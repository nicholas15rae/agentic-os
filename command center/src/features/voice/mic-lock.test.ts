import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 Part B through the real voice controller (engines, audio and the gateway stubbed):
 * while the mic is locked off, no path opens a listen (hands-free, a tap, a reply's follow-up /
 * barge-in, hold, the confirmation re-listen) and nothing speaks unsolicited (narration,
 * reminders, the timed-out "Cancelled."). Muting mid-listen aborts it and nothing re-arms.
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
import { announce, handleInput, holdWake, killTurn, narrate, requestConfirmation, resumeHold, setWakeMode, startListening, stopVoice, toggleListening } from "./voice-controller";
import { micEnabled, setMicEnabledLocal } from "./mic-gate";

const texts = () => useVoice.getState().turns.map((t) => t.text);

beforeEach(async () => {
  vi.useRealTimers();
  // Back to a clean, locked state through the real lock path.
  h.settings.wakeMode = false;
  setMicEnabledLocal(true);
  stopVoice();
  setMicEnabledLocal(false);
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null });
  for (const f of [h.cmd, h.execute, h.speak, h.ttsCancel, h.ttsPause, h.ttsResume, h.sttStart, h.sttStop, h.sttAbort]) f.mockReset();
  h.speak.mockResolvedValue(undefined);
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "Here's the weather.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
  vi.useFakeTimers();
});

describe("mic locked off: nothing opens a listen", () => {
  it("hands-free stays suspended (its preference is kept)", async () => {
    setWakeMode(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.sttStart).not.toHaveBeenCalled();
    expect(h.settings.wakeMode).toBe(true); // D7: the preference survives the lock
  });

  it("a tap / hotkey toggle opens nothing and says why", () => {
    toggleListening();
    expect(h.sttStart).not.toHaveBeenCalled();
    expect(useVoice.getState().error).toBe("Mic is locked off");
  });

  it("passive callers (a silent wake listen, a yes/no re-listen) stay silent and keep the state", () => {
    startListening({ silent: true, origin: "wake" });
    useVoice.setState({ state: "confirming" });
    startListening({ forConfirmation: true, origin: "tap" });
    expect(h.sttStart).not.toHaveBeenCalled();
    expect(useVoice.getState().state).toBe("confirming");
    expect(useVoice.getState().error).toBeNull();
  });

  it("a typed turn still gets its reply, with no barge-in or follow-up listen", async () => {
    await handleInput("what's the weather", { channel: "text" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(texts()).toContain("Here's the weather.");
    expect(h.sttStart).not.toHaveBeenCalled();
  });

  it("hold: entering / releasing / resuming never listens", async () => {
    holdWake(true);
    holdWake(false);
    resumeHold();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.sttStart).not.toHaveBeenCalled();
  });
});

describe("mic locked off: no unsolicited speech (D6)", () => {
  it("narration and reminder announcements are dropped", async () => {
    await narrate("Coder finished the build.", "coder");
    await announce("Reminder. Call Sam.");
    expect(h.speak).not.toHaveBeenCalled();
  });

  it("a voice card that times out is cancelled without a spoken 'Cancelled.'", async () => {
    setMicEnabledLocal(true);
    const plan = heuristicPlan("send Sam an email saying hi", "general");
    plan.mutating = true;
    plan.run = async () => ({ text: "sent", meta: "" });
    await requestConfirmation(plan, "voice"); // speaks its read-back, then listens for yes/no
    expect(h.speak).toHaveBeenCalledTimes(1);
    setMicEnabledLocal(false);
    h.speak.mockClear();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(useVoice.getState().pending).toBeNull();
    expect(texts().some((t) => /Cancelled \(timed out\)/.test(t))).toBe(true);
    expect(h.speak).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("muting a live mic", () => {
  it("aborts the open listen, and nothing re-arms (the old ~361 rearm leak)", async () => {
    setMicEnabledLocal(true);
    setWakeMode(true);
    await vi.advanceTimersByTimeAsync(700); // hands-free opens its wake listen
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    setMicEnabledLocal(false);
    expect(h.sttAbort).toHaveBeenCalled();
    expect(useVoice.getState().state).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    expect(micEnabled()).toBe(false);
    // Unlocking brings hands-free back, because it is still the preference.
    setMicEnabledLocal(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.sttStart).toHaveBeenCalledTimes(2);
  });

  it("an explicit listen is aborted by the mute and never transcribed", async () => {
    setMicEnabledLocal(true);
    startListening({ origin: "tap" });
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    setMicEnabledLocal(false);
    expect(h.sttAbort).toHaveBeenCalled();
    expect(useVoice.getState().state).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
  });
});

describe("muting during a hold (fix pass)", () => {
  it("drops the paused reply so a later say() is not stuck behind a paused engine", async () => {
    setMicEnabledLocal(true);
    let finishSpeech: () => void = () => undefined;
    h.speak.mockImplementation(() => new Promise<void>((r) => (finishSpeech = r)));
    startListening({ origin: "tap" });
    const first = h.sttStart.mock.calls[0][0];
    first.onFinal("what's the weather");
    await vi.advanceTimersByTimeAsync(50);
    expect(h.speak).toHaveBeenCalled(); // Tony is replying; the barge-in listen is open
    const barge = h.sttStart.mock.calls.at(-1)![0];
    barge.onPhase?.("speech");
    barge.onFinal("whoa");
    expect(useVoice.getState().state).toBe("holding");
    expect(h.ttsPause).toHaveBeenCalled();
    h.ttsCancel.mockClear();
    setMicEnabledLocal(false);
    expect(h.ttsCancel).toHaveBeenCalled();
    expect(useVoice.getState().held).toBeNull();
    finishSpeech();
  });
});

describe("mic on: stop vs cut (D8 regression)", () => {
  it("stopVoice (Esc / close) turns hands-free off so nothing reopens the mic, even a later cut", async () => {
    setMicEnabledLocal(true);
    setWakeMode(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    stopVoice();
    expect(h.settings.wakeMode).toBe(false); // the UI no longer claims hands-free is on
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    killTurn();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
  });

  it("killTurn ('cut it') re-arms hands-free", async () => {
    setMicEnabledLocal(true);
    setWakeMode(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    killTurn();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sttStart).toHaveBeenCalledTimes(2);
  });
});
