"""Language Hub — the phone's path (gateway) to the same local library and voice stack.

The desktop app talks to `<repo>/data/language-hub/library.db` through Rust
(`command center/src-tauri/src/commands/language_hub.rs`); the PWA / Mobile HUD reaches the SAME
file here. The DDL below is identical to Rust's `SCHEMA`. Self-contained: nothing here touches the
Command Center store, the vault or any RAG index, and no other module reads this file.

Voice, all local:
  * STT  — English → the configured STT (policy.stt): faster-whisper on the GPU (127.0.0.1:8177,
           stt/fw_server.py) when that is the pick. While :8177 is up but has no GPU model it
           forwards the turn to whisper.cpp :8178 itself (reported as backend "whispercpp"); when
           :8177 is down, or answers 503, the gateway uses :8178 directly and re-spawns :8177 in
           the background, with backoff.
           Plain json + the desktop's vocabulary prompt, with the same prompt-echo guard as
           voice.rs. WebSocket /stt/stream is the live version for English: the phone streams
           PCM16 while you speak and gets partial captions plus the final (see stt_stream).
           Any other language / auto-detect → a multilingual whisper-server sidecar on
           127.0.0.1:8179, started on first use and stopped by POST /release or after 3 idle
           minutes (zero idle overhead).
  * TTS  — the engine/voice picked in the Hub's Voice panel (settings table, shared with the
           desktop). The gateway speaks LOCAL engines only (Kokoro / XTTS): a cloud engine
           (ElevenLabs — its key lives in the desktop keychain) answers 422 ENGINE_DESKTOP_ONLY and
           the phone falls back. Kokoro with no voice picked uses one per language; a language it
           can't speak answers 422 UNSUPPORTED_LANG and the phone uses its own Web Speech voice.
  * LLM  — POST /llm: local LM Studio, JSON only, reasoning switched off per request (a thinking
           model otherwise burns the whole budget and returns no JSON). Backs off while the
           desktop holds the GPU, like /api/cc/llm/json.
"""
from __future__ import annotations

import asyncio
import atexit
import hmac
import io
import ipaddress
import json
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request, WebSocket
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect

BASE_DIR = Path(__file__).parent.resolve()
DB_PATH = Path(os.environ["LANG_HUB_DB"]).expanduser().resolve() if os.environ.get("LANG_HUB_DB") else BASE_DIR / "data" / "language-hub" / "library.db"
PROVIDERS_JSON = Path(os.environ.get("APPDATA", str(Path.home()))) / "os.agentic.commandcenter" / "providers.json"

CATEGORIES = ("public_capture", "my_translation", "lesson_vocab")
MASTERY = ("new", "learning", "mastered")
LEVELS = ("beginner", "intermediate", "conversational")
MAX_TEXT = 4000
MAX_NOTE = 500
MAX_AUDIO = 16 * 1024 * 1024
SIDECAR_PORT = 8179
SIDECAR_IDLE = 180.0
ML_MODELS = ("large-v3-turbo", "large-v3-turbo-q5_0", "large-v3-turbo-q8_0", "medium", "small", "small-q5_1", "base", "tiny")
KOKORO_VOICES = {"en": "af_heart", "es": "ef_dora", "fr": "ff_siwis", "it": "if_sara", "ja": "jf_alpha", "pt": "pf_dora", "hi": "hf_alpha", "zh": "zf_xiaobei"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS phrases(
  id TEXT PRIMARY KEY,
  timestamp REAL NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  phonetic_guide TEXT,
  context_note TEXT,
  category TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  mastery_status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS phrases_ts ON phrases(timestamp DESC);
CREATE TABLE IF NOT EXISTS tracks(
  lang TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  got INTEGER NOT NULL DEFAULT 0,
  again INTEGER NOT NULL DEFAULT 0,
  lessons INTEGER NOT NULL DEFAULT 0,
  updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

router = APIRouter(prefix="/api/cc/lang", tags=["language-hub"])
_lock = threading.Lock()
_LANG_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$")
_KEY_RE = re.compile(r"^[a-z0-9_.-]{1,40}$")


def valid_lang(s: str, allow_auto: bool = False) -> bool:
    return (allow_auto and s == "auto") or bool(_LANG_RE.match(s or ""))


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _entry(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["favorite"] = bool(d["favorite"])
    return d


def _clip(v: Any, n: int) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()[:n]
    return s or None


# ── library ──────────────────────────────────────────────────────────────────

@router.get("/entries")
def list_entries():
    with db() as c:
        return {"entries": [_entry(r) for r in c.execute("SELECT * FROM phrases ORDER BY timestamp DESC LIMIT 10000")]}


@router.post("/entries")
def save_entry(e: dict = Body(...)):
    src_l, dst_l = str(e.get("source_lang", "")), str(e.get("target_lang", ""))
    if not valid_lang(src_l, True) or not valid_lang(dst_l):
        raise HTTPException(400, "bad language code")
    cat = e.get("category")
    if cat not in CATEGORIES:
        raise HTTPException(400, "bad category")
    mastery = e.get("mastery_status") or "new"
    if mastery not in MASTERY:
        raise HTTPException(400, "bad mastery_status")
    src, dst = str(e.get("source_text", "")).strip(), str(e.get("translated_text", "")).strip()
    if not src or not dst or len(src) > MAX_TEXT or len(dst) > MAX_TEXT:
        raise HTTPException(400, f"source_text and translated_text must be 1–{MAX_TEXT} characters")
    row = {
        "id": f"lh-{uuid.uuid4().hex[:20]}",
        "timestamp": time.time() * 1000,
        "source_lang": src_l,
        "target_lang": dst_l,
        "source_text": src,
        "translated_text": dst,
        "phonetic_guide": _clip(e.get("phonetic_guide"), MAX_TEXT),
        "context_note": _clip(e.get("context_note"), MAX_NOTE),
        "category": cat,
        "favorite": 1 if e.get("favorite") else 0,
        "mastery_status": mastery,
    }
    with _lock, db() as c:
        c.execute(f"INSERT INTO phrases({','.join(row)}) VALUES({','.join('?' * len(row))})", list(row.values()))
    return {**row, "favorite": bool(row["favorite"])}


@router.patch("/entries/{eid}")
def update_entry(eid: str, patch: dict = Body(...)):
    with _lock, db() as c:
        r = c.execute("SELECT * FROM phrases WHERE id=?", (eid,)).fetchone()
        if not r:
            raise HTTPException(404, "Not found")
        e = _entry(r)
        if "context_note" in patch:
            e["context_note"] = _clip(patch["context_note"], MAX_NOTE)
        if "favorite" in patch:
            e["favorite"] = bool(patch["favorite"])
        if "mastery_status" in patch:
            if patch["mastery_status"] not in MASTERY:
                raise HTTPException(400, "bad mastery_status")
            e["mastery_status"] = patch["mastery_status"]
        if "translated_text" in patch:
            t = str(patch["translated_text"] or "").strip()
            if not t or len(t) > MAX_TEXT:
                raise HTTPException(400, "bad translated_text")
            e["translated_text"] = t
        if "phonetic_guide" in patch:
            e["phonetic_guide"] = _clip(patch["phonetic_guide"], MAX_TEXT)
        c.execute(
            "UPDATE phrases SET context_note=?, favorite=?, mastery_status=?, translated_text=?, phonetic_guide=? WHERE id=?",
            (e["context_note"], int(e["favorite"]), e["mastery_status"], e["translated_text"], e["phonetic_guide"], eid),
        )
    return e


@router.post("/entries/delete")
def delete_entries(body: dict = Body(...)):
    ids = body.get("ids") or []
    if not isinstance(ids, list) or len(ids) > 10_000:
        raise HTTPException(400, "bad ids")
    with _lock, db() as c:
        n = sum(c.execute("DELETE FROM phrases WHERE id=?", (str(i),)).rowcount for i in ids)
    return {"deleted": n}


@router.get("/tracks")
def list_tracks():
    with db() as c:
        return {"tracks": [dict(r) for r in c.execute("SELECT lang,level,got,again,lessons,updated FROM tracks ORDER BY updated DESC")]}


@router.put("/tracks/{lang}")
def save_track(lang: str, t: dict = Body(...)):
    level = t.get("level")
    if not valid_lang(lang) or level not in LEVELS:
        raise HTTPException(400, "bad track")
    clamp = lambda v: max(0, min(1_000_000, int(v or 0)))  # noqa: E731
    row = {"lang": lang, "level": level, "got": clamp(t.get("got")), "again": clamp(t.get("again")), "lessons": clamp(t.get("lessons")), "updated": time.time() * 1000}
    with _lock, db() as c:
        c.execute(
            "INSERT INTO tracks(lang,level,got,again,lessons,updated) VALUES(:lang,:level,:got,:again,:lessons,:updated) "
            "ON CONFLICT(lang) DO UPDATE SET level=:level,got=:got,again=:again,lessons=:lessons,updated=:updated",
            row,
        )
    return row


# ── settings (e.g. "voice"; shared with the desktop through the same file) ────

@router.get("/settings/{key}")
def get_setting(key: str):
    if not _KEY_RE.match(key) or ".." in key:
        raise HTTPException(400, "bad setting key")
    with db() as c:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    try:
        return {"key": key, "value": json.loads(r["value"]) if r else None}
    except ValueError:
        return {"key": key, "value": None}


@router.put("/settings/{key}")
def put_setting(key: str, body: dict = Body(...)):
    if not _KEY_RE.match(key) or ".." in key:
        raise HTTPException(400, "bad setting key")
    raw = json.dumps(body.get("value"))
    if len(raw) > 64 * 1024:
        raise HTTPException(413, "setting too large")
    with _lock, db() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, raw))
    return {"ok": True}


# ── providers (read from the desktop app's providers.json; local engines only) ─

def _providers() -> dict:
    try:
        return json.loads(PROVIDERS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _stt_main() -> dict:
    cfg = _providers()
    want = (cfg.get("policy") or {}).get("stt")
    for p in cfg.get("providers", []):
        if p.get("kind") == "stt" and p.get("id") == want and not p.get("needsKey"):
            return p
    return {"baseUrl": "http://127.0.0.1:8178/v1", "model": "base.en", "engine": "whispercpp", "modelsDir": None}


def _kokoro() -> Optional[dict]:
    for p in _providers().get("providers", []):
        if p.get("kind") == "tts" and p.get("engine") == "kokoro":
            return p
    return None


def _tts_providers() -> list[dict]:
    return [p for p in _providers().get("providers", []) if p.get("kind") == "tts"]


@router.get("/voice/engines")
def voice_engines():
    """TTS providers for the Voice panel (no keys). `local: false` = desktop only."""
    return {
        "engines": [
            {"id": p.get("id"), "label": p.get("label") or p.get("id"), "engine": p.get("engine") or "kokoro", "local": p.get("engine") != "elevenlabs", "model": p.get("model") or "", "voice": p.get("voice")}
            for p in _tts_providers()
        ]
    }


@router.get("/voice/voices")
def voice_list(engine: str = Query(..., max_length=64)):
    """Voices of a LOCAL provider (Kokoro / XTTS server list). Cloud engines: desktop only."""
    p = next((x for x in _tts_providers() if x.get("id") == engine), None)
    if not p:
        raise HTTPException(404, "no such TTS provider")
    if p.get("engine") == "elevenlabs":
        raise HTTPException(422, "ENGINE_DESKTOP_ONLY")
    base = p["baseUrl"].rstrip("/")
    url = base.rsplit("/v1", 1)[0] + "/speakers_list" if p.get("engine") == "xtts" else f"{base}/audio/voices"
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise HTTPException(502, f"voice list unavailable: {getattr(e, 'reason', e)}")
    items = data.get("voices", data) if isinstance(data, dict) else data
    ids = [i if isinstance(i, str) else i.get("id") or i.get("name") for i in items or []]
    return {"voices": [{"id": i, "label": None} for i in ids if i]}


def pick_ml_model(d: Path) -> Optional[Path]:
    for m in ML_MODELS:
        p = d / f"ggml-{m}.bin"
        if p.is_file():
            return p
    try:
        others = sorted(p for p in d.iterdir() if p.name.startswith("ggml-") and p.name.endswith(".bin") and ".en" not in p.name and "vad" not in p.name and "silero" not in p.name)
    except OSError:
        return None
    return others[0] if others else None


def _models_dir() -> Optional[Path]:
    for p in _providers().get("providers", []):
        if p.get("kind") == "stt" and p.get("engine") == "whispercpp" and p.get("modelsDir"):
            return Path(p["modelsDir"])
    return None


# ── multilingual sidecar ─────────────────────────────────────────────────────

_side_lock = threading.Lock()
_side: dict[str, Any] = {"proc": None, "last": 0.0}


def _port_open(port: int, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _stop_sidecar() -> bool:
    proc = _side.get("proc")
    _side["proc"] = None
    if proc and proc.poll() is None:
        proc.kill()
        try:
            proc.wait(5)
        except Exception:
            pass
        return True
    return False


atexit.register(_stop_sidecar)


def _reaper() -> None:
    while True:
        time.sleep(30)
        with _side_lock:
            if not _side.get("proc"):
                return
            if time.time() - _side["last"] > SIDECAR_IDLE:
                _stop_sidecar()
                return


def ensure_sidecar() -> str:
    url = f"http://127.0.0.1:{SIDECAR_PORT}/v1"
    with _side_lock:
        _side["last"] = time.time()
        if _port_open(SIDECAR_PORT):
            return url
        d = _models_dir()
        if not d:
            raise HTTPException(503, "LANG_STT_NO_MULTILINGUAL: no whisper.cpp modelsDir configured")
        model = pick_ml_model(d)
        if not model:
            raise HTTPException(503, f"LANG_STT_NO_MULTILINGUAL: put a multilingual model (e.g. ggml-small.bin) in {d}")
        exe = d.parent / "bin" / ("whisper-server.exe" if os.name == "nt" else "whisper-server")
        if not exe.is_file():
            raise HTTPException(503, "LANG_STT_NO_MULTILINGUAL: whisper-server not found next to the models folder")
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        _side["proc"] = subprocess.Popen(
            [str(exe), "-m", str(model), "--host", "127.0.0.1", "--port", str(SIDECAR_PORT), "--inference-path", "/v1/audio/transcriptions", "-t", "6", "-l", "auto"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags,
        )
        t0 = time.time()
        while not _port_open(SIDECAR_PORT):
            if _side["proc"].poll() is not None or time.time() - t0 > 90:
                _stop_sidecar()
                raise HTTPException(503, "whisper sidecar failed to start")
            time.sleep(0.4)
        threading.Thread(target=_reaper, daemon=True, name="lang-hub-reaper").start()
        return url


def _multipart(fields: dict[str, str], file_bytes: bytes) -> tuple[bytes, str]:
    boundary = f"----langhub{uuid.uuid4().hex}"
    out = bytearray()
    for k, v in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
    out += file_bytes + f"\r\n--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


# ── voice endpoints ──────────────────────────────────────────────────────────

@router.post("/stt")
async def stt(request: Request, lang: str = Query("auto")):
    if not valid_lang(lang, True):
        raise HTTPException(400, "bad language code")
    audio = await request.body()
    if len(audio) < 1024 or len(audio) > MAX_AUDIO:
        raise HTTPException(400, "audio too short or too long")
    # Whisper (up to 180 s) and a cold sidecar start (up to 90 s of polling) block: run them on a
    # worker thread. On the event loop they stalled every other gateway request (:8080 and :8443
    # share one loop), the phone's inbox polls included.
    return await run_in_threadpool(_transcribe, audio, lang)


# ── English STT: faster-whisper :8177 first, whisper.cpp :8178 as the fallback ──

# voice.rs DEFAULT_STT_PROMPT (command center/src-tauri/src/commands/dispatch.rs): the vocabulary the
# desktop biases Whisper with. A provider's own `sttPrompt` wins ("" = send none). "Nic" is in it so
# Whisper stops writing "Nick" (4 of turbo's 9 word errors in the benchmark).
DEFAULT_STT_PROMPT = ("Tony, Nic, Gabagool mode. Take it easy. Cut it. Whoa. Madone, aspetta. Prompter, Designer, Coder, Booking Desk "
                      "and Librarian. Bilmuri, Erra. WhatsApp, Gmail, Spotify, Tauri, Kokoro, Serena, checkpoint.")
WHISPERCPP_FALLBACK = {"id": "whisper", "baseUrl": "http://127.0.0.1:8178/v1", "model": "base.en", "engine": "whispercpp"}
STT_JUNK = ("[blank_audio]", "(silence)", "[ silence ]", "[silence]")
FW_PYTHON = Path(os.environ.get("STT_FW_PYTHON", r"C:\ai-stt\.venv\Scripts\python.exe"))
FW_SCRIPT = BASE_DIR / "stt" / "fw_server.py"
FW_DOWN_SECS = 10.0  # after a failure, go straight to whisper.cpp for this long
FW_BACKOFF = (30.0, 600.0)  # re-spawn backoff: first wait, cap (doubles each time)
_fw_lock = threading.Lock()
_fw: dict[str, Any] = {"down_until": 0.0, "next_spawn": 0.0, "backoff": 0.0, "spawns": 0}


def effective_stt_prompt(p: dict) -> Optional[str]:
    """voice.rs effective_stt_prompt: the provider's `sttPrompt` (blank = none), else the default."""
    s = p.get("sttPrompt")
    s = DEFAULT_STT_PROMPT if s is None else str(s)
    return s.strip() or None


def _prompt_words(s: str) -> list[str]:
    words, cur = [], []
    for c in s + " ":
        if c.isalnum() or c == "'":
            cur.append(c)
        elif cur:
            w = "".join(cur).replace("'", "").lower()
            if w:
                words.append(w)
            cur = []
    return words


REFLEX_PHRASES = (("take", "it", "easy"), ("take", "it", "ease"), ("cut", "it", "out"), ("cut", "it"), ("cut", "that"), ("whoa",), ("madone",),
                  ("aspetta",), ("hey",), ("yo",), ("tony",), ("ok",), ("okay",), ("man",))


def _only_reflex_phrases(words: list[str]) -> bool:
    i = 0
    while i < len(words):
        for p in REFLEX_PHRASES:
            if tuple(words[i:i + len(p)]) == p:
                i += len(p)
                break
        else:
            return False
    return True


def echoes_prompt(text: str, prompt: str) -> bool:
    """voice.rs echoes_prompt: True when the transcript is MOSTLY the prompt read back — words in
    runs of 4+ consecutive prompt words (prompt order, case/punctuation-insensitive) are >= 70% of
    it. A line made only of reflex phrases ("Take it easy, cut it") always passes. Pure."""
    run = 4
    t, p = _prompt_words(text), _prompt_words(prompt)
    if len(t) < run or len(p) < run or _only_reflex_phrases(t):
        return False
    grams = {tuple(p[i:i + run]) for i in range(len(p) - run + 1)}
    covered = [False] * len(t)
    for i in range(len(t) - run + 1):
        if tuple(t[i:i + run]) in grams:
            covered[i:i + run] = [True] * run
    return sum(covered) * 10 >= len(t) * 7


def _stt_chain() -> list[dict]:
    """English endpoints in order: the configured STT; when that is faster-whisper, whisper.cpp
    (the "whisper" provider, or :8178) behind it."""
    main = _stt_main()
    chain = [main]
    if main.get("engine") == "fasterwhisper":
        wc = next((p for p in _providers().get("providers", []) if p.get("kind") == "stt" and p.get("engine") == "whispercpp" and not p.get("needsKey")), None)
        chain.append(wc or WHISPERCPP_FALLBACK)
    return chain


def _local_port(base: str) -> Optional[int]:
    from urllib.parse import urlparse

    u = urlparse(base)
    return (u.port or 80) if u.hostname in ("127.0.0.1", "localhost") else None


def _spawn_fw(p: dict) -> bool:
    """Start stt/fw_server.py detached (it outlives the gateway), at most once per backoff window,
    only for a local endpoint whose port is closed. The request that noticed keeps using whisper.cpp."""
    port = _local_port(p.get("baseUrl") or "")
    with _fw_lock:
        now = time.time()
        if port is None or now < _fw["next_spawn"] or _port_open(port) or not FW_PYTHON.is_file() or not FW_SCRIPT.is_file():
            return False
        _fw["backoff"] = min(FW_BACKOFF[1], _fw["backoff"] * 2 if _fw["backoff"] else FW_BACKOFF[0])
        _fw["next_spawn"] = now + _fw["backoff"]
        args = [str(FW_PYTHON), str(FW_SCRIPT), "--port", str(port)]
        # A plain name starting with a letter or digit: argparse reads `--model -h` as an option.
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", str(p.get("model") or "")):
            args += ["--model", p["model"]]
        detached = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        for flags in ((detached | 0x01000000, detached) if os.name == "nt" else (0,)):  # + CREATE_BREAKAWAY_FROM_JOB when allowed
            try:
                subprocess.Popen(args, cwd=str(FW_SCRIPT.parent), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=flags, close_fds=True)
                _fw["spawns"] += 1
                return True
            except OSError:
                continue
        return False


def _post_stt(base: str, fields: dict[str, str], audio: bytes, timeout: float = 180) -> dict:
    """The reply JSON. When fw_server answered through its whisper.cpp fallback (X-STT-Backend:
    whispercpp), the reply carries "_backend": "whispercpp"."""
    body, ctype = _multipart(fields, audio)
    req = urllib.request.Request(f"{base.rstrip('/')}/audio/transcriptions", data=body, headers={"Content-Type": ctype}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode("utf-8"))
        if isinstance(out, dict) and r.headers.get("X-STT-Backend") == "whispercpp":
            out["_backend"] = "whispercpp"
        return out


def _transcribe_en(audio: bytes) -> tuple[dict, str, Optional[str]]:
    """-> (reply, backend, prompt sent). faster-whisper when it answers; whisper.cpp otherwise."""
    chain = _stt_chain()
    prompt = effective_stt_prompt(chain[0])
    fields = {"response_format": "json", "temperature": "0", "language": "en"}
    if prompt:
        fields["prompt"] = prompt
    last: Optional[BaseException] = None
    for i, p in enumerate(chain):
        f = {"model": p.get("model") or "whisper-1", **fields}
        if p.get("engine") == "fasterwhisper" and i < len(chain) - 1:
            # A refused connect to a closed localhost port takes ~2 s on Windows (SYN retries): look
            # at the port first (an open one answers in < 1 ms).
            port = _local_port(p.get("baseUrl") or "")
            if time.time() < _fw["down_until"]:
                _spawn_fw(p)
                continue
            if port is not None and not _port_open(port, 0.1):
                _fw["down_until"] = time.time() + FW_DOWN_SECS
                _spawn_fw(p)
                continue
            try:
                out = _post_stt(p["baseUrl"], f, audio)
                _fw.update(down_until=0.0, backoff=0.0, next_spawn=0.0)
                return out, out.pop("_backend", None) or "faster-whisper", prompt
            except urllib.error.HTTPError as e:  # 503 = up but loading / no GPU: fall back, no re-spawn
                last = e
                if e.code >= 500:  # a 4xx is about this clip, not the server
                    _fw["down_until"] = time.time() + FW_DOWN_SECS
            except (urllib.error.URLError, OSError, ValueError) as e:
                last = e
                _fw["down_until"] = time.time() + FW_DOWN_SECS
                _spawn_fw(p)
            continue
        try:
            return _post_stt(p["baseUrl"], f, audio), "faster-whisper" if p.get("engine") == "fasterwhisper" else "whispercpp", prompt
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = e
    raise HTTPException(502, f"Whisper unavailable: {getattr(last, 'reason', last)}")


def _transcribe(audio: bytes, lang: str) -> dict:
    """The blocking half of POST /stt: pick the Whisper endpoint and transcribe `audio`."""
    prompt = None
    if lang == "en":
        out, backend, prompt = _transcribe_en(audio)
        engine = "whisper"
    else:
        base, engine, backend = ensure_sidecar(), "whisper-multilingual", "whispercpp"
        body, ctype = _multipart({"model": "whisper-1", "response_format": "verbose_json", "temperature": "0", "language": lang.split("-")[0]}, audio)
        req = urllib.request.Request(f"{base.rstrip('/')}/audio/transcriptions", data=body, headers={"Content-Type": ctype}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                out = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise HTTPException(502, f"Whisper unavailable: {getattr(e, 'reason', e)}")
        finally:
            _side["last"] = time.time()
    text = _clean_en(str(out.get("text") or ""), prompt)
    language = out.get("language") or (None if lang == "auto" else lang)
    return {"text": text, "language": language, "engine": engine, "backend": backend}


def _clean_en(text: str, prompt: Optional[str]) -> str:
    """Whisper's silence markers and a read-back vocabulary prompt become "" (voice.rs's guards)."""
    t = text.strip()
    return "" if t.lower() in STT_JUNK or (prompt and echoes_prompt(t, prompt)) else t


# ── English STT, live: WebSocket /stt/stream (the phone) ──────────────────────
#
# The phone streams PCM16 16 kHz mono while you speak instead of uploading one WAV when you stop
# (over NetBird the upload is the slow part of a turn; here the audio is already in when you stop):
#   phone   -> {"type":"start","lang":"en","token","partials":bool,"partial_ms":600}, binary frames,
#              {"type":"config","partials":bool} (paused while Tony's reply streams), {"type":"end"}
#              or {"type":"cancel"}
#   gateway -> {"type":"ready","partials","mode"}, {"type":"partial","partial","stable"} (LocalAgreement-2),
#              {"type":"final","final","backend","mode"}; {"type":"error","error"} + a close on any
#              failure, which the phone answers with today's single upload (POST /stt).
# "relay" mode: fw_server's own WebSocket /v1/stream does the work. When it has none (its venv
# lacks the `websockets` package: the upgrade gets a 404) or refuses, "http" mode runs the same
# session over loopback POSTs: partial=1 every partial_ms of new audio (only while its /health says
# cuda), and the final through _transcribe: the exact upload path (json + prompt + echo guard,
# whisper.cpp fallback, re-spawn), so the text is the same as a single upload's.
# Auth: BaseHTTPMiddleware (server.ZeroTrustMiddleware) never sees a WebSocket, so this route applies
# the same rule itself: no tunnel, loopback or the NetBird mesh only, and off loopback the gateway
# token (sent in the start message, never in the URL) while the network lock is on.

STREAM_MAX_BYTES = MAX_AUDIO - 44  # the upload's cap, as raw PCM16
STREAM_PARTIAL_BYTES = (16000, 30 * 32000)  # partials on 0.5-30 s of audio only
STREAM_PARTIAL_MS = (300, 3000, 600)  # min, max, default spacing (ms of new audio)
STREAM_START_S = 5.0
STREAM_IDLE_S = 30.0
STREAM_UP_FINAL_S = 4.0  # wait this long for fw_server's final, then decide it here over POST
STREAM_PARTIAL_TIMEOUT = 3.0
STREAM_NO_WS_SECS = 600.0  # fw_server without a WebSocket: don't knock again for this long
STREAM_HEALTH_TTL = 30.0
_stream_state: dict[str, Any] = {"no_ws_until": 0.0, "health": (0.0, "", False)}
GATEWAY_TOKEN_FILE = BASE_DIR / "data" / "command-center" / "gateway.token"  # server.ZeroTrustMiddleware's
_MESH = ipaddress.ip_network("100.64.0.0/10")
_LOCAL_ORIGIN_RE = re.compile(r"^(tauri://localhost|https?://tauri\.localhost|https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?)$")


def _norm_word(w: str) -> str:
    return re.sub(r"^[^\w']+|[^\w']+$", "", w.lower())


class LocalAgreement:
    """LocalAgreement-2 (fw_server.LocalAgreement, stt-partials.ts): the words the last two
    whole-clip hypotheses agree on from the start are committed (stable); the rest of the newest
    one is tentative. When Whisper revises a committed word, the newest hypothesis is shown whole
    and the committed words shrink to the prefix the two still share (never a splice of old words
    with the new tail). An empty hypothesis changes nothing. Pure."""

    def __init__(self) -> None:
        self.prev: list[str] = []
        self.committed: list[str] = []

    def push(self, text: str) -> tuple[str, str]:
        cur = text.split()
        if cur:
            c = len(self.committed)
            if len(cur) >= c and all(_norm_word(a) == _norm_word(b) for a, b in zip(self.committed, cur)):
                n = c
                while n < min(len(self.prev), len(cur)) and _norm_word(self.prev[n]) == _norm_word(cur[n]):
                    n += 1
                self.committed += cur[c:n]
            else:  # a revision: keep only the common prefix, spelled as the newest (shown whole)
                k = 0
                while k < min(c, len(cur)) and _norm_word(self.committed[k]) == _norm_word(cur[k]):
                    k += 1
                self.committed = cur[:k]
            self.prev = cur
        return " ".join(self.committed + cur[len(self.committed):]), " ".join(self.committed)


def _pcm_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)
    return buf.getvalue()


def _ws_peer(ws: Any) -> Optional[str]:
    """"loopback" (the desktop), "mesh" (the phone over NetBird) or None (refused): the rule of
    server.ZeroTrustMiddleware. Forwarding headers mean a tunnel, i.e. the public internet."""
    if any(h in ws.headers for h in ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip")):
        return None
    host = (ws.client.host if ws.client else "") or ""
    if host in ("127.0.0.1", "::1", "localhost") or host.startswith("127."):
        return "loopback"
    try:
        return "mesh" if ipaddress.ip_address(host) in _MESH else None
    except ValueError:
        return None


def _ws_token_ok(ws: Any, sent: Any) -> bool:
    """The gateway token, while the network lock has written it: `Authorization: Bearer` (a native
    client) or the start message's `token` (a WebView can't set WebSocket headers)."""
    if not GATEWAY_TOKEN_FILE.exists():
        return True
    try:
        token = GATEWAY_TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    hdr = ws.headers.get("authorization", "")
    cand = hdr[7:].strip() if hdr.lower().startswith("bearer ") else (sent if isinstance(sent, str) else "")
    if token and cand and hmac.compare_digest(cand.encode(), token.encode()):
        return True
    # Section pass: a per-device token (device_registry) works here too.
    import device_registry
    dev = device_registry.match(cand) if cand else None
    if dev is None:
        return False
    device_registry.seen(dev["id"], ws.client.host if getattr(ws, "client", None) else "", ws.headers.get("user-agent", ""))
    return True


def _ws_json(msg: dict) -> Optional[dict]:
    try:
        obj = json.loads(msg.get("text") or "")
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _fw_cuda(p: dict) -> bool:
    """fw_server's /health says it decodes on the GPU (partials are pointless on a CPU). Cached:
    its /health asks nvidia-smi."""
    base = (p.get("baseUrl") or "").rstrip("/")
    at, b, ok = _stream_state["health"]
    if b == base and time.time() - at < STREAM_HEALTH_TTL:
        return ok
    ok = False
    try:
        with urllib.request.urlopen(f"{base.rsplit('/v1', 1)[0]}/health", timeout=1.5) as r:
            h = json.loads(r.read().decode("utf-8"))
        ok = bool(isinstance(h, dict) and h.get("ready") and h.get("device") == "cuda")
    except (urllib.error.URLError, OSError, ValueError):
        pass
    _stream_state["health"] = (time.time(), base, ok)
    return ok


class _PhoneStream:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.lock = asyncio.Lock()
        self.buf = bytearray()
        self.session = f"gw-{uuid.uuid4().hex[:12]}"
        self.la = LocalAgreement()
        self.main: dict = {}
        self.prompt: Optional[str] = None
        self.every = STREAM_PARTIAL_MS[2]
        self.gpu = False
        self.partials = False
        self.last = 0
        self.task: Optional[asyncio.Task] = None
        self.done = False
        self.up: Any = None  # fw_server's WebSocket (relay mode)
        self.reader: Optional[asyncio.Task] = None
        self.final: Optional[asyncio.Future] = None

    async def send(self, obj: dict) -> None:
        async with self.lock:
            await self.ws.send_text(json.dumps(obj))

    async def fail(self, msg: str, code: int = 1011) -> None:
        try:
            await self.send({"type": "error", "error": msg})
            await self.ws.close(code=code)
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def caption(self, shown: str, stable: str) -> None:
        if self.done or not self.partials or not shown or _clean_en(shown, self.prompt) == "":
            return
        try:
            await self.send({"type": "partial", "partial": shown, "stable": stable})
        except (WebSocketDisconnect, RuntimeError):
            pass

    # -- relay: fw_server /v1/stream --
    async def open_upstream(self, port: int, want: bool) -> Optional[dict]:
        if time.time() < _stream_state["no_ws_until"]:
            return None
        try:
            from websockets.asyncio.client import connect
            from websockets.exceptions import InvalidHandshake
        except ImportError:
            return None
        try:
            up = await connect(f"ws://127.0.0.1:{port}/v1/stream", open_timeout=1.5, close_timeout=1.0, max_size=2 ** 20, compression=None)
        except InvalidHandshake:  # it answered, but not as a WebSocket (uvicorn without a WS library: 404)
            _stream_state["no_ws_until"] = time.time() + STREAM_NO_WS_SECS
            return None
        except Exception:  # noqa: BLE001 — refused, timed out: try again next stream
            return None
        try:
            await up.send(json.dumps({"type": "start", "language": "en", "prompt": self.prompt or "", "partials": want,
                                      "partial_ms": self.every, "model": str(self.main.get("model") or "")}))
            ready = json.loads(await asyncio.wait_for(up.recv(), 2.0))
        except Exception:  # noqa: BLE001
            ready = None
        if not isinstance(ready, dict) or ready.get("type") != "ready":
            await self.drop_upstream(up)
            return None
        self.up = up
        self.final = asyncio.get_running_loop().create_future()
        self.reader = asyncio.create_task(self.read_upstream())
        return ready

    async def read_upstream(self) -> None:
        try:
            async for raw in self.up:
                m = json.loads(raw) if isinstance(raw, str) else None
                kind = m.get("type") if isinstance(m, dict) else None
                if kind == "partial":
                    await self.caption(str(m.get("partial") or ""), str(m.get("stable") or ""))
                elif kind in ("final", "error"):
                    if not self.final.done():
                        self.final.set_result(m)
                    return
        except Exception:  # noqa: BLE001 — upstream gone: the final is decided over POST
            pass
        finally:
            if self.final is not None and not self.final.done():
                self.final.set_result({"type": "error", "error": "upstream closed"})

    async def drop_upstream(self, up: Any = None) -> None:
        up = up or self.up
        if up is self.up:
            self.up = None
        if up is not None:
            try:
                await up.close()
            except Exception:  # noqa: BLE001
                pass

    # -- http: loopback POSTs --
    def maybe_partial(self) -> None:
        n = len(self.buf)
        if not self.partials or self.up is not None or (self.task is not None and not self.task.done()):
            return
        if n - self.last < self.every * 32 or not STREAM_PARTIAL_BYTES[0] <= n <= STREAM_PARTIAL_BYTES[1]:
            return
        self.last = n
        self.task = asyncio.create_task(self.http_partial(_pcm_wav(bytes(self.buf))))

    async def http_partial(self, wav: bytes) -> None:
        f = {"model": self.main.get("model") or "whisper-1", "response_format": "json", "temperature": "0", "language": "en",
             "partial": "1", "session": self.session}
        if self.prompt:
            f["prompt"] = self.prompt
        try:
            out = await run_in_threadpool(_post_stt, self.main["baseUrl"], f, wav, STREAM_PARTIAL_TIMEOUT)
        except Exception:  # noqa: BLE001 — a caption that fails is skipped
            return
        text = str(out.get("text") or "").strip() if isinstance(out, dict) else ""
        if self.done or out.get("stale") or not text or _clean_en(text, self.prompt) == "":
            return
        await self.caption(*self.la.push(text))

    async def run(self, peer: str) -> None:
        try:
            first = await asyncio.wait_for(self.ws.receive(), STREAM_START_S)
        except asyncio.TimeoutError:
            return await self.fail("no start message", 1008)
        start = _ws_json(first) if first.get("type") == "websocket.receive" else None
        if not start or start.get("type") != "start":
            return await self.fail("expected a start message", 1008)
        if peer != "loopback" and not _ws_token_ok(self.ws, start.get("token")):
            return await self.fail("Gateway token required (network lock is on).", 4401)
        if str(start.get("lang") or "en").lower().split("-")[0] != "en":
            return await self.fail("only English streams", 1003)
        main = _stt_main()
        port = _local_port(main.get("baseUrl") or "")
        # Streams need faster-whisper up; anything else is the upload's job (its fallback chain).
        if main.get("engine") != "fasterwhisper" or port is None or time.time() < _fw["down_until"] or not await run_in_threadpool(_port_open, port, 0.1):
            return await self.fail("unavailable", 1013)
        self.main, self.prompt = main, effective_stt_prompt(main)
        want = start.get("partials") is not False
        try:
            every = int(start.get("partial_ms") or STREAM_PARTIAL_MS[2])
        except (TypeError, ValueError):
            every = STREAM_PARTIAL_MS[2]
        self.every = min(STREAM_PARTIAL_MS[1], max(STREAM_PARTIAL_MS[0], every))
        ready = await self.open_upstream(port, want)
        mode = "relay" if ready else "http"
        # Known even when the phone starts with partials paused, so a later config can resume them.
        self.gpu = ready.get("device") == "cuda" if ready else await run_in_threadpool(_fw_cuda, main)
        self.partials = want and self.gpu
        try:
            await self.send({"type": "ready", "partials": self.partials, "mode": mode})
            if not await self.receive_audio():
                return
            reply = await self.decide_final(mode)
            if reply is None:
                return
            await self.send(reply)
            await self.ws.close(code=1000)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            self.done = True
            if self.reader is not None:
                self.reader.cancel()
            await self.drop_upstream()

    async def receive_audio(self) -> bool:
        """Frames and controls until "end" (True); False when the stream ended otherwise."""
        while True:
            try:
                msg = await asyncio.wait_for(self.ws.receive(), STREAM_IDLE_S)
            except asyncio.TimeoutError:
                await self.fail("idle", 1008)
                return False
            if msg.get("type") == "websocket.disconnect":
                return False
            data = msg.get("bytes")
            if data is not None:
                if len(data) % 2 or len(self.buf) + len(data) > STREAM_MAX_BYTES:
                    await self.fail("audio too long or not PCM16", 1009)
                    return False
                self.buf += data
                if self.up is not None:
                    try:
                        await self.up.send(data)
                    except Exception:  # noqa: BLE001 — carry on over POSTs; the buffer has everything
                        await self.drop_upstream()
                else:
                    self.maybe_partial()
                continue
            ctl = _ws_json(msg) or {}
            kind = ctl.get("type")
            if kind == "config":
                self.partials = ctl.get("partials") is True and self.gpu
                if self.up is not None:
                    try:
                        await self.up.send(json.dumps({"type": "config", "partials": self.partials}))
                    except Exception:  # noqa: BLE001
                        await self.drop_upstream()
            elif kind == "cancel":
                self.done = True
                await self.ws.close(code=1000)
                return False
            elif kind == "end":
                return True
            else:
                await self.fail("unknown message", 1003)
                return False

    async def decide_final(self, mode: str) -> Optional[dict]:
        self.done = True
        pcm = bytes(self.buf)
        if len(pcm) < 3200:  # < 0.1 s: nothing was said
            return {"type": "final", "final": "", "backend": None, "mode": mode}
        if self.up is not None:
            try:
                await self.up.send(json.dumps({"type": "end"}))
                m = await asyncio.wait_for(asyncio.shield(self.final), STREAM_UP_FINAL_S)
            except Exception:  # noqa: BLE001 — slow / gone: decided over POST below
                m = None
            if isinstance(m, dict) and m.get("type") == "final":
                return {"type": "final", "final": _clean_en(str(m.get("final") or ""), self.prompt), "backend": m.get("backend") or "faster-whisper", "mode": "relay"}
        try:
            out = await run_in_threadpool(_transcribe, _pcm_wav(pcm), "en")
        except HTTPException as e:
            await self.fail(str(e.detail))
            return None
        return {"type": "final", "final": out["text"], "backend": out["backend"], "mode": "http"}


@router.websocket("/stt/stream")
async def stt_stream(ws: WebSocket):
    """Live English STT for the phone (see the block comment above)."""
    peer = _ws_peer(ws)
    origin = ws.headers.get("origin")
    if peer is None or (peer == "loopback" and origin and not _LOCAL_ORIGIN_RE.match(origin)):
        await ws.close(code=4403)
        return
    await ws.accept()
    await _PhoneStream(ws).run(peer)


# ── ElevenLabs for the phone (the key never leaves the PC) ────────────────────
# The Android app can't read the PC's key, so the gateway makes the ElevenLabs call for it with the
# same key resolution as the desktop (elevenlabs.rs): ELEVENLABS_API_KEY, then the repo .env. The
# outbound kill switch (mirrored by the desktop into os-state.json) blocks it; unreadable = blocked.

REPO_ENV = Path(__file__).parent / ".env"
OS_STATE_JSON = Path(__file__).parent / "data" / "command-center" / "os-state.json"
ELEVEN_API = "https://api.elevenlabs.io/v1"
ELEVEN_VOICE_RE = re.compile(r"^[A-Za-z0-9]{10,40}$")
KOKORO_VOICE_RE = re.compile(r"^[a-z]{2}_[a-z0-9]+$", re.I)


def _eleven_key() -> Optional[str]:
    k = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if k:
        return k
    try:
        for line in REPO_ENV.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*ELEVENLABS_API_KEY\s*=\s*(.*)$", line)
            if m:
                return m.group(1).strip().strip("\"'") or None
    except OSError:
        pass
    return None


def _kill_switch() -> bool:
    try:
        return bool((json.loads(OS_STATE_JSON.read_text(encoding="utf-8")).get("privacy") or {}).get("killSwitch"))
    except Exception:
        return True  # can't tell: no cloud call


def _eleven_tts(text: str, voice_id: str, model: str) -> bytes:
    """One ElevenLabs TTS call (same request as the desktop's tts_request, without stitching)."""
    if _kill_switch():
        raise HTTPException(422, "KILL_SWITCH")
    key = _eleven_key()
    if not key:
        raise HTTPException(422, "ELEVENLABS_NO_KEY")
    if not ELEVEN_VOICE_RE.match(voice_id or ""):
        raise HTTPException(422, "ELEVENLABS_BAD_VOICE")
    body = json.dumps({"text": text, "model_id": model or "eleven_flash_v2_5", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}).encode()
    req = urllib.request.Request(
        f"{ELEVEN_API}/text-to-speech/{voice_id}?output_format=mp3_44100_128",
        data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"ElevenLabs HTTP {e.code}")
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(502, f"ElevenLabs unavailable: {getattr(e, 'reason', e)}")


def _kokoro_tts(p: dict, text: str, voice: str) -> bytes:
    payload = json.dumps({"model": p.get("model") or "kokoro", "input": text, "voice": voice, "response_format": "mp3", "speed": 1.0}).encode()
    req = urllib.request.Request(f"{p['baseUrl'].rstrip('/')}/audio/speech", data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.read()
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(502, f"Kokoro unavailable: {getattr(e, 'reason', e)}")


def resolve_agent_voice(cfg: dict, agent: str, voice: Optional[str]) -> dict:
    """The phone's Tony / agent line -> {engine, voice, model}, like the desktop's tts_synthesize:
    the agent's roster entry (agentVoices, falling back to "general"); an explicit voice id wins
    (a Kokoro-style id -> Kokoro, anything else -> ElevenLabs). Pure."""
    roster = cfg.get("agentVoices") or {}
    av = roster.get(agent) or roster.get("general") or {}
    providers = {p.get("engine"): p for p in cfg.get("providers", []) if p.get("kind") == "tts"}
    eleven, kokoro = providers.get("elevenlabs") or {}, providers.get("kokoro") or {}
    if voice:
        engine = "kokoro" if KOKORO_VOICE_RE.match(voice) else "elevenlabs"
    else:
        engine = "elevenlabs" if (av.get("engine") or (cfg.get("policy") or {}).get("tts")) == "elevenlabs" else "kokoro"
        voice = av.get("voice") if (av.get("engine") or "kokoro") == engine else None
    if engine == "elevenlabs":
        return {"engine": "elevenlabs", "voice": voice or eleven.get("voice"), "model": av.get("model") or eleven.get("model") or "eleven_flash_v2_5"}
    kv = voice if voice and KOKORO_VOICE_RE.match(voice) else None
    return {"engine": "kokoro", "voice": kv or kokoro.get("voice") or KOKORO_VOICES.get("en"), "model": kokoro.get("model") or "kokoro"}


@router.post("/tts")
def tts(body: dict = Body(...)):
    text = str(body.get("text") or "").strip()
    lang = str(body.get("lang") or "")
    if not text or len(text) > 2000:
        raise HTTPException(400, "text must be 1–2000 characters")
    engine = str(body.get("engine") or "").strip()
    voice = str(body.get("voice") or "").strip()[:128] or None
    agent = str(body.get("agent") or "").strip()[:32]

    # The phone's Tony / agent lines: the desktop roster's voice. ElevenLabs when that's the pick;
    # Kokoro (Tony's Kokoro voice) when ElevenLabs is blocked, keyless or failing. X-TTS-Engine says which.
    if agent and not engine:
        cfg = _providers()
        plan = resolve_agent_voice(cfg, agent, voice)
        fallback = None
        if plan["engine"] == "elevenlabs":
            try:
                audio = _eleven_tts(text, plan["voice"] or "", plan["model"])
                return Response(content=audio, media_type="audio/mpeg", headers={"X-TTS-Engine": "elevenlabs"})
            except HTTPException as e:
                fallback = str(e.detail)
        kp = _kokoro()
        if not kp:
            raise HTTPException(422, "NO_LOCAL_TTS")
        kvoice = plan["voice"] if plan["engine"] == "kokoro" else (kp.get("voice") or KOKORO_VOICES.get("en"))
        headers = {"X-TTS-Engine": "kokoro"}
        if fallback:
            headers["X-TTS-Fallback"] = fallback[:120]
        return Response(content=_kokoro_tts(kp, text, kvoice), media_type="audio/mpeg", headers=headers)

    if engine:
        p = next((x for x in _tts_providers() if x.get("id") == engine), None)
        if not p:
            raise HTTPException(422, f"no TTS provider '{engine}'")
        if p.get("engine") == "elevenlabs":
            # Language Hub on the phone: an explicit ElevenLabs pick. Errors are returned (KILL_SWITCH,
            # ELEVENLABS_NO_KEY, 502) so the client's own fallback runs.
            v = voice if voice and not KOKORO_VOICE_RE.match(voice) else p.get("voice")
            audio = _eleven_tts(text, v or "", str(body.get("model") or "") or p.get("model") or "")
            return Response(content=audio, media_type="audio/mpeg", headers={"X-TTS-Engine": "elevenlabs"})
    else:
        p = _kokoro()
        if not p:
            raise HTTPException(422, "NO_LOCAL_TTS")
    if not voice:
        voice = KOKORO_VOICES.get(lang.split("-")[0]) if p.get("engine", "kokoro") == "kokoro" else p.get("voice")
    if not voice:
        raise HTTPException(422, "UNSUPPORTED_LANG")
    if p.get("engine") == "xtts":
        root = p["baseUrl"].rstrip("/").rsplit("/v1", 1)[0]
        payload = json.dumps({"text": text, "speaker_wav": voice, "language": lang.split("-")[0] or "en"}).encode()
        req = urllib.request.Request(f"{root}/tts_to_audio/", data=payload, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return Response(content=r.read(), media_type="audio/wav")
        except (urllib.error.URLError, OSError) as e:
            raise HTTPException(502, f"XTTS unavailable: {getattr(e, 'reason', e)}")
    return Response(content=_kokoro_tts(p, text, voice), media_type="audio/mpeg")


@router.post("/llm")
def llm(body: dict = Body(...)):
    import command_center_api as cc  # the gateway's LM Studio config / model pick / GPU lease

    system, prompt = str(body.get("system") or ""), str(body.get("prompt") or "")
    if not prompt or len(system) > 8000 or len(prompt) > 12000:
        raise HTTPException(413, "Too long")
    if cc.gpu_busy():
        raise HTTPException(503, "Local LLM busy (the desktop holds the GPU)")
    cfg = cc.load_config()["llm"]
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    for attempt in range(2):
        req = {
            "model": cc._pick_model(cfg["model"]),
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 1200,
            "stream": False,
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            out = cc._http_json(f"{cfg['baseUrl'].rstrip('/')}/chat/completions", req, timeout=cfg.get("timeoutSecs", 120))
        except Exception as e:
            raise HTTPException(503, f"Local LLM unavailable: {cc._why(e)}")
        j = cc.extract_json(out["choices"][0]["message"].get("content") or "")
        if j is not None:
            return j
        messages.append({"role": "user", "content": "Return ONLY the JSON object, nothing else."})
    raise HTTPException(502, "Model returned no JSON")


@router.post("/release")
def release():
    with _side_lock:
        return {"stopped": _stop_sidecar()}


@router.get("/status")
def status():
    with db() as c:
        n = c.execute("SELECT COUNT(*) FROM phrases").fetchone()[0]
    d = _models_dir()
    m = pick_ml_model(d) if d else None
    return {
        "dbPath": str(DB_PATH),
        "entries": n,
        "multilingualModel": m.name if m else None,
        "sidecarRunning": _port_open(SIDECAR_PORT),
        "localTts": _kokoro() is not None,
        "llmModel": None,
    }
