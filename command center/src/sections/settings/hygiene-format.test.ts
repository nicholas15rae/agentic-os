import { describe, expect, it } from "vitest";
import { badgeTone, cadenceLabel, cadencePeriod, presetOf, pressureFill, pressureLabel, pressureTone, relTime, SCROLLS_PRESETS } from "./hygiene-format";

describe("hygiene format", () => {
  it("presets match the Rust table", () => {
    expect(SCROLLS_PRESETS.map((p) => [p.id, p.kb, p.turns])).toEqual([
      ["tight", 25, 15],
      ["balanced", 50, 25],
      ["relaxed", 100, 50],
    ]);
    expect(presetOf(50, 25)).toBe("balanced");
    expect(presetOf(50, 26)).toBeNull();
  });

  it("labels the cadence", () => {
    expect(cadenceLabel("daily", 3, 0)).toBe("Daily at 03:00");
    expect(cadenceLabel("weekly", 3, 0)).toBe("Weekly · Sunday 03:00");
    expect(cadenceLabel("weekly", 22, 9)).toBe("Weekly · Tuesday 22:00");
    expect(cadenceLabel("monthly", 3, 0)).toBe("Monthly · 1st at 03:00");
    expect(cadencePeriod("weekly")).toBe("the previous week");
  });

  it("relative times", () => {
    const now = 1_000_000_000_000;
    expect(relTime(null, now)).toBe("—");
    expect(relTime(now / 1000 - 10, now)).toBe("just now");
    expect(relTime(now / 1000 - 300, now)).toBe("5m ago");
    expect(relTime(now / 1000 + 3 * 3600, now)).toBe("in 3h");
    expect(relTime(now / 1000 + 2 * 86_400, now)).toBe("in 2d");
  });

  it("pressure bar", () => {
    expect(pressureFill(0.5)).toBe(25);
    expect(pressureFill(2)).toBe(100);
    expect(pressureFill(5)).toBe(100);
    expect(pressureFill(null)).toBe(0);
    expect(pressureTone("red")).toBe("bg-alert");
    expect(pressureLabel("amber")).toContain("Amber");
    expect(pressureLabel(null)).toContain("Unknown");
    expect(badgeTone({ state: "ready", label: "Idle — Ready" })).toContain("teal");
    expect(badgeTone(null)).toContain("ink-3");
  });
});
