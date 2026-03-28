/**
 * procMessenger - Node.js WebSocket Server
 *
 * Handles client registration, message routing, and client registry.
 * This file contains ONLY server logic. Runtime/message handling is in handlers.js.
 */

const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");
const handlers = require("./handlers");

// Registry of connected clients
// Key: ws object, Value: client info
const clients = new Map();

// Nickname overrides
const nicknames = new Map();

// Aggregated file list from all clients that advertise file_transfers capability
// Key: clientName, Value: array of file metadata records
const clientFileLists = new Map();

// --- Topics storage (shared project-root folder, same as transfers/) ---
const TOPICS_DIR = path.resolve(__dirname, "../data/topics");
const TOPICS_FILE = path.join(TOPICS_DIR, "index.json");

function ensureTopicsDir() {
    if (!fs.existsSync(TOPICS_DIR)) fs.mkdirSync(TOPICS_DIR, { recursive: true });
}

function loadTopics() {
    ensureTopicsDir();
    if (!fs.existsSync(TOPICS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TOPICS_FILE, "utf8"));
    } catch {
        return [];
    }
}

function saveTopics(topics) {
    ensureTopicsDir();
    fs.writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2), "utf8");
}

function buildMessage(type, source, target, payload, flags = {}) {
    return JSON.stringify({
        id: uuidv4(),
        type,
        source,
        target,
        timestamp: new Date().toISOString(),
        flags,
        payload,
    });
}

function getClientList() {
    const list = [];
    for (const [ws, info] of clients) {
        list.push({
            name: info.name,
            clientType: info.clientType,
            capabilities: info.capabilities,
            hostname: info.hostname || "",
            nickname: nicknames.get(info.name) || info.nickname || "",
            connectedAt: info.connectedAt,
        });
    }
    return list;
}

/**
 * Build the aggregated file list across all clients.
 * Each record is annotated with ownerClient so the mobile app knows who holds the file.
 */
function getAggregatedFileList() {
    // Deduplicate by fileId across all client lists.
    // When two clients announce the same fileId (e.g. both server and python-client
    // read the same metadata.json), keep the entry where the announcing client name
    // matches the record's ownerClient field — that is the authoritative holder.
    const seen = new Map();
    for (const [clientName, files] of clientFileLists) {
        for (const f of files) {
            const owner = f.ownerClient || clientName;
            const entry = { ...f, ownerClient: owner };
            const existing = seen.get(f.fileId);
            if (!existing || clientName === owner) {
                seen.set(f.fileId, entry);
            }
        }
    }
    const all = Array.from(seen.values());
    // Sort newest first
    all.sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || ""));
    return all;
}

function broadcast(message, exclude = null) {
    for (const [ws] of clients) {
        if (ws !== exclude && ws.readyState === 1) {
            ws.send(message);
        }
    }
}

function broadcastClientList() {
    const msg = buildMessage("client_list", "server", "all", {
        clients: getClientList(),
    });
    broadcast(msg);
}

function sendTo(targetName, message) {
    for (const [ws, info] of clients) {
        if (info.name === targetName && ws.readyState === 1) {
            ws.send(message);
            return true;
        }
    }
    return false;
}

function routeMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        const errorMsg = buildMessage("error", "server", "unknown", {
            code: "INVALID_MESSAGE",
            message: "Failed to parse JSON.",
            referenceId: "",
        });
        ws.send(errorMsg);
        return;
    }

    const { type, source, target, payload = {}, flags = {}, id: msgId } = msg;
    console.log(`[MSG] type=${type} source=${source} target=${target}`);

    // Handle registration
    if (type === "register") {
        const name = source || `${payload.clientType || "unknown"}-${uuidv4().slice(0, 8)}`;
        const hostname = payload.hostname || "";
        const clientType = payload.clientType || "unknown";

        // Duplicate check: reject if same hostname + clientType is already connected
        if (hostname) {
            for (const [existingWs, existingInfo] of clients) {
                if (existingInfo.hostname === hostname && existingInfo.clientType === clientType) {
                    const errorMsg = buildMessage("error", "server", name, {
                        code: "DUPLICATE_CLIENT",
                        message: `A '${clientType}' client from host '${hostname}' is already connected. Only one instance per type per machine is allowed.`,
                        referenceId: "",
                    });
                    ws.send(errorMsg);
                    ws.close(4001, "Duplicate client");
                    console.log(`[REGISTER] Rejected duplicate: ${name} (hostname=${hostname}, type=${clientType})`);
                    return;
                }
            }
        }

        const capabilities = payload.capabilities || [];
        clients.set(ws, {
            name,
            clientType,
            capabilities,
            hostname,
            nickname: payload.nickname || "",
            connectedAt: new Date().toISOString(),
        });
        console.log(`[REGISTER] ${name} (hostname=${hostname}, type=${clientType})`);

        // Announce the new client to all others
        const announceMsg = buildMessage("client_announce", "server", "all", {
            action: "joined",
            client: { name, clientType, hostname },
        });
        broadcast(announceMsg, ws);

        // If a file_transfers-capable client registers and provided an inline file list, record it.
        if (capabilities.includes("file_transfers") && Array.isArray(payload.fileList)) {
            clientFileLists.set(name, payload.fileList);
            console.log(`[FILES] ${name} announced ${payload.fileList.length} file(s) on register.`);
        }

        broadcastClientList();
        return;
    }

    // Handle nickname
    if (type === "nickname") {
        const clientName = payload.clientName || "";
        const nickname = payload.nickname || "";
        if (clientName) {
            nicknames.set(clientName, nickname);
            console.log(`[NICKNAME] ${clientName} -> ${nickname}`);
            broadcastClientList();
        }
        return;
    }

    // Handle pong
    if (type === "pong") return;

    // A client is announcing its local file list (sent after registration or after a new file is saved).
    if (type === "file_list_announce") {
        const files = payload.files || [];
        clientFileLists.set(source, files);
        console.log(`[FILES] ${source} updated file list: ${files.length} file(s).`);
        // Broadcast the updated aggregated list to everyone
        const aggMsg = buildMessage("file_list", "server", "all", {
            files: getAggregatedFileList(),
        });
        broadcast(aggMsg);
        return;
    }

    // Mobile requesting the aggregated file list from the server
    if (type === "file_list" && target === "server") {
        const reply = buildMessage("file_list", "server", source, {
            files: getAggregatedFileList(),
        });
        ws.send(reply);
        return;
    }

    // Consolidated "known data" request
    if (type === "server_known_data" && target === "server") {
        const reply = buildMessage("server_known_data", "server", source, {
            files: getAggregatedFileList(),
            topics: loadTopics(),
            // Add other server-derived data here as needed
        });
        ws.send(reply);
        return;
    }

    // Handle new topic creation
    if (type === "topic_create" && target === "server") {
        const topics = loadTopics();
        const newTopic = {
            id: uuidv4(),
            name: payload.name || "Untitled Topic",
            info: payload.info || "",
            createdAt: new Date().toISOString(),
        };
        topics.push(newTopic);
        saveTopics(topics);
        
        // Broadcast updated topics to everyone (or just reply)
        const announceMsg = buildMessage("topics", "server", "all", { topics });
        broadcast(announceMsg);
        return;
    }

    // Handle topic update
    if (type === "topic_update" && target === "server") {
        const topics = loadTopics();
        const idx = topics.findIndex(t => t.id === payload.id);
        if (idx === -1) {
            const errMsg = buildMessage("error", "server", source, {
                code: "TOPIC_NOT_FOUND",
                message: `Topic with id '${payload.id}' not found.`,
            });
            ws.send(errMsg);
            return;
        }
        topics[idx].name = payload.name || topics[idx].name;
        topics[idx].info = payload.info || topics[idx].info;
        topics[idx].updatedAt = new Date().toISOString();
        saveTopics(topics);

        const announceMsg = buildMessage("topics", "server", "all", { topics });
        broadcast(announceMsg);
        return;
    }

    // Two-way topic sync: mobile sends its local list, server merges by newest updatedAt/createdAt
    if (type === "topic_sync" && target === "server") {
        const getTime = t => Date.parse(t.updatedAt || t.createdAt || "") || 0;
        const serverList = loadTopics();
        const clientList = Array.isArray(payload.topics) ? payload.topics : [];
        const merged = new Map();
        serverList.forEach(t => merged.set(t.id, t));
        clientList.forEach(t => {
            if (t.id && (!merged.has(t.id) || getTime(t) > getTime(merged.get(t.id)))) {
                merged.set(t.id, t);
            }
        });
        const mergedList = [...merged.values()];
        saveTopics(mergedList);
        ws.send(buildMessage("topic_sync_result", "server", source, { topics: mergedList }));
        broadcast(buildMessage("topics", "server", "all", { topics: mergedList }), ws);
        return;
    }

    // Mobile requesting a file from a specific owner client.
    // The server acts as a relay - forward to the ownerClient, which will send file_transfer_data
    // chunks back with target = original requester (mobile).
    if (type === "file_fetch" && target === "server") {
        const ownerClient = payload.ownerClient || "";
        if (!ownerClient) {
            const errMsg = buildMessage("error", "server", source, {
                code: "MISSING_OWNER",
                message: "file_fetch requires ownerClient in payload.",
                referenceId: msgId,
            });
            ws.send(errMsg);
            return;
        }

        // If the file is owned by the server, serve it directly without a relay
        if (ownerClient === "server") {
            const result = handlers.readFileAsChunks(payload.fileId);
            if (!result) {
                const errMsg = buildMessage("error", "server", source, {
                    code: "FILE_NOT_FOUND",
                    message: `File '${payload.fileId}' not found on server.`,
                    referenceId: msgId,
                });
                ws.send(errMsg);
                return;
            }
            const { record, chunks } = result;
            for (const c of chunks) {
                const chunkMsg = buildMessage("file_transfer_data", "server", source, {
                    fileId: record.fileId,
                    fileName: record.fileName,
                    fileType: record.fileType,
                    fileSize: record.fileSize,
                    sentAt: record.sentAt || "",
                    source: record.source || "",
                    target: source,
                    chunkIndex: c.chunkIndex,
                    totalChunks: c.totalChunks,
                    data: c.data,
                });
                ws.send(chunkMsg);
            }
            return;
        }

        // Forward the request to the ownerClient, tagging requestedBy so the client knows where to reply
        const forward = buildMessage("file_fetch", "server", ownerClient, {
            ...payload,
            requestedBy: source,
        });
        const delivered = sendTo(ownerClient, forward);
        if (!delivered) {
            const errMsg = buildMessage("error", "server", source, {
                code: "OWNER_NOT_CONNECTED",
                message: `File owner '${ownerClient}' is not connected.`,
                referenceId: msgId,
            });
            ws.send(errMsg);
        }
        return;
    }

    // Mobile uploading a file to be stored directly on the server
    if (type === "file_upload" && target === "server") {
        const result = handlers.receiveFileChunk({ ...payload, source, target: "server" });
        if (result.done) {
            const rec = result.record;
            // Register the server's own file list so it appears in the aggregate
            clientFileLists.set("server", handlers.getFileList());
            // Broadcast updated aggregate file list to all clients
            const aggMsg = buildMessage("file_list", "server", "all", {
                files: getAggregatedFileList(),
            });
            broadcast(aggMsg);
            // Confirm the upload to the sender
            const reply = buildMessage("file_receive_complete", "server", source, {
                fileId: rec.fileId,
                fileName: rec.fileName,
                fileSize: rec.fileSize,
                fileType: rec.fileType,
                source,
                target: "server",
                sentAt: rec.sentAt,
            });
            ws.send(reply);
        }
        return;
    }

    // Handle file_delete: serve server-owned files inline; relay others to ownerClient.
    if (type === "file_delete" && target === "server") {
        const ownerClient = payload.ownerClient || "";
        if (!ownerClient) {
            ws.send(buildMessage("error", "server", source, {
                code: "MISSING_OWNER", message: "file_delete requires ownerClient in payload."
            }));
            return;
        }
        if (ownerClient === "server") {
            const result = handlers.deleteFile(payload.fileId || "");
            if (result.deleted) {
                clientFileLists.set("server", handlers.getFileList());
                broadcast(buildMessage("file_list", "server", "all", { files: getAggregatedFileList() }));
            }
            ws.send(buildMessage("file_delete_complete", "server", source, result));
            return;
        }
        const forward = buildMessage("file_delete", "server", ownerClient, { ...payload, requestedBy: source });
        const delivered = sendTo(ownerClient, forward);
        if (!delivered) {
            ws.send(buildMessage("error", "server", source, {
                code: "OWNER_NOT_CONNECTED",
                message: `File owner '${ownerClient}' is not connected.`,
            }));
        }
        return;
    }

    // Handle ack flag
    if (flags.ack) {
        const ackMsg = buildMessage("ack", "server", source, {
            referenceId: msgId,
            status: target !== "all" ? "delivered" : "broadcast",
        });
        ws.send(ackMsg);
    }

    // Route to target
    if (target === "all" || flags.broadcast) {
        broadcast(raw, ws);
    } else {
        const delivered = sendTo(target, raw);
        if (!delivered) {
            const errorMsg = buildMessage("error", "server", source, {
                code: "TARGET_NOT_FOUND",
                message: `Client '${target}' is not connected.`,
                referenceId: msgId,
            });
            ws.send(errorMsg);
        }
    }
}

/**
 * Detect the machine's Tailscale IP (100.64.0.0/10) via the CLI.
 * Calls the callback with the IP string, or null if Tailscale is not running.
 */
function getTailscaleIp(callback) {
    const isWin = process.platform === "win32";
    const cli = isWin ? "tailscale.exe" : "tailscale";
    execFile(cli, ["ip", "--4"], { timeout: 3000 }, (err, stdout) => {
        if (!err) {
            const ip = stdout.trim();
            // Validate it's in the 100.64.0.0/10 range (second octet 64–127)
            const parts = ip.split(".");
            if (parts[0] === "100" && parseInt(parts[1], 10) >= 64 && parseInt(parts[1], 10) <= 127) {
                return callback(ip);
            }
        }
        callback(null);
    });
}

function startServer() {
    const wss = new WebSocketServer({ host: config.HOST, port: config.PORT });

    wss.on("listening", () => {
        console.log(`[SERVER] procMessenger server running on ws://${config.HOST}:${config.PORT}`);
        console.log("[SERVER] Available connection addresses:");
        console.log(`[SERVER]   Local:     ws://127.0.0.1:${config.PORT}`);
        getTailscaleIp((tsIp) => {
            if (tsIp) {
                console.log(`[SERVER]   Tailscale: ws://${tsIp}:${config.PORT}  <- use this address on remote/mobile clients`);
            } else {
                console.log("[SERVER]   Tailscale: not running - mobile clients must use the LAN IP instead");
            }
        });
    });

    wss.on("connection", (ws) => {
        console.log("[SERVER] New connection");

        ws.on("message", (data) => {
            routeMessage(ws, data.toString());
        });

        ws.on("close", (code) => {
            const info = clients.get(ws);
            const name = info ? info.name : "unknown";

            // Announce departure before removing from registry
            if (info) {
                const announceMsg = buildMessage("client_announce", "server", "all", {
                    action: "left",
                    client: { name: info.name, clientType: info.clientType, hostname: info.hostname || "" },
                });
                broadcast(announceMsg);
            }

            clients.delete(ws);
            // Remove the file list for this client so the aggregate stays accurate
            if (name !== "unknown") clientFileLists.delete(name);
            console.log(`[DISCONNECT] ${name} (code=${code})`);
            broadcastClientList();

            // Broadcast updated aggregate file list
            const aggMsg = buildMessage("file_list", "server", "all", {
                files: getAggregatedFileList(),
            });
            broadcast(aggMsg);
        });

        ws.on("error", (err) => {
            console.error("[WS_ERROR]", err.message);
        });
    });

    // Ping keepalive
    setInterval(() => {
        const pingMsg = buildMessage("ping", "server", "all", {});
        for (const [ws] of clients) {
            if (ws.readyState === 1) {
                ws.send(pingMsg);
            }
        }
    }, config.PING_INTERVAL);

    return wss;
}

// Export for use by client.js
module.exports = { startServer, buildMessage };

// Run directly
if (require.main === module) {
    startServer();
}
