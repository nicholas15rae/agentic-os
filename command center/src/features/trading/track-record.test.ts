import { describe, expect, it, vi } from "vitest";

const calls: { path: string; init?: RequestInit }[] = [];
vi.mock("@/lib/gateway", () => ({
  gateway: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return {};
  }),
}));

import type { LeaderRow } from "./ibkr";
import { MIN_SCORED, adjustedHit, bandText, isTrackRecord, rText, spyText, splitBoard, trackCell, trackRecordApi, wilson } from "./track-record";

const row = (id: string, calls: number, hits: number, extra: Partial<LeaderRow> = {}): LeaderRow => ({
  id, name: id, calls, hits, hitRate: hits / calls, shrunkHitRate: (hits + 5) / (calls + 10), avgRet: 1, medianRet: 1, horizon: 5, ...extra,
});

describe("14.7 rankings", () => {
  it("wilson matches the Python outcomes.wilson", () => {
    const [lo, hi] = wilson(7, 10);
    expect(lo).toBeCloseTo(0.3968, 3);
    expect(hi).toBeCloseTo(0.8922, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it("never ranks a source under MIN_SCORED, however hot", () => {
    expect(MIN_SCORED).toBe(30);
    const s = splitBoard([row("hot", 29, 29), row("steady", 50, 30), row("better", 30, 24)]);
    expect(s.ranked.map((r) => r.id)).toEqual(["better", "steady"]);
    expect(s.notEnough.map((r) => r.id)).toEqual(["hot"]);
  });

  it("follows the bridge's ranked flag and minScored when sent", () => {
    const s = splitBoard([row("a", 12, 9, { ranked: true, minScored: 10, wilsonLow: 0.5, wilsonHigh: 0.9 }), row("b", 8, 8, { ranked: false, minScored: 10 })]);
    expect(s.minScored).toBe(10);
    expect(s.ranked.map((r) => r.id)).toEqual(["a"]);
    expect(adjustedHit(s.ranked[0])).toBe(0.5);
    expect(bandText(s.ranked[0])).toBe("50%–90%");
  });

  it("orders ranked rows by the Wilson lower bound, not the raw hit rate", () => {
    const s = splitBoard([row("small", 30, 24), row("big", 200, 150)]);
    expect(s.ranked.map((r) => r.id)).toEqual(["big", "small"]);
  });

  it("handles no rows", () => {
    expect(splitBoard(undefined)).toEqual({ ranked: [], notEnough: [], minScored: 30 });
  });
});

describe("14.6 track record", () => {
  it("is a GET of /api/trading/track-record", async () => {
    calls.length = 0;
    await trackRecordApi.get();
    expect(calls[0].path).toBe("/api/trading/track-record");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });

  it("guards against an older gateway's body", () => {
    expect(isTrackRecord({})).toBe(false);
    expect(isTrackRecord({ detail: "Not Found" })).toBe(false);
    expect(isTrackRecord(null)).toBe(false);
    expect(isTrackRecord({ paper: {}, drift: { message: "x" }, goal: {}, spy: {} })).toBe(true);
  });

  it("formats cells", () => {
    const set = { trades: 24, wins: 12, losses: 12, winRate: 0.5, expectancyR: 0.25, avgWinR: 1, avgLossR: -0.5, totalR: 6, stdR: 0.76,
      maxDrawdownR: 1.5, pctEquity: 1.5, from: "2026-09-01", to: "2026-10-01" };
    expect(trackCell("trades", set)).toBe("24");
    expect(trackCell("winRate", set)).toBe("50%");
    expect(trackCell("expectancyR", set)).toBe("+0.25R");
    expect(trackCell("avgLossR", set)).toBe("−0.50R");
    expect(trackCell("maxDrawdownR", set)).toBe("1.50R");
    expect(trackCell("pctEquity", set)).toBe("+1.50%");
    expect(trackCell("trades", null)).toBe("—");
    expect(rText(null)).toBe("—");
    expect(spyText({ from: "a", to: "b", retPct: 4.2, partial: true })).toBe("+4.20%*");
    expect(spyText({ from: "a", to: "b", retPct: null, why: "no bars" })).toBe("n/a");
    expect(spyText(null)).toBe("—");
  });
});
