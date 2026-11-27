/**
 * Director Suite Part 3 (A): ComfyUI state, its own zustand store so director-store.ts doesn't grow.
 * It imports director-store (refreshAssets / useDirector); nothing in director-store imports it.
 *
 * Every call here fails quietly: a bridge error lands in `statusError` or a toast, never in React.
 * GPU work starts only from an explicit click (Enqueue, Re-roll, Run now); nothing here enqueues
 * from a Director reply.
 */
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import { cmd, onNativeEvent, type SlotView } from "@/lib/platform";
import { api, onDirectorEvent } from "./api";
import type { ComfyJob, ComfyParams, ComfyPolicy, ComfyServiceEvent, ComfyStatus, DirectorEvents, MediaAsset } from "./contract";
import { refreshAssets, useDirector } from "./director-store";
import { defaultDraft, draftFromGeneration, draftToParams, generateBlocker, mergeTemplates, paramsFromGeneration, templateLabel, upsertJob, type GenerateDraft } from "./comfy-ui";

export { defaultDraft, upsertJob, type GenerateDraft } from "./comfy-ui";

export interface ComfyState {
  status: ComfyStatus | null;
  statusError: string | null; // last comfy_status error (bridge down / not mocked); panels hide or say "ComfyUI status unavailable"
  jobs: ComfyJob[]; // whole queue (all projects); views filter by slug
  slot: SlotView | null; // gpu_slot_view / gpu-slot
  draft: GenerateDraft; // the Generate panel's fields (Tweak writes here)
  generateOpen: boolean; // panel expanded (Tweak / "Generate…" opens it)
  busy: { enqueue: boolean; runNow: boolean; policy: boolean; cancel: string | null /* job id */ };
}

export const COMFY_STATUS_POLL_MS = 10_000;
export const COMFY_STATUS_DEBOUNCE_MS = 300;
/** The Generate panel's element id (Tweak scrolls it into view). */
export const GENERATE_PANEL_ID = "director-generate";

const initial = (): ComfyState => ({
  status: null,
  statusError: null,
  jobs: [],
  slot: null,
  draft: defaultDraft(),
  generateOpen: false,
  busy: { enqueue: false, runNow: false, policy: false, cancel: null },
});

export const useComfy = create<ComfyState>(() => initial());
const get = () => useComfy.getState();
const set = (p: Partial<ComfyState> | ((s: ComfyState) => Partial<ComfyState>)) => useComfy.setState(p);
const setBusy = (p: Partial<ComfyState["busy"]>) => set((s) => ({ busy: { ...s.busy, ...p } }));

const toast = (title: string, body?: string, tone: "info" | "warn" | "error" = "info") => useToasts.getState().push({ title, body, tone });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let statusTimer: ReturnType<typeof setTimeout> | undefined;
let assetTimer: ReturnType<typeof setTimeout> | undefined;
/** Jobs whose "done" already refreshed the bin (once per job). */
const refreshedDone = new Set<string>();
/** Bumped by every local job change (enqueue / cancel result, comfy-queue event). A queue snapshot
 * fetched before the counter moved is older than what the store holds, so it is dropped. */
let jobsSeq = 0;
const upsertLocal = (job: ComfyJob) => {
  jobsSeq++;
  set((s) => ({ jobs: upsertJob(s.jobs, job) }));
};

export function resetComfyStore(): void {
  clearTimeout(statusTimer);
  clearTimeout(assetTimer);
  statusTimer = assetTimer = undefined;
  refreshedDone.clear();
  jobsSeq = 0;
  useComfy.setState(initial(), true);
}

/** comfy_status only; an error lands in statusError. */
async function refreshStatus(): Promise<void> {
  try {
    const status = await api.comfyStatus();
    set({ status, statusError: null });
  } catch (e) {
    set({ statusError: errText(e) || "ComfyUI status unavailable" });
  }
}

/** comfy_status + comfy_queue_get; errors land in statusError, never throw. The queue snapshot is
 * applied as soon as it arrives (comfy_status can take ~1.5 s while ComfyUI is down), and only when
 * no local job change landed while it was in flight. */
export async function refreshComfy(): Promise<void> {
  const seq = jobsSeq;
  const queue = api
    .comfyQueue()
    .then((q) => {
      if (seq === jobsSeq && q && Array.isArray(q.jobs)) set({ jobs: q.jobs });
    })
    .catch(() => undefined);
  await Promise.allSettled([refreshStatus(), queue]);
}

function refreshStatusSoon() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => void refreshStatus(), COMFY_STATUS_DEBOUNCE_MS);
}
function refreshAssetsSoon(slug: string) {
  clearTimeout(assetTimer);
  assetTimer = setTimeout(() => void refreshAssets(slug), COMFY_STATUS_DEBOUNCE_MS);
}

export const setDraft = (patch: Partial<GenerateDraft>) => set((s) => ({ draft: { ...s.draft, ...patch } }));
export const openGenerate = (open: boolean) => set({ generateOpen: open });

/** A shot slot's "Generate…": a fresh scene-still draft with this prompt (nothing from an earlier
 * Tweak carries over: no source asset, seed or input), panel open and in view. Queues nothing. */
export function generateFromPrompt(prompt: string): void {
  set({ draft: { ...defaultDraft(), prompt }, generateOpen: true });
  revealGenerate();
}

/** Scroll the Generate panel into view (after Tweak / "Generate…"). No-op off the DOM. */
export function revealGenerate(): void {
  if (typeof document === "undefined") return;
  setTimeout(() => document.getElementById(GENERATE_PANEL_ID)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
}

/** Validates with generateBlocker(); enqueues for the open project; toast on refusal. Resolves the job or null. */
export async function enqueueDraft(): Promise<ComfyJob | null> {
  const { draft, status, statusError } = get();
  const dir = useDirector.getState();
  const input = draft.inputAssetId ? (dir.assets.find((a) => a.id === draft.inputAssetId) ?? null) : null;
  const usable = statusError ? null : status;
  const info = mergeTemplates(usable).find((t) => t.name === draft.template);
  const blocker = generateBlocker(draft, info, usable, input, !!dir.slug);
  if (blocker || !dir.slug) {
    toast("Can't queue that yet", blocker ?? "Open a project first", "warn");
    return null;
  }
  const job = await enqueue(dir.slug, draft.template, draftToParams(draft, input));
  if (job) toast(`Queued: ${templateLabel(job.template)}`, job.status === "waiting" ? (job.error ?? "Waiting for a model.") : undefined);
  return job;
}

/** One comfy_enqueue (only ever from an Enqueue / Re-roll click). */
export async function enqueue(slug: string, template: string, params: ComfyParams): Promise<ComfyJob | null> {
  if (get().busy.enqueue) return null; // a second click while the first is in flight queues nothing
  setBusy({ enqueue: true });
  try {
    const job = await api.comfyEnqueue({ slug, template, params });
    upsertLocal(job);
    refreshStatusSoon();
    return job;
  } catch (e) {
    toast("ComfyUI refused that", errText(e), "error");
    return null;
  } finally {
    setBusy({ enqueue: false });
  }
}

export async function cancelJob(id: string): Promise<boolean> {
  setBusy({ cancel: id });
  try {
    const job = await api.comfyCancel({ id });
    upsertLocal(job);
    refreshStatusSoon();
    return true;
  } catch (e) {
    toast("Couldn't cancel that job", errText(e), "error");
    return false;
  } finally {
    setBusy({ cancel: null });
  }
}

/** Run now (only from the queue's click). comfy_run_now always accepts (it sets the flag); `now` is
 * "starting", or the reason the batch still waits. Resolves true only when it is starting. */
export async function runNow(): Promise<boolean> {
  setBusy({ runNow: true });
  try {
    const r = await api.comfyRunNow();
    const starting = r.accepted && (!r.now || r.now === "starting");
    if (starting) toast("Starting the ComfyUI batch");
    else if (r.accepted) toast("Run now is set", `Waiting: ${r.now}`);
    else toast("Not yet", r.now, "warn");
    refreshStatusSoon();
    return starting;
  } catch (e) {
    toast("Couldn't start the batch", errText(e), "error");
    return false;
  } finally {
    setBusy({ runNow: false });
  }
}

export async function setPolicy(policy: ComfyPolicy): Promise<boolean> {
  setBusy({ policy: true });
  try {
    const settings = await api.comfySettingsSet({ patch: { policy } });
    set((s) => ({ status: s.status ? { ...s.status, settings } : s.status }));
    refreshStatusSoon();
    return true;
  } catch (e) {
    toast("Couldn't change when ComfyUI runs", errText(e), "error");
    return false;
  } finally {
    setBusy({ policy: false });
  }
}

const jobFor = (asset: MediaAsset): ComfyJob | undefined => (asset.generation ? get().jobs.find((j) => j.id === asset.generation!.comfyJobId) : undefined);

/** Re-roll: the same params with a new seed (seed omitted, Rust picks one). Needs the source job for img2img templates. */
export async function reroll(asset: MediaAsset): Promise<ComfyJob | null> {
  const gen = asset.generation;
  if (!gen) return null;
  const r = paramsFromGeneration(gen, jobFor(asset));
  if ("error" in r) {
    toast("Can't re-roll this one", r.error, "warn");
    return null;
  }
  const params: ComfyParams = { ...r.params };
  delete params.seed;
  const slug = asset.project || useDirector.getState().slug;
  if (!slug) return null;
  const job = await enqueue(slug, r.template, params);
  if (job) toast(`Queued: re-roll of ${asset.name}`);
  return job;
}

/** Tweak: prefill the draft from the asset's generation (and its job's params when still in the queue), open the panel. */
export function tweak(asset: MediaAsset): void {
  const gen = asset.generation;
  if (!gen) return;
  set({ draft: draftFromGeneration(gen, jobFor(asset), useDirector.getState().assets, asset.id), generateOpen: true });
  revealGenerate();
}

// ── Events ───────────────────────────────────────────────────────────────────

export function onQueueEvent(job: ComfyJob) {
  upsertLocal(job);
  const slug = useDirector.getState().slug;
  if (job.status === "done" && job.slug === slug && !refreshedDone.has(job.id)) {
    refreshedDone.add(job.id);
    refreshAssetsSoon(slug);
  }
}

export function onServiceEvent(e: ComfyServiceEvent) {
  refreshStatusSoon();
  if (e.phase !== "idle" || !e.batch) return;
  const { done, failed } = e.batch;
  const parts = [done > 0 ? `${done} still${done === 1 ? "" : "s"} ready` : null, failed > 0 ? `${failed} failed` : null].filter(Boolean);
  if (parts.length) toast(parts.join(" · "), e.batch.error ?? undefined, failed > 0 ? "warn" : "info");
}

export function onAssetEvent(p: DirectorEvents["comfy-asset"]) {
  if (p.slug === useDirector.getState().slug) refreshAssetsSoon(p.slug);
}

/**
 * Subscribe to comfy-queue / comfy-service / comfy-asset and gpu-slot (director-report is for the
 * Director, no UI). Also the first refreshComfy() and gpu_slot_view. Returns the unsubscribe.
 */
export async function startComfyEvents(): Promise<() => void> {
  const settled = await Promise.allSettled([
    onDirectorEvent("comfy-queue", onQueueEvent),
    onDirectorEvent("comfy-service", onServiceEvent),
    onDirectorEvent("comfy-asset", onAssetEvent),
    onNativeEvent<SlotView>("gpu-slot", (slot) => set({ slot })),
  ]);
  const offs = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  void refreshComfy();
  void cmd("gpu_slot_view")
    .then((slot) => set({ slot }))
    .catch(() => undefined);
  return () => {
    offs.forEach((off) => off());
    clearTimeout(statusTimer);
    clearTimeout(assetTimer);
  };
}
