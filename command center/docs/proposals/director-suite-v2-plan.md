# Director Suite v2: plan mapped onto existing code

Status: **awaiting approval** · 2026-11-26 · branch `director-suite` (from `feat/per-agent-voices` @ e748f88, which sits on `feat/language-hub`).
This extends the v1 suite (`director-suite-plan.md`, `director-gdrive-plan.md`); nothing here is a rebuild.
Line numbers are against e748f88. The main checkout has uncommitted latency/voice work, so re-resolve the line numbers before patching.

Effort: S < 0.5 d · M 0.5–2 d · L 2–5 d · XL > 5 d. ⚠ = touches shared core (gateway, routing, model loading, voice).

## 0. What exists today (the starting point)

| Area | Exists | Key files |
|---|---|---|
| Suite page | 4-zone page: Staging Bin, Shot List, Preview, Mini Timeline, Render Plan card, Director chat, Verified Shelf; desktop only | `sections/DirectorSuiteSection.tsx`, `features/director/*` |
| Backend | projects, ingest (copy → `raw/` read-only, probe, thumb), chunked upload, voiceover, manifest with revision check, render plan → approve → media-forge `render_timeline` → ffprobe verify | `src-tauri/src/commands/media.rs` (1494 lines) |
| Render engine | trims, stills, fades to black, audio layers, two-pass loudness −14/−16/−18 LUFS, size cap, 4 aspects, CPU x264 | `mcp/media-forge/media_forge/timeline.py` |
| Unused tools | media-forge `transcribe_clip` (faster-whisper CPU), `detect_scenes`, `detect_silence`, `reframe_and_caption`; the whole Shotcut MCP (transitions, colour, subtitles, markers) | `mcp/media-forge/server.py`, `G:\ai-hub\mcp\shotcut-mcp` |
| Drive | pull into bin, push render, view-only share link (smoke-tested) | `gdrive.rs`, `RenderCloudActions.tsx` |
| GPU baton | Tony-first slot, exclusive `acquire_maintenance`, gateway lease (15 min cap), unload → work → `restore_tony` with VRAM peak sampler (Model Lab) | `scheduler.rs`, `modellab/compare.rs`, `command_center_api.py` |
| Voices / inbox | per-agent report voices, wait-for-Tony (`canSpeak`), Comms inbox, `directorReport()` for renders | `features/voice/agent-reports.ts`, `features/comms/*` |
| Gmail / Instagram | approved-only draft (no attachments); approved-only publish with ConfirmCard | `gmail.rs`, `instagram.rs`, `orchestrator/*` |

### Findings that change the plan
1. **The Director Suite chat is answered by Tony, not the Director.** `director-chat.ts:25` sends `noDelegate:true` and `agents.rs:539-545` then forces `role="general"`. Removing that flag doesn't fix it on its own: the delegate path drops `req.context` and history (`agents.rs:2009`). The Director has no system prompt in the repo (`agent_prompts.rs:301-323`). ⚠ This is the first fix, and it sits in routing code the latency work is editing.
2. **The "motion vocabulary" skill is a web-UI animation glossary** (`animation-vocabulary`, `os_core.rs:345`), not camera or edit vocabulary. A real `director-craft` skill is needed.
3. **"MCP ready · 45 tools" is only a pill count** (shotcut + media-forge listings, `StudioBar.tsx:28`). Tool scoping already works: the Director gets `filesystem, shotcut, media-forge` (`mcp.rs:2746`). The real risk is that **any new MCP id defaults to `"all"` agents** (`os_core.rs:333`), so ComfyUI and Drive have to be registered with explicit grants.
4. **The launcher cards differ only in output name, aspect or LUFS** (`manifest.ts:212-224`). Same layout, and no first Director turn.
5. **ComfyUI** is at `C:\ComfyUI\ComfyUI_windows_portable\ComfyUI`. It is the portable build, v0.46.0, with a **detached HEAD**, so a plain `git pull` fails. The tree is clean. Embedded Python 3.13 and torch 2.14.1+cu130 work with CUDA on the 3060. All requirements are present, there are no custom nodes, port 8188 is free and there is no `extra_model_paths.yaml`.
6. **SDXL Turbo is not on disk.** `D:\AI Models Media and Vision\sdxl-turbo` is an aborted clone: an `index.lock` and no weights. No SD, SDXL, Flux or video weights exist anywhere on C:/D:/F:/G:.
7. **VRAM:** Qwen 3.5-9B at 32k ctx (Bionic :1235) holds about 10.7 GB of 12. Faster-whisper STT holds about 1.2 GB more. LM Studio **JIT-reloads** on any stray call, so the full unload → render → reload must be one held maintenance lease with a verify-after.
8. **Instagram needs a public https media URL** (`instagram.rs:295-314`). Local and NetBird URLs are rejected, and a Drive view link is probably not accepted (untested). Posting needs a hosting step.
9. **Scene Reader has no API.** It's a Tauri app with a studio-server on :5123 that serves LLM/TTS/STT only, and turn detection is webview-only (`src/domain/live.ts`). There's no comps concept, only a `best` flag on takes. **No separate Brainstorming app exists.** Only the in-app Brainstorm page does.
10. **Hybrid / "Droplet: Connected" is intended.** Chat turns overflow to the droplet only when VRAM ≥ 90% or the prompt is ≥ 24k chars (`os_core.rs:1520-1535`). Unloading Qwen for renders makes it moot. Before reloading, call ComfyUI `/free` so the reload doesn't trip it.

## 1. Part 1: Pipeline (≈ 9–13 days)

| # | Step | Builds on | New work | Effort |
|---|---|---|---|---|
| 1.0 | **Make the Director real** | `os_turn`, `context.ts` action contract | Route suite turns to the Director with context and history; Director system prompt; `director-craft` skill (shots, framing, pacing, platform specs) | M ⚠ `agents.rs`, `agent_prompts.rs` |
| 1.1 | Creative brief | `source.brief` (hidden today) | `CreativeBrief {goal, platform, lengthSec, aspect, tone, references}`; `draft_brief` action; editable brief card; `media_project_update` | M |
| 1.2 | Shot list | `ShotSlot`, `populate_shot_list` | Fields: framing, action, `source: film/generate/stock`, phone tips; manual add/edit/reorder; filming checklist | M |
| 1.3 | Footage intake | `ingest_paths`, `transcribe_clip`, `detect_scenes/silence` | `<slug>/inbox` watched by a scheduler-tick scan (no new crate); auto-ingest; batch CPU transcribe (tiny.en already on disk); slot matching via `match_footage` action; quality flags; best-moment markers | L |
| 1.4 | Edit | `render_timeline` v1 | Spec v2: crossfades, captions (ASS from word timestamps), music ducking and fades, basic colour (eq/LUT), platform presets → multi-output plan | L |
| 1.5 | Review loop | Render Plan card, `manifestRevision` | Review round counter (max 2), notes tied to a render version; after round 2 a "left for you to decide" report | M |
| 1.6 | Hand-off | Instagram ConfirmCard, Drive share | "Approve final" → deliverables folder → Biz Ops post card. **Public hosting for Instagram** (Drive direct link test first) | M, + L if hosting needs a new path |

**Test gate:** one real 15-second Instagram clip goes from idea to brief to shot list to intake to edit to two notes to an approved final to the post card, which I'll stop at so you can confirm.

## 2. Part 2: ComfyUI (≈ 4–6 days)

| # | Item | New work | Effort |
|---|---|---|---|
| 2.1 | Readiness | `extra_model_paths.yaml` kept **outside** the repo (`G:\ai-hub\comfy\`), `--output-directory`/`--user-directory` outside the repo. Repo files untouched | S |
| 2.2 | Models | Finish the **single** SDXL Turbo fp16 file into the existing clone (`git lfs pull --include sd_xl_turbo_1.0_fp16.safetensors`, **≈ 6.9 GB, needs your OK**) | S |
| 2.3 | On-demand service | `comfy.rs`: spawn `python_embeded\python.exe -s ComfyUI\main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --disable-api-nodes --extra-model-paths-config …`; health check; stop after the batch; never at boot | M |
| 2.4 | GPU baton | Move `unload/load/restore_tony/heartbeat/sampler` out of `compare.rs` into a shared `model_swap` module; one maintenance lease covers unload → render → `/free` → reload → verify; admission via `compaction::current_idle_wait()` plus a webview "Tony busy" signal; Tony preempt = ComfyUI `/interrupt` + restore; render-specific gateway line | L ⚠ `compare.rs`, `command_center_api.py`, `gateway_tony.py` |
| 2.5 | Templates | API-format JSON with slots: `scene-still`, `thumbnail-title`, `style-transfer` (img2img), `upscale`, `broll-motion` (after video models) | M |
| 2.6 | Provenance | `<asset>.gen.json` sidecar in `working/gen/` (prompt, negative, seed, steps, cfg, sampler, size, checkpoint + hash, ComfyUI version, workflow, render ms, peak VRAM); PNG keeps ComfyUI's embedded metadata; "Generated" chip and "Re-roll / tweak" in the bin | M |
| 2.7 | Tool scope | Register `comfyui` with grants `["director"]`, never `"all"` | S |

**Setup-note test (6):** unload Qwen, render one SDXL Turbo 512² image at 1 step through the API, ingest it into a `comfy-smoke` project's Staging Bin with its sidecar, `/free`, reload Qwen and verify. I'll report render time and peak VRAM, noting whether Whisper stayed resident.

**Optional models (ask before any download):**

| Model | Size | Use | Custom node |
|---|---|---|---|
| 4x-UltraSharp or RealESRGAN x4plus | ≈ 0.07 GB | upscale | none |
| sdxl-vae-fp16-fix | 0.33 GB | cleaner SDXL decode | none |
| SDXL-Lightning 4-step LoRA | 0.39 GB | fast quality stills | none |
| Juggernaut XL or SDXL base 1.0 fp16 | ≈ 6.5–7 GB | quality stills, title cards | none |
| Wan 2.1 T2V 1.3B + umt5-xxl fp8 + VAE | ≈ 2.8 + 6.7 + 0.25 GB | short B-roll | none (native) |
| LTX-Video 2B distilled + t5xxl fp8 | ≈ 4–6 + 4.9 GB | B-roll, img→video | none (native) |
| Flux schnell GGUF Q4 + t5 fp8 + clip_l + ae | ≈ 6.8 + 4.9 + 0.25 + 0.33 GB | best stills, slow and tight on 12 GB | city96/ComfyUI-GGUF |

Recommended first set: SDXL Turbo, plus UltraSharp, plus the fp16-fix VAE (≈ 7.3 GB total). It needs no custom nodes.

## 3. Part 3: UI (≈ 8–12 days; phone is the long pole)

| Item | Builds on | New work | Effort |
|---|---|---|---|
| Projects + status | recent list, auto status | Status `brief/shooting/editing/review/done` + migration; board/list view | M |
| Brief + shot checklist | 1.1, 1.2 | editors (same as Part 1) | (in Part 1) |
| Media bin | StagingBin | tags, transcript viewer, flags, generated-asset chip | M (after 1.3) |
| Timeline preview + notes | PreviewPlayer, MiniTimeline | timestamped notes on the manifest; click a note to seek | M |
| Render queue | single `job`, slot pill | Persisted queue (export + ComfyUI jobs), states queued/waiting-idle/running/done, baton pill in StudioBar | M (with 2.4) |
| Versions | `_vNNN` renders | Manifest snapshot per render, A/B compare player, restore revision | L |
| Phone | gateway `/cc` PWA over 8443 | Gateway `/api/media/*` proxy (list, stream render, note or voice note, approve) behind the security gate; mobile review layout | XL ⚠ gateway `server.py` |

## 4. Part 4: Scene Reader link (≈ 3–5 days, optional)

- The suite detects Scene Reader by probing `:5123/health`. With no answer it hides the link, and everything else keeps working.
- Takes come in through a read-only import of Scene Reader's project folder and `best` takes into a new Audition project. It's M, and Scene Reader's code is untouched. A proper export endpoint in Scene Reader is M in its repo; it's a separate repo, so I'll ask first.
- Sides from Gmail to Scene Reader and the casting reply draft use the existing Gmail read and approved draft. Scene Reader has no ingest API, so sides go in as a file drop for now.
- Casting-spec export means slate, trim and a self-tape preset (16:9, −18 LUFS, size cap) on top of 1.4.

## 5. Part 5: Voice and comms (≈ 1 day; mostly built in e748f88)

- Add an `agentVoices.director` row with an ElevenLabs voice you pick. It's a config change in Voice Settings.
- New report events for brief ready, footage gaps, a ComfyUI batch done and a review round, using `agent_report` and an inbox entry. Wait-for-Tony is already built (`canSpeak`).
- Inbox persistence is webview localStorage today. It's fine to leave, but noted.

## 6. Part 6: Studio features (after Parts 1–5)

| Item | Effort | Depends on |
|---|---|---|
| 6 launcher presets, each with its own layout and first Director turn | M | 1.0 |
| Three speeds (Rough / Polish / Full AI) | M (L with Full AI) | 1.4, Part 2 |
| Talk-to-edit with incremental actions (`trim`, `move`, `tighten_range`, `swap`) and before/after preview | M–L | 1.0, 1.4 |
| Style memory (approvals and rejections → `style-profile.json` injected into context) | M | 1.5 |
| Storyboard first | M | Part 2 |
| Phone-friendly shot lists | S | 1.2 |
| Fill the gaps | M | 1.3, Part 2 |
| Versions on demand (Reels / TikTok / YouTube / self-tape) | M | 1.4 |
| Performance-aware comping | L | Part 4 |
| Watched folder | (1.3) | — |
| NetBird import and private link | M ⚠ gateway | — |
| Drive share link | **done** | — |
| Email via Tony draft with the link | S–M | — |
| Post to Instagram | (1.6) | hosting |
| Tool pill shows the Director's real tool set; ComfyUI and Drive scoped to the Director | S | — |
| Readability: darker panels plus lighter `ink-3`, scoped to the Director section only | S | — |
| Droplet check | already intended; add a note in the suite | S |

## 7. Part 7: Creative boosters (after Part 6)

| Item | Effort | Note |
|---|---|---|
| Idea board (video ideas only) | M ⚠ voice `dialogue/tier.ts` | "ideas board" already maps to the **ledger** (`tier.ts:59`), so this needs a distinct phrase. There's no separate Brainstorming app, so the in-app Brainstorm page stays where general ideas go |
| Daily spark | M | `downtime.rs` tick, background GPU slot, snooze/off |
| Mood boards | M–L | colour (ffmpeg palette), pacing (scene cut rate), music (BPM/energy) |
| Music and ElevenLabs SFX | L | music library plus energy matching; SFX through the existing ElevenLabs key |
| Styled animated captions | M | from 1.4 ASS captions; saved styles |
| Performance stats | M | publish stores post id → per-media insights → project + style memory |
| Teleprompter | M–L | port Scene Reader's `Vad` (pure TS) rather than cross-app events |

## 8. Order, commits and merge

1. Part 1 → 2 → 3 → 4 + 5, then 6 and 7. Each part is its own run of small commits on `director-suite`. Each part gets an end-to-end test with a real 15-second clip.
2. Shared-core edits: list for you, kept small. The biggest are 1.0 (`agents.rs` routing) and 2.4 (`compare.rs` extraction, gateway lease wording). Both overlap files the latency work is editing right now, uncommitted in `G:\agentic os`, so do them **after** that lands, or as small additive patches.
3. Merge: rebase onto the latest trunk, then run vitest, typecheck, `cargo test --lib`, `python tests/run_all.py`, media-forge pytest, and the latency set (Model Lab Timing suite plus a diagnostics probe, compared to the baseline). Show you the conflict summary, then **ask before merging**.
