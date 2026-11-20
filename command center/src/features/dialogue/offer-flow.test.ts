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
  trackTask: vi.fn(),
  buildArtifact: vi.fn(),
  saveArtifact: vi.fn(),
  dispatch: vi.fn(),
  queueDesktopTurn: vi.fn(),
  queueDesktopItem: vi.fn(),
  speak: vi.fn(),
}));
const env = vi.hoisted(() => ({ tauri: true }));

// Phase 2 Part C: Tony's mode (the Tier-3 decision). Defaults to Brainstorming = today's offer card.
const mode = vi.hoisted(() => ({ effective: null as unknown }));
vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  mode.effective = m.DEFAULT_EFFECTIVE;
  return { useModes: { getState: () => ({ effective: mode.effective, load: async () => undefined }) } };
});

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => env.tauri, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  useSettings: { getState: () => ({ osName: "Tony", wakeMode: false, confirmTimeoutSec: 30, routing: { announcerHandoff: false }, audioRoute: "auto" }) },
}));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: null }) }, osName: () => "Tony", useOsName: () => "Tony" }));
vi.mock("@/sections/settings/use-providers", () => ({ useProviders: { getState: () => ({ view: null, load: async () => undefined }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ cueFor: () => null, fireCue: vi.fn(), registerCueIO: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, registerSpeechCancel: vi.fn(), setCueDuck: vi.fn(), stopAllAudio: vi.fn() }));
vi.mock("@/features/os/os-intents", () => ({ cuePlayingNow: () => false, parseOsLine: () => null, runOsIntent: vi.fn() }));
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: async () => null, runPendingSpotify: vi.fn(), runSpotifyIntent: vi.fn() }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: h.runPipeline, trackTask: h.trackTask, usePipelines: { getState: () => ({ runs: {}, recent: {} }) } }));
vi.mock("@/features/os/context", () => ({ liveContext: async () => "" }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: async () => null }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_o: unknown, call: (approved: boolean) => Promise<unknown>) => call(false) }));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: h.dispatch, queueDesktopTurn: h.queueDesktopTurn, queueDesktopItem: h.queueDesktopItem }));
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
import { approve, BUILD_QUEUED_LINE, BUILD_SENT_LINE, handleInput, parkPending, reject, requestBuild, requestPipeline, OFFER_READBACK, SOLO_PARK_READBACK } from "@/features/voice/voice-controller";
import { DEFAULT_EFFECTIVE, PRESET_MODES, effectiveOf } from "@/features/modes/modes";

const useMode = (id: string) => {
  mode.effective = effectiveOf(PRESET_MODES, id);
};

const text = { channel: "text" as const, thread: "auto" as const };
const osTurns = () => h.cmd.mock.calls.filter((c) => c[0] === "os_turn").map((c) => c[1].req);
const taskCreates = () => h.cmd.mock.calls.filter((c) => c[0] === "task_create").map((c) => c[1]);
const texts = () => useVoice.getState().turns.map((t) => t.text);

beforeEach(() => {
  env.tauri = true;
  mode.effective = DEFAULT_EFFECTIVE;
  useVoice.setState({ turns: [], pending: null, state: "idle" });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
    if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
    // The legacy shim never resolves: a build must not wait on it (and must not call it at all).
    if (name === "idea_capture") return new Promise(() => undefined);
    if (name === "task_create") return { task_id: "t-1-abcdef", created: true, status: "queued", title: "Audition Tracker" };
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

  it("'yes' runs the plan exactly once, through approve(): ONE task_create, zero idea_capture", async () => {
    await brainstorm();
    await handleInput("ok let's do it", text);
    await handleInput("yes", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "idea_capture")).toHaveLength(0);
    expect(taskCreates()).toHaveLength(1);
    expect(taskCreates()[0]).toMatchObject({ thread: "auto", source: "typed" });
    expect(taskCreates()[0].raw_intent).toMatch(/audition tracker/i);
    expect(h.trackTask).toHaveBeenCalledWith("t-1-abcdef", "Audition Tracker", "auto");
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(texts().some((t) => t.startsWith("Approved (typed): Delegate"))).toBe(true);
    expect(useDialogue.getState().active("auto")).toBeNull();
  });

  it("thin Tony: the approved build returns at once with the templated line (the worker does the rest)", async () => {
    // execute() runs plan.run; a never-resolving idea_capture would hang it if it were still called.
    await brainstorm();
    await handleInput("ok let's do it", text);
    await handleInput("yes", text);
    const out = await h.execute.mock.results[0].value;
    expect(out.text).toBe(BUILD_QUEUED_LINE);
    expect(BUILD_QUEUED_LINE).toBe("Queued. The Prompter's on it. Ask me where the build's at anytime.");
    expect(useVoice.getState().state).toBe("idle");
  });

  it("no approve → zero task_create (decline, timeout, park, unrelated text)", async () => {
    for (const end of [() => handleInput("no", text), () => reject("timed out"), () => handleInput("nah, park it", text), () => handleInput("what about a dark mode", text)]) {
      useVoice.setState({ turns: [], pending: null, state: "idle" });
      useDialogue.setState({ sessions: {} });
      await brainstorm();
      await handleInput("ok let's do it", text);
      expect(useVoice.getState().pending?.plan.offer).toBe("delegate");
      await end();
    }
    expect(taskCreates()).toHaveLength(0);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "idea_capture")).toHaveLength(0);
  });

  it("a duplicate build (already queued) says so instead of the queued line", async () => {
    h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
      if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
      if (name === "task_create") return { task_id: "t-1-abcdef", created: false, status: "coding", title: "Audition Tracker" };
      throw new Error(`unexpected cmd ${name}`);
    });
    await brainstorm();
    await handleInput("ok let's do it", text);
    await handleInput("yes", text);
    expect((await h.execute.mock.results[0].value).text).toMatch(/already queued/);
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
  it("Build prototype (Play Place) raises a card; only approve() queues ONE task", async () => {
    await requestBuild("a budgeting app with charts", "Budget App", "general");
    expect(taskCreates()).toHaveLength(0);
    await approve("tap");
    expect(taskCreates()).toHaveLength(1);
    expect(taskCreates()[0]).toMatchObject({ raw_intent: "a budgeting app with charts", title: "Budget App", thread: "general", source: "playplace" });
  });

  it("requestPipeline raises a card; only approve() starts it", async () => {
    await requestPipeline("idea-9", "Budget App", "general");
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(useVoice.getState().pending?.plan.summary).toMatch(/Budget App/);
    await approve("tap");
    expect(h.runPipeline).toHaveBeenCalledWith("idea-9", "Budget App", "general");
  });
});

describe("Phase 2 Part C — Tony's mode decides the Tier-3 commit cue", () => {
  it("the default mode is Brainstorming: today's offer card", () => {
    expect((mode.effective as { mode_id: string }).mode_id).toBe("brainstorm");
  });

  it("Builder: a build-shaped brainstorm + commit cue queues ONE auto task, no card, and ends the dialogue", async () => {
    useMode("builder");
    await brainstorm();
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(taskCreates()).toHaveLength(1);
    expect(taskCreates()[0]).toMatchObject({ auto: true, thread: "auto", source: "typed" });
    expect(taskCreates()[0].raw_intent).toMatch(/audition tracker/i);
    expect(texts()).toContain(BUILD_QUEUED_LINE);
    expect(texts().some((t) => t === OFFER_READBACK || t.startsWith("Approved"))).toBe(false);
    expect(h.trackTask).toHaveBeenCalledWith("t-1-abcdef", "Audition Tracker", "auto");
    expect(useDialogue.getState().active("auto")).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("Builder: Rust refusing the auto build (stale mode) falls back to the offer card", async () => {
    useMode("builder");
    h.cmd.mockImplementation(async (name: string, args: { req?: { text: string } }) => {
      if (name === "os_turn") return { answer: `Tony: ${args.req?.text}`, steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
      if (name === "task_create") throw new Error("MODE_NOT_AUTO: only Builder mode queues a build without your yes; nothing was queued.");
      throw new Error(`unexpected cmd ${name}`);
    });
    await brainstorm();
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending?.plan.offer).toBe("delegate");
    expect(useVoice.getState().pending?.plan.readBack).toBe(OFFER_READBACK);
  });

  describe("phone (PWA): the desktop's answer decides what Tony says (fix pass)", () => {
    const phoneBrainstorm = async () => {
      env.tauri = false;
      h.queueDesktopTurn.mockImplementation(async (p: { text: string }) => ({ answer: `Tony: ${p.text}` }));
      useMode("builder"); // the phone's (possibly stale) view
      await brainstorm();
      await handleInput("ok let's do it", text);
    };

    it("a desktop Solo refusal is never announced as 'Queued': the park card comes up", async () => {
      h.queueDesktopItem.mockRejectedValue(new Error("MODE_SURFACE_ONLY: Solo mode is on; nothing was queued."));
      await phoneBrainstorm();
      expect(h.queueDesktopItem).toHaveBeenCalledWith("task", expect.objectContaining({ auto: true }), expect.anything());
      expect(texts()).not.toContain(BUILD_QUEUED_LINE);
      expect(useVoice.getState().pending?.plan.readBack).toBe(SOLO_PARK_READBACK);
    });

    it("a desktop MODE_NOT_AUTO falls back to the offer card", async () => {
      h.queueDesktopItem.mockRejectedValue(new Error("MODE_NOT_AUTO: only Builder mode queues a build without your yes; nothing was queued."));
      await phoneBrainstorm();
      expect(texts()).not.toContain(BUILD_QUEUED_LINE);
      expect(useVoice.getState().pending?.plan.readBack).toBe(OFFER_READBACK);
    });

    it("'Queued' only once the desktop created the task; unclaimed = 'sent', not 'queued'", async () => {
      h.queueDesktopItem.mockResolvedValue({ taskId: "t-9", created: true, status: "queued", title: "Audition Tracker" });
      await phoneBrainstorm();
      expect(texts()).toContain(BUILD_QUEUED_LINE);
      useVoice.setState({ turns: [] });
      useDialogue.setState({ sessions: {} });
      h.queueDesktopItem.mockResolvedValue(null);
      await brainstorm();
      await handleInput("ok let's do it", text);
      expect(texts()).toContain(BUILD_SENT_LINE);
      expect(texts()).not.toContain(BUILD_QUEUED_LINE);
    });
  });

  it("Builder: a brainstorm about an agent (not a build) still gets the offer card", async () => {
    useMode("builder");
    await handleInput("what if the layout had a sidebar", text);
    await handleInput("ok let's do it", text);
    const p = useVoice.getState().pending;
    expect(p?.plan.offer).toBe("delegate");
    expect(p?.plan.summary).toMatch(/Designer/);
    expect(taskCreates()).toHaveLength(0);
  });

  it("Builder: a mutating request still goes through the confirmation card (approve())", async () => {
    useMode("builder");
    await handleInput("email Sam the notes", text);
    expect(useVoice.getState().pending?.plan.mutating).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(taskCreates()).toHaveLength(0);
  });

  it("Builder: Build prototype and a ledger Run still raise a card", async () => {
    useMode("builder");
    await requestBuild("a budgeting app with charts", "Budget App", "general");
    expect(useVoice.getState().pending).not.toBeNull();
    expect(taskCreates()).toHaveLength(0);
    reject("dismissed");
    await requestPipeline("idea-9", "Budget App", "general");
    expect(useVoice.getState().pending).not.toBeNull();
    expect(h.runPipeline).not.toHaveBeenCalled();
  });

  it("Solo: a commit cue hands nothing off — a park-only card; yes parks it once", async () => {
    useMode("surface");
    await brainstorm();
    await handleInput("ok let's do it", text);
    const p = useVoice.getState().pending;
    expect(p?.plan.offer).toBe("park");
    expect(p?.plan.readBack).toBe(SOLO_PARK_READBACK);
    expect(p?.plan.summary).toMatch(/Brainstorm list/);
    expect(taskCreates()).toHaveLength(0);
    expect(h.saveArtifact).not.toHaveBeenCalled();
    await handleInput("yes", text);
    expect(useVoice.getState().pending).toBeNull();
    expect(h.saveArtifact).toHaveBeenCalledTimes(1);
    expect(h.saveArtifact.mock.calls[0][0]).toBe("brainstorm");
    expect(taskCreates()).toHaveLength(0);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "idea_capture")).toHaveLength(0);
    expect(texts()).toContain("Saved “Audition Tracker” to your Brainstorm list.");
  });

  it("a build Rust refuses for the mode is a calm spoken-safe line, raw text kept in meta", async () => {
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "task_create") throw new Error("MODE_SURFACE_ONLY: Solo mode is on; nothing was queued.");
      throw new Error(`unexpected cmd ${name}`);
    });
    await requestBuild("a budgeting app with charts", "Budget App", "general");
    await approve("tap");
    const last = useVoice.getState().turns.at(-1)!;
    expect(last.text).toBe("Solo mode is on, so nothing was queued. Switch modes and I'll build it, or I can park it for later.");
    expect(last.meta).toMatch(/^MODE_SURFACE_ONLY/);
  });

  it("Solo: an agent-shaped brainstorm is not delegated either; 'no' leaves it with Tony", async () => {
    useMode("surface");
    await handleInput("what if the layout had a sidebar", text);
    await handleInput("ok let's do it", text);
    expect(useVoice.getState().pending?.plan.offer).toBe("park");
    await handleInput("no", text);
    expect(h.saveArtifact).not.toHaveBeenCalled();
    expect(osTurns().some((r) => r.role !== "general")).toBe(false);
  });
});
