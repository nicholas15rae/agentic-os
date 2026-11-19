import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P3 flow through the real voice controller (typed channel, desktop): Tier 2 stays with Tony,
 * a commit cue raises the Tier-3 offer card, and the card's replies — park / yes / anything else
 * / timeout — do exactly what they should. Engines, audio and the gateway are stubbed.
 */
// The voice store persists its threads; give it an in-memory storage (node has none).
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  execute: vi.fn(),
  runPipeline: vi.fn(),
  setOffered: vi.fn(),
  buildArtifact: vi.fn(),
  saveArtifact: vi.fn(),
  dispatch: vi.fn(),
  queueDesktopTurn: vi.fn(),
  speak: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  useSettings: { getState: () => ({ osName: "Tony", wakeMode: false, confirmTimeoutSec: 30, routing: { announcerHandoff: false, autoSwitch: false }, audioRoute: "auto" }) },
}));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: null }) }, osName: () => "Tony", useOsName: () => "Tony" }));
vi.mock("@/sections/settings/use-providers", () => ({ useProviders: { getState: () => ({ view: null, load: async () => undefined }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ cueFor: () => null, fireCue: vi.fn(), registerCueIO: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, registerSpeechCancel: vi.fn(), setCueDuck: vi.fn(), stopAllAudio: vi.fn() }));
vi.mock("@/features/os/os-intents", () => ({ cuePlayingNow: () => false, parseOsLine: () => null, runOsIntent: vi.fn() }));
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: async () => null, runPendingSpotify: vi.fn(), runSpotifyIntent: vi.fn() }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: h.runPipeline, usePipelines: { getState: () => ({ offered: null, setOffered: h.setOffered }) } }));
vi.mock("@/features/os/context", () => ({ liveContext: async () => "" }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: async () => null }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_o: unknown, call: (approved: boolean) => Promise<unknown>) => call(false) }));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: h.dispatch, queueDesktopTurn: h.queueDesktopTurn }));
vi.mock("@/features/dialogue/package", async (orig) => ({ ...(await orig<typeof import("./package")>()), buildArtifact: h.buildArtifact, saveArtifact: h.saveArtifact }));
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

import { useDialogue } from "./dialogue-store";
import { useVoice } from "@/features/voice/voice-store";
import { approve, handleInput, parkPending, reject, requestPipeline, OFFER_READBACK } from "@/features/voice/voice-controller";

const text = { channel: "text" as const, thread: "auto" as const };
const osTurns = () => h.cmd.mock.calls.filter((c) => c[0] === "os_turn").map((c) => c[1].req);
const texts = () => useVoice.getState().turns.map((t) => t.text);

beforeEach(() => {
  useVoice.setState({ turns: [], pending: null, state: "idle" });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
    if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    if (name === "idea_capture") return { idea: { id: "idea-1", title: "Audition Tracker", idea: "x", tasks: [{ id: "a", text: "t", done: false }], status: "captured" }, reply: "…", steps: [] };
    throw new Error(`unexpected cmd ${name}`);
  });
  h.execute.mockImplementation(async (plan: { run?: () => Promise<{ text: string; meta: string }> }) => (plan.run ? plan.run() : { text: "ok", meta: "" }));
  h.buildArtifact.mockImplementation(async () => ({ title: "Audition Tracker", summary: "s", rawContext: "r", timestamp: 1, tags: [] }));
  h.saveArtifact.mockResolvedValue({ id: "n1", target: "brainstorm" });
});

async function brainstorm() {
  await handleInput("I've been thinking about building an audition tracker", text);
}

describe("Tier 2 — the brainstorm stays with Tony", () => {
  it("an idea line is Tony's own turn with noDelegate — no Prompter, no card", async () => {
    await brainstorm();
    expect(h.cmd).not.toHaveBeenCalledWith("idea_capture", expect.anything());
    expect(osTurns()).toHaveLength(1);
    expect(osTurns()[0]).toMatchObject({ role: "general", routeKind: "Self", noDelegate: true });
    expect(useVoice.getState().pending).toBeNull();
    expect(useDialogue.getState().active("auto")).not.toBeNull();
  });

  it("a mutating command that mentions a brainstorm is not swallowed by Tier 2", async () => {
    // Fix pass: "send my brainstorm notes to Sam" was a brainstormTurn (noDelegate, no card).
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "os_turn") return { answer: "x", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
      throw new Error(`offline ${name}`); // planner / verifier unavailable: heuristic plan
    });
    await handleInput("send my brainstorm notes to Sam", text);
    expect(osTurns().some((r) => r.noDelegate)).toBe(false);
    expect(useDialogue.getState().active("auto")).toBeNull();
    expect(useVoice.getState().pending?.plan.mutating).toBe(true); // the card, behind approve()
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("a Domain-shaped what-if is not handed to the Designer", async () => {
    await handleInput("what if the layout had a sidebar", text);
    expect(osTurns()[0]).toMatchObject({ role: "general", noDelegate: true });
  });
});

describe("Tier 3 — the delegation offer card", () => {
  it("a commit cue in a live brainstorm raises the offer with the exact read-back; nothing runs", async () => {
    await brainstorm();
    h.cmd.mockClear();
    await handleInput("ok let's do it", text);
    const p = useVoice.getState().pending;
    expect(p?.plan.offer).toBe("delegate");
    expect(p?.plan.readBack).toBe(OFFER_READBACK);
    expect(OFFER_READBACK).toBe("Want me to go ahead and delegate that, or park it for later?");
    expect(p?.plan.summary).toMatch(/pipeline/);
    expect(h.cmd).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("the same cue with no brainstorm is just a turn for Tony (no card)", async () => {
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(osTurns()).toHaveLength(1);
  });

  it("'park it' saves to the Brainstorm list and never runs the plan", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    await handleInput("nah, park it", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(h.saveArtifact).toHaveBeenCalledTimes(1);
    expect(h.saveArtifact.mock.calls[0][0]).toBe("brainstorm");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.cmd).not.toHaveBeenCalledWith("idea_capture", expect.anything());
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(texts()).toContain("Saved “Audition Tracker” to your Brainstorm list.");
    expect(texts().some((t) => /Cancelled/.test(t))).toBe(false);
    expect(useDialogue.getState().active("auto")).toBeNull();
  });

  it("the card's Park it button does the same", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    parkPending();
    await vi.waitFor(() => expect(h.saveArtifact).toHaveBeenCalledTimes(1));
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("'yes' runs the plan exactly once, through approve()", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    await handleInput("yes", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "idea_capture")).toHaveLength(1);
    expect(h.runPipeline).toHaveBeenCalledTimes(1);
    expect(h.runPipeline.mock.calls[0][0]).toBe("idea-1");
    expect(texts().some((t) => t.startsWith("Approved (typed): Delegate"))).toBe(true);
    expect(useDialogue.getState().active("auto")).toBeNull();
  });

  it("a commit-cue reply answers the card (yes) instead of re-raising the same offer", async () => {
    // Fix pass: "ok let's do it" / "sounds good" / "ship it" parsed as "other", re-entered as a
    // Tier-3 turn and raised an identical card — the spec's own cue could never answer it.
    for (const reply of ["ok let's do it", "sounds good", "lock it in", "that's the plan", "ship it"]) {
      useVoice.setState({ turns: [], pending: null, state: "idle" });
      useDialogue.setState({ sessions: {} });
      h.execute.mockClear();
      await brainstorm();
      await handleInput("ok let's do it", text);
      expect(useVoice.getState().pending?.plan.offer, reply).toBe("delegate");
      await handleInput(reply, text);
      expect(useVoice.getState().pending, reply).toBeNull();
      expect(h.execute, reply).toHaveBeenCalledTimes(1);
      expect(texts().some((t) => t.startsWith("Approved (typed): Delegate")), reply).toBe(true);
    }
  });

  it("a hedged cue is not a yes: the card drops and the line is a new turn", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    await handleInput("ok let's do it but make it blue", text);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("unrelated text silently drops the card and is a new turn", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    h.cmd.mockClear();
    await handleInput("actually, what about a dark mode", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
    expect(texts().some((t) => /Cancelled|nothing was delegated/.test(t))).toBe(false);
    expect(osTurns()).toHaveLength(1);
    expect(osTurns()[0].text).toMatch(/dark mode/);
    expect(texts().filter((t) => t === "actually, what about a dark mode")).toHaveLength(1);
  });

  it("a timeout says nothing; 'no' leaves one quiet line", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    h.speak.mockClear();
    reject("timed out");
    expect(useVoice.getState().pending).toBeNull();
    expect(texts().some((t) => /Cancelled|nothing was delegated/.test(t))).toBe(false);
    expect(h.speak).not.toHaveBeenCalled();
    await handleInput("ok let's do it", text);
    await handleInput("not now", text);
    expect(texts()).toContain("Kept it with Tony — nothing was delegated.");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.speak).not.toHaveBeenCalled();
  });
});

describe("Tier 4 — save it for later", () => {
  it("parks without a plan, a card or an agent", async () => {
    await brainstorm();
    h.cmd.mockClear();
    await handleInput("put it in Play Place", text);
    expect(h.saveArtifact).toHaveBeenCalledTimes(1);
    expect(h.saveArtifact.mock.calls[0][0]).toBe("playplace");
    // The defer line itself isn't packaged.
    const slice = h.buildArtifact.mock.calls[0][0] as { text: string }[];
    expect(slice.map((t) => t.text)).not.toContain("put it in Play Place");
    expect(h.cmd).not.toHaveBeenCalled();
    expect(useVoice.getState().pending).toBeNull();
  });

  it("with nothing said yet, nothing is saved", async () => {
    await handleInput("save it for later", text);
    expect(h.saveArtifact).not.toHaveBeenCalled();
    expect(texts()).toContain("There's nothing to save yet — tell me the idea first.");
  });
});

describe("pipeline runs are always behind the card", () => {
  it("requestPipeline raises a card; only approve() starts it", async () => {
    await requestPipeline("idea-9", "Budget App", "general");
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(useVoice.getState().pending?.plan.summary).toMatch(/Budget App/);
    await approve("tap");
    expect(h.runPipeline).toHaveBeenCalledWith("idea-9", "Budget App", "general");
  });
});
