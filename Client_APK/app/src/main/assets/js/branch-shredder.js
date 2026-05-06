/**
 * procMessenger Mobile - branchShredder
 *
 * branchShredder panel rendering, graph/scene commands, and viewport
 * interaction (pan, zoom, tap, snapshot).
 */

// --- branchShredder Panel ---

function renderBranchShredderPanel(panel) {
    const viewportTarget = bsGetViewportTarget();
    const hasViewport = viewportTarget !== null;

    const recentOpts = bsRecentScenes.length > 0
        ? bsRecentScenes.map(s => `<option value="${escapeHtml(s.path)}">${escapeHtml(s.name || s.path)}</option>`).join("")
        : '<option value="">-- request recent scenes first --</option>';

    const nodeOpts = bsNodeIndex.length > 0
        ? bsNodeIndex.map(n => `<option value="${escapeHtml(n.id)}">[${escapeHtml(n.type)}] ${escapeHtml(n.name)}</option>`).join("")
        : '<option value="">-- find nodes first --</option>';

    const viewportSection = hasViewport ? `
        <div class="bs-viewport-toolbar">
            <button id="bsBtnViewportRefresh" class="btn-secondary btn-sm">&#x21BB; Refresh</button>
            <span class="bs-viewport-hint">Drag to pan &bull; Pinch to zoom</span>
        </div>
        <div id="bsViewportFrame" class="bs-viewport-frame">
            ${bsViewportImage
                ? `<img id="bsViewportImg" class="bs-viewport-img" src="data:image/png;base64,${bsViewportImage}" alt="Viewport" />
                   <div id="bsViewportLoadingOverlay" class="bs-viewport-loading-overlay" style="display:none">Loading...</div>`
                : `<div class="bs-viewport-placeholder">Tap Refresh to load viewport</div>
                   <div id="bsViewportLoadingOverlay" class="bs-viewport-loading-overlay" style="display:${bsViewportLoading ? "" : "none"}">Loading...</div>`
            }
        </div>
        <div id="bsViewportStateBar" class="bs-viewport-state-bar">${bsFormatViewportState(bsViewportState)}</div>
    ` : `
        <div class="bs-viewport-unavailable">No viewport-capable target selected.<br><small>Select a branchShredder target above.</small></div>
    `;

    panel.innerHTML = `
        <div class="bs-panel">

            <div class="bs-section-title">Viewport</div>
            ${viewportSection}

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

            <div class="bs-section-label">Update Node</div>
            <div class="bs-sub-form">
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
                <span class="bs-cmd-label">File Options</span>
                <button id="bsBtnToggleFileOptions" class="btn-secondary btn-sm">&#9660; Show</button>
            </div>
            <div id="bsFileOptionsForm" class="bs-sub-form" style="display:none">
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
            </div>
            <div class="bs-save-row">
                <input type="text" id="bsSaveFilename" class="full-width" placeholder="Save filename (optional)" />
                <button id="bsBtnSaveScene" class="btn-primary full-width">Save Scene</button>
            </div>

            <div class="bs-section-title">Free-form Message</div>
            <textarea id="storyMessage" class="full-width" rows="3" placeholder="Direct message to the story editor..."></textarea>

        </div>
    `;

    document.getElementById("bsBtnQueryNodes").addEventListener("click", bsSendQueryNodes);
    document.getElementById("bsBtnFindNodes").addEventListener("click", bsSendFindNodes);
    document.getElementById("bsBtnGetNode").addEventListener("click", bsSendGetNode);
    document.getElementById("bsBtnSendUpdate").addEventListener("click", bsSendUpdateNode);
    document.getElementById("bsBtnToggleFileOptions").addEventListener("click", bsToggleFileOptions);
    document.getElementById("bsBtnSystemPrompt").addEventListener("click", bsSendSystemPrompt);
    document.getElementById("bsBtnRecentScenes").addEventListener("click", () => bsSendSystem("recent_scenes"));
    document.getElementById("bsBtnOpenRecent").addEventListener("click", bsSendOpenRecent);
    document.getElementById("bsBtnNewScene").addEventListener("click", () => bsSendSystem("new_scene"));
    document.getElementById("bsBtnSaveScene").addEventListener("click", bsSendSaveScene);

    if (hasViewport) {
        document.getElementById("bsBtnViewportRefresh").addEventListener("click", bsSendViewportRefresh);
        bsAttachViewportGestures(document.getElementById("bsViewportFrame"));
    }
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

function bsToggleFileOptions() {
    const form = document.getElementById("bsFileOptionsForm");
    const btn  = document.getElementById("bsBtnToggleFileOptions");
    if (!form) return;
    const open = form.style.display !== "none";
    form.style.display = open ? "none" : "";
    btn.textContent = open ? "\u25bc Show" : "\u25b2 Hide";
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

// --- branchShredder: Viewport ---

/**
 * Return the name of the first selected target that advertises viewport capability,
 * or null if none of the selected targets support it.
 */
function bsGetViewportTarget() {
    const targets = getSelectedTargets();
    for (const targetName of targets) {
        const client = connectedClients.find(c => c.name === targetName);
        if (client && Array.isArray(client.capabilities) && client.capabilities.includes("viewport")) {
            return targetName;
        }
    }
    return null;
}

/** Send a viewport_snapshot request to refresh the full viewport image. */
function bsSendViewportRefresh() {
    const target = bsGetViewportTarget();
    if (!target) { setStatus("error", "No viewport-capable target selected."); return; }
    if (!wsManager || !wsManager.connected) { setStatus("error", "Not connected."); return; }
    bsViewportLoading = true;
    bsUpdateViewportLoading(true);
    wsManager.send("viewport_snapshot", target, {});
    addMessageToTab(target, "out", "viewport_snapshot", "Requesting viewport snapshot");
    setStatus("connected", "Requested viewport snapshot.");
}

/**
 * Send a viewport pipeline command (pan, zoom, or combined) followed by a Render.
 * @param {Array} commands  Array of command objects per the branchShredder protocol.
 */
function bsSendViewportCommand(commands) {
    const target = bsGetViewportTarget();
    if (!target || !wsManager || !wsManager.connected) return;
    bsViewportLoading = true;
    bsUpdateViewportLoading(true);
    wsManager.send("viewport", target, { commands });
}

/** Show or hide the loading overlay on the viewport frame. */
function bsUpdateViewportLoading(loading) {
    bsViewportLoading = loading;
    const overlay = document.getElementById("bsViewportLoadingOverlay");
    if (overlay) overlay.style.display = loading ? "" : "none";
}

/**
 * Render a base64 PNG image into the viewport frame.
 * Updates in-place when the <img> already exists, otherwise replaces the placeholder.
 * Re-attaches gesture handlers if the frame was rebuilt.
 * Called from viewport, viewport_snapshot, and viewport_tap handlers.
 */
function bsRenderViewportImage(image) {
    if (!image) return;
    bsViewportImage = image;
    const frame = document.getElementById("bsViewportFrame");
    if (frame) {
        const existingImg = document.getElementById("bsViewportImg");
        if (existingImg) {
            existingImg.src = "data:image/png;base64," + image;
        } else {
            frame.innerHTML = `<img id="bsViewportImg" class="bs-viewport-img" src="data:image/png;base64,${image}" alt="Viewport" />
                               <div id="bsViewportLoadingOverlay" class="bs-viewport-loading-overlay" style="display:none">Loading...</div>`;
            bsAttachViewportGestures(frame);
        }
    } else if (document.getElementById("functionSelect").value === "edit_story") {
        // Panel is visible but frame doesn't exist yet; re-render to show image
        renderBranchShredderPanel(document.getElementById("dynamicPanel"));
    }
}

/** Format a viewportState object into a short display string. */
function bsFormatViewportState(state) {
    if (!state) return "Position unknown";
    const x    = typeof state.x    === "number" ? state.x.toFixed(1)    : "?";
    const y    = typeof state.y    === "number" ? state.y.toFixed(1)    : "?";
    const zoom = typeof state.zoom === "number" ? state.zoom.toFixed(2) : "?";
    return `x\u202F${x}\u2003y\u202F${y}\u2003zoom\u202F${zoom}\u00D7`;
}

/** Update the viewport state bar in-place without re-rendering the full panel. */
function bsUpdateViewportStateBar(state) {
    bsViewportState = state || null;
    const bar = document.getElementById("bsViewportStateBar");
    if (bar) bar.textContent = bsFormatViewportState(bsViewportState);
}

/**
 * Attach touch gesture handlers to the viewport frame element.
 * - Single-finger drag  → pan (Move command + Render)
 * - Two-finger pinch    → zoom (zoom command + Render)
 */
function bsAttachViewportGestures(el) {
    if (!el) return;

    let dragStart = null;           // { x, y } of first touch in clientX/Y space
    let pinchStartDist = null;      // Initial pinch distance
    let pinchLastDist = null;       // Most recent pinch distance during move
    const DRAG_THRESHOLD = 10;      // px delta below which a touch-end is a tap, not a drag

    function getTouchDist(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    el.addEventListener("touchstart", (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
            dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            pinchStartDist = null;
            pinchLastDist = null;
        } else if (e.touches.length === 2) {
            dragStart = null;
            pinchStartDist = getTouchDist(e.touches);
            pinchLastDist = pinchStartDist;
        }
    }, { passive: false });

    el.addEventListener("touchmove", (e) => {
        e.preventDefault();
        if (e.touches.length === 2 && pinchStartDist !== null) {
            pinchLastDist = getTouchDist(e.touches);
        }
    }, { passive: false });

    el.addEventListener("touchend", (e) => {
        e.preventDefault();

        // Pinch gesture ended (one or both fingers lifted)
        if (pinchStartDist !== null && pinchLastDist !== null && e.touches.length < 2) {
            const zoomFactor = pinchLastDist / pinchStartDist;
            // Only send if zoom changed by more than 5%
            if (Math.abs(zoomFactor - 1) > 0.05) {
                bsSendViewportCommand([
                    { "zoom": parseFloat(zoomFactor.toFixed(3)) },
                    { "viewport": "Render", "output": "WebSocket" }
                ]);
            }
            pinchStartDist = null;
            pinchLastDist = null;
            dragStart = null;
            return;
        }

        // Single-finger touch ended — decide tap vs. drag
        if (dragStart !== null && e.changedTouches.length >= 1) {
            const touch = e.changedTouches[0];
            const dx = touch.clientX - dragStart.x;
            const dy = touch.clientY - dragStart.y;
            if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
                // --- Drag: pan the viewport ---
                // Negate the deltas: dragging finger right should scroll content right
                // (i.e. viewport moves left), which requires a negative scene offset.
                // Scale screen pixels → scene units using the known zoom level.
                const zoom = (bsViewportState && typeof bsViewportState.zoom === "number" && bsViewportState.zoom > 0)
                    ? bsViewportState.zoom : 1;
                const sceneDx = Math.round(-dx / zoom);
                const sceneDy = Math.round(-dy / zoom);
                bsSendViewportCommand([
                    { "Move": [sceneDx, sceneDy] },
                    { "viewport": "Render", "output": "WebSocket" }
                ]);
            } else {
                // --- Tap: hit-test the scene at the touch-start position ---
                bsSendViewportTap(el, dragStart.x, dragStart.y);
            }
            dragStart = null;
        }
    }, { passive: false });
}

/**
 * Send a viewport_tap for a touch that landed at clientX/clientY inside `el`.
 * Scales displayed-image coordinates to native image pixel space using
 * viewportState.pixelWidth / pixelHeight so branchShredder can do an exact hit-test.
 */
function bsSendViewportTap(el, clientX, clientY) {
    const target = bsGetViewportTarget();
    if (!target || !wsManager || !wsManager.connected) return;

    const rect = el.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    const displayedWidth  = rect.width;
    const displayedHeight = rect.height;

    // Prefer the native pixel dimensions reported by branchShredder.
    // Fall back to the displayed size when not yet known (1:1 mapping).
    const nativeWidth  = (bsViewportState && typeof bsViewportState.pixelWidth  === "number" && bsViewportState.pixelWidth  > 0) ? bsViewportState.pixelWidth  : displayedWidth;
    const nativeHeight = (bsViewportState && typeof bsViewportState.pixelHeight === "number" && bsViewportState.pixelHeight > 0) ? bsViewportState.pixelHeight : displayedHeight;

    const nativeX = Math.round(relX * (nativeWidth  / displayedWidth));
    const nativeY = Math.round(relY * (nativeHeight / displayedHeight));

    wsManager.send("viewport_tap", target, {
        x:           nativeX,
        y:           nativeY,
        imageWidth:  nativeWidth,
        imageHeight: nativeHeight,
    });
    addMessageToTab(target, "out", "viewport_tap", `Tap at image (${nativeX}, ${nativeY})`);
}
