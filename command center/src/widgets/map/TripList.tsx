import { useState } from "react";
import { ExternalLink, Loader2, LocateFixed, RefreshCw, Route as RouteIcon } from "lucide-react";
import { useNow } from "@/lib/cc-api";
import { fmtDistance, fmtDuration } from "@/features/maps/map-geo";
import { getDeviceFix } from "@/features/maps/location";
import { ageText, desktopPath, etaNote, formatClock, formatLeaveBy, upcomingTrips, useTrips, useTripsAutoRefresh, viewProblem, type LeaveTone } from "@/features/maps/trips-store";
import type { Trip, TripKind, TripListProps, TripListViewProps } from "@/features/maps/contract";

// Contract: features/maps/contract.ts (DRAFT). The Upcoming tab: the next 48 h of trips.
// Event titles and locations are untrusted calendar text: rendered as React text only.

const KIND_LABEL: Record<TripKind, string> = { audition: "Audition", booking: "Booking", job: "Job", other: "Event" };
const LEAVE_TONE: Record<LeaveTone, string> = { late: "text-alert", now: "text-amber", soon: "text-amber-light", later: "text-ink-2" };

function where(t: Trip): string {
  if (t.placeStatus === "virtual") return "Virtual meeting, no travel";
  if (t.placeStatus === "unresolved") return t.event.locationText ? `Address not found: ${t.event.locationText}` : "Address not found";
  return t.place?.label || t.event.locationText;
}

function TripRow({ t, nowMs, compact, routing, onRoute, onOpen }: { t: Trip; nowMs: number; compact?: boolean; routing: boolean; onRoute: () => void; onOpen: () => void }) {
  const leave = formatLeaveBy(t.leaveByMs, nowMs);
  const routable = t.placeStatus === "resolved" && !!t.place;
  return (
    <li className="r-12 border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="label-caps shrink-0 text-ink-3">{KIND_LABEL[t.event.kind]}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={t.event.title}>
          {t.event.title}
        </span>
        <span className="shrink-0 font-mono fs-11 tabular text-ink-2">{formatClock(t.event.startMs, nowMs)}</span>
      </div>
      {!compact && <p className="mt-0.5 truncate fs-11 text-ink-3" title={where(t)}>{where(t)}</p>}
      {routable && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 fs-11">
          {leave && <b className={`font-medium ${LEAVE_TONE[leave.tone]}`}>{leave.text}</b>}
          {t.eta && (
            <span className="text-ink-2">
              <span className="font-mono tabular">{fmtDuration(t.eta.durationS)}</span> · {fmtDistance(t.eta.distanceM)}
              {!t.eta.trafficAware && <span className="label-caps ml-1.5 text-ink-3">baseline</span>}
            </span>
          )}
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={onRoute} disabled={routing} className="pill-glass !h-7 !px-2 fs-11" title="Draw this trip on the map">
              {routing ? <Loader2 size={12} className="animate-spin" /> : <RouteIcon size={12} />} Route
            </button>
            <button type="button" onClick={onOpen} className="pill-glass !h-7 !px-2 fs-11" aria-label="Open in Maps" title="Turn-by-turn in Google Maps">
              <ExternalLink size={12} />
            </button>
          </span>
        </div>
      )}
      {t.error && <p className="mt-0.5 fs-10 text-ink-3">{t.error}</p>}
    </li>
  );
}

/** Pure view (tests render it to static markup). */
export function TripListView(p: TripListViewProps) {
  const problem = viewProblem(p.view);
  const age = p.source === "gateway" ? ageText(p.ageS) : "";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1.5 fs-11 text-ink-3">
        <span className="min-w-0 flex-1 truncate">{age || etaNote(p.view)}</span>
        {p.refreshPending && <span className="label-caps shrink-0 text-teal-soft">Asked the PC</span>}
        {p.onLocate && p.view && p.view.origin.source !== "home" && (
          <button type="button" onClick={p.onLocate} className="pill-glass !h-7 !px-2 fs-11" aria-label="Use my location" title="Start ETAs from this device's location (one fix, under 500 m accuracy)">
            <LocateFixed size={12} />
          </button>
        )}
        <button type="button" onClick={p.onRefresh} className="pill-glass !h-7 !px-2 fs-11" aria-label="Refresh trips" title={p.source === "gateway" ? "Ask the PC for fresh trips" : "Refresh trips"}>
          {p.status === "loading" ? <Loader2 size={12} className="animate-spin text-teal" /> : <RefreshCw size={12} className="text-teal" />}
        </button>
      </div>
      {p.killSwitch && <p className="fs-11 text-alert">The kill switch is on: trips may be out of date.</p>}
      {problem && <p className="fs-11 text-amber-light">{problem}</p>}
      {p.error && <p className="fs-11 text-alert">{p.error}</p>}
      {p.status === "loading" && !p.view ? (
        <p className="text-xs text-ink-3">Loading trips…</p>
      ) : p.status === "empty" ? (
        <p className="text-xs text-ink-3">No trips from the PC yet. The desktop app publishes them about every 10 minutes while it runs.</p>
      ) : p.view && !p.trips.length ? (
        <p className="text-xs text-ink-3">No timed events with a street address in the next {p.view.horizonHours} h.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5" aria-label="Upcoming trips">
          {p.trips.map((t) => (
            <TripRow key={t.event.id} t={t} nowMs={p.nowMs} compact={p.compact} routing={p.routingId === t.event.id} onRoute={() => p.onRoute(t)} onOpen={() => p.onOpen(t)} />
          ))}
        </ul>
      )}
      <p className="fs-10 text-ink-3">ETAs have no live traffic (OpenStreetMap baseline). Google Maps shows traffic once you open a trip.</p>
    </div>
  );
}

export default function TripList({ onRoute, onOpen, compact }: TripListProps) {
  const s = useTrips();
  const nowMs = useNow(30_000);
  const [routingId, setRoutingId] = useState<string | null>(null);
  useTripsAutoRefresh(true);
  const trips = upcomingTrips(s.view, nowMs, s.view?.horizonHours);
  const locate = async () => {
    const device = await getDeviceFix();
    if (device) await s.load({ force: true, device });
    else useTrips.setState({ error: "No usable location (denied, unavailable or less accurate than 500 m). ETAs stay from the current start point." });
  };
  return (
    <TripListView
      trips={trips}
      view={s.view}
      status={s.status}
      error={s.error}
      source={s.source}
      ageS={s.ageS}
      refreshPending={s.refreshPending}
      killSwitch={s.killSwitch}
      nowMs={nowMs}
      routingId={routingId}
      compact={compact}
      onRefresh={() => void s.requestRefresh()}
      onLocate={desktopPath() ? () => void locate() : undefined}
      onOpen={onOpen}
      onRoute={(t) => {
        if (!s.view || routingId) return;
        setRoutingId(t.event.id);
        Promise.resolve(onRoute(t, s.view.origin)).finally(() => setRoutingId(null));
      }}
    />
  );
}
