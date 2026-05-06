/**
 * procMessenger Mobile - Utilities & Persistence
 *
 * Shared helper functions and localStorage persistence for nicknames and topics.
 */

// --- HTML Escaping ---

function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// --- Byte Formatting ---

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// --- Nickname Persistence ---

function loadNicknames() {
    try {
        const saved = localStorage.getItem("clientNicknames");
        if (saved) clientNicknames = JSON.parse(saved);
    } catch {
        clientNicknames = {};
    }
}

function saveNicknames() {
    localStorage.setItem("clientNicknames", JSON.stringify(clientNicknames));
}

// --- Topic Persistence ---

function loadTopicsFromLocal() {
    try {
        const cached = localStorage.getItem("procMessenger_topics");
        if (cached) serverTopics = JSON.parse(cached);
    } catch {}
}

function saveTopicsLocal(topics) {
    try {
        localStorage.setItem("procMessenger_topics", JSON.stringify(topics));
    } catch {}
}
