/**
 * Spaced repetition (SM-2 style) for saved Library phrases. Pure and clock-injected: every
 * function takes `now` (ms since epoch), so the same inputs always give the same schedule.
 *
 * Storage: the `srs` table next to `phrases` in library.db (one row per phrase, created on the
 * first review). Rust (`language_hub.rs`) and the gateway (`language_hub_api.py`) only validate and
 * persist what this module computes, so there is ONE scheduler. A phrase with no row yet is a new
 * card, due at the moment it was saved — i.e. due now. (Phrases marked learning / mastered before the
 * `srs` table existed have no row either: see `legacySrs`.)
 *
 * Early reviews: a card answered before it is due (the deck and today's lesson fill up with
 * not-yet-due cards) is PRACTICE. "Got it" / "Hard" on it changes nothing — no reps, no interval, no
 * mastery — so two taps a minute apart can't make a phrase "mastered". "Again" still counts: missing
 * a card is information whenever it happens.
 */
import type { LangEntry, Mastery, SrsState } from "./contract";

export type SrsGrade = "again" | "hard" | "good";

export const DAY_MS = 86_400_000;
export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
export const START_EASE = 2.5;
/** A missed card comes back later in the same sitting rather than tomorrow. */
export const RELEARN_MS = 10 * 60_000;
export const MAX_INTERVAL_DAYS = 3650;

/** The schedule a phrase has before its first review: due when it was saved. */
export function initialSrs(savedAt: number): SrsState {
  return { ease: START_EASE, interval_days: 0, due_at: savedAt, reps: 0, lapses: 0, last_review: null };
}

/** Default interval for a phrase marked mastered before spaced repetition existed. */
export const LEGACY_MASTERED_DAYS = 14;

/**
 * The schedule of a phrase with no `srs` row. A "new" (or "learning") phrase is due since it was
 * saved. A phrase already "mastered" before 763dab0 is treated as a learned card last seen when it
 * was saved (the phrases table has no updated-at column, so the save time is the only anchor) with a
 * 14-day interval — it comes back 14 days after saving instead of counting as overdue from day one.
 */
export function legacySrs(e: Pick<LangEntry, "timestamp"> & { mastery_status?: Mastery }): SrsState {
  if (e.mastery_status === "mastered") {
    return {
      ease: START_EASE,
      interval_days: LEGACY_MASTERED_DAYS,
      due_at: e.timestamp + LEGACY_MASTERED_DAYS * DAY_MS,
      reps: 2,
      lapses: 0,
      last_review: e.timestamp,
    };
  }
  return initialSrs(e.timestamp);
}

export function srsOf(e: Pick<LangEntry, "timestamp"> & { srs?: SrsState | null; mastery_status?: Mastery }): SrsState {
  return normalizeSrs(e.srs) ?? legacySrs(e);
}

/** True when grading `prev` at `now` is early: the card isn't due yet. */
export const isEarly = (prev: SrsState, now: number) => prev.due_at > now;

const clampEase = (x: number) => Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(x * 100) / 100));
const clampDays = (x: number) => Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(x)));

/**
 * One review. `good` ("Got it"): 1 day, then 6, then interval × ease. `hard`: ease −0.15 and a
 * shorter step (×1.2, at least +1 day). `again` ("Review"): a lapse once the card had been learned,
 * reps back to 0, ease −0.2, due again in 10 minutes. Ease never drops below 1.3.
 */
export function review(prev: SrsState, grade: SrsGrade, now: number): SrsState {
  // Practice on a card that isn't due: "Got it" / "Hard" don't move the schedule (see top of file).
  if (grade !== "again" && isEarly(prev, now)) return prev;
  if (grade === "again") {
    return {
      ease: clampEase(prev.ease - 0.2),
      interval_days: 0,
      due_at: now + RELEARN_MS,
      reps: 0,
      lapses: prev.lapses + (prev.reps > 0 ? 1 : 0),
      last_review: now,
    };
  }
  const reps = prev.reps + 1;
  let ease = prev.ease;
  let days: number;
  if (grade === "hard") {
    ease = clampEase(ease - 0.15);
    days = reps === 1 ? 1 : clampDays(Math.max(prev.interval_days + 1, prev.interval_days * 1.2));
  } else {
    days = reps === 1 ? 1 : reps === 2 ? 6 : clampDays(prev.interval_days * ease);
  }
  days = clampDays(days);
  return { ease: clampEase(ease), interval_days: days, due_at: now + days * DAY_MS, reps, lapses: prev.lapses, last_review: now };
}

/** Mastery after a graded review (the Library's chip). `hard` never promotes past learning. */
export function masteryAfter(current: Mastery, grade: SrsGrade, next?: SrsState): Mastery {
  if (grade === "again") return "learning";
  if (grade === "hard") return current === "new" ? "learning" : current;
  if (current === "new") return "learning";
  // Mastered once it has survived a few spaced reviews (or was already).
  return current === "mastered" || !next || next.reps >= 2 ? "mastered" : "learning";
}

/** True when this answer is practice only (an early "Got it" / "Hard"): nothing needs saving. */
export function isPracticeReview(e: LangEntry, grade: SrsGrade, now: number): boolean {
  return grade !== "again" && isEarly(srsOf(e), now);
}

/**
 * The patch a review writes back: the new schedule plus the mastery chip. An early "Got it" /
 * "Hard" returns the current schedule and mastery unchanged (never promotes).
 */
export function reviewPatch(e: LangEntry, grade: SrsGrade, now: number): { srs: SrsState; mastery_status: Mastery } {
  const prev = srsOf(e);
  if (isPracticeReview(e, grade, now)) return { srs: prev, mastery_status: e.mastery_status };
  const srs = review(prev, grade, now);
  return { srs, mastery_status: masteryAfter(e.mastery_status, grade, srs) };
}

export const isDue = (e: LangEntry, now: number) => srsOf(e).due_at <= now;

/** Most overdue first; ties by save time, then id, so the order is stable. */
export function byDue(a: LangEntry, b: LangEntry): number {
  return srsOf(a).due_at - srsOf(b).due_at || a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function dueEntries(entries: LangEntry[], now: number): LangEntry[] {
  return entries.filter((e) => isDue(e, now)).sort(byDue);
}

export const dueCount = (entries: LangEntry[], now: number) => entries.reduce((n, e) => n + (isDue(e, now) ? 1 : 0), 0);

/**
 * A flashcard deck: every due card first (most overdue first), then — to fill up to `max` — the
 * not-yet-due cards that aren't mastered, soonest first. The filler is practice: grading it doesn't
 * advance its schedule (`review`).
 */
export function flashcardOrder(entries: LangEntry[], now: number, max = 20): LangEntry[] {
  const due = dueEntries(entries, now);
  if (due.length >= max) return due.slice(0, max);
  const rest = entries.filter((e) => !isDue(e, now) && e.mastery_status !== "mastered").sort(byDue);
  return [...due, ...rest].slice(0, max);
}

/** Validate a schedule coming off the wire (mirrors the Rust/Python clamps). */
export function normalizeSrs(raw: unknown): SrsState | null {
  if (!raw || typeof raw !== "object") return null;
  // A stored row must have a schedule time; anything else is "no row" (srsOf falls back to legacySrs).
  const o = raw as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  if (typeof o.due_at !== "number" || !Number.isFinite(o.due_at)) return null;
  return {
    ease: clampEase(n(o.ease, START_EASE)),
    interval_days: Math.min(MAX_INTERVAL_DAYS, Math.max(0, n(o.interval_days, 0))),
    due_at: o.due_at,
    reps: Math.max(0, Math.floor(n(o.reps, 0))),
    lapses: Math.max(0, Math.floor(n(o.lapses, 0))),
    last_review: typeof o.last_review === "number" && Number.isFinite(o.last_review) ? o.last_review : null,
  };
}
