"""
tailscale_vpn.py - Tailscale utility for procMessenger

Detects whether Tailscale is active on this machine and retrieves the
assigned Tailscale IP address (100.64.0.0/10 range).

Importable by the Python server, or run directly for diagnostics:
    python tailscale_vpn.py
"""

import json
import logging
import subprocess
import sys

logger = logging.getLogger(__name__)

# Tailscale assigns IPs in the CGNAT range 100.64.0.0/10
# (second octet 64–127)
_TS_SECOND_OCTET_MIN = 64
_TS_SECOND_OCTET_MAX = 127


def _is_tailscale_ip(ip: str) -> bool:
    """Return True if the IP falls within Tailscale's 100.64.0.0/10 range."""
    try:
        parts = ip.strip().split(".")
        if len(parts) != 4 or parts[0] != "100":
            return False
        return _TS_SECOND_OCTET_MIN <= int(parts[1]) <= _TS_SECOND_OCTET_MAX
    except (ValueError, IndexError):
        return False


def get_tailscale_ip() -> str | None:
    """
    Retrieve this machine's Tailscale IPv4 address.

    Tries `tailscale ip --4` first; falls back to parsing
    `tailscale status --json` for older Tailscale builds.

    Returns the IP string (e.g. '100.x.x.x'), or None if Tailscale is
    not running or not installed.
    """
    # On Windows the binary may be 'tailscale.exe' or just 'tailscale' via PATH
    cli_candidates = ["tailscale", "tailscale.exe"] if sys.platform == "win32" else ["tailscale"]

    for cli in cli_candidates:
        # --- Method 1: tailscale ip --4 ---
        try:
            result = subprocess.run(
                [cli, "ip", "--4"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if result.returncode == 0:
                ip = result.stdout.strip()
                if _is_tailscale_ip(ip):
                    return ip
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass

        # --- Method 2: tailscale status --json (broader compatibility) ---
        try:
            result = subprocess.run(
                [cli, "status", "--json"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if result.returncode == 0:
                status = json.loads(result.stdout)
                for ip in status.get("Self", {}).get("TailscaleIPs", []):
                    if _is_tailscale_ip(str(ip)):
                        return str(ip)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError, json.JSONDecodeError, ValueError):
            pass

    return None


def is_tailscale_running() -> bool:
    """Return True if Tailscale is currently active and has an assigned IP."""
    return get_tailscale_ip() is not None


def log_connection_info(port: int, log: logging.Logger | None = None) -> None:
    """
    Log available WebSocket connection addresses for a server on `port`.
    Includes the Tailscale address when available.
    Accepts an optional logger; falls back to the module logger.
    """
    log = log or logger
    ts_ip = get_tailscale_ip()
    log.info(f"  Local:     ws://127.0.0.1:{port}")
    if ts_ip:
        log.info(f"  Tailscale: ws://{ts_ip}:{port}  ← use this address on remote/mobile clients")
    else:
        log.info("  Tailscale: not running - mobile clients must use the LAN IP instead")


# ---------------------------------------------------------------------------
# CLI usage: python tailscale_vpn.py
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ts_ip = get_tailscale_ip()
    if ts_ip:
        print(f"Tailscale is running.  IP: {ts_ip}")
    else:
        print("Tailscale is not running or not installed on this machine.")
