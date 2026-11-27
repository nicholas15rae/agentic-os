import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as M from "./modes";

/** Phase 2 Part C: the TS mirror of modes.rs stays byte-identical where it matters. */
const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/modes.rs"), "utf8");
const agentsRs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/agents.rs"), "utf8");
const rustConst = (name: string): string => {
  const m = new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(rs);
  if (!m) throw new Error(`no Rust const ${name}`);
  return m[1];
};

const PROMPT_CONSTS = ["CURIOSITY_LOW", "CURIOSITY_MEDIUM", "CURIOSITY_HIGH", "VERBOSITY_TERSE", "VERBOSITY_CONVERSATIONAL", "DISPATCH_SOLO", "DISPATCH_AUTO", "BRAINSTORM_NOTES", "COACH_NOTES", "LEARNING_PROTOCOL"] as const;

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
    expect(rs).toContain(`pub const BUILTIN_IDS: [&str; 8] = [${M.BUILTIN_MODE_IDS.map((i) => `"${i}"`).join(", ")}];`);
    expect(M.BUILTIN_MODE_IDS.indexOf("operations")).toBe(M.BUILTIN_MODE_IDS.indexOf("builder") + 1);
    expect(M.PRESET_MODES.map((m) => m.id)).toEqual([...M.BUILTIN_MODE_IDS]);
    const row = (id: string) => M.PRESET_MODES.find((m) => m.id === id)!;
    expect(row("surface")).toMatchObject({ curiosity_level: "medium", verbosity: "balanced", agent_dispatch_policy: "surface_only", tts_interrupt_level: "silent", icon: "message-circle" });
    expect(row("brainstorm")).toMatchObject({ curiosity_level: "high", verbosity: "conversational", agent_dispatch_policy: "ask_before_dispatch", tts_interrupt_level: "milestones_only" });
    expect(row("builder")).toMatchObject({ curiosity_level: "medium", agent_dispatch_policy: "auto_dispatch", tts_interrupt_level: "full" });
    expect(row("operations")).toMatchObject({ name: "Operations", icon: "clipboard-list", curiosity_level: "medium", verbosity: "balanced", agent_dispatch_policy: "ask_before_dispatch", tts_interrupt_level: "milestones_only", prompt_modifier: "" });
    expect(row("executive")).toMatchObject({ curiosity_level: "low", verbosity: "terse", agent_dispatch_policy: "ask_before_dispatch", tts_interrupt_level: "milestones_only" });
    expect(row("coach")).toMatchObject({ curiosity_level: "medium", agent_dispatch_policy: "surface_only", prompt_modifier: M.COACH_NOTES });
    expect(row("gabagool")).toMatchObject({ is_novelty: true, agent_dispatch_policy: "surface_only" });
    expect(row("learning")).toMatchObject({ curiosity_level: "high", verbosity: "balanced", agent_dispatch_policy: "surface_only", tts_interrupt_level: "silent", icon: "graduation-cap", prompt_modifier: M.LEARNING_NOTES, night_training: true });
    for (const m of M.PRESET_MODES) {
      if (m.id === M.NOVELTY_MODE_ID) expect(rs).toContain('preset(NOVELTY_ID, "Gabagool Mode", "\\u{1F35D}"');
      else expect(rs, m.id).toContain(`preset("${m.id}", "${m.name}", "${m.icon}"`);
    }
    expect(M.DEFAULT_EFFECTIVE.mode_id).toBe("brainstorm");
    expect(rs).toContain(`pub const DEFAULT_MODE_ID: &str = "${M.DEFAULT_MODE_ID}";`);
    expect(rs).toContain(`pub const MODE_BLOCK_MAX: usize = ${M.MODE_BLOCK_MAX};`);
    expect(rs).toContain(`pub const MODIFIER_MAX: usize = ${M.MODIFIER_MAX};`);
  });
});

describe("switchboard presets mirror modes.rs", () => {
  const row = (id: string) => M.PRESET_MODES.find((m) => m.id === id)!;
  const quoted = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");

  it("the exact on-duty agents and tools per preset (the spec's order)", () => {
    expect(row("builder").switchboard).toEqual({ agents: ["prompter", "designer", "coder"], tools: ["filesystem", "git", "fetch", "brave-search", "knowledge-graph", "time", "weather", "spotify"] });
    expect(row("operations").switchboard).toEqual({ agents: ["bizops"], tools: ["gmail", "calendar", "whatsapp", "knowledge-graph", "filesystem", "maps", "fetch", "time", "weather", "instagram"] });
    // The Librarian runs only as its scheduled script: never on Executive duty.
    expect(row("executive").switchboard).toEqual({ agents: ["bizops", "finance"], tools: ["knowledge-graph", "gmail", "calendar", "brave-search", "time", "weather"] });
    expect(row("learning").switchboard).toEqual({ agents: [], tools: [] });
    for (const id of ["surface", "brainstorm", "coach", "gabagool"]) {
      expect(row(id).switchboard ?? null, id).toBeNull();
      expect(!!row(id).night_training, id).toBe(false);
    }
    expect(M.PRESET_MODES.filter((m) => m.night_training).map((m) => m.id)).toEqual(["learning"]);
  });

  it("the same lists, in the same order, appear in the Rust presets", () => {
    for (const m of M.PRESET_MODES) {
      if (!m.switchboard || m.switchboard.agents.length === 0) continue;
      expect(rs, `${m.id} agents`).toContain(quoted(m.switchboard.agents));
      expect(rs, `${m.id} tools`).toContain(quoted(m.switchboard.tools));
    }
    expect(rs).toContain(`"${M.LEARNING_NOTES}"`);
    expect(rs).toContain(M.ON_DUTY_TAIL);
    expect(rs).toContain("ON DUTY: ");
    for (const t of M.ALWAYS_LIVE_TOOLS) expect(rs, t).toContain(`"${t}"`);
    expect(rs).toContain(`pub const MODE_FROZEN: &str = "${M.MODE_FROZEN}";`);
  });

  it("rustRoleLabel matches every arm of agents.rs role_label", () => {
    const body = agentsRs.slice(agentsRs.indexOf("fn role_label("), agentsRs.indexOf("fn title_case_id("));
    const arms = [...body.matchAll(/"([a-z_-]+)" => "([^"]+)"\.into\(\)/g)].map((x) => [x[1], x[2]]);
    expect(arms.length).toBeGreaterThanOrEqual(8);
    for (const [id, label] of arms) expect(M.rustRoleLabel(id), id).toBe(label);
    // Any other registry id: title case per word (Rust `title_case_id`).
    expect(M.rustRoleLabel("security-patrol")).toBe("Security Patrol");
    expect(M.rustRoleLabel("finance_2")).toBe("Finance 2");
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
    expect(M.modeBlock(eff("coach"))).toBe(`\n\nMODE: Motivation / Coach. These MODE rules override the STYLE length rule.\n${M.CURIOSITY_MEDIUM}\n${M.DISPATCH_SOLO}\nMODE NOTES: ${M.COACH_NOTES}`);
    expect(rs).toContain('"\\n\\nMODE: {}. These MODE rules override the STYLE length rule."');
  });

  it("a 280-char note on the busiest dials (and a full switchboard) is clipped to the cap", () => {
    const e: M.EffectiveMode = { ...eff("surface", { curiosity: "high", verbosity: "conversational" }), name: "N".repeat(32), prompt_modifier: "x".repeat(280) };
    const block = M.modeBlock(e);
    expect(Array.from(block).length).toBeLessThanOrEqual(M.MODE_BLOCK_MAX);
    expect(block).toContain("MODE NOTES: xxx");
    const full = M.modeBlock({ ...e, switchboard: { agents: ["booking", "prompter", "coder", "designer", "director", "librarian", "bizops", "finance"], tools: [] } });
    expect(Array.from(full).length).toBeLessThanOrEqual(M.MODE_BLOCK_MAX);
    expect(full).toContain(M.ON_DUTY_TAIL);
    expect(M.MODE_BLOCK_MAX).toBe(800);
  });
});

describe("modeBlock (the switchboard line)", () => {
  const eff = (id: string, o: M.ModeOverrides = {}) => M.effectiveOf(M.PRESET_MODES, id, o);
  const head = (name: string) => `\n\nMODE: ${name}. These MODE rules override the STYLE length rule.`;

  it("an overlay adds one deterministic ON DUTY line (Rust labels, sorted) after the dial lines", () => {
    expect(M.modeBlock(eff("builder"))).toBe(`${head("Builder")}\n${M.CURIOSITY_MEDIUM}\n${M.DISPATCH_AUTO}\nON DUTY: Coder, Designer, Prompter; every other agent is frozen this mode.`);
    expect(M.modeBlock(eff("operations"))).toBe(`${head("Operations")}\n${M.CURIOSITY_MEDIUM}\nON DUTY: Operations Manager; every other agent is frozen this mode.`);
    expect(M.modeBlock(eff("executive"))).toBe(`${head("Executive")}\n${M.CURIOSITY_LOW}\n${M.VERBOSITY_TERSE}\nON DUTY: Finance, Operations Manager; every other agent is frozen this mode.`);
    // The list order in the mode never changes the text.
    const shuffled = { ...eff("builder"), switchboard: { agents: ["coder", "prompter", "designer", "coder"], tools: [] } };
    expect(M.modeBlock(shuffled)).toBe(M.modeBlock(eff("builder")));
  });

  it("no overlay = no line (the old text); Learning never gets one and carries its notes", () => {
    for (const id of ["surface", "brainstorm", "coach"]) expect(M.modeBlock(eff(id)), id).not.toContain("ON DUTY");
    const learning = M.modeBlock(eff("learning"));
    expect(learning).not.toContain("ON DUTY");
    expect(learning).toBe(`${head("Learning")}\n${M.CURIOSITY_HIGH}\n${M.LEARNING_PROTOCOL}\nMODE NOTES: ${M.LEARNING_NOTES}`);
    // Learning's notes survive its busiest dials under the raised cap.
    expect(M.modeBlock(eff("learning", { verbosity: "conversational" }))).toContain(`MODE NOTES: ${M.LEARNING_NOTES}`);
  });

  it("an empty custom overlay (not Learning) says so; Tony is never listed", () => {
    expect(M.onDutyLine({ agents: [], tools: [] })).toBe("ON DUTY: none; every agent is frozen this mode.");
    expect(M.onDutyLine({ agents: ["tony", "general"], tools: [] })).toBe("ON DUTY: none; every agent is frozen this mode.");
    expect(M.onDutyLine({ agents: ["bizops_trades", "financer"], tools: [] })).toBe("ON DUTY: Finance, Operations Manager; every other agent is frozen this mode.");
    expect(rs).toContain('"ON DUTY: none; every agent is frozen this mode."');
  });

  it("the ON DUTY line, then the notes, are clipped to the cap (Rust order)", () => {
    const e: M.EffectiveMode = { ...eff("surface", { curiosity: "high", verbosity: "conversational" }), name: "N".repeat(32), prompt_modifier: "x".repeat(280), switchboard: { agents: ["a".repeat(30), "b".repeat(30), "c".repeat(30), "d".repeat(30), "e".repeat(30), "f".repeat(30), "g".repeat(30), "h".repeat(30), "i".repeat(30), "j".repeat(30), "k".repeat(30), "l".repeat(30)], tools: [] } };
    const b = M.modeBlock(e);
    expect(Array.from(b).length).toBe(M.MODE_BLOCK_MAX);
    expect(b).toContain("\nON DUTY: Aaaa");
    expect(b).not.toContain("MODE NOTES");
  });
});

describe("agentLive / toolLive (the switchboard rule)", () => {
  const eff = (id: string) => M.effectiveOf(M.PRESET_MODES, id);
  const booking = { frozenAgents: ["booking"], frozenTools: ["instagram"] };

  it("live = not globally frozen AND (no overlay OR listed); Tony always", () => {
    expect(M.agentLive(eff("builder"), "coder")).toBe(true);
    expect(M.agentLive(eff("builder"), "bizops")).toBe(false);
    expect(M.agentLive(eff("operations"), "bizops")).toBe(true);
    expect(M.agentLive(eff("operations"), "bizops_trades_contracting")).toBe(true);
    expect(M.agentLive(eff("executive"), "financer")).toBe(true);
    expect(M.agentLive(eff("executive"), "librarian")).toBe(false); // a scheduled script only
    expect(M.agentLive(eff("brainstorm"), "director")).toBe(true);
    expect(M.agentLive(eff("brainstorm"), "booking", booking)).toBe(false);
    expect(M.agentLive({ switchboard: { agents: ["booking"], tools: [] } }, "booking", booking)).toBe(false);
    for (const self of ["general", "tony", "Jarvis", "dispatcher"]) {
      expect(M.agentLive(eff("learning"), self, { frozenAgents: [self] }), self).toBe(true);
    }
    expect(M.agentLive(eff("learning"), "nova", null, "Nova")).toBe(true);
    expect(M.agentLive(eff("learning"), "librarian")).toBe(false);
    expect(M.agentLive(null, "coder")).toBe(true);
  });

  it("tools: the always-live set can't be frozen; a master freeze beats any overlay", () => {
    for (const t of M.ALWAYS_LIVE_SERVERS) {
      expect(M.toolLive(eff("learning"), t, { frozenTools: [t] }), t).toBe(true);
    }
    expect(M.toolLive(eff("learning"), "gmail")).toBe(false);
    expect(M.toolLive(eff("builder"), "git")).toBe(true);
    expect(M.toolLive(eff("builder"), "gmail")).toBe(false);
    expect(M.toolLive(eff("operations"), "instagram")).toBe(true);
    expect(M.toolLive(eff("operations"), "instagram", booking)).toBe(false);
    expect(M.toolLive(eff("surface"), "shotcut")).toBe(true);
  });

  it("frozenAgentReason names the agent and the mode (or the master switchboard)", () => {
    expect(M.frozenAgentReason(eff("operations"), "coder")).toBe("Coder is frozen in Operations mode");
    expect(M.frozenAgentReason(eff("builder"), "booking", booking)).toBe("Booking Desk is frozen on the master switchboard");
    expect(M.frozenAgentReason(eff("builder"), "coder")).toBeNull();
    // A name that already ends in "mode" isn't doubled (Rust `frozen_where`).
    expect(M.frozenAgentReason({ name: "Deep Work Mode", switchboard: { agents: [], tools: [] } }, "coder")).toBe("Coder is frozen in Deep Work mode");
    expect(M.frozenToolReason(eff("builder"), "gmail")).toBe("gmail is frozen in Builder mode");
    expect(M.frozenToolReason(eff("builder"), "shotcut", { frozenTools: ["shotcut"] }, "Shotcut")).toBe("Shotcut is frozen on the master switchboard");
    expect(M.frozenToolReason(eff("builder"), "git")).toBeNull();
  });

  it("the system scripts are never switchboard agents", () => {
    for (const a of M.SYSTEM_AGENTS) {
      expect(M.agentLive(eff("learning"), a, { frozenAgents: [a] }), a).toBe(true);
      expect(M.agentGloballyFrozen(a, { frozenAgents: [a] }), a).toBe(false);
    }
    expect(rs).toContain(`pub const SYSTEM_AGENTS: [&str; 4] = [${M.SYSTEM_AGENTS.map((a) => `"${a}"`).join(", ")}];`);
    expect(rs).toContain(`pub const ALWAYS_LIVE_SERVERS: [&str; 3] = [${M.ALWAYS_LIVE_SERVERS.map((a) => `"${a}"`).join(", ")}];`);
    expect(rs).toContain(`pub const ALWAYS_LIVE_TOOLS: [&str; 3] = [${M.ALWAYS_LIVE_TOOLS.map((a) => `"${a}"`).join(", ")}];`);
    expect(rs).toContain(`pub const PIPELINE_AGENTS: [&str; 3] = [${M.PIPELINE_ROLES.map((a) => `"${a}"`).join(", ")}];`);
    expect(rs).toContain(`pub const SWITCHBOARD_LIST_MAX: usize = ${M.SWITCHBOARD_LIST_MAX};`);
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

  const eff = (id: string) => M.effectiveOf(M.PRESET_MODES, id);
  it.each([
    ["operations", { kind: "pipeline" }, "frozen"],
    ["operations", { kind: "agent", role: "coder" }, "frozen"],
    ["operations", { kind: "agent", role: "bizops" }, "offer"],
    ["builder", { kind: "pipeline" }, "auto"],
    ["builder", { kind: "agent", role: "designer" }, "offer"],
    ["builder", { kind: "agent", role: "librarian" }, "frozen"],
    ["executive", { kind: "agent", role: "finance" }, "offer"],
    ["executive", { kind: "pipeline" }, "frozen"],
    ["brainstorm", { kind: "agent", role: "director" }, "offer"],
    ["learning", { kind: "pipeline" }, "solo"],
    ["coach", { kind: "agent", role: "coder" }, "solo"],
  ] as const)("switchboard: %s + %o → %s", (id, target, want) => {
    expect(M.tier3Action(eff(id), target)).toBe(want);
  });

  it("a master-switchboard freeze makes any mode's hand-off frozen", () => {
    const freeze = { frozenAgents: ["booking", "designer"] };
    expect(M.tier3Action(eff("brainstorm"), { kind: "agent", role: "booking" }, freeze)).toBe("frozen");
    expect(M.tier3Action(eff("brainstorm"), { kind: "pipeline" }, freeze)).toBe("frozen");
    expect(M.tier3Action(eff("brainstorm"), { kind: "agent", role: "coder" }, freeze)).toBe("offer");
  });

  it("the calm frozen line names who is frozen and where", () => {
    expect(M.frozenOfferLine(eff("operations"), { kind: "agent", role: "coder" })).toBe("The Coder is frozen in Operations mode, so I didn't hand this off. Switch modes and I'll send it, or I can park it for later.");
    expect(M.frozenOfferLine(eff("operations"), { kind: "pipeline" })).toBe("The Prompter, the Designer and the Coder are frozen in Operations mode, so I didn't hand this off. Switch modes and I'll send it, or I can park it for later.");
    expect(M.frozenOfferLine(eff("brainstorm"), { kind: "agent", role: "booking" }, { frozenAgents: ["booking"] })).toBe("The Booking Desk is switched off on the master switchboard, so I didn't hand this off. I can park it for later.");
  });
});

describe("calmModeError", () => {
  it("maps the Rust refusal prefixes to Tony's lines", () => {
    expect(M.calmModeError("MODE_SURFACE_ONLY: Solo mode is on; nothing was queued.")).toBe(M.SOLO_REFUSAL_LINE);
    expect(M.calmModeError("Error: MODE_NOT_AUTO: only Builder mode queues a build without your yes; nothing was queued.")).toBe(M.NOT_AUTO_REFUSAL_LINE);
    expect(M.calmModeError("all providers failed")).toBeNull();
    // The Rust call-time refusal of a frozen server's tool (mcp.rs, `tool_frozen_error`).
    expect(M.calmModeError("MODE_FROZEN: gmail is frozen in Builder mode")).toBe("Gmail is frozen in Builder mode, so I left it alone. Switch modes and I can use it.");
    expect(M.calmModeError("tool error: MODE_FROZEN: shotcut is frozen on the master switchboard")).toBe("Shotcut is frozen on the master switchboard, so I left it alone. Switch modes and I can use it.");
    expect(M.calmModeError("Error: MODE_FROZEN")).toBe(M.FROZEN_REFUSAL_LINE);
    expect(rs).toContain('format!("{MODE_FROZEN}: {r}")');
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
    expect(v.modes).toHaveLength(8);
    expect(v.modes[4]).toEqual(M.PRESET_MODES[4]);
    // An older desktop (no switchboard keys): the preset's own overlay, nothing frozen known.
    expect(v.effective.switchboard).toEqual(M.EXECUTIVE_SWITCHBOARD);
    expect(v.frozen).toBeUndefined();
    expect(v.prompt_tail).toBeUndefined();
  });

  const base: M.ModeMirror = {
    id: "focus",
    name: "Focus",
    icon: "flame",
    curiosity: "medium",
    verbosity: "balanced",
    dispatch: "ask_before_dispatch",
    feedbackLevel: 1,
    overridden: [],
    list: [...M.PRESET_MODES.map((m) => ({ id: m.id, name: m.name, icon: m.icon, isNovelty: m.is_novelty })), { id: "focus", name: "Focus", icon: "flame", isNovelty: false }],
  };

  it("reads mode.switchboard and mode.promptTail (the phone live rule and the exact Rust block)", () => {
    const v = M.viewFromMirror({ ...base, promptTail: "\n\nMODE: Focus. x", switchboard: { agents: ["coder"], tools: ["git"], frozenAgents: ["booking"], frozenTools: ["shotcut"] } });
    expect(v.effective.switchboard).toEqual({ agents: ["coder"], tools: ["git"] });
    expect(v.modes.find((m) => m.id === "focus")!.switchboard).toEqual({ agents: ["coder"], tools: ["git"] });
    expect(v.frozen).toEqual({ agents: ["booking"], tools: ["shotcut"] });
    expect(v.prompt_tail).toBe("\n\nMODE: Focus. x");
    const freeze = { frozenAgents: v.frozen!.agents, frozenTools: v.frozen!.tools };
    expect(M.agentLive(v.effective, "coder", freeze)).toBe(true);
    expect(M.agentLive(v.effective, "designer", freeze)).toBe(false);
    expect(M.toolLive(v.effective, "shotcut", freeze)).toBe(false);
  });

  it("an explicit null overlay means none, even for a preset that has one", () => {
    const v = M.viewFromMirror({ ...base, id: "builder", name: "Builder", switchboard: { agents: null, tools: null, frozenAgents: [], frozenTools: [] } });
    expect(v.effective.switchboard ?? null).toBeNull();
    expect(M.agentLive(v.effective, "bizops")).toBe(true);
    const learn = M.viewFromMirror({ ...base, id: "learning", name: "Learning", nightTraining: true });
    expect(learn.effective.night_training).toBe(true);
    expect(learn.effective.switchboard).toEqual({ agents: [], tools: [] });
  });
});

describe("Learning mode", () => {
  it("locks dispatch to Solo under any override and swaps in the protocol", () => {
    const e = M.effectiveOf(M.PRESET_MODES, "learning", { dispatch: "auto_dispatch", curiosity: "low" });
    expect(M.isLearningMode(e)).toBe(true);
    expect(e.dispatch).toBe("surface_only");
    expect(e.overridden).toEqual(["curiosity"]);
    const b = M.modeBlock(e);
    expect(b).toContain(M.LEARNING_PROTOCOL);
    expect(b).toContain(M.CURIOSITY_LOW);
    expect(b).not.toContain(M.DISPATCH_SOLO);
    expect(M.tier3Action(e, { kind: "pipeline" })).toBe("solo");
    for (const verbosity of ["terse", "balanced", "conversational"] as const)
      for (const curiosity of ["low", "medium", "high"] as const) expect(Array.from(M.modeBlock(M.effectiveOf(M.PRESET_MODES, "learning", { verbosity, curiosity }))).length).toBeLessThanOrEqual(M.MODE_BLOCK_MAX);
    expect(M.effectiveOf(M.PRESET_MODES, "brainstorm", { dispatch: "auto_dispatch" }).dispatch).toBe("auto_dispatch");
    expect(e.night_training).toBe(true);
    expect(e.switchboard).toEqual({ agents: [], tools: [] });
    expect(M.effectiveOf(M.PRESET_MODES, "brainstorm").night_training).toBeUndefined();
  });
});
