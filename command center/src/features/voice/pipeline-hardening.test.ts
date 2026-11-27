import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thoughtform pipeline hardening, through the real voice controller (engines, audio and the
 * gateway stubbed; native events captured): hands-free never goes deaf after a failed listen, a
 * line that merely starts with "stop" is not a cut when nothing is running, a cut never wipes a
 * held thought silently, a lost hold segment is said, Tony's fallback answer on an agent's tab is
 * labelled as Tony, and an os_turn that fails still shows what Tony sent the agent.
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
  sttStart: vi.fn(),
  sttAbort: vi.fn(),
  events: new Map<string, ((p: unknown) => void)[]>(),
  settings: { osName: "Tony", wakeMode: false, wakeRequire: true, wakeWords: ["hey tony"], confirmTimeoutSec: 30, routing: { announcerHandoff: false }, conversation: { audioRoute: "auto", bargeIn: false, followUp: false, followUpSecs: 6, bargeEndSilenceMs: 500 } },
}));

vi.mock("@/lib/platform", () => ({
  cmd: h.cmd,
  isTauri: () => true,
  platform: "desktop",
  onNativeEvent: async (name: string, fn: (p: unknown) => void) => {
    const list = h.events.get(name) ?? [];
    list.push(fn);
    h.events.set(name, list);
    return () => h.events.set(name, (h.events.get(name) ?? []).filter((f) => f !== fn));
  },
}));
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
  audioContext: async () => {
    throw new Error("no audio in tests");
  },
  createEngines: () => ({
    stt: { name: "test-stt", start: h.sttStart, stop: vi.fn(), abort: h.sttAbort },
    tts: { supported: true, name: "test", speak: h.speak, cancel: vi.fn(), duck: vi.fn() },
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
  settleCommand: vi.fn(),
  settleNoise: vi.fn(),
}));

import { useVoice } from "./voice-store";
import { MAX_WAKE_ERROR_REARMS, answeredByAgent, handleInput, setWakeMode, startListening, stopVoice } from "./voice-controller";
import { useMic } from "./mic-gate";

useMic.setState({ enabled: true, hydrated: true });

type Handlers = { onPhase: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
const handlers = (i: number) => h.sttStart.mock.calls[i][0] as Handlers;
const lastHandlers = () => handlers(h.sttStart.mock.calls.length - 1);
const turns = () => useVoice.getState().turns;
const emit = (name: string, p: unknown) => (h.events.get(name) ?? []).forEach((f) => f(p));

beforeEach(() => {
  vi.useRealTimers();
  stopVoice();
  setWakeMode(false);
  useVoice.setState({ turns: [], pending: null, state: "idle", held: null, error: null });
  for (const f of [h.cmd, h.speak, h.sttStart, h.sttAbort]) f.mockReset();
  h.speak.mockResolvedValue(undefined);
  h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
    if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    return undefined;
  });
});

describe("hands-free after a failed listen", () => {
  it("re-arms (bounded, with backoff) instead of going deaf, then says it paused", async () => {
    vi.useFakeTimers();
    setWakeMode(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.sttStart).toHaveBeenCalledTimes(1);
    lastHandlers().onError("Whisper: error sending request");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sttStart).toHaveBeenCalledTimes(2); // re-armed (it used to stay at 1 forever)
    for (let i = 0; i < MAX_WAKE_ERROR_REARMS; i++) {
      lastHandlers().onError("Whisper: error sending request");
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(turns().some((t) => t.who === "system" && t.text.startsWith("Hands-free paused"))).toBe(true);
    const n = h.sttStart.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sttStart).toHaveBeenCalledTimes(n); // a dead Whisper never spins
  });

  it("words lost to a failed listen are said in the chat", () => {
    startListening({ origin: "tap" });
    handlers(0).onPhase("speech");
    handlers(0).onError("Whisper: timed out");
    expect(turns().some((t) => t.who === "system" && t.text.startsWith("Didn't catch that"))).toBe(true);
  });
});

describe("cut reflexes (regressions)", () => {
  it("'Stop motion studio app, …' with nothing running is an ordinary line, not a cut", async () => {
    startListening({ origin: "tap" });
    handlers(0).onFinal("Stop motion studio app, I want an app that turns my sketches into stop motion clips");
    await vi.waitFor(() => expect(turns().some((t) => t.who === "user" && t.text.startsWith("Stop motion studio app"))).toBe(true));
  });

  it("a held thought keeps 'Stop button should be red'; a bare cut drops it, but never silently", async () => {
    startListening({ origin: "tap" });
    handlers(0).onFinal("take it easy, I'm thinking about a bakery site");
    await vi.waitFor(() => expect(useVoice.getState().held).toEqual(["I'm thinking about a bakery site"]));
    lastHandlers().onFinal("Stop button should be red");
    await vi.waitFor(() => expect(useVoice.getState().held).toEqual(["I'm thinking about a bakery site", "Stop button should be red"]));
    lastHandlers().onFinal("cut it");
    await vi.waitFor(() => expect(useVoice.getState().held).toBeNull());
    expect(turns().some((t) => t.who === "system" && t.text.includes("held thought was not sent") && t.text.includes("Stop button should be red"))).toBe(true);
  });

  it("a passive hands-free listen may cut, but never runs the rest without the wake word", async () => {
    vi.useFakeTimers();
    setWakeMode(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.sttStart).toHaveBeenCalled();
    useVoice.setState({ state: "thinking" }); // a turn is busy, so the cut has a target
    lastHandlers().onFinal("cut it, read me my latest messages");
    await vi.advanceTimersByTimeAsync(50);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "os_turn")).toHaveLength(0);
    expect(turns().some((t) => t.who === "user" && t.text.includes("read me my latest messages"))).toBe(false);
    expect(turns().some((t) => t.who === "system" && t.text.includes("Didn't run “read me my latest messages”"))).toBe(true);
  });

  it("an addressed cut still turns the rest into the next turn", async () => {
    startListening({ origin: "tap" });
    useVoice.setState({ state: "thinking" });
    handlers(0).onFinal("cut it, what's on my calendar");
    await vi.waitFor(() => expect(h.cmd.mock.calls.some((c) => c[0] === "os_turn" && c[1].req?.text === "what's on my calendar")).toBe(true));
  });

  it("a hold segment lost to a Whisper error is said", async () => {
    startListening({ origin: "tap" });
    handlers(0).onFinal("take it easy, I'm thinking about a bakery site");
    await vi.waitFor(() => expect(useVoice.getState().held).not.toBeNull());
    lastHandlers().onPhase("speech");
    lastHandlers().onError("Whisper: boom");
    expect(turns().some((t) => t.who === "system" && t.text.startsWith("Missed that last part"))).toBe(true);
  });
});

describe("os_turn outcomes in the chat (regressions)", () => {
  it("Tony's fallback on an agent's tab is labelled as Tony, not the agent", async () => {
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "os_turn")
        return {
          answer: "Tony's own fallback answer.",
          steps: [
            { kind: "error", from: "coder", to: "os", text: "Coder agent failed: timed out", ok: false, ms: 5 },
            { kind: "step-in", from: "os", to: "user", text: "Tony stepped in with its own tools.", ok: true, ms: 0 },
          ],
          providerId: "lmstudio",
          latencyMs: 1,
          routedRole: "coder",
          routeKind: "Tab",
          routeReason: "",
          redacted: false,
          reason: "",
          answeredBy: "os",
        };
      return undefined;
    });
    await handleInput("is the build green?", { channel: "text", thread: "coder" });
    const answer = turns().find((t) => t.who === "agent" && t.text === "Tony's own fallback answer.");
    expect(answer?.from).toBe("os");
    expect(answeredByAgent({ answeredBy: "agent", steps: [] })).toBe(true);
    expect(answeredByAgent({ steps: [{ kind: "step-in", from: "os", to: "user", text: "", ok: true, ms: 0 }] })).toBe(false);
  });

  it("a failed turn still shows what Tony sent the agent (os-step), then the error", async () => {
    h.cmd.mockImplementation(async (name: string, args: { req?: { streamId: string } }) => {
      if (name === "os_turn") {
        emit("os-step", { streamId: args.req?.streamId, index: 0, step: { kind: "delegate", from: "os", to: "coder", text: "Request: check the landing page build", ok: true, ms: 0 } });
        throw new Error("all providers failed");
      }
      return undefined;
    });
    await handleInput("tell the coder to check the landing page build", { channel: "text", thread: "auto" });
    expect(turns().some((t) => t.who === "relay" && t.thread === "coder" && t.text.includes("check the landing page build"))).toBe(true);
    expect(turns().some((t) => t.who === "system" && t.tone === "error")).toBe(true);
  });

  it("an agent stream that breaks off keeps its own bubble; Tony's answer gets a new one", async () => {
    h.cmd.mockImplementation(async (name: string, args: { req?: { streamId: string } }) => {
      if (name === "os_turn") {
        const sid = args.req?.streamId;
        emit("tony-token", { streamId: sid, delta: "The build is ", agent: "coder" });
        emit("tony-token", { streamId: sid, delta: "Tony here: it's green." });
        return { answer: "Tony here: it's green.", steps: [], providerId: "lmstudio", latencyMs: 1, routedRole: "coder", routeKind: "Tab", routeReason: "", redacted: false, reason: "", answeredBy: "os" };
      }
      return undefined;
    });
    await handleInput("is the build green?", { channel: "text", thread: "coder" });
    const agentBubbles = turns().filter((t) => t.who === "agent");
    expect(agentBubbles.map((t) => [t.from, t.text, t.meta?.split(" · ")[0]])).toEqual([
      ["coder", "The build is ", "interrupted"],
      ["os", "Tony here: it's green.", "lmstudio"],
    ]);
  });
});
