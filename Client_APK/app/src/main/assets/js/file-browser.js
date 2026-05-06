/**
 * procMessenger Mobile - File Browser
 *
 * File listing, upload, download, view, edit, and deletion via the
 * server's shared transfers directory.
 */

/** Ask the server for its aggregated file list. */
function fbRequestList() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    wsManager.send("file_list", "server", {});
    setStatus("connected", "Requesting file list...");
}

/** Render the file browser into the dedicated Files tab panel. */
function renderFilesTab() {
    const container = document.getElementById("filesTabContent");
    if (!container) return;
    renderFileBrowserPanel(container);
}

/** Render the file browser panel into the given container element. */
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
    if (activeMainTab === "files") {
        renderFilesTab();
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
    if (activeMainTab === "files") {
        renderFilesTab();
    }

    if (tracker.received < totalChunks) return;

    // All chunks received - decode each chunk from base64 to binary individually,
    // then concatenate the byte arrays.  Simply stripping '=' and joining base64
    // strings is incorrect when chunks are not exact multiples of 3 bytes, which
    // causes data corruption for multi-chunk binary files (e.g. APKs).
    const binaryParts = [];
    let totalBytes = 0;
    for (let i = 0; i < totalChunks; i++) {
        const chunkB64 = tracker.chunks[i] || "";
        const binaryStr = atob(chunkB64);
        const arr = new Uint8Array(binaryStr.length);
        for (let j = 0; j < binaryStr.length; j++) arr[j] = binaryStr.charCodeAt(j);
        binaryParts.push(arr);
        totalBytes += arr.length;
    }
    const combined = new Uint8Array(totalBytes);
    let byteOffset = 0;
    for (const part of binaryParts) { combined.set(part, byteOffset); byteOffset += part.length; }

    // Re-encode the concatenated bytes as a single base64 string.
    // Process in 32 KB slices to avoid call-stack overflows on large files.
    let rawBinary = "";
    const SLICE = 0x8000;
    for (let i = 0; i < combined.length; i += SLICE) {
        rawBinary += String.fromCharCode.apply(null, combined.subarray(i, i + SLICE));
    }
    const fullBase64 = btoa(rawBinary);
    const meta = tracker.meta || {};

    delete fbInFlight[fileId];

    if (tracker.mode === "download") {
        fbDownloadFile(fullBase64, meta.fileName || "download", meta.fileType || "application/octet-stream");
    } else if (tracker.mode === "edit") {
        try {
            const text = new TextDecoder().decode(combined);
            fbOpenNewFileModal(meta.fileName || "file.txt", text, fileId);
        } catch (e) {
            setStatus("error", "Could not decode file for editing: " + e.message);
        }
    } else {
        fbViewFile(fullBase64, meta.fileName || "file", meta.fileType || "application/octet-stream");
    }

    // Refresh panel (remove progress indicator)
    if (activeMainTab === "files") {
        renderFilesTab();
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
    if (activeMainTab === "files") {
        renderFilesTab();
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
