import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The switchboard in the voice controller (desktop, through the real controller): a Tier-3 offer
 * never names a frozen agent (one calm line, no card), a route to a frozen agent stays Tony's
 * before the webview announces it (`frozenHold` after `soloHold`), and the Spotify fast path only
 * runs while the spotify server is live. Modes and the master switchboard's freezes are driven by
 * the test; engines, audio and the gateway are stubbed (mocks as dialogue/offer-flow.test.ts).
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
  buildArtifact: vi.fn(),
  saveArtifact: vi.fn(),
  speak: vi.fn(),
  parseSpotify: vi.fn(),
  runSpotify: vi.fn(),
  /** The approval gate's options (its label and role are the webview's view of the turn). */
  gated: vi.fn(),
}));

// The active mode and the master switchboard's freezes, per test.
const mode = vi.hoisted(() => ({ effective: null as unknown, freeze: {} as { frozenAgents?: string[]; frozenTools?: string[] } }));
vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  mode.effective = m.DEFAULT_EFFECTIVE;
  return {
    useModes: { getState: () => ({ effective: mode.effective, load: async () => undefined }) },
    currentFreeze: () => mode.freeze,
    isToolLiveNow: (s: string) => m.toolLive(mode.effective as import("@/features/modes/modes").EffectiveMode, s, mode.freeze),
    // Tony's base (Spotify is in it): only the master switchboard freezes it (section pass).
    isTonyToolLiveNow: (s: string) => !(mode.freeze.frozenTools ?? []).includes(s),
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
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: h.parseSpotify, runPendingSpotify: vi.fn(), runSpotifyIntent: h.runSpotify }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: vi.fn(), trackTask: vi.fn(), usePipelines: { getState: () => ({ runs: {}, recent: {} }) } }));
vi.mock("@/features/os/context", () => ({ liveContext: async () => "" }));
vi.mock("@/features/arbiter/api", () => ({ onArbiterEvent: async () => () => undefined }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: async () => null }));
vi.mock("@/features/bridge/gate", () => ({
  gated: (o: unknown, call: (approved: boolean) => Promise<unknown>) => {
    h.gated(o);
    return call(false);
  },
}));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn(), agentSearch: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: vi.fn(), queueDesktopTurn: vi.fn(), queueDesktopItem: vi.fn() }));
vi.mock("@/features/dialogue/package", async (orig) => ({ ...(await orig<typeof import("@/features/dialogue/package")>()), buildArtifact: h.buildArtifact, saveArtifact: h.saveArtifact }));
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
import { DEFAULT_EFFECTIVE, PRESET_MODES, effectiveOf, frozenOfferLine } from "@/features/modes/modes";
import { useVoice } from "./voice-store";
import { handleInput, stopVoice } from "./voice-controller";

const useMode = (id: string) => {
  mode.effective = effectiveOf(PRESET_MODES, id);
};
const text = { channel: "text" as const, thread: "auto" as const };
const voice = { channel: "voice" as const, origin: "tap" as const };
const osTurns = () => h.cmd.mock.calls.filter((c) => c[0] === "os_turn").map((c) => c[1].req);
const turns = () => useVoice.getState().turns;
const spoken = () => h.speak.mock.calls.map((c) => c[0] as string);
const PAUSE = { tool: "spotify.pause", args: {}, summary: "Pause Spotify", mutating: true };

beforeEach(() => {
  stopVoice();
  mode.effective = DEFAULT_EFFECTIVE;
  mode.freeze = {};
  useVoice.setState({ turns: [], pending: null, state: "idle", error: null });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
    if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    throw new Error(`offline ${name}`); // planner / verifier unavailable: heuristic plans
  });
  h.speak.mockResolvedValue(undefined);
  h.execute.mockImplementation(async (plan: { run?: () => Promise<{ text: string; meta: string }> }) => (plan.run ? plan.run() : { text: "ok", meta: "" }));
  h.buildArtifact.mockImplementation(async () => ({ title: "Audition Tracker", summary: "s", rawContext: "r", timestamp: 1, tags: [] }));
  h.saveArtifact.mockResolvedValue({ id: "n1", target: "brainstorm" });
  h.parseSpotify.mockImplementation(async (t: string) => (/pause the music/i.test(t) ? PAUSE : null));
  h.runSpotify.mockResolvedValue({ reply: "Paused." });
});

describe("Tier 3: a frozen agent is never offered", () => {
  it("Operations mode freezes the build crew: one calm line, no offer card, nothing queued; the brainstorm stays open", async () => {
    useMode("operations");
    await handleInput("I've been thinking about building an audition tracker", text);
    h.cmd.mockClear();
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending).toBeNull();
    const line = frozenOfferLine(mode.effective as typeof DEFAULT_EFFECTIVE, { kind: "pipeline" });
    expect(line).toBe("The Prompter, the Designer and the Coder are frozen in Operations mode, so I didn't hand this off. Switch modes and I'll send it, or I can park it for later.");
    expect(turns().at(-1)).toMatchObject({ who: "agent", text: line, thread: "auto" });
    expect(h.cmd).not.toHaveBeenCalled(); // no task_create, no os_turn
    expect(useDialogue.getState().active("auto")).not.toBeNull();
    // "park it" still packages the whole brainstorm.
    await handleInput("park it", text);
    expect(h.saveArtifact).toHaveBeenCalledTimes(1);
    expect(h.saveArtifact.mock.calls[0][0]).toBe("brainstorm");
  });

  it("an agent frozen on the master switchboard (any mode): the master line, no card", async () => {
    mode.freeze = { frozenAgents: ["designer"] };
    await handleInput("what if the layout had a sidebar", text);
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(turns().at(-1)?.text).toBe("The Designer is switched off on the master switchboard, so I didn't hand this off. I can park it for later.");
  });

  it("by voice, Tony says the line (and only it)", async () => {
    useMode("operations");
    await handleInput("I've been thinking about building an audition tracker", text);
    h.speak.mockClear();
    await handleInput("ok let's do it", voice);
    expect(useVoice.getState().pending).toBeNull();
    expect(spoken()).toEqual([frozenOfferLine(mode.effective as typeof DEFAULT_EFFECTIVE, { kind: "pipeline" })]);
  });

  it("a live target still gets today's offer card", async () => {
    useMode("builder");
    await handleInput("what if the layout had a sidebar", text);
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending?.plan.offer).toBe("delegate");
  });
});

describe("osRun: a route to a frozen agent stays Tony's in the webview; os_turn gets the route before the hold", () => {
  /** What the webview shows about the turn: the gate's label / role, and any "Routing …" notice. */
  const gateFor = () => h.gated.mock.calls.at(-1)?.[0] as { summary: string; detail: { role: string } };
  const routingNotices = () => turns().filter((t) => t.who === "relay" && /^Routing/.test(t.text));

  it("a topic route to the Coder in Operations mode: os_turn carries the Coder route (Rust holds it, with its FROZEN note); the webview treats it as Tony's", async () => {
    useMode("operations");
    await handleInput("can you check the tauri and rust build errors", text);
    expect(osTurns()).toHaveLength(1);
    // Rust's switchboard_hold sees the frozen agent, so Tony gets "FROZEN THIS TURN: Coder is frozen …".
    expect(osTurns()[0]).toMatchObject({ role: "coder", routeKind: "Domain", explicit: false });
    expect(osTurns()[0].routeReason).not.toMatch(/frozen/);
    // The webview's view is the held one: no "Routing … to Coder…", the gate is Tony's own.
    expect(routingNotices()).toHaveLength(0);
    expect(gateFor()).toMatchObject({ summary: "Let Tony use its tools", detail: { role: "general" } });
    expect(turns().at(-1)).toMatchObject({ who: "agent", role: "general", text: "Tony: can you check the tauri and rust build errors" });
  });

  it("naming an agent frozen only by the mode is a direct ask: it still goes through", async () => {
    useMode("operations");
    await handleInput("coder fix the broken build", text);
    expect(osTurns()[0]).toMatchObject({ role: "coder", routeKind: "Named" });
    expect(gateFor()).toMatchObject({ summary: "Let Tony use Coder", detail: { role: "coder" } });
  });

  it("an agent frozen on the master switchboard, even named: os_turn carries the Booking route; the webview never announces it", async () => {
    mode.freeze = { frozenAgents: ["booking"] };
    await handleInput("booking desk, please check my calendar for tomorrow", text);
    expect(osTurns()[0]).toMatchObject({ role: "booking", routeKind: "Named" });
    expect(routingNotices()).toHaveLength(0);
    expect(gateFor()).toMatchObject({ summary: "Let Tony use its tools", detail: { role: "general" } });
  });

  it("Solo's hold still applies to what os_turn gets (only the switchboard hold is left to Rust)", async () => {
    useMode("surface");
    await handleInput("can you check the tauri and rust build errors", text);
    expect(osTurns()[0]).toMatchObject({ role: "general", routeKind: "Self", routeReason: "Solo mode: kept with Tony" });
  });

  it("a live agent is routed (and announced) as before", async () => {
    await handleInput("can you check the tauri and rust build errors", text);
    expect(osTurns()[0]).toMatchObject({ role: "coder", routeKind: "Domain" });
    expect(routingNotices().some((t) => /^Routing .* to Coder/.test(t.text))).toBe(true);
    expect(gateFor()).toMatchObject({ summary: "Let Tony use Coder", detail: { role: "coder" } });
  });
});

describe("the Spotify fast path runs while Spotify is live for Tony (his always-on base)", () => {
  it("live (Builder lists it): the Spotify control runs in-process, no os_turn", async () => {
    useMode("builder");
    await handleInput("pause the music", text);
    expect(h.runSpotify).toHaveBeenCalledTimes(1);
    expect(osTurns()).toHaveLength(0);
  });

  it("a mode whose overlay doesn't list it (Operations) still runs it: it's in Tony's base", async () => {
    useMode("operations");
    await handleInput("pause the music", text);
    expect(h.runSpotify).toHaveBeenCalledTimes(1);
    expect(osTurns()).toHaveLength(0);
  });

  it("frozen on the master switchboard (no mode overlay): the same", async () => {
    mode.freeze = { frozenTools: ["spotify"] };
    await handleInput("pause the music", text);
    expect(h.runSpotify).not.toHaveBeenCalled();
    expect(osTurns()).toHaveLength(1);
  });

  it("Learning keeps Tony's base on too", async () => {
    useMode("learning");
    await handleInput("pause the music", text);
    expect(h.runSpotify).toHaveBeenCalledTimes(1);
  });
});
