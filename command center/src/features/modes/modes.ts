/**
 * Tony modes (Phase 2 Part C) — the pure TS mirror of `src-tauri/src/commands/modes.rs`.
 *
 * A mode is a small rule set swapped into Tony's system prompt on his next turn (no extra model,
 * no restart). Rust is authoritative on desktop (modes.json + in-memory overrides); this file holds
 * the shared types, the prompt constants (copied verbatim: a test reads the Rust file and compares),
 * the presets (the phone / gateway fallback), and the pure decisions the voice controller makes:
 * `tier3Action` (offer / auto / solo) and `calmModeError` (the spoken line for a refused build).
 *
 * Field names are the spec's snake_case, exactly as Rust serialises them. No prompt text here may
 * contain the format word that flips the provider chain, the thinking switch, or the novelty word.
 */

export type Curiosity = "low" | "medium" | "high";
export type Verbosity = "terse" | "balanced" | "conversational";
export type DispatchPolicy = "surface_only" | "ask_before_dispatch" | "auto_dispatch";
export type TtsInterrupt = "silent" | "milestones_only" | "full";

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
}

/** `tony_modes_get` and the `tony-mode-changed` payload. */
export interface ModesView {
  modes: TonyMode[];
  active_mode_id: string;
  effective: EffectiveMode;
  overrides: ModeOverrides;
  builtin_ids: string[];
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
}

export const BUILTIN_MODE_IDS = ["surface", "brainstorm", "builder", "executive", "coach", "learning", "gabagool"] as const;
export const DEFAULT_MODE_ID = "brainstorm";
export const NOVELTY_MODE_ID = "gabagool";
/** One-on-one training: Tony only, dispatch hard-locked to Solo, lessons saved as pathways. */
export const LEARNING_MODE_ID = "learning";
export const isLearningMode = (e: Pick<EffectiveMode, "mode_id"> | null | undefined): boolean => e?.mode_id === LEARNING_MODE_ID;
export const MODIFIER_MAX = 280;
export const MODE_BLOCK_MAX = 700;

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
): TonyMode => ({ id, name, icon, curiosity_level, verbosity, agent_dispatch_policy, tts_interrupt_level, prompt_modifier, is_novelty });

/** The seven presets, in switcher order (mirrors `modes::presets`). */
export const PRESET_MODES: readonly TonyMode[] = [
  mode("surface", "Surface / Solo", "message-circle", "medium", "balanced", "surface_only", "silent"),
  mode("brainstorm", "Brainstorming", "lightbulb", "high", "conversational", "ask_before_dispatch", "milestones_only", BRAINSTORM_NOTES),
  mode("builder", "Builder", "hammer", "medium", "balanced", "auto_dispatch", "full"),
  mode("executive", "Executive", "briefcase", "low", "terse", "ask_before_dispatch", "milestones_only"),
  mode("coach", "Motivation / Coach", "flame", "medium", "balanced", "surface_only", "milestones_only", COACH_NOTES),
  mode(LEARNING_MODE_ID, "Learning", "graduation-cap", "high", "balanced", "surface_only", "silent"),
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
  };
}

/** Brainstorming, no overrides: the first-launch mode (D11) and what any test sees by default. */
export const DEFAULT_EFFECTIVE: EffectiveMode = effectiveOf(PRESET_MODES, DEFAULT_MODE_ID);

const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const chars = (s: string) => Array.from(s).length;

/** Tony's MODE block (mirrors `modes::mode_block`): deterministic, ≤ 700 chars, "" for a novelty. */
export function modeBlock(e: EffectiveMode): string {
  if (e.is_novelty) return "";
  let s = `\n\nMODE: ${oneLine(e.name)}. These MODE rules override the STYLE length rule.`;
  const dispatch = isLearningMode(e) ? LEARNING_PROTOCOL : DISPATCH_LINE[e.dispatch];
  for (const line of [CURIOSITY_LINE[e.curiosity], VERBOSITY_LINE[e.verbosity], dispatch]) if (line) s += `\n${line}`;
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

/**
 * What a Tier-3 commit cue does under the mode: `auto` (Builder: queue the build at once, no card)
 * only for an `auto_dispatch` mode with a pipeline target; `solo` (nothing is handed off: offer to
 * park it) under `surface_only`; otherwise today's spoken `offer` card.
 */
export function tier3Action(e: Pick<EffectiveMode, "dispatch">, target: Tier3Target): "offer" | "auto" | "solo" {
  if (e.dispatch === "surface_only") return "solo";
  if (e.dispatch === "auto_dispatch" && target.kind === "pipeline") return "auto";
  return "offer";
}

export const MODE_SURFACE_ONLY = "MODE_SURFACE_ONLY";
export const MODE_NOT_AUTO = "MODE_NOT_AUTO";
export const SOLO_REFUSAL_LINE = "Solo mode is on, so nothing was queued. Switch modes and I'll build it, or I can park it for later.";
export const NOT_AUTO_REFUSAL_LINE = "Only Builder mode queues a build without your yes, so nothing was queued.";

/** A Rust `MODE_*` refusal → Tony's calm line (null: not a mode refusal). */
export function calmModeError(err: string): string | null {
  if (err.includes(MODE_SURFACE_ONLY)) return SOLO_REFUSAL_LINE;
  if (err.includes(MODE_NOT_AUTO)) return NOT_AUTO_REFUSAL_LINE;
  return null;
}

/** The phone mirror → a view (the list carries no dials, so customs fall back to the effective). */
export function viewFromMirror(m: ModeMirror): ModesView {
  const modes: TonyMode[] = m.list.map((x) => {
    const preset = PRESET_MODES.find((p) => p.id === x.id);
    if (preset) return preset;
    return mode(x.id, x.name, x.icon, m.curiosity, m.verbosity, m.dispatch, "milestones_only", "", x.isNovelty);
  });
  const effective: EffectiveMode = {
    mode_id: m.id,
    name: m.name,
    icon: m.icon,
    curiosity: m.curiosity,
    verbosity: m.verbosity,
    dispatch: m.dispatch,
    feedback_level: m.feedbackLevel,
    prompt_modifier: modes.find((x) => x.id === m.id)?.prompt_modifier ?? "",
    is_novelty: false,
    overridden: m.overridden ?? [],
  };
  const has = (k: string) => effective.overridden.includes(k);
  const overrides: ModeOverrides = {
    ...(has("curiosity") ? { curiosity: m.curiosity } : {}),
    ...(has("dispatch") ? { dispatch: m.dispatch } : {}),
    ...(has("verbosity") ? { verbosity: m.verbosity } : {}),
    ...(has("feedback") ? { feedback: m.feedbackLevel } : {}),
  };
  return { modes, active_mode_id: m.id, effective, overrides, builtin_ids: [...BUILTIN_MODE_IDS] };
}
