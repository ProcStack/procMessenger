/**
 * procMessenger Mobile - Messaging
 *
 * Outgoing message dispatch (handleSend), incoming message router (onMessage),
 * and the message log tab system.
 */

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

    // Blog entry sends to the blog-client target
    if (type === "blog_entry") {
        handleBlogEntrySend();
        return;
    }

    // procIndex always targets the procIndex client directly
    if (type === "procIndex") {
        procIndexSearch();
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
        // Update connected client list with server-known clients (includes functions)
        if (Array.isArray(payload.clients) && payload.clients.length > 0) {
            onClientListUpdate(payload.clients);
        }
        // Refresh panels that depend on this data
        const functionType = document.getElementById("functionSelect").value;
        if (functionType === "llm_chat") {
            updateDynamicPanel(true);
        }
        if (activeMainTab === "files") {
            renderFilesTab();
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
        llmSystemPrompts = payload.systemPrompts || [];
        // Re-render panel if LLM Chat is selected (force=true: fresh provider data must be reflected)
        if (document.getElementById("functionSelect").value === "llm_chat") {
            updateDynamicPanel(true);
        }
        addMessageToTab(source, "in", type, `LLM Chat online. Providers: ${llmProviders.map(p => p.label).join(", ")}`);
        return;
    }

    if (type === "llm_modes") {
        llmProviders = payload.providers || llmProviders;
        llmModes = payload.modes || llmModes;
        llmSystemPrompts = payload.systemPrompts || llmSystemPrompts;
        if (document.getElementById("functionSelect").value === "llm_chat") {
            updateDynamicPanel(true);
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
        // Refresh Files tab if it is currently visible
        if (activeMainTab === "files") {
            renderFilesTab();
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
            if (activeMainTab === "files") {
                renderFilesTab();
            }
            setStatus("connected", `Deleted: ${payload.fileName || payload.fileId}`);
        } else {
            setStatus("error", `Delete failed: ${payload.error || "unknown error"}`);
        }
        return;
    }

    // --- Blog Entry messages ---
    if (type === "blog_entry") {
        handleBlogEntryResponse(payload);
        return;
    }

    // --- branchShredder extension messages ---

    if (type === "viewport" || type === "viewport_snapshot") {
        bsViewportLoading = false;
        if (payload.status === "error") {
            bsUpdateViewportLoading(false);
            addMessageToTab(source, "in", type, `Viewport error: ${payload.error || "unknown error"}`);
            return;
        }
        if (payload.viewportState) {
            bsUpdateViewportStateBar(payload.viewportState);
        }
        bsRenderViewportImage(payload.image);
        bsUpdateViewportLoading(false);
        const stateStr = bsViewportState ? ` | ${bsFormatViewportState(bsViewportState)}` : "";
        const label = payload.image
            ? `Viewport image received${stateStr}`
            : `Viewport ${payload.status || "response"} (no image)${stateStr}`;
        addMessageToTab(source, "in", type, label);
        return;
    }

    if (type === "viewport_info") {
        addMessageToTab(source, "in", type, "Viewport info received:\n" + JSON.stringify(payload, null, 2));
        return;
    }

    if (type === "viewport_tap") {
        // Always update state first — ensures pixelWidth/pixelHeight are fresh for the next tap
        if (payload.viewportState) {
            bsUpdateViewportStateBar(payload.viewportState);
        }
        if (payload.status === "error") {
            bsUpdateViewportLoading(false);
            addMessageToTab(source, "in", type, `Viewport tap error: ${payload.error || "unknown error"}`);
            return;
        }
        // Render the updated viewport image included with the tap response
        bsRenderViewportImage(payload.image);
        bsUpdateViewportLoading(false);
        const node = payload.node;
        if (node) {
            // Pre-populate the update form with the tapped node, same as get_node
            const selUpdate = document.getElementById("bsUpdateNodeSelect");
            if (selUpdate) {
                let found = false;
                for (const opt of selUpdate.options) {
                    if (opt.value === node.nodeId) { selUpdate.value = node.nodeId; found = true; break; }
                }
                if (!found) {
                    const opt = document.createElement("option");
                    opt.value = node.nodeId;
                    opt.textContent = `[${node.type}] ${node.name}`;
                    selUpdate.appendChild(opt);
                    selUpdate.value = node.nodeId;
                }
            }
            const nameInput   = document.getElementById("bsUpdateName");
            const contentArea = document.getElementById("bsUpdateContent");
            if (nameInput)   nameInput.value   = node.name    || "";
            if (contentArea) contentArea.value = node.content || "";
            const text = `viewport_tap: ${node.name} [${node.type}]\n\n` + (node.content || "(no content)");
            addMessageToTab(source, "in", type, text);
        } else {
            addMessageToTab(source, "in", type, "viewport_tap: no node at tap position (selection cleared)");
        }
        return;
    }

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

    // --- Gather Research results (not part of chat history) ---
    if (type === "gather_research_results") {
        handleGatherResearchResults(payload);
        return;
    }

    if (type === "gather_research_action") {
        handleGatherResearchActionResult(payload);
        return;
    }

    // --- procIndex messages ---
    if (type === "procIndex") {
        handleProcIndexResponse(source, payload);
        return;
    }

    // --- Standard message handling ---

    // Handle script list responses - update the dropdown, preserving any prior selection
    if (type === "run_script" && payload.action === "script_list") {
        const select = document.getElementById("scriptSelect");
        if (select) {
            const previousValue = select.value;
            select.innerHTML = "";
            (payload.scripts || []).forEach((s) => {
                const opt = document.createElement("option");
                opt.value = s.name;
                opt.textContent = `${s.name} - ${s.description}`;
                select.appendChild(opt);
            });
            if ((payload.scripts || []).length === 0) {
                select.innerHTML = '<option value="">No scripts available</option>';
            } else if (previousValue) {
                // Restore prior selection if the script still exists in the new list
                select.value = previousValue;
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
    } else if (type === "blog_entry") {
        displayText = payload.message || JSON.stringify(payload, null, 2);
    } else if (type === "procIndex") {
        displayText = JSON.stringify(payload, null, 2);
    } else if (type === "error") {
        displayText = `Error [${payload.code}]: ${payload.message}`;
    } else {
        displayText = JSON.stringify(payload, null, 2);
    }

    addMessageToTab(source, "in", type, displayText);
}

// --- Message / Log System ---

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

    // Auto-switch active log tab if this is the first message for a source
    if (!activeTab) {
        activeTab = clientName;
    }

    // If Logs tab is visible, re-render it in-place; otherwise increment the badge
    if (activeMainTab === "logs") {
        renderLogsPanel();
    } else {
        logUnreadCount++;
        updateLogBadge();
    }
}

function renderLogsPanel() {
    renderLogTabs();
    renderLogMessages();
}

function renderLogTabs() {
    const container = document.getElementById("logsTabTabs");
    if (!container) return;
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
            renderLogTabs();
            renderLogMessages();
        });
        container.appendChild(tab);
    });
}

function renderLogMessages() {
    const container = document.getElementById("logsTabMessages");
    if (!container) return;
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
