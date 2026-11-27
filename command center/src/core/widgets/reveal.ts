import type { LayoutStore } from "./layout-store";
import { useToasts } from "@/features/reminders/notify";

/**
 * Shared layout system: a link into a page (a card, a build, a thread) always lands on something
 * visible. Shows the panel `widgetId` on `store`'s surface: switches to the page that holds it,
 * opens its window when it is an icon, or adds it back when it was hidden (a toast when there is
 * no room). Returns true when the panel is now visible.
 */
export function revealPanel(store: LayoutStore, widgetId: string, label: string): boolean {
  const s = store.getState();
  const page = s.pages.find((p) => p.items.some((i) => i.widgetId === widgetId));
  const inst = page?.items.find((i) => i.widgetId === widgetId);
  if (!page || !inst) {
    const r = s.add(widgetId, undefined, { noNewPage: true });
    if (!r.ok) useToasts.getState().push({ title: label, body: `That panel is hidden and there's no room for it: ${r.reason ?? "hide or shrink a panel"}, or Reset this page.`, tone: "info" });
    return r.ok;
  }
  if (page.id !== s.activePage) s.setActivePage(page.id);
  if (inst.display === "icon") store.getState().openWindow(inst.instanceId);
  // The phone column (and any board taller than the screen) scrolls to it.
  else if (typeof document !== "undefined")
    requestAnimationFrame(() => document.querySelector(`[data-widget="${CSS.escape(inst.instanceId)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  return true;
}

/** True when `widgetId` is on the active page in a cell (not an icon) or open in a window. */
export function panelShown(s: ReturnType<LayoutStore["getState"]>, widgetId: string): boolean {
  const inst = s.pages.find((p) => p.id === s.activePage)?.items.find((i) => i.widgetId === widgetId);
  return !!inst && (inst.display !== "icon" || s.windows.some((w) => w.instanceId === inst.instanceId));
}
