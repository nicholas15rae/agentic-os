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

import { ACTION_NEEDS_DESKTOP_MESSAGE, DESKTOP_LOST_MESSAGE } from "@/features/dispatcher/dispatch";
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

describe("execute: an approved calendar add (A2)", () => {
  const CAL = { title: "CONFIRMED: Netflix day player", date: "2026-11-28", startTime: "06:30", location: "Pinewood Studios" };
  const calPlan = () => plan({ id: "plan-7", role: "general", utterance: "add it to my calendar", summary: "Add it", target: { kind: "tool", tool: "calendar.create_event", args: CAL }, payload: CAL });

  it("desktop: the approved-only Rust command, never a gateway agent", async () => {
    h.desktop = true;
    h.cmd.mockResolvedValue('Added to your Google Calendar: "CONFIRMED: Netflix day player", Sat Nov 28, 6:30 AM – 7:30 AM. No invites were sent.');
    const r = await execute(calPlan(), history);
    expect(h.cmd).toHaveBeenCalledWith("gcal_create_event", { args: CAL, approved: true });
    expect(r.text).toMatch(/^Added to your Google Calendar/);
    expect(r.meta).toMatch(/^Google Calendar · add · \d+ms$/);
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.gateway).not.toHaveBeenCalled();
    h.cmd.mockRejectedValueOnce("PERMISSION_DENIED:mcp");
    await expect(execute(calPlan(), history)).rejects.toThrow("Nothing was done — MCP tools are set to Deny");
  });

  it("Android: an approved `action` inbox item the desktop runs; its answer comes back", async () => {
    h.android = true;
    stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "Added to your Google Calendar.", tool: "calendar.create_event" } } }));
    const p = execute(calPlan(), history);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r.text).toBe("Added to your Google Calendar.");
    const body = posted();
    expect(body.kind).toBe("action");
    expect(body.payload).toMatchObject({ tool: "calendar.create_event", args: CAL, planId: "plan-7" });
    expect(typeof body.payload.approvedAt).toBe("string");
    expect(h.cmd).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("Android, no desktop app: the item is taken back and nothing runs — never a CLI", async () => {
    h.android = true;
    stubQueue(quiet);
    const p = execute(calPlan(), history);
    const done = expect(p).rejects.toThrow(ACTION_NEEDS_DESKTOP_MESSAGE);
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(h.gateway.mock.calls.some(([path, init]) => path === "/api/os/inbox/q1/cancel" && init?.method === "POST")).toBe(true);
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.health).not.toHaveBeenCalled();
  });

  it("an approved agent-target plan about Nic's calendar never reaches a gateway agent", async () => {
    for (const s of [{ desktop: true, android: false }, { desktop: false, android: true }]) {
      h.desktop = s.desktop;
      h.android = s.android;
      for (const utterance of ["schedule the Netflix shoot on my calendar for Friday at 7am", "create an event on my calendar for the audition Friday at 2pm", "book the shoot in my calendar"]) {
        await expect(execute(plan({ role: "general", utterance, summary: "Calendar", payload: {} }), history), utterance).rejects.toThrow("Nothing was done — calendar adds go through Google Calendar.");
      }
      // The model planner's own words count too (its intent / summary / payload).
      await expect(execute(plan({ utterance: "lock in Friday's shoot", intent: "add the shoot to your calendar", summary: "Shoot" }), history)).rejects.toThrow("calendar adds go through Google Calendar");
      await expect(execute(plan({ utterance: "lock in Friday's shoot", summary: "Add the shoot to Google Calendar" }), history)).rejects.toThrow("calendar adds go through Google Calendar");
    }
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.health).not.toHaveBeenCalled();
    expect(h.gateway).not.toHaveBeenCalled();
    // A coding task about a calendar keeps its agent.
    h.desktop = true;
    await execute(plan({ utterance: "add a calendar view to the dashboard", summary: "Add a calendar view to the dashboard" }), history);
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it("Android: a Gmail draft goes the same way", async () => {
    h.android = true;
    stubQueue(() => ({ status: "done", result: { ok: true, result: { answer: "Draft saved in Gmail (not sent)." } } }));
    const args = { to: "sam@agency.ca", subject: "Avail", body: "Free Friday." };
    const p = execute(plan({ role: "general", target: { kind: "tool", tool: "gmail.create_draft", args }, payload: args }), history);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await p).text).toBe("Draft saved in Gmail (not sent).");
    expect(posted().payload).toMatchObject({ tool: "gmail.create_draft", args });
  });
});
