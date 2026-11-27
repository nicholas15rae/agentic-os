import { lazy } from "react";
import { Shield, Square } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { createLayoutStore } from "./layout-store";
import { isLockedWidget, registerWidget } from "./registry";
import { clampFloat, floatFromGrid, sanitizeFloats, FLOAT_KEEP } from "./floating";
import type { WidgetDefinition, WidgetInstance } from "./types";

const Noop = lazy(async () => ({ default: () => null }));
const def = (id: string, extra: Partial<WidgetDefinition<any>> = {}): WidgetDefinition<any> => ({ id, title: id, description: id, icon: Square, defaultSize: { w: 3, h: 2 }, defaultConfig: {}, component: Noop, surfaces: ["float-test"], ...extra });
registerWidget(def("f-panel"));
registerWidget(def("f-other"));
registerWidget(def("f-estop", { locked: true, icon: Shield }));

const inst = (instanceId: string, widgetId: string, col: number, row: number, w = 3, h = 2): WidgetInstance => ({ instanceId, widgetId, col, row, w, h, config: {} });
const TEMPLATE = [inst("a", "f-panel", 1, 1), inst("b", "f-other", 4, 1), inst("ks", "f-estop", 10, 1)];

describe("window options: float, pass clicks through, pin on top", () => {
  const store = createLayoutStore({ surface: "float-test", defaults: TEMPLATE });
  beforeEach(() => store.getState().resetAll());
  const get = (id: string) => store.getState().pages[0].items.find((i) => i.instanceId === id)!;

  it("a panel floats from its grid cell, moves freely, and frees its cells for the grid", () => {
    expect(store.getState().setFloat("a", true)).toBe(true);
    expect(get("a").float).toEqual(floatFromGrid(get("a")));
    store.getState().moveFloat("a", { x: 0.5, y: 0.5 });
    expect(get("a").float).toMatchObject({ x: 0.5, y: 0.5 });
    // Its old cells are free: another panel can take them.
    expect(store.getState().place("b", { col: 1, row: 1, w: 3, h: 2 })).toBe(true);
  });

  it("back onto the grid at its old cell, neighbours moving aside", () => {
    store.getState().setFloat("a", true);
    store.getState().place("b", { col: 1, row: 1, w: 3, h: 2 });
    expect(store.getState().setFloat("a", false)).toBe(true);
    expect(get("a").float).toBeUndefined();
    const a = get("a");
    const b = get("b");
    const overlap = a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
    expect(overlap).toBe(false);
  });

  it("an ordinary float keeps a grab handle on the board; a safety control stays wholly on it", () => {
    expect(clampFloat({ x: 5, y: 5, w: 0.3, h: 0.3 }, false)).toEqual({ x: 1 - FLOAT_KEEP, y: 1 - FLOAT_KEEP, w: 0.3, h: 0.3 });
    expect(clampFloat({ x: 5, y: -2, w: 0.3, h: 0.3 }, true)).toEqual({ x: 0.7, y: 0, w: 0.3, h: 0.3 });
    store.getState().setFloat("ks", true);
    store.getState().moveFloat("ks", { x: 3, y: 3 });
    const f = get("ks").float!;
    expect(f.x + f.w).toBeLessThanOrEqual(1);
    expect(f.y + f.h).toBeLessThanOrEqual(1);
  });

  it("clicks pass through an ordinary floating panel, never a grid panel or a safety control", () => {
    store.getState().setClickThrough("a", true);
    expect(get("a").clickThrough).toBeUndefined();
    store.getState().setFloat("a", true);
    store.getState().setFloat("ks", true);
    store.getState().setClickThrough("a", true);
    expect(get("a").clickThrough).toBe(true);
    store.getState().setClickThrough("ks", true);
    expect(get("ks").clickThrough).toBeUndefined();
    store.getState().setClickThrough("a", false);
    expect(get("a").clickThrough).toBeUndefined();
  });

  it("pin on top only for a floating panel", () => {
    store.getState().setPinned("a", true);
    expect(get("a").pinned).toBeUndefined();
    store.getState().setFloat("a", true);
    store.getState().setPinned("a", true);
    expect(get("a").pinned).toBe(true);
  });

  it("a save or import can't make a safety control click-through or put a float off the board", () => {
    const s = sanitizeFloats(
      { pages: [{ id: "p", name: "P", items: [{ ...inst("ks", "f-estop", 1, 1), clickThrough: true, float: { x: 9, y: 9, w: 0.2, h: 0.2 } }, { ...inst("a", "f-panel", 4, 1), pinned: true }] }], activePage: "p" },
      isLockedWidget,
    );
    const [ks, a] = s.pages[0].items;
    expect(ks.clickThrough).toBeUndefined();
    expect(ks.float).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(a.pinned).toBeUndefined();
  });

  it("a floating safety control survives a reload / import when a grid panel takes its old cell", () => {
    store.getState().setFloat("ks", true);
    store.getState().moveFloat("ks", { x: 0.1, y: 0.5 });
    expect(store.getState().place("b", { col: 10, row: 1, w: 3, h: 2 })).toBe(true);
    const saved = store.getState().exportLayout();
    store.getState().importLayout(JSON.parse(JSON.stringify(saved)));
    expect(store.getState().pages).toHaveLength(1);
    const ks = get("ks");
    expect(ks.float).toMatchObject({ x: 0.1, y: 0.5 });
  });

  it("a mode layout from a save or import is checked too (no off-board or click-through safety control)", () => {
    const bad = { pages: [{ id: "p1", name: "P", items: [inst("a", "f-panel", 1, 1), { ...inst("ks", "f-estop", 10, 1), float: { x: 7, y: 7, w: 0.3, h: 0.3 }, clickThrough: true }] }], activePage: "p1" };
    store.getState().importLayout({ ...store.getState().exportLayout(), variant: "default", variants: { trading: bad } });
    store.getState().applyMode("trading");
    const ks = get("ks");
    expect(ks.float!.x + ks.float!.w).toBeLessThanOrEqual(1);
    expect(ks.clickThrough).toBeUndefined();
    store.getState().applyMode("default");
  });

  it("a floating panel is full size only (icon / compact snap it to the grid first)", () => {
    store.getState().setFloat("a", true);
    expect(store.getState().setDisplay("a", "icon")).toBe(false);
    store.getState().setFloat("a", false);
    store.getState().setDisplay("a", "icon");
    expect(store.getState().setFloat("a", true)).toBe(false);
  });
});

describe("unique ids (a decoy can't share the kill switch's id)", () => {
  const store = createLayoutStore({ surface: "float-test-ids", defaults: TEMPLATE });
  it("a clashing id is renamed; removing the decoy leaves the safety control", () => {
    store.getState().importLayout({ pages: [{ id: "p1", name: "P", items: [inst("ks", "f-panel", 1, 1), inst("ks", "f-estop", 10, 1)] }], activePage: "p1" });
    const items = store.getState().pages[0].items;
    expect(new Set(items.map((i) => i.instanceId)).size).toBe(items.length);
    const decoy = items.find((i) => i.widgetId === "f-panel")!;
    expect(decoy.instanceId).not.toBe("ks");
    store.getState().remove(decoy.instanceId);
    store.getState().remove("ks");
    expect(store.getState().pages[0].items.some((i) => i.widgetId === "f-estop")).toBe(true);
  });
});
