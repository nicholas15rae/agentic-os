"""Thread store for gateway agents (Section 26, inventory A5): replaces AnythingLLM's workspace threads.

SQLite at data/engine/threads.db (gitignored, local only):
  threads(id, agent, title, source, created, updated)
  messages(id, thread_id, role, content, at)
Agents get their recent history from here (history(): last N messages, capped by characters, oldest
first, cut on a user turn so a reply never arrives without its question). It is history, not search:
nothing here is embedded or offered to other agents.

import_allm(): the AnythingLLM export's chats become archived threads per agent (source
"anythingllm"), idempotent by (workspace, thread). The Finance workspace is never imported
(money data stays out of the agents), nor are workspaces no agent maps to.
"""
from __future__ import annotations

import contextlib
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Iterator, Optional

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "engine" / "threads.db"
NEVER_IMPORT = {"finance"}


class ThreadStore:
    def __init__(self, path: Path = DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, agent TEXT NOT NULL, title TEXT, source TEXT NOT NULL DEFAULT 'gateway',
                    origin TEXT UNIQUE, created REAL, updated REAL);
                CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, at REAL);
                CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
            """)

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.path, timeout=30)
        try:
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys=ON")
            with c:
                yield c
        finally:
            c.close()

    def new_thread(self, agent: str, title: str = "", source: str = "gateway", origin: Optional[str] = None) -> str:
        tid = uuid.uuid4().hex
        now = time.time()
        with self._db() as c:
            c.execute("INSERT INTO threads(id,agent,title,source,origin,created,updated) VALUES(?,?,?,?,?,?,?)",
                      (tid, agent, title, source, origin, now, now))
        return tid

    def thread(self, tid: str) -> Optional[dict]:
        with self._db() as c:
            r = c.execute("SELECT * FROM threads WHERE id=?", (tid,)).fetchone()
        return dict(r) if r else None

    def threads(self, agent: Optional[str] = None) -> list[dict]:
        with self._db() as c:
            q = "SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id) AS n FROM threads t"
            rows = c.execute(q + (" WHERE agent=? ORDER BY updated DESC" if agent else " ORDER BY updated DESC"), (agent,) if agent else ()).fetchall()
        return [dict(r) for r in rows]

    def append(self, tid: str, role: str, content: str, at: Optional[float] = None) -> None:
        at = at or time.time()
        with self._db() as c:
            c.execute("INSERT INTO messages(thread_id,role,content,at) VALUES(?,?,?,?)", (tid, role, content, at))
            c.execute("UPDATE threads SET updated=MAX(updated, ?) WHERE id=?", (at, tid))

    def history(self, tid: str, max_messages: int = 12, max_chars: int = 12000) -> list[dict]:
        """Recent messages, oldest first, within both caps; starts on a user turn."""
        with self._db() as c:
            rows = c.execute("SELECT role, content FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT ?",
                             (tid, max_messages)).fetchall()
        out, total = [], 0
        for r in rows:
            total += len(r["content"])
            if total > max_chars and out:
                break
            out.append({"role": r["role"], "content": r["content"]})
        out.reverse()
        while out and out[0]["role"] != "user":
            out.pop(0)
        return out

    def import_allm(self, export_dir: Path, ws_to_agent: dict[str, str]) -> dict:
        """AnythingLLM chats → archived threads (one per AnythingLLM thread, or one per workspace for
        chats without a thread). Idempotent. Returns counts."""
        src = sqlite3.connect(f"file:{(Path(export_dir) / 'anythingllm.db').as_posix()}?mode=ro", uri=True)
        src.row_factory = sqlite3.Row
        counts = {"threads": 0, "messages": 0, "skippedWorkspaces": []}
        try:
            ws = {r["id"]: r["slug"] for r in src.execute("SELECT id, slug FROM workspaces")}
            names = {r["id"]: r["name"] for r in src.execute("SELECT id, name FROM workspace_threads")}
            rows = src.execute("SELECT workspaceId, thread_id, prompt, response, createdAt, include FROM workspace_chats ORDER BY id").fetchall()
        finally:
            src.close()
        made: dict[str, str] = {}
        skipped = set()
        for r in rows:
            slug = ws.get(r["workspaceId"])
            agent = ws_to_agent.get(slug or "")
            if not agent or agent in NEVER_IMPORT or slug in NEVER_IMPORT:
                skipped.add(slug or "?")
                continue
            # chats reset out of context in AnythingLLM (include = 0) go to their own archive thread
            reset = r["include"] == 0
            origin = f"anythingllm:{slug}:{r['thread_id'] or 'default'}" + (":reset" if reset else "")
            if origin not in made:
                with self._db() as c:
                    ex = c.execute("SELECT id FROM threads WHERE origin=?", (origin,)).fetchone()
                if ex:
                    made[origin] = ""  # already imported: skip its messages
                else:
                    title = (names.get(r["thread_id"]) or f"{slug} (AnythingLLM)") + (" (reset in AnythingLLM)" if reset else "")
                    made[origin] = self.new_thread(agent, title, "anythingllm", origin)
                    counts["threads"] += 1
            tid = made[origin]
            if not tid:
                continue
            at = _ts(r["createdAt"])
            if r["prompt"]:
                self.append(tid, "user", r["prompt"], at)
                counts["messages"] += 1
            if r["response"]:
                self.append(tid, "assistant", _response_text(r["response"]), at)
                counts["messages"] += 1
        counts["skippedWorkspaces"] = sorted(skipped)
        return counts


def _ts(v) -> float:
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    try:
        return time.mktime(time.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S"))
    except (ValueError, TypeError):
        return time.time()


def _response_text(raw: str) -> str:
    """AnythingLLM stores the response as JSON {text, sources, ...}; keep the text, minus any
    <think> block (the model's hidden reasoning, never part of the reply)."""
    import json
    import re
    text = raw
    try:
        d = json.loads(raw)
        if isinstance(d, dict) and isinstance(d.get("text"), str):
            text = d["text"]
    except ValueError:
        pass
    return re.sub(r"<think>.*?(</think>|$)", "", text, flags=re.S).strip()
