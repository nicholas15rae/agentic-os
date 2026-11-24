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
"""

from __future__ import annotations

import json
import math
from pathlib import Path

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
    _unknown(spec, TOP_KEYS, "spec")
    if spec.get("version") != 1:
        raise PolicyError(f"unsupported spec version {spec.get('version')!r} (expected 1)")
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
        _unknown(c, CLIP_KEYS, where)
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
        clips.append({"index": i, "path": str(path), "kind": kind, "in": round(t_in, 3), "out": round(t_out, 3),
                      "duration": round(dur, 3), "fade_s": min(fade, dur / 3), "has_audio": has_audio})

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
        _unknown(a, AUDIO_KEYS, where)
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
        layers.append({"index": j, "path": str(path), "start": round(start, 3), "in": round(t_in, 3),
                       "out": round(t_out, 3), "volume": vol})

    clip_vol = _num(spec.get("clip_audio_volume", 1.0), "clip_audio_volume", 0, 2)
    lufs = spec.get("loudness_lufs", -18)
    if lufs is not None and (isinstance(lufs, bool) or lufs not in LUFS_TARGETS):
        raise PolicyError(f"loudness_lufs must be -14, -16, -18 or null (got {lufs!r})")
    max_mb = spec.get("max_size_mb")
    if max_mb is not None:
        max_mb = _num(max_mb, "max_size_mb", 0.1, 4096)
    return {"project": project, "width": dims["width"], "height": dims["height"], "fps": fps,
            "clips": clips, "audio": layers, "clip_audio_volume": clip_vol,
            "loudness_lufs": float(lufs) if lufs is not None else None, "max_size_mb": max_mb,
            "total_duration": total}


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


def render(s: Settings, ctx: Ctx, plan: dict, out: Path, spec_path: Path) -> dict:
    ff.refuse_gpu_args(s, "x264")
    target = plan["loudness_lufs"]
    total = plan["total_duration"]
    max_mb = plan["max_size_mb"]

    measured = None
    if target is not None:
        ctx.stage("measuring loudness (pass 1)", 0.02)
        a_inputs, a_graph = _graph(plan, video=False, out_label="aout")
        measured = ff.measure_loudness(s, a_inputs, a_graph, target)
        ctx.check()

    inputs, graph = _graph(plan, video=True, out_label="amix")
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
        return ff.run_with_progress(cmd, total, lambda p: ctx.progress(base + p * (0.93 - base)), ctx.attach)

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
