import { cmd, isTauri, nativeRaw, onNativeEvent, type TtsUnpinEvent } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { micLevel, useVoice, voiceLevel } from "./voice-store";
import { speechStarted } from "./speech-start";
import { SileroStream, preloadSilero } from "./silero";
import { DEFAULT_ACTIVATION_DB, DEFAULT_BARGE_MARGIN_DB, Gate, dbfs, isQuietFrame, thresholdFor } from "./vad-gate";
import { PARTIAL_QUIET_MS, PartialLoop, newCaptureId, partialMsFrom, replyStreaming, sttPartial, type SpeechTick } from "./stt-partials";
import { PhoneSttStream, streamFinalMs, streamUrl } from "./stt-stream";
import { MIC_LOCKED_MSG, MicLockedError, assertMicAllowed, captureClosed, captureOpened, micEnabled, publishMeter, registerCapture, unpublishMeter, type MeterSnapshot } from "./mic-gate";
import { perSentenceOpts, sentences, stripForSpeech, synthArgs } from "./tts-text";
import { contextIsDead } from "@/lib/audio-context";
import { isAndroidApp } from "@/stores/settings";
import { langApi } from "@/features/language/api";

// ── Android: the PC's voice stack through the gateway ────────────────────────
// The Android app is Tauri, but its Rust side runs on the phone, where 127.0.0.1 is the phone, so
// `tts_synthesize` / `stt_transcribe` can't reach Kokoro / Whisper. The gateway's Language Hub
// endpoints (/api/cc/lang/tts and /stt, over NetBird with the token) run the same local engines.
// ElevenLabs: the gateway calls it with the PC's key (never on the phone) using the desktop roster's
// voice for the line's agent, and falls back to Kokoro when it's blocked, keyless or failing.

/** Audio bytes for one line: Rust on the desktop, the gateway's Kokoro on the phone. */
export function synthBytes(args: ReturnType<typeof synthArgs>): Promise<ArrayBuffer> {
  if (!isAndroidApp()) return cmd("tts_synthesize", args);
  return langApi.tts(args.text, "en", { agent: args.agent || "general", voice: args.voice || undefined });
}

/** Text for one WAV: Rust's Whisper on the desktop, the gateway's Whisper on the phone. */
export async function transcribeWav(wav: Uint8Array): Promise<string> {
  if (!isAndroidApp()) return nativeRaw<string>("stt_transcribe", wav);
  return (await langApi.stt(wav, "en")).text;
}
import type { SpeakOpts, TtsEngine } from "./tts-types";
import { FallbackTts } from "./tts-fallback";
import { PinCache, unpinEverywhere } from "./tts-pin";

// Re-exported so existing importers (`voice-controller.ts` et al.) are unaffected by
// the split — these three live in their own files so they're testable under Vitest
// without pulling in this file's browser-only code (see `tts-types.ts`'s doc comment).
export { sentences, stripForSpeech, FallbackTts };
export type { SpeakOpts, TtsEngine };

/**
 * Pluggable speech I/O. The controller only talks to these interfaces.
 *
 *   Desktop:  WhisperStt (mic → VAD → 16 kHz WAV → Rust → whisper server)
 *             KokoroTts  (Rust → Kokoro-FastAPI → mp3 → WebAudio, sentence-pipelined)
 *   PWA:      WebSpeechStt (Chrome/Android) + WebSpeechTts
 *             TODO(cline): gateway /api/voice/{stt,tts} proxies so mobile uses Whisper/Kokoro too.
 *
 * Mic engines feed `micLevel`, TTS feeds `voiceLevel` (the waveform shows the louder of the two).
 * Every capture goes through `mic-gate.ts`: while the mic is locked off nothing opens, and a
 * mute stops whatever is open at once (Phase 2 Part B).
 */
export interface SttHandlers {
  /** A live caption of what's been said so far (`stable`: the LocalAgreement-2 prefix that will
   * not change; `t` = stable + the tentative rest). Whisper: only on a GPU STT, see stt-partials.ts. */
  onPartial: (t: string, stable?: string) => void;
  onFinal: (t: string) => void;
  onError: (e: string) => void;
  /** Speech started/ended — lets the UI say "Listening…" vs "Transcribing…". */
  onPhase?: (p: "waiting" | "speech" | "transcribing") => void;
}

/** Per-listen options. `barge`: a listen over Tony (the gate adds `vad.bargeMarginDb`; `speakers`
 * = open speakers, a headset gets 2 dB less). */
export interface SttStartOpts {
  maxSilenceStartMs?: number;
  barge?: boolean;
  speakers?: boolean;
  endSilenceMs?: number;
  maxUtteranceMs?: number;
  /** Live captions wanted right now (default yes); read per caption, so a listen can turn them on/off. */
  partials?: () => boolean;
}

export interface SttEngine {
  readonly name: string;
  readonly supported: boolean;
  start(h: SttHandlers, opts?: SttStartOpts): void;
  /** Finish early and deliver what was heard. */
  stop(): void;
  /** Cancel: discard audio, call no handlers. */
  abort(): void;
}

// ── Shared audio context (created lazily inside a user gesture) ─────────────

let ctx: AudioContext | null = null;
let ctxBroken = false;

export async function audioContext(): Promise<AudioContext> {
  if (ctx && contextIsDead(ctx, ctxBroken)) {
    void ctx.close().catch(() => undefined);
    ctx = null;
  }
  if (!ctx) {
    const c = new AudioContext();
    ctxBroken = false;
    c.addEventListener?.("error", () => {
      if (ctx === c) ctxBroken = true;
    });
    ctx = c;
  }
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

// ── Mic capture + the activation gate ───────────────────────────────────────
//
// VAD runs on audio-thread frames (~21 ms each), so it keeps working when the window is in the
// background. One absolute dBFS gate decides (`vad-gate.ts`, Settings → Voice & Triggers →
// Activation threshold); Silero, once loaded, must also agree. The running noise floor is
// display-only. The gate is read per frame, so a slider move applies on the very next frame.

interface CaptureOpts {
  record: boolean;
  /** Called once when speech has started and then stayed quiet for the end-of-speech pause. */
  onUtteranceEnd?: (pcm: Float32Array, sampleRate: number) => void;
  onNoSpeech?: () => void;
  onSpeechStart?: () => void;
  maxSilenceStartMs?: number;
  /** Meter only (the Web Speech level): don't keep audio, decide nothing. */
  meterOnly?: boolean;
  /** A listen over Tony: the gate adds the barge margin. */
  barge?: boolean;
  speakers?: boolean;
  /** Pause (ms) that ends an utterance. Overrides `vad.endSilenceMs`; `Infinity` never ends on silence. */
  endSilenceMs?: number;
  /** Hard cap (ms) on one utterance, measured from speech start. Overrides `vad.maxUtteranceMs`; `Infinity` disables the cap. */
  maxUtteranceMs?: number;
  /** Every frame while the VAD hears speech (live captions): speech so far, the quiet run, the audio. */
  onSpeechTick?: (t: SpeechTick) => void;
  /** The audio from the speech onset on, as it arrives (the phone's stream): the pre-roll chunks at
   * the onset, then each frame up to and including the one that ends the utterance, i.e. exactly
   * what `onUtteranceEnd` then hands over. */
  onSpeechAudio?: (frames: Float32Array[], rate: number) => void;
}

const FRAME_SAMPLES = 1024;

/** The gate settings, cached (no store read per audio frame) and refreshed on every change. */
let gateCfg = { activationDb: DEFAULT_ACTIVATION_DB, bargeMarginDb: DEFAULT_BARGE_MARGIN_DB };
function readGateCfg() {
  const v = useSettings.getState().vad;
  gateCfg = {
    activationDb: typeof v?.activationDb === "number" ? v.activationDb : DEFAULT_ACTIVATION_DB,
    bargeMarginDb: typeof v?.bargeMarginDb === "number" ? v.bargeMarginDb : DEFAULT_BARGE_MARGIN_DB,
  };
}
readGateCfg();
useSettings.subscribe(readGateCfg);

export class MicCapture {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private chunks: Float32Array[] = [];
  private done = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private silero: SileroStream | null = null;
  /** Bumped by every start()/stop(): an older start() still awaiting the mic sees it changed and bails. */
  private session = 0;
  /** Releases this capture's registration with the mic gate (null while not holding the mic). */
  private release: (() => void) | null = null;
  /** The VAD heard speech in this capture, and the chunk it started at (with pre-roll): a flush
   * hands Whisper only that, never the silence before it (Whisper invents "Thank you." from it). */
  private speechStarted = false;
  private speechChunkAt = 0;
  /** This capture's own meter (published while it holds the mic; mutated per frame). */
  readonly meter: MeterSnapshot = { levelDb: -100, floorDb: -100, thrDb: DEFAULT_ACTIVATION_DB, prob: null, speaking: false, neural: false };

  /** start() is still acquiring the mic (nothing captured yet, not stopped). */
  get starting() {
    return !this.done && !this.stream;
  }

  /** Rejects with `MicLockedError` while the mic is locked off (before touching any audio API). */
  async start(opts: CaptureOpts): Promise<void> {
    this.stop();
    assertMicAllowed();
    const my = ++this.session;
    this.done = false;
    this.chunks = [];
    this.speechStarted = false;
    this.speechChunkAt = 0;
    const ac = await audioContext();
    if (my !== this.session) return;
    assertMicAllowed();
    const { micDeviceId: deviceId, vad } = useSettings.getState();
    const stream = await openMic(deviceId);
    if (my !== this.session) return stream.getTracks().forEach((t) => t.stop());
    // Locked off while the browser was opening the device: release it before anything listens.
    if (!micEnabled()) {
      stream.getTracks().forEach((t) => t.stop());
      this.done = true;
      throw new MicLockedError();
    }
    this.stream = stream;
    this.release = registerCapture({ stop: () => this.stop() });
    captureOpened();
    publishMeter(this.meter);
    const src = ac.createMediaStreamSource(stream);
    await ac.audioWorklet.addModule(import.meta.env.BASE_URL + "worklets/pcm-capture.js");
    // A stop() during addModule (a mute included) already released `stream`; stopping again is a no-op.
    if (my !== this.session) return stream.getTracks().forEach((t) => t.stop());
    const worklet = new AudioWorkletNode(ac, "pcm-capture");
    const sink = ac.createGain();
    sink.gain.value = 0; // keep the graph pulled without audible output
    src.connect(worklet).connect(sink).connect(ac.destination);
    this.nodes = [src, worklet, sink];

    const frameMs = (FRAME_SAMPLES / ac.sampleRate) * 1000;
    const started = performance.now();
    // A caller (e.g. Brainstorm's per-profile dictation) overrides the global VAD pause/cap;
    // `Infinity` disables either check (continuous mode never ends on silence or a time cap).
    const endMs = opts.endSilenceMs ?? vad.endSilenceMs;
    const maxMs = opts.maxUtteranceMs ?? vad.maxUtteranceMs;
    const gate = new Gate(frameMs, endMs, maxMs);
    const meter = this.meter;
    let floorDb = -100;
    let frames = 0;
    let speechAt = 0;
    let speechChunk = 0;
    // Live hooks: chunks already handed to onSpeechAudio, frames of speech, the current quiet run.
    let streamedTo = 0;
    let speechFrames = 0;
    let quietRunMs = 0;

    // Neural VAD: once its model is loaded, its latest probability is the gate's AND condition.
    const silero = opts.onUtteranceEnd ? new SileroStream(ac.sampleRate, () => undefined) : null;
    this.silero = silero;

    worklet.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; rms: number }>) => {
      if (this.done) return;
      // A mute that raced this frame: the line is dead, drop the frame and release the mic.
      if (!micEnabled()) return this.stop();
      const { pcm, rms } = e.data;
      if (!opts.meterOnly) this.chunks.push(pcm);
      micLevel.current += (Math.min(1, rms * 6) - micLevel.current) * 0.5;
      const neural = !!silero?.ready && !silero.failed;
      if (neural) silero.push(pcm);
      const levelDb = dbfs(rms);
      const prob = neural ? silero.prob : null;
      // Display-only floor: the first ~250 ms averaged, then tracked while nobody is speaking.
      frames++;
      if (frames <= 12) floorDb = frames === 1 ? levelDb : floorDb + (levelDb - floorDb) / frames;
      else if (!gate.speaking) floorDb += (levelDb - floorDb) * (levelDb < floorDb + 6 ? 0.05 : 0.003);
      // Read per frame from the cached settings: a slider move applies on the very next frame.
      const thrDb = thresholdFor({ ...gateCfg, barge: opts.barge, speakers: opts.speakers });
      meter.levelDb = levelDb;
      meter.floorDb = floorDb;
      meter.thrDb = thrDb;
      meter.prob = prob;
      meter.neural = neural;
      if (!opts.onUtteranceEnd) return;

      if (!gate.speaking && performance.now() - started > (opts.maxSilenceStartMs ?? 7000)) {
        this.done = true;
        this.stop();
        opts.onNoSpeech?.();
        return;
      }
      const ev = gate.push(levelDb, prob, thrDb);
      meter.speaking = gate.speaking;
      if (ev === "start") {
        speechAt = performance.now();
        // Keep ~300 ms of pre-roll before the trigger.
        speechChunk = Math.max(0, this.chunks.length - 3 - 14);
        if (!this.speechStarted) {
          this.speechStarted = true;
          this.speechChunkAt = speechChunk;
        }
        streamedTo = speechChunk;
        speechFrames = 0;
        quietRunMs = 0;
        opts.onSpeechStart?.();
      }
      if (opts.onSpeechAudio && (gate.speaking || ev === "end") && streamedTo < this.chunks.length) {
        opts.onSpeechAudio(this.chunks.slice(streamedTo), ac.sampleRate);
        streamedTo = this.chunks.length;
        if (this.done) return; // the hook stopped this capture
      }
      if (opts.onSpeechTick && gate.speaking) {
        speechFrames++;
        quietRunMs = isQuietFrame(levelDb, prob, thrDb) ? quietRunMs + frameMs : 0;
        const from = speechChunk;
        opts.onSpeechTick({ speechMs: speechFrames * frameMs, quietMs: quietRunMs, rate: ac.sampleRate, audio: () => this.audioFrom(from) });
        if (this.done) return;
      }
      if (ev === "end") this.finish(ac.sampleRate, opts, speechChunk);
    };

    // Safety net if the audio thread stalls (device unplugged…): give up after the max utterance.
    // Measured from speech start once speech has begun (so a long pre-speech wait in relaxed/
    // continuous mode — maxSilenceStartMs can be Infinity there — doesn't eat into the budget);
    // before that, from mic start. Infinity thresholds correctly never trip this (Infinity-safe).
    this.timer = setInterval(() => {
      if (this.done) return;
      if (!micEnabled()) return this.stop();
      const now = performance.now();
      if (speechAt) {
        if (now - speechAt > maxMs + 2000) {
          if (opts.onUtteranceEnd && this.chunks.length) this.finish(ac.sampleRate, opts, speechChunk);
          else this.stop();
        }
      } else if (now - started > (opts.maxSilenceStartMs ?? 7000) + 2000) {
        this.stop();
      }
    }, 1000);
  }

  /** End now and hand over what was SAID (used by the stop button): from the VAD's speech onset,
   * never the wait before it. No speech heard: an empty clip (nothing goes to Whisper). Nothing
   * live: just stop. */
  flush(onUtteranceEnd: CaptureOpts["onUtteranceEnd"]) {
    if (this.done || !this.stream || !ctx || !micEnabled()) return this.stop();
    if (!this.speechStarted) {
      const rate = ctx.sampleRate;
      this.stop();
      return onUtteranceEnd?.(new Float32Array(0), rate);
    }
    this.finish(ctx.sampleRate, { record: true, onUtteranceEnd }, this.speechChunkAt);
  }

  /** The captured audio from chunk `fromChunk` on, in one piece. */
  private audioFrom(fromChunk: number): Float32Array {
    const chunks = this.chunks.slice(fromChunk);
    const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    return pcm;
  }

  private finish(rate: number, opts: CaptureOpts, fromChunk: number) {
    this.done = true;
    const pcm = this.audioFrom(fromChunk);
    this.stop();
    // Never hand audio on once the line is dead (a mute in the same tick as the end of speech).
    if (micEnabled()) opts.onUtteranceEnd?.(pcm, rate);
  }

  /** Releases the mic (tracks stopped → OS indicator off). The shared AudioContext stays open for TTS. Idempotent. */
  stop() {
    this.session++;
    this.done = true;
    this.chunks = [];
    clearInterval(this.timer);
    this.silero?.close();
    this.silero = null;
    for (const n of this.nodes) n.disconnect();
    if (typeof AudioWorkletNode !== "undefined" && this.nodes[1] instanceof AudioWorkletNode) this.nodes[1].port.onmessage = null;
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.release) {
      this.release();
      this.release = null;
      captureClosed();
    }
    unpublishMeter(this.meter);
    this.meter.speaking = false;
    micLevel.current = 0;
  }
}

/** Float32 mic PCM → 16 kHz mono 16-bit WAV (what every Whisper server accepts). */
export function encodeWav16k(pcm: Float32Array, inRate: number): Uint8Array {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const n = Math.floor(pcm.length / ratio);
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, outRate, true);
  out.setUint32(28, outRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  w(36, "data");
  out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Box-filter decimation: average the input samples this output sample covers.
    const a = Math.floor(i * ratio), b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

// ── Mic open / errors ────────────────────────────────────────────────────────

const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  // AGC pumps room noise up between words, which kept the old VAD "hearing speech" forever.
  autoGainControl: false,
  channelCount: 1,
};

/** A remembered mic that is gone (unplugged, its id rotated): the browser's error names. Pure. */
export const isMissingDeviceError = (e: unknown): boolean => {
  const n = (e as { name?: string } | null)?.name ?? "";
  return n === "OverconstrainedError" || n === "NotFoundError" || n === "DevicesNotFoundError";
};

let micFallbackNoticed = false;

/** Open the chosen mic; when that exact device is gone, the default one (with a once-per-session
 * notice) instead of failing every listen. */
export async function openMic(deviceId: string | undefined | null): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
  } catch (e) {
    if (!deviceId || !isMissingDeviceError(e)) throw e;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    if (!micFallbackNoticed) {
      micFallbackNoticed = true;
      void import("@/features/reminders/notify")
        .then((m) => m.useToasts.getState().push({ title: "Selected microphone not found", body: "Using the default microphone instead — pick one again in Settings → Voice.", tone: "error" }))
        .catch(() => undefined);
    }
    return stream;
  }
}

/** What a failed mic open means, in words that point at the real cause. Pure. */
export function micErrorMessage(e: unknown): string {
  const n = (e as { name?: string } | null)?.name ?? "";
  if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError") return "Microphone blocked — allow mic access";
  if (isMissingDeviceError(e)) return "No microphone found — check it's plugged in (Settings → Voice)";
  if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") return "The microphone is busy or failed to start — another app may be using it";
  return `Microphone unavailable${n ? ` (${n})` : ""}`;
}

/** Whisper attempts per utterance, and the pause before the retry. */
export const STT_ATTEMPTS = 2;
const STT_RETRY_MS = 1500;

/** A Whisper failure worth one retry (the server reloading / slow / a 5xx), not a bad request. Pure. */
export function isTransientSttError(msg: string): boolean {
  return /timed? ?out|timeout|error sending request|connect|connection|refused|unreachable|reset|\b50[0-9]\b|service unavailable|bad gateway/i.test(msg) && !/too short or too long/i.test(msg);
}

// ── Whisper STT (desktop) ────────────────────────────────────────────────────

export class WhisperStt implements SttEngine {
  readonly name = "Whisper";
  readonly supported = isTauri();
  private mic = new MicCapture();
  private handlers: SttHandlers | null = null;
  /** This capture's live captions (desktop) and its stream to the gateway (phone). */
  private partials: PartialLoop | null = null;
  private stream: PhoneSttStream | null = null;

  constructor() {
    // Load Silero now so the first utterance is already judged by the neural VAD.
    if (this.supported) void preloadSilero();
  }

  start(h: SttHandlers, opts?: SttStartOpts) {
    // Locked off: never touch the mic (no getUserMedia, no Whisper request).
    if (!micEnabled()) return h.onError(MIC_LOCKED_MSG);
    this.endLive();
    this.handlers = h;
    h.onPhase?.("waiting");
    const current = () => this.handlers === h;
    this.mic
      .start({
        record: true,
        maxSilenceStartMs: opts?.maxSilenceStartMs,
        barge: opts?.barge,
        speakers: opts?.speakers,
        endSilenceMs: opts?.endSilenceMs,
        maxUtteranceMs: opts?.maxUtteranceMs,
        onSpeechStart: () => current() && h.onPhase?.("speech"),
        onNoSpeech: () => current() && h.onFinal(""),
        onUtteranceEnd: (pcm, rate) => void this.transcribe(pcm, rate, h),
        ...this.liveHooks(h, current, opts?.partials),
      })
      .catch((e) => current() && h.onError(e instanceof MicLockedError ? MIC_LOCKED_MSG : micErrorMessage(e)));
  }

  /**
   * Live captions while you speak (`vad.partialMs`, 0 = off). Desktop: the clip so far through Rust
   * `stt_partial` every partialMs. Phone: the audio streams to the gateway's WebSocket, which sends
   * captions and, at the end, the final (the upload stays the fallback). Both pause while Tony's
   * reply streams (his model has the GPU) and in a trailing pause (the final is near).
   */
  private liveHooks(h: SttHandlers, current: () => boolean, partials?: () => boolean): Pick<CaptureOpts, "onSpeechTick" | "onSpeechAudio"> {
    const { vad, gatewayUrl } = useSettings.getState();
    const everyMs = partialMsFrom(vad?.partialMs);
    if (everyMs <= 0) return {};
    const wanted = () => partials?.() ?? true;
    const caption = (t: string, stable: string) => {
      if (current() && micEnabled() && wanted()) h.onPartial(t, stable);
    };
    const pausedNow = () => !wanted() || replyStreaming(useVoice.getState());
    if (isAndroidApp()) {
      const url = streamUrl(gatewayUrl);
      if (!url) return {};
      let tried = false;
      return {
        onSpeechAudio: (frames, rate) => {
          if (!current()) return;
          if (!this.stream && !tried) {
            tried = true; // one stream per capture: a broken one leaves the upload to do the work
            this.stream = new PhoneSttStream({
              url,
              token: () => useSettings.getState().gatewayToken.trim(),
              inRate: rate,
              partials: !pausedNow(),
              partialMs: everyMs,
              onPartial: caption,
            });
          }
          for (const f of frames) this.stream?.push(f);
        },
        onSpeechTick: (t) => current() && this.stream?.setPartials(t.quietMs <= PARTIAL_QUIET_MS && !pausedNow()),
      };
    }
    const loop = new PartialLoop({
      everyMs,
      capture: newCaptureId(),
      send: sttPartial,
      encode: encodeWav16k,
      onPartial: caption,
      paused: pausedNow,
      allowed: micEnabled,
    });
    this.partials = loop;
    return { onSpeechTick: (t) => current() && loop.tick(t) };
  }

  /** No caption after this, and the phone's stream (if any) is dropped. */
  private endLive() {
    this.partials?.close();
    this.partials = null;
    this.stream?.abort();
    this.stream = null;
  }

  /** Stop button: transcribe what we have instead of discarding it. */
  stop() {
    const h = this.handlers;
    if (!h) return this.mic.stop();
    // Stopped before the mic even opened: nothing was captured, so the listen simply ends empty.
    if (this.mic.starting) {
      this.mic.stop();
      this.endLive();
      return h.onFinal("");
    }
    this.mic.flush((pcm, rate) => void this.transcribe(pcm, rate, h));
  }

  abort() {
    this.handlers = null;
    this.endLive();
    this.mic.stop();
  }

  private async transcribe(pcm: Float32Array, rate: number, h: SttHandlers) {
    if (this.handlers !== h) return;
    // The final takes over: captions stop here (a late one would outlive the final's text).
    this.partials?.close();
    this.partials = null;
    const stream = this.stream;
    this.stream = null;
    if (pcm.length < rate * 0.3 || !micEnabled()) {
      stream?.abort();
      return h.onFinal("");
    }
    h.onPhase?.("transcribing");
    if (stream) {
      // Phone: the gateway already has the audio; its final is the same decode the upload gets.
      try {
        const text = await stream.finish(streamFinalMs(pcm.length / rate));
        if (this.handlers === h) h.onFinal(micEnabled() ? text.trim() : "");
        return;
      } catch {
        // No stream / an error / too slow: today's single upload below.
        if (this.handlers !== h) return;
        if (!micEnabled()) return h.onFinal("");
      }
    }
    const wav = encodeWav16k(pcm, rate);
    for (let attempt = 1; ; attempt++) {
      try {
        const text = await transcribeWav(wav);
        // Locked off while Whisper worked: what was heard before the mute is dropped.
        if (this.handlers === h) h.onFinal(micEnabled() ? text.trim() : "");
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Whisper reloading / a timeout / a 5xx: the captured words are worth one more try
        // (they're gone once this returns) before the listen reports the error.
        if (attempt < STT_ATTEMPTS && isTransientSttError(msg) && micEnabled()) {
          await new Promise((r) => setTimeout(r, STT_RETRY_MS));
          if (this.handlers !== h) return;
          continue;
        }
        if (this.handlers === h) h.onError(`Whisper: ${msg}`);
        return;
      }
    }
  }
}

// ── Web Speech STT (PWA in Chrome/Android) ───────────────────────────────────

type SR = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};

export class WebSpeechStt implements SttEngine {
  readonly name = "Web Speech";
  readonly supported: boolean;
  private rec: SR | null = null;
  private Ctor: (new () => SR) | undefined;
  private mic = new MicCapture();

  constructor() {
    const w = (typeof window !== "undefined" ? window : {}) as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    this.Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    this.supported = !!this.Ctor && !isTauri(); // WebView2 exposes the API but it never returns results
  }

  start(h: SttHandlers, opts?: SttStartOpts) {
    if (!this.Ctor) return h.onError("Speech recognition unavailable");
    // Locked off: the cloud recognizer never starts (Rust can't gate it, so this is the gate).
    if (!micEnabled()) return h.onError(MIC_LOCKED_MSG);
    this.abort(); // a previous recognizer never keeps listening under a new one
    void this.mic.start({ record: false, meterOnly: true }).catch(() => undefined); // level meter only
    const rec = new this.Ctor();
    // Chrome's own endpointing has no configurable pause length, so snappy/relaxed just use its
    // default (ends the session after a short pause). Continuous mode (endSilenceMs: Infinity)
    // asks Chrome to keep recognizing across pauses; the session then only ends via stop()/abort().
    rec.continuous = opts?.endSilenceMs === Infinity;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    let finalText = "";
    let aborted = false;
    const dead = () => aborted || !micEnabled();
    h.onPhase?.("waiting");
    rec.onspeechstart = () => {
      if (!dead()) h.onPhase?.("speech");
    };
    rec.onresult = (e) => {
      if (dead()) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      h.onPartial((finalText + interim).trim());
    };
    // A mute stops this recognizer through the gate (abort: whatever it heard is discarded).
    const release = registerCapture({ stop: () => this.abort() });
    this.abortCurrent = () => {
      aborted = true;
      release();
      try {
        rec.abort();
      } catch {
        /* already ended */
      }
    };
    rec.onerror = (e) => {
      if (!dead() && e.error !== "no-speech" && e.error !== "aborted") h.onError(`Mic: ${e.error}`);
    };
    rec.onend = () => {
      release();
      if (this.rec === rec) this.rec = null;
      this.mic.stop();
      if (!dead()) h.onFinal(finalText.trim());
    };
    this.rec = rec;
    rec.start();
  }

  private abortCurrent: () => void = () => undefined;

  stop() {
    this.rec?.stop();
  }

  abort() {
    const a = this.abortCurrent;
    this.abortCurrent = () => undefined;
    a();
    this.rec = null;
    this.mic.stop();
  }
}

// ── Kokoro TTS (desktop) ─────────────────────────────────────────────────────

let unpinListening = false;
/** One `tts-unpin` listener for every Kokoro cache (started on the first cached line). */
function listenForUnpins() {
  if (unpinListening) return;
  unpinListening = true;
  void onNativeEvent<TtsUnpinEvent>("tts-unpin", (e) => unpinEverywhere(e?.pinId)).catch(() => {
    unpinListening = false;
  });
}

export class KokoroTts implements TtsEngine {
  readonly name = "Kokoro";
  readonly supported = isTauri();
  private current: AudioBufferSourceNode | null = null;
  private generation = 0;
  private raf = 0;
  /** Synth requests started ahead of playback (sentence N+1 renders while N plays). */
  private ahead = new Map<string, { at: number; p: Promise<ArrayBuffer> }>();

  /** Deliberately excludes `utteranceId`: callers pass the same id to a reply's prefetch and
   * speak (osRun), and a speak() that mints its own id still reuses the prefetched audio. */
  private key(s: string, opts?: SpeakOpts) {
    return `${opts?.agent ?? ""}|${opts?.voice ?? ""}|${opts?.localOnly ? "local" : ""}|${opts?.model ?? ""}|${opts?.previousText ?? ""}|${s}`;
  }

  /** Session cache for `cache: true` lines (intros, acks, the greeting). Holds the raw bytes;
   * each play gets a copy. A line Rust answered with a local engine instead of the cloud voice
   * is unpinned (`tts-unpin`), so a breaker cooldown can't keep it in Kokoro all session. */
  private pinned = new PinCache();

  private synth(s: string, opts?: SpeakOpts): Promise<ArrayBuffer> {
    const key = this.key(s, opts);
    if (opts?.cache) {
      listenForUnpins();
      return this.pinned.get(key, (pinId) => synthBytes(synthArgs(s, opts, pinId))); // no previousText / utteranceId
    }
    const hit = this.ahead.get(key);
    if (hit) {
      this.ahead.delete(key);
      return hit.p;
    }
    return synthBytes(synthArgs(s, opts));
  }

  prefetch(text: string, opts?: SpeakOpts) {
    const now = Date.now();
    for (const [k, v] of this.ahead) if (now - v.at > 60_000) this.ahead.delete(k);
    for (const { s, opts: sOpts } of perSentenceOpts(text, opts)) {
      const key = this.key(s, sOpts);
      if (this.ahead.has(key)) continue;
      const p = synthBytes(synthArgs(s, sOpts));
      p.catch(() => this.ahead.delete(key));
      this.ahead.set(key, { at: now, p });
    }
  }

  // ── Phase 2: duck (barge-in) and pause/resume (hold) ──
  /** Level while the user talks over the reply. */
  static readonly DUCK_LEVEL = 0.15;
  private gain: GainNode | null = null;
  private ducked = false;
  private paused = false;
  /** The source pause() stopped (its onended must replay, not advance — even after a quick resume). */
  private pausedSrc: AudioBufferSourceNode | null = null;
  private waiters: (() => void)[] = [];

  duck(on: boolean) {
    this.ducked = on;
    const g = this.gain;
    // One audio frame-ish ramp: fast enough to feel instant, smooth enough not to click.
    if (g) g.gain.setTargetAtTime(on ? KokoroTts.DUCK_LEVEL : 1, g.context.currentTime, 0.01);
  }

  /** Keeps the sentence list and index (see speak()); the shared AudioContext keeps running for the mic. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pausedSrc = this.current;
    try {
      this.current?.stop(); // its onended sees `pausedSrc` and replays that sentence on resume
    } catch {
      /* not started */
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.flushWaiters();
  }

  private flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Resolves on resume() or cancel() (the caller re-checks its generation). */
  private untilResumed(): Promise<void> {
    return this.paused ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  async speak(text: string, opts?: SpeakOpts): Promise<void> {
    this.stopCurrent();
    const gen = ++this.generation;
    const ac = await audioContext();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ac.destination);
    // sources → gain (duck) → analyser (meter) → speakers
    const gain = ac.createGain();
    gain.gain.value = this.ducked ? KokoroTts.DUCK_LEVEL : 1;
    gain.connect(analyser);
    this.gain = gain;
    const buf = new Float32Array(analyser.fftSize);
    const meter = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const target = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      voiceLevel.current += (target - voiceLevel.current) * 0.3;
      this.raf = requestAnimationFrame(meter);
    };
    this.raf = requestAnimationFrame(meter);

    // P1: every sentence of one speak() shares a breaker scope — the caller's reply id, or a
    // fresh one, so a failing ElevenLabs call trips this line once instead of per sentence.
    const uOpts: SpeakOpts | undefined = opts?.cache || opts?.utteranceId ? opts : { ...opts, utteranceId: crypto.randomUUID() };
    // Fire all synth requests now; play strictly in order as each resolves.
    const pending = perSentenceOpts(text, uOpts).map(({ s, opts: sOpts }) => this.synth(s, sOpts).then((bytes) => ac.decodeAudioData(bytes)));
    try {
      for (let i = 0; i < pending.length; ) {
        const audio = await pending[i];
        if (gen !== this.generation) return;
        // Held before this sentence started (or a speak() that began during hold): wait.
        await this.untilResumed();
        if (gen !== this.generation) return;
        const finished = await new Promise<boolean>((resolve) => {
          const src = ac.createBufferSource();
          src.buffer = audio;
          src.connect(gain);
          // Ended on its own → next sentence; stopped by pause() → replay this one on resume.
          src.onended = () => resolve(this.pausedSrc !== src);
          this.current = src;
          src.start();
          if (i === 0) speechStarted();
        });
        if (gen !== this.generation) return;
        if (finished) i++;
        else this.pausedSrc = null;
      }
    } finally {
      if (gen === this.generation) {
        cancelAnimationFrame(this.raf);
        voiceLevel.current = 0;
        analyser.disconnect();
        gain.disconnect();
        if (this.gain === gain) this.gain = null;
      }
    }
  }

  /** Stop playback without touching duck/pause state (a new speak() of the same reply). */
  private stopCurrent() {
    this.generation++;
    cancelAnimationFrame(this.raf);
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.current = null;
    voiceLevel.current = 0;
    this.flushWaiters(); // a speak() waiting out a hold ends (its generation is stale)
  }

  /** Hard stop: drops the reply, any paused audio and the duck. */
  cancel() {
    this.paused = false;
    this.ducked = false;
    this.gain = null;
    this.stopCurrent();
  }
}

// ── Web Speech TTS (fallback everywhere) ────────────────────────────────────

export class WebSpeechTts implements TtsEngine {
  readonly name = "System voice";
  readonly supported = typeof window !== "undefined" && "speechSynthesis" in window;
  private raf = 0;
  /** No gain on speechSynthesis: a duck pauses instead, a hold pauses too; either keeps it paused. */
  private ducked = false;
  private held = false;
  private gen = 0;
  private waiters: (() => void)[] = [];

  private apply() {
    if (!this.supported) return;
    if (this.ducked || this.held) speechSynthesis.pause();
    else {
      speechSynthesis.resume();
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    }
  }
  duck(on: boolean) {
    this.ducked = on;
    this.apply();
  }
  pause() {
    this.held = true;
    this.apply();
  }
  resume() {
    this.held = false;
    this.apply();
  }

  async speak(text: string): Promise<void> {
    if (!this.supported || !text) return;
    cancelAnimationFrame(this.raf);
    speechSynthesis.cancel();
    const gen = ++this.gen;
    // Started during a hold: wait (cancel() also releases this, with a stale generation).
    if (this.held) await new Promise<void>((r) => this.waiters.push(r));
    if (gen !== this.gen) return;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(stripForSpeech(text).slice(0, 600));
      u.rate = 1.03;
      // No audio tap on speechSynthesis, so synthesise an envelope from word boundaries.
      let target = 0.35;
      u.onboundary = () => (target = 0.45 + Math.random() * 0.5);
      const tick = () => {
        target *= 0.94;
        voiceLevel.current += (target - voiceLevel.current) * 0.25;
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
      const done = () => {
        cancelAnimationFrame(this.raf);
        voiceLevel.current = 0;
        resolve();
      };
      u.onstart = () => speechStarted();
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      if (this.ducked) speechSynthesis.pause();
    });
  }

  cancel() {
    cancelAnimationFrame(this.raf);
    this.gen++;
    this.ducked = false;
    this.held = false;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
    if (this.supported) {
      speechSynthesis.cancel();
      speechSynthesis.resume(); // a paused synth stays paused for the next utterance otherwise
    }
  }
}

// ── Selection ───────────────────────────────────────────────────────────────
// `FallbackTts` lives in `./tts-fallback` (re-exported above).

export function createEngines(): { stt: SttEngine | null; tts: TtsEngine } {
  const whisper = new WhisperStt();
  const web = new WebSpeechStt();
  return {
    stt: whisper.supported ? whisper : web.supported ? web : null,
    tts: new FallbackTts(new KokoroTts(), new WebSpeechTts()),
  };
}
