"""Black-bar detection (letterbox / pillarbox / windowbox) with ffmpeg cropdetect.

A handful of points spread over a window of the clip are each fast-seeked (`-ss` before `-i`)
and a few frames decoded through `cropdetect` (CPU only). Samples that are entirely black (a
fade, a title gap) are ignored; the content rect is the UNION of the remaining samples' extents,
so a dark scene that reads smaller than the real picture can never shrink the result. Bars thinner
than BAR_MIN of the frame are treated as no bars (encoder edge noise) and that axis snaps to full.

Result:
    {"content": {"x", "y", "w", "h"},      even source pixels (the crop to use)
     "source": {"w", "h"},                 display size (rotation applied, as ffmpeg's filters see it)
     "confidence": 0-1,                    share of ALL samples whose own rect matches `content`
     "letterboxed": bool, "pillarboxed": bool,
     "window": {"start_s", "end_s"}, "samples": [{"t", "x", "y", "w", "h"} | {"t", "black": true}],
     "regions": [{"x", "y", "w", "h", "count"}]}   distinct rects seen (more than one = mixed framing)
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import ff
from .config import PolicyError, Settings

LIMIT = 24          # luma ≤ 24/255 counts as black
FRAMES = 4          # frames decoded per sample (cropdetect accumulates over them)
BAR_MIN = 0.02      # bars totalling under 2% of a dimension (or < 16 px) are ignored
MATCH_TOL = 0.02    # a sample "agrees" when every edge is within 2% of the dimension
MIN_EXTENT = 0.05   # a lit area smaller than 5% of a dimension is noise, not a picture

_RECT = re.compile(r"x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+)")


def _even_rect(x1: int, x2: int, y1: int, y2: int, W: int, H: int) -> dict:
    """Inclusive edges → an even x/y/w/h that still covers the lit area, clamped to the frame."""
    x = max(0, x1 - x1 % 2)
    y = max(0, y1 - y1 % 2)
    xe = min(W, x2 + 1 + (x2 + 1) % 2)
    ye = min(H, y2 + 1 + (y2 + 1) % 2)
    w = max(2, (xe - x) // 2 * 2)
    h = max(2, (ye - y) // 2 * 2)
    return {"x": x, "y": y, "w": w, "h": h}


def _sample(s: Settings, path: Path, t: float | None) -> tuple[int, int, int, int] | None:
    seek = ["-ss", f"{t:.3f}"] if t is not None else []
    r = ff.run([s.ffmpeg, "-hide_banner", "-nostats", "-threads", "1", *seek, "-i", str(path),
                "-an", "-sn", "-dn", "-frames:v", str(FRAMES),
                "-vf", f"cropdetect=limit={LIMIT}:round=2:reset=0:skip=0", "-f", "null", "-"], 120)
    found = _RECT.findall(r.stderr)
    if not found:
        return None
    return tuple(int(v) for v in found[-1])  # type: ignore[return-value]


def sample_times(duration: float, start_s: float, sample_s: float | None, n: int) -> tuple[float, float, list]:
    """n points at the centres of n equal slices of [start, end] (an image: one frame, no seek)."""
    if duration <= 0:
        return 0.0, 0.0, [None]
    start = min(max(0.0, start_s), max(0.0, duration - 0.05))
    end = duration if sample_s is None else min(duration, start + sample_s)
    span = max(0.0, end - start)
    if span < 0.2:
        return round(start, 3), round(end, 3), [start]
    return round(start, 3), round(end, 3), [start + span * (k + 0.5) / n for k in range(n)]


def detect(s: Settings, path: Path, sample_s: float | None = None, start_s: float = 0.0,
           samples: int = 8) -> dict:
    if sample_s is not None and (isinstance(sample_s, bool) or not sample_s > 0):
        raise PolicyError(f"sample_s must be a positive number of seconds (got {sample_s!r})")
    if isinstance(start_s, bool) or not start_s >= 0:
        raise PolicyError(f"start_s must be ≥ 0 (got {start_s!r})")
    if isinstance(samples, bool) or not isinstance(samples, int) or not 1 <= samples <= 24:
        raise PolicyError(f"samples must be an integer 1–24 (got {samples!r})")
    info = ff.probe(s, path)
    if not info["video"]:
        raise PolicyError(f"{path.name} has no picture")
    W, H = info["video"]["width"], info["video"]["height"]
    start, end, times = sample_times(info["duration_sec"], start_s, sample_s, samples)
    if info["duration_sec"] > 0 and start_s > info["duration_sec"]:
        raise PolicyError(f"start_s {start_s} is past the end of {path.name} ({info['duration_sec']}s)")

    with ThreadPoolExecutor(max_workers=max(1, min(4, s.threads, len(times)))) as pool:
        raw = list(pool.map(lambda t: _sample(s, path, t), times))

    rows, lit = [], []
    for t, r in zip(times, raw):
        tt = round(t, 3) if t is not None else 0.0
        if (r is None or r[1] - r[0] + 1 < W * MIN_EXTENT or r[3] - r[2] + 1 < H * MIN_EXTENT):
            rows.append({"t": tt, "black": True})
            continue
        rect = _even_rect(*r, W, H)
        rows.append({"t": tt, **rect})
        lit.append(rect)

    full = {"x": 0, "y": 0, "w": W, "h": H}
    if not lit:
        return {"content": full, "source": {"w": W, "h": H}, "confidence": 0.0, "letterboxed": False,
                "pillarboxed": False, "window": {"start_s": start, "end_s": end}, "samples": rows,
                "regions": [], "note": "every sample was black: no picture to measure"}

    x0 = min(r["x"] for r in lit)
    y0 = min(r["y"] for r in lit)
    x1 = max(r["x"] + r["w"] for r in lit)
    y1 = max(r["y"] + r["h"] for r in lit)
    content = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
    pillar = W - content["w"] >= max(16, W * BAR_MIN)
    letter = H - content["h"] >= max(16, H * BAR_MIN)
    if not pillar:
        content.update(x=0, w=W)
    if not letter:
        content.update(y=0, h=H)

    def same(a: dict, b: dict) -> bool:
        tx, ty = W * MATCH_TOL, H * MATCH_TOL
        return (abs(a["x"] - b["x"]) <= tx and abs(a["x"] + a["w"] - b["x"] - b["w"]) <= tx
                and abs(a["y"] - b["y"]) <= ty and abs(a["y"] + a["h"] - b["y"] - b["h"]) <= ty)

    def snapped(r: dict) -> dict:
        r = dict(r)
        if W - r["w"] < max(16, W * BAR_MIN):
            r.update(x=0, w=W)
        if H - r["h"] < max(16, H * BAR_MIN):
            r.update(y=0, h=H)
        return r

    regions: list[dict] = []
    for r in map(snapped, lit):
        hit = next((g for g in regions if same(g, r)), None)
        if hit:
            hit["count"] += 1
        else:
            regions.append({**r, "count": 1})
    regions.sort(key=lambda g: -g["count"])
    agree = sum(same(snapped(r), content) for r in lit)
    return {"content": content, "source": {"w": W, "h": H}, "confidence": round(agree / len(times), 3),
            "letterboxed": letter, "pillarboxed": pillar, "window": {"start_s": start, "end_s": end},
            "samples": rows, "regions": regions}
