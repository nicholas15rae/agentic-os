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

  it("a cold launch: retries while the secure store is still starting, then loads the token", async () => {
    h.saved = "c".repeat(64);
    let fails = 3;
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "phone_secret_get" && fails-- > 0) throw "secure store not ready";
      return name === "phone_secret_get" ? h.saved : undefined;
    });
    vi.resetModules();
    const { useSettings } = await import("@/stores/settings");
    useSettings.getState().set({ gatewayToken: "" });
    const mod = await import("./phone-token");
    stops.push(await mod.initPhoneToken({ wait: async () => undefined }));
    expect(h.cmd.mock.calls.filter((c) => c[0] === "phone_secret_get")).toHaveLength(4);
    expect(useSettings.getState().gatewayToken).toBe("c".repeat(64));
  });

  it("a cold launch while LOCKED: waits for the unlock (however long), then loads the token", async () => {
    // The real failure: the app starts behind its biometric lock, Rust's gate refuses the read
    // with LOCKED, and the old code gave up -> no token -> every gateway call 401 after unlocking.
    h.saved = "d".repeat(64);
    let locked = true;
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "phone_secret_get" && locked) throw "LOCKED: the Command Center is locked; unlock it first";
      return name === "phone_secret_get" ? h.saved : undefined;
    });
    let unlock!: () => void;
    const unlockedP = new Promise<void>((r) => (unlock = r));
    vi.resetModules();
    const { useSettings } = await import("@/stores/settings");
    useSettings.getState().set({ gatewayToken: "" });
    const mod = await import("./phone-token");
    const done = mod.initPhoneToken({ wait: async () => undefined, unlocked: () => unlockedP });
    await vi.advanceTimersByTimeAsync(60_000); // a long time at the lock screen
    const gets = () => h.cmd.mock.calls.filter((c) => c[0] === "phone_secret_get").length;
    expect(gets()).toBe(1); // no spinning against the gate while locked
    expect(useSettings.getState().gatewayToken).toBe("");
    locked = false;
    unlock();
    stops.push(await done);
    expect(gets()).toBe(2);
    expect(useSettings.getState().gatewayToken).toBe("d".repeat(64));
  });

  it("gives up after ~7 s of non-lock failures, and still saves a token typed afterwards", async () => {
    h.cmd.mockImplementation(async (name: string, args: { value?: string }) => {
      if (name === "phone_secret_get") throw "secure store not ready";
      if (name === "phone_secret_set") h.saved = args.value || null;
      return undefined;
    });
    vi.resetModules();
    const { useSettings } = await import("@/stores/settings");
    useSettings.getState().set({ gatewayToken: "" });
    const mod = await import("./phone-token");
    stops.push(await mod.initPhoneToken({ wait: async () => undefined }));
    expect(h.cmd.mock.calls.filter((c) => c[0] === "phone_secret_get")).toHaveLength(29);
    useSettings.getState().set({ gatewayToken: "typed" });
    await vi.advanceTimersByTimeAsync(700);
    expect(h.saved).toBe("typed");
  });

  it("isLockRefusal matches the gate's lock codes only", async () => {
    const { isLockRefusal } = await import("./phone-token");
    expect(isLockRefusal("LOCKED: the Command Center is locked; unlock it first")).toBe(true);
    expect(isLockRefusal("HARD_LOCKED: the remote failsafe locked this app")).toBe(true);
    expect(isLockRefusal(new Error("LOCKED: x"))).toBe(true);
    expect(isLockRefusal("STEP_UP_REQUIRED:finance: read-only")).toBe(false);
    expect(isLockRefusal("secure store not ready")).toBe(false);
  });

  it("does nothing off Android", async () => {
    h.android = false;
    const { initPhoneToken } = await fresh();
    await initPhoneToken();
    expect(h.cmd).not.toHaveBeenCalled();
  });
});
