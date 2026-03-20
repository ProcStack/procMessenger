"""
procMessenger - Attachment Handler

Handles receiving chunked file transfers over WebSocket and saving them to disk.
Also handles preparing files for sending (chunking outbound).

WebSocket Frame Size Notes:
- Python `websockets` library: default max 1 MB per frame (configurable via max_size)
- Node.js `ws` library: default max 100 MB (configurable via maxPayload)
- Android WebView WebSocket: browser-dependent, typically ~16 MB
- We use 512 KB chunks for safe universal compatibility.
- Max total file size: 50 MB (configurable in config.py)
"""

import os
import base64
import uuid
import logging
import json

import config

logger = logging.getLogger("procMessenger.llm.attachments")

# In-progress transfers: transferId -> { filename, chunks: {index: data}, totalChunks, ... }
_pending_transfers = {}


def ensure_attachments_dir():
    """Create attachments directory if it doesn't exist."""
    os.makedirs(config.ATTACHMENTS_DIR, exist_ok=True)


def prepare_file_for_send(filepath):
    """
    Read a file and split into base64-encoded chunks for WebSocket transfer.

    Returns a list of chunk messages (dicts), or None if file too large / not found.
    Each chunk dict has: transferId, filename, chunkIndex, totalChunks, data, fileSize.
    """
    if not os.path.isfile(filepath):
        logger.error(f"File not found: {filepath}")
        return None

    file_size = os.path.getsize(filepath)
    if file_size > config.MAX_ATTACHMENT_SIZE:
        logger.error(f"File too large: {file_size} bytes (max {config.MAX_ATTACHMENT_SIZE})")
        return None

    filename = os.path.basename(filepath)
    transfer_id = str(uuid.uuid4())

    with open(filepath, "rb") as f:
        raw = f.read()

    encoded = base64.b64encode(raw).decode("ascii")
    chunk_size = config.CHUNK_SIZE
    # Chunk the base64 string
    chunks = [encoded[i:i + chunk_size] for i in range(0, len(encoded), chunk_size)]

    messages = []
    for i, chunk_data in enumerate(chunks):
        messages.append({
            "transferId": transfer_id,
            "filename": filename,
            "chunkIndex": i,
            "totalChunks": len(chunks),
            "data": chunk_data,
            "fileSize": file_size,
        })

    logger.info(f"Prepared {len(chunks)} chunks for '{filename}' ({file_size} bytes)")
    return messages


def receive_chunk(payload):
    """
    Process an incoming attachment chunk.

    Returns:
        - None if more chunks are needed
        - {"filename": str, "filepath": str, "fileSize": int} when transfer is complete
        - {"error": str} on failure
    """
    transfer_id = payload.get("transferId", "")
    filename = payload.get("filename", "")
    chunk_index = payload.get("chunkIndex", 0)
    total_chunks = payload.get("totalChunks", 1)
    data = payload.get("data", "")
    file_size = payload.get("fileSize", 0)

    if not transfer_id or not filename:
        return {"error": "Missing transferId or filename."}

    # Check total file size before accepting
    if file_size > config.MAX_ATTACHMENT_SIZE:
        return {"error": f"File too large: {file_size} bytes (max {config.MAX_ATTACHMENT_SIZE} bytes)."}

    # Sanitize filename - prevent path traversal
    safe_filename = os.path.basename(filename)
    if not safe_filename or safe_filename.startswith("."):
        return {"error": "Invalid filename."}

    # Initialize transfer tracking
    if transfer_id not in _pending_transfers:
        _pending_transfers[transfer_id] = {
            "filename": safe_filename,
            "totalChunks": total_chunks,
            "fileSize": file_size,
            "chunks": {},
        }

    _pending_transfers[transfer_id]["chunks"][chunk_index] = data
    received = len(_pending_transfers[transfer_id]["chunks"])
    logger.info(f"Chunk {chunk_index + 1}/{total_chunks} for '{safe_filename}' (transfer {transfer_id[:8]})")

    # Check if all chunks received
    if received < total_chunks:
        return None

    # Reassemble file
    transfer = _pending_transfers.pop(transfer_id)
    try:
        full_b64 = "".join(transfer["chunks"][i] for i in range(total_chunks))
        raw_bytes = base64.b64decode(full_b64)
    except Exception as e:
        return {"error": f"Failed to reassemble file: {e}"}

    # Save to attachments directory
    ensure_attachments_dir()
    # Avoid overwriting: add uuid suffix if file exists
    save_path = os.path.join(config.ATTACHMENTS_DIR, safe_filename)
    if os.path.exists(save_path):
        name, ext = os.path.splitext(safe_filename)
        save_path = os.path.join(config.ATTACHMENTS_DIR, f"{name}_{uuid.uuid4().hex[:8]}{ext}")

    with open(save_path, "wb") as f:
        f.write(raw_bytes)

    logger.info(f"Attachment saved: {save_path} ({len(raw_bytes)} bytes)")
    return {
        "filename": safe_filename,
        "filepath": save_path,
        "fileSize": len(raw_bytes),
    }


def check_file_size(filepath):
    """
    Check if a file is within the transfer size limit.
    Returns (ok: bool, size: int, limit: int).
    """
    if not os.path.isfile(filepath):
        return False, 0, config.MAX_ATTACHMENT_SIZE
    size = os.path.getsize(filepath)
    return size <= config.MAX_ATTACHMENT_SIZE, size, config.MAX_ATTACHMENT_SIZE
