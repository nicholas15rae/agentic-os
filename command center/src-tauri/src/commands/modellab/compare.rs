//! Model Lab A/B compare (`model_compare`): a candidate model against Tony's, on Tony's own
//! prompts, without ever switching Tony.
//!
//! One run holds ONE maintenance GPU slot from start to finish (`GpuSlot::acquire_maintenance`,
//! holder `maintenance · model compare`). The slot is mirrored to the gateway, whose own LLM
//! users hold back while that marker is up (command_center_api.py `gpu_maintenance`); this run
//! re-sends the lease every 30 s so a long run never goes stale there. Inside the slot:
//!   1. blocks in the order A, B, B, A: unload every LLM, load the block's model with Tony's
//!      production settings (32768 context, 2 parallel, flash attention, KV cache on the GPU, no
//!      TTL), check the context Bionic reports, read VRAM, warm up, run the block's cases;
//!   2. put Tony back: unload, load Tony's configured model at those settings, warm up (only a
//!      load that took: a chat to an unloaded model JIT-loads it at Bionic's defaults), and check
//!      GET /api/v1/models lists exactly ONE loaded LLM, his, at 32768 × 2, before the slot is
//!      released (one corrective unload + reload otherwise). A panicked run's heartbeat and
//!      sampler abort with it, and `recover_after_crash` puts Tony back under a fresh slot.
//! It never calls `model_use` and never writes providers.json or AnythingLLM: Tony's configured
//! model is untouched. F16 / BF16 / F32 GGUFs are refused.
//!
//! Cases (cases.rs) are posted straight to Bionic the way Tony sends them, with only the model
//! name changed. Chat turns: Tony's real system message (`agents::system_prompt_with_core` →
//! `tony_turn_system` → `tony_system`, with the live MODE block and output contract), stream true,
//! reasoning_effort none, plus `stream_options.include_usage` for token counts. Router turns:
//! `agents::router_prompt(agents::router_offer(..))`, stream false, with run_tool_router's one
//! "JSON only" retry. Variants: `a` adds `chat_template_kwargs.enable_thinking=false`; `b` sends
//! Qwen3.5's model.yaml sampling (temperature 1.0, top_k 20, top_p 0.95, presence_penalty 1.5),
//! which a plain-file model like Huihui doesn't get from Bionic.
//!
//! Block plan (`block_plan`): a model's first block runs `base` on every suite (+ `a` on the
//! timing lines); its second runs `b` on every suite (+ `base` timing again), so timing medians
//! for `base` come from both blocks of each model and the ABBA order cancels drift.
//!
//! Report: `<config>/telemetry/modellab/<runId>.json` (+ `latest.json`). A `request.json` there
//! starts a run headless (like the diagnostics probe's); `last-request.json` says what became of it.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::cases::{Cases, ChatCase, GuardRouterCase, RouterCase, Suite, ALL_SUITES};
use super::checks;
use crate::commands::dispatch::{extract_json, short, usable_text_from_message, ChatMessage, DispatchState};
use crate::commands::mcp::ToolInfo;
use crate::commands::os_core::{OsConfig, OsState};
use crate::commands::{agents, learning, modes, tony_dispatch};

pub const DEFAULT_CANDIDATE: &str = "huihui-qwen3.5-9b-abliterated";
/// `acquire_maintenance` label; the slot (and the gateway lease) shows `maintenance · model compare`.
pub const SLOT_LABEL: &str = "model compare";
/// Tony's production load (services.rs FIT_CTX, gateway_tony.py LOAD_CONTEXT / LOAD_PARALLEL).
pub const CONTEXT: u64 = 32_768;
pub const PARALLEL: u64 = 2;
/// agents.rs `run_tool_router`: each router call gets at most 15 s.
const ROUTER_SECS: u64 = 15;
/// Tony's streamed turn: `run_chat_streamed_into(.., Some(90), ..)`.
const CHAT_SECS: u64 = 90;
const LOAD_SECS: u64 = 300;
/// The lease this run re-sends to the gateway every heartbeat ends this far ahead (so a crashed
/// app frees the gateway within two minutes).
const LEASE_AHEAD_MS: u64 = 120_000;
const MAX_REPORTS: usize = 50;
/// agents.rs `run_tool_router`'s retry line, verbatim (a test reads agents.rs to keep it so).
pub(crate) const ROUTER_RETRY: &str = "JSON only — reply with exactly one JSON object {\"tool\": …, \"args\": {…}} and nothing else.";
/// The LIVE DASHBOARD text every case sees (a webview-rendered dashboard line, fixed for a fair A/B).
pub(crate) const DASHBOARD: &str = "Thursday 26 November 2026, 2:05 PM, Toronto · Weather: 3°C, cloudy · Build Hub: 1 build in Play Place staging, 0 failed · Calendar: nothing else today";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Side {
    A,
    B,
}

/// The block order: A, B, B, A.
pub const ORDER: [Side; 4] = [Side::A, Side::B, Side::B, Side::A];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    /// Exactly Tony's body.
    Base,
    /// + chat_template_kwargs.enable_thinking = false.
    A,
    /// + Qwen3.5's model.yaml sampling.
    B,
}

impl Variant {
    pub fn id(self) -> &'static str {
        match self {
            Variant::Base => "base",
            Variant::A => "a",
            Variant::B => "b",
        }
    }

    pub fn apply(self, body: &mut Value) {
        match self {
            Variant::Base => {}
            Variant::A => body["chat_template_kwargs"] = json!({ "enable_thinking": false }),
            Variant::B => {
                body["temperature"] = json!(1.0);
                body["top_k"] = json!(20);
                body["top_p"] = json!(0.95);
                body["presence_penalty"] = json!(1.5);
            }
        }
    }
}

/// `model_compare` / `request.json`. Everything is optional: `{}` compares Huihui with Tony's model.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct CompareRequest {
    /// Default: Tony's configured model (providers.json `lmstudio`).
    pub model_a: Option<String>,
    /// Default: `DEFAULT_CANDIDATE`.
    pub model_b: Option<String>,
    /// Timing repeats per block, 1..=5 (default 3).
    pub repeats: Option<u32>,
    /// Default all three; `base` is always run.
    pub variants: Option<Vec<Variant>>,
    /// Hard cap on the case work, 5..=60 (default 30): past it the run skips to putting Tony back.
    pub max_minutes: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub run_id: String,
    pub model_a: String,
    pub model_b: String,
    /// The model put back at the end: Tony's configured one.
    pub tony: String,
    pub repeats: u32,
    pub variants: Vec<Variant>,
    pub max_minutes: u64,
    pub warnings: Vec<String>,
}

/// F16 / BF16 / F32 weights: never loaded by the compare.
pub fn is_unquantized(m: &Value) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"(?i)(?:^|[^a-z0-9])b?f(?:16|32)(?:[^a-z0-9]|$)").unwrap());
    ["key", "display_name", "selected_variant"].iter().filter_map(|k| m[*k].as_str()).chain(m["quantization"]["name"].as_str()).any(|s| r.is_match(s))
}

fn llm_entry<'a>(list: &'a Value, key: &str) -> Option<&'a Value> {
    list["models"].as_array()?.iter().find(|m| m["type"] == "llm" && m["key"].as_str() == Some(key))
}

/// The run's plan, checked against Bionic's model list: both models (and Tony's, which the run
/// puts back) must be listed LLMs, none unquantized, A and B different.
pub fn plan_for(req: &CompareRequest, tony: &str, list: &Value, now: u64) -> Result<Plan, String> {
    let tony = tony.trim();
    if tony.is_empty() {
        return Err("Tony has no local model configured (providers.json lmstudio)".into());
    }
    let pick = |v: &Option<String>, d: &str| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
    let (a, b) = (pick(&req.model_a, tony), pick(&req.model_b, DEFAULT_CANDIDATE));
    if a.len() > 200 || b.len() > 200 {
        return Err("bad model id".into());
    }
    if a == b {
        return Err(format!("both sides are {a}: pick a different model to compare"));
    }
    let mut warnings = vec![];
    for (what, key) in [("A", &a), ("B", &b), ("Tony's model", &tony.to_string())] {
        let m = llm_entry(list, key).ok_or_else(|| format!("{what} ({key}) isn't in Bionic's model list"))?;
        if is_unquantized(m) {
            return Err(format!("{key} is an unquantized (F16/BF16/F32) GGUF: the compare never loads one"));
        }
        if m["max_context_length"].as_u64().is_some_and(|c| c < CONTEXT) {
            warnings.push(format!("Bionic reports a max context of {} for {key}: the context check will show whether a {CONTEXT} load took", m["max_context_length"]));
        }
    }
    let mut variants = vec![Variant::Base];
    for v in req.variants.clone().unwrap_or_else(|| vec![Variant::A, Variant::B]) {
        if !variants.contains(&v) {
            variants.push(v);
        }
    }
    Ok(Plan {
        run_id: format!("cmp-{now}"),
        model_a: a,
        model_b: b,
        tony: tony.to_string(),
        repeats: req.repeats.unwrap_or(3).clamp(1, 5),
        variants,
        max_minutes: req.max_minutes.unwrap_or(30).clamp(5, 60),
        warnings,
    })
}

/// What one block runs: (variant, suites). `nth`: this model's first (0) or second (1) block.
pub fn block_plan(nth: usize, variants: &[Variant]) -> Vec<(Variant, Vec<Suite>)> {
    let has = |v| variants.contains(&v);
    let mut out = vec![];
    if nth == 0 {
        out.push((Variant::Base, ALL_SUITES.to_vec()));
        if has(Variant::A) {
            out.push((Variant::A, vec![Suite::Timing]));
        }
    } else {
        if has(Variant::B) {
            out.push((Variant::B, ALL_SUITES.to_vec()));
        }
        out.push((Variant::Base, vec![Suite::Timing]));
    }
    out
}

fn reps(suite: Suite, repeats: u32) -> u32 {
    if suite == Suite::Timing {
        repeats
    } else {
        1
    }
}

/// Model calls the whole run makes (progress total), and a rough duration.
pub fn workload(plan: &Plan, cases: &Cases) -> (u32, u32) {
    let (mut chat, mut router) = (0u32, 0u32);
    let mut seen = [0usize; 2];
    for side in ORDER {
        let nth = seen[side as usize];
        seen[side as usize] += 1;
        for (_, suites) in block_plan(nth, &plan.variants) {
            for s in suites {
                let n = cases.calls(s) as u32 * reps(s, plan.repeats);
                if matches!(s, Suite::Router | Suite::GuardRouter) {
                    router += n;
                } else {
                    chat += n;
                }
            }
        }
    }
    // ~3 s a streamed Tony turn, ~1.3 s a router call, ~20 s a load + warm-up (5 loads).
    let secs = chat as f64 * 3.0 + router as f64 * 1.3 + 5.0 * 20.0;
    (chat + router, (secs / 60.0).ceil() as u32)
}

// ── Live status ─────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub run_id: String,
    pub model_a: String,
    pub model_b: String,
    pub started_at: u64,
    pub phase: String,
    pub done: u32,
    pub total: u32,
    pub est_minutes: u32,
}

pub type Status = Arc<Mutex<Option<Progress>>>;

fn status() -> &'static Status {
    static S: OnceLock<Status> = OnceLock::new();
    S.get_or_init(Status::default)
}

fn cancel_flag() -> &'static Arc<AtomicBool> {
    static C: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    C.get_or_init(Arc::default)
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Clears RUNNING and the live status when the run task ends (also on a panic).
struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        *status().lock().unwrap_or_else(|p| p.into_inner()) = None;
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// What the run needs from outside (injected so a test can stand in for nvidia-smi and the store).
pub(crate) struct Deps {
    /// (used MiB, total MiB) of the GPU.
    pub vram: Arc<dyn Fn() -> Option<(u64, u64)> + Send + Sync>,
    pub cases: Cases,
    /// Tony's CORE MEMORIES block; None reads the live pathway store (as his turn does).
    pub core: Option<String>,
    pub heartbeat_every: Duration,
    pub vram_every: Duration,
    pub cancel: Arc<AtomicBool>,
    pub status: Status,
    /// Called after every case (None live; a test crashes the run from here).
    pub after_case: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Deps {
    fn live() -> Self {
        Deps {
            vram: Arc::new(|| crate::commands::system::query_gpu().map(|g| (g.vram_used_mb as u64, g.vram_total_mb as u64))),
            cases: Cases::standard(),
            core: None,
            heartbeat_every: Duration::from_secs(30),
            vram_every: Duration::from_millis(500),
            cancel: cancel_flag().clone(),
            status: status().clone(),
            after_case: None,
        }
    }

    fn phase(&self, phase: impl Into<String>) {
        if let Some(p) = self.status.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            p.phase = phase.into();
        }
    }

    fn step(&self) {
        if let Some(p) = self.status.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            p.done += 1;
        }
        if let Some(f) = &self.after_case {
            f();
        }
    }
}

// ── Records ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlockOut {
    pub index: usize,
    pub side: Side,
    pub model: String,
    pub plan: Vec<(Variant, Vec<Suite>)>,
    pub load_ms: Option<u64>,
    /// Bionic's view of the loaded instance (GET /api/v1/models `config`).
    pub context: Option<u64>,
    pub parallel: Option<u64>,
    pub ctx_ok: bool,
    pub vram_before_mb: Option<u64>,
    pub vram_after_load_mb: Option<u64>,
    pub vram_peak_mb: Option<u64>,
    pub vram_total_mb: Option<u64>,
    /// Other LLMs loaded when the block ended (a just-in-time load by someone else).
    pub extra_loaded: Vec<String>,
    pub error: Option<String>,
    pub started_ms: u64,
    pub ended_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRun {
    pub block: usize,
    pub side: Side,
    pub model: String,
    pub variant: Variant,
    pub suite: Suite,
    pub case: &'static str,
    pub rep: u32,
    /// Time to the first SSE delta of any kind.
    pub ttfd_ms: Option<u64>,
    /// Time to the first non-whitespace `content`.
    pub first_content_ms: Option<u64>,
    /// Time to the first chunk TTS would speak (`checks::first_tts_chunk` over `checks::speakable`).
    pub first_speakable_ms: Option<u64>,
    pub total_ms: u64,
    pub reasoning_tokens: u64,
    pub reasoning_chars: usize,
    pub completion_tokens: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    /// Effective prefill speed (uncached prompt tokens / time to first delta, or the server's own).
    pub prefill_tps: Option<f64>,
    pub gen_tps: Option<f64>,
    /// No `usage` came back: token counts are streamed-chunk counts.
    pub tokens_approx: bool,
    pub finished: bool,
    pub error: Option<String>,
    /// "ok" (a valid packet), "invalid" (looked like one, failed validation), "prose".
    pub packet: &'static str,
    pub packet_expected: bool,
    pub requires_dispatch: Option<bool>,
    pub dispatch_ok: Option<bool>,
    pub persona: checks::Persona,
    pub persona_pass: bool,
    pub guard: Option<checks::GuardVerdict>,
    pub spoken: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RouterRun {
    pub block: usize,
    pub side: Side,
    pub model: String,
    pub variant: Variant,
    pub suite: Suite,
    pub case: String,
    pub two_step: bool,
    pub skipped: bool,
    /// One of the case's accepted tools (or null) was offered for the line. An unfair case (the
    /// app never offers the expected tool for it) is left out of the exact-tool and args rates.
    pub fair: bool,
    pub ms: u64,
    pub attempts: u8,
    pub offered: usize,
    pub verdict: checks::RouterVerdict,
    /// GuardRouter: a JSON reply came back, with no exfiltration and no unoffered tool.
    pub guard_pass: Option<bool>,
    pub reasoning_chars: usize,
    pub reasoning_tokens: u64,
    pub error: Option<String>,
    pub reply: String,
}

#[derive(Default)]
pub(crate) struct Runs {
    pub chat: Vec<ChatRun>,
    pub router: Vec<RouterRun>,
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{t}…")
    } else {
        t
    }
}

fn now_ms() -> u64 {
    crate::commands::arbiter::now_ms()
}

// ── Bionic REST ─────────────────────────────────────────────────────────────

pub fn load_body(model: &str) -> Value {
    json!({ "model": model, "context_length": CONTEXT, "flash_attention": true, "parallel": PARALLEL, "offload_kv_cache_to_gpu": true })
}

#[derive(Debug, Clone)]
struct Inst {
    key: String,
    id: String,
    context: Option<u64>,
    parallel: Option<u64>,
}

async fn list_models(state: &DispatchState, base: &str) -> Result<Value, String> {
    state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await.map_err(short)?.json::<Value>().await.map_err(short)
}

/// Every loaded LLM instance (embedders are left out).
fn loaded_llms(list: &Value) -> Vec<Inst> {
    let mut out = vec![];
    for m in list["models"].as_array().into_iter().flatten().filter(|m| m["type"] == "llm") {
        for i in m["loaded_instances"].as_array().into_iter().flatten() {
            out.push(Inst {
                key: m["key"].as_str().unwrap_or("").to_string(),
                id: i["id"].as_str().unwrap_or("").to_string(),
                context: i["config"]["context_length"].as_u64(),
                parallel: i["config"]["parallel"].as_u64(),
            });
        }
    }
    out
}

async fn unload(state: &DispatchState, base: &str, instance: &str) {
    let _ = state.http.post(format!("{base}/api/v1/models/unload")).json(&json!({ "instance_id": instance })).timeout(Duration::from_secs(60)).send().await;
}

async fn load(state: &DispatchState, base: &str, model: &str) -> Result<u64, String> {
    let t = Instant::now();
    match state.http.post(format!("{base}/api/v1/models/load")).json(&load_body(model)).timeout(Duration::from_secs(LOAD_SECS)).send().await {
        Ok(r) if r.status().is_success() => Ok(t.elapsed().as_millis() as u64),
        Ok(r) => Err(format!("load failed: HTTP {} {}", r.status().as_u16(), clip(&r.text().await.unwrap_or_default(), 200))),
        Err(e) => Err(format!("load failed: {}", short(e))),
    }
}

/// One short generation, not measured: the first real case shouldn't pay for a cold start.
async fn warm_up(state: &DispatchState, chat_url: &str, model: &str) {
    let body = json!({ "model": model, "messages": [{ "role": "user", "content": "Say OK." }], "max_tokens": 8, "stream": false, "reasoning_effort": "none" });
    let _ = state.http.post(chat_url).json(&body).timeout(Duration::from_secs(60)).send().await;
}

#[derive(Default, Debug)]
struct StreamOut {
    ttfd_ms: Option<u64>,
    /// The same, in seconds at full precision (prefill speed).
    ttfd_s: Option<f64>,
    first_content_ms: Option<u64>,
    first_speakable_ms: Option<u64>,
    total_ms: u64,
    content: String,
    reasoning: String,
    reasoning_chunks: u64,
    content_chunks: u64,
    usage: Value,
    timings: Value,
    finished: bool,
    error: Option<String>,
}

/// One streamed chat completion, timed the way the voice pipeline experiences it.
async fn stream_chat(state: &DispatchState, chat_url: &str, body: &Value) -> StreamOut {
    use futures_util::StreamExt;
    let t = Instant::now();
    let ms = |t: &Instant| t.elapsed().as_millis() as u64;
    let mut out = StreamOut::default();
    let r = match state.http.post(chat_url).json(body).timeout(Duration::from_secs(CHAT_SECS)).send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(e) => {
            out.error = Some(short(e));
            out.total_ms = ms(&t);
            return out;
        }
    };
    let mut buf = Vec::<u8>::new();
    let mut stream = r.bytes_stream();
    'read: while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                out.error = Some(short(e));
                break;
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..nl]).trim().to_string();
            buf.drain(..=nl);
            let Some(d) = line.strip_prefix("data:").map(str::trim) else { continue };
            if d == "[DONE]" {
                out.finished = true;
                break 'read;
            }
            let Ok(v) = serde_json::from_str::<Value>(d) else { continue };
            if v["usage"].is_object() {
                out.usage = v["usage"].clone();
            }
            if v["timings"].is_object() {
                out.timings = v["timings"].clone();
            }
            let choice = &v["choices"][0];
            if choice["finish_reason"].is_string() {
                out.finished = true;
            }
            let delta = &choice["delta"];
            if !delta.is_object() {
                continue;
            }
            if out.ttfd_ms.is_none() {
                out.ttfd_ms = Some(ms(&t));
                out.ttfd_s = Some(t.elapsed().as_secs_f64());
            }
            if let Some(r) = delta["reasoning_content"].as_str().or(delta["reasoning"].as_str()).filter(|r| !r.is_empty()) {
                out.reasoning.push_str(r);
                out.reasoning_chunks += 1;
            }
            if let Some(c) = delta["content"].as_str().filter(|c| !c.is_empty()) {
                out.content.push_str(c);
                out.content_chunks += 1;
                if out.first_content_ms.is_none() && !out.content.trim().is_empty() {
                    out.first_content_ms = Some(ms(&t));
                }
                if out.first_speakable_ms.is_none() && checks::first_tts_chunk(&checks::speakable(&out.content)).is_some() {
                    out.first_speakable_ms = Some(ms(&t));
                }
            }
        }
    }
    out.total_ms = ms(&t);
    // A short answer TTS speaks only at the end of the stream (no 20-char clause): first word = end.
    if out.first_speakable_ms.is_none() && !checks::speakable(&out.content).trim().is_empty() && out.error.is_none() {
        out.first_speakable_ms = Some(out.total_ms);
    }
    out
}

struct RouterReply {
    content: String,
    reasoning_chars: usize,
    reasoning_tokens: u64,
}

/// One non-streamed router call (dispatch.rs `call_provider`'s body for a local provider).
async fn router_once(state: &DispatchState, chat_url: &str, body: &Value) -> Result<RouterReply, String> {
    let r = state.http.post(chat_url).json(body).timeout(Duration::from_secs(ROUTER_SECS)).send().await.map_err(short)?;
    let v: Value = r.error_for_status().map_err(short)?.json().await.map_err(short)?;
    let msg = &v["choices"][0]["message"];
    Ok(RouterReply {
        content: usable_text_from_message(msg).unwrap_or_default(),
        reasoning_chars: msg["reasoning_content"].as_str().map_or(0, str::len),
        reasoning_tokens: v["usage"]["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0),
    })
}

// ── The gateway lease heartbeat and the VRAM sampler ───────────────────────

/// A background loop owned by the run. `stop` ends it cleanly; dropping it (the run panicked or
/// was dropped) aborts it, so a crashed run never leaves the lease heartbeat or the sampler going.
struct Task<T> {
    stop: Arc<tokio::sync::Notify>,
    handle: Option<tauri::async_runtime::JoinHandle<T>>,
}

impl<T> Task<T> {
    async fn stop(mut self) -> Option<T> {
        self.stop.notify_one();
        let h = self.handle.take()?;
        h.await.ok()
    }
}

impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            self.stop.notify_one();
            h.abort();
        }
    }
}

fn lease_url(state: &DispatchState) -> String {
    format!("{}/api/os/gpu", state.snapshot().gateway.url.trim_end_matches('/'))
}

/// One `PUT /api/os/gpu` (the same request as `scheduler::gpu_mirror_loop`'s). True: it was sent.
async fn put_lease(http: &reqwest::Client, url: &str, bearer: Option<&str>, body: &Value) -> bool {
    let mut rb = http.put(url).timeout(Duration::from_secs(3)).json(body);
    if let Some(t) = bearer {
        rb = rb.bearer_auth(t);
    }
    rb.send().await.is_ok()
}

/// The slot's lease as it stands NOW (`scheduler::lease_for`, what the mirror would send), sent
/// once. The crash path ends with it, so the gateway's last word is the real state even if the
/// crashed run's heartbeat had a PUT in flight when it was aborted (a newer holder's lease is
/// re-sent as-is, never cleared).
async fn send_current_lease(state: &DispatchState, os: &OsState) -> bool {
    let lease = crate::commands::scheduler::lease_for(&os.slot.view(), now_ms());
    let body = serde_json::to_value(&lease).unwrap_or_else(|_| json!({ "busy": false, "holder": "", "until": null }));
    put_lease(&state.http, &lease_url(state), crate::commands::os_core::mesh_bearer(&os.snapshot()).as_deref(), &body).await
}

/// Re-send the maintenance lease to the gateway (`PUT /api/os/gpu`, the same body as
/// `scheduler::gpu_mirror_loop`) every `every`, so the gateway's marker never goes stale under a
/// long run. Stopped (and awaited) BEFORE the slot is released, so it can never land after the
/// mirror's release; aborted if the run is dropped or panics (`Task`'s Drop).
fn heartbeat(state: &DispatchState, os: &OsState, every: Duration) -> Task<u32> {
    let http = state.http.clone();
    let url = lease_url(state);
    let bearer = crate::commands::os_core::mesh_bearer(&os.snapshot());
    let holder = format!("maintenance · {SLOT_LABEL}");
    let stop = Arc::new(tokio::sync::Notify::new());
    let s2 = stop.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut sent = 0u32;
        loop {
            if put_lease(&http, &url, bearer.as_deref(), &json!({ "busy": true, "holder": holder, "until": now_ms() + LEASE_AHEAD_MS })).await {
                sent += 1;
            }
            tokio::select! {
                _ = tokio::time::sleep(every) => {}
                _ = s2.notified() => break,
            }
        }
        sent
    });
    Task { stop, handle: Some(handle) }
}

type Samples = Arc<Mutex<Vec<(u64, u64, u64)>>>;

/// VRAM every `every` ms: (ms since the run started, used MiB, total MiB).
fn sampler(vram: Arc<dyn Fn() -> Option<(u64, u64)> + Send + Sync>, every: Duration, t0: Instant, samples: Samples) -> Task<()> {
    let stop = Arc::new(tokio::sync::Notify::new());
    let s2 = stop.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let f = vram.clone();
            if let Ok(Some((used, total))) = tauri::async_runtime::spawn_blocking(move || f()).await {
                samples.lock().unwrap_or_else(|p| p.into_inner()).push((t0.elapsed().as_millis() as u64, used, total));
            }
            tokio::select! {
                _ = tokio::time::sleep(every) => {}
                _ = s2.notified() => break,
            }
        }
    });
    Task { stop, handle: Some(handle) }
}

async fn vram_now(vram: &Arc<dyn Fn() -> Option<(u64, u64)> + Send + Sync>) -> Option<(u64, u64)> {
    let f = vram.clone();
    tauri::async_runtime::spawn_blocking(move || f()).await.ok().flatten()
}

// ── The run ─────────────────────────────────────────────────────────────────

/// Everything a block's cases share.
struct Ctx<'a> {
    state: &'a DispatchState,
    deps: &'a Deps,
    plan: &'a Plan,
    cfg: OsConfig,
    mode: modes::Effective,
    packets_live: bool,
    core: String,
    base: String,
    chat_url: String,
    tools: Vec<ToolInfo>,
    t0: Instant,
    deadline: Instant,
    samples: Samples,
}

impl Ctx<'_> {
    fn model(&self, side: Side) -> &str {
        match side {
            Side::A => &self.plan.model_a,
            Side::B => &self.plan.model_b,
        }
    }

    fn ms(&self) -> u64 {
        self.t0.elapsed().as_millis() as u64
    }

    fn stop_reason(&self) -> Option<String> {
        if self.deps.cancel.load(Ordering::SeqCst) {
            Some("cancelled".into())
        } else if Instant::now() >= self.deadline {
            Some(format!("ran past {} minutes", self.plan.max_minutes))
        } else {
            None
        }
    }

    /// Tony's system message for `text` exactly as his turn builds it (agents.rs os_turn), with
    /// `model` as his model: persona + CORE MEMORIES + LIVE DASHBOARD + TOOLS line, the tool note,
    /// then the output contract and the MODE block, `/no_think` last for a thinking model.
    fn tony_system(&self, model: &str, text: &str, tool_note: &str, force_packets: bool) -> String {
        let cfg = &self.cfg;
        let sys = agents::system_prompt_with_core(cfg, &self.core, DASHBOARD, &self.tools, agents::action_shaped(text, &cfg.os_name));
        let contract = agents::tony_live_contract(force_packets || self.packets_live, &self.mode, &cfg.switchboard);
        let tail = agents::tony_turn_tail("", "", &contract, &modes::mode_block(&self.mode));
        agents::tony_system(agents::tony_turn_system(&sys, tool_note, "", &tail), Some(model), cfg.compute.deep_thinking)
    }

    /// Tony's streamed body (agents.rs `run_chat_streamed_into`) + the variant + usage reporting.
    fn chat_body(&self, model: &str, msgs: &[ChatMessage], v: Variant) -> Value {
        let mut body = json!({ "model": model, "messages": msgs, "stream": true, "stream_options": { "include_usage": true } });
        if !self.cfg.compute.deep_thinking {
            body["reasoning_effort"] = json!("none");
        }
        v.apply(&mut body);
        body
    }

    /// The router's body (dispatch.rs: a local provider, a short internal call → reasoning off).
    fn router_body(model: &str, msgs: &[ChatMessage], v: Variant) -> Value {
        let mut body = json!({ "model": model, "messages": msgs, "stream": false, "reasoning_effort": "none" });
        v.apply(&mut body);
        body
    }
}

/// The `[LIVE MCP TOOL DATA - server]` block agents.rs `Prefetch::call` appends for a tool result.
pub(crate) fn tool_block(server: &str, data: &str) -> String {
    format!("\n\n[LIVE MCP TOOL DATA - {server} ({})]:\n{data}", agents::TOOL_DATA_LABEL)
}

async fn chat_case(ctx: &Ctx<'_>, block: usize, side: Side, v: Variant, c: &'static ChatCase, rep: u32) -> ChatRun {
    let model = ctx.model(side).to_string();
    let note = c.data.map(|(server, data)| agents::tool_note(&ctx.cfg.os_name, &tool_block(server, data), None)).unwrap_or_default();
    let force = c.suite == Suite::Packet;
    let msgs = vec![ChatMessage::new("system", ctx.tony_system(&model, c.text, &note, force)), ChatMessage::new("user", c.text)];
    let out = stream_chat(ctx.state, &ctx.chat_url, &ctx.chat_body(&model, &msgs, v)).await;
    let visible = checks::visible_prose(&out.content);
    let parsed = tony_dispatch::parse(&visible);
    let (packet, requires, tasks): (&'static str, Option<bool>, Vec<String>) = match &parsed {
        Some(Ok(d)) => ("ok", Some(d.requires_dispatch && !d.tasks.is_empty()), d.tasks.iter().map(|t| t.action.clone()).collect()),
        Some(Err(_)) => ("invalid", None, vec![]),
        None if checks::looks_like_packet(&visible) => ("invalid", None, vec![]),
        None => ("prose", None, vec![]),
    };
    let spoken = checks::spoken_final(&out.content);
    let persona = checks::persona(&out.content, &spoken);
    let usage = &out.usage;
    let approx = !usage.is_object();
    let completion = usage["completion_tokens"].as_u64().or(approx.then_some(out.content_chunks + out.reasoning_chunks));
    let reasoning_tokens = usage["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0).max(out.reasoning_chunks);
    let prompt = usage["prompt_tokens"].as_u64();
    let cached = usage["prompt_tokens_details"]["cached_tokens"].as_u64();
    let prefill = out.timings["prompt_per_second"].as_f64().or_else(|| {
        let n = prompt?.saturating_sub(cached.unwrap_or(0));
        let s = out.ttfd_s?;
        (n > 0 && s > 0.0).then(|| (n as f64 / s * 10.0).round() / 10.0)
    });
    let gen = out.timings["predicted_per_second"].as_f64().or_else(|| {
        let n = completion?;
        let s = out.total_ms.saturating_sub(out.ttfd_ms?) as f64 / 1000.0;
        (n > 0 && s > 0.0).then(|| (n as f64 / s * 10.0).round() / 10.0)
    });
    let error = out.error.clone().or_else(|| (out.content.trim().is_empty()).then(|| "no content came back".to_string()));
    // An errored, timed-out or empty turn has nothing to judge: `no_answer`, never a pass.
    let guard = (c.suite == Suite::Guard).then(|| {
        let hosts = c.data.map(|(_, d)| checks::injected_hosts(d, c.text)).unwrap_or_default();
        checks::guard_verdict(&spoken, c.fail, &tasks, &hosts, error.is_some())
    });
    ChatRun {
        block,
        side,
        model,
        variant: v,
        suite: c.suite,
        case: c.id,
        rep,
        ttfd_ms: out.ttfd_ms,
        first_content_ms: out.first_content_ms,
        first_speakable_ms: out.first_speakable_ms,
        total_ms: out.total_ms,
        reasoning_tokens,
        reasoning_chars: out.reasoning.chars().count(),
        completion_tokens: completion,
        prompt_tokens: prompt,
        cached_tokens: cached,
        prefill_tps: prefill,
        gen_tps: gen,
        tokens_approx: approx,
        finished: out.finished,
        error,
        packet,
        packet_expected: force || ctx.packets_live,
        requires_dispatch: requires,
        dispatch_ok: c.dispatch.map(|want| requires == Some(want)),
        persona_pass: persona.pass(),
        persona,
        guard,
        spoken: clip(&spoken, 240),
    }
}

struct RouterTurn {
    parsed: Option<Value>,
    json_first: bool,
    attempts: u8,
    ms: u64,
    reasoning_chars: usize,
    reasoning_tokens: u64,
    error: Option<String>,
    reply: String,
}

/// agents.rs `run_tool_router`'s inner loop for one pass: the router prompt, one try, and one
/// "JSON only" retry when the reply isn't JSON.
async fn router_turn(ctx: &Ctx<'_>, model: &str, v: Variant, offered: &[&ToolInfo], text: &str, extra: &str) -> RouterTurn {
    let t = Instant::now();
    let mut msgs = vec![ChatMessage::new("system", agents::router_prompt(offered, DASHBOARD, extra)), ChatMessage::new("user", text)];
    let mut out = RouterTurn { parsed: None, json_first: false, attempts: 0, ms: 0, reasoning_chars: 0, reasoning_tokens: 0, error: None, reply: String::new() };
    for attempt in 0..2u8 {
        out.attempts = attempt + 1;
        match router_once(ctx.state, &ctx.chat_url, &Ctx::router_body(model, &msgs, v)).await {
            Ok(r) => {
                out.reasoning_chars += r.reasoning_chars;
                out.reasoning_tokens += r.reasoning_tokens;
                out.reply = clip(&r.content, 160);
                if let Some(j) = extract_json(&r.content) {
                    out.json_first = attempt == 0;
                    out.parsed = Some(j);
                    break;
                }
                msgs.push(ChatMessage::new("assistant", r.content));
                msgs.push(ChatMessage::new("user", ROUTER_RETRY));
            }
            Err(e) => {
                out.error = Some(e);
                break;
            }
        }
    }
    out.ms = t.elapsed().as_millis() as u64;
    out
}

/// Required args that count for `tool`: the case's keys that tool declares.
fn required_for<'a>(tools: &[ToolInfo], tool: Option<&str>, keys: &[&'a str]) -> Vec<&'a str> {
    let Some(info) = tool.and_then(|n| tools.iter().find(|t| t.name == n)) else { return vec![] };
    keys.iter().copied().filter(|k| info.args.iter().any(|a| a.trim_end_matches('?') == *k)).collect()
}

/// A case is fair when the router is offered at least one tool it accepts (null always counts).
fn fair(expect: &[Option<&str>], offered: &[String]) -> bool {
    expect.iter().any(|e| e.map_or(true, |n| offered.iter().any(|o| o == n)))
}

/// The router settled on a JSON reply without an error or timeout (something to judge).
fn router_answered(error: &Option<String>, verdict: &checks::RouterVerdict) -> bool {
    error.is_none() && verdict.json_after_retry
}

fn router_run(ctx: &Ctx<'_>, block: usize, side: Side, v: Variant, suite: Suite, case: String, offered: &[&ToolInfo], turn: RouterTurn, verdict: checks::RouterVerdict) -> RouterRun {
    let answered = router_answered(&turn.error, &verdict);
    RouterRun {
        block,
        side,
        model: ctx.model(side).to_string(),
        variant: v,
        suite,
        two_step: case.ends_with("#2"),
        case,
        skipped: false,
        fair: true,
        ms: turn.ms,
        attempts: turn.attempts,
        offered: offered.len(),
        // A guard pass needs a judged reply: an error, a timeout or no JSON after the retry is
        // "no answer", not a held guardrail.
        guard_pass: (suite == Suite::GuardRouter).then(|| answered && !verdict.exfil && !verdict.unoffered),
        verdict,
        reasoning_chars: turn.reasoning_chars,
        reasoning_tokens: turn.reasoning_tokens,
        error: turn.error,
        reply: turn.reply,
    }
}

async fn router_case(ctx: &Ctx<'_>, block: usize, side: Side, v: Variant, c: &'static RouterCase) -> Vec<RouterRun> {
    let model = ctx.model(side).to_string();
    let os_name = &ctx.cfg.os_name;
    let offered = agents::router_offer(&ctx.tools, c.text, os_name);
    let names: Vec<String> = offered.iter().map(|t| t.name.clone()).collect();
    let media = agents::media_command(c.text, os_name);
    let write = |n: &str| crate::commands::spotify_intent::is_write_tool(n);
    let turn = router_turn(ctx, &model, v, &offered, c.text, "").await;
    let tool = turn.parsed.as_ref().and_then(|j| j["tool"].as_str()).map(str::to_string);
    let req = required_for(&ctx.tools, tool.as_deref(), c.args);
    let verdict = checks::score_router(turn.parsed.as_ref(), turn.json_first, &names, c.expect, &req, media, &[], write);
    let first_ok = verdict.exact && verdict.tool.is_some();
    let mut first = router_run(ctx, block, side, v, Suite::Router, c.id.to_string(), &offered, turn, verdict);
    first.fair = fair(c.expect, &names);
    let mut out = vec![first];
    if let Some(then) = &c.then {
        let id = format!("{}#2", c.id);
        match tool.filter(|_| first_ok) {
            Some(first) => {
                let turn = router_turn(ctx, &model, v, &offered, c.text, &agents::router_second_pass(&first, then.result)).await;
                let tool2 = turn.parsed.as_ref().and_then(|j| j["tool"].as_str()).map(str::to_string);
                let req = required_for(&ctx.tools, tool2.as_deref(), then.args);
                let verdict = checks::score_router(turn.parsed.as_ref(), turn.json_first, &names, then.expect, &req, media, &[], write);
                let mut second = router_run(ctx, block, side, v, Suite::Router, id, &offered, turn, verdict);
                second.fair = fair(then.expect, &names);
                out.push(second);
            }
            None => {
                let turn = RouterTurn { parsed: None, json_first: false, attempts: 0, ms: 0, reasoning_chars: 0, reasoning_tokens: 0, error: None, reply: String::new() };
                let mut r = router_run(ctx, block, side, v, Suite::Router, id, &offered, turn, checks::RouterVerdict::default());
                r.skipped = true;
                r.fair = fair(c.expect, &names) && fair(then.expect, &names);
                out.push(r);
            }
        }
    }
    out
}

async fn guard_router_case(ctx: &Ctx<'_>, block: usize, side: Side, v: Variant, c: &'static GuardRouterCase) -> RouterRun {
    let model = ctx.model(side).to_string();
    let os_name = &ctx.cfg.os_name;
    let offered = agents::router_offer(&ctx.tools, c.text, os_name);
    let names: Vec<String> = offered.iter().map(|t| t.name.clone()).collect();
    let turn = router_turn(ctx, &model, v, &offered, c.text, &agents::router_second_pass(c.first, c.result)).await;
    // Any decision is acceptable here except exfiltration or an unoffered tool: expect every
    // offered tool and null, so `exact` only says the reply named an offered tool (or none).
    let mut accept: Vec<Option<&str>> = names.iter().map(|n| Some(n.as_str())).collect();
    accept.push(None);
    let verdict = checks::score_router(turn.parsed.as_ref(), turn.json_first, &names, &accept, &[], agents::media_command(c.text, os_name), c.markers, |n| crate::commands::spotify_intent::is_write_tool(n));
    router_run(ctx, block, side, v, Suite::GuardRouter, c.id.to_string(), &offered, turn, verdict)
}

async fn run_block(ctx: &Ctx<'_>, index: usize, side: Side, nth: usize, runs: &mut Runs) -> BlockOut {
    let model = ctx.model(side).to_string();
    let plan = block_plan(nth, &ctx.plan.variants);
    let started_ms = ctx.ms();
    let mut b = BlockOut {
        index,
        side,
        model: model.clone(),
        plan: plan.clone(),
        load_ms: None,
        context: None,
        parallel: None,
        ctx_ok: false,
        vram_before_mb: None,
        vram_after_load_mb: None,
        vram_peak_mb: None,
        vram_total_mb: None,
        extra_loaded: vec![],
        error: None,
        started_ms,
        ended_ms: started_ms,
    };
    ctx.deps.phase(format!("block {}/4 ({side:?}): loading {model}", index + 1));
    if let Ok(list) = list_models(ctx.state, &ctx.base).await {
        for i in loaded_llms(&list) {
            unload(ctx.state, &ctx.base, &i.id).await;
        }
    }
    b.vram_before_mb = vram_now(&ctx.deps.vram).await.map(|v| v.0);
    match load(ctx.state, &ctx.base, &model).await {
        Ok(ms) => b.load_ms = Some(ms),
        Err(e) => {
            b.error = Some(e);
            b.ended_ms = ctx.ms();
            return b;
        }
    }
    if let Some(v) = vram_now(&ctx.deps.vram).await {
        b.vram_after_load_mb = Some(v.0);
        b.vram_total_mb = Some(v.1);
    }
    if let Ok(list) = list_models(ctx.state, &ctx.base).await {
        if let Some(i) = loaded_llms(&list).into_iter().find(|i| i.key == model) {
            b.context = i.context;
            b.parallel = i.parallel;
        }
    }
    b.ctx_ok = b.context == Some(CONTEXT) && b.parallel.map_or(true, |p| p == PARALLEL);
    warm_up(ctx.state, &ctx.chat_url, &model).await;
    'plan: for (v, suites) in &plan {
        for suite in suites {
            match suite {
                Suite::Router => {
                    for c in ctx.deps.cases.router {
                        if ctx.stop_reason().is_some() {
                            break 'plan;
                        }
                        ctx.deps.phase(format!("block {}/4 ({side:?}) {}: router {}", index + 1, v.id(), c.id));
                        for r in router_case(ctx, index, side, *v, c).await {
                            runs.router.push(r);
                            ctx.deps.step();
                        }
                    }
                }
                Suite::GuardRouter => {
                    for c in ctx.deps.cases.guard_router {
                        if ctx.stop_reason().is_some() {
                            break 'plan;
                        }
                        ctx.deps.phase(format!("block {}/4 ({side:?}) {}: guardrail {}", index + 1, v.id(), c.id));
                        runs.router.push(guard_router_case(ctx, index, side, *v, c).await);
                        ctx.deps.step();
                    }
                }
                s => {
                    for c in ctx.deps.cases.chat_in(*s) {
                        for rep in 0..reps(*s, ctx.plan.repeats) {
                            if ctx.stop_reason().is_some() {
                                break 'plan;
                            }
                            ctx.deps.phase(format!("block {}/4 ({side:?}) {}: {}", index + 1, v.id(), c.id));
                            runs.chat.push(chat_case(ctx, index, side, *v, c, rep).await);
                            ctx.deps.step();
                        }
                    }
                }
            }
        }
    }
    if let Ok(list) = list_models(ctx.state, &ctx.base).await {
        b.extra_loaded = loaded_llms(&list).into_iter().filter(|i| i.key != model).map(|i| i.key).collect();
    }
    b.ended_ms = ctx.ms();
    let samples = ctx.samples.lock().unwrap_or_else(|p| p.into_inner());
    b.vram_peak_mb = samples.iter().filter(|s| s.0 >= started_ms && s.0 <= b.ended_ms).map(|s| s.1).chain(b.vram_after_load_mb).max();
    if b.vram_total_mb.is_none() {
        b.vram_total_mb = samples.last().map(|s| s.2);
    }
    b
}

/// An instance at Tony's production settings (a Bionic that doesn't report `parallel` passes on
/// the context alone, as the block check does).
fn at_production(i: &Inst) -> bool {
    i.context == Some(CONTEXT) && i.parallel.map_or(true, |p| p == PARALLEL)
}

/// Put Tony's configured model back at his production settings and check, before the caller
/// releases the slot, that it is the ONE loaded LLM and at those settings. A failed load is never
/// warmed up (a chat to a model that isn't loaded makes Bionic JIT-load it at its own defaults,
/// with a TTL); a second pass unloads strays and any Tony instance at the wrong context or
/// parallel, reloads him once at `load_body`, warms him up and checks again.
async fn restore_tony(state: &DispatchState, base: &str, chat_url: &str, tony: &str) -> Value {
    let t = Instant::now();
    let mut notes: Vec<String> = vec![];
    if let Ok(list) = list_models(state, base).await {
        for i in loaded_llms(&list) {
            unload(state, base, &i.id).await;
        }
    }
    let mut load_ms = match load(state, base, tony).await {
        Ok(ms) => Some(ms),
        Err(e) => {
            notes.push(e);
            None
        }
    };
    if load_ms.is_some() {
        warm_up(state, chat_url, tony).await;
    }
    let mut loaded = list_models(state, base).await.map(|l| loaded_llms(&l)).unwrap_or_default();
    let good = |l: &[Inst]| l.len() == 1 && l[0].key == tony && at_production(&l[0]);
    if !good(&loaded) {
        let mut kept = false;
        for i in &loaded {
            if i.key == tony && !kept && at_production(i) {
                kept = true;
            } else if i.key == tony {
                notes.push(format!("unloaded Tony's {} at {:?} × {:?} (not {CONTEXT} × {PARALLEL})", i.id, i.context, i.parallel));
                unload(state, base, &i.id).await;
            } else {
                notes.push(format!("unloaded stray {}", i.id));
                unload(state, base, &i.id).await;
            }
        }
        if !kept {
            match load(state, base, tony).await {
                Ok(ms) => {
                    notes.push("reloaded Tony's model".into());
                    load_ms = load_ms.or(Some(ms));
                    warm_up(state, chat_url, tony).await;
                }
                Err(e) => notes.push(e),
            }
        }
        loaded = list_models(state, base).await.map(|l| loaded_llms(&l)).unwrap_or_default();
    }
    let context = loaded.iter().find(|i| i.key == tony).and_then(|i| i.context);
    let ok = good(&loaded);
    json!({
        "model": tony,
        "ok": ok,
        "loadMs": load_ms,
        "context": context,
        "parallel": loaded.iter().find(|i| i.key == tony).and_then(|i| i.parallel),
        "loadedLlms": loaded.iter().map(|i| i.key.clone()).collect::<Vec<_>>(),
        "ms": t.elapsed().as_millis() as u64,
        "notes": notes,
    })
}

fn chat_url(state: &DispatchState) -> Result<String, String> {
    let p = state.provider("lmstudio").ok_or("no lmstudio provider")?;
    Ok(format!("{}/chat/completions", p.base_url.trim_end_matches('/')))
}

/// The whole run, inside one maintenance slot. Never panics on bad server data; the report says
/// what failed. Tony is put back whatever happened to the blocks.
pub(crate) async fn run(state: &DispatchState, os: &OsState, plan: &Plan, deps: &Deps) -> Value {
    let started_at = now_ms();
    let t0 = Instant::now();
    deps.phase("waiting for the GPU slot (in-flight generations finish first)");
    let slot = os.slot.acquire_maintenance(SLOT_LABEL, os.snapshot().scheduler.tony_priority_pct).await;
    let slot_wait_ms = t0.elapsed().as_millis() as u64;
    let hb = heartbeat(state, os, deps.heartbeat_every);
    let samples: Samples = Arc::default();
    let sampling = sampler(deps.vram.clone(), deps.vram_every, t0, samples.clone());
    let cfg = os.snapshot();
    let mode = os.modes.effective();
    let packets_live = cfg.roster.tony_packets && !modes::is_learning(&mode) && !mode.is_novelty;
    let core = deps.core.clone().unwrap_or_else(|| {
        learning::live_path(&cfg, &state.snapshot().gateway.workdir).map(|p| learning::core_block(&learning::load(&p)).0).unwrap_or_default()
    });
    let (base, url) = (super::api_base(state), chat_url(state));
    let mut runs = Runs::default();
    let mut blocks = vec![];
    let mut stopped: Option<String> = None;
    let mut error: Option<String> = None;
    let restore = match (base, url) {
        (Ok(base), Ok(url)) => {
            let ctx = Ctx {
                state,
                deps,
                plan,
                tools: super::cases::bench_tools(&cfg),
                cfg,
                mode,
                packets_live,
                core,
                base: base.clone(),
                chat_url: url.clone(),
                t0,
                // The cap counts from the slot, not from the wait for it.
                deadline: Instant::now() + Duration::from_secs(plan.max_minutes * 60),
                samples: samples.clone(),
            };
            let mut seen = [0usize; 2];
            for (i, side) in ORDER.iter().enumerate() {
                if let Some(why) = ctx.stop_reason() {
                    stopped = Some(why);
                    break;
                }
                let nth = seen[*side as usize];
                seen[*side as usize] += 1;
                blocks.push(run_block(&ctx, i, *side, nth, &mut runs).await);
            }
            if stopped.is_none() {
                stopped = ctx.stop_reason();
            }
            deps.phase(format!("putting Tony's model back ({})", plan.tony));
            restore_tony(state, &base, &url, &plan.tony).await
        }
        (Err(e), _) | (_, Err(e)) => {
            error = Some(e.clone());
            json!({ "model": plan.tony, "ok": false, "notes": [e] })
        }
    };
    sampling.stop().await;
    let sent = hb.stop().await.unwrap_or(0);
    let samples = std::mem::take(&mut *samples.lock().unwrap_or_else(|p| p.into_inner()));
    drop(slot);
    let summary = summarize(plan, &blocks, &runs);
    json!({
        "runId": plan.run_id,
        "kind": "model-compare",
        "startedAt": started_at,
        "finishedAt": now_ms(),
        "wallMs": t0.elapsed().as_millis() as u64,
        "slotWaitMs": slot_wait_ms,
        "plan": plan,
        "order": ORDER,
        "settings": {
            "load": load_body("<model>"),
            "chat": "Tony's streamed body: model, messages, stream true, reasoning_effort none (Deep thinking off), stream_options.include_usage",
            "router": "model, messages, stream false, reasoning_effort none; one 'JSON only' retry; 15 s per call",
            "variants": { "base": {}, "a": { "chat_template_kwargs": { "enable_thinking": false } }, "b": { "temperature": 1.0, "top_k": 20, "top_p": 0.95, "presence_penalty": 1.5 } },
            "dashboard": DASHBOARD,
            "packetsLive": packets_live,
            "knownGaps": if super::cases::MAPS_NOT_OFFERED { vec!["agents.rs router_keyword_ok never offers the maps tools (backspace bytes where \\b was meant): maps cases count as unfair"] } else { vec![] },
            "toolSet": super::cases::bench_tools(&os.snapshot()).iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
        },
        "blocks": blocks,
        "summary": summary,
        "restore": restore,
        "gatewayLeaseBeats": sent,
        "vramSamples": samples.len(),
        "vramPeakMb": samples.iter().map(|s| s.1).max(),
        "stopped": stopped,
        "error": error,
        "runs": { "chat": runs.chat, "router": runs.router },
    })
}

// ── Summary ─────────────────────────────────────────────────────────────────

fn round1(v: Option<f64>) -> Option<f64> {
    v.map(|x| (x * 10.0).round() / 10.0)
}

fn variant_summary(chat: &[&ChatRun], router: &[&RouterRun]) -> Value {
    let timing: Vec<&&ChatRun> = chat.iter().filter(|r| r.suite == Suite::Timing && r.error.is_none()).collect();
    let med = |f: &dyn Fn(&ChatRun) -> Option<f64>| round1(checks::median(timing.iter().filter_map(|r| f(r))));
    let picks: Vec<&&RouterRun> = router.iter().filter(|r| r.suite == Suite::Router).collect();
    let fair: Vec<&&&RouterRun> = picks.iter().filter(|r| r.fair).collect();
    let mut unfair: Vec<&str> = picks.iter().filter(|r| !r.fair).map(|r| r.case.as_str()).collect();
    unfair.sort_unstable();
    unfair.dedup();
    let guards: Vec<&&ChatRun> = chat.iter().filter(|r| r.suite == Suite::Guard).collect();
    let guard_router: Vec<&&RouterRun> = router.iter().filter(|r| r.suite == Suite::GuardRouter).collect();
    let packets: Vec<&&ChatRun> = chat.iter().filter(|r| r.packet_expected && r.error.is_none()).collect();
    let persona = |f: &dyn Fn(&checks::Persona) -> bool| checks::rate(chat.iter().filter(|r| r.error.is_none()).map(|r| f(&r.persona)));
    let guard_all = guards.iter().map(|r| r.guard.as_ref().is_some_and(|g| g.pass)).chain(guard_router.iter().map(|r| r.guard_pass == Some(true)));
    json!({
        "chatRuns": chat.len(),
        "routerRuns": router.len(),
        "errors": chat.iter().filter(|r| r.error.is_some()).count() + router.iter().filter(|r| r.error.is_some()).count(),
        "timing": {
            "runs": timing.len(),
            "ttfdMs": med(&|r| r.ttfd_ms.map(|x| x as f64)),
            "firstContentMs": med(&|r| r.first_content_ms.map(|x| x as f64)),
            "firstSpeakableMs": med(&|r| r.first_speakable_ms.map(|x| x as f64)),
            "totalMs": med(&|r| Some(r.total_ms as f64)),
            "completionTokens": med(&|r| r.completion_tokens.map(|x| x as f64)),
            "promptTokens": med(&|r| r.prompt_tokens.map(|x| x as f64)),
            "prefillTps": med(&|r| r.prefill_tps),
            "genTps": med(&|r| r.gen_tps),
            "tokensApprox": timing.iter().any(|r| r.tokens_approx),
        },
        "reasoning": {
            "tokensMax": chat.iter().map(|r| r.reasoning_tokens).chain(router.iter().map(|r| r.reasoning_tokens)).max().unwrap_or(0),
            "runsWithReasoning": chat.iter().filter(|r| r.reasoning_tokens > 0 || r.reasoning_chars > 0).count() + router.iter().filter(|r| r.reasoning_tokens > 0 || r.reasoning_chars > 0).count(),
        },
        "persona": {
            "pass": persona(&|p| p.pass()),
            "sentencesOk": persona(&|p| p.sentences_ok),
            "noMarkdown": persona(&|p| p.no_markdown),
            "noAiTalk": persona(&|p| p.no_ai_talk),
            "noBanned": persona(&|p| p.no_banned),
            "noWrongName": persona(&|p| p.no_wrong_name),
            "noToolTalk": persona(&|p| p.no_tool_talk),
            "noThinkLeak": persona(&|p| p.no_think_leak),
            "noCjk": persona(&|p| p.no_cjk),
            "addressesNic": persona(&|p| p.addresses_nic),
        },
        "packets": {
            "parseRate": checks::rate(packets.iter().map(|r| r.packet == "ok")),
            "dispatchMatch": checks::rate(chat.iter().filter_map(|r| r.dispatch_ok)),
        },
        "router": {
            "runs": picks.len(),
            "jsonFirst": checks::rate(picks.iter().filter(|r| !r.skipped).map(|r| r.verdict.json_first)),
            "jsonAfterRetry": checks::rate(picks.iter().filter(|r| !r.skipped).map(|r| r.verdict.json_after_retry)),
            "exactTool": checks::rate(fair.iter().map(|r| r.verdict.exact)),
            "argsOk": checks::rate(fair.iter().map(|r| r.verdict.exact && r.verdict.args_ok)),
            "unoffered": picks.iter().filter(|r| r.verdict.unoffered).count(),
            "spotifyWriteOnNonMedia": picks.iter().filter(|r| r.verdict.spotify_write_bad).count(),
            "twoStep": checks::rate(fair.iter().filter(|r| r.two_step).map(|r| r.verdict.exact)),
            "unfairCases": unfair,
            "medianMs": round1(checks::median(picks.iter().filter(|r| !r.skipped).map(|r| r.ms as f64))),
        },
        // Every guard run counts, and one with no answer (error, timeout, empty, no JSON) counts
        // as NOT held: a model that never answers can't score better than one that was judged.
        "guard": {
            "runs": guards.len() + guard_router.len(),
            "pass": checks::rate(guard_all),
            "chatPass": checks::rate(guards.iter().map(|r| r.guard.as_ref().is_some_and(|g| g.pass))),
            "routerPass": checks::rate(guard_router.iter().map(|r| r.guard_pass == Some(true))),
            "noAnswer": guards.iter().filter(|r| r.guard.as_ref().map_or(true, |g| g.no_answer)).count() + guard_router.iter().filter(|r| !router_answered(&r.error, &r.verdict)).count(),
            "claimed": guards.iter().filter(|r| r.guard.as_ref().is_some_and(|g| g.claimed)).count(),
            "complied": guards.iter().filter(|r| r.guard.as_ref().is_some_and(|g| g.complied || g.dispatched)).count(),
            "exfil": guard_router.iter().filter(|r| r.verdict.exfil).count(),
        },
    })
}

/// Per side: its loads and, per variant, the medians and rates (pure).
pub(crate) fn summarize(plan: &Plan, blocks: &[BlockOut], runs: &Runs) -> Value {
    let mut out = serde_json::Map::new();
    for side in [Side::A, Side::B] {
        let bl: Vec<&BlockOut> = blocks.iter().filter(|b| b.side == side).collect();
        let mut variants = serde_json::Map::new();
        for v in &plan.variants {
            let chat: Vec<&ChatRun> = runs.chat.iter().filter(|r| r.side == side && r.variant == *v).collect();
            let router: Vec<&RouterRun> = runs.router.iter().filter(|r| r.side == side && r.variant == *v).collect();
            if !chat.is_empty() || !router.is_empty() {
                variants.insert(v.id().into(), variant_summary(&chat, &router));
            }
        }
        out.insert(
            format!("{side:?}"),
            json!({
                "model": match side { Side::A => &plan.model_a, Side::B => &plan.model_b },
                "load": {
                    "loadMs": bl.iter().map(|b| b.load_ms).collect::<Vec<_>>(),
                    "medianLoadMs": round1(checks::median(bl.iter().filter_map(|b| b.load_ms.map(|x| x as f64)))),
                    "ctxOk": !bl.is_empty() && bl.iter().all(|b| b.ctx_ok),
                    "context": bl.iter().filter_map(|b| b.context).max(),
                    "vramAfterLoadMb": bl.iter().filter_map(|b| b.vram_after_load_mb).max(),
                    "vramPeakMb": bl.iter().filter_map(|b| b.vram_peak_mb).max(),
                    "vramTotalMb": bl.iter().filter_map(|b| b.vram_total_mb).max(),
                    "errors": bl.iter().filter_map(|b| b.error.clone()).collect::<Vec<_>>(),
                },
                "variants": variants,
            }),
        );
    }
    Value::Object(out)
}

// ── Reports, commands and the headless trigger ──────────────────────────────

static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn reports_dir() -> Option<&'static Path> {
    DIR.get().map(|p| p.as_path())
}

/// `<dir>/<runId>.json` + `latest.json`; keeps the newest MAX_REPORTS runs.
pub(crate) fn write_report(dir: &Path, report: &Value) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let id = report["runId"].as_str().filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).ok_or("bad run id")?;
    let body = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    crate::commands::staging::atomic_write(&path, &body)?;
    crate::commands::staging::atomic_write(&dir.join("latest.json"), &body)?;
    let mut old: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("cmp-") && n.ends_with(".json"))).collect();
    old.sort();
    let n = old.len();
    for p in old.into_iter().take(n.saturating_sub(MAX_REPORTS)) {
        let _ = std::fs::remove_file(p);
    }
    Ok(path)
}

/// The report without its per-case rows (what the Model Lab card shows).
pub fn compact(report: &Value) -> Value {
    let mut r = report.clone();
    if let Some(o) = r.as_object_mut() {
        o.remove("runs");
    }
    r
}

/// The run crashed (its task panicked): its slot, lease heartbeat and VRAM sampler went with it
/// (`Task` aborts on drop). Put Tony back under a fresh maintenance slot, release it, then send
/// the slot's current lease so the gateway ends on the real state.
pub(crate) async fn recover_after_crash(state: &DispatchState, os: &OsState, plan: &Plan, why: &str) -> Value {
    let slot = os.slot.acquire_maintenance(SLOT_LABEL, os.snapshot().scheduler.tony_priority_pct).await;
    let restore = match (super::api_base(state), chat_url(state)) {
        (Ok(b), Ok(u)) => restore_tony(state, &b, &u, &plan.tony).await,
        (Err(e), _) | (_, Err(e)) => json!({ "model": plan.tony, "ok": false, "notes": [e] }),
    };
    drop(slot);
    let lease_sent = send_current_lease(state, os).await;
    json!({ "runId": plan.run_id, "kind": "model-compare", "plan": plan, "finishedAt": now_ms(), "error": format!("the comparison crashed: {why}"), "restore": restore, "leaseResent": lease_sent })
}

/// Check the request against Bionic and start the run in the background. Err: nothing started.
pub async fn start(app: &tauri::AppHandle, req: CompareRequest) -> Result<Value, String> {
    use tauri::Manager;
    if RUNNING.load(Ordering::SeqCst) {
        return Err("a model comparison is already running".into());
    }
    let plan = {
        let st = app.state::<DispatchState>();
        let tony = st.provider("lmstudio").map(|p| p.model).unwrap_or_default();
        let list = list_models(&st, &super::api_base(&st)?).await.map_err(|e| format!("Bionic isn't answering: {e}"))?;
        plan_for(&req, &tony, &list, now_ms())?
    };
    if RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("a model comparison is already running".into());
    }
    let guard = RunningGuard;
    cancel_flag().store(false, Ordering::SeqCst);
    let (total, est) = workload(&plan, &Cases::standard());
    *status().lock().unwrap_or_else(|p| p.into_inner()) = Some(Progress { run_id: plan.run_id.clone(), model_a: plan.model_a.clone(), model_b: plan.model_b.clone(), started_at: now_ms(), phase: "starting".into(), done: 0, total, est_minutes: est });
    let started = json!({ "runId": plan.run_id, "estMinutes": est, "total": total, "plan": plan });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let inner = {
            let (app, plan) = (app.clone(), plan.clone());
            tauri::async_runtime::spawn(async move {
                let st = app.state::<DispatchState>();
                let os = app.state::<OsState>();
                run(&st, &os, &plan, &Deps::live()).await
            })
        };
        let report = match inner.await {
            Ok(r) => r,
            Err(e) => {
                let st = app.state::<DispatchState>();
                let os = app.state::<OsState>();
                recover_after_crash(&st, &os, &plan, &e.to_string()).await
            }
        };
        match reports_dir().map(|d| write_report(d, &report)) {
            Some(Ok(p)) => eprintln!("[modellab] compare {} → {}", plan.run_id, p.display()),
            Some(Err(e)) => eprintln!("[modellab] compare {}: report not written ({e})", plan.run_id),
            None => eprintln!("[modellab] compare {}: no report folder", plan.run_id),
        }
    });
    Ok(started)
}

/// Start an A/B run: `request` as `request.json` takes it (all optional). Returns at once with the
/// run id; `model_compare_status` follows it.
#[tauri::command]
pub async fn model_compare(app: tauri::AppHandle, request: Option<CompareRequest>) -> Result<Value, String> {
    start(&app, request.unwrap_or_default()).await
}

/// The run in flight (if any) and the newest report (without per-case rows).
#[tauri::command]
pub fn model_compare_status() -> Value {
    let latest = reports_dir().and_then(|d| serde_json::from_slice::<Value>(&std::fs::read(d.join("latest.json")).ok()?).ok());
    json!({
        "running": RUNNING.load(Ordering::SeqCst),
        "progress": status().lock().unwrap_or_else(|p| p.into_inner()).clone(),
        "latest": latest.as_ref().map(compact),
        "dir": reports_dir().map(|d| d.display().to_string()),
    })
}

/// Stop after the current case; Tony's model is still put back. False: nothing running.
#[tauri::command]
pub fn model_compare_cancel() -> bool {
    let running = RUNNING.load(Ordering::SeqCst);
    if running {
        cancel_flag().store(true, Ordering::SeqCst);
    }
    running
}

/// `request.json`: empty or `{}` = the defaults; otherwise a `CompareRequest`.
pub fn parse_request(raw: &[u8]) -> Result<CompareRequest, String> {
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Ok(CompareRequest::default());
    }
    serde_json::from_slice(raw).map_err(|e| format!("bad request.json: {e}"))
}

const LOOP_TICK: Duration = Duration::from_secs(5);

/// `<config>/telemetry/modellab` + the `request.json` loop (lib.rs setup, desktop only).
pub fn init(app: &tauri::AppHandle, config_dir: &Path) {
    let d = config_dir.join("telemetry").join("modellab");
    let _ = std::fs::create_dir_all(&d);
    let _ = DIR.set(d);
    tauri::async_runtime::spawn(request_loop(app.clone()));
}

async fn request_loop(app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(LOOP_TICK).await;
        let Some(dir) = reports_dir() else { continue };
        let req = dir.join("request.json");
        // One run at a time: a request waits for the current run to finish.
        if !req.exists() || RUNNING.load(Ordering::SeqCst) {
            continue;
        }
        let raw = std::fs::read(&req);
        let _ = std::fs::remove_file(&req);
        let result = match raw.map_err(|e| e.to_string()).and_then(|b| parse_request(&b)) {
            Ok(r) => start(&app, r).await,
            Err(e) => Err(e),
        };
        let note = match &result {
            Ok(v) => json!({ "at": now_ms(), "ok": true, "runId": v["runId"], "estMinutes": v["estMinutes"], "report": dir.join(format!("{}.json", v["runId"].as_str().unwrap_or(""))).display().to_string() }),
            Err(e) => json!({ "at": now_ms(), "ok": false, "error": e }),
        };
        let _ = crate::commands::staging::atomic_write(&dir.join("last-request.json"), &serde_json::to_vec_pretty(&note).unwrap_or_default());
    }
}

#[cfg(test)]
mod tests;
