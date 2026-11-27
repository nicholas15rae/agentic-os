import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useMapRoute } from "@/features/maps/map-store";
import { OPENFREEMAP_STYLE, pinKind, routeBounds } from "@/features/maps/map-geo";
import type { MapCanvasProps } from "@/features/maps/contract";

// Contract: features/maps/contract.ts (DRAFT). The MapLibre map, drawing the map store's route.
// Mounted on the first visit to the Map tab (the phone loads no GPU map until it is needed), then
// kept alive while hidden (`active` false) so pan/zoom and the loaded tiles survive tab switches.

const HOME: [number, number] = [-79.3832, 43.6532]; // Toronto, until a route arrives
const SRC = "route";
const PIN_COLOR = { origin: "#00e5c3", stop: "#ffd166", destination: "#ff7a2f" } as const;

export default function MapCanvas({ className = "", active = true }: MapCanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  /** A route arrived while hidden: fit it once the canvas has a size again. */
  const pendingFit = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const { route, rev } = useMapRoute();

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({ container: box.current, style: OPENFREEMAP_STYLE, center: HOME, zoom: 10, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "route-casing", type: "line", source: SRC, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#0b0f14", "line-width": 8, "line-opacity": 0.6 } });
      m.addLayer({ id: "route-line", type: "line", source: SRC, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ff7a2f", "line-width": 4.5 } });
      setReady(true);
    });
    m.on("error", (e) => setMapError(e.error?.message ? `Map tiles: ${e.error.message}` : "Map tiles failed to load"));
    // Grid widgets resize without a window resize event.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(box.current);
    map.current = m;
    return () => {
      ro.disconnect();
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  // Draw the route: line, pins, fit.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    markers.current.forEach((mk) => mk.remove());
    markers.current = [];
    if (!route) {
      src?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    src?.setData({ type: "Feature", properties: {}, geometry: route.geometry });
    route.waypoints.forEach((p, i) => {
      const kind = pinKind(i, route.waypoints.length);
      const mk = new maplibregl.Marker({ color: PIN_COLOR[kind] })
        .setLngLat([p.lng, p.lat])
        // setText: labels can come from calendar invites; never HTML.
        .setPopup(new maplibregl.Popup({ offset: 24, closeButton: false }).setText(p.label || kind))
        .addTo(m);
      markers.current.push(mk);
    });
    if (!activeRef.current) {
      pendingFit.current = true;
      return;
    }
    m.resize(); // the ResizeObserver may not have caught up with a just-shown canvas
    const b = routeBounds(route);
    if (b) m.fitBounds(b, { padding: 40, maxZoom: 15, duration: 600 });
  }, [route, rev, ready]);

  // Shown again: take the real size back, then fit a route that arrived while hidden.
  useEffect(() => {
    const m = map.current;
    if (!active || !m || !ready) return;
    m.resize();
    if (!pendingFit.current) return;
    pendingFit.current = false;
    const r = useMapRoute.getState().route;
    const b = r ? routeBounds(r) : null;
    if (b) m.fitBounds(b, { padding: 40, maxZoom: 15, duration: 0 });
  }, [active, ready]);

  return (
    <div className={`relative min-h-[120px] flex-1 overflow-hidden r-12 border border-white/[0.07] ${className}`}>
      <div ref={box} className="absolute inset-0" />
      {mapError && <p className="absolute inset-x-2 bottom-2 r-8 bg-canvas/80 px-2 py-1 fs-11 text-alert">{mapError}</p>}
    </div>
  );
}
