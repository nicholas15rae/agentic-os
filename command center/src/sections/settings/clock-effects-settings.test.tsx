// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SSR renders read a zustand store's initial state, so the settings store is a plain stand-in here.
const h = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/stores/settings", () => ({
  useSettings: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state, subscribe: () => () => undefined }),
}));

import { ClockCard, EffectsCard } from "./ClockEffectsSettings";

const setState = (p: Record<string, unknown>) => Object.assign(h.state, p);

describe("Settings → Appearance: clock and effects cards", () => {
  beforeEach(() => {
    setState({ set: vi.fn(), weatherMode: "auto", effects: { enabled: true, intensity: "normal" }, clock: { hourCycle: "h12", showDate: true, showTemp: true } });
  });

  it("clock card: 12 h default checked, date and temperature switches on", () => {
    const html = renderToStaticMarkup(createElement(ClockCard));
    expect(html).toContain("Top bar clock");
    expect(html).toMatch(/role="radiogroup" aria-label="Time format"/);
    expect(html).toMatch(/aria-checked="true"[^>]*>12 h</);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Show date"/);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Show temperature"/);
  });

  it("effects card: live shows no Back to Live; the Android note is in the hint", () => {
    const html = renderToStaticMarkup(createElement(EffectsCard));
    expect(html).toContain("Weather effects");
    expect(html).toContain("always off in the Android app and the phone HUD");
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Effects on"/);
    expect(html).not.toContain("Back to Live");
  });

  it("effects card: a manual atmosphere shows Manual and Back to Live; off disables intensity", () => {
    setState({ weatherMode: "rain", effects: { enabled: false, intensity: "high" } });
    const html = renderToStaticMarkup(createElement(EffectsCard));
    expect(html).toContain("Manual · Rain");
    expect(html).toContain("Back to Live");
    expect(html).toMatch(/aria-label="Effects intensity" aria-disabled="true"/);
  });
});
