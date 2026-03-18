# procMessenger
## Local Network Messaging — PC <> Phone
### With local LLM Chat access available

Send commands from your phone to your computers over the local network.

A standardized JSON/WebSocket protocol routes messages between an Android app and any number of PC clients running Python or Node.js.

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
- **PC Clients** - Connect to the server and handle messages (run scripts, research, story editing, etc).

---

### Project Structure

```
procMessenger/
├── Protocol.md              # Message protocol specification & flags
├── ReadMe.md
│
├── Server_Python/           # Python server + client
│   ├── config.py            # Port, name, capabilities
│   ├── server.py            # WebSocket server (routing, registry)
│   ├── client.py            # Client (auto-starts server if needed)
│   ├── handlers.py          # Message handlers (run_script, edit_story, etc)
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

| Type               | Direction         | Description |
|--------------------|-------------------|-------------|
| `run_script`       | Mobile → PC       | List or execute scripts on a target computer |
| `gather_research`  | Mobile → PC       | Web search via local LLM + Search API + Puppeteer |
| `edit_story`       | Mobile ↔ PC       | Relay messages to/from a story editor program |

See [Protocol.md](Protocol.md) for the full specification, message formats, flags, and error codes.

---

### Quick Start

**1. Start the server** (pick Python or Node.js):


On Windows; check for dependencies & run server -

Double click the `Start.bat` file in either Server_Nodejs or Server_Python
To run it in a CMD -
```
# Python
cd Server_Python
.\Start.bat

# Node.js
cd Server_Nodejs
.\Start.bat
```

To set the server to boot with your computer, `startup`
Run the `add_startup_script.bat` from your desired Server directory or `LLM_Chat`

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
So the server messenging may get some features addressing aspects outside of this project.  Please see the branchShredder repo in that case.


