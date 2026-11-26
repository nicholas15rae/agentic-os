/**
 * Live partial transcripts ("make it stream", C1). While the VAD hears you, the clip so far is
 * decoded every `vad.partialMs` (~600 ms) and shown as a caption; the FINAL transcript is still one
 * full-clip decode at the end of speech, so accuracy is unchanged.
 *
 *   Desktop: `PartialLoop` → Rust `stt_partial` (single-flight per capture, 3 s timeout, the mic
 *            gate; it answers `off` unless the STT's /health says `device: "cuda"`).
 *   Phone:   `stt-stream.ts` streams PCM16 to the gateway's WebSocket, which runs the same
 *            schedule server-side and answers {partial, stable} and the {final}.
 *
 * Everything here is pure (or takes its I/O as a parameter) so it runs under Vitest.
 */

/** `vad.partialMs` default; 0 turns live captions (and the phone's stream) off. */
export const DEFAULT_PARTIAL_MS = 600;
export const PARTIAL_MIN_MS = 300;
export const PARTIAL_MAX_MS = 3000;
/** No captions past one Whisper window of speech (a longer pass is slow); the final covers it all. */
export const PARTIAL_MAX_SPEECH_MS = 28_000;
/** No new caption once you've been quiet this long: the end of speech (700 ms) is near and the
 * final needs the GPU. One that started before finishes well before the final starts. */
export const PARTIAL_QUIET_MS = 250;

/** The setting → spacing in ms (0 = off). Missing / not a number = the default. Pure. */
export function partialMsFrom(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PARTIAL_MS;
  if (v <= 0) return 0;
  return Math.round(Math.min(PARTIAL_MAX_MS, Math.max(PARTIAL_MIN_MS, v)));
}

/** Tony's reply is being generated (thinking, or a "streaming…" bubble still growing): his model
 * has the GPU then, and a caption pass would slow both. A bubble older than 2 min never counts (a
 * stuck one must not switch captions off for good). Pure. */
export function replyStreaming(s: { state: string; turns: readonly { meta?: string; at: number }[] }, now = Date.now()): boolean {
  if (s.state === "thinking") return true;
  return s.turns.slice(-6).some((t) => t.meta === "streaming…" && now - t.at < 120_000);
}

const normWord = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

export interface Agreed {
  /** What to show: the stable words, then the newest hypothesis's tentative rest. */
  text: string;
  stable: string;
  tentative: string;
}

/**
 * LocalAgreement-2 over whole-clip hypotheses: the words the last two hypotheses agree on, from the
 * start, are committed (stable) and never retracted; the rest of the newest is tentative. Words
 * compare case- and edge-punctuation-insensitively. Same rule as fw_server.LocalAgreement and the
 * gateway's (language_hub_api.py), so the phone and the desktop caption alike.
 */
export class LocalAgreement {
  private prev: string[] = [];
  private committed: string[] = [];

  push(hypothesis: string): Agreed {
    const cur = hypothesis.split(/\s+/).filter(Boolean);
    const c = this.committed.length;
    if (cur.length >= c && this.committed.every((w, i) => normWord(w) === normWord(cur[i]))) {
      let n = c;
      while (n < Math.min(this.prev.length, cur.length) && normWord(this.prev[n]) === normWord(cur[n])) n++;
      this.committed.push(...cur.slice(c, n));
    }
    this.prev = cur;
    const rest = cur.slice(this.committed.length);
    const stable = this.committed.join(" ");
    const tentative = rest.join(" ");
    return { text: [stable, tentative].filter(Boolean).join(" "), stable, tentative };
  }
}

/**
 * Float32 mic frames → 16 kHz PCM16, incrementally, sample-for-sample what `encodeWav16k` makes of
 * the same audio in one piece (box-filter decimation over the concatenated stream), so a streamed
 * clip decodes exactly like the uploaded WAV.
 */
export class Pcm16Stream {
  private readonly ratio: number;
  /** Output samples made so far. */
  private i = 0;
  /** Input samples not yet fully used, starting at absolute input index `base`. */
  private rest = new Float32Array(0);
  private base = 0;

  constructor(inRate: number) {
    this.ratio = inRate / 16000;
  }

  push(pcm: Float32Array): Int16Array {
    const buf = new Float32Array(this.rest.length + pcm.length);
    buf.set(this.rest);
    buf.set(pcm, this.rest.length);
    const end = this.base + buf.length;
    const out: number[] = [];
    for (;;) {
      const a = Math.floor(this.i * this.ratio), b = Math.floor((this.i + 1) * this.ratio);
      if (b > end) break;
      let s = 0;
      for (let j = a; j < b; j++) s += buf[j - this.base];
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
      out.push(v < 0 ? v * 0x8000 : v * 0x7fff);
      this.i++;
    }
    const keep = Math.floor(this.i * this.ratio);
    this.rest = buf.slice(keep - this.base);
    this.base = keep;
    return Int16Array.from(out);
  }
}

export interface PartialReply {
  text: string;
  stale?: boolean;
  off?: boolean;
  busy?: boolean;
}

/** One frame of the speech so far, as MicCapture reports it while the VAD hears speech. */
export interface SpeechTick {
  /** Speech so far (from the onset), in ms of audio. */
  speechMs: number;
  /** The current run of quiet frames, in ms. */
  quietMs: number;
  rate: number;
  /** The audio from the onset (pre-roll included); built only when a caption is due. */
  audio: () => Float32Array;
}

export interface PartialLoopOpts {
  everyMs: number;
  capture: string;
  send: (wav: Uint8Array, capture: string) => Promise<PartialReply>;
  encode: (pcm: Float32Array, rate: number) => Uint8Array;
  onPartial: (text: string, stable: string) => void;
  /** Skip (without using up the slot) while true: Tony's reply streaming. */
  paused: () => boolean;
  /** The mic gate. */
  allowed: () => boolean;
}

/**
 * The desktop's caption schedule for one capture: every `everyMs` of speech, one request at a time
 * (single-flight), none in a trailing pause, none past `PARTIAL_MAX_SPEECH_MS`. Off for the rest of
 * the capture when the server says `off` (not on a GPU) or after two failures. `close()` (the final
 * is starting) drops any caption still on its way.
 */
export class PartialLoop {
  /** Speech (ms) at which the next caption is due: the first after `everyMs` of speech. */
  private next: number;
  private inFlight = false;
  private off = false;
  private fails = 0;
  private closed = false;
  private readonly la = new LocalAgreement();

  constructor(private readonly o: PartialLoopOpts) {
    this.next = o.everyMs;
  }

  get disabled(): boolean {
    return this.off || this.closed;
  }

  tick(t: SpeechTick): void {
    if (this.off || this.closed || this.inFlight || this.o.everyMs <= 0) return;
    if (t.speechMs >= PARTIAL_MAX_SPEECH_MS) {
      this.off = true;
      return;
    }
    if (t.speechMs < this.next || t.quietMs > PARTIAL_QUIET_MS || !this.o.allowed() || this.o.paused()) return;
    this.next = t.speechMs + this.o.everyMs;
    this.inFlight = true;
    let wav: Uint8Array;
    try {
      wav = this.o.encode(t.audio(), t.rate);
    } catch {
      this.inFlight = false;
      return;
    }
    this.o
      .send(wav, this.o.capture)
      .then(
        (reply) => {
          this.fails = 0;
          const r: Partial<PartialReply> = reply ?? {};
          if (r.off) this.off = true;
          if (this.closed || r.off || r.stale || r.busy || typeof r.text !== "string" || !r.text) return;
          const v = this.la.push(r.text);
          if (v.text) this.o.onPartial(v.text, v.stable);
        },
        () => {
          if (++this.fails >= 2) this.off = true;
        },
      )
      .finally(() => {
        this.inFlight = false;
      });
  }

  close(): void {
    this.closed = true;
  }
}

let captureSeq = 0;
/** A capture id for `stt_partial`'s single-flight (letters, digits and `-` only). */
export const newCaptureId = (): string => `cap-${Date.now().toString(36)}-${(++captureSeq).toString(36)}`;

/** Desktop: one caption through Rust (`voice.rs stt_partial`), the WAV as the raw IPC body. */
export async function sttPartial(wav: Uint8Array, capture: string): Promise<PartialReply> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PartialReply>("stt_partial", wav, { headers: { "x-capture": capture } });
}
