import type { CueWidget } from "./types";

export type LiveCue = CueWidget & { _deleted?: boolean; _created?: number };

/**
 * The user's own copy of a built-in cue: the OLDEST live one. A device that read the cues list
 * while it was failing (e.g. the phone before its token loaded) used to re-seed the defaults, so
 * a built-in can exist many times; the copies are music-less defaults, and the newest-first list
 * made them win over the original the user set up.
 */
export function originalBuiltin<T extends LiveCue>(cues: T[], builtin: string): T | undefined {
  return cues
    .filter((c) => c.builtin === builtin && !c._deleted)
    .reduce<T | undefined>((best, c) => (!best || (c._created ?? 0) < (best._created ?? 0) ? c : best), undefined);
}

/** Startup cues in play order: each built-in once (its original), the built-in welcome first. */
export function startupQueue<T extends LiveCue>(cues: T[]): T[] {
  const live = cues.filter((c) => c.enabled && c.startup && !c._deleted);
  const builtins = new Set(live.map((c) => c.builtin).filter((b): b is NonNullable<typeof b> => !!b));
  const originals = [...builtins].map((b) => originalBuiltin(cues, b)).filter((c): c is T => !!c && c.enabled && !!c.startup);
  return [...originals, ...live.filter((c) => !c.builtin)].sort((a, b) => Number(b.builtin === "startup") - Number(a.builtin === "startup"));
}

