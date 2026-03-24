"""
procMessenger - Python Client

Connects to the procMessenger WebSocket server.
If no server is running, starts one automatically, then connects as a client.
"""

import asyncio
import json
import uuid
import socket
import logging
import sys
from datetime import datetime, timezone

import websockets

import config
from handlers import handle_message, get_file_list

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("procMessenger.client")


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


def is_server_running():
    """Check if a server is already listening on the configured port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(2)
        try:
            s.connect(("127.0.0.1", config.PORT))
            return True
        except (ConnectionRefusedError, TimeoutError, OSError):
            return False


async def start_server_background():
    """Start the server in a background subprocess."""
    logger.info("No server detected. Starting server in background...")
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "server.py",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    # Give the server a moment to start
    await asyncio.sleep(1.5)

    # Verify it started
    if is_server_running():
        logger.info("Server started successfully (background).")
        return proc
    else:
        logger.error("Failed to start server.")
        return None


async def announce_file_list(ws):
    """Send our local file list to the server so it can update the aggregate."""
    files = get_file_list()
    msg = build_message("file_list_announce", config.CLIENT_NAME, "server", {"files": files})
    await ws.send(msg)
    logger.info(f"Announced file list ({len(files)} file(s)).")


async def client_loop():
    """Main client connection loop."""
    uri = f"ws://127.0.0.1:{config.PORT}"
    server_proc = None

    # Check if server is running, start if not
    if not is_server_running():
        server_proc = await start_server_background()
        if server_proc is None:
            logger.error("Cannot connect - server failed to start. Exiting.")
            return

    logger.info(f"Connecting to {uri} as '{config.CLIENT_NAME}'...")

    try:
        async with websockets.connect(uri) as ws:
            # Register with the server - include local file list for immediate aggregation
            reg_msg = build_message("register", config.CLIENT_NAME, "server", {
                "clientType": "python",
                "capabilities": config.CAPABILITIES,
                "hostname": socket.gethostname(),
                "nickname": "",
                "fileList": get_file_list(),
            })
            await ws.send(reg_msg)
            logger.info("Registered with server.")

            # Listen for messages
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Received invalid JSON, ignoring.")
                    continue

                msg_type = msg.get("type", "")
                source = msg.get("source", "")
                payload = msg.get("payload", {})
                logger.info(f"Received: type={msg_type} from={source}")

                # System messages
                if msg_type == "client_list":
                    clients = msg.get("payload", {}).get("clients", [])
                    names = [c["name"] for c in clients]
                    logger.info(f"Connected clients: {names}")
                    continue

                if msg_type == "client_announce":
                    p = msg.get("payload", {})
                    c = p.get("client", {})
                    if p.get("action") == "joined":
                        logger.info(f"[ANNOUNCE] {c.get('name')} ({c.get('clientType')}) from {c.get('hostname')} has connected.")
                    elif p.get("action") == "left":
                        logger.info(f"[ANNOUNCE] {c.get('name')} ({c.get('clientType')}) from {c.get('hostname')} has disconnected.")
                    continue

                if msg_type == "ping":
                    pong = build_message("pong", config.CLIENT_NAME, "server", {})
                    await ws.send(pong)
                    continue

                # file_list broadcast from the server - notification only, no reply needed.
                if msg_type == "file_list" and source == "server":
                    continue

                if msg_type == "error":
                    err_payload = msg.get("payload", {})
                    logger.warning(f"Error from server: {err_payload.get('code')} - {err_payload.get('message')}")
                    if err_payload.get("code") == "DUPLICATE_CLIENT":
                        logger.error("Duplicate client - this hostname already has a client of this type connected. Exiting.")
                        sys.exit(1)
                    continue

                # The server forwarded a file_fetch request from mobile - stream chunks back.
                if msg_type == "file_fetch":
                    requested_by = payload.get("requestedBy", source)
                    response_type, response_payload = handle_message(msg)
                    if response_type == "__multi__" and isinstance(response_payload, list):
                        for (chunk_type, chunk_data) in response_payload:
                            chunk_msg = build_message(
                                chunk_type, config.CLIENT_NAME, requested_by, chunk_data,
                                flags={"correlationId": msg.get("id", "")},
                            )
                            await ws.send(chunk_msg)
                        logger.info(f"Sent file {payload.get('fileId')} to {requested_by}.")
                    elif response_type:
                        err_msg = build_message(response_type, config.CLIENT_NAME, requested_by, response_payload)
                        await ws.send(err_msg)
                    continue

                # Incoming file chunk to be stored here
                if msg_type == "file_receive":
                    response_type, response_payload = handle_message(msg)
                    if response_type and response_payload:
                        reply = build_message(
                            response_type, config.CLIENT_NAME, source, response_payload,
                            flags={"correlationId": msg.get("id", "")},
                        )
                        await ws.send(reply)
                        if response_type == "file_receive_complete":
                            await announce_file_list(ws)
                    continue

                # run_script can block for minutes (e.g. Gradle build).
                # Run it in a thread so the event loop stays live for pings.
                if msg_type == "run_script":
                    response_type, response_payload = await asyncio.to_thread(handle_message, msg)
                    if response_type and response_payload:
                        reply = build_message(
                            response_type, config.CLIENT_NAME, source, response_payload,
                            flags={"correlationId": msg.get("id", "")},
                        )
                        await ws.send(reply)
                        logger.info(f"Sent response: type={response_type} to={source}")
                        if isinstance(response_payload, dict) and response_payload.get("registeredFiles"):
                            await announce_file_list(ws)
                            n = len(response_payload["registeredFiles"])
                            logger.info(f"[SCRIPT] File list announced ({n} new file(s)).")
                    continue

                # file_delete: handle, reply to original requestor, re-announce file list.
                if msg_type == "file_delete":
                    requested_by = payload.get("requestedBy", source)
                    response_type, response_payload = handle_message(msg)
                    if response_type and response_payload:
                        reply = build_message(
                            response_type, config.CLIENT_NAME, requested_by, response_payload,
                            flags={"correlationId": msg.get("id", "")},
                        )
                        await ws.send(reply)
                        if response_payload.get("deleted"):
                            await announce_file_list(ws)
                    continue

                # Handle all other actionable messages
                response_type, response_payload = handle_message(msg)
                if response_type and response_payload:
                    if response_type == "__multi__" and isinstance(response_payload, list):
                        for (r_type, r_data) in response_payload:
                            m = build_message(
                                r_type, config.CLIENT_NAME, source, r_data,
                                flags={"correlationId": msg.get("id", "")},
                            )
                            await ws.send(m)
                    else:
                        reply = build_message(
                            response_type,
                            config.CLIENT_NAME,
                            source,
                            response_payload,
                            flags={"correlationId": msg.get("id", "")},
                        )
                        await ws.send(reply)
                        logger.info(f"Sent response: type={response_type} to={source}")

    except websockets.ConnectionClosed as e:
        if e.code == 4001:
            logger.error("Duplicate client - this hostname already has a client of this type connected. Exiting.")
            sys.exit(1)
        logger.info(f"Connection closed (code={e.code}). Reconnecting in 5s...")
        await asyncio.sleep(5)
    except ConnectionRefusedError:
        logger.error("Connection refused. Is the server running?")
    finally:
        if server_proc:
            server_proc.terminate()


async def main():
    """Run the client with reconnection logic."""
    while True:
        try:
            await client_loop()
        except KeyboardInterrupt:
            logger.info("Client stopped.")
            break
        except Exception as e:
            logger.error(f"Unexpected error: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Client stopped.")

