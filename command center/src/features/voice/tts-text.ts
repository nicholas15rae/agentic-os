/**
 * Pure text transforms applied before anything reaches a TTS engine. Split
 * out of `engines.ts` (same reason as `tts-types.ts`: no browser-only
 * imports, so these are unit-testable under Vitest's node environment).
 */

import type { SpeakOpts } from "./tts-types";

/** Internal label words a model sometimes prints in front of what it means to say ("Spoken
 * reply:", "Voice summary -", "Tony:"). Never part of the reply: live test 11-27 read "Spoken reply"
 * aloud. */
const LABEL_WORDS = String.raw`spoken[ _-]?(?:reply|response|text|line)?|voice[ _-]?(?:reply|summary|response|line)|tts(?:[ _-]?text)?|reply|response|answer|output|assistant|tony|internal(?:[ _-]?note)?|note to self|final answer`;
/** A label at the start of the text, a line or a sentence, with its colon / dash (and any bold or
 * brackets around it): "**Spoken reply:** Hey Nic" → "Hey Nic". Mid-sentence words stay ("my reply: no"). */
const LEADING_LABEL = new RegExp(String.raw`(^|[\n.!?]["')\]]*[ \t]*)(?:\*\*|__)?[\[(<]?[ \t]*(?:${LABEL_WORDS})[ \t]*[\])>]?(?:\*\*|__)?(?:[ \t]*[:：]|[ \t]+[—–-])[ \t]*(?:\*\*|__)?[ \t]*`, "gi");
/** A bracketed or tag-shaped label anywhere: "[Spoken reply]", "(internal)", "<spoken_reply>", "</tts>". */
const TAG_LABEL = new RegExp(String.raw`[\[(<][ \t]*\/?[ \t]*(?:${LABEL_WORDS})[ \t]*[\])>]`, "gi");

/** Drop internal labels and tags before speech. Exported for tests. */
export function stripLabels(text: string): string {
  return text.replace(TAG_LABEL, " ").replace(LEADING_LABEL, "$1");
}

/** Strip internal labels, markdown, code fences and emoji before anything is spoken — none of it
 * should ever be read aloud ("asterisk asterisk bold asterisk asterisk", "Spoken reply"). */
export function stripForSpeech(text: string): string {
  return stripLabels(text)
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1") // links → link text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, "") // numbered-list markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)([^*_]+)\1/g, "$2") // italics
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    // Emoji & pictographs (leaves plain punctuation/symbols alone).
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** A single clause/sentence over `maxChars` is split on word boundaries — used so one
 * chunk never grows unboundedly (Rust rejects TTS text over 2000 characters). */
function splitLong(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > maxChars) {
    const cut = rest.lastIndexOf(" ", maxChars);
    const at = cut > 0 ? cut : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export const LIST_LINE = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/** True when most non-blank lines are bulleted/numbered (a WhatsApp casting summary,
 * a checklist) rather than ordinary prose split across lines. */
export function looksLikeList(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const marked = lines.filter((l) => LIST_LINE.test(l)).length;
  return marked >= 2 && marked / lines.length >= 0.5;
}

const TERMINAL = /[.!?…:;,]["')\]]*$/;

/** One line of speech per list line: a bullet without its own punctuation gets a period
 * so it doesn't run into the next one when read aloud. */
function joinListLines(clean: string): string {
  return clean
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((l) => (TERMINAL.test(l) ? l : `${l}.`))
    .join(" ");
}

/** Split for pipelining: speak sentence 1 while sentence 2 synthesises. Each chunk is
 * capped at `maxChars` (never dumped, unbounded, into a final chunk the way the old
 * count-based cap did past its 6th chunk). A chunk under 40 characters keeps absorbing
 * the sentences right after it (bounded by `maxChars`) until it's no longer short, so a
 * one-word sentence like "Ok." merges into what follows instead of its own round trip.
 *
 * A bulleted/numbered reply is the one exception: splitting on sentence-ending
 * punctuation there means one TTS request per bullet (each line usually ends with a
 * period of its own), stacking a full round trip's latency per line for what should
 * read as one list. Those are kept as a single chunk instead (still safety-capped at
 * `maxChars` via `splitLong`, same as any other long chunk). */
export function sentences(text: string, maxChars = 1800): string[] {
  const clean = stripForSpeech(text);
  if (looksLikeList(text)) return splitLong(joinListLines(clean), maxChars);
  const parts = clean.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) ?? [clean];
  const out: string[] = [];
  for (const raw of parts.map((s) => s.trim()).filter(Boolean)) {
    for (const p of splitLong(raw, maxChars)) {
      const prev = out.length ? out[out.length - 1] : undefined;
      if (prev !== undefined && prev.length < 40 && prev.length + 1 + p.length <= maxChars) out[out.length - 1] = `${prev} ${p}`;
      else out.push(p);
    }
  }
  return out;
}

/** Streamed-reply chunking: the next piece of `buffered` (past `spokenUpTo`) worth sending
 * to TTS on its own, or null to keep waiting. The first chunk is the first clause of 20+
 * chars (a comma is enough) so the first audio renders fast; after that, whole sentences
 * of 40+ chars. Once any streamed line is a list line it returns null for good: the rest of
 * the reply is spoken at end of stream as one `sentences()` call, so a list isn't split
 * into one TTS round trip per bullet. `end` is the new `spokenUpTo`. */
export function nextStreamChunk(buffered: string, spokenUpTo: number): { chunk: string; end: number } | null {
  if (buffered.split("\n").some((l) => LIST_LINE.test(l))) return null;
  const pending = buffered.slice(spokenUpTo);
  const lead = /^\s*/.exec(pending)![0].length;
  const m = (spokenUpTo === 0 ? /^[\s\S]{20,}?[.!?…,;:](?=\s)/ : /^[\s\S]{40,}?[.!?…](?=\s)/).exec(pending.slice(lead));
  return m ? { chunk: m[0].trim(), end: spokenUpTo + lead + m[0].length } : null;
}

// ── P1: per-sentence TTS opts and the IPC args they become ───────────────────

/** `sentences(text)` with each one's own opts, chaining `previousText` from the sentence
 * right before it (the caller's own `opts.previousText`, if any, only applies to the
 * first) — ElevenLabs prosody continuity (Part 6 §2). Every other opt, including the
 * reply's `utteranceId` (the breaker scope), reaches every sentence unchanged. */
export function perSentenceOpts(text: string, opts?: SpeakOpts): { s: string; opts: SpeakOpts }[] {
  let prev = opts?.previousText;
  return sentences(text).map((s) => {
    const sOpts: SpeakOpts = { ...opts, previousText: prev };
    prev = s;
    return { s, opts: sOpts };
  });
}

/** The `tts_synthesize` args for one sentence. A `cache: true` line (intros, acks, the
 * greeting) sends neither `previousText` nor `utteranceId`: it is kept for the session, so
 * it must not be rendered under a reply's breaker. It sends its `pinId` instead: when Rust
 * answers it with a local engine (a cooldown, a failure, the kill switch) it emits
 * `tts-unpin` and the cache drops it (`tts-pin.ts`), so local audio is never pinned. */
export function synthArgs(s: string, opts?: SpeakOpts, pinId?: string): { text: string; voice?: string; agent?: string; previousText?: string; utteranceId?: string; pinId?: string; localOnly?: boolean; model?: string } {
  // `localOnly` only when set, so every other line's args stay exactly as before.
  const local = { ...(opts?.localOnly ? { localOnly: true } : {}), ...(opts?.model ? { model: opts.model } : {}) };
  if (opts?.cache) return pinId ? { text: s, voice: opts.voice, agent: opts.agent, pinId, ...local } : { text: s, voice: opts.voice, agent: opts.agent, ...local };
  return { text: s, voice: opts?.voice, agent: opts?.agent, previousText: opts?.previousText, utteranceId: opts?.utteranceId, ...local };
}

/** The breaker scope for one agent's part of one `osRun` turn: `${streamId}-${agent}`, so a
 * handoff's second voice gets its own breaker. Clipped to Rust's rule (1–64 chars of
 * `[A-Za-z0-9-]`; anything else is replaced) so it is never silently ignored. */
export function utteranceIdFor(streamId: string, agent: string): string {
  return `${streamId}-${agent}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);
}
