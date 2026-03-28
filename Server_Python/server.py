"""
procMessenger - Python WebSocket Server

Handles client registration, message routing, and client registry.
This file contains ONLY server logic. Runtime/message handling is in handlers.py.
"""

import asyncio
import json
import uuid
import logging
from datetime import datetime, timezone

import os
import sys

import websockets

import config
import handlers as _handlers

# Import Tailscale utility from workspace root (one level up)
_workspace_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _workspace_root not in sys.path:
    sys.path.insert(0, _workspace_root)
try:
    import tailscale_vpn as _tailscale
except ImportError:
    _tailscale = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("procMessenger.server")

# Registry of connected clients
# Key: websocket, Value: client info dict
clients = {}

# Nickname overrides (clientName -> nickname)
nicknames = {}

# Aggregated file list from all clients that advertise file_transfers capability
# Key: clientName, Value: list of file metadata records
client_file_lists = {}


def get_aggregated_file_list():
    """Build the aggregated file list across all connected clients, newest first.

    Deduplicates by fileId: when multiple clients announce the same fileId
    (e.g. both 'server' and 'python-client' read the same metadata.json),
    the entry from the client whose name matches ownerClient is kept.
    """
    seen = {}  # fileId -> record
    for client_name, files in client_file_lists.items():
        for f in files:
            owner = f.get("ownerClient") or client_name
            entry = {**f, "ownerClient": owner}
            existing = seen.get(f.get("fileId"))
            if existing is None or client_name == owner:
                seen[f.get("fileId")] = entry
    all_files = list(seen.values())
    all_files.sort(key=lambda r: r.get("sentAt", ""), reverse=True)
    return all_files


def build_message(msg_type, source, target, payload, flags=None):
    """Build a protocol-compliant message envelope."""
    return json.dumps({
        "id": str(uuid.uuid4()),
        "type": msg_type,
        "source": source,
        "target": target,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "flags": flags or {},
        "payload": payload,
    })


def get_client_list():
    """Build the current client list payload."""
    client_entries = []
    for ws, info in clients.items():
        entry = {
            "name": info["name"],
            "clientType": info["clientType"],
            "capabilities": info["capabilities"],
            "hostname": info.get("hostname", ""),
            "nickname": nicknames.get(info["name"], info.get("nickname", "")),
            "connectedAt": info["connectedAt"],
        }
        client_entries.append(entry)
    return client_entries


async def broadcast_client_list():
    """Send updated client list to all connected clients."""
    msg = build_message("client_list", "server", "all", {
        "clients": get_client_list()
    })
    await broadcast(msg)


async def broadcast(message, exclude=None):
    """Send a message to all connected clients, optionally excluding one."""
    tasks = []
    for ws in clients:
        if ws != exclude:
            tasks.append(ws.send(message))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def send_to(target_name, message):
    """Send a message to a specific client by name."""
    for ws, info in clients.items():
        if info["name"] == target_name:
            try:
                await ws.send(message)
            except websockets.ConnectionClosed:
                pass
            return True
    return False


async def route_message(websocket, raw):
    """Parse and route an incoming message."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        error_msg = build_message("error", "server", "unknown", {
            "code": "INVALID_MESSAGE",
            "message": "Failed to parse JSON.",
            "referenceId": "",
        })
        await websocket.send(error_msg)
        return

    msg_type = msg.get("type", "")
    source = msg.get("source", "")
    target = msg.get("target", "")
    payload = msg.get("payload", {})
    flags = msg.get("flags", {})
    msg_id = msg.get("id", "")

    logger.info(f"Message: type={msg_type} source={source} target={target}")

    # Handle registration
    if msg_type == "register":
        name = source if source else f"{payload.get('clientType', 'unknown')}-{str(uuid.uuid4())[:8]}"
        hostname = payload.get("hostname", "")
        client_type = payload.get("clientType", "unknown")

        # Duplicate check: reject if same hostname + clientType is already connected
        if hostname:
            for ws, info in clients.items():
                if info["hostname"] == hostname and info["clientType"] == client_type:
                    error_msg = build_message("error", "server", name, {
                        "code": "DUPLICATE_CLIENT",
                        "message": f"A '{client_type}' client from host '{hostname}' is already connected. Only one instance per type per machine is allowed.",
                        "referenceId": "",
                    })
                    await websocket.send(error_msg)
                    await websocket.close(4001, "Duplicate client")
                    logger.info(f"Rejected duplicate: {name} (hostname={hostname}, type={client_type})")
                    return

        capabilities = payload.get("capabilities", [])
        clients[websocket] = {
            "name": name,
            "clientType": client_type,
            "capabilities": capabilities,
            "hostname": hostname,
            "nickname": payload.get("nickname", ""),
            "connectedAt": datetime.now(timezone.utc).isoformat(),
        }
        logger.info(f"Registered client: {name} (hostname={hostname}, type={client_type})")

        # If the registering client advertises file_transfers and provided a file list, record it.
        if "file_transfers" in capabilities and isinstance(payload.get("fileList"), list):
            client_file_lists[name] = payload["fileList"]
            logger.info(f"[FILES] {name} announced {len(payload['fileList'])} file(s) on register.")

        # Announce the new client to all others
        announce_msg = build_message("client_announce", "server", "all", {
            "action": "joined",
            "client": {"name": name, "clientType": client_type, "hostname": hostname},
        })
        await broadcast(announce_msg, exclude=websocket)

        await broadcast_client_list()
        return

    # Handle nickname setting
    if msg_type == "nickname":
        client_name = payload.get("clientName", "")
        nickname = payload.get("nickname", "")
        if client_name:
            nicknames[client_name] = nickname
            logger.info(f"Nickname set: {client_name} -> {nickname}")
            await broadcast_client_list()
        return

    # Handle pong
    if msg_type == "pong":
        return

    # A client is announcing its local file list (sent after registration or after a new file is saved).
    if msg_type == "file_list_announce":
        files = payload.get("files", [])
        client_file_lists[source] = files
        logger.info(f"[FILES] {source} updated file list: {len(files)} file(s).")
        agg_msg = build_message("file_list", "server", "all", {
            "files": get_aggregated_file_list(),
        })
        await broadcast(agg_msg)
        return

    # Mobile requesting the aggregated file list from the server directly.
    if msg_type == "file_list" and target == "server":
        reply = build_message("file_list", "server", source, {
            "files": get_aggregated_file_list(),
        })
        await websocket.send(reply)
        return

    # Mobile requesting a file from a specific owner client.
    if msg_type == "file_fetch" and target == "server":
        owner_client = payload.get("ownerClient", "")
        if not owner_client:
            err_msg = build_message("error", "server", source, {
                "code": "MISSING_OWNER",
                "message": "file_fetch requires ownerClient in payload.",
                "referenceId": msg_id,
            })
            await websocket.send(err_msg)
            return

        # If the file is owned by the server itself, serve it directly
        if owner_client == "server":
            record, chunks = _handlers.read_file_as_chunks(payload.get("fileId", ""))
            if record is None:
                err_msg = build_message("error", "server", source, {
                    "code": "FILE_NOT_FOUND",
                    "message": f"File '{payload.get('fileId', '')}' not found on server.",
                    "referenceId": msg_id,
                })
                await websocket.send(err_msg)
                return
            for c in chunks:
                chunk_msg = build_message("file_transfer_data", "server", source, {
                    "fileId": record["fileId"],
                    "fileName": record["fileName"],
                    "fileType": record["fileType"],
                    "fileSize": record["fileSize"],
                    "sentAt": record.get("sentAt", ""),
                    "source": record.get("source", ""),
                    "target": source,
                    "chunkIndex": c["chunkIndex"],
                    "totalChunks": c["totalChunks"],
                    "data": c["data"],
                })
                await websocket.send(chunk_msg)
            return

        forward = build_message("file_fetch", "server", owner_client, {
            **payload,
            "requestedBy": source,
        })
        delivered = await send_to(owner_client, forward)
        if not delivered:
            err_msg = build_message("error", "server", source, {
                "code": "OWNER_NOT_CONNECTED",
                "message": f"File owner '{owner_client}' is not connected.",
                "referenceId": msg_id,
            })
            await websocket.send(err_msg)
        return

    # Mobile uploading a file to be stored directly on the server
    if msg_type == "file_upload" and target == "server":
        done, record = _handlers.receive_file_chunk({**payload, "source": source, "target": "server"})
        if done:
            client_file_lists["server"] = _handlers.get_file_list()
            agg_msg = build_message("file_list", "server", "all", {
                "files": get_aggregated_file_list(),
            })
            await broadcast(agg_msg)
            reply = build_message("file_receive_complete", "server", source, {
                "fileId": record["fileId"],
                "fileName": record["fileName"],
                "fileSize": record["fileSize"],
                "fileType": record["fileType"],
                "source": source,
                "target": "server",
                "sentAt": record["sentAt"],
            })
            await websocket.send(reply)
        return

    # Handle file_delete: serve server-owned files inline; relay others to ownerClient.
    if msg_type == "file_delete" and target == "server":
        owner_client = payload.get("ownerClient", "")
        if not owner_client:
            await websocket.send(build_message("error", "server", source, {
                "code": "MISSING_OWNER",
                "message": "file_delete requires ownerClient in payload.",
            }))
            return
        if owner_client == "server":
            response_type, response_payload = _handlers.handle_file_delete(payload)
            if response_payload.get("deleted"):
                client_file_lists["server"] = _handlers.get_file_list()
                await broadcast(build_message("file_list", "server", "all", {
                    "files": get_aggregated_file_list()
                }))
            await websocket.send(build_message(response_type, "server", source, response_payload))
            return
        forward = build_message("file_delete", "server", owner_client, {
            **payload, "requestedBy": source,
        })
        delivered = await send_to(owner_client, forward)
        if not delivered:
            await websocket.send(build_message("error", "server", source, {
                "code": "OWNER_NOT_CONNECTED",
                "message": f"File owner '{owner_client}' is not connected.",
            }))
        return

    # Consolidated "known data" request
    if msg_type == "server_known_data" and target == "server":
        reply = build_message("server_known_data", "server", source, {
            "files": get_aggregated_file_list(),
            "topics": _handlers.load_topics(),
        })
        await websocket.send(reply)
        return

    # Handle new topic creation
    if msg_type == "topic_create" and target == "server":
        topics = _handlers.load_topics()
        new_topic = {
            "id": str(uuid.uuid4()),
            "name": payload.get("name", "Untitled Topic"),
            "info": payload.get("info", ""),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        topics.append(new_topic)
        _handlers.save_topics(topics)
        announce_msg = build_message("topics", "server", "all", {"topics": topics})
        await broadcast(announce_msg)
        return

    # Handle topic update
    if msg_type == "topic_update" and target == "server":
        topics = _handlers.load_topics()
        topic_id = payload.get("id", "")
        idx = next((i for i, t in enumerate(topics) if t.get("id") == topic_id), -1)
        if idx == -1:
            await websocket.send(build_message("error", "server", source, {
                "code": "TOPIC_NOT_FOUND",
                "message": f"Topic with id '{topic_id}' not found.",
            }))
            return
        topics[idx]["name"] = payload.get("name", topics[idx]["name"])
        topics[idx]["info"] = payload.get("info", topics[idx]["info"])
        topics[idx]["updatedAt"] = datetime.now(timezone.utc).isoformat()
        _handlers.save_topics(topics)
        announce_msg = build_message("topics", "server", "all", {"topics": topics})
        await broadcast(announce_msg)
        return

    # Two-way topic sync: mobile sends its local list, server merges by newest updatedAt/createdAt
    if msg_type == "topic_sync" and target == "server":
        def _topic_time(t):
            ts = t.get("updatedAt") or t.get("createdAt") or ""
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            except Exception:
                return 0.0
        server_list = _handlers.load_topics()
        client_list = payload.get("topics", [])
        if not isinstance(client_list, list):
            client_list = []
        merged = {t["id"]: t for t in server_list if t.get("id")}
        for t in client_list:
            tid = t.get("id", "")
            if tid and (tid not in merged or _topic_time(t) > _topic_time(merged[tid])):
                merged[tid] = t
        merged_list = list(merged.values())
        _handlers.save_topics(merged_list)
        await websocket.send(build_message("topic_sync_result", "server", source, {"topics": merged_list}))
        await broadcast(build_message("topics", "server", "all", {"topics": merged_list}), exclude=websocket)
        return

    # Handle ack flag
    if flags.get("ack"):
        ack_msg = build_message("ack", "server", source, {
            "referenceId": msg_id,
            "status": "delivered" if target != "all" else "broadcast",
        })
        await websocket.send(ack_msg)

    # Route to target
    if target == "all" or flags.get("broadcast"):
        # Broadcast to everyone except sender
        await broadcast(raw, exclude=websocket)
    else:
        # Send to specific target
        delivered = await send_to(target, raw)
        if not delivered:
            error_msg = build_message("error", "server", source, {
                "code": "TARGET_NOT_FOUND",
                "message": f"Client '{target}' is not connected.",
                "referenceId": msg_id,
            })
            await websocket.send(error_msg)


async def handle_connection(websocket):
    """Handle a single WebSocket connection lifecycle."""
    client_name = "unregistered"
    try:
        async for message in websocket:
            await route_message(websocket, message)
            # Update client_name for logging
            if websocket in clients:
                client_name = clients[websocket]["name"]
    except websockets.ConnectionClosed as e:
        logger.info(f"Connection closed: {client_name} (code={e.code})")
    finally:
        if websocket in clients:
            client_name = clients[websocket]["name"]
            info = clients[websocket]

            # Announce departure before removing from registry
            announce_msg = build_message("client_announce", "server", "all", {
                "action": "left",
                "client": {
                    "name": info["name"],
                    "clientType": info["clientType"],
                    "hostname": info.get("hostname", ""),
                },
            })
            del clients[websocket]
            # Remove file list for this client so aggregate stays accurate
            client_file_lists.pop(client_name, None)
            logger.info(f"Unregistered client: {client_name}")
            await broadcast(announce_msg)
            await broadcast_client_list()
            # Broadcast updated aggregate file list
            agg_msg = build_message("file_list", "server", "all", {
                "files": get_aggregated_file_list(),
            })
            await broadcast(agg_msg)


async def start_server():
    """Start the WebSocket server."""
    logger.info(f"Starting procMessenger server on ws://{config.HOST}:{config.PORT}")
    async with websockets.serve(
        handle_connection,
        config.HOST,
        config.PORT,
        ping_interval=config.PING_INTERVAL,
        ping_timeout=config.PING_TIMEOUT,
    ):
        logger.info("Server is running. Press Ctrl+C to stop.")
        logger.info("Available connection addresses:")
        if _tailscale is not None:
            _tailscale.log_connection_info(config.PORT, logger)
        else:
            logger.info(f"  Local:     ws://127.0.0.1:{config.PORT}")
            logger.info("  Tailscale: unavailable (tailscale_vpn.py not found)")
        await asyncio.Future()  # Run forever


def main():
    try:
        asyncio.run(start_server())
    except KeyboardInterrupt:
        logger.info("Server stopped.")


if __name__ == "__main__":
    main()
