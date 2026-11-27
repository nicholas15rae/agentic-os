//! Gmail through the user's Google Apps Script web app — the same deployment
//! AnythingLLM's Gmail agent uses: `POST https://script.google.com/macros/s/{id}/exec`
//! with `{key, action, ...args}` → `{status, data}`.
//!
//! The deployment ID and key come from `GMAIL_SCRIPT_ID` + `GMAIL_SCRIPT_KEY` (environment
//! or repo-root `.env`, both required), else the OS keychain pair (`gmail-script-id`,
//! `gmail-script-key`); they never reach the webview, logs or error strings.
//! A read-only n8n workflow (`gmail-recent` or `gmail-digest`) is the fallback
//! for `gmail.recent` when no deployment is configured.
//! `gmail.booking_scan` (read-only) runs Nic's booking-mail check: the search from his
//! instruction file, then the newest threads read in parallel (see "Booking mail scan").

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

use super::bridge::BridgeState;
use super::dispatch::{short, DispatchState};
use super::os_core::{self, OsState};

const SECRET_ID: &str = "gmail-script-id";
const SECRET_KEY: &str = "gmail-script-key";
const N8N_WORKFLOWS: [&str; 2] = ["gmail-recent", "gmail-digest"];
pub(crate) const NO_BACKEND: &str = "Gmail: no backend — add the Apps Script deployment in Settings → Integrations, or import it from AnythingLLM";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Source {
    Script,
    N8n(&'static str),
    None,
}

/// The Apps Script deployment ID + key, in priority order: `GMAIL_SCRIPT_ID` /
/// `GMAIL_SCRIPT_KEY` from the environment or repo-root `.env` (the direct credential),
/// then the keychain pair (Settings, or the AnythingLLM import). `source()` falls back to
/// an n8n workflow after that. Read on every call, so a change takes effect without a restart.
fn creds(state: &DispatchState) -> Option<(String, String)> {
    env_pair(state).or_else(|| Some((os_core::os_secret(SECRET_ID)?, os_core::os_secret(SECRET_KEY)?)))
}

/// `GMAIL_SCRIPT_ID` + `GMAIL_SCRIPT_KEY` from the environment / repo-root `.env`, only
/// when BOTH are set (half a pair is never mixed with a keychain half). The Settings badges
/// (`envfile::os_secret_sources`) apply the same rule.
pub(crate) fn env_pair(state: &DispatchState) -> Option<(String, String)> {
    let env = |k| super::envfile::env_or_file(state, k);
    Some((env("GMAIL_SCRIPT_ID")?, env("GMAIL_SCRIPT_KEY")?))
}

/// Where the Gmail backend comes from, for the System Map: `"env"` (.env / environment),
/// `"keychain"`, `"n8n:<workflow>"` or `"none"`. Names only, never the values.
pub(crate) fn source_label(state: &DispatchState) -> String {
    if env_pair(state).is_some() {
        return "env".into();
    }
    match source(state) {
        Source::Script => "keychain".into(),
        Source::N8n(wf) => format!("n8n:{wf}"),
        Source::None => "none".into(),
    }
}

/// AnythingLLM Desktop's SQLite database (`%APPDATA%nythingllm-desktop\storagenythingllm.db`).
pub(crate) fn anythingllm_db_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("anythingllm-desktop").join("storage").join("anythingllm.db"))
}

pub(crate) fn source(state: &DispatchState) -> Source {
    if creds(state).is_some() {
        return Source::Script;
    }
    let wfs = state.snapshot().n8n_workflows;
    N8N_WORKFLOWS.iter().find(|n| wfs.contains_key(**n)).map_or(Source::None, |n| Source::N8n(n))
}

pub(crate) fn valid_deployment_id(id: &str) -> bool {
    (10..=200).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The Apps Script reply → its `data`, or a fix-it message (never echoing credentials).
fn parse_script_reply(status: u16, body: &str) -> Result<Value, String> {
    script_reply("Gmail", status, body)
}

/// `parse_script_reply` for any `{key, action}` Apps Script bridge (`label`: "Gmail", "Calendar").
pub(crate) fn script_reply(label: &str, status: u16, body: &str) -> Result<Value, String> {
    if !(200..300).contains(&status) {
        return Err(match status {
            404 => format!("{label} Apps Script deployment not found (HTTP 404) — check the deployment ID in Settings → Integrations"),
            401 | 403 => format!("{label} Apps Script refused access (HTTP {status}) — deploy it as a Web app with access \"Anyone\""),
            _ => format!("{label} Apps Script failed (HTTP {status})"),
        });
    }
    let v: Value = serde_json::from_str(body).map_err(|_| format!("{label} Apps Script didn't return JSON — deploy it as a Web app with access \"Anyone\" and use that deployment ID"))?;
    if v["status"] == "error" {
        let e = v["error"].as_str().unwrap_or("unknown error");
        return Err(format!("{label} Apps Script error: {}", e.chars().take(300).collect::<String>()));
    }
    Ok(v["data"].clone())
}

async fn script(state: &DispatchState, action: &str, args: Value, secs: u64) -> Result<Value, String> {
    let Some((id, key)) = creds(state) else {
        return Err(NO_BACKEND.into());
    };
    let id = id.trim().to_string();
    if !valid_deployment_id(&id) {
        return Err("the saved Gmail Apps Script deployment ID is malformed — paste it again in Settings → Integrations".into());
    }
    let mut body = args.as_object().cloned().unwrap_or_default();
    body.insert("key".into(), json!(key.trim()));
    body.insert("action".into(), json!(action));
    // Apps Script answers the POST with a 302 to script.googleusercontent.com; reqwest follows it as a GET.
    let r = state
        .http
        .post(format!("https://script.google.com/macros/s/{id}/exec"))
        .timeout(Duration::from_secs(secs))
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Gmail Apps Script {}", short(e)))?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| format!("Gmail Apps Script {}", short(e)))?;
    parse_script_reply(status, &text)
}

fn arg_str<'a>(args: &'a Value, k: &str) -> &'a str {
    args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn arg_num(args: &Value, k: &str, default: u64, max: u64) -> u64 {
    args.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())).unwrap_or(default).clamp(1, max)
}

/// `name` is a `gmail.*` builtin tool. `approved` matters only for `create_draft`.
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value, approved: bool) -> Result<String, String> {
    if os.snapshot().privacy.kill_switch {
        return Err("kill switch is on — Gmail is a cloud service".into());
    }
    match name {
        "gmail.recent" => {
            let n = arg_num(args, "count", 5, 20);
            match source(state) {
                Source::Script => recent(state, n).await,
                Source::N8n(wf) => {
                    let v = super::n8n::fetch_readonly(state, wf, json!({ "count": n })).await.map_err(|e| format!("Gmail (n8n \"{wf}\"): {e}"))?;
                    Ok(v.to_string().chars().take(6000).collect())
                }
                Source::None => Err(NO_BACKEND.into()),
            }
        }
        "gmail.search" => {
            let query = arg_str(args, "query");
            if query.is_empty() || query.len() > 500 {
                return Err("gmail.search needs a query (Gmail search syntax, e.g. from:sam is:unread)".into());
            }
            let limit = arg_num(args, "limit", 10, 25);
            let data = script(state, "search", json!({ "query": query, "limit": limit, "start": 0 }), 15).await?;
            Ok(format_threads(&data, &[], 240))
        }
        "gmail.read_thread" => {
            let id = arg_str(args, "threadId");
            if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Err("gmail.read_thread needs a threadId from gmail.recent or gmail.search".into());
            }
            let data = script(state, "read_thread", json!({ "threadId": id }), 15).await?;
            Ok(format_thread(&data))
        }
        BOOKING_SCAN => {
            if creds(state).is_none() {
                return Err(NO_BACKEND.into());
            }
            // Nic's editable instruction, re-read on every scan (a fix takes effect at once).
            let cfg = os.snapshot();
            let spec = booking_spec(&cfg.gmail.booking_instructions_path, &cfg.fs_roots);
            let limit = arg_num(args, "limit", 10, BOOKING_LIMIT_MAX);
            let read = args.get("read").map(|_| arg_num(args, "read", spec.read as u64, BOOKING_READ_MAX as u64) as usize).unwrap_or(spec.read);
            // 9 s for the search + 7 s for the parallel reads stays inside the turn's 18 s tool cap.
            let (text, bookings) = booking_scan_with(&spec.query, limit, read, Duration::from_secs(7), chrono::Local::now().date_naive(), |action, a| script(state, action, a, 9)).await?;
            remember_bookings(bookings, super::compaction::now_ms());
            Ok(text)
        }
        "gmail.create_draft" => {
            if !approved {
                return Err("PERMISSION_REQUIRED:gmail-draft".into());
            }
            let (to, subject, body) = draft_fields(args)?;
            let data = script(state, "create_draft", json!({ "to": to, "subject": subject, "body": body }), 15).await?;
            let to = data["to"].as_str().unwrap_or(&to).to_string();
            Ok(format!("Draft saved in Gmail (not sent) — to {to}, subject \"{subject}\"."))
        }
        _ => Err(format!("unknown Gmail tool {name}")),
    }
}

fn draft_fields(args: &Value) -> Result<(String, String, String), String> {
    let to = arg_str(args, "to");
    let addresses: Vec<&str> = to.split(',').map(str::trim).filter(|a| !a.is_empty()).collect();
    let valid = |a: &str| a.len() <= 254 && !a.chars().any(char::is_whitespace) && a.split_once('@').is_some_and(|(u, d)| !u.is_empty() && d.contains('.'));
    if addresses.is_empty() || to.len() > 1000 || !addresses.iter().all(|a| valid(a)) {
        return Err("a Gmail draft needs a valid recipient email address".into());
    }
    let subject: String = arg_str(args, "subject").chars().map(|c| if c.is_control() { ' ' } else { c }).take(300).collect();
    let body = arg_str(args, "body");
    if body.is_empty() || body.len() > 20_000 {
        return Err("a Gmail draft needs a body (up to 20,000 characters)".into());
    }
    Ok((addresses.join(", "), subject.trim().to_string(), body.to_string()))
}

async fn recent(state: &DispatchState, n: u64) -> Result<String, String> {
    let data = script(state, "search", json!({ "query": "is:inbox", "limit": n, "start": 0 }), 15).await?;
    // Search summaries carry no sender or body, so read the newest few threads too.
    let ids: Vec<String> = data["threads"].as_array().into_iter().flatten().take(n.min(3) as usize).filter_map(|t| t["id"].as_str().map(String::from)).collect();
    let reads = futures_util::future::join_all(ids.iter().map(|id| script(state, "read_thread", json!({ "threadId": id }), 8)));
    let details: Vec<Value> = match tokio::time::timeout(Duration::from_secs(8), reads).await {
        Ok(v) => v.into_iter().map(|r| r.unwrap_or(Value::Null)).collect(),
        Err(_) => vec![],
    };
    Ok(format_threads(&data, &details, if n == 1 { 1500 } else { 240 }))
}

fn local_date(s: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(s).map(|d| d.with_timezone(&chrono::Local).format("%a %b %-d, %-I:%M %p").to_string()).unwrap_or_else(|_| s.to_string())
}

/// A message date for a scan line ("date unknown" when the bridge sent none).
fn when(s: &str) -> String {
    if s.is_empty() {
        "date unknown".into()
    } else {
        local_date(s)
    }
}

fn compact(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v[*k].as_str().map(str::trim).filter(|s| !s.is_empty()))
}

/// `search` data (`{threads, resultCount}`) as numbered lines; `details[i]` is
/// thread i's `read_thread` data when it was fetched (sender + body preview).
fn format_threads(data: &Value, details: &[Value], preview: usize) -> String {
    let threads: Vec<&Value> = data["threads"].as_array().into_iter().flatten().collect();
    if threads.is_empty() {
        return "No emails found.".into();
    }
    let lines: Vec<String> = threads
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let latest = details.get(i).and_then(|d| d["messages"].as_array()).and_then(|m| m.last());
            let from = latest.and_then(|m| first_str(m, &["from"])).or_else(|| first_str(t, &["from", "lastMessageFrom"])).unwrap_or("unknown sender");
            let subject = first_str(t, &["subject"]).unwrap_or("(no subject)");
            let date = first_str(t, &["lastMessageDate", "date"]).map(local_date).unwrap_or_default();
            let unread = if t["isUnread"].as_bool() == Some(true) { "[UNREAD] " } else { "" };
            let mut line = format!("{}. {unread}From: {from} · Subject: \"{subject}\"", i + 1);
            if !date.is_empty() {
                line.push_str(&format!(" · {date}"));
            }
            if let Some(id) = first_str(t, &["id"]) {
                line.push_str(&format!(" [thread {id}]"));
            }
            let body = latest.and_then(|m| first_str(m, &["body"])).or_else(|| first_str(t, &["snippet"])).map(|b| compact(b, preview)).unwrap_or_default();
            if !body.is_empty() {
                line.push_str(&format!("\n   {body}"));
            }
            line
        })
        .collect();
    let total = data["resultCount"].as_u64().unwrap_or(threads.len() as u64);
    format!("{total} email thread(s):\n{}", lines.join("\n"))
}

/// `read_thread` data → the latest message in full (truncated) plus who else wrote.
fn format_thread(data: &Value) -> String {
    let subject = first_str(data, &["subject"]).unwrap_or("(no subject)");
    let msgs: Vec<&Value> = data["messages"].as_array().into_iter().flatten().collect();
    let Some(last) = msgs.last() else {
        return format!("Thread \"{subject}\" has no messages.");
    };
    let mut s = format!(
        "Thread: \"{subject}\" ({} message{})\nLatest — From: {} · To: {} · {}\n{}",
        msgs.len(),
        if msgs.len() == 1 { "" } else { "s" },
        first_str(last, &["from"]).unwrap_or("unknown sender"),
        first_str(last, &["to"]).unwrap_or("?"),
        first_str(last, &["date"]).map(local_date).unwrap_or_default(),
        compact(first_str(last, &["body"]).unwrap_or("(empty)"), 3000)
    );
    // Call sheets and deal memos usually arrive as attachments: their names, never their content.
    let files = attachment_names(data);
    if !files.is_empty() {
        s.push_str(&format!("\nAttachments: {}", files.join(", ")));
    }
    let mut earlier: Vec<&str> = msgs[..msgs.len() - 1].iter().filter_map(|m| first_str(m, &["from"])).collect();
    earlier.dedup();
    if !earlier.is_empty() {
        s.push_str(&format!("\nEarlier messages from: {}", earlier.join(", ")));
    }
    s
}

/// The attachment names of a `read_thread` reply (the thread's own list, else every message's),
/// deduplicated, control characters dropped, at most 10 names of 80 chars.
fn attachment_names(data: &Value) -> Vec<String> {
    let lists = std::iter::once(&data["attachments"]).chain(data["messages"].as_array().into_iter().flatten().map(|m| &m["attachments"]));
    let mut out: Vec<String> = Vec::new();
    for a in lists.filter_map(Value::as_array).flatten() {
        let name = a.as_str().or_else(|| first_str(a, &["name", "filename", "fileName"])).unwrap_or("");
        let name: String = name.chars().filter(|c| !c.is_control()).take(80).collect::<String>().trim().to_string();
        if !name.is_empty() && !out.contains(&name) && out.len() < 10 {
            out.push(name);
        }
    }
    out
}

// ── Booking mail scan ───────────────────────────────────────────────────────
//
// "Check my Gmail for what I got booked for": one Gmail search with the query from Nic's own
// instruction file (`G:\ai-hub\protocols\booking-email-check.md`, os.json
// `gmail.bookingInstructionsPath`, re-read on every scan), then the newest threads read in
// parallel under one budget. Read-only. Mail content is untrusted data (agents.rs TOOL_DATA_RULE).

/// The builtin's name (read-only: `mcp::is_mutating_tool` exempts it by name).
pub(crate) const BOOKING_SCAN: &str = "gmail.booking_scan";
/// The instruction file's default location (os.json `gmail.bookingInstructionsPath`).
pub(crate) const BOOKING_INSTRUCTIONS_DEFAULT_PATH: &str = r"G:\ai-hub\protocols\booking-email-check.md";
/// The built-in search when the file is missing or names no query.
pub(crate) const BOOKING_DEFAULT_QUERY: &str = r#"(booked OR confirmed OR "call sheet" OR "deal memo" OR audition OR "on hold") newer_than:30d -category:promotions -category:social"#;
pub(crate) const BOOKING_DEFAULT_READ: usize = 5;
/// The scan's whole result, exempt from the 2000-char cut every other tool block gets (agents.rs).
pub(crate) const BOOKING_SCAN_MAX: usize = 4000;
/// Only the file's first 4 KB is read.
const BOOKING_FILE_MAX: usize = 4096;
/// Nic's rules (the file after its query / read lines) as they ride in Tony's note.
const BOOKING_RULES_MAX: usize = 1200;
const BOOKING_EXCERPT: usize = 600;
const BOOKING_READ_MAX: usize = 8;
const BOOKING_LIMIT_MAX: u64 = 25;
/// How long the last scan's bookings serve a calendar-add card.
const BOOKINGS_TTL_MS: u64 = 2 * 3600 * 1000;

/// What the instruction file says (or the built-in default).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookingSpec {
    pub query: String,
    pub read: usize,
    /// The file's own rules (What counts / Ignore / Summarise as), clipped; "" for none.
    pub rules: String,
    /// "file" (read from disk) | "default" (missing / unreadable).
    pub source: &'static str,
}

impl Default for BookingSpec {
    fn default() -> Self {
        Self { query: BOOKING_DEFAULT_QUERY.into(), read: BOOKING_DEFAULT_READ, rules: String::new(), source: "default" }
    }
}

/// The instruction text (its first 4 KB) → the spec. `query: …` and `read: N` lines (any case,
/// backticks / quotes around the value dropped); every other line is Nic's rules. A query that
/// is empty, over 500 chars or has control characters keeps the built-in one; `read` is 1-8.
pub(crate) fn parse_booking_spec(text: &str) -> BookingSpec {
    let mut cut = text.len().min(BOOKING_FILE_MAX);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut spec = BookingSpec { source: "file", ..BookingSpec::default() };
    let mut rules: Vec<&str> = Vec::new();
    for line in text[..cut].trim_start_matches('\u{feff}').lines() {
        let t = line.trim();
        // A value wrapped in backticks (Markdown code) loses them; quotes are the query's own.
        let unwrap = |v: &str| v.strip_prefix('`').and_then(|v| v.strip_suffix('`')).unwrap_or(v).trim().to_string();
        let value = |key: &str| t.get(..key.len()).filter(|h| h.eq_ignore_ascii_case(key)).map(|_| unwrap(t[key.len()..].trim()));
        if let Some(q) = value("query:") {
            if !q.is_empty() && q.len() <= 500 && !q.chars().any(char::is_control) {
                spec.query = q;
            }
        } else if let Some(n) = value("read:") {
            if let Ok(n) = n.parse::<usize>() {
                spec.read = n.clamp(1, BOOKING_READ_MAX);
            }
        } else {
            rules.push(line.trim_end());
        }
    }
    let rules = rules.join("\n");
    spec.rules = super::envelope::clip(rules.trim(), BOOKING_RULES_MAX);
    spec
}

/// What os.json `gmail.bookingInstructionsPath` resolves to (`booking_instructions_file`).
#[derive(Debug, PartialEq)]
pub(crate) enum InstructionFile {
    /// Allowed and present (the resolved path, junctions followed).
    Ok(PathBuf),
    /// Allowed, not there (the built-in search is used).
    Missing,
    /// Not an instruction file the scan may read (why).
    Refused(&'static str),
}

const REFUSED_KIND: &str = "the booking instruction file must be a .md or .txt file (never .env)";
const REFUSED_ROOT: &str = r"the booking instruction file must live under G:\ai-hub or one of your file roots (os.json fsRoots)";

/// The instruction file `path` names ("" = the default), when the scan may read it: a `.md` /
/// `.txt` file, never one named `.env…`, that resolves (junctions and links followed) under the
/// hub `G:\ai-hub` or a configured `fsRoots` entry. The setting can never point Tony's prompt or
/// the Settings preview at `.env`, a key file or anything outside Nic's notes.
pub(crate) fn booking_instructions_file(path: &str, fs_roots: &[String]) -> InstructionFile {
    let raw = if path.trim().is_empty() { BOOKING_INSTRUCTIONS_DEFAULT_PATH } else { path.trim() };
    let note_file = |p: &std::path::Path| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
        let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        !name.starts_with(".env") && matches!(ext.as_deref(), Some("md") | Some("txt"))
    };
    let p = PathBuf::from(raw);
    if !note_file(&p) {
        return InstructionFile::Refused(REFUSED_KIND);
    }
    let Ok(real) = std::fs::canonicalize(&p) else { return InstructionFile::Missing };
    // A `.md` link to `.env` is judged by what it resolves to.
    if !real.is_file() || !note_file(&real) {
        return if real.is_file() { InstructionFile::Refused(REFUSED_KIND) } else { InstructionFile::Missing };
    }
    let roots = std::iter::once(os_core::READ_ONLY_HUB_ROOT).chain(fs_roots.iter().map(|r| r.trim()).filter(|r| !r.is_empty()));
    if !roots.into_iter().any(|r| os_core::path_under_root(&real, r)) {
        return InstructionFile::Refused(REFUSED_ROOT);
    }
    InstructionFile::Ok(real)
}

/// The first 4 KB of an allowed instruction file (lossy UTF-8).
fn read_instructions(f: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(BOOKING_FILE_MAX);
    std::fs::File::open(f).ok()?.take(BOOKING_FILE_MAX as u64).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// The spec at `path` (os.json `gmail.bookingInstructionsPath`; "" = the default path), read now.
/// A path `booking_instructions_file` refuses, or a missing file, is the built-in spec.
pub(crate) fn booking_spec(path: &str, fs_roots: &[String]) -> BookingSpec {
    match booking_instructions_file(path, fs_roots) {
        InstructionFile::Ok(f) => read_instructions(&f).map(|t| parse_booking_spec(&t)).unwrap_or_default(),
        _ => BookingSpec::default(),
    }
}

/// One booking thread the scan read, for the calendar-add card (`OsTurnResult.bookings`). The
/// fields are the mail's own (subject, sender, attachment names) plus what it states plainly:
/// the one date it names, a call time, a location line. Never a guess: an unclear field is absent.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Booking {
    pub thread_id: String,
    pub subject: String,
    pub from: String,
    /// When the latest message arrived (the bridge's date, as sent).
    pub received: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
    /// The one date the mail names (YYYY-MM-DD), only when it names exactly one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Its call time (HH:MM, 24 h), when it states one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// A `Location:` / `Address:` line, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

/// The last scan's bookings (memory only, never written): the desktop's calendar-add planner
/// reads them (`gmail_last_bookings`) because the card is raised on a later turn.
static LAST_BOOKINGS: std::sync::Mutex<Option<(u64, Vec<Booking>)>> = std::sync::Mutex::new(None);

pub(crate) fn remember_bookings(b: Vec<Booking>, now_ms: u64) {
    *LAST_BOOKINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some((now_ms, b));
}

/// The bookings of a scan made at or after `since_ms` (this turn's own scan); empty otherwise.
pub(crate) fn bookings_since(since_ms: u64) -> Vec<Booking> {
    scan_since(since_ms).unwrap_or_default()
}

/// This turn's scan (`OsTurnResult.bookings`): `Some` when a scan stored at or after `since_ms`
/// replaced the remembered list, even with nothing found (`Some([])`, so the phone clears its
/// copy too); `None` when no scan ran since (a failed search leaves both lists as they were).
pub(crate) fn scan_since(since_ms: u64) -> Option<Vec<Booking>> {
    match &*LAST_BOOKINGS.lock().unwrap_or_else(|e| e.into_inner()) {
        Some((at, b)) if *at >= since_ms => Some(b.clone()),
        _ => None,
    }
}

/// The last scan's bookings while fresh (`BOOKINGS_TTL_MS`).
pub(crate) fn last_bookings(now_ms: u64) -> Vec<Booking> {
    bookings_since(now_ms.saturating_sub(BOOKINGS_TTL_MS))
}

/// The scan itself, over any `{key, action}` bridge (`call`: the Apps Script, or a test fake):
/// `search` with `query` (`limit` hits), then `read_thread` on the newest `read` hits in
/// parallel, each bounded by `budget` (a slow read drops only itself). One compact block per
/// thread; the whole text is capped at `BOOKING_SCAN_MAX`. `today`: the year a date without one
/// falls in.
pub(crate) async fn booking_scan_with<F, Fut>(query: &str, limit: u64, read: usize, budget: Duration, today: chrono::NaiveDate, call: F) -> Result<(String, Vec<Booking>), String>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let data = call("search", json!({ "query": query, "limit": limit.clamp(1, BOOKING_LIMIT_MAX), "start": 0 })).await?;
    let threads: Vec<&Value> = data["threads"].as_array().into_iter().flatten().filter(|t| first_str(t, &["id"]).is_some()).collect();
    if threads.is_empty() {
        return Ok(("No booking emails found (the search covers the last 30 days unless the instruction file says otherwise).".into(), vec![]));
    }
    let n = read.clamp(1, BOOKING_READ_MAX).min(threads.len());
    let reads = futures_util::future::join_all(threads[..n].iter().map(|t| {
        let id = first_str(t, &["id"]).unwrap_or("").to_string();
        let f = call("read_thread", json!({ "threadId": id }));
        async move { tokio::time::timeout(budget, f).await.ok().and_then(Result::ok) }
    }))
    .await;
    let total = data["resultCount"].as_u64().unwrap_or(threads.len() as u64);
    let read_ok = reads.iter().filter(|r| r.is_some()).count();
    let excerpt = ((BOOKING_SCAN_MAX.saturating_sub(160 + n * 330)) / n.max(1)).clamp(150, BOOKING_EXCERPT);
    let mut out = format!("Booking mail: {total} thread(s) matched; the newest {read_ok} read.");
    let mut bookings = Vec::new();
    for (i, (t, d)) in threads[..n].iter().zip(&reads).enumerate() {
        let id = first_str(t, &["id"]).unwrap_or("");
        let subject = first_str(t, &["subject"]).or_else(|| d.as_ref().and_then(|d| first_str(d, &["subject"]))).unwrap_or("(no subject)");
        let date = first_str(t, &["lastMessageDate", "date"]).unwrap_or("");
        let Some(d) = d else {
            out.push_str(&format!("\n{}. {} · Subject: \"{subject}\" [thread {id}] (couldn't read it in time)", i + 1, when(date)));
            continue;
        };
        let latest = d["messages"].as_array().and_then(|m| m.last());
        let from = latest.and_then(|m| first_str(m, &["from"])).unwrap_or("unknown sender");
        let received = latest.and_then(|m| first_str(m, &["date"])).unwrap_or(date);
        let body = latest.and_then(|m| first_str(m, &["body"])).unwrap_or("");
        let files = attachment_names(d);
        out.push_str(&format!("\n{}. {} · From: {from} · Subject: \"{subject}\" [thread {id}]", i + 1, when(received)));
        if !files.is_empty() {
            out.push_str(&format!("\n   Attachments: {}", files.join(", ")));
        }
        if !body.is_empty() {
            out.push_str(&format!("\n   {}", compact(body, excerpt)));
        }
        // The card's fields come from the latest message's own words only: a reply header's send
        // time or a date quoted from an earlier message is never the booking's.
        let own = latest_text(body);
        let text = format!("{subject}\n{}", own.chars().take(3000).collect::<String>());
        bookings.push(Booking {
            thread_id: id.to_string(),
            subject: subject.chars().filter(|c| !c.is_control()).take(200).collect(),
            from: from.chars().filter(|c| !c.is_control()).take(200).collect(),
            received: received.chars().take(64).collect(),
            attachments: files,
            date: one_date(&text, today),
            time: call_time(&text),
            location: location_line(&own),
        });
    }
    let rest: Vec<String> = threads[n..].iter().take(10).map(|t| format!("\"{}\"", first_str(t, &["subject"]).unwrap_or("(no subject)"))).collect();
    if !rest.is_empty() {
        out.push_str(&format!("\nAlso matched, not read: {}", rest.join(", ")));
    }
    Ok((out.chars().take(BOOKING_SCAN_MAX).collect(), bookings))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// The one calendar date `text` names ("Nov 28", "28 November 2026", "Friday, November 28th",
/// "2026-11-28"), as YYYY-MM-DD; None when it names none or more than one. A date without a year
/// is this year's, or next year's when that day is over a month gone (`today`). Pure.
pub(crate) fn one_date(text: &str, today: chrono::NaiveDate) -> Option<String> {
    use chrono::Datelike;
    static MD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static DM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static ISO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    const MON: &str = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    let md = MD.get_or_init(|| regex::Regex::new(&format!(r"(?i)\b{MON}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(20\d\d)\b)?")).unwrap());
    let dm = DM.get_or_init(|| regex::Regex::new(&format!(r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?{MON}\b\.?(?:,?\s+(20\d\d)\b)?")).unwrap());
    let iso = ISO.get_or_init(|| regex::Regex::new(r"\b(20\d\d)-(\d\d)-(\d\d)\b").unwrap());
    let month = |m: &str| MONTHS.iter().position(|x| m.to_ascii_lowercase().starts_with(x)).map(|i| i as u32 + 1);
    let resolve = |m: u32, d: u32, y: Option<i32>| -> Option<chrono::NaiveDate> {
        match y {
            Some(y) => chrono::NaiveDate::from_ymd_opt(y, m, d),
            None => {
                let this = chrono::NaiveDate::from_ymd_opt(today.year(), m, d)?;
                if (today - this).num_days() > 31 {
                    chrono::NaiveDate::from_ymd_opt(today.year() + 1, m, d)
                } else {
                    Some(this)
                }
            }
        }
    };
    let mut found: Vec<chrono::NaiveDate> = Vec::new();
    for c in md.captures_iter(text) {
        found.extend(month(&c[1]).zip(c[2].parse().ok()).and_then(|(m, d)| resolve(m, d, c.get(3).and_then(|y| y.as_str().parse().ok()))));
    }
    for c in dm.captures_iter(text) {
        found.extend(month(&c[2]).zip(c[1].parse().ok()).and_then(|(m, d)| resolve(m, d, c.get(3).and_then(|y| y.as_str().parse().ok()))));
    }
    for c in iso.captures_iter(text) {
        found.extend(c[1].parse().ok().zip(c[2].parse().ok()).zip(c[3].parse().ok()).and_then(|((y, m), d)| chrono::NaiveDate::from_ymd_opt(y, m, d)));
    }
    found.sort();
    found.dedup();
    (found.len() == 1).then(|| found[0].format("%Y-%m-%d").to_string())
}

/// The latest message's own words: `body` without its quoted history. A reply's "On … wrote:"
/// line (also wrapped onto two lines), Outlook's "From: … / Sent: …" header or an "-----Original
/// Message-----" rule ends it; `>` quoted lines are dropped; a forward's marker and its From / Date
/// / Sent / To / Cc / Subject header lines are dropped, while the forwarded text (what was passed
/// along) stays. Pure.
pub(crate) fn latest_text(body: &str) -> String {
    static WROTE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static ORIGINAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static FORWARD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static HEADER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static FROM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let wrote = WROTE.get_or_init(|| regex::Regex::new(r"(?i)^\s*on\b.{0,300}\bwrote:\s*$").unwrap());
    let original = ORIGINAL.get_or_init(|| regex::Regex::new(r"(?i)^\s*(?:-{2,}\s*original message\s*-*|_{10,})\s*$").unwrap());
    let forward = FORWARD.get_or_init(|| regex::Regex::new(r"(?i)^\s*(?:-{2,}\s*forwarded message\s*-*|begin forwarded message:?)\s*$").unwrap());
    let header = HEADER.get_or_init(|| regex::Regex::new(r"(?i)^\s*\*?(?:from|sent|date|to|cc|bcc|subject|reply-to)\s*:").unwrap());
    let from = FROM.get_or_init(|| regex::Regex::new(r"(?i)^\s*\*?from\s*:\*?\s*\S").unwrap());
    let sent = SENT.get_or_init(|| regex::Regex::new(r"(?i)^\s*\*?(?:sent|date)\s*:\*?\s*\S").unwrap());
    let lines: Vec<&str> = body.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    // Inside a forward's header block: (in it, saw a header line yet). A blank line after the
    // headers ends it, so the forwarded text's own "Date: Friday, Nov 28" line stays.
    let mut fwd: Option<bool> = None;
    for (i, l) in lines.iter().enumerate() {
        let next = lines.get(i + 1).copied().unwrap_or("");
        if wrote.is_match(l) || (l.trim_start().to_ascii_lowercase().starts_with("on ") && wrote.is_match(&format!("{} {}", l.trim_end(), next.trim()))) || original.is_match(l) {
            break;
        }
        if forward.is_match(l) {
            fwd = Some(false);
            continue;
        }
        if let Some(seen) = fwd {
            if header.is_match(l) {
                fwd = Some(true);
                continue;
            }
            if l.trim().is_empty() {
                if seen {
                    fwd = None;
                }
                continue;
            }
            fwd = None;
        }
        // Outlook's reply header ("From: Sam" then "Sent: …" / "Date: …"): the history below it.
        if from.is_match(l) && lines[i + 1..].iter().take(3).any(|n| sent.is_match(n)) {
            break;
        }
        if l.trim_start().starts_with('>') {
            continue;
        }
        out.push(l);
    }
    out.join("\n")
}

/// The call time `text` states: a call-time phrase ("Call time: 7:30 AM", "call 6am", "call is at
/// 14:15", "audition slot 2:40 pm", "report at 06:00") followed by a real clock time, meaning
/// am / pm, or 24-hour HH:MM (12-23, 00, or a zero-led 0X). An hour 1-11 with no am / pm ("Call
/// time 5:30") is unclear, and so are "call 2 days before", a reply deadline ("confirm by 5pm")
/// and any loose time. Two different stated times are no call time either. HH:MM (24 h); None
/// when unclear. Pure.
pub(crate) fn call_time(text: &str) -> Option<String> {
    static CALL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let call = CALL.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(?:call(?:\s+time)?|(?:audition\s+)?slot|appointment|audition|start(?:s|ing)?(?:\s+time)?|report(?:ing)?(?:\s+time)?)\b\s*(?:(?:is|at|@|:|-|–|=)\s*)*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\W|$)").unwrap()
    });
    let hhmm = |c: &regex::Captures| -> Option<String> {
        let hs = &c[1];
        let mut h: u32 = hs.parse().ok()?;
        let m = match c.get(2) {
            Some(m) => Some(m.as_str().parse::<u32>().ok()?),
            None => None,
        };
        match c.get(3).map(|s| s.as_str().to_ascii_lowercase()) {
            Some(s) => {
                if !(1..=12).contains(&h) {
                    return None;
                }
                if s.starts_with('p') && h < 12 {
                    h += 12;
                } else if s.starts_with('a') && h == 12 {
                    h = 0;
                }
            }
            // No am / pm: only a 24-hour clock time is plain. 1-11 bare is never guessed.
            None => {
                let twenty_four = h == 0 || h >= 12 || (hs.len() == 2 && hs.starts_with('0'));
                if m.is_none() || !twenty_four {
                    return None;
                }
            }
        }
        let m = m.unwrap_or(0);
        (h < 24 && m < 60).then(|| format!("{h:02}:{m:02}"))
    };
    let mut all: Vec<String> = call.captures_iter(text).filter_map(|c| hhmm(&c)).collect();
    all.sort();
    all.dedup();
    (all.len() == 1).then(|| all.remove(0))
}

/// A `Location:` / `Address:` / `Where:` / `Set:` line of the mail body (≤ 120 chars). Pure.
pub(crate) fn location_line(body: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?im)^[ \t>*\-]*(?:location|address|where|set|studio)\s*[:\-]\s*(\S.{1,160})$").unwrap());
    let v = re.captures(body)?[1].trim().trim_end_matches(['.', ',']).chars().filter(|c| !c.is_control()).collect::<String>();
    (v.chars().count() >= 3).then(|| v.chars().take(120).collect())
}

/// Settings → Integrations: the booking instruction file (path, preview, what the scan uses).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingInstructions {
    path: String,
    exists: bool,
    /// The file's first 4 KB (Nic's own text), known secrets scrubbed; "" for a refused path.
    preview: String,
    spec: BookingSpec,
    /// Why the configured path isn't read (not a .md / .txt note under the hub or fsRoots).
    #[serde(skip_serializing_if = "Option::is_none")]
    refused: Option<&'static str>,
}

fn instructions_path(os: &OsState) -> String {
    let p = os.snapshot().gmail.booking_instructions_path;
    if p.trim().is_empty() { BOOKING_INSTRUCTIONS_DEFAULT_PATH.to_string() } else { p.trim().to_string() }
}

/// The Settings view of an instruction file (`known`: secret values to scrub). Never reads a path
/// `booking_instructions_file` refuses.
fn instructions_view(path: String, fs_roots: &[String], known: &[String]) -> BookingInstructions {
    match booking_instructions_file(&path, fs_roots) {
        InstructionFile::Ok(f) => {
            let text = read_instructions(&f).unwrap_or_default();
            let mut spec = parse_booking_spec(&text);
            spec.rules = super::devqueue::scrub(&spec.rules, known);
            BookingInstructions { path, exists: true, preview: super::devqueue::scrub(&text, known), spec, refused: None }
        }
        InstructionFile::Missing => BookingInstructions { path, exists: false, preview: String::new(), spec: BookingSpec::default(), refused: None },
        InstructionFile::Refused(why) => BookingInstructions { path, exists: false, preview: String::new(), spec: BookingSpec::default(), refused: Some(why) },
    }
}

#[tauri::command]
pub fn gmail_booking_instructions(state: State<'_, DispatchState>, os: State<'_, OsState>) -> BookingInstructions {
    instructions_view(instructions_path(&os), &os.snapshot().fs_roots, &super::devqueue::known_secrets(&state, &os))
}

/// Open the booking instruction file in Notepad (only a file `booking_instructions_file` allows).
#[tauri::command]
pub fn gmail_booking_instructions_open(os: State<'_, OsState>) -> Result<(), String> {
    let path = instructions_path(&os);
    match booking_instructions_file(&path, &os.snapshot().fs_roots) {
        InstructionFile::Ok(_) => std::process::Command::new("notepad.exe").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string()),
        InstructionFile::Missing => Err(format!("{path} doesn't exist yet")),
        InstructionFile::Refused(why) => Err(why.into()),
    }
}

/// The desktop's calendar-add planner: the last booking scan's threads (memory only, 2 h).
#[tauri::command]
pub fn gmail_last_bookings() -> Vec<Booking> {
    last_bookings(super::compaction::now_ms())
}

// ── Settings commands ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    configured: bool,
    /// "script" | "n8n" | "none"
    source: &'static str,
}

#[tauri::command]
pub async fn gmail_status(state: State<'_, DispatchState>) -> Result<GmailStatus, String> {
    let source = match source(&state) {
        Source::Script => "script",
        Source::N8n(_) => "n8n",
        Source::None => "none",
    };
    Ok(GmailStatus { configured: source != "none", source })
}

/// The approved-plan path for drafts: refuses unless the user approved the confirmation card.
#[tauri::command]
pub async fn gmail_create_draft(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, to: String, subject: String, body: String, approved: Option<bool>) -> Result<String, String> {
    create_draft_approved(&state, &os, &bridge, to, subject, body, approved.unwrap_or(false)).await
}

/// The one approved path for a draft: the desktop card (`gmail_create_draft`) and the phone's
/// approved `action` inbox item (pipeline.rs `run_approved_action`), where this Rust is the only
/// authority. The same gates as `calendar::create_event_approved`: approved, the MCP permission
/// gate, Gmail switched on, not frozen by the mode / master switchboard; the kill switch is
/// checked by `tool`. Logs no content.
pub(crate) async fn create_draft_approved(state: &DispatchState, os: &OsState, bridge: &BridgeState, to: String, subject: String, body: String, approved: bool) -> Result<String, String> {
    if !approved {
        return Err("PERMISSION_REQUIRED:gmail-draft".into());
    }
    let cfg = os.snapshot();
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", true, json!({ "tool": "gmail.create_draft" }))?;
    if !cfg.mcps.iter().any(|m| m.id == "gmail" && m.enabled) {
        return Err("Gmail is switched off — enable it in Settings → Skills & MCP Library".into());
    }
    // Gmail is part of Tony's always-on base (Section 2): only the master switchboard freezes it,
    // like calendar's approved add.
    if let Some(e) = super::mcp::tony_frozen_reason(&cfg, &os.modes.effective(), "gmail", "gmail").map(|r| format!("{}: {r}", super::modes::MODE_FROZEN)) {
        return Err(e);
    }
    let out = tool(state, os, "gmail.create_draft", &json!({ "to": to, "subject": subject, "body": body }), true).await;
    bridge.log(json!({ "type": "os-tool", "tool": "gmail.create_draft", "ok": out.is_ok(), "chars": body.len() }));
    out
}

#[derive(Serialize)]
pub struct ImportResult {
    imported: bool,
    detail: String,
}

/// Copy AnythingLLM Desktop's Gmail agent deployment straight into the keychain.
#[tauri::command]
pub async fn gmail_import_anythingllm(state: State<'_, DispatchState>) -> Result<ImportResult, String> {
    let r = tauri::async_runtime::spawn_blocking(import_from_anythingllm).await.map_err(|e| e.to_string())?;
    let shadowed = env_pair(&state).is_some();
    Ok(match r {
        Ok(()) if shadowed => ImportResult {
            imported: true,
            detail: "Imported the Gmail Apps Script deployment from AnythingLLM into the keychain — but GMAIL_SCRIPT_ID and GMAIL_SCRIPT_KEY are set in the environment / repo .env, and those are used first.".into(),
        },
        Ok(()) => ImportResult { imported: true, detail: "Imported the Gmail Apps Script deployment from AnythingLLM.".into() },
        Err(detail) => ImportResult { imported: false, detail },
    })
}

fn import_from_anythingllm() -> Result<(), String> {
    use rusqlite::{OpenFlags, OptionalExtension};
    let path = anythingllm_db_path().ok_or("%APPDATA% is not set")?;
    if !path.is_file() {
        return Err("AnythingLLM Desktop's database wasn't found — is AnythingLLM installed?".into());
    }
    let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| format!("couldn't open AnythingLLM's database: {e}"))?;
    let _ = conn.busy_timeout(Duration::from_secs(3));
    let raw: Option<Option<String>> = conn
        .query_row("SELECT value FROM system_settings WHERE label = 'gmail_agent_config'", [], |r| r.get(0))
        .optional()
        .map_err(|e| format!("couldn't read AnythingLLM's settings: {e}"))?;
    let (id, key) = parse_allm_config(raw.flatten().as_deref().unwrap_or(""))?;
    os_core::os_secret_store(SECRET_ID, &id)?;
    os_core::os_secret_store(SECRET_KEY, &key)
}

/// AnythingLLM's `gmail_agent_config` JSON → (deploymentId, apiKey).
fn parse_allm_config(raw: &str) -> Result<(String, String), String> {
    const MISSING: &str = "AnythingLLM has no Gmail deployment configured (Agent Skills → Gmail)";
    let v: Value = serde_json::from_str(raw).map_err(|_| MISSING.to_string())?;
    let id = v["deploymentId"].as_str().map(str::trim).unwrap_or("");
    let key = v["apiKey"].as_str().map(str::trim).unwrap_or("");
    if id.is_empty() || key.is_empty() || key.chars().all(|c| c == '*') {
        return Err(MISSING.into());
    }
    if !valid_deployment_id(id) || key.len() > 4096 {
        return Err("AnythingLLM's Gmail deployment ID doesn't look valid — paste it manually instead".into());
    }
    Ok((id.to_string(), key.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_reply_mapping() {
        assert_eq!(parse_script_reply(200, r#"{"status":"success","data":{"threads":[]}}"#).unwrap(), json!({ "threads": [] }));
        assert_eq!(parse_script_reply(200, r#"{"status":"error","error":"Invalid API key"}"#).unwrap_err(), "Gmail Apps Script error: Invalid API key");
        assert!(parse_script_reply(200, "<html>Sign in</html>").unwrap_err().contains("didn't return JSON"));
        assert!(parse_script_reply(404, "").unwrap_err().contains("not found"));
        assert!(parse_script_reply(403, "").unwrap_err().contains("\"Anyone\""));
    }

    #[test]
    fn deployment_ids_validated() {
        assert!(valid_deployment_id("AKfycbx-abc_DEF1234567890"));
        assert!(!valid_deployment_id("short"));
        assert!(!valid_deployment_id("AKfycbx/../../evil?x=1"));
    }

    #[test]
    fn allm_config_parsed_without_leaking() {
        let (id, key) = parse_allm_config(r#"{"deploymentId":" AKfycbx1234567890 ","apiKey":"k123"}"#).unwrap();
        assert_eq!((id.as_str(), key.as_str()), ("AKfycbx1234567890", "k123"));
        assert!(parse_allm_config("{}").is_err());
        assert!(parse_allm_config("").is_err());
        assert!(parse_allm_config(r#"{"deploymentId":"AKfycbx1234567890","apiKey":"*****"}"#).is_err());
        let e = parse_allm_config(r#"{"deploymentId":"bad id!","apiKey":"secret-key"}"#).unwrap_err();
        assert!(!e.contains("secret-key") && !e.contains("bad id"));
    }

    #[test]
    fn threads_formatted_with_details() {
        let data = json!({
            "resultCount": 2,
            "threads": [
                { "id": "t1", "subject": "Shoot Friday", "isUnread": true, "messageCount": 2, "lastMessageDate": "not-a-date" },
                { "id": "t2", "subject": "", "isUnread": false, "snippet": "see   you\nthere" }
            ]
        });
        let details = vec![json!({ "messages": [{ "from": "Old <o@x.com>", "body": "first" }, { "from": "Sam <sam@acme.ca>", "body": "Call time\n\n is 9am." }] })];
        let s = format_threads(&data, &details, 240);
        assert!(s.starts_with("2 email thread(s):"));
        assert!(s.contains("1. [UNREAD] From: Sam <sam@acme.ca> · Subject: \"Shoot Friday\" · not-a-date [thread t1]\n   Call time is 9am."));
        assert!(s.contains("2. From: unknown sender · Subject: \"(no subject)\" [thread t2]\n   see you there"));
        assert_eq!(format_threads(&json!({ "threads": [] }), &[], 240), "No emails found.");
    }

    #[test]
    fn thread_shows_latest_body_truncated() {
        let body = "word ".repeat(1000);
        let data = json!({ "subject": "Re: rates", "messages": [{ "from": "A" }, { "from": "B", "to": "me", "body": body }] });
        let s = format_thread(&data);
        assert!(s.starts_with("Thread: \"Re: rates\" (2 messages)\nLatest — From: B · To: me"));
        assert!(s.contains('…'));
        assert!(s.ends_with("Earlier messages from: A"));
    }

    #[test]
    fn thread_lists_attachment_names() {
        let data = json!({ "subject": "CONFIRMED", "attachments": [{ "name": "CallSheet_Nov28.pdf", "contentType": "application/pdf", "size": 1 }], "messages": [{ "from": "Sam", "body": "See attached.", "attachments": [{ "name": "CallSheet_Nov28.pdf" }, { "name": "Deal\u{7}Memo.pdf" }] }] });
        assert!(format_thread(&data).contains("\nAttachments: CallSheet_Nov28.pdf, DealMemo.pdf"), "{}", format_thread(&data));
        assert!(!format_thread(&json!({ "messages": [{ "from": "A", "body": "x" }] })).contains("Attachments"));
    }

    #[test]
    fn booking_spec_reads_query_read_and_rules() {
        let s = parse_booking_spec("query: `(booked OR \"call sheet\") newer_than:14d`\nread: 3\n\n## What counts\nConfirmed jobs.\n## Ignore\nNewsletters.");
        assert_eq!((s.query.as_str(), s.read, s.source), ("(booked OR \"call sheet\") newer_than:14d", 3, "file"));
        assert_eq!(s.rules, "## What counts\nConfirmed jobs.\n## Ignore\nNewsletters.");
        // A bad or missing value keeps the built-in one; read is 1-8.
        let s = parse_booking_spec("Query:\nREAD: 99\nrules");
        assert_eq!((s.query.as_str(), s.read, s.rules.as_str()), (BOOKING_DEFAULT_QUERY, 8, "rules"));
        assert_eq!(parse_booking_spec("read: zero").read, BOOKING_DEFAULT_READ);
        // A query's own quotes stay (a trailing quoted phrase keeps its closing quote).
        assert_eq!(parse_booking_spec("query: from:agent \"on hold\"").query, "from:agent \"on hold\"");
        // The shipped instruction file's shape (G:\ai-hub\protocols\booking-email-check.md).
        let shipped = "query: (booked OR confirmed OR \"call sheet\" OR \"deal memo\" OR audition OR \"on hold\") newer_than:30d -category:promotions -category:social\nread: 5\n\n# Booking email check\n\n## What counts\n- Confirmed bookings.";
        let s = parse_booking_spec(shipped);
        assert_eq!((s.query.as_str(), s.read), (BOOKING_DEFAULT_QUERY, 5));
        assert!(s.rules.starts_with("# Booking email check") && s.rules.ends_with("- Confirmed bookings."), "{}", s.rules);
        // On this machine, the real file (when present) parses to the same search, unclipped.
        if std::path::Path::new(BOOKING_INSTRUCTIONS_DEFAULT_PATH).is_file() {
            let real = booking_spec(BOOKING_INSTRUCTIONS_DEFAULT_PATH, &[]);
            assert_eq!((real.source, real.read), ("file", 5));
            assert!(real.rules.contains("## Summarise as") && !real.rules.ends_with('…'), "{}", real.rules);
            assert_eq!(booking_spec("", &[]), real, "\"\" is the default path");
        }
        // Only the first 4 KB counts (a cut never splits a character).
        let big = format!("query: booked\n{}", "é".repeat(5000));
        assert!(parse_booking_spec(&big).rules.chars().count() <= 1201);
        // A missing file is the default spec.
        assert_eq!(booking_spec(r"Z:\definitely\missing\booking-email-check.md", &[]), BookingSpec::default());
        let dir = std::env::temp_dir().join(format!("bk-spec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("booking-email-check.md");
        std::fs::write(&f, "query: from:agent@x.ca\nread: 2\nSummarise briefly.").unwrap();
        let root = vec![dir.to_string_lossy().into_owned()];
        let s = booking_spec(&f.to_string_lossy(), &root);
        assert_eq!((s.query.as_str(), s.read, s.rules.as_str(), s.source), ("from:agent@x.ca", 2, "Summarise briefly.", "file"));
        // The same file outside the hub and every fsRoot is never read.
        assert_eq!(booking_spec(&f.to_string_lossy(), &[]), BookingSpec::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// os.json `gmail.bookingInstructionsPath` can't aim the scan (Tony's prompt) or the Settings
    /// preview at `.env`, a key file or anything outside the hub / fsRoots.
    #[test]
    fn the_instruction_path_is_confined_to_note_files_under_the_roots() {
        let dir = std::env::temp_dir().join(format!("bk-path-{}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let env = dir.join(".env");
        std::fs::write(&env, "GMAIL_SCRIPT_KEY=supersecretvalue123\n").unwrap();
        let env_md = notes.join(".env.md");
        std::fs::write(&env_md, "GMAIL_SCRIPT_KEY=supersecretvalue123\n").unwrap();
        let json = notes.join("keys.json");
        std::fs::write(&json, "{}").unwrap();
        let ok = notes.join("booking.md");
        std::fs::write(&ok, "query: booked\nread: 3\nAPI_KEY=supersecretvalue123 is not a rule\nKeep it short.").unwrap();
        let outside = dir.join("booking.md");
        std::fs::write(&outside, "query: outside").unwrap();
        let roots = vec![notes.to_string_lossy().into_owned()];
        let p = |f: &std::path::Path| f.to_string_lossy().into_owned();
        assert_eq!(booking_instructions_file(&p(&env), &roots), InstructionFile::Refused(REFUSED_KIND));
        assert_eq!(booking_instructions_file(&p(&env_md), &roots), InstructionFile::Refused(REFUSED_KIND));
        assert_eq!(booking_instructions_file(&p(&json), &roots), InstructionFile::Refused(REFUSED_KIND));
        assert_eq!(booking_instructions_file(&p(&outside), &roots), InstructionFile::Refused(REFUSED_ROOT));
        // `..` can't climb out of a root either (judged on the resolved path).
        assert_eq!(booking_instructions_file(&format!(r"{}\..\booking.md", p(&notes)), &roots), InstructionFile::Refused(REFUSED_ROOT));
        assert_eq!(booking_instructions_file(&p(&notes.join("missing.md")), &roots), InstructionFile::Missing);
        assert!(matches!(booking_instructions_file(&p(&ok), &roots), InstructionFile::Ok(_)));
        // The repo .env named outright: refused before anything is opened.
        assert_eq!(booking_instructions_file(r"G:\agentic os\.env", &roots), InstructionFile::Refused(REFUSED_KIND));
        // The Settings view: nothing of a refused file, known secrets scrubbed from an allowed one.
        let v = instructions_view(p(&env), &roots, &["supersecretvalue123".into()]);
        assert!(!v.exists && v.preview.is_empty() && v.refused == Some(REFUSED_KIND) && v.spec == BookingSpec::default());
        let v = instructions_view(p(&ok), &roots, &["supersecretvalue123".into()]);
        assert!(v.exists && v.refused.is_none() && v.spec.query == "booked" && v.spec.read == 3);
        assert!(!v.preview.contains("supersecretvalue123") && !v.spec.rules.contains("supersecretvalue123") && v.spec.rules.contains("Keep it short."), "{} / {}", v.preview, v.spec.rules);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A reply or forward's quoted history (its "On … wrote:" / "Date:" header lines and `>`
    /// quotes) never feeds the card's date and time: only the latest message's own words do.
    #[test]
    fn quoted_history_and_headers_are_not_the_latest_message() {
        let reply = "Great news, you're confirmed for Saturday!\n\nOn Wed, Nov 25, 2026 at 4:12 PM Sam Agent <sam@agency.ca> wrote:\n> Are you free Saturday Nov 28? Call 6:30 AM.\n> Location: Pinewood";
        assert_eq!(latest_text(reply).trim(), "Great news, you're confirmed for Saturday!");
        // Gmail wraps a long "On … wrote:" line.
        let wrapped = "Confirmed.\nOn Wed, Nov 25, 2026 at 4:12 PM Sam Agent <sam@agency.ca>\nwrote:\n> Nov 28";
        assert_eq!(latest_text(wrapped).trim(), "Confirmed.");
        let outlook = "Booked!\r\n\r\nFrom: Sam Agent <sam@agency.ca>\r\nSent: Tuesday, November 24, 2026 9:02 AM\r\nTo: Nic\r\nSubject: Avail\r\n\r\nAre you free Nov 28?";
        assert_eq!(latest_text(outlook).trim(), "Booked!");
        assert_eq!(latest_text("ok\n-----Original Message-----\nNov 28").trim(), "ok");
        // A forward keeps what was passed along, minus its header lines (the send date).
        let fwd = "See below, you're booked!\n\n---------- Forwarded message ---------\nFrom: Prod <p@x.ca>\nDate: Tue, Nov 24, 2026 at 9:02 AM\nSubject: Booking\nTo: Sam <sam@agency.ca>\n\nDate: Friday, November 28\nCall time: 6:30 AM\nLocation: Pinewood Studios";
        let own = latest_text(fwd);
        assert!(!own.contains("Nov 24") && own.contains("Date: Friday, November 28") && own.contains("Call time: 6:30 AM"), "{own}");
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
        assert_eq!(one_date(&own, today).as_deref(), Some("2026-11-28"));
        assert_eq!(call_time(&own).as_deref(), Some("06:30"));
        assert_eq!(location_line(&own).as_deref(), Some("Pinewood Studios"));
        // The reply above: no date, no time, no place from the quote.
        let own = latest_text(reply);
        assert_eq!((one_date(&own, today), call_time(&own), location_line(&own)), (None, None, None));
        assert_eq!(latest_text("plain body\nno history"), "plain body\nno history");
    }

    #[test]
    fn dates_times_and_places_are_taken_only_when_plain() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
        assert_eq!(one_date("CONFIRMED: shoot Friday, November 28th", today).as_deref(), Some("2026-11-28"));
        assert_eq!(one_date("Hold for 3 Dec. Call to follow.", today).as_deref(), Some("2026-12-03"));
        assert_eq!(one_date("Shoot date 2027-01-09", today).as_deref(), Some("2027-01-09"));
        // A month long gone is next year's; two different dates are no date at all.
        assert_eq!(one_date("Jan 5 callback", today).as_deref(), Some("2027-01-05"));
        assert_eq!(one_date("Nov 28 or Nov 30, TBC", today), None);
        assert_eq!(one_date("Nov 28 … see you Nov 28th", today).as_deref(), Some("2026-11-28"));
        assert_eq!(one_date("no dates here, you may come", today), None);
        assert_eq!(call_time("Call time: 6:30 AM at the studio").as_deref(), Some("06:30"));
        assert_eq!(call_time("CALL 7pm").as_deref(), Some("19:00"));
        assert_eq!(call_time("call time is 14:15").as_deref(), Some("14:15"));
        assert_eq!(call_time("Call: 06:00, wrap 18:00").as_deref(), Some("06:00"), "a zero-led hour is a 24-hour clock");
        assert_eq!(call_time("Wrap by 6pm, lunch at 1pm"), None);
        assert_eq!(call_time("Audition slot 2:40 pm").as_deref(), Some("14:40"));
        assert_eq!(call_time("call sheet attached"), None);
        // Only a stated call time with a real clock time: never a number after "call", a reply
        // deadline, or an hour 1-11 without am / pm (a night shoot's "5:30" may be PM).
        assert_eq!(call_time("Please call 2 days before if you can't make it."), None);
        assert_eq!(call_time("You're confirmed for Friday, November 28. Please confirm by 5pm."), None);
        assert_eq!(call_time("Call: 6:30"), None);
        assert_eq!(call_time("Call time 5:30 for the night shoot"), None);
        assert_eq!(call_time("Call 416-555-0199 with questions"), None);
        assert_eq!(call_time("Call time 6:30 AM. Tuesday's call is 7 AM."), None, "two different call times: none");
        // A reply header's send time is not a call time.
        assert_eq!(call_time("On Wed, Nov 25, 2026 at 4:12 PM Sam wrote:"), None);
        assert_eq!(location_line("Hi Nic,\r\nLocation: Pinewood Toronto Studios, Stage 4.\r\nThanks").as_deref(), Some("Pinewood Toronto Studios, Stage 4"));
        assert_eq!(location_line("Settings are fine"), None);
    }

    /// The scan over a fake Apps Script bridge: one search with the spec's query, reads of the
    /// newest N in parallel (a read that errs drops only itself), compact blocks with attachment
    /// names, the 4000-char cap, and structured bookings for the card.
    #[test]
    fn booking_scan_searches_then_reads_the_newest_threads() {
        use std::sync::{Arc, Mutex};
        tauri::async_runtime::block_on(async {
            let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let c = calls.clone();
            let bridge = move |action: &'static str, args: Value| {
                c.lock().unwrap().push((action.to_string(), args.clone()));
                let id = args["threadId"].as_str().unwrap_or("").to_string();
                std::future::ready(match (action, id.as_str()) {
                    ("search", _) => Ok(json!({ "resultCount": 7, "threads": [
                        { "id": "t1", "subject": "CONFIRMED: Netflix day player", "lastMessageDate": "2026-11-21T20:04:00Z" },
                        { "id": "t2", "subject": "Audition — Bell spot", "lastMessageDate": "2026-11-20T15:00:00Z" },
                        { "id": "t3", "subject": "Avail check", "lastMessageDate": "2026-11-19T15:00:00Z" },
                        { "id": "t4", "subject": "Older one", "lastMessageDate": "2026-11-01T15:00:00Z" }
                    ] })),
                    ("read_thread", "t1") => Ok(json!({ "subject": "CONFIRMED: Netflix day player", "attachments": [{ "name": "CallSheet_Nov28.pdf" }], "messages": [{ "from": "Old" }, { "from": "Sam Agent <sam@agency.ca>", "date": "2026-11-21T20:04:00Z", "body": format!("You're booked!\nShoot Friday, November 28.\nCall time: 6:30 AM\nLocation: Pinewood Studios, Stage 4\n{}", "words ".repeat(400)) }] })),
                    ("read_thread", "t2") => Err("Gmail Apps Script failed (HTTP 500)".to_string()),
                    ("read_thread", _) => Ok(json!({ "messages": [{ "from": "Casting <c@x.ca>", "body": "Are you avail Dec 3 or Dec 4?" }] })),
                    _ => Err("unexpected".to_string()),
                })
            };
            let (text, bookings) = booking_scan_with("booked newer_than:30d", 10, 3, Duration::from_secs(8), today, &bridge).await.unwrap();
            let c = calls.lock().unwrap().clone();
            assert_eq!(c[0], ("search".to_string(), json!({ "query": "booked newer_than:30d", "limit": 10, "start": 0 })));
            assert_eq!(c.iter().filter(|(a, _)| a == "read_thread").count(), 3, "only the newest three are read");
            assert!(text.starts_with("Booking mail: 7 thread(s) matched; the newest 2 read."), "{text}");
            assert!(text.contains("From: Sam Agent <sam@agency.ca> · Subject: \"CONFIRMED: Netflix day player\" [thread t1]\n   Attachments: CallSheet_Nov28.pdf\n   You're booked!"), "{text}");
            assert!(text.contains("Subject: \"Audition — Bell spot\" [thread t2] (couldn't read it in time)"), "{text}");
            assert!(text.contains("Also matched, not read: \"Older one\""), "{text}");
            assert!(text.chars().count() <= BOOKING_SCAN_MAX);
            assert_eq!(bookings.len(), 2);
            assert_eq!(
                bookings[0],
                Booking {
                    thread_id: "t1".into(),
                    subject: "CONFIRMED: Netflix day player".into(),
                    from: "Sam Agent <sam@agency.ca>".into(),
                    received: "2026-11-21T20:04:00Z".into(),
                    attachments: vec!["CallSheet_Nov28.pdf".into()],
                    date: Some("2026-11-28".into()),
                    time: Some("06:30".into()),
                    location: Some("Pinewood Studios, Stage 4".into()),
                }
            );
            // Two dates named: no date, never a guess.
            assert_eq!((bookings[1].thread_id.as_str(), bookings[1].date.as_deref()), ("t3", None));
            let v = serde_json::to_value(&bookings[1]).unwrap();
            assert!(v.get("date").is_none() && v["threadId"] == "t3", "{v}");
            // Nothing matched: a plain line, no bookings.
            let empty = |_: &'static str, _: Value| std::future::ready(Ok(json!({ "threads": [] })));
            let (text, b) = booking_scan_with("q", 10, 5, Duration::from_secs(1), today, empty).await.unwrap();
            assert!(text.starts_with("No booking emails found") && b.is_empty(), "{text}");
            // The search failing is the tool's error.
            let down = |_: &'static str, _: Value| std::future::ready(Err::<Value, String>("Gmail Apps Script failed (HTTP 500)".into()));
            assert!(booking_scan_with("q", 10, 5, Duration::from_secs(1), today, down).await.is_err());
        });
    }

    /// The finding's case end to end: a "you're confirmed" reply quoting the agent's ask. The scan
    /// still shows Tony the whole excerpt, but the card gets no date or time from the quote or its
    /// "On … wrote:" header (no 4:12 PM event on the day the mail was sent).
    #[test]
    fn a_quoted_reply_leaves_the_cards_date_and_time_empty() {
        tauri::async_runtime::block_on(async {
            let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
            let body = "Great news, you're confirmed for Saturday!\n\nOn Wed, Nov 25, 2026 at 4:12 PM Sam Agent <sam@agency.ca> wrote:\n> Are you free Saturday for the Netflix day player? Call time 5:30.";
            let bridge = move |action: &'static str, _: Value| {
                std::future::ready(match action {
                    "search" => Ok(json!({ "threads": [{ "id": "t1", "subject": "Re: Netflix day player", "lastMessageDate": "2026-11-25T21:30:00Z" }] })),
                    _ => Ok(json!({ "messages": [{ "from": "Sam Agent <sam@agency.ca>", "date": "2026-11-25T21:30:00Z", "body": body }] })),
                })
            };
            let (text, bookings) = booking_scan_with("q", 10, 5, Duration::from_secs(2), today, bridge).await.unwrap();
            assert!(text.contains("you're confirmed for Saturday!"), "{text}");
            assert_eq!((bookings[0].date.as_deref(), bookings[0].time.as_deref(), bookings[0].location.as_deref()), (None, None, None));
        });
    }

    #[test]
    fn the_last_scan_serves_the_card_for_a_while() {
        remember_bookings(vec![Booking { thread_id: "t9".into(), ..Default::default() }], 1_000_000);
        assert_eq!(bookings_since(1_000_000).len(), 1);
        assert!(bookings_since(1_000_001).is_empty(), "an older scan isn't this turn's");
        assert_eq!(last_bookings(1_000_000 + BOOKINGS_TTL_MS).len(), 1);
        assert!(last_bookings(1_000_001 + BOOKINGS_TTL_MS).is_empty());
        // The turn result tells "no scan" from "a scan that found nothing".
        assert_eq!(scan_since(1_000_001), None, "no scan this turn");
        remember_bookings(vec![], 2_000_000);
        assert_eq!(scan_since(2_000_000), Some(vec![]), "this turn's scan found nothing");
        assert!(last_bookings(2_000_000).is_empty(), "and the desktop's list is cleared");
    }

    #[test]
    fn draft_fields_validated() {
        let (to, subject, _) = draft_fields(&json!({ "to": "sam@acme.ca, jo@x.io", "subject": "Hi\nthere", "body": "Hello" })).unwrap();
        assert_eq!(to, "sam@acme.ca, jo@x.io");
        assert_eq!(subject, "Hi there");
        assert!(draft_fields(&json!({ "to": "sam", "subject": "x", "body": "y" })).is_err());
        assert!(draft_fields(&json!({ "to": "sam@acme.ca", "subject": "x", "body": "" })).is_err());
    }
}
