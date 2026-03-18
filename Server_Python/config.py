# Server_Python Configuration

HOST = "0.0.0.0"
PORT = 9734

# Name this client uses when registering with the server
CLIENT_NAME = "python-client"

# Capabilities this client advertises
CAPABILITIES = ["run_script", "edit_story"]

# Directory containing scripts that can be executed via "run_script"
SCRIPTS_DIR = "./scripts"

# Ping interval in seconds (keepalive)
PING_INTERVAL = 30

# Ping timeout — disconnect if no pong within this many seconds
PING_TIMEOUT = 10
