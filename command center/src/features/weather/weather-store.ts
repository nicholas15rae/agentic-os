import { useEffect, useState } from "react";
import { create } from "zustand";
import { useSettings, type WeatherMode } from "@/stores/settings";
import {
  EFFECT_MULT,
  WEATHER_REFRESH_MS,
  type Atmosphere,
  type AtmosphereInfo,
  type EffectsSource,
  type ForecastDay,
  type WeatherNow,
  type WeatherState,
} from "./weather.contract";

// Contract: ./weather.contract.ts (LOCKED). Types live there; re-exported so existing imports keep working.
export { EFFECT_MULT, WEATHER_REFRESH_MS };
export type { Atmosphere, AtmosphereInfo, EffectsSource, ForecastDay, WeatherNow, WeatherState };

export type TimePhase = "day" | "golden" | "night";
export const PHASES: TimePhase[] = ["day", "golden", "night"];

/** Golden = within 50 min of sunrise/sunset. Without sun data, fall back to the clock. */
export function timePhase(now: number, sunrise: number | null, sunset: number | null): TimePhase {
  const GOLDEN = 50 * 60_000;
  if (sunrise && sunset) {
    if (Math.abs(now - sunrise) < GOLDEN || Math.abs(now - sunset) < GOLDEN) return "golden";
    return now > sunrise && now < sunset ? "day" : "night";
  }
  const h = new Date(now).getHours();
  return h >= 7 && h < 17 ? "day" : h >= 17 && h < 19 ? "golden" : h >= 6 && h < 7 ? "golden" : "night";
}

/** WMO weather code → human label + particle atmosphere. Mapping kept as is (decision 32); only code 1 is "Mainly clear". */
export function describeWmo(code: number, isDay: boolean): { label: string; atmosphere: Atmosphere } {
  if (code === 0) return { label: isDay ? "Clear" : "Clear night", atmosphere: isDay ? "clear" : "midnight" };
  if (code === 1) return { label: "Mainly clear", atmosphere: isDay ? "clear" : "midnight" };
  if (code === 2 || code === 3) return { label: code === 2 ? "Partly cloudy" : "Overcast", atmosphere: isDay ? "autumn" : "midnight" };
  if (code === 45 || code === 48) return { label: "Fog", atmosphere: "fog" };
  if (code >= 51 && code <= 67) return { label: code >= 61 ? "Rain" : "Drizzle", atmosphere: "rain" };
  if (code >= 71 && code <= 77) return { label: "Snow", atmosphere: "snow" };
  if (code >= 80 && code <= 82) return { label: "Showers", atmosphere: "rain" };
  if (code === 85 || code === 86) return { label: "Snow showers", atmosphere: "snow" };
  if (code >= 95) return { label: "Thunderstorm", atmosphere: "rain" };
  return { label: "—", atmosphere: "clear" };
}

const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset";

/** Open-Meteo: free, no API key, CORS-enabled (the Tauri CSP allows it). One call: current + `days` daily rows. */
export function weatherUrl(lat: number, lon: number, days = 7): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,is_day&daily=${DAILY}&forecast_days=${days}&timezone=auto&timeformat=unixtime`
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ms = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n * 1000;
};

/**
 * The location's calendar date for a daily row. With timeformat=unixtime, `daily.time` is the location's
 * local midnight as epoch seconds; shifting by `utc_offset_seconds` and reading it as UTC gives that
 * date regardless of the machine's timezone. +12 h before flooring absorbs a DST change inside the
 * 7 days (the offset is today's, so a later midnight can land an hour either side of 00:00).
 */
function localDate(timeSec: number, offsetSec: number): { date: string; weekday: string } {
  const day = Math.floor((timeSec + offsetSec + 43_200) / 86_400);
  const d = new Date(day * 86_400_000);
  return { date: d.toISOString().slice(0, 10), weekday: WEEKDAYS[d.getUTCDay()] };
}

interface OpenMeteoJson {
  utc_offset_seconds?: unknown;
  current?: { temperature_2m?: unknown; weather_code?: unknown; wind_speed_10m?: unknown; is_day?: unknown };
  daily?: Record<string, unknown[] | undefined>;
}

/** Pure: an Open-Meteo response → current conditions + up to N forecast days. Throws when `current` is missing. */
export function parseOpenMeteo(json: unknown, place: string, at: number): { now: WeatherNow; forecast: ForecastDay[] } {
  const j = (json ?? {}) as OpenMeteoJson;
  const c = j.current;
  const tempC = num(c?.temperature_2m);
  const code = num(c?.weather_code);
  if (!c || tempC === null || code === null) throw new Error("Weather: no current conditions");
  const isDay = c.is_day === 1;
  const { label, atmosphere } = describeWmo(code, isDay);
  const d = j.daily;
  const now: WeatherNow = {
    tempC,
    windKph: num(c.wind_speed_10m) ?? 0,
    code,
    isDay,
    label,
    atmosphere,
    place,
    fetchedAt: at,
    sunrise: ms(d?.sunrise?.[0]),
    sunset: ms(d?.sunset?.[0]),
  };
  const offset = num(j.utc_offset_seconds) ?? 0;
  const forecast: ForecastDay[] = [];
  const times = Array.isArray(d?.time) ? d.time : [];
  times.forEach((t, i) => {
    const time = num(t);
    const dayCode = num(d?.weather_code?.[i]);
    const maxC = num(d?.temperature_2m_max?.[i]);
    const minC = num(d?.temperature_2m_min?.[i]);
    if (time === null || dayCode === null || maxC === null || minC === null) return;
    const w = describeWmo(dayCode, true);
    forecast.push({
      ...localDate(time, offset),
      dayStart: time * 1000,
      code: dayCode,
      label: w.label,
      atmosphere: w.atmosphere,
      maxC,
      minC,
      precipPct: num(d?.precipitation_probability_max?.[i]),
      sunrise: ms(d?.sunrise?.[i]),
      sunset: ms(d?.sunset?.[i]),
    });
  });
  return { now, forecast };
}

/** Pure: which atmosphere is drawn, and why. Manual wins; "auto" uses live weather; no live data follows the clock. */
export function resolveAtmosphere(mode: WeatherMode, live: Atmosphere | undefined, phase: TimePhase): { atmosphere: Atmosphere; source: EffectsSource } {
  if (mode !== "auto") return { atmosphere: mode, source: "manual" };
  if (live) return { atmosphere: live, source: "live" };
  return { atmosphere: phase === "night" ? "midnight" : "clear", source: "fallback" };
}

async function resolveLocation(): Promise<{ lat: number; lon: number; label: string }> {
  const fixed = useSettings.getState().weatherLocation;
  if (fixed) return fixed;
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return reject(new Error("Set a location in Settings"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: "Current location" }),
      () => reject(new Error("Location denied — set one in Settings")),
      { timeout: 10_000, maximumAge: 30 * 60_000 },
    );
  });
}

/** Only the newest request may write: a slow fetch for the old location must not land after the new one. */
let requestSeq = 0;

export const useWeather = create<WeatherState>((set) => ({
  now: null,
  forecast: [],
  error: null,
  loading: false,
  refresh: async () => {
    const mine = ++requestSeq;
    set({ loading: true });
    try {
      const loc = await resolveLocation();
      const res = await fetch(weatherUrl(loc.lat, loc.lon));
      if (!res.ok) throw new Error(`Weather ${res.status}`);
      const parsed = parseOpenMeteo(await res.json(), loc.label, Date.now());
      if (mine !== requestSeq) return;
      set({ ...parsed, error: null, loading: false });
    } catch (err) {
      if (mine !== requestSeq) return;
      set({ error: err instanceof Error ? err.message : "Weather unavailable", loading: false });
    }
  },
}));

const locKey = (l: { lat: number; lon: number; label: string } | null) => (l ? `${l.lat},${l.lon},${l.label}` : "");

/**
 * The refresh loop (non-React, so it is testable): fetch now and every `intervalMs`; on visibilitychange
 * when the last attempt is older than the interval (sleep/resume); and immediately when the saved
 * weather location changes (the S22 app has no location permission and waits on a saved location).
 * Returns the cleanup.
 */
export function startWeatherRefresh(intervalMs = WEATHER_REFRESH_MS): () => void {
  let lastRun = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    lastRun = Date.now();
    void useWeather.getState().refresh();
  };
  const restart = () => {
    clearInterval(timer);
    run();
    timer = setInterval(run, intervalMs);
  };
  restart();
  const unsubscribe = useSettings.subscribe((s, prev) => {
    if (locKey(s.weatherLocation) !== locKey(prev.weatherLocation)) restart();
  });
  const onVisible = () => {
    if (!document.hidden && Date.now() - lastRun > intervalMs) restart();
  };
  const hasDoc = typeof document !== "undefined";
  if (hasDoc) document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    unsubscribe();
    if (hasDoc) document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Mounted once in the app shell (MainApp), so the clock's temperature keeps updating with effects off. */
export function useWeatherRefresh(intervalMs = WEATHER_REFRESH_MS): void {
  useEffect(() => startWeatherRefresh(intervalMs), [intervalMs]);
}

/** The drawn atmosphere plus where it came from (live / manual / fallback) and the saved mode. */
export function useAtmosphereInfo(): AtmosphereInfo {
  const mode = useSettings((s) => s.weatherMode);
  const live = useWeather((s) => s.now?.atmosphere);
  const phase = useTimePhase();
  return { ...resolveAtmosphere(mode, live, phase), mode };
}

/** The atmosphere actually rendered: manual override wins, otherwise live weather (8 callers; signature unchanged). */
export function useAtmosphere(): Atmosphere {
  return useAtmosphereInfo().atmosphere;
}

/** Current day / golden-hour / night, re-evaluated every minute. */
export function useTimePhase(): TimePhase {
  const sunrise = useWeather((s) => s.now?.sunrise ?? null);
  const sunset = useWeather((s) => s.now?.sunset ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return timePhase(now, sunrise, sunset);
}
