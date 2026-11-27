/**
 * Deterministic fast path for Tony's work-mode switches (pure, unit-tested). Runs before any
 * model call, on typed AND spoken lines: "go into builder mode", "hey Tony, coaching mode",
 * "switch to exec mode and check the staging hub", "ops mode" (Operations). Gabagool Mode (a toggle, not a
 * work mode) stays with the OS-intent parser.
 *
 * Only an explicit command matches: a switch verb + "<alias> mode" at the start of the line, or
 * the whole line being "<alias> mode" — so "what does builder mode do?" or "builder mode is
 * slow" never switch anything.
 */

export type WorkModeId = "surface" | "builder" | "operations" | "coach" | "brainstorm" | "executive" | "learning";

/** Spoken / typed aliases → mode id (longest first when matching). */
export const MODE_ALIASES: Readonly<Record<string, WorkModeId>> = {
  "surface solo": "surface",
  "surface / solo": "surface",
  surface: "surface",
  solo: "surface",
  builder: "builder",
  build: "builder",
  building: "builder",
  // "operations" (and the "ops" of "ops manager") are Biz Ops routing words: they only switch with
  // "mode" (every form below requires it), so "operations, check the invoices" still routes.
  "business operations": "operations",
  operations: "operations",
  operational: "operations",
  operation: "operations",
  ops: "operations",
  "motivation coach": "coach",
  "motivational coach": "coach",
  coach: "coach",
  coaching: "coach",
  motivation: "coach",
  motivational: "coach",
  brainstorming: "brainstorm",
  brainstorm: "brainstorm",
  executive: "executive",
  exec: "executive",
  learning: "learning",
  learn: "learning",
  study: "learning",
};

const ALIAS_RE = Object.keys(MODE_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/[/]/g, "\\/").replace(/\s+/g, "\\s+"))
  .join("|");

const LEAD = "(?:(?:ok(?:ay)?|hey|yo|alright|right|so|um+|uh+|please|now)\\s+)*";
const ASK = "(?:(?:can|could|would|will) you\\s+|let'?s\\s+|i (?:want|need) (?:you )?to\\s+|i'?d like (?:you )?to\\s+)?";
const VERB =
  "(?:go(?:\\s+back)?\\s+(?:into|in|to)|get\\s+(?:into|in)|switch(?:\\s+over|\\s+back)?\\s+(?:to|into)|swap\\s+to|enter|put\\s+(?:yourself|us|it|you)\\s+(?:in|into)|activate|turn\\s+on|start|set(?:\\s+(?:your|the))?(?:\\s+mode)?\\s+to|change(?:\\s+over)?\\s+to|use|drop\\s+into|shift\\s+into|flip\\s+to)";

const VERB_FORM = new RegExp(`^${LEAD}${ASK}${VERB}\\s+(?:the\\s+|your\\s+)?(${ALIAS_RE})\\s+mode\\b(.*)$`, "i");
const BARE_FORM = new RegExp(`^${LEAD}(${ALIAS_RE})\\s+mode(?:\\s+(?:on|now|please|activate|engaged))?\\b(.*)$`, "i");
const GO_SOLO = /^(?:(?:ok(?:ay)?|hey|alright|so|let'?s)\s+)*go\s+solo\b(.*)$/i;

/** Leading joiners between the switch and the rest of a compound line. */
const JOINER = /^(?:[,;:.!-]+\s*|\s+)*(?:(?:and(?:\s+then)?|then|also|&|now|after that|plus)\b\s*)?(?:[,;:]\s*)?/i;

export interface ModeSwitch {
  mode: WorkModeId;
  /** The instruction that follows the switch ("" = a pure mode switch). */
  rest: string;
}

/** Drop a leading wake name ("hey Tony,", "Tony") and trailing punctuation. */
function clean(text: string, osName: string): string {
  const name = osName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") || "Tony";
  return text
    .trim()
    .replace(new RegExp(`^(?:(?:hey|ok(?:ay)?|yo|hi)\\s+)?${name}\\b[\\s,.:!-]*`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The mode switch a line asks for, or null. `rest` keeps the user's casing so a compound
 * instruction ("… and check the Staging Hub") reaches Tony unchanged.
 */
export function parseModeSwitch(text: string, osName = "Tony"): ModeSwitch | null {
  const t = clean(text, osName);
  if (!t || t.length > 400) return null;
  const m = VERB_FORM.exec(t) ?? BARE_FORM.exec(t);
  let mode: WorkModeId | undefined;
  let tail = "";
  if (m) {
    mode = MODE_ALIASES[m[1].toLowerCase().replace(/\s+/g, " ")];
    tail = m[2] ?? "";
  } else {
    const g = GO_SOLO.exec(t);
    if (!g) return null;
    mode = "surface";
    tail = g[1] ?? "";
  }
  if (!mode) return null;
  // A bare form must be the whole command or a clear compound (", and …"): "builder mode is slow"
  // is talk about the mode, not a switch.
  const rest = tail.replace(JOINER, "").replace(/^[\s.!?]+|[\s.!?]+$/g, "").trim();
  if (!VERB_FORM.test(t) && !GO_SOLO.test(t) && rest && !/^\s*(?:[,;:]|and\b|then\b|&)/i.test(tail)) return null;
  return { mode, rest };
}
