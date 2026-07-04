"""
procMessenger – Research Results Panel

Displays Gather Research results as a selectable list of cards.
Clicking a card selects it (highlighted border) and enables the action bar
at the bottom — Index / Parse into Chat / Dismiss — mirroring the mobile
app's research result modal.

Public API
----------
  ResearchPanel.display_results(payload, chat_name, ws_client, provider, model)
      Render a gather_research_results payload.

  ResearchPanel.handle_action_response(payload)
      Update card state when an index / parse action completes.

  ResearchPanel.clear()
      Remove all result cards and reset state.
"""

from __future__ import annotations

import logging
from typing import Optional

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QCursor
from PyQt6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QVBoxLayout, QWidget,
)

logger = logging.getLogger("procMessenger.qt.research_panel")

# ── Palette ───────────────────────────────────────────────────────────────────
_BG_WINDOW   = "#1e1e2e"
_BG_CARD     = "#262637"
_BG_SELECTED = "#313244"
_FG_PRIMARY  = "#cdd6f4"
_FG_DIM      = "#6c7086"
_ACCENT      = "#89b4fa"
_BORDER      = "#45475a"
_BORDER_SEL  = "#89b4fa"
_GREEN       = "#a6e3a1"
_YELLOW      = "#f9e2af"
_RED         = "#f38ba8"


# ── Single result card ────────────────────────────────────────────────────────

class _ResultCard(QFrame):
    """Clickable card for one research result.  Emits ``selected`` on click."""

    selected = pyqtSignal(object)   # emits self

    _NORMAL_STYLE = (
        f"_ResultCard {{ background-color: {_BG_CARD}; border: 1px solid {_BORDER}; "
        f"border-radius: 8px; margin: 4px 6px; }}"
    )
    _SELECTED_STYLE = (
        f"_ResultCard {{ background-color: {_BG_SELECTED}; border: 2px solid {_BORDER_SEL}; "
        f"border-radius: 8px; margin: 4px 6px; }}"
    )

    def __init__(self, result: dict, parent=None):
        super().__init__(parent)
        self.result = result
        self._is_selected = False

        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setStyleSheet(self._NORMAL_STYLE)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(4)

        # Title
        title_lbl = QLabel(result.get("title", "(no title)"))
        title_lbl.setStyleSheet(
            f"color: {_ACCENT}; font-weight: bold; font-size: 13px; background: transparent; border: none;"
        )
        title_lbl.setWordWrap(True)
        layout.addWidget(title_lbl)

        # URL
        url = result.get("url", "")
        url_lbl = QLabel(f'<a href="{url}" style="color:{_FG_DIM};">{url[:80]}</a>')
        url_lbl.setOpenExternalLinks(True)
        url_lbl.setTextFormat(Qt.TextFormat.RichText)
        url_lbl.setStyleSheet("background: transparent; border: none;")
        layout.addWidget(url_lbl)

        # Snippet
        snippet = result.get("snippet", result.get("content", ""))
        if snippet:
            snip_lbl = QLabel(snippet[:300] + ("…" if len(snippet) > 300 else ""))
            snip_lbl.setWordWrap(True)
            snip_lbl.setStyleSheet(
                f"color: {_FG_PRIMARY}; font-size: 12px; background: transparent; border: none;"
            )
            layout.addWidget(snip_lbl)

        # Eval reason
        reason = result.get("evalReason", "")
        if reason:
            reason_lbl = QLabel(f"✓ {reason[:120]}")
            reason_lbl.setWordWrap(True)
            reason_lbl.setStyleSheet(
                f"color: {_GREEN}; font-size: 11px; font-style: italic; background: transparent; border: none;"
            )
            layout.addWidget(reason_lbl)

        # Status label (updated by action responses)
        self._status_lbl = QLabel("")
        self._status_lbl.setStyleSheet(
            f"color: {_GREEN}; font-size: 11px; background: transparent; border: none;"
        )
        layout.addWidget(self._status_lbl)

    # ── Selection state ───────────────────────────────────────────────────────

    def set_selected(self, selected: bool):
        self._is_selected = selected
        self.setStyleSheet(self._SELECTED_STYLE if selected else self._NORMAL_STYLE)

    def is_selected(self) -> bool:
        return self._is_selected

    def set_status(self, text: str, color: str = _GREEN):
        self._status_lbl.setText(text)
        self._status_lbl.setStyleSheet(
            f"color: {color}; font-size: 11px; background: transparent; border: none;"
        )

    # ── Mouse interaction ─────────────────────────────────────────────────────

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.selected.emit(self)
        super().mousePressEvent(event)


# ── Main panel ────────────────────────────────────────────────────────────────

class ResearchPanel(QWidget):
    """
    Right-hand sidebar showing Gather Research results.

    Layout
    ------
    ┌─── Header (query / count) ───────────────────────────────┐
    │   Scrollable card list                                    │
    │   [card] title / url / snippet / eval reason             │
    │   …                                                      │
    ├─── Action bar (enabled when a card is selected) ─────────┤
    │   [Index]  [Parse into Chat]  [Dismiss]   <status>       │
    └───────────────────────────────────────────────────────────┘
    """

    action_requested = pyqtSignal(str, dict)   # ("index"|"parse"|"dismiss"), result

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumWidth(300)

        self._cards: dict[str, _ResultCard] = {}
        self._selected_card: Optional[_ResultCard] = None
        self._chat_name = ""
        self._ws_client = None
        self._provider = "llama"
        self._model: Optional[str] = None

        self._build_ui()

    # ── UI construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── Header ─────────────────────────────────────────────────────────
        hdr = QWidget()
        hdr.setStyleSheet(f"background-color: #181825; border-bottom: 1px solid {_BORDER};")
        hdr_layout = QVBoxLayout(hdr)
        hdr_layout.setContentsMargins(12, 8, 12, 8)
        hdr_layout.setSpacing(2)

        self._header_lbl = QLabel("Research Results")
        self._header_lbl.setStyleSheet(
            f"color: {_ACCENT}; font-weight: bold; font-size: 13px;"
        )
        self._sub_lbl = QLabel("Select Gather Research mode and send a message")
        self._sub_lbl.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")

        hdr_layout.addWidget(self._header_lbl)
        hdr_layout.addWidget(self._sub_lbl)
        root.addWidget(hdr)

        # ── Scroll area of cards ────────────────────────────────────────────
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet(f"background-color: {_BG_WINDOW}; border: none;")

        self._container = QWidget()
        self._container.setStyleSheet(f"background-color: {_BG_WINDOW};")
        self._card_layout = QVBoxLayout(self._container)
        self._card_layout.setContentsMargins(0, 4, 0, 4)
        self._card_layout.setSpacing(2)
        self._card_layout.addStretch()

        self._empty_lbl = QLabel(
            "No research results yet.\n\nSelect Gather Research mode\nand send a message."
        )
        self._empty_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_lbl.setStyleSheet(f"color: {_FG_DIM}; font-size: 13px;")
        self._card_layout.insertWidget(0, self._empty_lbl)

        scroll.setWidget(self._container)
        root.addWidget(scroll, 1)

        # ── Action bar ──────────────────────────────────────────────────────
        action_bar = QWidget()
        action_bar.setStyleSheet(
            f"background-color: #181825; border-top: 1px solid {_BORDER};"
        )
        abl = QVBoxLayout(action_bar)
        abl.setContentsMargins(10, 8, 10, 10)
        abl.setSpacing(6)

        # Hint label shown when nothing is selected
        self._action_hint = QLabel("↑  Click a result card to select it")
        self._action_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._action_hint.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")
        abl.addWidget(self._action_hint)

        # Button row
        btn_row = QHBoxLayout()
        btn_row.setSpacing(6)

        self._idx_btn = QPushButton("Index")
        self._idx_btn.setFixedHeight(32)
        self._idx_btn.setToolTip("Index this result into procIndex for future retrieval")
        self._idx_btn.setStyleSheet(
            f"background-color: #313244; color: {_ACCENT}; "
            f"border: 1px solid {_ACCENT}; border-radius: 5px; "
            f"font-size: 12px; font-weight: bold; padding: 0 12px;"
        )
        self._idx_btn.clicked.connect(self._on_index)
        btn_row.addWidget(self._idx_btn)

        self._parse_btn = QPushButton("Parse into Chat")
        self._parse_btn.setFixedHeight(32)
        self._parse_btn.setToolTip(
            "Parse this result and inject its content into the current chat context"
        )
        self._parse_btn.setStyleSheet(
            f"background-color: #313244; color: {_YELLOW}; "
            f"border: 1px solid {_YELLOW}; border-radius: 5px; "
            f"font-size: 12px; font-weight: bold; padding: 0 12px;"
        )
        self._parse_btn.clicked.connect(self._on_parse)
        btn_row.addWidget(self._parse_btn)

        self._dismiss_btn = QPushButton("Dismiss")
        self._dismiss_btn.setFixedHeight(32)
        self._dismiss_btn.setToolTip("Remove this result from the list")
        self._dismiss_btn.setStyleSheet(
            f"background-color: #313244; color: {_RED}; "
            f"border: 1px solid {_RED}; border-radius: 5px; "
            f"font-size: 12px; padding: 0 12px;"
        )
        self._dismiss_btn.clicked.connect(self._on_dismiss)
        btn_row.addWidget(self._dismiss_btn)

        abl.addLayout(btn_row)

        # Action status label
        self._action_status = QLabel("")
        self._action_status.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._action_status.setStyleSheet(f"color: {_GREEN}; font-size: 11px;")
        abl.addWidget(self._action_status)

        root.addWidget(action_bar)

        # Buttons start disabled
        self._set_action_buttons_enabled(False)

    def _set_action_buttons_enabled(self, enabled: bool):
        self._idx_btn.setEnabled(enabled)
        self._parse_btn.setEnabled(enabled)
        self._dismiss_btn.setEnabled(enabled)
        self._action_hint.setVisible(not enabled)

    # ── Public API ────────────────────────────────────────────────────────────

    def display_results(
        self,
        payload: dict,
        chat_name: str,
        ws_client,
        provider: str,
        model: Optional[str],
    ):
        """Render a gather_research_results payload."""
        self._chat_name = chat_name
        self._ws_client = ws_client
        self._provider = provider
        self._model = model

        results = payload.get("results", [])
        search_query = payload.get("searchQuery", "")
        total_found = payload.get("totalFound", len(results))
        discarded = payload.get("discarded", 0)

        self._header_lbl.setText(f"Research: '{search_query}'")
        self._sub_lbl.setText(
            f"{total_found} kept · {discarded} discarded  —  click a result to select"
        )
        self._empty_lbl.setVisible(not results)

        for result in results:
            result_id = result.get("resultId", result.get("url", ""))
            if result_id in self._cards:
                continue

            card = _ResultCard(result)
            card.selected.connect(self._on_card_selected)

            self._cards[result_id] = card
            insert_pos = self._card_layout.count() - 1
            self._card_layout.insertWidget(insert_pos, card)

        # Deselect any previous selection when new results arrive
        self._deselect_all()

    def handle_action_response(self, payload: dict):
        """Update card state when an index / parse action completes."""
        result_id = payload.get("resultId", "")
        status = payload.get("status", "")
        title = payload.get("title", result_id)

        card = self._cards.get(result_id)

        if status == "indexed":
            if card:
                card.set_status("✓ Indexed")
            self._action_status.setText(f"✓ Indexed: {title[:50]}")
            self._action_status.setStyleSheet(f"color: {_GREEN}; font-size: 11px;")
            self._remove_card(result_id)

        elif status == "added":
            if card:
                card.set_status("✓ Added to chat context")
            self._action_status.setText(f"✓ Parsed into chat: {title[:50]}")
            self._action_status.setStyleSheet(f"color: {_GREEN}; font-size: 11px;")
            # Re-enable buttons so user can act on another card
            if self._selected_card and self._selected_card is card:
                self._set_action_buttons_enabled(True)

        elif status == "procIndex_unavailable":
            if card:
                card.set_status("✗ procIndex offline", color=_RED)
            self._action_status.setText("✗ procIndex not connected")
            self._action_status.setStyleSheet(f"color: {_RED}; font-size: 11px;")
            self._set_action_buttons_enabled(True)

    def clear(self):
        """Remove all cards and reset state."""
        for card in list(self._cards.values()):
            self._card_layout.removeWidget(card)
            card.deleteLater()
        self._cards.clear()
        self._selected_card = None
        self._set_action_buttons_enabled(False)
        self._empty_lbl.setVisible(True)
        self._header_lbl.setText("Research Results")
        self._sub_lbl.setText("Select Gather Research mode and send a message")
        self._action_status.setText("")

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _on_card_selected(self, card: _ResultCard):
        """Highlight the clicked card and enable action buttons."""
        if self._selected_card is card:
            # Toggle off on second click
            card.set_selected(False)
            self._selected_card = None
            self._set_action_buttons_enabled(False)
            self._action_status.setText("")
            return

        self._deselect_all()
        card.set_selected(True)
        self._selected_card = card
        self._set_action_buttons_enabled(True)
        title = card.result.get("title", "")
        self._action_status.setText(f"Selected: {title[:60]}")
        self._action_status.setStyleSheet(f"color: {_ACCENT}; font-size: 11px;")

    def _deselect_all(self):
        for c in self._cards.values():
            c.set_selected(False)
        self._selected_card = None
        self._set_action_buttons_enabled(False)

    def _on_index(self):
        if not self._selected_card or not self._ws_client:
            return
        r = self._selected_card.result
        self._ws_client.send_research_action(
            "index",
            self._chat_name,
            r.get("resultId", ""),
            r.get("url", ""),
            r.get("title", ""),
            r.get("snippet", r.get("content", "")),
            self._provider,
            self._model,
        )
        self._action_status.setText("Indexing…")
        self._action_status.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")
        self._set_action_buttons_enabled(False)

    def _on_parse(self):
        if not self._selected_card or not self._ws_client:
            return
        r = self._selected_card.result
        self._ws_client.send_research_action(
            "parse",
            self._chat_name,
            r.get("resultId", ""),
            r.get("url", ""),
            r.get("title", ""),
            r.get("snippet", r.get("content", "")),
            self._provider,
            self._model,
        )
        self._action_status.setText("Parsing…")
        self._action_status.setStyleSheet(f"color: {_FG_DIM}; font-size: 11px;")
        self._set_action_buttons_enabled(False)

    def _on_dismiss(self):
        if not self._selected_card:
            return
        r = self._selected_card.result
        result_id = r.get("resultId", r.get("url", ""))
        self._remove_card(result_id)
        self._action_status.setText("")

    def _remove_card(self, result_id: str):
        card = self._cards.pop(result_id, None)
        if card:
            if self._selected_card is card:
                self._selected_card = None
                self._set_action_buttons_enabled(False)
            self._card_layout.removeWidget(card)
            card.deleteLater()
        self._empty_lbl.setVisible(len(self._cards) == 0)
