import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/platform";

/**
 * Part 6 narration through the real voice controller (engines, audio and the gateway stubbed, as
 * in barge-duck.test.ts): a line queued during Tony's reply waits for him (ttsIdle + the quiet
 * gap), speech onset stops ONLY the narration line, and a passive hands-free re-arm never clips it.
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
  route: "headset" as "headset" | "speakers",
  settings: { osName: "Tony", wakeMode: false, wakeRequire: true, wakeWords: ["hey tony"], confirmTimeoutSec: 30, routing: { announcerHandoff: false }, conversation: { audioRoute: "auto", bargeIn: true, followUp: true, followUpSecs: 6, bargeEndSilenceMs: 500 } },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/lib/gateway", () => ({ gateway: vi.fn() }));
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
vi.mock("@/features/voice/audio-route", () => ({ bargeSensitivityOffset: () => -30, detectRoute: async () => h.route, detectedRoute: () => h.route, effectiveRoute: () => h.route }));
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

import { useVoice } from "./voice-store";
import { handleInput, narrate, narrationActive, narrator, narratorSnapshot, setWakeMode, startListening, stopVoice } from "./voice-controller";
import { useMic } from "./mic-gate";

// Phase 2 Part B: the mic gate fails closed until hydrated; these suites run with the mic live.
useMic.setState({ enabled: true, hydrated: true });

type Handlers = { onPhase: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
const handlers = (i: number) => h.sttStart.mock.calls[i][0] as Handlers;
const spokenTexts = () => h.speak.mock.calls.map((c) => c[0] as string);

/** Speech in flight; a cancel ends it, like the real engine. */
let speaking: Array<() => void> = [];
function speakHangs() {
  h.speak.mockImplementation(
    () =>
      new Promise<void>((r) => {
        speaking.push(r);
      }),
  );
}
const finishSpeech = () => {
  for (const r of speaking.splice(0)) r();
};

const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({ v: 1, seq: 1, at: Date.now(), taskId: "t-1-aaaaaa", traceId: "task:t-1-aaaaaa", agentId: "coder", eventType: "stage_started", severity: "milestone", shortSummary: "Coder is building the prototype", ...over });

beforeEach(() => {
  setWakeMode(false);
  stopVoice();
  finishSpeech();
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null });
  for (const f of [h.cmd, h.speak, h.ttsCancel, h.ttsDuck, h.sttStart, h.sttAbort]) f.mockReset();
  h.settings.wakeMode = false;
  h.route = "headset";
  h.ttsCancel.mockImplementation(finishSpeech);
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return { answer: "It's sunny.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

describe("narration waits for Tony", () => {
  it("a line queued during an osRun reply is spoken only after he finishes (ttsIdle) and the room is quiet", async () => {
    expect(narrator).not.toBeNull();
    speakHangs();
    const turn = handleInput("what's the weather", { channel: "voice", origin: "tap" });
    await vi.waitFor(() => expect(useVoice.getState().state).toBe("speaking"));
    expect(narratorSnapshot().sayDepth).toBeGreaterThan(0);
    narrator!.push(ev());
    await new Promise((r) => setTimeout(r, 150));
    expect(spokenTexts()).toEqual(["It's sunny."]); // nothing over Tony
    expect(narrator!.queue()).toHaveLength(1);
    finishSpeech();
    await turn;
    // The follow-up window after his reply is a listen Nic may speak into: still waiting.
    expect(useVoice.getState().state).toBe("listening");
    await new Promise((r) => setTimeout(r, 100));
    expect(spokenTexts()).toHaveLength(1);
    handlers(h.sttStart.mock.calls.length - 1).onFinal(""); // the window closes in silence
    expect(useVoice.getState().state).toBe("idle");
    await vi.waitFor(() => expect(spokenTexts()).toHaveLength(2), { timeout: 4000 });
    expect(spokenTexts()[1]).toBe("Coder is building the prototype");
    // Level 1, templated milestone: Tony's voice. The voice state never changed for it.
    expect(h.speak.mock.calls[1][1]).toMatchObject({ agent: "general" });
    expect(useVoice.getState().state).toBe("idle");
    finishSpeech();
  }, 8000);

  it("narrate() speaks in the agent's roster voice; localOnly rides along; not cached", async () => {
    speakHangs();
    const done = narrate("Built two files.", "coder", { localOnly: true });
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    expect(h.speak.mock.calls[0][1]).toMatchObject({ agent: "coder", localOnly: true });
    expect(h.speak.mock.calls[0][1].cache).toBeUndefined();
    expect(narrationActive()).toBe(true);
    expect(useVoice.getState().state).toBe("idle");
    finishSpeech();
    await done;
    expect(narrationActive()).toBe(false);
  });
});

describe("speech onset cancels ONLY the narration line", () => {
  it("headset: the passive wake listen stays open; Nic's speech stops the line once; no 'speaking' state", async () => {
    startListening({ silent: true, origin: "wake" });
    expect(useVoice.getState().state).toBe("listening");
    speakHangs();
    const done = narrate("The Designer is drafting the blueprint.", "designer");
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    expect(h.sttAbort).not.toHaveBeenCalled(); // mic kept open under the line (headset)
    h.ttsCancel.mockClear();
    handlers(0).onPhase("speech");
    expect(h.ttsCancel).toHaveBeenCalledTimes(1);
    await done;
    expect(narrationActive()).toBe(false);
    handlers(0).onPhase("speech"); // more speech: nothing else to cancel
    expect(h.ttsCancel).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().state).not.toBe("speaking");
  });

  it("speakers: the passive listen is closed for the line (echo) and re-armed after it", async () => {
    h.route = "speakers";
    h.settings.wakeMode = true;
    setWakeMode(true);
    await vi.waitFor(() => expect(h.sttStart).toHaveBeenCalledTimes(1), { timeout: 2000 }); // the 600 ms re-arm
    expect(useVoice.getState().state).toBe("listening");
    speakHangs();
    const done = narrate("The Coder is building the prototype.", "coder");
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    expect(h.sttAbort).toHaveBeenCalled();
    expect(useVoice.getState().state).toBe("idle");
    await new Promise((r) => setTimeout(r, 800));
    expect(h.sttStart).toHaveBeenCalledTimes(1); // no re-arm over the line
    finishSpeech();
    await done;
    await vi.waitFor(() => expect(h.sttStart).toHaveBeenCalledTimes(2), { timeout: 2000 });
    setWakeMode(false);
  }, 8000);
});

describe("a passive re-arm never clips narration", () => {
  it("rearmWake defers while the line plays, then re-arms", async () => {
    h.settings.wakeMode = true;
    speakHangs();
    const done = narrate("Spec is in.", "prompter");
    await vi.waitFor(() => expect(h.speak).toHaveBeenCalledTimes(1));
    h.ttsCancel.mockClear();
    setWakeMode(true); // schedules the silent re-arm (whose startListening cancels all TTS)
    await new Promise((r) => setTimeout(r, 900));
    expect(h.ttsCancel).not.toHaveBeenCalled();
    expect(h.sttStart).not.toHaveBeenCalled();
    expect(narrationActive()).toBe(true);
    finishSpeech();
    await done;
    await vi.waitFor(() => expect(h.sttStart).toHaveBeenCalledTimes(1), { timeout: 2000 });
    setWakeMode(false);
  }, 6000);
});
