"""media-forge-mcp: local media utilities for the Director agent (stdio MCP server).

Launch (gateway os.json entry):  uv --directory "<this folder>" run server.py
Heavy tools run as background jobs and wait up to `wait_s` (default 480 s, under the
gateway's 600 s per-call cap). If a job is still running the call returns its job id;
poll `job_status`. Every render ends with an ffprobe self-check (`verify`).
"""

from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from media_forge import analyze, config, ff, photos, timeline, video
from media_forge.config import PolicyError, next_version, project_dir, readable, writable
from media_forge.jobs import JobManager

S = config.load()
JOBS = JobManager(S)
mcp = FastMCP("media-forge")
MAX_WAIT = 540


async def _await_job(job_id: str, wait_s: float) -> dict:
    deadline = time.time() + min(max(wait_s, 0), MAX_WAIT)
    job = JOBS.get(job_id)
    while job.status in ("queued", "running") and time.time() < deadline:
        await asyncio.sleep(0.5)
    view = job.view()
    if job.status in ("queued", "running"):
        view["note"] = "still running: poll job_status with this job id"
    return view


async def _guard(fn, *args, **kwargs):
    """Run blocking work off the event loop; turn policy errors into readable tool errors."""
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except PolicyError as e:
        raise ValueError(str(e)) from None


def _out_path(slug: str | None, output: str | None, folder: str, stem: str, ext: str) -> Path:
    if output:
        return writable(S, output)
    if not slug:
        raise PolicyError("give either `project` (slug) or an absolute `output` path")
    return writable(S, str(next_version(project_dir(S, slug) / folder, stem, ext)))


# ── project + inspection ───────────────────────────────────────────────────────

@mcp.tool()
async def media_status() -> dict:
    """Server config: media root, binaries, CPU thread cap, GPU policy, whisper settings, recent jobs."""
    def run() -> dict:
        caption_ok = "subtitles" in ff.run([S.ffmpeg, "-hide_banner", "-filters"], 30).stdout
        return {"media_root": str(S.media_root), "ffmpeg": S.ffmpeg, "ffprobe": S.ffprobe,
                "ffmpeg_can_burn_captions": caption_ok, "cpu_threads": S.threads, "cpu_pct": S.cpu_pct,
                "gpu_allowed": S.allow_gpu, "max_jobs": S.max_jobs,
                "whisper": {"model": S.whisper_model, "device": S.whisper_device,
                            "compute": S.whisper_compute, "dir": str(S.whisper_dir)},
                "recent_jobs": JOBS.recent(5)}
    return await _guard(run)


@mcp.tool()
async def ensure_project(project: str) -> dict:
    """Create (or reuse) <media_root>/projects/<project>/{raw,working,renders}. Returns the paths.
    raw/ holds originals (read-only to this server), working/ intermediates (captions, scene
    thumbnails, stills, voiceover), renders/ finished versioned videos."""
    def run() -> dict:
        base = project_dir(S, project)
        return {"project": project, "root": str(base),
                **{sub: str(base / sub) for sub in config.PROJECT_SUBDIRS}}
    return await _guard(run)


@mcp.tool()
async def import_to_raw(project: str, source: str, rename_as: str | None = None) -> dict:
    """Copy a file that is already under the media root (e.g. a Drive download in an inbox folder)
    into the project's raw/ folder. The source is copied, never moved or modified."""
    def run() -> dict:
        src = readable(S, source)
        raw = project_dir(S, project) / "raw"
        name = rename_as or src.name
        if any(c in name for c in '\\/:*?"<>|'):
            raise PolicyError("rename_as must be a plain file name")
        dst = raw / name
        if dst.exists():
            raise PolicyError(f"raw/{name} already exists")
        shutil.copy2(src, dst)
        return {"path": str(dst), "probe": ff.probe(S, dst)}
    return await _guard(run)


@mcp.tool()
async def probe_media(path: str) -> dict:
    """FFprobe metadata: duration, fps, codecs, resolution, rotation, audio channels, bitrate, size."""
    return await _guard(lambda: ff.probe(S, readable(S, path)))


@mcp.tool()
async def detect_silence(path: str, threshold_db: float = -35.0, min_duration: float = 0.4,
                         pad: float = 0.25) -> dict:
    """Dead-air spans (start/end/duration) plus a suggested in/out that trims head and tail silence
    while keeping `pad` seconds of air. Use for self-tape walk-in / walk-out pauses."""
    def run() -> dict:
        p = readable(S, path)
        dur = ff.probe(S, p)["duration_sec"]
        spans = ff.silences(S, p, threshold_db, min_duration)
        t_in, t_out = ff.trim_points(spans, dur, pad)
        return {"duration": dur, "silences": spans, "suggested_in": t_in, "suggested_out": t_out,
                "mid_gaps": [x for x in spans if x["start"] > t_in + 0.05 and (x["end"] or dur) < t_out - 0.05]}
    return await _guard(run)


@mcp.tool()
async def verify_output(path: str, max_size_mb: float | None = None, width: int | None = None,
                        height: int | None = None, min_duration: float | None = None,
                        require_audio: bool = True) -> dict:
    """ffprobe self-check of a render: non-zero duration, A/V streams, resolution, size limit."""
    expect = {"max_size_mb": max_size_mb, "width": width, "height": height, "min_duration": min_duration,
              "require_audio": require_audio}
    return await _guard(lambda: video.verify(S, readable(S, path), expect))


# ── video jobs ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def quick_assemble(clips: list[dict], project: str | None = None, output: str | None = None,
                         preset: str = "web", normalize_audio: bool = True, lufs: float | None = None,
                         auto_trim: bool = False, silence_threshold_db: float = -35.0, trim_pad: float = 0.25,
                         fade_ms: int = 0, max_size_mb: float | None = None, width: int | None = None,
                         height: int | None = None, encoder: str = "x264", dry_run: bool = False,
                         wait_s: float = 480) -> dict:
    """Trim → (two-pass EBU R128 loudnorm) → concatenate → H.264/AAC MP4, then ffprobe-verify.

    clips: [{"path": abs path, "in"?: sec, "out"?: sec, "auto_trim"?: bool, "label"?: str}] in order.
    preset: self-tape (-18 LUFS), web (-16), short (-14). `lufs` overrides. `max_size_mb` targets a
    file size (casting limits). encoder: x264 (CPU, default) or nvenc (only when the GPU is free).
    dry_run returns the edit plan (resolved trims, format) without rendering.
    Output defaults to <project>/renders/<preset>_vNNN.mp4. Never touches raw/ files.
    """
    def plan() -> dict:
        ff.refuse_gpu_args(S, encoder)
        return video.plan_assembly(S, clips, auto_trim, silence_threshold_db, trim_pad, fade_ms, width, height)

    edit_plan = await _guard(plan)
    if dry_run:
        return {"dry_run": True, "edit_plan": edit_plan}
    out = await _guard(_out_path, project, output, "renders", preset, ".mp4")
    job = JOBS.start("assemble", f"{len(clips)} clips → {out.name}",
                     lambda ctx: video.assemble(S, ctx, edit_plan, out, preset, normalize_audio, lufs,
                                                max_size_mb, encoder))
    return await _await_job(job.id, wait_s)


@mcp.tool()
async def render_timeline(spec_path: str, output: str | None = None, project: str | None = None,
                          wait_s: float = 480) -> dict:
    """Render a timeline spec JSON (written by the Command Center) to an H.264/AAC MP4.

    spec (v1): {"version": 1, "project": slug, "width": even 320-3840, "height": even 320-3840,
    "fps": 10-60, "clips": [{"path", "kind": "video"|"image", "in", "out", "fade_ms": 0-2000}] (1-200;
    for images out-in is the hold, 0.2-60 s), "audio": [{"path", "start", "in", "out", "volume": 0-2}],
    "clip_audio_volume": 0-2, "loudness_lufs": -14|-16|-18|null (null = no normalisation),
    "max_size_mb": MB|null}. The spec file and every media path must be under the media root.
    Clips are trimmed/held, letterboxed to W x H and concatenated with their own audio; audio layers
    (voiceover, music) are delayed to `start` and mixed over it; then 2-pass EBU R128, CPU libx264,
    size cap and an ffprobe verify. Output: `output`, else <project>/renders/<spec name>_vNNN.mp4
    (`project` falls back to the spec's). Never touches raw/ files. Runs as a job like quick_assemble.

    spec v2 = v1 with "version": 2 and these optional keys (unknown keys are refused):
    clips[]: "transition_in": {"kind": "cut"|"crossfade"|"fade_black", "ms": 0-1500} (crossfade
    overlaps the previous clip, so the timeline shortens; not on clip 1), "punch_in": 1.0-1.5 (centre
    zoom), "transcript": abs path of that clip's transcribe_clip .json | null; audio[]: "fade_in_ms",
    "fade_out_ms": 0-10000, "duck_under_voice": bool (side-chain under the clip audio); "captions":
    {"enabled", "style": clean|bold_pop|karaoke|minimal, "position": lower|middle,
    "max_words_per_line": 1-12} (burned from the word timestamps, re-timed to each clip's in/out);
    "color": {"preset": none|warm|cool|punchy|film|bw, "strength": 0-1}. Still CPU libx264 only.
    """
    def prep() -> tuple[dict, Path, Path]:
        ff.refuse_gpu_args(S, "x264")
        spec = readable(S, spec_path)
        plan = timeline.load_spec(S, spec)
        slug = project or plan["project"]
        out = _out_path(slug, output, "renders", spec.stem or "render", ".mp4")
        return plan, spec, out

    plan, spec, out = await _guard(prep)
    job = JOBS.start("timeline", f"{len(plan['clips'])} clips → {out.name}",
                     lambda ctx: timeline.render(S, ctx, plan, out, spec))
    return await _await_job(job.id, wait_s)


@mcp.tool()
async def reframe_and_caption(input: str, aspect: str = "9:16", mode: str = "blur", srt_path: str | None = None,
                              burn_captions: bool = True, font_size: int = 18, project: str | None = None,
                              output: str | None = None, encoder: str = "x264", wait_s: float = 480) -> dict:
    """Convert to 9:16 / 4:5 / 1:1 / 16:9 (mode: crop | pad | blur background) and optionally add
    captions from an .srt (burned in, or as a soft subtitle track when burn_captions=false)."""
    def prep() -> tuple[Path, Path | None, Path]:
        ff.refuse_gpu_args(S, encoder)
        src = readable(S, input)
        srt = readable(S, srt_path) if srt_path else None
        out = _out_path(project, output, "renders", f"{src.stem}_{aspect.replace(':', 'x')}", ".mp4")
        return src, srt, out

    src, srt, out = await _guard(prep)
    job = JOBS.start("reframe", f"{src.name} → {aspect}",
                     lambda ctx: video.reframe(S, ctx, src, out, aspect, mode, srt, burn_captions, font_size, encoder))
    return await _await_job(job.id, wait_s)


@mcp.tool()
async def transcribe_clip(path: str, project: str | None = None, model: str | None = None,
                          language: str | None = None, word_timestamps: bool = True, wait_s: float = 480) -> dict:
    """Local faster-whisper (CPU int8 by default; never touches the LLM's GPU) with VAD.
    `model`: a name (`tiny.en`, looked up under WHISPER_MODEL_DIR) or an absolute model folder;
    default WHISPER_MODEL. Models are never downloaded: one that isn't on disk is an error.
    Writes .srt / .vtt / .json into <project>/working/captions when `project` is given (required for
    clips in raw/), else next to the clip. The .json has segments with word timestamps
    ({"w", "s", "e", "p"}), which render_timeline v2 burns as captions.
    Returns timestamped segments, first/last speech times (slate and line detection)."""
    name = model or S.whisper_model

    def prep() -> tuple[Path, Path]:
        analyze.resolve_model(S, name)
        return _caption_base(path, project)

    src, base = await _guard(prep)
    job = JOBS.start("transcribe", src.name,
                     lambda ctx: analyze.transcribe(S, ctx, src, base, name, language, word_timestamps))
    return await _await_job(job.id, wait_s)


def _caption_base(path: str, project: str | None, stem: str | None = None) -> tuple[Path, Path]:
    src = readable(S, path)
    if stem is not None and (not stem or any(c in stem for c in '\\/:*?"<>|') or stem in (".", "..")):
        raise PolicyError(f"output stem must be a plain file name (got {stem!r})")
    stem = stem or src.stem
    if project:
        base = project_dir(S, project) / "working" / "captions" / stem
    elif "raw" in (part.lower() for part in src.relative_to(S.media_root).parts[:-1]):
        raise PolicyError("the clip is in raw/: pass `project` so captions go to working/captions/")
    else:
        base = src.with_name(stem)
    writable(S, str(base.with_suffix(".srt")), overwrite=True)
    return src, base


@mcp.tool()
async def transcribe_batch(paths: list[str], project: str | None = None, model: str | None = None,
                           language: str | None = None, word_timestamps: bool = True,
                           output_stems: list[str] | None = None, wait_s: float = 480) -> dict:
    """transcribe_clip for up to 50 files, one after another in ONE job (one model load, CPU only).
    Same outputs per file as transcribe_clip; `output_stems` (same length as `paths`) names each
    .json/.srt/.vtt (e.g. the asset id) instead of the clip's own name. A file that fails is listed
    with its error and the batch carries on. Result: {model, count, done, failed, results: [{path,
    ok, json, srt, vtt, language, segment_count, first_speech_s, last_speech_s, text} | {path, ok:
    false, error}]}."""
    name = model or S.whisper_model

    def prep() -> list[tuple[Path, Path]]:
        if not paths or len(paths) > 50:
            raise PolicyError("paths must list 1–50 files")
        if output_stems is not None and len(output_stems) != len(paths):
            raise PolicyError("output_stems must have one entry per path")
        analyze.resolve_model(S, name)
        items = [_caption_base(p, project, output_stems[k] if output_stems else None)
                 for k, p in enumerate(paths)]
        bases = [str(b).lower() for _, b in items]
        if len(set(bases)) != len(bases):
            raise PolicyError("two files would write the same caption files: pass output_stems")
        return items

    items = await _guard(prep)
    job = JOBS.start("transcribe", f"{len(items)} clips",
                     lambda ctx: analyze.transcribe_batch(S, ctx, items, name, language, word_timestamps))
    return await _await_job(job.id, wait_s)


@mcp.tool()
async def detect_scenes(path: str, threshold: float = 27.0, min_scene_s: float = 0.6, project: str | None = None,
                        thumbnails: bool = True, wait_s: float = 480) -> dict:
    """Shot boundaries (PySceneDetect ContentDetector) with optional mid-shot thumbnails in
    <project>/working/scenes. Use for take selection and B-roll logging."""
    def prep() -> tuple[Path, Path | None]:
        src = readable(S, path)
        thumbs = project_dir(S, project) / "working" / "scenes" if (thumbnails and project) else None
        return src, thumbs

    src, thumbs = await _guard(prep)
    job = JOBS.start("scenes", src.name, lambda ctx: analyze.scenes(S, ctx, src, threshold, min_scene_s, thumbs))
    return await _await_job(job.id, wait_s)


# ── stills ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def process_photos(paths: list[str], project: str, operations: dict | None = None, format: str = "jpg",
                         quality: int = 92, wait_s: float = 480) -> dict:
    """Batch polish into <project>/working/stills (originals untouched). operations (all optional):
    auto_level (default true), white_balance, exposure / contrast / saturation (1.0 = unchanged),
    sharpen (default true), crop: 4:5 | 8x10 | headshot | 1:1 | 16:9 | 9:16 | 3:2 | 2:3,
    focus: face | center, long_edge: px, watermark: text."""
    def prep() -> tuple[list[Path], Path]:
        if not paths:
            raise PolicyError("no photos given")
        return [readable(S, p) for p in paths], project_dir(S, project) / "working" / "stills"

    srcs, out_dir = await _guard(prep)
    job = JOBS.start("photos", f"{len(srcs)} photos",
                     lambda ctx: photos.batch(S, ctx, srcs, out_dir, operations or {}, format, quality))
    return await _await_job(job.id, wait_s)


@mcp.tool()
async def contact_sheet(paths: list[str], project: str, columns: int = 4, cell_px: int = 360) -> dict:
    """A labelled grid of images (selects review, headshot proofs) saved to <project>/working/stills."""
    def run() -> dict:
        srcs = [readable(S, p) for p in paths]
        out = _out_path(project, None, "working/stills", "contact_sheet", ".jpg")
        return photos.contact_sheet(S, srcs, out, max(1, min(columns, 10)), max(120, min(cell_px, 800)))
    return await _guard(run)


@mcp.tool()
async def make_thumbnail(source: str, text: str, project: str, aspect: str = "16:9", at_sec: float | None = None,
                         subtitle: str | None = None) -> dict:
    """Text-on-frame thumbnail/cover from an image or a video frame (`at_sec`, default 1/3 in).
    aspect 16:9 (YouTube, 1280 wide) or 9:16 / 4:5 / 1:1 (covers, 1080 wide). Face-aware crop.
    Saved to <project>/working/stills."""
    def run() -> dict:
        src = readable(S, source)
        out = _out_path(project, None, "working/stills", f"thumb_{aspect.replace(':', 'x')}", ".jpg")
        return photos.thumbnail(S, src, at_sec, out, text, aspect, subtitle)
    return await _guard(run)


# ── jobs ───────────────────────────────────────────────────────────────────────

@mcp.tool()
async def job_status(job_id: str, wait_s: float = 0) -> dict:
    """Status of a background job: status, progress_pct, eta_s, stage, result (when done) or error.
    `wait_s` (≤540) blocks until the job ends or the wait runs out."""
    try:
        return await _await_job(job_id, wait_s)
    except PolicyError as e:
        raise ValueError(str(e)) from None


@mcp.tool()
async def job_cancel(job_id: str) -> dict:
    """Cancel a queued or running job (kills its ffmpeg). Partial outputs are removed."""
    try:
        return JOBS.cancel(job_id).view()
    except PolicyError as e:
        raise ValueError(str(e)) from None


@mcp.tool()
async def job_list(limit: int = 20) -> list[dict]:
    """Most recent jobs first."""
    return JOBS.recent(max(1, min(limit, 100)))


if __name__ == "__main__":
    mcp.run(transport="stdio")
