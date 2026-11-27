// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clockAriaLabel,
  EffectsPopoverView,
  effectsAriaLabel,
  formatClock,
  formatClockDate,
  msToNextMinute,
  nextFitLevel,
  startMinuteTick,
  TopBarClockView,
} from "./TopBarClock";
import type { TopBarClockViewProps } from "./TopBarClock.contract";
import { clampPopoverWidth, popoverPosition, popoverTakesEscape, POPOVER_W } from "./useAnchoredPopover";

const TZ = { locale: "en-US", timeZone: "America/Toronto" };
// Thursday 26 November 2026, 22:42 in Toronto (EST, UTC-5).
const THU_2242 = Date.UTC(2026, 10, 27, 3, 42);
const noop = () => undefined;

const view = (over: Partial<TopBarClockViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(TopBarClockView, {
      now: THU_2242,
      hourCycle: "h12",
      showDate: true,
      tempC: 3,
      density: "full",
      effects: { enabled: true, source: "live", atmosphere: "snow" },
      open: "none",
      onToggleAlarms: noop,
      onToggleEffects: noop,
      ...over,
    }),
  );

describe("formatClock / formatClockDate (fixed locale and zone)", () => {
  it("h12 and h23 on Thursday 26 Nov 2026", () => {
    expect(formatClock(THU_2242, "h12", TZ)).toEqual({ time: "10:42", dayPeriod: "PM", a11y: "10:42 PM, Thursday 26 November" });
    expect(formatClock(THU_2242, "h23", TZ)).toEqual({ time: "22:42", dayPeriod: null, a11y: "22:42, Thursday 26 November" });
    expect(formatClockDate(THU_2242, TZ)).toBe("Thu 26 Nov");
  });

  it("the locale's day-period marker (en-CA writes p.m.)", () => {
    expect(formatClock(THU_2242, "h12", { locale: "en-CA", timeZone: "America/Toronto" }).dayPeriod).toBe("p.m.");
  });

  it("fall back 2026-11-01: 1:30 happens twice, then 2:00 EST", () => {
    expect(formatClock(Date.UTC(2026, 10, 1, 5, 30), "h12", TZ).time).toBe("1:30"); // EDT
    expect(formatClock(Date.UTC(2026, 10, 1, 6, 30), "h12", TZ).time).toBe("1:30"); // EST
    expect(formatClock(Date.UTC(2026, 10, 1, 7, 0), "h23", TZ).time).toBe("02:00");
    expect(formatClockDate(Date.UTC(2026, 10, 1, 7, 0), TZ)).toBe("Sun 1 Nov");
  });

  it("spring forward 2026-03-08: 1:59 EST is followed by 3:00 EDT", () => {
    expect(formatClock(Date.UTC(2026, 2, 8, 6, 59), "h23", TZ).time).toBe("01:59");
    expect(formatClock(Date.UTC(2026, 2, 8, 7, 0), "h23", TZ).time).toBe("03:00");
    expect(formatClockDate(Date.UTC(2026, 2, 8, 7, 0), TZ)).toBe("Sun 8 Mar");
  });
});

describe("minute tick", () => {
  afterEach(() => vi.useRealTimers());

  it("aims just past the next minute boundary", () => {
    expect(msToNextMinute(Date.UTC(2026, 10, 26, 15, 0, 0))).toBe(60_020);
    expect(msToNextMinute(Date.UTC(2026, 10, 26, 15, 0, 59, 990))).toBe(30);
  });

  it("fires on each minute boundary, and lands on the right minute after a long stall (sleep)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 26, 15, 0, 30));
    const ticks: number[] = [];
    const stop = startMinuteTick((m) => ticks.push(m));
    vi.advanceTimersByTime(30_020);
    expect(ticks).toEqual([Date.UTC(2026, 10, 26, 15, 1)]);
    vi.advanceTimersByTime(60_000);
    expect(ticks.at(-1)).toBe(Date.UTC(2026, 10, 26, 15, 2));
    // Sleep: the clock jumps 3 h 17 min while the timer is suspended; the next tick reads the real time.
    vi.setSystemTime(Date.UTC(2026, 10, 26, 18, 19, 10));
    vi.advanceTimersByTime(60_000);
    expect(ticks.at(-1)).toBe(Date.UTC(2026, 10, 26, 18, 20));
    stop();
    const n = ticks.length;
    vi.advanceTimersByTime(180_000);
    expect(ticks).toHaveLength(n);
  });
});

describe("TopBarClockView", () => {
  it("full: effects icon, time, PM, temperature and date; both buttons open dialogs", () => {
    const html = view();
    expect(html).toContain('data-testid="topbar-clock"');
    expect(html).toContain("shrink-0");
    expect(html).toContain(formatClock(THU_2242, "h12").time);
    expect(html).toContain('data-clock-part="temp"');
    expect(html).toContain("3°");
    expect(html).toContain('data-clock-part="date"');
    expect(html).toContain(formatClockDate(THU_2242));
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Weather effects: live (snow)"');
    expect(html).toContain(`aria-label="${clockAriaLabel(formatClock(THU_2242, "h12").a11y, 3)}"`);
    expect(html).not.toContain("effects-manual-dot");
  });

  it("compact: no date even when showDate; the temperature stays when known", () => {
    const html = view({ density: "compact" });
    expect(html).not.toContain('data-clock-part="date"');
    expect(html).toContain('data-clock-part="temp"');
  });

  it("tempC null hides the temperature; showDate false hides the date", () => {
    const html = view({ tempC: null, showDate: false });
    expect(html).not.toContain('data-clock-part="temp"');
    expect(html).not.toContain('data-clock-part="date"');
    expect(html).toMatch(/aria-label="[^"]*November\. Open alarms and key dates"/);
  });

  it("h23 shows no day period", () => {
    const html = view({ hourCycle: "h23" });
    expect(html).toContain(formatClock(THU_2242, "h23").time);
    expect(html).not.toMatch(/label-caps -ml-0\.5/);
  });

  it("manual always shows the amber dot; off reads 'Weather effects off'", () => {
    expect(view({ effects: { enabled: true, source: "manual", atmosphere: "rain" } })).toContain('aria-label="Weather effects: manual (rain)"');
    expect(view({ effects: { enabled: true, source: "manual", atmosphere: "rain" } })).toContain("effects-manual-dot");
    const off = view({ effects: { enabled: false, source: "manual", atmosphere: "rain" } });
    expect(off).toContain('aria-label="Weather effects off"');
    expect(off).toContain("effects-manual-dot");
  });

  it("aria-expanded follows the open popover", () => {
    expect(view({ open: "alarms" })).toMatch(/aria-expanded="true" aria-label="[^"]*Open alarms and key dates"/);
    expect(view({ open: "effects" })).toMatch(/aria-expanded="true" aria-label="Weather effects: live/);
  });

  it("labels", () => {
    expect(effectsAriaLabel({ enabled: true, source: "fallback", atmosphere: "midnight" })).toBe("Weather effects: live (midnight)");
    expect(clockAriaLabel("10:42 PM, Thursday 26 November", null)).toBe("10:42 PM, Thursday 26 November. Open alarms and key dates");
  });
});

describe("EffectsPopoverView (lean, decision 33)", () => {
  const base = { effects: { enabled: true, intensity: "normal" as const }, atmosphere: "snow" as const, source: "live" as const, particlesSuppressed: false, onEffects: noop, onMode: noop, onOpenForecast: noop };

  it("live: on/off, intensity, Open weather & forecast, and no picker or forecast", () => {
    const html = renderToStaticMarkup(createElement(EffectsPopoverView, { ...base, mode: "auto" }));
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Weather effects"/);
    expect(html).toContain('aria-label="Effects intensity"');
    expect(html).toContain("Open weather &amp; forecast");
    expect(html).toContain("Live · Snow");
    expect(html).not.toContain("Back to Live");
    expect(html).not.toContain('aria-label="Atmosphere"');
    expect(html).not.toContain('aria-label="Forecast"');
    expect(html).not.toContain("Particles are off");
  });

  it("manual shows Manual with Back to Live; suppressed particles say so", () => {
    const html = renderToStaticMarkup(createElement(EffectsPopoverView, { ...base, mode: "rain", atmosphere: "rain", source: "manual", particlesSuppressed: true }));
    expect(html).toContain("Manual · Rain");
    expect(html).toContain("Back to Live");
    expect(html).toContain("Particles are off on this device");
  });
});

describe("fit: date drops first, then temperature", () => {
  it("overflow drops one level at a time, never past 2", () => {
    expect(nextFitLevel(0, { overflow: 30, slack: 0 }, 0)).toBe(1);
    expect(nextFitLevel(1, { overflow: 5, slack: 0 }, 70)).toBe(2);
    expect(nextFitLevel(2, { overflow: 5, slack: 0 }, 40)).toBe(2);
  });

  it("a part returns only when the free space covers its width (no flicker)", () => {
    expect(nextFitLevel(2, { overflow: 0, slack: 30 }, 40)).toBe(2);
    expect(nextFitLevel(2, { overflow: 0, slack: 42 }, 40)).toBe(1);
    expect(nextFitLevel(1, { overflow: 0, slack: 50 }, 76)).toBe(1);
    expect(nextFitLevel(0, { overflow: 0, slack: 500 }, 0)).toBe(0);
  });
});

describe("useAnchoredPopover helpers", () => {
  it("a 360 px popover on a 360 px screen is 344 px and stays inside it", () => {
    const w = clampPopoverWidth(360, 360);
    expect(w).toBe(344);
    const { left } = popoverPosition({ left: 200, right: 340, bottom: 52 }, 360, w);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + w).toBeLessThanOrEqual(352);
    // 375 (the Playwright phone): left >= 8, right <= 367.
    const w375 = clampPopoverWidth(360, 375);
    const p = popoverPosition({ left: 230, right: 360, bottom: 52 }, 375, w375);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + w375).toBeLessThanOrEqual(367);
    // Wide screens keep the requested width.
    expect(clampPopoverWidth(360, 1440)).toBe(360);
  });

  it("popoverPosition keeps ModePill's default width", () => {
    expect(popoverPosition({ left: 900, right: 1000, bottom: 50 }, 1400)).toEqual({ top: 58, left: 1000 - POPOVER_W });
  });

  it("Escape is left for a pending confirmation card", () => {
    expect(popoverTakesEscape("Escape", false)).toBe(true);
    expect(popoverTakesEscape("Escape", true)).toBe(false);
    expect(popoverTakesEscape("Enter", false)).toBe(false);
  });
});
