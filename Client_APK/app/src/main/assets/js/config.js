// procMessenger Mobile - Configuration

const CONFIG = {
    // Default server IP - used when no recent connections exist
    DEFAULT_IP: "192.168.1.100",

    PORT: 9734,

    // Client identity
    CLIENT_NAME: "mobile-phone",
    CLIENT_TYPE: "mobile",

    // Reconnect delay in ms
    RECONNECT_DELAY: 5000,

    // Available message types / functionality shown in the function dropdown.
    // The file browser is a dedicated tab and is not listed here.
    // When a client advertises its own `functions` list, the dropdown is filtered
    // to only show the types that client supports.
    MESSAGE_TYPES: [
        { value: "run_script",       label: "Run Script" },
        { value: "gather_research",  label: "Gather Research" },
        { value: "edit_story",       label: "Edit Story" },
        { value: "llm_chat",         label: "LLM Chat" },
        { value: "blog_entry",       label: "Blog Entry" },
        { value: "procIndex",        label: "procIndex Search" },
    ],

    // Attachment limits (must match server config)
    MAX_ATTACHMENT_SIZE: 50 * 1024 * 1024,  // 50 MB
    CHUNK_SIZE: 512 * 1024,                  // 512 KB per chunk
};
