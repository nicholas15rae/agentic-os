/**
 * Learning mode — pure helpers for the webview (mirrors `src-tauri/src/commands/learning.rs`).
 *
 * Tony saves a lesson by adding `[[LEARN category | when | rule or fact | confirmed]]` lines to
 * his reply. Rust pulls them out of the final answer; the live token stream reaches the webview
 * raw, so `stripLearnTags` hides them (and any half-streamed tag) before the bubble shows them or
 * TTS speaks them. Text before a tag never moves, so sentence-by-sentence speech stays aligned.
 */

/** One saved pathway as `os_turn` reports it (Rust `learning::Saved`). */
export interface LearnedPathway {
  id: string;
  title: string;
  category: string;
  confidence: "confirmed" | "provisional" | string;
  outcome: "saved" | "updated" | "superseded" | "unchanged" | string;
  /** `superseded`: the memory it replaced, as one line. */
  replaced?: string;
}

const COMPLETE = /\[\[\s*LEARN\b[\s\S]*?\]\]/gi;
const WORD = "LEARN";

/**
 * `text` without `[[LEARN …]]` tags. While streaming (`final` false) a trailing tag that hasn't
 * closed yet — or a `[` / `[[` / `[[LEA…` that may become one — is held back too.
 */
export function stripLearnTags(text: string, final = false): string {
  let s = text.replace(COMPLETE, "");
  if (!final) {
    const open = s.lastIndexOf("[[");
    if (open >= 0 && !s.includes("]]", open)) {
      const tail = s.slice(open + 2).trimStart().toUpperCase();
      if (tail.startsWith(WORD) || WORD.startsWith(tail)) s = s.slice(0, open);
    } else if (s.endsWith("[")) s = s.slice(0, -1);
  }
  return s.replace(/\n{3,}/g, "\n\n");
}

/**
 * A lesson Tony proposed in Learning mode, waiting for Nic's yes (Rust `learning::PendingMemory`,
 * `OsTurnResult.pendingMemory`). Nothing is saved until the card's Save, a spoken "yes" or the
 * phone's `memoryApprove`; then it is a core memory in every Tony prompt.
 */
export interface PendingMemory {
  id: string;
  category: string;
  text: string;
}

/** Tony's question after a proposal (mirrors Rust `learning::CORE_QUESTION`). */
export const CORE_QUESTION = "Want me to add that to my core memories?";

/** A proposal id as Rust accepts it (`resolve_proposal`, os_api `_MEMORY_ID`). */
export const MEMORY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** How long a proposal waits for Nic's yes (mirrors Rust `learning::PROPOSAL_TTL_MS`). */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Rust's fixed replies to a whole-line yes / no (`agents::answer_proposal`, provider "learning",
 * no model call). Mirrors `learning::SAVED_REPLY` / `ALREADY_REPLY` / `DISCARDED_REPLY`. */
export const SAVED_REPLY = "Saved to my core memories.";
export const ALREADY_REPLY = "That's already in my core memories.";
export const DISCARDED_REPLY = "Okay, I won't save that.";
/** Rust's reply when a spoken / typed yes could not save (mirrors `learning::SAVE_FAILED_REPLY`):
 * the batch stays pending under the same ids, and since this reply asks again, a yes / no right
 * after it answers that same batch. */
export const SAVE_FAILED_REPLY = "I couldn't save that just now. Want me to try again and add it to my core memories?";

/**
 * How a memory card ended without its own buttons (`VoiceTurn.memoryEnd`): a spoken / typed yes
 * saved its lessons ("saved"; "known" when each already was a core memory) or a no dropped them
 * ("skipped"); "gone": no longer pending (Rust keeps proposals in memory only, so a desktop
 * restart drops them). An expired card shows as "gone" too, but that is derived from its expiry
 * (`cardExpiresAt`, MemoryProposalCard), never stored.
 */
export type MemoryCardEnd = "saved" | "known" | "skipped" | "gone";

/** Which proposals Rust's answer to a spoken / typed yes / no took (Rust `agents::AnsweredMemory`,
 * `OsTurnResult.answeredMemory`): `approved` saved them, else they were dropped. None on a failed save. */
export interface AnsweredMemory {
  ids: string[];
  approved: boolean;
}

/** What a card needs from its turn (a `VoiceTurn`; this module stays free of the voice store). */
export interface CardTurn {
  id: string;
  who: string;
  thread: string;
  text: string;
  at: number;
  meta?: string;
  pendingMemory?: PendingMemory[];
  memoryExpiresAt?: number;
  memoryEnd?: MemoryCardEnd;
  /** On Rust's answer turn: exactly which proposals it answered (`answeredMemoryOf`). */
  answeredMemory?: AnsweredMemory;
  rev?: number;
}

/** Rust's answer turn shows its provider id "learning" in the turn's meta: "learning · 4ms" on the
 * desktop (osRun), "Tony · desktop:learning · 900ms" on the phone (dispatch → execute / phoneVoiceRun). */
const ANSWER_META = /(?:^|\s·\s)(?:desktop:)?learning(?:\s·\s|$)/;

const isLearningReply = (t: Pick<CardTurn, "who" | "meta">): boolean => t.who === "agent" && ANSWER_META.test(t.meta ?? "");

/** A turn that is Rust's answer to a spoken / typed yes / no, and what it did to the batch. Null
 * for any other turn, Rust's `SAVE_FAILED_REPLY` too (the proposals stay pending, same ids). */
export function memoryAnswerOf(t: Pick<CardTurn, "who" | "text" | "meta">): Exclude<MemoryCardEnd, "gone"> | null {
  if (!isLearningReply(t)) return null;
  const s = t.text.trim();
  if (s === DISCARDED_REPLY) return "skipped";
  if (s === ALREADY_REPLY) return "known";
  return s.startsWith(SAVED_REPLY) ? "saved" : null;
}

/** Rust's own failed-save answer (provider "learning", `SAVE_FAILED_REPLY`): the batch it tried is
 * still the one a yes / no answers next, so the card stays on the reply before it. */
const isSaveFailed = (t: Pick<CardTurn, "who" | "text" | "meta">): boolean => isLearningReply(t) && t.text.trim() === SAVE_FAILED_REPLY;

/** A reply that proposed a batch (it carries, or carried, a card). */
const proposed = (t: Pick<CardTurn, "pendingMemory" | "memoryExpiresAt">): boolean => !!t.pendingMemory?.length || t.memoryExpiresAt !== undefined;

/** Rust's proposal ids are `mem-{created ms}-{seq}` (`learning::Proposals::propose`). */
const ID_TIME = /^mem-(\d{12,14})-\d+$/;
const DAY_MS = 86_400_000;

/** When a card's batch was proposed: its ids' Rust timestamp when that is plausible (not after
 * `seen`, less than a day before it: another device's clock may be a little off), else `seen`. */
export function proposalCreatedAt(items: readonly PendingMemory[], seen: number): number {
  const m = items.length ? ID_TIME.exec(items[0].id) : null;
  const t = m ? Number(m[1]) : NaN;
  return Number.isFinite(t) && t <= seen && seen - t < DAY_MS ? t : seen;
}

/** A turn whose card just arrived gets its expiry, once: created + `PROPOSAL_TTL_MS`. */
export function withCardExpiry<T extends Pick<CardTurn, "pendingMemory" | "memoryExpiresAt">>(t: T, now: number): T {
  return t.pendingMemory?.length && t.memoryExpiresAt === undefined ? { ...t, memoryExpiresAt: proposalCreatedAt(t.pendingMemory, now) + PROPOSAL_TTL_MS } : t;
}

/** The card's expiry: the stored one, else (a turn saved before it was stored) from the ids / the turn's time. */
export const cardExpiresAt = (t: Pick<CardTurn, "pendingMemory" | "memoryExpiresAt" | "at">): number => t.memoryExpiresAt ?? proposalCreatedAt(t.pendingMemory ?? [], t.at) + PROPOSAL_TTL_MS;

/**
 * The turns after `answerId` landed: when it is Rust's answer to a spoken / typed yes / no, the card
 * it answered ends ("saved" / "known" / "skipped") instead of keeping live buttons. Rust answers
 * only the batch of Tony's immediately preceding reply, and only when that reply (the newest
 * assistant message in the conversation's history) asked the core question: so the card is on the
 * newest agent turn before the answer in its thread, past any of Rust's failed-save replies (they
 * ask again about the same batch). Rust's spoken batch is app-wide, though (`Proposals::propose`
 * moves it to the newest proposal, whichever conversation made it): when any thread proposed
 * after that card, Rust's answer may have been about the newer batch, so the card stays live (its
 * own buttons, or its expiry, still settle it). Same array when nothing changes.
 */
export function settleAnsweredCard<T extends CardTurn>(turns: T[], answerId: string): T[] {
  const i = turns.findIndex((t) => t.id === answerId);
  if (i < 0) return turns;
  // Rust said which proposals it took (`answeredMemory`): exactly the card holding them, in any
  // thread, and no guessing. A newer Rust answers only the card the request named (`answering`).
  const named = turns[i].answeredMemory;
  if (named?.ids.length && isLearningReply(turns[i])) {
    const ids = new Set(named.ids);
    const j = turns.findIndex((t) => t.who === "agent" && !t.memoryEnd && !!t.pendingMemory?.some((p) => ids.has(p.id)));
    if (j < 0) return turns;
    const out = turns.slice();
    out[j] = { ...turns[j], memoryEnd: memoryAnswerOf(turns[i]) ?? (named.approved ? "saved" : "skipped"), rev: (turns[j].rev ?? 0) + 1 };
    return out;
  }
  const end = memoryAnswerOf(turns[i]);
  if (!end) return turns;
  for (let j = i - 1; j >= 0; j--) {
    const t = turns[j];
    if (t.thread !== turns[i].thread || t.who !== "agent" || isSaveFailed(t)) continue;
    if (!t.pendingMemory?.length || t.memoryEnd) return turns;
    if (turns.slice(j + 1, i).some(proposed)) return turns;
    const out = turns.slice();
    out[j] = { ...t, memoryEnd: end, rev: (t.rev ?? 0) + 1 };
    return out;
  }
  return turns;
}

/** The desktop app restarted at `startedAt` (Rust `app_uptime`): every live card proposed before
 * that is "gone", since the restart emptied Rust's proposals. Same array when nothing changes. */
export function endCardsBefore<T extends CardTurn>(turns: T[], startedAt: number): T[] {
  let changed = false;
  const out = turns.map((t) => {
    if (!t.pendingMemory?.length || t.memoryEnd || cardExpiresAt(t) - PROPOSAL_TTL_MS >= startedAt) return t;
    changed = true;
    return { ...t, memoryEnd: "gone" as const, rev: (t.rev ?? 0) + 1 };
  });
  return changed ? out : turns;
}

/**
 * `OsTurnRequest.answering` for a turn in `thread`: the proposal ids on the card of the thread's
 * newest agent turn (past Rust's failed-save replies, which ask again about the same batch). That
 * reply is the history's last assistant message, the one Rust checks asked the core question, so
 * a yes / no can only answer its card: Rust takes the app-wide spoken batch only when it holds one
 * of these ids, never a batch another thread or device proposed since. `[]`: that reply has no
 * card, or the thread has no agent turn yet (every caller sends this thread's history, so no Tony
 * reply here means no card here): a yes answers nothing. Never `undefined`: Rust's id-less rule
 * would take whatever batch another conversation proposed last.
 */
export function answeringIds(turns: readonly CardTurn[], thread: string): string[] {
  for (let j = turns.length - 1; j >= 0; j--) {
    const t = turns[j];
    if (t.thread !== thread || t.who !== "agent" || isSaveFailed(t)) continue;
    return (t.pendingMemory ?? []).map((p) => p.id).filter((id) => MEMORY_ID_RE.test(id));
  }
  return [];
}

const str = (v: unknown): v is string => typeof v === "string";

/** `answeredMemory` from a turn result the phone read through the gateway: well-formed or nothing. */
export function answeredMemoryOf(v: unknown): AnsweredMemory | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { ids?: unknown; approved?: unknown };
  if (!Array.isArray(o.ids) || typeof o.approved !== "boolean") return undefined;
  const ids = o.ids.filter((id): id is string => str(id) && MEMORY_ID_RE.test(id));
  return ids.length ? { ids, approved: o.approved } : undefined;
}

/** `pendingMemory` from a turn result the phone read through the gateway: well-formed rows only. */
export function pendingMemoryOf(v: unknown): PendingMemory[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is PendingMemory => !!p && typeof p === "object" && str(p.id) && MEMORY_ID_RE.test(p.id) && str(p.category) && str(p.text) && p.text.trim() !== "").map((p) => ({ id: p.id, category: p.category, text: p.text }));
}

/** `learned` from a turn result the phone read through the gateway: well-formed rows only. */
export function learnedOf(v: unknown): LearnedPathway[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is LearnedPathway => !!p && typeof p === "object" && str(p.id) && str(p.title) && str(p.category) && str(p.confidence) && str(p.outcome))
    .map((p) => ({ id: p.id, title: p.title, category: p.category, confidence: p.confidence, outcome: p.outcome, ...(str(p.replaced) && p.replaced.trim() ? { replaced: p.replaced } : {}) }));
}

/** The pathways worth a pill on a turn's reply (an already-known lesson isn't news: Tony's reply
 * says so). The card's Save shows every outcome, `unchanged` included. */
export const pillPathways = (l: readonly LearnedPathway[] | null | undefined): LearnedPathway[] => (l ?? []).filter((p) => p.outcome !== "unchanged");

/** "Memory saved: …" / "Memory updated: … (replaced: …)" / "Memory confirmed: …" (+ provisional) /
 * "Already a core memory: …" (a Save that changed nothing never reads as a save). */
export function learnedPillText(p: Pick<LearnedPathway, "title" | "outcome" | "confidence" | "replaced">): string {
  if (p.outcome === "unchanged") return `Already a core memory: ${p.title}`;
  const verb = p.outcome === "superseded" ? "updated" : p.outcome === "updated" ? "confirmed" : "saved";
  const replaced = p.outcome === "superseded" && p.replaced ? ` (replaced: ${p.replaced})` : "";
  return `Memory ${verb}: ${p.title}${p.confidence === "provisional" ? " (provisional)" : ""}${replaced}`;
}
