/**
 * Live pop-in characters (pure logic). Hidden by default: now and then a character peeks in from
 * a screen edge, says one short line and ducks back out after a few seconds, like a mouse that
 * doesn't know he's being watched. Rules: never block clicks, never cover a safety control, never
 * during a call, typing, full screen, the Trading page or Do Not Disturb; easy to mute or hide;
 * reduced motion makes him fade instead of move; frequency adjustable.
 */

export type Corner = "br" | "bl" | "tr" | "tl";
export const CORNERS: readonly Corner[] = ["br", "bl", "tr", "tl"];

/** How often a character pops in on its own. */
export type Frequency = "off" | "rare" | "normal";
export const FREQUENCIES: readonly Frequency[] = ["off", "rare", "normal"];
export const FREQUENCY_LABEL: Record<Frequency, string> = { off: "Off", rare: "Rare", normal: "Normal" };

/** Older saves had four levels: tap-only becomes Off, Often becomes Normal. Pure. */
export function migrateFrequency(v: unknown): Frequency {
  if (v === "taps") return "off";
  if (v === "lively") return "normal";
  return FREQUENCIES.includes(v as Frequency) ? (v as Frequency) : "normal";
}

/** The least time between two pop-ins. */
export const GAP_MS: Record<Frequency, number> = { off: Infinity, rare: 20 * 60_000, normal: 5 * 60_000 };

/** The random "hey, what's up" comes at most this often. */
export const HELLO_GAP_MS = 60 * 60_000;

/** How long he stays (unless his menu is open) before ducking out. */
export const POP_MS = 5_000;

/** What is going on that a pop-in would interrupt. */
export interface QuietContext {
  /** A call or a live voice conversation with Tony. */
  inCall: boolean;
  /** A field has the focus, or a key went down a moment ago. */
  typing: boolean;
  fullscreen: boolean;
  /** The page on screen (the Trading page is never interrupted). */
  section: string;
  /** Do Not Disturb (any feature can set it through `setQuiet`). */
  dnd: boolean;
}

/** Why a pop-in must wait right now, or null when it may come. Pure. */
export function quietReason(c: QuietContext): string | null {
  if (c.dnd) return "do not disturb";
  if (c.inCall) return "on a call";
  if (c.typing) return "typing";
  if (c.fullscreen) return "full screen";
  if (c.section === "trading") return "trading";
  return null;
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Overlapping area of two rects (0 when apart). Pure. */
export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Insets tried from each edge, nearest first (px). */
export const INSETS = [16, 88, 160] as const;

/** Every spot a character may sit, `pref` corner first, each corner from its edge inwards. Pure. */
export function candidates(pref: Corner, vw: number, vh: number, size: number): (Rect & { corner: Corner })[] {
  const order = [pref, ...CORNERS.filter((c) => c !== pref)];
  const out: (Rect & { corner: Corner })[] = [];
  for (const c of order)
    for (const inset of INSETS) {
      const x = c === "br" || c === "tr" ? vw - size - 16 : 16;
      const y = c === "br" || c === "bl" ? vh - size - inset : inset;
      out.push({ corner: c, x, y, w: size, h: size });
    }
  return out;
}

/**
 * Where the character sits: the first spot (preferred corner first) that touches no obstacle
 * (safety controls, navigation, the page dock), else the spot with the least overlap. `pad`
 * keeps a gap around obstacles. Pure.
 */
export function placeCharacter(pref: Corner, vw: number, vh: number, size: number, obstacles: readonly Rect[], pad = 8): Rect & { corner: Corner } {
  const grown = obstacles.map((o) => ({ x: o.x - pad, y: o.y - pad, w: o.w + 2 * pad, h: o.h + 2 * pad }));
  let best: (Rect & { corner: Corner }) | null = null;
  let bestArea = Infinity;
  for (const c of candidates(pref, vw, vh, size)) {
    const area = grown.reduce((n, o) => n + overlap(c, o), 0);
    if (area === 0) return c;
    if (area < bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best!;
}

/** The speech bubble's box: beside the character, towards the middle of the screen. Pure. */
export function bubbleRect(at: Rect & { corner: Corner }, w = 220, h = 64): Rect {
  const left = at.corner === "br" || at.corner === "tr";
  const top = at.corner === "tr" || at.corner === "tl";
  return { x: left ? at.x - w - 8 : at.x + at.w + 8, y: top ? at.y : at.y + at.h - h, w, h };
}

/**
 * Where the bubble goes: beside the character, else above / below it, else nowhere (null: the
 * character still reacts, silently) when every spot would cover an obstacle or leave the screen. Pure.
 */
export function bubbleSpot(at: Rect & { corner: Corner }, obstacles: readonly Rect[], vw: number, vh: number, w = 220, h = 64): Rect | null {
  const side = bubbleRect(at, w, h);
  const top = at.corner === "tr" || at.corner === "tl";
  const right = at.corner === "br" || at.corner === "tr";
  const stacked: Rect = { x: right ? at.x + at.w - w : at.x, y: top ? at.y + at.h + 8 : at.y - h - 8, w, h };
  for (const r of [side, stacked]) {
    const onScreen = r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh;
    if (onScreen && obstacles.every((o) => overlap(r, o) === 0)) return r;
  }
  return null;
}

/** May a character pop in now? Never while muted or Off; otherwise after the frequency's gap. Pure. */
export function mayPop(now: number, lastPopAt: number, frequency: Frequency, muted: boolean): boolean {
  if (muted) return false;
  return now - lastPopAt >= GAP_MS[frequency];
}

/** What something happening in the app means to a character. */
export type CharacterEventKind = "reward" | "streak" | "done" | "hello";
export interface CharacterEvent {
  kind: CharacterEventKind;
  /** A line to say (else the character picks one). */
  text?: string;
}

/** A finished thing on a streak: 3, 5, 10, then every 10. Pure. */
export const isStreak = (n: number): boolean => n === 3 || n === 5 || (n >= 10 && n % 10 === 0);

/** Toasts that mean "you got something done" (title words). */
const DONE_TITLE = /^(done|staged|saved|sent|ready|promoted|built|finished|completed|paid|logged)\b/i;

/** Does a toast mean something got done? (Errors, warnings and alarms never pop a character.) Pure. */
export function isDoneToast(t: { title: string; tone: string }): boolean {
  return t.tone === "info" && DONE_TITLE.test(t.title.trim());
}

/** Today's key (local date), for the daily done-count. Pure. */
export const dayKey = (now: number): string => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** One line from `lines`, never the one just said (when there is a choice). Pure given `rand`. */
export function pickLine(lines: readonly string[], last: string | null, rand: () => number = Math.random): string {
  if (!lines.length) return "";
  const pool = lines.length > 1 ? lines.filter((l) => l !== last) : lines;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}
