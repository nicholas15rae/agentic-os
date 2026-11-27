/**
 * Language curveballs: now and then Tony would drop a phrase you're learning into an ordinary
 * chat turn ("Allora — did the booking go through?") and see if you follow / answer in kind.
 *
 * SETTING ONLY for now. The level is saved in the Language store (and mirrored to the library's
 * `settings` table under "curveballs" so the gateway/Rust side can read it later); it is OFF by
 * default.
 *
 * TODO(language-curveballs): NOT wired into Tony's prompt/turn path. That path is latency-critical
 * and owned elsewhere. To hook it up: read the level (`useHub.getState().curveballs`, or the
 * "curveballs" setting), call `curveballFor(level, dueItems, turnIndex, rng, lastCurveballTurn)`
 * once per turn with the due Library items (srs.ts `dueEntries`), add the returned phrase to the
 * turn's instructions, and after the reply call `recordCurveballReview(item, answeredInItalian,
 * understood, now)` and save the patch with `useHub.getState().updateEntry(item.id, patch)`.
 */
import type { CurveballLevel, LangEntry, LangEntryPatch } from "./contract";
import { foreignSide } from "./library";
import { reviewPatch, type SrsGrade } from "./srs";

export const CURVEBALL_LEVELS: { id: CurveballLevel; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Tony sticks to English" },
  { id: "light", label: "Light", hint: "about 1 turn in 8" },
  { id: "medium", label: "Medium", hint: "about 1 turn in 4" },
  { id: "heavy", label: "Heavy", hint: "about 1 turn in 2–3" },
];

/** Chance that an eligible turn gets a curveball. */
export const CURVEBALL_RATE: Record<CurveballLevel, number> = { off: 0, light: 0.125, medium: 0.25, heavy: 0.4 };

/** Pick among this many of the most-due eligible items, so the same phrase doesn't repeat every time. */
export const CURVEBALL_POOL = 5;

export const isCurveballLevel = (v: unknown): v is CurveballLevel => v === "off" || v === "light" || v === "medium" || v === "heavy";

export interface Curveball {
  entry: LangEntry;
  /** The foreign phrase to slip in, its language and English meaning. */
  lang: string;
  text: string;
  english: string;
}

/**
 * Decide whether turn `turnIndex` gets a curveball, and which phrase. Never on turn 0, never on two
 * turns in a row (`lastCurveballTurn` = the last turn that had one), only phrases already at
 * "learning" or "mastered". `dueItems` order is kept (pass them most-due first). `rng` returns
 * [0, 1) — inject a seeded one for tests. Consumes at most two rng draws.
 */
export function curveballFor(level: CurveballLevel, dueItems: LangEntry[], turnIndex: number, rng: () => number, lastCurveballTurn = Number.NEGATIVE_INFINITY): Curveball | null {
  const rate = CURVEBALL_RATE[level] ?? 0;
  if (rate <= 0 || turnIndex <= 0 || turnIndex - lastCurveballTurn <= 1) return null;
  const eligible = dueItems.filter((e) => e.mastery_status === "learning" || e.mastery_status === "mastered");
  if (!eligible.length) return null;
  if (rng() >= rate) return null;
  const pool = eligible.slice(0, CURVEBALL_POOL);
  const entry = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  const f = foreignSide(entry);
  return { entry, lang: f.lang, text: f.text, english: f.english };
}

/** How a curveball exchange grades: understood and answered in the language = good; understood in English = hard; lost = again. */
export function curveballGrade(answeredInItalian: boolean, understood: boolean): SrsGrade {
  if (!understood) return "again";
  return answeredInItalian ? "good" : "hard";
}

/** The Library patch (schedule + mastery) for one curveball exchange. Save it with `updateEntry`. */
export function recordCurveballReview(item: LangEntry, answeredInItalian: boolean, understood: boolean, now: number = Date.now()): LangEntryPatch {
  return reviewPatch(item, curveballGrade(answeredInItalian, understood), now);
}
