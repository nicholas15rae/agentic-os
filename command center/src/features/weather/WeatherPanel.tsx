import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSun, Leaf, Moon, RefreshCw, Snowflake, Sun, Wand2 } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import { Segmented, type SegmentOption } from "@/components/segmented";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { useSettings, type EffectsIntensity, type WeatherMode } from "@/stores/settings";
import { useAtmosphereInfo, useWeather } from "./weather-store";
import type {
  Atmosphere,
  AtmospherePickerProps,
  EffectsSource,
  ForecastDay,
  ForecastStripProps,
  PanelFit,
  WeatherPanelLayout,
  WeatherPanelProps,
  WeatherPanelViewProps,
} from "./weather.contract";

// Contract: ./weather.contract.ts (LOCKED 2026-11-26).

export const ATMOSPHERES: { mode: WeatherMode; label: string; icon: typeof Sun }[] = [
  { mode: "auto", label: "Live", icon: Wand2 },
  { mode: "clear", label: "Sunrise", icon: Sun },
  { mode: "autumn", label: "Autumn", icon: Leaf },
  { mode: "rain", label: "Rain", icon: CloudRain },
  { mode: "snow", label: "Snow", icon: Snowflake },
  { mode: "fog", label: "Fog", icon: CloudFog },
  { mode: "midnight", label: "Midnight", icon: Moon },
];

const atmosphereLabel = (a: Atmosphere) => ATMOSPHERES.find((x) => x.mode === a)?.label ?? a;

/** What fits: widget h ≤ 2 → no forecast, no effects controls; h = 3 → forecast; h ≥ 4 → + effects. Popover → everything. */
export function panelFit(layout: WeatherPanelLayout, size?: { w: number; h: number }): PanelFit {
  if (layout === "popover") return { days: 7, showEffects: true };
  const w = size?.w ?? 3;
  const h = size?.h ?? 3;
  if (h <= 2) return { days: 0, showEffects: false };
  return { days: w >= 3 ? 7 : 4, showEffects: h >= 4 };
}

/** The Live / Manual status line. The Manual indicator always shows, in every layout. */
export function statusText(source: EffectsSource, atmosphere: Atmosphere, liveLabel?: string): string {
  if (source === "manual") return `Manual · ${atmosphereLabel(atmosphere)}`;
  if (source === "fallback") return "Live · no data, following the clock";
  return `Live · ${liveLabel ?? atmosphereLabel(atmosphere)}`;
}

/** The forecast icon follows the WMO code (display only; the particle mapping is unchanged). */
function wmoIcon(code: number): typeof Sun {
  if (code <= 1) return Sun;
  if (code === 2) return CloudSun;
  if (code === 3) return Cloud;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 57) return CloudDrizzle;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return CloudRain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return Snowflake;
  if (code >= 95) return CloudLightning;
  return Cloud;
}

const deg = (c: number) => `${Math.round(c)}°`;

export function forecastAria(d: ForecastDay, name: string): string {
  const precip = d.precipPct === null ? "" : `, ${Math.round(d.precipPct)}% precipitation`;
  return `${name}: ${d.label}, high ${deg(d.maxC)}, low ${deg(d.minC)}${precip}`;
}

export function AtmospherePicker({ mode, onChange, className = "" }: AtmospherePickerProps) {
  return (
    <div role="radiogroup" aria-label="Atmosphere" className={`well flex w-fit flex-wrap gap-0.5 rounded-full p-1 ${className}`}>
      {ATMOSPHERES.map(({ mode: m, label, icon: Icon }) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          aria-label={label}
          title={label}
          onClick={() => onChange(m)}
          className={`grid size-7 place-items-center rounded-full transition-colors ${
            mode === m ? "bg-gradient-to-tr from-amber to-amber-light text-canvas shadow-[0_0_12px_rgba(255,122,47,0.6)]" : "text-ink-2 hover:bg-white/10 hover:text-ink"
          }`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

export function ForecastStrip({ days, max }: ForecastStripProps) {
  const shown = days.slice(0, Math.max(0, max));
  if (!shown.length) return null;
  return (
    <ul role="list" aria-label="Forecast" className="grid gap-1" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
      {shown.map((d, i) => {
        const Icon = wmoIcon(d.code);
        const name = i === 0 ? "Today" : d.weekday;
        return (
          <li key={d.date} role="listitem" aria-label={forecastAria(d, name)} title={d.label} className="flex min-w-0 flex-col items-center gap-0.5 r-10 bg-white/[0.03] px-0.5 py-1.5">
            <span className="label-caps truncate text-ink-3">{name}</span>
            <Icon size={14} aria-hidden className="text-ink-2" />
            <span className="font-mono fs-12 font-semibold text-ink tabular">{deg(d.maxC)}</span>
            <span className="font-mono fs-10 text-ink-3 tabular">{deg(d.minC)}</span>
            {d.precipPct !== null && d.precipPct > 0 && <span className="font-mono fs-9 text-ink-3 tabular">{Math.round(d.precipPct)}%</span>}
          </li>
        );
      })}
    </ul>
  );
}

const INTENSITY: readonly SegmentOption<EffectsIntensity>[] = [
  { id: "low", label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high", label: "High" },
];

function EffectsControls({ effects, particlesSuppressed, onEffects }: Pick<WeatherPanelViewProps, "effects" | "particlesSuppressed" | "onEffects">) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={effects.enabled}
          aria-label="Weather effects"
          onClick={() => onEffects({ enabled: !effects.enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${effects.enabled ? "bg-teal/80" : "bg-white/15"}`}
        >
          <span aria-hidden className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${effects.enabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
        <span className="label-caps text-ink-2">Effects</span>
        <Segmented size="sm" label="Effects intensity" value={effects.intensity} options={INTENSITY} disabled={!effects.enabled} onChange={(intensity) => onEffects({ intensity })} className="ml-auto" />
      </div>
      {particlesSuppressed && <p className="fs-11 text-ink-3">Particles are off on this device (performance).</p>}
    </div>
  );
}

/** Presentational: current conditions, forecast strip, Live/Manual status with Back to Live, picker, effects. */
export function WeatherPanelView(p: WeatherPanelViewProps) {
  const { now, forecast, error, loading, mode, atmosphere, source, fit, layout } = p;
  const manual = mode !== "auto";
  return (
    <div className={`flex flex-col gap-2.5 ${layout === "widget" ? "h-full" : ""}`}>
      <WidgetHeader
        title={now?.place ?? "Weather"}
        status={
          <>
            <span className={`label-caps truncate ${manual ? "text-amber-light" : "text-ink-3"}`} data-testid="weather-status">
              {manual && <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-amber align-middle" />}
              {statusText(source, atmosphere, now?.label)}
            </span>
            {manual && (
              <button type="button" onClick={() => p.onMode("auto")} className="pill-glass !h-6 shrink-0 !px-2 fs-10">
                Back to Live
              </button>
            )}
          </>
        }
      />
      {now ? (
        <div className="flex items-end gap-3">
          <span className="font-mono text-4xl font-semibold text-ink tabular">{deg(now.tempC)}</span>
          <div className="pb-1">
            <p className="text-sm text-ink">{now.label}</p>
            <p className="font-mono fs-11 text-ink-3 tabular">wind {Math.round(now.windKph)} km/h</p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Empty>{error ?? "Fetching conditions…"}</Empty>
          {error && (
            <button type="button" onClick={p.onRefresh} aria-label="Retry weather" title="Retry" className="pill-glass !h-7 !w-7 shrink-0 !p-0">
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
            </button>
          )}
        </div>
      )}
      {fit.days > 0 && <ForecastStrip days={forecast} max={fit.days} />}
      <div className={`flex flex-col gap-2 ${layout === "widget" ? "mt-auto" : ""}`}>
        <AtmospherePicker mode={mode} onChange={p.onMode} />
        {fit.showEffects && <EffectsControls effects={p.effects} particlesSuppressed={p.particlesSuppressed} onEffects={p.onEffects} />}
      </div>
    </div>
  );
}

/** Store-reading container (the Living Weather widget, and the sheet behind "Open weather & forecast"). */
export function WeatherPanel({ layout, size }: WeatherPanelProps) {
  const { now, forecast, error, loading, refresh } = useWeather();
  const { atmosphere, source, mode } = useAtmosphereInfo();
  const effects = useSettings((s) => s.effects);
  const set = useSettings((s) => s.set);
  const particlesSuppressed = usePrefersReducedMotion();
  return (
    <WeatherPanelView
      now={now}
      forecast={forecast}
      error={error}
      loading={loading}
      mode={mode}
      atmosphere={atmosphere}
      source={source}
      effects={effects}
      particlesSuppressed={particlesSuppressed}
      fit={panelFit(layout, size)}
      layout={layout}
      onMode={(weatherMode) => set({ weatherMode })}
      onEffects={(patch) => set({ effects: { ...useSettings.getState().effects, ...patch } })}
      onRefresh={() => void refresh()}
    />
  );
}
