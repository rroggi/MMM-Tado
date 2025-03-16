const NodeHelper = require("node_helper");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const logger = require("mocha-logger");

const TADO_CLIENT_ID = "1bb50063-6b0c-4d11-bd99-387f4a91cc46";
const TADO_AUTH_URL = "https://login.tado.com/oauth2/token";
const TADO_API_URL = "https://my.tado.com/api/v2";
const TOKEN_FILE = path.join(__dirname, "../../config/tokens/tado_tokens.json");
const EXPIRY_BUFFER_MS = 30 * 1000; // 30 seconds buffer

module.exports = NodeHelper.create({
    tadoMe: {},
    tadoHomes: [],
    accessToken: null,
    refreshToken: null,
    tokenExpiry: 0,

    start: function() {
        logger.log("MMM-Tado: Module started");
        this.loadTokens();
    },

    loadTokens: function() {
        logger.log("MMM-Tado: Attempting to load tokens from file at", TOKEN_FILE);
        if (fs.existsSync(TOKEN_FILE)) {
            const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
            this.accessToken = tokenData.access_token;
            this.refreshToken = tokenData.refresh_token;
            if (tokenData.issued_at && tokenData.expires_in) {
                this.tokenExpiry = tokenData.issued_at + (tokenData.expires_in * 1000);
            } else {
                this.tokenExpiry = Date.now();
            }
            logger.log("MMM-Tado: Tokens loaded from file successfully");
            logger.log(`MMM-Tado: Access token: ${this.accessToken.substring(0, 10)}...`);
        } else {
            logger.error("MMM-Tado: Token file not found at", TOKEN_FILE);
        }
    },

    saveTokens: function(data) {
        logger.log("MMM-Tado: Saving tokens to file at", TOKEN_FILE);
        const tokenData = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_in: data.expires_in,
            issued_at: Date.now()
        };
        const dir = path.dirname(TOKEN_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            logger.log("MMM-Tado: Created directory for tokens file");
        }
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
        logger.log("MMM-Tado: Tokens saved to file successfully");
    },

    async authenticate() {
        logger.log("MMM-Tado: Authenticating...");
        if (this.accessToken && Date.now() + EXPIRY_BUFFER_MS < this.tokenExpiry) {
            logger.log("MMM-Tado: Using cached access token (still valid)");
            return;
        }

        if (this.refreshToken) {
            logger.log("MMM-Tado: Access token expired or about to expire. Refreshing access token...");
            return await this.refreshAccessToken();
        } 

        logger.error("MMM-Tado: No valid tokens available, please manually obtain tokens and place them in tokens.json");
    },

    async refreshAccessToken() {
        logger.log("MMM-Tado: Sending request to refresh access token");
        try {
            const params = new URLSearchParams();
            params.append("client_id", TADO_CLIENT_ID);
            params.append("grant_type", "refresh_token");
            params.append("refresh_token", this.refreshToken);

            const response = await axios.post(TADO_AUTH_URL, params.toString(), {
                headers: { "Content-Type": "application/x-www-form-urlencoded" }
            });

            logger.log("MMM-Tado: Access token refreshed successfully");
            this.setAuthData(response.data);
            this.saveTokens(response.data);
        } catch (error) {
            logger.error("MMM-Tado: Failed to refresh access token", error.response ? error.response.data : error.message);
            this.accessToken = null;
            this.refreshToken = null;
        }
    },

    setAuthData(data) {
        logger.log("MMM-Tado: Setting new token data");
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        this.tokenExpiry = Date.now() + (data.expires_in * 1000);
    },

    async fetchTadoData() {
        logger.log("MMM-Tado: Fetching Tado data...");
        await this.authenticate();
        if (!this.accessToken) {
            logger.error("MMM-Tado: No valid access token available after authentication");
            return;
        }
        
        try {
            logger.log("MMM-Tado: Requesting user data from Tado API");
            const response = await axios.get(`${TADO_API_URL}/me`, {
                headers: { Authorization: `Bearer ${this.accessToken}` }
            });
            
            this.tadoMe = response.data;
            this.tadoHomes = [];
            logger.log("MMM-Tado: User data fetched successfully");
            
            for (const home of this.tadoMe.homes) {
                logger.log(`MMM-Tado: Processing home: ${home.name}`);
                const homeInfo = { id: home.id, name: home.name, zones: [] };
                this.tadoHomes.push(homeInfo);

                logger.log(`MMM-Tado: Requesting zones for home ID ${home.id}`);
                const zonesResponse = await axios.get(`${TADO_API_URL}/homes/${home.id}/zones`, {
                    headers: { Authorization: `Bearer ${this.accessToken}` }
                });
                
                for (const zone of zonesResponse.data) {
                    logger.log(`MMM-Tado: Processing zone: ${zone.name}`);
                    const zoneInfo = { id: zone.id, name: zone.name, type: zone.type, state: {} };
                    homeInfo.zones.push(zoneInfo);
                    
                    logger.log(`MMM-Tado: Requesting state for zone ID ${zone.id}`);
                    const stateResponse = await axios.get(`${TADO_API_URL}/homes/${home.id}/zones/${zone.id}/state`, {
                        headers: { Authorization: `Bearer ${this.accessToken}` }
                    });
                    
                    zoneInfo.state = stateResponse.data;
                }
            }
            
            logger.log("MMM-Tado: Successfully fetched all Tado data");
            this.sendSocketNotification('NEW_DATA', { tadoMe: this.tadoMe, tadoHomes: this.tadoHomes });
        } catch (error) {
            logger.error("MMM-Tado: Failed to fetch Tado data", error.response ? error.response.data : error.message);
        }
    },

    socketNotificationReceived: function(notification, payload) {
        logger.log(`MMM-Tado: Received socket notification: ${notification}`);
        if (notification === "CONFIG") {
            logger.log("MMM-Tado: Storing config and starting data fetch");
            this.config = payload;
            this.fetchTadoData();
            setInterval(() => {
                logger.log("MMM-Tado: Scheduled data fetch");
                this.fetchTadoData();
            }, this.config.updateInterval);
        }
    }
});