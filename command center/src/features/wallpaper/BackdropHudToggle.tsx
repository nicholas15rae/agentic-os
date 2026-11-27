import { ImagePlus, Settings2 } from "lucide-react";
import { useNav } from "@/stores/nav";
import { useBackdrops, patchSurface, useSurfaceConfig } from "./backdrop-store";
import { useBackdropActive } from "./SurfaceBackdropLayer";
import type { Surface } from "./backdrop-model";
import { useWallpaperReveal } from "./reveal-request";

/**
 * In-page HUD pill: `Backdrop: Clean / Custom` (one click, no page change) plus a gear that opens
 * the Wallpaper manager on this surface's tab.
 */
export function BackdropHudToggle({ surface }: { surface: Exclude<Surface, "home"> }) {
  const cfg = useSurfaceConfig(surface);
  const active = useBackdropActive(surface);
  const empty = cfg.enabled && !active;
  const openManager = () => {
    useBackdrops.getState().setTab(surface);
    // The manager opens with this surface's rotation and upload controls on screen.
    useWallpaperReveal.getState().request();
    useNav.getState().go("wallpapers");
  };
  return (
    <>
      <button
        type="button"
        className="sysmap-ctl"
        aria-pressed={cfg.enabled}
        onClick={() => (empty ? openManager() : patchSurface(surface, { enabled: !cfg.enabled }))}
        title={empty ? "Custom backdrop is on but no wallpapers are assigned to this page — click to add some" : cfg.enabled ? "Switch to Clean Minimal" : "Switch to the custom rolling backdrop"}
      >
        <span className="flex items-center gap-1.5">
          <ImagePlus size={12} aria-hidden /> Backdrop: {cfg.enabled ? (empty ? "Custom (empty)" : "Custom") : "Clean"}
        </span>
      </button>
      <button type="button" className="sysmap-ctl" onClick={openManager} aria-label="Backdrop settings for this page" title="Backdrop settings for this page">
        <Settings2 size={13} />
      </button>
    </>
  );
}
