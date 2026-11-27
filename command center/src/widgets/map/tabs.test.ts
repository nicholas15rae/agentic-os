import { describe, expect, it } from "vitest";
import { isCompact, resolveTab, tabsFit } from "./tabs";

describe("Maps widget tabs", () => {
  it("keeps a saved tab; else Upcoming on the phone, Map on the PC", () => {
    expect(resolveTab("saved", false)).toBe("saved");
    expect(resolveTab("bogus", false)).toBe("map");
    expect(resolveTab(undefined, true)).toBe("upcoming");
    expect(resolveTab(3, true)).toBe("upcoming");
  });
  it("collapses to icons below 4 columns; rows go compact at 3 wide or 2 tall", () => {
    expect(tabsFit({ w: 3, h: 3 })).toBe("icons");
    expect(tabsFit({ w: 4, h: 3 })).toBe("full");
    expect(tabsFit(undefined)).toBe("full");
    expect(isCompact({ w: 4, h: 3 })).toBe(false);
    expect(isCompact({ w: 3, h: 4 })).toBe(true);
    expect(isCompact({ w: 6, h: 2 })).toBe(true);
  });
});
