import { create } from "zustand";
import { persist } from "zustand/middleware";
import { del, get as idbGet, set as idbSet } from "idb-keyval";
import type { Atmosphere, TimePhase } from "@/features/weather/weather-store";
import { surfacesOf, toggleSurface, type Surface } from "./backdrop-model";

/**
 * Wallpapers = built-in files in /public/wallpapers + user uploads.
 * Uploads live as Blobs in IndexedDB (works identically in the Tauri webview
 * and the PWA, survives reloads, no filesystem permission needed).
 * Only metadata is in localStorage; object URLs are rebuilt on load.
 */
export interface Wallpaper {
  id: string;
  name: string;
  builtin: boolean;
  enabled: boolean;
  /** Runtime-only object URL or public path. */
  src?: string;
  /** Conditions this scene suits. Empty = generic (used when nothing matches). */
  tags: WallpaperTags;
  /** Surfaces whose rolling pool it joins (v1 records: Home only). */
  surfaces: Surface[];
}

export interface WallpaperTags {
  atmospheres: Atmosphere[];
  phases: TimePhase[];
}

/** Base-relative so the same build works at / (Tauri) and /cc/ (gateway-served PWA). */
const asset = (p: string) => import.meta.env.BASE_URL + p;

const tag = (atmospheres: Atmosphere[], phases: TimePhase[]): WallpaperTags => ({ atmospheres, phases });

const BUILTINS: Wallpaper[] = [
  { id: "drift-fog", name: "Drift Fog", builtin: true, enabled: true, surfaces: ["home"], src: asset("wallpapers/01-drift-fog.jpg"), tags: tag(["fog", "rain"], ["night"]) },
  { id: "skyline", name: "Skyline", builtin: true, enabled: true, surfaces: ["home"], src: asset("wallpapers/02-skyline.jpg"), tags: tag(["midnight", "clear", "autumn"], ["night"]) },
  { id: "pine-mist", name: "Pine Mist", builtin: true, enabled: true, surfaces: ["home"], src: asset("wallpapers/03-pine-mist.jpg"), tags: tag(["fog", "rain"], ["day"]) },
  { id: "milky-way", name: "Milky Way", builtin: true, enabled: true, surfaces: ["home"], src: asset("wallpapers/04-milky-way.jpg"), tags: tag(["midnight", "clear"], ["night"]) },
  { id: "golden-pch", name: "Golden PCH", builtin: true, enabled: true, surfaces: ["home"], src: asset("wallpapers/05-golden-pch.jpg"), tags: tag(["clear", "autumn"], ["golden", "day"]) },
  { id: "rain-district", name: "Rain District", builtin: true, enabled: true, surfaces: ["home"], src: asset("wallpapers/06-rain-district.jpg"), tags: tag(["rain"], ["night"]) },
];

/**
 * Wallpapers that best fit the current conditions. Score: weather match 2,
 * time-of-day match 1. Returns the top-scoring set, or every enabled
 * wallpaper when nothing is tagged for these conditions (e.g. snow with no
 * snow scenes uploaded yet).
 */
export function matchingWallpapers(items: Wallpaper[], atmosphere: Atmosphere, phase: TimePhase): Wallpaper[] {
  const pool = items.filter((i) => i.enabled && i.src);
  if (!pool.length) return [];
  const score = (w: Wallpaper) => (w.tags.atmospheres.includes(atmosphere) ? 2 : 0) + (w.tags.phases.includes(phase) ? 1 : 0);
  const best = Math.max(0, ...pool.map(score));
  return best > 0 ? pool.filter((w) => score(w) === best) : pool;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const idbKey = (id: string) => `wallpaper:${id}`;

interface WallpaperState {
  items: Wallpaper[];
  currentId: string;
  playing: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** `allowed` limits rotation to these ids (weather/time sync). */
  next: (dir?: 1 | -1, shuffle?: boolean, allowed?: string[]) => void;
  setTags: (id: string, tags: WallpaperTags) => void;
  select: (id: string) => void;
  setPlaying: (v: boolean) => void;
  toggleEnabled: (id: string) => void;
  /** Add / remove a wallpaper from one surface's rolling pool. */
  toggleSurface: (id: string, surface: Surface) => void;
  /** New uploads join `surfaces` (default: Home). */
  upload: (files: FileList | File[], surfaces?: Surface[]) => Promise<{ added: number; rejected: string[]; ids: string[] }>;
  remove: (id: string) => Promise<void>;
}

export const useWallpapers = create<WallpaperState>()(
  persist(
    (set, get) => ({
      items: BUILTINS,
      currentId: BUILTINS[0].id,
      playing: true,
      hydrated: false,

      hydrate: async () => {
        // Merge persisted metadata with builtins (new builtins appear automatically),
        // then rebuild object URLs for uploads.
        const persisted = get().items;
        const merged: Wallpaper[] = BUILTINS.map((b) => {
          const p = persisted.find((x) => x.id === b.id);
          return { ...b, enabled: p?.enabled ?? true, tags: p?.tags ?? b.tags, surfaces: p ? surfacesOf(p) : b.surfaces };
        });
        for (const p of persisted.filter((x) => !x.builtin)) {
          // A re-hydrate (StrictMode, HMR) must not leak the previous object URL.
          if (p.src?.startsWith("blob:")) URL.revokeObjectURL(p.src);
          const blob = await idbGet<Blob>(idbKey(p.id)).catch(() => undefined);
          if (blob) merged.push({ ...p, tags: p.tags ?? tag([], []), surfaces: surfacesOf(p), src: URL.createObjectURL(blob) });
        }
        const currentId = merged.some((m) => m.id === get().currentId) ? get().currentId : merged[0].id;
        set({ items: merged, currentId, hydrated: true });
      },

      next: (dir = 1, shuffle = false, allowed) => {
        const pool = get().items.filter((i) => i.enabled && i.src && (!allowed || allowed.includes(i.id)));
        if (!pool.length) return;
        const idx = pool.findIndex((i) => i.id === get().currentId);
        // Conditions changed and the current scene no longer fits: jump into the pool.
        if (idx < 0) return set({ currentId: pool[shuffle ? Math.floor(Math.random() * pool.length) : 0].id });
        if (pool.length < 2) return;
        let nextIdx: number;
        if (shuffle) {
          do nextIdx = Math.floor(Math.random() * pool.length);
          while (nextIdx === idx);
        } else nextIdx = (idx + dir + pool.length) % pool.length;
        set({ currentId: pool[nextIdx].id });
      },

      select: (currentId) => set({ currentId }),
      setTags: (id, tags) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, tags } : i)) })),
      setPlaying: (playing) => set({ playing }),
      toggleEnabled: (id) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, enabled: !i.enabled } : i)) })),
      toggleSurface: (id, surface) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, surfaces: toggleSurface(surfacesOf(i), surface) } : i)) })),

      upload: async (files, surfaces = ["home"]) => {
        const rejected: string[] = [];
        const added: Wallpaper[] = [];
        for (const file of Array.from(files)) {
          if (!file.type.startsWith("image/")) {
            rejected.push(`${file.name}: not an image`);
            continue;
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            rejected.push(`${file.name}: larger than 25 MB`);
            continue;
          }
          const id = `u-${crypto.randomUUID().slice(0, 8)}`;
          await idbSet(idbKey(id), file);
          added.push({
            id,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 40),
            builtin: false,
            enabled: true,
            src: URL.createObjectURL(file),
            tags: tag([], []),
            surfaces: [...surfaces],
          });
        }
        // Only a Home upload jumps the Home slideshow to it.
        if (added.length) set((s) => ({ items: [...s.items, ...added], currentId: surfaces.includes("home") ? added[0].id : s.currentId }));
        return { added: added.length, rejected, ids: added.map((a) => a.id) };
      },

      remove: async (id) => {
        const item = get().items.find((i) => i.id === id);
        if (!item || item.builtin) return;
        await del(idbKey(id));
        if (item.src) URL.revokeObjectURL(item.src);
        set((s) => {
          const items = s.items.filter((i) => i.id !== id);
          return { items, currentId: s.currentId === id ? items[0].id : s.currentId };
        });
      },
    }),
    {
      name: "cc.wallpapers",
      version: 2,
      // v1 → v2: every existing wallpaper (built-in or uploaded) stays on Home only.
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as { items?: Partial<Wallpaper>[] };
        if (from < 2 && Array.isArray(p.items)) p.items = p.items.map((i) => ({ ...i, surfaces: surfacesOf(i) }));
        return p as never;
      },
      // Never persist object URLs â€” they die with the page.
      partialize: (s) => ({
        items: s.items.map(({ src: _src, ...rest }) => rest),
        currentId: s.currentId,
        playing: s.playing,
      }),
    },
  ),
);
