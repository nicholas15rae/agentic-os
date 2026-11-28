import { lazy } from "react";
import { Shield, Square } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { createLayoutStore } from "./layout-store";
import { registerWidget } from "./registry";
import { drawerExclude, neighbourPage, showTabs, swipeStep } from "./subpages";
import type { LayoutPage } from "./pages";
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
  surfaces: ["sub-surface"],
  ...extra,
});
registerWidget(def("sp-calls"));
registerWidget(def("sp-inbox"));
registerWidget(def("sp-stop", { locked: true, icon: Shield }));

const inst = (instanceId: string, widgetId: string, col: number, row: number): WidgetInstance => ({ instanceId, widgetId, col, row, w: 3, h: 2, config: {} });
const page = (id: string, items: WidgetInstance[] = []): LayoutPage => ({ id, name: id, items });

describe("UI fixes 1: sub-pages, pure helpers", () => {
  it("a one-page section shows no tabs unless you are editing", () => {
    expect(showTabs(1, false)).toBe(false);
    expect(showTabs(1, true)).toBe(true);
    expect(showTabs(2, false)).toBe(true);
  });

  it("a sideways swipe turns the page; a scroll or a short drag does not", () => {
    expect(swipeStep(-120, 10)).toBe(1); // finger moved left → next page
    expect(swipeStep(120, -8)).toBe(-1);
    expect(swipeStep(-40, 0)).toBe(0); // too short
    expect(swipeStep(-90, 80)).toBe(0); // mostly vertical: that's a scroll
    expect(swipeStep(Number.NaN, 0)).toBe(0);
  });

  it("steps to the neighbour page, never wrapping around", () => {
    const pages = [page("a"), page("b"), page("c")];
    expect(neighbourPage(pages, "a", 1)).toBe("b");
    expect(neighbourPage(pages, "b", -1)).toBe("a");
    expect(neighbourPage(pages, "c", 1)).toBeNull();
    expect(neighbourPage(pages, "a", -1)).toBeNull();
    expect(neighbourPage(pages, "a", 0)).toBeNull();
    expect(neighbourPage(pages, "zz", 1)).toBeNull();
  });
});

describe("UI fixes 1: a section's own pages on the shared store", () => {
  const store = createLayoutStore({ surface: "sub-surface", defaults: [inst("calls", "sp-calls", 1, 1), inst("stop", "sp-stop", 10, 1)], storageKey: "cc.layout.sub-surface" });
  beforeEach(() => store.getState().resetAll());

  it("starts as one page; an added page is empty, named and active, with its own layout", () => {
    expect(store.getState().pages).toHaveLength(1);
    const id = store.getState().addPage("Business messages");
    const s = store.getState();
    expect(s.activePage).toBe(id);
    expect(s.pages.find((p) => p.id === id)).toMatchObject({ name: "Business messages", items: [] });
    // Add panel on the new page lands there, not on the first page.
    expect(s.add("sp-inbox").ok).toBe(true);
    expect(store.getState().pages.find((p) => p.id === id)!.items.map((i) => i.widgetId)).toEqual(["sp-inbox"]);
    expect(store.getState().pages[0].items.map((i) => i.widgetId)).toEqual(["sp-calls", "sp-stop"]);
  });

  it("Add panel offers another page's panels again, but never a second safety control", () => {
    store.getState().addPage("Calls");
    const ex = drawerExclude(store.getState());
    expect(ex).toContain("sp-stop");
    expect(ex).not.toContain("sp-calls");
    store.getState().add("sp-calls");
    expect(drawerExclude(store.getState())).toContain("sp-calls");
  });

  it("a panel moves to a sub-page; the safety control stays and its page can't be removed", () => {
    const first = store.getState().pages[0].id;
    const id = store.getState().addPage("Calls");
    expect(store.getState().moveToPage("calls", id)).toBe(true);
    expect(store.getState().pages.find((p) => p.id === id)!.items.map((i) => i.instanceId)).toEqual(["calls"]);
    expect(store.getState().moveToPage("stop", id)).toBe(false);
    store.getState().removePage(first);
    expect(store.getState().pages.some((p) => p.id === first)).toBe(true);
    store.getState().removePage(id);
    expect(store.getState().pages.some((p) => p.id === id)).toBe(false);
  });

  it("Reset all pages brings the section back to its one finished page", () => {
    store.getState().addPage("Calls");
    store.getState().addPage("Business");
    store.getState().resetAll();
    expect(store.getState().pages).toHaveLength(1);
  });
});
