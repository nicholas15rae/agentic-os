import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRESET_MODES, type TonyMode } from "@/features/modes/modes";
import { ModeRow, type ModeRowProps } from "./ModesManager";

const noop = () => undefined;
const preset = (id: string) => PRESET_MODES.find((m) => m.id === id)!;
const focus: TonyMode = { ...preset("surface"), id: "focus", name: "Focus", icon: "flame", prompt_modifier: "Stay on the build.", agent_dispatch_policy: "ask_before_dispatch" };
const row = (over: Partial<ModeRowProps>) =>
  renderToStaticMarkup(createElement(ModeRow, { mode: focus, isActive: false, deletable: true, onUse: noop, onDuplicate: noop, onDelete: noop, onSave: noop, onOpenVoice: noop, ...over }));
const fieldset = (html: string) => html.match(/<fieldset[^>]*>/)?.[0] ?? "";

describe("ModeRow (Settings → Tony Modes)", () => {
  it("a preset: PRESET chip, Duplicate, no Delete, body disabled with the duplicate hint", () => {
    const html = row({ mode: preset("executive"), deletable: false });
    expect(html).toContain(">Preset<");
    expect(html).toContain("Duplicate");
    expect(html).not.toContain('aria-label="Delete');
    expect(fieldset(html)).toMatch(/ disabled=""/);
    expect(html).toContain("Preset: duplicate to customise.");
    // Its name is text, not an input.
    expect(html).not.toContain('aria-label="Mode name"');
    // The four dials are all present (read-only).
    for (const l of ["Curiosity", "Verbosity", "Agent dispatch policy", "Narration"]) expect(html).toContain(`role="radiogroup" aria-label="${l}"`);
  });

  it("an inactive custom mode: Use, Delete, editable body and a correct n/280 counter", () => {
    const html = row({});
    expect(html).toContain('aria-label="Delete Focus"');
    expect(html).toContain(">Use<");
    expect(fieldset(html)).not.toMatch(/ disabled=""/);
    expect(html).toContain('aria-label="Mode name"');
    expect(html).toContain('maxLength="280"');
    expect(html).toContain(`>${Array.from(focus.prompt_modifier).length}/280<`);
    expect(html).toContain("Behaviour rules (injected into Tony&#x27;s prompt)");
    expect(html).toMatch(/aria-label="Agent dispatch policy"[^]*?aria-checked="true"[^>]*>Ask</);
    expect(html).not.toContain(">Preset<");
  });

  it("the active custom mode: Active chip, no Use, no Delete", () => {
    const html = row({ isActive: true, deletable: false });
    expect(html).toContain(">Active<");
    expect(html).not.toContain(">Use<");
    expect(html).not.toContain('aria-label="Delete');
  });

  it("the novelty: NOVELTY chip and the Voice & Triggers link, no dials, no Use, no Duplicate", () => {
    const html = row({ mode: preset("gabagool"), deletable: false });
    expect(html).toContain(">Novelty<");
    expect(html).toContain("Configure sound &amp; phrases → Voice &amp; Triggers");
    expect(html).not.toContain("role=\"radiogroup\"");
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain(">Use<");
    expect(html).not.toContain("Duplicate");
  });

  it("no backdrop or glass in a row", () => {
    for (const m of [preset("builder"), focus, preset("gabagool")]) expect(row({ mode: m })).not.toMatch(/backdrop|glass/);
  });
});
