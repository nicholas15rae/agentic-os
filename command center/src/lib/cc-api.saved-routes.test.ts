import { beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.fn();
vi.mock("@/lib/gateway", () => ({ gateway: (...a: unknown[]) => gateway(...a), GatewayError: class extends Error {}, authHeader: () => ({}) }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false,
  useSettings: Object.assign(() => "", { getState: () => ({ gatewayUrl: "http://127.0.0.1:8080" }) }),
}));

import {
  cc,
  collections,
  isPrivateCollection,
  PRIVATE_COLLECTIONS,
  ROUTE_STOPS_MAX,
  SavedRouteError,
  savedRoutes,
  sortSavedRoutes,
  toSavedRoute,
  toSavedRoutePatch,
  type SavedRoute,
} from "./cc-api";

const STUDIO = { lat: 43.6426, lng: -79.3871, label: "Test studio" };
const STOP = { lat: 43.66, lng: -79.39, label: "Coffee" };
const route = (over: Partial<SavedRoute> = {}): SavedRoute => ({ name: "To the studio", origin: "home", destination: STUDIO, stops: [STOP], ...over });
const saved = (r: SavedRoute, id: string, created: number) => ({ ...r, id, _created: created, _updated: created, _deleted: false });

describe("saved routes: shape checks (mirror the gateway's _check_route)", () => {
  it("normalises text and keeps here / home for use time", () => {
    expect(toSavedRoute(route({ name: "  Home ‮to​  set\n", origin: "here" }))).toEqual({
      name: "Home to set",
      origin: "here",
      destination: STUDIO,
      stops: [STOP],
    });
    expect(toSavedRoute(route({ origin: { lat: 43, lng: -79, label: "Here\u0000now" } })).origin).toEqual({ lat: 43, lng: -79, label: "Here now" });
    expect(toSavedRoute({ name: "x", origin: "home", destination: STUDIO } as SavedRoute).stops).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["no name", route({ name: "  " })],
    ["unknown origin", route({ origin: "work" as never })],
    ["lat out of range", route({ destination: { ...STUDIO, lat: 91 } })],
    ["lat NaN", route({ destination: { ...STUDIO, lat: Number.NaN } })],
    ["lng infinite", route({ destination: { ...STUDIO, lng: Number.POSITIVE_INFINITY } })],
    ["lat as text", route({ destination: { ...STUDIO, lat: "43.6" as never } })],
    ["extra place field", route({ destination: { ...STUDIO, address: "x" } as never })],
    ["too many stops", route({ stops: Array(ROUTE_STOPS_MAX + 1).fill(STOP) })],
    ["pinned not bool", route({ pinned: "yes" as never })],
    ["unknown field", { ...route(), notes: "free text" }],
  ])("refuses %s", (_what, r) => {
    expect(() => toSavedRoute(r as SavedRoute)).toThrow(SavedRouteError);
  });

  it("checks only the fields a patch carries", () => {
    expect(toSavedRoutePatch({ pinned: true })).toEqual({ pinned: true });
    expect(toSavedRoutePatch({ name: " Renamed " })).toEqual({ name: "Renamed" });
    expect(() => toSavedRoutePatch({ name: "" })).toThrow(SavedRouteError);
    expect(() => toSavedRoutePatch({ destination: { lat: 0, lng: 200, label: "" } })).toThrow(SavedRouteError);
    expect(() => toSavedRoutePatch({ stray: 1 } as never)).toThrow(SavedRouteError);
  });
});

describe("saved routes: client functions", () => {
  beforeEach(() => gateway.mockReset());

  it("save posts the normalised route to the routes collection", async () => {
    gateway.mockImplementation(async (_url: string, init?: RequestInit) => ({ ...JSON.parse(String(init?.body ?? "{}")), id: "r1", _created: 1, _updated: 1 }));
    const got = await savedRoutes.save(route({ name: " To  the studio " }));
    expect(gateway.mock.calls.map((c) => c[0])).toEqual(["/api/cc/c/routes"]);
    const [url, init] = gateway.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cc/c/routes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "To the studio", origin: "home", destination: STUDIO, stops: [STOP] });
    expect(got.id).toBe("r1");
    expect(savedRoutes.snapshot().map((r) => r.id)).toContain("r1");
  });

  it("a bad route never reaches the gateway", async () => {
    await expect(savedRoutes.save(route({ destination: { ...STUDIO, lat: 120 } }))).rejects.toBeInstanceOf(SavedRouteError);
    await expect(savedRoutes.update("r1", { origin: "office" as never })).rejects.toBeInstanceOf(SavedRouteError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it("update patches only the given fields", async () => {
    gateway.mockResolvedValue(saved(route({ pinned: true }), "r1", 1));
    await savedRoutes.update("r1", { pinned: true });
    const [url, init] = gateway.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cc/c/routes/r1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ pinned: true });
  });

  it("remove deletes on the gateway and drops it from the synced snapshot", async () => {
    gateway.mockResolvedValueOnce(saved(route(), "r2", 2));
    await savedRoutes.save(route());
    gateway.mockResolvedValueOnce({ ok: true });
    await savedRoutes.remove("r2");
    expect(gateway.mock.calls[1][0]).toBe("/api/cc/c/routes/r2");
    expect((gateway.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
    expect(collections.snapshot("routes").map((r) => r.id)).not.toContain("r2");
  });

  it("list leaves deleted rows out and puts pinned routes first, then newest", async () => {
    gateway.mockResolvedValue({
      items: [saved(route({ name: "old" }), "a", 1), saved(route({ name: "pinned", pinned: true }), "b", 0), saved(route({ name: "new" }), "c", 5), { ...saved(route(), "d", 9), _deleted: true }],
      now: 10,
    });
    expect((await savedRoutes.list()).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(String(gateway.mock.calls[0][0])).toBe("/api/cc/c/routes?since=0");
    expect(sortSavedRoutes([])).toEqual([]);
  });
});

describe("saved routes stay out of agent context", () => {
  beforeEach(() => gateway.mockReset());

  it("routes is the private collection list", () => {
    expect([...PRIVATE_COLLECTIONS]).toEqual(["routes"]);
    expect(isPrivateCollection("routes")).toBe(true);
    expect(isPrivateCollection("notes")).toBe(false);
  });

  it("agentSearch drops route hits an older gateway might return", async () => {
    const hit = (collection: string) => ({ score: 1, collection, id: collection, snippet: "", item: null });
    gateway.mockResolvedValue({ mode: "lexical", results: ["routes", "notes", "receipts"].map(hit) });
    const res = await cc.agentSearch("studio", 5);
    expect(res.results.map((r) => r.collection)).toEqual(["notes"]);
  });
});
