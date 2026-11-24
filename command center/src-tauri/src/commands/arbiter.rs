//! The Compute Arbiter ("hot potato"): one registry of every node on the whiteboard, who holds
//! the GPU token, who is queued, and every hand-off between them.
//!
//! - **The token** is the existing `GpuSlot` permit (capacity 1 on the 3060): only its holder runs
//!   local inference. The arbiter does not add a second lock; it watches the slot (`on_slot`,
//!   wired to the slot's notify in lib.rs) and turns holder changes into `token` hand-offs with
//!   their turnaround time.
//! - **CPU / API scripts** (Garbage, Observer, Security, Booking) run through [`run_task`], capped at
//!   `TASK_PERMITS` at once, so GPU + scripts never exceed 3 active tasks.
//! - **Node states**: `DORMANT` · `QUEUED` · `ACTIVE_TOKEN` (holds the GPU) · `ACTIVE` (a CPU/API
//!   script running) · `LOCKED_VAULT` (Finance while sealed) · `ERROR` (last run failed). A node
//!   that finishes goes straight back to `DORMANT`.
//! - **Away Mode** (`set_away`): persisted in os.json (`scheduler.awayMode`), pushed into the slot
//!   (no foreground reservation, no preemption) and the worker (no foreground wait), and lets the
//!   downtime scheduler run its scripts without waiting for the user to go idle.
//! - **Events**: `arbiter-state` (the node view, on change) and `arbiter-handoff` (one row per
//!   token pass, agent hand-off or memory read/write). Labels only: never prompts or payloads.
//! - **Latency audit**: Tony's end-to-end turn time and the token turnaround, rolling p50/p95.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// CPU / API script permits (the GPU token is the third active task).
pub const TASK_PERMITS: usize = 2;
const FEED_MAX: usize = 80;
const LATENCY_MAX: usize = 60;

pub const STATE_EVENT: &str = "arbiter-state";
pub const HANDOFF_EVENT: &str = "arbiter-handoff";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeState {
    Dormant,
    Queued,
    ActiveToken,
    Active,
    LockedVault,
    Error,
}

/// One whiteboard node (static).
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeDef {
    pub id: &'static str,
    pub label: &'static str,
    /// `foreground` · `build_circle` · `retrieval` · `script` · `vault` · `auditor` · `mesh`.
    pub group: &'static str,
    /// What it runs on: `gpu` (local inference, needs the token) · `cpu` (deterministic) · `api`.
    pub compute: &'static str,
    /// Its memory namespace (`memtier`), `finance` = the sealed vault's own index.
    pub namespace: Option<&'static str>,
    /// When it may run.
    pub schedule: &'static str,
}

const fn node(id: &'static str, label: &'static str, group: &'static str, compute: &'static str, namespace: Option<&'static str>, schedule: &'static str) -> NodeDef {
    NodeDef { id, label, group, compute, namespace, schedule }
}

/// The roster, in topology order.
pub const NODES: [NodeDef; 14] = [
    node("tony", "Tony", "foreground", "gpu", Some("tony"), "foreground: preempts background work; yields in Away Mode"),
    node("prompter", "Prompter", "build_circle", "gpu", Some("build_circle"), "build circle: Prompter → Coder → Designer, one token at a time"),
    node("coder", "Coder", "build_circle", "gpu", Some("build_circle"), "build circle"),
    node("designer", "Designer", "build_circle", "gpu", Some("build_circle"), "build circle"),
    node("librarian", "Librarian", "retrieval", "gpu", Some("librarian"), "on demand: lookups, deep recall, archival distill"),
    node("booking", "Booking", "script", "api", Some("booking"), "event / cron scan (n8n webhook)"),
    node("security", "Security", "script", "cpu", Some("security"), "idle / Away: injection + boundary scan of new hand-offs"),
    node("garbage", "Garbage", "script", "cpu", None, "idle / Away: purge dumps, graduate stale memory, compact"),
    node("finance", "Finance [Vault]", "vault", "cpu", Some("finance"), "sealed; wakes only when you unlock it or on a validated ledger write"),
    node("observer", "Observer", "auditor", "cpu", Some("observer"), "jittered idle / Away audit of hand-off integrity"),
    node("ops", "Ops", "mesh", "gpu", None, "on demand (AnythingLLM workspace)"),
    node("director", "Director", "mesh", "gpu", Some("director"), "on demand: edit plans on the GPU slot; renders run on the CPU (libx264)"),
    node("bizops", "Biz Ops", "mesh", "gpu", None, "on demand: one business per turn, in that business's own bizops_<id> workspace"),
    // The IBKR paper-trading agent (trading/ in the repo). Off the shared mesh: its only peer is
    // Finance (see `ISOLATED` / `mesh_allows`), and every order it proposes passes the
    // deterministic Security Detail before the broker bridge.
    node("trading", "Trading", "isolated", "cpu", Some("trading_rag"), "isolated: talks only to Finance; orders pass the Security Detail"),
];

/// Nodes whose hand-offs are restricted to their listed `EDGES` (an allowlist, not just a drawing).
pub const ISOLATED: [&str; 1] = ["trading"];

/// May `from` hand off to `to`? Unrestricted for the shared mesh (EDGES there are display only);
/// for an isolated node only its exact listed edges are allowed (pure).
pub fn mesh_allows(from: &str, to: &str) -> bool {
    if !ISOLATED.contains(&from) && !ISOLATED.contains(&to) {
        return true;
    }
    EDGES.iter().any(|(a, b)| *a == from && *b == to)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn node_def(id: &str) -> Option<&'static NodeDef> {
    NODES.iter().find(|n| n.id == id)
}

/// Canonical node id for an agent / role id (`general` and Tony's aliases → `tony`).
pub fn node_id(agent: &str) -> Option<&'static str> {
    let a = agent.trim().to_ascii_lowercase();
    let a = a.as_str();
    if matches!(a, "general" | "tony" | "os" | "dispatcher" | "orchestrator" | "jarvis" | "user") {
        return Some("tony");
    }
    if a == "financer" {
        return Some("finance");
    }
    if matches!(a, "trading_agent" | "trader") {
        return Some("trading");
    }
    // Every business's workspace (`bizops_<id>`) is the Operations Manager's.
    if a.starts_with("bizops_") {
        return Some("bizops");
    }
    NODES.iter().find(|n| n.id == a).map(|n| n.id)
}

/// Which node a GPU-slot holder label belongs to (`lmstudio · Tony`, `worker · coder code ·
/// lmstudio`, `anythingllm · booking`, `memory · compact`…). None: system work (model
/// maintenance, an unlabelled background call).
pub fn node_for_label(label: &str) -> Option<&'static str> {
    let l = label.to_ascii_lowercase();
    if l.starts_with("maintenance") {
        return None;
    }
    if l.contains("· tony") || l.ends_with("tony") {
        return Some("tony");
    }
    if let Some(rest) = l.strip_prefix("worker · ") {
        return rest.split_whitespace().next().and_then(node_id);
    }
    if l.starts_with("memory · ") {
        return Some("librarian");
    }
    l.split(" · ").skip(1).find_map(|seg| seg.split_whitespace().next().and_then(node_id))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RosterConfig {
    /// Booking's scan: an n8n / webhook URL that returns opportunities. Empty: `UNCONFIGURED`.
    pub booking_scan_webhook: String,
    pub booking_scan_minutes: u32,
    /// The user counts as idle after this long without a Tony turn.
    pub idle_minutes: u32,
    pub garbage_minutes: u32,
    pub security_minutes: u32,
    /// Observer's jittered interval.
    pub observer_min_minutes: u32,
    pub observer_max_minutes: u32,
    /// Security dumps older than this are purged by Garbage.
    pub dump_keep_days: u32,
    /// Active-RAG entries untouched this long graduate to the Memory Module.
    pub graduate_after_days: u32,
    /// The Finance vault re-seals after this long without use.
    pub vault_idle_minutes: u32,
    /// Tony answers with the dispatch packet (`tony_dispatch::CONTRACT`). Off: plain prose, as before.
    pub tony_packets: bool,
}

impl Default for RosterConfig {
    fn default() -> Self {
        Self {
            booking_scan_webhook: String::new(),
            booking_scan_minutes: 60,
            idle_minutes: 5,
            garbage_minutes: 30,
            security_minutes: 10,
            observer_min_minutes: 20,
            observer_max_minutes: 60,
            dump_keep_days: 7,
            graduate_after_days: 7,
            vault_idle_minutes: 10,
            tony_packets: true,
        }
    }
}

/// One hand-off on the map.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    /// Unix ms.
    pub at: u64,
    pub from: String,
    pub to: String,
    /// `token` (GPU pass) · `handoff` (agent → agent) · `memory_read` · `memory_write` · `script`.
    pub kind: String,
    /// Turnaround (token) / duration (script, memory) in ms, when known.
    pub ms: Option<u64>,
    pub label: String,
}

#[derive(Default)]
struct Inner {
    holder: Option<String>,
    holder_since: Option<Instant>,
    queued: Vec<String>,
    last_release: Option<(Option<String>, Instant)>,
    tasks: BTreeMap<String, u32>,
    errors: BTreeMap<String, String>,
    status: BTreeMap<String, (bool, String)>,
    runs: BTreeMap<String, u64>,
    last_active: BTreeMap<String, u64>,
    feed: VecDeque<Handoff>,
    tony_ms: VecDeque<u64>,
    turnaround_ms: VecDeque<u64>,
    last_foreground: Option<Instant>,
    away: bool,
    vault_open: bool,
    context_tokens: Option<u64>,
    last_state: String,
}

pub struct Arbiter {
    inner: Mutex<Inner>,
    tasks: Arc<tokio::sync::Semaphore>,
    app: OnceLock<tauri::AppHandle>,
}

impl Default for Arbiter {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner::default()), tasks: Arc::new(tokio::sync::Semaphore::new(TASK_PERMITS)), app: OnceLock::new() }
    }
}

/// The process-wide arbiter.
pub fn get() -> &'static Arbiter {
    static A: OnceLock<Arbiter> = OnceLock::new();
    A.get_or_init(Arbiter::default)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn push_capped<T>(q: &mut VecDeque<T>, v: T, max: usize) {
    q.push_back(v);
    while q.len() > max {
        q.pop_front();
    }
}

/// p50 / p95 / last of a latency window (pure).
pub fn percentiles(v: &VecDeque<u64>) -> Value {
    if v.is_empty() {
        return json!({ "n": 0 });
    }
    let mut s: Vec<u64> = v.iter().copied().collect();
    s.sort_unstable();
    let at = |p: f64| s[((s.len() - 1) as f64 * p).round() as usize];
    json!({ "n": s.len(), "last": v.back(), "p50": at(0.5), "p95": at(0.95), "max": s.last() })
}

impl Arbiter {
    pub fn install(&self, app: &tauri::AppHandle) {
        let _ = self.app.set(app.clone());
    }

    fn emit(&self, event: &str, payload: &impl Serialize) {
        if let Some(app) = self.app.get() {
            use tauri::Emitter;
            let _ = app.emit(event, payload);
        }
    }

    fn push_handoff(&self, h: Handoff) {
        self.inner.lock().unwrap().feed.push_back(h.clone());
        {
            let mut i = self.inner.lock().unwrap();
            while i.feed.len() > FEED_MAX {
                i.feed.pop_front();
            }
        }
        self.emit(HANDOFF_EVENT, &h);
    }

    /// Publish the node view if it changed.
    pub fn publish(&self) {
        let nodes = self.nodes();
        let away = self.inner.lock().unwrap().away;
        let holder = self.inner.lock().unwrap().holder.clone();
        let payload = json!({ "nodes": nodes, "away": away, "holder": holder });
        let key = payload.to_string();
        {
            let mut i = self.inner.lock().unwrap();
            if i.last_state == key {
                return;
            }
            i.last_state = key;
        }
        self.emit(STATE_EVENT, &payload);
    }

    /// The GPU slot changed (holder / queue). Turns holder changes into `token` hand-offs.
    pub fn on_slot(&self, v: &super::scheduler::SlotView) {
        let holder = v.active.iter().find_map(|l| node_for_label(l)).map(str::to_string);
        let queued: Vec<String> = v.waiting.iter().filter_map(|l| node_for_label(l)).map(str::to_string).collect();
        let now = Instant::now();
        let handoff = {
            let mut i = self.inner.lock().unwrap();
            i.queued = queued;
            i.away = v.away;
            if i.holder == holder {
                None
            } else {
                let prev = i.holder.take();
                if let Some(p) = &prev {
                    i.last_release = Some((Some(p.clone()), now));
                }
                i.holder = holder.clone();
                i.holder_since = holder.as_ref().map(|_| now);
                match &holder {
                    Some(h) => {
                        *i.runs.entry(h.clone()).or_default() += 1;
                        i.last_active.insert(h.clone(), now_ms());
                        i.errors.remove(h);
                        let (from, gap) = match (&prev, &i.last_release) {
                            (Some(p), _) => (p.clone(), Some(0)),
                            (None, Some((who, at))) => (who.clone().unwrap_or_else(|| "idle".into()), Some(now.duration_since(*at).as_millis() as u64)),
                            (None, None) => ("idle".into(), None),
                        };
                        if let Some(g) = gap {
                            push_capped(&mut i.turnaround_ms, g, LATENCY_MAX);
                        }
                        Some(Handoff { at: now_ms(), from, to: h.clone(), kind: "token".into(), ms: gap, label: "GPU token".into() })
                    }
                    None => prev.map(|p| Handoff { at: now_ms(), from: p, to: "idle".into(), kind: "token".into(), ms: None, label: "token released (node dormant)".into() }),
                }
            }
        };
        if let Some(h) = handoff {
            self.push_handoff(h);
        }
        self.publish();
    }

    /// An agent → agent hand-off (task worker rows, delegation). Returns false (and records
    /// nothing) when the edge touches an isolated node and isn't on its allowlist.
    pub fn handoff(&self, from: &str, to: &str, label: &str) -> bool {
        let (Some(f), Some(t)) = (node_id(from), node_id(to)) else { return false };
        if f == t {
            return false;
        }
        if !mesh_allows(f, t) {
            eprintln!("[arbiter] refused hand-off {f} -> {t}: {t_or_f} is isolated (Finance-only)", t_or_f = if ISOLATED.contains(&f) { f } else { t });
            return false;
        }
        self.push_handoff(Handoff { at: now_ms(), from: f.into(), to: t.into(), kind: "handoff".into(), ms: None, label: super::envelope::clip(&super::envelope::one_line(label), 80) });
        true
    }

    /// A memory read / write by `node` in `namespace` (pulses node ↔ its memory on the map).
    pub fn memory_io(&self, node: &str, namespace: &str, write: bool, ms: u64, label: &str) {
        let n = node_id(node).unwrap_or("tony");
        let mem = format!("mem:{namespace}");
        let (from, to) = if write { (n.to_string(), mem) } else { (mem, n.to_string()) };
        self.push_handoff(Handoff { at: now_ms(), from, to, kind: if write { "memory_write" } else { "memory_read" }.into(), ms: Some(ms), label: label.into() });
    }

    /// Run a CPU / API script as `node` (capped at `TASK_PERMITS` at once): `ACTIVE` while it
    /// runs, `DORMANT` (or `ERROR`) after. Returns the script's result.
    pub async fn run_task<F, T>(&self, node: &'static str, label: &str, f: F) -> Result<T, String>
    where
        F: std::future::Future<Output = Result<T, String>>,
    {
        let _permit = self.tasks.clone().acquire_owned().await.map_err(|_| "arbiter closed")?;
        let t0 = Instant::now();
        {
            let mut i = self.inner.lock().unwrap();
            *i.tasks.entry(node.into()).or_default() += 1;
            *i.runs.entry(node.into()).or_default() += 1;
            i.last_active.insert(node.into(), now_ms());
        }
        self.publish();
        let r = f.await;
        {
            let mut i = self.inner.lock().unwrap();
            if let Some(n) = i.tasks.get_mut(node) {
                *n = n.saturating_sub(1);
            }
            match &r {
                Ok(_) => {
                    i.errors.remove(node);
                }
                Err(e) => {
                    i.errors.insert(node.into(), super::envelope::clip(&super::envelope::one_line(e), 160));
                }
            }
        }
        self.push_handoff(Handoff { at: now_ms(), from: node.into(), to: node.into(), kind: "script".into(), ms: Some(t0.elapsed().as_millis() as u64), label: format!("{label}: {}", if r.is_ok() { "done" } else { "failed" }) });
        self.publish();
        r
    }

    /// Mark a node configured / not (`IDLE / UNCONFIGURED` on the map) with a short why.
    pub fn set_status(&self, node: &str, configured: bool, note: &str) {
        self.inner.lock().unwrap().status.insert(node.into(), (configured, note.into()));
        self.publish();
    }

    pub fn set_vault_open(&self, open: bool) {
        self.inner.lock().unwrap().vault_open = open;
        if open {
            self.inner.lock().unwrap().last_active.insert("finance".into(), now_ms());
        }
        self.publish();
    }

    /// The user is talking to Tony (idle timer reset).
    pub fn touch_foreground(&self) {
        self.inner.lock().unwrap().last_foreground = Some(Instant::now());
    }

    /// Minutes since the last Tony turn (None: none this session).
    pub fn idle_for(&self) -> Option<std::time::Duration> {
        self.inner.lock().unwrap().last_foreground.map(|t| t.elapsed())
    }

    /// One Tony turn finished: end-to-end ms.
    pub fn record_tony_turn(&self, ms: u64) {
        let mut i = self.inner.lock().unwrap();
        push_capped(&mut i.tony_ms, ms, LATENCY_MAX);
        i.last_foreground = Some(Instant::now());
    }

    /// The prompt Tony's model just got: its size as an approximate token count (chars / 4; the
    /// HUD labels it as an estimate).
    pub fn note_context(&self, prompt_chars: usize) {
        self.inner.lock().unwrap().context_tokens = Some((prompt_chars as u64).div_ceil(4));
    }

    pub fn away(&self) -> bool {
        self.inner.lock().unwrap().away
    }

    pub fn set_away_flag(&self, on: bool) {
        self.inner.lock().unwrap().away = on;
        self.publish();
    }

    /// Every node with its live state.
    pub fn nodes(&self) -> Vec<Value> {
        let i = self.inner.lock().unwrap();
        NODES
            .iter()
            .map(|n| {
                let id = n.id.to_string();
                let tasks = i.tasks.get(&id).copied().unwrap_or(0);
                let state = if i.holder.as_deref() == Some(n.id) {
                    NodeState::ActiveToken
                } else if tasks > 0 {
                    NodeState::Active
                } else if i.queued.iter().any(|q| q == n.id) {
                    NodeState::Queued
                } else if n.id == "finance" && !i.vault_open {
                    NodeState::LockedVault
                } else if i.errors.contains_key(&id) {
                    NodeState::Error
                } else {
                    NodeState::Dormant
                };
                let (configured, note) = i.status.get(&id).cloned().unwrap_or((true, String::new()));
                json!({
                    "id": n.id, "label": n.label, "group": n.group, "compute": n.compute, "namespace": n.namespace, "schedule": n.schedule,
                    "state": state, "configured": configured, "note": note,
                    "error": i.errors.get(&id), "runs": i.runs.get(&id).copied().unwrap_or(0), "lastActiveAt": i.last_active.get(&id),
                    "holdingMs": if i.holder.as_deref() == Some(n.id) { i.holder_since.map(|t| t.elapsed().as_millis() as u64) } else { None },
                })
            })
            .collect()
    }

    /// Everything the HUD shows (labels and numbers only).
    pub fn snapshot(&self) -> Value {
        let nodes = self.nodes();
        let i = self.inner.lock().unwrap();
        json!({
            "nodes": nodes,
            "holder": i.holder,
            "queued": i.queued,
            "away": i.away,
            "vaultOpen": i.vault_open,
            "feed": i.feed.iter().rev().take(40).collect::<Vec<_>>(),
            "latency": { "tony": percentiles(&i.tony_ms), "turnaround": percentiles(&i.turnaround_ms) },
            "contextTokens": i.context_tokens,
            "idleSecs": i.last_foreground.map(|t| t.elapsed().as_secs()),
            "taskPermits": TASK_PERMITS,
        })
    }
}

/// Edges the topology draws (valid hand-off paths), `from → to`.
pub const EDGES: [(&str, &str); 24] = [
    ("tony", "prompter"),
    ("prompter", "coder"),
    ("coder", "designer"),
    ("designer", "prompter"),
    ("tony", "librarian"),
    ("prompter", "librarian"),
    ("coder", "librarian"),
    ("designer", "librarian"),
    ("tony", "booking"),
    ("booking", "tony"),
    ("tony", "director"),
    ("director", "tony"),
    ("director", "librarian"),
    ("security", "garbage"),
    ("observer", "security"),
    ("tony", "finance"),
    ("finance", "librarian"),
    ("tony", "ops"),
    ("observer", "tony"),
    ("tony", "bizops"),
    ("bizops", "tony"),
    // The Ops -> Finance hand-off (finance_handoff.rs): a validated ledger write, nothing else.
    ("bizops", "finance"),
    // Trading is isolated: Finance is its only peer (capital, budget limits, P&L, risk posture).
    ("trading", "finance"),
    ("finance", "trading"),
];

// ── Away Mode ───────────────────────────────────────────────────────────────

/// Away Mode on / off: os.json, the GPU slot, the arbiter and the webview, together.
pub fn set_away(os: &super::os_core::OsState, on: bool) -> Result<(), String> {
    os.update(|c| {
        c.scheduler.away_mode = on;
        Ok(())
    })?;
    os.slot.set_away(on);
    get().set_away_flag(on);
    get().push_handoff(Handoff { at: now_ms(), from: "tony".into(), to: "tony".into(), kind: "script".into(), ms: None, label: if on { "Away Mode on: background work gets the GPU" } else { "Away Mode off: Tony has priority again" }.into() });
    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The HUD's snapshot: nodes, token holder, feed, latency, memory tiers and live hardware.
#[tauri::command]
pub fn arbiter_snapshot(os: tauri::State<'_, super::os_core::OsState>, sys: tauri::State<'_, super::system::SysState>) -> Value {
    let mut v = get().snapshot();
    let gpu = super::system::gpu_cached();
    let (cpu, ram_used, ram_total) = super::system::ram_cpu(&sys);
    v["hardware"] = json!({
        "gpu": gpu, "gpuSampler": super::system::gpu_sampler_running(),
        "cpuPct": cpu, "ramUsedMb": ram_used, "ramTotalMb": ram_total,
    });
    v["slot"] = serde_json::to_value(os.slot.view()).unwrap_or(Value::Null);
    v["memory"] = super::memtier::stats();
    v["edges"] = json!(EDGES.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>());
    v
}

/// Deep Inspector (System Map pages 2 and 3): one roster node in full — its live state, its
/// memory namespace in depth (`memtier::detail`; Finance reports only sealed counts, never its
/// contents), the memory lifecycle (graduation TTL, the Garbage Daemon's last purge), its valid
/// upstream / downstream hand-off contracts, and the recent hand-offs it took part in.
#[tauri::command]
pub fn agent_inspect(os: tauri::State<'_, super::os_core::OsState>, node: String) -> Result<Value, String> {
    let def = node_def(&node).ok_or_else(|| format!("unknown node {node}"))?;
    let snap = get().snapshot();
    let live = snap["nodes"].as_array().and_then(|a| a.iter().find(|n| n["id"] == node).cloned()).unwrap_or(Value::Null);
    let roster = os.snapshot().roster;
    let memory = match def.namespace {
        Some("finance") => {
            let v = super::finance_vault::finance_vault_status();
            json!({ "namespace": "finance", "sealed": !v["open"].as_bool().unwrap_or(false), "entries": v["entries"], "hasLedger": v["hasLedger"], "hasKey": v["hasKey"], "idleSecs": v["idleSecs"] })
        }
        Some(ns) => super::memtier::detail(ns, 6).unwrap_or(Value::Null),
        None => Value::Null,
    };
    let feed: Vec<Value> = snap["feed"].as_array().map(|a| a.iter().filter(|h| h["from"] == node || h["to"] == node || h["to"].as_str().is_some_and(|t| def.namespace.is_some_and(|ns| t == format!("mem:{ns}")))).cloned().collect()).unwrap_or_default();
    let g = super::garbage::snapshot();
    Ok(json!({
        "node": def,
        "live": live,
        "memory": memory,
        "lifecycle": {
            "graduateAfterDays": roster.graduate_after_days,
            "dumpKeepDays": roster.dump_keep_days,
            "garbageEveryMinutes": roster.garbage_minutes,
            "lastPurgeAt": g.last_purge_at,
            "vaultIdleMinutes": roster.vault_idle_minutes,
        },
        "upstream": EDGES.iter().filter(|(_, b)| *b == node).map(|(a, _)| *a).collect::<Vec<_>>(),
        "downstream": EDGES.iter().filter(|(a, _)| *a == node).map(|(_, b)| *b).collect::<Vec<_>>(),
        "feed": feed,
        "holder": snap["holder"],
        "away": snap["away"],
    }))
}

#[tauri::command]
pub fn arbiter_set_away(os: tauri::State<'_, super::os_core::OsState>, on: bool) -> Result<Value, String> {
    set_away(&os, on)?;
    if let Some(app) = get().app.get() {
        crate::tray_set_away(app, on);
    }
    Ok(get().snapshot())
}

/// One health check for the whole engine: queue dispatcher, GPU lock, Garbage daemon, Finance
/// vault isolation, and the resident GPU sampler.
#[tauri::command]
pub fn system_health(app: tauri::AppHandle, os: tauri::State<'_, super::os_core::OsState>) -> Value {
    use tauri::Manager;
    let cfg = os.snapshot();
    let mut roots: Vec<std::path::PathBuf> = cfg.fs_roots.iter().map(std::path::PathBuf::from).collect();
    if let Ok(d) = app.path().app_config_dir() {
        roots.push(d);
    }
    let slot = os.slot.view();
    let g = super::garbage::snapshot();
    let garbage_ok = g.running && g.heartbeat_at.map(|t| now_ms().saturating_sub(t) < 2 * super::garbage::TICK.as_millis() as u64 + 60_000).unwrap_or(false);
    let vault = super::finance_vault::isolation_check(&cfg, &roots);
    json!({
        "at": now_ms(),
        "queueDispatcher": super::packet_queue::health(),
        "gpuLock": { "holder": slot.active.first(), "waiting": slot.waiting, "settling": slot.settling, "capacity": slot.capacity, "away": slot.away, "tokenNode": get().snapshot()["holder"] },
        "garbageDaemon": { "ok": garbage_ok, "status": g },
        "financeVault": vault,
        "gpuSampler": super::system::gpu_sampler_running(),
        "ok": garbage_ok && vault["ok"].as_bool().unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::scheduler::SlotView;

    fn view(active: &[&str], waiting: &[&str]) -> SlotView {
        SlotView { active: active.iter().map(|s| s.to_string()).collect(), queued_foreground: 0, queued_background: waiting.len(), capacity: 1, settling: 0, waiting: waiting.iter().map(|s| s.to_string()).collect(), away: false }
    }

    fn state_of(a: &Arbiter, id: &str) -> String {
        a.nodes().into_iter().find(|n| n["id"] == id).unwrap()["state"].as_str().unwrap().to_string()
    }

    #[test]
    fn labels_map_to_nodes() {
        assert_eq!(node_for_label("lmstudio · Tony"), Some("tony"));
        assert_eq!(node_for_label("worker · coder code · lmstudio"), Some("coder"));
        assert_eq!(node_for_label("worker · prompter spec · prompter-dispatcher"), Some("prompter"));
        assert_eq!(node_for_label("anythingllm · booking"), Some("booking"));
        assert_eq!(node_for_label("memory · compact"), Some("librarian"));
        assert_eq!(node_for_label("maintenance · reload"), None);
        assert_eq!(node_for_label("lmstudio · background"), None);
        assert_eq!(node_id("general"), Some("tony"));
        assert_eq!(node_id("financer"), Some("finance"));
        assert_eq!(NODES.len(), 14);
        assert_eq!(node_id("bizops"), Some("bizops"));
        assert_eq!(node_for_label("anythingllm · bizops_trades_contracting"), Some("bizops"));
        assert_eq!(node_for_label("anythingllm · finance"), Some("finance"));
        for (a, b) in EDGES {
            assert!(node_def(a).is_some() && node_def(b).is_some(), "{a} → {b}");
        }
    }

    #[test]
    fn trading_is_isolated_to_finance() {
        assert_eq!(node_id("trading_agent"), Some("trading"));
        assert!(mesh_allows("trading", "finance"));
        assert!(mesh_allows("finance", "trading"));
        for other in ["tony", "librarian", "prompter", "coder", "designer", "director", "booking", "security", "garbage", "observer", "ops", "bizops"] {
            assert!(!mesh_allows("trading", other), "trading -> {other}");
            assert!(!mesh_allows(other, "trading"), "{other} -> trading");
        }
        // The shared mesh keeps its old behaviour (EDGES there are drawn, not enforced).
        assert!(mesh_allows("coder", "tony"));
        let a = Arbiter::default();
        assert!(!a.handoff("tony", "trading", "do a trade"));
        assert!(!a.handoff("trading_agent", "librarian", "fetch"));
        assert!(a.handoff("trading", "financer", "pnl_report"));
        let feed = a.inner.lock().unwrap().feed.clone();
        let edges: Vec<(String, String)> = feed.iter().map(|h| (h.from.clone(), h.to.clone())).collect();
        assert_eq!(edges, vec![("trading".into(), "finance".into())]);
    }

    #[test]
    fn token_passes_are_handoffs_with_turnaround_and_nodes_go_dormant() {
        let a = Arbiter::default();
        assert_eq!(state_of(&a, "finance"), "LOCKED_VAULT");
        a.on_slot(&view(&["worker · prompter spec · lmstudio"], &["worker · coder code · lmstudio"]));
        assert_eq!(state_of(&a, "prompter"), "ACTIVE_TOKEN");
        assert_eq!(state_of(&a, "coder"), "QUEUED");
        a.on_slot(&view(&[], &["worker · coder code · lmstudio"]));
        assert_eq!(state_of(&a, "prompter"), "DORMANT");
        a.on_slot(&view(&["worker · coder code · lmstudio"], &[]));
        assert_eq!(state_of(&a, "coder"), "ACTIVE_TOKEN");
        let feed = a.inner.lock().unwrap().feed.clone();
        let kinds: Vec<(String, String)> = feed.iter().map(|h| (h.from.clone(), h.to.clone())).collect();
        assert_eq!(kinds, vec![("idle".into(), "prompter".into()), ("prompter".into(), "idle".into()), ("prompter".into(), "coder".into())]);
        assert!(feed[2].ms.is_some(), "turnaround measured");
        a.set_vault_open(true);
        assert_eq!(state_of(&a, "finance"), "DORMANT");
    }

    #[test]
    fn scripts_are_active_then_dormant_or_error() {
        tauri::async_runtime::block_on(async {
            let a = Arbiter::default();
            let r: Result<u8, String> = a.run_task("garbage", "purge", async { Ok(1) }).await;
            assert_eq!(r, Ok(1));
            assert_eq!(state_of(&a, "garbage"), "DORMANT");
            let r: Result<u8, String> = a.run_task("observer", "audit", async { Err("tasks.db unreadable".into()) }).await;
            assert!(r.is_err());
            assert_eq!(state_of(&a, "observer"), "ERROR");
        });
    }

    #[test]
    fn latency_percentiles() {
        let a = Arbiter::default();
        for ms in [100, 200, 300, 400, 1000] {
            a.record_tony_turn(ms);
        }
        a.note_context(4000);
        let s = a.snapshot();
        assert_eq!(s["latency"]["tony"]["p50"], 300);
        assert_eq!(s["latency"]["tony"]["n"], 5);
        assert_eq!(s["contextTokens"], 1000);
    }
}
