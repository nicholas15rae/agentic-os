import type { AgentRole } from "@/features/dispatcher/agents";
import { isSelfRoleId, resolve } from "@/features/dispatcher/router";
import type { RoutingConfig } from "@/lib/platform";

/**
 * P3 tiered dialogue. Pure: no engines, no stores — the voice controller asks these once per turn.
 *
 *   Tier 1  a direct command (OS / Spotify / local intents, a Named "tell the coder…", a live-tool
 *           read, a mutating request): today's path, unchanged.
 *   Tier 2  thinking out loud ("I've been thinking about…", "what if…"): Tony answers himself,
 *           never a worker agent (`noDelegate`).
 *   Tier 3  a commit cue ("ok let's do it") inside a live brainstorm: Tony OFFERS to delegate —
 *           a confirmation card, so the yes is `approve()`.
 *   Tier 4  "nah, save it for later" / "put it in Play Place": packaged and saved, parked. Never a
 *           plan, never a worker agent.
 */
export type Tier = 1 | 2 | 3 | 4;
export type DeferTarget = "brainstorm" | "ledger" | "playplace";
export interface DeferMatch {
  target: DeferTarget;
  /** The line named a destination (a bare "save it for later" defaults to Brainstorm, U6). */
  explicit: boolean;
}

export const DEFER_LABEL: Record<DeferTarget, string> = {
  brainstorm: "Brainstorm list",
  ledger: "Ideas & Tasks Ledger",
  playplace: "Play Place",
};

// ── Shared lead / wake stripping (copied from os-intent-parse's dev-task parser, not imported) ──
const INTERJ = "hey|hi|aye|ay|ayy|ayo|oi|ok|okay|yo";
const LEAD = /^(?:(?:hey|hi|aye|ay|ayy|ayo|oi|yeah|yep|ok|okay|yo|so|um|uh|alright|all right|and|now|then|just|please|actually|can you|could you|would you|will you|go ahead and|i want you to|i need you to|let'?s)[\s,.!]+)+/i;
/** Only in front of a defer verb: "nah, save it for later" is a save, not a no. */
const DEFER_NEG = /^(?:nah|no|nope|naw)[\s,.!]+/i;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function strip(text: string, osName: string, extraLead?: RegExp): string {
  const name = escape(osName.trim() || "Tony");
  const wake = new RegExp(String.raw`^(?:(?:${INTERJ})[\s,]+)?(?:${name}|tony|jarvis)[\s,.:!]+`, "i");
  const trail = new RegExp(String.raw`(?:[\s,]+(?:please|thanks|thank you|for me|${name}|tony))+$`, "i");
  let t = text.trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(LEAD, "").replace(wake, "").trim();
    if (extraLead) t = t.replace(extraLead, "").trim();
    if (t === before) break;
  }
  return t.replace(/[.!?…]+$/, "").replace(trail, "").replace(/[.!?…]+$/, "").trim();
}

// ── Tier 4: defer / save ────────────────────────────────────────────────────

const PRON = String.raw`(?:it|this|that|this one|that one|all (?:of )?(?:this|that)|the whole thing|(?:this|that|the|our|my) (?:idea|thought|conversation|chat|plan|brainstorm|concept)|what we (?:just )?(?:talked|said|discussed)(?: about)?)`;
/** "For now" is NOT "for later": "nah, keep it for now" / "save it for now" answer a question
 * (keep the slot, keep the draft). It only parks with park / shelve, or with a named destination. */
const LATER = String.raw`(?:for (?:later|another time|the future|some ?day|next time)|till later|until later|later)`;
const LATER_OR_NOW = String.raw`(?:${LATER}|for now)`;
const DEST = String.raw`(?:(?:my|the|our)\s+)?(?:(?<brainstorm>brainstorm(?:ing)?(?:\s+(?:list|notes?|board|pile|doc|folder))?)|(?<ledger>(?:ideas?(?:\s*(?:and|&)\s*tasks?)?\s+)?ledger|ideas?(?:\s+(?:list|board|pile))?)|(?<playplace>play\s?-?place))`;
const PREP = String.raw`(?:in|into|on|onto|to)`;

/** "save it for later" / "park it" / "keep that for another time (in my brainstorm list)". */
const SAVE = new RegExp(String.raw`^(?:save|stash|keep|hold onto|hang onto|bookmark)\s+${PRON}\s+${LATER}(?:\s+${PREP}\s+${DEST})?$`, "i");
/** "save it in Play Place", "save that to the ledger for later". */
const SAVE_TO = new RegExp(String.raw`^(?:save|stash|keep|park|file|log)\s+(?:${PRON}\s+)?${PREP}\s+${DEST}(?:\s+${LATER_OR_NOW})?$`, "i");
/** "park it", "shelve that idea (for later)". */
const PARK = new RegExp(String.raw`^(?:park|shelve)\s+${PRON}(?:\s+${LATER_OR_NOW})?$`, "i");
/** "save for later", "park for now". */
const BARE_LATER = new RegExp(String.raw`^(?:(?:save|park|shelve|stash|keep)\s+${LATER}|(?:park|shelve)\s+for now)$`, "i");
/** "add it to my brainstorming list", "put that in the playplace", "add this to the ideas and tasks ledger". */
const ADD_TO = new RegExp(String.raw`^(?:add|put|throw|stick|drop|move|send|jot|write)(?:\s+down)?\s+(?:${PRON}\s+)?${PREP}\s+${DEST}(?:\s+${LATER_OR_NOW})?$`, "i");
const DEFER_PATTERNS = [SAVE, SAVE_TO, PARK, BARE_LATER, ADD_TO];
/** Spotify ("save this song for later") and the dev queue ("add this to the dev queue") own these. */
const NOT_OURS = /\b(?:songs?|tracks?|playlists?|albums?|tunes?|spotify|music|dev(?:eloper)?[\s-]*(?:queue|notes?))\b/i;

export function parseDefer(text: string, osName = "Tony"): DeferMatch | null {
  if (NOT_OURS.test(text)) return null;
  const t = strip(text, osName, DEFER_NEG);
  if (!t || t.length > 120) return null;
  for (const re of DEFER_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const g = m.groups ?? {};
    if (g.playplace) return { target: "playplace", explicit: true };
    if (g.ledger) return { target: "ledger", explicit: true };
    if (g.brainstorm) return { target: "brainstorm", explicit: true };
    return { target: "brainstorm", explicit: false };
  }
  return null;
}

// ── Tier 3: commit cue ──────────────────────────────────────────────────────

const CUE_LEAD = /^(?:(?:ok(?:ay)?|alright|all right|yeah|yep|yes|cool|great|perfect|right|so|sounds good|love it|nice|good)[\s,.!]+)+/i;
const COMMIT =
  /^(?:let'?s (?:do (?:it|this|that)|go(?: with (?:it|that|this))?|run with (?:it|that|this)|make it happen|build (?:it|that|this)|get (?:it|this) going)|that'?s the plan|lock it in|go|build (?:it|that|this)|get (?:it|this) going|run with (?:it|that|this)|make it happen|(?:sounds good|that works|works for me)(?:[\s,]+(?:go|do it|go for it|let'?s do it))?|do it|go for it|make it happen|ship it|i'?m sold|run with (?:it|that))$/i;

function cueCore(text: string, osName: string): string {
  let t = strip(text, osName);
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(CUE_LEAD, "").trim();
    if (t === before) break;
  }
  return t.replace(/[.!?]+$/, "");
}

/** "ok let's do it", "that's the plan", "lock it in", "sounds good, go". Deterministic (no model flag). */
export function isCommitCue(text: string, osName = "Tony"): boolean {
  return COMMIT.test(cueCore(text, osName));
}

/** Bare agreement — "sounds good", "yeah that works", "Go.", "so do it" — said mid-brainstorm is
 * usually a yes to Tony's last sub-point, not "build it now". Matched on the line with only
 * address / filler words removed (`strip` would also drop "let's", making "let's do it" bare). */
const WEAK_COMMIT = /^(?:go|do it|sounds good|that works|works for me)$/;
const COMMIT_FILLER = new Set(["hey", "hi", "ok", "okay", "yeah", "yep", "yes", "so", "um", "uh", "alright", "cool", "great", "perfect", "right", "nice", "please", "then", "just", "tony", "jarvis"]);

/** How strongly a commit cue commits: "strong" ("let's do it", "lock it in", "ship it") may run
 * Builder's auto-dispatch; "weak" bare agreement only ever raises the offer card. Null: no cue. */
export function commitStrength(text: string, osName = "Tony"): "strong" | "weak" | null {
  if (!isCommitCue(text, osName)) return null;
  const name = osName.trim().toLowerCase();
  const core = text
    .toLowerCase()
    .replace(/[.!?…,;:]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !COMMIT_FILLER.has(w) && w !== name)
    .join(" ");
  return WEAK_COMMIT.test(core) ? "weak" : "strong";
}

// ── Tier 2: brainstorm-shaped ───────────────────────────────────────────────

/** The voice controller's old IDEA regex (pipeline.rs `looks_like_idea` is its Rust twin). */
export const IDEA = /\b(i'?ve been thinking (about|of)|i'?m thinking (about|of)|i (want|wanna|would like) to (build|make|create)|idea for (an?|my)? ?(app|tool|site|website|product|game|platform|service|plugin|widget)|what if (i|we) (built|made|created)|i have an idea|new idea:|app idea|business idea)\b/i;
const THINKING = /\b(what if|what do you think (about|of)|help me (think|brainstorm|figure)|bounce (some )?ideas|brainstorm(ing)?|i'?m torn|should i|how might (i|we)|toying with|thinking out loud|kick (some )?ideas|play with (an|the|this) idea)\b/i;

export const looksLikeIdea = (t: string) => IDEA.test(t);
export const looksBrainstorm = (t: string) => IDEA.test(t) || THINKING.test(t);

const IDEA_LEAD = new RegExp(`^(?:${IDEA.source})`, "i");
const THINKING_LEAD = new RegExp(`^(?:${THINKING.source})`, "i");
/** The line OPENS as thinking out loud ("what if we…", "I've been thinking about an app that
 * sends…", "should I email Sam?"), rather than merely mentioning a brainstorm somewhere inside an
 * imperative ("email Sam what if…", "schedule a brainstorming session…"). */
export function leadsBrainstorm(text: string, osName = "Tony"): boolean {
  const t = strip(text, osName);
  return IDEA_LEAD.test(t) || THINKING_LEAD.test(t);
}

/** A build-shaped topic: the Tier-3 yes runs the Prompter → Designer → Coder pipeline (U5). */
const BUILD = /\b(build|make|create|prototype|design|mock ?up|spin up)\b[\s\S]*\b(app|tool|site|website|web ?app|prototype|dashboard|widget|plugin|extension|game|landing page|page|screen|tracker|platform|mvp|ui)\b/i;
/** The IDEA openers that NAME an artifact. A bare "I've been thinking about…" / "I have an idea"
 * is Tier-2 talk only: "I've been thinking about emailing Sam" is not a build (it used to queue a
 * prototype in Builder mode with no card). */
const ARTIFACT = "(?:app|tool|site|website|web ?app|product|game|platform|service|plugin|widget|dashboard|tracker|extension|landing page|prototype|mvp)";
const BUILD_IDEA = new RegExp(
  `\\b(?:i (?:want|wanna|would like) to (?:build|make|create)|idea for (?:an?|my)? ?${ARTIFACT}|what if (?:i|we) (?:built|made|created)|new idea:|app idea|(?:i'?ve been thinking|i'?m thinking) (?:about|of) (?:(?:building|making|creating|designing|prototyping|coding)\\b|(?:an?|my|a new|this) (?:\\w+ ){0,2}${ARTIFACT})|i have an idea for (?:an?|my)? ?(?:\\w+ ){0,2}${ARTIFACT})\\b`,
  "i",
);
export const looksBuildShaped = (t: string) => BUILD_IDEA.test(t) || BUILD.test(t);

export interface TierCtx {
  /** A Tier-2 brainstorm session is live on this thread (dialogue-store). */
  brainstormActive: boolean;
  routeKind: string;
  routeConfidence?: string;
  /** The heuristic planner's verdict for this line. */
  mutating: boolean;
  /** A live-tool read ("any WhatsApp updates?"). */
  directTool: boolean;
  osName?: string;
}

export function classifyTier(text: string, ctx: TierCtx): Tier {
  const osName = ctx.osName || "Tony";
  if (parseDefer(text, osName)) return 4;
  // An explicit command stays a command: "tell the coder to…", a live-tool read.
  if ((ctx.routeKind === "Named" && ctx.routeConfidence === "high") || ctx.directTool) return 1;
  if (isCommitCue(text, osName)) return ctx.brainstormActive ? 3 : 1;
  // Thinking out loud beats the mutating verb list ("…an app that sends reminders") — but only
  // when the line opens that way. A mutating command that merely mentions a brainstorm ("send my
  // brainstorm notes to Sam", "schedule a brainstorming session…") stays a command (card + agent).
  if (looksBrainstorm(text) && (!ctx.mutating || leadsBrainstorm(text, osName))) return 2;
  if (ctx.brainstormActive && !ctx.mutating) return 2;
  return 1;
}

// ── Tier 3 target (U5) ──────────────────────────────────────────────────────

export type OfferTarget = { kind: "pipeline" } | { kind: "agent"; role: AgentRole };

/**
 * Who a Tier-3 yes hands the work to: a build-shaped conversation → the full pipeline; otherwise
 * the agent the brainstorm was about (the Domain / mentioned agent Tony kept it from), else the
 * routing matrix's read of what was said. Null: nothing to delegate (Tony just keeps talking).
 */
export function offerTarget(o: { buildShaped: boolean; topicRole?: AgentRole; userText: string; cfg: RoutingConfig; osName?: string }): OfferTarget | null {
  if (o.buildShaped || looksBuildShaped(o.userText)) return { kind: "pipeline" };
  if (o.topicRole && !isSelfRoleId(o.topicRole, o.osName)) return { kind: "agent", role: o.topicRole };
  const r = resolve(o.userText, o.cfg, o.osName ?? "");
  if ((r.kind === "Named" || r.kind === "Domain") && r.role && !isSelfRoleId(r.role, o.osName)) return { kind: "agent", role: r.role as AgentRole };
  return null;
}
