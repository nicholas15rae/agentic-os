import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Home, Image, Link2, MoreHorizontal, Plus, Power, X } from "lucide-react";
import { useLayout } from "@/core/widgets/layout-store";
import { startupOf } from "@/core/widgets/pages";
import { useActiveSurface } from "@/core/widgets/surface-context";
import { useModes } from "@/features/modes/modes-store";
import { useWallpapers } from "@/features/wallpaper/wallpaper-store";

/**
 * Dashboard pages: one pill per page, "+ New", rename (double-click, or click the
 * active page in edit mode), × in edit mode when there's more than one page.
 * Desktop sits at the end of the ReelDock; `mobile` floats bottom-right above the tabs.
 */
export function PageSwitcher({ mobile = false }: { mobile?: boolean }) {
  const pages = useLayout((s) => s.pages);
  const activePage = useLayout((s) => s.activePage);
  const editing = useLayout((s) => s.editing);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  // Ctrl+Alt+←/→ steps through pages. Only one instance listens (the desktop one is always mounted with it).
  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      // A section on screen steps through its own pages (SubPageTabs), not the dashboard's.
      if (useActiveSurface.getState().store !== useLayout) return;
      const { pages: list, activePage: cur, setActivePage } = useLayout.getState();
      const i = list.findIndex((p) => p.id === cur);
      const next = list[i + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        setActivePage(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile]);

  const { setActivePage, addPage, removePage } = useLayout.getState();

  const remove = (id: string, count: number) => {
    // A page with widgets takes a second click, since its widgets go with it.
    if (count > 0 && armed !== id) return setArmed(id);
    setArmed(null);
    removePage(id);
  };

  return (
    <nav
      aria-label="Dashboard pages"
      className={
        mobile
          ? "fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-4 z-40 flex max-w-[calc(50vw-3.5rem)] items-center gap-1 overflow-x-auto rounded-full p-1 glass-thin [scrollbar-width:none] md:hidden"
          : "ml-auto flex shrink-0 items-center gap-1.5"
      }
    >
      {pages.map((p) => {
        const active = p.id === activePage;
        if (renaming === p.id) return <RenameField key={p.id} id={p.id} name={p.name} mobile={mobile} onDone={() => setRenaming(null)} />;
        return (
          <span key={p.id} className="relative flex shrink-0 items-center">
            <button
              aria-current={active ? "page" : undefined}
              title="Double-click to rename"
              onClick={() => (active && editing ? setRenaming(p.id) : setActivePage(p.id))}
              onDoubleClick={() => setRenaming(p.id)}
              onKeyDown={(e) => e.key === "F2" && setRenaming(p.id)}
              className={`flex items-center rounded-full border font-mono transition-colors ${mobile ? "h-8 px-3 fs-11" : "h-9 px-3.5 fs-12"} ${
                active ? "border-amber/70 bg-amber/10 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.4)] text-ink-2 backdrop-blur-md hover:border-white/25 hover:text-ink"
              } ${editing && pages.length > 1 ? "pr-7" : ""}`}
            >
              <span className="max-w-28 truncate">{p.name}</span>
            </button>
            {editing && active && !mobile && <PageMenu id={p.id} />}
            {editing && pages.length > 1 && (
              <button
                aria-label={armed === p.id ? `Confirm: remove ${p.name} and its ${p.items.length} widgets` : `Remove ${p.name}`}
                title={armed === p.id ? `Click again to remove ${p.name} and its ${p.items.length} widget${p.items.length === 1 ? "" : "s"}` : `Remove ${p.name}`}
                onClick={() => remove(p.id, p.items.length)}
                className={`absolute right-1 grid size-6 place-items-center rounded-full ${armed === p.id ? "bg-alert/80 text-white" : "text-ink-3 hover:text-alert"}`}
              >
                <X size={12} />
              </button>
            )}
          </span>
        );
      })}
      <button
        aria-label="New page"
        title="New page"
        onClick={() => addPage()}
        className={`flex shrink-0 items-center gap-1 rounded-full border border-dashed border-white/15 text-ink-2 hover:border-white/30 hover:text-ink ${mobile ? "h-8 px-2.5 fs-11" : "h-9 px-3 fs-12"}`}
      >
        <Plus size={13} />
        {!mobile && <span className="font-mono">New</span>}
      </button>
    </nav>
  );
}

function RenameField({ id, name, mobile, onDone }: { id: string; name: string; mobile: boolean; onDone: () => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const commit = () => {
    useLayout.getState().renamePage(id, value);
    onDone();
  };
  return (
    <input
      ref={ref}
      aria-label="Page name"
      value={value}
      maxLength={40}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
      className={`field shrink-0 !rounded-full !py-0 font-mono ${mobile ? "!h-8 w-24 fs-11" : "!h-9 w-32 fs-12"}`}
    />
  );
}

/**
 * Section pass, page presets: the active page's menu in edit mode. Reorder, duplicate, link to
 * one of Tony's modes (switching mode opens the page and vice versa), pin the current wallpaper
 * to the page, make it the startup page, or add the clean "Home" view.
 */
function PageMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const page = useLayout((s) => s.pages.find((p) => p.id === id));
  const pages = useLayout((s) => s.pages);
  const startup = useLayout((s) => startupOf(s));
  const modes = useModes((s) => s.modes).filter((m) => !m.is_novelty);
  const currentWallpaper = useWallpapers((s) => s.currentId);
  const L = useLayout.getState();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest?.("[data-page-menu]") && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  if (!page) return null;
  const idx = pages.findIndex((p) => p.id === id);
  const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left fs-12 text-ink-2 hover:bg-white/5 hover:text-ink disabled:opacity-40";
  return (
    <span className="relative ml-1" data-page-menu>
      <button aria-label={`${page.name}: page options`} aria-expanded={open} onClick={() => setOpen((v) => !v)} className="grid size-7 place-items-center rounded-full text-ink-3 hover:text-ink">
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="glass-chat absolute bottom-9 right-0 z-50 w-64 r-14 p-1.5" role="menu" aria-label={`${page.name} options`}>
          <div className="flex gap-1">
            <button className={item} disabled={idx <= 0} onClick={() => L.movePage(id, -1)}>
              <ChevronLeft size={13} /> Move left
            </button>
            <button className={item} disabled={idx >= pages.length - 1} onClick={() => L.movePage(id, 1)}>
              Move right <ChevronRight size={13} />
            </button>
          </div>
          <button className={item} onClick={() => (L.duplicatePage(id), setOpen(false))}>
            <Copy size={13} /> Duplicate page
          </button>
          <label className={`${item} cursor-default`}>
            <Link2 size={13} /> Tony's mode
            <select
              className="ml-auto rounded-md bg-black/30 px-1.5 py-0.5 fs-11 text-ink outline-none"
              value={page.mode ?? ""}
              onChange={(e) => L.setPageMode(id, e.target.value || null)}
              aria-label="Link this page to one of Tony's modes"
            >
              <option value="">None</option>
              {modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {page.wallpaper ? (
            <button className={item} onClick={() => L.setPageWallpaper(id, null)}>
              <Image size={13} /> Use the shared wallpaper rotation
            </button>
          ) : (
            <button className={item} onClick={() => L.setPageWallpaper(id, currentWallpaper)}>
              <Image size={13} /> Keep this wallpaper on this page
            </button>
          )}
          <button className={item} disabled={startup === id} onClick={() => L.setStartupPage(id)}>
            <Power size={13} /> {startup === id ? "Opens at startup" : "Open this page at startup"}
          </button>
          <button className={item} onClick={() => (L.addHomeView(), setOpen(false))}>
            <Home size={13} /> Add a clean Home view
          </button>
        </div>
      )}
    </span>
  );
}
