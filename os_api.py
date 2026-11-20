"""Agentic OS Phase 2 gateway routes.

  /api/play-place/*  staged prototypes (Designer / Coder) + sandboxed preview
  /api/pipeline/*    Ideas & Tasks ledger + live pipeline progress (for the phone HUD)
  /api/comms/*       calls & texts: phone-bridge sync, unified inbox, outbox, recall search, WS push
  /api/os/inbox      phone → desktop queue (turns, commands, pipeline/task, Play Place) with claim/lease
  /api/tasks/*       best-effort mirror of the desktop's TaskEnvelopes (phone status on demand)
  /api/spotify/*     Spotify OAuth redirect relay for `tauri dev` (Vite proxies /callback here)

Ideas and Play Place cards live in the shared Command Center store (collections
"ideas" and "playplace"), so they sync to every device and land in the vault.
Comms lives in its own tables (it can be large) and every message is also
indexed into the vault as collection "comms" for the Librarian.

Security: the gateway binds 127.0.0.1 (+ the NetBird address), ZeroTrustMiddleware
requires the bearer token from anything that isn't loopback, and sending a text
or placing a call needs an explicit `confirmed: true` (the UI's confirmation
card) unless the contact is marked trusted ("Instant Send").
"""
from __future__ import annotations

import asyncio
import os
import hmac
import json
import logging
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

import command_center_api as cc

play_router = APIRouter(prefix="/api/play-place", tags=["play-place"])
pipeline_router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])
comms_router = APIRouter(prefix="/api/comms", tags=["comms"])
inbox_router = APIRouter(prefix="/api/os", tags=["agentic-os"])
tasks_router = APIRouter(prefix="/api/tasks", tags=["tasks"])

TOKEN_FILE = cc.CC_DIR / "gateway.token"
log = logging.getLogger("agentic-os.gateway")


def init() -> None:
    with cc._db_lock, cc.db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS comms_messages(
              id TEXT PRIMARY KEY, thread TEXT NOT NULL, contact TEXT, address TEXT, direction TEXT,
              body TEXT, ts REAL NOT NULL, channel TEXT, read INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS comms_msg_thread ON comms_messages(thread, ts);
            CREATE TABLE IF NOT EXISTS comms_calls(
              id TEXT PRIMARY KEY, contact TEXT, address TEXT, direction TEXT, ts REAL NOT NULL, duration INTEGER);
            CREATE TABLE IF NOT EXISTS comms_outbox(
              id TEXT PRIMARY KEY, kind TEXT, address TEXT, contact TEXT, body TEXT, channel TEXT,
              status TEXT, created REAL, updated REAL, detail TEXT);
            CREATE TABLE IF NOT EXISTS comms_contacts(address TEXT PRIMARY KEY, name TEXT, trusted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS os_queue(
              id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created REAL, updated REAL);
            """
        )


# Additive schema (claim/lease columns, task mirror). cc.db has no migration ladder, so each
# change is a guarded ADD COLUMN / CREATE IF NOT EXISTS. Applied lazily on first use, once per
# database file, so importing the gateway (the test suite does) never alters a live cc.db.
_OS_QUEUE_COLUMNS = (("claimed_at", "REAL"), ("lease_until", "REAL"), ("claim_token", "TEXT"))
_schema_ready: set[str] = set()
_schema_lock = threading.Lock()


def _ensure_schema() -> None:
    key = str(cc.DB_PATH)
    if key in _schema_ready:
        return
    with _schema_lock:
        if key in _schema_ready:
            return
        init()
        with cc._db_lock, cc.db() as c:
            have = {r["name"] for r in c.execute("PRAGMA table_info(os_queue)")}
            for name, typ in _OS_QUEUE_COLUMNS:
                if name not in have:
                    c.execute(f"ALTER TABLE os_queue ADD COLUMN {name} {typ}")
            c.executescript(
                """
                CREATE INDEX IF NOT EXISTS os_queue_status ON os_queue(status, created);
                CREATE TABLE IF NOT EXISTS task_mirror(
                  task_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS task_mirror_updated ON task_mirror(updated_at);
                """
            )
        _schema_ready.add(key)


# ── helpers ─────────────────────────────────────────────────────────────────

def _thread_key(address: str, channel: str = "sms") -> str:
    a = (address or "").strip()
    if "@" in a:  # WhatsApp JID / email
        return a.lower()
    digits = re.sub(r"\D", "", a)
    return digits[-10:] if len(digits) >= 10 else (digits or a.lower() or "unknown")


def _ts(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return time.time()
    return f / 1000.0 if f > 1e11 else f  # accept ms or s


def _items(collection: str) -> list[dict]:
    with cc.db() as c:
        rows = c.execute("SELECT * FROM items WHERE collection=? AND deleted=0 ORDER BY updated DESC", (collection,)).fetchall()
    return [cc._row(r) for r in rows]


def _item(collection: str, item_id: str) -> dict:
    with cc.db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection=? AND deleted=0", (item_id, collection)).fetchone()
    if not r:
        raise HTTPException(404, "Not found")
    return cc._row(r)


# ── Play Place ──────────────────────────────────────────────────────────────

@play_router.get("")
def play_list():
    out = []
    for it in _items("playplace"):
        it = dict(it)
        it["hasHtml"] = bool(it.pop("html", ""))
        out.append(it)
    return {"items": out}


@play_router.get("/{item_id}")
def play_get(item_id: str):
    return _item("playplace", item_id)


@play_router.post("")
def play_create(data: dict = Body(...)):
    return cc.create_item("playplace", {**data, "status": data.get("status") or "staged"})


@play_router.delete("/{item_id}")
def play_delete(item_id: str):
    return cc.delete_item("playplace", item_id)


_PREVIEW_CSP = (
    # Isolation comes from <iframe sandbox="allow-scripts"> (opaque origin, no cookies,
    # no access to the OS or the gateway); this CSP only limits what the prototype loads.
    "default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; "
    "style-src 'unsafe-inline' https:; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com "
    "https://esm.sh https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; connect-src https:"
)


@play_router.get("/{item_id}/preview", response_class=HTMLResponse)
def play_preview(item_id: str):
    """The prototype itself. Shown in an <iframe sandbox="allow-scripts"> (opaque origin:
    it can't read the OS, cookies or the gateway), plus a strict CSP here."""
    it = _item("playplace", item_id)
    html = it.get("html") or "<p style='font:14px system-ui;color:#999;padding:2rem'>No prototype HTML yet.</p>"
    return HTMLResponse(html, headers={"Content-Security-Policy": _PREVIEW_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


# ── Pipeline: ideas ledger + progress ───────────────────────────────────────

@pipeline_router.get("/ideas")
def ideas():
    return {"items": _items("ideas")}


_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()
PROGRESS_DONE_TTL = 600.0  # finished runs linger 10 min
PROGRESS_FAILED_TTL = 120.0  # long enough for the phone's 5 s poll to see the failure once
PROGRESS_MAX_AGE = 1800.0  # anything silent for 30 min is gone, whatever its pct
_PROGRESS_MAX_BYTES = 8 * 1024


def _num(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _progress_failed(v: dict) -> bool:
    return str(v.get("status") or "").lower() in ("failed", "error") or v.get("ok") is False


def _evict_progress(now: Optional[float] = None) -> None:
    now = time.time() if now is None else now
    with _progress_lock:
        for k, v in list(_progress.items()):
            age = now - _num(v.get("at"), now)
            if age > PROGRESS_MAX_AGE or (_progress_failed(v) and age > PROGRESS_FAILED_TTL) or (_num(v.get("pct")) >= 100 and age > PROGRESS_DONE_TTL):
                _progress.pop(k, None)


@pipeline_router.post("/progress")
def progress_put(data: dict = Body(...)):
    """Phone HUD progress. Keyed by taskId (TaskEnvelope worker) or ideaId/pipelineId (legacy);
    optional status/owner/iteration ride along. Volatile: /api/tasks is the durable view."""
    pid = str(data.get("taskId") or data.get("ideaId") or data.get("pipelineId") or "")
    if not pid:
        raise HTTPException(400, "taskId, ideaId or pipelineId required")
    if len(json.dumps(data, ensure_ascii=False, default=str)) > _PROGRESS_MAX_BYTES:
        raise HTTPException(413, "progress entry too large")
    now = time.time()
    entry = {**data, "at": now}
    _evict_progress(now)
    with _progress_lock:
        _progress[pid] = entry
    _broadcast({"type": "pipeline", **entry})
    return {"ok": True}


@pipeline_router.get("/progress")
def progress_get():
    _evict_progress()
    with _progress_lock:
        return {"items": list(_progress.values())}


# ── Comms ───────────────────────────────────────────────────────────────────

_ws_clients: set[WebSocket] = set()
_loop: Optional[asyncio.AbstractEventLoop] = None


def _drop_if_failed(fut: Any, ws: Any) -> None:
    """Done-callback of one send: a client whose send failed (closed socket) is discarded."""
    try:
        failed = fut.cancelled() or fut.exception() is not None
    except Exception:
        failed = True
    if failed:
        _ws_clients.discard(ws)


def _broadcast(event: dict) -> None:
    loop = _loop
    if not _ws_clients or loop is None or loop.is_closed():
        return
    data = json.dumps(event, ensure_ascii=False, default=str)
    for ws in list(_ws_clients):
        coro = ws.send_text(data)
        try:
            fut = asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:  # loop gone between the check and the send
            coro.close()
            _ws_clients.discard(ws)
            continue
        fut.add_done_callback(lambda f, ws=ws: _drop_if_failed(f, ws))


def _contact_name(c, address: str) -> Optional[str]:
    r = c.execute("SELECT name FROM comms_contacts WHERE address=?", (_thread_key(address),)).fetchone()
    return r["name"] if r else None


@comms_router.post("/sms")
def comms_sms(data: Any = Body(...)):
    """Phone bridge → desktop. Accepts one message or {messages:[…]}.
    Fields: address, body, ts (s or ms), direction in|out, contact?, channel? (sms|rcs|whatsapp), id?"""
    msgs = data.get("messages") if isinstance(data, dict) and "messages" in data else (data if isinstance(data, list) else [data])
    added = 0
    to_index: list[tuple] = []
    with cc._db_lock, cc.db() as c:
        for m in msgs[:2000]:
            if not isinstance(m, dict) or not str(m.get("body") or "").strip():
                continue
            address = str(m.get("address") or m.get("from") or m.get("to") or "")
            channel = str(m.get("channel") or "sms").lower()
            ts = _ts(m.get("ts") or m.get("date"))
            body = str(m["body"])[:8000]
            direction = "out" if str(m.get("direction") or m.get("type") or "in").lower() in ("out", "sent", "outgoing", "2") else "in"
            mid = str(m.get("id") or f"{channel}:{_thread_key(address)}:{int(ts)}:{hash(body) & 0xFFFFFFFF:x}")
            contact = str(m.get("contact") or m.get("name") or "") or _contact_name(c, address) or address
            if m.get("contact"):
                c.execute("INSERT INTO comms_contacts(address,name) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET name=excluded.name", (_thread_key(address), contact))
            cur = c.execute(
                "INSERT OR IGNORE INTO comms_messages(id,thread,contact,address,direction,body,ts,channel,read) VALUES(?,?,?,?,?,?,?,?,?)",
                (mid, _thread_key(address, channel), contact, address, direction, body, ts, channel, 1 if direction == "out" else 0),
            )
            if cur.rowcount:
                added += 1
                to_index.append((mid, contact, address, direction, body, ts, channel))
                _broadcast({"type": "sms", "id": mid, "thread": _thread_key(address, channel), "contact": contact, "direction": direction, "body": body[:280], "ts": ts})
    for row in to_index:  # after the write transaction above has committed
        _vault_comms(*row)
    return {"ok": True, "added": added}


def _vault_comms(mid, contact, address, direction, body, ts, channel):
    """Index for the Librarian (semantic + lexical vault search, collection "comms")."""
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
    text = f"{channel} {'from' if direction == 'in' else 'to'} {contact} ({address}) at {when}: {body}"
    try:
        with cc._db_lock, cc.db() as c2:
            c2.execute(
                "INSERT INTO vault(item_id,collection,text,vector,model,updated) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(item_id) DO UPDATE SET text=excluded.text, vector=NULL, model=NULL, updated=excluded.updated",
                (f"comms:{mid}", "comms", text[:6000], None, None, time.time()),
            )
        cc._index_q.put(f"comms:{mid}")
    except Exception:
        pass


@comms_router.post("/call-log")
def comms_calls_post(data: Any = Body(...)):
    calls = data.get("calls") if isinstance(data, dict) and "calls" in data else (data if isinstance(data, list) else [data])
    added = 0
    with cc._db_lock, cc.db() as c:
        for k in calls[:2000]:
            if not isinstance(k, dict):
                continue
            address = str(k.get("address") or k.get("number") or "")
            ts = _ts(k.get("ts") or k.get("date"))
            d = str(k.get("direction") or k.get("type") or "in").lower()
            direction = "missed" if d in ("missed", "3", "rejected") else "out" if d in ("out", "outgoing", "2") else "in"
            cid = str(k.get("id") or f"call:{_thread_key(address)}:{int(ts)}")
            contact = str(k.get("contact") or k.get("name") or "") or _contact_name(c, address) or address
            cur = c.execute("INSERT OR IGNORE INTO comms_calls(id,contact,address,direction,ts,duration) VALUES(?,?,?,?,?,?)", (cid, contact, address, direction, ts, int(k.get("duration") or 0)))
            if cur.rowcount:
                added += 1
                _broadcast({"type": "call", "id": cid, "contact": contact, "direction": direction, "ts": ts})
    return {"ok": True, "added": added}


@comms_router.get("/threads")
def comms_threads(limit: int = Query(100, le=500)):
    with cc.db() as c:
        rows = c.execute(
            """SELECT m.thread, m.contact, m.address, m.body, m.ts, m.direction, m.channel,
                      (SELECT COUNT(*) FROM comms_messages u WHERE u.thread=m.thread AND u.read=0) AS unread
               FROM comms_messages m
               WHERE m.ts = (SELECT MAX(ts) FROM comms_messages x WHERE x.thread = m.thread)
               GROUP BY m.thread ORDER BY m.ts DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        trusted = {r["address"] for r in c.execute("SELECT address FROM comms_contacts WHERE trusted=1")}
    return {"threads": [{**dict(r), "trusted": r["thread"] in trusted} for r in rows]}


@comms_router.get("/threads/{thread}/messages")
def comms_messages(thread: str, limit: int = Query(200, le=2000)):
    with cc.db() as c:
        rows = c.execute("SELECT * FROM comms_messages WHERE thread=? ORDER BY ts DESC LIMIT ?", (thread, limit)).fetchall()
    return {"messages": [dict(r) for r in reversed(rows)]}


@comms_router.post("/threads/{thread}/read")
def comms_read(thread: str):
    with cc._db_lock, cc.db() as c:
        c.execute("UPDATE comms_messages SET read=1 WHERE thread=?", (thread,))
    return {"ok": True}


@comms_router.get("/calls")
def comms_calls(limit: int = Query(100, le=1000)):
    with cc.db() as c:
        rows = c.execute("SELECT * FROM comms_calls ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return {"calls": [dict(r) for r in rows]}


@comms_router.get("/contacts")
def comms_contacts(q: str = ""):
    with cc.db() as c:
        rows = c.execute(
            "SELECT address, name, trusted FROM comms_contacts WHERE name LIKE ? OR address LIKE ? ORDER BY name LIMIT 200",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
    return {"contacts": [dict(r) for r in rows]}


@comms_router.post("/contacts")
def comms_contact_put(data: dict = Body(...)):
    address = _thread_key(str(data.get("address") or ""))
    if not address:
        raise HTTPException(400, "address required")
    with cc._db_lock, cc.db() as c:
        c.execute(
            "INSERT INTO comms_contacts(address,name,trusted) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET name=COALESCE(excluded.name,name), trusted=excluded.trusted",
            (address, data.get("name"), 1 if data.get("trusted") else 0),
        )
    return {"ok": True}


def _trusted(address: str) -> bool:
    with cc.db() as c:
        r = c.execute("SELECT trusted FROM comms_contacts WHERE address=?", (_thread_key(address),)).fetchone()
    return bool(r and r["trusted"])


def _queue_out(kind: str, data: dict) -> dict:
    address = str(data.get("address") or "").strip()
    if not address:
        raise HTTPException(400, "address required")
    if kind == "sms" and not str(data.get("body") or "").strip():
        raise HTTPException(400, "body required")
    if not data.get("confirmed") and not (kind == "sms" and _trusted(address)):
        # The 30-second confirmation card in the UI sets confirmed:true. Never auto-send.
        raise HTTPException(428, "Confirmation required (or mark the contact trusted for Instant Send)")
    oid = uuid.uuid4().hex
    now = time.time()
    row = {"id": oid, "kind": kind, "address": address, "contact": data.get("contact") or address, "body": str(data.get("body") or "")[:2000], "channel": data.get("channel") or "sms", "status": "pending", "created": now, "updated": now, "detail": ""}
    with cc._db_lock, cc.db() as c:
        c.execute("INSERT INTO comms_outbox(id,kind,address,contact,body,channel,status,created,updated,detail) VALUES(:id,:kind,:address,:contact,:body,:channel,:status,:created,:updated,:detail)", row)
    _broadcast({"type": "outbox", **row})
    return row


@comms_router.post("/send")
def comms_send(data: dict = Body(...)):
    """Queue an SMS for the phone bridge to send (it polls /outbox or listens on /ws)."""
    row = _queue_out("sms", data)
    # Record it in the thread right away (marked as queued) so the inbox shows it.
    comms_sms({"messages": [{"id": f"out:{row['id']}", "address": row["address"], "contact": row["contact"], "body": row["body"], "ts": row["created"], "direction": "out", "channel": row["channel"]}]})
    return row


@comms_router.post("/call")
def comms_call(data: dict = Body(...)):
    """Ask the phone bridge to dial a number."""
    return _queue_out("call", data)


@comms_router.get("/outbox")
def comms_outbox(status: str = "pending"):
    with cc.db() as c:
        rows = c.execute("SELECT * FROM comms_outbox WHERE status=? ORDER BY created", (status,)).fetchall()
    return {"items": [dict(r) for r in rows]}


@comms_router.post("/outbox/{oid}/ack")
def comms_ack(oid: str, data: dict = Body(...)):
    status = str(data.get("status") or "sent")
    if status not in ("sent", "failed", "dialed", "delivered"):
        raise HTTPException(400, "bad status")
    with cc._db_lock, cc.db() as c:
        c.execute("UPDATE comms_outbox SET status=?, detail=?, updated=? WHERE id=?", (status, str(data.get("detail") or "")[:300], time.time(), oid))
    _broadcast({"type": "outbox-ack", "id": oid, "status": status})
    return {"ok": True}


@comms_router.get("/search")
def comms_search(q: str = "", contact: str = "", limit: int = Query(12, le=50)):
    """Librarian recall: exact quotes + timestamps. Contact matches name or number."""
    terms = [t for t in re.findall(r"[\w']+", q.lower()) if len(t) > 2]
    with cc.db() as c:
        sql = "SELECT * FROM comms_messages"
        args: list = []
        if contact.strip():
            digits = re.sub(r"\D", "", contact)
            sql += " WHERE (contact LIKE ? OR address LIKE ?" + (" OR thread LIKE ?" if digits else "") + ")"
            args += [f"%{contact.strip()}%", f"%{contact.strip()}%"] + ([f"%{digits[-10:]}%"] if digits else [])
        sql += " ORDER BY ts DESC LIMIT 3000"
        rows = [dict(r) for r in c.execute(sql, args).fetchall()]
    scored = []
    for r in rows:
        low = (r["body"] or "").lower()
        s = sum(low.count(t) for t in terms) if terms else 1
        if s:
            scored.append((s, r))
    scored.sort(key=lambda x: (-x[0], -x[1]["ts"]))
    hits = [r for _, r in scored[:limit]]
    hits.sort(key=lambda r: r["ts"])
    return {
        "query": q,
        "contact": contact,
        "scanned": len(rows),
        "results": [{**h, "when": time.strftime("%Y-%m-%d %H:%M", time.localtime(h["ts"]))} for h in hits],
    }


def _ws_authorized(ws: WebSocket) -> bool:
    # Loopback is trusted only when it did not come through a tunnel: a peer with forwarding
    # headers is the public internet (BaseHTTPMiddleware never sees WebSocket upgrades, so
    # ZeroTrustMiddleware's tunnel guard can't cover this route).
    if cc.is_loopback_request(ws):
        return True
    if not TOKEN_FILE.exists():
        return True
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    sent = ws.headers.get("authorization", "")
    sent = sent[7:].strip() if sent.lower().startswith("bearer ") else ws.query_params.get("token", "")
    return bool(token) and hmac.compare_digest(sent.encode(), token.encode())


@comms_router.websocket("/ws")
async def comms_ws(ws: WebSocket):
    """Live push: new texts, calls, outbox items, pipeline progress, task mirror updates
    ({type:"task"}). The phone bridge can listen here instead of polling /outbox."""
    global _loop
    if not _ws_authorized(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    _loop = asyncio.get_running_loop()
    _ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive / ignore
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)


# ── Phone → desktop queue (Tony turns, kill switch, compute mode, tasks) ───
#
# Lifecycle: pending → (claim) running → done | error; anything nobody picked up within its
# kind's TTL becomes `expired` with an explicit result (never silently hidden). A running item
# whose lease ran out is offered again. The desktop claims with POST /inbox/{id}/claim and
# answers with POST /inbox/{id}/result {claim_token, ok, result|error}; an answer without a
# claim_token still works, so a desktop build that predates claiming keeps functioning.

_QUEUE_KINDS = {"turn", "command", "pipeline", "playplace", "task"}
QUEUE_STATUSES = ("pending", "running", "done", "error", "expired")
QUEUE_TTL = {"turn": 600.0, "command": 600.0, "playplace": 3600.0, "pipeline": 86400.0, "task": 86400.0}
LEASE_MAX_SECS = 900
LEASE_DEFAULT_SECS = 300
_PAYLOAD_MAX = 64 * 1024
_RESULT_MAX = 200_000
TASK_INTENT_MAX = 8000
TASK_TITLE_MAX = 120
EXPIRED_ERROR = "expired before the desktop picked it up"


def _queue_ttl(kind: str) -> float:
    return QUEUE_TTL.get(kind or "", 600.0)


def _sweep_expired(c, now: float) -> int:
    """Mark unclaimed items past their TTL `expired` (with a result and a log line). A running
    item is only expired once its lease has also run out."""
    n = 0
    for r in c.execute("SELECT id, kind, status, created, lease_until FROM os_queue WHERE status IN ('pending','running')").fetchall():
        if now - _num(r["created"], now) <= _queue_ttl(r["kind"]):
            continue
        if r["status"] == "running" and _num(r["lease_until"]) > now:
            continue
        cur = c.execute(
            "UPDATE os_queue SET status='expired', result=?, lease_until=NULL, updated=? WHERE id=? AND status=?",
            (json.dumps({"ok": False, "error": EXPIRED_ERROR}), now, r["id"], r["status"]),
        )
        if cur.rowcount:
            n += 1
            log.warning("os_queue %s (%s) %s", r["id"], r["kind"], EXPIRED_ERROR)
    return n


def _loads(raw: Optional[str], default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default  # a row written by an older gateway that truncated mid-JSON


def _queue_row(r, *, with_result: bool) -> dict:
    d = {k: r[k] for k in r.keys() if k != "claim_token"}  # the token only goes to the claimer
    d["payload"] = _loads(r["payload"], {})
    if with_result:
        d["result"] = _loads(r["result"], None)
    else:
        d.pop("result", None)
    return d


def _validate_task_payload(payload: dict) -> None:
    ri = payload.get("raw_intent")
    text = ri.get("text") if isinstance(ri, dict) else ri
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "task needs raw_intent text")
    if len(text) > TASK_INTENT_MAX:
        raise HTTPException(413, f"raw_intent is limited to {TASK_INTENT_MAX} characters")
    title = payload.get("title")
    if title is not None and not isinstance(title, str):
        raise HTTPException(400, "title must be a string")
    if isinstance(title, str) and len(title) > TASK_TITLE_MAX:
        raise HTTPException(413, f"title is limited to {TASK_TITLE_MAX} characters")


# Phone -> desktop commands. `micEnabled` (Phase 2 Part B: the phone locks / unlocks the desktop
# mic) and `modeId` / `overrides` / `resetOverrides` (Part C: Tony's mode) are applied by the
# desktop's InboxAction::Command; the desktop re-validates every value.
_COMMAND_KEYS = {"killSwitch", "computeMode", "micEnabled", "modeId", "overrides", "resetOverrides"}
_MODE_ID_MAX = 64


def _validate_command_payload(payload: dict) -> None:
    if not set(payload) <= _COMMAND_KEYS:
        raise HTTPException(400, f"commands: {sorted(_COMMAND_KEYS)}")
    for k in ("killSwitch", "micEnabled", "resetOverrides"):
        if k in payload and not isinstance(payload[k], bool):
            raise HTTPException(400, f"{k} must be a boolean")
    if "computeMode" in payload and not isinstance(payload["computeMode"], str):
        raise HTTPException(400, "computeMode must be a string")
    mid = payload.get("modeId")
    if "modeId" in payload and (not isinstance(mid, str) or not mid.strip() or len(mid) > _MODE_ID_MAX):
        raise HTTPException(400, f"modeId must be a non-empty string of at most {_MODE_ID_MAX} characters")
    ov = payload.get("overrides")
    if "overrides" in payload and (not isinstance(ov, dict) or not all(v is None or isinstance(v, str) for v in ov.values())):
        raise HTTPException(400, "overrides must be an object of strings")


@inbox_router.post("/inbox")
def inbox_post(data: dict = Body(...)):
    _ensure_schema()
    kind = str(data.get("kind") or "turn")
    if kind not in _QUEUE_KINDS:
        raise HTTPException(400, "kind must be turn, command, pipeline, playplace or task")
    payload = data.get("payload") or {}
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be an object")
    if kind == "command":
        _validate_command_payload(payload)
    if kind == "task":
        _validate_task_payload(payload)
    raw = json.dumps(payload)
    if len(raw) > _PAYLOAD_MAX:
        # Never truncate: a cut JSON string would poison GET /inbox for every later item.
        raise HTTPException(413, "payload too large")
    qid = uuid.uuid4().hex
    now = time.time()
    with cc._db_lock, cc.db() as c:
        c.execute("INSERT INTO os_queue(id,kind,payload,status,result,created,updated) VALUES(?,?,?,?,?,?,?)", (qid, kind, raw, "pending", None, now, now))
    return {"id": qid, "status": "pending"}


@inbox_router.get("/inbox")
def inbox_pending():
    """The desktop app polls this: pending items plus running items whose lease ran out.
    It claims each (POST /inbox/{id}/claim) and answers with POST /inbox/{id}/result."""
    _ensure_schema()
    now = time.time()
    with cc._db_lock, cc.db() as c:
        _sweep_expired(c, now)
        rows = c.execute(
            "SELECT * FROM os_queue WHERE status='pending' OR (status='running' AND COALESCE(lease_until,0) <= ?) ORDER BY created LIMIT 10",
            (now,),
        ).fetchall()
    return {"items": [_queue_row(r, with_result=False) for r in rows]}


@inbox_router.get("/inbox/{qid}")
def inbox_get(qid: str):
    _ensure_schema()
    with cc._db_lock, cc.db() as c:
        _sweep_expired(c, time.time())
        r = c.execute("SELECT * FROM os_queue WHERE id=?", (qid,)).fetchone()
    if not r:
        raise HTTPException(404, "Not found")
    return _queue_row(r, with_result=True)


@inbox_router.post("/inbox/{qid}/claim")
def inbox_claim(qid: str, data: Optional[dict] = Body(None)):
    """Claim an item for `lease_secs` (1..900, default 300). 409 when it isn't claimable
    (already running under a live lease, finished or expired). The holder renews its lease by
    claiming again with its `claim_token`."""
    _ensure_schema()
    data = data or {}
    lease = data.get("lease_secs", LEASE_DEFAULT_SECS)
    if isinstance(lease, bool) or not isinstance(lease, (int, float)) or not 1 <= lease <= LEASE_MAX_SECS:
        raise HTTPException(400, f"lease_secs must be 1..{LEASE_MAX_SECS}")
    token = data.get("claim_token")
    token = token if isinstance(token, str) and token else None
    now = time.time()
    with cc._db_lock, cc.db() as c:
        _sweep_expired(c, now)
        r = c.execute("SELECT * FROM os_queue WHERE id=?", (qid,)).fetchone()
        if not r:
            raise HTTPException(404, "Not found")
        renew = bool(token and r["status"] == "running" and r["claim_token"] and hmac.compare_digest(token.encode(), str(r["claim_token"]).encode()))
        claimable = r["status"] == "pending" or (r["status"] == "running" and (renew or _num(r["lease_until"]) <= now))
        if not claimable:
            raise HTTPException(409, f"not claimable (status {r['status']})")
        new_token = token if renew else uuid.uuid4().hex
        claimed_at = r["claimed_at"] if renew and r["claimed_at"] else now
        lease_until = now + float(lease)
        cur = c.execute(
            "UPDATE os_queue SET status='running', claimed_at=?, lease_until=?, claim_token=?, updated=? WHERE id=? AND status=? AND COALESCE(claim_token,'')=?",
            (claimed_at, lease_until, new_token, now, qid, r["status"], r["claim_token"] or ""),
        )
        if not cur.rowcount:
            raise HTTPException(409, "claimed by someone else")
    return {"id": qid, "kind": r["kind"], "payload": _loads(r["payload"], {}), "status": "running",
            "claim_token": new_token, "claimed_at": claimed_at, "lease_until": lease_until}


@inbox_router.post("/inbox/{qid}/result")
def inbox_result(qid: str, data: dict = Body(...)):
    """{ok, result | error, claim_token?}. With a token it must be the current claim's (a
    superseded claimer gets 409); without one it is accepted as before (older desktop builds)."""
    _ensure_schema()
    ok = data.get("ok", True) is not False
    token = data.get("claim_token")
    body = {k: v for k, v in data.items() if k != "claim_token"}
    raw = json.dumps(body)
    if len(raw) > _RESULT_MAX:
        ok = False
        raw = json.dumps({"ok": False, "error": f"desktop result too large ({len(raw)} bytes)"})
    now = time.time()
    with cc._db_lock, cc.db() as c:
        r = c.execute("SELECT status, claim_token FROM os_queue WHERE id=?", (qid,)).fetchone()
        if not r:
            raise HTTPException(404, "Not found")
        if isinstance(token, str) and token and r["claim_token"] and not hmac.compare_digest(token.encode(), str(r["claim_token"]).encode()):
            raise HTTPException(409, "claim superseded")
        c.execute(
            "UPDATE os_queue SET status=?, result=?, lease_until=NULL, updated=? WHERE id=?",
            ("done" if ok else "error", raw, now, qid),
        )
    return {"ok": True}


# ── Task mirror (desktop TaskEnvelopes → phone status on demand) ────────────
#
# The desktop's tasks.db is the source of truth; it PUTs a snapshot here on every transition
# (best-effort). The phone reads GET /api/tasks?active=1 and listens for {type:"task"} on the
# comms WebSocket.

TASK_STATUSES = {"queued", "prompting", "designing", "coding", "review_ready", "failed"}
TASK_TERMINAL = {"review_ready", "failed"}
TASK_SNAPSHOT_MAX = 16 * 1024
TASK_MIRROR_KEEP = 500
_TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")


def _task_id(task_id: str) -> str:
    if not _TASK_ID.match(task_id or ""):
        raise HTTPException(400, "bad task id")
    return task_id


@tasks_router.put("/{task_id}")
def task_mirror_put(task_id: str, request: Request, snapshot: dict = Body(...)):
    """Upsert one envelope snapshot (the request body, at most 16 KB). Localhost only."""
    cc.require_loopback(request)
    _ensure_schema()
    _task_id(task_id)
    if snapshot.get("task_id") not in (None, task_id):
        raise HTTPException(400, "task_id in the body does not match the path")
    status = snapshot.get("status")
    if status is not None and status not in TASK_STATUSES:
        raise HTTPException(400, f"status must be one of {sorted(TASK_STATUSES)}")
    snap = {**snapshot, "task_id": task_id}
    raw = json.dumps(snap, ensure_ascii=False)
    if len(raw.encode("utf-8")) > TASK_SNAPSHOT_MAX:
        raise HTTPException(413, f"snapshot is limited to {TASK_SNAPSHOT_MAX} bytes")
    now = time.time()
    with cc._db_lock, cc.db() as c:
        c.execute(
            "INSERT INTO task_mirror(task_id,snapshot,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(task_id) DO UPDATE SET snapshot=excluded.snapshot, updated_at=excluded.updated_at",
            (task_id, raw, now),
        )
        c.execute(
            "DELETE FROM task_mirror WHERE task_id NOT IN (SELECT task_id FROM task_mirror ORDER BY updated_at DESC LIMIT ?)",
            (TASK_MIRROR_KEEP,),
        )
    _broadcast(_mirror_view(snap, now) | {"type": "task", "task_id": task_id})
    return {"ok": True, "task_id": task_id, "mirrored_at": now}


def _mirror_view(snap: dict, mirrored_at: float) -> dict:
    """A stored snapshot as served: the envelope's own ``updated_at`` (epoch MILLISECONDS, set
    by the desktop) is kept; the gateway's write time goes under ``mirrored_at`` (seconds).
    A snapshot without ``updated_at`` gets the write time in ms so readers see one unit."""
    out = {**snap, "mirrored_at": mirrored_at}
    if not isinstance(out.get("updated_at"), (int, float)):
        out["updated_at"] = int(mirrored_at * 1000)
    return out


@tasks_router.get("")
def task_mirror_list(active: int = 0, limit: int = Query(50, ge=1, le=200)):
    _ensure_schema()
    with cc.db() as c:
        rows = c.execute("SELECT * FROM task_mirror ORDER BY updated_at DESC").fetchall()
    out = []
    for r in rows:
        snap = _loads(r["snapshot"], None)
        if not isinstance(snap, dict):
            continue
        if active and snap.get("status") in TASK_TERMINAL:
            continue
        out.append(_mirror_view(snap, r["updated_at"]))
        if len(out) >= limit:
            break
    return {"items": out, "now": time.time()}


@tasks_router.get("/{task_id}")
def task_mirror_get(task_id: str):
    _ensure_schema()
    _task_id(task_id)
    with cc.db() as c:
        r = c.execute("SELECT * FROM task_mirror WHERE task_id=?", (task_id,)).fetchone()
    snap = _loads(r["snapshot"], None) if r else None
    if not isinstance(snap, dict):
        raise HTTPException(404, "Not found")
    return _mirror_view(snap, r["updated_at"])


# ── Spotify OAuth callback relay (dev only) ─────────────────────────────────
#
# Spotify redirects to http://127.0.0.1:1420/callback. In a packaged build the
# desktop app listens there itself; under `tauri dev` Vite owns :1420 and
# proxies /callback here, and the app polls /pending for its one-time result.

spotify_router = APIRouter(prefix="/api/spotify", tags=["spotify"])

_SPOTIFY_STATE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
_SPOTIFY_CODE = re.compile(r"^[A-Za-z0-9_.~-]{1,2048}$")
_SPOTIFY_TTL = 300.0
_SPOTIFY_MAX = 50
_spotify_lock = threading.Lock()
_spotify_results: dict[str, tuple[float, dict]] = {}


def spotify_store(state: str, result: dict, now: Optional[float] = None) -> None:
    now = time.time() if now is None else now
    with _spotify_lock:
        for k in [k for k, (ts, _) in _spotify_results.items() if now - ts > _SPOTIFY_TTL]:
            del _spotify_results[k]
        while len(_spotify_results) >= _SPOTIFY_MAX:
            del _spotify_results[min(_spotify_results, key=lambda k: _spotify_results[k][0])]
        _spotify_results[state] = (now, result)


def spotify_take(state: str, now: Optional[float] = None) -> dict:
    """One-time: the stored result for `state` (then forgotten), else {"pending": True}."""
    now = time.time() if now is None else now
    with _spotify_lock:
        hit = _spotify_results.pop(state, None)
    if hit is None or now - hit[0] > _SPOTIFY_TTL:
        return {"pending": True}
    return hit[1]


def _spotify_page(message: str, status: int = 200) -> HTMLResponse:
    body = ("<!doctype html><meta charset=\"utf-8\"><title>Spotify</title>"
            "<body style=\"font-family:system-ui;background:#0b0d11;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0\">"
            f"<p>{message}</p></body>")
    return HTMLResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


@spotify_router.get("/callback", response_class=HTMLResponse)
def spotify_callback(state: str = "", code: str = "", error: str = ""):
    if not _SPOTIFY_STATE.match(state) or not (code or error):
        return _spotify_page("This Spotify sign-in link isn't valid — press Connect again in Settings.", 400)
    if code:
        if not _SPOTIFY_CODE.match(code):
            return _spotify_page("Spotify sent an unexpected reply — press Connect again in Settings.", 400)
        spotify_store(state, {"code": code})
        return _spotify_page("Spotify connected — you can close this tab.")
    spotify_store(state, {"error": re.sub(r"[^A-Za-z0-9_]", "", error)[:60] or "unknown"})
    return _spotify_page("Spotify wasn't connected — you can close this tab.")


@spotify_router.get("/pending")
def spotify_pending(state: str = ""):
    if not _SPOTIFY_STATE.match(state):
        raise HTTPException(400, "invalid state")
    return spotify_take(state)


class _RedactSpotifyCode(logging.Filter):
    """Keep the OAuth code out of uvicorn's access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and args[2].startswith("/api/spotify/callback"):
            record.args = args[:2] + (re.sub(r"([?&]code=)[^&]*", r"\1[redacted]", args[2]),) + args[3:]
        return True


logging.getLogger("uvicorn.access").addFilter(_RedactSpotifyCode())


# ── Local model library (D:\ drive scan → LM Studio / Bionic) ───────────────

models_router = APIRouter(prefix="/api/models", tags=["models"])

MODEL_DIRS = [r"D:\AI Models Productivity", r"D:\AI Models Media and Vision", r"D:\ai model voices"]
LMSTUDIO_DIR = Path(r"D:\LM Studio")  # Bionic's downloadsFolder
LINK_PUBLISHER = "local-d"
_WEIGHT_EXT = {".gguf": "gguf", ".safetensors": "safetensors", ".bin": "pytorch-bin", ".pth": "pytorch", ".pt": "pytorch", ".onnx": "onnx", ".ckpt": "checkpoint", ".msgpack": "flax", ".h5": "tensorflow", ".npz": "numpy", ".tflite": "tflite"}


def _category(name: str) -> str:
    n = name.lower()
    if any(k in n for k in ("embed", "bge-", "minilm", "e5-", "gte-")):
        return "Embedding Models"
    if any(k in n for k in ("whisper", "kokoro", "xtts", "parler", "tts", "wav2vec", "pyannote", "vits", "distil-large", "speech")):
        return "Voice STT / TTS Models"
    if any(k in n for k in ("-vl", "vl-", "pixtral", "florence", "moondream", "ocr", "docling", "yolo", "sdxl", "stable-audio", "musicgen", "vision", "llava")):
        return "Vision & Media Models"
    return "Productivity & Coding LLMs"


def _scan_folder(d: Path) -> dict:
    files, size, formats, ggufs, partial = 0, 0, set(), [], False
    for root, _dirs, names in os.walk(d):
        for n in names:
            p = Path(root) / n
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            files += 1
            size += sz
            ext = p.suffix.lower()
            if ext in (".part", ".incomplete", ".tmp") or (len(p.name) >= 64 and all(c in "0123456789abcdef" for c in p.name[:64]) and sz > 5_000_000):
                partial = True
            if ext in _WEIGHT_EXT and sz > 5_000_000:
                formats.add(_WEIGHT_EXT[ext])
                if ext == ".gguf" and not n.lower().startswith("mmproj"):
                    ggufs.append({"file": str(p.relative_to(d)), "gb": round(sz / 1e9, 2)})
    linked = (LMSTUDIO_DIR / LINK_PUBLISHER / d.name).exists()
    in_lms = str(d).lower().startswith(str(LMSTUDIO_DIR).lower())
    status = "gguf" if ggufs else ("partial-download" if partial else ("needs-conversion" if formats else ("unknown-format" if size > 500_000_000 else "incomplete")))
    return {
        "name": d.name, "path": str(d), "category": _category(d.name), "sizeGb": round(size / 1e9, 2), "files": files,
        "formats": sorted(formats), "ggufs": ggufs, "status": status,
        "lmstudioLoadable": bool(ggufs), "registered": linked or in_lms,
        "note": {"gguf": "Loadable in LM Studio / Bionic", "needs-conversion": "Hugging Face weights — convert to GGUF (or use with a Python runtime) to load in Bionic", "incomplete": "No weight files — download looks unfinished", "unknown-format": "Large files in a format the scanner doesn't recognize", "partial-download": "Interrupted Hugging Face download (.part / cache blobs) — resume it with `hf download`"}[status],
    }


@models_router.get("/local-scan")
def local_scan():
    import os as _os  # noqa: F401  (os.walk via module-level import below)
    out = []
    for base in MODEL_DIRS:
        b = Path(base)
        if not b.is_dir():
            continue
        for d in sorted(b.iterdir()):
            if d.is_dir():
                out.append({**_scan_folder(d), "root": base})
    # Bionic's own library too (already loadable).
    if LMSTUDIO_DIR.is_dir():
        for pub in LMSTUDIO_DIR.iterdir():
            if pub.is_dir() and pub.name != LINK_PUBLISHER:
                for d in pub.iterdir():
                    if d.is_dir():
                        out.append({**_scan_folder(d), "root": str(LMSTUDIO_DIR), "registered": True})
    groups: dict[str, list] = {}
    for m in out:
        groups.setdefault(m["category"], []).append(m)
    return {"dirs": MODEL_DIRS, "lmstudioDir": str(LMSTUDIO_DIR), "count": len(out), "groups": groups, "scannedAt": time.time()}


@models_router.post("/sync-lmstudio")
def sync_lmstudio():
    """Link every GGUF folder from the D:\ model dirs into Bionic's library
    (D:\LM Studio\local-d\<folder>) with a directory junction — no copying."""
    import subprocess
    linked, skipped, errors = [], [], []
    target_root = LMSTUDIO_DIR / LINK_PUBLISHER
    target_root.mkdir(parents=True, exist_ok=True)
    for base in MODEL_DIRS:
        b = Path(base)
        if not b.is_dir():
            continue
        for d in sorted(b.iterdir()):
            if not d.is_dir() or not any(p.suffix.lower() == ".gguf" for p in d.rglob("*.gguf")):
                continue
            link = target_root / d.name
            if link.exists():
                skipped.append(d.name)
                continue
            r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(d)], capture_output=True, text=True)
            (linked if r.returncode == 0 else errors).append(d.name if r.returncode == 0 else f"{d.name}: {(r.stderr or r.stdout).strip()[:120]}")
    return {"linked": linked, "alreadyLinked": skipped, "errors": errors, "folder": str(target_root),
            "next": "Bionic picks new folders up on its next model-list refresh (or restart Bionic)."}
