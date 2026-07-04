"""
procMessenger – Chat Widget

Renders a single conversation's message history and provides a compose bar.
Reads history directly from disk (chat_history.py) and sends new messages
via the WsClient signal interface.

Layout
------
  ┌─────────────────────────────────────────────────┐
  │  Toolbar: mode ▾  provider ▾  model ▾           │
  ├─────────────────────────────────────────────────┤
  │                                                 │
  │            Message history (scrollable)         │
  │                                                 │
  ├─────────────────────────────────────────────────┤
  │  [ message input …              ] [Send] [⟳]   │
  └─────────────────────────────────────────────────┘
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from PyQt6.QtCore import Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QColor, QPalette, QTextCursor
from PyQt6.QtWidgets import (
    QComboBox, QFrame, QHBoxLayout, QLabel, QPlainTextEdit,
    QPushButton, QScrollArea, QSizePolicy, QToolBar,
    QVBoxLayout, QWidget,
)

import chat_history
import config
from qt_markdown import render_markdown

logger = logging.getLogger("procMessenger.qt.chat_widget")

# ── colour palette (dark theme) ──────────────────────────────────────────────
_BG_WINDOW   = "#1e1e2e"
_BG_USER     = "#313244"
_BG_ASSIST   = "#262637"
_BG_TOOLBAR  = "#181825"
_FG_PRIMARY  = "#cdd6f4"
_FG_DIM      = "#6c7086"
_ACCENT      = "#89b4fa"
_BORDER      = "#45475a"
_SEND_BTN    = "#89b4fa"
_SEND_FG     = "#1e1e2e"


class _Bubble(QFrame):
    """A single message bubble."""

    def __init__(self, role: str, content: str, timestamp: str = "", parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.NoFrame)

        bg = _BG_USER if role == "user" else _BG_ASSIST
        align = Qt.AlignmentFlag.AlignRight if role == "user" else Qt.AlignmentFlag.AlignLeft
        label_text = "You" if role == "user" else "Nova"

        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 4, 8, 4)
        outer.setSpacing(2)

        # Header row: sender + timestamp
        header = QHBoxLayout()
        sender_lbl = QLabel(label_text)
        sender_lbl.setStyleSheet(f"color: {_ACCENT}; font-weight: bold; font-size: 11px;")
        if timestamp:
            try:
                dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                ts_str = dt.strftime("%H:%M")
            except ValueError:
                ts_str = timestamp
            ts_lbl = QLabel(ts_str)
            ts_lbl.setStyleSheet(f"color: {_FG_DIM}; font-size: 10px;")
        else:
            ts_lbl = QLabel("")

        if role == "user":
            header.addStretch()
            header.addWidget(ts_lbl)
            header.addWidget(sender_lbl)
        else:
            header.addWidget(sender_lbl)
            header.addWidget(ts_lbl)
            header.addStretch()

        outer.addLayout(header)

        # Content bubble
        bubble = QFrame()
        bubble.setStyleSheet(
            f"background-color: {bg}; border-radius: 8px; padding: 8px;"
        )
        bubble_layout = QVBoxLayout(bubble)
        bubble_layout.setContentsMargins(10, 8, 10, 8)

        content_lbl = QLabel(render_markdown(content))
        content_lbl.setWordWrap(True)
        content_lbl.setOpenExternalLinks(True)
        content_lbl.setTextFormat(Qt.TextFormat.RichText)
        content_lbl.setStyleSheet(f"color: {_FG_PRIMARY}; font-size: 13px; background: transparent;")
        content_lbl.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum)
        bubble_layout.addWidget(content_lbl)
        bubble.setMaximumWidth(700)

        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        if role == "user":
            row.addStretch()
            row.addWidget(bubble)
        else:
            row.addWidget(bubble)
            row.addStretch()
        outer.addLayout(row)


class _ThinkingBubble(QFrame):
    """Animated 'Nova is thinking…' indicator."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.NoFrame)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 4, 8, 4)
        self._lbl = QLabel("Nova is thinking…")
        self._lbl.setStyleSheet(f"color: {_FG_DIM}; font-style: italic; font-size: 12px;")
        layout.addWidget(self._lbl)
        layout.addStretch()
        self._dots = 0
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(400)

    def _tick(self):
        self._dots = (self._dots + 1) % 4
        self._lbl.setText("Nova is thinking" + "." * self._dots)

    def stop(self):
        self._timer.stop()


class ChatWidget(QWidget):
    """Full chat panel for one conversation."""

    send_requested = pyqtSignal(str, str, str, str, str)  # chat_name, message, provider, mode, model

    def __init__(self, chat_name: str, ws_client, parent=None):
        super().__init__(parent)
        self.chat_name = chat_name
        self._ws = ws_client
        self._thinking_bubble: Optional[_ThinkingBubble] = None
        self._providers: list[dict] = []
        self._modes: list[dict] = []
        self._models: dict[str, list[dict]] = {}

        self._build_ui()
        self._load_history()

    # ── UI construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        self.setStyleSheet(f"background-color: {_BG_WINDOW};")
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Toolbar
        toolbar = QWidget()
        toolbar.setStyleSheet(f"background-color: {_BG_TOOLBAR}; border-bottom: 1px solid {_BORDER};")
        tbl = QHBoxLayout(toolbar)
        tbl.setContentsMargins(8, 4, 8, 4)
        tbl.setSpacing(8)

        mode_lbl = QLabel("Mode:")
        mode_lbl.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")
        self._mode_combo = QComboBox()
        self._mode_combo.setStyleSheet(self._combo_style())

        provider_lbl = QLabel("Provider:")
        provider_lbl.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")
        self._provider_combo = QComboBox()
        self._provider_combo.setStyleSheet(self._combo_style())
        self._provider_combo.currentIndexChanged.connect(self._on_provider_changed)

        model_lbl = QLabel("Model:")
        model_lbl.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")
        self._model_combo = QComboBox()
        self._model_combo.setStyleSheet(self._combo_style())

        tbl.addWidget(mode_lbl)
        tbl.addWidget(self._mode_combo)
        tbl.addSpacing(12)
        tbl.addWidget(provider_lbl)
        tbl.addWidget(self._provider_combo)
        tbl.addSpacing(12)
        tbl.addWidget(model_lbl)
        tbl.addWidget(self._model_combo)
        tbl.addStretch()

        root.addWidget(toolbar)

        # Message scroll area
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setStyleSheet(f"background-color: {_BG_WINDOW}; border: none;")
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)

        self._msg_container = QWidget()
        self._msg_container.setStyleSheet(f"background-color: {_BG_WINDOW};")
        self._msg_layout = QVBoxLayout(self._msg_container)
        self._msg_layout.setContentsMargins(8, 8, 8, 8)
        self._msg_layout.setSpacing(4)
        self._msg_layout.addStretch()

        self._scroll.setWidget(self._msg_container)
        root.addWidget(self._scroll, 1)

        # Compose bar
        compose_bg = QWidget()
        compose_bg.setStyleSheet(
            f"background-color: {_BG_TOOLBAR}; border-top: 1px solid {_BORDER};"
        )
        cbl = QHBoxLayout(compose_bg)
        cbl.setContentsMargins(8, 8, 8, 8)
        cbl.setSpacing(6)

        self._input = QPlainTextEdit()
        self._input.setPlaceholderText("Message Nova…")
        self._input.setMaximumHeight(90)
        self._input.setStyleSheet(
            f"background-color: {_BG_ASSIST}; color: {_FG_PRIMARY}; "
            f"border: 1px solid {_BORDER}; border-radius: 6px; "
            f"padding: 6px; font-size: 13px;"
        )
        self._input.installEventFilter(self)
        cbl.addWidget(self._input, 1)

        self._send_btn = QPushButton("Send")
        self._send_btn.setFixedWidth(72)
        self._send_btn.setStyleSheet(
            f"background-color: {_SEND_BTN}; color: {_SEND_FG}; "
            f"border: none; border-radius: 6px; font-weight: bold; font-size: 13px; padding: 6px;"
        )
        self._send_btn.clicked.connect(self._on_send)
        cbl.addWidget(self._send_btn)

        root.addWidget(compose_bg)

    @staticmethod
    def _combo_style() -> str:
        return (
            f"background-color: {_BG_ASSIST}; color: {_FG_PRIMARY}; "
            f"border: 1px solid {_BORDER}; border-radius: 4px; padding: 2px 6px; font-size: 11px;"
        )

    # ── Providers / modes injection (called by main window) ──────────────────

    def set_providers(self, providers: list[dict], models: dict[str, list[dict]]):
        self._providers = providers
        self._models = models

        self._provider_combo.blockSignals(True)
        self._provider_combo.clear()
        for p in providers:
            self._provider_combo.addItem(p["label"], userData=p["value"])
        self._provider_combo.blockSignals(False)
        self._on_provider_changed()

        # Restore saved provider from chat metadata
        chat_data = chat_history.get_chat(self.chat_name)
        if chat_data:
            saved_provider = chat_data.get("provider", "")
            idx = self._provider_combo.findData(saved_provider)
            if idx >= 0:
                self._provider_combo.setCurrentIndex(idx)
                self._on_provider_changed()

    def set_modes(self, modes: list[dict]):
        self._modes = modes
        self._mode_combo.blockSignals(True)
        self._mode_combo.clear()
        for m in modes:
            self._mode_combo.addItem(m["label"], userData=m["value"])
        self._mode_combo.blockSignals(False)

        # Restore saved mode
        chat_data = chat_history.get_chat(self.chat_name)
        if chat_data:
            saved_mode = chat_data.get("mode", "ask")
            idx = self._mode_combo.findData(saved_mode)
            if idx >= 0:
                self._mode_combo.setCurrentIndex(idx)

    def _on_provider_changed(self):
        provider_key = self._provider_combo.currentData()
        self._model_combo.clear()
        for m in self._models.get(provider_key, []):
            self._model_combo.addItem(m.get("name") or m.get("id", ""), userData=m.get("id", ""))

    # ── History loading ───────────────────────────────────────────────────────

    def _load_history(self):
        """Read messages from disk and render them."""
        # Remove all existing bubbles (keep the trailing stretch)
        while self._msg_layout.count() > 1:
            item = self._msg_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        messages = chat_history.get_chat_messages(self.chat_name) or []
        for msg in messages:
            self._append_bubble(msg.get("role", "user"), msg.get("content", ""),
                                msg.get("timestamp", ""))
        self._scroll_to_bottom()

    def reload_history(self):
        """Refresh from disk (called when switching tabs or on external change)."""
        self._load_history()

    # ── Message handling ──────────────────────────────────────────────────────

    def _append_bubble(self, role: str, content: str, timestamp: str = ""):
        # Insert before the trailing stretch
        insert_pos = self._msg_layout.count() - 1
        bubble = _Bubble(role, content, timestamp)
        self._msg_layout.insertWidget(insert_pos, bubble)

    def _show_thinking(self):
        if self._thinking_bubble:
            return
        insert_pos = self._msg_layout.count() - 1
        self._thinking_bubble = _ThinkingBubble()
        self._msg_layout.insertWidget(insert_pos, self._thinking_bubble)
        self._scroll_to_bottom()

    def _hide_thinking(self):
        if self._thinking_bubble:
            self._thinking_bubble.stop()
            self._msg_layout.removeWidget(self._thinking_bubble)
            self._thinking_bubble.deleteLater()
            self._thinking_bubble = None

    def on_llm_message(self, payload: dict):
        """Called by the main window when an llm_chat payload arrives for this chat."""
        if payload.get("chatName") != self.chat_name:
            return

        status = payload.get("status", "")
        if status == "thinking":
            self._show_thinking()
        elif status == "complete":
            self._hide_thinking()
            message = payload.get("message", "")
            if message:
                self._append_bubble("assistant", message)
                self._scroll_to_bottom()
            self._set_input_enabled(True)

    def _on_send(self):
        text = self._input.toPlainText().strip()
        if not text:
            return

        provider = self._provider_combo.currentData() or "llama"
        mode = self._mode_combo.currentData() or "ask"
        model = self._model_combo.currentData() or None

        self._input.clear()
        self._append_bubble("user", text)
        self._scroll_to_bottom()
        self._set_input_enabled(False)

        # Immediately write to disk so it's persisted even if LLM is slow
        chat_history.append_message(self.chat_name, "user", text)

        self._ws.send_llm_chat(self.chat_name, text, provider, mode, model)

    def _set_input_enabled(self, enabled: bool):
        self._input.setEnabled(enabled)
        self._send_btn.setEnabled(enabled)

    def set_llm_available(self, available: bool):
        self._send_btn.setEnabled(available)
        if not available:
            self._send_btn.setToolTip("llm-chat client is not connected")
        else:
            self._send_btn.setToolTip("")

    def _scroll_to_bottom(self):
        QTimer.singleShot(50, lambda: self._scroll.verticalScrollBar().setValue(
            self._scroll.verticalScrollBar().maximum()
        ))

    # ── Keyboard shortcut: Enter sends, Shift+Enter newline ──────────────────

    def eventFilter(self, obj, event):
        from PyQt6.QtCore import QEvent
        from PyQt6.QtGui import QKeyEvent
        if obj is self._input and event.type() == QEvent.Type.KeyPress:
            ke = event
            if (ke.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
                    and not (ke.modifiers() & Qt.KeyboardModifier.ShiftModifier)):
                self._on_send()
                return True
        return super().eventFilter(obj, event)
