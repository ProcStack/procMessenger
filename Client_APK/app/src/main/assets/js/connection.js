/**
 * procMessenger Mobile - Connection & Client List
 *
 * WebSocket connection management, status display, recent IPs,
 * and connected client list rendering.
 */

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
