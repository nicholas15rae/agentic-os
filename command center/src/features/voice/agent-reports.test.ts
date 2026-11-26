import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/platform";
import type { AuditRow } from "@/features/trading/ibkr";
import {
  addressToNic,
  directorReport,
  enqueueReport,
  inboxLine,
  isReportEvent,
  newTradingAlerts,
  parseInboxAsk,
  REPORT_TTL_MS,
  reportFromEvent,
  reportVoice,
  startReportPlayer,
  tonyBusy,
  tradingAlert,
  type AgentReport,
  type ReportPlayerDeps,
} from "./agent-reports";
import type { NarratorSnapshot } from "./narrator";

const ev = (o: Partial<AgentEvent>): AgentEvent => ({ v: 1, seq: 1, at: 1000, agentId: "coder", eventType: "review_ready", severity: "milestone", shortSummary: "Nic, the card's built. I added the hover states.", taskId: "t1", rowSeq: 7, ...o });
const quiet: NarratorSnapshot = { state: "idle", sayDepth: 0, activeStreams: 0, heardSpeech: false, holding: false, pending: false, passiveWake: false, lastUserSpeechAt: 0, lastTtsEndAt: 0 };
const speaking: NarratorSnapshot = { ...quiet, state: "speaking", sayDepth: 1 };
const rep = (o: Partial<AgentReport>): AgentReport => ({ id: "r1", agent: "director", text: "Nic, done.", at: 100_000, urgent: false, source: "note", ...o });
const row = (o: Partial<AuditRow>): AuditRow => ({ id: 1, ts: 1_000, kind: "order_failed", ref: "i1", verdict: "FAILED", actor: "desk", payload: {}, ...o });

describe("which events are reports", () => {
  it("task end rows and agent_report notes, never Tony's own", () => {
    expect(isReportEvent(ev({}))).toBe(true);
    expect(isReportEvent(ev({ eventType: "failed" }))).toBe(true);
    expect(isReportEvent(ev({ eventType: "handoff" }))).toBe(false);
    expect(isReportEvent(ev({ eventType: "review_ready", taskId: undefined }))).toBe(false);
    expect(isReportEvent(ev({ eventType: "agent_report", taskId: undefined, agentId: "director" }))).toBe(true);
    expect(isReportEvent(ev({ agentId: "tony" }))).toBe(false);
    expect(isReportEvent(ev({ agentId: "general" }))).toBe(false);
  });

  it("keeps the agent's own words, addressed to Nic, wake words stripped", () => {
    const r = reportFromEvent(ev({ shortSummary: "Tony, the card's built. I added the hover states." }), ["tony"])!;
    expect(r.text).toBe("Nic, the card's built. I added the hover states.");
    expect(r.agent).toBe("coder");
    expect(r.id).toBe("task:t1:7");
    expect(r.urgent).toBe(false);
  });

  it("pipeline-internal speakers are the Prompter's", () => {
    expect(reportFromEvent(ev({ agentId: "system", eventType: "failed" }), [])!.agent).toBe("prompter");
  });
});

describe("addressToNic", () => {
  it("prefixes once, keeps I and acronyms", () => {
    expect(addressToNic("Built, but 1 thing still doesn't work.")).toBe("Nic, built, but 1 thing still doesn't work.");
    expect(addressToNic("Nic, done.")).toBe("Nic, done.");
    expect(addressToNic("I finished the edit.")).toBe("Nic, I finished the edit.");
    expect(addressToNic("UI is staged.")).toBe("Nic, UI is staged.");
  });
  it("caps at a sentence end", () => {
    const long = `Nic, ${"word ".repeat(40)}end. ${"more ".repeat(60)}`;
    const out = addressToNic(long, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("end.")).toBe(true);
  });
});

describe("Director render reports", () => {
  it("done and failed, nothing for progress", () => {
    expect(directorReport({ slug: "self-tape", jobId: "j1", status: "done", render: { durationSec: 95, width: 1920, height: 1080 } }, 5)!.text).toBe(
      "Nic, the self tape render is done, 1 minute 35 seconds at 1920 by 1080. I checked the streams and it's on the verified shelf.",
    );
    const f = directorReport({ slug: "reel", jobId: "j2", status: "failed", error: "render failed verification: no audio stream; size" }, 5)!;
    expect(f.text).toBe("Nic, the reel render didn't make it: render failed verification. The raw footage is untouched.");
    expect(f.agent).toBe("director");
    expect(directorReport({ slug: "reel", jobId: "j3", status: "running" }, 5)).toBeNull();
  });
});

describe("trading alerts", () => {
  it("kill switch, loss limit, blocked and failed are urgent; dry runs and noise are not", () => {
    expect(tradingAlert(row({ kind: "kill", payload: { reason: "manual" } }))!.text).toBe("Nic, the kill switch just fired: manual. Orders are cancelled and positions are flattening.");
    expect(tradingAlert(row({ kind: "kill", payload: { reason: "Engine R daily loss limit: P&L -210.00 <= -200.00" } }))!.id).toMatch(/^trading:loss:/);
    expect(tradingAlert(row({ kind: "kill", payload: { dryRun: true } }))).toBeNull();
    expect(tradingAlert(row({ kind: "rule_limit_block", payload: { symbol: "AAPL", why: "max open positions reached (3/3)" } }))!.text).toBe("Nic, I blocked a trade in AAPL: max open positions reached (3/3).");
    expect(tradingAlert(row({ kind: "pretrade_rejected", payload: { failed: ["stale_quote", "spread"] } }))!.text).toBe("Nic, a trade was blocked before it went out: stale_quote and spread.");
    const failed = tradingAlert(row({ kind: "order_failed", payload: { error: "TWS not connected" } }))!;
    expect(failed.urgent && failed.agent === "trading").toBe(true);
    expect(tradingAlert(row({ kind: "order_submitted" }))).toBeNull();
    expect(tradingAlert(row({ kind: "heartbeat_lost" }))).toBeNull();
  });

  it("first poll alerts only recent rows; later polls only new ids; one per scan", () => {
    const now = 2_000_000_000_000;
    const tail = [row({ id: 1, ts: (now - 3_600_000) / 1000 }), row({ id: 2, ts: (now - 60_000) / 1000 })];
    const first = newTradingAlerts(tail, null, now);
    expect(first.alerts.map((a) => a.id)).toEqual(["trading:failed:2"]);
    expect(first.mark).toBe(2);
    const scan = [row({ id: 3, kind: "rule_limit_block", ref: "s1", payload: { symbol: "A" } }), row({ id: 4, kind: "rule_limit_block", ref: "s1", payload: { symbol: "B" } })];
    const next = newTradingAlerts([...tail, ...scan], first.mark, now);
    expect(next.alerts).toHaveLength(1);
    expect(next.mark).toBe(4);
    expect(newTradingAlerts([...tail, ...scan], 4, now).alerts).toHaveLength(0);
  });
});

describe("whose voice reads a report", () => {
  const prefs = (allTony: boolean, own?: boolean) => ({ agentVoicesAllTony: allTony, agentVoices: { director: { engine: "elevenlabs" as const, voice: "v1", autoSpeak: false, ownVoice: own } } });
  it("own voice by default; Tony when the row's switch is off; Tony for everyone under All Tony", () => {
    expect(reportVoice("director", prefs(false))).toBe("director");
    expect(reportVoice("coder", prefs(false))).toBe("coder");
    expect(reportVoice("director", prefs(false, false))).toBe("general");
    expect(reportVoice("director", prefs(true, true))).toBe("general");
    expect(reportVoice("coder", prefs(true))).toBe("general");
  });
  it("All Tony off again: each row's own setting is back", () => {
    expect(reportVoice("director", prefs(false, false))).toBe("general");
    expect(reportVoice("director", prefs(false, true))).toBe("director");
  });
});

describe("queue", () => {
  it("urgent first, then oldest; no duplicates; stale normal reports go to the inbox only", () => {
    let q = enqueueReport([], rep({ id: "a", at: 100_000 }), 100_000).queue;
    q = enqueueReport(q, rep({ id: "b", at: 90_000 }), 100_000).queue;
    q = enqueueReport(q, rep({ id: "u", agent: "trading", urgent: true, at: 100_500 }), 100_500).queue;
    q = enqueueReport(q, rep({ id: "a", at: 100_000 }), 100_500).queue;
    expect(q.map((r) => r.id)).toEqual(["u", "b", "a"]);
    const later = enqueueReport(q, rep({ id: "c", at: 100_000 + REPORT_TTL_MS }), 100_000 + REPORT_TTL_MS + 1);
    expect(later.queue.map((r) => r.id)).toEqual(["u", "c"]);
    expect(later.dropped.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
  it("caps without ever dropping an urgent alert", () => {
    let q: AgentReport[] = [];
    for (let i = 0; i < 4; i++) q = enqueueReport(q, rep({ id: `u${i}`, urgent: true, at: i }), 10, 3).queue;
    expect(q).toHaveLength(4);
  });
});

describe("Tony's inbox line", () => {
  it("counts unread per agent", () => {
    expect(inboxLine([{ agent: "director", read: false }, { agent: "director", read: false }])).toBe("You've got 2 messages from the Director.");
    expect(inboxLine([{ agent: "director", read: false }, { agent: "coder", read: false }, { agent: "director", read: false }, { agent: "trading", read: true }])).toBe("You've got 2 messages from the Director and 1 from the Coder.");
    expect(inboxLine([{ agent: "coder", read: false }])).toBe("You've got a message from the Coder.");
    expect(inboxLine([{ agent: "coder", read: true }])).toBe("No new messages, Nic.");
  });
  it("parses the asks, leaves texts and emails alone", () => {
    expect(parseInboxAsk("Any messages?")).toEqual({ play: false });
    expect(parseInboxAsk("hey tony, do I have any new messages")).toEqual({ play: false });
    expect(parseInboxAsk("What are my messages")).toEqual({ play: false });
    expect(parseInboxAsk("play my messages")).toEqual({ play: true });
    expect(parseInboxAsk("read me the messages please")).toEqual({ play: true });
    expect(parseInboxAsk("any text messages")).toBeNull();
    expect(parseInboxAsk("send a message to Sam")).toBeNull();
    expect(parseInboxAsk("check my email messages")).toBeNull();
    expect(parseInboxAsk("the messages in this design feel off")).toBeNull();
  });
});

describe("player", () => {
  const setup = (snap: () => NarratorSnapshot, over: Partial<ReportPlayerDeps> = {}) => {
    const calls: string[] = [];
    const logs: { id: string; outcome: string; interrupted: boolean }[] = [];
    const added: string[] = [];
    const heard: string[] = [];
    let t = 100_000;
    const deps: ReportPlayerDeps = {
      speak: vi.fn(async (r, voice) => (calls.push(`speak:${r.id}:${voice}`), true)),
      interrupt: vi.fn(async (r, voice) => (calls.push(`interrupt:${r.id}:${voice}`), true)),
      snapshot: snap,
      level: () => 1,
      prefs: () => ({ agentVoices: {}, agentVoicesAllTony: false }),
      inbox: { add: (r) => added.push(r.id), heard: (id) => heard.push(id) },
      log: (r, m) => logs.push({ id: r.id, outcome: m.outcome, interrupted: m.interrupted }),
      now: () => t,
      pollMs: 1_000_000, // drained by hand
      ...over,
    };
    const p = startReportPlayer(deps);
    return { p, calls, logs, added, heard, advance: (ms: number) => (t += ms) };
  };

  it("waits while Tony talks, then plays in the agent's voice and marks it heard", async () => {
    let snap = speaking;
    const s = setup(() => snap);
    s.p.push(rep({ id: "d1", at: 100_000 }));
    await Promise.resolve();
    expect(s.added).toEqual(["d1"]);
    expect(s.calls).toEqual([]);
    expect(s.logs).toEqual([{ id: "d1", outcome: "queued", interrupted: false }]);
    snap = quiet;
    s.advance(5_000);
    await s.p.drain();
    expect(s.calls).toEqual(["speak:d1:director"]);
    expect(s.heard).toEqual(["d1"]);
    expect(s.logs.at(-1)).toEqual({ id: "d1", outcome: "spoke", interrupted: false });
    s.p.stop();
  });

  it("only an urgent Trading alert interrupts Tony", async () => {
    const s = setup(() => speaking);
    s.p.push(rep({ id: "dir", agent: "director", urgent: true })); // urgent flag on another agent: still waits
    s.p.push(rep({ id: "kill", agent: "trading", urgent: true, at: 100_001 }));
    await s.p.drain();
    await s.p.drain();
    expect(s.calls).toEqual(["interrupt:kill:trading"]);
    expect(s.logs.find((l) => l.id === "kill")).toEqual({ id: "kill", outcome: "spoke", interrupted: true });
    s.p.stop();
  });

  it("feedback level 0: inbox only, nothing played", async () => {
    const s = setup(() => quiet, { level: () => 0 });
    s.p.push(rep({ id: "x" }));
    await s.p.drain();
    expect(s.added).toEqual(["x"]);
    expect(s.calls).toEqual([]);
    expect(s.logs).toEqual([{ id: "x", outcome: "inbox_only", interrupted: false }]);
  });

  it("a report that can't be heard (mic locked) stays unread", async () => {
    const s = setup(() => quiet, { speak: async () => false });
    s.p.push(rep({ id: "m" }));
    await s.p.drain();
    expect(s.heard).toEqual([]);
    expect(s.logs.at(-1)?.outcome).toBe("inbox_only");
  });

  it("tonyBusy: a passive wake listen that heard nothing is not a conversation", () => {
    expect(tonyBusy(quiet)).toBe(false);
    expect(tonyBusy({ ...quiet, state: "listening", passiveWake: true })).toBe(false);
    expect(tonyBusy({ ...quiet, state: "listening", passiveWake: false })).toBe(true);
    expect(tonyBusy({ ...quiet, state: "thinking", activeStreams: 1 })).toBe(true);
  });
});
