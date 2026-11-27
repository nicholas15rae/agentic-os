//! Agent event bus: one typed `agent-event` stream for the webview (narration, System Map
//! lanes, status) and a best-effort mirror to the gateway's phone HUD progress.
//!
//! - Task events are derived ONLY from committed `handoff_log` rows (`publish_entry`, called by
//!   `envelope::TaskStore` after the transaction commits): one write path, no drift.
//! - Non-task events (`publish_note`) are bus-only.
//! - `short_summary` is templated (or the agent's validated `voice_summary`), scrubbed with
//!   `devqueue::scrub`, capped, and stripped of wake words and the OS name so a spoken
//!   narration line can never wake Tony.
//! - `publish` never blocks: a bounded queue (256) that evicts the lowest-severity (verbose
//!   first) event when full. A single consumer emits to the webview (no-op until `install`).
#![cfg_attr(not(test), allow(dead_code))] // non-task publishers arrive with the worker (Part 5)

use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use super::envelope::{clip, one_line, Envelope, HandoffEntry, SEVERITIES};

pub const EVENT_NAME: &str = "agent-event";
pub const BUS_CAP: usize = 256;
/// Templated summaries.
pub const SUMMARY_MAX: usize = 120;
/// A summary that is the agent's own validated `voice_summary` (tf-decisions: ~240 chars).
pub const VOICE_SUMMARY_MAX: usize = 240;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub v: u8,
    pub seq: u64,
    /// Unix milliseconds.
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    pub agent_id: String,
    pub event_type: String,
    pub severity: String,
    pub short_summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iteration: Option<u32>,
    /// Task events: the envelope's status / owner after the commit (phone HUD).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// True when `short_summary` is the agent's own voice summary (speak it in its voice).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub from_voice_summary: bool,
    /// Task events: who the committed row was addressed to (`handoff_log.to_agent`) — the
    /// envelope `owner` after the commit is often someone else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_agent: Option<String>,
    /// Task events: the durable `handoff_log.seq` of the row (dedupe / backfill key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_seq: Option<i64>,
    /// Task events whose `short_summary` is a voice summary: the app's templated summary too
    /// (counts, sizes, who it went to), so the chat never loses the facts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_summary: Option<String>,
}

// ── Summary hygiene ─────────────────────────────────────────────────────────

/// Words a narration line must never contain (wake words, the OS name).
#[derive(Clone, Debug)]
pub struct SummaryFilter {
    phrases: Vec<String>,
}

impl SummaryFilter {
    pub fn new(os_name: &str, wake_words: &[String]) -> Self {
        let mut phrases: Vec<String> = wake_words.iter().map(|w| one_line(w).to_lowercase()).chain(std::iter::once(one_line(os_name).to_lowercase())).filter(|w| w.chars().any(char::is_alphanumeric)).collect();
        phrases.sort_by_key(|p| std::cmp::Reverse(p.len()));
        phrases.dedup();
        Self { phrases }
    }

    /// Remove every phrase (whole words, case-insensitive) and tidy the leftovers.
    pub fn strip(&self, text: &str) -> String {
        let mut out = text.to_string();
        for p in &self.phrases {
            let words: Vec<String> = p.split_whitespace().map(regex::escape).collect();
            let re = regex::Regex::new(&format!(r"(?i)\b{}\b(?:'s)?[,:]?", words.join(r"\s+"))).expect("escaped phrase");
            out = re.replace_all(&out, "").into_owned();
        }
        let out = one_line(&out);
        out.trim_start_matches([',', ':', ';', '-', '—', ' ']).trim().to_string()
    }
}

impl Default for SummaryFilter {
    fn default() -> Self {
        let d = super::os_core::OsConfig::default();
        Self::new(&d.os_name, &d.wake_words)
    }
}

fn filter() -> &'static RwLock<SummaryFilter> {
    static F: OnceLock<RwLock<SummaryFilter>> = OnceLock::new();
    F.get_or_init(|| RwLock::new(SummaryFilter::default()))
}

/// Refresh the wake-word / OS-name filter (startup, and the consumer per batch).
pub fn set_filter(os_name: &str, wake_words: &[String]) {
    *filter().write().unwrap() = SummaryFilter::new(os_name, wake_words);
}

/// Scrub, strip wake words / OS name, one line, cap. Never empty (falls back to `fallback`).
pub fn clean_summary(text: &str, cap: usize, f: &SummaryFilter, fallback: &str) -> String {
    let s = f.strip(&one_line(&super::devqueue::scrub(text, &[])));
    let s = if s.chars().any(char::is_alphanumeric) { s } else { fallback.to_string() };
    clip(&s, cap)
}

// ── Construction ────────────────────────────────────────────────────────────

fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// The event a committed handoff row stands for. The voice summary wins when present.
pub fn from_entry(h: &HandoffEntry, env: &Envelope, f: &SummaryFilter) -> AgentEvent {
    let fallback = h.event_type.replace('_', " ");
    let (text, cap, voiced) = match &h.voice_summary {
        Some(v) => (v.as_str(), VOICE_SUMMARY_MAX, true),
        None => (h.short_summary.as_str(), SUMMARY_MAX, false),
    };
    AgentEvent {
        v: 1,
        seq: next_seq(),
        at: h.timestamp,
        task_id: Some(h.task_id.clone()),
        trace_id: Some(format!("task:{}", h.task_id)),
        agent_id: h.from_agent.clone(),
        event_type: h.event_type.clone(),
        severity: h.severity.clone(),
        short_summary: clean_summary(text, cap, f, &fallback),
        stage: h.stage.clone(),
        iteration: h.iteration,
        status: Some(env.status.clone()),
        owner: Some(env.current_owner.clone()),
        from_voice_summary: voiced,
        to_agent: Some(h.to_agent.clone()),
        row_seq: Some(h.seq),
        template_summary: voiced.then(|| clean_summary(&h.short_summary, SUMMARY_MAX, f, &fallback)),
    }
}

/// A bus-only event (no task). `summary` must be a template, never model or user text.
pub fn note(agent_id: &str, event_type: &str, severity: &str, summary: &str, trace_id: Option<&str>, f: &SummaryFilter) -> AgentEvent {
    let severity = if SEVERITIES.contains(&severity) { severity } else { "verbose" };
    AgentEvent {
        v: 1,
        seq: next_seq(),
        at: super::envelope::now_ms(),
        task_id: None,
        trace_id: trace_id.map(str::to_string),
        agent_id: clip(&one_line(agent_id), 32),
        event_type: clip(&one_line(event_type), 40),
        severity: severity.into(),
        short_summary: clean_summary(summary, SUMMARY_MAX, f, &event_type.replace('_', " ")),
        stage: None,
        iteration: None,
        status: None,
        owner: None,
        from_voice_summary: false,
        to_agent: None,
        row_seq: None,
        template_summary: None,
    }
}

/// A bus-only template note that belongs to a task (`taskId` set, so the chat attributes it).
pub fn task_note(task_id: &str, agent_id: &str, event_type: &str, severity: &str, summary: &str, f: &SummaryFilter) -> AgentEvent {
    let mut ev = note(agent_id, event_type, severity, summary, Some(&format!("task:{task_id}")), f);
    ev.task_id = Some(clip(&one_line(task_id), 64));
    ev
}

/// Does an event of `severity` get spoken at feedback `level` (0 silent … 3 verbose)?
/// Level 0 is toast-only, even for critical events.
pub fn narrates(severity: &str, level: u8) -> bool {
    match severity {
        "critical" | "milestone" => level >= 1,
        "handoff" => level >= 2,
        "verbose" => level >= 3,
        _ => false,
    }
}

fn rank(severity: &str) -> u8 {
    match severity {
        "critical" => 3,
        "milestone" => 2,
        "handoff" => 1,
        _ => 0,
    }
}

// ── The bounded, never-blocking queue ───────────────────────────────────────

pub struct Bus {
    cap: usize,
    q: Mutex<VecDeque<AgentEvent>>,
    notify: tokio::sync::Notify,
    dropped: AtomicU64,
}

impl Bus {
    pub fn new(cap: usize) -> Self {
        Self { cap: cap.max(1), q: Mutex::new(VecDeque::with_capacity(cap.max(1))), notify: tokio::sync::Notify::new(), dropped: AtomicU64::new(0) }
    }

    /// Enqueue without blocking. When full, the oldest event of the lowest severity below
    /// this one's is evicted (verbose first); if none ranks lower, this event is dropped.
    /// Returns whether `ev` was queued.
    pub fn push(&self, ev: AgentEvent) -> bool {
        let mut q = self.q.lock().unwrap_or_else(|p| p.into_inner());
        if q.len() >= self.cap {
            let r = rank(&ev.severity);
            let victim = (0..r).find_map(|lvl| q.iter().position(|e| rank(&e.severity) == lvl));
            match victim {
                Some(i) => {
                    q.remove(i);
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
                None => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
            }
        }
        q.push_back(ev);
        drop(q);
        self.notify.notify_one();
        true
    }

    pub fn drain(&self) -> Vec<AgentEvent> {
        self.q.lock().unwrap_or_else(|p| p.into_inner()).drain(..).collect()
    }

    pub fn len(&self) -> usize {
        self.q.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// The last `REPLAY_CAP` non-verbose events, for a webview that was not listening yet (app
/// startup, a webview reload): `agent_events_replay` hands them back so nothing emitted before
/// the listener existed is lost (the webview dedupes by `seq` within this process `boot`).
pub const REPLAY_CAP: usize = 64;

pub struct Replay {
    cap: usize,
    q: Mutex<VecDeque<AgentEvent>>,
}

impl Replay {
    pub fn new(cap: usize) -> Self {
        Self { cap: cap.max(1), q: Mutex::new(VecDeque::new()) }
    }
    pub fn record(&self, ev: &AgentEvent) {
        let mut q = self.q.lock().unwrap_or_else(|p| p.into_inner());
        if q.len() >= self.cap {
            q.pop_front();
        }
        q.push_back(ev.clone());
    }
    /// Events with `seq > after`, oldest first.
    pub fn since(&self, after: u64) -> Vec<AgentEvent> {
        self.q.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|e| e.seq > after).cloned().collect()
    }
}

fn replay() -> &'static Replay {
    static R: OnceLock<Replay> = OnceLock::new();
    R.get_or_init(|| Replay::new(REPLAY_CAP))
}

/// This process's boot stamp (the webview keys its replay dedupe on it: `seq` restarts per boot).
pub fn boot_id() -> i64 {
    static B: OnceLock<i64> = OnceLock::new();
    *B.get_or_init(super::envelope::now_ms)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayView {
    pub boot: i64,
    pub events: Vec<AgentEvent>,
}

/// Recent agent events the webview may have missed (emitted before its listener existed).
#[tauri::command]
pub fn agent_events_replay(after_seq: Option<u64>) -> ReplayView {
    ReplayView { boot: boot_id(), events: replay().since(after_seq.unwrap_or(0)) }
}

fn bus() -> &'static Bus {
    static B: OnceLock<Bus> = OnceLock::new();
    B.get_or_init(|| Bus::new(BUS_CAP))
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Queue an event for the webview / gateway. Never blocks.
pub fn publish(ev: AgentEvent) -> bool {
    let _ = boot_id();
    if ev.severity != "verbose" {
        replay().record(&ev);
    }
    bus().push(ev)
}

/// `publish_note` with a longer summary cap (hub outcomes carrying a check name or Nic's own
/// steer text). Still scrubbed and wake-word safe.
pub fn publish_note_capped(agent_id: &str, event_type: &str, severity: &str, summary: &str, trace_id: Option<&str>, cap: usize) -> bool {
    let f = filter().read().unwrap().clone();
    let mut ev = note(agent_id, event_type, severity, summary, trace_id, &f);
    ev.short_summary = clean_summary(summary, cap.min(600), &f, &event_type.replace('_', " "));
    publish(ev)
}

/// Publish the event for a committed handoff row.
pub fn publish_entry(h: &HandoffEntry, env: &Envelope) -> bool {
    let f = filter().read().unwrap().clone();
    publish(from_entry(h, env, &f))
}

/// Publish a bus-only (non-task) event from a template.
pub fn publish_note(agent_id: &str, event_type: &str, severity: &str, summary: &str, trace_id: Option<&str>) -> bool {
    let f = filter().read().unwrap().clone();
    publish(note(agent_id, event_type, severity, summary, trace_id, &f))
}

/// Emit any other Rust → webview event through the installed app handle (no-op before
/// `install`, e.g. in unit tests). For payloads that are already scrubbed and capped.
pub fn emit_raw<T: Serialize + Clone>(name: &str, payload: &T) {
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit(name, payload.clone());
    }
}

/// Called once from `lib.rs` setup: start the consumer (webview emit + gateway mirror).
pub fn install(app: &tauri::AppHandle) {
    if APP.set(app.clone()).is_ok() {
        tauri::async_runtime::spawn(consume(app.clone()));
    }
}

async fn consume(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let b = bus();
    loop {
        b.notify.notified().await;
        let batch = b.drain();
        if batch.is_empty() {
            continue;
        }
        let os = app.state::<super::os_core::OsState>().snapshot();
        set_filter(&os.os_name, &os.wake_words);
        for ev in batch {
            let _ = app.emit(EVENT_NAME, &ev);
            note_roster(&ev);
            if ev.task_id.is_some() {
                tauri::async_runtime::spawn(mirror(app.clone(), ev));
            }
        }
    }
}

/// The compute arbiter and the Build Circle's shared memory see every task event: an addressed
/// row is a hand-off on the map; a build agent's milestone / hand-off row lands in the shared
/// `build_circle` namespace (tagged by task), and a finished task's entries graduate later.
fn note_roster(ev: &AgentEvent) {
    if let Some(to) = ev.to_agent.as_deref() {
        super::arbiter::get().handoff(&ev.agent_id, to, &ev.short_summary);
    }
    let Some(task) = ev.task_id.as_deref() else { return };
    let tag = format!("task:{task}");
    let build_agent = matches!(ev.agent_id.as_str(), "prompter" | "coder" | "designer" | "librarian");
    if build_agent && matches!(ev.severity.as_str(), "milestone" | "handoff") {
        let stage = ev.stage.as_deref().unwrap_or("-");
        super::memtier::put(&ev.agent_id, "build_circle", &format!("[{task} · {stage}] {}: {}", ev.agent_id, ev.short_summary), &[&tag]);
    }
    if matches!(ev.status.as_deref(), Some("review_ready" | "failed" | "cancelled")) {
        super::memtier::mark_done("build_circle", &tag);
    }
}

/// Phone HUD progress for a task event (loopback gateway, short timeout, best-effort).
async fn mirror(app: tauri::AppHandle, ev: AgentEvent) {
    use tauri::Manager;
    let st = app.state::<super::dispatch::DispatchState>();
    let os = app.state::<super::os_core::OsState>().snapshot();
    let base = st.snapshot().gateway.url;
    let body = json!({
        "taskId": ev.task_id, "status": ev.status, "owner": ev.owner, "stage": ev.stage, "iteration": ev.iteration,
        "label": ev.short_summary, "severity": ev.severity, "eventType": ev.event_type, "agentId": ev.agent_id, "seq": ev.seq,
    });
    let mut rb = st.http.post(format!("{}/api/pipeline/progress", base.trim_end_matches('/'))).timeout(Duration::from_secs(3)).json(&body);
    if let Some(t) = super::os_core::mesh_bearer(&os) {
        rb = rb.bearer_auth(t);
    }
    let _ = rb.send().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn ev(sev: &str) -> AgentEvent {
        note("coder", "progress", sev, "working", None, &SummaryFilter::default())
    }

    fn entry(voice: Option<&str>, short: &str) -> (HandoffEntry, Envelope) {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        super::super::envelope::migrate(&mut c).unwrap();
        let (env, _, h) = super::super::envelope::create(&mut c, &super::super::envelope::NewEnvelope { raw_intent: "build a card".into(), source: "voice".into(), ..Default::default() }, &[]).unwrap();
        let mut h = h.unwrap();
        h.voice_summary = voice.map(str::to_string);
        h.short_summary = short.into();
        (h, env)
    }

    #[test]
    fn camel_case_shape() {
        let (h, env) = entry(None, "Queued: build a card");
        let v: Value = serde_json::to_value(from_entry(&h, &env, &SummaryFilter::default())).unwrap();
        for k in ["v", "seq", "at", "taskId", "traceId", "agentId", "eventType", "severity", "shortSummary", "status", "owner"] {
            assert!(v.get(k).is_some(), "missing {k}: {v}");
        }
        assert_eq!(v["v"], 1);
        assert_eq!(v["traceId"], format!("task:{}", env.task_id));
        assert_eq!((v["eventType"].as_str(), v["severity"].as_str(), v["agentId"].as_str()), (Some("task_queued"), Some("milestone"), Some("tony")));
        assert!(v.get("fromVoiceSummary").is_none());
        let n: Value = serde_json::to_value(ev("verbose")).unwrap();
        assert!(n.get("taskId").is_none() && n.get("stage").is_none());
    }

    #[test]
    fn summary_is_scrubbed_capped_and_wake_safe() {
        let f = SummaryFilter::new("Tony", &["hey tony".into(), "yo tony".into(), "tony".into()]);
        let s = clean_summary("Hey Tony, coder used sk-abcdefghijklmnopqrstu and Bearer abcdefghij to deploy", SUMMARY_MAX, &f, "x");
        assert!(!s.contains("sk-abc") && !s.contains("abcdefghij"), "{s}");
        assert!(!s.to_lowercase().contains("tony"), "{s}");
        assert!(s.starts_with("coder used"), "{s}");
        let long = clean_summary(&"word ".repeat(100), SUMMARY_MAX, &f, "x");
        assert!(long.chars().count() <= SUMMARY_MAX);
        assert_eq!(clean_summary("Tony's", SUMMARY_MAX, &f, "handoff"), "handoff");
        // Voice summaries get the longer cap and win over the template.
        let (h, env) = entry(Some(&"The spec is ready and Tony will hear more. ".repeat(10)), "Spec ready");
        let e = from_entry(&h, &env, &f);
        assert!(e.from_voice_summary && e.short_summary.chars().count() <= VOICE_SUMMARY_MAX && e.short_summary.chars().count() > SUMMARY_MAX);
        assert!(!e.short_summary.to_lowercase().contains("tony"));
        let (h, env) = entry(None, "Spec ready");
        assert_eq!(from_entry(&h, &env, &f).short_summary, "Spec ready");
    }

    #[test]
    fn narrates_truth_table() {
        let want = [
            ("critical", [false, true, true, true]),
            ("milestone", [false, true, true, true]),
            ("handoff", [false, false, true, true]),
            ("verbose", [false, false, false, true]),
        ];
        for (sev, row) in want {
            for (lvl, w) in row.iter().enumerate() {
                assert_eq!(narrates(sev, lvl as u8), *w, "{sev} @ {lvl}");
            }
        }
        assert!(!narrates("loud", 3));
    }

    #[test]
    fn full_bus_drops_verbose_keeps_milestones_and_never_blocks() {
        let b = Bus::new(4);
        for _ in 0..3 {
            assert!(b.push(ev("verbose")));
        }
        assert!(b.push(ev("milestone")));
        // Full: a verbose newcomer is dropped…
        assert!(!b.push(ev("verbose")));
        // …a milestone evicts the oldest verbose.
        assert!(b.push(ev("milestone")));
        assert!(b.push(ev("critical")));
        assert!(b.push(ev("handoff")));
        assert_eq!(b.len(), 4);
        let sevs: Vec<String> = b.drain().into_iter().map(|e| e.severity).collect();
        assert_eq!(sevs, ["milestone", "milestone", "critical", "handoff"]);
        assert_eq!(b.dropped(), 4);
        // A queue full of criticals refuses a milestone but never loses a critical.
        let b = Bus::new(2);
        b.push(ev("critical"));
        b.push(ev("critical"));
        assert!(!b.push(ev("milestone")));
        assert!(b.drain().iter().all(|e| e.severity == "critical"));
        // Never blocks: 2000 pushes into a full bus average well under 1 ms each
        // (an average, so one preempted push on a loaded test machine can't flake it).
        let b = Bus::new(BUS_CAP);
        let evs: Vec<AgentEvent> = (0..2000).map(|i| ev(if i % 2 == 0 { "verbose" } else { "milestone" })).collect();
        let t = std::time::Instant::now();
        for e in evs {
            b.push(e);
        }
        let avg = t.elapsed() / 2000;
        assert!(avg < Duration::from_millis(1), "publish averaged {avg:?}");
        assert_eq!(b.len(), BUS_CAP);
    }

    #[test]
    fn task_events_carry_the_rows_recipient_seq_and_template() {
        // Regression: the event carried only the post-commit owner, so a prompter→librarian
        // handoff into the prompter-owned preflight stage looked like a prompter→prompter
        // self-relay (hidden in chat), and the voice summary replaced the facts.
        let (mut h, env) = entry(Some("Looks solid, passing it on"), "Coder staged index.html (14.2 KB)");
        h.from_agent = "prompter".into();
        h.to_agent = "librarian".into();
        let e = from_entry(&h, &env, &SummaryFilter::default());
        assert_eq!(e.to_agent.as_deref(), Some("librarian"));
        assert_eq!(e.row_seq, Some(h.seq));
        assert_eq!(e.template_summary.as_deref(), Some("Coder staged index.html (14.2 KB)"));
        let v: Value = serde_json::to_value(&e).unwrap();
        assert_eq!(v["toAgent"], "librarian");
        assert!(v.get("rowSeq").is_some() && v.get("templateSummary").is_some());
        let (h, env) = entry(None, "Spec ready");
        assert!(from_entry(&h, &env, &SummaryFilter::default()).template_summary.is_none());
    }

    #[test]
    fn task_notes_are_attributed_and_replayed_for_a_late_listener() {
        let n = task_note("t-1", "librarian", "mirror_failed", "milestone", "Couldn't index it", &SummaryFilter::default());
        assert_eq!(n.task_id.as_deref(), Some("t-1"));
        assert_eq!(n.trace_id.as_deref(), Some("task:t-1"));
        // Regression: events emitted before the webview listened (startup 'interrupted' rows) were lost.
        let r = Replay::new(3);
        for i in 0..5 {
            let mut e = ev("milestone");
            e.seq = 100 + i;
            r.record(&e);
        }
        let got: Vec<u64> = r.since(0).iter().map(|e| e.seq).collect();
        assert_eq!(got, [102, 103, 104]);
        assert_eq!(r.since(103).len(), 1);
        assert!(publish(ev("milestone")));
        assert!(!agent_events_replay(None).events.is_empty());
    }

    #[test]
    fn publish_without_app_is_bounded() {
        for _ in 0..(BUS_CAP + 10) {
            publish_note("system", "progress", "verbose", "tick", None);
        }
        assert!(bus().len() <= BUS_CAP);
    }
}
