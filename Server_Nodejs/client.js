/**
 * procMessenger — Node.js Client
 *
 * Connects to the procMessenger WebSocket server.
 * If no server is running, starts one automatically, then connects as a client.
 */

const net = require("net");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const config = require("./config");
const { startServer, buildMessage } = require("./server");
const { handleMessage } = require("./handlers");

let serverInstance = null;

/**
 * Check if a server is already listening on the configured port.
 */
function isServerRunning() {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(2000);
        sock.once("connect", () => {
            sock.destroy();
            resolve(true);
        });
        sock.once("error", () => {
            sock.destroy();
            resolve(false);
        });
        sock.once("timeout", () => {
            sock.destroy();
            resolve(false);
        });
        sock.connect(config.PORT, "127.0.0.1");
    });
}

/**
 * Connect to the WebSocket server as a client.
 */
async function connectAsClient() {
    const uri = `ws://127.0.0.1:${config.PORT}`;
    console.log(`[CLIENT] Connecting to ${uri} as '${config.CLIENT_NAME}'...`);

    const ws = new WebSocket(uri);

    ws.on("open", () => {
        console.log("[CLIENT] Connected to server.");

        // Register
        const regMsg = buildMessage("register", config.CLIENT_NAME, "server", {
            clientType: "nodejs",
            capabilities: config.CAPABILITIES,
            hostname: os.hostname(),
            nickname: "",
        });
        ws.send(regMsg);
        console.log("[CLIENT] Registered.");
    });

    ws.on("message", async (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            console.warn("[CLIENT] Received invalid JSON, ignoring.");
            return;
        }

        const { type, source } = msg;
        console.log(`[CLIENT] Received: type=${type} from=${source}`);

        // System messages
        if (type === "client_list") {
            const clients = (msg.payload || {}).clients || [];
            const names = clients.map((c) => c.name);
            console.log(`[CLIENT] Connected clients: ${names.join(", ")}`);
            return;
        }

        if (type === "client_announce") {
            const p = msg.payload || {};
            const c = p.client || {};
            if (p.action === "joined") {
                console.log(`[ANNOUNCE] ${c.name} (${c.clientType}) from ${c.hostname} has connected.`);
            } else if (p.action === "left") {
                console.log(`[ANNOUNCE] ${c.name} (${c.clientType}) from ${c.hostname} has disconnected.`);
            }
            return;
        }

        if (type === "ping") {
            const pong = buildMessage("pong", config.CLIENT_NAME, "server", {});
            ws.send(pong);
            return;
        }

        if (type === "error") {
            const p = msg.payload || {};
            console.warn(`[CLIENT] Error: ${p.code} — ${p.message}`);
            if (p.code === "DUPLICATE_CLIENT") {
                console.error("[CLIENT] This hostname already has a client of this type connected. Exiting.");
                process.exit(1);
            }
            return;
        }

        // Handle actionable messages
        const [responseType, responsePayload] = await handleMessage(msg);
        if (responseType && responsePayload) {
            const reply = buildMessage(
                responseType,
                config.CLIENT_NAME,
                source,
                responsePayload,
                { correlationId: msg.id || "" }
            );
            ws.send(reply);
            console.log(`[CLIENT] Sent response: type=${responseType} to=${source}`);
        }
    });

    ws.on("close", (code) => {
        if (code === 4001) {
            console.error("[CLIENT] Duplicate client — server rejected connection. Exiting.");
            process.exit(1);
        }
        console.log(`[CLIENT] Disconnected (code=${code}). Reconnecting in 5s...`);
        setTimeout(run, 5000);
    });

    ws.on("error", (err) => {
        console.error(`[CLIENT] Error: ${err.message}`);
    });
}

/**
 * Main entry: check for server, start if needed, then connect.
 */
async function run() {
    const running = await isServerRunning();

    if (!running) {
        console.log("[CLIENT] No server detected. Starting server...");
        serverInstance = startServer();
        // Give server a moment to start
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await connectAsClient();
}

run().catch((err) => {
    console.error("[CLIENT] Fatal error:", err);
    process.exit(1);
});
