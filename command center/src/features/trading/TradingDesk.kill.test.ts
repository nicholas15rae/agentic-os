// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Record exactly what TradingDesk hands the red button.
const seen: Record<string, unknown>[] = [];
vi.mock("@/features/trading/KillButton", () => ({ KillButton: (p: Record<string, unknown>) => (seen.push(p), null) }));
vi.mock("@/lib/gateway", () => ({ GatewayError: class extends Error {}, gateway: vi.fn(async () => ({})) }));
// notify.ts pulls in the voice engines (browser-only at import).
vi.mock("@/features/reminders/notify", () => ({ useToasts: () => () => undefined }));
// The real kill-switch module, with the 3-press arm and the kill call observable.
type Press = { kind: "arming"; remaining: number } | { kind: "fire" };
const arm = { press: vi.fn((_now: number): Press => ({ kind: "arming", remaining: 2 })), cancel: vi.fn(), isArmed: vi.fn(), pressed: vi.fn() };
const trip = vi.fn(async () => ({ incidentId: "i", ok: true, dryRun: false, cancelled: [], flatten: [], errors: [], steps: [] }));
// The live-kill in-flight flag, controllable here (a zustand store reads its initial state in a server render).
const inFlight = { on: false };
vi.mock("@/features/trading/kill-switch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kill-switch")>()),
  createKillArm: () => arm,
  tripKillSwitch: (...a: unknown[]) => trip(...(a as [])),
  useKillInFlight: (sel: (s: { on: boolean }) => unknown) => sel(inFlight),
}));

import { TradingDesk } from "./TradingDesk";

afterEach(() => {
  inFlight.on = false;
  seen.length = 0;
  arm.press.mockClear();
  trip.mockClear();
});

const render = () => {
  renderToStaticMarkup(createElement(TradingDesk));
  expect(seen).toHaveLength(1);
  return seen[0] as { pressed: number; busy: boolean; onPress: () => void };
};

describe("TradingDesk renders the red E-stop through KillButton only", () => {
  it("passes the click counter and its own live-kill flag, and no handler of its own", () => {
    const p = render();
    expect(Object.keys(p).sort()).toEqual(["busy", "onPress", "pressed"]);
    expect(p).toMatchObject({ pressed: 0, busy: false });
  });
  it("the E-stop is busy exactly while a live kill is in flight (its own flag, not the dry-run / reset slot)", () => {
    inFlight.on = true;
    expect(render().busy).toBe(true);
  });
  it("an arming click sends nothing; only the arm's 'fire' sends a LIVE kill (dryRun=false)", async () => {
    const p = render();
    arm.press.mockReturnValueOnce({ kind: "arming", remaining: 2 });
    p.onPress();
    expect(arm.press).toHaveBeenCalledWith(expect.any(Number)); // the tested createKillArm decides (3 presses, 4 s window)
    expect(trip).not.toHaveBeenCalled();
    arm.press.mockReturnValueOnce({ kind: "fire" });
    p.onPress();
    await Promise.resolve();
    expect(trip).toHaveBeenCalledTimes(1);
    expect(trip).toHaveBeenCalledWith(expect.any(String), false);
  });
});
