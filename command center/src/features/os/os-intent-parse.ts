/**
 * Native OS-control intents — the pure half (no runtime imports beyond `gaba.ts`, so
 * it is unit-tested). `os-intents.ts` executes what this returns.
 *
 * These are local, reversible controls (Gabagool on/off/volume, stop audio, switch tab,
 * swap model, compute mode, kill switch, status). They run in-process before the planner,
 * so a phrase like "turn off gabagool mode" can never become a mutating plan for a gateway agent.
 *
 * Spotify is NOT parsed here: its one grammar lives in Rust (`spotify_intent::parse`, reached
 * through `spotify_parse` in `spotify-intents.ts`). This file keeps only the cue precedence,
 * which depends on live cue state: a cue that is playing (volume) or active (stop) owns bare
 * music words; every other music line returns null here so Rust parses it. Naming Gabagool /
 * the theme always wins.
 */
import type { RoleId } from "@/features/dispatcher/roles";
import { editDistance, norm } from "../cues/gaba.ts";

export type ComputeModeId = "local" | "hybrid" | "cloud";
export type WorkspaceId = "auto" | RoleId;

export type OsIntent =
  | { kind: "gabagool-on" }
  /** `explicit` = the user named Gabagool; otherwise a bare "stop" while a cue is active. */
  | { kind: "gabagool-off"; explicit: boolean }
  /** Theme volume in steps of ±25 %. `explicit` = named Gabagool / the theme; otherwise a bare "louder" while a cue plays. */
  | { kind: "cue-volume"; steps: number; explicit: boolean }
  | { kind: "workspace"; thread: WorkspaceId }
  | { kind: "model"; query: string }
  | { kind: "compute"; mode: ComputeModeId }
  | { kind: "kill-switch"; on: boolean }
  | { kind: "status" }
  /** Part 6 status on demand: "what's the coder doing", "where's the build at", "status of my-app",
   * "hey Prompter, where are we at?". Answered from the task store with a template (no model).
   * `addressed` = said TO that agent (its own roster voice answers). `weak` = a bare "where's X at":
   * if no build is called X, the line falls through to Tony. */
  | { kind: "agent-status"; agent?: StatusAgent; slug?: string; addressed?: boolean; weak?: boolean }
  /** "narration off" / "narrate everything" / "quieter narration": the feedback level (0–3), or a step. */
  | { kind: "narration"; level?: 0 | 1 | 2 | 3; step?: -1 | 1 }
  /** System Map dev task queue: "log a dev note …", "queue a fix for …", "add … to the dev queue". `title` keeps the user's casing.
   * `taskKind: "fix"` goes to the Claude Code fix queue (`queueFix`). */
  | { kind: "dev-task"; taskKind: DevNoteKind; title: string }
  /** P6 live run: "run the mic fix with Claude Code", "send fix 401 loop to Claude". Only ever RAISES the confirmation card. */
  | { kind: "dev-fix-dispatch"; query: string };

export type DevNoteKind = "note" | "fix" | "task";
/** Agents whose progress status on demand can report (the worker's speakers). */
export type StatusAgent = "prompter" | "designer" | "coder" | "librarian";

export interface ParseOpts {
  /** The OS name from Settings ("Tony"); stripped as a wake word and accepted as Tony's tab. */
  osName?: string;
  /** A cue is running or fired in the last 10 minutes: bare "stop" / "turn off" stop it. */
  cueActive?: boolean;
  /** A cue is running right now: bare "louder" / "turn it down" change its theme, not Spotify. */
  cuePlaying?: boolean;
}

export const CUE_ACTIVE_MS = 10 * 60_000;

/** Spoken interjections before the wake name, shared by every parser here (commandText and
 * the dev-queue parser). Explicit words only ("aye", never a bare "a" — Whisper's
 * mis-hearing of "aye" would eat real words), so "play tony bennett" keeps its artist. */
const INTERJ = "hey|hi|aye|ay|ayy|ayo|oi|ok|okay|yo";
/** Leading interjections + politeness. Keep its interjections in step with INTERJ. */
const LEAD = /^(?:(?:hey|hi|aye|ay|ayy|ayo|oi|yeah|ok|okay|yo|so|um|uh|alright|all right|right|and|now|then|just|please|can you|could you|would you|will you|go ahead and|i want you to|i need you to|let s)\s+)+/;
const TRAIL = /(?:\s+(?:please|now|for me|thanks|thank you|right now|ok|okay))+$/;

/** Normalised command text with wake word and politeness stripped. */
export function commandText(text: string, osName = "Tony"): string {
  const name = norm(osName) || "tony";
  const wake = new RegExp(`^(?:(?:${INTERJ})\\s+)?(?:${escape(name)}|tony|jarvis)\\s+`);
  // "Turn it up, Tony." — the name addressed at the end (norm() already dropped the comma).
  const tailName = new RegExp(`(?:\\s+(?:${escape(name)}|tony|jarvis))+$`);
  let t = norm(text);
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(LEAD, "").replace(wake, "").replace(TRAIL, "").trim();
    // …but not when the name is the object: any workspace switch ("show tony", "open up
    // tony", "talk to tony") or a credit ("play something by tony").
    const untailed = t.replace(tailName, "").trim();
    if (untailed && !SWITCH_LEAD.test(t) && !/(?:^|\s)(?:to|with|by|from)$/.test(untailed)) t = untailed;
    if (t === before) break;
  }
  return t;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Gabagool ────────────────────────────────────────────────────────────────

const OFF_VERB = /\b(turn(?:ing)? (?:it )?off|turn of|switch(?:ing)? off|shut(?:ting)? (?:it )?(?:off|down)|exit(?:ing)?|disable|deactivate|stop(?:ping)?|end(?:ing)?|kill|quit|leave|cancel|no more|enough|out of|mute|pause|silence|get rid of|drop)\b/;
/** "turn the gabagool theme off": the verb and "off" need not be adjacent. */
const OFF_SPLIT = /\b(?:turn|switch|shut)(?: \w+){1,4} off\b|\b(?:shut|power)(?: \w+){1,4} down\b/;
/** "turn gabagool on", "switch the gabagool mode on". */
const ON_SPLIT = /\b(?:turn|switch)(?: \w+){1,4} on$/;
const ON_VERB = /\b(enter(?:ing)?|start(?:ing)?|turn(?:ing)? (?:it )?on|switch(?:ing)? on|activate|enable|begin|launch|go into|put on|engage|play)\b/;
/** Interjections before a bare stop ("hold on, stop", "no no stop", "dude stop"). */
const STOP_LEAD = /^(?:(?:hold on|hang on|wait|no|nope|ok|okay|dude|yo|bro|man|whoa|woah|hey)\s+)+/;
/** Bare stops that only mean "stop the cue" while one is active. */
const BARE_STOP = /^(?:stop(?: it| that| this)?(?: stop)*|make it stop|turn off|turn of|turn it off|switch off|switch it off|shut it off|shut it down|enough(?: already)?|that s enough|cut it|cut it out|kill it|off|be quiet|quiet|silence|shut up|pause(?: it| that)?|mute(?: it| that)?)$/;
const MUSIC_NOUN = "(?:music|theme|song|track|cue|soundtrack|audio|sound)";
const MUSIC_STOP = new RegExp(
  `^(?:(?:stop(?: playing)?|quit playing|kill|end|cut|turn off|turn of|shut off|switch off|mute|pause|silence)(?: the| that| this| my)? ${MUSIC_NOUN}|(?:turn|switch|shut)(?: the| that| this| my)? ${MUSIC_NOUN} off)$`,
);

/** Did the user say an ON verb ("enter", "start", "turn on", "play"…)? A running cue only restarts on one. */
export function hasOnVerb(text: string): boolean {
  return ON_VERB.test(norm(text));
}

/** Stops that name music or say pause/mute are Gabagool's only while its theme is actually
 * playing; otherwise they're left to Spotify's grammar ("pause the music" after Gabagool ended). */
const PAUSE_MUTE = /^(?:pause|mute)\b/;

function gabagool(t: string, cueActive: boolean, cuePlaying: boolean): OsIntent | null {
  if (/\bgabagool\b/.test(t)) {
    if (OFF_VERB.test(t) || OFF_SPLIT.test(t) || /\bgabagool(?: mode)? off$/.test(t)) return { kind: "gabagool-off", explicit: true };
    if (ON_VERB.test(t) || ON_SPLIT.test(t) || /^(?:the )?gabagool(?: mode)?(?: on)?$/.test(t)) return { kind: "gabagool-on" };
    return null;
  }
  const s = t.replace(STOP_LEAD, "");
  if (!cueActive) return null;
  const musicStop = MUSIC_STOP.test(s) || (BARE_STOP.test(s) && PAUSE_MUTE.test(s));
  if (musicStop ? cuePlaying : BARE_STOP.test(s)) return { kind: "gabagool-off", explicit: false };
  return null;
}

// ── Volume (cue theme only; Spotify volume lines return null for Rust) ──────

/** Words allowed between "turn" and "up"/"down" (never "off", so "turn gabagool off, shut it down" stays a stop). */
const GAP = "(?:(?:it|that|this|the|my|gabagool|music|theme|song|track|volume|sound|audio|mode|spotify|a|bit|little|lot|tad|notch|way|all) ){0,4}";
// The bare "gabagool up/down" forms are anchored: "start gabagool up" is an ON command and
// "shut the gabagool down" an exit, never a volume nudge.
const UP = new RegExp(`^(?:the )?gabagool (?:music |theme |mode )?up\\b|\\b(?:louder|crank\\w*|boost|raise|increase|volume up|up the volume|more volume|(?:turn|pump|bring|jack|kick)\\w* ${GAP}up)\\b`);
const DOWN = new RegExp(`^(?:the )?gabagool (?:music |theme |mode )?down\\b|\\b(?:quieter|softer|lower|decrease|reduce|volume down|less volume|(?:turn|bring|tone)\\w* ${GAP}down)\\b`);
const BIG = /\b(?:crank\w*|a lot|lots|way (?:up|louder|more)|much louder)\b/;
/** Every word of a bare volume command ("make it a little louder") is one of these, so "lower the price" never matches. */
const VOLUME_WORDS = new Set(
  ("a an the it that this its s bit little tad touch notch notches couple lot lots more way much some so too just even slightly quite again " +
    "make turn turned crank cranked pump bring jack kick tone raise lower increase decrease reduce boost louder quieter softer up down " +
    "volume music song track sound audio tune tunes background of can you could would will get").split(" "),
);

/** Targets a bare volume command may also name ("turn the spotify volume up", "theme louder"). */
const TARGET_WORDS = new Set(["gabagool", "theme", "spotify", "mode", "on", "in", "my", "please"]);

function volume(t: string, opts: ParseOpts): OsIntent | null {
  const up = UP.test(t);
  const down = DOWN.test(t);
  if (up === down) return null;
  const steps = up ? (BIG.test(t) ? 2 : 1) : -1;
  // "theme"/"spotify" alone don't make a line a volume command ("tell the designer to lower the
  // contrast on the dark theme", "reduce spotify api calls"): those need an otherwise-bare
  // volume line. Naming Gabagool is enough ("I want to hear the gabagool music a little louder").
  const bare = t.split(" ").every((w) => VOLUME_WORDS.has(w) || TARGET_WORDS.has(w));
  if (/\bgabagool\b/.test(t) || (bare && /\btheme\b/.test(t))) return { kind: "cue-volume", steps, explicit: true };
  if (!bare) return null;
  // Naming Spotify, or no cue playing: Spotify's line (Rust grammar), not ours.
  if (/\bspotify\b/.test(t)) return null;
  return opts.cuePlaying ? { kind: "cue-volume", steps, explicit: false } : null;
}

// ── Workspace / agent tab ───────────────────────────────────────────────────

/** Spoken names → thread. `suffix` names only count with "tab/desk/agent" after them. */
const AGENT_NAMES: Record<WorkspaceId, { bare: string[]; suffix: string[] }> = {
  auto: { bare: ["auto", "auto route", "autoroute", "auto routing", "auto router"], suffix: ["dispatcher"] },
  general: { bare: ["tony", "general"], suffix: ["main", "os"] },
  booking: { bare: ["booking", "bookings", "booking desk", "booking agent", "the booking desk"], suffix: ["book"] },
  prompter: { bare: ["prompter", "prompt builder", "the prompter"], suffix: ["prompt"] },
  coder: { bare: ["coder", "coding agent", "the coder", "developer"], suffix: ["code", "coding", "dev"] },
  designer: { bare: ["designer", "design agent", "the designer"], suffix: ["design", "ui", "ux"] },
  librarian: { bare: ["librarian", "the librarian"], suffix: ["library", "research"] },
  ops: { bare: ["ops", "operations", "ops agent"], suffix: ["op"] },
};
const SWITCH_LEAD = /^(?:switch(?: over)?|change|swap|flip|jump|move|head|hop)(?: me)? (?:to|over to) |^(?:open(?: up)?|go(?: over)? to|show(?: me)?|take me to|bring up|pull up|talk to|let me talk to|i want to talk to)\s/;
const SUFFIX = /\s(?:tab|desk|agent|workspace|thread|chat|channel)$/;

function workspace(t: string, osName: string): OsIntent | null {
  const m = SWITCH_LEAD.exec(t);
  if (!m) return null;
  let rest = t.slice(m[0].length).replace(/^(?:the|my|our)\s+/, "").trim();
  const hadSuffix = SUFFIX.test(rest);
  rest = rest.replace(SUFFIX, "").replace(/^(?:the|my|our)\s+/, "").trim();
  const name = norm(osName);
  if (name && rest === name) return { kind: "workspace", thread: "general" };
  for (const [id, n] of Object.entries(AGENT_NAMES) as [WorkspaceId, { bare: string[]; suffix: string[] }][]) {
    if (n.bare.includes(rest) || (hadSuffix && n.suffix.includes(rest))) return { kind: "workspace", thread: id };
  }
  // "talk to …" with anything else is a delegation request, not a tab switch.
  return null;
}

// ── Model / compute / kill switch / status ──────────────────────────────────

const MODEL = [
  /^(?:switch|change|swap|set|move)(?: the| your| tony s| my)? (?:model|brain|llm|local model)(?: over)? to (.+)$/,
  /^(?:use|load|run(?: on)?)(?: the)? (?:model|llm) (.+)$/,
  /^(?:switch|swap|change|move)(?: over)? to(?: the)? (?:model|llm) (.+)$/,
];

const COMPUTE = [
  /^(?:go|switch|change|set|flip|move|put(?: it| us| everything)?|run)(?: (?:it|us|everything|compute|compute mode|the compute mode|mode))?(?: to| into| in)? (local|hybrid|cloud)(?: mode| compute| only)?$/,
  /^(?:use )?(local|hybrid|cloud) (?:mode|compute)(?: on)?$/,
  /^compute(?: mode)?(?: to)? (local|hybrid|cloud)$/,
];

const KILL_ON_OFF = [
  /^(?:turn|switch|flip|set)(?: (on|off))?(?: the)? kill ?switch(?: (on|off))?$/,
  /^(?:the )?kill ?switch (on|off)$/,
];
const KILL_ON = /^(?:enable|activate|engage|arm|hit|pull|throw)(?: the)? kill ?switch$/;
const KILL_OFF = /^(?:disable|deactivate|disengage|disarm|release|reset)(?: the)? kill ?switch$/;

const STATUS = [
  /^(?:what s |what is |give me |run |do |show(?: me)? )?(?:the |a |my )?(?:system|systems|os) (?:status|check|health|report)(?: report| check| update)?$/,
  /^status (?:report|check|update)$/,
  /^how are (?:the |my |all )?(?:the )?systems(?: doing| looking)?$/,
];

// ── Status on demand (Part 6) ─────────────────────────────────────────────────
//
// Matched on `commandText` (lower-case, punctuation gone, "what's" → "what s"), BEFORE the router,
// so "what's the coder doing" is a status read from the store — never a Named delegation to the
// Coder's workspace (an ungrounded, GPU-heavy guess). "Tell the coder to fix the login" matches
// nothing here and still routes.

const AGENT_WORDS: Record<string, StatusAgent> = {
  prompter: "prompter",
  "prompt builder": "prompter",
  designer: "designer",
  coder: "coder",
  developer: "coder",
  librarian: "librarian",
};
const AGENT_ALT = Object.keys(AGENT_WORDS).sort((a, b) => b.length - a.length).join("|");
const WHAT = String.raw`(?:what s|whats|what is|what are)`;
const DOING = String.raw`(?:doing|working on|up to|been doing|been up to|busy with)(?: right now| now| at the moment)?`;
const STATUS_AGENT = [
  new RegExp(String.raw`^${WHAT} (?:the |my |our )?(?<a>${AGENT_ALT})(?: agent)? ${DOING}$`),
  new RegExp(String.raw`^(?:where s|where is|how s|how is) (?:the |my |our )?(?<a>${AGENT_ALT})(?: agent)? (?:at|doing|getting on|coming along)$`),
  new RegExp(String.raw`^(?:status|progress) (?:of|on|for) (?:the |my |our )?(?<a>${AGENT_ALT})(?: agent)?$`),
];
/** Said TO the agent ("hey" is already stripped): "prompter, where are we at", "coder status". */
const STATUS_ADDRESSED = [
  new RegExp(String.raw`^(?<a>${AGENT_ALT})(?: agent)? (?:where are we(?: at)?|where are you(?: at)?|where s it at|where is it at|status(?: update| report)?|what s the status|whats the status|how s it going|hows it going|how are we doing|what s happening|what are you (?:doing|working on))$`),
  new RegExp(String.raw`^(?:where are we(?: at)?|where are you(?: at)?|status(?: update)?|how s it going) (?<a>${AGENT_ALT})$`),
];
const BUILD_NOUN = String.raw`(?:build|builds|prototype|prototypes|project|pipeline)`;
const STATUS_ALL = [
  new RegExp(String.raw`^${WHAT} (?:the |all the |my |our )?(?:agents|team|crew|workers|everyone|everybody)(?: all)? ${DOING}$`),
  new RegExp(String.raw`^(?:where s|where is|wheres|how s|how is|hows) (?:the |my |our )?${BUILD_NOUN}(?: at| going| coming along| doing| looking)?$`),
  new RegExp(String.raw`^where are we (?:at )?(?:with|on) (?:the |my |our )?${BUILD_NOUN}$`),
  new RegExp(String.raw`^(?:${BUILD_NOUN}|task|tasks) (?:status|progress|update)$`),
  new RegExp(String.raw`^(?:what s|whats|what is) (?:going on|happening|the status|the latest) (?:with|on) (?:the |my |our )?${BUILD_NOUN}$`),
  new RegExp(String.raw`^(?:status|progress) (?:of|on|for) (?:the |my |our |all )?${BUILD_NOUN}$`),
  new RegExp(String.raw`^(?:any|what s the) (?:update|news) on (?:the |my |our )?${BUILD_NOUN}$`),
];
/** "status of the audition tracker build" (strong: it says it's a build). "status of audition
 * tracker" / "where's the audition tracker at" are WEAK: "status of my Amazon order", "progress
 * on the audition prep", "status on the booking for friday" are not builds — they fall through to
 * Tony (and the Booking Desk) when no build has that name. */
// "my"/"our" stay in the slug ("status of my app" → my-app); `slugCandidates` also tries it without.
const STATUS_SLUG_STRONG = /^(?:status|progress) (?:of|on|for) (?:the )?(?<s>[a-z0-9][a-z0-9 ]{0,46}?) (?:build|prototype)$/;
const STATUS_SLUG_NAMED = /^(?:status|progress) (?:of|on|for) (?:the )?(?<s>[a-z0-9][a-z0-9 ]{0,46})$/;
/** "project" / "pipeline" also name other things ("how's the project going" = CloudMart), so a
 * general status line that only says those is weak (Tony answers when no build is open). */
const AMBIGUOUS_BUILD = /\b(?:project|projects|pipeline|pipelines)\b/;
const PLAIN_BUILD = /\b(?:build|builds|prototype|prototypes)\b/;
const STATUS_SLUG_WEAK = /^(?:where s|where is|how s|how is) (?:the )?(?<s>[a-z0-9][a-z0-9 ]{0,46}?)(?: build| prototype| project)? (?:at|coming along)$/;
/** Words that are never a project name ("where's my phone at" still reaches Tony, as a weak match). */
const NOT_A_SLUG = /^(?:(?:my |our )?(?:it|this|that|everything|everyone|things|system|systems|you|we|us|me|phone|keys|stuff))$/;

/** The slugs a spoken name may be: "my-app", then "app" ("status of my audition tracker"). Pure. */
export function slugCandidates(slug: string): string[] {
  const bare = slug.replace(/^(?:my|our)-/, "");
  return bare && bare !== slug ? [slug, bare] : [slug];
}

/** "my app" → "my-app" (the worker's project slugs). */
const slugOf = (words: string) => words.trim().replace(/\s+/g, "-");

function agentStatus(t: string): OsIntent | null {
  for (const re of STATUS_ADDRESSED) {
    const a = re.exec(t)?.groups?.a;
    if (a) return { kind: "agent-status", agent: AGENT_WORDS[a], addressed: true };
  }
  for (const re of STATUS_AGENT) {
    const a = re.exec(t)?.groups?.a;
    if (a) return { kind: "agent-status", agent: AGENT_WORDS[a] };
  }
  if (STATUS_ALL.some((re) => re.test(t))) return AMBIGUOUS_BUILD.test(t) && !PLAIN_BUILD.test(t) ? { kind: "agent-status", weak: true } : { kind: "agent-status" };
  const strong = STATUS_SLUG_STRONG.exec(t)?.groups?.s;
  if (strong && !NOT_A_SLUG.test(strong.trim())) return { kind: "agent-status", slug: slugOf(strong) };
  const named = STATUS_SLUG_NAMED.exec(t)?.groups?.s;
  if (named && !NOT_A_SLUG.test(named.trim()) && !AGENT_WORDS[named.trim()]) return { kind: "agent-status", slug: slugOf(named), weak: true };
  const weak = STATUS_SLUG_WEAK.exec(t)?.groups?.s;
  if (weak && !NOT_A_SLUG.test(weak.trim()) && !AGENT_WORDS[weak.trim()]) return { kind: "agent-status", slug: slugOf(weak), weak: true };
  return null;
}

const NARRATION_SET: [RegExp, 0 | 1 | 2 | 3][] = [
  [/^(?:narration|narrations) (?:off|silent|quiet|mute|muted)$|^(?:turn|switch) (?:off )?(?:the )?narration(?: off)?$|^(?:stop|no more|mute) (?:the )?narrat(?:ing|ion|or)$|^silent narration$/, 0],
  [/^(?:narration|narrate) (?:milestones?|milestones only)$|^only narrate milestones$/, 1],
  [/^(?:narration|narrate) handoffs?$|^narrate the handoffs$/, 2],
  [/^narrate everything$|^(?:narration|narrations) (?:verbose|everything|all)$|^verbose narration$/, 3],
];

function narration(t: string): OsIntent | null {
  for (const [re, level] of NARRATION_SET) if (re.test(t)) return { kind: "narration", level };
  if (/^(?:turn|switch) (?:the )?narration on$|^narration on$/.test(t)) return { kind: "narration", level: 1 };
  if (/^(?:quieter|less) narration$|^narrate less$|^(?:turn|tone) (?:the )?narration down$/.test(t)) return { kind: "narration", step: -1 };
  if (/^(?:more|louder) narration$|^narrate more$|^(?:turn|bump) (?:the )?narration up$/.test(t)) return { kind: "narration", step: 1 };
  return null;
}

/** One open task as status needs it (envelope / gateway mirror snapshot fields). */
export interface StatusTask {
  task_id: string;
  title: string;
  status: string;
  stage: string | null;
  current_owner: string;
  iteration_count: number;
  max_iterations: number;
  project_slug: string | null;
  updated_at: number;
  error?: string | null;
  voice_summaries?: Record<string, { text: string; at: number } | undefined> | null;
}

const STAGE_AGENT: Record<string, StatusAgent | "system" | "staging"> = { triage: "prompter", spec: "prompter", merge: "prompter", verify: "prompter", preflight: "librarian", audit: "librarian", design: "designer", code: "coder", evaluate: "system", done: "staging" };
const LABEL: Record<string, string> = { prompter: "the Prompter", designer: "the Designer", coder: "the Coder", librarian: "the Librarian", system: "the build checks", staging: "staging", tony: "Tony" };
const NAME: Record<string, string> = { prompter: "The Prompter", designer: "The Designer", coder: "The Coder", librarian: "The Librarian" };

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

/**
 * The phone's status answer from the gateway mirror (the desktop answers from tasks.db with the
 * same shape of sentence). Templated: no model call. Pure.
 */
export function taskStatusText(tasks: readonly StatusTask[], q: { agent?: string; slug?: string }, now = Date.now()): string {
  const open = tasks.filter((t) => t.status !== "review_ready" && t.status !== "failed").sort((a, b) => a.updated_at - b.updated_at);
  const who = (t: StatusTask) => (t.stage ? STAGE_AGENT[t.stage] : undefined) ?? t.current_owner;
  const pick = q.slug ? tasks.find((t) => t.project_slug === q.slug) : q.agent ? open.find((t) => who(t) === q.agent || t.current_owner === q.agent) : open[0];
  if (!pick) {
    if (q.slug) return "I don't have a build with that name.";
    if (q.agent) return `${NAME[q.agent] ?? q.agent} isn't on a task right now.`;
    return "No builds in progress.";
  }
  if (pick.status === "review_ready") return `“${pick.title}” is ready for review in staging/${pick.project_slug ?? ""}.`;
  if (pick.status === "failed") return `“${pick.title}” failed${pick.error ? `: ${pick.error}` : "."}`;
  if (pick.status === "queued") return `“${pick.title}” is queued for the Prompter.`;
  const more = !q.slug && !q.agent && open.length > 1 ? ` ${open.length} builds are open.` : "";
  return `“${pick.title}” is with ${LABEL[who(pick)] ?? who(pick)}, iteration ${pick.iteration_count} of ${pick.max_iterations}, updated ${ago(pick.updated_at, now)}.${more}`;
}

/**
 * "Hey Coder, where are we at?" on the phone: the line the addressed agent speaks in its own voice,
 * from the gateway mirror. Same rules as the desktop (taskworker.rs `addressed_task` +
 * `addressed_line`): the open task it is working on (owner / its stage), else the one it last
 * spoke about, else the newest; its voice summary there, else a first-person line about where that
 * task is; with no open task, its latest voice summary from any task; else "Nothing from me yet."
 * Templated. Pure.
 */
export function addressedStatusLine(tasks: readonly StatusTask[], agent: string): string {
  const own = (t: StatusTask) => t.voice_summaries?.[agent]?.text;
  const open = tasks.filter((t) => t.status !== "review_ready" && t.status !== "failed").sort((a, b) => b.updated_at - a.updated_at);
  const working = (t: StatusTask) => t.current_owner === agent || (t.stage ? STAGE_AGENT[t.stage] : undefined) === agent;
  const spoke = open.filter((t) => own(t)).sort((a, b) => (b.voice_summaries?.[agent]?.at ?? 0) - (a.voice_summaries?.[agent]?.at ?? 0))[0];
  const newest = open.find(working) ?? spoke ?? open[0];
  if (newest) {
    const mine = own(newest);
    if (mine) return mine;
    const with_ = (newest.stage ? STAGE_AGENT[newest.stage] : undefined) ?? newest.current_owner;
    if (with_ === agent) return `I'm on "${newest.title}" now; nothing to report yet.`;
    if (newest.status === "queued") return `Nothing from me on "${newest.title}" yet; it's queued for the Prompter.`;
    if (with_ === "system") return `Nothing from me on "${newest.title}" yet; it's in the build checks.`;
    return `Nothing from me on "${newest.title}" yet; it's with ${LABEL[with_] ?? with_}.`;
  }
  const latest = tasks
    .map((t) => t.voice_summaries?.[agent])
    .filter((v): v is { text: string; at: number } => !!v?.text)
    .sort((a, b) => b.at - a.at)[0];
  return latest?.text ?? "Nothing from me yet.";
}

// ── Dev task queue (System Map) ─────────────────────────────────────────────
//
// Anchored at the start of the line (after the wake word and politeness), so a request
// that merely mentions a fix or a note ("tell the coder to queue a fix for…", "what's in
// the dev queue") never becomes one. Matched on the raw text so the title keeps its
// casing and punctuation; dictated notes may be long, so this runs before the 12-word gate.

// Whisper ends a paused phrase with a period ("Log a dev note. The mic…"), so sentence
// punctuation separates as well as ':' or a dash.
const DEV_PUNCT = String.raw`[:,;.\-–—…]`;
const DEV_SEP = String.raw`(?:\s*${DEV_PUNCT}+\s*|\s+(?:that|saying|about|re)\s+)`;
const DEV_WORD = String.raw`dev(?:eloper)?(?:\s+|-)?note`;
// Note-taking verbs also take a bare space ("log a dev note the HUD flickers"); verbs that
// usually mean building something ("write/add/make/create a dev note section…") need an
// explicit separator, so ordinary requests that mention a dev note aren't swallowed.
const DEV_NOTE_LOOSE = new RegExp(String.raw`^(?:log|take|save|jot(?: down)?|record|leave)\s+(?:a\s+|an\s+|another\s+)?${DEV_WORD}(?:${DEV_SEP}|(?<bare>\s+))(?<body>.+)$`, "is");
const DEV_NOTE_STRICT = new RegExp(String.raw`^(?:add|make|write(?: down)?|create)\s+(?:a\s+|an\s+|another\s+)?${DEV_WORD}${DEV_SEP}(?<body>.+)$`, "is");
const DEV_NOTE_BARE = new RegExp(String.raw`^${DEV_WORD}\s*${DEV_PUNCT}+\s*(?<body>.+)$`, "is");
/** "dev fix", "developer fix", "claude fix", "claude code fix" (the P6 Claude Code fix queue). */
const FIX_WHO = String.raw`(?:dev(?:eloper)?|claude(?:\s+code)?)\s+`;
const DEV_FIX = new RegExp(String.raw`^queue\s+(?:up\s+)?(?:a\s+|an\s+|another\s+)?(?:${FIX_WHO})?fix(?:\s+(?:for|to|on)\s+|\s*${DEV_PUNCT}+\s*)(?<body>.+)$`, "is");
/** "log a dev fix: …", "log a Claude fix for …" — `log`/`file`/`add` need the dev/claude qualifier. */
const DEV_FIX_LOG = new RegExp(String.raw`^(?:log|file|add)\s+(?:a\s+|an\s+|another\s+)?${FIX_WHO}fix(?:\s+(?:for|to|on|about)\s+|\s*${DEV_PUNCT}+\s*)(?<body>.+)$`, "is");
/** "dev fix: HUD flicker", "dev fix - HUD flicker", "claude fix the login loop". */
const DEV_FIX_BARE = new RegExp(String.raw`^(?:dev|claude(?:\s+code)?)\s+fix(?:\s*${DEV_PUNCT}+\s*|\s+(?:for|to|on)\s+|\s+)(?<body>.+)$`, "is");
const DEV_ADD_TO = new RegExp(String.raw`^add\s+(?:this\s+|that\s+)?to\s+the\s+dev(?:eloper)?\s+queue(?:${DEV_SEP}|\s+)(?<body>.+)$`, "is");
const DEV_ADD_X_TO = /^add\s+(?<body>.+?)\s+to\s+the\s+dev(?:eloper)?\s+queue[.!]?$/is;
const DEV_PATTERNS: [RegExp, DevNoteKind][] = [
  [DEV_NOTE_LOOSE, "note"],
  [DEV_NOTE_STRICT, "note"],
  [DEV_NOTE_BARE, "note"],
  [DEV_FIX, "fix"],
  [DEV_FIX_LOG, "fix"],
  [DEV_FIX_BARE, "fix"],
  [DEV_ADD_TO, "task"],
  [DEV_ADD_X_TO, "task"],
];
/** After a bare space, these mean "a note-shaped thing", not a note ("…dev note in the README", "…dev note template"). */
const DEV_STRUCTURAL = /^(?:(?:in|into|on|to|for|from|inside)\s+(?:the|my|our|a|an|this|that)\b|(?:template|section|app|file|page|docs?|field|button|feature|system|format|thing)\b)/i;
/** A body that is only a pointer at something said earlier: there's nothing to log. */
const DEV_PRONOUN = /^(?:this|that|it|these|those|this one|that one|the above|what i (?:just )?said)$/i;
/** A second request riding along ("…and email it to Sam") belongs to Tony, not the queue. */
const DEV_SECOND_REQUEST = /\b(?:and|then)\s+(?:also\s+|then\s+)?(?:e-?mail|send|text|message|tell|post|share|forward)\s+(?:it|this|that|him|her|them|me|to)\b/i;
const DEV_LEAD = /^(?:(?:hey|hi|aye|ay|ayy|ayo|oi|yeah|ok|okay|yo|so|um|uh|alright|all right|and|now|then|just|please|can you|could you|would you|will you|go ahead and|i want you to|i need you to|let'?s)[\s,.]+)+/i;
const DEV_TRAIL = /(?:[\s,]+(?:please|thanks|thank you|for me))+[.!]?$/i;

/** The dev-queue phrasing, or null. `title` is what follows, trimmed, first letter capitalised. */
export function parseDevTask(text: string, osName = "Tony"): { taskKind: DevNoteKind; title: string } | null {
  const name = escape(osName.trim() || "Tony");
  const wake = new RegExp(String.raw`^(?:(?:${INTERJ})[\s,]+)?(?:${name}|tony|jarvis)[\s,.:!]+`, "i");
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(DEV_LEAD, "").replace(wake, "").trim();
    if (t === before) break;
  }
  for (const [re, taskKind] of DEV_PATTERNS) {
    const m = re.exec(t);
    if (!m?.groups) continue;
    const raw = m.groups.body;
    if (m.groups.bare !== undefined && DEV_STRUCTURAL.test(raw)) return null;
    if (DEV_SECOND_REQUEST.test(raw)) return null;
    const body = raw.replace(DEV_TRAIL, "").replace(/^["'“‘]+|["'”’]+$/g, "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
    // "log a dev note" with nothing after it, or only filler, is not a note.
    if (body.replace(/[^\p{L}\p{N}]+/gu, "").length < 2) return null;
    if (DEV_PRONOUN.test(body)) return null;
    return { taskKind, title: body.charAt(0).toUpperCase() + body.slice(1) };
  }
  return null;
}

const CLAUDE = String.raw`claude(?:\s+code)?`;
const DISPATCH_VERB = String.raw`(?:run|send|dispatch|hand|give)`;
const DISPATCH_TO = String.raw`(?:to|with|through|over\s+to|in)`;
/** "run the mic fix with Claude Code", "send the 401 fix over to Claude". */
const DISPATCH_NAMED = new RegExp(String.raw`^${DISPATCH_VERB}\s+(?:the\s+|that\s+|my\s+)?(?<q>.+?)\s+fix\s+${DISPATCH_TO}\s+${CLAUDE}$`, "i");
/** "run fix 401 loop with Claude Code", "send the fix for the HUD flicker to Claude". */
const DISPATCH_FIX_FOR = new RegExp(String.raw`^${DISPATCH_VERB}\s+(?:the\s+)?fix\s+(?:for\s+|on\s+|about\s+)?(?<q>.+?)\s+${DISPATCH_TO}\s+${CLAUDE}$`, "i");

/** The P6 live-run phrasing, or null. `query` names the fix ("mic", "401 loop"). Never runs anything itself. */
export function parseDevDispatch(text: string, osName = "Tony"): { query: string } | null {
  const name = escape(osName.trim() || "Tony");
  const wake = new RegExp(String.raw`^(?:(?:${INTERJ})[\s,]+)?(?:${name}|tony|jarvis)[\s,.:!]+`, "i");
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(DEV_LEAD, "").replace(wake, "").trim();
    if (t === before) break;
  }
  t = t.replace(DEV_TRAIL, "").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  for (const re of [DISPATCH_FIX_FOR, DISPATCH_NAMED]) {
    const q = re.exec(t)?.groups?.q?.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
    if (!q || q.replace(/[^\p{L}\p{N}]+/gu, "").length < 2 || DEV_PRONOUN.test(q)) continue;
    return { query: q };
  }
  return null;
}

/**
 * Parse an OS-control command. Returns null for anything else (it then goes on to
 * idea capture, local intents and the planner).
 */
export function parseOsIntent(text: string, opts: ParseOpts = {}): OsIntent | null {
  const osName = opts.osName || "Tony";
  const dev = parseDevTask(text, osName);
  if (dev) return { kind: "dev-task", ...dev };
  const run = parseDevDispatch(text, osName);
  if (run) return { kind: "dev-fix-dispatch", ...run };
  const t = commandText(text, osName);
  if (!t) return null;
  // Long rambles only count as volume ("I want to hear the gabagool music a little louder").
  if (t.split(" ").length > 12) return volume(t, opts);

  for (const re of KILL_ON_OFF) {
    const m = re.exec(t);
    if (m) {
      const v = m[1] ?? m[2];
      if (v) return { kind: "kill-switch", on: v === "on" };
    }
  }
  if (KILL_ON.test(t)) return { kind: "kill-switch", on: true };
  if (KILL_OFF.test(t)) return { kind: "kill-switch", on: false };

  for (const re of COMPUTE) {
    const m = re.exec(t);
    if (m) return { kind: "compute", mode: m[1] as ComputeModeId };
  }
  for (const re of MODEL) {
    const m = re.exec(t);
    if (m) {
      const query = m[1].replace(/\s+(?:model|please)$/, "").trim();
      if (query) return { kind: "model", query };
    }
  }
  if (STATUS.some((re) => re.test(t))) return { kind: "status" };
  const st = agentStatus(t);
  if (st) return st;
  const nar = narration(t);
  if (nar) return nar;

  return volume(t, opts) ?? gabagool(t, !!opts.cueActive, !!opts.cuePlaying) ?? workspace(t, osName);
}

/**
 * Never a mutating plan for a gateway agent: true for anything the intent layer owns,
 * including bare stops ("turn off", "stop it") even when no cue is playing. Spotify lines
 * are no longer covered here (Rust parses them); plan.ts `isPlayback` keeps them non-mutating.
 */
export function isOsControlPhrase(text: string, osName?: string): boolean {
  return parseOsIntent(text, { osName, cueActive: true }) !== null;
}

// ── Model name resolution ───────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", twenty: "20", thirty: "30", seventy: "70",
};
/** Whisper spellings of common model families. */
const MODEL_ALIASES: Record<string, string> = {
  quen: "qwen", kwen: "qwen", queen: "qwen", quinn: "qwen", gwen: "qwen", qwin: "qwen",
  lama: "llama", llamma: "llama", jemma: "gemma", mistrel: "mistral", mistrall: "mistral", fi: "phi", fie: "phi",
};
const MODEL_STOP = new Set(["the", "a", "an", "model", "llm", "version", "point", "dot", "latest", "please"]);

function modelWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !MODEL_STOP.has(w))
    .map((w) => NUMBER_WORDS[w] ?? MODEL_ALIASES[w] ?? w);
}
const key = (s: string) => modelWords(s).join("");

/**
 * Best match for a spoken model name among model ids ("qwen three eight b" →
 * "qwen/qwen3-8b"). Returns null when nothing is close enough.
 */
export function resolveModel(query: string, models: string[]): string | null {
  const q = key(query);
  const qWords = modelWords(query);
  if (!q) return null;
  let best: { id: string; score: number } | null = null;
  for (const id of models) {
    const full = key(id);
    const base = key(id.split("/").pop() ?? id);
    if (!full) continue;
    let score = 0;
    if (base === q || full === q) score = 1000;
    else if (base.startsWith(q)) score = 600 - (base.length - q.length);
    else if (base.includes(q) || full.includes(q)) score = 500 - (full.length - q.length);
    else {
      const covered = qWords.filter((w) => full.includes(w)).length;
      if (covered === qWords.length) score = 300 - full.length;
      else if (covered / qWords.length >= 0.5 && qWords.some((w) => w.length >= 3 && full.includes(w))) score = 100 * (covered / qWords.length);
      else {
        const sim = 1 - editDistance(q, base) / Math.max(q.length, base.length);
        if (sim >= 0.7) score = 100 * sim;
      }
    }
    if (score > 0 && (!best || score > best.score || (score === best.score && id.length < best.id.length))) best = { id, score };
  }
  return best?.id ?? null;
}
