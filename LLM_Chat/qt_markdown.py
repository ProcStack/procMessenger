"""
procMessenger – Markdown → HTML renderer (minimal, dependency-free)

Converts the subset of Markdown used in LLM responses to HTML suitable for
QLabel (which renders a limited HTML4/CSS2 subset via Qt's rich text engine).

Handles:
  - **bold**  / __bold__
  - *italic* / _italic_
  - `inline code`
  - ``` fenced code blocks ```
  - # / ## / ### headings
  - - / * bullet lists
  - [text](url) links
  - Paragraph breaks (double newline)
"""

from __future__ import annotations

import html
import re


def render_markdown(text: str) -> str:
    """Convert Markdown text to an HTML string safe for QLabel."""
    if not text:
        return ""

    # 1. Escape HTML entities first (we will reintroduce safe tags below)
    lines = text.split("\n")
    out_lines: list[str] = []
    in_code_block = False
    code_buf: list[str] = []

    for line in lines:
        # ── Fenced code blocks ────────────────────────────────────────────────
        if line.startswith("```"):
            if not in_code_block:
                in_code_block = True
                code_buf = []
            else:
                in_code_block = False
                code_html = html.escape("\n".join(code_buf))
                out_lines.append(
                    f'<pre style="background:#1e1e2e;color:#a6e3a1;'
                    f'font-family:monospace;padding:6px;border-radius:4px;'
                    f'white-space:pre-wrap;">{code_html}</pre>'
                )
            continue

        if in_code_block:
            code_buf.append(line)
            continue

        escaped = html.escape(line)

        # ── Headings ──────────────────────────────────────────────────────────
        h3 = re.match(r"^#{3}\s+(.*)", escaped)
        h2 = re.match(r"^#{2}\s+(.*)", escaped)
        h1 = re.match(r"^#\s+(.*)", escaped)
        if h1:
            escaped = f"<h3 style='color:#89b4fa;margin:4px 0;'>{h1.group(1)}</h3>"
        elif h2:
            escaped = f"<h4 style='color:#89b4fa;margin:4px 0;'>{h2.group(1)}</h4>"
        elif h3:
            escaped = f"<h5 style='color:#89b4fa;margin:4px 0;'>{h3.group(1)}</h5>"
        else:
            # ── Bullet lists ──────────────────────────────────────────────────
            bullet = re.match(r"^[\-\*]\s+(.*)", escaped)
            if bullet:
                escaped = f"&nbsp;&nbsp;• {bullet.group(1)}"

        out_lines.append(escaped)

    result = "<br>".join(out_lines)

    # ── Inline code ───────────────────────────────────────────────────────────
    result = re.sub(
        r"`([^`]+)`",
        r'<code style="background:#313244;color:#f38ba8;'
        r'font-family:monospace;padding:1px 4px;border-radius:3px;">\1</code>',
        result,
    )

    # ── Bold ─────────────────────────────────────────────────────────────────
    result = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", result)
    result = re.sub(r"__(.+?)__", r"<b>\1</b>", result)

    # ── Italic ────────────────────────────────────────────────────────────────
    result = re.sub(r"\*(.+?)\*", r"<i>\1</i>", result)
    result = re.sub(r"_(.+?)_", r"<i>\1</i>", result)

    # ── Links ─────────────────────────────────────────────────────────────────
    result = re.sub(
        r"\[([^\]]+)\]\((https?://[^\)]+)\)",
        r'<a href="\2" style="color:#89b4fa;">\1</a>',
        result,
    )

    return result
