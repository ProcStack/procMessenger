/**
 * procMessenger Mobile - procIndex
 *
 * Keyword search and entry viewer for the procIndex knowledge-base service.
 */

/** Render the procIndex search panel inside the dynamic panel container. */
function renderProcIndexPanel(panel) {
    const online = piAnnounceInfo !== null;
    const statusClass = online ? "pi-status-online" : "pi-status-offline";
    const statusText = online
        ? `procIndex online \u2014 ${piAnnounceInfo.totalEntries || 0} entries ` +
          `(${piAnnounceInfo.indexed || 0} indexed, ${piAnnounceInfo.toParse || 0} staged)`
        : "procIndex not detected \u2014 start the procIndex service";

    const resultsHtml = piSearchResults.length > 0
        ? piSearchResults.map(r => piRenderResultItem(r)).join("")
        : '<div class="empty-list">Enter keywords and tap Search</div>';

    panel.innerHTML = `
        <div class="pi-panel">
            <div class="pi-status-bar ${statusClass}">${escapeHtml(statusText)}</div>
            <div class="pi-search-row">
                <input type="text" id="piQuery" class="pi-query-input"
                       placeholder="Search keywords..." />
                <button id="piBtnSearch" class="btn-primary btn-sm">Search</button>
            </div>
            <div class="pi-options-row">
                <label class="pi-option-label">Max&nbsp;results:
                    <input type="number" id="piMaxResults" class="pi-max-input"
                           value="10" min="1" max="50" />
                </label>
                <label class="pi-option-label">
                    <input type="checkbox" id="piIncludeAll" checked />
                    All statuses
                </label>
            </div>
            <div id="piResultsList" class="pi-results-list">
                ${resultsHtml}
            </div>
        </div>
    `;

    document.getElementById("piBtnSearch").addEventListener("click", procIndexSearch);
    document.getElementById("piQuery").addEventListener("keydown", (e) => {
        if (e.key === "Enter") procIndexSearch();
    });

    // Re-attach tap listeners if there are existing results
    if (piSearchResults.length > 0) {
        panel.querySelectorAll(".pi-result-item").forEach(item => {
            item.addEventListener("click", () => procIndexGetEntry(item.dataset.id));
        });
    }
}

/** Build HTML for a single search result row. */
function piRenderResultItem(r) {
    const sim = typeof r.similarity === "number"
        ? `<span class="pi-result-sim">${(r.similarity * 100).toFixed(0)}%</span>`
        : "";
    const kw = (r.keywords || []).slice(0, 6).join(", ");
    const statusClass = r.status === "indexed" ? "pi-badge-indexed" : "pi-badge-staged";
    const statusLabel = r.status === "indexed" ? "indexed" : "staged";

    return `
        <div class="pi-result-item" data-id="${escapeHtml(r.id || "")}">
            <div class="pi-result-header">
                <span class="pi-result-title">${escapeHtml(r.title || r.id || "Untitled")}</span>
                <span class="pi-badge ${statusClass}">${statusLabel}</span>
                ${sim}
            </div>
            ${kw ? `<div class="pi-result-keywords">${escapeHtml(kw)}</div>` : ""}
        </div>
    `;
}

/** Send a search request to the procIndex service. */
function procIndexSearch() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    const query = document.getElementById("piQuery")?.value.trim() || "";
    if (!query) {
        setStatus("error", "Enter a search query.");
        return;
    }

    const maxResults = parseInt(document.getElementById("piMaxResults")?.value || "10", 10);
    const includeAll = document.getElementById("piIncludeAll")?.checked !== false;

    const payload = { action: "search", query, maxResults };
    if (!includeAll) {
        payload.includeStatus = ["indexed"];
    }

    wsManager.send("procIndex", "procIndex", payload);
    addMessageToTab("procIndex", "out", "procIndex", `Search: ${query}`);
    setStatus("connected", "Searching procIndex\u2026");

    const listEl = document.getElementById("piResultsList");
    if (listEl) listEl.innerHTML = '<div class="empty-list">Searching\u2026</div>';
}

/** Request the full content of a single entry by ID. */
function procIndexGetEntry(entryId) {
    if (!entryId) return;
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    wsManager.send("procIndex", "procIndex", { action: "get", id: entryId });
    addMessageToTab("procIndex", "out", "procIndex", `Get entry: ${entryId}`);
    setStatus("connected", "Loading entry\u2026");
}

/**
 * Handle all incoming procIndex messages dispatched from onMessage().
 * Covers: announce, search, get, and unrecognised actions.
 */
function handleProcIndexResponse(source, payload) {
    const action = payload.action || "";

    // --- announce: procIndex came online ---
    if (action === "announce") {
        piAnnounceInfo = payload;
        // Update the status bar if the procIndex panel is currently visible
        if (document.getElementById("functionSelect").value === "procIndex") {
            const statusEl = document.querySelector(".pi-status-bar");
            if (statusEl) {
                statusEl.className = "pi-status-bar pi-status-online";
                statusEl.textContent =
                    `procIndex online \u2014 ${payload.totalEntries || 0} entries ` +
                    `(${payload.indexed || 0} indexed, ${payload.toParse || 0} staged)`;
            }
        }
        addMessageToTab(source, "in", "procIndex",
            `procIndex online \u2014 ${payload.totalEntries || 0} entries`);
        return;
    }

    // --- search results ---
    if (action === "search") {
        piSearchResults = payload.results || [];
        const listEl = document.getElementById("piResultsList");
        if (listEl) {
            if (piSearchResults.length === 0) {
                listEl.innerHTML = '<div class="empty-list">No results found</div>';
            } else {
                listEl.innerHTML = piSearchResults.map(r => piRenderResultItem(r)).join("");
                listEl.querySelectorAll(".pi-result-item").forEach(item => {
                    item.addEventListener("click", () => procIndexGetEntry(item.dataset.id));
                });
            }
        }
        const count = piSearchResults.length;
        addMessageToTab(source, "in", "procIndex",
            `Search \u201C${payload.query || ""}\u201D: ${count} result(s)`);
        setStatus("connected", `${count} result(s) found.`);
        return;
    }

    // --- full entry content ---
    if (action === "get") {
        // The response may nest the entry under payload.entry or inline it.
        const entry = payload.entry || payload;
        const fileContent = payload.fileContent || "";
        openPiEntryModal(entry, fileContent);
        addMessageToTab(source, "in", "procIndex",
            `Entry: ${entry.title || entry.id || "unknown"}`);
        return;
    }

    // --- fallback: log the raw payload ---
    addMessageToTab(source, "in", "procIndex", JSON.stringify(payload, null, 2));
}

/** Open the procIndex entry viewer modal with the given entry and Markdown content. */
function openPiEntryModal(entry, fileContent) {
    const modal = document.getElementById("piEntryModal");
    if (!modal) return;

    const titleEl   = document.getElementById("piEntryTitle");
    const metaEl    = document.getElementById("piEntryMeta");
    const contentEl = document.getElementById("piEntryContent");

    if (titleEl) titleEl.textContent = entry.title || entry.id || "Entry";

    if (metaEl) {
        const kw     = (entry.keywords || []).join(", ") || "\u2014";
        const linked = (entry.linkedIds || []).length;
        const statusClass = entry.status === "indexed" ? "pi-badge-indexed" : "pi-badge-staged";
        metaEl.innerHTML = `
            <div class="pi-entry-badges">
                <span class="pi-badge ${statusClass}">${escapeHtml(entry.status || "unknown")}</span>
                <span class="pi-meta-item">${escapeHtml(entry.fileType || "text")}</span>
                ${linked > 0 ? `<span class="pi-meta-item">${linked} linked idea(s)</span>` : ""}
            </div>
            <div class="pi-meta-keywords">Keywords: ${escapeHtml(kw)}</div>
            ${entry.sourceUrl
                ? `<div class="pi-meta-source">${escapeHtml(entry.sourceUrl)}</div>`
                : ""}
        `;
    }

    if (contentEl) {
        contentEl.textContent = fileContent || "(no content)";
    }

    modal.classList.add("visible");
}

/** Close the procIndex entry viewer modal. */
function closePiEntryModal() {
    const modal = document.getElementById("piEntryModal");
    if (modal) modal.classList.remove("visible");
    const contentEl = document.getElementById("piEntryContent");
    if (contentEl) contentEl.textContent = "";
}
