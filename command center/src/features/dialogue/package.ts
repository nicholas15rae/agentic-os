import type { BrainstormNote } from "@/features/brainstorm/capture";
import type { VoiceTurn } from "@/features/voice/voice-store";
import { cc, collections } from "@/lib/cc-api";
import { platform, type Idea, type PlayCard } from "@/lib/platform";
import type { DeferTarget } from "./tier";
import { sameConversation } from "./dialogue-store";

/**
 * P3 Tier 4: package the brainstorm you just had with Tony and park it (Brainstorm list, Ideas &
 * Tasks Ledger or Play Place). Summarised by the gateway's local LM Studio (`cc.llmJson`, $0 —
 * not a worker agent) with a deterministic fallback, so a save never fails on a down model.
 *
 * NEVER calls `idea_capture`, `runPipeline`, `os_turn` or any agent: parking is storage only.
 * The packaged text is never logged (it is whatever was said, sometimes quoting messages).
 */
export interface Artifact {
  title: string;
  summary: string;
  /** "You: …" / "Tony: …" lines of the slice. */
  rawContext: string;
  timestamp: number;
  tags: string[];
}

/** Without a live session, only this recent a window is packaged. */
const RECENT_MS = 30 * 60_000;
const MAX_TURNS = 20;
/** The gateway's /api/cc/llm/json caps the prompt at 8000 characters. */
const LLM_PROMPT_MAX = 7500;
const LLM_TIMEOUT_MS = 15_000;

/** Agent turns that aren't conversation: OS-control acks, earlier saves, live stream placeholders. */
const NOT_TALK = new Set(["os-control", "parked", "routing", "streaming…", "cut"]);

/**
 * The conversation worth saving: the active thread's own user / agent turns (never relay or
 * system turns, never another thread), from the brainstorm's first turn — or, with no session,
 * the last 20 turns of the past 30 minutes. `excludeIds`: the defer line itself.
 */
export function conversationSlice(turns: VoiceTurn[], thread: string, o: { fromTurnId?: string; excludeIds?: string[]; now?: number } = {}): VoiceTurn[] {
  const now = o.now ?? Date.now();
  const mine = turns.filter((t) => sameConversation(t.thread ?? "", thread) && (t.who === "user" || t.who === "agent") && !(t.who === "agent" && t.meta && NOT_TALK.has(t.meta)) && !o.excludeIds?.includes(t.id) && t.text.trim());
  if (o.fromTurnId) {
    const i = mine.findIndex((t) => t.id === o.fromTurnId);
    if (i >= 0) return mine.slice(i);
  }
  return mine.filter((t) => now - t.at <= RECENT_MS).slice(-MAX_TURNS);
}

export function rawContextOf(slice: VoiceTurn[], osName = "Tony"): string {
  return slice.map((t) => `${t.who === "user" ? "You" : osName}: ${t.text.trim()}`).join("\n");
}

/** A build brief's budget (the task store takes 8000; a little headroom for its secret scrub). */
export const BUILD_BRIEF_MAX = 7500;
const TRIM_MARK = "[…trimmed to fit…]";

/**
 * The brief a build gets from a brainstorm: Nic's OWN lines first (the opening idea always
 * whole, then every later line — the latest refinements included), then Tony's side as context,
 * trimmed first. The commit cue itself ("ok let's do it") is dropped. It used to be the last
 * 4000 characters of the raw transcript, which lost the opening idea, and the worker then read
 * only the head of THAT (mostly Tony's filler). Pure.
 */
export function briefOf(slice: VoiceTurn[], osName = "Tony", o: { dropText?: string; max?: number } = {}): string {
  const max = o.max ?? BUILD_BRIEF_MAX;
  let turns = slice.filter((t) => t.text.trim());
  const last = turns[turns.length - 1];
  if (o.dropText && last?.who === "user" && last.text.trim() === o.dropText.trim()) turns = turns.slice(0, -1);
  const mine = turns.filter((t) => t.who === "user").map((t) => `- ${t.text.trim()}`);
  const theirs = turns.filter((t) => t.who !== "user").map((t) => `${osName}: ${t.text.trim()}`);
  let head = mine.length ? `What Nic said (in order):\n${mine.join("\n")}` : "";
  if (head.length > max) {
    // Keep the opening idea whole and as many of the latest lines as fit.
    const first = mine[0];
    const tail: string[] = [];
    let room = max - first.length - TRIM_MARK.length - 40;
    for (let i = mine.length - 1; i > 0 && room > 0; i--) {
      if (mine[i].length + 1 > room) break;
      tail.unshift(mine[i]);
      room -= mine[i].length + 1;
    }
    head = `What Nic said (in order):\n${first.slice(0, max - 60)}\n${TRIM_MARK}\n${tail.join("\n")}`.slice(0, max);
    return head;
  }
  if (!theirs.length) return head;
  const label = `\n\n${osName}'s side of the conversation (context only):\n`;
  let room = max - head.length - label.length;
  if (room <= TRIM_MARK.length + 20) return head;
  // Tony's latest lines matter most (where it landed); his earliest are trimmed first.
  const kept: string[] = [];
  for (let i = theirs.length - 1; i >= 0; i--) {
    const line = theirs[i].length > room ? `${theirs[i].slice(0, Math.max(0, room - TRIM_MARK.length - 4))}… ${TRIM_MARK}` : theirs[i];
    if (line.length + 1 > room) break;
    kept.unshift(line);
    room -= line.length + 1;
    if (line !== theirs[i]) break;
  }
  if (kept.length < theirs.length && kept[0] !== undefined && !kept[0].includes(TRIM_MARK)) kept.unshift(TRIM_MARK);
  return kept.length ? `${head}${label}${kept.join("\n")}` : head;
}

/** A free-text brief (a parked card's whole context) cut to fit: head and tail kept, marked. Pure. */
export function fitBrief(text: string, max = BUILD_BRIEF_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const keep = max - TRIM_MARK.length - 4;
  const head = Math.floor(keep * 0.6);
  return `${t.slice(0, head)}\n\n${TRIM_MARK}\n\n${t.slice(t.length - (keep - head))}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Deterministic title: the first thing you said, trimmed of filler. */
export function fallbackTitle(slice: VoiceTurn[]): string {
  const first = slice.find((t) => t.who === "user")?.text.trim() ?? "";
  const t = first
    .replace(/^(?:(?:hey|hi|ok(?:ay)?|yo|so|um|uh|aye)[\s,]+)*(?:tony|jarvis)?[\s,]*/i, "")
    .replace(/^(?:i'?ve been thinking (?:about|of)|i'?m thinking (?:about|of)|what if|i have an idea(?: for)?|new idea:?)\s*/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  const s = t || "Untitled idea";
  return clip(s.charAt(0).toUpperCase() + s.slice(1), 60);
}

function fallbackArtifact(slice: VoiceTurn[], rawContext: string, now: number): Artifact {
  const users = slice.filter((t) => t.who === "user").map((t) => t.text.trim());
  return { title: fallbackTitle(slice), summary: clip(users.slice(0, 2).join(" "), 400), rawContext, timestamp: now, tags: [] };
}

const SYSTEM = [
  "You package a brainstorm between the user and their assistant so it can be picked up later.",
  'Reply ONLY with JSON: {"title": string (at most 8 words), "summary": string (2-3 sentences: the idea, where it landed, any open question), "tags": [up to 5 short lowercase tags]}.',
  "Use only what was said. Do not invent features, names or decisions.",
].join("\n");

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function buildArtifact(slice: VoiceTurn[], o: { osName?: string; now?: number; timeoutMs?: number } = {}): Promise<Artifact> {
  const now = o.now ?? Date.now();
  const rawContext = rawContextOf(slice, o.osName);
  const fallback = fallbackArtifact(slice, rawContext, now);
  if (!rawContext) return fallback;
  try {
    const j = await Promise.race([
      cc.llmJson<{ title?: unknown; summary?: unknown; tags?: unknown }>(SYSTEM, rawContext.slice(-LLM_PROMPT_MAX)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("summary timed out")), o.timeoutMs ?? LLM_TIMEOUT_MS)),
    ]);
    const title = str(j?.title, 80).split(" ").slice(0, 8).join(" ").replace(/[.!?]+$/, "");
    const summary = str(j?.summary, 600);
    const tags = Array.isArray(j?.tags) ? [...new Set(j.tags.map((t) => str(t, 24).toLowerCase()).filter(Boolean))].slice(0, 5) : [];
    return { title: title || fallback.title, summary: summary || fallback.summary, rawContext, timestamp: now, tags };
  } catch {
    return fallback;
  }
}

/** Write the artifact to its target, parked. Storage only — never an agent. */
export async function saveArtifact(target: DeferTarget, a: Artifact, slice: VoiceTurn[], osName = "Tony"): Promise<{ id: string; target: DeferTarget }> {
  if (target === "brainstorm") {
    const note = await collections.create<BrainstormNote>("notes", {
      title: a.title,
      rawText: a.rawContext,
      segments: slice.map((t) => ({ t: t.at, text: `${t.who === "user" ? "You" : osName}: ${t.text.trim()}`, device: platform })),
      organized: { title: a.title, summary: a.summary, tags: a.tags },
      organizedAt: a.timestamp,
      tags: a.tags,
      summary: a.summary,
      source: "tony",
    });
    return { id: note.id, target };
  }
  if (target === "ledger") {
    const idea = await collections.create<Idea>("ideas", { title: a.title, idea: a.rawContext, summary: a.summary, tasks: [], spec: {}, status: "parked", tags: a.tags, savedAt: a.timestamp });
    return { id: idea.id, target };
  }
  const card = await collections.create<PlayCard>("playplace", { title: a.title, idea: a.rawContext, brief: a.summary, summary: a.summary, status: "parked", tags: a.tags, html: "", savedAt: a.timestamp });
  return { id: card.id, target };
}
