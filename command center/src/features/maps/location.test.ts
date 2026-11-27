import { describe, expect, it } from "vitest";
import { getDeviceFix, latLngText, originPhrase, toDeviceFix, weatherSpot } from "./location";

const NOW = Date.parse("2026-11-26T15:00:00-05:00");
const pos = (accuracy: number, ageMs = 0, latitude = 43.65, longitude = -79.38) => ({ coords: { latitude, longitude, accuracy }, timestamp: NOW - ageMs });

describe("toDeviceFix", () => {
  it("keeps a fix under 500 m and under 30 min old", () => {
    expect(toDeviceFix(pos(35.4), NOW)).toEqual({ lat: 43.65, lng: -79.38, accuracyM: 35 });
  });
  it("never rounds a very precise fix to 0 m (Rust drops accuracy_m <= 0)", () => {
    expect(toDeviceFix(pos(0.3), NOW)?.accuracyM).toBe(1);
    expect(toDeviceFix(pos(0.5), NOW)?.accuracyM).toBe(1);
    expect(toDeviceFix(pos(1.6), NOW)?.accuracyM).toBe(2);
  });
  it("drops vague, old, out-of-range or missing fixes", () => {
    expect(toDeviceFix(pos(800), NOW)).toBeNull();
    expect(toDeviceFix(pos(0), NOW)).toBeNull();
    expect(toDeviceFix(pos(20, 31 * 60_000), NOW)).toBeNull();
    expect(toDeviceFix(pos(20, 0, 95), NOW)).toBeNull();
    expect(toDeviceFix(null, NOW)).toBeNull();
    expect(toDeviceFix({ coords: {} } as never, NOW)).toBeNull();
  });
});

describe("weatherSpot", () => {
  it("maps lon to lng and cleans the label", () => {
    expect(weatherSpot({ lat: 43.1, lon: -79.1, label: "Niagara\u0007" })).toEqual({ lat: 43.1, lng: -79.1, label: "Niagara" });
    expect(weatherSpot({ lat: 43.1, lon: 500, label: "x" })).toBeNull();
    expect(weatherSpot(null)).toBeNull();
  });
});

describe("origin wording and coordinate text", () => {
  it("says where ETAs start", () => {
    expect(originPhrase({ source: "home" })).toBe("from home");
    expect(originPhrase({ source: "device" })).toBe("from your location");
    expect(originPhrase({ source: "nope" as never })).toBe("from downtown Toronto");
    expect(originPhrase(null)).toBe("from downtown Toronto");
  });
  it("lat,lng for map_route", () => {
    expect(latLngText({ lat: 43.6, lng: -79.4 })).toBe("43.600000,-79.400000");
    expect(latLngText({ lat: 91, lng: 0 })).toBeNull();
  });
});

describe("getDeviceFix", () => {
  it("resolves null without a geolocation API (never rejects)", async () => {
    await expect(getDeviceFix(10)).resolves.toBeNull();
  });
});
