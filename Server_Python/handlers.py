"""
procMessenger — Python Message Handlers

Runtime functionality for handling incoming messages.
This file is imported by client.py to process messages received from the server.
"""

import os
import json
import base64
import subprocess
import logging
from datetime import datetime, timezone

import config

logger = logging.getLogger("procMessenger.handlers")

# ---------------------------------------------------------------------------
# File Transfer Helpers
# ---------------------------------------------------------------------------

TRANSFERS_DIR = config.TRANSFERS_DIR
META_FILE = os.path.join(TRANSFERS_DIR, "metadata.json")


def _ensure_transfers_dir():
    os.makedirs(TRANSFERS_DIR, exist_ok=True)


def _load_meta():
    _ensure_transfers_dir()
    if not os.path.isfile(META_FILE):
        return []
    try:
        with open(META_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_meta(records):
    _ensure_transfers_dir()
    with open(META_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)


def _upsert_meta(record):
    records = _load_meta()
    idx = next((i for i, r in enumerate(records) if r.get("fileId") == record.get("fileId")), -1)
    if idx >= 0:
        records[idx] = {**records[idx], **record}
    else:
        records.append(record)
    _save_meta(records)
    return record


def get_file_list():
    """Return all metadata records, newest first."""
    records = _load_meta()
    return sorted(records, key=lambda r: r.get("sentAt", ""), reverse=True)


def receive_file_chunk(payload):
    """
    Accept one chunk of an incoming file transfer.
    Returns (done, record_or_None).
    """
    _ensure_transfers_dir()

    file_id = payload.get("fileId", "")
    file_name = payload.get("fileName", "unnamed")
    file_type = payload.get("fileType", "application/octet-stream")
    file_size = payload.get("fileSize", 0)
    chunk_index = payload.get("chunkIndex", 0)
    total_chunks = payload.get("totalChunks", 1)
    data_b64 = payload.get("data", "")
    source = payload.get("source", "unknown")
    target = payload.get("target", "unknown")
    sent_at = payload.get("sentAt", datetime.now(timezone.utc).isoformat())

    # Sanitise filename
    safe_name = os.path.basename(file_name)
    safe_name = "".join(c if (c.isalnum() or c in "._- ") else "_" for c in safe_name)

    chunk_dir = os.path.join(TRANSFERS_DIR, f".chunks_{file_id}")
    os.makedirs(chunk_dir, exist_ok=True)

    chunk_path = os.path.join(chunk_dir, str(chunk_index).zfill(8))
    with open(chunk_path, "wb") as f:
        f.write(base64.b64decode(data_b64))

    written = len(os.listdir(chunk_dir))
    if written < total_chunks:
        return False, None

    # Reassemble
    dest_path = os.path.join(TRANSFERS_DIR, f"{file_id}_{safe_name}")
    chunk_files = sorted(os.listdir(chunk_dir))
    with open(dest_path, "wb") as out:
        for cf in chunk_files:
            with open(os.path.join(chunk_dir, cf), "rb") as inp:
                out.write(inp.read())

    # Cleanup chunks
    for cf in chunk_files:
        os.unlink(os.path.join(chunk_dir, cf))
    os.rmdir(chunk_dir)

    record = _upsert_meta({
        "fileId": file_id,
        "fileName": safe_name,
        "fileType": file_type,
        "fileSize": file_size,
        "storedPath": dest_path,
        "source": source,
        "target": target,
        "sentAt": sent_at,
        "storedAt": datetime.now(timezone.utc).isoformat(),
        "storedBy": config.CLIENT_NAME,
    })
    return True, record


def read_file_as_chunks(file_id, chunk_size=512 * 1024):
    """
    Read a stored file and return it as base64 chunks.
    Returns (record, chunks) or (None, None).
    """
    records = _load_meta()
    record = next((r for r in records if r.get("fileId") == file_id), None)
    if record is None:
        return None, None

    stored_path = record.get("storedPath", "")

    # Security: ensure path is within TRANSFERS_DIR
    real_transfers = os.path.realpath(TRANSFERS_DIR)
    try:
        real_stored = os.path.realpath(stored_path)
    except Exception:
        return None, None
    if not real_stored.startswith(real_transfers + os.sep):
        return None, None

    if not os.path.isfile(real_stored):
        return None, None

    with open(real_stored, "rb") as f:
        data = f.read()

    total_chunks = max(1, (len(data) + chunk_size - 1) // chunk_size)
    chunks = []
    for i in range(total_chunks):
        chunk_data = data[i * chunk_size: (i + 1) * chunk_size]
        chunks.append({
            "chunkIndex": i,
            "totalChunks": total_chunks,
            "data": base64.b64encode(chunk_data).decode("ascii"),
        })
    return record, chunks


def get_available_scripts():
    """Scan the scripts directory and return a list of available scripts."""
    scripts = []
    scripts_dir = os.path.abspath(config.SCRIPTS_DIR)

    if not os.path.isdir(scripts_dir):
        os.makedirs(scripts_dir, exist_ok=True)
        return scripts

    for filename in os.listdir(scripts_dir):
        filepath = os.path.join(scripts_dir, filename)
        if os.path.isfile(filepath):
            scripts.append({
                "name": filename,
                "description": f"Script: {filename}",
            })
    return scripts


def execute_script(script_name, args=None):
    """
    Execute a script by name from the scripts directory.
    Returns dict with exitCode, stdout, stderr.
    """
    scripts_dir = os.path.abspath(config.SCRIPTS_DIR)
    script_path = os.path.join(scripts_dir, script_name)

    # Security: ensure the script is within the scripts directory
    real_scripts_dir = os.path.realpath(scripts_dir)
    real_script_path = os.path.realpath(script_path)
    if not real_script_path.startswith(real_scripts_dir + os.sep):
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": "Security error: path traversal detected.",
        }

    if not os.path.isfile(real_script_path):
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": f"Script not found: {script_name}",
        }

    cmd = [real_script_path]
    if args:
        # Only allow string arguments
        cmd.extend(str(a) for a in args)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=real_scripts_dir,
        )
        return {
            "exitCode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": "Script execution timed out (120s limit).",
        }
    except Exception as e:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": str(e),
        }


def handle_run_script(payload):
    """
    Handle a run_script message.
    Returns a response payload dict.
    """
    action = payload.get("action", "")

    if action == "list_scripts":
        scripts = get_available_scripts()
        return {
            "action": "script_list",
            "scripts": scripts,
        }

    if action == "execute":
        script_name = payload.get("scriptName", "")
        args = payload.get("args", [])
        if not script_name:
            return {
                "action": "result",
                "scriptName": "",
                "exitCode": -1,
                "stdout": "",
                "stderr": "No scriptName provided.",
            }
        result = execute_script(script_name, args)
        return {
            "action": "result",
            "scriptName": script_name,
            **result,
        }

    return {
        "action": "error",
        "message": f"Unknown run_script action: {action}",
    }


def handle_edit_story(payload):
    """
    Handle an edit_story message.
    This is a passthrough — the message content is forwarded to the story editor.
    Override this function to integrate with your story editor program.
    """
    message = payload.get("message", "")
    logger.info(f"Edit Story request: {message}")

    # Placeholder: echo back the message
    return {
        "message": f"[Story Editor] Received: {message}",
        "status": "received",
    }


def handle_file_list():
    """Return payload for a file_list response."""
    return {"files": get_file_list()}


def handle_file_receive(payload):
    """Handle one incoming chunk. Returns (response_type, response_payload)."""
    done, record = receive_file_chunk(payload)
    if not done:
        return "file_receive_progress", {
            "fileId": payload.get("fileId"),
            "chunkIndex": payload.get("chunkIndex"),
            "totalChunks": payload.get("totalChunks"),
        }
    logger.info(f"[TRANSFER] Saved: {record['fileId']} — {record['fileName']}")
    return "file_receive_complete", {
        "fileId": record["fileId"],
        "fileName": record["fileName"],
        "fileSize": record["fileSize"],
        "fileType": record["fileType"],
        "source": record["source"],
        "target": record["target"],
        "sentAt": record["sentAt"],
    }


def handle_file_fetch(payload):
    """
    Return the file as a series of file_transfer_data chunk messages.
    Returns a list of (type, payload) tuples.
    """
    file_id = payload.get("fileId", "")
    if not file_id:
        return [("error", {"code": "MISSING_FILE_ID", "message": "fileId required."})]

    record, chunks = read_file_as_chunks(file_id)
    if record is None:
        return [("error", {"code": "FILE_NOT_FOUND", "message": f"File {file_id} not found."})]

    result = []
    for c in chunks:
        result.append(("file_transfer_data", {
            "fileId": record["fileId"],
            "fileName": record["fileName"],
            "fileType": record["fileType"],
            "fileSize": record["fileSize"],
            "sentAt": record.get("sentAt", ""),
            "source": record.get("source", ""),
            "target": record.get("target", ""),
            "chunkIndex": c["chunkIndex"],
            "totalChunks": c["totalChunks"],
            "data": c["data"],
        }))
    return result


def handle_message(msg):
    """
    Main dispatcher — routes a parsed message to the appropriate handler.
    Returns a response payload, or None if no response is needed.
    For file_fetch returns ("__multi__", list_of_(type, payload)).
    """
    msg_type = msg.get("type", "")
    payload = msg.get("payload", {})

    if msg_type == "run_script":
        return "run_script", handle_run_script(payload)

    if msg_type == "edit_story":
        return "edit_story", handle_edit_story(payload)

    if msg_type == "gather_research":
        logger.info(f"Gather Research request: {payload.get('query', '')}")
        return "gather_research", {
            "status": "unsupported",
            "message": "Gather Research is not yet implemented on this Python client.",
        }

    if msg_type == "file_list":
        return "file_list", handle_file_list()

    if msg_type == "file_receive":
        return handle_file_receive(payload)

    if msg_type == "file_fetch":
        return "__multi__", handle_file_fetch(payload)

    return None, None
