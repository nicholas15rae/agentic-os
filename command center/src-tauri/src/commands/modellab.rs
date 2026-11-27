//! Model Lab: try local models one at a time on the 12 GB card.
//!
//!   model_lab_list   — every LLM Bionic/LM Studio knows, with size + a VRAM-fit estimate
//!   model_bench      — load ONE model alone at a context that fits, measure load time,
//!                      time-to-first-token, tokens/s and VRAM, answer a real prompt
//!   model_use        — make it Tony's brain: providers.json + AnythingLLM default +
//!                      every AnythingLLM workspace on LM Studio, so a second model is
//!                      never auto-loaded next to it (the VRAM-spill trap). Refuses a model
//!                      that is only "tight" or "spills to RAM" here (or whose fit can't be
//!                      checked) with `FIT_WARN:` unless `force` (the UI's explicit confirm).
//!   model_compare    — A/B a candidate against Tony's model on Tony's own prompts inside ONE
//!                      maintenance slot, then put Tony's model back (compare.rs; never model_use)

mod cases;
mod checks;
pub mod compare;

use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::State;

use super::allm::{AllmConn, AllmWriter};
use super::dispatch::{short, DispatchState};
use super::os_core::{OsConfig, OsState};

const VRAM_RESERVED_GB: f64 = 3.3; // Windows compositor + browsers + headroom

fn api_base(state: &DispatchState) -> Result<String, String> {
    let cfg = state.snapshot();
    let p = cfg.providers.iter().find(|p| p.id == "lmstudio").ok_or("no lmstudio provider")?;
    let u = url::Url::parse(&p.base_url).map_err(|e| e.to_string())?;
    Ok(u.origin().ascii_serialization())
}

/// Context that keeps weights + KV cache inside VRAM (rough but conservative).
pub fn fit_context(size_gb: f64, vram_total_gb: f64) -> (u64, &'static str) {
    let budget = vram_total_gb - VRAM_RESERVED_GB - size_gb;
    if budget > 2.5 {
        (32_768, "fits")
    } else if budget > 1.4 {
        (16_384, "fits")
    } else if budget > 0.7 {
        (8_192, "tight")
    } else if budget > 0.2 {
        (4_096, "tight")
    } else {
        (4_096, "spills to RAM — slow")
    }
}

/// Why `fit` (from `fit_context`) needs an explicit confirm before the model becomes Tony's brain,
/// or `None` when it fits. Pure. The message starts with `FIT_WARN:` so the UI can ask.
pub fn brain_fit_warning(name: &str, fit: &str, context: u64) -> Option<String> {
    match fit {
        "fits" => None,
        "tight" => Some(format!("FIT_WARN:tight: {name} only fits the GPU at a {}k context; Tony's turns may slow down or spill into system RAM", context / 1024)),
        _ => Some(format!("FIT_WARN:spills: {name} won't fit the GPU even at {}k context; it spills into system RAM and every answer crawls", context / 1024)),
    }
}

fn vram_total_gb() -> f64 {
    super::system::query_gpu().map(|g| g.vram_total_mb as f64 / 1024.0).unwrap_or(12.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabModel {
    key: String,
    name: String,
    params: String,
    quant: String,
    size_gb: f64,
    vision: bool,
    loaded: bool,
    context: u64,
    fit: String,
    tony: bool,
}

#[tauri::command]
pub async fn model_lab_list(state: State<'_, DispatchState>) -> Result<Vec<LabModel>, String> {
    lab_models(&state).await
}

async fn lab_models(state: &DispatchState) -> Result<Vec<LabModel>, String> {
    let base = api_base(state)?;
    let v: Value = state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await.map_err(short)?.json().await.map_err(short)?;
    let total = tauri::async_runtime::spawn_blocking(vram_total_gb).await.unwrap_or(12.0);
    let tony = state.provider("lmstudio").map(|p| p.model).unwrap_or_default();
    let mut out: Vec<LabModel> = v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["type"] == "llm")
        .map(|m| {
            let size = m["size_bytes"].as_f64().unwrap_or(0.0) / 1e9;
            let (ctx, fit) = fit_context(size, total);
            LabModel {
                key: m["key"].as_str().unwrap_or("").into(),
                name: m["display_name"].as_str().unwrap_or("").into(),
                params: m["params_string"].as_str().unwrap_or("").into(),
                quant: m["quantization"]["name"].as_str().unwrap_or("").into(),
                size_gb: (size * 10.0).round() / 10.0,
                vision: m["capabilities"]["vision"].as_bool().unwrap_or(false),
                loaded: m["loaded_instances"].as_array().is_some_and(|a| !a.is_empty()),
                context: ctx,
                fit: fit.into(),
                tony: m["key"].as_str() == Some(tony.as_str()),
            }
        })
        .collect();
    out.sort_by(|a, b| a.size_gb.partial_cmp(&b.size_gb).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchResult {
    model: String,
    context: u64,
    load_ms: u128,
    first_token_ms: u128,
    tokens_per_sec: f64,
    vram_used_gb: f64,
    vram_total_gb: f64,
    reply: String,
    error: Option<String>,
}

async fn unload_all(state: &DispatchState, base: &str) {
    if let Ok(r) = state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await {
        if let Ok(v) = r.json::<Value>().await {
            for m in v["models"].as_array().into_iter().flatten().filter(|m| m["type"] == "llm") {
                for i in m["loaded_instances"].as_array().into_iter().flatten() {
                    if let Some(id) = i["id"].as_str() {
                        let _ = state.http.post(format!("{base}/api/v1/models/unload")).json(&json!({ "instance_id": id })).timeout(Duration::from_secs(60)).send().await;
                    }
                }
            }
        }
    }
}

/// Benchmark one model. Unloading / loading models is GPU maintenance: it runs only once every
/// in-flight generation has finished, and nothing else generates until it is done.
pub async fn bench(state: &DispatchState, os: &OsState, model: &str, context: Option<u64>) -> BenchResult {
    let _slot = os.slot.acquire_maintenance(&format!("bench {}", model.chars().take(40).collect::<String>()), os.snapshot().scheduler.tony_priority_pct).await;
    bench_unlocked(state, model, context).await
}

async fn bench_unlocked(state: &DispatchState, model: &str, context: Option<u64>) -> BenchResult {
    let total = tauri::async_runtime::spawn_blocking(vram_total_gb).await.unwrap_or(12.0);
    let mut res = BenchResult { model: model.into(), context: 0, load_ms: 0, first_token_ms: 0, tokens_per_sec: 0.0, vram_used_gb: 0.0, vram_total_gb: (total * 10.0).round() / 10.0, reply: String::new(), error: None };
    let base = match api_base(state) {
        Ok(b) => b,
        Err(e) => {
            res.error = Some(e);
            return res;
        }
    };
    // Size → context that fits.
    let size: Option<Value> = match state.http.get(format!("{base}/api/v1/models")).timeout(Duration::from_secs(8)).send().await {
        Ok(r) => r.json().await.ok(),
        Err(_) => None,
    };
    let size_gb = size
        .as_ref()
        .and_then(|v| v["models"].as_array()?.iter().find(|m| m["key"] == model).and_then(|m| m["size_bytes"].as_f64()))
        .unwrap_or(6e9)
        / 1e9;
    let ctx = context.unwrap_or_else(|| fit_context(size_gb, total).0);
    res.context = ctx;
    unload_all(state, &base).await;
    let t0 = Instant::now();
    let load = state.http.post(format!("{base}/api/v1/models/load")).json(&json!({ "model": model, "context_length": ctx, "flash_attention": true, "parallel": 2, "offload_kv_cache_to_gpu": true })).timeout(Duration::from_secs(300)).send().await;
    match load {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => {
            res.error = Some(format!("load failed: HTTP {} {}", r.status().as_u16(), r.text().await.unwrap_or_default().chars().take(200).collect::<String>()));
            return res;
        }
        Err(e) => {
            res.error = Some(format!("load failed: {}", short(e)));
            return res;
        }
    }
    res.load_ms = t0.elapsed().as_millis();

    // Streamed answer: time to first token + generation speed.
    use futures_util::StreamExt;
    let body = json!({ "model": model, "stream": true, "max_tokens": 160, "reasoning_effort": "none",
        "messages": [{ "role": "system", "content": "You are Tony, a concise assistant." }, { "role": "user", "content": "In two short sentences: what should I focus on today if I'm an actor who builds apps?" }] });
    let t1 = Instant::now();
    let r = match state.http.post(format!("{base}/v1/chat/completions")).json(&body).timeout(Duration::from_secs(180)).send().await {
        Ok(r) => r,
        Err(e) => {
            res.error = Some(short(e));
            return res;
        }
    };
    let mut first = None;
    let mut tokens = 0usize;
    let mut buf = String::new();
    let mut stream = r.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            if let Some(d) = line.strip_prefix("data:").map(str::trim).filter(|d| *d != "[DONE]") {
                if let Ok(v) = serde_json::from_str::<Value>(d) {
                    let delta = &v["choices"][0]["delta"];
                    let piece = delta["content"].as_str().or(delta["reasoning_content"].as_str()).unwrap_or("");
                    if !piece.is_empty() {
                        first.get_or_insert_with(|| t1.elapsed().as_millis());
                        tokens += 1;
                        if delta["content"].is_string() {
                            res.reply.push_str(piece);
                        }
                    }
                }
            }
        }
    }
    let gen_secs = (t1.elapsed().as_millis().saturating_sub(first.unwrap_or(0))) as f64 / 1000.0;
    res.first_token_ms = first.unwrap_or(0);
    res.tokens_per_sec = if gen_secs > 0.0 { (tokens as f64 / gen_secs * 10.0).round() / 10.0 } else { 0.0 };
    res.vram_used_gb = tauri::async_runtime::spawn_blocking(super::system::query_gpu).await.ok().flatten().map(|g| (g.vram_used_mb as f64 / 102.4).round() / 10.0).unwrap_or(0.0);
    res.reply = super::dispatch::strip_think(&res.reply).chars().take(300).collect();
    if tokens == 0 {
        res.error = Some("no tokens came back".into());
    }
    res
}

#[tauri::command]
pub async fn model_bench(state: State<'_, DispatchState>, os: State<'_, OsState>, model: String, context: Option<u64>) -> Result<BenchResult, String> {
    Ok(bench(&state, &os, &model, context).await)
}

/// Make `model` Tony's brain everywhere (one model on the GPU). A model that doesn't fit the card
/// comfortably (or whose fit can't be checked) is refused with `FIT_WARN:` unless `force`.
#[tauri::command]
pub async fn model_use(state: State<'_, DispatchState>, os: State<'_, OsState>, model: String, force: Option<bool>) -> Result<Vec<String>, String> {
    if !force.unwrap_or(false) {
        let list = lab_models(&state).await.map_err(|e| format!("FIT_WARN:unknown: couldn't check whether {model} fits the GPU ({e})"))?;
        let m = list.iter().find(|m| m.key == model).ok_or_else(|| format!("FIT_WARN:unknown: {model} isn't in LM Studio's model list, so its fit can't be checked"))?;
        if let Some(w) = brain_fit_warning(if m.name.is_empty() { &m.key } else { &m.name }, &m.fit, m.context) {
            return Err(w);
        }
    }
    use_model(&state, &os.snapshot(), model).await
}

/// The AnythingLLM endpoint the Model Lab writes to: `os.json anythingllm.baseUrl` (the same one
/// every chat uses), never a hard-coded port.
pub(crate) fn model_lab_allm(state: &DispatchState, cfg: &OsConfig, key: String) -> AllmWriter {
    AllmWriter::for_model_lab(AllmConn::from_cfg_key(state, cfg, key))
}

/// Point AnythingLLM's default and every LM Studio workspace at `model` (chat model only; the
/// agent model, context and parallelism are left alone, decision D9).
pub(crate) async fn apply_model_to_allm(w: &AllmWriter, model: &str) -> Vec<String> {
    let mut notes = vec![];
    if w.update_env(json!({ "LMStudioModelPref": model }), 20).await.is_ok() {
        notes.push("AnythingLLM default → same model".into());
    }
    if let Ok(v) = w.list_workspaces(10).await {
        for ws in v["workspaces"].as_array().into_iter().flatten().filter(|ws| ws["chatProvider"] == "lmstudio") {
            let slug = ws["slug"].as_str().unwrap_or("");
            if w.update_workspace(slug, json!({ "chatModel": model }), 20).await.is_ok() {
                notes.push(format!("workspace {slug} → same model"));
            }
        }
    }
    notes
}

pub async fn use_model(state: &DispatchState, cfg: &OsConfig, model: String) -> Result<Vec<String>, String> {
    if model.is_empty() || model.len() > 200 {
        return Err("bad model id".into());
    }
    let mut notes = vec![];
    state.update(|c| {
        for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
            p.model = model.clone();
        }
        Ok(())
    })?;
    notes.push(format!("Tony → {model}"));
    if let Some(key) = super::secrets::get(state, "anythingllm") {
        super::secrets::warn_allm_host_mismatch(state, &cfg.anythingllm.base_url);
        notes.extend(apply_model_to_allm(&model_lab_allm(state, cfg, key), &model).await);
    }
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn use_model_uses_the_cfg_base() {
        use super::super::allm::mock::{start, Req, Resp};
        tauri::async_runtime::block_on(async {
            let srv = start(|r: &Req| {
                if r.method == "GET" {
                    return Resp::json(json!({ "workspaces": [{ "slug": "coder", "chatProvider": "lmstudio" }, { "slug": "librarian", "chatProvider": null }] }));
                }
                Resp::json(json!({}))
            })
            .await;
            let st = DispatchState::default();
            let mut cfg = OsConfig::default();
            cfg.anythingllm.base_url = srv.base.clone();
            let w = model_lab_allm(&st, &cfg, "k".into());
            assert_eq!(w.base(), srv.base);
            let notes = apply_model_to_allm(&w, "qwen/qwen3.5-9b").await;
            assert_eq!(notes.len(), 2, "{notes:?}");
            let paths: Vec<String> = srv.reqs().into_iter().map(|r| format!("{} {}", r.method, r.path)).collect();
            assert_eq!(paths, vec!["POST /api/v1/system/update-env", "GET /api/v1/workspaces", "POST /api/v1/workspace/coder/update"]);
            assert!(srv.reqs().iter().all(|r| r.body.get("agentModel").is_none()), "agentModel is left alone (D9)");
        });
    }

    #[test]
    fn bench_waits_for_the_gpu_slot() {
        tauri::async_runtime::block_on(async {
            let st = DispatchState::default();
            // No LM Studio provider reachable on this port → bench errors fast once it runs.
            let _ = st.update(|c| {
                for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
                    p.base_url = "http://127.0.0.1:9/v1".into();
                }
                Ok(())
            });
            let os = std::sync::Arc::new(OsState::default());
            let st = std::sync::Arc::new(st);
            let holder = os.slot.acquire("tony", true, 90).await;
            let (o2, s2) = (os.clone(), st.clone());
            let h = tauri::async_runtime::spawn(async move { bench(&s2, &o2, "m", Some(4096)).await });
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(!h.inner().is_finished(), "bench must not start while a generation holds the slot");
            assert_eq!(os.slot.view().queued_background, 1);
            drop(holder);
            let r = h.await.unwrap();
            assert!(r.error.is_some());
        });
    }

    #[test]
    fn fit() {
        assert_eq!(fit_context(6.5, 12.0).0, 32_768 - 16_384); // 9B: 2.2 GB budget → 16k
        assert_eq!(fit_context(3.4, 12.0).0, 32_768); // 4B
        assert_eq!(fit_context(9.0, 12.0).1, "spills to RAM — slow"); // 14B on 12 GB
    }

    #[test]
    fn only_a_comfortable_fit_skips_the_brain_confirm() {
        assert_eq!(brain_fit_warning("Qwen 9B", "fits", 16_384), None);
        let (ctx, fit) = fit_context(7.6, 12.0);
        let t = brain_fit_warning("Gemma 12B", fit, ctx).unwrap();
        assert!(t.starts_with("FIT_WARN:tight:") && t.contains("Gemma 12B"), "{t}");
        let (ctx, fit) = fit_context(9.0, 12.0);
        assert!(brain_fit_warning("14B", fit, ctx).unwrap().starts_with("FIT_WARN:spills:"));
    }

    #[test]
    fn model_use_refuses_without_force_when_the_fit_is_unknown() {
        tauri::async_runtime::block_on(async {
            let st = DispatchState::default();
            let _ = st.update(|c| {
                for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
                    p.base_url = "http://127.0.0.1:9/v1".into();
                }
                Ok(())
            });
            // The command's own guard (no Tauri State in a unit test): the list can't load.
            let e = lab_models(&st).await.map_err(|e| format!("FIT_WARN:unknown: ({e})")).err().unwrap();
            assert!(e.starts_with("FIT_WARN:unknown"));
            let src = include_str!("modellab.rs");
            let cmd = src.split("pub async fn model_use(").nth(1).unwrap();
            let guard = cmd.find("if !force.unwrap_or(false)").unwrap();
            assert!(guard < cmd.find("use_model(&state").unwrap(), "the fit check runs before the switch");
        });
    }

    /// `MODEL=… cargo test --lib live_model_use -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_model_use() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            println!("USE {:?}", use_model(&state, &os.snapshot(), std::env::var("MODEL").unwrap()).await);
        });
    }

    /// `cargo test --lib live_model_bench -- --ignored --nocapture` — benchmark every local LLM,
    /// then put the current Tony model back.
    #[test]
    #[ignore]
    fn live_model_bench() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let tony = state.provider("lmstudio").unwrap().model;
            let base = api_base(&state).unwrap();
            let v: Value = state.http.get(format!("{base}/api/v1/models")).send().await.unwrap().json().await.unwrap();
            let only: Vec<String> = std::env::var("MODELS").map(|m| m.split(',').map(|x| x.trim().to_string()).collect()).unwrap_or_default();
            let models: Vec<String> = v["models"].as_array().unwrap().iter().filter(|m| m["type"] == "llm").filter_map(|m| m["key"].as_str().map(String::from)).filter(|k| only.is_empty() || only.contains(k)).collect();
            for m in models {
                let r = bench(&state, &os, &m, None).await;
                println!(
                    "BENCH {:<34} ctx {:>6} | load {:>5} ms | first token {:>5} ms | {:>5.1} tok/s | VRAM {:>4.1}/{:.0} GB | {}",
                    r.model, r.context, r.load_ms, r.first_token_ms, r.tokens_per_sec, r.vram_used_gb, r.vram_total_gb,
                    r.error.unwrap_or_else(|| format!("“{}”", r.reply.replace('\n', " ").chars().take(70).collect::<String>()))
                );
            }
            let r = bench(&state, &os, &tony, Some(32_768)).await;
            println!("RESTORED {} ({})", r.model, r.error.unwrap_or_else(|| "ok".into()));
        });
    }
}
