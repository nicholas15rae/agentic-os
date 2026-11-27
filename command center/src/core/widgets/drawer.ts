/**
 * Section pass: the widget drawer's catalogue (pure). Every widget belongs to one category; a
 * widget without an entry here is "Other", so a new widget folder shows up without editing this.
 */
export const CATEGORIES = ["Your builds", "At a glance", "Work & business", "Media & Tony", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

const BY_ID: Record<string, Category> = {
  "system-stats": "At a glance",
  weather: "At a glance",
  mantra: "At a glance",
  "agent-nodes": "At a glance",
  "data-streams": "At a glance",
  reminders: "Work & business",
  "quick-notes": "Work & business",
  pipeline: "Work & business",
  contracting: "Work & business",
  "n8n-pipelines": "Work & business",
  "google-drive": "Work & business",
  spotify: "Media & Tony",
  "voice-console": "Media & Tony",
  "tony-mode": "Media & Tony",
  map: "Media & Tony",
};

export const categoryOf = (id: string): Category => BY_ID[id] ?? "Other";

export interface DrawerItem {
  /** Registry id, or "staged-build:<buildId>" for a Play Place build. */
  key: string;
  title: string;
  description: string;
  category: Category;
  keywords?: readonly string[];
}

/** Case-insensitive match on title, description, category and keywords (every word must hit). Pure. */
export function matches(item: DrawerItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [item.title, item.description, item.category, ...(item.keywords ?? [])].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The visible groups, in category order, each sorted by title; empty groups dropped. Pure. */
export function groupItems(items: readonly DrawerItem[], query: string): { category: Category; items: DrawerItem[] }[] {
  const hit = items.filter((i) => matches(i, query));
  return CATEGORIES.map((category) => ({ category, items: hit.filter((i) => i.category === category).sort((a, b) => a.title.localeCompare(b.title)) })).filter((g) => g.items.length > 0);
}
