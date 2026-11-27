import { fits, placeWidget, withUniqueIds, type PagesState } from "./pages";
import { gridItems } from "./floating";
import type { WidgetInstance } from "./types";

/**
 * Shared layout system, safety locks (pure). The trading kill switch, Tony's stop and the send
 * confirmations are `locked` panels: they can be moved and resized, but no layout, look, theme,
 * reset or import can remove them, collapse them to an icon, park them on another page, make
 * them click-through, push them off-screen or make them invisible.
 */
export type IsLocked = (widgetId: string) => boolean;

export const isLockedInst = (i: WidgetInstance, isLocked: IsLocked) => isLocked(i.widgetId);

/** True when removing / hiding this panel is allowed. */
export const canHide = (i: WidgetInstance | undefined, isLocked: IsLocked) => !!i && !isLocked(i.widgetId);

/** Click-through (pointer-events: none) is never allowed on a safety control. */
export const canClickThrough = (widgetId: string, isLocked: IsLocked) => !isLocked(widgetId);

/** A page can be deleted only when it holds no safety control. */
export const canRemovePage = (s: PagesState, pageId: string, isLocked: IsLocked) =>
  !(s.pages.find((p) => p.id === pageId)?.items ?? []).some((i) => isLocked(i.widgetId));

/**
 * Reset one page: the first page gets the template back, any other page is cleared. Safety
 * controls that were on the page and are not in the template stay where they were.
 */
export function resetItems(current: WidgetInstance[], template: WidgetInstance[], first: boolean, isLocked: IsLocked, taken: Set<string>, newId: () => string): WidgetInstance[] {
  const base = first ? withUniqueIds(template, taken, newId) : [];
  const keep = current.filter((i) => isLocked(i.widgetId) && !base.some((b) => b.widgetId === i.widgetId));
  // A kept control may overlap the template; it keeps its spot and the template item yields.
  const clear = base.filter((b) => !keep.some((k) => overlaps(k, b)));
  return [...clear, ...keep];
}

const overlaps = (a: WidgetInstance, b: WidgetInstance) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

/**
 * Every safety control in the template is somewhere in the layout: one that went missing
 * (an old save, a hand-edited import) is put back on the first page with room.
 */
export function ensureLocked(s: PagesState, template: WidgetInstance[], isLocked: IsLocked, newId: () => string, carry: WidgetInstance[] = []): PagesState {
  // A control saved off the board (or overlapping another) is taken off and placed again below.
  let state: PagesState = {
    ...s,
    // A floating control keeps its float (sanitizeFloats clamps it); one on the grid must fit among the grid panels.
    pages: s.pages.map((p) => ({ ...p, items: p.items.filter((i) => !isLocked(i.widgetId) || !!i.float || fits(gridItems(p.items), i)) })),
  };
  // `carry`: controls the user added that a reset / "use the shared layout" would otherwise drop.
  const wanted = [...template, ...carry.filter((c) => !template.some((t) => t.widgetId === c.widgetId))];
  for (const t of wanted) {
    if (!isLocked(t.widgetId)) continue;
    if (state.pages.some((p) => p.items.some((i) => i.widgetId === t.widgetId))) continue;
    // Its old spot first when that is free, else the first page with room (else a new page).
    const first = state.pages[0];
    if (first && fits(gridItems(first.items), t) && !state.pages.some((p) => p.items.some((i) => i.instanceId === t.instanceId))) {
      state = { ...state, pages: state.pages.map((p) => (p.id === first.id ? { ...p, items: [...p.items, { ...t, display: undefined, fullSize: undefined }] } : p)) };
      continue;
    }
    const r = placeWidget(state, { widgetId: t.widgetId, sizes: [{ w: t.w, h: t.h }, { w: 1, h: 1 }], config: t.config, pageId: state.pages[0]?.id }, newId);
    if (r.ok) state = { ...r.state, activePage: s.activePage };
  }
  // A locked panel never shows as an icon (it would hide the control behind a tap).
  return {
    ...state,
    pages: state.pages.map((p) => ({ ...p, items: p.items.map((i) => (isLocked(i.widgetId) && i.display === "icon" ? { ...i, display: undefined, fullSize: undefined } : i)) })),
  };
}

/** Every safety control anywhere in a layout (to carry across a reset). */
export const lockedIn = (s: PagesState, isLocked: IsLocked) => s.pages.flatMap((p) => p.items.filter((i) => isLocked(i.widgetId)));

/** A duplicated page never copies a safety control (one per surface, so it can't strand a copy). */
export function withoutLockedOnPage(s: PagesState, pageId: string, isLocked: IsLocked): PagesState {
  return { ...s, pages: s.pages.map((p) => (p.id === pageId ? { ...p, items: p.items.filter((i) => !isLocked(i.widgetId)) } : p)) };
}

/**
 * Every instance id unique across the layout (a bad save or a crafted sync could reuse the kill
 * switch's id on a decoy, so removing the decoy would remove it too). Safety controls keep their
 * id; any other clash gets a fresh one. Pure.
 */
export function uniqueIds(s: PagesState, isLocked: IsLocked, newId: () => string): PagesState {
  const taken = new Set<string>();
  for (const p of s.pages) for (const i of p.items) if (isLocked(i.widgetId)) taken.add(i.instanceId);
  const lockedSeen = new Set<string>();
  return {
    ...s,
    pages: s.pages.map((p) => ({
      ...p,
      items: p.items.map((i) => {
        if (isLocked(i.widgetId) && !lockedSeen.has(i.instanceId)) {
          lockedSeen.add(i.instanceId);
          return i;
        }
        if (!taken.has(i.instanceId)) {
          taken.add(i.instanceId);
          return i;
        }
        let id = `${i.widgetId}-${newId()}`;
        while (taken.has(id)) id = `${i.widgetId}-${newId()}`;
        taken.add(id);
        return { ...i, instanceId: id };
      }),
    })),
  };
}

/** True when any panel with this id is a safety control. */
export const anyLocked = (s: PagesState, instanceId: string, isLocked: IsLocked) => s.pages.some((p) => p.items.some((i) => i.instanceId === instanceId && isLocked(i.widgetId)));

/** Keeps at least `keep` px of a free-floating rect on screen (for free placement and pop-outs). */
export function clampOnScreen(r: { x: number; y: number; w: number; h: number }, vw: number, vh: number, keep = 64) {
  const w = Math.min(r.w, vw);
  const h = Math.min(r.h, vh);
  return { x: Math.min(Math.max(r.x, keep - w), vw - keep), y: Math.min(Math.max(r.y, 0), vh - keep), w, h };
}

/** Safety controls sit fully on screen: `clampOnScreen` with the whole rect kept visible. */
export const clampLocked = (r: { x: number; y: number; w: number; h: number }, vw: number, vh: number) => {
  const w = Math.min(r.w, vw);
  const h = Math.min(r.h, vh);
  return { x: Math.min(Math.max(r.x, 0), vw - w), y: Math.min(Math.max(r.y, 0), vh - h), w, h };
};

/** The smallest content size a safety control can be styled to. */
export const LOCKED_MIN_SCALE = 0.9;

/** A look change on a safety control can't make it unreadable: no custom text colour, no tiny size. */
export function safeLook<T extends { color?: string; scale?: number }>(patch: T, locked: boolean): T {
  if (!locked) return patch;
  const { color: _drop, ...rest } = patch;
  void _drop;
  return { ...rest, ...(rest.scale !== undefined ? { scale: Math.max(LOCKED_MIN_SCALE, rest.scale) } : {}) } as T;
}
