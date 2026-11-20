import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hudMicChips, isMicOff, micIndicator } from "./mic-indicator";
import { MicButtonView, MicLockBadgeView } from "./MicLockBadge";

const noop = () => undefined;

describe("micIndicator", () => {
  it("truth table: a voice state can never fake a live mic while the gate is off", () => {
    expect(micIndicator(false, 0, "listening")).toBe("locked");
    expect(micIndicator(false, 0, "transcribing")).toBe("locked");
    expect(micIndicator(false, 0, "idle")).toBe("locked");
    for (const s of ["idle", "listening", "speaking", null]) expect(micIndicator(false, 1, s)).toBe("leak");
    expect(micIndicator(true, 1, "idle")).toBe("live");
    expect(micIndicator(true, 0, "listening")).toBe("live");
    expect(micIndicator(true, 0, "idle")).toBe("armed");
    expect(micIndicator(true, 0, "speaking")).toBe("armed");
    expect([isMicOff("locked"), isMicOff("leak"), isMicOff("live"), isMicOff("armed")]).toEqual([true, true, false, false]);
  });

  it("phone HUD chips: the phone's own lock, and the desktop's from the mirror", () => {
    expect(hudMicChips(true, true, false)).toEqual([]);
    expect(hudMicChips(true, undefined, false)).toEqual([]);
    expect(hudMicChips(false, true, false)).toEqual(["MIC LOCKED"]);
    expect(hudMicChips(false, false, false)).toEqual(["MIC LOCKED", "DESK MIC OFF"]);
    // On the desktop the HUD's own gate IS the desk mic.
    expect(hudMicChips(false, false, true)).toEqual(["MIC LOCKED"]);
  });
});

describe("MicLockBadgeView", () => {
  const badge = (kind: Parameters<typeof MicLockBadgeView>[0]["kind"], variant: "chip" | "dot" | "button" = "chip", flash = false) =>
    renderToStaticMarkup(createElement(MicLockBadgeView, { kind, variant, flash, onToggle: noop }));

  it("locked: a static red MIC OFF status (never animated, no glass)", () => {
    const html = badge("locked");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Mic locked off"');
    expect(html).toContain("MIC OFF");
    expect(html).toContain("bg-alert/15");
    expect(html).toContain("border-alert/50");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toMatch(/backdrop|glass/);
    // The locked dot (top bar) is static as well.
    const dot = badge("locked", "dot");
    expect(dot).toContain('role="status"');
    expect(dot).not.toContain("animate-pulse");
  });

  it("a flash is a ring, not an animation", () => {
    const html = badge("locked", "chip", true);
    expect(html).toContain("ring-2 ring-alert");
    expect(html).not.toContain("animate-pulse");
  });

  it("leak: MIC STILL OPEN, solid alert and pulsing", () => {
    const html = badge("leak");
    expect(html).toContain("MIC STILL OPEN");
    expect(html).toContain("bg-alert text-white animate-pulse");
    expect(badge("leak", "dot")).toContain("animate-pulse");
  });

  it("live shows the teal dot, armed an ink-3 mic", () => {
    expect(badge("live", "dot")).toContain("bg-teal");
    expect(badge("armed", "dot")).toContain("text-ink-3");
  });

  it("the button variant is a switch: off = locked", () => {
    expect(badge("locked", "button")).toMatch(/role="switch" aria-checked="false" aria-label="Mic locked off: tap to unlock"/);
    expect(badge("armed", "button")).toMatch(/role="switch" aria-checked="true"/);
  });
});

describe("MicButtonView", () => {
  it("locked: aria-disabled, alert-toned, says how to unlock", () => {
    const html = renderToStaticMarkup(createElement(MicButtonView, { state: "idle", locked: true, onClick: noop }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("border-alert/50 bg-alert/10 text-alert");
    expect(html).toContain('aria-label="Mic locked off: tap to unlock"');
    expect(html).not.toContain("glow-teal");
  });

  it("unlocked keeps today's faces", () => {
    expect(renderToStaticMarkup(createElement(MicButtonView, { state: "idle", locked: false, onClick: noop }))).toContain('aria-label="Start listening"');
    const live = renderToStaticMarkup(createElement(MicButtonView, { state: "listening", locked: false, onClick: noop }));
    expect(live).toContain('aria-label="Stop listening"');
    expect(live).not.toContain("aria-disabled");
  });
});
