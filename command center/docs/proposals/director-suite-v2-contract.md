# Director Suite v2: contract for Part 1 (steps 1.1–1.6)

Status: **awaiting approval** · 2026-11-26 · branch `director-suite`. This changes the locked v1 contract (`src/features/director/contract.ts`). Every type here is mirrored in Rust (`media.rs`) and validated on both sides, as in v1. Old projects keep working: v1 rows are read and upgraded in place, and v1 manifests load as v2 with defaults.

## 1. Project status and brief (1.1)

```ts
export type ProjectStatus = "brief" | "shooting" | "editing" | "review" | "done";
// v1 → v2 on read: intake→brief, awaiting_media→shooting, editing→editing, rendering→editing (the job shows it), ready→review.
// Rust moves brief→shooting when a brief is approved, shooting→editing when every "film" slot is filled or Nic says "edit with what I have",
// editing→review on a verified render, and review→done on "Approve final". Nic can move any project by hand.

export type Platform = "reels" | "tiktok" | "ig_feed" | "youtube" | "shorts" | "self_tape" | "custom";

export interface CreativeBrief {
  idea: string;               // Nic's words, kept verbatim
  goal: string;               // "get booked for a dance gig", "show the new product"
  platform: Platform;
  lengthSec: number;          // 5–600
  aspect: "16:9" | "9:16" | "4:5" | "1:1";
  tone: string;               // "moody, slow, warm"
  references: string[];       // links / file names / "like X's reels", ≤ 10
  guessed: (keyof CreativeBrief)[]; // fields the Director filled with defaults (shown as "guessed")
  approved: boolean;
  updatedBy: "nic" | "director";
  updatedAt: string;
}

export interface MediaProject {           // + brief, speed; source.brief stays as the original handoff text
  slug: string; title: string; status: ProjectStatus; root: string; createdAt: string; updatedAt: string;
  source: { from: "suite" | "brainstorm" | "playplace"; refId: string | null; brief: string | null };
  brief: CreativeBrief | null;
  speed: "rough" | "polish" | "full_ai";  // Part 6 later; stored now, default "rough"
}
```

## 2. Shot list (1.2)

```ts
export type Framing = "wide" | "medium" | "mcu" | "closeup" | "insert" | "overhead" | "pov";

export interface ShotSlot {               // v1 fields + the ones marked new
  id: string; label: string; instructions: string; kind: MediaKind; targetSec: number | null;
  assetId: string | null; status: "needed" | "attached" | "approved";
  framing: Framing | null;                // new
  action: string;                         // new: what to do in it
  source: "film" | "generate" | "stock";  // new: who supplies it
  phoneTips: string[];                    // new: ≤ 4 short tips ("lock exposure on your face")
  filmed: boolean;                        // new: Nic's checklist tick, independent of attach
}
```
The shot list stays inside the manifest, saved with `media_manifest_save`, so manual add, edit, reorder and delete are manifest edits (pure ops in `manifest.ts`). There's no new command for it.

## 3. Footage intake (1.3)

```ts
export interface AssetFlag { kind: "blurry" | "dark" | "overexposed" | "clipped_audio" | "too_short" | "no_speech" | "silent" | "wrong_aspect"; detail: string }
export interface Moment { id: string; inSec: number; outSec: number; label: string; score: number /* 0–1 */; by: "director" | "nic" }

export interface MediaAsset {             // v1 fields + new
  /* …v1… */
  tags: string[];                         // new, ≤ 12, lowercase
  transcript: { path: string; lang: string; words: number; firstSpeechSec: number | null; lastSpeechSec: number | null } | null; // new: working/captions/<id>.json
  flags: AssetFlag[];                     // new: from Rust probe checks + media-forge detect_silence/scenes
  moments: Moment[];                      // new
  slotId: string | null;                  // new: the matched shot (mirror of ShotSlot.assetId)
}
```
- **Watched folder:** `<slug>/inbox/`, created with the project. A 10-second tick in `media.rs` (spawned from `lib.rs`; no new crate) moves new, stable files (size unchanged for 2 ticks) through `ingest_paths` and deletes the inbox copy only after the `raw/` copy is verified. Drive pulls and the picker keep working as they do now.
- **Pipeline per new asset** (background, CPU only, one at a time): probe → flags → `transcribe_clip` (faster-whisper CPU int8, the **tiny.en** model already on disk; small.en is better but a ~480 MB download, ask first) → `detect_scenes` → a Director `match_footage` turn proposes slot matches and moments. Nic sees them as suggestions and accepts with one click.

## 4. Edit (1.4): manifest v2 and media-forge `render_timeline` spec v2

```ts
export interface TimelineClip { id: string; assetId: string; inSec: number; outSec: number; fadeMs: number;
  transitionIn: { kind: "cut" | "crossfade" | "fade_black"; ms: number } /* new, 0–1500 */; punchIn: number /* new, 1.0–1.5 zoom */ }
export interface AudioLayer { id: string; assetId: string; startSec: number; inSec: number; outSec: number; volume: number;
  fadeInMs: number; fadeOutMs: number /* new */; duckUnderVoice: boolean /* new: sidechain under clip audio */ }
export interface CaptionTrack { enabled: boolean; style: "clean" | "bold_pop" | "karaoke" | "minimal"; position: "lower" | "middle"; maxWordsPerLine: number } // new; built from word timestamps → ASS
export interface ColorLook { preset: "none" | "warm" | "cool" | "punchy" | "film" | "bw"; strength: number /* 0–1 */ } // new; ffmpeg eq/curves
export type PlatformPreset = { platform: Platform; aspect: TimelineManifest["output"]["aspect"]; loudnessLufs: -14 | -16 | -18; maxSizeMb: number | null; maxSec: number | null };

export interface TimelineManifest {       // version 2
  version: 2; /* …v1 fields… */
  captions: CaptionTrack;                 // new
  color: ColorLook;                       // new
  outputs: PlatformPreset[];              // new: 1–4 outputs rendered from one approval; v1 `output` stays as the primary
  notes: Note[];                          // new (1.5)
}
```
The media-forge spec version goes from 1 to 2. v1 specs still render the same way, and every new key is validated. Rendering stays CPU `libx264` only.

## 5. Review loop (1.5)

```ts
export interface Note { id: string; renderId: string | null; atSec: number | null; text: string; by: "nic"; viaVoice: boolean; resolved: boolean; at: string }
export interface ReviewRound { round: 1 | 2; renderId: string; notes: string[] /* note ids */; status: "open" | "revised" | "approved"; summary: string /* Director's choices */ }
// project.json gains `review: { rounds: ReviewRound[]; openDecisions: string[] }`.
// Rules: after a verified render the Director writes a short "choices" summary (round 1). Nic's notes
// → one revise_edit → render → round 2. After round 2 the Director only lists openDecisions, and there's no round 3.
```

## 6. Hand-off (1.6)

```ts
export interface Deliverable { platform: Platform; renderId: string; path: string; captionPath: string | null; thumbPath: string | null }
// "Approve final" → renders/final/<platform>/… (copies of the verified files) and status → done.
// "Send to Biz Ops" builds the EXISTING Instagram ConfirmCard (publishes nothing by itself) with caption, hashtags
// and the media URL. Instagram needs a public https media URL: I'll first test a Drive direct-download link
// (share link from gdrive.rs). If Meta refuses it, posting stays blocked and I report it rather than adding a new host.
```

## 7. Director actions (v1 three + new)

```ts
export type DirectorAction =
  | { type: "draft_brief"; brief: Omit<CreativeBrief, "approved" | "updatedBy" | "updatedAt"> }
  | { type: "populate_shot_list"; slots: Omit<ShotSlot, "assetId" | "status" | "filmed">[] }
  | { type: "match_footage"; matches: { assetId: string; slotId: string; reason: string }[]; moments: { assetId: string; inSec: number; outSec: number; label: string; score: number }[] }
  | { type: "propose_edit_plan"; clips: Omit<TimelineClip, "id">[]; audio: Omit<AudioLayer, "id">[]; output: Partial<TimelineManifest["output"]>; captions?: Partial<CaptionTrack>; color?: Partial<ColorLook>; outputs?: Platform[]; note: string }
  | { type: "revise_edit"; round: 1 | 2; resolves: string[] /* note ids */; plan: /* same body as propose_edit_plan */ Record<string, unknown>; summary: string }
  | { type: "report_open_decisions"; items: string[] }
  | { type: "execute_verified_render" };
```
Every action is only a suggestion until Nic clicks something. Nothing renders, posts or deletes from a model reply.

## 8. New IPC

```ts
media_project_update: { args: { slug: string; title?: string; brief?: CreativeBrief; status?: ProjectStatus; speed?: MediaProject["speed"] }; result: MediaProject };
media_asset_update:   { args: { slug: string; assetId: string; tags?: string[]; moments?: Moment[]; slotId?: string | null }; result: MediaAsset };
media_intake_status:  { args: { slug: string }; result: { inbox: string; pending: number; processing: string | null; lastError: string | null } };
media_transcribe:     { args: { slug: string; assetIds: string[] }; result: { queued: number } };   // CPU, background
media_note_add:       { args: { slug: string; note: Omit<Note, "id" | "at" | "resolved"> }; result: Note };
media_note_resolve:   { args: { slug: string; noteId: string }; result: void };
media_review_get:     { args: { slug: string }; result: { rounds: ReviewRound[]; openDecisions: string[] } };
media_approve_final:  { args: { slug: string; renderIds: string[]; approved: true }; result: Deliverable[] };
// events: "media-intake" { slug; assetId; stage: "ingested" | "probed" | "transcribed" | "matched" | "failed"; detail }
```

## 9. Storage
- `media.db` gets user_version **+1**. It adds JSON columns for the new asset fields and keeps every v1 row. Briefs and reviews live in `project.json`, and notes live in the manifest.
- New folders per project: `inbox/` and `working/captions/`, which already exists in media-forge. Finals go to `renders/final/`.

## 10. Shared core this touches
- `lib.rs`: spawn the intake tick (1 line) and register the commands. That's it. No routing, gateway, model-loading or voice files change in Part 1. Voice notes on review come in Part 3 with the phone work.
