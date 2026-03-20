/**
 * procMessenger Mobile — WebSocket Manager
 *
 * Handles connection lifecycle, registration, message sending/receiving.
 * Connects directly to the provided IP (LAN or Tailscale — treated the same).
 */

class WebSocketManager {
    constructor(onMessage, onStatusChange, onClientListUpdate) {
        this.ws = null;
        this.onMessage = onMessage;
        this.onStatusChange = onStatusChange;
        this.onClientListUpdate = onClientListUpdate;
        this.reconnectTimer = null;
        this.connected = false;

        this.ip = "";
        this.port = CONFIG.PORT;
    }

    /**
     * Connect to the server at ip:port.
     */
    connect(ip, port) {
        this.ip = ip;
        this.port = port;
        this._connectTo(this.ip);
    }

    /**
     * Disconnect and cancel any pending reconnect.
     */
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    /**
     * Send a message through the WebSocket.
     */
    send(type, target, payload, flags = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn("Cannot send — not connected.");
            return false;
        }

        const msg = {
            id: this._uuid(),
            type: type,
            source: CONFIG.CLIENT_NAME,
            target: target,
            timestamp: new Date().toISOString(),
            flags: flags,
            payload: payload,
        };

        this.ws.send(JSON.stringify(msg));
        return true;
    }

    /**
     * Set a nickname for a client.
     */
    setNickname(clientName, nickname) {
        return this.send("nickname", "server", {
            clientName: clientName,
            nickname: nickname,
        });
    }

    // --- Private methods ---

    /**
     * Attempt a WebSocket connection to `ip:port`.
     */
    _connectTo(ip) {
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        const url = `ws://${ip}:${this.port}`;
        this.onStatusChange("connecting", `Connecting to ${url}...`);

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            this.onStatusChange("error", `Failed to connect: ${e.message}`);
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            this.connected = true;
            this.onStatusChange("connected", `Connected to ${url}`);
            this._register();
        };

        this.ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                console.warn("Received invalid JSON:", event.data);
                return;
            }
            this._handleIncoming(msg);
        };

        this.ws.onclose = (event) => {
            this.connected = false;
            this.ws = null;
            this.onStatusChange("disconnected", `Disconnected (code=${event.code})`);
            this._scheduleReconnect();
        };

        this.ws.onerror = () => {
            console.warn(`[WS] Connection error on ${url}`);
        };
    }

    _register() {
        this.send("register", "server", {
            clientType: CONFIG.CLIENT_TYPE,
            capabilities: [],
            hostname: CONFIG.CLIENT_NAME,
            nickname: "",
        });
    }

    _handleIncoming(msg) {
        const type = msg.type || "";

        if (type === "client_list") {
            const clients = (msg.payload || {}).clients || [];
            this.onClientListUpdate(clients);
            return;
        }

        if (type === "ping") {
            this.send("pong", "server", {});
            return;
        }

        // Forward everything else to the UI
        this.onMessage(msg);
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.onStatusChange("reconnecting", `Reconnecting in ${CONFIG.RECONNECT_DELAY / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(this.ip, this.port);
        }, CONFIG.RECONNECT_DELAY);
    }

    _uuid() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
}

