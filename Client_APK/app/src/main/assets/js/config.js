// procMessenger Mobile — Configuration

const CONFIG = {
    // Local network IP — used when Tailscale is unavailable
    // Change this to your server's LAN IP (e.g. 192.168.1.100)
    LAN_IP: "192.168.1.100",

    // Tailscale VPN IP — the server's 100.x.x.x address assigned by Tailscale
    // Leave blank ("") to skip Tailscale and always connect via LAN
    // Find this by running:  python tailscale_vpn.py  on the server machine
    TAILSCALE_IP: "",

    PORT: 9734,

    // Client identity
    CLIENT_NAME: "mobile-phone",
    CLIENT_TYPE: "mobile",

    // Reconnect delay in ms
    RECONNECT_DELAY: 5000,

    // Available message types / functionality
    MESSAGE_TYPES: [
        { value: "run_script",       label: "Run Script" },
        { value: "gather_research",  label: "Gather Research" },
        { value: "edit_story",       label: "Edit Story" },
        { value: "llm_chat",         label: "LLM Chat" },
        { value: "file_browser",     label: "File Browser" },
    ],

    // Attachment limits (must match server config)
    MAX_ATTACHMENT_SIZE: 50 * 1024 * 1024,  // 50 MB
    CHUNK_SIZE: 512 * 1024,                  // 512 KB per chunk
};
