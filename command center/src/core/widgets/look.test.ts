import { describe, expect, it } from "vitest";
import { clampScale, DEFAULT_GLASS_ALPHA, fitZoom, frameOf, mergeLook, opacityFor, overflowRatio, wallTone } from "./look";

describe("widget look (section pass)", () => {
  it("frame: its own choice, else the old ultra toggle, else frameless for a chromeless widget", () => {
    expect(frameOf({}, false)).toBe("glass");
    expect(frameOf({}, true)).toBe("frameless");
    expect(frameOf({ glass: "ultra" }, false)).toBe("ultra");
    expect(frameOf({ glass: "ultra", look: { frame: "solid" } }, true)).toBe("solid");
  });
  it("opacity is saved per wallpaper and merges", () => {
    const a = mergeLook(undefined, { opacity: { w1: 0.3 } });
    const b = mergeLook(a, { opacity: { w2: 0.9 }, font: "mono" });
    expect(opacityFor(b, "w1")).toBe(0.3);
    expect(opacityFor(b, "w2")).toBe(0.9);
    expect(opacityFor(b, "w3")).toBe(DEFAULT_GLASS_ALPHA);
    expect(b.font).toBe("mono");
  });
  it("size is clamped; content only ever shrinks to fit", () => {
    expect(clampScale(5)).toBe(1.6);
    expect(clampScale("x")).toBe(1);
    expect(fitZoom({ w: 100, h: 100 }, { w: 100, h: 200 }, 1)).toBe(0.5);
    expect(fitZoom({ w: 100, h: 100 }, { w: 50, h: 50 }, 1)).toBe(1);
    expect(overflowRatio({ scrollWidth: 100, scrollHeight: 300, clientWidth: 100, clientHeight: 100 })).toBe(3);
  });
  it("wallpaper brightness", () => {
    expect(wallTone(240, 240, 230)).toBe("light");
    expect(wallTone(20, 25, 40)).toBe("dark");
  });
});
