import { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Plus, Search, X } from "lucide-react";
import { availableWidgets } from "./registry";
import { categoryOf, groupItems, type DrawerItem } from "./drawer";

export interface PromotedItem {
  buildId: string;
  title: string;
  buildTitle?: string | null;
}

/**
 * Section pass: "Add widget" as a searchable drawer grouped by category (replaces the sideways
 * scrolling Add row, which got cut off). Your Play Place builds come first.
 */
export function WidgetDrawer({ promoted, onAdd, onClose, surface = "home" }: { promoted: readonly PromotedItem[]; onAdd: (widgetId: string, title: string, config?: Record<string, unknown>) => void; onClose: () => void; surface?: string }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const defs = availableWidgets(surface).filter((w) => w.id !== "custom" && w.id !== "staged-build");
  const items = useMemo<DrawerItem[]>(
    () => [
      ...promoted.map((b) => ({ key: `staged-build:${b.buildId}`, title: b.title, description: b.buildTitle ? `Promoted from the Play Place build “${b.buildTitle}”` : "Promoted from the Play Place", category: "Your builds" as const })),
      ...defs.map((w) => ({ key: w.id, title: w.title, description: w.description, category: categoryOf(w.id), keywords: w.keywords })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [promoted, defs.length],
  );
  const groups = groupItems(items, q);
  const iconOf = (key: string) => (key.startsWith("staged-build:") ? FlaskConical : (defs.find((d) => d.id === key)?.icon ?? Plus));
  const pick = (it: DrawerItem) => {
    if (it.key.startsWith("staged-build:")) {
      const buildId = it.key.slice("staged-build:".length);
      onAdd("staged-build", it.title, { buildId, title: it.title });
    } else onAdd(it.key, it.title);
  };

  return (
    <div className="fixed inset-0 z-[75] flex justify-end bg-black/40" onClick={onClose}>
      <aside className="glass-chat flex h-full w-full max-w-md flex-col rounded-none p-4" onClick={(e) => e.stopPropagation()} aria-label="Add a widget">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="label-caps text-amber-soft">Add a widget</h2>
          <button onClick={onClose} className="ml-auto grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink" aria-label="Close the widget drawer">
            <X size={16} />
          </button>
        </div>
        <label className="relative mb-3 block">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input ref={input} className="field !h-10 !pl-9 fs-13" placeholder="Search widgets…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search widgets" />
        </label>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {!groups.length && <p className="text-sm text-ink-3">No widget matches “{q}”.</p>}
          {groups.map((g) => (
            <section key={g.category} aria-label={g.category}>
              <p className="label-caps mb-1.5 text-ink-3">{g.category}</p>
              <ul className="space-y-1">
                {g.items.map((it) => {
                  const Icon = iconOf(it.key);
                  return (
                    <li key={it.key}>
                      <button onClick={() => pick(it)} className="flex w-full items-start gap-3 r-12 border border-white/[0.06] px-3 py-2 text-left transition-colors hover:border-teal/40 hover:bg-teal/[0.05]">
                        <Icon size={16} className={`mt-0.5 shrink-0 ${it.category === "Your builds" ? "text-violet" : "text-teal"}`} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-ink">{it.title}</span>
                          <span className="block fs-11 leading-snug text-ink-3">{it.description}</span>
                        </span>
                        <Plus size={14} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
