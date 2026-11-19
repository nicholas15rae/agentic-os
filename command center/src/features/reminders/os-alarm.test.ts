import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ cmd: vi.fn(), isTauri: () => false }));
vi.mock("@/stores/settings", () => ({ useSettings: { getState: () => ({ reminders: { osFallback: true } }) } }));

const { OS_GRACE_MS, osAlarmFixes, osAlarmRang } = await import("./os-alarm");

const NOW = 1_800_000_000_000;
const rem = (id: string, dueAt: number, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, kind: "alarm" as const, source: "local" as const, dueAt, ...extra });

describe("osAlarmFixes — follows changes made on any device", () => {
  it("cancels the task of a reminder deleted, dismissed or fired elsewhere", () => {
    const tasked = { gone: NOW + 60_000, dismissed: NOW + 60_000, fired: NOW + 60_000, kept: NOW + 60_000 };
    const list = [rem("dismissed", NOW + 60_000, { dismissed: true }), rem("fired", NOW + 60_000, { firedAt: NOW - 1 }), rem("kept", NOW + 60_000)];
    expect(osAlarmFixes(tasked, list, NOW)).toEqual({ cancel: ["gone", "dismissed", "fired"], move: [] });
  });

  it("re-registers a reminder snoozed or edited elsewhere at its new time", () => {
    const fix = osAlarmFixes({ a: NOW + 60_000 }, [rem("a", NOW + 3_600_000)], NOW);
    expect(fix).toEqual({ cancel: [], move: [{ id: "a", title: "T a", dueAt: NOW + 3_600_000 }] });
  });

  it("a time moved into the past only drops the task (the in-app scheduler decides)", () => {
    expect(osAlarmFixes({ a: NOW + 60_000 }, [rem("a", NOW - 1000)], NOW)).toEqual({ cancel: ["a"], move: [] });
  });

  it("leaves this-PC-only alarms (saved while the gateway was down) and untasked reminders alone", () => {
    expect(osAlarmFixes({ local: NOW + 60_000 }, [rem("phone-only", NOW + 60_000)], NOW, ["local"])).toEqual({ cancel: [], move: [] });
  });
});

describe("osAlarmRang — no second ring after Windows showed it", () => {
  const due = NOW;
  it("rang: this PC's task was for this time and has run by now", () => {
    expect(osAlarmRang(due, due, due + OS_GRACE_MS + 15_001)).toBe(true);
  });
  it("not yet, another time, or no task here: the app rings it", () => {
    expect(osAlarmRang(due, due, due + 5_000)).toBe(false);
    expect(osAlarmRang(due - 60_000, due, due + 120_000)).toBe(false);
    expect(osAlarmRang(undefined, due, due + 120_000)).toBe(false);
  });
});
