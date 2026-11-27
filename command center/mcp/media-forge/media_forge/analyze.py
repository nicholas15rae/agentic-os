"""Transcription (faster-whisper, CPU int8 by default) and scene detection (PySceneDetect)."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from . import ff
from .config import PolicyError, Settings
from .jobs import Ctx

_model_lock = threading.Lock()
_model_cache: dict[tuple, object] = {}


def _is_model_dir(p: Path) -> bool:
    return p.is_dir() and (p / "model.bin").is_file() and (p / "config.json").is_file()


def _hf_snapshot(root: Path, name: str) -> Path | None:
    """`<root>/models--Systran--faster-whisper-<name>/snapshots/<rev>/` (the HF cache layout that
    faster-whisper's own downloads leave behind), preferring the revision refs/main names."""
    repo = root / f"models--Systran--faster-whisper-{name}"
    snaps = repo / "snapshots"
    if not snaps.is_dir():
        return None
    try:
        main = (repo / "refs" / "main").read_text("utf-8").strip()
    except OSError:
        main = ""
    if main and _is_model_dir(snaps / main):
        return snaps / main
    found = sorted((d for d in snaps.iterdir() if _is_model_dir(d)), key=lambda d: d.stat().st_mtime)
    return found[-1] if found else None


def resolve_model(s: Settings, model: str) -> Path:
    """A local CTranslate2 Whisper model folder for a name (`tiny.en`) or an absolute folder path.

    Never downloads: a model that isn't on disk is an error that says where it was looked for.
    Names are looked up under WHISPER_MODEL_DIR as `<name>/`, `faster-whisper-<name>/` and the HF
    cache layout. A path that doesn't exist but is named `faster-whisper-<name>` falls back to the
    HF cache in its parent folder (that's where faster-whisper itself stores `tiny.en`)."""
    model = (model or "").strip()
    if not model:
        raise PolicyError("a whisper model name or folder is required")
    p = Path(model)
    if p.is_absolute():
        if _is_model_dir(p):
            return p
        if p.name.startswith("faster-whisper-"):
            snap = _hf_snapshot(p.parent, p.name[len("faster-whisper-"):])
            if snap:
                return snap
        raise PolicyError(f"no whisper model at {p} (needs model.bin + config.json); models are never "
                          "downloaded automatically")
    if any(c in model for c in "\\/:") or model in (".", ".."):
        raise PolicyError(f"whisper model must be a name like tiny.en or an absolute folder (got {model!r})")
    root = s.whisper_dir
    for cand in (root / model, root / f"faster-whisper-{model}"):
        if _is_model_dir(cand):
            return cand
    snap = _hf_snapshot(root, model)
    if snap:
        return snap
    raise PolicyError(f"whisper model {model!r} is not on disk under {root}; it is never downloaded "
                      "automatically. Use model='tiny.en' (already local) or fetch the model first "
                      "(small.en is a ~480 MB download: ask Nic)")


def _model(s: Settings, name: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise PolicyError("faster-whisper is not installed: run `uv sync --extra transcribe`") from e
    device = s.whisper_device
    if device != "cpu" and not s.allow_gpu:
        # The 12 GB GPU belongs to the local LLM unless the gateway says otherwise.
        raise PolicyError("GPU_BUSY: Whisper on CUDA is not allowed right now; it runs on CPU int8")
    folder = resolve_model(s, name)
    key = (str(folder), device, s.whisper_compute)
    with _model_lock:
        if key not in _model_cache:
            # A folder path + local_files_only: faster-whisper never reaches the network.
            _model_cache[key] = WhisperModel(str(folder), device=device, compute_type=s.whisper_compute,
                                             cpu_threads=s.threads, local_files_only=True)
        return _model_cache[key]


def model_label(name: str) -> str:
    """`tiny.en` for a name or a local snapshot/folder path (picks the `.en` language default)."""
    p = Path(name)
    if not p.is_absolute():
        return name
    for part in reversed(p.parts):
        if part.startswith("models--Systran--faster-whisper-"):
            return part[len("models--Systran--faster-whisper-"):]
        if part.startswith("faster-whisper-"):
            return part[len("faster-whisper-"):]
    return p.name


def _ts(t: float, sep: str) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    sec, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{sec:02d}{sep}{ms:03d}"


def _pcm16k(s: Settings, src: Path):
    """Mono 16 kHz float32 via our ffmpeg (avoids PyAV API drift; reads any container ffmpeg reads)."""
    import subprocess

    import numpy as np

    r = subprocess.run([s.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1",
                        "-ar", "16000", "-f", "f32le", "-"], capture_output=True, timeout=900,
                       creationflags=ff.CREATE_FLAGS, stdin=subprocess.DEVNULL)
    if r.returncode != 0 or not r.stdout:
        raise PolicyError(f"could not decode audio from {src.name}: {r.stderr.decode(errors='replace')[-300:]}")
    return np.frombuffer(r.stdout, dtype=np.float32)


def transcribe(s: Settings, ctx: Ctx, src: Path, out_base: Path, model: str, language: str | None,
               words: bool) -> dict:
    duration = ff.probe(s, src)["duration_sec"] or 1.0
    ctx.stage(f"loading whisper {model} ({s.whisper_device}/{s.whisper_compute})", 0.01)
    m = _model(s, model)
    lang = language or ("en" if model_label(model).endswith(".en") else None)
    ctx.stage("decoding audio", 0.03)
    audio = _pcm16k(s, src)
    ctx.stage("transcribing", 0.05)
    segments, info = m.transcribe(audio, language=lang, vad_filter=True, word_timestamps=words,
                                  beam_size=5, condition_on_previous_text=False)
    segs = []
    for seg in segments:  # a generator: decoding happens as we iterate
        ctx.check()
        item = {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()}
        if words and seg.words:
            item["words"] = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3),
                              "p": round(w.probability, 3)} for w in seg.words]
        segs.append(item)
        ctx.progress(0.05 + 0.93 * min(1.0, seg.end / duration))
    srt = out_base.with_suffix(".srt")
    vtt = out_base.with_suffix(".vtt")
    js = out_base.with_suffix(".json")
    srt.write_text("\n".join(f"{i}\n{_ts(x['start'], ',')} --> {_ts(x['end'], ',')}\n{x['text']}\n"
                             for i, x in enumerate(segs, 1)), "utf-8")
    vtt.write_text("WEBVTT\n\n" + "\n".join(f"{_ts(x['start'], '.')} --> {_ts(x['end'], '.')}\n{x['text']}\n"
                                            for x in segs), "utf-8")
    js.write_text(json.dumps({"language": info.language, "duration": duration, "segments": segs}), "utf-8")
    first_speech = segs[0]["start"] if segs else None
    last_speech = segs[-1]["end"] if segs else None
    return {"srt": str(srt), "vtt": str(vtt), "json": str(js), "language": info.language,
            "segment_count": len(segs), "first_speech_s": first_speech, "last_speech_s": last_speech,
            "text": " ".join(x["text"] for x in segs)[:4000],
            "segments": [{k: v for k, v in x.items() if k != "words"} for x in segs[:200]]}


class _SliceCtx:
    """A job Ctx view that maps 0..1 progress into [lo, hi) of the parent job (batch items)."""

    def __init__(self, ctx: Ctx, lo: float, hi: float, prefix: str) -> None:
        self._ctx, self._lo, self._hi, self._prefix = ctx, lo, hi, prefix
        self.cancel = ctx.cancel

    def _map(self, frac: float) -> float:
        return self._lo + (self._hi - self._lo) * max(0.0, min(1.0, frac))

    def progress(self, frac: float, stage: str | None = None) -> None:
        self._ctx.progress(self._map(frac), f"{self._prefix}: {stage}" if stage else None)

    def stage(self, name: str, frac: float | None = None) -> None:
        self._ctx.stage(f"{self._prefix}: {name}", self._map(frac) if frac is not None else None)

    def attach(self, proc) -> None:
        self._ctx.attach(proc)

    def check(self) -> None:
        self._ctx.check()


def transcribe_batch(s: Settings, ctx: Ctx, items: list[tuple[Path, Path]], model: str, language: str | None,
                     words: bool) -> dict:
    """Transcribe (src, out_base) pairs one after another in a single job, sharing one loaded model.
    A file that fails is reported and the batch moves on; cancelling stops the whole batch."""
    ctx.stage(f"checking whisper model {model_label(model)}", 0.0)
    resolve_model(s, model)  # fail the whole job up front if the model isn't on disk
    results = []
    n = len(items)
    for k, (src, base) in enumerate(items):
        ctx.check()
        sub = _SliceCtx(ctx, k / n, (k + 1) / n, f"{k + 1}/{n} {src.name}")
        try:
            res = transcribe(s, sub, src, base, model, language, words)
            results.append({"path": str(src), "ok": True, **{key: res[key] for key in (
                "srt", "vtt", "json", "language", "segment_count", "first_speech_s", "last_speech_s")},
                "text": res["text"][:400]})
        except PolicyError as e:
            results.append({"path": str(src), "ok": False, "error": str(e)})
    done = sum(r["ok"] for r in results)
    return {"model": model_label(model), "count": n, "done": done, "failed": n - done, "results": results}


def _sec(tc) -> float:
    """FrameTimecode seconds across PySceneDetect 0.6 (get_seconds) and 0.7 (.seconds)."""
    v = getattr(tc, "seconds", None)
    return float(v if v is not None and not callable(v) else tc.get_seconds())


def scenes(s: Settings, ctx: Ctx, src: Path, threshold: float, min_scene_s: float,
           thumbs_dir: Path | None) -> dict:
    try:
        from scenedetect import ContentDetector, detect
    except ImportError as e:
        raise PolicyError("PySceneDetect is not installed: run `uv sync --extra scenes`") from e
    info = ff.probe(s, src)
    fps = (info["video"] or {}).get("fps") or 30
    ctx.stage("detecting scenes", 0.05)
    found = detect(str(src), ContentDetector(threshold=threshold, min_scene_len=max(1, int(min_scene_s * fps))))
    ctx.check()
    out = []
    if not found:  # one continuous shot
        found = [(None, None)]
    for i, (a, b) in enumerate(found):
        start = _sec(a) if a is not None else 0.0
        end = _sec(b) if b is not None else info["duration_sec"]
        item = {"index": i, "start": round(start, 3), "end": round(end, 3), "duration": round(end - start, 3)}
        if thumbs_dir:
            thumbs_dir.mkdir(parents=True, exist_ok=True)
            frame = thumbs_dir / f"{src.stem}_scene{i + 1:03d}.jpg"
            if not frame.exists():
                ff.run([s.ffmpeg, "-y", "-ss", f"{(start + end) / 2:.3f}", "-i", str(src), "-frames:v", "1",
                        "-q:v", "3", str(frame)], 60)
            item["thumbnail"] = str(frame) if frame.exists() else None
        out.append(item)
        ctx.progress(0.5 + 0.5 * (i + 1) / len(found))
    return {"source": str(src), "scene_count": len(out), "scenes": out}
