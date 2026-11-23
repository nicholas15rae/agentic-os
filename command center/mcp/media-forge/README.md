# media-forge-mcp

Local media utilities for the Command Center **Director** agent, served over stdio MCP. See
`docs/proposals/director-media-mcp-plan.md` for where it fits in the toolbelt alongside `shotcut-mcp`.

## Tools (16)

| Group | Tools |
|---|---|
| Project | `media_status`, `ensure_project`, `import_to_raw` |
| Inspect | `probe_media`, `detect_silence`, `verify_output` |
| Video jobs | `quick_assemble` (trim → 2-pass EBU R128 → concat → H.264/AAC, size cap), `reframe_and_caption` (9:16 / 4:5 / 1:1 / 16:9, crop / pad / blur, burned or soft captions) |
| Analysis jobs | `transcribe_clip` (faster-whisper, CPU int8, VAD, word timestamps → .srt/.vtt/.json), `detect_scenes` (PySceneDetect + thumbnails) |
| Stills | `process_photos` (auto-level, WB, exposure, sharpen, face-aware crop, watermark), `contact_sheet`, `make_thumbnail` |
| Jobs | `job_status`, `job_cancel`, `job_list` |

Heavy tools start a background job and wait up to `wait_s` (≤ 540 s, under the gateway's 600 s per-call cap).
If still running, the call returns the job id; poll `job_status`.

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
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE` / `WHISPER_MODEL_DIR` | `small.en` / `cpu` / `int8` / `C:\ai-hub\models\faster-whisper` |

Smoke-test any stdio MCP the way the gateway talks to it: `python ..\mcp_smoke.py --call media_status "{}" -- uv --directory . run server.py`.
