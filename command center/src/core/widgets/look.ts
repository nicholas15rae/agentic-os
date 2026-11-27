import type { WidgetInstance } from "./types";

/**
 * Section pass: a widget's own look, saved with its page. Every field is optional: a widget with
 * no `look` renders exactly as before (glass, or frameless for a chromeless widget).
 */
export type Frame = "glass" | "ultra" | "solid" | "frameless";
export type FontChoice = "sans" | "mono" | "display";
export type Align = "start" | "center" | "end";
/** Icon (an app-sized tile that opens as a window), compact or full size (`display`). */
export type DisplayMode = "full" | "compact" | "icon";

export interface WidgetLook {
  frame?: Frame;
  font?: FontChoice;
  /** Text and content size, 0.6–1.6 (1 = as designed). */
  scale?: number;
  /** A CSS colour for the widget's text ("" / missing: the theme's). */
  color?: string;
  align?: Align;
  /** Glass opacity 0–1, per wallpaper id (a widget can read differently on each wallpaper). */
  opacity?: Record<string, number>;
}

export const SCALE_MIN = 0.6;
export const SCALE_MAX = 1.6;
export const DEFAULT_GLASS_ALPHA = 0.62;

export const clampScale = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) : 1);

/** The frame a widget draws: its own choice, else the old ultra toggle, else frameless for a chromeless widget. Pure. */
export function frameOf(inst: Pick<WidgetInstance, "glass" | "look">, chromeless: boolean): Frame {
  return inst.look?.frame ?? (inst.glass === "ultra" ? "ultra" : chromeless ? "frameless" : "glass");
}

/** Glass opacity on `wallpaperId` (falls back to the default). Pure. */
export function opacityFor(look: WidgetLook | undefined, wallpaperId: string | null | undefined): number {
  const v = wallpaperId ? look?.opacity?.[wallpaperId] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_GLASS_ALPHA;
}

/** Merge a look patch; an `opacity` patch merges per wallpaper. Pure. */
export function mergeLook(cur: WidgetLook | undefined, patch: WidgetLook): WidgetLook {
  const next: WidgetLook = { ...cur, ...patch };
  if (patch.opacity) next.opacity = { ...cur?.opacity, ...patch.opacity };
  if (next.scale !== undefined) next.scale = clampScale(next.scale);
  return next;
}

export const FONT_CLASS: Record<FontChoice, string> = { sans: "", mono: "font-mono", display: "font-semibold uppercase tracking-wider" };
export const ALIGN_CLASS: Record<Align, string> = { start: "text-left", center: "text-center", end: "text-right" };

/** A content-fit zoom: shrink (never grow) content whose natural size is larger than its box. Pure. */
export function fitZoom(box: { w: number; h: number }, natural: { w: number; h: number }, userScale: number): number {
  if (box.w <= 0 || box.h <= 0 || natural.w <= 0 || natural.h <= 0) return 1;
  return Math.min(1, box.w / (natural.w * userScale), box.h / (natural.h * userScale));
}

/** The smallest content zoom fit-to-cell goes to (below this a widget is unreadable anyway). */
export const FIT_MIN = 0.35;

/** How far an element's content overflows its own box (1 = fits). Same-element ratio: zoom-proof. */
export function overflowRatio(el: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number }): number {
  return Math.max(el.scrollHeight / Math.max(1, el.clientHeight), el.scrollWidth / Math.max(1, el.clientWidth));
}

/** Rec. 709 luma of an average RGB (0–255) → "light" above the midpoint. Pure. */
export function wallTone(r: number, g: number, b: number): "light" | "dark" {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "light" : "dark";
}
