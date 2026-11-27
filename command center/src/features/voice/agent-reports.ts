/**
 * Agent reports (Comms inbox): when a specialist finishes a background job it leaves Nic a short
 * spoken report in its own persona ("Nic, the edit's done. I tightened the opening and added
 * captions."). The report is played as written — Tony never introduces or rewrites it, so there is
 * no extra model call — and it always lands in the Comms inbox, unread until Nic opens or hears it.
 *
 * Pure core (tested in `agent-reports.test.ts`): which events are reports, the text, whose voice
 * reads it ("All Tony" > the row's "Speak in own voice" > the agent's own), the Trading agent's
 * urgent alerts, the play queue and Tony's "You've got 2 messages from the Director." line.
 * Runtime (`startReportPlayer`): plays each report when the room is quiet (the narrator's
 * `canSpeak`), lets ONLY an urgent Trading alert interrupt Tony, and logs every outcome.
 */
import type { AgentEvent, AgentVoice } from "@/lib/platform";
import type { AuditRow } from "@/features/trading/ibkr";
import { canSpeak, stripWakeWords, type NarratorSnapshot } from "./narrator";

/** ElevenLabs model every report is synthesized with (streamed sentence by sentence). */
export const REPORT_MODEL = "eleven_turbo_v2_5";
/** Longest report kept (two or three sentences; the agents are asked for < 240 characters). */
export const REPORT_MAX = 320;
/** A normal report waiting this long for quiet is not played any more: it stays unread in the inbox. */
export const REPORT_TTL_MS = 10 * 60_000;
/** Reports waiting to play at most (oldest normal one goes to inbox-only first). */
export const REPORT_QUEUE_CAP = 8;
/** First trading poll after a start: audit rows this recent still alert (older ones are history). */
export const TRADING_BACKFILL_MS = 10 * 60_000;

export interface AgentReport {
  /** Stable id: dedupes the same report across event replays and polls. */
  id: string;
  /** Who wrote it (roster id: "director", "coder", "trading", …). Never "general". */
  agent: string;
  text: string;
  /** Unix ms. */
  at: number;
  /** Trading alerts only: may interrupt Tony. */
  urgent: boolean;
  source: "task" | "render" | "trading" | "note";
  taskId?: string;
}

/** An inbox row: the report plus what happened to it. */
export interface InboxMessage extends AgentReport {
  /** Opened in Comms or heard in full. */
  read: boolean;
  /** When it was played (the last time). */
  spokenAt?: number;
  /** Whose voice read it ("general" = Tony). */
  voice?: string;
  /** It cut in over Tony. */
  interrupted?: boolean;
}

const SELF = new Set(["", "tony", "general", "os"]);

/** Task events that close a background job: the specialist's report. */
const TASK_REPORT_TYPES = new Set(["review_ready", "failed"]);
/** Bus-only events a Rust job can raise to leave a report (template text, never model text). */
const NOTE_REPORT_TYPES = new Set(["agent_report"]);

/** Is this `agent-event` a finished background job (a report, not a narration line)? Pure. */
export function isReportEvent(ev: Pick<AgentEvent, "eventType" | "agentId" | "taskId"> | null | undefined): boolean {
  if (!ev || SELF.has((ev.agentId || "").trim().toLowerCase())) return false;
  return (TASK_REPORT_TYPES.has(ev.eventType) && !!ev.taskId) || NOTE_REPORT_TYPES.has(ev.eventType);
}

/** Speakable text addressed to Nic: one line, "Nic, " in front unless it already names him, capped. Pure. */
export function addressToNic(raw: string, max = REPORT_MAX): string {
  let t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!/^(nic|nick|nicky|nicholas)\b/i.test(t)) {
    // Keep "I", acronyms and names capitalised; lowercase an ordinary first word ("Built, but…").
    const first = t.split(/[\s,]/)[0];
    const keep = first === "I" || /^[A-Z0-9]{2,}$/.test(first) || /^I'/.test(first);
    t = `Nic, ${keep ? t : t.charAt(0).toLowerCase() + t.slice(1)}`;
  }
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

/** The roster speaker for an event's agent ("system"/"staging" jobs belong to the Prompter's pipeline). Pure. */
export function reportAgent(agentId: string): string {
  const a = (agentId || "").trim().toLowerCase();
  return a === "system" || a === "staging" || a === "verifier" ? "prompter" : a;
}

/** An `agent-event` → a report, or null (not a report / nothing speakable). Pure. */
export function reportFromEvent(ev: AgentEvent, wakeWords: readonly string[]): AgentReport | null {
  if (!isReportEvent(ev) || typeof ev.shortSummary !== "string") return null;
  const text = addressToNic(stripWakeWords(ev.shortSummary, wakeWords));
  if (!/[a-z0-9]/i.test(text.replace(/^nic,?/i, ""))) return null;
  const id = ev.taskId ? `task:${ev.taskId}:${ev.rowSeq ?? ev.eventType}` : `note:${ev.agentId}:${ev.seq}:${ev.at}`;
  return { id, agent: reportAgent(ev.agentId), text, at: typeof ev.at === "number" ? ev.at : Date.now(), urgent: false, source: ev.taskId ? "task" : "note", taskId: ev.taskId };
}

/** The `media-render` event payload (media.rs `render_event`), as far as a report needs it. */
export interface RenderEvent {
  slug: string;
  jobId: string;
  status: string;
  error?: string;
  render?: { durationSec?: number; width?: number; height?: number };
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)} minute${s >= 120 ? "s" : ""} ${s % 60 ? `${s % 60} seconds` : ""}`.trim() : `${s} seconds`;
};

/** The Director's own report on a finished render, in its persona (a template: no model call). Pure. */
export function directorReport(ev: RenderEvent, now: number): AgentReport | null {
  if (!ev?.jobId || (ev.status !== "done" && ev.status !== "failed")) return null;
  const project = (ev.slug || "the project").replace(/[-_]+/g, " ");
  let text: string;
  if (ev.status === "done") {
    const r = ev.render ?? {};
    const size = r.width && r.height ? ` at ${r.width} by ${r.height}` : "";
    const len = r.durationSec ? `, ${clock(r.durationSec)}` : "";
    text = `Nic, the ${project} render is done${len}${size}. I checked the streams and it's on the verified shelf.`;
  } else {
    const why = (ev.error || "").replace(/\s+/g, " ").trim().split(/[.;:]/)[0].slice(0, 90);
    text = `Nic, the ${project} render didn't make it${why ? `: ${why}` : ""}. The raw footage is untouched.`;
  }
  return { id: `render:${ev.jobId}:${ev.status}`, agent: "director", text: addressToNic(text), at: now, urgent: false, source: "render" };
}

// ── Trading: the only reports that may interrupt ─────────────────────────────

const str = (v: unknown, n = 80) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/**
 * A Trading Desk audit row → an urgent alert, or null. Urgent = the kill switch fired (not a dry
 * run), the daily loss limit was hit, or a trade was blocked or failed. Pure.
 */
export function tradingAlert(row: AuditRow): AgentReport | null {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const reason = str(p.reason) || str(p.why) || str(p.error) || str(row.ref);
  const at = row.ts > 1e12 ? row.ts : row.ts * 1000;
  const mk = (kind: string, text: string): AgentReport => ({ id: `trading:${kind}:${row.id}`, agent: "trading", text: addressToNic(text), at, urgent: true, source: "trading" });
  const lossLimit = /daily loss/i.test(`${reason} ${str(p.detail)}`);
  switch (row.kind) {
    case "kill":
      if (p.dryRun === true || p.dry_run === true) return null;
      return lossLimit
        ? mk("loss", `Nic, the daily loss limit just hit and I fired the kill switch. Orders are cancelled and positions are flattening.`)
        : mk("kill", `Nic, the kill switch just fired${reason ? `: ${reason}` : ""}. Orders are cancelled and positions are flattening.`);
    case "rule_limit_block": {
      const sym = str(p.symbol, 12);
      if (lossLimit) return mk("loss", `Nic, the daily loss limit is hit. I'm blocking new entries${sym ? `, starting with ${sym}` : ""}.`);
      return mk("block", `Nic, I blocked a trade${sym ? ` in ${sym}` : ""}${reason ? `: ${reason}` : ""}.`);
    }
    case "pretrade_rejected":
    case "llm_trade_refused":
    case "intent_schema_rejected": {
      const failed = Array.isArray(p.failed) ? p.failed.filter((x) => typeof x === "string").slice(0, 2).join(" and ") : "";
      return mk("block", `Nic, a trade was blocked before it went out${failed ? `: ${failed}` : reason ? `: ${reason}` : ""}.`);
    }
    case "order_failed":
      return mk("failed", `Nic, an order failed at the broker${reason ? `: ${reason}` : ""}. Nothing was filled.`);
    default:
      return null;
  }
}

/** New urgent alerts in an audit tail. `since` = the newest row id already seen (null = first poll,
 * where only rows newer than `TRADING_BACKFILL_MS` alert). Returns the alerts and the new mark. Pure. */
export function newTradingAlerts(tail: readonly AuditRow[], since: number | null, now: number): { alerts: AgentReport[]; mark: number | null } {
  let mark = since;
  const alerts: AgentReport[] = [];
  const seen = new Set<string>();
  for (const row of [...tail].sort((a, b) => a.id - b.id)) {
    if (mark !== null && row.id <= mark) continue;
    const a = tradingAlert(row);
    if (a && (since !== null || now - a.at <= TRADING_BACKFILL_MS)) {
      // One alert per kind and ref (a scan blocking five symbols is one line, not five).
      const k = `${a.id.split(":")[1]}:${row.ref}`;
      if (!seen.has(k)) {
        seen.add(k);
        alerts.push(a);
      }
    }
    mark = mark === null ? row.id : Math.max(mark, row.id);
  }
  return { alerts, mark };
}

// ── Voice ────────────────────────────────────────────────────────────────────

export interface VoicePrefs {
  agentVoices: Record<string, AgentVoice | undefined>;
  agentVoicesAllTony?: boolean;
}

/** "Speak in own voice" for a roster row (missing row or flag = on). Pure. */
export const ownVoiceOn = (row: AgentVoice | undefined): boolean => row?.ownVoice !== false;

/** Whose voice reads `agent`'s report: Tony's ("general") when "All Tony" is on or the row's
 * "Speak in own voice" is off; else the agent's own roster voice. Pure. */
export function reportVoice(agent: string, prefs: VoicePrefs | null | undefined): string {
  if (!prefs || prefs.agentVoicesAllTony) return prefs ? "general" : agent;
  return ownVoiceOn(prefs.agentVoices[agent]) ? agent : "general";
}

// ── Queue ────────────────────────────────────────────────────────────────────

/** Add a report to the play queue: no duplicates, urgent first then oldest, stale normal ones
 * dropped, capped (the oldest normal report goes first; urgent ones are never dropped). Pure. */
export function enqueueReport(queue: readonly AgentReport[], r: AgentReport, now: number, cap = REPORT_QUEUE_CAP): { queue: AgentReport[]; dropped: AgentReport[] } {
  const dropped: AgentReport[] = [];
  let q = queue.filter((x) => {
    const stale = !x.urgent && now - x.at > REPORT_TTL_MS;
    if (stale) dropped.push(x);
    return !stale && x.id !== r.id;
  });
  if (!r.urgent && now - r.at > REPORT_TTL_MS) return { queue: q, dropped: [...dropped, r] };
  q.push(r);
  q.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.at - b.at);
  while (q.length > cap) {
    const i = q.findIndex((x) => !x.urgent);
    if (i < 0) break;
    dropped.push(q[i]);
    q = q.filter((_, j) => j !== i);
  }
  return { queue: q, dropped };
}

// ── Tony's inbox line ────────────────────────────────────────────────────────

const NAMES: Record<string, string> = { prompter: "the Prompter", designer: "the Designer", director: "the Director", coder: "the Coder", librarian: "the Librarian", trading: "the Trading agent", booking: "the Booking Desk", bizops: "Biz Ops", finance: "Finance" };
export const agentName = (a: string) => NAMES[a] ?? a.charAt(0).toUpperCase() + a.slice(1);
const count = (n: number) => (n === 1 ? "a message" : `${n === 2 ? "2" : n} messages`);

/** "You've got 2 messages from the Director." / "…from the Director and 1 from the Coder." /
 * "No new messages." Unread only, busiest sender first. Pure. */
export function inboxLine(unread: readonly Pick<InboxMessage, "agent" | "read">[]): string {
  const by = new Map<string, number>();
  for (const m of unread) if (!m.read) by.set(m.agent, (by.get(m.agent) ?? 0) + 1);
  if (!by.size) return "No new messages, Nic.";
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([a, n], i) => (i === 0 ? `${count(n)} from ${agentName(a)}` : `${n} from ${agentName(a)}`));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `You've got ${list}.`;
}

/** Nic asking about his AGENT reports: "any agent reports?", "what are my agent messages", "play
 * my reports", "read me the agent messages". `play` = play the unread ones too. A plain "check my
 * messages" is NOT this — it is a WhatsApp / Gmail read Tony does with his own tools. Pure. */
export function parseInboxAsk(line: string): { play: boolean } | null {
  const t = line.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim().replace(/^(hey |yo |ok |okay )?(tony |jarvis )?/, "");
  const noun = "(agent (messages?|reports?|updates?)|reports?)";
  if (!new RegExp(`\\b${noun}\\b`).test(t) || /\b(text|texts|sms|whatsapp|email|emails|gmail|send|reply|write)\b/.test(t)) return null;
  if (new RegExp(`^(play|read|hear)( me)?( my| the| those| them| all)*( new| unread)? ${noun}( please)?$`).test(t)) return { play: true };
  if (new RegExp(`^((do i have|have i got|got|any|i got)( any)?( new| unread)? ${noun}|(check|what are|what s|whats)( my| the)?( new| unread)? ${noun}|${noun})( please)?$`).test(t)) return { play: false };
  return null;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export type SpeechOutcome = "spoke" | "queued" | "inbox_only" | "replayed" | "failed";

export interface ReportPlayerDeps {
  /** Play a report through the normal speech path. Resolves false when it could not be played at all
   * (mic locked off, no TTS, Learning mode's voice lock): it then stays unread in the inbox. */
  speak: (r: AgentReport, voice: string) => Promise<boolean>;
  /** Cut in over Tony: hold his audio, play the alert, resume (urgent Trading only). Same false rule. */
  interrupt: (r: AgentReport, voice: string) => Promise<boolean>;
  snapshot: () => NarratorSnapshot;
  /** os.json feedback level (0 = silent: inbox only, even urgent alerts). */
  level: () => number;
  prefs: () => VoicePrefs | null | undefined;
  /** The inbox (Comms). `add` is called for every report, before any audio. */
  inbox: { add: (r: AgentReport) => void; heard: (id: string, meta: { voice: string; interrupted: boolean }) => void };
  /** Telemetry: one call per outcome (ids only). */
  log: (r: AgentReport, meta: { voice: string; outcome: SpeechOutcome; interrupted: boolean; waitedMs: number }) => void;
  now?: () => number;
  pollMs?: number;
}

export interface ReportPlayer {
  push: (r: AgentReport) => void;
  queue: () => readonly AgentReport[];
  playing: () => boolean;
  drain: () => Promise<void>;
  stop: () => void;
}

/** The one kind of report that may interrupt Tony: the Trading agent's urgent alert. */
export const isUrgentAlert = (r: Pick<AgentReport, "agent" | "urgent">): boolean => r.urgent && r.agent === "trading";

/** Tony is busy with Nic right now (speaking, thinking, listening to him, a card up). */
export const tonyBusy = (s: NarratorSnapshot): boolean => s.sayDepth > 0 || s.activeStreams > 0 || s.pending || s.holding || !["idle", "error", "listening"].includes(s.state) || (s.state === "listening" && (!s.passiveWake || s.heardSpeech));

export function startReportPlayer(deps: ReportPlayerDeps): ReportPlayer {
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? 500;
  let queue: AgentReport[] = [];
  let playing = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const logged = new Set<string>();

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && queue.length) timer = setTimeout(() => void drain(), pollMs);
  };
  const toInbox = (dropped: AgentReport[]) => {
    for (const d of dropped) deps.log(d, { voice: reportVoice(d.agent, deps.prefs()), outcome: "inbox_only", interrupted: false, waitedMs: now() - d.at });
  };

  async function play(r: AgentReport, cutIn: boolean): Promise<void> {
    const voice = reportVoice(r.agent, deps.prefs());
    playing = true;
    try {
      const spoke = await (cutIn ? deps.interrupt(r, voice) : deps.speak(r, voice));
      if (!spoke) {
        deps.log(r, { voice, outcome: "inbox_only", interrupted: false, waitedMs: Math.max(0, now() - r.at) });
        return;
      }
      deps.inbox.heard(r.id, { voice, interrupted: cutIn });
      deps.log(r, { voice, outcome: "spoke", interrupted: cutIn, waitedMs: Math.max(0, now() - r.at) });
    } catch {
      deps.log(r, { voice, outcome: "failed", interrupted: cutIn, waitedMs: Math.max(0, now() - r.at) });
    } finally {
      playing = false;
    }
  }

  async function drain(): Promise<void> {
    if (stopped || playing || !queue.length) return;
    const { queue: q, dropped } = enqueueReport(queue.slice(1), queue[0], now());
    queue = q;
    toInbox(dropped);
    if (!queue.length) return;
    const snap = deps.snapshot();
    // Only an urgent Trading alert cuts in (ahead of anything queued); everything else waits for quiet.
    const alert = tonyBusy(snap) ? queue.find(isUrgentAlert) : undefined;
    const next = alert ?? queue[0];
    const cutIn = !!alert;
    if (!cutIn && !canSpeak(snap, now())) {
      if (!logged.has(next.id)) {
        logged.add(next.id);
        deps.log(next, { voice: reportVoice(next.agent, deps.prefs()), outcome: "queued", interrupted: false, waitedMs: 0 });
      }
      return schedule();
    }
    queue = queue.filter((x) => x !== next);
    await play(next, cutIn);
    schedule();
  }

  return {
    push: (raw) => {
      if (stopped) return;
      const r = raw.urgent && !isUrgentAlert(raw) ? { ...raw, urgent: false } : raw; // only Trading is ever urgent
      deps.inbox.add(r);
      if (deps.level() <= 0) return toInbox([r]);
      const { queue: q, dropped } = enqueueReport(queue, r, now());
      queue = q;
      toInbox(dropped);
      void drain();
    },
    queue: () => queue,
    playing: () => playing,
    drain,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      queue = [];
    },
  };
}
