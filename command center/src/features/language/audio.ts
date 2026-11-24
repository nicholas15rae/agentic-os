/**
 * Language Hub audio: a tap-to-record mic (no VAD — a quiet stranger in a café still gets
 * recorded) that goes through the mic gate like every other capture, and playback that prefers
 * the local Kokoro voice and falls back to the browser's Web Speech voice.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { audioContext, encodeWav16k, micErrorMessage, openMic } from "@/features/voice/engines";
import { assertMicAllowed, captureClosed, captureOpened, MicLockedError, MIC_LOCKED_MSG, micEnabled, registerCapture } from "@/features/voice/mic-gate";
import { useSettings } from "@/stores/settings";
import type { VoiceEngine } from "./contract";
import { langApi } from "./api";
import { langInfo } from "./languages";

const MAX_RECORD_MS = 90_000;

export type RecState = "idle" | "starting" | "recording";

/**
 * `start()` opens the mic; `stop()` resolves with a 16 kHz WAV (null when nothing usable was
 * captured). The stream is released the moment recording stops, on unmount, and on a mute.
 * `onAutoStop` receives the clip when the safety cap ends a forgotten recording.
 */
export function useRecorder(onAutoStop?: (wav: Uint8Array | null) => void) {
  const [state, setState] = useState<RecState>("idle");
  const [level, setLevel] = useState(0);
  const live = useRef<{ stream: MediaStream; nodes: AudioNode[]; chunks: Float32Array[]; rate: number; release: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const autoStop = useRef(onAutoStop);
  autoStop.current = onAutoStop;

  const teardown = useCallback((): { chunks: Float32Array[]; rate: number } | null => {
    const l = live.current;
    live.current = null;
    if (!l) return null;
    clearTimeout(l.timer);
    for (const n of l.nodes) n.disconnect();
    const w = l.nodes[1];
    if (typeof AudioWorkletNode !== "undefined" && w instanceof AudioWorkletNode) w.port.onmessage = null;
    l.stream.getTracks().forEach((t) => t.stop());
    l.release();
    captureClosed();
    setLevel(0);
    setState("idle");
    return { chunks: l.chunks, rate: l.rate };
  }, []);

  const stop = useCallback((): Promise<Uint8Array | null> => {
    const got = teardown();
    if (!got) return Promise.resolve(null);
    const total = got.chunks.reduce((n, c) => n + c.length, 0);
    if (total < got.rate * 0.4 || !micEnabled()) return Promise.resolve(null);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of got.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    return Promise.resolve(encodeWav16k(pcm, got.rate));
  }, [teardown]);

  const start = useCallback(async (): Promise<void> => {
    if (live.current) return;
    assertMicAllowed();
    setState("starting");
    try {
      const ac = await audioContext();
      const stream = await openMic(useSettings.getState().micDeviceId);
      if (!micEnabled()) {
        stream.getTracks().forEach((t) => t.stop());
        throw new MicLockedError();
      }
      const src = ac.createMediaStreamSource(stream);
      await ac.audioWorklet.addModule(import.meta.env.BASE_URL + "worklets/pcm-capture.js");
      const worklet = new AudioWorkletNode(ac, "pcm-capture");
      const sink = ac.createGain();
      sink.gain.value = 0;
      src.connect(worklet).connect(sink).connect(ac.destination);
      const chunks: Float32Array[] = [];
      worklet.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; rms: number }>) => {
        if (!micEnabled()) return void teardown();
        chunks.push(e.data.pcm);
        setLevel((l) => l + (Math.min(1, e.data.rms * 6) - l) * 0.5);
      };
      const release = registerCapture({ stop: () => void teardown() });
      captureOpened();
      // Safety cap: a forgotten recording ends itself and is still transcribed.
      const timer = setTimeout(() => void stop().then((w) => autoStop.current?.(w)), MAX_RECORD_MS);
      live.current = { stream, nodes: [src, worklet, sink], chunks, rate: ac.sampleRate, release, timer };
      setState("recording");
    } catch (e) {
      teardown();
      setState("idle");
      throw new Error(e instanceof MicLockedError ? MIC_LOCKED_MSG : micErrorMessage(e));
    }
  }, [stop, teardown]);

  useEffect(() => () => void teardown(), [teardown]);
  return { state, level, start, stop, cancel: teardown };
}

// ── Playback ────────────────────────────────────────────────────────────────

let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

export function stopSpeaking() {
  current?.pause();
  current = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

function webSpeechVoice(lang: string): { voice: SpeechSynthesisVoice | null; tag: string } {
  const info = langInfo(lang);
  const tags = [info?.bcp47 ?? lang, info?.speechFallback].filter(Boolean) as string[];
  const voices = typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices() : [];
  for (const tag of tags) {
    const base = tag.split("-")[0].toLowerCase();
    const v = voices.find((x) => x.lang.toLowerCase() === tag.toLowerCase()) ?? voices.find((x) => x.lang.toLowerCase().startsWith(base));
    if (v) return { voice: v, tag };
  }
  return { voice: null, tag: tags[0] };
}

function speakWeb(text: string, lang: string): Promise<VoiceEngine> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve("none");
  return new Promise((resolve) => {
    const { voice, tag } = webSpeechVoice(lang);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang ?? tag;
    if (voice) u.voice = voice;
    u.rate = 0.95;
    u.onend = () => resolve("web-speech");
    u.onerror = () => resolve("web-speech");
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    // Some engines never fire onend for an unsupported tag; don't hang the caller.
    setTimeout(() => resolve("web-speech"), 250);
  });
}

/** Speak `text` in `lang`: Kokoro when it has a voice for it, else the browser's voice. Returns the engine used. */
export async function speak(text: string, lang: string): Promise<VoiceEngine> {
  stopSpeaking();
  if (langInfo(lang)?.kokoro !== false) {
    try {
      const buf = await langApi.tts(text, lang);
      currentUrl = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
      current = new Audio(currentUrl);
      await current.play();
      return "kokoro";
    } catch {
      // UNSUPPORTED_LANG / NO_LOCAL_TTS / Kokoro down → the browser's voice.
    }
  }
  return speakWeb(text, lang);
}

export const ENGINE_LABEL: Record<VoiceEngine, string> = { kokoro: "Kokoro (local)", "web-speech": "Web Speech (browser)", none: "No voice available" };

/** Which engine WOULD speak this language (for the badge before anything plays). */
export const expectedEngine = (lang: string): VoiceEngine => (langInfo(lang)?.kokoro === false ? "web-speech" : "kokoro");
