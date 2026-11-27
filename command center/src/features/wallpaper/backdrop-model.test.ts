import { describe, expect, it } from "vitest";
import { nextInPool, sanitizeConfig, SURFACE_DEFAULTS, surfacePool, surfacesOf, toggleSurface, type PoolItem } from "./backdrop-model";

const w = (id: string, p: Partial<PoolItem> = {}): PoolItem => ({ id, enabled: true, src: `/${id}.jpg`, tags: { atmospheres: [], phases: [] }, ...p });

describe("migration + defaults", () => {
  it("keeps every v1 wallpaper on Home only", () => {
    expect(surfacesOf({})).toEqual(["home"]);
    expect(surfacesOf({ surfaces: undefined })).toEqual(["home"]);
    expect(surfacesOf({ surfaces: ["orbital", "bogus", "home"] })).toEqual(["home", "orbital"]);
    expect(surfacesOf({ surfaces: [] })).toEqual([]);
  });
  it("defaults the System Map pages to Clean Minimal with legibility-first blends", () => {
    expect(SURFACE_DEFAULTS.home.enabled).toBe(true);
    expect(SURFACE_DEFAULTS.flowchart).toMatchObject({ enabled: false, rotateIntervalSec: 50, opacity: 35, dimmer: 50, blurPx: 2, vignette: true });
    expect(SURFACE_DEFAULTS.orbital).toMatchObject({ enabled: false, rotateIntervalSec: 50, opacity: 55, dimmer: 35, blurPx: 0, vignette: true });
  });
  it("sanitises stored configs (clamps, fills gaps)", () => {
    const c = sanitizeConfig("flowchart", { opacity: 400, dimmer: 99, blurPx: -3, enabled: true } as never);
    expect(c).toMatchObject({ opacity: 100, dimmer: 85, blurPx: 0, enabled: true, shuffle: false, rotateIntervalSec: 50 });
    expect(sanitizeConfig("orbital", undefined)).toEqual(SURFACE_DEFAULTS.orbital);
  });
});

describe("surfacePool", () => {
  const items = [
    w("a", { surfaces: ["home"] }),
    w("b", { surfaces: ["home", "orbital"], tags: { atmospheres: ["rain"], phases: ["night"] } }),
    w("c", { surfaces: ["orbital"] }),
    w("d", { surfaces: ["orbital"], enabled: false }),
    w("e", { surfaces: ["orbital"], src: undefined }),
    w("f"), // v1 record: Home
  ];
  const off = { syncWeatherTime: false, pinnedWallpaperId: null };
  it("takes only enabled, loaded wallpapers assigned to the surface", () => {
    expect(surfacePool(items, "home", off, "clear", "day").map((i) => i.id)).toEqual(["a", "b", "f"]);
    expect(surfacePool(items, "orbital", off, "clear", "day").map((i) => i.id)).toEqual(["b", "c"]);
    expect(surfacePool(items, "flowchart", off, "clear", "day")).toEqual([]);
  });
  it("narrows to the best fit when synced, and a valid pin wins", () => {
    expect(surfacePool(items, "orbital", { syncWeatherTime: true, pinnedWallpaperId: null }, "rain", "night").map((i) => i.id)).toEqual(["b"]);
    expect(surfacePool(items, "orbital", { syncWeatherTime: true, pinnedWallpaperId: null }, "snow", "day").map((i) => i.id)).toEqual(["b", "c"]);
    expect(surfacePool(items, "orbital", { syncWeatherTime: true, pinnedWallpaperId: "c" }, "rain", "night").map((i) => i.id)).toEqual(["c"]);
    // A pin that is not in this surface's pool is ignored.
    expect(surfacePool(items, "orbital", { syncWeatherTime: false, pinnedWallpaperId: "a" }, "rain", "night").map((i) => i.id)).toEqual(["b", "c"]);
  });
});

describe("rotation + badges", () => {
  it("steps in order, wraps, and re-enters an empty / stale position", () => {
    expect(nextInPool([], "a", false)).toBeNull();
    expect(nextInPool(["a", "b", "c"], "a", false)).toBe("b");
    expect(nextInPool(["a", "b", "c"], "c", false)).toBe("a");
    expect(nextInPool(["a", "b"], "zz", false)).toBe("a");
    expect(nextInPool(["a"], "a", true)).toBe("a");
  });
  it("never repeats the current image on shuffle", () => {
    const seq = [0, 0, 0, 0, 0, 0, 0, 0];
    let i = 0;
    expect(nextInPool(["a", "b", "c"], "a", true, () => seq[i++] ?? 0)).not.toBe("a");
    expect(nextInPool(["a", "b", "c"], "a", true, () => 0.9)).toBe("c");
  });
  it("toggles a surface badge, keeping a canonical order", () => {
    expect(toggleSurface(["home"], "orbital")).toEqual(["home", "orbital"]);
    expect(toggleSurface(["home", "orbital"], "home")).toEqual(["orbital"]);
    expect(toggleSurface(["orbital"], "flowchart")).toEqual(["flowchart", "orbital"]);
  });
});
