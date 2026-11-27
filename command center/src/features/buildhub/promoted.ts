import type { BuildHubView, BuildView } from "./types";

export interface PromotedWidget {
  buildId: string;
  /** The widget's own name (its page title), else the build's title. */
  title: string;
  /** The Play Place build it came from, when that differs from `title`. */
  buildTitle: string | null;
  promotedAt: number;
}

/**
 * Builds that can sit on the dashboard: internal widgets promoted after their smoke test, newest
 * first. The hub keeps them (build-hub.json + the frozen copy) after their grid tile is removed, so
 * the Add tray can put them back any time; deleting the build in the Play Place drops it here too.
 */
export function promotedWidgets(view: BuildHubView | null): PromotedWidget[] {
  if (!view) return [];
  return view.builds
    .filter((b) => b.envelope.target_runtime === "internal_widget" && b.promoted_at != null)
    .map((b) => {
      const own = b.widget_title?.trim();
      const title = own || b.envelope.title;
      return { buildId: b.envelope.build_id, title, buildTitle: title === b.envelope.title ? null : b.envelope.title, promotedAt: b.promoted_at as number };
    })
    .sort((a, b) => b.promotedAt - a.promotedAt);
}

/** Does any dashboard page already hold a tile for this build? (Re-promoting updates it instead of adding another.) */
export function hasPromotedTile(pages: { items: { widgetId: string; config: Record<string, unknown> }[] }[], buildId: string): boolean {
  return pages.some((p) => p.items.some((i) => i.widgetId === "staged-build" && i.config.buildId === buildId));
}

/** What a promoted tile shows about its build while it's being reworked in the Play Place. */
export type ReworkView =
  | { kind: "live" }
  | { kind: "working"; label: string; progress: number }
  | { kind: "ready" }
  | { kind: "repair" }
  | { kind: "cancelled" };

export function reworkView(b: Pick<BuildView, "envelope" | "progress"> | undefined): ReworkView {
  if (!b) return { kind: "live" };
  switch (b.envelope.status) {
    case "deployed":
      return { kind: "live" };
    case "ready_for_merge":
      return { kind: "ready" };
    case "repair_queue":
      return { kind: "repair" };
    case "cancelled":
      return { kind: "cancelled" };
    case "queued":
      return { kind: "working", label: "Queued", progress: 0 };
    case "paused":
      return { kind: "working", label: "Paused", progress: b.progress };
    case "smoke_testing":
      return { kind: "working", label: "Smoke testing", progress: b.progress };
    case "building":
      return { kind: "working", label: "Building", progress: b.progress };
  }
}
