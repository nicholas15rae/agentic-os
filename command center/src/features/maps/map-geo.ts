import type { MapRoute } from "@/lib/platform";

/** OpenFreeMap vector style — free, no key, no card. */
export const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** [[west, south], [east, north]] covering the route line and every waypoint, or null. */
export function routeBounds(route: Pick<MapRoute, "geometry" | "waypoints">): [[number, number], [number, number]] | null {
  const pts: [number, number][] = [...(route.geometry?.coordinates ?? []), ...route.waypoints.map((p) => [p.lng, p.lat] as [number, number])];
  const ok = pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!ok.length) return null;
  let [w, s, e, n] = [ok[0][0], ok[0][1], ok[0][0], ok[0][1]];
  for (const [x, y] of ok) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return [
    [w, s],
    [e, n],
  ];
}

export function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Short pin label: the first part of a Nominatim display name. */
export function shortLabel(label: string): string {
  return label.split(",")[0]?.trim() || label;
}

/** Pin kind by position: origin, stop, destination. */
export function pinKind(i: number, total: number): "origin" | "stop" | "destination" {
  return i === 0 ? "origin" : i === total - 1 ? "destination" : "stop";
}
