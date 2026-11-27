import type { WidgetInstance } from "./types";

/**
 * Pure layout-page logic (no store, no registry) so it can be unit-tested.
 * A page is one 12×8 board; ids are unique across every page.
 */
export const GRID_COLS = 12;
export const GRID_ROWS = 8;

export interface LayoutPage {
  id: string;
  name: string;
  items: WidgetInstance[];
  /** Section pass (page presets): this page's own wallpaper id (none: the shared rotation). */
  wallpaper?: string | null;
  /** One of Tony's modes: switching to that mode opens this page, and opening it switches mode. */
  mode?: string | null;
}

export interface PagesState {
  pages: LayoutPage[];
  activePage: string;
  /** The page the app opens on (default: the first). */
  startupPage?: string | null;
}

/** Move a page one step left / right. Pure. */
export function movePage(s: PagesState, id: string, dir: -1 | 1): PagesState {
  const i = s.pages.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.pages.length) return s;
  const pages = [...s.pages];
  [pages[i], pages[j]] = [pages[j], pages[i]];
  return { ...s, pages };
}

/** Copy a page (widgets get fresh ids; the copy has no mode link, so modes stay one-to-one). Pure. */
export function duplicatePage(s: PagesState, id: string, newId: () => string): PagesState {
  const src = s.pages.find((p) => p.id === id);
  if (!src) return s;
  const pageIds = new Set(s.pages.map((p) => p.id));
  let pid = `p${newId()}`;
  while (pageIds.has(pid)) pid = `p${newId()}`;
  const taken = allIds(s.pages);
  const items: WidgetInstance[] = [];
  for (const it of src.items) {
    let iid = `${it.widgetId}-${newId()}`;
    while (taken.has(iid)) iid = `${it.widgetId}-${newId()}`;
    taken.add(iid);
    items.push({ ...it, instanceId: iid, config: { ...it.config } });
  }
  const names = new Set(s.pages.map((p) => p.name));
  let name = `${src.name} copy`.slice(0, 40);
  for (let n = 2; names.has(name); n++) name = `${src.name} copy ${n}`.slice(0, 40);
  const copy: LayoutPage = { ...src, id: pid, name, items, mode: null };
  const at = s.pages.findIndex((p) => p.id === id) + 1;
  return { ...s, pages: [...s.pages.slice(0, at), copy, ...s.pages.slice(at)], activePage: pid };
}

/** Link a page to one of Tony's modes (one page per mode: any other page loses that link). Pure. */
export function linkMode(s: PagesState, id: string, mode: string | null): PagesState {
  return { ...s, pages: s.pages.map((p) => (p.id === id ? { ...p, mode } : mode && p.mode === mode ? { ...p, mode: null } : p)) };
}

/** The page a mode opens, if any. Pure. */
export const pageForMode = (pages: readonly LayoutPage[], mode: string): LayoutPage | undefined => pages.find((p) => p.mode === mode);

/** The startup page: the chosen one if it still exists, else the first. Pure. */
export const startupOf = (s: PagesState): string => (s.startupPage && s.pages.some((p) => p.id === s.startupPage) ? s.startupPage : s.pages[0].id);

/** The "Home" view: wallpaper first, a few at-a-glance widgets (the mantra carries the clock). */
export const HOME_VIEW: Omit<WidgetInstance, "instanceId">[] = [
  { widgetId: "mantra", col: 4, row: 1, w: 6, h: 2, config: {} },
  { widgetId: "system-stats", col: 1, row: 1, w: 3, h: 2, config: {} },
  { widgetId: "agent-nodes", col: 10, row: 1, w: 3, h: 3, config: {} },
  { widgetId: "weather", col: 10, row: 7, w: 3, h: 2, config: {} },
];

/** Add a "Home" page first (it becomes the startup page). Pure. */
export function addHomeView(s: PagesState, newId: () => string): PagesState {
  const pageIds = new Set(s.pages.map((p) => p.id));
  let pid = `p${newId()}`;
  while (pageIds.has(pid)) pid = `p${newId()}`;
  const taken = allIds(s.pages);
  const items = HOME_VIEW.map((w) => {
    let iid = `${w.widgetId}-${newId()}`;
    while (taken.has(iid)) iid = `${w.widgetId}-${newId()}`;
    taken.add(iid);
    return { ...w, instanceId: iid, config: {} };
  });
  const names = new Set(s.pages.map((p) => p.name));
  const name = names.has("Home") ? "Home view" : "Home";
  return { pages: [{ id: pid, name, items }, ...s.pages], activePage: pid, startupPage: pid };
}

type Rect = Pick<WidgetInstance, "col" | "row" | "w" | "h">;
export type Size = { w: number; h: number };

const overlaps = (a: Rect, b: Rect) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

const inBounds = (r: Rect) => r.col >= 1 && r.row >= 1 && r.col + r.w - 1 <= GRID_COLS && r.row + r.h - 1 <= GRID_ROWS;

export function fits(instances: WidgetInstance[], candidate: WidgetInstance): boolean {
  return inBounds(candidate) && instances.every((o) => o.instanceId === candidate.instanceId || !overlaps(o, candidate));
}

/** First free slot scanning row-major, or null when the board is full. */
export function findSlot(instances: WidgetInstance[], w: number, h: number): { col: number; row: number } | null {
  for (let row = 1; row <= GRID_ROWS - h + 1; row++)
    for (let col = 1; col <= GRID_COLS - w + 1; col++)
      if (fits(instances, { instanceId: "__probe", widgetId: "", col, row, w, h, config: {} })) return { col, row };
  return null;
}

/**
 * Section pass: move / resize `id` to `rect`, pushing any widget it would cover into the nearest
 * free space (closest to where it was, below before above on a tie). Never overlaps anything;
 * null when the rect is off the board or there is no room for everyone. Pure.
 */
export function placePushing(items: WidgetInstance[], id: string, rect: Rect): WidgetInstance[] | null {
  const me = items.find((i) => i.instanceId === id);
  if (!me) return null;
  const next = { ...me, ...rect };
  if (!inBounds(next)) return null;
  const others = items.filter((i) => i.instanceId !== id);
  const board: WidgetInstance[] = [next, ...others.filter((o) => !overlaps(o, next))];
  const movers = others.filter((o) => overlaps(o, next)).sort((a, b) => a.row - b.row || a.col - b.col);
  for (const m of movers) {
    let best: { col: number; row: number; d: number } | null = null;
    for (let row = 1; row <= GRID_ROWS - m.h + 1; row++)
      for (let col = 1; col <= GRID_COLS - m.w + 1; col++) {
        const cand = { ...m, col, row };
        if (!board.every((b) => !overlaps(b, cand))) continue;
        // Distance from where it was; a small bias keeps a pushed widget below rather than above.
        const d = Math.abs(col - m.col) + Math.abs(row - m.row) + (row < m.row ? 0.5 : 0);
        if (!best || d < best.d) best = { col, row, d };
      }
    if (!best) return null;
    board.push({ ...m, col: best.col, row: best.row });
  }
  return items.map((i) => board.find((b) => b.instanceId === i.instanceId)!);
}

const EMPTY: WidgetInstance[] = [];

/** The visible board. Returns the stored array (or one shared empty array), so it is a stable selector. */
export const activeItems = (s: PagesState): WidgetInstance[] => s.pages.find((p) => p.id === s.activePage)?.items ?? EMPTY;

export const allIds = (pages: LayoutPage[]) => new Set(pages.flatMap((p) => p.items.map((i) => i.instanceId)));

/** "Page N" with the smallest N ≥ pages+1 that isn't taken, so names stay unique after removals. */
export function nextPageName(pages: LayoutPage[]): string {
  const taken = new Set(pages.map((p) => p.name));
  let n = pages.length + 1;
  while (taken.has(`Page ${n}`)) n++;
  return `Page ${n}`;
}

const mapPage = (s: PagesState, id: string, fn: (items: WidgetInstance[]) => WidgetInstance[]): LayoutPage[] =>
  s.pages.map((p) => (p.id === id ? { ...p, items: fn(p.items) } : p));

export interface PlaceRequest {
  widgetId: string;
  /** Tried in order (default size, then min size). */
  sizes: Size[];
  config: Record<string, unknown>;
  /** Page to try first; defaults to the active page. */
  pageId?: string;
}

export type PlaceResult = { ok: true; state: PagesState; pageId: string; created: boolean; instanceId: string } | { ok: false; reason: string };

/**
 * Put a widget on the first page with room: the start page, then the pages after it,
 * else a new "Page N" (at 1,1). The page it lands on becomes active.
 */
export function placeWidget(s: PagesState, req: PlaceRequest, newId: () => string): PlaceResult {
  const sizes = req.sizes.filter((z) => inBounds({ col: 1, row: 1, ...z }));
  if (!sizes.length) return { ok: false, reason: "That widget is larger than the whole board" };
  const taken = allIds(s.pages);
  let instanceId = `${req.widgetId}-${newId()}`;
  while (taken.has(instanceId)) instanceId = `${req.widgetId}-${newId()}`;
  const make = (slot: { col: number; row: number }, size: Size): WidgetInstance => ({ instanceId, widgetId: req.widgetId, ...slot, ...size, config: req.config });

  const start = Math.max(0, s.pages.findIndex((p) => p.id === (req.pageId ?? s.activePage)));
  for (const page of s.pages.slice(start)) {
    for (const size of sizes) {
      const slot = findSlot(page.items, size.w, size.h);
      if (!slot) continue;
      const inst = make(slot, size);
      return { ok: true, state: { pages: mapPage(s, page.id, (items) => [...items, inst]), activePage: page.id }, pageId: page.id, created: false, instanceId };
    }
  }
  const pageIds = new Set(s.pages.map((p) => p.id));
  let pageId = `p${newId()}`;
  while (pageIds.has(pageId)) pageId = `p${newId()}`;
  const page: LayoutPage = { id: pageId, name: nextPageName(s.pages), items: [make({ col: 1, row: 1 }, sizes[0])] };
  return { ok: true, state: { pages: [...s.pages, page], activePage: pageId }, pageId, created: true, instanceId };
}

/** Never removes the last page; removing the active page activates its neighbour (next, else previous). */
export function removePage(s: PagesState, id: string): PagesState {
  const idx = s.pages.findIndex((p) => p.id === id);
  if (idx < 0 || s.pages.length <= 1) return s;
  const pages = s.pages.filter((p) => p.id !== id);
  const activePage = s.activePage === id ? pages[Math.min(idx, pages.length - 1)].id : s.activePage;
  return { pages, activePage };
}

/** Move a widget to another page, keeping its size (else `fallback`); null when the target has no room. */
export function moveToPage(s: PagesState, instanceId: string, targetId: string, fallback?: Size): PagesState | null {
  const from = s.pages.find((p) => p.items.some((i) => i.instanceId === instanceId));
  const target = s.pages.find((p) => p.id === targetId);
  if (!from || !target || from.id === target.id) return null;
  const inst = from.items.find((i) => i.instanceId === instanceId)!;
  for (const size of [{ w: inst.w, h: inst.h }, ...(fallback ? [fallback] : [])]) {
    const slot = findSlot(target.items, size.w, size.h);
    if (!slot) continue;
    const moved = { ...inst, ...slot, ...size };
    const pages = s.pages.map((p) =>
      p.id === from.id ? { ...p, items: p.items.filter((i) => i.instanceId !== instanceId) } : p.id === target.id ? { ...p, items: [...p.items, moved] } : p,
    );
    return { pages, activePage: s.activePage };
  }
  return null;
}

/** Re-mint any id another page already uses (e.g. the default board's fixed ids after a move). */
export function withUniqueIds(items: WidgetInstance[], taken: Set<string>, newId: () => string): WidgetInstance[] {
  return items.map((i) => {
    if (!taken.has(i.instanceId)) return i;
    let id = `${i.widgetId}-${newId()}`;
    while (taken.has(id)) id = `${i.widgetId}-${newId()}`;
    return { ...i, instanceId: id };
  });
}

const isInstance = (v: unknown): v is WidgetInstance => {
  const i = v as WidgetInstance;
  return !!i && typeof i.instanceId === "string" && typeof i.widgetId === "string" && [i.col, i.row, i.w, i.h].every(Number.isFinite);
};

/** Rehydration guard: drop malformed pages/items, never return zero pages, keep `activePage` pointing at a real page. */
export function sanitizePages(raw: unknown, defaults: WidgetInstance[]): PagesState {
  const r = raw as Partial<PagesState> | null | undefined;
  const pages = (Array.isArray(r?.pages) ? r.pages : [])
    .filter((p): p is LayoutPage => !!p && typeof p.id === "string" && !!p.id && Array.isArray(p.items))
    .map((p) => ({
      id: p.id,
      name: typeof p.name === "string" && p.name.trim() ? p.name : "Page",
      items: p.items.filter(isInstance),
      ...(typeof p.wallpaper === "string" && p.wallpaper ? { wallpaper: p.wallpaper } : {}),
      ...(typeof p.mode === "string" && p.mode ? { mode: p.mode } : {}),
    }));
  if (!pages.length) return { pages: [{ id: "p1", name: "Page 1", items: defaults }], activePage: "p1" };
  const startupPage = typeof r?.startupPage === "string" && pages.some((p) => p.id === r.startupPage) ? r.startupPage : null;
  const activePage = pages.some((p) => p.id === r?.activePage) ? (r!.activePage as string) : pages[0].id;
  return { pages, activePage, ...(startupPage ? { startupPage } : {}) };
}

/**
 * Persisted `cc.layout` → the v5 pages shape, from any older version. Zustand calls
 * this once with the stored version, so every branch must end in `{pages, activePage}`.
 * `pipelines` is the desktop-only n8n slot (null on the PWA).
 */
export function migrateLayout(persisted: unknown, version: number, defaults: WidgetInstance[], pipelines: WidgetInstance | null): PagesState {
  if (version >= 5) return sanitizePages(persisted, defaults);
  const old = ((persisted as { instances?: unknown } | null)?.instances ?? []) as WidgetInstance[];
  let instances: WidgetInstance[];
  if (version === 4) instances = old;
  else if (version === 3) {
    // v4 added the n8n Pipelines panel to the centre band when it's free.
    const has = old.some((i) => i.widgetId === "n8n-pipelines");
    instances = pipelines && !has && fits(old, pipelines) ? [...old, pipelines] : old;
  } else {
    // v3 shipped a new default board: start from it, keep generated custom widgets that still fit.
    instances = [...defaults];
    for (const o of old) if (o.widgetId === "custom" && fits(instances, o)) instances = [...instances, o];
  }
  return sanitizePages({ pages: [{ id: "p1", name: "Page 1", items: instances }], activePage: "p1" }, defaults);
}
