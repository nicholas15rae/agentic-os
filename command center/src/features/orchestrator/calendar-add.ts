import type { BookingRef } from "./bookings";

/**
 * "add it to my calendar", "put the Netflix shoot on my calendar for Friday at 6:30", "add the
 * second one to my calendar" → a Google Calendar event for the confirmation card, or Tony's
 * follow-up question. Pure: plan.ts turns the result into a mutating `calendar.create_event` plan.
 *
 * Every field comes from the last booking scan (`BookingRef`: the mail's subject, sender, the one
 * date it names, its call time and location line) or from Nic's own words; nothing is invented.
 * Nic's words win over the mail. A field neither gives is left out and listed in `missing` (the
 * card shows it): no time → an all-day event; no end → one hour (Rust's default).
 */

export interface CalendarArgs {
  title: string;
  /** YYYY-MM-DD (America/Toronto). */
  date: string;
  /** HH:MM, 24 h, on `date`; absent for an all-day event. */
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
}

export type CalendarParse =
  | { kind: "event"; args: CalendarArgs; missing: string[]; booking: BookingRef | null }
  | { kind: "ask"; reply: string };

/**
 * Where an add's verb may stand: the start of the line or a clause, or after a request lead ("can
 * you", "please", "I want you to"). "I put it on my calendar" / "did you add it…" / "the book is on
 * my calendar" have the verb elsewhere and are no add.
 */
const LEAD = String.raw`(?:^|[,.;:!?]\s*|\b(?:and|then|also|please|just|now|so|ok(?:ay)?|can you|could you|would you|will you|go ahead and|you can|let'?s|i'?d like (?:you )?to|i want (?:you )?to|i need (?:you )?to|i wanna|wanna)\s+)`;
const VERB = String.raw`(?:add|put|pop|stick|throw|save|pencil|block(?: out| off)?|schedule|create|book|set up|enter)`;
/** "add / put / schedule / book … to / on / in my calendar", "calendar it", "add a calendar event for …". */
const ADD = new RegExp(String.raw`${LEAD}${VERB}\b(.*?)\b(?:on|to|in|into|onto)\s+(?:my\s+|the\s+)?(?:google\s+)?calendar\b`, "i");
const ADD_EVENT = new RegExp(String.raw`${LEAD}(?:add|create|make|set up)\s+(?:an?\s+|the\s+)?(?:google\s+)?calendar\s+(?:event|entry)\b(?:\s+(?:for|about))?(.*)$`, "i");
const CAL_IT = new RegExp(String.raw`${LEAD}calendar\s+(?:it|that|this)\b`, "i");
/** A question about the calendar ("did you add it…?", "have you put the shoot on my calendar?",
 * "is it on my calendar?", "should I add it…?"): never an add, whatever verb it repeats. A request
 * put as a question ("can / could / would you add…") is an add. */
const QUESTION = /^(?:did|didn'?t|have|haven'?t|has|hasn'?t|had|hadn'?t|was|wasn'?t|were|weren'?t|is|isn'?t|are|aren'?t|do|does|doesn'?t|don'?t|should|shall|why|when|where|what|what'?s|how|who|which)\b/i;
/** Leading interjections and the name a line may open with ("hey Tony, did you…"). */
const OPENER = /^(?:(?:hey|hi|yo|ok(?:ay)?|so|um|uh|and|but|wait|oh|tony|jarvis)\b[\s,.!:;-]*)*/i;

export function isCalendarQuestion(text: string): boolean {
  return QUESTION.test(text.trim().replace(OPENER, ""));
}

export function isCalendarAdd(text: string): boolean {
  if (isCalendarQuestion(text)) return false;
  return ADD.test(text) || ADD_EVENT.test(text) || CAL_IT.test(text);
}

/** Nic's own calendar ("my calendar", "Google Calendar", "on the calendar", "my agenda"), not a
 * coding task about one ("add a calendar view to the dashboard"). */
const OWN_CALENDAR = /\b(?:my|your|google)\s+(?:google\s+)?calendar\b|\b(?:my|your)\s+agenda\b|\b(?:on|to|in|into|onto|from|off)\s+the\s+calendar\b/i;
const WORK = /\b(?:widget|server|config|api|bug|code|app|script|dashboard|component|page|view|ui|feature|endpoint|database|schema|tests?|integration|sync)\b/i;
export function namesOwnCalendar(text: string): boolean {
  return OWN_CALENDAR.test(text) && !WORK.test(text);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_DAY = new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d)\\b)?`, "i");
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b\\.?(?:,?\\s+(20\\d\\d)\\b)?`, "i");
const ISO = /\b(20\d\d)-(\d\d)-(\d\d)\b/;
/** A numeric date, month first (en-US / en-CA): "12/3", "11/28/2026", "1/5/27". */
const NUMERIC = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/;
/** Anything that reads as a date at all, parsed or not ("12/34", "Feb 30", "2026-13-01"). */
const DATE_SHAPED = new RegExp(String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\b${MON}\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MON}\b`, "i");
const THE_NTH = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:one|booking|email|thread|job|gig|shoot|audition)\b)/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const AMPM = String.raw`(a\.?m\.?|p\.?m\.?)`;
const RANGE = new RegExp(String.raw`\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*${AMPM}?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*${AMPM}?(?=\W|$)`, "i");
const AT_TIME = new RegExp(String.raw`\b(?:at|@|by|for)\s+(\d{1,2})(?::(\d{2}))?\s*${AMPM}?(?=\W|$)`, "i");
const BARE_TIME = new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${AMPM}(?=\W|$)|\b(\d{1,2}):(\d{2})\b`, "i");

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const valid = (y: number, m: number, d: number) => {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? t : null;
};

/** A month / day without a year: this year's, or next year's when that day is over a month gone. */
function withYear(m: number, d: number, y: number | undefined, today: Date): Date | null {
  if (y) return valid(y, m, d);
  const t = valid(today.getFullYear(), m, d);
  if (!t) return null;
  return (today.getTime() - t.getTime()) / 86_400_000 > 31 ? valid(today.getFullYear() + 1, m, d) : t;
}

const monthOf = (s: string) => MONTHS.findIndex((m) => s.toLowerCase().startsWith(m)) + 1;

/** The date Nic's words name (today / tomorrow / a weekday / "Nov 28" / "28 November" / ISO /
 * "12/3" month first / "the 28th"), YYYY-MM-DD. */
export function dateFromWords(text: string, now: Date): string | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let m: RegExpExecArray | null;
  if ((m = ISO.exec(text))) {
    const t = valid(+m[1], +m[2], +m[3]);
    return t ? ymd(t) : null;
  }
  if ((m = NUMERIC.exec(text))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    const t = withYear(+m[1], +m[2], y, today);
    return t ? ymd(t) : null;
  }
  if ((m = MONTH_DAY.exec(text))) {
    const t = withYear(monthOf(m[1]), +m[2], m[3] ? +m[3] : undefined, today);
    if (t) return ymd(t);
  }
  if ((m = DAY_MONTH.exec(text))) {
    const t = withYear(monthOf(m[2]), +m[1], m[3] ? +m[3] : undefined, today);
    if (t) return ymd(t);
  }
  if (/\bday after tomorrow\b/i.test(text)) return ymd(addDays(today, 2));
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i.test(text)) return ymd(today);
  if (/\btomorrow\b/i.test(text)) return ymd(addDays(today, 1));
  if ((m = WEEKDAY.exec(text))) {
    const ahead = (WEEKDAYS.indexOf(m[2].toLowerCase()) - today.getDay() + 7) % 7;
    return ymd(addDays(today, m[1] && ahead === 0 ? 7 : ahead));
  }
  if ((m = THE_NTH.exec(text))) {
    const d = +m[1];
    const t = valid(today.getFullYear(), today.getMonth() + 1, d);
    if (t && t >= today) return ymd(t);
    const next = valid(today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear(), ((today.getMonth() + 1) % 12) + 1, d);
    return next ? ymd(next) : null;
  }
  return null;
}

/** HH:MM from an hour / minute / am-pm; `ambiguous` when 1-11 was said without am / pm (read as written). */
function clock(h: number, min: number, ampm: string | undefined): { t: string; ambiguous: boolean } | null {
  const p = ampm?.toLowerCase().startsWith("p");
  const a = ampm?.toLowerCase().startsWith("a");
  if (ampm && (h < 1 || h > 12)) return null;
  let hh = h;
  if (p && h < 12) hh += 12;
  if (a && h === 12) hh = 0;
  if (hh > 23 || min > 59) return null;
  return { t: `${pad(hh)}:${pad(min)}`, ambiguous: !ampm && h >= 1 && h <= 11 };
}

/** Nic's words name a date, readable or not: one `dateFromWords` can't read ("12/34", "Feb 30")
 * means Tony asks, never that the mail's date is used instead. */
export function namesDate(text: string): boolean {
  return DATE_SHAPED.test(text);
}

/** `text` with every date cut out (so "for 12/3" or "Nov 28" never reads as a time). */
const withoutDates = (text: string) =>
  [ISO, NUMERIC, MONTH_DAY, DAY_MONTH, THE_NTH, DATE_SHAPED].reduce((s, re) => s.replace(new RegExp(re.source, "gi"), " "), text);

/** The time Nic's words give: a range ("from 9 to 11am", "2-4pm") or one time ("at 6:30", "7pm", "noon"). Dates are cut first. */
export function timesFromWords(text: string): { start?: string; end?: string; ambiguous: boolean } {
  const t = withoutDates(text);
  let m: RegExpExecArray | null;
  if ((m = RANGE.exec(t))) {
    const endAmpm = m[6] ?? m[3];
    const s = clock(+m[1], m[2] ? +m[2] : 0, m[3] ?? endAmpm);
    const e = clock(+m[4], m[5] ? +m[5] : 0, endAmpm);
    if (s && e && e.t > s.t) return { start: s.t, end: e.t, ambiguous: s.ambiguous || e.ambiguous };
  }
  if (/\bnoon\b/i.test(t)) return { start: "12:00", ambiguous: false };
  if ((m = AT_TIME.exec(t))) {
    const c = clock(+m[1], m[2] ? +m[2] : 0, m[3]);
    if (c) return { start: c.t, ambiguous: c.ambiguous };
  }
  if ((m = BARE_TIME.exec(t))) {
    const c = m[1] ? clock(+m[1], m[2] ? +m[2] : 0, m[3]) : clock(+m[4], +m[5], undefined);
    if (c) return { start: c.t, ambiguous: c.ambiguous };
  }
  return { ambiguous: false };
}

const ORDINALS: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4 };
/** "the second (one)", "the 2nd booking", "#2", "number 2"; never a date ("the 2nd of December", "the 28th"). */
const ORDINAL = /\bthe\s+(?:(first|second|third|fourth|fifth|last)\b(?!\s+(?:of|week|day|month|thing)\b)|(1st|2nd|3rd|4th|5th)\s+(?:one|booking|email|thread|job|gig|shoot|audition)\b)|#\s?(\d)\b|\bnumber\s+(\d)\b/i;
/** Words that pick nothing ("it", "the booking", dates, times, the calendar itself). */
const STOP = new Set(
  "it that this them those these the a an my your our one ones booking bookings shoot shoots job jobs gig gigs audition auditions callback callbacks hold holds event events entry entries email emails mail thread to on in into onto for at from with and or of please calendar google add put pop stick throw save pencil block out off schedule create book set enter today tonight tomorrow morning afternoon evening next am pm noon day week first second third fourth fifth last new also too just thing something".split(" "),
);
/** Words that only point at something ("it", "that one", "the booking", "an event"): no name. */
const POINTERS = new Set("it that this them those these the a an my one ones booking bookings email emails mail thread event events entry something thing first second third fourth fifth last 1st 2nd 3rd 4th 5th number".split(" "));
const cleanSubject = (s: string) => s.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
/** Whole lower-case words, a possessive's "'s" dropped ("Netflix's" → "netflix"). */
const tokens = (s: string) => s.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** The content words of the object phrase (what Nic called the event). */
function contentWords(phrase: string): string[] {
  return tokens(withoutDates(phrase)).filter((w) => w.length >= 3 && !STOP.has(w) && !WEEKDAYS.includes(w) && !/^\d/.test(w));
}

/**
 * Nic's words name this booking: they match whole words of its SUBJECT (never the sender, whose
 * name or role, "Sam", "agent", "casting", says nothing about which job it is). Two words matching,
 * or one word with nothing else said, picks it; one match among other words ("dinner with Sam"
 * against "Sam / Netflix confirmation") is Nic's own event.
 */
function namesBooking(b: BookingRef, words: string[]): boolean {
  const subject = new Set(tokens(cleanSubject(b.subject)));
  const has = (w: string) => subject.has(w) || subject.has(`${w}s`) || (w.endsWith("s") && subject.has(w.slice(0, -1)));
  const matched = words.filter(has).length;
  return matched >= 2 || (matched === 1 && words.length === 1);
}

/** A generic object ("an event", "an entry", "something") names nothing: the words after
 * "calendar" ("…on my calendar for the dentist Friday") say what it is. */
const GENERIC_OBJECT = /^(?:(?:an?|the|new)\s+)?(?:event|entry|appointment|reminder|something|thing)$/i;
const TAIL = /\bcalendar\b\s*(?:event|entry)?\s*(?:for|about|called|named|titled)\s+(.+)$/i;

/** "Which one" when more than one booking could be meant. */
function whichOne(list: BookingRef[]): string {
  const names = list.slice(0, 3).map((b) => `"${cleanSubject(b.subject) || "(no subject)"}"`);
  const said = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  return `Which one should I add: ${said}? Say "add the first one to my calendar", or name it.`;
}

/** The object phrase: what sits between the verb and "to my calendar" (or after "calendar event
 * for"); a generic one ("an event") gives way to what follows "calendar … for". */
function objectPhrase(text: string): string {
  const m = ADD.exec(text) ?? ADD_EVENT.exec(text);
  const phrase = (m?.[1] ?? "").trim();
  if (GENERIC_OBJECT.test(phrase)) return (TAIL.exec(text)?.[1] ?? "").trim();
  return phrase;
}

export function parseCalendarAdd(text: string, bookings: BookingRef[], now: Date): CalendarParse | null {
  if (!isCalendarAdd(text)) return null;
  const phrase = objectPhrase(text);
  const words = contentWords(phrase);
  // Which booking: an ordinal, else the one whose subject Nic's words name, else the only one.
  let booking: BookingRef | null = null;
  const o = ORDINAL.exec(text);
  if (o && bookings.length) {
    const word = (o[1] ?? o[2])?.toLowerCase();
    const i = word === "last" ? bookings.length - 1 : word ? ORDINALS[word] : Number(o[3] ?? o[4]) - 1;
    booking = bookings[i] ?? null;
    if (!booking) return { kind: "ask", reply: `I only found ${bookings.length} booking email${bookings.length === 1 ? "" : "s"}. ${whichOne(bookings)}` };
  } else if (words.length) {
    const hits = bookings.filter((b) => namesBooking(b, words));
    if (hits.length === 1) booking = hits[0];
    else if (hits.length > 1) return { kind: "ask", reply: whichOne(hits) };
  } else if (bookings.length === 1) {
    booking = bookings[0];
  } else if (bookings.length > 1) {
    return { kind: "ask", reply: whichOne(bookings) };
  }
  const own = withoutDates(phrase)
    .replace(/^(?:a|an|the|my)\s+/i, "")
    .replace(/\s+(?:on|for|at|by|from|this|next|tomorrow|today|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,.;:!?-]+$/, "")
    .trim();
  const title = booking ? cleanSubject(booking.subject) : own.charAt(0).toUpperCase() + own.slice(1);
  // Nic's own event needs a name of its own ("the audition" is one; "it" / "that one" is not).
  const named = tokens(own).some((w) => !POINTERS.has(w) && !/^\d+$/.test(w));
  if (!title || (!booking && !named)) {
    return { kind: "ask", reply: 'What should I put on your calendar? Check your booking emails first ("check my Gmail for bookings"), or say it like "add the Netflix shoot to my calendar for Friday at 7 AM".' };
  }
  const shown = title.length > 60 ? `${title.slice(0, 57)}…` : title;
  const saidDate = dateFromWords(text, now);
  // A date Nic said that can't be read is asked about, never swapped for the mail's.
  if (!saidDate && namesDate(text)) {
    return { kind: "ask", reply: `I couldn't read that date for "${shown}". Say it like "Friday", "Dec 3" or "12/3" (month first).` };
  }
  const date = saidDate ?? booking?.date ?? null;
  if (!date) return { kind: "ask", reply: `What date is "${shown}"? Say it like "add it to my calendar for Friday at 9 AM".` };
  const said = timesFromWords(text);
  const start = said.start ?? booking?.time;
  const missing: string[] = [];
  const args: CalendarArgs = { title: title.slice(0, 200), date };
  if (start) {
    args.startTime = start;
    if (said.start && said.end) args.endTime = said.end;
    else missing.push("end time");
    if (said.start && said.ambiguous) missing.push("AM or PM");
  } else {
    args.allDay = true;
    missing.push("time");
  }
  if (booking?.location) args.location = booking.location;
  else missing.push("location");
  if (booking) {
    const files = booking.attachments?.length ? ` · Attachments: ${booking.attachments.join(", ")}` : "";
    args.description = `From Gmail: "${booking.subject}"${booking.from ? ` from ${booking.from}` : ""}${files}`.slice(0, 500);
  }
  return { kind: "event", args, missing, booking };
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const twelve = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
};

/** The event starts before `now` (an all-day one: on a day before today). Rust still refuses a start
 * more than a day in the past (`calendar::create_body`); the card says so for any past start. */
export function startsInPast(a: Pick<CalendarArgs, "date" | "startTime" | "allDay">, now: Date): boolean {
  const [y, m, d] = a.date.split("-").map(Number);
  if (a.allDay || !a.startTime) return new Date(y, m - 1, d) < new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [h, min] = a.startTime.split(":").map(Number);
  return new Date(y, m - 1, d, h, min) < now;
}

/**
 * The fields an add carries besides its title and time, for the card's "From the email" box
 * (`fromEmail` false: the box is the label) and the spoken read-back: `From the email: location
 * "…"; note: …` when they came from a booking email (untrusted data, so Nic sees every word
 * before approving, not only in the collapsed Payload); "" when there are none.
 */
export function extraFields(a: Pick<CalendarArgs, "location" | "description">, fromEmail: boolean): string {
  const parts = [a.location ? `location "${a.location}"` : "", a.description ? `note: ${a.description}` : ""].filter(Boolean);
  if (!parts.length) return "";
  return `${fromEmail ? "From the email: " : ""}${parts.join("; ")}`;
}

/**
 * An email-supplied title as the card's headline and the read-back quote it: double quotes
 * (straight or curly) become single ones and "·" a dash, so a subject can't close the quote early
 * or pose as the card's own separators ('X" to Google Calendar: Sat Nov 28, 6:30 AM · …' would
 * otherwise read as the headline's time). Whitespace collapsed. The event's own title is unchanged.
 * Pure.
 */
export function cardText(s: string): string {
  return s.replace(/["“”]/g, "'").replace(/[·•]/g, "-").replace(/\s+/g, " ").trim();
}

const HHMM = /^\d{2}:\d{2}$/;

/**
 * The card's "When" line for an approved-only calendar add, from the plan's own args (what Rust
 * creates), never from text an email supplied: "Fri Dec 4, 3:00 AM". null for any other plan, or
 * args without a valid date. Pure.
 */
export function cardWhen(target: { kind: string; tool?: string; args?: Record<string, unknown> }): string | null {
  if (target.kind !== "tool" || target.tool !== "calendar.create_event") return null;
  const a = target.args ?? {};
  if (typeof a.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return null;
  const time = (k: string) => (typeof a[k] === "string" && HHMM.test(a[k] as string) ? (a[k] as string) : undefined);
  return describeWhen({ date: a.date, startTime: time("startTime"), endTime: time("endTime"), allDay: a.allDay === true });
}

/** "Sat Nov 28, 6:30 AM – 7:30 AM" / "Sat Nov 28 (all day)" for the card and the read-back. */
export function describeWhen(a: Pick<CalendarArgs, "date" | "startTime" | "endTime" | "allDay">): string {
  const [y, m, d] = a.date.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const head = `${WD[day.getDay()]} ${MO[m - 1]} ${d}`;
  if (a.allDay || !a.startTime) return `${head} (all day)`;
  return a.endTime ? `${head}, ${twelve(a.startTime)} – ${twelve(a.endTime)}` : `${head}, ${twelve(a.startTime)}`;
}
