import { useEffect, useRef, useState } from "react";
import { Rocket, SkipForward, Sparkles } from "lucide-react";
import { useAtmosphere, useTimePhase } from "@/features/weather/weather-store";
import { useWallpapers } from "@/features/wallpaper/wallpaper-store";
import { useBackdrops, useSurfaceConfig } from "@/features/wallpaper/backdrop-store";
import { nextInPool, surfacePool } from "@/features/wallpaper/backdrop-model";
import { useBackdropActive } from "@/features/wallpaper/SurfaceBackdropLayer";
import { SPACE_MODES, useSpace } from "./space-store";
import type { TriggerKind } from "./fleet/sim";

const PREVIEWS: readonly { kind: TriggerKind; label: string; hint: string }[] = [
  { kind: "solo", label: "Cruise", hint: "The E46 flies a courier run between two agent planets" },
  { kind: "chased", label: "Chased", hint: "Dogfight sortie opening with the E46 on the run, shooting back; passes then alternate" },
  { kind: "pursuit", label: "Pursuit", hint: "Dogfight sortie opening with the E46 on the attack; passes then alternate" },
  { kind: "station", label: "Station", hint: "The distant battle station drifts into view" },
];

/**
 * Toolbar pill + popover for the deep-space backdrop: mode, ambient flybys, next backdrop, and
 * preview buttons for each flight event and the station. "Next Backdrop" advances the imported (Wallpaper manager) pool when that is
 * showing, otherwise the drop-in wallpapers / procedural nebula.
 */
export function SpaceControls() {
  const mode = useSpace((s) => s.mode);
  const flybys = useSpace((s) => s.flybys);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const custom = useBackdropActive("orbital");
  const cfg = useSurfaceConfig("orbital");
  const items = useWallpapers((s) => s.items);
  const atmosphere = useAtmosphere();
  const phase = useTimePhase();
  const engine = mode !== "minimal";

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const customIds = custom ? surfacePool(items, "orbital", cfg, atmosphere, phase).map((p) => p.id) : [];
  const canNext = custom ? customIds.length > 1 : engine;
  const next = () => {
    if (custom) {
      const cur = useBackdrops.getState().current.orbital;
      useBackdrops.getState().setCurrent("orbital", nextInPool(customIds, cur, cfg.shuffle));
    } else useSpace.getState().nextBackdrop();
  };
  const label = SPACE_MODES.find((m) => m.id === mode)?.label ?? "Deep Space";

  return (
    <div ref={wrap} className="relative">
      <button type="button" className="sysmap-ctl" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} title="Deep-space backdrop: mode, flybys">
        <span className="flex items-center gap-1.5">
          <Sparkles size={12} aria-hidden /> Space: {label}
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Deep-space backdrop" className="sysmap-drawer absolute bottom-[calc(100%+6px)] left-0 w-[300px] space-y-2.5 rounded-xl border border-white/12 bg-[rgba(4,7,12,0.94)] p-2.5 font-mono fs-11 text-ink-2 shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
          <div>
            <p className="mb-1 fs-9.5 uppercase tracking-[0.16em] text-ink-3">Backdrop mode</p>
            <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Backdrop mode">
              {SPACE_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  onClick={() => useSpace.getState().setMode(m.id)}
                  className={`h-7 whitespace-nowrap rounded-md border px-1 fs-10.5 transition-colors ${mode === m.id ? "border-amber/70 bg-amber/10 text-ink" : "border-white/10 hover:border-white/25 hover:text-ink"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <label className={`flex items-center justify-between gap-2 ${engine ? "" : "opacity-50"}`} title={engine ? undefined : "Flybys need Deep Space or Full Cinema"}>
            <span>Ambient flybys</span>
            <button
              type="button"
              role="switch"
              aria-checked={flybys}
              disabled={!engine}
              onClick={() => useSpace.getState().setFlybys(!flybys)}
              className={`relative h-[18px] w-8 rounded-full border transition-colors ${flybys ? "border-amber/70 bg-amber/25" : "border-white/15 bg-white/5"}`}
            >
              <span className={`absolute top-[2px] size-3 rounded-full bg-ink transition-transform ${flybys ? "translate-x-[15px]" : "translate-x-[2px]"}`} />
            </button>
          </label>
          <div className="grid grid-cols-1 gap-1">
            <button type="button" className="sysmap-ctl !h-7" disabled={!canNext} onClick={next} title={canNext ? "Crossfade to the next backdrop" : custom ? "Only one imported backdrop in the pool (or it is pinned)" : "Pick Deep Space or Full Cinema"}>
              <span className="flex items-center gap-1 whitespace-nowrap">
                <SkipForward size={11} aria-hidden /> Next Backdrop
              </span>
            </button>
          </div>
          <div>
            <p className="mb-1 flex items-center gap-1 fs-9.5 uppercase tracking-[0.16em] text-ink-3">
              <Rocket size={10} aria-hidden /> Trigger flyby
            </p>
            <div className="grid grid-cols-4 gap-1">
              {PREVIEWS.map((p) => (
                <button key={p.kind} type="button" className="sysmap-ctl !h-7 !px-1 fs-10.5" disabled={!engine} onClick={() => useSpace.getState().triggerFlyby(p.kind)} title={engine ? p.hint : "Pick Deep Space or Full Cinema"}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
