# procMessenger Protocol Specification

## Overview
All communication uses **WebSocket** on port **9734** (configurable).  
Messages are JSON-encoded UTF-8 text frames.

---

## Connection Flow

1. A **Server** starts listening on `ws://0.0.0.0:9734`
2. **Clients** (PC scripts, mobile app) connect to the server
3. On connect, each client sends a `register` message to identify itself
4. The server maintains a registry of connected clients and broadcasts updates
5. Messages are routed by the server based on the `target` field

---

## Message Envelope

Every message follows this structure:

```json
{
  "id": "uuid-v4",
  "type": "message_type",
  "source": "client_name",
  "target": "recipient_name | all",
  "timestamp": "ISO-8601 UTC",
  "flags": {},
  "payload": {}
}
```

### Fields

| Field       | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `id`        | string | yes      | UUID v4 unique message identifier |
| `type`      | string | yes      | Message type (see below) |
| `source`    | string | yes      | Name of the sending client |
| `target`    | string | yes      | Name of recipient client, or `"all"` for broadcast |
| `timestamp` | string | yes      | ISO-8601 UTC timestamp |
| `flags`     | object | no       | Optional flags (see Flags section) |
| `payload`   | object | yes      | Type-specific data |

---

## Message Types

### `register`
Sent by a client immediately after WebSocket connection opens.

```json
{
  "type": "register",
  "source": "my-desktop",
  "target": "server",
  "payload": {
    "clientType": "python | nodejs | mobile",
    "capabilities": ["run_script", "gather_research", "edit_story"],
    "hostname": "DESKTOP-ABC123",
    "nickname": ""
  }
}
```

### `client_list`
Broadcast by the server when the client registry changes.

```json
{
  "type": "client_list",
  "source": "server",
  "target": "all",
  "payload": {
    "clients": [
      {
        "name": "my-desktop",
        "clientType": "python",
        "capabilities": ["run_script", "edit_story"],
        "hostname": "DESKTOP-ABC123",
        "nickname": "",
        "connectedAt": "ISO-8601"
      }
    ]
  }
}
```

### `run_script`
Request a connected computer to execute a known script.

**Request** (mobile → computer):
```json
{
  "type": "run_script",
  "target": "my-desktop",
  "payload": {
    "action": "list_scripts | execute",
    "scriptName": "",
    "args": []
  }
}
```

**Response — Script List** (computer → mobile):
```json
{
  "type": "run_script",
  "target": "mobile-phone",
  "payload": {
    "action": "script_list",
    "scripts": [
      { "name": "backup.sh", "description": "Run weekly backup" },
      { "name": "deploy.py", "description": "Deploy staging" }
    ]
  }
}
```

**Response — Execution Result** (computer → mobile):
```json
{
  "type": "run_script",
  "target": "mobile-phone",
  "payload": {
    "action": "result",
    "scriptName": "backup.sh",
    "exitCode": 0,
    "stdout": "Backup complete.",
    "stderr": ""
  }
}
```

### `gather_research`
Request a computer to perform web research using a local LLM + Search API + Puppeteer.

**Request** (mobile → computer):
```json
{
  "type": "gather_research",
  "target": "research-pc",
  "payload": {
    "query": "Latest advances in quantum computing 2026",
    "maxResults": 5,
    "searchEngine": "default"
  }
}
```

**Response — Progress** (computer → mobile):
```json
{
  "type": "gather_research",
  "target": "mobile-phone",
  "payload": {
    "status": "in_progress",
    "message": "Searching... found 5 results, processing URL 2/5"
  }
}
```

**Response — Complete** (computer → mobile):
```json
{
  "type": "gather_research",
  "target": "mobile-phone",
  "payload": {
    "status": "complete",
    "query": "Latest advances in quantum computing 2026",
    "results": [
      {
        "url": "https://example.com/article",
        "title": "Quantum Computing Breakthrough",
        "summary": "LLM-generated summary of the page content..."
      }
    ]
  }
}
```

### `edit_story`
Relay messages between the mobile app and a story editor program (Python-based).

**Message** (mobile → story-editor):
```json
{
  "type": "edit_story",
  "target": "story-pc",
  "payload": {
    "message": "Change the protagonist's name to Alex in chapter 3"
  }
}
```

**Response** (story-editor → mobile):
```json
{
  "type": "edit_story",
  "target": "mobile-phone",
  "payload": {
    "message": "Updated protagonist name in chapter 3. 2 references changed.",
    "status": "complete"
  }
}
```

### `llm_announce`
Sent by the LLM Chat client when it joins the server. Broadcasts available providers (with discovered models) and modes.
Models are fetched dynamically from each provider's API at startup to stay current.

```json
{
  "type": "llm_announce",
  "source": "llm-chat",
  "target": "all",
  "payload": {
    "message": "LLM Chat is online and ready.",
    "providers": [
      {
        "value": "llama",
        "label": "Llama (Local)",
        "defaultModel": "default",
        "models": [
          { "id": "llama3", "name": "llama3" },
          { "id": "codellama", "name": "codellama" }
        ]
      },
      {
        "value": "claude",
        "label": "Claude (Anthropic)",
        "defaultModel": "claude-sonnet-4-20250514",
        "models": [
          { "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" },
          { "id": "claude-opus-4-20250514", "name": "Claude Opus 4" }
        ]
      }
    ],
    "modes": [
      { "value": "ask", "label": "Ask", "description": "Simple Q&A" },
      { "value": "agent", "label": "Agent", "description": "Agentic mode" },
      { "value": "plan", "label": "Plan", "description": "Planning mode" }
    ]
  }
}
```

### `llm_modes`
Request available LLM modes and providers from the LLM Chat client.

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_modes",
  "target": "llm-chat",
  "payload": {}
}
```

**Response** (llm-chat → mobile):
```json
{
  "type": "llm_modes",
  "target": "mobile-phone",
  "payload": {
    "modes": [
      { "value": "ask", "label": "Ask", "description": "Simple Q&A" }
    ],
    "providers": [
      { "value": "llama", "label": "Llama (Local)", "defaultModel": "default", "models": [{"id": "llama3", "name": "llama3"}] }
    ]
  }
}
```

### `llm_chat`
Send a message to the LLM and receive a response.

Also accepted by any application client that registers the `llm_chat` capability (e.g. branchShredder),
allowing other programs to forward prompts to their own AI provider.  In that case `chatName` and `mode`
are optional, `nodeContext` is available for pre-built context blocks, and `model` may be supplied as
`"provider:model_name"` (e.g. `"anthropic:claude-sonnet-4-6"`) in addition to the normal separate
`provider` / `model` fields.

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_chat",
  "target": "llm-chat",
  "payload": {
    "chatName": "My Research Chat",
    "message": "Explain quantum entanglement simply.",
    "provider": "llama",
    "model": "llama3",
    "mode": "ask",
    "nodeContext": ""
  }
}
```

| Field         | Required | Description |
|---------------|----------|-------------|
| `chatName`    | no       | Session name (used by llm-chat for persistence; ignored by other apps) |
| `message`     | yes      | The user prompt |
| `provider`    | no       | Provider key (e.g. `"claude"`). Ignored if `model` is in `"provider:model"` format |
| `model`       | no       | Model id, or `"provider:model_name"` combined shorthand |
| `mode`        | no       | Processing mode (e.g. `"ask"`, `"agent"`) — app-defined |
| `nodeContext` | no       | Pre-built context block to prepend to the prompt (e.g. from `query_nodes`) |

**Response — Thinking** (llm-chat → mobile):
```json
{
  "type": "llm_chat",
  "target": "mobile-phone",
  "payload": {
    "chatName": "My Research Chat",
    "status": "thinking",
    "message": ""
  }
}
```

**Response — Complete** (llm-chat → mobile):
```json
{
  "type": "llm_chat",
  "target": "mobile-phone",
  "payload": {
    "chatName": "My Research Chat",
    "status": "complete",
    "message": "Quantum entanglement is when two particles...",
    "images": [],
    "links": [{ "text": "Wikipedia", "url": "https://en.wikipedia.org/wiki/Quantum_entanglement" }]
  }
}
```

### `llm_chat_list`
Request the list of saved chat names (metadata only, no message content).

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_chat_list",
  "target": "llm-chat",
  "payload": {}
}
```

**Response** (llm-chat → mobile):
```json
{
  "type": "llm_chat_list",
  "target": "mobile-phone",
  "payload": {
    "chats": [
      {
        "name": "My Research Chat",
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601",
        "messageCount": 12,
        "provider": "llama",
        "mode": "ask"
      }
    ]
  }
}
```

### `llm_chat_history`
Request the full message history for a specific chat (by name).

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_chat_history",
  "target": "llm-chat",
  "payload": {
    "chatName": "My Research Chat"
  }
}
```

**Response** (llm-chat → mobile):
```json
{
  "type": "llm_chat_history",
  "target": "mobile-phone",
  "payload": {
    "chatName": "My Research Chat",
    "messages": [
      { "role": "user", "content": "Hello", "timestamp": "ISO-8601" },
      { "role": "assistant", "content": "Hi! How can I help?", "timestamp": "ISO-8601" }
    ]
  }
}
```

### `llm_chat_create`
Create a new chat session.

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_chat_create",
  "target": "llm-chat",
  "payload": {
    "chatName": "New Project Chat",
    "provider": "claude",
    "mode": "plan"
  }
}
```

**Response** (llm-chat → mobile):
```json
{
  "type": "llm_chat_create",
  "target": "mobile-phone",
  "payload": {
    "chatName": "New Project Chat",
    "provider": "claude",
    "mode": "plan",
    "createdAt": "ISO-8601"
  }
}
```

### `llm_chat_delete`
Delete a saved chat session.

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_chat_delete",
  "target": "llm-chat",
  "payload": { "chatName": "Old Chat" }
}
```

**Response** (llm-chat → mobile):
```json
{
  "type": "llm_chat_delete",
  "target": "mobile-phone",
  "payload": {
    "chatName": "Old Chat",
    "deleted": true
  }
}
```

### `llm_local_models`
Request a list of locally available model files from the LLM Chat client.
Scans the `models/` directory and any extra paths configured via `LLAMA_MODEL_PATHS` in `.env`.
Returns files with recognised extensions (`.gguf`, `.bin`, `.safetensors`).

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_local_models",
  "target": "llm-chat",
  "payload": {}
}
```

**Response** (llm-chat → mobile):
```json
{
  "type": "llm_local_models",
  "target": "mobile-phone",
  "payload": {
    "models": [
      {
        "id": "llama-3-8b.gguf",
        "name": "llama-3-8b.gguf  (llama-3-8b.gguf)",
        "path": "/path/to/models/llama-3-8b.gguf"
      }
    ]
  }
}
```

### `llm_model_download`
Download a model file from a URL (e.g. a HuggingFace GGUF link) into the LLM Chat client's local `models/` directory.
Streams to disk. Sends a `downloading` status immediately, then a `complete` or `error` reply when done.

**Request** (mobile → llm-chat):
```json
{
  "type": "llm_model_download",
  "target": "llm-chat",
  "payload": {
    "url": "https://huggingface.co/example/llama-3-8b-q4.gguf",
    "filename": "llama-3-8b-q4.gguf"
  }
}
```

**Response — Downloading** (llm-chat → mobile):
```json
{
  "type": "llm_model_download",
  "target": "mobile-phone",
  "payload": {
    "status": "downloading",
    "url": "https://huggingface.co/example/llama-3-8b-q4.gguf",
    "filename": "llama-3-8b-q4.gguf"
  }
}
```

**Response — Complete** (llm-chat → mobile):
```json
{
  "type": "llm_model_download",
  "target": "mobile-phone",
  "payload": {
    "status": "complete",
    "filename": "llama-3-8b-q4.gguf",
    "filepath": "/path/to/models/llama-3-8b-q4.gguf",
    "fileSize": 4294967296
  }
}
```

---

## Application Extension Message Types

These message types are generic extension points that any capable application client may implement.
They carry no assumption about which program services them — the `target` field routes each request
to whichever registered client advertises the matching capability.

When **branchShredder** is connected with `PROC_MESSENGER_ENABLED=true` it registers with the
capabilities `["edit_story", "llm_chat", "query_nodes", "find_nodes", "get_node", "update_node", "system_prompt", "system"]`.

Any application implementing these types should include the corresponding capability strings in its
`register` message so the server and other clients can discover them via `client_list`.

### `query_nodes`
Request node or entity data from any application that registers the `query_nodes` capability.
The optional `filter` object lets the requester narrow results; its contents are app-defined.
branchShredder returns `Info` and `Character` nodes from the currently-loaded project.

**Request** (any client → capable app):
```json
{
  "type": "query_nodes",
  "target": "some-app",
  "payload": {
    "filter": {
      "types": ["Info", "Character"],
      "includeSubnetworks": true
    }
  }
}
```

`filter` is optional.  branchShredder defaults: `types` → `["Info", "Character"]`; `includeSubnetworks` → `true`.

**Response** (capable app → requester):
```json
{
  "type": "query_nodes",
  "source": "some-app",
  "payload": {
    "nodes": [
      {
        "name": "The Shattered Compact",
        "type": "Info",
        "content": "Three hundred years ago the five kingdoms signed the Compact of Embers…",
        "stageNotes": "",
        "scenePath": "Root",
        "nodePaths": ["Start > The Shattered Compact"],
        "selectedCharacters": []
      },
      {
        "name": "Mira Ashford",
        "type": "Character",
        "content": "## Mira Ashford — Rogue Artificer\n\nAge: 28…",
        "stageNotes": "",
        "scenePath": "Root",
        "nodePaths": ["Mira Ashford  (no upstream connections)"],
        "selectedCharacters": []
      }
    ]
  }
}
```

If no data is available the response contains `"nodes": []` and an `"error"` field explaining why.

---

### `system_prompt`
Request the system prompt from any application that registers the `system_prompt` capability.
`fullSystemPrompt` is always present and ready to use.  The optional `parts` object exposes
named components so callers can reuse individual pieces — its keys are app-defined.
branchShredder populates `parts` with `appPrompt`, `scriptingPrompt`, and `projectContext`.

**Request** (any client → capable app):
```json
{
  "type": "system_prompt",
  "target": "some-app",
  "payload": {}
}
```

**Response** (capable app → requester):
```json
{
  "type": "system_prompt",
  "source": "some-app",
  "payload": {
    "fullSystemPrompt": "<complete ready-to-use system prompt>",
    "parts": {
      "appPrompt": "You are Nova, a creative writing AI…",
      "scriptingPrompt": "# Nova Node Scripting Reference\n…",
      "projectContext": "This story is a dark fantasy set in…"
    }
  }
}
```

| Field             | Description |
|-------------------|-------------|
| `fullSystemPrompt`| The complete system prompt, ready to pass directly to an LLM |
| `parts`           | Optional — named sub-components; keys and values are app-defined |

---

### `find_nodes`
Request a lightweight node index from any application that registers the `find_nodes` capability.
Returns nodes keyed by ID — suitable for building a picker list before fetching full content with `get_node`.
Unlike `query_nodes`, content fields are omitted to keep the response small.

**Request** (any client → capable app):
```json
{
  "type": "find_nodes",
  "target": "some-app",
  "payload": {
    "filter": {
      "types": ["Info", "Character"],
      "includeSubnetworks": true
    }
  }
}
```

`filter` is optional.  branchShredder defaults: `types` → `["Info", "Character"]`; `includeSubnetworks` → `true`.

**Response** (capable app → requester):
```json
{
  "type": "find_nodes",
  "source": "some-app",
  "payload": {
    "nodes": {
      "node-uuid-1": { "name": "The Shattered Compact", "type": "Info",      "scenePath": "Root", "nodePaths": ["Start > The Shattered Compact"] },
      "node-uuid-2": { "name": "Mira Ashford",          "type": "Character", "scenePath": "Root", "nodePaths": ["Mira Ashford  (no upstream connections)"] }
    }
  }
}
```

`nodes` is a dict keyed by node ID.  If no data is available the response contains `"nodes": {}` and an `"error"` field explaining why.

---

### `get_node`
Request the full content of a single node by its ID.

**Request** (any client → capable app):
```json
{
  "type": "get_node",
  "target": "some-app",
  "payload": {
    "nodeId": "node-uuid-1"
  }
}
```

**Response** (capable app → requester):
```json
{
  "type": "get_node",
  "source": "some-app",
  "payload": {
    "nodeId": "node-uuid-1",
    "name": "The Shattered Compact",
    "type": "Info",
    "content": "Three hundred years ago the five kingdoms signed the Compact of Embers…",
    "stageNotes": "",
    "scenePath": "Root",
    "nodePaths": ["Start > The Shattered Compact"],
    "selectedCharacters": []
  }
}
```

On failure: `{ "error": "Node '…' not found" }`.

---

### `update_node`
Write edited content or a new name back into the live scene.  Both fields are optional — omit either to leave it unchanged.

**Request** (any client → capable app):
```json
{
  "type": "update_node",
  "target": "some-app",
  "payload": {
    "nodeId": "node-uuid-1",
    "name": "The Shattered Compact (revised)",
    "content": "Updated lore text…"
  }
}
```

**Response** (capable app → requester):
```json
{
  "type": "update_node",
  "source": "some-app",
  "payload": {
    "nodeId": "node-uuid-1",
    "name": "The Shattered Compact (revised)",
    "status": "complete"
  }
}
```

On failure: `{ "nodeId": "…", "status": "error", "error": "…" }`.

---

### `system`
Application-level commands dispatched by action name.  Multiple actions may be batched in one request
via the `actions` array; a single action may also be given as a plain `action` string.

branchShredder supports the following actions:

| Action         | Description |
|----------------|-------------|
| `recent_scenes`| Return the list of recently opened projects |
| `open_recent`  | Open a project by absolute path (requires `path`) |
| `new_scene`    | Discard the current project and create a fresh empty one |
| `save_scene`   | Save the current project; provide `filename` to set the name (new projects are saved to `projects/`) |

**Request — single action** (any client → capable app):
```json
{
  "type": "system",
  "target": "some-app",
  "payload": { "action": "recent_scenes" }
}
```

**Request — batched actions**:
```json
{
  "type": "system",
  "target": "some-app",
  "payload": { "actions": ["recent_scenes", "new_scene"] }
}
```

**Request — open_recent**:
```json
{
  "type": "system",
  "target": "some-app",
  "payload": { "action": "open_recent", "path": "/absolute/path/to/MyStory.json" }
}
```

**Request — save_scene (new file)**:
```json
{
  "type": "system",
  "target": "some-app",
  "payload": { "action": "save_scene", "filename": "MyStory" }
}
```

`filename` may be a bare name (saved to `./projects/MyStory.json`) or an absolute path.  `.json` is
appended automatically if omitted.  Omit `filename` entirely to save in-place.

**Response** (capable app → requester):
```json
{
  "type": "system",
  "source": "some-app",
  "payload": {
    "results": {
      "recent_scenes": {
        "status": "complete",
        "scenes": [
          { "path": "/path/to/MyStory.json", "name": "MyStory" }
        ]
      },
      "open_recent": { "status": "complete", "name": "MyStory", "path": "/path/to/MyStory.json" }
    }
  }
}
```

Each key in `results` matches one requested action.  On per-action failure the value is
`{ "status": "error", "error": "…" }`.

---

### `attachment`
Transfer a file between clients using chunked base64 encoding.
See **Attachment Transfer** section below for details.

**Chunk message**:
```json
{
  "type": "attachment",
  "target": "llm-chat",
  "payload": {
    "transferId": "uuid-v4",
    "filename": "report.pdf",
    "chunkIndex": 0,
    "totalChunks": 3,
    "data": "base64-encoded-chunk-data...",
    "fileSize": 1572864
  }
}
```

**Progress ack** (receiver → sender):
```json
{
  "type": "attachment",
  "target": "mobile-phone",
  "payload": {
    "status": "receiving",
    "transferId": "uuid-v4",
    "chunkIndex": 0,
    "totalChunks": 3
  }
}
```

**Complete** (receiver → sender):
```json
{
  "type": "attachment",
  "target": "mobile-phone",
  "payload": {
    "status": "complete",
    "filename": "report.pdf",
    "filepath": "/path/to/saved/file",
    "fileSize": 1572864
  }
}
```

### `nickname`
Set a display nickname for a connected client (from mobile app).

```json
{
  "type": "nickname",
  "target": "server",
  "payload": {
    "clientName": "DESKTOP-ABC123",
    "nickname": "Work PC"
  }
}
```

### `ping` / `pong`
Keepalive heartbeat. Server sends `ping`, clients respond with `pong`.

```json
{ "type": "ping", "source": "server", "target": "all", "payload": {} }
{ "type": "pong", "source": "my-desktop", "target": "server", "payload": {} }
```

### `error`
Sent by server or client when something goes wrong.

```json
{
  "type": "error",
  "source": "server",
  "target": "mobile-phone",
  "payload": {
    "code": "TARGET_NOT_FOUND",
    "message": "Client 'research-pc' is not connected.",
    "referenceId": "original-message-uuid"
  }
}
```

---

## Attachment Transfer

Files are transferred over WebSocket using chunked base64 encoding.

| Limit | Value | Notes |
|-------|-------|-------|
| Max file size | **50 MB** | Configurable in `LLM_Chat/config.py` |
| Chunk size | **512 KB** | Base64-encoded; fits within all WebSocket frame limits |
| Frame limits | Python `websockets`: 1 MB default; Node.js `ws`: 100 MB default; Android WebView: ~16 MB | Chunking keeps each frame well under all limits |

**Flow:**
1. Sender checks file size against the 50 MB limit before starting
2. File is read, base64-encoded, split into 512 KB chunks
3. Each chunk is sent as a separate `attachment` message with `chunkIndex` and `totalChunks`
4. Receiver acknowledges each chunk and reassembles on completion
5. Completed file is saved to the `attachments/` directory

---

## Flags

Optional flags can be included in any message to modify behavior.

| Flag             | Type    | Default | Description |
|------------------|---------|---------|-------------|
| `priority`       | string  | `"normal"` | `"low"`, `"normal"`, `"high"` — hint for client processing order |
| `ack`            | boolean | `false` | Request delivery acknowledgment from the server |
| `silent`         | boolean | `false` | Suppress UI notification on the receiving client |
| `ttl`            | number  | `0`     | Time-to-live in seconds. `0` = no expiry. Server discards if expired before delivery. |
| `correlationId`  | string  | `""`    | Links a response to its original request `id` |
| `broadcast`      | boolean | `false` | When `true`, server sends to all clients (overrides `target`) |
| `encrypted`      | boolean | `false` | Reserved — indicates payload is encrypted (future use) |

### Flag Example

```json
{
  "flags": {
    "priority": "high",
    "ack": true,
    "correlationId": "abc-123-original-request-id",
    "ttl": 300
  }
}
```

---

## Error Codes

| Code                 | Description |
|----------------------|-------------|
| `TARGET_NOT_FOUND`   | The target client is not connected |
| `INVALID_MESSAGE`    | Message failed schema validation |
| `UNSUPPORTED_TYPE`   | The target client doesn't support this message type |
| `SCRIPT_NOT_FOUND`   | Requested script does not exist on the target |
| `EXECUTION_FAILED`   | Script execution failed |
| `RATE_LIMITED`        | Too many messages in a short period |
| `INTERNAL_ERROR`     | Unexpected server error |
| `CHAT_NOT_FOUND`     | Requested chat session does not exist |
| `ATTACHMENT_ERROR`   | Attachment transfer failed (size limit, corrupt, etc.) |
| `PROVIDER_UNAVAILABLE` | Requested LLM provider is not configured or offline |
| `DOWNLOAD_ERROR`     | Model download failed (bad URL, HTTP error, disk error) |

---

## Port Configuration

| Default Port | Protocol  | Usage |
|-------------|-----------|-------|
| **9734**    | WebSocket | All message relay traffic |

The port is configurable in each component's config file:
- `Server_Python/config.py`
- `Server_Nodejs/config.js`
- `Client_APK/app/src/main/assets/js/config.js`
- `LLM_Chat/config.py`

---

## Changelog

| Date       | Change |
|------------|--------|
| 2026-03-19 | Added `find_nodes`, `get_node`, `update_node` node management types |
| 2026-03-19 | Added `system` type with actions: `recent_scenes`, `open_recent`, `new_scene`, `save_scene` |
| 2026-03-19 | Generalized `bs_query_nodes` → `query_nodes`, `bs_system_prompt` → `system_prompt`; removed `bs_llm_chat` (merged into `llm_chat` via `nodeContext` field); renamed section to "Application Extension Message Types" |
| 2026-03-19 | Extended `llm_chat`: added optional `nodeContext` field; `model` now accepts `"provider:model_name"` shorthand |
| 2026-03-19 | Added `llm_chat_delete` response message (`chatName`, `deleted`) |
| 2026-03-19 | Added local model management types: `llm_local_models`, `llm_model_download` |
| 2026-03-19 | Added `DOWNLOAD_ERROR` error code |
| 2026-03-17 | Initial protocol specification |
| 2026-03-17 | Added LLM Chat types: `llm_announce`, `llm_modes`, `llm_chat`, `llm_chat_list`, `llm_chat_history`, `llm_chat_create`, `llm_chat_delete` |
| 2026-03-17 | Added `attachment` type with chunked base64 transfer |
| 2026-03-17 | Dynamic model discovery: providers now include `models[]` array fetched from APIs at startup; `llm_chat` requests accept optional `model` field |
