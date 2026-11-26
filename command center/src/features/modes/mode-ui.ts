/**
 * Tony modes — pure helpers for the mode surfaces (Phase 2 Part D): the Mode Panel widget, the
 * top-bar ModePill popover, the phone HUD's ModeStrip and the Settings Modes Manager.
 *
 * No React, no stores: everything here is unit-tested directly. Field names mirror the Rust
 * snake_case (`modes.ts`). Validation mirrors `modes::validate_mode` so a bad draft is caught on
 * blur before Rust refuses it.
 */
import { MODIFIER_MAX, NOVELTY_MODE_ID, PRESET_MODES, SWITCHBOARD_LIST_MAX, canonAgent, effectiveOf, feedbackFor, isAlwaysLiveServer, isBuiltinMode, type Curiosity, type DispatchPolicy, type EffectiveMode, type ModeOverrides, type TonyMode, type TtsInterrupt, type Verbosity } from "./modes";
import type { SegmentOption } from "@/components/segmented";

/** The icon names the pickers offer (lucide). Anything else (an emoji) renders as text. */
export const MODE_ICON_NAMES = ["message-circle", "lightbulb", "hammer", "clipboard-list", "briefcase", "flame", "graduation-cap", "sparkles"] as const;
export type ModeIconName = (typeof MODE_ICON_NAMES)[number];
export const isModeIconName = (s: string): s is ModeIconName => (MODE_ICON_NAMES as readonly string[]).includes(s);

export const NAME_MAX = 32;
export const ICON_MAX = 32;

export const CURIOSITY_OPTS: readonly SegmentOption<Curiosity>[] = [
  { id: "low", label: "Low", hint: "Answers directly in 1–2 sentences; no follow-up questions unless blocked." },
  { id: "medium", label: "Med", hint: "Natural pace; at most one focused clarifying question." },
  { id: "high", label: "High", hint: "Active brainstorming partner: probes edge cases, offers 1–2 creative angles." },
];

export const VERBOSITY_OPTS: readonly SegmentOption<Verbosity>[] = [
  { id: "terse", label: "Terse", hint: "Shortest useful answer; short confirmations; zero filler." },
  { id: "balanced", label: "Balanced", hint: "Tony's normal length." },
  { id: "conversational", label: "Chatty", hint: "Up to 4 short sentences when it helps the conversation." },
];

export const DISPATCH_OPTS: readonly SegmentOption<DispatchPolicy>[] = [
  { id: "surface_only", label: "Solo", tone: "teal", hint: "Just you and Tony: nothing is handed to the Prompter, Designer or Coder." },
  { id: "ask_before_dispatch", label: "Ask", tone: "amber", hint: "Tony asks “delegate or park?” before any build is queued." },
  { id: "auto_dispatch", label: "Auto", tone: "alert", hint: "Build-shaped requests go straight to staging; emails/messages/calendar still ask." },
];

export const TTS_OPTS: readonly SegmentOption<TtsInterrupt>[] = [
  { id: "silent", label: "Silent", hint: "Background builds are never spoken (toasts only)." },
  { id: "milestones_only", label: "Milestones", hint: "Queued, ready for review and failures are spoken." },
  { id: "full", label: "Full", hint: "Also every handoff between agents." },
];

/** Why the dispatch dial is locked in Learning mode (its tooltip). */
export const LEARNING_DISPATCH_LOCK = "Learning mode: sub-agent dispatch is off while you train Tony (Solo only).";

export const DISPATCH_SHORT: Record<DispatchPolicy, string> = { surface_only: "Solo", ask_before_dispatch: "Ask", auto_dispatch: "Auto" };

/** The narration level a mode's tts setting writes on switch (silent 0 · milestones 1 · full 2). */
export const ttsToFeedback = (t: TtsInterrupt): 0 | 1 | 2 => feedbackFor(t) as 0 | 1 | 2;

/** One mode's dials under the given overrides (what Tony's next turn would use if it were active). */
export function effectiveMode(m: TonyMode, o: ModeOverrides = {}): EffectiveMode {
  return effectiveOf([m], m.id, o);
}

/** Any temporary manual change in place? */
export const isOverridden = (o: ModeOverrides | null | undefined): boolean =>
  !!o && (o.curiosity !== undefined || o.dispatch !== undefined || o.verbosity !== undefined || o.feedback !== undefined);

/** The switcher's two groups: work modes (the radiogroup) and the novelty overlay (a switch). */
export function switcherModes(modes: readonly TonyMode[]): { work: TonyMode[]; novelty: TonyMode[] } {
  return {
    work: modes.filter((m) => !m.is_novelty && m.id !== NOVELTY_MODE_ID),
    novelty: modes.filter((m) => m.is_novelty || m.id === NOVELTY_MODE_ID),
  };
}

const chars = (s: string) => Array.from(s).length;

/** A custom id from a name, unique among `modes` and the presets (mirrors `ModesFile::unique_id`). */
export function uniqueModeId(modes: readonly TonyMode[], name: string): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-");
  if (!base || !/^[a-z]/.test(base)) base = `mode-${base}`;
  base = base.slice(0, 26).replace(/-+$/, "");
  const taken = (id: string) => isBuiltinMode(id) || modes.some((m) => m.id === id);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** A name not used by any mode: `base`, then `base 2`, `base 3`… (capped at 32 characters). */
export function uniqueModeName(modes: readonly TonyMode[], base: string): string {
  const used = new Set(modes.map((m) => m.name.trim().toLowerCase()));
  const cap = (s: string) => Array.from(s).slice(0, NAME_MAX).join("");
  if (!used.has(cap(base).toLowerCase())) return cap(base);
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = Array.from(base).slice(0, NAME_MAX - suffix.length).join("") + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** A custom copy of `src` ("<name> copy", then "<name> copy 2"…): never a preset, never a novelty. */
export function duplicateMode(modes: readonly TonyMode[], src: TonyMode): TonyMode {
  const name = uniqueModeName(modes, `${src.name} copy`);
  return { ...src, id: uniqueModeId(modes, name), name, is_novelty: false };
}

/** A fresh custom mode from the Surface / Solo defaults. */
export function newModeDraft(modes: readonly TonyMode[]): TonyMode {
  const name = uniqueModeName(modes, "New mode");
  return { ...PRESET_MODES[0], id: uniqueModeId(modes, name), name, icon: "sparkles", prompt_modifier: "", is_novelty: false };
}

/** Presets and the active mode can't be deleted. */
export const canDelete = (m: Pick<TonyMode, "id">, activeId: string): boolean => !isBuiltinMode(m.id) && m.id !== activeId;

/**
 * Words no mode text may carry into Tony's prompt (mirrors Rust `banned_word`): the format word
 * flips the provider chain, the thinking switch must stay last, the novelty word is never Tony's.
 */
export function bannedWord(s: string): string | null {
  const l = s.toLowerCase();
  if (l.includes("json")) return "json";
  if (l.includes("/no_think")) return "/no_think";
  if (l.includes("gabagool")) return "gabagool";
  return null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The UI's copy of `modes::validate_mode` for a draft (null = OK). */
export function validateModeDraft(m: Pick<TonyMode, "name" | "prompt_modifier"> & Partial<Pick<TonyMode, "icon" | "is_novelty" | "switchboard">>): string | null {
  const name = m.name.trim();
  if (chars(name) === 0 || chars(name) > NAME_MAX || CONTROL.test(name)) return `Name: 1–${NAME_MAX} characters`;
  if (m.icon !== undefined) {
    const icon = m.icon.trim();
    if (chars(icon) === 0 || chars(icon) > ICON_MAX || CONTROL.test(m.icon)) return `Icon: 1–${ICON_MAX} characters`;
  }
  if (chars(m.prompt_modifier) > MODIFIER_MAX) return `Behaviour rules: at most ${MODIFIER_MAX} characters`;
  if (CONTROL.test(m.prompt_modifier)) return "Behaviour rules: one line, no line breaks";
  if (!m.is_novelty) {
    for (const [what, text] of [
      ["Name", name],
      ["Behaviour rules", m.prompt_modifier],
    ] as const) {
      const w = bannedWord(text);
      if (w) return `${what} can't contain “${w}” (it would change how Tony's prompt is handled)`;
    }
  }
  return validateSwitchboard(m.switchboard);
}

const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVER_ID = /^[A-Za-z0-9_-]{1,48}$/;

/** The UI's copy of the switchboard part of `modes::validate_mode` (null = OK). */
export function validateSwitchboard(sb: TonyMode["switchboard"]): string | null {
  if (!sb) return null;
  if (sb.agents.length > SWITCHBOARD_LIST_MAX || sb.tools.length > SWITCHBOARD_LIST_MAX) return `Switchboard: at most ${SWITCHBOARD_LIST_MAX} agents and ${SWITCHBOARD_LIST_MAX} tools`;
  const agent = sb.agents.find((a) => !AGENT_ID.test(a) || canonAgent(a) === "general" || bannedWord(a));
  if (agent !== undefined) return `Switchboard agent “${agent}”: a sub-agent id, never Tony`;
  const tool = sb.tools.find((t) => !SERVER_ID.test(t));
  if (tool !== undefined) return `Switchboard tool “${tool}”: an MCP server id`;
  return null;
}

// ── Switchboard overlay editing (custom modes only; presets are re-seeded by Rust) ─────────

/** Turn a custom mode's overlay on (starting from `all`, so nothing changes until an item is
 * unticked; the always-live servers need no entry; each list capped like Rust's) or off (`null`:
 * no overlay, everything live). */
export function withOverlay(m: TonyMode, on: boolean, all: { agents: readonly string[]; tools: readonly string[] }): TonyMode {
  if (!on) return { ...m, switchboard: null };
  const agents = all.agents.filter((a) => canonAgent(a) !== "general").slice(0, SWITCHBOARD_LIST_MAX);
  const tools = all.tools.filter((t) => !isAlwaysLiveServer(t)).slice(0, SWITCHBOARD_LIST_MAX);
  return { ...m, switchboard: { agents, tools } };
}

/** Flip one agent or tool server in a custom mode's overlay (no overlay: unchanged). */
export function toggleOverlayItem(m: TonyMode, kind: "agents" | "tools", id: string): TonyMode {
  const sb = m.switchboard;
  if (!sb) return m;
  const list = sb[kind];
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return { ...m, switchboard: { ...sb, [kind]: next } };
}

/** "3 agents · 8 tools on duty" / "everything live" for a mode row. */
export function switchboardSummary(m: Pick<TonyMode, "switchboard">): string {
  const sb = m.switchboard;
  if (!sb) return "No switchboard: every agent and tool stays live";
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  if (sb.agents.length === 0 && sb.tools.length === 0) return "Tony only: no sub-agents, only the always-live tools";
  return `${n(sb.agents.length, "agent")} · ${n(sb.tools.length, "tool")} on duty; the rest are frozen`;
}

/** "3/280" for the behaviour-rules counter. */
export const modifierCount = (s: string): string => `${chars(s)}/${MODIFIER_MAX}`;

/** The work-radio grid for a widget size: 2 columns up to w=3, one scroll row at w≥4·h=2, else 3 columns. */
export function panelLayout(size: { w: number; h: number }): { grid: "cols-2" | "row" | "cols-3"; iconsOnly: boolean; dials: boolean; footer: boolean } {
  const grid = size.w <= 3 ? "cols-2" : size.h <= 2 ? "row" : "cols-3";
  return { grid, iconsOnly: size.w <= 2, dials: size.h >= 3, footer: size.h >= 4 };
}
