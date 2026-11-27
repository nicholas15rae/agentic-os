import { useRef, useState } from "react";
import { Eye, EyeOff, Pin, PinOff, RotateCcw, Tags, Trash2, Upload } from "lucide-react";
import { useWallpapers, type WallpaperTags } from "@/features/wallpaper/wallpaper-store";
import { PHASES, useAtmosphere, useTimePhase, type Atmosphere } from "@/features/weather/weather-store";
import { SURFACE_LABEL, SURFACE_SHORT, SURFACES, surfacePool, surfacesOf, type Surface } from "@/features/wallpaper/backdrop-model";
import { patchSurface, useBackdrops, useSurfaceConfig, type ManagerTab } from "@/features/wallpaper/backdrop-store";

const TABS: readonly { id: ManagerTab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "flowchart", label: "Schematic Flowchart" },
  { id: "orbital", label: "Orbital Ecosystem" },
  { id: "all", label: "All Library" },
];

/**
 * Wallpaper manager → Multi-Surface Backdrop Engine. One library (built-ins + IndexedDB uploads),
 * three surfaces (Home, Schematic Flowchart, Orbital Ecosystem) with their own pool, rotation,
 * weather / time sync and — for the System Map pages — a Clean Minimal / Custom switch and a
 * readability blend strip. Each card's Home / Flowchart / Orbital badges add or remove it from
 * that surface's pool in one click.
 */
export function WallpapersSection() {
  const { items, currentId, select, toggleEnabled, toggleSurface, upload, remove } = useWallpapers();
  const tab = useBackdrops((s) => s.tab);
  const setTab = useBackdrops((s) => s.setTab);
  const surfaceCurrent = useBackdrops((s) => s.current);
  const surface: Surface = tab === "all" ? "home" : tab;
  const cfg = useSurfaceConfig(surface);
  const atmosphere = useAtmosphere();
  const phase = useTimePhase();
  const fitsNow = new Set(surfacePool(items, surface, { syncWeatherTime: true, pinnedWallpaperId: null }, atmosphere, phase).map((w) => w.id));
  const [tagging, setTagging] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const mapSurface = surface !== "home";

  const handle = async (files: FileList | null) => {
    if (!files?.length) return;
    const target: Surface = tab === "all" ? "home" : tab;
    const poolBefore = surfacePool(items, target, { syncWeatherTime: false, pinnedWallpaperId: null }, atmosphere, phase).length;
    const r = await upload(files, [target]);
    // First images for a System Map page: switch its backdrop on.
    let note = "";
    if (r.added && target !== "home" && poolBefore === 0 && !useBackdrops.getState().configs[target].enabled) {
      patchSurface(target, { enabled: true });
      note = ` ${SURFACE_LABEL[target]} backdrop switched on.`;
    }
    setMsg([r.added ? `Added ${r.added} wallpaper${r.added > 1 ? "s" : ""} to ${SURFACE_LABEL[target]}.${note}` : "", ...r.rejected].filter(Boolean).join(" "));
  };

  const isCurrent = (id: string) => (surface === "home" ? id === currentId : surfaceCurrent[surface] === id);
  const pick = (id: string, member: boolean) => {
    if (surface === "home") return select(id);
    if (member) useBackdrops.getState().setCurrent(surface, id);
  };

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto px-4 pb-28 md:px-6 md:pb-8">
      <nav aria-label="Backdrop surface" className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
            className={`flex h-9 items-center rounded-full border px-3.5 font-mono fs-12 transition-colors ${
              tab === t.id ? "border-amber/70 bg-amber/10 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.4)] text-ink-2 backdrop-blur-md hover:border-white/25 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="glass mb-4 space-y-3 r-20 p-4">
        {mapSurface && (
          <div role="radiogroup" aria-label={`${SURFACE_LABEL[surface]} backdrop mode`} className="well inline-flex rounded-full p-0.5">
            {[
              { on: false, label: "Clean Minimal (Off)" },
              { on: true, label: "Custom Rolling Backdrop (On)" },
            ].map((o) => (
              <button
                key={String(o.on)}
                role="radio"
                aria-checked={cfg.enabled === o.on}
                onClick={() => patchSurface(surface, { enabled: o.on })}
                className={`h-8 rounded-full px-3 text-xs transition-colors ${cfg.enabled === o.on ? "bg-amber/25 text-amber-light" : "text-ink-2 hover:text-ink"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <button className="pill-primary" onClick={() => input.current?.click()}>
            <Upload size={15} /> Upload wallpapers{tab !== "all" && tab !== "home" ? ` to ${SURFACE_SHORT[surface]}` : ""}
          </button>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void handle(e.target.files)} />
          {tab !== "all" && (
            <>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={cfg.rotateEnabled} onChange={(e) => patchSurface(surface, { rotateEnabled: e.target.checked })} className="accent-amber" />
                Rotate every
                <input
                  type="range"
                  min={10}
                  max={300}
                  step={5}
                  value={cfg.rotateIntervalSec}
                  disabled={!cfg.rotateEnabled}
                  onChange={(e) => patchSurface(surface, { rotateIntervalSec: Number(e.target.value) })}
                  className="accent-amber"
                />
                <span className="w-12 font-mono text-ink tabular">{cfg.rotateIntervalSec}s</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={cfg.shuffle} onChange={(e) => patchSurface(surface, { shuffle: e.target.checked })} className="accent-amber" />
                Shuffle
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={cfg.syncWeatherTime} onChange={(e) => patchSurface(surface, { syncWeatherTime: e.target.checked })} className="accent-amber" />
                Sync to weather &amp; time
              </label>
              {cfg.pinnedWallpaperId && (
                <button className="pill-glass !h-8 text-xs" onClick={() => patchSurface(surface, { pinnedWallpaperId: null })}>
                  <PinOff size={12} /> Unpin “{items.find((i) => i.id === cfg.pinnedWallpaperId)?.name ?? "?"}”
                </button>
              )}
            </>
          )}
          <span className="label-caps ml-auto text-ink-3">
            Now: <span className="text-teal">{atmosphere}</span> · <span className="text-amber-soft">{phase}</span>
          </span>
        </div>
        {mapSurface && cfg.enabled && <BlendStrip surface={surface} />}
        {tab === "all" && <p className="text-xs text-ink-3">The whole library. Uploads here go to Home; use the badges on each card to share a wallpaper with the System Map pages.</p>}
        {msg && <p className="w-full text-xs text-ink-2">{msg}</p>}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handle(e.dataTransfer.files);
        }}
        className={`grid grid-cols-2 gap-3 r-20 transition-shadow sm:grid-cols-3 lg:grid-cols-4 ${dragOver ? "ring-2 ring-teal" : ""}`}
      >
        {items.map((w) => {
          const on = surfacesOf(w);
          const member = tab === "all" || on.includes(surface);
          const pinned = cfg.pinnedWallpaperId === w.id && tab !== "all";
          return (
            <figure key={w.id} className={`group relative overflow-hidden r-14 border ${tab !== "all" && isCurrent(w.id) ? "border-amber/70 glow-amber" : "border-white/10"}`}>
              <button onClick={() => pick(w.id, member)} className="block w-full" aria-label={`Show ${w.name}`}>
                {w.src ? (
                  <img src={w.src} alt="" loading="lazy" className={`aspect-video w-full object-cover transition-opacity ${w.enabled && member ? "" : "opacity-35"}`} />
                ) : (
                  <div className="aspect-video w-full animate-pulse bg-white/5" />
                )}
              </button>
              {tab !== "all" && cfg.syncWeatherTime && fitsNow.has(w.id) && w.enabled && member && (
                <span className="label-caps absolute left-2 top-2 rounded-full bg-teal/90 px-2 py-0.5 text-canvas">Fits now</span>
              )}
              {pinned && <span className="label-caps absolute left-2 top-2 rounded-full bg-amber/90 px-2 py-0.5 text-canvas">Pinned</span>}
              <div className="absolute right-2 top-2 flex gap-1" role="group" aria-label={`Surfaces for ${w.name}`}>
                {SURFACES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on.includes(s)}
                    onClick={() => toggleSurface(w.id, s)}
                    title={on.includes(s) ? `In the ${SURFACE_LABEL[s]} rotation — click to remove` : `Add to the ${SURFACE_LABEL[s]} rotation`}
                    className={`rounded-full border px-1.5 py-0.5 font-mono fs-9.5 uppercase tracking-wider backdrop-blur-sm transition-colors ${
                      on.includes(s) ? "border-amber bg-amber/30 text-ink" : "border-white/20 bg-black/50 text-ink-3 hover:text-ink"
                    }`}
                  >
                    {SURFACE_SHORT[s]}
                  </button>
                ))}
              </div>
              {tagging === w.id && <TagEditor id={w.id} tags={w.tags} />}
              <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-6">
                <span className="truncate fs-13 text-ink">{w.name}</span>
                <button
                  onClick={() => setTagging(tagging === w.id ? null : w.id)}
                  aria-label={`Edit conditions for ${w.name}`}
                  aria-expanded={tagging === w.id}
                  title="Weather & time tags"
                  className={`ml-auto grid size-7 place-items-center rounded-full hover:bg-white/10 ${tagging === w.id ? "text-amber" : "text-ink-2 hover:text-ink"}`}
                >
                  <Tags size={14} />
                </button>
                {tab !== "all" && member && (
                  <button
                    onClick={() => patchSurface(surface, { pinnedWallpaperId: pinned ? null : w.id })}
                    aria-label={pinned ? `Unpin ${w.name}` : `Pin ${w.name} on ${SURFACE_LABEL[surface]}`}
                    title={pinned ? "Unpin (rotate again)" : `Pin: always show this on ${SURFACE_LABEL[surface]}`}
                    className={`grid size-7 place-items-center rounded-full hover:bg-white/10 ${pinned ? "text-amber" : "text-ink-2 hover:text-ink"}`}
                  >
                    <Pin size={14} />
                  </button>
                )}
                <button
                  onClick={() => toggleEnabled(w.id)}
                  aria-label={w.enabled ? `Exclude ${w.name} from rotation` : `Include ${w.name} in rotation`}
                  title={w.enabled ? "In rotation (every surface)" : "Excluded everywhere"}
                  className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-ink"
                >
                  {w.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                {!w.builtin && (
                  <button onClick={() => void remove(w.id)} aria-label={`Delete ${w.name}`} className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-alert">
                    <Trash2 size={14} />
                  </button>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-3">
        Drop images anywhere on the grid. Uploads stay on this device (IndexedDB) and work offline. Tag each scene with the weather and time it
        suits — with sync on, a snowy December evening rotates through your snow + night scenes.
      </p>
    </div>
  );
}

/** Readability controls for a System Map backdrop. */
function BlendStrip({ surface }: { surface: Exclude<Surface, "home"> }) {
  const cfg = useSurfaceConfig(surface);
  const reset = useBackdrops((s) => s.reset);
  const slider = (label: string, value: number, min: number, max: number, unit: string, key: "opacity" | "dimmer" | "blurPx") => (
    <label className="flex items-center gap-2 text-xs text-ink-2">
      {label}
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => patchSurface(surface, { [key]: Number(e.target.value) })} className="w-24 accent-amber" />
      <span className="w-10 font-mono text-ink tabular">
        {value}
        {unit}
      </span>
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-4 r-12 border border-white/[0.07] bg-black/20 px-3 py-2">
      <span className="label-caps text-ink-3">Blend</span>
      {slider("Opacity", cfg.opacity, 0, 100, "%", "opacity")}
      {slider("Dark scrim", cfg.dimmer, 0, 85, "%", "dimmer")}
      {slider("Blur", cfg.blurPx, 0, 16, "px", "blurPx")}
      <label className="flex items-center gap-2 text-xs text-ink-2">
        <input type="checkbox" checked={cfg.vignette} onChange={(e) => patchSurface(surface, { vignette: e.target.checked })} className="accent-amber" />
        Vignette
      </label>
      <button className="pill-glass !h-7 ml-auto fs-11" onClick={() => reset(surface)}>
        <RotateCcw size={11} /> Reset defaults
      </button>
    </div>
  );
}

const ATMOS: Atmosphere[] = ["clear", "autumn", "rain", "snow", "fog", "midnight"];

function TagEditor({ id, tags }: { id: string; tags: WallpaperTags }) {
  const setTags = useWallpapers((s) => s.setTags);
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (on: boolean) =>
    `rounded-full border px-2 py-0.5 font-mono fs-10 uppercase tracking-wider transition-colors ${
      on ? "border-amber bg-amber/25 text-ink" : "border-white/15 bg-black/40 text-ink-2 hover:text-ink"
    }`;
  return (
    <div className="absolute inset-x-0 top-0 z-10 space-y-1.5 bg-black/80 p-2 backdrop-blur-sm">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Weather">
        {ATMOS.map((a) => (
          <button key={a} aria-pressed={tags.atmospheres.includes(a)} className={chip(tags.atmospheres.includes(a))} onClick={() => setTags(id, { ...tags, atmospheres: toggle(tags.atmospheres, a) })}>
            {a}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Time of day">
        {PHASES.map((p) => (
          <button key={p} aria-pressed={tags.phases.includes(p)} className={chip(tags.phases.includes(p))} onClick={() => setTags(id, { ...tags, phases: toggle(tags.phases, p) })}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
