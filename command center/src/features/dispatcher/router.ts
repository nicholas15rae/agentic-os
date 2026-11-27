import type { RoutingConfig } from "@/lib/platform";

/**
 * Agent routing resolver (Part 1): turns free text into a `Route` using the
 * user's trigger matrix (`OsConfig.routing`). Pure and deterministic.
 *
 * Mirrors `src-tauri/src/commands/routing.rs` exactly — both sides are
 * checked against the same fixtures (`router.fixtures.json`) so the two
 * implementations can't quietly drift apart. See that file's doc comment
 * for the full algorithm description; this file follows it step for step.
 */

/** "Direct": a live-tool read question Tony answers himself (`directTool`); never from `resolve`.
 * "Self": the line addresses Tony himself ("thanks tony", "ask the dispatcher…", "system status")
 * and nothing else — Tony answers; never a delegation, never a routing notice. */
export type RouteKind = "Named" | "Domain" | "Tab" | "Llm" | "Default" | "Direct" | "Self";
export type Confidence = "high" | "medium" | "low";

export interface Route {
  role: string | null;
  reason: string;
  confidence: Confidence;
  kind: RouteKind;
  /** The request with a resolved delegation phrase stripped (Named kind only); the original text otherwise. */
  task: string;
}

/** Tie-break order for domain scoring. `general` sits last (its own topic
 * triggers are mostly intercepted earlier by the OS-control intent layer). */
export const DOMAIN_TIEBREAK = ["booking", "bizops", "finance", "coder", "designer", "director", "librarian", "prompter", "general"] as const;

/** Role ids that ARE Tony (the OS itself): never a delegation target. The OS name (lower-cased)
 * counts too (`isSelfRoleId(id, osName)`). Mirrors `SELF_ROLE_IDS` in routing.rs. */
export const SELF_ROLE_IDS = ["general", "tony", "os", "dispatcher", "orchestrator", "jarvis"] as const;
/** Words that address Tony in a line ("ask tony…", "thanks jarvis", "ask the dispatcher…"),
 * plus the OS name. "general" / "os" are role ids only — too common as words. */
export const SELF_NAMES = ["tony", "jarvis", "dispatcher", "orchestrator"] as const;

export function isSelfRoleId(id: string, osName = ""): boolean {
  const v = id.trim().toLowerCase();
  if (!v) return false;
  return (SELF_ROLE_IDS as readonly string[]).includes(v) || (!!osName.trim() && v === osName.trim().toLowerCase());
}

const VERBS_A = ["tell", "ask", "have", "get", "let", "send", "route", "hand", "pass"];
const VERBS_B = ["check", "draft", "find", "look", "search", "tell", "send", "book", "schedule", "fetch", "get", "read", "email", "call", "write", "create", "cancel", "update", "confirm", "fix"];
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Interjections a leading self address may open with ("hey tony, …", "ok jarvis …"). */
const ADDRESS_LEADS = ["hey", "hi", "ok", "okay", "yo", "so"];
/** After "ask / tell / have … <self name>", the words that keep it an address ("ask tony to …",
 * "tell the dispatcher about …", "let tony know", "have jarvis check …", "tell tony I'm…", or the
 * line's end). Any other word makes the name a noun modifier ("get the orchestrator react code
 * working"): a mention, not an address. VERBS_B count too. */
const ADDRESS_NEXT = ["to", "about", "for", "know", "please", "what", "whats", "how", "hows", "if", "whether", "when", "where", "who", "why", "which", "that", "i", "im", "ill", "we", "you", "my", "me", "it", "its", "the", "a", "an", "this", "and"];
/** A trailing self name right after one of these is an object, not a vocative ("…availability for
 * friday", "fix the bug in the orchestrator", "play something by tony"). */
const NOT_VOCATIVE_BEFORE = ["the", "a", "an", "my", "our", "your", "his", "her", "their", "its", "this", "that", "next", "last", "every", "for", "to", "in", "into", "on", "of", "at", "by", "from", "with", "about", "until", "till", "before", "after", "since", "than", "like", "via", "and", "or"];

/** The exact default trigger matrix (mirrors `default_routing_agents()` in os_core.rs). */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  // `general` (Tony) has no name triggers: addressing him is `SELF_NAMES` → kind "Self".
  autoSwitch: true,
  agents: {
    // Section 20.1: the frozen Booking Desk has no topics; acting logistics are Tony's, recording /
    // editing a self-tape the Director's. Its own names stay, so addressing it is Named and the
    // switchboard holds the turn with Tony's FROZEN note (mirrors os_core.rs `BOOKING_NAMES`).
    booking: { names: ["booking desk", "booking agent", "B&Co"], domains: [] },
    prompter: {
      names: ["prompter", "prompt builder", "spec writer", "architect prompt"],
      domains: ["write a prompt", "build a prompt", "break it into phases", "master prompt", "prompt for claude"],
    },
    coder: {
      names: ["coder", "developer", "dev agent", "engineer"],
      domains: ["write code", "fix bug", "tauri", "rust", "typescript", "react", "git commit", "repo", "script", "terminal"],
    },
    designer: {
      names: ["designer", "ui agent", "ux agent"],
      domains: ["ui", "ux", "layout", "css", "color palette", "prototype", "play place", "mockup", "animation"],
    },
    director: {
      names: ["director", "editor", "media agent", "video editor"],
      domains: [
        "edit video", "self-tape edit", "render", "captions", "reel", "short-form", "thumbnail", "headshot", "photo edit", "b-roll",
        "record a self-tape", "record my self-tape", "film a self-tape", "film my self-tape", "self-tape recording", "edit my self-tape", "edit the self-tape",
      ],
    },
    librarian: {
      names: ["librarian", "memory", "vault", "researcher"],
      domains: ["search vault", "rag", "knowledge graph", "find document", "notes", "lookup"],
    },
    // Section 20.2: bizops = the store / brand; money = finance; calendar, schedule, reminders,
    // infrastructure and (for now) acting = Tony. Contracting (the future Job Desk) is Tony's too
    // until a Job Desk exists (mirrors os_core.rs `CONTRACTING_TO_TONY`).
    bizops: {
      names: ["bizops", "operations manager", "ops manager", "business manager", "operations", "business"],
      domains: ["inventory", "fulfillment", "open orders", "bf supplements", "supplements", "born fortuna", "instagram", "ecommerce", "online store"],
    },
    finance: {
      names: ["finance", "finance agent", "bookkeeper", "bookkeeping", "accountant"],
      domains: ["ledger", "expenses", "receipt", "receipts", "invoice", "invoices", "cheque", "cheques", "money", "hst", "commission", "commissions", "cash flow", "profit", "p&l", "my books"],
    },
    general: {
      names: [],
      domains: [
        "system status", "switch model", "droplet", "docker", "n8n", "server status", "calendar", "schedule", "reminder", "reminders", "remind me",
        "audition", "auditions", "casting", "casting call", "casting email", "casting emails", "self-tape", "self tape", "callback", "wardrobe", "availability",
        "bookings", "talent agent", "my agent", "agency", "imperious", "draft email to agent",
        "job desk", "contracting", "masonry", "job site", "job sites", "subcontractor", "subcontractors", "quote", "quotes", "estimate", "estimates",
      ],
    },
  },
};

/** What Rust seeds a fresh master switchboard with (os_core.rs `DEFAULT_FROZEN_AGENTS`). */
const DEFAULT_ROUTER_FROZEN: readonly string[] = ["booking", "librarian"];
/** The master switchboard's frozen agents the router skips (Section 20.1). The os store keeps it
 * in sync with os.json (`setRouterFrozenAgents`); until the config loads it is Rust's default. */
let routerFrozen: readonly string[] = DEFAULT_ROUTER_FROZEN;

/** Keep the router's frozen set in step with os.json's `switchboard.frozenAgents`. */
export function setRouterFrozenAgents(list: readonly string[] | null | undefined): void {
  routerFrozen = list ? list.map((a) => a.trim().toLowerCase()).filter(Boolean) : DEFAULT_ROUTER_FROZEN;
}

/** Test hook: back to Rust's default frozen set. */
export function resetRouterFrozenAgents(): void {
  routerFrozen = DEFAULT_ROUTER_FROZEN;
}

/** `role` is frozen on the master switchboard: its topics never route (a name still does, so the
 * switchboard can hold it with a note). Tony never is. Mirrors `frozen_role` in routing.rs. */
export function isFrozenRole(role: string, frozen: readonly string[] = routerFrozen): boolean {
  return role !== "general" && frozen.some((f) => f.trim().toLowerCase() === role.toLowerCase());
}

/** Whisper's "WhatsApp" → "what's up" is only the app when a word right before it names a place
 * or a target ("on / my / check / open / from / via what's up") … No "in" / "the": "I'm in,
 * what's up?" and "the what's up…" are as often a greeting. */
const WHATSUP_APP_BEFORE = ["on", "my", "check", "open", "from", "via"];
/** … except "come on / hang on / hold on, what's up" (a greeting, not "on WhatsApp") … */
const WHATSUP_ON_IDIOM = ["come", "hang", "hold"];
/** … or a messaging noun follows it ("what's up messages"). Mirrors routing.rs. */
const WHATSUP_APP_AFTER = ["message", "messages", "msg", "msgs", "text", "texts", "chat", "chats", "group", "groups", "dm", "dms", "notification", "notifications"];

/** "…what's up with / on / in / at / for / about X": a question about X, not the app. Mirrors routing.rs. */
const WHATSUP_ABOUT = ["with", "on", "in", "at", "for", "about"];

/** The word before "whats up" makes it the app: a before-cue, never "…what's up with X" (a
 * question about X: "check what's up with the droplet", "check what's up on my calendar") and
 * never "come / hang / hold on". A bare "check what's up" / "on whats up" is still the app. */
function whatsupBeforeCue(toks: string[], i: number): boolean {
  const before = toks[i - 1] ?? "";
  if (!WHATSUP_APP_BEFORE.includes(before)) return false;
  // … unless a messaging noun comes later ("check whats up for new messages").
  const after = toks[i + 2];
  const about = after === "with" || (after !== undefined && WHATSUP_ABOUT.includes(after) && toks[i + 3] !== undefined);
  if (about && !toks.slice(i + 2).some((w) => WHATSUP_APP_AFTER.includes(w))) return false;
  return !(before === "on" && WHATSUP_ON_IDIOM.includes(toks[i - 2] ?? ""));
}

/**
 * Whisper's WhatsApp mangles → "whatsapp", token by token: "whats app" / "what sapp" always;
 * "whats up" only next to a WhatsApp cue (above) — "what's up", "hey tony what's up" and
 * "what's up with the build" are greetings and stay as they are. Only the word right before
 * "whats" counts ("…on my phone now hey tony what's up" is still a greeting).
 */
function fixWhatsappMangles(toks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const [w, next] = [toks[i], toks[i + 1]];
    const app =
      (w === "whats" && next === "app") ||
      (w === "what" && next === "sapp") ||
      (w === "whats" && next === "up" && (whatsupBeforeCue(toks, i) || WHATSUP_APP_AFTER.includes(toks[i + 2] ?? "")));
    if (app) {
      out.push("whatsapp");
      i += 1;
    } else out.push(w);
  }
  return out;
}

/**
 * lowercase; strip punctuation except `&`; collapse whitespace; fix
 * Whisper's WhatsApp mangles ("whats app", "what sapp", and "whats up" only
 * when it is clearly the app — `fixWhatsappMangles`) → "whatsapp"; spell out
 * number words 1..10.
 *
 * NOTE: a matching-only normalization. A Named address's `Route.task` is cut
 * from the ORIGINAL text (`originalTail`): the agent gets Nic's exact words
 * (file names, versions, URLs), never this lower-cased, punctuation-stripped form.
 */
export function normalize(text: string): string {
  let cleaned = "";
  for (const ch of text) {
    if (/[a-z0-9&]/i.test(ch)) cleaned += ch.toLowerCase();
    else if (/\s/.test(ch)) cleaned += " ";
    // other punctuation: dropped entirely (not replaced by a space), so
    // "what's" normalizes to "whats", not "what s".
  }
  return fixWhatsappMangles(cleaned.split(/\s+/).filter(Boolean))
    .map((w) => {
      const i = NUMBER_WORDS.indexOf(w);
      return i >= 0 ? String(i + 1) : w;
    })
    .join(" ");
}

const tokenize = (s: string): string[] => s.split(" ").filter(Boolean);

/**
 * The ORIGINAL text after the first `k` normalized tokens (a Named address's delegation phrase
 * stripped), keeping Nic's casing, punctuation, file names, versions, URLs and decimals. Words
 * are mapped by how many normalized tokens each one yields; when that bookkeeping doesn't add up
 * (a Whisper mangle merged two words) the normalized tail is used, as before. Pure.
 */
export function originalTail(original: string, k: number): string {
  const words = original.trim().split(/\s+/).filter(Boolean);
  const counts = words.map((w) => tokenize(normalize(w)).length);
  const total = tokenize(normalize(original)).length;
  if (counts.reduce((a, b) => a + b, 0) !== total) return tokenize(normalize(original)).slice(k).join(" ");
  let seen = 0;
  let i = 0;
  while (i < words.length && seen + counts[i] <= k) seen += counts[i++];
  if (seen !== k) return tokenize(normalize(original)).slice(k).join(" ");
  // Leading punctuation-only words ("—", ",") never start the task.
  while (i < words.length && counts[i] === 0) i++;
  return words.slice(i).join(" ").replace(/^[,:;.\-–—\s]+/, "").trim();
}
const tokAt = (toks: string[], i: number): string | undefined => toks[i];
const roleRank = (role: string): number => {
  const i = (DOMAIN_TIEBREAK as readonly string[]).indexOf(role);
  return i < 0 ? DOMAIN_TIEBREAK.length : i;
};

/** Every (role, normalized name) pair; a self-alias role key counts as `general`, and the
 * built-in self names (+ the OS name) are added as `general`'s. */
function namePairs(cfg: RoutingConfig, osName: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, t] of Object.entries(cfg.agents)) {
    const role = isSelfRoleId(key, osName) ? "general" : key;
    // A frozen agent's NAMES still fire (kind Named): the switchboard holds the turn with Tony and
    // adds the FROZEN note. Only its topics are skipped (step (c)).
    for (const n of t.names) {
      const norm = normalize(n);
      if (norm) out.push([role, norm]);
    }
  }
  for (const n of [...SELF_NAMES, osName]) {
    const norm = normalize(n);
    if (norm && !out.some(([r, p]) => r === "general" && p === norm)) out.push(["general", norm]);
  }
  return out;
}

/** Does one of `names` match starting exactly at `toks[pos..]`? Longest phrase
 * wins on overlap; ties broken by `DOMAIN_TIEBREAK` order. */
function matchNameAt(toks: string[], pos: number, names: [string, string][]): [string, number] | null {
  let best: [string, number] | null = null;
  for (const [role, phrase] of names) {
    const p = tokenize(phrase);
    if (!p.length || pos + p.length > toks.length) continue;
    let ok = true;
    for (let k = 0; k < p.length; k++) if (toks[pos + k] !== p[k]) { ok = false; break; }
    if (!ok) continue;
    const better = !best || p.length > best[1] || (p.length === best[1] && roleRank(role) < roleRank(best[0]));
    if (better) best = [role, p.length];
  }
  return best;
}

function matchNameAnywhere(toks: string[], names: [string, string][]): string | null {
  let best: [string, number] | null = null;
  for (let pos = 0; pos < toks.length; pos++) {
    const m = matchNameAt(toks, pos, names);
    if (!m) continue;
    const better = !best || m[1] > best[1] || (m[1] === best[1] && roleRank(m[0]) < roleRank(best[0]));
    if (better) best = m;
  }
  return best ? best[0] : null;
}

/** "tell/ask/… (it)? (to)? (my/the/our)? NAME": the position NAME would start at after the verb at `i`. */
function verbTarget(toks: string[], i: number): number {
  let j = i + 1;
  if (tokAt(toks, j) === "it") j += 1;
  if (tokAt(toks, j) === "to") j += 1;
  if (["my", "the", "our"].includes(tokAt(toks, j) ?? "")) j += 1;
  return j;
}

/** The word at `k` (right after a self name a VERBS_A verb points at) keeps it an address. */
const addressFollows = (toks: string[], k: number): boolean => {
  const w = tokAt(toks, k);
  return w === undefined || ADDRESS_NEXT.includes(w) || VERBS_B.includes(w);
};

/** The line opens with a self name, optionally after "hey / hi / ok / yo / so". */
function leadsWithSelf(toks: string[], selfNames: [string, string][]): boolean {
  let p = 0;
  while (p < toks.length && ADDRESS_LEADS.includes(toks[p])) p += 1;
  return !!matchNameAt(toks, p, selfNames);
}

/** Words after "email" that make it the mail noun of a read ("audition email check", "booking email
 * updates"), not a command to send one ("booking email Sam about the shoot"). Mirrors routing.rs. */
const MAIL_NOUN_NEXT = ["check", "checks", "read", "update", "updates", "today", "tonight", "yesterday", "from", "inbox", "summary"];

/** In a mail read, the word at `k` right after an opening desk name is "email" used as the mail noun,
 * so "NAME email …" is a topic ("audition email check"), not "NAME, email …". Mirrors `mail_noun_at`. */
function mailNounAt(toks: string[], k: number, original: string): boolean {
  const next = tokAt(toks, k + 1);
  return tokAt(toks, k) === "email" && (next === undefined || MAIL_NOUN_NEXT.includes(next)) && directTool(original) === "gmail";
}

/** Marks that end a spoken address ("booking desk, …", "booking: …", "booking - …"). Mirrors routing.rs. */
const ADDRESS_PAUSES = [",", ":", ";", "!", "?", ".", "—", "–", " - "];
/** The ADDRESS_LEADS that call out to someone ("hey booking agent …"). "ok" / "okay" / "so" are
 * fillers ("Okay, booking emails from today?"): they never make the next word an address. */
const ADDRESS_VOCATIVES = ["hey", "hi", "yo"];
/** After "hey / hi / yo NAME", the words that keep NAME an address ("hey booking any new emails",
 * "hey booking agent did Sam reply?"), besides ADDRESS_NEXT and VERBS_B. Any other word ("hey
 * booking emails from today?") makes NAME a topic word. Mirrors routing.rs. */
const VOCATIVE_NEXT = ["any", "anything", "did", "do", "does", "have", "has", "is", "are", "was", "were", "can", "could", "would", "will"];

/** Every index of `m` in `s`. */
function indicesOf(s: string, m: string): number[] {
  const out: number[] = [];
  for (let i = s.indexOf(m); i >= 0; i = s.indexOf(m, i + 1)) out.push(i);
  return out;
}

/**
 * The line opens by ADDRESSING one of `names` (an agent's), after any "hey / hi / ok / yo / so"
 * leads: the name, then a pause mark or the line's end ("booking desk, any new emails?", "Okay,
 * booking: any emails today?"); or, after a vocative lead only, the name followed by an address
 * word ("hey booking agent any emails?", "hey booking check my inbox"). A name that opens the line
 * as a topic word ("booking emails from today?", "Okay, booking emails from today?", "so audition
 * email check") is no address. `original`: the raw line (its punctuation). Mirrors
 * `leads_with_name` in routing.rs.
 */
function leadsWithName(original: string, toks: string[], names: [string, string][]): boolean {
  let p = 0;
  while (p < toks.length && ADDRESS_LEADS.includes(toks[p])) p += 1;
  const hit = matchNameAt(toks, p, names);
  if (!hit) return false;
  const nlen = hit[1];
  if (toks.slice(0, p).some((w) => ADDRESS_VOCATIVES.includes(w))) {
    const k = p + nlen + (tokAt(toks, p + nlen) === "please" ? 1 : 0);
    const w = tokAt(toks, k);
    const follows = w === undefined || ((ADDRESS_NEXT.includes(w) || VOCATIVE_NEXT.includes(w) || VERBS_B.includes(w)) && !mailNounAt(toks, k, original));
    if (follows) return true;
  }
  // The text after the leads, up to the next pause mark, is exactly the name. A pause inside the
  // leads ("Okay, …") doesn't count: the first one with more than the leads before it.
  const before = (i: number) => tokenize(normalize(original.slice(0, i))).length;
  const pauses = ADDRESS_PAUSES.flatMap((m) => indicesOf(original, m)).sort((a, b) => a - b);
  const cut = pauses.find((i) => before(i) > p) ?? original.length;
  return before(cut) === p + nlen;
}

/** The line ends with a self name ("…, tony", "… tony please") that isn't an object (`NOT_VOCATIVE_BEFORE`). */
function trailingVocative(toks: string[], selfNames: [string, string][]): boolean {
  const end = toks[toks.length - 1] === "please" ? toks.length - 1 : toks.length;
  for (const [, phrase] of selfNames) {
    const p = tokenize(phrase);
    const start = end - p.length;
    if (!p.length || start < 0 || p.some((w, k) => toks[start + k] !== w)) continue;
    const prev = tokAt(toks, start - 1);
    if (prev === undefined || !NOT_VOCATIVE_BEFORE.includes(prev)) return true;
  }
  return false;
}

/** "ask / tell / have … <self name> to / about / …" anywhere in the line. */
function asksSelf(toks: string[], all: [string, string][]): boolean {
  for (let i = 0; i < toks.length; i++) {
    if (!VERBS_A.includes(toks[i])) continue;
    const j = verbTarget(toks, i);
    const m = matchNameAt(toks, j, all);
    if (m && m[0] === "general" && addressFollows(toks, j + m[1])) return true;
  }
  return false;
}

/** Self names that are also everyday nouns in this codebase ("fix the rust dispatcher",
 * "orchestrator react code has a bug"): they address Tony only when asked ("ask the dispatcher
 * to …"), never just by opening or ending a line. Mirrors routing.rs. */
const COMMON_SELF_NOUNS = ["dispatcher", "orchestrator"];
const properSelfNames = (selfNames: [string, string][]): [string, string][] =>
  selfNames.filter(([, p]) => !COMMON_SELF_NOUNS.includes(p.replace(/^the /, "")));

/** `addressesSelf` on tokens (mirrors `self_addressed` in routing.rs). */
const selfAddressed = (toks: string[], all: [string, string][], selfNames: [string, string][]): boolean => {
  const proper = properSelfNames(selfNames);
  return leadsWithSelf(toks, proper) || asksSelf(toks, all) || trailingVocative(toks, proper);
};

/**
 * The line ADDRESSES Tony by a self name (`SELF_NAMES`, the OS name) in a real address position:
 * it opens with the name ("hey tony, …"), asks him ("ask tony to …", "tell the dispatcher about
 * …"), or ends on it as a vocative ("…, tony"). A mention anywhere else ("fix the bug in the
 * orchestrator react code", "my availability for friday") is not an address. Pure.
 */
export function addressesSelf(text: string, cfg: RoutingConfig, osName = ""): boolean {
  const toks = tokenize(normalize(text.trim()));
  const all = namePairs(cfg, osName);
  return selfAddressed(toks, all, all.filter(([r]) => r === "general"));
}

export interface ResolveOpts {
  /** Read the topic only: a self address no longer beats a Domain match (the agent a
   * brainstorm was about: tier.ts `offerTarget`, the voice controller's Tier-2 `agentKept`). */
  ignoreSelfAddress?: boolean;
  /** The frozen agents whose TOPICS are skipped (names still resolve); default: the master switchboard's (`setRouterFrozenAgents`). */
  frozen?: readonly string[];
}

/** Does `phrase` occur as a contiguous run of whole tokens anywhere in `toks`? */
function containsPhrase(toks: string[], phrase: string): boolean {
  const p = tokenize(phrase);
  if (!p.length || p.length > toks.length) return false;
  for (let i = 0; i + p.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < p.length; k++) if (toks[i + k] !== p[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function domainScore(toks: string[], domains: string[]): number {
  let score = 0;
  for (const d of domains) {
    const dn = normalize(d);
    if (dn && containsPhrase(toks, dn)) score += dn.length;
  }
  return score;
}

/**
 * Resolve one utterance against the routing matrix. Priority:
 *  (a) explicit delegation pattern → Named, high
 *  (b) any name trigger mentioned anywhere → Named, medium
 *  (c) domain trigger score (longest phrases win; ties → `DOMAIN_TIEBREAK`) → Domain,
 *      unless Tony was ADDRESSED by a self name (`addressesSelf`: the line opens with it, "ask
 *      tony to …", or a trailing "…, tony"): then Self (his name beats a topic). A mere mention
 *      ("the orchestrator react code", "for friday") never beats a topic. `ignoreSelfAddress`
 *      skips this (the topic's agent, for an offer).
 *  (d) only Tony himself was addressed / mentioned / matched → Self (role general)
 *  (e) nothing → Default (the caller decides: keep the current tab, or general)
 *
 * Tony (`general`, any self alias, `SELF_NAMES`, the OS name) is never a delegation target:
 * a self match is skipped and the scan goes on, so "ask tony to ask the coder…" is coder.
 * `osName`: the configured OS name (Rust reads `cfg.os_name`); "tony" is built in either way.
 */
export function resolve(text: string, cfg: RoutingConfig, osName = "", opts: ResolveOpts = {}): Route {
  const original = text.trim();
  const norm = normalize(original);
  const toks = tokenize(norm);
  const frozen = opts.frozen ?? routerFrozen;
  const all = namePairs(cfg, osName);
  const names = all.filter(([r]) => r !== "general");
  const selfNames = all.filter(([r]) => r === "general");
  let selfHit = false;

  // (a) "tell/ask/have/get/let/send/route/hand/pass (it)? (to)? (my/the/our)? NAME (agent/desk)? (to/about/for)? …"
  for (let i = 0; i < toks.length; i++) {
    if (!VERBS_A.includes(toks[i])) continue;
    const j = verbTarget(toks, i);
    const m = matchNameAt(toks, j, all);
    if (m && m[0] === "general") {
      selfHit = true; // "ask tony to …": keep scanning for a real agent
      continue;
    }
    if (m) {
      const [role, nlen] = m;
      let k = j + nlen;
      if (["agent", "desk"].includes(tokAt(toks, k) ?? "")) k += 1;
      if (["to", "about", "for"].includes(tokAt(toks, k) ?? "")) k += 1;
      const task = originalTail(original, k);
      return { role, reason: "you named this agent directly", confidence: "high", kind: "Named", task: task || original };
    }
  }
  // (a) "NAME,? (please)? VERB…" — direct address at the start of the utterance. A leading
  // self name ("tony, coder, fix the build") is skipped once and the address retried after it.
  let pos = 0;
  for (let pass = 0; pass < 2; pass++) {
    const head = matchNameAt(toks, pos, all);
    if (!head) break;
    const [role, nlen] = head;
    let k = pos + nlen;
    if (tokAt(toks, k) === "please") k += 1;
    if (role === "general") {
      selfHit = true;
      pos = k;
      continue;
    }
    const v = tokAt(toks, k);
    if (v !== undefined && VERBS_B.includes(v) && !mailNounAt(toks, k, original)) {
      const task = originalTail(original, k);
      return { role, reason: "you named this agent directly", confidence: "high", kind: "Named", task: task || original };
    }
    break;
  }
  // (b) any (non-self) name trigger mentioned anywhere. A mail / calendar read ("check gmail for
  // booking emails", "any audition emails?", "booking emails from today?") is Tony's own live tool:
  // a name merely mentioned there, even first, is a topic, not an address. Only addressing the desk
  // ("booking desk, any …", "hey booking agent …") or step (a) above ("tell booking to …") hands it over.
  const mentioned = matchNameAnywhere(toks, names);
  const liveRead = directTool(original);
  if (mentioned && (!(liveRead === "gmail" || liveRead === "calendar" || liveRead === "finance" || liveRead === "vault") || leadsWithName(original, toks, names)))
    return { role: mentioned, reason: "this agent was named in the request", confidence: "medium", kind: "Named", task: original };
  if (matchNameAnywhere(toks, selfNames)) selfHit = true;
  // A self name in an address position (beats a topic below); any other mention is step (d) only.
  const selfAddress = selfAddressed(toks, all, selfNames);

  // (c) domain triggers (Tony's own topics only mark a self topic).
  let best: [string, number] | null = null;
  let selfTopic = false;
  for (const role of DOMAIN_TIEBREAK) {
    if (isFrozenRole(role, frozen)) continue;
    const t = cfg.agents[role];
    if (!t) continue;
    const score = domainScore(toks, t.domains);
    if (score <= 0) continue;
    if (role === "general") {
      selfTopic = true;
      continue;
    }
    if (!best || score > best[1]) best = [role, score];
  }
  // Tony's name beats a topic: a line that ADDRESSES him by a self name ("hey tony, check my
  // availability", "…, tony") is his to answer; only naming an agent (above) delegates.
  if (best && selfAddress && !opts.ignoreSelfAddress) return { role: "general", reason: "you addressed the OS by name", confidence: "high", kind: "Self", task: original };
  if (best) {
    const [role, score] = best;
    return { role, reason: "matched this agent's trigger words", confidence: score >= 6 ? "medium" : "low", kind: "Domain", task: original };
  }
  // (d) only Tony himself.
  if (selfHit || selfAddress || selfTopic) return { role: "general", reason: "you addressed the OS itself", confidence: "high", kind: "Self", task: original };
  // (e) nothing matched.
  return { role: null, reason: "no name or trigger matched", confidence: "low", kind: "Default", task: original };
}

// ── Trigger overlap (Settings → Routing, Section 20.2) ──────────────────────

export interface TriggerMatch {
  role: string;
  /** The role's own trigger phrases (names and topics) found in the text, as configured. */
  phrases: string[];
  frozen: boolean;
}

/** Every role whose names or topics occur in `text` as whole words (self-alias keys count as
 * `general`), frozen ones included and marked. Pure; independent of the resolver's priorities. */
export function matchingAgents(text: string, cfg: RoutingConfig, osName = "", frozen: readonly string[] = routerFrozen): TriggerMatch[] {
  const toks = tokenize(normalize(text.trim()));
  const by = new Map<string, string[]>();
  for (const [key, t] of Object.entries(cfg.agents)) {
    const role = isSelfRoleId(key, osName) ? "general" : key;
    for (const p of [...t.names, ...t.domains]) {
      const n = normalize(p);
      if (n && containsPhrase(toks, n)) by.set(role, [...(by.get(role) ?? []), p]);
    }
  }
  return [...by.entries()].map(([role, phrases]) => ({ role, phrases, frozen: isFrozenRole(role, frozen) }));
}

/** Trigger phrases that, said on their own, match more than one role's triggers (one row per
 * phrase, the roles in matrix order). Frozen roles never route, so they are left out. Pure. */
export function overlappingPhrases(cfg: RoutingConfig, osName = "", frozen: readonly string[] = routerFrozen): { phrase: string; roles: string[] }[] {
  const seen = new Set<string>();
  const out: { phrase: string; roles: string[] }[] = [];
  for (const t of Object.values(cfg.agents)) {
    for (const p of [...t.names, ...t.domains]) {
      const n = normalize(p);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      const roles = matchingAgents(p, cfg, osName, frozen).filter((m) => !m.frozen).map((m) => m.role);
      if (roles.length > 1) out.push({ phrase: p, roles });
    }
  }
  return out;
}

// ── Direct live-tool questions ──────────────────────────────────────────────
// Mirrors `direct_tool` in routing.rs exactly (shared fixtures, `direct` field).

/** Write verbs: the line asks to change something, not to read it ("add a weather widget",
 * "order an umbrella", "mark all emails from Sam as read", "email the forecast to Sam"). */
const DIRECT_WRITE = /\b(?:send|sending|reply|replying|respond|draft|delete|write|compose|forward|archive|trash|unsubscribe|add|set|create|make|build|fix|buy|order|purchase|pay|cancel|book|schedule|reschedule|mark|mute|unmute|block|move|remove|change|edit|rename|update|install|configure|deploy|save|share|post|upload|invite|enable|disable|subscribe|turn on|turn off)\b|\b(?:text|message|tell|email|ping|call) (?:him|her|them|back)\b|\blet (?:him|her|them) know\b|(?:^|\b(?:and|then|please|tony) )(?:email|text|message|dm|ping) (?:the|this|that|it|a|an|my|to)\b/;
/** "update" as a noun ("give me an update on WhatsApp") asks for news: dropped before DIRECT_WRITE. */
const DIRECT_UPDATE_NOUN = /\b(?:an?|any|the|latest|status|quick|no) updates?\b|\bupdate me\b/g;
const DIRECT_WHATSAPP_READ = /\b(?:check|read|any|anything|new|latest|last|recent|unread|updates?|messages?|texts?|chats?|today|whats new|who)\b/;
/** Whisper's "what's up" also normalizes to "whatsapp": that spelling needs the app named as a
 * place ("on / from / check whatsapp") or a messaging noun right after it — never "any updates?". */
const DIRECT_WHATSAPP_NOUN = /\b(?:on|from|in|my|check) whatsapp\b|\bwhatsapp (?:messages?|texts?|chats?|unread)\b/;
const DIRECT_GMAIL = /\b(?:gmail|inbox|emails?|mail)\b/;
const DIRECT_GMAIL_READ = /\b(?:check|read|any|anything|latest|last|recent|unread|updates?|whats in|what is in|did i get|have i got|got any|who emailed|new (?:emails?|mail|messages?))\b/;
/** A booking word next to the mail ("check my gmail for what I got booked for", "call sheets in my
 * inbox"): a booking-mail read (agents.rs `booking_mail_plan`). Mirrors routing.rs. */
const DIRECT_BOOKING_MAIL = /\b(?:booked|bookings?|gigs?|jobs?|auditions?|callbacks?|call ?sheets?|deal memos?|confirmed|on hold|shoots?|avails?)\b/;
/** Google Calendar, read form only ("what's on my calendar tomorrow", "check my calendar"). */
const DIRECT_CALENDAR = /\b(?:calendar|agenda)\b/;
/** Calendar writes DIRECT_WRITE doesn't list ("put / pop / pencil it on my calendar"). */
const DIRECT_CALENDAR_WRITE = /\b(?:put|pop|stick|throw|pencil|block (?:off|out))\b/;
const DIRECT_CALENDAR_READ = /\b(?:check|read|any|anything|whats|what is|what do i have|do i have|am i free|am i busy|show|look|today|tonight|tomorrow|this week|next week|upcoming|next|free|busy|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
/** Weather words only in read form: a question or check, or next to a time / place word. */
const DIRECT_WEATHER = /\bhow (?:hot|cold|warm) is it\b|\b(?:is it|will it|gonna|going to) (?:rain|snow)\b|\btemperature (?:outside|today|tonight|tomorrow|in|out)\b|\bwhats the temperature\b|\b(?:need|bring|take|grab) (?:an |my |the )?umbrella\b|\b(?:whats|what is|hows|how is|check|tell me|give me|show me|get me|any)(?: (?:the|todays|tomorrows|tonights|my|local))? (?:weather|forecast)\b|\b(?:weather|forecast) (?:today|tonight|tomorrow|now|outside|like|later|this|in|for|at|on)\b|^(?:the )?(?:weather|forecast)$/;
/** Work context ("the mail server config", "the sales forecast for Q3"): not an inbox / weather read. */
const DIRECT_NOT_LIVE = /\b(?:widget|server|config|api|bug|code|app|script|dashboard|spreadsheet|sheet|sales|revenue|budget|quarter|q[1-4]|filter|settings?)\b/;
/** A bare messages read ("check my messages", "any new texts", "last 5 messages"): WhatsApp, read by
 * Tony himself — never the agent-report inbox, recent chats or the Booking Desk. Only plain filler
 * words may sit between the read word and the noun, so "my agent messages" never matches. */
const DIRECT_MESSAGES = /\b(?:check|read|any|show|see|new|unread|latest|last|recent|did i get|have i got|got any)\b(?: (?:me|my|the|new|unread|latest|last|recent|\d{1,2}))* (?:messages?|texts?)\b/;
const DIRECT_SPOTIFY = /\b(?:whats playing|what is playing|now playing|what song is this|whats this song|what song is playing|which song is this)\b/;
/** Money READ questions Tony answers from Finance himself (`finance.ask`, read-only): what he owes
 * an agent, what an area made or spent, what's pending, unpaid invoices, HST dates, the money to-do
 * list. Writes stay on the Finance screens (DIRECT_WRITE / DIRECT_FINANCE_WRITE). */
const DIRECT_FINANCE =
  /\b(?:what|how much|who) (?:do |did )?(?:i|we) (?:still )?owe\b|\bcommissions? (?:do |did )?(?:i|we) (?:still )?owe\b|\bhow much commission\b|\bwho (?:still )?owes me\b|\bhow much (?:money )?(?:am i|is) (?:still )?owed\b|\bhow much (?:money )?(?:did|have|has|do|does) (?:i|we|acting|contracting|trades|bf supplements|supplements|the store|my business|personal)(?: \w+)? (?:make|made|earn|earned|bring in|brought in|spend|spent|gross|grossed)\b|\bhow much (?:income|revenue|profit) (?:did|have|has|do)\b|\b(?:whats|what is|anything|any money|any payments?)(?: still)? pending\b|\bpending (?:money|payments?|income)\b|\bwhen (?:is|are) (?:my |the |our |next )*(?:hst|gst)(?: return| payment| filing| remittance)? due\b|\b(?:hst|gst) (?:return |payment |filing |remittance )?(?:is |are )?due\b|\bhow much (?:hst|gst) do i owe\b|\bwhen do i (?:file|pay) (?:my |the )?(?:hst|gst)\b|\b(?:unpaid|outstanding|overdue|open) invoices?\b|\binvoices? (?:are |still )*(?:unpaid|outstanding|overdue|open)\b|\bwho hasnt paid\b|\b(?:money|finance|financial) (?:reminders?|to do|todo)\b/;
/** "How much did contracting make": "make" as earning, not a write. Dropped before DIRECT_WRITE. */
const DIRECT_FINANCE_MAKE = /\bhow much (?:money )?(?:did|have|has|do|does) (?:i|we|acting|contracting|trades|bf supplements|supplements|the store|my business|personal)(?: \w+)? make\b/g;
/** Finance writes DIRECT_WRITE doesn't list ("log the HST on that invoice", "record a cheque"). */
const DIRECT_FINANCE_WRITE = /\b(?:log|record|enter|track|scan|import|export|categori[sz]e|deposit|charge|bill|split|refund|transfer|send)\b/;
/** Not a money question: another live tool's or a work item's subject ("any pending emails",
 * "what orders are pending", "the overdue invoices widget"). */
const DIRECT_FINANCE_NOT = /\b(?:emails?|inbox|mail|gmail|whatsapp|messages?|texts?|calendar|tasks?|todos?|tickets?|builds?|prs?|pull requests?|reviews?|queue|orders?|deliver(?:y|ies)|packages?|shipments?|updates?|widget|server|config|api|bug|code|app|script|spreadsheet|filter|settings?|button|tests?)\b/;

/** Vault READ questions Tony answers with `vault.search` himself (read-only, never finance):
 * "search my vault / notes for …", "find the note about …", "what did I save about …". Mirrors routing.rs. */
const DIRECT_VAULT =
  /\bsearch (?:through |in )?(?:my |the )?(?:vault|notes|brainstorms|documents|docs|scripts|sides|auditions|jobs|ideas)\b|\b(?:look|dig) (?:through|in) (?:my |the )?(?:vault|notes|brainstorms|documents|docs)\b|\blook up (?:the |my |that )?(?:note|notes|brainstorm|document|doc|script|sides|idea) (?:about|on|for|from|with)\b|\bfind (?:the |my |that |a |any )(?:note|notes|brainstorm|brainstorms|document|doc|script|sides|idea|ideas) (?:about|on|for|from|with|where|that i)\b|\bwhat did i (?:save|write down|note down|jot down) (?:about|on|for|regarding)\b|\bwhat have i (?:saved|written down|noted down|jotted down) (?:about|on|for|regarding)\b|\b(?:anything|something) (?:in|from) (?:my |the )?(?:vault|notes|brainstorms|documents)\b|\bdo i have (?:a |any )?(?:notes?|documents?|brainstorms?|ideas?) (?:about|on|for)\b|\b(?:whats|what is) in (?:my |the )?(?:vault|notes)\b/;
/** "What did I save / write down about": a read, not a write. Dropped before DIRECT_WRITE. */
const DIRECT_VAULT_SAVED = /\bwhat (?:did|have) i (?:save|saved|write down|written down|note down|noted down|jot down|jotted down)\b/g;
/** Vault writes DIRECT_WRITE doesn't list ("put this in my vault", "re-index the vault"). */
const DIRECT_VAULT_WRITE = /\b(?:put|stick|store|keep|file|log|record|clear|wipe|reindex|re index|index|export|import|back up|backup|tag)\b/;
/** Another live tool's or the code's subject ("search my notes for that email", "find the doc about the repo"). */
const DIRECT_VAULT_NOT = /\b(?:emails?|inbox|gmail|whatsapp|calendar|repo|repository|codebase|github|web|online|internet|google)\b/;

export type DirectTool = "whatsapp" | "gmail" | "calendar" | "weather" | "spotify" | "finance" | "vault";

/**
 * "Any WhatsApp updates?", "check my inbox", "will it rain tomorrow", "what's playing":
 * read questions Tony answers from his own live tools, whichever tab is open. The caller
 * keeps a Named delegation; a write aimed at the service never matches.
 */
export function directTool(text: string): DirectTool | null {
  const n = normalize(text);
  if (!n || DIRECT_WRITE.test(n.replace(DIRECT_UPDATE_NOUN, " ").replace(DIRECT_VAULT_SAVED, " ").replace(DIRECT_FINANCE_MAKE, " "))) return null;
  if (/\bwhatsapp\b/.test(n)) {
    const lower = text.toLowerCase();
    const saysApp = lower.includes("sapp") || lower.includes("s app");
    const read = saysApp ? n === "whatsapp" || DIRECT_WHATSAPP_READ.test(n) : DIRECT_WHATSAPP_NOUN.test(n);
    if (read) return "whatsapp";
  }
  const work = DIRECT_NOT_LIVE.test(n);
  if (!work && DIRECT_GMAIL.test(n) && (DIRECT_GMAIL_READ.test(n) || DIRECT_BOOKING_MAIL.test(n))) return "gmail";
  if (!work && DIRECT_CALENDAR.test(n) && DIRECT_CALENDAR_READ.test(n) && !DIRECT_CALENDAR_WRITE.test(n)) return "calendar";
  if (!work && DIRECT_WEATHER.test(n)) return "weather";
  if (DIRECT_SPOTIFY.test(n)) return "spotify";
  if (DIRECT_FINANCE.test(n) && !DIRECT_FINANCE_WRITE.test(n) && !DIRECT_FINANCE_NOT.test(n)) return "finance";
  if (DIRECT_VAULT.test(n) && !DIRECT_VAULT_WRITE.test(n) && !DIRECT_VAULT_NOT.test(n)) return "vault";
  if (!work && DIRECT_MESSAGES.test(n)) return "whatsapp";
  return null;
}
