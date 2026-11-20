import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * Phase 5 through the real voice controller (engines, audio and the gateway stubbed): the vocal
 * handoff cue plays Tony → agent → Tony in their voices when "Vocal Handoffs" is on, is silent when
 * off, never holds up the delegated turn, and a stand-down / hard mic shutoff drops the rest of it.
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
  settings: { osName: "Tony", wakeMode: false, wakeRequire: true, wakeWords: ["hey tony"], confirmTimeoutSec: 30, routing: { announcerHandoff: false, vocalHandoffs: true }, conversation: { audioRoute: "auto", bargeIn: true, followUp: true, followUpSecs: 6, bargeEndSilenceMs: 500 } },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, native: async () => Promise.reject(new Error("no pool file in tests")), isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({ useSettings: { getState: () => ({ ...h.settings, set: (p: Partial<typeof h.settings>) => Object.assign(h.settings, p) }) } }));
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
import { handleInput, startHandoffCue, stopVoice } from "./voice-controller";
import { useMic } from "./mic-gate";
import { useHandoffChip } from "./handoff-cues";

useMic.setState({ enabled: true, hydrated: true });

/** Speech that only ends when the test (or a cancel) says so. */
let pending: Array<() => void> = [];
const voices = () => h.speak.mock.calls.map((c) => (c[1] as { agent?: string; voice?: string })?.agent ?? "?");

beforeEach(() => {
  stopVoice();
  for (const r of pending.splice(0)) r();
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null });
  useMic.setState({ enabled: true, hydrated: true });
  useHandoffChip.setState({ chip: null });
  for (const f of [h.cmd, h.speak, h.ttsCancel, h.ttsDuck, h.sttStart, h.sttAbort]) f.mockReset();
  h.settings.routing.vocalHandoffs = true;
  h.ttsCancel.mockImplementation(() => {
    for (const r of pending.splice(0)) r();
  });
  h.speak.mockImplementation(() => new Promise<void>((r) => pending.push(r)));
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "On it.", steps: [], providerId: "local", latencyMs: 1, routedRole: "coder", routeKind: "Named", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

const finishBeat = async () => {
  pending.shift()?.();
  await new Promise((r) => setTimeout(r, 0));
};

describe("vocal handoff cues (voice controller)", () => {
  it("ON: Tony, then the Coder in its own voice, then Tony", async () => {
    const cue = startHandoffCue("coder")!;
    expect(cue).not.toBeNull();
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    await finishBeat();
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(2));
    await finishBeat();
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(3));
    await finishBeat();
    expect(await cue.done).toBe("completed");
    expect(voices()).toEqual(["general", "coder", "general"]);
    expect(h.speak.mock.calls.map((c) => c[0]).join(" ")).toBe(cue.beats.map((b) => b.text).join(" "));
  });

  it("OFF: no exchange at all", () => {
    h.settings.routing.vocalHandoffs = false;
    expect(startHandoffCue("coder")).toBeNull();
    expect(h.speak).not.toHaveBeenCalled();
  });

  it("hard mic shutoff: no cue starts, and one in progress drops its remaining beats", async () => {
    const cue = startHandoffCue("designer")!;
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    useMic.setState({ enabled: false, hydrated: true });
    await finishBeat();
    expect(await cue.done).toBe("cancelled");
    expect(h.speak).toHaveBeenCalledTimes(1);
    expect(startHandoffCue("designer")).toBeNull();
  });

  it("a stand-down (barge-in reflex / stopVoice) cuts the beat in flight and drops the rest", async () => {
    const cue = startHandoffCue("librarian")!;
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    stopVoice();
    expect(await cue.done).toBe("cancelled");
    expect(h.speak).toHaveBeenCalledTimes(1);
  });

  it("a delegated turn dispatches at once while the cue is still talking, and shows the chip", async () => {
    void handleInput("ask the coder to build me a landing page", { channel: "voice", origin: "tap" });
    await vi.waitFor(() => expect(h.cmd.mock.calls.some((c) => c[0] === "os_turn")).toBe(true));
    // The first beat never finished: the turn did not wait for it.
    expect(pending.length).toBeGreaterThan(0);
    const chip = useHandoffChip.getState().chip;
    expect(chip?.to).toBe("coder");
    expect(chip?.voiced).toBe(true);
    expect(voices()[0]).toBe("general");
  });

  it("OFF: the same delegated turn, silent cue — only the chip (and Tony's usual one-line ack)", async () => {
    h.settings.routing.vocalHandoffs = false;
    void handleInput("ask the coder to build me a landing page", { channel: "voice", origin: "tap" });
    await vi.waitFor(() => expect(h.cmd.mock.calls.some((c) => c[0] === "os_turn")).toBe(true));
    expect(useHandoffChip.getState().chip).toMatchObject({ to: "coder", voiced: false });
    expect(voices().filter((v) => v === "coder")).toHaveLength(0);
  });

  it("review #9/#15: the reply queues behind the cue — no beat or reply sentence is cut", async () => {
    void handleInput("ask the coder to build me a landing page", { channel: "voice", origin: "tap" });
    await vi.waitFor(() => expect(h.cmd.mock.calls.some((c) => c[0] === "os_turn")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.speak).toHaveBeenCalledTimes(1); // beat 1 still playing: the answer waits
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(h.speak.mock.calls.length).toBeGreaterThan(i));
      await finishBeat();
    }
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(4));
    expect(h.speak.mock.calls[3][0]).toBe("On it.");
    expect(voices().slice(0, 3)).toEqual(["general", "coder", "general"]);
  });

  it("review #29/#10: a new command over the cue cancels the cue, not the delegated job", async () => {
    let first = true;
    h.cmd.mockImplementation(async (name: string) => {
      if (name !== "os_turn") return undefined;
      if (first) {
        first = false;
        return new Promise(() => undefined); // the Coder is still working
      }
      return { answer: "It's noon.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    });
    void handleInput("ask the coder to build me a landing page", { channel: "voice", origin: "tap" });
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.sttStart).toHaveBeenCalled());
    const barge = h.sttStart.mock.calls.at(-1)![0] as { onPhase: (p: string) => void; onFinal: (t: string) => void };
    barge.onPhase("speech");
    barge.onFinal("what time is it");
    await vi.waitFor(() => expect(h.cmd.mock.calls.filter((c) => c[0] === "os_turn")).toHaveLength(2));
    expect(h.cmd.mock.calls.some((c) => c[0] === "os_turn_cancel")).toBe(false);
    expect(h.ttsCancel).toHaveBeenCalled(); // the beat in flight was cut
  });
});
