"""Video jobs: assemble (trim + loudnorm + concat + size cap), reframe/caption, verify."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from . import ff
from .config import PolicyError, Settings
from .jobs import Ctx, cleanup_partial

ASPECTS = {"9:16": (1080, 1920), "4:5": (1080, 1350), "1:1": (1080, 1080), "16:9": (1920, 1080)}
PRESETS = {
    # target LUFS, audio kbps, crf
    "self-tape": (-18.0, 192, 20),
    "web": (-16.0, 192, 21),
    "short": (-14.0, 192, 22),
}


def verify(s: Settings, path: Path, expect: dict | None = None) -> dict:
    """ffprobe self-check: non-zero duration, streams present, resolution and size limits."""
    expect = expect or {}
    problems: list[str] = []
    if not path.is_file() or path.stat().st_size == 0:
        return {"ok": False, "problems": ["output file missing or empty"], "probe": None}
    info = ff.probe(s, path)
    if info["duration_sec"] <= 0:
        problems.append("duration is zero")
    if expect.get("require_video", True) and not info["video"]:
        problems.append("no video stream")
    if expect.get("require_audio", True) and not info["audio"]:
        problems.append("no audio stream")
    if (mx := expect.get("max_size_mb")) and info["size_bytes"] > mx * 1024 * 1024:
        problems.append(f"size {info['size_bytes'] / 1048576:.1f} MB is over the {mx} MB limit")
    if (mn := expect.get("min_duration")) and info["duration_sec"] < mn:
        problems.append(f"duration {info['duration_sec']}s is under {mn}s")
    if (dur := expect.get("duration")) and abs(info["duration_sec"] - dur) > max(0.5, dur * 0.02):
        problems.append(f"duration {info['duration_sec']}s, expected about {dur}s")
    v = info["video"] or {}
    for key in ("width", "height"):
        if expect.get(key) and v.get(key) != expect[key]:
            problems.append(f"{key} {v.get(key)} != {expect[key]}")
    return {"ok": not problems, "problems": problems, "probe": info}


def _even(n: float) -> int:
    return max(2, int(round(n / 2)) * 2)


def plan_assembly(s: Settings, clips: list[dict], auto_trim: bool, threshold_db: float, pad: float,
                  fade_ms: int, width: int | None, height: int | None) -> dict:
    """Resolve every clip's in/out (auto-trimming dead air) and the common output format."""
    if not clips:
        raise PolicyError("at least one clip is required")
    from .config import readable

    planned = []
    for i, c in enumerate(clips):
        path = readable(s, c.get("path", ""))
        info = ff.probe(s, path)
        if not info["video"]:
            raise PolicyError(f"clip {i + 1} has no video stream: {path.name}")
        dur = info["duration_sec"]
        t_in = float(c.get("in") or 0.0)
        t_out = float(c.get("out") or dur)
        trimmed = None
        if c.get("auto_trim", auto_trim) and info["audio"] and "in" not in c and "out" not in c:
            spans = ff.silences(s, path, threshold_db, 0.4)
            t_in, t_out = ff.trim_points(spans, dur, pad)
            trimmed = {"silences": spans[:20], "removed_head": t_in, "removed_tail": round(dur - t_out, 3)}
        if not (0 <= t_in < t_out <= dur + 0.05):
            raise PolicyError(f"clip {i + 1}: bad in/out {t_in}–{t_out} for a {dur}s clip")
        planned.append({"index": i, "path": str(path), "label": c.get("label") or path.stem,
                        "in": round(t_in, 3), "out": round(min(t_out, dur), 3),
                        "duration": round(min(t_out, dur) - t_in, 3), "has_audio": bool(info["audio"]),
                        "source": {"w": info["video"]["width"], "h": info["video"]["height"],
                                   "fps": info["video"]["fps"]}, "auto_trim": trimmed})
    first = planned[0]["source"]
    W = _even(width or first["w"])
    H = _even(height or first["h"])
    fps = first["fps"] if 10 <= first["fps"] <= 61 else 30.0
    fade = max(0, fade_ms) / 1000
    return {"clips": planned, "width": W, "height": H, "fps": round(fps, 3), "fade_s": fade,
            "total_duration": round(sum(c["duration"] for c in planned), 3)}


def _graph(plan: dict, video: bool) -> tuple[list[str], str]:
    """Input args + filter graph ending in [vcat] (if video) and [acat]."""
    inputs: list[str] = []
    parts: list[str] = []
    labels: list[str] = []
    W, H, fps, fade = plan["width"], plan["height"], plan["fps"], plan["fade_s"]
    n = len(plan["clips"])
    for c in plan["clips"]:
        inputs += ["-i", c["path"]]
    silent_idx = n
    for c in plan["clips"]:
        i, d = c["index"], c["duration"]
        f = min(fade, d / 3) if fade else 0
        if video:
            vf = (f"[{i}:v]trim=start={c['in']}:end={c['out']},setpts=PTS-STARTPTS,"
                  f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,"
                  f"setsar=1,fps={fps},format=yuv420p")
            if f:
                vf += f",fade=t=in:st=0:d={f:.3f},fade=t=out:st={d - f:.3f}:d={f:.3f}"
            parts.append(vf + f"[v{i}]")
        if c["has_audio"]:
            af = f"[{i}:a]atrim=start={c['in']}:end={c['out']},asetpts=PTS-STARTPTS,"
        else:
            inputs += ["-f", "lavfi", "-t", f"{d:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
            af = f"[{silent_idx}:a]"
            silent_idx += 1
        af += "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
        if f:
            af += f",afade=t=in:st=0:d={f:.3f},afade=t=out:st={d - f:.3f}:d={f:.3f}"
        parts.append(af + f"[a{i}]")
        labels.append((f"[v{i}]" if video else "") + f"[a{i}]")
    concat = "".join(labels) + f"concat=n={n}:v={1 if video else 0}:a=1"
    parts.append(concat + ("[vcat][acat]" if video else "[acat]"))
    return inputs, ";".join(parts)


def assemble(s: Settings, ctx: Ctx, plan: dict, out: Path, preset: str, normalize: bool,
             lufs: float | None, max_size_mb: float | None, encoder: str) -> dict:
    target: float | None
    target, akbps, crf = PRESETS.get(preset, PRESETS["web"])
    if lufs is not None:
        target = lufs
    if not normalize:
        target = None
    total = plan["total_duration"]

    measured = None
    if target is not None:
        ctx.stage("measuring loudness (pass 1)", 0.02)
        a_inputs, a_graph = _graph(plan, video=False)
        measured = ff.measure_loudness(s, a_inputs, a_graph.replace("[acat]", "[aout]"), target)
        ctx.check()

    inputs, graph = _graph(plan, video=True)
    if measured:
        graph += (f";[acat]loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={measured['input_i']}:"
                  f"measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:"
                  f"measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:"
                  f"linear=true,aresample=48000[aout]")
    else:
        graph += ";[acat]anull[aout]"

    def encode(vkbps: int | None) -> tuple[int, str]:
        cmd = [s.ffmpeg, "-y", *inputs, "-filter_complex", graph, "-map", "[vcat]", "-map", "[aout]",
               *ff.video_encoder(s, encoder, crf, vkbps), "-c:a", "aac", "-b:a", f"{akbps}k", "-ar", "48000",
               str(out)]
        base = 0.35 if measured else 0.02
        return ff.run_with_progress(cmd, total, lambda p: ctx.progress(base + p * (0.93 - base)), ctx.attach)

    vkbps = None
    if max_size_mb:
        vkbps = int(max_size_mb * 8192 * 0.94 / max(total, 0.1) - akbps)
        if vkbps < 250:
            raise PolicyError(f"{max_size_mb} MB is too small for {total:.0f}s of video (needs ≥250 kbps)")
    ctx.stage("encoding", 0.35 if measured else 0.02)
    attempts = []
    for attempt in range(2):
        code, tail = encode(vkbps)
        if ctx.cancel.is_set():
            cleanup_partial(out)
            ctx.check()
        if code != 0:
            cleanup_partial(out)
            raise PolicyError(f"ffmpeg failed (exit {code}): {tail[-600:]}")
        size_mb = out.stat().st_size / 1048576
        attempts.append({"video_kbps": vkbps, "size_mb": round(size_mb, 2)})
        if not max_size_mb or size_mb <= max_size_mb:
            break
        vkbps = int((vkbps or 4000) * max_size_mb / size_mb * 0.9)
        cleanup_partial(out)
    ctx.stage("verifying", 0.95)
    check = verify(s, out, {"max_size_mb": max_size_mb, "duration": total,
                            "width": plan["width"], "height": plan["height"]})
    measured_out = ff.integrated_lufs(s, out) if target is not None else None
    if target is not None and measured_out is not None and abs(measured_out - target) > 1.5:
        check["problems"].append(f"loudness {measured_out} LUFS is off the {target} target")
        check["ok"] = False
    return {"output": str(out), "verify": check, "edit_plan": plan, "loudness_target": target,
            "loudness_measured": measured_out, "encode_attempts": attempts, "preset": preset,
            "encoder": encoder, "cpu_threads": s.threads}


def reframe(s: Settings, ctx: Ctx, src: Path, out: Path, aspect: str, mode: str,
            srt: Path | None, burn: bool, font_size: int, encoder: str) -> dict:
    if aspect not in ASPECTS:
        raise PolicyError(f"aspect must be one of {', '.join(ASPECTS)}")
    W, H = ASPECTS[aspect]
    info = ff.probe(s, src)
    if mode == "crop":
        vf = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1"
    elif mode == "pad":
        vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    elif mode == "blur":
        vf = (f"split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:6[bg];"
              f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1")
    else:
        raise PolicyError("mode must be crop, pad or blur")

    work = Path(tempfile.mkdtemp(prefix="mf-"))
    try:
        cmd = [s.ffmpeg, "-y", "-i", str(src)]
        sub_args: list[str] = []
        if srt and burn:
            shutil.copyfile(srt, work / "subs.srt")  # relative name: no Windows path escaping in the filter
            margin = int(H * 0.08)
            style = (f"FontName=Arial,FontSize={font_size},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
                     f"BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV={margin // 4}")
            vf += f",subtitles=subs.srt:original_size={W}x{H}:force_style='{style}'"
        elif srt:
            cmd += ["-i", str(srt)]
            sub_args = ["-map", "1:0", "-c:s", "mov_text"]
        cmd += ["-filter_complex", f"[0:v]{vf}[vout]", "-map", "[vout]", "-map", "0:a?", *sub_args]
        cmd += [*ff.video_encoder(s, encoder, 21, None), "-c:a", "aac", "-b:a", "192k", str(out)]
        ctx.stage("rendering", 0.02)
        # ffmpeg resolves the relative subtitle name against its own cwd (the temp folder).
        code, tail = ff.run_with_progress(cmd, info["duration_sec"], lambda p: ctx.progress(0.02 + p * 0.93),
                                          ctx.attach, cwd=str(work))
        if ctx.cancel.is_set():
            cleanup_partial(out)
            ctx.check()
        if code != 0:
            cleanup_partial(out)
            raise PolicyError(f"ffmpeg failed (exit {code}): {tail[-600:]}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    ctx.stage("verifying", 0.96)
    check = verify(s, out, {"width": W, "height": H, "require_audio": bool(info["audio"]),
                            "duration": info["duration_sec"]})
    return {"output": str(out), "verify": check, "aspect": aspect, "mode": mode,
            "captions": "burned" if srt and burn else ("soft" if srt else None)}

