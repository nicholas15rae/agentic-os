import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRESET_MODES, effectiveOf } from "./modes";
import { ModePillView, ModePopoverView, POPOVER_W, popoverPosition } from "./ModePill";
import { ModeStripView } from "./ModeStrip";

const noop = () => undefined;
const eff = effectiveOf(PRESET_MODES, "builder");

describe("ModePill", () => {
  it("the trigger opens a popup and names Tony; the novelty segment is a switch", () => {
    const html = renderToStaticMarkup(createElement(ModePillView, { effective: eff, overridden: false, gabagoolOn: false, open: false, onOpen: noop, onToggleNovelty: noop }));
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-label="Tony mode"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Gabagool Mode"/);
    expect(html).toContain("Builder");
    // No amber override dot.
    expect(html).not.toContain("bg-amber");
  });

  it("an override shows the amber dot; the novelty on lights its segment only", () => {
    const html = renderToStaticMarkup(createElement(ModePillView, { effective: eff, overridden: true, gabagoolOn: true, open: true, onOpen: noop, onToggleNovelty: noop }));
    expect(html).toContain("rounded-full bg-amber");
    expect(html).toMatch(/role="switch" aria-checked="true"/);
    expect(html).toContain('aria-expanded="true"');
  });

  it("the popover is an opaque dialog with the full panel and no backdrop or glass", () => {
    const html = renderToStaticMarkup(
      createElement(ModePopoverView, {
        modes: PRESET_MODES,
        activeId: "builder",
        effective: eff,
        overrides: {},
        gabagoolOn: false,
        onSelect: noop,
        onToggleNovelty: noop,
        onOverride: noop,
        onReset: noop,
        onManage: noop,
      }),
    );
    expect(html).toMatch(/^<div role="dialog" aria-label="Tony mode"/);
    expect(html).toContain("bg-[rgba(11,13,17,0.94)]");
    expect(html).toContain("Tony mode curiosity");
    expect(html).toContain("Manage modes…");
    expect(html).not.toMatch(/backdrop|glass/);
  });

  it("popoverPosition sits under the trigger, right-aligned, inside the viewport", () => {
    expect(popoverPosition({ left: 900, right: 1000, bottom: 50 }, 1400)).toEqual({ top: 58, left: 1000 - POPOVER_W });
    expect(popoverPosition({ left: 10, right: 60, bottom: 50 }, 1400).left).toBe(8);
    expect(popoverPosition({ left: 1300, right: 1400, bottom: 50 }, 1400).left).toBe(1400 - POPOVER_W - 8);
  });

  it("source guard: the pill and the panel never carry a backdrop filter or pill-glass", () => {
    for (const rel of ["./ModePill.tsx", "../../widgets/tony-mode/ModePanel.tsx", "./ModeStrip.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src, rel).not.toMatch(/backdrop-|pill-glass/);
    }
  });
});

describe("ModeStripView (phone HUD)", () => {
  const strip = (over: Partial<Parameters<typeof ModeStripView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ModeStripView, { modes: PRESET_MODES, activeId: "executive", curiosity: "low", overridden: false, onSelect: noop, onCuriosity: noop, onReset: noop, ...over }),
    );

  it("work chips only, teal when active, in a Tony mode radiogroup", () => {
    const html = strip();
    expect(html).toContain('role="radiogroup" aria-label="Tony mode"');
    expect((html.match(/role="radio" aria-checked="(true|false)" aria-label="[^"]+"/g) ?? []).length).toBe(5);
    expect(html).toMatch(/aria-checked="true" aria-label="Executive"[^>]*border-teal\/60 bg-teal\/15/);
    expect(html).not.toContain("Gabagool");
    expect(html).toMatch(/aria-label="Tony mode curiosity"[^]*?aria-checked="true"[^>]*>Low</);
    expect(html).not.toContain(">Reset<");
  });

  it("Reset appears only when overridden", () => {
    expect(strip({ overridden: true })).toMatch(/Reset<\/button>/);
  });
});
