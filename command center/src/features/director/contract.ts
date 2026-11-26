// src/features/director/contract.ts — v2, LOCKED after approval (docs/proposals/director-suite-v2-contract.md, 2026-11-26).
// v1 projects, manifests and asset rows still load: Rust (media.rs) and manifest.ts upgrade them on read.

export type MediaKind = "video" | "image" | "audio";
export type AssetRole = "clip" | "photo" | "slate" | "outro" | "voiceover" | "music" | "sfx";
/** v2. v1 → v2 on read: intake→brief, awaiting_media→shooting, editing→editing, rendering→editing, ready→review. */
export type ProjectStatus = "brief" | "shooting" | "editing" | "review" | "done";
/** The v1 statuses, still found in old project rows (mapped on read). */
export type LegacyProjectStatus = "intake" | "awaiting_media" | "editing" | "rendering" | "ready";

export type Platform = "reels" | "tiktok" | "ig_feed" | "youtube" | "shorts" | "self_tape" | "custom";
export type Aspect = "16:9" | "9:16" | "4:5" | "1:1";

export interface CreativeBrief {
  idea: string;               // Nic's words, kept verbatim
  goal: string;               // "get booked for a dance gig", "show the new product"
  platform: Platform;
  lengthSec: number;          // 5–600
  aspect: Aspect;
  tone: string;               // "moody, slow, warm"
  references: string[];       // links / file names / "like X's reels", ≤ 10
  guessed: (keyof CreativeBrief)[]; // fields the Director filled with defaults (shown as "guessed")
  approved: boolean;
  updatedBy: "nic" | "director";
  updatedAt: string;
}

export type Framing = "wide" | "medium" | "mcu" | "closeup" | "insert" | "overhead" | "pov";

export interface AssetFlag { kind: "blurry" | "dark" | "overexposed" | "clipped_audio" | "too_short" | "no_speech" | "silent" | "wrong_aspect"; detail: string }
export interface Moment { id: string; inSec: number; outSec: number; label: string; score: number /* 0–1 */; by: "director" | "nic" }
/** working/captions/<id>.json */
export interface AssetTranscript { path: string; lang: string; words: number; firstSpeechSec: number | null; lastSpeechSec: number | null }

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
  // v2 (v1 rows load with the defaults: [], null, [], [], null)
  tags: string[];             // ≤ 12, lowercase
  transcript: AssetTranscript | null;
  flags: AssetFlag[];         // Rust probe checks + media-forge detect_silence/scenes
  moments: Moment[];
  slotId: string | null;      // the matched shot (mirror of ShotSlot.assetId; the manifest is the source of truth)
}

export interface ShotSlot {
  id: string;                 // "s1", "s2"…
  label: string;              // "15s Hook"
  instructions: string;
  kind: MediaKind;
  targetSec: number | null;
  assetId: string | null;     // filled by drop/pick
  status: "needed" | "attached" | "approved";
  // v2 (v1 slots load with: null, "", "film", [], false)
  framing: Framing | null;
  action: string;             // what to do in it
  source: "film" | "generate" | "stock"; // who supplies it
  phoneTips: string[];        // ≤ 4 short tips ("lock exposure on your face")
  filmed: boolean;            // Nic's checklist tick, independent of attach
}

export interface TimelineClip {
  id: string;                 // "c-<base36>"
  assetId: string;
  inSec: number;              // 0 ≤ inSec < outSec ≤ asset duration (stills: 0)
  outSec: number;             // stills: hold length
  fadeMs: number;             // 0–2000
  transitionIn: { kind: "cut" | "crossfade" | "fade_black"; ms: number }; // v2, ms 0–1500 (v1: cut, 0)
  punchIn: number;            // v2, 1.0–1.5 zoom (v1: 1)
}

export interface AudioLayer {
  id: string;
  assetId: string;            // voiceover / music / sfx asset
  startSec: number;           // offset on the timeline
  inSec: number;
  outSec: number;
  volume: number;             // 0–2 (1 = unity)
  fadeInMs: number;           // v2, 0–10000 (v1: 0)
  fadeOutMs: number;          // v2, 0–10000 (v1: 0)
  duckUnderVoice: boolean;    // v2: sidechain under clip audio (v1: false)
}

/** v2: built from word timestamps → ASS. */
export interface CaptionTrack { enabled: boolean; style: "clean" | "bold_pop" | "karaoke" | "minimal"; position: "lower" | "middle"; maxWordsPerLine: number /* 1–12 */ }
/** v2: ffmpeg eq/curves. */
export interface ColorLook { preset: "none" | "warm" | "cool" | "punchy" | "film" | "bw"; strength: number /* 0–1 */ }
export type PlatformPreset = { platform: Platform; aspect: Aspect; loudnessLufs: -14 | -16 | -18; maxSizeMb: number | null; maxSec: number | null };

/** v2 review note (§5). Notes live in the manifest; Rust owns them (media_note_add / media_note_resolve),
 * and a manifest save keeps the saved notes rather than the client's copy. */
export interface Note { id: string; renderId: string | null; atSec: number | null; text: string; by: "nic"; viaVoice: boolean; resolved: boolean; at: string }
export interface ReviewRound { round: 1 | 2; renderId: string; notes: string[] /* note ids */; status: "open" | "revised" | "approved"; summary: string /* Director's choices */ }
export interface ProjectReview { rounds: ReviewRound[]; openDecisions: string[] }

/** §6: "Approve final" copies verified renders to renders/final/<platform>/. */
export interface Deliverable { platform: Platform; renderId: string; path: string; captionPath: string | null; thumbPath: string | null }

/** working/timeline_manifest.json — the single source of truth for the UI, the Director and the render. */
export interface TimelineManifest {
  version: 2;                 // v1 files load as v2 with defaults (manifest.ts upgradeManifest, media.rs load_manifest)
  project: string;
  revision: number;           // +1 on every save; a save with a stale revision is refused
  clips: TimelineClip[];      // order = playback order (slates are clips with role slate/outro)
  audio: AudioLayer[];
  clipAudioVolume: number;    // 0–2, the camera audio under VO/music
  output: { aspect: Aspect; loudnessLufs: -14 | -16 | -18; maxSizeMb: number | null; name: string }; // the primary output
  shotList: ShotSlot[];
  updatedBy: "nic" | "director";
  updatedAt: string;
  captions: CaptionTrack;     // v2
  color: ColorLook;           // v2
  outputs: PlatformPreset[];  // v2: 1–4 outputs rendered from one approval
  notes: Note[];              // v2 (§5)
}

export interface MediaProject {
  slug: string; title: string; status: ProjectStatus;
  root: string;               // C:\ai-hub\media\projects\<slug>
  createdAt: string; updatedAt: string;
  source: { from: "suite" | "brainstorm" | "playplace"; refId: string | null; brief: string | null }; // source.brief = the original handoff text
  brief: CreativeBrief | null;            // v2
  speed: "rough" | "polish" | "full_ai";  // v2: Part 6 later; stored now, default "rough"
  /** v2 §5: stored in project.json (media_review_get reads it). Absent on rows Rust hasn't re-saved. */
  review?: ProjectReview;
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

/** Director → UI action blocks: a fenced ```director-action JSON block in the reply. Validated in TS AND Rust.
 * Every action is only a suggestion until Nic clicks something. Nothing renders, posts or deletes from a model reply. */
export type EditPlanBody = {
  clips: Omit<TimelineClip, "id">[];
  audio: Omit<AudioLayer, "id">[];
  output: Partial<TimelineManifest["output"]>;
  captions?: Partial<CaptionTrack>;
  color?: Partial<ColorLook>;
  outputs?: Platform[];
  note: string;
};
export type DirectorAction =
  | { type: "draft_brief"; brief: Omit<CreativeBrief, "approved" | "updatedBy" | "updatedAt"> }
  | { type: "populate_shot_list"; slots: Omit<ShotSlot, "assetId" | "status" | "filmed">[] }
  | { type: "match_footage"; matches: { assetId: string; slotId: string; reason: string }[]; moments: { assetId: string; inSec: number; outSec: number; label: string; score: number }[] }
  | ({ type: "propose_edit_plan" } & EditPlanBody)
  | { type: "revise_edit"; round: 1 | 2; resolves: string[] /* note ids */; plan: Record<string, unknown> /* same body as propose_edit_plan */; summary: string }
  | { type: "report_open_decisions"; items: string[] }
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
  // ── v2 (§8) ──
  media_project_update: { args: { slug: string; title?: string; brief?: CreativeBrief; status?: ProjectStatus; speed?: MediaProject["speed"] }; result: MediaProject };
  media_asset_update: { args: { slug: string; assetId: string; tags?: string[]; moments?: Moment[]; slotId?: string | null }; result: MediaAsset };
  media_intake_status: { args: { slug: string }; result: { inbox: string; pending: number; processing: string | null; lastError: string | null } };
  media_transcribe: { args: { slug: string; assetIds: string[] }; result: { queued: number } };   // CPU, background
  media_note_add: { args: { slug: string; note: Omit<Note, "id" | "at" | "resolved"> }; result: Note };
  media_note_resolve: { args: { slug: string; noteId: string }; result: void };
  media_review_get: { args: { slug: string }; result: ProjectReview };
  media_approve_final: { args: { slug: string; renderIds: string[]; approved: true }; result: Deliverable[] };
}
export interface DirectorTurnRequest { text: string; history: { role: "user" | "assistant"; content: string }[]; context: string; streamId: string | null }
export interface DirectorTurnResult { answer: string; providerId: string; latencyMs: number; answeredBy: "director" }
export type McpReady = { enabled: boolean; healthy: boolean; tools: number; error: string | null };

/** Events (onNativeEvent). */
export type DirectorEvents = {
  "media-render": { slug: string; jobId: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; pct: number; etaSec: number | null; stage: string; render?: VerifiedRender; error?: string };
  "media-ingest": { slug: string; uploadId: string; received: number; total: number };
  "media-intake": { slug: string; assetId: string; stage: "ingested" | "probed" | "transcribed" | "matched" | "failed"; detail: string };
};

/** Cross-page handoff ("Send to Director Suite"): sets the nav + creates or opens a project. */
export interface DirectorHandoff { from: "brainstorm" | "playplace"; refId: string; title: string; brief: string; assetPaths: string[] }
