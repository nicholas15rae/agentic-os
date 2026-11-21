import { calmModeError, type EffectiveMode } from "@/features/modes/modes";

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

/**
 * Why staging is blocked right now (a calm one-liner), or null. An unloaded mode store never
 * blocks: the defaults aren't Nic's mode, and Rust refuses anyway if the real one says no.
 */
export function stageBlocker(effective: Pick<EffectiveMode, "dispatch" | "name">, loaded: boolean): string | null {
  if (!loaded || effective.dispatch !== "surface_only") return null;
  return `${shortModeName(effective.name)} mode builds nothing — switch to Brainstorming or Builder to stage this.`;
}

/** A dispatch failure's text for the intake modal: a Rust `MODE_*` refusal reads calmly, never as a raw code. */
export function hubRefusalText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return calmModeError(raw) ?? raw;
}
