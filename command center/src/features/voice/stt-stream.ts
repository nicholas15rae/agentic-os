/**
 * The phone's live STT (C1 phase 2): while you speak, the mic audio goes to the gateway's
 * WebSocket `/api/cc/lang/stt/stream` as 16 kHz PCM16 (~100 ms per message); captions come back
 * as {partial, stable}; at the end of speech the gateway answers {final}, decoded from audio it
 * already has, so the turn no longer waits for a WAV upload over NetBird. Anything that goes
 * wrong (no socket, an error message, a close, a slow final) makes `finish()` reject, and the
 * caller sends today's single upload instead (`WhisperStt.transcribe`).
 *
 * The token goes in the start message, never in the URL. A mute aborts the stream at once.
 */
import { onMicChange } from "./mic-gate";
import { Pcm16Stream } from "./stt-partials";

/** What `PhoneSttStream` needs of a WebSocket (tests pass a fake). */
export interface SocketLike {
  binaryType: BinaryType;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export interface PhoneStreamOpts {
  /** `streamUrl(gatewayUrl)`. */
  url: string;
  /** Read when the socket opens (Android keeps it in the secure store, loaded at launch). */
  token: () => string;
  /** The mic's sample rate (the stream resamples to 16 kHz exactly like encodeWav16k). */
  inRate: number;
  partials: boolean;
  partialMs: number;
  onPartial: (text: string, stable: string) => void;
  socket?: (url: string) => SocketLike;
  /** No open socket after this long = broken (default 3 s). */
  connectMs?: number;
}

/** 100 ms of 16 kHz audio per WebSocket message. */
const BATCH_SAMPLES = 1600;

/** The gateway URL → its stream endpoint (https → wss); null for anything else. Pure. */
export function streamUrl(gatewayUrl: string): string | null {
  try {
    const u = new URL(gatewayUrl.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/api/cc/lang/stt/stream";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** How long to wait for the final before falling back to the upload: the decode grows with the clip. Pure. */
export const streamFinalMs = (audioSecs: number): number => 6000 + Math.max(0, audioSecs) * 500;

export class PhoneSttStream {
  private ws: SocketLike | null = null;
  private readonly pcm: Pcm16Stream;
  private batch: Int16Array[] = [];
  private batchLen = 0;
  /** Messages queued until the socket opens (the start message first). */
  private queue: (string | ArrayBuffer)[] = [];
  private open = false;
  private ended = false;
  private partialsOn: boolean;
  private finalText: string | null = null;
  private waiter: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private unmute: (() => void) | null = null;
  private why = "";
  /** Failed (or aborted): `finish()` rejects at once and the caller uploads. */
  broken = false;

  constructor(private readonly o: PhoneStreamOpts) {
    this.partialsOn = o.partials;
    this.pcm = new Pcm16Stream(o.inRate);
    let ws: SocketLike;
    try {
      ws = (o.socket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(o.url);
    } catch {
      this.broken = true;
      this.why = "no socket";
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.broken) return;
      this.open = true;
      const token = this.o.token();
      ws.send(JSON.stringify({ type: "start", lang: "en", partials: this.partialsOn, partial_ms: this.o.partialMs, ...(token ? { token } : {}) }));
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onerror = () => this.fail("socket error");
    ws.onclose = () => this.fail("closed");
    this.timers.push(setTimeout(() => !this.open && this.fail("connect timeout"), o.connectMs ?? 3000));
    this.unmute = onMicChange((on) => {
      if (!on) this.abort();
    });
  }

  /** One mic frame (any length, the mic's own rate). */
  push(frame: Float32Array): void {
    if (this.broken || this.ended) return;
    const out = this.pcm.push(frame);
    if (out.length) {
      this.batch.push(out);
      this.batchLen += out.length;
    }
    if (this.batchLen >= BATCH_SAMPLES) this.flush();
  }

  /** Pause / resume captions (Tony's reply streaming, a trailing pause). Sent only on a change. */
  setPartials(on: boolean): void {
    if (on === this.partialsOn || this.broken || this.ended) return;
    this.partialsOn = on;
    this.send(JSON.stringify({ type: "config", partials: on }));
  }

  /** End of speech: the rest of the audio, then the final text. Rejects on any failure. */
  finish(timeoutMs: number): Promise<string> {
    if (this.broken) return Promise.reject(new Error(this.why || "stream failed"));
    this.ended = true;
    this.flush();
    this.send(JSON.stringify({ type: "end" }));
    return new Promise<string>((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.timers.push(setTimeout(() => this.fail("final timed out"), timeoutMs));
    });
  }

  /** Drop everything (a cancelled listen, a mute). Never calls onPartial again. */
  abort(): void {
    if (!this.broken && this.open && this.finalText === null) {
      try {
        this.ws?.send(JSON.stringify({ type: "cancel" }));
      } catch {
        /* closing anyway */
      }
    }
    this.ended = true;
    this.fail("aborted");
  }

  private flush(): void {
    if (!this.batchLen) return;
    const all = new Int16Array(this.batchLen);
    let o = 0;
    for (const b of this.batch) {
      all.set(b, o);
      o += b.length;
    }
    this.batch = [];
    this.batchLen = 0;
    this.send(all.buffer);
  }

  private send(m: string | ArrayBuffer): void {
    if (this.broken || !this.ws) return;
    if (!this.open) {
      this.queue.push(m);
      return;
    }
    try {
      this.ws.send(m);
    } catch {
      this.fail("send failed");
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string" || this.broken) return;
    let m: { type?: string; partial?: unknown; stable?: unknown; final?: unknown; error?: unknown };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.type === "partial" && !this.ended && typeof m.partial === "string") {
      this.o.onPartial(m.partial, typeof m.stable === "string" ? m.stable : "");
    } else if (m.type === "final") {
      this.finalText = typeof m.final === "string" ? m.final : "";
      const w = this.waiter;
      this.cleanup();
      w?.resolve(this.finalText);
    } else if (m.type === "error") {
      this.fail(typeof m.error === "string" ? m.error : "error");
    }
  }

  private fail(why: string): void {
    if (this.finalText !== null || this.broken) return;
    this.broken = true;
    this.why = why;
    const w = this.waiter;
    this.cleanup();
    w?.reject(new Error(why));
  }

  private cleanup(): void {
    this.waiter = null;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.unmute?.();
    this.unmute = null;
    this.queue = [];
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.ws = null;
  }
}
