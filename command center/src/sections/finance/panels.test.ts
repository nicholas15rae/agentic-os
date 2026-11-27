import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/FinanceSection", () => ({ FinanceFilters: () => null, FinanceStats: () => null, FinanceTodo: () => null, SavingsSummary: () => null, goTo: () => true }));

import { FINANCE_DEFAULT_DESKTOP, FINANCE_DEFAULT_WEB, FINANCE_PANELS, FINANCE_SURFACE, useFinanceLayout } from "./panels";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Finance on the shared layout", () => {
  it("every panel is a Finance page panel", () => {
    for (const p of FINANCE_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [FINANCE_SURFACE], panel: true });
  });

  it("both defaults fill the board with no overlaps and hold every panel", () => {
    for (const d of [FINANCE_DEFAULT_DESKTOP, FINANCE_DEFAULT_WEB]) {
      for (const i of d) expect(fits(d, i)).toBe(true);
      expect(d.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
      for (const p of FINANCE_PANELS) expect(d.some((i) => i.widgetId === p.id)).toBe(true);
    }
  });

  it("icons open at their panel's full size", () => {
    for (const i of FINANCE_DEFAULT_DESKTOP.filter((x) => x.display === "icon")) expect(i.fullSize).toEqual(getWidget(i.widgetId)?.defaultSize);
  });

  it("Reset brings the filters back", () => {
    useFinanceLayout.getState().remove("filters");
    expect(useFinanceLayout.getState().pages[0].items.some((i) => i.widgetId === "fi-filters")).toBe(false);
    useFinanceLayout.getState().reset();
    expect(useFinanceLayout.getState().pages[0].items.some((i) => i.widgetId === "fi-filters")).toBe(true);
  });
});
