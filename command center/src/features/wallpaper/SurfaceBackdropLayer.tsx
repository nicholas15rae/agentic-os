import { useEffect, useMemo, useState } from "react";
import { useAtmosphere, useTimePhase } from "@/features/weather/weather-store";
import { useWallpapers } from "./wallpaper-store";
import { nextInPool, surfacePool, type Surface } from "./backdrop-model";
import { useBackdrops, useSurfaceConfig } from "./backdrop-store";
import { useMotionLevel } from "@/lib/motion";

/** Window in use: not hidden / minimised, not calm (lib/motion.ts). Each crossfade is 1.2 s of frames. */
function useDocVisible(): boolean {
  return useMotionLevel() === "full";
}

/**
 * Is a System Map surface showing a custom backdrop right now (on, and its pool has at least one
 * loaded image)? Pages use it to go transparent; false = Clean Minimal.
 */
export function useBackdropActive(surface: Surface): boolean {
  const cfg = useSurfaceConfig(surface);
  const items = useWallpapers((s) => s.items);
  const atmosphere = useAtmosphere();
  const phase = useTimePhase();
  return cfg.enabled && surfacePool(items, surface, cfg, atmosphere, phase).length > 0;
}

/**
 * A surface's rolling backdrop (Schematic Flowchart / Orbital Ecosystem): two stacked layers, the
 * next image decoded off-screen first, then a 1.2 s opacity crossfade (compositor-only, no layout
 * shift). Opacity, an obsidian scrim, blur and a radial vignette keep the page's HUD legible.
 *
 * Discipline: the parent mounts it only while its page is showing; the rotation timer runs only
 * while the window is visible; at most two decoded images are alive (the outgoing layer is dropped
 * after the fade). The image URLs are the wallpaper store's one-per-item object URLs (shared with
 * the thumbnails and revoked by the store on delete), so this layer never creates or leaks one.
 * Renders nothing — Clean Minimal — when the surface is off or its pool is empty.
 */
export function SurfaceBackdropLayer({ surface }: { surface: Exclude<Surface, "home"> }) {
  const cfg = useSurfaceConfig(surface);
  const items = useWallpapers((s) => s.items);
  const hydrated = useWallpapers((s) => s.hydrated);
  const atmosphere = useAtmosphere();
  const phase = useTimePhase();
  const visible = useDocVisible();
  const current = useBackdrops((s) => s.current[surface]);
  const setCurrent = useBackdrops((s) => s.setCurrent);
  const [layers, setLayers] = useState<{ key: string; src: string }[]>([]);

  useEffect(() => {
    if (!hydrated) void useWallpapers.getState().hydrate();
  }, [hydrated]);

  const pool = useMemo(() => surfacePool(items, surface, cfg, atmosphere, phase), [items, surface, cfg, atmosphere, phase]);
  const ids = useMemo(() => pool.map((p) => p.id), [pool]);
  const key = ids.join(",");
  const on = cfg.enabled && ids.length > 0;

  // Current fell out of the pool (conditions changed, unassigned, pinned): move into it now.
  useEffect(() => {
    if (!on) return;
    if (!current || !ids.includes(current)) setCurrent(surface, nextInPool(ids, null, cfg.shuffle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);

  // Rotation: only while on, visible, more than one image, not pinned.
  useEffect(() => {
    if (!on || !visible || !cfg.rotateEnabled || cfg.pinnedWallpaperId || ids.length < 2) return;
    const t = setInterval(() => {
      const cur = useBackdrops.getState().current[surface];
      setCurrent(surface, nextInPool(ids, cur, cfg.shuffle));
    }, Math.max(5, cfg.rotateIntervalSec) * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, visible, cfg.rotateEnabled, cfg.pinnedWallpaperId, cfg.rotateIntervalSec, cfg.shuffle, key, surface]);

  // Decode the incoming image off-screen, then crossfade; keep at most two layers.
  const src = on ? pool.find((p) => p.id === current)?.src : undefined;
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    img
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setLayers((prev) => (prev[prev.length - 1]?.src === src ? prev : [...prev.slice(-1), { key: `${src}-${Date.now()}`, src }]));
      });
    return () => {
      cancelled = true;
      img.src = "";
    };
  }, [src]);
  // Drop the outgoing layer once its fade is over (frees its decoded bitmap).
  useEffect(() => {
    if (layers.length < 2) return;
    const t = setTimeout(() => setLayers((prev) => prev.slice(-1)), 1400);
    return () => clearTimeout(t);
  }, [layers]);
  useEffect(() => {
    if (!on) setLayers([]);
  }, [on]);

  if (!on) return null;
  const blur = cfg.blurPx > 0 ? `blur(${cfg.blurPx}px)` : undefined;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden" data-backdrop={surface}>
      {layers.map((l, i) => (
        <div
          key={l.key}
          className="absolute inset-0 transition-opacity duration-[1200ms] ease-in-out starting:opacity-0"
          style={{ opacity: i === layers.length - 1 ? cfg.opacity / 100 : 0, willChange: "opacity" }}
        >
          {/* Overscan by the blur radius so blurred edges never show the page behind. */}
          <img src={l.src} alt="" draggable={false} className="absolute object-cover" style={{ inset: -cfg.blurPx * 2, width: `calc(100% + ${cfg.blurPx * 4}px)`, height: `calc(100% + ${cfg.blurPx * 4}px)`, filter: blur }} />
        </div>
      ))}
      <div className="absolute inset-0" style={{ background: `rgba(3,5,10,${cfg.dimmer / 100})` }} />
      {cfg.vignette && <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(2,3,8,0.78)_100%)]" />}
    </div>
  );
}
