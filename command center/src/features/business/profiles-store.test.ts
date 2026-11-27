import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake gateway with the real rev rule: a PUT must name the stored rev, else 409. */
const h = vi.hoisted(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  });
  return {
    mem,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: null as any,
    rev: 0,
    down: false,
    puts: [] as { value: Record<string, unknown>; rev: number }[],
    gets: 0,
    beforePut: null as null | (() => void),
    legacy: { name: "", address: "", email: "", phone: "", hstNumber: "", province: "ON", hstRate: 13, currency: "CAD" },
  };
});

vi.mock("@/lib/gateway", () => ({
  gateway: async (_path: string, init?: RequestInit) => {
    if (h.down) throw new Error("Gateway unreachable");
    if (!init || init.method !== "PUT") {
      h.gets++;
      return { value: h.value ? structuredClone(h.value) : null, rev: h.rev };
    }
    const body = JSON.parse(String(init.body));
    h.puts.push(body);
    const hook = h.beforePut;
    h.beforePut = null;
    hook?.();
    if (body.rev !== h.rev) throw Object.assign(new Error("409 Conflict"), { status: 409 });
    h.rev++;
    h.value = { ...body.value, rev: h.rev };
    return { value: structuredClone(h.value), rev: h.rev };
  },
}));
vi.mock("@/stores/settings", () => ({ useSettings: { getState: () => ({ business: h.legacy }) } }));

import { ensureProfiles, PENDING_KEY, resetProfilesForTests, RETRY_MS, useProfiles } from "./profiles-store";
import { withDefaults } from "./profiles";

const stored = (profiles: Record<string, Record<string, unknown>>, rev: number) => {
  const d = withDefaults({ version: 1, legacyImported: true, profiles: {} });
  for (const [id, p] of Object.entries(profiles)) Object.assign(d.profiles[id], p);
  delete d.rev;
  h.value = { ...d, rev };
  h.rev = rev;
};
const settle = async (ms = 0) => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(ms && i === 0 ? ms : 0);
};

beforeEach(() => {
  vi.useFakeTimers();
  h.mem.clear();
  Object.assign(h, { value: null, rev: 0, down: false, puts: [], gets: 0, beforePut: null });
  h.legacy = { ...h.legacy, name: "", phone: "" };
  resetProfilesForTests();
});
afterEach(() => {
  resetProfilesForTests();
  vi.useRealTimers();
});

describe("profiles store: rev, merge on 409, offline queue", () => {
  it("a stale save gets 409, merges this device's edits over the fresh doc and retries once", async () => {
    stored({ acting: { name: "Desktop" } }, 2);
    await useProfiles.getState().load();
    expect(useProfiles.getState().base.rev).toBe(2);

    useProfiles.getState().patch("acting", { phone: "555-1234" });
    // Another device saves before this one's debounced save goes out.
    h.beforePut = () => {
      h.value.profiles.trades_contracting.email = "nic@x.ca";
      h.value.profiles.acting.name = "Desktop renamed";
      h.rev = h.value.rev = 3;
    };
    await settle(600);

    expect(h.puts.map((p) => p.rev)).toEqual([2, 3]);
    expect(h.value.profiles.acting).toMatchObject({ name: "Desktop renamed", phone: "555-1234" });
    expect(h.value.profiles.trades_contracting.email).toBe("nic@x.ca");
    const s = useProfiles.getState();
    expect([s.pending, s.error, s.base.rev, s.doc.profiles.acting.name]).toEqual([false, null, 4, "Desktop renamed"]);
    expect(h.mem.get(PENDING_KEY)).toBeUndefined();
  });

  it("a second 409 is reported, the edit stays queued", async () => {
    stored({}, 1);
    await useProfiles.getState().load();
    useProfiles.getState().patch("acting", { name: "Mine" });
    const bump = () => {
      h.rev = h.value.rev = h.rev + 1;
      h.beforePut = bump;
    };
    h.beforePut = bump;
    await settle(600);
    h.beforePut = null;
    expect(h.puts.length).toBe(2);
    expect(useProfiles.getState()).toMatchObject({ pending: true, error: "409 Conflict" });
    expect(JSON.parse(h.mem.get(PENDING_KEY)!).doc.profiles.acting.name).toBe("Mine");
  });

  it("edits made while the gateway is down are queued (memory + localStorage) and saved on the next contact", async () => {
    stored({ acting: { name: "Acting" } }, 4);
    h.down = true;
    await useProfiles.getState().load();
    expect(useProfiles.getState()).toMatchObject({ loaded: false, error: "Gateway unreachable" });
    expect(await ensureProfiles()).toBe(false);

    useProfiles.getState().patch("trades_contracting", { name: "Offline edit" });
    expect(useProfiles.getState().pending).toBe(true);
    expect(JSON.parse(h.mem.get(PENDING_KEY)!).doc.profiles.trades_contracting.name).toBe("Offline edit");
    await settle(600);
    expect(h.puts.length).toBe(0); // never written blind

    h.down = false;
    await settle(RETRY_MS);
    expect(h.puts.map((p) => p.rev)).toEqual([4]);
    expect(h.value.profiles.trades_contracting.name).toBe("Offline edit");
    expect(h.value.profiles.acting.name).toBe("Acting"); // the gateway's fields kept
    expect(useProfiles.getState()).toMatchObject({ loaded: true, pending: false, error: null });
    expect(h.mem.get(PENDING_KEY)).toBeUndefined();
  });

  it("queued edits survive a reload of the app", async () => {
    stored({ acting: { name: "Acting" } }, 7);
    const base = withDefaults({ ...h.value });
    const doc = structuredClone(base);
    doc.profiles.personal.name = "Nic";
    h.mem.set(PENDING_KEY, JSON.stringify({ base, doc }));
    resetProfilesForTests(); // as on start-up: the queue is read back
    expect(useProfiles.getState().pending).toBe(true);
    await useProfiles.getState().load();
    await settle();
    expect(h.value.profiles.personal.name).toBe("Nic");
    expect(h.value.rev).toBe(8);
  });

  it("a device with no old profile doesn't use up the one-time import", async () => {
    h.value = null;
    await useProfiles.getState().load();
    await settle();
    expect(h.puts.length).toBe(0);
    expect(useProfiles.getState().doc.legacyImported).toBe(false);
    // The desktop (old profile in its localStorage) imports it later.
    resetProfilesForTests();
    h.legacy = { ...h.legacy, name: "Rae Masonry", phone: "555" };
    await useProfiles.getState().load();
    await settle();
    expect(h.puts.length).toBe(1);
    expect(h.value).toMatchObject({ legacyImported: true, rev: 1 });
    expect(h.value.profiles.trades_contracting.name).toBe("Rae Masonry");
    expect(useProfiles.getState().importedTo).toBe("trades_contracting");
  });
});
