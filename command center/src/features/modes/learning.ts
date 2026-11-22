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

/** The pathways worth a pill (an already-known lesson isn't news). */
export const pillPathways = (l: readonly LearnedPathway[] | null | undefined): LearnedPathway[] => (l ?? []).filter((p) => p.outcome !== "unchanged");

/** "Memory saved: …" / "Memory updated: …" / "Memory confirmed: …" (+ provisional). */
export function learnedPillText(p: Pick<LearnedPathway, "title" | "outcome" | "confidence">): string {
  const verb = p.outcome === "superseded" ? "updated" : p.outcome === "updated" ? "confirmed" : "saved";
  return `Memory ${verb}: ${p.title}${p.confidence === "provisional" ? " (provisional)" : ""}`;
}
