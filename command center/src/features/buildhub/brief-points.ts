import { compileEnvelope, LIST_MAX, type Compiled } from "./compile";

/**
 * Widget builder (section pass, step 8): a described widget ("a fortune cookie widget: tap the
 * cookie to crack it, show a random fortune, …") becomes a checklist of points. Nic sees and edits
 * the list before anything is built; each point becomes an acceptance criterion the verifier must
 * prove in a real browser (Rust `contract_criteria` pins them). Pure.
 */

/** The three standing checks `criteriaFor` always adds; points fill the rest of the envelope's 12. */
export const MAX_POINTS = LIST_MAX - 3;

const LEAD = /^\s*(?:please\s+|hey tony,?\s+|tony,?\s+)?(?:(?:can|could) you\s+)?(?:(?:make|build|create|add|design|code|give)\s+(?:me\s+|us\s+)?)?(?:a|an|one|my|the)?\s+/i;
const KIND = /\b(widget|app|card|tile|tool|panel|page|game|toy|dashboard)\b/i;
/** Where the description of what it does starts. */
const REST = /\s*(?::|—|–|-\s|\bthat\b|\bwhich\b|\bwhere\b|\bwith\b|\bso\b|\bto\b(?=\s+(?:show|track|help|let|keep|play|pick|tell)))\s*/i;
/** Verbs that start a new point after "and" ("… a button for a new fortune and keep a history …"). */
const VERBS = "show|shows|add|adds|keep|keeps|let|lets|display|displays|tap|click|press|save|saves|play|plays|include|includes|track|tracks|count|counts|pick|picks|have|has|give|gives|make|makes|offer|offers|store|stores|remember|remembers|reset|resets|open|opens|crack|cracks|change|changes|use|uses|animate|animates|list|lists|flip|flips|spin|spins|roll|rolls|draw|draws|share|shares|copy|copies|sort|sorts|filter|filters";
const NEXT = `(?=(?:also\\s+)?(?:${VERBS}|a|an|the)\\b)`;
const SPLIT = new RegExp(`\\s*(?:\\n+|;|•|(?:^|\\s)[-*]\\s|\\.\\s+(?=[A-Z])|(?<!\\d),\\s*(?:and\\s+)?${NEXT}|,(?!\\d)\\s*(?:and\\s+)?${NEXT}|\\s+(?:and|plus|also)\\s+(?=(?:also\\s+)?(?:${VERBS})\\b))\\s*`, "g");
/** A stand-in for a comma inside quotes (never a split point); put back after splitting. */
const QUOTED_COMMA = "\u0001";

const clean = (s: string) =>
  s
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:and|also|plus|it should|should|it|that)\s+/i, "")
    .replace(/[.!\s]+$/, "")
    .trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface BriefChecklist {
  title: string;
  points: string[];
  /** Points past MAX_POINTS (shown, never silently dropped). */
  overflow: string[];
}

/** "Make me a fortune cookie widget: …" → title "Fortune cookie" and the points. Pure. */
export function briefPoints(text: string): BriefChecklist {
  const t = text.replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " ")).trim();
  const body = t.replace(LEAD, "");
  const kind = body.search(KIND);
  const restAt = body.slice(0, 120).search(REST);
  let title: string;
  let rest: string;
  if (kind >= 0 && (restAt < 0 || kind < restAt)) {
    title = body.slice(0, kind).trim();
    rest = body.slice(kind).replace(KIND, "").replace(/^\s*(?::|—|–|-\s|that|which|where|with|so|to)?\s*/i, "");
  } else if (restAt >= 0) {
    title = body.slice(0, restAt).trim();
    rest = body.slice(restAt).replace(REST, "");
  } else {
    title = body;
    rest = "";
  }
  title = cap(title.replace(/[^\p{L}\p{N}' &-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60)) || "New widget";
  const raw = (rest || t)
    .replace(/(["“])([^"”]*)(["”])/g, (_m, a: string, inner: string, b: string) => `${a}${inner.replace(/,/g, QUOTED_COMMA)}${b}`)
    .split(SPLIT)
    .map((p) => clean(p).replace(new RegExp(QUOTED_COMMA, "g"), ","))
    .filter((p) => p.length >= 3 && /\p{L}/u.test(p));
  const seen = new Set<string>();
  const points = raw.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).map((p) => cap(p).slice(0, 200));
  return { title, points: points.slice(0, MAX_POINTS), overflow: points.slice(MAX_POINTS) };
}

/** Controls and actions the quick card templates can't do (a bare noun like "history" or "score" is a data card). */
const INTERACTIVE = /\b(tap|taps|click|clicks|press|button|buttons|drag|toggle|crack|random|randomly|shuffle|roll|dice|game|quiz|animate|animated|animation|timer|stopwatch|flip|spin|guess|confetti|streak|swipe|check(?:s|ed)? (?:them|it|items?|tasks?) off|tick(?:s)? off|mark|type|input|enter|edit|dropdown|slider|sliders|checkbox|to-?do|tracker|converter|saves?|i can add|add (?:tasks|items|notes|entries))\b|\b(?:keep|keeps|track|tracks|save|saves|show|shows)\s+(?:a |the |my )?(?:history|score)\b|\bplays?\s+(?:a|the)\s+\w+/i;

/**
 * Needs the build pipeline (interactive, or several things to do) rather than the quick card
 * generator, which only fills one of a few data templates. Pure.
 */
export function needsPipeline(text: string, points: readonly string[]): boolean {
  return points.length >= 3 || INTERACTIVE.test(text);
}

/** The Play Place build for a checklist: an internal widget built by the agent pipeline. Pure. */
export function compileWidgetBuild(text: string, list: Pick<BriefChecklist, "title" | "points">, ctx: { now: number; rand: string; stagingRoot: string; externalBase: string }): Compiled {
  // One point = one criterion: `criteriaFor` splits its text on ";" and line breaks.
  const points = list.points.map((p) => p.replace(/[;\n\r]+/g, ", ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, MAX_POINTS);
  if (!points.length) throw new Error("Add at least one point the widget must do");
  const questions = [
    { id: "runtime", question: "Where does it run?", options: ["Dashboard widget"], allow_free_text: false },
    { id: "worker", question: "Who builds it?", options: ["The Coder"], allow_free_text: false },
    { id: "success", question: "What must it do? (each point is checked in a real browser)", options: [], allow_free_text: true },
  ];
  const answers = { runtime: { choice: "Dashboard widget" }, worker: { choice: "The Coder" }, success: { text: points.join("\n") } };
  return compileEnvelope([{ id: `widget-${ctx.now}`, title: list.title, text, created: ctx.now }], questions, answers, { ...ctx, title: list.title });
}
