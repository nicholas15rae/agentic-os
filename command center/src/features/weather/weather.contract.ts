// weather.contract.ts — LOCKED 2026-11-26 (approved by Nic: all recommended defaults, decisions 31–38). Changes need a new approval.
// Scope: build plan Section 4 (docs/build-plan-sections-8-10.md), steps 1–6. Frontend only.
// IPC / HTTP / events: NONE new.
//   - Tauri commands: none.
//   - HTTP: the existing GET https://api.open-meteo.com/v1/forecast (CSP already allows it), widened to
//     forecast_days=7 with a daily= list, same single request. timezone=auto, timeformat=unixtime.
//   - Window events: none (the store is zustand; the refresh hook is mounted once in the app shell).
// Decisions recorded here:
//   31 One-time reset of the saved atmosphere to Live: YES (settings v8). The Manual indicator always shows.
//   32 Weather mapping: KEEP AS IS; only code 1 is relabelled "Mainly clear".
//   33 Top-bar effects popover: LEAN (on/off, intensity, Live/Manual, Back to Live, "Open weather & forecast").
//      The atmosphere picker therefore lives in WeatherPanel only (the Living Weather widget / its sheet).
//   36 Particles in the Android app: stay OFF (PHONE_LITE → reduced motion wins over `effects.enabled`).
//   37 Tony does not hear the forecast (features/os/context.ts unchanged).
//   38 Units: °C only.
import type { EffectsIntensity, WeatherMode } from "@/stores/settings";

export type { EffectsIntensity, WeatherMode };

/** The particle / wallpaper atmosphere actually drawn. Unchanged. */
export type Atmosphere = Exclude<WeatherMode, "auto">;

/** Current conditions. Shape unchanged (8 readers depend on it). */
export interface WeatherNow {
  tempC: number;
  windKph: number;
  code: number;
  isDay: boolean;
  label: string;
  atmosphere: Atmosphere;
  place: string;
  fetchedAt: number;
  /** Local sunrise/sunset today (epoch ms), used for time-of-day wallpaper sync. */
  sunrise: number | null;
  sunset: number | null;
}

/** One forecast day. [0] = today in the LOCATION's timezone. */
export interface ForecastDay {
  /** "YYYY-MM-DD" in the location's timezone: derived from (daily.time + utc_offset_seconds) read as UTC. */
  date: string;
  /** "Sun".."Sat" for `date` (same derivation, never the machine's timezone). */
  weekday: string;
  /** Epoch ms of the location's local midnight (daily.time × 1000). */
  dayStart: number;
  code: number;
  /** describeWmo(code, true). */
  label: string;
  atmosphere: Atmosphere;
  maxC: number;
  minC: number;
  /** 0–100, or null when Open-Meteo has no value. */
  precipPct: number | null;
  sunrise: number | null;
  sunset: number | null;
}

/** Where the drawn atmosphere came from: a manual pick, live weather, or the clock (no live data). */
export type EffectsSource = "live" | "manual" | "fallback";

export interface EffectsSettings {
  enabled: boolean;
  intensity: EffectsIntensity;
}

/** Particle-count multiplier per intensity. Reduced motion and PHONE_LITE still draw nothing. */
export const EFFECT_MULT: Record<EffectsIntensity, number> = { low: 0.5, normal: 1, high: 1.6 };

// ── store (features/weather/weather-store.ts) ────────────────────────────────

export interface WeatherState {
  now: WeatherNow | null;
  /** 0..7 days, [0] = today. Empty until the first successful fetch or when `daily` is missing. */
  forecast: ForecastDay[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Pure functions exported by weather-store.ts:
 *   weatherUrl(lat, lon, days = 7): string
 *   parseOpenMeteo(json, place, at): { now: WeatherNow; forecast: ForecastDay[] }   — throws when `current` is missing
 *   resolveAtmosphere(mode, live, phase): { atmosphere: Atmosphere; source: EffectsSource }
 *   describeWmo(code, isDay): { label; atmosphere }   — mapping unchanged except code 1 → "Mainly clear"
 * Hooks:
 *   useAtmosphere(): Atmosphere                         — unchanged signature (8 callers)
 *   useAtmosphereInfo(): AtmosphereInfo
 *   useWeatherRefresh(intervalMs = WEATHER_REFRESH_MS): void
 *     Mounted ONCE in MainApp (src/App.tsx), not in WeatherCanvas: fetch on mount, every 15 min,
 *     on visibilitychange when the data is older than the interval, and IMMEDIATELY when the saved
 *     weatherLocation changes. A late response from a superseded request is dropped.
 */
export interface AtmosphereInfo {
  atmosphere: Atmosphere;
  source: EffectsSource;
  mode: WeatherMode;
}

export const WEATHER_REFRESH_MS = 15 * 60_000;

// ── panel (features/weather/WeatherPanel.tsx) ────────────────────────────────

export type WeatherPanelLayout = "widget" | "popover";

/** What fits. widget h ≤ 2 (the old 3x2): no forecast, no effects controls. h = 3: forecast, no effects controls.
 * h ≥ 4: forecast + effects controls. popover (a sheet opened from "Open weather & forecast"): 7 days + effects. */
export interface PanelFit {
  /** Forecast days to show; 0 hides the strip. */
  days: number;
  showEffects: boolean;
}

/** role=radiogroup aria-label="Atmosphere"; one role=radio per ATMOSPHERES entry, amber when checked. */
export interface AtmospherePickerProps {
  mode: WeatherMode;
  onChange: (m: WeatherMode) => void;
  className?: string;
}

/** role=list; each item aria-label e.g. "Thu: Snow, high 1°, low -4°, 60% precipitation". [0] reads "Today". */
export interface ForecastStripProps {
  days: ForecastDay[];
  max: number;
}

export interface WeatherPanelViewProps {
  now: WeatherNow | null;
  forecast: ForecastDay[];
  error: string | null;
  loading: boolean;
  mode: WeatherMode;
  atmosphere: Atmosphere;
  source: EffectsSource;
  effects: EffectsSettings;
  /** Reduced motion / PHONE_LITE: show "Particles are off on this device (performance)" with the effects controls. */
  particlesSuppressed: boolean;
  fit: PanelFit;
  layout: WeatherPanelLayout;
  /** "auto" = Back to Live. */
  onMode: (m: WeatherMode) => void;
  onEffects: (patch: Partial<EffectsSettings>) => void;
  onRefresh: () => void;
}

/** Store-reading container. `size` is the widget's grid size (ignored for "popover"). */
export interface WeatherPanelProps {
  layout: WeatherPanelLayout;
  size?: { w: number; h: number };
}

// Always rendered, in every layout and size: the Live/Manual status line ("Live · Snow", "Manual · Rain",
// "Live · no data, following the clock") and, when mode !== "auto", a "Back to Live" button; the picker.
// Living Weather widget (widgets/weather): renders <WeatherPanel layout="widget" size={size} />, picker at
// every width (no lg:hidden), defaultSize 3x3 for NEW placements (saved layouts keep their size).
// Weather.tsx keeps exporting ATMOSPHERES and AtmosphereSwitch (store-connected) for existing imports.
