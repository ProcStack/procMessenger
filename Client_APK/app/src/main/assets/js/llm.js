/**
 * procMessenger Mobile - LLM Chat
 *
 * LLM Chat panel rendering, message sending/receiving, Markdown rendering,
 * chat history modal, and Gather Research result handling.
 */

// --- LLM Chat Panel ---

function renderLlmPanel(panel) {
    const providerOpts = llmProviders.length > 0
        ? llmProviders.map(p => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join("")
        : '<option value="llama">Llama (Local)</option>';

    const modeOpts = llmModes.length > 0
        ? llmModes.map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join("")
        : '<option value="ask">Ask</option><option value="agent">Agent</option><option value="plan">Plan</option>';

    const systemPromptOpts = llmSystemPrompts.length > 0
        ? llmSystemPrompts.map(sp => `<option value="${escapeHtml(sp.value)}"${sp.value === "Default" ? " selected" : ""}>${escapeHtml(sp.label)}</option>`).join("")
        : '<option value="Default">Default</option>';

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
                <div class="llm-field">
                    <label>Prompt:</label>
                    <select id="llmSystemPrompt">${systemPromptOpts}</select>
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
        <div id="researchDrawer" class="research-drawer hidden">
            <button id="researchDrawerToggle" class="research-drawer-toggle" onclick="toggleResearchDrawer()">
                <span id="researchDrawerLabel">Research Results</span>
                <span id="researchDrawerChevron" class="research-drawer-chevron">&#9660;</span>
            </button>
            <div id="researchDrawerBody" class="research-drawer-body">
                <div id="researchCardList" class="research-card-list"></div>
            </div>
        </div>
        <div id="parsedContextBar" class="parsed-context-bar hidden">
            <div class="parsed-context-label">Added to context:</div>
            <div id="parsedContextList" class="parsed-context-list"></div>
        </div>
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

    // Restore research results drawer if results are already in state
    // (e.g. user ran a search on Gather Research then switched here)
    _syncResearchDrawer();
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
    const systemPrompt = document.getElementById("llmSystemPrompt")?.value || "Default";
    
    // Include selected topics in payload
    const selectedTopics = serverTopics.filter(t => selectedTopicIds.has(t.id));

    wsManager.send("llm_chat", "llm-chat", {
        chatName: chatName,
        message: messageContent,
        provider: provider,
        mode: mode,
        model: model,
        systemPrompt: systemPrompt,
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
        // Show thinking indicator in LLM Chat panel
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
        // Also show status in Gather Research panel if that's what's visible
        const grStatus = document.getElementById("grStatus");
        if (grStatus) {
            grStatus.textContent = "Searching the web\u2026";
            grStatus.classList.remove("hidden");
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

// ---------------------------------------------------------------------------
// Gather Research – result cards and action modal
// ---------------------------------------------------------------------------

/**
 * Receive gather_research_results from the LLM Chat server.
 * Results are stored but NOT added to llmChatHistory.
 */
function handleGatherResearchResults(payload) {
    const chatName    = payload.chatName    || "";
    const results     = payload.results     || [];
    const searchQuery = payload.searchQuery || "";
    const error       = payload.error       || "";

    llmResearchResults  = results;
    llmResearchChatName = chatName;

    // Adopt the research chat as active so the LLM acknowledgement message shows
    if (chatName) {
        llmActiveChatName = chatName;
        llmChatHistory = [];
        const chatNameInput = document.getElementById("llmChatName");
        if (chatNameInput) chatNameInput.value = chatName;
    }
    // Refresh chat messages (acknowledgement) and the standalone results drawer
    renderLlmChatMessages();
    _syncResearchDrawer();
    // Also render into the Gather Research panel if it is currently open
    _syncGatherResearchPanel();

    if (error) {
        addMessageToTab("llm-chat", "in", "gather_research_results",
            `Search error: ${error}`);
    } else {
        addMessageToTab("llm-chat", "in", "gather_research_results",
            `Found ${results.length} result(s) for: "${searchQuery}"`);
    }
}

/**
 * Receive gather_research_action response from the LLM Chat server.
 * Updates the card state or shows a log warning for procIndex unavailability.
 */
function handleGatherResearchActionResult(payload) {
    const action   = payload.action   || "";
    const resultId = payload.resultId || "";
    const status   = payload.status   || "";
    const message  = payload.message  || "";

    const card = document.querySelector(`.research-card[data-result-id="${CSS.escape(resultId)}"]`);

    if (status === "procIndex_unavailable") {
        // Surface the warning in the log tab
        addMessageToTab("llm-chat", "in", "gather_research_action",
            `\u26A0 procIndex unavailable: ${message}`);
        if (card) {
            const actionsEl = card.querySelector(".research-card-actions");
            if (actionsEl) {
                actionsEl.innerHTML =
                    `<span class="research-status-warn">procIndex not connected</span>`;
            }
        }
        return;
    }

    if (action === "index" && status === "indexed") {
        llmResearchResults = llmResearchResults.filter(r => r.resultId !== resultId);
        _syncResearchDrawer();
        _syncGatherResearchPanel();
        addMessageToTab("llm-chat", "in", "gather_research_action",
            `Indexed: ${payload.title || resultId}`);
        return;
    }

    if (action === "parse" && status === "added") {
        // Mark the card in the drawer
        if (card) {
            const actionsEl = card.querySelector(".research-card-actions");
            if (actionsEl) {
                actionsEl.innerHTML =
                    `<span class="research-status-ok">\u2713 Added to chat context</span>`;
            }
        }
        // Add the title to the parsed context bar
        const bar  = document.getElementById("parsedContextBar");
        const list = document.getElementById("parsedContextList");
        if (bar && list) {
            const title = payload.title || resultId;
            const chip = document.createElement("span");
            chip.className = "parsed-context-chip";
            chip.textContent = title;
            list.appendChild(chip);
            bar.classList.remove("hidden");
        }
        addMessageToTab("llm-chat", "in", "gather_research_action",
            `Parsed into chat context: ${payload.title || resultId}`);
    }
}

/**
 * Build research result cards into any container element.
 * Shared by both the LLM Chat drawer and the Gather Research panel.
 */
function _buildResearchCards(cardList) {
    cardList.innerHTML = "";
    llmResearchResults.forEach((result) => {
        const card = document.createElement("div");
        card.className = "research-card";
        card.dataset.resultId = result.resultId || "";

        const titleEl = document.createElement("div");
        titleEl.className   = "research-card-title";
        titleEl.textContent = result.title || "(no title)";

        const urlEl = document.createElement("div");
        urlEl.className   = "research-card-url";
        urlEl.textContent = result.url || "";

        const snippetEl = document.createElement("div");
        snippetEl.className   = "research-card-snippet";
        const snip = result.snippet || "";
        snippetEl.textContent = snip.length > 180
            ? snip.substring(0, 180) + "\u2026"
            : snip;

        const actionsEl = document.createElement("div");
        actionsEl.className = "research-card-actions";

        card.appendChild(titleEl);
        card.appendChild(urlEl);
        card.appendChild(snippetEl);
        card.appendChild(actionsEl);

        card.addEventListener("click", () => showResearchResultModal(result));
        cardList.appendChild(card);
    });
}

/**
 * Sync the research results drawer (inside LLM Chat panel) with current results.
 * Call any time results change.
 */
function _syncResearchDrawer() {
    const drawer   = document.getElementById("researchDrawer");
    const cardList = document.getElementById("researchCardList");
    const label    = document.getElementById("researchDrawerLabel");
    if (!drawer || !cardList) return;

    if (!llmResearchResults.length) {
        drawer.classList.add("hidden");
        return;
    }

    drawer.classList.remove("hidden");
    if (label) {
        label.textContent =
            `Research Results \u2014 ${llmResearchResults.length} found`;
    }
    _buildResearchCards(cardList);
}

/**
 * Sync the research result cards into the Gather Research panel (#grCardList).
 * Safe to call even when the panel is not currently rendered — will no-op.
 */
function _syncGatherResearchPanel() {
    const grCardList = document.getElementById("grCardList");
    const grStatus   = document.getElementById("grStatus");
    if (!grCardList) return;

    if (!llmResearchResults.length) {
        grCardList.innerHTML = "";
        return;
    }

    if (grStatus) {
        grStatus.textContent = `Found ${llmResearchResults.length} result(s) — tap a card to index or parse`;
        grStatus.classList.remove("hidden");
    }
    _buildResearchCards(grCardList);
}

/**
 * Toggle the research drawer open/closed.
 */
function toggleResearchDrawer() {
    const body    = document.getElementById("researchDrawerBody");
    const chevron = document.getElementById("researchDrawerChevron");
    if (!body) return;
    const isOpen = !body.classList.contains("collapsed");
    body.classList.toggle("collapsed", isOpen);
    if (chevron) chevron.innerHTML = isOpen ? "&#9650;" : "&#9660;";
}

/**
 * Open the research result action sheet for a single result.
 */
function showResearchResultModal(result) {
    const modal = document.getElementById("researchResultModal");
    if (!modal) return;

    document.getElementById("rrModalTitle").textContent =
        result.title || "(no title)";
    document.getElementById("rrModalUrl").textContent =
        result.url   || "";
    const snip = result.snippet || "";
    document.getElementById("rrModalSnippet").textContent =
        snip.length > 500 ? snip.substring(0, 500) + "\u2026" : snip;

    // Index button
    document.getElementById("rrBtnIndex").onclick = () => {
        closeResearchResultModal();
        if (!wsManager || !wsManager.connected) {
            setStatus("error", "Not connected to server.");
            return;
        }
        const provider = document.getElementById("llmProvider")?.value
            || (llmProviders.length > 0 ? llmProviders[0].value : "llama");
        const model    = document.getElementById("llmModel")?.value    || "";
        wsManager.send("gather_research_action", "llm-chat", {
            action:    "index",
            chatName:  llmActiveChatName,
            resultId:  result.resultId,
            url:       result.url,
            title:     result.title,
            snippet:   result.snippet,
            provider:  provider,
            model:     model,
        });
        addMessageToTab("llm-chat", "out", "gather_research_action",
            `Index: ${result.title}`);
    };

    // Parse button
    document.getElementById("rrBtnParse").onclick = () => {
        closeResearchResultModal();
        if (!wsManager || !wsManager.connected) {
            setStatus("error", "Not connected to server.");
            return;
        }
        wsManager.send("gather_research_action", "llm-chat", {
            action:   "parse",
            chatName: llmActiveChatName,
            resultId: result.resultId,
            url:      result.url,
            title:    result.title,
            snippet:  result.snippet,
        });
        addMessageToTab("llm-chat", "out", "gather_research_action",
            `Parse: ${result.title}`);
    };

    // Dismiss button
    document.getElementById("rrBtnDismiss").onclick = () => {
        closeResearchResultModal();
        llmResearchResults = llmResearchResults.filter(
            r => r.resultId !== result.resultId
        );
        _syncResearchDrawer();
        _syncGatherResearchPanel();
    };

    modal.classList.add("visible");
}

/** Close the research result action modal. */
function closeResearchResultModal() {
    const modal = document.getElementById("researchResultModal");
    if (modal) modal.classList.remove("visible");
}
