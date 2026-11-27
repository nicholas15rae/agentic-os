import { describe, expect, it } from "vitest";
import { failureText, marketTone, type Decision, type HealthResult, type IbkrStatus, type MarketStatus } from "./ibkr";
import { liveBridgeRow, overallOf, reconcileHealth } from "./health-live";

const NOW = 2_000;

const status = (over: Partial<IbkrStatus> = {}): IbkrStatus => ({
  state: "CONNECTED",
  mode: "PAPER",
  host: "127.0.0.1",
  port: 7497,
  clientId: 11,
  readOnly: true,
  reasons: [],
  lastError: null,
  connectedSince: 1_000,
  updatedAt: NOW - 1,
  account: { account: "DU1234567", currency: "CAD", netLiquidation: 1, buyingPower: 1, availableFunds: 1, totalCash: 1, grossPositionValue: 0 },
  pnl: { daily: null, unrealized: null, realized: null },
  positions: [],
  openOrders: [],
  ...over,
});

/** A stored 09:00 run made while TWS sat at its login window: bridge FAIL, later stages SKIP. */
const storedFail = (): HealthResult => ({
  at: 1_000,
  atNy: "2026-11-26 09:00 EST",
  overall: "FAIL",
  counts: { PASS: 1, WARN: 0, FAIL: 1, SKIP: 1 },
  checks: [
    { stage: "safety", name: "paper_lock", status: "PASS", detail: "ok", ms: 1 },
    { stage: "broker", name: "bridge", status: "FAIL", detail: "bridge RECONNECTING: ConnectionRefusedError", ms: 0 },
    { stage: "data", name: "daily_bars", status: "SKIP", detail: "needs TWS (bridge not connected)", ms: 0 },
  ],
});

describe("reconcileHealth: one connection state everywhere", () => {
  it("never says FAIL while the account card says Connected", () => {
    const r = reconcileHealth(storedFail(), status(), null, NOW)!;
    const bridge = r.checks.find((c) => c.name === "bridge")!;
    expect(bridge.status).toBe("PASS");
    expect(bridge.live).toBe(true);
    expect(r.overall).toBe("PASS");
    expect(r.counts).toEqual({ PASS: 2, WARN: 0, FAIL: 0, SKIP: 1 });
    expect(r.stale).toBe(true);
    expect(r.staleReason).toContain("as of then");
    expect(r.asOfNy).toBe("2026-11-26 09:00 EST");
  });

  it("and never PASS while the account card says disconnected", () => {
    const stored = storedFail();
    stored.checks[1] = { ...stored.checks[1], status: "PASS", detail: "DU1234567" };
    stored.overall = "PASS";
    const r = reconcileHealth(stored, status({ state: "RECONNECTING", downReason: "TWS API not reachable on 127.0.0.1:7497" }), null, NOW)!;
    const bridge = r.checks.find((c) => c.name === "bridge")!;
    expect(bridge.status).toBe("FAIL");
    expect(bridge.detail).toContain("TWS API not reachable");
    expect(r.overall).toBe("FAIL");
    expect(r.stale).toBe(true);
  });

  it("a gateway error or a stale snapshot is not Connected (same rule as the HUD)", () => {
    expect(liveBridgeRow(status(), "timeout", NOW).status).toBe("FAIL");
    expect(liveBridgeRow(status({ updatedAt: NOW - 60 }), null, NOW).status).toBe("FAIL");
  });

  it("agreeing states keep the stored detail and are not stale", () => {
    const stored = storedFail();
    stored.checks[1] = { ...stored.checks[1], status: "PASS", detail: "DU1234567 · client 11" };
    stored.overall = "PASS";
    const r = reconcileHealth(stored, status(), null, NOW)!;
    expect(r.stale).toBe(false);
    expect(r.checks[1].detail).toBe("DU1234567 · client 11");
  });

  it("leaves the stored run alone until the live state is known", () => {
    const s = storedFail();
    expect(reconcileHealth(s, null, null, NOW)).toBe(s);
    expect(reconcileHealth(null, status(), null, NOW)).toBeNull();
  });

  it("overallOf ranks like healthcheck.overall", () => {
    expect(overallOf([])).toBe("PASS");
    expect(overallOf([{ stage: "a", name: "b", status: "SKIP", detail: "", ms: 0 }])).toBe("PASS");
    expect(overallOf([{ stage: "a", name: "b", status: "WARN", detail: "", ms: 0 }])).toBe("WARN");
  });
});

describe("failureText: every failure has a reason", () => {
  const decision: Decision = { verdict: "APPROVED", intentId: "x", quantity: 1, requestedQuantity: 1, checks: [], reasons: [], tripKill: false, entryRef: null, riskBase: null, notionalBase: null };

  it("shows the structured reason", () => {
    expect(failureText({ status: "failed", result: {}, decision, failure: { code: "rejected_by_ibkr", label: "Rejected by IBKR", detail: "TWS rejected the order: 321" } }))
      .toBe("Rejected by IBKR: TWS rejected the order: 321");
  });

  it("falls back to an old row's error text instead of a bare 'failed'", () => {
    expect(failureText({ status: "failed", result: { error: "ExecutionRefused: boom" }, decision })).toBe("Failed: ExecutionRefused: boom");
    expect(failureText({ status: "failed", result: null, decision })).toBe("Failed: no reason recorded");
    expect(failureText({ status: "rejected", result: null, decision: { ...decision, reasons: ["market_hours: outside regular trading hours"] } }))
      .toBe("Rejected: market_hours: outside regular trading hours");
  });

  it("is null for rows that did not fail", () => {
    expect(failureText({ status: "submitted", result: {}, decision })).toBeNull();
  });
});

describe("marketTone", () => {
  const m = (over: Partial<MarketStatus>): MarketStatus => ({
    open: false, reason: "holiday", label: "Market closed: holiday (Thanksgiving)", date: "2026-11-26", holiday: "Thanksgiving",
    earlyClose: false, earlyCloseReason: null, closeEt: null, nextOpen: 0, nextOpenNy: "", known: true, ...over,
  });
  it("closed on a holiday, early on a half day, open otherwise", () => {
    expect(marketTone(m({}))).toBe("closed");
    expect(marketTone(m({ open: true, reason: "open", earlyClose: true, holiday: null }))).toBe("early");
    expect(marketTone(m({ open: true, reason: "open", holiday: null }))).toBe("open");
    expect(marketTone(m({ open: false, reason: "after_hours", earlyClose: true, holiday: null }))).toBe("closed");
  });
});
