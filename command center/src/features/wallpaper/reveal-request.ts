import { create } from "zustand";

/**
 * A one-shot "show the wallpaper controls" request (not saved): the System Map HUD gear asks for
 * it when it opens the manager, so the rotation and upload panels are on screen even if they were
 * hidden or made icons in an earlier session. Only that click reveals them; a plain tab change
 * never re-adds panels Nic hid on purpose.
 */
export const useWallpaperReveal = create<{ pending: boolean; request: () => void; consume: () => boolean }>((set, get) => ({
  pending: false,
  request: () => set({ pending: true }),
  consume: () => {
    const was = get().pending;
    if (was) set({ pending: false });
    return was;
  },
}));
