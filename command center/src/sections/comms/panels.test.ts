import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/CommsSection", () => ({
  CommsThreads: () => null,
  CommsChat: () => null,
  CommsAgentReports: () => null,
  DialPad: () => null,
  RecentCalls: () => null,
  PhoneBook: () => null,
  WhatsAppPanel: () => null,
  BridgeSetup: () => null,
}));

import { COMMS_DEFAULT_ANDROID, COMMS_DEFAULT_DESKTOP, COMMS_DEFAULT_WEB, COMMS_PANELS, COMMS_SURFACE, useCommsLayout } from "./panels";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Comms on the shared layout", () => {
  it("every panel is a Comms page panel", () => {
    for (const p of COMMS_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [COMMS_SURFACE], panel: true });
  });

  it("both defaults fill the board with no overlaps (web: no desktop-only panels)", () => {
    for (const d of [COMMS_DEFAULT_DESKTOP, COMMS_DEFAULT_WEB, COMMS_DEFAULT_ANDROID]) {
      for (const i of d) expect(fits(d, i)).toBe(true);
      expect(d.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
    }
    const desktopOnly = COMMS_PANELS.filter((p) => p.platforms?.length === 1 && p.platforms[0] === "desktop").map((p) => p.id);
    expect(desktopOnly.sort()).toEqual(["cm-agents", "cm-whatsapp"]);
    expect(COMMS_DEFAULT_WEB.some((i) => desktopOnly.includes(i.widgetId))).toBe(false);
    // Every panel is in the desktop template.
    expect(COMMS_PANELS.every((p) => COMMS_DEFAULT_DESKTOP.some((i) => i.widgetId === p.id))).toBe(true);
  });

  it("Reset brings the conversation back", () => {
    useCommsLayout.getState().remove("chat");
    expect(useCommsLayout.getState().pages[0].items.some((i) => i.widgetId === "cm-chat")).toBe(false);
    useCommsLayout.getState().reset();
    expect(useCommsLayout.getState().pages[0].items.some((i) => i.widgetId === "cm-chat")).toBe(true);
  });
});
