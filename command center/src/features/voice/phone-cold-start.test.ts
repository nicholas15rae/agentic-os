import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A phone voice turn that gateway Tony answers on a cold start, through the REAL dispatch() and
 * voice controller (phone-voice-stream.test.ts mocks dispatch itself): the waking line streams
 * first, then the final delta and `done` come back in one poll, so only the result's
 * `streamPrefix` lines the short final answer up with what was already said. Only the gateway,
 * engines and audio are stubbed (mocks as phone-voice-stream.test.ts).
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
  gateway: vi.fn(),
  chat: vi.fn(),
  speak: vi.fn(),
  prefetch: vi.fn(),
}));

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
  return { gateway: h.gateway, api: { chat: h.chat }, GatewayError };
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
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn(), agentSearch: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: async () => null,
  createEngines: () => ({ stt: null, tts: { supported: true, name: "test", speak: h.speak, prefetch: h.prefetch, cancel: vi.fn() } }),
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
import { useVoice } from "./voice-store";
import { handleInput, stopVoice } from "./voice-controller";

const voice = { channel: "voice" as const, origin: "tap" as const };
/** gateway_tony.py WAKING_LINE: the first delta of a cold turn; the final answer never has it. */
const WAKING = "One sec, Nic — waking up.";
const spoken = () => h.speak.mock.calls.map((c) => c[0] as string);
const agentTurns = () => useVoice.getState().turns.filter((t) => t.who === "agent");

/** The gateway's inbox for one cold turn: POST → q1; the first (plain) GET has only the waking line
 * streamed; the long-poll after it is held until `release()`, then answers the final delta and
 * `done` at once (the last partial never reaches the phone). Anything else (the mic gate) → {}. */
function coldInbox(result: Record<string, unknown>) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.gateway.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/os/inbox" && init?.method === "POST") return { id: "q1" };
    if (path === "/api/os/inbox/q1") return { status: "running", result: null, partial: `${WAKING} `, partialSeq: 1 };
    if (path.startsWith("/api/os/inbox/q1?")) {
      await held;
      return { status: "done", result: { ok: true, result }, partial: `${WAKING} ${String(result.answer)}`, partialSeq: 2 };
    }
    return {};
  });
  return { release };
}

beforeEach(() => {
  stopVoice();
  useVoice.setState({ turns: [], pending: null, state: "idle", error: null });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockRejectedValue(new Error("offline")); // planner / verifier unavailable: heuristic plans
  h.speak.mockResolvedValue(undefined);
  h.execute.mockResolvedValue({ text: "via execute", meta: "" });
});

describe("a gateway cold start through the real dispatch(): the short answer is spoken once", () => {
  it("the waking line, then 'Sure.' (lined up by the done result's streamPrefix), never twice, never dropped", async () => {
    const inbox = coldInbox({ answer: "Sure.", providerId: "gateway:lmstudio", answeredBy: "gateway", coldLoad: true, streamPrefix: `${WAKING} ` });
    const turn = handleInput("what's the weather like today", voice);
    await vi.waitFor(() => expect(spoken()).toEqual([WAKING]));
    inbox.release();
    await turn;
    expect(spoken()).toEqual([WAKING, "Sure."]);
    expect(h.chat).not.toHaveBeenCalled(); // gateway Tony answered through the inbox, not the CLI
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0]).toMatchObject({ text: "Sure.", from: "os" });
    expect(agentTurns()[0].meta).toMatch(/desktop:gateway:lmstudio/);
    expect(useVoice.getState().state).toBe("idle");
  });

  it("a warm answer (streamPrefix \"\") with nothing streamed is said whole, once", async () => {
    h.gateway.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/os/inbox" && init?.method === "POST") return { id: "q1" };
      if (path === "/api/os/inbox/q1") return { status: "done", result: { ok: true, result: { answer: "It's sunny.", providerId: "gateway:lmstudio", streamPrefix: "" } }, partial: "It's sunny.", partialSeq: 1 };
      return {};
    });
    await handleInput("what's the weather like today", voice);
    expect(spoken()).toEqual(["It's sunny."]);
  });
});
