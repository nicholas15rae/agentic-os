// contract.ts — DRAFT 2026-11-27 (overnight build, Maps step 3, TS side only). Needs Nic's approval to be LOCKED.
// Scope: build plan Section 5 "Maps" (docs/build-plan-sections-8-10.md), steps 3, 9, 10 and the pure part of 11.
// TYPES ONLY. Helpers live in location.ts / nav.ts / trips-store.ts / handoff-listener.ts.
//
// Mirrors (check these when the backend changes):
//   - src-tauri/src/commands/trips.rs   TripsView, Trip, TripEvent, TripEta, TripOrigin, KindWords, DeviceFix,
//                                       WeatherSpot (every struct #[serde(rename_all = "camelCase")], except
//                                       TripKind = "lowercase" and WeatherSpot = field names as written + alias "lon").
//   - src-tauri/src/commands/maps.rs    Place (= MapPlace in lib/platform.ts), Route (= MapRoute).
//   - maps_api.py (gateway)             GET /api/maps/trips, POST|GET /api/maps/refresh, POST|GET /api/maps/handoff,
//                                       POST /api/maps/handoff/{id}/ack, WS /api/maps/ws.
//
// IPC: `maps_trips`, `maps_trip_words`, `maps_trip_words_set` are registered in lib.rs but NOT yet in
// lib/platform.ts NativeCommands (that file is a hot file this session must not edit). Until that line lands,
// trips-store.ts calls them through `native<T>()` with the arg/result types below.
//
// Untrusted text: TripEvent.title / locationText / Place.label and hand-off labels come from calendar invites
// or the gateway. Display-only: rendered as React text (never HTML), never handed to an agent or a prompt.
import type { MapPlace } from "@/lib/platform";

export type { MapPlace };

// ── Rust trips.rs (Tauri `maps_trips`; also the gateway snapshot's `view`) ─────

/** trips.rs `TripKind` (#[serde(rename_all = "lowercase")]). */
export type TripKind = "audition" | "booking" | "job" | "other";

/** trips.rs `KindWords`: the editable keyword lists (whole words, case-insensitive). */
export interface KindWords {
  audition: string[];
  booking: string[];
  job: string[];
}

/** trips.rs `TripEvent`. `source` is "gcal" today; kept open so a new source never breaks parsing. */
export interface TripEvent {
  /** The calendar id, else "h:" + a hash of title and start. */
  id: string;
  title: string;
  kind: TripKind;
  startMs: number;
  endMs: number | null;
  locationText: string;
  source: string;
}

/** trips.rs `TripEta`. `trafficAware` is always false until a traffic provider is chosen (decision 39: none). */
export interface TripEta {
  durationS: number;
  distanceM: number;
  trafficAware: boolean;
  typicalDurationS: number | null;
  trafficDelayS: number | null;
  provider: string;
  computedAtMs: number;
}

/** trips.rs `Trip.place_status`. */
export type PlaceStatus = "resolved" | "virtual" | "unresolved";

/** trips.rs `Trip`. */
export interface Trip {
  event: TripEvent;
  /** The resolved place; its label is the geocoder's full address, so a wrong pin is visible. */
  place: MapPlace | null;
  placeStatus: PlaceStatus;
  eta: TripEta | null;
  leaveByMs: number | null;
  /** A Google Maps directions URL built in Rust. Only kept by the parser when it passes `isAllowedMapUrl`. */
  openInMaps: string | null;
  error: string | null;
}

/** trips.rs `TripOrigin.source`. */
export type OriginSource = "home" | "device" | "weather" | "default";

/** trips.rs `TripOrigin`. */
export interface TripOrigin {
  lat: number;
  lng: number;
  label: string;
  source: OriginSource;
}

/** trips.rs `TripsView.calendar` (`calendar::read_state`). */
export type CalendarReadState = "ok" | "no-backend" | "off" | "frozen" | "blocked" | "error";

/** trips.rs `TripsView.maps`. */
export type MapsReadState = "ok" | "idle" | "blocked" | "off" | "frozen" | "error";

/** trips.rs `TripsView`. */
export interface TripsView {
  trips: Trip[];
  origin: TripOrigin;
  horizonHours: number;
  bufferMin: number;
  fetchedAtMs: number;
  calendar: CalendarReadState;
  /** Why a part is missing (refusals, MAP_HOME not found); empty when all is well. */
  detail: string;
  maps: MapsReadState;
  trafficProvider: string | null;
}

/** trips.rs `DeviceFix` (Deserialize, camelCase). `atMs` is stamped by Rust on receipt. */
export interface DeviceFix {
  lat: number;
  lng: number;
  accuracyM: number;
  atMs?: number;
}

/** trips.rs `WeatherSpot` (no rename_all; `lng` also accepts `lon`). We always send `lng`. */
export interface WeatherSpot {
  lat: number;
  lng: number;
  label: string;
}

/** Tauri `maps_trips` arguments (Tauri maps camelCase JS keys onto the snake_case Rust parameters). */
export interface MapsTripsArgs {
  horizonHours?: number;
  bufferMin?: number;
  device?: DeviceFix;
  weather?: WeatherSpot;
  force?: boolean;
}

/** Tauri commands this feature calls (not yet in NativeCommands; see the header). */
export interface MapsTripCommands {
  maps_trips: { args: MapsTripsArgs; result: TripsView };
  maps_trip_words: { args: undefined; result: KindWords };
  maps_trip_words_set: { args: { words: KindWords }; result: KindWords };
}

// ── Gateway maps_api.py ────────────────────────────────────────────────────────

/** GET /api/maps/trips (404 {"detail": "no snapshot"} when the PC never published). */
export interface TripsSnapshotResponse {
  view: TripsView;
  receivedAtMs: number | null;
  ageS: number;
  refreshPending: boolean;
  killSwitch: boolean;
}

/** POST /api/maps/refresh → (423 while the kill switch is on). */
export interface RefreshRequestResponse {
  ok: boolean;
  pending: boolean;
  requestedAtMs: number | null;
}

/** maps_api.py NAV_MODES. */
export type NavMode = "navigate" | "pin" | "directions";

/** maps_api.py ACK_STATUSES / LIST_STATUSES. */
export type HandoffAckStatus = "opened" | "dismissed";
export type HandoffStatus = "pending" | HandoffAckStatus | "expired";

/** A stop in a hand-off (`_place`: label optional, nothing else). */
export interface HandoffStop {
  lat: number;
  lng: number;
  label?: string;
}

/** POST /api/maps/handoff body (`_validate_handoff`: these fields only). Desktop (loopback) only. */
export interface NavHandoff {
  lat: number;
  lng: number;
  label?: string;
  mode?: NavMode;
  stops?: HandoffStop[];
}

/** One queued hand-off as the gateway hands it out (`_item`). */
export interface HandoffItem {
  id: string;
  lat: number;
  lng: number;
  label: string;
  mode: NavMode;
  stops?: HandoffStop[];
  status: HandoffStatus;
  createdMs: number;
  expiresMs: number;
  from: "desktop";
}

/** GET /api/maps/handoff?status=… */
export interface HandoffListResponse {
  items: HandoffItem[];
  killSwitch: boolean;
}

/** POST /api/maps/handoff → */
export interface HandoffQueuedResponse {
  id: string;
  expiresMs: number;
  duplicate: boolean;
}

/** WS /api/maps/ws messages (the maps socket only; never the comms socket). */
export type MapsWsEvent =
  | ({ type: "nav-handoff" } & HandoffItem)
  | { type: "nav-handoff-ack"; id: string; status: HandoffAckStatus | "expired" }
  | { type: "trips"; fetchedAtMs: number; receivedAtMs: number; count: number }
  | { type: "trips-refresh"; requestedAtMs: number };

// ── Front-end helpers ──────────────────────────────────────────────────────────

/** Why a hand-off was refused by `parseHandoff` (nav.ts). */
export type HandoffReject = "not-object" | "bad-id" | "bad-coords" | "bad-mode" | "bad-status" | "bad-time" | "stale" | "bad-url" | "bad-stops" | "bad-from";

export type HandoffParse = { ok: true; item: HandoffItem } | { ok: false; reason: HandoffReject };

/** Where the trips came from: the PC's own Rust command, or the gateway snapshot (phone / PWA / fallback). */
export type TripsSource = "desktop" | "gateway";

/** trips-store load status. "empty" = the gateway has no snapshot yet (404). */
export type TripsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface TripsLoadOptions {
  force?: boolean;
  device?: DeviceFix | null;
}

/** The zustand trips store (trips-store.ts). In memory only: trips hold addresses, nothing goes to localStorage. */
export interface TripsState {
  view: TripsView | null;
  source: TripsSource | null;
  status: TripsStatus;
  error: string | null;
  /** Local clock when the last good view arrived. */
  loadedAtMs: number | null;
  /** Gateway snapshot age at load time (seconds); null on the desktop path. */
  ageS: number | null;
  refreshPending: boolean;
  killSwitch: boolean;
  load: (opts?: TripsLoadOptions) => Promise<void>;
  /** Phone: ask the PC for a fresh snapshot (POST /api/maps/refresh). Never throws. */
  requestRefresh: () => Promise<void>;
}

/** The widget's tabs. */
export type MapTab = "map" | "upcoming" | "saved";

/** RouteMap widget config (persisted per instance by the board). */
export interface RouteMapConfig extends Record<string, unknown> {
  tab?: MapTab;
}

/** How the tab bar draws at the widget's size. */
export type TabsFit = "full" | "icons";

// ── Component props ───────────────────────────────────────────────────────────

/** MapCanvas.tsx: the MapLibre map; draws the current route from the map store. */
export interface MapCanvasProps {
  className?: string;
  /**
   * False while another tab is showing. The map stays alive (pan/zoom kept, no tile re-fetch);
   * a route that arrives meanwhile is fitted when the canvas is shown again. Default true.
   */
  active?: boolean;
}

/** TripList.tsx: the Upcoming tab (next 48 h). */
export interface TripListProps {
  /** Draw this trip's route on the map, then show the Map tab. */
  onRoute: (trip: Trip, origin: TripOrigin) => void | Promise<void>;
  /** Open turn-by-turn for the trip (Google Maps). */
  onOpen: (trip: Trip) => void;
  compact?: boolean;
}

/** TripList's pure view (rendered by TripList from the trips store; tested with static markup). */
export interface TripListViewProps extends Omit<TripListProps, "onRoute"> {
  trips: Trip[];
  view: TripsView | null;
  status: TripsStatus;
  error: string | null;
  source: TripsSource | null;
  ageS: number | null;
  refreshPending: boolean;
  killSwitch: boolean;
  nowMs: number;
  /** Id of the trip whose route is being drawn. */
  routingId: string | null;
  onRoute: (trip: Trip) => void;
  onRefresh: () => void;
  /** Desktop only, explicit tap: use one browser location fix as the start point. Omitted = no button. */
  onLocate?: () => void;
}

/** One saved-route row (pure; the inline delete confirm is driven by `confirming`). */
export interface SavedRouteRowProps {
  route: import("@/lib/cc-api").SavedRoute & { id: string };
  confirming: boolean;
  busy: boolean;
  onRoute: () => void;
  onOpen: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  compact?: boolean;
}

/** SavedRoutes.tsx: the Saved tab. */
export interface SavedRoutesProps {
  /** Draw a saved route on the map, then show the Map tab. */
  onRoute: (route: import("@/lib/cc-api").SavedRoute) => void | Promise<void>;
  /** Open turn-by-turn for the saved route (Google Maps). */
  onOpen: (route: import("@/lib/cc-api").SavedRoute) => void;
  compact?: boolean;
}

/** SavedRoutes' inline "Delete? Yes / No" state (widgets/map/saved-delete.ts). One row at a time. */
export interface SavedDeleteState {
  /** The row showing "Delete? Yes / No". */
  confirmId: string | null;
  /** The row whose delete is in flight. */
  busyId: string | null;
  error: string | null;
}

/** The delete part of a SavedRouteRow's props, built by `savedDeleteHandlers`. */
export type SavedRowDeleteProps = Pick<SavedRouteRowProps, "confirming" | "busy" | "onAskDelete" | "onConfirmDelete" | "onCancelDelete">;

// ── Phone hand-off receiver (handoff-listener.ts) ───────────────────────────────

export interface HandoffListenerState {
  /** Pending, unseen, fresh hand-offs by id (newest first via `pendingHandoffs`). In memory only. */
  items: Record<string, HandoffItem>;
  /** Ids already shown/acted on (or acked elsewhere): never shown again this session. */
  seen: Record<string, true>;
  /** Returns the accepted item, or null when refused, stale, seen or a duplicate. */
  receive: (raw: unknown, nowMs?: number) => HandoffItem | null;
  /** One raw WS text frame from /api/maps/ws. Returns the newly accepted hand-off, if any. */
  receiveWs: (text: string, nowMs?: number) => HandoffItem | null;
  /** A GET /api/maps/handoff body. Returns the newly accepted items. */
  receiveList: (raw: unknown, nowMs?: number) => HandoffItem[];
  markSeen: (id: string) => void;
  /** Drops expired items. */
  prune: (nowMs?: number) => void;
  reset: () => void;
}
