import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRESET_MODES, effectiveOf, type ModeOverrides } from "@/features/modes/modes";
import { ModePanelView, type ModePanelViewProps } from "./ModePanel";
import def from "./index";

const noop = () => undefined;
const props = (over: Partial<ModePanelViewProps> & { activeId?: string; overrides?: ModeOverrides } = {}): ModePanelViewProps => {
  const activeId = over.activeId ?? "brainstorm";
  const overrides = over.overrides ?? {};
  return {
    modes: PRESET_MODES,
    activeId,
    effective: effectiveOf(PRESET_MODES, activeId, overrides),
    overrides,
    gabagoolOn: false,
    size: { w: 3, h: 2 },
    onSelect: noop,
    onToggleNovelty: noop,
    onOverride: noop,
    onReset: noop,
    onManage: noop,
    ...over,
  };
};
const render = (p: ModePanelViewProps) => renderToStaticMarkup(createElement(ModePanelView, p));
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
/** The "Tony mode" radiogroup's inner HTML (up to its closing div; the radios hold no divs). */
const group = (html: string) => {
  const start = html.indexOf('role="radiogroup" aria-label="Tony mode"');
  return html.slice(start, html.indexOf("</div>", start));
};

describe("ModePanelView", () => {
  it("{3,2}: one Tony mode radiogroup of 5 work radios, one checked, the novelty as a switch outside it, no dials", () => {
    const html = render(props());
    expect(count(html, /aria-label="Tony mode"/g)).toBe(1);
    const g = group(html);
    expect(count(g, /role="radio"/g)).toBe(5);
    expect(count(g, /aria-checked="true"/g)).toBe(1);
    expect(g).toContain('aria-label="Brainstorming"');
    expect(g).not.toContain("Gabagool");
    expect(count(html, /role="switch"/g)).toBe(1);
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Gabagool Mode/);
    expect(html).not.toContain("Tony mode curiosity");
    expect(html).not.toContain("Reset to mode default");
    expect(html).toContain("Applies from Tony&#x27;s next turn");
  });

  it("{3,3} with a curiosity override: High checked, Reset and the OVERRIDE chip shown", () => {
    const html = render(props({ activeId: "surface", overrides: { curiosity: "high" }, size: { w: 3, h: 3 } }));
    expect(html).toMatch(/aria-label="Tony mode curiosity"[^]*?aria-checked="true"[^>]*>High</);
    expect(html).toContain("Reset to mode default");
    expect(html).toContain(">Override<");
    // Surface's dispatch is Solo.
    expect(html).toMatch(/aria-label="Tony mode dispatch"[^]*?aria-checked="true"[^>]*>Solo</);
  });

  it("{3,3} without overrides: no Reset, no OVERRIDE chip", () => {
    const html = render(props({ activeId: "surface", size: { w: 3, h: 3 } }));
    expect(html).toContain("Tony mode curiosity");
    expect(html).not.toContain("Reset to mode default");
    expect(html).not.toContain(">Override<");
  });

  it("w=2: icons only, every button still has an accessible name", () => {
    const html = render(props({ size: { w: 2, h: 2 } }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(6);
    for (const b of buttons) expect(b).toMatch(/aria-label="[^"]+"/);
    expect(group(html)).not.toMatch(/<span class="truncate">/);
  });

  it("h≥4 shows the narration level and Manage modes", () => {
    const html = render(props({ size: { w: 3, h: 4 } }));
    expect(html).toContain("Narration · Milestones");
    expect(html).toContain("Manage modes…");
  });

  it("the novelty on leaves the work mode exactly as it was", () => {
    const off = group(render(props()));
    const html = render(props({ gabagoolOn: true }));
    expect(html).toMatch(/role="switch" aria-checked="true"/);
    expect(group(html)).toBe(off);
  });

  it("no backdrop or glass classes (it paints over the System Map's WebGL)", () => {
    for (const size of [{ w: 2, h: 2 }, { w: 3, h: 4 }, { w: 6, h: 2 }, { w: 6, h: 4 }]) {
      const html = render(props({ size, overrides: { dispatch: "auto_dispatch" } }));
      expect(html).not.toMatch(/backdrop|glass|pill-glass/);
    }
  });

  it("widget definition: Tony Mode, sized 3×2 (2×2 … 6×4), first on the phone, never the novelty word", () => {
    expect(def.id).toBe("tony-mode");
    expect(def.title).toBe("Tony Mode");
    expect(def.defaultSize).toEqual({ w: 3, h: 2 });
    expect(def.minSize).toEqual({ w: 2, h: 2 });
    expect(def.maxSize).toEqual({ w: 6, h: 4 });
    expect(def.compactOrder).toBe(1);
    expect(JSON.stringify(def.keywords).toLowerCase()).not.toContain("gabagool");
  });

  it("source guard: ModePanel.tsx carries no backdrop or pill-glass", () => {
    const src = readFileSync(fileURLToPath(new URL("./ModePanel.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/backdrop-|pill-glass|glass-thin|className="[^"]*\bglass\b/);
  });
});
