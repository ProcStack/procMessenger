/**
 * procMessenger Mobile — WebSocket Manager
 *
 * Handles connection lifecycle, registration, message sending/receiving.
 * Supports automatic Tailscale → LAN fallback:
 *   - If a Tailscale IP is configured, it is tried first.
 *   - If Tailscale is unreachable (connection refused or no response within
 *     TAILSCALE_TIMEOUT ms), the LAN IP is tried automatically.
 *   - Reconnects always repeat the same Tailscale-first logic so the VPN
 *     is picked back up whenever it comes online.
 */

// Time (ms) to wait for a Tailscale connection before falling back to LAN
const TAILSCALE_TIMEOUT = 4000;

class WebSocketManager {
    constructor(onMessage, onStatusChange, onClientListUpdate) {
        this.ws = null;
        this.onMessage = onMessage;
        this.onStatusChange = onStatusChange;
        this.onClientListUpdate = onClientListUpdate;
        this.reconnectTimer = null;
        this.connected = false;

        // Persisted across reconnects
        this.lanIp = "";
        this.tailscaleIp = "";
        this.port = CONFIG.PORT;
    }

    /**
     * Connect to the server.
     * Tries tailscaleIp first (if set), falls back to lanIp on failure.
     */
    connect(lanIp, tailscaleIp, port) {
        this.lanIp = lanIp;
        this.tailscaleIp = (tailscaleIp || "").trim();
        this.port = port;

        if (this.tailscaleIp) {
            this._connectTo(this.tailscaleIp, /* tryLanOnFail */ true);
        } else {
            this._connectTo(this.lanIp, /* tryLanOnFail */ false);
        }
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
     * If tryLanOnFail is true and the connection doesn't open within
     * TAILSCALE_TIMEOUT ms (or is refused), the LAN IP is tried instead.
     */
    _connectTo(ip, tryLanOnFail) {
        // Clear any previous connection without triggering its handlers
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

        // Once this flag is set, we've already decided the outcome for this
        // attempt and subsequent events should be ignored.
        let handled = false;

        const fallback = () => {
            if (handled) return;
            handled = true;
            if (this.ws) {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.close();
                this.ws = null;
            }
            this.onStatusChange("connecting", `Tailscale unavailable, trying LAN (${this.lanIp})...`);
            this._connectTo(this.lanIp, false);
        };

        // Timeout – fires if Tailscale is reachable but slow to respond
        const timeoutHandle = tryLanOnFail
            ? setTimeout(fallback, TAILSCALE_TIMEOUT)
            : null;

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (tryLanOnFail) {
                this.onStatusChange("connecting", `Tailscale failed, trying LAN (${this.lanIp})...`);
                this._connectTo(this.lanIp, false);
            } else {
                this.onStatusChange("error", `Failed to connect: ${e.message}`);
                this._scheduleReconnect();
            }
            return;
        }

        this.ws.onopen = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            handled = true;
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
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (handled) {
                // Was successfully connected; now disconnected — schedule reconnect
                this.connected = false;
                this.ws = null;
                this.onStatusChange("disconnected", `Disconnected (code=${event.code})`);
                this._scheduleReconnect();
                return;
            }
            // Connection never opened — treat as failure
            if (tryLanOnFail) {
                fallback();
            } else {
                handled = true;
                this.ws = null;
                this.onStatusChange("disconnected", `Could not connect (code=${event.code})`);
                this._scheduleReconnect();
            }
        };

        this.ws.onerror = () => {
            // onerror always fires before onclose; onclose will handle the logic
            if (!handled) {
                console.warn(`[WS] Connection error on ${url}`);
            }
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
            // Re-run full Tailscale-first logic on each reconnect
            this.connect(this.lanIp, this.tailscaleIp, this.port);
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

