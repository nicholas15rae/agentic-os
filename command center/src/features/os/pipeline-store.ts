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
 * show (the chat is visual; level 0 only silences speech). Relays: the agent-to-agent hand-offs
 * are the record Nic reviews, so the chat shows them from level 1 (speech still narrates them at
 * 2+ only); verbose rows (stage claims) stay at level 3. Pure. */
export function chatKind(ev: AgentEvent, level: number): "failed" | "ready" | "alert" | "relay" | null {
  if (!ev?.taskId) return null;
  if (ev.eventType === "failed" || ev.status === "failed") return "failed";
  if (ev.eventType === "review_ready") return "ready";
  if (ev.severity === "critical") return "alert";
  return narrates(ev.severity, ev.severity === "handoff" && level >= 1 ? Math.max(level, 2) : level) ? "relay" : null;
}

/** A cancel ("cancelled by user": a remove / repair in the hub, or the task's Cancel) is not a
 * build failure: no "failed", no Retry / Offload. Pure. */
export const isCancelled = (error: string | null | undefined, summary = ""): boolean => /cancelled by user/i.test(`${error ?? ""} ${summary}`);

/** The relay line: the app's templated facts first, the agent's own words after them. Pure. */
export function relayText(ev: Pick<AgentEvent, "shortSummary" | "templateSummary">): string {
  const t = ev.templateSummary?.trim();
  if (!t || t === ev.shortSummary.trim()) return ev.shortSummary;
  return `${t} — “${ev.shortSummary}”`;
}

/** The "ready" line: blockers named when the Prompter shipped with known blockers; a Play Place
 * hub build is only "output ready" — the hub's smoke test still decides. `total` is the true
 * blocker count (`last_eval.known_blockers_total`): past the cap the stored list ends in an
 * "… and N more" line, which is not a blocker itself. `works` is the worker's honest verdict
 * (`last_eval.works`, AD-13): `false` reads "needs fixes" (never "ready"), `true` with blockers
 * reads "ready, with N notes"; an older record without it keeps the neutral wording. Pure. */
export function readyText(o: { title: string; slug: string | null | undefined; blockers: readonly string[]; hub: boolean; summary?: string; total?: number; works?: boolean }): string {
  const where = o.slug ? ` It's in staging/${o.slug}.` : "";
  const hubNext = o.hub ? " (the Play Place smoke test runs next)" : "";
  if (!o.blockers.length) {
    if (o.works === false) return `“${o.title}” is staged but needs fixes${hubNext}.${where}`;
    const head = o.hub ? `“${o.title}”: the agents finished; the Play Place smoke test runs next.` : `“${o.title}” is ready for review.`;
    return `${head}${where}`;
  }
  const n = typeof o.total === "number" && o.total > 0 ? o.total : o.blockers.length;
  const list = o.blockers.slice(0, 5).map((b) => `• ${b}`).join("\n");
  const s = n === 1 ? "" : "s";
  const lead =
    o.works === false
      ? `“${o.title}” is staged but needs fixes: ${n} known blocker${s}`
      : o.works === true
        ? `“${o.title}” is ready for review, with ${n} note${s}`
        : `“${o.title}” is staged with ${n} known blocker${s}`;
  return `${lead}${hubNext}.${where}\n${list}`;
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

/** The thread stored in an envelope's raw intent (where it was asked), if it's a real thread. Pure. */
export function storedThread(t: Pick<TaskEnvelope, "raw_intent"> | null | undefined): ThreadId | null {
  const th = (t?.raw_intent?.memory_reference as { thread?: unknown } | null | undefined)?.thread;
  return typeof th === "string" && THREADS.includes(th as ThreadId) ? (th as ThreadId) : null;
}

/** The tab a task's outcome goes to: where it was asked (tracked, else the thread stored in its
 * raw intent — a phone / hub build created while the app ran), else Tony's main thread ("auto",
 * what VoiceHUD / the Command view show — never the hidden "general" fallback). */
function threadOf(taskId: string): ThreadId {
  return origin.get(taskId) ?? "auto";
}

const level = () => feedbackLevel(useOs.getState().cfg);

/** What an outcome turn needs beyond the event: where it came from and the Prompter's verdict. */
interface TaskExtras {
  source: string | null;
  blockers: string[];
  /** The true blocker count (the list may end in an "… and N more" line). */
  total?: number;
  /** The worker's honest verdict (`last_eval.works`); absent on older records. */
  works?: boolean;
}

/** Desktop: re-read one task (title, slug, card, origin thread, verdict) before its outcome is
 * announced. Best-effort. */
async function refreshTask(taskId: string): Promise<TaskExtras> {
  const none: TaskExtras = { source: null, blockers: [] };
  if (!isTauri()) return none;
  try {
    const t = await cmd("task_get", { task_id: taskId });
    const fresh = runFromTask(t);
    const patch = { title: fresh.title, slug: fresh.slug, cardId: fresh.cardId, ideaId: fresh.ideaId, error: fresh.error, maxIterations: fresh.maxIterations };
    usePipelines.setState((s) => (s.runs[taskId] ? { runs: { ...s.runs, [taskId]: { ...s.runs[taskId], ...patch } } } : s.recent[taskId] ? { recent: { ...s.recent, [taskId]: { ...s.recent[taskId], ...patch } } } : s));
    // Remember where it goes (the stored thread, else Tony's main thread): looked up once per task.
    if (!origin.has(taskId)) origin.set(taskId, storedThread(t) ?? "auto");
    const mref = t.raw_intent?.memory_reference as { source?: unknown } | null | undefined;
    const le = t.last_eval as { known_blockers?: unknown; known_blockers_total?: unknown; works?: unknown; verdict?: unknown } | null | undefined;
    const kb = le?.known_blockers;
    const total = typeof le?.known_blockers_total === "number" ? le.known_blockers_total : undefined;
    // The honest verdict: `works`, else read from `verdict` ("needs_fixes" / "pass…"); absent → unknown.
    const works = typeof le?.works === "boolean" ? le.works : le?.verdict === "needs_fixes" ? false : typeof le?.verdict === "string" && le.verdict.startsWith("pass") ? true : undefined;
    return { source: typeof mref?.source === "string" ? mref.source : null, blockers: Array.isArray(kb) ? kb.filter((b): b is string => typeof b === "string") : [], total, works };
  } catch {
    return none; // the event's own fields are enough
  }
}

/** The "ready" turn of each task (its "Open in Play Place" pill is filled in when the card lands). */
const readyTurn = new Map<string, string>();

/** A Play Place hub outcome (smoke test, Repair Queue, a steer): a bus note traced `hub:<id>`. */
const isHubNote = (ev: AgentEvent) => typeof ev.traceId === "string" && ev.traceId.startsWith("hub:");

/** Live events handled this process boot (by `seq`): a replayed one is never a second turn. */
const seenSeq = new Set<number>();
let seenBoot: number | null = null;
function markSeen(ev: AgentEvent) {
  if (typeof ev?.seq !== "number") return;
  seenSeq.add(ev.seq);
  if (seenSeq.size > 2000) seenSeq.delete(seenSeq.values().next().value as number);
  rememberSeq(ev);
}

/** The native listener: every live event is marked seen, then handled. */
function onLiveEvent(ev: AgentEvent) {
  markSeen(ev);
  return onAgentEvent(ev);
}

export async function onAgentEvent(ev: AgentEvent): Promise<void> {
  if (!ev || typeof ev !== "object") return;
  if (!ev.taskId) {
    if (isHubNote(ev)) {
      // The hub's half of the conversation: smoke verdicts, repair passes, Repair Queue, steers.
      const tone = ev.severity === "critical" ? "error" : undefined;
      useVoice.getState().pushTurn({ who: "agent", from: "staging", thread: "auto", text: ev.shortSummary, meta: `Play Place · ${ev.eventType.replace(/^hub_/, "")}`, tone });
      if (ev.severity === "critical") useToasts.getState().push({ title: `${osName()} · Play Place`, body: ev.shortSummary, tone: "error" });
      if (ev.eventType === "hub_smoke" && /ready for merge/.test(ev.shortSummary)) usePipelines.setState((s) => ({ unseen: s.unseen + 1 }));
      return;
    }
    // Bus-only notes: a critical one (a Librarian discrepancy, …) is worth a toast.
    if (ev.severity === "critical") useToasts.getState().push({ title: `${osName()} · ${ev.agentId}`, body: ev.shortSummary, tone: "error" });
    return;
  }
  usePipelines.setState((s) => applyEvent(s, ev));
  // "Play Place card created" (after review_ready): give the ready turn its "Open in Play Place".
  if (ev.agentId === "staging" && (ev.templateSummary ?? ev.shortSummary).startsWith("Play Place card created")) void attachCard(ev.taskId);
  const kind = chatKind(ev, level());
  if (!kind) return;
  // Every outcome / relay knows its origin thread, source and the Prompter's verdict.
  const extras = kind === "failed" || kind === "ready" || !origin.has(ev.taskId) ? await refreshTask(ev.taskId) : { source: null, blockers: [] };
  const row = usePipelines.getState().runs[ev.taskId] ?? usePipelines.getState().recent[ev.taskId];
  const title = row?.title || "the build";
  const back = threadOf(ev.taskId);
  const push = useVoice.getState().pushTurn;
  const taskId = ev.taskId;
  if (kind === "failed") {
    if (isCancelled(row?.error, ev.shortSummary)) {
      push({ who: "system", thread: back, text: `Stopped “${title}” (cancelled) — nothing more runs for it.`, taskId });
      return;
    }
    const hub = extras.source === "playplace";
    push({
      who: "agent",
      from: "os",
      thread: back,
      taskId,
      // A Play Place build is retried through the hub (its Repair Queue), never behind its back.
      text: hub
        ? `The build for “${title}” failed${ev.stage ? ` at the ${ev.stage} step` : ""}: ${ev.shortSummary}. It's in the Play Place Repair Queue — re-queue it there.`
        : `The build for “${title}” failed${ev.stage ? ` at the ${ev.stage} step` : ""}: ${ev.shortSummary}. Retry it, or hand that step to a CLI agent?`,
      actions: hub
        ? undefined
        : [
            { label: "Retry step", run: `retry:${ev.taskId}` },
            { label: "Offload to Claude CLI", run: `offload:claude-cli:${ev.taskId}` },
            { label: "Offload to Gemini CLI", run: `offload:gemini-cli:${ev.taskId}` },
          ],
    });
    useToasts.getState().push({ title: `${osName()} · build failed`, body: `${title}: ${ev.shortSummary}`, tone: "error" });
    return;
  }
  if (kind === "ready") {
    const hub = extras.source === "playplace";
    const text = readyText({ title, slug: row?.slug, blockers: extras.blockers, hub, total: extras.total, works: extras.works });
    const needsFixes = extras.works === false || (extras.works === undefined && extras.blockers.length > 0);
    const turn = push({ who: "agent", from: "os", thread: back, text, cardId: row?.cardId, taskId, tone: needsFixes ? "warn" : undefined });
    if (!row?.cardId) readyTurn.set(taskId, turn.id);
    useToasts.getState().push({ title: `${osName()} · ${hub ? "output ready" : extras.works === false ? "needs fixes" : "ready for review"}`, body: text, tone: needsFixes ? "error" : "info" });
    // A hub build counts as new only once its smoke test passes (the hub's own note).
    if (!hub) usePipelines.setState((s) => ({ unseen: s.unseen + 1 }));
    return;
  }
  if (kind === "alert") {
    push({ who: "system", thread: back, text: `${title}: ${relayText(ev)}`, tone: "warn", taskId });
    return;
  }
  const iter = ev.iteration ? ` · iteration ${ev.iteration}${row?.maxIterations ? `/${row.maxIterations}` : ""}` : "";
  // The row's own recipient (the post-commit owner is often someone else), the build it belongs
  // to, and the facts before the agent's words.
  push({ who: "relay", from: ev.agentId, to: ev.toAgent ?? ev.owner ?? ev.agentId, text: relayText(ev), meta: `“${title}” · ${ev.stage ?? ev.eventType}${iter}`, thread: relayThread(ev.agentId), taskId, cardId: row?.cardId });
}

/** The card id landed after the ready turn: fill in its "Open in Play Place" pill. */
async function attachCard(taskId: string) {
  await refreshTask(taskId);
  const row = usePipelines.getState().recent[taskId] ?? usePipelines.getState().runs[taskId];
  const turnId = readyTurn.get(taskId);
  if (row?.cardId && turnId) {
    useVoice.getState().updateTurn(turnId, { cardId: row.cardId });
    readyTurn.delete(taskId);
  }
}

/** Desktop + phone: replay the agent events emitted before this webview listened (app startup,
 * a reload): the "Interrupted by a restart; resuming…" rows and anything else from that gap. */
export async function replayMissed() {
  if (!isTauri()) return;
  let after = 0;
  try {
    const saved = JSON.parse(sessionStorage.getItem("cc.events.seen") ?? "null") as { boot: number; seq: number } | null;
    const r = await cmd("agent_events_replay", { afterSeq: 0 });
    seenBoot = r.boot;
    if (saved && saved.boot === r.boot) after = saved.seq;
    for (const ev of r.events) {
      if (ev.seq <= after || seenSeq.has(ev.seq)) continue;
      markSeen(ev);
      await onAgentEvent(ev);
    }
  } catch {
    /* an older build has no replay */
  }
}

/** Remember the newest handled event per boot (a webview reload replays only what's newer). */
function rememberSeq(ev: AgentEvent) {
  if (seenBoot === null || typeof ev.seq !== "number") return;
  try {
    sessionStorage.setItem("cc.events.seen", JSON.stringify({ boot: seenBoot, seq: ev.seq }));
  } catch {
    /* private mode */
  }
}

const PIPELINE_QUEUED = (title: string) => `Queued “${title}”. The Prompter's on it. Ask me where the build's at anytime.`;

/** An approved ledger "Run" (only ever from approve()'s plan.run): the idea → a queued task.
 * Resolves with the real outcome line and THROWS on a refusal / failure (so the card's run fails
 * through the calm-error path): it never says "Queued" before the task exists. Phone: waits for
 * the desktop's answer like a build `task` does. */
export async function runPipeline(ideaId: string, title: string, thread: ThreadId): Promise<string> {
  if (!isTauri()) {
    const { queueDesktopItem } = await import("@/features/dispatcher/dispatch");
    const r = await queueDesktopItem("pipeline", { ideaId }, { capMs: 30_000 });
    if (!r) return `Sent “${title}” to the desktop. It gets queued once the app picks it up.`;
    return r.created === false ? `“${title}” is already in progress.` : PIPELINE_QUEUED(title);
  }
  const r = await cmd("idea_pipeline_run", { ideaId });
  trackTask(r.taskId, title, thread, ideaId);
  return r.created ? PIPELINE_QUEUED(title) : `“${title}” is already in progress.`;
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

/** Phone: the gateway's mirror of the desktop's envelopes. A build that left the active list since
 * the last poll is looked up once and its outcome posted to the phone's Tony thread (the phone has
 * no agent-event feed: a phone-started build used to finish without a word there). */
export async function pollMirror() {
  const r = await gateway<{ items: TaskLike[] }>("/api/tasks?active=1");
  const before = usePipelines.getState().runs;
  const next = hydrateRuns(r.items ?? []).runs;
  usePipelines.setState((s) => ({ runs: next, recent: s.recent }));
  for (const id of Object.keys(before).filter((id) => !next[id])) {
    const t = await gateway<TaskLike>(`/api/tasks/${encodeURIComponent(id)}`).catch(() => null);
    const line = t ? mirrorOutcomeLine(t) : null;
    if (line) {
      useVoice.getState().pushTurn({ who: "agent", from: "os", thread: "general", text: line, taskId: id, tone: t?.status === "failed" ? "warn" : undefined });
      usePipelines.setState((s) => ({ recent: { ...s.recent, [id]: runFromTask(t!) } }));
    }
  }
}

/** The phone's line for a build that finished on the desktop (null while it's still open). Pure. */
export function mirrorOutcomeLine(t: Pick<TaskLike, "title" | "status" | "project_slug" | "error">): string | null {
  const title = t.title || "the build";
  if (t.status === "review_ready") return `“${title}” is ready for review.${t.project_slug ? ` It's in staging/${t.project_slug}.` : ""}`;
  if (t.status === "failed") return isCancelled(t.error) ? `Stopped “${title}” (cancelled).` : `The build for “${title}” failed: ${t.error ?? "unknown error"}. Retry it from the desktop.`;
  return null;
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
    // Listen first, then replay what was emitted before the listener existed (deduped by seq).
    void onNativeEvent<AgentEvent>("agent-event", onLiveEvent).then(() => replayMissed());
    void onNativeEvent<PipelineStepEvent>("pipeline-step", onStep);
    return;
  }
  void pollMirror().catch(() => undefined);
  setInterval(() => void pollMirror().catch(() => undefined), 5000);
}
