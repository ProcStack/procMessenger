"""
procMessenger — Python Message Handlers

Runtime functionality for handling incoming messages.
This file is imported by client.py to process messages received from the server.
"""

import os
import json
import subprocess
import logging

import config

logger = logging.getLogger("procMessenger.handlers")


def get_available_scripts():
    """Scan the scripts directory and return a list of available scripts."""
    scripts = []
    scripts_dir = os.path.abspath(config.SCRIPTS_DIR)

    if not os.path.isdir(scripts_dir):
        os.makedirs(scripts_dir, exist_ok=True)
        return scripts

    for filename in os.listdir(scripts_dir):
        filepath = os.path.join(scripts_dir, filename)
        if os.path.isfile(filepath):
            scripts.append({
                "name": filename,
                "description": f"Script: {filename}",
            })
    return scripts


def execute_script(script_name, args=None):
    """
    Execute a script by name from the scripts directory.
    Returns dict with exitCode, stdout, stderr.
    """
    scripts_dir = os.path.abspath(config.SCRIPTS_DIR)
    script_path = os.path.join(scripts_dir, script_name)

    # Security: ensure the script is within the scripts directory
    real_scripts_dir = os.path.realpath(scripts_dir)
    real_script_path = os.path.realpath(script_path)
    if not real_script_path.startswith(real_scripts_dir + os.sep):
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": "Security error: path traversal detected.",
        }

    if not os.path.isfile(real_script_path):
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": f"Script not found: {script_name}",
        }

    cmd = [real_script_path]
    if args:
        # Only allow string arguments
        cmd.extend(str(a) for a in args)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=real_scripts_dir,
        )
        return {
            "exitCode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": "Script execution timed out (120s limit).",
        }
    except Exception as e:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": str(e),
        }


def handle_run_script(payload):
    """
    Handle a run_script message.
    Returns a response payload dict.
    """
    action = payload.get("action", "")

    if action == "list_scripts":
        scripts = get_available_scripts()
        return {
            "action": "script_list",
            "scripts": scripts,
        }

    if action == "execute":
        script_name = payload.get("scriptName", "")
        args = payload.get("args", [])
        if not script_name:
            return {
                "action": "result",
                "scriptName": "",
                "exitCode": -1,
                "stdout": "",
                "stderr": "No scriptName provided.",
            }
        result = execute_script(script_name, args)
        return {
            "action": "result",
            "scriptName": script_name,
            **result,
        }

    return {
        "action": "error",
        "message": f"Unknown run_script action: {action}",
    }


def handle_edit_story(payload):
    """
    Handle an edit_story message.
    This is a passthrough — the message content is forwarded to the story editor.
    Override this function to integrate with your story editor program.
    """
    message = payload.get("message", "")
    logger.info(f"Edit Story request: {message}")

    # Placeholder: echo back the message
    return {
        "message": f"[Story Editor] Received: {message}",
        "status": "received",
    }


def handle_message(msg):
    """
    Main dispatcher — routes a parsed message to the appropriate handler.
    Returns a response payload, or None if no response is needed.
    """
    msg_type = msg.get("type", "")
    payload = msg.get("payload", {})

    if msg_type == "run_script":
        return "run_script", handle_run_script(payload)

    if msg_type == "edit_story":
        return "edit_story", handle_edit_story(payload)

    if msg_type == "gather_research":
        # Placeholder — requires LLM + Search API + Puppeteer integration
        logger.info(f"Gather Research request: {payload.get('query', '')}")
        return "gather_research", {
            "status": "unsupported",
            "message": "Gather Research is not yet implemented on this Python client.",
        }

    return None, None
