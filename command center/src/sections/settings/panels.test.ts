import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/SettingsSection", () => ({ SettingsTabBar: () => null, SettingsContent: () => null }));

import { SETTINGS_DEFAULT, SETTINGS_PANELS, SETTINGS_SURFACE, useSettingsLayout } from "./panels";
import { useSettingsTab } from "./settings-tab-store";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Settings on the shared layout", () => {
  it("a tab bar and a content panel, centred like the old page", () => {
    for (const p of SETTINGS_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [SETTINGS_SURFACE], panel: true });
    for (const i of SETTINGS_DEFAULT) expect(fits(SETTINGS_DEFAULT, i)).toBe(true);
  });

  it("the shared tab switches; unknown tabs are ignored", () => {
    useSettingsTab.getState().set("modes");
    expect(useSettingsTab.getState().tab).toBe("modes");
    useSettingsTab.getState().set("nope");
    expect(useSettingsTab.getState().tab).toBe("modes");
  });

  it("Reset brings the content back", () => {
    useSettingsLayout.getState().remove("content");
    useSettingsLayout.getState().reset();
    expect(useSettingsLayout.getState().pages[0].items.some((i) => i.widgetId === "st-content")).toBe(true);
  });
});
