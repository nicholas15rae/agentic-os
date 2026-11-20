import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/platform";
import { agentEventToStep, agentLanes, groupTraces, normalizeStep } from "./trace-store";

/** Part 6: agent-event → System Map trace steps (per-agent lane, severity chip, scrubbed). */
const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({ v: 1, seq: 1, at: 1000, taskId: "t-1-aaaaaa", traceId: "task:t-1-aaaaaa", agentId: "coder", eventType: "stage_started", severity: "milestone", shortSummary: "Coder is building the prototype", ...over });

describe("agentEventToStep", () => {
  it("keys the step to the task, with its agent lane and severity chip", () => {
    const s = agentEventToStep(ev(), 0)!;
    expect(s).toMatchObject({ traceId: "task:t-1-aaaaaa", hop: "router", zone: "engine", ok: true, agent: "coder", severity: "milestone" });
    expect(s.label).toBe("coder · stage started · Coder is building the prototype");
  });

  it("maps event types to hops; failed / discrepancy are ok:false with the summary as the error", () => {
    expect(agentEventToStep(ev({ eventType: "stage_completed", agentId: "librarian" }), 0)!.hop).toBe("memory");
    expect(agentEventToStep(ev({ eventType: "stage_completed" }), 0)!.hop).toBe("model");
    expect(agentEventToStep(ev({ eventType: "loop_iteration" }), 0)!.hop).toBe("rules");
    expect(agentEventToStep(ev({ eventType: "review_ready" }), 0)!.hop).toBe("ui");
    const f = agentEventToStep(ev({ eventType: "failed", severity: "critical", shortSummary: "Coder timed out" }), 1)!;
    expect([f.ok, f.error, f.severity]).toEqual([false, "Coder timed out", "critical"]);
    const d = agentEventToStep(ev({ eventType: "discrepancy", severity: "critical", agentId: "librarian" }), 2)!;
    expect([d.ok, d.hop]).toEqual([false, "rules"]);
  });

  it("scrubs secrets that slipped into a summary (defence in depth) and caps it", () => {
    const s = agentEventToStep(ev({ shortSummary: `used key sk-${"a".repeat(30)} and Bearer abcdefghijkl ${"x".repeat(300)}` }), 0)!;
    expect(s.label).not.toMatch(/sk-a{10}/);
    expect(s.label).toMatch(/\[redacted\]/);
    expect(s.label.length).toBeLessThanOrEqual(161);
  });

  it("bus notes without a task get an agent trace; bad shapes are dropped", () => {
    expect(agentEventToStep(ev({ taskId: undefined, traceId: undefined, agentId: "librarian" }), 0)!.traceId).toBe("agent:librarian");
    expect(agentEventToStep({} as AgentEvent, 0)).toBeNull();
    expect(agentEventToStep(null as unknown as AgentEvent, 0)).toBeNull();
  });

  it("normalizeStep keeps only well-formed agent ids and known severities (data-driven ids)", () => {
    const base = { traceId: "x", seq: 0, hop: "router", label: "l", ok: true, ms: 0, at: 1 };
    expect(normalizeStep({ ...base, agent: "security_patrol", severity: "handoff" })).toMatchObject({ agent: "security_patrol", severity: "handoff" });
    const bad = normalizeStep({ ...base, agent: "Robert'); DROP", severity: "loud" })!;
    expect(bad.agent).toBeUndefined();
    expect(bad.severity).toBeUndefined();
  });

  it("a whole build reads as one trace; lanes list the agents in first-seen order", () => {
    const steps = [ev({ agentId: "prompter" }), ev({ agentId: "librarian", at: 1100 }), ev({ agentId: "coder", at: 1200 }), ev({ agentId: "prompter", at: 1300 })].map((e, i) => agentEventToStep(e, i)!);
    expect(groupTraces(steps)).toHaveLength(1);
    expect(agentLanes(steps)).toEqual(["prompter", "librarian", "coder"]);
  });
});
