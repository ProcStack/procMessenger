"""
procMessenger – Desktop UI WebSocket Client

Runs on a background thread and manages a single WebSocket connection to the
procMessenger server.  The Qt main thread communicates with this object via
Qt signals and thread-safe method calls.

Design decisions
----------------
- Uses asyncio in a dedicated thread so it never blocks the Qt event loop.
- Chat history is read directly from disk (chat_history.py) rather than sent
  over WebSocket – avoids redundant round-trips since both processes share the
  same filesystem.
- Sends all outbound messages to "llm-chat" using the standard protocol envelope.
- Emits signals on every meaningful server event so the UI can react.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

import websockets
from PyQt6.QtCore import QObject, pyqtSignal

import config

logger = logging.getLogger("procMessenger.qt.ws_client")

CLIENT_NAME = "desktop-ui"
CLIENT_TYPE = "python"


def _build_message(msg_type: str, target: str, payload: dict, flags: dict | None = None) -> str:
    return json.dumps({
        "id": str(uuid.uuid4()),
        "type": msg_type,
        "source": CLIENT_NAME,
        "target": target,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "flags": flags or {},
        "payload": payload,
    })


class WsClient(QObject):
    """Thread-safe WebSocket client that emits Qt signals for incoming events."""

    # Emitted when the connection status changes (True = connected)
    connected = pyqtSignal(bool)
    # Emitted with the parsed client list from the server
    client_list_updated = pyqtSignal(list)
    # Emitted when llm-chat availability changes (True = available)
    llm_available = pyqtSignal(bool)
    # Emitted on every llm_chat message: payload dict
    llm_chat_received = pyqtSignal(dict)
    # Emitted on gather_research_results message
    research_results_received = pyqtSignal(dict)
    # Emitted on gather_research_action response
    research_action_received = pyqtSignal(dict)
    # Emitted on error from server
    server_error = pyqtSignal(dict)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ws = None
        self._running = False
        self._llm_available = False

    # ------------------------------------------------------------------
    # Public thread-safe API (called from Qt thread)
    # ------------------------------------------------------------------

    def start(self):
        """Start the background asyncio thread and connect."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="ws-client")
        self._thread.start()

    def stop(self):
        """Gracefully shut down the background thread."""
        self._running = False
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)

    def send_llm_chat(self, chat_name: str, message: str, provider: str,
                      mode: str, model: Optional[str] = None,
                      system_prompt: Optional[str] = None):
        """Send a chat message to llm-chat over WebSocket."""
        payload: dict = {
            "chatName": chat_name,
            "message": message,
            "provider": provider,
            "mode": mode,
        }
        if model:
            payload["model"] = model
        if system_prompt:
            payload["systemPrompt"] = system_prompt
        self._schedule(self._send(_build_message("llm_chat", config.CLIENT_NAME, payload)))

    def send_gather_research(self, query: str, chat_name: str, provider: str,
                             model: Optional[str] = None):
        """Send a gather_research request to llm-chat."""
        payload: dict = {
            "query": query,
            "chatName": chat_name,
            "provider": provider,
            "maxResults": 5,
        }
        if model:
            payload["model"] = model
        self._schedule(self._send(_build_message("gather_research", config.CLIENT_NAME, payload)))

    def send_research_action(self, action: str, chat_name: str, result_id: str,
                             url: str, title: str, snippet: str,
                             provider: str, model: Optional[str] = None):
        """Send a gather_research_action (index/parse) to llm-chat."""
        payload: dict = {
            "action": action,
            "chatName": chat_name,
            "resultId": result_id,
            "url": url,
            "title": title,
            "snippet": snippet,
            "provider": provider,
        }
        if model:
            payload["model"] = model
        self._schedule(self._send(
            _build_message("gather_research_action", config.CLIENT_NAME, payload)
        ))

    # ------------------------------------------------------------------
    # Internal asyncio helpers
    # ------------------------------------------------------------------

    def _schedule(self, coro):
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(coro, self._loop)

    def _run_loop(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect_loop())
        finally:
            self._loop.close()

    async def _connect_loop(self):
        """Reconnect with exponential back-off until stop() is called."""
        delay = 2
        while self._running:
            uri = f"ws://{config.SERVER_HOST}:{config.SERVER_PORT}"
            try:
                async with websockets.connect(
                    uri,
                    max_size=10 * 1024 * 1024,
                    open_timeout=5,
                ) as ws:
                    self._ws = ws
                    delay = 2  # reset back-off on success
                    self.connected.emit(True)
                    await self._register(ws)
                    await self._recv_loop(ws)
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as exc:
                logger.warning("WebSocket error: %s – retrying in %ds", exc, delay)
            finally:
                self._ws = None
                self._update_llm_available(False)
                self.connected.emit(False)

            if self._running:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def _register(self, ws):
        reg = _build_message("register", "server", {
            "clientType": CLIENT_TYPE,
            "capabilities": ["llm_chat", "gather_research", "gather_research_results",
                             "gather_research_action"],
            "functions": [],
            "hostname": "",
            "nickname": "Desktop UI",
        })
        await ws.send(reg)

    async def _recv_loop(self, ws):
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict):
        msg_type = msg.get("type", "")
        payload = msg.get("payload", {})

        if msg_type == "client_list":
            clients = payload.get("clients", [])
            self.client_list_updated.emit(clients)
            llm_up = any(c.get("name") == config.CLIENT_NAME for c in clients)
            self._update_llm_available(llm_up)
            return

        if msg_type == "client_announce":
            # Server sends individual announce; re-use client_list_updated with a
            # synthetic single-item list so the UI can react.
            client_info = payload.get("client", {})
            if client_info.get("name") == config.CLIENT_NAME:
                self._update_llm_available(True)
            return

        if msg_type == "llm_chat":
            self.llm_chat_received.emit(payload)
            return

        if msg_type == "gather_research_results":
            self.research_results_received.emit(payload)
            return

        if msg_type == "gather_research_action":
            self.research_action_received.emit(payload)
            return

        if msg_type == "error":
            self.server_error.emit(payload)
            return

    async def _send(self, message: str):
        if self._ws:
            try:
                await self._ws.send(message)
            except Exception as exc:
                logger.warning("Send failed: %s", exc)

    def _update_llm_available(self, available: bool):
        if available != self._llm_available:
            self._llm_available = available
            self.llm_available.emit(available)
