import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C1 phase 2, the Android app: WhisperStt streams the speech to the gateway's WebSocket while you
 * speak, shows its captions, and takes its {final} instead of uploading the WAV. Every failure
 * falls back to today's single upload (`langApi.stt`) with the same audio.
 */
const h = vi.hoisted(() => {
  const m = new Map<string, string>();
  const localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
  Object.assign(globalThis, {
    localStorage,
    // The Android Tauri app: isAndroidApp() is true.
    window: { __TAURI_INTERNALS__: {}, localStorage, addEventListener() {}, removeEventListener() {} },
  });
  return { nativeRaw: vi.fn(), cmd: vi.fn(), langStt: vi.fn() };
});
vi.mock("@/lib/platform", () => ({ isTauri: () => true, nativeRaw: h.nativeRaw, cmd: h.cmd, onNativeEvent: async () => () => undefined }));
vi.mock("@/features/language/api", () => ({ langApi: { stt: h.langStt, tts: vi.fn() } }));
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
const fake = { worklets: [] as { port: { onmessage: Frame | null } }[], sockets: [] as FakeWs[] };

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
class FakeWs {
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    fake.sockets.push(this);
  }
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  json() {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
  pcm(): Int16Array {
    const parts = this.sent.filter((s): s is ArrayBuffer => typeof s !== "string").map((b) => new Int16Array(b));
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  reply(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}
vi.stubGlobal("AudioContext", FakeAudioContext);
vi.stubGlobal("AudioWorkletNode", FakeWorklet);
vi.stubGlobal("WebSocket", FakeWs);
vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, language: "en-US", userAgent: "Mozilla/5.0 (Linux; Android 15)" });

import { WhisperStt, type SttHandlers } from "./engines";
import { resetMicGateForTests, setMicEnabledLocal } from "./mic-gate";
import { useVoice } from "./voice-store";
import { isAndroidApp, useSettings } from "@/stores/settings";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const LOUD = 0.1;
const QUIET = 0.0001;
let phase = 0;
const frame = (rms: number) => {
  const pcm = new Float32Array(1024);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(((phase + i) * 2 * Math.PI * 220) / 48_000) * 0.2;
  phase += 1024;
  return { data: { pcm, rms } };
};
const handlers = (): SttHandlers & { [K in keyof SttHandlers]-?: ReturnType<typeof vi.fn> } => ({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onPhase: vi.fn() });
const vad0 = { ...useSettings.getState().vad };

beforeEach(() => {
  resetMicGateForTests();
  setMicEnabledLocal(true);
  fake.worklets = [];
  fake.sockets = [];
  h.langStt.mockReset();
  h.langStt.mockResolvedValue({ text: "uploaded text" });
  useSettings.getState().set({ vad: { ...vad0, activationDb: -44, partialMs: 600 }, gatewayUrl: "https://100.84.91.149:8443", gatewayToken: "phone-token" });
  useVoice.setState({ state: "listening", turns: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A listen that shows captions (they are opt-in). */
async function listen(opts: Parameters<WhisperStt["start"]>[1] = { partials: () => true }) {
  const hh = handlers();
  const stt = new WhisperStt();
  stt.start(hh, opts);
  await flush();
  const worklet = fake.worklets.at(-1)!;
  const push = (rms: number, n = 1) => {
    for (let i = 0; i < n; i++) worklet.port.onmessage?.(frame(rms));
  };
  return { hh, stt, push };
}

describe("the phone streams its STT", () => {
  it("is the Android app", () => {
    expect(isAndroidApp()).toBe(true);
  });

  it("opens a stream at speech onset, captions from it, and takes its final instead of uploading", async () => {
    const { hh, push } = await listen();
    push(QUIET, 5);
    expect(fake.sockets).toHaveLength(0); // nothing said yet: no socket
    push(LOUD, 30);
    expect(fake.sockets).toHaveLength(1);
    const ws = fake.sockets[0];
    expect(ws.url).toBe("wss://100.84.91.149:8443/api/cc/lang/stt/stream");
    ws.onopen?.({});
    expect(ws.json()[0]).toEqual({ type: "start", lang: "en", partials: true, partial_ms: 600, token: "phone-token" });
    ws.reply({ type: "partial", partial: "Tony cut", stable: "Tony" });
    expect(hh.onPartial).toHaveBeenCalledWith("Tony cut", "Tony");
    push(QUIET, 40); // end of speech
    await flush();
    expect(ws.json().map((m) => m.type)).toEqual(["start", "config", "end"]); // captions paused in the trailing pause
    expect(ws.json()[1]).toEqual({ type: "config", partials: false });
    ws.reply({ type: "final", final: " Tony, cut it. " });
    await flush();
    expect(hh.onFinal).toHaveBeenCalledWith("Tony, cut it.");
    expect(h.langStt).not.toHaveBeenCalled();
    expect(ws.closed).toBe(true);
  });

  it("without `partials` (captions are opt-in) the stream asks for none and still delivers the final", async () => {
    const { hh, push } = await listen({ maxSilenceStartMs: 8000 });
    push(LOUD, 30);
    expect(fake.sockets).toHaveLength(1);
    const ws = fake.sockets[0];
    ws.onopen?.({});
    expect(ws.json()[0]).toMatchObject({ type: "start", partials: false });
    ws.reply({ type: "partial", partial: "stray", stable: "" }); // the gateway shouldn't send one; never shown
    push(QUIET, 40);
    await flush();
    expect(ws.json().filter((m) => m.type === "config" && m.partials)).toEqual([]); // never turned on
    expect(ws.json().at(-1)).toEqual({ type: "end" });
    ws.reply({ type: "final", final: "Note: call Sam." });
    await flush();
    expect(hh.onFinal).toHaveBeenCalledWith("Note: call Sam.");
    expect(hh.onPartial).not.toHaveBeenCalled();
    expect(h.langStt).not.toHaveBeenCalled(); // the stream saved the upload
  });

  it("streams exactly the audio the upload would carry (pre-roll to the ending frame)", async () => {
    let wav: Uint8Array | null = null;
    h.langStt.mockImplementation(async (w: Uint8Array) => {
      wav = w;
      return { text: "uploaded text" };
    });
    const { hh, push } = await listen();
    push(QUIET, 20); // more than the pre-roll before the onset
    push(LOUD, 30);
    const ws = fake.sockets[0];
    ws.onopen?.({});
    push(QUIET, 40);
    await flush();
    ws.reply({ type: "error", error: "unavailable" }); // the gateway can't: the upload carries the same clip
    await flush();
    expect(hh.onFinal).toHaveBeenCalledWith("uploaded text");
    expect(wav).not.toBeNull();
    const uploaded = new Int16Array(wav!.buffer.slice(wav!.byteOffset + 44, wav!.byteOffset + wav!.byteLength));
    expect(uploaded.length).toBeGreaterThan(16_000 * 0.9);
    expect(ws.pcm()).toEqual(uploaded);
  });

  it("falls back to the upload when the socket closes, never opens, or the final is too slow", async () => {
    vi.useFakeTimers();
    // A close mid-stream.
    let l = await listen();
    l.push(LOUD, 30);
    fake.sockets[0].onopen?.({});
    fake.sockets[0].onclose?.({});
    l.push(QUIET, 40);
    await flush();
    expect(l.hh.onFinal).toHaveBeenLastCalledWith("uploaded text");
    expect(h.langStt).toHaveBeenCalledTimes(1);

    // Never opens: broken after 3 s; the end of speech goes straight to the upload.
    l = await listen();
    l.push(LOUD, 30);
    vi.advanceTimersByTime(3100);
    l.push(QUIET, 40);
    await flush();
    expect(h.langStt).toHaveBeenCalledTimes(2);

    // Opens, but no final within its wait.
    l = await listen();
    l.push(LOUD, 30);
    fake.sockets.at(-1)!.onopen?.({});
    l.push(QUIET, 40);
    await flush();
    expect(h.langStt).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(7000);
    await flush();
    expect(h.langStt).toHaveBeenCalledTimes(3);
    expect(l.hh.onFinal).toHaveBeenLastCalledWith("uploaded text");
  });

  it("starts with captions paused while Tony's reply streams; partialMs 0 = no stream at all", async () => {
    useVoice.setState({ state: "thinking" });
    let l = await listen();
    l.push(LOUD, 30);
    fake.sockets[0].onopen?.({});
    expect(fake.sockets[0].json()[0].partials).toBe(false);
    l.stt.abort();
    expect(fake.sockets[0].json().at(-1)).toEqual({ type: "cancel" });

    useVoice.setState({ state: "listening" });
    useSettings.getState().set({ vad: { ...vad0, activationDb: -44, partialMs: 0 } });
    l = await listen();
    l.push(LOUD, 30);
    l.push(QUIET, 40);
    await flush();
    expect(fake.sockets).toHaveLength(1);
    expect(h.langStt).toHaveBeenCalledTimes(1);
  });

  it("a mute aborts the stream: no final, no upload", async () => {
    const l = await listen();
    l.push(LOUD, 30);
    const ws = fake.sockets[0];
    ws.onopen?.({});
    setMicEnabledLocal(false);
    expect(ws.json().at(-1)).toEqual({ type: "cancel" });
    expect(ws.closed).toBe(true);
    l.push(QUIET, 40);
    await flush();
    expect(l.hh.onFinal).not.toHaveBeenCalled();
    expect(h.langStt).not.toHaveBeenCalled();
  });
});
