/**
 * procMessenger — Node.js Message Handlers
 *
 * Runtime functionality for handling incoming messages.
 * Imported by client.js to process messages received from the server.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");

// ---------------------------------------------------------------------------
// File Transfer Helpers
// ---------------------------------------------------------------------------

const TRANSFERS_DIR = config.TRANSFERS_DIR;
const META_FILE = path.join(TRANSFERS_DIR, "metadata.json");

/** Ensure the transfers directory exists. */
function ensureTransfersDir() {
    if (!fs.existsSync(TRANSFERS_DIR)) {
        fs.mkdirSync(TRANSFERS_DIR, { recursive: true });
    }
}

/** Load the metadata registry (array of attachment records). */
function loadMeta() {
    ensureTransfersDir();
    if (!fs.existsSync(META_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    } catch {
        return [];
    }
}

/** Persist the metadata registry. */
function saveMeta(records) {
    ensureTransfersDir();
    fs.writeFileSync(META_FILE, JSON.stringify(records, null, 2), "utf8");
}

/** Add or update a metadata record. Returns the updated record. */
function upsertMeta(record) {
    const records = loadMeta();
    const idx = records.findIndex((r) => r.fileId === record.fileId);
    if (idx >= 0) {
        records[idx] = { ...records[idx], ...record };
    } else {
        records.push(record);
    }
    saveMeta(records);
    return record;
}

/** Return all metadata records, newest first. */
function getFileList() {
    const records = loadMeta();
    // Sort by sentAt descending
    return records.slice().sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || ""));
}

/**
 * Save an incoming file chunk.  Re-assembles once all chunks are received.
 * Returns { done: false } while still receiving, or { done: true, record } when complete.
 */
function receiveFileChunk(payload) {
    ensureTransfersDir();

    const {
        fileId, fileName, fileType, fileSize,
        chunkIndex, totalChunks, data,
        source, target, sentAt,
    } = payload;

    // Security: sanitise filename — strip directory components
    const safeName = path.basename(fileName).replace(/[^\w.\- ]/g, "_");

    // Chunk temp directory
    const chunkDir = path.join(TRANSFERS_DIR, `.chunks_${fileId}`);
    if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

    // Write this chunk (base64 → binary)
    const chunkBuffer = Buffer.from(data, "base64");
    fs.writeFileSync(path.join(chunkDir, String(chunkIndex).padStart(8, "0")), chunkBuffer);

    // Check if all chunks present
    const written = fs.readdirSync(chunkDir).length;
    if (written < totalChunks) {
        return { done: false };
    }

    // Reassemble in order
    const destPath = path.join(TRANSFERS_DIR, `${fileId}_${safeName}`);
    const chunkFiles = fs.readdirSync(chunkDir).sort();
    const chunks = chunkFiles.map((cf) => fs.readFileSync(path.join(chunkDir, cf)));
    fs.writeFileSync(destPath, Buffer.concat(chunks));

    // Cleanup chunks
    for (const cf of chunkFiles) fs.unlinkSync(path.join(chunkDir, cf));
    fs.rmdirSync(chunkDir);

    // Persist metadata
    const record = upsertMeta({
        fileId,
        fileName: safeName,
        fileType: fileType || "application/octet-stream",
        fileSize: fileSize || 0,
        storedPath: destPath,
        source: source || "unknown",
        target: target || "unknown",
        sentAt: sentAt || new Date().toISOString(),
        storedAt: new Date().toISOString(),
        storedBy: config.CLIENT_NAME,
    });

    return { done: true, record };
}

/**
 * Read a stored file and return it as base64 chunks.
 * Returns array of { chunkIndex, totalChunks, data } objects.
 */
function readFileAsChunks(fileId, chunkSize = 512 * 1024) {
    const records = loadMeta();
    const record = records.find((r) => r.fileId === fileId);
    if (!record) return null;

    const storedPath = record.storedPath;
    if (!fs.existsSync(storedPath)) return null;

    // Security: ensure path is within TRANSFERS_DIR
    const realTransfers = fs.realpathSync(TRANSFERS_DIR);
    let realStored;
    try { realStored = fs.realpathSync(storedPath); } catch { return null; }
    if (!realStored.startsWith(realTransfers + path.sep) && realStored !== realTransfers) return null;

    const fileBuffer = fs.readFileSync(storedPath);
    const totalChunks = Math.ceil(fileBuffer.length / chunkSize);
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
        chunks.push({
            chunkIndex: i,
            totalChunks,
            data: fileBuffer.slice(i * chunkSize, (i + 1) * chunkSize).toString("base64"),
        });
    }
    return { record, chunks };
}

/**
 * Get list of available scripts in the scripts directory.
 */
function getAvailableScripts() {
    const scriptsDir = path.resolve(config.SCRIPTS_DIR);
    if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
        return [];
    }

    return fs.readdirSync(scriptsDir)
        .filter((f) => fs.statSync(path.join(scriptsDir, f)).isFile())
        .map((f) => ({
            name: f,
            description: `Script: ${f}`,
        }));
}

/**
 * Execute a script by name from the scripts directory.
 * Returns a promise resolving to { exitCode, stdout, stderr }.
 */
function executeScript(scriptName, args = []) {
    return new Promise((resolve) => {
        const scriptsDir = path.resolve(config.SCRIPTS_DIR);
        const scriptPath = path.join(scriptsDir, scriptName);

        // Security: prevent path traversal
        const realScriptsDir = fs.realpathSync(scriptsDir);
        let realScriptPath;
        try {
            realScriptPath = fs.realpathSync(scriptPath);
        } catch {
            resolve({ exitCode: -1, stdout: "", stderr: `Script not found: ${scriptName}` });
            return;
        }

        if (!realScriptPath.startsWith(realScriptsDir + path.sep)) {
            resolve({ exitCode: -1, stdout: "", stderr: "Security error: path traversal detected." });
            return;
        }

        const stringArgs = args.map(String);

        execFile(realScriptPath, stringArgs, { cwd: realScriptsDir, timeout: 120000 }, (error, stdout, stderr) => {
            if (error && error.killed) {
                resolve({ exitCode: -1, stdout: "", stderr: "Script execution timed out (120s limit)." });
            } else {
                resolve({
                    exitCode: error ? error.code || -1 : 0,
                    stdout: stdout || "",
                    stderr: stderr || "",
                });
            }
        });
    });
}

/**
 * Handle a run_script message.
 */
async function handleRunScript(payload) {
    const action = payload.action || "";

    if (action === "list_scripts") {
        return { action: "script_list", scripts: getAvailableScripts() };
    }

    if (action === "execute") {
        const scriptName = payload.scriptName || "";
        const args = payload.args || [];
        if (!scriptName) {
            return { action: "result", scriptName: "", exitCode: -1, stdout: "", stderr: "No scriptName provided." };
        }
        const result = await executeScript(scriptName, args);
        return { action: "result", scriptName, ...result };
    }

    return { action: "error", message: `Unknown run_script action: ${action}` };
}

/**
 * Handle a gather_research message.
 * Placeholder — requires Puppeteer + Search API + local LLM integration.
 */
async function handleGatherResearch(payload) {
    const query = payload.query || "";
    console.log(`[RESEARCH] Query: ${query}`);

    // Placeholder response
    return {
        status: "unsupported",
        message: "Gather Research is not yet fully implemented. Requires Puppeteer + Search API + LLM setup.",
        query,
    };
}

/**
 * Handle an edit_story message.
 */
function handleEditStory(payload) {
    const message = payload.message || "";
    console.log(`[STORY] ${message}`);

    return {
        message: `[Story Editor] Received: ${message}`,
        status: "received",
    };
}

/**
 * Handle file_list request — return the aggregated metadata for files stored here.
 */
function handleFileList() {
    return { files: getFileList() };
}

/**
 * Handle an incoming file chunk.  Returns a progress or complete response.
 */
function handleFileReceive(payload) {
    const result = receiveFileChunk(payload);
    if (!result.done) {
        return {
            type: "file_receive_progress",
            payload: { fileId: payload.fileId, chunkIndex: payload.chunkIndex, totalChunks: payload.totalChunks },
        };
    }
    console.log(`[TRANSFER] Saved: ${result.record.fileId} — ${result.record.fileName}`);
    return {
        type: "file_receive_complete",
        payload: {
            fileId: result.record.fileId,
            fileName: result.record.fileName,
            fileSize: result.record.fileSize,
            fileType: result.record.fileType,
            source: result.record.source,
            target: result.record.target,
            sentAt: result.record.sentAt,
        },
    };
}

/**
 * Handle a file_fetch request — send the file back in chunks.
 * Returns an array of messages to send.
 */
function handleFileFetch(payload) {
    const { fileId } = payload;
    if (!fileId) return [{ type: "error", payload: { code: "MISSING_FILE_ID", message: "fileId required." } }];

    const result = readFileAsChunks(fileId);
    if (!result) return [{ type: "error", payload: { code: "FILE_NOT_FOUND", message: `File ${fileId} not found.` } }];

    const { record, chunks } = result;
    return chunks.map((c) => ({
        type: "file_transfer_data",
        payload: {
            fileId: record.fileId,
            fileName: record.fileName,
            fileType: record.fileType,
            fileSize: record.fileSize,
            sentAt: record.sentAt,
            source: record.source,
            target: record.target,
            chunkIndex: c.chunkIndex,
            totalChunks: c.totalChunks,
            data: c.data,
        },
    }));
}

/**
 * Main dispatcher — routes a parsed message to the appropriate handler.
 * Returns [responseType, responsePayload] or [null, null].
 * For file_fetch, returns an array of [type, payload] pairs.
 */
async function handleMessage(msg) {
    const type = msg.type || "";
    const payload = msg.payload || {};

    if (type === "run_script") {
        return ["run_script", await handleRunScript(payload)];
    }

    if (type === "gather_research") {
        return ["gather_research", await handleGatherResearch(payload)];
    }

    if (type === "edit_story") {
        return ["edit_story", handleEditStory(payload)];
    }

    if (type === "file_list") {
        return ["file_list", handleFileList()];
    }

    if (type === "file_receive") {
        const result = handleFileReceive(payload);
        return [result.type, result.payload];
    }

    if (type === "file_fetch") {
        // Returns multiple messages — caller checks for array
        return ["__multi__", handleFileFetch(payload)];
    }

    return [null, null];
}

module.exports = {
    handleMessage,
    getAvailableScripts,
    executeScript,
    getFileList,
    upsertMeta,
    loadMeta,
};
