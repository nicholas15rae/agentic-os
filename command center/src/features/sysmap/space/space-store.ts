import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TriggerKind } from "./fleet/sim";
import type { Grade } from "./grade";

/**
 * Orbital Ecosystem deep-space backdrop preferences.
 *  - `minimal`: the original procedural scene (opaque WebGL clear + GL nebula, zero extra layers).
 *  - `deep`:    rotating nebulae + parallax starfield + the 3D fleet in the star map.
 *  - `cinema`:  brighter nebulae and denser stars.
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
  /** Follow-cam target (`ship:e46`, `ship:fighter0`, `ship:capital`…); null = free camera. Not persisted. */
  follow: string | null;
  setFollow: (k: string | null) => void;
  /** The showing nebula's colour grade (lights the 3D fleet). Not persisted. */
  grade: Grade | null;
  setGrade: (g: Grade) => void;
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
      grade: null,
      follow: null,
      setFollow: (follow) => set({ follow }),
      setGrade: (grade) => set({ grade }),
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
