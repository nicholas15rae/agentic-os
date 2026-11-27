import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C1 live captions on the desktop, through the real capture layer (`engines.ts` MicCapture +
 * WhisperStt) on fake browser audio (the harness of mic-capture-gate.test.ts): while the VAD hears
 * speech the clip so far goes to Rust `stt_partial` every `vad.partialMs`; the final is still one
 * `stt_transcribe` of the whole clip; nothing is captioned after it.
 */
const h = vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
  return { nativeRaw: vi.fn(), cmd: vi.fn(), partial: vi.fn() };
});
vi.mock("@/lib/platform", () => ({ isTauri: () => true, nativeRaw: h.nativeRaw, cmd: h.cmd, onNativeEvent: async () => () => undefined }));
// The real PartialLoop; only its IPC sender (Rust `stt_partial`, tested in stt-partials.test.ts) is a spy.
vi.mock("./stt-partials", async (importOriginal) => ({ ...(await importOriginal<typeof import("./stt-partials")>()), sttPartial: h.partial }));
vi.mock("./silero", () => ({
  preloadSilero: async () => false,
  SileroStream: class {
    ready = false;
    failed = true;
    prob = 0;
    push() {}
    close() {}
  },
}));

type Frame = (e: { data: { pcm: Float32Array; rms: number } }) => void;
const fake = { worklets: [] as { port: { onmessage: Frame | null } }[] };

class FakeNode {
  connect<T>(n: T) {
    return n;
  }
  disconnect() {}
}
class FakeWorklet extends FakeNode {
  port = { onmessage: null as Frame | null };
  constructor() {
    super();
    fake.worklets.push(this);
  }
}
class FakeAudioContext {
  state = "running";
  sampleRate = 48_000;
  destination = new FakeNode();
  audioWorklet = { addModule: async () => undefined };
  createMediaStreamSource() {
    return new FakeNode();
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
  async resume() {}
}
vi.stubGlobal("AudioContext", FakeAudioContext);
vi.stubGlobal("AudioWorkletNode", FakeWorklet);
vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, language: "en-US" });

import { WhisperStt, encodeWav16k, type SttHandlers } from "./engines";
import { resetMicGateForTests, setMicEnabledLocal } from "./mic-gate";
import { Pcm16Stream } from "./stt-partials";
import { useVoice } from "./voice-store";
import { useSettings } from "@/stores/settings";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const LOUD = 0.1;
const QUIET = 0.0001;
let phase = 0;
/** One 1024-sample worklet frame of a 220 Hz tone (so the audio is not all zeros). */
const frame = (rms: number) => {
  const pcm = new Float32Array(1024);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(((phase + i) * 2 * Math.PI * 220) / 48_000) * 0.2;
  phase += 1024;
  return { data: { pcm, rms } };
};
const handlers = (): SttHandlers & { [K in keyof SttHandlers]-?: ReturnType<typeof vi.fn> } => ({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onPhase: vi.fn() });
const vad0 = { ...useSettings.getState().vad };
const partialCalls = () => h.partial.mock.calls;

beforeEach(() => {
  resetMicGateForTests();
  setMicEnabledLocal(true);
  fake.worklets = [];
  h.nativeRaw.mockReset();
  h.nativeRaw.mockResolvedValue("Tony, cut it.");
  h.partial.mockReset();
  useSettings.getState().set({ vad: { ...vad0, activationDb: -44, partialMs: 600 } });
  useVoice.setState({ state: "listening", turns: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Start a listen that shows captions (they are opt-in) and return the frame pump. */
async function listen(opts: Parameters<WhisperStt["start"]>[1] = { partials: () => true }) {
  const hh = handlers();
  const stt = new WhisperStt();
  stt.start(hh, opts);
  await flush();
  const push = fake.worklets.at(-1)!.port.onmessage!;
  return { hh, stt, push: (rms: number, n = 1) => Array.from({ length: n }, () => push(frame(rms))) };
}

describe("desktop live captions", () => {
  it("captions every ~600 ms of speech, single-flight; the final is still one full-clip stt_transcribe", async () => {
    const replies = ["Tony", "Tony cut", "late caption"];
    const resolvers: ((v: unknown) => void)[] = [];
    h.partial.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const { hh, push } = await listen();
    push(LOUD, 20); // ~430 ms: speech started (onset ~60 ms), not yet 600 ms of it
    await flush();
    expect(partialCalls()).toHaveLength(0);
    push(LOUD, 12); // past 600 ms
    await flush();
    expect(partialCalls()).toHaveLength(1);
    const [wav, capture] = partialCalls()[0];
    expect(capture).toMatch(/^cap-[a-z0-9]+-[a-z0-9]+$/);
    expect(wav).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    push(LOUD, 40); // ~850 ms more: the first is still in flight, so no second request
    await flush();
    expect(partialCalls()).toHaveLength(1);
    resolvers[0]({ text: replies[0] });
    await flush();
    expect(hh.onPartial).toHaveBeenLastCalledWith("Tony", "");
    push(LOUD, 1); // due again (single-flight released)
    await flush();
    expect(partialCalls()).toHaveLength(2);
    resolvers[1]({ text: replies[1] });
    await flush();
    expect(hh.onPartial).toHaveBeenLastCalledWith("Tony cut", "Tony");
    push(LOUD, 30);
    await flush();
    expect(partialCalls()).toHaveLength(3);
    push(QUIET, 40); // the end-of-speech pause: no caption is started in it; the final runs
    await flush();
    expect(partialCalls()).toHaveLength(3);
    expect(h.nativeRaw).toHaveBeenCalledTimes(1);
    expect(h.nativeRaw.mock.calls[0][0]).toBe("stt_transcribe");
    expect(hh.onFinal).toHaveBeenCalledWith("Tony, cut it.");
    resolvers[2]({ text: replies[2] }); // the caption in flight when the final started
    await flush();
    expect(hh.onPartial).toHaveBeenCalledTimes(2);
    expect(hh.onPartial).not.toHaveBeenCalledWith("late caption", expect.anything());
  });

  it("no captions while Tony's reply streams, with partialMs 0, or when Rust says off", async () => {
    h.partial.mockResolvedValue({ text: "", off: true });
    useVoice.setState({ state: "thinking" });
    let l = await listen();
    l.push(LOUD, 60);
    await flush();
    expect(partialCalls()).toHaveLength(0);
    useVoice.setState({ state: "listening" });
    l.push(LOUD, 1); // the reply finished: captions resume
    await flush();
    expect(partialCalls()).toHaveLength(1);
    l.push(LOUD, 60); // Rust answered off (not a GPU STT): none for the rest of the capture
    await flush();
    expect(partialCalls()).toHaveLength(1);
    l.stt.abort();

    h.partial.mockClear();
    useSettings.getState().set({ vad: { ...vad0, activationDb: -44, partialMs: 0 } });
    l = await listen();
    l.push(LOUD, 80);
    await flush();
    expect(partialCalls()).toHaveLength(0);
    l.stt.abort();
  });

  it("a mute stops captions with the capture", async () => {
    h.partial.mockResolvedValue({ text: "Tony" });
    const l = await listen();
    l.push(LOUD, 20);
    setMicEnabledLocal(false);
    l.push(LOUD, 40);
    await flush();
    expect(partialCalls()).toHaveLength(0);
    expect(h.nativeRaw).not.toHaveBeenCalled();
  });

  it("captions are opt-in: a listen started without `partials` (Brainstorm, System Map dictation) sends no stt_partial", async () => {
    h.partial.mockResolvedValue({ text: "a note" });
    const { hh, push } = await listen({ maxSilenceStartMs: 8000, endSilenceMs: 1400 }); // dictation.ts's options
    push(LOUD, 120); // ~2.5 s of speech: four caption slots
    await flush();
    expect(partialCalls()).toHaveLength(0);
    expect(hh.onPartial).not.toHaveBeenCalled();
    push(QUIET, 80); // the final is still the one full-clip decode
    await flush();
    expect(h.nativeRaw).toHaveBeenCalledTimes(1);
    expect(h.nativeRaw.mock.calls[0][0]).toBe("stt_transcribe");
    expect(hh.onFinal).toHaveBeenCalledWith("Tony, cut it.");
  });

  it("a listen that doesn't want captions (hands-free's passive wake listen) gets no caption pass", async () => {
    h.partial.mockResolvedValue({ text: "the TV" });
    let wanted = false;
    const hh = handlers();
    const stt = new WhisperStt();
    stt.start(hh, { partials: () => wanted });
    await flush();
    const push = (n: number) => Array.from({ length: n }, () => fake.worklets.at(-1)!.port.onmessage!(frame(LOUD)));
    push(80);
    await flush();
    expect(partialCalls()).toHaveLength(0);
    wanted = true; // e.g. the wake word was heard and the listen became a real one
    push(1);
    await flush();
    expect(partialCalls()).toHaveLength(1);
    expect(hh.onPartial).toHaveBeenCalledWith("the TV", "");
    stt.abort();
  });
});

describe("Pcm16Stream", () => {
  it("streams exactly the samples encodeWav16k makes of the whole clip, at 48 and 44.1 kHz, in any split", () => {
    for (const rate of [48_000, 44_100]) {
      const pcm = new Float32Array(rate * 0.73);
      let seed = 7;
      for (let i = 0; i < pcm.length; i++) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        pcm[i] = (seed / 2 ** 31) * 2 - 1;
      }
      const wav = encodeWav16k(pcm, rate);
      const want = new Int16Array(wav.buffer.slice(44));
      const s = new Pcm16Stream(rate);
      const got: number[] = [];
      for (let o = 0, k = 0; o < pcm.length; k++) {
        const n = [1024, 1, 333, 128, 4096][k % 5];
        got.push(...s.push(pcm.subarray(o, o + n)));
        o += n;
      }
      expect(got.length).toBe(want.length);
      expect(Int16Array.from(got)).toEqual(want);
    }
  });
});
