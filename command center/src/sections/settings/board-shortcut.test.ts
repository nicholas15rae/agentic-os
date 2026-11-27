import { describe, expect, it, vi } from "vitest";
import { placeWidget, type LayoutPage, type PagesState } from "@/core/widgets/pages";
import type { WidgetInstance } from "@/core/widgets/types";
import { boardNotice, sendToBoard, type BoardDeps } from "./board-shortcut";

const inst = (instanceId: string, col: number, row: number, w: number, h: number, widgetId = "x"): WidgetInstance => ({ instanceId, widgetId, col, row, w, h, config: {} });
const full = (p: string) => [inst(`${p}a`, 1, 1, 6, 4), inst(`${p}b`, 7, 1, 6, 4), inst(`${p}c`, 1, 5, 6, 4), inst(`${p}d`, 7, 5, 6, 4)];

/** Real placement logic over an in-memory state, scanning from the first page like the button does. */
function deps(start: PagesState) {
  let s = start;
  let n = 0;
  const showBoard = vi.fn();
  const d: BoardDeps = {
    pages: () => s.pages,
    add: (widgetId) => {
      const r = placeWidget(s, { widgetId, sizes: [{ w: 4, h: 3 }, { w: 3, h: 3 }], config: {}, pageId: s.pages[0]?.id }, () => String(++n).padStart(6, "0"));
      if (!r.ok) return { ok: false, reason: r.reason };
      s = r.state;
      return { ok: true, pageId: r.pageId, created: r.created };
    },
    setActivePage: (id) => {
      s = { ...s, activePage: id };
    },
    showBoard,
  };
  return { d, showBoard, state: () => s };
}

const pages = (...ps: LayoutPage[]): PagesState => ({ pages: ps, activePage: ps[0].id });

describe("sendToBoard", () => {
  it("adds to the first page with room and goes there", () => {
    const { d, showBoard, state } = deps({ pages: [{ id: "p1", name: "Page 1", items: full("a") }, { id: "p2", name: "Errands", items: [] }], activePage: "p2" });
    // Active page is p2, but placement scans from the first page; p1 is full so it lands on p2.
    const o = sendToBoard("route-map", d);
    expect(o).toEqual({ kind: "added", pageId: "p2", pageName: "Errands", created: false });
    expect(state().activePage).toBe("p2");
    expect(state().pages[1].items[0]).toMatchObject({ widgetId: "route-map", col: 1, row: 1 });
    expect(showBoard).toHaveBeenCalledOnce();
  });

  it("a full board makes a new page, says which one, and goes there", () => {
    const { d, showBoard, state } = deps(pages({ id: "p1", name: "Page 1", items: full("a") }));
    const o = sendToBoard("route-map", d);
    expect(o).toMatchObject({ kind: "added", pageName: "Page 2", created: true });
    expect(state().activePage).toBe(o.kind === "added" ? o.pageId : "");
    expect(showBoard).toHaveBeenCalledOnce();
    const n = boardNotice(o, "Maps");
    expect(n.title).toBe("Maps added on Page 2");
    expect(n.body).toContain("Every page was full");
    expect(n.body).toContain("Page 2");
  });

  it("already on a page: shows that page instead of adding a second one", () => {
    const { d, showBoard, state } = deps(pages({ id: "p1", name: "Page 1", items: [] }, { id: "travel", name: "Travel", items: [inst("m", 1, 1, 6, 5, "route-map")] }));
    const o = sendToBoard("route-map", d);
    expect(o).toEqual({ kind: "shown", pageId: "travel", pageName: "Travel" });
    expect(state().pages.flatMap((p) => p.items).filter((i) => i.widgetId === "route-map")).toHaveLength(1);
    expect(state().activePage).toBe("travel");
    expect(showBoard).toHaveBeenCalledOnce();
    expect(boardNotice(o, "Maps")).toEqual({ title: "Maps is on Travel", body: "Showing Travel.", tone: "info" });
  });

  it("a failed add stays put and reports why", () => {
    const showBoard = vi.fn();
    const o = sendToBoard("route-map", { pages: () => [], add: () => ({ ok: false, reason: "Unknown widget" }), setActivePage: vi.fn(), showBoard });
    expect(o).toEqual({ kind: "failed", reason: "Unknown widget" });
    expect(showBoard).not.toHaveBeenCalled();
    expect(boardNotice(o, "Maps")).toMatchObject({ title: "Couldn't add Maps", tone: "error" });
  });
});
