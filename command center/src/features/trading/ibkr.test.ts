import { describe, expect, it } from "vitest";
import { hudLevel, money, pnlTone, STALE_AFTER_S, type IbkrStatus } from "./ibkr";
import { tvWidgetConfig } from "./TvChart";

const base = (over: Partial<IbkrStatus> = {}): IbkrStatus => ({
  state: "CONNECTED",
  mode: "PAPER",
  host: "127.0.0.1",
  port: 7497,
  clientId: 11,
  readOnly: true,
  reasons: [],
  lastError: null,
  connectedSince: 1000,
  updatedAt: 1000,
  account: null,
  pnl: { daily: null, unrealized: null, realized: null },
  positions: [],
  openOrders: [],
  ...over,
});

describe("hudLevel", () => {
  it("maps bridge states to the four HUD levels", () => {
    expect(hudLevel(base(), 1001).level).toBe("connected");
    expect(hudLevel(base({ state: "RECONNECTING" }), 1001)).toEqual({ level: "reconnecting", label: "Reconnecting" });
    expect(hudLevel(base({ state: "LOCKED" }), 1001).level).toBe("locked");
    expect(hudLevel(base({ state: "BRIDGE_OFFLINE" }), 1001)).toEqual({ level: "disconnected", label: "Bridge offline" });
    expect(hudLevel(null).level).toBe("disconnected");
  });

  it("never shows Connected for a stale snapshot", () => {
    expect(hudLevel(base(), 1000 + STALE_AFTER_S + 1)).toEqual({ level: "reconnecting", label: "Stale" });
  });
});

describe("formatting", () => {
  it("formats money and P&L tone", () => {
    expect(money(null)).toBe("—");
    expect(money(-12.5, "USD")).toMatch(/^−12\.50 USD$/);
    expect(pnlTone(3)).toBe("teal");
    expect(pnlTone(-3)).toBe("alert");
    expect(pnlTone(0)).toBe("ink");
  });
});

describe("tvWidgetConfig", () => {
  it("passes symbol and interval through to the advanced-chart embed", () => {
    const c = tvWidgetConfig("AMEX:GLD", "15");
    expect(c).toMatchObject({ symbol: "AMEX:GLD", interval: "15", autosize: true, theme: "dark" });
  });
});
