import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/platform";

vi.mock("@/lib/platform", () => ({ isTauri: () => false, onNativeEvent: async () => () => undefined }));

import { alreadyAnnounced, canSpeak, clampLevel, enqueue, eventToItem, feedbackLevel, narrates, nextItem, prune, QUEUE_CAP, QUIET_GAP_MS, startNarrator, stripWakeWords, type NarrationItem, type NarratorSnapshot } from "./narrator";

const NOW = 1_000_000;
const quiet: NarratorSnapshot = { state: "idle", sayDepth: 0, activeStreams: 0, heardSpeech: false, holding: false, pending: false, passiveWake: false, lastUserSpeechAt: 0, lastTtsEndAt: 0 };

function ev(over: Partial<AgentEvent> = {}): AgentEvent {
  return { v: 1, seq: 1, at: NOW, taskId: "t-1-aaaaaa", traceId: "task:t-1-aaaaaa", agentId: "coder", eventType: "stage_started", severity: "milestone", shortSummary: "Coder is building the prototype", ...over };
}
function item(over: Partial<NarrationItem> = {}): NarrationItem {
  return { key: "task:a:update", taskId: "a", text: "x", agent: "general", severity: "milestone", at: NOW, count: 1, ...over };
}
const ctx = (level: number, live: string[] = []) => ({ level, liveTraceIds: new Set(live), wakeWords: ["hey tony", "tony", "Tony"] });

describe("narrates (mirrors Rust events::narrates)", () => {
  it("is the 4×4 truth table: level 0 silent even for critical", () => {
    const table: Record<string, boolean[]> = {
      critical: [false, true, true, true],
      milestone: [false, true, true, true],
      handoff: [false, false, true, true],
      verbose: [false, false, false, true],
    };
    for (const [sev, row] of Object.entries(table)) row.forEach((want, level) => expect(narrates(sev, level), `${sev}@${level}`).toBe(want));
    expect(narrates("bogus", 3)).toBe(false);
  });

  it("feedback level: default 1, clamped 0–3 (a future mode setting can drive it)", () => {
    expect(feedbackLevel(null)).toBe(1);
    expect(feedbackLevel({ feedback: { sensitivity: 2, narrationEngine: "roster" } })).toBe(2);
    expect(clampLevel(7)).toBe(3);
    expect(clampLevel(-4)).toBe(0);
    expect(clampLevel("loud")).toBe(1);
  });
});

describe("canSpeak — never over Nic or Tony", () => {
  const blocked: [string, Partial<NarratorSnapshot>][] = [
    ["Tony is talking (sayDepth > 0)", { sayDepth: 1 }],
    ["a turn is generating", { activeStreams: 1 }],
    ["Nic is talking in a listen", { state: "listening", heardSpeech: true }],
    ["an explicit listen is open", { state: "listening" }],
    ["transcribing", { state: "transcribing" }],
    ["thinking", { state: "thinking" }],
    ["speaking", { state: "speaking" }],
    ["confirming", { state: "confirming" }],
    ["holding", { state: "holding", holding: true }],
    ["a pending card", { pending: true }],
    ["Nic spoke under 1.5 s ago", { lastUserSpeechAt: NOW - QUIET_GAP_MS + 100 }],
    ["a line ended under 1.5 s ago", { lastTtsEndAt: NOW - 200 }],
    ["a passive listen that heard speech", { state: "listening", passiveWake: true, heardSpeech: true }],
  ];
  for (const [why, over] of blocked) it(`blocks: ${why}`, () => expect(canSpeak({ ...quiet, ...over }, NOW)).toBe(false));

  it("allows idle, and a passive wake listen that has heard nothing", () => {
    expect(canSpeak(quiet, NOW)).toBe(true);
    expect(canSpeak({ ...quiet, state: "error" }, NOW)).toBe(true);
    expect(canSpeak({ ...quiet, state: "listening", passiveWake: true }, NOW)).toBe(true);
    expect(canSpeak({ ...quiet, lastUserSpeechAt: NOW - QUIET_GAP_MS, lastTtsEndAt: NOW - QUIET_GAP_MS }, NOW)).toBe(true);
  });
});

describe("enqueue — coalesce, TTL, cap; criticals never dropped", () => {
  it("coalesces per task: the latest update wins", () => {
    let q = enqueue([], item({ text: "Prompter is writing the spec" }), NOW);
    q = enqueue(q, item({ text: "Designer is drafting the blueprint", at: NOW + 10 }), NOW + 10);
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe("Designer is drafting the blueprint");
    expect(q[0].count).toBe(2);
  });

  it("a critical never replaces (or is replaced by) the task's update line, and criticals collapse", () => {
    let q = enqueue([], item(), NOW);
    q = enqueue(q, item({ key: "task:a:critical", severity: "critical", text: "failed once" }), NOW);
    q = enqueue(q, item({ key: "task:a:critical", severity: "critical", text: "failed twice", at: NOW + 1 }), NOW + 1);
    expect(q.map((i) => i.severity).sort()).toEqual(["critical", "milestone"]);
    const crit = q.find((i) => i.severity === "critical")!;
    expect([crit.text, crit.count]).toEqual(["failed twice", 2]);
  });

  it("expires by TTL: handoff/verbose 30 s, milestone 120 s, critical never", () => {
    const q = [item({ key: "h", severity: "handoff", at: NOW }), item({ key: "v", severity: "verbose", at: NOW }), item({ key: "m", severity: "milestone", at: NOW }), item({ key: "c", severity: "critical", at: NOW })];
    expect(prune(q, NOW + 31_000).map((i) => i.key)).toEqual(["m", "c"]);
    expect(prune(q, NOW + 121_000).map((i) => i.key)).toEqual(["c"]);
    expect(prune(q, NOW + 86_400_000).map((i) => i.key)).toEqual(["c"]);
    // A stale event is never queued.
    expect(enqueue([], item({ severity: "handoff", at: NOW - 40_000 }), NOW)).toEqual([]);
  });

  it(`caps at ${QUEUE_CAP}, dropping the oldest lowest-severity line, never a critical`, () => {
    let q: NarrationItem[] = [];
    for (let i = 0; i < 3; i++) q = enqueue(q, item({ key: `c${i}`, severity: "critical", at: NOW + i }), NOW + i);
    q = enqueue(q, item({ key: "v0", severity: "verbose", at: NOW }), NOW);
    q = enqueue(q, item({ key: "m0", severity: "milestone", at: NOW }), NOW);
    q = enqueue(q, item({ key: "h0", severity: "handoff", at: NOW }), NOW);
    expect(q).toHaveLength(QUEUE_CAP);
    expect(q.map((i) => i.key)).not.toContain("v0");
    for (let i = 3; i < 8; i++) q = enqueue(q, item({ key: `c${i}`, severity: "critical", at: NOW + i }), NOW + i);
    expect(q.filter((i) => i.severity === "critical")).toHaveLength(8); // over the cap, all kept
    expect(q.some((i) => i.severity !== "critical")).toBe(false);
  });

  it("speaks criticals first, then oldest", () => {
    const q = [item({ key: "m", at: NOW }), item({ key: "c", severity: "critical", at: NOW + 5 }), item({ key: "m2", at: NOW - 5 })];
    expect(nextItem(q)?.key).toBe("c");
    expect(nextItem(q.filter((i) => i.key !== "c"))?.key).toBe("m2");
    expect(nextItem([])).toBeNull();
  });
});

describe("eventToItem — gate, live-turn suppression, voice", () => {
  it("drops what the level doesn't narrate", () => {
    expect(eventToItem(ev({ severity: "handoff" }), ctx(1))).toBeNull();
    expect(eventToItem(ev({ severity: "milestone" }), ctx(0))).toBeNull();
    expect(eventToItem(ev({ severity: "critical", eventType: "failed" }), ctx(0))).toBeNull();
    expect(eventToItem(ev({ severity: "handoff" }), ctx(2))).not.toBeNull();
  });

  it("suppresses the live turn's own events (the announcer handoff already speaks them)", () => {
    expect(eventToItem(ev({ traceId: "turn-123", taskId: undefined }), ctx(3, ["turn-123"]))).toBeNull();
    expect(eventToItem(ev({ traceId: "turn-999", taskId: undefined }), ctx(3, ["turn-123"]))).not.toBeNull();
  });

  it("level 1: Tony relays every milestone in his voice, attributing an agent's own words (Part 7)", () => {
    expect(eventToItem(ev(), ctx(1))?.agent).toBe("general");
    const own = eventToItem(ev({ fromVoiceSummary: true, shortSummary: "Built the card, two files." }), ctx(1));
    expect(own).toMatchObject({ agent: "general", text: "The Coder says: Built the card, two files." });
    // Level 2+: the specialist speaks its own words in its own voice, unattributed.
    expect(eventToItem(ev({ fromVoiceSummary: true, severity: "milestone", shortSummary: "Built the card, two files." }), ctx(2))).toMatchObject({ agent: "coder", text: "Built the card, two files." });
  });

  it("level 2+: every line in the speaking agent's roster voice (tony → general)", () => {
    expect(eventToItem(ev({ severity: "handoff", agentId: "designer" }), ctx(2))?.agent).toBe("designer");
    expect(eventToItem(ev({ severity: "handoff", agentId: "tony" }), ctx(2))?.agent).toBe("general");
    expect(eventToItem(ev({ severity: "verbose", agentId: "verifier" }), ctx(3))?.agent).toBe("verifier");
  });

  it("strips wake words / the OS name (narration through speakers can't wake Tony); empty → dropped", () => {
    expect(eventToItem(ev({ shortSummary: "Hey Tony, the card is ready" }), ctx(1))?.text).toBe("the card is ready");
    expect(eventToItem(ev({ shortSummary: "Tony" }), ctx(1))).toBeNull();
    expect(stripWakeWords("Tony's build: done", ["tony"])).toBe("build: done");
  });

  it("keys: one update line + one critical line per task; bus notes per agent + type", () => {
    expect(eventToItem(ev(), ctx(1))?.key).toBe("task:t-1-aaaaaa:update");
    expect(eventToItem(ev({ severity: "critical", eventType: "failed" }), ctx(1))?.key).toBe("task:t-1-aaaaaa:critical");
    expect(eventToItem(ev({ taskId: undefined, traceId: undefined, agentId: "librarian", eventType: "discrepancy", severity: "critical" }), ctx(1))?.key).toBe("agent:librarian:discrepancy");
  });

  it("rejects bad shapes", () => {
    expect(eventToItem({} as AgentEvent, ctx(3))).toBeNull();
    expect(eventToItem(ev({ severity: "loud" as never }), ctx(3))).toBeNull();
  });
});

describe("startNarrator runtime", () => {
  function rig(level = 1, engine: "roster" | "kokoro" = "roster") {
    let snap: NarratorSnapshot = { ...quiet };
    let t = NOW;
    const spoken: { text: string; agent: string; localOnly: boolean }[] = [];
    const ends: Array<() => void> = [];
    const cfg = { feedback: { sensitivity: level as 0 | 1 | 2 | 3, narrationEngine: engine } };
    const n = startNarrator({
      narrate: (text, agent, o) => {
        spoken.push({ text, agent, localOnly: o.localOnly });
        return new Promise<void>((r) => ends.push(r));
      },
      snapshot: () => snap,
      cfg: () => cfg,
      liveTraceIds: () => new Set(),
      wakeWords: () => ["tony"],
      now: () => t,
      pollMs: 5,
      subscribe: async () => () => undefined,
    });
    return { n, spoken, ends, cfg, set: (s: Partial<NarratorSnapshot>) => (snap = { ...snap, ...s }), tick: (ms: number) => (t += ms) };
  }

  it("waits while Tony talks, then speaks once it's quiet", async () => {
    const r = rig();
    r.set({ sayDepth: 1, state: "speaking" });
    r.n.push(ev());
    await new Promise((x) => setTimeout(x, 20));
    expect(r.spoken).toHaveLength(0);
    expect(r.n.queue()).toHaveLength(1);
    r.set({ sayDepth: 0, state: "idle", lastTtsEndAt: NOW });
    r.tick(QUIET_GAP_MS);
    await vi.waitFor(() => expect(r.spoken).toHaveLength(1));
    expect(r.spoken[0]).toEqual({ text: "Coder is building the prototype", agent: "general", localOnly: false });
    r.n.stop();
  });

  it("one line at a time; the next waits for the first to end", async () => {
    const r = rig(2);
    r.n.push(ev({ taskId: "a", severity: "handoff", agentId: "prompter", shortSummary: "Spec done" }));
    r.n.push(ev({ taskId: "b", severity: "handoff", agentId: "designer", shortSummary: "Blueprint done" }));
    await vi.waitFor(() => expect(r.spoken).toHaveLength(1));
    expect(r.n.speaking()).toBe(true);
    r.ends[0]();
    await vi.waitFor(() => expect(r.spoken).toHaveLength(2));
    expect(r.spoken.map((s) => s.agent)).toEqual(["prompter", "designer"]);
    r.n.stop();
  });

  it("narrationEngine kokoro → localOnly (same per-agent voice, local engine)", async () => {
    const r = rig(2, "kokoro");
    r.n.push(ev({ fromVoiceSummary: true, shortSummary: "Spec is in." , agentId: "prompter"}));
    await vi.waitFor(() => expect(r.spoken).toHaveLength(1));
    expect(r.spoken[0]).toMatchObject({ agent: "prompter", localOnly: true });
    r.n.stop();
  });

  it("turning the level down drops queued lines it no longer narrates", async () => {
    const r = rig(1);
    r.set({ pending: true });
    r.n.push(ev());
    expect(r.n.queue()).toHaveLength(1);
    r.cfg.feedback.sensitivity = 0;
    r.set({ pending: false });
    await r.n.drain();
    expect(r.n.queue()).toHaveLength(0);
    expect(r.spoken).toHaveLength(0);
    r.n.stop();
  });
});

describe("regressions: double 'Queued' and coalescing that ate 'ready for review'", () => {
  it("a task Tony already announced: its task_queued row is not narrated again (task events never carry a live trace id)", () => {
    const queued = ev({ eventType: "task_queued", agentId: "tony", severity: "milestone", shortSummary: "Queued: Tip Calculator" });
    expect(eventToItem(queued, ctx(1))).not.toBeNull(); // not announced: phone / ledger tasks still narrate
    expect(eventToItem(queued, { ...ctx(1), announcedTasks: new Set(["t-1-aaaaaa"]) })).toBeNull();
    // Only the queued row: later events for that task still narrate.
    expect(eventToItem(ev({ eventType: "handoff", severity: "milestone" }), { ...ctx(1), announcedTasks: new Set(["t-1-aaaaaa"]) })).not.toBeNull();
    expect(alreadyAnnounced("task_queued", undefined, new Set(["x"]))).toBe(false);
  });

  it("the event can beat task_create's reply: the line is dropped at speak time once the task is marked", async () => {
    const announced = new Set<string>();
    let snap: NarratorSnapshot = { ...quiet, sayDepth: 1, state: "speaking" };
    const spoken: string[] = [];
    const n = startNarrator({
      narrate: async (text) => void spoken.push(text),
      snapshot: () => snap,
      cfg: () => ({ feedback: { sensitivity: 1, narrationEngine: "roster" } }),
      liveTraceIds: () => new Set(),
      announcedTasks: () => announced,
      wakeWords: () => ["tony"],
      now: () => NOW + 10_000,
      pollMs: 5,
      subscribe: async () => () => undefined,
    });
    n.push(ev({ eventType: "task_queued", agentId: "tony", shortSummary: "Queued: Tip Calculator" }));
    expect(n.queue()).toHaveLength(1); // arrived before delegateBuild marked it
    announced.add("t-1-aaaaaa"); // Tony says "Queued. The Prompter's on it…"
    snap = { ...quiet };
    await n.drain();
    await new Promise((x) => setTimeout(x, 20));
    expect(spoken).toEqual([]);
    expect(n.queue()).toHaveLength(0);
    n.stop();
  });

  it("'ready for review' keeps its own slot: later read-report lines never replace it", () => {
    const ready = eventToItem(ev({ eventType: "review_ready", agentId: "prompter", shortSummary: "\"Tip Calculator\" is ready for review in staging/tip-calculator" }), ctx(1))!;
    const report = eventToItem(ev({ eventType: "discrepancy", agentId: "librarian", shortSummary: "Read-report: index.html is smaller than expected", at: NOW + 5 }), ctx(1))!;
    let q = enqueue([], ready, NOW);
    q = enqueue(q, report, NOW + 5);
    q = enqueue(q, { ...report, text: "Read-report: second", at: NOW + 6 }, NOW + 6);
    expect(q.map((i) => i.text)).toEqual(["\"Tip Calculator\" is ready for review in staging/tip-calculator", "Read-report: second"]);
    expect(nextItem(q)?.text).toMatch(/ready for review/);
  });

  it("a waiting milestone is never replaced by a later, less severe line of the same task", () => {
    let q = enqueue([], item({ text: "One more pass", severity: "milestone" }), NOW);
    q = enqueue(q, item({ text: "Prompter is writing the build brief", severity: "handoff", at: NOW + 1 }), NOW + 1);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ text: "One more pass", severity: "milestone", count: 2 });
    // An equal or more severe line still wins (latest).
    q = enqueue(q, item({ text: "Newer milestone", severity: "milestone", at: NOW + 2 }), NOW + 2);
    expect(q[0].text).toBe("Newer milestone");
  });
});

describe("Agent Chatter off (section pass)", () => {
  it("mutes agent back-and-forth, keeps milestones and critical lines", async () => {
    const { chatterMuted } = await import("./narrator");
    expect(chatterMuted("handoff", false)).toBe(true);
    expect(chatterMuted("verbose", false)).toBe(true);
    expect(chatterMuted("milestone", false)).toBe(false);
    expect(chatterMuted("critical", false)).toBe(false);
    expect(chatterMuted("handoff", true)).toBe(false);
  });
});
