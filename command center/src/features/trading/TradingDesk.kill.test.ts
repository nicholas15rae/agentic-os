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
// The real kill-switch module (its real 3-press createKillArm included), with the kill call observable.
const trip = vi.fn(async () => ({ incidentId: "i", ok: true, dryRun: false, cancelled: [], flatten: [], errors: [], steps: [] }));
// The live-kill in-flight count, controllable here (a zustand store reads its initial state in a server render).
const inFlight = { n: 0, on: false };
vi.mock("@/features/trading/kill-switch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kill-switch")>()),
  tripKillSwitch: (...a: unknown[]) => trip(...(a as [])),
  useKillInFlight: (sel: (s: { n: number; on: boolean }) => unknown) => sel(inFlight),
}));

import { KILL_CONFIRM_MS, KILL_PRESSES } from "./kill-switch-core";
import { TradingDesk } from "./TradingDesk";

afterEach(() => {
  vi.useRealTimers();
  Object.assign(inFlight, { n: 0, on: false });
  seen.length = 0;
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
    Object.assign(inFlight, { n: 1, on: true });
    expect(render().busy).toBe(true);
  });
  it("with the real arm, only the third click sends one LIVE kill (dryRun=false)", async () => {
    expect(KILL_PRESSES).toBe(3);
    const p = render();
    p.onPress();
    p.onPress();
    await Promise.resolve();
    expect(trip).not.toHaveBeenCalled();
    p.onPress();
    await Promise.resolve();
    expect(trip).toHaveBeenCalledTimes(1);
    expect(trip).toHaveBeenCalledWith(expect.any(String), false);
  });
  it("a click after a longer pause than the window starts the count over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const p = render();
    p.onPress();
    p.onPress();
    vi.setSystemTime(KILL_CONFIRM_MS + 1);
    p.onPress(); // press 1 of a new count
    p.onPress();
    await Promise.resolve();
    expect(trip).not.toHaveBeenCalled();
    p.onPress();
    await Promise.resolve();
    expect(trip).toHaveBeenCalledTimes(1);
  });
});
