import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/TradingSection", () => ({ TradingToolbar: () => null, TradingWatchlist: () => null, TradingChart: () => null, TradingNews: () => null, TradingZones: () => null }));

import { TRADING_DEFAULT, TRADING_PANELS, TRADING_SURFACE, useTradingLayout } from "./panels";
import { getWidget, isLockedWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Trading on the shared layout", () => {
  it("every panel is a Trading page panel", () => {
    for (const p of TRADING_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [TRADING_SURFACE], panel: true });
  });

  it("the execution desk (kill switch / E-stop) is the one locked panel", () => {
    expect(isLockedWidget("tr-desk")).toBe(true);
    expect(TRADING_PANELS.filter((p) => p.locked).map((p) => p.id)).toEqual(["tr-desk"]);
    expect(TRADING_DEFAULT.some((i) => i.widgetId === "tr-desk")).toBe(true);
  });

  it("the default fills the board with no overlaps and holds every panel", () => {
    for (const i of TRADING_DEFAULT) expect(fits(TRADING_DEFAULT, i)).toBe(true);
    // One spare cell on the icon row lets the wallpaper breathe.
    expect(TRADING_DEFAULT.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8 - 1);
    expect(new Set(TRADING_DEFAULT.map((i) => i.widgetId))).toEqual(new Set(TRADING_PANELS.map((p) => p.id)));
  });

  it("the desk can't be removed or turned into an icon", () => {
    const desk = () => useTradingLayout.getState().pages.flatMap((p) => p.items).find((i) => i.widgetId === "tr-desk");
    useTradingLayout.getState().remove(desk()!.instanceId);
    expect(desk()).toBeDefined();
  });

  it("Reset brings the chart back", () => {
    useTradingLayout.getState().remove("chart");
    expect(useTradingLayout.getState().pages[0].items.some((i) => i.widgetId === "tr-chart")).toBe(false);
    useTradingLayout.getState().reset();
    expect(useTradingLayout.getState().pages[0].items.some((i) => i.widgetId === "tr-chart")).toBe(true);
  });
});
