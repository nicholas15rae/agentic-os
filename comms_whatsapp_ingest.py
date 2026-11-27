"""PC WhatsApp ingester (Comms step 5, build plan Sections 8-10).

Reads the lharries whatsapp-mcp bridge's own message store (whatsapp-bridge/store/messages.db)
READ-ONLY and posts new messages to the gateway's ingest path (POST /api/comms/ingest, source
"wa-mcp"), so incoming WhatsApp messages land in the Comms inbox next to SMS.

Rules it keeps:
- It opens only a file named messages.db, through a `mode=ro` URI plus `PRAGMA query_only`. It
  never opens whatsapp.db (the linked device's session keys live there).
- It selects explicit columns only. Media decryption keys, media URLs, file hashes, lengths and
  file names are never read, so they can't reach cc.db or the vault; a media message becomes a
  placeholder such as "[photo] caption".
- New rows are found by rowid (a watermark) plus a seen-set of (chat, message id). The bridge's
  `timestamp` is TEXT with a UTC offset ("2026-11-01 01:30:00-04:00"), so comparing it as a
  string breaks at DST changes; it is only parsed to epoch seconds, per row, never compared.
  The bridge's INSERT OR REPLACE gives a re-delivered message a new rowid: the seen-set (and the
  gateway's id dedupe) keeps it from showing twice. If the rowids shrink (a new messages.db after
  a re-pair, or a VACUUM) the watermark starts over and the dedupe absorbs the repeats.
- The thread key is the WhatsApp JID (the gateway keys a desktop send's phone number on the same
  JID). A "from me" row that matches a recent desktop send (same thread and text, within 60 s)
  is skipped: the desktop already recorded that bubble.
- The gateway URL must be loopback; nothing is sent anywhere else. The state file holds hashes
  only (no JIDs, no text) and lives in data/command-center/ (git-ignored). Logs carry counts only.

Run:  python comms_whatsapp_ingest.py --once        one pass, then exit
      python comms_whatsapp_ingest.py --loop        poll every --interval seconds (default 20)
      add --dry-run to read and count without posting or saving state.
start-command-center.ps1 starts it with --loop when the WhatsApp bridge is enabled there.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = Path(os.environ.get("WHATSAPP_MESSAGES_DB") or r"G:\ai-hub\whatsapp-mcp\whatsapp-bridge\store\messages.db")
DATA_DIR = Path(os.environ["CC_DATA_DIR"]).expanduser().resolve() if os.environ.get("CC_DATA_DIR") else ROOT / "data" / "command-center"
DEFAULT_STATE = DATA_DIR / "wa-ingest-state.json"
DEFAULT_GATEWAY = "http://127.0.0.1:8080"

SOURCE = "wa-mcp"
APP_VERSION = "wa-ingest/1"
DB_NAME = "messages.db"                 # the only file this module ever opens
FORBIDDEN_NAMES = frozenset({"whatsapp.db"})
# Exactly the columns read; nothing else of the row is ever selected.
REQUIRED_COLUMNS = {
    "messages": ("id", "chat_jid", "content", "timestamp", "is_from_me", "media_type"),
    "chats": ("jid", "name"),
}
_SELECT = (
    "SELECT m.rowid AS rid, m.id AS mid, m.chat_jid AS jid, m.content AS content, m.timestamp AS ts, "
    "m.is_from_me AS from_me, m.media_type AS media_type, c.name AS chat_name "
    "FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid "
    "WHERE m.rowid > ? ORDER BY m.rowid LIMIT ?"
)
BATCH = 500                 # rows read and posted per /ingest call
SEEN_MAX = 20000            # remembered (chat, id) hashes, oldest dropped first
ECHO_MAX = 2000             # remembered desktop rows already matched by a from-me copy
ECHO_WINDOW_SECS = 60.0     # os_api.ECHO_WINDOW_SECS for a desktop send
HEARTBEAT_SECS = 300.0
DEFAULT_BACKFILL_DAYS = 30  # first run: older history is skipped
WA_USER_SERVER = "@s.whatsapp.net"
SKIP_JID_SUFFIXES = ("@broadcast", "@newsletter")  # status updates, broadcast lists, channels
MEDIA_LABEL = {"image": "photo", "video": "video", "audio": "voice message", "document": "document", "sticker": "sticker"}
_INGEST_ID = re.compile(r"[\x21-\x7e]{1,200}")       # os_api._INGEST_ID
_INVISIBLE = re.compile("[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")
_DEVICE_BAD = re.compile(r"[^A-Za-z0-9 ._-]")
_TS = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?",
    re.IGNORECASE,
)


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} wa-ingest: {msg}", file=sys.stderr, flush=True)


# ── parsing ──────────────────────────────────────────────────────────────────

def parse_ts(v: Any) -> Optional[float]:
    """The bridge's timestamp → epoch seconds, or None. Go's sqlite driver writes TEXT like
    '2026-11-01 01:30:00-04:00' (optionally with nanoseconds): the offset is applied, so the same
    wall-clock time before and after a DST change gives two different, correct instants. A value
    without an offset is UTC (the driver's own default); a number is epoch s or ms."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, bytes):
        v = v.decode("ascii", "ignore")
    if isinstance(v, (int, float)):
        f = float(v)
    else:
        s = str(v).strip()
        if re.fullmatch(r"\d{9,13}(?:\.\d+)?", s):
            f = float(s)
        else:
            m = _TS.fullmatch(s)
            if not m:
                return None
            y, mo, d, h, mi, se = (int(m.group(i)) for i in range(1, 7))
            micro = int((m.group(7) or "").ljust(6, "0")[:6])
            tz = (m.group(8) or "Z").upper()
            if tz == "Z":
                off = timedelta(0)
            else:
                digits = tz[1:].replace(":", "")
                hh, mm = int(digits[:2]), int(digits[2:4] or 0)
                if hh > 23 or mm > 59:
                    return None
                off = timedelta(hours=hh, minutes=mm) * (1 if tz[0] == "+" else -1)
            try:
                f = datetime(y, mo, d, h, mi, se, micro, tzinfo=timezone(off)).timestamp()
            except (ValueError, OverflowError):
                return None
    if f > 1e11:
        f /= 1000.0
    return f if f > 0 else None


def wa_thread_key(jid: str) -> str:
    """os_api._thread_key(jid, "whatsapp") for a JID: lowercased."""
    return str(jid or "").strip().lower()


def clean_name(v: Any) -> str:
    """A chat name as a display label: no control / bidi / zero-width characters, one line, capped."""
    t = _INVISIBLE.sub("", unicodedata.normalize("NFKC", str(v or "")))
    return " ".join(t.split())[:120]


def seen_key(jid: str, mid: str) -> str:
    """The seen-set holds hashes, never a JID or a message id in the clear."""
    return hashlib.sha256(f"{jid}\x00{mid}".encode("utf-8")).hexdigest()[:20]


def default_device() -> str:
    d = _DEVICE_BAD.sub("", socket.gethostname() or "").strip(" ._-")[:64]
    return d or "pc"


def to_ingest(row: sqlite3.Row) -> tuple[Optional[dict], str]:
    """One bridge row → (IngestMessage, "ok"), or (None, why it was skipped)."""
    jid = str(row["jid"] or "").strip()
    mid = str(row["mid"] or "").strip()
    if not jid or not mid:
        return None, "bad"
    if jid.lower().endswith(SKIP_JID_SUFFIXES):
        return None, "broadcast"
    msg_id = f"wa:{jid}:{mid}"
    if not _INGEST_ID.fullmatch(msg_id):
        return None, "bad"
    ts = parse_ts(row["ts"])
    if ts is None:
        return None, "bad_ts"
    content = str(row["content"] or "").strip()
    media = str(row["media_type"] or "").strip().lower()
    if media:
        label = MEDIA_LABEL.get(media, "attachment")
        body = f"[{label}] {content}" if content else f"[{label}]"
    else:
        body = content
    if not body:
        return None, "empty"
    group = jid.lower().endswith("@g.us")
    name = clean_name(row["chat_name"])
    meta: dict = {"kind": "media" if media else "text"}
    if group:
        meta["isGroup"] = True
        if name:
            meta["conversationTitle"] = name
    msg = {
        "id": msg_id, "channel": "whatsapp", "address": jid, "body": body, "ts": ts,
        "direction": "out" if bool(row["from_me"]) else "in", "meta": meta,
    }
    if name:
        msg["contact"] = name
    return msg, "ok"


# ── messages.db (read-only) ──────────────────────────────────────────────────

class SchemaError(RuntimeError):
    pass


def open_messages_db(path: Path | str) -> sqlite3.Connection:
    """messages.db, read-only. Anything else (whatsapp.db above all) is refused before sqlite
    sees the path."""
    p = Path(path)
    for name in (p.name, p.resolve().name):
        if name.lower() in FORBIDDEN_NAMES or name.lower() != DB_NAME:
            raise ValueError(f"refusing to open {name!r}: only {DB_NAME} is read")
    if not p.is_file():
        raise FileNotFoundError(f"no {DB_NAME} at {p}")
    conn = sqlite3.connect(p.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=1")
    return conn


def check_schema(conn: sqlite3.Connection) -> list[str]:
    """Missing columns as 'table.column' (empty = OK). Upstream may change the schema: a missing
    column disables ingest instead of guessing."""
    missing = []
    for table, cols in REQUIRED_COLUMNS.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        missing += [f"{table}.{c}" for c in cols if c not in have]
    return missing


# ── state (hashes only) ──────────────────────────────────────────────────────

class State:
    def __init__(self, path: Optional[Path]):
        self.path = path
        self.fresh = True
        self.watermark = 0
        self.cutoff: Optional[float] = None
        self.seen: dict[str, None] = {}   # insertion-ordered set
        self.echoes: dict[str, None] = {}
        self.status: dict = {}
        if path and path.is_file():
            try:
                d = json.loads(path.read_text(encoding="utf-8"))
                self.watermark = int(d.get("watermark") or 0)
                self.cutoff = d.get("cutoff")
                self.seen = dict.fromkeys(str(x) for x in d.get("seen") or [])
                self.echoes = dict.fromkeys(str(x) for x in d.get("echoes") or [])
                self.fresh = False
            except Exception as e:  # a damaged state file: start over (the gateway dedupes)
                log(f"state file unreadable ({type(e).__name__}); starting over")

    def add_seen(self, key: str) -> None:
        self.seen.pop(key, None)
        self.seen[key] = None
        while len(self.seen) > SEEN_MAX:
            self.seen.pop(next(iter(self.seen)))

    def add_echo(self, desktop_id: str) -> None:
        self.echoes[desktop_id] = None
        while len(self.echoes) > ECHO_MAX:
            self.echoes.pop(next(iter(self.echoes)))

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "version": 1, "watermark": self.watermark, "cutoff": self.cutoff,
            "seen": list(self.seen), "echoes": list(self.echoes), "status": self.status,
            "updated": time.time(),
        }), encoding="utf-8")
        os.replace(tmp, self.path)
        self.fresh = False


# ── gateway (loopback only) ──────────────────────────────────────────────────

class GatewayError(RuntimeError):
    pass


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


class Gateway:
    """POST/GET JSON to the local gateway. Loopback needs no token (server.py ZeroTrustMiddleware),
    and no proxy is ever used."""

    def __init__(self, base: str = DEFAULT_GATEWAY, timeout: float = 15.0):
        u = urllib.parse.urlsplit(base)
        if u.scheme != "http" or not u.hostname or not _is_loopback(u.hostname):
            raise ValueError("the gateway URL must be http:// on loopback (WhatsApp data stays on this PC)")
        self.base = base.rstrip("/")
        self.timeout = timeout
        self._open = urllib.request.build_opener(urllib.request.ProxyHandler({})).open

    def _call(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        where = re.sub(r"/threads/[^/]+", "/threads/<thread>", path.split("?")[0])  # no JID in a log line
        try:
            with self._open(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            raise GatewayError(f"{method} {where} -> HTTP {e.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise GatewayError(f"{method} {where} -> {type(e).__name__}") from None

    def post(self, path: str, body: dict) -> dict:
        return self._call("POST", path, body)

    def get(self, path: str) -> dict:
        return self._call("GET", path)


# ── one pass ─────────────────────────────────────────────────────────────────

def _desktop_sends(gw, thread: str, cache: dict) -> list[dict]:
    """Outgoing WhatsApp rows in this thread that didn't come from this ingester: the desktop's
    own send records (pipeline.rs posts them to /api/comms/sms)."""
    if thread not in cache:
        r = gw.get(f"/api/comms/threads/{urllib.parse.quote(thread, safe='')}/messages?limit=200")
        cache[thread] = [
            m for m in (r.get("messages") or [])
            if isinstance(m, dict) and m.get("direction") == "out" and m.get("channel") == "whatsapp"
            and m.get("source") != SOURCE and not str(m.get("id") or "").startswith("wa:")
        ]
    return cache[thread]


def _echo_of(msg: dict, gw, state: State, cache: dict) -> Optional[str]:
    """The desktop send this from-me copy belongs to (once per desktop row), or None."""
    for m in _desktop_sends(gw, wa_thread_key(msg["address"]), cache):
        mid = str(m.get("id") or "")
        try:
            near = abs(float(m.get("ts")) - msg["ts"]) <= ECHO_WINDOW_SECS
        except (TypeError, ValueError):
            near = False
        if near and mid and mid not in state.echoes and str(m.get("body") or "") == msg["body"]:
            return mid
    return None


def run_once(db_path: Path | str, state: State, gw, *, device: str, backfill_days: float = DEFAULT_BACKFILL_DAYS,
             dry_run: bool = False, now: Optional[Callable[[], float]] = None) -> dict:
    """Read everything past the watermark, post it, advance. Returns counts. A gateway failure
    stops the pass with the watermark at the last batch that was posted (nothing is lost)."""
    clock = now or time.time
    counts = {"read": 0, "posted": 0, "added": 0, "dup": 0, "rejected": 0, "seen": 0, "echo": 0, "old": 0, "skipped": 0}
    if state.fresh and state.cutoff is None:
        state.cutoff = clock() - max(0.0, float(backfill_days)) * 86400.0
    conn = open_messages_db(db_path)
    try:
        missing = check_schema(conn)
        if missing:
            raise SchemaError("messages.db schema changed, ingest is off until this module is updated: missing " + ", ".join(missing))
        top = conn.execute("SELECT COALESCE(MAX(rowid), 0) FROM messages").fetchone()[0]
        if top < state.watermark:
            log("messages.db rowids went back (new database or VACUUM): rescanning; duplicates are dropped")
            state.watermark = 0
        while True:
            rows = conn.execute(_SELECT, (state.watermark, BATCH)).fetchall()
            if not rows:
                break
            out: list[dict] = []
            keys: list[str] = []
            echo_ids: list[str] = []
            cache: dict = {}
            batch_echo: set[str] = set()
            for row in rows:
                counts["read"] += 1
                msg, why = to_ingest(row)
                if msg is None:
                    counts["skipped"] += 1
                    continue
                key = seen_key(row["jid"], row["mid"])
                if key in state.seen:
                    counts["seen"] += 1
                    continue
                keys.append(key)
                if state.cutoff is not None and msg["ts"] < state.cutoff:
                    counts["old"] += 1
                    continue
                if msg["direction"] == "out":
                    echo = _echo_of(msg, gw, state, cache)
                    if echo and echo not in batch_echo:
                        batch_echo.add(echo)
                        echo_ids.append(echo)
                        state.add_echo(echo)   # rolled back below if the post fails
                        counts["echo"] += 1
                        continue
                out.append(msg)
            if out and not dry_run:
                try:
                    r = gw.post("/api/comms/ingest", {"source": SOURCE, "device": device, "messages": out})
                except Exception:
                    for e in echo_ids:
                        state.echoes.pop(e, None)
                    raise
                for k in ("added", "dup", "rejected"):
                    counts[k] += int(r.get(k) or 0)
            counts["posted"] += len(out)
            if dry_run:
                state.watermark = rows[-1]["rid"]   # in memory only: the pass walks the whole DB once
                continue
            for k in keys:
                state.add_seen(k)
            state.watermark = rows[-1]["rid"]
            state.save()
        state.cutoff = None   # the first pass reached the end: no more backfill limit
    finally:
        conn.close()
    if not dry_run:
        state.status = {"ok": True, "at": clock(), "counts": counts}
        state.save()
    return counts


def heartbeat(gw, device: str, *, db_ok: bool, schema_ok: bool) -> None:
    gw.post("/api/comms/heartbeat", {
        "source": SOURCE, "device": device, "perms": {"messagesDb": db_ok, "schemaOk": schema_ok}, "appVersion": APP_VERSION,
    })


def loop(db_path: Path, state_path: Path, gw: Gateway, *, device: str, interval: float, backfill_days: float) -> None:
    last_beat = 0.0
    while True:
        db_ok = schema_ok = True
        state = State(state_path)
        try:
            c = run_once(db_path, state, gw, device=device, backfill_days=backfill_days)
            if c["posted"] or c["echo"]:
                log("posted {posted} (added {added}, dup {dup}, rejected {rejected}), desktop echoes {echo}, read {read}".format(**c))
        except SchemaError as e:
            schema_ok = False
            log(str(e))
            state.status = {"ok": False, "at": time.time(), "error": str(e)}
            state.save()
        except (FileNotFoundError, sqlite3.Error, ValueError) as e:
            db_ok = False
            log(f"messages.db not readable ({type(e).__name__}); retrying")
        except GatewayError as e:
            log(f"gateway: {e}; retrying")
        if time.time() - last_beat >= HEARTBEAT_SECS:
            try:
                heartbeat(gw, device, db_ok=db_ok, schema_ok=schema_ok)
                last_beat = time.time()
            except GatewayError:
                pass
        time.sleep(interval)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Read-only WhatsApp messages.db -> Comms inbox ingester")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="one pass, then exit")
    mode.add_argument("--loop", action="store_true", help="poll forever")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"the bridge's {DB_NAME} (default %(default)s)")
    ap.add_argument("--state", type=Path, default=DEFAULT_STATE, help="state file (default %(default)s)")
    ap.add_argument("--gateway", default=os.environ.get("WA_INGEST_GATEWAY") or DEFAULT_GATEWAY, help="loopback gateway URL")
    ap.add_argument("--device", default=default_device())
    ap.add_argument("--interval", type=float, default=20.0, help="seconds between passes with --loop")
    ap.add_argument("--backfill-days", type=float, default=DEFAULT_BACKFILL_DAYS, help="first run: skip history older than this")
    ap.add_argument("--dry-run", action="store_true", help="read and count only: no posting, no state written")
    a = ap.parse_args(argv)
    gw = Gateway(a.gateway)
    if a.loop:
        if a.dry_run:
            ap.error("--dry-run goes with --once")
        try:
            loop(a.db, a.state, gw, device=a.device, interval=max(5.0, a.interval), backfill_days=a.backfill_days)
        except KeyboardInterrupt:
            return 0
    st = State(a.state)   # a dry run reads it but never saves
    try:
        c = run_once(a.db, st, gw, device=a.device, backfill_days=a.backfill_days, dry_run=a.dry_run)
    except (SchemaError, GatewayError, FileNotFoundError, ValueError, sqlite3.Error) as e:
        log(f"{type(e).__name__}: {e}")
        return 1
    print(json.dumps(c))
    return 0


if __name__ == "__main__":
    sys.exit(main())
