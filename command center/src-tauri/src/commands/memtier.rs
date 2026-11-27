//! Two-tier agent memory: one low-overhead service in system RAM with strict per-agent namespaces.
//!
//! - **Tier 1, Active RAG** (fast working memory): per namespace, at most `ACTIVE_MAX` entries held
//!   in RAM with a keyword index (no embeddings, no GPU). [`query`] returns the top-K that fit a
//!   char budget, so a prompt never grows by more than the caller allows.
//! - **Tier 2, Memory Module** (cold archive): `<config dir>/memory-tiers/<ns>/archive.jsonl`,
//!   append-only. Entries graduate here when untouched for `graduate_after_days` (Garbage's idle
//!   pass) or when Tier 1 overflows. [`query`] with `deep` (the Librarian, on demand) also scans it.
//! - Tier 1 survives a restart through `active.jsonl` (rewritten on change).
//! - Namespaces: `tony`, `build_circle`, `librarian`, `booking`, `security`, `observer`. Finance is
//!   NOT here: its index lives inside the sealed vault (`finance_vault.rs`), never in this service.
//!
//! Every read / write is reported to the arbiter (`memory_read` / `memory_write`), so the System
//! Map pulses the node ↔ its memory. Text is secret-scrubbed by the callers before it lands here.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const NAMESPACES: [&str; 6] = ["tony", "build_circle", "librarian", "booking", "security", "observer"];
/// Tier-1 entries per namespace.
pub const ACTIVE_MAX: usize = 400;
pub const TEXT_MAX: usize = 1200;
const DAY_MS: u64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Unix ms.
    pub at: u64,
    #[serde(default)]
    pub last_hit: u64,
    #[serde(default)]
    pub hits: u32,
    /// Done / completed work: graduates on the next Garbage pass.
    #[serde(default)]
    pub done: bool,
}

#[derive(Default)]
struct Space {
    active: Vec<Entry>,
    archived: u64,
    loaded: bool,
}

#[derive(Default)]
struct Service {
    root: Option<PathBuf>,
    spaces: BTreeMap<String, Space>,
    seq: u64,
}

fn svc() -> &'static Mutex<Service> {
    static S: OnceLock<Mutex<Service>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Service::default()))
}

pub fn valid_ns(ns: &str) -> bool {
    NAMESPACES.contains(&ns)
}

fn now_ms() -> u64 {
    super::arbiter::now_ms()
}

/// Point the service at `<config dir>/memory-tiers` (lib.rs setup). Tier 1 loads lazily.
pub fn init(config_dir: &Path) {
    svc().lock().unwrap().root = Some(config_dir.join("memory-tiers"));
}

fn ns_dir(root: &Path, ns: &str) -> PathBuf {
    root.join(ns)
}

fn tokens(s: &str) -> BTreeSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_string).collect()
}

fn read_jsonl(p: &Path) -> Vec<Entry> {
    std::fs::read_to_string(p).map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()).unwrap_or_default()
}

fn count_lines(p: &Path) -> u64 {
    std::fs::read_to_string(p).map(|s| s.lines().count() as u64).unwrap_or(0)
}

/// Load a namespace's Tier 1 (once).
fn ensure(s: &mut Service, ns: &str) {
    let root = s.root.clone();
    let sp = s.spaces.entry(ns.to_string()).or_default();
    if sp.loaded {
        return;
    }
    sp.loaded = true;
    if let Some(root) = root {
        let d = ns_dir(&root, ns);
        sp.active = read_jsonl(&d.join("active.jsonl"));
        sp.archived = count_lines(&d.join("archive.jsonl"));
    }
}

fn save_active(root: &Option<PathBuf>, ns: &str, active: &[Entry]) {
    let Some(root) = root else { return };
    let d = ns_dir(root, ns);
    if std::fs::create_dir_all(&d).is_err() {
        return;
    }
    let body: String = active.iter().filter_map(|e| serde_json::to_string(e).ok()).map(|l| l + "\n").collect();
    let _ = super::staging::atomic_write(&d.join("active.jsonl"), body.as_bytes());
}

fn append_archive(root: &Option<PathBuf>, ns: &str, entries: &[Entry]) -> Result<(), String> {
    let Some(root) = root else { return Ok(()) };
    if entries.is_empty() {
        return Ok(());
    }
    let d = ns_dir(root, ns);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(d.join("archive.jsonl")).map_err(|e| e.to_string())?;
    for e in entries {
        writeln!(f, "{}", serde_json::to_string(e).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Store `text` in `ns` (Tier 1). A near-duplicate of a recent entry refreshes it instead.
/// Overflow graduates the oldest entries to Tier 2. `node`: who wrote it (for the map).
pub fn put(node: &str, ns: &str, text: &str, tags: &[&str]) -> Option<String> {
    if !valid_ns(ns) {
        return None;
    }
    let text = super::envelope::clip(text.trim(), TEXT_MAX);
    if text.is_empty() {
        return None;
    }
    let t0 = std::time::Instant::now();
    let id = {
        let mut s = svc().lock().unwrap();
        ensure(&mut s, ns);
        s.seq += 1;
        let seq = s.seq;
        let root = s.root.clone();
        let sp = s.spaces.get_mut(ns).unwrap();
        let now = now_ms();
        let id = if let Some(e) = sp.active.iter_mut().rev().take(20).find(|e| e.text == text) {
            e.last_hit = now;
            e.id.clone()
        } else {
            let id = format!("{ns}-{now}-{seq}");
            sp.active.push(Entry { id: id.clone(), text, tags: tags.iter().map(|t| t.to_string()).collect(), at: now, last_hit: now, hits: 0, done: false });
            id
        };
        if sp.active.len() > ACTIVE_MAX {
            let n = sp.active.len() - ACTIVE_MAX;
            let out: Vec<Entry> = sp.active.drain(..n).collect();
            if append_archive(&root, ns, &out).is_ok() {
                sp.archived += out.len() as u64;
            }
        }
        save_active(&root, ns, &sp.active);
        id
    };
    super::arbiter::get().memory_io(node, ns, true, t0.elapsed().as_millis() as u64, &format!("{ns}: stored"));
    Some(id)
}

/// Top-K entries of `ns` matching `q`, within `char_budget` total. `deep` also scans Tier 2
/// (the Librarian's on-demand recall). A hit refreshes its `last_hit` (it stays active).
pub fn query(node: &str, ns: &str, q: &str, k: usize, char_budget: usize, deep: bool) -> Vec<Entry> {
    if !valid_ns(ns) || k == 0 {
        return vec![];
    }
    let t0 = std::time::Instant::now();
    let qt = tokens(q);
    if qt.is_empty() {
        return vec![];
    }
    let (mut hits, root) = {
        let mut s = svc().lock().unwrap();
        ensure(&mut s, ns);
        let root = s.root.clone();
        let sp = s.spaces.get_mut(ns).unwrap();
        let now = now_ms();
        let mut scored: Vec<(usize, usize)> = sp.active.iter().enumerate().map(|(i, e)| (tokens(&e.text).intersection(&qt).count(), i)).filter(|(n, _)| *n > 0).collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(sp.active[b.1].last_hit.cmp(&sp.active[a.1].last_hit)));
        let mut out = vec![];
        for (_, i) in scored.into_iter().take(k) {
            let e = &mut sp.active[i];
            e.last_hit = now;
            e.hits += 1;
            out.push(e.clone());
        }
        (out, root)
    };
    if deep && hits.len() < k {
        if let Some(root) = &root {
            let mut cold: Vec<(usize, Entry)> = read_jsonl(&ns_dir(root, ns).join("archive.jsonl")).into_iter().map(|e| (tokens(&e.text).intersection(&qt).count(), e)).filter(|(n, _)| *n > 0).collect();
            cold.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.at.cmp(&a.1.at)));
            hits.extend(cold.into_iter().take(k - hits.len()).map(|(_, e)| e));
        }
    }
    let mut used = 0;
    hits.retain(|e| {
        used += e.text.chars().count();
        used <= char_budget
    });
    if !hits.is_empty() {
        super::arbiter::get().memory_io(node, ns, false, t0.elapsed().as_millis() as u64, &format!("{ns}: {} recalled{}", hits.len(), if deep { " (deep)" } else { "" }));
    }
    hits
}

/// Read-only twin of [`query`] for the diagnostic probe runner (`diagnostics.rs`): same scoring
/// and the same Tier-2 scan cost, but no `hits` / `last_hit` bump, no arbiter memory pulse and no
/// write of any kind, so a probe never changes what the map or Garbage's graduation sees.
pub fn peek(ns: &str, q: &str, k: usize, char_budget: usize, deep: bool) -> Vec<Entry> {
    if !valid_ns(ns) || k == 0 {
        return vec![];
    }
    let qt = tokens(q);
    if qt.is_empty() {
        return vec![];
    }
    let (mut hits, root) = {
        let mut s = svc().lock().unwrap();
        ensure(&mut s, ns);
        let root = s.root.clone();
        let sp = &s.spaces[ns];
        let mut scored: Vec<(usize, &Entry)> = sp.active.iter().map(|e| (tokens(&e.text).intersection(&qt).count(), e)).filter(|(n, _)| *n > 0).collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.last_hit.cmp(&a.1.last_hit)));
        (scored.into_iter().take(k).map(|(_, e)| e.clone()).collect::<Vec<_>>(), root)
    };
    if deep && hits.len() < k {
        if let Some(root) = &root {
            let mut cold: Vec<(usize, Entry)> = read_jsonl(&ns_dir(root, ns).join("archive.jsonl")).into_iter().map(|e| (tokens(&e.text).intersection(&qt).count(), e)).filter(|(n, _)| *n > 0).collect();
            cold.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.at.cmp(&a.1.at)));
            hits.extend(cold.into_iter().take(k - hits.len()).map(|(_, e)| e));
        }
    }
    let mut used = 0;
    hits.retain(|e| {
        used += e.text.chars().count();
        used <= char_budget
    });
    hits
}

/// Mark entries tagged `tag` done (they graduate on the next Garbage pass).
pub fn mark_done(ns: &str, tag: &str) {
    if !valid_ns(ns) {
        return;
    }
    let mut s = svc().lock().unwrap();
    ensure(&mut s, ns);
    let root = s.root.clone();
    let sp = s.spaces.get_mut(ns).unwrap();
    let mut changed = false;
    for e in sp.active.iter_mut().filter(|e| e.tags.iter().any(|t| t == tag)) {
        changed |= !e.done;
        e.done = true;
    }
    if changed {
        save_active(&root, ns, &sp.active);
    }
}

/// Garbage's idle pass: done entries and entries untouched for `days` move from Tier 1 to Tier 2.
/// Returns how many graduated per namespace.
pub fn graduate(days: u32) -> BTreeMap<String, usize> {
    let cutoff = now_ms().saturating_sub(days.max(1) as u64 * DAY_MS);
    let mut out = BTreeMap::new();
    let mut s = svc().lock().unwrap();
    for ns in NAMESPACES {
        ensure(&mut s, ns);
        let root = s.root.clone();
        let sp = s.spaces.get_mut(ns).unwrap();
        let (cold, keep): (Vec<Entry>, Vec<Entry>) = sp.active.drain(..).partition(|e| e.done || e.last_hit.max(e.at) < cutoff);
        let n = cold.len();
        if n > 0 && append_archive(&root, ns, &cold).is_ok() {
            sp.archived += n as u64;
            sp.active = keep;
            save_active(&root, ns, &sp.active);
            out.insert(ns.to_string(), n);
        } else {
            let mut all = keep;
            if n > 0 {
                all.extend(cold); // the archive write failed: keep them active
            }
            sp.active = all;
        }
    }
    out
}

/// Per-namespace counts for the HUD.
pub fn stats() -> Value {
    let mut s = svc().lock().unwrap();
    let mut rows = vec![];
    for ns in NAMESPACES {
        ensure(&mut s, ns);
        let sp = &s.spaces[ns];
        let chars: usize = sp.active.iter().map(|e| e.text.len()).sum();
        rows.push(json!({ "namespace": ns, "active": sp.active.len(), "archived": sp.archived, "activeKb": chars / 1024 }));
    }
    json!(rows)
}

/// One namespace in depth, for the System Map's Deep Inspector: tier counts, the tag
/// "collections" it holds, the newest entries (one-line previews, already scrubbed by the writers),
/// and when it was last written / hit. `None` for an unknown namespace.
pub fn detail(ns: &str, previews: usize) -> Option<Value> {
    if !valid_ns(ns) {
        return None;
    }
    let mut s = svc().lock().unwrap();
    ensure(&mut s, ns);
    let sp = &s.spaces[ns];
    let mut tags: BTreeMap<&str, usize> = BTreeMap::new();
    for e in &sp.active {
        for t in &e.tags {
            *tags.entry(t.as_str()).or_default() += 1;
        }
    }
    let mut collections: Vec<(&str, usize)> = tags.into_iter().collect();
    collections.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let mut newest: Vec<&Entry> = sp.active.iter().collect();
    newest.sort_by(|a, b| b.at.max(b.last_hit).cmp(&a.at.max(a.last_hit)));
    let chars: usize = sp.active.iter().map(|e| e.text.len()).sum();
    Some(json!({
        "namespace": ns,
        "active": sp.active.len(),
        "activeMax": ACTIVE_MAX,
        "archived": sp.archived,
        "activeKb": chars / 1024,
        "done": sp.active.iter().filter(|e| e.done).count(),
        "hits": sp.active.iter().map(|e| e.hits as u64).sum::<u64>(),
        "lastWriteAt": sp.active.iter().map(|e| e.at).max(),
        "lastHitAt": sp.active.iter().map(|e| e.last_hit).filter(|&t| t > 0).max(),
        "oldestActiveAt": sp.active.iter().map(|e| e.last_hit.max(e.at)).min(),
        "collections": collections.iter().take(10).map(|(t, n)| json!({ "tag": t, "count": n })).collect::<Vec<_>>(),
        "recent": newest.iter().take(previews).map(|e| json!({
            "id": e.id,
            "at": e.at,
            "lastHit": e.last_hit,
            "hits": e.hits,
            "done": e.done,
            "tags": e.tags,
            "preview": super::envelope::one_line(&e.text).chars().take(140).collect::<String>(),
        })).collect::<Vec<_>>(),
    }))
}

// ── Tony's turn recall (EARLIER WITH NIC) ───────────────────────────────────────────────────────
//
// Each `tony` entry is a turn digest, "Nic: <words> | Tony: <reply>" (agents.rs). Plain `query`
// scoring made Tony parrot: "tony" and "nic" sit in every digest, so any line naming him matched
// all of them; a re-asked question pulled back his own old answer, which he then repeated word for
// word (a stale time, a greeting, a false "I'll ask the Librarian"); and a reply clipped mid-list
// ("And third,…") got continued. `recall_turns` scores content words only, skips the re-asked turn
// and never shows a reply cut mid-sentence.

/// Words that say nothing about a topic: function words, chat filler, Nic's and Tony's names, and
/// the digest labels. A line made only of these ("hey Tony, how's it going?") recalls nothing.
const STOPWORDS: &[&str] = &[
    "about", "again", "ain", "all", "alright", "also", "and", "another", "any", "anyone", "anything", "are", "aren", "because", "been", "being",
    "both", "bro", "but", "can", "cause", "check", "cool", "could", "couldn", "did", "didn", "does", "doesn", "doing", "don", "done", "dude",
    "each", "everyone", "everything", "few", "for", "from", "get", "give", "going", "gonna", "got", "gotta", "had", "has", "have", "having",
    "hello", "her", "here", "hers", "hey", "him", "himself", "his", "hiya", "how", "hows", "into", "isn", "its", "just", "know", "let",
    "lets", "like", "man", "many", "may", "might", "mine", "more", "most", "much", "must", "myself", "need", "nic", "nicholas", "nicky",
    "nope", "not", "nothing", "now", "off", "okay", "once", "one", "only", "onto", "other", "our", "ours", "out", "over", "own", "please",
    "quick", "really", "right", "said", "same", "say", "shall", "she", "should", "shouldn", "some", "someone", "something", "such", "sure",
    "tell", "than", "thank", "thanks", "that", "the", "their", "theirs", "them", "then", "there", "these", "they", "think", "this", "those",
    "three", "tony", "too", "two", "under", "until", "very", "wanna", "want", "was", "wasn", "well", "were", "weren", "what", "whats",
    "when", "where", "which", "while", "who", "whom", "whose", "why", "will", "with", "won", "would", "wouldn", "yeah", "yep", "yes", "you",
    "your", "yours", "yourself",
];

/// `tokens` without stopwords, a plural "s" dropped ("tips" = "tip"; not "focus", "glass", "this").
fn content_tokens(s: &str) -> BTreeSet<String> {
    tokens(s)
        .into_iter()
        .filter(|w| STOPWORDS.binary_search(&w.as_str()).is_err())
        .map(|w| if w.chars().count() >= 4 && w.ends_with('s') && !(w.ends_with("ss") || w.ends_with("us") || w.ends_with("is")) { w[..w.len() - 1].to_string() } else { w })
        .collect()
}

/// A turn digest's (Nic's words, Tony's reply); anything else is all Nic's side.
fn split_digest(text: &str) -> (&str, &str) {
    match text.strip_prefix("Nic: ").and_then(|t| t.split_once(" | Tony: ")) {
        Some((nic, tony)) => (nic.trim(), tony.trim()),
        None => (text.trim(), ""),
    }
}

/// Leading words that make Nic's line a question or request ("what…", "can you…", "give me…").
const ASK_WORDS: &[&str] = &[
    "am", "any", "anything", "are", "can", "check", "could", "did", "do", "does", "find", "get", "give", "got", "has", "have", "help", "how", "hows",
    "is", "look", "make", "play", "pull", "recommend", "remind", "search", "should", "show", "suggest", "tell", "was", "were", "what", "whats",
    "when", "where", "which", "who", "whos", "why", "will", "would",
];
/// Words skipped before that leading word ("hey Tony, so what…").
const LEAD_FILLERS: &[&str] = &["alright", "and", "but", "dude", "hey", "hi", "hiya", "man", "nic", "ok", "okay", "please", "quick", "so", "tony", "uh", "um", "well", "yeah", "yo"];

/// Nic's line asks or requests something (a "?", or a question / request word first), rather
/// than telling Tony a fact.
fn is_ask(nic: &str) -> bool {
    nic.contains('?')
        || nic.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).find(|w| LEAD_FILLERS.binary_search(w).is_err()).is_some_and(|w| ASK_WORDS.binary_search(&w).is_ok())
}

/// The turn being re-asked: the digest's words (`nt`, of Nic's line `nic`) and `q`'s overlap by
/// half or more (Jaccard), `q` adds at most max(1, shared / 4) words of its own, and so does an
/// earlier question or request; an earlier statement adds none. His old answer to it is what he
/// would copy. A statement that holds the answer ("My manager is Priya", "I'm calling the short
/// film Paper Lanterns") adds the answer to the question about it, so it is not one.
fn re_asked(nic: &str, nt: &BTreeSet<String>, q: &BTreeSet<String>) -> bool {
    let shared = nt.intersection(q).count();
    let own = (shared / 4).max(1);
    let old_own = if is_ask(nic) { own } else { 0 };
    shared > 0 && 2 * shared >= nt.union(q).count() && nt.difference(q).count() <= old_own && q.difference(nt).count() <= own
}

/// A reply clipped by the digest ("…") cut back to its last whole sentence, "" when none is left,
/// so a recalled reply never ends mid-list for Tony to continue ("And third,…").
fn whole_sentences(reply: &str) -> &str {
    let r = reply.trim();
    let Some(body) = r.strip_suffix('…') else { return r };
    let body = body.trim_end();
    match [". ", "! ", "? "].iter().filter_map(|p| body.rfind(p)).max() {
        Some(i) if i > 0 => &body[..=i],
        _ => "",
    }
}

/// A turn digest as one recall line ([`turn_line`]).
pub(crate) fn digest_line(text: &str) -> String {
    let (nic, tony) = split_digest(text);
    turn_line(nic, tony)
}

/// One recalled turn as Tony reads it (one line): quoted, so it reads as a note about a past
/// turn, not a transcript for him to carry on.
fn turn_line(nic: &str, tony: &str) -> String {
    let (nic, tony) = (super::envelope::one_line(nic), super::envelope::one_line(whole_sentences(tony)));
    if tony.is_empty() {
        format!("Nic said: \"{nic}\"")
    } else {
        format!("Nic said: \"{nic}\" You answered: \"{tony}\"")
    }
}

/// The pure selection behind [`recall_turns`]: (entry index, line) for up to `k` turns of
/// `entries` that bear on `q`, best first, whose lines fit `char_budget` together (a line that
/// doesn't fit is skipped, a shorter later one may still fit). A word counts by how rare it is in
/// `entries` (IDF), on Nic's side in full and on Tony's at half; a turn needs one shared word on
/// Nic's side or two on Tony's. The re-asked turn is skipped ([`re_asked`]). Ties: most recent hit.
fn select_turns(entries: &[Entry], q: &str, k: usize, char_budget: usize) -> Vec<(usize, String)> {
    let qt = content_tokens(q);
    if qt.is_empty() || k == 0 {
        return vec![];
    }
    let sides: Vec<(&str, &str, BTreeSet<String>, BTreeSet<String>)> = entries
        .iter()
        .map(|e| {
            let (nic, tony) = split_digest(&e.text);
            let nt = content_tokens(nic);
            let tt = content_tokens(tony).difference(&nt).cloned().collect();
            (nic, tony, nt, tt)
        })
        .collect();
    let mut df: BTreeMap<&str, usize> = BTreeMap::new();
    for (_, _, nt, tt) in &sides {
        for t in nt.iter().chain(tt.iter()).filter(|t| qt.contains(*t)) {
            *df.entry(t.as_str()).or_default() += 1;
        }
    }
    let idf = |t: &str| (1.0 + sides.len() as f64 / df.get(t).copied().unwrap_or(1).max(1) as f64).ln();
    let mut scored: Vec<(f64, usize)> = sides
        .iter()
        .enumerate()
        .filter_map(|(i, (nic, _, nt, tt))| {
            let on_nic: Vec<&String> = nt.intersection(&qt).collect();
            let on_tony: Vec<&String> = tt.intersection(&qt).collect();
            if (on_nic.is_empty() && on_tony.len() < 2) || re_asked(nic, nt, &qt) {
                return None;
            }
            Some((on_nic.iter().map(|t| idf(t)).sum::<f64>() + 0.5 * on_tony.iter().map(|t| idf(t)).sum::<f64>(), i))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(entries[b.1].last_hit.cmp(&entries[a.1].last_hit)));
    let mut out = vec![];
    let mut used = 0;
    for (_, i) in scored {
        let line = turn_line(sides[i].0, sides[i].1);
        let n = line.chars().count();
        if used + n <= char_budget {
            used += n;
            out.push((i, line));
            if out.len() == k {
                break;
            }
        }
    }
    out
}

/// Tony's EARLIER WITH NIC recall: up to `k` earlier turns of `ns` that bear on Nic's words `q`,
/// as prompt lines within `char_budget` ([`select_turns`]). A hit refreshes its `last_hit`, like
/// [`query`]. Tier 1 only.
pub fn recall_turns(node: &str, ns: &str, q: &str, k: usize, char_budget: usize) -> Vec<String> {
    if !valid_ns(ns) {
        return vec![];
    }
    let t0 = std::time::Instant::now();
    let lines: Vec<String> = {
        let mut s = svc().lock().unwrap();
        ensure(&mut s, ns);
        let sp = s.spaces.get_mut(ns).unwrap();
        let picked = select_turns(&sp.active, q, k, char_budget);
        let now = now_ms();
        for (i, _) in &picked {
            sp.active[*i].last_hit = now;
            sp.active[*i].hits += 1;
        }
        picked.into_iter().map(|(_, l)| l).collect()
    };
    if !lines.is_empty() {
        super::arbiter::get().memory_io(node, ns, false, t0.elapsed().as_millis() as u64, &format!("{ns}: {} recalled", lines.len()));
    }
    lines
}

/// The heading of Tony's recall block (a prefix `fence_untrusted` knows): what the lines are, and
/// the one rule that stops him repeating them.
pub const TURNS_TITLE: &str = "EARLIER WITH NIC (your memory of past turns; use only if relevant; never repeat or continue a past reply, answer Nic's new words)";

/// [`recall_turns`]' lines as a prompt block under [`TURNS_TITLE`] ("" when there are none).
pub fn turns_block(lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut s = format!("\n\n{TURNS_TITLE}:");
    for l in lines {
        s.push_str("\n- ");
        s.push_str(l);
    }
    s
}

/// A compact block for a prompt ("" when nothing matched).
pub fn recall_block(title: &str, hits: &[Entry]) -> String {
    if hits.is_empty() {
        return String::new();
    }
    let mut s = format!("\n\n{title}:");
    for e in hits {
        s.push_str("\n- ");
        s.push_str(&super::envelope::one_line(&e.text));
    }
    s
}

#[cfg(test)]
pub(crate) fn reset_for_test(root: Option<PathBuf>) {
    let mut s = svc().lock().unwrap();
    *s = Service { root, ..Default::default() };
}

#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_query_budget_graduate_and_deep_recall() {
        let _g = test_lock();
        let dir = std::env::temp_dir().join(format!("memtier-{}-{}", std::process::id(), now_ms()));
        reset_for_test(Some(dir.clone()));
        assert!(put("tony", "finance", "never here", &[]).is_none(), "finance is not a memtier namespace");
        put("coder", "build_circle", "status card build: switched the grid to CSS columns", &["task:a"]);
        put("prompter", "build_circle", "status card spec: three columns, dark theme", &["task:a"]);
        put("prompter", "build_circle", "weather widget spec: hourly strip", &["task:b"]);
        let h = query("coder", "build_circle", "status card columns", 5, 10_000, false);
        assert_eq!(h.len(), 2);
        assert!(query("coder", "build_circle", "status card columns", 5, 60, false).len() <= 1, "char budget");
        // Restart: Tier 1 reloads from disk.
        reset_for_test(Some(dir.clone()));
        assert_eq!(query("coder", "build_circle", "weather", 3, 1000, false).len(), 1);
        // Done work graduates; deep recall still finds it.
        mark_done("build_circle", "task:a");
        assert_eq!(graduate(7).get("build_circle"), Some(&2));
        assert!(query("coder", "build_circle", "status card", 3, 1000, false).is_empty());
        assert_eq!(query("librarian", "build_circle", "status card", 3, 1000, true).len(), 2);
        let st = stats();
        let row = st.as_array().unwrap().iter().find(|r| r["namespace"] == "build_circle").unwrap().clone();
        assert_eq!((row["active"].as_u64(), row["archived"].as_u64()), (Some(1), Some(2)));
        assert!(recall_block("SHARED BUILD MEMORY", &query("coder", "build_circle", "weather", 3, 1000, false)).contains("hourly strip"));
        reset_for_test(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn turn(text: &str, last_hit: u64) -> Entry {
        Entry { id: format!("t{last_hit}"), text: text.into(), tags: vec!["turn".into()], at: last_hit, last_hit, hits: 0, done: false }
    }

    /// Tony's memory as it stood on 2026-11-26, when he kept repeating old replies, plus a few
    /// facts only memory holds.
    fn nov26() -> Vec<Entry> {
        [
            "Nic: Hey Tony, how's it going? | Tony: Doing good, Nicky. Just keeping the background quiet so we can hit that next idea when you're ready.",
            "Nic: what's going on? | Tony: Just chillin' here, Nicky. Everything's green and running smooth.",
            "Nic: Tony, what time is it? | Tony: It's just about 5:43 PM right now.",
            "Nic: Tony, what should I eat tonight? | Tony: Got it, Nic. I'll ask the Librarian to check the fridge list and send you the menu or key details once it's done.",
            "Nic: Give me three quick tips for staying focused today. | Tony: First, clear your mental slate by jotting down any floating ideas so they don't steal your focus later. Second, block out just the next sixty minutes and go deep on one single thing that moves you forward. And third,…",
            "Nic: Hey Tony, give me one tip for staying focused. | Tony: Third, kill every notification except the ones that pay the bills.",
            "Nic: Hey Tony, quick check, are you there? | Tony: Yeah, I'm here Nic. Want to grab some food first, or shall we just dive straight into something interesting?",
            "Nic: Tony, how's the weather looking? | Tony: Toronto is sitting at 4°C with overcast skies and a light wind today, but rain is looking pretty likely tomorrow.",
            "Nic: No, forget about the WhatsApp group for the time being, but check my Gmail. | Tony: Got it, Nic. I've pulled your recent emails from Gmail.",
            "Nic: I'm calling the short film Paper Lanterns. | Tony: Paper Lanterns, love that title, man.",
            "Nic: Heads up, I'm allergic to shellfish, so no shrimp places. | Tony: Noted, Nic, no shellfish for you.",
            "Nic: What's that Thai spot you told me about? | Tony: Khao San Road on Adelaide, their khao soi is the move.",
            "Nic: It's from a guy named Chris. | Tony: Got it, Nic. I found the thread with Chris regarding Joelle Bandits.",
            "Nic: My manager is Priya. | Tony: Got it, Priya's your manager.",
        ]
        .iter()
        .enumerate()
        .map(|(i, t)| turn(t, 1_000 + i as u64))
        .collect()
    }

    fn lines(q: &str) -> Vec<String> {
        select_turns(&nov26(), q, 3, 450).into_iter().map(|(_, l)| l).collect()
    }

    #[test]
    fn stopwords_are_sorted_and_names_labels_and_filler_never_match() {
        assert!(STOPWORDS.windows(2).all(|w| w[0] < w[1]), "binary_search needs a sorted, deduplicated list");
        // Only names and filler: no content words, so nothing is recalled (every digest says "Tony").
        for q in ["Hey Tony, how's it going?", "Yo, what's up, Tony?", "hey nic", "Hey, how you doing?", "Tony, tell me something"] {
            assert!(content_tokens(q).is_empty(), "{q}: {:?}", content_tokens(q));
            assert!(lines(q).is_empty(), "{q}: {:?}", lines(q));
        }
        assert_eq!(content_tokens("Give me three quick tips, Tony"), BTreeSet::from(["tip".to_string()]));
        assert_eq!(content_tokens("focus on this glass"), BTreeSet::from(["focus".to_string(), "glass".to_string()]), "plural s only");
    }

    /// The 2026-11-26 parrots: each line's own earlier turn is skipped, so his old answer (a stale
    /// time, a false "I'll ask the Librarian", "Third, kill every notification") never comes back.
    #[test]
    fn the_turn_being_re_asked_is_never_recalled() {
        for q in ["Tony, what should I eat tonight?", "Tony, what time is it?", "Hey Tony, give me one tip for staying focused.", "Give me three quick tips for staying focused today.", "Tony, how's the weather looking?", "Hey Tony, quick check, are you there?", "Tony, what's the weather like?"] {
            let got = lines(q);
            assert!(got.iter().all(|l| !l.contains("fridge list") && !l.contains("5:43 PM") && !l.contains("Third, kill") && !l.contains("4°C") && !l.contains("Yeah, I'm here")), "{q}: {got:?}");
        }
        assert!(lines("Tony, what should I eat tonight?").is_empty());
        let r = |a: &str, b: &str| re_asked(a, &content_tokens(a), &content_tokens(b));
        assert!(r("Tony, what should I eat tonight?", "what should I eat tonight"));
        assert!(r("Give me three quick tips for staying focused today.", "Hey Tony, give me one tip for staying focused."), "one word of its own on a side is still the same ask");
        assert!(r("how's the weather looking", "what's the weather like"), "no '?' from speech-to-text: the question word still makes it an ask");
        assert!(r("Imperial sinks should be tagged.", "imperial sinks should be tagged"), "Nic repeating a statement word for word");
        // Not re-asks: the earlier line adds its own facts, or this one asks something more.
        assert!(!r("I'm calling the short film Paper Lanterns.", "what did I say I'm calling the short film?"), "the statement holds the answer");
        assert!(!r("My manager is Priya.", "Tony, who's my manager?"), "a one-word answer is still the answer");
        assert!(!r("I'm allergic to shellfish.", "am I allergic to anything?"));
        assert!(!r("Tony, what should I eat tonight?", "what's the move tonight?"));
        assert!(!r("when's my audition?", "what time is my audition tomorrow?"));
        assert!(!r("zqxlambda tell me a joke", "zqxlambda a joke about penguins and pirates now"));
    }

    #[test]
    fn asks_and_statements() {
        assert!(ASK_WORDS.windows(2).all(|w| w[0] < w[1]) && LEAD_FILLERS.windows(2).all(|w| w[0] < w[1]), "binary_search needs sorted lists");
        for ask in ["Hey Tony, how's it going?", "tony what time is it", "so what did you find on the sixth email", "Give me three quick tips for staying focused today.", "yo can you play some bilmuri", "Okay, quick check, are you there"] {
            assert!(is_ask(ask), "{ask}");
        }
        for said in ["My manager is Priya.", "I'm calling the short film Paper Lanterns.", "Heads up, I'm allergic to shellfish, so no shrimp places.", "It's from a guy named Chris.", "Okay, Tony", ""] {
            assert!(!is_ask(said), "{said}");
        }
    }

    /// What Nic really said before still comes back, the fact and the reply with it.
    #[test]
    fn facts_nic_gave_are_still_recalled() {
        let film = lines("Hey Tony, what did I say I'm calling the short film?");
        assert_eq!(film.first().map(String::as_str), Some("Nic said: \"I'm calling the short film Paper Lanterns.\" You answered: \"Paper Lanterns, love that title, man.\""), "{film:?}");
        assert!(lines("Tony, what was that Thai place called again?").iter().any(|l| l.contains("Khao San Road")));
        assert!(lines("Tony, who's the guy behind Joelle Bandits?").iter().any(|l| l.contains("named Chris")), "Tony's side counts too");
        assert!(lines("Tony, who's my manager?").iter().any(|l| l.contains("My manager is Priya.")), "a short statement survives the short question about it");
        // A rare word outranks a common one: the allergy beats two "...tonight?" turns.
        let mut m = nov26();
        m.push(turn("Nic: what should I eat tonight, I'm starving | Tony: How about a warm bowl of ramen?", 5_000));
        m.push(turn("Nic: tonight I'm editing the reel | Tony: Got it, editing night.", 5_001));
        let shrimp = select_turns(&m, "Tony, should I get the shrimp tacos tonight?", 3, 450);
        assert!(shrimp[0].1.contains("allergic to shellfish"), "{shrimp:?}");
    }

    #[test]
    fn a_word_only_on_tonys_side_needs_a_second_one() {
        let m = vec![turn("Nic: Tony, what should I eat tonight? | Tony: Just throw together whatever hits the spot if you want to save time.", 1), turn("Nic: hey | Tony: Joelle Bandits has a new casting call out.", 2)];
        assert!(select_turns(&m, "Tony, what time is it?", 3, 450).is_empty(), "one word ('time') in an old reply is noise");
        assert_eq!(select_turns(&m, "anything new on Joelle Bandits?", 3, 450).len(), 1, "two words in an old reply count");
    }

    #[test]
    fn a_clipped_reply_is_cut_to_whole_sentences_or_left_out() {
        let tips = lines("Hey Tony, any tips to stay focused while I edit?");
        let three = tips.iter().find(|l| l.contains("three quick tips")).expect("the three-tips turn is recalled");
        assert!(three.ends_with("moves you forward.\"") && !three.contains("third") && !three.contains('…'), "{three}");
        assert_eq!(whole_sentences("Got it. Pulling the threads for Joelle Bandits and then…"), "Got it.");
        assert_eq!(whole_sentences("Checking your Shotcut project for render jobs stuck on re-downloads or media errors, j…"), "");
        assert_eq!(whole_sentences("Done, Nic."), "Done, Nic.");
        assert_eq!(digest_line("Nic: summary please | Tony: I'm pulling the threads for 'Joelle Bandits' right now to see…"), "Nic said: \"summary please\"");
        assert_eq!(digest_line("a note that is not a turn digest"), "Nic said: \"a note that is not a turn digest\"");
    }

    #[test]
    fn the_budget_counts_rendered_lines_and_skips_what_does_not_fit() {
        let long = format!("Nic: tell me about the zqxmu festival | Tony: {}", "The zqxmu festival runs all weekend downtown. ".repeat(4).trim_end());
        let m = vec![turn(&long, 3), turn("Nic: zqxmu tickets are forty bucks | Tony: Noted.", 2), turn("Nic: zqxmu starts friday | Tony: Got it.", 1)];
        let q = "zqxmu festival plans for saturday downtown";
        assert_eq!(select_turns(&m, q, 3, 10_000)[0].0, 0, "the long one ranks first");
        let l = select_turns(&m, q, 3, 130);
        assert!(l.iter().all(|(i, _)| *i != 0) && l.len() == 2, "the long one doesn't fit; the two short ones still do: {l:?}");
        assert!(l.iter().map(|(_, s)| s.chars().count()).sum::<usize>() <= 130);
        assert_eq!(select_turns(&m, q, 1, 10_000).len(), 1, "k caps it");
    }

    #[test]
    fn recall_turns_refreshes_its_hits_and_titles_the_block() {
        let _g = test_lock();
        reset_for_test(None);
        put("tony", "tony", "Nic: Tony, what should I eat tonight? | Tony: Got it, Nic. I'll ask the Librarian to check the fridge list.", &["turn"]);
        put("tony", "tony", "Nic: My sister Maya's birthday is December 12th. | Tony: December 12th for Maya, got it.", &["turn"]);
        assert!(recall_turns("tony", "tony", "Tony, what should I eat tonight?", 3, 450).is_empty(), "the re-asked turn");
        let l = recall_turns("tony", "tony", "Tony, when's my sister's birthday again?", 3, 450);
        assert_eq!(l, ["Nic said: \"My sister Maya's birthday is December 12th.\" You answered: \"December 12th for Maya, got it.\""]);
        let b = turns_block(&l);
        assert!(b.starts_with(&format!("\n\n{TURNS_TITLE}:\n- Nic said:")) && b.contains("never repeat or continue a past reply"), "{b}");
        assert!(TURNS_TITLE.starts_with("EARLIER WITH NIC"), "fence_untrusted quotes a line that fakes this heading");
        assert_eq!(turns_block(&[]), "");
        let s = svc().lock().unwrap();
        let hit: Vec<u32> = s.spaces["tony"].active.iter().map(|e| e.hits).collect();
        assert_eq!(hit, [0, 1], "only the recalled turn is refreshed");
        drop(s);
        assert!(recall_turns("tony", "finance", "birthday", 3, 450).is_empty());
        reset_for_test(None);
    }

    /// Offline probe aid (opt-in): the recall block Tony would get for each line of `CC_PROBE_LINES`
    /// (a JSON list of strings) against the digests in `CC_PROBE_MEMORY` (a copy of
    /// `memory-tiers/tony/active.jsonl`), at the live hot-path defaults (3 turns, 450 chars), as a
    /// JSON `{line: block}` in `CC_PROBE_RECALL_OUT`. Reads copies only; the service is untouched.
    /// `cargo test --lib dump_recall_for_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump_recall_for_probe() {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let (Some(mem), Some(lines), Some(out)) = (var("CC_PROBE_MEMORY"), var("CC_PROBE_LINES"), var("CC_PROBE_RECALL_OUT")) else {
            eprintln!("set CC_PROBE_MEMORY, CC_PROBE_LINES and CC_PROBE_RECALL_OUT");
            return;
        };
        let entries = read_jsonl(&mem);
        let lines: Vec<String> = serde_json::from_str(std::fs::read_to_string(lines).unwrap().trim_start_matches('\u{feff}')).unwrap();
        let hp = super::super::os_core::MemoryConfig::default().hot_path;
        let blocks: BTreeMap<&str, String> = lines
            .iter()
            .map(|q| (q.as_str(), super::super::learning::neutral(&turns_block(&select_turns(&entries, q, hp.rag_top_k as usize, hp.rag_chunk_chars as usize).into_iter().map(|(_, l)| l).collect::<Vec<_>>()))))
            .collect();
        std::fs::write(&out, serde_json::to_string_pretty(&blocks).unwrap()).unwrap();
        println!("DUMPED {} recall blocks from {} digests -> {}", blocks.len(), entries.len(), out.display());
    }

    #[test]
    fn detail_reports_tiers_collections_and_previews() {
        let _g = test_lock();
        reset_for_test(None);
        put("librarian", "librarian", "indexed the CloudMart runbook", &["docs", "cloudmart"]);
        put("librarian", "librarian", "indexed the GCP free tier notes", &["docs"]);
        let d = detail("librarian", 1).unwrap();
        assert_eq!(d["active"], 2);
        assert_eq!(d["collections"][0]["tag"], "docs");
        assert_eq!(d["collections"][0]["count"], 2);
        assert_eq!(d["recent"].as_array().unwrap().len(), 1, "preview cap");
        assert!(d["lastWriteAt"].as_u64().is_some());
        assert!(detail("finance", 3).is_none(), "the vault's index is never exposed here");
        reset_for_test(None);
    }
}
