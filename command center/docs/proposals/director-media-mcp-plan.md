# Director Agent — MCP Toolbelt: Audit, Catalog, Gaps, Install & Integration Plan

Status: **proposal (Phase 1 + MCP research)** · 2026-11-22 · nothing installed or changed yet.

---

## 1. What the "gateway" actually is (audit)

There is **no separate MCP gateway process**. The Tauri app's Rust code is the MCP client; "gateway" in code means the FastAPI `server.py` on :8080 (phone sync hub), which has nothing to do with MCP.

| Concern | Where | Fact that matters for the Director |
|---|---|---|
| Registry | `%APPDATA%\os.agentic.commandcenter\os.json` → `mcps[]` (`OsConfig.mcps`, `os_core.rs:791`; struct `os_core.rs:193-232`) | A new MCP = one JSON entry. Defaults in `default_mcps()` (`os_core.rs:334-370`) are back-filled at load. |
| Entry fields | `id, name, transport (builtin\|stdio\|http), command, args, env, url, enabled, builtin, description, agents, timeoutSecs (5–600), cwd, readOnly` | Ids `[A-Za-z0-9_-]{1,48}`, **no dots** (tools are `<id>.<tool>`). |
| Spawn | `mcp_session.rs` — one persistent stdio child per id, `CREATE_NO_WINDOW`, kill-on-close Job Object, 5-min idle reaper | Renders spawned by an MCP die with the app. Good. |
| Timeouts | startup 120 s for `uv/uvx/npx`, else 45 s; per call `max(60, timeoutSecs)` (`mcp.rs:588-604`) | **Hard cap 600 s per tool call** → long renders must be job-based (start / status / cancel). |
| Health | no ping; `tools/list` result + call stats, cached 10 min (`mcp.rs:875-970`), warm-up at launch (`mcp.rs:900`) | "Healthy" = lists tools. Add a real smoke call for media servers (see §6). |
| Progress | `notifications/progress` are **dropped** (`mcp_session.rs:147-161`) | Render progress must come from polling a status tool and re-emitting a Tauri event. |
| Permissions | `agents` grants + `role_refusal` / `is_mutating_tool` (`mcp.rs:368,489`); `default_mcp_grants` (`os_core.rs:302-316`); `policy_for` (`roles.rs:102-115`) gives every agent except librarian/coder `READ_ONLY` | **Director must get a write policy in `roles.rs`**, otherwise every edit/render tool is refused. |
| HTTP/remote | `transport:"http"` supported; `env` entries become headers; host-bound bearer tokens (`mcp.rs:183-216, 1721-1728`) | **No OAuth browser flow / dynamic client registration.** Canva, Dropbox, Adobe, ElevenLabs, Google's hosted Drive MCP all need it. |
| UI | `McpRegistryCard` in `src/sections/settings/LibrarySettings.tsx` (Settings → Integrations); toggles via `features/integrations/mcp-enable.ts` | Adding/disabling servers works today with no code change. |
| Exe lookup | `exe_resolve.rs` (env PATH → app PATH → registry PATH → `~/.local/bin`, WinGet, uv, npm…) | Shotcut's folder is **not** on PATH — pass absolute paths via `env`. |
| Long child + progress pattern | `claude_fix.rs:466-607` (job, line reader, deadline, cancel, `emit`) | Template for Rust-side render runner if we bypass MCP for renders. |

### Local tooling found on this machine

| Tool | Status |
|---|---|
| Shotcut **26.11.15** at `C:\Program Files\Shotcut\` | ✅ ships `melt.exe`, `ffmpeg.exe`/`ffprobe.exe` (n9.0.2), `whisper-cli.exe` (whisper.cpp) |
| Bundled ffmpeg encoders | ✅ `libx264`, `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`, `aac` |
| Bundled ffmpeg filters | ✅ `loudnorm`, `ebur128`, `silencedetect`, `scdet`, `crop`, `cropdetect` · ❌ **no `subtitles`/`ass`/`drawtext`** (no caption burn-in) |
| ffmpeg / ImageMagick on PATH | ❌ none |
| Python 3.11, `uv`/`uvx`, Node/`npx` | ✅ |
| Python libs | Pillow ✅ · faster-whisper ❌ · scenedetect ❌ · rembg ❌ |
| GPU | RTX 3060 12 GB, driver 610.88 |
| Existing Whisper | whisper.cpp `whisper-server` on `127.0.0.1:8178` = **Tony's live STT**, does not take the GPU slot (`services.rs:359-445`, `voice.rs:126`) |

> ⚠️ **Never point media transcription at :8178.** An 8-minute take would block Tony's speech recognition. The Director gets its own CPU-int8 transcriber.

---

## 2. Candidate MCP catalog (evaluated)

Verdict key: **Adopt** · **Wrap** (adopt behind config/pins) · **Stub** (disabled entry, documented) · **Build** (we write it) · **Reject**.

### Tier 1 — local, required for autonomy

| Capability | Choice | Repo / runtime | Verdict | Why |
|---|---|---|---|---|
| Multi-track timeline, transitions, filters, MLT render, QC | **shotcut-mcp** | `matrodrigs/shotcut-mcp` · Python stdlib (no `mcp` dep) · MIT · pushed 2026-11-03 · Windows CI | **Adopt** | 28 tools incl. `plan_project_edit`, transactional `edit_project`, `analyze_media_quality` (silence/black/freeze/R128), `render_preview`, `render_contact_sheet`, **`start_render`/`render_status`/`cancel_render`** (fits the 600 s cap), `detect_hardware_encoders`, backups. Needs Shotcut ≥ 26.8.1 — we have 26.11.15. |
| Probe, silence trim, loudnorm, concat, reframe, captions, transcription, scenes, photos | **media-forge-mcp** | in-repo Python, `mcp>=1.6,<2`, uv project | **Build** | No single maintained server covers this with our GPU policy. See §3. |
| Fallback ffmpeg toolbox | `kajisho5/ffmpeg-skill` (42 tools) / `Ashutos1997/ffmpeg-mcp-server` (19 tools, Node) | Python stdlib / Node | **Reject for now** (read for ideas) | ffmpeg-skill: star count looks inflated, `setup` runs a winget install — supply-chain risk for a server we'd give write access. Ashutos: auto-selects NVENC. Both overlap media-forge. Revisit after a code review if media-forge stalls. |

### Tier 1 — cloud delivery

| Capability | Choice | Verdict | Why |
|---|---|---|---|
| Google Drive list / download / upload / share link | **`taylorwilsdon/google_workspace_mcp`** (`uvx workspace-mcp --tools drive --tool-tier core`) · Python · MIT · 3.6k★ · active | **Wrap** | Has upload + permissions/share; uses your own Google OAuth client (same one `GoogleCard` already stores). Keep its token store **separate** from gmail-multi's `~/.gmail-mcp/tokens.db`. |
| Google's hosted Drive MCP (`drivemcp.googleapis.com`) | — | **Stub** | Developer Preview, no share-link tool, needs gateway OAuth. |
| `@modelcontextprotocol/server-gdrive` | — | **Reject** | Archived, read-only. |
| Dropbox (official hosted, `https://mcp.dropbox.com/mcp`) | — | **Stub** | 24 tools incl. shared links; blocked on gateway OAuth (gap G6). |

### Tier 2 — pro / optional (disabled by default)

| Capability | Choice | Verdict | Notes |
|---|---|---|---|
| Canva (thumbnails, covers, MP4/PNG export) | **Official Canva MCP** `https://mcp.canva.com/mcp` (Streamable HTTP, OAuth) | **Stub → Adopt after G6** | Autofill/resize/brand templates need Canva Pro. The community `falcoschaefer99-eng` server is redundant → reject. |
| Adobe — hosted "Adobe for Creativity" `https://adobe-creativity.adobe.io/mcp` | Auto-tone, crop, select subject, quick-cut, resize | **Stub** | Uploads media to Adobe cloud; cannot open Premiere projects. |
| Adobe — local Photoshop/Premiere | `mikechambers/adb-mcp` (UXP proxy, PoC) | **Stub** | `BunsDev/adobe-mcp` = one-day dump → reject; `AJSMonty/adobe-mcp` = macOS AppleScript only → reject. Adobe's local CC MCP is private beta early 2027 — re-evaluate then. |
| DaVinci Resolve | `samuelgursky/davinci-resolve-mcp` (4.3k★, active) | **Stub, only if you use Resolve** | Free Resolve blocks external scripting; works only through an in-app bridge. Native MCP is Studio-only. |
| Local image gen / upscale | `artokun/comfyui-mcp` | **Stub** | Competes with Tony for VRAM; enable only in Away Mode / GPU-slot-gated. |
| Voice / SFX | ElevenLabs hosted MCP (local repo archived) | **Stub** | Codebase already has `elevenlabs.rs`; hosted MCP needs OAuth. |
| YouTube upload + thumbnail + captions | `kud/mcp-youtube` | **Stub** | Low adoption; upload = 1,600 of 10,000 daily quota units; unverified API projects force private uploads. Destructive calls need `confirm:true` — keep it behind an approval card. |
| Stock footage/photos | `jeanpfs/stock-images-mcp` | **Stub** | Images only. |
| Frame-level visual review | `jordanrendric/claude-video-vision` | **Stub** | Must be forced to local Whisper backend; overlaps media-forge. |
| Kdenlive (MLT XML) | `Jemo69/kdenlive-mcp`, `AMMIROSOH/Kdenlive-mcp` | **Reject** (fallback only) | Overlaps shotcut-mcp. |

---

## 3. Gaps → custom tools we build

### G1. `media-forge-mcp` (in-repo, `command center/mcp/media-forge/`)
Python, uv project, `mcp>=1.6,<2`, FastMCP stdio — matching the WhatsApp server's conventions. Binaries resolved from env (`MEDIA_FFMPEG`, `MEDIA_FFPROBE`, `MEDIA_MELT`) with Shotcut's folder as the fallback.

| Tool | Implementation | Notes |
|---|---|---|
| `probe_media(path)` | ffprobe JSON | duration, fps, codecs, resolution, channels, bitrate, size |
| `detect_silence(path, threshold_db=-35, min_duration=0.4)` | `silencedetect` | returns head/tail/mid gaps; drives self-tape auto-trim |
| `transcribe_clip(path, model="small.en", word_timestamps=true)` | **faster-whisper, CPU, `compute_type=int8`**, Silero VAD | writes `.srt` + `.ass`; job-based |
| `detect_scenes(path)` | PySceneDetect (BSD-3) `ContentDetector` | shot boundaries, best-frame thumbnails (gap G2) |
| `quick_assemble(clips[], normalize="-16\|-18 LUFS", fade_ms, max_size_mb, preset)` | ffmpeg two-pass `loudnorm` → concat → libx264/AAC; size-targeted bitrate | job-based; ffprobe self-verify |
| `reframe_and_caption(input, aspect, srt?, burn)` | crop/scale/pad (blur-bg option); `subtitles` filter | **needs full ffmpeg** (G4) for burn-in |
| `process_photos(paths[], ops)` | Pillow (+ OpenCV face box for smart crop) | auto-level, WB, sharpen, 4:5 / 1:1 / 16:9 / 8x10, watermark, contact sheet (gap G3) |
| `make_thumbnail(frame_or_image, text, style, aspect)` | Pillow text-on-frame | YouTube 16:9 + 9:16 covers (gap G7) |
| `job_start / job_status / job_cancel / job_list` | in-process job table + child in a Job Object | answers the 600 s cap; status carries `pct`, `eta_s`, `out_path`, `verify` |
| `verify_output(path, expect)` | ffprobe: non-zero duration, A+V streams, resolution, size ≤ limit | called automatically at end of every render job |

Built-in rules: never writes outside `<media_root>/<slug>/{proxies,mlt,exports,stills}`; `raw/` is read-only to it; a refused path is an error, not a silent skip.

### G2–G3, G7
Folded into media-forge as above: scenes, headshot batch, thumbnails. **CPU upscaling** (Real-ESRGAN ncnn / OpenCV `dnn_superres`) is a later add-on — none exists outside ComfyUI.

### G4. Full ffmpeg build
`winget install Gyan.FFmpeg` (full build, includes libass/freetype) → set `MEDIA_FFMPEG`. Shotcut's ffmpeg stays the default for everything except caption burn-in. (Alternative: burn captions with MLT text filters through shotcut-mcp.)

### G5. Encoder / GPU policy guard (Rust, gateway side)
Enforced in `mcp.rs` before dispatching a `director` tool call, so the policy doesn't depend on the model behaving:
- If args contain `nvenc|cuda|cuvid|hwaccel` (or shotcut-mcp's hardware-encoder flag) **and** the GPU slot is not idle (`scheduler::GpuSlot::is_idle`, `os_core.rs:903`) → rewrite to `libx264` (or refuse with `GPU_BUSY`).
- media-forge's own default: `libx264 -threads N`, N = `floor(cores × render_cpu_pct)` (Setting, default 70 % → 11 of 16 threads), process priority BelowNormal.
- faster-whisper is CPU-int8 by default; a `device="cuda"` request must go through `slot.acquire("whisper · media", false, …)` with preemption (pattern: `compaction.rs:541-578`).

### G6. Gateway OAuth for remote MCPs
`transport:"http"` exists but only with static headers/host-bound bearer tokens. Canva / Dropbox / Adobe / ElevenLabs / hosted Drive need MCP-spec OAuth (authorization-server discovery, DCR, PKCE, loopback redirect, refresh, keychain storage via `secrets.rs`). **This is the single biggest blocker for Tier 2** — scope it as its own change after Tier 1 works. Until then, those entries ship `enabled:false`.

### G8. Self-tape specifics
Slate detection (first transcript segment + silence boundary), reader-audio ducking (side-chain `sidechaincompress` when a reader track is supplied), take selection (scene detection + transcript match to sides). Lives in the Director's preset logic on top of media-forge, not a separate server.

### G9. Render progress channel
Rust `media.rs` polls `job_status` / `render_status` every 1 s while a job is live and emits a `media-render` Tauri event `{project_id, job_id, pct, eta_s, stage}`. No webview polling, matching AD-4.

---

## 4. Integration into the gateway — exact steps

### 4.1 Register the `director` agent so it can be granted tools
Tool grants match on agent id, so the agent must exist first. Minimal set for MCP to work (the full ~40-site checklist from the agent-routing audit goes in Phase 2):
- `roles.rs:102-115` `policy_for("director")` → a **media-write** policy (writes allowed only to granted media servers).
- `os_core.rs:302-316` `default_mcp_grants` → media servers granted to `["director"]` only.
- `os_core.rs:86` AnythingLLM workspace slug `director` + back-fill (`:930-937`); `agent_prompts.rs` `DIRECTOR` prompt + `WORKSPACE_TARGETS`.
- `agents.ts` `AGENT_DEFS` entry (`Clapperboard`, keywords: video, edit, self-tape, reel, render, photo, headshot, thumbnail…), plus `registry.test.ts`, `tony_dispatch.rs` `AGENTS` + CONTRACT text (a test enforces this), `router.fixtures.json` cases.

### 4.2 `os.json` entries (added through Settings → Integrations → MCP Registry, or as defaults in `default_mcps()`)

```jsonc
// Tier 1
// VERIFIED 2026-11-22 over stdio with command center/mcp/mcp_smoke.py (same protocol as mcp_session.rs)
{ "id": "shotcut", "name": "Shotcut (MLT)", "transport": "stdio",
  "command": "python", "args": ["C:\\ai-hub\\mcp\\shotcut-mcp\\scripts\\shotcut_mcp_server.py"],
  "env": { "MLT_REPOSITORY_DENY": "libmltladspa",          // LADSPA plugin scan hangs melt on this machine
           "SHOTCUT_MCP_ALLOWED_ROOTS": "C:\\ai-hub\\media",
           "SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS": "1",
           "SHOTCUT_MCP_MAX_ACTIVE_RENDERS": "1" },
  "enabled": true, "agents": ["director"], "timeoutSecs": 600, "readOnly": false,
  "description": "Multi-track MLT timelines, QC, preview + job-based renders" },

{ "id": "media-forge", "name": "Media Forge", "transport": "stdio",
  "command": "uv", "args": ["--directory", "G:\\agentic os\\command center\\mcp\\media-forge", "run", "server.py"],
  "env": { "MEDIA_ROOT": "C:\\ai-hub\\media",
           "MEDIA_FFMPEG": "C:\\Users\\nicho\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.1-full_build\\bin\\ffmpeg.exe",
           "MEDIA_FFPROBE": "C:\\Users\\nicho\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.1-full_build\\bin\\ffprobe.exe",
           "MEDIA_CPU_PCT": "70", "WHISPER_DEVICE": "cpu", "WHISPER_COMPUTE": "int8" },
  "enabled": true, "agents": ["director"], "timeoutSecs": 600, "readOnly": false },

{ "id": "gdrive", "name": "Google Drive (media)", "transport": "stdio",
  "command": "uvx", "args": ["--with", "mcp<2", "workspace-mcp", "--tools", "drive", "--tool-tier", "core"],
  "env": { "GOOGLE_OAUTH_CLIENT_ID": "<keychain>", "GOOGLE_OAUTH_CLIENT_SECRET": "<keychain>",
           "WORKSPACE_MCP_CREDENTIALS_DIR": "C:\\ai-hub\\secrets\\gdrive-media" },
  "enabled": true, "agents": ["director"], "timeoutSecs": 600, "readOnly": false },

// Tier 2 stubs (enabled:false until G6 OAuth lands)
{ "id": "canva",  "transport": "http", "url": "https://mcp.canva.com/mcp", "enabled": false, "agents": ["director"] },
{ "id": "dropbox","transport": "http", "url": "https://mcp.dropbox.com/mcp", "enabled": false, "agents": ["director"] },
{ "id": "adobe-creativity", "transport": "http", "url": "https://adobe-creativity.adobe.io/mcp", "enabled": false, "agents": ["director"] },
{ "id": "resolve", "transport": "stdio", "command": "python", "args": ["<path>\\davinci-resolve-mcp\\src\\server.py"], "enabled": false, "agents": ["director"] }
```
(Exact shotcut-mcp entry path, env names and the workspace-mcp env names get confirmed against each README at install time. Secrets are injected from the keychain, never written into os.json.)

### 4.3 Runtime capability discovery
The Director's turn prompt gets a generated "Available toolbelt" block built from `mcp_list_tools` filtered to its grants (enabled + healthy). If `canva` or `adobe-creativity` is live, the prompt prefers it for thumbnails/retouch, otherwise media-forge. Nothing is hard-coded per vendor.

---

## 5. Installation plan (in order, each one verified before the next)

| # | Step | Command / action | Verify |
|---|---|---|---|
| 0 | Media root | create `C:\ai-hub\media\` (sits beside `C:\ai-hub\memory`, outside the repo) | folder exists, writable |
| 1 | Full ffmpeg (captions) | `winget install Gyan.FFmpeg` | `ffmpeg -filters` lists `subtitles`, `drawtext` |
| 2 | shotcut-mcp | `git clone https://github.com/matrodrigs/shotcut-mcp C:\ai-hub\mcp\shotcut-mcp` (pin to a tagged release; read the server before enabling) | `python scripts\shotcut_mcp_server.py` answers an `initialize` + `tools/list` over stdio (scratch script); `detect_hardware_encoders` sees Shotcut 26.11.15 |
| 3 | media-forge scaffold | `uv init` in `command center/mcp/media-forge`, deps `mcp>=1.6,<2 faster-whisper scenedetect[opencv] pillow` | `uv run server.py` lists tools; `probe_media` on a sample clip; pytest suite on 2 generated test clips (`ffmpeg -f lavfi testsrc+sine`) |
| 4 | faster-whisper model | first `transcribe_clip` downloads `small.en` CT2 (~470 MB) to `C:\ai-hub\models\faster-whisper` | 30 s clip transcribes on CPU int8 with **0 MB VRAM change** (`nvidia-smi` before/after) |
| 5 | Google Cloud | in your existing OAuth project: enable Drive API, add `drive.file` scope (+ `drive.readonly` for the phone-inbox pull) | consent screen shows Drive scopes |
| 6 | workspace-mcp | `uvx --with "mcp<2" workspace-mcp --tools drive --tool-tier core` once by hand to complete OAuth in the browser | list a test folder; upload a 1 MB file; get a share link |
| 7 | Register entries | add §4.2 entries via Settings → MCP Registry (or defaults) | each card shows green with its tool count; `tools-changed` fires |
| 8 | Grant/role test | call a `media-forge` write tool as `designer` | refused (`role_refusal`); same call as `director` succeeds |
| 9 | GPU guard (G5) | ask for an NVENC render while Tony is generating | rewritten to libx264 / refused `GPU_BUSY`; Tony's token rate unchanged |
| 10 | Regression | app restart | all pre-existing MCPs (playwright, sqlite, whatsapp, gmail-multi) still list tools; `cargo test`, `vitest`, `tsc --noEmit` green |

---

### 5.1 Tier 1 install log (2026-11-22)

| Step | Result |
|---|---|
| 0 Media root | ✅ `C:\ai-hub\media`, `C:\ai-hub\mcp`, `C:\ai-hub\models\faster-whisper` |
| 1 Full ffmpeg | ✅ winget `Gyan.FFmpeg` 9.1 full build; `subtitles`, `ass`, `drawtext`, `loudnorm`, `silencedetect` present |
| 2 shotcut-mcp | ✅ cloned `925d0de` (v1.6.0) to `C:\ai-hub\mcp\shotcut-mcp`. Reviewed: stdlib only, no network clients, no eval/exec, argv-list subprocesses with stdin closed. `--check` → `runtime_ready: true`, status `untested` (Shotcut 26.11.15 / MLT 7.43 is newer than its CI matrix). **Fix needed:** `MLT_REPOSITORY_DENY=libmltladspa`, because the LADSPA module's plugin scan hangs `melt -query` indefinitely. With it denied, melt loads 576 filters in about 1 s, including rnnoise. Stdio smoke: 28 tools; `shotcut_status` and `detect_hardware_encoders` OK. |
| 3 media-forge | ✅ `command center/mcp/media-forge` (mcp 1.30.0, faster-whisper 1.2.1, scenedetect 0.7.3, opencv-headless 4.14, Pillow 13). 13 pytest cases pass, plus Whisper when opted in. Stdio smoke: 16 tools. A real self-tape assemble trimmed dead air → −18.0 LUFS, 1920×1080, 9.06 MB under a 25 MB cap, ffprobe OK. Writes to `raw/` refused; NVENC refused (`GPU_BUSY`). |
| 4 faster-whisper | ✅ CPU int8, `tiny.en` model downloaded for the test. Transcript accurate; **VRAM unchanged (1598 MiB before and at peak)**. `small.en` (the default) downloads on first real use. |
| Pitfalls fixed | PyAV API drift in faster-whisper's decoder (we decode with our own ffmpeg instead). OpenCV 5 dropped the Haar face cascade (pinned `<5`, with a centre-crop fallback). Windows temp-file lock in the thumbnail tool. |
| 5–10 | ⏳ Drive OAuth, os.json registration (needs the `director` role first, or every write is refused), GPU guard, regression |

## 6. Verification harness (kept in repo)

- `mcp/media-forge/tests/` — pytest against synthetic clips: silence detection on known gaps (±50 ms), loudnorm lands at −16 ±1 LUFS (measured with `ebur128`), concat duration = sum − trims, size-cap honoured, `verify_output` rejects a zero-length file.
- `src-tauri` test: a fake stdio MCP that sleeps 900 s in `job_status`-style chunks proves the job pattern never hits the 600 s call cap.
- **E2E self-tape smoke** (Phase 5): 2 sample MP4s → `detect_silence` → `quick_assemble(-18 LUFS, max 100 MB)` → `verify_output` → appears in Media Library → plays via asset protocol.

---

## 7. Other findings that affect the build (not MCP, but blocking)

- **File access in the webview:** `dragDropEnabled:false`, no `assetProtocol`, no dialog/fs plugin, capabilities are `core:default` + `notification:default` only. Media Studio needs: Tauri native drag-drop events (paths) on, `tauri-plugin-dialog` with `dialog:allow-open` only, and `assetProtocol` scoped to `C:\ai-hub\media\**` with `media-src`/`img-src` CSP additions. Narrow scopes keep the "no fs/shell/http plugins" rule intact.
- **SQLite:** new `media.db` in the app config dir following the `devqueue.rs` `user_version` ladder; register on the System Map (`introspect.rs:665-681`).
- **Tony → Director:** Tony's TonyDispatch packet + keyword router (`router.ts` / `routing.rs`, shared `router.fixtures.json`) gain a `director` domain; Brainstorm gets a "Send to Director" action beside "Push to Play Place", creating a `MediaProject` instead of a hub envelope.
- **Memory note may be stale:** `gmail-multi` runs on bundled `mcp 2.3.0` without crashing, so the "pin mcp<2" rule may only apply to some servers. We keep the pin for new servers (safe either way) and re-test later.

---

## 8. Decisions needed from Nic

1. **Media root:** `C:\ai-hub\media` (recommended, matches AD-3) or another drive?
2. **Tier 2 vendors you actually use:** Canva? Adobe CC? DaVinci Resolve (free or Studio)? Dropbox? This decides whether gateway OAuth (G6) comes next or waits.
3. **Drive:** OK to reuse your existing Google OAuth client with a new `drive.file` scope and a separate token store?
4. **Default render encoder:** CPU libx264 always (safest) vs NVENC when Tony is idle (faster; ~300 MB VRAM).
