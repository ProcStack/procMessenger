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
    "mode": "ask"
  }
}
```

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

```json
{
  "type": "llm_chat_delete",
  "target": "llm-chat",
  "payload": { "chatName": "Old Chat" }
}
```

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
| 2026-03-17 | Initial protocol specification |
| 2026-03-17 | Added LLM Chat types: `llm_announce`, `llm_modes`, `llm_chat`, `llm_chat_list`, `llm_chat_history`, `llm_chat_create`, `llm_chat_delete` |
| 2026-03-17 | Added `attachment` type with chunked base64 transfer |
| 2026-03-17 | Dynamic model discovery: providers now include `models[]` array fetched from APIs at startup; `llm_chat` requests accept optional `model` field |
