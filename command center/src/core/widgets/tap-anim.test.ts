import { describe, expect, it } from "vitest";
import { TAP_ANIMS, animationsOn, clampStrength, tapAnimOf, tapMotion } from "./tap-anim";
import { mergeLook } from "./look";
import { resolveTokens, sanitizePatch } from "@/features/appearance/theme";

describe("UI fixes 5: widget tap animations", () => {
  it("one switch: Widget animations on, Motion full and no OS reduced motion", () => {
    expect(animationsOn({ appSwitch: "on", motion: "full", osReduced: false })).toBe(true);
    expect(animationsOn({ appSwitch: "off", motion: "full", osReduced: false })).toBe(false);
    expect(animationsOn({ appSwitch: "on", motion: "reduced", osReduced: false })).toBe(false);
    expect(animationsOn({ appSwitch: "on", motion: "full", osReduced: true })).toBe(false);
  });

  it("the switch is a design token: on by default, a page can turn it off, junk is ignored", () => {
    expect(resolveTokens().animations).toBe("on");
    expect(resolveTokens({}, { animations: "off" }).animations).toBe("off");
    expect(sanitizePatch({ animations: "sometimes" })).toEqual({});
  });

  it("each widget picks its own; panels and the hero stay still unless asked; safety controls never animate", () => {
    expect(tapAnimOf(undefined, {})).toBe("bounce");
    expect(tapAnimOf(undefined, { panel: true })).toBe("none");
    expect(tapAnimOf({ tapAnim: "glow" }, { panel: true })).toBe("glow");
    expect(tapAnimOf({ tapAnim: "flip" }, { locked: true })).toBe("none");
    expect(tapAnimOf({ tapAnim: "spin" as never }, {})).toBe("bounce");
  });

  it("every style is short, ends where it started and touches only transform or shadow", () => {
    for (const a of TAP_ANIMS) {
      const m = tapMotion(a, 1.5);
      if (a === "none") {
        expect(m).toBeNull();
        continue;
      }
      expect(Number(m!.options.duration)).toBeLessThanOrEqual(600);
      const first = m!.keyframes[0];
      const last = m!.keyframes.at(-1)!;
      expect(last).toEqual(first);
      for (const k of m!.keyframes) for (const prop of Object.keys(k)) expect(["transform", "boxShadow", "offset"]).toContain(prop);
    }
  });

  it("strength scales the motion and is clamped (also when saved in the look)", () => {
    const soft = tapMotion("expand", 0.25)!.keyframes[1].transform;
    const strong = tapMotion("expand", 1.5)!.keyframes[1].transform;
    expect(soft).toBe("scale(1.01)");
    expect(strong).toBe("scale(1.06)");
    expect(clampStrength(9)).toBe(1.5);
    expect(clampStrength("x")).toBe(1);
    expect(mergeLook({}, { tapStrength: 0 }).tapStrength).toBe(0.25);
    expect(mergeLook({ tapAnim: "glow" }, { tapStrength: 1 })).toEqual({ tapAnim: "glow", tapStrength: 1 });
  });

  it("glow uses the theme's accent", () => {
    expect(JSON.stringify(tapMotion("glow", 1, "1, 2, 3")!.keyframes)).toContain("rgba(1, 2, 3, 0.4)");
  });
});
