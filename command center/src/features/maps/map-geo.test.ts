import { describe, expect, it } from "vitest";
import { fmtDistance, fmtDuration, pinKind, routeBounds, shortLabel } from "./map-geo";

describe("map-geo", () => {
  it("bounds cover the line and the waypoints", () => {
    const b = routeBounds({
      geometry: {
        type: "LineString",
        coordinates: [
          [-79.38, 43.65],
          [-79.4, 43.66],
        ],
      },
      waypoints: [{ lat: 43.7, lng: -79.5, label: "Stop" }],
    });
    expect(b).toEqual([
      [-79.5, 43.65],
      [-79.38, 43.7],
    ]);
    expect(routeBounds({ geometry: { type: "LineString", coordinates: [] }, waypoints: [] })).toBeNull();
  });

  it("formats durations and distances like Tony says them", () => {
    expect(fmtDuration(20)).toBe("under a minute");
    expect(fmtDuration(754)).toBe("13 min");
    expect(fmtDuration(3900)).toBe("1 h 5 min");
    expect(fmtDistance(347)).toBe("350 m");
    expect(fmtDistance(5230)).toBe("5.2 km");
  });

  it("labels and pin kinds", () => {
    expect(shortLabel("CN Tower, 290, Bremner Boulevard, Toronto")).toBe("CN Tower");
    expect([0, 1, 2].map((i) => pinKind(i, 3))).toEqual(["origin", "stop", "destination"]);
  });
});
