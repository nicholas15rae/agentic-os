import { useState } from "react";
import { Check, Copy, LayoutGrid, Plus, RotateCcw, Undo2 } from "lucide-react";
import { SurfaceContext, useClaimSurface, useSurface } from "./surface-context";
import { WidgetGrid } from "./WidgetGrid";
import { WidgetDrawer } from "./WidgetDrawer";
import { customizedModes, SHARED } from "./variants";
import type { LayoutStore } from "./layout-store";
import { useModes } from "@/features/modes/modes-store";

/**
 * Shared layout system (AGENTS.md, "Everything Is Customizable"): every page draws its panels
 * with this, on the same 12×8 grid as the home page, with the same Edit layout mode (top-bar
 * toggle, or press and hold on touch), drawer, Look panel, icons and windows. Safety controls
 * (`locked` panels) can move but never hide.
 *
 *   const store = surfaceStore({ surface: "playplace", defaults: PLAYPLACE_DEFAULT });
 *   <LayoutSurface store={store} />
 */
export function LayoutSurface({ store, label }: { store: LayoutStore; label?: string }) {
  useClaimSurface(store);
  return (
    <SurfaceContext.Provider value={store}>
      <div className="flex h-full min-h-0 flex-col" data-surface={store.getState().surface} aria-label={label}>
        <SurfaceEditBar />
        <div className="min-h-0 flex-1">
          <WidgetGrid />
        </div>
      </div>
    </SurfaceContext.Provider>
  );
}

/** Edit layout mode only: add a panel back, reset, per-mode layout. */
function SurfaceEditBar() {
  const useL = useSurface();
  const editing = useL((s) => s.editing);
  const surface = useL((s) => s.surface);
  const [drawer, setDrawer] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!editing) return null;
  return (
    <div className="mx-4 mb-3 md:mx-6 xl:mx-8">
      <div className="glass flex flex-wrap items-center gap-2 rounded-[18px] p-2">
        <button onClick={() => setDrawer(true)} className="pill-primary !h-9 shrink-0 !px-3 text-[13px]" title="Add a panel, or bring back one you hid">
          <Plus size={13} /> Add panel
        </button>
        <LayoutControls />
        <button onClick={() => useL.getState().setEditing(false)} className="pill-glass ml-auto !h-9 shrink-0 !px-3 text-[13px]">
          <Check size={13} /> Done
        </button>
      </div>
      {msg && <p className="mt-1 px-2 text-[12px] text-ink-2">{msg}</p>}
      {drawer && (
        <WidgetDrawer
          surface={surface}
          promoted={[]}
          onClose={() => setDrawer(false)}
          onAdd={(id, title, config) => {
            const r = useL.getState().add(id, config);
            setMsg(r.ok ? `Added “${title}”.` : (r.reason ?? null));
            setDrawer(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Reset this page / reset everything (with Undo), and the per-mode layout switch. Used by the
 * home tray and every LayoutSurface, so Reset to default works the same on every page.
 */
export function LayoutControls() {
  const useL = useSurface();
  const lastReset = useL((s) => s.lastReset);
  const variant = useL((s) => s.variant);
  const customCount = useL((s) => customizedModes(s).length);
  const modeId = useModes((s) => s.activeId);
  const modeName = useModes((s) => s.modes.find((m) => m.id === s.activeId)?.name ?? s.activeId);
  const own = variant !== SHARED && variant === modeId;
  const btn = "pill-glass !h-9 shrink-0 !px-3 text-[13px]";
  return (
    <>
      <button onClick={() => useL.getState().reset()} className={btn} title="Restores this page's default layout (any extra page is cleared). Safety controls stay. Other pages are untouched.">
        <RotateCcw size={13} /> Reset this page
      </button>
      <button
        onClick={() => useL.getState().resetAll()}
        className={btn}
        title="Every page of this layout back to the finished template (one page). Undo brings your layout back."
      >
        <LayoutGrid size={13} /> Reset all pages
      </button>
      {lastReset && (
        <button onClick={() => useL.getState().undoReset()} className={`${btn} !border-teal/60 text-teal`}>
          <Undo2 size={13} /> Undo reset
        </button>
      )}
      {own ? (
        <button onClick={() => useL.getState().useSharedForMode(modeId)} className={btn} title={`${modeName} stops using its own layout and goes back to the shared one (its copy is dropped).`}>
          <LayoutGrid size={13} /> Use the shared layout
        </button>
      ) : (
        <button onClick={() => useL.getState().customizeForMode(modeId)} className={btn} title={`Give ${modeName} its own copy of this layout. Other modes keep the shared one.`}>
          <Copy size={13} /> Customize for {modeName}
        </button>
      )}
      {customCount > 0 && <span className="label-caps px-1 text-ink-3">{own ? `${modeName}'s own layout` : "Shared layout"}</span>}
    </>
  );
}
