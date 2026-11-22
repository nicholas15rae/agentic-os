//! Learning mode's pathway store: what Nic teaches Tony one-on-one.
//!
//! - Tony saves a lesson by ending his reply with `[[LEARN category | when | rule or fact |
//!   confirmed]]` lines (`modes::LEARNING_PROTOCOL`). [`parse_tags`] pulls them out of the answer
//!   before it is shown, spoken or logged; the webview strips them from the live token stream.
//! - Each lesson becomes a [`Pathway`] (category, trigger_or_context, directive_or_fact, source
//!   `learning_mode`, timestamp, confidence) in `<memory.notesDir>/learning/pathways.json`.
//! - [`upsert`] checks the store first: the same lesson again is a no-op (or a provisional →
//!   confirmed upgrade); a new rule for the same trigger supersedes the old entry in place (the old
//!   text is kept in `superseded`), so conflicting duplicates never pile up.
//! - [`learned_block`] gives Tony the pathways relevant to a turn (every mode: confirmed only;
//!   Learning: provisional too, so he can spot a clash before saving).
//! - [`index`] re-indexes the whole store as ONE document in the Librarian's AnythingLLM workspace
//!   (through `documenter`, Tony's only write path), removing the previous copy. Silent: no
//!   Librarian turn, no TTS; a failure is a `mirror_failed` note like any documenter ingest.

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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Superseded {
    pub directive_or_fact: String,
    pub confidence: String,
    pub at: u64,
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
        drafts.push(Draft { category: normalize_category(&cat), trigger: if trig.is_empty() { "always".into() } else { trig }, directive: dir, confidence: conf });
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
    Saved { id: p.id.clone(), title: title_of(p), category: p.category.clone(), confidence: p.confidence.clone(), outcome: outcome.into() }
}

/// Insert `d`, or update the entry it matches (see the module doc). `now` = unix ms.
pub fn upsert(f: &mut PathwayFile, d: &Draft, now: u64) -> Saved {
    let best = f
        .pathways
        .iter()
        .enumerate()
        .map(|(i, p)| (i, similarity(&p.trigger_or_context, &d.trigger), similarity(&p.directive_or_fact, &d.directive)))
        .max_by(|a, b| (a.1 + a.2).partial_cmp(&(b.1 + b.2)).unwrap_or(std::cmp::Ordering::Equal));
    if let Some((i, trig, dir)) = best {
        let p = &mut f.pathways[i];
        // The same lesson again: at most a confidence upgrade.
        if dir >= SAME_RULE && (trig >= SAME_TRIGGER * 0.5 || d.trigger == "always") {
            if p.confidence != "confirmed" && d.confidence == "confirmed" {
                p.confidence = "confirmed".into();
                p.updated_at = now;
                return saved(p, "updated");
            }
            return saved(p, "unchanged");
        }
        // A new rule for the same trigger (or a correction of a close one): supersede in place.
        if trig >= SAME_TRIGGER || (d.category == "correction" && trig >= SAME_TRIGGER * 0.6) {
            p.superseded.insert(0, Superseded { directive_or_fact: p.directive_or_fact.clone(), confidence: p.confidence.clone(), at: now });
            p.superseded.truncate(SUPERSEDED_KEEP);
            p.directive_or_fact = d.directive.clone();
            p.confidence = d.confidence.clone();
            if d.category != "correction" {
                p.category = d.category.clone();
            }
            p.updated_at = now;
            return saved(p, "superseded");
        }
    }
    let p = Pathway {
        id: format!("lp-{now}-{}", f.pathways.len()),
        category: d.category.clone(),
        trigger_or_context: d.trigger.clone(),
        directive_or_fact: d.directive.clone(),
        source: SOURCE.into(),
        timestamp: now,
        updated_at: now,
        confidence: d.confidence.clone(),
        superseded: vec![],
    };
    let out = saved(&p, "saved");
    f.pathways.push(p);
    if f.pathways.len() > STORE_MAX {
        // Oldest provisional first, else the oldest entry.
        let drop = f.pathways.iter().position(|p| p.confidence == "provisional").unwrap_or(0);
        f.pathways.remove(drop);
    }
    out
}

// ── Recall ──────────────────────────────────────────────────────────────────

/// The pathways that share words with `text`, best first (ties: most recently updated).
pub fn relevant<'a>(f: &'a PathwayFile, text: &str, max: usize, confirmed_only: bool) -> Vec<&'a Pathway> {
    let q = tokens(text);
    let mut scored: Vec<(usize, &Pathway)> = f
        .pathways
        .iter()
        .filter(|p| !confirmed_only || p.confidence == "confirmed")
        .map(|p| (tokens(&format!("{} {}", p.trigger_or_context, p.directive_or_fact)).intersection(&q).count(), p))
        .filter(|(n, _)| *n > 0)
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
            s.push_str(&format!("- When {}: {} ({}, source {}, id {})\n", p.trigger_or_context, p.directive_or_fact, p.confidence, p.source, p.id));
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

/// Save every draft (scrubbed of secrets) into the store at `path`. Returns what each did.
pub fn commit(path: &Path, drafts: &[Draft], now: u64, known: &[String]) -> Result<Vec<Saved>, String> {
    if drafts.is_empty() {
        return Ok(vec![]);
    }
    let _g = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load(path);
    f.version = 1;
    let scrub = |s: &str| super::devqueue::scrub(s, known);
    let out: Vec<Saved> = drafts.iter().map(|d| upsert(&mut f, &Draft { trigger: scrub(&d.trigger), directive: scrub(&d.directive), ..d.clone() }, now)).collect();
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
        assert_eq!(d[0], Draft { category: "rule".into(), trigger: "Nic says ship it".into(), directive: "push to main after tests pass".into(), confidence: "confirmed".into() });
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
        Draft { category: cat.into(), trigger: t.into(), directive: r.into(), confidence: c.into() }
    }

    #[test]
    fn upsert_dedupes_upgrades_and_supersedes() {
        let mut f = PathwayFile::default();
        let a = upsert(&mut f, &d("preference", "booking a dinner table", "prefer patios after six pm", "provisional"), 1);
        assert_eq!(a.outcome, "saved");
        assert_eq!(f.pathways[0].source, SOURCE);
        // Same lesson, now confirmed: upgrade, no duplicate.
        assert_eq!(upsert(&mut f, &d("preference", "booking dinner table", "prefer patios after six pm", "confirmed"), 2).outcome, "updated");
        assert_eq!(upsert(&mut f, &d("preference", "booking dinner table", "prefer patios after six pm", "confirmed"), 3).outcome, "unchanged");
        assert_eq!((f.pathways.len(), f.pathways[0].confidence.as_str()), (1, "confirmed"));
        // Same trigger, a different rule: superseded in place, old text kept.
        let s = upsert(&mut f, &d("correction", "booking a dinner table", "always ask indoor or patio first", "confirmed"), 4);
        assert_eq!((s.outcome.as_str(), s.id.as_str()), ("superseded", a.id.as_str()));
        assert_eq!(f.pathways.len(), 1);
        assert_eq!(f.pathways[0].category, "preference", "a correction keeps the entry's category");
        assert_eq!(f.pathways[0].superseded[0].directive_or_fact, "prefer patios after six pm");
        // Unrelated: a new entry.
        assert_eq!(upsert(&mut f, &d("workflow", "deploying CloudMart", "run terraform plan before apply", "confirmed"), 5).outcome, "saved");
        assert_eq!(f.pathways.len(), 2);
    }

    #[test]
    fn recall_block_is_relevant_capped_and_prompt_safe() {
        let mut f = PathwayFile::default();
        upsert(&mut f, &d("rule", "exporting reports", "send them as JSON files", "confirmed"), 1);
        upsert(&mut f, &d("persona", "greeting Nic", "say hey Nicky", "provisional"), 2);
        let hits = relevant(&f, "can you export the weekly reports", 5, true);
        assert_eq!(hits.len(), 1);
        let b = learned_block(&hits, false);
        assert!(b.contains("exporting reports") && !b.to_lowercase().contains("json"), "{b}");
        assert!(relevant(&f, "greeting", 5, true).is_empty(), "provisional stays out of other modes");
        assert_eq!(relevant(&f, "greeting", 5, false).len(), 1);
        assert!(learned_block(&relevant(&f, "greeting", 5, false), true).contains("(provisional)"));
        assert_eq!(learned_block(&[], false), "");
        let big: Vec<Pathway> = (0..40).map(|i| Pathway { id: i.to_string(), category: "rule".into(), trigger_or_context: "x".repeat(50), directive_or_fact: "y".repeat(50), source: SOURCE.into(), timestamp: 0, updated_at: 0, confidence: "confirmed".into(), superseded: vec![] }).collect();
        assert!(learned_block(&big.iter().collect::<Vec<_>>(), false).chars().count() <= BLOCK_MAX);
    }

    #[test]
    fn commit_persists_and_survives_a_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("learning-test-{}-{}", std::process::id(), super::super::compaction::now_ms()));
        let path = store_path(&dir);
        let out = commit(&path, &[d("rule", "naming files", "use kebab-case", "confirmed")], 7, &[]).unwrap();
        assert_eq!(out[0].outcome, "saved");
        assert_eq!(load(&path).pathways.len(), 1);
        assert!(render_markdown(&load(&path)).contains("When naming files: use kebab-case"));
        std::fs::write(&path, "{not valid").unwrap();
        assert!(load(&path).pathways.is_empty());
        assert!(path.with_extension("json.bad").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
