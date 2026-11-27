"""Maps gateway routes (build plan Sections 8-10, Maps step 7).

  PUT  /api/maps/trips              the PC's trips snapshot (TripsView JSON, <= 64 KB). Loopback
                                    only: the desktop's background publisher (trips.rs) is the one
                                    writer. Clears a pending phone refresh request.
  GET  /api/maps/trips              {view, receivedAtMs, ageS, refreshPending, killSwitch} for the
                                    phone, or 404 {"detail": "no snapshot"}.
  POST /api/maps/refresh            the phone asks the PC for a fresh snapshot (423 while the kill
                                    switch is on; 415 unless Content-Type is application/json). The
                                    request lapses after REFRESH_TTL_S.
  GET  /api/maps/refresh            {pending, requestedAtMs}: what the publisher polls each minute.
  POST /api/maps/handoff            "Send to phone": queue a NavHandoff {lat, lng, label, mode,
                                    stops?}. Loopback only (the desktop sends it), refused while the
                                    kill switch is on, lives HANDOFF_TTL_S (30 min) → {id}.
  GET  /api/maps/handoff            ?status=pending (default) | opened | dismissed | expired:
                                    {items, killSwitch}. While the kill switch is on no pending
                                    hand-off is handed out.
  POST /api/maps/handoff/{id}/ack   {status: "opened" | "dismissed"}; 404 unknown, 410 expired,
                                    409 already finished with another status.
  WS   /api/maps/ws                 live push for the phone app: nav-handoff, nav-handoff-ack,
                                    trips (snapshot updated: times and count only), trips-refresh.

Why a module of its own: the Comms routes (os_api.py) belong to another track, and a hand-off must
NEVER enter comms_outbox or the comms WebSocket: the user's Tasker flow listens there and would
treat a navigation item as a text to send. This module has its own SQLite table (maps_handoff) and
its own socket, and nothing here touches the vault, so trips, addresses and hand-offs are never in
any search or agent context.

Storage: the snapshot is <CC_DIR>/maps-trips.json (data/command-center/, git-ignored: it holds
event titles and addresses); hand-offs live in cc.db (same folder), created lazily on first use so
importing the gateway never alters a live database. Finished hand-offs are purged after a day.

Auth: the global ZeroTrustMiddleware (server.py) already requires the gateway token from anything
that isn't loopback; the WebSocket (which that middleware never sees) checks it here. Writes that
only the PC makes (trips, hand-off) additionally require a direct loopback peer, so a mesh device
holding the token cannot plant fake trips or send the phone to an arbitrary destination, plus
`Content-Type: application/json` (415) and no foreign Origin (403), so a web page open in a
browser on the PC can't forge one with a preflight-free text/plain POST (CSRF). The socket admits
only loopback and the 100.64.0.0/10 mesh, never a tunnel (forwarding headers), lock on or off.

Untrusted text: event titles and locations can come from third-party invites. They are stored and
shown, never logged, never followed and never handed to an agent.
"""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import math
import os
import re
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

import command_center_api as cc

router = APIRouter(prefix="/api/maps", tags=["maps"])

SNAPSHOT_FILE = "maps-trips.json"
SNAPSHOT_MAX = 64 * 1024
SNAPSHOT_MAX_TRIPS = 20
HANDOFF_TTL_S = 30 * 60
HANDOFF_MAX_BYTES = 4 * 1024
HANDOFF_MAX_PENDING = 20
HANDOFF_KEEP_S = 24 * 3600  # finished / expired rows (they hold an address) are purged after this
LABEL_MAX = 120
STOPS_MAX = 8
NAV_MODES = ("navigate", "pin", "directions")
ACK_STATUSES = ("opened", "dismissed")
LIST_STATUSES = ("pending",) + ACK_STATUSES + ("expired",)
REFRESH_TTL_S = 15 * 60
REFRESH_MIN_GAP_S = 30
KILL_SWITCH_DETAIL = "KILL_SWITCH: the kill switch is on, so Maps sends nothing to the phone"
PC_ONLY_DETAIL = "Only the desktop app on this machine may write this."
JSON_ONLY_DETAIL = "Content-Type must be application/json"
FOREIGN_ORIGIN_DETAIL = "This request did not come from the Command Center app."
_FORWARDING_HEADERS = ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip")
_MESH = ipaddress.ip_network("100.64.0.0/10")
# The app's own web origins: server.py's CORS allow-list (Tauri webview on Windows / macOS+Linux,
# Vite dev 1420-1439, PWA preview, the gateway's own pages). Kept in step with server.py by hand:
# server imports this module, so it can't import server.
APP_ORIGINS = frozenset({
    "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
    "http://localhost:1420", "http://localhost:4173", "http://127.0.0.1:8080", "http://localhost:8080",
})
_DEV_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1):14[23][0-9]$")
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁦-⁩﻿]")


# ── Helpers ─────────────────────────────────────────────────────────────────

def _now_ms() -> int:
    return int(time.time() * 1000)


def _snapshot_path() -> Path:
    return Path(cc.CC_DIR) / SNAPSHOT_FILE


def _kill_switch_on() -> bool:
    """The desktop's kill switch as mirrored in <CC_DIR>/os-state.json (the same mirror the Comms
    routes read). A missing or unreadable mirror counts as on."""
    try:
        st = json.loads((Path(cc.CC_DIR) / "os-state.json").read_text(encoding="utf-8"))
        ks = (st.get("privacy") or {}).get("killSwitch") if isinstance(st, dict) else None
    except Exception:
        return True
    return ks if isinstance(ks, bool) else True


def _require_json(request: Request) -> None:
    """Refuse anything but `Content-Type: application/json`. A web page can POST text/plain or a
    form to the gateway cross-origin without a CORS preflight (a "simple" request reaches the
    handler); JSON forces the preflight, which server.py's CORS allow-list then blocks."""
    ctype = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if ctype != "application/json":
        raise HTTPException(415, JSON_ONLY_DETAIL)


def _require_app_origin(request: Request) -> None:
    """An Origin header, when present, must be one of the app's own (the desktop publisher's
    reqwest sends none). A foreign page (or a DNS-rebinding host) never gets this far."""
    origin = request.headers.get("origin")
    if origin is not None and origin not in APP_ORIGINS and not _DEV_ORIGIN_RE.match(origin):
        raise HTTPException(403, FOREIGN_ORIGIN_DETAIL)


def _require_pc(request: Request) -> None:
    """Writes only the desktop makes: a direct loopback peer (no tunnel), the app's own origin (or
    none, from native code) and a JSON body, so a page in a browser on the PC can't forge one."""
    if not cc.is_loopback_request(request):
        raise HTTPException(403, PC_ONLY_DETAIL)
    _require_app_origin(request)
    _require_json(request)


def _clean_label(v: Any) -> str:
    if v is None:
        return ""
    if not isinstance(v, str):
        raise HTTPException(400, "label must be text")
    t = _CTRL.sub(" ", unicodedata.normalize("NFKC", v))
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > LABEL_MAX:
        raise HTTPException(400, f"label is longer than {LABEL_MAX} characters")
    return t


def _coord(v: Any, lo: float, hi: float, name: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise HTTPException(400, f"{name} must be a number between {lo:g} and {hi:g}")
    return float(v)


def _place(d: Any, what: str) -> dict:
    if not isinstance(d, dict):
        raise HTTPException(400, f"{what} must be an object")
    extra = set(d) - {"lat", "lng", "label"}
    if extra:
        raise HTTPException(400, f"{what}: unexpected field(s) {', '.join(sorted(extra))}")
    out = {"lat": _coord(d.get("lat"), -90, 90, "lat"), "lng": _coord(d.get("lng"), -180, 180, "lng")}
    label = _clean_label(d.get("label"))
    if label:
        out["label"] = label
    return out


def _validate_handoff(data: Any) -> dict:
    """A NavHandoff, strictly: {lat, lng, label?, mode?, stops?}, nothing else."""
    if not isinstance(data, dict):
        raise HTTPException(400, "body must be a NavHandoff object")
    extra = set(data) - {"lat", "lng", "label", "mode", "stops"}
    if extra:
        raise HTTPException(400, f"unexpected field(s) {', '.join(sorted(extra))}")
    out = {"lat": _coord(data.get("lat"), -90, 90, "lat"), "lng": _coord(data.get("lng"), -180, 180, "lng")}
    out["label"] = _clean_label(data.get("label")) or f"{out['lat']:.5f}, {out['lng']:.5f}"
    mode = data.get("mode", "navigate")
    if mode not in NAV_MODES:
        raise HTTPException(400, f"mode must be one of {', '.join(NAV_MODES)}")
    out["mode"] = mode
    stops = data.get("stops")
    if stops is not None:
        if not isinstance(stops, list) or len(stops) > STOPS_MAX:
            raise HTTPException(400, f"stops must be a list of at most {STOPS_MAX} places")
        if stops:
            out["stops"] = [_place(s, "stop") for s in stops]
    return out


async def _read_capped(request: Request, cap: int) -> bytes:
    """The raw body, refused with 413 as soon as it passes `cap` (Content-Length or streamed)."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > cap:
                raise HTTPException(413, f"body is larger than {cap // 1024} KB")
        except ValueError:
            raise HTTPException(400, "bad Content-Length")
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > cap:
            raise HTTPException(413, f"body is larger than {cap // 1024} KB")
    return bytes(buf)


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# ── Own WebSocket channel (never the comms socket) ──────────────────────────

_ws_clients: set[WebSocket] = set()
_loop: Optional[asyncio.AbstractEventLoop] = None


def _drop_if_failed(fut: Any, ws: Any) -> None:
    try:
        failed = fut.cancelled() or fut.exception() is not None
    except Exception:
        failed = True
    if failed:
        _ws_clients.discard(ws)


def _broadcast(event: dict) -> None:
    """Push an event to this module's own socket clients (thread-safe; a no-op with none)."""
    loop = _loop
    if not _ws_clients or loop is None or loop.is_closed():
        return
    data = json.dumps(event, ensure_ascii=False, default=str)
    for ws in list(_ws_clients):
        coro = ws.send_text(data)
        try:
            fut = asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:
            coro.close()
            _ws_clients.discard(ws)
            continue
        fut.add_done_callback(lambda f, ws=ws: _drop_if_failed(f, ws))


def _ws_peer(ws: Any) -> Optional[str]:
    """"loopback" (the desktop), "mesh" (the phone over NetBird) or None (refused): the rule of
    server.ZeroTrustMiddleware, applied whether or not the network lock is on. Forwarding headers
    mean a tunnel (ngrok etc.), i.e. the public internet, even on a loopback peer."""
    if any(h in ws.headers for h in _FORWARDING_HEADERS):
        return None
    host = (ws.client.host if ws.client else "") or ""
    if host in ("127.0.0.1", "::1", "localhost") or host.startswith("127."):
        return "loopback"
    try:
        return "mesh" if ipaddress.ip_address(host) in _MESH else None
    except ValueError:
        return None


def _ws_token_ok(ws: WebSocket) -> bool:
    """The gateway token while the network lock has written it (BaseHTTPMiddleware never sees a
    WebSocket upgrade, so it is checked here): `Authorization: Bearer` or `?token=`."""
    token_file = Path(cc.CC_DIR) / "gateway.token"
    if not token_file.exists():
        return True
    try:
        token = token_file.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    sent = ws.headers.get("authorization", "")
    sent = sent[7:].strip() if sent.lower().startswith("bearer ") else ws.query_params.get("token", "")
    return bool(token) and hmac.compare_digest(sent.encode(), token.encode())


@router.websocket("/ws")
async def maps_ws(ws: WebSocket):
    """Live push for the phone app: {type: "nav-handoff", ...item}, {type: "nav-handoff-ack", id,
    status}, {type: "trips", fetchedAtMs, receivedAtMs, count}, {type: "trips-refresh", requestedAtMs}.
    It carries destinations (addresses), so only loopback and the mesh may subscribe: a tunnel or an
    off-mesh peer gets 4403 even while the network lock is off; a mesh peer without the token 4401."""
    global _loop
    peer = _ws_peer(ws)
    if peer is None:
        await ws.close(code=4403)
        return
    if peer != "loopback" and not _ws_token_ok(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    _loop = asyncio.get_running_loop()
    _ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive / ignored
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)


# ── Trips snapshot (PC → gateway → phone) ───────────────────────────────────

_state_lock = threading.Lock()
_refresh: dict[str, Optional[int]] = {"requestedAtMs": None}


def _refresh_pending(now_ms: int) -> Optional[int]:
    at = _refresh["requestedAtMs"]
    if at is not None and now_ms - at > REFRESH_TTL_S * 1000:
        _refresh["requestedAtMs"] = at = None
    return at


def _validate_view(raw: bytes) -> dict:
    try:
        view = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "snapshot must be JSON")
    if not isinstance(view, dict):
        raise HTTPException(400, "snapshot must be a TripsView object")
    trips = view.get("trips")
    if not isinstance(trips, list) or len(trips) > SNAPSHOT_MAX_TRIPS or not all(isinstance(t, dict) for t in trips):
        raise HTTPException(400, f"trips must be a list of at most {SNAPSHOT_MAX_TRIPS} objects")
    f = view.get("fetchedAtMs")
    if isinstance(f, bool) or not isinstance(f, (int, float)) or not math.isfinite(f) or f <= 0:
        raise HTTPException(400, "fetchedAtMs must be a positive number")
    return view


@router.put("/trips")
async def trips_put(request: Request):
    """The desktop publisher's snapshot. PC only, <= 64 KB, kept on disk under data/command-center/."""
    _require_pc(request)
    raw = await _read_capped(request, SNAPSHOT_MAX)
    view = _validate_view(raw)
    now = _now_ms()
    record = {"receivedAtMs": now, "view": view}
    await run_in_threadpool(_write_atomic, _snapshot_path(), json.dumps(record, ensure_ascii=False))
    with _state_lock:
        _refresh["requestedAtMs"] = None  # this PUT answers any pending phone request
    _broadcast({"type": "trips", "fetchedAtMs": view["fetchedAtMs"], "receivedAtMs": now, "count": len(view["trips"])})
    return {"ok": True, "receivedAtMs": now}


def _load_snapshot() -> Optional[dict]:
    try:
        rec = json.loads(_snapshot_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not isinstance(rec.get("view"), dict):
        return None
    return rec


@router.get("/trips")
def trips_get():
    """The latest snapshot and its age. ageS counts from when the PC computed it (fetchedAtMs;
    the gateway runs on the same PC, so it is the same clock), else from when it arrived."""
    rec = _load_snapshot()
    if rec is None:
        raise HTTPException(404, "no snapshot")
    now = _now_ms()
    view = rec["view"]
    f = view.get("fetchedAtMs")
    base = f if isinstance(f, (int, float)) and not isinstance(f, bool) else rec.get("receivedAtMs") or now
    with _state_lock:
        pending = _refresh_pending(now)
    return {
        "view": view,
        "receivedAtMs": rec.get("receivedAtMs"),
        "ageS": max(0, int((now - base) // 1000)),
        "refreshPending": pending is not None,
        "killSwitch": _kill_switch_on(),
    }


@router.post("/refresh")
def refresh_request(request: Request):
    """The phone asks for a fresh snapshot. The PC publisher sees it within a minute and the next
    PUT clears it. Repeats inside REFRESH_MIN_GAP_S keep the first request. Content-Type must be
    application/json (the body may be empty or `{}`), so a foreign page can't fire it without a
    CORS preflight; no Origin allow-list here, since the phone's PWA is served from the gateway's
    own mesh address."""
    _require_json(request)
    if _kill_switch_on():
        raise HTTPException(423, KILL_SWITCH_DETAIL)
    now = _now_ms()
    with _state_lock:
        at = _refresh_pending(now)
        fresh = at is None or now - at >= REFRESH_MIN_GAP_S * 1000
        if fresh:
            _refresh["requestedAtMs"] = at = now
    if fresh:
        _broadcast({"type": "trips-refresh", "requestedAtMs": at})
    return {"ok": True, "pending": True, "requestedAtMs": at}


@router.get("/refresh")
def refresh_state():
    with _state_lock:
        at = _refresh_pending(_now_ms())
    return {"pending": at is not None, "requestedAtMs": at}


# ── Hand-off queue ("Send to phone") ────────────────────────────────────────

_schema_ready: set[str] = set()
_schema_lock = threading.Lock()


def _ensure_schema() -> None:
    key = str(cc.DB_PATH)
    if key in _schema_ready:
        return
    with _schema_lock:
        if key in _schema_ready:
            return
        with cc._db_lock, cc.db() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS maps_handoff(
                  id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
                  created REAL NOT NULL, updated REAL NOT NULL, expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS maps_handoff_status ON maps_handoff(status, created);
                """
            )
        _schema_ready.add(key)


def _item(r: Any) -> dict:
    return {
        **json.loads(r["payload"]),
        "id": r["id"],
        "status": r["status"],
        "createdMs": int(r["created"] * 1000),
        "expiresMs": int(r["expires"] * 1000),
        "from": "desktop",
    }


def _sweep(c: Any, now: float) -> list[str]:
    """Expire overdue pending items (returned, for the ack broadcast) and purge old finished ones."""
    ids = [r["id"] for r in c.execute("SELECT id FROM maps_handoff WHERE status='pending' AND expires <= ?", (now,)).fetchall()]
    if ids:
        c.executemany("UPDATE maps_handoff SET status='expired', updated=? WHERE id=? AND status='pending'", [(now, i) for i in ids])
    c.execute("DELETE FROM maps_handoff WHERE status != 'pending' AND updated < ?", (now - HANDOFF_KEEP_S,))
    return ids


def _broadcast_expired(ids: list[str]) -> None:
    for i in ids:
        _broadcast({"type": "nav-handoff-ack", "id": i, "status": "expired"})


@router.post("/handoff")
async def handoff_post(request: Request):
    """Queue a destination for the phone. PC only, refused while the kill switch is on. The same
    destination already pending is not queued twice (its id comes back, `duplicate: true`)."""
    _require_pc(request)
    raw = await _read_capped(request, HANDOFF_MAX_BYTES)
    try:
        data = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "body must be JSON")
    h = _validate_handoff(data)
    if _kill_switch_on():
        raise HTTPException(423, KILL_SWITCH_DETAIL)
    return await run_in_threadpool(_queue_handoff, h)


def _queue_handoff(h: dict) -> dict:
    _ensure_schema()
    now = time.time()
    payload = json.dumps(h, ensure_ascii=False, sort_keys=True)
    with cc._db_lock, cc.db() as c:
        expired = _sweep(c, now)
        same = c.execute("SELECT * FROM maps_handoff WHERE status='pending' AND payload=? ORDER BY created DESC LIMIT 1", (payload,)).fetchone()
        if same:
            row, dup = same, True
        else:
            hid = uuid.uuid4().hex
            c.execute(
                "INSERT INTO maps_handoff(id,payload,status,created,updated,expires) VALUES(?,?,'pending',?,?,?)",
                (hid, payload, now, now, now + HANDOFF_TTL_S),
            )
            # At most HANDOFF_MAX_PENDING waiting: the oldest beyond that are dismissed.
            over = c.execute(
                "SELECT id FROM maps_handoff WHERE status='pending' ORDER BY created DESC LIMIT -1 OFFSET ?", (HANDOFF_MAX_PENDING,)
            ).fetchall()
            for r in over:
                c.execute("UPDATE maps_handoff SET status='dismissed', updated=? WHERE id=?", (now, r["id"]))
                expired.append(r["id"])
            row, dup = c.execute("SELECT * FROM maps_handoff WHERE id=?", (hid,)).fetchone(), False
    _broadcast_expired(expired)
    item = _item(row)
    if not dup:
        _broadcast({"type": "nav-handoff", **item})
    return {"id": item["id"], "expiresMs": item["expiresMs"], "duplicate": dup}


@router.get("/handoff")
def handoff_list(status: str = Query("pending")):
    if status not in LIST_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(LIST_STATUSES)}")
    _ensure_schema()
    killed = _kill_switch_on()
    now = time.time()
    with cc._db_lock, cc.db() as c:
        expired = _sweep(c, now)
        rows = c.execute("SELECT * FROM maps_handoff WHERE status=? ORDER BY created DESC LIMIT 50", (status,)).fetchall()
    _broadcast_expired(expired)
    items = [] if killed and status == "pending" else [_item(r) for r in rows]
    return {"items": items, "killSwitch": killed}


@router.post("/handoff/{hid}/ack")
def handoff_ack(hid: str, data: Optional[dict] = Body(None)):
    status = (data or {}).get("status")
    if status not in ACK_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(ACK_STATUSES)}")
    _ensure_schema()
    now = time.time()
    err: Optional[tuple[int, str]] = None
    with cc._db_lock, cc.db() as c:
        expired = _sweep(c, now)
        r = c.execute("SELECT status FROM maps_handoff WHERE id=?", (hid,)).fetchone()
        if r is None:
            err = (404, "no such hand-off")
        elif r["status"] == "expired":
            err = (410, "this hand-off expired")
        elif r["status"] == "pending":
            c.execute("UPDATE maps_handoff SET status=?, updated=? WHERE id=? AND status='pending'", (status, now, hid))
        elif r["status"] != status:
            err = (409, f"this hand-off was already {r['status']}")
        else:
            status = None  # the same ack again: fine, nothing new to announce
    _broadcast_expired(expired)
    if err:
        raise HTTPException(*err)
    if status:
        _broadcast({"type": "nav-handoff-ack", "id": hid, "status": status})
    return {"ok": True}
