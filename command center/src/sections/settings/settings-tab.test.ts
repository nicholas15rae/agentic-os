import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_TAB_EVENT, SETTINGS_TAB_KEY, requestSettingsTab } from "./settings-tab";

/** Fix pass: "Manage modes…" must switch a Settings view that is already open on another tab. */
describe("requestSettingsTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("remembers the tab and announces it to a mounted Settings view", () => {
    const store = new Map<string, string>();
    const events: { type: string; detail: unknown }[] = [];
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal("window", { dispatchEvent: (e: CustomEvent) => (events.push({ type: e.type, detail: e.detail }), true) });
    requestSettingsTab("modes");
    expect(store.get(SETTINGS_TAB_KEY)).toBe("modes");
    expect(events).toEqual([{ type: SETTINGS_TAB_EVENT, detail: "modes" }]);
  });

  it("never throws without storage or a window", () => {
    vi.stubGlobal("sessionStorage", undefined);
    vi.stubGlobal("window", undefined);
    expect(() => requestSettingsTab("voice")).not.toThrow();
  });

  it("SettingsSection listens for it, and the deep links use it", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(read("../SettingsSection.tsx")).toMatch(/addEventListener\(SETTINGS_TAB_EVENT/);
    expect(read("../../widgets/tony-mode/ModePanel.tsx")).toMatch(/requestSettingsTab\("modes"\)/);
  });
});
