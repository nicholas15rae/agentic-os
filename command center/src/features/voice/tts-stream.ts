/**
 * Latency pass, step 1: Tony's first sentence plays while ElevenLabs is still sending it
 * (Settings → Voice → Latency → "Stream the first sentence", `latency.streamTts`, off by default).
 *
 * Rust `tts_stream` asks ElevenLabs for 24 kHz 16-bit PCM (same voice, same model) and hands each
 * chunk over a Tauri channel as it lands. `PcmChunker` turns the bytes into float samples (a chunk
 * can split a sample), `StreamSchedule` decides when each piece starts so they play back to back,
 * and `playStream` drives a WebAudio graph with them. Whatever was streamed is kept, so a pause
 * (hold) can replay the sentence from its start like a normal one.
 *
 * Only plain roster lines stream: no cached / pinned line, no explicit voice (previews, cue clips),
 * no local-only narration, not on the phone. Rust answers `streamed: false` for anything that would
 * not reach ElevenLabs right now; the caller then speaks the line the old way.
 */
import type { SpeakOpts } from "./tts-types";

/** Wait for this much audio before the first piece starts (absorbs network jitter). */
export const START_AFTER_MS = 100;
/** Pieces shorter than this are held back and merged (fewer WebAudio nodes, no clicks). */
export const MIN_PIECE_MS = 40;
/** Scheduling lead over `currentTime` so a piece never starts in the past. */
export const LEAD_S = 0.02;

/** Does this line qualify for streaming? Pure. */
export function streamable(opts: SpeakOpts | undefined, on: boolean, android: boolean): boolean {
  if (!on || android || !opts) return false;
  return !opts.cache && !opts.localOnly && !opts.voice && !!opts.agent;
}

/** 16-bit little-endian PCM bytes → Float32 samples, carrying an odd byte across chunks. Pure. */
export class PcmChunker {
  private carry: number | null = null;
  push(bytes: Uint8Array): Float32Array {
    let b = bytes;
    if (this.carry !== null) {
      const joined = new Uint8Array(b.length + 1);
      joined[0] = this.carry;
      joined.set(b, 1);
      b = joined;
      this.carry = null;
    }
    const n = b.length >> 1;
    if (b.length & 1) this.carry = b[b.length - 1];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = b[2 * i] | (b[2 * i + 1] << 8);
      if (v >= 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }
}

/**
 * When each piece starts (pure; the clock is passed in). Samples pile up until `START_AFTER_MS`
 * (or the end of the stream), then go out in pieces of at least `MIN_PIECE_MS`, each starting
 * where the last one ends, never before `now + LEAD_S`. A late chunk (an underrun) starts at
 * `now + LEAD_S`: a short gap, never an overlap.
 */
export class StreamSchedule {
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private started = false;
  private next = 0;
  readonly all: Float32Array[] = [];
  constructor(readonly rate: number) {}

  /** Add samples; returns the pieces to start now as [startTime, samples]. */
  push(samples: Float32Array, now: number, ended = false): [number, Float32Array][] {
    if (samples.length) {
      this.pending.push(samples);
      this.pendingLen += samples.length;
      this.all.push(samples);
    }
    const minLen = Math.ceil(((this.started ? MIN_PIECE_MS : START_AFTER_MS) / 1000) * this.rate);
    if (!this.pendingLen || (!ended && this.pendingLen < minLen)) return [];
    const piece = concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    const at = Math.max(this.next, now + LEAD_S);
    this.next = at + piece.length / this.rate;
    this.started = true;
    return [[at, piece]];
  }

  /** When the last scheduled piece finishes (0 before the first). */
  get endsAt(): number {
    return this.next;
  }

  /** Everything received so far, in one piece (for a replay after a hold). */
  whole(): Float32Array {
    return concat(this.all, this.all.reduce((n, a) => n + a.length, 0));
  }
}

function concat(parts: Float32Array[], len: number): Float32Array {
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface StreamStart {
  streamed: boolean;
  sampleRate: number;
  bytes: number;
  reason: string;
}

/** What `playStream` hands back: whether it streamed, and the whole sentence once it ended. */
export interface StreamResult {
  streamed: boolean;
  /** All the audio that arrived, as one buffer (null when nothing streamed). */
  buffer: AudioBuffer | null;
  /** The stream was stopped by `stop()` (a pause / cancel) before it finished playing. */
  stopped: boolean;
}

export interface StreamHandle {
  done: Promise<StreamResult>;
  /** Stop what's playing now (pause, cancel). The stream keeps being read for a replay. */
  stop(): void;
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<StreamStart>;

/**
 * Play one sentence as it streams. `invoke` / `makeChannel` are Tauri's (passed in so this file
 * stays importable in tests). Resolves `done` once the last piece has played (or `stop()`), with
 * `streamed: false` when Rust declined, so the caller speaks it the old way.
 */
export function playStream(
  ac: AudioContext,
  out: AudioNode,
  args: { text: string; agent?: string; previousText?: string; utteranceId?: string; model?: string },
  invoke: Invoke,
  makeChannel: (onBytes: (b: ArrayBuffer) => void) => unknown,
  onFirstAudio?: () => void,
): StreamHandle {
  const chunker = new PcmChunker();
  let sched: StreamSchedule | null = null;
  const sources: AudioBufferSourceNode[] = [];
  const stopWaiters: (() => void)[] = [];
  let stopped = false;
  let first = true;
  const rate = 24000;
  const schedule = (pieces: [number, Float32Array][]) => {
    if (stopped) return;
    for (const [at, samples] of pieces) {
      const buf = ac.createBuffer(1, samples.length, rate);
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(out);
      src.start(at);
      sources.push(src);
      if (first) {
        first = false;
        onFirstAudio?.();
      }
    }
  };
  sched = new StreamSchedule(rate);
  const channel = makeChannel((b) => {
    if (!sched) return;
    schedule(sched.push(chunker.push(new Uint8Array(b)), ac.currentTime));
  });
  const done = (async (): Promise<StreamResult> => {
    const r = await invoke("tts_stream", { ...args, onChunk: channel });
    if (!r.streamed || !sched) {
      return { streamed: false, buffer: null, stopped };
    }
    schedule(sched.push(new Float32Array(0), ac.currentTime, true));
    const whole = sched.whole();
    const buffer = whole.length ? ac.createBuffer(1, whole.length, rate) : null;
    buffer?.copyToChannel(whole as Float32Array<ArrayBuffer>, 0);
    // Wait out what is still scheduled.
    const left = sched.endsAt - ac.currentTime;
    if (!stopped && left > 0) await new Promise<void>((res) => {
      setTimeout(res, left * 1000 + 30);
      stopWaiters.push(res);
    });
    return { streamed: true, buffer, stopped };
  })();
  return {
    done,
    stop() {
      stopped = true;
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* not started */
        }
      }
      stopWaiters.splice(0).forEach((f) => f());
    },
  };
}
