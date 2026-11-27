//! Google Calendar through the user's Google Apps Script web app: the same deployment
//! AnythingLLM's Google Calendar agent uses (`google_calendar_agent_config`), and the same
//! `POST https://script.google.com/macros/s/{id}/exec` `{key, action, ...args}` → `{status, data}`
//! protocol as Gmail (`gmail.rs`). Actions used: `get_events {startDate, endDate, query, limit}`,
//! `get_events_for_day {date}`, `create_event {title, startTime, endTime | allDay + date, …}`.
//!
//! Credentials: `GCAL_SCRIPT_ID` + `GCAL_SCRIPT_KEY` (environment or repo-root `.env`, both
//! required), else the keychain pair `gcal-script-id` / `gcal-script-key` (Settings, or
//! `gcal_import_anythingllm`, which also runs once by itself on Calendar's first use when both
//! are missing: a calendar tool call, the card's add or a calendar ask's plan, `ensure_creds`;
//! never an unrelated turn's tool listing, which only checks `has_creds`).
//! The values never reach the webview, logs or error strings.
//!
//! Writes: `calendar.create_event` refuses unless approved (`PERMISSION_REQUIRED:calendar-create`);
//! only `gcal_create_event` (the confirmation card) and the phone's approved `action` inbox item
//! (`create_event_approved`) pass `approved`. Always the deployment's default (primary) calendar,
//! never guests or invites (`sendInvites: false` is forced), America/Toronto times.
//!
//! Structured read: `fetch_events` returns a window's events as `CalEvent` data for the Maps
//! trips view, behind the same gates as the tool (kill switch, MCP permission, Calendar on,
//! modes freeze). Its event text is display-only and never handed to an agent.

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::State;

use super::bridge::BridgeState;
use super::dispatch::{short, DispatchState};
use super::os_core::{self, OsState};

const SECRET_ID: &str = "gcal-script-id";
const SECRET_KEY: &str = "gcal-script-key";
pub(crate) const NO_BACKEND: &str = "Google Calendar: no backend — import the Apps Script deployment from AnythingLLM in Settings → Integrations, or set GCAL_SCRIPT_ID / GCAL_SCRIPT_KEY";
/// The refusal of an unapproved create (the card's scope name).
pub(crate) const PERMISSION: &str = "PERMISSION_REQUIRED:calendar-create";
pub(crate) const CREATE: &str = "calendar.create_event";
/// Default length of an event the card gave no end time.
const DEFAULT_MINUTES: i64 = 60;
const TITLE_MAX: usize = 200;
const LOCATION_MAX: usize = 300;
const DESCRIPTION_MAX: usize = 2000;
/// The automatic AnythingLLM import runs at most this often when the pair is missing.
const AUTO_IMPORT_EVERY_MS: u64 = 10 * 60 * 1000;
static LAST_AUTO_IMPORT: AtomicU64 = AtomicU64::new(0);

/// The Apps Script deployment ID + key: `GCAL_SCRIPT_ID` / `GCAL_SCRIPT_KEY` (env / repo `.env`,
/// both), else the keychain pair. Read on every call.
fn creds(state: &DispatchState) -> Option<(String, String)> {
    env_pair(state).or_else(|| Some((os_core::os_secret(SECRET_ID)?, os_core::os_secret(SECRET_KEY)?)))
}

/// The env pair, only when BOTH are set (half a pair is never mixed with a keychain half).
pub(crate) fn env_pair(state: &DispatchState) -> Option<(String, String)> {
    let env = |k| super::envfile::env_or_file(state, k);
    Some((env("GCAL_SCRIPT_ID")?, env("GCAL_SCRIPT_KEY")?))
}

/// Is the Apps Script pair set (env or keychain)? Never imports: a tool listing (every turn's,
/// and the Settings registry's) uses this, so only an actual calendar use runs the import.
pub(crate) fn has_creds(state: &DispatchState) -> bool {
    creds(state).is_some()
}

/// The automatic import's throttle: may an import start at `now` after one started at `last`
/// (0: never)? Claims the slot when it may. At most once per `AUTO_IMPORT_EVERY_MS`.
fn claim_auto_import(now: u64) -> bool {
    let last = LAST_AUTO_IMPORT.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < AUTO_IMPORT_EVERY_MS {
        return false;
    }
    LAST_AUTO_IMPORT.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
}

#[cfg(test)]
thread_local! {
    /// Tests: how often this thread asked for credentials WITH the import allowed.
    static ENSURE_CALLS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn ensure_calls() -> u32 {
    ENSURE_CALLS.with(|c| c.get())
}

/// The credentials on Calendar's first USE (a calendar tool call, the card's add, a calendar
/// ask's plan — Nic approved the import for that, never for an unrelated turn's tool listing):
/// when none are set, AnythingLLM's deployment is imported first (at most once per
/// `AUTO_IMPORT_EVERY_MS`). The import (a SQLite read with a 3 s busy timeout, then keychain
/// writes) runs on the blocking pool, never on an async worker. Never logs or returns a value
/// anywhere else.
pub(crate) async fn ensure_creds(state: &DispatchState) -> Option<(String, String)> {
    #[cfg(test)]
    ENSURE_CALLS.with(|c| c.set(c.get() + 1));
    if let Some(c) = creds(state) {
        return Some(c);
    }
    if !claim_auto_import(super::compaction::now_ms()) {
        return None;
    }
    match tauri::async_runtime::spawn_blocking(auto_import).await {
        Ok(Ok(())) => {
            eprintln!("[calendar] imported the Google Calendar deployment from AnythingLLM into the keychain");
            creds(state)
        }
        _ => None,
    }
}

/// Where the Calendar backend comes from (names only): "env" | "keychain" | "none".
pub(crate) fn source_label(state: &DispatchState) -> &'static str {
    if env_pair(state).is_some() {
        "env"
    } else if creds(state).is_some() {
        "keychain"
    } else {
        "none"
    }
}

async fn script(state: &DispatchState, action: &'static str, args: Value, secs: u64) -> Result<Value, String> {
    let Some((id, key)) = ensure_creds(state).await else {
        return Err(NO_BACKEND.into());
    };
    let id = id.trim().to_string();
    if !super::gmail::valid_deployment_id(&id) {
        return Err("the saved Google Calendar Apps Script deployment ID is malformed — import it again in Settings → Integrations".into());
    }
    let mut body = args.as_object().cloned().unwrap_or_default();
    body.insert("key".into(), json!(key.trim()));
    body.insert("action".into(), json!(action));
    let r = state
        .http
        .post(format!("https://script.google.com/macros/s/{id}/exec"))
        .timeout(Duration::from_secs(secs))
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Calendar Apps Script {}", short(e)))?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| format!("Calendar Apps Script {}", short(e)))?;
    super::gmail::script_reply("Calendar", status, &text)
}

// ── America/Toronto ─────────────────────────────────────────────────────────

/// Toronto's UTC offset (hours) at local `date` `time`: EDT (-4) from the second Sunday of March
/// 02:00 to the first Sunday of November 02:00, else EST (-5). Pure.
pub(crate) fn toronto_offset_hours(date: NaiveDate, time: NaiveTime) -> i32 {
    let nth_sunday = |month: u32, n: u32| -> NaiveDate {
        let first = NaiveDate::from_ymd_opt(date.year(), month, 1).expect("valid month");
        let to_sun = (7 - first.weekday().num_days_from_sunday()) % 7;
        first + chrono::Duration::days((to_sun + 7 * (n - 1)) as i64)
    };
    let two = NaiveTime::from_hms_opt(2, 0, 0).expect("2 am");
    let start = NaiveDateTime::new(nth_sunday(3, 2), two);
    let end = NaiveDateTime::new(nth_sunday(11, 1), two);
    let at = NaiveDateTime::new(date, time);
    if at >= start && at < end {
        -4
    } else {
        -5
    }
}

/// A Toronto wall-clock time as RFC 3339 with its offset ("2026-11-28T09:00:00-05:00"). Pure.
pub(crate) fn toronto_rfc3339(at: NaiveDateTime) -> String {
    let h = toronto_offset_hours(at.date(), at.time());
    format!("{}{}{:02}:00", at.format("%Y-%m-%dT%H:%M:%S"), if h < 0 { '-' } else { '+' }, h.abs())
}

/// "YYYY-MM-DD", or "today" / "tomorrow" against `today`. Pure.
pub(crate) fn parse_day(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    match s.trim().to_ascii_lowercase().as_str() {
        "today" | "" => Some(today),
        "tomorrow" => today.succ_opt(),
        d => NaiveDate::parse_from_str(d, "%Y-%m-%d").ok(),
    }
}

/// "YYYY-MM-DDTHH:MM[:SS]" (Toronto wall clock; a trailing offset or Z is refused, so the card's
/// own words are the only time), or "HH:MM" on `date`. Pure.
pub(crate) fn parse_local(s: &str, date: Option<NaiveDate>) -> Option<NaiveDateTime> {
    let s = s.trim();
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, f) {
            return Some(t);
        }
    }
    let t = NaiveTime::parse_from_str(s, "%H:%M").ok()?;
    Some(NaiveDateTime::new(date?, t))
}

/// The `calendar.upcoming` range for `period` from `today`: [start, end) as Toronto dates plus a
/// label. today / tomorrow / week (next 7 days) / next week / month (next 30 days). Pure.
pub(crate) fn period_range(period: &str, today: NaiveDate) -> Option<(NaiveDate, NaiveDate, &'static str)> {
    let d = |n: i64| today + chrono::Duration::days(n);
    Some(match period.trim().to_ascii_lowercase().as_str() {
        "today" => (today, d(1), "today"),
        "tomorrow" => (d(1), d(2), "tomorrow"),
        "" | "week" | "this week" | "7d" => (today, d(8), "the next 7 days"),
        "next week" => (d(7), d(15), "next week"),
        "month" | "this month" | "30d" => (today, d(31), "the next 30 days"),
        _ => return None,
    })
}

// ── Tools ───────────────────────────────────────────────────────────────────

fn arg_str<'a>(args: &'a Value, k: &str) -> &'a str {
    args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

/// Control characters out, whitespace runs kept, capped.
fn clean(s: &str, max: usize) -> String {
    s.chars().map(|c| if c.is_control() && c != '\n' { ' ' } else { c }).take(max).collect::<String>().trim().to_string()
}

/// `name` is a `calendar.*` builtin. `approved` matters only for `create_event`.
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value, approved: bool) -> Result<String, String> {
    if os.snapshot().privacy.kill_switch {
        return Err(KILLED.into());
    }
    let today = chrono::Local::now().date_naive();
    match name {
        "calendar.upcoming" => upcoming_with(args, today, |a, v| script(state, a, v, 15)).await,
        "calendar.day" => day_with(args, today, |a, v| script(state, a, v, 15)).await,
        CREATE => {
            if !approved {
                return Err(PERMISSION.into());
            }
            create_with(args, today, |a, v| script(state, a, v, 20)).await
        }
        _ => Err(format!("unknown Calendar tool {name}")),
    }
}

fn midnight() -> NaiveTime {
    NaiveTime::from_hms_opt(0, 0, 0).expect("midnight")
}

pub(crate) async fn upcoming_with<F, Fut>(args: &Value, today: NaiveDate, call: F) -> Result<String, String>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let period = arg_str(args, "period");
    let Some((from, to, label)) = period_range(period, today) else {
        return Err("calendar.upcoming period must be today, tomorrow, week, next week or month".into());
    };
    let query = clean(arg_str(args, "query"), 200);
    let mut body = json!({
        "startDate": toronto_rfc3339(NaiveDateTime::new(from, midnight())),
        "endDate": toronto_rfc3339(NaiveDateTime::new(to, midnight())),
        "limit": 25,
    });
    if !query.is_empty() {
        body["query"] = json!(query);
    }
    let data = call("get_events", body).await?;
    Ok(format_events(&data, label, &query))
}

pub(crate) async fn day_with<F, Fut>(args: &Value, today: NaiveDate, call: F) -> Result<String, String>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let Some(day) = parse_day(arg_str(args, "date"), today) else {
        return Err("calendar.day needs a date as YYYY-MM-DD (or today / tomorrow)".into());
    };
    let data = call("get_events_for_day", json!({ "date": day.format("%Y-%m-%d").to_string() })).await?;
    Ok(format_events(&data, &day.format("%A, %B %-d").to_string(), ""))
}

/// The validated `create_event` body: the card's fields only, `sendInvites: false`, no guests, no
/// calendar id (the deployment's default, primary calendar). Timed: Toronto RFC 3339, one hour
/// when no end. All-day: `allDay` + `date`. Pure.
pub(crate) fn create_body(args: &Value, today: NaiveDate) -> Result<Value, String> {
    let title = clean(arg_str(args, "title"), TITLE_MAX).replace('\n', " ");
    if title.is_empty() {
        return Err("a calendar event needs a title".into());
    }
    let date = match arg_str(args, "date") {
        "" => None,
        d => Some(parse_day(d, today).ok_or("the event date must be YYYY-MM-DD")?),
    };
    let mut body = json!({ "title": title, "sendInvites": false });
    if args.get("allDay").and_then(Value::as_bool) == Some(true) {
        let date = date.ok_or("an all-day event needs a date")?;
        // Like a timed start: more than a day in the past is refused (the card says "in the past").
        if date < today - chrono::Duration::days(1) {
            return Err("that date is in the past".into());
        }
        body["allDay"] = json!(true);
        body["date"] = json!(date.format("%Y-%m-%d").to_string());
    } else {
        let start = parse_local(arg_str(args, "startTime"), date).ok_or("a timed event needs a start time (YYYY-MM-DDTHH:MM, or HH:MM with a date)")?;
        let end = match arg_str(args, "endTime") {
            "" => start + chrono::Duration::minutes(DEFAULT_MINUTES),
            e => parse_local(e, Some(start.date())).ok_or("the end time must be YYYY-MM-DDTHH:MM or HH:MM")?,
        };
        if end <= start || end - start > chrono::Duration::hours(24) {
            return Err("the event must end after it starts, within 24 hours".into());
        }
        if start.date() < today - chrono::Duration::days(1) {
            return Err("that start time is in the past".into());
        }
        body["startTime"] = json!(toronto_rfc3339(start));
        body["endTime"] = json!(toronto_rfc3339(end));
    }
    let location = clean(arg_str(args, "location"), LOCATION_MAX).replace('\n', " ");
    if !location.is_empty() {
        body["location"] = json!(location);
    }
    let description = clean(arg_str(args, "description"), DESCRIPTION_MAX);
    if !description.is_empty() {
        body["description"] = json!(description);
    }
    Ok(body)
}

pub(crate) async fn create_with<F, Fut>(args: &Value, today: NaiveDate, call: F) -> Result<String, String>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let body = create_body(args, today)?;
    let data = call("create_event", body.clone()).await?;
    let ev = if data["event"].is_object() { &data["event"] } else { &data };
    let title = ev["title"].as_str().or_else(|| body["title"].as_str()).unwrap_or("");
    let when = if body["allDay"] == true {
        format!("all day on {}", body["date"].as_str().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).map(|d| d.format("%a %b %-d").to_string()).unwrap_or_default())
    } else {
        format!("{} – {}", event_time(body["startTime"].as_str().unwrap_or("")), event_time(body["endTime"].as_str().unwrap_or("")).rsplit(", ").next().unwrap_or(""))
    };
    Ok(format!("Added to your Google Calendar: \"{title}\", {when}. No invites were sent."))
}

/// An event time for a line: "Fri Nov 28, 9:00 AM" (Toronto wall clock as sent), else as given.
fn event_time(s: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| {
            let off = d.offset().local_minus_utc() / 3600;
            let local = d.naive_utc() + chrono::Duration::hours(off as i64);
            let toronto = d.naive_utc() + chrono::Duration::hours(toronto_offset_hours(local.date(), local.time()) as i64);
            toronto.format("%a %b %-d, %-I:%M %p").to_string()
        })
        .unwrap_or_else(|_| s.to_string())
}

/// `get_events` / `get_events_for_day` data (`{events: […]}` or a bare list) as numbered lines.
pub(crate) fn format_events(data: &Value, label: &str, query: &str) -> String {
    let events: Vec<&Value> = data["events"].as_array().or_else(|| data.as_array()).into_iter().flatten().collect();
    let filter = if query.is_empty() { String::new() } else { format!(" matching \"{query}\"") };
    if events.is_empty() {
        return format!("No events on the calendar for {label}{filter}.");
    }
    let lines: Vec<String> = events
        .iter()
        .take(25)
        .enumerate()
        .map(|(i, e)| {
            let title = e["title"].as_str().or_else(|| e["summary"].as_str()).unwrap_or("(untitled)");
            let all_day = e["isAllDayEvent"].as_bool().or_else(|| e["allDay"].as_bool()).unwrap_or(false);
            let when = if all_day {
                let d = e["startDate"].as_str().or_else(|| e["startTime"].as_str()).unwrap_or("");
                format!("{} · all day", event_time(d).split(", ").next().unwrap_or(d))
            } else {
                let end = event_time(e["endTime"].as_str().unwrap_or(""));
                format!("{} – {}", event_time(e["startTime"].as_str().unwrap_or("")), end.rsplit(", ").next().unwrap_or(&end))
            };
            let place = e["location"].as_str().map(str::trim).filter(|l| !l.is_empty()).map(|l| format!(" · {}", clean(l, 120))).unwrap_or_default();
            format!("{}. {when} · {}{place}", i + 1, clean(title, 160))
        })
        .collect();
    format!("{} event(s) for {label}{filter}:\n{}", events.len(), lines.join("\n"))
}

// ── Structured read (Maps trips) ────────────────────────────────────────────
//
// `fetch_events`: the events in a window as data, for the Maps trips view (`trips.rs`). Read-only,
// behind the calendar tool's own gates (kill switch, the MCP permission tier, Calendar switched
// on, modes / switchboard freeze), and it logs no content. Event text (title, location,
// description) can come from third-party invites, so it is DISPLAY-ONLY: never handed to an
// agent, never followed. The Apps Script reply shape is unverified for `id` and `description`
// (the known fixture has neither), so both are optional and every field is parsed defensively;
// an entry without a usable start is skipped, never an error.

/// Most events one structured read returns (also the `get_events` limit it sends).
pub(crate) const MAX_EVENTS: usize = 25;
/// Reply entries looked at, at most (a huge reply is never walked in full).
const SCAN_MAX: usize = 200;
const ID_MAX: usize = 256;
/// The longest window one structured read asks for.
const WINDOW_MAX_DAYS: i64 = 31;
// Used by the Maps trips view (`trips.rs`, Maps step 6); until it lands only tests call it.
#[allow(dead_code)]
/// The name a structured read is permission-gated and logged as (never any event text).
pub(crate) const EVENTS: &str = "calendar.events";
const KILLED: &str = "kill switch is on — Google Calendar is a cloud service";

/// One calendar event as data. Times are RFC 3339 in Toronto's offset at that instant
/// ("2026-11-27T10:00:00-05:00") plus the exact epoch milliseconds. An all-day event starts at
/// Toronto midnight. `id` and `description` are optional: the deployment may not send them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub id: Option<String>,
    pub title: String,
    pub start: String,
    pub start_ms: i64,
    pub end: Option<String>,
    pub end_ms: Option<i64>,
    pub all_day: bool,
    pub location: Option<String>,
    pub description: Option<String>,
}

// Used by the Maps trips view (`trips.rs`, Maps step 6); until it lands only tests call it.
#[allow(dead_code)]
impl CalEvent {
    /// A stable key: the calendar's id, else "h:" + a SHA-256 prefix of title and start (which
    /// changes if the event is retitled or moved — the cost of a reply without ids). Pure.
    pub(crate) fn key(&self) -> String {
        use sha2::{Digest, Sha256};
        match &self.id {
            Some(id) => id.clone(),
            None => {
                let h = Sha256::digest(format!("{}\u{0}{}", self.title, self.start_ms).as_bytes());
                format!("h:{}", h[..8].iter().map(|b| format!("{b:02x}")).collect::<String>())
            }
        }
    }
}

/// Toronto's UTC offset (hours) at the UTC instant `utc`, exact through both DST changes (the
/// skipped and the repeated hour included): EDT only when the instant is past the spring change
/// read as EST AND before the fall change read as EDT. Pure.
pub(crate) fn toronto_offset_at_utc(utc: NaiveDateTime) -> i32 {
    let as_est = utc - chrono::Duration::hours(5);
    let as_edt = utc - chrono::Duration::hours(4);
    if toronto_offset_hours(as_est.date(), as_est.time()) == -4 && toronto_offset_hours(as_edt.date(), as_edt.time()) == -4 {
        -4
    } else {
        -5
    }
}

/// A UTC instant as Toronto RFC 3339 with the offset in force then. Pure.
fn toronto_rfc3339_of_utc(utc: NaiveDateTime) -> String {
    let h = toronto_offset_at_utc(utc);
    let local = utc + chrono::Duration::hours(h as i64);
    format!("{}-{:02}:00", local.format("%Y-%m-%dT%H:%M:%S"), h.abs())
}

/// A Toronto wall-clock time → the UTC instant (the repeated fall hour reads as EDT). Pure.
fn toronto_wall_to_utc(at: NaiveDateTime) -> NaiveDateTime {
    at - chrono::Duration::hours(toronto_offset_hours(at.date(), at.time()) as i64)
}

/// One reply time → (UTC instant, was it a bare date?). Accepts RFC 3339 with an offset or Z
/// (".000Z" too), a Toronto wall-clock "YYYY-MM-DDTHH:MM[:SS]", a bare "YYYY-MM-DD" (Toronto
/// midnight), epoch milliseconds, or Google's `{dateTime | date}` object. Else None. Pure.
fn reply_time(v: &Value) -> Option<(NaiveDateTime, bool)> {
    match v {
        Value::String(s) => {
            let s = s.trim();
            if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some((d.naive_utc(), false));
            }
            if let Some(t) = parse_local(s, None) {
                return Some((toronto_wall_to_utc(t), false));
            }
            let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
            Some((toronto_wall_to_utc(NaiveDateTime::new(d, midnight())), true))
        }
        // Milliseconds only in a plausible range (1973 – 5138): seconds or junk are refused.
        Value::Number(n) => n
            .as_i64()
            .filter(|ms| (100_000_000_000..100_000_000_000_000).contains(ms))
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|d| (d.naive_utc(), false)),
        Value::Object(o) => o.get("dateTime").and_then(reply_time).or_else(|| o.get("date").and_then(reply_time).map(|(t, _)| (t, true))),
        _ => None,
    }
}

/// One line of display text: control characters and newlines out, capped, trimmed. Pure.
fn one_line(s: &str, max: usize) -> String {
    clean(s, max).replace('\n', " ").trim().to_string()
}

/// One reply entry → a `CalEvent`, or None when it has no usable start. Pure.
fn cal_event_of(e: &Value) -> Option<CalEvent> {
    let text = |keys: &[&str]| keys.iter().find_map(|k| e.get(*k).and_then(Value::as_str)).map(str::trim).filter(|s| !s.is_empty());
    let flag = e.get("isAllDayEvent").and_then(Value::as_bool).or_else(|| e.get("allDay").and_then(Value::as_bool));
    let first = |keys: [&str; 3]| keys.iter().find_map(|k| e.get(*k).and_then(reply_time));
    let (start_utc, date_only) = if flag == Some(true) { first(["startDate", "startTime", "start"]) } else { first(["startTime", "startDate", "start"]) }?;
    let all_day = flag.unwrap_or(date_only);
    let end_utc = if all_day { first(["endDate", "endTime", "end"]) } else { first(["endTime", "endDate", "end"]) }.map(|(t, _)| t).filter(|t| *t >= start_utc);
    let id = match e.get("id").or_else(|| e.get("eventId")) {
        Some(Value::String(s)) => Some(one_line(s, ID_MAX)),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
    .filter(|s| !s.is_empty());
    let title = text(&["title", "summary"]).map(|t| one_line(t, TITLE_MAX)).filter(|t| !t.is_empty()).unwrap_or_else(|| "(untitled)".into());
    Some(CalEvent {
        id,
        title,
        start: toronto_rfc3339_of_utc(start_utc),
        start_ms: start_utc.and_utc().timestamp_millis(),
        end: end_utc.map(toronto_rfc3339_of_utc),
        end_ms: end_utc.map(|t| t.and_utc().timestamp_millis()),
        all_day,
        location: text(&["location"]).map(|l| one_line(l, LOCATION_MAX)).filter(|l| !l.is_empty()),
        description: text(&["description"]).map(|d| clean(d, DESCRIPTION_MAX)).filter(|d| !d.is_empty()),
    })
}

/// `get_events` data (`{events: […]}` or a bare list) as events: entries without a usable start
/// skipped, sorted by start (reply order among equals), at most `MAX_EVENTS`. Pure.
pub(crate) fn cal_events_of(data: &Value) -> Vec<CalEvent> {
    let list = data.get("events").and_then(Value::as_array).or_else(|| data.as_array());
    let mut out: Vec<CalEvent> = list.into_iter().flatten().take(SCAN_MAX).filter_map(cal_event_of).collect();
    out.sort_by_key(|e| e.start_ms);
    out.truncate(MAX_EVENTS);
    out
}

/// The `get_events` body for Toronto dates [from, to): at most `WINDOW_MAX_DAYS`. Pure.
pub(crate) fn events_body(from: NaiveDate, to: NaiveDate) -> Result<Value, String> {
    if to <= from || to - from > chrono::Duration::days(WINDOW_MAX_DAYS) {
        return Err(format!("a calendar window must end after it starts, within {WINDOW_MAX_DAYS} days"));
    }
    Ok(json!({
        "startDate": toronto_rfc3339(NaiveDateTime::new(from, midnight())),
        "endDate": toronto_rfc3339(NaiveDateTime::new(to, midnight())),
        "limit": MAX_EVENTS,
    }))
}

/// The gates every calendar USE passes after the kill switch: the MCP permission tier (an Ask
/// tier refuses a call nobody approved), Calendar switched on, the modes / switchboard freeze.
fn use_gates(cfg: &os_core::OsConfig, os: &OsState, bridge: &BridgeState, tool: &str, approved: bool) -> Result<(), String> {
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", approved, json!({ "tool": tool }))?;
    if !cfg.mcps.iter().any(|m| m.id == "calendar" && m.enabled) {
        return Err("Google Calendar is switched off — enable it in Settings → Skills & MCP Library".into());
    }
    if let Some(e) = super::modes::tool_frozen_error(&os.modes.effective(), &cfg.switchboard, "calendar") {
        return Err(e);
    }
    Ok(())
}

/// The structured read with the bridge injected (tests). Every gate runs before `call`.
pub(crate) async fn fetch_events_with<F, Fut>(os: &OsState, bridge: &BridgeState, from: NaiveDate, to: NaiveDate, call: F) -> Result<Vec<CalEvent>, String>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err(KILLED.into());
    }
    // Nobody approves a background read, so an Ask tier refuses it (PERMISSION_REQUIRED:mcp).
    use_gates(&cfg, os, bridge, EVENTS, false)?;
    let body = events_body(from, to)?;
    let data = call("get_events", body).await?;
    Ok(cal_events_of(&data))
}

// Used by the Maps trips view (`trips.rs`, Maps step 6); until it lands only tests call it.
#[allow(dead_code)]
/// The events on Toronto dates [from, to) as data (see the section note: display-only).
pub(crate) async fn fetch_events(state: &DispatchState, os: &OsState, bridge: &BridgeState, from: NaiveDate, to: NaiveDate) -> Result<Vec<CalEvent>, String> {
    fetch_events_with(os, bridge, from, to, |a, v| script(state, a, v, 15)).await
}

// Used by the Maps trips view (`trips.rs`, Maps step 6); until it lands only tests call it.
#[allow(dead_code)]
/// A structured read's refusal → the Maps view's `calendar` state: "blocked" (kill switch, MCP
/// permission), "off", "frozen", "no-backend", else "error". Pure.
pub(crate) fn read_state(e: &str) -> &'static str {
    if e == KILLED || e.starts_with("PERMISSION_") {
        "blocked"
    } else if e.starts_with("Google Calendar is switched off") {
        "off"
    } else if e.starts_with(super::modes::MODE_FROZEN) {
        "frozen"
    } else if e == NO_BACKEND || e.contains("deployment ID is malformed") {
        "no-backend"
    } else {
        "error"
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarStatus {
    configured: bool,
    /// "env" | "keychain" | "none" (names only).
    source: &'static str,
}

#[tauri::command]
pub async fn gcal_status(state: State<'_, DispatchState>) -> Result<CalendarStatus, String> {
    let source = source_label(&state);
    Ok(CalendarStatus { configured: source != "none", source })
}

/// The one approved path for a calendar add (the desktop card's `gcal_create_event` and the
/// phone's approved `action` inbox item): approved, the MCP permission gate, the switchboard,
/// Calendar switched on; the kill switch is checked by `tool`. Logs no content.
pub(crate) async fn create_event_approved(state: &DispatchState, os: &OsState, bridge: &BridgeState, args: &Value, approved: bool, via: &str) -> Result<String, String> {
    if !approved {
        return Err(PERMISSION.into());
    }
    use_gates(&os.snapshot(), os, bridge, CREATE, true)?;
    let out = tool(state, os, CREATE, args, true).await;
    bridge.log(json!({ "type": "os-tool", "tool": CREATE, "ok": out.is_ok(), "via": via }));
    out
}

/// The confirmation card's approved add (execute.ts `runTool`): refuses unless `approved`.
#[tauri::command]
pub async fn gcal_create_event(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, args: Value, approved: Option<bool>) -> Result<String, String> {
    create_event_approved(&state, &os, &bridge, &args, approved.unwrap_or(false), "card").await
}

#[derive(Serialize)]
pub struct ImportResult {
    imported: bool,
    detail: String,
}

/// Copy AnythingLLM Desktop's Google Calendar agent deployment into the keychain (read-only on
/// AnythingLLM's side; the values never leave Rust).
#[tauri::command]
pub async fn gcal_import_anythingllm(state: State<'_, DispatchState>) -> Result<ImportResult, String> {
    let r = tauri::async_runtime::spawn_blocking(import_from_anythingllm).await.map_err(|e| e.to_string())?;
    let shadowed = env_pair(&state).is_some();
    Ok(match r {
        Ok(()) if shadowed => ImportResult {
            imported: true,
            detail: "Imported the Google Calendar deployment from AnythingLLM into the keychain — but GCAL_SCRIPT_ID and GCAL_SCRIPT_KEY are set in the environment / repo .env, and those are used first.".into(),
        },
        Ok(()) => ImportResult { imported: true, detail: "Imported the Google Calendar deployment from AnythingLLM.".into() },
        Err(detail) => ImportResult { imported: false, detail },
    })
}

/// The automatic import `ensure_creds` runs. Tests never read AnythingLLM's database or write
/// the real keychain.
fn auto_import() -> Result<(), String> {
    if cfg!(test) {
        Err("tests never import".into())
    } else {
        import_from_anythingllm()
    }
}

fn import_from_anythingllm() -> Result<(), String> {
    use rusqlite::{OpenFlags, OptionalExtension};
    let path = super::gmail::anythingllm_db_path().ok_or("%APPDATA% is not set")?;
    if !path.is_file() {
        return Err("AnythingLLM Desktop's database wasn't found — is AnythingLLM installed?".into());
    }
    let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| format!("couldn't open AnythingLLM's database: {e}"))?;
    let _ = conn.busy_timeout(Duration::from_secs(3));
    let raw: Option<Option<String>> = conn
        .query_row("SELECT value FROM system_settings WHERE label = 'google_calendar_agent_config'", [], |r| r.get(0))
        .optional()
        .map_err(|e| format!("couldn't read AnythingLLM's settings: {e}"))?;
    let (id, key) = parse_allm_config(raw.flatten().as_deref().unwrap_or(""))?;
    os_core::os_secret_store(SECRET_ID, &id)?;
    os_core::os_secret_store(SECRET_KEY, &key)
}

/// AnythingLLM's `google_calendar_agent_config` JSON → (deploymentId, apiKey). Errors never
/// quote either value.
fn parse_allm_config(raw: &str) -> Result<(String, String), String> {
    const MISSING: &str = "AnythingLLM has no Google Calendar deployment configured (Agent Skills → Google Calendar)";
    let v: Value = serde_json::from_str(raw).map_err(|_| MISSING.to_string())?;
    let id = v["deploymentId"].as_str().map(str::trim).unwrap_or("");
    let key = v["apiKey"].as_str().map(str::trim).unwrap_or("");
    if id.is_empty() || key.is_empty() || key.chars().all(|c| c == '*') {
        return Err(MISSING.into());
    }
    if !super::gmail::valid_deployment_id(id) || key.len() > 4096 {
        return Err("AnythingLLM's Google Calendar deployment ID doesn't look valid — set GCAL_SCRIPT_ID / GCAL_SCRIPT_KEY instead".into());
    }
    Ok((id.to_string(), key.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    type Calls = Arc<Mutex<Vec<(String, Value)>>>;

    /// A fake Apps Script bridge: records every (action, body) and answers `reply`.
    fn fake(reply: Value) -> (Calls, impl Fn(&'static str, Value) -> std::future::Ready<Result<Value, String>>) {
        let calls: Calls = Arc::default();
        let c = calls.clone();
        (calls, move |a: &'static str, v: Value| {
            c.lock().unwrap().push((a.to_string(), v));
            std::future::ready(Ok(reply.clone()))
        })
    }

    #[test]
    fn toronto_offsets_follow_dst() {
        let t = |h| NaiveTime::from_hms_opt(h, 0, 0).unwrap();
        assert_eq!(toronto_offset_hours(d("2026-11-28"), t(9)), -5);
        assert_eq!(toronto_offset_hours(d("2026-07-01"), t(9)), -4);
        // 2026: DST starts Sun Mar 8 at 02:00, ends Sun Nov 1 at 02:00.
        assert_eq!(toronto_offset_hours(d("2026-03-08"), t(1)), -5);
        assert_eq!(toronto_offset_hours(d("2026-03-08"), t(3)), -4);
        assert_eq!(toronto_offset_hours(d("2026-11-01"), t(1)), -4);
        assert_eq!(toronto_offset_hours(d("2026-11-01"), t(3)), -5);
        assert_eq!(toronto_rfc3339(parse_local("2026-11-28T09:00", None).unwrap()), "2026-11-28T09:00:00-05:00");
        assert_eq!(toronto_rfc3339(parse_local("2026-06-02T18:30", None).unwrap()), "2026-06-02T18:30:00-04:00");
    }

    #[test]
    fn create_body_forces_no_invites_and_one_hour() {
        let today = d("2026-11-26");
        let b = create_body(&json!({ "title": "Netflix day player\u{7}", "startTime": "2026-11-28T07:30", "location": "Pinewood Studios", "guests": ["x@y.com"], "sendInvites": true, "calendarId": "evil@group" }), today).unwrap();
        assert_eq!(b, json!({ "title": "Netflix day player", "sendInvites": false, "startTime": "2026-11-28T07:30:00-05:00", "endTime": "2026-11-28T08:30:00-05:00", "location": "Pinewood Studios" }));
        // HH:MM with a date; an explicit end.
        let b = create_body(&json!({ "title": "Audition", "date": "2026-11-30", "startTime": "14:00", "endTime": "14:20" }), today).unwrap();
        assert_eq!((b["startTime"].as_str(), b["endTime"].as_str()), (Some("2026-11-30T14:00:00-05:00"), Some("2026-11-30T14:20:00-05:00")));
        // All day.
        let b = create_body(&json!({ "title": "Hold", "allDay": true, "date": "2026-12-03" }), today).unwrap();
        assert_eq!(b, json!({ "title": "Hold", "sendInvites": false, "allDay": true, "date": "2026-12-03" }));
        // Refusals: no title, no start, end before start, a time with an offset, the past.
        for bad in [
            json!({ "startTime": "2026-11-28T07:30" }),
            json!({ "title": "x" }),
            json!({ "title": "x", "allDay": true }),
            json!({ "title": "x", "startTime": "2026-11-28T09:00", "endTime": "2026-11-28T08:00" }),
            json!({ "title": "x", "startTime": "2026-11-28T09:00:00Z" }),
            json!({ "title": "x", "startTime": "2026-01-02T09:00" }),
            json!({ "title": "x", "allDay": true, "date": "2026-11-24" }),
        ] {
            assert!(create_body(&bad, today).is_err(), "{bad}");
        }
        // Up to a day back is still accepted (the card says "this is in the past"); older is refused.
        assert!(create_body(&json!({ "title": "x", "startTime": "2026-11-25T09:00" }), today).is_ok());
        assert!(create_body(&json!({ "title": "x", "allDay": true, "date": "2026-11-25" }), today).is_ok());
        assert_eq!(create_body(&json!({ "title": "x", "startTime": "2026-11-24T23:00" }), today).unwrap_err(), "that start time is in the past");
    }

    #[test]
    fn create_refuses_unapproved_and_sends_only_the_validated_body() {
        tauri::async_runtime::block_on(async {
            let today = d("2026-11-26");
            let (calls, bridge) = fake(json!({ "event": { "id": "e1", "title": "Netflix day player" } }));
            let out = create_with(&json!({ "title": "Netflix day player", "startTime": "2026-11-28T07:30", "guests": "a@b.c" }), today, &bridge).await.unwrap();
            assert_eq!(out, "Added to your Google Calendar: \"Netflix day player\", Sat Nov 28, 7:30 AM – 8:30 AM. No invites were sent.");
            let c = calls.lock().unwrap().clone();
            assert_eq!(c.len(), 1);
            assert_eq!(c[0].0, "create_event");
            assert!(c[0].1.get("guests").is_none() && c[0].1["sendInvites"] == false && c[0].1.get("calendarId").is_none(), "{}", c[0].1);
            // A bad body never reaches the bridge.
            assert!(create_with(&json!({ "title": "" }), today, &bridge).await.is_err());
            assert_eq!(calls.lock().unwrap().len(), 1);
        });
    }

    #[test]
    fn reads_ask_the_bridge_for_toronto_ranges_and_format_events() {
        tauri::async_runtime::block_on(async {
            let today = d("2026-11-26");
            let reply = json!({ "totalEvents": 2, "events": [
                { "title": "Fitting", "startTime": "2026-11-27T15:00:00.000Z", "endTime": "2026-11-27T16:00:00.000Z", "isAllDayEvent": false, "location": "Wardrobe, Stage 4" },
                { "title": "Hold: Bell spot", "startDate": "2026-11-29T05:00:00.000Z", "isAllDayEvent": true }
            ] });
            let (calls, bridge) = fake(reply);
            let out = upcoming_with(&json!({ "period": "week", "query": "fit" }), today, &bridge).await.unwrap();
            assert_eq!(out, "2 event(s) for the next 7 days matching \"fit\":\n1. Fri Nov 27, 10:00 AM – 11:00 AM · Fitting · Wardrobe, Stage 4\n2. Sun Nov 29 · all day · Hold: Bell spot");
            let c = calls.lock().unwrap().clone();
            assert_eq!(c[0], ("get_events".to_string(), json!({ "startDate": "2026-11-26T00:00:00-05:00", "endDate": "2026-12-04T00:00:00-05:00", "limit": 25, "query": "fit" })));
            let (calls, bridge) = fake(json!({ "eventCount": 0, "events": [] }));
            assert_eq!(day_with(&json!({ "date": "tomorrow" }), today, &bridge).await.unwrap(), "No events on the calendar for Friday, November 27.");
            assert_eq!(calls.lock().unwrap()[0], ("get_events_for_day".to_string(), json!({ "date": "2026-11-27" })));
            assert!(upcoming_with(&json!({ "period": "fortnight" }), today, &bridge).await.is_err());
            assert!(day_with(&json!({ "date": "next tuesday" }), today, &bridge).await.is_err());
        });
    }

    #[test]
    fn allm_config_parsed_without_leaking() {
        let (id, key) = parse_allm_config(r#"{"deploymentId":" AKfycbx1234567890 ","apiKey":"k123"}"#).unwrap();
        assert_eq!((id.as_str(), key.as_str()), ("AKfycbx1234567890", "k123"));
        for bad in ["", "{}", r#"{"deploymentId":"AKfycbx1234567890","apiKey":"****"}"#] {
            assert!(parse_allm_config(bad).is_err(), "{bad}");
        }
        let e = parse_allm_config(r#"{"deploymentId":"bad id!","apiKey":"secret-key"}"#).unwrap_err();
        assert!(!e.contains("secret-key") && !e.contains("bad id"));
    }

    /// An OsState with Calendar and Gmail switched on, then `f` applied.
    fn gate_env(f: impl FnOnce(&mut os_core::OsConfig)) -> OsState {
        let os = OsState::default();
        os.update(|c| {
            for m in c.mcps.iter_mut().filter(|m| m.id == "calendar" || m.id == "gmail") {
                m.enabled = true;
            }
            c.privacy.kill_switch = false;
            f(c);
            Ok(())
        })
        .unwrap();
        os
    }

    /// Review note (A2): the one approved write path refuses at every gate before any credential
    /// lookup or Apps Script call, and its log line names no content.
    #[test]
    fn the_approved_add_refuses_at_every_gate_before_any_call() {
        tauri::async_runtime::block_on(async {
            let state = DispatchState::default();
            let bridge = BridgeState::default();
            let args = json!({ "title": "zqx secret shoot", "startTime": "2030-01-02T09:00", "location": "Stage 9" });
            let before = ensure_calls();
            let run = |os: OsState, approved: bool| {
                let (state, bridge, args) = (&state, &bridge, &args);
                async move { create_event_approved(state, &os, bridge, args, approved, "card").await }
            };
            assert_eq!(run(gate_env(|_| {}), false).await.unwrap_err(), PERMISSION, "not approved");
            let e = run(gate_env(|c| c.permissions.mcp = super::super::bridge::Tier::Deny), true).await.unwrap_err();
            assert!(e.starts_with("PERMISSION_DENIED:mcp"), "{e}");
            let off = gate_env(|c| c.mcps.iter_mut().filter(|m| m.id == "calendar").for_each(|m| m.enabled = false));
            assert!(run(off, true).await.unwrap_err().contains("Google Calendar is switched off"));
            let master = gate_env(|c| c.switchboard.frozen_tools = vec!["calendar".into()]);
            assert_eq!(run(master, true).await.unwrap_err(), "MODE_FROZEN: calendar is frozen on the master switchboard");
            let learning = gate_env(|_| {});
            learning.modes.set_active(super::super::modes::LEARNING_ID).unwrap();
            assert_eq!(run(learning, true).await.unwrap_err(), "MODE_FROZEN: calendar is frozen in Learning mode");
            // The master kill switch: refused by the tool itself, still before any call.
            let e = run(gate_env(|c| c.privacy.kill_switch = true), true).await.unwrap_err();
            assert!(e.starts_with("kill switch is on"), "{e}");
            assert_eq!(ensure_calls(), before, "no gate reached the credentials or the bridge");
            // The kill-switch refusal is logged (tool, ok, via) without the event's text.
            let dir = std::env::temp_dir().join(format!("gcal-gate-{}-{}", std::process::id(), super::super::compaction::now_ms()));
            std::fs::create_dir_all(&dir).unwrap();
            let logged = BridgeState::default();
            logged.init(&dir, dir.join("logs"));
            let os = gate_env(|c| c.privacy.kill_switch = true);
            assert!(create_event_approved(&state, &os, &logged, &args, true, "phone").await.is_err());
            let log: String = std::fs::read_dir(dir.join("logs")).unwrap().filter_map(|e| std::fs::read_to_string(e.ok()?.path()).ok()).collect();
            assert!(log.contains("\"os-tool\"") && log.contains("\"via\":\"phone\"") && log.contains("\"ok\":false"), "{log}");
            assert!(!log.contains("zqx") && !log.contains("Stage 9"), "{log}");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn a_tool_listing_never_imports_the_calendar_credentials() {
        let state = DispatchState::default();
        let before = ensure_calls();
        // What every turn's tool listing and the Settings registry ask: a plain check.
        let _ = has_creds(&state);
        let _ = super::super::mcp::unavailable_reason(&state, &os_core::OsConfig::default(), "calendar");
        assert_eq!(ensure_calls(), before, "a listing must not reach ensure_creds (the import)");
        // The throttle: one import per window, then none until it passes.
        let t0 = 5_000_000_000_000;
        LAST_AUTO_IMPORT.store(0, Ordering::Relaxed);
        assert!(claim_auto_import(t0));
        assert!(!claim_auto_import(t0 + 1_000));
        assert!(claim_auto_import(t0 + AUTO_IMPORT_EVERY_MS));
        LAST_AUTO_IMPORT.store(0, Ordering::Relaxed);
    }

    // ── Structured read (Maps step 5) ──

    /// The known Apps Script `get_events` shape (no id, no description) plus the fields an
    /// unverified deployment may add.
    fn events_fixture() -> Value {
        json!({ "totalEvents": 5, "events": [
            { "title": "Hold: Bell spot", "startDate": "2026-11-29T05:00:00.000Z", "endDate": "2026-11-30T05:00:00.000Z", "isAllDayEvent": true },
            { "title": "Fitting", "startTime": "2026-11-27T15:00:00.000Z", "endTime": "2026-11-27T16:00:00.000Z", "isAllDayEvent": false, "location": "Wardrobe, Stage 4" },
            { "id": "abc123@google.com", "title": "Audition\u{7} – Netflix\nday player", "startTime": "2026-11-28T09:30:00-05:00", "endTime": "2026-11-28T10:00:00-05:00",
              "location": "  100 Queen St W,\nToronto  ", "description": "Sides attached.\nBring headshot.\u{0}" },
            { "title": "no start at all", "location": "Nowhere" },
            { "title": "bad start", "startTime": "next tuesday" }
        ] })
    }

    #[test]
    fn cal_events_of_parses_the_reply_defensively() {
        let ev = cal_events_of(&events_fixture());
        assert_eq!(ev.len(), 3, "entries without a usable start are skipped: {ev:?}");
        // Sorted by start, Toronto offsets.
        assert_eq!(
            ev[0],
            CalEvent {
                id: None,
                title: "Fitting".into(),
                start: "2026-11-27T10:00:00-05:00".into(),
                start_ms: 1_795_791_600_000,
                end: Some("2026-11-27T11:00:00-05:00".into()),
                end_ms: Some(1_795_795_200_000),
                all_day: false,
                location: Some("Wardrobe, Stage 4".into()),
                description: None,
            }
        );
        let a = &ev[1];
        assert_eq!(a.id.as_deref(), Some("abc123@google.com"));
        assert_eq!(a.title, "Audition  – Netflix day player", "control characters and newlines out");
        assert_eq!((a.start.as_str(), a.end.as_deref()), ("2026-11-28T09:30:00-05:00", Some("2026-11-28T10:00:00-05:00")));
        assert_eq!(a.location.as_deref(), Some("100 Queen St W, Toronto"));
        assert_eq!(a.description.as_deref(), Some("Sides attached.\nBring headshot."), "description keeps its line breaks");
        let h = &ev[2];
        assert!(h.all_day && h.location.is_none() && h.description.is_none());
        assert_eq!((h.start.as_str(), h.end.as_deref()), ("2026-11-29T00:00:00-05:00", Some("2026-11-30T00:00:00-05:00")));
        // Camel-case JSON for the webview / snapshot, and it round-trips.
        let v = serde_json::to_value(&ev[1]).unwrap();
        assert!(v["startMs"].is_i64() && v["allDay"] == false && v.get("start_ms").is_none(), "{v}");
        assert_eq!(serde_json::from_value::<CalEvent>(v).unwrap(), ev[1]);
    }

    #[test]
    fn cal_events_of_accepts_other_shapes_and_caps() {
        // A bare list; summary; Google's {dateTime | date}; a wall-clock time; epoch ms; a bare date;
        // a numeric id; an empty title and location; an end before the start dropped.
        let ev = cal_events_of(&json!([
            { "summary": "Job: kitchen reno walkthrough", "start": { "dateTime": "2026-12-01T14:00:00-05:00" }, "end": { "dateTime": "2026-12-01T15:00:00-05:00" }, "id": 42 },
            { "title": "All day via date", "start": { "date": "2026-12-02" } },
            { "title": "Wall clock", "startTime": "2026-12-03T08:15", "endTime": "2026-12-03T07:00", "location": "   " },
            { "title": "", "startTime": 1_796_000_000_000_i64 },
            { "title": "seconds are refused", "startTime": 1_796_000_000_i64 },
            "not an object",
            null
        ]));
        assert_eq!(ev.len(), 4, "{ev:?}");
        assert_eq!(ev[0].title, "(untitled)");
        assert_eq!(ev[0].start_ms, 1_796_000_000_000);
        assert_eq!((ev[1].id.as_deref(), ev[1].title.as_str(), ev[1].start.as_str()), (Some("42"), "Job: kitchen reno walkthrough", "2026-12-01T14:00:00-05:00"));
        assert!(ev[2].all_day && ev[2].start == "2026-12-02T00:00:00-05:00" && ev[2].end.is_none());
        assert_eq!(ev[3].start, "2026-12-03T08:15:00-05:00");
        assert!(ev[3].end.is_none() && ev[3].location.is_none(), "an end before the start and a blank location are dropped");
        // Nothing usable: empty, never an error.
        for junk in [json!(null), json!({}), json!({ "events": "x" }), json!("text"), json!({ "events": [] })] {
            assert!(cal_events_of(&junk).is_empty(), "{junk}");
        }
        // Capped at MAX_EVENTS, the earliest kept; long fields capped.
        let many: Vec<Value> = (0..40).rev().map(|i| json!({ "title": "x".repeat(500), "startTime": format!("2026-12-{:02}T09:00", 1 + i % 28), "description": "d".repeat(5000), "location": "l".repeat(900), "id": "i".repeat(900) })).collect();
        let ev = cal_events_of(&json!({ "events": many }));
        assert_eq!(ev.len(), MAX_EVENTS);
        assert!(ev.windows(2).all(|w| w[0].start_ms <= w[1].start_ms));
        assert_eq!(ev[0].start, "2026-12-01T09:00:00-05:00");
        let e = &ev[0];
        assert_eq!((e.title.len(), e.location.as_ref().unwrap().len(), e.description.as_ref().unwrap().len(), e.id.as_ref().unwrap().len()), (TITLE_MAX, LOCATION_MAX, DESCRIPTION_MAX, ID_MAX));
    }

    #[test]
    fn utc_instants_read_in_toronto_through_both_dst_changes() {
        let u = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
        // Spring 2026-03-08: 07:00Z is 03:00 EDT; 06:59Z is still 01:59 EST.
        assert_eq!(toronto_rfc3339_of_utc(u("2026-03-08 06:59")), "2026-03-08T01:59:00-05:00");
        assert_eq!(toronto_rfc3339_of_utc(u("2026-03-08 07:00")), "2026-03-08T03:00:00-04:00");
        // Fall 2026-11-01: 05:59Z is 01:59 EDT; 06:00Z is the repeated 01:00, now EST.
        assert_eq!(toronto_rfc3339_of_utc(u("2026-11-01 05:59")), "2026-11-01T01:59:00-04:00");
        assert_eq!(toronto_rfc3339_of_utc(u("2026-11-01 06:00")), "2026-11-01T01:00:00-05:00");
        assert_eq!(toronto_rfc3339_of_utc(u("2026-07-01 16:00")), "2026-07-01T12:00:00-04:00");
        // A summer wall-clock reply time reads as EDT.
        let ev = cal_events_of(&json!([{ "title": "Shoot", "startTime": "2026-07-02T06:00" }]));
        assert_eq!(ev[0].start, "2026-07-02T06:00:00-04:00");
    }

    #[test]
    fn a_missing_id_gets_a_stable_hash_key() {
        let ev = cal_events_of(&events_fixture());
        assert_eq!(ev[1].key(), "abc123@google.com");
        let k = ev[0].key();
        assert!(k.starts_with("h:") && k.len() == 18, "{k}");
        assert_eq!(k, cal_events_of(&events_fixture())[0].key(), "the same event keys the same on every read");
        let mut moved = ev[0].clone();
        moved.start_ms += 60_000;
        assert_ne!(moved.key(), k);
    }

    #[test]
    fn fetch_sends_a_toronto_window_and_refuses_bad_windows() {
        tauri::async_runtime::block_on(async {
            let os = gate_env(|_| {});
            let bridge = BridgeState::default();
            let (calls, fake_bridge) = fake(events_fixture());
            let ev = fetch_events_with(&os, &bridge, d("2026-11-26"), d("2026-11-28"), &fake_bridge).await.unwrap();
            assert_eq!(ev.len(), 3);
            assert_eq!(calls.lock().unwrap()[0], ("get_events".to_string(), json!({ "startDate": "2026-11-26T00:00:00-05:00", "endDate": "2026-11-28T00:00:00-05:00", "limit": MAX_EVENTS })));
            // A summer window carries EDT.
            assert_eq!(events_body(d("2026-07-01"), d("2026-07-02")).unwrap()["startDate"], "2026-07-01T00:00:00-04:00");
            for (from, to) in [("2026-11-26", "2026-11-26"), ("2026-11-28", "2026-11-26"), ("2026-11-26", "2026-12-28")] {
                assert!(fetch_events_with(&os, &bridge, d(from), d(to), &fake_bridge).await.is_err(), "{from}..{to}");
            }
            assert_eq!(calls.lock().unwrap().len(), 1, "a bad window never reaches the bridge");
            // A bridge error passes through.
            let failing = |_: &'static str, _: Value| std::future::ready(Err::<Value, String>("Calendar Apps Script error: Invalid API key".into()));
            assert_eq!(fetch_events_with(&os, &bridge, d("2026-11-26"), d("2026-11-27"), failing).await.unwrap_err(), "Calendar Apps Script error: Invalid API key");
        });
    }

    /// The plan's decision: the structured read honours the MCP permission tier, like the tool.
    /// Every gate refuses before any credential lookup or Apps Script call, and no event text or
    /// window is logged.
    #[test]
    fn the_structured_read_refuses_at_every_gate_before_any_call() {
        use super::super::bridge::Tier;
        tauri::async_runtime::block_on(async {
            let bridge = BridgeState::default();
            let (calls, fake_bridge) = fake(events_fixture());
            let read = |os: OsState| {
                let (bridge, fake_bridge) = (&bridge, &fake_bridge);
                async move { fetch_events_with(&os, bridge, d("2026-11-26"), d("2026-11-28"), fake_bridge).await }
            };
            let killed = read(gate_env(|c| c.privacy.kill_switch = true)).await.unwrap_err();
            assert_eq!(read_state(&killed), "blocked", "{killed}");
            let denied = read(gate_env(|c| c.permissions.mcp = Tier::Deny)).await.unwrap_err();
            assert!(denied.starts_with("PERMISSION_DENIED:mcp") && read_state(&denied) == "blocked", "{denied}");
            let ask = read(gate_env(|c| c.permissions.mcp = Tier::Ask)).await.unwrap_err();
            assert!(ask.starts_with("PERMISSION_REQUIRED:mcp") && read_state(&ask) == "blocked", "an unapproved background read under Ask: {ask}");
            let off = read(gate_env(|c| c.mcps.iter_mut().filter(|m| m.id == "calendar").for_each(|m| m.enabled = false))).await.unwrap_err();
            assert_eq!(read_state(&off), "off", "{off}");
            let master = read(gate_env(|c| c.switchboard.frozen_tools = vec!["calendar".into()])).await.unwrap_err();
            assert_eq!((master.as_str(), read_state(&master)), ("MODE_FROZEN: calendar is frozen on the master switchboard", "frozen"));
            let learning = gate_env(|_| {});
            learning.modes.set_active(super::super::modes::LEARNING_ID).unwrap();
            assert_eq!(read_state(&read(learning).await.unwrap_err()), "frozen");
            assert!(calls.lock().unwrap().is_empty(), "no gate reached the bridge");
            assert_eq!(read_state(NO_BACKEND), "no-backend");
            assert_eq!(read_state("Calendar Apps Script error: Invalid API key"), "error");

            // The real path: refused before `ensure_creds` (no import, no keychain, no network).
            let state = DispatchState::default();
            let before = ensure_calls();
            for os in [gate_env(|c| c.privacy.kill_switch = true), gate_env(|c| c.permissions.mcp = Tier::Deny), gate_env(|c| c.mcps.iter_mut().for_each(|m| m.enabled = false))] {
                assert!(fetch_events(&state, &os, &bridge, d("2026-11-26"), d("2026-11-28")).await.is_err());
            }
            assert_eq!(ensure_calls(), before, "no gate reached the credentials");

            // The permission log line names the read, never a window or event text.
            let dir = std::env::temp_dir().join(format!("gcal-read-{}-{}", std::process::id(), super::super::compaction::now_ms()));
            std::fs::create_dir_all(&dir).unwrap();
            let logged = BridgeState::default();
            logged.init(&dir, dir.join("logs"));
            let os = gate_env(|c| c.permissions.mcp = Tier::Ask);
            assert!(fetch_events_with(&os, &logged, d("2026-11-26"), d("2026-11-28"), &fake_bridge).await.is_err());
            let log: String = std::fs::read_dir(dir.join("logs")).unwrap().filter_map(|e| std::fs::read_to_string(e.ok()?.path()).ok()).collect();
            assert!(log.contains("\"permission\"") && log.contains(EVENTS), "{log}");
            assert!(!log.contains("startDate") && !log.contains("11-28T") && !log.contains("Fitting"), "{log}");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn script_errors_say_calendar() {
        assert!(super::super::gmail::script_reply("Calendar", 404, "").unwrap_err().starts_with("Calendar Apps Script deployment not found"));
        assert_eq!(super::super::gmail::script_reply("Calendar", 200, r#"{"status":"error","error":"Invalid API key"}"#).unwrap_err(), "Calendar Apps Script error: Invalid API key");
    }
}
