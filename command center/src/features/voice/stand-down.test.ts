import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P5 stand-down through the real voice controller (engines, audio and the gateway stubbed):
 * "take it easy" said/typed to an idle Tony turns hands-free off (persisted), stops the mic,
 * rejects a pending card silently — never approves it — and never pauses Spotify.
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
  setSettings: vi.fn(),
  cutMedia: vi.fn(),
  restoreDuck: vi.fn(),
  settings: { osName: "Tony", wakeMode: true, wakeRequire: true, wakeWords: ["hey tony"], confirmTimeoutSec: 30, routing: { announcerHandoff: false, autoSwitch: false }, conversation: { audioRoute: "auto", bargeIn: true, followUp: true, followUpSecs: 6, bargeEndSilenceMs: 500 } },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  useSettings: {
    getState: () => ({
      ...h.settings,
      set: (patch: Partial<typeof h.settings>) => {
        h.setSettings(patch);
        Object.assign(h.settings, patch);
      },
    }),
  },
}));
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
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: vi.fn(), queueDesktopTurn: vi.fn() }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: () => null,
  createEngines: () => ({ stt: null, tts: { supported: true, name: "test", speak: h.speak, cancel: h.ttsCancel } }),
}));
vi.mock("@/features/voice/audio-route", () => ({ bargeSensitivityOffset: () => -30, detectRoute: async () => "headset", detectedRoute: () => "headset", effectiveRoute: () => "headset" }));
vi.mock("@/features/voice/media-hold", () => ({ cutMedia: h.cutMedia, holdMedia: async () => ({}), releaseMedia: async () => undefined }));
vi.mock("@/features/voice/spotify-duck", () => ({
  duckOnSpeech: vi.fn(),
  duckOnTrigger: vi.fn(),
  musicPlayingHere: () => false,
  restoreAfterPause: vi.fn(),
  restoreDuck: h.restoreDuck,
  scheduleRestore: vi.fn(),
  settleCommand: vi.fn(),
  settleNoise: vi.fn(),
}));

import { heuristicPlan } from "@/features/orchestrator/plan";
import { useVoice } from "./voice-store";
import { handleInput, requestConfirmation, standDown } from "./voice-controller";
import { STAND_DOWN_LINES } from "./persona";

const texts = () => useVoice.getState().turns.map((t) => t.text);

beforeEach(() => {
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null });
  for (const f of [h.cmd, h.execute, h.speak, h.ttsCancel, h.setSettings, h.cutMedia, h.restoreDuck]) f.mockReset();
  h.settings.wakeMode = true;
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "hi", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

function mutatingPlan() {
  const plan = heuristicPlan("send Sam an email saying hi", "general");
  plan.mutating = true;
  plan.run = async () => ({ text: "sent", meta: "" });
  return plan;
}

describe("stand-down (typed, idle)", () => {
  it("turns hands-free off (persisted), goes idle, says nothing on the typed channel, never pauses Spotify", async () => {
    await handleInput("take it easy", { channel: "text" });
    expect(h.setSettings).toHaveBeenCalledWith({ wakeMode: false });
    expect(h.settings.wakeMode).toBe(false);
    expect(useVoice.getState().state).toBe("idle");
    expect(texts()).toContain("Taking it easy, hands-free off.");
    expect(h.speak).not.toHaveBeenCalled();
    expect(h.cutMedia).not.toHaveBeenCalled(); // a cut pauses Spotify; a stand-down only unducks
    expect(h.restoreDuck).toHaveBeenCalled();
    expect(h.cmd).not.toHaveBeenCalledWith("os_turn", expect.anything()); // never reaches the LLM
  });

  it("with a pending card: rejected silently, never approved, nothing runs", async () => {
    await requestConfirmation(mutatingPlan(), "text");
    expect(useVoice.getState().pending).not.toBeNull();
    await handleInput("Hey, take it easy", { channel: "text" });
    expect(useVoice.getState().pending).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
    expect(texts().some((t) => t.startsWith("Approved"))).toBe(false);
    expect(texts().some((t) => /Cancelled \(stand-down\)/.test(t))).toBe(true);
    expect(h.speak).not.toHaveBeenCalled(); // no spoken "Cancelled."
    expect(h.settings.wakeMode).toBe(false);
  });

  it("with trailing content it is not a stand-down (an ordinary line)", async () => {
    await handleInput("take it easy on the bass in the mix", { channel: "text" });
    expect(h.setSettings).not.toHaveBeenCalled();
    expect(h.settings.wakeMode).toBe(true);
  });

  it("a negated line is not a stand-down", async () => {
    await handleInput("don't take it easy on them", { channel: "text" });
    expect(h.setSettings).not.toHaveBeenCalled();
  });
});

describe("stand-down (voice)", () => {
  it("speaks one short cached ack and nothing re-opens the mic", async () => {
    standDown("voice");
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalled());
    const [line, opts] = h.speak.mock.calls[0];
    expect(STAND_DOWN_LINES).toContain(line);
    expect(opts).toMatchObject({ agent: "general", cache: true });
    expect(opts.utteranceId).toBeUndefined();
    expect(h.settings.wakeMode).toBe(false);
    expect(useVoice.getState().state).toBe("idle");
  });
});
