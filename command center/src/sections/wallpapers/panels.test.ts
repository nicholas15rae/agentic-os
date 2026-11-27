import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/WallpapersSection", () => ({ WallpaperTabs: () => null, WallpaperRotation: () => null, WallpaperUpload: () => null, WallpaperGallery: () => null }));

import { WALLPAPERS_DEFAULT, WALLPAPERS_PANELS, WALLPAPERS_SURFACE, useWallpapersLayout } from "./panels";
import { useWallpaperUploadMsg } from "./upload-store";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Wallpapers on the shared layout", () => {
  it("every panel is a Wallpapers page panel, usable in a browser too", () => {
    for (const p of WALLPAPERS_PANELS) {
      expect(getWidget(p.id)).toMatchObject({ surfaces: [WALLPAPERS_SURFACE], panel: true });
      expect(p.platforms).toBeUndefined();
    }
  });

  it("the default fills the board with no overlaps and holds every panel", () => {
    for (const i of WALLPAPERS_DEFAULT) expect(fits(WALLPAPERS_DEFAULT, i)).toBe(true);
    expect(WALLPAPERS_DEFAULT.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
    expect(new Set(WALLPAPERS_DEFAULT.map((i) => i.widgetId))).toEqual(new Set(WALLPAPERS_PANELS.map((p) => p.id)));
  });

  it("the upload message is shared between the upload and gallery panels", () => {
    useWallpaperUploadMsg.getState().set("Added 2 wallpapers to Home.");
    expect(useWallpaperUploadMsg.getState().msg).toBe("Added 2 wallpapers to Home.");
    useWallpaperUploadMsg.getState().set(null);
  });

  it("Reset brings the gallery back", () => {
    useWallpapersLayout.getState().remove("gallery");
    useWallpapersLayout.getState().reset();
    expect(useWallpapersLayout.getState().pages[0].items.some((i) => i.widgetId === "wp-gallery")).toBe(true);
  });
});
