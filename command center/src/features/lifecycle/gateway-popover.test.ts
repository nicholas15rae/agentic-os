import { describe, expect, it } from "vitest";
import { fmtAgo, fmtRate, NET_POLL_MS } from "./GatewayPopover";

describe("Gateway popover formatting", () => {
  it("formats throughput", () => {
    expect(fmtRate(null)).toBe("—");
    expect(fmtRate(820)).toBe("820 B/s");
    expect(fmtRate(4300)).toBe("4.2 KB/s");
    expect(fmtRate(110_000)).toBe("107 KB/s");
    expect(fmtRate(1_550_000)).toBe("12.4 Mbps");
    expect(fmtRate(20_000_000)).toBe("160 Mbps");
  });
  it("formats test age", () => {
    expect(fmtAgo(1000, 3000)).toBe("just now");
    expect(fmtAgo(0, 42_000)).toBe("42s ago");
    expect(fmtAgo(0, 300_000)).toBe("5m ago");
    expect(fmtAgo(0, 3 * 3_600_000)).toBe("3h ago");
  });
  it("polls every 2 s (only while open)", () => {
    expect(NET_POLL_MS).toBe(2000);
  });
});
