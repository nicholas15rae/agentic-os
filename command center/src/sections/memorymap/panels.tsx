import { lazy } from "react";
import { Activity, Box, Car, ListTodo, NotebookPen, PanelTop, Workflow } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";

/**
 * System Map (Page 1 · Gabagool Blueprint) on the shared layout system (AGENTS.md, "Everything Is
 * Customizable"): the status bar, the left column, the car stage, the live trace (with the zone
 * inspector drawer over it), the note bar and the task dock are panels on the same 12x8 grid as
 * the home page (move, resize, hide, add back, icon, window, per mode, Reset). The routing
 * flowchart is drawn on the stage by default; add the "Architecture routing" panel to give it a
 * box of its own (the stage then drops its strip). Pages 2 and 3 are full-page canvases.
 */
export const SYSTEMMAP_SURFACE = "systemmap";

type Body = React.ComponentType<WidgetProps>;

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<Body>, size: { w: number; h: number }, compactOrder: number, extra: Partial<WidgetDefinition> = {}): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 2, h: 1 },
  defaultConfig: {},
  surfaces: [SYSTEMMAP_SURFACE],
  panel: true,
  compactOrder,
  ...extra,
  component: lazy(async () => ({ default: await load() })),
});

const page = () => import("@/sections/MemoryMapSection");

export const SYSTEMMAP_PANELS: WidgetDefinition[] = [
  panel("sm-status", "System status bar", "OS state, voice, mode, Dev X-Ray and the snapshot clock.", PanelTop, async () => (await page()).SmStatusBar, { w: 12, h: 1 }, 1, { minSize: { w: 4, h: 1 } }),
  panel("sm-flow", "Architecture routing", "The routing flowchart with live pulses. Off the board by default: the stage draws it as a strip until this panel is added.", Workflow, async () => (await page()).SmFlowchart, { w: 7, h: 2 }, 2, { minSize: { w: 3, h: 1 } }),
  panel("sm-stage", "Car stage", "The 3D E46 (static chassis on phones), zone callouts, the badge and the Gabagool blueprint inset.", Car, async () => (await page()).SmStage, { w: 7, h: 5 }, 3, { minSize: { w: 4, h: 3 } }),
  panel("sm-trace", "Real-time action & stream", "The live routing trace, newest turn first; the zone inspector opens over it.", Activity, async () => (await page()).SmTrace, { w: 3, h: 5 }, 4, { minSize: { w: 2, h: 2 }, compactHeight: "max(300px, 60dvh)" }),
  panel("sm-note", "Intent & runtime note", "Type or dictate a note, kind and runtime context.", NotebookPen, async () => (await page()).SmNote, { w: 3, h: 2 }, 5, { minSize: { w: 2, h: 2 } }),
  panel("sm-dock", "Future tasks & autonomous queue", "The dev task queue and what the OS runs next; Export Session Brief.", ListTodo, async () => (await page()).SmDock, { w: 7, h: 2 }, 6, { minSize: { w: 3, h: 2 } }),
  panel("sm-left", "OS backend architecture", "OS state, delegation / overload switches, arbiter HUD and the subsystem cards.", Box, async () => (await page()).SmLeft, { w: 2, h: 7 }, 7, { minSize: { w: 2, h: 2 } }),
];
for (const p of SYSTEMMAP_PANELS) registerWidget(p);

/**
 * The finished template (what Reset restores), desktop and browser alike: the old HUD grid
 * [260 | 1fr | 320] x [auto | 1fr | 220] on 12 columns — the status bar across the top, the left
 * column (2 cols), the stage over the task dock in the centre (7 cols), the trace over the note
 * bar on the right (3 cols). The flowchart panel is not placed (the stage draws its strip).
 */
export const SYSTEMMAP_DEFAULT: WidgetInstance[] = [
  { instanceId: "status", widgetId: "sm-status", col: 1, row: 1, w: 12, h: 1, config: {} },
  // The roster needs room (the old fixed 260-280 px column): three columns.
  { instanceId: "left", widgetId: "sm-left", col: 1, row: 2, w: 3, h: 7, config: {} },
  { instanceId: "stage", widgetId: "sm-stage", col: 4, row: 2, w: 6, h: 5, config: {} },
  { instanceId: "dock", widgetId: "sm-dock", col: 4, row: 7, w: 6, h: 2, config: {} },
  { instanceId: "trace", widgetId: "sm-trace", col: 10, row: 2, w: 3, h: 5, config: {} },
  { instanceId: "note", widgetId: "sm-note", col: 10, row: 7, w: 3, h: 2, config: {} },
];

export const useSystemMapLayout = surfaceStore({ surface: SYSTEMMAP_SURFACE, defaults: SYSTEMMAP_DEFAULT });
