import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P4 through the real voice controller (engines, audio and the gateway stubbed): the barge-in
 * `onError` fix (an STT error over a ducked reply un-ducks Tony, keeps him "speaking", re-arms the
 * barge-in listen a bounded number of times, and the follow-up listen still opens), which listens
 * lower the music at listen start, and the `ttsIdle` hold the music duck waits for.
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  speak: vi.fn(),
  ttsCancel: vi.fn(),
  ttsDuck: vi.fn(),
  sttStart: vi.fn(),
  sttAbort: vi.fn(),
  duckOnTrigger: vi.fn(),
  duckOnSpeech: vi.fn(),
  settleCommand: vi.fn(),
  restoreDuck: vi.fn(),
  settings: { osName: "Tony", wakeMode: false, wakeRequire: true, wakeWords: ["hey tony"], confirmTimeoutSec: 30, routing: { announcerHandoff: false }, conversation: { audioRoute: "auto", bargeIn: true, followUp: true, followUpSecs: 6, bargeEndSilenceMs: 500 } },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false, useSettings: { getState: () => ({ ...h.settings, set: (p: Partial<typeof h.settings>) => Object.assign(h.settings, p) }) } }));
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
vi.mock("@/features/orchestrator/execute", () => ({ execute: vi.fn() }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: vi.fn(), queueDesktopTurn: vi.fn() }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: () => null,
  createEngines: () => ({
    stt: { name: "test-stt", start: h.sttStart, stop: vi.fn(), abort: h.sttAbort },
    tts: { supported: true, name: "test", speak: h.speak, cancel: h.ttsCancel, duck: h.ttsDuck },
  }),
}));
vi.mock("@/features/voice/audio-route", () => ({ bargeSensitivityOffset: () => -30, detectRoute: async () => "headset", detectedRoute: () => "headset", effectiveRoute: () => "headset" }));
vi.mock("@/features/voice/media-hold", () => ({ cutMedia: async () => undefined, holdMedia: async () => ({}), releaseMedia: async () => undefined }));
vi.mock("@/features/voice/spotify-duck", () => ({
  duckOnSpeech: h.duckOnSpeech,
  duckOnTrigger: h.duckOnTrigger,
  musicPlayingHere: () => false,
  restoreAfterPause: vi.fn(),
  restoreDuck: h.restoreDuck,
  scheduleRestore: vi.fn(),
  settleCommand: h.settleCommand,
  settleNoise: vi.fn(),
}));

import { useVoice } from "./voice-store";
import { handleInput, startListening, stopVoice, ttsIdle } from "./voice-controller";
import { useMic } from "./mic-gate";

// Phase 2 Part B: the mic gate fails closed until hydrated; these suites run with the mic live.
useMic.setState({ enabled: true, hydrated: true });

type Handlers = { onPhase: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
const handlers = (i: number) => h.sttStart.mock.calls[i][0] as Handlers;
const startOpts = (i: number) => h.sttStart.mock.calls[i][1] as Record<string, unknown>;

function later() {
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  return { p, done };
}

/** Speech in flight; a cancel ends it, like the real engine (a stale generation returns). */
let speaking: Array<() => void> = [];

beforeEach(() => {
  stopVoice(); // module state from the previous test
  for (const r of speaking.splice(0)) r();
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null });
  for (const f of [h.cmd, h.speak, h.ttsCancel, h.ttsDuck, h.sttStart, h.sttAbort, h.duckOnTrigger, h.duckOnSpeech, h.settleCommand, h.restoreDuck]) f.mockReset();
  h.settings.wakeMode = false;
  h.ttsCancel.mockImplementation(() => {
    for (const r of speaking.splice(0)) r();
  });
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "It's sunny.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

/** A voice turn whose spoken reply stays in flight until `speech.done()`; resolves once the barge-in listen is open. */
async function tonySpeaking() {
  const speech = later();
  speaking.push(speech.done);
  h.speak.mockImplementation(() => speech.p);
  const turn = handleInput("what's the weather", { channel: "voice", origin: "tap" });
  await vi.waitFor(() => expect(h.sttStart).toHaveBeenCalledTimes(1));
  expect(startOpts(0)).toMatchObject({ maxSilenceStartMs: 120_000 }); // the barge-in listen
  expect(useVoice.getState().state).toBe("speaking");
  return { speech, turn };
}

describe("barge-in onError (P4 fix)", () => {
  it("un-ducks Tony, keeps him 'speaking', re-arms the barge-in, and the follow-up listen still opens", async () => {
    const { speech, turn } = await tonySpeaking();
    handlers(0).onPhase("speech"); // you talk over him
    expect(h.ttsDuck).toHaveBeenLastCalledWith(true);
    handlers(0).onError("whisper timed out");
    expect(h.ttsDuck).toHaveBeenLastCalledWith(false);
    expect(h.restoreDuck).toHaveBeenCalled();
    expect(useVoice.getState().state).toBe("speaking"); // not "error" while he's still talking
    expect(h.sttStart).toHaveBeenCalledTimes(2);
    expect(startOpts(1)).toMatchObject({ maxSilenceStartMs: 120_000 });
    speech.done();
    await turn;
    // `barged` was reset, so the reply ends in the follow-up window (it used to return early).
    expect(h.sttStart).toHaveBeenCalledTimes(3);
    expect(startOpts(2)).toEqual({ maxSilenceStartMs: 6000, partials: expect.any(Function) }); // captions are opt-in: it asks
    expect(useVoice.getState().state).toBe("listening");
  });

  it("a mic that keeps failing re-arms only a bounded number of times", async () => {
    const { speech, turn } = await tonySpeaking();
    for (let i = 0; i < 5; i++) handlers(h.sttStart.mock.calls.length - 1).onError("no mic");
    expect(h.sttStart).toHaveBeenCalledTimes(3); // the first listen + 2 re-arms
    expect(useVoice.getState().state).toBe("speaking");
    speech.done();
    await turn;
  });

  it("an error with Tony quiet still shows the error", async () => {
    const { speech, turn } = await tonySpeaking();
    speech.done();
    await turn;
    expect(h.sttStart).toHaveBeenCalledTimes(3 - 1); // barge-in + follow-up
    handlers(1).onError("whisper timed out");
    expect(useVoice.getState().state).toBe("error");
    expect(useVoice.getState().error).toBe("whisper timed out");
    expect(h.sttStart).toHaveBeenCalledTimes(2);
  });

  it("the follow-up listen ducks the music only like a passive listen (onWakeListen)", async () => {
    const { speech, turn } = await tonySpeaking();
    handlers(0).onPhase("speech"); // over Tony: an explicit barge-in
    expect(h.duckOnSpeech).toHaveBeenLastCalledWith(false);
    handlers(0).onFinal(""); // noise: keep listening over the rest of the reply
    speech.done();
    await turn;
    const follow = h.sttStart.mock.calls.length - 1;
    expect(startOpts(follow)).toEqual({ maxSilenceStartMs: 6000, partials: expect.any(Function) });
    handlers(follow).onPhase("speech");
    expect(h.duckOnSpeech).toHaveBeenLastCalledWith(true);
  });
});

describe("music duck triggers and the ttsIdle hold (P4)", () => {
  it("explicit listens duck at listen start; a passive wake listen waits for the VAD", () => {
    startListening({ origin: "tap" });
    expect(h.duckOnTrigger).toHaveBeenCalledTimes(1);
    stopVoice();
    startListening({ silent: true, origin: "wake" });
    expect(h.duckOnTrigger).toHaveBeenCalledTimes(1);
    stopVoice();
    startListening({ forConfirmation: true, silent: true, origin: "wake" }); // a yes/no card
    expect(h.duckOnTrigger).toHaveBeenCalledTimes(2);
    stopVoice();
  });

  it("a command line hands its turn and ttsIdle to settleCommand", () => {
    startListening({ origin: "tap" });
    handlers(0).onFinal("what time is it");
    expect(h.settleCommand).toHaveBeenCalledTimes(1);
    expect(h.settleCommand.mock.calls[0][1]).toBe(ttsIdle);
  });

  it("ttsIdle waits for Tony's speech and resolves at once on a hard stop", async () => {
    let quiet = false;
    void ttsIdle().then(() => (quiet = true));
    await Promise.resolve();
    expect(quiet).toBe(true); // nothing speaking: resolves at once
    const { turn } = await tonySpeaking();
    let idle = false;
    void ttsIdle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);
    stopVoice(); // cancel: the speak() promise may still be awaiting its synthesis
    await vi.waitFor(() => expect(idle).toBe(true));
    void turn;
  });
});
