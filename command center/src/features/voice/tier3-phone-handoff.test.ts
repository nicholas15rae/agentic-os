import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The phone's approved Tier-3 hand-off, end to end through the real voice controller and the
 * real dispatch() (PWA: isDesktopApp false). The hand-off text opens "[Tony — approved hand-off
 * …]", which reads as an address to Tony; the queued desktop turn must still carry the target
 * agent as a Named route. Engines, audio and the gateway are stubbed (mocks as offer-flow.test.ts).
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
  queueDesktopTurn: vi.fn(),
  queueDesktopItem: vi.fn(),
  speak: vi.fn(),
}));

vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  // Nothing frozen on the master switchboard; the live rule is the real one.
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
  isAndroidApp: () => false,
  useSettings: { getState: () => ({ osName: "Tony", wakeMode: false, confirmTimeoutSec: 30, routing: { announcerHandoff: false }, audioRoute: "auto" }) },
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
// The real dispatch(); only the brainstorm's own Tier-2 turns are stubbed.
vi.mock("@/features/dispatcher/dispatch", async (orig) => ({ ...(await orig<typeof import("@/features/dispatcher/dispatch")>()), queueDesktopTurn: h.queueDesktopTurn, queueDesktopItem: h.queueDesktopItem }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: () => null,
  createEngines: () => ({ stt: null, tts: { supported: true, name: "test", speak: h.speak, cancel: vi.fn() } }),
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
import { handleInput } from "./voice-controller";

const text = { channel: "text" as const, thread: "auto" as const };
const inboxPosts = () => h.gateway.mock.calls.filter(([path, init]) => path === "/api/os/inbox" && init?.method === "POST").map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  useVoice.setState({ turns: [], pending: null, state: "idle" });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockRejectedValue(new Error("offline")); // planner / verifier unavailable: heuristic plans
  h.queueDesktopTurn.mockImplementation(async (p: { text: string }) => ({ answer: `Tony: ${p.text}` }));
  h.execute.mockImplementation(async (plan: { run?: () => Promise<{ text: string; meta: string }> }) => (plan.run ? plan.run() : { text: "ok", meta: "" }));
  // The gateway inbox: the desktop answers the queued item on the first poll.
  h.gateway.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST" && path === "/api/os/inbox") return { id: "q1" };
    // A plain poll or a long-poll (`?wait=…&after=…`).
    if (path === "/api/os/inbox/q1" || path.startsWith("/api/os/inbox/q1?")) return { status: "done", result: { ok: true, result: { answer: "Designer: on it", providerId: "anythingllm" } } };
    throw new Error(`unexpected gateway call ${path}`);
  });
});

describe("phone: an approved Tier-3 hand-off reaches its agent", () => {
  it("approving a Domain-topic hand-off queues role = the target agent with routeKind Named", async () => {
    await handleInput("what if the layout had a sidebar", text);
    await handleInput("ok let's do it", text);
    const p = useVoice.getState().pending;
    expect(p?.plan.offer).toBe("delegate");
    expect(p?.plan.summary).toMatch(/Designer/);
    expect(inboxPosts()).toHaveLength(0); // nothing leaves Tony before the yes
    await handleInput("yes", text);
    await vi.waitFor(() => expect(inboxPosts()).toHaveLength(1), { timeout: 4_000 });
    const { kind, payload } = inboxPosts()[0];
    expect(kind).toBe("turn");
    expect(payload.text).toMatch(/^\[Tony — approved hand-off from a brainstorm with the user\] Take it from here:/);
    expect(payload).toMatchObject({ role: "designer", routeKind: "Named", explicit: false, noDelegate: false });
    await vi.waitFor(() => expect(useVoice.getState().turns.map((t) => t.text)).toContain("Designer: on it"), { timeout: 4_000 });
    expect(h.chat).not.toHaveBeenCalled();
  });
});
