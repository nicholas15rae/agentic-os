import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TriggerKind } from "./space-engine";

/**
 * Orbital Ecosystem deep-space backdrop preferences.
 *  - `minimal`: the original procedural scene (opaque WebGL clear + GL nebula, zero extra layers).
 *  - `deep`:    rotating nebulae + parallax starfield + the space engine at 75 % strength.
 *  - `cinema`:  brighter nebulae, denser stars, the engine at full strength.
 * `mode` and `flybys` (ambient flight events on/off) persist to localStorage (`cc.orbital-space`);
 * the request counters are one-shot signals for the engine and never persist.
 */
export type SpaceMode = "minimal" | "deep" | "cinema";
export const SPACE_MODES: readonly { id: SpaceMode; label: string }[] = [
  { id: "minimal", label: "Minimal" },
  { id: "deep", label: "Deep Space" },
  { id: "cinema", label: "Full Cinema" },
];

interface SpaceStore {
  mode: SpaceMode;
  flybys: boolean;
  /** Bumped by the preview buttons; `flybyKind` says which event. */
  flybyReq: number;
  flybyKind: TriggerKind;
  /** Bumped by "Next Backdrop" (drop-in wallpapers / procedural nebula). */
  nextReq: number;
  setMode: (m: SpaceMode) => void;
  setFlybys: (on: boolean) => void;
  triggerFlyby: (kind?: TriggerKind) => void;
  nextBackdrop: () => void;
}

const isMode = (v: unknown): v is SpaceMode => v === "minimal" || v === "deep" || v === "cinema";

export const useSpace = create<SpaceStore>()(
  persist(
    (set) => ({
      mode: "deep",
      flybys: true,
      flybyReq: 0,
      flybyKind: "random",
      nextReq: 0,
      setMode: (mode) => set({ mode }),
      setFlybys: (flybys) => set({ flybys }),
      triggerFlyby: (kind = "random") => set((s) => ({ flybyReq: s.flybyReq + 1, flybyKind: kind })),
      nextBackdrop: () => set((s) => ({ nextReq: s.nextReq + 1 })),
    }),
    {
      name: "cc.orbital-space",
      version: 1,
      partialize: (s) => ({ mode: s.mode, flybys: s.flybys }),
      merge: (persisted, cur) => {
        const p = (persisted ?? {}) as Partial<SpaceStore>;
        return { ...cur, mode: isMode(p.mode) ? p.mode : cur.mode, flybys: typeof p.flybys === "boolean" ? p.flybys : cur.flybys };
      },
    },
  ),
);
