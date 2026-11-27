import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/voice/voice-controller", () => ({ requestConfirmation: vi.fn() }));
vi.mock("@/lib/cc-api", () => ({ useCollection: vi.fn(), useNow: vi.fn() }));
vi.mock("@/lib/platform", () => ({ cmd: vi.fn(), isTauri: () => true }));

import { reminderCalendarPlan } from "./Reminders";

/**
 * A2 review (latent regression): "Add to Google Calendar" on a reminder built its card with
 * heuristicPlan('add "<title>" to my Google Calendar on <toLocaleString()>'), which the calendar-add
 * parser now owns; when that parse asked a question (an en-US "11/27/2026, 3:00:00 PM" date it can't
 * read) or the calendar was frozen, it set `plan.run`, and execute() runs `plan.run` first, so the
 * n8n `calendar-create` workflow never ran. The card is now built from the reminder alone.
 */
describe("reminderCalendarPlan", () => {
  it("is the n8n calendar-create card with no plan.run, whatever the date text or mode", () => {
    const dueAt = new Date(2026, 10, 27, 15, 0, 0).getTime();
    const p = reminderCalendarPlan({ id: "r1", title: "Dentist", dueAt, notes: "bring the form" });
    expect(p.run).toBeUndefined();
    expect(p.onCancel).toBeUndefined();
    expect(p).toMatchObject({ mutating: true, role: "booking", target: { kind: "n8n", workflow: "calendar-create" }, missing: [], verification: { status: "verified" } });
    expect(p.payload).toEqual({ reminderId: "r1", title: "Dentist", start: new Date(dueAt).toISOString(), end: new Date(dueAt + 30 * 60_000).toISOString(), notes: "bring the form" });
    expect(p.summary).toMatch(/^Add “Dentist” to Google Calendar — /);
    expect(p.readBack).toMatch(/^Add Dentist to your Google Calendar, .*Proceed\?$/);
    expect(p.source).toBeUndefined();
  });
});
