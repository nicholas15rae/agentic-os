import type { LayoutPage, PagesState } from "./pages";
import { isLockedWidget } from "./registry";

/**
 * What Add panel hides: panels already on this page, and a safety control anywhere in the section
 * (one per section). Another page's panels can be added again, so a sub-page can hold its own copy. Pure.
 */
export function drawerExclude(s: Pick<PagesState, "pages" | "activePage">): string[] {
  const here = s.pages.find((p) => p.id === s.activePage)?.items.map((i) => i.widgetId) ?? [];
  const locked = s.pages.flatMap((p) => p.items.map((i) => i.widgetId)).filter(isLockedWidget);
  return [...new Set([...here, ...locked])];
}

/**
 * UI fixes 1: sub-pages for every section (pure helpers). A section's layout store already holds
 * pages; these decide when its page tabs show and where a swipe or Ctrl+Alt+arrow goes.
 */

/** The tab strip shows once a section has a second page, or in Edit layout (to add one). A one-page section looks exactly as before. */
export const showTabs = (pageCount: number, editing: boolean): boolean => pageCount > 1 || editing;

/** A horizontal swipe this far (px) turns the page. */
export const SWIPE_MIN_PX = 60;

/**
 * A finished touch swipe → the page step: 1 (next, finger moved left), -1 (previous) or 0. It must
 * be mostly sideways (|dx| ≥ 1.5 × |dy|), so scrolling the column never turns the page. Pure.
 */
export function swipeStep(dx: number, dy: number, min = SWIPE_MIN_PX): -1 | 0 | 1 {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** The page `step` away from `active` (no wrap-around), or null at either end. Pure. */
export function neighbourPage(pages: readonly LayoutPage[], active: string, step: -1 | 0 | 1): string | null {
  if (!step) return null;
  const i = pages.findIndex((p) => p.id === active);
  if (i < 0) return null;
  return pages[i + step]?.id ?? null;
}

/** Elements whose own sideways drag wins over a page swipe (sliders, fields, maps, charts, anything scrolling sideways). */
export const SWIPE_IGNORE = "input,textarea,select,[role=slider],[contenteditable],[data-no-swipe],canvas,iframe";

/** True when `el` or an ancestor (up to `stop`) scrolls sideways, so the swipe belongs to it. */
export function scrollsSideways(el: Element | null, stop: Element | null): boolean {
  for (let n: Element | null = el; n && n !== stop; n = n.parentElement) {
    const h = n as HTMLElement;
    if (h.scrollWidth > h.clientWidth + 1) {
      const ox = typeof getComputedStyle === "function" ? getComputedStyle(h).overflowX : "";
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}
