#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_apk.py

Increments versionName in Client_APK/app/build.gradle,
builds the Android APK via the Gradle wrapper (debug variant — signed with
the Android debug key, ready to sideload immediately), copies the result to:

  Client_APK/procMessenger-{version}.apk   <- versioned copy at project root
  data/transfers/{fileId}_{name}.apk       <- stored in shared transfers dir

…then prints a PROCMESSENGER_FILE_REGISTER line so the Server_Python handler
automatically updates metadata.json and sends a file_list_announce to the
WebSocket server, making the APK show up in the mobile File Browser.

Trigger from the mobile app:
  Function → Run Script → build_apk.py → Send Message

Or run directly:
  cd Server_Python/scripts
  python build_apk.py
"""

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

# Ensure stdout uses UTF-8 so print() never hits a codec error on Windows.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Path constants (resolved from this file's real location)
# ---------------------------------------------------------------------------
SCRIPT_DIR     = os.path.dirname(os.path.abspath(__file__))  # …/Server_Python/scripts/
SERVER_DIR     = os.path.dirname(SCRIPT_DIR)                 # …/Server_Python/
PROJECT_DIR    = os.path.dirname(SERVER_DIR)                 # …/procMessenger/

BUILD_GRADLE   = os.path.join(PROJECT_DIR, "Client_APK", "app", "build.gradle")
CLIENT_APK_DIR = os.path.join(PROJECT_DIR, "Client_APK")
TRANSFERS_DIR  = os.path.join(PROJECT_DIR, "data", "transfers")
META_FILE      = os.path.join(TRANSFERS_DIR, "metadata.json")

GRADLE_WRAPPER = os.path.join(
    CLIENT_APK_DIR,
    "gradlew.bat" if platform.system() == "Windows" else "gradlew",
)

# Where Gradle writes the debug APK
APK_SRC = os.path.join(
    CLIENT_APK_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk"
)

GRADLE_TIMEOUT = 600  # seconds – 10 minutes; first build may download dependencies

# ---------------------------------------------------------------------------
# Client name - read from config so ownerClient stays in sync with the
# registered WebSocket client name (avoids OWNER_NOT_CONNECTED errors).
# ---------------------------------------------------------------------------
sys.path.insert(0, SERVER_DIR)
try:
    import config as _client_config
    _CLIENT_NAME = _client_config.CLIENT_NAME
except ImportError:
    _CLIENT_NAME = "Python Runtime"

# ---------------------------------------------------------------------------
# Metadata helpers (mirrors Server_Python/handlers.py)
# ---------------------------------------------------------------------------

def _load_meta():
    os.makedirs(TRANSFERS_DIR, exist_ok=True)
    if not os.path.isfile(META_FILE):
        return []
    try:
        with open(META_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_meta(records):
    os.makedirs(TRANSFERS_DIR, exist_ok=True)
    with open(META_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)


def _upsert_meta(record):
    records = _load_meta()
    idx = next(
        (i for i, r in enumerate(records) if r.get("fileId") == record.get("fileId")),
        -1,
    )
    if idx >= 0:
        records[idx] = {**records[idx], **record}
    else:
        records.append(record)
    _save_meta(records)
    return record


# ---------------------------------------------------------------------------
# Version helpers
# ---------------------------------------------------------------------------

def increment_version(version_str: str) -> str:
    """'1.4' → '1.5',  '1.9' → '1.10',  '2.0.3' → '2.0.4'"""
    parts = version_str.strip().split(".")
    try:
        parts[-1] = str(int(parts[-1]) + 1)
    except (ValueError, IndexError):
        parts.append("1")
    return ".".join(parts)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    # ------------------------------------------------------------------
    # 1. Read build.gradle and extract current versions
    # ------------------------------------------------------------------
    if not os.path.isfile(BUILD_GRADLE):
        print(f"ERROR: build.gradle not found: {BUILD_GRADLE}", file=sys.stderr)
        return 1

    with open(BUILD_GRADLE, "r", encoding="utf-8") as fh:
        original_gradle = fh.read()

    m_vn = re.search(r'versionName\s+"([^"]+)"', original_gradle)
    if not m_vn:
        print("ERROR: versionName not found in build.gradle", file=sys.stderr)
        return 1
    old_version = m_vn.group(1)
    new_version = increment_version(old_version)

    # Apply updates
    updated_gradle = re.sub(
        r'(versionName\s+)"[^"]+"', f'\\1"{new_version}"', original_gradle
    )

    with open(BUILD_GRADLE, "w", encoding="utf-8") as fh:
        fh.write(updated_gradle)

    print(
        f"Version updated: {old_version} -> {new_version}"
    )

    # ------------------------------------------------------------------
    # 2. Invoke Gradle
    # ------------------------------------------------------------------
    if not os.path.isfile(GRADLE_WRAPPER):
        print(f"ERROR: Gradle wrapper not found: {GRADLE_WRAPPER}", file=sys.stderr)
        # Roll back gradle file
        with open(BUILD_GRADLE, "w", encoding="utf-8") as fh:
            fh.write(original_gradle)
        return 1

    if platform.system() != "Windows":
        os.chmod(GRADLE_WRAPPER, 0o755)

    if platform.system() == "Windows":
        gradle_cmd = ["cmd", "/c", GRADLE_WRAPPER, "assembleDebug", "--no-daemon"]
    else:
        gradle_cmd = [GRADLE_WRAPPER, "assembleDebug", "--no-daemon"]

    print(f"Running Gradle assembleDebug for version {new_version}...")
    try:
        gradle_result = subprocess.run(
            gradle_cmd,
            cwd=CLIENT_APK_DIR,
            capture_output=True,
            text=True,
            timeout=GRADLE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        print(
            f"ERROR: Gradle timed out after {GRADLE_TIMEOUT}s.", file=sys.stderr
        )
        with open(BUILD_GRADLE, "w", encoding="utf-8") as fh:
            fh.write(original_gradle)
        return 1

    if gradle_result.returncode != 0:
        print(
            f"ERROR: Gradle build failed (exit {gradle_result.returncode})",
            file=sys.stderr,
        )
        # Print last 4000 chars of output for diagnosis
        combined = (gradle_result.stdout or "") + (gradle_result.stderr or "")
        print(combined[-4000:], file=sys.stderr)
        # Roll back
        with open(BUILD_GRADLE, "w", encoding="utf-8") as fh:
            fh.write(original_gradle)
        return 1

    print("Gradle build succeeded.")

    # ------------------------------------------------------------------
    # 3. Locate the built APK
    # ------------------------------------------------------------------
    if not os.path.isfile(APK_SRC):
        print(f"ERROR: Expected APK not found: {APK_SRC}", file=sys.stderr)
        return 1

    apk_name = f"procMessenger-{new_version}.apk"

    # ------------------------------------------------------------------
    # 4. Copy to Client_APK/ root (versioned, easy to find)
    # ------------------------------------------------------------------
    apk_client_dest = os.path.join(CLIENT_APK_DIR, apk_name)
    shutil.copy2(APK_SRC, apk_client_dest)
    print(f"APK -> {apk_client_dest}")

    # ------------------------------------------------------------------
    # 5. Copy to transfers/ and register in metadata.json
    # ------------------------------------------------------------------
    apk_size   = os.path.getsize(apk_client_dest)
    file_id    = f"build-apk-{new_version.replace('.', '_')}"
    stored_path = os.path.join(TRANSFERS_DIR, apk_name)   # same name as fileName
    now_iso     = datetime.now(timezone.utc).isoformat()

    os.makedirs(TRANSFERS_DIR, exist_ok=True)
    shutil.copy2(apk_client_dest, stored_path)

    record = _upsert_meta(
        {
            "fileId":      file_id,
            "fileName":    apk_name,
            "fileType":    "application/vnd.android.package-archive",
            "fileSize":    apk_size,
            "storedPath":  stored_path,
            "source":      "build_apk.py",
            "target":      "server",
            "sentAt":      now_iso,
            "storedAt":    now_iso,
            "storedBy":    _CLIENT_NAME,
            "ownerClient": _CLIENT_NAME,
        }
    )

    print(f"Registered in transfers: {apk_name} ({apk_size:,} bytes)")

    # ------------------------------------------------------------------
    # 6. Signal the handler to run a file_list_announce
    #    The Server_Python/handlers.py parses this prefix and calls
    #    _upsert_meta, then includes registeredFiles in the response,
    #    which causes client.py to send a file_list_announce to the
    #    WebSocket server → broadcasts updated file list to all clients.
    # ------------------------------------------------------------------
    print(f"PROCMESSENGER_FILE_REGISTER:{json.dumps(record)}")

    print(f"Build complete: {apk_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
