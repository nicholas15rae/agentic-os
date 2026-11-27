//! Telemetry events + Live Observer Mode.
//!
//! [`event`] is the one entry point every module uses (`policy`, `breaker`, `defer`,
//! `queue_timeout`, `librarian`, `probe`, `run`, `ui_stall`, `ui_error`, `error`). Low-volume kinds
//! that record a self-healing / control action (`ALWAYS_LOGGED`) are appended to
//! `<config>/telemetry/events.jsonl` whether or not Live Observer Mode is on; everything is also
//! forwarded to the live stream while it is on. Calling `event` never blocks on the network and
//! never panics; while Live is off the forward is a single atomic load.
//!
//! Live Observer Mode (docs/proposals/orchestrator-policy-and-live-observer.md §2) is OFF by
//! default and OFF after every restart (the on-state is never persisted). [`live_set`]`(true)`:
//! - a ticker thread (every `policy.liveObserver.tickMs`, re-read each tick, so it is hot) that
//!   holds a `procstats` Guard and assembles one tick ([`build_tick`]);
//! - `telemetry/live_observer.json` (latest tick, atomic rewrite) and `telemetry/live_stream.jsonl`
//!   (one line per tick and per event; rotated to `live_stream.1.jsonl` past `streamMaxMb`);
//! - a read-only loopback HTTP server on `127.0.0.1:<liveObserver.port>`: `GET /live`,
//!   `GET /stream` (SSE), `GET /policy`, `GET /health`; anything else 404, non-GET 405, a foreign
//!   `Host` header 403 (DNS-rebinding guard). Requests are bounded (8 KiB head, 5 s), at most
//!   `MAX_SSE` stream clients, slow clients are dropped (bounded broadcast; lagged receivers skip).
//!
//! [`live_set`]`(false)` stops the ticker, closes the server and every SSE connection and drops the
//! Guard: zero background work. The Tauri event `live-status` ([`LiveStatus`]) fires on every
//! start / stop / error.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Kinds written to `events.jsonl` even when Live Observer Mode is off.
/// `agent_speech`: which agent spoke a report, when, in whose voice, and whether it interrupted.
pub const ALWAYS_LOGGED: [&str; 6] = ["policy", "breaker", "defer", "queue_timeout", "error", "agent_speech"];
pub const EVENTS_FILE: &str = "events.jsonl";
const EVENTS_MAX_BYTES: u64 = 10 * 1024 * 1024;

pub const LIVE_FILE: &str = "live_observer.json";
pub const STREAM_FILE: &str = "live_stream.jsonl";
pub const STREAM_ROTATED: &str = "live_stream.1.jsonl";
pub const STATUS_EVENT: &str = "live-status";
/// Concurrent `GET /stream` clients.
pub const MAX_SSE: usize = 8;
/// Concurrent connections of any kind (excess sockets are closed at once).
const MAX_CONNS: usize = 32;
/// Request head limit (request line + headers).
const MAX_HEAD: usize = 8 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
/// A client that can't take a frame within this is dropped.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const HEARTBEAT: Duration = Duration::from_secs(15);
/// Broadcast backlog per SSE client before it starts skipping (lagged).
const BACKLOG: usize = 256;
const DETAIL_MAX: usize = 200;

fn file_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

/// Append one line to `events.jsonl` (rotated to `events.1.jsonl` past 10 MB). Best effort.
fn append_event_log(line: &Value) {
    let Some(root) = super::policy::telemetry_root() else { return };
    let _g = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    let path = root.join(EVENTS_FILE);
    if std::fs::metadata(&path).map(|m| m.len() > EVENTS_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, root.join("events.1.jsonl"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Record a telemetry event. `payload` must be labels and numbers only (never prompts / payloads).
pub fn event(kind: &str, payload: Value) {
    let line = json!({ "t": kind, "at": super::arbiter::now_ms(), "data": payload });
    if ALWAYS_LOGGED.contains(&kind) {
        append_event_log(&line);
    }
    if kind == "probe" || kind == "librarian" {
        note_tok(kind, &line["data"]);
    }
    forward_live(&line);
}

/// Hand an event line to the live stream (a single atomic load while Live Observer Mode is off).
fn forward_live(line: &Value) {
    if !ON.load(Ordering::Relaxed) {
        return;
    }
    publish(&line.to_string());
}

// ── Last known tokens/s per node (from probe / librarian events) ────────────

fn tok_map() -> &'static Mutex<BTreeMap<String, f64>> {
    static M: OnceLock<Mutex<BTreeMap<String, f64>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

/// The node + tokens/s an event carries, if any (pure).
pub fn tok_from(kind: &str, data: &Value) -> Option<(String, f64)> {
    let node = data["node"].as_str().map(str::to_string).or_else(|| (kind == "librarian").then(|| "librarian".to_string()))?;
    let tps = data["tokensPerSec"].as_f64().or_else(|| data["tokPerSec"].as_f64()).or_else(|| data["phases"]["tokensPerSec"].as_f64())?;
    (tps.is_finite() && tps > 0.0).then_some((node, tps))
}

fn note_tok(kind: &str, data: &Value) {
    if let Some((node, tps)) = tok_from(kind, data) {
        // Bounded: only real node ids are remembered.
        if super::arbiter::node_def(&node).is_some() {
            tok_map().lock().unwrap_or_else(|e| e.into_inner()).insert(node, (tps * 10.0).round() / 10.0);
        }
    }
}

// ── Live state ──────────────────────────────────────────────────────────────

static ON: AtomicBool = AtomicBool::new(false);
static TICKS: AtomicU64 = AtomicU64::new(0);
static SEQ: AtomicU64 = AtomicU64::new(0);
static SSE_CLIENTS: AtomicUsize = AtomicUsize::new(0);
static CONNS: AtomicUsize = AtomicUsize::new(0);

struct Run {
    /// Ticker thread stop flag.
    stop: Arc<AtomicBool>,
    /// Server + every connection stop signal.
    stop_tx: tokio::sync::watch::Sender<bool>,
    tx: tokio::sync::broadcast::Sender<Arc<str>>,
    port: u16,
    started_at: u64,
}

fn run_cell() -> &'static Mutex<Option<Run>> {
    static R: OnceLock<Mutex<Option<Run>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn last_error() -> &'static Mutex<Option<String>> {
    static E: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(None))
}

fn latest_tick() -> &'static Mutex<Option<Arc<str>>> {
    static T: OnceLock<Mutex<Option<Arc<str>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

fn latest_line() -> Option<Arc<str>> {
    latest_tick().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn stream_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn app_cell() -> &'static OnceLock<tauri::AppHandle> {
    static A: OnceLock<tauri::AppHandle> = OnceLock::new();
    &A
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub on: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub dir: Option<String>,
    pub ticks: u64,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
}

/// Remember the app handle (lib.rs setup, after `policy::init`). Starts nothing: Live is OFF.
pub fn init(app: &tauri::AppHandle) {
    let _ = app_cell().set(app.clone());
}

/// Is Live Observer Mode on?
pub fn enabled() -> bool {
    ON.load(Ordering::Relaxed)
}

pub fn status() -> LiveStatus {
    let (port, started_at) = run_cell().lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| (Some(r.port), Some(r.started_at))).unwrap_or((None, None));
    LiveStatus {
        on: enabled(),
        port,
        url: port.map(|p| format!("http://127.0.0.1:{p}")),
        dir: super::policy::telemetry_root().map(|r| r.display().to_string()),
        ticks: TICKS.load(Ordering::Relaxed),
        started_at,
        last_error: last_error().lock().unwrap_or_else(|e| e.into_inner()).clone(),
    }
}

fn emit_status() {
    if let Some(app) = app_cell().get() {
        use tauri::Emitter;
        let _ = app.emit(STATUS_EVENT, status());
    }
}

fn set_error(e: Option<String>) {
    let changed = {
        let mut le = last_error().lock().unwrap_or_else(|e| e.into_inner());
        let changed = *le != e;
        *le = e;
        changed
    };
    if changed {
        emit_status();
    }
}

/// Append to the stream file and fan out to SSE clients.
fn publish(line: &str) {
    if let Some(root) = super::policy::telemetry_root() {
        let max = super::policy::current().live_observer.stream_max_mb.max(1) * 1_048_576;
        let _g = stream_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _ = append_rotating(&root.join(STREAM_FILE), &root.join(STREAM_ROTATED), line, max);
    }
    let tx = run_cell().lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.tx.clone());
    if let Some(tx) = tx {
        let _ = tx.send(Arc::from(line));
    }
}

/// Append `line` + '\n' to `path`, first renaming it to `rotated` once it is past `max_bytes`.
pub fn append_rotating(path: &Path, rotated: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if std::fs::metadata(path).map(|m| m.len() >= max_bytes).unwrap_or(false) {
        let _ = std::fs::remove_file(rotated);
        std::fs::rename(path, rotated)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{line}")
}

/// Turn Live Observer Mode on / off. Idempotent. Err (and stays off) when the port is taken.
pub fn set(on: bool) -> Result<LiveStatus, String> {
    if on {
        start()?;
    } else {
        stop();
    }
    emit_status();
    Ok(status())
}

fn start() -> Result<(), String> {
    let mut cell = run_cell().lock().unwrap_or_else(|e| e.into_inner());
    if cell.is_some() {
        return Ok(());
    }
    let app = app_cell().get().cloned().ok_or("Live Observer is not initialised yet")?;
    if super::policy::telemetry_root().is_none() {
        return Err("telemetry folder is not ready yet".into());
    }
    let port = super::policy::current().live_observer.port;
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).and_then(|l| l.set_nonblocking(true).map(|_| l)).map_err(|e| {
        let msg = format!("Live Observer could not open 127.0.0.1:{port} ({e}). Another program holds the port: set liveObserver.port in orchestrator_policy.json and try again.");
        drop_error_later(msg.clone());
        msg
    })?;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let (tx, _) = tokio::sync::broadcast::channel::<Arc<str>>(BACKLOG);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    std::thread::Builder::new().name("live-ticker".into()).spawn(move || ticker(app, stop_t)).map_err(|e| format!("Live Observer ticker did not start: {e}"))?;
    tauri::async_runtime::spawn(serve(listener, port, stop_rx, tx.clone()));
    TICKS.store(0, Ordering::Relaxed);
    *cell = Some(Run { stop, stop_tx, tx, port, started_at: super::arbiter::now_ms() });
    ON.store(true, Ordering::SeqCst);
    drop(cell);
    *last_error().lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

/// Record an error without emitting while a caller still holds `run_cell` (set() emits after).
fn drop_error_later(msg: String) {
    *last_error().lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
}

fn stop() {
    let run = run_cell().lock().unwrap_or_else(|e| e.into_inner()).take();
    ON.store(false, Ordering::SeqCst);
    if let Some(r) = run {
        r.stop.store(true, Ordering::SeqCst);
        let _ = r.stop_tx.send(true);
        // Dropping `r.tx` closes every SSE receiver once the server task drops its clone.
    }
}

#[tauri::command]
pub async fn live_set(on: bool) -> Result<LiveStatus, String> {
    let r = set(on);
    if r.is_err() {
        emit_status();
    }
    r
}

#[tauri::command]
pub fn live_status() -> LiveStatus {
    status()
}

/// The webview reports a main-thread stall / error (labels and numbers only).
#[tauri::command]
pub async fn live_ui_event(kind: String, ms: u64, detail: Option<String>) {
    if let Some((kind, payload)) = ui_event(&kind, ms, detail.as_deref()) {
        event(kind, payload);
    }
}

/// The webview's agent-report player: one line per report it played or queued (Comms inbox).
#[tauri::command]
pub async fn agent_speech_event(agent: String, voice: String, outcome: String, interrupted: bool, waited_ms: u64, urgent: bool) {
    if let Some(payload) = speech_event(&agent, &voice, &outcome, interrupted, waited_ms, urgent) {
        event("agent_speech", payload);
    }
}

/// Validate an `agent_speech` event (pure): ids only (never the report text), known outcomes only.
pub fn speech_event(agent: &str, voice: &str, outcome: &str, interrupted: bool, waited_ms: u64, urgent: bool) -> Option<Value> {
    let id = |s: &str| -> Option<String> {
        let s = s.trim().to_ascii_lowercase();
        (!s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).then_some(s)
    };
    let (agent, voice) = (id(agent)?, id(voice)?);
    let outcome = match outcome {
        "spoke" | "queued" | "inbox_only" | "replayed" | "failed" => outcome,
        _ => return None,
    };
    Some(json!({ "agent": agent, "voice": voice, "outcome": outcome, "interrupted": interrupted, "waitedMs": waited_ms.min(86_400_000), "urgent": urgent }))
}

/// Validate + clip a webview event (pure). Unknown kinds are dropped.
pub fn ui_event(kind: &str, ms: u64, detail: Option<&str>) -> Option<(&'static str, Value)> {
    let kind = match kind {
        "ui_stall" => "ui_stall",
        "ui_error" => "ui_error",
        _ => return None,
    };
    let detail = detail.map(|d| d.chars().filter(|c| !c.is_control()).take(DETAIL_MAX).collect::<String>()).filter(|d| !d.is_empty());
    Some((kind, json!({ "ms": ms, "detail": detail })))
}

// ── Ticker ──────────────────────────────────────────────────────────────────

/// Everything one tick is assembled from (synthetic in tests).
pub struct TickIn<'a> {
    pub at: u64,
    pub seq: u64,
    /// `scheduler::SlotDetail` as JSON (camelCase), Null when unavailable.
    pub slot: &'a Value,
    /// `arbiter::get().nodes()`.
    pub nodes: &'a [Value],
    pub decisions: &'a [super::stagger::Decision],
    pub tok: &'a BTreeMap<String, f64>,
    pub hw: Option<&'a super::procstats::Split>,
    pub policy_version: u32,
    pub policy_status: &'a Value,
}

fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn footprint_json(f: &super::procstats::Footprint) -> Value {
    json!({ "cpuPct": r1(f.cpu_pct as f64), "ramUsedGb": f.ram_used_gb, "gpuUtilPct": f.gpu_util_pct.map(|v| r1(v as f64)), "vramUsedMb": f.vram_used_mb, "processes": f.processes })
}

/// One tick line (pure). Shape: the proposal's §2 example.
pub fn build_tick(i: &TickIn) -> Value {
    let entries = |k: &str| i.slot[k].as_array().cloned().unwrap_or_default();
    let holders = entries("holders");
    let waiters = entries("waiters");
    let holder = holders.first().map(|h| json!({ "label": h["label"], "node": h["node"], "tier": h["tier"], "sinceMs": h["ms"] }));
    let queue: Vec<Value> = waiters
        .iter()
        .map(|w| {
            let mut q = json!({ "node": w["node"], "tier": w["tier"], "waitMs": w["ms"] });
            if w["node"].is_null() {
                q["label"] = w["label"].clone();
            }
            q
        })
        .collect();
    let b = &i.slot["breaker"];
    let since = b["sinceMsAgo"].as_u64().map(|ago| i.at.saturating_sub(ago));
    let mut gpu = json!({
        "holder": holder,
        "queue": queue,
        "depth": waiters.len(),
        "capacity": i.slot["capacity"],
        "settling": i.slot["settling"],
        "breaker": { "tripped": b["tripped"].as_bool().unwrap_or(false), "since": since, "trips": b["trips"], "lastReason": b["lastReason"] },
        "tier1WaitP95Ms": i.slot["tier1WaitP95Ms"],
    });
    if holders.len() > 1 {
        gpu["holders"] = json!(holders.iter().map(|h| json!({ "label": h["label"], "node": h["node"], "tier": h["tier"], "sinceMs": h["ms"] })).collect::<Vec<_>>());
    }

    let ms_for = |list: &[Value], node: &str| list.iter().filter(|e| e["node"].as_str() == Some(node)).filter_map(|e| e["ms"].as_u64()).max();
    let agents: Vec<Value> = i
        .nodes
        .iter()
        .filter_map(|n| {
            let id = n["id"].as_str()?;
            let state = n["state"].as_str().unwrap_or("DORMANT");
            let wait = ms_for(&waiters, id);
            let infer = ms_for(&holders, id);
            (state != "DORMANT" || wait.is_some() || infer.is_some()).then(|| json!({ "node": id, "state": state, "waitMs": wait, "inferMs": infer, "tokPerSec": i.tok.get(id) }))
        })
        .collect();

    let active: Vec<&str> = i.nodes.iter().filter(|n| matches!(n["state"].as_str(), Some("ACTIVE") | Some("ACTIVE_TOKEN"))).filter_map(|n| n["id"].as_str()).filter(|id| super::stagger::DAEMONS.contains(id)).collect();
    let last = i.decisions.last().map(|d| json!({ "job": d.job, "ran": d.ran, "reason": d.reason, "at": d.at }));

    let hw = i.hw.map(|s| {
        let mut system = footprint_json(&s.system);
        if let Some(o) = system.as_object_mut() {
            o.remove("processes");
        }
        system["vramTotalMb"] = json!(s.vram_total_mb);
        system["vramHeadroomMb"] = json!(match (s.vram_total_mb, s.system.vram_used_mb) {
            (Some(t), Some(u)) => Some(t.saturating_sub(u)),
            _ => None,
        });
        let mut other = footprint_json(&s.other);
        other["top"] = json!(s.top_other.iter().map(|p| json!({ "name": p.name, "pid": p.pid, "cpuPct": r1(p.cpu_pct as f64), "gpuUtilPct": p.gpu_util_pct.map(|v| r1(v as f64)), "vramUsedMb": p.vram_used_mb })).collect::<Vec<_>>());
        json!({ "at": s.at, "system": system, "app": footprint_json(&s.app), "other": other })
    });

    json!({
        "t": "tick",
        "at": i.at,
        "seq": i.seq,
        "gpu": gpu,
        "agents": agents,
        "daemons": { "active": active, "lastDecision": last },
        "hw": hw,
        "policy": { "version": i.policy_version, "loadedAt": i.policy_status["at"], "state": i.policy_status["state"] },
    })
}

fn slot_detail(app: &tauri::AppHandle) -> Value {
    use tauri::Manager;
    app.try_state::<super::os_core::OsState>().map(|s| serde_json::to_value(s.slot.detail()).unwrap_or(Value::Null)).unwrap_or(Value::Null)
}

fn tick_once(app: &tauri::AppHandle) {
    let slot = slot_detail(app);
    let nodes = super::arbiter::get().nodes();
    let decisions = super::stagger::recent();
    let tok = tok_map().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let hw = super::procstats::latest();
    let policy = super::policy::current();
    let pstatus = super::policy::status();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let tick = build_tick(&TickIn { at: super::arbiter::now_ms(), seq, slot: &slot, nodes: &nodes, decisions: &decisions, tok: &tok, hw: hw.as_ref(), policy_version: policy.version, policy_status: &pstatus });
    let line = tick.to_string();
    *latest_tick().lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::from(line.as_str()));
    let write = super::policy::telemetry_root().map(|root| super::staging::atomic_write(&root.join(LIVE_FILE), line.as_bytes()));
    publish(&line);
    TICKS.fetch_add(1, Ordering::Relaxed);
    match write {
        Some(Err(e)) => set_error(Some(format!("{LIVE_FILE}: {e}"))),
        _ => {
            if last_error().lock().map(|e| e.is_some()).unwrap_or(false) {
                set_error(None);
            }
        }
    }
}

fn ticker(app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    let _guard = super::procstats::acquire();
    while !stop.load(Ordering::SeqCst) {
        let t0 = Instant::now();
        // A panic in assembly must not kill the ticker silently; report it and carry on.
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick_once(&app))).is_err() {
            set_error(Some("tick assembly panicked (see stderr)".into()));
        }
        let every = Duration::from_millis(super::policy::current().live_observer.tick_ms.clamp(250, 10_000));
        let deadline = t0 + every;
        while !stop.load(Ordering::SeqCst) {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            std::thread::sleep((deadline - now).min(Duration::from_millis(100)));
        }
    }
}

// ── Loopback HTTP (pure parts) ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Live,
    Stream,
    Policy,
    Health,
    NotFound,
    MethodNotAllowed,
    BadRequest,
    Forbidden,
}

/// Request line + Host header of a request head (pure). None = not a parsable HTTP/1.x head.
pub fn parse_head(head: &str) -> Option<(String, String, Option<String>)> {
    let mut lines = head.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !version.starts_with("HTTP/1.") || method.is_empty() || !target.starts_with('/') {
        return None;
    }
    let path = target.split(|c| c == '?' || c == '#').next().unwrap_or("/").to_string();
    let host = lines.take_while(|l| !l.is_empty()).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("host").then(|| v.trim().to_ascii_lowercase())
    });
    Some((method.to_string(), path, host))
}

/// Only loopback Host names reach the data (blocks DNS rebinding from a browser page). A request
/// without Host (HTTP/1.0 tools) is allowed: browsers always send one.
pub fn host_ok(host: Option<&str>, port: u16) -> bool {
    let Some(h) = host else { return true };
    let (name, p) = if h.starts_with('[') {
        match h.find(']') {
            Some(i) => (&h[..=i], h[i + 1..].strip_prefix(':')),
            None => return false,
        }
    } else {
        match h.rsplit_once(':') {
            Some((n, p)) => (n, Some(p)),
            None => (h, None),
        }
    };
    matches!(name, "127.0.0.1" | "localhost" | "[::1]") && p.map(|p| p == port.to_string()).unwrap_or(true)
}

/// Route a parsed head (pure).
pub fn route(head: &str, port: u16) -> Route {
    let Some((method, path, host)) = parse_head(head) else { return Route::BadRequest };
    if method != "GET" {
        return Route::MethodNotAllowed;
    }
    if !host_ok(host.as_deref(), port) {
        return Route::Forbidden;
    }
    match path.as_str() {
        "/live" => Route::Live,
        "/stream" => Route::Stream,
        "/policy" => Route::Policy,
        "/health" => Route::Health,
        _ => Route::NotFound,
    }
}

/// One SSE frame for a JSON line (pure). JSON from serde never holds a raw newline; any that
/// slips through is split into continuation `data:` lines, as the SSE spec requires.
pub fn sse_frame(line: &str) -> String {
    let mut s = String::with_capacity(line.len() + 8);
    for l in line.split('\n') {
        s.push_str("data: ");
        s.push_str(l.trim_end_matches('\r'));
        s.push('\n');
    }
    s.push('\n');
    s
}

/// A complete `Connection: close` response (pure).
pub fn http_response(code: u16, reason: &str, ctype: &str, body: &[u8], extra: &str) -> Vec<u8> {
    let mut v = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n{extra}\r\n", body.len()).into_bytes();
    v.extend_from_slice(body);
    v
}

fn json_response(v: &Value) -> Vec<u8> {
    http_response(200, "OK", "application/json", v.to_string().as_bytes(), "")
}

fn error_response(code: u16, reason: &str, extra: &str) -> Vec<u8> {
    http_response(code, reason, "application/json", json!({ "error": reason }).to_string().as_bytes(), extra)
}

// ── Loopback HTTP (I/O) ─────────────────────────────────────────────────────

struct Counted(&'static AtomicUsize);
impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn take_slot(c: &'static AtomicUsize, max: usize) -> Option<Counted> {
    if c.fetch_add(1, Ordering::SeqCst) >= max {
        c.fetch_sub(1, Ordering::SeqCst);
        return None;
    }
    Some(Counted(c))
}

fn stopped(rx: &tokio::sync::watch::Receiver<bool>) -> bool {
    *rx.borrow() || rx.has_changed().is_err()
}

async fn serve(std_listener: std::net::TcpListener, port: u16, mut stop_rx: tokio::sync::watch::Receiver<bool>, tx: tokio::sync::broadcast::Sender<Arc<str>>) {
    let listener = match tokio::net::TcpListener::from_std(std_listener) {
        Ok(l) => l,
        Err(e) => {
            set_error(Some(format!("Live Observer server: {e}")));
            return;
        }
    };
    loop {
        if stopped(&stop_rx) {
            break;
        }
        tokio::select! {
            _ = stop_rx.changed() => break,
            r = listener.accept() => match r {
                Ok((sock, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let Some(slot) = take_slot(&CONNS, MAX_CONNS) else { continue };
                    tauri::async_runtime::spawn(connection(sock, port, stop_rx.clone(), tx.clone(), slot));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
        }
    }
    // Listener dropped here: the port is released.
}

async fn read_head(sock: &mut tokio::net::TcpStream) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            if end > MAX_HEAD {
                return None;
            }
            buf.truncate(end + 2);
            return Some(String::from_utf8_lossy(&buf).into_owned());
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
}

async fn write_timed(sock: &mut tokio::net::TcpStream, bytes: &[u8]) -> bool {
    use tokio::io::AsyncWriteExt;
    matches!(tokio::time::timeout(WRITE_TIMEOUT, sock.write_all(bytes)).await, Ok(Ok(())))
}

async fn connection(mut sock: tokio::net::TcpStream, port: u16, stop_rx: tokio::sync::watch::Receiver<bool>, tx: tokio::sync::broadcast::Sender<Arc<str>>, _slot: Counted) {
    use tokio::io::AsyncWriteExt;
    let head = match tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut sock)).await {
        Ok(Some(h)) => h,
        Ok(None) => {
            let _ = write_timed(&mut sock, &error_response(400, "Bad Request", "")).await;
            return;
        }
        Err(_) => return,
    };
    let resp = match route(&head, port) {
        Route::Stream => return sse(sock, stop_rx, tx).await,
        Route::Live => match latest_line() {
            Some(t) => http_response(200, "OK", "application/json", t.as_bytes(), ""),
            None => json_response(&json!({ "t": "tick", "pending": true })),
        },
        Route::Policy => json_response(&json!({ "policy": *super::policy::current(), "status": super::policy::status() })),
        Route::Health => json_response(&json!({ "ok": true, "on": enabled(), "ticks": TICKS.load(Ordering::Relaxed), "seq": SEQ.load(Ordering::Relaxed), "sseClients": SSE_CLIENTS.load(Ordering::Relaxed), "port": port })),
        Route::NotFound => error_response(404, "Not Found", ""),
        Route::MethodNotAllowed => error_response(405, "Method Not Allowed", "Allow: GET\r\n"),
        Route::BadRequest => error_response(400, "Bad Request", ""),
        Route::Forbidden => error_response(403, "Forbidden", ""),
    };
    if write_timed(&mut sock, &resp).await {
        let _ = sock.shutdown().await;
    }
}

async fn sse(mut sock: tokio::net::TcpStream, mut stop_rx: tokio::sync::watch::Receiver<bool>, tx: tokio::sync::broadcast::Sender<Arc<str>>) {
    use tokio::sync::broadcast::error::RecvError;
    let Some(_client) = take_slot(&SSE_CLIENTS, MAX_SSE) else {
        let _ = write_timed(&mut sock, &error_response(503, "Too Many Stream Clients", "Retry-After: 5\r\n")).await;
        return;
    };
    let mut rx = tx.subscribe();
    drop(tx);
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: keep-alive\r\n\r\nretry: 2000\n\n";
    if !write_timed(&mut sock, head.as_bytes()).await {
        return;
    }
    if let Some(t) = latest_line() {
        if !write_timed(&mut sock, sse_frame(&t).as_bytes()).await {
            return;
        }
    }
    let mut hb = tokio::time::interval(HEARTBEAT);
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    hb.tick().await;
    loop {
        if stopped(&stop_rx) {
            break;
        }
        let out = tokio::select! {
            _ = stop_rx.changed() => break,
            r = rx.recv() => match r {
                Ok(line) => sse_frame(&line),
                Err(RecvError::Lagged(n)) => format!(": lagged {n}\n\n"),
                Err(RecvError::Closed) => break,
            },
            _ = hb.tick() => ": hb\n\n".to_string(),
        };
        if !write_timed(&mut sock, out.as_bytes()).await {
            break; // slow or gone: drop it
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::procstats::{Footprint, ProcRow, Split};
    use super::super::stagger::Decision;
    use super::*;

    #[test]
    fn speech_event_keeps_ids_only_and_known_outcomes() {
        let v = speech_event("Trading", "general", "spoke", true, 1200, true).unwrap();
        assert_eq!(v["agent"], "trading");
        assert_eq!(v["voice"], "general");
        assert_eq!(v["interrupted"], true);
        assert_eq!(v["waitedMs"], 1200);
        assert!(speech_event("director", "director", "shouted", false, 0, false).is_none());
        assert!(speech_event("Nic, the edit's done.", "director", "spoke", false, 0, false).is_none());
        assert!(speech_event("", "general", "spoke", false, 0, false).is_none());
        assert!(ALWAYS_LOGGED.contains(&"agent_speech"));
    }

    #[test]
    fn tick_assembly_matches_the_proposal_shape() {
        let slot = json!({
            "capacity": 1, "settling": 0,
            "holders": [{ "label": "worker · coder code · lmstudio", "node": "coder", "tier": 3, "ms": 8120 }],
            "waiters": [{ "label": "lmstudio · Tony", "node": "tony", "tier": 1, "ms": 640 }, { "label": "worker · librarian x", "node": "librarian", "tier": 3, "ms": 5210 }, { "label": "maintenance · reload", "node": null, "tier": 3, "ms": 10 }],
            "breaker": { "tripped": true, "sinceMsAgo": 1000, "trips": 2, "lastReason": "tony waited 1600 ms" },
            "tier1WaitP95Ms": 700
        });
        let nodes = vec![json!({ "id": "coder", "state": "ACTIVE_TOKEN" }), json!({ "id": "tony", "state": "QUEUED" }), json!({ "id": "security", "state": "ACTIVE" }), json!({ "id": "garbage", "state": "DORMANT" }), json!({ "id": "designer", "state": "DORMANT" })];
        let decisions = vec![Decision { at: 1, job: "observer".into(), ran: true, reason: None }, Decision { at: 2, job: "garbage".into(), ran: false, reason: Some("market hours".into()) }];
        let tok: BTreeMap<String, f64> = [("coder".to_string(), 24.8)].into_iter().collect();
        let hw = Split {
            at: 99,
            system: Footprint { cpu_pct: 41.0, ram_used_gb: 21.3, gpu_util_pct: Some(97.0), vram_used_mb: Some(9640), processes: vec![] },
            vram_total_mb: Some(12288),
            app: Footprint { cpu_pct: 6.2, ram_used_gb: 1.9, gpu_util_pct: Some(88.0), vram_used_mb: Some(9000), processes: vec!["command-center".into(), "llama-server".into()] },
            other: Footprint { cpu_pct: 34.8, ram_used_gb: 19.4, gpu_util_pct: Some(9.0), vram_used_mb: Some(640), processes: vec!["chromium".into()] },
            top_other: vec![ProcRow { name: "chromium".into(), pid: 7, cpu_pct: 18.0, gpu_util_pct: Some(9.0), vram_used_mb: Some(600) }],
        };
        let pst = json!({ "state": "applied", "at": 1795547800000u64 });
        let t = build_tick(&TickIn { at: 1_000_000, seq: 412, slot: &slot, nodes: &nodes, decisions: &decisions, tok: &tok, hw: Some(&hw), policy_version: 1, policy_status: &pst });
        assert_eq!(t["t"], "tick");
        assert_eq!(t["seq"], 412);
        assert_eq!(t["gpu"]["holder"], json!({ "label": "worker · coder code · lmstudio", "node": "coder", "tier": 3, "sinceMs": 8120 }));
        assert_eq!(t["gpu"]["queue"][0], json!({ "node": "tony", "tier": 1, "waitMs": 640 }));
        assert_eq!(t["gpu"]["queue"][2]["label"], "maintenance · reload");
        assert_eq!(t["gpu"]["depth"], 3);
        assert_eq!(t["gpu"]["capacity"], 1);
        assert_eq!(t["gpu"]["breaker"]["tripped"], true);
        assert_eq!(t["gpu"]["breaker"]["since"], 999_000);
        assert!(t["gpu"].get("holders").is_none());
        let agents = t["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 3, "{agents:?}");
        assert_eq!(agents[0], json!({ "node": "coder", "state": "ACTIVE_TOKEN", "waitMs": null, "inferMs": 8120, "tokPerSec": 24.8 }));
        assert_eq!(agents[1]["waitMs"], 640);
        assert_eq!(t["daemons"]["active"], json!(["security"]));
        assert_eq!(t["daemons"]["lastDecision"]["reason"], "market hours");
        assert_eq!(t["hw"]["system"]["vramHeadroomMb"], 2648);
        assert!(t["hw"]["system"].get("processes").is_none());
        assert_eq!(t["hw"]["app"]["processes"], json!(["command-center", "llama-server"]));
        assert_eq!(t["hw"]["other"]["top"][0]["name"], "chromium");
        assert_eq!(t["policy"], json!({ "version": 1, "loadedAt": 1795547800000u64, "state": "applied" }));
    }

    #[test]
    fn tick_with_nothing_known_is_still_well_formed() {
        let t = build_tick(&TickIn { at: 5, seq: 1, slot: &Value::Null, nodes: &[], decisions: &[], tok: &BTreeMap::new(), hw: None, policy_version: 1, policy_status: &json!({ "state": "defaults" }) });
        assert_eq!(t["gpu"]["holder"], Value::Null);
        assert_eq!(t["gpu"]["depth"], 0);
        assert_eq!(t["gpu"]["breaker"]["tripped"], false);
        assert_eq!(t["hw"], Value::Null);
        assert_eq!(t["daemons"]["lastDecision"], Value::Null);
    }

    #[test]
    fn rotation_moves_the_full_file_aside() {
        let dir = std::env::temp_dir().join(format!("cc-live-rot-{}-{}", std::process::id(), super::super::arbiter::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let (p, r) = (dir.join(STREAM_FILE), dir.join(STREAM_ROTATED));
        for i in 0..10 {
            append_rotating(&p, &r, &format!("{{\"i\":{i}}}"), 30).unwrap();
        }
        let cur = std::fs::read_to_string(&p).unwrap();
        let old = std::fs::read_to_string(&r).unwrap();
        assert!(cur.len() <= 30 + 8, "{cur}");
        assert!(cur.ends_with("{\"i\":9}\n"));
        assert!(!old.is_empty());
        assert_eq!(cur.lines().count() + old.lines().count() <= 10, true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_parsing_and_routing() {
        let req = |m: &str, p: &str, host: &str| format!("{m} {p} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: t\r\n\r\n");
        assert_eq!(route(&req("GET", "/live", "127.0.0.1:8791"), 8791), Route::Live);
        assert_eq!(route(&req("GET", "/stream?x=1", "localhost:8791"), 8791), Route::Stream);
        assert_eq!(route(&req("GET", "/policy", "127.0.0.1"), 8791), Route::Policy);
        assert_eq!(route(&req("GET", "/health", "[::1]:8791"), 8791), Route::Health);
        assert_eq!(route(&req("GET", "/health", "[::1]"), 8791), Route::Health);
        assert_eq!(route(&req("GET", "/health", "[::1"), 8791), Route::Forbidden);
        assert_eq!(route(&req("GET", "/", "127.0.0.1:8791"), 8791), Route::NotFound);
        assert_eq!(route(&req("GET", "/live/../x", "127.0.0.1:8791"), 8791), Route::NotFound);
        assert_eq!(route(&req("POST", "/live", "127.0.0.1:8791"), 8791), Route::MethodNotAllowed);
        assert_eq!(route(&req("DELETE", "/nope", "127.0.0.1:8791"), 8791), Route::MethodNotAllowed);
        assert_eq!(route(&req("GET", "/live", "evil.example:8791"), 8791), Route::Forbidden);
        assert_eq!(route(&req("GET", "/live", "127.0.0.1:9999"), 8791), Route::Forbidden);
        assert_eq!(route("GET /live HTTP/1.0\r\n\r\n", 8791), Route::Live);
        assert_eq!(route("garbage\r\n\r\n", 8791), Route::BadRequest);
        assert_eq!(route("GET live HTTP/1.1\r\n\r\n", 8791), Route::BadRequest);
        assert_eq!(route("GET /live SPDY/3\r\n\r\n", 8791), Route::BadRequest);
        let (m, p, h) = parse_head("GET /live?a#b HTTP/1.1\r\nhOsT:  LocalHost:8791 \r\n\r\n").unwrap();
        assert_eq!((m.as_str(), p.as_str(), h.as_deref()), ("GET", "/live", Some("localhost:8791")));
    }

    #[test]
    fn sse_framing_and_responses() {
        assert_eq!(sse_frame("{\"t\":\"tick\"}"), "data: {\"t\":\"tick\"}\n\n");
        assert_eq!(sse_frame("a\nb"), "data: a\ndata: b\n\n");
        let r = String::from_utf8(http_response(405, "Method Not Allowed", "application/json", b"{}", "Allow: GET\r\n")).unwrap();
        assert!(r.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"));
        assert!(r.contains("Content-Length: 2\r\n"));
        assert!(r.contains("Allow: GET\r\n\r\n{}"));
    }

    #[test]
    fn ui_events_are_clipped_and_kind_checked() {
        let long = "x".repeat(500);
        let (k, v) = ui_event("ui_stall", 300, Some(&long)).unwrap();
        assert_eq!(k, "ui_stall");
        assert_eq!(v["detail"].as_str().unwrap().chars().count(), DETAIL_MAX);
        assert_eq!(ui_event("ui_error", 0, Some("a\nb\tc")).unwrap().1["detail"], "abc");
        assert_eq!(ui_event("ui_error", 0, Some("\n")).unwrap().1["detail"], Value::Null);
        assert!(ui_event("policy", 0, None).is_none());
    }

    #[test]
    fn tok_per_sec_is_read_from_probe_and_librarian_events() {
        assert_eq!(tok_from("probe", &json!({ "node": "coder", "tokensPerSec": 24.8 })), Some(("coder".into(), 24.8)));
        assert_eq!(tok_from("librarian", &json!({ "phases": { "tokensPerSec": 22.0 } })), Some(("librarian".into(), 22.0)));
        assert_eq!(tok_from("probe", &json!({ "node": "coder", "tokensPerSec": null })), None);
        assert_eq!(tok_from("probe", &json!({ "node": "coder", "tokensPerSec": 0.0 })), None);
    }

    /// The real server on an ephemeral loopback port: routes, SSE frames, stop closes streams and
    /// releases the port.
    #[test]
    fn loopback_server_routes_streams_and_stops() {
        use std::io::{Read, Write as _};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.set_nonblocking(true).unwrap();
        let port = l.local_addr().unwrap().port();
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let (tx, _) = tokio::sync::broadcast::channel::<Arc<str>>(BACKLOG);
        tauri::async_runtime::spawn(serve(l, port, stop_rx, tx.clone()));
        let get = |req: String| {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        let host = format!("127.0.0.1:{port}");
        let r = get(format!("GET /health HTTP/1.1\r\nHost: {host}\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 200 OK") && r.contains("\"ok\":true"), "{r}");
        assert!(get(format!("GET /live HTTP/1.1\r\nHost: {host}\r\n\r\n")).starts_with("HTTP/1.1 200"));
        assert!(get(format!("POST /live HTTP/1.1\r\nHost: {host}\r\n\r\n")).starts_with("HTTP/1.1 405"));
        assert!(get(format!("GET /nope HTTP/1.1\r\nHost: {host}\r\n\r\n")).starts_with("HTTP/1.1 404"));
        assert!(get("GET /live HTTP/1.1\r\nHost: evil.example\r\n\r\n".into()).starts_with("HTTP/1.1 403"));
        // Oversized head: refused (a 400, or a reset when the client's unread bytes make the close an RST).
        let r = get(format!("GET /live HTTP/1.1\r\nHost: {host}\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD)));
        assert!(r.is_empty() || r.starts_with("HTTP/1.1 400"), "{r}");

        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(format!("GET /stream HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes()).unwrap();
        let mut seen = String::new();
        let mut buf = [0u8; 4096];
        let read_until = |s: &mut std::net::TcpStream, seen: &mut String, buf: &mut [u8], needle: &str| {
            let t0 = Instant::now();
            while !seen.contains(needle) && t0.elapsed() < Duration::from_secs(5) {
                match s.read(buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => seen.push_str(&String::from_utf8_lossy(&buf[..n])),
                }
            }
        };
        read_until(&mut s, &mut seen, &mut buf, "retry: 2000\n\n");
        assert!(seen.contains("text/event-stream"), "{seen}");
        tx.send(Arc::from("{\"t\":\"x\"}")).unwrap();
        read_until(&mut s, &mut seen, &mut buf, "data: {\"t\":\"x\"}\n\n");
        assert!(seen.contains("data: {\"t\":\"x\"}\n\n"), "{seen}");

        stop_tx.send(true).unwrap();
        drop(tx);
        let t0 = Instant::now();
        let closed = loop {
            match s.read(&mut buf) {
                Ok(0) => break true,
                Ok(_) => continue,
                Err(_) => break t0.elapsed() < Duration::from_secs(4),
            }
        };
        assert!(closed, "SSE connection must close on stop");
        let mut rebound = false;
        for _ in 0..40 {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                rebound = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(rebound, "port must be released after stop");
    }

    #[test]
    fn off_by_default_and_forward_is_a_no_op() {
        assert!(!enabled());
        let s = status();
        assert!(!s.on && s.port.is_none() && s.url.is_none());
        forward_live(&json!({ "t": "x" })); // must not touch files or panic while off
    }
}
