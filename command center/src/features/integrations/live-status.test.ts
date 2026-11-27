import { describe, expect, it } from "vitest";
import type { InstagramStatus } from "@/lib/platform";
import { instagramBadge, mapsBadge, tokenExpiryLine } from "./live-status";

const ig = (p: Partial<InstagramStatus>): InstagramStatus => ({
  status: "ok",
  source: "env-file",
  username: null,
  accountType: null,
  followers: null,
  mediaCount: null,
  tokenExpiresAt: null,
  refreshedAt: null,
  detail: "",
  ...p,
});

describe("live integration status", () => {
  it("Instagram badge follows the backend status", () => {
    expect(instagramBadge(null)).toEqual({ label: "CHECKING…", tone: "idle" });
    expect(instagramBadge(ig({ username: "gabagool" }))).toEqual({ label: "CONNECTED · @gabagool", tone: "ok" });
    expect(instagramBadge(ig({ status: "missing" })).label).toBe("NO TOKEN");
    expect(instagramBadge(ig({ status: "error" })).tone).toBe("down");
    expect(instagramBadge(ig({ status: "blocked" })).tone).toBe("warn");
  });

  it("maps badge", () => {
    expect(mapsBadge({ provider: "osm", status: "ok", detail: "", homeSet: false, latencyMs: 120 })).toEqual({ label: "ONLINE · 120 ms", tone: "ok" });
    expect(mapsBadge({ provider: "osm", status: "error", detail: "OSRM timed out", homeSet: false, latencyMs: null }).label).toBe("UNREACHABLE");
  });

  it("token expiry line", () => {
    expect(tokenExpiryLine({ tokenExpiresAt: null })).toMatch(/unknown/);
    expect(tokenExpiryLine({ tokenExpiresAt: 1000 + 52 * 86_400 }, 1000)).toBe("Renews automatically · expires in 52 days.");
    expect(tokenExpiryLine({ tokenExpiresAt: 10 }, 1000)).toMatch(/expired/);
  });
});
