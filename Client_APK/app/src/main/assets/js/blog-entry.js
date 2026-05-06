/**
 * procMessenger Mobile - Blog Entry
 *
 * Blog entry creation and submission to the blog-client target.
 */

/**
 * Inline-insert button map.
 * Add a new entry here to expose a new quick-insert button above the body textarea.
 * { label, insert } — insert is the literal string placed at the cursor.
 */
const BLOG_INSERT_BUTTONS = [
    { label: "br",   insert: "<br>" },
    { label: "nbsp", insert: "&nbsp;" },
    { label: "line", insert: "<br><br><br><div class='procPagesAIDevBar'></div>" },
];

/** Insert a string at the current cursor position inside a textarea. */
function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end   = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after  = textarea.value.slice(end);
    textarea.value = before + text + after;
    const pos = start + text.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd   = pos;
    textarea.focus();
}

/** Render the Blog Entry panel inside the dynamic panel container. */
function renderBlogEntryPanel(panel) {
    const draft = blogEntryDraft || {};
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const insertBtns = BLOG_INSERT_BUTTONS
        .map(b => `<button class="btn-blog-insert" data-insert="${escapeHtml(b.insert)}">${escapeHtml(b.label)}</button>`)
        .join("");

    panel.innerHTML = `
        <div class="blog-entry-panel">
            <label>Name <small>(title of the entry)</small>:</label>
            <input type="text" id="blogEntryName" class="full-width"
                   placeholder="Entry title..." value="${escapeHtml(draft.name || "")}" />

            <label>Keywords <small>(comma-separated tags)</small>:</label>
            <input type="text" id="blogEntryKeywords" class="full-width"
                   placeholder="theory, keyword, another tag" value="${escapeHtml(draft.keywords || "")}" />

            <label>Date <small>(YYYY-MM-DD)</small>:</label>
            <input type="text" id="blogEntryDate" class="full-width"
                   placeholder="${today}" value="${escapeHtml(draft.date || today)}" />

            <div class="blog-insert-bar">${insertBtns}</div>

            <label>Body <small>(HTML-formatted content)</small>:</label>
            <textarea id="blogEntryBody" class="blog-body-textarea" rows="14"
                      placeholder="Entry body...">${escapeHtml(draft.body || "")}</textarea>

            <div class="blog-entry-actions">
                <button id="blogBtnSave" class="btn-primary">Save Entry</button>
                <button id="blogBtnVerify" class="btn-secondary">Verify</button>
                <button id="blogBtnClear" class="btn-secondary">Clear</button>
            </div>
            <div id="blogEntryStatus" class="blog-entry-status"></div>
        </div>
    `;

    // Insert buttons
    panel.querySelectorAll(".btn-blog-insert").forEach(btn => {
        btn.addEventListener("click", () => {
            const textarea = document.getElementById("blogEntryBody");
            if (textarea) insertAtCursor(textarea, btn.dataset.insert);
        });
    });

    document.getElementById("blogBtnSave").addEventListener("click", () => handleBlogEntrySend("save"));
    document.getElementById("blogBtnVerify").addEventListener("click", () => handleBlogEntrySend("verify"));
    document.getElementById("blogBtnClear").addEventListener("click", blogEntryClear);
}

/** Collect field values, stash them in the draft, and send to the blog-client target. */
function handleBlogEntrySend(action) {
    action = action || "save";

    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }

    const name     = document.getElementById("blogEntryName")?.value.trim()     || "";
    const keywords = document.getElementById("blogEntryKeywords")?.value.trim() || "";
    const date     = document.getElementById("blogEntryDate")?.value.trim()      || "";
    const body     = document.getElementById("blogEntryBody")?.value             || "";

    if (action === "save" && (!name || !date)) {
        setStatus("error", "Name and Date are required to save a blog entry.");
        return;
    }

    // Persist draft locally so fields survive a panel re-render
    blogEntryDraft = { name, keywords, date, body };

    const tags = keywords
        ? keywords.split(",").map(t => t.trim()).filter(Boolean)
        : [];

    const payload = { action, name, tags, date, body };

    wsManager.send("blog_entry", "blog-client", payload);
    addMessageToTab("blog-client", "out", "blog_entry",
        `${action === "verify" ? "Verify" : "Save"} blog entry: "${name}" (${date})`);
    setStatus("connected", `Blog entry ${action} sent to blog-client.`);
}

/** Clear the blog entry draft and re-render the panel. */
function blogEntryClear() {
    blogEntryDraft = null;
    if (document.getElementById("functionSelect").value === "blog_entry") {
        renderBlogEntryPanel(document.getElementById("dynamicPanel"));
    }
}

/** Handle an incoming blog_entry response from the blog-client. */
function handleBlogEntryResponse(payload) {
    const status = payload.status || "";
    const statusEl = document.getElementById("blogEntryStatus");

    if (status === "saved") {
        const msg = `Saved: ${payload.filePath || "unknown path"}`;
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.className = "blog-entry-status success";
        }
        setStatus("connected", `Blog entry saved: ${payload.filePath || ""}`);
        addMessageToTab("blog-client", "in", "blog_entry", msg);
    } else if (status === "verified") {
        const msg = payload.valid
            ? `Structure OK — ${payload.filePath || ""}`
            : `Verify failed: ${payload.error || "unknown error"}`;
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.className = "blog-entry-status" + (payload.valid ? " success" : " error");
        }
        setStatus(payload.valid ? "connected" : "error", msg);
        addMessageToTab("blog-client", "in", "blog_entry", msg);
    } else if (status === "error") {
        const msg = `Error: ${payload.message || "unknown error"}`;
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.className = "blog-entry-status error";
        }
        setStatus("error", msg);
        addMessageToTab("blog-client", "in", "blog_entry", msg);
    } else {
        const msg = payload.message || JSON.stringify(payload, null, 2);
        addMessageToTab("blog-client", "in", "blog_entry", msg);
    }
}
