# media-forge-mcp

Local media utilities for the Command Center **Director** agent, served over stdio MCP. See
`docs/proposals/director-media-mcp-plan.md` for where it fits in the toolbelt alongside `shotcut-mcp`.

## Tools (17)

| Group | Tools |
|---|---|
| Project | `media_status`, `ensure_project`, `import_to_raw` |
| Inspect | `probe_media`, `detect_silence`, `detect_bars` (letterbox / pillarbox content rect via cropdetect), `verify_output` |
| Video jobs | `render_timeline` (JSON timeline spec from the Command Center: video + image clips, per-clip crop and fit pad / fill / blur to W×H (v2), fades, voiceover/music layers, 2-pass EBU R128, size cap), `quick_assemble` (trim → 2-pass EBU R128 → concat → H.264/AAC, size cap), `reframe_and_caption` (9:16 / 4:5 / 1:1 / 16:9, crop / pad / blur, burned or soft captions) |
| Analysis jobs | `transcribe_clip` (faster-whisper, CPU int8, VAD, word timestamps → .srt/.vtt/.json), `detect_scenes` (PySceneDetect + thumbnails) |
| Stills | `process_photos` (auto-level, WB, exposure, sharpen, face-aware crop, watermark), `contact_sheet`, `make_thumbnail` |
| Jobs | `job_status`, `job_cancel`, `job_list` |

Heavy tools start a background job and wait up to `wait_s` (≤ 540 s, under the gateway's 600 s per-call cap).
If still running, the call returns the job id; poll `job_status`.

## Project layout

`ensure_project` creates `<MEDIA_ROOT>/projects/<slug>/`:

| Folder | Holds |
|---|---|
| `raw/` | Originals. Read-only to this server. |
| `working/` | Intermediates: `captions/` (transcripts), `scenes/` (scene thumbnails), `stills/` (photo batch, contact sheets, thumbnails), `voiceover/`, `timeline/` (specs). |
| `renders/` | Finished videos from `render_timeline`, `quick_assemble` and `reframe_and_caption`. |

## render_timeline spec (v1)

```json
{ "version": 1, "project": "my-slug", "width": 1920, "height": 1080, "fps": 30,
  "clips": [ { "path": "C:\\...\\raw\\take1.mp4", "kind": "video", "in": 0.8, "out": 5.2, "fade_ms": 0 },
             { "path": "C:\\...\\raw\\slate.png",  "kind": "image", "in": 0,   "out": 3.0, "fade_ms": 250 } ],
  "audio": [ { "path": "C:\\...\\working\\voiceover\\vo_v001.webm", "start": 1.0, "in": 0, "out": 6.5, "volume": 1.0 } ],
  "clip_audio_volume": 1.0, "loudness_lufs": -18, "max_size_mb": null }
```

Limits: 1–200 clips; `kind` video | image; `0 ≤ in < out`; an image is held `out − in` seconds (0.2–60); a video `out` ≤ its duration + 0.05 s; `fade_ms` 0–2000 (fade in and out, from/to black); audio `volume` and `clip_audio_volume` 0–2; `start` ≥ 0; width/height even 320–3840; fps 10–60; `loudness_lufs` −14 / −16 / −18, or null for no normalisation (omitted = −18). Unknown keys are rejected. The spec file and every path must be under `MEDIA_ROOT`. Output: `output`, else `renders/<spec name>_vNNN.mp4` of `project` (or the spec's `project`).

## Rules it enforces

- Every path must be absolute and under `MEDIA_ROOT`. Nothing is ever written into a `raw/` folder.
- Outputs are versioned (`<stem>_v001.mp4`, `_v002` …). Nothing is overwritten.
- Encodes use CPU `libx264` capped at `MEDIA_CPU_PCT` of the cores (default 70%), at below-normal priority.
  NVENC, CUDA and other GPU options are refused (`GPU_BUSY`) unless `MEDIA_ALLOW_GPU=1`, which the gateway sets only when the LLM's GPU slot is free.
- Every render ends with an ffprobe self-check (duration, streams, resolution, size, loudness).

## Run

```powershell
uv sync --all-extras            # mcp<2, pillow, faster-whisper, scenedetect, opencv-headless<5
uv run pytest -q                # synthetic clips; set MF_TEST_WHISPER=<speech.wav> to include Whisper
uv --directory "<this folder>" run server.py   # what the gateway launches
```

| Env | Default |
|---|---|
| `MEDIA_ROOT` | `G:\ai-hub\media` |
| `MEDIA_FFMPEG` / `MEDIA_FFPROBE` | PATH, then Shotcut's bundled copy. Use the full build (winget `Gyan.FFmpeg`) for caption burn-in. |
| `MEDIA_CPU_PCT` | `70` |
| `MEDIA_ALLOW_GPU` | `0` |
| `MEDIA_MAX_JOBS` | `1` |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE` / `WHISPER_MODEL_DIR` | `tiny.en` (on disk; `small.en` is a ~480 MB opt-in download) / `cpu` / `int8` / `C:\ai-hub\models\faster-whisper` |

Smoke-test any stdio MCP the way the gateway talks to it: `python ..\mcp_smoke.py --call media_status "{}" -- uv --directory . run server.py`.
