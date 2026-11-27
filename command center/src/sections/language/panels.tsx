import { lazy } from "react";
import { Languages, PanelTop } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance } from "@/core/widgets/types";

/** Language Hub on the shared layout: the view tabs and the open view (as Settings: no per-card panels). */
export const LANGUAGE_SURFACE = "language";

const page = () => import("@/sections/LanguageSection");

export const LANGUAGE_PANELS: WidgetDefinition[] = [
  {
    id: "lg-tabs",
    title: "Language tabs",
    description: "Live Translate, Learn & Practice, Library; the engine badge and the Voice settings toggle.",
    icon: PanelTop,
    defaultSize: { w: 10, h: 1 },
    minSize: { w: 4, h: 1 },
    defaultConfig: {},
    surfaces: [LANGUAGE_SURFACE],
    panel: true,
    compactOrder: 1,
    component: lazy(async () => ({ default: (await page()).LanguageTabBar })),
  },
  {
    id: "lg-content",
    title: "Language Hub",
    description: "The open view: the live translator, the tutor and drills, or the phrase library (and the Voice settings when open).",
    icon: Languages,
    defaultSize: { w: 10, h: 7 },
    minSize: { w: 4, h: 3 },
    defaultConfig: {},
    surfaces: [LANGUAGE_SURFACE],
    panel: true,
    compactOrder: 2,
    component: lazy(async () => ({ default: (await page()).LanguageContent })),
  },
];
for (const p of LANGUAGE_PANELS) registerWidget(p);

/** The old page's centred column (max-w-6xl): the middle ten columns. */
export const LANGUAGE_DEFAULT: WidgetInstance[] = [
  { instanceId: "tabs", widgetId: "lg-tabs", col: 2, row: 1, w: 10, h: 1, config: {} },
  { instanceId: "content", widgetId: "lg-content", col: 2, row: 2, w: 10, h: 7, config: {} },
];

export const useLanguageLayout = surfaceStore({ surface: LANGUAGE_SURFACE, defaults: LANGUAGE_DEFAULT });
