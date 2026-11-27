import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ kv: new Map<string, unknown>(), store: new Map<string, string>(), puts: 0 }));
vi.mock("@/lib/cc-api", () => ({
  cc: {
    kvGet: async (k: string) => ({ value: h.kv.get(k) ?? null }),
    kvSet: async (k: string, v: unknown) => {
      h.puts++;
      h.kv.set(k, JSON.parse(JSON.stringify(v)));
    },
  },
}));
vi.stubGlobal("localStorage", {
  getItem: (k: string) => h.store.get(k) ?? null,
  setItem: (k: string, v: string) => void h.store.set(k, v),
  removeItem: (k: string) => void h.store.delete(k),
  key: (i: number) => [...h.store.keys()][i] ?? null,
  get length() {
    return h.store.size;
  },
});

import { UI_SYNC_KEY, UI_SYNC_MAX, forPlatform, gatewaySize, isNewer, lastPushError, pullUi, pushUi, setFollowDesktop } from "./ui-sync";
import { useAppearance } from "./appearance-store";
import { useLayout } from "@/core/widgets/layout-store";

const phoneDevice = () => {
  // The phone keeps its own sync marks; the desktop's "last pushed" mark is the desktop's.
  for (const k of [...h.store.keys()]) if (k.startsWith("cc.ui.sync.")) h.store.delete(k);
};

describe("phone sync of layouts and themes", () => {
  beforeEach(() => {
    h.kv.clear();
    h.store.clear();
    h.puts = 0;
    useLayout.getState().setEditing(false);
  });

  it("a copy applies when its content revision differs; clocks are never compared", () => {
    expect(isNewer("abc", "")).toBe(true);
    expect(isNewer("abc", "abc")).toBe(false);
    expect(isNewer(12345, "")).toBe(false);
  });

  it("the size check measures the way the gateway does (spaces after , and :, \\u escapes)", () => {
    expect(gatewaySize({ a: 1 })).toBe(JSON.stringify({ value: { a: 1 } }).length + 2);
    expect(gatewaySize("é")).toBe(JSON.stringify({ value: "é" }).length + 5 + 1);
    expect(UI_SYNC_MAX).toBe(256 * 1024);
  });

  it("panels the phone can't show are left out, in every mode's layout too", () => {
    const item = (widgetId: string) => ({ instanceId: widgetId, widgetId, col: 1, row: 1, w: 1, h: 1, config: {} });
    const layout = { pages: [{ id: "p", items: [item("hub"), item("cards")] }], variants: { builder: { pages: [{ id: "p", items: [item("hub")] }] } } };
    const out = forPlatform(layout, "pwa", (id) => (id === "hub" ? ["desktop"] : undefined)) as typeof layout;
    expect(out.pages[0].items.map((i) => i.widgetId)).toEqual(["cards"]);
    expect(out.variants.builder.pages[0].items).toEqual([]);
  });

  it("the desktop pushes only when saved content changed (not on clicks, windows or page switches)", async () => {
    useLayout.getState().resetAll();
    expect(await pushUi(1000)).toBe("pushed");
    useLayout.getState().setFocused("x");
    useLayout.getState().setEditing(true);
    useLayout.getState().setEditing(false);
    expect(await pushUi(2000)).toBe("same");
    useLayout.getState().renamePage(useLayout.getState().pages[0].id, "Changed");
    expect(await pushUi(3000)).toBe("pushed");
    expect(h.puts).toBe(2);
    expect(lastPushError()).toBe("");
  });

  it("the desktop's push reaches the phone; the same copy twice changes nothing", async () => {
    useAppearance.setState({ themes: [], activeTheme: "midnight", app: { radius: 9 }, pages: {}, lastReset: null });
    await pushUi(1000);
    phoneDevice();
    useAppearance.getState().resetAll();
    expect(await pullUi()).toContain("themes");
    expect(useAppearance.getState()).toMatchObject({ activeTheme: "midnight", app: { radius: 9 } });
    useAppearance.getState().resetAll();
    expect(await pullUi()).toEqual([]);
    expect(useAppearance.getState().activeTheme).toBe("default");
  });

  it("a sync keeps the phone's page and never lands mid-edit", async () => {
    useLayout.getState().resetAll();
    useLayout.getState().addPage("Two");
    const two = useLayout.getState().activePage;
    await pushUi(1000);
    phoneDevice();
    useLayout.getState().setEditing(true);
    expect(await pullUi()).toEqual([]);
    useLayout.getState().setEditing(false);
    expect((await pullUi()).length).toBeGreaterThan(0);
    expect(useLayout.getState().activePage).toBe(two);
  });

  it("'Follow the desktop' off keeps this device's own", async () => {
    await pushUi(1000);
    phoneDevice();
    setFollowDesktop(false);
    expect(await pullUi()).toEqual([]);
    expect(h.kv.has(UI_SYNC_KEY)).toBe(true);
  });
});
