# LLM_Chat Configuration

import os
from dotenv import load_dotenv

load_dotenv()

# --- Server Connection ---
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 9734

# --- Client Identity ---
CLIENT_NAME = "llm-chat"
CLIENT_TYPE = "llm"
CAPABILITIES = ["llm_chat"]

# --- LLM Providers ---
# Each provider needs its key set in .env
# The client advertises which providers have valid keys on connect.
LLM_PROVIDERS = {
    "llama": {
        "label": "Llama (Local)",
        "api_base": os.getenv("LLAMA_API_BASE", "http://127.0.0.1:8080"),
        "model": os.getenv("LLAMA_MODEL", "default"),
        "api_key": os.getenv("LLAMA_API_KEY", ""),  # Some local servers require a key
        "enabled": True,  # Always enabled - local model
    },
    "claude": {
        "label": "Claude (Anthropic)",
        "api_base": "https://api.anthropic.com",
        "model": os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514"),
        "api_key": os.getenv("ANTHROPIC_API_KEY", ""),
        "enabled": bool(os.getenv("ANTHROPIC_API_KEY", "")),
    },
    "openai": {
        "label": "OpenAI",
        "api_base": "https://api.openai.com",
        "model": os.getenv("OPENAI_MODEL", "gpt-4o"),
        "api_key": os.getenv("OPENAI_API_KEY", ""),
        "enabled": bool(os.getenv("OPENAI_API_KEY", "")),
    },
}

# --- File Paths ---
SYSTEM_PROMPT_FILE = os.path.join(os.path.dirname(__file__), "System.md")
MESSAGE_FUNCTIONS_FILE = os.path.join(os.path.dirname(__file__), "message_functions.json")
CHAT_HISTORY_DIR = os.path.join(os.path.dirname(__file__), "chat_history")
ATTACHMENTS_DIR = os.path.join(os.path.dirname(__file__), "attachments")

# --- Local Models ---
# Default project-local directory for downloaded models
LOCAL_MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

# Extra directories to scan for existing local model files (from .env, semicolon-separated)
_extra_paths = os.getenv("LLAMA_MODEL_PATHS", "")
LLAMA_MODEL_PATHS = [
    p.strip() for p in _extra_paths.split(";") if p.strip()
]

# Recognized local model file extensions
LOCAL_MODEL_EXTENSIONS = (".gguf", ".bin", ".safetensors")

# --- Local Inference (llama-cpp-python) ---
# Number of layers to offload to GPU (-1 = all, 0 = CPU only)
LLAMA_GPU_LAYERS = int(os.getenv("LLAMA_GPU_LAYERS", "-1"))  # Default to all layers on GPU if available
# LLAMA_GPU_LAYERS = int(os.getenv("LLAMA_GPU_LAYERS", "0")) # CPU

# Context window size in tokens (0 = auto-detect from model metadata)
LLAMA_CONTEXT_SIZE = int(os.getenv("LLAMA_CONTEXT_SIZE", "0"))

# --- Attachment Limits ---
# WebSocket frames are typically limited by the library.
# websockets lib default max is 1MB (1_048_576 bytes).
# We chunk files larger than CHUNK_SIZE and reassemble on the other end.
MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024   # 50 MB total file limit
CHUNK_SIZE = 512 * 1024                   # 512 KB per chunk

# --- Ping / Keepalive ---
PING_INTERVAL = 30
PING_TIMEOUT = 10
