//! Learning mode's pathway store: what Nic teaches Tony one-on-one.
//!
//! - Tony proposes a lesson by ending his reply with `[[LEARN category | when | rule or fact |
//!   confirmed]]` lines (`modes::LEARNING_PROTOCOL`). [`parse_tags`] pulls them out of the answer
//!   before it is shown, spoken or logged; the webview strips them from the live token stream.
//! - Each approved lesson becomes a [`Pathway`] (category, trigger_or_context, directive_or_fact,
//!   source `learning_mode`, timestamp, confidence, core) in `<memory.notesDir>/learning/pathways.json`.
//!   Recall (`relevant`) also treats a trigger of `always` as eligible on every turn.
//! - [`upsert_core`] checks the store first (below), so conflicting duplicates never pile up; a
//!   replaced text is kept in `superseded`.
//! - [`learned_block`] gives Tony the pathways relevant to a turn (every mode: confirmed only;
//!   Learning: provisional too, so he can spot a clash before saving).
//! - [`index`] re-indexes the whole store as ONE document in the Librarian's AnythingLLM workspace
//!   (through `documenter`, Tony's only write path), removing the previous copy. Silent: no
//!   Librarian turn, no TTS; a failure is a `mirror_failed` note like any documenter ingest.
//! - Core memories (decision 5): in Learning mode a tag is never saved at once. It becomes a
//!   pending [`Proposals`] entry (in memory, [`PROPOSAL_TTL_MS`]) and Tony asks
//!   [`CORE_QUESTION`]. Nic's whole-line yes ([`parse_answer`], spoken or typed, desktop or
//!   phone) or the card's Save saves it with `core: true` and confirmed ([`commit_core`]); a no or
//!   Skip drops it. A spoken / typed yes or no answers only the batch Tony's immediately
//!   preceding reply proposed ([`Proposals::take_spoken`]); any other turn ends that, and older
//!   batches are card-only (by id). [`core_block`] puts the confirmed core entries in EVERY Tony
//!   prompt, sorted by id and capped at [`CORE_MAX`] (gateway_tony.py renders the same block,
//!   byte for byte).
//! - An approved lesson is stored as Nic approved it ([`upsert_core`]): the same words again are
//!   a no-op, a reworded or corrected lesson replaces its old text in place (named in the reply,
//!   [`saved_reply`]), and anything else is a new entry: different text is never promoted to
//!   core, and an unrelated core memory is never replaced.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::envelope::{clip, one_line};

pub const SOURCE: &str = "learning_mode";
pub const CATEGORIES: [&str; 6] = ["preference", "workflow", "rule", "persona", "domain_knowledge", "correction"];
pub const STORE_FILE: &str = "pathways.json";
pub const STORE_DIR: &str = "learning";
/// Lessons saved from one reply.
pub const TAGS_PER_TURN: usize = 5;
pub const FIELD_MAX: usize = 300;
pub const STORE_MAX: usize = 500;
pub const SUPERSEDED_KEEP: usize = 5;
/// The LEARNED block Tony sees (chars).
pub const BLOCK_MAX: usize = 900;
pub const RAG_TITLE: &str = "Tony learned pathways";
/// The store's format: v2 added `core` (a v1 file loads with every entry non-core).
pub const STORE_VERSION: u32 = 2;
/// The CORE MEMORIES block's first line (gateway_tony.py CORE_HEADER is the same text).
pub const CORE_HEADER: &str = "CORE MEMORIES (approved by Nic):";
/// The CORE MEMORIES block's cap in chars, header included. Whole entries only: the ones that
/// don't fit fall back to the keyword LEARNED recall.
pub const CORE_MAX: usize = 800;
/// How long a Learning-mode proposal waits for Nic's yes (ms).
pub const PROPOSAL_TTL_MS: u64 = 10 * 60 * 1000;
/// Pending proposals kept at most (the oldest go first).
pub const PROPOSALS_MAX: usize = 10;
/// Tony's question after a proposal (added in code when the model leaves it out).
pub const CORE_QUESTION: &str = "Want me to add that to my core memories?";
/// The reply to Nic's yes (no model call).
pub const SAVED_REPLY: &str = "Saved to my core memories.";
/// The reply to Nic's yes when every lesson was already a core memory, word for word.
pub const ALREADY_REPLY: &str = "That's already in my core memories.";
/// The reply to Nic's no (no model call).
pub const DISCARDED_REPLY: &str = "Okay, I won't save that.";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Superseded {
    pub directive_or_fact: String,
    pub confidence: String,
    pub at: u64,
    /// The old trigger, when the replacement changed it too (an approved core memory is stored
    /// with its own words, [`upsert_core`]).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub trigger_or_context: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pathway {
    pub id: String,
    pub category: String,
    pub trigger_or_context: String,
    pub directive_or_fact: String,
    pub source: String,
    /// Created (unix ms).
    pub timestamp: u64,
    #[serde(default)]
    pub updated_at: u64,
    /// `confirmed` | `provisional`.
    pub confidence: String,
    /// Nic approved it as a core memory: it rides in every Tony prompt ([`core_block`]).
    #[serde(default)]
    pub core: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub superseded: Vec<Superseded>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct PathwayFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub pathways: Vec<Pathway>,
    /// The AnythingLLM document the last [`index`] created (removed on the next one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rag_location: Option<String>,
}

/// One `[[LEARN …]]` line, normalised.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub category: String,
    pub trigger: String,
    pub directive: String,
    pub confidence: String,
    /// Save it as a core memory (Nic's yes, [`commit_core`]).
    pub core: bool,
}

/// What a save did (the webview's "Memory saved" pill).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Saved {
    pub id: String,
    pub title: String,
    pub category: String,
    pub confidence: String,
    /// `saved` (new) · `updated` (confidence upgrade) · `superseded` (new rule for the same
    /// trigger) · `unchanged` (already known).
    pub outcome: String,
    /// `superseded`: the memory it replaced, as one line ([`memory_text`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced: Option<String>,
}

// ── Parsing ─────────────────────────────────────────────────────────────────

fn tag_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?is)\[\[\s*LEARN\b(.*?)\]\]").unwrap())
}

fn label_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)^(category|when|trigger|context|trigger_or_context|rule|fact|what|directive|directive_or_fact|confidence)\s*[:=]\s*").unwrap())
}

fn field(s: &str) -> String {
    clip(&one_line(&label_re().replace(s.trim(), "")), FIELD_MAX)
}

/// A category name as Tony wrote it → one of [`CATEGORIES`] (unknown → `rule`).
pub fn normalize_category(s: &str) -> String {
    let c = s.trim().to_lowercase().replace([' ', '-'], "_");
    let c = match c.as_str() {
        "domain" | "knowledge" | "domain_knowledge" | "fact" | "facts" => "domain_knowledge",
        "pref" | "preferences" | "preference" => "preference",
        "workflows" | "process" | "procedure" | "workflow" => "workflow",
        "personality" | "voice" | "persona" => "persona",
        "fix" | "corrections" | "correction" => "correction",
        _ => "rule",
    };
    c.to_string()
}

fn normalize_confidence(s: &str) -> String {
    let l = s.trim().to_lowercase();
    if l.starts_with("confirm") || l == "yes" || l == "sure" { "confirmed".into() } else { "provisional".into() }
}

/// Pull every `[[LEARN …]]` line out of `answer`. Returns the answer without them (blank lines
/// they leave behind collapsed) and the lessons (at most [`TAGS_PER_TURN`]; one missing its rule
/// is dropped). A tag with three fields is provisional.
pub fn parse_tags(answer: &str) -> (String, Vec<Draft>) {
    let mut drafts = Vec::new();
    for c in tag_re().captures_iter(answer) {
        let body = c.get(1).map(|m| m.as_str()).unwrap_or("");
        let parts: Vec<String> = body.trim_start_matches([':', ' ']).split('|').map(field).collect();
        let (cat, trig, dir, conf) = match parts.as_slice() {
            [c, t, d, f, ..] => (c.clone(), t.clone(), d.clone(), normalize_confidence(f)),
            [c, t, d] => (c.clone(), t.clone(), d.clone(), "provisional".into()),
            [t, d] => ("rule".into(), t.clone(), d.clone(), "provisional".into()),
            _ => continue,
        };
        if dir.is_empty() || drafts.len() >= TAGS_PER_TURN {
            continue;
        }
        drafts.push(Draft { category: normalize_category(&cat), trigger: if trig.is_empty() { "always".into() } else { trig }, directive: dir, confidence: conf, core: false });
    }
    if !tag_re().is_match(answer) {
        return (answer.to_string(), drafts);
    }
    // Exactly the webview's `stripLearnTags` (tags out, 3+ newlines → 2), so the text before a tag
    // keeps its offsets: the voice controller speaks the rest of `answer` from where the stream was.
    static GAPS: OnceLock<regex::Regex> = OnceLock::new();
    let stripped = tag_re().replace_all(answer, "");
    let out = GAPS.get_or_init(|| regex::Regex::new(r"\n{3,}").unwrap()).replace_all(&stripped, "\n\n");
    (out.trim_end().to_string(), drafts)
}

// ── Similarity ──────────────────────────────────────────────────────────────

const STOP: [&str; 24] = ["the", "and", "for", "you", "your", "that", "this", "with", "when", "want", "then", "than", "them", "have", "from", "into", "what", "about", "always", "should", "would", "just", "like", "are"];

fn tokens(s: &str) -> std::collections::BTreeSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3 && !STOP.contains(w)).map(str::to_string).collect()
}

/// Dice similarity of the two texts' content words, 0–1 (0 when either has none).
pub fn similarity(a: &str, b: &str) -> f64 {
    let (x, y) = (tokens(a), tokens(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    2.0 * x.intersection(&y).count() as f64 / (x.len() + y.len()) as f64
}

/// Same trigger (how alike the "when" parts are).
const SAME_TRIGGER: f64 = 0.6;
/// Same rule.
const SAME_RULE: f64 = 0.7;

fn title_of(p: &Pathway) -> String {
    clip(&p.directive_or_fact, 60)
}

fn saved(p: &Pathway, outcome: &str) -> Saved {
    Saved { id: p.id.clone(), title: title_of(p), category: p.category.clone(), confidence: p.confidence.clone(), outcome: outcome.into(), replaced: None }
}

/// A new entry for `d` (the oldest non-core entries make room past [`STORE_MAX`]).
fn push_new(f: &mut PathwayFile, d: &Draft, now: u64) -> Saved {
    let p = Pathway {
        id: format!("lp-{now}-{}", f.pathways.len()),
        category: d.category.clone(),
        trigger_or_context: d.trigger.clone(),
        directive_or_fact: d.directive.clone(),
        source: SOURCE.into(),
        timestamp: now,
        updated_at: now,
        confidence: d.confidence.clone(),
        core: d.core,
        superseded: vec![],
    };
    let out = saved(&p, "saved");
    f.pathways.push(p);
    if f.pathways.len() > STORE_MAX {
        // Oldest non-core provisional first, else the oldest non-core entry, else the oldest.
        let drop = f.pathways.iter().position(|p| p.confidence == "provisional" && !p.core).or_else(|| f.pathways.iter().position(|p| !p.core)).unwrap_or(0);
        f.pathways.remove(drop);
    }
    out
}

/// Words only, lowercased ("Friday, 9 AM." → "friday 9 am"): an exact match that ignores case,
/// spacing and punctuation but never a word (a number, a "not").
fn norm(s: &str) -> String {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// [`norm`] for a trigger: a leading "when" dropped, and `always` the same as no trigger.
fn norm_trigger(s: &str) -> String {
    let n = norm(s);
    let n = n.strip_prefix("when ").map(str::to_string).unwrap_or(n);
    if n == "always" { String::new() } else { n }
}

/// How alike two triggers are: 1 when they are the same words (two `always` lessons too, which
/// [`similarity`] can't see: `always` is a stop word), else [`similarity`].
fn trigger_similarity(a: &str, b: &str) -> f64 {
    if norm_trigger(a) == norm_trigger(b) { 1.0 } else { similarity(a, b) }
}

/// Save `d` (Nic approved it: core, confirmed) EXACTLY as he approved it. Pure.
/// - The same words (trigger and rule, [`norm`]) as an entry: `unchanged` when it is already a
///   confirmed core memory, else `updated` (made core + confirmed; the text is the approved one).
/// - The same lesson reworded (same trigger and a rule at least [`SAME_RULE`] alike, e.g. "every
///   Friday" → "every Monday"), or an explicit `correction` of a lesson with the same trigger: the
///   approved text replaces the old one in place (`superseded`, the old text kept in
///   `superseded` and named in [`Saved::replaced`]).
/// - Anything else is a new entry: different words are never promoted to core, and a lesson
///   that only shares a trigger (or only a rule) never replaces another core memory.
pub fn upsert_core(f: &mut PathwayFile, d: &Draft, now: u64) -> Saved {
    let (nt, nd) = (norm_trigger(&d.trigger), norm(&d.directive));
    if let Some(p) = f.pathways.iter_mut().find(|p| norm_trigger(&p.trigger_or_context) == nt && norm(&p.directive_or_fact) == nd) {
        if p.core && p.confidence == "confirmed" {
            return saved(p, "unchanged");
        }
        p.core = true;
        p.confidence = "confirmed".into();
        p.updated_at = now;
        return saved(p, "updated");
    }
    let best = f
        .pathways
        .iter()
        .enumerate()
        .map(|(i, p)| (i, trigger_similarity(&p.trigger_or_context, &d.trigger), similarity(&p.directive_or_fact, &d.directive)))
        .filter(|&(_, trig, dir)| trig >= SAME_TRIGGER && (dir >= SAME_RULE || d.category == "correction"))
        .max_by(|a, b| (a.1 + a.2).partial_cmp(&(b.1 + b.2)).unwrap_or(std::cmp::Ordering::Equal));
    let Some((i, _, _)) = best else { return push_new(f, d, now) };
    let p = &mut f.pathways[i];
    let replaced = memory_text(&p.trigger_or_context, &p.directive_or_fact);
    let old_trigger = if p.trigger_or_context == d.trigger { String::new() } else { p.trigger_or_context.clone() };
    p.superseded.insert(0, Superseded { directive_or_fact: p.directive_or_fact.clone(), confidence: p.confidence.clone(), at: now, trigger_or_context: old_trigger });
    p.superseded.truncate(SUPERSEDED_KEEP);
    p.trigger_or_context = d.trigger.clone();
    p.directive_or_fact = d.directive.clone();
    p.confidence = "confirmed".into();
    p.core = true;
    if d.category != "correction" {
        p.category = d.category.clone();
    }
    p.updated_at = now;
    Saved { replaced: Some(replaced), ..saved(p, "superseded") }
}

/// Tony's fixed reply to Nic's yes, from what [`commit_core`] did: [`ALREADY_REPLY`] when nothing
/// changed, [`SAVED_REPLY`] plus the memory it replaced when a lesson superseded one (so a
/// replacement is never silent), else [`SAVED_REPLY`].
pub fn saved_reply(saved: &[Saved]) -> String {
    if !saved.is_empty() && saved.iter().all(|s| s.outcome == "unchanged") {
        return ALREADY_REPLY.into();
    }
    let replaced: Vec<String> = saved.iter().filter_map(|s| s.replaced.as_deref()).map(|r| format!("\"{}\"", clip(r.trim_end_matches(['.', '!', '?']), 120))).collect();
    match replaced.len() {
        0 => SAVED_REPLY.into(),
        1 => format!("{SAVED_REPLY} That replaces the old one: {}.", replaced[0]),
        _ => format!("{SAVED_REPLY} That replaces the old ones: {}.", replaced.join("; ")),
    }
}

// ── Recall ──────────────────────────────────────────────────────────────────

/// A pathway whose trigger is `always`: eligible on every turn, not only on a word match.
fn always_applies(p: &Pathway) -> bool {
    p.trigger_or_context.trim().eq_ignore_ascii_case("always")
}

/// The pathways that share words with `text` (or always apply), best first (ties: most recently
/// updated). `skip`: ids already in the prompt (the CORE MEMORIES block).
pub fn relevant<'a>(f: &'a PathwayFile, text: &str, max: usize, confirmed_only: bool, skip: &[String]) -> Vec<&'a Pathway> {
    let q = tokens(text);
    let mut scored: Vec<(usize, &Pathway)> = f
        .pathways
        .iter()
        .filter(|p| (!confirmed_only || p.confidence == "confirmed") && !skip.contains(&p.id))
        .map(|p| (tokens(&format!("{} {}", p.trigger_or_context, p.directive_or_fact)).intersection(&q).count(), p))
        .filter(|(n, p)| *n > 0 || always_applies(p))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.updated_at.cmp(&a.1.updated_at)));
    scored.into_iter().take(max).map(|(_, p)| p).collect()
}

/// Words that must never reach Tony's system prompt (the format word flips the provider chain,
/// the thinking switch must stay last, the novelty word is never the model's): neutralised.
pub(crate) fn neutral(s: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?i)json|/no_think|gabagool").unwrap());
    re.replace_all(s, |c: &regex::Captures| match c[0].to_lowercase().as_str() {
        "json" => "structured-data".to_string(),
        "gabagool" => "the novelty word".to_string(),
        _ => String::new(),
    })
    .into_owned()
}

/// Tony's LEARNED block for this turn ("" when nothing matches). `learning`: the header asks him
/// to check new lessons against these (provisional ones are marked).
pub fn learned_block(items: &[&Pathway], learning: bool) -> String {
    if items.is_empty() {
        return if learning { "\n\nLEARNED: nothing on this topic yet.".into() } else { String::new() };
    }
    let mut s = String::from(if learning { "\n\nLEARNED (pathways Nic already taught you; check new lessons against them):" } else { "\n\nLEARNED (pathways Nic taught you; follow them):" });
    for p in items {
        let line = neutral(&format!("\n- [{}] when {}: {}{}", p.category, p.trigger_or_context, p.directive_or_fact, if p.confidence == "provisional" { " (provisional)" } else { "" }));
        if s.chars().count() + line.chars().count() > BLOCK_MAX {
            break;
        }
        s.push_str(&line);
    }
    s
}

// ── Core memories ───────────────────────────────────────────────────────────

/// A lesson as one line: "When <trigger>: <rule or fact>", or the rule alone when its trigger is
/// empty or `always`. A leading "when " in the trigger is not doubled. (gateway_tony.py
/// memory_text is the same.)
pub fn memory_text(trigger: &str, directive: &str) -> String {
    let t = one_line(trigger);
    let t = match t.get(..5) {
        Some(w) if w.eq_ignore_ascii_case("when ") => t[5..].to_string(),
        _ => t,
    };
    let d = one_line(directive);
    if t.is_empty() || t.eq_ignore_ascii_case("always") {
        d
    } else {
        format!("When {t}: {d}")
    }
}

/// Tony's CORE MEMORIES block (no leading blank line) and the ids it holds: Nic's approved core
/// entries (confirmed only), sorted by id so the prompt prefix stays the same turn to turn (KV
/// cache), whole entries up to [`CORE_MAX`] chars (the first that doesn't fit ends the block; it
/// and the rest are recalled by keyword instead). `("", [])` when there are none. Pure.
pub fn core_block(f: &PathwayFile) -> (String, Vec<String>) {
    let mut core: Vec<&Pathway> = f.pathways.iter().filter(|p| p.core && p.confidence == "confirmed").collect();
    core.sort_by(|a, b| a.id.cmp(&b.id));
    let mut s = String::from(CORE_HEADER);
    let mut n = s.chars().count();
    let mut ids = vec![];
    for p in core {
        let line = format!("\n- {}", neutral(&memory_text(&p.trigger_or_context, &p.directive_or_fact)));
        let c = line.chars().count();
        if n + c > CORE_MAX {
            break;
        }
        s.push_str(&line);
        n += c;
        ids.push(p.id.clone());
    }
    if ids.is_empty() {
        return (String::new(), vec![]);
    }
    (s, ids)
}

/// Nic's whole line as an answer to a pending proposal: `Some(true)` a yes ("yes", "yeah", "yep",
/// "save it", "add it"), `Some(false)` a clear no ("no", "nope", "don't", "skip it"), `None`
/// anything else. Strict: only "Tony" (or the OS name), "please" and punctuation may surround the
/// phrase, so "yes, but change it" or "no wait" is not an answer.
pub fn parse_answer(line: &str, os_name: &str) -> Option<bool> {
    const YES: [&str; 5] = ["yes", "yeah", "yep", "save it", "add it"];
    const NO: [&str; 4] = ["no", "nope", "dont", "skip it"];
    if line.len() > 80 {
        return None;
    }
    let lower = line.to_lowercase().replace(['\'', '\u{2019}'], "");
    let name = os_name.trim().to_lowercase();
    let filler = |w: &str| w == "please" || w == "tony" || (!name.is_empty() && w == name);
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let start = words.iter().position(|w| !filler(w))?;
    let end = words.iter().rposition(|w| !filler(w))?;
    let core = words[start..=end].join(" ");
    if YES.contains(&core.as_str()) {
        Some(true)
    } else if NO.contains(&core.as_str()) {
        Some(false)
    } else {
        None
    }
}

/// A lesson waiting for Nic's yes, as the card shows it (`OsTurnResult.pendingMemory`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PendingMemory {
    pub id: String,
    pub category: String,
    pub text: String,
}

/// One pending lesson (taken out by [`Proposals::take`] / [`Proposals::take_spoken`]; a failed
/// save puts it back with [`Proposals::restore`], same id, so the card still answers it).
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: String,
    /// The reply that proposed it (one batch per reply).
    batch: u64,
    at: u64,
    pub draft: Draft,
}

#[derive(Default)]
struct Pending {
    list: Vec<Proposal>,
    /// The batch Tony's immediately preceding reply proposed: the only one a spoken / typed yes
    /// or no may answer. Cleared by any other turn ([`Proposals::close_spoken`]), by that answer,
    /// and replaced by the next proposal; older batches stay answerable by id (the card) only.
    spoken: Option<u64>,
}

/// Learning mode's pending proposals: in memory only (an app restart drops them), each live for
/// [`PROPOSAL_TTL_MS`], at most [`PROPOSALS_MAX`].
#[derive(Default)]
pub struct Proposals(std::sync::Mutex<Pending>);

fn next_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

impl Proposals {
    /// The store with expired entries dropped.
    fn live(&self, now: u64) -> std::sync::MutexGuard<'_, Pending> {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.list.retain(|p| now.saturating_sub(p.at) < PROPOSAL_TTL_MS);
        g
    }

    /// Park one reply's lessons as one batch: the batch a spoken yes / no answers next. Returns
    /// what the card shows.
    pub fn propose(&self, drafts: &[Draft], now: u64) -> Vec<PendingMemory> {
        let mut g = self.live(now);
        if drafts.is_empty() {
            return vec![];
        }
        let batch = next_seq();
        let out = drafts
            .iter()
            .map(|d| {
                let id = format!("mem-{now}-{}", next_seq());
                g.list.push(Proposal { id: id.clone(), batch, at: now, draft: d.clone() });
                PendingMemory { id, category: d.category.clone(), text: memory_text(&d.trigger, &d.directive) }
            })
            .collect();
        let over = g.list.len().saturating_sub(PROPOSALS_MAX);
        g.list.drain(..over);
        g.spoken = Some(batch);
        out
    }

    /// Any proposal still waiting.
    #[cfg(test)]
    pub fn any(&self, now: u64) -> bool {
        !self.live(now).list.is_empty()
    }

    /// Remove one proposal (the card). `None`: unknown, answered or expired.
    pub fn take(&self, id: &str, now: u64) -> Option<Proposal> {
        let mut g = self.live(now);
        let i = g.list.iter().position(|p| p.id == id)?;
        Some(g.list.remove(i))
    }

    /// A spoken / typed yes or no: remove the batch Tony's immediately preceding reply proposed
    /// (what his question asked about) and end spoken answers until the next proposal. Empty:
    /// none (no proposal since the last other turn, or its rows were answered or expired).
    pub fn take_spoken(&self, now: u64) -> Vec<Proposal> {
        let mut g = self.live(now);
        let Some(b) = g.spoken.take() else { return vec![] };
        let (take, keep): (Vec<Proposal>, Vec<Proposal>) = g.list.drain(..).partition(|p| p.batch == b);
        g.list = keep;
        take
    }

    /// Any turn that isn't a spoken answer: from now on a yes / no is about something else, so
    /// the pending batches are answerable by id (the card) only.
    pub fn close_spoken(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).spoken = None;
    }

    /// Put taken proposals back after a failed save (same ids, same expiry). `spoken`: a yes can
    /// retry them next turn (Tony's reply asked to try again).
    pub fn restore(&self, items: Vec<Proposal>, spoken: bool) {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let (true, Some(b)) = (spoken, items.first().map(|p| p.batch)) {
            g.spoken = Some(b);
        }
        g.list.extend(items);
        let over = g.list.len().saturating_sub(PROPOSALS_MAX);
        g.list.drain(..over);
    }
}

/// Did Tony's last reply in this conversation (`last_reply`, the newest assistant message of the
/// turn's history) ask [`CORE_QUESTION`]? Only then can Nic's yes / no be its answer (the
/// proposals are app-wide; the phone, the desktop and the Director chat each have their own
/// conversation). `None` (no history sent): nothing to check, the spoken batch alone decides.
pub fn asked_core_question(last_reply: Option<&str>) -> bool {
    last_reply.map_or(true, asks_core)
}

fn asks_core(reply: &str) -> bool {
    let l = reply.to_lowercase();
    l.contains("add that to my core memories") || l.contains("add it to my core memories")
}

/// The app's proposals (one store: desktop, phone and voice answer the same ones).
pub fn proposals() -> &'static Proposals {
    static P: OnceLock<Proposals> = OnceLock::new();
    P.get_or_init(Proposals::default)
}

/// Tony's Learning reply to a proposal: it ends with [`CORE_QUESTION`] (added when the model left
/// it out; the text before it never moves, so speech stays aligned). An empty reply echoes the
/// first lesson instead.
pub fn with_core_question(answer: &str, first: Option<&PendingMemory>) -> String {
    let a = answer.trim_end();
    if asks_core(a) {
        return a.to_string();
    }
    match (a.is_empty(), first) {
        (true, Some(p)) => format!("Got it: {}. {CORE_QUESTION}", clip(p.text.trim_end_matches(['.', '!', '?']), 160)),
        (true, None) => CORE_QUESTION.to_string(),
        (false, _) => format!("{a} {CORE_QUESTION}"),
    }
}

/// The whole store as Markdown (the Librarian's RAG document).
pub fn render_markdown(f: &PathwayFile) -> String {
    let mut s = format!("# {RAG_TITLE}\n\nWhat Nic taught Tony in Learning mode. Each entry: category, when it applies, the rule or fact, confidence.\n");
    for c in CATEGORIES {
        let rows: Vec<&Pathway> = f.pathways.iter().filter(|p| p.category == c).collect();
        if rows.is_empty() {
            continue;
        }
        s.push_str(&format!("\n## {c}\n"));
        for p in rows {
            s.push_str(&format!("- When {}: {} ({}{}, source {}, id {})\n", p.trigger_or_context, p.directive_or_fact, p.confidence, if p.core { ", core memory" } else { "" }, p.source, p.id));
        }
    }
    s
}

// ── Store ───────────────────────────────────────────────────────────────────

/// `<notes root>/learning/pathways.json`.
pub fn store_path(notes_root: &Path) -> PathBuf {
    notes_root.join(STORE_DIR).join(STORE_FILE)
}

/// Never fails: a missing or unreadable file is an empty store (a corrupt one is moved aside).
pub fn load(path: &Path) -> PathwayFile {
    match std::fs::read_to_string(path) {
        Err(_) => PathwayFile { version: 1, ..Default::default() },
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("[learning] {} unreadable ({e}); starting empty", path.display());
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            PathwayFile { version: 1, ..Default::default() }
        }),
    }
}

pub fn save(path: &Path, f: &PathwayFile) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("create {}: {e}", d.display()))?;
    }
    let body = serde_json::to_string_pretty(f).map_err(|e| e.to_string())?;
    super::staging::atomic_write(path, body.as_bytes())
}

/// The store path for the live config (None: no notes root).
pub fn live_path(cfg: &super::os_core::OsConfig, workdir: &str) -> Option<PathBuf> {
    super::documenter::notes_root(cfg, Path::new(workdir)).ok().map(|r| store_path(&r))
}

/// Serialises the read-modify-write of the store across concurrent turns.
fn lock() -> &'static std::sync::Mutex<()> {
    static L: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| std::sync::Mutex::new(()))
}

/// Nic's yes: save `drafts` (scrubbed of secrets) into the store at `path` as confirmed core
/// memories, word for word ([`upsert_core`]). Returns what each did.
pub fn commit_core(path: &Path, drafts: &[Draft], now: u64, known: &[String]) -> Result<Vec<Saved>, String> {
    if drafts.is_empty() {
        return Ok(vec![]);
    }
    let _g = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load(path);
    f.version = STORE_VERSION;
    let scrub = |s: &str| super::devqueue::scrub(s, known);
    let out: Vec<Saved> = drafts.iter().map(|d| upsert_core(&mut f, &Draft { trigger: scrub(&d.trigger), directive: scrub(&d.directive), confidence: "confirmed".into(), core: true, ..d.clone() }, now)).collect();
    if out.iter().any(|s| s.outcome != "unchanged") {
        save(path, &f)?;
    }
    Ok(out)
}

/// Re-index the store in the Librarian's workspace (one document; the previous copy removed).
pub async fn index(state: &super::dispatch::DispatchState, os: &super::os_core::OsState, path: PathBuf) -> Result<(), String> {
    let (text, old) = {
        let f = load(&path);
        (render_markdown(&f), f.rag_location.clone())
    };
    let loc = super::documenter::ingest_replacing(state, os, RAG_TITLE, &text, old.as_deref()).await?;
    let _g = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load(&path);
    f.rag_location = loc;
    save(&path, &f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pulls_tags_out_and_normalises_them() {
        let a = "Got it.\n\n[[LEARN rule | Nic says ship it | push to main after tests pass | confirmed]]\n[[learn: Domain Knowledge | when: CloudMart | it runs in three GCP regions]]\nStored.";
        let (clean, d) = parse_tags(a);
        assert_eq!(clean, "Got it.\n\nStored.");
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], Draft { category: "rule".into(), trigger: "Nic says ship it".into(), directive: "push to main after tests pass".into(), confidence: "confirmed".into(), core: false });
        assert_eq!((d[1].category.as_str(), d[1].trigger.as_str(), d[1].confidence.as_str()), ("domain_knowledge", "CloudMart", "provisional"));
        // No rule → dropped; no tags → unchanged answer.
        assert!(parse_tags("[[LEARN rule]]").1.is_empty());
        assert_eq!(parse_tags("plain [[link]] text").0, "plain [[link]] text");
        // At most TAGS_PER_TURN.
        let many = (0..9).map(|i| format!("[[LEARN rule | t{i} | d{i} | confirmed]]")).collect::<String>();
        assert_eq!(parse_tags(&many).1.len(), TAGS_PER_TURN);
        assert_eq!(normalize_category("weird"), "rule");
    }

    fn d(cat: &str, t: &str, r: &str, c: &str) -> Draft {
        Draft { category: cat.into(), trigger: t.into(), directive: r.into(), confidence: c.into(), core: false }
    }

    #[test]
    fn upsert_core_dedupes_upgrades_and_supersedes() {
        let mut f = PathwayFile::default();
        let a = upsert_core(&mut f, &approved("preference", "booking a dinner table", "prefer patios after six pm"), 1);
        assert_eq!(a.outcome, "saved");
        assert_eq!((f.pathways[0].source.as_str(), f.pathways[0].core, f.pathways[0].confidence.as_str()), (SOURCE, true, "confirmed"));
        // The same words again: unchanged, no duplicate.
        assert_eq!(upsert_core(&mut f, &approved("preference", "When booking a dinner table", "Prefer patios after six PM."), 3).outcome, "unchanged");
        assert_eq!(f.pathways.len(), 1);
        // An explicit correction for the same trigger: superseded in place, old text kept.
        let s = upsert_core(&mut f, &approved("correction", "booking a dinner table", "always ask indoor or patio first"), 4);
        assert_eq!((s.outcome.as_str(), s.id.as_str()), ("superseded", a.id.as_str()));
        assert_eq!(f.pathways.len(), 1);
        assert_eq!(f.pathways[0].category, "preference", "a correction keeps the entry's category");
        assert_eq!(f.pathways[0].superseded[0].directive_or_fact, "prefer patios after six pm");
        // Unrelated: a new entry.
        assert_eq!(upsert_core(&mut f, &approved("workflow", "deploying CloudMart", "run terraform plan before apply"), 5).outcome, "saved");
        assert_eq!(f.pathways.len(), 2);
        // A reworded trigger is stored too (the old one kept beside the old text).
        let s = upsert_core(&mut f, &approved("workflow", "deploying CloudMart to prod", "run terraform plan before every apply"), 6);
        assert_eq!(s.outcome, "superseded");
        let p = f.pathways.iter().find(|p| p.id == s.id).unwrap();
        assert_eq!((p.trigger_or_context.as_str(), p.superseded[0].trigger_or_context.as_str()), ("deploying CloudMart to prod", "deploying CloudMart"));
    }

    #[test]
    fn recall_block_is_relevant_capped_and_prompt_safe() {
        let mut f = PathwayFile::default();
        push_new(&mut f, &d("rule", "exporting reports", "send them as JSON files", "confirmed"), 1);
        push_new(&mut f, &d("persona", "greeting Nic", "say hey Nicky", "provisional"), 2);
        let hits = relevant(&f, "can you export the weekly reports", 5, true, &[]);
        assert_eq!(hits.len(), 1);
        let b = learned_block(&hits, false);
        assert!(b.contains("exporting reports") && !b.to_lowercase().contains("json"), "{b}");
        assert!(relevant(&f, "greeting", 5, true, &[]).is_empty(), "provisional stays out of other modes");
        assert_eq!(relevant(&f, "greeting", 5, false, &[]).len(), 1);
        assert!(learned_block(&relevant(&f, "greeting", 5, false, &[]), true).contains("(provisional)"));
        assert_eq!(learned_block(&[], false), "");
        let big: Vec<Pathway> = (0..40).map(|i| Pathway { id: i.to_string(), category: "rule".into(), trigger_or_context: "x".repeat(50), directive_or_fact: "y".repeat(50), source: SOURCE.into(), timestamp: 0, updated_at: 0, confidence: "confirmed".into(), core: false, superseded: vec![] }).collect();
        assert!(learned_block(&big.iter().collect::<Vec<_>>(), false).chars().count() <= BLOCK_MAX);
    }

    #[test]
    fn commit_persists_and_survives_a_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("learning-test-{}-{}", std::process::id(), super::super::compaction::now_ms()));
        let path = store_path(&dir);
        let out = commit_core(&path, &[d("rule", "naming files", "use kebab-case", "confirmed")], 7, &[]).unwrap();
        assert_eq!(out[0].outcome, "saved");
        assert_eq!(load(&path).pathways.len(), 1);
        assert!(render_markdown(&load(&path)).contains("When naming files: use kebab-case"));
        std::fs::write(&path, "{not valid").unwrap();
        assert!(load(&path).pathways.is_empty());
        assert!(path.with_extension("json.bad").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fixture gateway_tony.py's test reads too: both sides render `expected` byte for byte.
    const CORE_FIXTURE: &str = include_str!("../../../../tests/fixtures/core_memories.json");

    #[test]
    fn core_block_matches_the_shared_fixture() {
        let fx: serde_json::Value = serde_json::from_str(CORE_FIXTURE).unwrap();
        // An old entry with no `core` field still loads (as non-core).
        let f: PathwayFile = serde_json::from_value(fx["store"].clone()).unwrap();
        assert!(!f.pathways.iter().find(|p| p.id == "lp-1700000000003-2").unwrap().core);
        let (block, ids) = core_block(&f);
        assert_eq!(block, fx["expected"].as_str().unwrap());
        let want: Vec<String> = serde_json::from_value(fx["expectedIds"].clone()).unwrap();
        assert_eq!(ids, want);
        assert!(block.chars().count() <= CORE_MAX);
    }

    fn core(id: &str, t: &str, r: &str) -> Pathway {
        Pathway { id: id.into(), category: "rule".into(), trigger_or_context: t.into(), directive_or_fact: r.into(), source: SOURCE.into(), timestamp: 0, updated_at: 0, confidence: "confirmed".into(), core: true, superseded: vec![] }
    }

    #[test]
    fn core_block_is_sorted_capped_whole_entries_and_empty_without_core() {
        assert_eq!(core_block(&PathwayFile::default()), (String::new(), vec![]));
        let only_learned = PathwayFile { pathways: vec![Pathway { core: false, ..core("a", "always", "x") }], ..Default::default() };
        assert_eq!(core_block(&only_learned).0, "", "no block without a core entry");
        // Sorted by id whatever the file order (a stable prompt prefix for the KV cache).
        let f = PathwayFile { pathways: vec![core("lp-2", "always", "second"), core("lp-1", "always", "first")], ..Default::default() };
        assert_eq!(core_block(&f).0, "CORE MEMORIES (approved by Nic):\n- first\n- second");
        // Whole entries only, never past CORE_MAX; the first overflow ends the block.
        let many = PathwayFile { pathways: (0..20).map(|i| core(&format!("lp-{i:02}"), "always", &"w".repeat(90))).collect(), ..Default::default() };
        let (b, ids) = core_block(&many);
        assert!(b.chars().count() <= CORE_MAX, "{}", b.chars().count());
        assert_eq!(ids.len(), (CORE_MAX - CORE_HEADER.len()) / 93);
        assert!(b.lines().skip(1).all(|l| l == format!("- {}", "w".repeat(90))), "every line whole");
        // memory_text: "when" is not doubled; "always" is the rule alone.
        assert_eq!(memory_text("When Nic is driving", "keep it short"), "When Nic is driving: keep it short");
        assert_eq!(memory_text("ALWAYS", "say hey"), "say hey");
        assert_eq!(memory_text("", "say hey"), "say hey");
    }

    #[test]
    fn core_entries_in_the_block_are_not_recalled_twice_and_overflow_falls_back() {
        let mut f = PathwayFile { pathways: (0..12).map(|i| core(&format!("lp-{i:02}"), "booking dinner tables", &format!("rule {i} {}", "z".repeat(80)))).collect(), ..Default::default() };
        f.pathways.push(Pathway { core: false, ..core("lp-x", "always", "keep replies short") });
        let (_, ids) = core_block(&f);
        assert!(!ids.is_empty() && ids.len() < 12);
        let hits = relevant(&f, "booking a dinner table tonight", 20, true, &ids);
        assert!(hits.iter().all(|p| !ids.contains(&p.id)), "no entry twice");
        assert!(hits.iter().any(|p| p.id == "lp-11"), "an overflowed core entry comes back by keyword");
        // Trigger `always`: recalled with no word in common.
        assert!(relevant(&f, "what's the weather", 20, true, &ids).iter().any(|p| p.id == "lp-x"));
    }

    #[test]
    fn commit_core_marks_core_confirmed_and_v1_files_still_load() {
        let dir = std::env::temp_dir().join(format!("learning-core-{}-{}", std::process::id(), super::super::compaction::now_ms()));
        let path = store_path(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A v1 file (no `core` anywhere) loads; the same lesson approved later becomes core.
        std::fs::write(&path, r#"{"version":1,"pathways":[{"id":"lp-1-0","category":"rule","trigger_or_context":"naming files","directive_or_fact":"use kebab-case","source":"learning_mode","timestamp":1,"confidence":"provisional"}]}"#).unwrap();
        assert!(!load(&path).pathways[0].core);
        let out = commit_core(&path, &[d("rule", "naming files", "use kebab-case", "provisional")], 9, &[]).unwrap();
        assert_eq!(out[0].outcome, "updated");
        let f = load(&path);
        assert_eq!((f.version, f.pathways.len(), f.pathways[0].core, f.pathways[0].confidence.as_str()), (STORE_VERSION, 1, true, "confirmed"));
        // A new lesson is saved core + confirmed.
        commit_core(&path, &[d("persona", "always", "call me Nic", "provisional")], 10, &[]).unwrap();
        let f = load(&path);
        assert!(f.pathways.iter().all(|p| p.core && p.confidence == "confirmed"));
        assert_eq!(core_block(&f).1.len(), 2);
        assert!(render_markdown(&f).contains("core memory"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn answers_are_strict_whole_lines() {
        for yes in ["yes", "Yes.", "yeah!", "yep", "Save it", "add it please", "Yes, Tony", "tony, yes please", "  YES  ", "please add it."] {
            assert_eq!(parse_answer(yes, "Tony"), Some(true), "{yes}");
        }
        for no in ["no", "No.", "nope", "don't", "Don\u{2019}t", "skip it", "no, Tony", "Tony no"] {
            assert_eq!(parse_answer(no, "Tony"), Some(false), "{no}");
        }
        for other in ["yes, but change the time", "no wait", "yes and no", "sure", "save it to the notes", "tony", "", "please", "yesterday", "I don't know", "add it later"] {
            assert_eq!(parse_answer(other, "Tony"), None, "{other}");
        }
        // The OS name is a filler like "Tony".
        assert_eq!(parse_answer("Jarvis, yep", "Jarvis"), Some(true));
        assert_eq!(parse_answer(&"yes ".repeat(40), "Tony"), None);
    }

    fn directives(v: &[Proposal]) -> Vec<&str> {
        v.iter().map(|p| p.draft.directive.as_str()).collect()
    }

    #[test]
    fn proposals_expire_and_a_spoken_answer_takes_only_the_last_replys_batch() {
        let p = Proposals::default();
        assert!(!p.any(0) && p.take_spoken(0).is_empty());
        let a = p.propose(&[d("rule", "naming files", "use kebab-case", "confirmed")], 1_000);
        assert_eq!(a[0].text, "When naming files: use kebab-case");
        assert!(a[0].id.starts_with("mem-1000-"));
        let b = p.propose(&[d("persona", "always", "call me Nic", "confirmed"), d("rule", "always", "be brief", "confirmed")], 2_000);
        assert_eq!(b.len(), 2);
        // A spoken yes answers the newest batch (the last reply's); the older one stays for its card.
        assert_eq!(directives(&p.take_spoken(2_500)), ["call me Nic", "be brief"]);
        assert!(p.any(2_500));
        assert!(p.take(&b[0].id, 2_500).is_none(), "already answered");
        // A second spoken answer never falls through to the older batch.
        assert!(p.take_spoken(2_600).is_empty(), "older batches are card-only");
        assert_eq!(p.take(&a[0].id, 2_600).unwrap().draft.directive, "use kebab-case");
        // Any other turn ends spoken answers: the batch stays pending, by id only.
        let c = p.propose(&[d("rule", "deploying", "run the plan first", "confirmed")], 3_000);
        p.close_spoken();
        assert!(p.take_spoken(3_100).is_empty());
        assert!(p.any(3_100));
        // A failed save puts the rows back with their ids (the card still answers them); a spoken
        // retry may take them again only when asked to.
        let taken = p.take(&c[0].id, 3_200).unwrap();
        p.restore(vec![taken], false);
        assert!(p.take_spoken(3_300).is_empty());
        let e = p.propose(&[d("rule", "e", "f", "confirmed")], 3_400);
        let spoken = p.take_spoken(3_500);
        assert_eq!(directives(&spoken), ["f"]);
        p.restore(spoken, true);
        assert_eq!(p.take_spoken(3_600)[0].id, e[0].id, "same id after a failed save");
        assert_eq!(p.take(&c[0].id, 3_700).unwrap().draft.directive, "run the plan first");
        // ~10 minutes later a proposal is gone, spoken or not.
        let g = p.propose(&[d("rule", "x", "y", "confirmed")], 10_000);
        assert!(p.take_spoken(10_000 + PROPOSAL_TTL_MS).is_empty());
        assert!(p.take(&g[0].id, 10_000 + PROPOSAL_TTL_MS).is_none());
        assert!(!p.any(10_000 + PROPOSAL_TTL_MS));
        // Nothing proposed: the marker isn't touched.
        assert!(p.propose(&[], 20_000).is_empty());
        // At most PROPOSALS_MAX are kept (the oldest go).
        let many: Vec<PendingMemory> = (0..PROPOSALS_MAX as u64 + 3).flat_map(|i| p.propose(&[d("rule", "t", &format!("r{i}"), "confirmed")], 20_000 + i)).collect();
        assert!(p.take(&many[0].id, 20_100).is_none());
        assert!(p.take(&many.last().unwrap().id, 20_100).is_some());
    }

    #[test]
    fn a_spoken_answer_needs_the_last_reply_to_have_asked() {
        assert!(asked_core_question(None), "no history sent: the spoken batch decides");
        assert!(asked_core_question(Some(&format!("So when X, you want Y? {CORE_QUESTION}"))));
        assert!(asked_core_question(Some("Got it. Want me to add it to my core memories?")));
        for other in ["Is that every week?", "So when X, you want Y?", SAVED_REPLY, ALREADY_REPLY, DISCARDED_REPLY] {
            assert!(!asked_core_question(Some(other)), "{other}");
        }
    }

    fn core_store(t: &str, r: &str) -> PathwayFile {
        PathwayFile { pathways: vec![core("lp-1-0", t, r)], ..Default::default() }
    }

    fn approved(cat: &str, t: &str, r: &str) -> Draft {
        Draft { category: cat.into(), trigger: t.into(), directive: r.into(), confidence: "confirmed".into(), core: true }
    }

    /// Review regressions: an approved core memory is stored as Nic approved it. A one-word
    /// correction replaces the old text (named in the reply), never "unchanged" with the old one.
    #[test]
    fn an_approved_correction_replaces_the_core_text_and_says_so() {
        let mut f = core_store("weekly report", "Send the weekly report to Sam every Friday morning");
        let s = upsert_core(&mut f, &approved("correction", "weekly report", "Send the weekly report to Sam every Monday morning"), 5);
        assert_eq!((s.outcome.as_str(), s.id.as_str()), ("superseded", "lp-1-0"));
        assert_eq!(s.replaced.as_deref(), Some("When weekly report: Send the weekly report to Sam every Friday morning"));
        assert_eq!(f.pathways.len(), 1);
        assert_eq!(f.pathways[0].directive_or_fact, "Send the weekly report to Sam every Monday morning");
        assert!(f.pathways[0].core && f.pathways[0].confidence == "confirmed");
        assert_eq!(f.pathways[0].superseded[0].directive_or_fact, "Send the weekly report to Sam every Friday morning");
        assert_eq!(core_block(&f).0, "CORE MEMORIES (approved by Nic):\n- When weekly report: Send the weekly report to Sam every Monday morning");
        assert_eq!(saved_reply(std::slice::from_ref(&s)), "Saved to my core memories. That replaces the old one: \"When weekly report: Send the weekly report to Sam every Friday morning\".");
        // The same reworded lesson tagged as a plain rule replaces it too (no Friday + Monday pair).
        let mut f = core_store("weekly report", "Send the weekly report to Sam every Friday morning");
        assert_eq!(upsert_core(&mut f, &approved("rule", "the weekly report", "send the weekly report to Sam every Monday morning"), 5).outcome, "superseded");
        assert_eq!(f.pathways.len(), 1);
        // A number is a word: "after 6" → "after 7" is a change, not the same text.
        let mut f = core_store("booking dinner", "book tables after 6 pm");
        assert_eq!(upsert_core(&mut f, &approved("correction", "booking dinner", "book tables after 7 pm"), 5).outcome, "superseded");
        // Two `always` lessons: an explicit correction of one replaces it.
        let mut f = core_store("always", "call me Nic");
        assert_eq!(upsert_core(&mut f, &approved("correction", "always", "call me Nicky"), 5).outcome, "superseded");
        assert_eq!(f.pathways[0].directive_or_fact, "call me Nicky");
    }

    #[test]
    fn an_approved_lesson_never_claims_a_save_it_didnt_make_or_replaces_an_unrelated_core_memory() {
        // The same words again (case, spacing and punctuation aside): unchanged, and said so.
        let mut f = core_store("Nic is driving", "keep replies short");
        let s = upsert_core(&mut f, &approved("rule", "when nic is driving", "Keep replies short."), 5);
        assert_eq!(s.outcome, "unchanged");
        assert_eq!(saved_reply(&[s]), ALREADY_REPLY);
        // Same rule, a different trigger: a new core memory, both kept.
        let mut f = core_store("Nic is driving", "keep replies short");
        assert_eq!(upsert_core(&mut f, &approved("rule", "Nic is cooking dinner", "keep replies short"), 5).outcome, "saved");
        assert_eq!(core_block(&f).1.len(), 2);
        // A close trigger, an unrelated rule: a new entry; the approved core memory stays.
        let mut f = core_store("Nic is driving", "keep replies short");
        let s = upsert_core(&mut f, &approved("rule", "Nic is driving to set", "tell him the call time"), 5);
        assert_eq!((s.outcome.as_str(), s.replaced.as_deref()), ("saved", None));
        assert!(f.pathways.iter().any(|p| p.directive_or_fact == "keep replies short" && p.core));
        assert_eq!(saved_reply(&[s]), SAVED_REPLY);
        // An old non-core entry with other words is never promoted: the approved words are stored.
        let mut f = PathwayFile { pathways: vec![Pathway { core: false, confidence: "provisional".into(), ..core("lp-1-0", "naming files", "use kebab case for file names") }], ..Default::default() };
        let s = upsert_core(&mut f, &approved("rule", "naming files", "use kebab-case for every file name"), 5);
        assert_eq!(s.outcome, "superseded");
        assert_eq!((f.pathways.len(), f.pathways[0].directive_or_fact.as_str(), f.pathways[0].core), (1, "use kebab-case for every file name", true));
        // The same words as an old non-core entry: made core, its (identical) text kept.
        let mut f = PathwayFile { pathways: vec![Pathway { core: false, confidence: "provisional".into(), ..core("lp-1-0", "naming files", "use kebab-case") }], ..Default::default() };
        assert_eq!(upsert_core(&mut f, &approved("rule", "Naming files", "use kebab-case."), 5).outcome, "updated");
        assert!(f.pathways[0].core && f.pathways[0].confidence == "confirmed");
        // Several replaced memories are all named; nothing at all is a plain save.
        let two = [Saved { replaced: Some("When a: b.".into()), ..saved(&f.pathways[0], "superseded") }, Saved { replaced: Some("c".into()), ..saved(&f.pathways[0], "superseded") }];
        assert_eq!(saved_reply(&two), "Saved to my core memories. That replaces the old ones: \"When a: b\"; \"c\".");
        assert_eq!(saved_reply(&[]), SAVED_REPLY);
    }

    #[test]
    fn the_core_question_is_appended_once() {
        let pm = PendingMemory { id: "m".into(), category: "rule".into(), text: "When naming files: use kebab-case".into() };
        assert_eq!(with_core_question("So when you name files, you want kebab-case?", Some(&pm)), format!("So when you name files, you want kebab-case? {CORE_QUESTION}"));
        let asked = format!("Got it. {CORE_QUESTION}");
        assert_eq!(with_core_question(&asked, Some(&pm)), asked);
        assert_eq!(with_core_question("  ", Some(&pm)), format!("Got it: When naming files: use kebab-case. {CORE_QUESTION}"));
        assert_eq!(with_core_question("", None), CORE_QUESTION);
    }
}
