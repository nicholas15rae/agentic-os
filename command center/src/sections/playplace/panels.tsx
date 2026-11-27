import { lazy, useEffect } from "react";
import { FlaskConical, Hammer, Layers, Lightbulb } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";
import { isTauri, type Platform } from "@/lib/platform";

/**
 * Play Place on the shared layout system (AGENTS.md, "Everything Is Customizable"): its four
 * building blocks are panels on the same grid as the home page, so they can be moved, resized,
 * hidden, added back from the drawer, collapsed to an icon or opened in a window, per mode, with
 * Reset to default. The panels render what the page rendered before; Compact is their phone-size
 * view, and the staging hub's icon shows the repair count.
 */
export const PLAYPLACE = "playplace";

type Body = React.ComponentType<WidgetProps>;

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<Body>, size: { w: number; h: number }, compactOrder: number, platforms?: Platform[]): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  surfaces: [PLAYPLACE],
  panel: true,
  compactOrder,
  ...(platforms ? { platforms } : {}),
  component: lazy(async () => ({ default: await load() })),
});

const compactOf = (p: WidgetProps) => p.display === "compact";

export const PLAYPLACE_PANELS: WidgetDefinition[] = [
  panel(
    "pp-staging-hub",
    "Staging hub",
    "Builds in the queue, building, in repair and ready: steer, pause, promote, archive, Trash.",
    Layers,
    async () => {
      const [{ StagingHub }, { useHub }, { hubCounts }] = await Promise.all([import("@/features/buildhub/StagingHub"), import("@/features/buildhub/hub-store"), import("@/features/buildhub/format")]);
      return function StagingHubPanel({ setBadge }: WidgetProps) {
        // The icon's badge: builds waiting in the Repair queue (the hub tab's count).
        const repair = useHub((s) => hubCounts(s.view?.builds ?? []).repair);
        useEffect(() => setBadge?.(repair ? String(repair) : null), [repair, setBadge]);
        return <StagingHub />;
      };
    },
    { w: 12, h: 4 },
    1,
    // The hub is desktop-only (it renders nothing in a browser).
    ["desktop"],
  ),
  panel("pp-build-runners", "Build runners", "Builds in flight: stage, who has it, iteration; the latest finished runs.", Hammer, async () => {
    const { PipelineBars } = await import("@/sections/PlayPlaceSection");
    return function BuildRunnersPanel() {
      return <PipelineBars showEmpty />;
    };
  }, { w: 4, h: 4 }, 2),
  panel("pp-play-cards", "Play cards", "Staged prototypes in their sandbox: open, pin, send to the Director, archive.", FlaskConical, async () => {
    const { PlayCards } = await import("@/sections/PlayPlaceSection");
    return function PlayCardsPanel(p: WidgetProps) {
      return <PlayCards compact={compactOf(p)} />;
    };
  }, { w: 5, h: 4 }, 3),
  panel("pp-ideas-ledger", "Ideas and fixes", "The ideas ledger and the Dev Fix queue.", Lightbulb, async () => {
    const { IdeasLedger } = await import("@/sections/PlayPlaceSection");
    return function IdeasLedgerPanel(p: WidgetProps) {
      return <IdeasLedger compact={compactOf(p)} />;
    };
  }, { w: 3, h: 4 }, 4),
];
for (const p of PLAYPLACE_PANELS) registerWidget(p);

/** The finished template (what Reset restores): the hub across the top, the rest below. */
export const PLAYPLACE_DEFAULT_DESKTOP: WidgetInstance[] = [
  { instanceId: "staging-hub", widgetId: "pp-staging-hub", col: 1, row: 1, w: 12, h: 4, config: {} },
  { instanceId: "build-runners", widgetId: "pp-build-runners", col: 1, row: 5, w: 4, h: 4, config: {} },
  { instanceId: "play-cards", widgetId: "pp-play-cards", col: 5, row: 5, w: 5, h: 4, config: {} },
  { instanceId: "ideas-ledger", widgetId: "pp-ideas-ledger", col: 10, row: 5, w: 3, h: 4, config: {} },
];
/** Browser / phone: no staging hub (desktop-only), so the rest fill the board. */
export const PLAYPLACE_DEFAULT_WEB: WidgetInstance[] = [
  { instanceId: "build-runners", widgetId: "pp-build-runners", col: 1, row: 1, w: 4, h: 8, config: {} },
  { instanceId: "play-cards", widgetId: "pp-play-cards", col: 5, row: 1, w: 5, h: 8, config: {} },
  { instanceId: "ideas-ledger", widgetId: "pp-ideas-ledger", col: 10, row: 1, w: 3, h: 8, config: {} },
];
export const PLAYPLACE_DEFAULT = isTauri() ? PLAYPLACE_DEFAULT_DESKTOP : PLAYPLACE_DEFAULT_WEB;

export const usePlayPlaceLayout = surfaceStore({ surface: PLAYPLACE, defaults: PLAYPLACE_DEFAULT });
