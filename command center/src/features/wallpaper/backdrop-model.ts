/**
 * Multi-surface backdrops (pure, unit-tested): which wallpapers belong to which surface, each
 * surface's settings and defaults, the v1 → v2 metadata migration, and the rotation pool.
 */
import type { Atmosphere, TimePhase } from "@/features/weather/weather-store";

export type Surface = "home" | "flowchart" | "orbital";
export const SURFACES: readonly Surface[] = ["home", "flowchart", "orbital"];
export const SURFACE_LABEL: Readonly<Record<Surface, string>> = { home: "Home", flowchart: "Schematic Flowchart", orbital: "Orbital Ecosystem" };
export const SURFACE_SHORT: Readonly<Record<Surface, string>> = { home: "Home", flowchart: "Flowchart", orbital: "Orbital" };

export interface SurfaceConfig {
  /** Custom Rolling Backdrop on; off = Clean Minimal (the page's own procedural look). */
  enabled: boolean;
  rotateEnabled: boolean;
  rotateIntervalSec: number;
  shuffle: boolean;
  syncWeatherTime: boolean;
  /** Manual lock on one backdrop (null = rotate through the pool). */
  pinnedWallpaperId: string | null;
  /** Image opacity, 0–100 %. */
  opacity: number;
  /** Obsidian scrim darkness, 0–85 %. */
  dimmer: number;
  /** 0–16 px. */
  blurPx: number;
  vignette: boolean;
}

export const SURFACE_DEFAULTS: Readonly<Record<Surface, SurfaceConfig>> = {
  home: { enabled: true, rotateEnabled: true, rotateIntervalSec: 45, shuffle: false, syncWeatherTime: true, pinnedWallpaperId: null, opacity: 100, dimmer: 0, blurPx: 0, vignette: true },
  flowchart: { enabled: false, rotateEnabled: true, rotateIntervalSec: 50, shuffle: false, syncWeatherTime: false, pinnedWallpaperId: null, opacity: 35, dimmer: 50, blurPx: 2, vignette: true },
  orbital: { enabled: false, rotateEnabled: true, rotateIntervalSec: 50, shuffle: false, syncWeatherTime: false, pinnedWallpaperId: null, opacity: 55, dimmer: 35, blurPx: 0, vignette: true },
};

/** Keep a stored config in range, filling anything missing from the surface's defaults. Pure. */
export function sanitizeConfig(surface: Surface, c: Partial<SurfaceConfig> | undefined): SurfaceConfig {
  const d = SURFACE_DEFAULTS[surface];
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  return {
    enabled: bool(c?.enabled, d.enabled),
    rotateEnabled: bool(c?.rotateEnabled, d.rotateEnabled),
    rotateIntervalSec: num(c?.rotateIntervalSec, 5, 3600, d.rotateIntervalSec),
    shuffle: bool(c?.shuffle, d.shuffle),
    syncWeatherTime: bool(c?.syncWeatherTime, d.syncWeatherTime),
    pinnedWallpaperId: typeof c?.pinnedWallpaperId === "string" ? c.pinnedWallpaperId : null,
    opacity: num(c?.opacity, 0, 100, d.opacity),
    dimmer: num(c?.dimmer, 0, 85, d.dimmer),
    blurPx: num(c?.blurPx, 0, 16, d.blurPx),
    vignette: bool(c?.vignette, d.vignette),
  };
}

/** The minimum a wallpaper needs for pooling. */
export interface PoolItem {
  id: string;
  enabled: boolean;
  src?: string;
  surfaces?: Surface[];
  tags: { atmospheres: Atmosphere[]; phases: TimePhase[] };
}

/** v1 records had no `surfaces`: every existing wallpaper stays on Home. Pure. */
export function surfacesOf(w: { surfaces?: unknown }): Surface[] {
  if (!Array.isArray(w.surfaces)) return ["home"];
  return SURFACES.filter((s) => (w.surfaces as unknown[]).includes(s));
}

/** Best-fit wallpapers for now (weather 2, time 1); every one when none is tagged for now. Pure. */
export function bestFit<T extends PoolItem>(pool: T[], atmosphere: Atmosphere, phase: TimePhase): T[] {
  const score = (w: T) => (w.tags.atmospheres.includes(atmosphere) ? 2 : 0) + (w.tags.phases.includes(phase) ? 1 : 0);
  const best = Math.max(0, ...pool.map(score));
  return best > 0 ? pool.filter((w) => score(w) === best) : pool;
}

/**
 * The rotation pool for a surface: enabled, loaded wallpapers assigned to it, narrowed to the
 * best fit for now when weather / time sync is on; a valid pin wins outright. Pure.
 */
export function surfacePool<T extends PoolItem>(items: T[], surface: Surface, cfg: Pick<SurfaceConfig, "syncWeatherTime" | "pinnedWallpaperId">, atmosphere: Atmosphere, phase: TimePhase): T[] {
  const pool = items.filter((i) => i.enabled && i.src && surfacesOf(i).includes(surface));
  const pinned = cfg.pinnedWallpaperId ? pool.find((i) => i.id === cfg.pinnedWallpaperId) : undefined;
  if (pinned) return [pinned];
  return cfg.syncWeatherTime ? bestFit(pool, atmosphere, phase) : pool;
}

/** Next id in a pool (shuffle never repeats the current one); the head when current fell out. Pure. */
export function nextInPool(ids: readonly string[], current: string | null, shuffle: boolean, rnd: () => number = Math.random): string | null {
  if (!ids.length) return null;
  const idx = current ? ids.indexOf(current) : -1;
  if (idx < 0) return ids[shuffle ? Math.floor(rnd() * ids.length) : 0];
  if (ids.length < 2) return ids[idx];
  if (shuffle) {
    let n = idx;
    for (let i = 0; i < 8 && n === idx; i++) n = Math.floor(rnd() * ids.length);
    return ids[n === idx ? (idx + 1) % ids.length : n];
  }
  return ids[(idx + 1) % ids.length];
}

/** Toggle a surface on a wallpaper's assignment list (order stays canonical). Pure. */
export function toggleSurface(list: Surface[], s: Surface): Surface[] {
  const has = list.includes(s);
  return SURFACES.filter((x) => (x === s ? !has : list.includes(x)));
}
