/**
 * Director Suite state (zustand). The manifest is edited optimistically here and saved to Rust
 * debounced (400 ms) with the revision it was loaded at; a stale revision reloads the project.
 * Nothing in localStorage except the last-open project slug.
 */
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import type { CreativeBrief, Deliverable, DirectorAction, DirectorCommands, DirectorEvents, EditPlanBody, MediaAsset, MediaProject, Moment, Note, ProjectReview, ProjectStatus, RenderPlan, ShotSlot, TimelineManifest, VerifiedRender } from "./contract";
import { api, onDirectorEvent } from "./api";
import { revisePlanBody, stripActionBlocks } from "./actions";
import { briefIdeaFor, checkPlanFor, noopRevisionReason, notesResolved, planChangesNothing, planCheck, revisionSummary, withCheckedClips, type PlanCheckResult } from "./plan-check";
import {
  addSlot,
  applyEditPlan,
  attachSlot,
  moveSlot,
  newId,
  presetManifest,
  removeSlot,
  setShotList,
  toggleFilmed,
  updateSlot,
  upgradeAsset,
  upgradeManifest,
  upgradeProject,
  withNote,
  withNoteResolved,
  type QuickStart,
} from "./manifest";
import { versionLabel } from "./versions";
import { recordStyle } from "./style";
import { useChatDraft } from "./gaps";

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
  /** This reply changed the timeline / shot list: the undo point that puts it back (while current). */
  undoId?: string;
  /** media_plan_check warnings on this reply's plan (it still applied). */
  warnings?: string[];
  /** A page-sent corrective follow-up ("[auto-fix]"), not a line Nic typed. */
  autoFix?: boolean;
}

/** The tag every page-sent corrective line starts with. */
export const AUTO_FIX_TAG = "[auto-fix]";
/** The start of the short auto-fix line the chat shows and logs (director-chat autoFixLine). */
export const AUTO_FIX_SHOWN = `${AUTO_FIX_TAG} Asked the Director to fix:`;
/** Is a logged "nic" line really the page's auto-fix line? (The log only has nic / director roles.) */
export const isAutoFixLine = (role: ChatRole, text: string): boolean => role === "nic" && text.startsWith(AUTO_FIX_SHOWN);

export type Selection = { kind: "asset" | "clip" | "render"; id: string } | null;

export interface Upload {
  name: string;
  received: number;
  total: number;
}

/** A Director `match_footage` pairing waiting for Nic's accept / reject. */
export interface MatchSuggestion {
  id: string;
  assetId: string;
  slotId: string;
  reason: string;
}
/** A Director-suggested moment waiting for Nic's accept / reject. */
export interface MomentSuggestion {
  id: string;
  assetId: string;
  inSec: number;
  outSec: number;
  label: string;
  score: number;
}
/** The revise_edit waiting on its render: its notes resolve when Nic approves the render plan. */
export interface PendingRevision {
  round: 1 | 2;
  resolves: string[];
  summary: string;
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
  // ── v2 ──
  /** Review rounds + open decisions (media_review_get). */
  review: ProjectReview | null;
  /** The Director's latest report_open_decisions (stored via media_review_write; loaded from media_review_get). */
  openDecisions: string[];
  matchSuggestions: MatchSuggestion[];
  momentSuggestions: MomentSuggestion[];
  /** A Director draft_brief held back because Nic already approved a brief (accept to replace it). */
  briefDraft: CreativeBrief | null;
  revision: PendingRevision | null;
  deliverables: Deliverable[];
  /** Auto-send one match_footage turn when freshly transcribed clips leave film slots unfilled. */
  autoMatch: boolean;
  /** The preview's own media time (seconds into whatever it plays), for notes on a render. */
  previewTime: number;
  /** A seek request for the preview (applied once its source is loaded); `n` changes per request. */
  seek: { sec: number; n: number } | null;
  /** The edit before the Director's last timeline / shot-list change, so Nic can put it back. */
  undo: DirectorUndo | null;
  /** Nic's idea, word for word, for the brief the Director is drafting (BriefCard's "Draft a brief"). */
  briefIdea: string | null;
  /** Reply ids that already had their one automatic corrective turn (director-chat.ts). */
  autoFixed: string[];
  // ── Part 3 ──
  /** Two renders shown A/B in the centre column (render ids); null = the normal preview. */
  compare: { a: string; b: string } | null;
}

/** What a Director reply (or a version restore) replaced (clips, audio, shot list, looks, outputs), for one-click undo. */
export interface DirectorUndo {
  id: string;
  slug: string;
  before: Pick<TimelineManifest, "clips" | "audio" | "shotList" | "captions" | "color" | "outputs" | "output" | "clipAudioVolume">;
  /** What made the undo point (absent = a Director reply). */
  what?: "director" | "restore";
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
  review: null,
  openDecisions: [],
  matchSuggestions: [],
  momentSuggestions: [],
  briefDraft: null,
  revision: null,
  deliverables: [],
  autoMatch: true,
  previewTime: 0,
  seek: null,
  undo: null,
  briefIdea: null,
  autoFixed: [],
  compare: null,
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
  resetIntake();
  snapshotCache.clear();
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
  const same = get().slug === slug;
  if (!same) {
    resetIntake();
    useChatDraft.setState({ draft: null });
  }
  set({ slug, loading: true, error: null, plan: null, selection: null, previewMode: "working", playhead: 0, previewTime: 0, seek: null, chat: same ? get().chat : [], ...(same ? {} : PROJECT_V2_BLANK) });
  rememberSlug(slug);
  try {
    const [data, log, review, deliverables] = await Promise.all([api.projectGet({ slug }), api.chatLog({ slug }).catch(() => []), loadReview(slug), loadDeliverables(slug)]);
    if (get().slug !== slug) return;
    dirty = false;
    const rv = review ?? data.project.review ?? null;
    set({
      ...(deliverables ? { deliverables } : {}),
      review: rv,
      openDecisions: rv?.openDecisions ?? [],
      // v1 rows / manifests read as v2 (Rust upgrades too; this keeps an older backend safe).
      project: upgradeProject(data.project),
      assets: data.assets.map(upgradeAsset),
      manifest: upgradeManifest(data.manifest),
      renders: data.renders,
      loading: false,
      chat: log.map((m, i) => ({ id: `log-${i}`, role: m.role, text: m.role === "director" ? stripActionBlocks(m.text) || "(actions only)" : m.text, at: m.at, ...(isAutoFixLine(m.role, m.text) ? { autoFix: true } : {}) })),
    });
  } catch (e) {
    if (get().slug !== slug) return;
    set({ loading: false, error: errText(e) });
  }
}

export function closeProject() {
  void flushSave();
  rememberSlug(null);
  resetIntake();
  useChatDraft.setState({ draft: null });
  set({ slug: null, project: null, assets: [], manifest: null, renders: [], chat: [], plan: null, selection: null, error: null, ...PROJECT_V2_BLANK });
}

/** Per-project v2 state, cleared when another project opens. */
const PROJECT_V2_BLANK: Partial<DirectorState> = { review: null, openDecisions: [], matchSuggestions: [], momentSuggestions: [], briefDraft: null, revision: null, deliverables: [], undo: null, briefIdea: null, autoFixed: [], compare: null };

/** media_review_get, never throwing (an older backend or a missing project.json review is null). */
async function loadReview(slug: string): Promise<ProjectReview | null> {
  try {
    return (await api.reviewGet({ slug })) ?? null;
  } catch {
    return null;
  }
}

/** media_deliverables_get (the last Approve final's files), never throwing: null = unknown. */
async function loadDeliverables(slug: string): Promise<Deliverable[] | null> {
  try {
    const d = await api.deliverablesGet({ slug });
    return Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
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

/** Re-read the open project's assets and renders (e.g. after a Drive import finished). Leaves the
 * manifest, chat and selection alone. */
export async function refreshAssets(slug: string): Promise<void> {
  if (get().slug !== slug) return;
  try {
    const data = await api.projectGet({ slug });
    if (get().slug !== slug) return;
    set({ assets: data.assets.map(upgradeAsset), renders: data.renders });
  } catch {
    /* the next open reloads it */
  }
}

export function addAssets(assets: MediaAsset[]) {
  if (!assets.length) return;
  set((s) => ({ assets: [...s.assets.filter((a) => !assets.some((n) => n.id === a.id)), ...assets] }));
}

// ── Director actions ─────────────────────────────────────────────────────────

/** Replace clips/audio (+ captions/color/outputs when named) and save as the Director. False (and
 * nothing applied) if another project opened meanwhile. `snap` runs on the manifest it replaces. */
async function applyPlan(body: EditPlanBody, slug: string, snap: (m: TimelineManifest) => void): Promise<boolean> {
  if (get().slug !== slug || !get().manifest) return false;
  await flushSave();
  const cur = get().manifest;
  if (get().slug !== slug || !cur) return false;
  snap(cur);
  set({ manifest: applyEditPlan(cur, body) });
  dirty = true;
  return flushSave("director", true);
}

const undoFields = (m: TimelineManifest): DirectorUndo["before"] => ({ clips: m.clips, audio: m.audio, shotList: m.shotList, captions: m.captions, color: m.color, outputs: m.outputs, output: m.output, clipAudioVolume: m.clipAudioVolume });

/** Put back the edit from before the Director's last timeline / shot-list change (Nic's click). */
export async function undoDirectorEdit(): Promise<boolean> {
  const u = get().undo;
  const slug = get().slug;
  if (!u || !slug || u.slug !== slug || !get().manifest) return false;
  await flushSave();
  const cur = get().manifest;
  if (get().slug !== slug || !cur) return false;
  // The plan card and any waiting revision were for the Director's version.
  set({ manifest: { ...cur, ...u.before }, undo: null, plan: null, revision: null });
  dirty = true;
  const ok = await flushSave("nic", true);
  if (ok) {
    if (u.what === "restore") toast("Restore undone", "The timeline is back as it was before the restore.");
    else toast("Director's edit undone", "Your timeline and shot list are back as they were.");
    void refreshAssets(slug);
  }
  return ok;
}

// ── Part 3 C: versions ───────────────────────────────────────────────────────

/** Snapshots never change: cached per project + render id (null = made before versions were kept). */
const snapshotCache = new Map<string, TimelineManifest | null>();

/** The cut a render was made from (media_render_snapshot), cached. Throws when it can't be read. */
export async function loadSnapshot(renderId: string): Promise<TimelineManifest | null> {
  const slug = get().slug;
  if (!slug) return null;
  const key = `${slug}\n${renderId}`;
  if (snapshotCache.has(key)) return snapshotCache.get(key) ?? null;
  const s = await api.renderSnapshot({ slug, renderId });
  const m = s.manifest ? upgradeManifest(s.manifest) : null;
  snapshotCache.set(key, m);
  return m;
}

/** Only from the Versions confirm click. Saves pending edits first, then makes that render's cut the
 * working manifest (notes and the shot list stay); the edit before is the undo point. */
export async function restoreVersion(renderId: string): Promise<boolean> {
  const slug = get().slug;
  if (!slug || !get().manifest) return false;
  if (!(await flushSave())) return false;
  const before = get().manifest;
  if (get().slug !== slug || !before) return false;
  const render = get().renders.find((r) => r.id === renderId);
  const label = render ? versionLabel(render.path) : "";
  try {
    const restored = await api.manifestRestore({ slug, renderId, revision: before.revision });
    if (get().slug !== slug) return false;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    dirty = false;
    const id = newId("u");
    set({ manifest: upgradeManifest(restored), undo: { id, slug, before: undoFields(before), what: "restore" }, plan: null, revision: null });
    useToasts.getState().push({
      title: label && label !== "—" ? `Version ${label} restored` : "Version restored",
      body: "Notes and the shot list stayed.",
      tone: "info",
      actions: [{ label: "Undo", run: () => void (get().undo?.id === id ? undoDirectorEdit() : undefined) }],
    });
    return true;
  } catch (e) {
    if (isStaleError(e)) {
      toast("Timeline changed elsewhere", "Reloaded the latest saved version; nothing was restored.", "warn");
      await openProject(slug);
    } else toast("Couldn't restore this version", errText(e).replace(/^[A-Z_]+: /, ""), "error");
    return false;
  }
}

/** Compare replaces the preview, so the preview's selection becomes render A at 0: a note added while
 * comparing lands on A at A's time (Compare feeds A's time into previewTime). */
export const openCompare = (a: string, b: string) =>
  set(a && b && a !== b ? { compare: { a, b }, selection: { kind: "render", id: a }, previewMode: "final", previewTime: 0 } : { compare: null });
export const closeCompare = () => set({ compare: null });

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("ch") ? "es" : "s"}`;

/**
 * Why a `revise_edit` can't apply now (contract §5), or null. `round` is the review round being
 * answered: round 1's notes get ONE revision (its render becomes round 2); round 2 is the last,
 * so after it the Director only lists open decisions.
 */
export function reviseRefusal(round: 1 | 2, review: ProjectReview | null, pending: PendingRevision | null): string | null {
  const rounds = review?.rounds ?? [];
  const latest = rounds[rounds.length - 1];
  if (!latest) return "there's no verified render to revise yet (propose an edit plan instead)";
  if (latest.round >= 2 || round >= 2) return "round 2 is the last review round, so there's no round 3: list the open decisions instead";
  if (round !== latest.round) return `round ${latest.round} is the open round, not round ${round}`;
  if (latest.status !== "open" || pending?.round === round) return `round ${round} already has its one revision`;
  return null;
}

/** What one reply's actions did: notes for the bubble, plan-check warnings, and refusals the
 * Director can fix (they feed the one automatic corrective turn). */
export interface ApplyReport {
  notes: string[];
  warnings: string[];
  /** Plan-check refusals and no-op revisions, worded for the Director. */
  refusals: string[];
  /** The action types those refusals were for. */
  refusedTypes: DirectorAction["type"][];
}

export interface ApplyOptions {
  /** The line Nic typed for this turn (a drafted brief keeps its idea from it when there's no brief). */
  nicLine?: string;
}

/** Apply validated Director actions to the UI. Nothing renders, posts or deletes: at most the
 * plan card opens, and matches / held brief drafts wait for Nic's click. Returns the bubble notes. */
export async function applyDirectorActions(actions: DirectorAction[], forSlug?: string, opts: ApplyOptions = {}): Promise<string[]> {
  return (await applyDirectorActionsReport(actions, forSlug, opts)).notes;
}

/** Plan check for a Director plan body (snapped clips, with the check's answer), or null when it
 * was refused (pushed to `report`). The check gets the plan merged into the current manifest, so
 * it uses the plan's own outputs / captions / color / audio (and Nic's unsaved edits). */
async function checkedBody(body: EditPlanBody, type: "propose_edit_plan" | "revise_edit", slug: string, report: ApplyReport, resolves?: string[]): Promise<{ body: EditPlanBody; check: PlanCheckResult | null } | null> {
  const cur = get().manifest;
  const r = await planCheck(slug, body.clips, cur ? checkPlanFor(cur, body, resolves) : undefined);
  if (!r) return { body, check: null };
  for (const w of r.warnings) report.warnings.push(w);
  if (r.refusals.length) {
    report.notes.push(`${type === "revise_edit" ? "Revision" : "Edit plan"} not applied: ${r.refusals.join("; ")}`);
    for (const x of r.refusals) report.refusals.push(`${type} refused by the plan check: ${x}`);
    report.refusedTypes.push(type);
    return null;
  }
  return { body: withCheckedClips(body, r), check: r };
}

/** applyDirectorActions with the full report (director-chat.ts reads the refusals for its auto-fix turn). */
export async function applyDirectorActionsReport(actions: DirectorAction[], forSlug?: string, opts: ApplyOptions = {}): Promise<ApplyReport> {
  const report: ApplyReport = { notes: [], warnings: [], refusals: [], refusedTypes: [] };
  const notes = report.notes;
  // Every action is for the project the reply was about: stop as soon as another one opens.
  const slug = forSlug ?? get().slug;
  if (!slug) return report;
  const alive = () => get().slug === slug;
  // One undo point per reply: the manifest before its first timeline / shot-list change.
  let snapped = false;
  const snap = (m: TimelineManifest) => {
    if (snapped) return;
    snapped = true;
    set({ undo: { id: newId("u"), slug, before: undoFields(m) } });
  };
  const stopped = () => notes.push("Stopped: another project opened before the rest of this reply applied");
  for (const a of actions) {
    if (!alive()) {
      stopped();
      break;
    }
    switch (a.type) {
      case "draft_brief": {
        const p = get().project;
        if (!p) break;
        const prev = p.brief;
        // The idea stays in Nic's words: an existing brief's idea is never rewritten by a draft, and
        // a first brief takes Nic's own idea (the BriefCard textarea, else Nic's line, else the
        // handoff text) over the model's paraphrase.
        const nicIdea = briefIdeaFor(p, get().briefIdea, opts.nicLine);
        const brief: CreativeBrief = {
          ...a.brief,
          idea: nicIdea || a.brief.idea,
          guessed: nicIdea ? a.brief.guessed.filter((g) => g !== "idea") : a.brief.guessed,
          approved: false,
          updatedBy: "director",
          updatedAt: new Date().toISOString(),
        };
        if (prev?.approved) {
          set({ briefDraft: brief });
          notes.push("Brief draft held: your approved brief stays until you accept the draft");
          break;
        }
        if (await updateProject({ brief })) notes.push(`Brief drafted for your approval${brief.guessed.length ? ` (${plural(brief.guessed.length, "guessed field")})` : ""}`);
        break;
      }
      case "populate_shot_list": {
        const cur = get().manifest;
        if (cur) snap(cur);
        editManifest((m) => setShotList(m, a.slots));
        set((s) => ({ matchSuggestions: s.matchSuggestions.filter((x) => a.slots.some((sl) => sl.id === x.slotId)) }));
        notes.push(`Shot list: ${plural(a.slots.length, "slot")}`);
        break;
      }
      case "match_footage": {
        const m = get().manifest;
        const matches: MatchSuggestion[] = a.matches
          .filter((x) => m?.shotList.find((sl) => sl.id === x.slotId)?.assetId !== x.assetId)
          .map((x) => ({ id: newId("mt"), ...x }));
        const moments: MomentSuggestion[] = a.moments.map((x) => ({ id: newId("ms"), ...x }));
        set((s) => ({
          // A newer suggestion for a slot replaces the older one.
          matchSuggestions: [...s.matchSuggestions.filter((o) => !matches.some((n) => n.slotId === o.slotId)), ...matches],
          momentSuggestions: [...s.momentSuggestions.filter((o) => !moments.some((n) => n.assetId === o.assetId && n.inSec === o.inSec && n.outSec === o.outSec)), ...moments],
        }));
        const bits = [matches.length ? plural(matches.length, "match") : "", moments.length ? plural(moments.length, "moment") : ""].filter(Boolean);
        if (bits.length) notes.push(`Suggested ${bits.join(" and ")}: accept or reject each`);
        break;
      }
      case "propose_edit_plan": {
        const checked = await checkedBody(a, a.type, slug, report);
        if (!checked || !alive()) break;
        const body = checked.body;
        if (await applyPlan(body, slug, snap)) {
          notes.push(`Edit plan: ${plural(body.clips.length, "clip")}, ${plural(body.audio.length, "audio layer")}`);
          if (alive()) await requestPlan("director");
        }
        break;
      }
      case "revise_edit": {
        const refusal = reviseRefusal(a.round, get().review, get().revision);
        if (refusal) {
          notes.push(`Revision not applied: ${refusal}`);
          break;
        }
        const checked = await checkedBody(revisePlanBody(a), a.type, slug, report, a.resolves);
        if (!checked || !alive()) break;
        const body = checked.body;
        const cur = get().manifest;
        // A revision that changes nothing answers no note: refused, and the notes stay open. "Nothing"
        // is measured against the render the notes are on (Rust's plan snapshot), so a revision
        // that keeps Nic's own edits since that render still counts; without a snapshot, against
        // the current cut. Framing-only changes (fit, punchIn) count only for notes about framing
        // (plan-check.ts planChangesNothing; Rust's unchangedSinceRender applies the same rule).
        const unchanged = checked.check?.unchangedSinceRender ?? (cur ? planChangesNothing(cur, body, notesResolved(cur, a.resolves)) : false);
        if (cur && unchanged) {
          notes.push("Revision not applied: it changes nothing, so your notes stay open");
          report.refusals.push(noopRevisionReason(cur, body, a.resolves, checked.check?.unchangedSinceRender === true));
          report.refusedTypes.push(a.type);
          break;
        }
        // The stored summary never claims clip changes that didn't happen (app-written prefix).
        const summary = cur ? revisionSummary(cur, body, a.summary) : a.summary;
        if (await applyPlan(body, slug, snap)) {
          set({ revision: { round: a.round, resolves: a.resolves, summary } });
          // The "what changed" lands on the round it answers (text only).
          if (summary.trim() && alive()) await writeReview({ round: a.round, summary: summary.slice(0, 2000) });
          notes.push(`Round ${a.round} revision: ${plural(body.clips.length, "clip")}, answers ${plural(a.resolves.length, "note")} (resolved when you approve the render)`);
          if (alive()) await requestPlan("director");
        }
        break;
      }
      case "report_open_decisions": {
        set({ openDecisions: a.items });
        const rounds = get().review?.rounds ?? [];
        await writeReview({ round: rounds[rounds.length - 1]?.round ?? 1, openDecisions: a.items });
        notes.push(`Open decisions: ${a.items.length}`);
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
  return report;
}

/** Record Nic's idea for the brief the Director is about to draft (cleared once a brief exists). */
export const setBriefIdea = (idea: string | null) => set({ briefIdea: idea?.trim() ? idea.trim().slice(0, 8000) : null });

/** media_review_write for the open project (the Director's round summary / open decisions). The
 * stored review replaces the local one; a failure keeps the local copy and says so. */
async function writeReview(fields: Omit<DirectorCommands["media_review_write"]["args"], "slug">): Promise<boolean> {
  const slug = get().slug;
  if (!slug) return false;
  try {
    const review = await api.reviewWrite({ slug, ...fields });
    if (get().slug === slug && review) set({ review, openDecisions: review.openDecisions });
    return true;
  } catch (e) {
    toast("Couldn't save the Director's review notes", errText(e), "warn");
    return false;
  }
}

/** Nic chose not to render the waiting revision: its notes stay open. */
export const discardRevision = () => set({ revision: null });

// ── v2: project fields + brief ───────────────────────────────────────────────

type ProjectFields = Omit<DirectorCommands["media_project_update"]["args"], "slug">;

/** media_project_update for the open project; the result replaces the project (and its list row). */
export async function updateProject(fields: ProjectFields): Promise<boolean> {
  const slug = get().slug;
  if (!slug) return false;
  try {
    const p = upgradeProject(await api.projectUpdate({ slug, ...fields }));
    if (get().slug === slug) set((s) => ({ project: p, projects: s.projects.map((x) => (x.slug === slug ? p : x)), ...(p.brief ? { briefIdea: null } : {}) }));
    return true;
  } catch (e) {
    toast("Couldn't update the project", errText(e), "error");
    return false;
  }
}

/** Part 3 B.2: a project's status from the projects board (any project, open or not):
 * media_project_update({ slug, status }); the result replaces its row in `projects` (and `project`
 * when it is the open one). Toast on refusal. */
export async function setProjectStatus(slug: string, status: ProjectStatus): Promise<boolean> {
  try {
    const p = upgradeProject(await api.projectUpdate({ slug, status }));
    set((s) => ({ projects: s.projects.map((x) => (x.slug === slug ? p : x)), ...(s.slug === slug ? { project: p } : {}) }));
    return true;
  } catch (e) {
    toast("Couldn't change the project's status", errText(e), "error");
    return false;
  }
}

/** A starting brief for a project that has none: the handoff text (or title) as the idea, the rest guessed. */
export function defaultBrief(p: MediaProject, m: TimelineManifest | null): CreativeBrief {
  return {
    idea: (p.source.brief || p.title).slice(0, 8000),
    goal: "",
    platform: "custom",
    lengthSec: 30,
    aspect: m?.output.aspect ?? "16:9",
    tone: "",
    references: [],
    guessed: ["platform", "lengthSec", "aspect"],
    approved: false,
    updatedBy: "nic",
    updatedAt: new Date().toISOString(),
  };
}

export type BriefPatch = Partial<Pick<CreativeBrief, "idea" | "goal" | "platform" | "lengthSec" | "aspect" | "tone" | "references">>;

/** Nic edits the brief (creating one if there's none). Edited fields stop being "guessed"; approval is kept. */
export async function editBrief(patch: BriefPatch): Promise<boolean> {
  const { project, manifest } = get();
  if (!project) return false;
  const base = project.brief ?? defaultBrief(project, manifest);
  const keys = Object.keys(patch) as (keyof CreativeBrief)[];
  const brief: CreativeBrief = { ...base, ...patch, guessed: base.guessed.filter((g) => !keys.includes(g)), updatedBy: "nic", updatedAt: new Date().toISOString() };
  return updateProject({ brief });
}

/** Nic's approval click (Rust then moves a "brief" project to "shooting"). */
export async function approveBrief(): Promise<boolean> {
  const b = get().project?.brief;
  if (!b) return false;
  return updateProject({ brief: { ...b, approved: true, updatedBy: "nic", updatedAt: new Date().toISOString() } });
}

/** Replace the approved brief with the held Director draft (unapproved until Nic approves it). The
 * accept is Nic's save, so it never comes back as a Director report (director_reports.rs). */
export async function acceptBriefDraft(): Promise<boolean> {
  const d = get().briefDraft;
  if (!d) return false;
  const ok = await updateProject({ brief: { ...d, updatedBy: "nic", updatedAt: new Date().toISOString() } });
  if (ok) set({ briefDraft: null });
  return ok;
}
export const rejectBriefDraft = () => set({ briefDraft: null });

// ── v2: shot list edits (pure manifest ops, saved like any manifest edit) ─────

type SlotPatch = Partial<Omit<ShotSlot, "id" | "assetId" | "status">>;
export const addShot = (p: SlotPatch = {}, index?: number) => editManifest((m) => addSlot(m, p, index));
export const editShot = (slotId: string, patch: SlotPatch) => editManifest((m) => updateSlot(m, slotId, patch));
export const moveShot = (from: number, to: number) => editManifest((m) => moveSlot(m, from, to));
export const toggleShotFilmed = (slotId: string) => editManifest((m) => toggleFilmed(m, slotId));
export function removeShot(slotId: string) {
  editManifest((m) => removeSlot(m, slotId));
  set((s) => ({ matchSuggestions: s.matchSuggestions.filter((x) => x.slotId !== slotId), assets: s.assets.map((a) => (a.slotId === slotId ? { ...a, slotId: null } : a)) }));
}

// ── v2: footage matches + moments (suggestions until Nic accepts) ─────────────

const replaceAsset = (a: MediaAsset) => set((s) => ({ assets: s.assets.map((x) => (x.id === a.id ? a : x)) }));

/** Accept a match: attach the asset to the slot (manifest save), then mirror it on the asset. */
export async function acceptMatch(id: string): Promise<boolean> {
  const { slug, manifest, assets, matchSuggestions } = get();
  const sug = matchSuggestions.find((x) => x.id === id);
  if (!slug || !manifest || !sug) return false;
  const drop = () => set((s) => ({ matchSuggestions: s.matchSuggestions.filter((x) => x.id !== id) }));
  const asset = assets.find((a) => a.id === sug.assetId);
  const next = asset ? attachSlot(manifest, sug.slotId, asset) : manifest;
  if (!asset || next.shotList.find((s) => s.id === sug.slotId)?.assetId !== asset.id) {
    drop();
    toast("That match no longer fits", "The clip or the slot changed since the Director suggested it.", "warn");
    return false;
  }
  set({ manifest: next });
  dirty = true;
  if (!(await flushSave())) return false;
  set((s) => ({
    matchSuggestions: s.matchSuggestions.filter((x) => x.id !== id && x.slotId !== sug.slotId && x.assetId !== sug.assetId),
    assets: s.assets.map((a) => (a.id === asset.id ? { ...a, slotId: sug.slotId } : a.slotId === sug.slotId ? { ...a, slotId: null } : a)),
  }));
  try {
    replaceAsset(upgradeAsset(await api.assetUpdate({ slug, assetId: asset.id, slotId: sug.slotId })));
  } catch (e) {
    toast("Matched, but the clip's slot tag didn't save", errText(e), "warn");
  }
  return true;
}
export const rejectMatch = (id: string) => set((s) => ({ matchSuggestions: s.matchSuggestions.filter((x) => x.id !== id) }));

/** Accept a suggested moment: it joins the asset's moments (by: director). */
export async function acceptMoment(id: string): Promise<boolean> {
  const { slug, assets, momentSuggestions } = get();
  const sug = momentSuggestions.find((x) => x.id === id);
  if (!slug || !sug) return false;
  const asset = assets.find((a) => a.id === sug.assetId);
  set((s) => ({ momentSuggestions: s.momentSuggestions.filter((x) => x.id !== id) }));
  if (!asset) return false;
  const moment: Moment = { id: newId("m"), inSec: sug.inSec, outSec: sug.outSec, label: sug.label, score: sug.score, by: "director" };
  try {
    replaceAsset(upgradeAsset(await api.assetUpdate({ slug, assetId: asset.id, moments: [...asset.moments, moment] })));
    return true;
  } catch (e) {
    toast("Couldn't save the moment", errText(e), "error");
    return false;
  }
}
export const rejectMoment = (id: string) => set((s) => ({ momentSuggestions: s.momentSuggestions.filter((x) => x.id !== id) }));

export const MAX_TAGS = 12;
export const TAG_MAX_CHARS = 32;
/** Tags as Rust's clean_tags stores them: trimmed, lowercase, 1–32 chars, no duplicates, ≤ 12 (pure). */
export function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    // eslint-disable-next-line no-control-regex
    const tag = t.trim().toLowerCase().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, TAG_MAX_CHARS);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

/** Nic edits an asset's tags (media_asset_update); the stored asset replaces the local one. */
export async function setAssetTags(assetId: string, tags: string[]): Promise<boolean> {
  const slug = get().slug;
  if (!slug) return false;
  try {
    const a = upgradeAsset(await api.assetUpdate({ slug, assetId, tags: cleanTags(tags) }));
    if (get().slug === slug) replaceAsset(a);
    return true;
  } catch (e) {
    toast("Couldn't save the tags", errText(e), "error");
    return false;
  }
}

// ── v2: review notes + final approval ────────────────────────────────────────

/** Nic's review note (Rust owns notes: media_note_add; the result lands locally without a save). */
export async function addNote(text: string, opts: { renderId?: string | null; atSec?: number | null; viaVoice?: boolean } = {}): Promise<Note | null> {
  const slug = get().slug;
  const body = text.trim();
  if (!slug || !body) return null;
  try {
    const note = await api.noteAdd({ slug, note: { renderId: opts.renderId ?? null, atSec: opts.atSec ?? null, text: body.slice(0, 2000), by: "nic", viaVoice: opts.viaVoice === true } });
    if (get().slug !== slug) return note;
    set((s) => ({ manifest: s.manifest ? withNote(s.manifest, note) : s.manifest }));
    const review = await loadReview(slug);
    if (review && get().slug === slug) set({ review });
    return note;
  } catch (e) {
    toast("Couldn't save the note", errText(e), "error");
    return null;
  }
}

/** Resolve a note. `manual` = Nic's own Resolve click; without it (a revision's notes, on the
 * Approve & Render click) Rust refuses when the approved cut is the same one the note was on. */
export async function resolveNote(noteId: string, opts: { manual?: boolean } = {}): Promise<boolean> {
  const slug = get().slug;
  if (!slug) return false;
  try {
    await api.noteResolve(opts.manual ? { slug, noteId, manual: true } : { slug, noteId });
    if (get().slug === slug) set((s) => ({ manifest: s.manifest ? withNoteResolved(s.manifest, noteId) : s.manifest }));
    // Part 6 style memory: a resolve is a sign-off on this cut (Rust keeps one entry per cut revision).
    void recordStyle(slug, "notes");
    return true;
  } catch (e) {
    const why = errText(e);
    if (!opts.manual && /only changes framing/i.test(why)) toast("Note left open", "The approved cut only changes framing (fit or punch-in), and this note isn't about framing.", "warn");
    else if (!opts.manual && /UNCHANGED|changes nothing|same cut/i.test(why)) toast("Note left open", "The approved cut is the same as the one this note is on.", "warn");
    else toast("Couldn't resolve the note", errText(e), "error");
    return false;
  }
}

/** Nic's "Approve final" click: copies the verified renders to renders/final/<platform>/ (Rust), status → done. */
export async function approveFinal(renderIds: string[]): Promise<Deliverable[] | null> {
  const slug = get().slug;
  if (!slug || !renderIds.length) return null;
  try {
    const deliverables = await api.approveFinal({ slug, renderIds, approved: true });
    void recordStyle(slug, "final");
    if (get().slug !== slug) return deliverables;
    set({ deliverables });
    const [data, review] = await Promise.all([api.projectGet({ slug }).catch(() => null), loadReview(slug)]);
    if (get().slug === slug) {
      if (data) {
        const p = upgradeProject(data.project);
        set((s) => ({ project: p, projects: s.projects.map((x) => (x.slug === slug ? p : x)) }));
      }
      if (review) set({ review });
    }
    toast("Final approved", `${plural(deliverables.length, "file")} in renders/final`);
    return deliverables;
  } catch (e) {
    toast("Couldn't approve the final", errText(e), "error");
    return null;
  }
}

// ── v2: intake events → refresh + one debounced match_footage turn ───────────

export const INTAKE_REFRESH_MS = 300;
export const AUTO_MATCH_DEBOUNCE_MS = 5000;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let autoTimer: ReturnType<typeof setTimeout> | undefined;
/** Assets transcribed since the last auto turn, and every asset an auto turn already asked about. */
const transcribed = new Set<string>();
const asked = new Set<string>();

function resetIntake() {
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  clearTimeout(autoTimer);
  autoTimer = undefined;
  transcribed.clear();
  asked.clear();
}

export const setAutoMatch = (autoMatch: boolean) => set({ autoMatch });

export function onIntakeEvent(e: DirectorEvents["media-intake"]) {
  if (e.slug !== get().slug) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshAssets(e.slug);
  }, INTAKE_REFRESH_MS);
  if (e.stage === "failed") toast("A clip didn't finish processing", e.detail || undefined, "warn");
  if (e.stage === "transcribed") {
    transcribed.add(e.assetId);
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => void autoMatchTurn(e.slug), AUTO_MATCH_DEBOUNCE_MS);
  }
}

/** The line an auto match turn sends (pure). */
export function autoMatchPrompt(assets: Pick<MediaAsset, "id" | "name">[], slots: Pick<ShotSlot, "id" | "label">[]): string {
  const a = assets.map((x) => `${x.id} (${x.name})`).join(", ");
  const s = slots.map((x) => `${x.id} ${x.label}`).join(", ");
  return `[auto] New footage finished transcribing: ${a}. Unfilled film slots: ${s}. Suggest matches and the best moments with one match_footage block. Only suggest; Nic accepts each one.`;
}

async function autoMatchTurn(slug: string): Promise<void> {
  autoTimer = undefined;
  if (get().slug !== slug || !get().autoMatch) {
    transcribed.clear();
    return;
  }
  if (get().chatBusy) {
    // One turn at a time: try again once the current reply lands.
    autoTimer = setTimeout(() => void autoMatchTurn(slug), AUTO_MATCH_DEBOUNCE_MS);
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  await refreshAssets(slug);
  const { manifest, assets } = get();
  const ids = [...transcribed];
  transcribed.clear();
  if (get().slug !== slug || !manifest) return;
  const fresh = ids.map((id) => assets.find((a) => a.id === id)).filter((a): a is MediaAsset => !!a && a.kind !== "audio" && !a.slotId && !asked.has(a.id));
  // Only the unfilled film slots these clips could fill (same kind).
  const unfilled = manifest.shotList.filter((s) => s.source === "film" && !s.assetId && fresh.some((a) => a.kind === s.kind));
  if (!unfilled.length || !fresh.length) return;
  const { sendDirectorTurn } = await import("./director-chat");
  // Re-check after the awaits: a turn Nic started meanwhile (or a project switch) must not drop
  // these clips. Only a sent turn marks them as asked.
  if (get().slug !== slug) return;
  if (get().chatBusy) {
    for (const a of fresh) transcribed.add(a.id);
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => void autoMatchTurn(slug), AUTO_MATCH_DEBOUNCE_MS);
    return;
  }
  for (const a of fresh) asked.add(a.id);
  // The page sent this turn, not Nic: only match_footage (suggestions) may apply from its reply.
  const sent = await sendDirectorTurn(autoMatchPrompt(fresh, unfilled), { only: AUTO_TURN_ACTIONS });
  if (!sent)
    for (const a of fresh) {
      asked.delete(a.id);
      transcribed.add(a.id); // offered again with the next auto turn
    }
}

/** The only action an automatic (page-sent) turn may apply: suggestions Nic accepts one by one. */
export const AUTO_TURN_ACTIONS: DirectorAction["type"][] = ["match_footage"];

/** Subscribe the store to every Director Suite event (render, ingest, intake). Returns the unsubscribe. */
export async function startDirectorEvents(): Promise<() => void> {
  const offs = await Promise.all([onDirectorEvent("media-render", onRenderEvent), onDirectorEvent("media-ingest", onIngestEvent), onDirectorEvent("media-intake", onIntakeEvent)]);
  return () => offs.forEach((off) => off());
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
    // A waiting revision's notes resolve with Nic's render approval, not with the model's reply.
    const rev = get().revision;
    if (rev) {
      set({ revision: null });
      for (const id of rev.resolves) await resolveNote(id);
    }
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
    // Rust opened (or joined) a review round and moved the project to review: re-read both.
    void refreshAfterRender(e.slug);
  } else if (e.status === "failed") toast("Render failed", e.error ?? e.stage, "error");
}

/** After a verified render: the stored review rounds and the project row (status), if still open. */
export async function refreshAfterRender(slug: string): Promise<void> {
  const [review, data] = await Promise.all([loadReview(slug), Promise.resolve().then(() => api.projectGet({ slug })).catch(() => null)]);
  if (get().slug !== slug) return;
  if (review) set({ review, openDecisions: review.openDecisions ?? [] });
  if (data?.project) {
    const p = upgradeProject(data.project);
    set((s) => ({ project: p, projects: s.projects.map((x) => (x.slug === slug ? p : x)) }));
  }
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

/** Also closes Compare: a selection is shown in the preview, which Compare replaces. */
export function select(sel: Selection) {
  set({ selection: sel, previewMode: sel?.kind === "render" ? "final" : "working", compare: null });
}
export const setPreviewMode = (previewMode: DirectorState["previewMode"]) => set({ previewMode });
export const setPlayhead = (playhead: number) => set({ playhead: Math.max(0, playhead) });
export const setPreviewTime = (previewTime: number) => set({ previewTime: Number.isFinite(previewTime) ? Math.max(0, previewTime) : 0 });
/** Show `sel` in the preview and seek it to `sec` (seconds into that source). */
export function seekTo(sel: Selection, sec: number) {
  if (sel) select(sel);
  set((s) => ({ compare: null, seek: { sec: Math.max(0, Number.isFinite(sec) ? sec : 0), n: (s.seek?.n ?? 0) + 1 } }));
}
export const setReadiness = (readiness: Readiness | null, readinessError: string | null) => set({ readiness, readinessError });

/** Rendering needs media-forge green (enabled, healthy, listing tools) and ffmpeg. */
export const canRender = (r: Readiness | null) => !!r && r.mediaForge.enabled && r.mediaForge.healthy && r.mediaForge.tools > 0 && r.ffmpegFound;
