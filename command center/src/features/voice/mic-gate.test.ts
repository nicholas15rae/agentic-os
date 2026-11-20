import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 Part B: the webview's mic gate. Mute is a dead line (every capture stopped before any
 * listener runs), the store fails closed until hydrated, and a failed unmute never unlocks.
 */
const h = vi.hoisted(() => ({ cmd: vi.fn(), events: new Map<string, (p: unknown) => void>() }));
vi.mock("@/lib/platform", () => ({
  isTauri: () => true,
  cmd: h.cmd,
  onNativeEvent: async (name: string, fn: (p: unknown) => void) => {
    h.events.set(name, fn);
    return () => undefined;
  },
}));

import { MicLockedError, assertMicAllowed, captureClosed, captureOpened, hydrateMic, killAllCaptures, micEnabled, onMicChange, registerCapture, requestMicEnabled, resetMicGateForTests, setMicEnabledLocal, useMic } from "./mic-gate";

beforeEach(() => {
  resetMicGateForTests();
  h.cmd.mockReset();
  h.events.clear();
});

describe("mic gate (fail closed)", () => {
  it("starts locked and un-hydrated", () => {
    expect(useMic.getState()).toMatchObject({ enabled: false, hydrated: false, live: 0, activeMeter: null });
    expect(micEnabled()).toBe(false);
  });

  it("assertMicAllowed and registerCapture throw MicLockedError while muted", () => {
    expect(() => assertMicAllowed()).toThrow(MicLockedError);
    expect(() => registerCapture({ stop: vi.fn() })).toThrow(MicLockedError);
    setMicEnabledLocal(true);
    expect(() => assertMicAllowed()).not.toThrow();
  });
});

describe("mute is a dead line", () => {
  it("stops every registered capture synchronously, before any listener runs", () => {
    setMicEnabledLocal(true);
    const order: string[] = [];
    const a = { stop: vi.fn(() => order.push("a")) };
    const b = { stop: vi.fn(() => order.push("b")) };
    registerCapture(a);
    registerCapture(b);
    const off = onMicChange((on) => order.push(`listener:${on}`));
    setMicEnabledLocal(false);
    off();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["a", "b", "listener:false"]);
    expect(micEnabled()).toBe(false);
  });

  it("a capture that unregisters itself inside stop() doesn't break the sweep; a throwing one doesn't keep the others open", () => {
    setMicEnabledLocal(true);
    let release = () => undefined as void;
    const self = { stop: vi.fn(() => release()) };
    release = registerCapture(self);
    const bad = { stop: vi.fn(() => { throw new Error("boom"); }) };
    registerCapture(bad);
    const last = { stop: vi.fn() };
    registerCapture(last);
    killAllCaptures();
    expect(self.stop).toHaveBeenCalledTimes(1);
    expect(last.stop).toHaveBeenCalledTimes(1);
  });

  it("re-enable notifies listeners and starts nothing", () => {
    const seen: boolean[] = [];
    const off = onMicChange((on) => seen.push(on));
    const cap = { stop: vi.fn() };
    setMicEnabledLocal(true);
    registerCapture(cap);
    setMicEnabledLocal(true); // no change → no second notification
    off();
    expect(seen).toEqual([true]);
    expect(cap.stop).not.toHaveBeenCalled();
    expect(useMic.getState().live).toBe(0); // nothing opened a capture
  });

  it("the live counter never goes negative", () => {
    captureOpened();
    captureClosed();
    captureClosed();
    expect(useMic.getState().live).toBe(0);
  });
});

describe("requestMicEnabled (desktop)", () => {
  it("disable applies locally at once, even when Rust rejects", async () => {
    setMicEnabledLocal(true);
    const cap = { stop: vi.fn() };
    registerCapture(cap);
    h.cmd.mockRejectedValue(new Error("ipc down"));
    const p = requestMicEnabled(false);
    // Synchronous: before the IPC call has even been made.
    expect(micEnabled()).toBe(false);
    expect(cap.stop).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBe(false);
    expect(h.cmd).toHaveBeenCalledWith("mic_set_enabled", { enabled: false });
  });

  it("enable stays muted when Rust rejects (fail closed)", async () => {
    h.cmd.mockRejectedValue(new Error("ipc down"));
    await expect(requestMicEnabled(true)).resolves.toBe(false);
    expect(micEnabled()).toBe(false);
  });

  it("enable stays muted unless Rust acks true", async () => {
    h.cmd.mockResolvedValue(false);
    await expect(requestMicEnabled(true)).resolves.toBe(false);
    h.cmd.mockResolvedValue(true);
    await expect(requestMicEnabled(true)).resolves.toBe(true);
    expect(micEnabled()).toBe(true);
  });
});

describe("hydrateMic (desktop)", () => {
  it("adopts Rust's state and follows the mic-state event", async () => {
    h.cmd.mockImplementation(async (name: string) => (name === "mic_get" ? true : undefined));
    await hydrateMic();
    expect(useMic.getState()).toMatchObject({ enabled: true, hydrated: true });
    h.events.get("mic-state")?.({ enabled: false });
    expect(micEnabled()).toBe(false);
  });

  it("a failed read stays locked but is marked hydrated (the HUD can offer Unlock)", async () => {
    h.cmd.mockRejectedValue(new Error("no rust"));
    await hydrateMic();
    expect(useMic.getState()).toMatchObject({ enabled: false, hydrated: true });
  });

  it("a local choice made while hydrating wins over the slower read", async () => {
    let answer: (v: boolean) => void = () => undefined;
    h.cmd.mockImplementation((name: string) => (name === "mic_get" ? new Promise<boolean>((r) => (answer = r)) : Promise.resolve(undefined)));
    const p = hydrateMic();
    await vi.waitFor(() => expect(h.cmd).toHaveBeenCalledWith("mic_get"));
    setMicEnabledLocal(false); // e.g. the user locked it during startup
    answer(true);
    await p;
    expect(micEnabled()).toBe(false);
  });
});
