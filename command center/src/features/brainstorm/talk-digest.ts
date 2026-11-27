import type { NoteSegment } from "./session-types";
import type { TalkDigestOptions } from "./helper-types";

/**
 * The talk digest (TalkTurn.digest): Nic's earlier lines in this session, neutralised and bounded,
 * for the turn context of a talk turn. Pure and deterministic: the same segments give the same
 * string, byte for byte (the prompt-cache tests rely on that).
 *
 *  - Nic's lines only. Tony's replies are left out (they are already in the talk thread), and so
 *    is a legacy unlabelled line that starts "Tony:" / "<osName>:".
 *  - Neutralised: control, zero-width and bidi characters out; characters that could pose as
 *    prompt structure (< > ` { } [ ] |) become spaces; a leading role label ("Nic:", "You:",
 *    "System:", "Assistant:", "User:", "Tony:", "<osName>:") is dropped, so a Nic line never
 *    reads as the assistant's; each line is one line.
 *  - Bounded: at most TALK_DIGEST_MAX (1500) characters in all, each line at most
 *    TALK_DIGEST_LINE_MAX (240). The NEWEST lines are kept; when older ones are dropped the
 *    digest starts with "…". A line too long is cut at a word boundary and ends with "…".
 */

export const TALK_DIGEST_MAX = 1500;
export const TALK_DIGEST_LINE_MAX = 240;
const OMITTED = "…";

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const STRUCTURAL = /[<>`{}[\]|]/g;
const ROLE_NAMES = ["nic", "you", "user", "system", "assistant", "human", "tony"];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A leading role label, the assistant's names included ("Tony:", "<osName>:"). */
function roleLabel(osName: string): RegExp {
  const names = [...ROLE_NAMES, osName.trim().toLowerCase()].filter(Boolean).map(escape);
  return new RegExp(String.raw`^\s*(?:${names.join("|")})\s*[:\-–—]\s*`, "i");
}

function isTonyLabelled(text: string, osName: string): boolean {
  const names = ["tony", osName.trim().toLowerCase()].filter(Boolean).map(escape);
  return new RegExp(String.raw`^\s*(?:${names.join("|")})\s*[:\-–—]`, "i").test(text);
}

/** One digest line: neutral, single-line, capped. Empty when nothing is left. */
export function neutraliseLine(text: string, cap = TALK_DIGEST_LINE_MAX, osName = "Tony"): string {
  const ROLE = roleLabel(osName || "Tony");
  let s = String(text ?? "").normalize("NFKC").replace(INVISIBLE, " ").replace(STRUCTURAL, " ");
  for (let k = 0; k < 3 && ROLE.test(s); k++) s = s.replace(ROLE, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= cap) return s;
  const cut = s.slice(0, cap - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > cap / 2 ? cut.slice(0, sp) : cut).trimEnd()}${OMITTED}`;
}

export function buildTalkDigest(segments: readonly NoteSegment[], opts: TalkDigestOptions = {}): string {
  const osName = opts.osName || "Tony";
  const lines: string[] = [];
  // Stable order by time (the note keeps them sorted; a copy guards a legacy unsorted one).
  const segs = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s && typeof s.text === "string" && Number.isFinite(s.t))
    .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
    .map(({ s }) => s);
  for (const s of segs) {
    if (opts.beforeT !== undefined && !(s.t < opts.beforeT)) continue;
    if (s.speaker === "tony") continue;
    if (s.speaker === undefined && isTonyLabelled(s.text, osName)) continue;
    const line = neutraliseLine(s.text, TALK_DIGEST_LINE_MAX, osName);
    if (line) lines.push(line);
  }
  // Newest first until the cap; "\n" between lines counts.
  const kept: string[] = [];
  let used = 0;
  for (let k = lines.length - 1; k >= 0; k--) {
    const cost = lines[k].length + (kept.length ? 1 : 0);
    const reserve = k > 0 ? OMITTED.length + 1 : 0; // room for the "…" line if older ones would be dropped
    if (used + cost + reserve > TALK_DIGEST_MAX) break;
    kept.unshift(lines[k]);
    used += cost;
  }
  const out = (kept.length < lines.length ? [OMITTED, ...kept] : kept).join("\n");
  return out.length <= TALK_DIGEST_MAX ? out : out.slice(out.length - TALK_DIGEST_MAX);
}
