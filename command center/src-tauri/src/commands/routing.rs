//! Agent routing resolver (Part 1): turns free text into a `Route` using the
//! user's trigger matrix (`OsConfig.routing`). Pure and deterministic — no
//! LLM call here (that's a separate, optional step the caller may add when
//! the result is `Default`/low-confidence — see `agents::run_os_turn`).
//!
//! Mirrored exactly in TS at `src/features/dispatcher/router.ts`. Both sides
//! are checked against the same fixtures (`src/features/dispatcher/router.fixtures.json`)
//! so the two implementations can't quietly drift apart.

use super::os_core::{AgentTriggers, OsConfig};
use serde::{Deserialize, Serialize};

/// Tie-break order for domain scoring (longer/explicit matches win regardless;
/// this only breaks exact score ties). `general`'s own domain triggers are
/// mostly intercepted earlier by the OS-control intent layer (Part 4), so it
/// sits last here as a catch-all, never stealing a tie from a sub-agent.
pub const DOMAIN_TIEBREAK: [&str; 10] = ["booking", "bizops", "finance", "ops", "coder", "designer", "director", "librarian", "prompter", "general"];

/// "(hey tony,? )?(tell|ask|have|get|let|send|route|hand|pass) (it )?(to )?(my|the|our)? NAME…"
const VERBS_A: [&str; 9] = ["tell", "ask", "have", "get", "let", "send", "route", "hand", "pass"];
/// "NAME,? (please )?(check|draft|find|…)" — a direct address followed by a command verb.
const VERBS_B: [&str; 20] = [
    "check", "draft", "find", "look", "search", "tell", "send", "book", "schedule", "fetch", "get", "read", "email", "call", "write", "create", "cancel", "update", "confirm", "fix",
];
const NUMBER_WORDS: [&str; 10] = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/// Interjections a leading self address may open with ("hey tony, …", "ok jarvis …"). Mirrors router.ts.
const ADDRESS_LEADS: [&str; 6] = ["hey", "hi", "ok", "okay", "yo", "so"];
/// After "ask / tell / have … <self name>", the words that keep it an address ("ask tony to …",
/// "tell the dispatcher about …", "let tony know", "have jarvis check …", "tell tony I'm…", or the
/// line's end). Any other word makes the name a noun modifier ("get the orchestrator react code
/// working"): a mention, not an address. `VERBS_B` count too. Mirrors router.ts.
const ADDRESS_NEXT: [&str; 31] = [
    "to", "about", "for", "know", "please", "what", "whats", "how", "hows", "if", "whether", "when", "where", "who", "why", "which", "that", "i", "im", "ill", "we", "you", "my", "me", "it", "its", "the", "a", "an", "this", "and",
];
/// A trailing self name right after one of these is an object, not a vocative ("…availability for
/// friday", "fix the bug in the orchestrator", "play something by tony"). Mirrors router.ts.
const NOT_VOCATIVE_BEFORE: [&str; 36] = [
    "the", "a", "an", "my", "our", "your", "his", "her", "their", "its", "this", "that", "next", "last", "every", "for", "to", "in", "into", "on", "of", "at", "by", "from", "with", "about", "until", "till", "before", "after", "since", "than", "like", "via", "and", "or",
];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    Named,
    Domain,
    Tab,
    Llm,
    Default,
    /// The line addresses Tony himself ("thanks tony", "ask the dispatcher…", "system status")
    /// and nothing else: Tony answers, never a delegation. `Self` is a keyword in Rust.
    #[serde(rename = "Self")]
    Own,
}

impl RouteKind {
    /// The wire / TS spelling ("Self" for `Own`).
    pub fn as_str(self) -> &'static str {
        match self {
            RouteKind::Named => "Named",
            RouteKind::Domain => "Domain",
            RouteKind::Tab => "Tab",
            RouteKind::Llm => "Llm",
            RouteKind::Default => "Default",
            RouteKind::Own => "Self",
        }
    }
}

/// Role ids that ARE Tony (the OS itself): never a delegation target. The OS name
/// (lower-cased) counts too. Mirrors `SELF_ROLE_IDS` in router.ts.
pub const SELF_ROLE_IDS: [&str; 6] = ["general", "tony", "os", "dispatcher", "orchestrator", "jarvis"];
/// Words that address Tony in a line, plus the OS name. "general" / "os" are role ids only
/// (too common as words). Mirrors `SELF_NAMES` in router.ts.
pub const SELF_NAMES: [&str; 4] = ["tony", "jarvis", "dispatcher", "orchestrator"];

/// `id` is Tony: a self alias (`SELF_ROLE_IDS`) or the configured OS name, any case.
pub fn is_self_role(id: &str, os_name: &str) -> bool {
    let v = id.trim().to_lowercase();
    if v.is_empty() {
        return false;
    }
    SELF_ROLE_IDS.contains(&v.as_str()) || (!os_name.trim().is_empty() && v == os_name.trim().to_lowercase())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub role: Option<String>,
    pub reason: String,
    /// "high" | "medium" | "low".
    pub confidence: String,
    pub kind: RouteKind,
    /// The request, with any resolved delegation phrase ("tell my booking
    /// agent to…") stripped. Falls back to the original text when stripping
    /// would leave nothing, or for every other kind.
    pub task: String,
}

/// Whisper's "WhatsApp" → "what's up" is only the app when a word right before it names a place
/// or a target ("on / my / check / open / from / via what's up") … No "in" / "the": "I'm in,
/// what's up?" and "the what's up…" are as often a greeting.
const WHATSUP_APP_BEFORE: [&str; 6] = ["on", "my", "check", "open", "from", "via"];
/// … except "come on / hang on / hold on, what's up" (a greeting, not "on WhatsApp") …
const WHATSUP_ON_IDIOM: [&str; 3] = ["come", "hang", "hold"];
/// "…what's up with / on / in / at / for / about X": a question about X, not the app.
const WHATSUP_ABOUT: [&str; 6] = ["with", "on", "in", "at", "for", "about"];
/// … or a messaging noun follows it ("what's up messages"). Mirrors router.ts.
const WHATSUP_APP_AFTER: [&str; 14] = ["message", "messages", "msg", "msgs", "text", "texts", "chat", "chats", "group", "groups", "dm", "dms", "notification", "notifications"];

/// The word before "whats up" (at `i`) makes it the app: a before-cue, never "…what's up with X"
/// (a question about X: "check what's up with the droplet") and never "come / hang / hold on".
fn whatsup_before_cue(toks: &[&str], i: usize) -> bool {
    let Some(before) = i.checked_sub(1).and_then(|j| tok_at(toks, j)) else { return false };
    if !WHATSUP_APP_BEFORE.contains(&before) {
        return false;
    }
    // "…what's up with / on / in / at / for / about X" is a question about X ("check what's up
    // on my calendar"); a bare "check what's up" / "on whats up" is still the app. Mirrors router.ts.
    // … unless a messaging noun comes later ("check whats up for new messages").
    let after = tok_at(toks, i + 2);
    let about = after == Some("with") || (after.is_some_and(|w| WHATSUP_ABOUT.contains(&w)) && tok_at(toks, i + 3).is_some());
    if about && !toks[i + 2..].iter().any(|w| WHATSUP_APP_AFTER.contains(w)) {
        return false;
    }
    !(before == "on" && i.checked_sub(2).and_then(|j| tok_at(toks, j)).is_some_and(|w| WHATSUP_ON_IDIOM.contains(&w)))
}

/// Whisper's WhatsApp mangles → "whatsapp", token by token: "whats app" / "what sapp" always;
/// "whats up" only next to a WhatsApp cue (above) — "what's up", "hey tony what's up" and
/// "what's up with the build" are greetings and stay as they are. Only the word right before
/// "whats" counts ("…on my phone now hey tony what's up" is still a greeting).
fn fix_whatsapp_mangles<'a>(toks: &[&'a str]) -> Vec<&'a str> {
    let mut out = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        let (w, next) = (toks[i], tok_at(toks, i + 1));
        let app = (w == "whats" && next == Some("app"))
            || (w == "what" && next == Some("sapp"))
            || (w == "whats" && next == Some("up") && (whatsup_before_cue(toks, i) || tok_at(toks, i + 2).is_some_and(|a| WHATSUP_APP_AFTER.contains(&a))));
        if app {
            out.push("whatsapp");
            i += 2;
        } else {
            out.push(w);
            i += 1;
        }
    }
    out
}

/// lowercase; strip punctuation except `&`; collapse whitespace; fix
/// Whisper's WhatsApp mangles ("whats app", "what sapp", and "whats up" only
/// when it is clearly the app — `fix_whatsapp_mangles`) → "whatsapp"; spell
/// out number words 1..10 so "last five messages" matches the trigger phrase
/// "last 5 messages".
///
/// NOTE: this is a normalization for MATCHING only — `Route::task` is built
/// from this normalized text (lower-case, punctuation-stripped), not the
/// original casing/punctuation, to keep the two-language implementation
/// simple and identical. That's a deliberate, documented simplification.
pub fn normalize(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '&' {
            cleaned.extend(ch.to_lowercase());
        } else if ch.is_whitespace() {
            cleaned.push(' ');
        }
        // any other punctuation is dropped entirely (not replaced by a space),
        // so "what's" normalizes to "whats", not "what s".
    }
    let toks: Vec<&str> = cleaned.split_whitespace().collect();
    fix_whatsapp_mangles(&toks)
        .into_iter()
        .map(|w| match NUMBER_WORDS.iter().position(|n| *n == w) {
            Some(i) => (i + 1).to_string(),
            None => w.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Leading interjections a spoken request may open with ("aye tony, …", "yo jarvis …").
/// An explicit list only: guessing "one unknown word before the name" would turn
/// "play tony bennett" into "bennett". No bare "a" / "i" (Whisper's "aye"): real words.
const INTERJECTIONS: [&str; 15] = ["hey", "hi", "aye", "ay", "ayy", "ayo", "yo", "oi", "ok", "okay", "alright", "so", "um", "uh", "yeah"];
const POLITE_LEADS: [&str; 8] = ["please", "can you", "could you", "would you", "will you", "go ahead and", "i want you to", "i need you to"];

/// `s` starts with the word(s) `lead` (case-insensitive) followed by a space,
/// `, : ; ! .` or the end → the rest, with separators trimmed. (Not `-`: "so-called".)
fn strip_lead<'a>(s: &'a str, lead: &str) -> Option<&'a str> {
    let head = s.get(..lead.len())?;
    if !head.eq_ignore_ascii_case(lead) {
        return None;
    }
    let rest = &s[lead.len()..];
    if !(rest.is_empty() || rest.starts_with([' ', ',', ':', ';', '!', '.'])) {
        return None;
    }
    Some(rest.trim_start_matches([' ', ',', '.', '!', ':', ';', '-']))
}

/// "Aye, Tony, can you play some Bilmuri?" → "play some Bilmuri": drops a leading
/// interjection, the OS's name (`os_name`, "tony", "jarvis") and politeness leads,
/// keeping the original casing. Only explicit leading words are removed, so
/// "play tony bennett" stays intact.
pub(crate) fn strip_address(text: &str, os_name: &str) -> String {
    const EDGE: [char; 8] = [',', '.', '!', '?', ':', ';', '-', ' '];
    let name = os_name.trim().to_ascii_lowercase();
    let mut names: Vec<&str> = vec!["tony", "jarvis"];
    if !name.is_empty() && !names.contains(&name.as_str()) {
        names.insert(0, &name);
    }
    let mut s = text.trim().trim_matches(EDGE);
    for _ in 0..4 {
        let before = s;
        if let Some(r) = INTERJECTIONS.iter().find_map(|w| strip_lead(s, w)) {
            s = r;
        }
        if let Some(r) = names.iter().find_map(|w| strip_lead(s, w)) {
            s = r;
        }
        if let Some(r) = POLITE_LEADS.iter().find_map(|w| strip_lead(s, w)) {
            s = r;
        }
        s = s.trim_matches(EDGE);
        if s == before {
            break;
        }
    }
    s.to_string()
}

fn tokenize(s: &str) -> Vec<&str> {
    s.split(' ').filter(|w| !w.is_empty()).collect()
}

fn tok_at<'a>(toks: &[&'a str], i: usize) -> Option<&'a str> {
    toks.get(i).copied()
}

fn role_rank(role: &str) -> usize {
    DOMAIN_TIEBREAK.iter().position(|r| *r == role).unwrap_or(DOMAIN_TIEBREAK.len())
}

/// All (role, normalized trigger phrase) pairs for every role's `names`. A self-alias role key
/// counts as `general`, and the built-in self names (+ the OS name) are added as `general`'s.
fn name_pairs(cfg: &OsConfig) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (key, t) in &cfg.routing.agents {
        let role = if is_self_role(key, &cfg.os_name) { "general".to_string() } else { key.clone() };
        // A frozen agent's NAMES still fire (kind Named): addressing it resolves to it, and the
        // switchboard (`agents::switchboard_hold` / `switchboard_note`) keeps the turn with Tony
        // and adds the FROZEN note. Only its TOPICS are skipped (step (c) in `resolve`).
        for n in &t.names {
            let norm = normalize(n);
            if !norm.is_empty() {
                out.push((role.clone(), norm));
            }
        }
    }
    for n in SELF_NAMES.iter().copied().chain(std::iter::once(cfg.os_name.as_str())) {
        let norm = normalize(n);
        if !norm.is_empty() && !out.iter().any(|(r, p)| r == "general" && *p == norm) {
            out.push(("general".to_string(), norm));
        }
    }
    out
}

/// `role` is frozen on the master switchboard (`switchboard.frozenAgents`): its topics never
/// route (a NAME still does, so the switchboard can hold it with a note). Tony (`general`) is
/// never frozen. Mirrors `isFrozenRole` in router.ts.
pub fn frozen_role(cfg: &OsConfig, role: &str) -> bool {
    role != "general" && cfg.switchboard.frozen_agents.iter().any(|f| f.trim().eq_ignore_ascii_case(role))
}

/// Does one of `names` match starting exactly at `toks[pos..]`? The longest
/// phrase wins on overlap; ties broken by `DOMAIN_TIEBREAK` order.
fn match_name_at(toks: &[&str], pos: usize, names: &[(String, String)]) -> Option<(String, usize)> {
    let mut best: Option<(String, usize)> = None;
    for (role, phrase) in names {
        let p = tokenize(phrase);
        if p.is_empty() || pos + p.len() > toks.len() {
            continue;
        }
        if &toks[pos..pos + p.len()] == p.as_slice() {
            let better = match &best {
                None => true,
                Some((br, bl)) => p.len() > *bl || (p.len() == *bl && role_rank(role) < role_rank(br)),
            };
            if better {
                best = Some((role.clone(), p.len()));
            }
        }
    }
    best
}

fn match_name_anywhere(toks: &[&str], names: &[(String, String)]) -> Option<String> {
    let mut best: Option<(String, usize)> = None;
    for pos in 0..toks.len() {
        if let Some((role, len)) = match_name_at(toks, pos, names) {
            let better = match &best {
                None => true,
                Some((br, bl)) => len > *bl || (len == *bl && role_rank(&role) < role_rank(br)),
            };
            if better {
                best = Some((role, len));
            }
        }
    }
    best.map(|(r, _)| r)
}

/// "tell/ask/… (it)? (to)? (my/the/our)? NAME": the position NAME would start at after the verb at `i`.
fn verb_target(toks: &[&str], i: usize) -> usize {
    let mut j = i + 1;
    if tok_at(toks, j) == Some("it") {
        j += 1;
    }
    if tok_at(toks, j) == Some("to") {
        j += 1;
    }
    if matches!(tok_at(toks, j), Some("my") | Some("the") | Some("our")) {
        j += 1;
    }
    j
}

/// The word at `k` (right after a self name a `VERBS_A` verb points at) keeps it an address.
fn address_follows(toks: &[&str], k: usize) -> bool {
    match tok_at(toks, k) {
        None => true,
        Some(w) => ADDRESS_NEXT.contains(&w) || VERBS_B.contains(&w),
    }
}

/// The line opens with a self name, optionally after "hey / hi / ok / yo / so".
fn leads_with_self(toks: &[&str], self_names: &[(String, String)]) -> bool {
    let p = toks.iter().take_while(|w| ADDRESS_LEADS.contains(*w)).count();
    match_name_at(toks, p, self_names).is_some()
}

/// Words after "email" that make it the mail noun of a read ("audition email check", "booking
/// email updates"), not a command to send one ("booking email Sam about the shoot").
const MAIL_NOUN_NEXT: [&str; 11] = ["check", "checks", "read", "update", "updates", "today", "tonight", "yesterday", "from", "inbox", "summary"];

/// In a mail read, the word at `k` right after an opening desk name is "email" used as the mail
/// noun, so "NAME email …" is a topic ("audition email check"), not "NAME, email …". Mirrors router.ts.
fn mail_noun_at(toks: &[&str], k: usize, original: &str) -> bool {
    tok_at(toks, k) == Some("email") && tok_at(toks, k + 1).map_or(true, |w| MAIL_NOUN_NEXT.contains(&w)) && direct_tool(original) == Some("gmail")
}

/// Marks that end a spoken address ("booking desk, …", "booking: …", "booking - …").
const ADDRESS_PAUSES: [&str; 9] = [",", ":", ";", "!", "?", ".", "\u{2014}", "\u{2013}", " - "];
/// The `ADDRESS_LEADS` that call out to someone ("hey booking agent …"). "ok" / "okay" / "so" are
/// fillers ("Okay, booking emails from today?"): they never make the next word an address.
const ADDRESS_VOCATIVES: [&str; 3] = ["hey", "hi", "yo"];
/// After "hey / hi / yo NAME", the words that keep NAME an address ("hey booking any new emails",
/// "hey booking agent did Sam reply?"), besides `ADDRESS_NEXT` and `VERBS_B`. Any other word
/// ("hey booking emails from today?") makes NAME a topic word. Mirrors router.ts.
const VOCATIVE_NEXT: [&str; 15] = ["any", "anything", "did", "do", "does", "have", "has", "is", "are", "was", "were", "can", "could", "would", "will"];

/// The line opens by ADDRESSING one of `names` (an agent's), after any "hey / hi / ok / yo / so"
/// leads: the name, then a pause mark or the line's end ("booking desk, any new emails?",
/// "Okay, booking: any emails today?"); or, after a vocative lead only, the name followed by
/// an address word ("hey booking agent any emails?", "hey booking check my inbox"). A name that
/// opens the line as a topic word ("booking emails from today?", "Okay, booking emails from
/// today?", "so audition email check") is no address. `original`: the raw line (its
/// punctuation). Mirrors `leadsWithName` in router.ts.
fn leads_with_name(original: &str, toks: &[&str], names: &[(String, String)]) -> bool {
    let p = toks.iter().take_while(|w| ADDRESS_LEADS.contains(*w)).count();
    let Some((_, nlen)) = match_name_at(toks, p, names) else { return false };
    if toks[..p].iter().any(|w| ADDRESS_VOCATIVES.contains(w)) {
        let k = p + nlen + usize::from(tok_at(toks, p + nlen) == Some("please"));
        let follows = match tok_at(toks, k) {
            None => true,
            Some(w) => (ADDRESS_NEXT.contains(&w) || VOCATIVE_NEXT.contains(&w) || VERBS_B.contains(&w)) && !mail_noun_at(toks, k, original),
        };
        if follows {
            return true;
        }
    }
    // The text after the leads, up to the next pause mark, is exactly the name. A pause inside
    // the leads ("Okay, …") doesn't count: the first one with more than the leads before it.
    let mut pauses: Vec<usize> = ADDRESS_PAUSES.iter().flat_map(|m| original.match_indices(m).map(|(i, _)| i)).collect();
    pauses.sort_unstable();
    let before = |i: usize| tokenize(&normalize(&original[..i])).len();
    let cut = pauses.into_iter().find(|&i| before(i) > p).unwrap_or(original.len());
    before(cut) == p + nlen
}

/// The line ends with a self name ("…, tony", "… tony please") that isn't an object (`NOT_VOCATIVE_BEFORE`).
fn trailing_vocative(toks: &[&str], self_names: &[(String, String)]) -> bool {
    let end = if toks.last() == Some(&"please") { toks.len() - 1 } else { toks.len() };
    self_names.iter().any(|(_, phrase)| {
        let p = tokenize(phrase);
        if p.is_empty() || p.len() > end {
            return false;
        }
        let start = end - p.len();
        if toks[start..end] != p[..] {
            return false;
        }
        start.checked_sub(1).and_then(|j| tok_at(toks, j)).is_none_or(|prev| !NOT_VOCATIVE_BEFORE.contains(&prev))
    })
}

/// "ask / tell / have … <self name> to / about / …" anywhere in the line.
fn asks_self(toks: &[&str], all: &[(String, String)]) -> bool {
    (0..toks.len()).filter(|&i| VERBS_A.contains(&toks[i])).any(|i| {
        let j = verb_target(toks, i);
        matches!(match_name_at(toks, j, all), Some((role, nlen)) if role == "general" && address_follows(toks, j + nlen))
    })
}

/// The line ADDRESSES Tony by a self name (`SELF_NAMES`, `cfg.os_name`) in a real address
/// position: it opens with the name ("hey tony, …"), asks him ("ask tony to …", "tell the
/// dispatcher about …"), or ends on it as a vocative ("…, tony"). A mention anywhere else ("fix
/// the bug in the orchestrator react code", "my availability for friday") is not an address.
/// Mirrors `selfAddressed` / `addressesSelf` in router.ts.
fn self_addressed(toks: &[&str], all: &[(String, String)], self_names: &[(String, String)]) -> bool {
    // "dispatcher" / "orchestrator" are everyday nouns here ("fix the rust dispatcher"): they
    // address Tony only when asked ("ask the dispatcher to …"), not by opening or ending a line.
    let proper: Vec<(String, String)> = self_names
        .iter()
        .filter(|(_, p)| !COMMON_SELF_NOUNS.contains(&p.strip_prefix("the ").unwrap_or(p)))
        .cloned()
        .collect();
    leads_with_self(toks, &proper) || asks_self(toks, all) || trailing_vocative(toks, &proper)
}

/// Self names that are also everyday nouns in this codebase. Mirrors `COMMON_SELF_NOUNS` in router.ts.
const COMMON_SELF_NOUNS: [&str; 2] = ["dispatcher", "orchestrator"];

/// Does `phrase` occur as a contiguous run of whole tokens anywhere in `toks`?
fn contains_phrase(toks: &[&str], phrase: &str) -> bool {
    let p = tokenize(phrase);
    if p.is_empty() || p.len() > toks.len() {
        return false;
    }
    toks.windows(p.len()).any(|w| w == p.as_slice())
}

fn domain_score(toks: &[&str], t: &AgentTriggers) -> usize {
    t.domains.iter().map(|d| normalize(d)).filter(|dn| !dn.is_empty() && contains_phrase(toks, dn)).map(|dn| dn.len()).sum()
}

/// Resolve one utterance against the routing matrix. Priority:
///  (a) explicit delegation pattern → Named, high
///  (b) any name trigger mentioned anywhere → Named, medium
///  (c) domain trigger score (longest phrases win; ties → `DOMAIN_TIEBREAK`) → Domain,
///      unless Tony was ADDRESSED by a self name (`self_addressed`: the line opens with it, "ask
///      tony to …", or a trailing "…, tony"): then `Own` (his name beats a topic). A mere mention
///      ("the orchestrator react code", "for friday") never beats a topic.
///  (d) only Tony himself was addressed / mentioned / matched → `Own` ("Self", role general)
///  (e) nothing → Default (the caller decides: keep the current tab, or `general`)
///
/// Tony (`general`, any self alias, `SELF_NAMES`, `cfg.os_name`) is never a delegation target:
/// a self match is skipped and the scan goes on, so "ask tony to ask the coder…" is coder.
pub fn resolve(text: &str, cfg: &OsConfig) -> Route {
    let original = text.trim().to_string();
    let norm = normalize(&original);
    let toks = tokenize(&norm);
    let all = name_pairs(cfg);
    let (self_names, names): (Vec<_>, Vec<_>) = all.iter().cloned().partition(|(r, _)| r == "general");
    let mut self_hit = false;

    // (a) "tell/ask/have/get/let/send/route/hand/pass (it)? (to)? (my/the/our)? NAME (agent/desk)? (to/about/for)? …"
    for i in 0..toks.len() {
        if !VERBS_A.contains(&toks[i]) {
            continue;
        }
        let j = verb_target(&toks, i);
        if let Some((role, nlen)) = match_name_at(&toks, j, &all) {
            if role == "general" {
                self_hit = true; // "ask tony to …": keep scanning for a real agent
                continue;
            }
            let mut k = j + nlen;
            if matches!(tok_at(&toks, k), Some("agent") | Some("desk")) {
                k += 1;
            }
            if matches!(tok_at(&toks, k), Some("to") | Some("about") | Some("for")) {
                k += 1;
            }
            let task = toks[k..].join(" ");
            return Route {
                role: Some(role),
                reason: "you named this agent directly".into(),
                confidence: "high".into(),
                kind: RouteKind::Named,
                task: if task.is_empty() { original } else { task },
            };
        }
    }
    // (a) "NAME,? (please)? VERB…" — direct address at the start of the utterance. A leading
    // self name ("tony, coder, fix the build") is skipped once and the address retried after it.
    let mut pos = 0;
    for _ in 0..2 {
        let Some((role, nlen)) = match_name_at(&toks, pos, &all) else { break };
        let mut k = pos + nlen;
        if tok_at(&toks, k) == Some("please") {
            k += 1;
        }
        if role == "general" {
            self_hit = true;
            pos = k;
            continue;
        }
        if matches!(tok_at(&toks, k), Some(v) if VERBS_B.contains(&v)) && !mail_noun_at(&toks, k, &original) {
            let task = toks[k..].join(" ");
            return Route {
                role: Some(role),
                reason: "you named this agent directly".into(),
                confidence: "high".into(),
                kind: RouteKind::Named,
                task: if task.is_empty() { original } else { task },
            };
        }
        break;
    }
    // (b) any (non-self) name trigger mentioned anywhere. A mail / calendar read ("check gmail
    // for booking emails", "any audition emails?", "booking emails from today?") is Tony's own
    // live tool: a name merely mentioned there, even first, is a topic, not an address. Only
    // addressing the desk ("booking desk, any …", "hey booking agent …") or step (a) above
    // ("tell booking to …") hands it over.
    if let Some(role) = match_name_anywhere(&toks, &names) {
        if !matches!(direct_tool(&original), Some("gmail" | "calendar")) || leads_with_name(&original, &toks, &names) {
            return Route { role: Some(role), reason: "this agent was named in the request".into(), confidence: "medium".into(), kind: RouteKind::Named, task: original };
        }
    }
    if match_name_anywhere(&toks, &self_names).is_some() {
        self_hit = true;
    }
    // A self name in an address position (beats a topic below); any other mention is step (d) only.
    let self_address = self_addressed(&toks, &all, &self_names);
    // (c) domain triggers (Tony's own topics only mark a self topic).
    let mut best: Option<(&str, usize)> = None;
    let mut self_topic = false;
    for role in DOMAIN_TIEBREAK.iter().copied() {
        if frozen_role(cfg, role) {
            continue;
        }
        let Some(t) = cfg.routing.agents.get(role) else { continue };
        let score = domain_score(&toks, t);
        if score == 0 {
            continue;
        }
        if role == "general" {
            self_topic = true;
            continue;
        }
        if best.map(|(_, bs)| score > bs).unwrap_or(true) {
            best = Some((role, score));
        }
    }
    // Tony's name beats a topic: a line that ADDRESSES him by a self name ("hey tony, check my
    // availability", "…, tony") is his to answer; only naming an agent (above) delegates.
    if best.is_some() && self_address {
        return Route { role: Some("general".into()), reason: "you addressed the OS by name".into(), confidence: "high".into(), kind: RouteKind::Own, task: original };
    }
    if let Some((role, score)) = best {
        return Route {
            role: Some(role.to_string()),
            reason: "matched this agent's trigger words".into(),
            confidence: if score >= 6 { "medium".into() } else { "low".into() },
            kind: RouteKind::Domain,
            task: original,
        };
    }
    // (d) only Tony himself.
    if self_hit || self_address || self_topic {
        return Route { role: Some("general".into()), reason: "you addressed the OS itself".into(), confidence: "high".into(), kind: RouteKind::Own, task: original };
    }
    // (e) nothing matched.
    Route { role: None, reason: "no name or trigger matched".into(), confidence: "low".into(), kind: RouteKind::Default, task: original }
}

// ── Direct live-tool questions ──────────────────────────────────────────────
//
// "Any WhatsApp updates?", "check my inbox", "will it rain tomorrow", "what's playing":
// read questions Tony answers from his own live tools, whichever tab is open. A
// Named delegation still wins (the caller checks that); a write aimed at the
// service ("reply to Sam on WhatsApp", "draft an email") never matches.

/// Write verbs: the line asks to change something, not to read it ("add a weather widget",
/// "order an umbrella", "mark all emails from Sam as read", "email the forecast to Sam").
const DIRECT_WRITE: &str = r"\b(?:send|sending|reply|replying|respond|draft|delete|write|compose|forward|archive|trash|unsubscribe|add|set|create|make|build|fix|buy|order|purchase|pay|cancel|book|schedule|reschedule|mark|mute|unmute|block|move|remove|change|edit|rename|update|install|configure|deploy|save|share|post|upload|invite|enable|disable|subscribe|turn on|turn off)\b|\b(?:text|message|tell|email|ping|call) (?:him|her|them|back)\b|\blet (?:him|her|them) know\b|(?:^|\b(?:and|then|please|tony) )(?:email|text|message|dm|ping) (?:the|this|that|it|a|an|my|to)\b";
/// "update" as a noun ("give me an update on WhatsApp") asks for news: dropped before DIRECT_WRITE.
const DIRECT_UPDATE_NOUN: &str = r"\b(?:an?|any|the|latest|status|quick|no) updates?\b|\bupdate me\b";
const DIRECT_WHATSAPP_READ: &str = r"\b(?:check|read|any|anything|new|latest|last|recent|unread|updates?|messages?|texts?|chats?|today|whats new|who)\b";
/// Whisper's "what's up" also normalizes to "whatsapp": that spelling needs the app named as a
/// place ("on / from / check whatsapp") or a messaging noun right after it — never "any updates?".
const DIRECT_WHATSAPP_NOUN: &str = r"\b(?:on|from|in|my|check) whatsapp\b|\bwhatsapp (?:messages?|texts?|chats?|unread)\b";
const DIRECT_GMAIL: &str = r"\b(?:gmail|inbox|emails?|mail)\b";
const DIRECT_GMAIL_READ: &str = r"\b(?:check|read|any|anything|latest|last|recent|unread|updates?|whats in|what is in|did i get|have i got|got any|who emailed|new (?:emails?|mail|messages?))\b";
/// A booking word next to the mail ("check my gmail for what I got booked for", "call sheets in my
/// inbox"): a booking-mail read (agents.rs `booking_mail_plan`). Mirrors router.ts.
const DIRECT_BOOKING_MAIL: &str = r"\b(?:booked|bookings?|gigs?|jobs?|auditions?|callbacks?|call ?sheets?|deal memos?|confirmed|on hold|shoots?|avails?)\b";
/// Google Calendar, read form only ("what's on my calendar tomorrow", "check my calendar").
const DIRECT_CALENDAR: &str = r"\b(?:calendar|agenda)\b";
/// Calendar writes DIRECT_WRITE doesn't list ("put / pop / pencil it on my calendar").
const DIRECT_CALENDAR_WRITE: &str = r"\b(?:put|pop|stick|throw|pencil|block (?:off|out))\b";
const DIRECT_CALENDAR_READ: &str = r"\b(?:check|read|any|anything|whats|what is|what do i have|do i have|am i free|am i busy|show|look|today|tonight|tomorrow|this week|next week|upcoming|next|free|busy|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b";
/// Weather words only in read form: a question or check, or next to a time / place word.
const DIRECT_WEATHER: &str = r"\bhow (?:hot|cold|warm) is it\b|\b(?:is it|will it|gonna|going to) (?:rain|snow)\b|\btemperature (?:outside|today|tonight|tomorrow|in|out)\b|\bwhats the temperature\b|\b(?:need|bring|take|grab) (?:an |my |the )?umbrella\b|\b(?:whats|what is|hows|how is|check|tell me|give me|show me|get me|any)(?: (?:the|todays|tomorrows|tonights|my|local))? (?:weather|forecast)\b|\b(?:weather|forecast) (?:today|tonight|tomorrow|now|outside|like|later|this|in|for|at|on)\b|^(?:the )?(?:weather|forecast)$";
/// Work context ("the mail server config", "the sales forecast for Q3"): not an inbox / weather read.
const DIRECT_NOT_LIVE: &str = r"\b(?:widget|server|config|api|bug|code|app|script|dashboard|spreadsheet|sheet|sales|revenue|budget|quarter|q[1-4]|filter|settings?)\b";
/// A bare messages read ("check my messages", "last 5 messages"): WhatsApp, read by Tony himself.
/// Mirrors router.ts `DIRECT_MESSAGES`.
const DIRECT_MESSAGES: &str = r"\b(?:check|read|any|show|see|new|unread|latest|last|recent|did i get|have i got|got any)\b(?: (?:me|my|the|new|unread|latest|last|recent|\d{1,2}))* (?:messages?|texts?)\b";
const DIRECT_SPOTIFY: &str = r"\b(?:whats playing|what is playing|now playing|what song is this|whats this song|what song is playing|which song is this)\b";

fn direct_re(slot: &'static std::sync::OnceLock<regex::Regex>, pat: &str) -> &'static regex::Regex {
    slot.get_or_init(|| regex::Regex::new(pat).unwrap())
}

/// The live tool a read question is for: "whatsapp" | "gmail" | "calendar" | "weather" | "spotify".
/// Mirrored exactly by `directTool()` in router.ts (shared fixtures, `direct` field).
pub fn direct_tool(text: &str) -> Option<&'static str> {
    static WRITE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WA: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WA_READ: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WA_NOUN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static GMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static GMAIL_READ: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static BOOKING_MAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static CALENDAR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static CALENDAR_READ: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static CALENDAR_WRITE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WEATHER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SPOTIFY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static UPDATE_NOUN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static NOT_LIVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static MESSAGES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let n = normalize(text);
    if n.is_empty() || direct_re(&WRITE, DIRECT_WRITE).is_match(&direct_re(&UPDATE_NOUN, DIRECT_UPDATE_NOUN).replace_all(&n, " ")) {
        return None;
    }
    if direct_re(&WA, r"\bwhatsapp\b").is_match(&n) {
        let lower = text.to_lowercase();
        let says_app = lower.contains("sapp") || lower.contains("s app");
        let read = if says_app { n == "whatsapp" || direct_re(&WA_READ, DIRECT_WHATSAPP_READ).is_match(&n) } else { direct_re(&WA_NOUN, DIRECT_WHATSAPP_NOUN).is_match(&n) };
        if read {
            return Some("whatsapp");
        }
    }
    let work = direct_re(&NOT_LIVE, DIRECT_NOT_LIVE).is_match(&n);
    if !work && direct_re(&GMAIL, DIRECT_GMAIL).is_match(&n) && (direct_re(&GMAIL_READ, DIRECT_GMAIL_READ).is_match(&n) || direct_re(&BOOKING_MAIL, DIRECT_BOOKING_MAIL).is_match(&n)) {
        return Some("gmail");
    }
    if !work && direct_re(&CALENDAR, DIRECT_CALENDAR).is_match(&n) && direct_re(&CALENDAR_READ, DIRECT_CALENDAR_READ).is_match(&n) && !direct_re(&CALENDAR_WRITE, DIRECT_CALENDAR_WRITE).is_match(&n) {
        return Some("calendar");
    }
    if !work && direct_re(&WEATHER, DIRECT_WEATHER).is_match(&n) {
        return Some("weather");
    }
    if direct_re(&SPOTIFY, DIRECT_SPOTIFY).is_match(&n) {
        return Some("spotify");
    }
    if !work && direct_re(&MESSAGES, DIRECT_MESSAGES).is_match(&n) {
        return Some("whatsapp");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        #[allow(dead_code)]
        desc: String,
        text: String,
        role: Option<String>,
        kind: String,
        #[serde(default)]
        task_contains: Option<String>,
        /// `direct_tool`'s answer; missing = None.
        #[serde(default)]
        direct: Option<String>,
        /// `cfg.os_name` for this case; missing = the default ("Tony").
        #[serde(default)]
        os_name: Option<String>,
        /// `switchboard.frozen_agents` for this case; missing = the default set.
        #[serde(default)]
        frozen: Option<Vec<String>>,
    }

    fn kind_str(k: RouteKind) -> &'static str {
        k.as_str()
    }

    #[test]
    fn is_self_role_matches_aliases_and_os_name() {
        for id in ["tony", "Tony", "general", "dispatcher", "orchestrator", "os", "jarvis", " TONY "] {
            assert!(is_self_role(id, "Tony"), "{id}");
        }
        assert!(is_self_role("friday", "Friday"));
        for id in ["prompter", "coder", "booking", "", "friday"] {
            assert!(!is_self_role(id, "Tony"), "{id}");
        }
    }

    #[test]
    fn self_kind_serializes_as_self() {
        assert_eq!(serde_json::to_string(&RouteKind::Own).unwrap(), "\"Self\"");
        assert_eq!(serde_json::from_str::<RouteKind>("\"Self\"").unwrap(), RouteKind::Own);
        assert_eq!(RouteKind::Own.as_str(), "Self");
    }

    #[test]
    fn tony_is_never_a_delegation_target() {
        let cfg = ops_thawed(); // Ops (a frozen placeholder) stands in for another agent's topic
        let r = resolve("ask tony to ask the coder to fix it", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("coder"), RouteKind::Named));
        assert!(r.task.contains("fix"));
        // A leading self address is skipped once, then the real agent is addressed.
        let r = resolve("tony, coder, fix the build", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("coder"), RouteKind::Named));
        // The renamed OS is a self name too; an old config that still lists "tony" / a self key
        // never yields a Named general.
        let mut cfg = OsConfig::default();
        cfg.os_name = "Friday".into();
        cfg.routing.agents.get_mut("general").unwrap().names = vec!["tony".into()];
        cfg.routing.agents.insert("dispatcher".into(), AgentTriggers { names: vec!["boss".into()], domains: vec![] });
        for text in ["thanks friday", "thanks tony", "ask the boss what time it is"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some("general"), RouteKind::Own), "{text}");
        }
        // Tony's name beats a topic (it used to be: a sub-agent topic wins over a self address).
        let cfg = ops_thawed(); // Ops (a frozen placeholder) stands in for another agent's topic
        for text in ["tony check my whatsapp messages", "hey tony, render the reel", "tony, how's the droplet doing", "jarvis redo the color palette", "ask the dispatcher to check my calendar"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind, r.confidence.as_str()), (Some("general"), RouteKind::Own, "high"), "{text}");
        }
        let mut friday = OsConfig::default();
        friday.os_name = "Friday".into();
        let r = resolve("friday, check my reel for the shoot", &friday);
        assert_eq!((r.role.as_deref(), r.kind), (Some("general"), RouteKind::Own));
        // Without his name the same topic still delegates; his own topic alone doesn't beat it.
        let r = resolve("render the reel", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("director"), RouteKind::Domain));
        let r = resolve("friday, check my reel for the shoot", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("director"), RouteKind::Domain));
        let r = resolve("system status of the droplet", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("ops"), RouteKind::Domain));
        // A Named agent still wins over Tony's name.
        let r = resolve("hey tony, ask the director to edit video for the shoot", &cfg);
        assert_eq!((r.role.as_deref(), r.kind, r.confidence.as_str(), r.task.as_str()), (Some("director"), RouteKind::Named, "high", "edit video for the shoot"));
        let r = resolve("tony, my coder hasn't replied about the layout", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("coder"), RouteKind::Named));
    }

    /// Section 20.1: a frozen agent's TOPICS never fire (the line falls through to the next live
    /// match, or Tony), but addressing it BY NAME still resolves to it (kind Named), so the
    /// switchboard holds the turn with Tony and adds the FROZEN note (agents.rs).
    #[test]
    fn a_frozen_agent_is_named_but_its_topics_never_fire() {
        let cfg = OsConfig::default();
        assert!(frozen_role(&cfg, "librarian") && frozen_role(&cfg, "booking") && !frozen_role(&cfg, "general") && !frozen_role(&cfg, "coder"));
        // Addressed by name: Named, the frozen role itself.
        for (text, role) in [
            ("ask the librarian to search vault for the contract", "librarian"),
            ("librarian, find document about the lease", "librarian"),
            ("ask the booking desk to check my availability", "booking"),
            ("booking desk, any casting calls", "booking"),
            ("tony, my booking agent hasn't replied about the wardrobe", "booking"),
            ("send it to b&co", "booking"),
        ] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some(role), RouteKind::Named), "{text}");
        }
        // A frozen agent's topic falls through: Librarian topics alone route nowhere, Booking's
        // old topics are Tony's own now.
        let r = resolve("find document about the lease", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (None, RouteKind::Default), "{r:?}");
        for text in ["draft email to agent about the audition", "check my casting call availability"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some("general"), RouteKind::Own), "{text}");
        }
        // …and a live agent's topic in the same line still wins over a frozen agent's topic.
        let r = resolve("find document about the rust repo", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("coder"), RouteKind::Domain));
        // Thawed, the Librarian's topics route again.
        let mut thawed = OsConfig::default();
        thawed.switchboard.frozen_agents.clear();
        assert_eq!(resolve("find document about the lease", &thawed).role.as_deref(), Some("librarian"));
        // Freezing a live agent: its address still names it; its topic goes to the next agent.
        let mut cold = OsConfig::default();
        cold.switchboard.frozen_agents.push("Coder".into());
        let r = resolve("ask the coder to fix bug in the layout", &cold);
        assert_eq!((r.role.as_deref(), r.kind, r.confidence.as_str()), (Some("coder"), RouteKind::Named, "high"), "{r:?}");
        let r = resolve("fix bug in the layout", &cold);
        assert_eq!((r.role.as_deref(), r.kind), (Some("designer"), RouteKind::Domain), "{r:?}");
    }

    /// Regression: the override fired for a self name ANYWHERE in the line, so the common nouns in
    /// `SELF_NAMES` ("dispatcher", "orchestrator") and a renamed OS name ("Friday") beat every
    /// topic — in `route_for_turn` too. Mirrors router.test.ts.
    #[test]
    fn only_a_real_address_beats_a_topic() {
        let cfg = ops_thawed(); // Ops (a frozen placeholder) stands in for another agent's topic
        let mut friday = OsConfig::default();
        friday.os_name = "Friday".into();
        // A mention (a noun, an object) leaves the topic's agent in charge.
        for (text, c, role) in [
            ("fix bug in the orchestrator react code", &cfg, "coder"),
            ("refactor the dispatcher rust code", &cfg, "coder"),
            ("render the reel for friday", &friday, "director"),
            ("fix the layout css before friday", &friday, "designer"),
            ("fix bug in the orchestrator", &cfg, "coder"),
            ("get the orchestrator react code working", &cfg, "coder"),
            ("the dispatcher keeps timing out, is the droplet healthy", &cfg, "ops"),
        ] {
            let r = resolve(text, c);
            assert_eq!((r.role.as_deref(), r.kind), (Some(role), RouteKind::Domain), "{text}");
        }
        // A mention with no topic is still Tony's (step (d)).
        for text in ["refactor the dispatcher", "so I'm on my phone now hey tony what's up"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some("general"), RouteKind::Own), "{text}");
        }
        // An address — leading (after an interjection), "ask/tell <self> to/about …", trailing vocative.
        for (text, c) in [
            ("hey tony, render the reel", &cfg),
            ("ok jarvis, redo the color palette for the landing page", &cfg),
            ("so tony, is the droplet healthy", &cfg),
            ("yo tony check my docker containers", &cfg),
            ("friday, check my reel for the shoot", &friday),
            ("ask tony to render the reel", &cfg),
            ("tell the dispatcher about the thumbnail", &cfg),
            ("have jarvis check the droplet", &cfg),
            ("let tony know the layout changed", &cfg),
            ("render the reel, tony", &cfg),
            ("is the droplet healthy tony please", &cfg),
            ("render the reel, friday", &friday),
        ] {
            let r = resolve(text, c);
            assert_eq!((r.role.as_deref(), r.kind, r.confidence.as_str(), r.reason.as_str()), (Some("general"), RouteKind::Own, "high", "you addressed the OS by name"), "{text}");
        }
    }

    #[test]
    fn self_addressed_positions() {
        let cfg = OsConfig::default();
        let addressed = |text: &str| {
            let norm = normalize(text);
            let toks = tokenize(&norm);
            let all = name_pairs(&cfg);
            let self_names: Vec<_> = all.iter().filter(|(r, _)| r == "general").cloned().collect();
            self_addressed(&toks, &all, &self_names)
        };
        for text in ["tony", "hey tony", "ok so jarvis check it", "ask tony", "send it to tony", "what do you think, tony", "thanks tony"] {
            assert!(addressed(text), "{text}");
        }
        for text in ["fix bug in the orchestrator react code", "get the orchestrator react code working", "play something by tony", "the dispatcher keeps timing out", "", "please"] {
            assert!(!addressed(text), "{text}");
        }
    }

    #[test]
    fn whatsapp_and_messages_are_not_booking_topics() {
        let cfg = OsConfig::default();
        let d = &cfg.routing.agents["booking"].domains;
        assert!(!d.iter().any(|x| x == "whatsapp" || x == "messages"), "{d:?}");
        assert!(!d.iter().any(|x| x.contains("message") || x.contains("text")), "{d:?}");
        // A plain messages read is Tony's WhatsApp tool, never the Booking Desk or the agent inbox.
        for text in ["check my messages", "any new messages", "read my last five messages", "check my texts"] {
            assert_eq!(direct_tool(text), Some("whatsapp"), "{text}");
        }
        assert_eq!(direct_tool("check my agent messages"), None);
        assert_eq!(direct_tool("check my last five gmail messages"), Some("gmail"));
        for text in ["check my whatsapp", "any whatsapp updates", "what's up", "check my what's up messages"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (None, RouteKind::Default), "{text}");
        }
    }

    /// The default config with the Ops placeholder thawed, for priority tests that use Ops' infra
    /// topics as "another agent's topic".
    fn ops_thawed() -> OsConfig {
        let mut c = OsConfig::default();
        c.switchboard.frozen_agents.retain(|a| a != "ops");
        c
    }

    #[test]
    fn shared_fixtures() {
        let raw = include_str!("../../../src/features/dispatcher/router.fixtures.json");
        let fixtures: Vec<Fixture> = serde_json::from_str(raw).expect("fixtures parse");
        let default_cfg = OsConfig::default();
        assert!(fixtures.len() >= 10, "expected a decent fixture set");
        for f in &fixtures {
            let mut named = OsConfig::default();
            let cfg = match (&f.os_name, &f.frozen) {
                (None, None) => &default_cfg,
                (n, fz) => {
                    if let Some(n) = n {
                        named.os_name = n.clone();
                    }
                    if let Some(fz) = fz {
                        named.switchboard.frozen_agents = fz.clone();
                    }
                    &named
                }
            };
            let r = resolve(&f.text, cfg);
            assert_eq!(r.role, f.role, "role mismatch for {:?}", f.text);
            assert_eq!(kind_str(r.kind), f.kind, "kind mismatch for {:?}", f.text);
            if let Some(needle) = &f.task_contains {
                assert!(r.task.contains(needle.as_str()), "task {:?} should contain {:?} (text: {:?})", r.task, needle, f.text);
            }
            assert_eq!(direct_tool(&f.text), f.direct.as_deref(), "direct tool mismatch for {:?}", f.text);
        }
    }

    #[test]
    fn direct_tool_reads_match_and_writes_never_do() {
        for (text, tool) in [
            ("any WhatsApp updates?", "whatsapp"),
            ("Hey Tony, anything new on WhatsApp", "whatsapp"),
            ("read my last 3 whatsapp messages", "whatsapp"),
            ("what's in my inbox", "gmail"),
            ("did I get any mail today", "gmail"),
            ("is it going to snow tonight", "weather"),
            ("how cold is it outside", "weather"),
            ("what song is this", "spotify"),
            ("give me an update on WhatsApp", "whatsapp"),
            ("do I need an umbrella today", "weather"),
            ("weather forecast for Paris", "weather"),
            ("what's the weather", "weather"),
            ("check my what's up messages", "whatsapp"),
            ("check my Gmail for what I got booked for", "gmail"),
            ("any audition emails?", "gmail"),
            ("search my email for call sheets", "gmail"),
            ("what's on my calendar tomorrow", "calendar"),
            ("check my calendar", "calendar"),
            ("am I free on Friday? check the calendar", "calendar"),
        ] {
            assert_eq!(direct_tool(text), Some(tool), "{text}");
        }
        // Calendar writes and work talk stay off the read path.
        for text in ["add the Netflix shoot to my calendar", "put the audition on my calendar", "put it on my calendar for tomorrow", "fix the calendar widget", "schedule a meeting on my calendar", "cancel tomorrow on my calendar"] {
            assert_eq!(direct_tool(text), None, "{text}");
        }
        for text in ["send a whatsapp to Sam", "delete my last email", "tell him on whatsapp I'm late", "play purple rain", "what's the CPU temperature", "hey what's up", ""] {
            assert_eq!(direct_tool(text), None, "{text}");
        }
        // Writes and work talk that merely mention the weather / mail / WhatsApp words.
        for text in [
            "add a weather widget to the dashboard",
            "set the forecast widget to Toronto",
            "order an umbrella",
            "buy an umbrella on amazon",
            "create a filter for new emails from Amazon",
            "check the new mail server config",
            "pay the invoice from the latest email",
            "add the new emails from Sam to my todo list",
            "mark all emails from Sam as read",
            "cancel the meeting from my inbox invite",
            "add umbrella to my shopping list",
            "update the sales forecast spreadsheet",
            "schedule a meeting with Sam about the forecast",
            "email the forecast to Sam",
            "mute the WhatsApp chat with Sam",
            "what's up, any updates on the build?",
            "hey what's up, any updates?",
            "fix the weather api bug in the code",
            "Ops, turn off the weather alerts",
            "Booking, order an umbrella for the shoot",
        ] {
            assert_eq!(direct_tool(text), None, "{text}");
        }
    }

    #[test]
    fn normalize_handles_mangles_and_numbers() {
        assert_eq!(normalize("whats app"), "whatsapp");
        assert_eq!(normalize("what sapp"), "whatsapp");
        assert_eq!(normalize("hey tony what's new on whats app"), "hey tony whats new on whatsapp");
        assert_eq!(normalize("last five messages"), "last 5 messages");
        assert_eq!(normalize("B&Co"), "b&co");
        assert_eq!(normalize(""), "");
    }

    /// Regression: every "what's up" greeting became "whatsapp" (a Booking domain) and was
    /// delegated to the Booking Desk (20-70 s instead of 2-5 s). Mirrors router.test.ts.
    #[test]
    fn normalize_whats_up_is_whatsapp_only_next_to_an_app_cue() {
        for (text, out) in [
            ("what's up", "whats up"),
            ("Hey Tony, what's up?", "hey tony whats up"),
            ("what's up tony", "whats up tony"),
            ("hey what's up tony", "hey whats up tony"),
            ("what's up with the build", "whats up with the build"),
            ("so I'm on my phone now hey tony what's up", "so im on my phone now hey tony whats up"),
            ("what's up, any updates?", "whats up any updates"),
            // "…what's up with X" asks about X, even after a before-cue word.
            ("check what's up with the droplet", "check whats up with the droplet"),
            ("on what's up with the build", "on whats up with the build"),
            // "come / hang / hold on, what's up" is an idiom, not "on WhatsApp".
            ("come on, what's up", "come on whats up"),
            ("hang on what's up", "hang on whats up"),
            ("hold on, what's up?", "hold on whats up"),
            // "in" / "the" are no longer before-cues.
            ("I'm in, what's up?", "im in whats up"),
            ("anything new in what's up", "anything new in whats up"),
            ("the what's up", "the whats up"),
        ] {
            assert_eq!(normalize(text), out, "a greeting is not WhatsApp: {text}");
        }
        for (text, out) in [
            ("check my whats up messages", "check my whatsapp messages"),
            ("any whats up messages", "any whatsapp messages"),
            ("open whats up", "open whatsapp"),
            ("on whats up", "on whatsapp"),
            ("anything new on what's up", "anything new on whatsapp"),
            ("read it from whats up", "read it from whatsapp"),
            ("send it via what's up", "send it via whatsapp"),
            ("check the what's up group", "check the whatsapp group"),
            ("what's up texts from sam", "whatsapp texts from sam"),
            ("any what's up DMs", "any whatsapp dms"),
            ("clear my what's up notifications", "clear my whatsapp notifications"),
            ("what's up msgs", "whatsapp msgs"),
            ("any what's up chats", "any whatsapp chats"),
        ] {
            assert_eq!(normalize(text), out, "clearly the app: {text}");
        }
    }

    #[test]
    fn strip_address_drops_interjection_name_and_politeness() {
        assert_eq!(strip_address("aye tony can you play some bilmuri", "Tony"), "play some bilmuri");
        assert_eq!(strip_address("Aye, Tony, play Bilmuri on Spotify.", "Tony"), "play Bilmuri on Spotify");
        assert_eq!(strip_address("ayy tony pause the music", "Tony"), "pause the music");
        assert_eq!(strip_address("yo jarvis what's playing?", "Tony"), "what's playing");
        assert_eq!(strip_address("Hey, Friday, please could you skip this", "Friday"), "skip this");
        assert_eq!(strip_address("ok so um play jazz", "Tony"), "play jazz");
        assert_eq!(strip_address("oi Tony: I need you to pause", "Tony"), "pause");
        // The name as the object / an artist stays.
        assert_eq!(strip_address("play tony bennett", "Tony"), "play tony bennett");
        assert_eq!(strip_address("play something by tony", "Tony"), "play something by tony");
        // Interjections are whole words only.
        assert_eq!(strip_address("hiking trails near me", "Tony"), "hiking trails near me");
        assert_eq!(strip_address("sometimes I wonder", "Tony"), "sometimes I wonder");
        assert_eq!(strip_address("  ", "Tony"), "");
        assert_eq!(strip_address("Tony?", "Tony"), "");
        // Non-ASCII text never panics on a char boundary.
        assert_eq!(strip_address("éé hey", "Tony"), "éé hey");
    }

    #[test]
    fn whole_word_boundaries_only() {
        let cfg = OsConfig::default();
        // "book" must not match "booking"'s name triggers via substring.
        let r = resolve("please book a table for two", &cfg);
        assert_eq!(r.kind, RouteKind::Default);
        // "ui" must not match inside "quick".
        let r = resolve("give me a quick summary", &cfg);
        assert_eq!(r.kind, RouteKind::Default);
    }

    /// A Gmail booking read stays with Tony: "booking" / "audition" / "casting" merely mentioned in
    /// a mail read is a topic, never the Booking Desk; addressing the desk still hands it over.
    /// Mirrors router.test.ts (and the shared fixtures).
    #[test]
    fn a_mail_read_naming_a_booking_word_stays_with_tony() {
        let cfg = OsConfig::default();
        // Review note (A2): a mail read that merely OPENS with a booking word is a topic too.
        for text in ["check gmail for booking emails", "any audition emails?", "check my inbox for the casting call", "check my calendar for the audition", "booking emails from today?", "audition email check", "Booking confirmations in my gmail?", "audition emails this week?", "casting calendar check for tomorrow"] {
            let r = resolve(text, &cfg);
            // At most a topic (Domain), which the live-tool backstop keeps with Tony (`direct_tool`).
            assert_ne!(r.kind, RouteKind::Named, "{text}: {r:?}");
            assert!(matches!(direct_tool(text), Some("gmail" | "calendar")), "{text}");
        }
        // Addressing the (frozen) Booking Desk still names it in a mail read (A2 review); the
        // switchboard then holds it with Tony and adds the FROZEN note.
        for (text, conf) in [
            ("booking desk, any new emails about the shoot?", "medium"),
            ("tell the booking desk to check my email for the callback", "high"),
            ("booking desk check my inbox", "high"),
            ("hey booking agent, any emails?", "medium"),
            ("hey booking desk any new emails", "medium"),
            ("Booking desk: any emails today?", "medium"),
        ] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind, r.confidence.as_str()), (Some("booking"), RouteKind::Named, conf), "{text}");
        }
        // Addressing a desk still hands a mail read over (a frozen one is then held with Tony).
        for (text, conf) in [("director, any new emails about the shoot?", "medium"), ("tell the director to check my email for the callback", "high"), ("director check my inbox", "high"), ("hey director, any emails?", "medium")] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind, r.confidence.as_str()), (Some("director"), RouteKind::Named, conf), "{text}");
        }
        // Not a mail read: a mention still names the agent, as before.
        let r = resolve("what did the director say", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("director"), RouteKind::Named));
        // The frozen Booking Desk is still named (Named; the switchboard holds it with a note),
        // also when it opens a mail read.
        assert_eq!(resolve("what did the booking desk say", &cfg).kind, RouteKind::Named);
        let r = resolve("booking desk, any new emails about the shoot?", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("booking"), RouteKind::Named));
    }

    /// FX3 review: a filler lead ("Okay,", "so", "ok") skipped the pause / line-end rule, so a
    /// Whisper transcript like "Okay, booking emails from today?" still went to the (frozen)
    /// Booking Desk instead of Tony's own Gmail read. Fillers never address; "hey / hi / yo" do
    /// only before an address word. Mirrors router.ts (and the shared fixtures).
    #[test]
    fn a_filler_lead_never_hands_a_mail_read_to_the_desk() {
        let cfg = OsConfig::default();
        for text in ["Okay, booking emails from today?", "okay booking emails from today?", "so booking emails from today?", "ok audition emails this week?", "So, audition email check", "hey booking emails from today?", "Hey, audition email check"] {
            let r = resolve(text, &cfg);
            // Tony's: nothing matched, or (since the section 20-21 re-split) his own acting topic.
            assert!(r.kind != RouteKind::Named && matches!(r.role.as_deref(), None | Some("general")), "{text}: {r:?}");
            assert_eq!(direct_tool(text), Some("gmail"), "{text}");
        }
        // The Booking Desk's names are "booking desk" / "booking agent" / "B&Co" (bare "booking" /
        // "casting" are Tony's topics now).
        for text in ["Okay, booking desk: any emails today?", "so, booking desk, any new emails?", "hey booking agent any emails?", "hey booking desk any new emails", "hi booking agent did I get any emails?", "hey booking agent email Sam about the shoot", "yo booking desk check my inbox"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some("booking"), RouteKind::Named), "{text}: {r:?}");
        }
    }

    #[test]
    fn domain_tie_break_follows_role_order() {
        let cfg = ops_thawed(); // Ops (a frozen placeholder) stands in for another agent's topic
        // bizops "inventory" (9) vs designer "animation" (9): bizops comes first.
        let r = resolve("inventory animation", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("bizops"), RouteKind::Domain));
        // A Tony topic ("schedule") never steals a tie: the agent keeps it.
        let r = resolve("schedule a docker restart", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("ops"), RouteKind::Domain));
    }
}
