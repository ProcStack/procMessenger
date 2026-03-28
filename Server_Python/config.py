# Server_Python Configuration
import os

HOST = "0.0.0.0"
PORT = 9734

# Name this client uses when registering with the server
CLIENT_NAME = "Python Runtime"

# Capabilities this client advertises
CAPABILITIES = ["run_script", "edit_story", "file_transfers"]

# Directory containing scripts that can be executed via "run_script"
SCRIPTS_DIR = "./scripts"

# Shared transfers directory - both Node.js and Python servers read/write here.
TRANSFERS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data", "transfers"))
TOPICS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data", "topics"))

# Ping interval in seconds (keepalive)
PING_INTERVAL = 30

# Ping timeout - disconnect if no pong within this many seconds
PING_TIMEOUT = 10
