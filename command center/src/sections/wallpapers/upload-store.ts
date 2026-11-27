import { create } from "zustand";

/**
 * The last upload result ("Added 3 wallpapers to Home.", rejections). Shared by the Upload panel
 * (its button) and the Gallery panel (drop target): they are separate panels on the shared layout,
 * so the message can't be one component's local state.
 */
export const useWallpaperUploadMsg = create<{ msg: string | null; set: (msg: string | null) => void }>((set) => ({
  msg: null,
  set: (msg) => set({ msg }),
}));
