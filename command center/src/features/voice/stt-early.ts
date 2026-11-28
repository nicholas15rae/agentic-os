/**
 * Latency pass, step 2: Whisper starts in your pause (`latency.earlyStt`, off by default).
 *
 * Today the final decode starts once the end-of-turn wait is over (0.7 s of quiet), and Tony
 * waits another ~0.3-0.75 s for Whisper. Here, once you have been quiet for `EARLY_AT_MS`, the
 * clip so far is decoded right away, with exactly the call the final makes (`stt_transcribe`).
 * If the turn then ends without another word, that decode IS the final: the audio after it is
 * the quiet the VAD just measured, so the text is the same (Whisper's own VAD drops trailing
 * silence). If you speak again, it is thrown away and the next pause starts a new one. Anything
 * that doesn't line up (a different clip, a failed early decode) falls back to today's decode.
 *
 * One early decode at a time per listen. Pure apart from the `decode` it is given.
 */
import type { SpeechTick } from "./stt-partials";

/** Quiet (ms) before the early decode starts: past a word's tail, well inside the end wait. */
export const EARLY_AT_MS = 150;

interface Early {
  samples: number;
  head: Float32Array;
  tail: Float32Array;
  text: Promise<string>;
  stale: boolean;
}

const EDGE = 64;
const edges = (a: Float32Array, n: number) => ({ head: a.slice(0, Math.min(EDGE, n)), tail: a.slice(Math.max(0, n - EDGE), n) });
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export class EarlyFinal {
  private cur: Early | null = null;
  /** Early decodes started / used, for the log line and tests. */
  started = 0;
  used = 0;

  constructor(
    private readonly decode: (pcm: Float32Array, rate: number) => Promise<string>,
    private readonly atMs = EARLY_AT_MS,
  ) {}

  /** Every VAD frame while speech is open (MicCapture's `onSpeechTick`). */
  tick(t: SpeechTick): void {
    // A frame that isn't quiet: you're talking again, the early text is out of date.
    if (t.quietMs === 0) {
      if (this.cur) this.cur.stale = true;
      return;
    }
    if (t.quietMs < this.atMs || (this.cur && !this.cur.stale)) return;
    const pcm = t.audio();
    if (!pcm.length) return;
    const text = this.decode(pcm, t.rate);
    text.catch(() => undefined); // a failure only means the final decodes as today
    this.cur = { samples: pcm.length, ...edges(pcm, pcm.length), text, stale: false };
    this.started++;
  }

  /**
   * The early text for the final clip `pcm`, or null (decode it as today). Only when nobody
   * spoke since it started and `pcm` begins with exactly the audio it decoded.
   */
  take(pcm: Float32Array): Promise<string> | null {
    const e = this.cur;
    this.cur = null;
    if (!e || e.stale || pcm.length < e.samples) return null;
    const got = edges(pcm, e.samples);
    if (!same(got.head, e.head) || !same(got.tail, e.tail)) return null;
    this.used++;
    return e.text;
  }

  /** The listen ended without a final (abort / mute). */
  reset(): void {
    this.cur = null;
  }
}
