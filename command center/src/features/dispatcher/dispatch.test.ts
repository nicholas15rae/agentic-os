import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * queueDesktopTurn against the gateway's claim/lease queue: a claimed (`running`) item keeps the
 * phone waiting, an unclaimed one gives up after 12 s, and `expired` says so explicitly.
 * The gateway is stubbed; timers are fake.
 */
const h = vi.hoisted(() => ({ gateway: vi.fn() }));

vi.mock("@/lib/gateway", () => ({ gateway: h.gateway, api: { chat: vi.fn() } }));
vi.mock("@/lib/platform", () => ({ cmd: vi.fn(), isTauri: () => false }));
vi.mock("./agents", () => ({ SUB_AGENTS: {} }));
vi.mock("./router", () => ({ DEFAULT_ROUTING_CONFIG: {}, directTool: () => null, resolve: () => ({ kind: "Default", role: "general", reason: "" }) }));

import { DESKTOP_EXPIRED_MESSAGE, desktopAlive, queueDesktopTurn } from "./dispatch";

type Poll = { status: string; result: unknown };

/** POST answers {id}; each GET /api/os/inbox/{id} answers `statusAt(elapsedMs)`. */
function stubQueue(statusAt: (elapsed: number) => Poll) {
  const t0 = Date.now();
  h.gateway.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") return { id: "q1" };
    expect(path).toBe("/api/os/inbox/q1");
    return statusAt(Date.now() - t0);
  });
}

const payload = { text: "build it", noDelegate: false, capture: true };

beforeEach(() => {
  vi.useFakeTimers();
  h.gateway.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("queueDesktopTurn", () => {
  it("keeps waiting while the desktop has the item claimed (running), past the 12 s pickup window", async () => {
    stubQueue((t) =>
      t < 3_000 ? { status: "pending", result: null }
      : t < 90_000 ? { status: "running", result: null }
      : { status: "done", result: { ok: true, result: { answer: "queued", idea: { id: "i1" } } } },
    );
    const p = queueDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(95_000);
    await expect(p).resolves.toEqual({ answer: "queued", idea: { id: "i1" } });
  });

  it("returns null when the item is still pending after 12 s (desktop app not running)", async () => {
    stubQueue(() => ({ status: "pending", result: null }));
    const p = queueDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(14_000);
    await expect(p).resolves.toBeNull();
    const polls = h.gateway.mock.calls.filter(([, init]) => !init?.method).length;
    expect(polls).toBeGreaterThan(5);
    expect(polls).toBeLessThan(11);
  });

  it("keeps waiting past 12 s while the desktop is busy with an earlier turn (it takes them one at a time)", async () => {
    stubQueue((t) =>
      t < 50_000 ? ({ status: "pending", result: null, desktopBusy: true } as Poll)
      : t < 55_000 ? { status: "running", result: null }
      : { status: "done", result: { ok: true, result: { answer: "Tony here" } } },
    );
    const p = queueDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toEqual({ answer: "Tony here" });
  });

  it("keeps waiting past 12 s while the desktop polled lately, but falls back once it goes quiet", async () => {
    // Polled 2 s before each read: alive -> no fallback at 14 s.
    stubQueue(() => ({ status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 2 }) as Poll);
    const alive = queueDesktopTurn(payload);
    let settled = false;
    void alive.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    // Last poll 60 s ago and nothing running: no desktop app -> fall back after 12 s.
    stubQueue(() => ({ status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 60 }) as Poll);
    const quiet = queueDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(14_000);
    await expect(quiet).resolves.toBeNull();
  });

  it("desktopAlive: busy, or polled in the last 15 s", () => {
    const now = 1_000_000_000;
    expect(desktopAlive({ desktopBusy: true }, now)).toBe(true);
    expect(desktopAlive({ desktopSeenAt: now / 1000 - 5 }, now)).toBe(true);
    expect(desktopAlive({ desktopSeenAt: now / 1000 - 20 }, now)).toBe(false);
    expect(desktopAlive({}, now)).toBe(false);
  });

  it("gives an explicit message when the gateway expired the item", async () => {
    stubQueue((t) => (t < 4_000 ? { status: "pending", result: null } : { status: "expired", result: { ok: false, error: "expired before the desktop picked it up" } }));
    const p = queueDesktopTurn(payload);
    const settled = expect(p).rejects.toThrow(DESKTOP_EXPIRED_MESSAGE);
    await vi.advanceTimersByTimeAsync(6_000);
    await settled;
  });

  it("surfaces the desktop's error for an `error` result", async () => {
    stubQueue(() => ({ status: "error", result: { ok: false, error: "Prompter timed out" } }));
    const p = queueDesktopTurn(payload);
    const settled = expect(p).rejects.toThrow("Prompter timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  it("stops at the 240 s cap even while running", async () => {
    stubQueue(() => ({ status: "running", result: null }));
    const p = queueDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(242_000);
    await expect(p).resolves.toBeNull();
  });
});
