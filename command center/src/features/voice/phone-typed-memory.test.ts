import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Decision 5 (review regression): a TYPED phone turn the desktop's Tony answered in Learning mode
 * carries his proposals (the Save / Skip card) and the core memories a yes saved (the pills), as a
 * phone voice turn does. Through the real voice controller and the real `execute` on the phone
 * (isDesktopApp false), with dispatch() mocked. Engines, audio and the gateway are stubbed (mocks
 * as phone-voice-stream.test.ts).
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({ cmd: vi.fn(), dispatch: vi.fn(), speak: vi.fn() }));

vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  return { useModes: { getState: () => ({ effective: m.DEFAULT_EFFECTIVE, load: async () => undefined }) }, currentFreeze: () => ({}), isToolLiveNow: (s: string) => m.toolLive(m.DEFAULT_EFFECTIVE, s, {}) };
});
vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => false, onNativeEvent: async () => () => undefined, platform: "web" }));
vi.mock("@/lib/gateway", () => {
  class GatewayError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
    }
  }
  return { gateway: async () => ({}), api: { chat: vi.fn(), agentsHealth: vi.fn() }, GatewayError };
});
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => false,
  isAndroidApp: () => true,
  useSettings: {
    getState: () => ({
      osName: "Tony",
      wakeMode: false,
      confirmTimeoutSec: 30,
      routing: { announcerHandoff: false },
      audioRoute: "auto",
      conversation: { audioRoute: "auto", bargeIn: false, followUp: false, followUpSecs: 6, bargeEndSilenceMs: 500 },
    }),
  },
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
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn(), agentSearch: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: h.dispatch, queueDesktopTurn: vi.fn(), queueDesktopItem: vi.fn() }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: async () => null,
  createEngines: () => ({ stt: null, tts: { supported: true, name: "test", speak: h.speak, prefetch: vi.fn(), cancel: vi.fn() } }),
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
  settleCommand: vi.fn(),
  settleNoise: vi.fn(),
}));

import { useDialogue } from "@/features/dialogue/dialogue-store";
import type { LearnedPathway, PendingMemory } from "@/features/modes/learning";
import { useVoice } from "./voice-store";
import { handleInput, stopVoice } from "./voice-controller";

const LESSON = "when someone asks who books me, it's the booking desk";
const ASKED = "So when someone asks who books you, the Booking Desk handles it? Want me to add that to my core memories?";
const pending: PendingMemory[] = [{ id: "mem-1-2", category: "domain_knowledge", text: "When someone asks who books Nic: the Booking Desk handles it" }];
const saved: LearnedPathway = { id: "lp-9-0", title: "the Booking Desk handles it", category: "domain_knowledge", confidence: "confirmed", outcome: "saved" };
const known: LearnedPathway = { ...saved, id: "lp-9-1", outcome: "unchanged" };

const outcome = (content: string, extra: Record<string, unknown> = {}) => ({ role: "general", result: { providerId: "desktop:tony", content, fellBack: false, reason: "phone → desktop Tony", latencyMs: 5 }, ...extra });
const agentTurns = () => useVoice.getState().turns.filter((t) => t.who === "agent");

beforeEach(() => {
  stopVoice();
  useVoice.setState({ turns: [], pending: null, state: "idle", error: null });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockRejectedValue(new Error("offline")); // planner / verifier unavailable: heuristic plans
  h.speak.mockResolvedValue(undefined);
});

describe("decision 5: a typed phone turn in Learning mode", () => {
  it("carries Tony's proposals (the card) through execute onto the turn", async () => {
    h.dispatch.mockResolvedValueOnce(outcome(ASKED, { pendingMemory: pending }));
    await handleInput(LESSON, { channel: "text", thread: "auto" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const [turn] = agentTurns();
    expect(turn).toMatchObject({ text: ASKED, pendingMemory: pending });
    expect(turn.learned).toBeUndefined();
    expect(h.speak).not.toHaveBeenCalled();
  });

  it("carries the core memories a typed yes saved (pills; an unchanged one isn't a pill)", async () => {
    h.dispatch.mockResolvedValueOnce(outcome("Saved to my core memories.", { learned: [saved, known] }));
    await handleInput("yes", { channel: "text", thread: "auto" });
    const [turn] = agentTurns();
    expect(turn).toMatchObject({ text: "Saved to my core memories.", learned: [saved] });
    expect(turn.pendingMemory).toBeUndefined();
  });

  it("an ordinary typed phone turn has neither", async () => {
    h.dispatch.mockResolvedValueOnce(outcome("It's sunny."));
    await handleInput("what's the weather like today", { channel: "text", thread: "auto" });
    const [turn] = agentTurns();
    expect(turn.text).toBe("It's sunny.");
    expect("pendingMemory" in turn || "learned" in turn).toBe(false);
  });
});
