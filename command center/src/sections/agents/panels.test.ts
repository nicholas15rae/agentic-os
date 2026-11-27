import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/AgentsSection", () => ({ AgentThreadsBar: () => null, AgentChat: () => null, AgentReports: () => null, AgentLibrary: () => null }));

import { AGENTS_DEFAULT_DESKTOP, AGENTS_DEFAULT_WEB, AGENTS_PANELS, AGENTS_SURFACE, useAgentsLayout } from "./panels";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Agents on the shared layout", () => {
  it("every panel is an Agents page panel", () => {
    for (const p of AGENTS_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [AGENTS_SURFACE], panel: true });
  });

  it("both defaults fill the board with no overlaps (web: no desktop-only library)", () => {
    for (const d of [AGENTS_DEFAULT_DESKTOP, AGENTS_DEFAULT_WEB]) {
      for (const i of d) expect(fits(d, i)).toBe(true);
      expect(d.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
    }
    expect(AGENTS_DEFAULT_WEB.some((i) => i.widgetId === "ag-library")).toBe(false);
  });

  it("Reset brings the conversation back", () => {
    useAgentsLayout.getState().remove("chat");
    useAgentsLayout.getState().reset();
    expect(useAgentsLayout.getState().pages[0].items.some((i) => i.widgetId === "ag-chat")).toBe(true);
  });
});
