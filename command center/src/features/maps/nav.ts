// Contract: ./contract.ts (DRAFT). Pure helpers: Google Maps URLs, the allow-list, the hand-off parser.
// Nothing here throws on bad input: bad data gives null / { ok: false }.
import type { MapPlace, MapRoute } from "@/lib/platform";
import type { SavedRoute } from "@/lib/cc-api";
import type { HandoffItem, HandoffParse, HandoffStatus, HandoffStop, NavMode } from "./contract";

/** maps_api.py HANDOFF_TTL_S: a hand-off lives 30 min. */
export const HANDOFF_TTL_MS = 30 * 60_000;
/** Clock skew between the phone and the PC that is still accepted. */
export const HANDOFF_SKEW_MS = 2 * 60_000;
/** maps_api.py LABEL_MAX / STOPS_MAX. */
export const HANDOFF_LABEL_MAX = 120;
export const HANDOFF_STOPS_MAX = 8;
/** Google Maps directions take at most 9 waypoints. */
export const DIRECTIONS_STOPS_MAX = 9;

export const NAV_MODES: readonly NavMode[] = ["navigate", "pin", "directions"];
const STATUSES: readonly HandoffStatus[] = ["pending", "opened", "dismissed", "expired"];

/** The only hosts an "Open in Maps" link may point at (https only). */
const MAP_HOSTS = new Set(["www.google.com", "google.com", "maps.google.com"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** lat in [-90, 90], lng in [-180, 180], both finite numbers. */
export function isLatLng(lat: unknown, lng: unknown): boolean {
  return isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

const pair = (lat: number, lng: number) => encodeURIComponent(`${lat.toFixed(6)},${lng.toFixed(6)}`);

/**
 * A Google Maps directions URL from coordinates (same shape as Rust `open_in_maps_url`). Every
 * value is percent-encoded. Null when any point is out of range or there are too many stops.
 */
export function directionsUrl(
  dest: { lat: number; lng: number },
  opts: { origin?: { lat: number; lng: number } | null; stops?: readonly { lat: number; lng: number }[]; travelmode?: "driving" | "transit" | "walking" | "bicycling" } = {},
): string | null {
  if (!dest || !isLatLng(dest.lat, dest.lng)) return null;
  const stops = opts.stops ?? [];
  if (stops.length > DIRECTIONS_STOPS_MAX || !stops.every((s) => s && isLatLng(s.lat, s.lng))) return null;
  if (opts.origin && !isLatLng(opts.origin.lat, opts.origin.lng)) return null;
  let u = `https://www.google.com/maps/dir/?api=1&destination=${pair(dest.lat, dest.lng)}`;
  if (opts.origin) u += `&origin=${pair(opts.origin.lat, opts.origin.lng)}`;
  u += `&travelmode=${encodeURIComponent(opts.travelmode ?? "driving")}`;
  if (stops.length) u += `&waypoints=${stops.map((s) => pair(s.lat, s.lng)).join("%7C")}`;
  return u;
}

/** A Google Maps pin (search) URL for one point. */
export function pinUrl(p: { lat: number; lng: number }): string | null {
  if (!p || !isLatLng(p.lat, p.lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${pair(p.lat, p.lng)}`;
}

/** https, a Google Maps host, a /maps path, no credentials, default port. Never throws. */
export function isAllowedMapUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && MAP_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port && (u.pathname === "/maps" || u.pathname.startsWith("/maps/"));
}

/** The URL if it passes the allow-list, else null. */
export const safeMapUrl = (url: unknown): string | null => (isAllowedMapUrl(url) ? url : null);

// Control, bidi and zero-width characters (the set maps_api.py `_CTRL` strips).
const UNSAFE_TEXT = new RegExp("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]", "g");

/** Display text: unsafe characters out, spaces collapsed, capped. Non-strings give "". */
export function cleanText(v: unknown, cap: number): string {
  if (typeof v !== "string") return "";
  const s = v.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A queued hand-off from the gateway (GET /api/maps/handoff item or a `nav-handoff` WS frame),
 * strictly: a known mode, coordinates in range, an id, from the desktop, not expired (30-min
 * TTL by its own `expiresMs` and by `createdMs`), and any URL field it carries must be an allowed
 * Google Maps https link (the receiver builds its own URL from the coordinates anyway).
 */
export function parseHandoff(raw: unknown, nowMs: number = Date.now()): HandoffParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not-object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return { ok: false, reason: "bad-id" };
  if (!isLatLng(r.lat, r.lng)) return { ok: false, reason: "bad-coords" };
  const mode = r.mode === undefined ? "navigate" : r.mode;
  if (typeof mode !== "string" || !(NAV_MODES as readonly string[]).includes(mode)) return { ok: false, reason: "bad-mode" };
  const status = r.status === undefined ? "pending" : r.status;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return { ok: false, reason: "bad-status" };
  if (r.from !== undefined && r.from !== "desktop") return { ok: false, reason: "bad-from" };
  for (const k of ["url", "openInMaps", "href", "link"]) {
    if (k in r && !isAllowedMapUrl(r[k])) return { ok: false, reason: "bad-url" };
  }
  if (!isNum(r.createdMs) || !isNum(r.expiresMs) || r.createdMs <= 0 || r.expiresMs <= r.createdMs) return { ok: false, reason: "bad-time" };
  // The gateway's own expiry, and never longer than the 30-min TTL whatever expiresMs says.
  if (nowMs >= r.expiresMs || nowMs - r.createdMs > HANDOFF_TTL_MS + HANDOFF_SKEW_MS || r.createdMs - nowMs > HANDOFF_SKEW_MS) return { ok: false, reason: "stale" };
  let stops: HandoffStop[] | undefined;
  if (r.stops !== undefined && r.stops !== null) {
    if (!Array.isArray(r.stops) || r.stops.length > HANDOFF_STOPS_MAX) return { ok: false, reason: "bad-stops" };
    stops = [];
    for (const s of r.stops) {
      if (!s || typeof s !== "object" || !isLatLng((s as HandoffStop).lat, (s as HandoffStop).lng)) return { ok: false, reason: "bad-stops" };
      const p = s as HandoffStop;
      const label = cleanText(p.label, HANDOFF_LABEL_MAX);
      stops.push(label ? { lat: p.lat, lng: p.lng, label } : { lat: p.lat, lng: p.lng });
    }
  }
  const lat = r.lat as number;
  const lng = r.lng as number;
  const item: HandoffItem = {
    id: r.id,
    lat,
    lng,
    label: cleanText(r.label, HANDOFF_LABEL_MAX) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    mode: mode as NavMode,
    status: status as HandoffStatus,
    createdMs: r.createdMs,
    expiresMs: Math.min(r.expiresMs, r.createdMs + HANDOFF_TTL_MS),
    from: "desktop",
  };
  if (stops?.length) item.stops = stops;
  return { ok: true, item };
}

/** The link a hand-off opens: a pin for "pin", directions otherwise. Built from coordinates only. */
export function handoffUrl(item: Pick<HandoffItem, "lat" | "lng" | "mode" | "stops">): string | null {
  return item.mode === "pin" ? pinUrl(item) : directionsUrl(item, { stops: item.stops });
}

// ── Saved routes <-> map routes (lib/cc-api.ts "routes" collection) ───────────

/** The saved-route caps (cc-api ROUTE_NAME_MAX / ROUTE_LABEL_MAX / ROUTE_STOPS_MAX), restated so this file stays pure. */
const SAVED_NAME_MAX = 80;
const SAVED_LABEL_MAX = 200;
const SAVED_STOPS_MAX = 9;

const savedPlace = (p: MapPlace): MapPlace | null => (p && isLatLng(p.lat, p.lng) ? { lat: p.lat, lng: p.lng, label: cleanText(p.label, SAVED_LABEL_MAX) } : null);

/**
 * The route on the map as a SavedRoute (origin = first waypoint, destination = last, the rest
 * stops), or null when it has fewer than 2 usable points or too many stops. `name` falls back to
 * the destination's short label.
 */
export function savedFromRoute(route: Pick<MapRoute, "waypoints"> | null | undefined, name: string): SavedRoute | null {
  const pts = (route?.waypoints ?? []).map(savedPlace);
  if (pts.length < 2 || pts.some((p) => p === null)) return null;
  const places = pts as MapPlace[];
  const stops = places.slice(1, -1);
  if (stops.length > SAVED_STOPS_MAX) return null;
  const dest = places[places.length - 1];
  const n = cleanText(name, SAVED_NAME_MAX) || cleanText(dest.label.split(",")[0] ?? "", SAVED_NAME_MAX) || "Saved route";
  return { name: n, origin: places[0], destination: dest, stops };
}

/**
 * `map_route` arguments for a saved route: coordinates as "lat,lng" (no geocoding). "home" leaves
 * the origin out (Rust uses MAP_HOME); "here" uses `here` when given, else home. Null when a
 * point is out of range.
 */
export function routeArgsForSaved(r: SavedRoute, here?: { lat: number; lng: number } | null): { destination: string; origin?: string; stops?: string[] } | null {
  const ll = (p: { lat: number; lng: number } | null | undefined) => (p && isLatLng(p.lat, p.lng) ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : null);
  const destination = ll(r?.destination);
  if (!destination) return null;
  const stops = (r.stops ?? []).map(ll);
  if (stops.some((s) => s === null) || stops.length > SAVED_STOPS_MAX) return null;
  const out: { destination: string; origin?: string; stops?: string[] } = { destination };
  const o = r.origin === "home" ? null : r.origin === "here" ? ll(here) : ll(r.origin);
  if (r.origin !== "home" && r.origin !== "here" && !o) return null;
  if (o) out.origin = o;
  if (stops.length) out.stops = stops as string[];
  return out;
}

/** "from home" / "from here" / "from <place>" for a saved route's start. */
export function savedOriginText(o: SavedRoute["origin"]): string {
  if (o === "home") return "from home";
  if (o === "here") return "from your location";
  return `from ${cleanText(o?.label, 60).split(",")[0] || "a saved place"}`;
}

/**
 * The same route with nicer pin labels (map_route given "lat,lng" labels its points with
 * coordinates). `labels[i]` replaces waypoint i when it is non-empty; ignored unless the counts
 * match. Pure; labels are cleaned display text.
 */
export function relabelRoute<R extends Pick<MapRoute, "waypoints">>(route: R, labels: readonly (string | null | undefined)[]): R {
  if (!route?.waypoints || labels.length !== route.waypoints.length) return route;
  return { ...route, waypoints: route.waypoints.map((w, i) => ({ ...w, label: cleanText(labels[i], SAVED_LABEL_MAX) || w.label })) };
}
