"""Where Nic is logged in (section pass): per-device gateway tokens with a sign-out per device.

Before this, every remote device (the phone, a laptop) used ONE shared token in
data/command-center/gateway.token, so "sign out the phone" meant rotating it for everyone. Now the
desktop app can issue a token per device. Only its SHA-256 is stored, in
data/command-center/devices.json, with the device's name, kind and when it was last seen. Signing a
device out revokes its token on the spot. The old shared token keeps working (nothing breaks), and
devices still using it are listed by address as "shared token".

Managing devices is desktop-only: the /api/devices routes answer loopback callers (the desktop
app on this PC) and nobody else, whatever token they hold.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

FILE = Path(__file__).parent / "data" / "command-center" / "devices.json"
KINDS = ("phone", "laptop", "desktop", "tablet", "other")
SEEN_EVERY_S = 60  # last-seen is written at most once a minute per device
_lock = threading.Lock()
_seen_at: dict[str, float] = {}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _load(path: Path = FILE) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("devices"), list):
            return data
    except (OSError, ValueError):
        pass
    return {"devices": []}


def _save(data: dict[str, Any], path: Path = FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".tmp-{os.getpid()}-{threading.get_ident()}")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    for i in range(5):  # Windows: a reader may hold the file for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == 4:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def public(d: dict[str, Any]) -> dict[str, Any]:
    """A device as the UI sees it: never its token hash."""
    return {k: v for k, v in d.items() if k != "tokenHash"}


def add(name: str, kind: str, now: float | None = None, path: Path = FILE) -> tuple[dict[str, Any], str]:
    """Register a device; returns it and its token (shown once, never stored)."""
    name = " ".join((name or "").split())[:40] or "Device"
    kind = kind if kind in KINDS else "other"
    token = secrets.token_urlsafe(32)
    dev = {"id": "dev-" + secrets.token_hex(6), "name": name, "kind": kind, "tokenHash": _hash(token), "createdAt": now or time.time(), "lastSeen": None, "lastIp": None, "userAgent": None, "revokedAt": None}
    with _lock:
        data = _load(path)
        data["devices"].append(dev)
        _save(data, path)
    return dev, token


def revoke(dev_id: str, now: float | None = None, path: Path = FILE) -> bool:
    """Sign a device out: its token stops working at once. Shared-token rows can't be revoked one by one."""
    with _lock:
        data = _load(path)
        hit = False
        for d in data["devices"]:
            if d.get("id") == dev_id and not d.get("revokedAt") and d.get("kind") != "shared":
                d["revokedAt"] = now or time.time()
                hit = True
        if hit:
            _save(data, path)
        return hit


def match(token: str, path: Path = FILE) -> dict[str, Any] | None:
    """The live device this token belongs to (constant-time compare), else None."""
    if not token:
        return None
    h = _hash(token)
    for d in _load(path)["devices"]:
        if not d.get("revokedAt") and d.get("kind") != "shared" and hmac.compare_digest(str(d.get("tokenHash", "")), h):
            return d
    return None


def seen(dev_id: str, ip: str, ua: str, now: float | None = None, path: Path = FILE, name: str | None = None, kind: str | None = None) -> None:
    """Record activity (throttled). An unknown id with a `kind` creates a row (shared-token / local)."""
    now = now or time.time()
    if now - _seen_at.get(dev_id, 0) < SEEN_EVERY_S:
        return
    _seen_at[dev_id] = now
    # Best effort: a failed last-seen write must never fail the request it rides on.
    try:
        with _lock:
            data = _load(path)
            row = next((d for d in data["devices"] if d.get("id") == dev_id), None)
            if row is None:
                if not kind:
                    return
                row = {"id": dev_id, "name": name or dev_id, "kind": kind, "createdAt": now, "revokedAt": None}
                data["devices"].append(row)
            row.update({"lastSeen": now, "lastIp": ip, "userAgent": (ua or "")[:160]})
            _save(data, path)
    except Exception:
        _seen_at.pop(dev_id, None)


def listing(path: Path = FILE) -> list[dict[str, Any]]:
    """Every device, signed-in first then most recently seen; revoked ones last."""
    devs = [public(d) for d in _load(path)["devices"]]
    return sorted(devs, key=lambda d: (bool(d.get("revokedAt")), -(d.get("lastSeen") or d.get("createdAt") or 0)))


def _guess_kind(ua: str) -> str:
    u = (ua or "").lower()
    return "phone" if ("android" in u or "iphone" in u) else "other"


def note_shared(ip: str, ua: str) -> None:
    """A device on the old shared token: one row per address."""
    seen(f"shared-{ip}", ip, ua, name=f"Shared token ({ip})", kind="shared")


def note_local(ua: str) -> None:
    seen("local", "127.0.0.1", ua, name="This PC (desktop app)", kind="local")


# ── Routes (desktop / loopback only) ─────────────────────────────────────────

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _desktop_only(request: Request) -> None:
    host = (request.client.host if request.client else "") or ""
    proxied = any(h in request.headers for h in ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"))
    if proxied or not (host in ("127.0.0.1", "::1", "localhost") or host.startswith("127.")):
        raise HTTPException(status_code=403, detail="Devices are managed from the desktop app only.")


class NewDevice(BaseModel):
    name: str
    kind: str = "phone"


@router.get("")
def list_devices(request: Request):
    _desktop_only(request)
    return {"devices": listing()}


@router.post("")
def add_device(body: NewDevice, request: Request):
    _desktop_only(request)
    dev, token = add(body.name, body.kind)
    return {"device": public(dev), "token": token}


@router.delete("/{dev_id}")
def revoke_device(dev_id: str, request: Request):
    _desktop_only(request)
    if not revoke(dev_id):
        raise HTTPException(status_code=404, detail="No such signed-in device (shared-token devices are signed out by rotating the shared token).")
    return {"ok": True}
