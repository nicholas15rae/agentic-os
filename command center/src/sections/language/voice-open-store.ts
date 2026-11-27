import { create } from "zustand";

/** Whether the Voice settings drawer is open: toggled from the tab bar, drawn in the content panel. */
export const useHubVoiceOpen = create<{ open: boolean; toggle: () => void; close: () => void }>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
