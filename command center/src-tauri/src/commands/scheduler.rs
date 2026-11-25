//! "Tony-First" GPU slot scheduler ("baton pass").
//!
//! A 12 GB card can run one generation well; two at once both crawl (and
//! AnythingLLM + LM Studio + verifier calls used to collide). Every call that
//! runs on the local GPU takes a slot here:
//!
//!   foreground (Tony's turn, a sub-agent you're waiting on) → front of the line
//!   background (pipeline stages, verifier, memory condense)  → waits while any
//!       foreground request is queued; after `bg_max_wait` it runs anyway, so a
//!       90 % Tony-priority split still lets 10 % of the time go to the queue.
//!
//! `max_concurrency` = slots (1 on the 3060; raise it on a bigger server), unless the policy's
//! `gpu.maxConcurrentSlots` overrides it.
//! The live state is emitted as `gpu-slot` for the top-bar pill.
//!
//! Hot-potato additions (the compute arbiter, `arbiter.rs`):
//! - **Preemption**: a background holder races its call against [`SlotGuard::preempted`], which
//!   fires the moment Tony queues. The worker parks that stage and resumes it later, so Tony never
//!   waits behind a long Coder generation.
//! - **Away Mode** (`set_away`): Tony gives up his foreground reservation. A caller that asked
//!   for foreground queues as background at `gpu.defaultTier` (not its label tier), so it neither
//!   overtakes the queue nor trips the breaker: callers are served first-come-first-served, except
//!   that genuinely Tier-1 background nodes (trading) keep their tier ordering. Background never
//!   yields to Tony and is never preempted.
//! - The view names who is waiting (`waiting`), so the System Map can show `QUEUED` nodes.
//!
//! Tiered admission (`orchestrator_policy.json`, `policy.rs`), layered on top of all of the above:
//! - Every waiter / holder carries `tier = policy.tier_for_label(label)` (Away Mode foreground:
//!   `defaultTier`) and when it queued.
//! - Diagnostic probes (`diagnostic · probe <node>`) queue at their node's tier for ordering but
//!   never change real state: the breaker, Tier-1 p95, Librarian spacing, preemption and the Tony
//!   baton ignore them.
//! - **Ordering**: a waiter that wins a permit while a strictly better tier is queued (and not held
//!   by a gate) hands it back and retries — the same polite drop-and-retry as the Tony baton — so
//!   the better tier is served first; FIFO inside a tier. Foreground keeps its priority: a
//!   foreground waiter only yields to a better-tier FOREGROUND waiter, and gates never hold it.
//! - **Circuit breaker**: a Tier-1 waiter older than `tier1WaitMs` trips it; while tripped,
//!   background Tier-3 acquisitions don't take a permit (`defer` event). It clears once `holdMs`
//!   have passed since the trip AND no Tier-1 waiter was seen for `clearAfterIdleMs`. Evaluated
//!   lazily by waiters' own loops, new acquisitions and `detail()` — no extra thread.
//! - **Queue timeout**: a waiter older than its tier's `queueTimeoutMs` emits ONE `queue_timeout`
//!   event and keeps waiting (deferred, never failed).
//! - `preemptTier3ForTier1`: a queued Tier-1 fires the preempt signal for Tier-3 background holders.
//! - Trading hours: `tier3MaxConcurrentBackground` caps concurrent Tier-3 holders;
//!   `librarianMinIntervalMs` spaces Librarian acquisitions.
//!
//! With every node on one tier (or `gpu.tiers` empty and nothing gated), behaviour is exactly the
//! foreground / background baton above.

use super::policy::{self, Policy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SchedulerConfig {
    /// "sequential" (12 GB, Tony priority) | "hybrid" (local + cloud/CLI) | "parallel" (big GPU / server).
    pub profile: String,
    /// Slider 1: share of GPU time reserved for Tony's fast path (50–100).
    pub tony_priority_pct: u8,
    /// Simultaneous local generations.
    pub max_concurrency: u8,
    /// Slider 2: how aggressively heavy steps (coding, design) go to cloud/CLI (0 = never, 100 = always).
    pub offload_pct: u8,
    /// Engine for offloaded steps: "claude-cli" | "gemini-cli" | "llm-cli" | "claude-api" | "gemini-api" | "droplet".
    pub offload_engine: String,
    /// Rolling chat history sent with each Tony turn.
    pub history_turns: u8,
    /// Part 3: after a holder times out or is cancelled the server may still be generating, so
    /// the permit is kept this long before the next holder runs (capped at 120 s).
    pub settle_secs: u16,
    /// Away Mode ("red button"): Tony yields his foreground reservation and background work gets
    /// the GPU (see `arbiter::set_away`). Persisted so an overnight run survives a restart.
    pub away_mode: bool,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self { profile: "sequential".into(), tony_priority_pct: 90, max_concurrency: 1, offload_pct: 0, offload_engine: "claude-cli".into(), history_turns: 6, settle_secs: DEFAULT_SETTLE_SECS, away_mode: false }
    }
}

/// Default settle window after a timed-out / cancelled holder.
pub const DEFAULT_SETTLE_SECS: u16 = 20;

impl SchedulerConfig {
    pub fn settle(&self) -> Duration {
        Duration::from_secs(self.settle_secs.min(120) as u64)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub active: Vec<String>,
    pub queued_foreground: usize,
    pub queued_background: usize,
    pub capacity: usize,
    /// Permits held back after a timed-out / cancelled holder (the server may still be busy).
    pub settling: usize,
    /// Labels of the callers queued for a permit, oldest first.
    pub waiting: Vec<String>,
    /// Away Mode: no foreground reservation (Tony queues like everyone else).
    pub away: bool,
}

/// One holder or waiter in [`SlotDetail`]. `ms` = held for (holders) / waiting for (waiters).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SlotEntry {
    pub label: String,
    pub node: Option<String>,
    pub tier: u8,
    pub ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BreakerView {
    pub tripped: bool,
    pub since_ms_ago: Option<u64>,
    pub trips: u64,
    pub last_reason: Option<String>,
}

/// The tier-aware slot state (Live Observer, lease API `GET /arbiter/state`, diagnostics reports).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SlotDetail {
    pub capacity: usize,
    pub settling: usize,
    pub holders: Vec<SlotEntry>,
    pub waiters: Vec<SlotEntry>,
    pub breaker: BreakerView,
    pub tier1_wait_p95_ms: Option<u64>,
}

/// What the gateway's cooperative lease (`PUT /api/os/gpu`) mirrors.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct GpuLease {
    pub busy: bool,
    pub holder: String,
    /// Epoch ms the lease may be assumed to end (the gateway caps it at 15 min).
    pub until: Option<u64>,
}

/// A held permit's lease hint: the longest stage timeout plus the settle window.
const LEASE_HINT_MS: u64 = 660_000;
/// A waiter blocked on the semaphore re-evaluates the breaker / queue timeout this often.
const TICK: Duration = Duration::from_millis(200);
/// A gated waiter (breaker / tier-3 cap / Librarian spacing) re-checks its gate this often.
const GATE_POLL: Duration = Duration::from_millis(100);
/// Back-off after politely handing a won permit back (Tony baton / better tier).
const BATON_BACKOFF: Duration = Duration::from_millis(80);
/// Rolling window of Tier-1 waits behind `tier1_wait_p95_ms`.
const TIER1_WINDOW: usize = 64;

pub const DEFER_BREAKER: &str = "breaker";
pub const DEFER_TIER3_CAP: &str = "tier3_cap";
pub const DEFER_LIBRARIAN: &str = "librarian_interval";

type Notify = Box<dyn Fn(SlotView) + Send + Sync>;

/// Poison-tolerant lock (a panicked holder elsewhere must not take the scheduler down).
fn lk<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn ms(d: Duration) -> u64 {
    d.as_millis().min(u64::MAX as u128) as u64
}

/// Labels in telemetry are capped (labels and numbers only, never payloads).
fn short(label: &str) -> String {
    label.chars().take(80).collect()
}

/// The node a slot label belongs to: a diagnostic probe's node, else `arbiter::node_for_label`.
pub(crate) fn node_of(label: &str) -> Option<String> {
    let l = label.to_ascii_lowercase();
    if let Some(rest) = l.strip_prefix("diagnostic · probe ") {
        return rest.split_whitespace().next().filter(|n| !n.is_empty()).map(str::to_string);
    }
    super::arbiter::node_for_label(label).map(str::to_string)
}

/// A diagnostic probe (`diagnostic · probe <node>`): it queues at its node's tier (ordering) but
/// never touches real scheduling state — breaker, Tier-1 p95, Librarian spacing, preemption and
/// the Tony baton ignore it.
fn is_diagnostic(label: &str) -> bool {
    label.to_ascii_lowercase().starts_with("diagnostic · probe ")
}

/// A holder (in `active`) or a waiter (in `waiting`).
#[derive(Clone, Debug)]
struct Entry {
    id: u64,
    label: String,
    node: Option<String>,
    tier: u8,
    since: Instant,
    foreground: bool,
    /// A diagnostic probe (see [`is_diagnostic`]).
    diagnostic: bool,
    /// Waiters only: held by a gate, so not contending (nobody yields to it).
    gated: bool,
    /// Waiters only: handed a won permit back to a better tier. It keeps its seniority: newer
    /// same-tier waiters let it go first (the back-off timers alone don't keep FIFO order).
    yielded: bool,
}

impl Entry {
    fn view(&self, now: Instant) -> SlotEntry {
        SlotEntry { label: self.label.clone(), node: self.node.clone(), tier: self.tier, ms: ms(now.saturating_duration_since(self.since)) }
    }
}

// ── Circuit breaker (pure state machine) ────────────────────────────────────

#[derive(Debug, PartialEq)]
enum BreakerChange {
    Tripped { waiter: String, wait_ms: u64 },
    Cleared { held_ms: u64 },
}

#[derive(Default, Debug)]
struct Breaker {
    tripped_at: Option<Instant>,
    trips: u64,
    last_reason: Option<String>,
    /// The last moment a Tier-1 waiter was known to be queued.
    last_tier1_seen: Option<Instant>,
}

impl Breaker {
    fn tripped(&self) -> bool {
        self.tripped_at.is_some()
    }

    fn saw_tier1(&mut self, now: Instant) {
        if self.last_tier1_seen.is_none_or(|s| s < now) {
            self.last_tier1_seen = Some(now);
        }
    }

    /// `oldest_tier1`: the longest-waiting Tier-1 waiter right now (label, wait). Pure.
    fn evaluate(&mut self, now: Instant, oldest_tier1: Option<(&str, Duration)>, p: &policy::BreakerPolicy) -> Option<BreakerChange> {
        if oldest_tier1.is_some() {
            self.saw_tier1(now);
        }
        match self.tripped_at {
            Some(at) => {
                let hold = Duration::from_millis(p.hold_ms);
                let idle = Duration::from_millis(p.clear_after_idle_ms);
                let held = now.saturating_duration_since(at);
                let quiet = oldest_tier1.is_none() && self.last_tier1_seen.is_none_or(|s| now.saturating_duration_since(s) >= idle);
                if !p.enabled || (held >= hold && quiet) {
                    self.tripped_at = None;
                    // Report when it really became clearable (a lazy evaluation can come later).
                    let effective = if p.enabled { (at + hold).max(self.last_tier1_seen.map_or(at, |s| s + idle)).min(now) } else { now };
                    return Some(BreakerChange::Cleared { held_ms: ms(effective.saturating_duration_since(at)) });
                }
                None
            }
            None => {
                let (waiter, wait) = oldest_tier1?;
                if p.enabled && wait > Duration::from_millis(p.tier1_wait_ms) {
                    self.tripped_at = Some(now);
                    self.trips += 1;
                    self.last_reason = Some(format!("tier-1 waiter \"{}\" waited {} ms", short(waiter), ms(wait)));
                    return Some(BreakerChange::Tripped { waiter: short(waiter), wait_ms: ms(wait) });
                }
                None
            }
        }
    }
}

// ── Gates (pure) ────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Copy)]
struct GateState {
    breaker_tripped: bool,
    tier3_holders: usize,
    since_last_librarian: Option<Duration>,
    in_hours: bool,
}

/// Do the trading-hours gates apply at all (so the clock is only read when they could)?
fn needs_hours(p: &Policy) -> bool {
    p.trading_hours.tier3_max_concurrent_background > 0 || p.trading_hours.librarian_min_interval_ms > 0
}

/// Why this acquisition must not take a permit right now (None = admit). Pure.
fn gate_for(p: &Policy, tier: u8, foreground: bool, librarian: bool, s: &GateState) -> Option<&'static str> {
    if foreground {
        return None;
    }
    if tier >= 3 && s.breaker_tripped && p.circuit_breaker.enabled {
        return Some(DEFER_BREAKER);
    }
    if s.in_hours {
        let th = &p.trading_hours;
        let cap = th.tier3_max_concurrent_background as usize;
        if tier >= 3 && cap > 0 && s.tier3_holders >= cap {
            return Some(DEFER_TIER3_CAP);
        }
        let gap = Duration::from_millis(th.librarian_min_interval_ms);
        if librarian && !gap.is_zero() && s.since_last_librarian.is_some_and(|d| d < gap) {
            return Some(DEFER_LIBRARIAN);
        }
    }
    None
}

/// p95 of a latency window (pure).
fn p95(v: &VecDeque<u64>) -> Option<u64> {
    if v.is_empty() {
        return None;
    }
    let mut s: Vec<u64> = v.iter().copied().collect();
    s.sort_unstable();
    Some(s[((s.len() - 1) as f64 * 0.95).round() as usize])
}

#[derive(Default)]
struct Admission {
    breaker: Breaker,
    tier1_waits: VecDeque<u64>,
    last_librarian: Option<Instant>,
}

#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    /// Per-slot policy (tests never touch the process-wide one).
    policy: Option<Arc<Policy>>,
    /// Force "inside / outside trading hours".
    in_hours: Option<bool>,
}

/// Telemetry (`live::event`); tests also capture it. Never called with a scheduler lock held.
fn emit_event(kind: &str, payload: Value) {
    capture_event(kind, &payload);
    super::live::event(kind, payload);
}

#[cfg(test)]
fn captured() -> &'static Mutex<Vec<(String, Value)>> {
    static C: std::sync::OnceLock<Mutex<Vec<(String, Value)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(vec![]))
}

#[cfg(test)]
fn capture_event(kind: &str, payload: &Value) {
    lk(captured()).push((kind.to_string(), payload.clone()));
}

#[cfg(not(test))]
fn capture_event(_kind: &str, _payload: &Value) {}

struct Inner {
    sem: Arc<Semaphore>,
    capacity: AtomicUsize,
    fg_waiting: AtomicUsize,
    bg_waiting: AtomicUsize,
    settling: AtomicUsize,
    active: Mutex<Vec<Entry>>,
    waiting: Mutex<Vec<Entry>>,
    next_id: AtomicUsize,
    away: AtomicBool,
    /// Woken when a foreground (or Tier-1) caller queues: background holders racing `preempted()` stop.
    preempt: tokio::sync::Notify,
    /// Publishes slot changes (wired to the `gpu-slot` event in lib.rs). A plain callback
    /// keeps the window runtime out of this module (and its unit tests).
    notify: Mutex<Option<Notify>>,
    /// Latest lease for the gateway mirror. Sending never blocks; the consumer
    /// (`gpu_mirror_loop`) always sends the newest value, in order.
    lease: tokio::sync::watch::Sender<GpuLease>,
    /// Breaker, Tier-1 wait window, Librarian spacing. Lock order: `active` → `adm` (the only
    /// nested pair); `waiting` is never held together with either.
    adm: Mutex<Admission>,
    /// The policy's `gpu.maxConcurrentSlots` override (0 = none: not installed, or the policy says
    /// None). While set it wins over `set_capacity` callers.
    policy_cap: AtomicUsize,
    /// The last `set_capacity` value (os.json `scheduler.maxConcurrency`), restored when the
    /// policy override goes back to None.
    config_cap: AtomicUsize,
    /// Permits a shrink could not take back yet (they were held): forgotten as holders release.
    owed: AtomicUsize,
    /// Serializes capacity decisions (Settings save vs policy reload).
    cap_lock: Mutex<()>,
    /// Woken on every capacity decision (maintenance re-checks how many permits it still needs).
    cap_changed: tokio::sync::Notify,
    #[cfg(test)]
    hooks: Mutex<TestHooks>,
}

pub struct GpuSlot {
    inner: Arc<Inner>,
}

impl Default for GpuSlot {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                sem: Arc::new(Semaphore::new(1)),
                capacity: AtomicUsize::new(1),
                fg_waiting: AtomicUsize::new(0),
                bg_waiting: AtomicUsize::new(0),
                settling: AtomicUsize::new(0),
                active: Mutex::new(vec![]),
                waiting: Mutex::new(vec![]),
                next_id: AtomicUsize::new(1),
                away: AtomicBool::new(false),
                preempt: tokio::sync::Notify::new(),
                notify: Mutex::new(None),
                lease: tokio::sync::watch::channel(GpuLease::default()).0,
                adm: Mutex::new(Admission::default()),
                policy_cap: AtomicUsize::new(0),
                config_cap: AtomicUsize::new(1),
                owed: AtomicUsize::new(0),
                cap_lock: Mutex::new(()),
                cap_changed: tokio::sync::Notify::new(),
                #[cfg(test)]
                hooks: Mutex::new(TestHooks::default()),
            }),
        }
    }
}

/// A held GPU slot. Dropping it releases the permit at once, unless `arm_settle` was called
/// and `disarm` wasn't (a timeout, an error mid-generation, or the future being cancelled):
/// then the permit is kept for the settle window, so the next holder doesn't run alongside a
/// generation the server is still finishing.
pub struct SlotGuard {
    inner: Arc<Inner>,
    id: u64,
    permit: Option<OwnedSemaphorePermit>,
    settle: Option<Duration>,
    #[cfg_attr(not(test), allow(dead_code))]
    foreground: bool,
    tier: u8,
}

/// The error text a preempted background call returns (the worker parks the stage on it).
pub const PREEMPTED: &str = "PREEMPTED";

/// Does this error mean "a foreground turn took the GPU; run it again later"?
pub fn is_preempted(err: &str) -> bool {
    err.contains(PREEMPTED)
}

impl SlotGuard {
    /// Resolves when Tony queues for the GPU while this BACKGROUND holder runs (never for a
    /// foreground holder, never in Away Mode) — or, with `preemptTier3ForTier1`, when a Tier-1
    /// caller queues while this is a Tier-3 holder. Race the model call against it with
    /// `select!`; dropping the request makes LM Studio stop generating.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn preempted(&self) {
        if self.foreground {
            return std::future::pending().await;
        }
        wait_preempt(self.inner.clone(), Some(self.id)).await
    }

    /// Keep the permit for `settle` if this guard is dropped before `disarm`.
    pub fn arm_settle(&mut self, settle: Duration) {
        self.settle = (!settle.is_zero()).then_some(settle);
    }

    /// The call finished cleanly (the server is idle): release immediately on drop.
    pub fn disarm(&mut self) {
        self.settle = None;
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn settle_armed(&self) -> bool {
        self.settle.is_some()
    }

    /// The tier this holder was admitted at.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn tier(&self) -> u8 {
        self.tier
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        lk(&self.inner.active).retain(|e| e.id != self.id);
        match (self.settle.take(), self.permit.take()) {
            (Some(d), Some(permit)) => {
                self.inner.settling.fetch_add(1, Ordering::SeqCst);
                Inner::emit(&self.inner);
                let inner = self.inner.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(d).await;
                    // Count down before the permit goes: the next holder must never see its own
                    // acquisition while `settling` still reads 1 (a race under load).
                    inner.settling.fetch_sub(1, Ordering::SeqCst);
                    inner.release(permit);
                    Inner::emit(&inner);
                });
            }
            (_, permit) => {
                if let Some(p) = permit {
                    self.inner.release(p);
                }
                Inner::emit(&self.inner);
            }
        }
    }
}

/// One queued waiter (`fg_waiting` / `bg_waiting`). Cancel-safe: if the acquiring future is dropped
/// before it gets a permit (e.g. `tokio::time::timeout` around `acquire`), the count is given back
/// on drop, so a phantom waiter can never keep `is_idle()` false for good.
struct WaitTicket {
    inner: Arc<Inner>,
    foreground: bool,
    armed: bool,
    id: u64,
    label: String,
    tier: u8,
    librarian: bool,
    diagnostic: bool,
    since: Instant,
    gated: bool,
    timeout_reported: bool,
    deferred: Vec<&'static str>,
    /// Asked for foreground but Away Mode queued it FIFO: still never held by the Tier-3 gates.
    gate_exempt: bool,
}

impl WaitTicket {
    fn new(inner: &Arc<Inner>, foreground: bool, label: &str, tier: u8) -> Self {
        let id = inner.next_id.fetch_add(1, Ordering::SeqCst) as u64;
        let node = node_of(label);
        let librarian = node.as_deref() == Some("librarian");
        let diagnostic = is_diagnostic(label);
        let since = Instant::now();
        lk(&inner.waiting).push(Entry { id, label: label.to_string(), node, tier, since, foreground, diagnostic, gated: false, yielded: false });
        Self::counter(inner, foreground).fetch_add(1, Ordering::SeqCst);
        Inner::emit(inner);
        if (foreground || tier == 1) && !diagnostic {
            inner.preempt.notify_waiters();
        }
        Self { inner: inner.clone(), foreground, armed: true, id, label: label.to_string(), tier, librarian, diagnostic, since, gated: false, timeout_reported: false, deferred: vec![], gate_exempt: false }
    }

    fn counter(inner: &Inner, foreground: bool) -> &AtomicUsize {
        if foreground {
            &inner.fg_waiting
        } else {
            &inner.bg_waiting
        }
    }

    /// Mark this waiter held by a gate (not contending) or back in the race.
    fn set_gated(&mut self, on: bool) {
        if self.gated == on {
            return;
        }
        self.gated = on;
        if let Some(e) = lk(&self.inner.waiting).iter_mut().find(|e| e.id == self.id) {
            e.gated = on;
        }
        if !on && self.tier == 1 && !self.diagnostic {
            self.inner.preempt.notify_waiters();
        }
    }

    /// This waiter handed a permit back to a better tier (keeps its place in its tier).
    fn set_yielded(&mut self) {
        if let Some(e) = lk(&self.inner.waiting).iter_mut().find(|e| e.id == self.id) {
            e.yielded = true;
        }
    }

    /// Leave the queue (once). Returns whether it was still queued.
    fn release(&mut self) -> bool {
        if !self.armed {
            return false;
        }
        self.armed = false;
        lk(&self.inner.waiting).retain(|e| e.id != self.id);
        Self::counter(&self.inner, self.foreground).fetch_sub(1, Ordering::SeqCst);
        if self.tier == 1 && !self.diagnostic {
            lk(&self.inner.adm).breaker.saw_tier1(Instant::now());
        }
        true
    }

    /// Got the permit: count down without an emit (the guard that follows emits the new holder).
    fn done(&mut self) {
        self.release();
    }
}

impl Drop for WaitTicket {
    fn drop(&mut self) {
        if self.release() {
            Inner::emit(&self.inner);
        }
    }
}

impl Inner {
    fn view(&self) -> SlotView {
        SlotView {
            active: lk(&self.active).iter().map(|e| e.label.clone()).collect(),
            queued_foreground: self.fg_waiting.load(Ordering::SeqCst),
            queued_background: self.bg_waiting.load(Ordering::SeqCst),
            capacity: self.capacity.load(Ordering::SeqCst),
            settling: self.settling.load(Ordering::SeqCst),
            waiting: lk(&self.waiting).iter().map(|e| e.label.clone()).collect(),
            away: self.away.load(Ordering::SeqCst),
        }
    }

    fn emit(this: &Arc<Inner>) {
        let view = this.view();
        let lease = lease_for(&view, now_ms());
        this.lease.send_if_modified(|cur| {
            // Only busy flips and holder changes are mirrored; `until` alone never re-sends.
            if cur.busy != lease.busy || cur.holder != lease.holder {
                *cur = lease;
                true
            } else {
                false
            }
        });
        if let Some(f) = lk(&this.notify).as_ref() {
            f(view);
        }
    }

    #[cfg(test)]
    fn hook_policy(&self) -> Option<Arc<Policy>> {
        lk(&self.hooks).policy.clone()
    }

    #[cfg(not(test))]
    fn hook_policy(&self) -> Option<Arc<Policy>> {
        None
    }

    #[cfg(test)]
    fn hook_hours(&self) -> Option<bool> {
        lk(&self.hooks).in_hours
    }

    #[cfg(not(test))]
    fn hook_hours(&self) -> Option<bool> {
        None
    }

    /// The policy this slot admits by (a cheap `Arc` clone).
    fn policy(&self) -> Arc<Policy> {
        self.hook_policy().unwrap_or_else(policy::current)
    }

    fn in_trading_hours(&self, p: &Policy) -> bool {
        self.hook_hours().unwrap_or_else(|| p.in_trading_hours(now_ms()))
    }

    /// Resize the semaphore to `n` permits. Returns whether the capacity changed (no emit).
    fn apply_capacity(&self, n: usize) -> bool {
        let n = n.clamp(1, 8);
        let cur = self.capacity.swap(n, Ordering::SeqCst);
        if n > cur {
            // Growing first cancels any shrink still owed.
            let grow = n - cur;
            // Atomic: a concurrent release may be paying the same debt.
            let prev = self.owed.try_update(Ordering::SeqCst, Ordering::SeqCst, |o| Some(o - o.min(grow))).unwrap_or(0);
            self.sem.add_permits(grow - prev.min(grow));
        } else if n < cur {
            // Only available permits can be forgotten; the rest are owed and forgotten on release,
            // so a shrink while generations run can never leave extra permits behind.
            // Record the debt BEFORE forgetting, so a release racing this shrink always sees it;
            // each forgotten permit then settles one unit (if a release already paid that unit, the
            // permit goes back instead).
            let want = cur - n;
            self.owed.fetch_add(want, Ordering::SeqCst);
            let got = self.sem.forget_permits(want);
            for _ in 0..got {
                if !self.take_debt() {
                    self.sem.add_permits(1);
                }
            }
        }
        n != cur
    }

    /// Take one unit of shrink debt, atomically (false = nothing owed).
    fn take_debt(&self) -> bool {
        self.owed.try_update(Ordering::SeqCst, Ordering::SeqCst, |o| o.checked_sub(1)).is_ok()
    }

    /// The ONLY way a permit goes back: each owed unit forgets one of its permits first, so a
    /// released permit can never reach a queued waiter while a shrink is still owed (tokio hands a
    /// released permit straight to the head of its queue). Concurrent releases each take their own
    /// unit (CAS), so the debt can neither be paid twice nor underflow.
    fn release(&self, mut permit: OwnedSemaphorePermit) {
        while permit.num_permits() > 0 && self.take_debt() {
            if permit.num_permits() == 1 {
                permit.forget();
                return;
            }
            if let Some(one) = permit.split(1) {
                one.forget();
            }
        }
        drop(permit);
    }

    /// The one capacity decision: the policy override if set, else the Settings value. Serialized.
    fn decide_capacity(&self) -> bool {
        let changed = {
            let _g = lk(&self.cap_lock);
            let pc = self.policy_cap.load(Ordering::SeqCst);
            self.apply_capacity(if pc > 0 { pc } else { self.config_cap.load(Ordering::SeqCst) })
        };
        self.cap_changed.notify_waiters();
        changed
    }

    /// Trip / clear the breaker if due (cheap; emits only on a transition, no lock held then).
    fn evaluate_breaker(&self) {
        let p = self.policy();
        let now = Instant::now();
        let oldest = lk(&self.waiting).iter().filter(|e| e.tier == 1 && !e.diagnostic).min_by_key(|e| e.since).map(|e| (e.label.clone(), now.saturating_duration_since(e.since)));
        let change = lk(&self.adm).breaker.evaluate(now, oldest.as_ref().map(|(l, d)| (l.as_str(), *d)), &p.circuit_breaker);
        match change {
            Some(BreakerChange::Tripped { waiter, wait_ms }) => emit_event("breaker", json!({ "action": "tripped", "waiter": waiter, "waitMs": wait_ms })),
            Some(BreakerChange::Cleared { held_ms }) => emit_event("breaker", json!({ "action": "cleared", "heldMs": held_ms })),
            None => {}
        }
    }

    /// A waiter's periodic check: breaker, then its own queue-timeout alert (once).
    fn tick(&self, t: &mut WaitTicket) {
        self.evaluate_breaker();
        if t.timeout_reported {
            return;
        }
        if let Some(limit) = self.policy().queue_timeout(t.tier) {
            let waited = t.since.elapsed();
            if waited > limit {
                t.timeout_reported = true;
                emit_event("queue_timeout", json!({ "label": short(&t.label), "tier": t.tier, "waitMs": ms(waited) }));
            }
        }
    }

    fn gate_state(&self, p: &Policy, foreground: bool, tier3_holders: usize, adm: &Admission) -> GateState {
        let in_hours = !foreground && needs_hours(p) && self.in_trading_hours(p);
        GateState { breaker_tripped: adm.breaker.tripped(), tier3_holders, since_last_librarian: adm.last_librarian.map(|i| i.elapsed()), in_hours }
    }

    /// The gate holding `t` right now (a non-atomic pre-check; `try_admit` re-checks atomically).
    fn gate_now(&self, t: &WaitTicket) -> Option<&'static str> {
        if t.foreground || t.gate_exempt {
            return None;
        }
        let p = self.policy();
        let tier3 = lk(&self.active).iter().filter(|e| e.tier >= 3).count();
        let s = {
            let adm = lk(&self.adm);
            self.gate_state(&p, false, tier3, &adm)
        };
        gate_for(&p, t.tier, false, t.librarian, &s)
    }

    /// Must `t` let a queued waiter go first? Yes for a strictly better tier, and for an older
    /// same-tier waiter that already handed its permit back to a better tier (FIFO inside a tier).
    /// A foreground waiter only yields to foreground waiters (Tony keeps his priority); gated
    /// waiters don't count. With one tier for everyone nobody ever yields here.
    fn yields_by_tier(&self, t: &WaitTicket) -> bool {
        lk(&self.waiting).iter().any(|e| e.id != t.id && !e.gated && (e.foreground || !t.foreground) && (e.tier < t.tier || (e.tier == t.tier && e.yielded && e.id < t.id)))
    }

    /// Is a real (non-diagnostic) foreground caller queued? Diagnostic probes never preempt nor
    /// take the Tony baton.
    fn real_fg_waiting(&self) -> bool {
        self.fg_waiting.load(Ordering::SeqCst) > 0 && lk(&self.waiting).iter().any(|e| e.foreground && !e.diagnostic)
    }

    /// Should a background holder (`holder` = its id, None = any) stop for a queued caller?
    fn should_preempt(&self, holder: Option<u64>) -> bool {
        if self.away.load(Ordering::SeqCst) {
            return false;
        }
        if self.real_fg_waiting() {
            return true;
        }
        if !self.policy().gpu.preempt_tier3_for_tier1 {
            return false;
        }
        if !lk(&self.waiting).iter().any(|e| e.tier == 1 && !e.gated && !e.diagnostic) {
            return false;
        }
        lk(&self.active).iter().any(|e| e.tier >= 3 && !e.foreground && holder.is_none_or(|id| e.id == id))
    }
}

/// Resolves once a foreground caller is queued (and Away Mode is off), or — with
/// `preemptTier3ForTier1` — a Tier-1 caller is queued while `holder` (or any background holder,
/// for `None`) is Tier 3.
async fn wait_preempt(inner: Arc<Inner>, holder: Option<u64>) {
    loop {
        let mut n = std::pin::pin!(inner.preempt.notified());
        n.as_mut().enable();
        if inner.should_preempt(holder) {
            return;
        }
        n.await;
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// The gateway lease for a slot view (pure).
pub fn lease_for(v: &SlotView, now_ms: u64) -> GpuLease {
    let busy = !v.active.is_empty() || v.settling > 0;
    if !busy {
        return GpuLease::default();
    }
    let holder = v.active.first().cloned().unwrap_or_else(|| "settling".into());
    GpuLease { busy, holder: holder.chars().take(60).collect(), until: Some(now_ms + LEASE_HINT_MS) }
}

/// Make the slot follow `gpu.maxConcurrentSlots` hot (lib.rs, once at setup, after the OS config
/// loaded). `Some(n)` overrides `set_capacity` callers; `None` hands capacity back to the last
/// `set_capacity` value (the Settings slider), hot.
pub fn install_policy(slot: &GpuSlot) {
    let weak = Arc::downgrade(&slot.inner);
    policy::on_change(move |p| {
        let Some(inner) = weak.upgrade() else { return };
        let pc = p.gpu.max_concurrent_slots.map_or(0, |n| (n as usize).clamp(1, 8));
        inner.policy_cap.store(pc, Ordering::SeqCst);
        if inner.decide_capacity() {
            Inner::emit(&inner);
        }
        // `preemptTier3ForTier1` may have flipped: holders re-check.
        inner.preempt.notify_waiters();
    });
}

impl GpuSlot {
    /// Another handle on the same slot (the lease server keeps one).
    pub(crate) fn share(&self) -> GpuSlot {
        GpuSlot { inner: self.inner.clone() }
    }

    /// A slot that admits by its own policy (tests never touch the process-wide one).
    #[cfg(test)]
    pub(crate) fn with_policy(p: Policy) -> GpuSlot {
        let s = GpuSlot::default();
        lk(&s.inner.hooks).policy = Some(Arc::new(p));
        s
    }

    #[cfg(test)]
    fn force_trading_hours(&self, on: Option<bool>) {
        lk(&self.inner.hooks).in_hours = on;
    }

    pub fn set_notify(&self, f: impl Fn(SlotView) + Send + Sync + 'static) {
        *lk(&self.inner.notify) = Some(Box::new(f));
    }

    /// Resize to `n` slots (profile / server upgrade). While the installed policy sets
    /// `gpu.maxConcurrentSlots` (Some), that is used instead; `n` is remembered and applied once
    /// the policy goes back to None.
    pub fn set_capacity(&self, n: usize) {
        self.inner.config_cap.store(n.clamp(1, 8), Ordering::SeqCst);
        self.inner.decide_capacity();
        Inner::emit(&self.inner);
    }

    pub fn view(&self) -> SlotView {
        self.inner.view()
    }

    /// Holders and waiters with their tiers, the breaker and the Tier-1 wait p95.
    pub fn detail(&self) -> SlotDetail {
        self.inner.evaluate_breaker();
        let now = Instant::now();
        let holders = lk(&self.inner.active).iter().map(|e| e.view(now)).collect();
        let waiters = lk(&self.inner.waiting).iter().map(|e| e.view(now)).collect();
        let adm = lk(&self.inner.adm);
        let b = &adm.breaker;
        SlotDetail {
            capacity: self.inner.capacity.load(Ordering::SeqCst),
            settling: self.inner.settling.load(Ordering::SeqCst),
            holders,
            waiters,
            breaker: BreakerView { tripped: b.tripped(), since_ms_ago: b.tripped_at.map(|t| ms(now.saturating_duration_since(t))), trips: b.trips, last_reason: b.last_reason.clone() },
            tier1_wait_p95_ms: p95(&adm.tier1_waits),
        }
    }

    /// The same signal as `SlotGuard::preempted` for a background holder, without borrowing the
    /// guard (so the guarded call can hold it `&mut` inside a `select!`). For the Tier-1 rule it
    /// fires when any background holder is Tier 3 (exact with one slot).
    pub fn background_preempted(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        wait_preempt(self.inner.clone(), None)
    }

    /// Away Mode on / off (the compute arbiter calls this; see the module doc).
    pub fn set_away(&self, on: bool) {
        if self.inner.away.swap(on, Ordering::SeqCst) != on {
            Inner::emit(&self.inner);
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_away(&self) -> bool {
        self.inner.away.load(Ordering::SeqCst)
    }

    /// Nothing holds, waits for, or settles the GPU (Phase 3 idle compaction gate).
    pub fn is_idle(&self) -> bool {
        let v = self.view();
        v.active.is_empty() && v.queued_foreground == 0 && v.queued_background == 0 && v.settling == 0
    }

    /// The gateway lease mirror's receiver (see `gpu_mirror_loop`).
    pub fn lease_watch(&self) -> tokio::sync::watch::Receiver<GpuLease> {
        self.inner.lease.subscribe()
    }

    /// Background callers yield to queued foreground work for up to the Tony-priority wait.
    async fn yield_to_foreground(&self, tony_priority_pct: u8, t: &mut WaitTicket) {
        // 90 % → wait up to 45 s for Tony's queue to clear; 50 % → 0 s.
        let max_wait = Duration::from_millis(((tony_priority_pct.clamp(50, 100) as u64 - 50) * 1125).min(60_000));
        let t0 = Instant::now();
        let mut n = 0u32;
        // Real foreground only: a queued diagnostic probe never holds real background work back.
        while self.inner.real_fg_waiting() && t0.elapsed() < max_wait {
            tokio::time::sleep(Duration::from_millis(60)).await;
            n = n.wrapping_add(1);
            if n % 4 == 0 {
                self.inner.tick(t);
            }
        }
    }

    /// Wait while a gate holds `t` (breaker / tier-3 cap / Librarian spacing): no permit is taken,
    /// one `defer` event per reason.
    async fn wait_gates(&self, t: &mut WaitTicket) {
        loop {
            self.inner.tick(t);
            let Some(reason) = self.inner.gate_now(t) else {
                t.set_gated(false);
                return;
            };
            t.set_gated(true);
            if !t.deferred.contains(&reason) {
                t.deferred.push(reason);
                emit_event("defer", json!({ "label": short(&t.label), "tier": t.tier, "reason": reason }));
            }
            tokio::time::sleep(GATE_POLL).await;
        }
    }

    /// Queue on the semaphore (keeping the FIFO place) while ticking the breaker / queue timeout.
    async fn acquire_permit(&self, t: &mut WaitTicket) -> OwnedSemaphorePermit {
        let acq = self.inner.sem.clone().acquire_owned();
        tokio::pin!(acq);
        loop {
            tokio::select! {
                p = &mut acq => return p.expect("gpu slot semaphore"),
                _ = tokio::time::sleep(TICK) => self.inner.tick(t),
            }
        }
    }

    /// A won permit becomes a holder, or goes back: `Err((permit, None))` = hand the baton back and
    /// retry after a back-off; `Err((permit, Some(gate)))` = a gate closed meanwhile.
    fn try_admit(&self, t: &mut WaitTicket, permit: OwnedSemaphorePermit, tony_priority_pct: u8) -> Result<SlotGuard, (OwnedSemaphorePermit, Option<&'static str>)> {
        let inner = &self.inner;
        // A background step that won the race while Tony is now waiting hands the baton back.
        if !t.foreground && !inner.away.load(Ordering::SeqCst) && tony_priority_pct >= 90 && inner.real_fg_waiting() {
            return Err((permit, None));
        }
        // Tiered admission: a strictly better tier that is queued goes first.
        if inner.yields_by_tier(t) {
            t.set_yielded();
            return Err((permit, None));
        }
        let p = inner.policy();
        let now = Instant::now();
        let id = inner.next_id.fetch_add(1, Ordering::SeqCst) as u64;
        {
            // Atomic gate check + holder insert (two Tier-3 winners can't both pass a cap of 1).
            let mut active = lk(&inner.active);
            let tier3 = active.iter().filter(|e| e.tier >= 3).count();
            let mut adm = lk(&inner.adm);
            let exempt = t.foreground || t.gate_exempt;
            let s = inner.gate_state(&p, exempt, tier3, &adm);
            if let Some(gate) = gate_for(&p, t.tier, exempt, t.librarian, &s) {
                return Err((permit, Some(gate)));
            }
            // Diagnostic probes leave the real bookkeeping alone (spacing, p95, breaker).
            if t.librarian && !t.diagnostic {
                adm.last_librarian = Some(now);
            }
            if t.tier == 1 && !t.diagnostic {
                let waited = ms(now.saturating_duration_since(t.since));
                adm.tier1_waits.push_back(waited);
                while adm.tier1_waits.len() > TIER1_WINDOW {
                    adm.tier1_waits.pop_front();
                }
                adm.breaker.saw_tier1(now);
            }
            drop(adm);
            active.push(Entry { id, label: t.label.clone(), node: node_of(&t.label), tier: t.tier, since: now, foreground: t.foreground, diagnostic: t.diagnostic, gated: false, yielded: false });
        }
        t.done();
        Inner::emit(inner);
        Ok(SlotGuard { inner: inner.clone(), id, permit: Some(permit), settle: None, foreground: t.foreground, tier: t.tier })
    }

    fn guard(&self, label: &str, tier: u8, permit: OwnedSemaphorePermit, foreground: bool) -> SlotGuard {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst) as u64;
        lk(&self.inner.active).push(Entry { id, label: label.to_string(), node: node_of(label), tier, since: Instant::now(), foreground, diagnostic: is_diagnostic(label), gated: false, yielded: false });
        Inner::emit(&self.inner);
        SlotGuard { inner: self.inner.clone(), id, permit: Some(permit), settle: None, foreground, tier }
    }

    /// Take a GPU slot. Foreground jumps the queue; background yields to it
    /// (up to `bg_max_wait`, derived from the Tony-priority slider). Within that, better tiers are
    /// served first and the policy's gates apply (module doc).
    /// Cancel-safe: dropping the future while it waits leaves no queued count behind.
    pub async fn acquire(&self, label: &str, foreground: bool, tony_priority_pct: u8) -> SlotGuard {
        // Away Mode: no foreground reservation; everyone queues first-come-first-served. A caller
        // that asked for foreground also drops its label tier (Tony would otherwise still be
        // Tier 1, overtake the queue and trip the breaker): it queues at `defaultTier`. Genuine
        // background Tier-1 nodes (trading) keep their tier.
        let away = self.inner.away.load(Ordering::SeqCst);
        let tier = {
            let pol = self.inner.policy();
            if foreground && away { pol.gpu.default_tier.clamp(1, 3) } else { pol.tier_for_label(label) }
        };
        let asked_fg = foreground;
        let foreground = foreground && !away;
        let mut ticket = WaitTicket::new(&self.inner, foreground, label, tier);
        ticket.gate_exempt = asked_fg && away;
        if !foreground && !away {
            self.yield_to_foreground(tony_priority_pct, &mut ticket).await;
        }
        loop {
            self.wait_gates(&mut ticket).await;
            let permit = self.acquire_permit(&mut ticket).await;
            // A permit won while a shrink is owed pays it (covers permits tokio handed back from a
            // cancelled acquire without passing through elease).
            if self.inner.take_debt() {
                permit.forget();
                continue;
            }
            match self.try_admit(&mut ticket, permit, tony_priority_pct) {
                Ok(guard) => return guard,
                Err((p, None)) => {
                    self.inner.release(p);
                    tokio::time::sleep(BATON_BACKOFF).await;
                }
                // A gate closed between the pre-check and the permit: wait it out without the permit.
                Err((p, Some(_))) => self.inner.release(p),
            }
        }
    }

    /// Model maintenance (unload / reload / bench): background priority and EXCLUSIVE — it
    /// takes every permit, so nothing generates while a model is being swapped.
    pub async fn acquire_maintenance(&self, label: &str, tony_priority_pct: u8) -> SlotGuard {
        let label = format!("maintenance · {label}");
        let tier = self.inner.policy().tier_for_label(&label);
        let mut ticket = WaitTicket::new(&self.inner, false, &label, tier);
        self.yield_to_foreground(tony_priority_pct, &mut ticket).await;
        // One permit at a time up to the CURRENT capacity: a shrink while waiting must not leave
        // maintenance waiting for permits that no longer exist (a hang), and a permit won while a
        // shrink is owed pays it. PermitBatch releases what it holds if this future is dropped.
        let mut batch = PermitBatch { inner: self.inner.clone(), p: None };
        loop {
            // Armed before reading capacity, so a change between the read and the wait still wakes us.
            let changed = self.inner.cap_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let need = self.inner.capacity.load(Ordering::SeqCst).max(1);
            if batch.held() >= need {
                break;
            }
            let one = tokio::select! {
                p = self.inner.sem.clone().acquire_owned() => p.expect("gpu slot semaphore"),
                _ = &mut changed => continue,
            };
            if self.inner.take_debt() {
                one.forget();
                continue;
            }
            match batch.p.as_mut() {
                Some(p) => p.merge(one),
                None => batch.p = Some(one),
            }
        }
        let mut permit = batch.p.take().expect("at least one permit");
        let need = self.inner.capacity.load(Ordering::SeqCst).max(1);
        if permit.num_permits() > need {
            // Capacity shrank after these were collected: give the excess back (it pays any debt).
            if let Some(extra) = permit.split(permit.num_permits() - need) {
                self.inner.release(extra);
            }
        }
        ticket.done();
        self.guard(&label, tier, permit, false)
    }
}

/// Permits collected one by one for maintenance; released through `Inner::release` if dropped early.
struct PermitBatch {
    inner: Arc<Inner>,
    p: Option<OwnedSemaphorePermit>,
}

impl PermitBatch {
    fn held(&self) -> usize {
        self.p.as_ref().map_or(0, |p| p.num_permits())
    }
}

impl Drop for PermitBatch {
    fn drop(&mut self) {
        if let Some(p) = self.p.take() {
            self.inner.release(p);
        }
    }
}

/// Mirror the slot's lease to the gateway (`PUT /api/os/gpu`, loopback, 3 s timeout), so the
/// gateway's own LM Studio calls back off while the desktop holds the GPU. Best-effort: the hot
/// path only does a non-blocking `watch` send; this loop always sends the newest state, in order.
pub async fn gpu_mirror_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    let mut rx = app.state::<super::os_core::OsState>().slot.lease_watch();
    while rx.changed().await.is_ok() {
        let lease = rx.borrow_and_update().clone();
        let st = app.state::<super::dispatch::DispatchState>();
        let os = app.state::<super::os_core::OsState>().snapshot();
        let base = st.snapshot().gateway.url;
        let mut rb = st.http.put(format!("{}/api/os/gpu", base.trim_end_matches('/'))).timeout(Duration::from_secs(3)).json(&lease);
        if let Some(t) = super::os_core::mesh_bearer(&os) {
            rb = rb.bearer_auth(t);
        }
        let _ = rb.send().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_jumps_background() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            let order = Arc::new(Mutex::new(Vec::<&str>::new()));
            let g = slot.acquire("holder", true, 90).await;
            let (s1, o1) = (slot.clone(), order.clone());
            let bg = tauri::async_runtime::spawn(async move {
                let _g = s1.acquire("bg", false, 90).await;
                o1.lock().unwrap().push("bg");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            let (s2, o2) = (slot.clone(), order.clone());
            let fg = tauri::async_runtime::spawn(async move {
                let _g = s2.acquire("tony", true, 90).await;
                o2.lock().unwrap().push("tony");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(g);
            let _ = fg.await;
            let _ = bg.await;
            assert_eq!(*order.lock().unwrap(), vec!["tony", "bg"]);
        });
    }

    #[test]
    fn capacity_scales() {
        let slot = test_slot();
        slot.set_capacity(3);
        assert_eq!(slot.view().capacity, 3);
        slot.set_capacity(1);
        assert_eq!(slot.view().capacity, 1);
    }

    /// Time until a second (foreground) acquire succeeds after `drop_first` releases the holder.
    fn second_acquire_wait(arm: Option<Duration>, disarm: bool) -> Duration {
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(test_slot());
            let mut g = slot.acquire("holder", true, 90).await;
            if let Some(d) = arm {
                g.arm_settle(d);
            }
            if disarm {
                g.disarm();
            }
            let t0 = Instant::now();
            drop(g);
            let _g2 = slot.acquire("next", true, 90).await;
            t0.elapsed()
        })
    }

    #[test]
    fn timeout_does_not_release_before_settle() {
        // Armed and dropped (timeout / cancel): the next holder waits for the window.
        let waited = second_acquire_wait(Some(Duration::from_millis(300)), false);
        assert!(waited >= Duration::from_millis(280), "released after {waited:?}");
        // Clean completion: immediate.
        assert!(second_acquire_wait(Some(Duration::from_millis(300)), true) < Duration::from_millis(150));
        // Never armed (every existing caller): immediate, as before.
        assert!(second_acquire_wait(None, false) < Duration::from_millis(150));
    }

    #[test]
    fn cancelled_holder_future_settles() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            let s1 = slot.clone();
            // A holder that arms the settle window and is then cancelled mid-"generation".
            let task = tauri::async_runtime::spawn(async move {
                let mut g = s1.acquire("allm", false, 50).await;
                g.arm_settle(Duration::from_millis(300));
                tokio::time::sleep(Duration::from_secs(30)).await;
                g.disarm();
            });
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(slot.view().active.len(), 1);
            task.abort();
            let _ = task.await;
            assert_eq!(slot.view().settling, 1, "a cancelled holder keeps the permit");
            assert!(lease_for(&slot.view(), 0).busy, "the gateway still sees the GPU busy while settling");
            let t0 = Instant::now();
            let _g = slot.acquire("next", true, 90).await;
            assert!(t0.elapsed() >= Duration::from_millis(150), "{:?}", t0.elapsed());
            assert_eq!(slot.view().settling, 0);
        });
    }

    #[test]
    fn is_idle_tracks_holders_queues_and_settling() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            assert!(slot.is_idle());
            let g = slot.acquire("tony", true, 90).await;
            assert!(!slot.is_idle(), "held");
            // A queued background and a queued foreground waiter.
            let s1 = slot.clone();
            let bg = tauri::async_runtime::spawn(async move {
                let _g = s1.acquire("bg", false, 50).await;
            });
            tokio::time::sleep(Duration::from_millis(40)).await;
            assert_eq!(slot.view().queued_background, 1);
            assert!(!slot.is_idle(), "background queued");
            let s2 = slot.clone();
            let fg = tauri::async_runtime::spawn(async move {
                let _g = s2.acquire("fg", true, 50).await;
            });
            tokio::time::sleep(Duration::from_millis(40)).await;
            assert_eq!(slot.view().queued_foreground, 1);
            drop(g);
            let _ = fg.await;
            let _ = bg.await;
            assert!(slot.is_idle(), "released");
            // A settling permit is not idle.
            let mut g = slot.acquire("allm", false, 50).await;
            g.arm_settle(Duration::from_millis(200));
            drop(g);
            assert_eq!(slot.view().settling, 1);
            assert!(!slot.is_idle(), "settling");
            tokio::time::sleep(Duration::from_millis(350)).await;
            assert!(slot.is_idle(), "settled");
        });
    }

    #[test]
    fn timed_out_acquire_leaves_no_phantom_waiter() {
        // compaction.rs wraps a background acquire in `tokio::time::timeout(SLOT_WAIT, ..)`; when
        // the holder outlasts it, the dropped future must give its queued count back.
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            let views = Arc::new(Mutex::new(Vec::<usize>::new()));
            let v2 = views.clone();
            slot.set_notify(move |v| v2.lock().unwrap().push(v.queued_background));
            let g = slot.acquire("tony", true, 90).await;
            let r = tokio::time::timeout(Duration::from_millis(80), slot.acquire("memory · compact", false, 50)).await;
            assert!(r.is_err(), "timed out while held");
            assert_eq!(slot.view().queued_background, 0, "no phantom background waiter");
            assert_eq!(views.lock().unwrap().last().copied(), Some(0), "the drop is published");
            let r = tokio::time::timeout(Duration::from_millis(80), slot.acquire_maintenance("bench", 50)).await;
            assert!(r.is_err());
            assert_eq!(slot.view().queued_background, 0);
            // Foreground waiters too.
            let r = tokio::time::timeout(Duration::from_millis(80), slot.acquire("fg", true, 90)).await;
            assert!(r.is_err());
            assert_eq!(slot.view().queued_foreground, 0);
            drop(g);
            assert!(slot.is_idle(), "idle again once the holder releases");
            // A normal acquire still counts down exactly once.
            let g = slot.acquire("bg", false, 50).await;
            assert_eq!(slot.view().queued_background, 0);
            drop(g);
            assert!(slot.is_idle());
        });
    }

    #[test]
    fn maintenance_is_exclusive_and_waits_for_holders() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            slot.set_capacity(2);
            let g1 = slot.acquire("a", true, 90).await;
            let s = slot.clone();
            let m = tauri::async_runtime::spawn(async move {
                let g = s.acquire_maintenance("reload", 50).await;
                let v = s.view();
                drop(g);
                v
            });
            tokio::time::sleep(Duration::from_millis(120)).await;
            assert!(!m.inner().is_finished(), "maintenance must wait for the running holder");
            drop(g1);
            let v = m.await.unwrap();
            assert_eq!(v.active, vec!["maintenance · reload".to_string()]);
            // While maintenance held every permit, nothing else could have run: capacity is back.
            let a = slot.acquire("x", true, 90).await;
            let b = slot.acquire("y", true, 90).await;
            assert_eq!(slot.view().active.len(), 2);
            drop((a, b));
        });
    }

    #[test]
    fn lease_mirror_flips_busy_and_idle() {
        tauri::async_runtime::block_on(async {
            let slot = test_slot();
            let mut rx = slot.lease_watch();
            assert!(!rx.borrow_and_update().busy);
            let g = slot.acquire("anythingllm · coder", false, 50).await;
            assert!(rx.has_changed().unwrap());
            let l = rx.borrow_and_update().clone();
            assert!(l.busy && l.holder == "anythingllm · coder" && l.until.is_some());
            drop(g);
            assert!(rx.has_changed().unwrap());
            assert_eq!(*rx.borrow_and_update(), GpuLease::default());
        });
    }

    #[test]
    fn foreground_preempts_a_background_holder_but_not_in_away_mode() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            let bg = slot.acquire("worker · coder code", false, 90).await;
            // Nothing queued: not preempted.
            assert!(tokio::time::timeout(Duration::from_millis(60), bg.preempted()).await.is_err());
            let s = slot.clone();
            let tony = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("lmstudio · Tony", true, 90).await;
            });
            tokio::time::timeout(Duration::from_millis(500), bg.preempted()).await.expect("preempted when Tony queues");
            assert_eq!(slot.view().waiting, vec!["lmstudio · Tony".to_string()]);
            drop(bg);
            let _ = tony.await;
            assert!(slot.view().waiting.is_empty());
            // A foreground holder is never preempted.
            let fg = slot.acquire("tony", true, 90).await;
            assert!(tokio::time::timeout(Duration::from_millis(60), fg.preempted()).await.is_err());
            drop(fg);
            // Away Mode: Tony queues FIFO and the background holder keeps the token.
            slot.set_away(true);
            assert!(slot.is_away() && slot.view().away);
            let bg = slot.acquire("worker · coder code", false, 90).await;
            let s = slot.clone();
            let tony = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("lmstudio · Tony", true, 90).await;
            });
            assert!(tokio::time::timeout(Duration::from_millis(150), bg.preempted()).await.is_err());
            assert_eq!(slot.view().queued_foreground, 0, "away: no foreground reservation");
            drop(bg);
            let _ = tony.await;
        });
    }

    #[test]
    fn settle_default_and_cap() {
        let mut c = SchedulerConfig::default();
        assert_eq!(c.settle(), Duration::from_secs(20));
        c.settle_secs = 999;
        assert_eq!(c.settle(), Duration::from_secs(120));
        let old: SchedulerConfig = serde_json::from_str(r#"{"profile":"sequential"}"#).unwrap();
        assert_eq!(old.settle_secs, DEFAULT_SETTLE_SECS);
    }

    // ── Tiered admission ────────────────────────────────────────────────────

    fn test_slot() -> GpuSlot {
        GpuSlot::with_policy(Policy::default())
    }

    fn no_breaker() -> Policy {
        let mut p = Policy::default();
        p.circuit_breaker.enabled = false;
        p
    }

    fn events_for(kind: &str, label: &str) -> Vec<Value> {
        lk(captured()).iter().filter(|(k, v)| k == kind && v["label"] == label).map(|(_, v)| v.clone()).collect()
    }

    /// Background waiters queue (in this order) behind a Tier-3 holder; the order they ran in.
    fn run_order(p: Policy, labels: &[&'static str]) -> Vec<&'static str> {
        let labels = labels.to_vec();
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::with_policy(p));
            let order = Arc::new(Mutex::new(Vec::<&str>::new()));
            let g = slot.acquire("worker · coder hold", false, 50).await;
            let mut tasks = vec![];
            for l in labels {
                let (s, o) = (slot.clone(), order.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    let _g = s.acquire(l, false, 50).await;
                    o.lock().unwrap().push(l);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }));
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            drop(g);
            for t in tasks {
                let _ = t.await;
            }
            let v = order.lock().unwrap().clone();
            v
        })
    }

    const QUEUE: [&str; 3] = ["worker · coder b", "worker · prompter c", "gateway · trading"];

    #[test]
    fn tier1_waiter_overtakes_queued_tier3s() {
        assert_eq!(run_order(no_breaker(), &QUEUE), vec!["gateway · trading", "worker · coder b", "worker · prompter c"]);
    }

    #[test]
    fn empty_tiers_keep_todays_fifo() {
        let mut p = Policy::default();
        p.gpu.tiers.clear();
        assert_eq!(run_order(p, &QUEUE), QUEUE.to_vec());
    }

    #[test]
    fn foreground_does_not_yield_to_a_better_background_tier() {
        // Tony's priority is unchanged: a foreground Tier-3 caller is not overtaken by a queued
        // background Tier-1 one (only a better-tier FOREGROUND waiter would do that).
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(GpuSlot::with_policy(no_breaker()));
            let order = Arc::new(Mutex::new(Vec::<&str>::new()));
            let g = slot.acquire("worker · coder hold", false, 50).await;
            let (s1, o1) = (slot.clone(), order.clone());
            let fg = tauri::async_runtime::spawn(async move {
                let _g = s1.acquire("worker · coder fg", true, 50).await;
                o1.lock().unwrap().push("fg");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            let (s2, o2) = (slot.clone(), order.clone());
            let t1 = tauri::async_runtime::spawn(async move {
                let _g = s2.acquire("gateway · trading", false, 50).await;
                o2.lock().unwrap().push("trading");
            });
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(g);
            let _ = fg.await;
            let _ = t1.await;
            assert_eq!(*order.lock().unwrap(), vec!["fg", "trading"]);
        });
    }

    #[test]
    fn breaker_state_machine_trips_and_clears_on_time() {
        let p = policy::BreakerPolicy { enabled: true, tier1_wait_ms: 1_500, hold_ms: 30_000, clear_after_idle_ms: 5_000 };
        let t0 = Instant::now();
        let at = |m: u64| t0 + Duration::from_millis(m);
        let d = Duration::from_millis;
        let mut b = Breaker::default();
        assert_eq!(b.evaluate(at(0), None, &p), None);
        assert_eq!(b.evaluate(at(1_000), Some(("lmstudio · Tony", d(1_000))), &p), None, "under the threshold");
        assert_eq!(b.evaluate(at(1_600), Some(("lmstudio · Tony", d(1_600))), &p), Some(BreakerChange::Tripped { waiter: "lmstudio · Tony".into(), wait_ms: 1_600 }));
        assert!(b.tripped() && b.trips == 1);
        assert!(b.last_reason.as_deref().unwrap().contains("1600 ms"));
        assert_eq!(b.evaluate(at(1_700), Some(("x", d(1_700))), &p), None, "no second trip while tripped");
        assert_eq!(b.evaluate(at(20_000), None, &p), None, "inside holdMs");
        assert_eq!(b.evaluate(at(28_000), Some(("gateway · trading", d(100))), &p), None);
        assert_eq!(b.evaluate(at(31_700), None, &p), None, "hold passed but a Tier-1 was queued 3.7 s ago");
        // Clearable at max(trip + hold, last Tier-1 + idle) = max(31.6 s, 33 s) → held 31.4 s.
        assert_eq!(b.evaluate(at(33_100), None, &p), Some(BreakerChange::Cleared { held_ms: 31_400 }));
        assert!(!b.tripped() && b.trips == 1);
        // Trips again later.
        assert!(matches!(b.evaluate(at(40_000), Some(("t", d(2_000))), &p), Some(BreakerChange::Tripped { .. })));
        assert_eq!(b.trips, 2);
        // Disabled: a tripped breaker clears at once and never trips.
        let off = policy::BreakerPolicy { enabled: false, ..p.clone() };
        assert!(matches!(b.evaluate(at(40_100), Some(("t", d(2_100))), &off), Some(BreakerChange::Cleared { .. })));
        assert_eq!(b.evaluate(at(41_000), Some(("t", d(60_000))), &off), None);
    }

    #[test]
    fn breaker_defers_tier3_until_it_clears() {
        let mut p = Policy::default();
        p.circuit_breaker = policy::BreakerPolicy { enabled: true, tier1_wait_ms: 100, hold_ms: 400, clear_after_idle_ms: 150 };
        tauri::async_runtime::block_on(async move {
            let start = Instant::now();
            let slot = Arc::new(GpuSlot::with_policy(p));
            let g = slot.acquire("worker · coder hold", false, 50).await;
            let s = slot.clone();
            let trading = tauri::async_runtime::spawn(async move {
                let g = s.acquire("gateway · trading", false, 50).await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                drop(g);
            });
            tokio::time::sleep(Duration::from_millis(350)).await;
            let d = slot.detail();
            assert!(d.breaker.tripped, "a Tier-1 waiter past tier1WaitMs trips it: {d:?}");
            assert_eq!(d.breaker.trips, 1);
            let s = slot.clone();
            let late = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("worker · prompter breaker-late", false, 50).await;
                start.elapsed()
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(g);
            let _ = trading.await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!late.inner().is_finished(), "Tier 3 stays deferred while tripped (slot free)");
            assert!(slot.detail().holders.is_empty(), "a deferred Tier-3 takes no permit");
            let got_at = tokio::time::timeout(Duration::from_secs(3), late).await.expect("clears").unwrap();
            assert!(got_at >= Duration::from_millis(550), "admitted only after holdMs + idle: {got_at:?}");
            let d = slot.detail();
            assert!(!d.breaker.tripped && d.breaker.trips == 1);
            let defers = events_for("defer", "worker · prompter breaker-late");
            assert_eq!(defers.len(), 1, "one defer event per reason");
            assert_eq!(defers[0]["reason"], DEFER_BREAKER);
            assert_eq!(defers[0]["tier"], 3);
        });
    }

    #[test]
    fn queue_timeout_alerts_once_and_keeps_waiting() {
        let mut p = no_breaker();
        p.gpu.queue_timeout_ms.insert("3".into(), 100);
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::with_policy(p));
            let g = slot.acquire("worker · coder hold", false, 50).await;
            let s = slot.clone();
            let w = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("worker · coder qt-once", false, 50).await;
            });
            tokio::time::sleep(Duration::from_millis(900)).await;
            assert!(!w.inner().is_finished(), "deferred, never failed");
            let ev = events_for("queue_timeout", "worker · coder qt-once");
            assert_eq!(ev.len(), 1, "{ev:?}");
            assert!(ev[0]["waitMs"].as_u64().unwrap() >= 100);
            drop(g);
            w.await.unwrap();
            assert_eq!(events_for("queue_timeout", "worker · coder qt-once").len(), 1);
        });
    }

    #[test]
    fn tier3_cap_during_trading_hours() {
        let mut p = no_breaker();
        p.trading_hours.tier3_max_concurrent_background = 1;
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::with_policy(p));
            slot.set_capacity(2);
            slot.force_trading_hours(Some(true));
            let a = slot.acquire("worker · coder cap-a", false, 50).await;
            let r = tokio::time::timeout(Duration::from_millis(300), slot.acquire("worker · prompter cap-b", false, 50)).await;
            assert!(r.is_err(), "a second Tier-3 waits while one holds");
            assert_eq!(events_for("defer", "worker · prompter cap-b")[0]["reason"], DEFER_TIER3_CAP);
            assert_eq!(slot.view().queued_background, 0, "the abandoned waiter left cleanly");
            let t1 = tokio::time::timeout(Duration::from_millis(300), slot.acquire("gateway · trading", false, 50)).await.expect("Tier 1 is not capped");
            drop(t1);
            slot.force_trading_hours(Some(false));
            let b = tokio::time::timeout(Duration::from_millis(300), slot.acquire("worker · prompter cap-c", false, 50)).await.expect("no cap outside the window");
            drop((a, b));
        });
    }

    #[test]
    fn librarian_spacing_during_trading_hours() {
        let mut p = no_breaker();
        p.trading_hours.librarian_min_interval_ms = 300;
        tauri::async_runtime::block_on(async move {
            let slot = GpuSlot::with_policy(p);
            slot.force_trading_hours(Some(true));
            drop(slot.acquire("memory · condense", false, 50).await);
            let t0 = Instant::now();
            drop(slot.acquire("memory · condense", false, 50).await);
            assert!(t0.elapsed() >= Duration::from_millis(250), "{:?}", t0.elapsed());
            let t0 = Instant::now();
            drop(slot.acquire("worker · coder x", false, 50).await);
            assert!(t0.elapsed() < Duration::from_millis(150), "only the Librarian is spaced");
            slot.force_trading_hours(Some(false));
            let t0 = Instant::now();
            drop(slot.acquire("memory · condense", false, 50).await);
            assert!(t0.elapsed() < Duration::from_millis(150), "no spacing outside the window");
        });
    }

    #[test]
    fn tier1_preempts_tier3_only_when_enabled() {
        for on in [false, true] {
            let mut p = no_breaker();
            p.gpu.preempt_tier3_for_tier1 = on;
            tauri::async_runtime::block_on(async move {
                let slot = Arc::new(GpuSlot::with_policy(p));
                let bg = slot.acquire("worker · coder code", false, 50).await;
                let pre = slot.background_preempted();
                assert!(tokio::time::timeout(Duration::from_millis(60), bg.preempted()).await.is_err(), "nothing queued");
                let s = slot.clone();
                let t = tauri::async_runtime::spawn(async move {
                    let _g = s.acquire("gateway · trading", false, 50).await;
                });
                assert_eq!(tokio::time::timeout(Duration::from_millis(300), bg.preempted()).await.is_ok(), on);
                assert_eq!(tokio::time::timeout(Duration::from_millis(50), pre).await.is_ok(), on);
                drop(bg);
                let _ = t.await;
                // A Tier-2 holder is never preempted by the Tier-1 rule.
                let sec = slot.acquire("worker · security scan", false, 50).await;
                assert_eq!(sec.tier(), 2);
                let s = slot.clone();
                let t = tauri::async_runtime::spawn(async move {
                    let _g = s.acquire("gateway · trading", false, 50).await;
                });
                assert!(tokio::time::timeout(Duration::from_millis(150), sec.preempted()).await.is_err());
                drop(sec);
                let _ = t.await;
            });
        }
    }

    #[test]
    fn detail_names_tiers_nodes_and_tier1_p95() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(GpuSlot::with_policy(no_breaker()));
            let g = slot.acquire("worker · coder code", false, 50).await;
            let s = slot.clone();
            let w = tauri::async_runtime::spawn(async move {
                drop(s.acquire("gateway · trading", false, 50).await);
            });
            tokio::time::sleep(Duration::from_millis(60)).await;
            let d = slot.detail();
            assert_eq!(d.holders.len(), 1);
            assert_eq!((d.holders[0].tier, d.holders[0].node.as_deref()), (3, Some("coder")));
            assert_eq!(d.waiters.len(), 1);
            assert_eq!((d.waiters[0].label.as_str(), d.waiters[0].tier, d.waiters[0].node.as_deref()), ("gateway · trading", 1, Some("trading")));
            assert!(d.waiters[0].ms >= 40);
            assert_eq!(d.tier1_wait_p95_ms, None);
            drop(g);
            let _ = w.await;
            let d = slot.detail();
            assert!(d.tier1_wait_p95_ms.unwrap() >= 40);
            let v = serde_json::to_value(&d).unwrap();
            assert!(v.get("tier1WaitP95Ms").is_some() && v["breaker"].get("sinceMsAgo").is_some() && v["breaker"].get("lastReason").is_some(), "{v}");
        });
    }

    #[test]
    fn gates_and_p95_are_pure() {
        let mut p = Policy::default();
        p.trading_hours.tier3_max_concurrent_background = 1;
        p.trading_hours.librarian_min_interval_ms = 1_000;
        let s = |tripped, holders, lib: Option<u64>, in_hours| GateState { breaker_tripped: tripped, tier3_holders: holders, since_last_librarian: lib.map(Duration::from_millis), in_hours };
        assert_eq!(gate_for(&p, 3, false, false, &s(true, 0, None, false)), Some(DEFER_BREAKER));
        assert_eq!(gate_for(&p, 3, true, false, &s(true, 5, None, true)), None, "foreground is never gated");
        assert_eq!(gate_for(&p, 2, false, false, &s(true, 5, None, true)), None, "Tier 2 is never gated");
        assert_eq!(gate_for(&p, 3, false, false, &s(false, 1, None, true)), Some(DEFER_TIER3_CAP));
        assert_eq!(gate_for(&p, 3, false, false, &s(false, 1, None, false)), None, "cap only in hours");
        assert_eq!(gate_for(&p, 3, false, true, &s(false, 0, Some(400), true)), Some(DEFER_LIBRARIAN));
        assert_eq!(gate_for(&p, 3, false, true, &s(false, 0, Some(1_200), true)), None);
        assert_eq!(gate_for(&p, 3, false, true, &s(false, 0, None, true)), None, "first Librarian call");
        p.circuit_breaker.enabled = false;
        assert_eq!(gate_for(&p, 3, false, false, &s(true, 0, None, false)), None);
        assert!(!needs_hours(&Policy::default()));
        assert_eq!(p95(&VecDeque::new()), None);
        assert_eq!(p95(&(1..=100).collect()), Some(95));
        assert_eq!(p95(&[7].into_iter().collect()), Some(7));
        assert_eq!(node_of("diagnostic · probe librarian").as_deref(), Some("librarian"));
        assert_eq!(node_of("gateway · trading").as_deref(), Some("trading"));
        assert_eq!(node_of("maintenance · reload"), None);
    }

    /// Serializes the tests that change the process-wide policy.
    fn global_policy_lock() -> MutexGuard<'static, ()> {
        static L: Mutex<()> = Mutex::new(());
        lk(&L)
    }

    #[test]
    fn install_policy_applies_capacity_hot() {
        let _l = global_policy_lock();
        let before = (*policy::current()).clone();
        let mut none = before.clone();
        none.gpu.max_concurrent_slots = None;
        policy::apply(none.clone());
        let slot = GpuSlot::default();
        slot.set_capacity(3);
        install_policy(&slot);
        assert_eq!(slot.view().capacity, 3, "None: the config slider's value stands");
        let mut p = none.clone();
        p.gpu.max_concurrent_slots = Some(2);
        policy::apply(p);
        assert_eq!(slot.view().capacity, 2, "Some(n) applies hot");
        slot.set_capacity(1);
        assert_eq!(slot.view().capacity, 2, "the policy override wins over the config slider");
        policy::apply(none);
        assert_eq!(slot.view().capacity, 1, "back to None: the remembered slider value, hot");
        drop(slot);
        // A dropped slot's listener is a no-op.
        policy::apply(before);
    }

    #[test]
    fn null_slots_leave_capacity_to_set_capacity_and_the_default_pins_one() {
        let _l = global_policy_lock();
        let before = (*policy::current()).clone();
        // maxConcurrentSlots: null -> the Settings slider decides, exactly as before this work.
        let mut follow = Policy::default();
        follow.gpu.max_concurrent_slots = None;
        policy::apply(follow);
        let slot = GpuSlot::default();
        install_policy(&slot);
        assert_eq!(slot.view().capacity, 1);
        for n in [3, 1, 2, 9] {
            slot.set_capacity(n);
            assert_eq!(slot.view().capacity, n.clamp(1, 8), "set_capacity({n}) applies exactly as before");
        }
        // The default policy pins the single GPU slot: the slider can't raise it.
        policy::apply(Policy::default());
        assert_eq!(slot.view().capacity, 1);
        slot.set_capacity(4);
        assert_eq!(slot.view().capacity, 1, "locked at 1 by the default policy");
        drop(slot);
        policy::apply(before);
    }

    // ── Away Mode × tiers ───────────────────────────────────────────────────

    #[test]
    fn away_mode_tony_queues_fifo_but_trading_keeps_tier1() {
        // FIFO: Tony (foreground, label Tier 1) does not overtake an older Tier-3 background
        // waiter; background Tier-1 trading still does.
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(GpuSlot::with_policy(no_breaker()));
            slot.set_away(true);
            let order = Arc::new(Mutex::new(Vec::<&str>::new()));
            let g = slot.acquire("worker · coder hold", false, 90).await;
            let mut tasks = vec![];
            for (label, fg, name) in [("worker · prompter away-c", false, "prompter"), ("lmstudio · Tony", true, "tony"), ("gateway · trading", false, "trading")] {
                let (s, o) = (slot.clone(), order.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    let _g = s.acquire(label, fg, 90).await;
                    o.lock().unwrap().push(name);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }));
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            let d = slot.detail();
            let tony = d.waiters.iter().find(|w| w.label == "lmstudio · Tony").unwrap();
            assert_eq!(tony.tier, Policy::default().gpu.default_tier, "away: Tony queues at defaultTier");
            drop(g);
            for t in tasks {
                let _ = t.await;
            }
            assert_eq!(*order.lock().unwrap(), vec!["trading", "prompter", "tony"]);
        });
    }

    #[test]
    fn away_mode_tony_does_not_trip_the_breaker() {
        let mut p = Policy::default();
        p.circuit_breaker = policy::BreakerPolicy { enabled: true, tier1_wait_ms: 100, hold_ms: 400, clear_after_idle_ms: 150 };
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::with_policy(p));
            slot.set_away(true);
            let g = slot.acquire("worker · coder hold", false, 90).await;
            let s = slot.clone();
            let tony = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("lmstudio · Tony", true, 90).await;
            });
            tokio::time::sleep(Duration::from_millis(400)).await;
            let d = slot.detail();
            assert!(!d.breaker.tripped && d.breaker.trips == 0, "away-mode Tony is not Tier 1: {d:?}");
            drop(g);
            let _ = tony.await;
            assert_eq!(slot.detail().tier1_wait_p95_ms, None, "no Tier-1 wait recorded for away-mode Tony");
        });
    }

    #[test]
    fn away_mode_tony_is_never_held_by_the_breaker() {
        // Away Mode + a tripped breaker (a real Tier-1 trading waiter): Tony still queues, never gated.
        let mut p = Policy::default();
        p.circuit_breaker = policy::BreakerPolicy { enabled: true, tier1_wait_ms: 100, hold_ms: 5_000, clear_after_idle_ms: 5_000 };
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::with_policy(p));
            slot.set_away(true);
            let g = slot.acquire("worker · coder hold", false, 90).await;
            let s = slot.clone();
            let trading = tauri::async_runtime::spawn(async move { drop(s.acquire("gateway · trading", false, 90).await) });
            tokio::time::sleep(Duration::from_millis(400)).await;
            assert!(slot.detail().breaker.tripped, "a real Tier-1 waiter trips it");
            let s = slot.clone();
            let tony = tauri::async_runtime::spawn(async move { drop(s.acquire("lmstudio · Tony", true, 90).await) });
            tokio::time::sleep(Duration::from_millis(250)).await;
            let gated: Vec<_> = lk(&slot.inner.waiting).iter().filter(|e| e.gated).map(|e| e.label.clone()).collect();
            assert!(gated.is_empty(), "away-mode Tony is not gated by the breaker: {gated:?}");
            drop(g);
            tokio::time::timeout(Duration::from_secs(3), async { trading.await.unwrap(); tony.await.unwrap() }).await.expect("both served while the breaker is still tripped");
        });
    }

    // ── Capacity ────────────────────────────────────────────────────────────

    #[test]
    fn shrinking_while_held_forgets_the_permits_on_release() {
        tauri::async_runtime::block_on(async {
            let slot = test_slot();
            slot.set_capacity(2);
            let a = slot.acquire("worker · coder a", false, 50).await;
            let b = slot.acquire("worker · coder b", false, 50).await;
            slot.set_capacity(1);
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 1, "one permit owed: both were held");
            drop(a);
            drop(b);
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 0);
            assert_eq!(slot.inner.sem.available_permits(), 1, "exactly the new capacity is available");
            slot.set_capacity(3);
            assert_eq!(slot.inner.sem.available_permits(), 3);
            // Growing while still owed cancels the debt instead of adding on top of it.
            let a = slot.acquire("worker · coder a", false, 50).await;
            let b = slot.acquire("worker · coder b", false, 50).await;
            let c = slot.acquire("worker · coder c", false, 50).await;
            slot.set_capacity(1);
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 2);
            slot.set_capacity(2);
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 1);
            drop((a, b, c));
            assert_eq!(slot.inner.sem.available_permits(), 2);
        });
    }

    #[test]
    fn a_shrink_is_enforced_even_while_waiters_are_queued() {
        // capacity 2, both held, 3 waiters queued; shrink to 1: from then on only ONE holder at a time.
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            slot.set_capacity(2);
            let a = slot.acquire("worker · coder a", false, 50).await;
            let b = slot.acquire("worker · coder b", false, 50).await;
            let peak = Arc::new(AtomicUsize::new(0));
            let live = Arc::new(AtomicUsize::new(0));
            let mut waiters = vec![];
            for i in 0..3 {
                let (s, peak, live) = (slot.clone(), peak.clone(), live.clone());
                waiters.push(tauri::async_runtime::spawn(async move {
                    let _g = s.acquire(&format!("worker · coder w{i}"), false, 50).await;
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    live.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
            slot.set_capacity(1);
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 1);
            drop(a); // pays the debt: this permit must NOT reach a queued waiter
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert_eq!(live.load(Ordering::SeqCst), 0, "no waiter admitted beside b");
            drop(b);
            for w in waiters {
                w.await.unwrap();
            }
            assert_eq!(peak.load(Ordering::SeqCst), 1, "never more than the new capacity at once");
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 0);
            assert_eq!(slot.inner.sem.available_permits(), 1);
        });
    }

    #[test]
    fn maintenance_waiting_for_permits_survives_a_shrink() {
        // capacity 2, A holds one, maintenance has the other and waits for a 2nd; shrink to 1.
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            slot.set_capacity(2);
            let a = slot.acquire("worker · coder a", false, 50).await;
            let s = slot.clone();
            let m = tauri::async_runtime::spawn(async move {
                let g = s.acquire_maintenance("reload", 50).await;
                g.permit.as_ref().map(|p| p.num_permits())
            });
            tokio::time::sleep(Duration::from_millis(60)).await;
            slot.set_capacity(1); // maintenance already holds 1 = the new capacity: it must finish
            let held = tokio::time::timeout(Duration::from_secs(2), m).await.expect("maintenance must not hang after a shrink").unwrap();
            assert_eq!(held, Some(1), "exclusive at the new capacity");
            drop(a); // pays the debt
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 0);
            assert_eq!(slot.inner.sem.available_permits(), 1);
        });
    }

    #[test]
    fn maintenance_is_exclusive_and_released_if_cancelled() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            slot.set_capacity(2);
            let a = slot.acquire("worker · coder a", false, 50).await;
            let s = slot.clone();
            // Cancelled while holding one of the two permits it needs: nothing may leak.
            let r = tokio::time::timeout(Duration::from_millis(80), s.acquire_maintenance("bench", 50)).await;
            assert!(r.is_err());
            drop(a);
            assert_eq!(slot.inner.sem.available_permits(), 2, "the partial batch went back");
            let g = slot.acquire_maintenance("bench", 50).await;
            assert_eq!(g.permit.as_ref().map(|p| p.num_permits()), Some(2));
            let s = slot.clone();
            let ran = Arc::new(AtomicBool::new(false));
            let r2 = ran.clone();
            let other = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("worker · coder b", false, 50).await;
                r2.store(true, Ordering::SeqCst);
            });
            tokio::time::sleep(Duration::from_millis(60)).await;
            assert!(!ran.load(Ordering::SeqCst), "nothing runs beside maintenance");
            drop(g);
            tokio::time::timeout(Duration::from_secs(2), other).await.unwrap().unwrap();
            assert!(ran.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn concurrent_releases_never_pay_one_debt_twice() {
        for _ in 0..50 {
            let slot = Arc::new(test_slot());
            slot.set_capacity(2);
            let (a, b) = tauri::async_runtime::block_on(async { (slot.acquire("worker · coder a", false, 50).await, slot.acquire("worker · coder b", false, 50).await) });
            slot.set_capacity(1);
            let t1 = std::thread::spawn(move || drop(a));
            let t2 = std::thread::spawn(move || drop(b));
            t1.join().unwrap();
            t2.join().unwrap();
            assert_eq!(slot.inner.owed.load(Ordering::SeqCst), 0, "no underflow");
            assert_eq!(slot.inner.sem.available_permits(), 1, "exactly one permit left");
        }
    }

    // ── Diagnostic probes ───────────────────────────────────────────────────

    #[test]
    fn a_queued_foreground_probe_does_not_hold_real_background_back() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            let holder = slot.acquire("worker · coder hold", false, 90).await;
            let s = slot.clone();
            let probe = tauri::async_runtime::spawn(async move { drop(s.acquire("diagnostic · probe tony", true, 90).await) });
            tokio::time::sleep(Duration::from_millis(80)).await;
            let s = slot.clone();
            let real = tauri::async_runtime::spawn(async move {
                let t0 = Instant::now();
                drop(s.acquire("worker · prompter spec", false, 90).await);
                t0.elapsed()
            });
            tokio::time::sleep(Duration::from_millis(80)).await;
            drop(holder);
            let waited = tokio::time::timeout(Duration::from_secs(3), real).await.expect("not stuck in the 45 s foreground yield").unwrap();
            assert!(waited < Duration::from_secs(2), "{waited:?}");
            let _ = probe.await;
        });
    }

    #[test]
    fn tier1_probe_never_trips_the_breaker_nor_moves_p95() {
        let mut p = Policy::default();
        p.circuit_breaker = policy::BreakerPolicy { enabled: true, tier1_wait_ms: 100, hold_ms: 400, clear_after_idle_ms: 150 };
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::with_policy(p));
            let g = slot.acquire("worker · coder hold", false, 50).await;
            let s = slot.clone();
            let probe = tauri::async_runtime::spawn(async move {
                let g = s.acquire("diagnostic · probe trading", false, 50).await;
                g.tier()
            });
            tokio::time::sleep(Duration::from_millis(400)).await;
            let d = slot.detail();
            assert_eq!(d.waiters[0].tier, 1, "a probe still queues at its node's tier");
            assert!(!d.breaker.tripped && d.breaker.trips == 0, "{d:?}");
            drop(g);
            assert_eq!(probe.await.unwrap(), 1);
            let d = slot.detail();
            assert!(!d.breaker.tripped && d.breaker.trips == 0);
            assert_eq!(d.tier1_wait_p95_ms, None, "a probe's wait is not a Tier-1 wait");
            assert!(lk(&slot.inner.adm).breaker.last_tier1_seen.is_none());
        });
    }

    #[test]
    fn foreground_probe_does_not_preempt_a_background_holder() {
        tauri::async_runtime::block_on(async {
            let slot = Arc::new(test_slot());
            let bg = slot.acquire("worker · coder code", false, 90).await;
            let pre = slot.background_preempted();
            let s = slot.clone();
            let probe = tauri::async_runtime::spawn(async move {
                let _g = s.acquire("diagnostic · probe tony", true, 90).await;
            });
            assert!(tokio::time::timeout(Duration::from_millis(200), pre).await.is_err(), "background_preempted stays quiet");
            assert!(tokio::time::timeout(Duration::from_millis(60), bg.preempted()).await.is_err());
            assert_eq!(slot.view().queued_foreground, 1, "the probe is still queued as foreground");
            assert!(!slot.inner.real_fg_waiting(), "…but is no Tony baton holder");
            drop(bg);
            let _ = probe.await;
        });
    }

    #[test]
    fn librarian_probe_leaves_last_librarian_alone() {
        let mut p = no_breaker();
        p.trading_hours.librarian_min_interval_ms = 300;
        tauri::async_runtime::block_on(async move {
            let slot = GpuSlot::with_policy(p);
            slot.force_trading_hours(Some(true));
            drop(slot.acquire("diagnostic · probe librarian", false, 50).await);
            assert!(lk(&slot.inner.adm).last_librarian.is_none(), "a probe does not update last_librarian");
            let t0 = Instant::now();
            drop(slot.acquire("memory · condense", false, 50).await);
            assert!(t0.elapsed() < Duration::from_millis(150), "the real Librarian call is not spaced after a probe: {:?}", t0.elapsed());
            assert!(lk(&slot.inner.adm).last_librarian.is_some());
        });
    }
}
