"""
procMessenger — LLM Chat Client

Connects to the procMessenger WebSocket server and provides LLM chat functionality.
Announces itself with available LLM providers and modes on join.
Handles: chat messages, chat history, mode listing, provider listing, attachments.
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
from llm_providers import (
    chat_completion, get_available_providers, get_system_prompt, fetch_all_models,
    scan_local_models, download_model,
)
from chat_history import (
    list_chats, create_chat, get_chat, get_chat_messages,
    append_message, delete_chat, extract_images, extract_links,
)
from attachments import receive_chunk, prepare_file_for_send, check_file_size

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("procMessenger.llm.client")


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


def load_modes():
    """Load LLM modes from message_functions.json."""
    try:
        with open(config.MESSAGE_FUNCTIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("modes", [])
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to load message_functions.json: {e}")
        return [
            {"value": "ask", "label": "Ask", "description": "Simple Q&A"},
            {"value": "agent", "label": "Agent", "description": "Agentic mode"},
            {"value": "plan", "label": "Plan", "description": "Planning mode"},
        ]


async def handle_llm_message(ws, msg):
    """
    Handle an incoming message directed at the LLM client.
    Dispatches based on msg type and payload action.
    """
    msg_type = msg.get("type", "")
    source = msg.get("source", "")
    payload = msg.get("payload", {})
    msg_id = msg.get("id", "")
    flags = {"correlationId": msg_id}

    # --- LLM Chat: request available modes ---
    if msg_type == "llm_modes":
        modes = load_modes()
        providers = get_available_providers()
        # Fetch live model lists
        model_map = await fetch_all_models()
        for p in providers:
            p["models"] = model_map.get(p["value"], [])
        reply = build_message("llm_modes", config.CLIENT_NAME, source, {
            "modes": modes,
            "providers": providers,
        }, flags)
        await ws.send(reply)
        return

    # --- LLM Chat: list all chats ---
    if msg_type == "llm_chat_list":
        chats = list_chats()
        reply = build_message("llm_chat_list", config.CLIENT_NAME, source, {
            "chats": chats,
        }, flags)
        await ws.send(reply)
        return

    # --- LLM Chat: get chat history by name ---
    if msg_type == "llm_chat_history":
        chat_name = payload.get("chatName", "")
        if not chat_name:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "INVALID_MESSAGE",
                "message": "chatName is required.",
                "referenceId": msg_id,
            })
            await ws.send(reply)
            return

        messages = get_chat_messages(chat_name)
        if messages is None:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "CHAT_NOT_FOUND",
                "message": f"Chat '{chat_name}' not found.",
                "referenceId": msg_id,
            })
            await ws.send(reply)
            return

        reply = build_message("llm_chat_history", config.CLIENT_NAME, source, {
            "chatName": chat_name,
            "messages": messages,
        }, flags)
        await ws.send(reply)
        return

    # --- LLM Chat: create a new chat ---
    if msg_type == "llm_chat_create":
        chat_name = payload.get("chatName", "")
        provider = payload.get("provider", "llama")
        mode = payload.get("mode", "ask")
        if not chat_name:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "INVALID_MESSAGE",
                "message": "chatName is required.",
                "referenceId": msg_id,
            })
            await ws.send(reply)
            return

        chat_data = create_chat(chat_name, provider=provider, mode=mode)
        reply = build_message("llm_chat_create", config.CLIENT_NAME, source, {
            "chatName": chat_data["name"],
            "provider": chat_data["provider"],
            "mode": chat_data["mode"],
            "createdAt": chat_data["createdAt"],
        }, flags)
        await ws.send(reply)
        return

    # --- LLM Chat: delete a chat ---
    if msg_type == "llm_chat_delete":
        chat_name = payload.get("chatName", "")
        deleted = delete_chat(chat_name)
        reply = build_message("llm_chat_delete", config.CLIENT_NAME, source, {
            "chatName": chat_name,
            "deleted": deleted,
        }, flags)
        await ws.send(reply)
        return

    # --- LLM Chat: send a message and get LLM response ---
    if msg_type == "llm_chat":
        chat_name = payload.get("chatName", "")
        user_message = payload.get("message", "")
        provider = payload.get("provider", "llama")
        mode = payload.get("mode", "ask")
        model = payload.get("model", None)  # Specific model chosen by user

        if not chat_name or not user_message:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "INVALID_MESSAGE",
                "message": "chatName and message are required.",
                "referenceId": msg_id,
            })
            await ws.send(reply)
            return

        # Ensure chat exists
        chat = get_chat(chat_name)
        if chat is None:
            chat = create_chat(chat_name, provider=provider, mode=mode)

        # Save user message
        user_meta = {
            "images": extract_images(user_message),
            "links": extract_links(user_message),
        }
        append_message(chat_name, "user", user_message, metadata=user_meta)

        # Build message history for the LLM
        history = get_chat_messages(chat_name)
        llm_messages = [{"role": m["role"], "content": m["content"]} for m in history]

        # Send "thinking" status
        thinking_reply = build_message("llm_chat", config.CLIENT_NAME, source, {
            "chatName": chat_name,
            "status": "thinking",
            "message": "",
        }, flags)
        await ws.send(thinking_reply)

        # Call the LLM
        try:
            # Build current system prompt including any injected topics
            topics = payload.get("topics", [])
            injected_prompt = ""
            if topics:
                injected_prompt = "\n\nAdditional context for this conversation:\n"
                for t in topics:
                    injected_prompt += f"--- {t['name']} ---\n{t['info']}\n\n"
            
            response_text = await chat_completion(provider, llm_messages, mode=mode, model=model, injected_prompt=injected_prompt)
        except Exception as e:
            logger.error(f"LLM completion error: {e}")
            response_text = f"Error: LLM completion failed — {e}"

        # Save assistant response
        response_meta = {
            "images": extract_images(response_text),
            "links": extract_links(response_text),
        }
        append_message(chat_name, "assistant", response_text, metadata=response_meta)

        # Send response back
        reply = build_message("llm_chat", config.CLIENT_NAME, source, {
            "chatName": chat_name,
            "status": "complete",
            "message": response_text,
            "images": response_meta["images"],
            "links": response_meta["links"],
        }, flags)
        await ws.send(reply)
        return

    # --- Attachment: receive file chunk ---
    if msg_type == "attachment":
        result = receive_chunk(payload)
        if result is None:
            # More chunks needed, send progress ack
            progress_reply = build_message("attachment", config.CLIENT_NAME, source, {
                "status": "receiving",
                "transferId": payload.get("transferId", ""),
                "chunkIndex": payload.get("chunkIndex", 0),
                "totalChunks": payload.get("totalChunks", 1),
            }, flags)
            await ws.send(progress_reply)
        elif "error" in result:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "ATTACHMENT_ERROR",
                "message": result["error"],
                "referenceId": msg_id,
            })
            await ws.send(reply)
        else:
            reply = build_message("attachment", config.CLIENT_NAME, source, {
                "status": "complete",
                "filename": result["filename"],
                "filepath": result["filepath"],
                "fileSize": result["fileSize"],
            }, flags)
            await ws.send(reply)
        return

    logger.warning(f"Unhandled message type: {msg_type}")


async def handle_model_management(ws, msg):
    """
    Handle local-model management messages:
    - llm_local_models: list locally available model files
    - llm_model_download: download a model from a URL
    """
    msg_type = msg.get("type", "")
    source = msg.get("source", "")
    payload = msg.get("payload", {})
    msg_id = msg.get("id", "")
    flags = {"correlationId": msg_id}

    if msg_type == "llm_local_models":
        models = scan_local_models()
        reply = build_message("llm_local_models", config.CLIENT_NAME, source, {
            "models": models,
        }, flags)
        await ws.send(reply)
        return

    if msg_type == "llm_model_download":
        url = payload.get("url", "")
        filename = payload.get("filename", "")
        if not url:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "INVALID_MESSAGE",
                "message": "url is required for model download.",
                "referenceId": msg_id,
            })
            await ws.send(reply)
            return

        # Send progress start
        start_reply = build_message("llm_model_download", config.CLIENT_NAME, source, {
            "status": "downloading",
            "url": url,
            "filename": filename or "",
        }, flags)
        await ws.send(start_reply)

        result = await download_model(url, filename=filename or None)

        if "error" in result:
            reply = build_message("error", config.CLIENT_NAME, source, {
                "code": "DOWNLOAD_ERROR",
                "message": result["error"],
                "referenceId": msg_id,
            })
        else:
            reply = build_message("llm_model_download", config.CLIENT_NAME, source, {
                "status": "complete",
                "filename": result["filename"],
                "filepath": result["filepath"],
                "fileSize": result["fileSize"],
            }, flags)
        await ws.send(reply)
        return


async def client_loop():
    """Main client connection loop."""
    uri = f"ws://{config.SERVER_HOST}:{config.SERVER_PORT}"
    logger.info(f"Connecting to {uri} as '{config.CLIENT_NAME}'...")

    try:
        async with websockets.connect(uri, max_size=config.MAX_ATTACHMENT_SIZE + 1024*1024) as ws:
            # Fetch available models from each provider's API
            logger.info("Fetching available models from providers...")
            model_map = await fetch_all_models()

            # Register with capabilities and announce available LLMs
            providers = get_available_providers()
            for p in providers:
                p["models"] = model_map.get(p["value"], [])
            modes = load_modes()

            total_models = sum(len(p["models"]) for p in providers)
            logger.info(f"Discovered {total_models} model(s) across {len(providers)} provider(s)")

            reg_msg = build_message("register", config.CLIENT_NAME, "server", {
                "clientType": config.CLIENT_TYPE,
                "capabilities": config.CAPABILITIES,
                "hostname": socket.gethostname(),
                "nickname": "LLM Chat",
                "availableProviders": providers,
                "availableModes": modes,
            })
            await ws.send(reg_msg)
            logger.info(f"Registered. Providers: {[p['label'] for p in providers]}")

            # Announce to the room
            announce = build_message("llm_announce", config.CLIENT_NAME, "all", {
                "message": "LLM Chat is online and ready.",
                "providers": providers,
                "modes": modes,
            })
            await ws.send(announce)

            # Listen for messages
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")
                source = msg.get("source", "")

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

                if msg_type in ("error", "ack"):
                    logger.info(f"{msg_type}: {msg.get('payload', {})}")
                    continue

                # Handle all LLM-directed messages
                if msg_type in ("llm_local_models", "llm_model_download"):
                    await handle_model_management(ws, msg)
                else:
                    await handle_llm_message(ws, msg)

    except websockets.ConnectionClosed as e:
        if e.code == 4001:
            logger.error("Duplicate client — this hostname already has an LLM client connected. Exiting.")
            sys.exit(1)
        logger.info(f"Connection closed (code={e.code}). Reconnecting in 5s...")
        await asyncio.sleep(5)
    except ConnectionRefusedError:
        logger.error("Connection refused. Is the server running?")
        await asyncio.sleep(5)


async def main():
    """Run the client with reconnection logic."""
    while True:
        try:
            await client_loop()
        except KeyboardInterrupt:
            logger.info("LLM Chat client stopped.")
            break
        except Exception as e:
            logger.error(f"Unexpected error: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("LLM Chat client stopped.")
