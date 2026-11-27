# Director Suite — Phase 1 audit, plan and locked contract

Status: **awaiting approval** · 2026-11-22 · branch `feat/director-media-mcp` (stacked on `feat/thoughtform-pipeline`).

## 1. Audit findings

| Question | Finding | Consequence |
|---|---|---|
| Left nav / pages | `src/stores/nav.ts` has the `Section` union and the `SECTIONS` array. The rail (`shell/Navigation.tsx`) renders from `SECTIONS`; `App.tsx` has `SECTION_VIEWS: Record<Section, lazy(...)>` inside `<Suspense>`. No test enumerates the sections. | One id `"director"` + one lazy view. TypeScript flags the missing `Record` key. |
| Styling | `styles/index.css` tokens (`glass`, `glass-thin`, `well`, `label-caps`, `pill-primary`, `pill-glass`, `field`, `trim-range`), `components/ui.tsx` (`Card`, `Chip`, `Stat`, `SubTabs`, `Empty`). The root layout is copied from `PlayPlaceSection`. | Reuse only; no new design system. |
| Local media in the webview | **No asset protocol**, CSP `media-src 'self' blob:`, `dragDropEnabled:false`, no dialog/fs plugin, capabilities `core:default` + `notification:default`. | Add the asset protocol **scoped to `C:\ai-hub\media\projects\**` only**, CSP `asset: http://asset.localhost` on `media-src`/`img-src`, plus `convertFileSrc`. The asset protocol serves byte ranges, so `<video>` scrubbing works. |
| Native drag-drop | Turning `dragDropEnabled` on in Tauri v2 / WebView2 **disables HTML5 drag-and-drop for the whole app**, which would break the widget grid, reorder lists and the new clip strip. | Keep it **off**. Drops arrive as HTML5 `File` objects → **chunked binary IPC** into Rust. Add **tauri-plugin-dialog** (`dialog:allow-open` only) for a picker that gives real paths, so Rust can copy without loading the file into memory. |
| Turns to the `director` workspace | `os_turn` with `{ role: "director", explicit: true, streamId, context, history, noDelegate: true }` streams the workspace reply as `tony-token { streamId, agent: "director" }` (`agents.rs:1536`). This never touches the voice controller, so **there is no TTS and nothing lands in Tony's thread**. The model call takes the shared GPU queue like every agent. | The Director chat calls `cmd("os_turn")` directly with its own streamId; per-project history is kept in the project folder. |
| MCP tools | `mcp_call { name, args, approved, agent }` → `call_tool_with` applies the role gate (Director may write to `shotcut`/`media-forge` only), the GPU guard and then the MCP tier card. `mcp_list_tools` gives per-server status. Calls are capped at 600 s; media-forge renders run as jobs. | Renders are run by **Rust** after the user approves the Render Plan card (`approved: true`), never by the model mid-chat. Rust polls `job_status` and emits progress events. |
| Mic | `features/voice/mic-gate` (`micEnabled()`, `MIC_LOCKED_MSG`) is the hard mic shutoff that Brainstorm already honours. | Voiceover recording refuses while the mic is locked. MediaRecorder (webm/opus) → binary IPC save. |
| Media folder layout | media-forge currently uses `<root>/<slug>/{raw,proxies,mlt,exports,stills}`. | Move to the layout you asked for: `C:\ai-hub\media\projects\<slug>\{raw, working, renders}` (media-forge updated and its tests rerun). |
| Rendering capability gap | media-forge `quick_assemble` handles clips only: trims, loudness, concat, size cap. | **New media-forge tool `render_timeline(manifest_path, plan_id)`**: video clips, stills/slates held for N seconds, voiceover and music tracks with offset/volume, two-pass loudness, CPU `libx264`, ffprobe verification. |

## 2. Files

**New**
- `src-tauri/src/commands/media.rs` — Director Suite backend: projects, ingest, manifest, voiceover save, chat log, render runner and progress events. `media.db` follows the `devqueue.rs` `user_version` ladder; manifests stay JSON files on disk.
- `src/sections/DirectorSuiteSection.tsx` — page shell (4 zones).
- `src/features/director/` — `contract.ts` (locked types below), `director-store.ts` (zustand), `actions.ts` (parses and validates the Director's action blocks), `manifest.ts` (pure edit operations + tests), `StudioBar.tsx`, `StagingBin.tsx`, `ShotList.tsx`, `PreviewPlayer.tsx`, `MiniTimeline.tsx`, `VoiceoverRecorder.tsx`, `DirectorChat.tsx`, `RenderPlanCard.tsx`, `VerifiedShelf.tsx`, `*.test.ts`.
- `mcp/media-forge/media_forge/timeline.py` + tests — `render_timeline`.

**Modified**
- `nav.ts` (`"director"`, label "Director Suite", icon `Clapperboard`), `App.tsx` (lazy view).
- `lib.rs` (register commands + `MediaState`), `commands/mod.rs`, `Cargo.toml` (`tauri` feature `protocol-asset`, `tauri-plugin-dialog`), `package.json` (`@tauri-apps/plugin-dialog`), `tauri.conf.json` (assetProtocol scope + CSP), `capabilities/default.json` (`dialog:allow-open`).
- `src/lib/native-ext.ts` — `ExtCommands` entries (keeps `platform.ts` unchurned, per its own comment).
- `BrainstormSection.tsx` and `PlayPlaceSection.tsx` — a **"Send to Director Suite"** button.
- `introspect.rs` — `media.db` on the System Map.
- media-forge `config.py` / `server.py` — new layout, `render_timeline`.

## 3. Locked contract

```ts
// src/features/director/contract.ts — LOCKED after approval

export type MediaKind = "video" | "image" | "audio";
export type AssetRole = "clip" | "photo" | "slate" | "outro" | "voiceover" | "music" | "sfx";
export type ProjectStatus = "intake" | "awaiting_media" | "editing" | "rendering" | "ready";

export interface MediaAsset {
  id: string;                 // "a-<base36>"
  project: string;            // slug
  kind: MediaKind;
  role: AssetRole;
  name: string;               // display name (original file name)
  path: string;               // absolute, inside projects/<slug>/raw (read-only) or working/ (voiceover)
  readOnly: boolean;          // true for every raw/ file (OS read-only attribute set)
  sizeBytes: number;
  durationSec: number | null; // video/audio
  width: number | null;
  height: number | null;
  thumbPath: string | null;   // working/thumbs/<id>.jpg
  addedAt: string;            // ISO
}

export interface ShotSlot {
  id: string;                 // "s1", "s2"…
  label: string;              // "15s Hook"
  instructions: string;
  kind: MediaKind;
  targetSec: number | null;
  assetId: string | null;     // filled by drop/pick
  status: "needed" | "attached" | "approved";
}

export interface TimelineClip {
  id: string;                 // "c-<base36>"
  assetId: string;
  inSec: number;              // 0 ≤ inSec < outSec ≤ asset duration (stills: 0)
  outSec: number;             // stills: hold length
  fadeMs: number;             // 0–2000
}

export interface AudioLayer {
  id: string;
  assetId: string;            // voiceover / music / sfx asset
  startSec: number;           // offset on the timeline
  inSec: number;
  outSec: number;
  volume: number;             // 0–2 (1 = unity)
}

/** working/timeline_manifest.json — the single source of truth for the UI, the Director and the render. */
export interface TimelineManifest {
  version: 1;
  project: string;
  revision: number;           // +1 on every save; a save with a stale revision is refused
  clips: TimelineClip[];      // order = playback order (slates are clips with role slate/outro)
  audio: AudioLayer[];
  clipAudioVolume: number;    // 0–2, the camera audio under VO/music
  output: { aspect: "16:9" | "9:16" | "4:5" | "1:1"; loudnessLufs: -14 | -16 | -18; maxSizeMb: number | null; name: string };
  shotList: ShotSlot[];
  updatedBy: "nic" | "director";
  updatedAt: string;
}

export interface MediaProject {
  slug: string; title: string; status: ProjectStatus;
  root: string;               // C:\ai-hub\media\projects\<slug>
  createdAt: string; updatedAt: string;
  source: { from: "suite" | "brainstorm" | "playplace"; refId: string | null; brief: string | null };
}

export interface RenderPlan {
  planId: string;             // "p-<base36>"
  project: string;
  manifestRevision: number;   // the manifest the plan was made from; stale → refused
  sources: { assetId: string; name: string; inSec: number; outSec: number }[];
  audio: { assetId: string; name: string; startSec: number; volume: number }[];
  outputName: string;         // renders/<outputName>_vNNN.mp4
  outputSpec: string;         // "1920×1080 · H.264/AAC · −18 LUFS · ≤ 100 MB"
  renderMode: "cpu_only";
  proposedBy: "director" | "nic";
}

export interface VerifiedRender {
  id: string; project: string; planId: string;
  path: string;               // renders/…  (exists, > 0 bytes, ffprobe OK)
  durationSec: number; width: number; height: number; sizeBytes: number;
  loudnessLufs: number | null;
  verify: { ok: true; checks: string[] };
  createdAt: string;
}

/** Director → UI action blocks: a fenced ```director-action JSON block in the reply. Validated in TS AND Rust. */
export type DirectorAction =
  | { type: "populate_shot_list"; slots: Omit<ShotSlot, "assetId" | "status">[] }
  | { type: "propose_edit_plan"; clips: Omit<TimelineClip, "id">[]; audio: Omit<AudioLayer, "id">[]; output: Partial<TimelineManifest["output"]>; note: string }
  | { type: "execute_verified_render" };  // only raises the Render Plan card; never renders by itself

/** New Tauri IPC (ExtCommands; Rust snake_case params). All desktop-only. */
export interface DirectorCommands {
  media_projects: { args: undefined; result: MediaProject[] };
  media_project_create: { args: { title: string; source?: MediaProject["source"] }; result: MediaProject };
  media_project_get: { args: { slug: string }; result: { project: MediaProject; assets: MediaAsset[]; manifest: TimelineManifest; renders: VerifiedRender[] } };
  media_ingest_paths: { args: { slug: string; paths: string[]; role: AssetRole }; result: MediaAsset[] };   // from the dialog picker: copy → raw/, set read-only, probe, thumb
  media_ingest_begin: { args: { slug: string; name: string; sizeBytes: number; role: AssetRole }; result: { uploadId: string } };
  media_ingest_chunk: { args: { uploadId: string; offset: number; bytes: Uint8Array }; result: { received: number } }; // ≤ 8 MB per chunk
  media_ingest_finish: { args: { uploadId: string }; result: MediaAsset };
  media_voiceover_save: { args: { slug: string; bytes: Uint8Array; mime: "audio/webm" | "audio/ogg" | "audio/wav" }; result: MediaAsset }; // → working/voiceover/vo_vNNN.*
  media_manifest_save: { args: { slug: string; manifest: TimelineManifest }; result: TimelineManifest }; // refuses a stale revision or ids/paths outside the project
  media_chat_log: { args: { slug: string; append?: { role: "nic" | "director"; text: string } }; result: { role: "nic" | "director"; text: string; at: string }[] };
  media_render_plan: { args: { slug: string; proposedBy: RenderPlan["proposedBy"] }; result: RenderPlan };  // built in Rust from the saved manifest
  media_render_execute: { args: { slug: string; planId: string; approved: true }; result: { jobId: string } };
  media_render_cancel: { args: { jobId: string }; result: void };
  media_readiness: { args: undefined; result: { shotcut: McpReady; mediaForge: McpReady; ffmpegFound: boolean } };
  media_reveal: { args: { path: string }; result: void };   // opens Explorer at a file inside projects/ only
}
export type McpReady = { enabled: boolean; healthy: boolean; tools: number; error: string | null };

/** Events (onNativeEvent). */
export type DirectorEvents = {
  "media-render": { slug: string; jobId: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; pct: number; etaSec: number | null; stage: string; render?: VerifiedRender; error?: string };
  "media-ingest": { slug: string; uploadId: string; received: number; total: number };
};

/** Cross-page handoff ("Send to Director Suite"): sets the nav + creates or opens a project. */
export interface DirectorHandoff { from: "brainstorm" | "playplace"; refId: string; title: string; brief: string; assetPaths: string[] }
```

## 4. States and guardrails

- **Empty (no project):** greeting *"Hey Nic, what do you want to create today?"* plus four quick starts (New Video Edit · Plan a Video / Channel Series · Photo & Visual Staging · Quick Stitch + Slate) and the recent projects. Each quick start creates a project with a preset manifest (Quick Stitch = clips + slate slot, −18 LUFS).
- **MCP pill:** green when both servers are enabled and listing tools. Amber names the one that's off, with **Open Settings** (`go("settings")` → integrations tab). Red shows the server's error. Rendering is disabled until media-forge is green; staging, trimming and chat still work.
- **Render badge:** driven by `media-render` events. Shows "CPU · 11 threads · GPU free for LM Studio" while running.
- **Not desktop (phone PWA):** a single card saying the Director Suite is desktop-only.
- **Mutating actions and what gates them:**
  - ingest copies only; originals are never moved;
  - manifest save is local and revisioned;
  - **render** runs only from **Approve & Render** (`approved: true`);
  - Explorer reveal is confined to `projects/`;
  - nothing auto-runs from a Director reply.
- **Persisted:** `C:\ai-hub\media\projects\<slug>\` holds `project.json`, `working/timeline_manifest.json`, `working/chat.jsonl`, `working/thumbs/`, `working/voiceover/` and `renders/`. `media.db` (app config dir) is the index of projects, assets and renders. No secrets anywhere; nothing in localStorage except the last-open project slug.
- **Verified shelf:** a render is listed only after Rust confirms it exists, is over 0 bytes, passes ffprobe (A/V streams, duration within 2 %, resolution), and is within the size cap.

## 5. Phases

1. **This document** (approval).
2. **Backend:** `media.rs` + `media.db`, asset protocol / CSP / dialog, chunked ingest, voiceover save, manifest save, render runner + events, media-forge `render_timeline` and the layout move. Rust + pytest tests.
3. **Frontend:** the 4-zone page, nav entry, chat + action parser, shot list, preview, mini-timeline (reorder, trim, slate snap, VO record, volume), render card, verified shelf, plus the Brainstorm / Play Place handoff buttons. Vitest + tsc.
4. **E2E smoke** in the real app with Playwright and real clips:
   - nav and greeting;
   - 2 videos + 1 slate staged, with raw-file hashes unchanged;
   - trim / reorder / VO reflected in the manifest;
   - a Director shot list producing dropzones;
   - an approved render that runs on the CPU (VRAM unchanged), is verified on disk and plays in the player.

## 6. Decisions inside the contract (defaults; say if you want any changed)

1. **No native OS file drop.** HTML5 drop with chunked upload, plus the picker. Native drop would break drag-and-drop everywhere else in the app.
2. **Renders go through media-forge's new `render_timeline`.** shotcut-mcp is used for `.mlt` project export ("Open in Shotcut" for manual finishing), not for the default render.
3. **The Director proposes and Rust executes.** Action blocks only fill the UI; the actual render happens only on Approve & Render.
4. **Layout move** to `projects/<slug>/{raw,working,renders}`. Nothing real exists under the old layout yet; the smoke-test folder was deleted.

## 7. Phase 4 smoke results (2026-11-22, real Tauri app from this branch, Playwright over WebView2 CDP)

| # | Check | Result |
|---|---|---|
| 1 | Left nav shows **Director Suite**; it opens with "Hey Nic, what do you want to create today?" and 4 quick starts | ✅ |
| 2 | 2 videos + 1 slate staged (picker path + a real HTML5 drop through the chunked upload) | ✅ copies in `raw/` carry the read-only attribute, bytes are identical, sources are unchanged (SHA-256), thumbnails load through the asset protocol, "Raw · read-only" badges show |
| 3 | Quick edits → `timeline_manifest.json` | ✅ add ×3, drag reorder, in/out trims (1.0–4.8, 0.7–4.0), 3 s slate hold and the voiceover layer at 1.0 s are all on disk; revisions 1→10 |
| 4 | Director plans a multi-clip video → shot-list dropzones | ⏳ **not run.** LM Studio (the `director` workspace's provider) wasn't running, and 9 GB of the 12 GB VRAM was held by `llama-server`. Loading qwen3.5-9b on top would have competed with Tony. The parser and the action → slot path are covered by vitest (`actions.test.ts`, `director-store.test.ts`). |
| 5 | Approve Render Plan → CPU render → verified on disk → plays in the player | ✅ The plan card lists 3 sources + the VO layer, 1920×1080 · −18 LUFS · 10.1 s · `render_mode: cpu_only`. The render took 5.4 s; **VRAM 9244 MiB before and at peak**. Rust verification: file on disk (3.35 MB), A+V streams, 10.10 s, 1920×1080; −18.0 LUFS. It is listed in Verified Outputs and plays in the preview at 1920×1080. Frames show take2 → take1 → slate in order; the VO is audible where both clips are silent (−32 dB) and silence is correct before it. |

Not exercised in the smoke: live mic recording (the recorder's save endpoint *was* exercised with an Opus/WebM take), the native file picker dialog (its backend command was), and Shotcut (disabled by default).
