import { describe, expect, it } from "vitest";
import { feedbackLevel } from "@/features/voice/narrator";
import { PRESET_MODES, MODIFIER_MAX, isBuiltinMode, type TonyMode } from "./modes";
import {
  CURIOSITY_OPTS,
  DISPATCH_OPTS,
  MODE_ICON_NAMES,
  TTS_OPTS,
  VERBOSITY_OPTS,
  bannedWord,
  canDelete,
  duplicateMode,
  effectiveMode,
  isOverridden,
  modifierCount,
  newModeDraft,
  panelLayout,
  switchboardSummary,
  switcherModes,
  toggleOverlayItem,
  ttsToFeedback,
  uniqueModeId,
  validateModeDraft,
  validateSwitchboard,
  withOverlay,
} from "./mode-ui";

const preset = (id: string) => PRESET_MODES.find((m) => m.id === id)!;
const custom = (over: Partial<TonyMode> = {}): TonyMode => ({ ...preset("surface"), id: "focus", name: "Focus", icon: "flame", prompt_modifier: "Stay on task.", ...over });

describe("mode-ui", () => {
  it("maps tts levels to the narration levels the narrator accepts", () => {
    expect(TTS_OPTS.map((o) => ttsToFeedback(o.id))).toEqual([0, 1, 2]);
    for (const o of TTS_OPTS) {
      const lvl = ttsToFeedback(o.id);
      expect(feedbackLevel({ feedback: { sensitivity: lvl, narrationEngine: "roster" } })).toBe(lvl);
    }
  });

  it("option arrays cover every enum value, and Auto says what still asks", () => {
    expect(CURIOSITY_OPTS.map((o) => o.id)).toEqual(["low", "medium", "high"]);
    expect(VERBOSITY_OPTS.map((o) => o.id)).toEqual(["terse", "balanced", "conversational"]);
    expect(DISPATCH_OPTS.map((o) => [o.id, o.label, o.tone])).toEqual([
      ["surface_only", "Solo", "teal"],
      ["ask_before_dispatch", "Ask", "amber"],
      ["auto_dispatch", "Auto", "alert"],
    ]);
    expect(DISPATCH_OPTS[2].hint).toContain("emails/messages/calendar still ask");
    expect(MODE_ICON_NAMES).toEqual(["message-circle", "lightbulb", "hammer", "clipboard-list", "briefcase", "flame", "graduation-cap", "sparkles"]);
  });

  it("effectiveMode applies the dial overrides and leaves the mode's identity and rules alone", () => {
    const m = preset("brainstorm");
    const e = effectiveMode(m, { curiosity: "low", dispatch: "surface_only" });
    expect(e.curiosity).toBe("low");
    expect(e.dispatch).toBe("surface_only");
    expect(e.verbosity).toBe(m.verbosity);
    expect(e.name).toBe(m.name);
    expect(e.prompt_modifier).toBe(m.prompt_modifier);
    expect(e.feedback_level).toBe(1);
    expect(e.overridden).toEqual(["curiosity", "dispatch"]);
    expect(effectiveMode(m).curiosity).toBe("high");
  });

  it("isOverridden", () => {
    expect(isOverridden({})).toBe(false);
    expect(isOverridden(null)).toBe(false);
    expect(isOverridden({ curiosity: "low" })).toBe(true);
    expect(isOverridden({ feedback: 3 })).toBe(true);
  });

  it("switcherModes never puts the novelty in the work group", () => {
    const { work, novelty } = switcherModes([...PRESET_MODES, custom()]);
    expect(work.map((m) => m.id)).toEqual(["surface", "brainstorm", "builder", "operations", "executive", "coach", "learning", "focus"]);
    expect(novelty.map((m) => m.id)).toEqual(["gabagool"]);
    expect(work.some((m) => m.is_novelty)).toBe(false);
  });

  it("duplicateMode: unique id and name (copy, then copy 2), never a preset, source untouched", () => {
    const src = preset("builder");
    const snapshot = JSON.stringify(src);
    const a = duplicateMode(PRESET_MODES, src);
    expect(a.name).toBe("Builder copy");
    expect(a.id).toBe("builder-copy");
    expect(isBuiltinMode(a.id)).toBe(false);
    expect(a.is_novelty).toBe(false);
    expect([a.curiosity_level, a.verbosity, a.agent_dispatch_policy, a.tts_interrupt_level, a.icon]).toEqual([src.curiosity_level, src.verbosity, src.agent_dispatch_policy, src.tts_interrupt_level, src.icon]);
    const b = duplicateMode([...PRESET_MODES, a], src);
    expect(b.name).toBe("Builder copy 2");
    expect(b.id).toBe("builder-copy-2");
    expect(JSON.stringify(src)).toBe(snapshot);
  });

  it("uniqueModeId mirrors the Rust slug rules", () => {
    expect(uniqueModeId(PRESET_MODES, "My Focus!")).toBe("my-focus");
    expect(uniqueModeId(PRESET_MODES, "Builder")).toBe("builder-2");
    expect(uniqueModeId(PRESET_MODES, "42 things")).toBe("mode-42-things");
    expect(uniqueModeId(PRESET_MODES, "")).toBe("mode");
  });

  it("newModeDraft starts from the Surface defaults with a fresh id", () => {
    const d = newModeDraft(PRESET_MODES);
    expect(d.agent_dispatch_policy).toBe("surface_only");
    expect(d.is_novelty).toBe(false);
    expect(isBuiltinMode(d.id)).toBe(false);
    expect(validateModeDraft(d)).toBeNull();
    const d2 = newModeDraft([...PRESET_MODES, d]);
    expect(d2.id).not.toBe(d.id);
    expect(d2.name).toBe("New mode 2");
  });

  it("canDelete: never a preset, never the active mode", () => {
    expect(canDelete(preset("coach"), "brainstorm")).toBe(false);
    expect(canDelete(preset("gabagool"), "brainstorm")).toBe(false);
    expect(canDelete(custom(), "focus")).toBe(false);
    expect(canDelete(custom(), "brainstorm")).toBe(true);
  });

  it("validateModeDraft rejects what Rust rejects", () => {
    expect(validateModeDraft(custom())).toBeNull();
    expect(validateModeDraft(custom({ name: "   " }))).toMatch(/Name/);
    expect(validateModeDraft(custom({ name: "x".repeat(33) }))).toMatch(/Name/);
    expect(validateModeDraft(custom({ name: "x".repeat(32) }))).toBeNull();
    expect(validateModeDraft(custom({ prompt_modifier: "y".repeat(MODIFIER_MAX + 1) }))).toMatch(/at most 280/);
    expect(validateModeDraft(custom({ prompt_modifier: "y".repeat(MODIFIER_MAX) }))).toBeNull();
    expect(validateModeDraft(custom({ prompt_modifier: "Reply in JSON please" }))).toMatch(/json/);
    expect(validateModeDraft(custom({ prompt_modifier: "be quick /no_think" }))).toMatch(/no_think/);
    expect(validateModeDraft(custom({ name: "Gabagool time" }))).toMatch(/gabagool/);
    expect(validateModeDraft(custom({ prompt_modifier: "line one\nline two" }))).toMatch(/one line/);
    expect(validateModeDraft(custom({ icon: "" }))).toMatch(/Icon/);
    expect(bannedWord("Json")).toBe("json");
    expect(bannedWord("fine")).toBeNull();
  });

  it("modifierCount counts characters, not UTF-16 units", () => {
    expect(modifierCount("")).toBe("0/280");
    expect(modifierCount("ok \u{1F35D}")).toBe("4/280");
  });

  it("panelLayout: 2 columns to w=3, a scroll row at w≥4·h=2, else 3 columns", () => {
    expect(panelLayout({ w: 2, h: 2 })).toEqual({ grid: "cols-2", iconsOnly: true, dials: false, footer: false });
    expect(panelLayout({ w: 3, h: 2 }).grid).toBe("cols-2");
    expect(panelLayout({ w: 4, h: 2 }).grid).toBe("row");
    expect(panelLayout({ w: 6, h: 3 })).toEqual({ grid: "cols-3", iconsOnly: false, dials: true, footer: false });
    expect(panelLayout({ w: 3, h: 4 }).footer).toBe(true);
  });
});

describe("switchboard overlay editing (custom modes)", () => {
  it("withOverlay starts from everything (no Tony, no always-live server, Rust caps), or clears to none", () => {
    const m = custom();
    const on = withOverlay(m, true, { agents: ["general", "coder", "bizops"], tools: ["time", "git"] });
    expect(on.switchboard).toEqual({ agents: ["coder", "bizops"], tools: ["git"] });
    const many = withOverlay(m, true, { agents: [], tools: Array.from({ length: 20 }, (_, i) => `s${i}`) });
    expect(many.switchboard!.tools).toHaveLength(16);
    expect(validateModeDraft(many)).toBeNull();
    expect(withOverlay(on, false, { agents: [], tools: [] }).switchboard).toBeNull();
    expect(m.switchboard).toBeUndefined();
  });

  it("toggleOverlayItem flips one agent or tool, never touching the source", () => {
    const m = custom({ switchboard: { agents: ["coder"], tools: ["git"] } });
    expect(toggleOverlayItem(m, "agents", "coder").switchboard).toEqual({ agents: [], tools: ["git"] });
    expect(toggleOverlayItem(m, "tools", "fetch").switchboard).toEqual({ agents: ["coder"], tools: ["git", "fetch"] });
    expect(m.switchboard).toEqual({ agents: ["coder"], tools: ["git"] });
    expect(toggleOverlayItem(custom(), "agents", "coder")).toEqual(custom());
  });

  it("duplicating a preset keeps its switchboard; a new mode has none", () => {
    expect(duplicateMode(PRESET_MODES, preset("operations")).switchboard).toEqual(preset("operations").switchboard);
    expect(newModeDraft(PRESET_MODES).switchboard ?? null).toBeNull();
    expect(switchboardSummary(preset("operations"))).toBe("1 agent · 10 tools on duty; the rest are frozen");
    expect(switchboardSummary(custom({ switchboard: { agents: ["coder"], tools: [] } }))).toBe("1 agent · 0 tools on duty; the rest are frozen");
  });
});

describe("validateSwitchboard (mirrors modes::validate_mode)", () => {
  it("caps each list at 16, refuses Tony, bad ids and banned words", () => {
    expect(validateSwitchboard(null)).toBeNull();
    expect(validateSwitchboard({ agents: ["coder"], tools: ["git", "brave-search"] })).toBeNull();
    expect(validateSwitchboard({ agents: Array.from({ length: 17 }, (_, i) => `a${i}`), tools: [] })).toMatch(/at most 16/);
    expect(validateSwitchboard({ agents: ["tony"], tools: [] })).toMatch(/never Tony/);
    expect(validateSwitchboard({ agents: ["Coder!"], tools: [] })).toMatch(/sub-agent id/);
    expect(validateSwitchboard({ agents: ["gabagool"], tools: [] })).toMatch(/sub-agent id/);
    expect(validateSwitchboard({ agents: [], tools: ["bad id"] })).toMatch(/MCP server id/);
    expect(validateModeDraft(custom({ switchboard: { agents: ["general"], tools: [] } }))).toMatch(/never Tony/);
  });
});
