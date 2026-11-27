import { useEffect, useRef, useState, type FormEvent } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { ExternalLink, Loader2, Navigation, Search, X } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import { cmd, isTauri } from "@/lib/platform";
import { listenForRoutes, useMapRoute } from "@/features/maps/map-store";
import { OPENFREEMAP_STYLE, fmtDistance, fmtDuration, pinKind, routeBounds, shortLabel } from "@/features/maps/map-geo";

const HOME: [number, number] = [-79.3832, 43.6532]; // Toronto, until a route arrives
const SRC = "route";
const PIN_COLOR = { origin: "#00e5c3", stop: "#ffd166", destination: "#ff7a2f" } as const;

export default function RouteMap() {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const { route, rev, setRoute, clear } = useMapRoute();
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(listenForRoutes, []);

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
      m.remove();
      map.current = null;
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
        .setPopup(new maplibregl.Popup({ offset: 24, closeButton: false }).setText(p.label || kind))
        .addTo(m);
      markers.current.push(mk);
    });
    const b = routeBounds(route);
    if (b) m.fitBounds(b, { padding: 40, maxZoom: 15, duration: 600 });
  }, [route, rev, ready]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!dest.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setRoute(await cmd("map_route", { destination: dest.trim() }));
    } catch (x) {
      setErr(String(x instanceof Error ? x.message : x));
    } finally {
      setBusy(false);
    }
  };

  const openInMaps = () => {
    if (!route) return;
    const d = route.waypoints[route.waypoints.length - 1];
    void cmd("map_open_in_maps", { lat: d.lat, lng: d.lng, stops: route.waypoints.slice(1, -1) }).catch((x) => setErr(String(x)));
  };

  const dst = route?.waypoints[route.waypoints.length - 1];

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title="Maps" status={route ? <span className="label-caps text-ink-3">OSM · no live traffic</span> : null} />
      {!isTauri() ? (
        <Empty>The route map runs in the desktop app.</Empty>
      ) : (
        <>
          <form onSubmit={(e) => void search(e)} className="mb-2 flex items-center gap-1.5">
            <input
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="Drive to… (address or place)"
              aria-label="Destination"
              className="well h-8 min-w-0 flex-1 rounded-full px-3 text-xs text-ink placeholder:text-ink-3 focus:outline-none"
            />
            <button type="submit" disabled={busy || !dest.trim()} className="pill-glass !h-8 text-xs" title="Route from home">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            </button>
          </form>
          <div className="relative min-h-[120px] flex-1 overflow-hidden r-12 border border-white/[0.07]">
            <div ref={box} className="absolute inset-0" />
            {mapError && <p className="absolute inset-x-2 bottom-2 r-8 bg-canvas/80 px-2 py-1 fs-11 text-alert">{mapError}</p>}
          </div>
          {route && dst && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <Navigation size={13} className="text-amber" />
              <span className="text-ink">
                <b className="font-mono tabular">{fmtDuration(route.durationS)}</b> · {fmtDistance(route.distanceM)} to {shortLabel(dst.label)}
              </span>
              <button onClick={openInMaps} className="pill-glass ml-auto !h-7 fs-11" title="Turn-by-turn in Google Maps (hand off to your phone)">
                <ExternalLink size={12} /> Open in Maps
              </button>
              <button onClick={clear} className="pill-glass !h-7 !px-2 fs-11" aria-label="Clear route" title="Clear route">
                <X size={12} />
              </button>
            </div>
          )}
          {route && <p className="mt-1 fs-10 text-ink-3">{route.note}</p>}
          {err && <p className="mt-1 fs-11 text-alert">{err}</p>}
        </>
      )}
    </div>
  );
}
