import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/OperationsSection", () => ({ OpsDesktopNotice: () => null, OpsBusinesses: () => null, OpsReview: () => null, OpsAudit: () => null, OpsDigest: () => null }));

import { OPERATIONS_DEFAULT_DESKTOP, OPERATIONS_DEFAULT_WEB, OPERATIONS_PANELS, OPERATIONS_SURFACE, useOperationsLayout } from "./panels";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Operations on the shared layout", () => {
  it("every panel is an Operations page panel", () => {
    for (const p of OPERATIONS_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [OPERATIONS_SURFACE], panel: true });
  });

  it("both defaults fill the board with no overlaps (web: only the desktop-app notice)", () => {
    for (const d of [OPERATIONS_DEFAULT_DESKTOP, OPERATIONS_DEFAULT_WEB]) {
      for (const i of d) expect(fits(d, i)).toBe(true);
      expect(d.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
    }
    const byId = new Map(OPERATIONS_PANELS.map((p) => [p.id, p]));
    for (const i of OPERATIONS_DEFAULT_DESKTOP) expect(byId.get(i.widgetId)?.platforms ?? ["desktop"]).toContain("desktop");
    for (const i of OPERATIONS_DEFAULT_WEB) expect(byId.get(i.widgetId)?.platforms ?? ["pwa"]).toContain("pwa");
  });

  it("Reset restores the finished template", () => {
    const first = useOperationsLayout.getState().pages[0].items[0];
    useOperationsLayout.getState().remove(first.instanceId);
    useOperationsLayout.getState().reset();
    expect(useOperationsLayout.getState().pages[0].items.some((i) => i.widgetId === first.widgetId)).toBe(true);
  });
});
