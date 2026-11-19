import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fix pass, through the real voice controller (engines, audio and the gateway stubbed):
 *  - the listen after the bare-"Hey Tony" greeting takes Nic's answer without a second wake word;
 *  - after a stand-down, the gabagool flavour line never plays into a mic Nic has just opened.
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
  sttStart: vi.fn(),
  sttAbort: vi.fn(),
  settleCommand: vi.fn(),
  settleNoise: vi.fn(),
  settings: { osName: "Tony", wakeMode: false, wakeRequire: true, wakeWords: ["hey tony"], confirmTimeoutSec: 30, routing: { announcerHandoff: false, autoSwitch: false }, conversation: { audioRoute: "auto", bargeIn: true, followUp: false, followUpSecs: 6, bargeEndSilenceMs: 500 } },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({ useSettings: { getState: () => ({ ...h.settings, set: (p: Partial<typeof h.settings>) => Object.assign(h.settings, p) }) } }));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: null }) }, osName: () => "Tony", useOsName: () => "Tony" }));
vi.mock("@/sections/settings/use-providers", () => ({ useProviders: { getState: () => ({ view: null, load: async () => undefined }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ cueFor: () => null, fireCue: vi.fn(), registerCueIO: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, registerSpeechCancel: vi.fn(), setCueDuck: vi.fn(), stopAllAudio: vi.fn() }));
vi.mock("@/features/os/os-intents", () => ({ cuePlayingNow: () => false, parseOsLine: () => null, runOsIntent: vi.fn() }));
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: async () => null, runPendingSpotify: vi.fn(), runSpotifyIntent: vi.fn() }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: vi.fn(), usePipelines: { getState: () => ({ offered: null, setOffered: vi.fn() }) } }));
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
    tts: { supported: true, name: "test", speak: h.speak, cancel: h.ttsCancel, duck: vi.fn() },
  }),
}));
vi.mock("@/features/voice/audio-route", () => ({ bargeSensitivityOffset: () => -30, detectRoute: async () => "headset", detectedRoute: () => "headset", effectiveRoute: () => "headset" }));
vi.mock("@/features/voice/media-hold", () => ({ cutMedia: async () => undefined, holdMedia: async () => ({}), releaseMedia: async () => undefined }));
vi.mock("@/features/voice/spotify-duck", () => ({
  duckOnSpeech: vi.fn(),
  duckOnTrigger: vi.fn(),
  musicPlayingHere: () => false,
  restoreAfterPause: vi.fn(),
  restoreDuck: vi.fn(),
  scheduleRestore: vi.fn(),
  settleCommand: h.settleCommand,
  settleNoise: h.settleNoise,
}));

import { useVoice } from "./voice-store";
import { setWakeMode, standDown, startListening, stopVoice } from "./voice-controller";
import { FLAVOUR, GREETING } from "./persona";

type Handlers = { onPhase: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
const lastHandlers = () => h.sttStart.mock.calls[h.sttStart.mock.calls.length - 1][0] as Handlers;
const spoken = () => h.speak.mock.calls.map((c) => c[0] as string);
const osTurnTexts = () => h.cmd.mock.calls.filter((c) => c[0] === "os_turn").map((c) => (c[1] as { req: { text: string } }).req.text);

/** Speech in flight until a cancel (like the real engine). */
let speaking: Array<() => void> = [];

beforeEach(() => {
  setWakeMode(false);
  stopVoice();
  for (const r of speaking.splice(0)) r();
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null });
  for (const f of [h.cmd, h.speak, h.ttsCancel, h.sttStart, h.sttAbort, h.settleCommand, h.settleNoise]) f.mockReset();
  h.ttsCancel.mockImplementation(() => {
    for (const r of speaking.splice(0)) r();
  });
  h.speak.mockResolvedValue(undefined);
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "It's sunny.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setWakeMode(false);
});

describe("bare 'Hey Tony' greeting → the answer needs no second wake word", () => {
  it("greets, opens a listen, and Nic's answer is a turn (not dropped as room talk)", async () => {
    setWakeMode(true); // hands-free on, wakeRequire on (the default)
    startListening({ silent: true, origin: "wake" }); // the passive wake listen
    const before = h.sttStart.mock.calls.length;
    lastHandlers().onFinal("Hey Tony");
    await vi.waitFor(() => expect(h.sttStart.mock.calls.length).toBe(before + 1)); // greeting, then a listen
    expect(spoken()).toContain(GREETING);
    expect(useVoice.getState().state).toBe("listening");
    lastHandlers().onFinal("what's the weather?");
    expect(h.settleNoise).not.toHaveBeenCalled(); // not treated as room talk
    expect(h.settleCommand).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(osTurnTexts()).toContain("what's the weather?"));
  });

  it("an ordinary wake listen still needs the wake word", async () => {
    setWakeMode(true);
    startListening({ silent: true, origin: "wake" });
    lastHandlers().onFinal("what's the weather?");
    expect(h.settleNoise).toHaveBeenCalledTimes(1);
    expect(h.settleCommand).not.toHaveBeenCalled();
    expect(osTurnTexts()).toHaveLength(0);
  });
});

describe("stand-down ack → no flavour line into an open mic", () => {
  it("a tap during the stand-down line: the flavour never plays", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the rare draw always hits
    const ack = new Promise<void>((r) => speaking.push(r));
    h.speak.mockImplementationOnce(() => ack);
    standDown("voice");
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    startListening(); // Nic taps the orb while Tony is still saying the stand-down line
    await ack;
    await new Promise((r) => setTimeout(r, 0));
    expect(useVoice.getState().state).toBe("listening");
    expect(spoken()).not.toContain(FLAVOUR);
  });

  it("with nothing listening the flavour can still follow (same draw)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    standDown("voice");
    await vi.waitFor(() => expect(spoken()).toContain(FLAVOUR));
  });
});
