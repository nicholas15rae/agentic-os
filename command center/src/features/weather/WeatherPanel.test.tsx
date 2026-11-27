import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { forecastAria, panelFit, statusText, WeatherPanelView } from "./WeatherPanel";
import type { ForecastDay, WeatherNow, WeatherPanelViewProps } from "./weather.contract";

const now: WeatherNow = { tempC: -2.4, windKph: 14, code: 73, isDay: true, label: "Snow", atmosphere: "snow", place: "Toronto", fetchedAt: 0, sunrise: null, sunset: null };
const WD = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const forecast: ForecastDay[] = WD.map((weekday, i) => ({
  date: `2026-11-${26 + i}`.replace("2026-11-31", "2026-12-01").replace("2026-11-32", "2026-12-02"),
  weekday,
  dayStart: i,
  code: i === 0 ? 73 : 3,
  label: i === 0 ? "Snow" : "Overcast",
  atmosphere: i === 0 ? "snow" : "autumn",
  maxC: 1 + i,
  minC: -4 + i,
  precipPct: i === 0 ? 60 : null,
  sunrise: null,
  sunset: null,
}));

const props = (over: Partial<WeatherPanelViewProps> = {}): WeatherPanelViewProps => ({
  now,
  forecast,
  error: null,
  loading: false,
  mode: "auto",
  atmosphere: "snow",
  source: "live",
  effects: { enabled: true, intensity: "normal" },
  particlesSuppressed: false,
  fit: { days: 7, showEffects: true },
  layout: "widget",
  onMode: vi.fn(),
  onEffects: vi.fn(),
  onRefresh: vi.fn(),
  ...over,
});
const html = (over?: Partial<WeatherPanelViewProps>) => renderToStaticMarkup(<WeatherPanelView {...props(over)} />);
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("panelFit", () => {
  it("3x2 widget: no forecast, no effects controls", () => {
    expect(panelFit("widget", { w: 3, h: 2 })).toEqual({ days: 0, showEffects: false });
  });
  it("3x3 widget (the new default): 7 days, no effects controls; 2x3 shows 4 days", () => {
    expect(panelFit("widget", { w: 3, h: 3 })).toEqual({ days: 7, showEffects: false });
    expect(panelFit("widget", { w: 2, h: 3 })).toEqual({ days: 4, showEffects: false });
  });
  it("tall widget and the popover sheet show the effects controls", () => {
    expect(panelFit("widget", { w: 3, h: 4 })).toEqual({ days: 7, showEffects: true });
    expect(panelFit("popover")).toEqual({ days: 7, showEffects: true });
  });
});

describe("WeatherPanelView", () => {
  it("renders 7 forecast items for 7 days and 3 for 3", () => {
    expect(count(html(), 'role="listitem"')).toBe(7);
    expect(count(html({ fit: { days: 3, showEffects: false } }), 'role="listitem"')).toBe(3);
    expect(html({ fit: { days: 0, showEffects: false } })).not.toContain('aria-label="Forecast"');
  });

  it("labels each day for screen readers; [0] is Today", () => {
    const out = html();
    expect(out).toContain('aria-label="Today: Snow, high 1°, low -4°, 60% precipitation"');
    expect(out).toContain('aria-label="Fri: Overcast, high 2°, low -3°"');
    expect(forecastAria(forecast[0], "Thu")).toBe("Thu: Snow, high 1°, low -4°, 60% precipitation");
  });

  it("marks the current mode checked in the picker, at every layout", () => {
    const out = html({ mode: "rain", atmosphere: "rain", source: "manual", fit: { days: 0, showEffects: false } });
    expect(out).toContain('role="radiogroup" aria-label="Atmosphere"');
    expect(out).toMatch(/aria-checked="true" aria-label="Rain"/);
    expect(out).toMatch(/aria-checked="false" aria-label="Live"/);
  });

  it("shows Manual and Back to Live only when a manual atmosphere is on, even at 3x2", () => {
    const manual = html({ mode: "rain", atmosphere: "rain", source: "manual", fit: { days: 0, showEffects: false } });
    expect(manual).toContain("Manual · Rain");
    expect(manual).toContain("Back to Live");
    const live = html();
    expect(live).toContain("Live · Snow");
    expect(live).not.toContain("Back to Live");
  });

  it("status text covers live, manual and the clock fallback", () => {
    expect(statusText("live", "autumn", "Mainly clear")).toBe("Live · Mainly clear");
    expect(statusText("manual", "clear")).toBe("Manual · Sunrise");
    expect(statusText("fallback", "midnight")).toBe("Live · no data, following the clock");
  });

  it("effects controls: shown only when they fit; the device note only when particles are suppressed", () => {
    expect(html({ fit: { days: 7, showEffects: false } })).not.toContain('aria-label="Weather effects"');
    const on = html();
    expect(on).toContain('role="switch" aria-checked="true" aria-label="Weather effects"');
    expect(on).toContain('aria-label="Effects intensity"');
    expect(on).not.toContain("Particles are off on this device");
    expect(html({ particlesSuppressed: true })).toContain("Particles are off on this device (performance).");
    expect(html({ effects: { enabled: false, intensity: "high" } })).toContain('aria-checked="false" aria-label="Weather effects"');
  });

  it("error state: the message and a retry, no temperature", () => {
    const out = html({ now: null, forecast: [], error: "Location denied — set one in Settings" });
    expect(out).toContain("Location denied — set one in Settings");
    expect(out).toContain('aria-label="Retry weather"');
    expect(out).not.toContain("wind ");
    expect(html({ now: null, forecast: [] })).toContain("Fetching conditions…");
  });

  it("current conditions: rounded °C, label, wind", () => {
    const out = html();
    expect(out).toContain(">-2°<");
    expect(out).toContain("Snow");
    expect(out).toContain("wind 14 km/h");
  });
});
