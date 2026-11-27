import { create } from "zustand";
import { isTauri, onNativeEvent, type MapRoute } from "@/lib/platform";

/**
 * The latest route, from Tony's `maps.route` tool (Rust emits `map-route`) or the widget's
 * own search. In memory only: routes contain addresses, so nothing goes to localStorage.
 */
interface MapState {
  route: MapRoute | null;
  /** Bumps on every new route so the map re-fits even when the same route repeats. */
  rev: number;
  setRoute: (r: MapRoute) => void;
  clear: () => void;
}

export const useMapRoute = create<MapState>((set) => ({
  route: null,
  rev: 0,
  setRoute: (route) => set((s) => ({ route, rev: s.rev + 1 })),
  clear: () => set({ route: null }),
}));

let listening = false;

/** Subscribe once (idempotent) to `map-route` events from Rust. */
export function listenForRoutes(): void {
  if (listening || !isTauri()) return;
  listening = true;
  void onNativeEvent<MapRoute>("map-route", (r) => useMapRoute.getState().setRoute(r));
}
