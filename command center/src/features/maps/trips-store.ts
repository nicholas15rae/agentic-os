// Contract: ./contract.ts (DRAFT). The trips store: the PC's own `maps_trips` on the desktop, the
// gateway snapshot on the phone (or when Rust answers PHONE_USE_GATEWAY). Parsers never throw;
// a bad trip is dropped on its own and the rest still show. In memory only (addresses).
import { useEffect } from "react";
import { create } from "zustand";
import { isTauri, native } from "@/lib/platform";
import { gateway, GatewayError } from "@/lib/gateway";
import { isAndroidApp, useSettings } from "@/stores/settings";
import type {
  CalendarReadState,
  MapsReadState,
  MapsTripsArgs,
  OriginSource,
  PlaceStatus,
  Trip,
  TripEta,
  TripEvent,
  TripKind,
  TripOrigin,
  TripsSnapshotResponse,
  TripsSource,
  TripsState,
  TripsStatus,
  TripsView,
} from "./contract";
import { weatherSpot, originPhrase } from "./location";
import { cleanText, isLatLng, safeMapUrl } from "./nav";

/** Decision 43 / 45 defaults (trips.rs HORIZON_H, BUFFER_MIN). */
export const HORIZON_H = 48;
export const BUFFER_MIN = 15;
/** trips.rs STARTED_GRACE_MS: an event that started this recently is still listed. */
export const STARTED_GRACE_MS = 30 * 60_000;
/** maps_api.py SNAPSHOT_MAX_TRIPS. */
export const MAX_TRIPS = 20;
/** Refresh cadence while the widget is on screen. Rust answers from a 2-min cache; the publisher runs every 10 min. */
export const REFRESH_DESKTOP_MS = 5 * 60_000;
export const REFRESH_GATEWAY_MS = 2 * 60_000;
export const REFRESH_ERROR_MS = 10 * 60_000;
export const PHONE_USE_GATEWAY = "PHONE_USE_GATEWAY";
const TEXT_MAX = 300;

const KINDS: readonly TripKind[] = ["audition", "booking", "job", "other"];
const PLACE_STATUSES: readonly PlaceStatus[] = ["resolved", "virtual", "unresolved"];
const ORIGINS: readonly OriginSource[] = ["home", "device", "weather", "default"];
const CAL_STATES: readonly CalendarReadState[] = ["ok", "no-backend", "off", "frozen", "blocked", "error"];
const MAPS_STATES: readonly MapsReadState[] = ["ok", "idle", "blocked", "off", "frozen", "error"];

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback);

function parseEvent(v: unknown): TripEvent | null {
  const e = obj(v);
  const start = num(e?.startMs);
  if (!e || typeof e.id !== "string" || !e.id || start === null) return null;
  return {
    id: e.id.slice(0, 200),
    title: cleanText(e.title, TEXT_MAX) || "Untitled event",
    kind: pick(e.kind, KINDS, "other"),
    startMs: start,
    endMs: num(e.endMs),
    locationText: cleanText(e.locationText, TEXT_MAX),
    source: cleanText(e.source, 20) || "gcal",
  };
}

function parseEta(v: unknown): TripEta | null {
  const e = obj(v);
  const d = num(e?.durationS);
  const m = num(e?.distanceM);
  if (!e || d === null || m === null || d < 0 || m < 0) return null;
  return {
    durationS: d,
    distanceM: m,
    trafficAware: e.trafficAware === true,
    typicalDurationS: num(e.typicalDurationS),
    trafficDelayS: num(e.trafficDelayS),
    provider: cleanText(e.provider, 40) || "osm",
    computedAtMs: num(e.computedAtMs) ?? 0,
  };
}

/** One trip, or null when its event is unusable. A bad place / ETA / link is dropped, not the trip. */
export function parseTrip(v: unknown): Trip | null {
  const t = obj(v);
  const event = parseEvent(t?.event);
  if (!t || !event) return null;
  const p = obj(t.place);
  const place = p && isLatLng(p.lat, p.lng) ? { lat: p.lat as number, lng: p.lng as number, label: cleanText(p.label, TEXT_MAX) } : null;
  let placeStatus = pick(t.placeStatus, PLACE_STATUSES, "unresolved");
  if (placeStatus === "resolved" && !place) placeStatus = "unresolved";
  return {
    event,
    place,
    placeStatus,
    eta: placeStatus === "resolved" ? parseEta(t.eta) : null,
    leaveByMs: placeStatus === "resolved" ? num(t.leaveByMs) : null,
    openInMaps: placeStatus === "resolved" ? safeMapUrl(t.openInMaps) : null,
    error: typeof t.error === "string" && t.error ? cleanText(t.error, TEXT_MAX) : null,
  };
}

function parseOrigin(v: unknown): TripOrigin | null {
  const o = obj(v);
  if (!o || !isLatLng(o.lat, o.lng)) return null;
  return { lat: o.lat as number, lng: o.lng as number, label: cleanText(o.label, TEXT_MAX), source: pick(o.source, ORIGINS, "default") };
}

/** A TripsView from Rust or the gateway, or null when it isn't one. Never throws. */
export function parseTripsView(raw: unknown): TripsView | null {
  const v = obj(raw);
  const origin = parseOrigin(v?.origin);
  const fetched = num(v?.fetchedAtMs);
  if (!v || !origin || fetched === null || !Array.isArray(v.trips)) return null;
  const trips = v.trips.slice(0, MAX_TRIPS).map(parseTrip).filter((t): t is Trip => t !== null);
  return {
    trips,
    origin,
    horizonHours: num(v.horizonHours) ?? HORIZON_H,
    bufferMin: num(v.bufferMin) ?? BUFFER_MIN,
    fetchedAtMs: fetched,
    calendar: pick(v.calendar, CAL_STATES, "error"),
    detail: cleanText(v.detail, TEXT_MAX),
    maps: pick(v.maps, MAPS_STATES, "error"),
    trafficProvider: typeof v.trafficProvider === "string" && v.trafficProvider ? cleanText(v.trafficProvider, 40) : null,
  };
}

/** GET /api/maps/trips body, or null. */
export function parseSnapshot(raw: unknown): TripsSnapshotResponse | null {
  const r = obj(raw);
  const view = parseTripsView(r?.view);
  if (!r || !view) return null;
  return {
    view,
    receivedAtMs: num(r.receivedAtMs),
    ageS: Math.max(0, num(r.ageS) ?? 0),
    refreshPending: r.refreshPending === true,
    // Unknown counts as on, the gateway's own rule.
    killSwitch: r.killSwitch !== false,
  };
}

/** Trips starting from 30 min ago to `horizonH` ahead, soonest first. */
export function upcomingTrips(view: TripsView | null, nowMs: number, horizonH = HORIZON_H): Trip[] {
  if (!view) return [];
  const end = nowMs + horizonH * 3_600_000;
  return view.trips.filter((t) => t.event.startMs >= nowMs - STARTED_GRACE_MS && t.event.startMs <= end).sort((a, b) => a.event.startMs - b.event.startMs);
}

export interface TimeFormat {
  timeZone?: string;
  hour12?: boolean;
}

/** "2:35 PM", with "Fri " in front when it isn't today (in `timeZone`). */
export function formatClock(ms: number, nowMs: number, fmt: TimeFormat = {}): string {
  const base: Intl.DateTimeFormatOptions = { timeZone: fmt.timeZone, hour12: fmt.hour12 ?? true };
  const time = new Intl.DateTimeFormat("en-US", { ...base, hour: "numeric", minute: "2-digit" }).format(ms);
  const day = (t: number) => new Intl.DateTimeFormat("en-CA", { ...base, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  if (day(ms) === day(nowMs)) return time;
  if (day(ms) === day(nowMs + 86_400_000)) return `Tomorrow ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { ...base, weekday: "short" }).format(ms)} ${time}`;
}

export type LeaveTone = "late" | "now" | "soon" | "later";

/**
 * "Leave by" wording. Over a minute past: "Leave now · 5 min late"; within a minute: "Leave now";
 * under an hour: "Leave in 25 min (2:35 PM)"; later: "Leave by 2:35 PM" (with the day when not today).
 */
export function formatLeaveBy(leaveByMs: number | null | undefined, nowMs: number, fmt: TimeFormat = {}): { text: string; tone: LeaveTone } | null {
  if (typeof leaveByMs !== "number" || !Number.isFinite(leaveByMs)) return null;
  const diff = leaveByMs - nowMs;
  const clock = formatClock(leaveByMs, nowMs, fmt);
  if (diff < -60_000) return { text: `Leave now · ${minutes(-diff)} late`, tone: "late" };
  if (diff <= 60_000) return { text: "Leave now", tone: "now" };
  if (diff < 3_600_000) return { text: `Leave in ${minutes(diff)} (${clock})`, tone: "soon" };
  return { text: `Leave by ${clock}`, tone: "later" };
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "Updated 4 min ago" from a snapshot age in seconds. */
export function ageText(ageS: number | null | undefined): string {
  if (typeof ageS !== "number" || !Number.isFinite(ageS) || ageS < 0) return "";
  if (ageS < 60) return "Updated just now";
  const m = Math.round(ageS / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `Updated ${h} h ago` : `Updated ${Math.round(h / 24)} days ago`;
}

/** Why there are no ETAs, in plain words; null when calendar and maps are fine. */
export function viewProblem(view: TripsView | null): string | null {
  if (!view) return null;
  const cal: Partial<Record<CalendarReadState, string>> = {
    "no-backend": "The calendar isn't connected.",
    off: "Calendar is switched off in Settings.",
    frozen: "Calendar reads are paused by the current mode.",
    blocked: "Calendar reads are blocked (kill switch or MCP permission).",
    error: "The calendar couldn't be read.",
  };
  const maps: Partial<Record<MapsReadState, string>> = {
    off: "Maps tools are switched off, so there are no ETAs.",
    frozen: "Map lookups are paused by the current mode.",
    blocked: "Map lookups are blocked (kill switch or MCP permission).",
    error: "Some map lookups failed.",
  };
  const parts = [cal[view.calendar], maps[view.maps]].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** "From home" etc., with the "no live traffic" note when the ETA isn't traffic-aware. */
export function etaNote(view: TripsView | null): string {
  const from = originPhrase(view?.origin);
  const traffic = view?.trafficProvider ? "" : " · no live traffic";
  return `ETAs ${from}${traffic}`;
}

/** How long until the next automatic load. */
export function refreshDelayMs(source: TripsSource | null, status: TripsStatus): number {
  if (status === "error") return REFRESH_ERROR_MS;
  return source === "desktop" ? REFRESH_DESKTOP_MS : REFRESH_GATEWAY_MS;
}

/** The desktop path is for the PC app only; the Android app and the PWA read the snapshot. */
export const desktopPath = (): boolean => isTauri() && !isAndroidApp();

const errText = (e: unknown): string => cleanText(e instanceof Error ? e.message : typeof e === "string" ? e : "Couldn't load trips", TEXT_MAX) || "Couldn't load trips";

let seq = 0;

export const useTrips = create<TripsState>((set, get) => {
  async function fromGateway(my: number): Promise<void> {
    try {
      const snap = parseSnapshot(await gateway<unknown>("/api/maps/trips", { timeoutMs: 10_000 }));
      if (my !== seq) return;
      if (!snap) return set({ status: "error", error: "The gateway sent trips this app can't read." });
      set({ view: snap.view, source: "gateway", status: "ready", error: null, loadedAtMs: Date.now(), ageS: snap.ageS, refreshPending: snap.refreshPending, killSwitch: snap.killSwitch });
    } catch (e) {
      if (my !== seq) return;
      if (e instanceof GatewayError && e.status === 404) return set({ status: "empty", error: null, source: "gateway", view: null, ageS: null });
      set({ status: "error", error: errText(e), source: "gateway" });
    }
  }

  return {
    view: null,
    source: null,
    status: "idle",
    error: null,
    loadedAtMs: null,
    ageS: null,
    refreshPending: false,
    killSwitch: false,
    load: async (opts = {}) => {
      const my = ++seq;
      set({ status: get().view ? get().status : "loading" });
      if (!desktopPath()) return fromGateway(my);
      const args: MapsTripsArgs = { horizonHours: HORIZON_H, bufferMin: BUFFER_MIN };
      const w = weatherSpot(useSettings.getState().weatherLocation);
      if (w) args.weather = w;
      if (opts.device) args.device = opts.device;
      if (opts.force) args.force = true;
      try {
        const view = parseTripsView(await native<unknown>("maps_trips", args as Record<string, unknown>));
        if (my !== seq) return;
        if (!view) return set({ status: "error", error: "The desktop sent trips this app can't read." });
        set({ view, source: "desktop", status: "ready", error: null, loadedAtMs: Date.now(), ageS: null, refreshPending: false, killSwitch: false });
      } catch (e) {
        if (my !== seq) return;
        if (errText(e).includes(PHONE_USE_GATEWAY)) return fromGateway(my);
        set({ status: "error", error: errText(e), source: "desktop" });
      }
    },
    requestRefresh: async () => {
      if (get().source === "desktop") return get().load({ force: true });
      try {
        const r = await gateway<{ pending?: unknown }>("/api/maps/refresh", { method: "POST", body: "{}" });
        set({ refreshPending: r?.pending === true, error: null });
      } catch (e) {
        set({ error: e instanceof GatewayError && e.status === 423 ? "The kill switch is on, so the PC can't be asked for new trips." : errText(e) });
      }
    },
  };
});

/** Load now, then on the cadence above while `active` (the widget is on screen). */
export function useTripsAutoRefresh(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async () => {
      await useTrips.getState().load();
      if (!alive) return;
      const { source, status } = useTrips.getState();
      timer = setTimeout(() => void tick(), refreshDelayMs(source, status));
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
}
