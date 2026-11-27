import { platform } from "@/lib/platform";
import type { WidgetDefinition } from "./types";

// Auto-discovery: any folder under src/widgets with an index.ts that
// default-exports a WidgetDefinition becomes available in the "Add widget" tray.
const modules = import.meta.glob<{ default: WidgetDefinition<any> }>("../../widgets/*/index.ts", { eager: true });

const registry = new Map<string, WidgetDefinition<any>>();

for (const [path, mod] of Object.entries(modules)) {
  const def = mod.default;
  if (!def?.id) {
    console.warn(`[widgets] ${path} has no default WidgetDefinition export — skipped`);
    continue;
  }
  if (registry.has(def.id)) {
    console.warn(`[widgets] duplicate widget id "${def.id}" in ${path} — skipped`);
    continue;
  }
  registry.set(def.id, def);
}

export function getWidget(id: string): WidgetDefinition<any> | undefined {
  return registry.get(id);
}

/**
 * Shared layout system: a page's own panels (Play Place, Trading…) register here instead of
 * living in src/widgets. A duplicate id is ignored (hot reload re-runs a page module).
 */
export function registerWidget(def: WidgetDefinition<any>): void {
  if (!def?.id || registry.has(def.id)) return;
  registry.set(def.id, def);
}

/** Safety controls (kill switch, Tony's stop, confirmations): never hidden, removed or click-through. */
export const isLockedWidget = (id: string): boolean => !!registry.get(id)?.locked;

/** The surfaces a widget can be placed on (default: the home page only). */
export const surfacesOf = (def: WidgetDefinition<any>): readonly string[] => def.surfaces ?? ["home"];

/** Widgets usable on the current platform and on `surface` (default: home), sorted by title. */
export function availableWidgets(surface = "home"): WidgetDefinition<any>[] {
  return [...registry.values()]
    .filter((w) => (!w.platforms || w.platforms.includes(platform)) && surfacesOf(w).includes(surface))
    .sort((a, b) => a.title.localeCompare(b.title));
}
