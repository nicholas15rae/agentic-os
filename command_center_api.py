"""
Command Center gateway API (mounted by server.py under /api/cc).

Everything here is local-first and standard-library only:

  * Shared store      SQLite collections (notes, reminders, finance, …). The
                      phone (PWA over NetBird / Wi-Fi) and the desktop read and
                      write the same rows, which is how they stay in sync.
  * Files             Scanned receipts / invoices / checks / scripts on disk.
  * Local LLM         OpenAI-compatible endpoint (LM Studio by default) for
                      OCR via a vision model, brainstorm organizing, JSON gen.
  * Vector vault      Local embeddings (a CPU-only llama-server on :1237, never
                      a GPU JIT load on LM Studio) + lexical fallback, so search
                      works even with no embedding model.
  * Market proxy      Candles for the Day Trading companion chart (no broker).
  * Backups           Scheduled + on-demand zip of the db, files and configs.

No bank / Plaid / broker connections exist or should be added here.
"""
from __future__ import annotations

import array
import base64
import bisect
import hashlib
import json
import math
import mimetypes
import os
import queue
import re
import shutil
import socket
import sqlite3
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

BASE_DIR = Path(__file__).parent.resolve()
# CC_DATA_DIR only exists so a scratch gateway (smoke tests) can run against its own store;
# the default is unchanged.
CC_DIR = Path(os.environ["CC_DATA_DIR"]).expanduser().resolve() if os.environ.get("CC_DATA_DIR") else BASE_DIR / "data" / "command-center"
FILES_DIR = CC_DIR / "files"
DB_PATH = CC_DIR / "cc.db"
CONFIG_PATH = CC_DIR / "config.json"

DEFAULT_LLM_BASE_URL = "http://127.0.0.1:1235/v1"  # LM Studio (Bionic) on this machine; :1234 is closed
# Vault embeddings go to a CPU-only llama-server (G:\ai-startup\start-ai-stack.ps1 step 1a) serving
# the nomic GGUF Bionic bundles: 0 VRAM. On Bionic the same request JIT-loads nomic onto the GPU
# (~300 MiB next to Tony's model, measured 2026-11-26).
DEFAULT_EMBED_BASE_URL = "http://127.0.0.1:1237/v1"
DEFAULT_EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5"


def _valid_http_url(u: str) -> bool:
    p = urllib.parse.urlparse(u or "")
    return p.scheme in ("http", "https") and bool(p.netloc)


def _default_llm_base(env: Optional[dict] = None) -> str:
    """`CC_LLM_BASE_URL` overrides the built-in default (a saved config.json still wins)."""
    v = ((env if env is not None else os.environ).get("CC_LLM_BASE_URL") or "").strip()
    return v if _valid_http_url(v) else DEFAULT_LLM_BASE_URL


def _default_embed_base(env: Optional[dict] = None) -> str:
    """`CC_EMBED_BASE_URL` overrides the CPU embedder's default (a saved config.json still wins)."""
    v = ((env if env is not None else os.environ).get("CC_EMBED_BASE_URL") or "").strip()
    return v if _valid_http_url(v) else DEFAULT_EMBED_BASE_URL


DEFAULT_CONFIG: dict[str, Any] = {
    # Zero-cost local LLM for OCR, organizing, widget generation and embeddings.
    "llm": {
        "baseUrl": _default_llm_base(),
        "model": "",  # empty = the model LM Studio already has loaded (never JIT-loads a second one)
        "visionModel": "",  # e.g. a Qwen2.5-VL / LLaVA build loaded in LM Studio
        "embeddingModel": DEFAULT_EMBED_MODEL,
        # The CPU embedder (0 VRAM). "" = embed on baseUrl as before (the rollback; that path can
        # JIT-load the embedding model onto the GPU next to Tony's).
        "embeddingBaseUrl": _default_embed_base(),
        "timeoutSecs": 120,
    },
    "backup": {
        "enabled": True,
        "intervalHours": 24,
        "keep": 14,
        "dir": str(BASE_DIR / "backups" / "command-center"),
    },
    # Gateway Tony (gateway_tony.py): while no desktop app works the inbox, the gateway answers a
    # phone turn as Tony on his own local model. false is the rollback switch: phone turns then wait
    # for the desktop exactly as before (read per decision, no restart needed).
    "gatewayTony": {
        "enabled": True,
    },
}

COLLECTIONS = {
    "notes",  # brainstorm sessions
    "reminders",  # alarms, countdowns, reminders (+ Google Calendar mirror)
    "pipeline",  # auditions, self-tapes, callbacks, bookings
    "projects",  # contracting: estimates, bids, follow-ups
    "income",  # revenue entries
    "goals",  # savings goals / structures
    "invoices",
    "checks",
    "receipts",  # scanned receipts with HST/GST breakdown
    "documents",  # misc scanned docs / scripts
    "widgets",  # generated custom widget definitions
    "ideas",  # Ideas & Tasks ledger (Tony → Prompter → Librarian)
    "playplace",  # staged prototypes from the Designer / Coder pipeline
    "cues",  # Voice & Triggers widgets (Gabagool Mode, startup welcome, timed cues)
    "routes",  # Maps saved routes (resolved coordinates). Deliberately NOT in VAULT_FIELDS: see PRIVATE_COLLECTIONS
}

# Finance records: never part of an unscoped vault search (agent context reads those).
FINANCE_COLLECTIONS = frozenset({"receipts", "invoices", "checks", "income"})

# Never embedded, never in any vault search (scoped or not), so home / job-site addresses stay out
# of the AI search index and agent context. They sync like any other collection.
PRIVATE_COLLECTIONS = frozenset({"routes"})

# Which fields get embedded into the vault, per collection.
VAULT_FIELDS: dict[str, list[str]] = {
    "notes": ["title", "rawText", "organized"],
    "receipts": ["vendor", "date", "category", "total", "hst", "gst", "notes", "ocrText"],
    "invoices": ["number", "client", "items", "notes", "total"],
    "checks": ["payer", "amount", "memo", "notes"],
    "pipeline": ["title", "role", "kind", "status", "casting", "notes", "script"],
    "projects": ["client", "job", "status", "notes", "estimate"],
    "documents": ["title", "notes", "ocrText"],
    "ideas": ["title", "idea", "summary", "tasks", "spec", "status"],
    "playplace": ["title", "idea", "brief", "blueprint", "buildPlan", "notes", "status"],
}
if PRIVATE_COLLECTIONS & VAULT_FIELDS.keys():
    raise RuntimeError("a private collection must never be embedded")

MAX_UPLOAD = 15 * 1024 * 1024
ALLOWED_UPLOAD = ("image/", "application/pdf", "audio/", "text/plain")

router = APIRouter(prefix="/api/cc", tags=["command-center"])
_db_lock = threading.Lock()


# ── config ───────────────────────────────────────────────────────────────────

def _why(e: BaseException, limit: int = 160) -> str:
    """Human-readable reason, never empty (some network errors stringify to '')."""
    msg = str(getattr(e, "reason", "") or e) or repr(e)
    return f"{type(e).__name__}: {msg}"[:limit]


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return _deep_merge(DEFAULT_CONFIG, json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    return json.loads(json.dumps(DEFAULT_CONFIG))


def save_config(cfg: dict) -> None:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# ── database ─────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """Commit on success, roll back on error, and always close (sqlite3's own
    context manager never closes, which leaks handles and locks files on Windows)."""
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with _db_lock, db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS items(
              id TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL,
              created REAL NOT NULL, updated REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS items_coll_upd ON items(collection, updated);
            CREATE TABLE IF NOT EXISTS files(
              id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, path TEXT, created REAL);
            CREATE TABLE IF NOT EXISTS vault(
              item_id TEXT PRIMARY KEY, collection TEXT, text TEXT, vector BLOB, model TEXT, updated REAL);
            CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT, updated REAL);
            """
        )


def _row(r: sqlite3.Row) -> dict:
    d = json.loads(r["data"])
    d.update(id=r["id"], _created=r["created"], _updated=r["updated"], _deleted=bool(r["deleted"]))
    return d


def _coll(name: str) -> str:
    if name not in COLLECTIONS:
        raise HTTPException(404, f"Unknown collection '{name}'")
    return name


def _clean(data: dict) -> dict:
    return {k: v for k, v in data.items() if not k.startswith("_") and k != "id"}


# ── saved routes (Maps): the stored shape is checked, so a bad pin never reaches a nav intent ──
# SavedRoute { name, origin: MapPlace | "here" | "home", destination: MapPlace, stops: MapPlace[],
# pinned? }. MapPlace { lat, lng, label }. Mirrors SavedRoute in command center/src/lib/cc-api.ts.
ROUTE_NAME_MAX = 80
ROUTE_LABEL_MAX = 200
ROUTE_STOPS_MAX = 9  # Google Maps directions URLs take at most 9 waypoints
ROUTE_ORIGINS = ("here", "home")  # resolved at use time: "here" to the device fix, "home" to MAP_HOME
_ROUTE_FIELDS = frozenset({"name", "origin", "destination", "stops", "pinned"})
_UNSAFE_TEXT = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]")


def _route_text(v: Any, what: str, cap: int, required: bool) -> str:
    if v is None and not required:
        return ""
    if not isinstance(v, str):
        raise HTTPException(400, f"{what} must be text")
    s = " ".join(_UNSAFE_TEXT.sub(" ", v).split())
    if required and not s:
        raise HTTPException(400, f"{what} is required")
    if len(s) > cap:
        raise HTTPException(400, f"{what} is longer than {cap} characters")
    return s


def _route_place(v: Any, what: str) -> dict:
    if not isinstance(v, dict):
        raise HTTPException(400, f"{what} must be a place {{lat, lng, label}}")
    extra = set(v) - {"lat", "lng", "label"}
    if extra:
        raise HTTPException(400, f"{what} has unknown fields: {', '.join(sorted(extra))}")
    out: dict = {}
    for k, lim in (("lat", 90.0), ("lng", 180.0)):
        n = v.get(k)
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or abs(n) > lim:
            raise HTTPException(400, f"{what}.{k} must be a number from -{lim:g} to {lim:g}")
        out[k] = float(n)
    out["label"] = _route_text(v.get("label"), f"{what}.label", ROUTE_LABEL_MAX, required=False)
    return out


def _check_route(body: dict) -> dict:
    """A whole SavedRoute (create, or the merged row on a PATCH), normalised; 400 when it isn't one."""
    extra = set(body) - _ROUTE_FIELDS
    if extra:
        raise HTTPException(400, f"Unknown saved-route fields: {', '.join(sorted(extra))}")
    origin = body.get("origin")
    if isinstance(origin, str):
        if origin not in ROUTE_ORIGINS:
            raise HTTPException(400, "origin must be a place, 'here' or 'home'")
    else:
        origin = _route_place(origin, "origin")
    stops = body.get("stops", [])
    if not isinstance(stops, list):
        raise HTTPException(400, "stops must be a list of places")
    if len(stops) > ROUTE_STOPS_MAX:
        raise HTTPException(400, f"At most {ROUTE_STOPS_MAX} stops")
    out = {
        "name": _route_text(body.get("name"), "name", ROUTE_NAME_MAX, required=True),
        "origin": origin,
        "destination": _route_place(body.get("destination"), "destination"),
        "stops": [_route_place(s, f"stops[{i}]") for i, s in enumerate(stops)],
    }
    if "pinned" in body:
        if not isinstance(body["pinned"], bool):
            raise HTTPException(400, "pinned must be true or false")
        out["pinned"] = body["pinned"]
    return out


# Per-collection shape checks, applied to the created body and to the merged row on a PATCH.
_VALIDATORS = {"routes": _check_route}


def _validated(collection: str, body: dict) -> dict:
    check = _VALIDATORS.get(collection)
    return check(body) if check else body


def kv_get(key: str, default: Any = None) -> Any:
    with db() as c:
        r = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(r["value"]) if r else default


def kv_set(key: str, value: Any) -> None:
    with _db_lock, db() as c:
        c.execute(
            "INSERT INTO kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated",
            (key, json.dumps(value), time.time()),
        )


# ── local LLM (OpenAI-compatible) ────────────────────────────────────────────

_models_cache: dict[str, tuple[float, list[str]]] = {}


def _http_json(url: str, payload: Optional[dict] = None, timeout: float = 30, headers: Optional[dict] = None) -> Any:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def llm_models() -> list[str]:
    base = load_config()["llm"]["baseUrl"].rstrip("/")
    hit = _models_cache.get(base)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    ids = [m.get("id", "") for m in _http_json(f"{base}/models", timeout=4).get("data", [])]
    _models_cache[base] = (time.time(), ids)
    return ids


_loaded_cache: dict[str, tuple[float, list[dict]]] = {}


def llm_loaded_models() -> list[dict]:
    """LM Studio's own model list (`/api/v0/models`, which carries `state` and `type`), filtered
    to the models that are loaded right now. [] when the server isn't LM Studio or is down."""
    base = load_config()["llm"]["baseUrl"].rstrip("/")
    hit = _loaded_cache.get(base)
    if hit and time.time() - hit[0] < 15:
        return hit[1]
    root = base[: -len("/v1")] if base.endswith("/v1") else base
    try:
        data = _http_json(f"{root}/api/v0/models", timeout=4).get("data", [])
        loaded = [m for m in data if isinstance(m, dict) and m.get("state") == "loaded" and m.get("id")]
    except Exception:
        loaded = []
    _loaded_cache[base] = (time.time(), loaded)
    return loaded


def _pick_model(preferred: str, want: str = "chat") -> str:
    """An explicit model wins. Otherwise prefer what LM Studio already has loaded, so a gateway
    call never JIT-loads a second large model next to the desktop's; only when nothing usable is
    loaded (or the server has no /api/v0) fall back to the first listed model."""
    if preferred:
        return preferred
    loaded = llm_loaded_models()
    if want == "embed":
        emb = [m["id"] for m in loaded if m.get("type") == "embeddings" or "embed" in m["id"].lower()]
        if emb:
            return emb[0]
    else:
        chat = [m["id"] for m in loaded if m.get("type") != "embeddings" and "embed" not in m["id"].lower()]
        if chat:
            return chat[0]
    models = llm_models()
    if want == "embed":
        emb = [m for m in models if "embed" in m.lower()]
        if emb:
            return emb[0]
    chat = [m for m in models if "embed" not in m.lower()]
    if not chat:
        raise RuntimeError("No model loaded in the local LLM server")
    return chat[0]


# ── cooperative GPU lease (the desktop's GpuSlot mirrors itself here) ───────
#
# The desktop app owns the only real GPU arbiter. While it holds the baton it PUTs
# /api/os/gpu {busy:true, holder, until}; the gateway's own LM Studio calls then back off:
# /llm/json answers 503 at once (its caller has a deterministic fallback), the embedding
# thread defers, and every other llm_chat waits up to 30 s before going ahead anyway.
# A flag without `until` goes stale 30 s after it was set; `until` is honoured for at most
# 15 minutes, so a crashed desktop can never wedge the gateway.
#
# Maintenance window: a holder starting "maintenance" (the desktop's GpuSlot label for a model
# unload / reload / bench / A-B compare; the Model Lab compare re-sends it every 30 s) means the
# loaded model is being swapped or tested, so it is nobody's to use: llm_chat never goes ahead
# during one (GpuMaintenance), and gateway Tony answers with his "testing a model" line.

GPU_STALE_SECS = 30.0
GPU_MAX_HOLD_SECS = 900.0
GPU_MAINTENANCE_PREFIX = "maintenance"
_gpu_lock = threading.Lock()
_gpu: dict[str, Any] = {"busy": False, "holder": "", "until": None, "at": 0.0}


def _epoch(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f / 1000.0 if f > 1e11 else f  # ms or s


def gpu_set(busy: bool, holder: str = "", until: Any = None, now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    with _gpu_lock:
        _gpu.update(busy=bool(busy), holder=str(holder or "")[:60], until=_epoch(until) if busy else None, at=now)
        return dict(_gpu)


def gpu_expires_at(state: Optional[dict] = None) -> float:
    s = state if state is not None else _gpu
    at = float(s.get("at") or 0.0)
    until = s.get("until")
    if until is None:
        return at + GPU_STALE_SECS
    return max(at, min(float(until), at + GPU_MAX_HOLD_SECS))


def gpu_busy(now: Optional[float] = None) -> bool:
    now = time.time() if now is None else now
    with _gpu_lock:
        return bool(_gpu["busy"]) and now < gpu_expires_at(_gpu)


def _is_maintenance(holder: Any) -> bool:
    return str(holder or "").strip().lower().startswith(GPU_MAINTENANCE_PREFIX)


def gpu_maintenance(now: Optional[float] = None) -> bool:
    """The desktop holds the GPU for model maintenance (a live lease whose holder starts
    "maintenance"): whatever is loaded now may be a model under test, not Tony's."""
    now = time.time() if now is None else now
    with _gpu_lock:
        return bool(_gpu["busy"]) and now < gpu_expires_at(_gpu) and _is_maintenance(_gpu["holder"])


def gpu_state(now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    with _gpu_lock:
        s = dict(_gpu)
    active = bool(s["busy"]) and now < gpu_expires_at(s)
    return {**s, "active": active, "maintenance": active and _is_maintenance(s["holder"]), "expiresAt": gpu_expires_at(s) if s["busy"] else None}


class GpuMaintenance(RuntimeError):
    """llm_chat during a maintenance window: the caller skips (or answers 503) instead of running
    on a model that is being swapped or tested."""


def wait_gpu(max_wait: Optional[float], poll: float = 0.5) -> bool:
    """Block while the desktop holds the GPU: True once free, False if `max_wait` ran out
    (None = until the lease ends, which GPU_MAX_HOLD_SECS always bounds)."""
    deadline = None if max_wait is None else time.time() + max_wait
    while gpu_busy():
        if deadline is not None and time.time() >= deadline:
            return False
        time.sleep(poll)
    return True


def is_loopback_request(request: Any) -> bool:
    """Same rule as server.ZeroTrustMiddleware's trusted path: a loopback peer that did not
    come through a tunnel (forwarding headers mean the public internet)."""
    client = getattr(request, "client", None)
    host = (client.host if client else "") or ""
    loopback = host in ("127.0.0.1", "::1", "localhost") or host.startswith("127.")
    headers = getattr(request, "headers", None) or {}
    proxied = any(h in headers for h in ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"))
    return loopback and not proxied


def require_loopback(request: Any) -> None:
    if not is_loopback_request(request):
        raise HTTPException(403, "Only the desktop app on this machine may call this endpoint.")


def llm_chat(messages: list[dict], *, model: str = "", max_tokens: int = 1200, temperature: float = 0.2, gpu_wait: Optional[float] = GPU_STALE_SECS, think: bool = False) -> str:
    """One non-streaming chat completion. Reasoning is off unless `think=True`: a thinking model
    (Qwen3.5) otherwise spends 13-90 s and most of the token budget on hidden reasoning. Both flags
    are sent: this server honours only "reasoning_effort": "none"; others read enable_thinking.
    Never during a maintenance window (whatever gpu_wait says): GpuMaintenance instead."""
    if gpu_wait:
        wait_gpu(gpu_wait)  # cooperative: let the desktop's generation finish first, then go ahead anyway
    if gpu_maintenance():
        raise GpuMaintenance("the desktop is testing or swapping models on the GPU; try again in a few minutes")
    cfg = load_config()["llm"]
    body = _chat_body(messages, _pick_model(model or cfg["model"]), max_tokens=max_tokens, temperature=temperature, think=think, stream=False)
    out = _http_json(f"{cfg['baseUrl'].rstrip('/')}/chat/completions", body, timeout=cfg.get("timeoutSecs", 120))
    return out["choices"][0]["message"]["content"] or ""


def _chat_body(messages: list[dict], model: str, *, max_tokens: int, temperature: Optional[float], think: bool, stream: bool) -> dict[str, Any]:
    """The /chat/completions body llm_chat and llm_stream share, so the thinking-off flags live in one
    place. `temperature` None leaves the server's per-model default (what the desktop's Tony uses)."""
    body: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": stream}
    if temperature is not None:
        body["temperature"] = temperature
    if not think:
        body["reasoning_effort"] = "none"
        body["chat_template_kwargs"] = {"enable_thinking": False}
    return body


def _timed_lines(resp: Any, read_timeout: float, deadline: Any) -> Iterator[bytes]:
    """The response's lines, every read bounded by the wall clock: before each read the socket
    timeout is cut to what is left before `deadline()` (a time.monotonic() value), and TimeoutError
    once it has passed, so a server that goes silent mid-answer can't hold a read past it. `read1`
    makes each wait a single socket read. Plain iteration when http.client's socket isn't there."""
    sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
    read1 = getattr(resp, "read1", None)
    if sock is None or read1 is None:
        yield from resp
        return
    buf = b""
    while True:
        i = buf.find(b"\n")
        if i >= 0:
            line, buf = buf[: i + 1], buf[i + 1:]
            yield line
            continue
        left = deadline() - time.monotonic()
        if left <= 0:
            raise TimeoutError("timed out")
        sock.settimeout(max(0.01, min(read_timeout, left)))
        chunk = read1(65536)
        if not chunk:
            if buf:
                yield buf
            return
        buf += chunk


def llm_stream(messages: list[dict], *, model: str, base_url: str = "", max_tokens: int = 400, temperature: Optional[float] = None,
               first_token_s: float = 20.0, total_s: float = 60.0, on_delta: Optional[Any] = None, think: bool = False) -> str:
    """One streamed chat completion (server-sent events) from an OpenAI-compatible server; returns
    the whole content. Same body as llm_chat (thinking off unless `think`), stream on.

    `model` is required: a stream never picks a model itself (so it can never answer on, or JIT-load,
    whatever else the server has). `base_url` defaults to config llm.baseUrl. `on_delta(piece)` gets
    each content piece as it arrives; an exception it raises ends the request (the connection closes,
    so the server stops generating). No GPU-lease wait: the caller decides. Raises TimeoutError when
    no content arrived within `first_token_s` or the answer ran past `total_s` (wall clock from the
    request, even while the server is silent mid-answer), RuntimeError on an error event, and
    urllib's errors for HTTP / connection failures."""
    if not model:
        raise ValueError("llm_stream needs an explicit model")
    base = (base_url or load_config()["llm"]["baseUrl"]).rstrip("/")
    body = _chat_body(messages, model, max_tokens=max_tokens, temperature=temperature, think=think, stream=True)
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")
    started = time.monotonic()
    got_first = False
    pieces: list[str] = []

    def deadline() -> float:  # no content yet: the first-token limit too
        return started + (total_s if got_first else min(first_token_s, total_s))

    # The socket timeout bounds each read (a server that goes silent), cut to the time left on the
    # wall clock (_timed_lines); the elapsed checks catch a server that keeps sending other lines.
    read_timeout = max(0.5, min(first_token_s, total_s))
    with urllib.request.urlopen(req, timeout=read_timeout) as resp:
        try:
            for raw in _timed_lines(resp, read_timeout, deadline):
                elapsed = time.monotonic() - started
                if not got_first and elapsed > first_token_s:
                    raise TimeoutError(f"no answer within {first_token_s:.0f} s")
                if elapsed > total_s:
                    raise TimeoutError(f"answer ran past {total_s:.0f} s")
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    ev = json.loads(data)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if ev.get("error"):
                    raise RuntimeError(f"model server error: {str(ev['error'])[:160]}")
                choices = ev.get("choices") or []
                first = choices[0] if choices and isinstance(choices[0], dict) else {}
                delta = first.get("delta") if isinstance(first.get("delta"), dict) else {}
                piece = delta.get("content")
                if isinstance(piece, str) and piece:
                    got_first = True
                    pieces.append(piece)
                    if on_delta is not None:
                        on_delta(piece)
        except TimeoutError as e:
            if str(e) != "timed out":
                raise
            # A read the socket timeout (or the time left) cut: say which limit it was.
            limit = f"no answer within {first_token_s:.0f} s" if not got_first else f"answer ran past {total_s:.0f} s"
            raise TimeoutError(limit) from None
    return "".join(pieces)


_SMART_QUOTES = {"“": '"', "”": '"', "‘": "'", "’": "'"}
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
_FENCED_JSON_RE = re.compile(r"```json\s*(.*?)```", re.S | re.I)
_TOOL_CALL_TAG_RE = re.compile(r"</?tool_call>", re.I)


def _strip_think_loose(text: str) -> str:
    """Remove every closed <think>...</think>; drop an unclosed one (and
    everything after it) — a never-finished scratchpad has no usable JSON
    trailing it."""
    text = text or ""
    while True:
        a, b = text.find("<think>"), text.find("</think>")
        if a >= 0 and b > a:
            text = text[:a] + text[b + len("</think>") :]
            continue
        if a >= 0 and b < 0:
            text = text[:a]
        break
    return text.strip()


def _balanced_spans(text: str) -> list[tuple[int, int]]:
    """Every outermost `{...}` span, skipping braces inside quoted strings."""
    spans: list[tuple[int, int]] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] == "{":
            depth, in_str, escape, j, end = 0, False, False, i, None
            while j < n:
                c = text[j]
                if in_str:
                    if escape:
                        escape = False
                    elif c == "\\":
                        escape = True
                    elif c == '"':
                        in_str = False
                else:
                    if c == '"':
                        in_str = True
                    elif c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                        if depth == 0:
                            end = j
                            break
                j += 1
            if end is not None:
                spans.append((i, end))
                i = end + 1
                continue
        i += 1
    return spans


def _light_repair(s: str) -> str:
    for bad, good in _SMART_QUOTES.items():
        s = s.replace(bad, good)
    return _TRAILING_COMMA_RE.sub(r"\1", s)


def _normalize_tool_shape(v: dict) -> dict:
    if "tool" not in v and isinstance(v.get("name"), str) and "arguments" in v:
        v = {**v, "tool": v["name"], "args": v["arguments"]}
    return v


def extract_json(text: str) -> Optional[dict]:
    """Model-agnostic JSON / tool-call extraction (Part 6 §3) — mirrors
    `extract_json` in the Tauri app's `dispatch.rs` and TS `extract-json.ts`.
    Survives a reasoning scratchpad next to the JSON, a ```json fence, more
    than one `{...}` span, trailing commas / smart quotes, and either
    `{"tool","args"}` or the OpenAI-style `{"name","arguments"}` shape."""
    cleaned = _strip_think_loose(text)
    candidates: list[str] = []
    fenced = _FENCED_JSON_RE.search(cleaned)
    if fenced:
        candidates.append(fenced.group(1).strip())
    without_tool_tags = _TOOL_CALL_TAG_RE.sub("", cleaned)
    for a, b in _balanced_spans(without_tool_tags):
        candidates.append(without_tool_tags[a : b + 1])
    for c in candidates:
        for attempt in (c, _light_repair(c)):
            try:
                v = json.loads(attempt)
            except json.JSONDecodeError:
                continue
            if isinstance(v, dict):
                return _normalize_tool_shape(v)
    return None


# ── vault embeddings on the CPU embedder (:1237) ────────────────────────────
#
# Down: a refused localhost connect blocks ~2 s on Windows (the stack retries the SYN), so every
# call first connects with a short timeout (EMBED_CONNECT_SECS on loopback, where a live server
# accepts in well under a millisecond), and a down embedder is remembered: EMBED_DOWN_SECS after the
# first failed probe, doubling while it stays down up to EMBED_DOWN_MAX_SECS. A good probe, or a
# config change (put_config clears the cache), starts the back-off over.
# The back-off spares the query path only. The indexer thread does the watching: its calls connect
# first even inside the back-off (and probe at once when the embedder answers), and while it is
# idle it re-checks a down embedder every EMBED_WATCH_SECS. So the embedder is used again within
# seconds of coming back, never only after the back-off. A row the indexer could not embed because
# the embedder was down waits in memory and is retried, instead of keeping vector NULL until a
# reindex (only rows past INDEX_WAIT_MAX, or waiting through a gateway restart, still need one).
EMBED_DOWN_SECS = 30.0
EMBED_DOWN_MAX_SECS = 300.0
EMBED_UP_SECS = 60.0
EMBED_CONNECT_SECS = 0.3          # an embedder on this machine
EMBED_CONNECT_REMOTE_SECS = 2.0   # one on another host
EMBED_WATCH_SECS = 15.0           # the idle indexer's re-check / retry interval
INDEX_WAIT_MAX = 10000            # rows kept for a retry while the embedder is down
INDEX_FAIL_PAUSE_SECS = 2.0       # the indexer's pause after a failed row
_embedder_cache: dict[str, tuple[float, Optional[list[str]]]] = {}
_embedder_fails: dict[str, int] = {}  # failed probes in a row, per base (the back-off)
# llama-server's answer to an input longer than its batch (Bionic truncates such inputs itself).
_EMBED_TOO_LARGE = re.compile(r"input \((\d+) tokens\) is too large.*?batch size: (\d+)", re.S)
# Too long: the start is kept, cut by the embedder's own token count (/tokenize) to
# EMBED_TOKEN_MARGIN under its batch; the last resort, _hard_cut, needs no tokenizer and keeps
# EMBED_HARD_MARGIN for special / prefix tokens. A cut costs at most EMBED_FIT_PROBES counts.
EMBED_TOKEN_MARGIN = 4
EMBED_HARD_MARGIN = 16
EMBED_FIT_PROBES = 16
# Busy: the embedder has one slot, and a 2k-token note takes ~2.2 s on the CPU (a query ~30 ms).
# So the indexer embeds a text in pieces of EMBED_CHUNK_TOKENS (~0.4 s each; the row's vector is
# their length-weighted mean) and, before each piece, waits while a query runs and for
# EMBED_QUERY_GRACE_SECS after one (EMBED_BG_MAX_DEFER_SECS at most). A search then waits behind
# one piece at most, never a whole note.
EMBED_CHUNK_TOKENS = 512
EMBED_QUERY_GRACE_SECS = 2.0
EMBED_BG_MAX_DEFER_SECS = 30.0


def _down_ttl(base: str) -> float:
    fails = min(max(1, _embedder_fails.get(base, 1)), 16)
    return min(EMBED_DOWN_MAX_SECS, EMBED_DOWN_SECS * 2 ** (fails - 1))


def _mark_embedder(base: str, ids: Optional[list[str]]) -> None:
    """Remember what a probe (or a failed request) found: up ends the back-off, down grows it."""
    if ids is None:
        _embedder_fails[base] = min(_embedder_fails.get(base, 0) + 1, 16)
    else:
        _embedder_fails.pop(base, None)
    _embedder_cache[base] = (time.time(), ids)


def _connect_ok(base: str) -> bool:
    """A TCP connect to `base` within EMBED_CONNECT_SECS (loopback) or EMBED_CONNECT_REMOTE_SECS:
    a closed loopback port answers this in 0.3 s instead of a request's ~2 s refused connect."""
    u = urllib.parse.urlsplit(base)
    host = u.hostname or ""
    try:
        port = u.port or (443 if u.scheme == "https" else 80)
    except ValueError:
        return False
    loopback = host in ("localhost", "::1") or host.startswith("127.")
    try:
        with socket.create_connection((host, port), timeout=EMBED_CONNECT_SECS if loopback else EMBED_CONNECT_REMOTE_SECS):
            return True
    except OSError:
        return False


class EmbedderDown(RuntimeError):
    """embed() found no embedder to use: the CPU one is down and LM Studio does not have the model
    loaded (it is never JIT-loaded). The indexer keeps such a row for a retry."""


def _embedder_models(base: str, recheck: bool = False) -> Optional[list[str]]:
    """The model ids the CPU embedder at `base` serves (GET /models), or None while it is down
    (an embedder that lists no model counts as down too). `recheck` is the indexer thread: inside a
    down back-off it still connects (EMBED_CONNECT_SECS) and probes at once if the embedder answers,
    so a row written just after the embedder came back embeds. The query path keeps the cached
    answer and pays nothing inside the back-off."""
    now = time.time()
    hit = _embedder_cache.get(base)
    if hit is None:
        _embedder_fails.pop(base, None)  # a cleared cache (a config change) starts the back-off over
    elif now - hit[0] < (EMBED_UP_SECS if hit[1] is not None else _down_ttl(base)):
        if hit[1] is not None or not recheck or not _connect_ok(base):
            return hit[1]  # (a failed re-check connect is not a probe: the back-off does not grow)
    ids: Optional[list[str]] = None
    if _connect_ok(base):
        try:
            ids = [m.get("id", "") for m in _http_json(f"{base}/models", timeout=4).get("data", [])] or None
        except Exception:
            ids = None
    _mark_embedder(base, ids)
    return ids


def _embed_at(base: str, model: str, texts: list[str]) -> list[list[float]]:
    out = _http_json(f"{base}/embeddings", {"model": model, "input": texts}, timeout=60)
    return [d["embedding"] for d in sorted(out["data"], key=lambda d: d.get("index", 0))]


def _token_counter(base: str) -> Any:
    """count(text) -> the embedder's token count for `text` as /embeddings counts it (special tokens
    included), from llama-server's /tokenize, which sits at the root, not under /v1. Raises when
    that route is missing or the embedder is down."""
    url = f"{base[:-3] if base.endswith('/v1') else base}/tokenize"

    def count(text: str) -> int:
        toks = _http_json(url, {"content": text, "add_special": True}, timeout=10).get("tokens")
        if not isinstance(toks, list):
            raise ValueError("no token list from /tokenize")
        return len(toks)

    return count


def _hard_cost(c: str) -> int:
    """At least as many tokens as one character can become in any llama.cpp tokenizer: its UTF-8
    bytes (byte-level BPE, SPM byte fallback: one token per byte at most), or those of its
    compatibility decomposition when longer (WordPiece splits accents off before matching)."""
    return max(len(c.encode("utf-8", "surrogatepass")), len(unicodedata.normalize("NFKD", c).encode("utf-8", "surrogatepass")))


def _hard_cut(text: str, budget: int) -> str:
    """The longest start of `text` that is sure to be at most `budget` tokens (_hard_cost) with no
    tokenizer to ask: the last resort that always fits. ASCII keeps one character per token; a
    CJK block keeps a third of that."""
    total, budget = 0, max(1, budget)
    for i, c in enumerate(text):
        total += _hard_cost(c)
        if total > budget:
            return text[:i]
    return text


def _fit_prefix(count: Any, text: str, target: int, slack: float = 0.05) -> tuple[int, int]:
    """(length, tokens) of a start of `text` that is at most `target` tokens by `count`: all of it
    when it fits. Otherwise the probes alternate between interpolating on the token density seen so
    far and halving, so a token-dense start (a base64 or CJK block before prose) costs a probe or
    two more, never a failed embed. Stops within `slack` of the target, or after EMBED_FIT_PROBES
    counts; (0, 0) when no probed start fits."""
    n = count(text)
    if n <= target:
        return len(text), n
    lo, lo_n, hi, hi_n = 0, 0, len(text), n
    good = target - max(1, int(target * slack))
    for i in range(EMBED_FIT_PROBES):
        if hi - lo <= 1:
            break
        if i % 2 == 0:
            k = lo + int((hi - lo) * (target - lo_n) / max(hi_n - lo_n, 1) * 0.95)
        else:
            k = (lo + hi) // 2
        k = min(max(k, lo + 1), hi - 1)
        kn = count(text[:k])
        if kn <= target:
            lo, lo_n = k, kn
            if kn >= good:
                break
        else:
            hi, hi_n = k, kn
    return lo, lo_n


def _fit_start(base: str, text: str, cap: int) -> str:
    """The start of `text` that fits a `cap`-token batch by the embedder's own count (near the
    longest); _hard_cut's when /tokenize is not there or finds nothing."""
    try:
        k, _ = _fit_prefix(_token_counter(base), text, cap - EMBED_TOKEN_MARGIN)
    except Exception:
        k = 0
    return text[:k] if k else _hard_cut(text, cap - EMBED_HARD_MARGIN)


def _embed_fit(base: str, model: str, texts: list[str]) -> list[list[float]]:
    """_embed_at on llama-server, which refuses an input longer than its batch (Bionic truncates such
    inputs itself). A too-long text keeps its start, as Bionic's truncation does: cut by the
    embedder's own token count (/tokenize), then, should that still not fit, by the hard cut that
    always does. So every text embeds, however dense its tokens."""
    for attempt in range(3):
        try:
            return _embed_at(base, model, texts)
        except urllib.error.HTTPError as e:
            try:
                why = e.read().decode("utf-8", "replace")
            except Exception:
                why = ""
            m = _EMBED_TOO_LARGE.search(why)
            if not m or attempt == 2:
                raise
            cap = int(m.group(2))
            if attempt == 0:
                texts = [_fit_start(base, t, cap) for t in texts]
            else:
                texts = [_hard_cut(t, cap - EMBED_HARD_MARGIN) for t in texts]
    raise RuntimeError("unreachable")


class _EmbedGate:
    """Queries first on the one-slot CPU embedder. A query never waits here; a background
    (indexing) piece waits while a query is running and for EMBED_QUERY_GRACE_SECS after the last
    one, so a turn's searches run back to back instead of each queuing behind a note."""

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._running = 0
        self._last = float("-inf")  # time.monotonic() when the last query finished

    @contextmanager
    def query(self) -> Iterator[None]:
        with self._cv:
            self._running += 1
        try:
            yield
        finally:
            with self._cv:
                self._running -= 1
                self._last = time.monotonic()
                self._cv.notify_all()

    def wait_background(self) -> bool:
        """Block a background piece until no query is running or recent: True. False = it waited
        EMBED_BG_MAX_DEFER_SECS and goes ahead anyway, so indexing never starves."""
        deadline = time.monotonic() + EMBED_BG_MAX_DEFER_SECS
        with self._cv:
            while True:
                now = time.monotonic()
                quiet_at = self._last + EMBED_QUERY_GRACE_SECS
                if not self._running and now >= quiet_at:
                    return True
                if now >= deadline:
                    return False
                self._cv.wait(max(0.005, (deadline if self._running else min(deadline, quiet_at)) - now))


_embed_gate = _EmbedGate()


def _split_tokens(base: str, text: str, size: int) -> list[str]:
    """`text` as consecutive pieces of at most `size` tokens by the embedder's own count, each cut
    after a space where one is near. A piece _hard_cut vouches for needs no count, and without
    /tokenize every piece is cut that way."""
    count: Any = _token_counter(base)
    pieces: list[str] = []
    rest = text
    while rest:
        k = len(_hard_cut(rest, size - EMBED_HARD_MARGIN))
        if k < len(rest) and count is not None:
            try:
                k = max(k, _fit_prefix(count, rest[: size * 8], size, slack=0.2)[0])
            except Exception:
                count = None  # no /tokenize: hard cuts from here on
        if k < len(rest):
            sp = max(rest.rfind(c, k - k // 8, k) for c in " \n\t")
            if sp > 0:
                k = sp + 1
        k = max(1, k)
        pieces.append(rest[:k])
        rest = rest[k:]
    return pieces


def _mean_vector(vecs: list[list[float]], weights: list[int]) -> list[float]:
    """The weighted mean of the pieces' vectors at unit length (llama-server's own are), so a long
    text's vector stands for all of it."""
    out = [0.0] * len(vecs[0])
    for v, w in zip(vecs, weights):
        for i, x in enumerate(v):
            out[i] += w * x
    norm = math.sqrt(sum(x * x for x in out)) or 1.0
    return [x / norm for x in out]


def _embed_background(base: str, model: str, text: str) -> list[float]:
    """One indexer text on the CPU embedder: in pieces (_split_tokens), each behind any query
    (_EmbedGate). A text of one piece gets the same vector as a query-path embed of it."""
    pieces = _split_tokens(base, text, EMBED_CHUNK_TOKENS) or [text]
    vecs: list[list[float]] = []
    for p in pieces:
        _embed_gate.wait_background()
        vecs.extend(_embed_fit(base, model, [p]))
    return vecs[0] if len(vecs) == 1 else _mean_vector(vecs, [len(p) for p in pieces])


def embed(texts: list[str], background: bool = False) -> tuple[list[list[float]], str]:
    """Vault embeddings. They go to the CPU embedder (`llm.embeddingBaseUrl`) when it serves the
    configured model. While it is down, LM Studio is used only if that model is ALREADY loaded
    there: an embedding request never JIT-loads a model onto the GPU next to Tony's (with "unload
    previous JIT model" on, a JIT load could also swap out a JIT-loaded Tony). Otherwise this
    raises and the vault stays lexical. An empty `embeddingBaseUrl` is the old path (LM Studio),
    and so is a configured model the CPU embedder does not serve (Nic picked an LM Studio one).
    `background` is the indexer: on the CPU embedder its texts go in pieces, behind any query, and a
    remembered "down" is re-checked with a short connect (_embedder_models `recheck`). Raises
    EmbedderDown when there is no embedder to use."""
    cfg = load_config()["llm"]
    llm_base = cfg["baseUrl"].rstrip("/")
    cpu_base = (cfg.get("embeddingBaseUrl") or "").strip().rstrip("/")
    if cpu_base and cpu_base != llm_base:
        served = _embedder_models(cpu_base, recheck=background)
        model = cfg.get("embeddingModel") or (served[0] if served else DEFAULT_EMBED_MODEL)
        if served is not None and model in served and not _connect_ok(cpu_base):
            _mark_embedder(cpu_base, None)  # it went down since the last /models check
            served = None
        if served is not None and model in served:
            try:
                if background:
                    return [_embed_background(cpu_base, model, t) for t in texts], model
                with _embed_gate.query():
                    return _embed_fit(cpu_base, model, texts), model
            except urllib.error.HTTPError:
                raise
            except OSError:  # it went down mid-request
                _mark_embedder(cpu_base, None)
                served = None
        if served is None:
            if any(m.get("id") == model for m in llm_loaded_models()):
                return _embed_at(llm_base, model, texts), model
            raise EmbedderDown(f"CPU embedder {cpu_base} is down and {model} is not loaded in LM Studio (no GPU JIT load)")
    model = _pick_model(cfg.get("embeddingModel", ""), "embed")
    return _embed_at(llm_base, model, texts), model


def _watch_embedder() -> None:
    """The idle indexer's check: while the configured CPU embedder is remembered as down, a short
    connect (and a /models probe only if it answers), so vault searches use it again within
    EMBED_WATCH_SECS of it coming back instead of after the back-off. Off the query path."""
    try:
        cfg = load_config()["llm"]
        base = (cfg.get("embeddingBaseUrl") or "").strip().rstrip("/")
        hit = _embedder_cache.get(base)
        if base and base != cfg["baseUrl"].rstrip("/") and hit is not None and hit[1] is None:
            _embedder_models(base, recheck=True)
    except Exception:
        pass


# ── vector vault ─────────────────────────────────────────────────────────────

_index_q: "queue.Queue[str]" = queue.Queue()
_TOKEN = re.compile(r"[a-z0-9$#.\-]{2,}")


def _vault_text(collection: str, data: dict) -> str:
    parts = []
    for f in VAULT_FIELDS.get(collection, []):
        v = data.get(f)
        if v in (None, "", [], {}):
            continue
        parts.append(f"{f}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}")
    return "\n".join(parts)[:6000]


def _upsert_vault_text(item_id: str, collection: str, data: dict, deleted: bool) -> None:
    if collection not in VAULT_FIELDS:
        return
    with _db_lock, db() as c:
        if deleted:
            c.execute("DELETE FROM vault WHERE item_id=?", (item_id,))
            return
        text = _vault_text(collection, data)
        c.execute(
            "INSERT INTO vault(item_id,collection,text,vector,model,updated) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(item_id) DO UPDATE SET text=excluded.text, vector=NULL, model=NULL, updated=excluded.updated",
            (item_id, collection, text, None, None, time.time()),
        )
    _index_q.put(item_id)


def _index_one(item_id: str) -> bool:
    """Embed one vault row and store its vector: True, or False when there is nothing to embed
    (the row is gone or empty). Raises when the embed fails."""
    with db() as c:
        r = c.execute("SELECT text FROM vault WHERE item_id=?", (item_id,)).fetchone()
    if not r or not r["text"]:
        return False
    wait_gpu(None, poll=2.0)  # defer while the desktop holds the GPU (the lease is bounded)
    (vec,), model = embed([r["text"]], background=True)  # in pieces, behind any vault search
    blob = array.array("f", vec).tobytes()
    with _db_lock, db() as c:
        c.execute("UPDATE vault SET vector=?, model=? WHERE item_id=?", (blob, model, item_id))
    return True


def _index_step(item_id: str, waiting: dict[str, None], q: "queue.Queue[str]") -> str:
    """One indexer step: "done" (embedded), "skip" (nothing to embed), "waiting" (no embedder
    could take it, EmbedderDown or a connection error: the row goes to the back of `waiting` for a
    retry instead of being dropped) or "failed" (the embedder answered with an error: dropped, as
    before, until a reindex). Once a row embeds, every waiting row goes back on `q`."""
    try:
        done = _index_one(item_id)
    except urllib.error.HTTPError:  # an answer from the server (a URLError / OSError subclass), not an outage
        waiting.pop(item_id, None)
        return "failed"
    except (EmbedderDown, OSError):
        known = item_id in waiting
        waiting.pop(item_id, None)
        if known or len(waiting) < INDEX_WAIT_MAX:
            waiting[item_id] = None  # to the back: the next retry tries another row
        return "waiting"
    except Exception:
        waiting.pop(item_id, None)
        return "failed"
    waiting.pop(item_id, None)
    if done and waiting:
        for i in list(waiting):
            q.put(i)
        waiting.clear()
    return "done" if done else "skip"


def _index_worker(q: "Optional[queue.Queue[str]]" = None, stop: Optional[threading.Event] = None) -> None:
    """Embeds vault rows in the background; a missing embedding model just leaves lexical search.
    A row that found the embedder down waits instead of being dropped: after EMBED_WATCH_SECS
    without new rows, the oldest waiting row is tried again (its embed re-checks the embedder with
    a short connect), and once one embeds the others follow. With nothing waiting, the quiet
    interval is _watch_embedder's. `q` / `stop` exist for tests (the default is the vault queue,
    forever)."""
    q = _index_q if q is None else q
    waiting: dict[str, None] = {}  # insertion order: the next retry is the front
    while stop is None or not stop.is_set():
        try:
            item_id = q.get(timeout=EMBED_WATCH_SECS)
        except queue.Empty:
            if not waiting:
                _watch_embedder()
                continue
            item_id = next(iter(waiting))
        try:
            status = _index_step(item_id, waiting, q)
        except Exception:
            status = "failed"
        if status in ("waiting", "failed"):
            time.sleep(INDEX_FAIL_PAUSE_SECS)


def _cosine(a: array.array, b: array.array) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def vault_search(q: str, collections: Optional[list[str]] = None, k: int = 8, include_finance: bool = False) -> dict:
    """Search the vault. With no `collections`, finance records are left out unless
    `include_finance` is set: only Nic's own screens ask for them (the Vault page's
    unfiltered search, the Finance tables naming their collection). Agent context
    (the Librarian's vault matches) never gets receipts, invoices, cheques or income."""
    with db() as c:
        rows = c.execute("SELECT item_id, collection, text, vector FROM vault").fetchall()
    rows = [r for r in rows if r["collection"] not in PRIVATE_COLLECTIONS]  # even when asked for by name
    if collections:
        rows = [r for r in rows if r["collection"] in collections]
    elif not include_finance:
        rows = [r for r in rows if r["collection"] not in FINANCE_COLLECTIONS]
    if not rows:
        return {"results": [], "mode": "empty"}

    # Lexical (BM25-lite) — always available.
    q_terms = _TOKEN.findall(q.lower())
    docs = [(r, _TOKEN.findall((r["text"] or "").lower())) for r in rows]
    df: dict[str, int] = {}
    for _, toks in docs:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    n = len(docs)
    lex = {}
    for r, toks in docs:
        s = 0.0
        for t in q_terms:
            tf = toks.count(t)
            if tf:
                s += (math.log(1 + n / df[t])) * (tf / (tf + 1.2))
        lex[r["item_id"]] = s
    lmax = max(lex.values()) or 1.0

    # Semantic, if the embedding model is reachable.
    sem: dict[str, float] = {}
    mode = "lexical"
    try:
        (qv,), _ = embed([q])
        qa = array.array("f", qv)
        for r in rows:
            if r["vector"]:
                v = array.array("f")
                v.frombytes(r["vector"])
                sem[r["item_id"]] = _cosine(qa, v)
        if sem:
            mode = "hybrid"
    except Exception:
        pass

    scored = []
    for r in rows:
        s = 0.3 * (lex[r["item_id"]] / lmax) + (0.7 * sem.get(r["item_id"], 0.0) if sem else 0.7 * (lex[r["item_id"]] / lmax))
        if s > 0.05:
            scored.append((s, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    ids = [r["item_id"] for _, r in scored[:k]]
    items: dict[str, dict] = {}
    if ids:
        with db() as c:
            for row in c.execute(f"SELECT * FROM items WHERE id IN ({','.join('?' * len(ids))})", ids):
                items[row["id"]] = _row(row)
    return {
        "mode": mode,
        "results": [
            {"score": round(s, 3), "collection": r["collection"], "id": r["item_id"], "snippet": (r["text"] or "")[:280], "item": items.get(r["item_id"])}
            for s, r in scored[:k]
            if r["item_id"] in items
        ],
    }


# ── collections API ──────────────────────────────────────────────────────────

@router.get("/health")
def cc_health():
    llm = {"ok": False}
    try:
        llm = {"ok": True, "models": llm_models()[:20], "loaded": [m["id"] for m in llm_loaded_models()][:5]}
    except Exception as e:
        llm = {"ok": False, "error": _why(e)}
    llm["baseUrl"] = load_config()["llm"]["baseUrl"]
    llm["gpuBusy"] = gpu_busy()
    with db() as c:
        counts = {r["collection"]: r["n"] for r in c.execute("SELECT collection, COUNT(*) n FROM items WHERE deleted=0 GROUP BY collection")}
        vault = c.execute("SELECT COUNT(*) n, SUM(vector IS NOT NULL) e FROM vault").fetchone()
    return {
        "ok": True,
        "version": 1,
        "now": time.time(),
        "llm": llm,
        "counts": counts,
        "vault": {"items": vault["n"] or 0, "embedded": vault["e"] or 0},
        "lastBackup": kv_get("backup.last"),
    }


@router.get("/c/{collection}")
def list_items(collection: str, since: float = 0, include_deleted: bool = False):
    _coll(collection)
    with db() as c:
        rows = c.execute(
            "SELECT * FROM items WHERE collection=? AND updated>? ORDER BY created DESC LIMIT 5000",
            (collection, since),
        ).fetchall()
    items = [_row(r) for r in rows if include_deleted or since or not r["deleted"]]
    return {"items": items, "now": time.time()}


@router.post("/c/{collection}")
def create_item(collection: str, data: dict):
    _coll(collection)
    body = _validated(collection, _clean(data))
    if len(json.dumps(body)) > 512 * 1024:
        raise HTTPException(413, "Item too large")
    item_id = str(data.get("id") or uuid.uuid4())
    now = time.time()
    with _db_lock, db() as c:
        c.execute(
            "INSERT INTO items(id,collection,data,created,updated,deleted) VALUES(?,?,?,?,?,0)",
            (item_id, collection, json.dumps(body), now, now),
        )
    _upsert_vault_text(item_id, collection, body, False)
    return {**body, "id": item_id, "_created": now, "_updated": now, "_deleted": False}


@router.patch("/c/{collection}/{item_id}")
def update_item(collection: str, item_id: str, patch: dict):
    _coll(collection)
    with _db_lock, db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection=?", (item_id, collection)).fetchone()
        if not r:
            raise HTTPException(404, "Not found")
        merged = _validated(collection, {**json.loads(r["data"]), **_clean(patch)})
        now = time.time()
        c.execute("UPDATE items SET data=?, updated=?, deleted=0 WHERE id=?", (json.dumps(merged), now, item_id))
    _upsert_vault_text(item_id, collection, merged, False)
    return {**merged, "id": item_id, "_created": r["created"], "_updated": now, "_deleted": False}


@router.delete("/c/{collection}/{item_id}")
def delete_item(collection: str, item_id: str):
    """Soft delete so other devices see the removal on their next sync."""
    _coll(collection)
    with _db_lock, db() as c:
        n = c.execute("UPDATE items SET deleted=1, updated=? WHERE id=? AND collection=?", (time.time(), item_id, collection)).rowcount
    if not n:
        raise HTTPException(404, "Not found")
    _upsert_vault_text(item_id, collection, {}, True)
    return {"ok": True}


# ── key/value (device UI config snapshots, sync cursors) ─────────────────────

_KV_KEY = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


@router.get("/kv/{key}")
def get_kv(key: str):
    if not _KV_KEY.match(key):
        raise HTTPException(400, "Bad key")
    return {"key": key, "value": kv_get(key)}


@router.put("/kv/{key}")
def put_kv(key: str, body: dict):
    if not _KV_KEY.match(key) or key.startswith("backup."):
        raise HTTPException(400, "Bad key")
    if len(json.dumps(body)) > 256 * 1024:
        raise HTTPException(413, "Too large")
    kv_set(key, body.get("value"))
    return {"ok": True}


# ── n8n status pings (workflows report their own start/finish) ───────────────
#
# Add an HTTP Request node at the start and end of a workflow:
#   POST http://host.docker.internal:8080/api/cc/n8n/ping
#   {"workflowId": "{{$workflow.id}}", "status": "running" | "success" | "error",
#    "executionId": "{{$execution.id}}", "durationMs": 1234}
# The desktop's pipeline monitor merges these with the n8n REST API so a
# workflow shows "running" the moment it starts, not on the next execution poll.

_PING_STATUS = {"running", "success", "error", "idle", "waiting", "crashed"}
_ping_lock = threading.Lock()


class N8nPing(BaseModel):
    workflowId: str
    status: str
    executionId: Optional[str] = None
    durationMs: Optional[int] = None
    name: Optional[str] = None


@router.post("/n8n/ping")
def n8n_ping(p: N8nPing):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", p.workflowId) or p.status not in _PING_STATUS:
        raise HTTPException(400, "workflowId [A-Za-z0-9_-] and a known status required")
    now = time.time()
    with _ping_lock:
        pings = kv_get("n8n.pings", {}) or {}
        pings[p.workflowId] = {
            "status": p.status,
            "at": now,
            "iso": datetime.utcfromtimestamp(now).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "executionId": p.executionId,
            "durationMs": p.durationMs,
            "name": (p.name or "")[:120] or None,
        }
        if len(pings) > 200:  # keep the most recent 200 workflows
            pings = dict(sorted(pings.items(), key=lambda kv: kv[1]["at"], reverse=True)[:200])
        kv_set("n8n.pings", pings)
    return {"ok": True}


@router.get("/n8n/pings")
def n8n_pings():
    return {"pings": kv_get("n8n.pings", {}) or {}}


# ── config ───────────────────────────────────────────────────────────────────

@router.get("/config")
def get_config():
    return load_config()


@router.put("/config")
def put_config(patch: dict):
    cfg = _deep_merge(load_config(), {k: v for k, v in patch.items() if k in DEFAULT_CONFIG})
    if not _valid_http_url(cfg["llm"]["baseUrl"]):
        raise HTTPException(400, "llm.baseUrl must be an http(s) URL")
    eb = cfg["llm"].get("embeddingBaseUrl")
    if eb is not None and (not isinstance(eb, str) or (eb.strip() and not _valid_http_url(eb.strip()))):
        raise HTTPException(400, "llm.embeddingBaseUrl must be an http(s) URL, or empty for llm.baseUrl")
    b = cfg["backup"]
    b["intervalHours"] = max(1, min(24 * 30, float(b.get("intervalHours", 24))))
    b["keep"] = max(1, min(365, int(b.get("keep", 14))))
    save_config(cfg)
    _models_cache.clear()
    _loaded_cache.clear()
    _embedder_cache.clear()
    return cfg


# ── files ────────────────────────────────────────────────────────────────────

@router.post("/files")
async def upload_file(file: UploadFile = File(...)):
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    if not mime.startswith(ALLOWED_UPLOAD):
        raise HTTPException(415, f"Unsupported type {mime}")
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File larger than 15 MB")
    # The disk write and the DB insert (which can wait on _db_lock / a busy SQLite) block: keep them
    # off the event loop that every gateway request shares.
    return await run_in_threadpool(_store_upload, data, mime, file.filename or "")


def _store_upload(data: bytes, mime: str, filename: str) -> dict:
    fid = uuid.uuid4().hex
    ext = (mimetypes.guess_extension(mime) or Path(filename).suffix or ".bin")[:8]
    sub = FILES_DIR / datetime.now().strftime("%Y-%m")
    sub.mkdir(parents=True, exist_ok=True)
    path = sub / f"{fid}{ext}"
    path.write_bytes(data)
    name = Path(filename or f"capture{ext}").name[:120]
    with _db_lock, db() as c:
        c.execute(
            "INSERT INTO files(id,name,mime,size,path,created) VALUES(?,?,?,?,?,?)",
            (fid, name, mime, len(data), str(path.relative_to(CC_DIR)), time.time()),
        )
    return {"id": fid, "name": name, "mime": mime, "size": len(data)}


def _file_row(fid: str) -> sqlite3.Row:
    if not re.fullmatch(r"[0-9a-f]{32}", fid):
        raise HTTPException(400, "Bad file id")
    with db() as c:
        r = c.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
    if not r:
        raise HTTPException(404, "File not found")
    return r


@router.get("/files/{fid}")
def get_file(fid: str):
    r = _file_row(fid)
    path = (CC_DIR / r["path"]).resolve()
    if CC_DIR.resolve() not in path.parents:
        raise HTTPException(400, "Bad path")
    return FileResponse(path, media_type=r["mime"], filename=r["name"])


# ── OCR: receipts / invoices / checks via local vision LLM ───────────────────

OCR_PROMPT = """You read Canadian receipts, invoices and cheques. Return ONLY JSON:
{"vendor": str|null, "date": "YYYY-MM-DD"|null, "subtotal": number|null,
 "gst": number|null, "hst": number|null, "pst": number|null, "qst": number|null,
 "tip": number|null, "total": number|null, "currency": "CAD"|"USD"|null,
 "invoiceNumber": str|null, "payer": str|null, "chequeNumber": str|null, "memo": str|null,
 "category": one of ["meals","fuel","vehicle","office","equipment","software","travel","wardrobe","training","subcontract","materials","utilities","other"]|null,
 "items": [{"desc": str, "amount": number}], "confidence": number between 0 and 1}
Copy numbers exactly as printed. Never guess a value you cannot read; use null."""


class OcrRequest(BaseModel):
    fileId: str
    kind: str = "receipt"  # receipt | invoice | check


def _tax_check(f: dict) -> dict:
    """Validate the arithmetic and infer the tax regime (ON HST 13 %, Atlantic HST 15 %, GST 5 %)."""
    num = lambda k: float(f[k]) if isinstance(f.get(k), (int, float)) else 0.0
    sub, total = num("subtotal"), num("total")
    taxes = num("gst") + num("hst") + num("pst") + num("qst")
    flags = []
    regime = None
    if sub > 0:
        hst_rate = num("hst") / sub
        gst_rate = num("gst") / sub
        if abs(hst_rate - 0.13) < 0.006:
            regime = "HST 13% (ON)"
        elif abs(hst_rate - 0.15) < 0.006:
            regime = "HST 15%"
        elif abs(gst_rate - 0.05) < 0.004:
            regime = "GST 5%" + (" + PST" if num("pst") else "") + (" + QST" if num("qst") else "")
        elif taxes:
            flags.append(f"Unusual tax rate {round(taxes / sub * 100, 2)}%")
        if total and abs(sub + taxes + num("tip") - total) > 0.05:
            flags.append("Subtotal + tax + tip doesn't equal total")
    elif total and not taxes:
        flags.append("No tax breakdown found")
    return {"regime": regime, "flags": flags, "taxTotal": round(taxes, 2)}


@router.post("/ocr")
def ocr(req: OcrRequest):
    r = _file_row(req.fileId)
    if not r["mime"].startswith("image/"):
        raise HTTPException(415, "OCR needs an image")
    img = (CC_DIR / r["path"]).read_bytes()
    cfg = load_config()["llm"]
    engine = "vision-llm"
    try:
        content = [
            {"type": "text", "text": f"Document type: {req.kind}. Extract the fields."},
            {"type": "image_url", "image_url": {"url": f"data:{r['mime']};base64,{base64.b64encode(img).decode()}"}},
        ]
        raw = llm_chat(
            [{"role": "system", "content": OCR_PROMPT}, {"role": "user", "content": content}],
            model=cfg.get("visionModel") or "",
            max_tokens=900,
            temperature=0,
        )
    except Exception as vision_err:
        # Fallback: Tesseract (if installed) → text LLM.
        try:
            import pytesseract  # type: ignore
            from PIL import Image  # type: ignore
            import io

            text = pytesseract.image_to_string(Image.open(io.BytesIO(img)))
            raw = llm_chat([{"role": "system", "content": OCR_PROMPT}, {"role": "user", "content": f"Document type: {req.kind}.\nOCR text:\n{text}"}], temperature=0)
            engine = "tesseract+llm"
        except ImportError:
            raise HTTPException(503, f"No local vision model reachable ({_why(vision_err)}). Load a vision model in LM Studio or install pytesseract.")
        except Exception as e:
            raise HTTPException(503, f"OCR failed: {_why(e)}")
    fields = extract_json(raw) or {}
    return {"fields": fields, "check": _tax_check(fields), "engine": engine, "raw": raw[:4000]}


# ── LLM helpers: brainstorm organizing + structured JSON generation ──────────

ORGANIZE_PROMPT = """You organize raw spoken brain-dumps. Keep the speaker's meaning; never invent facts.
Return ONLY JSON: {"title": str (<= 8 words), "summary": str (2-3 sentences),
"categories": [{"name": str, "bullets": [str]}], "actions": [{"text": str, "due": str|null}],
"tags": [str (lowercase, 1-2 words)]}"""


class OrganizeRequest(BaseModel):
    id: str


@router.post("/brainstorm/organize")
def organize(req: OrganizeRequest):
    with db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection='notes'", (req.id,)).fetchone()
    if not r:
        raise HTTPException(404, "Note not found")
    note = json.loads(r["data"])
    raw = note.get("rawText") or "\n".join(s.get("text", "") for s in note.get("segments", []))
    if not raw.strip():
        raise HTTPException(400, "Nothing to organize yet")
    try:
        out = llm_chat([{"role": "system", "content": ORGANIZE_PROMPT}, {"role": "user", "content": raw[-24000:]}], max_tokens=1600)
    except Exception as e:
        raise HTTPException(503, f"Local LLM unavailable: {_why(e)}")
    organized = extract_json(out)
    if not organized:
        # One retry with a blunt nudge before giving up on clean JSON.
        try:
            out = llm_chat(
                [{"role": "system", "content": ORGANIZE_PROMPT}, {"role": "user", "content": raw[-24000:]}, {"role": "user", "content": "Return ONLY JSON, nothing else."}],
                max_tokens=1600,
            )
            organized = extract_json(out)
        except Exception:
            organized = None
    if not organized:
        # Still no clean JSON: don't fail the whole note over formatting —
        # fall back to a plain summary from whatever text came back.
        organized = {"title": note.get("title") or "Untitled", "summary": out.strip()[:600], "categories": [], "actions": [], "tags": []}
    patch = {"organized": organized, "organizedAt": time.time()}
    if not note.get("titleLocked") and organized.get("title"):
        patch["title"] = organized["title"]
    return update_item("notes", req.id, patch)


class JsonGenRequest(BaseModel):
    system: str
    prompt: str


@router.post("/llm/json")
def llm_json(req: JsonGenRequest):
    if len(req.system) > 8000 or len(req.prompt) > 8000:
        raise HTTPException(413, "Too long")
    if gpu_busy():
        # The desktop's pipeline holds the GPU: answer at once so the caller takes its
        # deterministic fallback instead of queueing a second generation on the card.
        raise HTTPException(503, "Local LLM busy (the desktop holds the GPU); use the fallback")
    try:
        out = llm_chat([{"role": "system", "content": req.system}, {"role": "user", "content": req.prompt}], max_tokens=1200, gpu_wait=0)
    except Exception as e:
        raise HTTPException(503, f"Local LLM unavailable: {_why(e)}")
    j = extract_json(out)
    if j is None and not gpu_busy():
        # One retry with a blunt nudge before giving up.
        try:
            out = llm_chat(
                [{"role": "system", "content": req.system}, {"role": "user", "content": req.prompt}, {"role": "user", "content": "Return ONLY JSON, nothing else."}],
                max_tokens=1200,
                gpu_wait=0,
            )
            j = extract_json(out)
        except Exception:
            j = None
    if j is None:
        raise HTTPException(502, "Model returned no JSON")
    return j


# ── brainstorm wrap-up (Section 9: "Talk it through" → items to approve one by one) ──
#
# POST /brainstorm/wrapup {id} reads a note's transcript (segments with Nic / Tony speakers; a
# legacy note's rawText) and asks the local model for a title, a summary and items. The model's
# answer is validated strictly and nothing it invents survives:
#   * every item must carry a `quote` that is found, word for word (case, punctuation and spacing
#     aside), in the transcript; an item whose quote isn't there is dropped and counted in `dropped`.
#   * an item text that drifts from the transcript's words is replaced by its quote.
#   * a quote must sit in one speaker's words (one line, or adjacent lines of the same speaker);
#     "..." may skip at most WRAPUP_ELLIPSIS_GAP words. Stitching Nic and Tony together is dropped.
#   * a memory suggestion must trace to Nic's own words, never Tony's; a decision or next step
#     that traces only to Tony is kept as an idea (speaker "tony"), never offered as Nic's decision.
# Item ids are assigned here (a hash of kind + quote), not by the model, so a re-run gives the same
# item the same id. Statuses live on the note (`wrapup.items[].status`): a re-run never resets an
# item that is sending, sent, skipped or failed, and keeps those even when the new run drops them.
# Model busy (the desktop holds the GPU past a short wait, or a maintenance window), unreachable,
# or no valid JSON after one retry: 503 {detail, reason, retryAfter, note} plus a Retry-After header.
# The note then carries a no-model fallback (Nic's own lines as candidate items) unless it
# already has a model wrap-up, which is kept. Mirrored by src/features/brainstorm/session-types.ts.

WRAPUP_KINDS = ("idea", "decision", "next_step")
WRAPUP_DESTINATIONS = ("play_place", "director", "ledger", "memory")
WRAPUP_STATUSES = ("pending", "sending", "sent", "skipped", "failed")
WRAPUP_MEMORY_CATEGORIES = ("preference", "workflow", "rule", "persona", "domain_knowledge", "correction")
WRAPUP_MAX_CHARS = 24000      # transcript window sent to the model (the end of the session)
WRAPUP_MAX_ITEMS = 20
WRAPUP_FALLBACK_MAX = 30
WRAPUP_TEXT_MAX = 300         # also the memory-commit cap per item
WRAPUP_ELLIPSIS_GAP = 12      # most words one "..." in a quote may skip
WRAPUP_TITLE_MAX = 80
WRAPUP_SUMMARY_MAX = 800
WRAPUP_GPU_WAIT_SECS = 4.0    # Tony finishing his last sentence; longer than this is "busy"
WRAPUP_RETRY_SECS = 15

WRAPUP_PROMPT = """You wrap up a brainstorming session between Nic and Tony (his assistant). Each transcript line starts with "Nic:" or "Tony:".
List only what was actually said. Never invent ideas, decisions, steps, names, dates or facts. When unsure, leave it out.
Return ONLY JSON, nothing else:
{"title": str (<= 8 words), "summary": str (2-3 sentences, only what was said),
 "items": [{"kind": "idea" | "decision" | "next_step",
   "text": str (one short sentence),
   "quote": str (the exact words from ONE transcript line that this item comes from, copied verbatim, without the "Nic:" / "Tony:" label),
   "suggested_destination": "play_place" | "director" | "ledger" | "memory" | null,
   "memory_category": "preference" | "workflow" | "rule" | "persona" | "domain_knowledge" | "correction" | null}]}
Destinations: play_place = an app, widget or prototype to build; director = a film, video, music or other creative media project; ledger = a task or idea to track; memory = a lasting fact or preference Nic said about himself or how he works; null = none fits.
At most 20 items. An empty items list is fine."""

_WRAP_NONWORD = re.compile(r"[\W_]+", re.UNICODE)
_WRAP_SPEAKER = re.compile(r"^\s*(nic|tony)\s*[:\-–—]\s*", re.I)
_WRAP_ELLIPSIS = re.compile(r"\.{3,}|…")
_WRAP_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_WRAP_STOP = frozenset(
    "about after again also because been being could does doing done from have here into just like make more most much need "
    "only other over really should some such than that their them then there these they thing things this those through "
    "very want what when where which while will with would your yeah okay maybe gonna wanna".split()
)
_wrapup_running: set[str] = set()
_wrapup_running_lock = threading.Lock()


def _wrap_norm(s: Any) -> str:
    """Case, punctuation and spacing folded away: what a verbatim quote must still match."""
    s = unicodedata.normalize("NFKC", str(s or "")).casefold()
    return " ".join(_WRAP_NONWORD.sub(" ", s).split())


def _wrap_clean(s: Any, cap: int) -> str:
    """One line of display text: control / bidi / zero-width characters out, spaces collapsed,
    cut at a word boundary to `cap`."""
    s = "".join(ch for ch in str(s or "") if unicodedata.category(ch)[0] != "C" or ch in "\t\n")
    s = " ".join(s.split())
    if len(s) > cap:
        cut = s[:cap]
        sp = cut.rfind(" ")
        s = (cut[:sp] if sp > cap // 2 else cut).rstrip()
    return s


def _wrap_segments(note: dict) -> list[dict]:
    """The note's transcript as [{t, text, speaker}]: segments (no speaker = Nic, Listen Mode),
    or a legacy note's rawText split into lines ("Tony:" / "Nic:" labels honoured)."""
    out: list[dict] = []
    segs = note.get("segments")
    if isinstance(segs, list) and any(isinstance(s, dict) and str(s.get("text") or "").strip() for s in segs):
        for s in segs:
            if not isinstance(s, dict):
                continue
            text = str(s.get("text") or "").strip()
            if not text:
                continue
            t = s.get("t")
            t = float(t) if isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t) else None
            out.append({"t": t, "text": text, "speaker": "tony" if s.get("speaker") == "tony" else "nic"})
        return out
    for line in str(note.get("rawText") or "").splitlines():
        m = _WRAP_SPEAKER.match(line)
        speaker = m.group(1).lower() if m else "nic"
        text = (line[m.end():] if m else line).strip()
        if text:
            out.append({"t": None, "text": text, "speaker": speaker})
    return out


def _wrap_window(segs: list[dict], max_chars: int = WRAPUP_MAX_CHARS) -> list[dict]:
    """The last segments that fit in `max_chars` of labelled transcript (a huge last one is cut to its end)."""
    window: list[dict] = []
    used = 0
    for s in reversed(segs):
        cost = len(s["text"]) + 6
        if used + cost > max_chars:
            if not window:
                window.append({**s, "text": s["text"][-(max_chars - 6):]})
            break
        window.append(s)
        used += cost
    window.reverse()
    return window


def _wrap_transcript(window: list[dict]) -> str:
    return "\n".join(f"{'Tony' if s['speaker'] == 'tony' else 'Nic'}: {s['text']}" for s in window)


def _wrap_item_id(kind: str, quote: str) -> str:
    return "w" + hashlib.sha1(f"{kind}|{_wrap_norm(quote)}".encode("utf-8")).hexdigest()[:12]


class _WrapTrace:
    """Finds a quote in the transcript window; says which segments it spans."""

    def __init__(self, window: list[dict]):
        self.window = window
        norms = [_wrap_norm(s["text"]) for s in window]
        self.starts: list[int] = []
        pos = 0
        for n in norms:
            self.starts.append(pos)
            pos += len(n) + 1
        self.joined = " ".join(norms)
        self._padded = f" {self.joined} "
        self.prefixes = {w[:5] for w in self.joined.split() if len(w) >= 4}

    def _seg_at(self, pos: int) -> int:
        return max(0, bisect.bisect_right(self.starts, pos) - 1)

    def find(self, quote: str) -> Optional[list[int]]:
        """Indices of the segments a quote spans (Nic-only spans preferred), or None when it isn't
        in the transcript. "..." in a quote may skip at most WRAPUP_ELLIPSIS_GAP words; the parts
        must appear in order. The whole quote must sit in one speaker's words: one segment, or
        adjacent segments of the same speaker. A quote stitched across Nic and Tony (or across a
        long gap) is not a quote of anything either of them said."""
        parts = [p for p in (_wrap_norm(x) for x in _WRAP_ELLIPSIS.split(_WRAP_SPEAKER.sub("", quote or ""))) if p]
        if not parts:
            return None
        if sum(len(p.split()) for p in parts) < 2 or sum(len(p) for p in parts) < 6:
            return None  # too short to trace anything ("yes", "ok")
        # P is the joined text padded with one space each side, so an index i of " part " in P is
        # the index of the part itself in self.joined (what self.starts counts in).
        P = self._padded
        first = f" {parts[0]} "
        tony_span: Optional[list[int]] = None
        i = P.find(first)
        tries = 0
        while i >= 0 and tries < 200:
            tries += 1
            end = i + len(parts[0])  # exclusive end in self.joined
            ok = True
            for p in parts[1:]:
                j = P.find(f" {p} ", end)  # the nearest next part is the smallest gap
                if j < 0 or len(P[end + 1:j + 1].split()) > WRAPUP_ELLIPSIS_GAP:
                    ok = False
                    break
                end = j + len(p)
            if ok:
                segs = list(range(self._seg_at(i), self._seg_at(max(i, end - 1)) + 1))
                speakers = {self.window[k]["speaker"] for k in segs}
                if speakers == {"nic"}:
                    return segs
                if speakers == {"tony"} and tony_span is None:
                    tony_span = segs
            i = P.find(first, i + 1)
        return tony_span

    def grounded(self, text: str) -> bool:
        """Most of an item text's content words (stems) were said in the session."""
        words = [w for w in _wrap_norm(text).split() if len(w) >= 4 and w not in _WRAP_STOP]
        if not words:
            return True
        hits = sum(1 for w in words if w[:5] in self.prefixes)
        return hits / len(words) >= 0.6


def _wrap_dest(v: Any) -> Optional[str]:
    if not isinstance(v, str):
        return None
    d = v.strip().lower().replace("-", "_").replace(" ", "_")
    d = {"playplace": "play_place", "play": "play_place"}.get(d, d)
    return d if d in WRAPUP_DESTINATIONS else None


def _wrap_kind(v: Any) -> Optional[str]:
    if not isinstance(v, str):
        return None
    k = v.strip().lower().replace("-", "_").replace(" ", "_")
    k = {"nextstep": "next_step", "next": "next_step", "step": "next_step", "action": "next_step", "task": "next_step"}.get(k, k)
    return k if k in WRAPUP_KINDS else None


def _wrap_validate(raw: Any, trace: _WrapTrace) -> Optional[dict]:
    """The model's answer as {title, summary, items, dropped}, or None when its shape is wrong
    (that earns the one retry). Items that fail are dropped one by one, never repaired by guessing."""
    if not isinstance(raw, dict):
        return None
    title, summary, items = raw.get("title"), raw.get("summary"), raw.get("items")
    if not isinstance(title, str) or not isinstance(summary, str) or not isinstance(items, list):
        return None
    out: list[dict] = []
    seen: set[str] = set()
    dropped = 0
    for it in items:
        if len(out) >= WRAPUP_MAX_ITEMS:
            dropped += 1
            continue
        if not isinstance(it, dict):
            dropped += 1
            continue
        kind = _wrap_kind(it.get("kind"))
        text = _wrap_clean(it.get("text"), WRAPUP_TEXT_MAX) if isinstance(it.get("text"), str) else ""
        quote = _wrap_clean(_WRAP_SPEAKER.sub("", it.get("quote") or "") if isinstance(it.get("quote"), str) else "", WRAPUP_TEXT_MAX)
        segs = trace.find(quote) if kind and text and quote else None
        if segs is None:
            dropped += 1
            continue
        if not trace.grounded(text):
            text = quote  # the model's wording drifted from what was said: show the words themselves
        speaker = "nic" if all(trace.window[k]["speaker"] == "nic" for k in segs) else "tony"
        if speaker == "tony" and kind in ("decision", "next_step"):
            kind = "idea"  # Tony proposing it is not Nic deciding it: offered as Tony's idea
        suggested = _wrap_dest(it.get("suggested_destination"))
        if suggested == "memory" and speaker != "nic":
            suggested = None  # core memory only from Nic's own words
        item_id = _wrap_item_id(kind, quote)
        if item_id in seen:
            continue  # the same item twice
        seen.add(item_id)
        item: dict[str, Any] = {
            "id": item_id, "kind": kind, "text": text, "quote": quote, "speaker": speaker,
            "t": trace.window[segs[0]]["t"], "suggested": suggested, "dest": suggested, "status": "pending",
        }
        if suggested == "memory":
            cat = it.get("memory_category")
            item["memoryCategory"] = cat if cat in WRAPUP_MEMORY_CATEGORIES else "rule"
        out.append(item)
    return {"title": _wrap_clean(title, WRAPUP_TITLE_MAX), "summary": _wrap_clean(summary, WRAPUP_SUMMARY_MAX), "items": out, "dropped": dropped}


def _wrap_fallback(note: dict, window: list[dict], reason: str) -> dict:
    """No model: Nic's own lines (sentences of 3+ words) become candidate items, unsorted and
    undirected. Nothing is summarised beyond his first words."""
    items: list[dict] = []
    seen: set[str] = set()
    firsts: list[str] = []
    for s in window:
        if s["speaker"] != "nic":
            continue
        for sentence in _WRAP_SENTENCE.split(s["text"]):
            line = _wrap_clean(sentence, WRAPUP_TEXT_MAX)
            if len(_wrap_norm(line).split()) < 3:
                continue
            if len(firsts) < 2:
                firsts.append(line)
            item_id = _wrap_item_id("idea", line)
            if item_id in seen or len(items) >= WRAPUP_FALLBACK_MAX:
                continue
            seen.add(item_id)
            items.append({
                "id": item_id, "kind": "idea", "text": line, "quote": line, "speaker": "nic", "t": s["t"],
                "suggested": None, "dest": None, "status": "pending",
            })
    return {
        "at": time.time(),
        "title": _wrap_clean(note.get("title") or "Brainstorm", WRAPUP_TITLE_MAX) or "Brainstorm",
        "summary": _wrap_clean(" ".join(firsts), WRAPUP_SUMMARY_MAX),
        "items": items,
        "engine": "fallback",
        "fallbackReason": reason,
        "coveredSegments": len(window),
        "dropped": 0,
    }


def _wrap_merge(old: Any, new: dict) -> dict:
    """`new` with the old run's decisions kept: an item already sending / sent / skipped / failed is
    never reset (and is carried over when the new run lost it); a pending item keeps its old id
    and the destination Nic picked by hand."""
    old_items = [i for i in ((old or {}).get("items") if isinstance(old, dict) else None) or [] if isinstance(i, dict) and isinstance(i.get("id"), str)]
    by_id = {i["id"]: i for i in old_items}
    by_quote: dict[str, dict] = {}
    by_text: dict[str, dict] = {}
    for i in old_items:
        by_quote.setdefault(_wrap_norm(i.get("quote")), i)
        by_text.setdefault(_wrap_norm(i.get("text")), i)
    by_quote.pop("", None)
    by_text.pop("", None)
    def overlapping(q: str) -> Optional[dict]:
        """An old item whose quote and this one are the same words give or take a few at the ends
        ("I want a clock widget…" vs "a clock widget…"): the shorter is inside the longer, is
        3+ words and at least 60% of it."""
        qw = q.split()
        hits = []
        for o in old_items:
            ow = _wrap_norm(o.get("quote")).split()
            short, long_ = (qw, ow) if len(qw) <= len(ow) else (ow, qw)
            if len(short) >= 3 and len(short) >= 0.6 * len(long_) and f" {' '.join(short)} " in f" {' '.join(long_)} ":
                hits.append(o)
        return next((o for o in hits if o["id"] not in used), hits[0] if hits else None)

    used: set[str] = set()
    items: list[dict] = []
    for n in new["items"]:
        nq = _wrap_norm(n.get("quote"))
        o = by_id.get(n["id"]) or by_quote.get(nq) or by_text.get(_wrap_norm(n.get("text")))
        if o is None or o["id"] in used:
            o = overlapping(nq) or o
        if o is not None and o["id"] not in used:
            used.add(o["id"])
            if o.get("status") != "pending":
                items.append(o)  # decided (or in flight): exactly as it was
                continue
            m = {**n, "id": o["id"]}
            if _wrap_dest(o.get("dest")) and o.get("dest") != o.get("suggested"):
                m["dest"] = o["dest"]
            items.append(m)
            continue
        if o is not None and o.get("status") != "pending":
            continue  # a second new item for an already decided one: never a second send
        items.append(n)
    for o in old_items:
        if o["id"] not in used and o.get("status") != "pending":
            items.append(o)
    unique: list[dict] = []
    ids: set[str] = set()
    for i in items:
        if i["id"] not in ids:
            ids.add(i["id"])
            unique.append(i)
    return {**new, "items": unique}


def _wrap_organized(note: dict, wrap: dict) -> dict:
    live = [i for i in wrap["items"] if i.get("status") != "skipped"]
    cats = [
        {"name": name, "bullets": [i["text"] for i in live if i.get("kind") == kind]}
        for name, kind in (("Ideas", "idea"), ("Decisions", "decision"))
    ]
    prev = note.get("organized") if isinstance(note.get("organized"), dict) else {}
    return {
        "title": wrap["title"],
        "summary": wrap["summary"],
        "categories": [c for c in cats if c["bullets"]],
        "actions": [{"text": i["text"], "due": None} for i in live if i.get("kind") == "next_step"],
        "tags": prev.get("tags") if isinstance(prev.get("tags"), list) else [],
    }


def _wrap_store(note_id: str, wrap: dict, keep_model_run: bool) -> dict:
    """Merge `wrap` into the note's current wrap-up and save it, read and written under one lock
    (a status a device wrote while the model ran is the one merged). `keep_model_run`: a fallback
    never replaces an existing model wrap-up."""
    with _db_lock, db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection='notes' AND deleted=0", (note_id,)).fetchone()
        if not r:
            raise HTTPException(404, "Note not found")
        note = json.loads(r["data"])
        cur = note.get("wrapup") if isinstance(note.get("wrapup"), dict) else None
        if keep_model_run and cur and cur.get("engine") == "llm":
            merged = note
        else:
            w = _wrap_merge(cur, wrap)
            patch: dict[str, Any] = {"wrapup": w}
            if w["engine"] == "llm":
                patch.update(organized=_wrap_organized(note, w), organizedAt=w["at"])
                if not note.get("titleLocked") and w["title"]:
                    patch["title"] = w["title"]
            merged = {**note, **patch}
            c.execute("UPDATE items SET data=?, updated=? WHERE id=?", (json.dumps(merged), time.time(), note_id))
        r = c.execute("SELECT * FROM items WHERE id=?", (note_id,)).fetchone()
    _upsert_vault_text(note_id, "notes", merged, False)
    return _row(r)


def _wrap_ask_model(transcript: str, trace: _WrapTrace) -> tuple[Optional[dict], str, str]:
    """(validated answer or None, failure reason, detail). One retry when the JSON is bad,
    unless the desktop took the GPU meanwhile."""
    msgs = [{"role": "system", "content": WRAPUP_PROMPT}, {"role": "user", "content": f"TRANSCRIPT:\n{transcript}"}]
    for attempt in range(2):
        if attempt and gpu_busy():
            return None, "busy", "the desktop took the GPU before the retry"
        try:
            out = llm_chat(msgs if not attempt else msgs + [{"role": "user", "content": "Return ONLY the JSON object described, nothing else."}], max_tokens=1600, temperature=0.1, gpu_wait=0)
        except GpuMaintenance as e:
            return None, "busy", str(e)
        except Exception as e:
            return None, "unavailable", _why(e)
        v = _wrap_validate(extract_json(out), trace)
        if v is not None:
            return v, "", ""
    return None, "invalid", "the local model returned no valid wrap-up JSON (twice)"


class WrapUpRequest(BaseModel):
    id: str


@router.post("/brainstorm/wrapup")
def brainstorm_wrapup(req: WrapUpRequest):
    with db() as c:
        r = c.execute("SELECT * FROM items WHERE id=? AND collection='notes' AND deleted=0", (req.id,)).fetchone()
    if not r:
        raise HTTPException(404, "Note not found")
    note = json.loads(r["data"])
    window = _wrap_window(_wrap_segments(note))
    if not window:
        raise HTTPException(400, "Nothing to wrap up yet")
    with _wrapup_running_lock:
        if req.id in _wrapup_running:
            raise HTTPException(409, "A wrap-up for this note is already running")
        _wrapup_running.add(req.id)
    try:
        trace = _WrapTrace(window)
        reason, detail, answer = "", "", None
        if not wait_gpu(WRAPUP_GPU_WAIT_SECS, poll=0.1) or gpu_maintenance():
            reason, detail = "busy", "the desktop holds the GPU"
        else:
            answer, reason, detail = _wrap_ask_model(_wrap_transcript(window), trace)
        if answer is not None:
            wrap = {
                "at": time.time(), "title": answer["title"] or _wrap_clean(note.get("title") or "Brainstorm", WRAPUP_TITLE_MAX),
                "summary": answer["summary"], "items": answer["items"], "engine": "llm",
                "coveredSegments": len(window), "dropped": answer["dropped"],
            }
            return _wrap_store(req.id, wrap, keep_model_run=False)
        stored = _wrap_store(req.id, _wrap_fallback(note, window, reason), keep_model_run=True)
        retry = WRAPUP_RETRY_SECS
        if reason == "busy":
            st = gpu_state()
            if st.get("expiresAt"):
                retry = int(min(120, max(5, math.ceil(st["expiresAt"] - time.time()))))
        msg = {"busy": "Local model busy", "unavailable": "Local model unavailable", "invalid": "Local model gave no usable wrap-up"}[reason]
        return JSONResponse(
            status_code=503,
            content={"detail": f"{msg}: {detail}"[:300], "reason": reason, "retryAfter": retry, "note": stored},
            headers={"Retry-After": str(retry)},
        )
    finally:
        with _wrapup_running_lock:
            _wrapup_running.discard(req.id)


# ── vault endpoints ──────────────────────────────────────────────────────────

@router.get("/vault/search")
def search(q: str = Query(..., min_length=1, max_length=500), collections: str = "", k: int = Query(8, ge=1, le=50), include_finance: bool = False):
    cols = [c for c in collections.split(",") if c in VAULT_FIELDS] or None
    return vault_search(q, cols, k, include_finance)


@router.post("/vault/reindex")
def reindex():
    with db() as c:
        rows = c.execute("SELECT id, collection, data, deleted FROM items").fetchall()
    n = 0
    for r in rows:
        if r["collection"] in VAULT_FIELDS:
            _upsert_vault_text(r["id"], r["collection"], json.loads(r["data"]), bool(r["deleted"]))
            n += 1
    return {"queued": n}


# ── market data proxy (no broker, read-only) ─────────────────────────────────

_SYMBOL = re.compile(r"^[A-Za-z0-9.^=\-]{1,24}$")
_INTERVALS = {"1m": "5d", "2m": "5d", "5m": "1mo", "15m": "1mo", "30m": "1mo", "60m": "3mo", "1d": "1y"}
_RANGES = {"1d", "5d", "1mo", "3mo", "6mo", "1y"}
_market_cache: dict[str, tuple[float, dict]] = {}


@router.get("/market/candles")
def candles(symbol: str, interval: str = "5m", range: str = "5d"):
    if not _SYMBOL.match(symbol) or interval not in _INTERVALS or range not in _RANGES:
        raise HTTPException(400, "Bad symbol / interval / range")
    key = f"{symbol}|{interval}|{range}"
    hit = _market_cache.get(key)
    if hit and time.time() - hit[0] < 15:
        return hit[1]
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?interval={interval}&range={range}&includePrePost=false"
    )
    try:
        data = _http_json(url, timeout=10, headers={"User-Agent": "Mozilla/5.0 (CommandCenter)"})
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code if e.code in (404, 429) else 502, f"Market data: HTTP {e.code}")
    except Exception as e:
        raise HTTPException(502, f"Market data unavailable: {_why(e)}")
    res = (data.get("chart", {}).get("result") or [None])[0]
    if not res:
        raise HTTPException(404, "Unknown symbol")
    q = res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(res.get("timestamp") or []):
        o, h, l, cl, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None not in (o, h, l, cl):
            out.append({"t": t, "o": o, "h": h, "l": l, "c": cl, "v": v or 0})
    meta = res.get("meta", {})
    payload = {
        "symbol": meta.get("symbol", symbol),
        "currency": meta.get("currency"),
        "exchange": meta.get("exchangeName"),
        "price": meta.get("regularMarketPrice"),
        "candles": out,
        "fetchedAt": time.time(),
        "source": "Yahoo Finance (unofficial, may be delayed)",
    }
    _market_cache[key] = (time.time(), payload)
    return payload


# ── backups ──────────────────────────────────────────────────────────────────

def run_backup(reason: str = "manual") -> dict:
    cfg = load_config()["backup"]
    out_dir = Path(cfg["dir"]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    zpath = out_dir / f"cc-{stamp}.zip"
    tmp_db = CC_DIR / f".backup-{stamp}.db"
    try:
        # Consistent online copy of the live database.
        dst = sqlite3.connect(tmp_db)
        try:
            with db() as src:
                src.backup(dst)
        finally:
            dst.close()
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tmp_db, "cc.db")
            if CONFIG_PATH.exists():
                z.write(CONFIG_PATH, "config.json")
            for extra in ("settings.json", "agent-routes.json", "goals.json"):
                p = BASE_DIR / "data" / extra
                if p.exists():
                    z.write(p, f"agentic-os-data/{extra}")
            if FILES_DIR.exists():
                for f in FILES_DIR.rglob("*"):
                    if f.is_file():
                        z.write(f, f"files/{f.relative_to(FILES_DIR).as_posix()}")
    finally:
        tmp_db.unlink(missing_ok=True)
    # Retention.
    zips = sorted(out_dir.glob("cc-*.zip"))
    for old in zips[: max(0, len(zips) - int(cfg.get("keep", 14)))]:
        old.unlink(missing_ok=True)
    info = {"file": str(zpath), "size": zpath.stat().st_size, "at": time.time(), "reason": reason}
    kv_set("backup.last", info)
    return info


def _backup_scheduler() -> None:
    while True:
        try:
            cfg = load_config()["backup"]
            last = (kv_get("backup.last") or {}).get("at", 0)
            if cfg.get("enabled") and time.time() - last >= float(cfg.get("intervalHours", 24)) * 3600:
                run_backup("scheduled")
        except Exception as e:
            print(f"[command-center] backup failed: {e}")
        time.sleep(300)


@router.post("/backup")
def backup_now():
    try:
        return run_backup("manual")
    except Exception as e:
        raise HTTPException(500, f"Backup failed: {e}")


@router.get("/backups")
def list_backups():
    cfg = load_config()["backup"]
    d = Path(cfg["dir"]).expanduser()
    files = sorted(d.glob("cc-*.zip"), reverse=True) if d.exists() else []
    return {
        "dir": str(d),
        "last": kv_get("backup.last"),
        "backups": [{"name": f.name, "size": f.stat().st_size, "at": f.stat().st_mtime} for f in files[:100]],
    }


# ── startup ──────────────────────────────────────────────────────────────────

_started = False


def start() -> None:
    """Called once by server.py after mounting the router."""
    global _started
    if _started:
        return
    _started = True
    init_db()
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_index_worker, name="cc-vault-indexer", daemon=True).start()
    threading.Thread(target=_backup_scheduler, name="cc-backup", daemon=True).start()


# ── Agentic OS state for the phone (osName, compute mode, isolated threads) ──
#
# The desktop app mirrors its non-secret OS settings to os-state.json and pushes
# its per-agent conversation threads here, so the mobile companion shows the
# same Tony, the same compute mode and the same Booking / Coder / … tabs.

from fastapi import Body  # noqa: E402

os_router = APIRouter(prefix="/api/os", tags=["agentic-os"])
_THREADS_FILE = CC_DIR / "os-threads.json"
_THREADS_MAX = 2 * 1024 * 1024


@os_router.get("/state")
def os_state():
    p = CC_DIR / "os-state.json"
    if not p.exists():
        return {"osName": "Tony", "computeMode": "hybrid", "available": False}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"os-state.json unreadable: {_why(e)}")
    data["available"] = True
    return data


# ── The desktop's settings, read-only, for the phone's Settings screens ───────
# The Android app's Rust side has its own (loopback, keyless) providers.json/os.json, so its Settings
# showed the wrong endpoints and "no key" everywhere. This serves the DESKTOP's files instead, with
# secrets kept out: keys stay in the Windows credential store (only whether one EXISTS is reported,
# from credential names, never values) and MCP env values are masked.

APP_CFG_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "os.agentic.commandcenter"
_CRED_SERVICE = "agentic-os-command-center"


def _cred_names() -> set[str]:
    """Names (never values) of this app's Windows credentials, e.g. 'droplet@100.84.235.228:8000'."""
    if os.name != "nt":
        return set()
    import ctypes
    import ctypes.wintypes as wt

    class CREDENTIALW(ctypes.Structure):
        _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("TargetName", wt.LPWSTR), ("Comment", wt.LPWSTR),
                    ("LastWritten", wt.FILETIME), ("CredentialBlobSize", wt.DWORD), ("CredentialBlob", ctypes.c_void_p),
                    ("Persist", wt.DWORD), ("AttributeCount", wt.DWORD), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", wt.LPWSTR), ("UserName", wt.LPWSTR)]

    adv = ctypes.windll.advapi32
    count = wt.DWORD()
    creds = ctypes.POINTER(ctypes.POINTER(CREDENTIALW))()
    if not adv.CredEnumerateW(f"*.{_CRED_SERVICE}", 0, ctypes.byref(count), ctypes.byref(creds)):
        return set()
    try:
        suffix = f".{_CRED_SERVICE}"
        return {n[: -len(suffix)] for n in (creds[i].contents.TargetName for i in range(count.value)) if n and n.endswith(suffix)}
    finally:
        adv.CredFree(creds)


def _provider_host(base_url: str) -> str:
    """Same as dispatch.rs provider_host: host, plus ':port' when the URL names one."""
    try:
        u = urllib.parse.urlsplit(base_url)
        return f"{u.hostname}:{u.port}" if u.port else (u.hostname or "")
    except ValueError:
        return ""


def desktop_config_view(providers: dict, os_cfg: Optional[dict], cred_names: set[str]) -> dict:
    """Pure: the phone's view of the desktop's config (hasKey from credential names; env masked)."""
    out = []
    for p in providers.get("providers", []) or []:
        q = dict(p)
        q["hasKey"] = bool(q.get("needsKey")) and f"{q.get('id')}@{_provider_host(str(q.get('baseUrl') or ''))}" in cred_names
        q.setdefault("custom", False)
        out.append(q)
    os_view = json.loads(json.dumps(os_cfg)) if isinstance(os_cfg, dict) else None
    for m in (os_view or {}).get("mcps", []) or []:
        if isinstance(m.get("env"), dict):
            m["env"] = {k: "•••" for k in m["env"]}
    return {"providers": {"providers": out, "policy": providers.get("policy") or {}, "agentVoices": providers.get("agentVoices") or {}}, "os": os_view}


@os_router.get("/desktop-config")
def desktop_config():
    def load(name: str) -> Optional[dict]:
        try:
            return json.loads((APP_CFG_DIR / name).read_text(encoding="utf-8"))
        except Exception:
            return None

    return desktop_config_view(load("providers.json") or {}, load("os.json"), _cred_names())


@os_router.put("/gpu")
def os_gpu_put(request: Request, body: dict = Body(...)):
    """The desktop's GpuSlot mirror: {busy, holder, until (epoch s or ms)}. Localhost only."""
    require_loopback(request)
    if not isinstance(body.get("busy"), bool):
        raise HTTPException(400, "busy must be true or false")
    gpu_set(body["busy"], str(body.get("holder") or ""), body.get("until"))
    return gpu_state()


@os_router.get("/gpu")
def os_gpu_get():
    return gpu_state()


@os_router.get("/threads")
def os_threads():
    if not _THREADS_FILE.exists():
        return {"threads": {}, "updatedAt": 0}
    return json.loads(_THREADS_FILE.read_text(encoding="utf-8"))


@os_router.put("/threads")
def os_threads_put(body: dict = Body(...)):
    threads = body.get("threads")
    if not isinstance(threads, dict):
        raise HTTPException(400, "threads must be an object")
    # Merge by turn id (desktop and phone both push), newest 60 per thread.
    current = {}
    if _THREADS_FILE.exists():
        try:
            current = json.loads(_THREADS_FILE.read_text(encoding="utf-8")).get("threads", {})
        except Exception:
            current = {}
    if body.get("replace"):
        current = {}
    for name, turns in threads.items():
        if not isinstance(turns, list):
            continue
        merged = {t.get("id"): t for t in current.get(name, []) if isinstance(t, dict)}
        merged.update({t.get("id"): t for t in turns if isinstance(t, dict) and t.get("id")})
        current[name] = sorted(merged.values(), key=lambda t: t.get("at", 0))[-60:]
    threads = current
    raw = json.dumps({"threads": threads, "updatedAt": time.time()}, ensure_ascii=False)
    if len(raw.encode("utf-8")) > _THREADS_MAX:
        raise HTTPException(413, "threads too large")
    CC_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _THREADS_FILE.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(_THREADS_FILE)
    return {"ok": True}
