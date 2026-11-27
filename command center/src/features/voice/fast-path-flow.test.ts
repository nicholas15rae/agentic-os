import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Section 20.10 instant cues through the real voice controller: a matched line is answered from
 * the client stores with NO model call (`os_turn` / planner never invoked; the mocked `cmd` is the
 * model), tagged "instant cue · N ms"; anything else — a non-match, a mutating line, an open
 * confirmation card, stale or unloaded data, a throwing handler, the switch off, a sub-agent
 * tab — falls through to the normal turn unchanged. Mocks as switchboard-turns.test.ts.
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
  parseSpotify: vi.fn(),
  runSpotify: vi.fn(),
  runOs: vi.fn(),
  setActive: vi.fn(),
  localIntent: vi.fn(),
}));

/** Per-test client-store state. */
const live = vi.hoisted(() => ({
  fastPath: { builtins: true, userCues: true } as { builtins: boolean; userCues: boolean },
  weather: null as null | { tempC: number; windKph: number; label: string; place: string; fetchedAt: number },
  snapshots: {} as Record<string, unknown[]>,
  loaded: new Set<string>(),
  frozenTools: [] as string[],
  locked: false,
  throwOnSnapshot: false,
}));

vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  return {
    useModes: { getState: () => ({ effective: m.DEFAULT_EFFECTIVE, modes: m.PRESET_MODES, activeId: "surface", setActive: h.setActive, load: async () => undefined }) },
    currentFreeze: () => ({ frozenTools: live.frozenTools }),
    isToolLiveNow: (s: string) => !live.frozenTools.includes(s),
    isTonyToolLiveNow: (s: string) => !live.frozenTools.includes(s),
  };
});
vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false,
  useSettings: {
    getState: () => ({
      osName: "Tony",
      wakeWords: ["hey tony", "yo tony", "tony"],
      wakeMode: false,
      confirmTimeoutSec: 30,
      clock: { hourCycle: "h12" },
      fastPath: live.fastPath,
      routing: { announcerHandoff: false },
      audioRoute: "auto",
      conversation: { audioRoute: "auto", bargeIn: false, followUp: false, followUpSecs: 6, bargeEndSilenceMs: 500 },
    }),
  },
}));
vi.mock("@/features/weather/weather-store", () => ({ useWeather: { getState: () => ({ now: live.weather }) } }));
vi.mock("@/features/security/store", () => ({ useSecurity: { getState: () => ({ status: live.locked ? { hardLocked: false, session: { locked: true } } : null }) } }));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: null }) }, osName: () => "Tony", useOsName: () => "Tony" }));
vi.mock("@/sections/settings/use-providers", () => ({ useProviders: { getState: () => ({ view: null, load: async () => undefined }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ cueFor: () => null, fireCue: vi.fn(), registerCueIO: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, registerSpeechCancel: vi.fn(), setCueDuck: vi.fn(), stopAllAudio: vi.fn() }));
vi.mock("@/features/os/os-intents", () => ({
  cuePlayingNow: () => false,
  // The kill switch is an OS intent: it must always beat a fast cue with the same words.
  parseOsLine: (t: string) => (/kill switch/i.test(t) ? { kind: "kill-switch", on: true } : null),
  runOsIntent: h.runOs,
}));
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: h.parseSpotify, runPendingSpotify: vi.fn(), runSpotifyIntent: h.runSpotify }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: vi.fn(), trackTask: vi.fn(), usePipelines: { getState: () => ({ runs: {}, recent: {} }) } }));
vi.mock("@/features/os/context", () => ({ liveContext: async () => "" }));
vi.mock("@/features/arbiter/api", () => ({ onArbiterEvent: async () => () => undefined }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: h.localIntent }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_o: unknown, call: (approved: boolean) => Promise<unknown>) => call(false) }));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({
  cc: { search: vi.fn(), llmJson: vi.fn(), agentSearch: vi.fn() },
  collections: {
    create: vi.fn(),
    snapshot: (c: string) => {
      if (live.throwOnSnapshot && c === "reminders") throw new Error("boom");
      return live.snapshots[c] ?? [];
    },
    loaded: (c: string) => live.loaded.has(c),
  },
}));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: vi.fn(), queueDesktopTurn: vi.fn(), queueDesktopItem: vi.fn() }));
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
import { handleInput, stopVoice } from "./voice-controller";

const text = { channel: "text" as const, thread: "auto" as const };
const voice = { channel: "voice" as const, origin: "tap" as const };
/** Every model / planner call goes through `cmd` (os_turn, plan_intent, verify…). */
const modelCalls = () => h.cmd.mock.calls.map((c) => c[0] as string);
const turns = () => useVoice.getState().turns;
const spoken = () => h.speak.mock.calls.map((c) => c[0] as string);
const lastAgent = () => [...turns()].reverse().find((t) => t.who === "agent");
const fastCue = (id: string, phrase: string, target: string, reply?: string) => ({ id, enabled: true, phrases: [], time: "", days: [], startup: false, fast: { phrase, target, reply } });

beforeEach(() => {
  stopVoice();
  useVoice.setState({ turns: [], pending: null, state: "idle", error: null });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  Object.assign(live, { fastPath: { builtins: true, userCues: true }, weather: null, snapshots: {}, loaded: new Set<string>(), frozenTools: [], locked: false, throwOnSnapshot: false });
  h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
    if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    throw new Error(`offline ${name}`);
  });
  h.speak.mockResolvedValue(undefined);
  h.execute.mockImplementation(async (plan: { run?: () => Promise<{ text: string; meta: string }> }) => (plan.run ? plan.run() : { text: "ok", meta: "" }));
  h.parseSpotify.mockImplementation(async (t: string) => (t === "play spotify" ? { tool: "spotify.resume", args: {}, summary: "Resume Spotify", mutating: true, explicit: true } : null));
  h.runSpotify.mockResolvedValue({ reply: "Playing." });
  h.runOs.mockResolvedValue({ reply: "Kill switch on." });
  h.localIntent.mockResolvedValue(null);
  h.setActive.mockResolvedValue(undefined);
});

describe("built-in instant cues answer without the model", () => {
  it("'what time is it' (typed): the time, tagged instant cue · N ms, zero model calls", async () => {
    const t0 = performance.now();
    await handleInput("what time is it", text);
    const elapsed = performance.now() - t0;
    expect(modelCalls()).toEqual([]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(turns().map((t) => t.who)).toEqual(["user", "agent"]);
    expect(turns()[0].text).toBe("what time is it");
    expect(lastAgent()?.text).toMatch(/^It's \d{1,2}:\d{2} (AM|PM)\.$/);
    const ms = Number(/^instant cue · (\d+) ms$/.exec(lastAgent()?.meta ?? "")?.[1]);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(Math.ceil(elapsed) + 1);
    expect(elapsed).toBeLessThan(250); // no model round-trip in the way
  });

  it("by voice, Tony speaks the line and only it", async () => {
    await handleInput("hey tony, what's the date", voice);
    expect(modelCalls()).toEqual([]);
    expect(spoken()).toEqual([lastAgent()?.text]);
    expect(spoken()[0]).toMatch(/^It's \w+day, \w+ \d+(st|nd|rd|th)\.$/);
  });

  it("weather from a fresh store reading: no fetch, no model", async () => {
    live.weather = { tempC: 2.4, windKph: 10, label: "Overcast", place: "Toronto", fetchedAt: Date.now() - 60_000 };
    await handleInput("how's the weather", text);
    expect(modelCalls()).toEqual([]);
    expect(lastAgent()).toMatchObject({ text: "It's 2 degrees and overcast in Toronto.", meta: expect.stringMatching(/^instant cue/) });
  });

  it("reminders from the loaded store, money left to finance.ask (never a stale Finance copy)", async () => {
    const now = Date.now();
    live.loaded = new Set(["reminders", "checks", "pending", "invoices", "commissions", "receipts"]);
    live.snapshots = {
      reminders: [{ id: "r1", title: "Call Sam", kind: "reminder", dueAt: now + 60_000, repeat: "none", source: "local" }],
      checks: [{ id: "c1", amount: 120, deposited: false, receivedAt: now - 86_400_000 }],
    };
    await handleInput("any reminders", text);
    expect(modelCalls()).toEqual([]);
    expect(lastAgent()?.text).toBe("You've got 1 reminder: call Sam. For money that's still owed, ask me what's pending.");
  });

  it("\"what's pending\" is a money question: the normal turn (finance.ask), not an instant cue", async () => {
    live.loaded = new Set(["reminders", "checks", "pending", "invoices", "commissions", "receipts"]);
    await handleInput("what's pending", text);
    expect(modelCalls()).toContain("os_turn");
    expect(turns().some((t) => /^instant cue/.test(t.meta ?? ""))).toBe(false);
  });
});

describe("falls through to the normal model turn", () => {
  const fellThrough = (line: string) => {
    expect(modelCalls()).toContain("os_turn");
    expect(turns().some((t) => /^instant cue/.test(t.meta ?? ""))).toBe(false);
    expect(lastAgent()?.text).toBe(`Tony: ${line}`);
  };

  it.each(["what time is it in Tokyo", "what's the weather tomorrow", "what's the weather like in Lisbon"])("a non-match: %s", async (line) => {
    await handleInput(line, text);
    fellThrough(line);
  });

  it("mutating lines never take the fast path (a send that mentions the time)", async () => {
    await handleInput("text Sam what time it is", text);
    expect(turns().some((t) => /^instant cue/.test(t.meta ?? ""))).toBe(false);
    // The normal path ran (planner / gate / os_turn), not an instant answer.
    expect(h.cmd).toHaveBeenCalled();
  });

  it("stale weather → the model (which fetches)", async () => {
    live.weather = { tempC: 2, windKph: 1, label: "Clear", place: "Toronto", fetchedAt: Date.now() - 3 * 3_600_000 };
    await handleInput("how's the weather", text);
    fellThrough("how's the weather");
  });

  it("weather frozen on the switchboard → the model (Rust gives the frozen reason)", async () => {
    live.weather = { tempC: 2, windKph: 1, label: "Clear", place: "Toronto", fetchedAt: Date.now() };
    live.frozenTools = ["weather"];
    await handleInput("how's the weather", text);
    fellThrough("how's the weather");
  });

  it("reminders not loaded → the model", async () => {
    await handleInput("any reminders", text);
    fellThrough("any reminders");
  });

  it("a handler that throws → the model, once, with the transcript intact", async () => {
    live.loaded = new Set(["reminders"]);
    live.throwOnSnapshot = true;
    await handleInput("any reminders", text);
    fellThrough("any reminders");
    expect(turns().filter((t) => t.who === "user").map((t) => t.text)).toEqual(["any reminders"]);
  });

  it("built-ins switched off → the model", async () => {
    live.fastPath = { builtins: false, userCues: true };
    await handleInput("what time is it", text);
    fellThrough("what time is it");
  });

  it("a typed line on a sub-agent tab stays that agent's", async () => {
    await handleInput("what time is it", { channel: "text", thread: "coder" as never });
    expect(turns().some((t) => /^instant cue/.test(t.meta ?? ""))).toBe(false);
  });
});

describe("safety: cards, OS controls", () => {
  it("an open confirmation card: the line answers the card, never an instant cue", async () => {
    const pending = { plan: { summary: "Send a text to Sam", mutating: true, steps: [] }, createdAt: Date.now() };
    useVoice.setState({ pending: pending as never, state: "confirming" });
    await handleInput("what time is it", text);
    expect(turns().some((t) => /^instant cue/.test(t.meta ?? ""))).toBe(false);
  });

  it("an OS intent (kill switch) beats a fast cue with the same words", async () => {
    live.snapshots = { cues: [fastCue("k", "kill switch on", "reply", "Sure thing.")] };
    await handleInput("kill switch on", text);
    expect(h.runOs).toHaveBeenCalledTimes(1);
    expect(turns().some((t) => /^instant cue/.test(t.meta ?? ""))).toBe(false);
  });
});

describe("Nic's fast cues", () => {
  it("a fixed reply: said as is, no model", async () => {
    live.snapshots = { cues: [fastCue("a", "lock in", "reply", "Locked in, Nic. Let's get it.")] };
    await handleInput("Lock in!", voice);
    expect(modelCalls()).toEqual([]);
    expect(spoken()).toEqual(["Locked in, Nic. Let's get it."]);
    expect(lastAgent()?.meta).toMatch(/^instant cue · \d+ ms$/);
  });

  it("a cue mapped to a read-only handler", async () => {
    live.snapshots = { cues: [fastCue("b", "clock", "time")] };
    await handleInput("clock", text);
    expect(modelCalls()).toEqual([]);
    expect(lastAgent()?.text).toMatch(/^It's \d/);
  });

  it("a cue mapped to music runs the existing Spotify fast path (its gates included), no model", async () => {
    live.snapshots = { cues: [fastCue("c", "my jam", "music.play")] };
    await handleInput("my jam", text);
    expect(h.parseSpotify).toHaveBeenCalledWith("play spotify");
    expect(h.runSpotify).toHaveBeenCalledTimes(1);
    expect(modelCalls()).toEqual([]);
    // Spotify frozen: the Spotify path stands down and the line goes to the model as typed.
    h.runSpotify.mockClear();
    live.frozenTools = ["spotify"];
    await handleInput("my jam", text);
    expect(h.runSpotify).not.toHaveBeenCalled();
    expect(lastAgent()?.text).toBe("Tony: my jam");
  });

  it("a cue mapped to a mode switch runs the existing mode setter, no model", async () => {
    live.snapshots = { cues: [fastCue("d", "lets build", "mode.builder")] };
    await handleInput("let's build", text);
    expect(h.setActive).toHaveBeenCalledWith("builder");
    expect(modelCalls()).toEqual([]);
    expect(turns().some((t) => t.text === "→ Switched mode: Builder")).toBe(true);
  });

  it("a mode cue never answers an open card: the card gets the line (review fix)", async () => {
    live.snapshots = { cues: [fastCue("d", "lets build", "mode.builder")] };
    const pending = { plan: { summary: "Send a text to Sam", mutating: true, steps: [] }, createdAt: Date.now() };
    useVoice.setState({ pending: pending as never, state: "confirming" });
    await handleInput("let's build", text);
    expect(h.setActive).not.toHaveBeenCalled();
    useVoice.setState({ pending: null as never, state: "idle" });
  });

  it("disabled cue or user cues switched off → the model", async () => {
    live.snapshots = { cues: [{ ...fastCue("a", "lock in", "reply", "Locked in."), enabled: false }] };
    await handleInput("lock in", text);
    expect(lastAgent()?.text).toBe("Tony: lock in");
    live.snapshots = { cues: [fastCue("a", "lock in", "reply", "Locked in.")] };
    live.fastPath = { builtins: true, userCues: false };
    await handleInput("lock in", text);
    expect(lastAgent()?.text).toBe("Tony: lock in");
  });
});
