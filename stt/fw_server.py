"""faster-whisper speech-to-text server for the Agentic OS: 127.0.0.1:8177, on the GPU.

An OpenAI-style STT endpoint that the desktop app (voice.rs transcribe_bytes) and the gateway's
phone path (language_hub_api.py) call exactly like whisper.cpp on :8178:

  POST /v1/audio/transcriptions  multipart: file, model, language, prompt, response_format
                                 (json | verbose_json | text), temperature; plus optional hotwords,
                                 beam_size, partial=1 (fast path), session (partials' stream key), vad
  GET  /v1/models                the CT2 models in the models folder (the app's probe + dropdown)
  GET  /health                   {ready, device, compute_type, model, vram_mb, last timings, ...}
  POST /load                     hot-swap: {model, compute_type?, device?} (JSON or form)
  WS   /v1/stream                live captions: JSON {"type":"start",...} then binary PCM16 16 kHz
                                 mono frames, then {"type":"end"}; answers {"type":"partial",
                                 "partial", "stable"} while you speak (GPU only) and one
                                 {"type":"final", "final"} (the same full-clip decode as a POST)

One GPU worker thread owns the model. Jobs wait in a priority queue: finals before partials, and a
partial that a newer one from the same session has overtaken (or that waited too long) is answered
{"text": "", "stale": true} without decoding. The model stays loaded; two warm-up decodes run
before /health says ready. If CUDA can't start (or the GPU is too full), device is
"cpu-unavailable" and the load is retried in the background (30 s, doubling to 10 min, same VRAM
pre-check).

The desktop app sends one POST to its STT provider and has no fallback of its own, so a final this
server can't decode on the GPU (loading, cpu-unavailable, queue full, decode error) is forwarded to
whisper.cpp :8178 (--fallback-url) and answered from there (header X-STT-Backend: whispercpp). It
answers 503 only when :8178 is down too, and GET /v1/models (the app's health probe) answers 503
exactly then. A DEAD server is not covered for the desktop: only the gateway re-spawns it.
WebSocket /v1/stream (the gateway's phone proxy) uses Worker.submit with partial=True and a
per-stream session key, so its partials get the same scheduling (finals first, stale ones dropped).
Uvicorn needs the `websockets` (or `wsproto`) package in the venv to serve it; without one the
upgrade gets a 404 and the gateway runs the same session over POSTs instead.

Per-request audio length / queue / decode times (never the transcript) go to
G:\\whisper\\fw-server.log, capped at 10 MB (5 MB + one rollover).

Run (the venv has ctranslate2 4.9.1 + faster-whisper 1.2.1; cuBLAS 12 / cuDNN 9 DLLs in C:\\ai-stt\\cuda):
  C:\\ai-stt\\.venv\\Scripts\\python.exe "G:\\agentic os\\stt\\fw_server.py"   (defaults: large-v3-turbo int8_float16, beam 5, VAD on)
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import concurrent.futures
import gc
import io
import itertools
import json
import logging
import logging.handlers
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8177
MODELS_DIR = Path(os.environ.get("STT_MODELS_DIR", r"C:\models\stt"))
CUDA_DIR = Path(os.environ.get("STT_CUDA_DIR", r"C:\ai-stt\cuda"))
LOG_PATH = Path(os.environ.get("STT_LOG", r"G:\whisper\fw-server.log"))
LOG_MAX_BYTES = 5 * 1024 * 1024  # x2 with the one rollover file = the 10 MB cap
MODEL_ALIASES = {
    "distil-large-v3": "faster-distil-whisper-large-v3",
    "large-v3-turbo": "faster-whisper-large-v3-turbo",
}
SAMPLE_RATE = 16000
MAX_AUDIO_BYTES = 20 * 1024 * 1024  # voice.rs caps at ~15 MB, the gateway at 16 MB
QUEUE_MAX = 16
PARTIAL_MAX_AGE = 2.0  # s a partial may wait before it is stale
MIN_FREE_VRAM_MB = 1500  # don't load onto a GPU with less free than this (a model needs ~1.2 GB)
RETRY_BACKOFF = (30.0, 600.0)  # s: first wait after a failed load, cap (doubles each time)
FALLBACK_URL = "http://127.0.0.1:8178/v1/audio/transcriptions"  # whisper.cpp base.en on the CPU
FALLBACK_TIMEOUT = 170.0  # s; voice.rs waits 180 s for a transcription
QUIET_RMS = 0.004  # -48 dBFS over the whole clip, the app's 360 ms pre-roll and 700 ms tail included
FORMATS = ("json", "verbose_json", "text")
_LANG_RE = re.compile(r"^[a-z]{2,3}$")
# Whisper's stock lines on silence / noise; a result made only of these from a clip the model
# itself thinks is probably not speech is dropped (see clean_text).
NOISE_LINES = {
    "you", "thank you", "thank you very much", "thanks for watching", "thank you for watching",
    "bye", "the end", "subtitles by the amaraorg community", "blank_audio", "silence", "music", "applause", "laughter",
}
JUNK = ("[BLANK_AUDIO]", "(silence)", "[ Silence ]", "[silence]")
# Caption credits Whisper invents on noise (learned from subtitled video); never real dictation here.
CREDIT_PREFIXES = ("transcription by", "transcribed by", "subtitles by", "subtitled by", "captions by", "captioning by")
# WebSocket /v1/stream
STREAM_MAX_BYTES = MAX_AUDIO_BYTES  # PCM16 in one stream (~10 min of 16 kHz mono)
STREAM_PARTIAL_MIN_S = 0.5  # no partial on less audio than this
STREAM_PARTIAL_MAX_S = 30.0  # nor past one Whisper window (a multi-window partial is too slow)
STREAM_PARTIAL_MS = (300, 3000, 600)  # min, max, default spacing of partials (ms of new audio)
STREAM_START_S = 5.0  # wait this long for the start message
STREAM_IDLE_S = 30.0  # a stream that sends nothing for this long is closed
# Pages a browser may drive the stream from (a WebSocket has no CORS): loopback origins only.
_LOCAL_ORIGIN_RE = re.compile(r"^(tauri://localhost|https?://tauri\.localhost|https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?)$")

log = logging.getLogger("fw-server")


class NotReady(Exception):
    pass


class Busy(Exception):
    pass


class FallbackFailed(Exception):
    pass


# ── audio ────────────────────────────────────────────────────────────────────

def decode_audio_bytes(data: bytes) -> np.ndarray:
    """The clip as float32 mono 16 kHz. The app's encodeWav16k WAV (16 kHz mono PCM16) is read
    directly; anything else goes through PyAV (faster_whisper.decode_audio). ValueError if neither
    can read it."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1 and w.getsampwidth() == 2:
                return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    except (wave.Error, EOFError):
        pass
    try:
        from faster_whisper.audio import decode_audio  # PyAV; only for non-WAV uploads
        return decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    except Exception as e:  # noqa: BLE001 — any decoder failure is a bad upload
        raise ValueError(f"unreadable audio: {e}") from e


def rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if audio.size else 0.0


def pcm16_audio(pcm: bytes) -> np.ndarray:
    """Raw PCM16 LE mono 16 kHz (the stream's frames) as float32, like decode_audio_bytes."""
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def wav16k(pcm: bytes) -> bytes:
    """Raw PCM16 16 kHz mono wrapped in a WAV header (what the whisper.cpp fallback reads)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _norm_word(w: str) -> str:
    return re.sub(r"^[^\w']+|[^\w']+$", "", w.lower())


class LocalAgreement:
    """LocalAgreement-2 over whole-clip partial hypotheses (each partial decodes everything said
    so far). The words two consecutive hypotheses agree on, from the start, are committed: the
    stable text, never retracted. The rest of the newest hypothesis is tentative. Words compare
    case- and edge-punctuation-insensitively ("Tony," == "tony"). The same rule as the desktop's
    `LocalAgreement` (stt-partials.ts). Pure."""

    def __init__(self) -> None:
        self.prev: list[str] = []
        self.committed: list[str] = []

    def push(self, text: str) -> tuple[str, str]:
        """-> (shown text = stable + tentative, stable text)."""
        cur = text.split()
        c = len(self.committed)
        # Commit more only while the new hypothesis still starts with what is committed.
        if len(cur) >= c and all(_norm_word(a) == _norm_word(b) for a, b in zip(self.committed, cur)):
            n = c
            while n < min(len(self.prev), len(cur)) and _norm_word(self.prev[n]) == _norm_word(cur[n]):
                n += 1
            self.committed += cur[c:n]
        self.prev = cur
        return " ".join(self.committed + cur[len(self.committed):]), " ".join(self.committed)


# ── request -> decode options ────────────────────────────────────────────────

@dataclass
class Options:
    language: Optional[str] = "en"
    beam_size: int = 5
    temperature: tuple = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
    initial_prompt: Optional[str] = None
    hotwords: Optional[str] = None
    without_timestamps: bool = True
    condition_on_previous_text: bool = False
    vad_filter: bool = False
    partial: bool = False
    response_format: str = "json"

    def kwargs(self) -> dict:
        """The faster-whisper WhisperModel.transcribe keyword arguments."""
        return {
            "language": self.language,
            "task": "transcribe",
            "beam_size": self.beam_size,
            "best_of": 1 if self.partial else 5,
            "temperature": list(self.temperature),
            "initial_prompt": self.initial_prompt,
            "hotwords": self.hotwords,
            "without_timestamps": self.without_timestamps,
            "condition_on_previous_text": self.condition_on_previous_text,
            "vad_filter": self.vad_filter,
            "word_timestamps": False,
        }


def _flag(v: Any) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


def build_options(fields: dict, duration: float, *, beam_size: int = 5, prompt_mode: str = "initial", vad: str = "off") -> Options:
    """Map the multipart fields to decode options. ValueError on a bad field (-> 400).

    partial=1 is the live-caption fast path: beam 1, no timestamps, no conditioning, one
    temperature, no VAD. prompt_mode says where the `prompt` field (voice.rs's vocabulary list)
    goes: "initial" (Whisper's initial_prompt), "hotwords" (faster-whisper's per-window bias,
    less prone to being read back on silence) or "both". An explicit `hotwords` field always
    goes to hotwords."""
    fmt = str(fields.get("response_format") or "json").strip().lower()
    if fmt not in FORMATS:
        raise ValueError(f"response_format must be one of {', '.join(FORMATS)}")
    lang = str(fields.get("language") or "").strip().lower().split("-")[0]
    if lang in ("", "auto"):
        lang = None
    elif not _LANG_RE.match(lang):
        raise ValueError("bad language code")
    try:
        t = float(fields.get("temperature") or 0.0)
    except ValueError:
        raise ValueError("bad temperature") from None
    t = min(1.0, max(0.0, t))
    partial = _flag(fields.get("partial"))
    raw_beam = str(fields.get("beam_size") or "").strip()
    if raw_beam:
        if not raw_beam.isdigit():
            raise ValueError("bad beam_size")
        beam = min(10, max(1, int(raw_beam)))
    else:
        beam = 1 if partial else beam_size
    prompt = str(fields.get("prompt") or "").strip()[:1000] or None
    hot = str(fields.get("hotwords") or "").strip()[:1000] or None
    initial = prompt if prompt_mode in ("initial", "both") else None
    if prompt and prompt_mode in ("hotwords", "both") and not hot:
        hot = prompt
    want_vad = str(fields.get("vad") or "").strip().lower()
    if partial:
        return Options(language=lang, beam_size=1, temperature=(t,), initial_prompt=initial, hotwords=hot,
                       without_timestamps=True, condition_on_previous_text=False, vad_filter=False,
                       partial=True, response_format=fmt)
    temps = tuple(round(x, 1) for x in np.arange(t, 1.0001, 0.2)) or (t,)
    return Options(
        language=lang, beam_size=beam, temperature=temps, initial_prompt=initial, hotwords=hot,
        # One 30 s window needs no timestamps (fewer tokens); longer clips and verbose_json keep them
        # so the window seeks land on segment boundaries.
        without_timestamps=fmt != "verbose_json" and duration <= 30.0,
        condition_on_previous_text=False,
        vad_filter=_flag(want_vad) if want_vad else vad == "on",
        partial=False, response_format=fmt,
    )


def clean_text(text: str, segments: list[dict], level: float) -> str:
    """Drop what Whisper says on noise: the silence markers, caption credits ("Transcription by
    CastingWords"), and a result made only of its stock lines ("Thank you.", "you") when the
    model doubts it: no_speech_prob >= 0.1, or avg_logprob < -0.6 (large-v3-turbo reports
    no_speech_prob 0 even on pure noise; its noise "Thank you." scores -0.70 to -0.81). A quiet
    clip (rms < QUIET_RMS) needs less doubt (avg_logprob < -0.5) but still some: a softly said
    "Thank you." / "Bye." the model is sure of (-0.29 to -0.36) is real and is kept. The Silero
    VAD pass (vad on) stops most noise before decoding; this is the backstop. Pure."""
    t = text.strip()
    low = t.lower()
    if not t or any(low == j.lower() for j in JUNK) or low.startswith(CREDIT_PREFIXES):
        return ""
    words = re.sub(r"[^a-z' ]+", " ", low).split()
    line = " ".join(w.replace("'", "") for w in words)
    parts = [p.strip() for p in re.split(r"[.!?,]+", re.sub(r"[\[\]()]", "", low)) if p.strip()]
    stock = bool(parts) and all(re.sub(r"[^a-z ]", "", p).strip() in NOISE_LINES for p in parts)
    if stock or line in NOISE_LINES:
        nsp = max((float(s.get("no_speech_prob") or 0.0) for s in segments), default=0.0)
        lp = min((float(s.get("avg_logprob") or 0.0) for s in segments), default=0.0)
        if nsp >= 0.1 or lp < (-0.5 if level < QUIET_RMS else -0.6):
            return ""
    return t


# ── backends ─────────────────────────────────────────────────────────────────

def add_cuda_dlls(cuda_dir: Path = CUDA_DIR) -> None:
    """cuBLAS 12 + cuDNN 9 (copied from VoiceStudio's torch\\lib) must be findable BEFORE
    ctranslate2 is imported; its own wheel ships only the cudnn64_9 stub."""
    if os.name == "nt" and cuda_dir.is_dir():
        os.add_dll_directory(str(cuda_dir))
        os.environ["PATH"] = f"{cuda_dir}{os.pathsep}{os.environ.get('PATH', '')}"


def resolve_model(name: str, models_dir: Path = MODELS_DIR) -> Path:
    """Alias ("distil-large-v3") or folder name under models_dir -> the CT2 folder. Never a path
    outside models_dir."""
    n = (name or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", n):
        raise ValueError("bad model name")
    for cand in (MODEL_ALIASES.get(n), n, f"faster-whisper-{n}", f"faster-{n}"):
        if cand and (models_dir / cand / "model.bin").is_file():
            return models_dir / cand
    raise ValueError(f"model '{n}' not found in {models_dir}")


def alias_of(folder: str) -> str:
    return next((a for a, f in MODEL_ALIASES.items() if f == folder), folder)


class FasterWhisperBackend:
    def __init__(self, path: Path, device: str, compute_type: str):
        from faster_whisper import WhisperModel  # after add_cuda_dlls

        self.model = WhisperModel(str(path), device=device, compute_type=compute_type, cpu_threads=4, num_workers=1)

    def transcribe(self, audio: np.ndarray, opts: Options) -> dict:
        segs, info = self.model.transcribe(audio, **opts.kwargs())
        out = [
            {"id": i, "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text, "avg_logprob": round(s.avg_logprob, 4),
             "no_speech_prob": round(s.no_speech_prob, 4), "compression_ratio": round(s.compression_ratio, 3), "temperature": s.temperature}
            for i, s in enumerate(segs)  # the generator decodes here, on the worker thread
        ]
        return {"text": "".join(s["text"] for s in out).strip(), "segments": out, "language": info.language, "duration": info.duration}

    @staticmethod
    def warm_vad() -> None:
        from faster_whisper.vad import get_speech_timestamps

        get_speech_timestamps(np.zeros(SAMPLE_RATE, dtype=np.float32))


Loader = Callable[[Path, str, str], Any]


def real_loader(path: Path, device: str, compute_type: str):
    return FasterWhisperBackend(path, device, compute_type)


def gpu_mem() -> Optional[tuple[int, int]]:
    """(used_mb, free_mb) of GPU 0 from nvidia-smi, or None."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, creationflags=0x08000000 if os.name == "nt" else 0,
        ).stdout.strip().splitlines()[0]
        used, free = (int(x.strip()) for x in out.split(","))
        return used, free
    except Exception:  # noqa: BLE001
        return None


class Fallback:
    """whisper.cpp (:8178, CPU) behind this server. A final this server can't decode on the GPU is
    forwarded there with the caller's own fields, so the desktop app (one POST to policy.stt, no
    retry of its own) keeps working. Loopback only: speech never leaves the PC."""

    FIELDS = ("model", "language", "prompt", "response_format", "temperature")  # what voice.rs / the gateway send
    _CTYPE_RE = re.compile(r"^[a-z]+/[a-z0-9.+-]{1,40}$")

    def __init__(self, url: str = FALLBACK_URL, timeout: float = FALLBACK_TIMEOUT):
        u = urllib.parse.urlparse(url)
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError(f"the fallback must be an http:// loopback URL, not {url!r}")
        self.url, self.host, self.port, self.timeout = url, u.hostname, u.port or 80, timeout
        self.used = 0
        self.last_error: Optional[str] = None

    def reachable(self, timeout: float = 0.2) -> bool:
        # A refused connect to a closed localhost port stalls ~2 s on Windows (SYN retries); an
        # open one answers in < 1 ms. Look before posting.
        try:
            with socket.create_connection((self.host, self.port), timeout=timeout):
                return True
        except OSError:
            return False

    def forward(self, fields: dict, data: bytes, ctype: str = "audio/wav") -> tuple[int, bytes, str]:
        """-> (status, body, content type) of whisper.cpp's answer. FallbackFailed when it is down or failed."""
        try:
            out = self._forward(fields, data, ctype)
        except FallbackFailed as e:
            self.last_error = str(e)
            raise
        self.used += 1
        self.last_error = None
        return out

    def _forward(self, fields: dict, data: bytes, ctype: str) -> tuple[int, bytes, str]:
        if not self.reachable():
            raise FallbackFailed("not listening")
        ctype = ctype if self._CTYPE_RE.match(ctype or "") else "application/octet-stream"
        bnd = "----fwfallback" + uuid.uuid4().hex
        body = bytearray()
        for k in self.FIELDS:
            v = fields.get(k)
            if isinstance(v, str) and v:
                body += f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        body += f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
        body += data + f"\r\n--{bnd}--\r\n".encode()
        req = urllib.request.Request(self.url, data=bytes(body), headers={"Content-Type": f"multipart/form-data; boundary={bnd}"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, r.read(), r.headers.get("Content-Type") or "application/json"
        except urllib.error.HTTPError as e:
            raise FallbackFailed(f"HTTP {e.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise FallbackFailed(type(e).__name__) from None


# ── the GPU worker ───────────────────────────────────────────────────────────

@dataclass(order=True)
class _Item:
    prio: int
    seq: int
    job: Any = field(compare=False)


@dataclass
class Job:
    kind: str  # "decode" | "load" | "stop"
    future: concurrent.futures.Future
    enq: float
    audio: Optional[np.ndarray] = None
    opts: Optional[Options] = None
    session: str = "default"
    load: Optional[tuple[str, str, str]] = None


class Worker:
    """One thread, one model. submit() never blocks; the future resolves on the worker."""

    def __init__(self, loader: Loader = real_loader, models_dir: Path = MODELS_DIR, gpu: Callable[[], Optional[tuple[int, int]]] = gpu_mem,
                 min_free_mb: int = MIN_FREE_VRAM_MB, warmup: int = 2, retry_backoff: tuple[float, float] = RETRY_BACKOFF):
        self.loader, self.models_dir, self.gpu, self.min_free_mb, self.warmup = loader, models_dir, gpu, min_free_mb, warmup
        # A load that left no model is retried after retry_backoff[0] s, doubling to [1]; 0 = never.
        self.retry_backoff = retry_backoff
        self._retry: Optional[tuple[str, str, str]] = None
        self._retry_at = 0.0  # time.monotonic() of the pending retry
        self._retry_wait = 0.0
        self.q: "queue.PriorityQueue[_Item]" = queue.PriorityQueue()
        self.seq = itertools.count()
        self.latest_partial: dict[str, int] = {}
        self.backend: Any = None
        self.lock = threading.Lock()
        self.state: dict[str, Any] = {"ready": False, "loading": False, "device": None, "compute_type": None, "model": None,
                                      "model_path": None, "vram_mb": None, "error": None, "warmup_ms": [], "loaded_at": None}
        self.timings: collections.deque = collections.deque(maxlen=20)
        self.requests = 0
        self.started = time.time()
        self._thread = threading.Thread(target=self._run, name="fw-gpu-worker", daemon=True)
        self._thread.start()

    # -- public --
    def submit(self, audio: np.ndarray, opts: Options, session: str = "default") -> concurrent.futures.Future:
        with self.lock:
            if not self.state["ready"]:
                raise NotReady(self.state.get("error") or ("loading" if self.state["loading"] else "not ready"))
            if self.q.qsize() >= QUEUE_MAX:
                raise Busy("queue full")
            seq = next(self.seq)
            job = Job("decode", concurrent.futures.Future(), time.perf_counter(), audio=audio, opts=opts, session=session or "default")
            if opts.partial:
                self.latest_partial[job.session] = seq
            self.q.put(_Item(1 if opts.partial else 0, seq, job))
            return job.future

    def load(self, name: str, device: str, compute_type: str) -> concurrent.futures.Future:
        """Queue a (re)load; decodes queued before it run first. Resolves to the new state."""
        job = Job("load", concurrent.futures.Future(), time.perf_counter(), load=(name, device, compute_type))
        with self.lock:
            self.q.put(_Item(0, next(self.seq), job))
        return job.future

    def stop(self) -> None:
        """End the worker thread (after the jobs already queued) and drop any pending retry."""
        with self.lock:
            self._retry = None
            self.q.put(_Item(2, next(self.seq), Job("stop", concurrent.futures.Future(), time.perf_counter())))

    def health(self) -> dict:
        with self.lock:
            st = dict(self.state)
            st["queue"] = self.q.qsize()
            st["retry_in_s"] = round(max(0.0, self._retry_at - time.monotonic()), 1) if self._retry else None
        st["requests"] = self.requests
        st["uptime_s"] = round(time.time() - self.started, 1)
        st["last"] = list(self.timings)
        return st

    # -- worker thread --
    def _run(self) -> None:
        while True:
            with self.lock:
                wait = max(0.0, self._retry_at - time.monotonic()) if self._retry else None
            try:
                item = self.q.get(timeout=wait)
            except queue.Empty:  # a failed load's retry is due
                with self.lock:
                    args, self._retry = self._retry, None
                if args:
                    log.info("retrying the load of %s on %s/%s", *args)
                    try:
                        self._load(*args)
                    except BaseException as e:  # noqa: BLE001 — never kill the worker
                        log.error("load retry failed: %s: %s", type(e).__name__, e)
                continue
            job: Job = item.job
            if job.kind == "stop":
                return
            try:
                if job.kind == "load":
                    job.future.set_result(self._load(*job.load))
                else:
                    self._decode(item.seq, job)
            except BaseException as e:  # noqa: BLE001 — never kill the worker
                if not job.future.done():
                    job.future.set_exception(e)

    def _decode(self, seq: int, job: Job) -> None:
        start = time.perf_counter()
        waited = start - job.enq
        if job.opts.partial:
            with self.lock:
                newer = self.latest_partial.get(job.session, seq) != seq
            if newer or waited > PARTIAL_MAX_AGE:
                job.future.set_result({"text": "", "stale": True, "segments": [], "queue_ms": round(waited * 1000)})
                return
        if self.backend is None:
            raise NotReady(self.state.get("error") or "no model loaded")
        out = self.backend.transcribe(job.audio, job.opts)
        done = time.perf_counter()
        audio_s = job.audio.size / SAMPLE_RATE
        out["text"] = clean_text(str(out.get("text") or ""), out.get("segments") or [], rms(job.audio))
        out.setdefault("duration", audio_s)
        t = {"at": time.strftime("%H:%M:%S"), "audio_s": round(audio_s, 2), "queue_ms": round(waited * 1000), "decode_ms": round((done - start) * 1000),
             "partial": job.opts.partial, "beam": job.opts.beam_size, "chars": len(out["text"])}
        out["queue_ms"], out["decode_ms"] = t["queue_ms"], t["decode_ms"]
        self.requests += 1
        self.timings.append(t)
        log.info("audio=%.2fs queue=%dms decode=%dms partial=%d beam=%d fmt=%s model=%s chars=%d",
                 audio_s, t["queue_ms"], t["decode_ms"], int(job.opts.partial), job.opts.beam_size, job.opts.response_format, self.state.get("model"), t["chars"])
        job.future.set_result(out)

    def _set(self, **kw) -> None:
        with self.lock:
            self.state.update(kw)

    def _load(self, name: str, device: str, compute_type: str) -> dict:
        prev = (self.state.get("model"), self.state.get("device"), self.state.get("compute_type")) if self.backend is not None else None
        with self.lock:
            self._retry = None  # this attempt replaces a pending retry
        self._set(ready=False, loading=True)
        self.backend = None
        gc.collect()  # the old model's VRAM goes back before the new one loads
        try:
            self._try_load(name, device, compute_type)
            self._retry_wait = 0.0
        except Exception as e:  # noqa: BLE001
            why = f"{type(e).__name__}: {e}"[:400]
            log.error("load %s on %s/%s failed: %s", name, device, compute_type, why)
            restorable = bool(prev and prev[1] in ("cuda", "cpu"))
            if restorable and (prev[0], prev[2]) != (name, compute_type):
                try:
                    self._try_load(*prev)
                    self._retry_wait = 0.0
                    self._set(error=f"load {name}/{compute_type} failed, kept {prev[0]}: {why}")
                    return self.health()
                except Exception as e2:  # noqa: BLE001
                    why = f"{why}; restoring {prev[0]} failed too: {e2}"[:400]
            self.backend = None
            self._set(ready=False, loading=False, device="cpu-unavailable" if device == "cuda" else f"{device}-unavailable",
                      compute_type=compute_type, model=name, error=why)
            # No model now. Try again later (the VRAM pre-check runs again each time): a 3D job or
            # an Ollama model may be holding the GPU only for a while. Finals go to whisper.cpp meanwhile.
            self._schedule_retry(prev if restorable else (name, device, compute_type))
        return self.health()

    def _schedule_retry(self, args: tuple[str, str, str]) -> None:
        first, cap = self.retry_backoff
        if first <= 0:
            return
        self._retry_wait = min(cap, self._retry_wait * 2) if self._retry_wait else first
        with self.lock:
            self._retry, self._retry_at = args, time.monotonic() + self._retry_wait
        log.warning("will retry the load of %s on %s/%s in %.0f s", args[0], args[1], args[2], self._retry_wait)

    def _try_load(self, name: str, device: str, compute_type: str) -> None:
        path = resolve_model(name, self.models_dir)
        before = self.gpu() if device == "cuda" else None
        # The pre-flight: no GPU load below min_free_mb free, nor blind (no nvidia-smi reading).
        if device == "cuda" and before is None:
            raise RuntimeError("no free-VRAM reading from nvidia-smi: not loading on the GPU")
        if before and before[1] < self.min_free_mb:
            raise RuntimeError(f"only {before[1]} MB VRAM free (< {self.min_free_mb} MB): not loading on the GPU")
        t0 = time.perf_counter()
        backend = self.loader(path, device, compute_type)
        load_ms = round((time.perf_counter() - t0) * 1000)
        warm = []
        rng = np.random.default_rng(7)
        for i in range(self.warmup):  # cuDNN / cuBLAS init and the first-call allocations happen here
            a = (rng.standard_normal(SAMPLE_RATE * (1 + i)) * 0.003).astype(np.float32)
            w0 = time.perf_counter()
            backend.transcribe(a, Options(language="en", beam_size=1 if i == 0 else 5, temperature=(0.0,)))
            warm.append(round((time.perf_counter() - w0) * 1000))
        if hasattr(backend, "warm_vad"):
            backend.warm_vad()  # load Silero now, not on the first real turn
        after = self.gpu() if device == "cuda" else None
        self.backend = backend
        self._set(ready=True, loading=False, device=device, compute_type=compute_type, model=alias_of(path.name), model_path=str(path),
                  vram_mb=(after[0] - before[0]) if before and after else None, error=None, warmup_ms=warm, load_ms=load_ms,
                  loaded_at=time.strftime("%Y-%m-%d %H:%M:%S"))
        log.info("loaded %s on %s/%s in %d ms, warm-up %s ms, vram %s MB", path.name, device, compute_type, load_ms, warm, self.state["vram_mb"])


# ── HTTP ─────────────────────────────────────────────────────────────────────

def format_response(out: dict, fmt: str):
    headers = {"X-Queue-Ms": str(out.get("queue_ms", 0)), "X-Decode-Ms": str(out.get("decode_ms", 0)), "X-STT-Backend": "faster-whisper"}
    if out.get("stale"):
        headers["X-Stale"] = "1"
    if fmt == "text":
        return PlainTextResponse(out["text"], headers=headers)
    if fmt == "verbose_json":
        body = {"task": "transcribe", "language": out.get("language"), "duration": round(float(out.get("duration") or 0.0), 2),
                "text": out["text"], "segments": out.get("segments") or []}
        if out.get("stale"):
            body["stale"] = True
        return JSONResponse(body, headers=headers)
    return JSONResponse({"text": out["text"], **({"stale": True} if out.get("stale") else {})}, headers=headers)


def create_app(worker: Worker, *, beam_size: int = 5, prompt_mode: str = "initial", vad: str = "off", fallback: Optional[Fallback] = None) -> FastAPI:
    app = FastAPI(title="faster-whisper STT", docs_url=None, redoc_url=None)
    app.state.worker = worker
    app.state.fallback = fallback
    app.state.defaults = {"beam_size": beam_size, "prompt_mode": prompt_mode, "vad": vad}

    def err(status: int, msg: str, kind: str):
        return JSONResponse({"error": {"message": msg, "type": kind}, "device": worker.state.get("device")}, status_code=status)

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(request: Request):
        if not worker.state["ready"] and fallback is None:
            return err(503, worker.state.get("error") or "model loading", "not_ready")
        form = await request.form()
        up = form.get("file")
        if up is None or not hasattr(up, "read"):
            return err(400, "missing file", "invalid_request")
        data = await up.read()
        if len(data) < 64 or len(data) > MAX_AUDIO_BYTES:
            return err(400, "audio too short or too long", "invalid_request")
        try:
            audio = await run_in_threadpool(decode_audio_bytes, data)
            fields = {k: v for k, v in form.items() if isinstance(v, str)}
            opts = build_options(fields, audio.size / SAMPLE_RATE, **app.state.defaults)
        except ValueError as e:
            return err(400, str(e), "invalid_request")

        async def fall_back(status: int, msg: str, kind: str):
            """A final this server can't decode goes to whisper.cpp; its answer, else this error.
            Partials never do: a CPU decode is too slow for a live caption."""
            if fallback is None or opts.partial:
                return err(status, msg, kind)
            t0 = time.perf_counter()
            try:
                code, body, ctype = await run_in_threadpool(fallback.forward, fields, data, getattr(up, "content_type", None) or "audio/wav")
            except FallbackFailed as e:
                log.warning("fallback (%s) to whisper.cpp failed: %s", kind, e)
                return err(status, f"{msg}; whisper.cpp fallback: {e}", kind)
            log.info("fallback (%s) -> whisper.cpp %d in %d ms, audio=%.2fs", kind, code, round((time.perf_counter() - t0) * 1000), audio.size / SAMPLE_RATE)
            return Response(body, status_code=code, media_type=ctype, headers={"X-STT-Backend": "whispercpp", "X-Fallback-Reason": kind})

        if not worker.state["ready"]:
            return await fall_back(503, worker.state.get("error") or "model loading", "not_ready")
        try:
            fut = worker.submit(audio, opts, str(fields.get("session") or "default")[:64])
        except NotReady as e:
            return await fall_back(503, str(e), "not_ready")
        except Busy as e:
            return await fall_back(503, str(e), "busy")
        try:
            out = await asyncio.wrap_future(fut)
        except NotReady as e:
            return await fall_back(503, str(e), "not_ready")
        except Exception as e:  # noqa: BLE001
            log.error("decode failed: %s: %s", type(e).__name__, e)
            return await fall_back(500, f"decode failed: {type(e).__name__}", "server_error")
        return format_response(out, opts.response_format)

    @app.get("/v1/models")
    def models():
        """The desktop app's health probe for this provider (up = any status < 500) and its Settings
        model list. 200 while finals get answered (GPU ready, or whisper.cpp behind it); 503 when
        neither can, so Settings / the HUD don't show STT green while every utterance fails."""
        have = []
        try:
            have = sorted(p.name for p in worker.models_dir.iterdir() if (p / "model.bin").is_file())
        except OSError:
            pass
        st = worker.state
        loaded = st.get("model") if st.get("ready") else None
        serving = "faster-whisper" if st.get("ready") else ("whispercpp" if fallback is not None and fallback.reachable() else None)
        body = {"object": "list", "ready": bool(st.get("ready")), "device": st.get("device"), "serving": serving,
                "data": [{"id": alias_of(n), "object": "model", "owned_by": "faster-whisper", "loaded": alias_of(n) == loaded} for n in have]}
        if serving is None:
            body["error"] = {"message": st.get("error") or ("model loading" if st.get("loading") else "not ready"), "type": "not_ready"}
            return JSONResponse(body, status_code=503)
        return body

    @app.get("/health")
    def health():
        st = worker.health()
        g = worker.gpu() if st.get("device") == "cuda" else None
        st["gpu_free_mb"] = g[1] if g else None
        st["fallback"] = {"url": fallback.url, "used": fallback.used, "last_error": fallback.last_error} if fallback is not None else None
        st.update(app.state.defaults)
        return st

    @app.post("/load")
    async def load(request: Request):
        ctype = request.headers.get("content-type", "")
        try:
            body = await request.json() if "json" in ctype else {k: v for k, v in (await request.form()).items() if isinstance(v, str)}
        except ValueError:
            return err(400, "body must be JSON or a form", "invalid_request")
        if not isinstance(body, dict):
            return err(400, "body must be an object", "invalid_request")
        name = str(body.get("model") or worker.state.get("model") or "").strip()
        name = Path(name).name if ("\\" in name or "/" in name) else name  # a whisper.cpp-style path -> its folder name
        device = str(body.get("device") or worker.state.get("device") or "cuda")
        device = "cuda" if device == "cpu-unavailable" else device
        compute = str(body.get("compute_type") or worker.state.get("compute_type") or "int8_float16")
        if device not in ("cuda", "cpu") or not re.fullmatch(r"[a-z0-9_]{3,20}", compute):
            return err(400, "bad device or compute_type", "invalid_request")
        try:
            resolve_model(name, worker.models_dir)
        except ValueError as e:
            return err(400, str(e), "invalid_request")
        st = await asyncio.wrap_future(worker.load(name, device, compute))
        return JSONResponse(st, status_code=200 if st.get("ready") else 503)

    @app.websocket("/v1/stream")
    async def stream(ws: WebSocket):
        """Live captions for one utterance.

        client -> {"type":"start", "language":"en", "prompt":..., "hotwords"?, "partials":true,
                   "partial_ms":600}; then binary PCM16 LE 16 kHz mono frames (any size, even
                   length); {"type":"config","partials":bool} at any time; {"type":"end"} (or
                   {"type":"cancel"}).
        server -> {"type":"ready","partials":bool,"device"}; {"type":"partial","partial","stable"}
                  (LocalAgreement-2) while audio arrives, single-flight, only on the GPU;
                  {"type":"final","final","backend",...} after end: one full-clip decode with the
                  POST's options (beam, VAD, prompt), so the text is what a POST of the same clip
                  gives; whisper.cpp answers it when this server can't. {"type":"error","error"}
                  then a close on any failure (the caller falls back to a single POST).
        A browser page from anywhere but a loopback origin is refused (a WebSocket has no CORS)."""
        origin = ws.headers.get("origin")
        if origin and not _LOCAL_ORIGIN_RE.match(origin):
            await ws.close(code=4403)
            return
        await ws.accept()
        send_lock = asyncio.Lock()

        async def send(obj: dict) -> None:
            async with send_lock:
                await ws.send_text(json.dumps(obj))

        async def fail(msg: str, code: int = 1011) -> None:
            try:
                await send({"type": "error", "error": msg, "device": worker.state.get("device")})
                await ws.close(code=code)
            except (WebSocketDisconnect, RuntimeError):
                pass

        def control(msg: dict) -> Optional[dict]:
            try:
                obj = json.loads(msg.get("text") or "")
            except ValueError:
                return None
            return obj if isinstance(obj, dict) else None

        try:
            first = await asyncio.wait_for(ws.receive(), STREAM_START_S)
        except (asyncio.TimeoutError, WebSocketDisconnect):
            return await fail("no start message", 1008)
        start = control(first) if first.get("type") == "websocket.receive" else None
        if not start or start.get("type") != "start":
            return await fail("expected a start message", 1008)
        fields = {"language": str(start.get("language") or "en")[:16], "prompt": str(start.get("prompt") or "")[:1000],
                  "hotwords": str(start.get("hotwords") or "")[:1000], "response_format": "json", "temperature": "0"}
        try:
            build_options(fields, 1.0, **app.state.defaults)  # validates language etc. (-> ValueError)
            every = int(start.get("partial_ms") or STREAM_PARTIAL_MS[2])
        except (ValueError, TypeError) as e:
            return await fail(f"bad start: {e}", 1008)
        every = min(STREAM_PARTIAL_MS[1], max(STREAM_PARTIAL_MS[0], every))
        if not worker.state["ready"] and fallback is None:
            return await fail(worker.state.get("error") or "model loading", 1013)
        # Partials only on the GPU: a CPU pass costs ~0.5 s or more per caption.
        gpu = bool(worker.state["ready"] and worker.state.get("device") == "cuda")
        want = start.get("partials", True) is not False
        session = f"ws-{uuid.uuid4().hex[:12]}"
        await send({"type": "ready", "partials": want and gpu, "device": worker.state.get("device"), "model": worker.state.get("model")})

        buf = bytearray()
        la = LocalAgreement()
        state = {"done": False, "last": 0, "task": None, "partials": want and gpu}

        async def run_partial(pcm: bytes) -> None:
            audio = pcm16_audio(pcm)
            opts = build_options({**fields, "partial": "1"}, audio.size / SAMPLE_RATE, **app.state.defaults)
            try:
                out = await asyncio.wrap_future(worker.submit(audio, opts, session))
            except Exception:  # noqa: BLE001 — a caption that can't be decoded is simply skipped
                return
            text = str(out.get("text") or "").strip()
            if state["done"] or out.get("stale") or not text:
                return
            shown, stable = la.push(text)
            try:
                await send({"type": "partial", "partial": shown, "stable": stable, "audio_s": round(audio.size / SAMPLE_RATE, 2),
                            "decode_ms": out.get("decode_ms")})
            except (WebSocketDisconnect, RuntimeError):
                pass

        def maybe_partial() -> None:
            task = state["task"]
            n = len(buf)
            if not state["partials"] or (task is not None and not task.done()):
                return
            if n - state["last"] < every * 32 or not STREAM_PARTIAL_MIN_S * 32000 <= n <= STREAM_PARTIAL_MAX_S * 32000:
                return
            state["last"] = n
            state["task"] = asyncio.create_task(run_partial(bytes(buf)))

        try:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive(), STREAM_IDLE_S)
                except asyncio.TimeoutError:
                    return await fail("idle", 1008)
                if msg.get("type") == "websocket.disconnect":
                    return
                data = msg.get("bytes")
                if data is not None:
                    if len(data) % 2 or len(buf) + len(data) > STREAM_MAX_BYTES:
                        return await fail("audio too long or not PCM16", 1009)
                    buf += data
                    maybe_partial()
                    continue
                ctl = control(msg)
                kind = (ctl or {}).get("type")
                if kind == "config":
                    state["partials"] = ctl.get("partials") is True and gpu
                elif kind == "cancel":
                    state["done"] = True
                    await ws.close(code=1000)
                    return
                elif kind == "end":
                    break
                else:
                    return await fail("unknown message", 1003)
        except WebSocketDisconnect:
            state["done"] = True
            return

        # The final: an in-flight partial is left to finish on its own (finals run first anyway).
        state["done"] = True
        pcm = bytes(buf)
        audio = pcm16_audio(pcm)
        if audio.size < SAMPLE_RATE // 10:
            await send({"type": "final", "final": "", "backend": "faster-whisper", "audio_s": round(audio.size / SAMPLE_RATE, 2)})
            await ws.close(code=1000)
            return
        out: Optional[dict] = None
        why = worker.state.get("error") or "model loading"
        if worker.state["ready"]:
            try:
                out = await asyncio.wrap_future(worker.submit(audio, build_options(fields, audio.size / SAMPLE_RATE, **app.state.defaults), session + "-final"))
            except Exception as e:  # noqa: BLE001
                why = f"{type(e).__name__}: {e}"[:200]
                log.error("stream final failed: %s", why)
        if out is not None:
            reply = {"type": "final", "final": str(out.get("text") or "").strip(), "backend": "faster-whisper", "audio_s": round(audio.size / SAMPLE_RATE, 2),
                     "queue_ms": out.get("queue_ms"), "decode_ms": out.get("decode_ms")}
        elif fallback is not None:
            try:
                code, body, _ = await run_in_threadpool(fallback.forward, {**fields, "model": str(start.get("model") or "base.en")[:80]}, wav16k(pcm))
                text = str(json.loads(body.decode("utf-8")).get("text") or "").strip()
            except (FallbackFailed, ValueError, AttributeError) as e:
                return await fail(f"{why}; whisper.cpp fallback: {e}")
            if code >= 400:
                return await fail(f"{why}; whisper.cpp fallback: HTTP {code}")
            log.info("stream final -> whisper.cpp, audio=%.2fs", audio.size / SAMPLE_RATE)
            reply = {"type": "final", "final": "" if any(text.lower() == j.lower() for j in JUNK) else text, "backend": "whispercpp",
                     "audio_s": round(audio.size / SAMPLE_RATE, 2)}
        else:
            return await fail(why)
        try:
            await send(reply)
            await ws.close(code=1000)
        except (WebSocketDisconnect, RuntimeError):
            pass

    return app


# ── process ──────────────────────────────────────────────────────────────────

def setup_logging(path: Path = LOG_PATH) -> None:
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        h: logging.Handler = logging.handlers.RotatingFileHandler(path, maxBytes=LOG_MAX_BYTES, backupCount=1, encoding="utf-8")
    except OSError:
        h = logging.StreamHandler(sys.stderr)
    h.setFormatter(fmt)
    log.addHandler(h)


def bind_exclusive(host: str, port: int) -> socket.socket:
    """Bind the listening socket BEFORE any model work, exclusively (Windows lets SO_REUSEADDR
    sockets share a port), so a second copy exits at once instead of loading a model. OSError if taken."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name == "nt":
        s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        s.bind((host, port))
        s.listen(64)
    except OSError:
        s.close()
        raise
    return s


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    # Benchmark winner (stt/README.md): large-v3-turbo int8_float16 beam 5 -> WER 1.29% vs base.en 2.73%,
    # 0.28 s p50 on 2-5 s clips, ~1.1 GB VRAM. distil-large-v3 ignored the vocabulary prompt (WER 6.2%).
    ap.add_argument("--model", default=os.environ.get("STT_MODEL", "large-v3-turbo"))
    ap.add_argument("--device", default=os.environ.get("STT_DEVICE", "cuda"), choices=("cuda", "cpu"))
    ap.add_argument("--compute-type", default=os.environ.get("STT_COMPUTE", "int8_float16"))
    ap.add_argument("--beam-size", type=int, default=int(os.environ.get("STT_BEAM", "5")))
    ap.add_argument("--prompt-mode", default=os.environ.get("STT_PROMPT_MODE", "initial"), choices=("initial", "hotwords", "both"))
    # Silero VAD before decoding: non-speech clips come back empty without a decode (benchmark: 0
    # false positives on the noise set with it, 4-6 without); partials skip it.
    ap.add_argument("--vad", default=os.environ.get("STT_VAD", "on"), choices=("on", "off"))
    ap.add_argument("--min-free-mb", type=int, default=MIN_FREE_VRAM_MB)
    ap.add_argument("--models-dir", default=str(MODELS_DIR))
    # Finals this server can't decode on the GPU go here (loopback whisper.cpp); "off" = answer 503.
    ap.add_argument("--fallback-url", default=os.environ.get("STT_FALLBACK_URL", FALLBACK_URL))
    # A load that left no model (too little VRAM, CUDA error) is retried: first wait, doubling to the cap.
    ap.add_argument("--retry-first-s", type=float, default=RETRY_BACKOFF[0])
    ap.add_argument("--retry-max-s", type=float, default=RETRY_BACKOFF[1])
    a = ap.parse_args(argv)

    setup_logging()
    try:
        fallback = None if a.fallback_url.strip().lower() in ("", "off", "none") else Fallback(a.fallback_url.strip())
    except ValueError as e:
        print(f"--fallback-url: {e}", file=sys.stderr)
        return 2
    try:
        sock = bind_exclusive(a.host, a.port)
    except OSError as e:
        print(f"port {a.port} is taken ({e}); another STT server is running", file=sys.stderr)
        return 0
    add_cuda_dlls()
    import uvicorn

    worker = Worker(real_loader, Path(a.models_dir), min_free_mb=a.min_free_mb, retry_backoff=(a.retry_first_s, max(a.retry_first_s, a.retry_max_s)))
    log.info("starting on %s:%d model=%s device=%s compute=%s beam=%d prompt_mode=%s vad=%s fallback=%s (pid %d)",
             a.host, a.port, a.model, a.device, a.compute_type, a.beam_size, a.prompt_mode, a.vad, fallback.url if fallback else "off", os.getpid())
    worker.load(a.model, a.device, a.compute_type)  # first job on the worker; /health answers meanwhile
    app = create_app(worker, beam_size=a.beam_size, prompt_mode=a.prompt_mode, vad=a.vad, fallback=fallback)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
