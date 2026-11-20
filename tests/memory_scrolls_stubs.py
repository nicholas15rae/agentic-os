"""Stdlib stub servers for the Memory Scrolls tests (and the Phase 3 smoke): LM Studio, AnythingLLM,
the gateway GPU lease. Each binds 127.0.0.1:0 and records what it saw. Nothing real is contacted.
"""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional


class _Stub:
    def __init__(self) -> None:
        self.requests: List[tuple] = []  # (method, path)
        self.bodies: List[tuple] = []  # (method, path, json body)
        self.lock = threading.Lock()
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    return json.loads(raw.decode("utf-8")) if raw else None
                except ValueError:
                    return None

            def _send(self, code: int, obj: Any):
                data = json.dumps(obj).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                with stub.lock:
                    stub.requests.append(("GET", self.path))
                code, obj = stub.handle("GET", self.path, None, self.headers)
                self._send(code, obj)

            def do_POST(self):
                body = self._body()
                with stub.lock:
                    stub.requests.append(("POST", self.path))
                    stub.bodies.append(("POST", self.path, body))
                code, obj = stub.handle("POST", self.path, body, self.headers)
                self._send(code, obj)

            def do_DELETE(self):
                body = self._body()
                with stub.lock:
                    stub.requests.append(("DELETE", self.path))
                    stub.bodies.append(("DELETE", self.path, body))
                self._send(500, {"error": "unexpected"})

            do_PUT = do_DELETE
            do_PATCH = do_DELETE

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def count(self, method: str, prefix: str = "") -> int:
        return sum(1 for m, p in self.requests if m == method and p.startswith(prefix))

    def handle(self, method, path, body, headers):  # pragma: no cover - overridden
        return 500, {"error": "unexpected"}


class StubLMStudio(_Stub):
    """`/api/v0/models` with a configurable loaded model; `/v1/chat/completions` with scripted replies."""

    def __init__(self, models: Optional[list] = None, replies: Any = None, delay: float = 0.0):
        super().__init__()
        self.models = models if models is not None else [{"id": "qwen/qwen3.5-9b", "type": "llm", "state": "loaded"}]
        self.replies = replies if replies is not None else []
        self.delay = delay
        self.chat_bodies: List[dict] = []
        self.in_flight = 0
        self.max_concurrency = 0

    def handle(self, method, path, body, headers):
        if method == "GET" and path == "/api/v0/models":
            return 200, {"data": self.models}
        if method == "POST" and path == "/v1/chat/completions":
            with self.lock:
                self.in_flight += 1
                self.max_concurrency = max(self.max_concurrency, self.in_flight)
                self.chat_bodies.append(body)
            try:
                if self.delay:
                    time.sleep(self.delay)
                if callable(self.replies):
                    content = self.replies(body["messages"])
                else:
                    with self.lock:
                        content = self.replies.pop(0) if self.replies else ""
                if not isinstance(content, str):
                    content = json.dumps(content)
                return 200, {"choices": [{"message": {"role": "assistant", "content": content}}]}
            finally:
                with self.lock:
                    self.in_flight -= 1
        return 500, {"error": "unexpected"}


class StubAllm(_Stub):
    """AnythingLLM: per-workspace GETs, raw-text ingest, update-embeddings. 500 on anything else."""

    def __init__(self, workspaces: Optional[Dict[str, dict]] = None, documents: Optional[Dict[str, str]] = None, chats: Optional[Dict[str, list]] = None):
        super().__init__()
        self.workspaces = workspaces or {}
        self.documents = documents or {}
        self.chats = chats or {}
        self.ingested = 0
        self.fail_ingest = False
        # The ingest lands server-side (embedded in the workspace) but the client sees a failure,
        # as with a client-side timeout on a busy GPU.
        self.fail_after_land = False

    def handle(self, method, path, body, headers):
        route = path.split("?", 1)[0]
        if method == "GET" and route == "/api/ping":
            return 200, {"online": True}
        m = re.fullmatch(r"/api/v1/workspace/([a-z0-9-]+)", route)
        if method == "GET" and m:
            ws = self.workspaces.get(m.group(1))
            return (200, {"workspace": [ws]}) if ws is not None else (404, {"error": "not found"})
        m = re.fullmatch(r"/api/v1/workspace/([a-z0-9-]+)/chats", route)
        if method == "GET" and m:
            return 200, {"history": self.chats.get(m.group(1), [])}
        m = re.fullmatch(r"/api/v1/document/(.+)", route)
        if method == "GET" and m:
            from urllib.parse import unquote

            name = unquote(m.group(1))
            if name in self.documents:
                v = self.documents[name]
                return 200, {"document": {"name": name, **v} if isinstance(v, dict) else {"name": name, "pageContent": v}}
            return 404, {"error": "not found"}
        if method == "POST" and route == "/api/v1/document/raw-text":
            if self.fail_ingest:
                return 500, {"error": "ingest failed"}
            with self.lock:
                self.ingested += 1
                n = self.ingested
            loc = f"custom-documents/raw-scroll-{n}.json"
            ws = self.workspaces.get(str((body or {}).get("addToWorkspaces") or ""))
            if ws is not None:
                meta = (body or {}).get("metadata") or {}
                ws.setdefault("documents", []).append({"docpath": loc, "filename": loc.rsplit("/", 1)[-1], "metadata": json.dumps({"title": meta.get("title"), "docSource": meta.get("docSource")})})
            if self.fail_after_land:
                return 500, {"error": "client gave up"}
            return 200, {"success": True, "documents": [{"location": loc}]}
        m = re.fullmatch(r"/api/v1/workspace/([a-z0-9-]+)/update-embeddings", route)
        if method == "POST" and m:
            ws = self.workspaces.get(m.group(1))
            gone = set((body or {}).get("deletes") or [])
            if ws is not None and gone:
                ws["documents"] = [d for d in ws.get("documents") or [] if d.get("docpath") not in gone]
            return 200, {"workspace": {"slug": m.group(1)}}
        return 500, {"error": "unexpected"}


class StubGateway(_Stub):
    def __init__(self, active: bool = False, holder: str = ""):
        super().__init__()
        self.active = active
        self.holder = holder

    def handle(self, method, path, body, headers):
        if method == "GET" and path == "/api/os/gpu":
            return 200, {"busy": self.active, "holder": self.holder, "until": None, "at": 0, "active": self.active, "expiresAt": None}
        return 500, {"error": "unexpected"}


def user_text(messages: list) -> str:
    return next((m["content"] for m in messages if m.get("role") == "user"), "")


def auto_reply(messages: list) -> str:
    """A schema-valid distiller reply for whatever TARGET the prompt names.

    Durable lines from the BATCH (Locked..., prefers..., Scrolls live...) become bullets; the
    1234 -> 1235 move becomes a superseded fact. Mirrors what a good model would do.
    """
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from memory_scrolls import scroll as sc

    u = user_text(messages)
    target = re.search(r"^TARGET: (\S+)", u, re.M).group(1)
    t = sc.target_info(target)
    cur = re.search(r"<<<DATA CURRENT SCROLL\n(.*?)\n>>>", u, re.S).group(1)
    batch = re.search(r"<<<DATA BATCH\n(.*?)\n>>>", u, re.S).group(1)
    facts = []
    bullets = []
    for line in batch.split("\n"):
        for pat in (r"Locked: ([^\n]+)", r"(Nic prefers [^\n.]+)", r"(Scrolls live under [^\n]+)", r"(Concept: [^\n]+)"):
            m = re.search(pat, line)
            if m:
                b = f"- {m.group(1).strip()}"
                if b not in bullets:
                    bullets.append(b)
        if "moved from 1234 to 1235" in line:
            facts = [{"old": "LM Studio serves on port 1234", "new": "LM Studio serves on port 1235", "reason": "moved"}]
    heads = sc.headings_for(t)
    keep = {}
    for sec, lvl, line in sc._outline(cur):
        if lvl == 0 and sec and line.strip().startswith("- "):
            if sec == sc.SUPERSEDED or not any(f["old"].lower() in line.lower() for f in facts):
                keep.setdefault(sec, []).append(line.strip())
    parts = [f"# {t.title}", ""]
    for i, h in enumerate(heads):
        parts.append(f"## {h}")
        parts.append("")
        sec_bullets = list(keep.get(h, []))
        if i == 0:
            sec_bullets += [b for b in bullets if b not in sec_bullets]
            if facts:
                sec_bullets.append("- LM Studio serves on port 1235")
        parts.extend(sec_bullets)
        if sec_bullets:
            parts.append("")
    body = "\n".join(parts).rstrip() + "\n"
    ents = [{"name": "Whisper STT", "entityType": "service", "observations": ["port 8178"]}] if "8178" in batch else []
    return json.dumps({"target_scroll": target, "updated_markdown": body, "graph_entities_to_upsert": ents, "superseded_facts": facts})
