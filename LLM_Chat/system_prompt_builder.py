"""
procMessenger – System Prompt Builder

Assembles the final system prompt for an LLM call by merging:
  1. The base persona file  (System.md or a custom file from SYSTEM_PROMPTS)
  2. An optional injected context string  (e.g. topic data provided by the caller)
  3. A mode-specific chunk file  (if one exists for the given mode)
  4. A mode-specific inline suffix  (fallback when no chunk file is present)

Adding support for a new mode is as simple as dropping a
``System_<mode_name>.md`` file into the LLM_Chat directory and registering
its path in ``_MODE_CHUNK_FILES``.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import config

logger = logging.getLogger("procMessenger.llm.prompt_builder")


# ---------------------------------------------------------------------------
# Mode chunk files
# ---------------------------------------------------------------------------

# Loaded from config so paths stay in one place.
_MODE_CHUNK_FILES: dict[str, str] = config.MODE_CHUNK_FILES


# ---------------------------------------------------------------------------
# Inline mode suffixes (used only when no chunk file exists for the mode)
# ---------------------------------------------------------------------------

_MODE_SUFFIXES: dict[str, str] = {
    "ask":   "\n\nYou are in Ask mode. Respond to the user's question.",
    "agent": (
        "\n\nYou are in Agent mode. You may describe actions to take "
        "and incorporate tool outputs."
    ),
    "plan":  (
        "\n\nYou are in Plan mode. Break down the request into numbered "
        "steps before responding, try to find inconsistencies or gaps in "
        "data to advise the user."
    ),
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_file(path: str) -> str:
    """Read a prompt file, returning an empty string on any failure."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        logger.warning("Prompt file not found: %s", path)
        return ""
    except OSError as exc:
        logger.error("Failed to read prompt file %s: %s", path, exc)
        return ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_system_prompt(
    mode: str,
    system_prompt_key: Optional[str] = None,
    injected_prompt: str = "",
) -> str:
    """
    Build the full system prompt for a single LLM call.

    Assembly order
    --------------
    1. Base prompt  – from ``config.SYSTEM_PROMPTS[system_prompt_key]``
       (falls back to ``config.SYSTEM_PROMPT_FILE`` / default text).
    2. Injected context  – topics or web research pre-built by the caller.
    3. Mode chunk file  – loaded from ``_MODE_CHUNK_FILES[mode]`` if present.
    4. Mode inline suffix  – from ``_MODE_SUFFIXES[mode]`` when no file exists.

    Parameters
    ----------
    mode              : LLM mode string (e.g. ``"ask"``, ``"gather_research"``).
    system_prompt_key : Key into ``config.SYSTEM_PROMPTS``; uses the default
                        prompt file when ``None`` or not found.
    injected_prompt   : Additional context string (already formatted by caller).

    Returns
    -------
    str  – the complete, assembled system prompt.
    """
    # 1. Base prompt
    path = config.SYSTEM_PROMPT_FILE
    if system_prompt_key and system_prompt_key in config.SYSTEM_PROMPTS:
        path = config.SYSTEM_PROMPTS[system_prompt_key]

    base = _load_file(path) or config.SYSTEM_PROMPT_FALLBACK
    parts: list[str] = [base]

    # 2. Injected context
    injected = injected_prompt.strip() if injected_prompt else ""
    if injected:
        parts.append(injected)

    # 3. Mode chunk file (takes priority over inline suffix)
    if mode in _MODE_CHUNK_FILES:
        chunk = _load_file(_MODE_CHUNK_FILES[mode])
        if chunk:
            parts.append(chunk)
    elif mode in _MODE_SUFFIXES:
        # 4. Inline suffix fallback
        suffix = _MODE_SUFFIXES[mode].strip()
        if suffix:
            parts.append(suffix)

    return "\n\n".join(parts)
