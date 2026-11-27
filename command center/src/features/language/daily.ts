/**
 * "Today's lesson" — about five minutes a day built from what is due plus what was saved lately.
 * Pure and clock-injected. Snooze / done state lives on this device only (store prefs); there are
 * no notifications or background jobs. `dailyLessonDue` is the one call Tony can make later to
 * decide whether to mention it.
 */
import type { LangEntry } from "./contract";
import { byDue, DAY_MS, isDue } from "./srs";

export const DAILY_MAX_ITEMS = 10;
/** Roughly half a minute per card (reveal, listen, answer). */
export const SECONDS_PER_ITEM = 30;
/** "Recently saved" = within this window. */
export const RECENT_MS = 7 * DAY_MS;

export interface DailyLesson {
  lang: string;
  items: LangEntry[];
  /** How many of the items were due (the rest are recent saves). */
  due: number;
  minutes: number;
}

export interface DailySnooze {
  /** ms since epoch; 0 = not snoozed. */
  snoozedUntil: number;
  /** Local day (YYYY-MM-DD) a daily lesson was last finished, or null. */
  doneDay: string | null;
}

export const NO_SNOOZE: DailySnooze = { snoozedUntil: 0, doneDay: null };

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of `now`. */
export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight at the start of the day `days` after `now`'s day. */
export function startOfDayAfter(now: number, days: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

export function snoozeUntil(kind: "today" | "3days", now: number): number {
  return startOfDayAfter(now, kind === "today" ? 1 : 3);
}

const inLang = (e: LangEntry, lang: string) => e.source_lang === lang || e.target_lang === lang;

/**
 * Deterministic: due cards (most overdue first), then phrases saved in the last 7 days (newest
 * first, id as tiebreak), capped at 10 items (~5 minutes).
 */
export function buildDailyLesson(entries: LangEntry[], lang: string, now: number, max = DAILY_MAX_ITEMS): DailyLesson {
  const mine = entries.filter((e) => inLang(e, lang));
  const due = mine.filter((e) => isDue(e, now)).sort(byDue).slice(0, max);
  const picked = new Set(due.map((e) => e.id));
  const recent = mine
    .filter((e) => !picked.has(e.id) && now - e.timestamp <= RECENT_MS && e.timestamp <= now)
    .sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, max - due.length);
  const items = [...due, ...recent];
  return { lang, items, due: due.length, minutes: items.length ? Math.max(1, Math.round((items.length * SECONDS_PER_ITEM) / 60)) : 0 };
}

export interface DailyLessonState extends Partial<DailySnooze> {
  entries: LangEntry[];
  lang: string;
}

/** True when today's lesson has something in it, wasn't finished today, and isn't snoozed. */
export function dailyLessonDue(state: DailyLessonState, now: number): boolean {
  if ((state.snoozedUntil ?? 0) > now) return false;
  if (state.doneDay && state.doneDay === dayKey(now)) return false;
  return buildDailyLesson(state.entries, state.lang, now).items.length > 0;
}
