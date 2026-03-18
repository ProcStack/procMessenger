"""
procMessenger — LLM Provider Interface

Handles communication with different LLM backends (Llama local, Claude, OpenAI).
All providers use an OpenAI-compatible chat completions API where possible.
"""

import json
import logging
import os
import asyncio
import aiohttp

import config

logger = logging.getLogger("procMessenger.llm.providers")

# --- In-process model cache ---
# Holds the currently loaded llama-cpp-python Llama instance and its file path.
_loaded_model = None       # llama_cpp.Llama instance
_loaded_model_path = None  # str — file path of the loaded model

try:
    from llama_cpp import Llama as _LlamaCpp
    LLAMA_CPP_AVAILABLE = True
except ImportError:
    _LlamaCpp = None
    LLAMA_CPP_AVAILABLE = False
    logger.info("llama-cpp-python not installed — local in-process inference unavailable.")


def get_system_prompt():
    """Read the system prompt from System.md."""
    try:
        with open(config.SYSTEM_PROMPT_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return "You are a helpful AI assistant."


def get_available_providers():
    """Return list of enabled LLM providers (those with valid config)."""
    available = []
    for key, prov in config.LLM_PROVIDERS.items():
        if prov["enabled"]:
            available.append({
                "value": key,
                "label": prov["label"],
                "defaultModel": prov["model"],
                "models": [],  # Populated by fetch_all_models()
            })
    return available


async def fetch_all_models():
    """
    Query each enabled provider's API for available models.
    For the llama provider, also merges in locally discovered model files.
    Returns dict: provider_key -> [{"id": "model-id", "name": "display name"}, ...]
    """
    results = {}
    for key, prov in config.LLM_PROVIDERS.items():
        if not prov["enabled"]:
            continue
        try:
            if key == "claude":
                results[key] = await _fetch_anthropic_models(prov)
            elif key == "llama":
                # Llama server may not be running — that's fine, local files suffice
                results[key] = await _fetch_openai_compatible_models(prov, quiet=True)
            else:
                results[key] = await _fetch_openai_compatible_models(prov)
        except Exception as e:
            logger.warning(f"Failed to fetch models for {prov['label']}: {e}")
            # Fallback to configured default
            results[key] = [{"id": prov["model"], "name": prov["model"]}]

    # Merge local model files into the llama provider list
    if "llama" in results:
        local_models = scan_local_models()
        # Add local files that aren't already listed (by id)
        existing_ids = {m["id"] for m in results["llama"]}
        for lm in local_models:
            if lm["id"] not in existing_ids:
                results["llama"].append(lm)
    elif config.LLM_PROVIDERS.get("llama", {}).get("enabled"):
        results["llama"] = scan_local_models()

    return results


async def _fetch_openai_compatible_models(prov, quiet=False):
    """Fetch models from an OpenAI-compatible /v1/models endpoint.
    If quiet=True, connection errors return an empty list without warning."""
    api_base = prov["api_base"].rstrip("/")
    url = f"{api_base}/v1/models"

    headers = {"Content-Type": "application/json"}
    if prov["api_key"]:
        headers["Authorization"] = f"Bearer {prov['api_key']}"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    if not quiet:
                        logger.warning(f"Models endpoint returned HTTP {resp.status} for {prov['label']}")
                    return [{"id": prov["model"], "name": prov["model"]}]
                data = await resp.json()
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        if quiet:
            logger.info(f"No API server reachable for {prov['label']} — using local models only.")
            return []
        raise

    models = []
    for m in data.get("data", []):
        model_id = m.get("id", "")
        if model_id:
            models.append({"id": model_id, "name": model_id})

    # Sort alphabetically and ensure default is first if present
    models.sort(key=lambda x: x["id"])
    default_id = prov["model"]
    models = (
        [m for m in models if m["id"] == default_id]
        + [m for m in models if m["id"] != default_id]
    )

    return models if models else [{"id": prov["model"], "name": prov["model"]}]


async def _fetch_anthropic_models(prov):
    """Fetch models from the Anthropic /v1/models endpoint."""
    url = f"{prov['api_base'].rstrip('/')}/v1/models"

    headers = {
        "Content-Type": "application/json",
        "x-api-key": prov["api_key"],
        "anthropic-version": "2023-06-01",
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status != 200:
                logger.warning(f"Anthropic models endpoint returned HTTP {resp.status}")
                return [{"id": prov["model"], "name": prov["model"]}]
            data = await resp.json()

    models = []
    for m in data.get("data", []):
        model_id = m.get("id", "")
        display = m.get("display_name", model_id)
        if model_id:
            models.append({"id": model_id, "name": display or model_id})

    models.sort(key=lambda x: x["id"])
    default_id = prov["model"]
    models = (
        [m for m in models if m["id"] == default_id]
        + [m for m in models if m["id"] != default_id]
    )

    return models if models else [{"id": prov["model"], "name": prov["model"]}]


async def chat_completion(provider_key, messages, mode="ask", model=None):
    """
    Send a chat completion request to the specified provider.

    Args:
        provider_key: Key into config.LLM_PROVIDERS (e.g. "llama", "claude", "openai")
        messages: List of {"role": "...", "content": "..."} dicts
        mode: Current LLM mode ("ask", "agent", "plan")
        model: Specific model ID to use. Falls back to provider default if None.

    Returns:
        str: The assistant's response text
    """
    prov = config.LLM_PROVIDERS.get(provider_key)
    if not prov or not prov["enabled"]:
        return f"Error: Provider '{provider_key}' is not available or not configured."

    # Use caller-specified model, fall back to config default
    effective_model = model if model else prov["model"]

    system_prompt = get_system_prompt()

    # Append mode-specific instruction
    mode_suffix = {
        "ask": "\n\nYou are in Ask mode. Respond directly to the user's question.",
        "agent": "\n\nYou are in Agent mode. You may describe actions to take and incorporate tool outputs.",
        "plan": "\n\nYou are in Plan mode. Break down the request into numbered steps before responding.",
    }
    system_prompt += mode_suffix.get(mode, "")

    if provider_key == "claude":
        return await _claude_completion(prov, system_prompt, messages, effective_model)

    # For llama: check if the model resolves to a local file for in-process inference
    if provider_key == "llama":
        local_path = _resolve_local_model_path(effective_model)
        if local_path:
            return await _local_llama_completion(local_path, system_prompt, messages)

    # Fall back to OpenAI-compatible API (remote server)
    return await _openai_compatible_completion(prov, system_prompt, messages, effective_model)


async def _openai_compatible_completion(prov, system_prompt, messages, model):
    """OpenAI-compatible chat completion (works with Llama local servers, OpenAI, etc)."""
    api_base = prov["api_base"].rstrip("/")
    url = f"{api_base}/v1/chat/completions"

    headers = {"Content-Type": "application/json"}
    if prov["api_key"]:
        headers["Authorization"] = f"Bearer {prov['api_key']}"

    full_messages = [{"role": "system", "content": system_prompt}] + messages

    body = {
        "model": model,
        "messages": full_messages,
        "stream": False,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    return f"Error from {prov['label']}: HTTP {resp.status}\n{text}"
                data = await resp.json()
                return data["choices"][0]["message"]["content"]
    except aiohttp.ClientError as e:
        return f"Connection error to {prov['label']}: {e}"
    except Exception as e:
        return f"Error from {prov['label']}: {e}"


async def _claude_completion(prov, system_prompt, messages, model):
    """Anthropic Claude API (Messages API format)."""
    url = f"{prov['api_base'].rstrip('/')}/v1/messages"

    headers = {
        "Content-Type": "application/json",
        "x-api-key": prov["api_key"],
        "anthropic-version": "2023-06-01",
    }

    # Claude Messages API expects system as a top-level field, not in messages
    claude_messages = []
    for m in messages:
        claude_messages.append({
            "role": m["role"],
            "content": m["content"],
        })

    body = {
        "model": model,
        "system": system_prompt,
        "messages": claude_messages,
        "max_tokens": 4096,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    return f"Error from Claude: HTTP {resp.status}\n{text}"
                data = await resp.json()
                # Claude returns content as a list of blocks
                content_blocks = data.get("content", [])
                text_parts = [b["text"] for b in content_blocks if b.get("type") == "text"]
                return "\n".join(text_parts)
    except aiohttp.ClientError as e:
        return f"Connection error to Claude: {e}"
    except Exception as e:
        return f"Error from Claude: {e}"


# ---------------------------------------------------------------------------
# In-process local model inference (llama-cpp-python)
# ---------------------------------------------------------------------------

def _resolve_local_model_path(model_id):
    """
    Check if *model_id* corresponds to a local model file.
    Returns the absolute path if found, or None.
    """
    # If it's already an absolute path that exists, use it directly
    if os.path.isfile(model_id):
        return os.path.realpath(model_id)

    # Search scanned local models for a matching id (filename)
    for m in scan_local_models():
        if m["id"] == model_id:
            return m["path"]
    return None


def _get_or_load_model(model_path):
    """
    Return a cached Llama instance, loading (or swapping) if necessary.
    """
    global _loaded_model, _loaded_model_path

    if not LLAMA_CPP_AVAILABLE:
        raise RuntimeError(
            "llama-cpp-python is not installed. "
            "Run: pip install llama-cpp-python"
        )

    if _loaded_model is not None and _loaded_model_path == model_path:
        return _loaded_model

    # Unload previous model
    if _loaded_model is not None:
        logger.info(f"Unloading previous model: {_loaded_model_path}")
        del _loaded_model
        _loaded_model = None
        _loaded_model_path = None

    logger.info(f"Loading local model: {model_path} "
                f"(n_gpu_layers={config.LLAMA_GPU_LAYERS}, "
                f"n_ctx={config.LLAMA_CONTEXT_SIZE})")

    _loaded_model = _LlamaCpp(
        model_path=model_path,
        n_gpu_layers=config.LLAMA_GPU_LAYERS,
        n_ctx=config.LLAMA_CONTEXT_SIZE,
        verbose=False,
    )
    _loaded_model_path = model_path
    logger.info("Model loaded successfully.")
    return _loaded_model


async def _local_llama_completion(model_path, system_prompt, messages):
    """
    Run chat completion in-process using llama-cpp-python.
    Offloads the blocking inference call to a thread so the event loop stays free.
    """
    def _run():
        llm = _get_or_load_model(model_path)

        chat_messages = [{"role": "system", "content": system_prompt}]
        for m in messages:
            chat_messages.append({"role": m["role"], "content": m["content"]})

        result = llm.create_chat_completion(
            messages=chat_messages,
        )
        return result["choices"][0]["message"]["content"]

    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        logger.error(f"Local inference error: {e}")
        return f"Error: Local inference failed — {e}"

# ---------------------------------------------------------------------------
# Local model file scanning & download
# ---------------------------------------------------------------------------
def scan_local_models():
    """
    Scan the project's models/ directory and any extra paths defined in
    LLAMA_MODEL_PATHS for recognised model files (.gguf, .bin, .safetensors).
    Returns a list of {"id": <filename>, "name": <display>, "path": <abs path>}.
    """
    found = {}  # keyed by filename to deduplicate

    # Build ordered list of directories: project default first, then extras
    search_dirs = [config.LOCAL_MODELS_DIR] + list(config.LLAMA_MODEL_PATHS)

    for search_dir in search_dirs:
        if not os.path.isdir(search_dir):
            continue
        real_dir = os.path.realpath(search_dir)
        for root, _dirs, files in os.walk(real_dir):
            for fname in files:
                if fname.lower().endswith(config.LOCAL_MODEL_EXTENSIONS):
                    if fname not in found:
                        full_path = os.path.join(root, fname)
                        # Build a friendly display name
                        rel = os.path.relpath(full_path, real_dir)
                        found[fname] = {
                            "id": fname,
                            "name": f"{fname}  ({rel})",
                            "path": full_path,
                        }

    models = sorted(found.values(), key=lambda m: m["id"])
    logger.info(f"Local model scan: found {len(models)} file(s) across {len(search_dirs)} dir(s)")
    return models


async def download_model(url, filename=None):
    """
    Download a model file from *url* into the project's LOCAL_MODELS_DIR.
    Streams to disk to avoid high memory usage.

    Args:
        url: Direct download URL (e.g. a HuggingFace GGUF link).
        filename: Optional filename override. Derived from URL if omitted.

    Returns:
        dict with keys: filename, filepath, fileSize on success,
        or {"error": "..."} on failure.
    """
    os.makedirs(config.LOCAL_MODELS_DIR, exist_ok=True)

    if not filename:
        # Derive from the last segment of the URL path
        from urllib.parse import urlparse, unquote
        parsed = urlparse(url)
        filename = unquote(os.path.basename(parsed.path)) or "model.gguf"

    dest = os.path.join(config.LOCAL_MODELS_DIR, filename)

    # Security: ensure we stay inside LOCAL_MODELS_DIR
    real_dest = os.path.realpath(dest)
    real_models_dir = os.path.realpath(config.LOCAL_MODELS_DIR)
    if not real_dest.startswith(real_models_dir + os.sep):
        return {"error": "Security error: path traversal detected in filename."}

    if os.path.exists(real_dest):
        return {"error": f"File already exists: {filename}"}

    logger.info(f"Downloading model: {url} -> {dest}")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=None)) as resp:
                if resp.status != 200:
                    return {"error": f"Download failed: HTTP {resp.status}"}

                total = int(resp.headers.get("Content-Length", 0))
                downloaded = 0

                with open(real_dest, "wb") as f:
                    async for chunk in resp.content.iter_chunked(1024 * 1024):
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total:
                            pct = downloaded * 100 // total
                            # Log every ~10 %
                            if pct % 10 == 0:
                                logger.info(f"Download progress: {pct}% ({downloaded}/{total})")

        file_size = os.path.getsize(real_dest)
        logger.info(f"Download complete: {filename} ({file_size} bytes)")
        return {"filename": filename, "filepath": real_dest, "fileSize": file_size}

    except Exception as e:
        # Clean up partial file
        if os.path.exists(real_dest):
            os.remove(real_dest)
        return {"error": f"Download failed: {e}"}
