import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ExternalLink, PencilLine, PinOff, Settings2 } from "lucide-react";
import { useNav } from "@/stores/nav";
import { useFocus } from "@/features/os/focus-store";
import { useToasts } from "@/features/reminders/notify";
import { MountFields } from "./PinButton";
import { iconOf, useMyApps, type AppIcon, type MountedApp } from "./store";

/** "Edit in Play Place": its card, Steer / Tweak box focused. */
export function editInPlayPlace(app: MountedApp) {
  if (app.kind === "build") useMyApps.getState().requestFocus(app.ref);
  else useFocus.getState().set({ card: app.ref });
  useNav.getState().go("playplace");
}

/**
 * MY APPS in the desktop rail: one button per mounted app, in the user's order. Right-click
 * (or Shift+F10 / the context-menu key) for Open, Edit in Play Place, Rename & icon, Move up /
 * down and Unpin. Unpinning never touches the app's files.
 */
export function MyAppsRail() {
  const apps = useMyApps((s) => s.apps);
  const { section, appId, openApp } = useNav();
  const [menu, setMenu] = useState<{ app: MountedApp; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<MountedApp | null>(null);
  if (!apps.length) return null;
  return (
    <div className="flex w-full flex-col items-center gap-2" aria-label="My Apps" role="group">
      <div className="mt-1 h-px w-9 bg-white/10" />
      <span className="label-caps !text-[8px] text-ink-3" title="Play Place apps mounted as pages — right-click one to reorder, rename or unpin">
        My Apps
      </span>
      {apps.map((a, i) => {
        const Icon = iconOf(a.icon);
        const on = section === "app" && appId === a.id;
        return (
          <button
            key={a.id}
            onClick={() => openApp(a.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ app: a, x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ app: a, x: r.right, y: r.top });
              } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                e.preventDefault();
                useMyApps.getState().move(a.id, e.key === "ArrowUp" ? -1 : 1);
              }
            }}
            aria-current={on ? "page" : undefined}
            aria-label={`${a.label} (My Apps ${i + 1} of ${apps.length})`}
            title={`${a.label} — right-click for options`}
            className={`relative grid size-11 place-items-center rounded-[14px] transition-all duration-200 ${on ? "border border-teal/50 bg-teal/10 text-teal-soft glow-teal" : "text-ink-2 hover:bg-white/5 hover:text-ink"}`}
          >
            <Icon size={18} />
          </button>
        );
      })}
      {menu && <AppMenu {...menu} index={apps.findIndex((a) => a.id === menu.app.id)} count={apps.length} onClose={() => setMenu(null)} onEdit={() => setEditing(menu.app)} />}
      {editing && <EditDialog app={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AppMenu({ app, x, y, index, count, onClose, onEdit }: { app: MountedApp; x: number; y: number; index: number; count: number; onClose: () => void; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [onClose]);
  const s = useMyApps.getState();
  const item = (label: string, Icon: typeof ArrowUp, run: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <button
      role="menuitem"
      disabled={opts.disabled}
      onClick={() => {
        run();
        onClose();
      }}
      className={`flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12px] disabled:opacity-40 ${opts.danger ? "text-alert hover:bg-alert/10" : "text-ink-2 hover:bg-white/[0.06] hover:text-ink"}`}
    >
      <Icon size={13} /> {label}
    </button>
  );
  return createPortal(
    <div ref={ref} role="menu" aria-label={`${app.label} options`} className="glass fixed z-[70] w-52 rounded-[12px] p-1 shadow-xl" style={{ left: Math.min(x + 4, window.innerWidth - 216), top: Math.min(y, window.innerHeight - 260) }}>
      <p className="truncate px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-ink">{app.label}</p>
      {item("Open", ExternalLink, () => useNav.getState().openApp(app.id))}
      {item("Edit in Play Place", PencilLine, () => editInPlayPlace(app))}
      {item("Rename & icon…", Settings2, onEdit)}
      {item("Move up", ArrowUp, () => s.move(app.id, -1), { disabled: index <= 0 })}
      {item("Move down", ArrowDown, () => s.move(app.id, 1), { disabled: index >= count - 1 })}
      {item(
        "Unpin from sidebar",
        PinOff,
        () => {
          s.unmount(app.id);
          if (useNav.getState().appId === app.id) useNav.getState().go("playplace");
          useToasts.getState().push({ title: "Unpinned", body: `“${app.label}” left the sidebar. Its files are untouched.`, tone: "info" });
        },
        { danger: true },
      )}
    </div>,
    document.body,
  );
}

function EditDialog({ app, onClose }: { app: MountedApp; onClose: () => void }) {
  const [label, setLabel] = useState(app.label);
  const [icon, setIcon] = useState<AppIcon>(app.icon);
  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${app.label}`}
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="glass w-80 rounded-[18px] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          useMyApps.getState().update(app.id, { label, icon });
          onClose();
        }}
      >
        <p className="label-caps mb-2 text-ink-3">Sidebar page</p>
        <MountFields label={label} icon={icon} onLabel={setLabel} onIcon={setIcon} placeholder={app.label} />
        <div className="mt-3 flex justify-end gap-1.5">
          <button type="button" onClick={onClose} className="pill-glass !h-8 text-xs">
            Cancel
          </button>
          <button className="pill-primary !h-8 text-xs">Save</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** MY APPS in the phone's "More" sheet. */
export function MyAppsSheet({ onPick }: { onPick: () => void }) {
  const apps = useMyApps((s) => s.apps);
  const { section, appId, openApp } = useNav();
  if (!apps.length) return null;
  return (
    <>
      <p className="label-caps col-span-4 mt-1 px-1 text-ink-3">My Apps</p>
      {apps.map((a) => {
        const Icon = iconOf(a.icon);
        return (
          <button
            key={a.id}
            role="menuitem"
            onClick={() => {
              openApp(a.id);
              onPick();
            }}
            className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-[14px] ${section === "app" && appId === a.id ? "bg-teal/15 text-teal-soft" : "text-ink-2"}`}
          >
            <Icon size={20} />
            <span className="max-w-full truncate px-1 text-[11px]">{a.label}</span>
          </button>
        );
      })}
    </>
  );
}
