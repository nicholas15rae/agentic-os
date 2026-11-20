/**
 * Deep links into a Settings tab. The tab is remembered in sessionStorage (read when Settings
 * mounts) AND announced with a window event, so a Settings view that is already mounted on another
 * tab switches too (it only reads storage in its initial state). Pure of React: safe to import
 * from small widgets without pulling in the Settings section.
 */
export const SETTINGS_TAB_KEY = "cc.settings.tab";
export const SETTINGS_TAB_EVENT = "cc-settings-tab";

export function requestSettingsTab(tab: string): void {
  try {
    sessionStorage.setItem(SETTINGS_TAB_KEY, tab);
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent(SETTINGS_TAB_EVENT, { detail: tab }));
  } catch {
    /* no window (tests / SSR) */
  }
}
