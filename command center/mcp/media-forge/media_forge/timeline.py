"""Render a timeline spec (JSON written by the Command Center backend) to an H.264/AAC MP4.

Spec v1:
    {"version": 1, "project": "my-slug", "width": 1920, "height": 1080, "fps": 30,
     "clips": [{"path": abs, "kind": "video"|"image", "in": s, "out": s, "fade_ms": 0}, ...],
     "audio": [{"path": abs, "start": s, "in": s, "out": s, "volume": 1.0}, ...],
     "clip_audio_volume": 1.0, "loudness_lufs": -18 | -16 | -14 | null, "max_size_mb": null | MB}

Every clip is trimmed (video) or held (image), letterboxed to W×H, conformed to fps / yuv420p /
SAR 1 and concatenated with its own audio (silence for images and silent videos). Audio layers
(voiceover, music) are trimmed, delayed to `start` and mixed over the clip audio. Then two-pass
EBU R128 loudnorm (unless lufs is null), CPU libx264, size cap, ffprobe verify.

Spec v2 = v1 plus (every new key optional, defaults shown; a v1 spec must not carry them):
    clips[]:  "transition_in": {"kind": "cut"|"crossfade"|"fade_black", "ms": 0-1500} ({"cut", 0}),
              "punch_in": 1.0-1.5 (1.0), "transcript": abs path to a transcribe_clip JSON | null (null),
              "crop": {"x", "y", "w", "h"} | null (null): all four, even integers ≥ 0, w/h ≥ 16, inside
                      the probed (rotation-applied) source frame; cut first, before punch-in / fit,
              "fit": "pad"|"fill"|"blur" ("pad")
    audio[]:  "fade_in_ms": 0-10000 (0), "fade_out_ms": 0-10000 (0), "duck_under_voice": bool (false)
    "captions": {"enabled": bool, "style": "clean"|"bold_pop"|"karaoke"|"minimal",
                 "position": "lower"|"middle", "max_words_per_line": 1-12} ({false, clean, lower, 5})
    "color":    {"preset": "none"|"warm"|"cool"|"punchy"|"film"|"bw", "strength": 0-1} ({none, 0.6})

A crossfade overlaps a clip with the one before it (xfade + acrossfade), so the timeline gets
shorter by its length; fade_black dips the previous clip's end and this clip's start through
black (no overlap; on the first clip it fades up from black). The first clip can't crossfade. A
transition is capped at 45% of the shorter neighbouring clip. punch_in crops the centre before the
usual letterbox scale. Ducked layers are side-chain compressed under the clip audio bus. Captions
are built from word timestamps re-timed onto the output (captions.py) and burned with `ass`; the
colour look (eq / colorbalance / curves / hue) goes on before the captions so text stays neutral.
v1 specs keep the exact v1 graph (`_graph`).

Framing (added to v2 2026-11; a v2 spec without crop/fit renders byte-for-byte the same graph):
  pad  = [crop] → punch-in centre crop → scale to fit → black pad (the original v2 behaviour)
  fill = [crop] → scale to COVER W·z × H·z (z = punch_in) → centre-crop W×H (no bars, edges lost)
  blur = [crop] → punch-in → split: background cover-scaled at ¼ size, box-blurred, scaled back up
         and darkened; foreground scaled to fit; overlaid centred (the Reels look for 16:9 in 9:16)
Pair `crop` with detect_bars' content rect for pillarboxed / letterboxed sources.
"""

from __future__ import annotations

import json
import math
import shutil
import tempfile
from pathlib import Path

from . import captions as cap_mod
from . import ff
from .config import SLUG_RE, PolicyError, Settings, readable
from .jobs import Ctx, cleanup_partial
from .video import verify

TOP_KEYS = {"version", "project", "width", "height", "fps", "clips", "audio", "clip_audio_volume",
            "loudness_lufs", "max_size_mb"}
CLIP_KEYS = {"path", "kind", "in", "out", "fade_ms"}
AUDIO_KEYS = {"path", "start", "in", "out", "volume"}
LUFS_TARGETS = (-14, -16, -18)
AUDIO_KBPS = 192
CRF = 20
AFMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"

SPEC_VERSIONS = (1, 2)
TOP_KEYS_V2 = TOP_KEYS | {"captions", "color"}
CLIP_KEYS_V2 = CLIP_KEYS | {"transition_in", "punch_in", "transcript", "crop", "fit"}
CROP_KEYS = {"x", "y", "w", "h"}
CROP_MIN = 16
FITS = ("pad", "fill", "blur")
# blur fit: the background is cover-scaled at a quarter size, blurred, scaled back up and darkened.
BLUR_BG = "boxblur=8:2"
BLUR_DARKEN = "eq=brightness=-0.08:saturation=0.85"
AUDIO_KEYS_V2 = AUDIO_KEYS | {"fade_in_ms", "fade_out_ms", "duck_under_voice"}
TRANSITIONS = ("cut", "crossfade", "fade_black")
TRANSITION_MAX_MS = 1500
TRANSITION_CAP = 0.45  # of the shorter neighbouring clip
LAYER_FADE_MAX_MS = 10000
CAPTION_KEYS = {"enabled", "style", "position", "max_words_per_line"}
CAPTION_DEFAULT = {"enabled": False, "style": "clean", "position": "lower", "max_words_per_line": 5}
COLOR_KEYS = {"preset", "strength"}
COLOR_PRESETS = ("none", "warm", "cool", "punchy", "film", "bw")
COLOR_DEFAULT = {"preset": "none", "strength": 0.6}
# Side-chain duck: roughly -10 to -12 dB under speech, quick in, slow out.
DUCK = "sidechaincompress=threshold=0.02:ratio=8:attack=20:release=350:makeup=1:knee=4"


def _num(v, what: str, lo: float | None = None, hi: float | None = None) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise PolicyError(f"{what} must be a number (got {v!r})")
    if lo is not None and v < lo:
        raise PolicyError(f"{what} must be ≥ {lo} (got {v})")
    if hi is not None and v > hi:
        raise PolicyError(f"{what} must be ≤ {hi} (got {v})")
    return float(v)


def _unknown(d: dict, allowed: set[str], where: str) -> None:
    extra = sorted(set(d) - allowed)
    if extra:
        raise PolicyError(f"{where}: unknown key(s) {', '.join(extra)}")


def load_spec(s: Settings, spec_path: Path) -> dict:
    """Parse + strictly validate a spec file; returns the resolved render plan."""
    try:
        spec = json.loads(spec_path.read_text("utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise PolicyError(f"could not read the timeline spec {spec_path.name}: {e}") from None
    if not isinstance(spec, dict):
        raise PolicyError("the timeline spec must be a JSON object")
    version = spec.get("version")
    if isinstance(version, bool) or version not in SPEC_VERSIONS:
        raise PolicyError(f"unsupported spec version {version!r} (expected 1 or 2)")
    v2 = version == 2
    _unknown(spec, TOP_KEYS_V2 if v2 else TOP_KEYS, "spec")
    project = spec.get("project")
    if project is not None and (not isinstance(project, str) or not SLUG_RE.match(project)):
        raise PolicyError("spec.project must be a slug (a-z, 0-9, dashes) or null")

    dims = {}
    for key in ("width", "height"):
        v = spec.get(key)
        if isinstance(v, bool) or not isinstance(v, int) or not 320 <= v <= 3840 or v % 2:
            raise PolicyError(f"{key} must be an even integer 320–3840 (got {v!r})")
        dims[key] = v
    fps = _num(spec.get("fps"), "fps", 10, 60)

    clips_in = spec.get("clips")
    if not isinstance(clips_in, list) or not 1 <= len(clips_in) <= 200:
        raise PolicyError("clips must be a list of 1–200 entries")
    clips = []
    for i, c in enumerate(clips_in):
        where = f"clip {i + 1}"
        if not isinstance(c, dict):
            raise PolicyError(f"{where}: must be an object")
        _unknown(c, CLIP_KEYS_V2 if v2 else CLIP_KEYS, where)
        kind = c.get("kind")
        if kind not in ("video", "image"):
            raise PolicyError(f"{where}: kind must be 'video' or 'image' (got {kind!r})")
        path = readable(s, c.get("path") or "")
        t_in = _num(c.get("in", 0), f"{where} in", 0)
        t_out = _num(c.get("out"), f"{where} out")
        if not t_in < t_out:
            raise PolicyError(f"{where}: in ({t_in}) must be before out ({t_out})")
        fade = _num(c.get("fade_ms", 0), f"{where} fade_ms", 0, 2000) / 1000
        info = ff.probe(s, path)
        if not info["video"]:
            raise PolicyError(f"{where}: {path.name} has no picture ({kind})")
        has_audio = False
        if kind == "image":
            hold = t_out - t_in
            if not 0.2 <= hold <= 60:
                raise PolicyError(f"{where}: an image is held 0.2–60 s (got {hold:g} s)")
            dur = hold
        else:
            src = info["duration_sec"]
            if t_out > src + 0.05:
                raise PolicyError(f"{where}: out {t_out} is past the end of {path.name} ({src}s)")
            t_out = min(t_out, src) if src > 0 else t_out
            if not t_in < t_out:
                raise PolicyError(f"{where}: in ({t_in}) is at or past the end of {path.name} ({src}s)")
            dur = t_out - t_in
            has_audio = bool(info["audio"])
        item = {"index": i, "path": str(path), "kind": kind, "in": round(t_in, 3), "out": round(t_out, 3),
                "duration": round(dur, 3), "fade_s": min(fade, dur / 3), "has_audio": has_audio}
        if v2:
            item.update(_clip_v2(s, c, where, kind, i, info["video"]))
        clips.append(item)

    audio_in = spec.get("audio", [])
    if audio_in is None:
        audio_in = []
    if not isinstance(audio_in, list) or len(audio_in) > 32:
        raise PolicyError("audio must be a list of up to 32 layers")
    total = round(sum(c["duration"] for c in clips), 3)
    layers = []
    for j, a in enumerate(audio_in):
        where = f"audio {j + 1}"
        if not isinstance(a, dict):
            raise PolicyError(f"{where}: must be an object")
        _unknown(a, AUDIO_KEYS_V2 if v2 else AUDIO_KEYS, where)
        path = readable(s, a.get("path") or "")
        start = _num(a.get("start", 0), f"{where} start", 0)
        t_in = _num(a.get("in", 0), f"{where} in", 0)
        vol = _num(a.get("volume", 1.0), f"{where} volume", 0, 2)
        info = ff.probe(s, path)
        if not info["audio"]:
            raise PolicyError(f"{where}: {path.name} has no audio stream")
        src = info["duration_sec"]
        t_out = _num(a["out"], f"{where} out") if a.get("out") is not None else src
        if not t_in < t_out:
            raise PolicyError(f"{where}: in ({t_in}) must be before out ({t_out})")
        if src > 0 and t_out > src + 0.05:
            raise PolicyError(f"{where}: out {t_out} is past the end of {path.name} ({src}s)")
        t_out = min(t_out, src) if src > 0 else t_out
        layer = {"index": j, "path": str(path), "start": round(start, 3), "in": round(t_in, 3),
                 "out": round(t_out, 3), "volume": vol}
        if v2:
            layer.update(_layer_v2(a, where, t_out - t_in))
        layers.append(layer)

    clip_vol = _num(spec.get("clip_audio_volume", 1.0), "clip_audio_volume", 0, 2)
    lufs = spec.get("loudness_lufs", -18)
    if lufs is not None and (isinstance(lufs, bool) or lufs not in LUFS_TARGETS):
        raise PolicyError(f"loudness_lufs must be -14, -16, -18 or null (got {lufs!r})")
    max_mb = spec.get("max_size_mb")
    if max_mb is not None:
        max_mb = _num(max_mb, "max_size_mb", 0.1, 4096)
    plan = {"project": project, "width": dims["width"], "height": dims["height"], "fps": fps,
            "clips": clips, "audio": layers, "clip_audio_volume": clip_vol,
            "loudness_lufs": float(lufs) if lufs is not None else None, "max_size_mb": max_mb,
            "total_duration": total}
    if v2:
        _finish_v2(spec, plan)
    return plan


# ── spec v2 validation ──────────────────────────────────────────────────────────

def _obj(v, where: str, allowed: set[str]) -> dict:
    if not isinstance(v, dict):
        raise PolicyError(f"{where} must be an object")
    _unknown(v, allowed, where)
    return v


def _crop_v2(c: dict, where: str, src: dict) -> dict | None:
    crop = c.get("crop")
    if crop is None:
        return None
    crop = _obj(crop, f"{where} crop", CROP_KEYS)
    missing = sorted(CROP_KEYS - set(crop))
    if missing:
        raise PolicyError(f"{where}: crop needs x, y, w and h (missing {', '.join(missing)})")
    for k in ("x", "y", "w", "h"):
        v = crop[k]
        if isinstance(v, bool) or not isinstance(v, int):
            raise PolicyError(f"{where}: crop.{k} must be an integer number of source pixels (got {v!r})")
        if v % 2:
            raise PolicyError(f"{where}: crop.{k} must be even (got {v})")
        if v < 0:
            raise PolicyError(f"{where}: crop.{k} must be ≥ 0 (got {v})")
    if crop["w"] < CROP_MIN or crop["h"] < CROP_MIN:
        raise PolicyError(f"{where}: crop must be at least {CROP_MIN}x{CROP_MIN} (got {crop['w']}x{crop['h']})")
    W, H = src["width"], src["height"]
    if crop["x"] + crop["w"] > W or crop["y"] + crop["h"] > H:
        raise PolicyError(f"{where}: crop {crop['w']}x{crop['h']} at {crop['x']},{crop['y']} runs outside "
                          f"the {W}x{H} source")
    return {"x": crop["x"], "y": crop["y"], "w": crop["w"], "h": crop["h"]}


def _clip_v2(s: Settings, c: dict, where: str, kind: str, i: int, src: dict) -> dict:
    tr = c.get("transition_in")
    tr = _obj(tr, f"{where} transition_in", {"kind", "ms"}) if tr is not None else {}
    t_kind = tr.get("kind", "cut")
    if t_kind not in TRANSITIONS:
        raise PolicyError(f"{where}: transition_in.kind must be cut, crossfade or fade_black (got {t_kind!r})")
    ms = _num(tr.get("ms", 0), f"{where} transition_in.ms", 0, TRANSITION_MAX_MS)
    if t_kind == "crossfade" and i == 0:
        raise PolicyError(f"{where}: the first clip has nothing to crossfade from (use cut or fade_black)")
    if t_kind == "cut" or ms == 0:
        t_kind, ms = "cut", 0.0
    punch = _num(c.get("punch_in", 1.0), f"{where} punch_in", 1.0, 1.5)
    transcript = c.get("transcript")
    if transcript is not None:
        if not isinstance(transcript, str):
            raise PolicyError(f"{where}: transcript must be an absolute path or null")
        if kind != "video":
            raise PolicyError(f"{where}: an image has no speech to caption (transcript must be null)")
        tp = readable(s, transcript)
        if tp.suffix.lower() != ".json":
            raise PolicyError(f"{where}: transcript must be a transcribe_clip .json file")
        cap_mod.load_words(tp)  # strict parse now, not halfway through a render
        transcript = str(tp)
    fit = c.get("fit", "pad")
    if fit not in FITS:
        raise PolicyError(f"{where}: fit must be pad, fill or blur (got {fit!r})")
    return {"transition": t_kind, "transition_s": ms / 1000, "punch_in": punch, "transcript": transcript,
            "crop": _crop_v2(c, where, src), "fit": fit}


def _layer_v2(a: dict, where: str, length: float) -> dict:
    fi = _num(a.get("fade_in_ms", 0), f"{where} fade_in_ms", 0, LAYER_FADE_MAX_MS) / 1000
    fo = _num(a.get("fade_out_ms", 0), f"{where} fade_out_ms", 0, LAYER_FADE_MAX_MS) / 1000
    if fi + fo > length > 0:  # both fades fit inside the layer, in proportion
        k = length / (fi + fo)
        fi, fo = fi * k, fo * k
    duck = a.get("duck_under_voice", False)
    if not isinstance(duck, bool):
        raise PolicyError(f"{where}: duck_under_voice must be true or false (got {duck!r})")
    return {"fade_in_s": round(fi, 3), "fade_out_s": round(fo, 3), "duck": duck}


def _finish_v2(spec: dict, plan: dict) -> None:
    """Cap transitions, lay the clips onto the output timeline, validate captions and colour."""
    clips = plan["clips"]
    for k, c in enumerate(clips):
        if c["transition"] != "cut":
            shorter = c["duration"] if k == 0 else min(c["duration"], clips[k - 1]["duration"])
            c["transition_s"] = round(min(c["transition_s"], shorter * TRANSITION_CAP), 3)
    t = 0.0
    for c in clips:
        if c["transition"] == "crossfade":
            t -= c["transition_s"]
        c["start"] = round(t, 3)
        t += c["duration"]
    plan["total_duration"] = round(t, 3)

    cap = spec.get("captions")
    cap = dict(CAPTION_DEFAULT, **_obj(cap, "captions", CAPTION_KEYS)) if cap is not None else dict(CAPTION_DEFAULT)
    if not isinstance(cap["enabled"], bool):
        raise PolicyError(f"captions.enabled must be true or false (got {cap['enabled']!r})")
    if cap["style"] not in cap_mod.STYLES:
        raise PolicyError(f"captions.style must be one of {', '.join(cap_mod.STYLES)} (got {cap['style']!r})")
    if cap["position"] not in cap_mod.POSITIONS:
        raise PolicyError(f"captions.position must be lower or middle (got {cap['position']!r})")
    mw = cap["max_words_per_line"]
    if isinstance(mw, bool) or not isinstance(mw, int) or not 1 <= mw <= 12:
        raise PolicyError(f"captions.max_words_per_line must be an integer 1–12 (got {mw!r})")
    if cap["enabled"] and not any(c["transcript"] for c in clips):
        raise PolicyError("captions are on but no clip has a transcript (run transcribe_clip first)")

    col = spec.get("color")
    col = dict(COLOR_DEFAULT, **_obj(col, "color", COLOR_KEYS)) if col is not None else dict(COLOR_DEFAULT)
    if col["preset"] not in COLOR_PRESETS:
        raise PolicyError(f"color.preset must be one of {', '.join(COLOR_PRESETS)} (got {col['preset']!r})")
    col["strength"] = _num(col["strength"], "color.strength", 0, 1)
    plan.update(version=2, captions=cap, color=col)


def color_filter(color: dict) -> str | None:
    """The colour look as a filter chain (None when it is a no-op)."""
    p, k = color["preset"], color["strength"]
    if p == "none" or k <= 0:
        return None

    def f(v: float) -> str:
        return f"{v:.3f}"

    if p == "warm":
        return (f"colorbalance=rs={f(0.08 * k)}:bs={f(-0.08 * k)}:rm={f(0.05 * k)}:bm={f(-0.05 * k)}:"
                f"rh={f(0.03 * k)}:bh={f(-0.03 * k)},eq=saturation={f(1 + 0.08 * k)}")
    if p == "cool":
        return (f"colorbalance=rs={f(-0.06 * k)}:bs={f(0.08 * k)}:rm={f(-0.04 * k)}:bm={f(0.06 * k)},"
                f"eq=saturation={f(1 - 0.05 * k)}")
    if p == "punchy":
        return f"eq=contrast={f(1 + 0.18 * k)}:saturation={f(1 + 0.35 * k)}:gamma={f(1 - 0.04 * k)}"
    if p == "film":  # lifted blacks, soft highlights, teal shadows / warm highlights, less saturation
        return (f"curves=all='0/{f(0.06 * k)} 0.5/0.5 1/{f(1 - 0.05 * k)}',"
                f"colorbalance=rs={f(-0.04 * k)}:bs={f(0.05 * k)}:rh={f(0.05 * k)}:bh={f(-0.04 * k)},"
                f"eq=saturation={f(1 - 0.18 * k)}")
    # bw: strength 1 = full black and white, plus a touch of contrast
    return f"hue=s={f(1 - k)},eq=contrast={f(1 + 0.1 * k)}"


def _graph(plan: dict, video: bool, out_label: str) -> tuple[list[str], str]:
    """Input args + filter graph: [vcat] (if video) and the mixed audio as [out_label]."""
    W, H, fps = plan["width"], plan["height"], plan["fps"]
    inputs: list[str] = []
    parts: list[str] = []
    seg: list[str] = []
    n_in = 0

    def add(*args: str) -> int:
        nonlocal n_in
        inputs.extend(args)
        n_in += 1
        return n_in - 1

    # Clip inputs first (images only when the picture is needed), then layers, then silences.
    idx: dict[int, int] = {}
    for c in plan["clips"]:
        if c["kind"] == "video":
            idx[c["index"]] = add("-i", c["path"])
        elif video:
            idx[c["index"]] = add("-loop", "1", "-framerate", f"{fps:g}", "-t", f"{c['duration']:.3f}",
                                  "-i", c["path"])
    layer_idx = [add("-i", a["path"]) for a in plan["audio"]]

    for c in plan["clips"]:
        i, d, f = c["index"], c["duration"], c["fade_s"]
        if video:
            k = idx[i]
            vf = (f"[{k}:v]trim=start={c['in']}:end={c['out']}" if c["kind"] == "video"
                  else f"[{k}:v]trim=duration={d:.3f}")
            vf += (f",setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                   f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps:g},format=yuv420p")
            if f:
                vf += f",fade=t=in:st=0:d={f:.3f},fade=t=out:st={d - f:.3f}:d={f:.3f}"
            parts.append(vf + f"[v{i}]")
        if c["has_audio"]:
            af = f"[{idx[i]}:a]atrim=start={c['in']}:end={c['out']},asetpts=PTS-STARTPTS,{AFMT}"
        else:
            k = add("-f", "lavfi", "-t", f"{d:.3f}", "-i", "anullsrc=r=48000:cl=stereo")
            af = f"[{k}:a]{AFMT}"
        # Pad/cut to the exact clip length so picture and sound stay locked across the concat.
        af += f",apad,atrim=end={d:.3f},volume={plan['clip_audio_volume']:g}"
        if f and c["has_audio"]:
            af += f",afade=t=in:st=0:d={f:.3f},afade=t=out:st={d - f:.3f}:d={f:.3f}"
        parts.append(af + f"[a{i}]")
        seg.append((f"[v{i}]" if video else "") + f"[a{i}]")
    n = len(plan["clips"])
    parts.append("".join(seg) + f"concat=n={n}:v={1 if video else 0}:a=1" + ("[vcat][acat]" if video else "[acat]"))

    if plan["audio"]:
        mix = ["[acat]"]
        for a, k in zip(plan["audio"], layer_idx):
            ms = int(round(a["start"] * 1000))
            parts.append(f"[{k}:a]atrim=start={a['in']}:end={a['out']},asetpts=PTS-STARTPTS,{AFMT},"
                         f"volume={a['volume']:g},adelay={ms}|{ms}[l{a['index']}]")
            mix.append(f"[l{a['index']}]")
        parts.append("".join(mix) + f"amix=inputs={len(mix)}:duration=first:normalize=0[{out_label}]")
    else:
        parts.append(f"[acat]anull[{out_label}]")
    return inputs, ";".join(parts)


def _even_up(v: float) -> int:
    return int(math.ceil(v / 2 - 1e-9)) * 2


def _frame_v2(c: dict, vf: str, W: int, H: int, fps: float) -> tuple[list[str], str]:
    """Crop + fit a trimmed clip chain to W×H. Returns (finished side chains, the main chain so far,
    which ends conformed: setsar=1, fps, yuv420p). Without crop / fit this is exactly the old pad."""
    i = c["index"]
    z = c["punch_in"]
    if c.get("crop"):
        r = c["crop"]
        vf += f",crop={r['w']}:{r['h']}:{r['x']}:{r['y']}"
    tail = f",setsar=1,fps={fps:g},format=yuv420p"
    fit = c.get("fit", "pad")
    if fit == "fill":
        # Cover the output (punch_in zooms the covered frame), centre-crop to W×H. One resample.
        zw, zh = (W, H) if z <= 1.0 else (_even_up(W * z), _even_up(H * z))
        return [], vf + f",scale={zw}:{zh}:force_original_aspect_ratio=increase,crop={W}:{H}" + tail
    if z > 1.0:
        zs = f"{z:g}"
        vf += f",crop=trunc(iw/{zs}/2)*2:trunc(ih/{zs}/2)*2"
    if fit == "blur":
        bw, bh = max(2, W // 4 // 2 * 2), max(2, H // 4 // 2 * 2)
        side = [vf + f",split=2[bg{i}][fg{i}]",
                f"[bg{i}]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},{BLUR_BG},"
                f"scale={W}:{H},{BLUR_DARKEN}[bb{i}]",
                f"[fg{i}]scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fs{i}]"]
        return side, f"[bb{i}][fs{i}]overlay=(W-w)/2:(H-h)/2" + tail
    return [], vf + (f",scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                     f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black") + tail


def _graph_v2(plan: dict, video: bool, out_label: str, ass_name: str | None = None) -> tuple[list[str], str]:
    """Spec v2 graph: per-clip punch-in and fades, joined by concat (runs of cuts) and xfade +
    acrossfade (crossfades); layers faded, optionally ducked under the clip audio, then mixed.
    The picture ends as [vcat] with the colour look and burned captions applied."""
    W, H, fps = plan["width"], plan["height"], plan["fps"]
    clips = plan["clips"]
    inputs: list[str] = []
    parts: list[str] = []
    n_in = 0

    def add(*args: str) -> int:
        nonlocal n_in
        inputs.extend(args)
        n_in += 1
        return n_in - 1

    idx: dict[int, int] = {}
    for c in clips:
        if c["kind"] == "video":
            idx[c["index"]] = add("-i", c["path"])
        elif video:
            idx[c["index"]] = add("-loop", "1", "-framerate", f"{fps:g}", "-t", f"{c['duration']:.3f}",
                                  "-i", c["path"])
    layer_idx = [add("-i", a["path"]) for a in plan["audio"]]

    for pos, c in enumerate(clips):
        i, d, f = c["index"], c["duration"], c["fade_s"]
        # fade_black: this clip rises from black over half the transition (all of it on clip 1)
        # and the clip before it sinks to black over the other half.
        nxt = clips[pos + 1] if pos + 1 < len(clips) else None
        b_in = (c["transition_s"] / (1 if pos == 0 else 2)) if c["transition"] == "fade_black" else 0
        b_out = nxt["transition_s"] / 2 if nxt and nxt["transition"] == "fade_black" else 0
        if video:
            k = idx[i]
            vf = (f"[{k}:v]trim=start={c['in']}:end={c['out']}" if c["kind"] == "video"
                  else f"[{k}:v]trim=duration={d:.3f}")
            vf += ",setpts=PTS-STARTPTS"
            pre, vf = _frame_v2(c, vf, W, H, fps)
            parts.extend(pre)
            if f:
                vf += f",fade=t=in:st=0:d={f:.3f},fade=t=out:st={d - f:.3f}:d={f:.3f}"
            if b_in:
                vf += f",fade=t=in:st=0:d={b_in:.3f}"
            if b_out:
                vf += f",fade=t=out:st={d - b_out:.3f}:d={b_out:.3f}"
            parts.append(vf + f",settb=AVTB[v{i}]")
        if c["has_audio"]:
            af = f"[{idx[i]}:a]atrim=start={c['in']}:end={c['out']},asetpts=PTS-STARTPTS,{AFMT}"
        else:
            k = add("-f", "lavfi", "-t", f"{d:.3f}", "-i", "anullsrc=r=48000:cl=stereo")
            af = f"[{k}:a]{AFMT}"
        af += f",apad,atrim=end={d:.3f},volume={plan['clip_audio_volume']:g}"
        if c["has_audio"]:
            if f:
                af += f",afade=t=in:st=0:d={f:.3f},afade=t=out:st={d - f:.3f}:d={f:.3f}"
            if b_in:
                af += f",afade=t=in:st=0:d={b_in:.3f}"
            if b_out:
                af += f",afade=t=out:st={d - b_out:.3f}:d={b_out:.3f}"
        parts.append(af + f"[a{i}]")

    # Runs of cuts are concatenated; the runs are chained with xfade / acrossfade.
    runs: list[list[dict]] = []
    for c in clips:
        if not runs or c["transition"] == "crossfade":
            runs.append([])
        runs[-1].append(c)
    run_len: list[float] = []
    for r, run in enumerate(runs):
        run_len.append(sum(c["duration"] for c in run))
        if len(run) == 1:
            i = run[0]["index"]
            if video:
                parts.append(f"[v{i}]null[vr{r}]")
            parts.append(f"[a{i}]anull[ar{r}]")
            continue
        seg = "".join((f"[v{c['index']}]" if video else "") + f"[a{c['index']}]" for c in run)
        parts.append(seg + f"concat=n={len(run)}:v={1 if video else 0}:a=1"
                     + (f"[vr{r}][ar{r}]" if video else f"[ar{r}]"))
    v_acc, a_acc, acc_len = "[vr0]", "[ar0]", run_len[0]
    for r in range(1, len(runs)):
        x = runs[r][0]["transition_s"]
        if video:
            parts.append(f"{v_acc}[vr{r}]xfade=transition=fade:duration={x:.3f}:offset={acc_len - x:.3f}[vx{r}]")
            v_acc = f"[vx{r}]"
        parts.append(f"{a_acc}[ar{r}]acrossfade=d={x:.3f}:c1=tri:c2=tri[ax{r}]")
        a_acc = f"[ax{r}]"
        acc_len += run_len[r] - x
    if video:
        tail = [t for t in (color_filter(plan["color"]), f"ass={ass_name}" if ass_name else None) if t]
        parts.append(f"{v_acc}{','.join([*tail, 'format=yuv420p'])}[vcat]")

    total = plan["total_duration"]
    if not plan["audio"]:
        parts.append(f"{a_acc}anull[{out_label}]")
        return inputs, ";".join(parts)
    ducked = [a for a in plan["audio"] if a["duck"]]
    if ducked:  # one copy of the clip bus for the mix, one per ducked layer as its side-chain key
        parts.append(f"{a_acc}asplit={len(ducked) + 1}[acat]" + "".join(f"[sc{a['index']}]" for a in ducked))
    else:
        parts.append(f"{a_acc}anull[acat]")
    mix = ["[acat]"]
    for a, k in zip(plan["audio"], layer_idx):
        j, ms = a["index"], int(round(a["start"] * 1000))
        length = a["out"] - a["in"]
        lf = f"[{k}:a]atrim=start={a['in']}:end={a['out']},asetpts=PTS-STARTPTS,{AFMT},volume={a['volume']:g}"
        if a["fade_in_s"]:
            lf += f",afade=t=in:st=0:d={a['fade_in_s']:.3f}"
        if a["fade_out_s"]:
            lf += f",afade=t=out:st={max(0.0, length - a['fade_out_s']):.3f}:d={a['fade_out_s']:.3f}"
        lf += f",adelay={ms}|{ms}"
        if a["duck"]:
            # Padded to the bus length so the compressor never stalls on the shorter input.
            parts.append(lf + f",apad,atrim=end={total:.3f}[lp{j}]")
            parts.append(f"[lp{j}][sc{j}]{DUCK}[l{j}]")
        else:
            parts.append(lf + f"[l{j}]")
        mix.append(f"[l{j}]")
    parts.append("".join(mix) + f"amix=inputs={len(mix)}:duration=first:normalize=0[{out_label}]")
    return inputs, ";".join(parts)


def render(s: Settings, ctx: Ctx, plan: dict, out: Path, spec_path: Path) -> dict:
    if plan.get("version") == 2:
        return _render_v2(s, ctx, plan, out, spec_path)
    return _render(s, ctx, plan, out, spec_path)


def _render_v2(s: Settings, ctx: Ctx, plan: dict, out: Path, spec_path: Path) -> dict:
    """Captions are written as captions.ass in a temp folder ffmpeg runs in (a relative name means
    no Windows drive-colon escaping inside the filter); a copy is kept next to the render."""
    work = Path(tempfile.mkdtemp(prefix="mf-tl-"))
    ass_name, lines, sidecar = None, 0, None
    try:
        if plan["captions"]["enabled"]:
            ctx.stage("building captions", 0.01)
            text, lines = cap_mod.timeline_ass(plan)
            (work / "captions.ass").write_text(text, "utf-8")
            ass_name = "captions.ass"

        def graph(p: dict, video: bool, out_label: str) -> tuple[list[str], str]:
            return _graph_v2(p, video, out_label, ass_name if video else None)

        res = _render(s, ctx, plan, out, spec_path, graph_fn=graph, cwd=str(work))
        if ass_name:
            sidecar = out.with_suffix(".ass")
            if not sidecar.exists():
                shutil.copyfile(work / ass_name, sidecar)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    res.update(spec_version=2, crossfades=sum(c["transition"] == "crossfade" for c in plan["clips"]),
               captions={"enabled": bool(ass_name), "style": plan["captions"]["style"], "lines": lines,
                         "ass_path": str(sidecar) if sidecar else None},
               color=plan["color"], ducked_layers=sum(a["duck"] for a in plan["audio"]),
               fits={f: sum(c["fit"] == f for c in plan["clips"]) for f in FITS},
               cropped_clips=sum(bool(c["crop"]) for c in plan["clips"]))
    return res


def _render(s: Settings, ctx: Ctx, plan: dict, out: Path, spec_path: Path, graph_fn=None,
            cwd: str | None = None) -> dict:
    """Shared two-pass loudnorm + encode + size cap + verify. v1 uses `_graph` exactly as before."""
    graph_fn = graph_fn or _graph
    ff.refuse_gpu_args(s, "x264")
    target = plan["loudness_lufs"]
    total = plan["total_duration"]
    max_mb = plan["max_size_mb"]

    measured = None
    if target is not None:
        ctx.stage("measuring loudness (pass 1)", 0.02)
        a_inputs, a_graph = graph_fn(plan, video=False, out_label="aout")
        measured = ff.measure_loudness(s, a_inputs, a_graph, target)
        ctx.check()

    inputs, graph = graph_fn(plan, video=True, out_label="amix")
    if measured:
        graph += (f";[amix]loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={measured['input_i']}:"
                  f"measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:"
                  f"measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:"
                  f"linear=true,aresample=48000[aout]")
    else:
        graph += ";[amix]anull[aout]"
    base = 0.3 if measured else 0.02

    def encode(vkbps: int | None) -> tuple[int, str]:
        cmd = [s.ffmpeg, "-y", *inputs, "-filter_complex", graph, "-map", "[vcat]", "-map", "[aout]",
               *ff.video_encoder(s, "x264", CRF, vkbps), "-c:a", "aac", "-b:a", f"{AUDIO_KBPS}k", "-ar", "48000",
               "-t", f"{total:.3f}", str(out)]
        return ff.run_with_progress(cmd, total, lambda p: ctx.progress(base + p * (0.93 - base)), ctx.attach,
                                    cwd=cwd)

    vkbps = None
    if max_mb:
        vkbps = int(max_mb * 8192 * 0.94 / max(total, 0.1) - AUDIO_KBPS)
        if vkbps < 250:
            raise PolicyError(f"{max_mb} MB is too small for {total:.0f}s of video (needs ≥250 kbps)")
    ctx.stage("encoding", base)
    for _attempt in range(2):
        code, tail = encode(vkbps)
        if ctx.cancel.is_set():
            cleanup_partial(out)
            ctx.check()
        if code != 0:
            cleanup_partial(out)
            raise PolicyError(f"ffmpeg failed (exit {code}): {tail[-600:]}")
        size_mb = out.stat().st_size / 1048576
        if not max_mb or size_mb <= max_mb:
            break
        vkbps = int((vkbps or 4000) * max_mb / size_mb * 0.9)
        cleanup_partial(out)

    ctx.stage("verifying", 0.95)
    check = verify(s, out, {"max_size_mb": max_mb, "duration": total,
                            "width": plan["width"], "height": plan["height"]})
    measured_out = ff.integrated_lufs(s, out) if target is not None else None
    if target is not None and measured_out is not None and abs(measured_out - target) > 1.5:
        check["problems"].append(f"loudness {measured_out} LUFS is off the {target} target")
        check["ok"] = False
    dur = (check.get("probe") or {}).get("duration_sec")
    return {"output": str(out), "verify": check, "duration_sec": dur, "loudness_target": target,
            "loudness_measured": measured_out, "width": plan["width"], "height": plan["height"],
            "clips": len(plan["clips"]), "audio_layers": len(plan["audio"]), "encoder": "x264",
            "cpu_threads": s.threads, "spec_path": str(spec_path)}
