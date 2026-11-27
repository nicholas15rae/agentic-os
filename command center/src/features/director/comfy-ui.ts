/**
 * Director Suite Part 3 (A): pure helpers for the ComfyUI panels. No store, no IPC; unit-tested
 * in comfy-ui.test.ts. The views and comfy-store.ts call these.
 */
import type { SlotView } from "@/lib/platform";
import {
  COMFY_ASPECTS,
  COMFY_PROMPT_MAX,
  COMFY_STYLE_DENOISE,
  COMFY_TEMPLATE_META,
  COMFY_TURBO_MAX_STEPS,
  COMFY_UPSCALE_MAX_INPUT_SIDE,
  type ComfyAspect,
  type ComfyJob,
  type ComfyParams,
  type ComfyPolicy,
  type ComfyStatus,
  type ComfyTemplateInfo,
  type ComfyTemplateName,
  type GenMeta,
  type MediaAsset,
} from "./contract";
import type { RenderJob } from "./director-store";
import type { PillTone } from "./StudioBar";

// ── Draft ────────────────────────────────────────────────────────────────────

export interface GenerateDraft {
  template: ComfyTemplateName;
  prompt: string;
  negative: string;
  seed: number | null; // null = random at enqueue
  aspect: ComfyAspect | null; // null = the project's aspect
  steps: number; // 1–4
  denoise: number; // used by style-transfer only
  inputAssetId: string | null; // style-transfer / upscale (resolved to the asset's path at enqueue)
  /** Set by Tweak: which asset this draft came from (shown as "Tweaking <name>"). */
  fromAssetId: string | null;
}

export const defaultDraft = (): GenerateDraft => ({ template: "scene-still", prompt: "", negative: "", seed: null, aspect: null, steps: 1, denoise: 0.5, inputAssetId: null, fromAssetId: null });

const SIZE_MAX = 1024;

export const isTemplateName = (n: string): n is ComfyTemplateName => Object.prototype.hasOwnProperty.call(COMFY_TEMPLATE_META, n);
const metaOf = (n: string) => (isTemplateName(n) ? COMFY_TEMPLATE_META[n] : undefined);
export const templateLabel = (n: string): string => metaOf(n)?.label ?? n;

export type MergedTemplate = ComfyTemplateInfo & { label: string; implemented: boolean; needsInput: boolean };

/** comfy_status.templates merged with COMFY_TEMPLATE_META, one row per known template (META order).
 * A template Rust didn't list is not ready. `implemented` = META's AND Rust's (when Rust sends it). */
export function mergeTemplates(status: Pick<ComfyStatus, "templates"> | null): MergedTemplate[] {
  return (Object.keys(COMFY_TEMPLATE_META) as ComfyTemplateName[]).map((name) => {
    const meta = COMFY_TEMPLATE_META[name];
    const info = status?.templates.find((t) => t.name === name);
    const implemented = meta.implemented && info?.implemented !== false;
    return {
      name,
      requiredModels: info?.requiredModels ?? [],
      missing: info?.missing ?? [],
      ready: info?.ready ?? false,
      note: info?.note ?? (info ? null : status ? "ComfyUI doesn't list this template." : null),
      label: info?.label || meta.label,
      kind: info?.kind ?? meta.kind,
      implemented,
      unavailableReason: info?.unavailableReason ?? meta.unavailableReason ?? null,
      needsInput: meta.needsInput,
    };
  });
}

const longSide = (a: Pick<MediaAsset, "width" | "height">) => Math.max(a.width ?? 0, a.height ?? 0);

/** Why Enqueue is disabled, or null when it can go (order as in the Part 3 contract §A.4). */
export function generateBlocker(d: GenerateDraft, info: ComfyTemplateInfo | undefined, status: ComfyStatus | null, input: MediaAsset | null, hasProject: boolean): string | null {
  if (!hasProject) return "Open a project first";
  if (!status) return "ComfyUI status unavailable";
  const meta = metaOf(d.template);
  const implemented = (meta?.implemented ?? false) && info?.implemented !== false;
  if (!implemented) return info?.unavailableReason || meta?.unavailableReason || "This template isn't available.";
  if (!info) return "ComfyUI doesn't list this template.";
  if (!info.ready) return info.note || "A model for this template is missing.";
  if (d.template !== "upscale") {
    if (!d.prompt.trim()) return "Write a prompt";
    if (d.prompt.length > COMFY_PROMPT_MAX) return `Prompt is too long (${COMFY_PROMPT_MAX} max)`;
  }
  if (meta?.needsInput) {
    if (!input) return "Pick a still from the bin";
    if (d.template === "upscale" && longSide(input) > COMFY_UPSCALE_MAX_INPUT_SIDE) return `That still is too big to upscale (${COMFY_UPSCALE_MAX_INPUT_SIDE} px max)`;
  }
  if (!Number.isInteger(d.steps) || d.steps < 1 || d.steps > COMFY_TURBO_MAX_STEPS) return `Steps must be 1 to ${COMFY_TURBO_MAX_STEPS}`;
  if (d.template === "style-transfer" && !(d.denoise >= COMFY_STYLE_DENOISE[0] && d.denoise <= COMFY_STYLE_DENOISE[1])) return `Denoise must be ${COMFY_STYLE_DENOISE[0]} to ${COMFY_STYLE_DENOISE[1]}`;
  if (d.seed != null && !(Number.isSafeInteger(d.seed) && d.seed >= 0)) return "Seed must be a whole number, 0 or more";
  return null;
}

/** Draft → params: drops seed / aspect when null, aspect for the input templates (they keep the
 * source size), denoise unless style-transfer, an empty negative; inputImage = the asset's path. */
export function draftToParams(d: GenerateDraft, input: MediaAsset | null): ComfyParams {
  const needsInput = metaOf(d.template)?.needsInput ?? false;
  const p: ComfyParams = { prompt: d.prompt.trim() };
  if (d.negative.trim()) p.negative = d.negative.trim();
  if (d.seed != null) p.seed = d.seed;
  p.steps = d.steps;
  if (d.aspect && !needsInput) p.aspect = d.aspect;
  if (needsInput && input) p.inputImage = input.path;
  if (d.template === "style-transfer") p.denoise = d.denoise;
  return p;
}

/** Image assets of this project usable as an input (for upscale, long side ≤ 2048). [] for templates without an input. */
export function inputCandidates(assets: MediaAsset[], template: ComfyTemplateName): MediaAsset[] {
  if (!COMFY_TEMPLATE_META[template]?.needsInput) return [];
  return assets.filter((a) => a.kind === "image" && (template !== "upscale" || longSide(a) <= COMFY_UPSCALE_MAX_INPUT_SIDE));
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asAspect = (v: unknown): ComfyAspect | undefined => (typeof v === "string" && (COMFY_ASPECTS as readonly string[]).includes(v) ? (v as ComfyAspect) : undefined);

export const REROLL_NO_SOURCE = "The source still for this one isn't known any more";

/** Re-roll / Tweak source: the job's stored params when `job` is given (exact, incl. seed and inputImage),
 * else from GenMeta (prompt, negative, seed, steps, width, height, denoise; no input). Err when the
 * template needs an input and none is known. */
export function paramsFromGeneration(gen: GenMeta, job: ComfyJob | undefined): { template: string; params: ComfyParams } | { error: string } {
  const template = job?.template || gen.template;
  const meta = metaOf(template);
  let params: ComfyParams;
  if (job) {
    const j = job.params;
    params = { prompt: str(j.prompt) ?? "" };
    const neg = str(j.negative);
    if (neg) params.negative = neg;
    const seed = num(j.seed);
    if (seed != null) params.seed = seed;
    const steps = num(j.steps);
    if (steps != null) params.steps = steps;
    const w = num(j.width);
    const h = num(j.height);
    if (w) params.width = w;
    if (h) params.height = h;
    const aspect = asAspect(j.aspect);
    if (aspect) params.aspect = aspect;
    const input = str(j.inputImage) ?? str(j.input_image);
    if (input) params.inputImage = input;
    const denoise = num(j.denoise);
    if (denoise != null && template === "style-transfer") params.denoise = denoise;
  } else {
    params = { prompt: gen.prompt ?? "" };
    if (gen.negative) params.negative = gen.negative;
    if (Number.isSafeInteger(gen.seed) && gen.seed >= 0) params.seed = gen.seed;
    if (gen.steps >= 1) params.steps = Math.min(COMFY_TURBO_MAX_STEPS, Math.round(gen.steps));
    if (gen.width > 0 && gen.height > 0 && gen.width <= SIZE_MAX && gen.height <= SIZE_MAX) {
      params.width = gen.width;
      params.height = gen.height;
    }
    if (template === "style-transfer") params.denoise = gen.denoise;
  }
  if (meta?.needsInput && !params.inputImage) return { error: REROLL_NO_SOURCE };
  return { template, params };
}

/** Why Re-roll can't go for this generation (null = it can). */
export function rerollBlocker(gen: GenMeta | null | undefined, job: ComfyJob | undefined): string | null {
  if (!gen) return "Not a generated asset";
  const r = paramsFromGeneration(gen, job);
  if ("error" in r) return r.error;
  if (!isTemplateName(r.template) || !COMFY_TEMPLATE_META[r.template].implemented) return `Unknown template “${r.template}”`;
  return null;
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** Tweak: a Generate draft from an asset's generation (and its job when still in the queue). */
export function draftFromGeneration(gen: GenMeta, job: ComfyJob | undefined, assets: MediaAsset[], assetId: string): GenerateDraft {
  const r = paramsFromGeneration(gen, job);
  const template: ComfyTemplateName = isTemplateName(job?.template || gen.template) ? ((job?.template || gen.template) as ComfyTemplateName) : "scene-still";
  // Without a known input (img2img, job pruned) the draft still carries the prompt and settings.
  const p: ComfyParams = "error" in r ? { prompt: gen.prompt ?? "", negative: gen.negative, seed: gen.seed, steps: gen.steps, denoise: gen.denoise } : r.params;
  const needsInput = COMFY_TEMPLATE_META[template].needsInput;
  const input = p.inputImage ? assets.find((a) => samePath(a.path, p.inputImage!)) : undefined;
  const steps = Math.min(COMFY_TURBO_MAX_STEPS, Math.max(1, Math.round(p.steps ?? 1)));
  const denoise = p.denoise != null && p.denoise >= COMFY_STYLE_DENOISE[0] && p.denoise <= COMFY_STYLE_DENOISE[1] ? p.denoise : 0.5;
  return {
    template,
    prompt: (p.prompt ?? "").slice(0, COMFY_PROMPT_MAX),
    negative: p.negative ?? "",
    seed: p.seed != null && Number.isSafeInteger(p.seed) && p.seed >= 0 ? p.seed : null,
    aspect: needsInput ? null : (p.aspect ?? aspectOf(p.width ?? gen.width, p.height ?? gen.height)),
    steps,
    denoise: template === "style-transfer" ? denoise : 0.5,
    inputAssetId: needsInput ? (input?.id ?? null) : null,
    fromAssetId: assetId,
  };
}

/** Nearest COMFY_ASPECTS entry to w×h (log-ratio distance); null when either side is 0. */
export function aspectOf(width: number, height: number): ComfyAspect | null {
  if (!(width > 0 && height > 0)) return null;
  const r = Math.log(width / height);
  let best: ComfyAspect = COMFY_ASPECTS[0];
  let bestD = Infinity;
  for (const a of COMFY_ASPECTS) {
    const [w, h] = a.split(":").map(Number);
    const d = Math.abs(Math.log(w / h) - r);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/** A random seed, an integer in 0 … 2^53-1 (crypto.getRandomValues; Math.random only without it). */
export const randomSeed = (): number => {
  const u = new Uint32Array(2);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(u);
  else {
    u[0] = Math.floor(Math.random() * 2 ** 32);
    u[1] = Math.floor(Math.random() * 2 ** 32);
  }
  return (u[0] & 0x1fffff) * 2 ** 32 + u[1];
};

/** Upsert one job by id (replace in place, or add at the front). */
export function upsertJob(jobs: ComfyJob[], job: ComfyJob): ComfyJob[] {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i < 0) return [job, ...jobs];
  const next = jobs.slice();
  next[i] = job;
  return next;
}

// ── Queue display ────────────────────────────────────────────────────────────

export type QueueDisplay = "queued" | "waiting_idle" | "waiting_model" | "running" | "done" | "failed" | "cancelled";
export interface QueueDisplayInfo { state: QueueDisplay; label: string; detail: string | null; tone: "teal" | "amber" | "violet" | "alert" | "muted" }

export const POLICY_WAIT: Record<ComfyPolicy, string> = { idle: "Waiting for idle", overnight: "Waiting for 01:00–06:00", manual: "Waiting for Run now" };
export const POLICY_LABEL: Record<ComfyPolicy, string> = { idle: "When idle", overnight: "Overnight (01:00–06:00)", manual: "Only on Run now" };
/** The line under Enqueue. */
export const POLICY_NOTE: Record<ComfyPolicy, string> = {
  idle: "Runs when the PC is idle. Tony is unloaded for the batch, then put back.",
  overnight: "Runs between 01:00 and 06:00. Tony is unloaded for the batch, then put back.",
  manual: "Runs on Run now in the queue. Tony is unloaded for the batch, then put back.",
};

/** status + policy + admission + phase → what a queue row says (pure; the Part 3 contract §A.4 table). */
export type QueueComfy = Pick<ComfyStatus, "running" | "phase" | "admission" | "settings"> & Partial<Pick<ComfyStatus, "runNow">>;

export function deriveQueueDisplay(job: Pick<ComfyJob, "status" | "error">, comfy: QueueComfy | null): QueueDisplayInfo {
  switch (job.status) {
    case "done":
      return { state: "done", label: "Done", detail: null, tone: "teal" };
    case "failed":
      return { state: "failed", label: "Failed", detail: job.error || null, tone: "alert" };
    case "cancelled":
      return { state: "cancelled", label: "Cancelled", detail: null, tone: "muted" };
    case "waiting":
      return { state: "waiting_model", label: "Waiting for a model", detail: job.error || null, tone: "amber" };
    case "running":
      return { state: "running", label: "Running", detail: comfy?.phase || null, tone: "violet" };
    case "queued":
    default:
      if (comfy?.running) return { state: "queued", label: "In line", detail: comfy.phase || null, tone: "amber" };
      if (!comfy || comfy.admission === "running") return { state: "queued", label: "Queued", detail: null, tone: "amber" };
      // Run now was pressed but the batch can't start yet: say so, with the reason, not the policy wait.
      if (comfy.runNow) return { state: "waiting_idle", label: "Run now pending", detail: comfy.admission || null, tone: "amber" };
      return { state: "waiting_idle", label: POLICY_WAIT[comfy.settings.policy] ?? "Waiting", detail: comfy.admission || null, tone: "amber" };
  }
}

/** The CPU export job (media-render) in the same vocabulary. */
export function exportDisplay(job: RenderJob): QueueDisplayInfo {
  switch (job.status) {
    case "queued":
      return { state: "queued", label: "Queued", detail: job.stage || null, tone: "amber" };
    case "running":
      return { state: "running", label: "Running", detail: [`${Math.round(job.pct)}%`, job.stage || null, job.etaSec != null ? `~${Math.ceil(job.etaSec)}s` : null].filter(Boolean).join(" · "), tone: "violet" };
    case "done":
      return { state: "done", label: "Done", detail: null, tone: "teal" };
    case "failed":
      return { state: "failed", label: "Failed", detail: job.error || null, tone: "alert" };
    case "cancelled":
    default:
      return { state: "cancelled", label: "Cancelled", detail: null, tone: "muted" };
  }
}

export type QueueRow =
  | { kind: "export"; id: string; title: string; display: QueueDisplayInfo; pct: number | null; canCancel: boolean }
  | { kind: "comfy"; id: string; title: string /* template label + prompt (40 chars) */; display: QueueDisplayInfo; createdAt: number; finishedAt: number | null; canCancel: boolean /* queued | waiting | running */; outputAssetIds: string[] };

const LIVE_COMFY = new Set<ComfyJob["status"]>(["queued", "waiting", "running"]);
const PROMPT_CHARS = 40;

export function comfyRowTitle(job: Pick<ComfyJob, "template" | "params">): string {
  const prompt = (str(job.params.prompt) ?? "").trim().replace(/\s+/g, " ");
  const short = prompt.length > PROMPT_CHARS ? `${prompt.slice(0, PROMPT_CHARS - 1)}…` : prompt;
  return short ? `${templateLabel(job.template)} · ${short}` : templateLabel(job.template);
}

/** The queue card's rows: this slug's media-render job first, then this slug's ComfyUI jobs newest first. */
export function queueRows(slug: string | null, render: RenderJob | null, jobs: ComfyJob[], comfy: QueueComfy | null): QueueRow[] {
  if (!slug) return [];
  const rows: QueueRow[] = [];
  if (render && render.slug === slug) {
    const live = render.status === "queued" || render.status === "running";
    rows.push({ kind: "export", id: render.jobId, title: "Export (CPU render)", display: exportDisplay(render), pct: live ? render.pct : null, canCancel: live });
  }
  const mine = jobs.filter((j) => j.slug === slug).sort((a, b) => b.createdAt - a.createdAt);
  for (const j of mine)
    rows.push({
      kind: "comfy",
      id: j.id,
      title: comfyRowTitle(j),
      display: deriveQueueDisplay(j, comfy),
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      canCancel: LIVE_COMFY.has(j.status),
      outputAssetIds: j.outputs.map((o) => o.assetId).filter((x): x is string => !!x),
    });
  return rows;
}

export const QUEUE_FINISHED_CAP = 8;
const FINISHED = new Set<QueueDisplay>(["done", "failed", "cancelled"]);
/** Every live row, then at most `cap` finished ones (order kept); `hidden` = finished rows left out. */
export function capFinished(rows: QueueRow[], cap = QUEUE_FINISHED_CAP): { rows: QueueRow[]; hidden: number } {
  let seen = 0;
  const out = rows.filter((r) => !FINISHED.has(r.display.state) || ++seen <= cap);
  return { rows: out, hidden: rows.length - out.length };
}

/** Why Run now can't go (null = it can). */
export function runNowBlocker(status: ComfyStatus | null): string | null {
  if (!status) return "ComfyUI status unavailable";
  if (status.running) return "A batch is running";
  if (!status.counts.queued) return "Nothing queued";
  return null;
}

// ── Baton ────────────────────────────────────────────────────────────────────

export interface BatonInfo { who: "tony" | "comfy" | "other" | "free"; label: string; detail: string | null; tone: PillTone }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Who holds the GPU right now (pure; the Part 3 contract §A.4). */
export function batonInfo(slot: SlotView | null, comfy: Pick<ComfyStatus, "running" | "phase" | "counts"> | null, render: RenderJob | null): BatonInfo {
  const active = slot?.active ?? [];
  const details: string[] = [];
  if (active.length) details.push(`Holding the GPU: ${active.join(", ")}`);
  if (slot && slot.queuedForeground + slot.queuedBackground > 0) details.push(`Queued: ${slot.queuedForeground} Tony, ${slot.queuedBackground} background`);
  if (comfy && (comfy.counts.queued || comfy.counts.waiting)) details.push(`ComfyUI: ${comfy.counts.queued ?? 0} queued, ${comfy.counts.waiting ?? 0} waiting for a model`);
  const detail = details.length ? details.join(" · ") : null;

  if (comfy?.running && comfy.phase) return { who: "comfy", label: `ComfyUI · ${comfy.phase}`, detail, tone: /^rendering/i.test(comfy.phase) ? "violet" : "amber" };
  if (active.some((l) => /comfyui/i.test(l))) return { who: "comfy", label: "ComfyUI · rendering", detail, tone: "violet" };
  if (active.some((l) => /(^|·\s*)tony\b/i.test(l))) return { who: "tony", label: "GPU · Tony", detail, tone: "amber" };
  if (active.length) return { who: "other", label: `GPU · ${active[0].split(" · ").pop()?.trim() || active[0]}`, detail, tone: "amber" };
  const cpu = !!render && (render.status === "queued" || render.status === "running");
  return { who: "free", label: `GPU free${cpu ? " · CPU render" : ""}`, detail: detail ?? (slot ? `${plural(slot.capacity, "slot")} free` : null), tone: slot || comfy ? "green" : "unknown" };
}
