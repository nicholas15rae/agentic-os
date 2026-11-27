"""Tier-1 collectors. Strictly read-only: nothing here creates, changes or removes a file.

Each collector returns records `{kind, ts, source, text, meta}` newer than its watermark plus the
watermark values to store once (and only once) the archive holding them has verified.
Every text is scrubbed before it leaves this module.
"""

from __future__ import annotations

import copy
import datetime as _dt
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import fsutil
from .scrub import scrub

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PREVIEW_DIR = "memory-scrolls-preview"
FIELD_CAP = 4096
DISTILL_CAP = 32 * 1024
NOTE_DIRS = ("ideas", "tasks")
SKIP_NOTE_DIRS = ("anythingllm-prompt-backups",)
STAGING_FILE_LIST_MAX = 200


def iso_ms(ms: Any) -> str:
    try:
        return _dt.datetime.fromtimestamp(float(ms) / 1000.0, _dt.timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def iso_s(s: Any) -> str:
    try:
        f = float(s)
    except (TypeError, ValueError):
        return ""
    if f > 1e11:
        f /= 1000.0
    try:
        return _dt.datetime.fromtimestamp(f, _dt.timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return ""


def clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def booking_thread(name: str) -> bool:
    n = (name or "").lower()
    return "booking" in n or n == "my-workspace"


# Routing fields of a pipeline / turn log line that name the agent, thread or workspace it belongs to.
_BOOKING_FIELDS = ("role", "delegatedTo", "delegated_to", "agent", "agentId", "thread", "threadId", "thread_id", "workspace", "slug", "target", "lane")


def booking_log_line(line: str) -> bool:
    """A training-log line that belongs to the Booking Desk (its role, delegation, thread or workspace).

    Unparsable lines fall back to a raw check of those same fields as JSON text.
    """
    try:
        o = json.loads(line)
    except ValueError:
        o = None
    if isinstance(o, dict):
        return booking_record(o)
    return bool(re.search(r'"(?:%s)"\s*:\s*"[^"]*(?:booking|my-workspace)' % "|".join(_BOOKING_FIELDS), line, re.I))


# A line of free text that names Booking scope (the same rule the read-only hub source applies).
# A plain substring, like `booking_thread` / `booking_record`: "Bookings", "booking_desk",
# "BookingDesk" and "rebooking" all count (over-dropping a line is the safe side).
BOOKING_LINE = re.compile(r"booking|my-workspace", re.I)
# A Booking Desk envelope ("[Booking Desk - action APPROVED by the user]" + its Details payload):
# the whole message / turn is Booking scope, not only its header line.
BOOKING_ENVELOPE = re.compile(r"\s*\[[^\]\n]*(?:booking|my-workspace)", re.I)
# Bumped whenever the Tier-1 Booking filtering changes; an offload preview read under another
# version is refused by `--apply` (offload.py manifest `source_filter`).
SOURCE_FILTER_VERSION = 2


def booking_record(o: dict) -> bool:
    """A chat / log object whose routing fields (role, delegation, thread, workspace) name Booking."""
    return any(isinstance(o.get(k), str) and booking_thread(o[k]) for k in _BOOKING_FIELDS)


def booking_envelope(text: str) -> bool:
    """True when the text opens with a bracketed header that names Booking (a Booking Desk envelope)."""
    return bool(BOOKING_ENVELOPE.match(text or ""))


def drop_booking_lines(text: str) -> Tuple[str, int]:
    """(text without its Booking lines, lines dropped)."""
    kept: List[str] = []
    dropped = 0
    for line in text.replace("\r\n", "\n").split("\n"):
        if BOOKING_LINE.search(line):
            dropped += 1
            continue
        kept.append(line)
    return "\n".join(kept), dropped


def _rec(kind: str, ts: str, source: str, text: str, meta: dict, known) -> dict:
    return {"kind": kind, "ts": ts, "source": source, "text": scrub(text, known), "meta": meta}


def _strip_booking(v: Any) -> Any:
    """A deep copy of a JSON-like value with every Booking line dropped from each string in it."""
    if isinstance(v, str):
        return drop_booking_lines(v)[0]
    if isinstance(v, list):
        return [_strip_booking(x) for x in v]
    if isinstance(v, dict):
        return {k: _strip_booking(x) for k, x in v.items()}
    return copy.deepcopy(v)


def raw_json(obj: Any) -> str:
    """The original source object of a record, Booking lines dropped from every string, as JSON
    text (a string, so the archive's secret scrub covers its keys too). Only `raw=True` collectors
    (the curated seed's Step A archive) attach it, as `meta["raw"]`; it never reaches the model."""
    return json.dumps(_strip_booking(obj), ensure_ascii=False, sort_keys=True)


def decode_line(b: bytes) -> Tuple[str, bool]:
    """(text, valid): UTF-8; bytes that are not valid UTF-8 are kept as backslash-x escapes (lossless,
    flagged by `valid` False) instead of being replaced."""
    try:
        return b.decode("utf-8"), True
    except UnicodeDecodeError:
        return b.decode("utf-8", "backslashreplace"), False


def distill_text(text: str, archive_id: str) -> str:
    """Only the distill input is capped: head 8 KB + tail 2 KB + a pointer into the archive."""
    b = text.encode("utf-8")
    if len(b) <= DISTILL_CAP:
        return text
    head = b[: 8 * 1024].decode("utf-8", "ignore")
    tail = b[-2 * 1024:].decode("utf-8", "ignore")
    return f"{head}\n[... {len(b)} bytes in {archive_id}]\n{tail}"


# ── os-threads.json ─────────────────────────────────────────────────────────


def threads(path: Path, wm: Dict[str, list], known, raw: bool = False) -> Tuple[List[dict], Dict[str, list], dict]:
    """Turns newer than `(at, id)` per thread; Booking threads and system turns skipped.

    Booking is filtered inside the other threads too (the rule gateway chat uses): a turn from a
    Booking speaker or opening with a Booking Desk envelope is skipped whole, and any remaining line
    that names Booking (or my-workspace) is dropped before the turn is recorded.

    `raw` (the curated seed's lossless Step A archive, never distilled): system turns are kept too
    (meta `system`), a turn whose routing fields name Booking is skipped whole, and each record
    carries the whole original turn (`from` / `to` / `role` / `meta` / `tone` ..., Booking lines
    dropped) as `meta["raw"]`.
    """
    out: List[dict] = []
    new_wm = dict(wm)
    note: dict = {}
    if not Path(path).is_file():
        return out, new_wm, {"skipped": "os-threads.json missing"}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return out, new_wm, {"skipped": f"os-threads.json unreadable ({type(e).__name__})"}
    tmap = data.get("threads") if isinstance(data, dict) else None
    if not isinstance(tmap, dict):
        return out, new_wm, {"skipped": "os-threads.json has no threads"}
    skipped = turns_skipped = lines_skipped = 0
    for name in sorted(tmap):
        turns = tmap[name]
        if booking_thread(name):
            skipped += 1
            continue
        if not isinstance(turns, list):
            continue
        mark = wm.get(name) or [0, ""]
        mark_t = (int(mark[0]) if str(mark[0]).lstrip("-").isdigit() else 0, str(mark[1]))
        best = mark_t
        for t in turns:
            if not isinstance(t, dict):
                continue
            at = t.get("at")
            tid = str(t.get("id") or "")
            if not isinstance(at, int):
                continue
            key = (at, tid)
            if key <= mark_t:
                continue
            best = max(best, key)
            who = str(t.get("who") or "")
            if who == "system" and not raw:
                continue
            body = str(t.get("text") or "").strip()
            if booking_thread(who) or booking_envelope(body) or (raw and _booking_turn(t)):
                turns_skipped += 1
                continue
            text, dropped = drop_booking_lines(body)
            lines_skipped += dropped
            text = text.strip()
            if not text and not raw:
                continue
            meta = {"thread": name, "who": who, "id": tid}
            if raw:
                meta["raw"] = raw_json(t)
                if who == "system":
                    meta["system"] = True
            out.append(_rec("turn", iso_ms(at), f"thread:{name}", f"{who}: {text}", meta, known))
        if best != mark_t:
            new_wm[name] = [best[0], best[1]]
    if skipped:
        note["booking_threads_skipped"] = skipped
    if turns_skipped:
        note["booking_turns_skipped"] = turns_skipped
    if lines_skipped:
        note["booking_lines_skipped"] = lines_skipped
    return out, new_wm, note


# ── tasks.db (read-only connection) ─────────────────────────────────────────


def open_ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=ON")
    return conn


def _cols(conn: sqlite3.Connection, table: str) -> List[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def _has_table(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def _field(row: dict, key: str, cap: int = FIELD_CAP) -> str:
    v = row.get(key)
    if v is None:
        return ""
    return clip(str(v), cap)


def tasks_db(path: Path, wm_env: Dict[str, int], wm_seq: int, known) -> Tuple[List[dict], Dict[str, int], int, dict]:
    out: List[dict] = []
    new_env = dict(wm_env)
    new_seq = wm_seq
    if not Path(path).is_file():
        return out, new_env, new_seq, {"skipped": "tasks.db missing"}
    conn = open_ro(path)
    try:
        slugs: Dict[str, str] = {}
        if _has_table(conn, "task_envelope"):
            cols = _cols(conn, "task_envelope")
            want = [c for c in ("task_id", "created_at", "updated_at", "status", "raw_intent", "raw_intent_at", "title", "project_slug", "prompt_spec", "librarian_notes", "voice_summaries", "iteration_count") if c in cols]
            if "task_id" in want and "status" in want:
                q = f"SELECT {', '.join(want)} FROM task_envelope ORDER BY {'updated_at' if 'updated_at' in want else 'task_id'}"
                for raw in conn.execute(q):
                    row = dict(zip(want, raw))
                    tid = str(row["task_id"])
                    if row.get("project_slug"):
                        slugs[tid] = str(row["project_slug"])
                    if row.get("status") not in ("review_ready", "failed"):
                        continue
                    upd = int(row.get("updated_at") or 0)
                    if tid in wm_env and int(wm_env[tid]) >= upd:
                        continue
                    new_env[tid] = upd
                    text = "\n".join(
                        x for x in (
                            f"Task {tid} [{row.get('status')}] project={row.get('project_slug') or '-'} title={_field(row, 'title', 200)}",
                            f"Intent: {_field(row, 'raw_intent')}",
                            f"Spec: {_field(row, 'prompt_spec')}" if row.get("prompt_spec") else "",
                            f"Librarian: {_field(row, 'librarian_notes')}" if row.get("librarian_notes") else "",
                            f"Voice: {_field(row, 'voice_summaries', 2048)}" if row.get("voice_summaries") not in (None, "", "{}") else "",
                        ) if x
                    )
                    out.append(_rec("envelope", iso_s(upd), "tasks.db", text, {"task_id": tid, "project_slug": row.get("project_slug"), "status": row.get("status")}, known))
        if _has_table(conn, "handoff_log"):
            cols = _cols(conn, "handoff_log")
            want = [c for c in ("seq", "task_id", "timestamp", "from_agent", "to_agent", "event_type", "severity", "short_summary", "voice_summary") if c in cols]
            if "seq" in want:
                for raw in conn.execute(f"SELECT {', '.join(want)} FROM handoff_log WHERE seq > ? ORDER BY seq", (int(wm_seq),)):
                    row = dict(zip(want, raw))
                    seq = int(row["seq"])
                    new_seq = max(new_seq, seq)
                    tid = str(row.get("task_id") or "")
                    text = f"{row.get('from_agent')} -> {row.get('to_agent')} [{row.get('event_type')}/{row.get('severity')}]: {_field(row, 'short_summary', 600)}"
                    if row.get("voice_summary"):
                        text += f" | {_field(row, 'voice_summary', 300)}"
                    out.append(_rec("handoff", iso_s(row.get("timestamp")), "tasks.db", text, {"task_id": tid, "seq": seq, "project_slug": slugs.get(tid), "severity": row.get("severity")}, known))
    finally:
        conn.close()
    return out, new_env, new_seq, {}


# ── staging build outputs ───────────────────────────────────────────────────


def _sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def staging(root: Path, wm: Dict[str, str], known) -> Tuple[List[dict], Dict[str, str], dict]:
    out: List[dict] = []
    new_wm = dict(wm)
    root = Path(root)
    if not root.is_dir():
        return out, new_wm, {"skipped": "staging root missing"}
    for d in sorted(root.iterdir()):
        name = d.name
        if name == PREVIEW_DIR or not SLUG_RE.match(name) or fsutil.is_reparse(d) or not d.is_dir():
            continue
        status = d / ".status.json"
        if not status.is_file() or fsutil.is_reparse(status):
            continue
        sha = _sha_file(status)
        if wm.get(name) == sha:
            continue
        new_wm[name] = sha
        try:
            status_text = clip(status.read_text(encoding="utf-8", errors="replace"), FIELD_CAP)
        except OSError:
            continue
        files = []
        for p in sorted(d.rglob("*")):
            if len(files) >= STAGING_FILE_LIST_MAX:
                files.append("... (more files)")
                break
            if fsutil.is_reparse(p) or not p.is_file():
                continue
            rel = p.relative_to(d).as_posix()
            try:
                files.append(f"{rel} {p.stat().st_size} {_sha_file(p)}")
            except OSError:
                continue
        text = f"Build {name} status:\n{status_text}\nFiles:\n" + "\n".join(files)
        ts = iso_s(status.stat().st_mtime)
        out.append(_rec("build_log", ts, f"staging:{name}", text, {"project_slug": name}, known))
    return out, new_wm, {}


# ── Tony's notes ────────────────────────────────────────────────────────────


def notes(root: Path, wm: Dict[str, str], known) -> Tuple[List[dict], Dict[str, str], dict]:
    out: List[dict] = []
    new_wm = dict(wm)
    root = Path(root)
    if not root.is_dir():
        return out, new_wm, {"skipped": "notes root missing"}
    for sub in NOTE_DIRS:
        d = root / sub
        if not d.is_dir() or fsutil.is_reparse(d):
            continue
        for p in sorted(d.glob("*.md")):
            if fsutil.is_reparse(p) or not p.is_file():
                continue
            rel = f"{sub}/{p.name}"
            sha = _sha_file(p)
            if wm.get(rel) == sha:
                continue
            new_wm[rel] = sha
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            out.append(_rec("note", iso_s(p.stat().st_mtime), f"notes:{rel}", text, {"rel": rel}, known))
    return out, new_wm, {}


# ── optional sources ────────────────────────────────────────────────────────


def training_logs(root: Path, wm: Dict[str, int], known, raw: bool = False) -> Tuple[List[dict], Dict[str, int], dict]:
    """Training-log lines after each file's byte watermark. `raw` (the lossless Step A archive):
    lines are split on newlines only, never clipped, and bytes that are not valid UTF-8 are kept
    as escapes (meta `utf8_invalid`) instead of being replaced."""
    out: List[dict] = []
    new_wm = dict(wm)
    skipped = 0
    root = Path(root)
    if not root.is_dir():
        return out, new_wm, {"skipped": "training_logs missing"}
    for p in sorted(root.glob("*.jsonl")):
        if fsutil.is_reparse(p):
            continue
        start = int(wm.get(p.name, 0))
        try:
            with open(p, "rb") as f:
                f.seek(start)
                data = f.read()
        except OSError:
            continue
        end = start + len(data)
        if data and not data.endswith(b"\n"):
            cut = data.rfind(b"\n") + 1
            data, end = data[:cut], start + cut
        if raw:
            lines = [decode_line(b[:-1] if b.endswith(b"\r") else b) for b in data.split(b"\n")]
        else:
            lines = [(x, True) for x in data.decode("utf-8", "replace").splitlines()]
        for line, valid in lines:
            if not line.strip():
                continue
            # Booking-routed, or naming Booking anywhere (a log line is one record: dropped whole).
            if booking_log_line(line) or BOOKING_LINE.search(line):
                skipped += 1
                continue
            meta: Dict[str, Any] = {"file": p.name}
            if not valid:
                meta["utf8_invalid"] = True
            out.append(_rec("training_log", "", f"training_logs:{p.name}", line if raw else clip(line, DISTILL_CAP), meta, known))
        new_wm[p.name] = end
    return out, new_wm, ({"booking_lines_skipped": skipped} if skipped else {})


def _booking_turn(t: dict) -> bool:
    """A thread turn whose routing fields (incl. a relay's `from` / `to`) name Booking."""
    return booking_record(t) or any(isinstance(t.get(k), str) and booking_thread(t[k]) for k in ("from", "to"))


def _msg_ts(m: Any) -> Optional[float]:
    """A chat message's time as epoch seconds (ISO text or s / ms number), None when absent."""
    if not isinstance(m, dict):
        return None
    v = m.get("timestamp") if m.get("timestamp") is not None else m.get("at")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        f = float(v)
        return f / 1000.0 if f > 1e11 else f
    if isinstance(v, str) and v.strip():
        try:
            d = _dt.datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        if d.tzinfo is None:
            d = d.replace(tzinfo=_dt.timezone.utc)
        return d.timestamp()
    return None


def gateway_mark(items: List[Any], prev: Any) -> Any:
    """The gateway-chat watermark after `items`: `{"id", "ts", "n"}` of the last message (its id,
    its timestamp, and the item count as a last resort for messages with neither). Never an item
    count alone: server.py keeps only the last 200 messages, so indices shift. `prev` is kept when
    there is no message."""
    for m in reversed(items):
        if isinstance(m, dict):
            v = m.get("timestamp") if m.get("timestamp") is not None else m.get("at")
            ts = v if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""
            return {"id": str(m.get("id") or ""), "ts": ts, "n": len(items)}
    return prev


def _count_start(n: Any, total: int) -> Tuple[int, Dict[str, Any]]:
    """A legacy item-count watermark: honoured while it still fits the file; past its end the file
    was trimmed or replaced, so every message counts as new (twice beats never)."""
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        n = 0
    if n < 0 or n > total:
        return 0, {"watermark_trimmed": True}
    return n, {}


def gateway_start(items: List[Any], wm: Any) -> Tuple[int, Dict[str, Any]]:
    """(index of the first message newer than `wm`, notes).

    `wm` is `{"id", "ts", "n"}` (see `gateway_mark`): the message after that id; when the id is gone
    (the server trimmed it), every message newer than its timestamp (every message when the time
    is unknown: archiving a message twice beats losing one), with a `watermark_trimmed` note since
    messages trimmed in between can no longer be read. A mark with neither id nor time (messages
    without them) and a legacy int (the item count of state written before this change) are
    item counts, honoured only while they still fit the file.
    """
    if not isinstance(wm, dict):
        return _count_start(wm, len(items))
    mid = str(wm.get("id") or "")
    if mid:
        for i in range(len(items) - 1, -1, -1):
            m = items[i]
            if isinstance(m, dict) and str(m.get("id") or "") == mid:
                return i + 1, {}
    raw_ts = wm.get("ts")
    if raw_ts in (None, ""):
        if mid:
            return 0, {"watermark_trimmed": True}
        return _count_start(wm.get("n"), len(items))
    ts = _msg_ts({"timestamp": raw_ts})
    if ts is None:
        return 0, {"watermark_trimmed": True}
    for i, m in enumerate(items):
        t = _msg_ts(m)
        if t is None or t > ts:
            return i, ({"watermark_trimmed": True} if mid else {})
    return len(items), {}


def gateway_chat(path: Path, wm: Any, known, raw: bool = False) -> Tuple[List[dict], Any, dict]:
    """Tony gateway chat turns newer than `wm` (see `gateway_start` / `gateway_mark`: keyed on the
    last message's id, so the server trimming the file to 200 messages never skips a new one).

    Booking is filtered like threads and training logs: a message whose routing fields (role,
    agent, delegation, thread, workspace) name Booking, or that opens with a Booking Desk envelope
    header (its Details payload is Booking scope), is skipped whole, and any remaining line that
    names Booking (or my-workspace) is dropped before the text is recorded. Counts only in notes.
    Every record keeps the message's `role`, `agent` and `id`; `raw` (the lossless Step A archive)
    also attaches the whole original message (Booking lines dropped) as `meta["raw"]`.
    """
    path = Path(path)
    if not path.is_file():
        return [], wm, {"skipped": "chat-history.json missing"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], wm, {"skipped": "chat-history.json unreadable"}
    items = data if isinstance(data, list) else (data.get("messages") or data.get("history") or []) if isinstance(data, dict) else []
    if not isinstance(items, list):
        items = []
    start, notes = gateway_start(items, wm)
    out = []
    msgs_skipped = lines_skipped = 0
    for m in items[start:]:
        if isinstance(m, dict):
            body = str(m.get("content") or m.get("text") or m.get("message") or "")
            if booking_record(m) or booking_envelope(body):
                msgs_skipped += 1
                continue
            role = str(m.get("role") or m.get("agent") or "")
            text, dropped = drop_booking_lines(body)
            lines_skipped += dropped
            if text.strip() or raw:
                meta = {"role": role, "agent": str(m.get("agent") or ""), "id": str(m.get("id") or "")}
                if raw:
                    meta["raw"] = raw_json(m)
                out.append(_rec("gateway_chat", iso_s(m.get("timestamp") or m.get("at")), "gateway-chat", f"{role}: {text}", meta, known))
    if msgs_skipped:
        notes["booking_messages_skipped"] = msgs_skipped
    if lines_skipped:
        notes["booking_lines_skipped"] = lines_skipped
    return out, gateway_mark(items, wm), notes


# ── all of Tier 1 ───────────────────────────────────────────────────────────


def collect(paths, wm: Dict[str, Any], known, include_training_logs: bool = False, include_gateway_chat: bool = False) -> Tuple[List[dict], Dict[str, Any], Dict[str, Any]]:
    """(records, new watermarks, per-source notes). Pure read."""
    wm = copy.deepcopy(wm)
    notes_out: Dict[str, Any] = {}
    records: List[dict] = []
    r, wm["threads"], n = threads(paths.threads_json, wm.get("threads") or {}, known)
    records += r
    notes_out["threads"] = {"records": len(r), **n}
    try:
        r, wm["envelopes"], wm["handoff_seq"], n = tasks_db(paths.tasks_db, wm.get("envelopes") or {}, int(wm.get("handoff_seq") or 0), known)
    except sqlite3.Error as e:
        r, n = [], {"skipped": f"tasks.db unreadable ({type(e).__name__})"}
    records += r
    notes_out["tasks_db"] = {"records": len(r), **n}
    r, wm["staging"], n = staging(paths.staging_root, wm.get("staging") or {}, known)
    records += r
    notes_out["staging"] = {"records": len(r), **n}
    r, wm["notes"], n = notes(paths.notes_root, wm.get("notes") or {}, known)
    records += r
    notes_out["notes"] = {"records": len(r), **n}
    if include_training_logs:
        r, wm["training_logs"], n = training_logs(paths.training_logs, wm.get("training_logs") or {}, known)
        records += r
        notes_out["training_logs"] = {"records": len(r), **n}
    if include_gateway_chat:
        r, wm["gateway_chat"], n = gateway_chat(paths.gateway_chat, wm.get("gateway_chat") or 0, known)
        records += r
        notes_out["gateway_chat"] = {"records": len(r), **n}
    return records, wm, notes_out


def pending(records: Iterable[dict]) -> Dict[str, Any]:
    """Totals for `status` and the auto-compaction threshold."""
    by: Dict[str, int] = {}
    total = 0
    turns = 0
    n = 0
    for r in records:
        b = len(r["text"].encode("utf-8"))
        total += b
        n += 1
        if r["kind"] == "turn":
            turns += 1
        key = r["source"].split(":", 1)[0]
        by[key] = by.get(key, 0) + b
    return {"bytes": total, "turns": turns, "records": n, "by_source": by}


def project_hint(record: dict) -> Optional[str]:
    slug = (record.get("meta") or {}).get("project_slug")
    return slug if isinstance(slug, str) and SLUG_RE.match(slug) else None
