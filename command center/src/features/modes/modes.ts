/**
 * Tony modes (Phase 2 Part C) — the pure TS mirror of `src-tauri/src/commands/modes.rs`.
 *
 * A mode is a small rule set swapped into Tony's system prompt on his next turn (no extra model,
 * no restart). Rust is authoritative on desktop (modes.json + in-memory overrides); this file holds
 * the shared types, the prompt constants (copied verbatim: a test reads the Rust file and compares),
 * the presets (the phone / gateway fallback), and the pure decisions the voice controller makes:
 * `tier3Action` (offer / auto / solo / frozen) and `calmModeError` (the spoken line for a refused build).
 *
 * The SWITCHBOARD is a runtime mask (it never edits os.json's routing, MCP `enabled` or grants):
 * a mode may carry an overlay `switchboard: {agents, tools}` (absent / null = no overlay: today's
 * behaviour), and os.json's master `switchboard.frozenAgents / frozenTools` are frozen in every
 * mode. An agent is live when it is not globally frozen AND (no overlay OR listed). Tony is always
 * live, and so are `ALWAYS_LIVE_TOOLS`.
 *
 * Field names are the spec's snake_case, exactly as Rust serialises them. No prompt text here may
 * contain the format word that flips the provider chain, the thinking switch, or the novelty word.
 */

export type Curiosity = "low" | "medium" | "high";
export type Verbosity = "terse" | "balanced" | "conversational";
export type DispatchPolicy = "surface_only" | "ask_before_dispatch" | "auto_dispatch";
export type TtsInterrupt = "silent" | "milestones_only" | "full";

/** A mode's switchboard overlay (Rust `modes::Switchboard`): the sub-agent role ids and the os.json
 * `mcps[].id` tool servers that stay live in this mode; every other one is frozen. */
export interface ModeSwitchboard {
  agents: string[];
  tools: string[];
}

/** The master switchboard's frozen sets (os.json `switchboard`): frozen in every mode. */
export interface SwitchboardFreeze {
  frozenAgents?: readonly string[] | null;
  frozenTools?: readonly string[] | null;
}

export interface TonyMode {
  id: string;
  name: string;
  icon: string;
  curiosity_level: Curiosity;
  verbosity: Verbosity;
  agent_dispatch_policy: DispatchPolicy;
  tts_interrupt_level: TtsInterrupt;
  prompt_modifier: string;
  is_novelty: boolean;
  /** The overlay (absent / null = none). Optional so an older Rust view or mirror still parses. */
  switchboard?: ModeSwitchboard | null;
  /** Learning: queue tonight's training run (Rust default false). */
  night_training?: boolean;
}

/** Temporary manual changes (cleared by a mode switch, a reset or a restart). */
export interface ModeOverrides {
  curiosity?: Curiosity;
  dispatch?: DispatchPolicy;
  verbosity?: Verbosity;
  /** A manual narration level (0–3), recorded by Rust when NarrationControl changes it. */
  feedback?: number;
}

/** What Tony's next turn runs under (Rust `modes::Effective`). */
export interface EffectiveMode {
  mode_id: string;
  name: string;
  icon: string;
  curiosity: Curiosity;
  verbosity: Verbosity;
  dispatch: DispatchPolicy;
  feedback_level: number;
  prompt_modifier: string;
  is_novelty: boolean;
  overridden: string[];
  /** Copied from the active mode (absent / null = no overlay). */
  switchboard?: ModeSwitchboard | null;
  night_training?: boolean;
}

/** `tony_modes_get` and the `tony-mode-changed` payload. */
export interface ModesView {
  modes: TonyMode[];
  active_mode_id: string;
  effective: EffectiveMode;
  overrides: ModeOverrides;
  builtin_ids: string[];
  /** Phone only (from the mirror): Rust's exact MODE block, and the master switchboard's freezes. */
  prompt_tail?: string;
  frozen?: { agents: string[]; tools: string[] };
}

/** The mirror's `mode.switchboard`: the active mode's overlay (null = none) + the master freezes. */
export interface SwitchboardMirror {
  agents?: string[] | null;
  tools?: string[] | null;
  frozenAgents?: string[];
  frozenTools?: string[];
}

/** The phone mirror's `mode` block (`/api/os/state`). */
export interface ModeMirror {
  id: string;
  name: string;
  icon: string;
  curiosity: Curiosity;
  verbosity: Verbosity;
  dispatch: DispatchPolicy;
  feedbackLevel: number;
  overridden: string[];
  list: { id: string; name: string; icon: string; isNovelty: boolean }[];
  /** The exact `mode_block` string Rust appends to Tony's prompt (the gateway reuses it verbatim). */
  promptTail?: string;
  switchboard?: SwitchboardMirror;
  nightTraining?: boolean;
}

export const BUILTIN_MODE_IDS = ["surface", "brainstorm", "builder", "operations", "executive", "coach", "learning", "gabagool"] as const;
export const DEFAULT_MODE_ID = "brainstorm";
export const NOVELTY_MODE_ID = "gabagool";
/** One-on-one training: Tony only, dispatch hard-locked to Solo, lessons saved as pathways. */
export const LEARNING_MODE_ID = "learning";
/** Business operations: Ops and the Operations Manager on duty, Tony asks before any hand-off. */
export const OPERATIONS_MODE_ID = "operations";
export const isLearningMode = (e: Pick<EffectiveMode, "mode_id"> | null | undefined): boolean => e?.mode_id === LEARNING_MODE_ID;
export const MODIFIER_MAX = 280;
export const MODE_BLOCK_MAX = 800;

export const isBuiltinMode = (id: string): boolean => (BUILTIN_MODE_IDS as readonly string[]).includes(id);

// ── Prompt constants (verbatim copies of modes.rs) ──────────────────────────
export const CURIOSITY_LOW = "CURIOSITY LOW: answer directly in 1–2 sentences; no follow-up questions unless you are blocked.";
export const CURIOSITY_MEDIUM = "CURIOSITY MEDIUM: natural pace; at most 1 focused clarifying question, only if it helps.";
export const CURIOSITY_HIGH = "CURIOSITY HIGH: be an active brainstorming partner: probe edge cases, offer 1–2 creative angles, stay curious.";
export const VERBOSITY_TERSE = "VERBOSITY TERSE: shortest useful answer; short confirmations; zero filler.";
export const VERBOSITY_CONVERSATIONAL = "VERBOSITY CONVERSATIONAL: up to 4 short sentences when it helps the conversation.";
export const DISPATCH_SOLO = "SOLO MODE: nothing is handed to the Prompter, Designer or Coder now. If Nic wants something built, offer to park it, or say it can be queued once he switches modes.";
export const DISPATCH_AUTO = "BUILDER MODE: the app queues a clear build for the Prompter as soon as Nic commits; never say it was queued unless the app confirms it.";
export const BRAINSTORM_NOTES = "Refine raw ideas with sharp follow-ups; when one firms up, offer to park it in the Brainstorm list or hand it off.";
export const LEARNING_PROTOCOL = "LEARNING MODE: Nic is training you; offer no builds or hand-offs. Distill each lesson into a rule; ask one sharp question on edge cases or clashes with LEARNED; echo it back (So when X, you want Y?) before saving unless he says save now. To save, add a line per lesson: [[LEARN category | when | rule or fact | confirmed or provisional]], category one of preference, workflow, rule, persona, domain_knowledge, correction. Confirm briefly.";
export const COACH_NOTES = "Be a grounded, high-energy accountability partner: name the next concrete step and push Nic to take it.";
export const LEARNING_NOTES = "Be curious: ask Nic what he's doing, how and why.";
/** The fixed tail of the switchboard line ("ON DUTY: Coder, Designer, Prompter; " + this). */
export const ON_DUTY_TAIL = "every other agent is frozen this mode.";

// ── Switchboard presets (mirrors `modes::presets`) ──────────────────────────

/** Never frozen by a mode or the master switchboard: the clock, the skill reader, and
 * `tony.set_mode` (how Nic always gets out of a mode by voice). */
export const ALWAYS_LIVE_TOOLS = ["time", "skills.read", "tony.set_mode"] as const;
/** The server ids behind `ALWAYS_LIVE_TOOLS` (`time.now` is on `time`; the other two are synthetic). */
export const ALWAYS_LIVE_SERVERS = ["time", "skills", "tony"] as const;
/** System scripts that are never switchboard agents (never frozen). */
export const SYSTEM_AGENTS = ["security", "observer", "garbage", "trading"] as const;
/** Per-list cap of a mode's overlay (Rust `SWITCHBOARD_LIST_MAX`). */
export const SWITCHBOARD_LIST_MAX = 16;

const board = (agents: string[], tools: string[]): ModeSwitchboard => ({ agents, tools });
export const BUILDER_SWITCHBOARD = board(["prompter", "designer", "coder"], ["filesystem", "git", "fetch", "brave-search", "knowledge-graph", "time", "weather", "spotify"]);
export const OPERATIONS_SWITCHBOARD = board(["ops", "bizops"], ["gmail", "whatsapp", "knowledge-graph", "filesystem", "maps", "fetch", "time", "weather", "instagram"]);
/** The Librarian is not on Executive duty: it runs only as its scheduled script (Rust `EXECUTIVE_AGENTS`). */
export const EXECUTIVE_SWITCHBOARD = board(["bizops", "finance"], ["knowledge-graph", "gmail", "brave-search", "time", "weather"]);
/** Learning: Tony only (the always-live tools stay on). */
export const LEARNING_SWITCHBOARD = board([], []);

const mode = (
  id: string,
  name: string,
  icon: string,
  curiosity_level: Curiosity,
  verbosity: Verbosity,
  agent_dispatch_policy: DispatchPolicy,
  tts_interrupt_level: TtsInterrupt,
  prompt_modifier = "",
  is_novelty = false,
  extra: { switchboard?: ModeSwitchboard | null; night_training?: boolean } = {},
): TonyMode => ({
  id,
  name,
  icon,
  curiosity_level,
  verbosity,
  agent_dispatch_policy,
  tts_interrupt_level,
  prompt_modifier,
  is_novelty,
  ...(extra.switchboard ? { switchboard: extra.switchboard } : {}),
  ...(extra.night_training ? { night_training: true } : {}),
});

/** The eight presets, in switcher order (mirrors `modes::presets`). Surface, Brainstorming, Coach
 * and Gabagool carry no switchboard: everything stays live there, exactly as before. */
export const PRESET_MODES: readonly TonyMode[] = [
  mode("surface", "Surface / Solo", "message-circle", "medium", "balanced", "surface_only", "silent"),
  mode("brainstorm", "Brainstorming", "lightbulb", "high", "conversational", "ask_before_dispatch", "milestones_only", BRAINSTORM_NOTES),
  mode("builder", "Builder", "hammer", "medium", "balanced", "auto_dispatch", "full", "", false, { switchboard: BUILDER_SWITCHBOARD }),
  mode(OPERATIONS_MODE_ID, "Operations", "clipboard-list", "medium", "balanced", "ask_before_dispatch", "milestones_only", "", false, { switchboard: OPERATIONS_SWITCHBOARD }),
  mode("executive", "Executive", "briefcase", "low", "terse", "ask_before_dispatch", "milestones_only", "", false, { switchboard: EXECUTIVE_SWITCHBOARD }),
  mode("coach", "Motivation / Coach", "flame", "medium", "balanced", "surface_only", "milestones_only", COACH_NOTES),
  mode(LEARNING_MODE_ID, "Learning", "graduation-cap", "high", "balanced", "surface_only", "silent", LEARNING_NOTES, false, { switchboard: LEARNING_SWITCHBOARD, night_training: true }),
  mode(NOVELTY_MODE_ID, "Gabagool Mode", "\u{1F35D}", "medium", "balanced", "surface_only", "silent", "", true),
];

export const CURIOSITY_LINE: Record<Curiosity, string> = { low: CURIOSITY_LOW, medium: CURIOSITY_MEDIUM, high: CURIOSITY_HIGH };
export const VERBOSITY_LINE: Record<Verbosity, string> = { terse: VERBOSITY_TERSE, balanced: "", conversational: VERBOSITY_CONVERSATIONAL };
export const DISPATCH_LINE: Record<DispatchPolicy, string> = { surface_only: DISPATCH_SOLO, ask_before_dispatch: "", auto_dispatch: DISPATCH_AUTO };

/** Narration level for a mode's tts level (D17): silent 0 · milestones_only 1 · full 2. */
export function feedbackFor(level: TtsInterrupt): number {
  return level === "silent" ? 0 : level === "full" ? 2 : 1;
}

/** The active mode + overrides (mirrors `modes::effective`; the phone / pre-load fallback). */
export function effectiveOf(modes: readonly TonyMode[], activeId: string, o: ModeOverrides = {}): EffectiveMode {
  const m = modes.find((x) => x.id === activeId) ?? modes.find((x) => x.id === DEFAULT_MODE_ID) ?? PRESET_MODES[1];
  // Learning locks dispatch to Solo: a dispatch override never applies (nor counts) there.
  const learning = m.id === LEARNING_MODE_ID;
  const overridden = (["curiosity", "dispatch", "verbosity", "feedback"] as const).filter((k) => o[k] !== undefined && !(learning && k === "dispatch"));
  return {
    mode_id: m.id,
    name: m.name,
    icon: m.icon,
    curiosity: o.curiosity ?? m.curiosity_level,
    verbosity: o.verbosity ?? m.verbosity,
    dispatch: learning ? "surface_only" : (o.dispatch ?? m.agent_dispatch_policy),
    feedback_level: o.feedback !== undefined ? Math.min(3, Math.max(0, o.feedback)) : feedbackFor(m.tts_interrupt_level),
    prompt_modifier: m.prompt_modifier,
    is_novelty: m.is_novelty,
    overridden: [...overridden],
    ...(m.switchboard ? { switchboard: m.switchboard } : {}),
    ...(m.night_training ? { night_training: true } : {}),
  };
}

/** Brainstorming, no overrides: the first-launch mode (D11) and what any test sees by default. */
export const DEFAULT_EFFECTIVE: EffectiveMode = effectiveOf(PRESET_MODES, DEFAULT_MODE_ID);

// ── Live / frozen (pure; mirrors modes.rs `agent_live` / `tool_live`) ───────

const SELF_IDS: readonly string[] = ["general", "tony", "os", "dispatcher", "orchestrator", "jarvis"];

/** The switchboard id of a role / packet target / workspace (Rust `board_agent`): Tony's aliases
 * (and the OS name, when given) → `general`, `financer` → `finance`, `bizops_<id>` → `bizops`. */
export function canonAgent(id: string, osName = ""): string {
  const v = id.trim().toLowerCase();
  if (!v || SELF_IDS.includes(v) || (!!osName.trim() && v === osName.trim().toLowerCase())) return "general";
  if (v === "financer") return "finance";
  if (v.startsWith("bizops_")) return "bizops";
  return v;
}

const listed = (list: readonly string[] | null | undefined, id: string, osName = "") => !!list && list.some((x) => canonAgent(x, osName) === id);
const isSystemAgent = (a: string) => (SYSTEM_AGENTS as readonly string[]).includes(a);

/** A server id behind an always-live tool (`time`, and the synthetic `skills` / `tony`). */
export const isAlwaysLiveServer = (server: string): boolean => (ALWAYS_LIVE_SERVERS as readonly string[]).includes(server.trim());

/** Frozen on the master switchboard (every mode). Tony and the system scripts never are. */
export function agentGloballyFrozen(id: string, freeze: SwitchboardFreeze | null | undefined, osName = ""): boolean {
  const a = canonAgent(id, osName);
  return a !== "general" && !isSystemAgent(a) && listed(freeze?.frozenAgents, a, osName);
}

export function toolGloballyFrozen(server: string, freeze: SwitchboardFreeze | null | undefined): boolean {
  const s = server.trim();
  return !isAlwaysLiveServer(s) && !!freeze?.frozenTools?.some((x) => x === s);
}

type BoardOf = Pick<EffectiveMode, "switchboard"> | null | undefined;

/** live(agent) = not globally frozen AND (no overlay OR listed). Tony and the system scripts:
 * always live. */
export function agentLive(e: BoardOf, id: string, freeze?: SwitchboardFreeze | null, osName = ""): boolean {
  const a = canonAgent(id, osName);
  if (a === "general" || isSystemAgent(a)) return true;
  if (agentGloballyFrozen(a, freeze, osName)) return false;
  const sb = e?.switchboard;
  return !sb || listed(sb.agents, a, osName);
}

/** live(server) = an always-live server, or not globally frozen AND (no overlay OR listed). */
export function toolLive(e: BoardOf, server: string, freeze?: SwitchboardFreeze | null): boolean {
  const s = server.trim();
  if (isAlwaysLiveServer(s)) return true;
  if (toolGloballyFrozen(s, freeze)) return false;
  const sb = e?.switchboard;
  return !sb || sb.tools.some((x) => x === s);
}

/** "in Builder mode" (a name already ending in " mode" isn't doubled), or "on the master
 * switchboard" (Rust `frozen_where`). */
function frozenWhere(name: string | undefined, master: boolean): string {
  if (master) return "on the master switchboard";
  const n = oneLine(name ?? "this");
  return `in ${n.toLowerCase().endsWith(" mode") ? n.slice(0, -5) : n} mode`;
}

/** Why `id` is frozen this turn ("Coder is frozen in Operations mode"), or null when it is live. */
export function frozenAgentReason(e: (BoardOf & Partial<Pick<EffectiveMode, "name">>) | null | undefined, id: string, freeze?: SwitchboardFreeze | null, osName = ""): string | null {
  if (agentLive(e, id, freeze, osName)) return null;
  const a = canonAgent(id, osName);
  return `${rustRoleLabel(a)} is frozen ${frozenWhere(e?.name, agentGloballyFrozen(a, freeze, osName))}`;
}

/** "<label> is frozen in <Mode> mode" for tool server `server` (null: live). */
export function frozenToolReason(e: (BoardOf & Partial<Pick<EffectiveMode, "name">>) | null | undefined, server: string, freeze?: SwitchboardFreeze | null, label = server): string | null {
  if (toolLive(e, server, freeze)) return null;
  return `${label} is frozen ${frozenWhere(e?.name, !!freeze?.frozenTools?.some((x) => x === server.trim()))}`;
}

const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const chars = (s: string) => Array.from(s).length;

/** A role id as Rust `agents::role_label` names it. The MODE block's labels must match Rust byte
 * for byte, so this never reads the OS name or the webview's own "Biz Ops" label. */
export function rustRoleLabel(id: string): string {
  switch (id) {
    case "booking":
      return "Booking Desk";
    case "bizops":
      return "Operations Manager";
    default:
      return id
        .split(/[-_]/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
  }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The switchboard line (Rust `on_duty_line`): the on-duty agents' labels (never Tony), sorted
 * and deduplicated, so the text is deterministic. */
export function onDutyLine(s: ModeSwitchboard): string {
  const ids = s.agents.map((a) => canonAgent(a)).filter((a) => a !== "general");
  const labels = [...new Set(ids.map(rustRoleLabel))].sort(byCodeUnit);
  return labels.length ? `ON DUTY: ${labels.join(", ")}; ${ON_DUTY_TAIL}` : "ON DUTY: none; every agent is frozen this mode.";
}

/**
 * Tony's MODE block (mirrors `modes::mode_block`): deterministic, ≤ MODE_BLOCK_MAX chars, "" for a
 * novelty. Rust appends it LAST in Tony's system message (right before the thinking switch), so
 * the cached prefix above it is the same in every mode. With an overlay (not Learning, whose
 * protocol already rules out hand-offs) it gains the ON DUTY line after the dial lines; the ON
 * DUTY line, then the mode's notes, are clipped to fit.
 */
export function modeBlock(e: EffectiveMode): string {
  if (e.is_novelty) return "";
  let s = `\n\nMODE: ${oneLine(e.name)}. These MODE rules override the STYLE length rule.`;
  const learning = isLearningMode(e);
  const dispatch = learning ? LEARNING_PROTOCOL : DISPATCH_LINE[e.dispatch];
  for (const line of [CURIOSITY_LINE[e.curiosity], VERBOSITY_LINE[e.verbosity], dispatch]) if (line) s += `\n${line}`;
  if (e.switchboard && !learning) {
    const room = MODE_BLOCK_MAX - (chars(s) + 1);
    if (room > 0) s += `\n${Array.from(onDutyLine(e.switchboard)).slice(0, room).join("")}`;
  }
  const notes = oneLine(e.prompt_modifier);
  if (notes) {
    const head = "\nMODE NOTES: ";
    const room = MODE_BLOCK_MAX - chars(s) - chars(head);
    if (room > 0) s += head + Array.from(notes).slice(0, room).join("");
  }
  return s;
}

/** The Tier-3 offer target (voice-controller / dialogue `OfferTarget`), structurally. */
export type Tier3Target = { kind: "pipeline" } | { kind: "agent"; role: string };

/** The agents a Prompter → Designer → Coder build passes through (any one frozen parks it). */
export const PIPELINE_ROLES = ["prompter", "designer", "coder"] as const;

export type Tier3Outcome = "offer" | "auto" | "solo" | "frozen";

/** The target's frozen agents this turn (empty: the hand-off can go). */
export function frozenTargetAgents(e: BoardOf, target: Tier3Target, freeze?: SwitchboardFreeze | null): string[] {
  const roles = target.kind === "pipeline" ? [...PIPELINE_ROLES] : [canonAgent(target.role)];
  return roles.filter((r) => !agentLive(e, r, freeze));
}

/**
 * What a Tier-3 commit cue does under the mode: `solo` (nothing is handed off: offer to park it)
 * under `surface_only`; `frozen` (the target agent, or any of the build crew, is frozen in this
 * mode or on the master switchboard: say so calmly, offer to park it); `auto` (Builder: queue the
 * build at once, no card) only for an `auto_dispatch` mode with a pipeline target; otherwise
 * today's spoken `offer` card. A Tier-3 offer is Tony's own initiative, never a direct ask, so a
 * frozen target is never offered.
 */
export function tier3Action(e: Pick<EffectiveMode, "dispatch"> & Partial<Pick<EffectiveMode, "switchboard">>, target: Tier3Target, freeze?: SwitchboardFreeze | null): Tier3Outcome {
  if (e.dispatch === "surface_only") return "solo";
  if (frozenTargetAgents(e, target, freeze).length > 0) return "frozen";
  if (e.dispatch === "auto_dispatch" && target.kind === "pipeline") return "auto";
  return "offer";
}

const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Tony's calm spoken line for a `frozen` Tier-3 outcome. */
export function frozenOfferLine(e: Pick<EffectiveMode, "name"> & Partial<Pick<EffectiveMode, "switchboard">>, target: Tier3Target, freeze?: SwitchboardFreeze | null): string {
  const frozen = frozenTargetAgents(e, target, freeze);
  const labels = frozen.map((r) => `the ${rustRoleLabel(r)}`);
  const who = andList(labels) || "that agent";
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const verb = frozen.length > 1 ? "are" : "is";
  if (frozen.length > 0 && frozen.every((r) => agentGloballyFrozen(r, freeze))) return `${Who} ${verb} switched off on the master switchboard, so I didn't hand this off. I can park it for later.`;
  return `${Who} ${verb} frozen ${frozenWhere(e.name, false)}, so I didn't hand this off. Switch modes and I'll send it, or I can park it for later.`;
}

export const MODE_SURFACE_ONLY = "MODE_SURFACE_ONLY";
export const MODE_NOT_AUTO = "MODE_NOT_AUTO";
/** A tool call Rust refused because the switchboard froze its server ("MODE_FROZEN: gmail is
 * frozen in Builder mode"). Builds are never refused for it: they wait in the queue. */
export const MODE_FROZEN = "MODE_FROZEN";
export const SOLO_REFUSAL_LINE = "Solo mode is on, so nothing was queued. Switch modes and I'll build it, or I can park it for later.";
export const NOT_AUTO_REFUSAL_LINE = "Only Builder mode queues a build without your yes, so nothing was queued.";
export const FROZEN_REFUSAL_LINE = "That's frozen in this mode, so I left it alone. Switch modes and I can use it.";

/** A Rust `MODE_*` refusal → Tony's calm line (null: not a mode refusal). */
export function calmModeError(err: string): string | null {
  if (err.includes(MODE_SURFACE_ONLY)) return SOLO_REFUSAL_LINE;
  if (err.includes(MODE_NOT_AUTO)) return NOT_AUTO_REFUSAL_LINE;
  if (err.includes(MODE_FROZEN)) {
    // "MODE_FROZEN: gmail is frozen in Builder mode" → its own subject and place.
    const detail = err.slice(err.indexOf(MODE_FROZEN) + MODE_FROZEN.length).replace(/^[\s:]+/, "").split(/[;\n]/)[0].replace(/[.\s]+$/, "").trim();
    if (!/ is frozen /i.test(detail) || detail.length > 120) return FROZEN_REFUSAL_LINE;
    return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}, so I left it alone. Switch modes and I can use it.`;
  }
  return null;
}

/** The mirror's overlay: present `agents` / `tools` arrays = an overlay; explicit nulls = none;
 * no `switchboard` key at all (an older desktop) = `fallback` (the preset's own). */
function mirrorOverlay(sbm: SwitchboardMirror | undefined, fallback: ModeSwitchboard | null | undefined): ModeSwitchboard | null {
  if (!sbm) return fallback ?? null;
  if (!Array.isArray(sbm.agents) && !Array.isArray(sbm.tools)) return null;
  return { agents: [...(sbm.agents ?? [])], tools: [...(sbm.tools ?? [])] };
}

/** The phone mirror → a view (the list carries no dials, so customs fall back to the effective). */
export function viewFromMirror(m: ModeMirror): ModesView {
  const modes: TonyMode[] = m.list.map((x) => {
    const preset = PRESET_MODES.find((p) => p.id === x.id);
    if (preset) return preset;
    return mode(x.id, x.name, x.icon, m.curiosity, m.verbosity, m.dispatch, "milestones_only", "", x.isNovelty, x.id === m.id ? { switchboard: mirrorOverlay(m.switchboard, null), night_training: m.nightTraining } : {});
  });
  const active = modes.find((x) => x.id === m.id);
  const overlay = mirrorOverlay(m.switchboard, active?.switchboard);
  const night = m.nightTraining ?? !!active?.night_training;
  const effective: EffectiveMode = {
    mode_id: m.id,
    name: m.name,
    icon: m.icon,
    curiosity: m.curiosity,
    verbosity: m.verbosity,
    dispatch: m.dispatch,
    feedback_level: m.feedbackLevel,
    prompt_modifier: active?.prompt_modifier ?? "",
    is_novelty: false,
    overridden: m.overridden ?? [],
    ...(overlay ? { switchboard: overlay } : {}),
    ...(night ? { night_training: true } : {}),
  };
  const has = (k: string) => effective.overridden.includes(k);
  const overrides: ModeOverrides = {
    ...(has("curiosity") ? { curiosity: m.curiosity } : {}),
    ...(has("dispatch") ? { dispatch: m.dispatch } : {}),
    ...(has("verbosity") ? { verbosity: m.verbosity } : {}),
    ...(has("feedback") ? { feedback: m.feedbackLevel } : {}),
  };
  return {
    modes,
    active_mode_id: m.id,
    effective,
    overrides,
    builtin_ids: [...BUILTIN_MODE_IDS],
    ...(typeof m.promptTail === "string" ? { prompt_tail: m.promptTail } : {}),
    ...(m.switchboard ? { frozen: { agents: [...(m.switchboard.frozenAgents ?? [])], tools: [...(m.switchboard.frozenTools ?? [])] } } : {}),
  };
}
