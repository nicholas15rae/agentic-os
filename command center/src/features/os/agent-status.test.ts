import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Part 6 status on demand: the parse (it beats the router's Named routing), the templates, and the
 * handler (a store read: `task_status` / `task_get` only — never `os_turn`, never a model).
 */
const h = vi.hoisted(() => ({ cmd: vi.fn(), gateway: vi.fn(), tauri: true, patch: vi.fn(), cfg: null as null | { feedback: { sensitivity: number; narrationEngine: string } }, runs: {} as Record<string, unknown> }));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => h.tauri, onNativeEvent: async () => () => undefined }));
vi.mock("@/lib/gateway", () => ({ gateway: h.gateway }));
vi.mock("@/lib/cc-api", () => ({ collections: { snapshot: () => [] } }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command", go: vi.fn() }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => h.tauri,
  isAndroidApp: () => false, useSettings: { getState: () => ({ osName: "Tony", systemMapMode: "streamlined" }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ fireCue: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, gabagoolOn: () => false, nudgeCueVolume: vi.fn(), stopAllAudio: vi.fn(), useCueRun: { getState: () => ({ running: null }) } }));
vi.mock("@/features/services/use-health", () => ({ useHealthStore: { getState: () => ({ services: [{ label: "Gateway", up: true }] }) } }));
vi.mock("@/features/voice/voice-store", () => ({ useVoice: { getState: () => ({ state: "idle", activeThread: "auto", setActiveThread: vi.fn() }) } }));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: h.cfg, patch: h.patch }) } }));
vi.mock("@/features/os/pipeline-store", () => ({ usePipelines: { getState: () => ({ runs: h.runs, recent: {} }) } }));
vi.mock("@/features/memmap/devqueue-events", () => ({ notifyDevQueueChanged: vi.fn(), uiState: () => ({}) }));

import { addressedStatusLine, parseOsIntent, taskStatusText, type OsIntent, type StatusTask } from "./os-intent-parse";
import { agentStatusAction, runOsIntent, statusSummary } from "./os-intents";
import { resolve, DEFAULT_ROUTING_CONFIG } from "@/features/dispatcher/router";

const parse = (t: string) => parseOsIntent(t, { osName: "Tony" });

beforeEach(() => {
  h.cmd.mockReset();
  h.gateway.mockReset();
  h.patch.mockReset();
  h.tauri = true;
  h.cfg = null;
  h.runs = {};
});

describe("agent-status parse", () => {
  it.each<[string, OsIntent]>([
    ["what's the coder doing", { kind: "agent-status", agent: "coder" }],
    ["What is the designer working on?", { kind: "agent-status", agent: "designer" }],
    ["hey Tony, what's the prompter up to right now", { kind: "agent-status", agent: "prompter" }],
    ["how's the librarian doing", { kind: "agent-status", agent: "librarian" }],
    ["where's the build at", { kind: "agent-status" }],
    ["Where's the build at?", { kind: "agent-status" }],
    ["what are the agents doing", { kind: "agent-status" }],
    ["what's going on with the build", { kind: "agent-status" }],
    ["build status", { kind: "agent-status" }],
    ["where are we with the prototype", { kind: "agent-status" }],
    ["status of my-app", { kind: "agent-status", slug: "my-app", weak: true }],
    ["status of audition tracker", { kind: "agent-status", slug: "audition-tracker", weak: true }],
    ["status of the audition tracker build", { kind: "agent-status", slug: "audition-tracker" }],
    ["where's the audition tracker at", { kind: "agent-status", slug: "audition-tracker", weak: true }],
    ["status of my audition tracker", { kind: "agent-status", slug: "my-audition-tracker", weak: true }],
    ["Hey Prompter, where are we at?", { kind: "agent-status", agent: "prompter", addressed: true }],
    ["coder, status update", { kind: "agent-status", agent: "coder", addressed: true }],
    ["where are we at designer", { kind: "agent-status", agent: "designer", addressed: true }],
  ])("%s", (text, want) => expect(parse(text)).toEqual(want));

  it.each(["tell the coder to fix the login", "ask the designer to make it blue", "what's the weather doing", "status of it", "where's it at", "coder build me a login page", "what's the status of my order with the booking desk"])(
    "not a status line: %s",
    (text) => expect(parse(text)?.kind).not.toBe("agent-status"),
  );

  it("beats the router's Named routing (the parse runs before the router in handleInput)", () => {
    // The router alone would delegate the question to the Coder's workspace (an ungrounded guess).
    expect(resolve("what's the coder doing", DEFAULT_ROUTING_CONFIG, "Tony")).toMatchObject({ kind: "Named", role: "coder" });
    expect(parse("what's the coder doing")?.kind).toBe("agent-status");
    // A real delegation still routes.
    expect(parse("tell the coder to fix the login")).toBeNull();
  });

  it("the existing system status still wins its own phrases", () => {
    expect(parse("system status")).toEqual({ kind: "status" });
  });
});

describe("narration level by voice", () => {
  it.each<[string, OsIntent]>([
    ["narration off", { kind: "narration", level: 0 }],
    ["stop narrating", { kind: "narration", level: 0 }],
    ["narrate everything", { kind: "narration", level: 3 }],
    ["narrate handoffs", { kind: "narration", level: 2 }],
    ["narration on", { kind: "narration", level: 1 }],
    ["quieter narration", { kind: "narration", step: -1 }],
    ["more narration", { kind: "narration", step: 1 }],
  ])("%s", (text, want) => expect(parse(text)).toEqual(want));

  it("patches os.json feedback.sensitivity (clamped steps)", async () => {
    h.cfg = { feedback: { sensitivity: 3, narrationEngine: "roster" } };
    await runOsIntent({ kind: "narration", step: 1 });
    expect(h.patch).toHaveBeenLastCalledWith({ feedback: { sensitivity: 3 } });
    const r = await runOsIntent({ kind: "narration", level: 0 });
    expect(h.patch).toHaveBeenLastCalledWith({ feedback: { sensitivity: 0 } });
    expect(r?.reply).toMatch(/off/);
  });
});

const task = (over: Partial<StatusTask> = {}): StatusTask => ({ task_id: "t-1-aaaaaa", title: "Audition Tracker", status: "coding", stage: "code", current_owner: "coder", iteration_count: 2, max_iterations: 3, project_slug: "audition-tracker", updated_at: 1_000_000 - 40_000, ...over });

describe("taskStatusText (phone mirror template)", () => {
  const NOW = 1_000_000;
  it("formats owner, iteration n/max and age", () => {
    expect(taskStatusText([task()], { agent: "coder" }, NOW)).toBe("“Audition Tracker” is with the Coder, iteration 2 of 3, updated 40s ago.");
  });
  it("names the stage's agent (the Librarian pre-flight is owned by the prompter row)", () => {
    expect(taskStatusText([task({ stage: "preflight", current_owner: "prompter", status: "prompting" })], { agent: "librarian" }, NOW)).toMatch(/with the Librarian/);
  });
  it("idle agent, no builds, unknown slug, ready, failed", () => {
    expect(taskStatusText([task()], { agent: "designer" }, NOW)).toBe("The Designer isn't on a task right now.");
    expect(taskStatusText([], {}, NOW)).toBe("No builds in progress.");
    expect(taskStatusText([task()], { slug: "nope" }, NOW)).toBe("I don't have a build with that name.");
    expect(taskStatusText([task({ status: "review_ready" })], { slug: "audition-tracker" }, NOW)).toBe("“Audition Tracker” is ready for review in staging/audition-tracker/.".replace("/.", "."));
    expect(taskStatusText([task({ status: "failed", error: "max iterations" })], { slug: "audition-tracker" }, NOW)).toBe("“Audition Tracker” failed: max iterations");
  });
  it("counts open builds on a general question", () => {
    expect(taskStatusText([task(), task({ task_id: "t-2", title: "B", updated_at: NOW })], {}, NOW)).toMatch(/2 builds are open/);
  });
});

describe("agentStatusAction — a store read, never a model", () => {
  it("desktop: task_status with the agent; no os_turn", async () => {
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "task_status") return { text: "“Audition Tracker” is with the Coder (coder is building the prototype), iteration 2 of 3.", task_id: "t-1-aaaaaa", open: 1, active: [] };
      throw new Error(`unexpected ${name}`);
    });
    const r = await agentStatusAction({ kind: "agent-status", agent: "coder" });
    expect(r).toEqual({ reply: "“Audition Tracker” is with the Coder (coder is building the prototype), iteration 2 of 3.", agent: undefined });
    expect(h.cmd.mock.calls.map((c) => c[0])).toEqual(["task_status"]);
    expect(h.cmd.mock.calls[0][1]).toEqual({ agent: "coder", slug: undefined });
  });

  it("addressed: the agent's own line from the store (task_status voice), in its voice", async () => {
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "task_status") return { text: "templated", task_id: "t-1-aaaaaa", open: 1, active: [], voice: { agent: "prompter", text: "Spec's done, three screens, handing it to the Librarian.", task_id: "t-1-aaaaaa", source: "voice_summary" } };
      throw new Error(`unexpected ${name}`);
    });
    const r = await agentStatusAction({ kind: "agent-status", agent: "prompter", addressed: true });
    expect(r).toEqual({ reply: "Spec's done, three screens, handing it to the Librarian.", agent: "prompter" });
    expect(h.cmd.mock.calls.map((c) => c[0])).toEqual(["task_status"]);
  });

  it("addressed while the agent isn't on the build: a first-person line in its voice, never Tony's template", async () => {
    h.cmd.mockResolvedValue({ text: "The Coder isn't on a task right now.", task_id: null, open: 1, active: [], voice: { agent: "coder", text: `Nothing from me on "Audition Tracker" yet; it's with the Designer.`, task_id: "t-1", source: "templated" } });
    expect(await agentStatusAction({ kind: "agent-status", agent: "coder", addressed: true })).toEqual({ reply: `Nothing from me on "Audition Tracker" yet; it's with the Designer.`, agent: "coder" });
    // "What's the coder doing?" (not addressed) stays Tony's template, in Tony's voice.
    expect(await agentStatusAction({ kind: "agent-status", agent: "coder" })).toEqual({ reply: "The Coder isn't on a task right now.", agent: undefined });
  });

  it("'my audition tracker' also tries 'audition-tracker'", async () => {
    h.cmd.mockImplementation(async (_n: string, a: { slug?: string }) => (a.slug === "audition-tracker" ? { text: "found", task_id: "t-1", open: 1, active: [] } : { text: "I don't have a build with that name.", task_id: null, open: 0, active: [] }));
    expect((await agentStatusAction({ kind: "agent-status", slug: "my-audition-tracker" }))?.reply).toBe("found");
    expect(h.cmd.mock.calls.map((c) => c[1].slug)).toEqual(["my-audition-tracker", "audition-tracker"]);
  });

  it("a weak 'where's X at' with no such build falls through to Tony (null)", async () => {
    h.cmd.mockResolvedValue({ text: "I don't have a build with that name.", task_id: null, open: 0, active: [] });
    expect(await agentStatusAction({ kind: "agent-status", slug: "my-phone", weak: true })).toBeNull();
    // …but the strong form answers.
    expect((await agentStatusAction({ kind: "agent-status", slug: "my-phone" }))?.reply).toMatch(/don't have a build/);
  });

  it("phone: the gateway mirror, templated", async () => {
    h.tauri = false;
    h.gateway.mockResolvedValue({ items: [task({ updated_at: Date.now() - 5000, voice_summaries: { coder: { text: "Two files written.", at: 5 } } })] });
    const r = await agentStatusAction({ kind: "agent-status", agent: "coder" });
    expect(r?.reply).toMatch(/with the Coder, iteration 2 of 3/);
    expect(h.gateway).toHaveBeenCalledWith("/api/tasks?limit=50");
    const own = await agentStatusAction({ kind: "agent-status", agent: "coder", addressed: true });
    expect(own).toEqual({ reply: "Two files written.", agent: "coder" });
    expect(h.cmd).not.toHaveBeenCalled();
  });

  it("phone addressed lines mirror the desktop rules (pure)", () => {
    const now = Date.now();
    const open = task({ updated_at: now, stage: "design", current_owner: "designer", voice_summaries: { prompter: { text: "Spec's in.", at: 1 } } });
    expect(addressedStatusLine([open], "prompter")).toBe("Spec's in.");
    expect(addressedStatusLine([open], "designer")).toMatch(/^I'm on ".+" now; nothing to report yet\.$/);
    expect(addressedStatusLine([open], "coder")).toMatch(/^Nothing from me on ".+" yet; it's with the Designer\.$/);
    expect(addressedStatusLine([{ ...open, status: "queued", stage: null, current_owner: "tony" }], "coder")).toMatch(/queued for the Prompter\.$/);
    const done = [task({ status: "review_ready", updated_at: 5, voice_summaries: { coder: { text: "Old build shipped.", at: 5 } } }), task({ status: "failed", updated_at: 9, voice_summaries: { coder: { text: "Newer words.", at: 9 } } })];
    expect(addressedStatusLine(done, "coder")).toBe("Newer words.");
    expect(addressedStatusLine([], "librarian")).toBe("Nothing from me yet.");
  });

  it("system status adds active build counts", () => {
    h.runs = { a: {}, b: {} };
    expect(statusSummary()).toMatch(/2 builds in progress/);
  });
});

describe("regressions: status lines that are not about builds fall through to Tony", () => {
  it.each<[string, OsIntent]>([
    ["status of my audition booking", { kind: "agent-status", slug: "my-audition-booking", weak: true }],
    ["Hey Tony, status of my Amazon order", { kind: "agent-status", slug: "my-amazon-order", weak: true }],
    ["progress on the audition prep", { kind: "agent-status", slug: "audition-prep", weak: true }],
    ["status of the droplet", { kind: "agent-status", slug: "droplet", weak: true }],
    ["status on the booking for friday", { kind: "agent-status", slug: "booking-for-friday", weak: true }],
    ["how's the project going", { kind: "agent-status", weak: true }],
    ["where's the build at", { kind: "agent-status" }],
  ])("%s", (text, want) => expect(parse(text)).toEqual(want));

  it("desktop: no build by that name → null (Tony / the Booking Desk answer), never the canned 'no build' line", async () => {
    h.cmd.mockResolvedValue({ text: "I don't have a build with that name.", task_id: null, open: 0, active: [] });
    for (const t of ["status of my audition booking", "Hey Tony, status of my Amazon order", "status on the booking for friday"]) {
      const i = parse(t);
      expect(i?.kind).toBe("agent-status");
      expect(await runOsIntent(i!)).toBeNull();
    }
    h.cmd.mockResolvedValue({ text: "No builds in progress.", task_id: null, open: 0, active: [] });
    expect(await runOsIntent(parse("how's the project going")!)).toBeNull();
  });

  it("phone: a weak general line with no open build falls through; with one open it answers", async () => {
    h.tauri = false;
    h.gateway.mockResolvedValue({ items: [task({ status: "review_ready" })] });
    expect(await agentStatusAction({ kind: "agent-status", weak: true })).toBeNull();
    h.gateway.mockResolvedValue({ items: [task({ updated_at: Date.now() })] });
    expect((await agentStatusAction({ kind: "agent-status", weak: true }))?.reply).toMatch(/with the Coder/);
  });
});

describe("addressed status picks the agent's own task (regression)", () => {
  it("the Coder talks about the build it is on, not a newer queued one", () => {
    const a = task({ task_id: "a", title: "A", updated_at: 1000, stage: "code", current_owner: "coder" });
    const b = task({ task_id: "b", title: "B", updated_at: 2000, status: "queued", stage: null, current_owner: "tony", project_slug: "b" });
    expect(addressedStatusLine([a, b], "coder")).toBe(`I'm on "A" now; nothing to report yet.`);
  });

  it("its latest voice summary on a task that moved on beats a newer task it never touched", () => {
    const a = task({ task_id: "a", title: "A", updated_at: 1000, status: "prompting", stage: "verify", current_owner: "prompter", voice_summaries: { coder: { text: "Built A in one page.", at: 900 } } });
    const b = task({ task_id: "b", title: "B", updated_at: 2000, status: "queued", stage: null, current_owner: "tony", project_slug: "b" });
    expect(addressedStatusLine([a, b], "coder")).toBe("Built A in one page.");
  });
});
