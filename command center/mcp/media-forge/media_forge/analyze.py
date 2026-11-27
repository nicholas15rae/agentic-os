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


def _model(s: Settings, name: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise PolicyError("faster-whisper is not installed: run `uv sync --extra transcribe`") from e
    device = s.whisper_device
    if device != "cpu" and not s.allow_gpu:
        # The 12 GB GPU belongs to the local LLM unless the gateway says otherwise.
        raise PolicyError("GPU_BUSY: Whisper on CUDA is not allowed right now; it runs on CPU int8")
    key = (name, device, s.whisper_compute)
    with _model_lock:
        if key not in _model_cache:
            s.whisper_dir.mkdir(parents=True, exist_ok=True)
            _model_cache[key] = WhisperModel(name, device=device, compute_type=s.whisper_compute,
                                             download_root=str(s.whisper_dir), cpu_threads=s.threads)
        return _model_cache[key]


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
    lang = language or ("en" if model.endswith(".en") else None)
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
