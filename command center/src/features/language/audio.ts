/**
 * Language Hub audio: a tap-to-record mic (no VAD — a quiet stranger in a café still gets
 * recorded) that goes through the mic gate like every other capture, and playback that prefers
 * the local Kokoro voice and falls back to the browser's Web Speech voice.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { audioContext, encodeWav16k, micErrorMessage, openMic } from "@/features/voice/engines";
import { assertMicAllowed, captureClosed, captureOpened, MicLockedError, MIC_LOCKED_MSG, micEnabled, registerCapture } from "@/features/voice/mic-gate";
import { useSettings } from "@/stores/settings";
import type { SpokeWith } from "./contract";
import { langApi } from "./api";
import { langInfo } from "./languages";
import { useHub } from "./store";
import { kokoroSpeaks, resolveVoice, type VoicePlan } from "./voice";

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
  // The mic opening (a second or two on a phone): a stop that arrives meanwhile waits for it.
  const starting = useRef<Promise<void> | null>(null);

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

  const stop = useCallback(async (): Promise<Uint8Array | null> => {
    if (!live.current && starting.current) await starting.current.catch(() => undefined);
    const got = teardown();
    if (!got) return null;
    const total = got.chunks.reduce((n, c) => n + c.length, 0);
    if (total < got.rate * 0.4 || !micEnabled()) return null;
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of got.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    return encodeWav16k(pcm, got.rate);
  }, [teardown]);

  const start = useCallback(async (): Promise<void> => {
    if (live.current || starting.current) return;
    assertMicAllowed();
    setState("starting");
    let done!: () => void;
    starting.current = new Promise<void>((r) => (done = r));
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
    } finally {
      starting.current = null;
      done();
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

/** This device's Web Speech voices (fills in asynchronously on most browsers). */
export function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

/** Browser voices that speak `lang` (Latin also lists the Italian voices it falls back to). */
export function browserVoicesFor(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice[] {
  const info = langInfo(lang);
  const bases = [info?.bcp47 ?? lang, info?.speechFallback].filter(Boolean).map((t) => (t as string).split("-")[0].toLowerCase());
  return voices.filter((v) => bases.includes(v.lang.split(/[-_]/)[0].toLowerCase()));
}

function webSpeechVoice(lang: string, pick: string | null): { voice: SpeechSynthesisVoice | null; tag: string } {
  const info = langInfo(lang);
  const tags = [info?.bcp47 ?? lang, info?.speechFallback].filter(Boolean) as string[];
  const voices = typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices() : [];
  const chosen = pick ? voices.find((v) => v.voiceURI === pick || v.name === pick) : undefined;
  if (chosen) return { voice: chosen, tag: chosen.lang };
  for (const tag of tags) {
    const base = tag.split("-")[0].toLowerCase();
    const v = voices.find((x) => x.lang.toLowerCase() === tag.toLowerCase()) ?? voices.find((x) => x.lang.toLowerCase().startsWith(base));
    if (v) return { voice: v, tag };
  }
  return { voice: null, tag: tags[0] };
}

function speakWeb(text: string, lang: string, pick: string | null): Promise<string | null> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const { voice, tag } = webSpeechVoice(lang, pick);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang ?? tag;
    if (voice) u.voice = voice;
    u.rate = 0.95;
    const name = voice ? `Browser · ${voice.name}` : "Browser voice";
    u.onend = () => resolve(name);
    u.onerror = () => resolve(name);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    // Some engines never fire onend for an unsupported tag; don't hang the caller.
    setTimeout(() => resolve(name), 250);
  });
}

async function playServer(text: string, lang: string, plan: { engine?: string; voice?: string | null; model?: string | null }) {
  const buf = await langApi.tts(text, lang, plan);
  currentUrl = URL.createObjectURL(new Blob([buf]));
  current = new Audio(currentUrl);
  await current.play();
}

const why = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/KILL_SWITCH/.test(m)) return "kill switch is on";
  if (/ENGINE_DESKTOP_ONLY/.test(m)) return "cloud voices are desktop-only";
  if (/UNSUPPORTED_LANG/.test(m)) return "no voice for this language";
  return m.slice(0, 120);
};

/**
 * Speak `text` in `lang` with the Voice panel's choice (or `override`, for previews). If that
 * engine can't, fall back to Kokoro's own voice for the language, then the browser's voice.
 * Returns what actually spoke (the badge).
 */
export async function speak(text: string, lang: string, override?: VoicePlan): Promise<SpokeWith> {
  stopSpeaking();
  const s = useHub.getState();
  const plan = override ?? resolveVoice(s.voice, lang, s.engines);
  const browserPick = plan.kind === "browser" ? plan.voice : (s.browserVoices[lang.split("-")[0]] ?? s.browserVoices["*"] ?? null);
  if (plan.kind === "browser") {
    const name = await speakWeb(text, lang, browserPick);
    return name ? { label: name, fallback: false } : { label: "No voice available", fallback: true, reason: "this browser has no speech voices" };
  }
  let reason: string | undefined;
  try {
    await playServer(text, lang, plan);
    return { label: plan.voice ? `${plan.label} · ${plan.voice}` : plan.label, fallback: false };
  } catch (e) {
    reason = why(e);
  }
  const kokoro = s.engines.find((e) => e.engine === "kokoro");
  if (kokoro && kokoro.id !== plan.engine && kokoroSpeaks(lang)) {
    // Your own Kokoro picks still apply when Kokoro is only standing in.
    const k = resolveVoice({ ...s.voice, engine: kokoro.id }, lang, s.engines);
    try {
      await playServer(text, lang, { engine: kokoro.id, voice: k.voice });
      return { label: `${kokoro.label}${k.voice ? ` · ${k.voice}` : ""} (fallback)`, fallback: true, reason };
    } catch {
      /* fall through to the browser */
    }
  }
  const name = await speakWeb(text, lang, browserPick);
  return { label: name ? `${name} (fallback)` : "No voice available", fallback: true, reason };
}

/** What WOULD speak this language (the play button's tooltip). */
export function expectedVoice(lang: string): string {
  const s = useHub.getState();
  const plan = resolveVoice(s.voice, lang, s.engines);
  return plan.voice ? `${plan.label} · ${plan.voice}` : plan.label;
}
