//! Live service health, model discovery, and keeping the gateway alive.
//!
//! Nodes are only shown green after a real probe answers. Before this, the
//! UI showed "configured" as if it meant "running".

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::State;

use super::dispatch::{short, DispatchState, Kind, Provider};
use super::os_core;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    id: String,
    label: String,
    kind: String,
    up: bool,
    latency_ms: u128,
    detail: String,
    /// Switched off by the user (droplet master switch / kill switch) — not a fault.
    manual: bool,
}

fn origin(base: &str) -> String {
    url::Url::parse(base).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| base.to_string())
}

/// Which URL proves a provider is alive, per kind/engine.
fn probe_url(p: &Provider) -> String {
    let base = p.base_url.trim_end_matches('/');
    match p.kind {
        Kind::AgenticOs => format!("{base}/api/status"),
        Kind::N8n => format!("{base}/healthz"),
        Kind::Tts if p.engine.as_deref() == Some("xtts") => format!("{}/speakers_list", origin(base)),
        Kind::Tts => format!("{base}/audio/voices"),
        Kind::Stt if p.engine.as_deref() == Some("whispercpp") => format!("{}/", origin(base)),
        _ => format!("{base}/models"),
    }
}

async fn probe(state: &DispatchState, osc: &os_core::OsConfig, p: Provider, timeout: Duration) -> ServiceHealth {
    let started = Instant::now();
    let kind = serde_json::to_value(p.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let off = if os_core::is_droplet(&p, osc) && !osc.droplet.enabled {
        Some("OFFLINE (MANUAL)")
    } else if osc.privacy.kill_switch && os_core::is_remote(&p) {
        Some("OFFLINE (KILL SWITCH)")
    } else if osc.compute.mode == os_core::ComputeMode::Local && os_core::is_remote(&p) && p.kind.is_chat() {
        Some("OFFLINE (LOCAL ONLY)")
    } else {
        None
    };
    if let Some(why) = off {
        return ServiceHealth { id: p.id.clone(), label: p.label.clone(), kind, up: false, latency_ms: 0, detail: why.into(), manual: true };
    }
    let eleven = p.engine.as_deref() == Some("elevenlabs");
    let url = if eleven { format!("{}/models", p.base_url.trim_end_matches('/')) } else { probe_url(&p) };
    let mut rb = state.http.get(url).timeout(timeout);
    if eleven {
        if let (Some(k), _) = super::elevenlabs::api_key(state, &p) {
            rb = rb.header("xi-api-key", k);
        }
    } else if let Ok(Some(k)) = state.key_for(&p) {
        rb = rb.bearer_auth(k);
    }
    let (up, detail) = match rb.send().await {
        Ok(r) if r.status().is_success() => (true, format!("{}", r.status().as_u16())),
        // whisper.cpp answers 404 on / in some builds but is clearly listening.
        Ok(r) if p.kind == Kind::Stt && r.status().as_u16() < 500 => (true, format!("{}", r.status().as_u16())),
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => (false, "auth failed — check API key".into()),
        Ok(r) => (false, format!("HTTP {}", r.status().as_u16())),
        Err(e) => (false, short(e)),
    };
    ServiceHealth {
        id: p.id.clone(),
        label: p.label.clone(),
        kind,
        up,
        latency_ms: started.elapsed().as_millis(),
        detail,
        manual: false,
    }
}

/// Every configured service (integrations excluded) with the gateway (server.py) first.
fn targets(cfg: &super::dispatch::Config) -> Vec<Provider> {
    let mut targets: Vec<Provider> = cfg.providers.iter().filter(|p| p.kind != Kind::Integration).cloned().collect();
    // The gateway (server.py) as its own node — it is the sync hub for the phone.
    let mut gw = targets.iter().find(|p| p.kind == Kind::AgenticOs).cloned().unwrap_or_else(|| Provider {
        id: String::new(),
        label: String::new(),
        kind: Kind::AgenticOs,
        base_url: String::new(),
        model: String::new(),
        needs_key: false,
        voice: None,
        engine: None,
        language: None,
        models_dir: None,
        voices_dir: None,
        stt_prompt: None,
        custom: false,
    });
    gw.id = "gateway".into();
    gw.label = "Gateway (server.py)".into();
    gw.base_url = cfg.gateway.url.clone();
    targets.insert(0, gw);
    targets
}

/// Probe every configured service plus the gateway, concurrently.
#[tauri::command]
pub async fn services_health(state: State<'_, DispatchState>, os: State<'_, os_core::OsState>) -> Result<Vec<ServiceHealth>, String> {
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let futs = targets(&cfg).into_iter().map(|p| probe(&state, &osc, p, Duration::from_secs(4)));
    let mut out = Vec::new();
    for f in futs {
        out.push(f);
    }
    let res = futures_join(out).await;
    *LAST_HEALTH.lock().unwrap() = Some((os_core::now_secs(), res.clone()));
    Ok(res)
}

/// The most recent `services_health` result, so snapshots (dev task queue, System Map)
/// can describe the services without probing again. Memory only.
static LAST_HEALTH: std::sync::Mutex<Option<(u64, Vec<ServiceHealth>)>> = std::sync::Mutex::new(None);

/// `(unix secs of the probe, entries as JSON)` from the last `services_health` call, if any.
pub(crate) fn cached_health() -> Option<(u64, Vec<serde_json::Value>)> {
    let g = LAST_HEALTH.lock().unwrap();
    let (at, list) = g.as_ref()?;
    Some((*at, list.iter().filter_map(|h| serde_json::to_value(h).ok()).collect()))
}

/// LM Studio's out-of-the-box port. Probed as its own node when no provider already
/// points at it, so a second LM Studio server (or a stale default) shows up honestly.
const LMSTUDIO_DEFAULT_PORT: u16 = 1234;

fn port_of(url: &str) -> Option<u16> {
    url::Url::parse(url).ok()?.port_or_known_default()
}

/// The local (loopback) services only, each probed once (`timeout` each, all
/// concurrently), with its port: the System Map's `services` block. Remote nodes
/// (droplet, cloud TTS) are left out — they have their own monitors.
pub(crate) async fn probe_local(state: &DispatchState, osc: &os_core::OsConfig, timeout: Duration) -> Vec<serde_json::Value> {
    let cfg = state.snapshot();
    let mut seen = std::collections::HashSet::new();
    let mut list: Vec<Provider> = targets(&cfg).into_iter().filter(|p| !os_core::is_remote(p) && seen.insert(probe_url(p))).collect();
    let lm = list.iter().find(|p| p.id == "lmstudio" || p.id == cfg.policy.primary_local).cloned();
    if let Some(mut extra) = lm {
        if !list.iter().any(|p| port_of(&p.base_url) == Some(LMSTUDIO_DEFAULT_PORT)) {
            if let Ok(mut u) = url::Url::parse(&extra.base_url) {
                if u.set_port(Some(LMSTUDIO_DEFAULT_PORT)).is_ok() {
                    extra.id = format!("{}-{LMSTUDIO_DEFAULT_PORT}", extra.id);
                    extra.label = format!("{} (default port :{LMSTUDIO_DEFAULT_PORT})", extra.label);
                    extra.base_url = u.to_string();
                    extra.needs_key = false;
                    list.push(extra);
                }
            }
        }
    }
    let ports: Vec<Option<u16>> = list.iter().map(|p| port_of(&p.base_url)).collect();
    let res = futures_join(list.into_iter().map(|p| probe(state, osc, p, timeout)).collect()).await;
    res.into_iter()
        .zip(ports)
        .filter_map(|(h, port)| {
            let mut v = serde_json::to_value(h).ok()?;
            v["port"] = serde_json::json!(port);
            Some(v)
        })
        .collect()
}

/// Minimal join_all without pulling in the `futures` crate.
async fn futures_join<F: std::future::Future<Output = ServiceHealth>>(futs: Vec<F>) -> Vec<ServiceHealth> {
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut results: Vec<Option<ServiceHealth>> = vec![None; pinned.len()];
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (i, f) in pinned.iter_mut().enumerate() {
            if results[i].is_none() {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => results[i] = Some(v),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(())
        }
    })
    .await;
    results.into_iter().flatten().collect()
}

pub const WHISPER_VARIANTS: [&str; 10] = ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v3", "large-v3-turbo"];

/// Models a provider can switch to (feeds the Settings dropdowns).
#[tauri::command]
pub async fn provider_models(state: State<'_, DispatchState>, id: String) -> Result<Vec<String>, String> {
    let p = state.provider(&id).ok_or("unknown provider")?;
    match p.kind {
        // Only the CLIs actually installed (the gateway resolves .cmd/.exe shims).
        Kind::AgenticOs => Ok(["opencode", "claude", "gemini", "llm", "agy"].iter().filter(|n| super::clihub::resolve(n).is_some()).map(|n| n.to_string()).collect()),
        Kind::Stt if p.engine.as_deref() == Some("whispercpp") => {
            // Variants with a model file present (if modelsDir is set), else the standard list.
            if let Some(dir) = p.models_dir.as_deref() {
                let have: Vec<String> = WHISPER_VARIANTS
                    .iter()
                    .filter(|v| std::path::Path::new(dir).join(format!("ggml-{v}.bin")).exists())
                    .map(|v| v.to_string())
                    .collect();
                if !have.is_empty() {
                    return Ok(have);
                }
            }
            Ok(WHISPER_VARIANTS.iter().map(|v| v.to_string()).collect())
        }
        // Live list (Part 3), falling back to the static MODELS on any failure (no key, offline…).
        Kind::Tts if p.engine.as_deref() == Some("elevenlabs") => match super::elevenlabs::list_models(&state, &p).await {
            Ok(ids) if !ids.is_empty() => Ok(ids),
            _ => Ok(super::elevenlabs::MODELS.iter().map(|m| m.to_string()).collect()),
        },
        Kind::Tts | Kind::N8n | Kind::Integration => Ok(vec![]),
        _ => {
            let mut rb = state.http.get(format!("{}/models", p.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(5));
            if let Some(k) = state.key_for(&p)? {
                rb = rb.bearer_auth(k);
            }
            let body: serde_json::Value = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.json().await.map_err(short)?;
            let mut ids: Vec<String> = body["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect();
            if p.kind == Kind::Stt && ids.is_empty() {
                ids = WHISPER_VARIANTS.iter().map(|v| v.to_string()).collect();
            }
            Ok(ids)
        }
    }
}

// ── Gateway (server.py) ──────────────────────────────────────────────────────

async fn gateway_up(state: &DispatchState, url: &str) -> bool {
    state
        .http
        .get(format!("{}/api/status", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    up: bool,
    started: bool,
    url: String,
    detail: String,
}

impl GatewayStatus {
    pub fn is_up(&self) -> bool {
        self.up
    }
}

/// Make sure the gateway is running: probe it, and if it's down (and
/// `gateway.autostart` is on), launch it from providers.json → `gateway`.
/// The command line comes ONLY from that file, never from the webview.
#[tauri::command]
pub async fn gateway_ensure(state: State<'_, DispatchState>) -> Result<GatewayStatus, String> {
    let gw = state.snapshot().gateway;
    if gateway_up(&state, &gw.url).await {
        return Ok(GatewayStatus { up: true, started: false, url: gw.url, detail: "running".into() });
    }
    // The phone build can't run server.py; it only talks to the PC's gateway over NetBird.
    if cfg!(mobile) {
        return Ok(GatewayStatus { up: false, started: false, url: gw.url, detail: "down (phone build: the gateway runs on the PC)".into() });
    }
    if !gw.autostart {
        return Ok(GatewayStatus { up: false, started: false, url: gw.url, detail: "down (autostart off)".into() });
    }
    let workdir = std::path::PathBuf::from(&gw.workdir);
    if !workdir.join("server.py").exists() {
        return Ok(GatewayStatus {
            up: false,
            started: false,
            url: gw.url,
            detail: format!("server.py not found in {} — set gateway.workdir in providers.json", workdir.display()),
        });
    }
    let mut cmd = std::process::Command::new(&gw.command);
    cmd.args(&gw.args).current_dir(&workdir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().map_err(|e| format!("could not start gateway ({}): {e}", gw.command))?;
    for _ in 0..30 {
        tokio_sleep(Duration::from_millis(500)).await;
        if gateway_up(&state, &gw.url).await {
            return Ok(GatewayStatus { up: true, started: true, url: gw.url, detail: "started".into() });
        }
    }
    Ok(GatewayStatus { up: false, started: true, url: gw.url, detail: "launched but not answering yet — check Python deps".into() })
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

// ── Local model fit guard ────────────────────────────────────────────────────
//
// Bionic / LM Studio auto-load ("JIT") uses the model's saved defaults — for
// qwen3.5-9b that was a 123k context × 4 slots, which overflows the 12 GB card
// into system RAM and makes every answer crawl. Every 5 minutes: if the primary
// local model is loaded with more than FIT_CTX context, reload it at FIT_CTX.

const FIT_CTX: u64 = 32_768;

/// Reload the primary model at FIT_CTX when it is loaded wider. The unload / reload is GPU
/// maintenance: it waits for every in-flight generation and blocks new ones until it is done.
pub async fn local_fit_once(state: &DispatchState, os: &super::os_core::OsState) -> Option<String> {
    let cfg = state.snapshot();
    let p = cfg.providers.iter().find(|p| p.id == cfg.policy.primary_local || p.id == "lmstudio")?.clone();
    let api = format!("{}/api/v1/models", origin(&p.base_url));
    let v: serde_json::Value = state.http.get(&api).timeout(Duration::from_secs(5)).send().await.ok()?.json().await.ok()?;
    let m = v["models"].as_array()?.iter().find(|m| m["key"].as_str() == Some(p.model.as_str()))?.clone();
    let inst = m["loaded_instances"].as_array()?.first()?.clone();
    let ctx = inst["config"]["context_length"].as_u64()?;
    if ctx <= FIT_CTX {
        return None;
    }
    let id = inst["id"].as_str()?.to_string();
    let base = origin(&p.base_url);
    let _slot = os.slot.acquire_maintenance("local fit", os.snapshot().scheduler.tony_priority_pct).await;
    state.http.post(format!("{base}/api/v1/models/unload")).json(&serde_json::json!({ "instance_id": id })).timeout(Duration::from_secs(60)).send().await.ok()?;
    let r = state
        .http
        .post(format!("{base}/api/v1/models/load"))
        .json(&serde_json::json!({ "model": p.model, "context_length": FIT_CTX, "flash_attention": true, "parallel": 2, "offload_kv_cache_to_gpu": true }))
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .ok()?;
    Some(format!("reloaded {} from {ctx} to {FIT_CTX} context (HTTP {})", p.model, r.status().as_u16()))
}

/// STT keep-alive, every 60 s, in its OWN loop: it used to share `local_fit_loop`, where the
/// LM Studio fit check can wait minutes (a model reload, the maintenance GPU slot), and while it
/// waited a Whisper that had died stayed down — Tony was deaf until the app restarted.
/// `stt_ensure` keeps faster-whisper :8177 AND its whisper.cpp fallback :8178 up (or whisper.cpp
/// alone when that is the STT), each under a start limit; `fw_model_sync` keeps :8177 on the
/// saved model.
pub async fn whisper_keepalive_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    use super::introspect::loop_ran;
    loop {
        let cfg = app.state::<DispatchState>().snapshot();
        let notes = tauri::async_runtime::spawn_blocking(move || stt_ensure(&cfg)).await.unwrap_or_default();
        if notes.is_empty() {
            loop_ran("whisper", true, "nothing to do (already up, or STT isn't a local whisper server)");
        } else {
            let msg = notes.join("; ");
            eprintln!("[whisper] {msg}");
            loop_ran("whisper", !notes.iter().any(|n| n.starts_with("could not")), &msg);
        }
        // faster-whisper up on another model than the saved one (boot step 0b's $STT_MODEL after a reboot).
        spawn_fw_model_sync(&app);
        tokio_sleep(Duration::from_secs(60)).await;
    }
}

pub async fn local_fit_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    use super::introspect::loop_ran;
    // Bloat guard: the LM Studio fit check (which can unload and reload the model) runs at start
    // and every 30 min. (Whisper's keep-alive is `whisper_keepalive_loop`, so this can't block it.)
    let mut round = 0u32;
    loop {
        round = round.wrapping_add(1);
        let fit = if round % 6 == 1 { local_fit_once(&app.state::<DispatchState>(), &app.state::<super::os_core::OsState>()).await } else { None };
        match fit {
            Some(msg) => {
                eprintln!("[fit] {msg}");
                loop_ran("local-fit", true, &msg);
            }
            None => loop_ran("local-fit", true, "nothing to do (fits, or the model isn't loaded / LM Studio is down)"),
        }
        tokio_sleep(Duration::from_secs(300)).await;
    }
}

// ── STT keep-alive (faster-whisper :8177, whisper.cpp :8178) ─────────────────
//
// Both STT servers are plain processes (not services), so a crash or a reboot left them down
// ("cannot connect to whisper"). At launch, every 60 s, and right before a transcription whose
// server is down (voice.rs `transcribe_with`): for policy.stt's server, and when that is
// faster-whisper also for its whisper.cpp fallback (the first local whisper.cpp provider), if
// the provider is on 127.0.0.1 / localhost and its port is closed, start it detached with a
// hidden window, exactly as G:\ai-startup\start-ai-stack.ps1 does at logon (boot step 0b:
// faster-whisper; then whisper.cpp from G:\whisper\bin with ggml-<model>.bin from modelsDir).
// Each port has a start limit (`StartLimit`), so a server that dies at once is never respawned in
// a loop. Paths come only from providers.json / these constants. Tests use `stt_ensure_with`
// with fakes; in a test build the real spawner refuses, so no test can start a live server.

const WHISPER_EXE: &str = r"G:\whisper\bin\whisper-server.exe";
/// faster-whisper, as ai-stack.config.ps1 sets it for boot step 0b ($STT_PYTHON, $STT_SCRIPT,
/// $STT_COMPUTE, $STT_MIN_FREE_MB). The script is `<gateway.workdir>\stt\fw_server.py` when that
/// exists (G: is the only home), else FW_SCRIPT. The model is the provider's.
pub(crate) const FW_PYTHON: &str = r"C:\ai-stt\.venv\Scripts\python.exe";
pub(crate) const FW_SCRIPT: &str = r"G:\agentic os\stt\fw_server.py";
const FW_COMPUTE: &str = "int8_float16";
/// fw_server.py enforces at least its own need (turbo int8_float16: 1.2 GB resident + 150 MB decode
/// peak + 500 MB floor = 1850 MB); this is what step 0b passes, kept equal (stt-startup.tests.ps1).
const FW_MIN_FREE_MB: u32 = 1850;
const FW_DEFAULT_MODEL: &str = "large-v3-turbo";
/// Start limit per port: after a start, wait 30 s (doubling to 10 min while it stays down) before
/// the next, and never more than MAX_STARTS starts in START_WINDOW, however it dies.
const START_BACKOFF_FIRST: Duration = Duration::from_secs(30);
const START_BACKOFF_MAX: Duration = Duration::from_secs(600);
const START_WINDOW: Duration = Duration::from_secs(600);
const MAX_STARTS: usize = 3;

/// One server start: the command line and what must exist for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub exe: std::path::PathBuf,
    pub args: Vec<String>,
    pub cwd: std::path::PathBuf,
    /// stderr goes here (whisper.cpp's G:\whisper\server.log); None: discarded (fw_server writes
    /// its own capped log, G:\whisper\fw-server.log).
    pub stderr_log: Option<std::path::PathBuf>,
    /// Files the start needs (the exe, the script or model): checked by the real spawner.
    pub needs: Vec<std::path::PathBuf>,
    /// "faster-whisper on :8177 (large-v3-turbo)" for the logs.
    pub what: String,
}

/// The engines the app starts itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SttEngine {
    FasterWhisper,
    WhisperCpp,
}

impl SttEngine {
    pub(crate) fn of(p: &Provider) -> Option<Self> {
        match (p.kind, p.engine.as_deref()) {
            (Kind::Stt, Some("fasterwhisper")) => Some(Self::FasterWhisper),
            (Kind::Stt, Some("whispercpp")) => Some(Self::WhisperCpp),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::FasterWhisper => "faster-whisper",
            Self::WhisperCpp => "whisper.cpp",
        }
    }
}

/// A provider's port when it is on this PC (127.0.0.1 / localhost): the only servers started here.
pub(crate) fn local_port(p: &Provider) -> Option<u16> {
    let u = url::Url::parse(&p.base_url).ok()?;
    matches!(u.host_str()?, "127.0.0.1" | "localhost").then(|| u.port_or_known_default()).flatten()
}

/// The whisper.cpp server behind a faster-whisper STT (fw_server forwards to it, and a failed
/// transcription is retried on it): the first local, keyless whisper.cpp provider. None for any
/// other engine.
pub(crate) fn stt_fallback(cfg: &super::dispatch::Config, p: &Provider) -> Option<Provider> {
    if SttEngine::of(p) != Some(SttEngine::FasterWhisper) {
        return None;
    }
    cfg.providers.iter().find(|w| w.id != p.id && SttEngine::of(w) == Some(SttEngine::WhisperCpp) && !w.needs_key && local_port(w).is_some()).cloned()
}

/// What the keep-alive looks after: policy.stt's server (a local whisper engine), plus its
/// whisper.cpp fallback when it is faster-whisper (pure).
pub(crate) fn stt_targets(cfg: &super::dispatch::Config) -> Vec<(Provider, SttEngine)> {
    let Some(p) = cfg.providers.iter().find(|p| p.id == cfg.policy.stt) else { return vec![] };
    let Some(engine) = SttEngine::of(p) else { return vec![] };
    let mut out = vec![(p.clone(), engine)];
    if let Some(w) = stt_fallback(cfg, p) {
        out.push((w, SttEngine::WhisperCpp));
    }
    out
}

/// The faster-whisper model a provider names, as fw_server takes it (`fw_launch`'s --model and
/// `fw_model_sync`'s /load): the last path part (fw_server keeps only a path's folder name) when
/// that is a plain model name, else FW_DEFAULT_MODEL. It starts with a letter or digit: argparse
/// reads `--model -h` as an option and fw_server exits before it binds the port.
pub(crate) fn fw_model(p: &Provider) -> String {
    let leaf = p.model.trim().rsplit(['/', '\\']).next().unwrap_or_default();
    let ok = (1..=80).contains(&leaf.len()) && leaf.starts_with(|c: char| c.is_ascii_alphanumeric()) && leaf.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok { leaf.to_string() } else { FW_DEFAULT_MODEL.to_string() }
}

/// fw_server.py's command line, as boot step 0b builds it:
/// `"python.exe" "fw_server.py" --port P --model M --compute-type int8_float16 --min-free-mb 1850`
/// (working directory: the script's folder). The server runs its own VRAM pre-flight before any
/// GPU load and forwards finals to whisper.cpp while it has no GPU model.
pub(crate) fn fw_launch(p: &Provider, port: u16, workdir: &str) -> Launch {
    let in_workdir = std::path::Path::new(workdir).join("stt").join("fw_server.py");
    let script = if !workdir.trim().is_empty() && in_workdir.exists() { in_workdir } else { std::path::PathBuf::from(FW_SCRIPT) };
    let model = fw_model(p);
    let cwd = script.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
    let s = |v: &str| v.to_string();
    Launch {
        exe: std::path::PathBuf::from(FW_PYTHON),
        args: vec![script.display().to_string(), s("--port"), port.to_string(), s("--model"), model.clone(), s("--compute-type"), s(FW_COMPUTE), s("--min-free-mb"), FW_MIN_FREE_MB.to_string()],
        cwd,
        stderr_log: None,
        needs: vec![std::path::PathBuf::from(FW_PYTHON), script],
        what: format!("faster-whisper on :{port} ({model})"),
    }
}

/// whisper.cpp's command line (boot step 0b's fallback start, and the app's own since day one):
/// ggml-<model>.bin from the provider's modelsDir (any ggml-*.bin there when that one is missing).
pub(crate) fn whispercpp_launch(p: &Provider, port: u16) -> Result<Launch, String> {
    let dir = std::path::PathBuf::from(p.models_dir.clone().unwrap_or_else(|| r"G:\whisper\models".into()));
    let mut model = dir.join(format!("ggml-{}.bin", p.model));
    if !model.exists() {
        model = std::fs::read_dir(&dir)
            .ok()
            .and_then(|rd| rd.flatten().map(|e| e.path()).find(|f| f.extension().is_some_and(|x| x == "bin") && f.file_name().is_some_and(|n| n.to_string_lossy().starts_with("ggml-"))))
            .ok_or_else(|| format!("no ggml-*.bin model in {}", dir.display()))?;
    }
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(2, 8)).unwrap_or(4).to_string();
    let file = model.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let s = |v: &str| v.to_string();
    Ok(Launch {
        exe: std::path::PathBuf::from(WHISPER_EXE),
        args: vec![s("-m"), model.display().to_string(), s("--host"), s("127.0.0.1"), s("--port"), port.to_string(), s("--inference-path"), s("/v1/audio/transcriptions"), s("-t"), threads],
        cwd: std::path::PathBuf::from(r"G:\whisper"),
        stderr_log: Some(std::path::PathBuf::from(r"G:\whisper\server.log")),
        needs: vec![std::path::PathBuf::from(WHISPER_EXE), model],
        what: format!("whisper.cpp on :{port} ({file})"),
    })
}

/// One port's start history: the backoff and the window cap (see START_BACKOFF_* / MAX_STARTS).
#[derive(Debug, Default)]
pub(crate) struct StartLimit {
    next: Option<std::time::Instant>,
    backoff: Duration,
    starts: std::collections::VecDeque<std::time::Instant>,
}

impl StartLimit {
    /// None: a start is allowed at `now`; Some(why) otherwise.
    fn blocked(&mut self, now: std::time::Instant) -> Option<String> {
        self.starts.retain(|t| now.saturating_duration_since(*t) < START_WINDOW);
        if self.starts.len() >= MAX_STARTS {
            let free_in = self.starts.front().map_or(START_WINDOW, |t| START_WINDOW.saturating_sub(now.saturating_duration_since(*t)));
            return Some(format!("not restarted: {MAX_STARTS} starts in {} min already (next allowed in {} s)", START_WINDOW.as_secs() / 60, free_in.as_secs()));
        }
        match self.next {
            Some(n) if now < n => Some(format!("not restarted yet: last start was recent (next allowed in {} s)", (n - now).as_secs())),
            _ => None,
        }
    }

    /// A start was made (or tried: a failed start counts too, so it can never loop).
    fn started(&mut self, now: std::time::Instant) {
        self.backoff = if self.backoff.is_zero() { START_BACKOFF_FIRST } else { (self.backoff * 2).min(START_BACKOFF_MAX) };
        self.next = Some(now + self.backoff);
        self.starts.push_back(now);
    }

    /// The server is listening: a later death gets a prompt restart again (the window cap stays).
    fn up(&mut self) {
        self.backoff = Duration::ZERO;
        self.next = None;
    }
}

pub(crate) type StartLimits = std::sync::Mutex<std::collections::HashMap<u16, StartLimit>>;

/// What `stt_ensure_with` needs from outside (fakes in tests).
pub(crate) struct EnsureEnv<'a> {
    pub port_open: &'a (dyn Fn(u16) -> bool + Send + Sync),
    pub spawn: &'a (dyn Fn(&Launch) -> Result<(), String> + Send + Sync),
    pub limits: &'a StartLimits,
    pub now: std::time::Instant,
}

/// Start whichever `stt_targets` server is down, within its start limit. Returns one note per
/// server it did something about ("started …", "could not start …", "… not restarted: …");
/// empty when everything was up (or nothing is a local whisper server).
pub(crate) fn stt_ensure_with(cfg: &super::dispatch::Config, env: &EnsureEnv<'_>) -> Vec<String> {
    let mut out = vec![];
    for (p, engine) in stt_targets(cfg) {
        let Some(port) = local_port(&p) else { continue };
        let open = (env.port_open)(port);
        let mut limits = env.limits.lock().unwrap_or_else(|e| e.into_inner());
        let lim = limits.entry(port).or_default();
        if open {
            lim.up();
            continue;
        }
        if let Some(why) = lim.blocked(env.now) {
            out.push(format!("{} on :{port} is down, {why}", engine.label()));
            continue;
        }
        let launch = match engine {
            SttEngine::FasterWhisper => Ok(fw_launch(&p, port, &cfg.gateway.workdir)),
            SttEngine::WhisperCpp => whispercpp_launch(&p, port),
        };
        lim.started(env.now);
        match launch.and_then(|l| (env.spawn)(&l).map(|()| l)) {
            Ok(l) => out.push(format!("started {}", l.what)),
            Err(e) => out.push(format!("could not start {} on :{port}: {e}", engine.label())),
        }
    }
    out
}

fn start_limits() -> &'static StartLimits {
    static L: std::sync::OnceLock<StartLimits> = std::sync::OnceLock::new();
    L.get_or_init(Default::default)
}

/// A server listens on 127.0.0.1:`port` (an open port answers in < 1 ms; a closed one is given
/// 400 ms instead of Windows' ~2 s of SYN retries).
pub(crate) fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(400)).is_ok()
}

/// Start a server detached (it outlives the app), with no window. Like the gateway's fw_server
/// respawn, it first asks to break away from the app's job (if any), then goes without.
#[cfg(not(test))]
fn spawn_detached(l: &Launch) -> Result<(), String> {
    if let Some(missing) = l.needs.iter().find(|f| !f.exists()) {
        return Err(format!("not installed ({} missing)", missing.display()));
    }
    let attempt = |flags: u32| {
        let mut cmd = std::process::Command::new(&l.exe);
        cmd.args(&l.args).current_dir(&l.cwd).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null());
        match l.stderr_log.as_ref().and_then(|p| std::fs::File::create(p).ok()) {
            Some(f) => cmd.stderr(f),
            None => cmd.stderr(std::process::Stdio::null()),
        };
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(flags);
        }
        #[cfg(not(windows))]
        let _ = flags;
        cmd.spawn().map(|_| ())
    };
    // CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP (+ CREATE_BREAKAWAY_FROM_JOB).
    const FLAGS: u32 = 0x0800_0000 | 0x0000_0008 | 0x0000_0200;
    attempt(FLAGS | 0x0100_0000).or_else(|_| attempt(FLAGS)).map_err(|e| e.to_string())
}

/// A test build never starts a real STT server, whatever a test does.
#[cfg(test)]
fn spawn_detached(_l: &Launch) -> Result<(), String> {
    Err("test build: STT servers are never started".into())
}

/// Keep the local STT servers up (see the section comment): the live port check, spawner and
/// start limits. Blocking (port checks, a spawn): call it off the async runtime when you can.
pub fn stt_ensure(cfg: &super::dispatch::Config) -> Vec<String> {
    stt_ensure_with(cfg, &EnsureEnv { port_open: &port_open, spawn: &spawn_detached, limits: start_limits(), now: std::time::Instant::now() })
}

// ── faster-whisper: the saved model, also after a reboot ─────────────────────
//
// Boot step 0b starts :8177 with ai-stack.config.ps1's $STT_MODEL, and `stt_ensure` leaves a
// listening server alone, so a model picked in Settings (providers.json) was silently lost on every
// reboot while the Settings card still showed it. Each keep-alive pass, while faster-whisper is up,
// ready and idle, `fw_model_sync` compares its /health `model` with the saved one and asks it to
// load the saved one (POST /load, the Settings hot-swap's success check). Never during GPU
// maintenance (a Model Lab compare / bench measures VRAM; a local-fit reload juggles it), and the
// same model is asked for at most once per FW_SYNC_RETRY: a refusal (no VRAM next to Tony) costs
// fw_server a reload of the model it had, so it is never retried in a loop.

/// After asking for a model once, wait this long before asking for the same one again.
const FW_SYNC_RETRY: Duration = Duration::from_secs(30 * 60);
/// GET /health answers at once; POST /load waits for the load + warm-up (voice.rs FW_LOAD_SECS).
const FW_HEALTH_SECS: u64 = 3;
const FW_SYNC_LOAD_SECS: u64 = 120;

/// The last model `fw_model_sync` asked each port to load, and when.
pub(crate) type SyncTries = std::sync::Mutex<std::collections::HashMap<u16, (String, std::time::Instant)>>;

/// One pass (see the section comment). None: nothing to do (not faster-whisper, down, loading, the
/// saved model already runs, GPU maintenance, or this model was asked for recently). Some(note)
/// after a /load: "faster-whisper on :P ran X; loaded Y …" or "could not switch …".
pub(crate) async fn fw_model_sync(state: &DispatchState, gpu_maintenance: bool, tries: &SyncTries, now: std::time::Instant) -> Option<String> {
    let cfg = state.snapshot();
    let p = cfg.providers.iter().find(|p| p.id == cfg.policy.stt)?;
    if SttEngine::of(p) != Some(SttEngine::FasterWhisper) {
        return None;
    }
    let port = local_port(p)?;
    let want = fw_model(p);
    let base = origin(&p.base_url);
    let health: serde_json::Value = state.http.get(format!("{base}/health")).timeout(Duration::from_secs(FW_HEALTH_SECS)).send().await.ok()?.json().await.ok()?;
    // Loading, or no GPU model yet (its own retry is pending): not now.
    if health["ready"] != true || health["loading"] == true {
        return None;
    }
    let running = health["model"].as_str()?.trim().to_string();
    {
        let mut t = tries.lock().unwrap_or_else(|e| e.into_inner());
        if super::voice::fw_same_model(&running, &want) {
            t.remove(&port);
            return None;
        }
        if gpu_maintenance || t.get(&port).is_some_and(|(m, at)| m == &want && now.saturating_duration_since(*at) < FW_SYNC_RETRY) {
            return None;
        }
        t.insert(port, (want.clone(), now));
    }
    let outcome = match state.http.post(format!("{base}/load")).json(&serde_json::json!({ "model": want })).timeout(Duration::from_secs(FW_SYNC_LOAD_SECS)).send().await {
        Ok(r) => {
            let code = r.status().as_u16();
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            super::voice::fw_load_outcome(code, &body, &want)
        }
        Err(e) => Err(e.to_string()),
    };
    Some(match outcome {
        Ok(()) => format!("faster-whisper on :{port} ran {running}; loaded {want}, the saved STT model"),
        Err(e) => format!("could not switch faster-whisper on :{port} from {running} to {want} (asks again in {} min): {e}", FW_SYNC_RETRY.as_secs() / 60),
    })
}

fn sync_tries() -> &'static SyncTries {
    static T: std::sync::OnceLock<SyncTries> = std::sync::OnceLock::new();
    T.get_or_init(Default::default)
}

/// GPU maintenance holds the slot (a Model Lab compare, from its start until Tony is back; a
/// bench; a local-fit reload): `acquire_maintenance` labels them "maintenance · …".
fn gpu_maintenance_now(os: &super::os_core::OsState) -> bool {
    super::modellab::compare::running() || os.slot.view().active.iter().any(|h| h.trim().to_ascii_lowercase().starts_with("maintenance"))
}

/// One `fw_model_sync` at a time, off the keep-alive loop (a /load can take two minutes, and the
/// loop must keep checking that the servers are up meanwhile).
fn spawn_fw_model_sync(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;
    static BUSY: AtomicBool = AtomicBool::new(false);
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::SeqCst);
        }
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _done = Done;
        let maintenance = gpu_maintenance_now(&app.state::<super::os_core::OsState>());
        if let Some(note) = fw_model_sync(&app.state::<DispatchState>(), maintenance, sync_tries(), std::time::Instant::now()).await {
            eprintln!("[whisper] {note}");
        }
    });
}

/// Keep the ElevenLabs HTTPS connection warm (a free GET /models every 60 s) so
/// Tony's first spoken sentence doesn't pay a ~1 s TLS handshake.
pub async fn tts_warm_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    loop {
        {
            let st = app.state::<DispatchState>();
            let os = app.state::<super::os_core::OsState>();
            let cfg = st.snapshot();
            if !os.snapshot().privacy.kill_switch {
                if let Some(p) = cfg.providers.iter().find(|p| p.id == cfg.policy.tts && p.engine.as_deref() == Some("elevenlabs")).cloned() {
                    if let (Some(key), _) = super::elevenlabs::api_key(&st, &p) {
                        let _ = st.http.get(format!("{}/models", p.base_url.trim_end_matches('/'))).header("xi-api-key", key).timeout(Duration::from_secs(5)).send().await;
                    }
                }
            }
        }
        tokio_sleep(Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::allm::mock::{start, Req, Resp};
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn local_fit_takes_the_slot_before_unloading() {
        tauri::async_runtime::block_on(async {
            let srv = start(|r: &Req| {
                if r.method == "GET" {
                    return Resp::json(json!({ "models": [{ "key": "qwen/qwen3.5-9b", "type": "llm", "loaded_instances": [{ "id": "inst-1", "config": { "context_length": 65536 } }] }] }));
                }
                Resp::json(json!({}))
            })
            .await;
            let st = DispatchState::default();
            let base = format!("{}/v1", srv.base);
            st.update(|c| {
                for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
                    p.base_url = base.clone();
                    p.model = "qwen/qwen3.5-9b".into();
                }
                c.policy.primary_local = "lmstudio".into();
                Ok(())
            })
            .unwrap();
            let (st, os) = (Arc::new(st), Arc::new(os_core::OsState::default()));
            let holder = os.slot.acquire("tony", true, 90).await;
            let (s2, o2) = (st.clone(), os.clone());
            let h = tauri::async_runtime::spawn(async move { local_fit_once(&s2, &o2).await });
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert_eq!(srv.count("POST", "/models/unload"), 0, "no unload while a generation holds the GPU");
            drop(holder);
            let msg = h.await.unwrap().unwrap();
            assert!(msg.contains("65536"), "{msg}");
            assert_eq!(srv.count("POST", "/models/unload"), 1);
            assert_eq!(srv.count("POST", "/models/load"), 1);
            assert!(os.slot.view().active.is_empty(), "maintenance released the slot");
        });
    }

    // ── STT keep-alive (fakes only: nothing is spawned, no live port is touched) ──

    use std::collections::HashSet;
    use std::sync::Mutex;
    use std::time::Instant;

    /// The live STT setup: policy.stt = faster-whisper on :8177, whisper.cpp ("whisper") on :8178
    /// with its models in `models` (a temp dir holding ggml-base.en.bin).
    fn stt_cfg(models: &std::path::Path) -> crate::commands::dispatch::Config {
        let st = DispatchState::default();
        st.update(|c| {
            let w = c.providers.iter_mut().find(|p| p.id == "whisper").expect("built-in whisper");
            w.base_url = "http://127.0.0.1:8178/v1".into();
            w.model = "base.en".into();
            w.engine = Some("whispercpp".into());
            w.models_dir = Some(models.display().to_string());
            let mut fw = w.clone();
            fw.id = "faster-whisper".into();
            fw.label = "faster-whisper (GPU)".into();
            fw.base_url = "http://127.0.0.1:8177/v1".into();
            fw.model = "large-v3-turbo".into();
            fw.engine = Some("fasterwhisper".into());
            fw.models_dir = None;
            fw.custom = true;
            c.providers.push(fw);
            c.policy.stt = "faster-whisper".into();
            Ok(())
        })
        .unwrap()
    }

    fn models_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("stt-ensure-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        std::fs::write(d.join("ggml-base.en.bin"), b"fake").unwrap();
        d
    }

    /// Ports in `closed` are down; every spawn is recorded and "works" (nothing really starts).
    struct Fakes {
        closed: Mutex<HashSet<u16>>,
        spawned: Mutex<Vec<Launch>>,
        fail_spawn: bool,
        limits: StartLimits,
    }

    impl Fakes {
        fn new(closed: &[u16]) -> Self {
            Fakes { closed: Mutex::new(closed.iter().copied().collect()), spawned: Mutex::default(), fail_spawn: false, limits: StartLimits::default() }
        }
        fn ensure(&self, cfg: &crate::commands::dispatch::Config, now: Instant) -> Vec<String> {
            let port_open = |p: u16| !self.closed.lock().unwrap().contains(&p);
            let spawn = |l: &Launch| {
                self.spawned.lock().unwrap().push(l.clone());
                if self.fail_spawn {
                    Err("boom".to_string())
                } else {
                    Ok(())
                }
            };
            stt_ensure_with(cfg, &EnsureEnv { port_open: &port_open, spawn: &spawn, limits: &self.limits, now })
        }
        fn count(&self) -> usize {
            self.spawned.lock().unwrap().len()
        }
    }

    #[test]
    fn a_dead_faster_whisper_is_started_like_boot_step_0b_and_its_whisper_cpp_fallback_too() {
        let dir = models_dir("boot");
        let cfg = stt_cfg(&dir);
        let f = Fakes::new(&[8177, 8178]);
        let notes = f.ensure(&cfg, Instant::now());
        let spawned = f.spawned.lock().unwrap().clone();
        assert_eq!(spawned.len(), 2, "{notes:?}");
        // :8177 — `"python.exe" "fw_server.py" --port 8177 --model large-v3-turbo --compute-type int8_float16 --min-free-mb 1850`.
        let fw = &spawned[0];
        assert_eq!(fw.exe, std::path::PathBuf::from(r"C:\ai-stt\.venv\Scripts\python.exe"));
        assert!(fw.args[0].ends_with(r"stt\fw_server.py"), "{:?}", fw.args);
        assert_eq!(fw.args[1..], ["--port", "8177", "--model", "large-v3-turbo", "--compute-type", "int8_float16", "--min-free-mb", "1850"]);
        assert_eq!(fw.cwd, std::path::Path::new(&fw.args[0]).parent().unwrap(), "run from the script's folder (Split-Path $STT_SCRIPT)");
        assert_eq!(fw.stderr_log, None, "fw_server writes its own capped log");
        // :8178 — whisper.cpp with the provider's ggml model, as before.
        let wc = &spawned[1];
        assert_eq!(wc.exe, std::path::PathBuf::from(WHISPER_EXE));
        assert_eq!(wc.args[..8], ["-m", dir.join("ggml-base.en.bin").display().to_string().as_str(), "--host", "127.0.0.1", "--port", "8178", "--inference-path", "/v1/audio/transcriptions"]);
        assert_eq!(notes, vec!["started faster-whisper on :8177 (large-v3-turbo)".to_string(), "started whisper.cpp on :8178 (ggml-base.en.bin)".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn up_servers_are_left_alone() {
        let dir = models_dir("up");
        let cfg = stt_cfg(&dir);
        let f = Fakes::new(&[]);
        assert!(f.ensure(&cfg, Instant::now()).is_empty());
        assert_eq!(f.count(), 0);
        // Only :8178 down: only whisper.cpp is started.
        let f = Fakes::new(&[8178]);
        f.ensure(&cfg, Instant::now());
        assert_eq!(f.spawned.lock().unwrap().iter().map(|l| l.exe.clone()).collect::<Vec<_>>(), vec![std::path::PathBuf::from(WHISPER_EXE)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_start_limit_never_lets_a_dying_server_loop() {
        let dir = models_dir("limit");
        let mut cfg = stt_cfg(&dir);
        cfg.policy.stt = "whisper".into(); // just whisper.cpp: one port to count
        let f = Fakes::new(&[8178]);
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        f.ensure(&cfg, at(0));
        assert_eq!(f.count(), 1);
        let notes = f.ensure(&cfg, at(5));
        assert_eq!(f.count(), 1, "still starting: no second start 5 s later");
        assert!(notes[0].contains("not restarted yet"), "{notes:?}");
        f.ensure(&cfg, at(31));
        assert_eq!(f.count(), 2, "30 s backoff");
        f.ensure(&cfg, at(31 + 59));
        assert_eq!(f.count(), 2, "then 60 s");
        f.ensure(&cfg, at(31 + 61));
        assert_eq!(f.count(), 3);
        // A server that starts, answers, and dies again: the backoff resets but the cap holds.
        f.closed.lock().unwrap().clear();
        assert!(f.ensure(&cfg, at(100)).is_empty());
        f.closed.lock().unwrap().insert(8178);
        let notes = f.ensure(&cfg, at(101));
        assert_eq!(f.count(), 3, "3 starts in 10 min: no 4th");
        assert!(notes[0].contains("3 starts in 10 min"), "{notes:?}");
        f.ensure(&cfg, at(601));
        assert_eq!(f.count(), 4, "the first start aged out of the window");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_start_counts_against_the_limit() {
        let dir = models_dir("fail");
        let mut cfg = stt_cfg(&dir);
        cfg.policy.stt = "faster-whisper".into();
        let mut f = Fakes::new(&[8177]);
        f.fail_spawn = true;
        let t0 = Instant::now();
        let notes = f.ensure(&cfg, t0);
        assert!(notes[0].starts_with("could not start faster-whisper on :8177: boom"), "{notes:?}");
        f.ensure(&cfg, t0 + Duration::from_secs(1));
        assert_eq!(f.count(), 1, "no retry loop on a start that fails at once");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_local_whisper_servers_are_started() {
        let dir = models_dir("remote");
        let mut cfg = stt_cfg(&dir);
        for p in cfg.providers.iter_mut().filter(|p| p.kind == Kind::Stt) {
            p.base_url = p.base_url.replace("127.0.0.1", "10.0.0.5");
        }
        let f = Fakes::new(&[8177, 8178]);
        assert!(f.ensure(&cfg, Instant::now()).is_empty());
        // An engine the app doesn't run (openai-compatible) is never started either.
        let mut cfg = stt_cfg(&dir);
        cfg.providers.iter_mut().find(|p| p.id == "faster-whisper").unwrap().engine = Some("openai".into());
        assert!(stt_targets(&cfg).is_empty());
        assert!(f.ensure(&cfg, Instant::now()).is_empty());
        assert_eq!(f.count(), 0);
        // whisper.cpp as the STT: just :8178.
        cfg.policy.stt = "whisper".into();
        assert_eq!(stt_targets(&cfg).iter().map(|(p, e)| (p.id.as_str(), *e)).collect::<Vec<_>>(), vec![("whisper", SttEngine::WhisperCpp)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── faster-whisper on the saved model (a fake fw_server: /health + /load, as stt/fw_server.py answers) ──

    /// policy.stt = faster-whisper at `base` with `saved` as its model (nothing is written).
    fn fw_state(base: &str, saved: &str) -> DispatchState {
        let st = DispatchState::default();
        st.update(|c| {
            let mut fw = c.providers.iter().find(|p| p.id == "whisper").expect("built-in whisper").clone();
            fw.id = "faster-whisper".into();
            fw.label = "faster-whisper (GPU)".into();
            fw.base_url = format!("{base}/v1");
            fw.model = saved.into();
            fw.engine = Some("fasterwhisper".into());
            fw.models_dir = None;
            fw.custom = true;
            c.providers.push(fw);
            c.policy.stt = "faster-whisper".into();
            Ok(())
        })
        .unwrap();
        st
    }

    /// A fake fw_server running `model` (`ready`, `loading` as given). /load: "ok" switches it;
    /// "kept" is fw_server's usual refusal (200, ready, the previous model and an error).
    struct FakeFw {
        srv: crate::commands::allm::mock::Server,
        model: Arc<Mutex<String>>,
    }

    async fn fake_fw(model: &str, ready: bool, loading: bool, load: &'static str) -> FakeFw {
        let m = Arc::new(Mutex::new(model.to_string()));
        let m2 = m.clone();
        let srv = start(move |r: &Req| match r.path.as_str() {
            "/health" => Resp::json(json!({ "ready": ready, "loading": loading, "model": m2.lock().unwrap().clone(), "device": "cuda", "error": null })),
            "/load" if load == "ok" => {
                *m2.lock().unwrap() = r.body["model"].as_str().unwrap_or_default().to_string();
                Resp::json(json!({ "ready": true, "loading": false, "model": r.body["model"], "error": null }))
            }
            "/load" => {
                let prev = m2.lock().unwrap().clone();
                Resp::json(json!({ "ready": true, "loading": false, "model": prev, "error": format!("load {}/int8_float16 failed, kept {prev}: RuntimeError: only 900 MB VRAM free", r.body["model"].as_str().unwrap_or_default()) }))
            }
            _ => Resp::status(404, json!({})),
        })
        .await;
        FakeFw { srv, model: m }
    }

    #[test]
    fn after_a_reboot_faster_whisper_is_switched_to_the_saved_model_once() {
        tauri::async_runtime::block_on(async {
            // Boot step 0b started it on $STT_MODEL (turbo); Settings saved distil-large-v3.
            let fw = fake_fw("large-v3-turbo", true, false, "ok").await;
            let st = fw_state(&fw.srv.base, "distil-large-v3");
            let tries = SyncTries::default();
            let t0 = Instant::now();
            let note = fw_model_sync(&st, false, &tries, t0).await;
            assert_eq!(note.as_deref(), Some(format!("faster-whisper on :{} ran large-v3-turbo; loaded distil-large-v3, the saved STT model", local_port(&st.provider("faster-whisper").unwrap()).unwrap()).as_str()));
            let loads: Vec<serde_json::Value> = fw.srv.reqs().into_iter().filter(|r| r.method == "POST" && r.path == "/load").map(|r| r.body).collect();
            assert_eq!(loads, vec![json!({ "model": "distil-large-v3" })], "exactly one /load, the saved model by name");
            assert_eq!(*fw.model.lock().unwrap(), "distil-large-v3");
            // It runs the saved model now: the next passes leave it alone.
            for s in [60, 120] {
                assert_eq!(fw_model_sync(&st, false, &tries, t0 + Duration::from_secs(s)).await, None);
            }
            assert_eq!(fw.srv.count("POST", "/load"), 1);
        });
    }

    #[test]
    fn a_refused_switch_is_not_retried_in_a_loop() {
        tauri::async_runtime::block_on(async {
            let fw = fake_fw("large-v3-turbo", true, false, "kept").await;
            let st = fw_state(&fw.srv.base, "distil-large-v3");
            let tries = SyncTries::default();
            let t0 = Instant::now();
            let note = fw_model_sync(&st, false, &tries, t0).await.expect("a note");
            assert!(note.starts_with("could not switch faster-whisper") && note.contains("kept large-v3-turbo") && note.contains("900 MB VRAM free"), "{note}");
            // Every keep-alive pass for the next half hour: no second /load (each one would cost
            // fw_server a reload of turbo).
            for s in [60, 600, 29 * 60] {
                assert_eq!(fw_model_sync(&st, false, &tries, t0 + Duration::from_secs(s)).await, None, "{s} s");
            }
            assert_eq!(fw.srv.count("POST", "/load"), 1);
            fw_model_sync(&st, false, &tries, t0 + Duration::from_secs(31 * 60)).await.expect("asked again");
            assert_eq!(fw.srv.count("POST", "/load"), 2, "once more after FW_SYNC_RETRY");
            // A different saved model is a new ask straight away.
            let st = fw_state(&fw.srv.base, "small");
            fw_model_sync(&st, false, &tries, t0 + Duration::from_secs(31 * 60 + 1)).await.expect("a new model");
            assert_eq!(fw.srv.count("POST", "/load"), 3);
        });
    }

    #[test]
    fn no_switch_while_loading_in_gpu_maintenance_or_when_the_names_match() {
        tauri::async_runtime::block_on(async {
            let t0 = Instant::now();
            // Loading, or up with no GPU model (its own retry is pending): not now.
            for (ready, loading) in [(false, true), (false, false), (true, true)] {
                let fw = fake_fw("large-v3-turbo", ready, loading, "ok").await;
                assert_eq!(fw_model_sync(&fw_state(&fw.srv.base, "distil-large-v3"), false, &SyncTries::default(), t0).await, None);
                assert_eq!(fw.srv.count("POST", "/load"), 0, "ready={ready} loading={loading}");
            }
            // A Model Lab compare / bench / local-fit reload holds the GPU: wait for it to end.
            let fw = fake_fw("large-v3-turbo", true, false, "ok").await;
            let st = fw_state(&fw.srv.base, "distil-large-v3");
            let tries = SyncTries::default();
            assert_eq!(fw_model_sync(&st, true, &tries, t0).await, None);
            assert_eq!(fw.srv.count("POST", "/load"), 0);
            assert!(fw_model_sync(&st, false, &tries, t0 + Duration::from_secs(60)).await.is_some(), "and switches once it is over");
            // The same model by another of fw_server's names (its CT2 folder, a path): nothing to do.
            for saved in ["faster-whisper-large-v3-turbo", r"C:\models\stt\faster-whisper-large-v3-turbo", "Large-V3-Turbo"] {
                let fw = fake_fw("large-v3-turbo", true, false, "ok").await;
                assert_eq!(fw_model_sync(&fw_state(&fw.srv.base, saved), false, &SyncTries::default(), t0).await, None, "{saved}");
                assert_eq!(fw.srv.count("POST", "/load"), 0, "{saved}");
            }
            // whisper.cpp as the STT, or faster-whisper down: not even a /health call.
            let fw = fake_fw("large-v3-turbo", true, false, "ok").await;
            let st = fw_state(&fw.srv.base, "distil-large-v3");
            st.update(|c| {
                c.policy.stt = "whisper".into();
                Ok(())
            })
            .unwrap();
            assert_eq!(fw_model_sync(&st, false, &SyncTries::default(), t0).await, None);
            assert_eq!(fw.srv.reqs().len(), 0);
            let down = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            assert_eq!(fw_model_sync(&fw_state(&format!("http://127.0.0.1:{down}"), "distil-large-v3"), false, &SyncTries::default(), t0).await, None);
        });
    }

    #[test]
    fn the_launch_model_and_the_sync_model_agree() {
        let dir = models_dir("model");
        let mut p = stt_cfg(&dir).providers.into_iter().find(|p| p.id == "faster-whisper").unwrap();
        for (saved, want) in [("distil-large-v3", "distil-large-v3"), (r"C:\models\stt\faster-distil-whisper-large-v3", "faster-distil-whisper-large-v3"), ("", FW_DEFAULT_MODEL), ("bad name; rm", FW_DEFAULT_MODEL), ("-h", FW_DEFAULT_MODEL), ("--port", FW_DEFAULT_MODEL), ("..", FW_DEFAULT_MODEL)] {
            p.model = saved.into();
            assert_eq!(fw_model(&p), want, "{saved}");
            assert_eq!(fw_launch(&p, 8177, "").args[4], want, "--model {saved}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_test_build_never_spawns_a_real_server() {
        let dir = models_dir("real");
        let l = fw_launch(&stt_cfg(&dir).providers.iter().find(|p| p.id == "faster-whisper").unwrap().clone(), 8177, "");
        assert!(spawn_detached(&l).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
