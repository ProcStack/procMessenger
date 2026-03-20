// Server_Nodejs Configuration
const path = require("path");

module.exports = {
    HOST: "0.0.0.0",
    PORT: 9734,

    // Name this client uses when registering with the server
    CLIENT_NAME: "nodejs-client",

    // Capabilities this client advertises
    CAPABILITIES: ["run_script", "gather_research", "file_transfers"],

    // Directory containing scripts that can be executed via "run_script"
    SCRIPTS_DIR: "./scripts",

    // Shared transfers directory - both Node.js and Python servers read/write here.
    // Resolved relative to the project root (two levels up from Server_Nodejs/).
    TRANSFERS_DIR: path.resolve(__dirname, "../transfers"),

    // Ping interval in milliseconds (keepalive)
    PING_INTERVAL: 30000,

    // Ping timeout - disconnect if no pong within this many ms
    PING_TIMEOUT: 10000,
};
