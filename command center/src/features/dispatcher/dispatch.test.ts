import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * queueDesktopTurn against the gateway's claim/lease queue: a claimed (`running`) item keeps the
 * phone waiting, an unclaimed one gives up after 12 s, and `expired` says so explicitly.
 * The phone's dispatch(): poll blips are retried, a claimed turn never falls back to the gateway
 * CLI, desktop errors surface, and the CLI still answers when no desktop app is running.
 * The gateway is stubbed; timers are fake.
 */
const h = vi.hoisted(() => {
  class GatewayError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
    }
  }
  return { gateway: vi.fn(), chat: vi.fn(), GatewayError, realRouter: false, android: false };
});

vi.mock("@/lib/gateway", () => ({ gateway: h.gateway, api: { chat: h.chat }, GatewayError: h.GatewayError }));
vi.mock("@/lib/platform", () => ({ cmd: vi.fn(), isTauri: () => false }));
// Never the desktop app here (dispatch queues for the desktop); `h.android` = the Android app, else the PWA.
vi.mock("@/stores/settings", () => ({ isDesktopApp: () => false, isAndroidApp: () => h.android }));
vi.mock("./agents", () => ({
  SUB_AGENTS: {
    general: { label: "Tony", gatewayAgent: "opencode", systemPrompt: "", priority: "normal" },
    booking: { label: "Booking Desk", gatewayAgent: "opencode", systemPrompt: "", priority: "normal" },
    designer: { label: "Designer", gatewayAgent: "opencode", systemPrompt: "", priority: "normal" },
  },
}));
// Every line reads "Default" unless a test switches on the real router (`h.realRouter`).
vi.mock("./router", async (importOriginal) => {
  const real = await importOriginal<typeof import("./router")>();
  return {
    DEFAULT_ROUTING_CONFIG: real.DEFAULT_ROUTING_CONFIG,
    directTool: (t: string) => (h.realRouter ? real.directTool(t) : null),
    resolve: (...a: Parameters<typeof real.resolve>) => (h.realRouter ? real.resolve(...a) : { kind: "Default", role: "general", reason: "" }),
  };
});

import {
  DESKTOP_CANCELLED_MESSAGE,
  DESKTOP_EXPIRED_MESSAGE,
  DESKTOP_LOST_MESSAGE,
  DESKTOP_NO_ANSWER_MESSAGE,
  DESKTOP_QUEUED_MESSAGE,
  DESKTOP_STILL_QUEUED_MESSAGE,
  DESKTOP_STILL_WORKING_MESSAGE,
  DESKTOP_UNREACHABLE_MESSAGE,
  cancelDesktopItem,
  DESKTOP_LONG_POLL_PAD_MS,
  awaitDesktopItem,
  desktopAlive,
  desktopOff,
  desktopTimeoutMessage,
  dispatch,
  gatewayFallbackPrompt,
  longPollWait,
  postMayHaveQueued,
  postRefused,
  queueDesktopTurn,
  sendDesktopTurn,
  transientPollError,
} from "./dispatch";
import { DEFAULT_ROUTING_CONFIG, resolve } from "./router";

type Poll = { status: string; result: unknown; desktopSeenAt?: number; desktopBusy?: boolean };

/** A gateway from before long-poll: POST /api/os/inbox answers {id} (or `post()`'s answer / error);
 * each GET /api/os/inbox/{id} answers (or throws) `statusAt(elapsedMs)` at once (no `partialSeq`,
 * so every GET stays the plain one, exactly as before); POST /api/os/inbox/{id}/cancel answers (or
 * throws) `cancel()`, by default the gateway's 200. */
function stubQueue(statusAt: (elapsed: number) => Poll, post?: () => unknown, cancel?: () => unknown) {
  const t0 = Date.now();
  h.gateway.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && path === "/api/os/inbox/q1/cancel") return cancel ? cancel() : { id: "q1", status: "cancelled" };
    if (init?.method === "POST") {
      expect(path).toBe("/api/os/inbox");
      return post ? post() : { id: "q1" };
    }
    expect(path).toBe("/api/os/inbox/q1");
    return statusAt(Date.now() - t0);
  });
}

const polls = () => h.gateway.mock.calls.filter(([, init]) => !init?.method).length;
const cancels = () => h.gateway.mock.calls.filter(([path]) => String(path).endsWith("/cancel")).length;
const postedPayload = () => JSON.parse(h.gateway.mock.calls.find(([, init]) => init?.method === "POST")![1].body).payload;
const unreachable = () => {
  throw new h.GatewayError("Gateway unreachable");
};
const conflict = () => {
  throw new h.GatewayError("409 Conflict", 409);
};
/** No desktop app polling: nothing running, last poll 30 s ago (past desktopAlive's 15 s, but not
 * the 60 s that reads as "off"), so the 12 s pickup wait applies. */
const quiet = (): Poll => ({ status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 30, desktopBusy: false });

const payload = { text: "build it", noDelegate: false, capture: true };

beforeEach(() => {
  vi.useFakeTimers();
  h.realRouter = false;
  h.android = false;
  h.gateway.mockReset();
  h.chat.mockReset();
  h.chat.mockResolvedValue({ response: { content: "CLI answer" } });
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
    expect(polls()).toBeGreaterThan(5);
    expect(polls()).toBeLessThan(11);
    expect(cancels()).toBe(0); // queueDesktopItem callers never run it elsewhere: it stays queued
  });

  it("an item cancelled at the gateway is explained, never read as a failure", async () => {
    stubQueue((t) => (t < 3_000 ? { status: "pending", result: null } : { status: "cancelled", result: { ok: false, error: "cancelled before the desktop picked it up" } }));
    const p = queueDesktopTurn(payload);
    const settled = expect(p).rejects.toThrow(DESKTOP_CANCELLED_MESSAGE);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
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

describe("poll failures", () => {
  it("retries a poll blip (network error / 5xx) instead of giving up, then takes the answer", async () => {
    let n = 0;
    stubQueue((t) => {
      n++;
      if (n === 2) unreachable();
      if (n === 3) throw new h.GatewayError("502 Bad Gateway", 502);
      return t < 20_000 ? { status: "running", result: null } : { status: "done", result: { ok: true, result: { answer: "Tony here" } } };
    });
    const p = queueDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toEqual({ answer: "Tony here" });
  });

  it("backs off while the poll keeps failing (3 s → 6 s → 8 s), not every 1.5 s", async () => {
    stubQueue(() => unreachable());
    const p = sendDesktopTurn(payload, { capMs: 30_000 });
    await vi.advanceTimersByTimeAsync(32_000);
    await p;
    // 1.5 + 3 + 6 + 8 + 8 + 8 s: at most 6 polls in 30 s (a fixed 1.5 s cadence would be 20).
    expect(polls()).toBeGreaterThanOrEqual(4);
    expect(polls()).toBeLessThanOrEqual(6);
  });

  it("a claimed item is never given up: a blip and a lapsed lease past 12 s with no desktop still wait", async () => {
    let n = 0;
    stubQueue((t) => {
      n++;
      if (n === 3) unreachable();
      return t < 3_000 ? { status: "running", result: null }
        : t < 60_000 ? { status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 60 } // lease lapsed, desktop quiet
        : { status: "done", result: { ok: true, result: { answer: "late but here" } } };
    });
    const p = sendDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(p).resolves.toEqual({ state: "done", result: { answer: "late but here" } });
  });

  it("a 4xx poll failure (bad token, unknown item) is not retried: it throws", async () => {
    stubQueue(() => {
      throw new h.GatewayError("401 Unauthorized", 401);
    });
    const p = queueDesktopTurn(payload);
    const settled = expect(p).rejects.toThrow("401 Unauthorized");
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(polls()).toBe(1);
  });

  it("no poll ever got through: a timeout that says so (not unclaimed: the desktop may have it)", async () => {
    stubQueue(() => unreachable());
    const p = sendDesktopTurn(payload, { capMs: 20_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(p).resolves.toEqual({ state: "timeout", claimed: false, polled: false, lastPollOk: false, busy: false });
    expect(cancels()).toBe(0);
  });

  it("one early poll got through, then every poll failed: LOST, not 'busy with an earlier request'", async () => {
    let n = 0;
    stubQueue(() => {
      if (++n > 1) unreachable();
      return { status: "pending", result: null, desktopBusy: true };
    });
    const p = sendDesktopTurn(payload, { capMs: 60_000 });
    await vi.advanceTimersByTimeAsync(65_000);
    const w = await p;
    expect(w).toEqual({ state: "timeout", claimed: false, polled: true, lastPollOk: false, busy: true });
    expect(desktopTimeoutMessage(w as { claimed: boolean; lastPollOk: boolean; busy: boolean })).toBe(DESKTOP_LOST_MESSAGE);
    expect(cancels()).toBe(0);
  });

  it("busy early, then the last poll got through with the desktop idle but alive: the neutral 'still queued' line", async () => {
    stubQueue((t) => (t < 10_000 ? { status: "pending", result: null, desktopBusy: true } : { status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 2 }));
    const p = sendDesktopTurn(payload, { capMs: 30_000 });
    await vi.advanceTimersByTimeAsync(32_000);
    const w = await p;
    expect(w).toMatchObject({ state: "timeout", claimed: false, lastPollOk: true, busy: false });
    expect(desktopTimeoutMessage(w as { claimed: boolean; lastPollOk: boolean; busy: boolean })).toBe(DESKTOP_QUEUED_MESSAGE);
  });

  it("a failed POST is `unqueued` for sendDesktopTurn, and still throws for queueDesktopItem callers", async () => {
    stubQueue(() => ({ status: "pending", result: null }), unreachable);
    await expect(sendDesktopTurn(payload)).resolves.toMatchObject({ state: "unqueued" });
    await expect(queueDesktopTurn(payload)).rejects.toThrow("Gateway unreachable");
  });

  it("transientPollError: no status, 5xx, 408 and 429 retry; other 4xx and plain errors don't", () => {
    expect(transientPollError(new h.GatewayError("Gateway timed out"))).toBe(true);
    expect(transientPollError(new h.GatewayError("503", 503))).toBe(true);
    expect(transientPollError(new h.GatewayError("408", 408))).toBe(true);
    expect(transientPollError(new h.GatewayError("429", 429))).toBe(true);
    expect(transientPollError(new h.GatewayError("404", 404))).toBe(false);
    expect(transientPollError(new Error("boom"))).toBe(false);
  });

  it("desktopTimeoutMessage: still working / busy-queued only when the LAST poll said busy / queued / lost", () => {
    expect(desktopTimeoutMessage({ claimed: true, lastPollOk: true, busy: false })).toBe(DESKTOP_STILL_WORKING_MESSAGE);
    expect(desktopTimeoutMessage({ claimed: true, lastPollOk: false, busy: false })).toBe(DESKTOP_STILL_WORKING_MESSAGE);
    expect(desktopTimeoutMessage({ claimed: false, lastPollOk: true, busy: true })).toBe(DESKTOP_STILL_QUEUED_MESSAGE);
    expect(desktopTimeoutMessage({ claimed: false, lastPollOk: true, busy: false })).toBe(DESKTOP_QUEUED_MESSAGE);
    expect(desktopTimeoutMessage({ claimed: false, lastPollOk: false, busy: true })).toBe(DESKTOP_LOST_MESSAGE);
    expect(desktopTimeoutMessage({ claimed: false, lastPollOk: false, busy: false })).toBe(DESKTOP_LOST_MESSAGE);
  });

  it("postMayHaveQueued: a failure with no HTTP status (timeout / dropped connection) or a 5xx", () => {
    expect(postMayHaveQueued(new h.GatewayError("Gateway timed out"))).toBe(true);
    expect(postMayHaveQueued(new h.GatewayError("Gateway unreachable"))).toBe(true);
    expect(postMayHaveQueued(new h.GatewayError("502 Bad Gateway", 502))).toBe(true);
    expect(postMayHaveQueued(new h.GatewayError("503 Service Unavailable", 503))).toBe(true);
    expect(postMayHaveQueued(new h.GatewayError("404 Not Found", 404))).toBe(false);
    expect(postMayHaveQueued(new h.GatewayError("429 Too Many Requests", 429))).toBe(false);
    expect(postMayHaveQueued(new Error("boom"))).toBe(false);
  });

  it("postRefused: only 400 / 404 / 413 / 422 (the gateway refused the item outright)", () => {
    for (const s of [400, 404, 413, 422]) expect(postRefused(new h.GatewayError(`${s}`, s)), `${s}`).toBe(true);
    for (const s of [401, 403, 408, 409, 423, 429, 500, 502, 503, 504]) expect(postRefused(new h.GatewayError(`${s}`, s)), `${s}`).toBe(false);
    expect(postRefused(new h.GatewayError("Gateway timed out"))).toBe(false);
    expect(postRefused(new Error("boom"))).toBe(false);
  });
});

describe("cancel before any CLI fallback", () => {
  it("cancelDesktopItem: 200 cancelled, 409 taken, a transient failure retried once, then failed", async () => {
    stubQueue(() => quiet());
    await expect(cancelDesktopItem("q1")).resolves.toBe("cancelled");
    stubQueue(() => quiet(), undefined, conflict);
    await expect(cancelDesktopItem("q1")).resolves.toBe("taken");
    h.gateway.mockReset();
    stubQueue(() => quiet(), undefined, unreachable);
    const p = cancelDesktopItem("q1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe("failed");
    expect(cancels()).toBe(2);
    h.gateway.mockReset();
    stubQueue(() => quiet(), undefined, () => {
      throw new h.GatewayError("404 Not Found", 404); // an older gateway with no cancel route
    });
    await expect(cancelDesktopItem("q1")).resolves.toBe("failed");
    expect(cancels()).toBe(1);
  });

  it("sendDesktopTurn: unclaimed only after the gateway cancelled it", async () => {
    stubQueue(() => quiet());
    const p = sendDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(14_000);
    await expect(p).resolves.toEqual({ state: "unclaimed" });
    expect(cancels()).toBe(1);
  });

  it("the desktop claimed it as the phone gave up (cancel 409): keeps waiting and takes Tony's answer", async () => {
    stubQueue((t) => (t <= 13_500 ? quiet() : t < 20_000 ? { status: "running", result: null } : { status: "done", result: { ok: true, result: { answer: "Tony got it" } } }), undefined, conflict);
    const p = sendDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(p).resolves.toEqual({ state: "done", result: { answer: "Tony got it" } });
    expect(cancels()).toBe(1);
  });

  it("a 409 is never followed by a second give-up, even if the item reads pending and quiet again", async () => {
    stubQueue(() => quiet(), undefined, conflict);
    const p = sendDesktopTurn(payload, { capMs: 40_000 });
    await vi.advanceTimersByTimeAsync(42_000);
    await expect(p).resolves.toMatchObject({ state: "timeout", claimed: true });
    expect(cancels()).toBe(1);
  });

  it("the cancel got no answer: `uncancelled` (the desktop may still run it)", async () => {
    stubQueue(() => quiet(), undefined, unreachable);
    const p = sendDesktopTurn(payload);
    await vi.advanceTimersByTimeAsync(17_000);
    await expect(p).resolves.toEqual({ state: "uncancelled" });
    expect(cancels()).toBe(2);
  });
});

describe("dispatch on the phone", () => {
  it("takes the desktop's answer; the queued turn carries the routing and noDelegate", async () => {
    stubQueue((t) => (t < 3_000 ? { status: "running", result: null } : { status: "done", result: { ok: true, result: { answer: "Hi from Tony", providerId: "bionic" } } }));
    const p = dispatch("hello", { history: [{ role: "user", content: "earlier" }] });
    await vi.advanceTimersByTimeAsync(5_000);
    const { role, result } = await p;
    expect(role).toBe("general");
    expect(result).toMatchObject({ providerId: "desktop:bionic", content: "Hi from Tony", reason: "phone → desktop Tony" });
    expect(postedPayload()).toMatchObject({ text: "hello", role: "general", explicit: false, routeKind: "Default", noDelegate: false, history: [{ role: "user", content: "earlier" }] });
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("claimed then slow: never falls back to the CLI; at the cap it says Tony is still on it", async () => {
    stubQueue(() => ({ status: "running", result: null }));
    const p = dispatch("plan my week");
    await vi.advanceTimersByTimeAsync(245_000);
    const { result } = await p;
    expect(result.content).toBe(DESKTOP_STILL_WORKING_MESSAGE);
    expect(result.providerId).toBe("desktop:tony");
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("queued behind a busy desktop for the whole cap: says so, no CLI (the desktop will still run it)", async () => {
    stubQueue(() => ({ status: "pending", result: null, desktopBusy: true }));
    const p = dispatch("plan my week");
    await vi.advanceTimersByTimeAsync(245_000);
    expect((await p).result.content).toBe(DESKTOP_STILL_QUEUED_MESSAGE);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a poll blip after the claim is retried: Tony's answer, no CLI", async () => {
    let n = 0;
    stubQueue((t) => {
      n++;
      if (n === 2 || n === 3) unreachable();
      return t < 15_000 ? { status: "running", result: null } : { status: "done", result: { ok: true, result: { answer: "done it" } } };
    });
    const p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await p).result.content).toBe("done it");
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a desktop error is surfaced, not swallowed into a CLI fallback", async () => {
    stubQueue((t) => (t < 3_000 ? { status: "running", result: null } : { status: "error", result: { ok: false, error: "all providers failed" } }));
    const p = dispatch("hello");
    const settled = expect(p).rejects.toThrow("all providers failed");
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("an expired item is explained, not silently run on the CLI", async () => {
    stubQueue((t) => (t < 4_000 ? { status: "pending", result: null } : { status: "expired", result: null }));
    const p = dispatch("hello");
    const settled = expect(p).rejects.toThrow(DESKTOP_EXPIRED_MESSAGE);
    await vi.advanceTimersByTimeAsync(6_000);
    await settled;
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a desktop result with no answer is an error, not a CLI re-run", async () => {
    stubQueue(() => ({ status: "done", result: { ok: true, result: { steps: [] } } }));
    const p = dispatch("hello");
    const settled = expect(p).rejects.toThrow(DESKTOP_NO_ANSWER_MESSAGE);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("never claimed and no desktop app polling: cancelled at the gateway, THEN the gateway CLI answers after 12 s", async () => {
    stubQueue(() => quiet());
    const p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(14_000);
    const { result } = await p;
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.chat).toHaveBeenCalledWith("opencode", "You are Tony, Nic's assistant in Agentic OS. Nic just said this from his phone; reply to him directly and briefly:\n\nhello");
    expect(result).toMatchObject({ providerId: "gateway:opencode", content: "CLI answer", reason: "PWA → Agentic OS gateway" });
    // The cancel went out before the CLI ran, so a desktop that starts later never answers it again.
    const cancelCall = h.gateway.mock.calls.findIndex(([path]) => String(path).endsWith("/cancel"));
    expect(cancelCall).toBeGreaterThan(0);
    expect(h.gateway.mock.invocationCallOrder[cancelCall]).toBeLessThan(h.chat.mock.invocationCallOrder[0]);
  });

  it("the desktop claimed it as the phone gave up (cancel 409): Tony's answer, no CLI", async () => {
    stubQueue((t) => (t <= 13_500 ? quiet() : t < 20_000 ? { status: "running", result: null } : { status: "done", result: { ok: true, result: { answer: "Tony got it" } } }), undefined, conflict);
    const p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await p).result).toMatchObject({ providerId: "desktop:tony", content: "Tony got it" });
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("the cancel got no answer: the 'lost' message, no CLI (it may still run on the desktop)", async () => {
    stubQueue(() => quiet(), undefined, unreachable);
    const p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(17_000);
    const { result } = await p;
    expect(result).toMatchObject({ providerId: "desktop:tony", content: DESKTOP_LOST_MESSAGE, fellBack: false });
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("nothing queued (the POST was refused with a status): the gateway CLI answers", async () => {
    stubQueue(() => ({ status: "pending", result: null }), () => {
      throw new h.GatewayError("404 Not Found", 404);
    });
    const p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).result.providerId).toBe("gateway:opencode");
    expect(polls()).toBe(0);
  });

  it("the gateway refused the item (400 / 413 / 422): nothing queued, the gateway CLI answers", async () => {
    for (const s of [400, 413, 422]) {
      h.gateway.mockReset();
      h.chat.mockClear();
      stubQueue(() => ({ status: "pending", result: null }), () => {
        throw new h.GatewayError(`${s} refused`, s);
      });
      const out = await dispatch("hello");
      expect(out.result, `${s}`).toMatchObject({ providerId: "gateway:opencode", content: "CLI answer" });
      expect(out.notice).toBeUndefined();
      expect(h.chat, `${s}`).toHaveBeenCalledTimes(1);
      expect(polls()).toBe(0);
    }
  });

  it("a 503 on the POST never runs the CLI: the item may have landed, so the 'lost' message", async () => {
    for (const s of [500, 502, 503, 504]) {
      h.gateway.mockReset();
      stubQueue(() => ({ status: "pending", result: null }), () => {
        throw new h.GatewayError(`${s} Service Unavailable`, s);
      });
      const out = await dispatch("hello");
      expect(out, `${s}`).toMatchObject({ notice: "unconfirmed", result: { providerId: "desktop:tony", content: DESKTOP_LOST_MESSAGE, fellBack: false } });
      expect(polls()).toBe(0);
      expect(cancels()).toBe(0);
    }
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a POST turned away for now (408 / 429): 'couldn't reach Tony, try again', no CLI", async () => {
    for (const s of [408, 429]) {
      h.gateway.mockReset();
      stubQueue(() => ({ status: "pending", result: null }), () => {
        throw new h.GatewayError(`${s}`, s);
      });
      expect(await dispatch("hello"), `${s}`).toMatchObject({ notice: "unconfirmed", result: { providerId: "desktop:tony", content: DESKTOP_UNREACHABLE_MESSAGE } });
      expect(polls()).toBe(0);
    }
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("any other POST status (401 / 403 / 423) throws it, never runs the CLI", async () => {
    for (const s of [401, 403, 423]) {
      h.gateway.mockReset();
      stubQueue(() => ({ status: "pending", result: null }), () => {
        throw new h.GatewayError(`${s} denied`, s);
      });
      await expect(dispatch("hello"), `${s}`).rejects.toThrow(`${s} denied`);
    }
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a done result's streamPrefix (gateway Tony's cold-start lead-in) reaches result.streamPrefix", async () => {
    const WAKING = "One sec, Nic — waking up. ";
    stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "Sure.", providerId: "gateway:lmstudio", streamPrefix: WAKING } } }));
    const out = await dispatch("hello");
    expect(out.result).toMatchObject({ providerId: "desktop:gateway:lmstudio", content: "Sure.", streamPrefix: WAKING });
    expect(out.notice).toBeUndefined();
    // Warm (""), absent or not a string: no streamPrefix at all.
    for (const streamPrefix of ["", undefined, 7]) {
      h.gateway.mockReset();
      stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "Hi", streamPrefix } } }));
      expect((await dispatch("hello")).result).not.toHaveProperty("streamPrefix");
    }
  });

  it("a POST with no answer (timed out / dropped) may have queued it: the 'lost' message, no CLI", async () => {
    for (const msg of ["Gateway timed out", "Gateway unreachable"]) {
      h.gateway.mockReset();
      stubQueue(() => ({ status: "pending", result: null }), () => {
        throw new h.GatewayError(msg);
      });
      const { result } = await dispatch("hello");
      expect(result).toMatchObject({ providerId: "desktop:tony", content: DESKTOP_LOST_MESSAGE });
      expect(polls()).toBe(0);
      expect(cancels()).toBe(0);
    }
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("all polls fail after one early success: the 'lost' message at the cap, never 'busy with an earlier request'", async () => {
    let n = 0;
    stubQueue(() => {
      if (++n > 1) unreachable();
      return { status: "pending", result: null, desktopBusy: true };
    });
    const p = dispatch("plan my week");
    await vi.advanceTimersByTimeAsync(245_000);
    expect((await p).result.content).toBe(DESKTOP_LOST_MESSAGE);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a notice in place of Tony's answer says so (`notice`), so a streamed partial answer is never overwritten by it", async () => {
    // The cap ran out while the desktop had it.
    stubQueue(() => ({ status: "running", result: null }));
    let p = dispatch("plan my week");
    await vi.advanceTimersByTimeAsync(245_000);
    expect(await p).toMatchObject({ notice: "waiting", result: { content: DESKTOP_STILL_WORKING_MESSAGE } });
    // The cancel got no answer: the gateway can't confirm it.
    h.gateway.mockReset();
    stubQueue(() => quiet(), undefined, unreachable);
    p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(17_000);
    expect(await p).toMatchObject({ notice: "unconfirmed", result: { content: DESKTOP_LOST_MESSAGE } });
    // A POST with no answer.
    h.gateway.mockReset();
    stubQueue(() => ({ status: "pending", result: null }), () => {
      throw new h.GatewayError("Gateway timed out");
    });
    expect(await dispatch("hello")).toMatchObject({ notice: "unconfirmed", result: { content: DESKTOP_LOST_MESSAGE } });
    // Tony's answer and the CLI's are answers: no notice.
    h.gateway.mockReset();
    stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "Hi from Tony" } } }));
    p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).notice).toBeUndefined();
    h.gateway.mockReset();
    stubQueue(() => quiet());
    p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(14_000);
    const cli = await p;
    expect(cli.result.providerId).toBe("gateway:opencode");
    expect(cli.notice).toBeUndefined();
  });
});

describe("dispatch on the phone: the caller's route reaches the desktop intact", () => {
  const done = () => ({ status: "done", result: { ok: true, result: { answer: "ok" } } });
  /** Dispatch on the phone against a queue that answers at once; resolves with the queued payload. */
  const queued = async (text: string, opts: Parameters<typeof dispatch>[1]) => {
    h.gateway.mockReset();
    stubQueue(done);
    const p = dispatch(text, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    const out = await p;
    return { out, payload: postedPayload() };
  };

  it("routeFor's Self goes as 'Self'; a plain no-match stays 'Default' (the desktop re-resolves it)", async () => {
    h.realRouter = true;
    const text = "what should I focus on this afternoon";
    expect(resolve(text, DEFAULT_ROUTING_CONFIG).kind).toBe("Default"); // the real router
    expect((await queued(text, { role: "general", routeKind: "Self" })).payload).toMatchObject({ text, role: "general", explicit: false, routeKind: "Self" });
    expect((await queued(text, { role: "general", routeKind: "Default" })).payload).toMatchObject({ text, role: "general", explicit: false, routeKind: "Default" });
    // No kind from the caller: dispatch's own read of the text.
    expect((await queued(text, { role: "general" })).payload).toMatchObject({ role: "general", routeKind: "Default" });
  });

  it("Android app: every queued turn carries stayWithTony (a re-resolved Default topic stays Tony's)", async () => {
    h.realRouter = true;
    h.android = true;
    const text = "what should I focus on this afternoon";
    expect((await queued(text, { role: "general", routeKind: "Default" })).payload).toMatchObject({ role: "general", routeKind: "Default", stayWithTony: true });
    expect((await queued(text, { role: "general", routeKind: "Self" })).payload).toMatchObject({ routeKind: "Self", stayWithTony: true });
  });

  it("PWA (not the Android app): no stayWithTony, the desktop's routing applies as is", async () => {
    h.realRouter = true;
    for (const routeKind of ["Default", "Self", undefined]) {
      const { payload } = await queued("what should I focus on this afternoon", { role: "general", routeKind });
      expect(payload, String(routeKind)).not.toHaveProperty("stayWithTony");
    }
  });

  it("role general from a Named / Direct / Tab caller keeps that kind", async () => {
    for (const routeKind of ["Named", "Direct", "Tab"]) {
      h.gateway.mockReset();
      stubQueue(done);
      const p = dispatch("hello", { role: "general", routeKind });
      await vi.advanceTimersByTimeAsync(2_000);
      await p;
      expect(postedPayload(), routeKind).toMatchObject({ role: "general", routeKind });
    }
  });

  it("another role keeps its caller's kind; no caller role still resolves; Tier 2 stays Self; a live-tool read is Direct", async () => {
    stubQueue(done);
    let p = dispatch("hello", { role: "booking", routeKind: "Domain" });
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(postedPayload()).toMatchObject({ role: "booking", routeKind: "Domain" });
    h.gateway.mockReset();
    stubQueue(done);
    p = dispatch("hello");
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(postedPayload()).toMatchObject({ role: "general", routeKind: "Default" });
    h.gateway.mockReset();
    stubQueue(done);
    p = dispatch("hello", { role: "general", routeKind: "Default", noDelegate: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(postedPayload()).toMatchObject({ role: "general", routeKind: "Self", routeReason: "brainstorm with Tony (Tier 2)", noDelegate: true });
    h.realRouter = true;
    h.gateway.mockReset();
    stubQueue(done);
    p = dispatch("any whatsapp updates", { role: "general", routeKind: "Self" });
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(postedPayload()).toMatchObject({ role: "general", routeKind: "Direct" });
  });
});

describe("dispatch on the phone: an approved Tier-3 hand-off reaches its agent", () => {
  const done = () => ({ status: "done", result: { ok: true, result: { answer: "Designer on it" } } });
  /** The voice controller's phone Tier-3 hand-off text (`offerDelegation`). */
  const handoff = (brief: string) => `[Tony — approved hand-off from a brainstorm with the user] Take it from here:\n${brief}`;
  const topic = handoff("A warmer color palette for the landing page, more orange in the hero.");

  async function queued(text: string, opts: Parameters<typeof dispatch>[1]) {
    h.gateway.mockReset();
    stubQueue(done);
    const p = dispatch(text, opts);
    await vi.advanceTimersByTimeAsync(2_000);
    const out = await p;
    return { out, payload: postedPayload() };
  }

  it("a Domain-topic hand-off is queued for the target agent as Named, not answered by Tony", async () => {
    h.realRouter = true;
    // The trap: its opener addresses Tony, so a plain re-read of the text says "Self".
    expect(resolve(topic, DEFAULT_ROUTING_CONFIG).kind).toBe("Self");
    expect(resolve(topic, DEFAULT_ROUTING_CONFIG, "", { ignoreSelfAddress: true })).toMatchObject({ kind: "Domain", role: "designer" });
    const { out, payload } = await queued(topic, { role: "designer", routeKind: "Named", history: [] });
    expect(out.role).toBe("designer");
    expect(out.result.content).toBe("Designer on it");
    expect(payload).toMatchObject({ text: topic, role: "designer", routeKind: "Named", explicit: false, noDelegate: false });
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("the caller's role stands even without a kind: read for its topic only, never 'Self'", async () => {
    h.realRouter = true;
    const { out, payload } = await queued(topic, { role: "designer" });
    expect(out.role).toBe("designer");
    expect(payload).toMatchObject({ role: "designer", routeKind: "Domain" });
  });

  it("a hand-off whose brief reads like a live-tool question still goes to its agent (a caller's Named, as in Rust)", async () => {
    h.realRouter = true;
    const weather = handoff("Moodboard for the rooftop shoot: will it rain tomorrow? Plan the palette around it.");
    const { directTool } = await vi.importActual<typeof import("./router")>("./router");
    expect(directTool(weather)).toBe("weather");
    expect((await queued(weather, { role: "designer", routeKind: "Named" })).payload).toMatchObject({ role: "designer", routeKind: "Named" });
    // Without the caller's Named it is Tony's live-tool read, as before.
    expect((await queued(weather, { role: "designer" })).payload).toMatchObject({ role: "general", routeKind: "Direct" });
  });

  it("on the Android app the hand-off keeps its agent and kind (stayWithTony only matters for a Default)", async () => {
    h.realRouter = true;
    h.android = true;
    expect((await queued(topic, { role: "designer", routeKind: "Named" })).payload).toMatchObject({ role: "designer", routeKind: "Named", stayWithTony: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Phone speed fixes: P1 (skip the dead-desktop wait), P2 (long-poll), P3 (onPartial), P4 (CLI prompt)
// ---------------------------------------------------------------------------------------------

type Srv = { status: string; result: unknown; partial: string; partialSeq: number; desktopSeenAt: number | null; desktopBusy: boolean };

/**
 * A long-poll gateway (os_api.py G1-G3): the POST reports the desktop's liveness; GET
 * /api/os/inbox/q1?wait=W&after=S is held until the status changes, `partialSeq` passes S, the
 * item finishes, or W runs out (fake timers). `cancel()` overrides the cancel route (default: 200
 * while pending, else 409). `at(ms, …)` changes the item at that time (the desktop claims, streams,
 * answers). `gets` records each GET's wait / after / request timeout / time.
 */
function fakeLongPoll(init: Partial<Srv> = {}, cancel?: () => unknown) {
  const t0 = Date.now();
  const s: Srv = { status: "pending", result: null, partial: "", partialSeq: 0, desktopSeenAt: Date.now() / 1000, desktopBusy: false, ...init };
  let waiters: Array<() => void> = [];
  const notify = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  const gets: Array<{ wait: number; after: number; timeoutMs?: number; at: number }> = [];
  h.gateway.mockImplementation(async (path: string, req?: { method?: string; timeoutMs?: number }) => {
    if (req?.method === "POST" && path === "/api/os/inbox/q1/cancel") {
      if (cancel) return cancel();
      if (s.status !== "pending" && s.status !== "cancelled") throw new h.GatewayError("409 Conflict", 409);
      s.status = "cancelled";
      notify();
      return { id: "q1", status: "cancelled" };
    }
    if (req?.method === "POST") return { id: "q1", status: "pending", desktopSeenAt: s.desktopSeenAt, desktopBusy: s.desktopBusy };
    const u = new URL(path, "http://gateway");
    expect(u.pathname).toBe("/api/os/inbox/q1");
    const wait = Number(u.searchParams.get("wait") ?? 0);
    const after = Number(u.searchParams.get("after") ?? -1);
    gets.push({ wait, after, timeoutMs: req?.timeoutMs, at: Date.now() - t0 });
    const began = s.status;
    const ready = () => wait === 0 || !["pending", "running"].includes(s.status) || s.status !== began || s.partialSeq > after;
    if (!ready()) {
      await new Promise<void>((resolve) => {
        let open = true;
        const finish = () => {
          if (!open) return;
          open = false;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, wait * 1000);
        const check = () => {
          if (!open) return;
          if (ready()) finish();
          else waiters.push(check);
        };
        waiters.push(check);
      });
    }
    return { id: "q1", status: s.status, result: s.result, partial: s.partial, partialSeq: s.partialSeq, desktopSeenAt: s.desktopSeenAt, desktopBusy: s.desktopBusy };
  });
  return {
    s,
    gets,
    at(ms: number, change: Partial<Srv> | (() => void)) {
      setTimeout(() => {
        if (typeof change === "function") change();
        else Object.assign(s, change);
        notify();
      }, ms - (Date.now() - t0));
    },
    delta(text: string) {
      s.partial += text;
      s.partialSeq++;
    },
  };
}

const answered = (answer: string) => ({ status: "done", result: { ok: true, result: { answer } } });
/** Resolve-tracking, so a test can say "not settled yet" without awaiting a promise that never settles. */
function track<T>(p: Promise<T>) {
  const t: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (v) => Object.assign(t, { done: true, value: v }),
    (e) => Object.assign(t, { done: true, error: e }),
  );
  return t;
}
const getPaths = () => h.gateway.mock.calls.filter(([, init]) => !init?.method).map(([path]) => String(path));

describe("P1: a desktop app that is off is given up at once, not after 12 s", () => {
  it("desktopOff: not busy and never seen / seen over 60 s ago; an answer without both fields never reads off", () => {
    const now = 1_000_000_000;
    expect(desktopOff({ desktopSeenAt: null, desktopBusy: false }, now)).toBe(true);
    expect(desktopOff({ desktopSeenAt: 0, desktopBusy: false }, now)).toBe(true);
    expect(desktopOff({ desktopSeenAt: now / 1000 - 61, desktopBusy: false }, now)).toBe(true);
    expect(desktopOff({ desktopSeenAt: now / 1000 - 59, desktopBusy: false }, now)).toBe(false);
    expect(desktopOff({ desktopSeenAt: null, desktopBusy: true }, now)).toBe(false);
    expect(desktopOff({ desktopSeenAt: now / 1000 - 600, desktopBusy: true }, now)).toBe(false);
    expect(desktopOff({}, now)).toBe(false); // a gateway POST from before long-poll
    expect(desktopOff({ desktopSeenAt: null }, now)).toBe(false);
    expect(desktopOff({ desktopBusy: false }, now)).toBe(false);
  });

  it("the POST says the desktop app is off: cancelled at once, then the CLI answers (no poll, no 12 s wait)", async () => {
    for (const desktopSeenAt of [null, 0, Date.now() / 1000 - 120]) {
      h.gateway.mockReset();
      h.chat.mockClear();
      fakeLongPoll({ desktopSeenAt });
      const t = track(dispatch("hello"));
      await vi.advanceTimersByTimeAsync(50);
      expect(t.done, String(desktopSeenAt)).toBe(true);
      expect(t.value?.result).toMatchObject({ providerId: "gateway:opencode", content: "CLI answer" });
      expect(cancels()).toBe(1);
      expect(polls()).toBe(0);
      // The cancel went out before the CLI ran.
      const cancelCall = h.gateway.mock.calls.findIndex(([path]) => String(path).endsWith("/cancel"));
      expect(h.gateway.mock.invocationCallOrder[cancelCall]).toBeLessThan(h.chat.mock.invocationCallOrder[0]);
    }
  });

  it("a gateway POST without liveness: the first poll that says off gives it up at once", async () => {
    stubQueue(() => ({ status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 120, desktopBusy: false }));
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(100);
    expect(t.done).toBe(true);
    expect(t.value?.result.providerId).toBe("gateway:opencode");
    expect(polls()).toBe(1);
    expect(cancels()).toBe(1);
  });

  it("busy, or seen 30 s ago (quiet, not off): no early give-up; a quiet desktop still gets the 12 s", async () => {
    // Busy with an earlier turn, never seen: keeps waiting and takes Tony's answer.
    let g = fakeLongPoll({ desktopSeenAt: null, desktopBusy: true });
    g.at(15_000, { status: "running" });
    g.at(16_000, answered("Tony here"));
    let t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(16_100);
    expect(t.value?.result).toMatchObject({ providerId: "desktop:tony", content: "Tony here" });
    expect(cancels()).toBe(0);
    // Seen 30 s ago: past the 15 s alive window, not the 60 s off one -> the 12 s pickup wait.
    h.gateway.mockReset();
    fakeLongPoll({ desktopSeenAt: Date.now() / 1000 - 30 });
    t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(11_900);
    expect(t.done).toBe(false);
    expect(cancels()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.value?.result.providerId).toBe("gateway:opencode");
    expect(cancels()).toBe(1);
  });

  it("off at the POST but the desktop claims it as the phone cancels (409): keeps waiting, Tony answers, no CLI", async () => {
    const g = fakeLongPoll({ desktopSeenAt: null }, conflict);
    g.at(500, { status: "running" });
    g.at(2_000, answered("Tony got it"));
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(t.value?.result).toMatchObject({ providerId: "desktop:tony", content: "Tony got it" });
    expect(cancels()).toBe(1);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("off at the POST and the cancel gets no answer: the 'lost' message, no CLI", async () => {
    fakeLongPoll({ desktopSeenAt: null }, unreachable);
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.value?.result).toMatchObject({ providerId: "desktop:tony", content: DESKTOP_LOST_MESSAGE });
    expect(cancels()).toBe(2);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("callers that never run it elsewhere (queueDesktopItem) keep the 12 s pickup wait: the item stays queued", async () => {
    stubQueue(() => ({ status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 120, desktopBusy: false }));
    const t = track(queueDesktopTurn(payload));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.done).toBe(false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(t).toMatchObject({ done: true, value: null });
    expect(cancels()).toBe(0);
  });
});

describe("P2: long-poll the queued item", () => {
  it("longPollWait: 20 s, only until the 12 s pickup while unclaimed, never past the cap, at least 1 s", () => {
    const cap = 240_000;
    expect(longPollWait(0, cap, false)).toBe(12);
    expect(longPollWait(5_000, cap, false)).toBe(7);
    expect(longPollWait(4_321, cap, false)).toBe(7.7); // rounded up, so it ends at or after 12 s
    expect(longPollWait(11_500, cap, false)).toBe(1);
    expect(longPollWait(12_000, cap, false)).toBe(20);
    expect(longPollWait(5_000, cap, true)).toBe(20);
    expect(longPollWait(230_000, cap, true)).toBe(10);
    expect(longPollWait(239_800, cap, true)).toBe(1);
    expect(longPollWait(0, 5_000, false)).toBe(5);
  });

  it("longPollWait: past the pickup, unclaimed and the desktop not busy, only until its desktopSeenAt turns 15 s old (at least 1 s)", () => {
    const cap = 240_000;
    const now = 1_000_000_000;
    const seen = (agoS: number, busy = false) => ({ desktopSeenAt: now / 1000 - agoS, desktopBusy: busy });
    expect(longPollWait(12_000, cap, false, seen(12), now)).toBe(3);
    expect(longPollWait(13_000, cap, false, seen(2.55), now)).toBe(12.5); // rounded up
    expect(longPollWait(12_000, cap, false, seen(14.5), now)).toBe(1);
    expect(longPollWait(12_000, cap, false, seen(40), now)).toBe(1); // already gone (or a skewed clock)
    expect(longPollWait(12_000, cap, false, seen(-30), now)).toBe(20); // never past 20 s
    expect(longPollWait(235_000, cap, false, seen(1), now)).toBe(5); // nor the cap
    // Kept at 20 s: busy, claimed, no liveness from the gateway, or the item wasn't pending.
    expect(longPollWait(12_000, cap, false, seen(12, true), now)).toBe(20);
    expect(longPollWait(12_000, cap, true, seen(12), now)).toBe(20);
    expect(longPollWait(12_000, cap, false, { desktopSeenAt: null, desktopBusy: false }, now)).toBe(20);
    expect(longPollWait(12_000, cap, false, undefined, now)).toBe(20);
    // Before the pickup decision the 12 s rule still applies.
    expect(longPollWait(5_000, cap, false, seen(5), now)).toBe(7);
  });

  it("a desktop that went quiet while an item waits unclaimed is noticed when its 15 s are up, not after another 20 s long-poll", async () => {
    vi.setSystemTime(1_800_000_000_000); // whole seconds: the 15 s edge is exact
    // The desktop polled at the POST, then closed: not busy, never claims the item.
    const g = fakeLongPoll({ desktopSeenAt: Date.now() / 1000, desktopBusy: false });
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(14_900);
    expect(t.done).toBe(false);
    expect(cancels()).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.done).toBe(true);
    expect(t.value?.result).toMatchObject({ providerId: "gateway:opencode", content: "CLI answer" });
    expect(cancels()).toBe(1);
    expect(g.gets.map((x) => [x.wait, x.after, x.at])).toEqual([
      [0, -1, 0], // the plain GET
      [12, 0, 0], // the first long-poll sends after=0
      [3, 0, 12_000], // seen at 0 s: alive until 15 s, so only that long
    ]);
    expect(getPaths()[1]).toBe("/api/os/inbox/q1?wait=12&after=0");
  });

  it("a desktop that keeps polling (seen fresh each answer) keeps an unclaimed item until it claims it", async () => {
    const g = fakeLongPoll({ desktopSeenAt: Date.now() / 1000, desktopBusy: false });
    const t0 = Date.now();
    // The desktop's own long-poll is open: the gateway reports it seen "now" on every answer.
    const impl = h.gateway.getMockImplementation()!;
    h.gateway.mockImplementation(async (path: string, init?: { method?: string }) => {
      const r = (await impl(path, init)) as Record<string, unknown>;
      return init?.method ? r : { ...r, desktopSeenAt: Date.now() / 1000 };
    });
    g.at(20_000, { status: "running" });
    g.at(21_000, answered("got there"));
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(21_100);
    expect(t.value?.result).toMatchObject({ providerId: "desktop:tony", content: "got there" });
    expect(cancels()).toBe(0);
    expect(h.chat).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(21_000);
  });

  it("after one plain GET, asks ?wait=W&after=S with a W+10 s timeout, and takes Tony's answer the moment it lands", async () => {
    const g = fakeLongPoll();
    g.at(300, { status: "running" });
    g.at(3_200, answered("Tony here"));
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(3_210);
    expect(t.value?.result).toMatchObject({ providerId: "desktop:tony", content: "Tony here" });
    // The plain GET (any gateway answers it at once) shows `partialSeq`; the claim ends the first
    // long-poll at once; the next is held until the answer.
    expect(g.gets.map(({ wait, after, at }) => ({ wait, after, at }))).toEqual([
      { wait: 0, after: -1, at: 0 },
      { wait: 12, after: 0, at: 0 },
      { wait: 20, after: 0, at: 300 },
    ]);
    expect(getPaths()).toEqual(["/api/os/inbox/q1", "/api/os/inbox/q1?wait=12&after=0", "/api/os/inbox/q1?wait=20&after=0"]);
    expect(g.gets.map((x) => x.timeoutMs)).toEqual([undefined, 12_000 + DESKTOP_LONG_POLL_PAD_MS, 20_000 + DESKTOP_LONG_POLL_PAD_MS]);
    expect(DESKTOP_LONG_POLL_PAD_MS).toBe(10_000);
  });

  it("an unclaimed item's wait ends at the 12 s pickup decision; with the desktop busy it then waits 20 s at a time", async () => {
    const g = fakeLongPoll({ desktopBusy: true, desktopSeenAt: null });
    g.at(25_000, { status: "running" });
    g.at(26_000, answered("after the earlier one"));
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(26_100);
    expect(t.value?.result.content).toBe("after the earlier one");
    expect(g.gets.map((x) => [x.wait, x.at])).toEqual([
      [0, 0], // the plain GET
      [12, 0],
      [20, 12_000],
      [20, 25_000],
    ]);
  });

  it("never waits past the cap", async () => {
    const g = fakeLongPoll({ status: "running" });
    const t = track(sendDesktopTurn(payload, { capMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.value).toEqual({ state: "timeout", claimed: true, polled: true, lastPollOk: true, busy: false });
    expect(g.gets.map((x) => x.wait)).toEqual([0, 20, 10]);
  });

  it("an older gateway (no partialSeq): only plain GETs, every 1.5 s after the first, exactly as before", async () => {
    stubQueue((ms) => (ms < 5_000 ? { status: "running", result: null } : answered("old gateway")));
    const seen: string[] = [];
    const t = track(dispatch("hello", { onPartial: (s) => seen.push(s) }));
    await vi.advanceTimersByTimeAsync(4_400);
    expect(t.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.value?.result.content).toBe("old gateway");
    expect(getPaths()).toEqual(Array(5).fill("/api/os/inbox/q1")); // 0, 1.5, 3, 4.5, 6 s
    expect(h.gateway.mock.calls.filter(([, init]) => !init?.method).every(([, init]) => init === undefined)).toBe(true); // the default timeout
    expect(seen).toEqual([]);
  });

  it("a long-poll blip is retried after the backoff, then the long-poll resumes", async () => {
    const g = fakeLongPoll();
    g.at(300, { status: "running" });
    g.at(4_000, answered("still here"));
    const impl = h.gateway.getMockImplementation()!;
    let n = 0;
    h.gateway.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (!init?.method && ++n === 3) throw new h.GatewayError("502 Bad Gateway", 502);
      return impl(path, init);
    });
    const t = track(dispatch("hello"));
    await vi.advanceTimersByTimeAsync(4_100);
    expect(t.value?.result.content).toBe("still here");
    expect(g.gets.map((x) => [x.wait, x.at])).toEqual([
      [0, 0],
      [12, 0],
      [20, 3_300], // the 502 at 300 ms, then the 3 s backoff
    ]);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a gateway that answers with partialSeq but doesn't hold the request is paced at 1.5 s, never spun", async () => {
    let n = 0;
    h.gateway.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === "POST") return { id: "q1" };
      if (++n > 100) throw new Error(`spun: ${path}`);
      return { status: "running", result: null, partial: "", partialSeq: 0, desktopSeenAt: Date.now() / 1000, desktopBusy: true };
    });
    const t = track(sendDesktopTurn(payload, { capMs: 15_000 }));
    await vi.advanceTimersByTimeAsync(15_100);
    expect(t.value).toMatchObject({ state: "timeout", claimed: true });
    expect(n).toBeLessThanOrEqual(12);
  });
});

describe("P3: onPartial streams Tony's answer while the desktop writes it", () => {
  it("the accumulated text each time partialSeq grows; the final answer comes back as before", async () => {
    const g = fakeLongPoll();
    const final = "Morning, Nic. You have two meetings today.";
    g.at(200, { status: "running" });
    g.at(1_000, () => g.delta("Morning, Nic. "));
    g.at(1_400, () => g.delta("You have two meetings"));
    g.at(1_800, () => g.delta(" today."));
    g.at(2_500, answered(final));
    const seen: string[] = [];
    const t = track(dispatch("what's on today", { onPartial: (s) => seen.push(s) }));
    await vi.advanceTimersByTimeAsync(2_600);
    expect(seen).toEqual(["Morning, Nic. ", "Morning, Nic. You have two meetings", final]);
    expect(t.value?.result).toMatchObject({ providerId: "desktop:tony", content: final, reason: "phone → desktop Tony" });
    // After the plain GET, each long-poll asks for what comes after the last delta it saw.
    expect(g.gets.map((x) => x.after)).toEqual([-1, 0, 0, 1, 2, 3]);
  });

  it("never after the final result: a last delta that lands with the result is not emitted", async () => {
    const g = fakeLongPoll();
    g.at(200, { status: "running" });
    g.at(500, () => g.delta("Hi"));
    g.at(1_000, () => {
      g.delta(" there.");
      Object.assign(g.s, answered("Hi there."));
    });
    const seen: string[] = [];
    const t = track(dispatch("hello", { onPartial: (s) => seen.push(s) }));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(t.value?.result.content).toBe("Hi there.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual(["Hi"]);
  });

  it("monotonic: an answer whose partialSeq isn't past the last one seen is not emitted", async () => {
    const answers = [
      { status: "running", result: null, partial: "Hello the", partialSeq: 2, desktopSeenAt: Date.now() / 1000, desktopBusy: true },
      { status: "running", result: null, partial: "Hel", partialSeq: 1, desktopSeenAt: Date.now() / 1000, desktopBusy: true },
      { status: "running", result: null, partial: "Hello there", partialSeq: 3, desktopSeenAt: Date.now() / 1000, desktopBusy: true },
      answered("Hello there."),
    ];
    let n = 0;
    h.gateway.mockImplementation(async (_path: string, init?: { method?: string }) => (init?.method === "POST" ? { id: "q1" } : answers[Math.min(n++, answers.length - 1)]));
    const seen: string[] = [];
    const t = track(dispatch("hello", { onPartial: (s) => seen.push(s) }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.value?.result.content).toBe("Hello there.");
    expect(seen).toEqual(["Hello the", "Hello there"]);
  });

  it("a listener that throws never ends the wait", async () => {
    const g = fakeLongPoll();
    g.at(200, { status: "running" });
    g.at(500, () => g.delta("Partial"));
    g.at(900, answered("Partial and final"));
    const t = track(
      dispatch("hello", {
        onPartial: () => {
          throw new Error("speech engine gone");
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.value?.result.content).toBe("Partial and final");
  });

  it("awaitDesktopItem passes it through for any caller", async () => {
    const g = fakeLongPoll({ status: "running" });
    g.at(100, () => g.delta("a"));
    g.at(200, answered("ab"));
    const seen: string[] = [];
    const t = track(awaitDesktopItem("q1", "turn", { onPartial: (s) => seen.push(s) }));
    await vi.advanceTimersByTimeAsync(300);
    expect(t.value).toEqual({ state: "done", result: { answer: "ab" } });
    expect(seen).toEqual(["a"]);
  });
});

describe("P4: the CLI fallback answers as the agent, to Nic", () => {
  it("frames the line so the CLI replies as the agent instead of reading the user as the agent", () => {
    const p = gatewayFallbackPrompt("Booking Desk", "book me a table for two");
    expect(p).toBe("You are Booking Desk, Nic's assistant in Agentic OS. Nic just said this from his phone; reply to him directly and briefly:\n\nbook me a table for two");
    expect(p.startsWith("[")).toBe(false);
  });

  it("the phone's fallback sends the framed prompt for the routed agent", async () => {
    stubQueue(() => quiet(), () => ({ id: "q1", status: "pending", desktopSeenAt: null, desktopBusy: false }));
    const t = track(dispatch("hello", { role: "booking" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(t.value?.role).toBe("booking");
    expect(h.chat).toHaveBeenCalledWith("opencode", gatewayFallbackPrompt("Booking Desk", "hello"));
    expect(h.chat.mock.calls[0][1]).not.toContain("[Booking Desk]");
  });
});
