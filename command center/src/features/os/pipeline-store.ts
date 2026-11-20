import { create } from "zustand";
import { cmd, isTauri, onNativeEvent, type AgentEvent, type PipelineStepEvent, type TaskEnvelope, type TaskStatus } from "@/lib/platform";
import { gateway } from "@/lib/gateway";
import { useVoice, THREADS, type ThreadId } from "@/features/voice/voice-store";
import { useToasts } from "@/features/reminders/notify";
import { feedbackLevel, narrates } from "@/features/voice/narrator";
import { osName, useOs } from "./os-store";

/**
 * Builds in flight (Part 6): the Rust worker's TaskEnvelopes, as the webview sees them.
 * - Desktop: hydrated from `task_list` at startup (so a restart keeps the bars), then kept live
 *   by `agent-event` (the event bus; every task event is a committed handoff_log row).
 * - Phone: polls the gateway's mirror, `GET /api/tasks?active=1`.
 * Chat turns are gated by `feedback.sensitivity`: failures and "ready for review" always land
 * in the tab that asked; milestone / handoff / verbose relays in the agent's own tab at 1 / 2 / 3.
 * Spoken narration is the narrator's job (voice/narrator.ts), not this store's.
 */
export interface PipelineRun {
  /** The task id. */
  id: string;
  ideaId: string | null;
  title: string;
  stage: string;
  pct: number;
  /** The latest short summary (templated or the agent's voice summary). */
  label: string;
  cardId?: string;
  at: number;
  status: TaskStatus;
  owner: string;
  iteration: number;
  maxIterations: number;
  slug: string | null;
  error?: string | null;
}

interface PipelineStore {
  /** Open tasks (queued / prompting / designing / coding), by task id. */
  runs: Record<string, PipelineRun>;
  /** Recently finished tasks (review_ready / failed), newest last, capped. */
  recent: Record<string, PipelineRun>;
  /** New prototypes not yet opened in the Play Place (nav badge). */
  unseen: number;
  clearUnseen: () => void;
}

export const RECENT_CAP = 20;
const TERMINAL: readonly TaskStatus[] = ["review_ready", "failed"];

export const usePipelines = create<PipelineStore>((set) => ({
  runs: {},
  recent: {},
  unseen: 0,
  clearUnseen: () => set({ unseen: 0 }),
}));

/** Rough progress per worker stage (the bar; the worker itself has no percentage). */
const STAGE_PCT: Record<string, number> = { triage: 6, preflight: 14, spec: 24, design: 40, merge: 54, code: 68, evaluate: 80, audit: 86, verify: 92, done: 100 };

export function pctFor(status: TaskStatus, stage: string | null | undefined): number {
  if (status === "review_ready") return 100;
  if (status === "queued") return 2;
  return STAGE_PCT[stage ?? ""] ?? 4;
}

/** The fields an envelope and a gateway mirror snapshot share. */
export type TaskLike = Pick<TaskEnvelope, "task_id" | "title" | "status" | "stage" | "current_owner" | "iteration_count" | "max_iterations" | "project_slug" | "updated_at" | "error"> &
  Partial<Pick<TaskEnvelope, "idea_id" | "card_id" | "handoff_log" | "voice_summaries">>;

/** A run row from an envelope / mirror snapshot. Pure. */
export function runFromTask(t: TaskLike): PipelineRun {
  const last = t.handoff_log?.[t.handoff_log.length - 1];
  return {
    id: t.task_id,
    ideaId: t.idea_id ?? null,
    title: t.title || "Prototype",
    stage: t.stage ?? t.status,
    pct: pctFor(t.status, t.stage),
    label: last ? (last.voice_summary ?? last.short_summary) : t.status.replace("_", " "),
    cardId: t.card_id ?? undefined,
    at: t.updated_at || Date.now(),
    status: t.status,
    owner: t.current_owner,
    iteration: t.iteration_count,
    maxIterations: t.max_iterations,
    slug: t.project_slug,
    error: t.error,
  };
}

/** Split a task list into open runs and recent finished ones. Pure. */
export function hydrateRuns(tasks: readonly TaskLike[]): Pick<PipelineStore, "runs" | "recent"> {
  const runs: Record<string, PipelineRun> = {};
  const done: PipelineRun[] = [];
  for (const t of tasks) {
    if (!t?.task_id || typeof t.status !== "string") continue;
    const r = runFromTask(t);
    if (TERMINAL.includes(r.status)) done.push(r);
    else runs[r.id] = r;
  }
  done.sort((a, b) => a.at - b.at);
  return { runs, recent: Object.fromEntries(done.slice(-RECENT_CAP).map((r) => [r.id, r])) };
}

/** Fold one task event into the store's rows. Pure. */
export function applyEvent(s: Pick<PipelineStore, "runs" | "recent">, ev: AgentEvent): Pick<PipelineStore, "runs" | "recent"> {
  if (!ev?.taskId) return s;
  const prev = s.runs[ev.taskId] ?? s.recent[ev.taskId];
  const status: TaskStatus = ev.status ?? prev?.status ?? "queued";
  const stage = ev.stage ?? prev?.stage ?? status;
  const row: PipelineRun = {
    id: ev.taskId,
    ideaId: prev?.ideaId ?? null,
    title: prev?.title ?? "",
    stage,
    pct: pctFor(status, stage),
    label: ev.shortSummary,
    cardId: prev?.cardId,
    at: ev.at || Date.now(),
    status,
    owner: ev.owner ?? prev?.owner ?? ev.agentId,
    iteration: ev.iteration ?? prev?.iteration ?? 0,
    maxIterations: prev?.maxIterations ?? 3,
    slug: prev?.slug ?? null,
    error: prev?.error,
  };
  const runs = { ...s.runs };
  const recent = { ...s.recent };
  if (TERMINAL.includes(status)) {
    delete runs[ev.taskId];
    recent[ev.taskId] = row;
    const ids = Object.values(recent).sort((a, b) => a.at - b.at).map((r) => r.id);
    for (const id of ids.slice(0, Math.max(0, ids.length - RECENT_CAP))) delete recent[id];
  } else {
    delete recent[ev.taskId]; // retried
    runs[ev.taskId] = row;
  }
  return { runs, recent };
}

/** The chat turn an event earns at feedback `level`, or null. Failures and review_ready always
 * show (the chat is visual; level 0 only silences speech); the rest follow the narration gate. Pure. */
export function chatKind(ev: AgentEvent, level: number): "failed" | "ready" | "alert" | "relay" | null {
  if (!ev?.taskId) return null;
  if (ev.eventType === "failed" || ev.status === "failed") return "failed";
  if (ev.eventType === "review_ready") return "ready";
  if (ev.severity === "critical") return "alert";
  return narrates(ev.severity, level) ? "relay" : null;
}

const SPECIALIST_TABS: readonly ThreadId[] = ["prompter", "designer", "coder", "librarian"];
/** Which tab an agent's relay line goes to (Tony's tab stays a clean Nic↔Tony transcript). */
export function relayThread(agentId: string): ThreadId {
  return (SPECIALIST_TABS as readonly string[]).includes(agentId) ? (agentId as ThreadId) : "prompter";
}

/** Remember which tab started a task, so "it's ready" / "it failed" lands there. */
const origin = new Map<string, ThreadId>();
const ORIGIN_CAP = 200;

/** Called right after `task_create` / `idea_pipeline_run` with the tab that asked. */
export function trackTask(taskId: string, title: string, thread: ThreadId, ideaId: string | null = null) {
  if (!taskId) return;
  origin.set(taskId, THREADS.includes(thread) ? thread : "general");
  if (origin.size > ORIGIN_CAP) origin.delete(origin.keys().next().value as string);
  usePipelines.setState((s) => {
    const prev = s.runs[taskId];
    const row: PipelineRun = prev ? { ...prev, title: prev.title || title, ideaId: prev.ideaId ?? ideaId } : { id: taskId, ideaId, title, stage: "queued", pct: 2, label: "Queued for the Prompter", at: Date.now(), status: "queued", owner: "prompter", iteration: 0, maxIterations: 3, slug: null };
    return { runs: { ...s.runs, [taskId]: row } };
  });
}

/** The tab a task's outcome goes to: where it was asked, else the thread stored in its raw intent. */
function threadOf(taskId: string): ThreadId {
  return origin.get(taskId) ?? "general";
}

const level = () => feedbackLevel(useOs.getState().cfg);

/** Desktop: re-read one task (title, slug, card) before its outcome is announced. Best-effort. */
async function refreshTask(taskId: string) {
  if (!isTauri()) return;
  try {
    const t = await cmd("task_get", { task_id: taskId });
    const fresh = runFromTask(t);
    const patch = { title: fresh.title, slug: fresh.slug, cardId: fresh.cardId, ideaId: fresh.ideaId, error: fresh.error, maxIterations: fresh.maxIterations };
    usePipelines.setState((s) => (s.runs[taskId] ? { runs: { ...s.runs, [taskId]: { ...s.runs[taskId], ...patch } } } : s.recent[taskId] ? { recent: { ...s.recent, [taskId]: { ...s.recent[taskId], ...patch } } } : s));
  } catch {
    /* the event's own fields are enough */
  }
}

export async function onAgentEvent(ev: AgentEvent): Promise<void> {
  if (!ev || typeof ev !== "object") return;
  if (!ev.taskId) {
    // Bus-only notes: a critical one (a Librarian discrepancy, …) is worth a toast.
    if (ev.severity === "critical") useToasts.getState().push({ title: `${osName()} · ${ev.agentId}`, body: ev.shortSummary, tone: "error" });
    return;
  }
  usePipelines.setState((s) => applyEvent(s, ev));
  const kind = chatKind(ev, level());
  if (!kind) return;
  if (kind === "failed" || kind === "ready") await refreshTask(ev.taskId);
  const row = usePipelines.getState().runs[ev.taskId] ?? usePipelines.getState().recent[ev.taskId];
  const title = row?.title || "the build";
  const back = threadOf(ev.taskId);
  const push = useVoice.getState().pushTurn;
  if (kind === "failed") {
    push({
      who: "agent",
      from: "os",
      thread: back,
      text: `The build for “${title}” failed${ev.stage ? ` at the ${ev.stage} step` : ""}: ${ev.shortSummary}. Retry it, or hand that step to a CLI agent?`,
      actions: [
        { label: "Retry step", run: `retry:${ev.taskId}` },
        { label: "Offload to Claude CLI", run: `offload:claude-cli:${ev.taskId}` },
        { label: "Offload to Gemini CLI", run: `offload:gemini-cli:${ev.taskId}` },
      ],
    });
    useToasts.getState().push({ title: `${osName()} · build failed`, body: `${title}: ${ev.shortSummary}`, tone: "error" });
    return;
  }
  if (kind === "ready") {
    const where = row?.slug ? ` It's in staging/${row.slug}.` : "";
    const text = `“${title}” is ready for review.${where}`;
    push({ who: "agent", from: "os", thread: back, text, cardId: row?.cardId });
    useToasts.getState().push({ title: `${osName()} · ready for review`, body: text, tone: "info" });
    usePipelines.setState((s) => ({ unseen: s.unseen + 1 }));
    return;
  }
  if (kind === "alert") {
    push({ who: "system", thread: back, text: `${title}: ${ev.shortSummary}`, tone: "warn" });
    return;
  }
  const iter = ev.iteration ? ` · iteration ${ev.iteration}${row?.maxIterations ? `/${row.maxIterations}` : ""}` : "";
  push({ who: "relay", from: ev.agentId, to: ev.owner ?? ev.agentId, text: ev.shortSummary, meta: `${ev.stage ?? ev.eventType}${iter}`, thread: relayThread(ev.agentId) });
}

/** An approved ledger "Run" (only ever from approve()): the idea → a queued task. Returns at once. */
export async function runPipeline(ideaId: string, title: string, thread: ThreadId) {
  if (!isTauri()) {
    // Phone: the desktop claims it from the queue (one task per idea, deduped there).
    await gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind: "pipeline", payload: { ideaId } }) });
    useVoice.getState().pushTurn({ who: "system", text: `Sent “${title}” to the desktop: the Prompter picks it up there.`, tone: "ok", thread });
    return;
  }
  try {
    const r = await cmd("idea_pipeline_run", { ideaId });
    trackTask(r.taskId, title, thread, ideaId);
    useVoice.getState().pushTurn({ who: "system", text: r.created ? `Queued “${title}” for the Prompter.` : `“${title}” is already in progress.`, tone: "ok", thread });
  } catch (e) {
    useVoice.getState().pushTurn({ who: "system", text: `Couldn't start “${title}”: ${e instanceof Error ? e.message : String(e)}`, tone: "error", thread });
  }
}

/**
 * The chat turn a `pipeline-step` earns. A worker stage (`source: "worker"`) earns none: its
 * committed row already reaches the chat through `agent-event` (sensitivity-gated), so showing
 * both doubled every stage. Play Place iterate / approve (the Coder's implementation, a revise
 * result) and verifier notes run inline and report ONLY here, so they always show: the chat is
 * visual, and feedback.sensitivity gates speech, not these results. Pure.
 */
export function stepTurn(e: PipelineStepEvent | null | undefined): "verify" | "relay" | null {
  if (!e || typeof e.text !== "string" || e.source === "worker") return null;
  return e.kind === "verify" ? "verify" : "relay";
}

function onStep(e: PipelineStepEvent) {
  const kind = stepTurn(e);
  if (!kind) return;
  const thread = (THREADS.includes(e.thread as ThreadId) ? e.thread : "auto") as ThreadId;
  if (kind === "verify") useVoice.getState().pushTurn({ who: "system", text: e.text, tone: e.ok ? "ok" : "warn", thread });
  else useVoice.getState().pushTurn({ who: "relay", from: e.from, to: e.to, text: e.text, tone: e.ok ? undefined : "warn", meta: `${e.stage}${e.ms ? ` · ${(e.ms / 1000).toFixed(1)}s` : ""}`, thread, cardId: e.cardId ?? undefined });
}

/** Desktop: the store's rows from `task_list` (startup, and after a webview reload). */
export async function hydrateFromStore() {
  const list = await cmd("task_list", { limit: 50 });
  for (const t of list) {
    const th = (t.raw_intent?.memory_reference as { thread?: unknown } | null)?.thread;
    if (typeof th === "string" && THREADS.includes(th as ThreadId) && !origin.has(t.task_id)) origin.set(t.task_id, th as ThreadId);
  }
  // Events that arrived while this loaded are newer than the list: keep them.
  usePipelines.setState((s) => mergeRuns(hydrateRuns(list), s));
}

/** `base` with every row of `live` that is newer (by `at`) on top. Pure. */
export function mergeRuns(base: Pick<PipelineStore, "runs" | "recent">, live: Pick<PipelineStore, "runs" | "recent">): Pick<PipelineStore, "runs" | "recent"> {
  const runs = { ...base.runs };
  const recent = { ...base.recent };
  for (const r of [...Object.values(live.runs), ...Object.values(live.recent)]) {
    const old = runs[r.id] ?? recent[r.id];
    if (old && old.at >= r.at) continue;
    delete runs[r.id];
    delete recent[r.id];
    (TERMINAL.includes(r.status) ? recent : runs)[r.id] = old ? { ...r, title: r.title || old.title, ideaId: r.ideaId ?? old.ideaId, slug: r.slug ?? old.slug } : r;
  }
  return { runs, recent };
}

/** Phone: the gateway's mirror of the desktop's envelopes. */
export async function pollMirror() {
  const r = await gateway<{ items: TaskLike[] }>("/api/tasks?active=1");
  usePipelines.setState((s) => ({ runs: hydrateRuns(r.items ?? []).runs, recent: s.recent }));
}

/** Where a review-ready build's files are, relative to the repo (D2: `<workdir>/staging/<slug>`). */
export const stagingPath = (slug: string | null | undefined) => (slug ? `staging/${slug}/` : null);

/** The build for a ledger idea: by its task id, else an open run that came from it. Pure. */
export function runForIdea(i: { taskId?: string } & { id: string }, runs: Record<string, PipelineRun>, recent: Record<string, PipelineRun> = {}): PipelineRun | undefined {
  if (i.taskId && (runs[i.taskId] || recent[i.taskId])) return runs[i.taskId] ?? recent[i.taskId];
  return Object.values(runs).find((r) => r.ideaId === i.id);
}

/** Which button a ledger idea gets: Run (never built), Retry (a failed build, or one stuck in
 * "prototyping" with no build running), or none while a build is live. Pure. */
export function ideaAction(status: string, live: boolean, hasTask: boolean): "run" | "rebuild" | "retry" | null {
  if (live) return null;
  if (status === "failed" || status === "prototyping") return hasTask && status === "failed" ? "retry" : "run";
  if (status === "captured" || status === "parked") return "run";
  if (status === "staged") return "rebuild";
  return null;
}

let started = false;
/** Desktop: hydrate + listen to Rust. Phone: poll the gateway's task mirror. */
export function startPipelineFeed() {
  if (started) return;
  started = true;
  if (isTauri()) {
    void hydrateFromStore().catch(() => undefined);
    void onNativeEvent<AgentEvent>("agent-event", onAgentEvent);
    void onNativeEvent<PipelineStepEvent>("pipeline-step", onStep);
    return;
  }
  void pollMirror().catch(() => undefined);
  setInterval(() => void pollMirror().catch(() => undefined), 5000);
}
