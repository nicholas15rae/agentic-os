import { describe, expect, it } from "vitest";
import { categoryOf, groupItems, matches, type DrawerItem } from "./drawer";

const it_ = (key: string, title: string, description = "", keywords?: string[]): DrawerItem => ({ key, title, description, category: categoryOf(key), keywords });

describe("widget drawer", () => {
  it("groups by category in a fixed order, sorted by title, empty groups dropped", () => {
    const items = [it_("weather", "Weather"), it_("spotify", "Spotify"), it_("mantra", "Mantra"), it_("brand-new", "Brand new"), { key: "staged-build:b1", title: "Clock", description: "", category: "Your builds" as const }];
    const g = groupItems(items, "");
    expect(g.map((x) => x.category)).toEqual(["Your builds", "At a glance", "Media & Tony", "Other"]);
    expect(g[1].items.map((x) => x.title)).toEqual(["Mantra", "Weather"]);
  });
  it("search matches every word across title, description, category and keywords", () => {
    const w = it_("weather", "Weather", "Forecast for today", ["rain"]);
    expect(matches(w, "rain")).toBe(true);
    expect(matches(w, "forecast glance")).toBe(true);
    expect(matches(w, "spotify")).toBe(false);
    expect(groupItems([w], "nothing here")).toEqual([]);
  });
});
