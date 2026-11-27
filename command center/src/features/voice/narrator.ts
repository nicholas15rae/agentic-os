/**
 * Part 6 narration: agent progress spoken in each agent's own roster voice, never over Nic or
 * Tony. Pure core (tested): `narrates`, `enqueue`, `prune`, `canSpeak`, `eventToItem`. Runtime
 * (`startNarrator`): subscribes to Rust's `agent-event`, filters by `feedback.sensitivity`, and
 * drains the queue only when `canSpeak` says the room is quiet. Speech goes through the voice
 * controller's exported `narrate()` (injected here, so this file never imports the controller).
 *
 * Rules (tf-decisions D16 OVERRIDE):
 * - the voice is the agent's EXISTING roster voice (providers.json agentVoices, Kokoro defaults for
 *   gaps); `narrationEngine: "kokoro"` only adds `localOnly` (local Kokoro, same per-agent voice);
 * - who speaks (Part 7, the sensitivity gate): level 1 = Tony relays milestones in his voice
 *   ("The Coder says: …"); level 2+ = each specialist speaks its own lines in its own voice;
 * - default sensitivity 1; level 0 is silent (toasts only), even for critical events;
 * - a line waits behind Tony's say / sayLive and any live turn, and is dropped when stale.
 *
 * Future "mode" settings (Phase 2 `tts_interrupt_level`) drive narration through
 * `feedback.sensitivity` alone: `feedbackLevel()` is the single read point.
 */
import { isTauri, onNativeEvent, type AgentEvent, type EventSeverity, type FeedbackLevel, type OsConfig } from "@/lib/platform";

export const SEVERITIES: readonly EventSeverity[] = ["critical", "milestone", "handoff", "verbose"];
/** Most lines a queue holds (criticals are never dropped, so it can briefly exceed this). */
export const QUEUE_CAP = 5;
/** Quiet gap after Nic's last speech or the last TTS line before a narration line may start. */
export const QUIET_GAP_MS = 1500;
const TTL_MS: Record<EventSeverity, number> = { verbose: 30_000, handoff: 30_000, milestone: 120_000, critical: Number.POSITIVE_INFINITY };
const SPOKEN_MAX = 240;

/** Agent Chatter (`routing.vocalHandoffs`) off: internal agent back-and-forth (handoff / verbose
 * events) is never spoken — milestones and critical lines still are. Pure. */
export function chatterMuted(severity: string, chatterOn: boolean): boolean {
  return !chatterOn && (severity === "handoff" || severity === "verbose");
}

/** Mirrors Rust `events::narrates`: is an event of `severity` spoken at feedback `level`? */
export function narrates(severity: string, level: number): boolean {
  switch (severity) {
    case "critical":
    case "milestone":
      return level >= 1;
    case "handoff":
      return level >= 2;
    case "verbose":
      return level >= 3;
    default:
      return false;
  }
}

/** Clamp anything (a stale os.json, a future mode setting) to 0–3; missing → 1. */
export function clampLevel(v: unknown): FeedbackLevel {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 1;
  return Math.max(0, Math.min(3, n)) as FeedbackLevel;
}

/** The single read point for the feedback level (os.json `feedback.sensitivity`, default 1). */
export function feedbackLevel(cfg: Pick<OsConfig, "feedback"> | null | undefined): FeedbackLevel {
  return clampLevel(cfg?.feedback?.sensitivity);
}

export interface NarrationItem {
  /** Coalescing key: one line per task (per severity class), else per agent + event type. */
  key: string;
  taskId?: string;
  traceId?: string;
  text: string;
  /** Roster speaker ("general" = Tony). */
  agent: string;
  severity: EventSeverity;
  /** When the event happened (ms). TTLs count from here. */
  at: number;
  /** How many events this line stands for (collapsed criticals / coalesced updates). */
  count: number;
  /** The event type (`task_queued`, `review_ready`, …). */
  eventType?: string;
}

const rank = (s: EventSeverity) => SEVERITIES.length - SEVERITIES.indexOf(s); // critical 4 … verbose 1

/** Drop expired lines (criticals never expire). Pure. */
export function prune(queue: readonly NarrationItem[], now: number): NarrationItem[] {
  return queue.filter((i) => now - i.at <= TTL_MS[i.severity]);
}

/**
 * Add `item`: expired lines go first; a line for the same task and class (critical / final /
 * update, see `eventToItem`) is replaced by the newer one (latest wins), unless the waiting line
 * is MORE severe: a queued milestone is never replaced by a later handoff / verbose line (the
 * newer one is folded into its count instead). Criticals collapse and are never dropped; then the
 * queue is capped at `cap`, dropping the oldest lowest-severity non-critical line. Pure.
 */
export function enqueue(queue: readonly NarrationItem[], item: NarrationItem, now: number, cap = QUEUE_CAP): NarrationItem[] {
  let q = prune(queue, now);
  if (now - item.at > TTL_MS[item.severity]) return q; // already stale
  const prev = q.find((i) => i.key === item.key);
  if (prev && rank(prev.severity) > rank(item.severity)) return q.map((i) => (i === prev ? { ...i, count: i.count + item.count } : i));
  q = q.filter((i) => i.key !== item.key);
  q.push({ ...item, count: (prev?.count ?? 0) + item.count });
  while (q.length > cap) {
    const victims = q.filter((i) => i.severity !== "critical");
    if (!victims.length) break; // criticals are never dropped
    const lowest = Math.min(...victims.map((i) => rank(i.severity)));
    const v = victims.find((i) => rank(i.severity) === lowest)!; // oldest of the lowest class
    q = q.filter((i) => i !== v);
  }
  return q;
}

/** The next line to speak: criticals first, then oldest. Pure. */
export function nextItem(queue: readonly NarrationItem[]): NarrationItem | null {
  if (!queue.length) return null;
  return [...queue].sort((a, b) => rank(b.severity) - rank(a.severity) || a.at - b.at)[0];
}

/** What the voice controller looks like right now (`narratorSnapshot()`). */
export interface NarratorSnapshot {
  /** useVoice state: idle | listening | transcribing | thinking | speaking | confirming | holding | error. */
  state: string;
  /** say() calls in flight (Tony / an agent / a cue has audio queued). */
  sayDepth: number;
  /** os_turns still generating. */
  activeStreams: number;
  /** The VAD heard speech in the current listen. */
  heardSpeech: boolean;
  /** Hold mode is on. */
  holding: boolean;
  /** A confirmation card is waiting. */
  pending: boolean;
  /** The current listen is only hands-free's silent wake-word re-arm (nothing heard). */
  passiveWake: boolean;
  /** ms of Nic's last VAD speech onset (0 = never). */
  lastUserSpeechAt: number;
  /** ms the last say() finished (0 = never). */
  lastTtsEndAt: number;
}

/**
 * May a narration line start now? All of: nothing being said (sayDepth 0), no turn generating,
 * no hold, no card, state idle (or a passive wake listen that has heard nothing), and 1.5 s of
 * quiet since Nic last spoke and since the last line ended. Pure.
 */
export function canSpeak(s: NarratorSnapshot, now: number): boolean {
  if (s.sayDepth > 0 || s.activeStreams > 0 || s.holding || s.pending) return false;
  // "error" is a resting state too (an STT error line on screen, nobody talking).
  const restful = s.state === "idle" || s.state === "error" || (s.state === "listening" && s.passiveWake && !s.heardSpeech);
  if (!restful) return false;
  if (now - s.lastUserSpeechAt < QUIET_GAP_MS || now - s.lastTtsEndAt < QUIET_GAP_MS) return false;
  return true;
}

/** Roster speaker for an event's agent id ("tony" → Tony's roster row "general"). */
export function speakerFor(agentId: string): string {
  const a = (agentId || "").trim().toLowerCase();
  return a === "tony" || a === "os" || !a ? "general" : a;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Defence in depth (Rust already strips): no wake word or OS name in a spoken line, so narration
 * through the speakers can never wake Tony. */
export function stripWakeWords(text: string, words: readonly string[]): string {
  let out = text;
  const phrases = [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => /[a-z0-9]/.test(w)))].sort((a, b) => b.length - a.length);
  for (const p of phrases) out = out.replace(new RegExp(`\\b${p.split(/\s+/).map(esc).join("\\s+")}\\b(?:'s)?[,:]?`, "gi"), "");
  return out.replace(/\s+/g, " ").replace(/^[\s,:;—-]+/, "").trim();
}

export interface EventContext {
  level: number;
  /** Trace ids of the live turn(s): their events are already spoken by the announcer handoff. */
  liveTraceIds: ReadonlySet<string>;
  /** Tasks whose queueing Tony already said out loud ("Queued. The Prompter's on it…"): their
   * `task_queued` row is not narrated again. (Task events carry `task:<id>` trace ids, which
   * `liveTraceIds` never holds.) */
  announcedTasks?: ReadonlySet<string>;
  /** Wake words + OS name to strip. */
  wakeWords: readonly string[];
}

const RELAY_NAME: Record<string, string> = { prompter: "The Prompter", designer: "The Designer", director: "The Director", coder: "The Coder", librarian: "The Librarian", verifier: "The verifier", staging: "Staging", system: "The build checks" };

/**
 * An `agent-event` → a narration line, or null (not narrated at this level, the live turn's own,
 * empty). Voice, per the sensitivity gate (Part 7): at level 2+ every line is the speaking agent
 * in its own roster voice (handoffs are the specialists talking); at level 1 Tony relays the
 * milestones in his voice, attributing an agent's own words ("The Coder says: …"). Pure.
 */
export function eventToItem(ev: AgentEvent, ctx: EventContext): NarrationItem | null {
  if (!ev || typeof ev.shortSummary !== "string" || !SEVERITIES.includes(ev.severity)) return null;
  if (!narrates(ev.severity, ctx.level)) return null;
  if (ev.traceId && ctx.liveTraceIds.has(ev.traceId)) return null;
  if (alreadyAnnounced(ev.eventType, ev.taskId, ctx.announcedTasks)) return null;
  const said = stripWakeWords(ev.shortSummary, ctx.wakeWords).trim();
  if (!/[a-z0-9]/i.test(said)) return null;
  const own = speakerFor(ev.agentId);
  const relay = ctx.level < 2 && own !== "general";
  const agent = relay ? "general" : own;
  const who = RELAY_NAME[own] ?? own.charAt(0).toUpperCase() + own.slice(1);
  const text = (relay && ev.fromVoiceSummary ? `${who} says: ${said}` : said).slice(0, SPOKEN_MAX).trim();
  // "Ready for review" has its own slot: a later read-report / discrepancy line never replaces it.
  const cls = ev.severity === "critical" ? "critical" : ev.eventType === "review_ready" ? "final" : "update";
  const key = ev.taskId ? `task:${ev.taskId}:${cls}` : `agent:${own}:${ev.eventType}`;
  return { key, taskId: ev.taskId, traceId: ev.traceId, text, agent, severity: ev.severity, at: typeof ev.at === "number" ? ev.at : Date.now(), count: 1, eventType: ev.eventType };
}

/** A `task_queued` line for a task Tony already announced. Pure. */
export function alreadyAnnounced(eventType: string | undefined, taskId: string | undefined, announced: ReadonlySet<string> | undefined): boolean {
  return eventType === "task_queued" && !!taskId && !!announced?.has(taskId);
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export interface NarratorDeps {
  /** Speak one line in `agent`'s voice (voice-controller `narrate`). Resolves when it ends or is cut. */
  narrate: (text: string, agent: string, opts: { localOnly: boolean }) => Promise<void>;
  snapshot: () => NarratorSnapshot;
  /** os.json (feedback level, narration engine). */
  cfg: () => Pick<OsConfig, "feedback"> | null | undefined;
  /** Trace ids of the turn(s) in flight. */
  liveTraceIds: () => ReadonlySet<string>;
  /** Tasks whose queueing was already spoken (see `EventContext.announcedTasks`). */
  announcedTasks?: () => ReadonlySet<string>;
  wakeWords: () => readonly string[];
  now?: () => number;
  /** Poll interval while lines wait for quiet. */
  pollMs?: number;
  /** Subscribe to `agent-event` (default: the Tauri event). */
  subscribe?: (h: (ev: AgentEvent) => void) => Promise<() => void>;
}

export interface Narrator {
  /** Feed one event (what the subscription calls). */
  push: (ev: AgentEvent) => void;
  /** Lines waiting. */
  queue: () => readonly NarrationItem[];
  /** A line is playing now. */
  speaking: () => boolean;
  /** Try to speak now (tests; the poll calls it too). */
  drain: () => Promise<void>;
  stop: () => void;
}

/** Start the narrator. Idempotent per deps object is the caller's job (voice-controller starts it once). */
export function startNarrator(deps: NarratorDeps): Narrator {
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? 500;
  let queue: NarrationItem[] = [];
  let speaking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let off: (() => void) | undefined;

  const schedule = () => {
    clearTimeout(timer);
    if (stopped || !queue.length) return;
    timer = setTimeout(() => void drain(), pollMs);
  };

  async function drain(): Promise<void> {
    if (stopped || speaking) return;
    queue = prune(queue, now());
    const level = feedbackLevel(deps.cfg());
    // Level turned down meanwhile: drop what it no longer narrates.
    queue = queue.filter((i) => narrates(i.severity, level));
    // The event can beat `task_create`'s reply (and so the announcement) here: re-check at speak time.
    const announced = deps.announcedTasks?.();
    queue = queue.filter((i) => !alreadyAnnounced(i.eventType, i.taskId, announced));
    const item = nextItem(queue);
    if (!item) return;
    if (!canSpeak(deps.snapshot(), now())) return schedule();
    queue = queue.filter((i) => i !== item);
    speaking = true;
    try {
      await deps.narrate(item.text, item.agent, { localOnly: deps.cfg()?.feedback?.narrationEngine === "kokoro" });
    } catch {
      /* best-effort: the text is in the chat / trace */
    } finally {
      speaking = false;
    }
    schedule();
  }

  const push = (ev: AgentEvent) => {
    if (stopped) return;
    const item = eventToItem(ev, { level: feedbackLevel(deps.cfg()), liveTraceIds: deps.liveTraceIds(), announcedTasks: deps.announcedTasks?.(), wakeWords: deps.wakeWords() });
    if (!item) return;
    queue = enqueue(queue, item, now());
    void drain();
  };

  const subscribe = deps.subscribe ?? (isTauri() ? (h: (ev: AgentEvent) => void) => onNativeEvent<AgentEvent>("agent-event", h) : null);
  if (subscribe)
    void subscribe(push).then((o) => {
      if (stopped) o();
      else off = o;
    });

  return {
    push,
    queue: () => queue,
    speaking: () => speaking,
    drain,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      off?.();
      queue = [];
    },
  };
}
