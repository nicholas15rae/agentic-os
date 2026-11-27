import { create } from "zustand";

/** Section pass: the short badge / live value each widget publishes for its app icon (not saved). */
export const useWidgetBadges = create<{ badges: Record<string, string>; set: (instanceId: string, badge: string | null) => void }>((set) => ({
  badges: {},
  set: (instanceId, badge) =>
    set((s) => {
      const cur = s.badges[instanceId];
      const next = badge?.trim().slice(0, 8) || null;
      if ((cur ?? null) === next) return s;
      const badges = { ...s.badges };
      if (next) badges[instanceId] = next;
      else delete badges[instanceId];
      return { badges };
    }),
}));
