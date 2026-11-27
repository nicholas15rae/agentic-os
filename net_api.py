"""NetBird path — is the phone's link to this PC direct (P2P) or relayed?

GET /api/net/path runs `netbird status --json` (3 s timeout, off the event loop, one shared
snapshot cached ~5 s) and answers with the caller's own peer: the one whose NetBird IP is the
request's source address. The phone's request itself crosses the tunnel, so its peer is live
while it asks. A loopback caller (the desktop) gets every peer instead.

What it returns per peer: name, mesh IP, status, connection type (P2P / Relayed), the ICE
candidate TYPES (host / srflx / prflx / relay), the relay's host name (only when relayed),
latency, last WireGuard handshake and the lazy-connection flag. What it never returns: public
keys, ICE candidate endpoints, transfer counters, or any address outside the mesh (a relay
given as a bare IP is withheld, since it could be a public address).

Auth: the same as every other /api route (server.ZeroTrustMiddleware: loopback is trusted, the
mesh needs the gateway token while the network lock is on). Read-only: nothing here changes
NetBird, the firewall or the router.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api/net", tags=["net"])

TIMEOUT_S = 3.0
CACHE_TTL_S = 5.0
DEFAULT_EXE = r"C:\Program Files\Netbird\netbird.exe"
_ZERO_TIME = "0001-01-01T00:00:00Z"

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "data": None, "error": None}


def _exe() -> str:
    return shutil.which("netbird") or (DEFAULT_EXE if os.path.isfile(DEFAULT_EXE) else "netbird")


def _run_status() -> dict:
    """One `netbird status --json` call. Raises RuntimeError with a short, value-free reason."""
    try:
        proc = subprocess.run(
            [_exe(), "status", "--json"],
            capture_output=True,
            timeout=TIMEOUT_S,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
        )
    except FileNotFoundError:
        raise RuntimeError("netbird CLI not found")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"netbird status timed out after {TIMEOUT_S:.0f} s")
    if proc.returncode != 0:
        raise RuntimeError(f"netbird status exited {proc.returncode}")
    try:
        data = json.loads(proc.stdout.decode("utf-8-sig", "replace"))
    except ValueError:
        raise RuntimeError("netbird status gave no JSON")
    if not isinstance(data, dict):
        raise RuntimeError("netbird status gave no JSON")
    return data


def status_snapshot(now: Optional[float] = None) -> dict:
    """The cached status (≤ CACHE_TTL_S old). Failures are cached too, so a missing or hung
    CLI costs one 3 s call per TTL, not one per request. The lock makes concurrent callers
    share one subprocess."""
    with _lock:
        t = time.monotonic() if now is None else now
        if _cache["at"] and t - _cache["at"] < CACHE_TTL_S:
            if _cache["error"]:
                raise RuntimeError(_cache["error"])
            return _cache["data"]
        try:
            data = _run_status()
        except RuntimeError as e:
            _cache.update(at=t, data=None, error=str(e))
            raise
        _cache.update(at=t, data=data, error=None)
        return data


def clear_cache() -> None:
    with _lock:
        _cache.update(at=0.0, data=None, error=None)


def _host_only(addr: str) -> Optional[str]:
    """'rels://streamline-us-chi1-4.relay.netbird.io:443' → 'streamline-us-chi1-4.relay.netbird.io'.
    A bare IP (v4 or v6) gives None: it may be a public address."""
    if not addr:
        return None
    rest = addr.split("://", 1)[1] if "://" in addr else re.sub(r"^(?:turns?|stuns?|rels?):", "", addr)
    rest = rest.split("/", 1)[0].split("?", 1)[0]
    if rest.startswith("["):  # [v6]:port
        return None
    host = rest.rsplit(":", 1)[0] if rest.count(":") == 1 else rest
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        return host or None


def _ip(value: Any) -> str:
    return str(value or "").split("/", 1)[0].strip()


def _str_or_none(value: Any) -> Optional[str]:
    s = str(value or "").strip()
    return None if s in ("", "-") else s


def peer_view(p: dict, lazy: Optional[bool]) -> dict:
    """The safe subset of one peer. Built field by field (an allowlist), so a new field in a
    future NetBird release can't leak through."""
    path = _str_or_none(p.get("connectionType"))
    ice = p.get("iceCandidateType") or {}
    if not isinstance(ice, dict):
        ice = {}
    latency = p.get("latency")
    latency_ms = round(latency / 1e6, 1) if isinstance(latency, (int, float)) and latency > 0 else None
    handshake = _str_or_none(p.get("lastWireguardHandshake"))
    fqdn = str(p.get("fqdn") or "")
    return {
        "peer": fqdn.split(".", 1)[0] or None,
        "ip": _ip(p.get("netbirdIp")) or None,
        "status": _str_or_none(p.get("status")) or "unknown",
        "path": path,
        "iceLocal": _str_or_none(ice.get("local")),
        "iceRemote": _str_or_none(ice.get("remote")),
        # relayAddress is filled in on P2P links too (it's the fallback): only show it when used.
        "relayHost": _host_only(str(p.get("relayAddress") or "")) if path == "Relayed" else None,
        "latencyMs": latency_ms,
        "lastHandshake": None if handshake in (None, _ZERO_TIME) else handshake,
        "lazy": lazy,
    }


def _norm_client(host: str) -> str:
    h = (host or "").strip()
    if h.lower().startswith("::ffff:"):
        h = h[7:]
    return h


def _is_loopback(request: Request) -> bool:
    """server.ZeroTrustMiddleware's trusted path: loopback and not through a tunnel."""
    host = _norm_client(request.client.host if request.client else "")
    loopback = host in ("127.0.0.1", "::1", "localhost") or host.startswith("127.")
    proxied = any(h in request.headers for h in ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"))
    return loopback and not proxied


def path_for(data: dict, client_host: str, loopback: bool) -> dict:
    """Pure: the response for one caller, from one status snapshot."""
    lazy = data.get("lazyConnectionEnabled")
    lazy = lazy if isinstance(lazy, bool) else None
    peers = (data.get("peers") or {}).get("details") or []
    peers = [p for p in peers if isinstance(p, dict)]
    if loopback:
        return {"lazy": lazy, "peers": [peer_view(p, lazy) for p in peers]}
    host = _norm_client(client_host)
    for p in peers:
        if host and host in (_ip(p.get("netbirdIp")), _ip(p.get("netbirdIpv6"))):
            return peer_view(p, lazy)
    # Not a peer this PC knows (or not on the mesh): nothing to show, and nothing leaked.
    return {"peer": None, "ip": None, "status": "unknown", "path": None, "iceLocal": None, "iceRemote": None, "relayHost": None, "latencyMs": None, "lastHandshake": None, "lazy": lazy}


@router.get("/path")
async def net_path(request: Request):
    try:
        data = await run_in_threadpool(status_snapshot)
    except RuntimeError as e:
        raise HTTPException(503, f"NetBird status unavailable: {e}")
    return path_for(data, request.client.host if request.client else "", _is_loopback(request))
