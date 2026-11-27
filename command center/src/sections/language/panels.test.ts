import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/LanguageSection", () => ({ LanguageTabBar: () => null, LanguageContent: () => null }));

import { LANGUAGE_DEFAULT, LANGUAGE_PANELS, LANGUAGE_SURFACE, useLanguageLayout } from "./panels";
import { useHubVoiceOpen } from "./voice-open-store";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Language Hub on the shared layout", () => {
  it("a tab bar and a content panel, centred like the old page", () => {
    for (const p of LANGUAGE_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [LANGUAGE_SURFACE], panel: true });
    for (const i of LANGUAGE_DEFAULT) expect(fits(LANGUAGE_DEFAULT, i)).toBe(true);
    for (const i of LANGUAGE_DEFAULT) expect(i.col + i.w - 1 <= 12 && i.row + i.h - 1 <= 8).toBe(true);
  });

  it("the Voice drawer is shared state between the tab bar and the content", () => {
    useHubVoiceOpen.getState().toggle();
    expect(useHubVoiceOpen.getState().open).toBe(true);
    useHubVoiceOpen.getState().close();
    expect(useHubVoiceOpen.getState().open).toBe(false);
  });

  it("Reset brings the content back", () => {
    useLanguageLayout.getState().remove("content");
    useLanguageLayout.getState().reset();
    expect(useLanguageLayout.getState().pages[0].items.some((i) => i.widgetId === "lg-content")).toBe(true);
  });
});
