import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ tauri: false }));
vi.mock("@/lib/platform", () => ({ isTauri: () => h.tauri, native: vi.fn(), cmd: vi.fn(), onNativeEvent: vi.fn() }));
vi.mock("@/lib/gateway", () => ({ gateway: vi.fn(), GatewayError: class extends Error {}, authHeader: () => ({}) }));
vi.mock("@/stores/settings", () => ({
  isAndroidApp: () => false,
  useSettings: Object.assign(() => ({}), { getState: () => ({ weatherLocation: null, gatewayUrl: "http://127.0.0.1:8080", gatewayToken: "" }) }),
}));
// The Saved tab's live collection hook has no server snapshot; static markup gets a fixed list.
vi.mock("@/lib/cc-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cc-api")>()),
  useSavedRoutes: () => ({ items: [], loaded: true, error: null, remove: vi.fn() }),
}));

import RouteMap from "./RouteMap";
import { TripListView } from "./TripList";
import { SavedRouteRow } from "./SavedRoutes";
import { SAVED_DELETE_IDLE, savedDeleteHandlers } from "./saved-delete";
import type { SavedDeleteState } from "@/features/maps/contract";
import { formatLeaveBy, parseTripsView, upcomingTrips } from "@/features/maps/trips-store";
import type { TripListViewProps } from "@/features/maps/contract";

const NOW = Date.parse("2026-11-26T15:00:00-05:00");
const raw = {
  trips: [
    {
      event: { id: "e1", title: "<b>Audition</b> – test", kind: "audition", startMs: NOW + 2 * 3_600_000, endMs: null, locationText: "100 Queen St W", source: "gcal" },
      place: { lat: 43.6525, lng: -79.3839, label: "100 Queen Street West, Toronto" },
      placeStatus: "resolved",
      eta: { durationS: 1500, distanceM: 12_300, trafficAware: false, typicalDurationS: null, trafficDelayS: null, provider: "osm", computedAtMs: NOW },
      leaveByMs: NOW + 80 * 60_000,
      openInMaps: null,
      error: null,
    },
    {
      event: { id: "e2", title: "Zoom callback", kind: "audition", startMs: NOW + 3 * 3_600_000, endMs: null, locationText: "https://zoom.us/j/1", source: "gcal" },
      place: null,
      placeStatus: "virtual",
      eta: null,
      leaveByMs: null,
      openInMaps: null,
      error: null,
    },
  ],
  origin: { lat: 43.7, lng: -79.4, label: "Home", source: "home" },
  horizonHours: 48,
  bufferMin: 15,
  fetchedAtMs: NOW,
  calendar: "ok",
  detail: "",
  maps: "ok",
  trafficProvider: null,
};
const view = parseTripsView(raw)!;
const props = (over: Partial<TripListViewProps> = {}): TripListViewProps => ({
  trips: upcomingTrips(view, NOW),
  view,
  status: "ready",
  error: null,
  source: "desktop",
  ageS: null,
  refreshPending: false,
  killSwitch: false,
  nowMs: NOW,
  routingId: null,
  onRoute: vi.fn(),
  onOpen: vi.fn(),
  onRefresh: vi.fn(),
  ...over,
});
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("RouteMap", () => {
  it("still shows the desktop-app Empty state outside Tauri", () => {
    h.tauri = false;
    const html = renderToStaticMarkup(<RouteMap instanceId="m" config={{}} setConfig={vi.fn()} size={{ w: 4, h: 3 }} />);
    expect(html).toContain("The route map runs in the desktop app.");
    expect(html).not.toContain('role="tablist"');
  });
  it("in the app: three tabs, labels at 4 wide, icons only at 3 wide", () => {
    h.tauri = true;
    const wide = renderToStaticMarkup(<RouteMap instanceId="m" config={{ tab: "map" }} setConfig={vi.fn()} size={{ w: 4, h: 3 }} />);
    expect(count(wide, 'role="tab"')).toBe(3);
    expect(wide).toContain(">Upcoming<");
    expect(wide).toMatch(/aria-selected="true"[^>]*title="Map"/);
    expect(wide).toContain('aria-label="Destination"');
    const narrow = renderToStaticMarkup(<RouteMap instanceId="m" config={{ tab: "map" }} setConfig={vi.fn()} size={{ w: 3, h: 3 }} />);
    expect(narrow).not.toContain(">Upcoming<");
    expect(narrow).toContain('aria-label="Upcoming"');
  });
  it("mounts the map canvas lazily: not on a first visit to another tab", () => {
    h.tauri = true;
    const onMap = renderToStaticMarkup(<RouteMap instanceId="m" config={{ tab: "map" }} setConfig={vi.fn()} size={{ w: 4, h: 3 }} />);
    expect(onMap).toContain("data-map-canvas");
    expect(onMap).not.toMatch(/data-map-canvas=""[^>]*class="hidden"/);
    const onSaved = renderToStaticMarkup(<RouteMap instanceId="m" config={{ tab: "saved" }} setConfig={vi.fn()} size={{ w: 4, h: 3 }} />);
    expect(onSaved).not.toContain("data-map-canvas");
    expect(onSaved).not.toContain('aria-label="Destination"');
  });
});

describe("TripListView", () => {
  it("lists trips with leave-by, ETA, the baseline badge and the no-traffic note", () => {
    const html = renderToStaticMarkup(<TripListView {...props()} />);
    expect(count(html, "<li")).toBe(2);
    // Zone-independent: TripRow formats in the machine's zone (4:20 PM in Toronto, 9:20 PM in UTC).
    const leave = formatLeaveBy(view.trips[0].leaveByMs, NOW)!.text;
    expect(leave).toMatch(/^Leave by (Tomorrow )?\d{1,2}:20 [AP]M$/);
    expect(html).toContain(leave);
    expect(html).toContain("25 min");
    expect(html).toContain("12.3 km");
    expect(html).toContain("baseline");
    expect(html).toContain("ETAs have no live traffic");
    expect(html).toContain("Virtual meeting, no travel");
    // Only the resolved trip can be routed.
    expect(count(html, "Draw this trip on the map")).toBe(1);
  });
  it("renders calendar text as text, never HTML", () => {
    const html = renderToStaticMarkup(<TripListView {...props()} />);
    expect(html).not.toContain("<b>Audition</b>");
    expect(html).toContain("&lt;b&gt;Audition&lt;/b&gt;");
  });
  it("empty, loading, gateway age and kill switch states", () => {
    expect(renderToStaticMarkup(<TripListView {...props({ status: "empty", view: null, trips: [] })} />)).toContain("No trips from the PC yet");
    expect(renderToStaticMarkup(<TripListView {...props({ status: "loading", view: null, trips: [] })} />)).toContain("Loading trips");
    expect(renderToStaticMarkup(<TripListView {...props({ trips: [] })} />)).toContain("in the next 48 h");
    const phone = renderToStaticMarkup(<TripListView {...props({ source: "gateway", ageS: 300, killSwitch: true, refreshPending: true })} />);
    expect(phone).toContain("Updated 5 min ago");
    expect(phone).toContain("kill switch is on");
    expect(phone).toContain("Asked the PC");
  });
});

describe("SavedRouteRow", () => {
  const route = { id: "r1", name: "Studio", origin: "home" as const, destination: { lat: 43.6, lng: -79.4, label: "Studio, 1 King St" }, stops: [] };
  const fns = { onRoute: vi.fn(), onOpen: vi.fn(), onAskDelete: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() };
  it("shows Route / Open / Delete, and only Delete? Yes / No while confirming", () => {
    const idle = renderToStaticMarkup(<SavedRouteRow route={route} confirming={false} busy={false} {...fns} />);
    expect(idle).toContain("Delete Studio");
    expect(idle).not.toContain("Delete?");
    expect(idle).toContain("to Studio from home");
    const asking = renderToStaticMarkup(<SavedRouteRow route={route} confirming busy={false} {...fns} />);
    expect(asking).toContain("Delete?");
    expect(asking).toContain(">Yes<");
    expect(asking).toContain(">No<");
    expect(asking).not.toContain("Delete Studio");
  });
});

/** Every <button> element in a pure component's returned tree (no DOM needed). */
function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; "aria-label"?: string; children?: ReactNode }>[] {
  const out: ReactElement<{ onClick?: () => void; "aria-label"?: string; children?: ReactNode }>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (el.type === "button") out.push(el as never);
    walk(el.props.children);
  };
  walk(node);
  return out;
}
const textOf = (n: ReactNode): string =>
  Array.isArray(n) ? n.map(textOf).join("") : typeof n === "string" || typeof n === "number" ? String(n) : isValidElement(n) ? textOf((n as ReactElement<{ children?: ReactNode }>).props.children) : "";

describe("Saved route delete: only Yes deletes", () => {
  const route = { id: "r1", name: "Studio", origin: "home" as const, destination: { lat: 43.6, lng: -79.4, label: "Studio, 1 King St" }, stops: [] };

  /** A tiny stand-in for SavedRoutes: its state, the same handler factory, and the real row. */
  function harness() {
    let state: SavedDeleteState = SAVED_DELETE_IDLE;
    const setState = (f: (s: SavedDeleteState) => SavedDeleteState) => {
      state = f(state);
    };
    const remove = vi.fn(async (_id: string) => ({ ok: true }));
    const row = () =>
      buttons(SavedRouteRow({ route, onRoute: vi.fn(), onOpen: vi.fn(), ...savedDeleteHandlers(route.id, state, setState, remove) }));
    const click = (match: (b: ReturnType<typeof row>[number]) => boolean) => {
      const b = row().find(match);
      if (!b) throw new Error("button not found");
      b.props.onClick?.();
    };
    const trash = (b: ReturnType<typeof row>[number]) => b.props["aria-label"] === "Delete Studio";
    const byText = (t: string) => (b: ReturnType<typeof row>[number]) => textOf(b.props.children).trim() === t;
    return { remove, row, click, trash, byText, get state() { return state; } };
  }

  it("the trash button only asks: remove is not called and Yes / No show", () => {
    const t = harness();
    t.click(t.trash);
    expect(t.remove).not.toHaveBeenCalled();
    expect(t.state.confirmId).toBe("r1");
    const labels = t.row().map((b) => textOf(b.props.children).trim());
    expect(labels).toEqual(["Yes", "No"]);
  });
  it("No cancels without deleting", () => {
    const t = harness();
    t.click(t.trash);
    t.click(t.byText("No"));
    expect(t.remove).not.toHaveBeenCalled();
    expect(t.state.confirmId).toBeNull();
    expect(t.row().some(t.trash)).toBe(true);
  });
  it("Delete, then Yes, calls remove once with the id", async () => {
    const t = harness();
    t.click(t.trash);
    const yes = t.row().find(t.byText("Yes"))!;
    yes.props.onClick?.();
    yes.props.onClick?.(); // a double-click before the re-render
    expect(t.remove).toHaveBeenCalledTimes(1);
    expect(t.remove).toHaveBeenCalledWith("r1");
    await vi.waitFor(() => expect(t.state.busyId).toBeNull());
    expect(t.state.confirmId).toBeNull();
  });
  it("Yes without the confirm step (a stale handler) does nothing", () => {
    const remove = vi.fn(async () => ({ ok: true }));
    const set = vi.fn();
    savedDeleteHandlers("r1", SAVED_DELETE_IDLE, set, remove).onConfirmDelete();
    savedDeleteHandlers("r1", { ...SAVED_DELETE_IDLE, confirmId: "r2" }, set, remove).onConfirmDelete();
    expect(remove).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it("a failed delete keeps the row and shows the error", async () => {
    const t = harness();
    t.remove.mockRejectedValueOnce(new Error("offline"));
    t.click(t.trash);
    t.click(t.byText("Yes"));
    await vi.waitFor(() => expect(t.state.error).toBe("Couldn't delete: offline"));
    expect(t.state.busyId).toBeNull();
  });
});
