//! Out-of-band Diagnostic & Load Probe runner (System Map · Schematic Flowchart panel).
//!
//! Pings one or many roster nodes at once at one of three intensities and streams per-node timing
//! (`diag-probe`) plus a run summary (`diag-run`) with peak hardware. Contract:
//! `src/features/sysmap/diagnostics.contract.ts`.
//!
//! **Ephemeral by construction.** Every probe is tagged `{ diagnostic: true, ephemeral: true }`
//! (the `Probe` struct and the `X-Diagnostic` / `X-Ephemeral` headers on the model call). A probe:
//! - never goes through `Arbiter::run_task` (which counts `runs`) — CPU probes take a raw
//!   `Arbiter::probe_permit` (same semaphore, real contention, nothing counted);
//! - takes the GPU slot as `diagnostic · probe <node>`, which `arbiter::node_for_label` maps to NO
//!   node, so the token never "passes" to the node and its `runs` never move;
//! - never writes memtier (`put`) and reads only through `memtier::peek` (no hit / `last_hit`
//!   bump, no arbiter memory pulse), so RAG `active` / `archived` (disk) counts never move;
//! - calls LM Studio directly with the model already loaded (no AnythingLLM workspace, no
//!   gateway, no conversation memory, no second model load);
//! - never calls n8n / the vault / any webhook (Booking and Finance get the CPU profile).
//!
//! Synthetic prompts and replies are dropped as soon as their timing is taken; only numbers leave.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use super::arbiter;
use super::dispatch::DispatchState;
use super::os_core::OsState;
use super::system::SysState;

pub const PROBE_EVENT: &str = "diag-probe";
pub const RUN_EVENT: &str = "diag-run";
const MAX_NODES: usize = 16;
const SAMPLE_MS: u64 = 250;
/// nvidia-smi one-shots are spaced out more than the CPU/RAM samples (each is a process spawn).
const GPU_SAMPLE_MS: u64 = 500;

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Intensity {
    Light,
    Medium,
    Heavy,
}

impl Intensity {
    fn default_timeout(self) -> Duration {
        Duration::from_secs(match self {
            Intensity::Light => 5,
            Intensity::Medium => 60,
            Intensity::Heavy => 180,
        })
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiagRunArgs {
    pub nodes: Vec<String>,
    pub intensity: Intensity,
    #[serde(default)]
    pub stagger_ms: BTreeMap<String, u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Preset label for the report (`daemons` · `daily` · `dual` · `stress`), when one was used.
    #[serde(default)]
    pub preset: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HwPeak {
    pub cpu_pct: f32,
    pub ram_used_gb: f64,
    pub gpu_util_pct: Option<f32>,
    pub vram_used_mb: Option<u64>,
    pub vram_total_mb: Option<u64>,
}

impl HwPeak {
    fn max(self, o: HwPeak) -> HwPeak {
        let mo = |a: Option<f32>, b: Option<f32>| match (a, b) {
            (Some(x), Some(y)) => Some(x.max(y)),
            (x, y) => x.or(y),
        };
        let mu = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (Some(x), Some(y)) => Some(x.max(y)),
            (x, y) => x.or(y),
        };
        HwPeak { cpu_pct: self.cpu_pct.max(o.cpu_pct), ram_used_gb: self.ram_used_gb.max(o.ram_used_gb), gpu_util_pct: mo(self.gpu_util_pct, o.gpu_util_pct), vram_used_mb: mu(self.vram_used_mb, o.vram_used_mb), vram_total_mb: mu(self.vram_total_mb, o.vram_total_mb) }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Dispatched,
    Queued,
    Executing,
    Completed,
    Timeout,
    Error,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Gpu,
    Cpu,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEvent {
    pub run_id: String,
    pub node: String,
    pub phase: Phase,
    pub profile: Profile,
    pub at: u64,
    pub queue_wait_ms: Option<u64>,
    pub exec_ms: Option<u64>,
    pub total_rtt_ms: Option<u64>,
    pub tokens_per_sec: Option<f64>,
    pub tokens: Option<u64>,
    pub hw: Option<HwPeak>,
    pub error: Option<String>,
    /// Where the probe's time went (GPU probes: all four phases; CPU / Light probes: queue only).
    pub phases: Option<Phases>,
}

/// One probe's (or Librarian pipeline run's) time split. Every field is measured; a phase that
/// could not be measured is `None`, never estimated.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Phases {
    pub queue_wait_ms: Option<u64>,
    /// Librarian: the read before the model call (probe: the `memtier::peek`). Others: None.
    pub retrieval_ms: Option<u64>,
    /// Request sent → first streamed token (prompt processing + network).
    pub prefill_ms: Option<u64>,
    /// First token → stream end.
    pub generation_ms: Option<u64>,
    /// From the stream's final `usage` chunk (None when the server sent none).
    pub input_tokens: Option<u64>,
    /// `usage.completion_tokens`, else the streamed deltas counted.
    pub output_tokens: Option<u64>,
    /// `output_tokens / generation_ms`.
    pub tokens_per_sec: Option<f64>,
    /// Librarian only: `diagnose` over these phases.
    pub diagnosis: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub intensity: Intensity,
    pub wall_ms: u64,
    pub hw: HwPeak,
    pub baseline: HwPeak,
    pub aborted: bool,
    pub trigger: Trigger,
    /// Where the full report was written (None: the write failed; see stderr).
    pub report_path: Option<String>,
    /// Peak footprint of the agent stack (command-center + children, LM Studio, AnythingLLM,
    /// gateway, Bionic) during the run (None: no process sample landed).
    pub hw_app: Option<super::procstats::Footprint>,
    /// Peak footprint of everything else on the machine during the run.
    pub hw_other: Option<super::procstats::Footprint>,
}

/// Who started a run (recorded in its report).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    Ui,
    Schedule,
    Request,
}

/// The probe itself (never serialised anywhere persistent; the tags are documentation + headers).
struct Probe {
    run_id: String,
    node: &'static str,
    profile: Profile,
    intensity: Intensity,
    #[allow(dead_code)]
    diagnostic: bool,
    #[allow(dead_code)]
    ephemeral: bool,
}

/// GPU-backed probe? Local-inference nodes plus Trading (its judgment layer runs on the local
/// model). Booking (n8n) and Finance (vault) are never called out to: CPU profile (pure).
pub fn profile_for(id: &str) -> Profile {
    match arbiter::node_def(id) {
        Some(d) if d.compute == "gpu" || d.id == "trading" => Profile::Gpu,
        _ => Profile::Cpu,
    }
}

/// The GPU-slot label a probe holds. Must never resolve to a node (`node_for_label`).
pub fn slot_label(node: &str) -> String {
    format!("diagnostic · probe {node}")
}

// ── Runs + abort ────────────────────────────────────────────────────────────

fn runs() -> &'static Mutex<BTreeMap<String, tokio::sync::watch::Sender<bool>>> {
    static R: OnceLock<Mutex<BTreeMap<String, tokio::sync::watch::Sender<bool>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

async fn cancelled(mut rx: tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

// ── Hardware sampling ───────────────────────────────────────────────────────

type Samples = Arc<Mutex<Vec<(Instant, HwPeak)>>>;

fn sample_now(app: &tauri::AppHandle, gpu: Option<super::system::GpuStats>) -> HwPeak {
    let (cpu, ram_used, _) = super::system::ram_cpu(&app.state::<SysState>());
    HwPeak { cpu_pct: cpu, ram_used_gb: ram_used as f64 / 1024.0, gpu_util_pct: gpu.as_ref().map(|g| g.util_pct), vram_used_mb: gpu.as_ref().map(|g| g.vram_used_mb), vram_total_mb: gpu.as_ref().map(|g| g.vram_total_mb) }
}

/// Fresh GPU reading: an nvidia-smi one-shot for Medium/Heavy (the resident sampler only prints
/// every 2 s, too coarse for a spike), the resident sampler's cache for Light.
async fn gpu_reading(fresh: bool) -> Option<super::system::GpuStats> {
    if fresh {
        tauri::async_runtime::spawn_blocking(super::system::query_gpu).await.ok().flatten()
    } else {
        super::system::gpu_cached()
    }
}

/// Peak over a window; falls back to the sample nearest the window's end (short probes).
fn peak_in(samples: &[(Instant, HwPeak)], from: Instant, to: Instant) -> Option<HwPeak> {
    let inside: Vec<HwPeak> = samples.iter().filter(|(t, _)| *t >= from && *t <= to).map(|(_, s)| *s).collect();
    if let Some(first) = inside.first() {
        return Some(inside.iter().skip(1).fold(*first, |a, b| a.max(*b)));
    }
    samples.iter().filter(|(t, _)| *t <= to).last().or(samples.last()).map(|(_, s)| *s)
}

/// Field-wise peak of two footprints (process names merged, capped) (pure).
pub fn footprint_peak(a: Option<super::procstats::Footprint>, b: &super::procstats::Footprint) -> super::procstats::Footprint {
    let Some(mut a) = a else { return b.clone() };
    a.cpu_pct = a.cpu_pct.max(b.cpu_pct);
    a.ram_used_gb = a.ram_used_gb.max(b.ram_used_gb);
    a.gpu_util_pct = match (a.gpu_util_pct, b.gpu_util_pct) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    };
    a.vram_used_mb = match (a.vram_used_mb, b.vram_used_mb) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    };
    for p in &b.processes {
        if a.processes.len() >= 16 {
            break;
        }
        if !a.processes.contains(p) {
            a.processes.push(p.clone());
        }
    }
    a
}

type SplitPeaks = Arc<Mutex<(Option<super::procstats::Footprint>, Option<super::procstats::Footprint>)>>;

fn note_split(peaks: &SplitPeaks, started_at: u64) {
    fold_split(peaks, super::procstats::latest().as_ref(), started_at);
}

/// Fold one app / other split into the run's peaks. A split sampled before the run started (a
/// previous run's, still fresh in the sampler) is ignored (pure).
fn fold_split(peaks: &SplitPeaks, sp: Option<&super::procstats::Split>, started_at: u64) {
    let Some(sp) = sp.filter(|sp| sp.at >= started_at) else { return };
    let mut g = peaks.lock().unwrap();
    g.0 = Some(footprint_peak(g.0.take(), &sp.app));
    g.1 = Some(footprint_peak(g.1.take(), &sp.other));
}

// ── Phase measurement (pure) ────────────────────────────────────────────────

/// `usage` of one OpenAI-style response / stream chunk: `(prompt_tokens, completion_tokens)`.
/// None when the object carries no usage (pure).
pub fn usage_of(v: &serde_json::Value) -> Option<(Option<u64>, Option<u64>)> {
    let u = v.get("usage")?;
    if !u.is_object() {
        return None;
    }
    let (i, o) = (u["prompt_tokens"].as_u64(), u["completion_tokens"].as_u64());
    (i.is_some() || o.is_some()).then_some((i, o))
}

/// What a streamed completion delivered: first / last content time, deltas, and the final
/// `usage` chunk (`stream_options.include_usage`). Only counts and times are kept, never text.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct StreamTally {
    pub first: Option<Instant>,
    pub last: Option<Instant>,
    pub deltas: u64,
    pub usage_in: Option<u64>,
    pub usage_out: Option<u64>,
}

impl StreamTally {
    /// Feed one SSE line received at `now` (pure).
    pub fn feed_line(&mut self, line: &str, now: Instant) {
        let Some(d) = line.trim().strip_prefix("data:").map(str::trim).filter(|d| *d != "[DONE]") else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(d) else { return };
        let delta = &v["choices"][0]["delta"];
        if delta["content"].as_str().or(delta["reasoning_content"].as_str()).is_some_and(|s| !s.is_empty()) {
            self.first.get_or_insert(now);
            self.last = Some(now);
            self.deltas += 1;
        }
        if let Some((i, o)) = usage_of(&v) {
            self.usage_in = i.or(self.usage_in);
            self.usage_out = o.or(self.usage_out);
        }
    }

    /// Output tokens: the server's count, else the deltas counted (None if neither).
    pub fn output_tokens(&self) -> Option<u64> {
        self.usage_out.or((self.deltas > 0).then_some(self.deltas))
    }
}

fn ms(d: Duration) -> u64 {
    d.as_millis() as u64
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// A GPU probe's phases from its stream (pure): prefill = request sent → first token,
/// generation = first token → stream end.
pub fn stream_phases(t: &StreamTally, exec_start: Instant, end: Instant, queue_wait: Duration, retrieval: Option<Duration>) -> Phases {
    let prefill = t.first.map(|f| f.saturating_duration_since(exec_start));
    let generation = t.first.map(|f| end.saturating_duration_since(f));
    let out = t.output_tokens();
    let tps = match (out, generation) {
        (Some(n), Some(g)) if g.as_secs_f64() > 0.0 => Some(round1(n as f64 / g.as_secs_f64())),
        _ => None,
    };
    Phases { queue_wait_ms: Some(ms(queue_wait)), retrieval_ms: retrieval.map(ms), prefill_ms: prefill.map(ms), generation_ms: generation.map(ms), input_tokens: t.usage_in, output_tokens: out, tokens_per_sec: tps, diagnosis: None }
}

/// The prefill / generation split of one NON-streamed completion (pure). Taken from the
/// response's own timing stats when the server sends them (LM Studio's `stats`, llama.cpp's
/// `timings`); otherwise left None and `split_method` says why — never estimated.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSplit {
    pub prefill_ms: Option<u64>,
    pub generation_ms: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Generation-only tokens/s (only when the split is known).
    pub tokens_per_sec: Option<f64>,
    pub split_method: String,
}

pub const SPLIT_UNAVAILABLE: &str = "unavailable: non-streamed call and the response carried no timing stats (modelMs = prefill + generation)";

pub fn split_from_response(v: &serde_json::Value, model_ms: u64) -> ModelSplit {
    let (mut input, mut output) = usage_of(v).unwrap_or((None, None));
    let st = &v["stats"];
    let tm = &v["timings"];
    if let Some(ttft) = st["time_to_first_token"].as_f64().filter(|x| *x >= 0.0) {
        let prefill = (ttft * 1000.0).round() as u64;
        let generation = st["generation_time"].as_f64().filter(|x| *x >= 0.0).map(|g| (g * 1000.0).round() as u64).unwrap_or_else(|| model_ms.saturating_sub(prefill));
        let tps = st["tokens_per_second"].as_f64().map(round1).or_else(|| match output {
            Some(n) if generation > 0 => Some(round1(n as f64 * 1000.0 / generation as f64)),
            _ => None,
        });
        return ModelSplit { prefill_ms: Some(prefill), generation_ms: Some(generation), input_tokens: input, output_tokens: output, tokens_per_sec: tps, split_method: "lmstudio stats (time_to_first_token / generation_time)".into() };
    }
    if let Some(p) = tm["prompt_ms"].as_f64().filter(|x| *x >= 0.0) {
        input = input.or(tm["prompt_n"].as_u64());
        output = output.or(tm["predicted_n"].as_u64());
        let generation = tm["predicted_ms"].as_f64().filter(|x| *x >= 0.0).map(|g| g.round() as u64);
        let tps = tm["predicted_per_second"].as_f64().map(round1).or_else(|| match (output, generation) {
            (Some(n), Some(g)) if g > 0 => Some(round1(n as f64 * 1000.0 / g as f64)),
            _ => None,
        });
        return ModelSplit { prefill_ms: Some(p.round() as u64), generation_ms: generation, input_tokens: input, output_tokens: output, tokens_per_sec: tps, split_method: "llama.cpp timings (prompt_ms / predicted_ms)".into() };
    }
    ModelSplit { prefill_ms: None, generation_ms: None, input_tokens: input, output_tokens: output, tokens_per_sec: None, split_method: SPLIT_UNAVAILABLE.into() }
}

// ── Librarian diagnosis (proposal §3) ───────────────────────────────────────

/// Input tokens above which a prefill-heavy run is "oversized context".
pub const HIGH_INPUT_TOKENS: u64 = 2_000;
/// Below this generation speed the run is not "normal tok/s" (healthy runs: 22–27 tok/s).
pub const NORMAL_TOK_S: f64 = 15.0;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DiagInput {
    pub total_ms: u64,
    pub queue_ms: Option<u64>,
    pub retrieval_ms: Option<u64>,
    pub prefill_ms: Option<u64>,
    pub generation_ms: Option<u64>,
    /// prefill + generation as one number (when the split is unknown).
    pub model_ms: Option<u64>,
    pub input_tokens: Option<u64>,
    pub tokens_per_sec: Option<f64>,
    pub vram_pct: Option<f64>,
}

/// The proposal's rule, first match in its order (pure):
/// retrieval > 30 % → "retrieval / disk"; prefill > 40 % with high inputTokens → "oversized
/// context"; queue > 50 % → "scheduling"; generation dominates at normal tok/s with VRAM < 90 %
/// → "genuine compute". None when there is no total to divide by.
pub fn diagnose(d: &DiagInput) -> Option<String> {
    if d.total_ms == 0 {
        return None;
    }
    let f = |x: Option<u64>| x.map(|v| v as f64 / d.total_ms as f64).unwrap_or(0.0);
    let (q, r, p, g) = (f(d.queue_ms), f(d.retrieval_ms), f(d.prefill_ms), f(d.generation_ms));
    if r > 0.30 {
        return Some("retrieval / disk".into());
    }
    if p > 0.40 && d.input_tokens.is_some_and(|t| t >= HIGH_INPUT_TOKENS) {
        return Some("oversized context".into());
    }
    if q > 0.50 {
        return Some("scheduling".into());
    }
    if d.generation_ms.is_some() && g >= q.max(r).max(p) && g >= 0.40 {
        return Some(match (d.tokens_per_sec, d.vram_pct) {
            (Some(t), _) if t < NORMAL_TOK_S => "slow generation (below normal tok/s: check VRAM spill or a concurrent generation)".into(),
            (_, Some(v)) if v >= 90.0 => "VRAM pressure (generation dominates with VRAM >= 90 %)".into(),
            (Some(_), Some(_)) => "genuine compute".into(),
            _ => "genuine compute (tok/s or VRAM not sampled)".into(),
        });
    }
    if d.prefill_ms.is_none() && f(d.model_ms) > 0.50 {
        return Some("model time dominates (prefill / generation split unavailable)".into());
    }
    Some("no dominant phase".into())
}

// ── Librarian pipeline profiles (ring of the last 50) ───────────────────────

pub const PROFILES_MAX: usize = 50;

/// One Librarian pipeline run (real worker stage or diagnostic probe). Labels and numbers only.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LibrarianRun {
    /// `worker` | `probe`.
    pub source: &'static str,
    /// `preflight` | `audit` | `probe`.
    pub stage: String,
    pub task_id: Option<String>,
    pub at: u64,
    /// `ok` | `fallback` (the model call failed; the gathered packet stood in).
    pub outcome: &'static str,
    pub by: Option<String>,
    pub total_ms: u64,
    pub queue_wait_ms: Option<u64>,
    pub retrieval_ms: Option<u64>,
    pub research_ms: Option<u64>,
    pub forensic_ms: Option<u64>,
    pub files_walked: Option<u64>,
    pub bytes_read: Option<u64>,
    pub hits: BTreeMap<String, usize>,
    pub packet_chars: Option<usize>,
    pub packet_items: Option<usize>,
    /// Wall time of the model request (prefill + generation).
    pub model_ms: Option<u64>,
    pub split: ModelSplit,
    pub max_output_tokens: Option<u32>,
    pub vram_pct: Option<f64>,
}

impl LibrarianRun {
    pub fn diag_input(&self) -> DiagInput {
        // Disk time = the local gather + any forensic archive read.
        let retrieval = match (self.retrieval_ms, self.forensic_ms) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        DiagInput { total_ms: self.total_ms, queue_ms: self.queue_wait_ms, retrieval_ms: retrieval, prefill_ms: self.split.prefill_ms, generation_ms: self.split.generation_ms, model_ms: self.model_ms, input_tokens: self.split.input_tokens, tokens_per_sec: self.split.tokens_per_sec, vram_pct: self.vram_pct }
    }
}

/// The profile JSON (pure): every phase, its share of the total, and the diagnosis.
pub fn librarian_profile(r: &LibrarianRun) -> serde_json::Value {
    let share = |x: Option<u64>| x.filter(|_| r.total_ms > 0).map(|v| round1(v as f64 * 100.0 / r.total_ms as f64));
    let e2e = match (r.split.output_tokens, r.model_ms) {
        (Some(n), Some(m)) if m > 0 => Some(round1(n as f64 * 1000.0 / m as f64)),
        _ => None,
    };
    json!({
        "source": r.source,
        "stage": r.stage,
        "taskId": r.task_id,
        "at": r.at,
        "outcome": r.outcome,
        "by": r.by,
        "totalMs": r.total_ms,
        "queueWaitMs": r.queue_wait_ms,
        "retrievalMs": r.retrieval_ms,
        "researchMs": r.research_ms,
        "forensicMs": r.forensic_ms,
        "filesWalked": r.files_walked,
        "bytesRead": r.bytes_read,
        "hits": r.hits,
        "packetChars": r.packet_chars,
        "packetItems": r.packet_items,
        "modelMs": r.model_ms,
        "prefillMs": r.split.prefill_ms,
        "generationMs": r.split.generation_ms,
        "inputTokens": r.split.input_tokens,
        "outputTokens": r.split.output_tokens,
        "tokPerSec": r.split.tokens_per_sec,
        "endToEndTokPerSec": e2e,
        "splitMethod": r.split.split_method,
        "maxOutputTokens": r.max_output_tokens,
        "vramPct": r.vram_pct,
        "sharePct": { "queue": share(r.queue_wait_ms), "retrieval": share(r.retrieval_ms), "prefill": share(r.split.prefill_ms), "generation": share(r.split.generation_ms), "model": share(r.model_ms) },
        "diagnosis": diagnose(&r.diag_input()),
    })
}

fn profiles() -> &'static Mutex<std::collections::VecDeque<serde_json::Value>> {
    static P: OnceLock<Mutex<std::collections::VecDeque<serde_json::Value>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// Keep a profile (ring of `PROFILES_MAX`) and emit it as a `librarian` live event.
pub fn record_librarian(r: &LibrarianRun) -> serde_json::Value {
    let v = librarian_profile(r);
    {
        let mut p = profiles().lock().unwrap_or_else(|e| e.into_inner());
        p.push_back(v.clone());
        while p.len() > PROFILES_MAX {
            p.pop_front();
        }
    }
    super::live::event("librarian", v.clone());
    v
}

/// The recent Librarian pipeline profiles, oldest first (at most `PROFILES_MAX`).
pub fn librarian_profiles() -> Vec<serde_json::Value> {
    profiles().lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

/// VRAM use (%) of a peak sample.
fn vram_pct(h: Option<HwPeak>) -> Option<f64> {
    match h {
        Some(HwPeak { vram_used_mb: Some(u), vram_total_mb: Some(t), .. }) if t > 0 => Some(round1(u as f64 * 100.0 / t as f64)),
        _ => None,
    }
}

// ── Workloads ───────────────────────────────────────────────────────────────

const FILLER: &str = "Synthetic diagnostic context. The schematic routes hand-offs from the orchestrator to specialists over coloured buses; \
the GPU token passes between local-inference nodes while CPU daemons audit hand-off integrity, scan for injected instructions and purge stale dumps. \
This paragraph carries no user data and is discarded after timing. ";

fn synthetic_context(chars: usize) -> String {
    let mut s = String::with_capacity(chars + FILLER.len());
    let mut i = 0u32;
    while s.len() < chars {
        s.push_str(&format!("[{i}] "));
        s.push_str(FILLER);
        i += 1;
    }
    s
}

/// CPU daemon workload: the real secret / injection scanner + hashing over synthetic text.
fn cpu_work(intensity: Intensity) -> u64 {
    use sha2::{Digest, Sha256};
    let (rounds, chars): (u32, usize) = match intensity {
        Intensity::Light => (1, 256),
        Intensity::Medium => (300, 4_000),
        Intensity::Heavy => (2_500, 8_000),
    };
    let text = synthetic_context(chars);
    let mut acc = 0u64;
    let mut h = Sha256::new();
    for r in 0..rounds {
        acc += super::security_gate::scan_secrets(&text, &[]).len() as u64;
        h.update(text.as_bytes());
        h.update(r.to_le_bytes());
    }
    let d = h.finalize();
    acc ^ d[0] as u64
}

struct Outcome {
    queue_wait: Duration,
    exec: Duration,
    exec_start: Instant,
    tokens: Option<u64>,
    tok_s: Option<f64>,
    phases: Phases,
}

/// CPU / Light probes: only the queue phase exists.
fn queue_only(queue_wait: Duration) -> Phases {
    Phases { queue_wait_ms: Some(ms(queue_wait)), ..Default::default() }
}

type Emit = Arc<dyn Fn(Phase, Option<u64>) + Send + Sync>;

async fn run_light(app: &tauri::AppHandle, emit: &Emit) -> Result<Outcome, String> {
    // Wake latency: how long the async runtime takes to start a fresh task (routing / thread health).
    let t0 = Instant::now();
    let woke = tauri::async_runtime::spawn(async { Instant::now() }).await.map_err(|e| e.to_string())?;
    let queue_wait = woke.duration_since(t0);
    emit(Phase::Queued, Some(queue_wait.as_millis() as u64));
    emit(Phase::Executing, Some(queue_wait.as_millis() as u64));
    let exec_start = Instant::now();
    // Daemon responsiveness: the arbiter's registry lock + the GPU slot view (what every hand-off touches).
    let n = arbiter::get().nodes().len();
    let _ = app.state::<OsState>().slot.view();
    let _ = std::hint::black_box(n);
    Ok(Outcome { queue_wait, exec: exec_start.elapsed(), exec_start, tokens: None, tok_s: None, phases: queue_only(queue_wait) })
}

async fn run_cpu(p: &Probe, emit: &Emit) -> Result<Outcome, String> {
    let t0 = Instant::now();
    emit(Phase::Queued, None);
    let permit = arbiter::get().probe_permit().await?;
    let queue_wait = t0.elapsed();
    emit(Phase::Executing, Some(queue_wait.as_millis() as u64));
    let exec_start = Instant::now();
    let intensity = p.intensity;
    let r = tauri::async_runtime::spawn_blocking(move || cpu_work(intensity)).await.map_err(|e| e.to_string());
    drop(permit);
    let _ = std::hint::black_box(r?);
    Ok(Outcome { queue_wait, exec: exec_start.elapsed(), exec_start, tokens: None, tok_s: None, phases: queue_only(queue_wait) })
}

async fn run_gpu(app: &tauri::AppHandle, p: &Probe, emit: &Emit) -> Result<Outcome, String> {
    use futures_util::StreamExt;
    let ds = app.state::<DispatchState>();
    let prov = ds.provider("lmstudio").ok_or("no lmstudio provider configured")?;
    let base = url::Url::parse(&prov.base_url).map_err(|e| e.to_string())?.origin().ascii_serialization();
    let model = prov.model.clone();
    if model.trim().is_empty() {
        return Err("lmstudio provider has no model set".into());
    }
    // Librarian: a simulated RAG read, read-only (no hit counters, no pulse). Timed: its
    // retrieval phase.
    let (rag, retrieval) = if p.node == "librarian" {
        let deep = p.intensity == Intensity::Heavy;
        let r0 = Instant::now();
        let n = super::memtier::peek("librarian", "schematic hand-off memory recall agent", 8, 4_000, deep).len();
        (n, Some(r0.elapsed()))
    } else {
        (0, None)
    };
    // A per-probe nonce leads the prompt so LM Studio's prefix cache can't reuse another node's
    // prompt processing: every Heavy probe pays its full ~4k-token prefill, like a real turn.
    let nonce = format!("probe {} · run {} · {}", p.node, p.run_id, arbiter::now_ms());
    let (system, ctx, ask, max_tokens) = match p.intensity {
        Intensity::Heavy => (
            "You are a diagnostic probe. Answer at length.",
            synthetic_context(16_000),
            "Write a detailed, multi-paragraph technical summary (at least 300 words) of the context above.",
            384,
        ),
        _ => ("You are a diagnostic probe. Reply briefly.", String::new(), "Reply with one short sentence.", 48),
    };
    let body = json!({
        "model": model, "stream": true, "stream_options": { "include_usage": true }, "max_tokens": max_tokens, "temperature": 0.2, "reasoning_effort": "none",
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("[{nonce}]\n{ctx}\n\nDiagnostic ping for node {} ({} RAG rows peeked). {ask}", p.node, rag) },
        ]
    });
    drop(ctx);

    let os = app.state::<OsState>();
    let t0 = Instant::now();
    emit(Phase::Queued, None);
    let mut guard = os.slot.acquire(&slot_label(p.node), p.node == "tony", os.snapshot().scheduler.tony_priority_pct).await;
    let queue_wait = t0.elapsed();
    emit(Phase::Executing, Some(queue_wait.as_millis() as u64));
    // Dropped mid-generation (abort / timeout): keep the slot briefly so the next holder never runs
    // alongside a generation LM Studio is still finishing.
    guard.arm_settle(Duration::from_millis(1500));
    let exec_start = Instant::now();
    let r = ds
        .http
        .post(format!("{base}/v1/chat/completions"))
        .header("X-Diagnostic", "true")
        .header("X-Ephemeral", "true")
        .json(&body)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(super::dispatch::short)?;
    drop(body);
    if !r.status().is_success() {
        return Err(format!("LM Studio HTTP {}", r.status().as_u16()));
    }
    // Count the pieces and read the final usage chunk; keep no text.
    let mut tally = StreamTally::default();
    let mut buf = String::new();
    let mut stream = r.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(super::dispatch::short)?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            tally.feed_line(&line, Instant::now());
        }
    }
    if !buf.trim().is_empty() {
        tally.feed_line(&buf, Instant::now());
    }
    buf.clear();
    guard.disarm();
    drop(guard);
    let end = Instant::now();
    let exec = end.duration_since(exec_start);
    let tokens = tally.deltas;
    if tokens == 0 {
        return Err("no tokens came back".into());
    }
    let gen = tally.first.map(|f| end.duration_since(f)).unwrap_or(exec).as_secs_f64();
    let tok_s = if gen > 0.0 { Some((tokens as f64 / gen * 10.0).round() / 10.0) } else { None };
    let phases = stream_phases(&tally, exec_start, end, queue_wait, retrieval);
    Ok(Outcome { queue_wait, exec, exec_start, tokens: Some(tokens), tok_s, phases })
}

// ── Command ─────────────────────────────────────────────────────────────────

/// Fire a probe burst. Returns the run id at once; results stream as `diag-probe` / `diag-run`.
#[tauri::command]
pub fn diag_run(app: tauri::AppHandle, args: DiagRunArgs) -> Result<String, String> {
    start_run(app, args, Trigger::Ui)
}

/// The one run path (UI, schedule, file-drop request). Every finished run writes its report to
/// disk (`<config>/telemetry/diagnostics/reports/<runId>.json` + `latest.json`) before the
/// `diag-run` event, so a webview reload can never lose it.
pub fn start_run(app: tauri::AppHandle, args: DiagRunArgs, trigger: Trigger) -> Result<String, String> {
    let mut nodes: Vec<&'static str> = vec![];
    for n in &args.nodes {
        let id = arbiter::node_def(n).map(|d| d.id).ok_or_else(|| format!("unknown node {n}"))?;
        if !nodes.contains(&id) {
            nodes.push(id);
        }
    }
    if nodes.is_empty() {
        return Err("pick at least one node".into());
    }
    if nodes.len() > MAX_NODES {
        return Err(format!("at most {MAX_NODES} nodes per run"));
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let run_id = format!("diag-{}-{}", arbiter::now_ms(), SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    let (tx, rx) = tokio::sync::watch::channel(false);
    runs().lock().unwrap().insert(run_id.clone(), tx);
    let timeout = args.timeout_ms.map(Duration::from_millis).unwrap_or_else(|| args.intensity.default_timeout());
    let intensity = args.intensity;
    let stagger = args.stagger_ms;
    let preset = args.preset;
    let id = run_id.clone();
    let node_list: Vec<String> = nodes.iter().map(|n| n.to_string()).collect();

    tauri::async_runtime::spawn(async move {
        // Per-process sampling (app vs other) runs only while this guard lives: the whole run.
        let _procstats = super::procstats::acquire();
        let started_at = arbiter::now_ms();
        let counters_before = counters();
        let slot_before = serde_json::to_value(app.state::<OsState>().slot.view()).unwrap_or_default();
        let slot_detail_before = serde_json::to_value(app.state::<OsState>().slot.detail()).unwrap_or_default();
        let policy_in_force = serde_json::to_value(&*super::policy::current()).unwrap_or_default();
        let fresh_gpu = intensity != Intensity::Light;
        let baseline = sample_now(&app, gpu_reading(fresh_gpu).await);
        let samples: Samples = Arc::new(Mutex::new(vec![(Instant::now(), baseline)]));
        let split_peaks: SplitPeaks = Arc::new(Mutex::new((None, None)));
        note_split(&split_peaks, started_at);
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        // Sampler: CPU/RAM every 250 ms, GPU every 500 ms (Medium/Heavy) or cached (Light), and the
        // latest app / other split (procstats, ~1 s period) each tick.
        let sampler = {
            let app = app.clone();
            let samples = samples.clone();
            let split_peaks = split_peaks.clone();
            tauri::async_runtime::spawn(async move {
                let mut last_gpu: Option<(Instant, Option<super::system::GpuStats>)> = None;
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(SAMPLE_MS)) => {}
                        _ = cancelled(stop_rx.clone()) => break,
                    }
                    let gpu = match &last_gpu {
                        Some((at, g)) if at.elapsed() < Duration::from_millis(GPU_SAMPLE_MS) => g.clone(),
                        _ => {
                            let g = gpu_reading(fresh_gpu).await;
                            last_gpu = Some((Instant::now(), g.clone()));
                            g
                        }
                    };
                    let s = sample_now(&app, gpu);
                    samples.lock().unwrap().push((Instant::now(), s));
                    note_split(&split_peaks, started_at);
                }
            })
        };

        let run_t0 = Instant::now();
        let mut handles = vec![];
        for node in nodes {
            let app = app.clone();
            let rx = rx.clone();
            let samples = samples.clone();
            let run_id = id.clone();
            let delay = stagger.get(node).copied().unwrap_or(0);
            handles.push(tauri::async_runtime::spawn(async move {
                if delay > 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                        _ = cancelled(rx.clone()) => {}
                    }
                }
                let p = Probe { run_id: run_id.clone(), node, profile: profile_for(node), intensity, diagnostic: true, ephemeral: true };
                let ev = |phase: Phase| ProbeEvent { run_id: p.run_id.clone(), node: p.node.into(), phase, profile: p.profile, at: arbiter::now_ms(), queue_wait_ms: None, exec_ms: None, total_rtt_ms: None, tokens_per_sec: None, tokens: None, hw: None, error: None, phases: None };
                send_probe(&app, &ev(Phase::Dispatched));
                let t0 = Instant::now();
                let emit: Emit = {
                    let app = app.clone();
                    let (run_id, node, profile) = (p.run_id.clone(), p.node, p.profile);
                    Arc::new(move |phase, qw| {
                        send_probe(&app, &ProbeEvent { run_id: run_id.clone(), node: node.into(), phase, profile, at: arbiter::now_ms(), queue_wait_ms: qw, exec_ms: None, total_rtt_ms: None, tokens_per_sec: None, tokens: None, hw: None, error: None, phases: None });
                    })
                };
                let work = async {
                    if *rx.borrow() {
                        return Err("aborted".to_string());
                    }
                    match (intensity, p.profile) {
                        (Intensity::Light, _) => run_light(&app, &emit).await,
                        (_, Profile::Cpu) => run_cpu(&p, &emit).await,
                        (_, Profile::Gpu) => run_gpu(&app, &p, &emit).await,
                    }
                };
                let res = tokio::select! {
                    r = tokio::time::timeout(timeout, work) => r.map_err(|_| None).and_then(|r| r.map_err(Some)),
                    _ = cancelled(rx.clone()) => Err(Some("aborted".to_string())),
                };
                let end = Instant::now();
                let total = t0.elapsed().as_millis() as u64;
                let mut out = ev(Phase::Completed);
                out.total_rtt_ms = Some(total);
                match res {
                    Ok(o) => {
                        out.queue_wait_ms = Some(o.queue_wait.as_millis() as u64);
                        out.exec_ms = Some(o.exec.as_millis() as u64);
                        out.tokens = o.tokens;
                        out.tokens_per_sec = o.tok_s;
                        out.hw = peak_in(&samples.lock().unwrap(), o.exec_start, end);
                        let mut phases = o.phases;
                        if p.node == "librarian" && p.profile == Profile::Gpu && intensity != Intensity::Light {
                            let run = probe_librarian_run(&phases, total, vram_pct(out.hw));
                            phases.diagnosis = diagnose(&run.diag_input());
                            record_librarian(&run);
                        }
                        out.phases = Some(phases);
                    }
                    Err(None) => {
                        out.phase = Phase::Timeout;
                        out.error = Some(format!("no answer within {} ms", timeout.as_millis()));
                        out.hw = peak_in(&samples.lock().unwrap(), t0, end);
                    }
                    Err(Some(e)) => {
                        out.phase = Phase::Error;
                        out.error = Some(super::envelope::clip(&super::envelope::one_line(&e), 160));
                        out.hw = peak_in(&samples.lock().unwrap(), t0, end);
                    }
                }
                send_probe(&app, &out);
                out
            }));
        }
        let mut probes = vec![];
        for h in handles {
            if let Ok(p) = h.await {
                probes.push(p);
            }
        }
        let wall_ms = run_t0.elapsed().as_millis() as u64;
        let _ = stop_tx.send(true);
        let _ = sampler.await;
        let aborted = runs().lock().unwrap().get(&id).map(|tx| *tx.borrow()).unwrap_or(false);
        let hw = samples.lock().unwrap().iter().fold(baseline, |a, (_, s)| a.max(*s));
        // Synthetic samples gone with the run.
        samples.lock().unwrap().clear();
        note_split(&split_peaks, started_at);
        let (hw_app, hw_other) = std::mem::take(&mut *split_peaks.lock().unwrap());
        let mut summary = RunSummary { run_id: id.clone(), intensity, wall_ms, hw, baseline, aborted, trigger, report_path: None, hw_app, hw_other };
        let profiles = librarian_profiles();
        let recent_profiles = &profiles[profiles.len().saturating_sub(REPORT_PROFILES)..];
        let report = build_report(ReportInput {
            summary: &summary,
            preset: preset.as_deref(),
            nodes: &node_list,
            stagger: &stagger,
            timeout_ms: timeout.as_millis() as u64,
            started_at,
            probes: &probes,
            counters_before: &counters_before,
            counters_after: &counters(),
            slot_before: &slot_before,
            slot_detail_before: &slot_detail_before,
            policy: &policy_in_force,
            librarian_profiles: recent_profiles,
        });
        match write_report(&id, &report) {
            Ok(p) => summary.report_path = Some(p.display().to_string()),
            Err(e) => eprintln!("[diagnostics] report not saved: {e}"),
        }
        // Released only after the report is on disk (the schedule / request loop waits on this).
        runs().lock().unwrap().remove(&id);
        super::live::event("run", serde_json::to_value(&summary).unwrap_or_default());
        let _ = app.emit(RUN_EVENT, summary);
    });
    Ok(run_id)
}

/// Librarian profiles carried in each run report.
pub const REPORT_PROFILES: usize = 10;

/// One probe event to the webview (`diag-probe`) and the live stream (`probe`).
fn send_probe(app: &tauri::AppHandle, ev: &ProbeEvent) {
    super::live::event("probe", serde_json::to_value(ev).unwrap_or_default());
    let _ = app.emit(PROBE_EVENT, ev.clone());
}

/// The probe Librarian as a pipeline profile (pure): retrieval = the memtier peek, the model
/// phases from its stream.
fn probe_librarian_run(ph: &Phases, total_ms: u64, vram_pct: Option<f64>) -> LibrarianRun {
    let model_ms = match (ph.prefill_ms, ph.generation_ms) {
        (Some(a), Some(b)) => Some(a + b),
        _ => None,
    };
    LibrarianRun {
        source: "probe",
        stage: "probe".into(),
        at: arbiter::now_ms(),
        outcome: "ok",
        by: Some("lmstudio-direct (diagnostic)".into()),
        total_ms,
        queue_wait_ms: ph.queue_wait_ms,
        retrieval_ms: ph.retrieval_ms,
        model_ms,
        split: ModelSplit { prefill_ms: ph.prefill_ms, generation_ms: ph.generation_ms, input_tokens: ph.input_tokens, output_tokens: ph.output_tokens, tokens_per_sec: ph.tokens_per_sec, split_method: "stream (time to first token)".into() },
        vram_pct,
        ..Default::default()
    }
}

/// Abort one run (or every run with `None`): in-flight probes drop their HTTP stream and slot guard.
#[tauri::command]
pub fn diag_abort(run_id: Option<String>) -> bool {
    let r = runs().lock().unwrap();
    let mut any = false;
    for (id, tx) in r.iter() {
        if run_id.as_deref().is_none_or(|w| w == id) {
            let _ = tx.send(true);
            any = true;
        }
    }
    any
}

// ── Persistent reports ──────────────────────────────────────────────────────
//
// `<config>/telemetry/diagnostics/`:
//   reports/<runId>.json   one full report per finished run (newest MAX_REPORTS kept)
//   latest.json            copy of the newest report
//   schedule.json          the background schedule (diag_schedule_set)
//   request.json           drop one here to run on demand (consumed within ~5 s)
//   last-request.json      what happened to the last request (run id or error)
// These are the user's own diagnostic records: no agent memory, RAG or counter is touched.

pub const MAX_REPORTS: usize = 500;
const LOOP_TICK: Duration = Duration::from_secs(5);

static DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

pub fn telemetry_dir() -> Option<&'static std::path::Path> {
    DIR.get().map(|p| p.as_path())
}

/// Point reports at `<config dir>/telemetry/diagnostics`, load the schedule, start the
/// schedule / request loop (lib.rs setup).
pub fn init(app: &tauri::AppHandle, config_dir: &std::path::Path) {
    let d = config_dir.join("telemetry").join("diagnostics");
    let _ = std::fs::create_dir_all(d.join("reports"));
    let _ = DIR.set(d);
    *schedule_cell().lock().unwrap() = load_schedule();
    tauri::async_runtime::spawn(daemon_loop(app.clone()));
}

/// Every node's `runs` plus every memtier namespace's counts (read-only), for before/after proof.
fn counters() -> serde_json::Value {
    let runs: BTreeMap<String, u64> = arbiter::get().nodes().iter().filter_map(|n| Some((n["id"].as_str()?.to_string(), n["runs"].as_u64().unwrap_or(0)))).collect();
    json!({ "runs": runs, "memory": super::memtier::stats() })
}

/// What moved between two `counters()` snapshots (pure). Empty = nothing changed.
pub fn counter_changes(before: &serde_json::Value, after: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut out = vec![];
    if let (Some(b), Some(a)) = (before["runs"].as_object(), after["runs"].as_object()) {
        for (k, bv) in b {
            let av = a.get(k).cloned().unwrap_or(json!(0));
            if *bv != av {
                out.push(json!({ "counter": format!("runs.{k}"), "before": bv, "after": av }));
            }
        }
    }
    let rows = |v: &serde_json::Value| -> BTreeMap<String, serde_json::Value> { v.as_array().into_iter().flatten().filter_map(|r| Some((r["namespace"].as_str()?.to_string(), r.clone()))).collect() };
    let (b, a) = (rows(&before["memory"]), rows(&after["memory"]));
    for (ns, br) in &b {
        for field in ["active", "archived", "activeKb"] {
            let (bv, av) = (&br[field], a.get(ns).map(|r| r[field].clone()).unwrap_or_default());
            if *bv != av {
                out.push(json!({ "counter": format!("memory.{ns}.{field}"), "before": bv, "after": av }));
            }
        }
    }
    out
}

pub struct ReportInput<'a> {
    pub summary: &'a RunSummary,
    pub preset: Option<&'a str>,
    pub nodes: &'a [String],
    pub stagger: &'a BTreeMap<String, u64>,
    pub timeout_ms: u64,
    pub started_at: u64,
    pub probes: &'a [ProbeEvent],
    pub counters_before: &'a serde_json::Value,
    pub counters_after: &'a serde_json::Value,
    pub slot_before: &'a serde_json::Value,
    /// `GpuSlot::detail()` at the start (holders / waiters with tiers, breaker, Tier-1 p95).
    pub slot_detail_before: &'a serde_json::Value,
    /// The orchestrator policy in force for the run.
    pub policy: &'a serde_json::Value,
    /// The most recent Librarian pipeline profiles (oldest first).
    pub librarian_profiles: &'a [serde_json::Value],
}

/// The full raw report written to disk (pure).
pub fn build_report(i: ReportInput) -> serde_json::Value {
    let s = i.summary;
    let changes = counter_changes(i.counters_before, i.counters_after);
    let vram_spike = match (s.hw.vram_used_mb, s.baseline.vram_used_mb) {
        (Some(p), Some(b)) => Some(p.saturating_sub(b)),
        _ => None,
    };
    let headroom = match (s.hw.vram_total_mb, s.hw.vram_used_mb) {
        (Some(t), Some(u)) => Some(t.saturating_sub(u)),
        _ => None,
    };
    let peak_pct = match (s.hw.vram_total_mb, s.hw.vram_used_mb) {
        (Some(t), Some(u)) if t > 0 => Some((u as f64 / t as f64 * 1000.0).round() / 10.0),
        _ => None,
    };
    let slowest = i.probes.iter().max_by_key(|p| p.total_rtt_ms.unwrap_or(0)).map(|p| json!({ "node": p.node, "totalRttMs": p.total_rtt_ms }));
    json!({
        "schema": "agentic-os.diagnostic-report/1",
        "diagnostic": true,
        "ephemeral": true,
        "runId": s.run_id,
        "trigger": s.trigger,
        "preset": i.preset,
        "intensity": s.intensity,
        "nodes": i.nodes,
        "staggerMs": i.stagger,
        "timeoutMs": i.timeout_ms,
        "startedAt": i.started_at,
        "finishedAt": arbiter::now_ms(),
        "wallMs": s.wall_ms,
        "aborted": s.aborted,
        "hardware": { "baseline": s.baseline, "peak": s.hw, "vramSpikeMb": vram_spike, "vramHeadroomMb": headroom, "vramPeakPct": peak_pct, "app": s.hw_app, "other": s.hw_other },
        "slowest": slowest,
        "probes": i.probes,
        "gpuSlotBefore": i.slot_before,
        "slotDetailBefore": i.slot_detail_before,
        "policy": i.policy,
        "librarianProfiles": i.librarian_profiles,
        // Recent daemon stagger decisions (ran / deferred + why), oldest first.
        "daemonSchedule": super::stagger::recent(),
        "counters": {
            "before": i.counters_before,
            "after": i.counters_after,
            "unchanged": changes.is_empty(),
            "changes": changes,
            "note": "Probes never count runs or touch memtier; a change here means real agent work ran during the probe window.",
        },
        "thresholds": "Green/Amber/Red bands and bottleneck rules: src/features/sysmap/diagnostics-model.ts (THRESHOLDS)",
    })
}

fn write_report(run_id: &str, report: &serde_json::Value) -> Result<std::path::PathBuf, String> {
    let dir = telemetry_dir().ok_or("telemetry dir not initialised")?;
    let reports = dir.join("reports");
    std::fs::create_dir_all(&reports).map_err(|e| e.to_string())?;
    let body = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    let path = reports.join(format!("{run_id}.json"));
    super::staging::atomic_write(&path, &body)?;
    super::staging::atomic_write(&dir.join("latest.json"), &body)?;
    prune(&reports, MAX_REPORTS);
    Ok(path)
}

/// Report files, newest first (run ids start with the unix-ms timestamp).
fn report_files(reports: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(reports).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    v.sort_by_key(|p| std::cmp::Reverse(run_sort_key(p)));
    v
}

fn run_sort_key(p: &std::path::Path) -> (u64, u64) {
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let mut it = stem.trim_start_matches("diag-").split('-').map(|n| n.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

fn prune(reports: &std::path::Path, keep: usize) {
    for old in report_files(reports).into_iter().skip(keep) {
        let _ = std::fs::remove_file(old);
    }
}

fn read_json(p: &std::path::Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// The newest report on disk, the run in flight (so a reloaded window can re-attach), and the folder.
#[tauri::command]
pub fn diag_latest() -> serde_json::Value {
    let dir = telemetry_dir();
    json!({
        "latest": dir.and_then(|d| read_json(&d.join("latest.json"))),
        "activeRunId": runs().lock().unwrap().keys().next_back().cloned(),
        "dir": dir.map(|d| d.display().to_string()),
    })
}

/// The newest `limit` reports (default 20, max 100), newest first.
#[tauri::command]
pub fn diag_reports(limit: Option<usize>) -> Vec<serde_json::Value> {
    let Some(dir) = telemetry_dir() else { return vec![] };
    report_files(&dir.join("reports")).into_iter().take(limit.unwrap_or(20).min(100)).filter_map(|p| read_json(&p)).collect()
}

// ── Presets (mirrors PRESETS in diagnostics-model.ts; a vitest keeps them in sync) ──

pub const PRESET_NODES: [(&str, &[&str]); 4] = [
    ("daemons", &["observer", "security", "garbage"]),
    ("daily", &["tony", "observer", "security", "garbage", "librarian"]),
    ("dual", &["tony", "coder", "librarian", "observer", "security", "garbage"]),
    ("stress", &["tony", "trading", "coder", "librarian", "observer", "security", "garbage"]),
];

/// A preset's nodes and this pulse's stagger (Live Daily Stack: Librarian at a 600–2500 ms offset).
pub fn preset_args(id: &str, intensity: Intensity) -> Option<DiagRunArgs> {
    let nodes = PRESET_NODES.iter().find(|(p, _)| *p == id)?.1;
    let mut stagger = BTreeMap::new();
    if id == "daily" {
        stagger.insert("librarian".to_string(), 600 + arbiter::now_ms() % 1_901);
    }
    Some(DiagRunArgs { nodes: nodes.iter().map(|s| s.to_string()).collect(), intensity, stagger_ms: stagger, timeout_ms: None, preset: Some(id.into()) })
}

// ── Background schedule + on-demand request file ────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Schedule {
    pub enabled: bool,
    pub every_minutes: u32,
    pub preset: String,
    pub intensity: Intensity,
    /// Medium/Heavy only fire when nothing holds or waits for the GPU (never disturbs real work).
    pub only_when_gpu_idle: bool,
    pub last_run_at: Option<u64>,
}

impl Default for Schedule {
    fn default() -> Self {
        Self { enabled: false, every_minutes: 30, preset: "daemons".into(), intensity: Intensity::Light, only_when_gpu_idle: true, last_run_at: None }
    }
}

impl Schedule {
    /// Is a scheduled run due at `now` (pure)?
    pub fn due(&self, now: u64) -> bool {
        self.enabled && self.last_run_at.is_none_or(|t| now.saturating_sub(t) >= self.every_minutes as u64 * 60_000)
    }
    pub fn next_at(&self) -> Option<u64> {
        self.enabled.then(|| self.last_run_at.map(|t| t + self.every_minutes as u64 * 60_000).unwrap_or_else(arbiter::now_ms))
    }
}

fn schedule_cell() -> &'static Mutex<Schedule> {
    static S: OnceLock<Mutex<Schedule>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Schedule::default()))
}

fn load_schedule() -> Schedule {
    telemetry_dir().and_then(|d| serde_json::from_slice(&std::fs::read(d.join("schedule.json")).ok()?).ok()).unwrap_or_default()
}

fn save_schedule(s: &Schedule) {
    if let (Some(d), Ok(body)) = (telemetry_dir(), serde_json::to_vec_pretty(s)) {
        let _ = super::staging::atomic_write(&d.join("schedule.json"), &body);
    }
}

fn schedule_view() -> serde_json::Value {
    let s = schedule_cell().lock().unwrap().clone();
    json!({ "schedule": s, "nextAt": s.next_at(), "dir": telemetry_dir().map(|d| d.display().to_string()), "presets": PRESET_NODES.iter().map(|(p, _)| *p).collect::<Vec<_>>() })
}

#[tauri::command]
pub fn diag_schedule_get() -> serde_json::Value {
    schedule_view()
}

#[tauri::command]
pub fn diag_schedule_set(schedule: Schedule) -> Result<serde_json::Value, String> {
    if !PRESET_NODES.iter().any(|(p, _)| *p == schedule.preset) {
        return Err(format!("unknown preset {}", schedule.preset));
    }
    {
        let mut cur = schedule_cell().lock().unwrap();
        let last = cur.last_run_at;
        *cur = Schedule { every_minutes: schedule.every_minutes.clamp(1, 1440), last_run_at: last, ..schedule };
        save_schedule(&cur);
    }
    Ok(schedule_view())
}

/// `request.json`: `{ "preset": "stress", "intensity": "MEDIUM" }` or `{ "nodes": [...], "intensity": … }`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub nodes: Option<Vec<String>>,
    pub intensity: Intensity,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

impl RunRequest {
    pub fn into_args(self) -> Result<DiagRunArgs, String> {
        let mut args = match (&self.preset, self.nodes) {
            (Some(p), _) => preset_args(p, self.intensity).ok_or_else(|| format!("unknown preset {p}"))?,
            (None, Some(nodes)) => DiagRunArgs { nodes, intensity: self.intensity, stagger_ms: BTreeMap::new(), timeout_ms: None, preset: None },
            (None, None) => return Err("request needs \"preset\" or \"nodes\"".into()),
        };
        args.timeout_ms = self.timeout_ms;
        Ok(args)
    }
}

async fn daemon_loop(app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(LOOP_TICK).await;
        let Some(dir) = telemetry_dir() else { continue };
        // One run at a time: a request / scheduled run waits for the current one to finish.
        if !runs().lock().unwrap().is_empty() {
            continue;
        }
        let req = dir.join("request.json");
        if req.exists() {
            let raw = std::fs::read(&req);
            let _ = std::fs::remove_file(&req);
            let result = raw.map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<RunRequest>(&b).map_err(|e| format!("bad request.json: {e}"))).and_then(RunRequest::into_args).and_then(|a| start_run(app.clone(), a, Trigger::Request));
            let note = match &result {
                Ok(id) => json!({ "at": arbiter::now_ms(), "ok": true, "runId": id, "report": dir.join("reports").join(format!("{id}.json")).display().to_string() }),
                Err(e) => json!({ "at": arbiter::now_ms(), "ok": false, "error": e }),
            };
            let _ = super::staging::atomic_write(&dir.join("last-request.json"), &serde_json::to_vec_pretty(&note).unwrap_or_default());
            continue;
        }
        let s = schedule_cell().lock().unwrap().clone();
        let now = arbiter::now_ms();
        if !s.due(now) {
            continue;
        }
        if s.only_when_gpu_idle && s.intensity != Intensity::Light && !app.state::<OsState>().slot.is_idle() {
            continue;
        }
        if let Some(args) = preset_args(&s.preset, s.intensity) {
            if start_run(app.clone(), args, Trigger::Schedule).is_ok() {
                let mut cur = schedule_cell().lock().unwrap();
                cur.last_run_at = Some(now);
                save_schedule(&cur);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_labels_never_resolve_to_a_node() {
        for n in arbiter::NODES {
            let l = slot_label(n.id);
            assert_eq!(arbiter::node_for_label(&l), None, "{l}");
        }
    }

    #[test]
    fn counter_diff_names_what_moved() {
        let b = json!({ "runs": { "tony": 3, "coder": 1 }, "memory": [{ "namespace": "librarian", "active": 10, "archived": 4, "activeKb": 2 }] });
        assert!(counter_changes(&b, &b).is_empty());
        let a = json!({ "runs": { "tony": 4, "coder": 1 }, "memory": [{ "namespace": "librarian", "active": 10, "archived": 5, "activeKb": 2 }] });
        let c = counter_changes(&b, &a);
        let names: Vec<&str> = c.iter().map(|x| x["counter"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["runs.tony", "memory.librarian.archived"]);
    }

    #[test]
    fn schedule_due_and_requests() {
        let mut s = Schedule { enabled: true, every_minutes: 10, ..Default::default() };
        assert!(s.due(1_000_000));
        s.last_run_at = Some(1_000_000);
        assert!(!s.due(1_000_000 + 9 * 60_000));
        assert!(s.due(1_000_000 + 10 * 60_000));
        s.enabled = false;
        assert!(!s.due(u64::MAX));
        let r: RunRequest = serde_json::from_str(r#"{"preset":"stress","intensity":"HEAVY"}"#).unwrap();
        let a = r.into_args().unwrap();
        assert_eq!(a.nodes, ["tony", "trading", "coder", "librarian", "observer", "security", "garbage"]);
        assert_eq!(a.intensity, Intensity::Heavy);
        let r: RunRequest = serde_json::from_str(r#"{"preset":"daily","intensity":"LIGHT"}"#).unwrap();
        let st = r.into_args().unwrap().stagger_ms["librarian"];
        assert!((600..=2500).contains(&st));
        assert!(serde_json::from_str::<RunRequest>(r#"{"preset":"nope","intensity":"LIGHT"}"#).unwrap().into_args().is_err());
        assert!(serde_json::from_str::<RunRequest>(r#"{"intensity":"LIGHT"}"#).unwrap().into_args().is_err());
        for (p, nodes) in PRESET_NODES {
            for n in nodes {
                assert!(arbiter::node_def(n).is_some(), "{p}: {n}");
            }
        }
    }

    #[test]
    fn report_has_hardware_and_counter_proof() {
        let hw = |v: u64| HwPeak { cpu_pct: 30.0, ram_used_gb: 20.0, gpu_util_pct: Some(90.0), vram_used_mb: Some(v), vram_total_mb: Some(12288) };
        let app = super::super::procstats::Footprint { cpu_pct: 6.2, ram_used_gb: 1.9, gpu_util_pct: Some(88.0), vram_used_mb: Some(9000), processes: vec!["command-center".into(), "llama-server".into()] };
        let other = super::super::procstats::Footprint { cpu_pct: 30.0, ..Default::default() };
        let s = RunSummary { run_id: "diag-1-1".into(), intensity: Intensity::Medium, wall_ms: 4000, hw: hw(10_000), baseline: hw(9_000), aborted: false, trigger: Trigger::Request, report_path: None, hw_app: Some(app), hw_other: Some(other) };
        let c = json!({ "runs": { "tony": 1 }, "memory": [] });
        let phases = Phases { queue_wait_ms: Some(2500), retrieval_ms: Some(3), prefill_ms: Some(400), generation_ms: Some(800), input_tokens: Some(120), output_tokens: Some(48), tokens_per_sec: Some(60.0), diagnosis: Some("scheduling".into()) };
        let p = ProbeEvent { run_id: "diag-1-1".into(), node: "librarian".into(), phase: Phase::Completed, profile: Profile::Gpu, at: 1, queue_wait_ms: Some(2500), exec_ms: Some(1200), total_rtt_ms: Some(3700), tokens_per_sec: Some(40.0), tokens: Some(48), hw: None, error: None, phases: Some(phases) };
        let profiles = [json!({ "stage": "preflight", "diagnosis": "retrieval / disk" })];
        let policy = serde_json::to_value(super::super::policy::Policy::default()).unwrap();
        let r = build_report(ReportInput { summary: &s, preset: Some("stress"), nodes: &["librarian".into()], stagger: &BTreeMap::new(), timeout_ms: 60_000, started_at: 0, probes: &[p], counters_before: &c, counters_after: &c, slot_before: &json!(null), slot_detail_before: &json!({ "capacity": 1 }), policy: &policy, librarian_profiles: &profiles });
        assert_eq!(r["hardware"]["vramSpikeMb"], 1000);
        assert_eq!(r["hardware"]["vramHeadroomMb"], 2288);
        assert_eq!(r["hardware"]["app"]["cpuPct"].as_f64().map(|x| (x * 10.0).round() / 10.0), Some(6.2));
        assert_eq!(r["hardware"]["app"]["processes"][1], "llama-server");
        assert_eq!(r["hardware"]["other"]["cpuPct"], 30.0);
        assert_eq!(r["counters"]["unchanged"], true);
        assert_eq!(r["slowest"]["node"], "librarian");
        assert_eq!(r["trigger"], "request");
        assert_eq!(r["probes"][0]["queueWaitMs"], 2500);
        assert_eq!(r["probes"][0]["phases"]["prefillMs"], 400);
        assert_eq!(r["probes"][0]["phases"]["diagnosis"], "scheduling");
        assert_eq!(r["slotDetailBefore"]["capacity"], 1);
        assert_eq!(r["policy"]["version"], 1);
        assert_eq!(r["librarianProfiles"][0]["diagnosis"], "retrieval / disk");
        // The summary serialises camelCase over IPC.
        let sv = serde_json::to_value(&s).unwrap();
        assert!(sv["hwApp"].is_object() && sv["hwOther"].is_object(), "{sv}");
    }

    #[test]
    fn usage_chunks_are_parsed() {
        assert_eq!(usage_of(&json!({ "usage": { "prompt_tokens": 4100, "completion_tokens": 384, "total_tokens": 4484 } })), Some((Some(4100), Some(384))));
        assert_eq!(usage_of(&json!({ "usage": null })), None);
        assert_eq!(usage_of(&json!({ "choices": [] })), None);
        assert_eq!(usage_of(&json!({ "usage": {} })), None);
        assert_eq!(usage_of(&json!({ "usage": { "completion_tokens": 7 } })), Some((None, Some(7))));
    }

    /// A synthetic SSE stream: 3 content deltas, an empty one, the final usage chunk, [DONE].
    #[test]
    fn phases_from_a_synthetic_stream() {
        let t = Instant::now();
        let at = |m: u64| t + Duration::from_millis(m);
        let lines = [
            (100, r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#),
            (900, r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#),
            (950, r#"data: {"choices":[{"delta":{"content":""}}]}"#),
            (1000, r#"data: {"choices":[{"delta":{"content":"lo"}}]}"#),
            (1900, r#"data: {"choices":[{"delta":{"reasoning_content":"!"}}]}"#),
            (1950, r#"data: {"choices":[],"usage":{"prompt_tokens":4096,"completion_tokens":20}}"#),
            (1960, "data: [DONE]"),
            (1961, ": keep-alive comment"),
            (1962, "data: {not json"),
        ];
        let mut tally = StreamTally::default();
        for (m, l) in lines {
            tally.feed_line(l, at(m));
        }
        assert_eq!(tally.deltas, 3);
        assert_eq!((tally.usage_in, tally.usage_out), (Some(4096), Some(20)));
        let ph = stream_phases(&tally, t, at(2900), Duration::from_millis(1500), Some(Duration::from_millis(12)));
        assert_eq!(ph.queue_wait_ms, Some(1500));
        assert_eq!(ph.retrieval_ms, Some(12));
        assert_eq!(ph.prefill_ms, Some(900));
        assert_eq!(ph.generation_ms, Some(2000));
        assert_eq!(ph.input_tokens, Some(4096));
        assert_eq!(ph.output_tokens, Some(20), "usage wins over the delta count");
        assert_eq!(ph.tokens_per_sec, Some(10.0));
        assert_eq!(ph.diagnosis, None, "diagnosis is set by the caller (Librarian only)");
        // No usage chunk: deltas counted, input unknown.
        let mut t2 = StreamTally::default();
        t2.feed_line(r#"data: {"choices":[{"delta":{"content":"a"}}]}"#, at(500));
        t2.feed_line(r#"data: {"choices":[{"delta":{"content":"b"}}]}"#, at(1500));
        let ph = stream_phases(&t2, t, at(2500), Duration::ZERO, None);
        assert_eq!((ph.input_tokens, ph.output_tokens, ph.prefill_ms, ph.generation_ms), (None, Some(2), Some(500), Some(2000)));
        assert_eq!(ph.tokens_per_sec, Some(1.0));
        // Nothing streamed: no prefill / generation, never invented.
        let ph = stream_phases(&StreamTally::default(), t, at(100), Duration::ZERO, None);
        assert_eq!((ph.prefill_ms, ph.generation_ms, ph.output_tokens, ph.tokens_per_sec), (None, None, None, None));
        // Serialised camelCase.
        let v = serde_json::to_value(Phases { queue_wait_ms: Some(1), ..Default::default() }).unwrap();
        assert!(v.get("queueWaitMs").is_some() && v.get("tokensPerSec").is_some(), "{v}");
    }

    #[test]
    fn non_streamed_split_uses_server_stats_or_says_unavailable() {
        let lm = json!({ "usage": { "prompt_tokens": 2400, "completion_tokens": 300 }, "stats": { "tokens_per_second": 24.96, "time_to_first_token": 1.25, "generation_time": 12.02, "stop_reason": "eosFound" } });
        let s = split_from_response(&lm, 13_400);
        assert_eq!((s.prefill_ms, s.generation_ms, s.input_tokens, s.output_tokens, s.tokens_per_sec), (Some(1250), Some(12_020), Some(2400), Some(300), Some(25.0)));
        assert!(s.split_method.starts_with("lmstudio stats"));
        let lc = json!({ "usage": { "prompt_tokens": 2400, "completion_tokens": 300 }, "timings": { "prompt_n": 2400, "prompt_ms": 800.4, "predicted_n": 300, "predicted_ms": 12000.0, "predicted_per_second": 25.0 } });
        let s = split_from_response(&lc, 13_000);
        assert_eq!((s.prefill_ms, s.generation_ms, s.tokens_per_sec), (Some(800), Some(12_000), Some(25.0)));
        assert!(s.split_method.starts_with("llama.cpp"));
        let plain = json!({ "usage": { "prompt_tokens": 2400, "completion_tokens": 300 }, "choices": [] });
        let s = split_from_response(&plain, 13_000);
        assert_eq!((s.prefill_ms, s.generation_ms, s.tokens_per_sec), (None, None, None), "never estimated");
        assert_eq!((s.input_tokens, s.output_tokens), (Some(2400), Some(300)));
        assert_eq!(s.split_method, SPLIT_UNAVAILABLE);
        let none = split_from_response(&json!({}), 0);
        assert_eq!((none.input_tokens, none.output_tokens), (None, None));
    }

    #[test]
    fn diagnosis_follows_the_proposal_rule() {
        let base = DiagInput { total_ms: 10_000, ..Default::default() };
        assert_eq!(diagnose(&DiagInput { total_ms: 0, ..base.clone() }), None);
        // retrieval > 30 %
        let d = DiagInput { retrieval_ms: Some(3_500), queue_ms: Some(500), prefill_ms: Some(1_000), generation_ms: Some(5_000), input_tokens: Some(3_000), tokens_per_sec: Some(25.0), vram_pct: Some(78.0), ..base.clone() };
        assert_eq!(diagnose(&d).as_deref(), Some("retrieval / disk"));
        // retrieval exactly 30 % is not over the line
        assert_ne!(diagnose(&DiagInput { retrieval_ms: Some(3_000), ..d.clone() }).as_deref(), Some("retrieval / disk"));
        // prefill > 40 % with high input tokens
        let d = DiagInput { retrieval_ms: Some(200), queue_ms: Some(300), prefill_ms: Some(5_000), generation_ms: Some(4_500), input_tokens: Some(4_100), tokens_per_sec: Some(25.0), vram_pct: Some(78.0), ..base.clone() };
        assert_eq!(diagnose(&d).as_deref(), Some("oversized context"));
        // …but not with a small prompt
        assert_ne!(diagnose(&DiagInput { input_tokens: Some(500), ..d.clone() }).as_deref(), Some("oversized context"));
        // queue > 50 %
        let d = DiagInput { retrieval_ms: Some(100), queue_ms: Some(6_000), prefill_ms: Some(800), generation_ms: Some(3_100), input_tokens: Some(2_400), tokens_per_sec: Some(25.0), vram_pct: Some(78.0), ..base.clone() };
        assert_eq!(diagnose(&d).as_deref(), Some("scheduling"));
        // generation dominates at normal tok/s, VRAM < 90 %
        let d = DiagInput { retrieval_ms: Some(100), queue_ms: Some(400), prefill_ms: Some(1_500), generation_ms: Some(8_000), input_tokens: Some(2_400), tokens_per_sec: Some(24.0), vram_pct: Some(78.0), ..base.clone() };
        assert_eq!(diagnose(&d).as_deref(), Some("genuine compute"));
        assert!(diagnose(&DiagInput { tokens_per_sec: Some(6.0), ..d.clone() }).unwrap().starts_with("slow generation"));
        assert!(diagnose(&DiagInput { vram_pct: Some(95.0), ..d.clone() }).unwrap().starts_with("VRAM pressure"));
        assert!(diagnose(&DiagInput { vram_pct: None, ..d.clone() }).unwrap().starts_with("genuine compute (tok/s or VRAM not sampled)"));
        // Split unavailable (non-streamed call without stats): said so, not guessed.
        let d = DiagInput { retrieval_ms: Some(100), queue_ms: Some(400), model_ms: Some(9_000), input_tokens: Some(2_400), ..base.clone() };
        assert!(diagnose(&d).unwrap().contains("split unavailable"));
        // Nothing dominates.
        let d = DiagInput { retrieval_ms: Some(2_500), queue_ms: Some(2_500), prefill_ms: Some(2_500), generation_ms: Some(2_500), input_tokens: Some(100), ..base };
        assert_eq!(diagnose(&d).as_deref(), Some("no dominant phase"));
    }

    #[test]
    fn librarian_profiles_ring_and_shape() {
        let run = LibrarianRun {
            source: "worker",
            stage: "preflight".into(),
            task_id: Some("t-1".into()),
            outcome: "ok",
            total_ms: 10_000,
            queue_wait_ms: Some(500),
            retrieval_ms: Some(4_000),
            files_walked: Some(600),
            bytes_read: Some(1_234_567),
            hits: [("hub".to_string(), 3usize)].into_iter().collect(),
            packet_chars: Some(8_900),
            model_ms: Some(5_400),
            split: ModelSplit { input_tokens: Some(2_300), output_tokens: Some(270), split_method: SPLIT_UNAVAILABLE.into(), ..Default::default() },
            ..Default::default()
        };
        let v = librarian_profile(&run);
        assert_eq!(v["diagnosis"], "retrieval / disk");
        assert_eq!(v["prefillMs"], serde_json::Value::Null);
        assert_eq!(v["splitMethod"], SPLIT_UNAVAILABLE);
        assert_eq!(v["endToEndTokPerSec"], 50.0);
        assert_eq!(v["tokPerSec"], serde_json::Value::Null);
        assert_eq!(v["sharePct"]["retrieval"], 40.0);
        assert_eq!(v["hits"]["hub"], 3);
        for i in 0..(PROFILES_MAX + 5) {
            record_librarian(&LibrarianRun { stage: format!("ring-{i}"), total_ms: 1, ..run.clone() });
        }
        let all = librarian_profiles();
        assert!(all.len() <= PROFILES_MAX);
        assert_eq!(all.last().unwrap()["stage"], format!("ring-{}", PROFILES_MAX + 4));
    }

    #[test]
    fn footprint_peaks_merge() {
        use super::super::procstats::Footprint;
        let a = Footprint { cpu_pct: 5.0, ram_used_gb: 2.0, gpu_util_pct: None, vram_used_mb: Some(100), processes: vec!["command-center".into()] };
        let b = Footprint { cpu_pct: 9.0, ram_used_gb: 1.0, gpu_util_pct: Some(80.0), vram_used_mb: Some(50), processes: vec!["llama-server".into(), "command-center".into()] };
        let p = footprint_peak(Some(a), &b);
        assert_eq!((p.cpu_pct, p.ram_used_gb, p.gpu_util_pct, p.vram_used_mb), (9.0, 2.0, Some(80.0), Some(100)));
        assert_eq!(p.processes, vec!["command-center", "llama-server"]);
        assert_eq!(footprint_peak(None, &b).cpu_pct, 9.0);
    }

    #[test]
    fn stale_split_from_a_previous_run_is_not_folded() {
        use super::super::procstats::{Footprint, Split};
        let fp = |cpu: f32, name: &str| Footprint { cpu_pct: cpu, processes: vec![name.into()], ..Default::default() };
        let peaks: SplitPeaks = Arc::new(Mutex::new((None, None)));
        let started_at = 10_000;
        // Sampled 500 ms before this run started (previous run's heavy load, still "fresh").
        let stale = Split { at: started_at - 500, app: fp(90.0, "llama-server"), other: fp(70.0, "tws"), ..Default::default() };
        fold_split(&peaks, Some(&stale), started_at);
        fold_split(&peaks, None, started_at);
        assert_eq!(*peaks.lock().unwrap(), (None, None));
        // This run's splits (at or after the start) are folded.
        let own = Split { at: started_at, app: fp(6.0, "command-center"), other: fp(30.0, "chromium"), ..Default::default() };
        fold_split(&peaks, Some(&own), started_at);
        fold_split(&peaks, Some(&stale), started_at);
        let (hw_app, hw_other) = std::mem::take(&mut *peaks.lock().unwrap());
        let (hw_app, hw_other) = (hw_app.unwrap(), hw_other.unwrap());
        assert_eq!((hw_app.cpu_pct, hw_app.processes), (6.0, vec!["command-center".to_string()]));
        assert_eq!((hw_other.cpu_pct, hw_other.processes), (30.0, vec!["chromium".to_string()]));
    }

    #[test]
    fn prune_keeps_the_newest() {
        let d = std::env::temp_dir().join(format!("diag-prune-{}", arbiter::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        for (ms, seq) in [(100, 1), (300, 2), (200, 3), (300, 10)] {
            std::fs::write(d.join(format!("diag-{ms}-{seq}.json")), "{}").unwrap();
        }
        prune(&d, 2);
        let left: Vec<String> = report_files(&d).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["diag-300-10.json", "diag-300-2.json"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A probe holding (and queueing for) the GPU slot never becomes a node's token or run.
    #[test]
    fn gpu_slot_probe_does_not_count_runs() {
        use crate::commands::scheduler::SlotView;
        let a = arbiter::Arbiter::default();
        let v = |active: &[&str], waiting: &[&str]| SlotView { active: active.iter().map(|s| s.to_string()).collect(), queued_foreground: 0, queued_background: waiting.len(), capacity: 1, settling: 0, waiting: waiting.iter().map(|s| s.to_string()).collect(), away: false };
        a.on_slot(&v(&[&slot_label("tony")], &[&slot_label("coder"), &slot_label("librarian")]));
        a.on_slot(&v(&[&slot_label("coder")], &[&slot_label("librarian")]));
        a.on_slot(&v(&[], &[]));
        for n in a.nodes() {
            assert_eq!(n["runs"], 0, "{}", n["id"]);
            assert_ne!(n["state"], "ACTIVE_TOKEN");
            assert_ne!(n["state"], "QUEUED");
        }
        assert!(a.snapshot()["feed"].as_array().unwrap().is_empty(), "no token hand-off rows");
    }

    #[test]
    fn profiles() {
        assert_eq!(profile_for("tony"), Profile::Gpu);
        assert_eq!(profile_for("librarian"), Profile::Gpu);
        assert_eq!(profile_for("trading"), Profile::Gpu);
        for n in ["observer", "security", "garbage", "finance", "booking"] {
            assert_eq!(profile_for(n), Profile::Cpu, "{n}");
        }
    }

    #[test]
    fn peak_window_and_fallback() {
        let t = Instant::now();
        let s = |c: f32, v: u64| HwPeak { cpu_pct: c, ram_used_gb: 1.0, gpu_util_pct: Some(c), vram_used_mb: Some(v), vram_total_mb: Some(12288) };
        let samples = vec![(t, s(10.0, 100)), (t + Duration::from_millis(250), s(80.0, 9000)), (t + Duration::from_millis(500), s(20.0, 500))];
        let p = peak_in(&samples, t + Duration::from_millis(100), t + Duration::from_millis(600)).unwrap();
        assert_eq!(p.cpu_pct, 80.0);
        assert_eq!(p.vram_used_mb, Some(9000));
        // Window with no sample inside: nearest earlier sample.
        let p = peak_in(&samples, t + Duration::from_millis(260), t + Duration::from_millis(270)).unwrap();
        assert_eq!(p.cpu_pct, 80.0);
    }

    #[test]
    fn cpu_work_is_deterministic_and_scales() {
        let t = Instant::now();
        cpu_work(Intensity::Medium);
        let med = t.elapsed();
        let t = Instant::now();
        cpu_work(Intensity::Heavy);
        assert!(t.elapsed() > med);
    }

    /// The ephemeral rule: a CPU probe burst leaves every node's `runs` and the memtier counts alone.
    #[test]
    fn cpu_probes_and_peek_do_not_touch_counters() {
        tauri::async_runtime::block_on(async {
            let before: Vec<(String, u64)> = arbiter::get().nodes().iter().map(|n| (n["id"].as_str().unwrap().to_string(), n["runs"].as_u64().unwrap())).collect();
            let mem_before = super::super::memtier::stats();
            let emit: Emit = Arc::new(|_, _| {});
            for node in ["observer", "security", "garbage"] {
                for intensity in [Intensity::Medium, Intensity::Heavy] {
                    let p = Probe { run_id: "t".into(), node, profile: Profile::Cpu, intensity, diagnostic: true, ephemeral: true };
                    run_cpu(&p, &emit).await.unwrap();
                }
            }
            let _ = super::super::memtier::peek("librarian", "anything at all", 8, 4000, true);
            let after: Vec<(String, u64)> = arbiter::get().nodes().iter().map(|n| (n["id"].as_str().unwrap().to_string(), n["runs"].as_u64().unwrap())).collect();
            assert_eq!(before, after);
            assert_eq!(mem_before, super::super::memtier::stats());
        });
    }
}
