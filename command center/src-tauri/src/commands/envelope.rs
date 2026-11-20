//! TaskEnvelope store: the durable source of truth for the sequential agent worker.
//!
//! A Rust-owned SQLite file, `<app config dir>/tasks.db` (`%APPDATA%\os.agentic.commandcenter`),
//! separate from `devqueue.db` so the two migration ladders never interlock. It follows the
//! `devqueue.rs` pattern: a `PRAGMA user_version` ladder, WAL, `busy_timeout 3000`, a lazily
//! reopened `Mutex<Option<Connection>>` and `in_memory()` for tests.
//!
//! Every stage change is ONE immediate transaction that checks the expected `(status, stage)`
//! (optimistic: a stale expectation writes nothing), writes the stage output and appends a
//! `handoff_log` row. `handoff_log` is append-only (UPDATE / DELETE abort in SQLite triggers).
//! Task events on the agent bus are derived from the committed row only (`TaskStore` methods).
//!
//! Collective memory: this file is also what the Librarian reads (through `open_read_only`,
//! a `query_only` connection) — compact structured rows with capped text fields, never raw logs.
//! Every string stored here is scrubbed of secrets first.
#![cfg_attr(not(test), allow(dead_code))] // most of the API is driven by the sequential worker (Part 5)

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use super::devqueue::{scrub, scrub_known, scrub_value};

// ── Vocabulary ──────────────────────────────────────────────────────────────

pub const STATUSES: [&str; 6] = ["queued", "prompting", "designing", "coding", "review_ready", "failed"];
pub const TERMINAL: [&str; 2] = ["review_ready", "failed"];
pub const IN_FLIGHT: [&str; 3] = ["prompting", "designing", "coding"];
/// Stage order of the upgraded loop (tf-decisions addendum): Prompter triage → Librarian
/// pre-flight → Prompter enriched spec → Designer → Prompter merge → Coder → deterministic
/// gate (+ Prompter evaluation) → Librarian audit → Prompter verify → done.
pub const STAGES: [&str; 10] = ["triage", "preflight", "spec", "design", "merge", "code", "evaluate", "audit", "verify", "done"];
// The agent REGISTRY (data, not schema): the database only pattern-checks agent ids
// (`^[a-z][a-z0-9_-]{0,31}$`, see `agent_id_check`), so a future read-only node (Security
// Patrol, Finance) is one entry here, never a table-rebuild migration.
/// `current_owner`: who holds the task. The Librarian is a read-only gateway and never owns one.
pub const OWNERS: [&str; 5] = ["tony", "prompter", "designer", "coder", "staging"];
/// `from_agent` / `to_agent` of a handoff row (owners plus the non-owning participants).
pub const AGENTS: [&str; 8] = ["tony", "prompter", "librarian", "designer", "coder", "staging", "verifier", "system"];
pub const SEVERITIES: [&str; 4] = ["critical", "milestone", "handoff", "verbose"];
pub const EVENT_TYPES: [&str; 13] = [
    "task_queued", "stage_started", "stage_completed", "handoff", "loop_iteration", "review_ready", "failed", "discrepancy", "tool_call", "progress", "interrupted", "retry", "note",
];
pub const SOURCES: [&str; 5] = ["voice", "typed", "phone", "playplace", "ledger"];
pub const OPTION_KEYS: [&str; 5] = ["localOnly", "noIngest", "noVerify", "noMirror", "autoDispatched"];

/// Hard breaker for Designer/Coder loops. Code owns iteration_count, never a model.
pub const MAX_LOOP_ITERATIONS: u32 = 3;

pub const JSON_MAX: usize = 64 * 1024;
pub const RAW_INTENT_MAX: usize = 8000;
pub const TITLE_MAX: usize = 120;
pub const SHORT_SUMMARY_MAX: usize = 140;
pub const VOICE_SUMMARY_MAX: usize = 240;
pub const SUMMARY_PAYLOAD_MAX: usize = 4096;
pub const ERROR_MAX: usize = 500;
const REF_MAX: usize = 8192;
const ID_MAX: usize = 80;
/// Past this many rows a task keeps logging only critical / milestone rows (compact store).
pub const LOG_ROWS_PER_TASK_MAX: i64 = 400;
/// Mirror snapshot cap (the gateway's `task_mirror` limit).
pub const MIRROR_MAX: usize = 16 * 1024;

/// Canonical `(status, current_owner)` for a stage, so callers don't hand-pair them.
pub fn stage_defaults(stage: &str) -> Option<(&'static str, &'static str)> {
    Some(match stage {
        // The Librarian works FOR the Prompter during pre-flight; ownership stays with the Prompter.
        "triage" | "preflight" | "spec" | "merge" | "verify" => ("prompting", "prompter"),
        "design" => ("designing", "designer"),
        // The audit reads the Coder's output; the Coder keeps the task until the Prompter verifies.
        "code" | "evaluate" | "audit" => ("coding", "coder"),
        "done" => ("review_ready", "staging"),
        _ => return None,
    })
}

fn in_list(v: &str, list: &[&str]) -> bool {
    list.contains(&v)
}

fn one_of(field: &str, v: &str, allowed: &[&str]) -> Result<(), String> {
    if in_list(v, allowed) {
        Ok(())
    } else {
        Err(format!("{field} must be one of: {}", allowed.join(", ")))
    }
}

/// An agent-id field: a valid id (`roles::valid_agent_id`) that the registry lists.
fn agent_field(field: &str, v: &str, registry: &[&str]) -> Result<(), String> {
    if !super::roles::valid_agent_id(v) {
        return Err(format!("{field} must be an agent id (^[a-z][a-z0-9_-]{{0,31}}$)"));
    }
    one_of(field, v, registry)
}

/// The SQL CHECK for an agent-id column: the id PATTERN only (never a closed role list).
pub(crate) fn agent_id_check(c: &str) -> String {
    format!("length({c}) BETWEEN 1 AND 32 AND {c} GLOB '[a-z]*' AND {c} NOT GLOB '*[^a-z0-9_-]*'")
}

fn sql_list(list: &[&str]) -> String {
    list.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",")
}

// ── Schema ──────────────────────────────────────────────────────────────────

/// `PRAGMA user_version` ladder: entry `i` takes the schema from version `i` to `i + 1`.
/// Append new steps; never edit a shipped one.
fn migrations() -> &'static [String] {
    static M: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    M.get_or_init(|| {
        let json_col = |c: &str| format!("{c} TEXT CHECK ({c} IS NULL OR length({c}) <= {JSON_MAX})");
        vec![format!(
            "CREATE TABLE task_envelope (
               task_id          TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 1 AND {ID_MAX}),
               created_at       INTEGER NOT NULL,
               updated_at       INTEGER NOT NULL,
               status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ({statuses})),
               stage            TEXT CHECK (stage IS NULL OR stage IN ({stages})),
               current_owner    TEXT NOT NULL DEFAULT 'tony' CHECK ({owner_check}),
               raw_intent       TEXT NOT NULL CHECK (length(raw_intent) BETWEEN 1 AND {RAW_INTENT_MAX}),
               raw_intent_at    INTEGER NOT NULL,
               raw_intent_ref   TEXT NOT NULL DEFAULT '{{}}' CHECK (length(raw_intent_ref) <= {REF_MAX}),
               title            TEXT NOT NULL DEFAULT '' CHECK (length(title) <= {TITLE_MAX}),
               project_slug     TEXT CHECK (project_slug IS NULL OR length(project_slug) <= 64),
               iteration_count  INTEGER NOT NULL DEFAULT 0 CHECK (iteration_count >= 0),
               max_iterations   INTEGER NOT NULL DEFAULT 3 CHECK (max_iterations BETWEEN 1 AND 10),
               {prompt_spec},
               {design_artifacts},
               {coder_brief},
               {code_artifacts},
               {librarian_notes},
               {last_eval},
               voice_summaries  TEXT NOT NULL DEFAULT '{{}}' CHECK (length(voice_summaries) <= {REF_MAX}),
               idea_id          TEXT,
               card_id          TEXT,
               dedupe_key       TEXT UNIQUE,
               options          TEXT NOT NULL DEFAULT '{{}}' CHECK (length(options) <= 1024),
               lease_until      INTEGER,
               error            TEXT CHECK (error IS NULL OR length(error) <= {ERROR_MAX}),
               CHECK (iteration_count <= max_iterations)
             );
             CREATE INDEX te_open ON task_envelope(status, updated_at);
             CREATE UNIQUE INDEX te_idea_open ON task_envelope(idea_id)
               WHERE idea_id IS NOT NULL AND status NOT IN ('review_ready','failed');
             CREATE TABLE handoff_log (
               seq              INTEGER PRIMARY KEY AUTOINCREMENT,
               task_id          TEXT NOT NULL REFERENCES task_envelope(task_id),
               timestamp        INTEGER NOT NULL,
               from_agent       TEXT NOT NULL CHECK ({from_check}),
               to_agent         TEXT NOT NULL CHECK ({to_check}),
               event_type       TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 40),
               severity         TEXT NOT NULL CHECK (severity IN ({severities})),
               short_summary    TEXT NOT NULL CHECK (length(short_summary) <= {SHORT_SUMMARY_MAX}),
               voice_summary    TEXT CHECK (voice_summary IS NULL OR length(voice_summary) <= {VOICE_SUMMARY_MAX}),
               summary_payload  TEXT NOT NULL DEFAULT '{{}}' CHECK (length(summary_payload) <= {SUMMARY_PAYLOAD_MAX}),
               detail_ref       TEXT CHECK (detail_ref IS NULL OR length(detail_ref) <= 512),
               stage            TEXT,
               iteration        INTEGER
             );
             CREATE INDEX hl_task ON handoff_log(task_id, seq);
             CREATE INDEX hl_voice ON handoff_log(from_agent, seq) WHERE voice_summary IS NOT NULL;
             CREATE TRIGGER handoff_log_no_update BEFORE UPDATE ON handoff_log
               BEGIN SELECT RAISE(ABORT, 'handoff_log is append-only'); END;
             CREATE TRIGGER handoff_log_no_delete BEFORE DELETE ON handoff_log
               BEGIN SELECT RAISE(ABORT, 'handoff_log is append-only'); END;
             CREATE TABLE allm_thread (
               base             TEXT NOT NULL,
               workspace_slug   TEXT NOT NULL,
               key              TEXT NOT NULL,
               thread_slug      TEXT NOT NULL,
               created_at       INTEGER NOT NULL,
               PRIMARY KEY (base, workspace_slug, key)
             );
             CREATE TABLE envelope_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            statuses = sql_list(&STATUSES),
            stages = sql_list(&STAGES),
            owner_check = agent_id_check("current_owner"),
            from_check = agent_id_check("from_agent"),
            to_check = agent_id_check("to_agent"),
            severities = sql_list(&SEVERITIES),
            prompt_spec = json_col("prompt_spec"),
            design_artifacts = json_col("design_artifacts"),
            coder_brief = json_col("coder_brief"),
            code_artifacts = json_col("code_artifacts"),
            librarian_notes = json_col("librarian_notes"),
            last_eval = json_col("last_eval"),
        )]
    })
}

fn sql_err(e: rusqlite::Error) -> String {
    format!("task store: {e}")
}

/// Bring `conn` up to the latest schema. Returns the resulting version. A database written
/// by a newer app is refused (never downgraded).
pub(crate) fn migrate(conn: &mut Connection) -> Result<u32, String> {
    let steps = migrations();
    let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(sql_err)?;
    if v as usize > steps.len() {
        return Err(format!("task store: tasks.db is schema v{v}, newer than this app (v{})", steps.len()));
    }
    for (i, step) in steps.iter().enumerate().skip(v as usize) {
        let tx = conn.transaction().map_err(sql_err)?;
        tx.execute_batch(step).map_err(sql_err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
    }
    Ok(steps.len() as u32)
}

pub(crate) fn open_db(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(sql_err)?;
    conn.busy_timeout(Duration::from_millis(3000)).map_err(sql_err)?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql_err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON").map_err(sql_err)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// A read-only connection (SQLite READ_ONLY open + `query_only`): the Librarian's only way in.
pub(crate) fn open_read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(sql_err)?;
    conn.busy_timeout(Duration::from_millis(3000)).map_err(sql_err)?;
    conn.execute_batch("PRAGMA query_only = ON").map_err(sql_err)?;
    Ok(conn)
}

// ── Rows ────────────────────────────────────────────────────────────────────

/// The user's original request: text, when it was said, and where it is remembered
/// (`{source, thread, turnIds[], ideaId, memoryDoc}`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RawIntent {
    pub text: String,
    pub timestamp: i64,
    pub memory_reference: Value,
}

/// One append-only handoff entry. Spec names: `timestamp, from_agent, to_agent, summary_payload`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HandoffEntry {
    pub seq: i64,
    pub task_id: String,
    pub timestamp: i64,
    pub from_agent: String,
    pub to_agent: String,
    pub event_type: String,
    pub severity: String,
    pub short_summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_summary: Option<String>,
    pub summary_payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<String>,
    pub stage: Option<String>,
    pub iteration: Option<u32>,
}

/// The TaskEnvelope. Field names are the spec's, verbatim (snake_case on the wire too).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Envelope {
    pub task_id: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
    pub status: String,
    pub stage: Option<String>,
    pub current_owner: String,
    pub raw_intent: RawIntent,
    pub title: String,
    pub project_slug: Option<String>,
    pub iteration_count: u32,
    pub max_iterations: u32,
    pub prompt_spec: Value,
    pub design_artifacts: Value,
    pub coder_brief: Value,
    /// `[{path, sha256, bytes, iteration}]` — the files stay on disk in staging.
    pub code_artifacts: Value,
    pub librarian_notes: Value,
    pub last_eval: Value,
    /// Latest validated `voice_summary` per agent: `{agent: {text, at, stage}}`.
    pub voice_summaries: Value,
    pub idea_id: Option<String>,
    pub card_id: Option<String>,
    pub dedupe_key: Option<String>,
    pub options: Value,
    pub lease_until: Option<i64>,
    pub error: Option<String>,
    pub handoff_log: Vec<HandoffEntry>,
}

const COLS: &str = "task_id, created_at, updated_at, status, stage, current_owner, raw_intent, raw_intent_at, raw_intent_ref, title, project_slug, iteration_count, max_iterations, prompt_spec, design_artifacts, coder_brief, code_artifacts, librarian_notes, last_eval, voice_summaries, idea_id, card_id, dedupe_key, options, lease_until, error";

fn json_or(s: Option<String>, dflt: Value) -> Value {
    s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(dflt)
}

fn row_env(r: &Row) -> rusqlite::Result<Envelope> {
    Ok(Envelope {
        task_id: r.get(0)?,
        created_at: r.get(1)?,
        updated_at: r.get(2)?,
        status: r.get(3)?,
        stage: r.get(4)?,
        current_owner: r.get(5)?,
        raw_intent: RawIntent { text: r.get(6)?, timestamp: r.get(7)?, memory_reference: json_or(r.get(8)?, json!({})) },
        title: r.get(9)?,
        project_slug: r.get(10)?,
        iteration_count: r.get::<_, i64>(11)?.max(0) as u32,
        max_iterations: r.get::<_, i64>(12)?.max(1) as u32,
        prompt_spec: json_or(r.get(13)?, Value::Null),
        design_artifacts: json_or(r.get(14)?, Value::Null),
        coder_brief: json_or(r.get(15)?, Value::Null),
        code_artifacts: json_or(r.get(16)?, json!([])),
        librarian_notes: json_or(r.get(17)?, Value::Null),
        last_eval: json_or(r.get(18)?, Value::Null),
        voice_summaries: json_or(r.get(19)?, json!({})),
        idea_id: r.get(20)?,
        card_id: r.get(21)?,
        dedupe_key: r.get(22)?,
        options: json_or(r.get(23)?, json!({})),
        lease_until: r.get(24)?,
        error: r.get(25)?,
        handoff_log: vec![],
    })
}

const LOG_COLS: &str = "seq, task_id, timestamp, from_agent, to_agent, event_type, severity, short_summary, voice_summary, summary_payload, detail_ref, stage, iteration";

fn row_entry(r: &Row) -> rusqlite::Result<HandoffEntry> {
    Ok(HandoffEntry {
        seq: r.get(0)?,
        task_id: r.get(1)?,
        timestamp: r.get(2)?,
        from_agent: r.get(3)?,
        to_agent: r.get(4)?,
        event_type: r.get(5)?,
        severity: r.get(6)?,
        short_summary: r.get(7)?,
        voice_summary: r.get(8)?,
        summary_payload: json_or(r.get(9)?, json!({})),
        detail_ref: r.get(10)?,
        stage: r.get(11)?,
        iteration: r.get::<_, Option<i64>>(12)?.map(|i| i.max(0) as u32),
    })
}

pub(crate) fn now_ms() -> i64 {
    super::devqueue::now_ms()
}

/// `t-<unix_ms>-<rand6>`.
pub fn new_task_id(now: i64) -> String {
    use aes_gcm::aead::rand_core::RngCore;
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut b = [0u8; 6];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    let r: String = b.iter().map(|x| ALPHA[(*x as usize) % ALPHA.len()] as char).collect();
    format!("t-{now}-{r}")
}

// ── Text hygiene ────────────────────────────────────────────────────────────

/// Clip to `max` chars; a cut ends in "…" (counted in `max`).
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    // Prefer a word boundary if one is reasonably close.
    if let Some(i) = out.rfind(' ') {
        if out[..i].chars().count() * 4 >= max * 3 {
            out.truncate(i);
        }
    }
    format!("{}…", out.trim_end())
}

/// One line: control chars dropped, whitespace collapsed.
pub fn one_line(s: &str) -> String {
    s.split_whitespace().map(|w| w.chars().filter(|c| !c.is_control()).collect::<String>()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// A model's `voice_summary`, validated for speaking: code blocks and markdown removed, one
/// line, scrubbed, clipped to `VOICE_SUMMARY_MAX`. `None` when nothing speakable is left
/// (empty, or a JSON / HTML blob instead of a sentence).
pub fn clean_voice_summary(raw: &str, known: &[String]) -> Option<String> {
    let mut s = raw.to_string();
    // Drop fenced blocks entirely.
    while let Some(a) = s.find("```") {
        let rest = &s[a + 3..];
        let end = rest.find("```").map(|b| a + 3 + b + 3).unwrap_or(s.len());
        s.replace_range(a..end, " ");
    }
    let s: String = s.chars().filter(|c| !matches!(c, '`' | '*' | '#' | '_' | '>' | '<' | '{' | '}' | '[' | ']' | '|')).collect();
    let s = one_line(&s);
    let t = s.trim_start();
    if t.chars().filter(|c| c.is_alphabetic()).count() < 3 || raw.trim_start().starts_with('{') || raw.trim_start().starts_with('<') {
        return None;
    }
    let s = one_line(&scrub(t, known));
    (!s.is_empty()).then(|| clip(&s, VOICE_SUMMARY_MAX))
}

fn clean_short(s: &str, known: &[String]) -> String {
    clip(&one_line(&scrub(&one_line(s), known)), SHORT_SUMMARY_MAX)
}

fn json_text(field: &str, v: &Value, known: &[String], max: usize) -> Result<String, String> {
    let s = serde_json::to_string(&scrub_value(v, known)).map_err(|e| e.to_string())?;
    if s.len() > max {
        return Err(format!("{field} is {} bytes, over the {} KB cap (keep artifacts on disk)", s.len(), max / 1024));
    }
    Ok(s)
}

fn clean_options(v: &Value) -> Value {
    let mut m = Map::new();
    if let Some(o) = v.as_object() {
        for k in OPTION_KEYS {
            if let Some(b) = o.get(k).and_then(Value::as_bool) {
                m.insert(k.into(), json!(b));
            }
        }
    }
    Value::Object(m)
}

fn clean_id(field: &str, v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.is_empty() || v.len() > ID_MAX || !v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c)) {
        return Err(format!("{field}: 1–{ID_MAX} letters, digits, - _ . :"));
    }
    Ok(v.to_string())
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/// A handoff row to append (validated and scrubbed on write; `stage`/`iteration` are taken
/// from the envelope as committed).
#[derive(Clone, Debug)]
pub struct HandoffRow {
    pub from_agent: String,
    pub to_agent: String,
    pub event_type: String,
    pub severity: String,
    pub short_summary: String,
    pub voice_summary: Option<String>,
    pub summary_payload: Value,
    pub detail_ref: Option<String>,
}

impl HandoffRow {
    pub fn new(from: &str, to: &str, event_type: &str, severity: &str, short_summary: impl Into<String>) -> Self {
        Self {
            from_agent: from.into(),
            to_agent: to.into(),
            event_type: event_type.into(),
            severity: severity.into(),
            short_summary: short_summary.into(),
            voice_summary: None,
            summary_payload: json!({}),
            detail_ref: None,
        }
    }
    /// The model's raw voice summary; validated (and dropped if unusable) on write.
    pub fn voice(mut self, raw: Option<&str>) -> Self {
        self.voice_summary = raw.map(str::to_string);
        self
    }
    pub fn payload(mut self, v: Value) -> Self {
        self.summary_payload = v;
        self
    }
    pub fn detail(mut self, r: impl Into<String>) -> Self {
        self.detail_ref = Some(r.into());
        self
    }

    fn validated(&self, known: &[String]) -> Result<HandoffRow, String> {
        agent_field("from_agent", &self.from_agent, &AGENTS)?;
        agent_field("to_agent", &self.to_agent, &AGENTS)?;
        one_of("event_type", &self.event_type, &EVENT_TYPES)?;
        one_of("severity", &self.severity, &SEVERITIES)?;
        let short = clean_short(&self.short_summary, known);
        if short.is_empty() {
            return Err("short_summary is empty".into());
        }
        let payload = {
            let s = serde_json::to_string(&scrub_value(&self.summary_payload, known)).map_err(|e| e.to_string())?;
            if s.len() > SUMMARY_PAYLOAD_MAX {
                json!({ "truncated": true, "bytes": s.len() })
            } else {
                serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
            }
        };
        Ok(HandoffRow {
            from_agent: self.from_agent.clone(),
            to_agent: self.to_agent.clone(),
            event_type: self.event_type.clone(),
            severity: self.severity.clone(),
            short_summary: short,
            voice_summary: self.voice_summary.as_deref().and_then(|v| clean_voice_summary(v, known)),
            summary_payload: payload,
            detail_ref: self.detail_ref.as_deref().map(|d| clip(&one_line(&scrub(d, known)), 512)),
        })
    }
}

/// What a new task carries. `max_iterations` is clamped to 1..=MAX_LOOP_ITERATIONS.
#[derive(Clone, Debug, Default)]
pub struct NewEnvelope {
    pub raw_intent: String,
    /// When the request was made (unix ms); defaults to now.
    pub raw_intent_at: Option<i64>,
    /// voice | typed | phone | playplace | ledger
    pub source: String,
    pub thread: Option<String>,
    pub turn_ids: Vec<String>,
    pub idea_id: Option<String>,
    pub title: Option<String>,
    pub project_slug: Option<String>,
    /// e.g. the phone `os_queue` id: the same key twice returns the same task.
    pub dedupe_key: Option<String>,
    pub options: Value,
    pub max_iterations: Option<u32>,
}

/// Fields a transition may set besides status/stage/owner. `None` = leave as is.
#[derive(Clone, Debug, Default)]
pub struct Patch {
    pub title: Option<String>,
    pub project_slug: Option<String>,
    pub prompt_spec: Option<Value>,
    pub design_artifacts: Option<Value>,
    pub coder_brief: Option<Value>,
    pub code_artifacts: Option<Value>,
    pub librarian_notes: Option<Value>,
    pub last_eval: Option<Value>,
    pub card_id: Option<String>,
    /// `Some(None)` clears the error.
    pub error: Option<Option<String>>,
    /// `Some(None)` clears the lease. Terminal statuses always clear it.
    pub lease_until: Option<Option<i64>>,
    /// Keys merged into `raw_intent.memory_reference` (e.g. `memoryDoc`).
    pub memory_reference: Option<Map<String, Value>>,
}

#[derive(Clone, Copy, Debug)]
pub struct Expect<'a> {
    pub status: &'a str,
    pub stage: Option<&'a str>,
    /// The claim token. `Some(l)`: the row must still hold lease `l` (the value the stage claim
    /// wrote), so a cancel + retry (or a re-claim) since then makes an in-flight result stale even
    /// though `(status, stage)` match again. `None`: not checked.
    pub lease: Option<i64>,
}

#[derive(Clone, Copy, Debug)]
pub struct Next<'a> {
    pub status: &'a str,
    pub stage: Option<&'a str>,
    pub owner: &'a str,
}

impl<'a> Next<'a> {
    /// The canonical status/owner for `stage` (see `stage_defaults`).
    pub fn stage(stage: &'a str) -> Result<Next<'a>, String> {
        let (status, owner) = stage_defaults(stage).ok_or_else(|| format!("unknown stage {stage}"))?;
        Ok(Next { status, stage: Some(stage), owner })
    }
}

#[derive(Debug)]
pub enum Bump {
    /// Looped back: iteration_count went up by one.
    Looped(Envelope, Option<HandoffEntry>),
    /// The breaker tripped: status `failed`, "max iterations", a critical row.
    Failed(Envelope, Option<HandoffEntry>),
}

// ── Core operations (pure over a Connection) ────────────────────────────────

pub(crate) fn get_bare(conn: &Connection, task_id: &str) -> Result<Option<Envelope>, String> {
    conn.query_row(&format!("SELECT {COLS} FROM task_envelope WHERE task_id = ?1"), params![task_id], row_env).optional().map_err(sql_err)
}

pub(crate) fn log_for(conn: &Connection, task_id: &str) -> Result<Vec<HandoffEntry>, String> {
    let mut st = conn.prepare(&format!("SELECT {LOG_COLS} FROM handoff_log WHERE task_id = ?1 ORDER BY seq")).map_err(sql_err)?;
    let rows = st.query_map(params![task_id], row_entry).map_err(sql_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
}

/// Envelope plus its `handoff_log[]` in seq order.
pub(crate) fn get(conn: &Connection, task_id: &str) -> Result<Option<Envelope>, String> {
    let Some(mut e) = get_bare(conn, task_id)? else { return Ok(None) };
    e.handoff_log = log_for(conn, task_id)?;
    Ok(Some(e))
}

fn append_row(conn: &Connection, task_id: &str, row: &HandoffRow, stage: Option<&str>, iteration: u32, at: i64) -> Result<Option<HandoffEntry>, String> {
    if !matches!(row.severity.as_str(), "critical" | "milestone") {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM handoff_log WHERE task_id = ?1", params![task_id], |r| r.get(0)).map_err(sql_err)?;
        if n >= LOG_ROWS_PER_TASK_MAX {
            return Ok(None);
        }
    }
    conn.execute(
        "INSERT INTO handoff_log (task_id, timestamp, from_agent, to_agent, event_type, severity, short_summary, voice_summary, summary_payload, detail_ref, stage, iteration)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![task_id, at, row.from_agent, row.to_agent, row.event_type, row.severity, row.short_summary, row.voice_summary, row.summary_payload.to_string(), row.detail_ref, stage, iteration as i64],
    )
    .map_err(sql_err)?;
    let seq = conn.last_insert_rowid();
    conn.query_row(&format!("SELECT {LOG_COLS} FROM handoff_log WHERE seq = ?1"), params![seq], row_entry).optional().map_err(sql_err)
}

/// Create a task (status `queued`, owner `tony`) with a `task_queued` row. Idempotent: an
/// existing `dedupe_key`, or an open task for the same `idea_id`, returns that task and
/// `false` instead of creating another.
pub(crate) fn create(conn: &mut Connection, n: &NewEnvelope, known: &[String]) -> Result<(Envelope, bool, Option<HandoffEntry>), String> {
    let raw = scrub(n.raw_intent.trim(), known);
    if raw.is_empty() {
        return Err("raw_intent is empty".into());
    }
    if raw.chars().count() > RAW_INTENT_MAX {
        return Err(format!("raw_intent is limited to {RAW_INTENT_MAX} characters"));
    }
    let source = if n.source.trim().is_empty() { "typed".to_string() } else { n.source.trim().to_string() };
    one_of("source", &source, &SOURCES)?;
    let dedupe = n.dedupe_key.as_deref().map(|k| clean_id("dedupe_key", k)).transpose()?;
    let idea = n.idea_id.as_deref().map(|k| clean_id("idea_id", k)).transpose()?;
    let slug = match n.project_slug.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(super::staging::validate_slug(s)?),
        None => None,
    };
    let title = {
        let t = n.title.as_deref().map(one_line).filter(|t| !t.is_empty()).unwrap_or_else(|| one_line(&raw).split(' ').take(10).collect::<Vec<_>>().join(" "));
        clip(&one_line(&scrub(&t, known)), TITLE_MAX)
    };
    let max_iter = n.max_iterations.unwrap_or(MAX_LOOP_ITERATIONS).clamp(1, MAX_LOOP_ITERATIONS);
    let turn_ids: Vec<String> = n.turn_ids.iter().take(20).map(|t| clip(&one_line(t), 80)).filter(|t| !t.is_empty()).collect();
    let mref = json!({
        "source": source,
        "thread": n.thread.as_deref().map(|t| clip(&one_line(&scrub(t, known)), 120)),
        "turnIds": turn_ids,
        "ideaId": idea,
        "memoryDoc": Value::Null,
    });
    let options = clean_options(&n.options);

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
    if let Some(k) = &dedupe {
        if let Some(id) = tx.query_row("SELECT task_id FROM task_envelope WHERE dedupe_key = ?1", params![k], |r| r.get::<_, String>(0)).optional().map_err(sql_err)? {
            let e = get(&tx, &id)?.ok_or("task store: dedupe row vanished")?;
            return Ok((e, false, None));
        }
    }
    if let Some(i) = &idea {
        let open = format!("SELECT task_id FROM task_envelope WHERE idea_id = ?1 AND status NOT IN ({}) LIMIT 1", sql_list(&TERMINAL));
        if let Some(id) = tx.query_row(&open, params![i], |r| r.get::<_, String>(0)).optional().map_err(sql_err)? {
            let e = get(&tx, &id)?.ok_or("task store: open idea row vanished")?;
            return Ok((e, false, None));
        }
    }
    let now = now_ms();
    let id = new_task_id(now);
    tx.execute(
        "INSERT INTO task_envelope (task_id, created_at, updated_at, status, stage, current_owner, raw_intent, raw_intent_at, raw_intent_ref, title, project_slug, iteration_count, max_iterations, idea_id, dedupe_key, options)
         VALUES (?1, ?2, ?2, 'queued', NULL, 'tony', ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11)",
        params![id, now, raw, n.raw_intent_at.unwrap_or(now), mref.to_string(), title, slug, max_iter as i64, idea, dedupe, options.to_string()],
    )
    .map_err(sql_err)?;
    // Tony's dispatch hand-off (his prompt's OUTPUT FORMAT, built by the app at approval; Part 7).
    let mut refs: Vec<String> = Vec::new();
    if let Some(t) = mref["thread"].as_str() {
        refs.push(format!("thread:{t}"));
    }
    if let Some(i) = mref["ideaId"].as_str() {
        refs.push(format!("idea:{i}"));
    }
    refs.extend(turn_ids.iter().take(5).map(|t| format!("turn:{t}")));
    let mut handoff = super::agent_prompts::tony_dispatch_handoff(&id, &raw, &refs);
    handoff["source"] = json!(source);
    let row = HandoffRow::new("tony", "prompter", "task_queued", "milestone", format!("Queued: {title}")).payload(handoff).validated(known)?;
    let entry = append_row(&tx, &id, &row, None, 0, now)?;
    let env = get(&tx, &id)?.ok_or("task store: insert vanished")?;
    tx.commit().map_err(sql_err)?;
    Ok((env, true, entry))
}

fn validate_next(next: &Next) -> Result<(), String> {
    one_of("status", next.status, &STATUSES)?;
    agent_field("current_owner", next.owner, &OWNERS)?;
    if let Some(s) = next.stage {
        one_of("stage", s, &STAGES)?;
    }
    Ok(())
}

/// Move a task in ONE transaction: check `(status, stage)` = `expect`, set the next
/// status/stage/owner plus `patch`, append `row`. A stale expectation errors and writes nothing.
/// A row's `voice_summary` (validated) is also stored as `voice_summaries[from_agent]`.
pub(crate) fn transition(conn: &mut Connection, task_id: &str, expect: Expect, next: Next, patch: &Patch, row: &HandoffRow, known: &[String]) -> Result<(Envelope, Option<HandoffEntry>), String> {
    validate_next(&next)?;
    let row = row.validated(known)?;
    // Serialize JSON fields before taking the write lock.
    let mut sets: Vec<(&str, rusqlite::types::Value)> = Vec::new();
    use rusqlite::types::Value as Sql;
    let text = |v: String| Sql::Text(v);
    for (field, val) in [
        ("prompt_spec", &patch.prompt_spec),
        ("design_artifacts", &patch.design_artifacts),
        ("coder_brief", &patch.coder_brief),
        ("code_artifacts", &patch.code_artifacts),
        ("librarian_notes", &patch.librarian_notes),
        ("last_eval", &patch.last_eval),
    ] {
        if let Some(v) = val {
            sets.push((field, text(json_text(field, v, known, JSON_MAX)?)));
        }
    }
    if let Some(t) = &patch.title {
        let t = clip(&one_line(&scrub(t, known)), TITLE_MAX);
        if t.is_empty() {
            return Err("title is empty".into());
        }
        sets.push(("title", text(t)));
    }
    if let Some(s) = &patch.project_slug {
        sets.push(("project_slug", text(super::staging::validate_slug(s)?)));
    }
    if let Some(c) = &patch.card_id {
        sets.push(("card_id", text(clean_id("card_id", c)?)));
    }
    if let Some(e) = &patch.error {
        sets.push(("error", e.as_deref().map(|e| text(clip(&one_line(&scrub(e, known)), ERROR_MAX))).unwrap_or(Sql::Null)));
    }
    let terminal = in_list(next.status, &TERMINAL);
    match (terminal, patch.lease_until) {
        (true, _) => sets.push(("lease_until", Sql::Null)),
        (false, Some(l)) => sets.push(("lease_until", l.map(Sql::Integer).unwrap_or(Sql::Null))),
        (false, None) => {}
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
    let cur = tx
        .query_row(&format!("SELECT {COLS} FROM task_envelope WHERE task_id = ?1 AND status = ?2 AND stage IS ?3 AND (?4 IS NULL OR lease_until IS ?4)"), params![task_id, expect.status, expect.stage, expect.lease], row_env)
        .optional()
        .map_err(sql_err)?;
    let Some(cur) = cur else {
        return Err(stale_msg(&tx, task_id, &expect));
    };
    let now = now_ms();
    if let Some(v) = &row.voice_summary {
        let mut vs = cur.voice_summaries.as_object().cloned().unwrap_or_default();
        vs.insert(row.from_agent.clone(), json!({ "text": v, "at": now, "stage": next.stage }));
        sets.push(("voice_summaries", text(Value::Object(vs).to_string())));
    }
    if let Some(m) = &patch.memory_reference {
        // Path references are stored verbatim apart from known secret values: the pattern
        // scrubber can mistake a long path for a token, and a mangled path makes the Librarian
        // report the note as missing. The worker builds `memoryDoc` itself (taskworker h_spec,
        // under the notes root); any future IPC/webview setter must validate the value is under
        // notes_root before it reaches here.
        const PATH_REF_KEYS: &[&str] = &["memoryDoc"];
        let mut r = cur.raw_intent.memory_reference.as_object().cloned().unwrap_or_default();
        for (k, v) in m {
            let val = match v.as_str() {
                Some(path) if PATH_REF_KEYS.contains(&k.as_str()) => json!(clip(&one_line(&scrub_known(path, known)), 400)),
                _ => scrub_value(v, known),
            };
            r.insert(k.clone(), val);
        }
        let s = Value::Object(r).to_string();
        if s.len() > REF_MAX {
            return Err("memory_reference is too large".into());
        }
        sets.push(("raw_intent_ref", text(s)));
    }
    let mut sql = String::from("UPDATE task_envelope SET status = ?, stage = ?, current_owner = ?, updated_at = ?");
    let mut vals: Vec<Sql> = vec![text(next.status.into()), next.stage.map(|s| text(s.into())).unwrap_or(Sql::Null), text(next.owner.into()), Sql::Integer(now)];
    for (k, v) in sets {
        sql.push_str(&format!(", {k} = ?"));
        vals.push(v);
    }
    sql.push_str(" WHERE task_id = ? AND status = ? AND stage IS ? AND (? IS NULL OR lease_until IS ?)");
    vals.push(text(task_id.into()));
    vals.push(text(expect.status.into()));
    vals.push(expect.stage.map(|s| text(s.into())).unwrap_or(Sql::Null));
    let lease = expect.lease.map(Sql::Integer).unwrap_or(Sql::Null);
    vals.push(lease.clone());
    vals.push(lease);
    let n = tx.execute(&sql, rusqlite::params_from_iter(vals)).map_err(sql_err)?;
    if n != 1 {
        return Err(stale_msg(&tx, task_id, &expect));
    }
    let entry = append_row(&tx, task_id, &row, next.stage, cur.iteration_count, now)?;
    let env = get(&tx, task_id)?.ok_or("task store: row vanished")?;
    tx.commit().map_err(sql_err)?;
    Ok((env, entry))
}

fn stale_msg(conn: &Connection, task_id: &str, expect: &Expect) -> String {
    match get_bare(conn, task_id) {
        Ok(Some(e)) if expect.lease.is_some() && e.status == expect.status && e.stage.as_deref() == expect.stage => format!("STALE: task {task_id} was re-claimed, cancelled or retried since this run claimed it"),
        Ok(Some(e)) => format!("STALE: task {task_id} is {}/{} (expected {}/{})", e.status, e.stage.as_deref().unwrap_or("-"), expect.status, expect.stage.unwrap_or("-")),
        Ok(None) => format!("task {task_id} not found"),
        Err(e) => e,
    }
}

/// Loop back (`iteration_count += 1` → `next`) or, once the count has reached
/// `min(max_iterations, MAX_LOOP_ITERATIONS)`, set `failed` with "max iterations" and a
/// critical row. One transaction either way.
pub(crate) fn bump_iteration(conn: &mut Connection, task_id: &str, expect: Expect, next: Next, row: &HandoffRow, known: &[String]) -> Result<Bump, String> {
    validate_next(&next)?;
    let row = row.validated(known)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
    let Some(cur) = tx
        .query_row(&format!("SELECT {COLS} FROM task_envelope WHERE task_id = ?1 AND status = ?2 AND stage IS ?3 AND (?4 IS NULL OR lease_until IS ?4)"), params![task_id, expect.status, expect.stage, expect.lease], row_env)
        .optional()
        .map_err(sql_err)?
    else {
        return Err(stale_msg(&tx, task_id, &expect));
    };
    let limit = cur.max_iterations.min(MAX_LOOP_ITERATIONS);
    let now = now_ms();
    if cur.iteration_count >= limit {
        let err = format!("max iterations ({limit}) reached");
        tx.execute(
            "UPDATE task_envelope SET status = 'failed', updated_at = ?1, lease_until = NULL, error = ?2 WHERE task_id = ?3",
            params![now, err, task_id],
        )
        .map_err(sql_err)?;
        let fail = HandoffRow::new(&row.from_agent, "tony", "failed", "critical", format!("Stopped after {limit} iterations")).payload(json!({ "reason": "max_iterations", "iteration": cur.iteration_count })).validated(known)?;
        let entry = append_row(&tx, task_id, &fail, cur.stage.as_deref(), cur.iteration_count, now)?;
        let env = get(&tx, task_id)?.ok_or("task store: row vanished")?;
        tx.commit().map_err(sql_err)?;
        return Ok(Bump::Failed(env, entry));
    }
    let it = cur.iteration_count + 1;
    tx.execute(
        "UPDATE task_envelope SET status = ?1, stage = ?2, current_owner = ?3, iteration_count = ?4, updated_at = ?5, lease_until = NULL WHERE task_id = ?6",
        params![next.status, next.stage, next.owner, it as i64, now, task_id],
    )
    .map_err(sql_err)?;
    let entry = append_row(&tx, task_id, &row, next.stage, it, now)?;
    let env = get(&tx, task_id)?.ok_or("task store: row vanished")?;
    tx.commit().map_err(sql_err)?;
    Ok(Bump::Looped(env, entry))
}

/// `failed` from the expected state, with a critical row from `agent` to Tony.
pub(crate) fn fail(conn: &mut Connection, task_id: &str, expect: Expect, agent: &str, reason: &str, known: &[String]) -> Result<(Envelope, Option<HandoffEntry>), String> {
    let cur = get_bare(conn, task_id)?.ok_or_else(|| format!("task {task_id} not found"))?;
    let owner = cur.current_owner.clone();
    let stage = cur.stage.clone();
    let row = HandoffRow::new(agent, "tony", "failed", "critical", format!("Failed: {}", one_line(reason)));
    let patch = Patch { error: Some(Some(reason.to_string())), ..Default::default() };
    transition(conn, task_id, expect, Next { status: "failed", stage: stage.as_deref(), owner: &owner }, &patch, &row, known)
}

// ── Play Place hub hooks (Thought-to-Product Phase 4) ─────────────────────────
// Process-local registries the build hub (`buildhub.rs`) keeps in sync from its own persisted
// file: a paused task is never claimed (the stage in flight finishes and commits first — that
// commit is the checkpoint), and a task's human overrides go into every following stage prompt.

static PAUSED: std::sync::OnceLock<Mutex<std::collections::BTreeSet<String>>> = std::sync::OnceLock::new();
static OVERRIDES: std::sync::OnceLock<Mutex<BTreeMap<String, Vec<String>>>> = std::sync::OnceLock::new();

pub fn set_paused(task_id: &str, on: bool) {
    let mut s = PAUSED.get_or_init(Default::default).lock().unwrap();
    if on {
        s.insert(task_id.to_string());
    } else {
        s.remove(task_id);
    }
}

pub fn is_paused(task_id: &str) -> bool {
    PAUSED.get().is_some_and(|s| s.lock().unwrap().contains(task_id))
}

pub fn set_overrides(task_id: &str, directives: Vec<String>) {
    let mut m = OVERRIDES.get_or_init(Default::default).lock().unwrap();
    if directives.is_empty() {
        m.remove(task_id);
    } else {
        m.insert(task_id.to_string(), directives);
    }
}

pub fn overrides(task_id: &str) -> Vec<String> {
    OVERRIDES.get().and_then(|m| m.lock().unwrap().get(task_id).cloned()).unwrap_or_default()
}

/// The oldest runnable task — `queued`, or in flight with no live lease — leased until
/// `now + lease_ms` in the same transaction. No log row (the stage claim writes one). Tasks the
/// Play Place hub paused are skipped (`set_paused`).
pub(crate) fn claim_next(conn: &mut Connection, now: i64, lease_ms: i64) -> Result<Option<Envelope>, String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
    let id: Option<String> = {
        let mut st = tx
            .prepare(&format!(
                "SELECT task_id FROM task_envelope
                 WHERE (status = 'queued' OR status IN ({})) AND (lease_until IS NULL OR lease_until < ?1)
                 ORDER BY created_at, task_id LIMIT 64",
                sql_list(&IN_FLIGHT)
            ))
            .map_err(sql_err)?;
        let rows = st.query_map(params![now], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        let ids = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?;
        ids.into_iter().find(|i| !is_paused(i))
    };
    let Some(id) = id else { return Ok(None) };
    tx.execute("UPDATE task_envelope SET lease_until = ?1 WHERE task_id = ?2", params![now + lease_ms.max(1), id]).map_err(sql_err)?;
    let env = get(&tx, &id)?;
    tx.commit().map_err(sql_err)?;
    Ok(env)
}

/// Give back a `claim_next` lease that never became a stage claim (the worker stopped or the
/// claim transition failed): only while the row still holds exactly that lease.
pub(crate) fn release_claim(conn: &Connection, task_id: &str, lease: i64) -> Result<bool, String> {
    let n = conn.execute("UPDATE task_envelope SET lease_until = NULL WHERE task_id = ?1 AND lease_until = ?2", params![task_id, lease]).map_err(sql_err)?;
    Ok(n == 1)
}

/// After a restart: every in-flight task (`prompting|designing|coding`) gets one
/// `interrupted` row (severity handoff) and its lease cleared; status, stage and
/// iteration stay, so only the current stage re-runs. A `queued` row only loses a lease
/// `claim_next` left on it (the app closed before the stage claim), with no row; terminal rows
/// are untouched. Returns the recovered in-flight tasks (oldest first) with the row each gained.
pub(crate) fn recover_interrupted(conn: &mut Connection) -> Result<Vec<(Envelope, Option<HandoffEntry>)>, String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
    let ids: Vec<String> = {
        let mut st = tx.prepare(&format!("SELECT task_id FROM task_envelope WHERE status IN ({}) ORDER BY created_at, task_id", sql_list(&IN_FLIGHT))).map_err(sql_err)?;
        let rows = st.query_map([], |r| r.get(0)).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?
    };
    let now = now_ms();
    tx.execute("UPDATE task_envelope SET lease_until = NULL WHERE status = 'queued' AND lease_until IS NOT NULL", []).map_err(sql_err)?;
    let mut out = Vec::new();
    for id in ids {
        let cur = get_bare(&tx, &id)?.ok_or("task store: row vanished")?;
        tx.execute("UPDATE task_envelope SET lease_until = NULL, updated_at = ?1 WHERE task_id = ?2", params![now, id]).map_err(sql_err)?;
        let stage = cur.stage.clone();
        let owner = cur.current_owner.clone();
        let row = HandoffRow::new(&owner, &owner, "interrupted", "handoff", format!("Interrupted by a restart; resuming {}", stage.as_deref().unwrap_or("the task"))).validated(&[])?;
        let entry = append_row(&tx, &id, &row, stage.as_deref(), cur.iteration_count, now)?;
        out.push((get(&tx, &id)?.ok_or("task store: row vanished")?, entry));
    }
    tx.commit().map_err(sql_err)?;
    Ok(out)
}

/// Record where Tony's documenter wrote the task note (`raw_intent.memory_reference.memoryDoc`).
/// No status change and no log row.
pub(crate) fn set_memory_doc(conn: &Connection, task_id: &str, path: &str) -> Result<(), String> {
    let cur = get_bare(conn, task_id)?.ok_or_else(|| format!("task {task_id} not found"))?;
    let mut r = cur.raw_intent.memory_reference.as_object().cloned().unwrap_or_default();
    r.insert("memoryDoc".into(), json!(clip(path, 400)));
    conn.execute("UPDATE task_envelope SET raw_intent_ref = ?1, updated_at = ?2 WHERE task_id = ?3", params![Value::Object(r).to_string(), now_ms(), task_id]).map_err(sql_err)?;
    Ok(())
}

/// Newest first; `status` filters. Logs are attached only with `include_log`.
pub(crate) fn list(conn: &Connection, status: Option<&str>, limit: usize, include_log: bool) -> Result<Vec<Envelope>, String> {
    if let Some(s) = status {
        one_of("status", s, &STATUSES)?;
    }
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM task_envelope WHERE (?1 IS NULL OR status = ?1) ORDER BY updated_at DESC, task_id LIMIT ?2")).map_err(sql_err)?;
    let rows = st.query_map(params![status, limit.clamp(1, 500) as i64], row_env).map_err(sql_err)?;
    let mut out = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?;
    if include_log {
        for e in out.iter_mut() {
            e.handoff_log = log_for(conn, &e.task_id)?;
        }
    }
    Ok(out)
}

/// One task as status-on-demand needs it (no artifacts, no payloads).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TaskBrief {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub stage: Option<String>,
    pub current_owner: String,
    pub project_slug: Option<String>,
    pub iteration_count: u32,
    pub max_iterations: u32,
    pub updated_at: i64,
    pub error: Option<String>,
    pub last_handoff: Option<HandoffEntry>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StatusSummary {
    pub counts: BTreeMap<String, i64>,
    /// Open tasks, oldest first.
    pub active: Vec<TaskBrief>,
    /// The three most recently finished (review_ready / failed).
    pub recent: Vec<TaskBrief>,
}

fn brief(conn: &Connection, e: Envelope) -> Result<TaskBrief, String> {
    let last = conn.query_row(&format!("SELECT {LOG_COLS} FROM handoff_log WHERE task_id = ?1 ORDER BY seq DESC LIMIT 1"), params![e.task_id], row_entry).optional().map_err(sql_err)?;
    Ok(TaskBrief {
        task_id: e.task_id,
        title: e.title,
        status: e.status,
        stage: e.stage,
        current_owner: e.current_owner,
        project_slug: e.project_slug,
        iteration_count: e.iteration_count,
        max_iterations: e.max_iterations,
        updated_at: e.updated_at,
        error: e.error,
        last_handoff: last,
    })
}

/// Deterministic status for "what's going on with the build?" (no model call).
pub(crate) fn status_summary(conn: &Connection) -> Result<StatusSummary, String> {
    let mut counts: BTreeMap<String, i64> = STATUSES.iter().map(|s| (s.to_string(), 0)).collect();
    {
        let mut st = conn.prepare("SELECT status, COUNT(*) FROM task_envelope GROUP BY status").map_err(sql_err)?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(sql_err)?;
        for r in rows {
            let (s, n) = r.map_err(sql_err)?;
            counts.insert(s, n);
        }
    }
    let fetch = |sql: String| -> Result<Vec<TaskBrief>, String> {
        let mut st = conn.prepare(&sql).map_err(sql_err)?;
        let rows = st.query_map([], row_env).map_err(sql_err)?;
        let envs = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?;
        envs.into_iter().map(|e| brief(conn, e)).collect()
    };
    let active = fetch(format!("SELECT {COLS} FROM task_envelope WHERE status NOT IN ({}) ORDER BY created_at, task_id LIMIT 50", sql_list(&TERMINAL)))?;
    let recent = fetch(format!("SELECT {COLS} FROM task_envelope WHERE status IN ({}) ORDER BY updated_at DESC, task_id LIMIT 3", sql_list(&TERMINAL)))?;
    Ok(StatusSummary { counts, active, recent })
}

/// The newest validated voice summary `agent` gave, with its task id and time
/// ("Hey Coder, where are we at?").
pub(crate) fn latest_voice_summary(conn: &Connection, agent: &str) -> Result<Option<(String, String, i64)>, String> {
    agent_field("agent", agent, &AGENTS)?;
    conn.query_row(
        "SELECT task_id, voice_summary, timestamp FROM handoff_log WHERE from_agent = ?1 AND voice_summary IS NOT NULL ORDER BY seq DESC LIMIT 1",
        params![agent],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(sql_err)
}

/// A compact envelope snapshot for the gateway `task_mirror` (≤ 16 KB): no artifacts, no
/// specs, the last five log rows without payloads (dropped first if still too large).
pub fn mirror_snapshot(e: &Envelope) -> Value {
    let log: Vec<Value> = e
        .handoff_log
        .iter()
        .rev()
        .take(5)
        .rev()
        .map(|h| json!({ "seq": h.seq, "timestamp": h.timestamp, "from_agent": h.from_agent, "to_agent": h.to_agent, "event_type": h.event_type, "severity": h.severity, "short_summary": h.short_summary, "voice_summary": h.voice_summary, "stage": h.stage, "iteration": h.iteration }))
        .collect();
    let mut snap = json!({
        "task_id": e.task_id,
        "title": e.title,
        "status": e.status,
        "stage": e.stage,
        "current_owner": e.current_owner,
        "project_slug": e.project_slug,
        "iteration_count": e.iteration_count,
        "max_iterations": e.max_iterations,
        "created_at": e.created_at,
        "updated_at": e.updated_at,
        "voice_summaries": e.voice_summaries,
        "error": e.error,
        "handoff_log": log,
    });
    if snap.to_string().len() > MIRROR_MAX {
        snap["handoff_log"] = json!([]);
    }
    if snap.to_string().len() > MIRROR_MAX {
        snap["voice_summaries"] = json!({});
    }
    snap
}

// ── AnythingLLM thread map (Part 3) and meta ────────────────────────────────

pub(crate) fn thread_get(conn: &Connection, base: &str, workspace: &str, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT thread_slug FROM allm_thread WHERE base = ?1 AND workspace_slug = ?2 AND key = ?3", params![base, workspace, key], |r| r.get(0)).optional().map_err(sql_err)
}

pub(crate) fn thread_put(conn: &Connection, base: &str, workspace: &str, key: &str, thread_slug: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO allm_thread (base, workspace_slug, key, thread_slug, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(base, workspace_slug, key) DO UPDATE SET thread_slug = excluded.thread_slug",
        params![base, workspace, key, thread_slug, now_ms()],
    )
    .map_err(sql_err)?;
    Ok(())
}

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM envelope_meta WHERE key = ?1", params![key], |r| r.get(0)).optional().map_err(sql_err)
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT INTO envelope_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(sql_err)?;
    Ok(())
}

// ── State ───────────────────────────────────────────────────────────────────

/// Managed Tauri state. If tasks.db can't be opened the app keeps running and the worker
/// stays disabled (`unavailable()` says why).
#[derive(Default)]
pub struct TaskStore {
    conn: Mutex<Option<Connection>>,
    path: Mutex<Option<PathBuf>>,
    unavailable: Mutex<Option<String>>,
}

impl TaskStore {
    /// Open (or create) `<dir>/tasks.db`. On failure: logged, remembered, retried on first use.
    pub fn init(&self, dir: &Path) -> Result<(), String> {
        let path = dir.join("tasks.db");
        *self.path.lock().unwrap() = Some(path.clone());
        match std::fs::create_dir_all(dir).map_err(|e| e.to_string()).and_then(|_| open_db(&path)) {
            Ok(c) => {
                *self.conn.lock().unwrap() = Some(c);
                *self.unavailable.lock().unwrap() = None;
                Ok(())
            }
            Err(e) => {
                eprintln!("[tasks] {e}; the task worker is disabled");
                *self.unavailable.lock().unwrap() = Some(e.clone());
                Err(e)
            }
        }
    }

    /// Why the store isn't usable (None = fine).
    pub fn unavailable(&self) -> Option<String> {
        self.unavailable.lock().unwrap().clone()
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.path.lock().unwrap().clone()
    }

    /// Run `f` on the connection. Never hold this across an `.await`.
    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.conn.lock().unwrap();
        if g.is_none() {
            let path = self.path.lock().unwrap().clone().ok_or("task store isn't initialised")?;
            *g = Some(open_db(&path)?);
            *self.unavailable.lock().unwrap() = None;
        }
        f(g.as_mut().expect("connection just opened"))
    }

    /// A separate read-only connection on the same file (the Librarian's view).
    pub(crate) fn read_only(&self) -> Result<Connection, String> {
        let path = self.path().ok_or("task store has no file (in-memory)")?;
        open_read_only(&path)
    }

    pub(crate) fn create(&self, n: &NewEnvelope, known: &[String]) -> Result<(Envelope, bool), String> {
        let (env, created, entry) = self.with(|c| create(c, n, known))?;
        if let Some(h) = entry {
            super::events::publish_entry(&h, &env);
            super::transcript::mirror_entry(&h, &env, known);
        }
        Ok((env, created))
    }

    pub(crate) fn transition(&self, task_id: &str, expect: Expect, next: Next, patch: &Patch, row: &HandoffRow, known: &[String]) -> Result<Envelope, String> {
        let (env, entry) = self.with(|c| transition(c, task_id, expect, next, patch, row, known))?;
        if let Some(h) = entry {
            super::events::publish_entry(&h, &env);
            super::transcript::mirror_entry(&h, &env, known);
        }
        Ok(env)
    }

    pub(crate) fn bump_iteration(&self, task_id: &str, expect: Expect, next: Next, row: &HandoffRow, known: &[String]) -> Result<Bump, String> {
        let b = self.with(|c| bump_iteration(c, task_id, expect, next, row, known))?;
        if let Bump::Looped(env, Some(h)) | Bump::Failed(env, Some(h)) = &b {
            super::events::publish_entry(h, env);
            super::transcript::mirror_entry(h, env, known);
        }
        Ok(b)
    }

    pub(crate) fn fail(&self, task_id: &str, expect: Expect, agent: &str, reason: &str, known: &[String]) -> Result<Envelope, String> {
        let (env, entry) = self.with(|c| fail(c, task_id, expect, agent, reason, known))?;
        if let Some(h) = entry {
            super::events::publish_entry(&h, &env);
            super::transcript::mirror_entry(&h, &env, known);
        }
        Ok(env)
    }

    /// Startup recovery; returns the task ids to re-enqueue.
    pub(crate) fn recover_interrupted(&self) -> Result<Vec<String>, String> {
        let rec = self.with(recover_interrupted)?;
        for (env, entry) in &rec {
            if let Some(h) = entry {
                super::events::publish_entry(h, env);
                // Its rows were scrubbed when they were written.
                super::transcript::mirror_entry(h, env, &[]);
            }
        }
        Ok(rec.into_iter().map(|(e, _)| e.task_id).collect())
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate(&mut c).unwrap();
        Self { conn: Mutex::new(Some(c)), path: Mutex::new(None), unavailable: Mutex::new(None) }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate(&mut c).unwrap();
        c
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tasks-{tag}-{}-{}", std::process::id(), new_task_id(now_ms())));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn new(text: &str) -> NewEnvelope {
        NewEnvelope { raw_intent: text.into(), source: "voice".into(), ..Default::default() }
    }

    fn mk(c: &mut Connection, text: &str) -> Envelope {
        create(c, &new(text), &[]).unwrap().0
    }

    fn start_spec(c: &mut Connection, id: &str) -> Envelope {
        transition(c, id, Expect { status: "queued", stage: None, lease: None }, Next::stage("spec").unwrap(), &Patch::default(), &HandoffRow::new("tony", "prompter", "stage_started", "handoff", "Prompter is writing the spec"), &[]).unwrap().0
    }

    #[test]
    fn migration_fresh_and_idempotent() {
        let mut c = mem();
        assert_eq!(migrate(&mut c).unwrap(), migrations().len() as u32);
        assert_eq!(migrate(&mut c).unwrap(), 1);
        let v: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
        for t in ["task_envelope", "handoff_log", "allm_thread", "envelope_meta"] {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", params![t], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "{t}");
        }
    }

    #[test]
    fn newer_database_is_refused() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA user_version = 99").unwrap();
        let e = migrate(&mut c).unwrap_err();
        assert!(e.contains("newer than this app"), "{e}");
    }

    #[test]
    fn spec_field_names_serialize_verbatim() {
        let mut c = mem();
        let e = mk(&mut c, "Build a minimal status card component");
        let v = serde_json::to_value(get(&c, &e.task_id).unwrap().unwrap()).unwrap();
        for k in ["task_id", "created_at", "status", "raw_intent", "current_owner", "iteration_count", "max_iterations", "prompt_spec", "design_artifacts", "code_artifacts", "librarian_notes", "handoff_log"] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["raw_intent"]["text"], "Build a minimal status card component");
        assert!(v["raw_intent"]["timestamp"].as_i64().unwrap() > 0);
        assert_eq!(v["raw_intent"]["memory_reference"]["source"], "voice");
        let h = &v["handoff_log"][0];
        for k in ["timestamp", "from_agent", "to_agent", "summary_payload"] {
            assert!(h.get(k).is_some(), "handoff_log missing {k}");
        }
        assert_eq!((v["status"].as_str(), v["current_owner"].as_str(), v["max_iterations"].as_u64()), (Some("queued"), Some("tony"), Some(3)));
        assert!(e.task_id.starts_with("t-") && e.task_id.len() == 2 + 13 + 1 + 6, "{}", e.task_id);
        // Part 7: the intake row carries Tony's dispatch hand-off, field for field (+ source).
        let p = &h["summary_payload"];
        assert_eq!((p["action"].as_str(), p["task_id"].as_str(), p["priority"].as_str(), p["source"].as_str()), (Some("dispatch_to_prompter"), Some(e.task_id.as_str()), Some("normal"), Some("voice")));
        assert_eq!(p["raw_intent"], "Build a minimal status card component");
        assert!(p["memory_refs"].is_array() && p["voice_summary"].as_str().unwrap().starts_with("Queued."));
        let n = NewEnvelope { raw_intent: "urgent: fix the card".into(), source: "typed".into(), thread: Some("auto".into()), idea_id: Some("idea-7".into()), turn_ids: vec!["turn-1".into()], ..Default::default() };
        let (e2, _, _) = create(&mut c, &n, &[]).unwrap();
        let p2 = &log_for(&c, &e2.task_id).unwrap()[0].summary_payload;
        assert_eq!(p2["memory_refs"], json!(["thread:auto", "idea:idea-7", "turn:turn-1"]));
        assert_eq!(p2["priority"], "high");
        assert!(get(&c, &e2.task_id).unwrap().unwrap().voice_summaries.as_object().unwrap().is_empty(), "the hand-off's voice line is not a narrated voice summary");
    }

    #[test]
    fn checks_reject_bad_status_owner_and_iterations() {
        let mut c = mem();
        let e = mk(&mut c, "x task");
        let id = e.task_id.as_str();
        assert!(c.execute("UPDATE task_envelope SET status = 'done' WHERE task_id = ?1", params![id]).is_err());
        assert!(c.execute("UPDATE task_envelope SET current_owner = 'Not An Id' WHERE task_id = ?1", params![id]).is_err());
        assert!(c.execute("UPDATE task_envelope SET iteration_count = 4 WHERE task_id = ?1", params![id]).is_err());
        assert!(c.execute("UPDATE task_envelope SET max_iterations = 11 WHERE task_id = ?1", params![id]).is_err());
        assert!(c.execute("UPDATE task_envelope SET stage = 'deploy' WHERE task_id = ?1", params![id]).is_err());
        assert!(c.execute("UPDATE task_envelope SET prompt_spec = ?1 WHERE task_id = ?2", params!["x".repeat(JSON_MAX + 1), id]).is_err());
        // …and the Rust side refuses them before SQL.
        let r = HandoffRow::new("tony", "prompter", "stage_started", "handoff", "x");
        assert!(transition(&mut c, id, Expect { status: "queued", stage: None, lease: None }, Next { status: "done", stage: None, owner: "tony" }, &Patch::default(), &r, &[]).is_err());
        assert!(transition(&mut c, id, Expect { status: "queued", stage: None, lease: None }, Next { status: "prompting", stage: Some("spec"), owner: "librarian" }, &Patch::default(), &r, &[]).is_err());
        let bad = HandoffRow::new("tony", "prompter", "stage_started", "loud", "x");
        assert!(transition(&mut c, id, Expect { status: "queued", stage: None, lease: None }, Next::stage("spec").unwrap(), &Patch::default(), &bad, &[]).is_err());
        assert_eq!(get(&c, id).unwrap().unwrap().handoff_log.len(), 1);
        assert!(c.execute("INSERT INTO handoff_log (task_id, timestamp, from_agent, to_agent, event_type, severity, short_summary) VALUES (?1, 1, 'tony', 'prompter', 'x', 'handoff', ?2)", params![id, "y".repeat(141)]).is_err());
        assert!(c.execute("INSERT INTO handoff_log (task_id, timestamp, from_agent, to_agent, event_type, severity, short_summary) VALUES ('nope', 1, 'tony', 'prompter', 'x', 'handoff', 'z')", []).is_err(), "FK");
    }

    #[test]
    fn handoff_log_is_append_only_and_ordered() {
        let mut c = mem();
        let e = mk(&mut c, "append only");
        start_spec(&mut c, &e.task_id);
        let err = c.execute("UPDATE handoff_log SET short_summary = 'x'", []).unwrap_err().to_string();
        assert!(err.contains("append-only"), "{err}");
        let err = c.execute("DELETE FROM handoff_log", []).unwrap_err().to_string();
        assert!(err.contains("append-only"), "{err}");
        let log = get(&c, &e.task_id).unwrap().unwrap().handoff_log;
        assert_eq!(log.len(), 2);
        assert!(log[0].seq < log[1].seq);
        assert_eq!(log[0].event_type, "task_queued");
        assert_eq!((log[1].stage.as_deref(), log[1].from_agent.as_str(), log[1].to_agent.as_str()), (Some("spec"), "tony", "prompter"));
    }

    #[test]
    fn stale_transition_writes_nothing() {
        let mut c = mem();
        let e = mk(&mut c, "stale");
        let before = get(&c, &e.task_id).unwrap().unwrap();
        let patch = Patch { prompt_spec: Some(json!({"title": "x"})), ..Default::default() };
        let r = HandoffRow::new("prompter", "designer", "handoff", "handoff", "Spec ready");
        let err = transition(&mut c, &e.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("design").unwrap(), &patch, &r, &[]).unwrap_err();
        assert!(err.starts_with("STALE"), "{err}");
        assert_eq!(get(&c, &e.task_id).unwrap().unwrap(), before);
        // The right expectation moves it, the same one again is stale.
        start_spec(&mut c, &e.task_id);
        let after = transition(&mut c, &e.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("design").unwrap(), &patch, &r, &[]).unwrap().0;
        assert_eq!((after.status.as_str(), after.stage.as_deref(), after.current_owner.as_str()), ("designing", Some("design"), "designer"));
        assert_eq!(after.prompt_spec, json!({"title": "x"}));
        let snapshot = get(&c, &e.task_id).unwrap().unwrap();
        assert!(transition(&mut c, &e.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("design").unwrap(), &patch, &r, &[]).is_err());
        assert_eq!(get(&c, &e.task_id).unwrap().unwrap(), snapshot);
    }

    #[test]
    fn oversize_json_is_refused_without_writing() {
        let mut c = mem();
        let e = mk(&mut c, "big");
        start_spec(&mut c, &e.task_id);
        let before = get(&c, &e.task_id).unwrap().unwrap();
        let patch = Patch { prompt_spec: Some(json!({ "x": "y".repeat(JSON_MAX) })), ..Default::default() };
        let r = HandoffRow::new("prompter", "designer", "handoff", "handoff", "Spec ready");
        assert!(transition(&mut c, &e.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("design").unwrap(), &patch, &r, &[]).unwrap_err().contains("64 KB"));
        assert_eq!(get(&c, &e.task_id).unwrap().unwrap(), before);
    }

    #[test]
    fn bump_iteration_stops_at_exactly_three() {
        let mut c = mem();
        let e = mk(&mut c, "loop me");
        start_spec(&mut c, &e.task_id);
        transition(&mut c, &e.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("evaluate").unwrap(), &Patch::default(), &HandoffRow::new("prompter", "coder", "handoff", "handoff", "x"), &[]).unwrap();
        let row = HandoffRow::new("prompter", "coder", "loop_iteration", "milestone", "Another pass");
        for want in 1..=3 {
            // Each loop goes evaluate → code; walk back to evaluate for the next bump.
            match bump_iteration(&mut c, &e.task_id, Expect { status: "coding", stage: Some("evaluate"), lease: None }, Next::stage("code").unwrap(), &row, &[]).unwrap() {
                Bump::Looped(env, _) => assert_eq!(env.iteration_count, want),
                Bump::Failed(..) => panic!("failed early at {want}"),
            }
            transition(&mut c, &e.task_id, Expect { status: "coding", stage: Some("code"), lease: None }, Next::stage("evaluate").unwrap(), &Patch::default(), &HandoffRow::new("coder", "prompter", "handoff", "handoff", "built"), &[]).unwrap();
        }
        match bump_iteration(&mut c, &e.task_id, Expect { status: "coding", stage: Some("evaluate"), lease: None }, Next::stage("code").unwrap(), &row, &[]).unwrap() {
            Bump::Failed(env, h) => {
                assert_eq!((env.status.as_str(), env.iteration_count), ("failed", 3));
                assert!(env.error.unwrap().contains("max iterations"));
                let h = h.unwrap();
                assert_eq!((h.severity.as_str(), h.event_type.as_str()), ("critical", "failed"));
            }
            Bump::Looped(..) => panic!("looped past 3"),
        }
        // A configured max of 10 is still capped by MAX_LOOP_ITERATIONS.
        let (e2, ..) = create(&mut c, &NewEnvelope { max_iterations: Some(10), ..new("cap") }, &[]).unwrap();
        assert_eq!(e2.max_iterations, MAX_LOOP_ITERATIONS);
    }

    #[test]
    fn dedupe_and_open_idea_return_the_existing_task() {
        let mut c = mem();
        let a = create(&mut c, &NewEnvelope { dedupe_key: Some("q-42".into()), ..new("phone task") }, &[]).unwrap();
        let b = create(&mut c, &NewEnvelope { dedupe_key: Some("q-42".into()), ..new("phone task again") }, &[]).unwrap();
        assert!(a.1 && !b.1);
        assert_eq!(a.0.task_id, b.0.task_id);
        let i1 = create(&mut c, &NewEnvelope { idea_id: Some("idea-7".into()), ..new("idea one") }, &[]).unwrap();
        let i2 = create(&mut c, &NewEnvelope { idea_id: Some("idea-7".into()), ..new("idea one again") }, &[]).unwrap();
        assert!(i1.1 && !i2.1);
        assert_eq!(i1.0.task_id, i2.0.task_id);
        // Once that task is terminal the same idea may run again.
        fail(&mut c, &i1.0.task_id, Expect { status: "queued", stage: None, lease: None }, "system", "user cancelled", &[]).unwrap();
        let i3 = create(&mut c, &NewEnvelope { idea_id: Some("idea-7".into()), ..new("idea retry") }, &[]).unwrap();
        assert!(i3.1);
        assert_ne!(i3.0.task_id, i1.0.task_id);
        // The partial unique index is the backstop.
        let n: i64 = c.query_row("SELECT COUNT(*) FROM task_envelope WHERE idea_id='idea-7' AND status NOT IN ('review_ready','failed')", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn restart_recovery_resumes_only_in_flight_rows() {
        let dir = tmp("restart");
        let path = dir.join("tasks.db");
        let (inflight, queued, done) = {
            let mut c = open_db(&path).unwrap();
            let a = mk(&mut c, "in flight");
            start_spec(&mut c, &a.task_id);
            transition(&mut c, &a.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("design").unwrap(), &Patch { lease_until: Some(Some(now_ms() + 60_000)), ..Default::default() }, &HandoffRow::new("prompter", "designer", "handoff", "handoff", "spec ready"), &[]).unwrap();
            let q = mk(&mut c, "still queued");
            let d = mk(&mut c, "finished");
            fail(&mut c, &d.task_id, Expect { status: "queued", stage: None, lease: None }, "system", "x", &[]).unwrap();
            (a.task_id, q.task_id, d.task_id)
        }; // dropped = app closed
        let store = TaskStore::default();
        store.init(&dir).unwrap();
        let before_q = store.with(|c| get(c, &queued)).unwrap().unwrap();
        let before_d = store.with(|c| get(c, &done)).unwrap().unwrap();
        let ids = store.recover_interrupted().unwrap();
        assert_eq!(ids, vec![inflight.clone()]);
        let a = store.with(|c| get(c, &inflight)).unwrap().unwrap();
        assert_eq!((a.status.as_str(), a.stage.as_deref(), a.current_owner.as_str(), a.iteration_count), ("designing", Some("design"), "designer", 0));
        assert_eq!(a.lease_until, None);
        assert_eq!(a.handoff_log.len(), 4);
        let last = a.handoff_log.last().unwrap();
        assert_eq!((last.event_type.as_str(), last.severity.as_str()), ("interrupted", "handoff"));
        assert_eq!(store.with(|c| get(c, &queued)).unwrap().unwrap(), before_q);
        assert_eq!(store.with(|c| get(c, &done)).unwrap().unwrap(), before_d);
        // The interrupted task is claimable straight away (its lease was cleared).
        let claimed = store.with(|c| claim_next(c, now_ms(), 60_000)).unwrap().unwrap();
        assert_eq!(claimed.task_id, inflight);
        assert!(claimed.lease_until.unwrap() > now_ms());
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claim_next_skips_live_leases_and_terminal_rows() {
        let mut c = mem();
        assert!(claim_next(&mut c, now_ms(), 1000).unwrap().is_none());
        let a = mk(&mut c, "first");
        let b = mk(&mut c, "second");
        let now = now_ms();
        assert_eq!(claim_next(&mut c, now, 60_000).unwrap().unwrap().task_id, a.task_id);
        assert_eq!(claim_next(&mut c, now, 60_000).unwrap().unwrap().task_id, b.task_id);
        assert!(claim_next(&mut c, now, 60_000).unwrap().is_none());
        // An expired lease is offered again.
        assert_eq!(claim_next(&mut c, now + 120_000, 60_000).unwrap().unwrap().task_id, a.task_id);
    }

    #[test]
    fn secrets_and_voice_summaries_are_scrubbed_and_capped() {
        let mut c = mem();
        let known = vec!["hunter2-super-secret".to_string()];
        let (e, ..) = create(&mut c, &NewEnvelope { raw_intent: "use key sk-abcdefghijklmnopqrstuvwx and hunter2-super-secret".into(), source: "typed".into(), ..Default::default() }, &known).unwrap();
        assert!(!e.raw_intent.text.contains("sk-abcdef") && !e.raw_intent.text.contains("hunter2"), "{}", e.raw_intent.text);
        start_spec(&mut c, &e.task_id);
        let long = format!("Spec is ready with five screens, Bearer abcdefghijklmnop. {}", "More words here. ".repeat(40));
        let row = HandoffRow::new("prompter", "designer", "handoff", "handoff", "Spec ready").voice(Some(&long)).payload(json!({ "token": "x", "note": "Bearer abcdefghijklmnopq" }));
        let env = transition(&mut c, &e.task_id, Expect { status: "prompting", stage: Some("spec"), lease: None }, Next::stage("design").unwrap(), &Patch::default(), &row, &known).unwrap().0;
        let vs = env.voice_summaries["prompter"]["text"].as_str().unwrap();
        assert!(vs.chars().count() <= VOICE_SUMMARY_MAX && !vs.contains("abcdefghijklmnop"), "{vs}");
        assert_eq!(env.voice_summaries["prompter"]["stage"], "design");
        let h = env.handoff_log.last().unwrap();
        assert_eq!(h.voice_summary.as_deref(), Some(vs));
        assert!(!h.summary_payload.to_string().contains("abcdefghijklmnopq"));
        assert_eq!(latest_voice_summary(&c, "prompter").unwrap().unwrap().1, vs);
        assert!(latest_voice_summary(&c, "coder").unwrap().is_none());
        // Unspeakable summaries are dropped, not stored.
        assert_eq!(clean_voice_summary("{\"a\":1}", &[]), None);
        assert_eq!(clean_voice_summary("```html\n<div>hi</div>\n```", &[]), None);
        assert_eq!(clean_voice_summary("  **Done** — the card is *built*.  ", &[]).as_deref(), Some("Done — the card is built."));
    }

    #[test]
    fn status_summary_and_mirror_snapshot() {
        let mut c = mem();
        let a = mk(&mut c, "alpha task");
        start_spec(&mut c, &a.task_id);
        let b = mk(&mut c, "beta task");
        fail(&mut c, &b.task_id, Expect { status: "queued", stage: None, lease: None }, "system", "nope", &[]).unwrap();
        let s = status_summary(&c).unwrap();
        assert_eq!((s.counts["prompting"], s.counts["failed"], s.counts["queued"]), (1, 1, 0));
        assert_eq!(s.active.len(), 1);
        assert_eq!(s.active[0].last_handoff.as_ref().unwrap().stage.as_deref(), Some("spec"));
        assert_eq!(s.recent[0].task_id, b.task_id);
        let full = get(&c, &a.task_id).unwrap().unwrap();
        let snap = mirror_snapshot(&full);
        assert!(snap.to_string().len() <= MIRROR_MAX);
        assert_eq!(snap["task_id"], a.task_id.as_str());
        assert!(snap.get("prompt_spec").is_none());
        set_memory_doc(&c, &a.task_id, r"D:\x\memory\tony\ideas\2026-11-19-alpha.md").unwrap();
        assert!(get(&c, &a.task_id).unwrap().unwrap().raw_intent.memory_reference["memoryDoc"].as_str().unwrap().ends_with("alpha.md"));
    }

    #[test]
    fn memory_doc_path_is_stored_verbatim_but_known_secrets_still_go() {
        let mut c = mem();
        let a = mk(&mut c, "status card");
        let path = "C:/Users/nicho/AppData/Local/Temp/claude/5c24697b0373cc22/9d6851da-3c2b-4105-8776-21872b819875/scratchpad/smoke-lmstudio-20261119-064010/notes/ideas/2026-11-19-minimal-status-card.md";
        let mut mref = Map::new();
        mref.insert("memoryDoc".into(), json!(path));
        mref.insert("thread".into(), json!("see Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z and api_key=abcdef1234567890"));
        let patch = Patch { memory_reference: Some(mref), ..Default::default() };
        transition(&mut c, &a.task_id, Expect { status: "queued", stage: None, lease: None }, Next::stage("spec").unwrap(), &patch, &HandoffRow::new("tony", "prompter", "stage_started", "handoff", "spec"), &[]).unwrap();
        let e = get(&c, &a.task_id).unwrap().unwrap();
        assert_eq!(e.raw_intent.memory_reference["memoryDoc"], path);
        let other = e.raw_intent.memory_reference["thread"].as_str().unwrap();
        assert!(!other.contains("Ab3dEf6h") && !other.contains("abcdef1234567890") && other.contains("[redacted]"), "{other}");

        // A known secret value inside the path is still replaced.
        let b = mk(&mut c, "second card");
        let known = vec!["hunter2-secret".to_string()];
        let mut mref = Map::new();
        mref.insert("memoryDoc".into(), json!("D:/notes/hunter2-secret/ideas/x.md"));
        let patch = Patch { memory_reference: Some(mref), ..Default::default() };
        transition(&mut c, &b.task_id, Expect { status: "queued", stage: None, lease: None }, Next::stage("spec").unwrap(), &patch, &HandoffRow::new("tony", "prompter", "stage_started", "handoff", "spec"), &known).unwrap();
        let e = get(&c, &b.task_id).unwrap().unwrap();
        assert_eq!(e.raw_intent.memory_reference["memoryDoc"], "D:/notes/[redacted]/ideas/x.md");
    }

    #[test]
    fn read_only_connection_cannot_write() {
        let dir = tmp("ro");
        let store = TaskStore::default();
        store.init(&dir).unwrap();
        store.create(&new("read me"), &[]).unwrap();
        let ro = store.read_only().unwrap();
        let n: i64 = ro.query_row("SELECT COUNT(*) FROM task_envelope", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(ro.execute("UPDATE task_envelope SET title = 'x'", []).is_err());
        assert!(ro.execute("INSERT INTO envelope_meta (key, value) VALUES ('a','b')", []).is_err());
        assert!(ro.execute_batch("PRAGMA query_only = OFF; DELETE FROM envelope_meta").is_err(), "READ_ONLY open still refuses");
        drop(ro);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn thread_map_and_meta() {
        let c = mem();
        assert_eq!(thread_get(&c, "http://x", "booking", "tony-2026-11").unwrap(), None);
        thread_put(&c, "http://x", "booking", "tony-2026-11", "abc").unwrap();
        thread_put(&c, "http://x", "booking", "tony-2026-11", "def").unwrap();
        assert_eq!(thread_get(&c, "http://x", "booking", "tony-2026-11").unwrap().as_deref(), Some("def"));
        meta_set(&c, "k", "v").unwrap();
        assert_eq!(meta_get(&c, "k").unwrap().as_deref(), Some("v"));
    }

    #[test]
    fn task_store_wrappers_run_the_full_happy_path() {
        let store = TaskStore::in_memory();
        assert_eq!(store.unavailable(), None);
        let (e, created) = store.create(&new("Build a minimal status card component"), &[]).unwrap();
        assert!(created);
        let id = e.task_id.as_str();
        let mut at = Expect { status: "queued", stage: None, lease: None };
        for (stage, from, to) in [("triage", "tony", "prompter"), ("preflight", "prompter", "librarian"), ("spec", "librarian", "prompter"), ("design", "prompter", "designer"), ("merge", "designer", "prompter"), ("code", "prompter", "coder"), ("evaluate", "coder", "prompter")] {
            let row = HandoffRow::new(from, to, "handoff", "handoff", format!("{stage} next")).detail(format!("stage:{stage}"));
            let env = store.transition(id, at, Next::stage(stage).unwrap(), &Patch::default(), &row, &[]).unwrap();
            assert_eq!(env.stage.as_deref(), Some(stage));
            at = Expect { status: stage_defaults(stage).unwrap().0, stage: Some(stage), lease: None };
        }
        match store.bump_iteration(id, at, Next::stage("code").unwrap(), &HandoffRow::new("prompter", "coder", "loop_iteration", "milestone", "One more pass"), &[]).unwrap() {
            Bump::Looped(env, h) => {
                assert_eq!(env.iteration_count, 1);
                assert_eq!(h.unwrap().iteration, Some(1));
            }
            Bump::Failed(..) => panic!("should loop"),
        }
        let done = store
            .transition(id, Expect { status: "coding", stage: Some("code"), lease: None }, Next::stage("done").unwrap(), &Patch { code_artifacts: Some(json!([{ "path": "staging/status-card/index.html", "sha256": "ab", "bytes": 10, "iteration": 1 }])), lease_until: Some(Some(1)), ..Default::default() }, &HandoffRow::new("coder", "staging", "review_ready", "milestone", "Ready for review"), &[])
            .unwrap();
        assert_eq!((done.status.as_str(), done.current_owner.as_str(), done.lease_until), ("review_ready", "staging", None), "terminal clears the lease");
        assert_eq!(done.code_artifacts[0]["iteration"], 1);
        assert_eq!(done.handoff_log[2].detail_ref.as_deref(), Some("stage:preflight"));
        assert!(done.handoff_log.iter().any(|h| h.from_agent == "librarian"), "the Librarian appears in the log, never as owner");
        let (other, _) = store.create(&new("second"), &[]).unwrap();
        let failed = store.fail(&other.task_id, Expect { status: "queued", stage: None, lease: None }, "system", "cancelled by Nic", &[]).unwrap();
        assert_eq!(failed.error.as_deref(), Some("cancelled by Nic"));
        let all = store.with(|c| list(c, None, 10, true)).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|e| !e.handoff_log.is_empty()));
        assert_eq!(store.with(|c| list(c, Some("failed"), 10, false)).unwrap().len(), 1);
        assert!(store.with(|c| list(c, Some("done"), 10, false)).is_err());
    }

    /// Forward-compat (binding): agent ids are pattern-checked in SQL, never a closed role list, so
    /// a future node (Security Patrol, Finance) needs a registry entry, not a migration rewrite.
    #[test]
    fn agent_ids_are_pattern_checked_in_sql_not_role_listed() {
        let mut c = mem();
        let e = mk(&mut c, "x task");
        let id = e.task_id.as_str();
        let ins = |c: &Connection, from: &str, to: &str| c.execute("INSERT INTO handoff_log (task_id, timestamp, from_agent, to_agent, event_type, severity, short_summary) VALUES (?1, 1, ?2, ?3, 'note', 'verbose', 'z')", params![id, from, to]);
        assert!(ins(&c, "security_patrol", "tony").is_ok(), "a new agent id fits the schema");
        assert!(ins(&c, "tony", "finance-2").is_ok());
        for bad in ["Tony", "1coder", "", "has space", "x;drop", &"a".repeat(33)] {
            assert!(ins(&c, bad, "tony").is_err(), "from_agent {bad:?}");
            assert!(ins(&c, "tony", bad).is_err(), "to_agent {bad:?}");
        }
        assert!(c.execute("UPDATE task_envelope SET current_owner = 'security_patrol' WHERE task_id = ?1", params![id]).is_ok());
        assert!(c.execute("UPDATE task_envelope SET current_owner = 'Bad Owner' WHERE task_id = ?1", params![id]).is_err());
        // The schema text itself names no role.
        let ddl: String = c.query_row("SELECT group_concat(sql, ' ') FROM sqlite_master WHERE name IN ('task_envelope','handoff_log')", [], |r| r.get(0)).unwrap();
        assert!(!ddl.contains("'prompter'") && !ddl.contains("'designer'"), "{ddl}");
        // Rust still validates against the registry (and the id pattern) before SQL.
        let r = HandoffRow::new("security_patrol", "tony", "note", "verbose", "x");
        assert!(r.validated(&[]).unwrap_err().contains("must be one of"));
        let r = HandoffRow::new("Bad Agent", "tony", "note", "verbose", "x");
        assert!(r.validated(&[]).unwrap_err().contains("agent id"));
    }

    /// Regression: a `claim_next` lease left on a still-`queued` row (the app closed while the
    /// worker waited for Tony) used to hide the task for ~46 minutes after a restart.
    #[test]
    fn recovery_clears_a_claim_lease_left_on_a_queued_row() {
        let mut c = mem();
        let a = mk(&mut c, "approved build");
        let now = now_ms();
        let claimed = claim_next(&mut c, now, 2_750_000).unwrap().unwrap();
        assert_eq!((claimed.status.as_str(), claimed.lease_until.is_some()), ("queued", true));
        assert!(claim_next(&mut c, now_ms(), 60_000).unwrap().is_none(), "hidden while leased");
        let rec = recover_interrupted(&mut c).unwrap();
        assert!(rec.is_empty(), "a queued row gains no interrupted row");
        let after = get(&c, &a.task_id).unwrap().unwrap();
        assert_eq!((after.status.as_str(), after.lease_until, after.handoff_log.len()), ("queued", None, 1));
        assert_eq!(claim_next(&mut c, now_ms(), 60_000).unwrap().unwrap().task_id, a.task_id, "claimable right after the restart");
    }

    #[test]
    fn release_claim_gives_back_only_its_own_lease() {
        let mut c = mem();
        let a = mk(&mut c, "approved build");
        let l = claim_next(&mut c, now_ms(), 60_000).unwrap().unwrap().lease_until.unwrap();
        assert!(!release_claim(&c, &a.task_id, l + 1).unwrap(), "another claim's lease is untouched");
        assert!(release_claim(&c, &a.task_id, l).unwrap());
        assert_eq!(get_bare(&c, &a.task_id).unwrap().unwrap().lease_until, None);
    }

    /// Regression: the optimistic check compared only (status, stage), so a run whose task was
    /// cancelled and retried meanwhile committed its stale result. The lease is the claim token.
    #[test]
    fn a_lease_token_makes_a_cancelled_then_retried_run_stale() {
        let mut c = mem();
        let a = mk(&mut c, "approved build");
        let l1 = now_ms() + 600_000;
        let run = transition(&mut c, &a.task_id, Expect { status: "queued", stage: None, lease: None }, Next::stage("code").unwrap(), &Patch { lease_until: Some(Some(l1)), ..Default::default() }, &HandoffRow::new("coder", "coder", "stage_started", "verbose", "Coder is building"), &[]).unwrap().0;
        assert_eq!(run.lease_until, Some(l1));
        // Cancel (terminal: lease cleared), then retry back into the same (status, stage).
        let cur = get_bare(&c, &a.task_id).unwrap().unwrap();
        fail(&mut c, &a.task_id, Expect { status: &cur.status, stage: cur.stage.as_deref(), lease: cur.lease_until }, "tony", "cancelled by user", &[]).unwrap();
        transition(&mut c, &a.task_id, Expect { status: "failed", stage: Some("code"), lease: None }, Next::stage("code").unwrap(), &Patch { error: Some(None), lease_until: Some(None), ..Default::default() }, &HandoffRow::new("tony", "coder", "retry", "handoff", "Retrying from code"), &[]).unwrap();
        let rows = get(&c, &a.task_id).unwrap().unwrap().handoff_log.len();
        // The original run returns: (coding, code) matches again, its lease token does not.
        let old = Expect { status: "coding", stage: Some("code"), lease: Some(l1) };
        let err = transition(&mut c, &a.task_id, old, Next::stage("evaluate").unwrap(), &Patch::default(), &HandoffRow::new("coder", "system", "stage_completed", "handoff", "stale result"), &[]).unwrap_err();
        assert!(err.starts_with("STALE"), "{err}");
        let err = fail(&mut c, &a.task_id, old, "coder", "old timeout", &[]).unwrap_err();
        assert!(err.starts_with("STALE"), "{err}");
        let e = get(&c, &a.task_id).unwrap().unwrap();
        assert_eq!((e.status.as_str(), e.stage.as_deref(), e.error.as_deref(), e.handoff_log.len()), ("coding", Some("code"), None, rows), "nothing written");
        // A fresh claim's token commits.
        let l2 = l1 + 1;
        transition(&mut c, &a.task_id, Expect { status: "coding", stage: Some("code"), lease: None }, Next::stage("code").unwrap(), &Patch { lease_until: Some(Some(l2)), ..Default::default() }, &HandoffRow::new("coder", "coder", "stage_started", "verbose", "Coder is building"), &[]).unwrap();
        assert!(transition(&mut c, &a.task_id, Expect { status: "coding", stage: Some("code"), lease: Some(l2) }, Next::stage("evaluate").unwrap(), &Patch::default(), &HandoffRow::new("coder", "system", "stage_completed", "handoff", "fresh result"), &[]).is_ok());
    }

    #[test]
    fn stage_defaults_cover_every_stage() {
        for s in STAGES {
            let (st, ow) = stage_defaults(s).unwrap();
            assert!(STATUSES.contains(&st) && OWNERS.contains(&ow), "{s}");
        }
        assert_eq!(stage_defaults("preflight"), Some(("prompting", "prompter")));
        assert!(stage_defaults("deploy").is_none());
    }
}
