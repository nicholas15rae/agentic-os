//! Hot-reloadable orchestration policy: `<config>/telemetry/orchestrator_policy.json`.
//!
//! Created with the defaults below on first start. A watcher checks the file's mtime every
//! `RELOAD_EVERY`; a valid change is swapped in atomically (readers call [`current`], which is a
//! cheap `Arc` clone) and every registered listener runs. An invalid file is rejected WHOLE: the
//! last good policy stays in force, the reason lands in `policy_status.json` and the always-on
//! event log (`live::event("policy", …)`). Nothing here can panic the app.
//!
//! Schema: docs/proposals/orchestrator-policy-and-live-observer.md. Unknown keys are rejected (a
//! typo must not silently do nothing); missing keys take their defaults.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime};

pub const FILE: &str = "orchestrator_policy.json";
pub const STATUS_FILE: &str = "policy_status.json";
pub const RELOAD_EVERY: Duration = Duration::from_secs(2);

// ── Schema ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Policy {
    pub version: u32,
    pub gpu: GpuPolicy,
    pub circuit_breaker: BreakerPolicy,
    pub trading_hours: TradingHours,
    pub librarian: LibrarianPolicy,
    pub live_observer: LivePolicy,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct GpuPolicy {
    /// Capacity override. None (absent / null, the default) = follow `os.json`
    /// `scheduler.maxConcurrency` (the Settings slider); Some(n) (1–8) = the policy wins over it.
    /// >1 only if the model + KV caches fit in VRAM.
    pub max_concurrent_slots: Option<u8>,
    /// Node id → tier (1 = served first). FIFO inside a tier. Empty map = every node on
    /// `default_tier`, i.e. today's foreground / background behaviour only.
    pub tiers: BTreeMap<String, u8>,
    pub default_tier: u8,
    /// Tier ("1" / "2" / "3") → ms a waiter may queue before a `queue_timeout` alert event. 0 = never.
    /// The job keeps its place: it is reported (deferred), never failed.
    pub queue_timeout_ms: BTreeMap<String, u64>,
    /// A waiting Tier-1 job preempts a running Tier-3 generation (which re-queues itself, exactly
    /// like a background step Tony preempts today).
    pub preempt_tier3_for_tier1: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct BreakerPolicy {
    pub enabled: bool,
    /// A Tier-1 waiter older than this trips the breaker.
    pub tier1_wait_ms: u64,
    /// Minimum time the breaker stays tripped (new Tier-3 acquisitions wait).
    pub hold_ms: u64,
    /// …and it clears only after no Tier-1 waiter for this long.
    pub clear_after_idle_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TradingHours {
    /// Only "America/New_York" is supported (US DST computed in `stagger.rs`, no tz database).
    pub timezone: String,
    /// "HH:MM-HH:MM" in `timezone`.
    pub window: String,
    pub weekdays_only: bool,
    /// No two daemon passes (Observer / Security / Garbage) start closer than this. Always on.
    pub daemon_gap_seconds: u32,
    /// Garbage's scheduled hygiene pass waits for the close (purge handshakes still run).
    pub hold_garbage_hygiene: bool,
    /// During the window: at most this many Tier-3 jobs hold the GPU at once (0 = no extra cap).
    pub tier3_max_concurrent_background: u32,
    /// During the window: minimum spacing between Librarian GPU acquisitions (0 = off).
    pub librarian_min_interval_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct LibrarianPolicy {
    pub packet_max_chars: usize,
    pub item_max_chars: usize,
    pub per_root_hits: usize,
    pub history_hits: usize,
    pub archive_hits: usize,
    pub walk_files_max: usize,
    pub walk_depth: usize,
    pub archive_gz_max_bytes: u64,
    /// None = the caller's own limit, unchanged.
    pub max_output_tokens: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct LivePolicy {
    pub tick_ms: u64,
    pub port: u16,
    pub stream_max_mb: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self { version: 1, gpu: GpuPolicy::default(), circuit_breaker: BreakerPolicy::default(), trading_hours: TradingHours::default(), librarian: LibrarianPolicy::default(), live_observer: LivePolicy::default() }
    }
}

impl Default for GpuPolicy {
    fn default() -> Self {
        let tiers = [("trading", 1), ("tony", 1), ("security", 2), ("observer", 2), ("librarian", 3), ("coder", 3), ("prompter", 3), ("designer", 3), ("director", 3), ("ops", 3), ("bizops", 3)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let queue_timeout_ms = [("1", 0), ("2", 120_000), ("3", 600_000)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        // Single-GPU setup: pinned to 1 by default (an explicit null hands capacity to the Settings slider).
        Self { max_concurrent_slots: Some(1), tiers, default_tier: 3, queue_timeout_ms, preempt_tier3_for_tier1: false }
    }
}

impl Default for BreakerPolicy {
    fn default() -> Self {
        Self { enabled: true, tier1_wait_ms: 1_500, hold_ms: 30_000, clear_after_idle_ms: 5_000 }
    }
}

impl Default for TradingHours {
    fn default() -> Self {
        Self { timezone: "America/New_York".into(), window: "08:00-16:00".into(), weekdays_only: true, daemon_gap_seconds: 90, hold_garbage_hygiene: true, tier3_max_concurrent_background: 0, librarian_min_interval_ms: 0 }
    }
}

impl Default for LibrarianPolicy {
    /// Today's compile-time values in `librarian.rs`.
    fn default() -> Self {
        Self { packet_max_chars: 9_000, item_max_chars: 1_600, per_root_hits: 3, history_hits: 5, archive_hits: 5, walk_files_max: 600, walk_depth: 4, archive_gz_max_bytes: 8 * 1024 * 1024, max_output_tokens: None }
    }
}

impl Default for LivePolicy {
    fn default() -> Self {
        Self { tick_ms: 1_000, port: 8791, stream_max_mb: 50 }
    }
}

// ── Validation (pure) ───────────────────────────────────────────────────────

fn range<T: PartialOrd + std::fmt::Display + Copy>(errs: &mut Vec<String>, name: &str, v: T, lo: T, hi: T) {
    if v < lo || v > hi {
        errs.push(format!("{name} = {v} (allowed {lo}–{hi})"));
    }
}

/// Every reason `p` is unusable (empty = valid). Pure.
pub fn validate(p: &Policy) -> Vec<String> {
    let mut e = vec![];
    if p.version != 1 {
        e.push(format!("version = {} (only 1 is supported)", p.version));
    }
    if let Some(n) = p.gpu.max_concurrent_slots {
        range(&mut e, "gpu.maxConcurrentSlots", n, 1, 8);
    }
    range(&mut e, "gpu.defaultTier", p.gpu.default_tier, 1, 3);
    for (node, t) in &p.gpu.tiers {
        if super::arbiter::node_def(node).is_none() {
            e.push(format!("gpu.tiers: unknown node \"{node}\""));
        }
        range(&mut e, &format!("gpu.tiers.{node}"), *t, 1, 3);
    }
    for (k, v) in &p.gpu.queue_timeout_ms {
        if !["1", "2", "3"].contains(&k.as_str()) {
            e.push(format!("gpu.queueTimeoutMs: key \"{k}\" must be \"1\", \"2\" or \"3\""));
        }
        range(&mut e, &format!("gpu.queueTimeoutMs.{k}"), *v, 0, 3_600_000);
    }
    let b = &p.circuit_breaker;
    range(&mut e, "circuitBreaker.tier1WaitMs", b.tier1_wait_ms, 100, 60_000);
    range(&mut e, "circuitBreaker.holdMs", b.hold_ms, 1_000, 600_000);
    range(&mut e, "circuitBreaker.clearAfterIdleMs", b.clear_after_idle_ms, 500, 600_000);
    let th = &p.trading_hours;
    if th.timezone != "America/New_York" {
        e.push(format!("tradingHours.timezone = \"{}\" (only \"America/New_York\" is supported)", th.timezone));
    }
    if super::stagger::parse_window(&th.window).is_none() {
        e.push(format!("tradingHours.window = \"{}\" (expected \"HH:MM-HH:MM\", start before end)", th.window));
    }
    range(&mut e, "tradingHours.daemonGapSeconds", th.daemon_gap_seconds, 0, 3_600);
    range(&mut e, "tradingHours.tier3MaxConcurrentBackground", th.tier3_max_concurrent_background, 0, 8);
    range(&mut e, "tradingHours.librarianMinIntervalMs", th.librarian_min_interval_ms, 0, 3_600_000);
    let l = &p.librarian;
    range(&mut e, "librarian.packetMaxChars", l.packet_max_chars, 1_000, 40_000);
    range(&mut e, "librarian.itemMaxChars", l.item_max_chars, 200, l.packet_max_chars.max(200));
    range(&mut e, "librarian.perRootHits", l.per_root_hits, 0, 20);
    range(&mut e, "librarian.historyHits", l.history_hits, 0, 20);
    range(&mut e, "librarian.archiveHits", l.archive_hits, 0, 20);
    range(&mut e, "librarian.walkFilesMax", l.walk_files_max, 0, 5_000);
    range(&mut e, "librarian.walkDepth", l.walk_depth, 1, 8);
    range(&mut e, "librarian.archiveGzMaxBytes", l.archive_gz_max_bytes, 0, 64 * 1024 * 1024);
    if let Some(t) = l.max_output_tokens {
        range(&mut e, "librarian.maxOutputTokens", t, 32, 4_096);
    }
    let lv = &p.live_observer;
    range(&mut e, "liveObserver.tickMs", lv.tick_ms, 250, 10_000);
    range(&mut e, "liveObserver.port", lv.port, 1_024, 65_535);
    range(&mut e, "liveObserver.streamMaxMb", lv.stream_max_mb, 1, 1_024);
    e
}

/// Parse + validate a policy file's bytes (pure).
pub fn parse(bytes: &[u8]) -> Result<Policy, Vec<String>> {
    let p: Policy = serde_json::from_slice(bytes).map_err(|e| vec![format!("not valid policy JSON: {e}")])?;
    let errs = validate(&p);
    if errs.is_empty() {
        Ok(p)
    } else {
        Err(errs)
    }
}

impl Policy {
    /// The tier a node is served at (pure).
    pub fn tier_for_node(&self, node: &str) -> u8 {
        self.gpu.tiers.get(node).copied().unwrap_or(self.gpu.default_tier).clamp(1, 3)
    }

    /// The tier a GPU-slot label is served at: diagnostic probes (`diagnostic · probe <node>`) run
    /// at their node's tier so a probe measures what that node would really get; maintenance and
    /// unlabelled system work at `default_tier` (pure).
    pub fn tier_for_label(&self, label: &str) -> u8 {
        let l = label.to_ascii_lowercase();
        if let Some(node) = l.strip_prefix("diagnostic · probe ") {
            return self.tier_for_node(node.split_whitespace().next().unwrap_or(""));
        }
        match super::arbiter::node_for_label(label) {
            Some(n) => self.tier_for_node(n),
            None => self.gpu.default_tier.clamp(1, 3),
        }
    }

    /// Queue-timeout alert threshold for a tier (None = never).
    pub fn queue_timeout(&self, tier: u8) -> Option<Duration> {
        self.gpu.queue_timeout_ms.get(&tier.to_string()).copied().filter(|ms| *ms > 0).map(Duration::from_millis)
    }

    /// Is `utc_ms` inside the trading window (pure)?
    pub fn in_trading_hours(&self, utc_ms: u64) -> bool {
        let th = &self.trading_hours;
        if th.weekdays_only {
            super::stagger::in_market_hours(utc_ms, &th.window)
        } else {
            super::stagger::in_window_any_day(utc_ms, &th.window)
        }
    }
}

// ── Live state + hot reload ─────────────────────────────────────────────────

struct Holder {
    policy: RwLock<Arc<Policy>>,
    root: OnceLock<PathBuf>,
    status: Mutex<Value>,
    listeners: Mutex<Vec<Box<dyn Fn(&Policy) + Send + Sync>>>,
}

fn holder() -> &'static Holder {
    static H: OnceLock<Holder> = OnceLock::new();
    H.get_or_init(|| Holder { policy: RwLock::new(Arc::new(Policy::default())), root: OnceLock::new(), status: Mutex::new(json!({ "state": "defaults", "file": null })), listeners: Mutex::new(vec![]) })
}

/// The policy in force (a cheap `Arc` clone; never blocks on I/O).
pub fn current() -> Arc<Policy> {
    holder().policy.read().map(|p| p.clone()).unwrap_or_else(|_| Arc::new(Policy::default()))
}

/// `<config>/telemetry` (None until `init`).
pub fn telemetry_root() -> Option<&'static Path> {
    holder().root.get().map(|p| p.as_path())
}

/// Run `f` now with the current policy and after every applied change (capacity, etc.).
pub fn on_change(f: impl Fn(&Policy) + Send + Sync + 'static) {
    f(&current());
    holder().listeners.lock().unwrap().push(Box::new(f));
}

/// The load / reject state (`policy_status.json`).
pub fn status() -> Value {
    holder().status.lock().unwrap().clone()
}

/// Swap in a validated policy, notify listeners (pure state change; used by reload + tests).
pub fn apply(p: Policy) {
    let p = Arc::new(p);
    if let Ok(mut w) = holder().policy.write() {
        *w = p.clone();
    }
    for f in holder().listeners.lock().unwrap().iter() {
        f(&p);
    }
}

fn set_status(v: Value) {
    if let Some(root) = telemetry_root() {
        let _ = super::staging::atomic_write(&root.join(STATUS_FILE), &serde_json::to_vec_pretty(&v).unwrap_or_default());
    }
    *holder().status.lock().unwrap() = v;
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Load the file once: apply it, or keep the current policy and record why not.
fn load(path: &Path) {
    let now = super::arbiter::now_ms();
    match std::fs::read(path).map_err(|e| vec![e.to_string()]).and_then(|b| parse(&b)) {
        Ok(p) => {
            let changed = *current() != p;
            apply(p);
            set_status(json!({ "state": "applied", "file": path.display().to_string(), "at": now }));
            if changed {
                super::live::event("policy", json!({ "action": "applied", "file": path.display().to_string() }));
            }
        }
        Err(errs) => {
            set_status(json!({ "state": "rejected", "file": path.display().to_string(), "at": now, "errors": errs, "inForce": "last good policy" }));
            super::live::event("policy", json!({ "action": "rejected", "errors": errs }));
        }
    }
}

/// `<config dir>/telemetry/orchestrator_policy.json`: write the defaults if absent, load it, then
/// watch it (lib.rs setup).
pub fn init(config_dir: &Path) {
    let root = config_dir.join("telemetry");
    let _ = std::fs::create_dir_all(&root);
    let _ = holder().root.set(root.clone());
    let path = root.join(FILE);
    if !path.exists() {
        let _ = super::staging::atomic_write(&path, &serde_json::to_vec_pretty(&Policy::default()).unwrap_or_default());
    }
    load(&path);
    tauri::async_runtime::spawn(async move {
        let mut seen = mtime(&path);
        loop {
            tokio::time::sleep(RELOAD_EVERY).await;
            let m = mtime(&path);
            if m != seen {
                seen = m;
                if m.is_some() {
                    load(&path);
                } else {
                    set_status(json!({ "state": "missing", "file": path.display().to_string(), "inForce": "last good policy" }));
                }
            }
        }
    });
}

#[tauri::command]
pub fn policy_get() -> Value {
    let p = current();
    json!({ "policy": *p, "status": status(), "file": telemetry_root().map(|r| r.join(FILE).display().to_string()), "mode": mode_of(&p), "modes": MODES.iter().map(|m| m.id).collect::<Vec<_>>() })
}

// ── Orchestration modes (the Schematic panel's selector) ─────────────────────

/// One selectable orchestration profile. Add a row to offer a new one; a mode only sets the keys
/// it owns and pins `gpu.maxConcurrentSlots` to 1 (single-GPU setup: multi-slot is never exposed).
pub struct Mode {
    pub id: &'static str,
    pub preempt_tier3_for_tier1: bool,
}

pub const MODES: [Mode; 2] = [
    // Tier-1 Trading jobs preempt running Tier-3 generations; Tony is never preempted.
    Mode { id: "trading_priority", preempt_tier3_for_tier1: true },
    // Fair queueing: running Tier-3 coding / research jobs are never interrupted.
    Mode { id: "build_balanced", preempt_tier3_for_tier1: false },
];

/// The mode a policy is in (pure). Anything that matches no row reads as "custom".
pub fn mode_of(p: &Policy) -> &'static str {
    MODES.iter().find(|m| m.preempt_tier3_for_tier1 == p.gpu.preempt_tier3_for_tier1 && p.gpu.max_concurrent_slots == Some(1)).map_or("custom", |m| m.id)
}

/// `base` switched to `mode`, every other key untouched (pure).
pub fn with_mode(base: &Policy, mode: &str) -> Result<Policy, String> {
    let m = MODES.iter().find(|m| m.id == mode).ok_or_else(|| format!("unknown orchestration mode \"{mode}\""))?;
    let mut p = base.clone();
    p.gpu.preempt_tier3_for_tier1 = m.preempt_tier3_for_tier1;
    p.gpu.max_concurrent_slots = Some(1);
    let errs = validate(&p);
    if errs.is_empty() {
        Ok(p)
    } else {
        Err(errs.join("; "))
    }
}

/// Switch the orchestration mode: rewrite `orchestrator_policy.json` (atomic) and apply it at once
/// (the file watcher would within `RELOAD_EVERY` anyway). The base is the FILE as it stands, so
/// hand edits are kept; a file that currently fails validation is never overwritten (that would
/// throw away an edit in progress) — fix it first. The change is logged in `events.jsonl`.
#[tauri::command]
pub fn policy_set_mode(mode: String) -> Result<Value, String> {
    let root = telemetry_root().ok_or("telemetry folder not initialised")?;
    let path = root.join(FILE);
    let base = match std::fs::read(&path) {
        Ok(b) => parse(&b).map_err(|errs| format!("orchestrator_policy.json is currently rejected ({}); fix it before switching modes", errs.join("; ")))?,
        // Only a missing file falls back to the policy in memory; any other read error (a lock, access
        // denied) refuses, so a just-saved hand edit the watcher hasn't loaded can't be overwritten.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (*current()).clone(),
        Err(e) => return Err(format!("cannot read orchestrator_policy.json ({e}); try again")),
    };
    let next = with_mode(&base, &mode)?;
    let from = mode_of(&base);
    super::staging::atomic_write(&path, &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?)?;
    load(&path);
    super::live::event("policy", json!({ "action": "mode", "from": from, "to": mode_of(&current()) }));
    Ok(policy_get())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_round_trip() {
        let p = Policy::default();
        assert!(validate(&p).is_empty(), "{:?}", validate(&p));
        let bytes = serde_json::to_vec(&p).unwrap();
        assert_eq!(parse(&bytes).unwrap(), p);
    }

    #[test]
    fn partial_files_take_defaults_and_typos_are_rejected() {
        let p = parse(br#"{"version":1,"circuitBreaker":{"tier1WaitMs":2000}}"#).unwrap();
        assert_eq!(p.circuit_breaker.tier1_wait_ms, 2000);
        assert_eq!(p.circuit_breaker.hold_ms, 30_000);
        assert_eq!(p.gpu, GpuPolicy::default());
        assert!(parse(br#"{"version":1,"circuitBreaker":{"tier1WaitMS":2000}}"#).is_err());
        assert!(parse(b"{ not json").is_err());
    }

    #[test]
    fn out_of_range_values_are_named() {
        let mut p = Policy::default();
        p.gpu.max_concurrent_slots = Some(9);
        p.gpu.tiers.insert("nobody".into(), 1);
        p.trading_hours.window = "16:00-08:00".into();
        p.librarian.item_max_chars = 50_000;
        let e = validate(&p).join("\n");
        assert!(e.contains("maxConcurrentSlots"), "{e}");
        assert!(e.contains("unknown node \"nobody\""), "{e}");
        assert!(e.contains("tradingHours.window"), "{e}");
        assert!(e.contains("librarian.itemMaxChars"), "{e}");
    }

    #[test]
    fn max_concurrent_slots_is_an_optional_override() {
        assert_eq!(Policy::default().gpu.max_concurrent_slots, Some(1), "default: pinned to the single GPU slot");
        assert_eq!(parse(br#"{"version":1,"gpu":{}}"#).unwrap().gpu.max_concurrent_slots, Some(1), "absent = the default");
        assert_eq!(mode_of(&Policy::default()), "build_balanced", "an untouched default file reads as a mode, not custom");
        assert_eq!(parse(br#"{"version":1,"gpu":{"maxConcurrentSlots":null}}"#).unwrap().gpu.max_concurrent_slots, None, "null");
        assert_eq!(parse(br#"{"version":1,"gpu":{"maxConcurrentSlots":1}}"#).unwrap().gpu.max_concurrent_slots, Some(1));
        assert_eq!(parse(br#"{"version":1,"gpu":{"maxConcurrentSlots":8}}"#).unwrap().gpu.max_concurrent_slots, Some(8));
        for bad in [0u8, 9] {
            let mut p = Policy::default();
            p.gpu.max_concurrent_slots = Some(bad);
            assert!(validate(&p).join("\n").contains("gpu.maxConcurrentSlots"), "{bad} must be rejected");
        }
    }

    #[test]
    fn modes_switch_only_their_keys_and_pin_one_slot() {
        let mut base = Policy::default();
        base.circuit_breaker.tier1_wait_ms = 2_500; // a hand edit that must survive
        base.gpu.max_concurrent_slots = Some(4);
        assert_eq!(mode_of(&base), "custom");
        let t = with_mode(&base, "trading_priority").unwrap();
        assert!(t.gpu.preempt_tier3_for_tier1);
        assert_eq!(t.gpu.max_concurrent_slots, Some(1));
        assert_eq!(t.circuit_breaker.tier1_wait_ms, 2_500);
        assert_eq!(mode_of(&t), "trading_priority");
        let b = with_mode(&t, "build_balanced").unwrap();
        assert!(!b.gpu.preempt_tier3_for_tier1);
        assert_eq!(mode_of(&b), "build_balanced");
        assert!(with_mode(&base, "turbo").unwrap_err().contains("unknown orchestration mode"));
        // A base that is already invalid can't be "fixed" by a mode switch.
        let mut bad = Policy::default();
        bad.trading_hours.window = "nope".into();
        assert!(with_mode(&bad, "build_balanced").is_err());
        assert_eq!(MODES.map(|m| m.id), ["trading_priority", "build_balanced"]);
    }

    #[test]
    fn tiers_for_nodes_and_labels() {
        let p = Policy::default();
        assert_eq!(p.tier_for_node("trading"), 1);
        assert_eq!(p.tier_for_node("librarian"), 3);
        assert_eq!(p.tier_for_node("garbage"), 3);
        assert_eq!(p.tier_for_label("lmstudio · Tony"), 1);
        assert_eq!(p.tier_for_label("worker · coder code · lmstudio"), 3);
        assert_eq!(p.tier_for_label("diagnostic · probe trading"), 1);
        assert_eq!(p.tier_for_label("diagnostic · probe librarian"), 3);
        assert_eq!(p.tier_for_label("maintenance · reload"), 3);
        assert_eq!(p.queue_timeout(1), None);
        assert_eq!(p.queue_timeout(2), Some(Duration::from_secs(120)));
    }
}
