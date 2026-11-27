import { create } from "zustand";
import { isTauri, onNativeEvent, type MapRoute } from "@/lib/platform";
import { relabelRoute } from "./nav";

/**
 * The latest route, from Tony's `maps.route` tool (Rust emits `map-route`) or the widget's
 * own search. In memory only: routes contain addresses, so nothing goes to localStorage.
 *
 * Rust's `map_route` command ALSO emits `map-route` before it returns, and nothing orders that
 * event against the invoke response. So the widget hands its own result to `setOwnRoute`, which
 * shows it once (one `rev` bump) whichever arrives first, and keeps the widget's friendly labels
 * even when the event lands after the response.
 */
interface MapState {
  route: MapRoute | null;
  /** Bumps on every new route so the map re-fits even when the same route repeats. */
  rev: number;
  setRoute: (r: MapRoute) => void;
  /** A `map-route` event from Rust: deduped against the widget's own just-shown route. */
  receiveRoute: (r: MapRoute) => void;
  /** The widget's own `map_route` result, with optional friendly labels (one per waypoint). */
  setOwnRoute: (r: MapRoute, labels?: readonly (string | null | undefined)[]) => void;
  clear: () => void;
}

/** How long an own route and its `map-route` echo are paired. */
export const ECHO_WINDOW_MS = 15_000;

/** Same road and points: waypoint coordinates (5 dp), distance, duration and line length. */
export function routeKey(r: Pick<MapRoute, "waypoints" | "distanceM" | "durationS" | "geometry"> | null | undefined): string {
  if (!r?.waypoints) return "";
  const pts = r.waypoints.map((w) => `${Number(w.lat).toFixed(5)},${Number(w.lng).toFixed(5)}`).join(";");
  return `${pts}|${Math.round(r.distanceM)}|${Math.round(r.durationS)}|${r.geometry?.coordinates?.length ?? 0}`;
}

/** The last route the widget set itself (so its late echo is dropped) and the last event (so an early echo isn't doubled). */
let own: { key: string; atMs: number } | null = null;
let lastEvent: { key: string; atMs: number } | null = null;
const fresh = (x: { atMs: number } | null, now: number) => !!x && now - x.atMs >= 0 && now - x.atMs <= ECHO_WINDOW_MS;

export const useMapRoute = create<MapState>((set, get) => ({
  route: null,
  rev: 0,
  setRoute: (route) => set((s) => ({ route, rev: s.rev + 1 })),
  receiveRoute: (r) => {
    const now = Date.now();
    const key = routeKey(r);
    if (own && own.key === key && fresh(own, now) && routeKey(get().route) === key) {
      // The echo of the widget's own route, which is already on screen with its labels.
      own = null;
      return;
    }
    lastEvent = { key, atMs: now };
    get().setRoute(r);
  },
  setOwnRoute: (r, labels) => {
    const now = Date.now();
    const key = routeKey(r);
    const shown = labels ? relabelRoute(r, labels) : r;
    if (lastEvent && lastEvent.key === key && fresh(lastEvent, now) && routeKey(get().route) === key) {
      // The event came first and already bumped rev: swap in the labels without a second re-fit.
      lastEvent = null;
      own = null;
      set({ route: shown });
      return;
    }
    own = { key, atMs: now };
    get().setRoute(shown);
  },
  clear: () => {
    own = null;
    lastEvent = null;
    set({ route: null });
  },
}));

let listening = false;

/** Subscribe once (idempotent) to `map-route` events from Rust. */
export function listenForRoutes(): void {
  if (listening || !isTauri()) return;
  listening = true;
  void onNativeEvent<MapRoute>("map-route", (r) => useMapRoute.getState().receiveRoute(r));
}
