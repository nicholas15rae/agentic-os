import { utteranceShouldEnd } from "./vad-rules";

/**
 * The deterministic activation gate (Phase 2 Part B). One absolute dBFS threshold decides
 * whether a frame is speech: no adaptive floor, no hidden per-start offsets. The same level,
 * probability and threshold always give the same answer, whatever came before. Silero (when it
 * is loaded) is an extra AND condition, so a loud door slam above the gate still isn't speech.
 *
 * Pure (no browser imports): unit-tested, and shared by `MicCapture`, the threshold meter and
 * the settings migration.
 */

/** Silero must agree a frame is speech (when it is deciding)… */
export const SPEECH_PROB_ON = 0.5;
/** …and a probability this low counts as quiet. */
export const SPEECH_PROB_OFF = 0.35;
/** Quiet = this far under the gate (hysteresis, so a word's tail doesn't flap). */
export const HYSTERESIS_DB = 6;
/** Speech must hold this long before the gate opens (computed in frames from the frame length). */
export const ONSET_MS = 60;
/** The threshold range (the slider and the meter share it). */
export const ACTIVATION_DB_MIN = -70;
export const ACTIVATION_DB_MAX = -10;
export const DEFAULT_ACTIVATION_DB = -44;
export const DEFAULT_BARGE_MARGIN_DB = 6;

/** RMS (0..1) → dBFS, floored at -100 dB. */
export function dbfs(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-5));
}

export interface GateCtx {
  activationDb: number;
  bargeMarginDb: number;
  /** A listen opened over Tony (barge-in): stricter, so his own voice doesn't trip it. */
  barge?: boolean;
  /** Tony comes out of open speakers (vs a headset, which gets 2 dB less margin). */
  speakers?: boolean;
}

/** The gate for one listen, in dBFS. Replaces the old hidden -35 / -25 sensitivity offsets. */
export function thresholdFor(c: GateCtx): number {
  if (!c.barge) return c.activationDb;
  return c.activationDb + (c.speakers ? c.bargeMarginDb : Math.max(0, c.bargeMarginDb - 2));
}

export const isSpeechFrame = (levelDb: number, prob: number | null, thrDb: number): boolean => levelDb >= thrDb && (prob === null || prob >= SPEECH_PROB_ON);

export const isQuietFrame = (levelDb: number, prob: number | null, thrDb: number): boolean => levelDb < thrDb - HYSTERESIS_DB || (prob !== null && prob < SPEECH_PROB_OFF);

/**
 * Under the gate but inside the hysteresis band (and Silero, when deciding, doesn't call it
 * speech). A soft word tail lives here briefly; steady room noise just under the gate lives here
 * forever. So band time also ends an utterance, only later: after `endSilenceMs + BAND_GRACE_MS`.
 */
export const isBelowGateFrame = (levelDb: number, prob: number | null, thrDb: number): boolean => levelDb < thrDb && (prob === null || prob < SPEECH_PROB_ON);
/** Extra quiet a below-the-gate band needs (vs a clear pause) before it ends the utterance. */
export const BAND_GRACE_MS = 1000;

/**
 * Latency pass, step 3 (`latency.smartEnd`): a pause may end the turn after the shorter
 * `fastEndMs` only if Silero decided every frame of it and called each one clearly silent
 * (probability at or under this). A breath, an "mmm", a trailing vowel or a frame Silero didn't
 * judge makes it a soft pause, which waits the full `endSilenceMs` like today.
 */
export const DEEP_QUIET_PROB = 0.15;
/** The shorter wait's range (Settings → Voice detection → Latency). */
export const FAST_END_MIN_MS = 300;
export const FAST_END_DEFAULT_MS = 500;

/** The shorter wait in effect: clamped to [FAST_END_MIN_MS, endSilenceMs]; null = off. Pure. */
export function fastEndFor(on: boolean | undefined, ms: unknown, endSilenceMs: number): number | null {
  if (!on || !Number.isFinite(endSilenceMs)) return null;
  const v = typeof ms === "number" && Number.isFinite(ms) ? ms : FAST_END_DEFAULT_MS;
  return Math.round(Math.min(endSilenceMs, Math.max(FAST_END_MIN_MS, v)));
}

/** Settings v7 migration: the old 0–100 sensitivity → an absolute gate (60 → -44 dB). */
export function migrateSensitivity(sensitivity: number): number {
  const s = Number.isFinite(sensitivity) ? sensitivity : 60;
  return Math.max(ACTIVATION_DB_MIN, Math.min(ACTIVATION_DB_MAX, Math.round(-20 - 0.4 * s)));
}

export type GateEvent = "start" | "end" | null;

/**
 * Speech state machine over fixed-length frames. `start` once speech has held for ONSET_MS;
 * `end` once it has been quiet for `endSilenceMs`, or the utterance hit `maxUtteranceMs`
 * (`Infinity` disables either, see `utteranceShouldEnd`). Time is counted in frames, so the
 * result never depends on wall-clock jitter.
 */
export class Gate {
  readonly onsetFrames: number;
  speaking = false;
  private run = 0;
  private quietMs = 0;
  private belowMs = 0;
  private speechMs = 0;
  /** This pause had a frame that wasn't clearly silent to Silero (see DEEP_QUIET_PROB). */
  private softPause = false;
  /** Why the last `end` fired (tests, the log): the shorter wait, or the usual one. */
  endedFast = false;

  constructor(
    private readonly frameMs: number,
    private readonly endSilenceMs: number,
    private readonly maxUtteranceMs: number,
    private readonly fastEndMs: number | null = null,
  ) {
    this.onsetFrames = Math.max(1, Math.ceil(ONSET_MS / frameMs - 1e-9));
  }

  push(levelDb: number, prob: number | null, thrDb: number): GateEvent {
    if (!this.speaking) {
      this.run = isSpeechFrame(levelDb, prob, thrDb) ? this.run + 1 : 0;
      if (this.run < this.onsetFrames) return null;
      this.speaking = true;
      this.quietMs = 0;
      this.belowMs = 0;
      this.speechMs = 0;
      return "start";
    }
    this.speechMs += this.frameMs;
    const quiet = isQuietFrame(levelDb, prob, thrDb);
    if (!quiet || this.quietMs === 0) this.softPause = false;
    if (quiet && (prob === null || prob > DEEP_QUIET_PROB)) this.softPause = true;
    this.quietMs = quiet ? this.quietMs + this.frameMs : 0;
    const fast = this.fastEndMs !== null && quiet && !this.softPause && this.quietMs >= this.fastEndMs;
    this.belowMs = quiet || isBelowGateFrame(levelDb, prob, thrDb) ? this.belowMs + this.frameMs : 0;
    const bandEnded = this.belowMs >= this.endSilenceMs + BAND_GRACE_MS;
    if (!fast && !bandEnded && !utteranceShouldEnd(this.quietMs, this.endSilenceMs, this.speechMs, this.maxUtteranceMs)) return null;
    this.endedFast = fast && this.quietMs < this.endSilenceMs;
    this.speaking = false;
    this.run = 0;
    return "end";
  }
}
