import { create } from "zustand";
import { SETTINGS_TAB_EVENT, SETTINGS_TAB_KEY } from "./settings-tab";

/**
 * The open Settings tab, shared by the tab bar and the content panels. Remembered for the session
 * (sessionStorage), and a deep link (`requestSettingsTab`) switches it even while Settings is open.
 */
const TAB_IDS = ["services", "engine", "voice", "modes", "comms", "integrations", "business", "appearance", "security"];

function stored(): string {
  try {
    const t = sessionStorage.getItem(SETTINGS_TAB_KEY);
    return t && TAB_IDS.includes(t) ? t : "services";
  } catch {
    return "services";
  }
}

export const useSettingsTab = create<{ tab: string; set: (t: string) => void }>((set) => ({
  tab: stored(),
  set: (tab) => {
    if (!TAB_IDS.includes(tab)) return;
    set({ tab });
    try {
      sessionStorage.setItem(SETTINGS_TAB_KEY, tab);
    } catch {
      /* private mode */
    }
  },
}));

if (typeof window !== "undefined")
  window.addEventListener(SETTINGS_TAB_EVENT, (e) => {
    const t = (e as CustomEvent<unknown>).detail;
    if (typeof t === "string") useSettingsTab.getState().set(t);
  });
