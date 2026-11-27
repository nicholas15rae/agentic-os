import { pageForMode, sanitizePages, startupOf, type PagesState } from "./pages";
import type { WidgetInstance } from "./types";

/**
 * Shared layout system, per-mode layouts (pure). Every mode shows the surface's shared
 * ("default") layout until you pick "Customize for this mode", which copies it. The live
 * layout is always in `pages`; the others wait in `variants` until their mode comes back.
 */
export const SHARED = "default";

export interface VariantState {
  /** Which layout is live: SHARED or a mode id. */
  variant: string;
  /** The layouts that are not live, by SHARED / mode id. */
  variants: Record<string, PagesState>;
}

type Live = PagesState & VariantState;

const livePart = (s: PagesState): PagesState => ({ pages: s.pages, activePage: s.activePage, ...(s.startupPage ? { startupPage: s.startupPage } : {}) });

/** The layout a mode uses: its own when customized, else the shared one. */
export const variantFor = (s: VariantState, mode: string | null | undefined) => (mode && (mode === s.variant || mode in s.variants) && mode !== SHARED ? mode : SHARED);

/** The page to open after a swap: the one linked to `mode`, else the startup page (never a page linked to another mode's switch). */
const landing = (p: PagesState, mode: string | null | undefined) => (mode && pageForMode(p.pages, mode)?.id) || startupOf(p);

/** Swap in `mode`'s layout; null when it is already live. */
export function switchTo(s: Live, mode: string | null | undefined): Live | null {
  const target = variantFor(s, mode);
  if (target === s.variant) return null;
  const next = s.variants[target];
  if (!next) return null;
  const variants = { ...s.variants, [s.variant]: livePart(s) };
  delete variants[target];
  return { ...next, startupPage: next.startupPage ?? null, activePage: landing(next, mode), variant: target, variants };
}

/** Give `mode` its own copy of the live layout (it becomes the live one). */
export function customize(s: Live, mode: string): Live | null {
  if (!mode || mode === SHARED || s.variant === mode) return null;
  // Another mode's custom layout is live: start the new one from the shared layout, not from it.
  const from = s.variant === SHARED ? livePart(s) : s.variants[SHARED];
  if (!from) return null;
  const variants = { ...s.variants };
  if (s.variant !== SHARED) variants[s.variant] = livePart(s);
  else variants[SHARED] = livePart(s);
  delete variants[mode];
  return { ...structuredClone(from), startupPage: from.startupPage ?? null, variant: mode, variants };
}

/** `mode` goes back to the shared layout (its own copy is dropped). */
export function backToShared(s: Live, mode: string): Live | null {
  if (!mode || mode === SHARED) return null;
  if (s.variant === mode) {
    const shared = s.variants[SHARED];
    if (!shared) return null;
    const variants = { ...s.variants };
    delete variants[SHARED];
    return { ...shared, startupPage: shared.startupPage ?? null, activePage: landing(shared, mode), variant: SHARED, variants };
  }
  if (!(mode in s.variants)) return null;
  const variants = { ...s.variants };
  delete variants[mode];
  return { ...s, variants };
}

/** The modes with a layout of their own. */
export const customizedModes = (s: VariantState) => [s.variant, ...Object.keys(s.variants)].filter((k) => k !== SHARED);

/** Rehydration guard for the stored variants (each one sanitized like the live layout). */
export function sanitizeVariants(raw: unknown, defaults: WidgetInstance[]): VariantState {
  const r = raw as Partial<VariantState> | null | undefined;
  const variant = typeof r?.variant === "string" && r.variant ? r.variant : SHARED;
  const variants: Record<string, PagesState> = {};
  if (r?.variants && typeof r.variants === "object") {
    for (const [k, v] of Object.entries(r.variants)) if (k && k !== variant) variants[k] = sanitizePages(v, defaults);
  }
  // A mode layout is live but the shared one went missing: the live one stands in for both.
  if (variant !== SHARED && !variants[SHARED]) return { variant: SHARED, variants };
  return { variant, variants };
}
