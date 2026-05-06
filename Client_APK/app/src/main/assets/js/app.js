/**
 * procMessenger Mobile - App Coordinator
 *
 * Slim coordinator: initialisation, main-tab switching, event wiring,
 * function dropdown, and the dynamic panel router.
 *
 * All state variables live in state.js.
 * Feature logic lives in the individual module files (connection.js,
 * messaging.js, llm.js, branch-shredder.js, file-browser.js,
 * blog-entry.js, topics.js, proc-index.js).
 */

// --- Initialization ---

document.addEventListener("DOMContentLoaded", () => {
    loadNicknames();
    loadTopicsFromLocal();
    setupEventListeners();
    setupLinkHandler();
    populateFunctionDropdown();
    updateDynamicPanel();
    updateConnectionButtons("disconnected");

    // Wire up main tab bar
    document.querySelectorAll(".main-tab").forEach(tab => {
        tab.addEventListener("click", () => switchMainTab(tab.dataset.tab));
    });

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

// --- Main Tab Switching ---

function switchMainTab(tabName) {
    activeMainTab = tabName;
    // Update tab bar
    document.querySelectorAll(".main-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.tab === tabName);
    });
    // Update panels
    document.querySelectorAll(".tab-panel").forEach(p => {
        p.classList.toggle("active", p.dataset.panel === tabName);
    });
    // Clear badge on Logs tab
    if (tabName === "logs") {
        logUnreadCount = 0;
        updateLogBadge();
        renderLogsPanel();
    } else if (tabName === "files") {
        renderFilesTab();
    }
}

function updateLogBadge() {
    const badge = document.getElementById("logBadge");
    if (!badge) return;
    if (logUnreadCount > 0) {
        badge.textContent = String(logUnreadCount);
        badge.style.display = "inline-flex";
    } else {
        badge.style.display = "none";
    }
}

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
    // Re-evaluate function dropdown for currently selected client
    const selName = Array.from(selectedTargets)[0] || null;
    updateFunctionDropdownForClient(selName);
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

        // Toggle selection on tap (single-select)
        item.addEventListener("click", (e) => {
            if (e.target.classList.contains("btn-nickname")) return;
            const wasSelected = selectedTargets.has(client.name);
            selectedTargets.clear();
            if (!wasSelected) {
                selectedTargets.add(client.name);
            }
            renderClientList();
            updateFunctionDropdownForClient(wasSelected ? null : client.name);
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
                renderLogsPanel();
            }
        });

        container.appendChild(item);
    });
}

/**
 * Update the function dropdown (and auto-select) based on what the named client supports.
 * - No client selected: show full list, keep current selection.
 * - Client with 0 registered functions: show full list.
 * - Client with 1 function: hide dropdown, auto-select.
 * - Client with 2+ functions: show filtered dropdown.
 */
function updateFunctionDropdownForClient(clientName) {
    const client = clientName ? connectedClients.find(c => c.name === clientName) : null;
    const clientFunctions = (client && Array.isArray(client.functions) && client.functions.length > 0)
        ? client.functions
        : null;

    const select = document.getElementById("functionSelect");
    const sectionTitle = document.getElementById("functionSectionTitle");
    if (!select) return;

    if (!clientFunctions) {
        // No filter — restore full list
        select.style.display = "";
        if (sectionTitle) sectionTitle.style.display = "";
        // Repopulate from config if we previously narrowed the list
        const currentVal = select.value;
        populateFunctionDropdown();
        if (currentVal) select.value = currentVal;
        updateDynamicPanel();
        return;
    }

    const available = CONFIG.MESSAGE_TYPES.filter(mt => clientFunctions.includes(mt.value));

    if (available.length === 1) {
        // Single function: hide the select label + select element, auto-select
        select.innerHTML = `<option value="${available[0].value}">${available[0].label}</option>`;
        select.value = available[0].value;
        select.style.display = "none";
        if (sectionTitle) sectionTitle.style.display = "none";
    } else {
        // Multiple functions: show filtered dropdown
        select.style.display = "";
        if (sectionTitle) sectionTitle.style.display = "";
        const currentVal = select.value;
        select.innerHTML = '<option value="" disabled>Select functionality...</option>';
        available.forEach(mt => {
            const opt = document.createElement("option");
            opt.value = mt.value;
            opt.textContent = mt.label;
            select.appendChild(opt);
        });
        // Restore previous selection if still valid, otherwise default to first
        if (available.find(mt => mt.value === currentVal)) {
            select.value = currentVal;
        } else {
            select.value = available[0].value || "";
        }
    }
    updateDynamicPanel();
}

// --- Function Dropdown & Dynamic Panel ---

function populateFunctionDropdown() {
    const select = document.getElementById("functionSelect");
    // Clear except the placeholder
    select.innerHTML = '<option value="" disabled selected>Select functionality...</option>';
    CONFIG.MESSAGE_TYPES.forEach((mt) => {
        const opt = document.createElement("option");
        opt.value = mt.value;
        opt.textContent = mt.label;
        select.appendChild(opt);
    });
}

function updateDynamicPanel(force = false) {
    const type = document.getElementById("functionSelect").value;
    const panel = document.getElementById("dynamicPanel");

    // Skip rebuild when the same function type is already rendered.
    // This preserves user input (typed queries, selected scripts, etc.)
    // when switching clients or receiving server-push updates that don't
    // change the active function.  Pass force=true to override (e.g. when
    // fresh provider / mode data arrives for the LLM panel).
    if (!force && panel.dataset.activeFunction === type) return;
    panel.dataset.activeFunction = type;

    switch (type) {
        case "run_script":
            panel.innerHTML = `
                <div class="llm-row">
                    <div class="llm-field" style="flex:1">
                        <label>Script:</label>
                        <select id="scriptSelect" class="full-width">
                            <option value="">-- Loading scripts... --</option>
                        </select>
                    </div>
                    <button id="btnListScripts" class="btn-secondary" style="align-self:flex-end" title="Reload script list">&#x21BB;</button>
                </div>
                <label>Arguments (space-separated):</label>
                <input type="text" id="scriptArgs" class="full-width" placeholder="arg1 arg2 arg3" />
            `;
            document.getElementById("btnListScripts").addEventListener("click", requestScriptList);
            requestScriptList();
            break;

        case "gather_research":
            panel.innerHTML = `
                <label>Search Query:</label>
                <input type="text" id="researchQuery" class="full-width" placeholder="What would you like to research?" />
                <label>Max Results:</label>
                <input type="number" id="researchMaxResults" class="full-width" value="5" min="1" max="20" />
                <div id="grStatus" class="gr-status hidden"></div>
                <div id="grCardList" class="research-card-list"></div>
            `;
            // Restore any results that arrived before this panel was last opened
            if (typeof _syncGatherResearchPanel === "function") _syncGatherResearchPanel();
            break;

        case "edit_story":
            renderBranchShredderPanel(panel);
            break;

        case "llm_chat":
            renderLlmPanel(panel);
            break;

        case "blog_entry":
            renderBlogEntryPanel(panel);
            break;

        case "procIndex":
            renderProcIndexPanel(panel);
            break;

        default:
            panel.innerHTML = '<div class="empty-list">Select a function above</div>';
    }
}

