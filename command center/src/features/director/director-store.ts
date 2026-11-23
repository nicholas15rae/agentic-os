/**
 * Director Suite state (zustand). The manifest is edited optimistically here and saved to Rust
 * debounced (400 ms) with the revision it was loaded at; a stale revision reloads the project.
 * Nothing in localStorage except the last-open project slug.
 */
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import type { DirectorAction, DirectorCommands, DirectorEvents, MediaAsset, MediaProject, RenderPlan, TimelineManifest, VerifiedRender } from "./contract";
import { api } from "./api";
import { stripActionBlocks } from "./actions";
import { applyEditPlan, presetManifest, setShotList, type QuickStart } from "./manifest";

export type Readiness = DirectorCommands["media_readiness"]["result"];
export type RenderJob = DirectorEvents["media-render"];
export type ChatRole = "nic" | "director";

export interface ChatMsg {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
  streaming?: boolean;
  /** Action blocks the Director sent that failed validation (shown under the bubble). */
  errors?: string[];
  /** Short notes of what its valid actions changed. */
  applied?: string[];
}

export type Selection = { kind: "asset" | "clip" | "render"; id: string } | null;

export interface Upload {
  name: string;
  received: number;
  total: number;
}

export interface DirectorState {
  projects: MediaProject[];
  projectsLoaded: boolean;
  slug: string | null;
  project: MediaProject | null;
  assets: MediaAsset[];
  manifest: TimelineManifest | null;
  renders: VerifiedRender[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  chat: ChatMsg[];
  chatBusy: boolean;
  plan: RenderPlan | null;
  planBusy: boolean;
  job: RenderJob | null;
  readiness: Readiness | null;
  readinessError: string | null;
  uploads: Record<string, Upload>;
  selection: Selection;
  previewMode: "working" | "final";
  /** Timeline playhead, seconds (where a new voiceover lands). */
  playhead: number;
  /** "Modify Plan" focus request: a component focuses itself when `n` changes. */
  focus: { target: "timeline" | "chat"; n: number } | null;
}

const LAST_KEY = "cc.director.lastSlug";
export function lastSlug(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function rememberSlug(slug: string | null) {
  try {
    if (slug) localStorage.setItem(LAST_KEY, slug);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* private mode / tests */
  }
}

const toast = (title: string, body?: string, tone: "info" | "warn" | "error" = "info") => useToasts.getState().push({ title, body, tone });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Rust refuses a save made from an old revision (media.rs). Matched loosely on purpose. */
export const isStaleError = (e: unknown) => /stale|revision/i.test(errText(e));

const initial: DirectorState = {
  projects: [],
  projectsLoaded: false,
  slug: null,
  project: null,
  assets: [],
  manifest: null,
  renders: [],
  loading: false,
  error: null,
  saving: false,
  chat: [],
  chatBusy: false,
  plan: null,
  planBusy: false,
  job: null,
  readiness: null,
  readinessError: null,
  uploads: {},
  selection: null,
  previewMode: "working",
  playhead: 0,
  focus: null,
};

export const useDirector = create<DirectorState>(() => ({ ...initial }));
const get = () => useDirector.getState();
const set = (p: Partial<DirectorState> | ((s: DirectorState) => Partial<DirectorState>)) => useDirector.setState(p);

/** Test hook: back to the initial state with no timers pending. */
export function resetDirectorStore() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  dirty = false;
  inflight = null;
  useDirector.setState({ ...initial }, true);
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function loadProjects(): Promise<void> {
  try {
    const projects = await api.projects();
    set({ projects: [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), projectsLoaded: true });
  } catch (e) {
    set({ projectsLoaded: true, error: errText(e) });
  }
}

export async function openProject(slug: string): Promise<void> {
  if (get().slug && get().slug !== slug) await flushSave();
  set({ slug, loading: true, error: null, plan: null, selection: null, previewMode: "working", playhead: 0, chat: get().slug === slug ? get().chat : [] });
  rememberSlug(slug);
  try {
    const [data, log] = await Promise.all([api.projectGet({ slug }), api.chatLog({ slug }).catch(() => [])]);
    if (get().slug !== slug) return;
    dirty = false;
    set({
      project: data.project,
      assets: data.assets,
      manifest: data.manifest,
      renders: data.renders,
      loading: false,
      chat: log.map((m, i) => ({ id: `log-${i}`, role: m.role, text: m.role === "director" ? stripActionBlocks(m.text) || "(actions only)" : m.text, at: m.at })),
    });
  } catch (e) {
    if (get().slug !== slug) return;
    set({ loading: false, error: errText(e) });
  }
}

export function closeProject() {
  void flushSave();
  rememberSlug(null);
  set({ slug: null, project: null, assets: [], manifest: null, renders: [], chat: [], plan: null, selection: null, error: null });
}

/** Create a project (optionally from a quick start's preset) and open it. */
export async function createProject(title: string, quick?: QuickStart, source?: MediaProject["source"]): Promise<MediaProject> {
  const project = await api.projectCreate(source ? { title, source } : { title });
  await openProject(project.slug);
  if (quick && get().manifest) {
    const m = get().manifest;
    if (m) {
      set({ manifest: presetManifest(m, quick, title) });
      dirty = true;
      await flushSave();
    }
  }
  void loadProjects();
  return project;
}

// ── Manifest edits + debounced save ──────────────────────────────────────────

export const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let inflight: Promise<void> | null = null;

/** Apply a pure manifest op locally and schedule a save. */
export function editManifest(fn: (m: TimelineManifest) => TimelineManifest): void {
  const m = get().manifest;
  if (!m) return;
  const next = fn(m);
  if (next === m) return;
  set({ manifest: next });
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
}

/** Save now (pending edits, or unconditionally with `force`). Saves are serialized. */
export async function flushSave(by: TimelineManifest["updatedBy"] = "nic", force = false): Promise<boolean> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  while (inflight) await inflight;
  if (!dirty && !force) return true;
  const { slug, manifest } = get();
  if (!slug || !manifest) return false;
  dirty = false;
  const sent: TimelineManifest = { ...manifest, updatedBy: by, updatedAt: new Date().toISOString() };
  let ok = true;
  set({ saving: true });
  inflight = api
    .manifestSave({ slug, manifest: sent })
    .then((saved) => {
      if (get().slug !== slug) return;
      const cur = get().manifest;
      // Edits made while this save was in flight stay local (and dirty); they ride on the new revision.
      set({ manifest: cur === manifest || !cur ? saved : { ...cur, revision: saved.revision } });
    })
    .catch(async (e: unknown) => {
      ok = false;
      if (isStaleError(e)) {
        toast("Timeline changed elsewhere", "Reloaded the latest saved version; your last edit wasn't saved.", "warn");
        inflight = null;
        await openProject(slug);
      } else {
        dirty = true;
        toast("Couldn't save the timeline", errText(e), "error");
      }
    })
    .finally(() => {
      inflight = null;
      set({ saving: false });
    });
  await inflight;
  return ok;
}

export function addAssets(assets: MediaAsset[]) {
  if (!assets.length) return;
  set((s) => ({ assets: [...s.assets.filter((a) => !assets.some((n) => n.id === a.id)), ...assets] }));
}

// ── Director actions ─────────────────────────────────────────────────────────

/** Apply validated Director actions to the UI. Nothing renders: at most the plan card opens. */
export async function applyDirectorActions(actions: DirectorAction[]): Promise<string[]> {
  const notes: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case "populate_shot_list":
        editManifest((m) => setShotList(m, a.slots));
        notes.push(`Shot list: ${a.slots.length} slot${a.slots.length === 1 ? "" : "s"}`);
        break;
      case "propose_edit_plan": {
        const m = get().manifest;
        if (!m) break;
        await flushSave();
        const cur = get().manifest ?? m;
        set({ manifest: applyEditPlan(cur, a) });
        dirty = true;
        if (await flushSave("director", true)) {
          notes.push(`Edit plan: ${a.clips.length} clip${a.clips.length === 1 ? "" : "s"}, ${a.audio.length} audio layer${a.audio.length === 1 ? "" : "s"}`);
          await requestPlan("director");
        }
        break;
      }
      case "execute_verified_render":
        await requestPlan("director");
        notes.push("Render plan raised for your approval");
        break;
      default: {
        const never: never = a;
        void never;
      }
    }
  }
  return notes;
}

// ── Render plan / job ────────────────────────────────────────────────────────

export async function requestPlan(proposedBy: RenderPlan["proposedBy"]): Promise<RenderPlan | null> {
  const slug = get().slug;
  if (!slug) return null;
  set({ planBusy: true });
  try {
    await flushSave();
    const plan = await api.renderPlan({ slug, proposedBy });
    if (get().slug === slug) set({ plan });
    return plan;
  } catch (e) {
    toast("Couldn't build a render plan", errText(e), "error");
    return null;
  } finally {
    set({ planBusy: false });
  }
}

/** The Approve & Render click — the only path to `media_render_execute`. */
export async function approvePlan(): Promise<void> {
  const { slug, plan } = get();
  if (!slug || !plan) return;
  set({ planBusy: true });
  try {
    const { jobId } = await api.renderExecute({ slug, planId: plan.planId, approved: true });
    set({ plan: null, job: { slug, jobId, status: "queued", pct: 0, etaSec: null, stage: "queued" } });
  } catch (e) {
    toast("Render refused", errText(e), "error");
  } finally {
    set({ planBusy: false });
  }
}

export function modifyPlan(target: "timeline" | "chat" = "timeline") {
  set((s) => ({ plan: null, focus: { target, n: (s.focus?.n ?? 0) + 1 } }));
}

export function onRenderEvent(e: RenderJob) {
  const { slug } = get();
  if (e.slug !== slug) return;
  set({ job: e });
  if (e.status === "done" && e.render) {
    const r = e.render;
    set((s) => ({ renders: [r, ...s.renders.filter((x) => x.id !== r.id)] }));
    toast("Render verified", r.path.split(/[\\/]/).pop());
  } else if (e.status === "failed") toast("Render failed", e.error ?? e.stage, "error");
}

export function onIngestEvent(e: DirectorEvents["media-ingest"]) {
  if (e.slug !== get().slug) return;
  set((s) => {
    const uploads = { ...s.uploads };
    if (e.received >= e.total) delete uploads[e.uploadId];
    else uploads[e.uploadId] = { name: uploads[e.uploadId]?.name ?? "Copying…", received: e.received, total: e.total };
    return { uploads };
  });
}

export function setUpload(key: string, u: Upload | null) {
  set((s) => {
    const uploads = { ...s.uploads };
    if (u) uploads[key] = u;
    else delete uploads[key];
    return { uploads };
  });
}

// ── Selection / preview ──────────────────────────────────────────────────────

export function select(sel: Selection) {
  set({ selection: sel, previewMode: sel?.kind === "render" ? "final" : "working" });
}
export const setPreviewMode = (previewMode: DirectorState["previewMode"]) => set({ previewMode });
export const setPlayhead = (playhead: number) => set({ playhead: Math.max(0, playhead) });
export const setReadiness = (readiness: Readiness | null, readinessError: string | null) => set({ readiness, readinessError });

/** Rendering needs media-forge green (enabled, healthy, listing tools) and ffmpeg. */
export const canRender = (r: Readiness | null) => !!r && r.mediaForge.enabled && r.mediaForge.healthy && r.mediaForge.tools > 0 && r.ffmpegFound;
