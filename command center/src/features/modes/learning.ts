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

const str = (v: unknown): v is string => typeof v === "string";

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
