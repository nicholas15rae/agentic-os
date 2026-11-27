import { lazy } from "react";
import { PanelTop, Settings2 } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance } from "@/core/widgets/types";

/** Settings on the shared layout: the tab bar and the open tab's content (Nic's pick: no per-card panels). */
export const SETTINGS_SURFACE = "settings";

const page = () => import("@/sections/SettingsSection");

export const SETTINGS_PANELS: WidgetDefinition[] = [
  {
    id: "st-tabs",
    title: "Settings tabs",
    description: "Services, Voice, Modes, Integrations, Business, Appearance, Security; the read-only banner.",
    icon: PanelTop,
    defaultSize: { w: 8, h: 1 },
    minSize: { w: 4, h: 1 },
    defaultConfig: {},
    surfaces: [SETTINGS_SURFACE],
    panel: true,
    compactOrder: 1,
    component: lazy(async () => ({ default: (await page()).SettingsTabBar })),
  },
  {
    id: "st-content",
    title: "Settings",
    description: "The open tab's settings.",
    icon: Settings2,
    defaultSize: { w: 8, h: 7 },
    minSize: { w: 4, h: 3 },
    defaultConfig: {},
    surfaces: [SETTINGS_SURFACE],
    panel: true,
    compactOrder: 2,
    component: lazy(async () => ({ default: (await page()).SettingsContent })),
  },
];
for (const p of SETTINGS_PANELS) registerWidget(p);

/** The old page's centred column (max-w-4xl): the middle eight columns, wallpaper either side. */
export const SETTINGS_DEFAULT: WidgetInstance[] = [
  { instanceId: "tabs", widgetId: "st-tabs", col: 3, row: 1, w: 8, h: 1, config: {} },
  { instanceId: "content", widgetId: "st-content", col: 3, row: 2, w: 8, h: 7, config: {} },
];

export const useSettingsLayout = surfaceStore({ surface: SETTINGS_SURFACE, defaults: SETTINGS_DEFAULT });
