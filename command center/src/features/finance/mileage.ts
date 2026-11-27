/**
 * Mileage log maths: km for a trip (from the maps route, else typed), its $ value at your per-km
 * rate, and totals per area. The maps distance is the shortest driving route with no live
 * traffic, so it's labelled an estimate. Pure.
 */
import { areaOf } from "./areas";
import type { MileageTrip } from "./types";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** km from a route's metres (one way, doubled for a round trip). */
export const kmFromRoute = (distanceM: number, roundTrip = false): number => r1((Math.max(0, distanceM) / 1000) * (roundTrip ? 2 : 1));

/** "12,5" / "12.5 km" → 12.5; nonsense → null. */
export function parseKm(raw: string): number | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s*km$/, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n < 10_000 ? r1(n) : null;
}

export const mileageValue = (km: number, rate: number): number => r2(Math.max(0, km) * Math.max(0, rate));

export interface MileageTotals {
  area: string;
  trips: number;
  km: number;
  value: number;
}

export function mileageTotals(trips: readonly MileageTrip[], rate: number): MileageTotals[] {
  const m = new Map<string, MileageTotals>();
  for (const t of trips) {
    const a = areaOf(t);
    const cur = m.get(a) ?? { area: a, trips: 0, km: 0, value: 0 };
    cur.trips++;
    cur.km = r1(cur.km + t.km);
    m.set(a, cur);
  }
  return [...m.values()].map((x) => ({ ...x, value: mileageValue(x.km, rate) })).sort((a, b) => b.km - a.km);
}
