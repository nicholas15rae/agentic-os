import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ android: true, saved: null as string | null, cmd: vi.fn() }));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd }));
vi.mock("@/stores/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settings")>();
  return { ...actual, isAndroidApp: () => h.android };
});

const stops: ((() => void) | undefined)[] = [];

async function fresh() {
  vi.resetModules();
  const { useSettings } = await import("@/stores/settings");
  useSettings.getState().set({ gatewayToken: "" });
  const mod = await import("./phone-token");
  const initPhoneToken = async () => {
    stops.push(await mod.initPhoneToken());
  };
  return { useSettings, initPhoneToken };
}

describe("phone gateway token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.android = true;
    h.saved = null;
    h.cmd.mockReset();
    h.cmd.mockImplementation(async (name: string, args: { value?: string }) => {
      if (name === "phone_secret_get") return h.saved;
      if (name === "phone_secret_set") h.saved = args.value || null;
      return undefined;
    });
  });
  afterEach(() => {
    for (const s of stops.splice(0)) s?.();
    vi.useRealTimers();
  });

  it("loads the saved token at start", async () => {
    h.saved = "a".repeat(64);
    const { useSettings, initPhoneToken } = await fresh();
    await initPhoneToken();
    expect(useSettings.getState().gatewayToken).toBe("a".repeat(64));
  });

  it("never overwrites a token typed before the load finished", async () => {
    h.saved = "old";
    const { useSettings, initPhoneToken } = await fresh();
    useSettings.getState().set({ gatewayToken: "typed" });
    await initPhoneToken();
    expect(useSettings.getState().gatewayToken).toBe("typed");
  });

  it("saves changes (trimmed, debounced) and forgets an emptied field", async () => {
    const { useSettings, initPhoneToken } = await fresh();
    await initPhoneToken();
    useSettings.getState().set({ gatewayToken: " b" });
    useSettings.getState().set({ gatewayToken: " bb " });
    await vi.advanceTimersByTimeAsync(700);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "phone_secret_set")).toEqual([["phone_secret_set", { key: "gateway-token", value: "bb" }]]);
    useSettings.getState().set({ gatewayToken: "" });
    await vi.advanceTimersByTimeAsync(700);
    expect(h.saved).toBeNull();
  });

  it("does nothing off Android", async () => {
    h.android = false;
    const { initPhoneToken } = await fresh();
    await initPhoneToken();
    expect(h.cmd).not.toHaveBeenCalled();
  });
});
