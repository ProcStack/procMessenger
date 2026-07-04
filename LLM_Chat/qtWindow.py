"""
procMessenger – Desktop UI (PyQt6)

Launch this script from the LLM_Chat directory to open the desktop chat window.
The LLM_Chat WebSocket client (llm_client.py / start.bat) must already be
running and connected to the procMessenger server.

Usage
-----
    python qtWindow.py

Architecture
------------
  qtWindow.py          – main window, chat/research layout, signal wiring
  qt_ws_client.py      – background asyncio WebSocket thread
  qt_chat_widget.py    – per-chat message history + compose bar
  qt_research_panel.py – research result cards (index / parse)
  qt_markdown.py       – minimal Markdown → HTML converter

Chat history is read directly from disk via chat_history.py to avoid
redundant WebSocket round-trips.  Outbound messages follow the procMessenger
protocol and are routed to the "llm-chat" client on the server.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

# ── Make sure we can import LLM_Chat modules ─────────────────────────────────
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QFont, QIcon, QPalette, QColor
from PyQt6.QtWidgets import (
    QApplication, QDialog, QDialogButtonBox, QFrame, QHBoxLayout,
    QInputDialog, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMainWindow, QMessageBox, QPushButton, QSplitter, QStackedWidget,
    QStatusBar, QTabWidget, QVBoxLayout, QWidget,
)

import chat_history
import config
from llm_providers import get_available_providers, fetch_all_models
from llm_client import load_modes
from qt_ws_client import WsClient
from qt_chat_widget import ChatWidget
from qt_research_panel import ResearchPanel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("procMessenger.qt.window")

# ── Palette ───────────────────────────────────────────────────────────────────
_BG_WINDOW  = "#1e1e2e"
_BG_SIDEBAR = "#181825"
_FG_PRIMARY = "#cdd6f4"
_FG_DIM     = "#6c7086"
_ACCENT     = "#89b4fa"
_BORDER     = "#45475a"
_RED        = "#f38ba8"
_GREEN      = "#a6e3a1"


def _apply_dark_palette(app: QApplication):
    app.setStyle("Fusion")
    pal = QPalette()
    pal.setColor(QPalette.ColorRole.Window,          QColor(_BG_WINDOW))
    pal.setColor(QPalette.ColorRole.WindowText,      QColor(_FG_PRIMARY))
    pal.setColor(QPalette.ColorRole.Base,            QColor("#313244"))
    pal.setColor(QPalette.ColorRole.AlternateBase,   QColor(_BG_SIDEBAR))
    pal.setColor(QPalette.ColorRole.Text,            QColor(_FG_PRIMARY))
    pal.setColor(QPalette.ColorRole.ButtonText,      QColor(_FG_PRIMARY))
    pal.setColor(QPalette.ColorRole.Button,          QColor("#313244"))
    pal.setColor(QPalette.ColorRole.Highlight,       QColor(_ACCENT))
    pal.setColor(QPalette.ColorRole.HighlightedText, QColor(_BG_WINDOW))
    app.setPalette(pal)


# ── Sidebar chat list ─────────────────────────────────────────────────────────

class ChatListWidget(QWidget):
    """Left-hand sidebar listing all chats with metadata."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(240)
        self.setStyleSheet(f"background-color: {_BG_SIDEBAR};")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Header
        hdr = QWidget()
        hdr.setStyleSheet(f"background-color: #11111b; border-bottom: 1px solid {_BORDER};")
        hdr_layout = QHBoxLayout(hdr)
        hdr_layout.setContentsMargins(10, 8, 8, 8)
        hdr_lbl = QLabel("Chats")
        hdr_lbl.setStyleSheet(f"color: {_ACCENT}; font-weight: bold; font-size: 13px;")
        hdr_layout.addWidget(hdr_lbl)
        hdr_layout.addStretch()
        new_btn = QPushButton("+")
        new_btn.setFixedSize(24, 24)
        new_btn.setStyleSheet(
            f"background-color: #313244; color: {_ACCENT}; border: none; "
            f"border-radius: 4px; font-size: 16px; font-weight: bold;"
        )
        new_btn.setToolTip("New chat")
        new_btn.clicked.connect(self._on_new_chat)
        hdr_layout.addWidget(new_btn)
        layout.addWidget(hdr)

        # List
        self._list = QListWidget()
        self._list.setStyleSheet(
            f"background-color: {_BG_SIDEBAR}; color: {_FG_PRIMARY}; "
            f"border: none; font-size: 12px;"
            "QListWidget::item { padding: 8px 10px; border-bottom: 1px solid #313244; }"
            "QListWidget::item:selected { background-color: #313244; color: #cdd6f4; }"
            "QListWidget::item:hover { background-color: #262637; }"
        )
        self._list.setSpacing(1)
        layout.addWidget(self._list, 1)

        self._list.currentItemChanged.connect(self._on_selection_changed)

        self._on_chat_selected_cb = None
        self._on_new_chat_cb = None

    def set_callbacks(self, on_selected, on_new_chat):
        self._on_chat_selected_cb = on_selected
        self._on_new_chat_cb = on_new_chat

    def refresh(self):
        current = self.current_chat_name()
        chats = chat_history.list_chats()
        # Sort most-recently-updated first
        chats.sort(key=lambda c: c.get("updatedAt", ""), reverse=True)

        self._list.blockSignals(True)
        self._list.clear()
        for c in chats:
            name = c.get("name", "")
            count = c.get("messageCount", 0)
            mode = c.get("mode", "")
            item = QListWidgetItem(f"{name}\n{count} msgs · {mode}")
            item.setData(Qt.ItemDataRole.UserRole, name)
            item.setSizeHint(item.sizeHint().__class__(230, 52))
            self._list.addItem(item)
        self._list.blockSignals(False)

        # Restore selection
        if current:
            for i in range(self._list.count()):
                if self._list.item(i).data(Qt.ItemDataRole.UserRole) == current:
                    self._list.setCurrentRow(i)
                    break

    def current_chat_name(self) -> str | None:
        item = self._list.currentItem()
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def select_chat(self, name: str):
        for i in range(self._list.count()):
            if self._list.item(i).data(Qt.ItemDataRole.UserRole) == name:
                self._list.setCurrentRow(i)
                return

    def _on_selection_changed(self, current, previous):
        if current and self._on_chat_selected_cb:
            name = current.data(Qt.ItemDataRole.UserRole)
            self._on_chat_selected_cb(name)

    def _on_new_chat(self):
        if self._on_new_chat_cb:
            self._on_new_chat_cb()


# ── Main Window ───────────────────────────────────────────────────────────────

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("procMessenger – Desktop UI")
        self.resize(1200, 780)

        # State
        self._chat_widgets: dict[str, ChatWidget] = {}
        self._current_chat: str | None = None
        self._providers: list[dict] = []
        self._models: dict[str, list[dict]] = {}
        self._modes: list[dict] = []
        self._llm_available = False

        # WebSocket client
        self._ws = WsClient(self)
        self._ws.connected.connect(self._on_ws_connected)
        self._ws.llm_available.connect(self._on_llm_available)
        self._ws.client_list_updated.connect(self._on_client_list)
        self._ws.llm_chat_received.connect(self._on_llm_message)
        self._ws.research_results_received.connect(self._on_research_results)
        self._ws.research_action_received.connect(self._on_research_action)
        self._ws.server_error.connect(self._on_server_error)

        self._build_ui()
        self._load_providers_from_config()
        self._ws.start()

    # ── UI construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Sidebar
        self._sidebar = ChatListWidget()
        self._sidebar.set_callbacks(self._on_chat_selected, self._on_new_chat)
        root.addWidget(self._sidebar)

        # Vertical separator
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setStyleSheet(f"color: {_BORDER};")
        root.addWidget(sep)

        # Right pane: chat area + research panel in a splitter
        self._splitter = QSplitter(Qt.Orientation.Horizontal)
        self._splitter.setStyleSheet(f"background-color: {_BG_WINDOW};")

        # Stacked chat area
        self._stack = QStackedWidget()
        self._stack.setStyleSheet(f"background-color: {_BG_WINDOW};")

        # Placeholder shown when no chat is selected
        self._placeholder = QLabel("Select or create a chat to begin")
        self._placeholder.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._placeholder.setStyleSheet(f"color: {_FG_DIM}; font-size: 16px;")
        self._stack.addWidget(self._placeholder)

        self._splitter.addWidget(self._stack)

        # Research panel – always visible on the right
        self._research_panel = ResearchPanel()
        self._splitter.addWidget(self._research_panel)
        self._splitter.setSizes([850, 380])

        root.addWidget(self._splitter, 1)

        # Status bar
        self._status_bar = QStatusBar()
        self._status_bar.setStyleSheet(
            f"background-color: #11111b; color: {_FG_DIM}; font-size: 11px;"
        )
        self.setStatusBar(self._status_bar)
        self._conn_lbl = QLabel("● Connecting…")
        self._conn_lbl.setStyleSheet(f"color: {_FG_DIM};")
        self._llm_lbl = QLabel("llm-chat: unknown")
        self._llm_lbl.setStyleSheet(f"color: {_FG_DIM};")
        self._status_bar.addPermanentWidget(self._conn_lbl)
        self._status_bar.addPermanentWidget(self._llm_lbl)

        # Populate sidebar
        self._sidebar.refresh()

    # ── Provider/mode loading ─────────────────────────────────────────────────

    def _load_providers_from_config(self):
        """Load available providers/modes from config synchronously at startup."""
        import asyncio

        self._modes = load_modes()

        # Fetch providers and models asynchronously, update UI when done
        async def _fetch():
            providers = get_available_providers()
            models = await fetch_all_models()
            for p in providers:
                p["models"] = models.get(p["value"], [])
            return providers, models

        loop = asyncio.new_event_loop()
        try:
            self._providers, self._models = loop.run_until_complete(_fetch())
        except Exception as exc:
            logger.warning("Could not fetch models at startup: %s", exc)
            self._providers = get_available_providers()
            self._models = {}
        finally:
            loop.close()

    # ── Chat management ───────────────────────────────────────────────────────

    def _on_chat_selected(self, name: str):
        self._current_chat = name
        if name not in self._chat_widgets:
            widget = ChatWidget(name, self._ws)
            widget.set_providers(self._providers, self._models)
            widget.set_modes(self._modes)
            widget.set_llm_available(self._llm_available)
            self._chat_widgets[name] = widget
            self._stack.addWidget(widget)

        self._stack.setCurrentWidget(self._chat_widgets[name])
        # Reload from disk in case another client updated the chat
        self._chat_widgets[name].reload_history()
        # Clear research panel when switching chats so stale results don't show
        self._research_panel.clear()

    def _on_new_chat(self):
        name, ok = QInputDialog.getText(
            self, "New Chat", "Chat name:", QLineEdit.EchoMode.Normal
        )
        if not ok or not name.strip():
            return
        name = name.strip()
        provider = self._providers[0]["value"] if self._providers else "llama"
        chat_history.create_chat(name, provider=provider, mode="ask")
        self._sidebar.refresh()
        self._sidebar.select_chat(name)

    # ── WebSocket signal handlers ─────────────────────────────────────────────

    def _on_ws_connected(self, connected: bool):
        if connected:
            self._conn_lbl.setText("● Server connected")
            self._conn_lbl.setStyleSheet(f"color: {_GREEN};")
        else:
            self._conn_lbl.setText("● Disconnected – reconnecting…")
            self._conn_lbl.setStyleSheet(f"color: {_RED};")

    def _on_llm_available(self, available: bool):
        self._llm_available = available
        if available:
            self._llm_lbl.setText("llm-chat: ✓ online")
            self._llm_lbl.setStyleSheet(f"color: {_GREEN};")
        else:
            self._llm_lbl.setText("llm-chat: ✗ offline")
            self._llm_lbl.setStyleSheet(f"color: {_RED};")

        # Propagate to all open chat widgets
        for w in self._chat_widgets.values():
            w.set_llm_available(available)

    def _on_client_list(self, clients: list):
        pass  # llm_available signal handles the important bit

    def _on_llm_message(self, payload: dict):
        chat_name = payload.get("chatName", "")
        if not chat_name:
            return

        # Refresh sidebar count
        self._sidebar.refresh()

        # Route to the correct chat widget (create lazily if needed)
        if chat_name not in self._chat_widgets:
            widget = ChatWidget(chat_name, self._ws)
            widget.set_providers(self._providers, self._models)
            widget.set_modes(self._modes)
            widget.set_llm_available(self._llm_available)
            self._chat_widgets[chat_name] = widget
            self._stack.addWidget(widget)

        self._chat_widgets[chat_name].on_llm_message(payload)

        # If we're currently viewing this chat, show the research panel if relevant
        if chat_name == self._current_chat:
            status = payload.get("status", "")
            if status in ("thinking",):
                # Research may be incoming – pre-show panel
                pass

    def _on_research_results(self, payload: dict):
        chat_name = payload.get("chatName", "")
        if not chat_name:
            return

        # Determine provider/model from the active chat widget
        chat_widget = self._chat_widgets.get(chat_name)
        provider = "llama"
        model = None
        if chat_widget:
            provider = chat_widget._provider_combo.currentData() or "llama"
            model = chat_widget._model_combo.currentData() or None

        # If the results are for a different chat, switch to it first
        if chat_name != self._current_chat:
            self._sidebar.select_chat(chat_name)

        self._research_panel.display_results(payload, chat_name, self._ws, provider, model)

    def _on_research_action(self, payload: dict):
        self._research_panel.handle_action_response(payload)

    def _on_server_error(self, payload: dict):
        code = payload.get("code", "ERROR")
        msg = payload.get("message", "Unknown error from server.")
        self._status_bar.showMessage(f"[{code}] {msg}", 5000)

    # ── Window close ─────────────────────────────────────────────────────────

    def closeEvent(self, event):
        self._ws.stop()
        event.accept()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("procMessenger Desktop")
    _apply_dark_palette(app)

    font = QFont("Segoe UI", 10)
    app.setFont(font)

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
