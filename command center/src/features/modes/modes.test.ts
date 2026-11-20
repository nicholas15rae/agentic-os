import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as M from "./modes";

/** Phase 2 Part C: the TS mirror of modes.rs stays byte-identical where it matters. */
const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/modes.rs"), "utf8");
const rustConst = (name: string): string => {
  const m = new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(rs);
  if (!m) throw new Error(`no Rust const ${name}`);
  return m[1];
};

const PROMPT_CONSTS = ["CURIOSITY_LOW", "CURIOSITY_MEDIUM", "CURIOSITY_HIGH", "VERBOSITY_TERSE", "VERBOSITY_CONVERSATIONAL", "DISPATCH_SOLO", "DISPATCH_AUTO", "BRAINSTORM_NOTES", "COACH_NOTES"] as const;

describe("prompt constants mirror modes.rs", () => {
  it.each(PROMPT_CONSTS)("%s is identical to the Rust constant", (name) => {
    expect(M[name]).toBe(rustConst(name));
  });

  it("no constant or preset names the format word, the thinking switch or the novelty word", () => {
    for (const name of PROMPT_CONSTS) {
      const l = M[name].toLowerCase();
      expect(l, name).not.toContain("json");
      expect(l, name).not.toContain("/no_think");
      expect(l, name).not.toContain("gabagool");
    }
    for (const m of M.PRESET_MODES) {
      const block = M.modeBlock(M.effectiveOf(M.PRESET_MODES, m.id)).toLowerCase();
      expect(block, m.id).not.toContain("json");
      expect(block, m.id).not.toContain("/no_think");
      expect(block, m.id).not.toContain("gabagool");
      expect(Array.from(block).length, m.id).toBeLessThanOrEqual(M.MODE_BLOCK_MAX);
    }
  });

  it("the preset ids, order and dials match BUILTIN_IDS / presets() in Rust", () => {
    expect(rs).toContain(`pub const BUILTIN_IDS: [&str; 6] = [${M.BUILTIN_MODE_IDS.map((i) => `"${i}"`).join(", ")}];`);
    expect(M.PRESET_MODES.map((m) => m.id)).toEqual([...M.BUILTIN_MODE_IDS]);
    const row = (id: string) => M.PRESET_MODES.find((m) => m.id === id)!;
    expect(row("surface")).toMatchObject({ curiosity_level: "medium", verbosity: "balanced", agent_dispatch_policy: "surface_only", tts_interrupt_level: "silent", icon: "message-circle" });
    expect(row("brainstorm")).toMatchObject({ curiosity_level: "high", verbosity: "conversational", agent_dispatch_policy: "ask_before_dispatch", tts_interrupt_level: "milestones_only" });
    expect(row("builder")).toMatchObject({ curiosity_level: "medium", agent_dispatch_policy: "auto_dispatch", tts_interrupt_level: "full" });
    expect(row("executive")).toMatchObject({ curiosity_level: "low", verbosity: "terse", agent_dispatch_policy: "ask_before_dispatch" });
    expect(row("coach")).toMatchObject({ curiosity_level: "medium", agent_dispatch_policy: "surface_only", prompt_modifier: M.COACH_NOTES });
    expect(row("gabagool")).toMatchObject({ is_novelty: true, agent_dispatch_policy: "surface_only" });
    for (const m of M.PRESET_MODES) {
      if (m.id === M.NOVELTY_MODE_ID) expect(rs).toContain('preset(NOVELTY_ID, "Gabagool Mode", "\\u{1F35D}"');
      else expect(rs, m.id).toContain(`preset("${m.id}", "${m.name}", "${m.icon}"`);
    }
    expect(M.DEFAULT_EFFECTIVE.mode_id).toBe("brainstorm");
    expect(rs).toContain(`pub const DEFAULT_MODE_ID: &str = "${M.DEFAULT_MODE_ID}";`);
  });
});

describe("modeBlock (the curiosity dial)", () => {
  const eff = (id: string, o: M.ModeOverrides = {}) => M.effectiveOf(M.PRESET_MODES, id, o);

  it("swaps exactly the CURIOSITY line and is deterministic", () => {
    const low = M.modeBlock(eff("executive"));
    const high = M.modeBlock(eff("executive", { curiosity: "high" }));
    expect(low).toContain("1–2 sentences");
    expect(low).toContain("no follow-up questions");
    expect(M.modeBlock(eff("executive", { curiosity: "medium" }))).toContain("at most 1");
    expect(high).toContain("edge cases");
    expect(high).toContain("1–2 creative angles");
    const a = low.split("\n");
    const b = high.split("\n");
    expect(a.filter((l, i) => l !== b[i])).toEqual([M.CURIOSITY_LOW]);
    expect(M.modeBlock(eff("executive"))).toBe(low);
  });

  it("matches the Rust layout: header, dial lines, then the notes", () => {
    expect(M.modeBlock(eff("brainstorm"))).toBe(`\n\nMODE: Brainstorming. These MODE rules override the STYLE length rule.\n${M.CURIOSITY_HIGH}\n${M.VERBOSITY_CONVERSATIONAL}\nMODE NOTES: ${M.BRAINSTORM_NOTES}`);
    expect(M.modeBlock(eff("surface"))).toBe(`\n\nMODE: Surface / Solo. These MODE rules override the STYLE length rule.\n${M.CURIOSITY_MEDIUM}\n${M.DISPATCH_SOLO}`);
    expect(M.modeBlock(eff("builder"))).toContain(M.DISPATCH_AUTO);
    expect(M.modeBlock(eff("gabagool"))).toBe("");
    expect(rs).toContain('"\\n\\nMODE: {}. These MODE rules override the STYLE length rule."');
  });

  it("a 280-char note on the busiest dials is clipped to the 700-char cap", () => {
    const e: M.EffectiveMode = { ...eff("surface", { curiosity: "high", verbosity: "conversational" }), name: "N".repeat(32), prompt_modifier: "x".repeat(280) };
    const block = M.modeBlock(e);
    expect(Array.from(block).length).toBeLessThanOrEqual(700);
    expect(block).toContain("MODE NOTES: xxx");
  });
});

describe("tts_interrupt_level → narration (D17)", () => {
  it("silent 0 · milestones_only 1 · full 2, overrides win", () => {
    expect([M.feedbackFor("silent"), M.feedbackFor("milestones_only"), M.feedbackFor("full")]).toEqual([0, 1, 2]);
    expect(M.effectiveOf(M.PRESET_MODES, "builder").feedback_level).toBe(2);
    expect(M.effectiveOf(M.PRESET_MODES, "surface").feedback_level).toBe(0);
    const e = M.effectiveOf(M.PRESET_MODES, "builder", { feedback: 3, curiosity: "low" });
    expect(e.feedback_level).toBe(3);
    expect(e.overridden).toEqual(["curiosity", "feedback"]);
    expect(M.effectiveOf(M.PRESET_MODES, "nope").mode_id).toBe("brainstorm");
  });
});

describe("tier3Action truth table", () => {
  const pipeline = { kind: "pipeline" } as const;
  const agent = { kind: "agent", role: "designer" } as const;
  it.each([
    ["surface_only", pipeline, "solo"],
    ["surface_only", agent, "solo"],
    ["ask_before_dispatch", pipeline, "offer"],
    ["ask_before_dispatch", agent, "offer"],
    ["auto_dispatch", pipeline, "auto"],
    ["auto_dispatch", agent, "offer"],
  ] as const)("%s + %o → %s", (dispatch, target, want) => {
    expect(M.tier3Action({ dispatch }, target)).toBe(want);
  });
});

describe("calmModeError", () => {
  it("maps the Rust refusal prefixes to Tony's lines", () => {
    expect(M.calmModeError("MODE_SURFACE_ONLY: Solo mode is on; nothing was queued.")).toBe(M.SOLO_REFUSAL_LINE);
    expect(M.calmModeError("Error: MODE_NOT_AUTO: only Builder mode queues a build without your yes; nothing was queued.")).toBe(M.NOT_AUTO_REFUSAL_LINE);
    expect(M.calmModeError("all providers failed")).toBeNull();
    // The Rust messages carry the exact prefixes the map keys on.
    expect(rs).toContain('format!("{MODE_SURFACE_ONLY}: Solo mode is on; nothing was queued.")');
    expect(rs).toContain(`pub const MODE_SURFACE_ONLY: &str = "${M.MODE_SURFACE_ONLY}";`);
    expect(rs).toContain(`pub const MODE_NOT_AUTO: &str = "${M.MODE_NOT_AUTO}";`);
  });
});

describe("viewFromMirror (phone)", () => {
  it("rebuilds the effective state and the overrides from the mirror", () => {
    const v = M.viewFromMirror({
      id: "executive",
      name: "Executive",
      icon: "briefcase",
      curiosity: "high",
      verbosity: "terse",
      dispatch: "ask_before_dispatch",
      feedbackLevel: 1,
      overridden: ["curiosity"],
      list: M.PRESET_MODES.map((m) => ({ id: m.id, name: m.name, icon: m.icon, isNovelty: m.is_novelty })),
    });
    expect(v.active_mode_id).toBe("executive");
    expect(v.effective.curiosity).toBe("high");
    expect(v.overrides).toEqual({ curiosity: "high" });
    expect(v.modes).toHaveLength(6);
    expect(v.modes[3]).toEqual(M.PRESET_MODES[3]);
  });
});
