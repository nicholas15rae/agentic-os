import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Bookmark, BookmarkPlus, CalendarClock, ExternalLink, Loader2, Map as MapIcon, Navigation, Search, X } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import type { WidgetProps } from "@/core/widgets/types";
import { cmd, isTauri, type MapPlace, type MapRoute } from "@/lib/platform";
import { savedRoutes, type SavedRoute } from "@/lib/cc-api";
import { isAndroidApp } from "@/stores/settings";
import { listenForRoutes, useMapRoute } from "@/features/maps/map-store";
import { fmtDistance, fmtDuration, shortLabel } from "@/features/maps/map-geo";
import { getDeviceFix, latLngText } from "@/features/maps/location";
import { directionsUrl, routeArgsForSaved, safeMapUrl, savedFromRoute } from "@/features/maps/nav";
import type { MapTab, RouteMapConfig, Trip, TripOrigin } from "@/features/maps/contract";
import TripList from "./TripList";
import SavedRoutes from "./SavedRoutes";
import { isCompact, resolveTab, tabsFit } from "./tabs";

// Contract: features/maps/contract.ts (DRAFT). Maps widget: Map / Upcoming / Saved tabs.
// The MapLibre canvas is its own chunk. It mounts on the first visit to the Map tab (phone: list
// first), then stays mounted but hidden on the other tabs, so pan/zoom survive and tiles aren't re-fetched.
const MapCanvas = lazy(() => import("./MapCanvas"));

const TABS: { id: MapTab; label: string; icon: typeof MapIcon }[] = [
  { id: "map", label: "Map", icon: MapIcon },
  { id: "upcoming", label: "Upcoming", icon: CalendarClock },
  { id: "saved", label: "Saved", icon: Bookmark },
];

const msg = (x: unknown) => String(x instanceof Error ? x.message : x);

/** Hand turn-by-turn to Google Maps: the Rust command (URL built from coordinates), else an allow-listed https link. */
async function openDirections(dest: MapPlace, stops: MapPlace[] = [], fallbackUrl?: string | null): Promise<void> {
  try {
    await cmd("map_open_in_maps", { lat: dest.lat, lng: dest.lng, stops });
  } catch (x) {
    const url = safeMapUrl(fallbackUrl) ?? directionsUrl(dest, { stops });
    if (!url) throw x;
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function SaveRoute({ route, onDone }: { route: MapRoute; onDone: (note: string | null) => void }) {
  const [name, setName] = useState(() => shortLabel(route.waypoints[route.waypoints.length - 1]?.label ?? "").slice(0, 80));
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = savedFromRoute(route, name);
    if (!r || busy) return onDone(r ? null : "This route can't be saved.");
    setBusy(true);
    try {
      await savedRoutes.save(r);
      onDone(`Saved "${r.name}".`);
    } catch (x) {
      onDone(`Couldn't save: ${msg(x)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} className="mt-1.5 flex items-center gap-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder="Name this route"
        aria-label="Route name"
        autoFocus
        className="well h-7 min-w-0 flex-1 rounded-full px-3 text-[11px] text-ink placeholder:text-ink-3 focus:outline-none"
      />
      <button type="submit" disabled={busy || !name.trim()} className="pill-glass !h-7 text-[11px] text-amber">
        {busy ? <Loader2 size={12} className="animate-spin" /> : "Save"}
      </button>
      <button type="button" onClick={() => onDone(null)} className="pill-glass !h-7 !px-2 text-[11px]" aria-label="Cancel saving">
        <X size={12} />
      </button>
    </form>
  );
}

export default function RouteMap({ config, setConfig, size }: WidgetProps<RouteMapConfig>) {
  const { route, rev, setOwnRoute, clear } = useMapRoute();
  const [tab, setTabState] = useState<MapTab>(() => resolveTab(config?.tab, isAndroidApp()));
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mapSeen, setMapSeen] = useState(tab === "map");
  if (tab === "map" && !mapSeen) setMapSeen(true);
  const firstRev = useRef(rev);
  const fit = tabsFit(size);
  const compact = isCompact(size);

  useEffect(listenForRoutes, []);

  const setTab = (t: MapTab) => {
    setTabState(t);
    if (config?.tab !== t) setConfig({ tab: t });
  };

  // A new route (Tony's maps.route, a trip, a saved route) shows itself on the map.
  useEffect(() => {
    if (rev !== firstRev.current) setTabState("map");
  }, [rev]);

  useEffect(() => setSaving(false), [rev]);

  const run = async (f: () => Promise<void>) => {
    setErr(null);
    setNote(null);
    try {
      await f();
    } catch (x) {
      setErr(msg(x));
    }
  };

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!dest.trim() || busy) return;
    setBusy(true);
    await run(async () => setOwnRoute(await cmd("map_route", { destination: dest.trim() })));
    setBusy(false);
  };

  const openInMaps = () => {
    if (!route) return;
    const d = route.waypoints[route.waypoints.length - 1];
    if (d) void run(() => openDirections(d, route.waypoints.slice(1, -1), route.openInMaps));
  };

  const routeTrip = (t: Trip, origin: TripOrigin) =>
    run(async () => {
      const destination = latLngText(t.place);
      if (!destination || !t.place) throw new Error("This trip has no resolved address to route to.");
      const o = latLngText(origin);
      const r = await cmd("map_route", o ? { destination, origin: o } : { destination });
      setOwnRoute(r, [origin.label, t.place.label]);
      setTab("map");
    });

  const openTrip = (t: Trip) => {
    if (t.place) void run(() => openDirections(t.place as MapPlace, [], t.openInMaps));
  };

  const routeSaved = (s: SavedRoute) =>
    run(async () => {
      const here = s.origin === "here" ? await getDeviceFix() : null;
      const args = routeArgsForSaved(s, here);
      if (!args) throw new Error("This saved route has a point that is off the map.");
      const r = await cmd("map_route", args);
      const originLabel = typeof s.origin === "object" ? s.origin.label : null;
      setOwnRoute(r, [originLabel, ...s.stops.map((p) => p.label), s.destination.label]);
      if (s.origin === "here" && !here) setNote("No usable location fix, so this starts from home.");
      setTab("map");
    });

  const openSaved = (s: SavedRoute) => void run(() => openDirections(s.destination, s.stops));

  const dst = route?.waypoints[route.waypoints.length - 1];

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title="Maps" status={tab === "map" && route ? <span className="label-caps text-ink-3">OSM · no live traffic</span> : null} />
      {!isTauri() ? (
        <Empty>The route map runs in the desktop app.</Empty>
      ) : (
        <>
          <div role="tablist" aria-label="Maps views" className="well mb-2 flex w-fit max-w-full gap-0.5 rounded-full p-0.5">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-label={fit === "icons" ? label : undefined}
                title={label}
                onClick={() => setTab(id)}
                className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors ${tab === id ? "border border-white/10 bg-raised text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                <Icon size={12} />
                {fit === "full" && label}
              </button>
            ))}
          </div>

          {tab === "map" && (
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
          )}
          {mapSeen && (
            <div data-map-canvas="" className={tab === "map" ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-hidden={tab !== "map" || undefined}>
              <Suspense fallback={<div className="min-h-[120px] flex-1 rounded-[12px] border border-white/[0.07]" />}>
                <MapCanvas active={tab === "map"} />
              </Suspense>
            </div>
          )}
          {tab === "map" && (
            <>
              {route && dst && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <Navigation size={13} className="text-amber" />
                  <span className="min-w-0 text-ink">
                    <b className="font-mono tabular">{fmtDuration(route.durationS)}</b> · {fmtDistance(route.distanceM)} to {shortLabel(dst.label)}
                  </span>
                  <button onClick={openInMaps} className="pill-glass ml-auto !h-7 text-[11px]" title="Turn-by-turn in Google Maps (hand off to your phone)">
                    <ExternalLink size={12} /> {fit === "full" && "Open in Maps"}
                  </button>
                  <button onClick={() => setSaving((v) => !v)} className="pill-glass !h-7 !px-2 text-[11px]" aria-label="Save route" title="Save this route">
                    <BookmarkPlus size={12} />
                  </button>
                  <button onClick={clear} className="pill-glass !h-7 !px-2 text-[11px]" aria-label="Clear route" title="Clear route">
                    <X size={12} />
                  </button>
                </div>
              )}
              {route && saving && (
                <SaveRoute
                  route={route}
                  onDone={(n) => {
                    setSaving(false);
                    setNote(n);
                  }}
                />
              )}
              {route && <p className="mt-1 text-[10px] text-ink-3">{route.note}</p>}
            </>
          )}
          {tab === "upcoming" && <TripList onRoute={routeTrip} onOpen={openTrip} compact={compact} />}
          {tab === "saved" && <SavedRoutes onRoute={routeSaved} onOpen={openSaved} compact={compact} />}
          {note && <p className="mt-1 text-[11px] text-teal-soft">{note}</p>}
          {err && <p className="mt-1 text-[11px] text-alert">{err}</p>}
        </>
      )}
    </div>
  );
}
