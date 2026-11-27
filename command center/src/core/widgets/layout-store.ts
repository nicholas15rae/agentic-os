import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getWidget } from "./registry";
import { isTauri } from "@/lib/platform";
import type { WidgetInstance } from "./types";
import { mergeLook, type DisplayMode, type WidgetLook } from "./look";

/** A pop-up window of an icon-mode widget (screen px). */
export interface WidgetWindow {
  instanceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}
import { activeItems, addHomeView, allIds, duplicatePage, linkMode, migrateLayout, movePage, moveToPage, nextPageName, placePushing, placeWidget, removePage, sanitizePages, startupOf, withUniqueIds, type PagesState } from "./pages";

export { GRID_COLS, GRID_ROWS, activeItems, fits, type LayoutPage } from "./pages";

const PIPELINES_SLOT: WidgetInstance = { instanceId: "n8n", widgetId: "n8n-pipelines", col: 4, row: 4, w: 6, h: 2, config: {} };
/** Browser / phone board only (Phase 2 Part D): the desktop board is full, so desktop switches modes
 * from the top-bar ModePill (and can add this panel from the Widgets tray). */
const TONY_MODE_SLOT: WidgetInstance = { instanceId: "tony-mode", widgetId: "tony-mode", col: 4, row: 4, w: 6, h: 2, config: {} };

/**
 * Default board: widgets hug the edges so the centre-bottom of the wallpaper
 * (where the car sits) stays clear.
 */
const DEFAULT_LAYOUT: WidgetInstance[] = [
  { instanceId: "mantra", widgetId: "mantra", col: 4, row: 1, w: 6, h: 3, config: {} },
  // Voice-first: the docked HUD is anchored centre stage, under the mantra.
  { instanceId: "voice", widgetId: "voice-console", col: 4, row: 6, w: 6, h: 3, config: {} },
  // Left: telemetry, time-critical lists.
  { instanceId: "system", widgetId: "system-stats", col: 1, row: 1, w: 3, h: 2, config: {} },
  { instanceId: "reminders", widgetId: "reminders", col: 1, row: 3, w: 3, h: 3, config: {} },
  { instanceId: "pipeline", widgetId: "pipeline", col: 1, row: 6, w: 3, h: 3, config: {} },
  // Right: live nodes, work, atmosphere.
  { instanceId: "agents", widgetId: "agent-nodes", col: 10, row: 1, w: 3, h: 3, config: {} },
  { instanceId: "contracting", widgetId: "contracting", col: 10, row: 4, w: 3, h: 3, config: {} },
  { instanceId: "weather", widgetId: "weather", col: 10, row: 7, w: 3, h: 2, config: {} },
  // Desktop only (needs the Rust side): live n8n sessions + Drive sync, centre band.
  // Browser / phone: Tony's mode panel takes that band instead.
  ...(isTauri() ? [PIPELINES_SLOT] : [TONY_MODE_SLOT]),
];

export interface AddResult {
  ok: boolean;
  reason?: string;
  /** The page the widget landed on (it becomes the active page). */
  pageId?: string;
  /** True when no page had room and a new one was made. */
  created?: boolean;
}

interface LayoutState extends PagesState {
  editing: boolean;
  setEditing: (v: boolean) => void;
  /** Lands on the start page (default: active) if it fits, else a later page, else a new page. */
  add: (widgetId: string, config?: Record<string, unknown>, opts?: { pageId?: string }) => AddResult;
  remove: (instanceId: string) => void;
  /** Moves / resizes, pushing covered neighbours aside; false (nothing changes) when off the board or there is no room. */
  place: (instanceId: string, rect: Pick<WidgetInstance, "col" | "row" | "w" | "h">) => boolean;
  setConfig: (instanceId: string, patch: Record<string, unknown>) => void;
  setGlass: (instanceId: string, ultra: boolean) => void;
  /** Section pass: a widget's own look (merged), and its display mode. */
  setLook: (instanceId: string, patch: WidgetLook) => void;
  /** Icon (1×1), compact (its min size) or full (its remembered size); neighbours move aside. False: no room. */
  setDisplay: (instanceId: string, display: DisplayMode) => boolean;
  /** Pop-up windows of icon-mode widgets (not saved): several at once, on top of the page. */
  windows: WidgetWindow[];
  openWindow: (instanceId: string) => void;
  closeWindow: (instanceId: string) => void;
  moveWindow: (instanceId: string, rect: Partial<Omit<WidgetWindow, "instanceId">>) => void;
  /** Tap to focus (not saved): the widget turns solid and readable until you click away. */
  focused: string | null;
  setFocused: (instanceId: string | null) => void;
  setGlassAll: (ultra: boolean) => void;
  /** Resets the active page only: the first page gets the default board back, any other page is cleared. */
  reset: () => void;
  addPage: (name?: string) => string;
  removePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  setActivePage: (id: string) => void;
  moveToPage: (instanceId: string, pageId: string) => boolean;
  /** Page presets (section pass). */
  movePage: (id: string, dir: -1 | 1) => void;
  duplicatePage: (id: string) => void;
  setPageMode: (id: string, mode: string | null) => void;
  setPageWallpaper: (id: string, wallpaper: string | null) => void;
  setStartupPage: (id: string | null) => void;
  addHomeView: () => void;
}

const shortId = () => crypto.randomUUID().slice(0, 6);

/** The Glass switches: the old ultra flag, and a glass / ultra frame picked in the Look panel, agree. */
const withUltra = (i: WidgetInstance, ultra: boolean): WidgetInstance => ({
  ...i,
  glass: ultra ? ("ultra" as const) : undefined,
  look: i.look?.frame === "glass" || i.look?.frame === "ultra" ? { ...i.look, frame: ultra ? "ultra" : "glass" } : i.look,
});

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => {
      /** Replace the active page's items. */
      const updateActive = (fn: (items: WidgetInstance[]) => WidgetInstance[]) =>
        set((s) => ({ pages: s.pages.map((p) => (p.id === s.activePage ? { ...p, items: fn(p.items) } : p)) }));
      return {
        pages: [{ id: "p1", name: "Page 1", items: DEFAULT_LAYOUT }],
        activePage: "p1",
        editing: false,
        setEditing: (editing) => set({ editing }),
        add: (widgetId, config, opts) => {
          const def = getWidget(widgetId);
          if (!def) return { ok: false, reason: "Unknown widget" };
          const sizes = [def.defaultSize, def.minSize].filter((z): z is { w: number; h: number } => !!z);
          const s = get();
          const r = placeWidget(s, { widgetId, sizes, config: { ...def.defaultConfig, ...config }, pageId: opts?.pageId }, shortId);
          if (!r.ok) return { ok: false, reason: r.reason };
          set(r.state);
          return { ok: true, pageId: r.pageId, created: r.created };
        },
        remove: (instanceId) => updateActive((items) => items.filter((i) => i.instanceId !== instanceId)),
        place: (instanceId, rect) => {
          const next = placePushing(activeItems(get()), instanceId, rect);
          if (!next) return false;
          updateActive(() => next);
          return true;
        },
        // By id on whichever page holds it (ids are unique), so a widget's late async save still lands after a page switch.
        setConfig: (instanceId, patch) =>
          set((s) => ({
            pages: s.pages.map((p) =>
              p.items.some((i) => i.instanceId === instanceId)
                ? { ...p, items: p.items.map((i) => (i.instanceId === instanceId ? { ...i, config: { ...i.config, ...patch } } : i)) }
                : p,
            ),
          })),
        setGlass: (instanceId, ultra) => updateActive((items) => items.map((i) => (i.instanceId === instanceId ? withUltra(i, ultra) : i))),
        setLook: (instanceId, patch) =>
          set((s) => ({ pages: s.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.instanceId === instanceId ? { ...i, look: mergeLook(i.look, patch) } : i)) })) })),
        setDisplay: (instanceId, display) => {
          const s = get();
          const page = s.pages.find((p) => p.items.some((i) => i.instanceId === instanceId));
          const cur = page?.items.find((i) => i.instanceId === instanceId);
          if (!page || !cur) return false;
          const def = getWidget(cur.widgetId);
          const full = cur.fullSize ?? (cur.display && cur.display !== "full" ? def?.defaultSize : undefined) ?? { w: cur.w, h: cur.h };
          const half = def?.minSize ?? { w: Math.max(1, Math.ceil(full.w / 2)), h: Math.max(1, Math.ceil(full.h / 2)) };
          const size = display === "icon" ? { w: 1, h: 1 } : display === "compact" ? { w: Math.min(half.w, full.w), h: Math.min(half.h, full.h) } : full;
          const moved = placePushing(page.items, instanceId, { col: Math.min(cur.col, 13 - size.w), row: Math.min(cur.row, 9 - size.h), ...size });
          if (!moved) return false;
          const items = moved.map((i) => (i.instanceId === instanceId ? { ...i, display: display === "full" ? undefined : display, fullSize: display === "full" ? undefined : full } : i));
          set({ pages: s.pages.map((p) => (p.id === page.id ? { ...p, items } : p)), windows: display === "icon" ? s.windows : s.windows.filter((w) => w.instanceId !== instanceId) });
          return true;
        },
        windows: [],
        // z is a rank 1..n (front = n), so windows stay below confirmation cards and toasts.
        openWindow: (instanceId) =>
          set((s) => {
            const open = s.windows.find((w) => w.instanceId === instanceId);
            if (open && s.windows.every((w) => w === open || w.z < open.z)) return s;
            const n = s.windows.length;
            const target: WidgetWindow = open ?? { instanceId, x: 120 + n * 28, y: 90 + n * 28, w: 520, h: 380, z: 0 };
            const order = [...s.windows].filter((w) => w.instanceId !== instanceId).sort((a, b) => a.z - b.z);
            return { windows: [...order, target].map((w, i) => ({ ...w, z: i + 1 })) };
          }),
        closeWindow: (instanceId) => set((s) => ({ windows: s.windows.filter((w) => w.instanceId !== instanceId) })),
        moveWindow: (instanceId, rect) => set((s) => ({ windows: s.windows.map((w) => (w.instanceId === instanceId ? { ...w, ...rect } : w)) })),
        focused: null,
        setFocused: (focused) => set({ focused }),
        setGlassAll: (ultra) => updateActive((items) => items.map((i) => withUltra(i, ultra))),
        reset: () => {
          const s = get();
          const first = s.pages[0]?.id === s.activePage;
          const others = allIds(s.pages.filter((p) => p.id !== s.activePage));
          updateActive(() => (first ? withUniqueIds(DEFAULT_LAYOUT, others, shortId) : []));
        },
        addPage: (name) => {
          const s = get();
          const ids = new Set(s.pages.map((p) => p.id));
          let id = `p${shortId()}`;
          while (ids.has(id)) id = `p${shortId()}`;
          set({ pages: [...s.pages, { id, name: name?.trim() || nextPageName(s.pages), items: [] }], activePage: id });
          return id;
        },
        removePage: (id) => set((s) => removePage(s, id)),
        renamePage: (id, name) => {
          const n = name.trim().slice(0, 40);
          if (n) set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, name: n } : p)) }));
        },
        setActivePage: (id) => {
          // A page switch closes the previous page's widget windows and any focus.
          if (get().pages.some((p) => p.id === id)) set({ activePage: id, windows: [], focused: null });
        },
        movePage: (id, dir) => set((s) => movePage(s, id, dir)),
        duplicatePage: (id) => set((s) => duplicatePage(s, id, shortId)),
        setPageMode: (id, mode) => set((s) => linkMode(s, id, mode)),
        setPageWallpaper: (id, wallpaper) => set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, wallpaper } : p)) })),
        setStartupPage: (startupPage) => set({ startupPage }),
        addHomeView: () => set((s) => addHomeView(s, shortId)),
        moveToPage: (instanceId, pageId) => {
          const s = get();
          const inst = s.pages.flatMap((p) => p.items).find((i) => i.instanceId === instanceId);
          const next = moveToPage(s, instanceId, pageId, inst ? getWidget(inst.widgetId)?.minSize : undefined);
          if (!next) return false;
          set(next);
          return true;
        },
      };
    },
    {
      name: "cc.layout",
      version: 5,
      partialize: (s) => ({ pages: s.pages, activePage: s.activePage, startupPage: s.startupPage }),
      migrate: (persisted, version) => migrateLayout(persisted, version, DEFAULT_LAYOUT, isTauri() ? PIPELINES_SLOT : null),
      // The app opens on the startup page (default: the first), not on whatever page was last open.
      merge: (persisted, current) => {
        if (persisted == null) return current;
        const s = sanitizePages(persisted, DEFAULT_LAYOUT);
        return { ...current, ...s, activePage: startupOf(s) };
      },
    },
  ),
);
