# Director Suite Part 3: UI contract

Status: DRAFT for approval (component-contract). Nothing is built until this is approved.
Date: 2026-11-27. Branch: `director-suite`. Builds on `director-suite-v2-contract.md` (v2, locked).

Part 3 adds three things to the page:

- **A. Generate.** A UI for the ComfyUI backend (`comfy.rs`), which has no UI yet: a Generate panel, a render queue, a GPU baton pill, and Re-roll / Tweak on generated assets.
- **B. Navigation.** Note markers on the timeline, a projects board, and bin filters.
- **C. Versions.** Restore a past render's cut, and compare two renders A/B.

## 0. Rules this contract keeps

- **Suggestions vs clicks.** Director actions stay suggestions. Anything that starts GPU work is an explicit click: Enqueue, Re-roll, Run now. Nothing here enqueues from a model reply.
  - Enqueue under the `idle` / `overnight` policy does start GPU work later on its own. The panel says so under the button: "Runs when the PC is idle. Tony is unloaded for the batch, then put back."
- **Components.** Each new panel is a pure `XxxView(props)` plus a thin store-connected wrapper.
  - Styling uses Tailwind utilities (`pill-glass`, `pill-primary`, `field`, `label-caps`, `text-teal-soft` / `text-amber-soft` / `text-violet`) and the existing `Card` / `Empty` / `Select`.
  - Any page-scoped CSS goes in `director.css` under `.director-suite`.
  - Copy is plain and short, with no pronouns for Nic.
- **GPU budget (HANDOFF.md §8).** No new rAF loop and no new infinite CSS animation.
  - Compare sync is event-driven (`play` / `pause` / `seeked` / `timeupdate`), never a frame loop.
  - The baton pill dot is static (no `animate-pulse`).
  - No `.glass` inside `.glass`: new panels inside an existing card use `well` / `border-white/10` boxes.
- **Off limits.** Gateway `server.py`, `dispatch.rs`, `agents.rs`, `scheduler.rs`, model loading and voice are not touched.
  - `lib.rs` gets command registration lines only.
  - The only Rust work is in `media.rs` (C.1) and one optional field addition in `comfy.rs` (A.1).
- **Bridge failures.** Unmocked native commands throw in the Playwright fake desktop. Every new poll and fetch must fail quietly: the panel hides or shows "ComfyUI status unavailable", and nothing throws into React. The existing `director-suite-v2.spec.ts` must keep passing without changes.

---

## A. ComfyUI

### A.1 Types (new, `src/features/director/contract.ts`)

These mirror the Rust serde JSON exactly:

- `comfy.rs`: `#[serde(rename_all = "camelCase")]` on `Job`, `JobOutput`, `ComfySettings`, `QueueFile` and `SettingsPatch`; `lowercase` on `JobStatus` and `Policy`.
- `comfy_status` builds its JSON by hand with `json!` (key names checked at comfy.rs L1966–1980).

```ts
// ── ComfyUI (comfy.rs, comfy_templates.rs) ──
export type ComfyJobStatus = "queued" | "waiting" | "running" | "done" | "failed" | "cancelled"; // waiting = a model file is missing (`error` says which)
export type ComfyPolicy = "idle" | "overnight" | "manual";                                     // default "idle"
/** comfy_templates.rs ASPECTS (the manifest's four + 4:3 / 3:4 for stills). */
export type ComfyAspect = "16:9" | "9:16" | "4:5" | "1:1" | "4:3" | "3:4";
export type ComfyTemplateName = "scene-still" | "thumbnail-bg" | "style-transfer" | "upscale" | "broll-motion";

/** What the UI sends as `params` (GenParams, camelCase). `slug` / `jobId` are set by Rust, never sent.
 * Omit `seed` for a random one (Rust picks it at enqueue and stores it on the job, ≤ 2^53).
 * Omit `aspect` and `width` / `height` for the project's aspect (thumbnail-bg falls back to 16:9, others to 1:1). */
export interface ComfyParams {
  prompt: string;          // ≤ COMFY_PROMPT_MAX (2000) chars
  negative?: string;       // inert at cfg 1.0 (SDXL Turbo); kept for provenance
  seed?: number;           // integer 0 … 2^53-1
  steps?: number;          // 1 … COMFY_TURBO_MAX_STEPS (4); default 1
  width?: number;          // 0 or 64 … 1024 (0 = from aspect)
  height?: number;
  aspect?: ComfyAspect;
  inputImage?: string;     // style-transfer / upscale: an image asset's absolute `path` inside this project
  denoise?: number;        // style-transfer 0.3 … 0.7 (default 0.5 in the panel); others 1.0
}

export interface ComfyJobOutput { path: string; filename: string; kind: "image" | "video"; assetId: string | null; gen: GenMeta }

export interface ComfyJob {
  id: string;
  slug: string;
  template: string;
  /** As stored at enqueue (seed and default aspect filled in). An absolute inputImage stays absolute here (staging only changes the copy sent to ComfyUI). */
  params: Partial<ComfyParams> & Record<string, unknown>;
  status: ComfyJobStatus;
  createdAt: number;        // epoch ms
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  outputs: ComfyJobOutput[];
  renderMs: number | null;
  peakVramMb: number | null;
  promptId: string | null;
}

export interface ComfySettings { modelRoots: string[]; policy: ComfyPolicy }

/** One row of comfy_status.templates. `label` / `kind` / `implemented` / `unavailableReason` are the
 * optional A.1 Rust addition (copied from comfy_templates::list()); until then the UI uses COMFY_TEMPLATE_META. */
export interface ComfyTemplateInfo {
  name: string;
  requiredModels: string[];
  missing: string[];
  ready: boolean;           // every required model is on disk (says nothing about `implemented`)
  note: string | null;      // "needs model checkpoints/…" when missing, else null
  label?: string;
  kind?: "image" | "video";
  implemented?: boolean;
  unavailableReason?: string | null;
}

/** comfy_status.lastBatch: a BatchReport, or a crash-recovery result. Loose on purpose; the UI reads only these. */
export interface ComfyLastBatch {
  kind?: string; label?: string; finishedAt?: number;
  done?: string[]; failed?: string[]; requeued?: string[]; cancelled?: string[];
  preempted?: string | null; deferred?: string | null; error?: string | null;
  restore?: { ok: boolean } | null;
}

export interface ComfyStatus {
  up: boolean;
  version: string | null;
  running: boolean;          // a batch holds (or is getting) the GPU
  phase: string;             // "" | "waiting for the GPU slot" | "unloading LLMs" | "starting ComfyUI" | "rendering <template> (n/m)" | "putting Tony back"
  admission: string;         // "running" | "not checked yet" | the admit() refusal ("manual policy: press Run now", "mid-conversation (…)", …)
  runNow: boolean;
  templates: ComfyTemplateInfo[];
  counts: Record<ComfyJobStatus, number>;
  settings: ComfySettings;
  crashMarker: boolean;
  lastBatch: ComfyLastBatch | null;
  backoff: { failures: number; untilMs: number | null };
  recoveryAttempts: number;
}

export interface ComfyQueue { version: number; settings: ComfySettings; jobs: ComfyJob[] }

/** comfy-service payloads (comfy.rs run_batch). */
export type ComfyServiceEvent =
  | { phase: "waiting for the GPU slot" | "putting Tony back"; label: string }
  | { phase: "starting ComfyUI" }
  | { phase: "rendering"; up: true; version: string | null }
  | { phase: "idle"; deferred?: string | null; batch?: { done: number; failed: number; requeued: number; error: string | null; restoreOk: boolean | null } };

export const COMFY_PROMPT_MAX = 2000;
export const COMFY_TURBO_MAX_STEPS = 4;
export const COMFY_STYLE_DENOISE: readonly [number, number] = [0.3, 0.7];
export const COMFY_UPSCALE_MAX_INPUT_SIDE = 2048;
export const COMFY_ASPECTS: readonly ComfyAspect[] = ["16:9", "9:16", "4:5", "1:1", "4:3", "3:4"];
/** Fallback until comfy_status carries label/kind/implemented (keep in step with comfy_templates.rs TEMPLATES). */
export const COMFY_TEMPLATE_META: Record<ComfyTemplateName, { label: string; kind: "image" | "video"; implemented: boolean; needsInput: boolean; unavailableReason?: string }> = {
  "scene-still":    { label: "Scene still", kind: "image", implemented: true, needsInput: false },
  "thumbnail-bg":   { label: "Thumbnail background", kind: "image", implemented: true, needsInput: false },
  "style-transfer": { label: "Style transfer", kind: "image", implemented: true, needsInput: true },
  "upscale":        { label: "Upscale 4x", kind: "image", implemented: true, needsInput: true },
  "broll-motion":   { label: "B-roll motion", kind: "video", implemented: false, needsInput: false, unavailableReason: "Not built yet: needs a video model." },
};
```

**Optional Rust addition (A.1, comfy.rs `comfy_status` only).** Add `"label"`, `"kind"`, `"implemented"` and `"unavailableReason"` from `templates::list()` to each template row. With it, `broll-motion` can never show as ready just because its weights happen to be on disk. Without it, the UI ANDs `ready` with `COMFY_TEMPLATE_META[name].implemented`. Either way the UI must work.

### A.2 `DirectorCommands` entries (contract.ts; Rust snake_case params, Tauri camelCase args)

```ts
  // ── Part 3: ComfyUI (comfy.rs) ──
  comfy_status: { args: undefined; result: ComfyStatus };
  /** Refused for an unknown / unbuilt template, params that could never render (dry-run fill), or an inputImage outside the project.
   * A template with a missing model is accepted as status "waiting". */
  comfy_enqueue: { args: { slug: string; template: string; params?: ComfyParams }; result: ComfyJob };
  comfy_cancel: { args: { id: string }; result: ComfyJob };
  /** Skips the policy and lifts the failure backoff, never the mid-conversation / boot-grace checks. `now` = "starting" or why not yet. */
  comfy_run_now: { args: undefined; result: { accepted: boolean; now: string } };
  comfy_queue_get: { args: undefined; result: ComfyQueue };
  comfy_settings_set: { args: { patch: { modelRoots?: string[]; policy?: ComfyPolicy } }; result: ComfySettings };
```

`DirectorEvents` additions:

```ts
  "comfy-queue": ComfyJob;                        // every job change (enqueue, waiting↔queued, start, finish, cancel)
  "comfy-service": ComfyServiceEvent;
  "comfy-asset": { slug: string; assetId: string }; // a generated output was ingested into the project
  "director-report": { kind: "comfy-batch"; slug: string; done: number; failed: number }; // one per project a batch touched
```

The GPU baton reuses the existing `gpu_slot_view` command (platform.ts `SlotView`) and the `gpu-slot` event (`onNativeEvent`), as `OsControls.ActiveSlotPill` already does.

### A.3 api wrappers (`api.ts`)

```ts
  comfyStatus: (): Promise<Result<"comfy_status">> => xcmd("comfy_status"),
  /** Only ever from an Enqueue / Re-roll click. */
  comfyEnqueue: (a: Args<"comfy_enqueue">): Promise<Result<"comfy_enqueue">> => xcmd("comfy_enqueue", a),
  comfyCancel: (a: Args<"comfy_cancel">): Promise<Result<"comfy_cancel">> => xcmd("comfy_cancel", a),
  /** Only ever from the queue's Run now click. */
  comfyRunNow: (): Promise<Result<"comfy_run_now">> => xcmd("comfy_run_now"),
  comfyQueue: (): Promise<Result<"comfy_queue_get">> => xcmd("comfy_queue_get"),
  comfySettingsSet: (a: Args<"comfy_settings_set">): Promise<Result<"comfy_settings_set">> => xcmd("comfy_settings_set", a),
```

### A.4 Store slice: `src/features/director/comfy-store.ts` (new, own zustand store `useComfy`)

This is a separate file so `director-store.ts` (1042 lines) does not grow. It imports `refreshAssets` / `useDirector` from director-store. Nothing in director-store imports it, so there is no cycle.

```ts
export interface GenerateDraft {
  template: ComfyTemplateName;
  prompt: string;
  negative: string;
  seed: number | null;          // null = random at enqueue
  aspect: ComfyAspect | null;   // null = the project's aspect
  steps: number;                // 1–4
  denoise: number;              // used by style-transfer only
  inputAssetId: string | null;  // style-transfer / upscale (resolved to the asset's path at enqueue)
  /** Set by Tweak: which asset this draft came from (shown as "Tweaking <name>"). */
  fromAssetId: string | null;
}

export interface ComfyState {
  status: ComfyStatus | null;
  statusError: string | null;   // last comfy_status error (bridge down / not mocked); panels hide or say "ComfyUI status unavailable"
  jobs: ComfyJob[];             // whole queue (all projects); views filter by slug
  slot: SlotView | null;        // gpu_slot_view / gpu-slot
  draft: GenerateDraft;         // the Generate panel's fields (Tweak writes here)
  generateOpen: boolean;        // panel expanded (Tweak / "Generate for this shot" opens it)
  busy: { enqueue: boolean; runNow: boolean; policy: boolean; cancel: string | null /* job id */ };
}

export const COMFY_STATUS_POLL_MS = 10_000;
export const COMFY_STATUS_DEBOUNCE_MS = 300;
export const defaultDraft = (): GenerateDraft;  // scene-still, "", "", null, null, 1, 0.5, null, null

export const useComfy: UseBoundStore<StoreApi<ComfyState>>;
/** comfy_status + comfy_queue_get; errors land in statusError, never throw. */
export async function refreshComfy(): Promise<void>;
/** Upsert one job by id (from comfy-queue or a command result). Pure reducer exported for tests: */
export function upsertJob(jobs: ComfyJob[], job: ComfyJob): ComfyJob[];
export const setDraft: (patch: Partial<GenerateDraft>) => void;
export const openGenerate: (open: boolean) => void;
/** Validates with generateBlocker(); enqueues for the open project; toast on refusal. Resolves the job or null. */
export async function enqueueDraft(): Promise<ComfyJob | null>;
export async function enqueue(slug: string, template: string, params: ComfyParams): Promise<ComfyJob | null>;
export async function cancelJob(id: string): Promise<boolean>;
/** Toast with `now` ("starting" or the reason it waits). */
export async function runNow(): Promise<boolean>;
export async function setPolicy(policy: ComfyPolicy): Promise<boolean>;
/** Re-roll: the same params with a new seed (seed omitted, Rust picks one). Needs the source job (by gen.comfyJobId) for img2img templates. */
export async function reroll(asset: MediaAsset): Promise<ComfyJob | null>;
/** Tweak: prefill the draft from the asset's generation (and its job's params when still in the queue), open the panel. */
export function tweak(asset: MediaAsset): void;
/**
 * Wiring (called from DirectorStudio's mount effect, next to startDirectorEvents):
 *  - comfy-queue      → upsertJob; if a job of the open project turned done, refreshAssets(slug) once
 *  - comfy-service    → debounced refreshComfy() (status only); phase "idle" with a batch → toast "N stills ready" / "N failed"
 *  - comfy-asset      → if payload.slug === useDirector.getState().slug → refreshAssets(slug) (debounced 300 ms; several outputs arrive together)
 *  - director-report  → ignored here (the Director reads it later; no UI)
 *  - gpu-slot         → set({ slot })
 *  - initial refreshComfy() + gpu_slot_view; the status poll lives in the StudioBar wrapper (usePoll, COMFY_STATUS_POLL_MS)
 * Returns the unsubscribe.
 */
export async function startComfyEvents(): Promise<() => void>;
export function resetComfyStore(): void; // tests
```

Pure helpers (`src/features/director/comfy-ui.ts`, new, no store or IPC, unit-tested):

```ts
/** Why Enqueue is disabled, or null when it can go. In order:
 *  no project → "Open a project first"
 *  statusError / !status → "ComfyUI status unavailable"
 *  template not implemented → meta.unavailableReason
 *  template not ready → info.note ("needs model …")  (enqueue would only park it as "waiting")
 *  prompt empty (not upscale) → "Write a prompt"; > COMFY_PROMPT_MAX → "Prompt is too long (2000 max)"
 *  needsInput and no input → "Pick a still from the bin"; upscale input long side > 2048 → "That still is too big to upscale (2048 px max)"
 *  steps outside 1–4, denoise outside 0.3–0.7 (style-transfer), seed not an integer in 0…2^53-1 → the field's message */
export function generateBlocker(d: GenerateDraft, info: ComfyTemplateInfo | undefined, status: ComfyStatus | null, input: MediaAsset | null, hasProject: boolean): string | null;
/** Draft → params (drops seed when null, aspect when null, denoise unless style-transfer, inputImage = asset.path). */
export function draftToParams(d: GenerateDraft, input: MediaAsset | null): ComfyParams;
/** Image assets of this project usable as an input (kind "image"; for upscale, long side ≤ 2048). */
export function inputCandidates(assets: MediaAsset[], template: ComfyTemplateName): MediaAsset[];
/** Re-roll / Tweak source: the job's stored params when `job` is given (exact, incl. inputImage), else from GenMeta
 * (prompt, negative, steps, width, height, denoise; no input). Err when the template needs an input and none is known. */
export function paramsFromGeneration(gen: GenMeta, job: ComfyJob | undefined): { template: string; params: ComfyParams } | { error: string };
export function draftFromGeneration(gen: GenMeta, job: ComfyJob | undefined, assets: MediaAsset[], assetId: string): GenerateDraft;
/** Nearest COMFY_ASPECTS entry to w×h (for Tweak; null when 0×0). */
export function aspectOf(width: number, height: number): ComfyAspect | null;
export const randomSeed: () => number; // crypto.getRandomValues → integer < 2^53

// ── Queue display ──
export type QueueDisplay = "queued" | "waiting_idle" | "waiting_model" | "running" | "done" | "failed" | "cancelled";
export interface QueueDisplayInfo { state: QueueDisplay; label: string; detail: string | null; tone: "teal" | "amber" | "violet" | "alert" | "muted" }
/**
 * Pure. status + policy + admission + phase → what the row says:
 *  done → done "Done" (teal);  failed → failed "Failed" + job.error (alert);  cancelled → cancelled "Cancelled" (muted)
 *  waiting → waiting_model "Waiting for a model" + job.error ("needs model …") (amber)
 *  running → running "Running" + phase (violet)
 *  queued:
 *    comfy.running → queued "In line" + phase
 *    admission === "running" or comfy null → queued "Queued"
 *    else waiting_idle, label by policy: idle "Waiting for idle", overnight "Waiting for 01:00–06:00", manual "Waiting for Run now";
 *         detail = admission (Rust's words: "mid-conversation (…)", "app just started (…)", "backing off …")
 */
export function deriveQueueDisplay(job: Pick<ComfyJob, "status" | "error">, comfy: Pick<ComfyStatus, "running" | "phase" | "admission" | "settings"> | null): QueueDisplayInfo;
/** The CPU export job (media-render) in the same vocabulary: queued → "queued", running → "running" (+ pct / stage), done/failed/cancelled. */
export function exportDisplay(job: RenderJob): QueueDisplayInfo;

// ── Baton ──
export interface BatonInfo { who: "tony" | "comfy" | "other" | "free"; label: string; detail: string | null; tone: PillTone }
/**
 * Pure. Who holds the GPU right now:
 *  comfy.running && phase         → comfy  "ComfyUI · <phase>"           (violet / amber)
 *  slot.active has "comfyui"      → comfy  "ComfyUI · rendering"
 *  slot.active has "Tony"         → tony   "GPU · Tony"
 *  other active label             → other  "GPU · <last ' · ' segment>"
 *  none                           → free   "GPU free"   (+ " · CPU render" when a media-render job is queued/running)
 *  detail (title): every active label, queued counts, ComfyUI queued/waiting counts.
 */
export function batonInfo(slot: SlotView | null, comfy: Pick<ComfyStatus, "running" | "phase" | "counts"> | null, render: RenderJob | null): BatonInfo;
```

### A.5 Views

```ts
/** Centre column, under OutputsCard. Collapsed: one row ("Generate a still" + the selected template's readiness dot). */
export interface GeneratePanelProps {
  open: boolean;
  onToggle: (open: boolean) => void;
  templates: (ComfyTemplateInfo & { label: string; implemented: boolean; needsInput: boolean })[]; // merged with COMFY_TEMPLATE_META
  draft: GenerateDraft;
  onDraft: (patch: Partial<GenerateDraft>) => void;
  projectAspect: Aspect | null;          // shown as "Project (9:16)" for aspect null
  inputs: MediaAsset[];                  // inputCandidates(...) for the selected template
  tweakingName: string | null;           // "Tweaking still_03.png" + a Clear link (onDraft defaultDraft)
  blocker: string | null;                // generateBlocker(...); Enqueue disabled with this as the visible reason
  policy: ComfyPolicy | null;            // for the line under Enqueue ("Runs when the PC is idle…" / "…01:00–06:00" / "…when you press Run now")
  busy: boolean;
  onEnqueue: () => void;
}
export function GeneratePanelView(p: GeneratePanelProps): JSX.Element;
export function GeneratePanel(): JSX.Element | null; // null when no project; reads useComfy + useDirector
```

Fields, top to bottom:

- **Template.** A `Select`, one option per template. Unavailable ones are disabled with " (not ready)", and the note shows under it in `text-amber-soft`.
- **Prompt.** A textarea with a live `n / 2000` count. Hidden for upscale.
- **Negative.** A one-line field with the hint "Has little effect on SDXL Turbo".
- **Seed.** A number field with a "Random" toggle (on = seed null) and a dice button that fills `randomSeed()`.
- **Aspect.** A `Select`: "Project (x)" plus `COMFY_ASPECTS`. Hidden for style-transfer / upscale, which keep the source size.
- **Steps.** A 1–4 range.
- **Denoise.** A 0.3–0.7 range, style-transfer only.
- **Input.** A small thumb grid of `inputs`, shown only when `needsInput`. Empty grid: "Add a still to the bin first."
- **Enqueue.** A `pill-primary` button. When disabled it shows `blocker` beside it, not only in a tooltip.

```ts
/** Centre column, directly under GeneratePanel (one card: "Queue"). Hidden when there are no rows and nothing is generating. */
export type QueueRow =
  | { kind: "export"; id: string; title: string; display: QueueDisplayInfo; pct: number | null; canCancel: boolean }
  | { kind: "comfy"; id: string; title: string /* template label + prompt (40 chars) */; display: QueueDisplayInfo; createdAt: number; finishedAt: number | null; canCancel: boolean /* queued | waiting | running */; outputAssetIds: string[] };
export interface RenderQueueProps {
  rows: QueueRow[];                       // the media-render job for this slug first, then this slug's comfy jobs, newest first, finished capped at 8 (+ "Show all")
  policy: ComfyPolicy | null;
  runNowBlocked: string | null;           // null, or why (no queued jobs: "Nothing queued"; status unavailable)
  admission: string | null;               // Rust's admission line, shown small under the header when it isn't "running"
  busy: { runNow: boolean; policy: boolean; cancel: string | null };
  onCancel: (row: QueueRow) => void;      // export → api.renderCancel; comfy → cancelJob
  onRunNow: () => void;
  onPolicy: (p: ComfyPolicy) => void;     // Select: "When idle" | "Overnight (01:00–06:00)" | "Only on Run now"
  onShowOutput: (assetId: string) => void; // select({kind:"asset"}) in the bin
}
export function RenderQueueView(p: RenderQueueProps): JSX.Element | null;
export function RenderQueue(): JSX.Element | null;
```

The policy is global (all projects). The select's title says so: "Applies to every project".

```ts
/** StudioBar, left of RenderBadge. Static dot, no animation. Hidden when slot and comfy status are both unknown. */
export function BatonPillView({ info }: { info: BatonInfo }): JSX.Element;
export function BatonPill(): JSX.Element | null; // useComfy slot/status + useDirector job; StudioBar also runs usePoll(refreshComfy, COMFY_STATUS_POLL_MS)
```

GenerationBlock (AssetDetails.tsx) gets two buttons next to "Copy settings". The old comment "Re-roll / tweak come with the Generate panel" is removed.

```ts
export function GenerationBlock(p: {
  gen: GenMeta;
  onCopy: (json: string) => void;
  onReroll?: () => void;          // same params, new seed → enqueue (explicit click; toast "Queued: re-roll of <name>")
  onTweak?: () => void;           // prefill + open the Generate panel, scroll it into view
  rerollBlocked?: string | null;  // e.g. "The source still for this one isn't known any more" (img2img with the job pruned)
}): JSX.Element;
```

The `AssetDetails` wrapper passes `reroll(asset)` / `tweak(asset)` from comfy-store.

Small extra: a ShotSlot with `source: "generate"` gets a "Generate…" link in ShotSlotCard. It calls `setDraft({ prompt: slot.instructions || slot.label })` plus `openGenerate(true)`. Suggestion only; nothing is enqueued.

---

## B. Navigation

### B.1 Note markers on MiniTimeline

```ts
// review-ui.ts (pure)
export interface NoteMarker { id: string; x: number /* 0–1 along the clip strip */; resolved: boolean; onRender: boolean; text: string; target: { sel: Selection; sec: number } }
/** Notes with atSec → markers. Timeline notes: x = atSec / total. Render notes: x = atSec / render duration
 * (`onRender: true`, drawn hollow: the render's cut may differ from the timeline). target = noteTarget(note, manifest).
 * Skips notes without atSec or target; clamps x to [0, 1]. Sorted by x. */
export function noteMarkers(notes: Note[], manifest: Pick<TimelineManifest, "clips"> | null, totalSec: number, renders: Pick<VerifiedRender, "id" | "durationSec">[]): NoteMarker[];

// MiniTimeline.tsx
export function NoteMarkersView(p: { markers: NoteMarker[]; onSeek: (m: NoteMarker) => void }): JSX.Element | null;
```

- **Placement.** A 10 px lane directly above the clip strip in the Timeline card.
- **Marker shape.** Each marker is a small `button` with an amber dot. A render note's dot is hollow, and a resolved note's dot is `opacity-40`. The `aria-label` is "Note at 0:02.5: tighter here".
- **Click.** `seekTo(m.target.sel, m.target.sec)`, the same path ReviewPanel uses.
- **Layout.** The lane is laid out by percentage of the strip width. The strip's clip widths are clamped (72–220 px), so the wrapper computes x against the real clip boxes instead: `markerLeftPx(x, clipWidths)`, a pure helper that maps timeline seconds to the strip using the same widths it renders.

### B.2 Projects board

```ts
// EmptyState.tsx: replaces the recent list under the quick starts (no project open); StudioBar's project Select gains "All projects…" (closeProject()).
export type ProjectsLayout = "board" | "list";
export interface ProjectsFilter { text: string; statuses: ProjectStatus[] /* [] = all */ }
/** Pure: title/slug contains text (case-insensitive), status in statuses; newest updatedAt first. */
export function filterProjects(projects: MediaProject[], f: ProjectsFilter): MediaProject[];
export const STATUS_LABEL: Record<ProjectStatus, string>; // Brief · Shooting · Editing · Review · Done
export interface ProjectsBoardProps {
  projects: MediaProject[];
  loaded: boolean;
  layout: ProjectsLayout;                  // remembered per viewer in localStorage (try/catch), default "board"
  filter: ProjectsFilter;
  busySlug: string | null;
  onLayout: (l: ProjectsLayout) => void;
  onFilter: (f: ProjectsFilter) => void;
  onOpen: (slug: string) => void;
  onStatus: (slug: string, status: ProjectStatus) => void;
}
export function ProjectsBoardView(p: ProjectsBoardProps): JSX.Element;
export function StatusChipView(p: { status: ProjectStatus; busy: boolean; onChange: (s: ProjectStatus) => void }): JSX.Element; // chip button → small menu of the 5 statuses (Escape / outside click closes)
```

- **Board.** Five columns, one per status, each with a count. Each card shows the title, `updatedAt` (relative) and a StatusChip. Columns scroll horizontally below `md`.
- **List.** One row per project with the same chip.
- **No drag and drop.** Status changes only through the chip menu.

Store (director-store.ts, one new function):

```ts
/** media_project_update({ slug, status }); replaces the row in `projects` (and `project` when it is the open one). Toast on refusal. */
export async function setProjectStatus(slug: string, status: ProjectStatus): Promise<boolean>;
```

### B.3 Bin filters

```ts
// StagingBin.tsx
export interface BinFilter { tag: string | null; flag: AssetFlag["kind"] | "any" | null; generatedOnly: boolean }
export const NO_BIN_FILTER: BinFilter;
/** Pure. tag: asset.tags includes it; flag "any": ≥ 1 flag, a kind: that flag; generatedOnly: asset.generation != null. */
export function filterAssets(assets: MediaAsset[], f: BinFilter): MediaAsset[];
/** Tags in use, most used first (for the tag Select). */
export function binTags(assets: MediaAsset[]): string[];
export function BinFilterBarView(p: { filter: BinFilter; tags: string[]; flagKinds: AssetFlag["kind"][] /* present in the bin */; shown: number; total: number; onChange: (f: BinFilter) => void }): JSX.Element | null; // null when the bin has < 4 assets and no filter is on
```

- **Placement.** One compact row under the bin's header: Tag `Select`, Flag `Select` (Any / each kind present, labels from `FLAG_LABEL`), a "Generated" toggle pill, and "Showing 3 of 12 · Clear" when a filter is on.
- **State.** The filter lives in StagingBin's local state. It resets on project switch and is not persisted.
- **Uploads.** In-progress uploads are always shown, whatever the filter.

---

## C. Versions

### C.1 Rust (media.rs; two registration lines in lib.rs)

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSnapshot { pub render_id: String, pub plan_id: String, pub manifest: Option<TimelineManifest>, pub created_at: String }

/// The cut a render was made from: plan_snapshot(render.plan_id) (notes and shot list are empty in it by design).
/// Err when the render isn't in this project. `manifest: None` for renders from before snapshots existed.
/// created_at = the render's createdAt (the kv row has no time). Reads only.
#[tauri::command]
pub async fn media_render_snapshot(app: tauri::AppHandle, slug: String, render_id: String) -> Result<RenderSnapshot, String>;

/// Make that cut the working manifest: clips, audio, clipAudioVolume, output, captions, color, outputs come from the snapshot;
/// project, notes and shotList stay the current ones; updatedBy "nic"; revision = current (then manifest_save bumps it).
/// Goes through manifest_save, so validate_manifest still refuses clips whose asset is gone, and a concurrent save
/// gets STALE_REVISION. Refuses "NO_SNAPSHOT: this render was made before versions were kept, so its cut can't be restored."
#[tauri::command]
pub async fn media_manifest_restore(app: tauri::AppHandle, slug: String, render_id: String, revision: Option<u64>) -> Result<TimelineManifest, String>;
```

Rust tests (media.rs `#[cfg(test)]`, temp dirs) cover four cases:

- snapshot round-trip
- restore keeps notes and shot list
- restore refuses without a snapshot
- restore refuses a render from another project

TS (contract.ts `DirectorCommands`, api.ts):

```ts
  media_render_snapshot: { args: { slug: string; renderId: string }; result: { renderId: string; planId: string; manifest: TimelineManifest | null; createdAt: string } };
  media_manifest_restore: { args: { slug: string; renderId: string; revision?: number }; result: TimelineManifest };
// api
  renderSnapshot: (a) => xcmd("media_render_snapshot", a),
  /** Only from the Versions confirm click. */
  manifestRestore: (a) => xcmd("media_manifest_restore", a),
```

Store (director-store.ts):

```ts
export interface DirectorUndo { id: string; slug: string; before: …; /** new, optional */ what?: "director" | "restore" }
/** flushSave() first; then manifestRestore; set the undo point (undoFields of the manifest before) with what "restore", manifest = result,
 * plan/revision cleared; toast "Version v003 restored · Undo". undoDirectorEdit's toast says "Restore undone" when what === "restore". */
export async function restoreVersion(renderId: string): Promise<boolean>;
/** Cached per renderId in the module (snapshots never change). */
export async function loadSnapshot(renderId: string): Promise<TimelineManifest | null>;
// compare state (new field, reset on project switch)
compare: { a: string; b: string } | null;    // render ids
export const openCompare: (a: string, b: string) => void;
export const closeCompare: () => void;
```

### C.2 Pure helpers (`src/features/director/versions.ts`, new)

```ts
/** "renders/demo_v003.mp4" → 3; null without _vNNN. */
export function renderVersion(path: string): number | null;
export interface VersionRow { renderId: string; version: number | null; name: string; createdAt: string; planId: string; durationSec: number; width: number; height: number; current: boolean /* its plan = the latest used plan */ }
/** Renders (newest first) → rows; renders sharing a planId (multi-output) are kept as one restore target (first row carries the button). */
export function versionRows(renders: VerifiedRender[]): VersionRow[];

export interface DiffSummary { same: boolean; lines: string[] }
/**
 * Pure. What changed from A to B in what renders (ids, revisions, notes, shot list, updatedAt ignored):
 * "2 clips added (beach.mp4, spin.mp4)", "1 clip removed", "order changed", "clip 2 trimmed 3.0s → 2.4s",
 * "length 0:28 → 0:31", "music added", "voiceover volume 1.0 → 0.8", "captions on (bold pop)", "colour warm → film",
 * "outputs + youtube", "aspect 9:16 → 16:9". ≤ 8 lines, then "+N more". same → lines = ["Same cut"].
 * Asset names come from `names` (id → name), else the id.
 */
export function diffSummary(a: TimelineManifest, b: TimelineManifest, names?: Record<string, string>): DiffSummary;

/** A/B sync (no rAF): call from the leader video's play / pause / seeked / timeupdate events.
 * Returns what to do to the follower: seek when |Δt| > tolerance (default 0.15 s), play/pause when they differ. */
export interface VideoClock { paused: boolean; currentTime: number; duration: number }
export function syncFollower(leader: VideoClock, follower: VideoClock, tolerance?: number): { seekTo: number | null; play: boolean | null };
```

### C.3 Views

```ts
/** Right column, inside the VerifiedShelf card as a second tab: "Outputs | Versions" (one card, no nested glass). */
export interface VersionsProps {
  rows: VersionRow[];
  confirming: string | null;          // renderId awaiting confirm
  busy: string | null;
  diff: Record<string, DiffSummary | "none" | "loading">; // vs the working manifest, loaded on expand ("none" = no snapshot)
  compareA: string | null;            // first pick for Compare
  onExpand: (renderId: string) => void;  // loads the snapshot and diffSummary(snapshot, working)
  onAskRestore: (renderId: string) => void;
  onConfirmRestore: (renderId: string) => void; // "Restore v003's cut? The timeline becomes that cut; notes and the shot list stay. Undo is available."
  onCancel: () => void;
  onCompare: (renderId: string) => void; // first click marks A, second opens Compare with B
}
export function VersionsView(p: VersionsProps): JSX.Element;
export function Versions(): JSX.Element | null;
```

Each row shows: version ("v003"), date, plan (`p-…`, short), duration, size, and a "Current" badge when it is the latest used plan. Buttons:

- **Restore…** Hidden on the current row. Disabled with "Made before versions were kept" when the diff is `"none"`.
- **Compare.**

```ts
/** Centre column: replaces PreviewPlayer while `compare` is set (Close returns to the player). */
export interface CompareProps {
  a: { render: VerifiedRender; src: string; label: string }; // label "v002"
  b: { render: VerifiedRender; src: string; label: string };
  mode: "wipe" | "side";               // local state, default "side"
  wipe: number;                        // 0–1, a range input (clip-path: inset on B; no loop)
  diff: DiffSummary | null;            // diffSummary(snapA, snapB) when both snapshots exist
  onMode: (m: "wipe" | "side") => void;
  onWipe: (x: number) => void;
  onClose: () => void;
}
export function CompareView(p: CompareProps): JSX.Element;
export function Compare(): JSX.Element | null;
```

- **Layout.** A is the leader. Both are `<video muted={side === "b"}>`, B muted by default with an "Audio A | B" toggle. One shared play/pause button and one seek bar drive A, and A's events call `syncFollower(A, B)`.
  - Side by side is a 2-column grid that stacks below `md`.
  - Wipe overlays B on A with `clip-path: inset(0 0 0 calc(var(--wipe) * 100%))`, driven by a range input.
  - Different durations: the seek bar uses A's duration, and B clamps at its end.
- **Diff.** The DiffSummary lines sit under the videos.

---

## D. Layout (DirectorSuiteSection)

| Where | What |
|---|---|
| StudioBar | `BatonPill` left of `RenderBadge`; StudioBar runs `usePoll(refreshComfy, 10 s)` while a project is open; project Select gains "All projects…" |
| Left column | StagingBin gets `BinFilterBarView` under its header; ShotSlotCard "Generate…" link for `source: "generate"` |
| Centre column | `Compare` replaces `PreviewPlayer` while comparing; MiniTimeline gets the note-marker lane above the clip strip; after `OutputsCard`: `GeneratePanel`, then `RenderQueue` |
| Right column | `VerifiedShelf` gets the "Outputs / Versions" tabs (Versions inside the same card) |
| No project open | `ProjectsBoardView` replaces EmptyState's recent list (quick starts stay on top) |
| Mount effect | `startComfyEvents()` next to `startDirectorEvents()`; both unsubscribed on unmount |

## E. Tests

- **Vitest, pure helpers.** `comfy-ui.test.ts` covers `generateBlocker` (each reason), `draftToParams`, `paramsFromGeneration` (job vs GenMeta, img2img without input), `deriveQueueDisplay` (every status × policy × admission × running), `batonInfo`, `aspectOf`, `upsertJob`.
- **Vitest, other helpers.** `versions.test.ts` covers `renderVersion`, `versionRows`, `diffSummary` (same cut, add/remove/reorder/trim, looks, outputs) and `syncFollower`. Also covered: `noteMarkers`, `markerLeftPx`, `filterAssets`, `binTags`, `filterProjects`.
- **Vitest, view rendering.** `ui-p3.test.ts` uses `renderToStaticMarkup` for every new `XxxView`. Same mocks as `ui-v2.test.ts` (`@/stores/nav`, `@/features/reminders/notify`, `./bizops`), fixtures from `fixtures.test-util.ts`, plus `comfyStatus()` / `comfyJob()` fixtures. It checks:
  - Enqueue is disabled with its visible reason
  - the waiting-model row shows "needs model …"
  - the queued row under the manual policy says "Waiting for Run now"
  - Restore is hidden on the current version
- **Playwright.** New `tests/ui/director-suite-p3.spec.ts` on the `fakeDesktop` pattern. It mocks `comfy_status`, `comfy_queue_get`, `comfy_enqueue`, `comfy_cancel`, `comfy_run_now`, `comfy_settings_set`, `gpu_slot_view`, `media_render_snapshot` and `media_manifest_restore`; everything else still throws. It checks:
  - the template picker shows "needs model …" for a missing upscaler and Enqueue's reason
  - enqueue adds a "Waiting for idle" row; Cancel moves it to Cancelled; the policy select calls `comfy_settings_set`
  - the baton pill text
  - a note marker click seeks the preview
  - board status chip → `media_project_update`
  - Versions → Restore… → confirm → `media_manifest_restore` called once
  - Compare opens two videos

  Run it with `npx playwright test tests/ui/director-suite` (the director specs only). `director-suite-v2.spec.ts` must pass unchanged, which proves the comfy poll fails quietly when unmocked.
- **Rust.** `cargo test --lib media::` for C.1.
- **No live runs.** No COMFY_LIVE and no E2E_LIVE.

## F. Files

- **New:** `comfy-store.ts`, `comfy-ui.ts`, `versions.ts`, `GeneratePanel.tsx`, `RenderQueue.tsx`, `BatonPill.tsx`, `ProjectsBoard.tsx`, `Versions.tsx`, `Compare.tsx`, their tests, and `tests/ui/director-suite-p3.spec.ts`.
- **Edited:**
  - `contract.ts`, `api.ts`
  - `director-store.ts`: `setProjectStatus`, `restoreVersion`, `loadSnapshot`, `compare`, `DirectorUndo.what`
  - `review-ui.ts`: `noteMarkers`
  - `MiniTimeline.tsx`, `StagingBin.tsx`, `AssetDetails.tsx`, `ShotSlotCard.tsx`, `StudioBar.tsx`, `EmptyState.tsx`, `VerifiedShelf.tsx`, `DirectorSuiteSection.tsx`
  - `media.rs` (C.1), `lib.rs` (2 registration lines), and optionally `comfy.rs` `comfy_status` (A.1 template fields)

## G. Open questions for Nic

1. Policy is global for every project. Is that OK, or should the Queue card hide the select and leave it to Settings?
2. Should Re-roll on a style-transfer whose job has been pruned from the queue (200 kept) be disabled, or ask for the source still again?
3. Is "Restore" only from Versions enough, or should it also be offered on a Verified Outputs row?
