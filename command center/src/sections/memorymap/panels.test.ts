import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/MemoryMapSection", () => ({ SmStatusBar: () => null, SmFlowchart: () => null, SmStage: () => null, SmTrace: () => null, SmNote: () => null, SmDock: () => null, SmLeft: () => null }));

import { SYSTEMMAP_DEFAULT, SYSTEMMAP_PANELS, SYSTEMMAP_SURFACE, useSystemMapLayout } from "./panels";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("System Map on the shared layout", () => {
  it("every panel is a System Map panel", () => {
    for (const p of SYSTEMMAP_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [SYSTEMMAP_SURFACE], panel: true });
  });

  it("the default fills the board with no overlaps and leaves the flowchart on the stage", () => {
    for (const i of SYSTEMMAP_DEFAULT) expect(fits(SYSTEMMAP_DEFAULT, i)).toBe(true);
    expect(SYSTEMMAP_DEFAULT.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
    expect(SYSTEMMAP_DEFAULT.some((i) => i.widgetId === "sm-flow")).toBe(false);
    for (const id of ["sm-status", "sm-left", "sm-stage", "sm-dock", "sm-trace", "sm-note"]) expect(SYSTEMMAP_DEFAULT.some((i) => i.widgetId === id)).toBe(true);
  });

  it("Reset brings the car stage back", () => {
    useSystemMapLayout.getState().remove("stage");
    useSystemMapLayout.getState().reset();
    expect(useSystemMapLayout.getState().pages[0].items.some((i) => i.widgetId === "sm-stage")).toBe(true);
  });
});
