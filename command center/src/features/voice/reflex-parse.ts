import { norm } from "@/features/cues/gaba";

/**
 * Voice reflexes (Phase 2 §2): "cut it", "take it easy", "whoa", "keep going", "go ahead".
 * P5: the "take it easy" family depends on context — over a busy turn (Tony talking, a turn
 * thinking/executing) or while already holding it is a HOLD (with any rest, as before); when
 * Tony is idle / just listening and the phrase is the whole line it is a STAND-DOWN (hands-free
 * off); idle with trailing content it stays the hold-with-rest "thought-form lock".
 * Pure and import-light (only `norm`), so Vitest runs it without browser code — the same
 * pattern as `wake-word.ts`. Every phrase that shows up in live use goes in the tables
 * below AND in `reflex-parse.test.ts`.
 */
export type Reflex = {
  kind: "cut" | "hold" | "resume" | "submit" | "standdown";
  rest: string;
  /** A bare hard stop ("stop", "shut it off", "stop the timer"): a passive hands-free listen acts on it only after the wake word. */
  needsAddress?: true;
} | null;

export interface ReflexCtx {
  /** Tony/an agent is speaking OR a turn is thinking/executing. */
  busy: boolean;
  /** Already in hold mode. */
  holding: boolean;
  /** Speakers mode only: TTS is audible right now, so Tony's own "oh" could leak into the mic. */
  ttsAudible?: boolean;
  /** Speakers mode only: Spotify plays on this PC (ducked, still audible), so a lyric's "oh" could too. */
  musicAudible?: boolean;
}

/** Whole-word phrase tables, written as `norm()` produces them ("that's" → "that s"). */
export const CUT = ["cut it", "cut it out", "cut that", "cutit", "yo tony cut it", "tony cut it", "stop talking", "stop stop"];
/** Hard stops only when the line STARTS with one (after address words / "please") or is one on
 * its own: "Stop.", "Tony, shut it off", "stop, what's next?", "stop the timer". Never a
 * "contains" match, so mid-sentence and negated uses ("don't stop the music", "please don't
 * stop", "I can't stop") stay ordinary lines for the grammars and the LLM. */
export const CUT_LEADING = ["stop", "stop it", "shut off", "shut it off", "shut it down"];
/** The "take it easy" family (P5): a hold over a busy/held turn, a stand-down when idle and
 * the whole line, a hold-with-rest when idle with more after it. Whisper writes every one of these. */
export const EASE_MULTI = ["take it ease", "take it easy", "take it eas", "take it ees", "take it knees", "take at ease", "take it is"];
/** Whisper's "take it easy" — only as the whole utterance, never a prefix. */
export const EASE_STANDALONE = ["hey kitties"];
/** Holds in every state (never a stand-down). */
export const HOLD_MULTI = [
  "madone", "madonna", "ma donna", "my donna", "mad one",
  "aspetta", "aspett", "aspet", "a spetta", "ah spet",
];
export const HOLD_SINGLE = ["whoa", "woah", "oh", "eh", "aye", "ay"];
export const RESUME = ["keep going", "go on", "continue", "carry on", "where were you", "you were saying"];
export const SUBMIT = ["go ahead", "run that", "over to you", "that s it", "thats it", "send it"];

/** Address words in front of a reflex ("hey Tony, take it ease"). */
const LEAD = new Set(["hey", "yo", "ok", "okay", "alright", "so", "um", "uh", "tony", "yeah"]);
/** Lead words a cut may follow: the address words plus "please" and an emphatic "no"
 * ("please stop", "No, cut it!", "no no, stop"). "no don't stop" still isn't one: after the
 * skipped "no" the line starts with "don't", not a cut phrase. */
const CUT_LEAD = new Set([...LEAD, "please", "no"]);
/** Words that make a following cut phrase not a command ("don't cut it", "never stop talking"). */
const NEGATOR = new Set(["not", "never", "dont", "cant", "wont", "didnt", "doesnt", "shouldnt", "couldnt", "wouldnt", "isnt"]);
/** `norm` splits "don't" into "don t": the stem before a lone "t". */
const NEG_STEM = new Set(["don", "can", "won", "didn", "doesn", "shouldn", "couldn", "wouldn", "isn", "ain"]);
/** Trailing politeness after a standalone resume/submit ("keep going please"). */
const TAIL = new Set(["please", "tony", "now", "then", "yeah", "man"]);
/** Lead words before the "take it easy" family: the address words plus "please". */
const EASE_LEAD = new Set([...LEAD, "please"]);
/** Trailing words a whole-line stand-down may carry ("take it easy man", "take it easy, Nic"). */
const EASE_TAIL = new Set([...TAIL, "nic", "nicky", "buddy", "bro", "okay", "ok"]);

const toks = (s: string) => (s ? s.split(" ") : []);
const PHRASES = (list: string[]) => list.map(toks).sort((a, b) => b.length - a.length);
const T_CUT = PHRASES(CUT);
const T_CUT_LEADING = PHRASES(CUT_LEADING);
/** "stop talking" / "stop stop" follow the leading rule too: a cut only at the start of the line. */
const T_CUT_ANYWHERE = T_CUT.filter((p) => p[0] !== "stop");
const T_HOLD = PHRASES(HOLD_MULTI);
const T_EASE = PHRASES(EASE_MULTI);
const T_RESUME = PHRASES(RESUME);
const T_SUBMIT = PHRASES(SUBMIT);
const SINGLE = new Set(HOLD_SINGLE);
const EASE_ALONE = new Set(EASE_STANDALONE);

const startsWith = (w: string[], p: string[], at = 0) => p.length <= w.length - at && p.every((x, i) => w[at + i] === x);
/** Token `i` comes right after a negator ("not", "never", "don't", "can't" …). */
const negatedAt = (w: string[], i: number) => i > 0 && (NEGATOR.has(w[i - 1]) || (w[i - 1] === "t" && i > 1 && NEG_STEM.has(w[i - 2])));
/** `p` occurs in `w` somewhere that is not negated. */
const contains = (w: string[], p: string[]) => w.some((_, i) => startsWith(w, p, i) && !negatedAt(w, i));
/** Longest phrase `w` starts with (at `at`), as its token count; 0 if none. */
const prefixLen = (w: string[], table: string[][], at = 0) => table.find((p) => startsWith(w, p, at))?.length ?? 0;

/** Leading address words to skip (never all of them: "tony" alone stays a word). */
function leadCount(w: string[], lead: Set<string> = LEAD): number {
  let i = 0;
  while (i < w.length - 1 && lead.has(w[i])) i++;
  return i;
}

/** The original text after its first `n` words (punctuation and a joining "and/so" dropped). */
function restAfter(text: string, n: number): string {
  if (n <= 0) return text.trim();
  const words = [...text.matchAll(/[a-z0-9]+/gi)];
  const last = words[n - 1];
  if (!last) return "";
  return text
    .slice(last.index! + last[0].length)
    .replace(/^[\s,.!?:;'’…-]+/, "")
    .replace(/^(and|so|then)\b[\s,]*/i, "")
    .trim();
}

/** `w` (after `from`) is exactly the phrase, allowing trailing politeness. */
function standalone(w: string[], table: string[][], from: number, tail: Set<string> = TAIL): boolean {
  const n = prefixLen(w, table, from);
  if (!n) return false;
  return w.slice(from + n).every((x) => tail.has(x));
}

export function parseReflex(text: string, ctx: ReflexCtx): Reflex {
  const n = norm(text);
  if (!n) return null;
  const w = toks(n);

  // 1. Cut: every state. Short line containing a (non-negated) cut phrase, or a line that starts with one.
  if (w.length <= 5 && T_CUT_ANYWHERE.some((p) => contains(w, p))) return { kind: "cut", rest: "" };
  const cutLead = leadCount(w, CUT_LEAD);
  const cutLen = prefixLen(w, T_CUT, cutLead);
  if (cutLen) return { kind: "cut", rest: restAfter(text, cutLead + cutLen) };
  // Bare hard stops: the whole line, or its first words. Whatever follows is dropped with the turn.
  const stopLen = prefixLen(w, T_CUT_LEADING, cutLead);
  if (stopLen) {
    const rest = w.slice(cutLead + stopLen).every((x) => TAIL.has(x)) ? "" : restAfter(text, cutLead + stopLen);
    return { kind: "cut", rest, needsAddress: true };
  }
  const lead = leadCount(w);

  // 4. Resume / submit only mean something while holding.
  if (ctx.holding) {
    if (standalone(w, T_RESUME, lead)) return { kind: "resume", rest: "" };
    const sub = prefixLen(w, T_SUBMIT, lead);
    if (sub) return { kind: "submit", rest: restAfter(text, lead + sub) };
  }

  // 3a. The "take it easy" family (P5) — depends on context. Busy or holding: a hold, with any
  //     rest (today's behaviour). Idle / just listening: the whole line (lead + tail words only)
  //     is a stand-down — never while Tony is audible; with more after it, the thought-form lock.
  //     "hey kitties" (Whisper's "take it easy") only ever counts as the whole line.
  const engaged = ctx.busy || ctx.holding || !!ctx.ttsAudible;
  const easeLead = leadCount(w, EASE_LEAD);
  if (EASE_ALONE.has(n) || EASE_ALONE.has(w.slice(lead).join(" "))) return { kind: engaged ? "hold" : "standdown", rest: "" };
  const ease = prefixLen(w, T_EASE, easeLead);
  if (ease) {
    // A whole line's politeness ("man", "Nic", "please") is never a held thought.
    if (standalone(w, T_EASE, easeLead, EASE_TAIL)) return { kind: engaged ? "hold" : "standdown", rest: "" };
    return { kind: "hold", rest: restAfter(text, easeLead + ease) };
  }

  // 3b. Other multi-word holds: standalone or as a prefix, in any state ("thought-form lock").
  const hold = prefixLen(w, T_HOLD, lead);
  if (hold) return { kind: "hold", rest: restAfter(text, lead + hold) };

  // 2. Single-syllable holds: only over a busy/held turn, only as the whole line (repeats ok),
  //    and never while Tony or music is audible through speakers (an "oh" can leak into the mic).
  if ((ctx.busy || ctx.holding) && !ctx.ttsAudible && !ctx.musicAudible && w.every((x) => SINGLE.has(x))) return { kind: "hold", rest: "" };

  return null;
}

/**
 * Is the line ONLY a cut — the phrase plus address / politeness words ("Cut it.", "Tony, stop",
 * "no no, cut it out please")? A line that merely starts with or contains one ("Stop motion
 * studio app, I want…", "let's cut that feature") is not: with nothing running to cut it is an
 * ordinary line, and while holding it is one more held segment. Pure.
 */
export function isBareCut(text: string): boolean {
  const w = toks(norm(text));
  if (!w.length) return false;
  const filler = new Set([...CUT_LEAD, ...TAIL]);
  const core = w.filter((x) => !filler.has(x));
  if (!core.length) return false;
  const s = core.join(" ");
  return [...CUT, ...CUT_LEADING].includes(s) || /^(?:(?:cut it|cut that|stop)(?: (?:out|it|that|talking))?)(?: (?:stop|cut it))*$/.test(s);
}

/**
 * Whether a normal / wake / yes-no listen acts on a parsed reflex before anything else. A
 * stand-down (P5) acts in every listen — a passive one without the wake word, a yes/no one
 * (the card is rejected silently) — but never while Tony is audible (his own words could leak
 * into the mic), and never from a passive listen while Spotify is audible here (a lyric like
 * "take it easy" would switch hands-free off): then it needs the wake word or a tapped mic. A bare
 * hard stop (`needsAddress`) is special: in a passive hands-free listen it needs the wake word
 * even over a busy turn (room talk, a lyric); in a yes/no listen it stays the card's "no"
 * (parseConfirmation); and while a cue plays it is that cue's stop (handleInput), never a cut that
 * also pauses Spotify. `bare`: a passive listen that requires the wake word.
 */
export function listenTakesReflex(
  r: NonNullable<Reflex>,
  o: { forConfirmation?: boolean; bare: boolean; busy: boolean; cueActive: boolean; ttsAudible?: boolean; musicAudible?: boolean },
): boolean {
  if (r.kind === "standdown") return !o.ttsAudible && !(o.bare && o.musicAudible);
  const addressed = !r.needsAddress;
  if (!addressed && o.cueActive) return false;
  if (o.forConfirmation) return r.kind === "cut" && addressed;
  return !o.bare || (r.kind === "cut" && addressed) || (o.busy && addressed);
}
