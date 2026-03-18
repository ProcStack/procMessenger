// Server_Nodejs Configuration

module.exports = {
    HOST: "0.0.0.0",
    PORT: 9734,

    // Name this client uses when registering with the server
    CLIENT_NAME: "nodejs-client",

    // Capabilities this client advertises
    CAPABILITIES: ["run_script", "gather_research"],

    // Directory containing scripts that can be executed via "run_script"
    SCRIPTS_DIR: "./scripts",

    // Ping interval in milliseconds (keepalive)
    PING_INTERVAL: 30000,

    // Ping timeout — disconnect if no pong within this many ms
    PING_TIMEOUT: 10000,
};
