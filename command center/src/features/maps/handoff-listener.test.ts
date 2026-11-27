import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ gateway: vi.fn() }));
vi.mock("@/lib/gateway", () => ({ gateway: h.gateway, GatewayError: class extends Error {} }));

import { ackHandoff, expiresText, fetchPendingHandoffs, HANDOFF_HOLD_MAX, pendingHandoffs, useHandoffs } from "./handoff-listener";
import { HANDOFF_TTL_MS } from "./nav";

const NOW = Date.parse("2026-11-26T15:00:00-05:00");
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
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
const s = () => useHandoffs.getState();

beforeEach(() => {
  s().reset();
  h.gateway.mockReset();
});

describe("receive", () => {
  it("accepts once, dedupes by id, refuses seen ones", () => {
    expect(s().receive(item("a"), NOW)?.id).toBe("a");
    expect(s().receive(item("a", { label: "Changed" }), NOW)).toBeNull();
    expect(s().items.a.label).toBe("CN Tower");
    s().markSeen("a");
    expect(s().items.a).toBeUndefined();
    expect(s().receive(item("a"), NOW)).toBeNull();
  });
  it("refuses bad, stale and non-pending items", () => {
    expect(s().receive(item("b", { mode: "call" }), NOW)).toBeNull();
    expect(s().receive(item("c", { expiresMs: NOW - 1 }), NOW)).toBeNull();
    expect(s().receive(item("d", { status: "opened" }), NOW)).toBeNull();
    expect(s().receive("junk", NOW)).toBeNull();
    expect(Object.keys(s().items)).toEqual([]);
  });
  it("holds at most HANDOFF_HOLD_MAX, newest kept", () => {
    for (let i = 0; i < HANDOFF_HOLD_MAX + 5; i++) s().receive(item(`id${i}`, { createdMs: NOW - 60_000 + i }), NOW);
    const list = pendingHandoffs(s(), NOW);
    expect(list).toHaveLength(HANDOFF_HOLD_MAX);
    expect(list[0].id).toBe(`id${HANDOFF_HOLD_MAX + 4}`);
  });
});

describe("receiveWs", () => {
  it("takes nav-handoff frames, acks mark seen, other frames are ignored", () => {
    expect(s().receiveWs(JSON.stringify({ type: "nav-handoff", ...item("w1") }), NOW)?.id).toBe("w1");
    expect(s().receiveWs(JSON.stringify({ type: "trips", fetchedAtMs: NOW, receivedAtMs: NOW, count: 2 }), NOW)).toBeNull();
    expect(s().receiveWs(JSON.stringify({ type: "sms", ...item("w2") }), NOW)).toBeNull();
    expect(s().receiveWs("{not json", NOW)).toBeNull();
    expect(s().receiveWs(JSON.stringify({ type: "nav-handoff-ack", id: "w1", status: "opened" }), NOW)).toBeNull();
    expect(s().items.w1).toBeUndefined();
    expect(s().receiveWs(JSON.stringify({ type: "nav-handoff", ...item("w1") }), NOW)).toBeNull();
  });
});

describe("receiveList, prune, TTL", () => {
  it("honours the kill switch flag and drops expired items on prune", () => {
    expect(s().receiveList({ items: [item("k1")], killSwitch: true }, NOW)).toEqual([]);
    expect(s().receiveList({ items: [item("k1")] }, NOW)).toEqual([]);
    expect(s().receiveList({ items: [item("k1"), item("k2"), { bad: 1 }], killSwitch: false }, NOW).map((i) => i.id)).toEqual(["k1", "k2"]);
    const later = NOW + HANDOFF_TTL_MS;
    expect(pendingHandoffs(s(), later)).toEqual([]);
    s().prune(later);
    expect(Object.keys(s().items)).toEqual([]);
  });
  it("expiry text", () => {
    expect(expiresText({ expiresMs: NOW + 12 * 60_000 }, NOW)).toBe("Expires in 12 min");
    expect(expiresText({ expiresMs: NOW + 30_000 }, NOW)).toBe("Expires in 1 min");
    expect(expiresText({ expiresMs: NOW - 1 }, NOW)).toBe("Expired");
  });
});

describe("gateway helpers never throw", () => {
  it("fetchPendingHandoffs and ackHandoff", async () => {
    h.gateway.mockResolvedValueOnce({ items: [item("g1")], killSwitch: false });
    expect((await fetchPendingHandoffs(NOW)).map((i) => i.id)).toEqual(["g1"]);
    h.gateway.mockRejectedValueOnce(new Error("down"));
    await expect(fetchPendingHandoffs(NOW)).resolves.toEqual([]);
    h.gateway.mockResolvedValueOnce({ ok: true });
    expect(await ackHandoff("g1", "opened")).toBe(true);
    expect(h.gateway).toHaveBeenLastCalledWith("/api/maps/handoff/g1/ack", { method: "POST", body: '{"status":"opened"}', timeoutMs: 8000 });
    expect(s().seen.g1).toBe(true);
    h.gateway.mockRejectedValueOnce(new Error("410"));
    expect(await ackHandoff("g2", "dismissed")).toBe(false);
    expect(await ackHandoff("../x", "opened")).toBe(false);
    expect(await ackHandoff("g3", "expired" as never)).toBe(false);
  });
});
