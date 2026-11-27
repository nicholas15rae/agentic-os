import { lazy } from "react";
import { Shield, Square } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { createLayoutStore, surfaceStore } from "./layout-store";
import { availableWidgets, isLockedWidget, registerWidget } from "./registry";
import { canClickThrough, clampLocked, clampOnScreen, ensureLocked, resetItems, safeLook } from "./locks";
import { SHARED, backToShared, customize, customizedModes, sanitizeVariants, switchTo } from "./variants";
import type { WidgetDefinition, WidgetInstance } from "./types";

const Noop = lazy(async () => ({ default: () => null }));
const def = (id: string, extra: Partial<WidgetDefinition<any>> = {}): WidgetDefinition<any> => ({
  id,
  title: id,
  description: id,
  icon: Square,
  defaultSize: { w: 3, h: 2 },
  defaultConfig: {},
  component: Noop,
  surfaces: ["test-surface"],
  ...extra,
});
registerWidget(def("t-panel"));
registerWidget(def("t-other"));
registerWidget(def("t-estop", { locked: true, icon: Shield, title: "Kill switch" }));

const inst = (instanceId: string, widgetId: string, col: number, row: number, w = 3, h = 2): WidgetInstance => ({ instanceId, widgetId, col, row, w, h, config: {} });
const TEMPLATE = [inst("a", "t-panel", 1, 1), inst("ks", "t-estop", 10, 1)];
const locked = isLockedWidget;

describe("shared layout engine: a surface's own store", () => {
  const store = createLayoutStore({ surface: "test-surface", defaults: TEMPLATE, storageKey: "cc.layout.test-surface" });
  beforeEach(() => store.getState().resetAll());

  it("starts from its finished template", () => {
    expect(store.getState().surface).toBe("test-surface");
    expect(store.getState().pages[0].items.map((i) => i.instanceId)).toEqual(["a", "ks"]);
    // (Saved under its own key: `persist` is inert in this storage-less test environment.)
  });

  it("panels are offered only on the surfaces they belong to", () => {
    expect(availableWidgets("test-surface").map((d) => d.id)).toEqual(expect.arrayContaining(["t-panel", "t-estop"]));
    expect(availableWidgets().some((d) => d.id === "t-panel")).toBe(false);
  });

  it("Reset this page restores the template, Undo brings the edit back", () => {
    const L = store.getState();
    L.remove("a");
    expect(store.getState().pages[0].items.map((i) => i.widgetId)).toEqual(["t-estop"]);
    store.getState().reset();
    expect(store.getState().pages[0].items.map((i) => i.widgetId).sort()).toEqual(["t-estop", "t-panel"]);
    store.getState().undoReset();
    expect(store.getState().pages[0].items.map((i) => i.widgetId)).toEqual(["t-estop"]);
  });

  it("Reset all pages goes back to one template page", () => {
    store.getState().addPage("Extra");
    store.getState().add("t-other");
    expect(store.getState().pages).toHaveLength(2);
    store.getState().resetAll();
    expect(store.getState().pages).toHaveLength(1);
    expect(store.getState().lastReset?.pages).toHaveLength(2);
  });

  it("surfaceStore makes one store per surface", () => {
    const a = surfaceStore({ surface: "test-surface-2", defaults: [] });
    expect(surfaceStore({ surface: "test-surface-2", defaults: TEMPLATE })).toBe(a);
  });
});

describe("safety controls are locked", () => {
  const store = createLayoutStore({ surface: "test-locks", defaults: TEMPLATE });
  beforeEach(() => store.getState().resetAll());

  it("can't be removed, collapsed to an icon, sent to another page or have their page deleted", () => {
    const L = store.getState();
    L.remove("ks");
    expect(store.getState().pages[0].items.some((i) => i.instanceId === "ks")).toBe(true);
    expect(L.setDisplay("ks", "icon")).toBe(false);
    const p2 = store.getState().addPage();
    expect(store.getState().moveToPage("ks", p2)).toBe(false);
    store.getState().setActivePage("p1");
    store.getState().removePage("p1");
    expect(store.getState().pages.some((p) => p.id === "p1")).toBe(true);
  });

  it("can still be moved and resized", () => {
    expect(store.getState().place("ks", { col: 7, row: 5, w: 4, h: 3 })).toBe(true);
    const ks = store.getState().pages[0].items.find((i) => i.instanceId === "ks")!;
    expect([ks.col, ks.row, ks.w, ks.h]).toEqual([7, 5, 4, 3]);
  });

  it("can't be styled unreadable: no text colour, no tiny size", () => {
    store.getState().setLook("ks", { color: "#000000", scale: 0.6 });
    const look = store.getState().pages[0].items.find((i) => i.instanceId === "ks")!.look!;
    expect(look.color).toBeUndefined();
    expect(look.scale).toBe(0.9);
    expect(safeLook({ color: "#111", scale: 0.6 }, false)).toEqual({ color: "#111", scale: 0.6 });
  });

  it("Reset keeps a control that was moved off the template's spot; clearing an extra page keeps it too", () => {
    const moved = [inst("ks", "t-estop", 1, 1), inst("b", "t-other", 4, 1)];
    const out = resetItems(moved, TEMPLATE, true, locked, new Set(), () => "x");
    expect(out.filter((i) => i.widgetId === "t-estop")).toHaveLength(1);
    const extra = resetItems([inst("ks2", "t-estop", 1, 1)], [inst("a", "t-panel", 1, 1)], false, locked, new Set(), () => "x");
    expect(extra.map((i) => i.instanceId)).toEqual(["ks2"]);
  });

  it("a save or import that lost a control gets it back; one saved as an icon shows in full", () => {
    const lost = ensureLocked({ pages: [{ id: "p", name: "P", items: [inst("a", "t-panel", 1, 1)] }], activePage: "p" }, TEMPLATE, locked, () => "n");
    expect(lost.pages[0].items.some((i) => i.widgetId === "t-estop")).toBe(true);
    const icon = ensureLocked({ pages: [{ id: "p", name: "P", items: [{ ...inst("ks", "t-estop", 1, 1, 1, 1), display: "icon" }] }], activePage: "p" }, TEMPLATE, locked, () => "n");
    expect(icon.pages[0].items[0].display).toBeUndefined();
  });

  it("is never click-through, and stays fully on screen when floating", () => {
    expect(canClickThrough("t-estop", locked)).toBe(false);
    expect(canClickThrough("t-panel", locked)).toBe(true);
    expect(clampLocked({ x: 1900, y: -40, w: 300, h: 200 }, 1920, 1080)).toEqual({ x: 1620, y: 0, w: 300, h: 200 });
    // An ordinary panel may hang off the edge, but a grab handle's worth stays visible.
    expect(clampOnScreen({ x: 5000, y: 5000, w: 300, h: 200 }, 1920, 1080)).toEqual({ x: 1856, y: 1016, w: 300, h: 200 });
  });
});

describe("per-mode layouts", () => {
  const page = (id: string, items: WidgetInstance[]) => ({ pages: [{ id, name: id, items }], activePage: id });
  const live = { ...page("s", [inst("a", "t-panel", 1, 1)]), variant: SHARED, variants: {} as Record<string, ReturnType<typeof page>> };

  it("a mode uses the shared layout until it is customized", () => {
    expect(switchTo(live, "builder")).toBeNull();
    const c = customize(live, "builder")!;
    expect(c.variant).toBe("builder");
    expect(Object.keys(c.variants)).toEqual([SHARED]);
    expect(customizedModes(c)).toEqual(["builder"]);
  });

  it("switching modes swaps layouts and keeps each one's edits", () => {
    const c = customize(live, "builder")!;
    const edited = { ...c, pages: [{ ...c.pages[0], items: [inst("z", "t-other", 5, 5)] }] };
    const shared = switchTo(edited, "executive")!;
    expect(shared.variant).toBe(SHARED);
    expect(shared.pages[0].items.map((i) => i.instanceId)).toEqual(["a"]);
    const back = switchTo(shared, "builder")!;
    expect(back.pages[0].items.map((i) => i.instanceId)).toEqual(["z"]);
  });

  it("customizing a second mode starts from the shared layout, not the other mode's", () => {
    const c = customize(live, "builder")!;
    const edited = { ...c, pages: [{ ...c.pages[0], items: [inst("z", "t-other", 5, 5)] }] };
    const second = customize(edited, "operations")!;
    expect(second.pages[0].items.map((i) => i.instanceId)).toEqual(["a"]);
    expect(customizedModes(second).sort()).toEqual(["builder", "operations"]);
  });

  it("Use the shared layout drops the mode's copy", () => {
    const c = customize(live, "builder")!;
    const s = backToShared(c, "builder")!;
    expect(s.variant).toBe(SHARED);
    expect(customizedModes(s)).toEqual([]);
  });

  it("a damaged save falls back to the shared layout", () => {
    expect(sanitizeVariants({ variant: "builder", variants: {} }, [])).toEqual({ variant: SHARED, variants: {} });
    expect(sanitizeVariants(null, [])).toEqual({ variant: SHARED, variants: {} });
  });
});

describe("review fixes", () => {
  const store = createLayoutStore({ surface: "test-review", defaults: TEMPLATE });
  beforeEach(() => store.getState().resetAll());

  it("a layout swap opens the page linked to the new mode, not the startup page linked to another", () => {
    const s = {
      pages: [
        { id: "p1", name: "Work", items: [], mode: "work" },
        { id: "p2", name: "Chill", items: [], mode: "chill" },
      ],
      activePage: "p1",
    };
    const live = { pages: [{ id: "p1", name: "F", items: [] }, { id: "p2", name: "F2", items: [] }], activePage: "p2", variant: "focus", variants: { [SHARED]: s } };
    expect(switchTo(live, "chill")!.activePage).toBe("p2");
  });

  it("removeWhere takes a tile off every per-mode layout; putBack returns each to its own layout", () => {
    const tile = (id: string) => ({ ...inst(id, "t-other", 4, 4), config: { buildId: "B" } });
    store.setState((s) => ({ pages: [{ ...s.pages[0], items: [...s.pages[0].items, tile("live-b")] }] }));
    store.getState().customizeForMode("focus");
    // focus is live now; the shared copy (in variants) holds the tile too.
    const removed = store.getState().removeWhere((i) => (i.config as { buildId?: string }).buildId === "B");
    expect(removed.map((r) => r.variant).sort()).toEqual([SHARED, "focus"]);
    store.getState().applyMode("work");
    expect(store.getState().pages[0].items.some((i) => i.instanceId === "live-b")).toBe(false);
    store.getState().putBack(removed);
    expect(store.getState().pages[0].items.some((i) => i.instanceId === "live-b")).toBe(true);
    expect(store.getState().variants.focus.pages[0].items.some((i) => i.instanceId === "live-b")).toBe(true);
  });

  it("removeWhere never takes a safety control", () => {
    expect(store.getState().removeWhere(() => true).some((r) => (r.item as WidgetInstance).widgetId === "t-estop")).toBe(false);
  });

  it("Reset all pages keeps a safety control the user added (not in the template)", () => {
    const plain = createLayoutStore({ surface: "test-review-2", defaults: [inst("a", "t-panel", 1, 1)] });
    plain.getState().add("t-estop");
    plain.getState().resetAll();
    expect(plain.getState().pages.flatMap((p) => p.items).some((i) => i.widgetId === "t-estop")).toBe(true);
  });

  it("Use the shared layout keeps a safety control only the mode's copy held", () => {
    const plain = createLayoutStore({ surface: "test-review-3", defaults: [inst("a", "t-panel", 1, 1)] });
    plain.getState().customizeForMode("focus");
    plain.getState().add("t-estop");
    plain.getState().useSharedForMode("focus");
    expect(plain.getState().variant).toBe(SHARED);
    expect(plain.getState().pages.flatMap((p) => p.items).some((i) => i.widgetId === "t-estop")).toBe(true);
  });

  it("duplicating a page doesn't copy its safety control", () => {
    store.getState().duplicatePage("p1");
    const copy = store.getState().pages.find((p) => p.id === store.getState().activePage)!;
    expect(copy.items.some((i) => i.widgetId === "t-estop")).toBe(false);
    expect(copy.items.some((i) => i.widgetId === "t-panel")).toBe(true);
  });

  it("a control saved off the board is placed back on it", () => {
    const off = ensureLocked({ pages: [{ id: "p", name: "P", items: [inst("ks", "t-estop", 40, 30)] }], activePage: "p" }, TEMPLATE, locked, () => "n");
    const ks = off.pages[0].items.find((i) => i.widgetId === "t-estop")!;
    expect(ks.col + ks.w - 1).toBeLessThanOrEqual(12);
    expect(ks.row + ks.h - 1).toBeLessThanOrEqual(8);
  });
});
