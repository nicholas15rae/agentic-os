import { afterEach, describe, expect, it } from "vitest";
import { recentBookings, rememberBookings, rememberScan, resetBookingsForTests, scanOf, type BookingRef } from "./bookings";

const NETFLIX: BookingRef = { threadId: "t1", subject: "CONFIRMED: Netflix day player", from: "Sam Agent <sam@agency.ca>", date: "2026-11-28" };

afterEach(() => resetBookingsForTests());

describe("scanOf / rememberScan", () => {
  it("tells 'no scan this turn' from 'a scan that found nothing'", () => {
    expect(scanOf(undefined)).toBeNull();
    expect(scanOf(null)).toBeNull();
    expect(scanOf({})).toBeNull();
    expect(scanOf([])).toEqual([]);
    expect(scanOf([{ threadId: "t1", subject: "CONFIRMED: Netflix day player", from: "Sam Agent <sam@agency.ca>", date: "2026-11-28" }])).toEqual([NETFLIX]);
  });

  it("a turn with no scan keeps the remembered list; an empty newer scan clears it (review note A2)", () => {
    const t0 = 1_000_000;
    rememberBookings([NETFLIX], t0);
    rememberScan(undefined, t0 + 1000);
    expect(recentBookings(t0 + 2000)).toEqual([NETFLIX]);
    // Rust now sends `bookings: []` when this turn's scan found nothing (the desktop's list was cleared).
    rememberScan([], t0 + 3000);
    expect(recentBookings(t0 + 4000)).toEqual([]);
    rememberScan([NETFLIX], t0 + 5000);
    expect(recentBookings(t0 + 6000)).toEqual([NETFLIX]);
  });
});
