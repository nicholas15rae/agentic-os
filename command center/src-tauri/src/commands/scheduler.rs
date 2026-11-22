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
//! `max_concurrency` = slots (1 on the 3060; raise it on a bigger server).
//! The live state is emitted as `gpu-slot` for the top-bar pill.
//!
//! Hot-potato additions (the compute arbiter, `arbiter.rs`):
//! - **Preemption**: a background holder races its call against [`SlotGuard::preempted`], which
//!   fires the moment Tony queues. The worker parks that stage and resumes it later, so Tony never
//!   waits behind a long Coder generation.
//! - **Away Mode** (`set_away`): Tony gives up his foreground reservation. Every caller queues
//!   first-come-first-served; background never yields and is never preempted.
//! - The view names who is waiting (`waiting`), so the System Map can show `QUEUED` nodes.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
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

type Notify = Box<dyn Fn(SlotView) + Send + Sync>;

struct Inner {
    sem: Arc<Semaphore>,
    capacity: AtomicUsize,
    fg_waiting: AtomicUsize,
    bg_waiting: AtomicUsize,
    settling: AtomicUsize,
    active: Mutex<Vec<(u64, String)>>,
    waiting: Mutex<Vec<(u64, String)>>,
    next_id: AtomicUsize,
    away: AtomicBool,
    /// Woken when a foreground caller queues: background holders racing `preempted()` stop.
    preempt: tokio::sync::Notify,
    /// Publishes slot changes (wired to the `gpu-slot` event in lib.rs). A plain callback
    /// keeps the window runtime out of this module (and its unit tests).
    notify: Mutex<Option<Notify>>,
    /// Latest lease for the gateway mirror. Sending never blocks; the consumer
    /// (`gpu_mirror_loop`) always sends the newest value, in order.
    lease: tokio::sync::watch::Sender<GpuLease>,
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
}

/// The error text a preempted background call returns (the worker parks the stage on it).
pub const PREEMPTED: &str = "PREEMPTED";

/// Does this error mean "a foreground turn took the GPU; run it again later"?
pub fn is_preempted(err: &str) -> bool {
    err.contains(PREEMPTED)
}

impl SlotGuard {
    /// Resolves when Tony queues for the GPU while this BACKGROUND holder runs (never for a
    /// foreground holder, never in Away Mode). Race the model call against it with `select!`;
    /// dropping the request makes LM Studio stop generating.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn preempted(&self) {
        if self.foreground {
            return std::future::pending().await;
        }
        wait_preempt(self.inner.clone()).await
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
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.inner.active.lock().unwrap().retain(|(i, _)| *i != self.id);
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
                    drop(permit);
                    Inner::emit(&inner);
                });
            }
            (_, permit) => {
                drop(permit);
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
}

impl WaitTicket {
    fn new(inner: &Arc<Inner>, foreground: bool, label: &str) -> Self {
        let id = inner.next_id.fetch_add(1, Ordering::SeqCst) as u64;
        inner.waiting.lock().unwrap().push((id, label.to_string()));
        Self::counter(inner, foreground).fetch_add(1, Ordering::SeqCst);
        Inner::emit(inner);
        if foreground {
            inner.preempt.notify_waiters();
        }
        Self { inner: inner.clone(), foreground, armed: true, id }
    }

    fn counter(inner: &Inner, foreground: bool) -> &AtomicUsize {
        if foreground {
            &inner.fg_waiting
        } else {
            &inner.bg_waiting
        }
    }

    /// Got the permit: count down without an emit (the guard that follows emits the new holder).
    fn done(mut self) {
        self.armed = false;
        self.inner.waiting.lock().unwrap().retain(|(i, _)| *i != self.id);
        Self::counter(&self.inner, self.foreground).fetch_sub(1, Ordering::SeqCst);
    }
}

impl Drop for WaitTicket {
    fn drop(&mut self) {
        if self.armed {
            self.inner.waiting.lock().unwrap().retain(|(i, _)| *i != self.id);
            Self::counter(&self.inner, self.foreground).fetch_sub(1, Ordering::SeqCst);
            Inner::emit(&self.inner);
        }
    }
}

impl Inner {
    fn view(&self) -> SlotView {
        SlotView {
            active: self.active.lock().unwrap().iter().map(|(_, l)| l.clone()).collect(),
            queued_foreground: self.fg_waiting.load(Ordering::SeqCst),
            queued_background: self.bg_waiting.load(Ordering::SeqCst),
            capacity: self.capacity.load(Ordering::SeqCst),
            settling: self.settling.load(Ordering::SeqCst),
            waiting: self.waiting.lock().unwrap().iter().map(|(_, l)| l.clone()).collect(),
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
        if let Some(f) = this.notify.lock().unwrap().as_ref() {
            f(view);
        }
    }
}

/// Resolves once a foreground caller is queued (and Away Mode is off).
async fn wait_preempt(inner: Arc<Inner>) {
    loop {
        let mut n = std::pin::pin!(inner.preempt.notified());
        n.as_mut().enable();
        if inner.fg_waiting.load(Ordering::SeqCst) > 0 && !inner.away.load(Ordering::SeqCst) {
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

impl GpuSlot {
    pub fn set_notify(&self, f: impl Fn(SlotView) + Send + Sync + 'static) {
        *self.inner.notify.lock().unwrap() = Some(Box::new(f));
    }

    /// Resize to `n` slots (profile / server upgrade).
    pub fn set_capacity(&self, n: usize) {
        let n = n.clamp(1, 8);
        let cur = self.inner.capacity.swap(n, Ordering::SeqCst);
        if n > cur {
            self.inner.sem.add_permits(n - cur);
        } else if n < cur {
            self.inner.sem.forget_permits(cur - n);
        }
        Inner::emit(&self.inner);
    }

    pub fn view(&self) -> SlotView {
        self.inner.view()
    }

    /// The same signal as `SlotGuard::preempted` for a background holder, without borrowing the
    /// guard (so the guarded call can hold it `&mut` inside a `select!`).
    pub fn background_preempted(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        wait_preempt(self.inner.clone())
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
    async fn yield_to_foreground(&self, tony_priority_pct: u8) {
        // 90 % → wait up to 45 s for Tony's queue to clear; 50 % → 0 s.
        let max_wait = Duration::from_millis(((tony_priority_pct.clamp(50, 100) as u64 - 50) * 1125).min(60_000));
        let t0 = Instant::now();
        while self.inner.fg_waiting.load(Ordering::SeqCst) > 0 && t0.elapsed() < max_wait {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }

    fn guard(&self, label: &str, permit: OwnedSemaphorePermit, foreground: bool) -> SlotGuard {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst) as u64;
        self.inner.active.lock().unwrap().push((id, label.to_string()));
        Inner::emit(&self.inner);
        SlotGuard { inner: self.inner.clone(), id, permit: Some(permit), settle: None, foreground }
    }

    /// Take a GPU slot. Foreground jumps the queue; background yields to it
    /// (up to `bg_max_wait`, derived from the Tony-priority slider).
    /// Cancel-safe: dropping the future while it waits leaves no queued count behind.
    pub async fn acquire(&self, label: &str, foreground: bool, tony_priority_pct: u8) -> SlotGuard {
        // Away Mode: no foreground reservation; everyone queues first-come-first-served.
        let away = self.inner.away.load(Ordering::SeqCst);
        let foreground = foreground && !away;
        let ticket = WaitTicket::new(&self.inner, foreground, label);
        if !foreground && !away {
            self.yield_to_foreground(tony_priority_pct).await;
        }
        let permit = loop {
            let p = self.inner.sem.clone().acquire_owned().await.expect("gpu slot semaphore");
            // A background step that won the race while Tony is now waiting hands the baton back.
            if !foreground && !self.inner.away.load(Ordering::SeqCst) && self.inner.fg_waiting.load(Ordering::SeqCst) > 0 && tony_priority_pct >= 90 {
                drop(p);
                tokio::time::sleep(Duration::from_millis(80)).await;
                continue;
            }
            break p;
        };
        ticket.done();
        self.guard(label, permit, foreground)
    }

    /// Model maintenance (unload / reload / bench): background priority and EXCLUSIVE — it
    /// takes every permit, so nothing generates while a model is being swapped.
    pub async fn acquire_maintenance(&self, label: &str, tony_priority_pct: u8) -> SlotGuard {
        let label = format!("maintenance · {label}");
        let ticket = WaitTicket::new(&self.inner, false, &label);
        self.yield_to_foreground(tony_priority_pct).await;
        let n = self.inner.capacity.load(Ordering::SeqCst).max(1) as u32;
        let permit = self.inner.sem.clone().acquire_many_owned(n).await.expect("gpu slot semaphore");
        ticket.done();
        self.guard(&label, permit, false)
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
            let slot = Arc::new(GpuSlot::default());
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
        let slot = GpuSlot::default();
        slot.set_capacity(3);
        assert_eq!(slot.view().capacity, 3);
        slot.set_capacity(1);
        assert_eq!(slot.view().capacity, 1);
    }

    /// Time until a second (foreground) acquire succeeds after `drop_first` releases the holder.
    fn second_acquire_wait(arm: Option<Duration>, disarm: bool) -> Duration {
        tauri::async_runtime::block_on(async move {
            let slot = Arc::new(GpuSlot::default());
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
            let slot = Arc::new(GpuSlot::default());
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
            let slot = Arc::new(GpuSlot::default());
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
            let slot = Arc::new(GpuSlot::default());
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
            let slot = Arc::new(GpuSlot::default());
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
            let slot = GpuSlot::default();
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
            let slot = Arc::new(GpuSlot::default());
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
}
