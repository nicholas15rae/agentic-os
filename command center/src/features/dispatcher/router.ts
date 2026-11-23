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
export const DOMAIN_TIEBREAK = ["booking", "bizops", "finance", "ops", "coder", "designer", "director", "librarian", "prompter", "general"] as const;

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

/** The exact default trigger matrix (mirrors `default_routing_agents()` in os_core.rs). */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  // `general` (Tony) has no name triggers: addressing him is `SELF_NAMES` → kind "Self".
  autoSwitch: true,
  agents: {
    booking: {
      names: ["booking", "booking desk", "booking agent", "casting", "audition", "talent agent", "B&Co"],
      domains: ["whatsapp", "messages", "last 5 messages", "check my texts", "casting call", "self-tape", "wardrobe", "availability", "draft email to agent"],
    },
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
      domains: ["edit video", "self-tape edit", "render", "captions", "reel", "short-form", "thumbnail", "headshot", "photo edit", "b-roll"],
    },
    librarian: {
      names: ["librarian", "memory", "vault", "researcher"],
      domains: ["search vault", "rag", "knowledge graph", "find document", "notes", "lookup"],
    },
    ops: {
      names: ["ops", "infra", "infrastructure"],
      domains: ["droplet", "docker", "n8n", "server status", "schedule", "calendar"],
    },
    bizops: {
      names: ["bizops", "operations manager", "ops manager", "business manager", "operations", "business"],
      domains: ["invoice", "quote", "job site", "subcontractor", "inventory", "fulfillment", "open orders", "bf supplements", "supplements", "contracting", "masonry", "ecommerce"],
    },
    finance: {
      names: ["finance", "finance agent", "bookkeeper", "bookkeeping", "accountant"],
      domains: ["ledger", "expenses", "receipt", "receipts", "cash flow", "profit", "p&l", "my books"],
    },
    general: { names: [], domains: ["system status", "switch model"] },
  },
};

/**
 * lowercase; strip punctuation except `&`; collapse whitespace; fix the
 * three Whisper mangles the spec calls out ("whats up/app", "what sapp" →
 * "whatsapp"); spell out number words 1..10.
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
  let s = cleaned.split(/\s+/).filter(Boolean).join(" ");
  for (const [from, to] of [
    [" whats up ", " whatsapp "],
    [" whats app ", " whatsapp "],
    [" what sapp ", " whatsapp "],
  ] as const) {
    const padded = ` ${s} `;
    if (padded.includes(from)) s = padded.split(from).join(to).trim();
  }
  return s
    .split(" ")
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
 *  (c) domain trigger score (longest phrases win; ties → `DOMAIN_TIEBREAK`) → Domain
 *  (d) only Tony himself was addressed / matched → Self (role general)
 *  (e) nothing → Default (the caller decides: keep the current tab, or general)
 *
 * Tony (`general`, any self alias, `SELF_NAMES`, the OS name) is never a delegation target:
 * a self match is skipped and the scan goes on, so "ask tony to ask the coder…" is coder.
 * `osName`: the configured OS name (Rust reads `cfg.os_name`); "tony" is built in either way.
 */
export function resolve(text: string, cfg: RoutingConfig, osName = ""): Route {
  const original = text.trim();
  const norm = normalize(original);
  const toks = tokenize(norm);
  const all = namePairs(cfg, osName);
  const names = all.filter(([r]) => r !== "general");
  const selfNames = all.filter(([r]) => r === "general");
  let selfHit = false;

  // (a) "tell/ask/have/get/let/send/route/hand/pass (it)? (to)? (my/the/our)? NAME (agent/desk)? (to/about/for)? …"
  for (let i = 0; i < toks.length; i++) {
    if (!VERBS_A.includes(toks[i])) continue;
    let j = i + 1;
    if (tokAt(toks, j) === "it") j += 1;
    if (tokAt(toks, j) === "to") j += 1;
    if (["my", "the", "our"].includes(tokAt(toks, j) ?? "")) j += 1;
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
    if (v !== undefined && VERBS_B.includes(v)) {
      const task = originalTail(original, k);
      return { role, reason: "you named this agent directly", confidence: "high", kind: "Named", task: task || original };
    }
    break;
  }
  // (b) any (non-self) name trigger mentioned anywhere.
  const mentioned = matchNameAnywhere(toks, names);
  if (mentioned) return { role: mentioned, reason: "this agent was named in the request", confidence: "medium", kind: "Named", task: original };
  if (matchNameAnywhere(toks, selfNames)) selfHit = true;

  // (c) domain triggers (Tony's own topics only mark a self hit).
  let best: [string, number] | null = null;
  for (const role of DOMAIN_TIEBREAK) {
    const t = cfg.agents[role];
    if (!t) continue;
    const score = domainScore(toks, t.domains);
    if (score <= 0) continue;
    if (role === "general") {
      selfHit = true;
      continue;
    }
    if (!best || score > best[1]) best = [role, score];
  }
  if (best) {
    const [role, score] = best;
    return { role, reason: "matched this agent's trigger words", confidence: score >= 6 ? "medium" : "low", kind: "Domain", task: original };
  }
  // (d) only Tony himself.
  if (selfHit) return { role: "general", reason: "you addressed the OS itself", confidence: "high", kind: "Self", task: original };
  // (e) nothing matched.
  return { role: null, reason: "no name or trigger matched", confidence: "low", kind: "Default", task: original };
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
/** Weather words only in read form: a question or check, or next to a time / place word. */
const DIRECT_WEATHER = /\bhow (?:hot|cold|warm) is it\b|\b(?:is it|will it|gonna|going to) (?:rain|snow)\b|\btemperature (?:outside|today|tonight|tomorrow|in|out)\b|\bwhats the temperature\b|\b(?:need|bring|take|grab) (?:an |my |the )?umbrella\b|\b(?:whats|what is|hows|how is|check|tell me|give me|show me|get me|any)(?: (?:the|todays|tomorrows|tonights|my|local))? (?:weather|forecast)\b|\b(?:weather|forecast) (?:today|tonight|tomorrow|now|outside|like|later|this|in|for|at|on)\b|^(?:the )?(?:weather|forecast)$/;
/** Work context ("the mail server config", "the sales forecast for Q3"): not an inbox / weather read. */
const DIRECT_NOT_LIVE = /\b(?:widget|server|config|api|bug|code|app|script|dashboard|spreadsheet|sheet|sales|revenue|budget|quarter|q[1-4]|filter|settings?)\b/;
const DIRECT_SPOTIFY = /\b(?:whats playing|what is playing|now playing|what song is this|whats this song|what song is playing|which song is this)\b/;

export type DirectTool = "whatsapp" | "gmail" | "weather" | "spotify";

/**
 * "Any WhatsApp updates?", "check my inbox", "will it rain tomorrow", "what's playing":
 * read questions Tony answers from his own live tools, whichever tab is open. The caller
 * keeps a Named delegation; a write aimed at the service never matches.
 */
export function directTool(text: string): DirectTool | null {
  const n = normalize(text);
  if (!n || DIRECT_WRITE.test(n.replace(DIRECT_UPDATE_NOUN, " "))) return null;
  if (/\bwhatsapp\b/.test(n)) {
    const lower = text.toLowerCase();
    const saysApp = lower.includes("sapp") || lower.includes("s app");
    const read = saysApp ? n === "whatsapp" || DIRECT_WHATSAPP_READ.test(n) : DIRECT_WHATSAPP_NOUN.test(n);
    if (read) return "whatsapp";
  }
  const work = DIRECT_NOT_LIVE.test(n);
  if (!work && DIRECT_GMAIL.test(n) && DIRECT_GMAIL_READ.test(n)) return "gmail";
  if (!work && DIRECT_WEATHER.test(n)) return "weather";
  if (DIRECT_SPOTIFY.test(n)) return "spotify";
  return null;
}
