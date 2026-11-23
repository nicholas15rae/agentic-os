import { describe, expect, it } from "vitest";
import { hasPromotedTile, promotedWidgets, reworkView } from "./promoted";
import type { BuildHubView } from "./types";

const build = (id: string, runtime: string, promoted_at: number | null) =>
  ({ envelope: { build_id: id, title: `T ${id}`, target_runtime: runtime }, promoted_at }) as unknown as BuildHubView["builds"][number];

describe("promotedWidgets", () => {
  it("lists only promoted internal widgets, newest first", () => {
    const view = { builds: [build("a", "internal_widget", 10), build("b", "internal_widget", null), build("c", "external_app", 30), build("d", "internal_widget", 20)] } as BuildHubView;
    expect(promotedWidgets(view)).toEqual([
      { buildId: "d", title: "T d", promotedAt: 20 },
      { buildId: "a", title: "T a", promotedAt: 10 },
    ]);
  });
  it("is empty before the hub has loaded", () => {
    expect(promotedWidgets(null)).toEqual([]);
  });
});

describe("hasPromotedTile", () => {
  const pages = [{ items: [{ widgetId: "weather", config: {} }] }, { items: [{ widgetId: "staged-build", config: { buildId: "b-1" } }] }];
  it("finds a tile for the build on any page", () => {
    expect(hasPromotedTile(pages, "b-1")).toBe(true);
    expect(hasPromotedTile(pages, "b-2")).toBe(false);
  });
});

describe("reworkView", () => {
  const b = (status: string, progress = 0) => ({ envelope: { status }, progress }) as unknown as Parameters<typeof reworkView>[0];
  it("maps each build status to what the tile shows", () => {
    expect(reworkView(undefined)).toEqual({ kind: "live" });
    expect(reworkView(b("deployed"))).toEqual({ kind: "live" });
    expect(reworkView(b("queued"))).toEqual({ kind: "working", label: "Queued", progress: 0 });
    expect(reworkView(b("building", 40))).toEqual({ kind: "working", label: "Building", progress: 40 });
    expect(reworkView(b("smoke_testing", 90))).toEqual({ kind: "working", label: "Smoke testing", progress: 90 });
    expect(reworkView(b("ready_for_merge"))).toEqual({ kind: "ready" });
    expect(reworkView(b("repair_queue"))).toEqual({ kind: "repair" });
    expect(reworkView(b("cancelled"))).toEqual({ kind: "cancelled" });
  });
});
