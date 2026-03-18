/**
 * procMessenger Mobile — Main Application Logic
 *
 * Handles UI interactions, dynamic panels, message tabs, and client management.
 * No framework — vanilla JS.
 */

// --- State ---
let wsManager = null;
let connectedClients = [];        // Array of client info from server
let clientNicknames = {};          // clientName -> nickname (persisted in localStorage)
let messageTabs = {};              // clientName -> array of messages
let activeTab = null;              // Currently viewed tab name
let selectedTargets = new Set();   // Multi-select: which computers to send to

// --- LLM State ---
let llmProviders = [];             // Available LLM providers from llm_announce
let llmModes = [];                 // Available LLM modes from llm_announce
let llmActiveChatName = "";        // Currently active chat name
let llmChatHistory = [];           // Messages in the active LLM chat
let llmChatList = [];              // List of saved chat sessions

// --- Initialization ---

document.addEventListener("DOMContentLoaded", () => {
    loadNicknames();
    setupEventListeners();
    populateFunctionDropdown();
    updateDynamicPanel();

    // Auto-connect if we have saved settings
    const savedIp = localStorage.getItem("serverIp") || CONFIG.SERVER_IP;
    const savedPort = localStorage.getItem("serverPort") || CONFIG.PORT;
    document.getElementById("serverIp").value = savedIp;
    document.getElementById("serverPort").value = savedPort;
});

function setupEventListeners() {
    document.getElementById("btnConnect").addEventListener("click", handleConnect);
    document.getElementById("btnDisconnect").addEventListener("click", handleDisconnect);
    document.getElementById("functionSelect").addEventListener("change", updateDynamicPanel);
    document.getElementById("btnSend").addEventListener("click", handleSend);
}

// --- Connection ---

function handleConnect() {
    const ip = document.getElementById("serverIp").value.trim();
    const port = parseInt(document.getElementById("serverPort").value.trim(), 10);

    if (!ip || !port) {
        setStatus("error", "Please enter a valid IP and port.");
        return;
    }

    wsManager = new WebSocketManager(onMessage, setStatus, onClientListUpdate);
    wsManager.connect(ip, port);
}

function handleDisconnect() {
    if (wsManager) {
        wsManager.disconnect();
        setStatus("disconnected", "Disconnected.");
    }
}

// --- Status ---

function setStatus(state, text) {
    const el = document.getElementById("connectionStatus");
    el.textContent = text;
    el.className = "status " + state;

    // Persist server address only after a successful connection
    if (state === "connected") {
        const ip = document.getElementById("serverIp").value.trim();
        const port = document.getElementById("serverPort").value.trim();
        if (ip) localStorage.setItem("serverIp", ip);
        if (port) localStorage.setItem("serverPort", port);
    }
}

// --- Client List ---

function onClientListUpdate(clients) {
    // Filter out self
    connectedClients = clients.filter((c) => c.name !== CONFIG.CLIENT_NAME);
    renderClientList();
}

function renderClientList() {
    const container = document.getElementById("clientList");
    container.innerHTML = "";

    if (connectedClients.length === 0) {
        container.innerHTML = '<div class="empty-list">No computers connected</div>';
        return;
    }

    connectedClients.forEach((client) => {
        const displayName = clientNicknames[client.name] || client.nickname || client.name;

        const item = document.createElement("div");
        item.className = "client-item" + (selectedTargets.has(client.name) ? " selected" : "");
        item.dataset.name = client.name;

        item.innerHTML = `
            <span class="client-name">${escapeHtml(displayName)}</span>
            <span class="client-type">${escapeHtml(client.clientType)}</span>
            <button class="btn-nickname" title="Set nickname">&#9998;</button>
        `;

        // Toggle selection on tap
        item.addEventListener("click", (e) => {
            if (e.target.classList.contains("btn-nickname")) return;
            if (selectedTargets.has(client.name)) {
                selectedTargets.delete(client.name);
            } else {
                selectedTargets.add(client.name);
            }
            renderClientList();
        });

        // Nickname button
        item.querySelector(".btn-nickname").addEventListener("click", (e) => {
            e.stopPropagation();
            const newNick = prompt("Set nickname for " + client.name + ":", displayName);
            if (newNick !== null) {
                clientNicknames[client.name] = newNick;
                saveNicknames();
                if (wsManager) {
                    wsManager.setNickname(client.name, newNick);
                }
                renderClientList();
                renderMessageTabs();
            }
        });

        container.appendChild(item);
    });

    // "Select All" toggle
    const allBtn = document.createElement("div");
    allBtn.className = "client-item select-all" + (selectedTargets.size === connectedClients.length && connectedClients.length > 0 ? " selected" : "");
    allBtn.innerHTML = '<span class="client-name">Select All</span>';
    allBtn.addEventListener("click", () => {
        if (selectedTargets.size === connectedClients.length) {
            selectedTargets.clear();
        } else {
            connectedClients.forEach((c) => selectedTargets.add(c.name));
        }
        renderClientList();
    });
    container.appendChild(allBtn);
}

// --- Function Dropdown & Dynamic Panel ---

function populateFunctionDropdown() {
    const select = document.getElementById("functionSelect");
    CONFIG.MESSAGE_TYPES.forEach((mt) => {
        const opt = document.createElement("option");
        opt.value = mt.value;
        opt.textContent = mt.label;
        select.appendChild(opt);
    });
}

function updateDynamicPanel() {
    const type = document.getElementById("functionSelect").value;
    const panel = document.getElementById("dynamicPanel");

    switch (type) {
        case "run_script":
            panel.innerHTML = `
                <label>Scripts:</label>
                <select id="scriptSelect" class="full-width">
                    <option value="">-- Request script list first --</option>
                </select>
                <button id="btnListScripts" class="btn-secondary">Refresh Script List</button>
                <label>Arguments (space-separated):</label>
                <input type="text" id="scriptArgs" class="full-width" placeholder="arg1 arg2 arg3" />
            `;
            document.getElementById("btnListScripts").addEventListener("click", requestScriptList);
            break;

        case "gather_research":
            panel.innerHTML = `
                <label>Search Query:</label>
                <input type="text" id="researchQuery" class="full-width" placeholder="What would you like to research?" />
                <label>Max Results:</label>
                <input type="number" id="researchMaxResults" class="full-width" value="5" min="1" max="20" />
            `;
            break;

        case "edit_story":
            panel.innerHTML = `
                <label>Story Editor Message:</label>
                <textarea id="storyMessage" class="full-width" rows="4" placeholder="Instructions for the story editor..."></textarea>
            `;
            break;

        case "llm_chat":
            renderLlmPanel(panel);
            break;

        default:
            panel.innerHTML = '<div class="empty-list">Select a function above</div>';
    }
}

// --- LLM Chat Panel ---

function renderLlmPanel(panel) {
    const providerOpts = llmProviders.length > 0
        ? llmProviders.map(p => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join("")
        : '<option value="llama">Llama (Local)</option>';

    const modeOpts = llmModes.length > 0
        ? llmModes.map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join("")
        : '<option value="ask">Ask</option><option value="agent">Agent</option><option value="plan">Plan</option>';

    panel.innerHTML = `
        <div class="llm-controls">
            <div class="llm-row">
                <div class="llm-field">
                    <label>Provider:</label>
                    <select id="llmProvider">${providerOpts}</select>
                </div>
                <div class="llm-field">
                    <label>Mode:</label>
                    <select id="llmMode">${modeOpts}</select>
                </div>
            </div>
            <div class="llm-row">
                <div class="llm-field" style="flex:1">
                    <label>Model:</label>
                    <select id="llmModel" class="full-width"><option value="">Loading models...</option></select>
                </div>
            </div>
            <div class="llm-row">
                <div class="llm-field" style="flex:1">
                    <label>Chat Name:</label>
                    <input type="text" id="llmChatName" class="full-width" placeholder="Enter chat name..." value="${escapeHtml(llmActiveChatName)}" />
                </div>
                <button id="btnLlmHistory" class="btn-secondary" style="align-self:flex-end">Chat History</button>
            </div>
        </div>
        <div id="llmChatDisplay" class="llm-chat-display"></div>
    `;

    document.getElementById("btnLlmHistory").addEventListener("click", openChatHistoryModal);
    document.getElementById("llmProvider").addEventListener("change", updateModelDropdown);

    // Populate model dropdown for current provider
    updateModelDropdown();

    // Restore chat display if we have history for active chat
    if (llmActiveChatName && llmChatHistory.length > 0) {
        renderLlmChatMessages();
    }
}

function updateModelDropdown() {
    const providerKey = document.getElementById("llmProvider")?.value || "";
    const modelSelect = document.getElementById("llmModel");
    if (!modelSelect) return;

    const provider = llmProviders.find(p => p.value === providerKey);
    const models = (provider && provider.models) ? provider.models : [];
    const defaultModel = provider ? (provider.defaultModel || "") : "";

    modelSelect.innerHTML = "";

    if (models.length === 0) {
        // No models discovered yet — show default from config
        if (defaultModel) {
            const opt = document.createElement("option");
            opt.value = defaultModel;
            opt.textContent = defaultModel;
            modelSelect.appendChild(opt);
        } else {
            modelSelect.innerHTML = '<option value="">No models available</option>';
        }
        return;
    }

    models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name !== m.id ? `${m.name} (${m.id})` : m.id;
        modelSelect.appendChild(opt);
    });
}

// --- Sending Messages ---

function handleSend() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }

    const type = document.getElementById("functionSelect").value;

    // LLM chat targets the llm-chat client directly, skip target check
    if (type === "llm_chat") {
        handleLlmSend();
        return;
    }

    const targets = getSelectedTargets();

    if (targets.length === 0) {
        setStatus("error", "Select at least one target computer.");
        return;
    }

    let payload = {};
    let messageText = "";

    switch (type) {
        case "run_script": {
            const scriptSelect = document.getElementById("scriptSelect");
            const scriptName = scriptSelect ? scriptSelect.value : "";
            const argsField = document.getElementById("scriptArgs");
            const args = argsField && argsField.value.trim()
                ? argsField.value.trim().split(/\s+/)
                : [];

            if (scriptName) {
                payload = { action: "execute", scriptName, args };
                messageText = `Run: ${scriptName} ${args.join(" ")}`;
            } else {
                payload = { action: "list_scripts" };
                messageText = "Requesting script list...";
            }
            break;
        }

        case "gather_research": {
            const query = document.getElementById("researchQuery")?.value.trim() || "";
            const maxResults = parseInt(document.getElementById("researchMaxResults")?.value || "5", 10);
            if (!query) {
                setStatus("error", "Enter a search query.");
                return;
            }
            payload = { query, maxResults };
            messageText = `Research: ${query}`;
            break;
        }

        case "edit_story": {
            const message = document.getElementById("storyMessage")?.value.trim() || "";
            if (!message) {
                setStatus("error", "Enter a message for the story editor.");
                return;
            }
            payload = { message };
            messageText = `Story: ${message}`;
            break;
        }
    }

    // Send to each selected target
    targets.forEach((target) => {
        wsManager.send(type, target, payload);
        addMessageToTab(target, "out", type, messageText);
    });

    setStatus("connected", `Sent ${type} to ${targets.length} target(s).`);
}

function getSelectedTargets() {
    return Array.from(selectedTargets);
}

function requestScriptList() {
    const targets = getSelectedTargets();
    if (targets.length === 0) {
        setStatus("error", "Select a target computer first.");
        return;
    }
    targets.forEach((target) => {
        wsManager.send("run_script", target, { action: "list_scripts" });
        addMessageToTab(target, "out", "run_script", "Requesting script list...");
    });
}

// --- Incoming Messages ---

function onMessage(msg) {
    const source = msg.source || "unknown";
    const type = msg.type || "";
    const payload = msg.payload || {};

    // --- LLM-specific messages ---
    if (type === "llm_announce") {
        llmProviders = payload.providers || [];
        llmModes = payload.modes || [];
        // Re-render panel if LLM Chat is selected
        if (document.getElementById("functionSelect").value === "llm_chat") {
            updateDynamicPanel();
        }
        addMessageToTab(source, "in", type, `LLM Chat online. Providers: ${llmProviders.map(p => p.label).join(", ")}`);
        return;
    }

    if (type === "llm_modes") {
        llmProviders = payload.providers || llmProviders;
        llmModes = payload.modes || llmModes;
        if (document.getElementById("functionSelect").value === "llm_chat") {
            updateDynamicPanel();
        }
        return;
    }

    if (type === "llm_chat") {
        handleLlmChatResponse(payload);
        return;
    }

    if (type === "llm_chat_list") {
        llmChatList = payload.chats || [];
        renderChatHistoryList();
        return;
    }

    if (type === "llm_chat_history") {
        llmActiveChatName = payload.chatName || "";
        llmChatHistory = payload.messages || [];
        const chatNameInput = document.getElementById("llmChatName");
        if (chatNameInput) chatNameInput.value = llmActiveChatName;
        renderLlmChatMessages();
        return;
    }

    if (type === "llm_chat_create") {
        llmActiveChatName = payload.chatName || "";
        llmChatHistory = [];
        const chatNameInput = document.getElementById("llmChatName");
        if (chatNameInput) chatNameInput.value = llmActiveChatName;
        renderLlmChatMessages();
        setStatus("connected", `Chat "${llmActiveChatName}" created.`);
        closeChatHistoryModal();
        return;
    }

    if (type === "llm_chat_delete") {
        if (payload.deleted) {
            setStatus("connected", `Chat "${payload.chatName}" deleted.`);
            if (llmActiveChatName === payload.chatName) {
                llmActiveChatName = "";
                llmChatHistory = [];
                renderLlmChatMessages();
            }
            // Refresh chat list
            if (wsManager) wsManager.send("llm_chat_list", "llm-chat", {});
        }
        return;
    }

    if (type === "attachment") {
        if (payload.status === "complete") {
            addMessageToTab(source, "in", type, `Attachment saved: ${payload.filename} (${formatBytes(payload.fileSize)})`);
        } else if (payload.status === "receiving") {
            // Progress — silent
        }
        return;
    }

    // --- Standard message handling ---

    // Handle script list responses — update the dropdown
    if (type === "run_script" && payload.action === "script_list") {
        const select = document.getElementById("scriptSelect");
        if (select) {
            select.innerHTML = "";
            (payload.scripts || []).forEach((s) => {
                const opt = document.createElement("option");
                opt.value = s.name;
                opt.textContent = `${s.name} — ${s.description}`;
                select.appendChild(opt);
            });
            if ((payload.scripts || []).length === 0) {
                select.innerHTML = '<option value="">No scripts available</option>';
            }
        }
    }

    // Build display text
    let displayText = "";
    if (type === "run_script") {
        if (payload.action === "script_list") {
            const count = (payload.scripts || []).length;
            displayText = `Script list received (${count} scripts)`;
        } else if (payload.action === "result") {
            displayText = `Script "${payload.scriptName}" exited with code ${payload.exitCode}\n`;
            if (payload.stdout) displayText += `stdout: ${payload.stdout}\n`;
            if (payload.stderr) displayText += `stderr: ${payload.stderr}`;
        } else {
            displayText = JSON.stringify(payload, null, 2);
        }
    } else if (type === "gather_research") {
        if (payload.status === "complete") {
            displayText = `Research complete for: "${payload.query}"\n`;
            (payload.results || []).forEach((r, i) => {
                displayText += `\n[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.summary}\n`;
            });
        } else {
            displayText = payload.message || JSON.stringify(payload, null, 2);
        }
    } else if (type === "edit_story") {
        displayText = payload.message || JSON.stringify(payload, null, 2);
    } else if (type === "error") {
        displayText = `Error [${payload.code}]: ${payload.message}`;
    } else {
        displayText = JSON.stringify(payload, null, 2);
    }

    addMessageToTab(source, "in", type, displayText);
}

// --- Message Tabs ---

function addMessageToTab(clientName, direction, type, text) {
    if (!messageTabs[clientName]) {
        messageTabs[clientName] = [];
    }

    messageTabs[clientName].push({
        direction,
        type,
        text,
        time: new Date().toLocaleTimeString(),
    });

    // Auto-switch to tab if it's new
    if (!activeTab) {
        activeTab = clientName;
    }

    renderMessageTabs();
    renderMessages();
}

function renderMessageTabs() {
    const container = document.getElementById("messageTabs");
    container.innerHTML = "";

    const tabNames = Object.keys(messageTabs);
    if (tabNames.length === 0) {
        container.innerHTML = '<div class="empty-list">No messages yet</div>';
        return;
    }

    tabNames.forEach((name) => {
        const displayName = clientNicknames[name] || name;
        const tab = document.createElement("div");
        tab.className = "tab" + (activeTab === name ? " active" : "");
        tab.textContent = displayName;
        tab.addEventListener("click", () => {
            activeTab = name;
            renderMessageTabs();
            renderMessages();
        });
        container.appendChild(tab);
    });
}

function renderMessages() {
    const container = document.getElementById("messageArea");
    container.innerHTML = "";

    if (!activeTab || !messageTabs[activeTab]) {
        container.innerHTML = '<div class="empty-list">Select a tab to view messages</div>';
        return;
    }

    messageTabs[activeTab].forEach((msg) => {
        const div = document.createElement("div");
        div.className = "message " + msg.direction;

        const header = document.createElement("div");
        header.className = "message-header";
        header.innerHTML = `<span class="msg-type">${escapeHtml(msg.type)}</span> <span class="msg-time">${escapeHtml(msg.time)}</span>`;

        const body = document.createElement("div");
        body.className = "message-body";
        body.textContent = msg.text;

        div.appendChild(header);
        div.appendChild(body);
        container.appendChild(div);
    });

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// --- Nicknames (persistence) ---

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

// --- Utilities ---

function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// --- LLM Chat: Send ---

function handleLlmSend() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }

    const messageContent = document.getElementById("messageContent")?.value.trim() || "";
    if (!messageContent) {
        setStatus("error", "Enter a message to send.");
        return;
    }

    const chatNameInput = document.getElementById("llmChatName");
    let chatName = chatNameInput ? chatNameInput.value.trim() : "";
    if (!chatName) {
        // Auto-generate name from first message
        chatName = messageContent.substring(0, 40).replace(/[^\w\s-]/g, "").trim() || "Chat";
        if (chatNameInput) chatNameInput.value = chatName;
    }
    llmActiveChatName = chatName;

    const provider = document.getElementById("llmProvider")?.value || "llama";
    const mode = document.getElementById("llmMode")?.value || "ask";
    const model = document.getElementById("llmModel")?.value || "";

    wsManager.send("llm_chat", "llm-chat", {
        chatName: chatName,
        message: messageContent,
        provider: provider,
        mode: mode,
        model: model,
    });

    // Add user message to local chat display
    llmChatHistory.push({
        role: "user",
        content: messageContent,
        timestamp: new Date().toISOString(),
    });
    renderLlmChatMessages();

    // Clear the message input
    document.getElementById("messageContent").value = "";

    setStatus("connected", "Message sent to LLM...");
}

// --- LLM Chat: Handle Response ---

function handleLlmChatResponse(payload) {
    const chatName = payload.chatName || "";
    const status = payload.status || "";

    if (status === "thinking") {
        // Show thinking indicator
        const display = document.getElementById("llmChatDisplay");
        if (display) {
            let thinkingEl = display.querySelector(".llm-thinking");
            if (!thinkingEl) {
                thinkingEl = document.createElement("div");
                thinkingEl.className = "llm-msg assistant llm-thinking";
                thinkingEl.innerHTML = '<div class="llm-msg-role">Assistant</div><div class="llm-msg-body">Thinking...</div>';
                display.appendChild(thinkingEl);
                display.scrollTop = display.scrollHeight;
            }
        }
        return;
    }

    if (status === "complete") {
        // Remove thinking indicator
        const display = document.getElementById("llmChatDisplay");
        if (display) {
            const thinkingEl = display.querySelector(".llm-thinking");
            if (thinkingEl) thinkingEl.remove();
        }

        // Add to local history
        llmChatHistory.push({
            role: "assistant",
            content: payload.message || "",
            timestamp: new Date().toISOString(),
            images: payload.images || [],
            links: payload.links || [],
        });

        renderLlmChatMessages();
        setStatus("connected", `LLM response received for "${chatName}".`);
    }

    if (status === "error") {
        const display = document.getElementById("llmChatDisplay");
        if (display) {
            const thinkingEl = display.querySelector(".llm-thinking");
            if (thinkingEl) thinkingEl.remove();
        }
        setStatus("error", `LLM error: ${payload.message || "Unknown error"}`);
    }
}

// --- LLM Chat: Render Messages ---

function renderLlmChatMessages() {
    const display = document.getElementById("llmChatDisplay");
    if (!display) return;
    display.innerHTML = "";

    if (llmChatHistory.length === 0) {
        display.innerHTML = '<div class="empty-list">Start a conversation...</div>';
        return;
    }

    llmChatHistory.forEach((msg) => {
        const el = document.createElement("div");
        el.className = "llm-msg " + msg.role;

        const role = document.createElement("div");
        role.className = "llm-msg-role";
        role.textContent = msg.role === "user" ? "You" : "Assistant";

        const body = document.createElement("div");
        body.className = "llm-msg-body";

        if (msg.role === "assistant") {
            body.innerHTML = renderMarkdown(msg.content || "");
        } else {
            body.textContent = msg.content || "";
        }

        el.appendChild(role);
        el.appendChild(body);
        display.appendChild(el);
    });

    display.scrollTop = display.scrollHeight;
}

// --- Markdown Renderer (lightweight) ---

function renderMarkdown(text) {
    // Escape HTML first, then apply markdown transforms
    let html = escapeHtml(text);

    // Code blocks (```) 
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre class="md-code-block"><code class="lang-${escapeHtml(lang)}">${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Images: ![alt](url)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-image" src="$2" alt="$1" />');

    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank">$1</a>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4 class="md-header">$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3 class="md-header">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 class="md-header">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 class="md-header">$1</h1>');

    // Unordered lists
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul class="md-list">$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Horizontal rule
    html = html.replace(/^---$/gm, '<hr class="md-hr" />');

    // Line breaks (double newline = paragraph, single = br)
    html = html.replace(/\n\n/g, "</p><p>");
    html = html.replace(/\n/g, "<br>");
    html = "<p>" + html + "</p>";

    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, "");
    html = html.replace(/<p>(<h[1-4])/g, "$1");
    html = html.replace(/(<\/h[1-4]>)<\/p>/g, "$1");
    html = html.replace(/<p>(<pre)/g, "$1");
    html = html.replace(/(<\/pre>)<\/p>/g, "$1");
    html = html.replace(/<p>(<ul)/g, "$1");
    html = html.replace(/(<\/ul>)<\/p>/g, "$1");
    html = html.replace(/<p>(<hr)/g, "$1");

    return html;
}

// --- Chat History Modal ---

function openChatHistoryModal() {
    const modal = document.getElementById("chatHistoryModal");
    if (modal) {
        modal.classList.add("visible");
        // Request chat list from LLM client
        if (wsManager && wsManager.connected) {
            wsManager.send("llm_chat_list", "llm-chat", {});
        }
    }
}

function closeChatHistoryModal() {
    const modal = document.getElementById("chatHistoryModal");
    if (modal) modal.classList.remove("visible");
}

function renderChatHistoryList() {
    const container = document.getElementById("chatHistoryList");
    if (!container) return;
    container.innerHTML = "";

    if (llmChatList.length === 0) {
        container.innerHTML = '<div class="empty-list">No saved chats</div>';
        return;
    }

    llmChatList.forEach((chat) => {
        const item = document.createElement("div");
        item.className = "chat-history-item" + (chat.name === llmActiveChatName ? " active" : "");

        const info = document.createElement("div");
        info.className = "chat-history-info";
        info.innerHTML = `
            <div class="chat-history-name">${escapeHtml(chat.name)}</div>
            <div class="chat-history-meta">${chat.messageCount} messages &middot; ${escapeHtml(chat.provider || "")} &middot; ${escapeHtml(chat.mode || "")}</div>
        `;
        info.addEventListener("click", () => loadChat(chat.name));

        const delBtn = document.createElement("button");
        delBtn.className = "btn-delete-chat";
        delBtn.textContent = "\u2715";
        delBtn.title = "Delete chat";
        delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (confirm(`Delete chat "${chat.name}"?`)) {
                if (wsManager) wsManager.send("llm_chat_delete", "llm-chat", { chatName: chat.name });
            }
        });

        item.appendChild(info);
        item.appendChild(delBtn);
        container.appendChild(item);
    });
}

function loadChat(chatName) {
    if (wsManager && wsManager.connected) {
        wsManager.send("llm_chat_history", "llm-chat", { chatName: chatName });
        closeChatHistoryModal();
    }
}

function createNewChat() {
    const input = document.getElementById("newChatNameInput");
    const name = input ? input.value.trim() : "";
    if (!name) {
        alert("Enter a chat name.");
        return;
    }
    const provider = document.getElementById("llmProvider")?.value || "llama";
    const mode = document.getElementById("llmMode")?.value || "ask";
    if (wsManager && wsManager.connected) {
        wsManager.send("llm_chat_create", "llm-chat", {
            chatName: name,
            provider: provider,
            mode: mode,
        });
    }
}
