import type { SpeakOpts, TtsEngine } from "./tts-types";

/** Rust refused because the speaker is frozen on the master switchboard (Section 20.3). */
export const isFrozenVoice = (e: unknown): boolean => String(e instanceof Error ? e.message : e).includes("FROZEN_VOICE");

/** Primary TTS with automatic fallback to the system voice if Kokoro/ElevenLabs is
 * down. The fallback is per CALL, not a permanent switch: a transient failure (one
 * offline request, a quota blip) no longer strands the rest of the session on the
 * system voice — the next call tries the primary engine again. */
export class FallbackTts implements TtsEngine {
  readonly supported: boolean;
  constructor(private primary: TtsEngine, private backup: TtsEngine) {
    this.supported = primary.supported || backup.supported;
  }
  get name() {
    return this.primary.supported ? this.primary.name : this.backup.name;
  }
  async speak(text: string, opts?: SpeakOpts) {
    if (this.primary.supported) {
      try {
        return await this.primary.speak(text, opts);
      } catch (e) {
        // A frozen agent has no voice at all (Rust FROZEN_VOICE): silence, not the system voice.
        if (isFrozenVoice(e)) return;
        // A cue's voice that the current engine doesn't have: retry without it
        // (still the primary engine) before giving up on this one call. The retry keeps
        // the reply's `utteranceId` (P1), so it stays in the same breaker scope.
        if (opts?.voice) {
          const retry = opts.agent || opts.utteranceId ? { agent: opts.agent, utteranceId: opts.utteranceId } : undefined;
          try {
            return await this.primary.speak(text, retry);
          } catch {
            /* engine really is down — fall through to the backup for this call */
          }
        }
        console.warn("[tts] primary failed for this utterance, using system voice", e);
      }
    }
    return this.backup.speak(text);
  }
  prefetch(text: string, opts?: SpeakOpts) {
    if (this.primary.supported) this.primary.prefetch?.(text, opts);
  }
  cancel() {
    this.primary.cancel();
    this.backup.cancel();
  }
  duck(on: boolean) {
    this.primary.duck?.(on);
    this.backup.duck?.(on);
  }
  pause() {
    this.primary.pause?.();
    this.backup.pause?.();
  }
  resume() {
    this.primary.resume?.();
    this.backup.resume?.();
  }
}
