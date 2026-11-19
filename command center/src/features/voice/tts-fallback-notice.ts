/**
 * P1: the one compact amber line a `tts-fallback` event becomes (pure, node-testable —
 * `voice-controller.ts` only pushes what this returns).
 *
 * Rust already emits at most one event per reply / cooldown window / (no id) reason per
 * 10 s; this is the webview's own guard on top, so a re-emit (a race between concurrent
 * sentences, a preview-started cooldown announced by a live skip, an older Rust build)
 * still yields ONE line. `seen` maps a dedupe key to the time it stops suppressing.
 */
import type { TtsFallbackEvent } from "@/lib/platform";

/** No-id events: one notice per `reason` within this window (matches Rust's EMIT_DEDUPE). */
export const NOTICE_REASON_WINDOW_MS = 10_000;
/** One reply never runs longer than this; matches Rust's breaker TTL. */
export const NOTICE_UTTERANCE_TTL_MS = 5 * 60_000;
/** Cap on `seen` (expired entries go first, then the soonest-expiring). */
export const NOTICE_SEEN_CAP = 64;
/** Hard cap on the notice text. */
export const NOTICE_MAX_CHARS = 90;

/** "kokoro" / "kokoro-local" → "Kokoro"; anything unrecognised → "local voice". */
function engineLabel(to: string): string {
  if (/kokoro/i.test(to)) return "Kokoro";
  if (/xtts/i.test(to)) return "XTTS";
  if (/piper/i.test(to)) return "Piper";
  return "local voice";
}

/** "HTTP 429", or for a transport failure (no status) Rust's short reason, clipped. */
function codeOf(e: TtsFallbackEvent): string {
  if (typeof e.status === "number") return `HTTP ${e.status}`;
  const r = (e.reason || "").replace(/^ElevenLabs\s+/i, "").trim();
  return r.length > 24 ? `${r.slice(0, 23)}…` : r || "failed";
}

function prune(seen: Map<string, number>, now: number) {
  for (const [k, until] of seen) if (until <= now) seen.delete(k);
  if (seen.size <= NOTICE_SEEN_CAP) return;
  const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  for (const [k] of oldest.slice(0, seen.size - NOTICE_SEEN_CAP)) seen.delete(k);
}

const suppressed = (seen: Map<string, number>, key: string, now: number) => (seen.get(key) ?? 0) > now;

/** The dedupe key of a cooldown notice: the global 429 pause is one key; a 402 pause is
 * per voice (Rust's opaque `cooldownKey` tag), so a second voice's pause gets its own line.
 * (An event without the tag keeps the old single per-voice key.) */
function cooldownKeyOf(e: TtsFallbackEvent): string {
  if (e.scope === "global") return "cd:global";
  return e.cooldownKey ? `cd:voice:${e.cooldownKey}` : "cd:voice";
}

/** The notice for one `tts-fallback` event, or null when this fallback was already
 * announced. Dedupes per `utteranceId`, per cooldown window (402 per voice / 429 global),
 * and — per call (no id, or a 404 / 5xx that didn't trip the reply) — per `reason` within
 * 10 s. Mutates `seen`. */
export function fallbackNotice(e: TtsFallbackEvent, seen: Map<string, number>, now: number): string | null {
  prune(seen, now);
  const to = engineLabel(e.to);
  const code = codeOf(e);
  // A "call" notice (a 404 / 5xx: this one sentence fell back, the next tries ElevenLabs
  // again) is never "for this reply" and doesn't use up the reply's one line.
  const perCall = e.scope === "call";
  const utt = perCall ? null : e.utteranceId || null;
  const cooldown = (e.scope === "global" || e.scope === "voice") && typeof e.cooldownSecs === "number" && e.cooldownSecs > 0;

  let key: string;
  let until: number;
  let text: string;
  if (cooldown) {
    const secs = Math.round(e.cooldownSecs as number);
    key = cooldownKeyOf(e);
    until = now + secs * 1000;
    text = e.scope === "voice" ? `ElevenLabs voice paused ${secs} s (${code}), speaking with ${to}` : `ElevenLabs paused ${secs} s (${code}), speaking with ${to}`;
  } else if (utt) {
    key = `u:${utt}`;
    until = now + NOTICE_UTTERANCE_TTL_MS;
    text = `Voice → ${to} for this reply (ElevenLabs ${code})`;
  } else {
    key = `r:${e.reason}`;
    until = now + NOTICE_REASON_WINDOW_MS;
    text = `Voice → ${to} for this line (ElevenLabs ${code})`;
  }
  // A reply already announced (by its own trip or by a cooldown notice) stays one line.
  if (suppressed(seen, key, now) || (utt && suppressed(seen, `u:${utt}`, now))) return null;
  // Inside an announced global pause, the replies it skips need no line of their own. (A
  // per-voice pause doesn't cover other voices, so their own failures still get a line.)
  if (!cooldown && suppressed(seen, "cd:global", now)) {
    if (utt) seen.set(`u:${utt}`, now + NOTICE_UTTERANCE_TTL_MS);
    return null;
  }
  seen.set(key, until);
  if (utt) seen.set(`u:${utt}`, now + NOTICE_UTTERANCE_TTL_MS);
  prune(seen, now);
  return text.length > NOTICE_MAX_CHARS ? `${text.slice(0, NOTICE_MAX_CHARS - 1)}…` : text;
}
