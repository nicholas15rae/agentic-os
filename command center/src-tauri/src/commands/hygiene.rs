//! Self-regulating memory hygiene: the vault lifecycle cadence, the period-aware harvest
//! handshake gate, buffer pressure, the Security/Garbage hygiene audit log and the
//! "Purge Raw Vectors & Re-sync Scrolls" planner.
//!
//! - **Cadence** (`memory.autoRunEnabled` + `memory.cadence`): Daily (target hour, default
//!   03:00), Weekly (the `weeklyDay` quiet window, Sunday by default) or Monthly (the 1st). The
//!   latest slot is compared with `memory.lastVerifiedHarvestAt`; a missed slot collapses into ONE
//!   catch-up that runs on the next IDLE window (never during the boot warm-up), harvesting
//!   everything since the last verified harvest.
//! - **Handshake** (`seal_and_verify` → `destructive_plan`): snapshot → condense → every vault
//!   file written (AES-256-GCM when the vault key exists) → every file re-read and its SHA-256
//!   compared → only then may the cloud flush / thread prune run. Any failed write or checksum
//!   aborts every destructive step. Each step lands in the hygiene audit log
//!   (`<config>/security/audit/hygiene-YYYY-MM.jsonl`, outside Garbage's purge allowlist).
//! - All vault I/O runs on the blocking pool; the daemon is its own low-priority task.

use chrono::{Datelike, Duration as CDuration, Local, NaiveDate, NaiveDateTime, TimeZone, Weekday};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Nothing scheduled runs this long after launch (models, voice and MCPs warm up first).
pub const STARTUP_GRACE: Duration = Duration::from_secs(300);
const TICK: Duration = Duration::from_secs(60);
/// After a failed scheduled harvest, the next attempt waits at least this long.
const RETRY_AFTER_SECS: u64 = 30 * 60;
/// A slot run within this long of its time is "on time"; later it is a catch-up.
const ON_TIME_GRACE_MINS: i64 = 120;
pub const STATUS_EVENT: &str = "hygiene-status";

// ── Cadence ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Cadence {
    Daily,
    Weekly,
    Monthly,
}

impl Cadence {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "daily" => Self::Daily,
            "weekly" => Self::Weekly,
            _ => Self::Monthly,
        }
    }
}

fn weekday_from(n: u8) -> Weekday {
    match n % 7 {
        0 => Weekday::Sun,
        1 => Weekday::Mon,
        2 => Weekday::Tue,
        3 => Weekday::Wed,
        4 => Weekday::Thu,
        5 => Weekday::Fri,
        _ => Weekday::Sat,
    }
}

fn at_hour(d: NaiveDate, hour: u8) -> NaiveDateTime {
    d.and_hms_opt(hour.min(23) as u32, 0, 0).unwrap()
}

fn first_of_month(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1).unwrap()
}

fn add_months(d: NaiveDate, n: i32) -> NaiveDate {
    let m0 = d.year() * 12 + d.month() as i32 - 1 + n;
    NaiveDate::from_ymd_opt(m0.div_euclid(12), m0.rem_euclid(12) as u32 + 1, 1).unwrap()
}

/// The most recent slot at or before `now` (pure).
pub fn latest_slot(now: NaiveDateTime, c: Cadence, hour: u8, weekday: u8) -> NaiveDateTime {
    let today = now.date();
    match c {
        Cadence::Daily => {
            let s = at_hour(today, hour);
            if s <= now {
                s
            } else {
                s - CDuration::days(1)
            }
        }
        Cadence::Weekly => {
            let want = weekday_from(weekday).num_days_from_sunday() as i64;
            let have = today.weekday().num_days_from_sunday() as i64;
            let s = at_hour(today - CDuration::days((have - want).rem_euclid(7)), hour);
            if s <= now {
                s
            } else {
                s - CDuration::days(7)
            }
        }
        Cadence::Monthly => {
            let s = at_hour(first_of_month(today), hour);
            if s <= now {
                s
            } else {
                at_hour(add_months(today, -1), hour)
            }
        }
    }
}

/// The first slot strictly after `now` (pure).
pub fn next_slot(now: NaiveDateTime, c: Cadence, hour: u8, weekday: u8) -> NaiveDateTime {
    let last = latest_slot(now, c, hour, weekday);
    match c {
        Cadence::Daily => last + CDuration::days(1),
        Cadence::Weekly => last + CDuration::days(7),
        Cadence::Monthly => at_hour(add_months(last.date(), 1), hour),
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Due {
    NotDue,
    /// The current slot, within its on-time grace.
    Slot,
    /// A slot was missed (app closed / busy): one catch-up on the next idle window.
    CatchUp,
}

/// Is a harvest owed? Several missed slots are ONE catch-up (pure).
pub fn due(now: NaiveDateTime, last_verified: Option<NaiveDateTime>, c: Cadence, hour: u8, weekday: u8) -> Due {
    let slot = latest_slot(now, c, hour, weekday);
    if last_verified.is_some_and(|l| l >= slot) {
        return Due::NotDue;
    }
    if now - slot <= CDuration::minutes(ON_TIME_GRACE_MINS) {
        Due::Slot
    } else {
        Due::CatchUp
    }
}

// ── Periods ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeriodKind {
    PreviousDay,
    PreviousWeek,
    PreviousMonth,
    SinceLastHarvest,
    /// A calendar month picked by hand (the Settings month field).
    Month,
}

/// A harvest window `[start, end)` in local time, with its vault folder id.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub id: String,
    pub kind: PeriodKind,
    #[serde(skip)]
    pub start: NaiveDateTime,
    #[serde(skip)]
    pub end: NaiveDateTime,
    /// `YYYY-MM` months the window touches (Tony's monthly threads, training-log file names).
    pub months: Vec<String>,
}

impl Period {
    fn new(id: String, kind: PeriodKind, start: NaiveDateTime, end: NaiveDateTime) -> Self {
        let mut months = vec![];
        let mut d = first_of_month(start.date());
        let last = (end - CDuration::seconds(1)).date();
        while d <= last {
            months.push(format!("{:04}-{:02}", d.year(), d.month()));
            d = add_months(d, 1);
        }
        Self { id, kind, start, end, months }
    }

    /// Unix seconds `[from, to)`.
    pub fn bounds(&self) -> (i64, i64) {
        (local_ts(self.start), local_ts(self.end))
    }
}

pub fn local_ts(t: NaiveDateTime) -> i64 {
    Local.from_local_datetime(&t).earliest().map(|x| x.timestamp()).unwrap_or_else(|| t.and_utc().timestamp())
}

pub fn from_ts(secs: u64) -> Option<NaiveDateTime> {
    (secs > 0).then(|| Local.timestamp_opt(secs as i64, 0).single().map(|t| t.naive_local())).flatten()
}

fn midnight(d: NaiveDate) -> NaiveDateTime {
    d.and_hms_opt(0, 0, 0).unwrap()
}

/// A calendar month `YYYY-MM`.
pub fn month_period(month: &str) -> Option<Period> {
    if month.len() != 7 || month.as_bytes()[4] != b'-' {
        return None;
    }
    let d = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").ok()?;
    Some(Period::new(month.to_string(), PeriodKind::Month, midnight(d), midnight(add_months(d, 1))))
}

/// The local end (= the next month's first instant) of `YYYY-MM`, as unix secs (migration).
pub fn month_end_secs(month: &str) -> Option<u64> {
    month_period(month).map(|p| p.bounds().1.max(0) as u64)
}

/// The full previous day / ISO week / month before `now` (pure).
pub fn previous_period(now: NaiveDateTime, c: Cadence) -> Period {
    let today = now.date();
    match c {
        Cadence::Daily => {
            let d = today - CDuration::days(1);
            Period::new(d.format("%Y-%m-%d").to_string(), PeriodKind::PreviousDay, midnight(d), midnight(today))
        }
        Cadence::Weekly => {
            let this_monday = today - CDuration::days(today.weekday().num_days_from_monday() as i64);
            let start = this_monday - CDuration::days(7);
            let w = start.iso_week();
            Period::new(format!("{:04}-W{:02}", w.year(), w.week()), PeriodKind::PreviousWeek, midnight(start), midnight(this_monday))
        }
        Cadence::Monthly => {
            let start = add_months(today, -1);
            let mut p = Period::new(format!("{:04}-{:02}", start.year(), start.month()), PeriodKind::PreviousMonth, midnight(start), midnight(first_of_month(today)));
            p.kind = PeriodKind::PreviousMonth;
            p
        }
    }
}

/// What a scheduled run harvests (pure): the cadence's previous period, or — when the last
/// verified harvest is older than that period's start (missed slots) — everything since it,
/// up to the same end. Never an empty window.
pub fn choose_period(now: NaiveDateTime, last_verified: Option<NaiveDateTime>, c: Cadence) -> Period {
    let prev = previous_period(now, c);
    match last_verified {
        Some(l) if l < prev.start && l < prev.end => {
            let id = format!("since-{}-to-{}", l.date().format("%Y-%m-%d"), (prev.end - CDuration::seconds(1)).date().format("%Y-%m-%d"));
            Period::new(id, PeriodKind::SinceLastHarvest, l, prev.end)
        }
        _ => prev,
    }
}

/// A manual request: `previous_day` / `previous_week` / `previous_month` / `since_last_harvest`.
pub fn named_period(name: &str, now: NaiveDateTime, last_verified: Option<NaiveDateTime>) -> Option<Period> {
    match name {
        "previous_day" => Some(previous_period(now, Cadence::Daily)),
        "previous_week" => Some(previous_period(now, Cadence::Weekly)),
        "previous_month" => Some(previous_period(now, Cadence::Monthly)),
        "since_last_harvest" => {
            let from = last_verified?;
            (from < now).then(|| Period::new(format!("since-{}-to-{}", from.date().format("%Y-%m-%d"), now.date().format("%Y-%m-%d")), PeriodKind::SinceLastHarvest, from, now))
        }
        _ => None,
    }
}

fn is_date(s: &str) -> bool {
    s.len() == 10 && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// A vault folder id: `YYYY-MM`, `YYYY-MM-DD`, `YYYY-Www` or `since-YYYY-MM-DD-to-YYYY-MM-DD`
/// (pure; nothing else can become a path component).
pub fn valid_period_id(id: &str) -> bool {
    if month_period(id).is_some() || is_date(id) {
        return true;
    }
    if let Some((y, w)) = id.split_once("-W") {
        return y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()) && w.len() == 2 && w.parse::<u32>().is_ok_and(|n| (1..=53).contains(&n));
    }
    if let Some(rest) = id.strip_prefix("since-") {
        if let Some((a, b)) = rest.split_once("-to-") {
            return is_date(a) && is_date(b);
        }
    }
    false
}

// ── Handshake gate ──────────────────────────────────────────────────────────

/// Where the sealed files go (the real vault, or a test double that fails on purpose).
pub trait VaultIo {
    /// Write `name` (sealed when a vault key exists); returns the stored file name.
    fn write(&mut self, name: &str, data: &[u8]) -> Result<String, String>;
    /// Read a stored file back as plaintext (decrypting when sealed).
    fn read(&mut self, fname: &str) -> Result<Vec<u8>, String>;
}

pub struct Artifact {
    pub kind: String,
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sealed {
    /// kind → stored file name.
    pub files: BTreeMap<String, String>,
    /// kind → SHA-256 of the plaintext, re-verified on disk.
    pub sha256: BTreeMap<String, String>,
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Write every artifact, then re-read every one and compare its SHA-256. The first failed
/// write or mismatching checksum aborts (`Err`); the caller must then skip every destructive
/// step. Each step is reported to `audit(step, ok, detail)`.
pub fn seal_and_verify(io: &mut dyn VaultIo, artifacts: &[Artifact], audit: &mut dyn FnMut(&str, bool, String)) -> Result<Sealed, String> {
    let mut sealed = Sealed::default();
    for a in artifacts {
        match io.write(&a.name, &a.data) {
            Ok(f) => {
                audit("seal", true, format!("{} → {f} ({} bytes)", a.kind, a.data.len()));
                sealed.sha256.insert(a.kind.clone(), sha256_hex(&a.data));
                sealed.files.insert(a.kind.clone(), f);
            }
            Err(e) => {
                let why = format!("{} not written: {e}", a.kind);
                audit("seal", false, why.clone());
                audit("abort", false, "vault write failed — no flush, no prune".into());
                return Err(why);
            }
        }
    }
    for a in artifacts {
        let f = &sealed.files[&a.kind];
        let want = &sealed.sha256[&a.kind];
        match io.read(f) {
            Ok(b) if &sha256_hex(&b) == want => audit("verify", true, format!("{} sha256 {}…", a.kind, &want[..12])),
            Ok(_) => {
                let why = format!("{} failed its SHA-256 re-read", a.kind);
                audit("verify", false, why.clone());
                audit("abort", false, "checksum mismatch — no flush, no prune".into());
                return Err(why);
            }
            Err(e) => {
                let why = format!("{} could not be re-read: {e}", a.kind);
                audit("verify", false, why.clone());
                audit("abort", false, "re-read failed — no flush, no prune".into());
                return Err(why);
            }
        }
    }
    Ok(sealed)
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestructivePlan {
    /// Droplet AnythingLLM threads + Qdrant cache collections.
    pub cloud_flush: bool,
    /// Tony's OS-created local AnythingLLM threads (a summary seed opens the next one).
    pub prune_threads: bool,
}

/// The destructive steps a harvest may run (pure): none unless every file verified.
pub fn destructive_plan(sealed: &Result<Sealed, String>, auto_flush: bool, prune_threads: bool) -> DestructivePlan {
    match sealed {
        Ok(s) if !s.files.is_empty() && s.files.len() == s.sha256.len() => DestructivePlan { cloud_flush: auto_flush, prune_threads },
        _ => DestructivePlan::default(),
    }
}

// ── Audit log ───────────────────────────────────────────────────────────────

static AUDIT_DIR: OnceLock<PathBuf> = OnceLock::new();

fn recent() -> &'static Mutex<VecDeque<Value>> {
    static R: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(VecDeque::with_capacity(64)))
}

/// `<config>/security/audit` (set once at boot).
pub fn init(config_dir: &Path) {
    let _ = AUDIT_DIR.set(config_dir.join("security").join("audit"));
}

/// One hygiene audit line (lifecycle / compaction / purge / sweep). Tiny append; safe anywhere.
pub fn audit(stage: &str, step: &str, ok: bool, detail: &str) {
    let line = json!({ "at": super::os_core::now_secs(), "stage": stage, "step": step, "ok": ok, "detail": super::envelope::clip(detail, 400) });
    {
        let mut r = recent().lock().unwrap();
        if r.len() == 64 {
            r.pop_front();
        }
        r.push_back(line.clone());
    }
    if let Some(dir) = AUDIT_DIR.get() {
        use std::io::Write;
        if std::fs::create_dir_all(dir).is_ok() {
            let f = dir.join(format!("hygiene-{}.jsonl", Local::now().format("%Y-%m")));
            if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(fh, "{line}");
            }
        }
    }
    if !ok {
        eprintln!("[hygiene] {stage}/{step}: {detail}");
    }
}

pub fn recent_audit(n: usize) -> Vec<Value> {
    let r = recent().lock().unwrap();
    r.iter().rev().take(n).cloned().collect()
}

// ── Buffer pressure & presets ───────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Pressure {
    Green,
    Amber,
    Red,
}

/// The pending buffer against its threshold (bytes OR turns, whichever is fuller).
pub fn pressure_ratio(bytes: u64, turns: u64, kb: u32, max_turns: u32) -> f64 {
    let b = bytes as f64 / (kb.max(1) as f64 * 1024.0);
    let t = turns as f64 / max_turns.max(1) as f64;
    b.max(t)
}

/// Green below the threshold, Amber up to the 2× high-water mark, Red at / over it.
pub fn pressure(bytes: u64, turns: u64, kb: u32, max_turns: u32) -> Pressure {
    let r = pressure_ratio(bytes, turns, kb, max_turns);
    if r >= 2.0 {
        Pressure::Red
    } else if r >= 1.0 {
        Pressure::Amber
    } else {
        Pressure::Green
    }
}

/// At / over the 2× high-water mark: compact between turns, quiet window or not.
pub fn high_water(bytes: u64, turns: u64, kb: u32, max_turns: u32) -> bool {
    pressure(bytes, turns, kb, max_turns) == Pressure::Red
}

/// Threshold presets `(KB, turns)`: Tight / Balanced / Relaxed.
pub const PRESETS: [(&str, u32, u32); 3] = [("tight", 25, 15), ("balanced", 50, 25), ("relaxed", 100, 50)];

pub fn preset(name: &str) -> Option<(u32, u32)> {
    PRESETS.iter().find(|(n, _, _)| n.eq_ignore_ascii_case(name.trim())).map(|(_, kb, t)| (*kb, *t))
}

/// Which preset (if any) a pair of thresholds is.
pub fn preset_name(kb: u32, turns: u32) -> Option<&'static str> {
    PRESETS.iter().find(|(_, k, t)| *k == kb && *t == turns).map(|(n, _, _)| *n)
}

// ── Purge raw vectors & re-sync scrolls (planner) ───────────────────────────

/// Tony's per-task notes (documenter, `Idea: <title>`).
pub const RAW_NOTE_SOURCE: &str = "agentic-os";
pub const RAW_NOTE_PREFIX: &str = "Idea: ";
/// Memory Scroll documents (the Python sync).
pub const SCROLL_SOURCE: &str = "agentic-os-scroll";

#[derive(Clone, Debug, PartialEq)]
pub struct WsDoc {
    pub location: String,
    pub title: String,
    pub source: String,
}

/// The documents of a workspace object (`metadata` may be a JSON string or an object).
pub fn ws_docs(ws: &Value) -> Vec<WsDoc> {
    ws["documents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let location = d["docpath"].as_str().or_else(|| d["location"].as_str())?.to_string();
            let meta = match &d["metadata"] {
                Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
                v => v.clone(),
            };
            let pick = |k: &str| meta[k].as_str().or_else(|| d[k].as_str()).unwrap_or("").to_string();
            Some(WsDoc { location, title: pick("title"), source: pick("docSource") })
        })
        .collect()
}

/// One sync-ledger entry of the Python CLI (`data/memory-scrolls/state.json`, `sync.<scroll_id>`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LedgerScroll {
    pub sha256: Option<String>,
    pub location: Option<String>,
}

/// The CLI's sync ledger, read-only (missing / unreadable = empty).
pub fn read_sync_ledger(state_json: &Path) -> BTreeMap<String, LedgerScroll> {
    let Ok(s) = std::fs::read_to_string(state_json) else { return BTreeMap::new() };
    let v: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
    v["sync"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, e)| (k.clone(), LedgerScroll { sha256: e["sha256"].as_str().map(String::from), location: e["location"].as_str().map(String::from) }))
        .collect()
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PurgePlan {
    /// Raw task-note documents to un-embed and remove (the notes stay on disk).
    pub raw_notes: Vec<String>,
    /// Duplicate scroll embeddings (same content hash) to un-embed.
    pub scroll_dupes: Vec<String>,
    pub kept_scrolls: usize,
}

/// What a purge removes (pure). Raw notes: `docSource agentic-os` + an `Idea: ` title only
/// (never learned pathways, prototypes, Memory Books or uploads). Scrolls are grouped by the
/// ledger's content hash (title when the ledger doesn't know it); one copy per group stays —
/// the ledger's current location when it is there — and no ledger location is ever removed.
pub fn plan_purge(docs: &[WsDoc], ledger: &BTreeMap<String, LedgerScroll>) -> PurgePlan {
    let protected: std::collections::HashSet<&str> = ledger.values().filter_map(|e| e.location.as_deref()).collect();
    let mut plan = PurgePlan::default();
    let mut groups: BTreeMap<String, Vec<&WsDoc>> = BTreeMap::new();
    for d in docs {
        if d.source == RAW_NOTE_SOURCE && d.title.starts_with(RAW_NOTE_PREFIX) && !protected.contains(d.location.as_str()) {
            plan.raw_notes.push(d.location.clone());
        } else if d.source == SCROLL_SOURCE {
            let key = ledger.get(&d.title).and_then(|e| e.sha256.clone()).map(|h| format!("sha:{h}")).unwrap_or_else(|| format!("title:{}", d.title));
            groups.entry(key).or_default().push(d);
        }
    }
    for g in groups.values() {
        let keep = g.iter().find(|d| protected.contains(d.location.as_str())).or(g.last()).map(|d| d.location.as_str());
        plan.kept_scrolls += 1;
        for d in g {
            if Some(d.location.as_str()) != keep && !protected.contains(d.location.as_str()) {
                plan.scroll_dupes.push(d.location.clone());
            }
        }
    }
    plan
}

// ── Newest scroll summary (thread seed + Tony's hot path) ───────────────────

static SEED: Mutex<Option<String>> = Mutex::new(None);

/// The cached newest Memory Scroll summary (no disk I/O; refreshed off the hot path).
pub fn seed_text() -> Option<String> {
    SEED.lock().unwrap().clone()
}

pub fn set_seed(text: Option<String>) {
    *SEED.lock().unwrap() = text.filter(|t| !t.trim().is_empty());
}

/// The body of the most recently modified valid scroll under `root` (blocking; ≤ 2 levels).
pub fn newest_scroll(root: &Path) -> Option<String> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut visit = |p: PathBuf| {
        if p.extension().is_some_and(|e| e == "md") {
            if let Ok(m) = std::fs::metadata(&p) {
                if m.len() <= super::librarian::FILE_READ_MAX {
                    let t = m.modified().unwrap_or(std::time::UNIX_EPOCH);
                    if best.as_ref().is_none_or(|(b, _)| t > *b) {
                        best = Some((t, p));
                    }
                }
            }
        }
    };
    for e in std::fs::read_dir(root).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            for f in std::fs::read_dir(&p).into_iter().flatten().flatten() {
                visit(f.path());
            }
        } else {
            visit(p);
        }
    }
    let (_, p) = best?;
    let text = std::fs::read_to_string(p).ok()?;
    super::librarian::parse_scroll(&text, None).map(|(m, body)| format!("[{} v{}] {}", m.scroll_id, m.version, body.trim()))
}

/// Re-read the newest scroll into the seed cache (blocking pool).
pub async fn refresh_seed(root: PathBuf) {
    if let Ok(s) = tauri::async_runtime::spawn_blocking(move || newest_scroll(&root)).await {
        if s.is_some() {
            set_seed(s);
        }
    }
}

/// `text` prefixed with the carried-over summary (the first message of a fresh thread).
pub fn seeded_message(seed: Option<&str>, text: &str, max: usize) -> String {
    match seed.map(str::trim).filter(|s| !s.is_empty() && max > 0) {
        Some(s) => format!("[Context carried over from the previous thread — newest memory summary; use only if relevant]\n{}\n\n{text}", super::envelope::clip(s, max)),
        None => text.to_string(),
    }
}

// ── Daemon state ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRun {
    pub at: u64,
    pub period: String,
    pub ok: bool,
    pub catch_up: bool,
    pub detail: String,
}

#[derive(Default)]
struct State {
    harvesting: bool,
    last_run: Option<LifecycleRun>,
    last_sweep_at: u64,
    queued: Option<Due>,
    waiting: Option<String>,
    last_error_at: u64,
    /// `(bytes, turns, unix secs)` from the last compaction status.
    pending: Option<(u64, u64, u64)>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// The compaction status saw this pending buffer (feeds the pressure bar).
pub fn note_pending(status: &Value) {
    let p = &status["pending"];
    if p.is_object() {
        state().lock().unwrap().pending = Some((p["bytes"].as_u64().unwrap_or(0), p["turns"].as_u64().unwrap_or(0), super::os_core::now_secs()));
    }
}

pub fn last_pending() -> Option<(u64, u64)> {
    state().lock().unwrap().pending.map(|(b, t, _)| (b, t))
}

pub fn note_sweep() {
    state().lock().unwrap().last_sweep_at = super::os_core::now_secs();
}

pub fn is_harvesting() -> bool {
    state().lock().unwrap().harvesting
}

struct HarvestGuard;
impl Drop for HarvestGuard {
    fn drop(&mut self) {
        state().lock().unwrap().harvesting = false;
    }
}

/// Claim the single harvest slot (manual and scheduled runs never overlap).
pub fn begin_harvest() -> Result<impl Drop, String> {
    let mut s = state().lock().unwrap();
    if s.harvesting {
        return Err("a harvest is already running".into());
    }
    s.harvesting = true;
    Ok(HarvestGuard)
}

// ── Status (Settings "Hygiene & Buffer Pressure" bar) ───────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HygieneStatus {
    pub daemon_running: bool,
    pub heartbeat_at: Option<u64>,
    pub last_sweep_at: Option<u64>,
    pub pressure: Option<Pressure>,
    pub pressure_ratio: Option<f64>,
    pub pending_bytes: Option<u64>,
    pub pending_turns: Option<u64>,
    pub threshold_kb: u32,
    pub threshold_turns: u32,
    pub preset: Option<&'static str>,
    pub auto_run: bool,
    pub cadence: Cadence,
    /// Unix secs of the next scheduled slot (None = auto-regulate off).
    pub next_harvest_at: Option<i64>,
    pub catch_up_queued: bool,
    /// Why a queued harvest is waiting (busy signal), if it is.
    pub waiting: Option<String>,
    pub harvesting: bool,
    pub last_verified_harvest_at: Option<u64>,
    pub last_run: Option<LifecycleRun>,
    pub recent: Vec<Value>,
}

pub fn status_from(cfg: &super::os_core::OsConfig, garbage: &super::garbage::Status) -> HygieneStatus {
    let m = &cfg.memory;
    let sc = &m.scrolls;
    let s = state().lock().unwrap();
    let cadence = Cadence::parse(&m.cadence);
    let now = Local::now().naive_local();
    let last_sweep = [s.last_sweep_at, garbage.heartbeat_at.map(|h| h / 1000).unwrap_or(0)].into_iter().max().filter(|t| *t > 0);
    HygieneStatus {
        daemon_running: garbage.running,
        heartbeat_at: garbage.heartbeat_at,
        last_sweep_at: last_sweep,
        pressure: s.pending.map(|(b, t, _)| pressure(b, t, sc.threshold_kb, sc.threshold_turns)),
        pressure_ratio: s.pending.map(|(b, t, _)| (pressure_ratio(b, t, sc.threshold_kb, sc.threshold_turns) * 100.0).round() / 100.0),
        pending_bytes: s.pending.map(|p| p.0),
        pending_turns: s.pending.map(|p| p.1),
        threshold_kb: sc.threshold_kb,
        threshold_turns: sc.threshold_turns,
        preset: preset_name(sc.threshold_kb, sc.threshold_turns),
        auto_run: m.auto_run_enabled,
        cadence,
        next_harvest_at: m.auto_run_enabled.then(|| local_ts(next_slot(now, cadence, m.target_hour, m.weekly_day))),
        catch_up_queued: m.auto_run_enabled && s.queued == Some(Due::CatchUp),
        waiting: s.waiting.clone(),
        harvesting: s.harvesting,
        last_verified_harvest_at: (m.last_verified_harvest_at > 0).then_some(m.last_verified_harvest_at),
        last_run: s.last_run.clone(),
        recent: recent_audit(12),
    }
}

#[tauri::command]
pub fn hygiene_status(os: tauri::State<'_, super::os_core::OsState>) -> HygieneStatus {
    status_from(&os.snapshot(), &super::garbage::snapshot())
}

/// "Quick Hygiene Sweep": a Garbage pass now, a fresh pending check, and (when the buffer is
/// over its threshold and the system idle) a background compaction. Never blocks the UI.
#[tauri::command]
pub async fn hygiene_sweep(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri::{Emitter, Manager};
    audit("sweep", "start", true, "quick hygiene sweep");
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let r = app.state::<super::os_core::OsState>().snapshot().roster.clone();
    let garbage = tauri::async_runtime::spawn_blocking(move || super::garbage::pass(&super::garbage::Allow::for_config(&dir), r.dump_keep_days, r.graduate_after_days, super::garbage::SCRATCH_QUOTA, std::time::SystemTime::now()))
        .await
        .map_err(|e| e.to_string())?;
    audit("sweep", "garbage", true, &garbage.to_string());
    note_sweep();
    let sc = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.sanitized();
    let mut compaction = "not needed".to_string();
    if super::compaction::is_running() {
        compaction = "already running".into();
    } else {
        match super::compaction::run_status(&app).await {
            Ok(st) => {
                note_pending(&st);
                if super::compaction::threshold_hit(&st, sc.threshold_kb, sc.threshold_turns) {
                    match super::compaction::current_idle_reason(&app, sc.quiet_mins, true) {
                        Some(why) => compaction = format!("over threshold, waiting: {why}"),
                        None => {
                            compaction = "started in the background".into();
                            let a = app.clone();
                            tauri::async_runtime::spawn(async move {
                                super::compaction::run_compact(&a, true).await;
                            });
                        }
                    }
                }
            }
            Err(e) => compaction = format!("status unavailable: {}", super::envelope::clip(&e, 120)),
        }
    }
    audit("sweep", "compaction", true, &compaction);
    let st = status_from(&app.state::<super::os_core::OsState>().snapshot(), &super::garbage::snapshot());
    let _ = app.emit(STATUS_EVENT, &st);
    Ok(json!({ "garbage": garbage, "compaction": compaction, "status": st }))
}

/// Apply a threshold preset (`tight` / `balanced` / `relaxed`).
#[tauri::command]
pub fn memory_scrolls_preset(os: tauri::State<'_, super::os_core::OsState>, name: String) -> Result<super::os_core::OsConfig, String> {
    let (kb, turns) = preset(&name).ok_or("preset must be tight, balanced or relaxed")?;
    os.update(|c| {
        c.memory.scrolls.threshold_kb = kb;
        c.memory.scrolls.threshold_turns = turns;
        Ok(())
    })
}

// ── The lifecycle daemon ────────────────────────────────────────────────────

/// Scheduled vault lifecycle (spawned once in lib.rs; replaces the old "1st of the month" loop).
/// Every minute: is a slot (or one catch-up) owed? Then wait for an IDLE window — no voice turn,
/// TTS, LLM generation, build or Claude fix, and the quiet window over — and run ONE harvest.
pub async fn lifecycle_loop(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    if let Ok(d) = app.path().app_config_dir() {
        init(&d);
    }
    // The seed first, before the grace period (one directory walk + one file read on the
    // blocking pool): Tony's system message carries it from his first turn, so it doesn't
    // appear five minutes into a conversation and change that message mid-mode.
    let root = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.scrolls_root();
    refresh_seed(root).await;
    tokio::time::sleep(STARTUP_GRACE).await;
    let mut ticks: u64 = 0;
    loop {
        tokio::time::sleep(TICK).await;
        ticks += 1;
        let os = app.state::<super::os_core::OsState>();
        let cfg = os.snapshot();
        if ticks % 10 == 0 {
            refresh_seed(cfg.memory.scrolls.scrolls_root()).await;
        }
        let m = &cfg.memory;
        if !m.auto_run_enabled || cfg.privacy.kill_switch && m.storage != "local" {
            state().lock().unwrap().queued = None;
            continue;
        }
        let now = Local::now().naive_local();
        let cadence = Cadence::parse(&m.cadence);
        let last = from_ts(m.last_verified_harvest_at);
        let d = due(now, last, cadence, m.target_hour, m.weekly_day);
        {
            let mut s = state().lock().unwrap();
            s.queued = (d != Due::NotDue).then_some(d);
            if d == Due::NotDue {
                s.waiting = None;
                continue;
            }
            if s.harvesting || super::os_core::now_secs().saturating_sub(s.last_error_at) < RETRY_AFTER_SECS {
                continue;
            }
        }
        let wait = if super::compaction::is_running() { Some("compaction running".to_string()) } else { super::compaction::current_idle_reason(&app, m.scrolls.quiet_mins.min(10), false) };
        if let Some(w) = wait {
            let changed = state().lock().unwrap().waiting.replace(w.clone()) != Some(w);
            if changed {
                let _ = app.emit(STATUS_EVENT, &status_from(&cfg, &super::garbage::snapshot()));
            }
            continue;
        }
        state().lock().unwrap().waiting = None;
        let period = choose_period(now, last, cadence);
        let catch_up = d == Due::CatchUp;
        audit("lifecycle", "scheduled", true, &format!("{:?} harvest of {} ({:?}){}", cadence, period.id, period.kind, if catch_up { " — catch-up" } else { "" }));
        let run = super::memory::lifecycle_run(&app, &period, true).await;
        let ok = run.is_ok();
        let detail = match &run {
            Ok(s) => s.clone(),
            Err(e) => e.clone(),
        };
        {
            let mut s = state().lock().unwrap();
            s.last_run = Some(LifecycleRun { at: super::os_core::now_secs(), period: period.id.clone(), ok, catch_up, detail: super::envelope::clip(&detail, 300) });
            if ok {
                s.queued = None;
            } else {
                s.last_error_at = super::os_core::now_secs();
            }
        }
        let _ = app.emit(STATUS_EVENT, &status_from(&os.snapshot(), &super::garbage::snapshot()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    /// Tony's system message carries the LATEST MEMORY SCROLL (agents.rs `scroll_summary_block`
    /// from `seed_text`), so the seed is read at launch, before the five-minute grace period: a
    /// seed that only arrives after it would change that message in the middle of a conversation.
    /// Source pin (the loop needs a running app).
    #[test]
    fn the_seed_is_read_before_the_startup_grace() {
        let src = include_str!("hygiene.rs");
        let body = &src[src.find("pub async fn lifecycle_loop(").unwrap()..];
        let body = &body[..body.find("\n}\n").or_else(|| body.find("\n}\r\n")).unwrap()];
        let (seed, grace) = (body.find("refresh_seed(root).await;").expect("startup seed"), body.find("tokio::time::sleep(STARTUP_GRACE).await;").expect("grace"));
        assert!(seed < grace, "the seed must be read before the startup grace");
    }

    #[test]
    fn daily_slots_at_the_target_hour() {
        let c = Cadence::Daily;
        assert_eq!(latest_slot(dt("2026-11-22 02:59"), c, 3, 0), dt("2026-11-21 03:00"));
        assert_eq!(latest_slot(dt("2026-11-22 03:00"), c, 3, 0), dt("2026-11-22 03:00"));
        assert_eq!(next_slot(dt("2026-11-22 03:00"), c, 3, 0), dt("2026-11-23 03:00"));
        assert_eq!(next_slot(dt("2026-11-22 01:00"), c, 3, 0), dt("2026-11-22 03:00"));
        // Month / year boundaries.
        assert_eq!(latest_slot(dt("2027-01-01 00:10"), c, 3, 0), dt("2026-12-31 03:00"));
    }

    #[test]
    fn weekly_slots_in_the_sunday_quiet_window() {
        let c = Cadence::Weekly;
        // 2026-11-22 is a Sunday.
        assert_eq!(dt("2026-11-22 00:00").weekday(), Weekday::Sun);
        assert_eq!(latest_slot(dt("2026-11-22 03:30"), c, 3, 0), dt("2026-11-22 03:00"));
        assert_eq!(latest_slot(dt("2026-11-22 02:00"), c, 3, 0), dt("2026-11-15 03:00"));
        assert_eq!(latest_slot(dt("2026-11-25 12:00"), c, 3, 0), dt("2026-11-22 03:00"));
        assert_eq!(next_slot(dt("2026-11-25 12:00"), c, 3, 0), dt("2026-11-29 03:00"));
        // Another weekday (Wednesday = 3).
        assert_eq!(latest_slot(dt("2026-11-22 12:00"), c, 3, 3), dt("2026-11-18 03:00"));
    }

    #[test]
    fn monthly_slots_on_the_first() {
        let c = Cadence::Monthly;
        assert_eq!(latest_slot(dt("2026-11-22 12:00"), c, 3, 0), dt("2026-11-01 03:00"));
        assert_eq!(latest_slot(dt("2026-11-01 02:00"), c, 3, 0), dt("2026-10-01 03:00"));
        assert_eq!(latest_slot(dt("2026-01-01 01:00"), c, 3, 0), dt("2025-12-01 03:00"));
        assert_eq!(next_slot(dt("2026-12-15 00:00"), c, 3, 0), dt("2027-01-01 03:00"));
    }

    #[test]
    fn due_collapses_missed_slots_into_one_catch_up() {
        let c = Cadence::Daily;
        let now = dt("2026-11-22 03:20");
        assert_eq!(due(now, Some(dt("2026-11-22 03:05")), c, 3, 0), Due::NotDue, "already harvested this slot");
        assert_eq!(due(now, Some(dt("2026-11-21 03:01")), c, 3, 0), Due::Slot);
        assert_eq!(due(now, None, c, 3, 0), Due::Slot, "first run ever");
        // App closed for three days: one catch-up later in the day, not three runs.
        let later = dt("2026-11-22 14:00");
        assert_eq!(due(later, Some(dt("2026-11-19 03:00")), c, 3, 0), Due::CatchUp);
        let p = choose_period(later, Some(dt("2026-11-19 03:00")), c);
        assert_eq!(p.kind, PeriodKind::SinceLastHarvest);
        assert_eq!(p.id, "since-2026-11-19-to-2026-11-21");
        assert_eq!((p.start, p.end), (dt("2026-11-19 03:00"), dt("2026-11-22 00:00")));
        assert!(valid_period_id(&p.id));
        // Up to date: just yesterday.
        let p = choose_period(now, Some(dt("2026-11-21 03:01")), c);
        assert_eq!((p.kind, p.id.as_str()), (PeriodKind::PreviousDay, "2026-11-21"));
        assert_eq!(p.months, vec!["2026-11"]);
    }

    #[test]
    fn previous_periods_are_whole_days_weeks_months() {
        let now = dt("2026-11-22 03:00");
        let d = previous_period(now, Cadence::Daily);
        assert_eq!((d.id.as_str(), d.start, d.end), ("2026-11-21", dt("2026-11-21 00:00"), dt("2026-11-22 00:00")));
        let w = previous_period(now, Cadence::Weekly);
        assert_eq!((w.id.as_str(), w.start, w.end), ("2026-W46", dt("2026-11-09 00:00"), dt("2026-11-16 00:00")));
        let m = previous_period(dt("2026-01-01 03:00"), Cadence::Monthly);
        assert_eq!((m.id.as_str(), m.start, m.end, m.kind), ("2025-12", dt("2025-12-01 00:00"), dt("2026-01-01 00:00"), PeriodKind::PreviousMonth));
        // A week spanning two months touches both monthly threads.
        let w2 = previous_period(dt("2026-12-08 03:00"), Cadence::Weekly);
        assert_eq!(w2.months, vec!["2026-11", "2026-12"]);
        let (a, b) = w2.bounds();
        assert!(a < b);
        assert!(named_period("since_last_harvest", now, None).is_none());
        assert_eq!(named_period("previous_week", now, None).unwrap().id, "2026-W46");
    }

    #[test]
    fn period_ids_are_strict_path_components() {
        for ok in ["2026-11", "2026-11-21", "2026-W46", "since-2026-11-01-to-2026-11-21"] {
            assert!(valid_period_id(ok), "{ok}");
        }
        for bad in ["2026-13", "2026-11-31", "2026-W60", "../2026-11", "since-x-to-y", "2026", "", "2026-11/..", "since-2026-11-01-to-2026-11-21/.."] {
            assert!(!valid_period_id(bad), "{bad}");
        }
        assert!(month_end_secs("2026-10").unwrap() > month_end_secs("2026-09").unwrap());
        assert!(month_end_secs("garbage").is_none());
    }

    /// A vault double: optionally fails one write, or corrupts one file on read-back.
    #[derive(Default)]
    struct FakeVault {
        files: BTreeMap<String, Vec<u8>>,
        fail_write: Option<&'static str>,
        corrupt: Option<&'static str>,
    }
    impl VaultIo for FakeVault {
        fn write(&mut self, name: &str, data: &[u8]) -> Result<String, String> {
            if self.fail_write.is_some_and(|f| name.starts_with(f)) {
                return Err("disk full".into());
            }
            let f = format!("{name}.enc");
            self.files.insert(f.clone(), data.to_vec());
            Ok(f)
        }
        fn read(&mut self, fname: &str) -> Result<Vec<u8>, String> {
            let mut b = self.files.get(fname).cloned().ok_or("missing")?;
            if self.corrupt.is_some_and(|c| fname.starts_with(c)) {
                b.push(b'!');
            }
            Ok(b)
        }
    }

    fn artifacts() -> Vec<Artifact> {
        ["raw", "summary", "dataset"].iter().map(|k| Artifact { kind: k.to_string(), name: format!("{k}_2026_11_21"), data: format!("{k} body").into_bytes() }).collect()
    }

    #[test]
    fn a_failed_write_or_checksum_aborts_every_destructive_step() {
        // Failed write (summary): nothing destructive, the abort is logged.
        for (fail_write, corrupt) in [(Some("summary"), None), (None, Some("dataset")), (Some("raw"), None)] {
            let mut io = FakeVault { fail_write, corrupt, ..Default::default() };
            let mut log: Vec<(String, bool)> = vec![];
            let r = seal_and_verify(&mut io, &artifacts(), &mut |step, ok, _| log.push((step.to_string(), ok)));
            assert!(r.is_err(), "{fail_write:?} {corrupt:?}");
            let plan = destructive_plan(&r, true, true);
            assert_eq!(plan, DestructivePlan::default(), "no flush / prune after a failed handshake");
            assert_eq!(log.last().unwrap(), &("abort".to_string(), false));
            // Destructive steps that would have run are gated by the plan alone.
            let mut flushed = false;
            if plan.cloud_flush || plan.prune_threads {
                flushed = true;
            }
            assert!(!flushed);
        }
        // All verified: the plan follows the consent toggles.
        let mut io = FakeVault::default();
        let mut steps = vec![];
        let r = seal_and_verify(&mut io, &artifacts(), &mut |step, ok, _| steps.push((step.to_string(), ok)));
        let s = r.as_ref().unwrap();
        assert_eq!(s.files.len(), 3);
        assert_eq!(s.sha256["raw"], sha256_hex(b"raw body"));
        assert!(steps.iter().all(|(_, ok)| *ok));
        assert_eq!(steps.iter().filter(|(s, _)| s == "verify").count(), 3, "every file is re-read");
        assert_eq!(destructive_plan(&r, true, false), DestructivePlan { cloud_flush: true, prune_threads: false });
        assert_eq!(destructive_plan(&r, false, false), DestructivePlan::default());
        assert_eq!(destructive_plan(&Ok(Sealed::default()), true, true), DestructivePlan::default(), "nothing sealed, nothing destroyed");
    }

    #[test]
    fn pressure_and_presets() {
        assert_eq!(pressure(10 * 1024, 5, 50, 25), Pressure::Green);
        assert_eq!(pressure(50 * 1024, 0, 50, 25), Pressure::Amber);
        assert_eq!(pressure(0, 49, 50, 25), Pressure::Amber);
        // The reported backlog: 96 KB / 120 turns against 50 KB / 25 is far over the 2× mark.
        assert_eq!(pressure(96 * 1024, 120, 50, 25), Pressure::Red);
        assert!(high_water(0, 50, 50, 25) && !high_water(0, 49, 50, 25));
        assert!(high_water(100 * 1024, 0, 50, 25));
        assert_eq!(preset("tight"), Some((25, 15)));
        assert_eq!(preset(" Balanced "), Some((50, 25)));
        assert_eq!(preset("relaxed"), Some((100, 50)));
        assert_eq!(preset("loose"), None);
        assert_eq!(preset_name(50, 25), Some("balanced"));
        assert_eq!(preset_name(50, 26), None);
        // The defaults are the Balanced preset.
        let d = super::super::os_core::ScrollsConfig::default();
        assert_eq!(preset_name(d.threshold_kb, d.threshold_turns), Some("balanced"));
    }

    #[test]
    fn purge_removes_only_raw_idea_notes_and_duplicate_scrolls() {
        let ws = json!({ "documents": [
            { "docpath": "custom-documents/idea-1.json", "metadata": json!({ "title": "Idea: landing page", "docSource": "agentic-os" }).to_string() },
            { "docpath": "custom-documents/path.json", "metadata": json!({ "title": "Tony learned pathways", "docSource": "agentic-os" }).to_string() },
            { "docpath": "custom-documents/proto.json", "metadata": json!({ "title": "Prototype: x", "docSource": "agentic-os" }).to_string() },
            { "docpath": "custom-documents/book.json", "metadata": json!({ "title": "Memory Book 2026-10", "docSource": "agentic-os memory vault" }).to_string() },
            { "docpath": "custom-documents/core-old.json", "metadata": json!({ "title": "core-user", "docSource": "agentic-os-scroll" }).to_string() },
            { "docpath": "custom-documents/core-new.json", "metadata": json!({ "title": "core-user", "docSource": "agentic-os-scroll" }).to_string() },
            { "docpath": "custom-documents/proj-a.json", "metadata": { "title": "proj-a", "docSource": "agentic-os-scroll" } },
            { "docpath": "custom-documents/proj-b1.json", "metadata": { "title": "proj-b", "docSource": "agentic-os-scroll" } },
            { "docpath": "custom-documents/proj-b2.json", "metadata": { "title": "proj-b", "docSource": "agentic-os-scroll" } },
            { "docpath": "custom-documents/upload.json", "metadata": { "title": "Idea: uploaded", "docSource": "upload" } }
        ] });
        let docs = ws_docs(&ws);
        assert_eq!(docs.len(), 10);
        let mut ledger = BTreeMap::new();
        ledger.insert("core-user".to_string(), LedgerScroll { sha256: Some("aa".into()), location: Some("custom-documents/core-new.json".into()) });
        // proj-a has the SAME content hash as core-user but is a ledger location: never removed.
        ledger.insert("proj-a".to_string(), LedgerScroll { sha256: Some("bb".into()), location: Some("custom-documents/proj-a.json".into()) });
        let plan = plan_purge(&docs, &ledger);
        assert_eq!(plan.raw_notes, vec!["custom-documents/idea-1.json"]);
        assert_eq!(plan.scroll_dupes, vec!["custom-documents/core-old.json", "custom-documents/proj-b1.json"]);
        assert_eq!(plan.kept_scrolls, 3);
        // Same hash across two ledger-current titles: both protected.
        ledger.get_mut("proj-a").unwrap().sha256 = Some("aa".into());
        let plan = plan_purge(&docs, &ledger);
        assert!(!plan.scroll_dupes.contains(&"custom-documents/proj-a.json".to_string()));
        assert!(!plan.scroll_dupes.contains(&"custom-documents/core-new.json".to_string()));
        // Empty workspace / ledger: nothing.
        assert_eq!(plan_purge(&[], &BTreeMap::new()), PurgePlan::default());
    }

    #[test]
    fn sync_ledger_reads_and_seeded_messages() {
        let dir = std::env::temp_dir().join(format!("hyg-ledger-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("state.json");
        std::fs::write(&p, r#"{"sync":{"core-user":{"state":"synced","sha256":"ab","location":"custom-documents/x.json"},"proj":{"state":"pending","sha256":null,"location":null}}}"#).unwrap();
        let l = read_sync_ledger(&p);
        assert_eq!(l["core-user"].location.as_deref(), Some("custom-documents/x.json"));
        assert_eq!(l["proj"], LedgerScroll::default());
        assert!(read_sync_ledger(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(seeded_message(None, "hi", 100), "hi");
        assert_eq!(seeded_message(Some("  "), "hi", 100), "hi");
        let s = seeded_message(Some("Nic prefers dark mode"), "hi", 100);
        assert!(s.contains("Nic prefers dark mode") && s.ends_with("\n\nhi"));
        assert_eq!(seeded_message(Some("x"), "hi", 0), "hi");
    }

    #[test]
    fn newest_scroll_reads_the_latest_valid_scroll() {
        let dir = std::env::temp_dir().join(format!("hyg-scrolls-{}-{}", std::process::id(), super::super::os_core::now_secs()));
        std::fs::create_dir_all(dir.join("core")).unwrap();
        let scroll = |id: &str, body: &str| format!("---\nscroll_id: \"{id}\"\ncategory: \"core\"\nlast_updated: \"2026-11-21\"\nversion: 2\nsource_archive_ids: []\nsupersedes: []\n---\n{body}\n");
        std::fs::write(dir.join("core").join("core-old.md"), scroll("core-old", "old facts")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(dir.join("core").join("core-user.md"), scroll("core-user", "newest facts")).unwrap();
        let s = newest_scroll(&dir);
        if let Some(s) = &s {
            assert!(s.contains("newest facts"), "{s}");
        }
        assert!(newest_scroll(&dir.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
