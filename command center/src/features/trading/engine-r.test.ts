import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; init?: RequestInit }[] = [];
vi.mock("@/lib/gateway", () => {
  class GatewayError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
    }
  }
  return {
    GatewayError,
    gateway: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return {};
    }),
  };
});

import { GatewayError } from "@/lib/gateway";
import { engineRApi, type AuditRow } from "./ibkr";
import { canApprove, isChangeEvaluation, isEvaluationReport, needsEnableConfirm, type SetMetrics } from "./EngineRPanel.contract";
import { METRIC_ROWS, compareTone, diffLines, diffText, errorText, logLine, metricText, paramValue, viewErrorText } from "./engine-r-format";

const metrics = (over: Partial<SetMetrics> = {}): SetMetrics => ({
  trades: 40, wins: 18, losses: 22, winRate: 0.45, avgWinR: 1.8, avgLossR: -0.95, avgWinPct: 2.1, avgLossPct: -1.1,
  expectancyR: 0.29, totalR: 11.6, maxDrawdownR: 4.2, maxDrawdownPct: 1.05, from: "2023-01-03", to: "2025-06-30", note: null, ...over,
});
const row = (kind: string, payload: Record<string, unknown>): AuditRow => ({ id: 1, ts: 1_764_000_000, kind, ref: "r", verdict: "OK", actor: "rule_engine", payload });

describe("Engine R contract rules", () => {
  it("approve needs the exact typed phrase", () => {
    expect(canApprove("APPROVE")).toBe(true);
    for (const p of ["", "approve", "APPROVE ", " APPROVE", "APPROVED"]) expect(canApprove(p)).toBe(false);
  });
  it("turning ON asks only in FULL_AUTO or an unknown mode; OFF never asks", () => {
    expect(needsEnableConfirm(true, "FULL_AUTO")).toBe(true);
    expect(needsEnableConfirm(true, null)).toBe(true);
    expect(needsEnableConfirm(true, "ADVISORY")).toBe(false);
    expect(needsEnableConfirm(true, "SEMI_AUTO")).toBe(false);
    expect(needsEnableConfirm(false, "FULL_AUTO")).toBe(false);
    expect(needsEnableConfirm(false, null)).toBe(false);
  });
  it("tells a scored change from a backtest error, and a report from 'no evaluation yet'", () => {
    expect(isChangeEvaluation(null)).toBe(false);
    expect(isChangeEvaluation({ error: "no cached daily bars yet" })).toBe(false);
    const rep = { cutoff: "2025-01-02", range: { from: null, to: null }, symbols: [], openAtEnd: 0, build: metrics(), test: metrics() };
    expect(isChangeEvaluation({ cutoff: null, range: { from: null, to: null }, current: rep, proposed: rep, verdict: { label: "mixed", notes: [] } })).toBe(true);
    expect(isEvaluationReport(null)).toBe(false);
    expect(isEvaluationReport({ at: null, note: "no evaluation yet" })).toBe(false);
  });
});

describe("engineRApi requests", () => {
  beforeEach(() => void (calls.length = 0));
  const body = (i: number) => JSON.parse(String(calls[i].init?.body));

  it("approve posts the typed phrase and note to the PIN-gated engines route", async () => {
    await engineRApi.approve("rc-20261125-ab12cd34", "APPROVE", "looks fine");
    expect(calls[0].path).toBe("/api/trading/engines/r/changes/rc-20261125-ab12cd34/approve");
    expect(calls[0].init?.method).toBe("POST");
    expect(body(0)).toEqual({ confirm: "APPROVE", note: "looks fine" });
  });
  it("reject posts only the note; ids are URL-encoded", async () => {
    await engineRApi.reject("a/b", "no");
    expect(calls[0].path).toBe("/api/trading/engines/r/changes/a%2Fb/reject");
    expect(body(0)).toEqual({ note: "no" });
  });
  it("the only scan the UI can start is a dry run", async () => {
    await engineRApi.dryScan();
    expect(calls[0].path).toBe("/api/trading/engines/r/scan");
    expect(body(0)).toEqual({ submit: false });
  });
  it("enable / evaluate / reads hit their routes", async () => {
    await engineRApi.enable(false);
    await engineRApi.evaluate();
    await engineRApi.view();
    await engineRApi.evaluation();
    await engineRApi.log(9999);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/trading/engines/r/enable",
      "/api/trading/engines/r/evaluate",
      "/api/trading/rules",
      "/api/trading/rules/evaluation",
      "/api/trading/rules/log?limit=500",
    ]);
    expect(body(0)).toEqual({ enabled: false });
    expect(body(1)).toEqual({ refresh: true });
    expect(calls.slice(2).every((c) => (c.init?.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("Engine R formatting", () => {
  it("lists a diff in schema order with readable values", () => {
    const diff = { min_rel_volume: { from: 1.2, to: 1.5 }, disabled_symbols: { from: [], to: ["UNG"] }, sma_fast: { from: 20, to: 15 } };
    expect(diffLines(diff).map((d) => d.param)).toEqual(["sma_fast", "min_rel_volume", "disabled_symbols"]);
    expect(diffText(diff)).toBe("sma_fast 20 → 15, min_rel_volume 1.2 → 1.5, disabled_symbols none → UNG");
    expect(paramValue(["SLV", "UNG"])).toBe("SLV UNG");
    expect(diffLines(null)).toEqual([]);
  });
  it("formats metrics as count, %, signed R and drawdown R", () => {
    const m = metrics();
    expect(metricText("trades", m)).toBe("40");
    expect(metricText("winRate", m)).toBe("45%");
    expect(metricText("avgWinR", m)).toBe("+1.80R");
    expect(metricText("avgLossR", m)).toBe("−0.95R");
    expect(metricText("maxDrawdownR", m)).toBe("4.20R");
    expect(metricText("winRate", metrics({ winRate: null }))).toBe("—");
    expect(metricText("trades", null)).toBe("—");
  });
  it("tones proposed vs current by each metric's direction; trade counts have none", () => {
    const by = (k: string) => METRIC_ROWS.find((r) => r.key === k)!;
    const cur = metrics();
    expect(compareTone(by("winRate"), cur, metrics({ winRate: 0.5 }))).toBe("better");
    expect(compareTone(by("avgLossR"), cur, metrics({ avgLossR: -0.8 }))).toBe("better");
    expect(compareTone(by("maxDrawdownR"), cur, metrics({ maxDrawdownR: 6 }))).toBe("worse");
    expect(compareTone(by("expectancyR"), cur, metrics())).toBe("same");
    expect(compareTone(by("trades"), cur, metrics({ trades: 10 }))).toBeNull();
    expect(compareTone(by("winRate"), cur, metrics({ winRate: null }))).toBeNull();
  });
  it("names the cause of a refused decision; keeps the step-up message", () => {
    expect(errorText(new GatewayError("409 Conflict", 409), "approve")).toMatch(/stale/);
    expect(errorText(new GatewayError("403 Forbidden", 403), "approve")).toMatch(/type APPROVE exactly/);
    expect(errorText(new GatewayError("503 Service Unavailable", 503), "scan")).toMatch(/bridge/);
    expect(errorText(new GatewayError("trading is read-only on this device", 423), "approve")).toBe("trading is read-only on this device");
    expect(errorText(new Error("boom"), "evaluate")).toBe("boom");
  });
  it("tells an old gateway (404) from a bridge without Engine R (503)", () => {
    expect(viewErrorText("404 Not Found")).toMatch(/restart the gateway/);
    expect(viewErrorText("503 Service Unavailable")).toMatch(/trading bridge/);
    expect(viewErrorText("Gateway unreachable")).toBe("Engine R unreachable (Gateway unreachable).");
  });
  it("summarizes log rows and flags analyst text as untrusted", () => {
    expect(logLine(row("rule_change_proposed", { diff: { min_rel_volume: { from: 1.2, to: 1.5 } }, source: "analyst", rationale: { text: "x", untrusted: true } })))
      .toEqual({ text: "min_rel_volume 1.2 → 1.5 · by analyst", title: "x", untrusted: true });
    expect(logLine(row("rule_scan", { kind: "manual", status: "dry_run", detail: "", submit: false, taken: ["SPY"] })).text).toBe("manual scan (dry run): dry_run · took SPY");
    expect(logLine(row("rule_change_approved", { diff: { sma_fast: { from: 20, to: 15 } }, fromVersion: 1, toVersion: 2, note: "" })).text).toBe("v1 → v2: sma_fast 20 → 15");
    expect(logLine(row("rule_engine_enabled", { enabled: false })).text).toBe("switched OFF");
    expect(logLine(row("kill_switch", { reason: "red button" })).text).toBe("red button");
    expect(logLine(row("rule_trade", { symbol: "SPY", quantity: 10, limit: 600.1, stop: 590, target: 615, desk: "not an object" })).text).toContain("desk ?");
  });
});
