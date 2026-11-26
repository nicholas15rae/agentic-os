/**
 * TTS engine contract, split out from `engines.ts` so it can be imported
 * (type-only or otherwise) without pulling in `engines.ts`'s browser-only
 * code — notably `silero.ts`, which touches `location` at module-eval time
 * and crashes under Vitest's node environment (same reason Part 5 split
 * `listen-profiles.ts`/`vad-rules.ts` out of `capture.ts`).
 */

/** `voice` overrides the configured voice (cue widgets); engines without voices ignore it.
 * `agent` (Part 3) names who's speaking ("general" = Tony) so a per-agent voice-roster
 * entry can be used server-side when `voice` itself isn't given. `previousText` (Part 6
 * §2) is the sentence spoken right before this one in the same reply — engines that
 * synthesize sentence-by-sentence pass it per-call for ElevenLabs prosody continuity;
 * engines/providers that don't support it simply ignore it. */
export interface SpeakOpts {
  voice?: string;
  agent?: string;
  previousText?: string;
  /** Keep this line's audio for the session (Phase 2 §4: Tony's per-agent intro lines), so
   * repeats cost no synthesis call or wait. Engines without a cache ignore it. */
  cache?: boolean;
  /** P1: the reply this line belongs to — the scope of Rust's ElevenLabs circuit breaker
   * (one failure sends the rest of the reply to local TTS, with one notice). Every
   * `prefetch`/`speak` pair of one reply must pass the same id. NOT part of the prefetch
   * cache key, and never sent for `cache: true` lines (they use Rust's per-call path, so a
   * breaker cooldown can't pin local audio for an intro). `speak()` mints one if missing. */
  utteranceId?: string;
  /** Part 6 narration with `feedback.narrationEngine: "kokoro"`: synthesize on the local engine in
   * this agent's own local voice (spares the ElevenLabs quota). Part of the cache key. */
  localOnly?: boolean;
  /** Agent reports: the ElevenLabs model for this line ("eleven_turbo_v2_5"), over the roster row's. */
  model?: string;
}

export interface TtsEngine {
  readonly name: string;
  readonly supported: boolean;
  speak(text: string, opts?: SpeakOpts): Promise<void>;
  /** Start synthesizing now so a later speak() of the same text plays without a gap. */
  prefetch?(text: string, opts?: SpeakOpts): void;
  cancel(): void;
  /** Phase 2 barge-in: drop to ~15 % while the user talks over the reply (engines that can't duck pause). */
  duck?(on: boolean): void;
  /** Phase 2 hold: stop where we are but keep the reply; a speak() started while paused waits. */
  pause?(): void;
  /** Continue from the start of the interrupted sentence. */
  resume?(): void;
}
