import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useSettings } from "@/stores/settings";
import { useWallpapers } from "./wallpaper-store";
import { sanitizeConfig, SURFACE_DEFAULTS, SURFACES, type Surface, type SurfaceConfig } from "./backdrop-model";

export type ManagerTab = Surface | "all";

/**
 * Per-surface backdrop settings (Home, Schematic Flowchart, Orbital Ecosystem). Home's rotation
 * fields stay where they always lived — `useSettings` (interval / shuffle / sync) and
 * `useWallpapers.playing` (rotate on/off) — so the Home slideshow is untouched; this store holds
 * everything else, plus each System Map surface's current wallpaper and the manager's open tab.
 */
interface BackdropStore {
  configs: Record<Surface, SurfaceConfig>;
  /** Current wallpaper per System Map surface (Home uses `useWallpapers.currentId`). */
  current: Record<Surface, string | null>;
  /** The Wallpaper manager's selected tab (the in-page gear opens it pre-switched). */
  tab: ManagerTab;
  setTab: (t: ManagerTab) => void;
  patch: (s: Surface, p: Partial<SurfaceConfig>) => void;
  reset: (s: Surface) => void;
  setCurrent: (s: Surface, id: string | null) => void;
}

export const useBackdrops = create<BackdropStore>()(
  persist(
    (set) => ({
      configs: { home: SURFACE_DEFAULTS.home, flowchart: SURFACE_DEFAULTS.flowchart, orbital: SURFACE_DEFAULTS.orbital },
      current: { home: null, flowchart: null, orbital: null },
      tab: "home",
      setTab: (tab) => set({ tab }),
      patch: (s, p) => set((st) => ({ configs: { ...st.configs, [s]: sanitizeConfig(s, { ...st.configs[s], ...p }) } })),
      // Reset Defaults covers the blend strip (look), not the pool or the on/off choice.
      reset: (s) =>
        set((st) => {
          const d = SURFACE_DEFAULTS[s];
          return { configs: { ...st.configs, [s]: { ...st.configs[s], opacity: d.opacity, dimmer: d.dimmer, blurPx: d.blurPx, vignette: d.vignette } } };
        }),
      setCurrent: (s, id) => set((st) => ({ current: { ...st.current, [s]: id } })),
    }),
    {
      name: "cc.backdrops",
      version: 1,
      partialize: (s) => ({ configs: s.configs, current: s.current, tab: s.tab }),
      // Every load: fill new fields / clamp ranges, whatever an older build saved.
      merge: (persisted, cur) => {
        const p = (persisted ?? {}) as Partial<BackdropStore>;
        const configs = Object.fromEntries(SURFACES.map((s) => [s, sanitizeConfig(s, p.configs?.[s])])) as Record<Surface, SurfaceConfig>;
        const tab = p.tab && (p.tab === "all" || SURFACES.includes(p.tab as Surface)) ? p.tab : cur.tab;
        return { ...cur, configs, current: { ...cur.current, ...(p.current ?? {}) }, tab };
      },
    },
  ),
);

/** A surface's effective config (Home: rotation fields from their original homes). */
export function useSurfaceConfig(s: Surface): SurfaceConfig {
  const cfg = useBackdrops((st) => st.configs[s]);
  const interval = useSettings((st) => st.wallpaperIntervalSec);
  const shuffle = useSettings((st) => st.wallpaperShuffle);
  const sync = useSettings((st) => st.wallpaperSync);
  const playing = useWallpapers((st) => st.playing);
  if (s !== "home") return cfg;
  return { ...cfg, rotateIntervalSec: interval, shuffle, syncWeatherTime: sync, rotateEnabled: playing };
}

/** Write a surface's config, routing Home's rotation fields to their original stores. */
export function patchSurface(s: Surface, p: Partial<SurfaceConfig>) {
  if (s === "home") {
    const { rotateIntervalSec, shuffle, syncWeatherTime, rotateEnabled, ...rest } = p;
    const set: Record<string, unknown> = {};
    if (rotateIntervalSec != null) set.wallpaperIntervalSec = rotateIntervalSec;
    if (shuffle != null) set.wallpaperShuffle = shuffle;
    if (syncWeatherTime != null) set.wallpaperSync = syncWeatherTime;
    if (Object.keys(set).length) useSettings.getState().set(set);
    if (rotateEnabled != null) useWallpapers.getState().setPlaying(rotateEnabled);
    if (Object.keys(rest).length) useBackdrops.getState().patch("home", rest);
    return;
  }
  useBackdrops.getState().patch(s, p);
}
