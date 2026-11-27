import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ tauri: true, android: false, native: vi.fn(), gateway: vi.fn() }));

vi.mock("@/lib/platform", () => ({ isTauri: () => h.tauri, native: h.native }));
vi.mock("@/lib/gateway", () => {
  class GatewayError extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return { GatewayError, gateway: h.gateway };
});
vi.mock("@/stores/settings", () => ({
  isAndroidApp: () => h.android,
  useSettings: { getState: () => ({ weatherLocation: { lat: 43.1, lon: -79.1, label: "Niagara" } }) },
}));

import { GatewayError } from "@/lib/gateway";
import {
  ageText,
  etaNote,
  formatClock,
  formatLeaveBy,
  parseSnapshot,
  parseTrip,
  parseTripsView,
  refreshDelayMs,
  REFRESH_DESKTOP_MS,
  REFRESH_ERROR_MS,
  REFRESH_GATEWAY_MS,
  upcomingTrips,
  useTrips,
  viewProblem,
} from "./trips-store";

const TZ = { timeZone: "America/Toronto" };
// Thursday 26 Nov 2026, 15:00 Toronto (EST, after the 2026-11-01 change).
const NOW = Date.parse("2026-11-26T15:00:00-05:00");

const trip = (over: Record<string, unknown> = {}, ev: Record<string, unknown> = {}) => ({
  event: { id: "e1", title: "Audition – test", kind: "audition", startMs: NOW + 2 * 3_600_000, endMs: null, locationText: "100 Queen St W", source: "gcal", ...ev },
  place: { lat: 43.6525, lng: -79.3839, label: "100 Queen Street West, Toronto" },
  placeStatus: "resolved",
  eta: { durationS: 1500, distanceM: 12_300, trafficAware: false, typicalDurationS: null, trafficDelayS: null, provider: "osm", computedAtMs: NOW },
  leaveByMs: NOW + 80 * 60_000,
  openInMaps: "https://www.google.com/maps/dir/?api=1&destination=43.652500,-79.383900&travelmode=driving",
  error: null,
  ...over,
});
const view = (trips: unknown[] = [trip()], over: Record<string, unknown> = {}) => ({
  trips,
  origin: { lat: 43.7, lng: -79.4, label: "Home", source: "home" },
  horizonHours: 48,
  bufferMin: 15,
  fetchedAtMs: NOW,
  calendar: "ok",
  detail: "",
  maps: "ok",
  trafficProvider: null,
  ...over,
});

describe("parseTripsView / parseTrip", () => {
  it("reads the Rust camelCase shape", () => {
    const v = parseTripsView(view())!;
    expect(v.trips).toHaveLength(1);
    expect(v.trips[0].event.kind).toBe("audition");
    expect(v.trips[0].eta?.durationS).toBe(1500);
    expect(v.origin.source).toBe("home");
  });
  it("never throws on junk and returns null for a non-view", () => {
    for (const bad of [null, 1, "x", [], {}, { trips: [], origin: {}, fetchedAtMs: 1 }, { trips: "x", origin: { lat: 1, lng: 1 }, fetchedAtMs: 1 }]) {
      expect(() => parseTripsView(bad)).not.toThrow();
      expect(parseTripsView(bad)).toBeNull();
    }
  });
  it("drops one bad trip, keeps the rest", () => {
    const v = parseTripsView(view([trip(), { event: { id: 5 } }, "junk", trip({}, { id: "e2" })]))!;
    expect(v.trips.map((t) => t.event.id)).toEqual(["e1", "e2"]);
  });
  it("drops a foreign or non-https openInMaps link but keeps the trip", () => {
    expect(parseTrip(trip({ openInMaps: "http://www.google.com/maps/dir/" }))!.openInMaps).toBeNull();
    expect(parseTrip(trip({ openInMaps: "https://evil.example/maps/" }))!.openInMaps).toBeNull();
    expect(parseTrip(trip())!.openInMaps).toContain("https://www.google.com/maps/dir/");
  });
  it("resolved without a valid place becomes unresolved (no ETA, no leave-by)", () => {
    const t = parseTrip(trip({ place: { lat: 200, lng: 0, label: "x" } }))!;
    expect(t.placeStatus).toBe("unresolved");
    expect(t.eta).toBeNull();
    expect(t.leaveByMs).toBeNull();
  });
  it("unknown kinds and states fall back safely; text is cleaned", () => {
    const v = parseTripsView(view([trip({}, { kind: "party", title: `Shoot${String.fromCharCode(0x202e)}\u0000` })], { calendar: "weird", maps: 3 }))!;
    expect(v.trips[0].event.kind).toBe("other");
    expect(v.trips[0].event.title).toBe("Shoot");
    expect(v.calendar).toBe("error");
    expect(v.maps).toBe("error");
  });
  it("snapshot: unknown kill switch counts as on", () => {
    expect(parseSnapshot({ view: view(), ageS: 120, refreshPending: true, receivedAtMs: NOW })!.killSwitch).toBe(true);
    expect(parseSnapshot({ view: view(), ageS: -5, killSwitch: false })).toMatchObject({ ageS: 0, killSwitch: false, refreshPending: false });
    expect(parseSnapshot({ ageS: 1 })).toBeNull();
  });
});

describe("upcomingTrips", () => {
  it("keeps the next 48 h (plus a 30-min grace), soonest first", () => {
    const v = parseTripsView(
      view([
        trip({}, { id: "late", startMs: NOW + 47 * 3_600_000 }),
        trip({}, { id: "soon", startMs: NOW + 3_600_000 }),
        trip({}, { id: "running", startMs: NOW - 20 * 60_000 }),
        trip({}, { id: "past", startMs: NOW - 31 * 60_000 }),
        trip({}, { id: "far", startMs: NOW + 49 * 3_600_000 }),
      ]),
    );
    expect(upcomingTrips(v, NOW).map((t) => t.event.id)).toEqual(["running", "soon", "late"]);
    expect(upcomingTrips(null, NOW)).toEqual([]);
  });
});

describe("leave-by formatting", () => {
  it("clock with the day when not today (Thu 26 Nov 2026)", () => {
    expect(formatClock(NOW + 35 * 60_000, NOW, TZ)).toBe("3:35 PM");
    expect(formatClock(NOW + 24 * 3_600_000, NOW, TZ)).toBe("Tomorrow 3:00 PM");
    expect(formatClock(NOW + 48 * 3_600_000, NOW, TZ)).toBe("Sat 3:00 PM");
    expect(formatClock(NOW, NOW, { ...TZ, hour12: false })).toBe("15:00");
  });
  it("late / now / soon / later", () => {
    expect(formatLeaveBy(NOW - 5 * 60_000, NOW, TZ)).toEqual({ text: "Leave now · 5 min late", tone: "late" });
    expect(formatLeaveBy(NOW + 30_000, NOW, TZ)).toEqual({ text: "Leave now", tone: "now" });
    expect(formatLeaveBy(NOW + 25 * 60_000, NOW, TZ)).toEqual({ text: "Leave in 25 min (3:25 PM)", tone: "soon" });
    expect(formatLeaveBy(NOW + 80 * 60_000, NOW, TZ)).toEqual({ text: "Leave by 4:20 PM", tone: "later" });
    expect(formatLeaveBy(null, NOW)).toBeNull();
    expect(formatLeaveBy(NaN, NOW)).toBeNull();
  });
  it("age, problems and the no-traffic note", () => {
    expect(ageText(30)).toBe("Updated just now");
    expect(ageText(240)).toBe("Updated 4 min ago");
    expect(ageText(7200)).toBe("Updated 2 h ago");
    expect(ageText(undefined)).toBe("");
    const v = parseTripsView(view())!;
    expect(viewProblem(v)).toBeNull();
    expect(viewProblem({ ...v, calendar: "blocked", maps: "off" })).toContain("blocked");
    expect(etaNote(v)).toBe("ETAs from home · no live traffic");
  });
});

describe("refresh cadence", () => {
  it("desktop 5 min, gateway 2 min, errors back off to 10 min", () => {
    expect(refreshDelayMs("desktop", "ready")).toBe(REFRESH_DESKTOP_MS);
    expect(refreshDelayMs("gateway", "ready")).toBe(REFRESH_GATEWAY_MS);
    expect(refreshDelayMs(null, "empty")).toBe(REFRESH_GATEWAY_MS);
    expect(refreshDelayMs("desktop", "error")).toBe(REFRESH_ERROR_MS);
  });
});

describe("useTrips.load", () => {
  beforeEach(() => {
    h.tauri = true;
    h.android = false;
    h.native.mockReset();
    h.gateway.mockReset();
    useTrips.setState({ view: null, source: null, status: "idle", error: null, ageS: null, refreshPending: false, killSwitch: false });
  });

  it("desktop: calls maps_trips with the 48 h / 15 min defaults and the weather hint", async () => {
    h.native.mockResolvedValue(view());
    await useTrips.getState().load({ force: true, device: { lat: 43.6, lng: -79.4, accuracyM: 20 } });
    expect(h.native).toHaveBeenCalledWith("maps_trips", {
      horizonHours: 48,
      bufferMin: 15,
      weather: { lat: 43.1, lng: -79.1, label: "Niagara" },
      device: { lat: 43.6, lng: -79.4, accuracyM: 20 },
      force: true,
    });
    expect(h.gateway).not.toHaveBeenCalled();
    expect(useTrips.getState()).toMatchObject({ status: "ready", source: "desktop", error: null });
  });

  it("desktop answering PHONE_USE_GATEWAY falls back to the snapshot", async () => {
    h.native.mockRejectedValue("PHONE_USE_GATEWAY");
    h.gateway.mockResolvedValue({ view: view(), ageS: 300, refreshPending: false, killSwitch: false, receivedAtMs: NOW });
    await useTrips.getState().load();
    expect(h.gateway).toHaveBeenCalledWith("/api/maps/trips", expect.anything());
    expect(useTrips.getState()).toMatchObject({ status: "ready", source: "gateway", ageS: 300 });
  });

  it("phone (Android app) and PWA read the gateway, never the native command", async () => {
    h.android = true;
    h.gateway.mockResolvedValue({ view: view(), ageS: 10, refreshPending: true, killSwitch: false });
    await useTrips.getState().load();
    expect(h.native).not.toHaveBeenCalled();
    expect(useTrips.getState()).toMatchObject({ source: "gateway", refreshPending: true });
    h.android = false;
    h.tauri = false;
    await useTrips.getState().load();
    expect(h.native).not.toHaveBeenCalled();
  });

  it("404 = no snapshot yet; bad data and errors keep the last view", async () => {
    h.tauri = false;
    h.gateway.mockRejectedValueOnce(new GatewayError("404 Not Found", 404));
    await useTrips.getState().load();
    expect(useTrips.getState().status).toBe("empty");
    h.gateway.mockResolvedValueOnce({ view: view(), ageS: 0, killSwitch: false });
    await useTrips.getState().load();
    h.gateway.mockResolvedValueOnce({ view: "garbage" });
    await useTrips.getState().load();
    expect(useTrips.getState()).toMatchObject({ status: "error" });
    expect(useTrips.getState().view?.trips).toHaveLength(1);
    h.gateway.mockRejectedValueOnce(new GatewayError("Gateway unreachable"));
    await expect(useTrips.getState().load()).resolves.toBeUndefined();
    expect(useTrips.getState().error).toBe("Gateway unreachable");
  });

  it("requestRefresh: phone POSTs /api/maps/refresh; kill switch 423 is explained, never thrown", async () => {
    h.tauri = false;
    useTrips.setState({ source: "gateway" });
    h.gateway.mockResolvedValueOnce({ ok: true, pending: true, requestedAtMs: NOW });
    await useTrips.getState().requestRefresh();
    expect(h.gateway).toHaveBeenCalledWith("/api/maps/refresh", { method: "POST", body: "{}" });
    expect(useTrips.getState().refreshPending).toBe(true);
    h.gateway.mockRejectedValueOnce(new GatewayError("Locked", 423));
    await useTrips.getState().requestRefresh();
    expect(useTrips.getState().error).toContain("kill switch");
  });
});
