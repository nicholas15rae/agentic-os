import { useEffect, useRef, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";
import { APP_ICONS, iconOf, LABEL_MAX, mountId, useMyApps, type AppIcon, type MountTarget } from "./store";

/** The icon grid shared by the pin popover, the intake's mount fields and the rail's edit menu. */
export function IconPicker({ value, onChange }: { value: AppIcon; onChange: (i: AppIcon) => void }) {
  return (
    <div role="radiogroup" aria-label="Sidebar icon" className="flex flex-wrap gap-1">
      {(Object.keys(APP_ICONS) as AppIcon[]).map((name) => {
        const Icon = APP_ICONS[name];
        const on = value === name;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={name}
            title={name}
            onClick={() => onChange(name)}
            className={`grid size-7 place-items-center rounded-[8px] border transition-colors ${on ? "border-amber/60 bg-amber/15 text-amber-light" : "border-white/10 text-ink-2 hover:text-ink"}`}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

/** Label + icon fields (no toggle): the pin popover and the rail's edit menu. */
export function MountFields({ label, icon, onLabel, onIcon, placeholder }: { label: string; icon: AppIcon; onLabel: (s: string) => void; onIcon: (i: AppIcon) => void; placeholder?: string }) {
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-2">
        Sidebar label
        <input value={label} onChange={(e) => onLabel(e.target.value)} maxLength={LABEL_MAX} placeholder={placeholder} className="field mt-1 !h-8 !py-1 text-xs" />
      </label>
      <div className="text-[11px] text-ink-2">
        Icon
        <div className="mt-1">
          <IconPicker value={icon} onChange={onIcon} />
        </div>
      </div>
    </div>
  );
}

/**
 * "Pin to Sidebar" / "Unpin" on a finished Play Place build or prototype: mounts it as a page in
 * MY APPS (left rail). Unpinning only removes the rail entry; the app's files stay.
 */
export function PinButton({ target, size = "sm" }: { target: MountTarget; size?: "sm" | "md" }) {
  const id = mountId(target.kind, target.ref);
  const mounted = useMyApps((s) => s.apps.find((a) => a.id === id));
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(mounted?.label ?? target.title);
  const [icon, setIcon] = useState<AppIcon>(mounted?.icon ?? "app");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(mounted?.label ?? target.title);
    setIcon(mounted?.icon ?? "app");
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
    // Re-seed only when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = () => {
    const app = useMyApps.getState().mount(target, { label, icon });
    setOpen(false);
    useToasts.getState().push({ title: mounted ? "Sidebar page updated" : "Pinned to the sidebar", body: `“${app.label}” is under My Apps in the left rail.`, tone: "info" });
  };
  const unpin = () => {
    useMyApps.getState().unmount(id);
    setOpen(false);
    useToasts.getState().push({ title: "Unpinned", body: `“${mounted?.label ?? target.title}” left the sidebar. Its files are untouched.`, tone: "info" });
  };
  const Icon = iconOf(mounted?.icon ?? "app");
  const h = size === "md" ? "!h-9 text-xs" : "!h-7 !px-2.5 text-[11px]";

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`pill-glass ${h} ${mounted ? "!border-amber/50 !text-amber-soft" : ""}`}
        title={mounted ? `In the sidebar as “${mounted.label}” — edit or unpin` : "Add as a Command Center page (My Apps in the left rail)"}
      >
        {mounted ? <Icon size={11} /> : <Pin size={11} />} {mounted ? "Pinned" : "Pin to Sidebar"}
      </button>
      {open && (
        <div role="dialog" aria-label="Sidebar page" className="glass absolute right-0 top-full z-30 mt-1 w-72 rounded-[14px] p-3 shadow-xl">
          <p className="label-caps mb-2 text-ink-3">Command Center page</p>
          <MountFields label={label} icon={icon} onLabel={setLabel} onIcon={setIcon} placeholder={target.title} />
          <div className="mt-3 flex gap-1.5">
            <button type="button" onClick={save} className="pill-primary !h-8 flex-1 text-xs">
              <Pin size={12} /> {mounted ? "Save" : "Add to sidebar"}
            </button>
            {mounted && (
              <button type="button" onClick={unpin} className="pill-glass !h-8 text-xs hover:!border-alert/50" title="Remove from the sidebar (files are kept)">
                <PinOff size={12} /> Unpin
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
