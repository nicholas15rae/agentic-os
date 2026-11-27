import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getWidget, isLockedWidget } from "./registry";
import { isTauri } from "@/lib/platform";
import { PHONE_LITE } from "@/lib/phone-lite";
import type { WidgetInstance } from "./types";
import { mergeLook, type DisplayMode, type WidgetLook } from "./look";
import { activeItems, addHomeView, addTravelPage, allIds, duplicatePage, linkMode, migrateLayout, movePage, moveToPage, nextPageName, placePushing, placeWidget, removePage, sanitizePages, startupOf, type PagesState } from "./pages";
import { anyLocked, canClickThrough, canHide, canRemovePage, ensureLocked, lockedIn, resetItems, safeLook, uniqueIds, withoutLockedOnPage } from "./locks";
import { clampFloat, floatFromGrid, gridItems, sanitizeFloats, withoutFloats, type FloatRect } from "./floating";
import { SHARED, backToShared, customize, sanitizeVariants, switchTo, type VariantState } from "./variants";

export { GRID_COLS, GRID_ROWS, activeItems, fits, type LayoutPage } from "./pages";

/** A pop-up window of an icon-mode widget (screen px). */
export interface WidgetWindow {
  instanceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const PIPELINES_SLOT: WidgetInstance = { instanceId: "n8n", widgetId: "n8n-pipelines", col: 4, row: 4, w: 6, h: 2, config: {} };
/** Browser / phone board only (Phase 2 Part D): the desktop board is full, so desktop switches modes
 * from the top-bar ModePill (and can add this panel from the Widgets tray). */
const TONY_MODE_SLOT: WidgetInstance = { instanceId: "tony-mode", widgetId: "tony-mode", col: 4, row: 4, w: 6, h: 2, config: {} };

/**
 * Default board: widgets hug the edges so the centre-bottom of the wallpaper
 * (where the car sits) stays clear.
 */
const HOME_DEFAULT: WidgetInstance[] = [
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

export interface LayoutState extends PagesState, VariantState {
  /** Which page this store lays out ("home", "playplace", …). */
  surface: string;
  /** The finished template (what Reset restores). */
  defaults: WidgetInstance[];
  editing: boolean;
  setEditing: (v: boolean) => void;
  /** Lands on the start page (default: active) if it fits, else a later page, else a new page. */
  /** `noNewPage`: refuse instead of making a new page (a page with no page switcher). */
  add: (widgetId: string, config?: Record<string, unknown>, opts?: { pageId?: string; noNewPage?: boolean }) => AddResult;
  /** Safety controls are never removed. */
  remove: (instanceId: string) => void;
  /** Moves / resizes, pushing covered neighbours aside; false (nothing changes) when off the board or there is no room. */
  place: (instanceId: string, rect: Pick<WidgetInstance, "col" | "row" | "w" | "h">) => boolean;
  setConfig: (instanceId: string, patch: Record<string, unknown>) => void;
  setGlass: (instanceId: string, ultra: boolean) => void;
  /** Section pass: a widget's own look (merged), and its display mode. */
  setLook: (instanceId: string, patch: WidgetLook) => void;
  /** Icon (1×1), compact (its min size) or full (its remembered size); neighbours move aside. False: no room, or a safety control asked to be an icon. */
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
  /** Resets the active page only: the first page gets the template back, any other page is cleared. Safety controls stay. */
  reset: () => void;
  /** The whole surface back to its finished template (one page). Undo with `undoReset`. */
  resetAll: () => void;
  /** The layout before the last reset (this session only, not saved). */
  lastReset: PagesState | null;
  undoReset: () => void;
  /** Per-mode layouts: show `mode`'s own layout if it has one, else the shared one. */
  applyMode: (mode: string | null | undefined) => void;
  /** Give `mode` its own copy of the shared layout (it goes live). */
  customizeForMode: (mode: string) => void;
  /** `mode` goes back to the shared layout. */
  useSharedForMode: (mode: string) => void;
  addPage: (name?: string) => string;
  /** A page holding a safety control can't be deleted. */
  removePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  setActivePage: (id: string) => void;
  /** False for a safety control (it stays on its page). */
  moveToPage: (instanceId: string, pageId: string) => boolean;
  /** Page presets (section pass). */
  movePage: (id: string, dir: -1 | 1) => void;
  duplicatePage: (id: string) => void;
  setPageMode: (id: string, mode: string | null) => void;
  setPageWallpaper: (id: string, wallpaper: string | null) => void;
  setStartupPage: (id: string | null) => void;
  addHomeView: () => void;
  /** Take matching items off every page of every layout (live and per-mode); returns where each was. */
  removeWhere: (pred: (i: WidgetInstance) => boolean) => RemovedTile[];
  /** Put items back where `removeWhere` found them (skips a page that is gone or an id already there). */
  putBack: (tiles: RemovedTile[]) => void;
  /** Window options: float off the grid (null: back onto the grid; false when there is no room). */
  setFloat: (instanceId: string, float: boolean) => boolean;
  /** Move / resize a floating panel (fractions of the board; kept usable, a safety control kept wholly on). */
  moveFloat: (instanceId: string, rect: Partial<FloatRect>) => void;
  /** Clicks pass through to what is under it (never a safety control). */
  setClickThrough: (instanceId: string, on: boolean) => void;
  /** A floating panel stays above the other floating panels. */
  setPinned: (instanceId: string, on: boolean) => void;
  /** Export / import (Settings → Appearance): the saved layout, and a layout from a file (validated, unknown widgets dropped, safety controls kept). */
  exportLayout: () => SavedLayout;
  /** `keepView` (phone sync): keep the page you are on and open windows / focus that still exist. */
  importLayout: (raw: unknown, opts?: { keepView?: boolean }) => void;
}

/** What a surface saves (and what an `agentic-os-ui.json` file carries per surface). */
export type SavedLayout = PagesState & VariantState;

/** Drop items whose widget this app doesn't have (an import from another build). Pure. */
const knownOnly = (p: PagesState): PagesState => ({ ...p, pages: p.pages.map((pg) => ({ ...pg, items: pg.items.filter((i) => !!getWidget(i.widgetId)) })) });

/** An item `removeWhere` took off, and the layout (live or a mode's) and page it was on. */
export interface RemovedTile {
  surface?: string;
  variant?: string;
  pageId: string;
  item: unknown;
}

const shortId = () => crypto.randomUUID().slice(0, 6);

/**
 * A new window's rect: the widget's full size in grid cells at about the board's cell size
 * (12 × 8 over the window), at least 420 × 300 and never past the screen; cascaded by `n`.
 */
export function windowRect(size: { w: number; h: number } | undefined, n: number, vw = typeof window === "undefined" ? 1280 : window.innerWidth, vh = typeof window === "undefined" ? 800 : window.innerHeight) {
  const cellW = vw / 12;
  const cellH = Math.max(60, (vh - 120) / 8);
  const w = Math.round(Math.min(vw - 32, Math.max(420, (size?.w ?? 5) * cellW)));
  const h = Math.round(Math.min(vh - 32, Math.max(300, (size?.h ?? 4) * cellH + 48)));
  const x = Math.round(Math.max(16, Math.min(vw - w - 16, (vw - w) / 2 + n * 28)));
  const y = Math.round(Math.max(16, Math.min(vh - h - 16, (vh - h) / 2 + n * 28)));
  return { x, y, w, h };
}

/** The Glass switches: the old ultra flag, and a glass / ultra frame picked in the Look panel, agree. */
const withUltra = (i: WidgetInstance, ultra: boolean): WidgetInstance => ({
  ...i,
  glass: ultra ? ("ultra" as const) : undefined,
  look: i.look?.frame === "glass" || i.look?.frame === "ultra" ? { ...i.look, frame: ultra ? "ultra" : "glass" } : i.look,
});

/** A surface's layout: its finished template and where it is saved. */
export interface SurfaceSpec {
  surface: string;
  /** The finished-template layout (what Reset restores). */
  defaults: WidgetInstance[];
  /** localStorage key (default `cc.layout.<surface>`; home keeps `cc.layout`). */
  storageKey?: string;
  version?: number;
  /** Older saves → the pages shape (default: sanitize). */
  migrate?: (persisted: unknown, version: number) => PagesState;
  /** First run / Reset all pages (default: one page holding `defaults`). */
  initial?: PagesState;
}

/** The panel without its floating fields (back on the grid). */
function onGrid(i: WidgetInstance): WidgetInstance {
  const { float: _f, pinned: _p, clickThrough: _c, ...rest } = i;
  void _f;
  void _p;
  void _c;
  return rest;
}

const snapshot = (s: PagesState): PagesState => ({ pages: s.pages, activePage: s.activePage, startupPage: s.startupPage ?? null });

/** One layout store per surface: the same engine, actions and safety locks on every page. */
export function createLayoutStore(spec: SurfaceSpec) {
  const template = spec.defaults;
  /** Every load / import goes through this: unique ids, safety controls kept and on the board, floats sane. */
  const cleanLayout = (p: PagesState, known: boolean): PagesState => sanitizeFloats(ensureLocked(uniqueIds(known ? knownOnly(p) : p, isLockedWidget, shortId), template, isLockedWidget, shortId), isLockedWidget);
  const seeded = (): PagesState => ensureLocked(spec.initial ?? { pages: [{ id: "p1", name: "Page 1", items: template }], activePage: "p1" }, template, isLockedWidget, shortId);
  return create<LayoutState>()(
    persist(
      (set, get) => {
        /** Replace the active page's items. */
        const updateActive = (fn: (items: WidgetInstance[]) => WidgetInstance[]) =>
          set((s) => ({ pages: s.pages.map((p) => (p.id === s.activePage ? { ...p, items: fn(p.items) } : p)) }));
        const findInst = (instanceId: string) => get().pages.flatMap((p) => p.items).find((i) => i.instanceId === instanceId);
        /** Leaving the current layout closes its windows and focus. */
        const fresh = { windows: [] as WidgetWindow[], focused: null };
        return {
          surface: spec.surface,
          defaults: template,
          ...seeded(),
          variant: SHARED,
          variants: {},
          lastReset: null,
          editing: false,
          setEditing: (editing) => set({ editing }),
          add: (widgetId, config, opts) => {
            const def = getWidget(widgetId);
            if (!def) return { ok: false, reason: "Unknown widget" };
            const sizes = [def.defaultSize, def.minSize].filter((z): z is { w: number; h: number } => !!z);
            const s = get();
            // Floating panels don't take grid cells: place among the grid panels only.
            const { grid, restore } = withoutFloats(s);
            const r = placeWidget(grid, { widgetId, sizes, config: { ...def.defaultConfig, ...config }, pageId: opts?.pageId }, shortId);
            if (!r.ok) return { ok: false, reason: r.reason };
            if (r.created && opts?.noNewPage) return { ok: false, reason: "No room on this page: hide or shrink a panel first" };
            set(restore(r.state));
            return { ok: true, pageId: r.pageId, created: r.created };
          },
          remove: (instanceId) => {
            if (!canHide(findInst(instanceId), isLockedWidget) || anyLocked(get(), instanceId, isLockedWidget)) return;
            updateActive((items) => items.filter((i) => i.instanceId !== instanceId));
          },
          place: (instanceId, rect) => {
            const items = activeItems(get());
            const next = placePushing(gridItems(items), instanceId, rect);
            if (!next) return false;
            updateActive((cur) => [...next, ...cur.filter((i) => i.float)]);
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
            set((s) => ({ pages: s.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.instanceId === instanceId ? { ...i, look: mergeLook(i.look, safeLook(patch, isLockedWidget(i.widgetId))) } : i)) })) })),
          setDisplay: (instanceId, display) => {
            const s = get();
            const page = s.pages.find((p) => p.items.some((i) => i.instanceId === instanceId));
            const cur = page?.items.find((i) => i.instanceId === instanceId);
            if (!page || !cur) return false;
            // A safety control never collapses to an icon (that would hide it behind a tap).
            if (display === "icon" && !canHide(cur, isLockedWidget)) return false;
            // Icon / compact are grid sizes: a floating panel snaps to the grid first.
            if (cur.float && display !== "full") return false;
            const def = getWidget(cur.widgetId);
            const full = cur.fullSize ?? (cur.display && cur.display !== "full" ? def?.defaultSize : undefined) ?? { w: cur.w, h: cur.h };
            const half = def?.minSize ?? { w: Math.max(1, Math.ceil(full.w / 2)), h: Math.max(1, Math.ceil(full.h / 2)) };
            const size = display === "icon" ? { w: 1, h: 1 } : display === "compact" ? { w: Math.min(half.w, full.w), h: Math.min(half.h, full.h) } : full;
            const placed = placePushing(gridItems(page.items), instanceId, { col: Math.min(cur.col, 13 - size.w), row: Math.min(cur.row, 9 - size.h), ...size });
            if (!placed) return false;
            const moved = [...placed, ...page.items.filter((i) => i.float && i.instanceId !== instanceId)];
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
              const inst = s.pages.flatMap((p) => p.items).find((i) => i.instanceId === instanceId);
              const target: WidgetWindow = open ?? { instanceId, ...windowRect(inst ? (inst.fullSize ?? getWidget(inst.widgetId)?.defaultSize) : undefined, n), z: 0 };
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
            set({ lastReset: snapshot(s), ...fresh });
            updateActive((items) => resetItems(items, template, first, isLockedWidget, others, shortId));
          },
          // Safety controls the user added (not in the template) come through a reset too.
          resetAll: () =>
            set((s) => {
              const base = seeded();
              return { ...ensureLocked(base, template, isLockedWidget, shortId, lockedIn(s, isLockedWidget)), startupPage: null, lastReset: snapshot(s), ...fresh };
            }),
          undoReset: () => {
            const r = get().lastReset;
            if (r) set({ ...r, startupPage: r.startupPage ?? null, lastReset: null, ...fresh });
          },
          applyMode: (mode) => {
            const next = switchTo(get(), mode);
            if (next) set({ ...next, lastReset: null, ...fresh });
          },
          customizeForMode: (mode) => {
            const next = customize(get(), mode);
            if (next) set({ ...next, lastReset: null, ...fresh });
          },
          useSharedForMode: (mode) => {
            const s = get();
            // A safety control only the dropped copy held moves to the shared layout.
            const dropped = s.variant === mode ? lockedIn(s, isLockedWidget) : s.variants[mode] ? lockedIn(s.variants[mode], isLockedWidget) : [];
            const next = backToShared(s, mode);
            if (!next) return;
            const live = ensureLocked(next, template, isLockedWidget, shortId, dropped);
            set({ ...next, pages: live.pages, lastReset: null, ...fresh });
          },
          addPage: (name) => {
            const s = get();
            const ids = new Set(s.pages.map((p) => p.id));
            let id = `p${shortId()}`;
            while (ids.has(id)) id = `p${shortId()}`;
            set({ pages: [...s.pages, { id, name: name?.trim() || nextPageName(s.pages), items: [] }], activePage: id });
            return id;
          },
          removePage: (id) => set((s) => (canRemovePage(s, id, isLockedWidget) ? removePage(s, id) : s)),
          renamePage: (id, name) => {
            const n = name.trim().slice(0, 40);
            if (n) set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, name: n } : p)) }));
          },
          setActivePage: (id) => {
            // A page switch closes the previous page's widget windows and any focus.
            if (get().pages.some((p) => p.id === id)) set({ activePage: id, ...fresh });
          },
          movePage: (id, dir) => set((s) => movePage(s, id, dir)),
          duplicatePage: (id) =>
            set((s) => {
              const next = duplicatePage(s, id, shortId);
              return next === s ? s : withoutLockedOnPage(next, next.activePage, isLockedWidget);
            }),
          setPageMode: (id, mode) => set((s) => linkMode(s, id, mode)),
          setPageWallpaper: (id, wallpaper) => set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, wallpaper } : p)) })),
          setStartupPage: (startupPage) => set({ startupPage }),
          addHomeView: () => set((s) => addHomeView(s, shortId)),
          removeWhere: (pred) => {
            const out: RemovedTile[] = [];
            const strip = (p: PagesState, variant: string): PagesState => ({
              ...p,
              pages: p.pages.map((pg) => ({
                ...pg,
                items: pg.items.filter((i) => {
                  if (!pred(i) || isLockedWidget(i.widgetId)) return true;
                  out.push({ surface: spec.surface, variant, pageId: pg.id, item: i });
                  return false;
                }),
              })),
            });
            set((s) => ({
              pages: strip(s, s.variant).pages,
              variants: Object.fromEntries(Object.entries(s.variants).map(([k, v]) => [k, strip(v, k)])),
            }));
            return out;
          },
          putBack: (tiles) =>
            set((s) => {
              const into = (p: PagesState, variant: string): PagesState => ({
                ...p,
                pages: p.pages.map((pg) => {
                  const back = tiles
                    .filter((t) => (t.variant ?? s.variant) === variant && t.pageId === pg.id)
                    .map((t) => t.item as WidgetInstance)
                    .filter((b) => !pg.items.some((x) => x.instanceId === b.instanceId));
                  return back.length ? { ...pg, items: [...pg.items, ...back] } : pg;
                }),
              });
              return { pages: into(s, s.variant).pages, variants: Object.fromEntries(Object.entries(s.variants).map(([k, v]) => [k, into(v, k)])) };
            }),
          setFloat: (instanceId, float) => {
            const s = get();
            const page = s.pages.find((p) => p.items.some((i) => i.instanceId === instanceId));
            const cur = page?.items.find((i) => i.instanceId === instanceId);
            if (!page || !cur) return false;
            const locked = isLockedWidget(cur.widgetId);
            let items: WidgetInstance[] | null;
            if (float) {
              if (cur.display && cur.display !== "full") return false;
              items = page.items.map((i) => (i.instanceId === instanceId ? { ...i, float: clampFloat(floatFromGrid(i), locked) } : i));
            } else {
              // Back onto the grid at its old cell; neighbours move aside (false: no room).
              const back = { ...cur, float: undefined, pinned: undefined, clickThrough: undefined };
              const others = gridItems(page.items.filter((i) => i.instanceId !== instanceId));
              const moved = placePushing([...others, back], instanceId, { col: cur.col, row: cur.row, w: cur.w, h: cur.h });
              items = moved ? [...moved.map((i) => (i.instanceId === instanceId ? onGrid(i) : i)), ...page.items.filter((i) => i.float && i.instanceId !== instanceId)] : null;
            }
            if (!items) return false;
            set({ pages: s.pages.map((p) => (p.id === page.id ? { ...p, items } : p)) });
            return true;
          },
          moveFloat: (instanceId, rect) =>
            set((s) => ({
              pages: s.pages.map((p) => ({
                ...p,
                items: p.items.map((i) => (i.instanceId === instanceId && i.float ? { ...i, float: clampFloat({ ...i.float, ...rect }, isLockedWidget(i.widgetId)) } : i)),
              })),
            })),
          setClickThrough: (instanceId, on) =>
            set((s) => ({
              pages: s.pages.map((p) => ({
                ...p,
                items: p.items.map((i) => {
                  if (i.instanceId !== instanceId) return i;
                  if (on && (!canClickThrough(i.widgetId, isLockedWidget) || !i.float)) return i;
                  const next = { ...i };
                  if (on) next.clickThrough = true;
                  else delete next.clickThrough;
                  return next;
                }),
              })),
            })),
          setPinned: (instanceId, on) =>
            set((s) => ({
              pages: s.pages.map((p) => ({
                ...p,
                items: p.items.map((i) => {
                  if (i.instanceId !== instanceId || !i.float) return i;
                  const next = { ...i };
                  if (on) next.pinned = true;
                  else delete next.pinned;
                  return next;
                }),
              })),
            })),
          exportLayout: () => {
            const s = get();
            return { pages: s.pages, activePage: s.activePage, startupPage: s.startupPage ?? null, variant: s.variant, variants: s.variants };
          },
          importLayout: (raw, opts) => {
            const live = cleanLayout(sanitizePages(raw, template), true);
            const v = sanitizeVariants(raw, template);
            const variants = Object.fromEntries(Object.entries(v.variants).map(([k, p]) => [k, cleanLayout(p, true)]));
            const s = get();
            if (opts?.keepView) {
              // A sync: stay where you are, keep windows and focus whose panels still exist.
              const ids = new Set(live.pages.flatMap((p) => p.items.map((i) => i.instanceId)));
              const activePage = live.pages.some((p) => p.id === s.activePage) ? s.activePage : startupOf(live);
              set({ ...live, startupPage: live.startupPage ?? null, ...v, variants, activePage, lastReset: null, windows: s.windows.filter((w) => ids.has(w.instanceId)), focused: s.focused && ids.has(s.focused) ? s.focused : null });
              return;
            }
            set({ ...live, startupPage: live.startupPage ?? null, ...v, variants, activePage: startupOf(live), lastReset: null, ...fresh });
          },
          moveToPage: (instanceId, pageId) => {
            const s = get();
            const inst = s.pages.flatMap((p) => p.items).find((i) => i.instanceId === instanceId);
            if (!canHide(inst, isLockedWidget) || anyLocked(s, instanceId, isLockedWidget)) return false;
            const next = moveToPage(s, instanceId, pageId, inst ? getWidget(inst.widgetId)?.minSize : undefined);
            if (!next) return false;
            set(next);
            return true;
          },
        };
      },
      {
        name: spec.storageKey ?? `cc.layout.${spec.surface}`,
        version: spec.version ?? 1,
        partialize: (s) => ({ pages: s.pages, activePage: s.activePage, startupPage: s.startupPage, variant: s.variant, variants: s.variants }),
        migrate: (persisted, version) => {
          const v = persisted as Partial<VariantState> | null;
          const pages = spec.migrate ? spec.migrate(persisted, version) : sanitizePages(persisted, template);
          return { ...pages, variant: v?.variant, variants: v?.variants };
        },
        // The app opens on the startup page (default: the first), not on whatever page was last open.
        // Safety controls a save (or an import) lost are put back.
        merge: (persisted, current) => {
          if (persisted == null) return current;
          const s = cleanLayout(sanitizePages(persisted, template), false);
          const v = sanitizeVariants(persisted, template);
          const variants = Object.fromEntries(Object.entries(v.variants).map(([k, p]) => [k, cleanLayout(p, false)]));
          return { ...current, ...s, ...v, variants, activePage: startupOf(s) };
        },
      },
    ),
  );
}

export type LayoutStore = ReturnType<typeof createLayoutStore>;

/** First run: the default board, plus the Travel page (Maps) wherever the Maps widget can run. */
const FIRST_PAGE: PagesState = { pages: [{ id: "p1", name: "Page 1", items: HOME_DEFAULT }], activePage: "p1" };
const HOME_INITIAL: PagesState = isTauri() && !PHONE_LITE ? addTravelPage(FIRST_PAGE) : FIRST_PAGE;

/** The home page (surface "home"), saved as `cc.layout` like before. */
export const useLayout = createLayoutStore({
  surface: "home",
  defaults: HOME_DEFAULT,
  initial: HOME_INITIAL,
  storageKey: "cc.layout",
  // v6: one-time "Travel" page holding the Maps widget (desktop app only: the phone app's Open in Maps is not fixed yet).
  version: 6,
  migrate: (persisted, version) => migrateLayout(persisted, version, HOME_DEFAULT, isTauri() ? PIPELINES_SLOT : null, isTauri() && !PHONE_LITE),
});

const stores = new Map<string, LayoutStore>([["home", useLayout]]);

/** The layout store of a page (made once, on first use). */
export function surfaceStore(spec: SurfaceSpec): LayoutStore {
  let s = stores.get(spec.surface);
  if (!s) {
    s = createLayoutStore(spec);
    stores.set(spec.surface, s);
    for (const fn of onNewSurface) fn(s);
  }
  return s;
}

/** Every surface's store made so far (home first). */
export const allSurfaceStores = (): LayoutStore[] => [...stores.values()];

const onNewSurface = new Set<(s: LayoutStore) => void>();
/** Called for each surface store made later (the mode link, the phone sync push). Returns the unsubscribe. */
export function onSurfaceCreated(fn: (s: LayoutStore) => void): () => void {
  onNewSurface.add(fn);
  return () => void onNewSurface.delete(fn);
}
