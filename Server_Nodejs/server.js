/**
 * procMessenger — Node.js WebSocket Server
 *
 * Handles client registration, message routing, and client registry.
 * This file contains ONLY server logic. Runtime/message handling is in handlers.js.
 */

const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const config = require("./config");

// Registry of connected clients
// Key: ws object, Value: client info
const clients = new Map();

// Nickname overrides
const nicknames = new Map();

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

        clients.set(ws, {
            name,
            clientType,
            capabilities: payload.capabilities || [],
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

function startServer() {
    const wss = new WebSocketServer({ host: config.HOST, port: config.PORT });

    wss.on("listening", () => {
        console.log(`[SERVER] procMessenger server running on ws://${config.HOST}:${config.PORT}`);
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
            console.log(`[DISCONNECT] ${name} (code=${code})`);
            broadcastClientList();
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
