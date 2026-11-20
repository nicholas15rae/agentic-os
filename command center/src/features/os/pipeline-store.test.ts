import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, TaskEnvelope } from "@/lib/platform";

/**
 * Part 6 build store: hydrated from the TaskEnvelope store after a restart, kept live by
 * `agent-event`, chat turns gated by feedback sensitivity 0/1/2/3, ledger Run/Retry helpers.
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});
const h = vi.hoisted(() => ({ cmd: vi.fn(), gateway: vi.fn(), toast: vi.fn(), cfg: { feedback: { sensitivity: 1, narrationEngine: "roster" } } as { feedback: { sensitivity: number; narrationEngine: string } } }));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined }));
vi.mock("@/lib/gateway", () => ({ gateway: h.gateway }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: h.toast }) } }));
vi.mock("./os-store", () => ({ useOs: { getState: () => ({ cfg: h.cfg }) }, osName: () => "Tony" }));

import { useVoice } from "@/features/voice/voice-store";
import { applyEvent, chatKind, stepTurn, hydrateFromStore, hydrateRuns, ideaAction, mergeRuns, onAgentEvent, runForIdea, runFromTask, runPipeline, stagingPath, trackTask, usePipelines, type PipelineRun } from "./pipeline-store";

function env(over: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    task_id: "t-1-aaaaaa",
    created_at: 1,
    updated_at: 100,
    status: "coding",
    stage: "code",
    current_owner: "coder",
    raw_intent: { text: "build a card", timestamp: 1, memory_reference: { source: "voice", thread: "general" } },
    title: "Status Card",
    project_slug: "status-card",
    iteration_count: 1,
    max_iterations: 3,
    prompt_spec: null,
    design_artifacts: null,
    coder_brief: null,
    code_artifacts: null,
    librarian_notes: null,
    last_eval: null,
    voice_summaries: {},
    idea_id: "idea-1",
    card_id: null,
    dedupe_key: null,
    options: {},
    lease_until: null,
    error: null,
    handoff_log: [],
    ...over,
  };
}
const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({ v: 1, seq: 1, at: 200, taskId: "t-1-aaaaaa", traceId: "task:t-1-aaaaaa", agentId: "coder", eventType: "stage_started", severity: "milestone", shortSummary: "Coder is building the prototype", status: "coding", owner: "coder", stage: "code", iteration: 1, ...over });
const turns = () => useVoice.getState().turns;

beforeEach(() => {
  usePipelines.setState({ runs: {}, recent: {}, unseen: 0 });
  useVoice.setState({ turns: [] });
  h.cmd.mockReset();
  h.toast.mockReset();
  h.cfg.feedback.sensitivity = 1;
});

describe("hydration (restart keeps the bars)", () => {
  it("open tasks are runs, finished ones recent; owner, iteration n/max, slug carried", () => {
    const s = hydrateRuns([env(), env({ task_id: "t-2", status: "review_ready", stage: "done", updated_at: 50 }), env({ task_id: "t-3", status: "failed", error: "max iterations" })]);
    expect(Object.keys(s.runs)).toEqual(["t-1-aaaaaa"]);
    expect(Object.keys(s.recent).sort()).toEqual(["t-2", "t-3"]);
    expect(s.runs["t-1-aaaaaa"]).toMatchObject({ owner: "coder", iteration: 1, maxIterations: 3, slug: "status-card", status: "coding", ideaId: "idea-1" });
    expect(s.recent["t-2"].pct).toBe(100);
    expect(s.recent["t-3"].error).toBe("max iterations");
  });

  it("hydrateFromStore reads task_list once and keeps newer live rows", async () => {
    usePipelines.setState({ runs: { "t-1-aaaaaa": { ...runFromTask(env()), at: 999, label: "live" } } });
    h.cmd.mockResolvedValue([env(), env({ task_id: "t-9", status: "queued", stage: null })]);
    await hydrateFromStore();
    expect(h.cmd).toHaveBeenCalledWith("task_list", { limit: 50 });
    const r = usePipelines.getState().runs;
    expect(r["t-1-aaaaaa"].label).toBe("live");
    expect(r["t-9"].pct).toBe(2);
  });

  it("mergeRuns moves a row that finished meanwhile into recent", () => {
    const base = hydrateRuns([env()]);
    const live = { runs: {}, recent: { "t-1-aaaaaa": { ...runFromTask(env({ status: "review_ready" })), at: 500 } } };
    const m = mergeRuns(base, live);
    expect(m.runs["t-1-aaaaaa"]).toBeUndefined();
    expect(m.recent["t-1-aaaaaa"].status).toBe("review_ready");
  });
});

describe("events fold into rows", () => {
  it("a stage event updates the row; a terminal one moves it to recent; a retry brings it back", () => {
    let s = applyEvent({ runs: {}, recent: {} }, ev());
    expect(s.runs["t-1-aaaaaa"]).toMatchObject({ stage: "code", owner: "coder", label: "Coder is building the prototype" });
    s = applyEvent(s, ev({ eventType: "review_ready", status: "review_ready", stage: "done", owner: "staging" }));
    expect(s.runs["t-1-aaaaaa"]).toBeUndefined();
    expect(s.recent["t-1-aaaaaa"].status).toBe("review_ready");
    s = applyEvent(s, ev({ eventType: "retry", status: "coding" }));
    expect(s.recent["t-1-aaaaaa"]).toBeUndefined();
    expect(s.runs["t-1-aaaaaa"]).toBeDefined();
  });

  it("non-task events leave rows alone", () => {
    const s = { runs: {}, recent: {} };
    expect(applyEvent(s, ev({ taskId: undefined }))).toBe(s);
  });
});

describe("chat turns gated by sensitivity 0/1/2/3", () => {
  const sample: AgentEvent[] = [
    ev({ eventType: "task_queued", severity: "milestone", agentId: "tony", stage: undefined }),
    ev({ eventType: "handoff", severity: "handoff", agentId: "prompter" }),
    ev({ eventType: "progress", severity: "verbose" }),
    ev({ eventType: "discrepancy", severity: "critical", agentId: "librarian" }),
    ev({ eventType: "failed", severity: "critical", status: "failed" }),
    ev({ eventType: "review_ready", severity: "milestone", status: "review_ready" }),
  ];
  it.each([
    [0, ["alert", "failed", "ready"]],
    [1, ["relay", "alert", "failed", "ready"]],
    [2, ["relay", "relay", "alert", "failed", "ready"]],
    [3, ["relay", "relay", "relay", "alert", "failed", "ready"]],
  ])("level %i", (level, want) => {
    expect(sample.map((e) => chatKind(e, level)).filter(Boolean)).toEqual(want);
  });

  it("level 1: the milestone relay goes to the agent's tab, a handoff adds nothing; failures land where asked, with Retry/Offload", async () => {
    trackTask("t-1-aaaaaa", "Status Card", "auto");
    h.cmd.mockResolvedValue(env({ status: "failed", error: "coder timed out" }));
    await onAgentEvent(ev({ agentId: "prompter", eventType: "stage_started", severity: "milestone" }));
    await onAgentEvent(ev({ eventType: "handoff", severity: "handoff" }));
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toMatchObject({ who: "relay", thread: "prompter", text: "Coder is building the prototype" });
    await onAgentEvent(ev({ eventType: "failed", severity: "critical", status: "failed", shortSummary: "Coder timed out" }));
    const fail = turns()[1];
    expect(fail).toMatchObject({ who: "agent", thread: "auto" });
    expect(fail.actions?.map((a) => a.run)).toEqual(["retry:t-1-aaaaaa", "offload:claude-cli:t-1-aaaaaa", "offload:gemini-cli:t-1-aaaaaa"]);
    expect(h.toast).toHaveBeenCalledTimes(1);
    // ONE failure turn per failure event (the old duplicate pipeline-failed turn is gone).
    expect(turns().filter((t) => /failed/.test(t.text))).toHaveLength(1);
  });

  it("level 0: no relay turns, but review_ready still shows (with its staging path) and bumps the badge", async () => {
    h.cfg.feedback.sensitivity = 0;
    trackTask("t-1-aaaaaa", "Status Card", "general");
    h.cmd.mockResolvedValue(env({ status: "review_ready", stage: "done" }));
    await onAgentEvent(ev());
    expect(turns()).toHaveLength(0);
    await onAgentEvent(ev({ eventType: "review_ready", status: "review_ready", stage: "done" }));
    expect(turns()).toHaveLength(1);
    expect(turns()[0].text).toBe("“Status Card” is ready for review. It's in staging/status-card.");
    expect(usePipelines.getState().unseen).toBe(1);
  });

  it("Phase 2 Part C: switching to a silent mode (Surface / Solo) writes level 0, so a milestone adds no turn", async () => {
    const { PRESET_MODES, feedbackFor } = await import("@/features/modes/modes");
    // What Rust's tony_mode_set_active writes into os.json feedback.sensitivity (D17).
    h.cfg.feedback.sensitivity = feedbackFor(PRESET_MODES.find((m) => m.id === "surface")!.tts_interrupt_level);
    expect(h.cfg.feedback.sensitivity).toBe(0);
    trackTask("t-1-aaaaaa", "Status Card", "auto");
    await onAgentEvent(ev({ agentId: "prompter", eventType: "stage_started", severity: "milestone" }));
    await onAgentEvent(ev({ eventType: "handoff", severity: "handoff" }));
    expect(turns()).toHaveLength(0);
    // Builder (full) narrates handoffs too.
    h.cfg.feedback.sensitivity = feedbackFor(PRESET_MODES.find((m) => m.id === "builder")!.tts_interrupt_level);
    await onAgentEvent(ev({ eventType: "handoff", severity: "handoff" }));
    expect(turns()).toHaveLength(1);
  });

  it("level 3: verbose progress shows too", async () => {
    h.cfg.feedback.sensitivity = 3;
    await onAgentEvent(ev({ eventType: "progress", severity: "verbose", agentId: "designer" }));
    expect(turns()[0]).toMatchObject({ who: "relay", thread: "designer" });
  });

  it("a critical bus note (no task) is a toast, not a turn", async () => {
    await onAgentEvent(ev({ taskId: undefined, agentId: "librarian", eventType: "discrepancy", severity: "critical", shortSummary: "Set it to Query mode." }));
    expect(turns()).toHaveLength(0);
    expect(h.toast).toHaveBeenCalledTimes(1);
  });
});

describe("ledger Run / Retry", () => {
  it("runPipeline queues a task for the idea and returns at once", async () => {
    h.cmd.mockResolvedValue({ taskId: "t-5", created: true, cardId: null, hasHtml: false, steps: [] });
    await runPipeline("idea-1", "Budget App", "general");
    expect(h.cmd).toHaveBeenCalledWith("idea_pipeline_run", { ideaId: "idea-1" });
    expect(usePipelines.getState().runs["t-5"]).toMatchObject({ title: "Budget App", ideaId: "idea-1", status: "queued" });
    expect(turns()[0].text).toBe("Queued “Budget App” for the Prompter.");
  });

  it("ideaAction: Retry for prototyping/failed, nothing while live", () => {
    expect(ideaAction("failed", false, true)).toBe("retry");
    expect(ideaAction("failed", false, false)).toBe("run");
    expect(ideaAction("prototyping", false, true)).toBe("run"); // stuck: queue again (an open task is reused)
    expect(ideaAction("prototyping", true, true)).toBeNull();
    expect(ideaAction("captured", false, false)).toBe("run");
    expect(ideaAction("staged", false, true)).toBe("rebuild");
    expect(ideaAction("archived", false, false)).toBeNull();
  });

  it("runForIdea finds the build by task id or by idea id; stagingPath", () => {
    const r: PipelineRun = runFromTask(env());
    expect(runForIdea({ id: "idea-1" }, { [r.id]: r })).toBe(r);
    expect(runForIdea({ id: "x", taskId: r.id }, {}, { [r.id]: r })).toBe(r);
    expect(runForIdea({ id: "x" }, { [r.id]: r })).toBeUndefined();
    expect(stagingPath("status-card")).toBe("staging/status-card/");
    expect(stagingPath(null)).toBeNull();
  });
});

describe("pipeline-step turns (regressions)", () => {
  const step = (over: Record<string, unknown> = {}) => ({ pipelineId: "card-1", ideaId: null, cardId: "card-1", stage: "build", pct: 100, thread: "coder", kind: "reply", from: "coder", to: "os", text: "Implementation: …", ok: true, ms: 1200, ...over }) as never;

  it("Play Place approve / revise results and verifier notes always reach the chat, at any level (default 1 included)", () => {
    for (const lv of [0, 1, 2, 3]) {
      h.cfg.feedback.sensitivity = lv;
      expect(stepTurn(step())).toBe("relay");
      expect(stepTurn(step({ kind: "verify", from: "verifier", text: "✓ build verified" }))).toBe("verify");
    }
  });

  it("a worker stage's legacy step earns no turn (agent-event already shows it): no double relays at level 2+", () => {
    h.cfg.feedback.sensitivity = 3;
    expect(stepTurn(step({ source: "worker", kind: "delegate" }))).toBeNull();
    expect(stepTurn(null)).toBeNull();
  });
});
