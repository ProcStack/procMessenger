# procMessenger
### Local Network Messaging; PC <> Phone
#### With local/API LLM Chat access

<p align='center'>
  <img src="Images/procMessenger_header_alpha.png" alt="procMessenger top image" />
</p>

Send commands from your phone to your computers over the local network.

There is a standardized JSON/WebSocket `protocol.md` file; showing message routes between the Android app and any number of services running through Python or Node.js.

---

### Architecture

```
┌─────────────┐       WebSocket (port 9734)       ┌───────────────────┐
│  Mobile App │ <-------------------------------> │  WebSocket Server │
│  (Android)  │                                   │  (Python or Node) │
└─────────────┘                                   └────────┬──────────┘
                                                           │
                                          ┌────────────────┼────────────────┐
                                          │                │                │
                                    ┌─────┴─────┐    ┌─────┴─────┐    ┌─────┴─────┐
                                    │  Python   │    │  Node.js  │    │  More...  │
                                    │  Client   │    │  Client   │    │  Clients  │
                                    └───────────┘    └───────────┘    └───────────┘
```

- **Server** - Either the Python or Node.js instance can be the server. The first to start claims the port; others connect as clients.
- **Mobile App** - Android APK with a WebView UI (vanilla HTML/CSS/JS, no frameworks). Connects to the server via WebSocket.
  - *Sorry, I'm using this project as a way to develop my spa javascript framework `procPages`, so I'm not using React or Nextjs... They added decorators to javascript, so why not make a framework?*
- **PC Clients** - Connect to the server and handle messages (run scripts, research, story editing, etc).

---

### Project Structure

```
procMessenger/
├── Protocol.md              # Message protocol specification & flags
├── ReadMe.md                # It's this file!
├── tailscale_vpn.py         # Tailscale VPN helper
├── Images/                  # Project images & assets
├── transfers/               # File transfer staging directory
│
├── LLM_Chat/                # Local/API LLM chat service
│   ├── config.py            # Provider config, model paths, .env keys
│   ├── llm_client.py        # WebSocket client + message handler
│   ├── llm_providers.py     # Provider adapters (Llama, Claude, OpenAI, etc)
│   ├── chat_history.py      # Chat session persistence helpers
│   ├── attachments.py       # File/image attachment handling
│   ├── System.md            # LLM system prompt
│   ├── message_functions.json # Function/tool definitions for agent mode
│   ├── requirements.txt
│   ├── start.bat
│   ├── add_startup_script.bat
│   ├── chat_history/        # Persisted chat session JSON files
│   └── models/              # Local GGUF model files
│
├── Server_Python/           # Python server + client
│   ├── config.py            # Port, name, capabilities
│   ├── server.py            # WebSocket server (routing, registry)
│   ├── client.py            # Client (auto-starts server if needed)
│   ├── handlers.py          # Message handlers (run_script, file_list, etc)
│   ├── requirements.txt
│   └── scripts/             # Executable scripts for "Run Script"
│
├── Server_Nodejs/           # Node.js server + client
│   ├── config.js            # Port, name, capabilities
│   ├── server.js            # WebSocket server (routing, registry)
│   ├── client.js            # Client (auto-starts server if needed)
│   ├── handlers.js          # Message handlers (run_script, gather_research, etc)
│   ├── package.json
│   └── scripts/             # Executable scripts for "Run Script"
│
└── Client_APK/              # Android mobile app
    ├── build.gradle
    ├── settings.gradle
    └── app/
        ├── build.gradle
        └── src/main/
            ├── AndroidManifest.xml
            ├── java/com/procmessenger/app/
            │   └── MainActivity.java
            └── assets/
                ├── index.html
                ├── css/style.css
                └── js/
                    ├── config.js
                    ├── websocket.js
                    └── app.js
```

---

### Message Types

**Core - PC Clients**

| Type              | Direction    | Description |
|-------------------|--------------|-------------|
| `run_script`      | Mobile → PC  | List or execute scripts on a target computer |
| `edit_story`      | Mobile ↔ PC  | Relay messages to/from a story editor program |
| `gather_research` | Mobile → PC  | Web search via LLM + Search API + Puppeteer *(Node.js)* |
| `file_list`       | Mobile ↔ PC  | Browse files available on a target computer |
| `file_fetch`      | Mobile → PC  | Request a file from a target computer |
| `file_receive`    | PC → Mobile  | Deliver file chunks back to mobile |

**LLM Chat - `LLM_Chat` service**

| Type                | Direction          | Description |
|---------------------|--------------------|-------------|
| `llm_chat`          | Mobile ↔ LLM Chat  | Send a message and receive a response |
| `llm_modes`         | Mobile ↔ LLM Chat  | Request available providers, modes, and models |
| `llm_chat_list`     | Mobile ↔ LLM Chat  | List saved chat sessions |
| `llm_chat_history`  | Mobile ↔ LLM Chat  | Load full message history for a session |
| `llm_chat_create`   | Mobile → LLM Chat  | Create a new named chat session |
| `llm_chat_delete`   | Mobile → LLM Chat  | Delete a chat session |
| `attachment`        | Mobile → LLM Chat  | Send a file or image as LLM context |
| `llm_local_models`  | Mobile ↔ LLM Chat  | Scan/list local GGUF model files |
| `llm_model_download`| Mobile → LLM Chat  | Download a remote model |

**Application Extensions - e.g. branchShredder**

| Type            | Direction    | Description |
|-----------------|--------------|-------------|
| `query_nodes`   | Mobile ↔ PC  | Get all graph nodes with full content |
| `find_nodes`    | Mobile ↔ PC  | Get lightweight node index |
| `get_node`      | Mobile ↔ PC  | Retrieve a single node by ID |
| `update_node`   | Mobile → PC  | Update a node's name or content |
| `system_prompt` | Mobile ↔ PC  | Retrieve the application's active system prompt |
| `system`        | Mobile ↔ PC  | Scene/system control commands |

See [Protocol.md](Protocol.md) for the full specification, message formats, flags, and error codes.

---

### Quick Start

<p align='center'>
  <img src="Client_APK/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp" alt="procMessenger App Icon" />
  <br/>procMessenger Android App Icon
</p>

#### Mobile -

In `./Client_APK` you'll find an apk in the root of the directory.  I haven't submitted it to any playstores yet, so you'll need to manually install it.

All of the code is right there, if you want to re-build the APK for yourself, open the `Client_APK` folder in `Android Studio` and --
<br/>Click the 4 lines in the upper left, it'll show the rest of the top menu ... Why did they need to do that?
<br/>Go to - `Build > Build App Bundle(s) / APK(s) > Build APK(s)`

Once built, it'll be in the `debug` folder (Unless you build a signed APK, then it will be in `release`)
<br/>`./Client_APK/app/build/outputs/apk/debug/app-debug.apk`

#### Computer -

**1. Start the server** (pick Python or Node.js):


On Windows; check for dependencies & run server -

Double click the `Start.bat` file in either Server_Nodejs or Server_Python
To run it in a CMD -
```
# Python
cd Server_Python
.\start_server.bat
# or 
.\start_client.bat

# Node.js
cd Server_Nodejs
.\start_server.bat
# or 
.\start_client.bat
```

To set the server to boot with your computer, `startup`
<br/>&nbsp;&nbsp; Run the `add_startup_script.bat` from your desired Server directory or `LLM_Chat`
<br/>&nbsp;&nbsp; The script installed is the client script, to boot Server & Client

-or-

Manually install the servers; Not running the BAT file
```
# Python
cd Server_Python
pip install -r requirements.txt
python server.py

# Node.js
cd Server_Nodejs
npm install
npm run server
```

**2. Connect a client** (from another terminal or another machine):

```
# Python client; auto-starts server if none found
cd Server_Python
python client.py

# Node.js client; auto-starts server if none found
cd Server_Nodejs
npm run client
```

**3. Build and install the mobile app:**

Open `Client_APK/` in Android Studio, build the APK, and install on your phone. Enter your server's LAN IP address and port 9734 in the connection bar.


**4. OPTIONAL - Install local LLM support:**

Llama uses `llama-cpp-python`, if you don't already have it installed, there is a cuda version, as the default installs CPU only.

To test if you have the CUDA version built/installed correctly, or check `llama-cpp-python` is installed, you can run this -
```
python -c "import llama_cpp; print('GPU offload:', llama_cpp.llama_supports_gpu_offload())"
```
It'll say `True` for GPU usage

If it says `False`, or errors to load `llama-cpp`, then run -

`pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124 --force-reinstall`

Change `cu124` to -
 - `cu121` for CUDA 12.1
 - `cu122` for CUDA 12.2
 - `cu123` for CUDA 12.3
 - `cu124` for CUDA 12.4

To find your CUDA version run - `nvcc --version`
<br/> Look for - `Build cuda_##.#...`

*NOTE*: I only got CUDA working by building it myself in powershell -
```
$env:CMAKE_ARGS="-DGGML_CUDA=on"
pip install llama-cpp-python --force-reinstall --no-cache-dir
```

---

### Configuration

| Setting     | Python               | Node.js             | Mobile                    |
|-------------|----------------------|---------------------|---------------------------|
| Port        | `config.py > PORT`   | `config.js > PORT`  | `js/config.js > PORT`     |
| Client name | `config.py > CLIENT_NAME` | `config.js > CLIENT_NAME` | `js/config.js > CLIENT_NAME` |
| Server IP   | N/A (is the server)  | N/A (is the server) | `js/config.js > SERVER_IP` or set in the app UI |

---

### Notes

- **Port 9734** was chosen to avoid conflicts with common development ports (3000, 8080, 8443, etc).
- **WebSocket** was chosen for better support across Android WebView, Python, and Node.js. May look into using WebRTC if I enable screen sharing to mobile.  Not sure if I can do a sip handshake locally or not.  AI would know.
- The mobile app is a **WebView-based APK** - an installable Android app. The UI is plain HTML/CSS/JS for easy customization.
- Python is best suited for: terminal command execution, story editor integration.
- Node.js is best suited for: Puppeteer-based web research, browser automation.

I'm developing `procMessenger` as a way to work on my `branchShredder` projects; my branching narritive graph visualizer.
 - [Branch Shredder Repo](https://github.com/ProcStack/branchShredder)
<br/>So the server messenging may get some features addressing aspects outside of this project.  Please see the branchShredder repo in that case.


