import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live captions through the real voice controller (engines, audio and the gateway stubbed): every
 * listen it opens asks for captions (they are opt-in in engines.ts) except hands-free's passive
 * wake listen, and a listen that ends without an onFinal (abort() fires no handlers: a tap on
 * Approve / Reject, the confirm timer, Resume) leaves no caption on the HUD or the orb.
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  execute: vi.fn(),
  speak: vi.fn(),
  ttsCancel: vi.fn(),
  ttsPause: vi.fn(),
  ttsResume: vi.fn(),
  sttStart: vi.fn(),
  sttStop: vi.fn(),
  sttAbort: vi.fn(),
  settings: {
    osName: "Tony",
    wakeMode: false,
    wakeRequire: true,
    wakeWords: ["hey tony"],
    confirmTimeoutSec: 30,
    routing: { announcerHandoff: false },
    conversation: { audioRoute: "auto", bargeIn: true, followUp: true, followUpSecs: 6, bargeEndSilenceMs: 500 },
  },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false,
  useSettings: { getState: () => ({ ...h.settings, set: (patch: Partial<typeof h.settings>) => Object.assign(h.settings, patch) }) },
}));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: null }) }, osName: () => "Tony", useOsName: () => "Tony" }));
vi.mock("@/sections/settings/use-providers", () => ({ useProviders: { getState: () => ({ view: null, load: async () => undefined }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ cueFor: () => null, fireCue: vi.fn(), registerCueIO: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, registerSpeechCancel: vi.fn(), setCueDuck: vi.fn(), stopAllAudio: vi.fn() }));
vi.mock("@/features/os/os-intents", () => ({ cuePlayingNow: () => false, parseOsLine: () => null, runOsIntent: vi.fn() }));
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: async () => null, runPendingSpotify: vi.fn(), runSpotifyIntent: vi.fn() }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: vi.fn(), trackTask: vi.fn(), usePipelines: { getState: () => ({ runs: {}, recent: {} }) } }));
vi.mock("@/features/os/context", () => ({ liveContext: async () => "" }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: async () => null }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_o: unknown, call: (approved: boolean) => Promise<unknown>) => call(false) }));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: vi.fn(), queueDesktopTurn: vi.fn() }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: () => null,
  createEngines: () => ({
    stt: { name: "fake", supported: true, start: h.sttStart, stop: h.sttStop, abort: h.sttAbort },
    tts: { supported: true, name: "test", speak: h.speak, cancel: h.ttsCancel, pause: h.ttsPause, resume: h.ttsResume },
  }),
}));
vi.mock("@/features/voice/audio-route", () => ({ detectRoute: async () => "headset", detectedRoute: () => "headset", effectiveRoute: () => "headset" }));
vi.mock("@/features/voice/media-hold", () => ({ cutMedia: async () => undefined, holdMedia: async () => ({}), releaseMedia: async () => undefined }));
vi.mock("@/features/voice/spotify-duck", () => ({
  duckOnSpeech: vi.fn(),
  duckOnTrigger: vi.fn(),
  musicPlayingHere: () => false,
  restoreAfterPause: vi.fn(),
  restoreDuck: vi.fn(),
  scheduleRestore: vi.fn(),
  settleCommand: vi.fn(),
  settleNoise: vi.fn(),
}));

import { heuristicPlan } from "@/features/orchestrator/plan";
import { useVoice } from "./voice-store";
import { approve, reject, requestConfirmation, resumeHold, startListening, stopVoice } from "./voice-controller";
import { setMicEnabledLocal } from "./mic-gate";

type Handlers = { onPartial: (t: string) => void; onPhase?: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
type Opts = { partials?: () => boolean; maxSilenceStartMs?: number };
const last = () => h.sttStart.mock.calls.at(-1) as [Handlers, Opts];
const partial = () => useVoice.getState().partial;

beforeEach(() => {
  vi.useRealTimers();
  h.settings.wakeMode = false;
  setMicEnabledLocal(true);
  stopVoice();
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null, partial: "" });
  for (const f of [h.cmd, h.execute, h.speak, h.ttsCancel, h.ttsPause, h.ttsResume, h.sttStart, h.sttStop, h.sttAbort]) f.mockReset();
  h.speak.mockResolvedValue(undefined);
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "Here's the weather.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

function emailPlan() {
  const plan = heuristicPlan("send Sam an email saying hi", "general");
  plan.mutating = true;
  plan.run = async () => ({ text: "sent", meta: "" });
  return plan;
}

/** A voice confirmation card whose yes/no listen is showing a caption. */
async function captionedConfirmListen(caption: string) {
  await requestConfirmation(emailPlan(), "voice"); // the read-back, then the yes/no listen
  expect(h.sttStart).toHaveBeenCalledTimes(1);
  const [hh, opts] = last();
  expect(opts.partials?.()).toBe(true); // a yes/no listen asks for captions
  hh.onPartial(caption);
  expect(partial()).toBe(caption);
}

describe("an aborted listen leaves no caption behind", () => {
  it("Approve tapped mid-sentence during a captioned confirm listen", async () => {
    await captionedConfirmListen("yeah go ahead and");
    const done = approve("tap");
    expect(h.sttAbort).toHaveBeenCalled(); // no onFinal will clear it
    expect(partial()).toBe("");
    await done;
    expect(partial()).toBe("");
  });

  it("Reject tapped, and the confirm timer's reject('timed out')", async () => {
    await captionedConfirmListen("no wait");
    reject("dismissed");
    expect(partial()).toBe("");

    vi.useFakeTimers();
    await captionedConfirmListen2("send it to");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(useVoice.getState().pending).toBeNull();
    expect(partial()).toBe("");
  });

  it("Resume during a hold listen, with and without held segments (clearHold clears it)", async () => {
    await holdWithCaption("and also");
    resumeHold(); // nothing held: Tony picks up again
    expect(partial()).toBe("");

    await holdWithCaption("and a chart", "add a pricing table");
    resumeHold(); // something held: sent as one turn (submitHold)
    expect(partial()).toBe("");
  });
});

describe("a listen whose final fails (onError) leaves no caption behind", () => {
  it("a tapped listen", () => {
    startListening({ origin: "tap" });
    const [hh] = last();
    hh.onPhase?.("speech");
    hh.onPartial("turn on the");
    expect(partial()).toBe("turn on the");
    hh.onError("Whisper: timed out");
    expect(useVoice.getState().state).toBe("error");
    expect(partial()).toBe("");
    useVoice.getState().setState("thinking"); // the next turn's state: no stale caption comes back on the orb
    expect(partial()).toBe("");
  });

  it("the barge-in over Tony ('cut...' then Whisper fails): he keeps speaking, the caption goes", async () => {
    h.speak.mockImplementation(() => new Promise<void>(() => undefined)); // he is still talking
    startListening({ origin: "tap" });
    last()[0].onFinal("what's the weather");
    await vi.waitFor(() => expect(last()[1].maxSilenceStartMs).toBe(120_000));
    const barge = last()[0];
    barge.onPhase?.("speech");
    barge.onPartial("cut");
    expect(partial()).toBe("cut");
    barge.onError("Whisper: timed out");
    expect(useVoice.getState().state).toBe("speaking");
    expect(partial()).toBe("");
  });

  it("a hold listen", async () => {
    await holdWithCaption("and a chart");
    last()[0].onError("Whisper: timed out");
    expect(useVoice.getState().state).toBe("holding");
    expect(partial()).toBe("");
    stopVoice();
  });
});

describe("which listens ask for captions", () => {
  it("a tapped listen, the barge-in, the hold and the follow-up do; hands-free's passive wake listen doesn't", async () => {
    startListening({ silent: true, origin: "wake" });
    expect(last()[1].partials?.()).toBe(false);
    stopVoice();
    startListening({ origin: "tap" });
    expect(last()[1].partials?.()).toBe(true);
    let finish: () => void = () => undefined;
    h.speak.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    last()[0].onFinal("what's the weather");
    await vi.waitFor(() => expect(last()[1].maxSilenceStartMs).toBe(120_000)); // the barge-in over Tony
    expect(last()[1].partials?.()).toBe(true);
    finish();
    await vi.waitFor(() => expect(last()[1].maxSilenceStartMs).toBe(6000)); // the follow-up window
    expect(last()[1].partials?.()).toBe(true);
  });
});

/** Like captionedConfirmListen, under fake timers (the read-back resolves at once). */
async function captionedConfirmListen2(caption: string) {
  h.sttStart.mockClear();
  await requestConfirmation(emailPlan(), "voice");
  expect(h.sttStart).toHaveBeenCalledTimes(1);
  last()[0].onPartial(caption);
  expect(partial()).toBe(caption);
}

/** Tony replying, "whoa" said over him (a hold), then `held` segments and a caption in the hold listen. */
async function holdWithCaption(caption: string, ...held: string[]) {
  stopVoice();
  h.sttStart.mockClear();
  h.speak.mockImplementation(() => new Promise<void>(() => undefined)); // he is still talking
  startListening({ origin: "tap" });
  last()[0].onFinal("what's the weather");
  await vi.waitFor(() => expect(last()[1].maxSilenceStartMs).toBe(120_000));
  const barge = last()[0];
  barge.onPhase?.("speech");
  barge.onFinal("whoa");
  expect(useVoice.getState().state).toBe("holding");
  for (const s of held) last()[0].onFinal(s);
  const [hold, opts] = last();
  expect(opts.partials?.()).toBe(true);
  hold.onPartial(caption);
  expect(partial()).toBe(caption);
}
