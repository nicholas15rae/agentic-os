/**
 * Instant cues fast path (Section 20.10). Pure and import-light (types + two pure parsers), so
 * Vitest runs it directly. A small, data-driven table of whole-line phrases → handler ids, plus
 * Nic's own "fast cues" (Settings → Voice & Triggers): a matched line is answered by the app
 * itself, in Tony's voice, with no model call. Everything else — and any handler that can't
 * answer from what's already loaded — falls through to the normal turn, unchanged.
 *
 * Safety: handlers are READ-ONLY (time, date, weather from the store, what's pending) or map onto
 * the existing no-card fast paths (Spotify play / pause / next and mode switches run through
 * their own code and gates). A fixed reply is text only. Matching is a whole-line EXACT match
 * after normalising, never a substring, so anything longer or ambiguous falls through.
 */
import { parseModeSwitch, type WorkModeId } from "@/features/modes/mode-intent";
import { parseOsIntent } from "@/features/os/os-intent-parse";
import { isBareCut, parseReflex } from "./reflex-parse";
import { parseConfirmation } from "@/features/orchestrator/plan";

/** Is `phrase` an OS control in ANY context: also the stops that only count while a cue is
 * playing ("turn it off", "enough", "stop the music"), so a fast cue can never shadow them. */
function osControl(phrase: string, osName: string): boolean {
  return !!(parseOsIntent(phrase, { osName }) || parseOsIntent(phrase, { osName, cueActive: true, cuePlaying: true }));
}

export type FastHandlerId =
  | "time"
  | "date"
  | "weather"
  | "pending"
  | "music.play"
  | "music.stop"
  | "music.next"
  | `mode.${WorkModeId}`;

/** A user fast cue's target: a handler, or a fixed spoken reply. */
export type FastTarget = FastHandlerId | "reply";

/** Stored on a cue widget document (`CueWidget.fast`) in the existing "cues" collection. */
export interface FastCueSpec {
  /** Normalised phrase (see `normalizeFastPhrase`). */
  phrase: string;
  target: FastTarget;
  /** Only for `target: "reply"`: the fixed line Tony says. */
  reply?: string;
}

export const FAST_PHRASE_MAX = 80;
export const FAST_PHRASE_MAX_WORDS = 12;
export const FAST_REPLY_MAX = 240;

const MODES: readonly WorkModeId[] = ["surface", "builder", "operations", "coach", "brainstorm", "executive", "learning"];
const MODE_LABEL: Record<WorkModeId, string> = { surface: "Surface / Solo", builder: "Builder", operations: "Operations", coach: "Coach", brainstorm: "Brainstorm", executive: "Executive", learning: "Learning" };

/** Every handler a fast cue can point at, with its Settings label. */
export const FAST_HANDLERS: readonly { id: FastHandlerId; label: string }[] = [
  { id: "time", label: "Say the time" },
  { id: "date", label: "Say the date" },
  { id: "weather", label: "Weather now (from the clock's reading)" },
  { id: "pending", label: "What's pending (reminders + Finance)" },
  { id: "music.play", label: "Start music (Spotify)" },
  { id: "music.stop", label: "Stop music (Spotify)" },
  { id: "music.next", label: "Next track (Spotify)" },
  ...MODES.map((m) => ({ id: `mode.${m}` as FastHandlerId, label: `Switch to ${MODE_LABEL[m]} mode` })),
];
const HANDLER_IDS = new Set<string>(FAST_HANDLERS.map((h) => h.id));
export const isFastTarget = (v: unknown): v is FastTarget => v === "reply" || (typeof v === "string" && HANDLER_IDS.has(v));

/** The read-only handlers this module answers itself. The rest re-use existing fast paths. */
export const READ_ONLY_HANDLERS: readonly FastHandlerId[] = ["time", "date", "weather", "pending"];
export const isReadOnlyHandler = (h: FastTarget): boolean => (READ_ONLY_HANDLERS as readonly string[]).includes(h);

/** The canonical line each music handler hands to the existing Spotify grammar (`spotify_parse`). */
export const MUSIC_LINES: Readonly<Record<"music.play" | "music.stop" | "music.next", string>> = {
  "music.play": "play spotify",
  "music.stop": "pause spotify",
  "music.next": "next song",
};
export const modeOfHandler = (h: FastTarget): WorkModeId | null => (h.startsWith("mode.") ? (h.slice(5) as WorkModeId) : null);

/** Built-in phrases (already normalised). Whole-line matches only. Music and mode switches are
 * NOT here: the existing Spotify and mode-switch fast paths already answer them without a model. */
export const BUILTIN_PHRASES: Readonly<Record<"time" | "date" | "weather" | "pending", readonly string[]>> = {
  time: ["what time is it", "what time is it now", "whats the time", "whats the time now", "what time it is", "time check", "the time", "current time", "got the time"],
  date: ["whats the date", "whats the date today", "whats todays date", "todays date", "what date is it", "what date is it today", "what date it is", "what day is it", "what day is it today", "what day is today", "what day it is"],
  weather: [
    "whats the weather", "whats the weather like", "whats the weather now", "whats the weather like outside", "whats the weather outside",
    "hows the weather", "hows the weather outside", "whats it like outside", "whats the temperature", "whats the temperature outside", "whats the temp",
    "how cold is it", "how cold is it outside", "how hot is it", "how hot is it outside", "how warm is it", "how warm is it outside",
    "weather", "the weather", "weather check", "weather now", "current weather",
  ],
  // Reminders / to-do only. "What's pending" / "anything outstanding" stay Tony's Finance read
  // (finance.ask on the gateway's live data): the client's Finance collections are only synced
  // while a Finance view is open, so an instant answer could be stale (review).
  pending: ["whats on my to do list", "whats on my todo list", "whats on my list", "what reminders do i have", "any reminders", "what reminders are there"],
};
const BUILTIN_INDEX = new Map<string, FastHandlerId>(Object.entries(BUILTIN_PHRASES).flatMap(([h, ps]) => ps.map((p) => [p, h as FastHandlerId] as const)));

const LEAD = /^(?:(?:hey|yo|ok|okay|so|um|uh|alright|aye)\s+)+/;
const POLITE_LEAD = /^(?:(?:can|could|would) you (?:please )?tell me |please tell me |tell me |do you know |please )/;
const TRAIL = /(?:\s+(?:please|man|buddy|bro|real quick|right now))+$/;

/**
 * Lowercase, no accents / apostrophes / punctuation, single spaces; a leading wake ("hey tony,"),
 * interjection or politeness and a trailing "please" / name dropped; "what is" → "whats".
 */
export function normalizeFastPhrase(s: string, names: readonly string[] = ["tony"]): string {
  let t = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const nameAlt = names
    .map((n) => n.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim())
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(LEAD, "");
    if (nameAlt) t = t.replace(new RegExp(`^(?:${nameAlt})(?:\\s+|$)`), "").replace(new RegExp(`\\s+(?:${nameAlt})$`), "");
    t = t.replace(POLITE_LEAD, "").replace(TRAIL, "").trim();
    if (t === before) break;
  }
  return t
    .replace(/\bwhat is\b/g, "whats")
    .replace(/\bhow is\b/g, "hows")
    .replace(/\btoday s\b/g, "todays")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FastMatch {
  handler: FastTarget;
  source: "builtin" | "user";
  /** The phrase that matched (normalised). */
  phrase: string;
  /** User cue only. */
  cueId?: string;
  reply?: string;
}

export interface MatchOpts {
  builtins: boolean;
  userCuesOn: boolean;
  userCues: readonly (FastCueSpec & { id: string })[];
  /** Tony's name(s) and wake words, stripped from the ends of the line. */
  names?: readonly string[];
}

/** Whole-line match. A user cue wins over a built-in with the same phrase (it's Nic's choice). */
export function matchFastPath(line: string, o: MatchOpts): FastMatch | null {
  const n = normalizeFastPhrase(line, o.names);
  if (!n || n.length > FAST_PHRASE_MAX) return null;
  if (o.userCuesOn) {
    const c = o.userCues.find((u) => u.phrase && normalizeFastPhrase(u.phrase, o.names) === n && isFastTarget(u.target));
    if (c) {
      if (c.target === "reply") {
        const reply = cleanReply(c.reply ?? "");
        if (reply) return { handler: "reply", source: "user", phrase: n, cueId: c.id, reply };
      } else return { handler: c.target, source: "user", phrase: n, cueId: c.id };
    }
  }
  if (o.builtins) {
    const h = BUILTIN_INDEX.get(n);
    if (h) return { handler: h, source: "builtin", phrase: n };
  }
  return null;
}

// ── Answers (pure, given the data the stores already hold) ────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (d: number) => `${d}${d % 100 >= 11 && d % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][d % 10] ?? "th")}`;

export function timeReply(now: Date, hourCycle: "h12" | "h23" = "h12"): string {
  const h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, "0");
  if (hourCycle === "h23") return `It's ${String(h).padStart(2, "0")}:${m}.`;
  return `It's ${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}.`;
}

export function dateReply(now: Date): string {
  return `It's ${WEEKDAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${ordinal(now.getDate())}.`;
}

/** Fresh enough to say out loud without a new fetch: two of the clock's 15-minute refreshes. */
export const WEATHER_MAX_AGE_MS = 30 * 60_000;

export interface WeatherReading {
  tempC: number;
  windKph: number;
  label: string;
  place: string;
  fetchedAt: number;
}

/** Null when there is no reading or it is stale (→ the normal turn fetches one). */
export function weatherReply(w: WeatherReading | null | undefined, now: number): string | null {
  if (!w || !Number.isFinite(w.tempC) || !Number.isFinite(w.fetchedAt) || now - w.fetchedAt > WEATHER_MAX_AGE_MS || w.fetchedAt - now > 60_000) return null;
  const t = Math.round(w.tempC);
  const cond = w.label && w.label !== "—" ? ` and ${w.label.toLowerCase()}` : "";
  const place = w.place?.trim() ? ` in ${w.place.trim()}` : "";
  const wind = Number.isFinite(w.windKph) && w.windKph >= 25 ? ` Windy too, about ${Math.round(w.windKph)} km/h.` : "";
  return `It's ${t} degree${Math.abs(t) === 1 ? "" : "s"}${cond}${place}.${wind}`;
}

export interface PendingReminder {
  title: string;
  kind: string;
  dueAt: number;
  firedAt?: number | null;
  dismissed?: boolean;
}
export interface PendingFinance {
  title: string;
  overdue: boolean;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * "What's pending": open reminders (not fired, not dismissed; countdowns still ahead) and the
 * Finance reminders list. `finance: null` = not loaded / not available this turn (said so).
 * `reminders: null` = not loaded → null (fall through).
 */
export function pendingReply(o: { reminders: readonly PendingReminder[] | null; finance: readonly PendingFinance[] | null; now: number }): string | null {
  if (!o.reminders) return null;
  const open = o.reminders
    .filter((r) => !r.dismissed && (r.firedAt === null || r.firedAt === undefined) && Number.isFinite(r.dueAt) && (r.kind !== "countdown" || r.dueAt > o.now))
    .sort((a, b) => a.dueAt - b.dueAt);
  const parts: string[] = [];
  if (open.length) {
    const names = open.slice(0, 2).map((r) => lowerFirst(r.title.trim()) || "a reminder");
    if (open.length > 2) names.push(`${open.length - 2} more`);
    parts.push(`You've got ${open.length} reminder${open.length === 1 ? "" : "s"}: ${list(names)}.`);
  }
  if (o.finance && o.finance.length) {
    const overdue = o.finance.filter((f) => f.overdue).length;
    const first = o.finance[0].title.split(" · ")[0];
    parts.push(`Money side, ${o.finance.length} thing${o.finance.length === 1 ? "" : "s"}${overdue ? `, ${overdue} overdue` : ""}. Top one: ${lowerFirst(first)}.`);
  }
  if (!parts.length) parts.push(o.finance ? "Nothing pending, Nic. You're clear." : "No reminders pending.");
  if (!o.finance) parts.push("For money that's still owed, ask me what's pending.");
  return parts.join(" ");
}

/** A fixed reply: plain text, no control characters, capped. */
export function cleanReply(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FAST_REPLY_MAX);
}

// ── Validation (Settings → "Make this a fast cue") ─────────────────────────────

export interface FastCueCheck {
  ok: boolean;
  phrase: string;
  reply?: string;
  errors: string[];
  warnings: string[];
}

export interface ValidateCtx {
  /** Other fast cues (the one being edited excluded by `selfId`). */
  existing: readonly (FastCueSpec & { id: string })[];
  selfId?: string;
  /** Tony's name and wake words ("tony", "hey tony"). */
  names: readonly string[];
  /** Routing names (agent names: "coder", "booking desk", …) → their label. */
  routingNames: readonly { name: string; agent: string }[];
  /** Phrases of the cue widgets (they fire before a fast cue). */
  cuePhrases: readonly string[];
}

/** Words that belong to stops, holds and confirmation cards: never a fast cue phrase. */
const RESERVED = new Set([
  "stop", "wait", "hold on", "hold up", "hang on", "shut up", "quiet", "be quiet", "never mind", "nevermind", "cancel", "abort",
  "yes", "yeah", "yep", "yup", "no", "nope", "nah", "ok", "okay", "sure", "approve", "approved", "confirm", "deny", "reject",
  "do it", "go ahead", "send it", "send", "book it", "buy it", "sell", "buy", "keep going", "continue", "resume",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function validateFastCue(input: { phrase: string; target: string; reply?: string }, ctx: ValidateCtx): FastCueCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = input.phrase ?? "";
  const phrase = normalizeFastPhrase(raw, ctx.names);
  if (!phrase) errors.push(raw.trim() ? "That phrase is only Tony's name or filler — add the actual words." : "Type the phrase you say.");
  else {
    if (phrase.length > FAST_PHRASE_MAX) errors.push(`Keep the phrase under ${FAST_PHRASE_MAX} characters.`);
    if (phrase.split(" ").length > FAST_PHRASE_MAX_WORDS) errors.push(`Keep the phrase to ${FAST_PHRASE_MAX_WORDS} words or fewer.`);
    if (phrase.length < 2) errors.push("The phrase is too short.");
    // Stop / cut / hold / stand-down words always belong to Tony's reflexes.
    if (RESERVED.has(phrase) || isBareCut(phrase) || parseReflex(phrase, { busy: true, holding: false }) || parseReflex(phrase, { busy: false, holding: false })) errors.push("That's one of Tony's stop / hold words — it can't be a fast cue.");
    // OS controls (kill switch, status, cue volume, model swap…) keep their own handling.
    if (/\bkill ?switch\b|\bkillswitch\b|\bpanic\b|\bemergency\b|\block (?:it|everything|down)\b|\blockdown\b/.test(phrase) || osControl(phrase, ctx.names[0] ?? "Tony")) errors.push("That's an OS control (kill switch, status, volume…) — it keeps its own handling.");
    if (parseConfirmation(phrase) !== "unclear") errors.push("That reads as a yes / no to a confirmation card — it can't be a fast cue.");
    if (ctx.existing.some((c) => c.id !== ctx.selfId && normalizeFastPhrase(c.phrase, ctx.names) === phrase)) errors.push("Another fast cue already uses that phrase.");
    const builtin = BUILTIN_INDEX.get(phrase);
    if (builtin) warnings.push(`Same as the built-in “${phrase}” (${FAST_HANDLERS.find((h) => h.id === builtin)?.label ?? builtin}) — yours answers instead.`);
    if (parseModeSwitch(phrase)) warnings.push("That already switches modes — the mode switch runs first, so this cue never fires.");
    for (const r of ctx.routingNames) {
      const n = normalizeFastPhrase(r.name, []);
      if (n && new RegExp(`(?:^| )${escapeRe(n)}(?: |$)`).test(phrase)) {
        warnings.push(`It names ${r.agent} (“${r.name}”): the fast cue answers instead of routing to that agent.`);
        break;
      }
    }
    if (ctx.cuePhrases.some((p) => normalizeFastPhrase(p, ctx.names) === phrase)) warnings.push("A cue widget already fires on that phrase — the widget runs first.");
  }
  if (!isFastTarget(input.target)) errors.push("Pick what the cue does.");
  let reply: string | undefined;
  if (input.target === "reply") {
    reply = cleanReply(input.reply ?? "");
    if (!reply) errors.push("Type the reply Tony should say.");
    else if ((input.reply ?? "").trim().length > FAST_REPLY_MAX) warnings.push(`The reply was cut to ${FAST_REPLY_MAX} characters.`);
  }
  return { ok: errors.length === 0, phrase, reply, errors, warnings };
}
