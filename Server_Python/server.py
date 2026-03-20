"""
procMessenger — Python WebSocket Server

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

        clients[websocket] = {
            "name": name,
            "clientType": client_type,
            "capabilities": payload.get("capabilities", []),
            "hostname": hostname,
            "nickname": payload.get("nickname", ""),
            "connectedAt": datetime.now(timezone.utc).isoformat(),
        }
        logger.info(f"Registered client: {name} (hostname={hostname}, type={client_type})")

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
            logger.info(f"Unregistered client: {client_name}")
            await broadcast(announce_msg)
            await broadcast_client_list()


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
