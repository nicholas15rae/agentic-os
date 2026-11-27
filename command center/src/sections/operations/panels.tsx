import { lazy, useEffect } from "react";
import { Bell, Building2, ClipboardCheck, MonitorSmartphone, ScrollText } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";
import { isTauri, type Platform } from "@/lib/platform";

/**
 * Operations on the shared layout system (AGENTS.md, "Everything Is Customizable"): the four tabs
 * the page had (Businesses, Review Queue, Audit, Digest & alerts) are panels on the same grid as
 * the home page, so they can be moved, resized, hidden, added back, collapsed to an icon or opened
 * in a window, per mode, with Reset to default. Each panel renders what its tab rendered, with the
 * tab's help line on top; the Review Queue's icon shows the pending count.
 */
export const OPERATIONS_SURFACE = "operations";

type Body = React.ComponentType<WidgetProps>;

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<Body>, size: { w: number; h: number }, compactOrder: number, platforms?: Platform[]): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  surfaces: [OPERATIONS_SURFACE],
  panel: true,
  compactOrder,
  ...(platforms ? { platforms } : {}),
  component: lazy(async () => ({ default: await load() })),
});

const mod = () => import("@/sections/OperationsSection");

export const OPERATIONS_PANELS: WidgetDefinition[] = [
  // Operations runs on the desktop app: in a browser the page is this one notice.
  panel("op-desktop-only", "Desktop app only", "Operations runs on the desktop app.", MonitorSmartphone, async () => (await mod()).OpsDesktopNotice, { w: 12, h: 8 }, 0, ["pwa"]),
  panel("op-businesses", "Businesses", "Each business you run, kept apart: its cards, key numbers, edit, archive and Add business.", Building2, async () => (await mod()).OpsBusinesses, { w: 7, h: 5 }, 1, ["desktop"]),
  panel("op-review", "Review Queue", "Flagged notes, empty or half-written files and purges waiting for your yes.", ClipboardCheck, async () => {
    const [{ OpsReview }, { useOps }] = await Promise.all([mod(), import("@/features/ops/ops-store")]);
    return function OpsReviewPanel({ setBadge, display }: WidgetProps) {
      // The icon's badge: items waiting for a yes (the old tab's "Review Queue · N").
      const pending = useOps((s) => s.review?.pending ?? 0);
      useEffect(() => setBadge?.(pending ? String(pending) : null), [pending, setBadge]);
      // Collapsed to an icon, only the badge copy is mounted: it never marks the digest seen.
      return <OpsReview markSeen={display !== "icon"} />;
    };
  }, { w: 5, h: 5 }, 2, ["desktop"]),
  panel("op-audit", "Audit", "Rules integrity, the audit chain and the append-only audit trail.", ScrollText, async () => (await mod()).OpsAudit, { w: 7, h: 3 }, 3, ["desktop"]),
  panel("op-digest", "Digest and alerts", "When you hear about the Review Queue: daily digest hour, early threshold and an optional counts-only webhook.", Bell, async () => (await mod()).OpsDigest, { w: 5, h: 3 }, 4, ["desktop"]),
];
for (const p of OPERATIONS_PANELS) registerWidget(p);

/** The finished template (what Reset restores): businesses and the queue on top, audit and digest below. */
export const OPERATIONS_DEFAULT_DESKTOP: WidgetInstance[] = [
  { instanceId: "businesses", widgetId: "op-businesses", col: 1, row: 1, w: 7, h: 5, config: {} },
  { instanceId: "review", widgetId: "op-review", col: 8, row: 1, w: 5, h: 5, config: {} },
  { instanceId: "audit", widgetId: "op-audit", col: 1, row: 6, w: 7, h: 3, config: {} },
  { instanceId: "digest", widgetId: "op-digest", col: 8, row: 6, w: 5, h: 3, config: {} },
];
/** Browser / phone: every Operations block is desktop-only, so the page is the notice. */
export const OPERATIONS_DEFAULT_WEB: WidgetInstance[] = [{ instanceId: "desktop-only", widgetId: "op-desktop-only", col: 1, row: 1, w: 12, h: 8, config: {} }];
export const OPERATIONS_DEFAULT = isTauri() ? OPERATIONS_DEFAULT_DESKTOP : OPERATIONS_DEFAULT_WEB;

export const useOperationsLayout = surfaceStore({ surface: OPERATIONS_SURFACE, defaults: OPERATIONS_DEFAULT });
