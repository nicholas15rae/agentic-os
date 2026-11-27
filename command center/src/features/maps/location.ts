// Contract: ./contract.ts (DRAFT). Start-point helpers: device fixes, the weather location, origin wording.
// Pure except `getDeviceFix`, which asks the browser for a position ONLY when called (never on load).
import type { DeviceFix, OriginSource, TripOrigin, WeatherSpot } from "./contract";
import { cleanText, isLatLng } from "./nav";

/** trips.rs DEVICE_MAX_ACCURACY_M / DEVICE_MAX_AGE_MS: Rust ignores worse or older fixes anyway. */
export const DEVICE_MAX_ACCURACY_M = 500;
export const DEVICE_MAX_AGE_MS = 30 * 60_000;
/** trips.rs WEATHER_LABEL_MAX. */
export const WEATHER_LABEL_MAX = 120;

/** The parts of a GeolocationPosition we read. */
export interface PositionLike {
  coords: { latitude: number; longitude: number; accuracy: number };
  timestamp: number;
}

/** A browser position as a DeviceFix, or null when out of range, too vague (> 500 m) or older than 30 min. */
export function toDeviceFix(pos: PositionLike | null | undefined, nowMs: number = Date.now()): DeviceFix | null {
  const c = pos?.coords;
  if (!c || !isLatLng(c.latitude, c.longitude)) return null;
  const acc = c.accuracy;
  if (typeof acc !== "number" || !Number.isFinite(acc) || acc <= 0 || acc > DEVICE_MAX_ACCURACY_M) return null;
  const t = pos.timestamp;
  if (typeof t === "number" && Number.isFinite(t) && nowMs - t > DEVICE_MAX_AGE_MS) return null;
  // Whole metres, but never 0: Rust drops a fix whose accuracy_m is not > 0 (a sub-0.5 m fix would vanish).
  return { lat: c.latitude, lng: c.longitude, accuracyM: Math.max(1, Math.round(acc)) };
}

/** settings.weatherLocation `{lat, lon, label}` as the WeatherSpot Rust takes (`lng`), or null. */
export function weatherSpot(loc: { lat: number; lon: number; label?: string } | null | undefined): WeatherSpot | null {
  if (!loc || !isLatLng(loc.lat, loc.lon)) return null;
  return { lat: loc.lat, lng: loc.lon, label: cleanText(loc.label, WEATHER_LABEL_MAX) };
}

/**
 * One position from the browser, on an explicit user action only. Resolves null on any failure
 * (no API, denied, timeout, too vague); never rejects.
 */
export function getDeviceFix(timeoutMs = 10_000): Promise<DeviceFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    let done = false;
    const finish = (v: DeviceFix | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const t = setTimeout(() => finish(null), timeoutMs + 500);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          clearTimeout(t);
          finish(toDeviceFix(p));
        },
        () => {
          clearTimeout(t);
          finish(null);
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 5 * 60_000 },
      );
    } catch {
      clearTimeout(t);
      finish(null);
    }
  });
}

const ORIGIN_WORDS: Record<OriginSource, string> = {
  home: "from home",
  device: "from your location",
  weather: "from your weather location",
  default: "from downtown Toronto",
};

/** "from home" etc. Unknown sources read as the default. */
export function originPhrase(o: Pick<TripOrigin, "source"> | null | undefined): string {
  return (o && ORIGIN_WORDS[o.source]) || ORIGIN_WORDS.default;
}

/** "lat,lng" (6 decimals) for `map_route`, which takes coordinates without geocoding; null when out of range. */
export function latLngText(p: { lat: number; lng: number } | null | undefined): string | null {
  return p && isLatLng(p.lat, p.lng) ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : null;
}
