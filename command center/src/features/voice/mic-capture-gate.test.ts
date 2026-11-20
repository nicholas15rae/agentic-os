import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 Part B — the concrete zero-capture / zero-STT proof the spec asks for. The real capture
 * layer (`engines.ts`: MicCapture, WhisperStt, WebSpeechStt) runs against fake browser audio:
 * getUserMedia hands out tracks with `stop` spies, the worklet's `port.onmessage` is driven by
 * hand, and `nativeRaw` (the only way audio reaches Whisper) is a spy. With the mic locked off:
 * zero getUserMedia calls, zero STT requests, every open track stopped.
 */
const h = vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
  return { nativeRaw: vi.fn(), cmd: vi.fn() };
});
vi.mock("@/lib/platform", () => ({ isTauri: () => true, nativeRaw: h.nativeRaw, cmd: h.cmd, onNativeEvent: async () => () => undefined }));
// silero.ts reads `location` at import; the neural model is "failed" here, so the level gate decides alone.
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

type Track = { stop: ReturnType<typeof vi.fn> };
type Frame = (e: { data: { pcm: Float32Array; rms: number } }) => void;

const fake = {
  tracks: [] as Track[],
  worklets: [] as { port: { onmessage: Frame | null } }[],
  gum: vi.fn(),
};

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

function stream() {
  const t = { stop: vi.fn() };
  fake.tracks.push(t);
  return { getTracks: () => [t] };
}

vi.stubGlobal("AudioContext", FakeAudioContext);
vi.stubGlobal("AudioWorkletNode", FakeWorklet);
vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: fake.gum }, language: "en-US" });

import { WebSpeechStt, WhisperStt, type SttHandlers } from "./engines";
import { resetMicGateForTests, setMicEnabledLocal, useMic } from "./mic-gate";
import { useSettings } from "@/stores/settings";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const LOUD = 0.1; // -20 dBFS
const QUIET = 0.0001; // -80 dBFS
const frame = (rms: number) => ({ data: { pcm: new Float32Array(1024), rms } });

function handlers(): SttHandlers & { [K in keyof SttHandlers]-?: ReturnType<typeof vi.fn> } {
  return { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onPhase: vi.fn() };
}

const vad0 = { ...useSettings.getState().vad };

beforeEach(() => {
  resetMicGateForTests();
  fake.tracks = [];
  fake.worklets = [];
  fake.gum.mockReset();
  fake.gum.mockImplementation(async () => stream());
  h.nativeRaw.mockReset();
  h.nativeRaw.mockResolvedValue("hello tony");
  useSettings.getState().set({ vad: { ...vad0, activationDb: -44 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mic locked off: zero capture, zero STT", () => {
  it("(1) a WhisperStt start never touches the mic or Whisper", async () => {
    const hh = handlers();
    new WhisperStt().start(hh);
    await flush();
    expect(fake.gum).not.toHaveBeenCalled();
    expect(fake.worklets).toHaveLength(0);
    expect(h.nativeRaw).not.toHaveBeenCalled();
    expect(hh.onError).toHaveBeenCalledWith("Mic is locked off");
    expect(useMic.getState().live).toBe(0);
  });

  it("(2) muting mid-utterance stops every track; nothing reaches Whisper; the stream ends dead", async () => {
    vi.useFakeTimers();
    setMicEnabledLocal(true);
    const hh = handlers();
    const stt = new WhisperStt();
    stt.start(hh);
    await flush();
    expect(fake.gum).toHaveBeenCalledTimes(1);
    expect(fake.worklets).toHaveLength(1);
    expect(useMic.getState().live).toBe(1);
    const push = fake.worklets[0].port.onmessage!;
    for (let i = 0; i < 40; i++) push(frame(LOUD));
    expect(hh.onPhase).toHaveBeenCalledWith("speech"); // the gate opened: an utterance is in progress

    setMicEnabledLocal(false); // the Mic switch
    expect(fake.tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(useMic.getState().live).toBe(0);
    expect(fake.worklets[0].port.onmessage).toBeNull();

    // Frames that raced the mute (the old handler still called) and a long quiet tail that would
    // have ended the utterance: nothing is handed on.
    for (let i = 0; i < 100; i++) push(frame(i < 50 ? LOUD : QUIET));
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(h.nativeRaw).not.toHaveBeenCalled();
    expect(hh.onFinal).not.toHaveBeenCalled();
    expect(hh.onPhase).not.toHaveBeenCalledWith("transcribing");
    expect(useMic.getState().live).toBe(0);
    expect(fake.gum).toHaveBeenCalledTimes(1); // and nothing reopened the mic
  });

  it("(2b) control: with the mic live the same utterance does reach Whisper once", async () => {
    setMicEnabledLocal(true);
    const hh = handlers();
    new WhisperStt().start(hh);
    await flush();
    const push = fake.worklets[0].port.onmessage!;
    for (let i = 0; i < 40; i++) push(frame(LOUD));
    for (let i = 0; i < 60; i++) push(frame(QUIET)); // > 700 ms of quiet ends it
    await flush();
    expect(h.nativeRaw).toHaveBeenCalledTimes(1);
    expect(h.nativeRaw.mock.calls[0][0]).toBe("stt_transcribe");
    expect(hh.onFinal).toHaveBeenCalledWith("hello tony");
    expect(useMic.getState().live).toBe(0); // the capture released the mic after the utterance
  });

  it("(3) muted while getUserMedia is pending: the late tracks are stopped, no worklet is built", async () => {
    setMicEnabledLocal(true);
    let resolve: (s: ReturnType<typeof stream>) => void = () => undefined;
    fake.gum.mockImplementation(() => new Promise((r) => (resolve = r)));
    const hh = handlers();
    new WhisperStt().start(hh);
    await flush();
    expect(fake.gum).toHaveBeenCalledTimes(1);
    setMicEnabledLocal(false);
    resolve(stream());
    await flush();
    expect(fake.tracks[0].stop).toHaveBeenCalled();
    expect(fake.worklets).toHaveLength(0);
    expect(useMic.getState().live).toBe(0);
    expect(h.nativeRaw).not.toHaveBeenCalled();
    expect(hh.onFinal).not.toHaveBeenCalled();
  });

  it("(4) Web Speech: abort() really aborts, a mute aborts too, and late results are dropped", async () => {
    const recs: { abort: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onresult: ((e: unknown) => void) | null; onend: (() => void) | null }[] = [];
    class FakeSR {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror = null;
      onend: (() => void) | null = null;
      onspeechstart = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        recs.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeSR });
    const result = { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "turn it up" } }] };

    // Locked off: the cloud recognizer is never constructed.
    const locked = handlers();
    new WebSpeechStt().start(locked);
    expect(recs).toHaveLength(0);
    expect(locked.onError).toHaveBeenCalledWith("Mic is locked off");

    setMicEnabledLocal(true);
    const ws = new WebSpeechStt();
    const a = handlers();
    ws.start(a);
    ws.abort();
    expect(recs[0].abort).toHaveBeenCalledTimes(1);
    recs[0].onresult?.(result);
    recs[0].onend?.();
    expect(a.onPartial).not.toHaveBeenCalled();
    expect(a.onFinal).not.toHaveBeenCalled();

    const b = handlers();
    ws.start(b);
    setMicEnabledLocal(false); // the gate aborts the live recognizer
    expect(recs[1].abort).toHaveBeenCalledTimes(1);
    recs[1].onresult?.(result);
    recs[1].onend?.();
    expect(b.onPartial).not.toHaveBeenCalled();
    expect(b.onFinal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: fake.gum }, language: "en-US" });
  });
});

describe("the activation threshold is read per frame", () => {
  it("(5) moving the slider mid-stream changes the decision on the very next frame", async () => {
    setMicEnabledLocal(true);
    useSettings.getState().set({ vad: { ...vad0, activationDb: -20 } });
    const hh = handlers();
    const stt = new WhisperStt();
    stt.start(hh);
    await flush();
    const push = fake.worklets[0].port.onmessage!;
    const MID = 0.0316; // ≈ -30 dBFS: under a -20 gate, over a -44 one
    for (let i = 0; i < 20; i++) push(frame(MID));
    expect(hh.onPhase).not.toHaveBeenCalledWith("speech");
    expect(useMic.getState().activeMeter?.thrDb).toBe(-20);

    useSettings.getState().set({ vad: { ...useSettings.getState().vad, activationDb: -44 } });
    push(frame(MID));
    expect(useMic.getState().activeMeter?.thrDb).toBe(-44); // the very next frame
    push(frame(MID));
    push(frame(MID)); // 3 frames × 21.3 ms ≥ the 60 ms onset
    expect(hh.onPhase).toHaveBeenCalledWith("speech");
    stt.abort();
    expect(useMic.getState().live).toBe(0);
  });
});
