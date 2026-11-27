"""FFmpeg / FFprobe helpers: probing, silence detection, encoder policy, progress runs."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable

from .config import PolicyError, Settings

# Windows: no console window, below-normal priority so the UI and Tony stay responsive.
if sys.platform == "win32":
    CREATE_FLAGS = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
else:  # pragma: no cover
    CREATE_FLAGS = 0

GPU_ARG = re.compile(r"(nvenc|cuda|cuvid|qsv|amf|vaapi|videotoolbox|hwaccel|hwupload)", re.I)


def run(cmd: list[str], timeout: float = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=CREATE_FLAGS,
        stdin=subprocess.DEVNULL,
    )


def probe(s: Settings, path: Path) -> dict:
    r = run([s.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], 60)
    if r.returncode != 0:
        raise PolicyError(f"ffprobe could not read {path.name}: {r.stderr.strip()[-400:]}")
    raw = json.loads(r.stdout or "{}")
    fmt = raw.get("format", {})
    v = next((x for x in raw.get("streams", []) if x.get("codec_type") == "video" and not x.get("disposition", {}).get("attached_pic")), None)
    a = next((x for x in raw.get("streams", []) if x.get("codec_type") == "audio"), None)
    out: dict = {
        "path": str(path),
        "container": fmt.get("format_name"),
        "duration_sec": round(float(fmt.get("duration") or 0), 3),
        "size_bytes": int(fmt.get("size") or path.stat().st_size),
        "bitrate_kbps": round(int(fmt.get("bit_rate") or 0) / 1000),
        "video": None,
        "audio": None,
    }
    if v:
        num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
        fps = float(num) / float(den or 1) if float(den or 1) else 0.0
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(sd["rotation"])
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        if abs(rot) in (90, 270):
            w, h = h, w
        out["video"] = {"codec": v.get("codec_name"), "width": w, "height": h, "fps": round(fps, 3),
                        "pix_fmt": v.get("pix_fmt"), "rotation": rot}
    if a:
        out["audio"] = {"codec": a.get("codec_name"), "channels": a.get("channels"),
                        "sample_rate": int(a.get("sample_rate") or 0)}
    return out


_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)")


def silences(s: Settings, path: Path, threshold_db: float, min_duration: float) -> list[dict]:
    r = run([s.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn",
             "-af", f"silencedetect=n={threshold_db}dB:d={min_duration}", "-f", "null", "-"], 900)
    spans: list[dict] = []
    start: float | None = None
    for line in r.stderr.splitlines():
        if m := _SIL_START.search(line):
            start = max(0.0, float(m.group(1)))
        elif (m := _SIL_END.search(line)) and start is not None:
            spans.append({"start": round(start, 3), "end": round(float(m.group(1)), 3),
                          "duration": round(float(m.group(2)), 3)})
            start = None
    if start is not None:  # silence runs to the end of the file
        spans.append({"start": round(start, 3), "end": None, "duration": None})
    return spans


def trim_points(spans: list[dict], duration: float, pad: float = 0.25) -> tuple[float, float]:
    """Suggested in/out that drop dead air at the head and tail, keeping `pad` seconds of air."""
    t_in, t_out = 0.0, duration
    for sp in spans:
        if sp["start"] <= 0.05 and sp["end"]:
            t_in = max(0.0, sp["end"] - pad)
        end = sp["end"] if sp["end"] is not None else duration
        if end >= duration - 0.05 and sp["start"] > t_in:
            t_out = min(duration, sp["start"] + pad)
    if t_out - t_in < 0.5:  # all silence (or nearly): keep the clip whole
        return 0.0, duration
    return round(t_in, 3), round(t_out, 3)


def video_encoder(s: Settings, encoder: str, crf: int, bitrate_kbps: int | None) -> list[str]:
    """CPU libx264 by default. NVENC only when the gateway allows it (MEDIA_ALLOW_GPU=1)."""
    enc = (encoder or "x264").lower()
    if enc in ("nvenc", "h264_nvenc"):
        if not s.allow_gpu:
            raise PolicyError("GPU_BUSY: NVENC is not allowed right now; use encoder='x264'")
        args = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr"]
        args += ["-b:v", f"{bitrate_kbps}k"] if bitrate_kbps else ["-cq", str(crf + 3)]
        return args + ["-pix_fmt", "yuv420p"]
    if enc not in ("x264", "libx264"):
        raise PolicyError(f"unknown encoder '{encoder}' (use x264 or nvenc)")
    args = ["-c:v", "libx264", "-preset", "medium", "-threads", str(s.threads)]
    if bitrate_kbps:
        args += ["-b:v", f"{bitrate_kbps}k", "-maxrate", f"{int(bitrate_kbps * 1.5)}k",
                 "-bufsize", f"{bitrate_kbps * 2}k"]
    else:
        args += ["-crf", str(crf)]
    return args + ["-pix_fmt", "yuv420p", "-movflags", "+faststart"]


def refuse_gpu_args(s: Settings, *values: str) -> None:
    if s.allow_gpu:
        return
    for v in values:
        if v and GPU_ARG.search(v):
            raise PolicyError("GPU_BUSY: hardware/GPU options are disabled while the local LLM owns the GPU")


_TIME = re.compile(r"out_time_(?:us|ms)=(\d+)")


def run_with_progress(cmd: list[str], total_sec: float, on_progress: Callable[[float], None],
                      on_start: Callable[[subprocess.Popen], None], cwd: str | None = None) -> tuple[int, str]:
    """Run ffmpeg with `-progress pipe:1`, reporting 0..1. Returns (returncode, stderr tail)."""
    import threading

    full = cmd[:1] + ["-hide_banner", "-nostats", "-progress", "pipe:1"] + cmd[1:]
    proc = subprocess.Popen(full, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
                            creationflags=CREATE_FLAGS)
    on_start(proc)
    tail: list[str] = []

    def drain() -> None:
        assert proc.stderr
        for line in proc.stderr:
            tail.append(line.rstrip())
            del tail[:-40]

    t = threading.Thread(target=drain, daemon=True)
    t.start()
    assert proc.stdout
    for line in proc.stdout:
        if (m := _TIME.search(line)) and total_sec > 0:
            on_progress(min(0.999, int(m.group(1)) / 1_000_000 / total_sec))
    proc.wait()
    t.join(timeout=5)
    return proc.returncode, "\n".join(tail[-15:])


def measure_loudness(s: Settings, inputs: list[str], filter_graph: str, target: float) -> dict:
    """Pass 1 of two-pass EBU R128 loudnorm: returns the measured values."""
    cmd = [s.ffmpeg, "-hide_banner", "-nostats", *inputs, "-filter_complex",
           f"{filter_graph};[aout]loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json[ln]",
           "-map", "[ln]", "-f", "null", "-"]
    r = run(cmd, 1800)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        raise PolicyError(f"loudness measurement failed: {r.stderr.strip()[-400:]}")
    return json.loads(m.group(0))


def integrated_lufs(s: Settings, path: Path) -> float | None:
    r = run([s.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "ebur128", "-f", "null", "-"], 900)
    found = re.findall(r"I:\s*(-?[\d.]+) LUFS", r.stderr)
    return float(found[-1]) if found else None
