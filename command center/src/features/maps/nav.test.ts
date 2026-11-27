import { describe, expect, it } from "vitest";
import { cleanText, directionsUrl, handoffUrl, HANDOFF_TTL_MS, isAllowedMapUrl, isLatLng, parseHandoff, pinUrl, relabelRoute, routeArgsForSaved, safeMapUrl, savedFromRoute, savedOriginText } from "./nav";
import { toSavedRoute } from "@/lib/cc-api";

/** U+202E RIGHT-TO-LEFT OVERRIDE, built at runtime so the source holds no raw bidi character. */
const RLO = String.fromCharCode(0x202e);
const NOW = Date.parse("2026-11-26T15:00:00-05:00");
const item = (over: Record<string, unknown> = {}) => ({
  id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  lat: 43.6426,
  lng: -79.3871,
  label: "CN Tower",
  mode: "navigate",
  status: "pending",
  createdMs: NOW - 60_000,
  expiresMs: NOW - 60_000 + HANDOFF_TTL_MS,
  from: "desktop",
  ...over,
});

describe("isLatLng", () => {
  it("accepts the edges, refuses out of range and non-numbers", () => {
    expect(isLatLng(90, -180)).toBe(true);
    expect(isLatLng(90.0001, 0)).toBe(false);
    expect(isLatLng(0, 180.5)).toBe(false);
    expect(isLatLng(NaN, 0)).toBe(false);
    expect(isLatLng("43", -79)).toBe(false);
    expect(isLatLng(Infinity, 0)).toBe(false);
  });
});

describe("directionsUrl", () => {
  it("matches the Rust open_in_maps_url shape", () => {
    expect(directionsUrl({ lat: 43.66, lng: -79.4 })).toBe("https://www.google.com/maps/dir/?api=1&destination=43.660000%2C-79.400000&travelmode=driving");
  });
  it("encodes stops with %7C and adds an origin", () => {
    const u = directionsUrl({ lat: 43.66, lng: -79.4 }, { origin: { lat: 43.7, lng: -79.5 }, stops: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }] })!;
    expect(u).toContain("&origin=43.700000%2C-79.500000");
    expect(u).toContain("&waypoints=1.000000%2C2.000000%7C3.000000%2C4.000000");
    expect(isAllowedMapUrl(u)).toBe(true);
  });
  it("refuses bad coordinates and too many stops", () => {
    expect(directionsUrl({ lat: 91, lng: 0 })).toBeNull();
    expect(directionsUrl({ lat: 1, lng: 1 }, { origin: { lat: 0, lng: 999 } })).toBeNull();
    expect(directionsUrl({ lat: 1, lng: 1 }, { stops: [{ lat: NaN, lng: 0 }] })).toBeNull();
    expect(directionsUrl({ lat: 1, lng: 1 }, { stops: Array.from({ length: 10 }, () => ({ lat: 1, lng: 1 })) })).toBeNull();
    expect(directionsUrl(null as never)).toBeNull();
  });
  it("pin URL", () => {
    expect(pinUrl({ lat: 1.5, lng: -2 })).toBe("https://www.google.com/maps/search/?api=1&query=1.500000%2C-2.000000");
    expect(pinUrl({ lat: 100, lng: 0 })).toBeNull();
  });
});

describe("isAllowedMapUrl", () => {
  it("only https Google Maps paths", () => {
    expect(isAllowedMapUrl("https://www.google.com/maps/dir/?api=1&destination=1,2")).toBe(true);
    expect(isAllowedMapUrl("https://maps.google.com/maps?q=1,2")).toBe(true);
    expect(isAllowedMapUrl("http://www.google.com/maps/dir/")).toBe(false);
    expect(isAllowedMapUrl("https://www.google.com.evil.example/maps/")).toBe(false);
    expect(isAllowedMapUrl("https://evil.example/maps/")).toBe(false);
    expect(isAllowedMapUrl("https://www.google.com/search?q=x")).toBe(false);
    expect(isAllowedMapUrl("https://user:pw@www.google.com/maps/")).toBe(false);
    expect(isAllowedMapUrl("https://www.google.com:8443/maps/")).toBe(false);
    expect(isAllowedMapUrl("javascript:alert(1)//www.google.com/maps")).toBe(false);
    expect(isAllowedMapUrl("not a url")).toBe(false);
    expect(isAllowedMapUrl(42)).toBe(false);
    expect(safeMapUrl("https://evil.example/")).toBeNull();
  });
});

describe("cleanText", () => {
  it("strips control and bidi characters and caps", () => {
    expect(cleanText(`Stage\u0007 4${RLO}  `, 50)).toBe("Stage 4");
    expect(cleanText("x".repeat(10), 5)).toBe("xxxx…");
    expect(cleanText(null, 5)).toBe("");
  });
});

describe("parseHandoff", () => {
  it("accepts a fresh pending item and builds its own link", () => {
    const p = parseHandoff(item(), NOW);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.item.label).toBe("CN Tower");
    expect(handoffUrl(p.item)).toBe("https://www.google.com/maps/dir/?api=1&destination=43.642600%2C-79.387100&travelmode=driving");
    expect(handoffUrl({ ...p.item, mode: "pin" })).toContain("/maps/search/");
  });
  it("rejects unknown modes, bad ids, bad coords, wrong sender", () => {
    expect(parseHandoff(item({ mode: "sms" }), NOW)).toEqual({ ok: false, reason: "bad-mode" });
    expect(parseHandoff(item({ id: "../x" }), NOW)).toEqual({ ok: false, reason: "bad-id" });
    expect(parseHandoff(item({ lat: 95 }), NOW)).toEqual({ ok: false, reason: "bad-coords" });
    expect(parseHandoff(item({ lng: "-79" }), NOW)).toEqual({ ok: false, reason: "bad-coords" });
    expect(parseHandoff(item({ from: "phone" }), NOW)).toEqual({ ok: false, reason: "bad-from" });
    expect(parseHandoff(item({ status: "sent" }), NOW)).toEqual({ ok: false, reason: "bad-status" });
    expect(parseHandoff([], NOW)).toEqual({ ok: false, reason: "not-object" });
    expect(parseHandoff(null, NOW)).toEqual({ ok: false, reason: "not-object" });
  });
  it("rejects non-https or foreign map URLs it carries", () => {
    expect(parseHandoff(item({ url: "http://www.google.com/maps/dir/" }), NOW)).toEqual({ ok: false, reason: "bad-url" });
    expect(parseHandoff(item({ openInMaps: "https://evil.example/maps/" }), NOW)).toEqual({ ok: false, reason: "bad-url" });
    expect(parseHandoff(item({ url: "https://www.google.com/maps/dir/?api=1" }), NOW).ok).toBe(true);
  });
  it("rejects stale items past the 30-min TTL, whatever expiresMs claims", () => {
    expect(parseHandoff(item({ expiresMs: NOW - 1 }), NOW)).toEqual({ ok: false, reason: "stale" });
    expect(parseHandoff(item({ createdMs: NOW - 40 * 60_000, expiresMs: NOW + 3_600_000 }), NOW)).toEqual({ ok: false, reason: "stale" });
    expect(parseHandoff(item({ createdMs: NOW + 10 * 60_000, expiresMs: NOW + 40 * 60_000 }), NOW)).toEqual({ ok: false, reason: "stale" });
    expect(parseHandoff(item({ createdMs: "x" }), NOW)).toEqual({ ok: false, reason: "bad-time" });
    const capped = parseHandoff(item({ createdMs: NOW - 60_000, expiresMs: NOW + 5 * 3_600_000 }), NOW);
    expect(capped.ok && capped.item.expiresMs).toBe(NOW - 60_000 + HANDOFF_TTL_MS);
  });
  it("validates stops and cleans labels", () => {
    const p = parseHandoff(item({ label: `  ${RLO}Home\u0000 `, stops: [{ lat: 1, lng: 2, label: "A" }, { lat: 3, lng: 4 }] }), NOW);
    expect(p.ok && p.item.label).toBe("Home");
    expect(p.ok && p.item.stops).toEqual([{ lat: 1, lng: 2, label: "A" }, { lat: 3, lng: 4 }]);
    expect(parseHandoff(item({ stops: [{ lat: 1 }] }), NOW)).toEqual({ ok: false, reason: "bad-stops" });
    expect(parseHandoff(item({ stops: "1,2" }), NOW)).toEqual({ ok: false, reason: "bad-stops" });
    expect(parseHandoff(item({ label: "" }), NOW).ok && parseHandoff(item({ label: "" }), NOW)).toMatchObject({ item: { label: "43.64260, -79.38710" } });
  });
});

describe("saved routes <-> map routes", () => {
  const wp = [
    { lat: 43.7, lng: -79.4, label: "Home, 1 Main St" },
    { lat: 43.65, lng: -79.38, label: "Stop" },
    { lat: 43.6426, lng: -79.3871, label: "CN Tower, 290 Bremner Blvd, Toronto" },
  ];
  it("a map route becomes a saved route the cc-api checker accepts", () => {
    const r = savedFromRoute({ waypoints: wp }, "")!;
    expect(r).toEqual({ name: "CN Tower", origin: wp[0], destination: wp[2], stops: [wp[1]] });
    expect(() => toSavedRoute(r)).not.toThrow();
    expect(savedFromRoute({ waypoints: [{ ...wp[0], label: "x".repeat(500) }, wp[2]] }, "Long")!.origin).toMatchObject({ label: expect.stringMatching(/^x{199}…$/) });
    expect(() => toSavedRoute(savedFromRoute({ waypoints: [{ ...wp[0], label: "x".repeat(500) }, wp[2]] }, "y".repeat(300))!)).not.toThrow();
    expect(savedFromRoute({ waypoints: [wp[0]] }, "x")).toBeNull();
    expect(savedFromRoute({ waypoints: [wp[0], { lat: 99, lng: 0, label: "" }] }, "x")).toBeNull();
    expect(savedFromRoute(null, "x")).toBeNull();
  });
  it("map_route args use coordinates; home leaves the origin to Rust", () => {
    const base = { name: "n", destination: wp[2], stops: [wp[1]] };
    expect(routeArgsForSaved({ ...base, origin: "home" })).toEqual({ destination: "43.642600,-79.387100", stops: ["43.650000,-79.380000"] });
    expect(routeArgsForSaved({ ...base, origin: "here" }, { lat: 1, lng: 2 })).toMatchObject({ origin: "1.000000,2.000000" });
    expect(routeArgsForSaved({ ...base, origin: "here" }, null)).not.toHaveProperty("origin");
    expect(routeArgsForSaved({ ...base, origin: wp[0] })).toMatchObject({ origin: "43.700000,-79.400000" });
    expect(routeArgsForSaved({ ...base, origin: { lat: 200, lng: 0, label: "" } })).toBeNull();
    expect(routeArgsForSaved({ ...base, origin: "home", destination: { lat: 0, lng: 500, label: "" } })).toBeNull();
  });
  it("origin wording", () => {
    expect(savedOriginText("home")).toBe("from home");
    expect(savedOriginText("here")).toBe("from your location");
    expect(savedOriginText(wp[0])).toBe("from Home");
  });
});

describe("relabelRoute", () => {
  it("replaces coordinate labels only when counts match", () => {
    const r = { waypoints: [{ lat: 1, lng: 2, label: "1.00000, 2.00000" }, { lat: 3, lng: 4, label: "3.00000, 4.00000" }] };
    expect(relabelRoute(r, ["Home", null]).waypoints.map((w) => w.label)).toEqual(["Home", "3.00000, 4.00000"]);
    expect(relabelRoute(r, ["only one"])).toBe(r);
  });
});
