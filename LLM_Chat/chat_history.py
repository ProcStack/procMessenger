"""
procMessenger — Chat History Manager

Persists chat conversations to disk as JSON files.
Each chat is a separate file in the chat_history/ directory.
"""

import os
import json
import re
import logging
from datetime import datetime, timezone

import config

logger = logging.getLogger("procMessenger.llm.chat_history")


def _ensure_dirs():
    """Create chat_history directory if it doesn't exist."""
    os.makedirs(config.CHAT_HISTORY_DIR, exist_ok=True)


def _sanitize_filename(name):
    """Sanitize a chat name into a safe filename."""
    safe = re.sub(r'[^\w\s\-]', '', name).strip()
    safe = re.sub(r'\s+', '_', safe)
    return safe[:100] if safe else "unnamed"


def _chat_filepath(chat_name):
    """Get the file path for a chat by name."""
    return os.path.join(config.CHAT_HISTORY_DIR, _sanitize_filename(chat_name) + ".json")


def list_chats():
    """Return a list of all saved chat names with metadata."""
    _ensure_dirs()
    chats = []
    for filename in sorted(os.listdir(config.CHAT_HISTORY_DIR)):
        if not filename.endswith(".json"):
            continue
        filepath = os.path.join(config.CHAT_HISTORY_DIR, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            chats.append({
                "name": data.get("name", filename.replace(".json", "")),
                "createdAt": data.get("createdAt", ""),
                "updatedAt": data.get("updatedAt", ""),
                "messageCount": len(data.get("messages", [])),
                "provider": data.get("provider", ""),
                "mode": data.get("mode", "ask"),
            })
        except (json.JSONDecodeError, OSError):
            continue
    return chats


def create_chat(chat_name, provider="llama", mode="ask"):
    """Create a new chat with the given name. Returns the chat data."""
    _ensure_dirs()
    now = datetime.now(timezone.utc).isoformat()
    data = {
        "name": chat_name,
        "provider": provider,
        "mode": mode,
        "createdAt": now,
        "updatedAt": now,
        "messages": [],
    }
    filepath = _chat_filepath(chat_name)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    logger.info(f"Created chat: {chat_name}")
    return data


def get_chat(chat_name):
    """Load a chat by name. Returns the full chat data or None."""
    filepath = _chat_filepath(chat_name)
    if not os.path.isfile(filepath):
        return None
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def get_chat_messages(chat_name):
    """Get just the messages for a chat (lightweight). Returns list or None."""
    chat = get_chat(chat_name)
    if chat is None:
        return None
    return chat.get("messages", [])


def append_message(chat_name, role, content, metadata=None):
    """
    Append a message to a chat's history.

    Args:
        chat_name: Name of the chat
        role: "user" or "assistant"
        content: The text content of the message
        metadata: Optional dict with extra info (e.g. images, links found)
    """
    chat = get_chat(chat_name)
    if chat is None:
        chat = create_chat(chat_name)

    msg_entry = {
        "role": role,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # Future expansion: track images and links found in content
    if metadata:
        if "images" in metadata:
            msg_entry["images"] = metadata["images"]
        if "links" in metadata:
            msg_entry["links"] = metadata["links"]
        if "attachments" in metadata:
            msg_entry["attachments"] = metadata["attachments"]

    chat["messages"].append(msg_entry)
    chat["updatedAt"] = datetime.now(timezone.utc).isoformat()

    filepath = _chat_filepath(chat_name)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(chat, f, indent=2, ensure_ascii=False)

    return msg_entry


def delete_chat(chat_name):
    """Delete a chat by name."""
    filepath = _chat_filepath(chat_name)
    if os.path.isfile(filepath):
        os.remove(filepath)
        logger.info(f"Deleted chat: {chat_name}")
        return True
    return False


def extract_images(content):
    """
    Extract Markdown image references from message content.
    Returns list of {"alt": str, "url": str}.

    Placeholder for future expansion — currently just parses Markdown syntax.
    """
    pattern = r'!\[([^\]]*)\]\(([^)]+)\)'
    return [{"alt": m[0], "url": m[1]} for m in re.findall(pattern, content)]


def extract_links(content):
    """
    Extract Markdown link references from message content.
    Returns list of {"text": str, "url": str}.

    Placeholder for future expansion — currently just parses Markdown syntax.
    """
    # Match [text](url) but not ![text](url) (images)
    pattern = r'(?<!!)\[([^\]]+)\]\(([^)]+)\)'
    return [{"text": m[0], "url": m[1]} for m in re.findall(pattern, content)]
