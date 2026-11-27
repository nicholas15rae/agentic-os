import { useLayout } from "@/core/widgets/layout-store";
import { useToasts } from "@/features/reminders/notify";
import { hasPromotedTile } from "./promoted";

/**
 * After a successful build_promote of an internal widget: a build that already has a dashboard
 * tile updates it in place (the tile reloads on the new promoted_at); otherwise one is added.
 */
export function placePromotedTile(buildId: string, title: string): void {
  const toast = useToasts.getState().push;
  if (hasPromotedTile(useLayout.getState().pages, buildId)) {
    toast({ title: "Updated", body: `“${title}” is updated on the live dashboard.`, tone: "info" });
    return;
  }
  const added = useLayout.getState().add("staged-build", { buildId, title });
  toast({ title: "Promoted", body: added.ok ? `“${title}” is on the live dashboard.` : `Promoted, but the dashboard had no room: ${added.reason ?? "add it from Widgets"}.`, tone: added.ok ? "info" : "error" });
}
