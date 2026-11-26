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
  /** v2 §1.0: the Director's own chat turn (director.rs), not a Tony turn through os_turn. */
  director_turn: { args: { req: DirectorTurnRequest }; result: DirectorTurnResult };
}
export interface DirectorTurnRequest { text: string; history: { role: "user" | "assistant"; content: string }[]; context: string; streamId: string | null }
export interface DirectorTurnResult { answer: string; providerId: string; latencyMs: number; answeredBy: "director" }
export type McpReady = { enabled: boolean; healthy: boolean; tools: number; error: string | null };

/** Events (onNativeEvent). */
export type DirectorEvents = {
  "media-render": { slug: string; jobId: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; pct: number; etaSec: number | null; stage: string; render?: VerifiedRender; error?: string };
  "media-ingest": { slug: string; uploadId: string; received: number; total: number };
};

/** Cross-page handoff ("Send to Director Suite"): sets the nav + creates or opens a project. */
export interface DirectorHandoff { from: "brainstorm" | "playplace"; refId: string; title: string; brief: string; assetPaths: string[] }
