import { norm } from "@/features/cues/gaba";
import { isBareCut, parseReflex } from "@/features/voice/reflex-parse";
import type { TalkIntent, TalkIntentCtx, TalkReflex } from "./helper-types";

/**
 * Talk is routed first (Section 9, Brainstorm). While Talk is live only these run before a line
 * becomes a talk turn, in this order:
 *   1. a voice reflex from reflex-parse.ts, but only a cut, a hold or a stand-down ("cut it",
 *      "take it easy", "madone", …). A resume or submit ("keep going", "go ahead and text Sam",
 *      "run that build") is a talk turn: no reflex carries a command out of Talk. A bare-stop cut
 *      (needsAddress) counts only as the whole line ("stop", "Tony, stop"); "stop motion would be
 *      cool for the trailer" is thinking aloud, so a talk turn;
 *   2. an explicit, addressed "Tony, end talk";
 *   3. a whole-line wrap phrase ("wrap it up", "let's wrap up", "end and wrap up").
 * Everything else is a talk turn: Spotify / OS / dev / defer-looking lines ("play devil's
 * advocate", "what if we queue a fix", "save it for later") are talked about, never run.
 * Pure: only `norm`, `parseReflex` and `isBareCut`, all import-light.
 */

/** Whole-line wrap phrases, as `norm()` writes them ("let's" → "let s"). Never a prefix match:
 * "we should wrap up the login flow by Friday" stays a talk turn. Checked against the reflex and
 * defer tables in talk-intent.test.ts. */
export const WRAP_PHRASES: readonly string[] = [
  "wrap it up", "wrap up", "wrap this up", "wrap that up", "wrap things up", "wrap us up",
  "let s wrap up", "let s wrap it up", "let s wrap this up", "let s wrap things up",
  "lets wrap up", "lets wrap it up", "lets wrap this up",
  "let us wrap up", "let us wrap it up",
  "time to wrap up", "time to wrap it up", "time to wrap this up",
  "can we wrap up", "can we wrap it up", "can you wrap it up", "can you wrap this up",
  "we can wrap up", "we can wrap it up",
  "end and wrap up", "end and wrap it up", "end it and wrap up", "end it and wrap it up",
  "end talk and wrap up", "end the talk and wrap up", "end the session and wrap up",
  "let s end and wrap up", "let s end and wrap it up",
];

/** Explicit end-of-Talk phrases (no wrap-up). Only counted with the assistant's name in front. */
export const END_TALK_PHRASES: readonly string[] = [
  "end talk", "end talk mode", "end the talk", "end talking", "exit talk", "exit talk mode",
  "leave talk", "leave talk mode", "talk mode off", "turn off talk mode", "turn talk mode off",
];

/** Address / filler words skipped in front of a phrase. */
const LEAD = new Set(["hey", "yo", "ok", "okay", "alright", "so", "um", "uh", "yeah", "right", "cool", "well", "and", "now", "please", "tony", "jarvis"]);
const TAIL = new Set(["please", "now", "then", "tony", "jarvis", "thanks", "man", "for", "me"]);

const wrapSet = new Set(WRAP_PHRASES);
const endSet = new Set(END_TALK_PHRASES);

function nameTokens(osName: string | undefined): Set<string> {
  const n = norm(osName || "Tony");
  return new Set(["tony", "jarvis", ...(n ? [n] : [])]);
}

/** The line's words without leading address/filler and trailing politeness. `addressed`: a name was in front. */
function core(text: string, osName?: string): { words: string[]; addressed: boolean } {
  const names = nameTokens(osName);
  const w = norm(text).split(" ").filter(Boolean);
  let i = 0;
  let addressed = false;
  // "all right" is two tokens after norm.
  while (i < w.length) {
    if (w[i] === "all" && w[i + 1] === "right") { i += 2; continue; }
    if (names.has(w[i])) { addressed = true; i++; continue; }
    if (LEAD.has(w[i])) { i++; continue; }
    break;
  }
  let j = w.length;
  while (j > i && (TAIL.has(w[j - 1]) || names.has(w[j - 1]))) j--;
  return { words: w.slice(i, j), addressed };
}

export function isWrapPhrase(text: string, osName?: string): boolean {
  const c = core(text, osName).words.join(" ");
  return !!c && wrapSet.has(c);
}

export function isEndTalkPhrase(text: string, osName?: string): boolean {
  const c = core(text, osName);
  return c.addressed && endSet.has(c.words.join(" "));
}

/** The parsed reflex if Talk honours it, else null (the line stays a talk turn). */
function talkReflex(text: string, ctx: TalkIntentCtx): TalkReflex | null {
  const r = parseReflex(text, ctx);
  if (!r) return null;
  if (r.kind !== "cut" && r.kind !== "hold" && r.kind !== "standdown") return null;
  if (r.kind === "cut" && r.needsAddress && (r.rest !== "" || !isBareCut(text))) return null;
  return r as TalkReflex;
}

/** One heard line in Talk. Never returns a command: the only non-talk outcomes are the ones above
 * (and "empty" for a blank line, which the caller drops). */
export function classifyTalkLine(text: string, ctx: TalkIntentCtx): TalkIntent {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { kind: "empty" };
  const reflex = talkReflex(trimmed, ctx);
  if (reflex) return { kind: "reflex", reflex };
  if (isEndTalkPhrase(text, ctx.osName)) return { kind: "end_talk" };
  if (isWrapPhrase(text, ctx.osName)) return { kind: "wrap" };
  return { kind: "talk", text: trimmed };
}
