/**
 * procMessenger Mobile - Main Application Logic
 *
 * Handles UI interactions, dynamic panels, message tabs, and client management.
 * No framework - vanilla JS.
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
let llmModelsRequested = false;    // True after the first automatic model fetch this session

// --- Topic State ---
let serverTopics = [];             // List of topics from server
let selectedTopicIds = new Set();  // Set of IDs of selected topics

// --- branchShredder State ---
let bsRecentScenes = [];           // From system → recent_scenes response
let bsNodeIndex = [];              // From find_nodes response - lightweight node list

// --- File Browser State ---
let fbFileList = [];               // Aggregated file list from server
// In-flight chunk assembly: fileId -> { record, chunks: {index -> base64}, totalChunks }
let fbInFlight = {};
let fbSelectedFileId = null;       // Currently selected file ID
let fbLastTap = { id: null, time: 0 }; // For double-tap detection
let fbEditingFileId = null;        // fileId of the file being edited (null for new files)

// --- Initialization ---

document.addEventListener("DOMContentLoaded", () => {
    loadNicknames();
    loadTopicsFromLocal();
    setupEventListeners();
    setupLinkHandler();
    populateFunctionDropdown();
    updateDynamicPanel();
    updateConnectionButtons("disconnected");

    // Restore last-used IP and port (or fall back to config defaults)
    const recentIps = getRecentIps();
    if (recentIps.length > 0) {
        document.getElementById("serverIp").value = recentIps[0].ip;
        document.getElementById("serverPort").value = recentIps[0].port;
    } else {
        document.getElementById("serverIp").value =
            localStorage.getItem("serverIp") || CONFIG.DEFAULT_IP;
        document.getElementById("serverPort").value =
            localStorage.getItem("serverPort") || CONFIG.PORT;
    }
});

function setupEventListeners() {
    document.getElementById("btnConnect").addEventListener("click", handleConnect);
    document.getElementById("btnDisconnect").addEventListener("click", handleDisconnect);
    document.getElementById("btnRecentIps").addEventListener("click", openRecentIpsModal);
    document.getElementById("functionSelect").addEventListener("change", updateDynamicPanel);
    document.getElementById("btnSend").addEventListener("click", handleSend);
}

// --- Connection ---

function handleConnect() {
    const ip = document.getElementById("serverIp").value.trim();
    const port = parseInt(document.getElementById("serverPort").value.trim(), 10);

    if (!ip || !port) {
        setStatus("error", "Please enter a valid IP address and port.");
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

function updateConnectionButtons(state) {
    const isConnected = state === "connected";
    const isConnecting = state === "connecting";
    document.getElementById("btnConnect").style.display = (isConnected || isConnecting) ? "none" : "";
    document.getElementById("btnDisconnect").style.display = isConnected ? "" : "none";
}

function setStatus(state, text) {
    const el = document.getElementById("connectionStatus");
    el.textContent = text;
    el.className = "status " + state;
    updateConnectionButtons(state);

    // Persist server address and add to recent list after a successful connection
    if (state === "connected") {
        const ip = document.getElementById("serverIp").value.trim();
        const port = document.getElementById("serverPort").value.trim();
        if (ip) localStorage.setItem("serverIp", ip);
        if (port) localStorage.setItem("serverPort", port);

        if (ip && port) {
            addRecentIp(ip, port);
        }

        // Fetch server known data on connection
        requestServerData();
    }
}

function requestServerData() {
    if (wsManager && wsManager.connected) {
        wsManager.send("server_known_data", "server", {});
    }
}

// --- Recent IPs ---

function getRecentIps() {
    try {
        return JSON.parse(localStorage.getItem("recentIps") || "[]");
    } catch {
        return [];
    }
}

function saveRecentIps(list) {
    localStorage.setItem("recentIps", JSON.stringify(list));
}

function addRecentIp(ip, port) {
    let list = getRecentIps();
    const key = `${ip}:${port}`;
    // Remove existing entry if present
    list = list.filter((entry) => `${entry.ip}:${entry.port}` !== key);
    // Insert at the top
    list.unshift({ ip, port: String(port) });
    saveRecentIps(list);
}

function removeRecentIp(ip, port) {
    let list = getRecentIps();
    const key = `${ip}:${port}`;
    list = list.filter((entry) => `${entry.ip}:${entry.port}` !== key);
    saveRecentIps(list);
    renderRecentIpsList();
}

function openRecentIpsModal() {
    renderRecentIpsList();
    document.getElementById("recentIpsModal").classList.add("visible");
}

function closeRecentIpsModal() {
    document.getElementById("recentIpsModal").classList.remove("visible");
}

function selectRecentIp(ip, port) {
    document.getElementById("serverIp").value = ip;
    document.getElementById("serverPort").value = port;
    closeRecentIpsModal();
}

function renderRecentIpsList() {
    const container = document.getElementById("recentIpsList");
    const list = getRecentIps();

    if (list.length === 0) {
        container.innerHTML = '<div class="empty-list">No recent connections</div>';
        return;
    }

    container.innerHTML = "";
    list.forEach((entry) => {
        const item = document.createElement("div");
        item.className = "recent-ip-item";

        const label = document.createElement("span");
        label.className = "recent-ip-label";
        label.textContent = `${entry.ip}:${entry.port}`;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-delete-recent";
        deleteBtn.innerHTML = "&times;";
        deleteBtn.title = "Remove";
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            removeRecentIp(entry.ip, entry.port);
        });

        item.addEventListener("click", () => {
            selectRecentIp(entry.ip, entry.port);
        });

        item.appendChild(label);
        item.appendChild(deleteBtn);
        container.appendChild(item);
    });
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
            renderBranchShredderPanel(panel);
            break;

        case "llm_chat":
            renderLlmPanel(panel);
            break;

        case "file_browser":
            renderFileBrowserPanel(panel);
            break;

        default:
            panel.innerHTML = '<div class="empty-list">Select a function above</div>';
    }
}

// --- branchShredder Panel ---

function renderBranchShredderPanel(panel) {
    const recentOpts = bsRecentScenes.length > 0
        ? bsRecentScenes.map(s => `<option value="${escapeHtml(s.path)}">${escapeHtml(s.name || s.path)}</option>`).join("")
        : '<option value="">-- request recent scenes first --</option>';

    const nodeOpts = bsNodeIndex.length > 0
        ? bsNodeIndex.map(n => `<option value="${escapeHtml(n.id)}">[${escapeHtml(n.type)}] ${escapeHtml(n.name)}</option>`).join("")
        : '<option value="">-- find nodes first --</option>';

    panel.innerHTML = `
        <div class="bs-panel">

            <div class="bs-section-title">Graph Operations</div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Query Nodes <small>(full content)</small></span>
                <button id="bsBtnQueryNodes" class="btn-secondary btn-sm">Run</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Find Nodes <small>(index only)</small></span>
                <button id="bsBtnFindNodes" class="btn-secondary btn-sm">Run</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Get Node</span>
                <select id="bsGetNodeSelect" class="bs-select">${nodeOpts}</select>
                <button id="bsBtnGetNode" class="btn-secondary btn-sm">Get</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Update Node</span>
                <button id="bsBtnToggleUpdate" class="btn-secondary btn-sm">&#9660; Edit</button>
            </div>
            <div id="bsUpdateForm" class="bs-sub-form" style="display:none">
                <label>Node:</label>
                <select id="bsUpdateNodeSelect" class="bs-select full-width">${nodeOpts}</select>
                <label>New name <small>(leave blank to keep)</small>:</label>
                <input type="text" id="bsUpdateName" class="full-width" placeholder="Node name..." />
                <label>New content <small>(leave blank to keep)</small>:</label>
                <textarea id="bsUpdateContent" class="full-width" rows="5" placeholder="Node content (Markdown)..."></textarea>
                <button id="bsBtnSendUpdate" class="btn-primary btn-sm">Send Update</button>
            </div>

            <div class="bs-section-title">Scene &amp; System</div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">System Prompt</span>
                <button id="bsBtnSystemPrompt" class="btn-secondary btn-sm">Get</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Recent Scenes</span>
                <button id="bsBtnRecentScenes" class="btn-secondary btn-sm">Refresh</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Open Scene</span>
                <select id="bsRecentSelect" class="bs-select">${recentOpts}</select>
                <button id="bsBtnOpenRecent" class="btn-secondary btn-sm">Open</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">New Scene</span>
                <button id="bsBtnNewScene" class="btn-secondary btn-sm">New</button>
            </div>

            <div class="bs-command-row">
                <span class="bs-cmd-label">Save Scene</span>
                <input type="text" id="bsSaveFilename" class="bs-inline-input" placeholder="filename (optional)" />
                <button id="bsBtnSaveScene" class="btn-secondary btn-sm">Save</button>
            </div>

            <div class="bs-section-title">Free-form Message</div>
            <textarea id="storyMessage" class="full-width" rows="3" placeholder="Direct message to the story editor..."></textarea>

        </div>
    `;

    document.getElementById("bsBtnQueryNodes").addEventListener("click", bsSendQueryNodes);
    document.getElementById("bsBtnFindNodes").addEventListener("click", bsSendFindNodes);
    document.getElementById("bsBtnGetNode").addEventListener("click", bsSendGetNode);
    document.getElementById("bsBtnToggleUpdate").addEventListener("click", bsToggleUpdateForm);
    document.getElementById("bsBtnSendUpdate").addEventListener("click", bsSendUpdateNode);
    document.getElementById("bsBtnSystemPrompt").addEventListener("click", bsSendSystemPrompt);
    document.getElementById("bsBtnRecentScenes").addEventListener("click", () => bsSendSystem("recent_scenes"));
    document.getElementById("bsBtnOpenRecent").addEventListener("click", bsSendOpenRecent);
    document.getElementById("bsBtnNewScene").addEventListener("click", () => bsSendSystem("new_scene"));
    document.getElementById("bsBtnSaveScene").addEventListener("click", bsSendSaveScene);
}

// --- branchShredder: Send Helpers ---

function bsGetTargets() {
    const targets = getSelectedTargets();
    if (targets.length === 0) {
        setStatus("error", "Select at least one target computer.");
        return null;
    }
    return targets;
}

function bsSendToTargets(type, payload, label) {
    if (!wsManager || !wsManager.connected) { setStatus("error", "Not connected."); return; }
    const targets = bsGetTargets();
    if (!targets) return;
    targets.forEach(t => {
        wsManager.send(type, t, payload);
        addMessageToTab(t, "out", type, label);
    });
    setStatus("connected", `Sent ${type} to ${targets.length} target(s).`);
}

function bsSendQueryNodes() {
    bsSendToTargets("query_nodes", {}, "Query all nodes (full content)");
}

function bsSendFindNodes() {
    bsSendToTargets("find_nodes", {}, "Find nodes (index)");
}

function bsSendGetNode() {
    const sel = document.getElementById("bsGetNodeSelect");
    const nodeId = sel ? sel.value : "";
    if (!nodeId) { setStatus("error", "Select or find a node first."); return; }
    bsSendToTargets("get_node", { nodeId }, `Get node: ${nodeId}`);
}

function bsToggleUpdateForm() {
    const form = document.getElementById("bsUpdateForm");
    const btn  = document.getElementById("bsBtnToggleUpdate");
    if (!form) return;
    const open = form.style.display !== "none";
    form.style.display = open ? "none" : "";
    btn.textContent = open ? "\u25bc Edit" : "\u25b2 Edit";
}

function bsSendUpdateNode() {
    const sel     = document.getElementById("bsUpdateNodeSelect");
    const nodeId  = sel ? sel.value : "";
    const name    = document.getElementById("bsUpdateName")?.value.trim() || "";
    const content = document.getElementById("bsUpdateContent")?.value || "";
    if (!nodeId) { setStatus("error", "Select a node to update."); return; }
    if (!name && !content) { setStatus("error", "Provide a new name and/or content."); return; }
    const payload = { nodeId };
    if (name)    payload.name    = name;
    if (content) payload.content = content;
    bsSendToTargets("update_node", payload, `Update node: ${nodeId}`);
}

function bsSendSystemPrompt() {
    bsSendToTargets("system_prompt", {}, "Request system prompt");
}

function bsSendSystem(action, extra = {}) {
    bsSendToTargets("system", { action, ...extra }, `System: ${action}`);
}

function bsSendOpenRecent() {
    const sel  = document.getElementById("bsRecentSelect");
    const path = sel ? sel.value : "";
    if (!path) { setStatus("error", "Select a recent scene first, or refresh the list."); return; }
    bsSendSystem("open_recent", { path });
}

function bsSendSaveScene() {
    const filename = document.getElementById("bsSaveFilename")?.value.trim() || "";
    const extra = filename ? { filename } : {};
    bsSendSystem("save_scene", extra);
}

// --- LLM Chat Panel ---

function renderLlmPanel(panel) {
    const providerOpts = llmProviders.length > 0
        ? llmProviders.map(p => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join("")
        : '<option value="llama">Llama (Local)</option>';

    const modeOpts = llmModes.length > 0
        ? llmModes.map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join("")
        : '<option value="ask">Ask</option><option value="agent">Agent</option><option value="plan">Plan</option>';

    // Get display names of selected topics
    const selectedTopics = serverTopics.filter(t => selectedTopicIds.has(t.id));
    const topicsDisplayText = selectedTopics.length > 0 
        ? selectedTopics.map(t => t.name).join(", ") 
        : "Select topics...";

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
                <button id="btnRefreshModels" class="btn-secondary" style="align-self:flex-end" title="Refresh model list">&#x21BB;</button>
            </div>
            <div class="llm-row">
                <div class="llm-field" style="flex:1">
                    <label>Chat Name:</label>
                    <input type="text" id="llmChatName" class="full-width" placeholder="Enter chat name..." value="${escapeHtml(llmActiveChatName)}" />
                </div>
                <button id="btnLlmHistory" class="btn-secondary" style="align-self:flex-end">Chat History</button>
            </div>
            <div class="topic-section">
                <div id="topicDisplay" class="topic-display" title="${escapeHtml(topicsDisplayText)}">${escapeHtml(topicsDisplayText)}</div>
            </div>
        </div>
        <div id="llmChatDisplay" class="llm-chat-display"></div>
    `;

    document.getElementById("btnLlmHistory").addEventListener("click", openChatHistoryModal);
    document.getElementById("btnRefreshModels").addEventListener("click", refreshLlmModels);
    document.getElementById("llmProvider").addEventListener("change", updateModelDropdown);
    document.getElementById("topicDisplay").addEventListener("click", openTopicSelectModal);

    // Populate model dropdown for current provider
    updateModelDropdown();

    // Auto-fetch models from the LLM client the first time LLM Chat is opened this session
    if (!llmModelsRequested && wsManager && wsManager.connected) {
        llmModelsRequested = true;
        refreshLlmModels();
    }

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
        // No models discovered yet - show default from config
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
        //opt.textContent = m.name !== m.id ? `${m.name} (${m.id})` : m.id;
        //opt.textContent = m.name !== m.id ? `${m.name}` : m.id;
        
        let label = m.name;
        console.log(m);
        console.log(m.hasOwnProperty("path"))
        if( m.hasOwnProperty("path") ){
          label = m.id.split(".");
          label.pop();
          label = label.join(".");
          label = label.replace(/[-]/g, " ");
        }
        opt.textContent = label;
        modelSelect.appendChild(opt);
    });
}

function refreshLlmModels() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    const modelSelect = document.getElementById("llmModel");
    if (modelSelect) modelSelect.innerHTML = '<option value="">Refreshing...</option>';
    wsManager.send("llm_modes", "llm-chat", {});
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

    // File browser requests go to the server directly
    if (type === "file_browser") {
        fbRequestList();
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

    if (type === "server_known_data") {
        fbFileList = payload.files || [];
        serverTopics = payload.topics || [];
        saveTopicsLocal(serverTopics);
        // Refresh panel if showing
        const functionType = document.getElementById("functionSelect").value;
        if (functionType === "llm_chat" || functionType === "file_browser") {
            updateDynamicPanel();
        }
        return;
    }

    if (type === "topics") {
        serverTopics = payload.topics || [];
        saveTopicsLocal(serverTopics);
        if (document.getElementById("functionSelect").value === "llm_chat") {
            const panel = document.getElementById("dynamicPanel");
            // Only re-render if modals aren't open to avoid UX jump
            if (!document.querySelector(".modal-overlay.visible")) {
                renderLlmPanel(panel);
            }
            // Always update the topic select list if it's currently showing
            if (document.getElementById("topicSelectModal").classList.contains("visible")) {
                renderTopicSelectList();
            }
        }
        return;
    }

    if (type === "topic_sync_result") {
        serverTopics = payload.topics || [];
        saveTopicsLocal(serverTopics);
        if (document.getElementById("topicSelectModal").classList.contains("visible")) {
            renderTopicSelectList();
        }
        setStatus("connected", `Topics synced — ${serverTopics.length} topic(s).`);
        return;
    }

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
            // Progress - silent
        }
        return;
    }

    // --- File Browser messages ---

    if (type === "file_list") {
        fbFileList = payload.files || [];
        // Refresh panel if file_browser is currently showing
        if (document.getElementById("functionSelect").value === "file_browser") {
            renderFileBrowserPanel(document.getElementById("dynamicPanel"));
        }
        return;
    }

    if (type === "file_transfer_data") {
        fbReceiveChunk(payload);
        return;
    }

    if (type === "file_receive_complete") {
        addMessageToTab(source, "in", type,
            `File saved on server: ${payload.fileName} (${formatBytes(payload.fileSize)})`);
        return;
    }

    if (type === "file_delete_complete") {
        if (payload.deleted) {
            fbFileList = fbFileList.filter(f => f.fileId !== payload.fileId);
            if (fbSelectedFileId === payload.fileId) fbSelectedFileId = null;
            if (document.getElementById("functionSelect").value === "file_browser") {
                renderFileBrowserPanel(document.getElementById("dynamicPanel"));
            }
            setStatus("connected", `Deleted: ${payload.fileName || payload.fileId}`);
        } else {
            setStatus("error", `Delete failed: ${payload.error || "unknown error"}`);
        }
        return;
    }

    // --- branchShredder extension messages ---

    if (type === "query_nodes") {
        const nodes = payload.nodes || [];
        if (nodes.length === 0) {
            addMessageToTab(source, "in", type, payload.error || "No nodes returned.");
        } else {
            let text = `query_nodes: ${nodes.length} node(s) returned\n\n`;
            nodes.forEach(n => {
                text += `[${n.type}] ${n.name}  (${n.scenePath})\n`;
                if (n.content) text += n.content.slice(0, 120) + (n.content.length > 120 ? "…" : "") + "\n";
                text += "\n";
            });
            addMessageToTab(source, "in", type, text.trim());
        }
        return;
    }

    if (type === "find_nodes") {
        const nodesDict = payload.nodes || {};
        // Normalise to [{id, name, type, scenePath, nodePaths}] for internal use
        bsNodeIndex = Object.entries(nodesDict).map(([id, n]) => ({ id, ...n }));
        // Refresh node selects in the panel if present
        const selGet    = document.getElementById("bsGetNodeSelect");
        const selUpdate = document.getElementById("bsUpdateNodeSelect");
        const opts = bsNodeIndex.length > 0
            ? bsNodeIndex.map(n => `<option value="${escapeHtml(n.id)}">[${escapeHtml(n.type)}] ${escapeHtml(n.name)}</option>`).join("")
            : '<option value="">-- no nodes found --</option>';
        if (selGet)    selGet.innerHTML    = opts;
        if (selUpdate) selUpdate.innerHTML = opts;
        const summary = bsNodeIndex.length > 0
            ? `find_nodes: ${bsNodeIndex.length} node(s)\n` + bsNodeIndex.map(n => `  [${n.type}] ${n.name}  (${n.scenePath})`).join("\n")
            : (payload.error || "No nodes returned.");
        addMessageToTab(source, "in", type, summary);
        return;
    }

    if (type === "get_node") {
        if (payload.error) {
            addMessageToTab(source, "in", type, `Error: ${payload.error}`);
            return;
        }
        // Pre-populate update form if it exists
        const selUpdate = document.getElementById("bsUpdateNodeSelect");
        if (selUpdate) {
            // If node is already in index select it, otherwise add a temporary entry
            let found = false;
            for (const opt of selUpdate.options) { if (opt.value === payload.nodeId) { selUpdate.value = payload.nodeId; found = true; break; } }
            if (!found) {
                const opt = document.createElement("option");
                opt.value = payload.nodeId;
                opt.textContent = `[${payload.type}] ${payload.name}`;
                selUpdate.appendChild(opt);
                selUpdate.value = payload.nodeId;
            }
        }
        const nameInput    = document.getElementById("bsUpdateName");
        const contentArea  = document.getElementById("bsUpdateContent");
        if (nameInput)   nameInput.value   = payload.name    || "";
        if (contentArea) contentArea.value = payload.content || "";
        const text = `get_node: ${payload.name} [${payload.type}]\n` +
                     `Path: ${payload.scenePath}\n\n` +
                     (payload.content || "(no content)");
        addMessageToTab(source, "in", type, text);
        return;
    }

    if (type === "update_node") {
        const text = payload.status === "ok"
            ? `update_node OK: "${payload.name || payload.nodeId}"`
            : `update_node error: ${payload.error || "unknown error"}`;
        addMessageToTab(source, "in", type, text);
        return;
    }

    if (type === "system_prompt") {
        if (payload.error) { addMessageToTab(source, "in", type, `Error: ${payload.error}`); return; }
        addMessageToTab(source, "in", type, payload.fullSystemPrompt || JSON.stringify(payload.parts || payload, null, 2));
        return;
    }

    if (type === "system") {
        const results = payload.results || {};
        // Update recent scenes list if present - code returns { status, scenes: [...] }
        const rsResult = results.recent_scenes;
        if (rsResult && rsResult.scenes && Array.isArray(rsResult.scenes)) {
            bsRecentScenes = rsResult.scenes;
            const sel = document.getElementById("bsRecentSelect");
            if (sel) {
                sel.innerHTML = bsRecentScenes.length > 0
                    ? bsRecentScenes.map(s => `<option value="${escapeHtml(s.path)}">${escapeHtml(s.name || s.path)}</option>`).join("")
                    : '<option value="">-- no recent scenes --</option>';
            }
        }
        let text = "system results:\n";
        Object.entries(results).forEach(([action, result]) => {
            if (action === "recent_scenes" && result && Array.isArray(result.scenes)) {
                text += `  recent_scenes (${result.scenes.length}):\n`;
                result.scenes.forEach(s => { text += `    ${s.name || s.path}\n`; });
            } else if (result && typeof result === "object") {
                text += `  ${action}: ${result.status || JSON.stringify(result)}\n`;
                if (result.name) text += `    → ${result.name}\n`;
                if (result.error) text += `    → ${result.error}\n`;
            } else {
                text += `  ${action}: ${JSON.stringify(result)}\n`;
            }
        });
        addMessageToTab(source, "in", type, text.trim());
        return;
    }

    // --- Standard message handling ---

    // Handle script list responses - update the dropdown
    if (type === "run_script" && payload.action === "script_list") {
        const select = document.getElementById("scriptSelect");
        if (select) {
            select.innerHTML = "";
            (payload.scripts || []).forEach((s) => {
                const opt = document.createElement("option");
                opt.value = s.name;
                opt.textContent = `${s.name} - ${s.description}`;
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
    updateResponsesBadge();
}

function toggleResponsesModal() {
    const modal = document.getElementById("responsesModal");
    if (modal) modal.classList.toggle("visible");
    // Clear badge when opening
    if (modal && modal.classList.contains("visible")) {
        const badge = document.getElementById("responsesBadge");
        if (badge) { badge.style.display = "none"; badge.textContent = ""; }
    }
}

function updateResponsesBadge() {
    const modal = document.getElementById("responsesModal");
    // Only show badge when modal is closed
    if (modal && modal.classList.contains("visible")) return;
    const badge = document.getElementById("responsesBadge");
    if (!badge) return;
    const current = parseInt(badge.textContent || "0", 10);
    badge.textContent = String(current + 1);
    badge.style.display = "flex";
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

// --- Topics (persistence) ---

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
    
    // Include selected topics in payload
    const selectedTopics = serverTopics.filter(t => selectedTopicIds.has(t.id));

    wsManager.send("llm_chat", "llm-chat", {
        chatName: chatName,
        message: messageContent,
        provider: provider,
        mode: mode,
        model: model,
        topics: selectedTopics
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
            // Preserve newlines for user messages as well
            body.innerHTML = renderMarkdown(msg.content || "");
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

/**
 * Handle clicks on Markdown links to prompt for external launch.
 * Uses event delegation on the document.
 */
function setupLinkHandler() {
    document.addEventListener("click", (e) => {
        const link = e.target.closest(".md-link");
        if (link && link.href) {
            e.preventDefault();
            const url = link.href;
            if (confirm(`Open external link?\n\n${url}`)) {
                // In a WebView, window.open(url, '_blank') usually triggers the OS to 
                // handle the URL via the default browser.
                window.open(url, "_blank");
            }
        }
    });
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

// ============================================================================
// File Browser
// ============================================================================

/** Ask the server for its aggregated file list. */
function fbRequestList() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    wsManager.send("file_list", "server", {});
    setStatus("connected", "Requesting file list...");
}

/** Render the file browser panel. */
function renderFileBrowserPanel(panel) {
    panel.innerHTML = `
        <div class="fb-panel">
            <div class="fb-toolbar">
                <button id="fbBtnRefresh" class="btn-secondary btn-sm">&#x21BB; Refresh</button>
                <button id="fbBtnUpload" class="btn-secondary btn-sm">&#x2B06; Upload</button>
                <button id="fbBtnNew" class="btn-secondary btn-sm">&#128221; New</button>
                <span class="fb-count">${fbFileList.length} file(s)</span>
            </div>
            <input type="file" id="fbUploadInput" style="display:none" />
            <div id="fbFileList" class="fb-file-list">
                ${fbFileList.length === 0
                    ? '<div class="empty-list">No files — tap Refresh to load</div>'
                    : fbFileList.map(fbRenderFileItem).join("")}
            </div>
        </div>
    `;

    document.getElementById("fbBtnRefresh").addEventListener("click", fbRequestList);
    document.getElementById("fbBtnUpload").addEventListener("click", fbUploadFile);
    document.getElementById("fbBtnNew").addEventListener("click", () => fbOpenNewFileModal(null, null));

    const uploadInput = document.getElementById("fbUploadInput");
    if (uploadInput) uploadInput.addEventListener("change", fbHandleUploadChange);

    // Attach tap listeners to file rows
    panel.querySelectorAll(".fb-file-item").forEach((item) => {
        const fileId = item.dataset.id;
        const owner  = item.dataset.owner;
        const ftype  = item.dataset.ftype;
        item.addEventListener("click", () => fbHandleFileTap(fileId, owner, ftype));
    });

    // Attach download button listeners
    panel.querySelectorAll(".fb-btn-download").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            fbRequestFile(btn.dataset.id, btn.dataset.owner, "download");
        });
    });

    // Attach delete listeners
    panel.querySelectorAll(".fb-btn-delete").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            fbDeleteFile(btn.dataset.id, btn.dataset.owner, btn.dataset.name);
        });
    });
}

/** Build HTML for a single file row. Tap = select, double-tap = view/edit. */
function fbRenderFileItem(f) {
    const isSelected = f.fileId === fbSelectedFileId;
    const ft = f.fileType || "";
    const icon = ft.startsWith("image/") ? "&#128444;" : "&#128196;";
    const inFlight = fbInFlight[f.fileId];
    const progress = inFlight
        ? `<span class="fb-progress">Receiving ${inFlight.received}/${inFlight.totalChunks}…</span>`
        : "";

    return `
        <div class="fb-file-item${isSelected ? " selected" : ""}"
             data-id="${escapeHtml(f.fileId)}"
             data-owner="${escapeHtml(f.ownerClient || "server")}"
             data-ftype="${escapeHtml(ft)}">
            <span class="fb-file-icon">${icon}</span>
            <div class="fb-file-info">
                <span class="fb-file-name">${escapeHtml(f.fileName)}</span>
                <span class="fb-file-meta">
                    ${escapeHtml(formatBytes(f.fileSize || 0))}
                    &middot; ${escapeHtml(ft || "?")}
                    &middot; ${escapeHtml(f.ownerClient || "server")}
                    &middot; ${escapeHtml(fbFormatDate(f.sentAt))}
                </span>
                ${progress}
            </div>
            <button class="fb-btn-download btn-sm"
                    data-id="${escapeHtml(f.fileId)}"
                    data-owner="${escapeHtml(f.ownerClient || "server")}"
                    title="Download file">&#x2B07;</button>
            <button class="fb-btn-delete btn-sm"
                    data-id="${escapeHtml(f.fileId)}"
                    data-owner="${escapeHtml(f.ownerClient || "server")}"
                    data-name="${escapeHtml(f.fileName)}"
                    title="Delete file">&#x2715;</button>
        </div>
    `;
}

function fbFormatDate(iso) {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

/**
 * Request a file from the server (which forwards to ownerClient).
 * mode: "view" (display inline) or "download" (save to device)
 */
function fbRequestFile(fileId, ownerClient, mode) {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected.");
        return;
    }
    if (!fileId || !ownerClient) {
        setStatus("error", "File info missing.");
        return;
    }

    // Initialise in-flight tracker
    fbInFlight[fileId] = { mode, received: 0, totalChunks: null, chunks: {} };

    wsManager.send("file_fetch", "server", { fileId, ownerClient });
    setStatus("connected", "Requesting file…");

    // Refresh panel to show progress indicator
    if (document.getElementById("functionSelect").value === "file_browser") {
        renderFileBrowserPanel(document.getElementById("dynamicPanel"));
    }
}

/** Handle an incoming file_transfer_data chunk. */
function fbReceiveChunk(payload) {
    const { fileId, chunkIndex, totalChunks, data,
            fileName, fileType, fileSize, sentAt, source, target } = payload;

    if (!fbInFlight[fileId]) {
        // Chunk arrived without a prior request - start tracking (edge case)
        fbInFlight[fileId] = { mode: "view", received: 0, totalChunks, chunks: {} };
    }

    const tracker = fbInFlight[fileId];
    tracker.totalChunks = totalChunks;
    tracker.chunks[chunkIndex] = data;
    tracker.received = Object.keys(tracker.chunks).length;
    tracker.meta = { fileName, fileType, fileSize, sentAt, source, target };

    // Refresh panel progress
    if (document.getElementById("functionSelect").value === "file_browser") {
        renderFileBrowserPanel(document.getElementById("dynamicPanel"));
    }

    if (tracker.received < totalChunks) return;

    // All chunks received - reassemble.
    // Each chunk is independently base64-encoded, so intermediate chunks may have
    // trailing '=' padding. Strip padding from every chunk before joining, then
    // re-pad the final string to a multiple of 4 so atob() accepts it.
    const ordered = [];
    for (let i = 0; i < totalChunks; i++) {
        ordered.push((tracker.chunks[i] || "").replace(/=+$/, ""));
    }
    const raw = ordered.join("");
    const fullBase64 = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const meta = tracker.meta || {};

    delete fbInFlight[fileId];

    if (tracker.mode === "download") {
        fbDownloadFile(fullBase64, meta.fileName || "download", meta.fileType || "application/octet-stream");
    } else if (tracker.mode === "edit") {
        try {
            const binary = atob(fullBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const text = new TextDecoder().decode(bytes);
            fbOpenNewFileModal(meta.fileName || "file.txt", text, fileId);
        } catch (e) {
            setStatus("error", "Could not decode file for editing: " + e.message);
        }
    } else {
        fbViewFile(fullBase64, meta.fileName || "file", meta.fileType || "application/octet-stream");
    }

    // Refresh panel (remove progress indicator)
    if (document.getElementById("functionSelect").value === "file_browser") {
        renderFileBrowserPanel(document.getElementById("dynamicPanel"));
    }
    setStatus("connected", `File received: ${meta.fileName}`);
}

/**
 * Display the file in the image viewer modal (images) or a plain text overlay.
 * No data is written to phone storage.
 */
function fbViewFile(base64Data, fileName, fileType) {
    const modal  = document.getElementById("fileViewerModal");
    const img    = document.getElementById("fileViewerImg");
    const textEl = document.getElementById("fileViewerText");
    const title  = document.getElementById("fileViewerTitle");
    const dlBtn  = document.getElementById("fileViewerDownload");

    if (!modal) return;

    title.textContent = fileName;

    // Store data on the download button for when user taps Download
    dlBtn.dataset.b64  = base64Data;
    dlBtn.dataset.name = fileName;
    dlBtn.dataset.type = fileType;

    if (fileType.startsWith("image/")) {
        img.src = "data:" + fileType + ";base64," + base64Data;
        img.style.display = "";
        if (textEl) textEl.style.display = "none";
    } else if (fileType.startsWith("text/") || fileType === "application/json") {
        if (img) img.style.display = "none";
        if (textEl) {
            try {
                const binary = atob(base64Data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                textEl.textContent = new TextDecoder().decode(bytes);
            } catch {
                textEl.textContent = "Could not display file content.";
            }
            textEl.style.display = "";
        }
    } else {
        if (img) img.style.display = "none";
        if (textEl) { textEl.textContent = "Binary file — use Download to save."; textEl.style.display = ""; }
    }

    modal.classList.add("visible");
}

/** Close the file viewer modal and free the base64 data from the DOM. */
function closeFileViewerModal() {
    const modal = document.getElementById("fileViewerModal");
    if (modal) modal.classList.remove("visible");
    const img = document.getElementById("fileViewerImg");
    if (img) img.src = "";
    const textEl = document.getElementById("fileViewerText");
    if (textEl) textEl.textContent = "";
    const dlBtn = document.getElementById("fileViewerDownload");
    if (dlBtn) { dlBtn.dataset.b64 = ""; dlBtn.dataset.name = ""; dlBtn.dataset.type = ""; }
}

/** Trigger a browser download of the base64 data - saves to phone storage. */
function fbDownloadFile(base64Data, fileName, fileType) {
    // Android WebView: use the native bridge to write to the public Downloads folder.
    if (window.AndroidDownload) {
        const result = window.AndroidDownload.saveFile(
            base64Data,
            fileName,
            fileType || "application/octet-stream"
        );
        if (result === "ok") {
            setStatus("connected", `Saved to Downloads: ${fileName}`);
        } else {
            setStatus("error", "Download failed: " + result);
        }
        return;
    }
    // Fallback for desktop browser testing (anchor-click download).
    try {
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: fileType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
        setStatus("error", "Download failed: " + e.message);
    }
}

/** Download button inside the viewer modal. */
function fbDownloadFromViewer() {
    const dlBtn = document.getElementById("fileViewerDownload");
    if (!dlBtn) return;
    const b64 = dlBtn.dataset.b64 || "";
    const name = dlBtn.dataset.name || "file";
    const type = dlBtn.dataset.type || "application/octet-stream";
    if (!b64) { setStatus("error", "No file data to download."); return; }
    fbDownloadFile(b64, name, type);
}

// ============================================================================
// File Browser: Selection & Actions
// ============================================================================

/** Toggle selection of a file row. Re-renders the panel to update the action bar. */
function fbSelectFile(fileId) {
    fbSelectedFileId = (fbSelectedFileId === fileId) ? null : fileId;
    if (document.getElementById("functionSelect").value === "file_browser") {
        renderFileBrowserPanel(document.getElementById("dynamicPanel"));
    }
}

/**
 * Handle a tap on a file item.
 * Single tap = select/deselect.  Double-tap (within 400 ms) = view or edit.
 */
function fbHandleFileTap(fileId, ownerClient, fileType) {
    const now = Date.now();
    if (fbLastTap.id === fileId && now - fbLastTap.time < 400) {
        fbLastTap = { id: null, time: 0 };
        fbHandleFileDoubleTap(fileId, ownerClient, fileType);
    } else {
        fbLastTap = { id: fileId, time: now };
        fbSelectFile(fileId);
    }
}

/** Double-tap action: images open in the viewer; text files open in the editor. */
function fbHandleFileDoubleTap(fileId, ownerClient, fileType) {
    const ft = fileType || "";
    if (ft.startsWith("image/")) {
        fbRequestFile(fileId, ownerClient, "view");
    } else if (ft.startsWith("text/") || ft === "application/json" || ft === "") {
        fbRequestFile(fileId, ownerClient, "edit");
    } else {
        fbRequestFile(fileId, ownerClient, "view");
    }
}

/** Prompt the user then send a file_delete to the server. */
function fbDeleteFile(fileId, ownerClient, fileName) {
    if (!confirm(`Delete "${fileName}"?\nThis cannot be undone.`)) return;
    if (!wsManager || !wsManager.connected) { setStatus("error", "Not connected."); return; }
    wsManager.send("file_delete", "server", { fileId, ownerClient });
    setStatus("connected", `Deleting ${fileName}...`);
}

/** Download the currently selected file. */
function fbDownloadSelectedFile() {
    if (!fbSelectedFileId) { setStatus("error", "Select a file first."); return; }
    const file = fbFileList.find(f => f.fileId === fbSelectedFileId);
    if (!file) return;
    fbRequestFile(file.fileId, file.ownerClient || "server", "download");
}

/** Open the selected text file in the editor modal. */
function fbEditSelectedFile() {
    if (!fbSelectedFileId) { setStatus("error", "Select a file first."); return; }
    const file = fbFileList.find(f => f.fileId === fbSelectedFileId);
    if (!file) return;
    const ft = file.fileType || "";
    if (!ft.startsWith("text/") && ft !== "application/json" && ft !== "") {
        setStatus("error", "Only text files can be edited.");
        return;
    }
    fbRequestFile(file.fileId, file.ownerClient || "server", "edit");
}

/** Trigger the hidden file-pick input for uploading a local file. */
function fbUploadFile() {
    const input = document.getElementById("fbUploadInput");
    if (input) input.click();
}

/**
 * Called when the user picks a file via the upload input.
 * Splits the file into 512 KB chunks and sends each as a file_upload message
 * targeted at the server, which stores it in the shared transfers directory.
 */
function fbHandleUploadChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!wsManager || !wsManager.connected) { setStatus("error", "Not connected."); return; }

    const CHUNK_BYTES = 512 * 1024;
    const reader = new FileReader();
    reader.onload = (e) => {
        const buffer = e.target.result;
        const totalBytes = buffer.byteLength;
        const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTES));
        const fileId = "upload-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        const now = new Date().toISOString();

        for (let i = 0; i < totalChunks; i++) {
            const slice = buffer.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
            const bytes = new Uint8Array(slice);
            let binary = "";
            for (let b = 0; b < bytes.length; b++) binary += String.fromCharCode(bytes[b]);
            wsManager.send("file_upload", "server", {
                fileId,
                fileName: file.name,
                fileType: file.type || "application/octet-stream",
                fileSize: totalBytes,
                chunkIndex: i,
                totalChunks,
                data: btoa(binary),
                sentAt: now,
                source: CONFIG.CLIENT_NAME,
                target: "server",
            });
        }
        setStatus("connected", `Uploading ${file.name} (${totalChunks} chunk(s))…`);
    };
    reader.readAsArrayBuffer(file);
    // Reset so the same file can be re-uploaded later
    event.target.value = "";
}

/**
 * Open the file editor modal.
 * Pass prefillName / prefillContent to pre-populate (edit mode).
 * Pass null for both to open in "New File" mode.
 */
function fbOpenNewFileModal(prefillName, prefillContent, fileId = null) {
    const modal = document.getElementById("fbFileEditorModal");
    if (!modal) return;
    const titleEl = document.getElementById("fbEditorModalTitle");
    if (titleEl) titleEl.textContent = (prefillContent !== null && prefillContent !== undefined) ? "Edit File" : "New File";
    document.getElementById("fbEditorFilename").value = prefillName || "new_file.txt";
    document.getElementById("fbEditorContent").value  = prefillContent || "";
    fbEditingFileId = fileId;
    modal.classList.add("visible");
}

/** Close the file editor modal. */
function closeFbFileEditorModal() {
    const modal = document.getElementById("fbFileEditorModal");
    if (modal) modal.classList.remove("visible");
    fbEditingFileId = null;
}

/**
 * Save the file from the editor modal to the server.
 * Encodes the text content as UTF-8, chunks it, and sends each chunk as file_upload.
 */
function fbSaveFileFromEditor() {
    if (!wsManager || !wsManager.connected) { setStatus("error", "Not connected."); return; }

    let filename = (document.getElementById("fbEditorFilename")?.value || "").trim();
    const content = document.getElementById("fbEditorContent")?.value || "";
    if (!filename) { alert("Please enter a filename."); return; }
    // Default to .txt if no extension
    if (!filename.includes(".")) filename += ".txt";

    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    const CHUNK_BYTES = 512 * 1024;
    const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    const fileId = fbEditingFileId || ("new-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    const now = new Date().toISOString();

    for (let i = 0; i < totalChunks; i++) {
        const slice = bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        let binary = "";
        slice.forEach(b => binary += String.fromCharCode(b));
        wsManager.send("file_upload", "server", {
            fileId,
            fileName: filename,
            fileType: "text/plain",
            fileSize: bytes.length,
            chunkIndex: i,
            totalChunks,
            data: btoa(binary),
            sentAt: now,
            source: CONFIG.CLIENT_NAME,
            target: "server",
        });
    }

    setStatus("connected", `Saving ${filename}…`);
    closeFbFileEditorModal();
}

// ============================================================================
// Topics Management
// ============================================================================

let editingTopicId = null;  // null = creating new, string = editing existing

function openTopicModal(topicToEdit) {
    const modal = document.getElementById("topicModal");
    const title = document.getElementById("topicModalTitle");
    const nameInput = document.getElementById("topicNameInput");
    const infoInput = document.getElementById("topicInfoInput");
    if (!modal) return;

    if (topicToEdit) {
        editingTopicId = topicToEdit.id;
        if (title) title.textContent = "Edit Topic";
        if (nameInput) nameInput.value = topicToEdit.name || "";
        if (infoInput) infoInput.value = topicToEdit.info || "";
    } else {
        editingTopicId = null;
        if (title) title.textContent = "Create New Topic";
        if (nameInput) nameInput.value = "";
        if (infoInput) infoInput.value = "";
    }

    modal.classList.add("visible");
}

function closeTopicModal() {
    const modal = document.getElementById("topicModal");
    if (modal) modal.classList.remove("visible");
    editingTopicId = null;
}

function openTopicModalFromSelect(action) {
    if (action === "edit") {
        // Find the first selected topic to edit
        const selected = serverTopics.find(t => selectedTopicIds.has(t.id));
        if (!selected) {
            alert("Select a topic to edit first.");
            return;
        }
        // Close the Select Topics window first, then open Edit
        const selectModal = document.getElementById("topicSelectModal");
        if (selectModal) selectModal.classList.remove("visible");
        openTopicModal(selected);
    } else {
        // Close the Select Topics window first, then open Create New Topic
        const selectModal = document.getElementById("topicSelectModal");
        if (selectModal) selectModal.classList.remove("visible");
        openTopicModal(null);
    }
}

function saveTopic() {
    const nameInput = document.getElementById("topicNameInput");
    const infoInput = document.getElementById("topicInfoInput");
    const name = nameInput ? nameInput.value.trim() : "";
    const info = infoInput ? infoInput.value.trim() : "";

    if (!name || !info) {
        alert("Please enter both a topic name and information.");
        return;
    }

    if (wsManager && wsManager.connected) {
        if (editingTopicId) {
            wsManager.send("topic_update", "server", { id: editingTopicId, name, info });
            setStatus("connected", `Topic "${name}" updated.`);
        } else {
            wsManager.send("topic_create", "server", { name, info });
            setStatus("connected", `Topic "${name}" sent to server.`);
        }

        nameInput.value = "";
        infoInput.value = "";
        closeTopicModal();
    } else {
        setStatus("error", "Not connected to server.");
    }
}

function syncTopics() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    wsManager.send("topic_sync", "server", { topics: serverTopics });
    setStatus("connected", "Syncing topics...");
}

function openTopicSelectModal() {
    const modal = document.getElementById("topicSelectModal");
    if (modal) {
        modal.classList.add("visible");
        renderTopicSelectList();
    }
}

function closeTopicSelectModal() {
    const modal = document.getElementById("topicSelectModal");
    if (modal) {
        modal.classList.remove("visible");
        // Update the main panel's display of selected topics
        if (document.getElementById("functionSelect").value === "llm_chat") {
            const display = document.getElementById("topicDisplay");
            if (display) {
                const selectedTopics = serverTopics.filter(t => selectedTopicIds.has(t.id));
                const text = selectedTopics.length > 0 
                    ? selectedTopics.map(t => t.name).join(", ") 
                    : "Select topics...";
                display.textContent = text;
                display.title = text;
            }
        }
    }
}

function renderTopicSelectList() {
    const container = document.getElementById("topicSelectList");
    if (!container) return;
    container.innerHTML = "";

    if (serverTopics.length === 0) {
        container.innerHTML = '<div class="empty-list">No topics found on server.</div>';
        return;
    }

    serverTopics.forEach((topic) => {
        const item = document.createElement("div");
        const isSelected = selectedTopicIds.has(topic.id);
        item.className = "topic-select-item" + (isSelected ? " selected" : "");
        
        item.innerHTML = `
            <input type="checkbox" class="topic-select-checkbox" ${isSelected ? "checked" : ""} />
            <div class="topic-select-info">
                <div class="topic-select-name">${escapeHtml(topic.name)}</div>
                <div class="topic-select-desc">${escapeHtml(topic.info.substring(0, 60))}${topic.info.length > 60 ? "..." : ""}</div>
            </div>
        `;

        item.addEventListener("click", (e) => {
            // Toggle checkbox and selection
            if (selectedTopicIds.has(topic.id)) {
                selectedTopicIds.delete(topic.id);
            } else {
                selectedTopicIds.add(topic.id);
            }
            renderTopicSelectList();
        });

        container.appendChild(item);
    });
}
