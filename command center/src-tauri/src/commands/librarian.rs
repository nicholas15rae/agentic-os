//! The Librarian's READ-ONLY view of the collective memory (tf-decisions addendum).
//!
//! The Librarian is the sole memory & research gateway, but it never touches anything itself:
//! the worker (`taskworker.rs`) gathers context ON ITS BEHALF through this module, and the
//! Librarian model only condenses what was gathered. Everything here is a read:
//!
//! - `tasks.db` through `envelope::open_read_only` (SQLite READ_ONLY open + `query_only`),
//!   SELECT statements only;
//! - Tony's notes (`memory.notesDir`, default `<workdir>/memory/tony`), `G:\ai-hub` docs and
//!   skills, and `staging/` outputs: text files only, size-capped, every path canonicalised
//!   inside its root, links / junctions and secret-looking files skipped.
//!
//! There is no write, rename, delete, embed, upload or AnythingLLM path in this module (a unit
//! test scans the non-test source for one). The packet is compact (capped items, capped total)
//! and every string is scrubbed of secrets before it leaves.

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use super::devqueue::scrub;
use super::envelope::{clip, one_line};

// Retrieval limits. The consts below are the documented DEFAULTS; the values in force are read
// at call time from the hot-reloadable policy (`policy::current().librarian`, whose
// `LibrarianPolicy::default()` mirrors them), so they can be tuned without a rebuild.

/// One context item (chars). Policy: `librarian.itemMaxChars`.
#[allow(dead_code)] // documented default; the policy value is used
pub const ITEM_MAX: usize = 1600;
/// The whole packet (chars), so the Librarian prompt stays inside a 16k-context budget.
/// Policy: `librarian.packetMaxChars`.
#[allow(dead_code)] // documented default; the policy value is used
pub const PACKET_MAX: usize = 9000;
/// Files larger than this are never opened.
pub const FILE_READ_MAX: u64 = 256 * 1024;
/// Bytes of a file scanned for keywords.
const SCAN_BYTES: usize = 8 * 1024;
/// Policy: `librarian.walkFilesMax`.
#[allow(dead_code)] // documented default; the policy value is used
pub const WALK_FILES_MAX: usize = 600;
/// Policy: `librarian.walkDepth`.
#[allow(dead_code)] // documented default; the policy value is used
pub const WALK_DEPTH: usize = 4;
/// Policy: `librarian.perRootHits`.
#[allow(dead_code)] // documented default; the policy value is used
pub const PER_ROOT_HITS: usize = 3;
/// Policy: `librarian.historyHits`.
#[allow(dead_code)] // documented default; the policy value is used
pub const HISTORY_HITS: usize = 5;

/// The retrieval limits in force (a cheap `Arc` clone of the live policy).
fn limits() -> std::sync::Arc<super::policy::Policy> {
    super::policy::current()
}

// ── Retrieval cost counters (profiling only) ────────────────────────────────
//
// `gather_local` runs on one blocking thread; these thread-local counters let it report how
// much disk it touched without threading a counter through every reader. Counts only.

thread_local! {
    static IO: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
}

fn io_reset() {
    IO.with(|c| c.set((0, 0)));
}

fn io_files(n: u64) {
    IO.with(|c| {
        let (f, b) = c.get();
        c.set((f + n, b));
    });
}

fn io_bytes(n: u64) {
    IO.with(|c| {
        let (f, b) = c.get();
        c.set((f, b + n));
    });
}

fn io_take() -> (u64, u64) {
    IO.with(|c| c.replace((0, 0)))
}

/// What one gather cost: files the walks enumerated (text-file candidates + scroll files
/// considered), bytes actually read from files (tasks.db reads go through SQLite and are not
/// counted), and the items each source contributed.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatherStats {
    pub files_walked: u64,
    pub bytes_read: u64,
    pub hits: std::collections::BTreeMap<String, usize>,
}

/// `Read` wrapper counting bytes pulled from the underlying file.
struct Counted<R>(R);

impl<R: std::io::Read> std::io::Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.0.read(buf)?;
        io_bytes(n as u64);
        Ok(n)
    }
}
const TEXT_EXT: [&str; 6] = ["md", "txt", "json", "yml", "yaml", "toml"];
/// Where Part 7 saved each AnythingLLM workspace's previous prompt (under Tony's notes root).
/// Old role prompts are not context for a build, so the gather walk never enters it.
pub const PROMPT_BACKUPS_DIR: &str = "anythingllm-prompt-backups";
const SKIP_DIRS: [&str; 15] = ["node_modules", ".git", "target", "dist", "build", "vault", "locked-archives", "venv", ".venv", "__pycache__", "checkpoints", ".iterations", "backups", "models", PROMPT_BACKUPS_DIR];
const STOPWORDS: [&str; 40] = [
    "that", "this", "with", "from", "have", "what", "when", "where", "which", "will", "would", "could", "should", "make", "build", "want", "like", "just", "some", "into", "your", "their", "there", "about", "then", "than", "them", "they", "also", "need", "page", "simple", "minimal", "create", "please", "using", "each", "every", "thing", "stuff",
];

/// Where the Librarian may read. `None` / empty = that source is unavailable (noted, skipped).
#[derive(Clone, Debug, Default)]
pub struct Sources {
    pub tasks_db: Option<PathBuf>,
    pub notes_root: Option<PathBuf>,
    pub hub_roots: Vec<PathBuf>,
    pub staging_root: Option<PathBuf>,
    /// Phase 3 Tier-2 Memory Scrolls (`G:\ai-hub-memory\scrolls` by default): read FIRST, never walked twice.
    pub scrolls_root: Option<PathBuf>,
    /// Phase 3 Tier-3 cold archive: never walked; opened only by `archive_lookup` (forensic).
    pub archive_root: Option<PathBuf>,
}

/// Scroll items per packet.
const SCROLL_HITS: usize = 3;
/// Scroll files considered per category folder.
const SCROLL_FILES_MAX: usize = 64;
/// Archive ids shown in a scroll item header (newest last in the frontmatter list).
const SCROLL_HEADER_IDS: usize = 6;
/// Cold-archive file (gz bytes) and decompressed read caps for a forensic lookup.
/// Policy: `librarian.archiveGzMaxBytes`.
#[allow(dead_code)] // documented default; the policy value is used
pub const ARCHIVE_GZ_MAX: u64 = 8 * 1024 * 1024;
pub const ARCHIVE_RAW_MAX: u64 = 4 * 1024 * 1024;
/// Records returned per forensic lookup (policy: `librarian.archiveHits`), and chars per excerpt.
#[allow(dead_code)] // documented default; the policy value is used
pub const ARCHIVE_HITS: usize = 5;
const ARCHIVE_EXCERPT: usize = 400;
/// The staging preview of the offload utility (never build output).
pub const SCROLLS_PREVIEW_DIR: &str = "memory-scrolls-preview";
/// The 4-category scroll layout: folder -> frontmatter category.
const SCROLL_DIRS: [(&str, &str); 3] = [("core", "core"), ("projects", "project"), ("patterns", "pattern")];

/// One retrieved item: `source` is an exact path / `tasks.db:<id>` / URL.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Item {
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

/// What the worker gathered for the Librarian, plus why a source was skipped.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Packet {
    pub items: Vec<Item>,
    pub skipped: Vec<String>,
}

impl Packet {
    pub fn chars(&self) -> usize {
        self.items.iter().map(|i| i.text.chars().count() + i.source.len()).sum()
    }

    /// Add an item (scrubbed, one-lined, capped at `librarian.itemMaxChars` / the packet at
    /// `librarian.packetMaxChars`). `false` once the packet is full.
    pub fn push(&mut self, source: &str, kind: &str, text: &str, known: &[String]) -> bool {
        let pol = limits();
        let (item_max, packet_max) = (pol.librarian.item_max_chars, pol.librarian.packet_max_chars);
        let text = clip(&one_line(&scrub(text, known)), item_max);
        if text.is_empty() {
            return true;
        }
        let room = packet_max.saturating_sub(self.chars());
        if room < 120 {
            self.skip("context packet is full");
            return false;
        }
        let text = clip(&text, room.saturating_sub(source.len()).min(item_max));
        self.items.push(Item { source: clip(&scrub(source, known), 300), kind: kind.into(), text });
        true
    }

    pub fn skip(&mut self, why: &str) {
        let w = clip(&one_line(why), 200);
        if !self.skipped.contains(&w) && self.skipped.len() < 20 {
            self.skipped.push(w);
        }
    }

    /// The sources a Librarian claim may cite.
    pub fn sources(&self) -> Vec<String> {
        self.items.iter().map(|i| i.source.clone()).collect()
    }
}

/// What to look for.
pub struct Query<'a> {
    /// The current task (excluded from history).
    pub task_id: Option<&'a str>,
    pub keywords: &'a [String],
    /// The current project's staging slug (its own files are listed).
    pub slug: Option<&'a str>,
}

/// Distinct lower-case search words (≥ 4 letters, no stopwords), first-seen order.
pub fn keywords(texts: &[&str], max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in texts {
        for w in t.split(|c: char| !c.is_alphanumeric()) {
            let w = w.to_lowercase();
            if w.chars().count() >= 4 && !w.chars().all(|c| c.is_ascii_digit()) && !STOPWORDS.contains(&w.as_str()) && !out.contains(&w) {
                out.push(w);
                if out.len() >= max {
                    return out;
                }
            }
        }
    }
    out
}

fn hits(text: &str, kws: &[String]) -> usize {
    let low = text.to_lowercase();
    kws.iter().filter(|k| low.contains(k.as_str())).count()
}

/// A file the Librarian must never open (credentials, keys, databases).
pub fn secret_looking(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with(".env")
        || ["secret", "credential", "password", "keychain", "token", "apikey", "api-key", "api_key", "id_rsa", "id_ed25519"].iter().any(|s| n.contains(s))
        || [".pem", ".key", ".pfx", ".p12", ".db", ".sqlite", ".sqlite3", ".kdbx", ".db-wal", ".db-shm"].iter().any(|e| n.ends_with(e))
}

fn text_file(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| TEXT_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Canonical `p` inside canonical `root`, and no link / junction at `p`.
fn inside(root_canon: &Path, p: &Path) -> bool {
    if super::staging::is_reparse(p) {
        return false;
    }
    std::fs::canonicalize(p).map(|c| c.starts_with(root_canon)).unwrap_or(false)
}

/// Read at most `max` bytes of a text file (lossy UTF-8). `None` if it is too big or unreadable.
fn read_capped(p: &Path, max: usize) -> Option<String> {
    use std::io::Read;
    let md = std::fs::symlink_metadata(p).ok()?;
    if !md.is_file() || md.len() > FILE_READ_MAX {
        return None;
    }
    let f = std::fs::File::open(p).ok()?;
    let mut buf = Vec::with_capacity(max.min(md.len() as usize));
    Counted(f).take(max as u64).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Text files under `root` (depth / count capped by `librarian.walkDepth` / `walkFilesMax`;
/// links, skip dirs and secret files excluded). `extra_skip` holds canonical directories never
/// entered (the scrolls root, read on its own, and the cold archive, which is never walked).
fn walk(root: &Path, extra_skip: &[PathBuf], l: &super::policy::LibrarianPolicy) -> Vec<PathBuf> {
    let out = walk_inner(root, extra_skip, l.walk_files_max, l.walk_depth);
    io_files(out.len() as u64);
    out
}

fn walk_inner(root: &Path, extra_skip: &[PathBuf], files_max: usize, max_depth: usize) -> Vec<PathBuf> {
    let Ok(canon) = std::fs::canonicalize(root) else { return vec![] };
    if extra_skip.iter().any(|s| *s == canon) {
        return vec![];
    }
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if out.len() >= files_max {
                return out;
            }
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if super::staging::is_reparse(&p) || secret_looking(&name) {
                continue;
            }
            if md.is_dir() {
                let skipped = !extra_skip.is_empty() && std::fs::canonicalize(&p).map(|c| extra_skip.contains(&c)).unwrap_or(true);
                if depth + 1 < max_depth && !skipped && !SKIP_DIRS.contains(&name.to_ascii_lowercase().as_str()) && !name.starts_with('.') {
                    stack.push((p, depth + 1));
                }
            } else if md.is_file() && text_file(&p) && md.len() <= FILE_READ_MAX && inside(&canon, &p) {
                out.push(p);
            }
        }
    }
    out
}

/// The lines of `text` that mention a keyword (with the first heading), else its head.
fn excerpt(text: &str, kws: &[String]) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut picked: Vec<&str> = Vec::new();
    if let Some(h) = lines.iter().find(|l| l.starts_with('#')) {
        picked.push(h);
    }
    for l in &lines {
        if picked.len() >= 14 {
            break;
        }
        if hits(l, kws) > 0 && !picked.contains(l) {
            picked.push(l);
        }
    }
    if picked.len() <= 1 {
        picked = lines.iter().take(10).copied().collect();
    }
    picked.join(" · ")
}

/// Keyword-ranked text files of one root.
fn files(p: &mut Packet, root: &Path, label: &str, kws: &[String], known: &[String], extra_skip: &[PathBuf], l: &super::policy::LibrarianPolicy) {
    if !root.is_dir() {
        p.skip(&format!("{label}: {} not found", root.display()));
        return;
    }
    if kws.is_empty() {
        return;
    }
    let mut scored: Vec<(usize, PathBuf, String)> = Vec::new();
    for f in walk(root, extra_skip, l) {
        let rel = f.strip_prefix(root).unwrap_or(&f).display().to_string();
        let Some(head) = read_capped(&f, SCAN_BYTES) else { continue };
        let score = hits(&rel, kws) * 3 + hits(&head, kws);
        if score >= 2 {
            scored.push((score, f, head));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    for (_, f, head) in scored.into_iter().take(l.per_root_hits) {
        if !p.push(&f.display().to_string(), "internal", &excerpt(&head, kws), known) {
            return;
        }
    }
}

/// Earlier tasks (SELECT only, read-only connection) that share keywords with this one.
fn history(p: &mut Packet, db: &Path, q: &Query, known: &[String], l: &super::policy::LibrarianPolicy) {
    let conn = match super::envelope::open_read_only(db) {
        Ok(c) => c,
        Err(e) => {
            p.skip(&format!("tasks.db unavailable: {e}"));
            return;
        }
    };
    let rows: Result<Vec<(String, String, Option<String>, String, String, Option<String>, Option<String>)>, rusqlite::Error> = (|| {
        let mut st = conn.prepare("SELECT task_id, title, project_slug, status, raw_intent, last_eval, error FROM task_envelope WHERE task_id IS NOT ?1 ORDER BY updated_at DESC LIMIT 200")?;
        let it = st.query_map(rusqlite::params![q.task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?;
        it.collect()
    })();
    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            p.skip(&format!("tasks.db read failed: {e}"));
            return;
        }
    };
    let mut scored: Vec<(usize, String)> = Vec::new();
    for (id, title, slug, status, raw, last_eval, error) in rows {
        let score = hits(&title, q.keywords) * 2 + hits(&raw, q.keywords);
        if score == 0 {
            continue;
        }
        let eval: Value = last_eval.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let complete = eval["complete"].as_bool().map(|b| if b { "checks passed" } else { "checks failed" }).unwrap_or("not evaluated");
        let text = format!(
            "{id}: \"{}\" · {status} · {} · {complete}{}",
            clip(&one_line(&title), 80),
            slug.map(|s| format!("staging/{s}")).unwrap_or_else(|| "no staging folder".into()),
            error.map(|e| format!(" · error: {}", clip(&one_line(&e), 120))).unwrap_or_default()
        );
        scored.push((score, text));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    if scored.is_empty() {
        return;
    }
    let text = scored.into_iter().take(l.history_hits).map(|(_, t)| t).collect::<Vec<_>>().join(" | ");
    p.push(&format!("tasks.db ({})", db.display()), "internal", &format!("Related earlier tasks: {text}"), known);
}

/// What an earlier staged project's `.status.json` says it is, for the Librarian (AD-13 round 4,
/// live run 4: "found three ready-to-use modules" from "name (review_ready)" labels on builds that
/// needed fixes). Reads `works` / `verdict` / `known_blockers(_total)` / `unchecked_total`,
/// tolerating their absence and older shapes: `works: false` or verdict `needs_fixes` → "needs
/// fixes (N known blockers), not reusable"; verdict `unverified` → "unverified (N things couldn't
/// be checked), not proven"; `works: true` → "ready"; a review_ready record from before the
/// verdict existed → "needs fixes (N known blockers), not reusable" when it lists blockers, else
/// "staged before verdicts were recorded, not proven to work"; anything else → its status
/// ("failed", "unknown"). Only "ready" means reusable.
/// Pure.
pub fn staged_label(v: &Value) -> String {
    let status = v["status"].as_str().unwrap_or("unknown");
    let listed = v["known_blockers"].as_array().map(|a| a.iter().filter(|b| b.as_str().is_some_and(|b| !b.starts_with("… and "))).count()).unwrap_or(0);
    let total = v["known_blockers_total"].as_u64().map(|n| n as usize).unwrap_or(listed);
    let plural = |n: usize, one: &str, many: &str| if n == 1 { format!("1 {one}") } else { format!("{n} {many}") };
    let verdict = v["verdict"].as_str().unwrap_or("");
    if verdict == "unverified" {
        let n = v["unchecked_total"].as_u64().map(|n| n as usize).unwrap_or(total);
        return format!("unverified ({} couldn't be checked), not proven to work", plural(n, "thing", "things"));
    }
    if v["works"] == false || verdict == "needs_fixes" {
        return format!("needs fixes ({}), not reusable", plural(total, "known blocker", "known blockers"));
    }
    if v["works"] == true {
        return "ready".into();
    }
    if status == "review_ready" {
        // A record from before the verdict fields: its blockers were found by the verify pass
        // (AD-13 round 5: "staged with 7 known blockers, never verified" for a verified, failing
        // build), so any blocker means it needs fixes. A blocker-free one may or may not have been
        // verified, so it is not called ready either.
        return if total > 0 { format!("needs fixes ({}), not reusable", plural(total, "known blocker", "known blockers")) } else { "staged before verdicts were recorded, not proven to work".into() };
    }
    status.to_string()
}

/// Other staged projects and their `.status.json` status (`staged_label`; names and status only,
/// never their code); this project's existing files.
fn staging_outputs(p: &mut Packet, root: &Path, q: &Query, known: &[String]) {
    let Ok(canon) = std::fs::canonicalize(root) else { return };
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut projects: Vec<(std::time::SystemTime, String, String)> = Vec::new();
    for e in rd.flatten().take(200) {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name == SCROLLS_PREVIEW_DIR || !path.is_dir() || !inside(&canon, &path) || super::staging::validate_slug(&name).is_err() {
            continue;
        }
        // A .status.json lists its blockers: read enough of it for the verdict fields.
        let status = read_capped(&path.join(".status.json"), 64 * 1024).and_then(|s| serde_json::from_str::<Value>(&s).ok()).map(|v| staged_label(&v)).unwrap_or_else(|| "unknown".into());
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        projects.push((mtime, name, status));
    }
    projects.sort_by(|a, b| b.0.cmp(&a.0));
    let own = q.slug.unwrap_or("");
    let related: Vec<String> = projects.iter().filter(|(_, n, _)| n != own && (q.keywords.is_empty() || hits(&n.replace('-', " "), q.keywords) > 0)).take(5).map(|(_, n, s)| format!("{n} ({s})")).collect();
    if !related.is_empty() {
        p.push(&root.display().to_string(), "internal", &format!("Related staged projects (names and status only; their code was not read): {}. Only a project marked \"ready\" may be suggested for reuse; anything else (needs fixes, unverified, staged before verdicts were recorded, failed, unknown) is never ready-to-use or reusable", related.join("; ")), known);
    }
    if !own.is_empty() {
        if let Ok(dir) = super::staging::resolve(root, own, "x").map(|x| x.parent().map(Path::to_path_buf).unwrap_or_default()) {
            if let Ok(rd) = std::fs::read_dir(&dir) {
                let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.starts_with(".tmp-")).collect();
                names.sort();
                if !names.is_empty() {
                    p.push(&dir.display().to_string(), "internal", &format!("Files already staged for this project: {}", names.join(", ")), known);
                }
            }
        }
    }
}

/// Everything local the Librarian may see for `q`. Never writes; a missing source is noted.
/// Memory Scrolls come FIRST (the distilled living truth), then tasks.db history, Tony's notes,
/// the hub (which never re-walks the scrolls or the cold archive) and staging outputs.
#[allow(dead_code)] // the plain API (tests, other callers); the worker uses the profiled one
pub fn gather_local(src: &Sources, q: &Query, known: &[String]) -> Packet {
    gather_local_profiled(src, q, known).0
}

/// [`gather_local`] plus what it cost ([`GatherStats`]). Exactly the same reads and packet; the
/// limits in force are one snapshot of `policy::current().librarian`.
pub fn gather_local_profiled(src: &Sources, q: &Query, known: &[String]) -> (Packet, GatherStats) {
    let pol = limits();
    let l = &pol.librarian;
    io_reset();
    let mut p = Packet::default();
    let mut hits = std::collections::BTreeMap::new();
    let mut mark = |p: &Packet, source: &str, before: usize| {
        let n = p.items.len().saturating_sub(before);
        *hits.entry(source.to_string()).or_insert(0usize) += n;
    };
    if let Some(r) = &src.scrolls_root {
        let b = p.items.len();
        scrolls(&mut p, r, q.keywords, known);
        mark(&p, "scrolls", b);
    }
    let extra_skip: Vec<PathBuf> = [&src.scrolls_root, &src.archive_root].into_iter().flatten().filter_map(|r| std::fs::canonicalize(r).ok()).collect();
    let b = p.items.len();
    match &src.tasks_db {
        Some(db) => history(&mut p, db, q, known, l),
        None => p.skip("tasks.db: no file-backed store"),
    }
    mark(&p, "history", b);
    let b = p.items.len();
    match &src.notes_root {
        Some(r) => files(&mut p, r, "memory", q.keywords, known, &extra_skip, l),
        None => p.skip("memory: notes root unavailable"),
    }
    mark(&p, "memory", b);
    let b = p.items.len();
    for r in src.hub_roots.iter().take(3) {
        files(&mut p, r, "ai-hub", q.keywords, known, &extra_skip, l);
    }
    mark(&p, "hub", b);
    if let Some(r) = &src.staging_root {
        let b = p.items.len();
        staging_outputs(&mut p, r, q, known);
        mark(&p, "staging", b);
    }
    let (files_walked, bytes_read) = io_take();
    (p, GatherStats { files_walked, bytes_read, hits })
}

// ── Phase 3: Memory Scrolls (Tier 2) and the cold archive (Tier 3), both read-only ──────────

/// The 6-key frontmatter of a Memory Scroll.
#[derive(Clone, Debug, PartialEq)]
pub struct ScrollMeta {
    pub scroll_id: String,
    pub category: String,
    pub last_updated: String,
    pub version: u32,
    pub source_archive_ids: Vec<String>,
    pub supersedes: Vec<String>,
}

fn archive_id_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^arch-(\d{4})-(\d{2})-\d{2}-\d{2,3}$").unwrap())
}

/// Every `arch-YYYY-MM-DD-NN` id mentioned in free text (deduplicated, in order).
pub fn archive_ids_in(text: &str) -> Vec<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"arch-\d{4}-\d{2}-\d{2}-\d{2,3}\b").unwrap());
    let mut out: Vec<String> = Vec::new();
    for m in re.find_iter(text) {
        let id = m.as_str().to_string();
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Strip a trailing ` # comment` that sits outside double quotes.
fn strip_comment(v: &str) -> &str {
    let (mut quoted, mut escaped) = (false, false);
    for (i, c) in v.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '#' if !quoted && (i == 0 || v[..i].ends_with(' ') || v[..i].ends_with('\t')) => return v[..i].trim_end(),
            _ => {}
        }
    }
    v.trim_end()
}

/// A double-quoted scalar (JSON string syntax, as the host renderer writes it).
fn unquote(v: &str) -> Option<String> {
    let v = v.trim();
    if !v.starts_with('"') {
        return None;
    }
    serde_json::from_str::<String>(v).ok()
}

/// A flow list of quoted strings: `["a", "b"]` (or `[]`); an unquoted item is refused.
fn flow_list(v: &str) -> Option<Vec<String>> {
    let v = v.trim();
    if !v.starts_with('[') {
        return None;
    }
    serde_json::from_str::<Vec<String>>(v).ok()
}

/// Parse a scroll: `(frontmatter, body)`. `None` when the frontmatter is missing, has an
/// unknown / missing key, an unquoted list item, a bad id, or a category the folder disagrees with.
pub fn parse_scroll(text: &str, dir_category: Option<&str>) -> Option<(ScrollMeta, String)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut fm: Vec<(String, String)> = Vec::new();
    let mut closed = false;
    let mut consumed = 1usize;
    for l in lines.by_ref() {
        consumed += 1;
        if l.trim_end() == "---" {
            closed = true;
            break;
        }
        if l.trim().is_empty() || l.trim_start().starts_with('#') {
            continue;
        }
        let (k, v) = l.split_once(':')?;
        let k = k.trim().to_string();
        if fm.iter().any(|(x, _)| *x == k) {
            return None;
        }
        fm.push((k, strip_comment(v.trim()).to_string()));
    }
    if !closed || fm.len() != 6 {
        return None;
    }
    let get = |k: &str| fm.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
    let scroll_id = unquote(get("scroll_id")?)?;
    let category = unquote(get("category")?)?;
    let last_updated = unquote(get("last_updated")?)?;
    let version: u32 = get("version")?.trim().parse().ok().filter(|v| *v >= 1)?;
    let source_archive_ids = flow_list(get("source_archive_ids")?)?;
    let supersedes = flow_list(get("supersedes")?)?;
    static ID: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let id_re = ID.get_or_init(|| regex::Regex::new(r"^(core|proj|pattern)-[a-z0-9][a-z0-9-]{0,62}$").unwrap());
    if !id_re.is_match(&scroll_id) || !["core", "project", "pattern"].contains(&category.as_str()) || dir_category.is_some_and(|d| d != category) {
        return None;
    }
    if last_updated.len() < 10 || !source_archive_ids.iter().all(|a| archive_id_re().is_match(a)) || supersedes.iter().any(|s| s.chars().count() > 80) {
        return None;
    }
    let body: String = text.lines().skip(consumed).collect::<Vec<_>>().join("\n");
    Some((ScrollMeta { scroll_id, category, last_updated, version, source_archive_ids, supersedes }, body))
}

/// The scroll-aware excerpt: the title, then every `##` section whose heading or bullets mention
/// a keyword (heading + its matching bullets, or all bullets when the heading itself matches).
fn scroll_excerpt(body: &str, kws: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();
    for l in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if l.starts_with("# ") && out.is_empty() && sections.is_empty() {
            out.push(l.to_string());
        } else if l.starts_with("## ") {
            sections.push((l.to_string(), vec![]));
        } else if let Some(s) = sections.last_mut() {
            s.1.push(l.to_string());
        }
    }
    let mut picked = 0;
    for (h, lines) in &sections {
        let head_hit = hits(h, kws) > 0;
        let hit_lines: Vec<&String> = lines.iter().filter(|l| head_hit || hits(l, kws) > 0).collect();
        if !hit_lines.is_empty() {
            out.push(h.clone());
            out.extend(hit_lines.into_iter().take(10).cloned());
            picked += 1;
        }
    }
    if picked == 0 {
        for (h, lines) in sections.iter().take(3) {
            out.push(h.clone());
            out.extend(lines.iter().take(3).cloned());
        }
    }
    out.join(" · ")
}

/// Tier-2 Memory Scrolls: only `core/*.md`, `projects/*.md`, `patterns/*.md` (no links, valid
/// frontmatter), ranked by keyword hits; core scrolls are always eligible.
fn scrolls(p: &mut Packet, root: &Path, kws: &[String], known: &[String]) {
    let Ok(canon) = std::fs::canonicalize(root) else {
        p.skip("scrolls: no Memory Scrolls yet");
        return;
    };
    if super::staging::is_reparse(root) {
        p.skip("scrolls: the scrolls root is a link; skipped");
        return;
    }
    let mut scored: Vec<(usize, String, ScrollMeta, String, PathBuf)> = Vec::new();
    let mut invalid = 0usize;
    for (dir, category) in SCROLL_DIRS {
        let d = root.join(dir);
        if !d.is_dir() || !inside(&canon, &d) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries.into_iter().take(SCROLL_FILES_MAX) {
            let f = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") || secret_looking(&name) || !inside(&canon, &f) {
                continue;
            }
            io_files(1);
            let Some(text) = read_capped(&f, SCAN_BYTES) else { continue };
            let Some((meta, body)) = parse_scroll(&text, Some(category)) else {
                invalid += 1;
                continue;
            };
            let rel = format!("{dir}/{name}");
            let mut score = hits(&rel.replace(['-', '_'], " "), kws) * 3 + hits(&body, kws);
            if category == "core" {
                score = score.max(1);
            }
            if score >= 1 {
                scored.push((score, rel, meta, body, f));
            }
        }
    }
    if invalid > 0 {
        p.skip(&format!("scrolls: {invalid} scroll(s) with invalid frontmatter skipped"));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    for (_, _, meta, body, f) in scored.into_iter().take(SCROLL_HITS) {
        let ids = &meta.source_archive_ids[meta.source_archive_ids.len().saturating_sub(SCROLL_HEADER_IDS)..];
        let head = format!("[scroll {} v{} · archives: {}]", meta.scroll_id, meta.version, if ids.is_empty() { "none".to_string() } else { ids.join(", ") });
        if !p.push(&f.display().to_string(), "scroll", &format!("{head} {}", scroll_excerpt(&body, kws)), known) {
            return;
        }
    }
}

/// Archive ids cited in the Librarian's reply text that ALSO appear in a gathered scroll item's
/// header (the worker never looks up an id the model invented). At most `max`.
pub fn cited_archive_ids(reply_text: &str, packet: &Packet, max: usize) -> Vec<String> {
    let in_scrolls: Vec<String> = packet.items.iter().filter(|i| i.kind == "scroll").flat_map(|i| archive_ids_in(i.text.split(']').next().unwrap_or(""))).collect();
    archive_ids_in(reply_text).into_iter().filter(|id| in_scrolls.contains(id)).take(max).collect()
}

/// A window of `text` around its first keyword hit (else its head), at most `max` chars.
fn hit_window(text: &str, kws: &[String], max: usize) -> String {
    let low = text.to_lowercase();
    let at = kws.iter().filter_map(|k| low.find(k.as_str())).min();
    let chars: Vec<char> = text.chars().collect();
    let start = match at {
        // `low` may differ in byte length from `text`; map through the char count of the prefix.
        Some(b) => low.get(..b).map(|s| s.chars().count()).unwrap_or(0).saturating_sub(max / 3),
        None => 0,
    };
    let s: String = chars.iter().skip(start).take(max).collect();
    one_line(&s)
}

/// Deep-forensic lookup (read-only): open ONE cold-archive batch by id
/// (`<root>/YYYY/MM/<id>.jsonl.gz`, path built from the id, canonicalised inside the root, no
/// links), decompress at most 4 MB, and return up to 5 keyword-matching record excerpts. Only
/// `File::open`; nothing is created, changed or deleted.
pub fn archive_lookup(root: &Path, archive_id: &str, kws: &[String], known: &[String]) -> Packet {
    use std::io::Read;
    let mut p = Packet::default();
    let Some(c) = archive_id_re().captures(archive_id) else {
        p.skip("archive: invalid archive id");
        return p;
    };
    let (yyyy, mm) = (c[1].to_string(), c[2].to_string());
    let Ok(canon) = std::fs::canonicalize(root) else {
        p.skip("archive: cold archive root not found");
        return p;
    };
    if super::staging::is_reparse(root) {
        p.skip("archive: the archive root is a link; refused");
        return p;
    }
    let dir_y = root.join(&yyyy);
    let dir_m = dir_y.join(&mm);
    let file = dir_m.join(format!("{archive_id}.jsonl.gz"));
    if [&dir_y, &dir_m, &file].iter().any(|x| super::staging::is_reparse(x)) {
        p.skip(&format!("archive {archive_id}: a link in the path; refused"));
        return p;
    }
    let md = match std::fs::symlink_metadata(&file) {
        Ok(m) if m.is_file() => m,
        _ => {
            p.skip(&format!("archive {archive_id}: not found"));
            return p;
        }
    };
    if !inside(&canon, &file) {
        p.skip(&format!("archive {archive_id}: outside the archive root; refused"));
        return p;
    }
    let pol = limits();
    let (gz_max, max_hits) = (pol.librarian.archive_gz_max_bytes, pol.librarian.archive_hits);
    if md.len() > gz_max {
        p.skip(&format!("archive {archive_id}: too large to read ({} bytes)", md.len()));
        return p;
    }
    let mut raw = Vec::new();
    let read = std::fs::File::open(&file).and_then(|f| flate2::read::GzDecoder::new(Counted(f)).take(ARCHIVE_RAW_MAX).read_to_end(&mut raw));
    if let Err(e) = read {
        p.skip(&format!("archive {archive_id}: unreadable ({e})"));
        return p;
    }
    let text = String::from_utf8_lossy(&raw);
    let mut found = 0usize;
    for line in text.lines() {
        if found >= max_hits {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "record" {
            continue;
        }
        let body = v["text"].as_str().unwrap_or("");
        let label = [v["kind"].as_str(), v["title"].as_str()].into_iter().flatten().collect::<Vec<_>>().join(" ");
        if !kws.is_empty() && hits(body, kws) + hits(&label, kws) == 0 {
            continue;
        }
        let seq = v["seq"].as_u64().map(|s| s.to_string()).unwrap_or_else(|| "?".into());
        let ts = v["ts"].as_str().unwrap_or("");
        let excerpt = format!("{}{}{}", if ts.is_empty() { String::new() } else { format!("{ts} ") }, if label.is_empty() { String::new() } else { format!("[{label}] ") }, hit_window(body, kws, ARCHIVE_EXCERPT));
        p.push(&format!("archive:{archive_id}#{seq}"), "archive", &clip(&excerpt, ARCHIVE_EXCERPT), known);
        found += 1;
    }
    if found == 0 {
        p.skip(&format!("archive {archive_id}: no record matches"));
    }
    p
}

/// [`archive_lookup`] plus the bytes it read from the archive file (profiling).
pub fn archive_lookup_profiled(root: &Path, archive_id: &str, kws: &[String], known: &[String]) -> (Packet, u64) {
    io_reset();
    let p = archive_lookup(root, archive_id, kws, known);
    (p, io_take().1)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The deterministic Librarian read-report on a finished build (no model): every artifact of
/// `iteration` exists inside `staging/<slug>/` with the recorded sha256, the slug is valid, and
/// Tony's note exists where the envelope says. Mismatches are `discrepancies` (all of them),
/// split into `build_discrepancies` (the Coder's output: slug, missing / changed files; these
/// decide `build_ok`) and `memory_discrepancies` (Tony's bookkeeping, never the Coder's job).
pub fn read_report(staging_root: &Path, slug: &str, code_artifacts: &Value, iteration: u32, memory_doc: Option<&str>) -> Value {
    let mut checks: Vec<Value> = Vec::new();
    let mut discrepancies: Vec<String> = Vec::new();
    let mut memory_discrepancies: Vec<String> = Vec::new();
    if super::staging::validate_slug(slug).is_err() {
        discrepancies.push(format!("project slug {slug:?} is not a valid staging slug"));
    }
    let arts: Vec<&Value> = code_artifacts.as_array().into_iter().flatten().filter(|a| a["iteration"].as_u64() == Some(iteration as u64) && !a["rel"].as_str().unwrap_or("").starts_with(".iterations/")).collect();
    if arts.is_empty() {
        discrepancies.push("no staged file is recorded for the final iteration".into());
    }
    for a in arts {
        let rel = a["rel"].as_str().unwrap_or("");
        let want = a["sha256"].as_str().unwrap_or("");
        let got = super::staging::resolve(staging_root, slug, rel).ok().and_then(|p| {
            let md = std::fs::symlink_metadata(&p).ok()?;
            if !md.is_file() || md.len() > super::staging::FILE_MAX {
                return None;
            }
            std::fs::read(&p).ok().map(|b| hex(&Sha256::digest(&b)))
        });
        let ok = got.as_deref() == Some(want);
        if got.is_none() {
            discrepancies.push(format!("{slug}/{rel} is missing from staging"));
        } else if !ok {
            discrepancies.push(format!("{slug}/{rel} changed after the Coder wrote it (sha256 mismatch)"));
        }
        checks.push(json!({ "file": format!("{slug}/{rel}"), "exists": got.is_some(), "shaMatches": ok }));
    }
    if let Some(doc) = memory_doc.filter(|d| !d.is_empty()) {
        let exists = Path::new(doc).is_file();
        if !exists {
            memory_discrepancies.push("Tony's task note is missing from memory".into());
        }
        checks.push(json!({ "file": "memoryDoc", "exists": exists }));
    }
    let build_discrepancies = discrepancies.clone();
    discrepancies.extend(memory_discrepancies.iter().cloned());
    json!({
        "ok": discrepancies.is_empty(),
        "build_ok": build_discrepancies.is_empty(),
        "checks": checks,
        "discrepancies": discrepancies,
        "build_discrepancies": build_discrepancies,
        "memory_discrepancies": memory_discrepancies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("librarian-{tag}-{}-{}", std::process::id(), super::super::envelope::new_task_id(super::super::envelope::now_ms())));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Every file under `root` with its size and mtime (a "nothing changed" fingerprint).
    /// SQLite's own `-wal` / `-shm` coordination files are left out: a reader may touch the
    /// shared-memory read marks, which is not a write to the database.
    fn snapshot(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let md = std::fs::symlink_metadata(e.path()).unwrap();
                if md.is_dir() {
                    stack.push(e.path());
                }
                let name = e.file_name().to_string_lossy().into_owned();
                if name.ends_with("-wal") || name.ends_with("-shm") {
                    continue;
                }
                out.push((e.path(), md.len(), md.modified().unwrap()));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn keywords_skip_stopwords_and_short_words() {
        let k = keywords(&["Build a simple tip calculator with bill and split inputs", "Tip calculator"], 8);
        assert_eq!(k, vec!["calculator", "bill", "split", "inputs"]);
    }

    #[test]
    fn secret_files_are_never_candidates() {
        for n in [".env", ".env.local", "api_tokens.md", "secrets.txt", "tasks.db", "id_rsa", "cert.pem", "creds-password.md"] {
            assert!(secret_looking(n), "{n}");
        }
        for n in ["README.md", "design-taste.md", "skills.json"] {
            assert!(!secret_looking(n), "{n}");
        }
    }

    #[test]
    fn gather_reads_only_and_changes_nothing() {
        let root = tmp("ro");
        let notes = root.join("memory").join("tony");
        let hub = root.join("ai-hub");
        let staging = root.join("staging");
        std::fs::create_dir_all(notes.join("ideas")).unwrap();
        std::fs::create_dir_all(hub.join("skills").join("taste")).unwrap();
        std::fs::create_dir_all(staging.join("tip-calculator-v1")).unwrap();
        std::fs::write(notes.join("ideas").join("2026-11-18-tip-calculator.md"), "# Tip calculator\nNic wants the split shown per person.\n").unwrap();
        std::fs::write(hub.join("skills").join("taste").join("SKILL.md"), "# Taste\nCalculator layouts: big numerals, one accent colour, split totals per person.\n").unwrap();
        std::fs::write(hub.join(".env"), "BRAVE_API_KEY=calculator-secret-should-never-be-read").unwrap();
        std::fs::write(hub.join("calculator-token.md"), "calculator calculator").unwrap();
        std::fs::write(staging.join("tip-calculator-v1").join(".status.json"), r#"{"status":"review_ready"}"#).unwrap();
        // A file-backed tasks.db with one related task, open as it is in the running app.
        let db = root.join("tasks.db");
        let store = super::super::envelope::TaskStore::default();
        store.init(&root).unwrap();
        store.create(&super::super::envelope::NewEnvelope { raw_intent: "a tip calculator for dinners".into(), source: "typed".into(), ..Default::default() }, &[]).unwrap();
        let before = snapshot(&root);
        let kws = keywords(&["tip calculator with split"], 8);
        let src = Sources { tasks_db: Some(db.clone()), notes_root: Some(notes.clone()), hub_roots: vec![hub.clone()], staging_root: Some(staging.clone()), ..Default::default() };
        let p = gather_local(&src, &Query { task_id: Some("t-other"), keywords: &kws, slug: Some("tip-calc-2") }, &[]);
        let after = snapshot(&root);
        assert_eq!(before, after, "the Librarian's gather must not create, change or delete anything");
        let all = serde_json::to_string(&p).unwrap();
        assert!(all.contains("tip-calculator.md"), "{all}");
        assert!(all.contains("SKILL.md"), "{all}");
        assert!(all.contains("Related earlier tasks"), "{all}");
        assert!(all.contains("tip-calculator-v1 (staged before verdicts were recorded, not proven to work)"), "{all}");
        assert!(!all.contains("should-never-be-read") && !all.contains("calculator-token"), "secret-looking files must not be read: {all}");
        assert!(p.chars() <= PACKET_MAX);
        drop(store);
    }

    #[test]
    fn read_only_connection_refuses_writes() {
        let root = tmp("rodb");
        let store = super::super::envelope::TaskStore::default();
        store.init(&root).unwrap();
        let ro = super::super::envelope::open_read_only(&root.join("tasks.db")).unwrap();
        let e = ro.execute("INSERT INTO envelope_meta (key, value) VALUES ('x', 'y')", []).unwrap_err().to_string();
        assert!(e.contains("readonly") || e.contains("read-only") || e.contains("attempt to write"), "{e}");
    }

    #[test]
    fn missing_sources_are_noted_not_fatal() {
        let p = gather_local(&Sources { tasks_db: Some(PathBuf::from(r"Z:\nope\tasks.db")), notes_root: Some(PathBuf::from(r"Z:\nope\notes")), ..Default::default() }, &Query { task_id: None, keywords: &["calc".to_string()], slug: None }, &[]);
        assert!(p.items.is_empty());
        assert!(p.skipped.iter().any(|s| s.contains("tasks.db")), "{:?}", p.skipped);
        assert!(p.skipped.iter().any(|s| s.contains("memory")), "{:?}", p.skipped);
    }

    #[test]
    fn read_report_flags_missing_and_changed_files() {
        let root = tmp("report");
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app").join("index.html"), b"<html>v1</html>").unwrap();
        let sha = hex(&Sha256::digest(b"<html>v1</html>"));
        let arts = json!([{ "rel": "index.html", "sha256": sha, "iteration": 0 }]);
        let ok = read_report(&root, "app", &arts, 0, None);
        assert_eq!(ok["ok"], true, "{ok}");
        std::fs::write(root.join("app").join("index.html"), b"<html>tampered</html>").unwrap();
        let bad = read_report(&root, "app", &arts, 0, Some(r"Z:\missing.md"));
        assert_eq!(bad["ok"], false);
        let d = bad["discrepancies"].to_string();
        assert!(d.contains("sha256 mismatch") && d.contains("note is missing"), "{d}");
        assert_eq!(bad["build_ok"], false);
        assert!(bad["build_discrepancies"].to_string().contains("sha256 mismatch") && !bad["build_discrepancies"].to_string().contains("note is missing"), "{bad}");
        assert!(bad["memory_discrepancies"].to_string().contains("note is missing"), "{bad}");
        let gone = read_report(&root, "app", &json!([{ "rel": "other.html", "sha256": "x", "iteration": 0 }]), 0, None);
        assert!(gone["discrepancies"].to_string().contains("missing from staging"));
        assert!(gone["build_discrepancies"].to_string().contains("missing from staging"));
        assert_eq!(gone["build_ok"], false);
        // A missing task note alone: the build is fine, the note is Tony's (memory) problem.
        std::fs::write(root.join("app").join("index.html"), b"<html>v1</html>").unwrap();
        let note = read_report(&root, "app", &arts, 0, Some(r"Z:\missing.md"));
        assert_eq!((note["ok"].clone(), note["build_ok"].clone()), (json!(false), json!(true)), "{note}");
        assert!(note["memory_discrepancies"].to_string().contains("note is missing"), "{note}");
        assert!(note["discrepancies"].to_string().contains("note is missing"), "{note}");
        assert_eq!(note["build_discrepancies"], json!([]), "{note}");
        // Both kinds at once: each list holds only its own.
        let both = read_report(&root, "app", &json!([{ "rel": "other.html", "sha256": "x", "iteration": 0 }]), 0, Some(r"Z:\missing.md"));
        assert!(!both["build_discrepancies"].to_string().contains("note is missing"), "{both}");
        assert!(!both["memory_discrepancies"].to_string().contains("missing from staging"), "{both}");
        assert_eq!(both["discrepancies"].as_array().unwrap().len(), 2, "{both}");
    }

    #[test]
    fn gather_skips_prompt_backups() {
        let root = tmp("backups");
        let notes = root.join("memory").join("tony");
        std::fs::create_dir_all(notes.join("ideas")).unwrap();
        std::fs::create_dir_all(notes.join(PROMPT_BACKUPS_DIR)).unwrap();
        std::fs::write(notes.join("ideas").join("2026-11-19-status-card.md"), "# Status card\nA minimal status card component.\n").unwrap();
        std::fs::write(notes.join(PROMPT_BACKUPS_DIR).join("coder-20261119-060535.txt"), "status card status card component component BACKUP-PROMPT-TEXT").unwrap();
        let before = snapshot(&root);
        let kws = keywords(&["status card component"], 8);
        let src = Sources { notes_root: Some(notes.clone()), ..Default::default() };
        let p = gather_local(&src, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        assert_eq!(before, snapshot(&root), "the Librarian's gather must not create, change or delete anything");
        let all = serde_json::to_string(&p).unwrap();
        assert!(all.contains("2026-11-19-status-card.md"), "{all}");
        assert!(!all.contains("BACKUP-PROMPT-TEXT") && !all.contains(PROMPT_BACKUPS_DIR), "prompt backups must not be gathered: {all}");
    }

    /// The policy defaults mirror the documented consts (hot values start where the build was).
    #[test]
    fn policy_defaults_mirror_the_consts() {
        let l = super::super::policy::LibrarianPolicy::default();
        assert_eq!((l.packet_max_chars, l.item_max_chars, l.per_root_hits, l.history_hits, l.archive_hits), (PACKET_MAX, ITEM_MAX, PER_ROOT_HITS, HISTORY_HITS, ARCHIVE_HITS));
        assert_eq!((l.walk_files_max, l.walk_depth, l.archive_gz_max_bytes), (WALK_FILES_MAX, WALK_DEPTH, ARCHIVE_GZ_MAX));
    }

    /// The walk obeys the limits it is given (the policy's, at call time).
    #[test]
    fn walk_limits_come_from_the_policy() {
        let root = tmp("walklim");
        std::fs::create_dir_all(root.join("a").join("b").join("c")).unwrap();
        for i in 0..5 {
            std::fs::write(root.join(format!("f{i}.md")), "x").unwrap();
        }
        std::fs::write(root.join("a").join("b").join("c").join("deep.md"), "x").unwrap();
        let l = super::super::policy::LibrarianPolicy { walk_files_max: 2, ..Default::default() };
        assert_eq!(walk(&root, &[], &l).len(), 2);
        let shallow = super::super::policy::LibrarianPolicy { walk_depth: 1, ..Default::default() };
        let all = walk(&root, &[], &shallow);
        assert_eq!(all.len(), 5, "depth 1 never enters a/: {all:?}");
        let deep = walk(&root, &[], &super::super::policy::LibrarianPolicy::default());
        assert!(deep.iter().any(|p| p.ends_with("deep.md")), "{deep:?}");
    }

    /// The profiled gather returns the same packet plus its cost.
    #[test]
    fn profiled_gather_counts_files_bytes_and_hits() {
        let root = tmp("stats");
        let notes = root.join("notes");
        let hub = root.join("hub");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&hub).unwrap();
        let body = "# Whisper\nwhisper port notes 8178\n";
        std::fs::write(notes.join("whisper-port.md"), body).unwrap();
        std::fs::write(hub.join("whisper-hub.md"), body).unwrap();
        std::fs::write(hub.join("unrelated.md"), "nothing here").unwrap();
        let kws = keywords(&["whisper port"], 8);
        let src = Sources { notes_root: Some(notes), hub_roots: vec![hub], ..Default::default() };
        let q = Query { task_id: None, keywords: &kws, slug: None };
        let (p, st) = gather_local_profiled(&src, &q, &[]);
        assert_eq!(p, gather_local(&src, &q, &[]), "profiling never changes what is gathered");
        assert_eq!(st.files_walked, 3);
        assert_eq!(st.bytes_read, (body.len() * 2 + "nothing here".len()) as u64);
        assert_eq!(st.hits.get("memory"), Some(&1));
        assert_eq!(st.hits.get("hub"), Some(&1));
        assert_eq!(st.hits.get("history"), Some(&0));
        let v = serde_json::to_value(&st).unwrap();
        assert!(v.get("filesWalked").is_some() && v.get("bytesRead").is_some(), "{v}");
        // A forensic lookup reports the archive bytes it read.
        let id = "arch-2026-11-19-01";
        let gz = write_archive(&root.join("archive"), id, &[("turn", "whisper port 8178")]);
        let (fp, bytes) = archive_lookup_profiled(&root.join("archive"), id, &kws, &[]);
        assert_eq!(fp.items.len(), 1);
        assert_eq!(bytes, std::fs::metadata(gz).unwrap().len());
    }

    /// Acceptance (addendum): ZERO write / edit / upload / embed / delete paths in the
    /// Librarian's module.
    #[test]
    fn module_has_no_write_paths() {
        let src = include_str!("librarian.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for w in [
            "fs::write", "File::create", "OpenOptions", "remove_file", "remove_dir", "create_dir", "fs::rename", "fs::copy", "atomic_write", "write_artifact", "tony_document", "AllmWriter", "AllmConn", "raw_text_ingest", ".execute(", "execute_batch", "TaskStore", "open_db", "reqwest",
            // Phase 3: the scroll / archive readers stay read-only too.
            "GzEncoder", "hard_link", "set_len", "Command::new", ".spawn(", "ScrollWriter", "kg_upsert", "set_permissions", "write_all",
        ] {
            assert!(!body.contains(w), "librarian.rs must not contain {w}");
        }
    }

    // ── Phase 3: Memory Scrolls + cold archive ───────────────────────────────

    fn scroll_text(id: &str, category: &str, version: u32, ids: &[&str], body: &str) -> String {
        let ids = ids.iter().map(|i| format!("\"{i}\"")).collect::<Vec<_>>().join(", ");
        format!("---\nscroll_id: \"{id}\"\ncategory: \"{category}\"\nlast_updated: \"2026-11-19T09:00:00-05:00\"\nversion: {version}\nsource_archive_ids: [{ids}]\nsupersedes: []\n---\n{body}")
    }

    /// A scrolls root with the 3 categories; returns (root, scrolls_root).
    fn scrolls_fixture(tag: &str, under_hub: bool) -> (PathBuf, PathBuf) {
        let root = tmp(tag);
        let scrolls = if under_hub { root.join("hub").join("memory").join("scrolls") } else { root.join("scrolls") };
        for d in ["core", "projects", "patterns"] {
            std::fs::create_dir_all(scrolls.join(d)).unwrap();
        }
        std::fs::write(
            scrolls.join("core").join("architecture_decisions.md"),
            scroll_text("core-architecture-decisions", "core", 2, &["arch-2026-11-18-01"], "# Architecture Decisions\n\n## Ports & Services\n\n- LM Studio serves on :1235\n- Whisper STT runs on port 8178\n\n## Repo Paths\n\n- Scrolls live under the ai-hub memory folder\n\n## Superseded Decisions\n\n- 2026-11-19: LM Studio 1234 -> 1235 (arch-2026-11-19-01)\n"),
        )
        .unwrap();
        std::fs::write(
            scrolls.join("projects").join("agentic-os.md"),
            scroll_text("proj-agentic-os", "project", 3, &["arch-2026-11-18-01", "arch-2026-11-19-02"], "# Agentic OS\n\n## Current Milestone\n\n- Phase 3 memory scrolls\n\n## Locked Decisions\n\n- Whisper transcription stays local\n\n## Superseded Decisions\n"),
        )
        .unwrap();
        std::fs::write(
            scrolls.join("patterns").join("lessons_and_fixes.md"),
            scroll_text("pattern-lessons-and-fixes", "pattern", 1, &[], "# Lessons and Fixes\n\n## Tool Quirks\n\n- Smart App Control blocks fresh test binaries\n\n## Superseded Decisions\n"),
        )
        .unwrap();
        (root, scrolls)
    }

    #[test]
    fn parse_scroll_accepts_the_spec_example_and_rejects_bad_frontmatter() {
        let spec = "---\nscroll_id: \"proj-agentic-os\"\ncategory: \"project\" # core | project | pattern\nlast_updated: \"2026-11-19T09:00:00-05:00\"\nversion: 3\nsource_archive_ids: [\"arch-2026-11-18-01\", \"arch-2026-11-19-02\"]\nsupersedes: [\"legacy-note-v1\"]\n---\n# Agentic OS\n";
        let (m, body) = parse_scroll(spec, Some("project")).unwrap();
        assert_eq!((m.scroll_id.as_str(), m.category.as_str(), m.version), ("proj-agentic-os", "project", 3));
        assert_eq!(m.source_archive_ids, vec!["arch-2026-11-18-01", "arch-2026-11-19-02"]);
        assert_eq!(m.supersedes, vec!["legacy-note-v1"]);
        assert_eq!(body.trim(), "# Agentic OS");
        // A supersedes item with a comma and an escaped quote (the host renders JSON strings).
        let tricky = spec.replace("[\"legacy-note-v1\"]", "[\"old, \\\"quoted\\\" note\"]");
        assert_eq!(parse_scroll(&tricky, Some("project")).unwrap().0.supersedes, vec!["old, \"quoted\" note"]);
        let bad = [
            spec.replace("version: 3\n", ""),                                       // missing key
            spec.replace("supersedes:", "extra: \"x\"\nsupersedes:"),               // unknown / 7 keys
            spec.replace("version: 3", "version: three"),                          // non-int
            spec.replace("version: 3", "version: 0"),                              // < 1
            spec.replace("[\"legacy-note-v1\"]", "[legacy-note-v1]"),              // unquoted item
            spec.replace("\"proj-agentic-os\"", "\"Proj_Bad\""),                   // bad id
            spec.replace("arch-2026-11-18-01", "arch-26-11-18-1"),                 // bad archive id
            spec.replace("---\n# Agentic", "# Agentic"),                           // unclosed
            spec.replacen("---\n", "", 1),                                         // no frontmatter
        ];
        for b in &bad {
            assert!(parse_scroll(b, Some("project")).is_none(), "{b}");
        }
        assert!(parse_scroll(spec, Some("core")).is_none(), "category must match its folder");
    }

    #[test]
    fn gather_reads_scrolls_first_and_changes_nothing() {
        let (root, scrolls) = scrolls_fixture("tierfirst", true);
        let hub = root.join("hub");
        std::fs::create_dir_all(hub.join("skills")).unwrap();
        std::fs::write(hub.join("skills").join("whisper-setup.md"), "# Whisper setup\nWhisper port notes for the transcription service.\n").unwrap();
        let before = snapshot(&root);
        let kws = keywords(&["whisper port"], 8);
        let src = Sources { hub_roots: vec![hub.clone()], scrolls_root: Some(scrolls.clone()), ..Default::default() };
        let p = gather_local(&src, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        assert_eq!(before, snapshot(&root), "reading scrolls must not create, change or delete anything");
        assert!(!p.items.is_empty(), "{p:?}");
        assert_eq!(p.items[0].kind, "scroll", "scrolls come first: {:?}", p.items);
        let first = &p.items[0].text;
        assert!(first.starts_with("[scroll core-architecture-decisions v2 · archives: arch-2026-11-18-01]"), "{first}");
        assert!(first.contains("8178"), "{first}");
        let all = serde_json::to_string(&p).unwrap();
        assert!(all.contains("[scroll proj-agentic-os v3 · archives: arch-2026-11-18-01, arch-2026-11-19-02]"), "{all}");
        assert!(all.contains("whisper-setup.md"), "the hub is still read: {all}");
        // The hub walk never re-reads the scrolls (no duplicate internal items).
        let scrolls_prefix = scrolls.display().to_string();
        assert!(p.items.iter().filter(|i| i.kind == "internal").all(|i| !i.source.starts_with(&scrolls_prefix)), "{all}");
        assert!(p.items.iter().filter(|i| i.kind == "scroll").count() <= SCROLL_HITS);
    }

    #[test]
    fn core_scrolls_are_always_eligible_and_projects_need_a_hit() {
        let (_root, scrolls) = scrolls_fixture("scrollrank", false);
        let kws = keywords(&["unrelated topic"], 8);
        let p = gather_local(&Sources { scrolls_root: Some(scrolls), ..Default::default() }, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        let ids: Vec<&str> = p.items.iter().filter(|i| i.kind == "scroll").map(|i| i.text.as_str()).collect();
        assert_eq!(ids.len(), 1, "{ids:?}");
        assert!(ids[0].contains("core-architecture-decisions"));
    }

    #[test]
    fn hub_walk_skips_scrolls_and_archive() {
        let root = tmp("hubskip");
        let hub = root.join("hub");
        let scrolls = hub.join("memory").join("scrolls");
        let archive = hub.join("archive");
        std::fs::create_dir_all(scrolls.join("notes")).unwrap();
        std::fs::create_dir_all(&archive).unwrap();
        // Files that WOULD match the hub walk if it entered these roots.
        std::fs::write(scrolls.join("notes").join("whisper-loose.md"), "whisper whisper port").unwrap();
        std::fs::write(archive.join("whisper-archive.md"), "whisper whisper port").unwrap();
        std::fs::write(hub.join("whisper-hub.md"), "whisper whisper port").unwrap();
        let kws = keywords(&["whisper port"], 8);
        let src = Sources { hub_roots: vec![hub.clone()], scrolls_root: Some(scrolls), archive_root: Some(archive), ..Default::default() };
        let p = gather_local(&src, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        let all = serde_json::to_string(&p).unwrap();
        assert!(all.contains("whisper-hub.md"), "{all}");
        assert!(!all.contains("whisper-loose.md") && !all.contains("whisper-archive.md"), "{all}");
    }

    #[test]
    fn invalid_frontmatter_scroll_skipped() {
        let root = tmp("badscroll");
        let scrolls = root.join("scrolls");
        std::fs::create_dir_all(scrolls.join("projects")).unwrap();
        std::fs::create_dir_all(scrolls.join("core")).unwrap();
        std::fs::write(scrolls.join("projects").join("whisper.md"), "# no frontmatter\nwhisper whisper").unwrap();
        // A project-category scroll in the core folder is refused too.
        std::fs::write(scrolls.join("core").join("identity_and_preferences.md"), scroll_text("proj-whisper", "project", 1, &[], "# whisper\n")).unwrap();
        // Outside the 4-category layout: never read.
        std::fs::write(scrolls.join("whisper-root.md"), scroll_text("core-x", "core", 1, &[], "# whisper\n")).unwrap();
        let kws = keywords(&["whisper"], 8);
        let p = gather_local(&Sources { scrolls_root: Some(scrolls), ..Default::default() }, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        assert!(p.items.is_empty(), "{p:?}");
        assert!(p.skipped.iter().any(|s| s.contains("2 scroll(s) with invalid frontmatter")), "{:?}", p.skipped);
    }

    #[test]
    fn missing_scrolls_root_is_noted() {
        let p = gather_local(&Sources { scrolls_root: Some(PathBuf::from(r"Z:\nope\scrolls")), ..Default::default() }, &Query { task_id: None, keywords: &["whisper".to_string()], slug: None }, &[]);
        assert!(p.items.is_empty());
        assert!(p.skipped.iter().any(|s| s.contains("scrolls")), "{:?}", p.skipped);
    }

    #[test]
    fn staging_outputs_ignores_preview_dir() {
        let root = tmp("preview");
        let staging = root.join("staging");
        std::fs::create_dir_all(staging.join(SCROLLS_PREVIEW_DIR).join("20261119-010101")).unwrap();
        std::fs::create_dir_all(staging.join("memory-widget")).unwrap();
        std::fs::write(staging.join("memory-widget").join(".status.json"), r#"{"status":"review_ready"}"#).unwrap();
        let kws = keywords(&["memory scrolls widget preview"], 8);
        let p = gather_local(&Sources { staging_root: Some(staging), ..Default::default() }, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        let all = serde_json::to_string(&p).unwrap();
        assert!(all.contains("memory-widget (staged before verdicts were recorded, not proven to work)"), "{all}");
        assert!(!all.contains(SCROLLS_PREVIEW_DIR), "{all}");
    }

    /// AD-13 round 4 (live run 4: "found three ready-to-use modules" that all needed fixes): the
    /// Librarian sees each earlier staged project's honest verdict from its `.status.json`, in a
    /// temp staging dir (never the real one), tolerating older shapes and a broken file.
    #[test]
    fn staged_projects_are_labelled_by_their_verdict_not_review_ready() {
        let root = tmp("staged-labels");
        let staging = root.join("staging");
        let fixtures: [(&str, &str); 7] = [
            ("protein-tracker", r#"{"status":"review_ready","iteration":0,"known_blockers":[],"title":"Protein Tracker"}"#),
            ("protein-tracker-2", r#"{"status":"review_ready","known_blockers":["probe failed for x","probe failed for y","… and 4 more (see the verify record)"],"known_blockers_total":6,"works":false,"verdict":"needs_fixes"}"#),
            ("protein-tracker-3", r#"{"status":"review_ready","known_blockers":["a","b","c"],"verdict":"needs_fixes"}"#),
            ("protein-intake-tracker", r#"{"status":"review_ready","known_blockers":["couldn't be checked in a browser: x"],"known_blockers_total":3,"unchecked_total":2,"works":false,"verdict":"unverified"}"#),
            ("protein-calc", r#"{"status":"review_ready","known_blockers":["a note"],"works":true,"verdict":"pass_with_notes"}"#),
            ("protein-old", r#"{"status":"failed"}"#),
            ("protein-broken", "{not json"),
        ];
        for (name, body) in fixtures {
            std::fs::create_dir_all(staging.join(name)).unwrap();
            std::fs::write(staging.join(name).join(".status.json"), body).unwrap();
        }
        let kws = keywords(&["protein tracker"], 8);
        let p = gather_local(&Sources { staging_root: Some(staging.clone()), ..Default::default() }, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        let line = p.items.iter().find(|i| i.text.starts_with("Related staged projects")).map(|i| i.text.clone()).unwrap_or_default();
        assert!(line.contains("names and status only; their code was not read"), "{line}");
        assert!(line.contains("never ready-to-use or reusable"), "{line}");
        // Five of the seven are listed (the newest first); every label is checked on its own.
        assert!(!line.contains("(review_ready)"), "{line}");
        let label = |body: &str| staged_label(&serde_json::from_str(body).unwrap());
        assert_eq!(label(fixtures[0].1), "staged before verdicts were recorded, not proven to work");
        assert_eq!(label(fixtures[1].1), "needs fixes (6 known blockers), not reusable");
        assert_eq!(label(fixtures[2].1), "needs fixes (3 known blockers), not reusable", "verdict alone, the list counted");
        assert_eq!(label(fixtures[3].1), "unverified (2 things couldn't be checked), not proven to work");
        assert_eq!(label(fixtures[4].1), "ready");
        assert_eq!(label(fixtures[5].1), "failed");
        // AD-13 round 5: an older record a verify pass failed (the real protein-intake-tracker
        // shape: iteration 2, probe failures, no works/verdict) needs fixes; it was verified.
        assert_eq!(label(r#"{"status":"review_ready","known_blockers":["x"]}"#), "needs fixes (1 known blocker), not reusable");
        let legacy_failed = r#"{"at":1795176790057,"iteration":2,"known_blockers":["the script looks up ids no element has: #proteinGrams","the page throws when its controls are used: Uncaught TypeError","probe failed again for Toggle switch: got Loading...; expected ≈132","a","b","c","d"],"status":"review_ready","title":"Protein Intake Tracker"}"#;
        assert_eq!(label(legacy_failed), "needs fixes (7 known blockers), not reusable");
        assert!(!label(legacy_failed).contains("never verified"));
        // A blocker-free older record is not "ready" and not "never verified" (it may have passed).
        assert_eq!(label(r#"{"status":"review_ready","iteration":2,"known_blockers":[]}"#), "staged before verdicts were recorded, not proven to work");
        assert!(line.contains("anything else") && line.contains("staged before verdicts were recorded"), "{line}");
        assert_eq!(label(r#"{"works":false}"#), "needs fixes (0 known blockers), not reusable");
        assert_eq!(label("{}"), "unknown");
        // The broken file reads "unknown"; nothing in the staging dir was changed.
        let p2 = gather_local(&Sources { staging_root: Some(staging.clone()), ..Default::default() }, &Query { task_id: None, keywords: &keywords(&["protein broken"], 8), slug: None }, &[]);
        assert!(serde_json::to_string(&p2).unwrap().contains("protein-broken (unknown)"));
        assert_eq!(std::fs::read_to_string(staging.join("protein-broken").join(".status.json")).unwrap(), "{not json");
    }

    /// `<root>/YYYY/MM/<id>.jsonl.gz` in the host's archive format (built with the encoder
    /// here in the test module only).
    fn write_archive(root: &Path, id: &str, records: &[(&str, &str)]) -> PathBuf {
        use flate2::write::GzEncoder;
        use std::io::Write;
        let dir = root.join(&id[5..9]).join(&id[10..12]);
        std::fs::create_dir_all(&dir).unwrap();
        let mut lines = vec![json!({ "type": "header", "schema": "agentic-os.archive.v1", "archive_id": id, "records": records.len(), "redactions": 0 }).to_string()];
        for (i, (kind, text)) in records.iter().enumerate() {
            lines.push(json!({ "type": "record", "seq": i + 1, "kind": kind, "ts": "2026-11-19T08:00:00-05:00", "text": text, "meta": {} }).to_string());
        }
        let path = dir.join(format!("{id}.jsonl.gz"));
        let mut enc = GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::default());
        enc.write_all((lines.join("\n") + "\n").as_bytes()).unwrap();
        enc.finish().unwrap();
        path
    }

    #[test]
    fn archive_lookup_reads_gz_read_only() {
        let root = tmp("archive");
        let id = "arch-2026-11-19-01";
        let long_noise = "retrying... ".repeat(200);
        write_archive(&root, id, &[("turn", "hey Tony good morning"), ("turn", &format!("{long_noise} Locked: Whisper STT runs on port 8178 {long_noise}")), ("turn", "token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789 leaked whisper"), ("build_log", "unrelated build output")]);
        let before = snapshot(&root);
        let kws = keywords(&["whisper port"], 8);
        let p = archive_lookup(&root, id, &kws, &[]);
        assert_eq!(before, snapshot(&root), "a forensic lookup must not create, change or delete anything");
        assert_eq!(p.items.len(), 2, "{p:?}");
        assert!(p.items.iter().all(|i| i.kind == "archive" && i.source.starts_with("archive:arch-2026-11-19-01#")), "{p:?}");
        assert!(p.items[0].text.contains("8178") && p.items[0].text.chars().count() <= ARCHIVE_EXCERPT, "{}", p.items[0].text);
        assert!(!serde_json::to_string(&p).unwrap().contains("sk-ant-api03"), "excerpts are scrubbed");
        // Bad ids, traversal, a missing file: refused / noted, never an error.
        for bad in ["arch-2026-11-19", "../arch-2026-11-19-01", "arch-2026-11-19-01/../../x", "ARCH-2026-11-19-01", "arch-2026-1-19-01"] {
            let p = archive_lookup(&root, bad, &kws, &[]);
            assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("invalid archive id")), "{bad}: {p:?}");
        }
        let p = archive_lookup(&root, "arch-2026-11-19-02", &kws, &[]);
        assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("not found")), "{p:?}");
        let p = archive_lookup(&root.join("nope"), id, &kws, &[]);
        assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("root not found")), "{p:?}");
        // No keyword match -> a note, no items.
        let p = archive_lookup(&root, id, &keywords(&["kubernetes"], 4), &[]);
        assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("no record matches")), "{p:?}");
        // A corrupt gz is unreadable, not a panic.
        let bad_dir = root.join("2026").join("11");
        std::fs::write(bad_dir.join("arch-2026-11-19-03.jsonl.gz"), b"not gzip at all").unwrap();
        let p = archive_lookup(&root, "arch-2026-11-19-03", &kws, &[]);
        assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("unreadable")), "{p:?}");
    }

    #[test]
    fn archive_lookup_refuses_oversized_files() {
        let root = tmp("archbig");
        let dir = root.join("2026").join("11");
        std::fs::create_dir_all(&dir).unwrap();
        let f = std::fs::File::create(dir.join("arch-2026-11-19-04.jsonl.gz")).unwrap();
        f.set_len(ARCHIVE_GZ_MAX + 1).unwrap();
        drop(f);
        let p = archive_lookup(&root, "arch-2026-11-19-04", &["whisper".to_string()], &[]);
        assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("too large")), "{p:?}");
    }

    #[test]
    fn archive_lookup_refuses_a_junction_month_dir() {
        let root = tmp("archjunc");
        let outside = tmp("archjunc-out");
        write_archive(&outside, "arch-2026-11-19-01", &[("turn", "whisper port 8178")]);
        std::fs::create_dir_all(root.join("2026")).unwrap();
        let link = root.join("2026").join("11");
        let target = outside.join("2026").join("11");
        let made = if cfg!(windows) {
            std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&target).output().map(|o| o.status.success()).unwrap_or(false)
        } else {
            false
        };
        if !made {
            eprintln!("skipped: could not create a junction in the temp dir");
            return;
        }
        let p = archive_lookup(&root, "arch-2026-11-19-01", &["whisper".to_string()], &[]);
        assert!(p.items.is_empty() && p.skipped.iter().any(|s| s.contains("link")), "{p:?}");
    }

    #[test]
    fn cited_archive_ids_only_from_scroll_headers() {
        let mut p = Packet::default();
        p.push("s1", "scroll", "[scroll proj-agentic-os v3 · archives: arch-2026-11-18-01, arch-2026-11-19-02] # Agentic OS", &[]);
        p.push("n1", "internal", "a note citing arch-2026-11-17-09", &[]);
        let reply = "per arch-2026-11-19-02 and arch-2026-11-17-09 and arch-2026-11-18-01 and arch-2026-11-20-05";
        assert_eq!(cited_archive_ids(reply, &p, 2), vec!["arch-2026-11-19-02", "arch-2026-11-18-01"]);
        assert_eq!(cited_archive_ids(reply, &p, 1), vec!["arch-2026-11-19-02"]);
        assert!(cited_archive_ids("nothing cited", &p, 2).is_empty());
        assert!(cited_archive_ids("arch-2026-11-17-09", &p, 2).is_empty(), "an id outside a scroll header is never looked up");
    }

    /// Phase 3 smoke S3 (env-gated, run only with `--ignored --exact`): Librarian retrieval over
    /// the smoke's scratch scrolls / archive roots.
    #[test]
    #[ignore]
    fn smoke_scrolls_retrieval() {
        let (Ok(scrolls), Ok(archive)) = (std::env::var("SMOKE_SCROLLS_ROOT"), std::env::var("SMOKE_ARCHIVE_ROOT")) else {
            eprintln!("set SMOKE_SCROLLS_ROOT and SMOKE_ARCHIVE_ROOT");
            return;
        };
        let q = std::env::var("SMOKE_QUERY").unwrap_or_else(|_| "whisper port".into());
        let (scrolls, archive) = (PathBuf::from(scrolls), PathBuf::from(archive));
        let before = (snapshot(&scrolls), snapshot(&archive));
        let kws = keywords(&[&q], 8);
        let p = gather_local(&Sources { scrolls_root: Some(scrolls.clone()), archive_root: Some(archive.clone()), ..Default::default() }, &Query { task_id: None, keywords: &kws, slug: None }, &[]);
        println!("{}", serde_json::to_string_pretty(&p).unwrap());
        assert_eq!(p.items.first().map(|i| i.kind.as_str()), Some("scroll"));
        let ids = archive_ids_in(p.items[0].text.split(']').next().unwrap_or(""));
        assert!(!ids.is_empty(), "the scroll carries its source_archive_ids");
        let f = archive_lookup(&archive, &ids[0], &kws, &[]);
        println!("{}", serde_json::to_string_pretty(&f).unwrap());
        assert!(!f.items.is_empty(), "{f:?}");
        assert_eq!(before, (snapshot(&scrolls), snapshot(&archive)), "read-only");
    }
}
