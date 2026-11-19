import type { BrainstormNote } from "@/features/brainstorm/capture";
import type { VoiceTurn } from "@/features/voice/voice-store";
import { cc, collections } from "@/lib/cc-api";
import { platform, type Idea, type PlayCard } from "@/lib/platform";
import type { DeferTarget } from "./tier";

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
  const mine = turns.filter((t) => t.thread === thread && (t.who === "user" || t.who === "agent") && !(t.who === "agent" && t.meta && NOT_TALK.has(t.meta)) && !o.excludeIds?.includes(t.id) && t.text.trim());
  if (o.fromTurnId) {
    const i = mine.findIndex((t) => t.id === o.fromTurnId);
    if (i >= 0) return mine.slice(i);
  }
  return mine.filter((t) => now - t.at <= RECENT_MS).slice(-MAX_TURNS);
}

export function rawContextOf(slice: VoiceTurn[], osName = "Tony"): string {
  return slice.map((t) => `${t.who === "user" ? "You" : osName}: ${t.text.trim()}`).join("\n");
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
