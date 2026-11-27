import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import type { Platform } from "@/lib/platform";
import type { DisplayMode, WidgetLook } from "./look";

/**
 * The widget contract. Every widget lives in `src/widgets/<id>/index.ts` and
 * default-exports `defineWidget({...})`. The registry discovers it automatically —
 * no central list to edit, no layout code to touch.
 */
export interface WidgetProps<C = Record<string, unknown>> {
  instanceId: string;
  config: C;
  /** Persist a config change for this instance. */
  setConfig: (patch: Partial<C>) => void;
  /** Current size in grid units, so widgets can render compact/expanded variants. */
  size: { w: number; h: number };
  /** Section pass: a short badge / live value for this widget's app icon ("3", "18°"); null clears it. */
  setBadge?: (badge: string | null) => void;
  /** How it is shown right now (icon-mode widgets render full size inside their window). */
  display?: DisplayMode;
}

export interface WidgetDefinition<C = Record<string, unknown>> {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Grid units on the 12-column × 8-row desktop canvas. */
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  /** Omit to allow everywhere. */
  platforms?: Platform[];
  /** Extra words a "Generate" prompt can name to add this widget directly (id and title always count). */
  keywords?: string[];
  defaultConfig: C;
  /** Phone stack position (lower = higher up). Defaults to the desktop row. */
  compactOrder?: number;
  /** Draw without a glass card (e.g. the mantra hero that sits directly on the wallpaper). */
  chromeless?: boolean;
  /**
   * A page's own panel (Play Place staging hub, Trading desk…): it draws its own card, so it sits
   * frameless, scrolls instead of shrinking to fit, and a tap doesn't focus it.
   */
  panel?: boolean;
  /** Phone column: the panel's height (CSS), for a panel that scrolls inside itself (a chat). */
  compactHeight?: string;
  /** Shared layout system: the pages this can be placed on (default: ["home"]). */
  surfaces?: string[];
  /**
   * A safety control (trading kill switch, Tony's stop, send confirmations): it can be moved and
   * resized but never removed, collapsed to an icon, moved to another page, made click-through,
   * moved off-screen or styled invisible.
   */
  locked?: boolean;
  /** Lazy so each widget is its own chunk and a crash in one never takes down the grid. */
  component: LazyExoticComponent<ComponentType<WidgetProps<C>>>;
}

export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  /** 1-based grid placement. */
  col: number;
  row: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
  /** Ultra-glass: near-transparent panel so the wallpaper shows through. */
  glass?: "ultra";
  /** Section pass: frame, font, size, colour, alignment, per-wallpaper opacity. */
  look?: WidgetLook;
  /** Section pass: full (default), compact, or an app-sized icon that opens as a window. */
  display?: DisplayMode;
  /** The full size to come back to from icon / compact. */
  fullSize?: { w: number; h: number };
  /** Window options: floating off the grid (fractions of the board), clicks passing through, pinned above other floats. */
  float?: { x: number; y: number; w: number; h: number };
  clickThrough?: boolean;
  pinned?: boolean;
}

export function defineWidget<C extends Record<string, unknown>>(def: WidgetDefinition<C>): WidgetDefinition<C> {
  return def;
}
