//! Shared LM Studio / Bionic model swapping for GPU borrowers (ComfyUI batches today; meant to
//! replace the private copies in modellab/compare.rs later, which is why the values below are
//! COPIED from there and not re-derived).
//!
//!   snapshot_loaded   GET /api/v1/models → every loaded LLM instance with its load config
//!   unload_all        unload every loaded LLM (embedders are left alone)
//!   load_tony         load Tony's configured model at his production settings
//!                     (compare.rs `load_body` / services.rs `local_fit_once`: 32768 context,
//!                     2 parallel, flash attention, KV cache on the GPU, no TTL)
//!   warm_up           one short generation (only ever after a load that took: a chat to an
//!                     unloaded model makes LM Studio JIT-load it at its own bad defaults)
//!   verify_only_tony  exactly ONE loaded LLM, Tony's, at production settings, with one
//!                     corrective pass (compare.rs `restore_tony` semantics)
//!   restore_tony      unload all → load → warm up → verify_only_tony
//!   vram_sampler      a task reading `system::gpu_now` every 500 ms, keeping the peak MiB
//!   lease_heartbeat   re-sends the maintenance lease (`PUT /api/os/gpu`) every 30 s so a hold
//!                     longer than the gateway's 15 min cap (GPU_MAX_HOLD_SECS) never goes stale
//!
//! The base URL comes from the live providers config the way compare.rs gets it (the
//! `lmstudio` provider's origin; chat at `<base_url>/chat/completions`).
//!
//! Section 26: while Tony runs on the built-in engine (engine.json `enabled && route_tony`,
//! engine_route.rs), `Lm.engine` is set and the same calls drive the engine through the gateway's
//! GPU baton instead: the engine counts as Tony's one loaded instance while it answers,
//! `unload_all` also asks it to step aside (`POST /api/engine/yield`), and `restore_tony` /
//! `verify_only_tony` bring it back (`POST /api/engine/reclaim`) and make sure LM Studio holds no
//! second model next to it. OFF (`engine: None`), every call is exactly LM Studio's, as before.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::dispatch::{short, DispatchState};
use super::os_core::OsState;

/// Tony's production load (compare.rs CONTEXT / PARALLEL, services.rs FIT_CTX).
pub const CONTEXT: u64 = 32_768;
pub const PARALLEL: u64 = 2;
/// compare.rs LOAD_SECS.
const LOAD_SECS: u64 = 300;
/// compare.rs LEASE_AHEAD_MS: a crashed app frees the gateway within two minutes.
pub const LEASE_AHEAD_MS: u64 = 120_000;
/// compare.rs `Deps::live().heartbeat_every`.
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);
pub const VRAM_EVERY: Duration = Duration::from_millis(500);
/// verify_only_tony: listing attempts before giving up (never loading blind).
const LIST_TRIES: u32 = 3;
const LIST_RETRY: Duration = Duration::from_secs(2);

/// compare.rs `load_body`, verbatim.
pub fn load_body(model: &str) -> Value {
    json!({ "model": model, "context_length": CONTEXT, "flash_attention": true, "parallel": PARALLEL, "offload_kv_cache_to_gpu": true })
}

/// One loaded LLM instance and the load config LM Studio reports for it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inst {
    pub key: String,
    pub id: String,
    pub context: Option<u64>,
    pub parallel: Option<u64>,
    /// The whole `config` object as reported (flash attention, KV offload, …).
    pub config: Value,
}

/// Every loaded LLM instance in a `GET /api/v1/models` body (embedders are left out).
pub fn loaded_llms(list: &Value) -> Vec<Inst> {
    let mut out = vec![];
    for m in list["models"].as_array().into_iter().flatten().filter(|m| m["type"] == "llm") {
        for i in m["loaded_instances"].as_array().into_iter().flatten() {
            out.push(Inst {
                key: m["key"].as_str().unwrap_or("").to_string(),
                id: i["id"].as_str().unwrap_or("").to_string(),
                context: i["config"]["context_length"].as_u64(),
                parallel: i["config"]["parallel"].as_u64(),
                config: i["config"].clone(),
            });
        }
    }
    out
}

/// compare.rs `at_production`: a server that doesn't report `parallel` passes on the context alone.
pub fn at_production(i: &Inst) -> bool {
    i.context == Some(CONTEXT) && i.parallel.map_or(true, |p| p == PARALLEL)
}

/// Exactly one loaded LLM, Tony's, at production settings.
pub fn only_tony(loaded: &[Inst], tony: &str) -> bool {
    loaded.len() == 1 && loaded[0].key == tony && at_production(&loaded[0])
}

/// What `verify_only_tony` / `restore_tony` found and did.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    pub model: String,
    pub ok: bool,
    pub load_ms: Option<u64>,
    pub context: Option<u64>,
    pub parallel: Option<u64>,
    pub loaded_llms: Vec<String>,
    pub ms: u64,
    pub notes: Vec<String>,
}

/// One LM Studio REST endpoint and Tony's model on it.
#[derive(Clone)]
pub struct Lm {
    pub http: reqwest::Client,
    /// Origin, e.g. `http://127.0.0.1:1235`.
    pub base: String,
    pub chat_url: String,
    pub tony: String,
    /// Tony is on the built-in engine (Section 26). None = LM Studio only.
    pub engine: Option<EngineCtl>,
}

/// The built-in engine and the gateway that starts and stops it.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineCtl {
    /// `http://127.0.0.1:1238`
    pub origin: String,
    /// The gateway's origin (`/api/engine/yield`, `/api/engine/reclaim`).
    pub gateway: String,
}

/// The engine as one loaded "instance" of Tony's model, for the batch's snapshot (pure).
pub fn engine_inst(tony: &str) -> Inst {
    Inst { key: tony.into(), id: "engine".into(), context: Some(CONTEXT), parallel: Some(PARALLEL), config: json!({ "server": "llama.cpp (built-in engine)" }) }
}

impl Lm {
    /// From the live providers config (compare.rs `api_base` + `chat_url`; Tony = the lmstudio
    /// provider's model).
    pub fn from_dispatch(state: &DispatchState) -> Result<Lm, String> {
        let p = state.provider("lmstudio").ok_or("no lmstudio provider")?;
        let u = url::Url::parse(&p.base_url).map_err(|e| e.to_string())?;
        let route = state.engine_route().filter(|r| r.tony_on());
        let engine = route.as_ref().map(|r| EngineCtl { origin: r.origin(), gateway: state.snapshot().gateway.url.trim_end_matches('/').to_string() });
        Ok(Lm {
            http: state.http.clone(),
            base: u.origin().ascii_serialization(),
            chat_url: format!("{}/chat/completions", p.base_url.trim_end_matches('/')),
            // On the engine, Tony's model is the engine's alias.
            tony: route.map(|r| r.alias).unwrap_or(p.model),
            engine,
        })
    }

    pub async fn list(&self) -> Result<Value, String> {
        let r = self.http.get(format!("{}/api/v1/models", self.base)).timeout(Duration::from_secs(8)).send().await.map_err(short)?;
        r.error_for_status().map_err(short)?.json::<Value>().await.map_err(short)
    }

    /// Every loaded LLM with its load config (LM Studio's, plus the engine while it answers).
    pub async fn snapshot_loaded(&self) -> Result<Vec<Inst>, String> {
        let mut out = self.lm_loaded().await?;
        if self.engine_up().await {
            out.push(engine_inst(&self.tony));
        }
        Ok(out)
    }

    /// LM Studio's loaded LLMs only.
    async fn lm_loaded(&self) -> Result<Vec<Inst>, String> {
        self.list().await.map(|l| loaded_llms(&l))
    }

    /// The engine answers `/health` (always false while Tony is on LM Studio).
    pub async fn engine_up(&self) -> bool {
        let Some(e) = &self.engine else { return false };
        matches!(self.http.get(format!("{}/health", e.origin)).timeout(Duration::from_secs(3)).send().await, Ok(r) if r.status().is_success())
    }

    async fn engine_call(&self, path: &str, body: Value, secs: u64) -> Result<Value, String> {
        let e = self.engine.as_ref().ok_or("Tony is not on the built-in engine")?;
        let r = self.http.post(format!("{}/api/engine/{path}", e.gateway)).json(&body).timeout(Duration::from_secs(secs)).send().await.map_err(short)?;
        let code = r.status();
        let v = r.json::<Value>().await.unwrap_or(Value::Null);
        if code.is_success() {
            Ok(v)
        } else {
            Err(format!("engine {path}: HTTP {} {}", code.as_u16(), v["detail"].as_str().unwrap_or("")))
        }
    }

    pub async fn unload(&self, instance: &str) -> Result<(), String> {
        let r = self.http.post(format!("{}/api/v1/models/unload", self.base)).json(&json!({ "instance_id": instance })).timeout(Duration::from_secs(60)).send().await.map_err(short)?;
        r.error_for_status().map(|_| ()).map_err(short)
    }

    /// Unload every loaded LLM; returns what was loaded. Err: the listing failed (nothing done)
    /// or an unload failed (the rest were still tried).
    pub async fn unload_all(&self) -> Result<Vec<Inst>, String> {
        let mut loaded = self.lm_loaded().await?;
        let mut err = None;
        // The engine steps aside through the gateway's baton (it remembers the model to reclaim).
        if self.engine_up().await {
            match self.engine_call("yield", json!({ "holder": "comfyui" }), 60).await {
                Ok(_) => loaded.push(engine_inst(&self.tony)),
                Err(e) => err = Some(format!("the built-in engine would not step aside: {e}")),
            }
        }
        for i in loaded.iter().filter(|i| i.id != "engine") {
            if let Err(e) = self.unload(&i.id).await {
                err.get_or_insert(format!("unload {} failed: {e}", i.id));
            }
        }
        match err {
            Some(e) => Err(e),
            None => Ok(loaded),
        }
    }

    /// Load Tony's model at production settings; Ok = load ms.
    pub async fn load_tony(&self) -> Result<u64, String> {
        let t = Instant::now();
        match self.http.post(format!("{}/api/v1/models/load", self.base)).json(&load_body(&self.tony)).timeout(Duration::from_secs(LOAD_SECS)).send().await {
            Ok(r) if r.status().is_success() => Ok(t.elapsed().as_millis() as u64),
            Ok(r) => {
                let code = r.status().as_u16();
                let body: String = r.text().await.unwrap_or_default().chars().take(200).collect();
                Err(format!("load failed: HTTP {code} {body}"))
            }
            Err(e) => Err(format!("load failed: {}", short(e))),
        }
    }

    /// compare.rs `warm_up`, verbatim body. Call only after a load that took.
    pub async fn warm_up(&self) {
        let body = json!({ "model": self.tony, "messages": [{ "role": "user", "content": "Say OK." }], "max_tokens": 8, "stream": false, "reasoning_effort": "none" });
        let _ = self.http.post(&self.chat_url).json(&body).timeout(Duration::from_secs(60)).send().await;
    }

    /// Exactly one loaded LLM, Tony's, at production settings. Otherwise ONE corrective pass:
    /// unload strays and any Tony instance at the wrong context/parallel, reload him once at
    /// `load_body` (warming up only a load that took) and check again.
    ///
    /// A listing that fails (LM Studio busy or still starting) is retried; if it never answers,
    /// nothing is loaded: Tony may well be loaded already, and a blind load makes a SECOND
    /// instance (~21 GB on a 12 GB card). Only a successful listing without a production Tony
    /// leads to a load.
    pub async fn verify_only_tony(&self) -> Restore {
        self.verify_only_tony_with(LIST_RETRY).await
    }

    async fn verify_only_tony_with(&self, retry: Duration) -> Restore {
        if self.engine.is_some() {
            return self.verify_engine_with(retry).await;
        }
        let t = Instant::now();
        let mut r = Restore { model: self.tony.clone(), ..Default::default() };
        let mut listed = Err(String::new());
        for n in 0..LIST_TRIES {
            if n > 0 {
                tokio::time::sleep(retry).await;
            }
            listed = self.snapshot_loaded().await;
            if listed.is_ok() {
                break;
            }
        }
        let mut loaded = match listed {
            Ok(l) => l,
            Err(e) => {
                r.notes.push(format!("could not list LM Studio models ({e}); nothing loaded so Tony isn't doubled"));
                r.ms = t.elapsed().as_millis() as u64;
                return r;
            }
        };
        if !only_tony(&loaded, &self.tony) {
            let mut kept = false;
            for i in &loaded {
                if i.key == self.tony && !kept && at_production(i) {
                    kept = true;
                } else if i.key == self.tony {
                    r.notes.push(format!("unloaded Tony's {} at {:?} × {:?} (not {CONTEXT} × {PARALLEL})", i.id, i.context, i.parallel));
                    let _ = self.unload(&i.id).await;
                } else {
                    r.notes.push(format!("unloaded stray {}", i.id));
                    let _ = self.unload(&i.id).await;
                }
            }
            if !kept {
                match self.load_tony().await {
                    Ok(ms) => {
                        r.notes.push("reloaded Tony's model".into());
                        r.load_ms = Some(ms);
                        self.warm_up().await;
                    }
                    Err(e) => r.notes.push(e),
                }
            }
            loaded = self.snapshot_loaded().await.unwrap_or_default();
        }
        let tony = loaded.iter().find(|i| i.key == self.tony);
        r.context = tony.and_then(|i| i.context);
        r.parallel = tony.and_then(|i| i.parallel);
        r.ok = only_tony(&loaded, &self.tony);
        r.loaded_llms = loaded.iter().map(|i| i.key.clone()).collect();
        r.ms = t.elapsed().as_millis() as u64;
        r
    }

    /// Put Tony back: unload everything, load him at production settings, warm up (only a load
    /// that took), then `verify_only_tony`.
    pub async fn restore_tony(&self) -> Restore {
        self.restore_tony_with(LIST_RETRY).await
    }

    async fn restore_tony_with(&self, retry: Duration) -> Restore {
        if self.engine.is_some() {
            return self.verify_engine_with(retry).await;
        }
        let t = Instant::now();
        let mut notes = vec![];
        // A failed unload_all (listing or an unload) means Tony may still be loaded: don't load
        // blind, let verify_only_tony decide from a listing that worked.
        let load_ms = match self.unload_all().await {
            Err(e) => {
                notes.push(e);
                None
            }
            Ok(_) => match self.load_tony().await {
                Ok(ms) => {
                    self.warm_up().await;
                    Some(ms)
                }
                Err(e) => {
                    notes.push(e);
                    None
                }
            },
        };
        let mut r = self.verify_only_tony_with(retry).await;
        notes.append(&mut r.notes);
        r.notes = notes;
        r.load_ms = load_ms.or(r.load_ms);
        r.ms = t.elapsed().as_millis() as u64;
        r
    }
}

impl Lm {
    /// Tony on the built-in engine: LM Studio holds NO LLM (strays unloaded, never a load there),
    /// and the engine answers; if it does not, ONE reclaim through the gateway (same model, warm).
    async fn verify_engine_with(&self, retry: Duration) -> Restore {
        let t = Instant::now();
        let mut r = Restore { model: self.tony.clone(), context: Some(CONTEXT), parallel: Some(PARALLEL), ..Default::default() };
        let mut listed = Err(String::new());
        for n in 0..LIST_TRIES {
            if n > 0 {
                tokio::time::sleep(retry).await;
            }
            listed = self.lm_loaded().await;
            if listed.is_ok() {
                break;
            }
        }
        match listed {
            Ok(l) => {
                for i in &l {
                    r.notes.push(format!("unloaded {} from LM Studio (Tony is on the built-in engine)", i.id));
                    let _ = self.unload(&i.id).await;
                }
            }
            Err(e) => r.notes.push(format!("could not list LM Studio models ({e})")),
        }
        if !self.engine_up().await {
            let t0 = Instant::now();
            match self.engine_call("reclaim", json!({}), LOAD_SECS).await {
                Ok(_) => {
                    r.load_ms = Some(t0.elapsed().as_millis() as u64);
                    r.notes.push("reclaimed the GPU: the built-in engine is back with Tony's model".into());
                }
                Err(e) => r.notes.push(e),
            }
        }
        let lm_left = self.lm_loaded().await.unwrap_or_default();
        let up = self.engine_up().await;
        r.loaded_llms = lm_left.iter().map(|i| i.key.clone()).chain(up.then(|| format!("{} (built-in engine)", self.tony))).collect();
        r.ok = up && lm_left.is_empty();
        r.ms = t.elapsed().as_millis() as u64;
        r
    }
}

// ── Background tasks: lease heartbeat, VRAM sampler ─────────────────────────

/// A background loop owned by its caller (compare.rs `Task`): `stop` ends it cleanly; dropping
/// it aborts it, so a crashed run never leaves a heartbeat or a sampler going.
pub struct Task<T> {
    stop: Arc<tokio::sync::Notify>,
    handle: Option<tauri::async_runtime::JoinHandle<T>>,
}

impl<T> Task<T> {
    /// A task that does nothing (tests, or no gateway).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn idle() -> Self {
        Task { stop: Arc::default(), handle: None }
    }

    pub async fn stop(mut self) -> Option<T> {
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

/// `<gateway>/api/os/gpu` (compare.rs `lease_url`).
pub fn lease_url(state: &DispatchState) -> String {
    format!("{}/api/os/gpu", state.snapshot().gateway.url.trim_end_matches('/'))
}

/// The maintenance holder string the slot shows for `label` (scheduler.rs `acquire_maintenance`).
pub fn maintenance_holder(label: &str) -> String {
    format!("maintenance · {label}")
}

/// Re-send `{busy, holder, until: now + 2 min}` to the gateway every `every` (compare.rs
/// `heartbeat`). Stop it (and await it) BEFORE releasing the slot so a beat never lands after
/// the mirror's release.
pub fn lease_heartbeat(http: reqwest::Client, url: String, bearer: Option<String>, holder: String, every: Duration) -> Task<u32> {
    let stop = Arc::new(tokio::sync::Notify::new());
    let s2 = stop.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut sent = 0u32;
        loop {
            let mut rb = http.put(&url).timeout(Duration::from_secs(3)).json(&json!({ "busy": true, "holder": holder, "until": now_ms() + LEASE_AHEAD_MS }));
            if let Some(t) = &bearer {
                rb = rb.bearer_auth(t);
            }
            if rb.send().await.is_ok() {
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

/// `lease_heartbeat` for the live app (gateway URL + mesh bearer from the live configs).
pub fn live_lease_heartbeat(state: &DispatchState, os: &OsState, label: &str) -> Task<u32> {
    lease_heartbeat(state.http.clone(), lease_url(state), super::os_core::mesh_bearer(&os.snapshot()), maintenance_holder(label), HEARTBEAT_EVERY)
}

/// Used VRAM in MiB (None: no reading).
pub type VramFn = Arc<dyn Fn() -> Option<u64> + Send + Sync>;

/// `system::gpu_now` (the resident nvidia-smi sampler's newest reading).
pub fn live_vram() -> VramFn {
    Arc::new(|| super::system::gpu_now().map(|g| g.vram_used_mb))
}

/// A running VRAM sampler: the peak so far, and how many readings it took.
pub struct Sampler {
    task: Task<()>,
    peak: Arc<AtomicU64>,
    reads: Arc<AtomicU64>,
}

impl Sampler {
    /// Stop and return the peak MiB (None: never got a reading).
    pub async fn stop(self) -> Option<u64> {
        let Sampler { task, peak, reads } = self;
        task.stop().await;
        Some(peak.load(Ordering::SeqCst)).filter(|_| reads.load(Ordering::SeqCst) > 0)
    }
}

pub fn vram_sampler(vram: VramFn, every: Duration) -> Sampler {
    let (peak, reads) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let (p2, r2) = (peak.clone(), reads.clone());
    let stop = Arc::new(tokio::sync::Notify::new());
    let s2 = stop.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let f = vram.clone();
            if let Ok(Some(used)) = tauri::async_runtime::spawn_blocking(move || f()).await {
                p2.fetch_max(used, Ordering::SeqCst);
                r2.fetch_add(1, Ordering::SeqCst);
            }
            tokio::select! {
                _ = tokio::time::sleep(every) => {}
                _ = s2.notified() => break,
            }
        }
    });
    Sampler { task: Task { stop, handle: Some(handle) }, peak, reads }
}

fn now_ms() -> u64 {
    super::arbiter::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::allm::mock::{start as serve, Req, Resp, Server};
    use std::sync::Mutex;

    const TONY: &str = "qwen/qwen3.5-9b";

    #[derive(Default)]
    struct Fake {
        /// (key, ctx, parallel)
        loaded: Vec<(String, u64, u64)>,
        events: Vec<String>,
        fail_load: bool,
        /// A load at these settings instead of what was asked (a JIT race / bad defaults).
        load_as: Option<(u64, u64)>,
        gpu: Vec<Value>,
        /// The next N `GET /api/v1/models` answer 503 (LM Studio busy / starting).
        fail_list: u32,
        /// Section 26: the built-in engine answers /health (yield stops it, reclaim starts it).
        engine_up: bool,
    }
    type Shared = Arc<Mutex<Fake>>;

    fn listing(f: &Fake) -> Value {
        let keys: Vec<String> = {
            let mut k: Vec<String> = f.loaded.iter().map(|l| l.0.clone()).collect();
            k.push(TONY.into());
            k.sort();
            k.dedup();
            k
        };
        let mut models: Vec<Value> = keys
            .iter()
            .map(|key| {
                json!({ "type": "llm", "key": key, "loaded_instances": f.loaded.iter().enumerate().filter(|(_, l)| &l.0 == key).map(|(n, l)| json!({ "id": format!("{}:{n}", l.0), "config": { "context_length": l.1, "parallel": l.2, "flash_attention": true } })).collect::<Vec<_>>() })
            })
            .collect();
        models.push(json!({ "type": "embedding", "key": "nomic", "loaded_instances": [{ "id": "nomic" }] }));
        json!({ "models": models })
    }

    async fn fake(shared: Shared) -> Server {
        serve(move |r: &Req| {
            let mut f = shared.lock().unwrap();
            match (r.method.as_str(), r.path.as_str()) {
                ("GET", "/api/v1/models") if f.fail_list > 0 => {
                    f.fail_list -= 1;
                    f.events.push("list failed".into());
                    Resp::status(503, json!({ "error": "busy" }))
                }
                ("GET", "/api/v1/models") => Resp::json(listing(&f)),
                ("POST", "/api/v1/models/unload") => {
                    let id = r.body["instance_id"].as_str().unwrap_or("").to_string();
                    f.events.push(format!("unload {id}"));
                    let snapshot = f.loaded.clone();
                    f.loaded = snapshot.into_iter().enumerate().filter(|(n, l)| format!("{}:{n}", l.0) != id).map(|(_, l)| l).collect();
                    Resp::json(json!({}))
                }
                ("POST", "/api/v1/models/load") => {
                    let model = r.body["model"].as_str().unwrap_or("").to_string();
                    f.events.push(format!("load {model} {}", r.body));
                    if f.fail_load {
                        return Resp::status(500, json!({ "error": "no memory" }));
                    }
                    let (c, p) = f.load_as.take().unwrap_or((r.body["context_length"].as_u64().unwrap_or(4096), r.body["parallel"].as_u64().unwrap_or(1)));
                    f.loaded.push((model, c, p));
                    Resp::json(json!({ "status": "loaded" }))
                }
                ("POST", "/v1/chat/completions") => {
                    f.events.push(format!("chat {}", r.body["model"].as_str().unwrap_or("")));
                    Resp::json(json!({ "choices": [{ "message": { "content": "OK" } }] }))
                }
                ("PUT", "/api/os/gpu") => {
                    f.gpu.push(r.body.clone());
                    Resp::json(json!({}))
                }
                ("GET", "/health") if f.engine_up => Resp::json(json!({ "status": "ok" })),
                ("GET", "/health") => Resp::status(503, json!({ "error": "down" })),
                ("POST", "/api/engine/yield") => {
                    f.events.push(format!("engine yield {}", r.body["holder"].as_str().unwrap_or("")));
                    f.engine_up = false;
                    Resp::json(json!({ "yielded": true }))
                }
                ("POST", "/api/engine/reclaim") => {
                    f.events.push("engine reclaim".into());
                    f.engine_up = true;
                    Resp::json(json!({ "reclaimed": true }))
                }
                _ => Resp::status(404, json!({})),
            }
        })
        .await
    }

    fn lm(srv: &Server) -> Lm {
        Lm { http: reqwest::Client::new(), base: srv.base.clone(), chat_url: format!("{}/v1/chat/completions", srv.base), tony: TONY.into(), engine: None }
    }

    fn inst(key: &str, ctx: Option<u64>, par: Option<u64>) -> Inst {
        Inst { key: key.into(), id: key.into(), context: ctx, parallel: par, config: Value::Null }
    }

    #[test]
    fn load_body_is_tonys_production_settings() {
        assert_eq!(load_body(TONY), json!({ "model": TONY, "context_length": 32768, "flash_attention": true, "parallel": 2, "offload_kv_cache_to_gpu": true }));
    }

    #[test]
    fn production_and_only_tony_checks() {
        assert!(at_production(&inst(TONY, Some(32768), Some(2))));
        assert!(at_production(&inst(TONY, Some(32768), None)), "parallel not reported passes on context");
        assert!(!at_production(&inst(TONY, Some(123_000), Some(4))));
        assert!(!at_production(&inst(TONY, Some(32768), Some(4))));
        assert!(only_tony(&[inst(TONY, Some(32768), Some(2))], TONY));
        assert!(!only_tony(&[], TONY));
        assert!(!only_tony(&[inst(TONY, Some(32768), Some(2)), inst("other", Some(4096), Some(1))], TONY));
        assert!(!only_tony(&[inst("other", Some(32768), Some(2))], TONY));
    }

    #[test]
    fn loaded_llms_skips_embedders_and_keeps_config() {
        let f = Fake { loaded: vec![(TONY.into(), 32768, 2)], ..Default::default() };
        let l = loaded_llms(&listing(&f));
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].key, TONY);
        assert_eq!(l[0].context, Some(32768));
        assert_eq!(l[0].config["flash_attention"], true);
    }

    #[test]
    fn from_dispatch_uses_the_lmstudio_provider() {
        let st = DispatchState::default();
        st.update(|c| {
            for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
                p.base_url = "http://127.0.0.1:1235/v1".into();
                p.model = TONY.into();
            }
            Ok(())
        })
        .unwrap();
        let lm = Lm::from_dispatch(&st).unwrap();
        assert_eq!(lm.base, "http://127.0.0.1:1235");
        assert_eq!(lm.chat_url, "http://127.0.0.1:1235/v1/chat/completions");
        assert_eq!(lm.tony, TONY);
    }

    #[test]
    fn snapshot_then_unload_all_then_restore() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            shared.lock().unwrap().loaded = vec![(TONY.into(), 32768, 2)];
            let srv = fake(shared.clone()).await;
            let lm = lm(&srv);
            let snap = lm.snapshot_loaded().await.unwrap();
            assert_eq!(snap.len(), 1);
            let un = lm.unload_all().await.unwrap();
            assert_eq!(un.len(), 1);
            assert!(lm.snapshot_loaded().await.unwrap().is_empty());
            let r = lm.restore_tony().await;
            assert!(r.ok, "{r:?}");
            assert_eq!(r.context, Some(32768));
            let ev = shared.lock().unwrap().events.clone();
            // The load is at production settings and the warm-up comes after it.
            let load = ev.iter().position(|e| e.starts_with("load ")).unwrap();
            assert!(ev[load].contains("\"context_length\":32768") && ev[load].contains("\"parallel\":2"));
            assert_eq!(ev[load + 1], format!("chat {TONY}"));
        })
    }

    #[test]
    fn verify_unloads_a_jit_stray_and_keeps_tony() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            shared.lock().unwrap().loaded = vec![(TONY.into(), 32768, 2), ("stray".into(), 4096, 4)];
            let srv = fake(shared.clone()).await;
            let r = lm(&srv).verify_only_tony().await;
            assert!(r.ok, "{r:?}");
            let ev = shared.lock().unwrap().events.clone();
            assert!(ev.iter().any(|e| e.starts_with("unload stray")));
            assert!(!ev.iter().any(|e| e.starts_with("load ")), "Tony was kept, not reloaded");
        })
    }

    #[test]
    fn verify_reloads_tony_at_the_wrong_settings() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            shared.lock().unwrap().loaded = vec![(TONY.into(), 123_000, 4)];
            let srv = fake(shared.clone()).await;
            let r = lm(&srv).verify_only_tony().await;
            assert!(r.ok, "{r:?}");
            assert_eq!(shared.lock().unwrap().loaded, vec![(TONY.to_string(), 32768, 2)]);
        })
    }

    #[test]
    fn a_failed_load_is_never_warmed_up() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            shared.lock().unwrap().fail_load = true;
            let srv = fake(shared.clone()).await;
            let r = lm(&srv).restore_tony().await;
            assert!(!r.ok);
            assert!(r.notes.iter().any(|n| n.contains("load failed: HTTP 500")), "{:?}", r.notes);
            assert!(!shared.lock().unwrap().events.iter().any(|e| e.starts_with("chat")), "no chat → no JIT load");
        })
    }

    #[test]
    fn one_corrective_pass_only() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            // The reload lands at bad settings: one pass, then it reports not ok (no loop).
            shared.lock().unwrap().load_as = Some((8192, 1));
            let srv = fake(shared.clone()).await;
            let r = lm(&srv).verify_only_tony().await;
            assert!(!r.ok);
            assert_eq!(shared.lock().unwrap().events.iter().filter(|e| e.starts_with("load ")).count(), 1);
        })
    }

    #[test]
    fn a_failed_listing_never_loads_a_second_tony() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            {
                let mut f = shared.lock().unwrap();
                f.loaded = vec![(TONY.into(), 32768, 2)];
                f.fail_list = 100;
            }
            let srv = fake(shared.clone()).await;
            let r = lm(&srv).verify_only_tony_with(Duration::from_millis(5)).await;
            assert!(!r.ok);
            assert!(r.notes.iter().any(|n| n.contains("could not list")), "{:?}", r.notes);
            let r = lm(&srv).restore_tony_with(Duration::from_millis(5)).await;
            assert!(!r.ok);
            let f = shared.lock().unwrap();
            assert!(!f.events.iter().any(|e| e.starts_with("load ")), "no blind load: {:?}", f.events);
            assert_eq!(f.loaded, vec![(TONY.to_string(), 32768, 2)], "still exactly one Tony");
        })
    }

    #[test]
    fn a_listing_that_recovers_on_retry_keeps_tony() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            {
                let mut f = shared.lock().unwrap();
                f.loaded = vec![(TONY.into(), 32768, 2)];
                f.fail_list = 2;
            }
            let srv = fake(shared.clone()).await;
            let r = lm(&srv).verify_only_tony_with(Duration::from_millis(5)).await;
            assert!(r.ok, "{r:?}");
            assert!(!shared.lock().unwrap().events.iter().any(|e| e.starts_with("load ")));
        })
    }

    #[test]
    fn heartbeat_beats_until_stopped() {
        tauri::async_runtime::block_on(async {
            let shared: Shared = Arc::default();
            let srv = fake(shared.clone()).await;
            let hb = lease_heartbeat(reqwest::Client::new(), format!("{}/api/os/gpu", srv.base), None, maintenance_holder("comfyui · 2 job(s)"), Duration::from_millis(30));
            tokio::time::sleep(Duration::from_millis(110)).await;
            let sent = hb.stop().await.unwrap();
            assert!(sent >= 2, "{sent}");
            let n = shared.lock().unwrap().gpu.len();
            tokio::time::sleep(Duration::from_millis(80)).await;
            let f = shared.lock().unwrap();
            assert_eq!(f.gpu.len(), n, "nothing after stop");
            assert_eq!(f.gpu[0]["holder"], "maintenance · comfyui · 2 job(s)");
            assert_eq!(f.gpu[0]["busy"], true);
            let until = f.gpu[0]["until"].as_u64().unwrap();
            assert!(until > now_ms() && until <= now_ms() + LEASE_AHEAD_MS);
        })
    }

    #[test]
    fn sampler_keeps_the_peak() {
        tauri::async_runtime::block_on(async {
            let n = Arc::new(AtomicU64::new(0));
            let n2 = n.clone();
            let s = vram_sampler(Arc::new(move || Some([3000, 9500, 7000][(n2.fetch_add(1, Ordering::SeqCst) % 3) as usize])), Duration::from_millis(5));
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(s.stop().await, Some(9500));
            let none = vram_sampler(Arc::new(|| None), Duration::from_millis(5));
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert_eq!(none.stop().await, None);
        })
    }

    fn engine_lm(srv: &Server) -> Lm {
        Lm { engine: Some(EngineCtl { origin: srv.base.clone(), gateway: srv.base.clone() }), ..lm(srv) }
    }

    #[tokio::test]
    async fn off_never_touches_the_engine() {
        let shared: Shared = Arc::new(Mutex::new(Fake { loaded: vec![(TONY.into(), 32768, 2)], engine_up: true, ..Default::default() }));
        let srv = fake(shared.clone()).await;
        let l = lm(&srv);
        assert_eq!(l.snapshot_loaded().await.unwrap().len(), 1, "an engine answering is not counted while OFF");
        assert!(!l.engine_up().await);
        l.unload_all().await.unwrap();
        assert!(!shared.lock().unwrap().events.iter().any(|e| e.starts_with("engine")));
    }

    #[tokio::test]
    async fn on_the_engine_steps_aside_and_comes_back_without_any_lm_studio_load() {
        let shared: Shared = Arc::new(Mutex::new(Fake { engine_up: true, ..Default::default() }));
        let srv = fake(shared.clone()).await;
        let l = engine_lm(&srv);
        let snap = l.snapshot_loaded().await.unwrap();
        assert_eq!(snap, vec![engine_inst(TONY)], "the engine is Tony's one instance");
        let gone = l.unload_all().await.unwrap();
        assert_eq!(gone, vec![engine_inst(TONY)]);
        assert!(!shared.lock().unwrap().engine_up);
        assert!(l.snapshot_loaded().await.unwrap().is_empty(), "the JIT watch sees nothing while yielded");
        let r = l.restore_tony_with(Duration::from_millis(1)).await;
        assert!(r.ok, "{r:?}");
        assert!(r.load_ms.is_some());
        let ev = shared.lock().unwrap().events.clone();
        assert_eq!(ev, vec!["engine yield comfyui".to_string(), "engine reclaim".to_string()]);
        assert!(!ev.iter().any(|e| e.starts_with("load ")), "never loads Tony in LM Studio while he is on the engine");
    }

    #[tokio::test]
    async fn on_verify_unloads_lm_studio_strays_and_reclaims_once() {
        let shared: Shared = Arc::new(Mutex::new(Fake { loaded: vec![(TONY.into(), 4096, 1)], engine_up: false, ..Default::default() }));
        let srv = fake(shared.clone()).await;
        let r = engine_lm(&srv).verify_only_tony_with(Duration::from_millis(1)).await;
        assert!(r.ok, "{r:?}");
        let ev = shared.lock().unwrap().events.clone();
        assert!(ev.contains(&format!("unload {TONY}:0")), "{ev:?}");
        assert_eq!(ev.iter().filter(|e| *e == "engine reclaim").count(), 1);
        assert!(r.loaded_llms.iter().any(|k| k.contains("built-in engine")));
    }

    #[tokio::test]
    async fn on_a_refused_yield_is_an_unload_error() {
        let shared: Shared = Arc::new(Mutex::new(Fake { engine_up: true, ..Default::default() }));
        let srv = fake(shared.clone()).await;
        let l = Lm { engine: Some(EngineCtl { origin: srv.base.clone(), gateway: "http://127.0.0.1:9".into() }), ..lm(&srv) };
        assert!(l.unload_all().await.unwrap_err().contains("would not step aside"));
    }
}
