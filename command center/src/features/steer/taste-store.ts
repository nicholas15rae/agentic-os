import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * UI fixes 4: the taste profile Play Place steers with. Every pick (a kind accepted, a look or a
 * personality chosen) nudges a trait up; turning a pitch down nudges it down. It is the start of
 * the shared taste profile (Section 5, item 13): view, remove a trait, or reset it, from the steer card.
 */
export interface TasteState {
  /** Trait → weight (positive = you lean that way). */
  traits: Record<string, number>;
  record: (tags: string[], delta?: number) => void;
  forget: (trait: string) => void;
  reset: () => void;
}

const TRAIT = /^[a-z][a-z-]{0,23}$/;
const MAX = 20;

/** Rehydration guard. Pure. */
export function sanitizeTraits(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 60))
    if (TRAIT.test(k) && typeof v === "number" && Number.isFinite(v)) out[k] = Math.max(-MAX, Math.min(MAX, v));
  return out;
}

/** The traits you lean towards, strongest first. Pure. */
export function topTraits(traits: Record<string, number>, n = 3): string[] {
  return Object.entries(traits)
    .filter(([, v]) => v >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k);
}

/** "You usually pick dark, rounded designs." (null while nothing stands out). Pure. */
export function tasteLine(traits: Record<string, number>): string | null {
  const top = topTraits(traits, 3);
  if (!top.length) return null;
  const list = top.length === 1 ? top[0] : `${top.slice(0, -1).join(", ")} and ${top[top.length - 1]}`;
  return `You usually pick ${list} designs.`;
}

export const useTaste = create<TasteState>()(
  persist(
    (set) => ({
      traits: {},
      record: (tags, delta = 1) =>
        set((s) => {
          const traits = { ...s.traits };
          for (const t of tags) if (TRAIT.test(t)) traits[t] = Math.max(-MAX, Math.min(MAX, (traits[t] ?? 0) + delta));
          return { traits };
        }),
      forget: (trait) =>
        set((s) => {
          const traits = { ...s.traits };
          delete traits[trait];
          return { traits };
        }),
      reset: () => set({ traits: {} }),
    }),
    {
      name: "cc.taste",
      version: 1,
      partialize: (s) => ({ traits: s.traits }),
      merge: (persisted, current) => ({ ...current, traits: sanitizeTraits((persisted as { traits?: unknown } | null)?.traits) }),
    },
  ),
);
