import { describe, expect, it } from "vitest";
import { barsRefreshMs, barsUrl } from "./ibkr";

describe("IBKR bars client", () => {
  it("builds the gateway query from the Yahoo-style chart settings", () => {
    expect(barsUrl(" spy ", "5m", "5d")).toBe("/api/trading/bars?symbol=SPY&interval=5m&range=5d");
    expect(barsUrl("SHOP.TO", "1d", "6mo")).toBe("/api/trading/bars?symbol=SHOP.TO&interval=1d&range=6mo");
  });

  it("never polls faster than IBKR's identical-request pacing (15 s)", () => {
    for (const iv of ["1m", "5m", "15m", "30m", "60m", "1d"]) expect(barsRefreshMs(iv)).toBeGreaterThanOrEqual(20_000);
    expect(barsRefreshMs("1d")).toBe(300_000);
  });
});
