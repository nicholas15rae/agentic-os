import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapRoute } from "@/lib/platform";

const h = vi.hoisted(() => ({ handler: null as ((r: unknown) => void) | null }));
vi.mock("@/lib/platform", () => ({
  isTauri: () => true,
  onNativeEvent: vi.fn(async (_name: string, f: (r: unknown) => void) => {
    h.handler = f;
    return () => undefined;
  }),
}));

import { ECHO_WINDOW_MS, listenForRoutes, routeKey, useMapRoute } from "./map-store";

// What Rust returns (and emits) for map_route with "lat,lng" points: coordinate labels.
const rust = (): MapRoute => ({
  provider: "osrm",
  distanceM: 12_300,
  durationS: 1500,
  waypoints: [
    { lat: 43.7, lng: -79.4, label: "43.70000, -79.40000" },
    { lat: 43.6525, lng: -79.3839, label: "43.65250, -79.38390" },
  ],
  steps: [],
  geometry: { type: "LineString", coordinates: [[-79.4, 43.7], [-79.39, 43.68], [-79.3839, 43.6525]] },
  trafficAware: false,
  note: "OSM",
  openInMaps: "https://www.google.com/maps/dir/?api=1",
});
const LABELS = ["Home", "100 Queen Street West, Toronto"];
const labels = () => useMapRoute.getState().route?.waypoints.map((w) => w.label);
const fire = (r: MapRoute) => h.handler?.(r);

beforeEach(() => {
  useMapRoute.getState().clear();
  useMapRoute.setState({ rev: 0 });
  listenForRoutes();
});
afterEach(() => vi.useRealTimers());

describe("map-store: the widget's own route vs Rust's map-route echo", () => {
  it("listens to map-route events", () => {
    expect(h.handler).toBeTypeOf("function");
    fire(rust());
    expect(useMapRoute.getState().rev).toBe(1);
    expect(labels()).toEqual(["43.70000, -79.40000", "43.65250, -79.38390"]);
  });
  it("event AFTER the response: labels survive and rev bumps once", () => {
    useMapRoute.getState().setOwnRoute(rust(), LABELS);
    fire(rust());
    expect(labels()).toEqual(LABELS);
    expect(useMapRoute.getState().rev).toBe(1);
  });
  it("event BEFORE the response: the labels are applied and rev bumps once", () => {
    fire(rust());
    useMapRoute.getState().setOwnRoute(rust(), LABELS);
    expect(labels()).toEqual(LABELS);
    expect(useMapRoute.getState().rev).toBe(1);
  });
  it("a plain search (no labels) is shown once either way", () => {
    useMapRoute.getState().setOwnRoute(rust());
    fire(rust());
    expect(useMapRoute.getState().rev).toBe(1);
  });
  it("a different route from Tony still shows, and so does a repeat after the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-26T15:00:00-05:00"));
    useMapRoute.getState().setOwnRoute(rust(), LABELS);
    const other = { ...rust(), distanceM: 9_000 };
    fire(other);
    expect(useMapRoute.getState().rev).toBe(2);
    expect(useMapRoute.getState().route?.distanceM).toBe(9_000);

    useMapRoute.getState().setOwnRoute(rust(), LABELS);
    vi.setSystemTime(Date.now() + ECHO_WINDOW_MS + 1);
    fire(rust()); // Tony asks for the same trip later: a real new route
    expect(useMapRoute.getState().rev).toBe(4);
  });
  it("only one echo is swallowed", () => {
    useMapRoute.getState().setOwnRoute(rust(), LABELS);
    fire(rust());
    fire(rust());
    expect(useMapRoute.getState().rev).toBe(2);
  });
  it("routeKey ignores labels but not coordinates", () => {
    const a = rust();
    const b = { ...a, waypoints: a.waypoints.map((w) => ({ ...w, label: "x" })) };
    expect(routeKey(a)).toBe(routeKey(b));
    expect(routeKey(a)).not.toBe(routeKey({ ...a, waypoints: [a.waypoints[0], { ...a.waypoints[1], lat: 43.66 }] }));
    expect(routeKey(null)).toBe("");
  });
});
