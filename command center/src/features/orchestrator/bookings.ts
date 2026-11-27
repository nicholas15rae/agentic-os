/**
 * The last booking-mail scan's threads (Rust `gmail::Booking`, `OsTurnResult.bookings`), for the
 * calendar-add card (`calendar-add.ts`). Its fields are the mail's own (subject, sender, attachment
 * names) plus what Rust read plainly from it (the one date it names, a call time, a location line);
 * never a model's guess. Mail content is untrusted data: these fields are only ever shown on the
 * card for Nic to approve, never followed.
 *
 * The desktop reads them from Rust (`gmail_last_bookings`); the phone keeps what its last queued
 * turn returned (`rememberBookings`, called by `dispatch`). Memory only, two hours.
 */

export interface BookingRef {
  threadId: string;
  subject: string;
  from: string;
  /** When the latest message arrived (the bridge's date text). */
  received?: string;
  attachments?: string[];
  /** YYYY-MM-DD: the one date the mail names. */
  date?: string;
  /** HH:MM (24 h): the call time it states. */
  time?: string;
  location?: string;
}

export const BOOKINGS_TTL_MS = 2 * 3600 * 1000;

let last: { at: number; list: BookingRef[] } | null = null;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/** `OsTurnResult.bookings` (any shape) → valid entries only. Pure. */
export function bookingsOf(v: unknown): BookingRef[] {
  if (!Array.isArray(v)) return [];
  const out: BookingRef[] = [];
  for (const b of v.slice(0, 10)) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    const threadId = str(o.threadId, 64);
    if (!/^[A-Za-z0-9]+$/.test(threadId)) continue;
    const date = str(o.date, 10);
    const time = str(o.time, 5);
    const ref: BookingRef = { threadId, subject: str(o.subject, 200), from: str(o.from, 200) };
    if (str(o.received, 64)) ref.received = str(o.received, 64);
    if (Array.isArray(o.attachments)) ref.attachments = o.attachments.map((a) => str(a, 80)).filter(Boolean).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) ref.date = date;
    if (/^\d{2}:\d{2}$/.test(time)) ref.time = time;
    if (str(o.location, 120)) ref.location = str(o.location, 120);
    out.push(ref);
  }
  return out;
}

/**
 * `OsTurnResult.bookings` → this turn's scan: `null` when no scan ran (the field is absent: Rust
 * sends it only when this turn's scan replaced its own remembered list), else the valid entries
 * (`[]`: the scan found nothing). Pure.
 */
export function scanOf(v: unknown): BookingRef[] | null {
  return Array.isArray(v) ? bookingsOf(v) : null;
}

/** The phone: keep a queued turn's scan (an empty scan clears the last one). */
export function rememberBookings(list: BookingRef[], now = Date.now()): void {
  last = { at: now, list };
}

/** The phone: apply a queued turn's `bookings` field (`scanOf`): no scan keeps the remembered
 * list, a scan (even an empty one) replaces it, as the desktop's Rust list is replaced. */
export function rememberScan(v: unknown, now = Date.now()): void {
  const scan = scanOf(v);
  if (scan) rememberBookings(scan, now);
}

/** The last scan while fresh (`BOOKINGS_TTL_MS`). */
export function recentBookings(now = Date.now()): BookingRef[] {
  return last && now - last.at <= BOOKINGS_TTL_MS ? last.list : [];
}

export function resetBookingsForTests(): void {
  last = null;
}
