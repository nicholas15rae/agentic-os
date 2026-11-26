import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * execute() for an approved mutating agent plan: desktop app and phone alike, the agent health
 * check, then the gateway agent (opencode has real tools). Never an inbox turn for Tony on the
 * desktop: `os_turn` has no mutating tools, so a chat model there would only claim it acted.
 * Read-only plans still go through dispatch() with the plan's route kind.
 * The gateway is stubbed; timers are fake.
 */
const h = vi.hoisted(() => {
  class GatewayError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
    }
  }
  return { gateway: vi.fn(), chat: vi.fn(), health: vi.fn(), cmd: vi.fn(), desktop: false, android: false, GatewayError };
});

vi.mock("@/lib/gateway", () => ({ gateway: h.gateway, api: { chat: h.chat, agentsHealth: h.health }, GatewayError: h.GatewayError }));
vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => h.desktop }));
vi.mock("@/lib/cc-api", () => ({ cc: { agentSearch: vi.fn() } }));
vi.mock("@/stores/settings", () => ({ isDesktopApp: () => h.desktop, isAndroidApp: () => h.android }));
vi.mock("@/features/dispatcher/agents", () => ({
  SUB_AGENTS: {
    general: { label: "Tony", gatewayAgent: "opencode", systemPrompt: "", priority: "normal" },
    booking: { label: "Booking Desk", gatewayAgent: "opencode", systemPrompt: "", priority: "normal" },
  },
}));
vi.mock("@/features/dispatcher/router", () => ({ DEFAULT_ROUTING_CONFIG: {}, directTool: () => null, resolve: () => ({ kind: "Default", role: null, reason: "" }) }));

import { DESKTOP_LOST_MESSAGE } from "@/features/dispatcher/dispatch";
import { execute } from "./execute";
import type { ActionPlan } from "./plan";

const plan = (over: Partial<ActionPlan> = {}): ActionPlan => ({
  id: "p1",
  utterance: "book a table for two at Nori at 7",
  role: "booking",
  intent: "book a table",
  summary: "Book a table for two at Nori, 7 pm",
  readBack: "Book a table for two at Nori at 7? Proceed?",
  mutating: true,
  target: { kind: "agent" },
  payload: { venue: "Nori", time: "19:00", party: 2 },
  missing: [],
  verification: { status: "verified", notes: [] },
  planner: "heuristic",
  ...over,
});

type Poll = { status: string; result: unknown; desktopSeenAt?: number; desktopBusy?: boolean };

/** POST /api/os/inbox answers {id}; each inbox poll answers `statusAt(elapsedMs)`;
 * POST /api/os/inbox/q1/cancel answers (or throws) `cancel()`, by default 200. */
function stubQueue(statusAt: (elapsed: number) => Poll, cancel?: () => unknown) {
  const t0 = Date.now();
  h.gateway.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && path === "/api/os/inbox/q1/cancel") return cancel ? cancel() : { id: "q1", status: "cancelled" };
    if (init?.method === "POST") {
      expect(path).toBe("/api/os/inbox");
      return { id: "q1" };
    }
    expect(path).toBe("/api/os/inbox/q1");
    return statusAt(Date.now() - t0);
  });
}

const posted = () => JSON.parse(h.gateway.mock.calls.find(([, init]) => init?.method === "POST")![1].body);
const history = [{ role: "user" as const, content: "earlier line" }];
/** No desktop app: nothing running, last poll a minute ago. */
const quiet = (): Poll => ({ status: "pending", result: null, desktopSeenAt: Date.now() / 1000 - 60 });

beforeEach(() => {
  vi.useFakeTimers();
  h.desktop = false;
  h.android = false;
  for (const f of [h.gateway, h.chat, h.health, h.cmd]) f.mockReset();
  h.health.mockResolvedValue({ agents: [{ name: "opencode", status: "online" }] });
  h.chat.mockResolvedValue({ response: { content: "CLI did it" } });
});
afterEach(() => vi.useRealTimers());

describe("execute: approved mutating agent action", () => {
  /** The desktop app, the Android app and the PWA. */
  const surfaces = [
    { name: "desktop app", desktop: true, android: false },
    { name: "Android app", desktop: false, android: true },
    { name: "PWA", desktop: false, android: false },
  ];

  for (const s of surfaces) {
    it(`${s.name}: health check, then the gateway agent with the approved action — never an inbox turn`, async () => {
      h.desktop = s.desktop;
      h.android = s.android;
      const r = await execute(plan(), history);
      expect(h.gateway).not.toHaveBeenCalled(); // nothing queued for the desktop's Tony
      expect(h.health).toHaveBeenCalledTimes(1);
      expect(h.chat).toHaveBeenCalledTimes(1);
      const [agent, message] = h.chat.mock.calls[0];
      expect(agent).toBe("opencode");
      expect(message).toContain("[Booking Desk — action APPROVED by the user]");
      expect(message).toContain("Action: Book a table for two at Nori, 7 pm");
      expect(message).toContain('Details: {"venue":"Nori","time":"19:00","party":2}');
      expect(message).toContain('Original request: "book a table for two at Nori at 7"');
      expect(r.text).toBe("CLI did it");
      expect(r.meta).toMatch(/^Booking Desk → Agentic OS · opencode · \d+ms$/);
    });
  }

  it("phone: an uninstalled agent CLI fails plainly before anything is sent (and nothing is queued)", async () => {
    h.health.mockResolvedValue({ agents: [{ name: "opencode", status: "missing" }] });
    await expect(execute(plan(), history)).rejects.toThrow("Nothing was done — the opencode CLI isn't installed.");
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it("phone: a 503 from the gateway agent is 'not installed'; any other failure says nothing was done", async () => {
    h.chat.mockRejectedValueOnce(new h.GatewayError("503 Service Unavailable", 503));
    await expect(execute(plan(), history)).rejects.toThrow("Nothing was done — the opencode CLI isn't installed.");
    h.chat.mockRejectedValueOnce(new h.GatewayError("Gateway unreachable"));
    await expect(execute(plan(), history)).rejects.toThrow("Executor unreachable (Gateway unreachable) — nothing was done.");
    expect(h.gateway).not.toHaveBeenCalled();
  });
});

describe("execute: read-only plans go through dispatch() with the plan's route", () => {
  it("phone: a read-only chat whose cancel got no answer gets the 'lost' line, not a CLI answer", async () => {
    stubQueue(quiet, () => {
      throw new h.GatewayError("Gateway timed out");
    });
    const p = execute(plan({ mutating: false, role: "general", routeKind: "Self", utterance: "how's my week" }), history);
    await vi.advanceTimersByTimeAsync(17_000);
    expect((await p).text).toBe(DESKTOP_LOST_MESSAGE);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("phone: the plan's route kind is queued as given — Self stays Self, a plain no-match stays Default, a Tab pick stays Tab", async () => {
    for (const [routeKind, sent] of [["Self", "Self"], ["Default", "Default"], [undefined, "Default"], ["Tab", "Tab"]] as const) {
      h.gateway.mockReset();
      stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "Here's your week." } } }));
      const p = execute(plan({ mutating: false, role: "general", routeKind, utterance: "what's on this week" }), history);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await p).text).toBe("Here's your week.");
      expect(posted().payload, String(routeKind)).toMatchObject({ text: "what's on this week", role: "general", explicit: false, routeKind: sent });
      expect(posted().payload).not.toHaveProperty("stayWithTony"); // the PWA
    }
  });

  it("Android app: a plain no-match goes as Default with stayWithTony", async () => {
    h.android = true;
    stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "ok" } } }));
    const p = execute(plan({ mutating: false, role: "general", routeKind: "Default", utterance: "what's on this week" }), history);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(posted().payload).toMatchObject({ role: "general", routeKind: "Default", stayWithTony: true });
  });

  it("phone: a read-only plan is one queued turn, not explicit or approved", async () => {
    stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "You're free at 7." } } }));
    const p = execute(plan({ mutating: false, utterance: "am I free at 7?" }), history);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r.text).toBe("You're free at 7.");
    expect(posted().payload).toMatchObject({ text: "am I free at 7?", role: "booking", explicit: false });
    expect(posted().payload.approved).toBeUndefined();
    expect(h.chat).not.toHaveBeenCalled();
  });
});
