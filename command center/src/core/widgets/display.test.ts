import { beforeEach, describe, expect, it } from "vitest";
import { useLayout } from "./layout-store";
import type { WidgetInstance } from "./types";

const inst = (instanceId: string, widgetId: string, col: number, row: number, w: number, h: number): WidgetInstance => ({ instanceId, widgetId, col, row, w, h, config: {} });

describe("icon / compact / full and widget windows (section pass)", () => {
  beforeEach(() => {
    useLayout.setState({ pages: [{ id: "p", name: "P", items: [inst("wx", "weather", 1, 1, 3, 2), inst("rem", "reminders", 4, 1, 3, 3)] }], activePage: "p", windows: [], focused: null });
  });

  it("icon mode takes one cell and remembers the full size to come back to", () => {
    expect(useLayout.getState().setDisplay("wx", "icon")).toBe(true);
    let w = useLayout.getState().pages[0].items.find((i) => i.instanceId === "wx")!;
    expect([w.w, w.h, w.display, w.fullSize]).toEqual([1, 1, "icon", { w: 3, h: 2 }]);
    expect(useLayout.getState().setDisplay("wx", "full")).toBe(true);
    w = useLayout.getState().pages[0].items.find((i) => i.instanceId === "wx")!;
    expect([w.w, w.h, w.display, w.fullSize]).toEqual([3, 2, undefined, undefined]);
  });

  it("several windows can be open; opening again brings one to the front; a page switch closes them", () => {
    const L = useLayout.getState();
    L.openWindow("wx");
    L.openWindow("rem");
    expect(useLayout.getState().windows.map((w) => w.instanceId)).toEqual(["wx", "rem"]);
    L.openWindow("wx");
    const byId = (id: string) => useLayout.getState().windows.find((w) => w.instanceId === id)!;
    expect(byId("wx").z).toBeGreaterThan(byId("rem").z);
    // z stays a rank (1..n): clicking the front window again changes nothing, so it never climbs past modals.
    L.openWindow("wx");
    L.openWindow("wx");
    expect(Math.max(...useLayout.getState().windows.map((w) => w.z))).toBe(2);
    L.moveWindow("wx", { x: 10, w: 600 });
    expect(byId("wx")).toMatchObject({ x: 10, w: 600 });
    L.closeWindow("rem");
    expect(useLayout.getState().windows).toHaveLength(1);
    useLayout.setState({ pages: [...useLayout.getState().pages, { id: "q", name: "Q", items: [] }] });
    useLayout.getState().setActivePage("q");
    expect(useLayout.getState().windows).toEqual([]);
  });

  it("a look patch is saved on the widget", () => {
    useLayout.getState().setLook("rem", { frame: "frameless", scale: 1.2 });
    expect(useLayout.getState().pages[0].items.find((i) => i.instanceId === "rem")!.look).toEqual({ frame: "frameless", scale: 1.2 });
  });
});
