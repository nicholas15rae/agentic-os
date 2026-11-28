import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useSurface } from "./surface-context";
import { isLockedWidget } from "./registry";
import { canRemovePage } from "./locks";
import { neighbourPage, showTabs } from "./subpages";

/**
 * UI fixes 1: a section's own pages (Comms "Calls", Comms "Business messages"…). Each page has its
 * own panels and layout on the shared grid. Hidden while a section has one page and you aren't
 * editing, so a one-page section looks exactly as before. Edit layout adds, renames (double-click),
 * reorders and removes pages; a page holding a safety control can't be removed.
 * Ctrl+Alt+←/→ (or a sideways swipe on the board) steps through them.
 */
export function SubPageTabs({ label }: { label?: string }) {
  const useL = useSurface();
  const pages = useL((s) => s.pages);
  const activePage = useL((s) => s.activePage);
  const editing = useL((s) => s.editing);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  // Ctrl+Alt+←/→ steps through this section's pages while it is on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const s = useL.getState();
      const next = neighbourPage(s.pages, s.activePage, e.key === "ArrowRight" ? 1 : -1);
      if (next) {
        e.preventDefault();
        s.setActivePage(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [useL]);

  if (!showTabs(pages.length, editing)) return null;
  const L = useL.getState();
  const name = label ?? "Section";

  const remove = (id: string, count: number) => {
    // A page with panels takes a second click, since its panels go with it.
    if (count > 0 && armed !== id) return setArmed(id);
    setArmed(null);
    L.removePage(id);
  };

  return (
    <div className="mx-4 mb-2 flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] md:mx-6 xl:mx-8" data-no-swipe>
      <div role="tablist" aria-label={`${name} pages`} className="flex items-center gap-1.5">
        {pages.map((p, i) => {
          const active = p.id === activePage;
          if (renaming === p.id) return <RenameField key={p.id} name={p.name} onDone={(v) => (v !== null && L.renamePage(p.id, v), setRenaming(null))} />;
          const removable = pages.length > 1 && canRemovePage(useL.getState(), p.id, isLockedWidget);
          return (
            <span key={p.id} className="relative flex shrink-0 items-center">
              <button
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={editing ? "Double-click to rename" : p.name}
                onClick={() => (active && editing ? setRenaming(p.id) : L.setActivePage(p.id))}
                onDoubleClick={() => setRenaming(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "F2") setRenaming(p.id);
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    const next = pages[i + (e.key === "ArrowRight" ? 1 : -1)];
                    if (next) {
                      L.setActivePage(next.id);
                      (e.currentTarget.parentElement?.[e.key === "ArrowRight" ? "nextElementSibling" : "previousElementSibling"]?.querySelector("[role=tab]") as HTMLElement | null)?.focus();
                    }
                  }
                }}
                className={`flex h-8 items-center rounded-full border px-3 font-mono fs-12 transition-colors ${
                  active ? "border-amber/70 bg-amber/10 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.4)] text-ink-2 backdrop-blur-md hover:border-white/25 hover:text-ink"
                } ${editing && removable ? "pr-7" : ""}`}
              >
                <span className="max-w-32 truncate">{p.name}</span>
              </button>
              {editing && removable && (
                <button
                  aria-label={armed === p.id ? `Confirm: remove ${p.name} and its ${p.items.length} panels` : `Remove ${p.name}`}
                  title={armed === p.id ? `Click again to remove ${p.name} and its ${p.items.length} panel${p.items.length === 1 ? "" : "s"}` : `Remove ${p.name}`}
                  onClick={() => remove(p.id, p.items.length)}
                  className={`absolute right-1 grid size-6 place-items-center rounded-full ${armed === p.id ? "bg-alert/80 text-white" : "text-ink-3 hover:text-alert"}`}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {editing && (
        <>
          <button onClick={() => L.addPage()} aria-label={`New ${name} page`} title="A new page with its own panels and layout" className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-dashed border-white/15 px-2.5 fs-12 text-ink-2 hover:border-white/30 hover:text-ink">
            <Plus size={13} /> <span className="font-mono">Page</span>
          </button>
          {pages.length > 1 && (
            <span className="ml-1 flex shrink-0 items-center gap-1">
              <button aria-label="Move this page left" title="Move this page left" disabled={pages[0]?.id === activePage} onClick={() => L.movePage(activePage, -1)} className="grid size-8 place-items-center rounded-full text-ink-3 hover:text-ink disabled:opacity-30">
                <ChevronLeft size={14} />
              </button>
              <button aria-label="Move this page right" title="Move this page right" disabled={pages[pages.length - 1]?.id === activePage} onClick={() => L.movePage(activePage, 1)} className="grid size-8 place-items-center rounded-full text-ink-3 hover:text-ink disabled:opacity-30">
                <ChevronRight size={14} />
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      aria-label="Page name"
      value={value}
      maxLength={40}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
      className="field !h-8 w-32 shrink-0 !rounded-full !py-0 font-mono fs-12"
    />
  );
}
