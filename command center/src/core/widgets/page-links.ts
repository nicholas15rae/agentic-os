import { useLayout } from "./layout-store";
import { pageForMode } from "./pages";
import { useModes } from "@/features/modes/modes-store";
import { useWallpapers } from "@/features/wallpaper/wallpaper-store";

/**
 * Section pass, page presets: a page can be linked to one of Tony's modes and carry its own
 * wallpaper.
 * - Switching Tony's mode (voice, top bar) opens the page linked to it.
 * - Opening a linked page switches Tony to its mode.
 * - A page with its own wallpaper shows it and pauses the rotation; leaving it for a page without
 *   one resumes the rotation if it was running.
 * Each side only acts when the other differs, so the two never ping-pong.
 */
export function installPageLinks(): () => void {
  let resumeRotation: boolean | null = null;

  const applyWallpaper = () => {
    const s = useLayout.getState();
    const page = s.pages.find((p) => p.id === s.activePage);
    const wp = useWallpapers.getState();
    if (page?.wallpaper && wp.items.some((w) => w.id === page.wallpaper)) {
      if (resumeRotation === null) resumeRotation = wp.playing;
      if (wp.currentId !== page.wallpaper) wp.select(page.wallpaper);
      if (wp.playing) wp.setPlaying(false);
    } else if (resumeRotation !== null) {
      if (resumeRotation && !wp.playing) wp.setPlaying(true);
      resumeRotation = null;
    }
  };

  const offMode = useModes.subscribe((m, prev) => {
    if (m.activeId === prev.activeId) return;
    const page = pageForMode(useLayout.getState().pages, m.activeId);
    if (page && page.id !== useLayout.getState().activePage) useLayout.getState().setActivePage(page.id);
  });

  const offPage = useLayout.subscribe((s, prev) => {
    if (s.activePage === prev.activePage) return;
    const page = s.pages.find((p) => p.id === s.activePage);
    const modes = useModes.getState();
    if (page?.mode && page.mode !== modes.activeId && modes.modes.some((m) => m.id === page.mode)) void modes.setActive(page.mode).catch(() => undefined);
    applyWallpaper();
  });

  applyWallpaper();
  return () => {
    offMode();
    offPage();
  };
}
