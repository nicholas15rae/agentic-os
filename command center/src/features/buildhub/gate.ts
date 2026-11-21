import { calmModeError, MODE_SURFACE_ONLY, type EffectiveMode } from "@/features/modes/modes";

/**
 * The Tony-mode gate on staging a build, surfaced BEFORE the confirmation card (pure). Rust's
 * `build_enqueue` stays authoritative (a `surface_only` mode refuses every worker with
 * MODE_SURFACE_ONLY); this only spares Nic a card whose yes can't stage anything.
 */

/** "Motivation / Coach" → "Coach", "Surface / Solo" → "Solo", "Gabagool Mode" → "Gabagool". */
export function shortModeName(name: string): string {
  const last = name.split("/").pop()?.trim() ?? "";
  return last.replace(/\s+mode$/i, "").trim() || "This";
}

/** What the gate reads of the effective mode (`overridden` names the Mode Panel's temporary overrides). */
export type GateMode = Pick<EffectiveMode, "dispatch" | "name"> & { overridden?: readonly string[] };

/** The dispatch policy is a temporary Mode Panel override, not the mode's own (a mode switch or a reset clears it, D18). */
const dispatchOverridden = (m: GateMode) => m.overridden?.includes("dispatch") ?? false;

/** The modes that can stage a build, minus the one already active (never "switch to" the current mode). */
function switchTargets(short: string): string {
  const others = ["Brainstorming", "Builder"].filter((n) => n.toLowerCase() !== short.toLowerCase());
  return others.join(" or ");
}

/**
 * Why staging is blocked right now (a calm one-liner), or null. An unloaded mode store never
 * blocks: the defaults aren't Nic's mode, and Rust refuses anyway if the real one says no. A Solo
 * dispatch set as a Mode Panel override is named as that (the way out is resetting it, not a
 * mode switch to the mode he is already in).
 */
export function stageBlocker(effective: GateMode, loaded: boolean): string | null {
  if (!loaded || effective.dispatch !== "surface_only") return null;
  if (dispatchOverridden(effective)) return "Dispatch is set to Solo for now — set it back (or reset) in the Mode Panel to stage this.";
  const short = shortModeName(effective.name);
  return `${short} mode builds nothing — switch to ${switchTargets(short)} to stage this.`;
}

/**
 * A dispatch failure's text for the intake modal: a Rust `MODE_*` refusal reads calmly, never as a
 * raw code. A `MODE_SURFACE_ONLY` refusal names the mode actually in force (Rust's message always
 * says "Solo") and never offers to park (the modal has no park action): from the effective mode
 * when the store is loaded, mode-neutral when it is not. Tony's spoken path keeps `SOLO_REFUSAL_LINE`.
 */
export function hubRefusalText(e: unknown, mode?: GateMode | null, loaded = false): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes(MODE_SURFACE_ONLY)) {
    const tail = "so nothing was queued — your answers are still here.";
    if (mode && loaded && mode.dispatch === "surface_only") {
      if (dispatchOverridden(mode)) return `Dispatch is set to Solo for now, ${tail} Set it back (or reset) in the Mode Panel to stage this.`;
      const short = shortModeName(mode.name);
      return `${short} mode builds nothing, ${tail} Switch to ${switchTargets(short)} to stage this.`;
    }
    return `The current Tony mode builds nothing, ${tail} Switch to Brainstorming or Builder to stage this.`;
  }
  return calmModeError(raw) ?? raw;
}
