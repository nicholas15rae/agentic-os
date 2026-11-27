import { GRID_COLS, GRID_ROWS, type PagesState } from "./pages";
import type { WidgetInstance } from "./types";
import type { IsLocked } from "./locks";

/**
 * Shared layout system, window options (pure): a panel can float off the grid (a free rect over
 * the board, as fractions of the board so it survives a resize or another screen), let clicks
 * pass through to what is under it, and be pinned above the other floating panels.
 *
 * Safety controls may float, but always fully on the board, never click-through.
 */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest floating panel (fraction of the board). */
export const FLOAT_MIN = 0.08;
/** An ordinary floating panel keeps at least this much of itself on the board. */
export const FLOAT_KEEP = 0.06;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The panel's grid cell as a floating rect (where it starts when it starts floating). Pure. */
export const floatFromGrid = (i: Pick<WidgetInstance, "col" | "row" | "w" | "h">): FloatRect => ({ x: (i.col - 1) / GRID_COLS, y: (i.row - 1) / GRID_ROWS, w: i.w / GRID_COLS, h: i.h / GRID_ROWS });

/** A float kept usable: a sane size, a grab-handle's worth on the board; a safety control wholly on it. Pure. */
export function clampFloat(r: Partial<FloatRect>, locked: boolean): FloatRect {
  const w = clamp(finite(r.w, 0.3), FLOAT_MIN, 1);
  const h = clamp(finite(r.h, 0.3), FLOAT_MIN, 1);
  const x = finite(r.x, 0.1);
  const y = finite(r.y, 0.1);
  if (locked) return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h };
  return { x: clamp(x, FLOAT_KEEP - w, 1 - FLOAT_KEEP), y: clamp(y, 0, 1 - FLOAT_KEEP), w, h };
}

/** The panels that take grid cells (floating ones don't block the grid). Pure. */
export const gridItems = (items: WidgetInstance[]) => items.filter((i) => !i.float);
export const floatingItems = (items: WidgetInstance[]) => items.filter((i) => !!i.float);

/** `s` with only grid panels (for the grid's placement maths), and a way to put the floats back. Pure. */
export function withoutFloats(s: PagesState): { grid: PagesState; restore: (next: PagesState) => PagesState } {
  const floats = new Map(s.pages.map((p) => [p.id, floatingItems(p.items)]));
  const grid = { ...s, pages: s.pages.map((p) => ({ ...p, items: gridItems(p.items) })) };
  const restore = (next: PagesState): PagesState => ({ ...next, pages: next.pages.map((p) => ({ ...p, items: [...p.items, ...(floats.get(p.id) ?? [])] })) });
  return { grid, restore };
}

/** Rehydration / import guard: every float clamped, and safety controls never click-through. Pure. */
export function sanitizeFloats(s: PagesState, isLocked: IsLocked): PagesState {
  return {
    ...s,
    pages: s.pages.map((p) => ({
      ...p,
      items: p.items.map((i) => {
        const locked = isLocked(i.widgetId);
        const next: WidgetInstance = { ...i };
        if (i.float) next.float = clampFloat(i.float, locked);
        else delete next.float;
        // Click-through is a floating panel's option, never a safety control's.
        if (locked || !i.float || i.clickThrough !== true) delete next.clickThrough;
        if (!i.float || i.pinned !== true) delete next.pinned;
        return next;
      }),
    })),
  };
}
