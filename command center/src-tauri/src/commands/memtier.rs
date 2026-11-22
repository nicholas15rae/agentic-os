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
}
