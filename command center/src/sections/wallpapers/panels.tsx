import { lazy } from "react";
import { Images, PanelTop, SlidersHorizontal, Upload } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";

/**
 * Wallpapers on the shared layout system (AGENTS.md, "Everything Is Customizable"): the surface
 * tabs, the rotation / backdrop controls, uploads and the gallery are panels on the same 12x8 grid
 * as the home page (move, resize, hide, add back, icon, window, per mode, Reset to default).
 * Everything works in a browser too (uploads live in IndexedDB), so one default serves both.
 */
export const WALLPAPERS_SURFACE = "wallpapers";

type Body = React.ComponentType<WidgetProps>;

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<Body>, size: { w: number; h: number }, compactOrder: number, extra: Partial<WidgetDefinition> = {}): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 3, h: 1 },
  defaultConfig: {},
  surfaces: [WALLPAPERS_SURFACE],
  panel: true,
  compactOrder,
  ...extra,
  component: lazy(async () => ({ default: await load() })),
});

const page = () => import("@/sections/WallpapersSection");

export const WALLPAPERS_PANELS: WidgetDefinition[] = [
  panel("wp-tabs", "Backdrop surfaces", "Home, Schematic Flowchart, Orbital Ecosystem or the whole library.", PanelTop, async () => (await page()).WallpaperTabs, { w: 8, h: 1 }, 1),
  panel(
    "wp-rotation",
    "Rotation and blend",
    "Clean Minimal / Custom backdrop, rotate interval, shuffle, weather & time sync, pin and the readability blend.",
    SlidersHorizontal,
    async () => (await page()).WallpaperRotation,
    { w: 8, h: 2 },
    2,
  ),
  panel("wp-upload", "Upload wallpapers", "Add images to the open surface; they stay on this device (IndexedDB) and work offline.", Upload, async () => (await page()).WallpaperUpload, { w: 4, h: 3 }, 3),
  panel("wp-gallery", "Gallery", "Every wallpaper: pick, tag weather and time, pin, include / exclude, share with other surfaces, delete uploads. Drop images here.", Images, async () => (await page()).WallpaperGallery, { w: 12, h: 5 }, 4, { minSize: { w: 3, h: 2 } }),
];
for (const p of WALLPAPERS_PANELS) registerWidget(p);

/**
 * The finished template (what Reset restores): tabs and rotation controls across the top with the
 * upload panel beside them, the gallery underneath at full width.
 */
export const WALLPAPERS_DEFAULT: WidgetInstance[] = [
  { instanceId: "tabs", widgetId: "wp-tabs", col: 1, row: 1, w: 8, h: 1, config: {} },
  { instanceId: "rotation", widgetId: "wp-rotation", col: 1, row: 2, w: 8, h: 2, config: {} },
  { instanceId: "upload", widgetId: "wp-upload", col: 9, row: 1, w: 4, h: 3, config: {} },
  { instanceId: "gallery", widgetId: "wp-gallery", col: 1, row: 4, w: 12, h: 5, config: {} },
];

export const useWallpapersLayout = surfaceStore({ surface: WALLPAPERS_SURFACE, defaults: WALLPAPERS_DEFAULT });
