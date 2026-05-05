"""
procMessenger - LLM Chat Client

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
    chat_completion, get_available_providers, get_system_prompt,
    get_available_system_prompts, fetch_all_models,
    scan_local_models, download_model, extract_search_query,
)
from chat_history import (
    list_chats, create_chat, get_chat, get_chat_messages,
    append_message, delete_chat, extract_images, extract_links,
)
from attachments import receive_chunk, prepare_file_for_send, check_file_size
from tavily_search import tavily_search

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("procMessenger.llm.client")

# ---------------------------------------------------------------------------
# Module-level runtime state
# ---------------------------------------------------------------------------

# Tracks all currently connected procMessenger clients (updated from client_list
# and client_announce messages). Maps client name -> client info dict.
_connected_clients: dict = {}


def _find_client_by_type(client_type: str) -> str | None:
    """Return the name of the first connected client whose clientType matches."""
    for name, c in _connected_clients.items():
        if c.get("clientType") == client_type:
            return name
    return None


# Stores web-research snippets that the user has chosen to "parse" into a chat.
# These are injected as context in subsequent LLM calls but are NOT saved to the
# chat's message history.
# Maps chat_name -> list of {url, title, content}
_parsed_web_contexts: dict = {}


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
        system_prompts = get_available_system_prompts()
        reply = build_message("llm_modes", config.CLIENT_NAME, source, {
            "modes": modes,
            "providers": providers,
            "systemPrompts": system_prompts,
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
        system_prompt_key = payload.get("systemPrompt", None)

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

        # --- Gather Research: separate pipeline (Tavily search, not LLM reply) ---
        if mode == "gather_research":
            await _handle_gather_research(
                ws, chat_name, source, flags, provider, model, llm_messages
            )
            return

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

            # Inject any parsed web-research contexts for this chat
            web_ctxs = _parsed_web_contexts.get(chat_name, [])
            if web_ctxs:
                injected_prompt += "\n\nParsed web research (use as background knowledge – do not re-summarise):\n"
                for ctx in web_ctxs:
                    injected_prompt += f"--- {ctx['title']} ({ctx['url']}) ---\n{ctx['content']}\n\n"

            response_text = await chat_completion(provider, llm_messages, mode=mode, model=model, injected_prompt=injected_prompt, system_prompt_key=system_prompt_key)
        except Exception as e:
            logger.error(f"LLM completion error: {e}")
            response_text = f"Error: LLM completion failed - {e}"

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

    # --- Gather Research: action on a search result (index / parse) ---
    if msg_type == "gather_research_action":
        await _handle_gather_research_action(ws, msg)
        return

    # --- Gather Research: direct trigger from mobile function panel ---
    # The mobile app sends type "gather_research" with {query, maxResults, chatName?}
    # when the LLM client is the selected target. We run the full pipeline.
    if msg_type == "gather_research":
        query = payload.get("query", "").strip()
        chat_name = payload.get("chatName", "")
        # Use the first enabled provider — prefer whatever is actually configured
        _default_provider = next(
            (k for k, v in config.LLM_PROVIDERS.items() if v.get("enabled")),
            "llama",
        )
        provider = payload.get("provider", _default_provider)
        model = payload.get("model", None)
        if not query:
            await ws.send(build_message("error", config.CLIENT_NAME, source, {
                "code": "INVALID_MESSAGE",
                "message": "query is required for gather_research.",
                "referenceId": msg_id,
            }))
            return
        # Ensure a chat exists to anchor the results
        if not chat_name:
            chat_name = query[:40].replace("/", " ").strip() or "Research"
        chat = get_chat(chat_name)
        if chat is None:
            chat = create_chat(chat_name, provider=provider, mode="gather_research")
        # Treat the query as a user message so it appears in the chat
        append_message(chat_name, "user", query)
        # Pass the query directly — no need to ask the LLM to reformulate it
        await _handle_gather_research(
            ws, chat_name, source, flags, provider, model, [], raw_query=query
        )
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


# ---------------------------------------------------------------------------
# Gather Research helpers
# ---------------------------------------------------------------------------

async def _handle_gather_research(
    ws,
    chat_name: str,
    source: str,
    flags: dict,
    provider: str,
    model,
    llm_messages: list,
    raw_query: str | None = None,
) -> None:
    """
    Gather Research pipeline:
      1. Extract a precise search query (or use ``raw_query`` directly).
      2. Call Tavily with that query.
      3. Return a brief acknowledgement via ``llm_chat`` (saved to history).
      4. Return the raw result list via ``gather_research_results`` (NOT saved).
    """
    if not config.TAVILY_API_KEY:
        # Save a helpful error message to chat history
        err_text = (
            "**Gather Research** requires a Tavily API key.\n\n"
            "Set `TAVILY_API_KEY` in your `.env` file and restart the LLM Chat service."
        )
        append_message(chat_name, "assistant", err_text)
        await ws.send(build_message("llm_chat", config.CLIENT_NAME, source, {
            "chatName": chat_name,
            "status": "complete",
            "message": err_text,
            "images": [],
            "links": [],
        }, flags))
        return

    # Step 1: Derive search query — use raw_query if already known, otherwise ask the LLM
    await ws.send(build_message("llm_chat", config.CLIENT_NAME, source, {
        "chatName": chat_name,
        "status": "thinking",
        "message": "",
    }, flags))

    if raw_query:
        search_query = raw_query
    else:
        try:
            search_query = await extract_search_query(provider, llm_messages, model=model)
        except Exception as exc:
            logger.error("extract_search_query error: %s", exc)
            search_query = ""
        # Detect silent error strings returned by _openai_compatible_completion
        if search_query.startswith(("Error from ", "Connection error to ", "Error ")):
            logger.warning("extract_search_query returned provider error, falling back: %.120s", search_query)
            search_query = ""
        if not search_query:
            for m in reversed(llm_messages):
                if m.get("role") == "user":
                    search_query = m["content"][:300]
                    break

    if not search_query:
        err_text = "Could not derive a search query from the conversation."
        append_message(chat_name, "assistant", err_text)
        await ws.send(build_message("llm_chat", config.CLIENT_NAME, source, {
            "chatName": chat_name,
            "status": "complete",
            "message": err_text,
            "images": [],
            "links": [],
        }, flags))
        return

    # Step 2: Tavily search
    try:
        search_result = await tavily_search(
            query=search_query,
            api_key=config.TAVILY_API_KEY,
            max_results=config.TAVILY_MAX_RESULTS,
            search_depth=config.TAVILY_SEARCH_DEPTH,
        )
    except Exception as exc:
        logger.error("Tavily search error: %s", exc)
        search_result = {"query": search_query, "results": [], "error": str(exc)}

    results = search_result.get("results", [])
    error   = search_result.get("error", "")

    # Step 3: Build acknowledgement text (saved to chat history)
    if error:
        ack_text = (
            f"Search for **{search_query}** failed: {error}\n\n"
            "Please try a different query or check the Tavily API key."
        )
    elif not results:
        ack_text = (
            f"Searched Tavily for **{search_query}** — no results found.\n\n"
            "Try rephrasing or broadening the query."
        )
    else:
        ack_text = (
            f"Searching Tavily for: **{search_query}**\n\n"
            f"Found **{len(results)}** result(s). "
            "Tap any result card below to index or parse its contents."
        )

    append_message(chat_name, "assistant", ack_text,
                   metadata={"images": [], "links": []})
    await ws.send(build_message("llm_chat", config.CLIENT_NAME, source, {
        "chatName": chat_name,
        "status": "complete",
        "message": ack_text,
        "images": [],
        "links": [],
    }, flags))

    # Step 4: Assign stable result IDs and send the results payload
    for r in results:
        r["resultId"] = str(uuid.uuid4())

    await ws.send(build_message("gather_research_results", config.CLIENT_NAME, source, {
        "chatName":    chat_name,
        "searchQuery": search_query,
        "totalFound":  len(results),
        "results":     results,
        "error":       error,
    }, flags))


async def _handle_gather_research_action(ws, msg: dict) -> None:
    """
    Handle a gather_research_action message from the mobile app.

    Actions
    -------
    ``index``  – summarise the snippet via LLM and forward to procIndex.
    ``parse``  – store the snippet as injected context for subsequent chats.
    """
    payload  = msg["payload"]
    source   = msg.get("source", "")
    msg_id   = msg.get("id", "")
    flags    = {"correlationId": msg_id}

    action    = payload.get("action", "")
    chat_name = payload.get("chatName", "")
    result_id = payload.get("resultId", "")
    url       = payload.get("url", "")
    title     = payload.get("title", "")
    snippet   = payload.get("snippet", "")
    provider  = payload.get("provider", "llama")
    model     = payload.get("model", None)

    if action == "index":
        await _do_index_result(
            ws, source, flags, chat_name, result_id,
            url, title, snippet, provider, model,
        )
    elif action == "parse":
        await _do_parse_result(
            ws, source, flags, chat_name, result_id, url, title, snippet,
        )
    else:
        await ws.send(build_message("error", config.CLIENT_NAME, source, {
            "code":        "INVALID_MESSAGE",
            "message":     f"Unknown gather_research_action action '{action}'.",
            "referenceId": msg_id,
        }))


async def _do_index_result(
    ws, source, flags, chat_name, result_id,
    url, title, snippet, provider, model,
) -> None:
    """Summarise a result via LLM and forward it to procIndex for indexing."""
    # Find a connected procIndex client by type (name may differ)
    proc_index_target = _find_client_by_type("procIndex") or (
        "procIndex" if "procIndex" in _connected_clients else None
    )
    if not proc_index_target:
        logger.warning("Index request: no procIndex client is connected.")
        await ws.send(build_message("gather_research_action", config.CLIENT_NAME, source, {
            "action":    "index",
            "resultId":  result_id,
            "chatName":  chat_name,
            "status":    "procIndex_unavailable",
            "message":   (
                "procIndex is not connected to the server. "
                "Start the procIndex service and try again."
            ),
        }, flags))
        return

    # Ask the LLM for a concise summary and clean keywords
    summary = snippet  # safe fallback
    keywords: list[str] = []
    try:
        summary = await chat_completion(
            provider,
            [{
                "role":    "user",
                "content": (
                    f"Summarize the following content in 3–5 sentences. "
                    f"Output ONLY the summary sentences — no introduction, no preamble, "
                    f"no 'Here is a summary:' or similar phrase. Start directly with the content.\n\n"
                    f"Title: {title}\nURL: {url}\n\nContent:\n{snippet}"
                ),
            }],
            mode="ask",
            model=model,
        )
    except Exception as exc:
        logger.warning("Summary generation failed (using raw snippet): %s", exc)

    try:
        kw_raw = await chat_completion(
            provider,
            [{
                "role":    "user",
                "content": (
                    f"Extract 5–10 specific, meaningful keywords from the following text. "
                    f"Focus on domain-specific nouns and key concepts. "
                    f"Exclude generic words like 'observed', 'article', 'content', 'summary', "
                    f"'sentence', 'concise', or place names unrelated to the topic. "
                    f"Output ONLY a comma-separated list of keywords, nothing else.\n\n"
                    f"Title: {title}\n\n{summary}"
                ),
            }],
            mode="ask",
            model=model,
        )
        keywords = [k.strip().lower() for k in kw_raw.split(",") if k.strip()][:10]
    except Exception as exc:
        logger.warning("Keyword extraction failed: %s", exc)

    # Forward to procIndex using the existing gather_research protocol
    await ws.send(build_message("gather_research", config.CLIENT_NAME, proc_index_target, {
        "status": "complete",
        "query":  title,
        "results": [{
            "url":      url,
            "title":    title,
            "summary":  summary,
            "keywords": keywords,
        }],
    }))

    await ws.send(build_message("gather_research_action", config.CLIENT_NAME, source, {
        "action":   "index",
        "resultId": result_id,
        "chatName": chat_name,
        "status":   "indexed",
        "title":    title,
        "message":  f"Sent '{title}' to procIndex for indexing.",
    }, flags))


async def _do_parse_result(
    ws, source, flags, chat_name, result_id, url, title, snippet,
) -> None:
    """Add a search result's content as injected context for the chat."""
    if chat_name not in _parsed_web_contexts:
        _parsed_web_contexts[chat_name] = []

    _parsed_web_contexts[chat_name].append({
        "url":     url,
        "title":   title,
        "content": snippet,
    })
    logger.info(
        "Parsed web context added to chat '%s': %s (%s)", chat_name, title, url
    )

    await ws.send(build_message("gather_research_action", config.CLIENT_NAME, source, {
        "action":   "parse",
        "resultId": result_id,
        "chatName": chat_name,
        "status":   "added",
        "title":    title,
        "url":      url,
        "message":  (
            f"Content from '{title}' has been added as context. "
            "It will inform the LLM's responses for the rest of this chat session."
        ),
    }, flags))


# ---------------------------------------------------------------------------
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
                "functions": ["llm_chat", "gather_research"],
                "hostname": socket.gethostname(),
                "nickname": "LLM Chat",
                "availableProviders": providers,
                "availableModes": modes,
            })
            await ws.send(reg_msg)
            logger.info(f"Registered. Providers: {[p['label'] for p in providers]}")

            # Announce to the room
            system_prompts = get_available_system_prompts()
            announce = build_message("llm_announce", config.CLIENT_NAME, "all", {
                "message": "LLM Chat is online and ready.",
                "providers": providers,
                "modes": modes,
                "systemPrompts": system_prompts,
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
                    _connected_clients.clear()
                    for c in clients:
                        name = c.get("name", "")
                        if name:
                            _connected_clients[name] = c
                    logger.info(f"Connected clients: {list(_connected_clients.keys())}")
                    continue

                if msg_type == "client_announce":
                    p = msg.get("payload", {})
                    c = p.get("client", {})
                    action = p.get("action")
                    client_name = c.get("name", "")
                    if action == "joined":
                        logger.info(f"[ANNOUNCE] {client_name} ({c.get('clientType')}) from {c.get('hostname')} has connected.")
                        if client_name:
                            _connected_clients[client_name] = c
                    elif action == "left":
                        logger.info(f"[ANNOUNCE] {client_name} ({c.get('clientType')}) from {c.get('hostname')} has disconnected.")
                        _connected_clients.pop(client_name, None)
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
            logger.error("Duplicate client - this hostname already has an LLM client connected. Exiting.")
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
