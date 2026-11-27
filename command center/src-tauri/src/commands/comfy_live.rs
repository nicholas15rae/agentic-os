//! Opt-in live smoke test of the ComfyUI batch path (comfy.rs `run_batch`) OUTSIDE the Tauri app:
//! one SDXL Turbo still through the real production code, from cargo.
//!
//!   unload Qwen (LM Studio :1235) → start ComfyUI headless → render one `scene-still` → save it to
//!   the `comfy-smoke` media project (media::ingest_generated + the GenMeta sidecar) → /free → stop
//!   ComfyUI → reload Qwen → verify only Tony is loaded.
//!
//! `#[ignore]`d and gated on `COMFY_LIVE=1`, so `cargo test` never runs it. Two steps:
//!   preflight (safe: reads only, unloads nothing, starts nothing, no lease PUT):
//!     $env:COMFY_LIVE="1"; $env:COMFY_LIVE_STEP="preflight"; cargo test --lib live_sdxl_turbo_smoke -- --ignored --nocapture
//!   full run (unset COMFY_LIVE_STEP):
//!     $env:COMFY_LIVE="1"; Remove-Item Env:COMFY_LIVE_STEP -ErrorAction SilentlyContinue; cargo test --lib live_sdxl_turbo_smoke -- --ignored --nocapture
//!
//! What stands in for the app (`TestIo` vs comfy.rs `LiveIo`):
//!   * configs: the app's providers.json is COPIED into the scratch dir and loaded from the copy
//!     (`DispatchState::load_or_init` writes the file it loads, so the live one is never opened
//!     for writing); os.json is parsed in memory (`parse_os_config_lenient` pointed at the scratch
//!     copy, so even a parse-failure backup lands in scratch). Nothing is ever saved back.
//!   * GPU slot: a standalone `GpuSlot` (run_batch takes it with `acquire_maintenance`). The app's
//!     in-process arbiter is NOT involved (see the crash-marker note below).
//!   * lease: the real gateway maintenance lease (`model_swap::lease_heartbeat`, live gateway URL +
//!     mesh bearer). While it is up the gateway holds Tony's `llm_chat` (phone Tony answers with
//!     his "testing a model" line). The app's slot mirror normally releases it when the slot is
//!     dropped; here the test releases it itself, and only when the gateway still shows our holder.
//!   * preempt: no arbiter here. Creating the file `<scratch>\comfy-live-preempt` stops the batch
//!     (interrupt → requeue → restore), the way a Tony preempt does in the app.
//!   * crash marker: the test's OWN file (`<scratch>\comfy-crash.json`), so it runs with
//!     Command Center open: the app's runner never sees it (2026-11-27, Nic away overnight;
//!     closing the app was the alternative). A leftover app marker is still a blocker. The
//!     ComfyUI child is in a kill-on-close Job Object, so it dies with the test process; the
//!     crash/timeout cleanup below puts Tony back.
//!   * Command Center may be running. If its own work calls LM Studio mid-render, LM Studio
//!     JIT-loads a model and run_batch's JIT check fails the job and restores Tony.
//!   * media: a MediaState like media_e2e.rs (scratch media.db, the real projects root). With
//!     `COMFY_LIVE_MEDIA_DB=app` it opens the app's own media.db instead (only when its schema
//!     version equals this build's, so nothing is migrated), and the asset then shows in the
//!     app's Staging Bin.
//!   * queue: an isolated `Store` on a scratch file, never `<config>\comfy-queue.json`.
//!   * aspect: the project manifest's aspect (default 16:9, media `default_manifest`), as in the app.
//!   * lease check: `TestIo::preflight` (run before the marker and the unload) re-reads the gateway
//!     and aborts unless it shows OUR maintenance lease, so Tony is never unloaded without a window.
//!   * cleanup (batch crashed or timed out): its own lease heartbeat while it runs; VRAM settles
//!     before Tony reloads; `restore_tony` only when the marker says LLMs were touched (and Tony
//!     isn't already back), `verify_only_tony` otherwise. The hard timeout never aborts the batch
//!     during its own "putting Tony back" phase, and an aborted batch is awaited before cleanup.
//!   * whisper residency: GPU processes are identified by command line (`fw_server.py` /
//!     "whisper"), not just the exe name (faster-whisper shows as a plain python.exe).
//!
//! Scratch dir: `COMFY_LIVE_SCRATCH`, default `F:\claude-scratch\comfy-live`.

use super::*;
use crate::commands::dispatch::DispatchState;
use crate::commands::media::{self, MediaState};
use crate::commands::os_core::{self, OsConfig};

const LM_BASE: &str = "http://127.0.0.1:1235";
const TONY_MODEL: &str = "qwen/qwen3.5-9b";
const SLUG: &str = "comfy-smoke";
const TEMPLATE: &str = "scene-still";
const PROMPT: &str = "a quiet hockey arena bench at golden hour, cinematic still, 35mm";
const SEED: u64 = 424_242;
const CKPT: &str = "checkpoints/sd_xl_turbo_1.0_fp16.safetensors";
/// Above run_batch's own bound (unload 60 s/instance + 2 x 20 s settle + 120 s start + 600 s job
/// timeout + 300 s load + 60 s warm-up + a 300 s corrective reload + ingest).
const HARD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Extra wait when the hard timeout lands inside run_batch's "putting Tony back" phase (that phase
/// is bounded by its own timeouts; aborting it mid-load could double Tony).
const RESTORE_GRACE: Duration = Duration::from_secs(15 * 60);
const RESTORE_PHASE: &str = "putting Tony back";
/// TestIo::preflight: gateway lease reads before giving up.
const LEASE_TRIES: u32 = 3;
const LEASE_RETRY: Duration = Duration::from_millis(500);
const PREEMPT_FILE: &str = "comfy-live-preempt";
const DEFAULT_SCRATCH: &str = r"F:\claude-scratch\comfy-live";
const APP_ID: &str = "os.agentic.commandcenter";
/// compute-apps sampling while the batch runs.
const APPS_EVERY: Duration = Duration::from_secs(3);

fn scratch() -> PathBuf {
    std::env::var_os("COMFY_LIVE_SCRATCH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(DEFAULT_SCRATCH))
}

fn app_config_dir() -> Result<PathBuf, String> {
    Ok(PathBuf::from(std::env::var_os("APPDATA").ok_or("%APPDATA% is not set")?).join(APP_ID))
}

/// The crash marker the app's runner reads (comfy.rs `init`: `config_dir.join("comfy-crash.json")`).
fn app_marker_path(cfg_dir: &Path) -> PathBuf {
    cfg_dir.join("comfy-crash.json")
}

/// This test's own crash marker (never the app's, so a running app ignores it).
fn test_marker_path(scratch: &Path) -> PathBuf {
    scratch.join("comfy-crash.json")
}

// ── Pure helpers (unit-tested below) ────────────────────────────────────────

/// Some(reason) while `<dir>\comfy-live-preempt` exists (a human asked the run to stop).
pub(super) fn preempt_file_reason(dir: &Path) -> Option<String> {
    let f = dir.join(PREEMPT_FILE);
    f.exists().then(|| format!("preempt file {} exists", f.display()))
}

/// A Command Center build (installed: productName.exe; dev: the cargo bin name).
pub(super) fn is_app_exe(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    ["command-center.exe", "command-center", "jarvis command center.exe", "jarvis command center"].contains(&n.as_str())
}

/// `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`
/// → [{pid, name, usedMb}]. WDDM reports `[N/A]` memory per process: usedMb is then null.
/// (`compute_apps_now` adds each pid's command line as `cmd`.)
pub(super) fn parse_compute_apps(text: &str) -> Vec<Value> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("No running"))
        .filter_map(|l| {
            let (pid, rest) = l.split_once(',')?;
            let (name, used) = rest.rsplit_once(',').unwrap_or((rest, ""));
            let pid: u32 = pid.trim().parse().ok()?;
            Some(json!({ "pid": pid, "name": name.trim(), "usedMb": used.trim().parse::<u64>().ok() }))
        })
        .collect()
}

/// An STT process: faster-whisper's `fw_server.py` (a plain python.exe by name) or anything with
/// "whisper" in its command line or exe path.
pub(super) fn is_stt_app(a: &Value) -> bool {
    let has = |k: &str| {
        a[k].as_str().is_some_and(|n| {
            let n = n.to_ascii_lowercase();
            n.contains("fw_server.py") || n.contains("whisper")
        })
    };
    has("cmd") || has("name")
}

/// Is a whisper STT process holding the GPU? resident: true (one matched), false (none matched and
/// every GPU process's command line was read), null (none matched but some command line couldn't
/// be read, so an STT process may have gone unrecognised).
pub(super) fn whisper_of(apps: &[Value]) -> Value {
    let w: Vec<&Value> = apps.iter().filter(|a| is_stt_app(a)).collect();
    let all_known = apps.iter().all(|a| a["cmd"].as_str().is_some_and(|c| !c.trim().is_empty()));
    let resident = if !w.is_empty() {
        json!(true)
    } else if all_known {
        json!(false)
    } else {
        Value::Null
    };
    json!({ "resident": resident, "processes": w, "usedMb": w.iter().filter_map(|a| a["usedMb"].as_u64()).reduce(|a, b| a + b) })
}

/// Does the gateway's `GET /api/os/gpu` show our live holder?
pub(super) fn lease_is_ours(lease: &Value, holder: &str) -> bool {
    lease["busy"] == true && lease["holder"].as_str() == Some(holder)
}

/// The run must target the real lmstudio provider with Tony's model.
pub(super) fn check_lm_target(base: &str, tony: &str) -> Result<(), String> {
    if base != LM_BASE || tony != TONY_MODEL {
        return Err(format!("providers.json lmstudio is {base} / {tony}, expected {LM_BASE} / {TONY_MODEL}; refusing to swap models on the wrong server"));
    }
    Ok(())
}

fn secs(ms: Option<u64>) -> Value {
    ms.map(|m| json!((m as f64 / 100.0).round() / 10.0)).unwrap_or(Value::Null)
}

/// The full-run report: the batch, the job's timing / VRAM / provenance, the assets, plus `extra`.
pub(super) fn build_report(rep: Option<&BatchReport>, job: Option<&Job>, assets: &[Value], extra: Value) -> Value {
    let out = job.and_then(|j| j.outputs.first());
    let image = out.map(|o| {
        let g = &o.gen;
        json!({
            "prompt": g.prompt, "negative": g.negative, "seed": g.seed,
            "settings": { "template": g.template, "checkpoint": g.checkpoint, "steps": g.steps, "cfg": g.cfg, "sampler": g.sampler, "scheduler": g.scheduler, "width": g.width, "height": g.height, "denoise": g.denoise },
            "file": o.path, "assetId": o.asset_id, "whisperResident": g.whisper_resident,
        })
    });
    let mut v = json!({
        "ok": rep.is_some_and(|r| r.done.len() == 1 && r.restore.as_ref().is_some_and(|x| x.ok)),
        "batch": rep,
        "job": job.map(|j| json!({ "id": j.id, "status": j.status, "error": j.error, "promptId": j.prompt_id })),
        "renderSeconds": secs(job.and_then(|j| j.render_ms)),
        "peakVramDuringRenderMb": job.and_then(|j| j.peak_vram_mb),
        "vramAfterUnloadMb": rep.and_then(|r| r.vram_after_unload_mb),
        "vramAfterStopMb": rep.and_then(|r| r.vram_after_stop_mb),
        "qwenReloadSeconds": secs(rep.and_then(|r| r.restore.as_ref()).and_then(|r| r.load_ms)),
        "restore": rep.and_then(|r| r.restore.as_ref()),
        "comfyuiVersion": rep.and_then(|r| r.comfyui_version.clone()),
        "assets": assets,
        "image": image,
    });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in e {
            o.insert(k.clone(), x.clone());
        }
    }
    v
}

// ── Live helpers ────────────────────────────────────────────────────────────

fn compute_apps_now() -> Result<Vec<Value>, String> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let o = cmd.output().map_err(|e| format!("nvidia-smi: {e}"))?;
    if !o.status.success() {
        return Err(format!("nvidia-smi exited {}", o.status));
    }
    let mut apps = parse_compute_apps(&String::from_utf8_lossy(&o.stdout));
    add_cmdlines(&mut apps);
    Ok(apps)
}

/// `cmd` (the joined command line, or null when it can't be read) for each app's pid.
fn add_cmdlines(apps: &mut [Value]) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    let pids: Vec<Pid> = apps.iter().filter_map(|a| a["pid"].as_u64()).map(|p| Pid::from_u32(p as u32)).collect();
    if pids.is_empty() {
        return;
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
    for a in apps.iter_mut() {
        let cmd = a["pid"]
            .as_u64()
            .and_then(|p| sys.process(Pid::from_u32(p as u32)))
            .map(|p| p.cmd().iter().map(|x| x.to_string_lossy()).collect::<Vec<_>>().join(" "))
            .filter(|c| !c.trim().is_empty());
        a["cmd"] = cmd.map_or(Value::Null, Value::from);
    }
}

fn apps_snapshot() -> Value {
    match compute_apps_now() {
        Ok(a) => json!({ "apps": a, "whisper": whisper_of(&a) }),
        Err(e) => json!({ "error": e }),
    }
}

fn command_center_pids() -> Vec<u32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes().iter().filter(|(_, p)| is_app_exe(&p.name().to_string_lossy())).map(|(pid, _)| pid.as_u32()).collect()
}

/// The app's configs, read-only (see the module doc).
struct LiveCfg {
    cfg_dir: PathBuf,
    dispatch: DispatchState,
    os: OsConfig,
    lease_url: String,
    bearer: Option<String>,
}

fn load_live(scratch: &Path) -> Result<LiveCfg, String> {
    let cfg_dir = app_config_dir()?;
    let copy = scratch.join("config-copy");
    std::fs::create_dir_all(&copy).map_err(|e| format!("create {}: {e}", copy.display()))?;
    let src = cfg_dir.join("providers.json");
    std::fs::copy(&src, copy.join("providers.json")).map_err(|e| format!("copy {}: {e}", src.display()))?;
    let dispatch = DispatchState::default();
    dispatch.load_or_init(&copy);
    let os_text = std::fs::read_to_string(cfg_dir.join("os.json")).map_err(|e| format!("read os.json: {e}"))?;
    let os = os_core::parse_os_config_lenient(os_text.strip_prefix('\u{feff}').unwrap_or(&os_text), &copy.join("os.json"));
    let lease_url = model_swap::lease_url(&dispatch);
    let bearer = os_core::mesh_bearer(&os);
    Ok(LiveCfg { cfg_dir, dispatch, os, lease_url, bearer })
}

async fn lease_get(http: &reqwest::Client, url: &str, bearer: Option<&str>) -> Result<Value, String> {
    let mut rb = http.get(url).timeout(Duration::from_secs(3));
    if let Some(t) = bearer {
        rb = rb.bearer_auth(t);
    }
    let r = rb.send().await.map_err(super::super::dispatch::short)?;
    r.error_for_status().map_err(super::super::dispatch::short)?.json().await.map_err(super::super::dispatch::short)
}

/// What the app's slot mirror sends on release, but only while the gateway still shows our holder
/// (never clearing someone else's lease).
async fn lease_release_if_ours(http: &reqwest::Client, url: &str, bearer: Option<&str>, holder: &str) -> Value {
    match lease_get(http, url, bearer).await {
        Ok(l) if lease_is_ours(&l, holder) => {
            let mut rb = http.put(url).timeout(Duration::from_secs(3)).json(&json!({ "busy": false, "holder": "", "until": null }));
            if let Some(t) = bearer {
                rb = rb.bearer_auth(t);
            }
            json!({ "released": rb.send().await.map(|r| r.status().is_success()).unwrap_or(false) })
        }
        Ok(l) => json!({ "released": false, "note": "gateway lease isn't ours any more; left alone", "lease": l }),
        Err(e) => json!({ "released": false, "error": e }),
    }
}

/// media.db: scratch (default, like media_e2e.rs) or the app's own (COMFY_LIVE_MEDIA_DB=app, only
/// when no migration would run). The projects root is the real one either way.
fn app_db_version(cfg_dir: &Path) -> Result<u32, String> {
    let c = rusqlite::Connection::open_with_flags(cfg_dir.join("media.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())
}

fn media_state(scratch: &Path, cfg_dir: &Path) -> Result<(MediaState, Value), String> {
    let root = PathBuf::from(os_core::MEDIA_ROOT).join("projects");
    let use_app = std::env::var("COMFY_LIVE_MEDIA_DB").as_deref() == Ok("app");
    let path = if use_app {
        let v = app_db_version(cfg_dir)?;
        if v as usize != media::MIGRATIONS.len() {
            return Err(format!("the app's media.db is schema v{v}, this build is v{}; refusing to migrate it (unset COMFY_LIVE_MEDIA_DB)", media::MIGRATIONS.len()));
        }
        cfg_dir.join("media.db")
    } else {
        scratch.join("media.db")
    };
    let mut c = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_millis(3000)).map_err(|e| e.to_string())?;
    media::migrate(&mut c)?;
    Ok((MediaState::with_conn(c, &root), json!({ "db": path, "mode": if use_app { "app" } else { "scratch" }, "projectsRoot": root })))
}

/// The `comfy-smoke` project: loaded, adopted from its folder's project.json (a scratch db that
/// doesn't know it yet), or created with media's own `create_project`.
fn ensure_project(st: &MediaState) -> Result<(String, &'static str), String> {
    if media::load_project(st, SLUG).is_ok() {
        return Ok((SLUG.into(), "existing"));
    }
    let root = media::project_root(st, SLUG)?;
    if let Ok(text) = std::fs::read_to_string(root.join("project.json")) {
        let p = media::parse_project(&text)?;
        if p.slug == SLUG {
            st.with(|c| c.execute("INSERT INTO project (slug, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(slug) DO NOTHING", rusqlite::params![p.slug, text, p.updated_at]).map(|_| ()).map_err(media::sql_err))?;
            media::ensure_project_dirs(&root)?;
            return Ok((SLUG.into(), "adopted from project.json"));
        }
    }
    let p = media::create_project(st, SLUG, None)?;
    Ok((p.slug, "created"))
}

// ── TestIo: BatchIo without an AppHandle ────────────────────────────────────

struct TestIo {
    lm: model_swap::Lm,
    comfy: ComfyHttp,
    paths: ComfyPaths,
    roots: Vec<String>,
    proc_: Mutex<Option<ComfyProc>>,
    marker: PathBuf,
    scratch: PathBuf,
    http: reqwest::Client,
    lease_url: String,
    bearer: Option<String>,
    holder: Mutex<Option<String>>,
    media: Arc<MediaState>,
    t0: Instant,
    events: Mutex<Vec<Value>>,
    assets: Mutex<Vec<Value>>,
}

impl TestIo {
    fn event(&self, kind: &str, v: Value) {
        lk(&self.events).push(json!({ "tMs": self.t0.elapsed().as_millis() as u64, "kind": kind, "data": v }));
    }
}

impl BatchIo for TestIo {
    async fn snapshot_loaded(&self) -> Result<Vec<Inst>, String> {
        self.lm.snapshot_loaded().await
    }
    async fn unload_all(&self) -> Result<Vec<Inst>, String> {
        self.lm.unload_all().await
    }
    async fn restore_tony(&self) -> Restore {
        self.lm.restore_tony().await
    }
    async fn verify_only_tony(&self) -> Restore {
        self.lm.verify_only_tony().await
    }
    fn vram(&self) -> VramFn {
        model_swap::live_vram()
    }
    /// ComfyUI's preflight, then: does the gateway actually show OUR maintenance lease? run_batch
    /// calls this before the marker and the unload, so a lease that didn't take (gateway restarted,
    /// a 403, a late PUT) aborts with Tony untouched.
    async fn preflight(&self) -> Result<(), String> {
        comfy_preflight_live(&self.paths, &self.comfy).await?;
        let holder = lk(&self.holder).clone().ok_or("no lease holder (the heartbeat never started)")?;
        let mut last = String::new();
        for n in 0..LEASE_TRIES {
            if n > 0 {
                tokio::time::sleep(LEASE_RETRY).await;
            }
            match lease_get(&self.http, &self.lease_url, self.bearer.as_deref()).await {
                Ok(l) if lease_is_ours(&l, &holder) && l["maintenance"] == true => {
                    self.event("lease-confirmed", json!({ "try": n + 1, "lease": l }));
                    return Ok(());
                }
                Ok(l) => last = format!("gateway shows {l}"),
                Err(e) => last = e,
            }
        }
        Err(format!("the gateway maintenance lease for {holder:?} didn't take ({last}); nothing was unloaded"))
    }
    async fn comfy_start(&self) -> Result<(Option<u32>, String), String> {
        // comfy_start_live writes extra_model_paths.yaml (prepare_dirs) exactly as the app does.
        let (p, version) = comfy_start_live(&self.paths, &self.comfy, &self.roots, Duration::from_secs(120)).await?;
        let pid = p.child.id();
        *lk(&self.proc_) = Some(p);
        Ok((Some(pid), version))
    }
    async fn comfy_stop(&self) {
        comfy_stop_live(&self.comfy, &self.proc_).await
    }
    async fn free(&self) {
        if lk(&self.proc_).is_some() {
            self.comfy.free().await
        }
    }
    async fn interrupt(&self) {
        self.comfy.interrupt().await
    }
    async fn submit(&self, prompt: &Value, client_id: &str) -> Result<String, String> {
        let r = self.comfy.submit(prompt, client_id).await;
        self.event("submit", json!({ "ok": r.is_ok(), "promptId": r.as_ref().ok() }));
        r
    }
    async fn history(&self, prompt_id: &str) -> Result<Value, String> {
        self.comfy.history(prompt_id).await
    }
    async fn download(&self, f: &OutFile, dest: &Path) -> Result<u64, String> {
        let bytes = self.comfy.view(f).await?;
        super::super::staging::atomic_write(dest, &bytes)?;
        Ok(bytes.len() as u64)
    }
    fn write_marker(&self, m: &CrashMarker) -> Result<(), String> {
        write_marker_file(&self.marker, m)
    }
    fn read_marker(&self) -> Option<CrashMarker> {
        read_marker(&self.marker)
    }
    fn clear_marker(&self) {
        let _ = std::fs::remove_file(&self.marker);
    }
    fn leftover_is_ours(&self, m: &CrashMarker, pid: u32) -> bool {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
        let mut sys = sysinfo::System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing().with_exe(UpdateKind::Always));
        sys.process(p).is_some_and(|pr| is_our_comfy(pr.exe(), pr.start_time(), m))
    }
    fn kill_pid(&self, pid: u32) {
        crate::proc::kill_tree(pid)
    }
    /// No arbiter outside the app: the preempt file. The gateway lease (heartbeat) holds Tony's
    /// `llm_chat` meanwhile; an in-app LLM call shows up as a JIT load, which run_batch handles.
    fn preempt(&self, _since: u64) -> Option<String> {
        preempt_file_reason(&self.scratch)
    }
    fn heartbeat(&self, label: &str) -> Task<u32> {
        let holder = model_swap::maintenance_holder(label);
        *lk(&self.holder) = Some(holder.clone());
        model_swap::lease_heartbeat(self.http.clone(), self.lease_url.clone(), self.bearer.clone(), holder, model_swap::HEARTBEAT_EVERY)
    }
    fn gen_dir(&self, slug: &str, job_id: &str) -> Result<PathBuf, String> {
        let id = safe_name(job_id).ok_or("bad job id")?;
        Ok(media::project_root(&self.media, slug)?.join("working").join("gen").join(id))
    }
    async fn ingest(&self, slug: &str, file: &Path, meta: &GenMeta) -> Option<String> {
        let (st, s, f, mut m) = (self.media.clone(), slug.to_string(), file.to_path_buf(), meta.clone());
        let res = tauri::async_runtime::spawn_blocking(move || {
            // Right after the render: is whisper still on the GPU? (LiveIo leaves this unknown.)
            if m.whisper_resident.is_none() {
                // None (unknown) when no STT process could be identified, never a guessed false.
                m.whisper_resident = compute_apps_now().ok().and_then(|a| whisper_of(&a)["resident"].as_bool());
            }
            media::ingest_generated(&st, &s, &f, &m)
        })
        .await
        .unwrap_or_else(|e| Err(format!("ingest task: {e}")));
        match res {
            Ok(a) => {
                let v = json!({ "assetId": a.id, "rawPath": a.path, "sidecarPath": a.generation.as_ref().and_then(|g| g.sidecar_path.clone()), "downloaded": file });
                self.event("asset", v.clone());
                lk(&self.assets).push(v);
                Some(a.id)
            }
            Err(e) => {
                self.event("ingest-error", json!({ "file": file, "error": e }));
                None
            }
        }
    }
    fn emit_queue(&self, job: &Job) {
        self.event("comfy-queue", json!({ "id": job.id, "status": job.status, "error": job.error }));
    }
    fn emit_service(&self, v: Value) {
        self.event("comfy-service", v);
    }
    fn models_root(&self) -> Vec<String> {
        self.roots.clone()
    }
    fn input_dir(&self) -> PathBuf {
        self.paths.input()
    }
}

// ── Gates (the whole preflight step; the full run aborts on any blocker) ────

fn job_params_for(project_aspect: Option<&str>) -> Value {
    with_default_aspect(with_seed(json!({ "prompt": PROMPT, "seed": SEED }), 0), TEMPLATE, project_aspect)
}

async fn gates(live: &LiveCfg, lm: &Result<model_swap::Lm, String>, scratch: &Path) -> (Value, Vec<String>) {
    let mut blockers = vec![];
    let http = live.dispatch.http.clone();
    let paths = ComfyPaths::live();
    let roots = ComfySettings::default().model_roots;
    // LM Studio
    let lm_v = match lm {
        Ok(l) => {
            if let Err(e) = check_lm_target(&l.base, &l.tony) {
                blockers.push(e);
            }
            match l.list().await {
                Ok(list) => {
                    let loaded = model_swap::loaded_llms(&list);
                    let only = model_swap::only_tony(&loaded, &l.tony);
                    json!({ "base": l.base, "tony": l.tony, "loaded": loaded, "onlyTony": only, "allModels": list["models"].as_array().map(|a| a.iter().map(|m| json!({ "key": m["key"], "type": m["type"], "loadedInstances": m["loaded_instances"].as_array().map(|x| x.len()) })).collect::<Vec<_>>()) })
                }
                Err(e) => {
                    blockers.push(format!("LM Studio /api/v1/models: {e}"));
                    json!({ "base": l.base, "tony": l.tony, "error": e })
                }
            }
        }
        Err(e) => {
            blockers.push(format!("no lmstudio provider: {e}"));
            json!({ "error": e })
        }
    };
    // Gateway (GET only)
    let gw = match lease_get(&http, &live.lease_url, live.bearer.as_deref()).await {
        Ok(l) => {
            if l["maintenance"] == true {
                blockers.push(format!("the gateway already shows a maintenance lease ({}); something else is swapping models", l["holder"]));
            }
            json!({ "url": live.lease_url, "bearer": live.bearer.is_some(), "lease": l })
        }
        Err(e) => {
            blockers.push(format!("gateway {} unreachable: {e}; nothing was unloaded", live.lease_url));
            json!({ "url": live.lease_url, "bearer": live.bearer.is_some(), "error": e })
        }
    };
    // ComfyUI preflight (8188 free, python present)
    let comfy = ComfyHttp::local(http.clone());
    let pre = comfy_preflight_live(&paths, &comfy).await;
    if let Err(e) = &pre {
        blockers.push(format!("ComfyUI preflight: {e}"));
    }
    // Template dry fill + model files
    let project_root = PathBuf::from(os_core::MEDIA_ROOT).join("projects").join(SLUG);
    let aspect = media::load_manifest_strict(&project_root, SLUG).ok().map(|m| m.output.aspect);
    let params = job_params_for(aspect.as_deref());
    let mut dry = params.clone();
    dry["slug"] = json!(SLUG);
    let fill = dry_run_fill(&LiveTemplates, TEMPLATE, &dry);
    if let Err(e) = &fill {
        blockers.push(format!("template dry fill: {e}"));
    }
    let missing = missing_models(&roots, &LiveTemplates.required_models(TEMPLATE));
    if !missing.is_empty() {
        blockers.push(needs_text(&missing));
    }
    // App state that would fight the run
    let marker = app_marker_path(&live.cfg_dir);
    let marker_v = read_marker(&marker);
    if marker.exists() {
        blockers.push(format!("a crash marker is already at {} (an earlier batch didn't finish); let the app recover it first", marker.display()));
    }
    let own = test_marker_path(scratch);
    if own.exists() {
        blockers.push(format!("this test's crash marker is still at {} (an earlier run died): check only Tony is loaded, then delete it", own.display()));
    }
    let app = command_center_pids();
    if let Some(r) = preempt_file_reason(scratch) {
        blockers.push(format!("{r}; delete it to run"));
    }
    let vram = tauri::async_runtime::spawn_blocking(|| super::super::system::gpu_now()).await.ok().flatten();
    let apps = tauri::async_runtime::spawn_blocking(apps_snapshot).await.unwrap_or(Value::Null);
    let db = match app_db_version(&live.cfg_dir) {
        Ok(v) => json!({ "appDbVersion": v, "buildVersion": media::MIGRATIONS.len(), "appDbUsable": v as usize == media::MIGRATIONS.len() }),
        Err(e) => json!({ "appDbError": e, "buildVersion": media::MIGRATIONS.len() }),
    };
    let report = json!({
        "configDir": live.cfg_dir,
        "lmstudio": lm_v,
        "gateway": gw,
        "comfy": {
            "preflight": pre.as_ref().map(|_| "ok").map_err(|e| e.clone()),
            "python": paths.python, "comfyDir": paths.comfy_dir, "hub": paths.hub, "hubExists": paths.hub.is_dir(),
            "yaml": paths.yaml(), "yamlWouldBe": extra_model_paths_yaml(&roots), "args": command_args(&paths),
        },
        "template": { "name": TEMPLATE, "params": params, "dryFill": fill.as_ref().map(|_| "ok").map_err(|e| e.clone()) },
        "models": { "roots": roots, "checkpoint": find_model(&roots, CKPT), "missing": missing },
        "vramNow": vram.map(|g| json!({ "usedMb": g.vram_used_mb, "gpu": g })),
        "computeApps": apps,
        "tonyPriorityPct": live.os.scheduler.tony_priority_pct,
        "marker": { "path": marker, "exists": marker.exists(), "content": marker_v },
        "commandCenterPids": app,
        "preemptFile": scratch.join(PREEMPT_FILE),
        "project": { "root": project_root, "exists": project_root.is_dir() },
        "mediaDb": db,
        "blockers": blockers,
        "ready": blockers.is_empty(),
    });
    (report, blockers)
}

fn print_json(tag: &str, v: &Value) {
    eprintln!("[comfy-live] {tag}:\n{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

// ── The run ─────────────────────────────────────────────────────────────────

fn full_run(live: LiveCfg, lm: model_swap::Lm, scratch: &Path, t0: Instant, gate_report: Value) {
    let (media_st, media_v) = media_state(scratch, &live.cfg_dir).unwrap_or_else(|e| panic!("media state: {e}"));
    let media_st = Arc::new(media_st);
    let (slug, project_how) = ensure_project(&media_st).unwrap_or_else(|e| panic!("project {SLUG}: {e}"));
    let project_root = media::project_root(&media_st, &slug).expect("project root");
    let aspect = media::load_manifest_strict(&project_root, &slug).ok().map(|m| m.output.aspect);

    // Isolated queue (never <config>\comfy-queue.json): exactly one scene-still job.
    let qpath = scratch.join(format!("comfy-queue-{}.json", now_ms()));
    let store = Arc::new(Store::open(qpath.clone()));
    let roots = ComfySettings::default().model_roots;
    let missing = missing_models(&roots, &LiveTemplates.required_models(TEMPLATE));
    let job = store.enqueue(&slug, TEMPLATE, job_params_for(aspect.as_deref()), &missing);
    assert_eq!(job.status, JobStatus::Queued, "job not runnable: {:?}", job.error);

    let http = live.dispatch.http.clone();
    let io = Arc::new(TestIo {
        lm: lm.clone(),
        comfy: ComfyHttp::local(http.clone()),
        paths: ComfyPaths::live(),
        roots,
        proc_: Mutex::default(),
        marker: test_marker_path(scratch),
        scratch: scratch.to_path_buf(),
        http: http.clone(),
        lease_url: live.lease_url.clone(),
        bearer: live.bearer.clone(),
        holder: Mutex::default(),
        media: media_st.clone(),
        t0,
        events: Mutex::default(),
        assets: Mutex::default(),
    });
    let ctl = Arc::new(Control::default());
    let slot = Arc::new(super::super::scheduler::GpuSlot::default());
    let cfg = RunCfg::live(live.os.scheduler.tony_priority_pct);

    let apps_before = apps_snapshot();
    let vram_before = model_swap::live_vram()();

    // compute-apps (whisper) every 3 s while the batch runs, tagged with the batch phase.
    let stop = Arc::new(AtomicBool::new(false));
    let apps_during = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sampler = {
        let (stop, during, ctl) = (stop.clone(), apps_during.clone(), ctl.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let phase = lk(&ctl.phase).clone();
                lk(&during).push(json!({ "tMs": t0.elapsed().as_millis() as u64, "phase": phase, "snapshot": apps_snapshot() }));
                let until = Instant::now() + APPS_EVERY;
                while Instant::now() < until && !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })
    };

    let outcome: Result<BatchReport, String> = tauri::async_runtime::block_on(async {
        let (io2, store2, slot2, ctl2, cfg2) = (io.clone(), store.clone(), slot.clone(), ctl.clone(), cfg.clone());
        let mut h = tauri::async_runtime::spawn(async move { run_batch(&*io2, &*store2, &LiveTemplates, &*slot2, &cfg2, &*ctl2).await });
        let mut done = tokio::time::timeout(HARD_TIMEOUT, &mut h).await.ok();
        // Never cut run_batch off inside its own restore (a dropped load request still finishes in
        // LM Studio, and a second restore next to it could double Tony): give it its bounded time.
        if done.is_none() && lk(&ctl.phase).as_str() == RESTORE_PHASE {
            eprintln!("[comfy-live] hard timeout during \"{RESTORE_PHASE}\": waiting up to {} min more for the batch's own restore", RESTORE_GRACE.as_secs() / 60);
            done = tokio::time::timeout(RESTORE_GRACE, &mut h).await.ok();
        }
        match done {
            Some(Ok(rep)) => Ok(rep),
            Some(Err(e)) => Err(format!("the batch task crashed: {e}")),
            None => {
                let phase = lk(&ctl.phase).clone();
                h.abort();
                // The batch future (and anything it holds) is gone before the cleanup starts.
                let _ = (&mut h).await;
                Err(format!("hard timeout ({} min) in phase {phase:?}", HARD_TIMEOUT.as_secs() / 60))
            }
        }
    });

    // run_batch restores Tony itself once it touched anything. A crash or the hard timeout skipped
    // that: stop our ComfyUI, then put Tony back (unload all → load once → verify; never doubled).
    // The batch's heartbeat died with it, so the cleanup keeps its own lease up meanwhile (the
    // same holder when there was one, so the release below still recognises it).
    let mut cleanup = json!(null);
    if let Err(e) = &outcome {
        let holder = lk(&io.holder).get_or_insert_with(|| model_swap::maintenance_holder("comfyui · cleanup")).clone();
        let v = tauri::async_runtime::block_on(async {
            let hb = model_swap::lease_heartbeat(http.clone(), live.lease_url.clone(), live.bearer.clone(), holder.clone(), model_swap::HEARTBEAT_EVERY);
            io.interrupt().await;
            io.free().await;
            io.comfy_stop().await;
            // The marker goes down before the unload: without it no LLM was touched.
            let touched = io.read_marker().is_some();
            // ComfyUI's VRAM back BEFORE Qwen reloads (hybrid overflows at >= 90%).
            let (vram, settled) = if touched { wait_vram(&io.vram(), &cfg).await } else { (None, false) };
            let already = lm.snapshot_loaded().await.is_ok_and(|l| model_swap::only_tony(&l, &lm.tony));
            let how = if touched && !already { "restore" } else { "verify" };
            let r = if how == "restore" { io.restore_tony().await } else { io.verify_only_tony().await };
            if r.ok {
                io.clear_marker();
            }
            let beats = hb.stop().await.unwrap_or(0);
            json!({ "why": e, "holder": holder, "touched": touched, "tonyAlreadyBack": already, "how": how, "vramBeforeReloadMb": vram, "vramSettled": settled, "leaseBeats": beats, "restore": r })
        });
        cleanup = v;
    }
    stop.store(true, Ordering::SeqCst);
    let _ = sampler.join();

    // The app's slot mirror would release the gateway lease; here we do (only if still ours).
    let holder = lk(&io.holder).clone();
    let lease = tauri::async_runtime::block_on(async {
        match &holder {
            Some(h) => lease_release_if_ours(&http, &live.lease_url, live.bearer.as_deref(), h).await,
            None => json!({ "released": false, "note": "no lease was taken" }),
        }
    });

    // Belt and braces: report only (a listing; nothing is loaded or unloaded here).
    let final_check = tauri::async_runtime::block_on(lm.snapshot_loaded());
    let final_v = match &final_check {
        Ok(l) => json!({ "loaded": l, "onlyTony": model_swap::only_tony(l, &lm.tony) }),
        Err(e) => json!({ "error": e }),
    };
    let apps_after = apps_snapshot();
    let during = lk(&apps_during).clone();
    let render_apps: Vec<&Value> = during.iter().filter(|s| s["phase"].as_str().is_some_and(|p| p.starts_with("rendering"))).collect();

    let rep = outcome.as_ref().ok();
    let job_after = store.job(&job.id);
    let assets = lk(&io.assets).clone();
    let report = build_report(
        rep,
        job_after.as_ref(),
        &assets,
        json!({
            "outcome": outcome.as_ref().map(|_| "batch finished").map_err(|e| e.clone()),
            "cleanup": cleanup,
            "leaseRelease": lease,
            "finalCheck": final_v,
            "vramBeforeMb": vram_before,
            "whisper": {
                "before": apps_before,
                "duringRender": render_apps,
                "duringAll": during,
                "after": apps_after,
            },
            "project": { "slug": slug, "root": project_root, "how": project_how },
            "media": media_v,
            "queueFile": qpath,
            "markerPath": io.marker,
            "preflight": gate_report,
            "events": lk(&io.events).clone(),
            "totalWallSeconds": (t0.elapsed().as_millis() as f64 / 100.0).round() / 10.0,
        }),
    );
    let out = project_root.join("working").join("comfy-smoke-report.json");
    let _ = std::fs::create_dir_all(out.parent().unwrap());
    let _ = std::fs::write(&out, serde_json::to_vec_pretty(&report).unwrap_or_default());
    print_json("report", &report);
    eprintln!("[comfy-live] report written to {}", out.display());

    let rep = outcome.unwrap_or_else(|e| panic!("batch didn't finish: {e} (Tony restore: {})", report["cleanup"]["restore"]["ok"]));
    assert!(rep.restore.as_ref().is_some_and(|r| r.ok), "Tony wasn't put back: {:?}", rep.restore);
    assert!(final_check.as_ref().is_ok_and(|l| model_swap::only_tony(l, &lm.tony)), "final check: not only Tony loaded: {final_v}");
    assert_eq!(rep.done, vec![job.id.clone()], "the job didn't render: {:?} / {:?}", rep.error, job_after.and_then(|j| j.error));
    assert!(!assets.is_empty(), "the render wasn't ingested into {slug}");
}

#[test]
#[ignore = "live: unloads Qwen, starts ComfyUI on the GPU, renders, reloads Qwen; run with COMFY_LIVE=1 -- --ignored"]
fn live_sdxl_turbo_smoke() {
    if std::env::var("COMFY_LIVE").as_deref() != Ok("1") {
        eprintln!("COMFY_LIVE is not 1: skipping the live ComfyUI smoke test");
        return;
    }
    let _sampler = SamplerReaper;
    let t0 = Instant::now();
    let scratch = scratch();
    std::fs::create_dir_all(&scratch).unwrap_or_else(|e| panic!("scratch {}: {e}", scratch.display()));
    let live = load_live(&scratch).unwrap_or_else(|e| panic!("live config: {e}"));
    let lm = model_swap::Lm::from_dispatch(&live.dispatch);
    let (gate_report, blockers) = tauri::async_runtime::block_on(gates(&live, &lm, &scratch));
    if std::env::var("COMFY_LIVE_STEP").as_deref() == Ok("preflight") {
        let out = scratch.join("preflight-report.json");
        let _ = std::fs::write(&out, serde_json::to_vec_pretty(&gate_report).unwrap_or_default());
        print_json("preflight", &gate_report);
        eprintln!("[comfy-live] preflight written to {} (nothing was unloaded, started or leased)", out.display());
        return;
    }
    if !blockers.is_empty() {
        print_json("preflight", &gate_report);
        panic!("not starting: nothing was touched. Blockers:\n  {}", blockers.join("\n  "));
    }
    full_run(live, lm.expect("checked by the gates"), &scratch, t0, gate_report);
}

/// system.rs's resident `nvidia-smi -lms` sampler is a plain child process: when a test binary
/// exits it is orphaned and keeps running (and keeps a redirected stdout open, so the shell
/// waiting on the run never returns). On drop (also on panic), kill our own nvidia-smi children.
struct SamplerReaper;

impl Drop for SamplerReaper {
    fn drop(&mut self) {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
        let me = sysinfo::Pid::from_u32(std::process::id());
        let mut sys = sysinfo::System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        for (pid, p) in sys.processes() {
            if p.parent() == Some(me) && p.name().to_string_lossy().eq_ignore_ascii_case("nvidia-smi.exe") {
                crate::proc::kill_tree(pid.as_u32());
            }
        }
    }
}

// ── Unit tests for the pure helpers (always run) ────────────────────────────

#[test]
fn preempt_file_reason_follows_the_file() {
    let d = std::env::temp_dir().join(format!("cc-comfy-live-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&d).unwrap();
    assert_eq!(preempt_file_reason(&d), None);
    std::fs::write(d.join(PREEMPT_FILE), b"").unwrap();
    assert!(preempt_file_reason(&d).unwrap().contains(PREEMPT_FILE));
    std::fs::remove_file(d.join(PREEMPT_FILE)).unwrap();
    assert_eq!(preempt_file_reason(&d), None);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn compute_apps_parse_and_whisper_detection() {
    let text = "1234, C:\\ai\\faster-whisper\\.venv\\Scripts\\python.exe, 1180\n5678, C:\\Program Files\\LM Studio\\LM Studio.exe, [N/A]\n\nbad line\n";
    let apps = parse_compute_apps(text);
    assert_eq!(apps.len(), 2);
    assert_eq!(apps[0]["pid"], 1234);
    assert_eq!(apps[0]["usedMb"], 1180);
    assert_eq!(apps[1]["name"], "C:\\Program Files\\LM Studio\\LM Studio.exe");
    assert!(apps[1]["usedMb"].is_null());
    let w = whisper_of(&apps);
    assert_eq!(w["resident"], true);
    assert_eq!(w["usedMb"], 1180);
    // No STT by name and no command line read: unknown, not false.
    assert!(whisper_of(&apps[1..])["resident"].is_null());
    assert!(parse_compute_apps("No running processes found\n").is_empty());
    // faster-whisper as nvidia-smi names it: a plain python.exe, recognised by its command line.
    let fw = json!({ "pid": 37592, "name": "C:\\Users\\x\\AppData\\Roaming\\uv\\python\\cpython-3.13-windows-x86_64-none\\python.exe", "usedMb": null, "cmd": "python.exe G:\\agentic os\\stt\\fw_server.py --model large-v3-turbo --compute-type int8_float16" });
    let lms = json!({ "pid": 5678, "name": "LM Studio.exe", "usedMb": null, "cmd": "LM Studio.exe --type=gpu" });
    let both = [fw.clone(), lms.clone()];
    assert_eq!(whisper_of(&both)["resident"], true);
    assert_eq!(whisper_of(&both)["processes"][0]["pid"], 37592);
    // Every command line read, none STT: false. One unreadable: unknown (null), not false.
    assert_eq!(whisper_of(std::slice::from_ref(&lms))["resident"], false);
    let unknown = json!({ "pid": 9, "name": "python.exe", "usedMb": null, "cmd": null });
    assert!(whisper_of(&[lms, unknown])["resident"].is_null());
}

#[test]
fn lease_lm_and_app_checks() {
    let h = model_swap::maintenance_holder("comfyui · 1 job(s)");
    assert!(lease_is_ours(&json!({ "busy": true, "holder": h }), &h));
    assert!(!lease_is_ours(&json!({ "busy": false, "holder": h }), &h));
    assert!(!lease_is_ours(&json!({ "busy": true, "holder": "pipeline:coder" }), &h));
    assert!(check_lm_target(LM_BASE, TONY_MODEL).is_ok());
    assert!(check_lm_target("http://127.0.0.1:1234", TONY_MODEL).is_err());
    assert!(check_lm_target(LM_BASE, "local-model").is_err());
    assert!(is_app_exe("Jarvis Command Center.exe") && is_app_exe("command-center.exe"));
    assert!(!is_app_exe("command_center_lib-0123abcd.exe"));
}

#[test]
fn smoke_params_are_the_turbo_defaults_and_fill() {
    let p = job_params_for(None);
    assert_eq!(p["seed"], SEED);
    assert_eq!(p["prompt"], PROMPT);
    let mut dry = p.clone();
    dry["slug"] = json!(SLUG);
    let g = LiveTemplates.fill(TEMPLATE, &{
        let mut x = dry.clone();
        x["jobId"] = json!("cj0");
        x
    });
    assert!(g.is_ok(), "{g:?}");
    assert!(dry_run_fill(&LiveTemplates, TEMPLATE, &dry).is_ok());
    assert_eq!(LiveTemplates.required_models(TEMPLATE), [CKPT]);
    // What the live run actually uses: the project manifest's aspect, 16:9 by default.
    let wide = job_params_for(Some("16:9"));
    assert_eq!(wide["aspect"], "16:9");
    let mut x = wide.clone();
    x["slug"] = json!(SLUG);
    assert!(dry_run_fill(&LiveTemplates, TEMPLATE, &x).is_ok());
    x["jobId"] = json!("cj0");
    assert!(LiveTemplates.fill(TEMPLATE, &x).is_ok(), "16:9 fill");
}

#[test]
fn report_carries_timing_vram_restore_and_provenance() {
    let gen = GenMeta { template: TEMPLATE.into(), prompt: PROMPT.into(), seed: SEED, steps: 1, sampler: "euler_ancestral".into(), width: 512, height: 512, checkpoint: "sd_xl_turbo_1.0_fp16.safetensors".into(), whisper_resident: Some(true), ..Default::default() };
    let job = Job {
        id: "cj1".into(),
        slug: SLUG.into(),
        template: TEMPLATE.into(),
        params: json!({}),
        status: JobStatus::Done,
        created_at: 0,
        started_at: None,
        finished_at: None,
        error: None,
        outputs: vec![JobOutput { path: "x.png".into(), filename: "x.png".into(), asset_id: Some("a1".into()), gen, ..Default::default() }],
        render_ms: Some(4_321),
        peak_vram_mb: Some(9_100),
        prompt_id: Some("p1".into()),
    };
    let rep = BatchReport { done: vec!["cj1".into()], vram_after_unload_mb: Some(1_900), vram_after_stop_mb: Some(2_000), comfyui_version: Some("0.46.0".into()), restore: Some(Restore { ok: true, load_ms: Some(12_340), ..Default::default() }), ..Default::default() };
    let v = build_report(Some(&rep), Some(&job), &[json!({ "assetId": "a1" })], json!({ "totalWallSeconds": 99.0 }));
    assert_eq!(v["ok"], true);
    assert_eq!(v["renderSeconds"], 4.3);
    assert_eq!(v["peakVramDuringRenderMb"], 9_100);
    assert_eq!(v["vramAfterUnloadMb"], 1_900);
    assert_eq!(v["vramAfterStopMb"], 2_000);
    assert_eq!(v["qwenReloadSeconds"], 12.3);
    assert_eq!(v["comfyuiVersion"], "0.46.0");
    assert_eq!(v["image"]["seed"], SEED);
    assert_eq!(v["image"]["prompt"], PROMPT);
    assert_eq!(v["image"]["settings"]["steps"], 1);
    assert_eq!(v["image"]["whisperResident"], true);
    assert_eq!(v["assets"][0]["assetId"], "a1");
    assert_eq!(v["totalWallSeconds"], 99.0);
    // No batch (crash / timeout): not ok, nulls rather than a panic.
    let none = build_report(None, None, &[], json!({}));
    assert_eq!(none["ok"], false);
    assert!(none["renderSeconds"].is_null() && none["image"].is_null());
}
