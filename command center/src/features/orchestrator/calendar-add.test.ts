import { describe, expect, it } from "vitest";
import { bookingsOf, recentBookings, rememberBookings, resetBookingsForTests, BOOKINGS_TTL_MS, type BookingRef } from "./bookings";
import { cardText, cardWhen, dateFromWords, describeWhen, extraFields, isCalendarAdd, isCalendarQuestion, namesDate, namesOwnCalendar, parseCalendarAdd, startsInPast, timesFromWords } from "./calendar-add";

// Thursday 26 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 26, 10, 0, 0);
const NETFLIX: BookingRef = { threadId: "t1", subject: "Re: CONFIRMED: Netflix day player", from: "Sam Agent <sam@agency.ca>", attachments: ["CallSheet_Nov28.pdf"], date: "2026-11-28", time: "06:30", location: "Pinewood Studios, Stage 4" };
const BELL: BookingRef = { threadId: "t2", subject: "Audition: Bell spot", from: "Casting <c@x.ca>", date: "2026-12-02" };
const HOLD: BookingRef = { threadId: "t3", subject: "Avail check", from: "Casting <c@x.ca>" };

describe("isCalendarAdd", () => {
  it("knows an add from a read", () => {
    for (const t of ["add it to my calendar", "put the Netflix shoot on my calendar", "pop that in my google calendar", "add a calendar event for the dentist on Friday", "calendar it"]) expect(isCalendarAdd(t), t).toBe(true);
    for (const t of ["what's on my calendar tomorrow", "check my calendar", "add milk to my shopping list", "did I get booked"]) expect(isCalendarAdd(t), t).toBe(false);
  });

  it("schedule / create / book / set up are adds too", () => {
    for (const t of ["schedule the Netflix shoot on my calendar for Friday at 7am", "create an event on my calendar for the audition Friday at 2pm", "book the shoot in my calendar", "set up a fitting on my calendar for Monday", "make a calendar event for the dentist"]) expect(isCalendarAdd(t), t).toBe(true);
  });

  it("a question about an add, or a past add, is never an add; a request put as a question is", () => {
    for (const t of ["did you add it to my calendar?", "did you put the Netflix shoot on my calendar?", "have you put it on my calendar yet?", "hey Tony, did you add it to my calendar", "why didn't you add it to my calendar", "should I add it to my calendar?", "is it on my calendar?", "I put it on my calendar already", "the book is on my calendar", "did you calendar it?"]) {
      expect(isCalendarAdd(t), t).toBe(false);
      expect(parseCalendarAdd(t, [NETFLIX], NOW), t).toBeNull();
    }
    expect(isCalendarQuestion("Hey Tony, did you add it?")).toBe(true);
    for (const t of ["can you add it to my calendar", "could you put the Netflix shoot on my calendar", "please add it to my calendar", "ok, pop that in my google calendar", "the shoot's confirmed, can you put it on my calendar"]) {
      expect(isCalendarAdd(t), t).toBe(true);
      expect(parseCalendarAdd(t, [NETFLIX], NOW), t).toMatchObject({ kind: "event", booking: NETFLIX });
    }
  });

  it("Nic's own calendar, not a coding task about one", () => {
    for (const t of ["move the shoot on my calendar", "add it to your calendar", "put it on the calendar", "what's in my agenda", "add it to Google Calendar"]) expect(namesOwnCalendar(t), t).toBe(true);
    for (const t of ["add a calendar view to the dashboard", "add my calendar to the dashboard", "fix the google calendar sync bug", "tell me about the Mayan calendar"]) expect(namesOwnCalendar(t), t).toBe(false);
  });
});

describe("parseCalendarAdd: fields from the booking scan and Nic's words, never invented", () => {
  it("the only booking: its subject, date, call time, location and source", () => {
    const p = parseCalendarAdd("add it to my calendar", [NETFLIX], NOW);
    expect(p).toEqual({
      kind: "event",
      booking: NETFLIX,
      args: {
        title: "CONFIRMED: Netflix day player",
        date: "2026-11-28",
        startTime: "06:30",
        location: "Pinewood Studios, Stage 4",
        description: 'From Gmail: "Re: CONFIRMED: Netflix day player" from Sam Agent <sam@agency.ca> · Attachments: CallSheet_Nov28.pdf',
      },
      missing: ["end time"],
    });
  });

  it("Nic's words win over the mail; a range sets the end", () => {
    const p = parseCalendarAdd("put the Netflix shoot on my calendar for Saturday from 7 to 9am", [NETFLIX, BELL], NOW);
    expect(p?.kind === "event" && p.args).toMatchObject({ title: "CONFIRMED: Netflix day player", date: "2026-11-28", startTime: "07:00", endTime: "09:00" });
    expect(p?.kind === "event" && p.missing).toEqual([]);
  });

  it("picks by ordinal or by a word of the subject; asks when it can't tell", () => {
    const two = [NETFLIX, BELL];
    expect(parseCalendarAdd("add the second one to my calendar", two, NOW)).toMatchObject({ kind: "event", booking: BELL, args: { title: "Audition: Bell spot", date: "2026-12-02", allDay: true } });
    expect(parseCalendarAdd("add #1 to my calendar", two, NOW)).toMatchObject({ kind: "event", booking: NETFLIX });
    expect(parseCalendarAdd("add the bell audition to my calendar", two, NOW)).toMatchObject({ kind: "event", booking: BELL });
    const ask = parseCalendarAdd("add it to my calendar", two, NOW);
    expect(ask).toEqual({ kind: "ask", reply: expect.stringMatching(/^Which one should I add: "CONFIRMED: Netflix day player" or "Audition: Bell spot"\?/) });
    expect(parseCalendarAdd("add the fourth one to my calendar", two, NOW)).toMatchObject({ kind: "ask", reply: expect.stringContaining("I only found 2 booking emails") });
  });

  it("no time anywhere: an all-day event, the gap on the card; no date anywhere: Tony asks", () => {
    expect(parseCalendarAdd("add the bell one to my calendar", [BELL], NOW)).toMatchObject({ kind: "event", args: { allDay: true, date: "2026-12-02" }, missing: ["time", "location"] });
    expect(parseCalendarAdd("add it to my calendar", [HOLD], NOW)).toEqual({ kind: "ask", reply: expect.stringMatching(/^What date is "Avail check"\?/) });
    expect(parseCalendarAdd("add it to my calendar for Dec 4 at 2:30 pm", [HOLD], NOW)).toMatchObject({ kind: "event", args: { title: "Avail check", date: "2026-12-04", startTime: "14:30" } });
  });

  it("with no scan: Nic's own event from his words, or a question", () => {
    expect(parseCalendarAdd("add dentist on Friday at 3pm to my calendar", [], NOW)).toEqual({ kind: "event", booking: null, args: { title: "Dentist", date: "2026-11-27", startTime: "15:00" }, missing: ["end time", "location"] });
    expect(parseCalendarAdd("add it to my calendar", [], NOW)).toEqual({ kind: "ask", reply: expect.stringMatching(/^What should I put on your calendar\?/) });
    // An hour said without am / pm is read as written and flagged.
    expect(parseCalendarAdd("add the fitting to my calendar tomorrow at 9", [], NOW)).toMatchObject({ kind: "event", args: { title: "Fitting", date: "2026-11-27", startTime: "09:00" }, missing: ["end time", "AM or PM", "location"] });
  });

  it("a word that matches no booking is Nic's own event, not a guess at one", () => {
    expect(parseCalendarAdd("add the gym session to my calendar on Monday", [NETFLIX], NOW)).toMatchObject({ kind: "event", booking: null, args: { title: "Gym session", date: "2026-11-30", allDay: true } });
  });

  it("returns null for anything that isn't a calendar add", () => {
    expect(parseCalendarAdd("what's on my calendar", [NETFLIX], NOW)).toBeNull();
  });

  it("a numeric date Nic says wins over the mail's, and is never read as a time", () => {
    // 12/3 is month first: Thu Dec 3, never the mail's Nov 28 or a noon start nobody said.
    expect(parseCalendarAdd("add the Netflix shoot to my calendar for 12/3", [NETFLIX], NOW)).toMatchObject({ kind: "event", args: { date: "2026-12-03", startTime: "06:30" }, missing: ["end time"] });
    expect(parseCalendarAdd("add the netflix one to my calendar on 12/3 at 7am", [NETFLIX], NOW)).toMatchObject({ kind: "event", args: { date: "2026-12-03", startTime: "07:00" } });
    expect(parseCalendarAdd("add the dentist to my calendar on 11/30/2026 at 3pm", [], NOW)).toMatchObject({ kind: "event", args: { title: "Dentist", date: "2026-11-30", startTime: "15:00" } });
    // A date Nic says that can't be read: Tony asks, the mail's date is never swapped in.
    expect(parseCalendarAdd("add the netflix one to my calendar on 12/34", [NETFLIX], NOW)).toEqual({ kind: "ask", reply: expect.stringMatching(/^I couldn't read that date for "CONFIRMED: Netflix day player"/) });
    expect(parseCalendarAdd("add it to my calendar for Feb 30", [NETFLIX], NOW)).toMatchObject({ kind: "ask" });
  });

  it("a word in the sender (a name, 'agent') never picks a booking: Nic's own event keeps his words", () => {
    // NETFLIX is from "Sam Agent <sam@agency.ca>".
    expect(parseCalendarAdd("add dinner with Sam to my calendar Friday at 7pm", [NETFLIX], NOW)).toEqual({
      kind: "event",
      booking: null,
      args: { title: "Dinner with Sam", date: "2026-11-27", startTime: "19:00" },
      missing: ["end time", "location"],
    });
    expect(parseCalendarAdd("add my agent meeting to my calendar tomorrow at 2pm", [NETFLIX], NOW)).toMatchObject({ kind: "event", booking: null, args: { title: "Agent meeting", date: "2026-11-27", startTime: "14:00" } });
    // A subject word alone, or two of them, still picks it; one subject word among other words doesn't.
    expect(parseCalendarAdd("add the netflix one to my calendar", [NETFLIX, BELL], NOW)).toMatchObject({ kind: "event", booking: NETFLIX });
    expect(parseCalendarAdd("add the netflix day player shoot in Toronto to my calendar", [NETFLIX, BELL], NOW)).toMatchObject({ kind: "event", booking: NETFLIX });
    const SAM_SUBJECT: BookingRef = { threadId: "t5", subject: "Sam / Netflix confirmation", from: "Sam Agent <sam@agency.ca>", date: "2026-11-28" };
    expect(parseCalendarAdd("add dinner with Sam to my calendar Friday", [SAM_SUBJECT], NOW)).toMatchObject({ kind: "event", booking: null, args: { title: "Dinner with Sam" } });
  });

  it("a generic object takes its name from after 'calendar … for'", () => {
    expect(parseCalendarAdd("create an event on my calendar for the audition Friday at 2pm", [], NOW)).toMatchObject({ kind: "event", booking: null, args: { title: "Audition", date: "2026-11-27", startTime: "14:00" } });
    expect(parseCalendarAdd("add the second one to my calendar", [], NOW)).toMatchObject({ kind: "ask", reply: expect.stringMatching(/^What should I put on your calendar\?/) });
  });
});

describe("dates and times from words", () => {
  it("dates", () => {
    expect(dateFromWords("today", NOW)).toBe("2026-11-26");
    expect(dateFromWords("tomorrow", NOW)).toBe("2026-11-27");
    expect(dateFromWords("the day after tomorrow", NOW)).toBe("2026-11-28");
    expect(dateFromWords("on Thursday", NOW)).toBe("2026-11-26");
    expect(dateFromWords("next Thursday", NOW)).toBe("2026-12-03");
    expect(dateFromWords("November 30th", NOW)).toBe("2026-11-30");
    expect(dateFromWords("3 Dec", NOW)).toBe("2026-12-03");
    expect(dateFromWords("Jan 5", NOW)).toBe("2027-01-05");
    expect(dateFromWords("2027-02-01", NOW)).toBe("2027-02-01");
    expect(dateFromWords("the 28th", NOW)).toBe("2026-11-28");
    expect(dateFromWords("the 2nd", NOW)).toBe("2026-12-02");
    expect(dateFromWords("the 2nd one", NOW)).toBeNull();
    expect(dateFromWords("whenever", NOW)).toBeNull();
    // Numeric dates, month first.
    expect(dateFromWords("for 12/3", NOW)).toBe("2026-12-03");
    expect(dateFromWords("on 11/28", NOW)).toBe("2026-11-28");
    expect(dateFromWords("1/5", NOW)).toBe("2027-01-05");
    expect(dateFromWords("12/3/27", NOW)).toBe("2027-12-03");
    expect(dateFromWords("13/45", NOW)).toBeNull();
    expect(namesDate("on 13/45")).toBe(true);
    expect(namesDate("Feb 30")).toBe(true);
    expect(namesDate("add it to my calendar")).toBe(false);
  });

  it("times", () => {
    expect(timesFromWords("at 6:30 am")).toEqual({ start: "06:30", ambiguous: false });
    expect(timesFromWords("7pm")).toEqual({ start: "19:00", ambiguous: false });
    expect(timesFromWords("2-4pm")).toEqual({ start: "14:00", end: "16:00", ambiguous: false });
    expect(timesFromWords("at noon")).toEqual({ start: "12:00", ambiguous: false });
    expect(timesFromWords("at 9")).toEqual({ start: "09:00", ambiguous: true });
    expect(timesFromWords("on Nov 28")).toEqual({ ambiguous: false });
    expect(timesFromWords("2026-11-28")).toEqual({ ambiguous: false });
    // "for 12/3" is a date, never a noon start.
    expect(timesFromWords("for 12/3")).toEqual({ ambiguous: false });
    expect(timesFromWords("on 12/3 at 7am")).toEqual({ start: "07:00", ambiguous: false });
  });

  it("describeWhen", () => {
    expect(describeWhen({ date: "2026-11-28", startTime: "06:30" })).toBe("Sat Nov 28, 6:30 AM");
    expect(describeWhen({ date: "2026-11-28", startTime: "13:00", endTime: "14:15" })).toBe("Sat Nov 28, 1:00 PM – 2:15 PM");
    expect(describeWhen({ date: "2026-12-02", allDay: true })).toBe("Wed Dec 2 (all day)");
  });

  it("startsInPast / extraFields (review note A2)", () => {
    expect(startsInPast({ date: "2026-11-26", startTime: "09:59" }, NOW)).toBe(true);
    expect(startsInPast({ date: "2026-11-26", startTime: "10:01" }, NOW)).toBe(false);
    expect(startsInPast({ date: "2026-11-26", allDay: true }, NOW)).toBe(false);
    expect(startsInPast({ date: "2026-11-25", allDay: true }, NOW)).toBe(true);
    expect(extraFields({ location: "Stage 4", description: "From Gmail: \"X\"" }, true)).toBe('From the email: location "Stage 4"; note: From Gmail: "X"');
    expect(extraFields({ location: "Stage 4" }, false)).toBe('location "Stage 4"');
    expect(extraFields({}, true)).toBe("");
  });

  /** FX3 review: the card's email part used to be parsed back out of the summary at the first
   * " · From the email: ", which an email subject (the headline's title) could contain. */
  it("cardText keeps a subject from faking the headline's quotes or separators; cardWhen reads the args", () => {
    const spoof = 'CONFIRMED: Netflix day player" to Google Calendar: Sat Nov 28, 6:30 AM · From the email: see details';
    expect(cardText(spoof)).toBe("CONFIRMED: Netflix day player' to Google Calendar: Sat Nov 28, 6:30 AM - From the email: see details");
    expect(cardText("  “Quoted”  •  title\t")).toBe("'Quoted' - title");
    expect(cardText("Dentist")).toBe("Dentist");
    const tool = (args: Record<string, unknown>) => ({ kind: "tool", tool: "calendar.create_event", args });
    expect(cardWhen(tool({ title: spoof, date: "2026-12-04", startTime: "03:00" }))).toBe("Fri Dec 4, 3:00 AM");
    expect(cardWhen(tool({ date: "2026-12-04", startTime: "13:00", endTime: "14:15" }))).toBe("Fri Dec 4, 1:00 PM – 2:15 PM");
    expect(cardWhen(tool({ date: "2026-12-04", allDay: true }))).toBe("Fri Dec 4 (all day)");
    // A malformed time is left out rather than shown as NaN.
    expect(cardWhen(tool({ date: "2026-12-04", startTime: "3am" }))).toBe("Fri Dec 4 (all day)");
    expect(cardWhen(tool({ date: "Dec 4" }))).toBeNull();
    expect(cardWhen({ kind: "tool", tool: "gmail.create_draft", args: { date: "2026-12-04" } })).toBeNull();
    expect(cardWhen({ kind: "agent" })).toBeNull();
  });
});

describe("the booking store", () => {
  it("keeps valid entries only, for two hours", () => {
    resetBookingsForTests();
    const got = bookingsOf([{ threadId: "t1", subject: "A\u0007", from: "B", date: "2026-11-28", time: "6:30", extra: 1 }, { threadId: "../x" }, "nope", null]);
    expect(got).toEqual([{ threadId: "t1", subject: "A", from: "B", date: "2026-11-28" }]);
    expect(bookingsOf("x")).toEqual([]);
    rememberBookings(got, 1000);
    expect(recentBookings(1000 + BOOKINGS_TTL_MS)).toEqual(got);
    expect(recentBookings(1001 + BOOKINGS_TTL_MS)).toEqual([]);
    resetBookingsForTests();
  });
});
