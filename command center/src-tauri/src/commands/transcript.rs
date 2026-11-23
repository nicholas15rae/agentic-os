//! Agent Conversation transcript: the reviewable record of what Tony and the agents said to each
//! other (prompts, replies, hand-offs, questions, overrides, smoke verdicts…), one chat thread per
//! task or delegation.
//!
//! - A SEPARATE Rust-owned SQLite file, `<app config dir>/transcripts.db`. Not a table in tasks.db:
//!   the Librarian reads tasks.db as "compact structured rows, never raw logs", and a migration
//!   there would lock an older binary out. Same pattern as tasks.db: a `user_version` ladder, WAL,
//!   `busy_timeout 3000`, a lazily reopened `Mutex<Option<Connection>>`, `in_memory()` for tests.
//! - Only Rust writes it; the webview gets read commands. Every string is scrubbed with
//!   `devqueue::scrub` (known values + key patterns) and capped before it is stored. Nothing here
//!   is ever fed back into a prompt, and the Librarian never opens this file.
//! - `message` is append-only (UPDATE aborts in a trigger); rows leave only through `prune()`,
//!   by the conversation cascade.
//! - Recording is best-effort: a hook never fails, panics or delays a stage, a turn or an enqueue
//!   (an error is logged once and the caller carries on). Uninitialised (unit tests) = no-op.
//! - Live updates: `agent-transcript` carries the conversation summary and the message HEAD (no
//!   body). The webview rebuilds from `transcript_conversations` / `transcript_get` after a
//!   restart or reload and never relies on bus delivery.
#![cfg_attr(not(test), allow(dead_code))]

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use super::devqueue::{scrub, scrub_value};
use super::envelope::{clip, one_line, Envelope, HandoffEntry, TaskStore};

pub const EVENT_NAME: &str = "agent-transcript";
/// One line.
pub const SUMMARY_MAX: usize = 160;
/// Stored chars of a body.
pub const BODY_MAX: usize = 16_384;
/// Head kept on truncation.
pub const BODY_HEAD: usize = 12_000;
/// Tail kept on truncation.
pub const BODY_TAIL: usize = 4_000;
pub const TITLE_MAX: usize = 120;
/// Past this many messages a conversation keeps only `KEEP_PAST_CAP` kinds; others count in `dropped`.
pub const MESSAGES_PER_CONV_MAX: i64 = 800;
/// Absolute ceiling (even `KEEP_PAST_CAP` kinds): a runaway loop can't grow one conversation forever.
pub const MESSAGES_HARD_MAX: i64 = MESSAGES_PER_CONV_MAX * 2;
/// Prune the oldest (terminal, or idle > `RETENTION_DAYS`) root conversations beyond this.
pub const CONVERSATIONS_MAX: i64 = 400;
pub const RETENTION_DAYS: i64 = 30;
pub const PAGE_MAX: u32 = 400;
pub const KINDS: [&str; 12] = ["prompt", "reply", "handoff", "status", "question", "answer", "override", "repair", "smoke", "error", "retry", "note"];
pub const CONV_KINDS: [&str; 4] = ["task", "hub", "turn", "dev"];
pub const KEEP_PAST_CAP: [&str; 5] = ["handoff", "error", "smoke", "repair", "override"];
/// Mirrors TS `THREADS` (voice-store.ts).
pub const THREADS: [&str; 9] = ["auto", "general", "prompter", "designer", "director", "coder", "booking", "librarian", "ops"];
/// Conversation statuses that make a conversation prunable once over the cap.
pub const TERMINAL_STATUSES: [&str; 7] = ["review_ready", "failed", "done", "deployed", "ready_for_merge", "cancelled", "removed"];
const DB_FILE: &str = "transcripts.db";
const CONV_ID_MAX: usize = 120;

// ── Schema ──────────────────────────────────────────────────────────────────

fn sql_list(list: &[&str]) -> String {
    list.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",")
}

/// `PRAGMA user_version` ladder: entry `i` takes the schema from version `i` to `i + 1`.
/// Append new steps; never edit a shipped one.
fn migrations() -> &'static [String] {
    static M: OnceLock<Vec<String>> = OnceLock::new();
    M.get_or_init(|| {
        vec![format!(
            "CREATE TABLE conversation (
               conv_id          TEXT PRIMARY KEY CHECK (length(conv_id) BETWEEN 3 AND {CONV_ID_MAX}),
               kind             TEXT NOT NULL CHECK (kind IN ({conv_kinds})),
               title            TEXT NOT NULL DEFAULT '' CHECK (length(title) <= {TITLE_MAX}),
               thread           TEXT NOT NULL DEFAULT 'auto' CHECK (length(thread) <= 32),
               parent_conv_id   TEXT,
               task_id          TEXT,
               status           TEXT CHECK (status IS NULL OR length(status) <= 32),
               created_at       INTEGER NOT NULL,
               updated_at       INTEGER NOT NULL,
               message_count    INTEGER NOT NULL DEFAULT 0,
               dropped          INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX conv_updated ON conversation(updated_at);
             CREATE INDEX conv_parent ON conversation(parent_conv_id);
             CREATE TABLE message (
               seq              INTEGER PRIMARY KEY AUTOINCREMENT,
               conv_id          TEXT NOT NULL REFERENCES conversation(conv_id) ON DELETE CASCADE,
               at               INTEGER NOT NULL,
               from_agent       TEXT NOT NULL CHECK ({from_check}),
               to_agent         TEXT NOT NULL CHECK ({to_check}),
               kind             TEXT NOT NULL CHECK (kind IN ({kinds})),
               stage            TEXT,
               iteration        INTEGER,
               summary          TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND {SUMMARY_MAX}),
               body             TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 16500),
               original_chars   INTEGER NOT NULL DEFAULT 0,
               truncated        INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
               ok               INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
               handoff_seq      INTEGER
             );
             CREATE INDEX msg_conv ON message(conv_id, at, seq);
             CREATE UNIQUE INDEX msg_handoff ON message(conv_id, handoff_seq) WHERE handoff_seq IS NOT NULL;
             CREATE TRIGGER message_no_update BEFORE UPDATE ON message
               BEGIN SELECT RAISE(ABORT, 'message is append-only'); END;",
            conv_kinds = sql_list(&CONV_KINDS),
            kinds = sql_list(&KINDS),
            from_check = super::envelope::agent_id_check("from_agent"),
            to_check = super::envelope::agent_id_check("to_agent"),
        )]
    })
}

fn sql_err(e: rusqlite::Error) -> String {
    format!("transcript store: {e}")
}

/// Bring `conn` up to the latest schema. A database written by a newer app is refused.
pub(crate) fn migrate(conn: &mut Connection) -> Result<u32, String> {
    let steps = migrations();
    let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(sql_err)?;
    if v as usize > steps.len() {
        return Err(format!("transcript store: {DB_FILE} is schema v{v}, newer than this app (v{})", steps.len()));
    }
    for (i, step) in steps.iter().enumerate().skip(v as usize) {
        let tx = conn.transaction().map_err(sql_err)?;
        tx.execute_batch(step).map_err(sql_err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
    }
    Ok(steps.len() as u32)
}

fn open_db(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(sql_err)?;
    conn.busy_timeout(Duration::from_millis(3000)).map_err(sql_err)?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql_err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON").map_err(sql_err)?;
    migrate(&mut conn)?;
    Ok(conn)
}

// ── Wire types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptConversation {
    pub conv_id: String,
    pub kind: String,
    pub title: String,
    pub thread: String,
    pub parent_conv_id: Option<String>,
    pub task_id: Option<String>,
    pub status: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: u32,
    pub dropped: u32,
    pub last_from: Option<String>,
    pub last_to: Option<String>,
    pub last_summary: Option<String>,
    pub last_kind: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHead {
    pub seq: i64,
    pub conv_id: String,
    pub at: i64,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub stage: Option<String>,
    pub iteration: Option<u32>,
    pub summary: String,
    pub body_chars: u32,
    pub original_chars: u32,
    pub truncated: bool,
    pub ok: bool,
    pub handoff_seq: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    #[serde(flatten)]
    pub head: TranscriptHead,
    pub body: String,
}

/// Payload of `agent-transcript`: the conversation after the append, and the new message's head.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    pub conv: TranscriptConversation,
    pub message: TranscriptHead,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub conv: TranscriptConversation,
    pub messages: Vec<TranscriptHead>,
    pub children: Vec<TranscriptConversation>,
    pub more: bool,
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/// A conversation to open (`INSERT OR IGNORE`; empty fields of an existing one are filled).
#[derive(Clone, Debug, Default)]
pub struct OpenConv {
    pub conv_id: String,
    pub kind: &'static str,
    pub title: String,
    pub thread: Option<String>,
    pub parent: Option<String>,
    pub task_id: Option<String>,
}

/// One message to append (validated, scrubbed and capped on write).
#[derive(Clone, Debug)]
pub struct NewMessage {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
    pub stage: Option<String>,
    pub iteration: Option<u32>,
    pub summary: String,
    pub body: String,
    pub ok: bool,
    pub handoff_seq: Option<i64>,
    /// Unix ms; None = now.
    pub at: Option<i64>,
}

impl NewMessage {
    pub fn new(from: &str, to: &str, kind: &'static str, summary: impl Into<String>) -> Self {
        Self { from: from.into(), to: to.into(), kind, stage: None, iteration: None, summary: summary.into(), body: String::new(), ok: true, handoff_seq: None, at: None }
    }
    pub fn body(mut self, b: impl Into<String>) -> Self {
        self.body = b.into();
        self
    }
    pub fn stage(mut self, s: Option<&str>, it: Option<u32>) -> Self {
        self.stage = s.map(str::to_string);
        self.iteration = it;
        self
    }
    pub fn failed(mut self) -> Self {
        self.ok = false;
        self
    }
    pub fn at(mut self, at: i64) -> Self {
        self.at = Some(at);
        self
    }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/// A participant id for the transcript: `os` / `general` → `tony`, `user` → `nic`, a tool id
/// (`spotify.play`) → `tool`, anything else that isn't an agent id → `system`.
pub fn participant(id: &str) -> String {
    let s = one_line(id).to_lowercase();
    let s = match s.as_str() {
        "os" | "general" => "tony".to_string(),
        "user" => "nic".to_string(),
        _ => s,
    };
    if s.contains('.') {
        return "tool".into();
    }
    let s: String = s.chars().take(32).collect();
    if super::roles::valid_agent_id(&s) {
        s
    } else {
        "system".into()
    }
}

/// The chat thread a conversation's card lands in: a known thread, else Tony's main one ("auto";
/// never the hidden "general" fallback). A phone source maps to "auto" too.
pub fn conv_thread(t: Option<&str>) -> String {
    t.map(str::trim).filter(|t| THREADS.contains(t)).unwrap_or("auto").to_string()
}

/// Keep `s` whole up to `BODY_MAX` chars; past that keep the first `BODY_HEAD` and the last
/// `BODY_TAIL` around a visible marker. Returns `(text, original chars, truncated)`.
pub fn clip_body(s: &str) -> (String, u32, bool) {
    let n = s.chars().count();
    if n <= BODY_MAX {
        return (s.to_string(), n as u32, false);
    }
    let head: String = s.chars().take(BODY_HEAD).collect();
    let tail: String = s.chars().skip(n - BODY_TAIL).collect();
    (format!("{head}\n…[truncated: kept the first {BODY_HEAD} and last {BODY_TAIL} of {n} characters]…\n{tail}"), n.min(u32::MAX as usize) as u32, true)
}

fn clean_summary_or(s: &str, known: &[String], fallback: &str) -> String {
    let s = one_line(&scrub(s, known));
    let s = if s.chars().any(char::is_alphanumeric) { s } else { fallback.to_string() };
    clip(&s, SUMMARY_MAX)
}

/// Scrubbed, one line, capped at `SUMMARY_MAX`. Never empty.
pub fn clean_summary(s: &str, known: &[String]) -> String {
    clean_summary_or(s, known, "note")
}

/// Scrubbed (known values + key patterns), then `clip_body`.
pub fn clean_body(s: &str, known: &[String]) -> (String, u32, bool) {
    clip_body(&scrub(s, known))
}

/// `[A-Za-z0-9:_#.-]` only, at most 120 chars.
fn sanitize_id(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '#' | '.' | '-')).take(CONV_ID_MAX).collect()
}

pub fn task_conv(task_id: &str) -> String {
    sanitize_id(&format!("task:{task_id}"))
}
pub fn hub_conv(build_id: &str) -> String {
    sanitize_id(&format!("hub:{build_id}"))
}
pub fn dev_conv(dev_id: &str) -> String {
    sanitize_id(&format!("dev:{dev_id}"))
}
pub fn turn_conv(id: &str) -> String {
    sanitize_id(&format!("turn:{id}"))
}

/// The task conversation for an envelope (title, the thread it was asked in, its task id).
pub fn task_open(env: &Envelope) -> OpenConv {
    OpenConv {
        conv_id: task_conv(&env.task_id),
        kind: "task",
        title: env.title.clone(),
        thread: Some(conv_thread(env.raw_intent.memory_reference["thread"].as_str())),
        parent: None,
        task_id: Some(env.task_id.clone()),
    }
}

/// The transcript message a committed handoff row stands for. `to` is the row's own recipient
/// (never the post-commit owner). The body carries what the row's chat line leaves out: the
/// agent's spoken summary, the structured payload, the detail ref and — for `task_queued` — the
/// full brief Tony sent.
pub fn entry_message(h: &HandoffEntry, env: &Envelope) -> NewMessage {
    let et = h.event_type.as_str();
    // An error is never hidden as a status line, even a self-addressed one.
    let kind: &'static str = if matches!(et, "failed" | "discrepancy") {
        "error"
    } else if et == "retry" {
        "retry"
    } else if h.from_agent == h.to_agent || matches!(et, "stage_started" | "progress" | "note" | "interrupted") {
        "status"
    } else {
        "handoff"
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = &h.voice_summary {
        parts.push(format!("Said: {v}"));
    }
    let payload_empty = match &h.summary_payload {
        Value::Object(o) => o.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Null => true,
        _ => false,
    };
    if !payload_empty {
        if let Ok(p) = serde_json::to_string_pretty(&scrub_value(&h.summary_payload, &[])) {
            parts.push(p);
        }
    }
    if let Some(d) = &h.detail_ref {
        parts.push(format!("Detail: {d}"));
    }
    if et == "task_queued" {
        parts.push(format!("Brief from Tony:\n{}", env.raw_intent.text));
    }
    let mut m = NewMessage::new(&h.from_agent, &h.to_agent, kind, h.short_summary.clone()).body(parts.join("\n\n")).stage(h.stage.as_deref(), h.iteration).at(h.timestamp);
    m.handoff_seq = Some(h.seq);
    if kind == "error" {
        m.ok = false;
    }
    m
}

/// The transcript of one delegated Tony turn: Nic's request, every step (hand-off, reply, error,
/// step-in, tool, overseer), then Tony's answer or the error. Pure.
pub fn turn_messages(request: &str, steps: &[(String, String, String, String, bool)], answer: Option<&str>, error: Option<&str>) -> Vec<NewMessage> {
    let mut out = vec![NewMessage::new("nic", "tony", "prompt", request).body(request)];
    for (kind, from, to, text, ok) in steps {
        let k: &'static str = match kind.as_str() {
            "delegate" => "handoff",
            "reply" | "overseer" => "reply",
            "error" => "error",
            _ => "note",
        };
        let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or(kind.as_str());
        let mut m = NewMessage::new(from, to, k, first).body(text.as_str());
        if !ok || k == "error" {
            m.ok = false;
        }
        out.push(m);
    }
    if let Some(a) = answer.filter(|a| !a.trim().is_empty()) {
        out.push(NewMessage::new("tony", "nic", "reply", a).body(a));
    }
    if let Some(e) = error {
        out.push(NewMessage::new("tony", "nic", "error", e).body(e).failed());
    }
    out
}

// ── Rows ────────────────────────────────────────────────────────────────────

const CONV_SELECT: &str = "SELECT c.conv_id, c.kind, c.title, c.thread, c.parent_conv_id, c.task_id, c.status, c.created_at, c.updated_at, c.message_count, c.dropped,
       m.from_agent, m.to_agent, m.summary, m.kind
  FROM conversation c
  LEFT JOIN message m ON m.seq = (SELECT seq FROM message WHERE conv_id = c.conv_id ORDER BY at DESC, seq DESC LIMIT 1)";

fn row_conv(r: &Row) -> rusqlite::Result<TranscriptConversation> {
    Ok(TranscriptConversation {
        conv_id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        thread: r.get(3)?,
        parent_conv_id: r.get(4)?,
        task_id: r.get(5)?,
        status: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        message_count: r.get::<_, i64>(9)?.clamp(0, u32::MAX as i64) as u32,
        dropped: r.get::<_, i64>(10)?.clamp(0, u32::MAX as i64) as u32,
        last_from: r.get(11)?,
        last_to: r.get(12)?,
        last_summary: r.get(13)?,
        last_kind: r.get(14)?,
    })
}

const HEAD_COLS: &str = "seq, conv_id, at, from_agent, to_agent, kind, stage, iteration, summary, length(body), original_chars, truncated, ok, handoff_seq";

fn row_head(r: &Row) -> rusqlite::Result<TranscriptHead> {
    Ok(TranscriptHead {
        seq: r.get(0)?,
        conv_id: r.get(1)?,
        at: r.get(2)?,
        from: r.get(3)?,
        to: r.get(4)?,
        kind: r.get(5)?,
        stage: r.get(6)?,
        iteration: r.get::<_, Option<i64>>(7)?.map(|i| i.clamp(0, u32::MAX as i64) as u32),
        summary: r.get(8)?,
        body_chars: r.get::<_, i64>(9)?.clamp(0, u32::MAX as i64) as u32,
        original_chars: r.get::<_, i64>(10)?.clamp(0, u32::MAX as i64) as u32,
        truncated: r.get::<_, i64>(11)? != 0,
        ok: r.get::<_, i64>(12)? != 0,
        handoff_seq: r.get(13)?,
    })
}

fn conv_get(c: &Connection, conv_id: &str) -> Result<Option<TranscriptConversation>, String> {
    c.query_row(&format!("{CONV_SELECT} WHERE c.conv_id = ?1"), params![conv_id], row_conv).optional().map_err(sql_err)
}

fn head_get(c: &Connection, seq: i64) -> Result<Option<TranscriptHead>, String> {
    c.query_row(&format!("SELECT {HEAD_COLS} FROM message WHERE seq = ?1"), params![seq], row_head).optional().map_err(sql_err)
}

fn now_ms() -> i64 {
    super::devqueue::now_ms()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ── Store ───────────────────────────────────────────────────────────────────

/// The transcript store. If transcripts.db can't be opened the app keeps running and every hook
/// is a no-op (`unavailable()` says why).
#[derive(Default)]
pub struct TranscriptStore {
    conn: Mutex<Option<Connection>>,
    path: Mutex<Option<PathBuf>>,
    unavailable: Mutex<Option<String>>,
    appends: AtomicU64,
    /// A hook already logged an error (logged once per process, never per call).
    warned: AtomicBool,
}

impl TranscriptStore {
    /// Open (or create) `<dir>/transcripts.db`, migrate, prune. On failure: logged, remembered.
    pub fn init(&self, dir: &Path) -> Result<(), String> {
        let path = dir.join(DB_FILE);
        *lock(&self.path) = Some(path.clone());
        match std::fs::create_dir_all(dir).map_err(|e| e.to_string()).and_then(|_| open_db(&path)) {
            Ok(c) => {
                *lock(&self.conn) = Some(c);
                *lock(&self.unavailable) = None;
                if let Err(e) = self.prune(now_ms()) {
                    eprintln!("[transcript] prune: {e}");
                }
                Ok(())
            }
            Err(e) => {
                eprintln!("[transcript] {e}; the agent conversation feed is off");
                *lock(&self.unavailable) = Some(e.clone());
                Err(e)
            }
        }
    }

    pub fn unavailable(&self) -> Option<String> {
        lock(&self.unavailable).clone()
    }

    /// Initialised (a file, or an in-memory test store) and not known-broken.
    fn ready(&self) -> bool {
        (lock(&self.conn).is_some() || lock(&self.path).is_some()) && self.unavailable().is_none()
    }

    fn warn(&self, e: &str) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            eprintln!("[transcript] {e} (further transcript errors are not logged)");
        }
    }

    /// Run `f` on the connection. Never hold this across an `.await`.
    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut g = lock(&self.conn);
        if g.is_none() {
            let path = lock(&self.path).clone().ok_or("transcript store isn't initialised")?;
            *g = Some(open_db(&path)?);
            *lock(&self.unavailable) = None;
        }
        f(g.as_mut().expect("connection just opened"))
    }

    /// Open a conversation (`INSERT OR IGNORE`); an existing one gets its empty title / parent /
    /// task id, and a specific thread over "auto", filled in.
    pub fn open(&self, o: &OpenConv, known: &[String]) -> Result<TranscriptConversation, String> {
        let id = sanitize_id(&o.conv_id);
        if id != o.conv_id || id.len() < 3 {
            return Err(format!("conversation id must be 3–{CONV_ID_MAX} of [A-Za-z0-9:_#.-]"));
        }
        if !CONV_KINDS.contains(&o.kind) {
            return Err(format!("conversation kind must be one of: {}", CONV_KINDS.join(", ")));
        }
        let title = clip(&one_line(&scrub(&o.title, known)), TITLE_MAX);
        let thread = conv_thread(o.thread.as_deref());
        let parent = o.parent.as_deref().map(sanitize_id).filter(|p| p.len() >= 3 && *p != id);
        let task_id = o.task_id.as_deref().map(|t| clip(&one_line(t), 80)).filter(|t| !t.is_empty());
        self.with(|c| {
            let now = now_ms();
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
            tx.execute(
                "INSERT OR IGNORE INTO conversation (conv_id, kind, title, thread, parent_conv_id, task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, o.kind, title, thread, parent, task_id, now],
            )
            .map_err(sql_err)?;
            tx.execute(
                "UPDATE conversation SET
                   title = CASE WHEN title = '' THEN ?2 ELSE title END,
                   thread = CASE WHEN thread = 'auto' AND ?3 != 'auto' THEN ?3 ELSE thread END,
                   parent_conv_id = COALESCE(parent_conv_id, ?4),
                   task_id = COALESCE(task_id, ?5)
                 WHERE conv_id = ?1",
                params![id, title, thread, parent, task_id],
            )
            .map_err(sql_err)?;
            let conv = conv_get(&tx, &id)?.ok_or("transcript store: conversation vanished")?;
            tx.commit().map_err(sql_err)?;
            Ok(conv)
        })
    }

    /// Append one message. `Ok(None)`: a duplicate `handoff_seq`, or dropped past the cap
    /// (`dropped` counts it). Bumps `message_count` / `updated_at` in the same transaction.
    pub fn append(&self, conv_id: &str, m: &NewMessage, known: &[String]) -> Result<Option<TranscriptEvent>, String> {
        if !KINDS.contains(&m.kind) {
            return Err(format!("message kind must be one of: {}", KINDS.join(", ")));
        }
        let from = participant(&m.from);
        let to = participant(&m.to);
        let summary = clean_summary_or(&m.summary, known, m.kind);
        let (body, original, truncated) = clean_body(&m.body, known);
        let stage = m.stage.as_deref().map(|s| clip(&one_line(s), 32)).filter(|s| !s.is_empty());
        let at = m.at.unwrap_or_else(now_ms);
        let ev = self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
            let count: Option<i64> = tx.query_row("SELECT message_count FROM conversation WHERE conv_id = ?1", params![conv_id], |r| r.get(0)).optional().map_err(sql_err)?;
            let Some(count) = count else { return Err("no such conversation".to_string()) };
            if let Some(hs) = m.handoff_seq {
                let dup: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM message WHERE conv_id = ?1 AND handoff_seq = ?2)", params![conv_id, hs], |r| r.get(0)).map_err(sql_err)?;
                if dup {
                    return Ok(None);
                }
            }
            if count >= MESSAGES_HARD_MAX || (count >= MESSAGES_PER_CONV_MAX && !KEEP_PAST_CAP.contains(&m.kind)) {
                tx.execute("UPDATE conversation SET dropped = dropped + 1, updated_at = max(updated_at, ?2) WHERE conv_id = ?1", params![conv_id, at]).map_err(sql_err)?;
                tx.commit().map_err(sql_err)?;
                return Ok(None);
            }
            tx.execute(
                "INSERT INTO message (conv_id, at, from_agent, to_agent, kind, stage, iteration, summary, body, original_chars, truncated, ok, handoff_seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![conv_id, at, from, to, m.kind, stage, m.iteration.map(i64::from), summary, body, original as i64, truncated as i64, m.ok as i64, m.handoff_seq],
            )
            .map_err(sql_err)?;
            let seq = tx.last_insert_rowid();
            tx.execute(
                "UPDATE conversation SET message_count = message_count + 1, updated_at = max(updated_at, ?2), created_at = min(created_at, ?2) WHERE conv_id = ?1",
                params![conv_id, at],
            )
            .map_err(sql_err)?;
            let conv = conv_get(&tx, conv_id)?.ok_or("transcript store: conversation vanished")?;
            let head = head_get(&tx, seq)?.ok_or("transcript store: message vanished")?;
            tx.commit().map_err(sql_err)?;
            Ok(Some(TranscriptEvent { conv, message: head }))
        })?;
        if ev.is_some() && self.appends.fetch_add(1, Ordering::Relaxed) % 100 == 99 {
            if let Err(e) = self.prune(now_ms()) {
                eprintln!("[transcript] prune: {e}");
            }
        }
        Ok(ev)
    }

    pub fn set_parent(&self, conv_id: &str, parent: &str) -> Result<(), String> {
        let parent = sanitize_id(parent);
        if parent.len() < 3 || parent == conv_id {
            return Err("bad parent conversation".into());
        }
        self.with(|c| c.execute("UPDATE conversation SET parent_conv_id = ?2 WHERE conv_id = ?1", params![conv_id, parent]).map(|_| ()).map_err(sql_err))
    }

    pub fn set_status(&self, conv_id: &str, status: &str) -> Result<(), String> {
        let s = clip(&one_line(status), 32);
        self.with(|c| c.execute("UPDATE conversation SET status = ?2, updated_at = max(updated_at, ?3) WHERE conv_id = ?1", params![conv_id, s, now_ms()]).map(|_| ()).map_err(sql_err))
    }

    /// Newest first (`updated_at DESC`); `before` pages back; `roots_only` hides nested ones.
    pub fn list(&self, limit: u32, before: Option<i64>, roots_only: bool) -> Result<Vec<TranscriptConversation>, String> {
        self.with(|c| {
            let mut st = c
                .prepare(&format!("{CONV_SELECT} WHERE (?1 IS NULL OR c.updated_at < ?1) AND (?2 = 0 OR c.parent_conv_id IS NULL) ORDER BY c.updated_at DESC, c.conv_id LIMIT ?3"))
                .map_err(sql_err)?;
            let rows = st.query_map(params![before, roots_only as i64, limit.max(1) as i64], row_conv).map_err(sql_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
        })
    }

    /// One page of a conversation, `ORDER BY at, seq`, after the message `after_seq` (None = from
    /// the start), plus its nested conversations. `None` = no such conversation.
    pub fn page(&self, conv_id: &str, after_seq: Option<i64>, limit: u32) -> Result<Option<TranscriptPage>, String> {
        let limit = limit.clamp(1, PAGE_MAX) as i64;
        self.with(|c| {
            let Some(conv) = conv_get(c, conv_id)? else { return Ok(None) };
            let cursor: (i64, i64) = match after_seq {
                Some(s) => c.query_row("SELECT at, seq FROM message WHERE seq = ?1 AND conv_id = ?2", params![s, conv_id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(sql_err)?.unwrap_or((i64::MIN, s)),
                None => (i64::MIN, i64::MIN),
            };
            let mut st = c.prepare(&format!("SELECT {HEAD_COLS} FROM message WHERE conv_id = ?1 AND (at > ?2 OR (at = ?2 AND seq > ?3)) ORDER BY at, seq LIMIT ?4")).map_err(sql_err)?;
            let mut messages = st.query_map(params![conv_id, cursor.0, cursor.1, limit + 1], row_head).map_err(sql_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?;
            let more = messages.len() as i64 > limit;
            messages.truncate(limit as usize);
            let mut st = c.prepare(&format!("{CONV_SELECT} WHERE c.parent_conv_id = ?1 ORDER BY c.created_at, c.conv_id")).map_err(sql_err)?;
            let children = st.query_map(params![conv_id], row_conv).map_err(sql_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?;
            Ok(Some(TranscriptPage { conv, messages, children, more }))
        })
    }

    pub fn message(&self, seq: i64) -> Result<Option<TranscriptMessage>, String> {
        self.with(|c| {
            let Some(head) = head_get(c, seq)? else { return Ok(None) };
            let body: String = c.query_row("SELECT body FROM message WHERE seq = ?1", params![seq], |r| r.get(0)).map_err(sql_err)?;
            Ok(Some(TranscriptMessage { head, body }))
        })
    }

    /// Open the task's conversation and mirror every `handoff_log` row not in it yet (rows that
    /// were never mirrored, or arrived before the store existed). Idempotent. Returns how many
    /// were added.
    pub fn backfill_task(&self, env: &Envelope, known: &[String]) -> Result<usize, String> {
        let open = task_open(env);
        self.open(&open, known)?;
        let have: HashSet<i64> = self.with(|c| {
            let mut st = c.prepare("SELECT handoff_seq FROM message WHERE conv_id = ?1 AND handoff_seq IS NOT NULL").map_err(sql_err)?;
            let rows = st.query_map(params![open.conv_id], |r| r.get::<_, i64>(0)).map_err(sql_err)?;
            rows.collect::<rusqlite::Result<HashSet<_>>>().map_err(sql_err)
        })?;
        let mut n = 0;
        for h in env.handoff_log.iter().filter(|h| !have.contains(&h.seq)) {
            if self.append(&open.conv_id, &entry_message(h, env), known)?.is_some() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Past `CONVERSATIONS_MAX`: delete the oldest root conversations that are terminal or idle
    /// for `RETENTION_DAYS` (their nested ones and messages with them). Returns rows removed.
    pub fn prune(&self, now: i64) -> Result<usize, String> {
        let cutoff = now - RETENTION_DAYS * 24 * 3600 * 1000;
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_err)?;
            let total: i64 = tx.query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0)).map_err(sql_err)?;
            if total <= CONVERSATIONS_MAX {
                tx.commit().map_err(sql_err)?;
                return Ok(0);
            }
            let excess = (total - CONVERSATIONS_MAX) as usize;
            let ids: Vec<String> = {
                let mut st = tx
                    .prepare(&format!(
                        "SELECT conv_id FROM conversation
                          WHERE (parent_conv_id IS NULL OR parent_conv_id NOT IN (SELECT conv_id FROM conversation))
                            AND (status IN ({}) OR updated_at < ?1)
                          ORDER BY updated_at, conv_id",
                        sql_list(&TERMINAL_STATUSES)
                    ))
                    .map_err(sql_err)?;
                let rows = st.query_map(params![cutoff], |r| r.get::<_, String>(0)).map_err(sql_err)?;
                rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)?
            };
            let mut removed = 0;
            for id in ids {
                if removed >= excess {
                    break;
                }
                removed += tx.execute("DELETE FROM conversation WHERE parent_conv_id = ?1", params![id]).map_err(sql_err)?;
                removed += tx.execute("DELETE FROM conversation WHERE conv_id = ?1", params![id]).map_err(sql_err)?;
            }
            tx.commit().map_err(sql_err)?;
            Ok(removed)
        })
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate(&mut c).unwrap();
        Self { conn: Mutex::new(Some(c)), ..Default::default() }
    }
}

/// The process-wide store (`lib.rs` initialises it). Uninitialised (unit tests): every hook is a
/// silent no-op.
pub fn store() -> &'static TranscriptStore {
    static S: OnceLock<TranscriptStore> = OnceLock::new();
    S.get_or_init(TranscriptStore::default)
}

// ── Best-effort hooks (never Err, never panic, never block on the webview) ──

/// The testable core of `record`: append to `s`, emit `agent-transcript` on a new message.
pub fn record_in(s: &TranscriptStore, conv_id: &str, m: NewMessage, known: &[String]) {
    if !s.ready() {
        return;
    }
    match s.append(conv_id, &m, known) {
        Ok(Some(ev)) => super::events::emit_raw(EVENT_NAME, &ev),
        Ok(None) => {}
        Err(e) => s.warn(&e),
    }
}

pub fn record(conv_id: &str, m: NewMessage, known: &[String]) {
    record_in(store(), conv_id, m, known)
}

pub fn open_conv_in(s: &TranscriptStore, o: OpenConv, known: &[String]) {
    if !s.ready() {
        return;
    }
    if let Err(e) = s.open(&o, known) {
        s.warn(&e);
    }
}

pub fn open_conv(o: OpenConv, known: &[String]) {
    open_conv_in(store(), o, known)
}

/// Nest `conv_id` under `parent` (a hub build's worker task / Claude item).
pub fn nest_in(s: &TranscriptStore, conv_id: &str, parent: &str) {
    if !s.ready() {
        return;
    }
    if let Err(e) = s.set_parent(conv_id, parent) {
        s.warn(&e);
    }
}

pub fn status_in(s: &TranscriptStore, conv_id: &str, status: &str) {
    if !s.ready() {
        return;
    }
    if let Err(e) = s.set_status(conv_id, status) {
        s.warn(&e);
    }
}

pub fn status(conv_id: &str, status: &str) {
    status_in(store(), conv_id, status)
}

/// Mirror a committed handoff row (called right after `events::publish_entry`).
pub fn mirror_entry_in(s: &TranscriptStore, h: &HandoffEntry, env: &Envelope, known: &[String]) {
    if !s.ready() {
        return;
    }
    let o = task_open(env);
    let conv = o.conv_id.clone();
    open_conv_in(s, o, known);
    status_in(s, &conv, &env.status);
    record_in(s, &conv, entry_message(h, env), known);
}

pub fn mirror_entry(h: &HandoffEntry, env: &Envelope, known: &[String]) {
    mirror_entry_in(store(), h, env, known)
}

/// Record one delegated Tony turn (`turn:<stream|trace id>`), titled with Nic's request.
pub fn record_turn_in(s: &TranscriptStore, conv_id: &str, request: &str, msgs: Vec<NewMessage>, known: &[String]) {
    if !s.ready() {
        return;
    }
    open_conv_in(s, OpenConv { conv_id: conv_id.to_string(), kind: "turn", title: request.to_string(), thread: Some("auto".into()), ..Default::default() }, known);
    for m in msgs {
        record_in(s, conv_id, m, known);
    }
}

pub fn record_turn(conv_id: &str, request: &str, msgs: Vec<NewMessage>, known: &[String]) {
    record_turn_in(store(), conv_id, request, msgs, known)
}

// ── Tauri commands (read-only) ──────────────────────────────────────────────

/// Root conversations (newest activity first) for the chat cards.
#[tauri::command(rename_all = "snake_case")]
pub fn transcript_conversations(limit: Option<u32>, before: Option<i64>, roots_only: Option<bool>) -> Result<Vec<TranscriptConversation>, String> {
    store().list(limit.unwrap_or(50).clamp(1, 200), before, roots_only.unwrap_or(true))
}

/// `transcript_get`'s core: a task conversation is first backfilled from tasks.db (rows already
/// scrubbed there), so a page never misses a committed hand-off.
pub fn page_with_backfill(s: &TranscriptStore, tasks: &TaskStore, conv_id: &str, after_seq: Option<i64>, limit: Option<u32>) -> Result<TranscriptPage, String> {
    if let Some(tid) = conv_id.strip_prefix("task:") {
        if after_seq.is_none() {
            if let Ok(Some(env)) = tasks.with(|c| super::envelope::get(c, tid)) {
                if let Err(e) = s.backfill_task(&env, &[]) {
                    eprintln!("[transcript] backfill {tid}: {e}");
                }
            }
        }
    }
    s.page(conv_id, after_seq, limit.unwrap_or(PAGE_MAX).clamp(1, PAGE_MAX))?.ok_or_else(|| "no such conversation".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn transcript_get(app: tauri::AppHandle, conv_id: String, after_seq: Option<i64>, limit: Option<u32>) -> Result<TranscriptPage, String> {
    use tauri::Manager;
    page_with_backfill(store(), app.state::<TaskStore>().inner(), &conv_id, after_seq, limit)
}

/// One message with its (scrubbed, capped) body, loaded lazily when a row is opened.
#[tauri::command(rename_all = "snake_case")]
pub fn transcript_message(seq: i64) -> Result<TranscriptMessage, String> {
    store().message(seq)?.ok_or_else(|| "no such message".to_string())
}

#[cfg(test)]
mod tests;
