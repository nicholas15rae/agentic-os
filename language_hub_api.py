"""Language Hub — the phone's path (gateway) to the same local library and voice stack.

The desktop app talks to `<repo>/data/language-hub/library.db` through Rust
(`command center/src-tauri/src/commands/language_hub.rs`); the PWA / Mobile HUD reaches the SAME
file here. The DDL below is identical to Rust's `SCHEMA`. Self-contained: nothing here touches the
Command Center store, the vault or any RAG index, and no other module reads this file.

Voice, all local:
  * STT  — English → the configured Whisper (Tony's base.en). Any other language / auto-detect →
           a multilingual whisper-server sidecar on 127.0.0.1:8179, started on first use and
           stopped by POST /release or after 3 idle minutes (zero idle overhead).
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

import atexit
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
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import Response

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


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
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
    if lang == "en":
        p = _stt_main()
        base, model, engine = p["baseUrl"], p.get("model") or "whisper-1", "whisper"
    else:
        base, model, engine = ensure_sidecar(), "whisper-1", "whisper-multilingual"
    body, ctype = _multipart({"model": model, "response_format": "verbose_json", "temperature": "0", "language": lang.split("-")[0]}, audio)
    req = urllib.request.Request(f"{base.rstrip('/')}/audio/transcriptions", data=body, headers={"Content-Type": ctype}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            out = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise HTTPException(502, f"Whisper unavailable: {getattr(e, 'reason', e)}")
    finally:
        _side["last"] = time.time()
    text = str(out.get("text") or "").strip()
    if text.lower() in ("[blank_audio]", "(silence)", "[ silence ]", "[silence]"):
        text = ""
    language = out.get("language") or (None if lang == "auto" else lang)
    return {"text": text, "language": language, "engine": engine}


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
