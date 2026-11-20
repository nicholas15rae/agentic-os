//! Shell lifecycle (Thought-to-Product spec, Phase 1): the gateway health heartbeat, the one-click
//! "Master Reset / Reconnect", and a clean Exit.
//!
//! - The heartbeat runs on the async runtime (never the webview's main thread): one tiny
//!   `GET /api/ping` every 10 s (5 s while failing), 3 s timeout, falling back to `/api/status` on
//!   an older gateway that has no `/api/ping`. Every probe result is emitted as `gateway-health`.
//! - Nothing here touches audio, Spotify, TTS or the mic: it is HTTP to the gateway plus an event.
//! - Exit: `app_exit_check` lists what a quit would interrupt mid-commit (a worker stage holding a
//!   live lease, a Claude Code fix run, a Play Place hub file operation); the webview asks only
//!   then. `app_exit` ends the process through `AppHandle::exit`, which runs the usual RunEvent::Exit
//!   cleanup (Spotify duck restore, Drive sync); MCP servers and Claude fix runs live in kill-on-close
//!   Job Objects (proc.rs), and the build hub's preview servers are tasks of this process, so
//!   nothing is orphaned. The gateway is the phone's sync hub and is left running on purpose.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use super::dispatch::DispatchState;

pub const HEALTH_EVENT: &str = "gateway-health";
pub const PING_EVERY: Duration = Duration::from_secs(10);
pub const PING_EVERY_FAILING: Duration = Duration::from_secs(5);
pub const PING_TIMEOUT: Duration = Duration::from_secs(3);
/// A reply slower than this reads "Slow" (the gateway answers /api/ping in single-digit ms).
pub const SLOW_MS: u64 = 1500;
/// Consecutive failed probes before the indicator offers Master Reset / Reconnect.
pub const RESET_AFTER: u32 = 2;

// ── Pure state mapping (unit-tested) ────────────────────────────────────────

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    #[default]
    Unknown,
    Online,
    Slow,
    TimedOut,
    Offline,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Probe {
    Ok { latency_ms: u64 },
    Timeout,
    Down(String),
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub state: Health,
    pub latency_ms: Option<u64>,
    /// Unix ms of the last probe (0 = never).
    pub checked_at: i64,
    pub consecutive_failures: u32,
    /// Timed out / offline long enough to offer the one-click reset.
    pub needs_reset: bool,
    pub reconnecting: bool,
    pub detail: String,
}

/// Fold one probe into the previous snapshot (pure).
pub fn fold(prev: &HealthSnapshot, probe: &Probe, now_ms: i64) -> HealthSnapshot {
    let (state, latency_ms, failures, detail) = match probe {
        Probe::Ok { latency_ms } => (if *latency_ms >= SLOW_MS { Health::Slow } else { Health::Online }, Some(*latency_ms), 0, format!("{latency_ms} ms")),
        Probe::Timeout => (Health::TimedOut, None, prev.consecutive_failures + 1, format!("no answer within {} s", PING_TIMEOUT.as_secs())),
        Probe::Down(why) => (Health::Offline, None, prev.consecutive_failures + 1, why.clone()),
    };
    HealthSnapshot { state, latency_ms, checked_at: now_ms, consecutive_failures: failures, needs_reset: failures >= RESET_AFTER, reconnecting: prev.reconnecting, detail }
}

// ── State ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct LifecycleState {
    health: Mutex<HealthSnapshot>,
    reconnecting: AtomicBool,
}

impl LifecycleState {
    pub fn snapshot(&self) -> HealthSnapshot {
        self.health.lock().unwrap().clone()
    }
    fn record(&self, probe: &Probe) -> HealthSnapshot {
        let mut h = self.health.lock().unwrap();
        *h = fold(&h, probe, chrono::Utc::now().timestamp_millis());
        h.reconnecting = self.reconnecting.load(Ordering::SeqCst);
        h.clone()
    }
    fn set_reconnecting(&self, on: bool) -> HealthSnapshot {
        self.reconnecting.store(on, Ordering::SeqCst);
        let mut h = self.health.lock().unwrap();
        h.reconnecting = on;
        h.clone()
    }
}

async fn probe(http: &reqwest::Client, base: &str) -> Probe {
    let base = base.trim_end_matches('/');
    let t0 = Instant::now();
    let get = |path: &str| http.get(format!("{base}{path}")).timeout(PING_TIMEOUT).send();
    let res = match get("/api/ping").await {
        // An older gateway (no /api/ping yet) still answers /api/status.
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => get("/api/status").await,
        other => other,
    };
    match res {
        Ok(r) if r.status().is_success() => Probe::Ok { latency_ms: t0.elapsed().as_millis() as u64 },
        Ok(r) => Probe::Down(format!("HTTP {}", r.status().as_u16())),
        Err(e) if e.is_timeout() => Probe::Timeout,
        Err(e) if e.is_connect() => Probe::Down("not running (connection refused)".into()),
        Err(_) => Probe::Down("unreachable".into()),
    }
}

async fn tick(app: &AppHandle) -> HealthSnapshot {
    let (http, url) = {
        let d = app.state::<DispatchState>();
        (d.http.clone(), d.snapshot().gateway.url)
    };
    let p = probe(&http, &url).await;
    let snap = app.state::<LifecycleState>().record(&p);
    let _ = app.emit(HEALTH_EVENT, &snap);
    snap
}

/// The heartbeat (spawned once in `lib.rs`).
pub async fn health_loop(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(3)).await;
    loop {
        let snap = tick(&app).await;
        let wait = if snap.consecutive_failures > 0 { PING_EVERY_FAILING } else { PING_EVERY };
        tokio::time::sleep(wait).await;
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn gateway_health(state: State<'_, LifecycleState>) -> HealthSnapshot {
    state.snapshot()
}

/// Master Reset / Reconnect: probe now; when the gateway is down, (re)launch it the same way
/// startup does (`services::gateway_ensure`, providers.json's command line only), then probe
/// again. One at a time; a second click while one runs just returns the current snapshot.
#[tauri::command]
pub async fn gateway_reconnect(app: AppHandle) -> Result<HealthSnapshot, String> {
    let life = app.state::<LifecycleState>();
    if life.reconnecting.swap(true, Ordering::SeqCst) {
        return Ok(life.snapshot());
    }
    let _ = app.emit(HEALTH_EVENT, &life.set_reconnecting(true));
    let first = tick(&app).await;
    if !matches!(first.state, Health::Online | Health::Slow) {
        let st = app.state::<DispatchState>();
        if let Err(e) = super::services::gateway_ensure(st).await {
            eprintln!("[gateway] reconnect: {e}");
        }
    }
    life.set_reconnecting(false);
    Ok(tick(&app).await)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExitCheck {
    /// Human-readable things a quit would interrupt mid-commit (empty = safe to quit now).
    pub busy: Vec<String>,
}

/// What would a quit interrupt mid-commit? Read-only.
#[tauri::command]
pub fn app_exit_check(app: AppHandle) -> ExitCheck {
    let mut busy = Vec::new();
    if app.state::<super::claude_fix::ClaudeFixState>().is_busy() {
        busy.push("A Claude Code fix is running in its worktree".to_string());
    }
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(list) = app.state::<super::envelope::TaskStore>().with(|c| super::envelope::list(c, None, 50, false)) {
        for e in list.iter().filter(|e| super::envelope::IN_FLIGHT.contains(&e.status.as_str()) && e.lease_until.is_some_and(|l| l > now) && !super::envelope::is_paused(&e.task_id)) {
            busy.push(format!("Build “{}” is mid-stage ({})", e.title, e.stage.as_deref().unwrap_or(&e.status)));
        }
    }
    busy.extend(super::buildhub::busy_labels(&app));
    ExitCheck { busy }
}

/// Quit the app. Refuses with `BUSY:` when something is mid-commit, unless `force`.
#[tauri::command]
pub fn app_exit(app: AppHandle, force: Option<bool>) -> Result<(), String> {
    if !force.unwrap_or(false) {
        let c = app_exit_check(app.clone());
        if !c.busy.is_empty() {
            return Err(format!("BUSY:{}", c.busy.join("; ")));
        }
    }
    super::buildhub::shutdown(&app);
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_reply_is_online_and_clears_failures() {
        let prev = HealthSnapshot { consecutive_failures: 3, needs_reset: true, ..Default::default() };
        let s = fold(&prev, &Probe::Ok { latency_ms: 12 }, 5);
        assert_eq!(s.state, Health::Online);
        assert_eq!(s.latency_ms, Some(12));
        assert_eq!(s.consecutive_failures, 0);
        assert!(!s.needs_reset);
        assert_eq!(s.checked_at, 5);
    }

    #[test]
    fn slow_reply_reads_slow() {
        let s = fold(&HealthSnapshot::default(), &Probe::Ok { latency_ms: SLOW_MS }, 1);
        assert_eq!(s.state, Health::Slow);
        assert!(!s.needs_reset);
    }

    #[test]
    fn timeouts_count_up_and_offer_reset_after_two() {
        let a = fold(&HealthSnapshot::default(), &Probe::Timeout, 1);
        assert_eq!(a.state, Health::TimedOut);
        assert_eq!(a.consecutive_failures, 1);
        assert!(!a.needs_reset, "one blip never nags");
        let b = fold(&a, &Probe::Timeout, 2);
        assert!(b.needs_reset);
        let c = fold(&b, &Probe::Down("refused".into()), 3);
        assert_eq!(c.state, Health::Offline);
        assert_eq!(c.consecutive_failures, 3);
        assert!(c.needs_reset);
        assert_eq!(c.detail, "refused");
    }

    #[test]
    fn snapshot_serializes_camel_case_with_snake_states() {
        let s = fold(&HealthSnapshot::default(), &Probe::Timeout, 1);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["state"], "timed_out");
        assert_eq!(v["consecutiveFailures"], 1);
        assert_eq!(v["needsReset"], false);
    }

    #[test]
    fn probe_against_a_closed_port_is_down_not_a_panic() {
        let http = reqwest::Client::new();
        // Port 9 (discard) is closed on a dev box; either a refusal or a timeout is fine.
        let p = tauri::async_runtime::block_on(probe(&http, "http://127.0.0.1:9"));
        assert!(matches!(p, Probe::Down(_) | Probe::Timeout), "{p:?}");
    }
}
