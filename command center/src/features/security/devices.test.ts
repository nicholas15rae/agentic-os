import { describe, expect, it } from "vitest";
import { canSignOut, seenAgo } from "./Devices";

describe("where you're logged in", () => {
  it("says how long ago a device was seen", () => {
    const now = 1_000_000;
    expect(seenAgo(null, now)).toBe("never");
    expect(seenAgo(now - 30, now)).toBe("just now");
    expect(seenAgo(now - 600, now)).toBe("10 min ago");
    expect(seenAgo(now - 7200, now)).toBe("2 h ago");
    expect(seenAgo(now - 3 * 86_400, now)).toBe("3 days ago");
  });
  it("only real per-device rows can be signed out one by one", () => {
    expect(canSignOut({ kind: "phone", revokedAt: null })).toBe(true);
    expect(canSignOut({ kind: "phone", revokedAt: 5 })).toBe(false);
    expect(canSignOut({ kind: "local", revokedAt: null })).toBe(false);
    expect(canSignOut({ kind: "shared", revokedAt: null })).toBe(false);
  });
});
