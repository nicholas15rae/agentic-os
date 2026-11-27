import { describe, expect, it } from "vitest";
import type { LangEntry, SrsState } from "./contract";
import { CURVEBALL_RATE, curveballFor, curveballGrade, isCurveballLevel, recordCurveballReview } from "./curveballs";
import { buildDailyLesson, DAILY_MAX_ITEMS, dailyLessonDue, dayKey, snoozeUntil } from "./daily";
import { byDue, DAY_MS, dueCount, flashcardOrder, initialSrs, isDue, isPracticeReview, LEGACY_MASTERED_DAYS, masteryAfter, MIN_EASE, normalizeSrs, RELEARN_MS, review, reviewPatch, srsOf, START_EASE } from "./srs";

const T0 = new Date(2026, 10, 27, 12, 0, 0).getTime(); // local noon, so day math is timezone-safe

let n = 0;
const entry = (p: Partial<LangEntry> = {}): LangEntry => ({
  id: `e${String(n++).padStart(3, "0")}`,
  timestamp: T0 - DAY_MS * 30,
  source_lang: "en",
  target_lang: "it",
  source_text: "Good morning",
  translated_text: "Buongiorno",
  phonetic_guide: null,
  context_note: null,
  category: "my_translation",
  favorite: false,
  mastery_status: "new",
  srs: null,
  ...p,
});
const sched = (p: Partial<SrsState>): SrsState => ({ ...initialSrs(T0), ...p });

/** mulberry32 — a tiny seeded rng for deterministic tests. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SM-2 scheduler", () => {
  it("new cards are due the moment they were saved", () => {
    const s = initialSrs(T0);
    expect(s).toEqual({ ease: START_EASE, interval_days: 0, due_at: T0, reps: 0, lapses: 0, last_review: null });
    expect(isDue(entry({ timestamp: T0 }), T0)).toBe(true);
    expect(isDue(entry({ timestamp: T0 }), T0 - 1)).toBe(false);
  });

  it("intervals grow 1 → 6 → ×ease on 'got it'", () => {
    let s = initialSrs(T0);
    const days: number[] = [];
    let t = T0;
    for (let k = 0; k < 5; k++) {
      s = review(s, "good", t);
      days.push(s.interval_days);
      expect(s.due_at).toBe(t + s.interval_days * DAY_MS);
      t = s.due_at;
    }
    expect(days).toEqual([1, 6, 15, 38, 95]);
    expect(s.reps).toBe(5);
    expect(s.ease).toBe(START_EASE);
    for (let k = 1; k < days.length; k++) expect(days[k]).toBeGreaterThan(days[k - 1]);
  });

  it("is deterministic given the clock", () => {
    const a = review(review(initialSrs(T0), "good", T0), "hard", T0 + DAY_MS);
    const b = review(review(initialSrs(T0), "good", T0), "hard", T0 + DAY_MS);
    expect(a).toEqual(b);
    expect(a.last_review).toBe(T0 + DAY_MS);
  });

  it("a lapse resets reps and interval, counts once learned, and comes back in 10 minutes", () => {
    const learned = sched({ reps: 3, interval_days: 15, ease: 2.5 });
    const s = review(learned, "again", T0);
    expect(s).toMatchObject({ reps: 0, interval_days: 0, lapses: 1, due_at: T0 + RELEARN_MS, ease: 2.3 });
    // Missing a brand-new card isn't a lapse.
    expect(review(initialSrs(T0), "again", T0).lapses).toBe(0);
    // After a lapse the ladder restarts at 1 day.
    expect(review(s, "good", T0 + RELEARN_MS).interval_days).toBe(1);
  });

  it("ease never drops below 1.3", () => {
    let s = sched({ ease: 1.4, reps: 2, interval_days: 6 });
    for (let k = 0; k < 10; k++) s = review(s, k % 2 ? "again" : "hard", T0 + k);
    expect(s.ease).toBe(MIN_EASE);
    expect(review(sched({ ease: 1.3 }), "again", T0).ease).toBe(MIN_EASE);
  });

  it("'hard' lowers ease and steps more slowly than 'good'", () => {
    const base = sched({ reps: 2, interval_days: 6, ease: 2.5 });
    const hard = review(base, "hard", T0);
    const good = review(base, "good", T0);
    expect(hard.ease).toBe(2.35);
    expect(hard.interval_days).toBe(7);
    expect(good.interval_days).toBe(15);
    expect(review(sched({ reps: 2, interval_days: 1 }), "hard", T0).interval_days).toBe(2); // at least +1 day
  });

  it("mastery follows the review", () => {
    expect(masteryAfter("new", "good")).toBe("learning");
    expect(masteryAfter("learning", "good", sched({ reps: 2 }))).toBe("mastered");
    expect(masteryAfter("learning", "good", sched({ reps: 1 }))).toBe("learning");
    expect(masteryAfter("mastered", "again")).toBe("learning");
    expect(masteryAfter("new", "hard")).toBe("learning");
    expect(masteryAfter("mastered", "hard")).toBe("mastered");
    const p = reviewPatch(entry(), "good", T0);
    expect(p).toEqual({ srs: { ease: 2.5, interval_days: 1, due_at: T0 + DAY_MS, reps: 1, lapses: 0, last_review: T0 }, mastery_status: "learning" });
  });

  it("orders due cards first, most overdue first, then fills with unmastered", () => {
    const later = entry({ srs: sched({ due_at: T0 + DAY_MS, reps: 1, interval_days: 1 }), mastery_status: "learning" });
    const overdue = entry({ srs: sched({ due_at: T0 - 5 * DAY_MS }), mastery_status: "learning" });
    const fresh = entry({ timestamp: T0 - 1000 }); // new: due since saved
    const masteredLater = entry({ srs: sched({ due_at: T0 + 9 * DAY_MS }), mastery_status: "mastered" });
    const masteredDue = entry({ srs: sched({ due_at: T0 - 1 }), mastery_status: "mastered" });
    const all = [later, fresh, masteredLater, overdue, masteredDue];
    expect(dueCount(all, T0)).toBe(3);
    expect(flashcardOrder(all, T0).map((e) => e.id)).toEqual([overdue.id, fresh.id, masteredDue.id, later.id]);
    expect(flashcardOrder(all, T0, 2).map((e) => e.id)).toEqual([overdue.id, fresh.id]);
    expect([...all].sort(byDue)[0].id).toBe(overdue.id);
  });

  it("normalises a schedule off the wire", () => {
    expect(normalizeSrs(null)).toBeNull();
    expect(normalizeSrs({ ease: 2 })).toBeNull();
    expect(normalizeSrs({ due_at: 5, ease: 0.2, reps: -3, lapses: 2.7, interval_days: 99999 })).toEqual({ ease: MIN_EASE, interval_days: 3650, due_at: 5, reps: 0, lapses: 2, last_review: null });
  });
});

describe("early reviews are practice", () => {
  /** Apply a patch the way the store + server do. */
  const apply = (e: LangEntry, p: { srs: SrsState; mastery_status: LangEntry["mastery_status"] }): LangEntry => ({ ...e, ...p });

  it("save -> Got it -> Got it a minute later stays learning, interval <= 1 day", () => {
    let e = entry({ timestamp: T0 });
    e = apply(e, reviewPatch(e, "good", T0));
    expect(e.mastery_status).toBe("learning");
    expect(isPracticeReview(e, "good", T0 + 60_000)).toBe(true);
    e = apply(e, reviewPatch(e, "good", T0 + 60_000));
    expect(e.mastery_status).toBe("learning");
    expect(e.srs!.interval_days).toBeLessThanOrEqual(1);
    expect(e.srs).toMatchObject({ reps: 1, due_at: T0 + DAY_MS, last_review: T0 });
    // A third tap, and "hard", change nothing either.
    expect(reviewPatch(e, "good", T0 + 120_000)).toEqual({ srs: e.srs, mastery_status: "learning" });
    expect(reviewPatch(e, "hard", T0 + 120_000)).toEqual({ srs: e.srs, mastery_status: "learning" });
  });

  it("never promotes mastery early, even from reps 1 -> 2", () => {
    const e = entry({ mastery_status: "learning", srs: sched({ reps: 1, interval_days: 1, due_at: T0 + DAY_MS, last_review: T0 }) });
    expect(reviewPatch(e, "good", T0 + DAY_MS - 1).mastery_status).toBe("learning");
    // Once due, the same answer is a real step: 6 days and mastered.
    const due = reviewPatch(e, "good", T0 + DAY_MS);
    expect(due).toMatchObject({ mastery_status: "mastered", srs: { reps: 2, interval_days: 6 } });
  });

  it("'again' on an early card still shortens it", () => {
    const e = entry({ mastery_status: "mastered", srs: sched({ reps: 3, interval_days: 15, due_at: T0 + 10 * DAY_MS }) });
    expect(isPracticeReview(e, "again", T0)).toBe(false);
    const p = reviewPatch(e, "again", T0);
    expect(p).toMatchObject({ mastery_status: "learning", srs: { reps: 0, interval_days: 0, due_at: T0 + RELEARN_MS, lapses: 1 } });
  });

  it("due-card behaviour is unchanged", () => {
    const s = sched({ reps: 2, interval_days: 6, due_at: T0 });
    expect(review(s, "good", T0)).toMatchObject({ reps: 3, interval_days: 15, due_at: T0 + 15 * DAY_MS });
    expect(review(s, "good", T0 + DAY_MS).due_at).toBe(T0 + DAY_MS + 15 * DAY_MS); // overdue too
    expect(review(s, "hard", T0)).toMatchObject({ reps: 3, interval_days: 7 });
  });

  it("today's lesson filler (recent, not due) is practice too", () => {
    const recent = entry({ timestamp: T0 - 3_600_000, mastery_status: "learning", srs: sched({ reps: 1, interval_days: 1, due_at: T0 + DAY_MS }) });
    const l = buildDailyLesson([recent], "it", T0);
    expect(l.items.map((e) => e.id)).toEqual([recent.id]);
    expect(l.due).toBe(0);
    expect(reviewPatch(recent, "good", T0)).toEqual({ srs: recent.srs, mastery_status: "learning" });
  });
});

describe("phrases without an srs row (before spaced repetition)", () => {
  it("mastered: a 14-day card from its save time, not overdue", () => {
    const e = entry({ timestamp: T0 - 3 * DAY_MS, mastery_status: "mastered", srs: null });
    expect(srsOf(e)).toEqual({ ease: START_EASE, interval_days: LEGACY_MASTERED_DAYS, due_at: T0 + 11 * DAY_MS, reps: 2, lapses: 0, last_review: T0 - 3 * DAY_MS });
    expect(isDue(e, T0)).toBe(false);
    expect(isDue(e, T0 + 11 * DAY_MS)).toBe(true);
    expect(dueCount([e], T0)).toBe(0);
    expect(flashcardOrder([e], T0)).toEqual([]);
    expect(buildDailyLesson([e], "it", T0).due).toBe(0);
    // Reviewing it once due continues from the 14-day interval.
    expect(reviewPatch(e, "good", T0 + 11 * DAY_MS)).toMatchObject({ mastery_status: "mastered", srs: { reps: 3, interval_days: 35 } });
  });

  it("learning and new: due now (since saved)", () => {
    const learning = entry({ timestamp: T0 - DAY_MS, mastery_status: "learning", srs: null });
    const fresh = entry({ timestamp: T0 - DAY_MS, mastery_status: "new" });
    expect(srsOf(learning)).toEqual(initialSrs(T0 - DAY_MS));
    expect(srsOf(fresh)).toEqual(initialSrs(T0 - DAY_MS));
    expect(dueCount([learning, fresh], T0)).toBe(2);
  });

  it("a stored row always wins over the legacy default", () => {
    const e = entry({ mastery_status: "mastered", srs: sched({ due_at: T0 - 1 }) });
    expect(isDue(e, T0)).toBe(true);
  });
});

describe("today's lesson", () => {
  it("takes due first, then recent saves, at most 10, ~5 minutes", () => {
    const due = Array.from({ length: 4 }, (_, k) => entry({ srs: sched({ due_at: T0 - (k + 1) * DAY_MS }), mastery_status: "learning" }));
    const recent = Array.from({ length: 12 }, (_, k) => entry({ timestamp: T0 - (k + 1) * 3_600_000, srs: sched({ due_at: T0 + DAY_MS }) }));
    const old = entry({ timestamp: T0 - 20 * DAY_MS, srs: sched({ due_at: T0 + DAY_MS }) });
    const latin = entry({ target_lang: "la", timestamp: T0 - 1000 });
    const l = buildDailyLesson([...recent, old, latin, ...due], "it", T0);
    expect(l.items).toHaveLength(DAILY_MAX_ITEMS);
    expect(l.due).toBe(4);
    expect(l.items.slice(0, 4).map((e) => e.id)).toEqual([due[3].id, due[2].id, due[1].id, due[0].id]);
    expect(l.items.slice(4).map((e) => e.id)).toEqual(recent.slice(0, 6).map((e) => e.id)); // newest first
    expect(l.items).not.toContain(old);
    expect(l.items).not.toContain(latin);
    expect(l.minutes).toBe(5);
    expect(buildDailyLesson([...recent, old, latin, ...due].reverse(), "it", T0).items.map((e) => e.id)).toEqual(l.items.map((e) => e.id));
  });

  it("is empty with nothing due or recent", () => {
    const l = buildDailyLesson([entry({ timestamp: T0 - 20 * DAY_MS, srs: sched({ due_at: T0 + DAY_MS }) })], "it", T0);
    expect(l).toMatchObject({ items: [], minutes: 0 });
  });

  it("dailyLessonDue respects snooze and done-today", () => {
    const entries = [entry()];
    expect(dailyLessonDue({ entries, lang: "it" }, T0)).toBe(true);
    expect(dailyLessonDue({ entries, lang: "la" }, T0)).toBe(false);
    expect(dailyLessonDue({ entries, lang: "it", doneDay: dayKey(T0) }, T0)).toBe(false);
    expect(dailyLessonDue({ entries, lang: "it", doneDay: dayKey(T0) }, T0 + DAY_MS)).toBe(true);
    const today = snoozeUntil("today", T0);
    expect(today).toBe(new Date(2026, 10, 28).getTime());
    expect(dailyLessonDue({ entries, lang: "it", snoozedUntil: today }, T0)).toBe(false);
    expect(dailyLessonDue({ entries, lang: "it", snoozedUntil: today }, today)).toBe(true);
    const three = snoozeUntil("3days", T0);
    expect(three).toBe(new Date(2026, 10, 30).getTime());
    expect(dailyLessonDue({ entries, lang: "it", snoozedUntil: three }, T0 + 2 * DAY_MS)).toBe(false);
  });
});

describe("curveballs", () => {
  const learning = Array.from({ length: 8 }, (_, k) => entry({ mastery_status: k % 3 === 0 ? "mastered" : "learning", srs: sched({ due_at: T0 - k }) }));
  const brandNew = [entry(), entry()];

  it("off never fires; turn 0 and consecutive turns never fire", () => {
    const always = () => 0;
    expect(curveballFor("off", learning, 5, always)).toBeNull();
    expect(curveballFor("heavy", learning, 0, always)).toBeNull();
    expect(curveballFor("heavy", learning, 4, always, 3)).toBeNull();
    expect(curveballFor("heavy", learning, 5, always, 3)).not.toBeNull();
  });

  it("only uses phrases at learning or mastered", () => {
    expect(curveballFor("heavy", brandNew, 3, () => 0)).toBeNull();
    const c = curveballFor("heavy", [...brandNew, ...learning], 3, () => 0);
    expect(c?.entry.id).toBe(learning[0].id);
    expect(c).toMatchObject({ lang: "it", text: "Buongiorno", english: "Good morning" });
  });

  it("fires at roughly the level's rate and never two turns in a row", () => {
    for (const level of ["light", "medium", "heavy"] as const) {
      const rng = seeded(42);
      let last = Number.NEGATIVE_INFINITY;
      let hits = 0;
      const turns = 4000;
      for (let t = 1; t <= turns; t++) {
        const c = curveballFor(level, learning, t, rng, last);
        if (c) {
          expect(t - last).toBeGreaterThan(1);
          expect(learning.slice(0, 5)).toContain(c.entry);
          last = t;
          hits++;
        }
      }
      const rate = hits / turns;
      expect(rate).toBeGreaterThan(CURVEBALL_RATE[level] * 0.6);
      expect(rate).toBeLessThan(CURVEBALL_RATE[level] * 1.1);
    }
    // Deterministic for a given seed.
    const run = () => Array.from({ length: 50 }, (_, t) => curveballFor("medium", learning, t + 1, seeded(7))?.entry.id ?? null);
    expect(run()).toEqual(run());
  });

  it("feeds the SRS", () => {
    expect(curveballGrade(true, true)).toBe("good");
    expect(curveballGrade(false, true)).toBe("hard");
    expect(curveballGrade(true, false)).toBe("again");
    const item = entry({ mastery_status: "learning", srs: sched({ reps: 2, interval_days: 6 }) });
    expect(recordCurveballReview(item, true, true, T0)).toEqual(reviewPatch(item, "good", T0));
    expect(recordCurveballReview(item, false, false, T0).srs).toMatchObject({ reps: 0, lapses: 1 });
    expect(isCurveballLevel("medium")).toBe(true);
    expect(isCurveballLevel("wild")).toBe(false);
  });
});
