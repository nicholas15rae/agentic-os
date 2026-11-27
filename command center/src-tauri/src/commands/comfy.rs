//! Director Suite Part 2: ComfyUI image/video generation as an overnight / idle batch job on the
//! one 12 GB card that Tony's LLM normally owns.
//!
//! ComfyUI is NEVER started at boot or by any loop other than a batch run. A batch:
//!   1. admission (`admit`, pure): runnable jobs (their model files on disk), nobody mid-conversation
//!      (no foreground waiter on the GPU slot, ≥ 180 s since the last interactive touch / Tony turn,
//!      compaction's idle gate clear) and the policy says go (idle; overnight 01:00–06:00 local or
//!      Away mode; or Run now);
//!   2. `acquire_maintenance("comfyui · N job(s)")` (exclusive; the gateway holds its own LLM calls
//!      while a `maintenance` holder is up) + the lease heartbeat (the gateway caps a lease at 15 min);
//!   3. crash marker → snapshot + unload every LLM → confirm VRAM dropped → start ComfyUI headless
//!      (kill-on-close Job Object, CREATE_NO_WINDOW) and wait for `/system_stats`;
//!   4. per job: fill the template, `POST /prompt`, poll `/history` (10 min cap), download outputs
//!      via `/view` into `<project>/working/gen/<job-id>/`, peak VRAM sampled. LM Studio is polled
//!      every 5 s: a JIT-loaded LLM interrupts the render. A Tony preempt (foreground waiter or a
//!      fresh interactive touch) interrupts and puts the remaining jobs back to `queued`;
//!   5. ALWAYS, whatever failed: `/free` → stop ComfyUI → put Tony back (unload all, load at
//!      production settings, warm up, verify he's the only LLM) → clear the marker → stop the
//!      heartbeat → release the slot. (Hybrid mode overflows chat to the droplet at VRAM ≥ 90%, so
//!      ComfyUI is freed and stopped BEFORE Qwen is reloaded.)
//! On app start a leftover crash marker runs the recovery: kill the ComfyUI we started (the PID in
//! the marker, checked against our python and start time — never one we didn't start), then
//! `verify_only_tony`.
//!
//! Queue: `<config dir>/comfy-queue.json` (atomic write) with the settings (model roots, policy).
//! Events: `comfy-queue` (a job changed), `comfy-service` (batch phase / service), and a Director
//! report hook `director-report` {kind:"comfy-batch", done, failed, slug} for the comms layer.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::media::GenMeta;
use super::model_swap::{self, Inst, Restore, Task, VramFn};
use super::scheduler::GpuSlot;

pub const COMFY_PORT: u16 = 8188;
/// The slot label prefix (`maintenance · comfyui · N job(s)`).
pub const SLOT_PREFIX: &str = "comfyui";
/// Quiet time after the last interactive touch / Tony turn before a batch may start.
pub const QUIET_MS: u64 = 180_000;
/// Overnight window, local minutes since midnight: [01:00, 06:00).
pub const OVERNIGHT: (u32, u32) = (60, 360);
/// Runner tick (it is also woken by enqueue / Run now).
const TICK: Duration = Duration::from_secs(60);
/// Default model root (Settings can replace / extend it).
pub const DEFAULT_MODEL_ROOT: &str = r"D:\AI Models Media and Vision";
/// Finished jobs kept in the queue file.
const KEEP_FINISHED: usize = 200;
pub const JIT_ERROR: &str = "LM Studio reloaded a model mid-render";
/// No batch in the first 10 min after launch (LM Studio / Bionic may still be loading Qwen, and a
/// logon launch is when Nic sits down); Run now respects it too.
pub const BOOT_GRACE_MS: u64 = 600_000;
/// After a batch-level failure: no admission for 15 min, doubling per failure up to 4 h (reset on
/// a batch that rendered something, or Run now).
pub const BACKOFF_BASE_MS: u64 = 15 * 60_000;
pub const BACKOFF_CAP_MS: u64 = 4 * 60 * 60_000;
/// What Tony's Qwen (qwen3.5-9b at 32768 × 2) holds, for the pre-unload VRAM estimate.
pub const TONY_VRAM_EST_MB: u64 = 10_700;
/// A failed restore is retried on later ticks after 1, 5, then every 15 min.
pub const RECOVERY_RETRY_MS: [u64; 3] = [60_000, 300_000, 900_000];
/// Wall-time cap per batch: the gateway refuses phone Tony while a `maintenance` lease is up and
/// none of the preempt signals can see that (shared-core gap), so a batch ends after this and
/// puts Tony back; the rest wait for the next admission.
pub const BATCH_WALL: Duration = Duration::from_secs(20 * 60);

/// Admission backoff after `failures` consecutive batch-level failures (0: none).
pub fn backoff_ms(failures: u32) -> u64 {
    if failures == 0 {
        return 0;
    }
    BACKOFF_BASE_MS.saturating_mul(1u64 << (failures - 1).min(16)).min(BACKOFF_CAP_MS)
}

/// A batch that failed as a whole (nothing rendered and an error, or Tony not put back) counts
/// toward the backoff; a preempt or a deferral does not.
pub fn batch_failed(rep: &BatchReport) -> bool {
    rep.deferred.is_none() && ((rep.error.is_some() && rep.done.is_empty()) || rep.restore.as_ref().is_some_and(|r| !r.ok))
}

/// Is a crash-marker recovery due? `attempts` so far this session, `last` = ms of the last one.
pub fn recovery_due(attempts: u32, last: u64, now: u64) -> bool {
    attempts == 0 || now.saturating_sub(last) >= RECOVERY_RETRY_MS[(attempts as usize - 1).min(RECOVERY_RETRY_MS.len() - 1)]
}

fn now_ms() -> u64 {
    super::arbiter::now_ms()
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ── Templates seam ──────────────────────────────────────────────────────────

/// What the batch needs from the templates module (comfy_templates.rs; a trait so tests fake it).
pub trait TemplatesApi: Send + Sync {
    /// The ComfyUI API prompt graph for `template` with `params` (a `GenParams` as JSON).
    fn fill(&self, template: &str, params: &Value) -> Result<Value, String>;
    /// Model files the template needs, as `<category>/<file>` or a bare file name.
    fn required_models(&self, template: &str) -> Vec<String>;
    /// Every template name (status readiness).
    fn names(&self) -> Vec<String> {
        vec![]
    }
    /// Err: the template can't be queued at all (unknown, or not built yet).
    fn check(&self, _template: &str) -> Result<(), String> {
        Ok(())
    }
    /// The output (SaveImage) node ids to read in `/history`; empty = every node.
    fn output_nodes(&self, _template: &str) -> Vec<String> {
        vec![]
    }
}

use super::comfy_templates as templates;

/// The live templates (comfy_templates.rs).
pub struct LiveTemplates;

impl TemplatesApi for LiveTemplates {
    fn fill(&self, template: &str, params: &Value) -> Result<Value, String> {
        let p: templates::GenParams = serde_json::from_value(params.clone()).map_err(|e| format!("bad params: {e}"))?;
        templates::fill(template, &p)
    }
    fn required_models(&self, template: &str) -> Vec<String> {
        templates::required_models(template)
    }
    fn names(&self) -> Vec<String> {
        templates::list().into_iter().map(|t| t.name).collect()
    }
    fn check(&self, template: &str) -> Result<(), String> {
        let t = templates::list().into_iter().find(|t| t.name == template).ok_or_else(|| format!("unknown template {template:?}"))?;
        if !t.implemented {
            return Err(t.unavailable_reason.unwrap_or_else(|| format!("template {template:?} is not built yet")));
        }
        Ok(())
    }
    fn output_nodes(&self, template: &str) -> Vec<String> {
        templates::output_node_ids(template)
    }
}

/// The params `fill` gets for a queued job: the stored params with `slug` and `jobId` set from
/// the job (they name the SaveImage prefix `director/<slug>/<jobId>`).
pub fn job_params(job: &Job) -> Value {
    let mut p = if job.params.is_object() { job.params.clone() } else { json!({}) };
    p["slug"] = json!(job.slug);
    p["jobId"] = json!(job.id);
    p
}

/// `fill` is deterministic and needs a seed: pick one at enqueue when none was given, so the
/// queue records it (≤ 2^53 so the webview's numbers keep it exact).
pub fn with_seed(mut params: Value, entropy: u64) -> Value {
    if !params.is_object() {
        params = json!({});
    }
    if params["seed"].as_u64().is_none() {
        let mut x = entropy ^ 0x9E37_79B9_7F4A_7C15;
        x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE5_E5B9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        params["seed"] = json!((x ^ (x >> 31)) % (1u64 << 53));
    }
    params
}

/// An absolute `inputImage` (a still in the project) is copied into ComfyUI's input dir (ours, on
/// G:, never the ComfyUI folder) as `<job-id>/<file>`, and the params point at that name.
pub fn stage_input(params: &Value, input_dir: &Path, job_id: &str) -> Result<Value, String> {
    let Some(src) = params["inputImage"].as_str().or(params["input_image"].as_str()) else { return Ok(params.clone()) };
    let src_path = Path::new(src);
    if !src_path.is_absolute() {
        return Ok(params.clone());
    }
    let name = safe_name(src).ok_or("bad input image name")?;
    let id = safe_name(job_id).ok_or("bad job id")?;
    let dir = input_dir.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::copy(src_path, dir.join(&name)).map_err(|e| format!("copy {src}: {e}"))?;
    let mut p = params.clone();
    if let Some(o) = p.as_object_mut() {
        o.remove("input_image");
    }
    p["inputImage"] = json!(format!("{id}/{name}"));
    Ok(p)
}

// ── Paths, command line, extra_model_paths.yaml ─────────────────────────────

#[derive(Clone, Debug)]
pub struct ComfyPaths {
    pub python: PathBuf,
    /// The ComfyUI checkout (never written to).
    pub comfy_dir: PathBuf,
    /// Our side: yaml, output, user, temp, logs.
    pub hub: PathBuf,
}

impl ComfyPaths {
    pub fn live() -> Self {
        ComfyPaths {
            python: PathBuf::from(r"C:\ComfyUI\ComfyUI_windows_portable\python_embeded\python.exe"),
            comfy_dir: PathBuf::from(r"C:\ComfyUI\ComfyUI_windows_portable\ComfyUI"),
            hub: PathBuf::from(r"G:\ai-hub\comfy"),
        }
    }
    pub fn yaml(&self) -> PathBuf {
        self.hub.join("extra_model_paths.yaml")
    }
    pub fn output(&self) -> PathBuf {
        self.hub.join("output")
    }
    pub fn user(&self) -> PathBuf {
        self.hub.join("user")
    }
    pub fn temp(&self) -> PathBuf {
        self.hub.join("temp")
    }
    /// LoadImage reads only ComfyUI's input dir: ours, so nothing is copied into the checkout.
    pub fn input(&self) -> PathBuf {
        self.hub.join("input")
    }
    pub fn log(&self) -> PathBuf {
        self.hub.join("logs").join("comfyui.log")
    }
}

/// The exact headless arguments (python_embeded\python.exe <these>). Never
/// `--windows-standalone-build` (it auto-opens a browser), never run_nvidia_gpu.bat.
pub fn command_args(p: &ComfyPaths) -> Vec<String> {
    let s = |p: PathBuf| p.to_string_lossy().to_string();
    vec![
        "-s".into(),
        s(p.comfy_dir.join("main.py")),
        "--listen".into(),
        "127.0.0.1".into(),
        "--port".into(),
        COMFY_PORT.to_string(),
        "--disable-auto-launch".into(),
        "--disable-api-nodes".into(),
        "--extra-model-paths-config".into(),
        s(p.yaml()),
        "--output-directory".into(),
        s(p.output()),
        "--user-directory".into(),
        s(p.user()),
        "--temp-directory".into(),
        s(p.temp()),
        "--input-directory".into(),
        s(p.input()),
    ]
}

/// ComfyUI model category → sub-folders searched under every model root (first is the layout
/// the D: drive uses: checkpoints live in `sdxl-turbo/`).
pub const MODEL_DIRS: &[(&str, &[&str])] = &[
    ("checkpoints", &["sdxl-turbo", "checkpoints"]),
    ("vae", &["vae"]),
    ("loras", &["loras"]),
    ("upscale_models", &["upscalers", "upscale_models"]),
    ("controlnet", &["controlnet"]),
    ("clip", &["clip", "text_encoders"]),
    ("text_encoders", &["text_encoders", "clip"]),
    ("clip_vision", &["clip_vision"]),
    ("diffusion_models", &["diffusion_models", "unet"]),
    ("embeddings", &["embeddings"]),
];

fn yaml_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `extra_model_paths.yaml` for `roots` (ComfyUI's format: one section per root, `base_path`,
/// then `category: |` with one sub-folder per line).
pub fn extra_model_paths_yaml(roots: &[String]) -> String {
    let mut y = String::from("# Generated by Command Center (comfy.rs) from the Director model roots setting. Edits are overwritten.\n");
    let usable: Vec<&str> = roots.iter().map(|r| r.trim()).filter(|r| Path::new(r).is_absolute() && !r.chars().any(char::is_control)).collect();
    for (n, root) in usable.iter().enumerate() {
        y.push_str(&format!("director_{n}:\n    base_path: {}\n", yaml_quote(root)));
        for (cat, dirs) in MODEL_DIRS {
            y.push_str(&format!("    {cat}: |\n"));
            for d in *dirs {
                y.push_str(&format!("        {d}\n"));
            }
        }
    }
    // An all-comment file parses to None and crashes ComfyUI's loader; a null section is skipped.
    if usable.is_empty() {
        y.push_str("director_no_roots:\n");
    }
    y
}

/// Write `content` only when it differs. Ok(true): written.
pub fn write_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("create {}: {e}", d.display()))?;
    }
    super::staging::atomic_write(path, content.as_bytes())?;
    Ok(true)
}

/// The yaml (only when changed) and output / user / temp / logs folders.
pub fn prepare_dirs(p: &ComfyPaths, roots: &[String]) -> Result<bool, String> {
    for d in [p.output(), p.user(), p.temp(), p.input(), p.hub.join("logs")] {
        std::fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
    }
    write_if_changed(&p.yaml(), &extra_model_paths_yaml(roots))
}

/// Where a required model is on disk. `name` is `<category>/<file>` (searched in that category's
/// folders) or a bare file (every category, then the root itself).
pub fn find_model(roots: &[String], name: &str) -> Option<PathBuf> {
    let norm = name.replace('\\', "/");
    let (cat, file) = match norm.split_once('/') {
        Some((c, f)) if MODEL_DIRS.iter().any(|(k, _)| *k == c) => (Some(c.to_string()), f.to_string()),
        _ => (None, norm.clone()),
    };
    if file.is_empty() || file.contains("..") {
        return None;
    }
    for root in roots.iter().map(|r| PathBuf::from(r.trim())) {
        for (k, dirs) in MODEL_DIRS {
            if cat.as_deref().is_some_and(|c| c != *k) {
                continue;
            }
            for d in *dirs {
                let p = root.join(d).join(&file);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        if cat.is_none() && root.join(&file).is_file() {
            return Some(root.join(&file));
        }
    }
    None
}

pub fn missing_models(roots: &[String], required: &[String]) -> Vec<String> {
    required.iter().filter(|m| find_model(roots, m).is_none()).cloned().collect()
}

pub fn needs_text(missing: &[String]) -> String {
    format!("needs model {}", missing.join(", "))
}

// ── Queue ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    /// Its template needs a model file that isn't on disk (`error` says which).
    Waiting,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn finished(self) -> bool {
        matches!(self, JobStatus::Done | JobStatus::Failed | JobStatus::Cancelled)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct JobOutput {
    pub path: String,
    pub filename: String,
    /// "image" | "video".
    pub kind: String,
    /// Set when media.rs ingested it as a project asset.
    pub asset_id: Option<String>,
    /// Provenance (the full workflow is in `workflow.json` next to the file).
    pub gen: GenMeta,
}

impl Default for JobOutput {
    fn default() -> Self {
        JobOutput { path: String::new(), filename: String::new(), kind: "image".into(), asset_id: None, gen: GenMeta::default() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub slug: String,
    pub template: String,
    #[serde(default)]
    pub params: Value,
    pub status: JobStatus,
    pub created_at: u64,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub finished_at: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub outputs: Vec<JobOutput>,
    #[serde(default)]
    pub render_ms: Option<u64>,
    #[serde(default)]
    pub peak_vram_mb: Option<u64>,
    #[serde(default)]
    pub prompt_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Any time nobody is mid-conversation (Nic's choice, 2026-11-26: the default).
    #[default]
    Idle,
    /// 01:00–06:00 local (or while Away mode is on).
    Overnight,
    /// Only on Run now.
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ComfySettings {
    pub model_roots: Vec<String>,
    pub policy: Policy,
}

impl Default for ComfySettings {
    fn default() -> Self {
        ComfySettings { model_roots: vec![DEFAULT_MODEL_ROOT.into()], policy: Policy::default() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueFile {
    pub version: u32,
    pub settings: ComfySettings,
    pub jobs: Vec<Job>,
}

impl Default for QueueFile {
    fn default() -> Self {
        QueueFile { version: 1, settings: ComfySettings::default(), jobs: vec![] }
    }
}

/// After a crash: a job left `running` goes back to `queued`. Returns how many.
pub fn recover(q: &mut QueueFile) -> usize {
    let mut n = 0;
    for j in q.jobs.iter_mut().filter(|j| j.status == JobStatus::Running) {
        j.status = JobStatus::Queued;
        j.started_at = None;
        j.prompt_id = None;
        j.error = Some("interrupted (the app stopped mid-render); queued again".into());
        n += 1;
    }
    n
}

/// Keep every unfinished job and the newest `KEEP_FINISHED` finished ones (order kept).
pub fn prune(q: &mut QueueFile) {
    let finished = q.jobs.iter().filter(|j| j.status.finished()).count();
    if finished <= KEEP_FINISHED {
        return;
    }
    let mut drop_n = finished - KEEP_FINISHED;
    q.jobs.retain(|j| {
        if drop_n > 0 && j.status.finished() {
            drop_n -= 1;
            false
        } else {
            true
        }
    });
}

/// queued ⇄ waiting as model files come and go. Returns the ids that changed.
pub fn refresh_waiting(q: &mut QueueFile, missing_for: &dyn Fn(&str) -> Vec<String>) -> Vec<String> {
    let mut changed = vec![];
    for j in q.jobs.iter_mut().filter(|j| matches!(j.status, JobStatus::Queued | JobStatus::Waiting)) {
        let missing = missing_for(&j.template);
        if !missing.is_empty() && j.status == JobStatus::Queued {
            j.status = JobStatus::Waiting;
            j.error = Some(needs_text(&missing));
            changed.push(j.id.clone());
        } else if missing.is_empty() && j.status == JobStatus::Waiting {
            j.status = JobStatus::Queued;
            j.error = None;
            changed.push(j.id.clone());
        }
    }
    changed
}

pub struct Store {
    path: Option<PathBuf>,
    q: Mutex<QueueFile>,
}

static SEQ: AtomicU32 = AtomicU32::new(0);

impl Store {
    /// Load (and recover) the queue file; a missing / unreadable file starts empty.
    pub fn open(path: PathBuf) -> Store {
        let mut q: QueueFile = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let n = recover(&mut q);
        let s = Store { path: Some(path), q: Mutex::new(q) };
        if n > 0 {
            eprintln!("[comfy] {n} interrupted job(s) queued again");
            let _ = s.save(&lk(&s.q));
        }
        s
    }

    #[cfg(test)]
    pub fn memory() -> Store {
        Store { path: None, q: Mutex::default() }
    }

    fn save(&self, q: &QueueFile) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        super::staging::atomic_write(p, &serde_json::to_vec_pretty(q).map_err(|e| e.to_string())?)
    }

    pub fn snapshot(&self) -> QueueFile {
        lk(&self.q).clone()
    }

    /// Change the queue and save it (a failed save is logged; memory stays authoritative).
    pub fn update<R>(&self, f: impl FnOnce(&mut QueueFile) -> R) -> R {
        let mut q = lk(&self.q);
        let r = f(&mut q);
        prune(&mut q);
        if let Err(e) = self.save(&q) {
            eprintln!("[comfy] queue not saved: {e}");
        }
        r
    }

    pub fn job(&self, id: &str) -> Option<Job> {
        lk(&self.q).jobs.iter().find(|j| j.id == id).cloned()
    }

    /// Change one job; returns it after the change.
    pub fn set(&self, id: &str, f: impl FnOnce(&mut Job)) -> Option<Job> {
        self.update(|q| {
            let j = q.jobs.iter_mut().find(|j| j.id == id)?;
            f(j);
            Some(j.clone())
        })
    }

    pub fn enqueue(&self, slug: &str, template: &str, params: Value, missing: &[String]) -> Job {
        let now = now_ms();
        let id = format!("cj{now}{:03}", SEQ.fetch_add(1, Ordering::SeqCst) % 1000);
        let (status, error) = if missing.is_empty() { (JobStatus::Queued, None) } else { (JobStatus::Waiting, Some(needs_text(missing))) };
        let job = Job { id, slug: slug.into(), template: template.into(), params, status, created_at: now, started_at: None, finished_at: None, error, outputs: vec![], render_ms: None, peak_vram_mb: None, prompt_id: None };
        self.update(|q| q.jobs.push(job.clone()));
        job
    }

    /// Queued / waiting → cancelled. A running job is only flagged (the runner interrupts it).
    /// Checked and changed under one lock, so the runner's Queued → Running (`start_running`)
    /// can't slip in between.
    pub fn cancel(&self, id: &str, ctl: &Control) -> Result<Job, String> {
        self.update(|q| {
            let j = q.jobs.iter_mut().find(|j| j.id == id).ok_or_else(|| format!("no job {id}"))?;
            match j.status {
                JobStatus::Queued | JobStatus::Waiting => {
                    j.status = JobStatus::Cancelled;
                    j.finished_at = Some(now_ms());
                    Ok(j.clone())
                }
                JobStatus::Running => {
                    lk(&ctl.cancel).insert(id.to_string());
                    Ok(j.clone())
                }
                _ => Err(format!("job {id} already finished")),
            }
        })
    }

    /// Queued → Running in one step; None (nothing changed) when the job is no longer queued
    /// (cancelled while the batch reached it).
    pub fn start_running(&self, id: &str) -> Option<Job> {
        self.update(|q| {
            let j = q.jobs.iter_mut().find(|j| j.id == id && j.status == JobStatus::Queued)?;
            j.status = JobStatus::Running;
            j.started_at = Some(now_ms());
            j.error = None;
            Some(j.clone())
        })
    }

    /// Queued jobs whose models are all on disk, oldest first.
    pub fn runnable(&self, missing_for: &dyn Fn(&str) -> Vec<String>) -> Vec<String> {
        lk(&self.q).jobs.iter().filter(|j| j.status == JobStatus::Queued && missing_for(&j.template).is_empty()).map(|j| j.id.clone()).collect()
    }
}

/// Run-time controls the commands share with the runner.
#[derive(Default)]
pub struct Control {
    pub cancel: Mutex<HashSet<String>>,
    pub phase: Mutex<String>,
}

impl Control {
    fn phase(&self, p: impl Into<String>) {
        *lk(&self.phase) = p.into();
    }
    fn cancelled(&self, id: &str) -> bool {
        lk(&self.cancel).contains(id)
    }
}

// ── Admission ───────────────────────────────────────────────────────────────

/// Everything admission looks at (gathered live by `live_signals`; pure here).
#[derive(Clone, Debug, Default)]
pub struct Signals {
    pub runnable: usize,
    /// Foreground callers (Tony) queued on the GPU slot.
    pub foreground_waiting: usize,
    /// ms since `compaction::LAST_INTERACTIVE_MS` (None: no touch this session).
    pub ms_since_interactive: Option<u64>,
    /// `arbiter::get().idle_for()` (None: no Tony turn this session).
    pub arbiter_idle_ms: Option<u64>,
    /// `compaction::current_idle_wait` reason (None: clear).
    pub idle_wait: Option<String>,
    pub away: bool,
    pub policy: Policy,
    /// Local minutes since midnight.
    pub local_minutes: u32,
    pub run_now: bool,
    /// ms since the app started (`Runtime::boot_ms`).
    pub ms_since_boot: u64,
    /// ms left on the batch-failure backoff (0: none) and how many failures in a row.
    pub backoff_left_ms: u64,
    pub failures: u32,
}

pub fn in_overnight_window(local_minutes: u32) -> bool {
    (OVERNIGHT.0..OVERNIGHT.1).contains(&local_minutes)
}

/// Ok: start a batch now. Err: why not (shown in status). Run now skips only the policy, never
/// the mid-conversation checks.
pub fn admit(s: &Signals) -> Result<(), String> {
    if s.runnable == 0 {
        return Err("nothing runnable (queue empty, or waiting on model files)".into());
    }
    if s.foreground_waiting > 0 {
        return Err("Tony is waiting for the GPU".into());
    }
    if let Some(ms) = s.ms_since_interactive.filter(|ms| *ms < QUIET_MS) {
        return Err(format!("mid-conversation (last interactive {} s ago; needs {} s)", ms / 1000, QUIET_MS / 1000));
    }
    if let Some(ms) = s.arbiter_idle_ms.filter(|ms| *ms < QUIET_MS) {
        return Err(format!("mid-conversation (last Tony turn {} s ago; needs {} s)", ms / 1000, QUIET_MS / 1000));
    }
    // At boot both signals are None ("no interaction yet"), which is not "quiet".
    if s.ms_since_boot < BOOT_GRACE_MS {
        return Err(format!("app just started ({} s ago; waits {} s)", s.ms_since_boot / 1000, BOOT_GRACE_MS / 1000));
    }
    if let Some(w) = &s.idle_wait {
        return Err(format!("not idle: {w}"));
    }
    if s.backoff_left_ms > 0 {
        return Err(format!("backing off after {} failed batch(es): next try in {} min (Run now retries)", s.failures, s.backoff_left_ms.div_ceil(60_000)));
    }
    if s.run_now {
        return Ok(());
    }
    match s.policy {
        Policy::Idle => Ok(()),
        Policy::Overnight if in_overnight_window(s.local_minutes) || s.away => Ok(()),
        Policy::Overnight => Err("overnight policy: waits for 01:00–06:00 (or Away mode)".into()),
        Policy::Manual => Err("manual policy: press Run now".into()),
    }
}

/// Tony wants the GPU back (checked between jobs and while a render polls). `since` = when the
/// batch got its slot.
pub fn preempt_reason(foreground_waiting: usize, last_interactive_ms: u64, arbiter_idle_ms: Option<u64>, since: u64, now: u64) -> Option<String> {
    if foreground_waiting > 0 {
        return Some("Tony is waiting for the GPU".into());
    }
    if last_interactive_ms > since {
        return Some("interactive use since the batch started".into());
    }
    if arbiter_idle_ms.is_some_and(|ms| ms < now.saturating_sub(since)) {
        return Some("a Tony turn since the batch started".into());
    }
    None
}

// ── ComfyUI REST ────────────────────────────────────────────────────────────

/// One output file a finished prompt reported.
#[derive(Clone, Debug, PartialEq)]
pub struct OutFile {
    /// The output node that wrote it.
    pub node: String,
    pub filename: String,
    pub subfolder: String,
    pub kind: String,
    /// "image" | "video".
    pub media: String,
}

#[derive(Debug, PartialEq)]
pub enum HistoryState {
    Pending,
    Error(String),
    Done(Vec<OutFile>),
}

fn media_kind(filename: &str) -> &'static str {
    let ext = Path::new(filename).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if matches!(ext.as_str(), "mp4" | "webm" | "mov" | "mkv" | "gif") {
        "video"
    } else {
        "image"
    }
}

/// `GET /history/{id}` → pending / error / done with the `type: output` files.
pub fn parse_history(prompt_id: &str, h: &Value) -> HistoryState {
    let Some(e) = h.get(prompt_id) else { return HistoryState::Pending };
    let st = &e["status"];
    if st["status_str"] == "error" {
        let msg = st["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m[0] == "execution_error")
            .map(|m| format!("{} ({})", m[1]["exception_message"].as_str().unwrap_or("error").trim(), m[1]["node_type"].as_str().unwrap_or("?")))
            .unwrap_or_else(|| "ComfyUI reported an error".into());
        return HistoryState::Error(msg);
    }
    let done = st["completed"] == true || st["status_str"] == "success" || (st.is_null() && e["outputs"].is_object());
    if !done {
        return HistoryState::Pending;
    }
    let mut files = vec![];
    for (node_id, node) in e["outputs"].as_object().into_iter().flat_map(|o| o.iter()) {
        for list in node.as_object().into_iter().flat_map(|o| o.values()) {
            for f in list.as_array().into_iter().flatten() {
                let (Some(name), kind) = (f["filename"].as_str(), f["type"].as_str().unwrap_or("output")) else { continue };
                if kind != "output" {
                    continue;
                }
                files.push(OutFile { node: node_id.clone(), filename: name.into(), subfolder: f["subfolder"].as_str().unwrap_or("").into(), kind: kind.into(), media: media_kind(name).into() });
            }
        }
    }
    HistoryState::Done(files)
}

/// A ComfyUI `/prompt` rejection as one line.
fn prompt_error(code: u16, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let msg = v["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| body.chars().take(200).collect());
    let nodes: Vec<String> = v["node_errors"].as_object().into_iter().flat_map(|o| o.iter()).map(|(k, e)| format!("{k}: {}", e["errors"][0]["message"].as_str().unwrap_or("?"))).collect();
    if nodes.is_empty() {
        format!("ComfyUI rejected the prompt (HTTP {code}): {msg}")
    } else {
        format!("ComfyUI rejected the prompt (HTTP {code}): {msg} — {}", nodes.join("; "))
    }
}

#[derive(Clone)]
pub struct ComfyHttp {
    pub http: reqwest::Client,
    pub base: String,
}

impl ComfyHttp {
    pub fn local(http: reqwest::Client) -> Self {
        ComfyHttp { http, base: format!("http://127.0.0.1:{COMFY_PORT}") }
    }

    pub async fn system_stats(&self, timeout: Duration) -> Result<Value, String> {
        let r = self.http.get(format!("{}/system_stats", self.base)).timeout(timeout).send().await.map_err(super::dispatch::short)?;
        r.error_for_status().map_err(super::dispatch::short)?.json().await.map_err(super::dispatch::short)
    }

    /// `POST /prompt` → prompt id.
    pub async fn submit(&self, prompt: &Value, client_id: &str) -> Result<String, String> {
        let r = self.http.post(format!("{}/prompt", self.base)).json(&json!({ "prompt": prompt, "client_id": client_id })).timeout(Duration::from_secs(30)).send().await.map_err(super::dispatch::short)?;
        let code = r.status().as_u16();
        let body = r.text().await.unwrap_or_default();
        if !(200..300).contains(&code) {
            return Err(prompt_error(code, &body));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("bad /prompt reply: {e}"))?;
        if v["node_errors"].as_object().is_some_and(|o| !o.is_empty()) {
            return Err(prompt_error(code, &body));
        }
        v["prompt_id"].as_str().map(str::to_string).ok_or_else(|| "no prompt_id in the /prompt reply".into())
    }

    pub async fn history(&self, prompt_id: &str) -> Result<Value, String> {
        let r = self.http.get(format!("{}/history/{prompt_id}", self.base)).timeout(Duration::from_secs(10)).send().await.map_err(super::dispatch::short)?;
        r.error_for_status().map_err(super::dispatch::short)?.json().await.map_err(super::dispatch::short)
    }

    pub async fn view(&self, f: &OutFile) -> Result<Vec<u8>, String> {
        let r = self
            .http
            .get(format!("{}/view", self.base))
            .query(&[("filename", f.filename.as_str()), ("subfolder", f.subfolder.as_str()), ("type", f.kind.as_str())])
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(super::dispatch::short)?;
        Ok(r.error_for_status().map_err(super::dispatch::short)?.bytes().await.map_err(super::dispatch::short)?.to_vec())
    }

    pub async fn interrupt(&self) {
        let _ = self.http.post(format!("{}/interrupt", self.base)).json(&json!({})).timeout(Duration::from_secs(5)).send().await;
    }

    pub async fn free(&self) {
        let _ = self.http.post(format!("{}/free", self.base)).json(&json!({ "unload_models": true, "free_memory": true })).timeout(Duration::from_secs(10)).send().await;
    }
}

/// A safe file name from ComfyUI (no folders, no `..`).
pub fn safe_name(name: &str) -> Option<String> {
    let n = Path::new(name).file_name()?.to_str()?.to_string();
    (!n.is_empty() && n != "." && n != "..").then_some(n)
}

/// Provenance from the params and the filled API graph (KSampler / checkpoint / latent nodes).
pub fn gen_meta_from(template: &str, params: &Value, workflow: &Value) -> GenMeta {
    let mut g = GenMeta { template: template.into(), prompt: params["prompt"].as_str().unwrap_or("").into(), negative: params["negative"].as_str().unwrap_or("").into(), ..Default::default() };
    for node in workflow.as_object().into_iter().flat_map(|o| o.values()) {
        let i = &node["inputs"];
        let class = node["class_type"].as_str().unwrap_or("");
        if class == "KSamplerSelect" {
            g.sampler = i["sampler_name"].as_str().unwrap_or("").into();
        } else if class.starts_with("KSampler") || class.starts_with("SamplerCustom") {
            g.seed = i["seed"].as_u64().or(i["noise_seed"].as_u64()).unwrap_or(g.seed);
            g.steps = i["steps"].as_u64().map(|v| v as u32).unwrap_or(g.steps);
            g.cfg = i["cfg"].as_f64().unwrap_or(g.cfg);
            g.sampler = i["sampler_name"].as_str().map(str::to_string).unwrap_or(g.sampler);
            g.scheduler = i["scheduler"].as_str().map(str::to_string).unwrap_or(g.scheduler);
            g.denoise = i["denoise"].as_f64().unwrap_or(g.denoise);
        } else if class == "SDTurboScheduler" || class == "BasicScheduler" {
            g.denoise = i["denoise"].as_f64().unwrap_or(g.denoise);
            let steps = i["steps"].as_u64().unwrap_or(0) as u32;
            // SDTurboScheduler runs min(steps, floor(10·denoise)) (comfy_templates `effective_steps`).
            g.steps = if class == "SDTurboScheduler" { steps.min((g.denoise * 10.0 + 1e-9).floor() as u32) } else { steps };
            g.scheduler = i["scheduler"].as_str().unwrap_or(if class == "SDTurboScheduler" { "sd_turbo" } else { "" }).into();
        } else if class.starts_with("CheckpointLoader") {
            g.checkpoint = i["ckpt_name"].as_str().unwrap_or("").into();
        } else if (class.starts_with("Empty") && class.contains("Latent")) || class == "ImageScale" {
            // txt2img sizes the latent; style-transfer sizes its input with ImageScale.
            g.width = i["width"].as_u64().map(|v| v as u32).unwrap_or(g.width);
            g.height = i["height"].as_u64().map(|v| v as u32).unwrap_or(g.height);
        }
    }
    if g.seed == 0 {
        g.seed = params["seed"].as_u64().unwrap_or(0);
    }
    if g.width == 0 {
        g.width = params["width"].as_u64().unwrap_or(0) as u32;
        g.height = params["height"].as_u64().unwrap_or(0) as u32;
    }
    g
}

/// Width × height from a PNG's IHDR (upscale has no size node: read the output itself).
pub fn png_size(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut b = [0u8; 24];
    std::fs::File::open(path).ok()?.read_exact(&mut b).ok()?;
    if b[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] || &b[12..16] != b"IHDR" {
        return None;
    }
    let (w, h) = (u32::from_be_bytes([b[16], b[17], b[18], b[19]]), u32::from_be_bytes([b[20], b[21], b[22], b[23]]));
    (w > 0 && h > 0).then_some((w, h))
}

/// Default aspect for a job whose params give neither an aspect nor a size: the project's output
/// aspect, else 16:9 for `thumbnail-bg` (its layout needs the wide frame). Others keep 1:1.
pub fn with_default_aspect(mut params: Value, template: &str, project_aspect: Option<&str>) -> Value {
    if !params.is_object() || params.get("aspect").is_some_and(|a| !a.is_null()) || params["width"].as_u64().unwrap_or(0) > 0 || params["height"].as_u64().unwrap_or(0) > 0 {
        return params;
    }
    let fallback = (template == "thumbnail-bg").then_some("16:9");
    if let Some(a) = project_aspect.filter(|a| templates::ASPECTS.contains(a)).or(fallback) {
        params["aspect"] = json!(a);
    }
    params
}

/// The enqueue-time dry run of `fill`: placeholder slug / job id, and an absolute input still
/// replaced by `<id>/<name>` (its real extension kept) so the name rules still apply. Err: the job
/// could never render, so it is refused now rather than after Tony was unloaded.
pub fn dry_run_fill(t: &dyn TemplatesApi, template: &str, params: &Value) -> Result<(), String> {
    let mut p = if params.is_object() { params.clone() } else { json!({}) };
    for (k, v) in [("slug", "dry-run"), ("jobId", "cj0")] {
        if p[k].as_str().is_none_or(str::is_empty) {
            p[k] = json!(v);
        }
    }
    if let Some(src) = p["inputImage"].as_str().or(p["input_image"].as_str()).map(str::to_string) {
        if Path::new(&src).is_absolute() {
            if !Path::new(&src).is_file() {
                return Err(format!("input image {src} is not a file"));
            }
            let name = safe_name(&src).ok_or("bad input image name")?;
            let id = p["jobId"].as_str().unwrap_or("cj0").to_string();
            if let Some(o) = p.as_object_mut() {
                o.remove("input_image");
            }
            p["inputImage"] = json!(format!("{id}/{name}"));
        }
    }
    t.fill(template, &p).map(|_| ())
}

// ── Crash marker ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CrashMarker {
    pub started_at: u64,
    /// The ComfyUI we started (None until it was spawned).
    pub pid: Option<u32>,
    pub python: String,
    pub jobs: Vec<String>,
    /// LLM keys loaded before the batch unloaded them.
    pub snapshot: Vec<String>,
}

pub fn read_marker(path: &Path) -> Option<CrashMarker> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub fn write_marker_file(path: &Path, m: &CrashMarker) -> Result<(), String> {
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    super::staging::atomic_write(path, &serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?)
}

/// Is a live process the ComfyUI the marker says we started? Its exe must be our python and it
/// must have started after the marker was written (a reused PID is older or another program).
pub fn is_our_comfy(exe: Option<&Path>, start_secs: u64, m: &CrashMarker) -> bool {
    let Some(exe) = exe else { return false };
    !m.python.is_empty() && exe.to_string_lossy().eq_ignore_ascii_case(&m.python) && start_secs.saturating_mul(1000) + 5_000 >= m.started_at
}

// ── The batch ───────────────────────────────────────────────────────────────

/// Everything a batch does to the outside world (live: `LiveIo`; tests: a fake that fails at any step).
pub trait BatchIo: Send + Sync {
    fn snapshot_loaded(&self) -> impl Future<Output = Result<Vec<Inst>, String>> + Send;
    fn unload_all(&self) -> impl Future<Output = Result<Vec<Inst>, String>> + Send;
    fn restore_tony(&self) -> impl Future<Output = Restore> + Send;
    fn verify_only_tony(&self) -> impl Future<Output = Restore> + Send;
    fn vram(&self) -> VramFn;
    /// The cheap checks that would make `comfy_start` fail, run BEFORE the marker and the unload
    /// (port 8188 free, ComfyUI's python present), so a doomed batch never costs Tony a reload.
    fn preflight(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// Start ComfyUI headless and wait for /system_stats → (pid, comfyui version).
    fn comfy_start(&self) -> impl Future<Output = Result<(Option<u32>, String), String>> + Send;
    /// Kill the ComfyUI we started (tree), if any.
    fn comfy_stop(&self) -> impl Future<Output = ()> + Send;
    fn free(&self) -> impl Future<Output = ()> + Send;
    fn interrupt(&self) -> impl Future<Output = ()> + Send;
    fn submit(&self, prompt: &Value, client_id: &str) -> impl Future<Output = Result<String, String>> + Send;
    fn history(&self, prompt_id: &str) -> impl Future<Output = Result<Value, String>> + Send;
    fn download(&self, f: &OutFile, dest: &Path) -> impl Future<Output = Result<u64, String>> + Send;
    fn write_marker(&self, m: &CrashMarker) -> Result<(), String>;
    fn read_marker(&self) -> Option<CrashMarker>;
    fn clear_marker(&self);
    /// Is `pid` (from the marker) a ComfyUI we started that is still running?
    fn leftover_is_ours(&self, m: &CrashMarker, pid: u32) -> bool;
    fn kill_pid(&self, pid: u32);
    /// Some(reason): Tony wants the GPU back.
    fn preempt(&self, since: u64) -> Option<String>;
    fn heartbeat(&self, label: &str) -> Task<u32>;
    fn gen_dir(&self, slug: &str, job_id: &str) -> Result<PathBuf, String>;
    /// Hand a downloaded file to media.rs (asset id when it was ingested).
    /// Off the async runtime (the first ingest hashes the ~6.9 GB checkpoint).
    fn ingest(&self, slug: &str, file: &Path, meta: &GenMeta) -> impl Future<Output = Option<String>> + Send;
    fn emit_queue(&self, job: &Job);
    fn emit_service(&self, v: Value);
    fn models_root(&self) -> Vec<String>;
    /// ComfyUI's input dir (`--input-directory`).
    fn input_dir(&self) -> PathBuf;
}

#[derive(Clone, Debug)]
pub struct RunCfg {
    pub poll_every: Duration,
    pub jit_every: Duration,
    pub job_timeout: Duration,
    pub vram_every: Duration,
    /// How long to wait for VRAM to drop after the unload (gpu_now is up to 6 s stale).
    pub vram_settle: Duration,
    /// Used VRAM must fall to this (12 GB card: whisper ~1.2 GB + desktop leaves room for SDXL).
    pub vram_max_used_mb: u64,
    pub tony_priority_pct: u8,
    /// No new job starts once the batch is this old (`BATCH_WALL`).
    pub batch_wall: Duration,
}

impl RunCfg {
    pub fn live(tony_priority_pct: u8) -> Self {
        RunCfg { poll_every: Duration::from_secs(1), jit_every: Duration::from_secs(5), job_timeout: Duration::from_secs(600), vram_every: model_swap::VRAM_EVERY, vram_settle: Duration::from_secs(20), vram_max_used_mb: 5_500, tony_priority_pct, batch_wall: BATCH_WALL }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub kind: &'static str,
    pub label: String,
    pub started_at: u64,
    pub finished_at: u64,
    pub jobs: Vec<String>,
    pub done: Vec<String>,
    pub failed: Vec<String>,
    pub requeued: Vec<String>,
    pub cancelled: Vec<String>,
    /// Back to waiting: a model file vanished after admission.
    pub waiting: Vec<String>,
    pub preempted: Option<String>,
    /// The batch released the slot before touching anything (Tony came back while it waited).
    pub deferred: Option<String>,
    pub error: Option<String>,
    pub snapshot: Vec<String>,
    pub vram_after_unload_mb: Option<u64>,
    /// Used VRAM once ComfyUI was stopped, before Qwen reloads.
    pub vram_after_stop_mb: Option<u64>,
    pub comfyui_version: Option<String>,
    pub restore: Option<Restore>,
    pub lease_beats: u32,
    pub steps: Vec<String>,
}

/// What a batch has touched so far (drives the restore path).
#[derive(Default)]
struct Touched {
    /// The LLM unload was attempted.
    llm: bool,
    /// ComfyUI start was attempted.
    comfy: bool,
}

enum JobEnd {
    Done,
    Failed,
    Cancelled,
    /// A model vanished since admission: back to waiting (not cancelled, not failed).
    Waiting,
    /// No longer queued when the batch reached it (nothing recorded).
    Skipped,
    /// The render timed out: this job failed, the rest go back to queued and the batch ends
    /// (the next job would queue behind the hung prompt).
    Timeout,
    /// Tony wants the GPU: this and the remaining jobs go back to queued.
    Preempted(String),
    /// An LLM was JIT-loaded mid-render: this job failed, the rest go back to queued.
    Jit,
}

/// The whole batch inside one maintenance slot. Restore ALWAYS runs once anything was touched.
pub async fn run_batch<I: BatchIo>(io: &I, store: &Store, t: &dyn TemplatesApi, slot: &GpuSlot, cfg: &RunCfg, ctl: &Control) -> BatchReport {
    let roots = io.models_root();
    let mut ids = store.runnable(&|tpl| missing_models(&roots, &t.required_models(tpl)));
    let mut invalid = vec![];
    // Every job is filled once (dry run) before anything is touched: one that can never render
    // fails here, not after Tony was unloaded and ComfyUI booted.
    ids.retain(|id| {
        let Some(job) = store.job(id) else { return false };
        match dry_run_fill(t, &job.template, &job_params(&job)) {
            Ok(()) => true,
            Err(e) => {
                finish(io, store, id, |j| {
                    j.status = JobStatus::Failed;
                    j.error = Some(format!("template: {e}"));
                });
                invalid.push(id.clone());
                false
            }
        }
    });
    let label = format!("{SLOT_PREFIX} · {} job(s)", ids.len());
    let mut rep = BatchReport { kind: "comfy-batch", label: label.clone(), started_at: now_ms(), jobs: ids.clone(), failed: invalid, ..Default::default() };
    if ids.is_empty() {
        rep.deferred = Some("nothing runnable".into());
        rep.finished_at = now_ms();
        return rep;
    }
    let asked = now_ms();
    ctl.phase("waiting for the GPU slot");
    io.emit_service(json!({ "phase": "waiting for the GPU slot", "label": label }));
    let guard = slot.acquire_maintenance(&label, cfg.tony_priority_pct).await;
    let hb = io.heartbeat(&label);
    // Tony came back while we waited: nothing was touched yet, so just let go.
    if let Some(why) = io.preempt(asked) {
        rep.deferred = Some(why);
        rep.lease_beats = hb.stop().await.unwrap_or(0);
        drop(guard);
        ctl.phase("");
        rep.finished_at = now_ms();
        io.emit_service(json!({ "phase": "idle", "deferred": rep.deferred }));
        return rep;
    }
    let since = now_ms();
    let mut touched = Touched::default();
    if let Err(e) = batch_steps(io, store, t, cfg, ctl, &ids, since, &mut rep, &mut touched).await {
        rep.steps.push(format!("error: {e}"));
        rep.error = Some(e);
    }
    // ── Restore: always. ComfyUI is freed and stopped BEFORE Qwen reloads (hybrid overflow).
    ctl.phase("putting Tony back");
    io.emit_service(json!({ "phase": "putting Tony back", "label": label }));
    if touched.comfy {
        io.free().await;
        io.comfy_stop().await;
        rep.steps.push("comfyui freed and stopped".into());
        // Confirm ComfyUI's VRAM is back BEFORE Qwen reloads (hybrid overflows at ≥ 90%). Tony
        // is put back either way; a reading still high is recorded.
        let (used, settled) = wait_vram(&io.vram(), cfg).await;
        rep.vram_after_stop_mb = used;
        rep.steps.push(match (used, settled) {
            (None, _) => "no VRAM reading after the stop; not confirmed".into(),
            (Some(u), true) => format!("VRAM {u} MiB after the stop"),
            (Some(u), false) => format!("VRAM still {u} MiB after the stop (wanted ≤ {} MiB); reloading Tony anyway", cfg.vram_max_used_mb),
        });
    }
    // Nothing of this batch may stay `running`.
    let stuck: Vec<String> = ids.iter().filter(|id| store.job(id).is_some_and(|j| j.status == JobStatus::Running)).cloned().collect();
    for id in stuck {
        if let Some(j) = store.set(&id, |j| {
            j.status = JobStatus::Queued;
            j.started_at = None;
        }) {
            rep.requeued.push(id.clone());
            io.emit_queue(&j);
        }
    }
    // Nothing was unloaded (the marker or the snapshot failed): only check Tony, don't reload him.
    let restore = if touched.llm { io.restore_tony().await } else { io.verify_only_tony().await };
    rep.steps.push(format!("{} ok={}", if touched.llm { "restore" } else { "verify" }, restore.ok));
    if restore.ok {
        io.clear_marker();
    }
    rep.restore = Some(restore);
    rep.lease_beats = hb.stop().await.unwrap_or(0);
    drop(guard);
    lk(&ctl.cancel).retain(|id| !ids.contains(id));
    ctl.phase("");
    rep.finished_at = now_ms();
    io.emit_service(json!({ "phase": "idle", "batch": { "done": rep.done.len(), "failed": rep.failed.len(), "requeued": rep.requeued.len(), "error": rep.error, "restoreOk": rep.restore.as_ref().map(|r| r.ok) } }));
    rep
}

#[allow(clippy::too_many_arguments)]
async fn batch_steps<I: BatchIo>(io: &I, store: &Store, t: &dyn TemplatesApi, cfg: &RunCfg, ctl: &Control, ids: &[String], since: u64, rep: &mut BatchReport, touched: &mut Touched) -> Result<(), String> {
    // Cheap checks first: nothing is touched when ComfyUI couldn't start anyway.
    io.preflight().await.map_err(|e| format!("preflight: {e}"))?;
    // The marker goes down BEFORE the unload, so a crash after it still puts Tony back.
    let mut marker = CrashMarker { started_at: now_ms(), pid: None, python: String::new(), jobs: ids.to_vec(), snapshot: vec![] };
    io.write_marker(&marker).map_err(|e| format!("crash marker not written: {e}"))?;
    ctl.phase("unloading LLMs");
    let snap = io.snapshot_loaded().await.map_err(|e| format!("LM Studio snapshot failed: {e}"))?;
    rep.snapshot = snap.iter().map(|i| i.key.clone()).collect();
    marker.snapshot = rep.snapshot.clone();
    let _ = io.write_marker(&marker);
    // Would the unload even leave room? Another app holding VRAM fails here, before Tony goes.
    let vram = io.vram();
    if let Some(est) = vram_estimate_after_unload(read_vram(&vram).await, &snap) {
        if est > cfg.vram_max_used_mb {
            return Err(format!("VRAM would still be ~{est} MiB after unloading the LLMs (needs ≤ {} MiB); another app holds the GPU", cfg.vram_max_used_mb));
        }
    }
    touched.llm = true;
    io.unload_all().await.map_err(|e| format!("unload failed: {e}"))?;
    rep.steps.push(format!("unloaded {} LLM(s)", snap.len()));
    // Confirm the VRAM actually came back (no reading: no nvidia-smi; carry on, noted).
    let (used, settled) = wait_vram(&vram, cfg).await;
    rep.vram_after_unload_mb = used;
    match (used, settled) {
        (None, _) => rep.steps.push("no VRAM reading; not confirmed".into()),
        (Some(u), false) => return Err(format!("VRAM still at {u} MiB after unloading the LLMs (needs ≤ {} MiB)", cfg.vram_max_used_mb)),
        _ => {}
    }
    ctl.phase("starting ComfyUI");
    io.emit_service(json!({ "phase": "starting ComfyUI" }));
    touched.comfy = true;
    let (pid, version) = io.comfy_start().await?;
    marker.pid = pid;
    marker.python = ComfyPaths::live().python.to_string_lossy().to_string();
    let _ = io.write_marker(&marker);
    rep.comfyui_version = Some(version.clone());
    rep.steps.push(format!("comfyui up (pid {pid:?}, {version})"));
    io.emit_service(json!({ "phase": "rendering", "up": true, "version": version }));
    let client_id = format!("cc-{since}");
    let started = Instant::now();
    for (n, id) in ids.iter().enumerate() {
        if let Some(why) = io.preempt(since) {
            io.interrupt().await;
            requeue(io, store, &ids[n..], rep);
            rep.preempted = Some(why);
            break;
        }
        if n > 0 && started.elapsed() >= cfg.batch_wall {
            rep.steps.push(format!("batch wall cap ({} min) reached; the rest wait for the next batch", cfg.batch_wall.as_secs() / 60));
            requeue(io, store, &ids[n..], rep);
            break;
        }
        let Some(job) = store.job(id).filter(|j| j.status == JobStatus::Queued) else { continue };
        if ctl.cancelled(id) {
            if let Some(j) = store.set(id, |j| {
                j.status = JobStatus::Cancelled;
                j.finished_at = Some(now_ms());
            }) {
                io.emit_queue(&j);
            }
            rep.cancelled.push(id.clone());
            continue;
        }
        ctl.phase(format!("rendering {} ({}/{})", job.template, n + 1, ids.len()));
        match run_job(io, store, t, cfg, ctl, &job, &client_id, since, &version).await {
            JobEnd::Done => rep.done.push(id.clone()),
            JobEnd::Failed => rep.failed.push(id.clone()),
            JobEnd::Cancelled => rep.cancelled.push(id.clone()),
            JobEnd::Waiting => rep.waiting.push(id.clone()),
            JobEnd::Skipped => {}
            JobEnd::Timeout => {
                rep.failed.push(id.clone());
                requeue(io, store, &ids[n + 1..], rep);
                rep.error = Some(format!("a render timed out after {} s; ComfyUI may be hung", cfg.job_timeout.as_secs()));
                break;
            }
            JobEnd::Preempted(why) => {
                requeue(io, store, &ids[n..], rep);
                rep.preempted = Some(why);
                break;
            }
            JobEnd::Jit => {
                rep.failed.push(id.clone());
                requeue(io, store, &ids[n + 1..], rep);
                rep.error = Some(JIT_ERROR.into());
                break;
            }
        }
    }
    Ok(())
}

async fn read_vram(vram: &VramFn) -> Option<u64> {
    let f = vram.clone();
    tauri::async_runtime::spawn_blocking(move || f()).await.ok().flatten()
}

/// Wait up to `vram_settle` for used VRAM ≤ `vram_max_used_mb` → (last reading, reached).
async fn wait_vram(vram: &VramFn, cfg: &RunCfg) -> (Option<u64>, bool) {
    let deadline = Instant::now() + cfg.vram_settle;
    loop {
        match read_vram(vram).await {
            None => return (None, false),
            Some(u) if u <= cfg.vram_max_used_mb => return (Some(u), true),
            Some(u) if Instant::now() >= deadline => return (Some(u), false),
            Some(_) => tokio::time::sleep(Duration::from_millis(500).min(cfg.vram_settle)).await,
        }
    }
}

/// Used VRAM once the loaded LLMs are gone, estimated before unloading anything: nothing loaded →
/// the reading itself; one LLM (Tony) → minus his ~10.7 GB. None (don't guess): no reading, or
/// several LLMs of unknown size (the post-unload check still applies).
pub fn vram_estimate_after_unload(used: Option<u64>, loaded: &[Inst]) -> Option<u64> {
    let used = used?;
    match loaded.len() {
        0 => Some(used),
        1 => Some(used.saturating_sub(TONY_VRAM_EST_MB)),
        _ => None,
    }
}

/// Running or queued jobs among `ids` back to queued (preempt / JIT).
fn requeue<I: BatchIo>(io: &I, store: &Store, ids: &[String], rep: &mut BatchReport) {
    for id in ids {
        let Some(j) = store.job(id) else { continue };
        if !matches!(j.status, JobStatus::Running | JobStatus::Queued) {
            continue;
        }
        if let Some(j) = store.set(id, |j| {
            j.status = JobStatus::Queued;
            j.started_at = None;
            j.prompt_id = None;
        }) {
            io.emit_queue(&j);
        }
        rep.requeued.push(id.clone());
    }
}

fn finish<I: BatchIo>(io: &I, store: &Store, id: &str, f: impl FnOnce(&mut Job)) {
    if let Some(j) = store.set(id, |j| {
        f(j);
        j.finished_at = Some(now_ms());
    }) {
        io.emit_queue(&j);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_job<I: BatchIo>(io: &I, store: &Store, t: &dyn TemplatesApi, cfg: &RunCfg, ctl: &Control, job: &Job, client_id: &str, since: u64, version: &str) -> JobEnd {
    let fail = |e: String| {
        finish(io, store, &job.id, |j| {
            j.status = JobStatus::Failed;
            j.error = Some(e);
        });
        JobEnd::Failed
    };
    let roots = io.models_root();
    let missing = missing_models(&roots, &t.required_models(&job.template));
    if !missing.is_empty() {
        // A model vanished since admission: back to waiting, not a failure.
        if let Some(j) = store.set(&job.id, |j| {
            j.status = JobStatus::Waiting;
            j.error = Some(needs_text(&missing));
        }) {
            io.emit_queue(&j);
        }
        return JobEnd::Waiting;
    }
    // Queued → Running atomically: a cancel that landed while the model probe ran wins.
    match store.start_running(&job.id) {
        Some(j) => io.emit_queue(&j),
        None if store.job(&job.id).is_some_and(|j| j.status == JobStatus::Cancelled) => return JobEnd::Cancelled,
        None => return JobEnd::Skipped,
    }
    let params = match stage_input(&job_params(job), &io.input_dir(), &job.id) {
        Ok(p) => p,
        Err(e) => return fail(format!("input image: {e}")),
    };
    let workflow = match t.fill(&job.template, &params) {
        Ok(w) => w,
        Err(e) => return fail(format!("template: {e}")),
    };
    let sampler = model_swap::vram_sampler(io.vram(), cfg.vram_every);
    let t0 = Instant::now();
    let prompt_id = match io.submit(&workflow, client_id).await {
        Ok(p) => p,
        Err(e) => {
            sampler.stop().await;
            return fail(e);
        }
    };
    store.set(&job.id, |j| j.prompt_id = Some(prompt_id.clone()));
    let mut last_jit = Instant::now();
    let mut errors = 0u32;
    let files = loop {
        tokio::time::sleep(cfg.poll_every).await;
        if t0.elapsed() > cfg.job_timeout {
            io.interrupt().await;
            sampler.stop().await;
            fail(format!("timed out after {} s", cfg.job_timeout.as_secs()));
            return JobEnd::Timeout;
        }
        if ctl.cancelled(&job.id) {
            io.interrupt().await;
            sampler.stop().await;
            finish(io, store, &job.id, |j| j.status = JobStatus::Cancelled);
            return JobEnd::Cancelled;
        }
        if let Some(why) = io.preempt(since) {
            io.interrupt().await;
            sampler.stop().await;
            return JobEnd::Preempted(why);
        }
        if last_jit.elapsed() >= cfg.jit_every {
            last_jit = Instant::now();
            if let Ok(l) = io.snapshot_loaded().await {
                if !l.is_empty() {
                    io.interrupt().await;
                    sampler.stop().await;
                    fail(format!("{JIT_ERROR} ({})", l.iter().map(|i| i.key.as_str()).collect::<Vec<_>>().join(", ")));
                    return JobEnd::Jit;
                }
            }
        }
        match io.history(&prompt_id).await.map(|h| parse_history(&prompt_id, &h)) {
            Ok(HistoryState::Pending) => errors = 0,
            Ok(HistoryState::Error(e)) => {
                sampler.stop().await;
                return fail(e);
            }
            Ok(HistoryState::Done(files)) => break files,
            Err(e) => {
                errors += 1;
                if errors >= 5 {
                    sampler.stop().await;
                    return fail(format!("ComfyUI stopped answering: {e}"));
                }
            }
        }
    };
    let render_ms = t0.elapsed().as_millis() as u64;
    let peak = sampler.stop().await;
    let dir = match io.gen_dir(&job.slug, &job.id) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("workflow.json"), serde_json::to_vec_pretty(&workflow).unwrap_or_default());
    let mut base = gen_meta_from(&job.template, &params, &workflow);
    base.comfyui_version = version.into();
    base.comfy_job_id = job.id.clone();
    base.prompt_id = prompt_id.clone();
    base.render_ms = render_ms;
    base.peak_vram_mb = peak;
    base.created_at = chrono::Local::now().to_rfc3339();
    base.checkpoint_path = (!base.checkpoint.is_empty()).then(|| find_model(&roots, &format!("checkpoints/{}", base.checkpoint))).flatten().map(|p| p.to_string_lossy().to_string());
    let only = t.output_nodes(&job.template);
    let mut outputs = vec![];
    for f in files.iter().filter(|f| only.is_empty() || only.contains(&f.node)) {
        let Some(name) = safe_name(&f.filename) else { continue };
        let dest = dir.join(&name);
        if let Err(e) = io.download(f, &dest).await {
            return fail(format!("download {name}: {e}"));
        }
        // media.rs gets the full record (with the workflow); the queue copy drops the graph.
        let mut meta = base.clone();
        // upscale has no size node (and a failed parse leaves 0): the file itself says.
        if meta.width == 0 || meta.height == 0 {
            if let Some((w, h)) = png_size(&dest) {
                (meta.width, meta.height) = (w, h);
            }
        }
        let mut full = meta.clone();
        full.workflow = workflow.clone();
        let asset_id = io.ingest(&job.slug, &dest, &full).await;
        outputs.push(JobOutput { path: dest.to_string_lossy().to_string(), filename: name, kind: f.media.clone(), asset_id, gen: meta });
    }
    if outputs.is_empty() {
        return fail("ComfyUI finished without an output file".into());
    }
    finish(io, store, &job.id, |j| {
        j.status = JobStatus::Done;
        j.outputs = outputs;
        j.render_ms = Some(render_ms);
        j.peak_vram_mb = peak;
    });
    JobEnd::Done
}

/// App start with a leftover marker: stop the ComfyUI we started (never another one), then make
/// sure Tony is the one loaded LLM at production settings. None: no marker.
pub async fn recover_from_marker<I: BatchIo>(io: &I, slot: &GpuSlot, tony_priority_pct: u8) -> Option<Value> {
    let m = io.read_marker()?;
    let guard = slot.acquire_maintenance(&format!("{SLOT_PREFIX} · crash recovery"), tony_priority_pct).await;
    let mut notes = vec![];
    match m.pid {
        Some(pid) if io.leftover_is_ours(&m, pid) => {
            io.kill_pid(pid);
            notes.push(format!("stopped the leftover ComfyUI (pid {pid})"));
        }
        Some(pid) => notes.push(format!("pid {pid} is gone or not our ComfyUI; left alone")),
        None => notes.push("ComfyUI was never started".into()),
    }
    let restore = io.verify_only_tony().await;
    if restore.ok {
        io.clear_marker();
    }
    drop(guard);
    Some(json!({ "kind": "comfy-recovery", "marker": m, "notes": notes, "restore": restore }))
}

// ── Live wiring ─────────────────────────────────────────────────────────────

struct ComfyProc {
    child: std::process::Child,
    job: Option<crate::proc::Job>,
}

/// Spawn the headless ComfyUI (kill-on-close Job Object, CREATE_NO_WINDOW, output to
/// `<hub>/logs/comfyui.log`) and wait for `/system_stats` (120 s). Refuses when 8188 already
/// answers (a ComfyUI this app didn't start is never used or touched).
/// The preflight (also re-run by the start itself): 8188 must not answer, python must exist.
async fn comfy_preflight_live(paths: &ComfyPaths, http: &ComfyHttp) -> Result<(), String> {
    if !paths.python.is_file() {
        return Err(format!("ComfyUI python not found at {}", paths.python.display()));
    }
    if http.system_stats(Duration::from_millis(1500)).await.is_ok() {
        return Err(format!("port {COMFY_PORT} already answers: a ComfyUI this app didn't start; not touching it"));
    }
    Ok(())
}

async fn comfy_start_live(paths: &ComfyPaths, http: &ComfyHttp, roots: &[String], timeout: Duration) -> Result<(ComfyProc, String), String> {
    comfy_preflight_live(paths, http).await?;
    prepare_dirs(paths, roots)?;
    let log = std::fs::File::create(paths.log()).map_err(|e| format!("log {}: {e}", paths.log().display()))?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&paths.python);
    cmd.args(command_args(paths)).current_dir(paths.comfy_dir.parent().unwrap_or(&paths.comfy_dir)).stdin(std::process::Stdio::null()).stdout(log).stderr(log2);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let (child, job) = crate::proc::spawn_in_job(&mut cmd, CREATE_NO_WINDOW).map_err(|e| format!("could not start ComfyUI: {e}"))?;
    let mut p = ComfyProc { child, job };
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(st)) = p.child.try_wait() {
            return Err(format!("ComfyUI exited ({st}) before answering; see {}", paths.log().display()));
        }
        if let Ok(v) = http.system_stats(Duration::from_secs(2)).await {
            let version = v["system"]["comfyui_version"].as_str().unwrap_or("unknown").to_string();
            return Ok((p, version));
        }
        if Instant::now() >= deadline {
            kill_proc(&mut p);
            return Err(format!("ComfyUI didn't answer /system_stats within {} s; see {}", timeout.as_secs(), paths.log().display()));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn kill_proc(p: &mut ComfyProc) {
    match &p.job {
        Some(j) => j.kill(),
        None => crate::proc::kill_tree(p.child.id()),
    }
    for _ in 0..30 {
        if matches!(p.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Wait for the exit after the hard kill too (TerminateProcess returns at once), so the
    // caller's VRAM check sees ComfyUI gone, not mid-teardown.
    let _ = p.child.kill();
    let _ = p.child.wait();
}

/// `comfy_stop`: POST /free, then kill the tree — only when it is the ComfyUI WE started. A
/// refused start (8188 already answered: someone else's ComfyUI) leaves `proc_` empty, and that
/// instance is never sent /free.
async fn comfy_stop_live(http: &ComfyHttp, proc_: &Mutex<Option<ComfyProc>>) {
    let p = lk(proc_).take();
    if let Some(mut p) = p {
        http.free().await;
        let _ = tauri::async_runtime::spawn_blocking(move || kill_proc(&mut p)).await;
    }
}

struct Runtime {
    store: Store,
    ctl: Control,
    wake: tokio::sync::Notify,
    run_now: AtomicBool,
    running: AtomicBool,
    marker: PathBuf,
    paths: ComfyPaths,
    admission: Mutex<String>,
    last_batch: Mutex<Option<Value>>,
    /// App start (boot grace).
    boot_ms: u64,
    /// Batch-level failures in a row and when the backoff ends.
    backoff: Mutex<(u32, u64)>,
    /// Crash-marker recovery attempts this session and when the last one ran.
    recovery: Mutex<(u32, u64)>,
    /// Checkpoints whose SHA-256 was warmed into media.db this session.
    hashed: Mutex<HashSet<PathBuf>>,
}

static RT: OnceLock<Arc<Runtime>> = OnceLock::new();

fn rt() -> Result<&'static Arc<Runtime>, String> {
    RT.get().ok_or_else(|| "ComfyUI queue not initialised".into())
}

struct LiveIo {
    app: tauri::AppHandle,
    rt: Arc<Runtime>,
    lm: Result<model_swap::Lm, String>,
    comfy: ComfyHttp,
    proc_: Mutex<Option<ComfyProc>>,
}

impl LiveIo {
    fn new(app: &tauri::AppHandle, rt: Arc<Runtime>) -> Self {
        use tauri::Manager;
        let st = app.state::<super::dispatch::DispatchState>();
        LiveIo { app: app.clone(), rt, lm: model_swap::Lm::from_dispatch(&st), comfy: ComfyHttp::local(st.http.clone()), proc_: Mutex::default() }
    }
    fn lm(&self) -> Result<&model_swap::Lm, String> {
        self.lm.as_ref().map_err(|e| e.clone())
    }
}

fn no_lm(e: String) -> Restore {
    Restore { ok: false, notes: vec![e], ..Default::default() }
}

impl BatchIo for LiveIo {
    async fn snapshot_loaded(&self) -> Result<Vec<Inst>, String> {
        self.lm()?.snapshot_loaded().await
    }
    async fn unload_all(&self) -> Result<Vec<Inst>, String> {
        self.lm()?.unload_all().await
    }
    async fn restore_tony(&self) -> Restore {
        match self.lm() {
            Ok(l) => l.restore_tony().await,
            Err(e) => no_lm(e),
        }
    }
    async fn verify_only_tony(&self) -> Restore {
        match self.lm() {
            Ok(l) => l.verify_only_tony().await,
            Err(e) => no_lm(e),
        }
    }
    fn vram(&self) -> VramFn {
        model_swap::live_vram()
    }
    async fn preflight(&self) -> Result<(), String> {
        comfy_preflight_live(&self.rt.paths, &self.comfy).await
    }
    async fn comfy_start(&self) -> Result<(Option<u32>, String), String> {
        let roots = self.rt.store.snapshot().settings.model_roots;
        let (p, version) = comfy_start_live(&self.rt.paths, &self.comfy, &roots, Duration::from_secs(120)).await?;
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
        self.comfy.submit(prompt, client_id).await
    }
    async fn history(&self, prompt_id: &str) -> Result<Value, String> {
        self.comfy.history(prompt_id).await
    }
    async fn download(&self, f: &OutFile, dest: &Path) -> Result<u64, String> {
        let bytes = self.comfy.view(f).await?;
        super::staging::atomic_write(dest, &bytes)?;
        Ok(bytes.len() as u64)
    }
    fn write_marker(&self, m: &CrashMarker) -> Result<(), String> {
        write_marker_file(&self.rt.marker, m)
    }
    fn read_marker(&self) -> Option<CrashMarker> {
        read_marker(&self.rt.marker)
    }
    fn clear_marker(&self) {
        let _ = std::fs::remove_file(&self.rt.marker);
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
    fn preempt(&self, since: u64) -> Option<String> {
        use tauri::Manager;
        let v = self.app.state::<super::os_core::OsState>().slot.view();
        let last = super::compaction::LAST_INTERACTIVE_MS.load(Ordering::Relaxed);
        preempt_reason(v.queued_foreground, last, super::arbiter::get().idle_for().map(|d| d.as_millis() as u64), since, now_ms())
    }
    fn heartbeat(&self, label: &str) -> Task<u32> {
        use tauri::Manager;
        model_swap::live_lease_heartbeat(&self.app.state::<super::dispatch::DispatchState>(), &self.app.state::<super::os_core::OsState>(), label)
    }
    fn gen_dir(&self, slug: &str, job_id: &str) -> Result<PathBuf, String> {
        use tauri::Manager;
        let id = safe_name(job_id).ok_or("bad job id")?;
        Ok(super::media::project_root(&self.app.state::<super::media::MediaState>(), slug)?.join("working").join("gen").join(id))
    }
    async fn ingest(&self, slug: &str, file: &Path, meta: &GenMeta) -> Option<String> {
        use tauri::{Emitter, Manager};
        // media.rs copies it into raw/ (read-only) as a project asset with its provenance sidecar.
        // A refusal leaves the file in working/gen/<job-id>/, recorded on the job. Blocking work
        // (byte-checked copy, a first checkpoint hash) runs off the async workers.
        let (app, s, f, m) = (self.app.clone(), slug.to_string(), file.to_path_buf(), meta.clone());
        let res = tauri::async_runtime::spawn_blocking(move || super::media::ingest_generated(&app.state::<super::media::MediaState>(), &s, &f, &m)).await.unwrap_or_else(|e| Err(format!("ingest task: {e}")));
        match res {
            Ok(a) => {
                let _ = self.app.emit("comfy-asset", json!({ "slug": slug, "assetId": a.id }));
                Some(a.id)
            }
            Err(e) => {
                eprintln!("[comfy] ingest {} into {slug}: {e}", file.display());
                None
            }
        }
    }
    fn emit_queue(&self, job: &Job) {
        use tauri::Emitter;
        let _ = self.app.emit("comfy-queue", job);
    }
    fn emit_service(&self, v: Value) {
        use tauri::Emitter;
        let _ = self.app.emit("comfy-service", v);
    }
    fn models_root(&self) -> Vec<String> {
        self.rt.store.snapshot().settings.model_roots
    }
    fn input_dir(&self) -> PathBuf {
        self.rt.paths.input()
    }
}

fn local_minutes() -> u32 {
    use chrono::Timelike;
    let n = chrono::Local::now();
    n.hour() * 60 + n.minute()
}

fn missing_fn(roots: Vec<String>) -> impl Fn(&str) -> Vec<String> {
    move |tpl: &str| missing_models(&roots, &LiveTemplates.required_models(tpl))
}

fn live_signals(app: &tauri::AppHandle, r: &Runtime) -> Signals {
    use tauri::Manager;
    let q = r.store.snapshot();
    let os = app.state::<super::os_core::OsState>();
    let view = os.slot.view();
    let last = super::compaction::LAST_INTERACTIVE_MS.load(Ordering::Relaxed);
    let now = now_ms();
    let backoff = *lk(&r.backoff);
    Signals {
        runnable: r.store.runnable(&missing_fn(q.settings.model_roots.clone())).len(),
        foreground_waiting: view.queued_foreground,
        ms_since_interactive: (last > 0).then(|| now.saturating_sub(last)),
        arbiter_idle_ms: super::arbiter::get().idle_for().map(|d| d.as_millis() as u64),
        idle_wait: super::compaction::current_idle_wait(app, (QUIET_MS / 60_000) as u32, false).map(|w| w.reason()),
        away: super::arbiter::get().away() || os.slot.is_away(),
        policy: q.settings.policy,
        local_minutes: local_minutes(),
        run_now: r.run_now.load(Ordering::SeqCst),
        ms_since_boot: now.saturating_sub(r.boot_ms),
        backoff_left_ms: backoff.1.saturating_sub(now),
        failures: backoff.0,
    }
}

/// After a batch: a batch-level failure extends the backoff, a batch that rendered resets it.
fn note_outcome(r: &Runtime, rep: &BatchReport) {
    let mut b = lk(&r.backoff);
    if batch_failed(rep) {
        b.0 += 1;
        b.1 = now_ms() + backoff_ms(b.0);
        eprintln!("[comfy] batch failed ({} in a row); no admission for {} min", b.0, backoff_ms(b.0) / 60_000);
    } else if !rep.done.is_empty() {
        *b = (0, 0);
    }
}

/// Warm media.db's checkpoint hash cache in the background, outside any GPU hold, so the first
/// ingest after the weights land doesn't read ~6.9 GB while Tony is unloaded.
fn prehash_checkpoints(app: &tauri::AppHandle, r: &Runtime) {
    let roots = r.store.snapshot().settings.model_roots;
    let names: HashSet<String> = LiveTemplates.names().iter().flat_map(|n| LiveTemplates.required_models(n)).filter(|m| m.starts_with("checkpoints/")).collect();
    for name in names {
        let Some(p) = find_model(&roots, &name) else { continue };
        if !lk(&r.hashed).insert(p.clone()) {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Manager;
            if let Err(e) = super::media::checkpoint_sha256(&app.state::<super::media::MediaState>(), &p) {
                eprintln!("[comfy] checkpoint hash {}: {e}", p.display());
            }
        });
    }
}

/// Director report hook: one payload per project the batch touched.
fn report_hook(app: &tauri::AppHandle, store: &Store, rep: &BatchReport) {
    use tauri::Emitter;
    let mut slugs: Vec<String> = rep.jobs.iter().filter_map(|id| store.job(id)).map(|j| j.slug).collect();
    slugs.sort();
    slugs.dedup();
    for slug in slugs {
        let of = |ids: &[String]| ids.iter().filter(|id| store.job(id).is_some_and(|j| j.slug == slug)).count();
        let _ = app.emit("director-report", json!({ "kind": "comfy-batch", "done": of(&rep.done), "failed": of(&rep.failed), "slug": slug }));
    }
}

async fn run_once(app: &tauri::AppHandle, r: &Arc<Runtime>) {
    use tauri::Manager;
    if r.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let inner = {
        let (app, r2) = (app.clone(), r.clone());
        tauri::async_runtime::spawn(async move {
            let io = LiveIo::new(&app, r2.clone());
            let os = app.state::<super::os_core::OsState>();
            let cfg = RunCfg::live(os.snapshot().scheduler.tony_priority_pct);
            run_batch(&io, &r2.store, &LiveTemplates, &os.slot, &cfg, &r2.ctl).await
        })
    };
    let report = match inner.await {
        Ok(rep) => {
            report_hook(app, &r.store, &rep);
            note_outcome(r, &rep);
            if rep.restore.as_ref().is_some_and(|x| !x.ok) {
                // The runner loop retries the recovery in 1 min (not straight away).
                *lk(&r.recovery) = (1, now_ms());
            }
            serde_json::to_value(&rep).unwrap_or_default()
        }
        // A panic: its LiveIo (and the ComfyUI job handle) went with it; the marker drives recovery.
        Err(e) => {
            let io = LiveIo::new(app, r.clone());
            let os = app.state::<super::os_core::OsState>();
            r.store.update(recover);
            note_outcome(r, &BatchReport { error: Some("the batch crashed".into()), ..Default::default() });
            let rec = recover_from_marker(&io, &os.slot, os.snapshot().scheduler.tony_priority_pct).await;
            json!({ "kind": "comfy-batch", "error": format!("the batch crashed: {e}"), "recovery": rec })
        }
    };
    eprintln!("[comfy] batch: {}", report);
    *lk(&r.last_batch) = Some(report);
    if r.store.runnable(&missing_fn(r.store.snapshot().settings.model_roots)).is_empty() {
        r.run_now.store(false, Ordering::SeqCst);
    }
    r.ctl.phase("");
    r.running.store(false, Ordering::SeqCst);
}

async fn runner_loop(app: tauri::AppHandle, r: Arc<Runtime>) {
    use tauri::{Emitter, Manager};
    loop {
        // A crash marker (last session's, or a restore that failed this session): stop our
        // leftover ComfyUI, then verify Tony — retried after 1, 5, then every 15 min until it
        // takes, so Tony isn't left to an LM Studio JIT load at its bad defaults.
        let rc = *lk(&r.recovery);
        if !r.running.load(Ordering::SeqCst) && read_marker(&r.marker).is_some() && recovery_due(rc.0, rc.1, now_ms()) && app.state::<super::os_core::OsState>().slot.view().queued_foreground == 0 {
            *lk(&r.recovery) = (rc.0 + 1, now_ms());
            let io = LiveIo::new(&app, r.clone());
            let os = app.state::<super::os_core::OsState>();
            if let Some(v) = recover_from_marker(&io, &os.slot, os.snapshot().scheduler.tony_priority_pct).await {
                eprintln!("[comfy] crash recovery: {v}");
                if v["restore"]["ok"] == true {
                    *lk(&r.recovery) = (0, 0);
                }
                *lk(&r.last_batch) = Some(v);
            }
        }
        tokio::select! {
            _ = r.wake.notified() => {}
            _ = tokio::time::sleep(TICK) => {}
        }
        if !r.running.load(Ordering::SeqCst) {
            prehash_checkpoints(&app, &r);
        }
        let roots = r.store.snapshot().settings.model_roots;
        let mf = missing_fn(roots);
        for id in r.store.update(|q| refresh_waiting(q, &mf)) {
            if let Some(j) = r.store.job(&id) {
                let _ = app.emit("comfy-queue", &j);
            }
        }
        let sig = live_signals(&app, &r);
        // Run now applies to what is queued now, not to a job enqueued hours later.
        if sig.runnable == 0 {
            r.run_now.store(false, Ordering::SeqCst);
        }
        match admit(&sig) {
            Ok(()) => {
                *lk(&r.admission) = "running".into();
                run_once(&app, &r).await;
            }
            Err(why) => *lk(&r.admission) = why,
        }
    }
}

/// lib.rs setup (desktop): load the queue, then the runner (crash recovery first). ComfyUI itself
/// is only ever started by a batch.
pub fn init(app: &tauri::AppHandle, config_dir: &Path) {
    let r = Arc::new(Runtime {
        store: Store::open(config_dir.join("comfy-queue.json")),
        ctl: Control::default(),
        wake: tokio::sync::Notify::new(),
        run_now: AtomicBool::new(false),
        running: AtomicBool::new(false),
        marker: config_dir.join("comfy-crash.json"),
        paths: ComfyPaths::live(),
        admission: Mutex::new("not checked yet".into()),
        last_batch: Mutex::default(),
        boot_ms: now_ms(),
        backoff: Mutex::default(),
        recovery: Mutex::default(),
        hashed: Mutex::default(),
    });
    if RT.set(r.clone()).is_ok() {
        tauri::async_runtime::spawn(runner_loop(app.clone(), r));
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Service up?, the batch phase, per-template weights readiness, queue counts, settings and why
/// the runner is (not) admitting.
#[tauri::command]
pub async fn comfy_status(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri::Manager;
    let r = rt()?;
    let st = app.state::<super::dispatch::DispatchState>();
    let up = ComfyHttp::local(st.http.clone()).system_stats(Duration::from_millis(1500)).await;
    let q = r.store.snapshot();
    let roots = q.settings.model_roots.clone();
    let mut names = LiveTemplates.names();
    names.extend(q.jobs.iter().map(|j| j.template.clone()));
    names.sort();
    names.dedup();
    let templates: Vec<Value> = names
        .iter()
        .map(|n| {
            let req = LiveTemplates.required_models(n);
            let missing = missing_models(&roots, &req);
            json!({ "name": n, "requiredModels": req, "missing": missing, "ready": missing.is_empty(), "note": (!missing.is_empty()).then(|| needs_text(&missing)) })
        })
        .collect();
    let count = |s: JobStatus| q.jobs.iter().filter(|j| j.status == s).count();
    let b = *lk(&r.backoff);
    let backoff = json!({ "failures": b.0, "untilMs": (b.1 > now_ms()).then_some(b.1) });
    Ok(json!({
        "up": up.is_ok(),
        "version": up.as_ref().ok().and_then(|v| v["system"]["comfyui_version"].as_str().map(str::to_string)),
        "running": r.running.load(Ordering::SeqCst),
        "phase": lk(&r.ctl.phase).clone(),
        "admission": lk(&r.admission).clone(),
        "runNow": r.run_now.load(Ordering::SeqCst),
        "templates": templates,
        "counts": { "queued": count(JobStatus::Queued), "waiting": count(JobStatus::Waiting), "running": count(JobStatus::Running), "done": count(JobStatus::Done), "failed": count(JobStatus::Failed), "cancelled": count(JobStatus::Cancelled) },
        "settings": q.settings,
        "crashMarker": read_marker(&r.marker).is_some(),
        "lastBatch": lk(&r.last_batch).clone(),
        "backoff": backoff,
        "recoveryAttempts": lk(&r.recovery).0,
    }))
}

#[tauri::command]
pub fn comfy_enqueue(app: tauri::AppHandle, slug: String, template: String, params: Option<Value>) -> Result<Job, String> {
    use tauri::{Emitter, Manager};
    let r = rt()?;
    let root = super::media::project_root(&app.state::<super::media::MediaState>(), &slug)?;
    if !root.is_dir() {
        return Err(format!("no project {slug:?}"));
    }
    let template = template.trim().to_string();
    LiveTemplates.check(&template)?;
    let project_aspect = super::media::load_manifest_strict(&root, &slug).ok().map(|m| m.output.aspect);
    let params = with_default_aspect(with_seed(params.unwrap_or_else(|| json!({})), now_ms() ^ ((SEQ.load(Ordering::SeqCst) as u64) << 40)), &template, project_aspect.as_deref());
    // Fill once now: params that could never render are refused here, not after Tony was unloaded.
    let mut dry = params.clone();
    dry["slug"] = json!(slug);
    dry_run_fill(&LiveTemplates, &template, &dry)?;
    // An absolute input still must be a file inside this project (it is copied at render time).
    if let Some(src) = params["inputImage"].as_str().or(params["input_image"].as_str()).filter(|s| Path::new(s).is_absolute()) {
        let (f, proj) = (std::fs::canonicalize(src).map_err(|e| format!("input image {src}: {e}"))?, std::fs::canonicalize(&root).map_err(|e| e.to_string())?);
        if !f.is_file() || !f.starts_with(&proj) {
            return Err(format!("input image must be a file inside the {slug} project"));
        }
    }
    let missing = missing_models(&r.store.snapshot().settings.model_roots, &LiveTemplates.required_models(&template));
    let job = r.store.enqueue(&slug, &template, params, &missing);
    let _ = app.emit("comfy-queue", &job);
    r.wake.notify_one();
    Ok(job)
}

#[tauri::command]
pub fn comfy_cancel(app: tauri::AppHandle, id: String) -> Result<Job, String> {
    use tauri::Emitter;
    let r = rt()?;
    let j = r.store.cancel(&id, &r.ctl)?;
    let _ = app.emit("comfy-queue", &j);
    Ok(j)
}

/// Run the queue as soon as nobody is mid-conversation (skips the idle / overnight policy only).
#[tauri::command]
pub fn comfy_run_now(app: tauri::AppHandle) -> Result<Value, String> {
    let r = rt()?;
    r.run_now.store(true, Ordering::SeqCst);
    // Nic asked: the failure backoff is lifted (the boot grace and conversation checks are not).
    *lk(&r.backoff) = (0, 0);
    let sig = live_signals(&app, r);
    r.wake.notify_one();
    Ok(json!({ "accepted": true, "now": admit(&sig).err().unwrap_or_else(|| "starting".into()) }))
}

#[tauri::command]
pub fn comfy_queue_get() -> Result<QueueFile, String> {
    Ok(rt()?.store.snapshot())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub model_roots: Option<Vec<String>>,
    pub policy: Option<Policy>,
}

#[tauri::command]
pub fn comfy_settings_set(patch: SettingsPatch) -> Result<ComfySettings, String> {
    let r = rt()?;
    if let Some(roots) = &patch.model_roots {
        if roots.iter().any(|x| x.contains('\n') || x.len() > 260) {
            return Err("bad model root".into());
        }
    }
    let s = r.store.update(|q| {
        if let Some(roots) = patch.model_roots {
            q.settings.model_roots = roots.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
        }
        if let Some(p) = patch.policy {
            q.settings.policy = p;
        }
        q.settings.clone()
    });
    r.wake.notify_one();
    Ok(s)
}

/// The opt-in live smoke test (#[ignore]d, COMFY_LIVE=1): comfy_live.rs.
#[cfg(test)]
#[path = "comfy_live.rs"]
mod live;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::allm::mock::{start as serve, Req, Resp};
    use crate::commands::os_core::OsState;
    use std::sync::atomic::AtomicU64;

    const TONY: &str = "qwen/qwen3.5-9b";
    const CKPT: &str = "checkpoints/sd_xl_turbo_1.0_fp16.safetensors";
    const UPSCALER: &str = "upscale_models/4x-UltraSharp.safetensors";

    fn tmp(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("cc-comfy-{tag}-{}-{}-{}", std::process::id(), now_ms(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    struct FakeTemplates;
    impl TemplatesApi for FakeTemplates {
        fn fill(&self, template: &str, params: &Value) -> Result<Value, String> {
            if template == "bad" {
                return Err("unknown template".into());
            }
            Ok(json!({
                "3": { "class_type": "KSampler", "inputs": { "seed": params["seed"].as_u64().unwrap_or(7), "steps": 1, "cfg": 0.0, "sampler_name": "euler_ancestral", "scheduler": "normal", "denoise": 1.0 } },
                "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_turbo_1.0_fp16.safetensors" } },
                "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } },
            }))
        }
        fn required_models(&self, template: &str) -> Vec<String> {
            match template {
                "upscale" => vec![CKPT.into(), UPSCALER.into()],
                _ => vec![CKPT.into()],
            }
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Step {
        None,
        Preflight,
        Marker,
        Snapshot,
        Unload,
        Vram,
        Start,
        Submit,
        History,
        Download,
    }

    struct FakeIo {
        dir: PathBuf,
        marker: PathBuf,
        fail: Step,
        calls: Mutex<Vec<String>>,
        loaded: Mutex<Vec<Inst>>,
        vram: Arc<AtomicU64>,
        history_calls: AtomicU64,
        submits: AtomicU64,
        /// /history answers "pending" this many times per prompt.
        pending: u64,
        /// An LLM appears (JIT) after this many /history calls.
        jit_after: Option<u64>,
        /// preempt() says yes from this call on (1-based).
        preempt_at: Option<u64>,
        preempt_calls: AtomicU64,
        ours: bool,
        restore_ok: bool,
        /// comfy_stop gives the VRAM back (false: ComfyUI's allocation lingers).
        stop_frees: bool,
        /// Cancel this job (store, ctl) the first time models_root is read inside run_job.
        cancel_on_probe: Mutex<Option<(Arc<Store>, Arc<Control>, String)>>,
        roots_calls: AtomicU64,
    }

    fn tony() -> Inst {
        Inst { key: TONY.into(), id: TONY.into(), context: Some(32768), parallel: Some(2), config: Value::Null }
    }

    impl FakeIo {
        fn new(fail: Step) -> Self {
            let dir = tmp("io");
            let ck = dir.join("models").join("sdxl-turbo");
            std::fs::create_dir_all(&ck).unwrap();
            std::fs::write(ck.join("sd_xl_turbo_1.0_fp16.safetensors"), b"x").unwrap();
            FakeIo {
                marker: dir.join("comfy-crash.json"),
                dir,
                fail,
                calls: Mutex::default(),
                loaded: Mutex::new(vec![tony()]),
                vram: Arc::new(AtomicU64::new(10_900)),
                history_calls: AtomicU64::new(0),
                submits: AtomicU64::new(0),
                pending: 0,
                jit_after: None,
                preempt_at: None,
                preempt_calls: AtomicU64::new(0),
                ours: true,
                restore_ok: true,
                stop_frees: true,
                cancel_on_probe: Mutex::default(),
                roots_calls: AtomicU64::new(0),
            }
        }
        fn call(&self, s: impl Into<String>) {
            lk(&self.calls).push(s.into());
        }
        fn calls(&self) -> Vec<String> {
            lk(&self.calls).clone()
        }
        fn count(&self, s: &str) -> usize {
            self.calls().iter().filter(|c| *c == s).count()
        }
        fn pos(&self, s: &str) -> Option<usize> {
            self.calls().iter().position(|c| c == s)
        }
        fn restore(&self) -> Restore {
            *lk(&self.loaded) = vec![tony()];
            Restore { model: TONY.into(), ok: self.restore_ok, ..Default::default() }
        }
    }

    impl BatchIo for FakeIo {
        async fn snapshot_loaded(&self) -> Result<Vec<Inst>, String> {
            if self.fail == Step::Snapshot {
                return Err("LM Studio down".into());
            }
            Ok(lk(&self.loaded).clone())
        }
        async fn unload_all(&self) -> Result<Vec<Inst>, String> {
            self.call("unload");
            if self.fail == Step::Unload {
                return Err("unload refused".into());
            }
            if self.fail != Step::Vram {
                self.vram.store(2_100, Ordering::SeqCst);
            }
            Ok(std::mem::take(&mut *lk(&self.loaded)))
        }
        async fn restore_tony(&self) -> Restore {
            self.call("restore");
            self.restore()
        }
        async fn verify_only_tony(&self) -> Restore {
            self.call("verify");
            self.restore()
        }
        fn vram(&self) -> VramFn {
            let v = self.vram.clone();
            Arc::new(move || Some(v.load(Ordering::SeqCst)))
        }
        async fn preflight(&self) -> Result<(), String> {
            self.call("preflight");
            if self.fail == Step::Preflight {
                return Err("port 8188 already answers: a ComfyUI this app didn't start; not touching it".into());
            }
            Ok(())
        }
        async fn comfy_start(&self) -> Result<(Option<u32>, String), String> {
            self.call("start");
            if self.fail == Step::Start {
                return Err("ComfyUI didn't answer /system_stats within 120 s".into());
            }
            self.vram.store(8_800, Ordering::SeqCst);
            Ok((Some(4242), "0.46.0".into()))
        }
        async fn comfy_stop(&self) {
            self.call("stop");
            if self.stop_frees {
                self.vram.store(2_100, Ordering::SeqCst);
            }
        }
        async fn free(&self) {
            self.call("free");
        }
        async fn interrupt(&self) {
            self.call("interrupt");
        }
        async fn submit(&self, prompt: &Value, _client_id: &str) -> Result<String, String> {
            assert!(prompt["3"]["class_type"] == "KSampler");
            if self.fail == Step::Submit {
                return Err("ComfyUI rejected the prompt (HTTP 400): bad".into());
            }
            Ok(format!("p{}", self.submits.fetch_add(1, Ordering::SeqCst) + 1))
        }
        async fn history(&self, prompt_id: &str) -> Result<Value, String> {
            let n = self.history_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.jit_after == Some(n) {
                lk(&self.loaded).push(Inst { key: "stray-jit".into(), id: "stray-jit".into(), context: Some(4096), parallel: Some(4), config: Value::Null });
            }
            if self.fail == Step::History {
                return Ok(json!({ prompt_id: { "status": { "status_str": "error", "completed": false, "messages": [["execution_error", { "exception_message": "CUDA out of memory", "node_type": "KSampler" }]] }, "outputs": {} } }));
            }
            if self.pending > 0 && n % (self.pending + 1) != 0 {
                return Ok(json!({}));
            }
            Ok(json!({ prompt_id: {
                "status": { "status_str": "success", "completed": true, "messages": [] },
                "outputs": { "9": { "images": [
                    { "filename": format!("{prompt_id}_00001_.png"), "subfolder": "", "type": "output" },
                    { "filename": "preview.png", "subfolder": "", "type": "temp" },
                ] } },
            } }))
        }
        async fn download(&self, f: &OutFile, dest: &Path) -> Result<u64, String> {
            if self.fail == Step::Download {
                return Err("HTTP 404".into());
            }
            std::fs::write(dest, format!("PNG {}", f.filename)).map_err(|e| e.to_string())?;
            Ok(3)
        }
        fn write_marker(&self, m: &CrashMarker) -> Result<(), String> {
            if self.fail == Step::Marker {
                return Err("disk full".into());
            }
            write_marker_file(&self.marker, m)
        }
        fn read_marker(&self) -> Option<CrashMarker> {
            read_marker(&self.marker)
        }
        fn clear_marker(&self) {
            self.call("clear-marker");
            let _ = std::fs::remove_file(&self.marker);
        }
        fn leftover_is_ours(&self, _m: &CrashMarker, _pid: u32) -> bool {
            self.ours
        }
        fn kill_pid(&self, pid: u32) {
            self.call(format!("kill {pid}"));
        }
        fn preempt(&self, _since: u64) -> Option<String> {
            let n = self.preempt_calls.fetch_add(1, Ordering::SeqCst) + 1;
            self.preempt_at.filter(|at| n >= *at).map(|_| "Tony is waiting for the GPU".into())
        }
        fn heartbeat(&self, _label: &str) -> Task<u32> {
            Task::idle()
        }
        fn gen_dir(&self, slug: &str, job_id: &str) -> Result<PathBuf, String> {
            Ok(self.dir.join("projects").join(slug).join("working").join("gen").join(job_id))
        }
        async fn ingest(&self, _slug: &str, _file: &Path, meta: &GenMeta) -> Option<String> {
            assert!(meta.workflow.is_object(), "media gets the full workflow");
            self.call("ingest");
            None
        }
        fn emit_queue(&self, j: &Job) {
            self.call(format!("q {} {:?}", j.id, j.status));
        }
        fn emit_service(&self, _v: Value) {}
        fn models_root(&self) -> Vec<String> {
            // Read once by run_batch (admission), then once per run_job (the model probe).
            if self.roots_calls.fetch_add(1, Ordering::SeqCst) >= 1 {
                if let Some((store, ctl, id)) = lk(&self.cancel_on_probe).take() {
                    store.cancel(&id, &ctl).unwrap();
                }
            }
            vec![self.dir.join("models").to_string_lossy().to_string()]
        }
        fn input_dir(&self) -> PathBuf {
            self.dir.join("input")
        }
    }

    fn cfg() -> RunCfg {
        RunCfg { poll_every: Duration::from_millis(2), jit_every: Duration::ZERO, job_timeout: Duration::from_secs(5), vram_every: Duration::from_millis(2), vram_settle: Duration::from_millis(40), vram_max_used_mb: 5_500, tony_priority_pct: 50, batch_wall: Duration::from_secs(600) }
    }

    fn store_with(n: usize) -> (Store, Vec<String>) {
        let s = Store::memory();
        let ids = (0..n).map(|i| s.enqueue("short-film", "sdxl-turbo-txt2img", json!({ "prompt": format!("shot {i}"), "seed": 100 + i as u64 }), &[]).id).collect();
        (s, ids)
    }

    fn run(io: &FakeIo, store: &Store) -> (BatchReport, Arc<OsState>) {
        let os = Arc::new(OsState::default());
        let ctl = Control::default();
        let rep = tauri::async_runtime::block_on(run_batch(io, store, &FakeTemplates, &os.slot, &cfg(), &ctl));
        (rep, os)
    }

    fn status(store: &Store, id: &str) -> JobStatus {
        store.job(id).unwrap().status
    }

    #[test]
    fn a_batch_renders_downloads_then_puts_tony_back() {
        let io = FakeIo::new(Step::None);
        let (store, ids) = store_with(2);
        let (rep, os) = run(&io, &store);
        assert_eq!(rep.done, ids, "{rep:?}");
        assert!(rep.error.is_none() && rep.requeued.is_empty());
        assert_eq!(rep.label, "comfyui · 2 job(s)");
        assert_eq!(rep.snapshot, vec![TONY.to_string()]);
        assert_eq!(rep.vram_after_unload_mb, Some(2_100));
        assert!(os.slot.view().active.is_empty(), "slot released");
        // Order: unload → start → … → free → stop → restore → marker cleared.
        let (u, s, f, st, r, c) = (io.pos("unload").unwrap(), io.pos("start").unwrap(), io.pos("free").unwrap(), io.pos("stop").unwrap(), io.pos("restore").unwrap(), io.pos("clear-marker").unwrap());
        assert!(u < s && s < f && f < st && st < r && r < c, "{:?}", io.calls());
        assert_eq!(io.count("restore"), 1);
        assert!(!io.marker.exists());
        for id in &ids {
            let j = store.job(id).unwrap();
            assert_eq!(j.status, JobStatus::Done);
            assert_eq!(j.outputs.len(), 1, "the temp preview is skipped");
            let o = &j.outputs[0];
            assert!(Path::new(&o.path).is_file());
            assert!(o.path.contains(&format!("gen{}{id}", std::path::MAIN_SEPARATOR)));
            assert_eq!(o.gen.checkpoint, "sd_xl_turbo_1.0_fp16.safetensors");
            assert!(o.gen.checkpoint_path.as_deref().is_some_and(|p| p.contains("sdxl-turbo")));
            assert_eq!((o.gen.steps, o.gen.width, o.gen.height, o.gen.comfyui_version.as_str()), (1, 512, 512, "0.46.0"));
            assert!(o.gen.workflow.is_null(), "the queue copy drops the graph");
            assert!(j.peak_vram_mb.is_some_and(|p| p >= 8_800));
            assert!(j.prompt_id.is_some() && j.render_ms.is_some());
            assert!(Path::new(&o.path).with_file_name("workflow.json").is_file());
        }
        assert_eq!(store.job(&ids[0]).unwrap().outputs[0].gen.seed, 100);
    }

    #[test]
    fn restore_always_runs_whatever_step_fails() {
        for step in [Step::Preflight, Step::Marker, Step::Snapshot, Step::Unload, Step::Vram, Step::Start, Step::Submit, Step::History, Step::Download] {
            let io = FakeIo::new(step);
            let (store, ids) = store_with(2);
            let (rep, os) = run(&io, &store);
            let llm_touched = !matches!(step, Step::Preflight | Step::Marker | Step::Snapshot);
            let comfy_touched = matches!(step, Step::Start | Step::Submit | Step::History | Step::Download);
            if llm_touched {
                assert_eq!(io.count("restore"), 1, "{step:?}: {:?}", io.calls());
                assert_eq!(io.count("verify"), 0, "{step:?}");
            } else {
                assert_eq!((io.count("restore"), io.count("verify")), (0, 1), "{step:?}: nothing unloaded → only verified");
            }
            assert_eq!(io.count("start") == 1, comfy_touched, "{step:?}");
            assert_eq!(io.count("stop") == 1, comfy_touched, "{step:?}");
            if comfy_touched {
                assert!(io.pos("stop").unwrap() < io.pos(if llm_touched { "restore" } else { "verify" }).unwrap(), "{step:?}: ComfyUI stops before Qwen reloads");
            }
            assert!(os.slot.view().active.is_empty(), "{step:?}: slot released");
            assert!(!io.marker.exists(), "{step:?}: marker cleared after a good restore");
            for id in &ids {
                assert_ne!(status(&store, id), JobStatus::Running, "{step:?}");
            }
            match step {
                Step::Submit | Step::History | Step::Download => {
                    assert_eq!(rep.failed, ids, "{step:?}");
                    let e = store.job(&ids[0]).unwrap().error.unwrap();
                    assert!(e.contains(match step {
                        Step::Submit => "rejected",
                        Step::History => "CUDA out of memory (KSampler)",
                        _ => "download",
                    }), "{step:?}: {e}");
                }
                _ => {
                    assert!(rep.error.is_some(), "{step:?}");
                    assert!(ids.iter().all(|id| status(&store, id) == JobStatus::Queued), "{step:?}: jobs untouched");
                }
            }
            if step == Step::Vram {
                assert!(rep.error.as_deref().unwrap().contains("VRAM still at 10900 MiB"));
            }
        }
    }

    #[test]
    fn a_failed_restore_keeps_the_crash_marker() {
        let mut io = FakeIo::new(Step::Start);
        io.restore_ok = false;
        let (store, _) = store_with(1);
        let (rep, _) = run(&io, &store);
        assert!(!rep.restore.unwrap().ok);
        assert!(io.marker.exists(), "the next start retries the recovery");
        assert_eq!(read_marker(&io.marker).unwrap().snapshot, vec![TONY.to_string()]);
    }

    #[test]
    fn preempt_between_jobs_requeues_the_rest() {
        let mut io = FakeIo::new(Step::None);
        // Calls: 1 after the slot, 2 before job 1, 3 job 1's poll, 4 before job 2.
        io.preempt_at = Some(4);
        let (store, ids) = store_with(3);
        let (rep, _) = run(&io, &store);
        assert_eq!(rep.done, vec![ids[0].clone()]);
        assert_eq!(rep.requeued, ids[1..].to_vec());
        assert!(rep.preempted.is_some());
        assert_eq!(status(&store, &ids[1]), JobStatus::Queued);
        assert_eq!(status(&store, &ids[2]), JobStatus::Queued);
        assert_eq!(io.count("interrupt"), 1);
        assert_eq!(io.count("restore"), 1);
    }

    #[test]
    fn preempt_mid_render_requeues_the_current_job_too() {
        let mut io = FakeIo::new(Step::None);
        io.preempt_at = Some(3);
        let (store, ids) = store_with(2);
        let (rep, _) = run(&io, &store);
        assert!(rep.done.is_empty());
        assert_eq!(rep.requeued, ids);
        let j = store.job(&ids[0]).unwrap();
        assert_eq!((j.status, j.started_at, j.prompt_id), (JobStatus::Queued, None, None));
        assert!(io.pos("interrupt").unwrap() < io.pos("stop").unwrap());
        assert_eq!(io.count("restore"), 1);
    }

    #[test]
    fn tony_back_while_waiting_for_the_slot_defers_without_touching_anything() {
        let mut io = FakeIo::new(Step::None);
        io.preempt_at = Some(1);
        let (store, ids) = store_with(2);
        let (rep, os) = run(&io, &store);
        assert!(rep.deferred.is_some());
        assert!(io.calls().iter().all(|c| !matches!(c.as_str(), "unload" | "start" | "restore" | "verify")), "{:?}", io.calls());
        assert!(ids.iter().all(|id| status(&store, id) == JobStatus::Queued));
        assert!(os.slot.view().active.is_empty());
    }

    #[test]
    fn a_jit_loaded_llm_interrupts_the_render() {
        let mut io = FakeIo::new(Step::None);
        io.pending = 3;
        io.jit_after = Some(1);
        let (store, ids) = store_with(2);
        let (rep, _) = run(&io, &store);
        assert_eq!(rep.failed, vec![ids[0].clone()]);
        assert_eq!(rep.requeued, vec![ids[1].clone()]);
        assert_eq!(rep.error.as_deref(), Some(JIT_ERROR));
        let e = store.job(&ids[0]).unwrap().error.unwrap();
        assert!(e.starts_with(JIT_ERROR) && e.contains("stray-jit"), "{e}");
        assert_eq!(status(&store, &ids[1]), JobStatus::Queued);
        assert!(io.count("interrupt") >= 1);
        assert_eq!(io.count("restore"), 1, "restore unloads the stray and reloads Tony");
    }

    #[test]
    fn a_cancelled_running_job_is_interrupted() {
        let mut io = FakeIo::new(Step::None);
        io.pending = 1_000_000;
        let (store, ids) = store_with(1);
        let os = Arc::new(OsState::default());
        let ctl = Arc::new(Control::default());
        let store = Arc::new(store);
        let io = Arc::new(io);
        let rep = tauri::async_runtime::block_on(async {
            let (io2, st2, ctl2, os2) = (io.clone(), store.clone(), ctl.clone(), os.clone());
            let h = tauri::async_runtime::spawn(async move { run_batch(&*io2, &st2, &FakeTemplates, &os2.slot, &cfg(), &ctl2).await });
            for _ in 0..500 {
                if store.job(&ids[0]).unwrap().status == JobStatus::Running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            store.cancel(&ids[0], &ctl).unwrap();
            h.await.unwrap()
        });
        assert_eq!(rep.cancelled, ids);
        assert_eq!(status(&store, &ids[0]), JobStatus::Cancelled);
        assert!(io.count("interrupt") >= 1);
        assert!(lk(&ctl.cancel).is_empty(), "cancel flags cleared after the batch");
    }

    #[test]
    fn jobs_needing_absent_models_wait_and_never_run() {
        let io = FakeIo::new(Step::None);
        let roots = io.models_root();
        let store = Store::memory();
        let missing = missing_models(&roots, &FakeTemplates.required_models("upscale"));
        assert_eq!(missing, vec![UPSCALER.to_string()]);
        let j = store.enqueue("short-film", "upscale", json!({}), &missing);
        assert_eq!(j.status, JobStatus::Waiting);
        assert_eq!(j.error.as_deref(), Some("needs model upscale_models/4x-UltraSharp.safetensors"));
        let (rep, _) = run(&io, &store);
        assert_eq!(rep.deferred.as_deref(), Some("nothing runnable"));
        assert!(io.calls().is_empty());
        // The upscaler lands on disk: waiting → queued on the next tick.
        let up = io.dir.join("models").join("upscalers");
        std::fs::create_dir_all(&up).unwrap();
        std::fs::write(up.join("4x-UltraSharp.safetensors"), b"x").unwrap();
        let changed = store.update(|q| refresh_waiting(q, &|t| missing_models(&roots, &FakeTemplates.required_models(t))));
        assert_eq!(changed, vec![j.id.clone()]);
        assert_eq!(status(&store, &j.id), JobStatus::Queued);
        assert!(store.job(&j.id).unwrap().error.is_none());
    }

    #[test]
    fn cancel_queued_waiting_and_finished() {
        let store = Store::memory();
        let ctl = Control::default();
        let a = store.enqueue("p", "t", json!({}), &[]);
        let b = store.enqueue("p", "t", json!({}), &["x".into()]);
        assert_eq!(store.cancel(&a.id, &ctl).unwrap().status, JobStatus::Cancelled);
        assert_eq!(store.cancel(&b.id, &ctl).unwrap().status, JobStatus::Cancelled);
        assert!(store.cancel(&a.id, &ctl).is_err(), "already finished");
        assert!(store.cancel("nope", &ctl).is_err());
    }

    #[test]
    fn the_queue_persists_and_recovers_after_a_crash() {
        let dir = tmp("queue");
        let path = dir.join("comfy-queue.json");
        let (a, b) = {
            let s = Store::open(path.clone());
            let a = s.enqueue("short-film", "sdxl-turbo-txt2img", json!({ "prompt": "a cat" }), &[]);
            let b = s.enqueue("short-film", "sdxl-turbo-txt2img", json!({ "prompt": "a dog" }), &[]);
            s.set(&a.id, |j| {
                j.status = JobStatus::Running;
                j.started_at = Some(5);
                j.prompt_id = Some("p1".into());
            });
            s.update(|q| q.settings.policy = Policy::Idle);
            (a, b)
        };
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(raw["jobs"][0]["createdAt"].is_u64() && raw["settings"]["modelRoots"][0] == DEFAULT_MODEL_ROOT);
        assert_eq!(raw["jobs"][0]["status"], "running");
        let s = Store::open(path.clone());
        let ra = s.job(&a.id).unwrap();
        assert_eq!((ra.status, ra.started_at, ra.prompt_id.clone()), (JobStatus::Queued, None, None));
        assert!(ra.error.unwrap().contains("interrupted"));
        assert_eq!(s.job(&b.id).unwrap(), b);
        assert_eq!(s.snapshot().settings.policy, Policy::Idle);
        // The recovery was saved back.
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["jobs"][0]["status"], "queued");
        // A missing or broken file starts empty.
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(Store::open(path).snapshot().jobs.is_empty());
    }

    #[test]
    fn prune_keeps_every_unfinished_job() {
        let mut q = QueueFile::default();
        let job = |i: usize, s: JobStatus| Job { id: format!("j{i}"), slug: "p".into(), template: "t".into(), params: Value::Null, status: s, created_at: i as u64, started_at: None, finished_at: None, error: None, outputs: vec![], render_ms: None, peak_vram_mb: None, prompt_id: None };
        q.jobs.push(job(0, JobStatus::Queued));
        for i in 1..=KEEP_FINISHED + 5 {
            q.jobs.push(job(i, JobStatus::Done));
        }
        prune(&mut q);
        assert_eq!(q.jobs.len(), KEEP_FINISHED + 1);
        assert_eq!(q.jobs[0].id, "j0");
        assert_eq!(q.jobs[1].id, "j6", "the oldest finished go first");
    }

    fn sig() -> Signals {
        Signals { runnable: 1, policy: Policy::Idle, local_minutes: 14 * 60, ms_since_boot: 3_600_000, ..Default::default() }
    }

    #[test]
    fn no_batch_right_after_boot_even_with_run_now() {
        // At boot neither interaction signal exists (None), which used to read as "quiet".
        let boot = Signals { ms_since_boot: 30_000, ms_since_interactive: None, arbiter_idle_ms: None, ..sig() };
        assert!(admit(&boot).unwrap_err().contains("just started"));
        assert!(admit(&Signals { run_now: true, ..boot.clone() }).is_err(), "Run now respects the boot grace");
        assert!(admit(&Signals { away: true, policy: Policy::Overnight, local_minutes: 120, ..boot }).is_err(), "Away mode persisted across a restart");
        assert!(admit(&Signals { ms_since_boot: BOOT_GRACE_MS, ..sig() }).is_ok());
    }

    #[test]
    fn a_failed_batch_backs_admission_off() {
        assert_eq!(backoff_ms(0), 0);
        assert_eq!(backoff_ms(1), 15 * 60_000);
        assert_eq!(backoff_ms(2), 30 * 60_000);
        assert_eq!(backoff_ms(5), BACKOFF_CAP_MS);
        assert_eq!(backoff_ms(40), BACKOFF_CAP_MS);
        let off = Signals { backoff_left_ms: 14 * 60_000, failures: 1, ..sig() };
        assert!(admit(&off).unwrap_err().contains("backing off after 1 failed batch(es): next try in 14 min"));
        assert!(admit(&Signals { run_now: true, ..off }).is_err(), "Run now clears the backoff in comfy_run_now, not in admit");
        // What counts: an error with nothing rendered, or Tony not put back. Not a preempt / deferral.
        let failed = |e: Option<&str>, done: usize, restore_ok: bool| BatchReport { error: e.map(str::to_string), done: vec!["x".into(); done], restore: Some(Restore { ok: restore_ok, ..Default::default() }), ..Default::default() };
        assert!(batch_failed(&failed(Some("preflight: port 8188 already answers"), 0, true)));
        assert!(!batch_failed(&failed(Some(JIT_ERROR), 1, true)), "something rendered");
        assert!(batch_failed(&failed(None, 2, false)), "a failed restore");
        assert!(!batch_failed(&failed(None, 0, true)), "a preempt with a good restore");
        assert!(!batch_failed(&BatchReport { deferred: Some("Tony is waiting".into()), ..Default::default() }));
    }

    #[test]
    fn a_failed_restore_is_retried_with_backoff() {
        assert!(recovery_due(0, 0, 5));
        assert!(!recovery_due(1, 1_000, 60_999));
        assert!(recovery_due(1, 1_000, 61_000));
        assert!(!recovery_due(2, 0, 299_999));
        assert!(recovery_due(2, 0, 300_000));
        assert!(!recovery_due(9, 0, 899_999));
        assert!(recovery_due(9, 0, 900_000));
    }

    #[test]
    fn preflight_failure_never_unloads_tony() {
        // A foreign ComfyUI on 8188 (or no python): refused before the marker and the unload.
        let io = FakeIo::new(Step::Preflight);
        let (store, ids) = store_with(1);
        let (rep, _) = run(&io, &store);
        assert!(rep.error.as_deref().unwrap().starts_with("preflight: port 8188"));
        assert_eq!(io.count("unload"), 0);
        assert_eq!((io.count("start"), io.count("stop"), io.count("free"), io.count("restore")), (0, 0, 0, 0), "{:?}", io.calls());
        assert_eq!(status(&store, &ids[0]), JobStatus::Queued);
        assert!(!io.marker.exists());
        assert!(batch_failed(&rep));
    }

    #[test]
    fn another_app_holding_vram_fails_before_the_unload() {
        let io = FakeIo::new(Step::None);
        // Tony (~10.7 GB) + a game's 6 GB: the unload could never get under 5.5 GB.
        io.vram.store(16_900, Ordering::SeqCst);
        let (store, _) = store_with(1);
        let (rep, _) = run(&io, &store);
        assert!(rep.error.as_deref().unwrap().contains("another app holds the GPU"), "{rep:?}");
        assert_eq!(io.count("unload"), 0);
        assert_eq!(io.count("restore"), 0, "nothing unloaded → only verified");
        assert_eq!(vram_estimate_after_unload(Some(11_900), &[tony()]), Some(1_200));
        assert_eq!(vram_estimate_after_unload(Some(3_000), &[]), Some(3_000));
        assert_eq!(vram_estimate_after_unload(Some(11_900), &[tony(), tony()]), None, "unknown sizes: no guess");
        assert_eq!(vram_estimate_after_unload(None, &[tony()]), None);
    }

    #[test]
    fn invalid_params_fail_before_anything_is_touched() {
        let io = FakeIo::new(Step::None);
        let store = Store::memory();
        let bad = store.enqueue("short-film", "bad", json!({ "prompt": "x" }), &[]);
        let (rep, _) = run(&io, &store);
        assert_eq!(rep.failed, vec![bad.id.clone()]);
        assert_eq!(rep.deferred.as_deref(), Some("nothing runnable"));
        assert!(io.calls().iter().all(|c| !matches!(c.as_str(), "preflight" | "unload" | "start" | "restore" | "verify")), "{:?}", io.calls());
        let j = store.job(&bad.id).unwrap();
        assert_eq!(j.status, JobStatus::Failed);
        assert!(j.error.unwrap().starts_with("template:"));
        // The live templates' rules, as comfy_enqueue dry-runs them.
        let p = |v: Value| with_seed(v, 1);
        assert!(dry_run_fill(&LiveTemplates, "scene-still", &p(json!({ "prompt": "a pier", "steps": 8 }))).unwrap_err().contains("steps 8"));
        assert!(dry_run_fill(&LiveTemplates, "scene-still", &p(json!({ "prompt": "" }))).unwrap_err().contains("prompt is empty"));
        assert!(dry_run_fill(&LiveTemplates, "scene-still", &p(json!({ "prompt": "a pier", "aspect": "21:9" }))).unwrap_err().contains("aspect"));
        assert!(dry_run_fill(&LiveTemplates, "scene-still", &p(json!({ "prompt": "a pier" }))).is_ok());
        let dir = tmp("dry");
        let heic = dir.join("IMG_0001.HEIC");
        let png = dir.join("still.png");
        std::fs::write(&heic, b"x").unwrap();
        std::fs::write(&png, b"x").unwrap();
        let st = |f: &Path, d: f64| p(json!({ "prompt": "oil paint", "inputImage": f.to_string_lossy(), "denoise": d }));
        assert!(dry_run_fill(&LiveTemplates, "style-transfer", &st(&heic, 0.5)).unwrap_err().contains(".png, .jpg"));
        assert!(dry_run_fill(&LiveTemplates, "style-transfer", &st(&png, 0.9)).unwrap_err().contains("denoise"));
        assert!(dry_run_fill(&LiveTemplates, "style-transfer", &st(&png, 0.5)).is_ok());
        assert!(dry_run_fill(&LiveTemplates, "style-transfer", &st(&dir.join("gone.png"), 0.5)).unwrap_err().contains("not a file"));
        assert!(dry_run_fill(&LiveTemplates, "style-transfer", &p(json!({ "prompt": "oil paint", "denoise": 0.5 }))).unwrap_err().contains("inputImage"));
        assert!(dry_run_fill(&LiveTemplates, "upscale", &p(json!({ "inputImage": "x[1].png" }))).is_err());
    }

    #[test]
    fn thumbnail_bg_defaults_to_16_9_or_the_project_aspect() {
        assert_eq!(with_default_aspect(json!({ "prompt": "x" }), "thumbnail-bg", None)["aspect"], "16:9");
        assert_eq!(with_default_aspect(json!({ "prompt": "x" }), "thumbnail-bg", Some("9:16"))["aspect"], "9:16");
        assert_eq!(with_default_aspect(json!({ "prompt": "x" }), "scene-still", Some("4:5"))["aspect"], "4:5");
        assert!(with_default_aspect(json!({ "prompt": "x" }), "scene-still", None).get("aspect").is_none(), "1:1 stays the template default");
        assert_eq!(with_default_aspect(json!({ "aspect": "1:1" }), "thumbnail-bg", Some("9:16"))["aspect"], "1:1", "an explicit aspect wins");
        assert!(with_default_aspect(json!({ "width": 512, "height": 512 }), "thumbnail-bg", None).get("aspect").is_none(), "an explicit size wins");
        assert_eq!(with_default_aspect(json!({}), "thumbnail-bg", Some("21:9"))["aspect"], "16:9", "a bad project aspect is ignored");
        let p = with_default_aspect(with_seed(json!({ "prompt": "a desk", "slug": "s", "jobId": "j" }), 3), "thumbnail-bg", None);
        let g = LiveTemplates.fill("thumbnail-bg", &p).unwrap();
        assert_eq!((g["5"]["inputs"]["width"].clone(), g["5"]["inputs"]["height"].clone()), (json!(896), json!(512)));
    }

    #[test]
    fn a_cancel_while_the_batch_reaches_the_job_wins() {
        let io = FakeIo::new(Step::None);
        let (store, ids) = store_with(1);
        let store = Arc::new(store);
        let ctl = Arc::new(Control::default());
        *lk(&io.cancel_on_probe) = Some((store.clone(), ctl.clone(), ids[0].clone()));
        let os = OsState::default();
        let rep = tauri::async_runtime::block_on(run_batch(&io, &store, &FakeTemplates, &os.slot, &cfg(), &ctl));
        assert_eq!(rep.cancelled, ids);
        assert!(rep.done.is_empty());
        let j = store.job(&ids[0]).unwrap();
        assert_eq!(j.status, JobStatus::Cancelled, "not overwritten by Running / Done");
        assert!(j.outputs.is_empty());
        assert_eq!(io.submits.load(Ordering::SeqCst), 0);
        // The helper itself: only a queued job starts.
        let s = Store::memory();
        let a = s.enqueue("p", "t", json!({}), &[]);
        s.cancel(&a.id, &Control::default()).unwrap();
        assert!(s.start_running(&a.id).is_none());
        assert_eq!(status(&s, &a.id), JobStatus::Cancelled);
    }

    #[test]
    fn a_model_gone_mid_batch_is_reported_waiting_not_cancelled() {
        let io = FakeIo::new(Step::None);
        let (store, ids) = store_with(1);
        // Admitted with the checkpoint on disk; it is gone by the job's own probe (run_job is
        // driven directly, since run_batch would now find nothing runnable).
        std::fs::remove_file(io.dir.join("models").join("sdxl-turbo").join("sd_xl_turbo_1.0_fp16.safetensors")).unwrap();
        let job = store.job(&ids[0]).unwrap();
        let end = tauri::async_runtime::block_on(run_job(&io, &store, &FakeTemplates, &cfg(), &Control::default(), &job, "c", now_ms(), "0.46.0"));
        assert!(matches!(end, JobEnd::Waiting), "batch_steps records it under rep.waiting, not rep.cancelled");
        let j = store.job(&ids[0]).unwrap();
        assert_eq!(j.status, JobStatus::Waiting);
        assert!(j.error.unwrap().starts_with("needs model"));
    }

    #[test]
    fn a_timed_out_render_ends_the_batch() {
        let mut io = FakeIo::new(Step::None);
        io.pending = 1_000_000;
        let (store, ids) = store_with(3);
        let os = Arc::new(OsState::default());
        let ctl = Control::default();
        let c = RunCfg { job_timeout: Duration::from_millis(60), ..cfg() };
        let rep = tauri::async_runtime::block_on(run_batch(&io, &store, &FakeTemplates, &os.slot, &c, &ctl));
        assert_eq!(rep.failed, vec![ids[0].clone()]);
        assert_eq!(rep.requeued, ids[1..].to_vec(), "the rest wait for a fresh ComfyUI");
        assert!(rep.error.as_deref().unwrap().contains("timed out"));
        assert_eq!(io.submits.load(Ordering::SeqCst), 1, "nothing queued behind the hung prompt");
        assert_eq!(io.count("restore"), 1);
        assert!(store.job(&ids[0]).unwrap().error.unwrap().contains("timed out"));
    }

    #[test]
    fn the_batch_wall_cap_puts_tony_back_and_requeues_the_rest() {
        let io = FakeIo::new(Step::None);
        let (store, ids) = store_with(3);
        let os = Arc::new(OsState::default());
        let ctl = Control::default();
        let c = RunCfg { batch_wall: Duration::ZERO, ..cfg() };
        let rep = tauri::async_runtime::block_on(run_batch(&io, &store, &FakeTemplates, &os.slot, &c, &ctl));
        assert_eq!(rep.done, vec![ids[0].clone()], "the first job always runs");
        assert_eq!(rep.requeued, ids[1..].to_vec());
        assert!(rep.error.is_none() && !batch_failed(&rep));
        assert_eq!(io.count("restore"), 1);
    }

    #[test]
    fn vram_is_confirmed_after_the_stop_before_tony_reloads() {
        let io = FakeIo::new(Step::None);
        let (store, _) = store_with(1);
        let (rep, _) = run(&io, &store);
        assert_eq!(rep.vram_after_stop_mb, Some(2_100));
        assert!(rep.steps.iter().any(|s| s == "VRAM 2100 MiB after the stop"), "{:?}", rep.steps);
        // ComfyUI's allocation lingers: Tony is still put back, and it is recorded.
        let mut io = FakeIo::new(Step::None);
        io.stop_frees = false;
        let (store, _) = store_with(1);
        let (rep, _) = run(&io, &store);
        assert_eq!(rep.vram_after_stop_mb, Some(8_800));
        assert!(rep.steps.iter().any(|s| s.contains("VRAM still 8800 MiB after the stop")), "{:?}", rep.steps);
        assert_eq!(io.count("restore"), 1);
    }

    #[test]
    fn stop_never_frees_a_comfyui_we_did_not_start() {
        tauri::async_runtime::block_on(async {
            let srv = serve(|_r: &Req| Resp::json(json!({}))).await;
            let c = ComfyHttp { http: reqwest::Client::new(), base: srv.base.clone() };
            let none: Mutex<Option<ComfyProc>> = Mutex::default();
            comfy_stop_live(&c, &none).await;
            assert_eq!(srv.count("POST", "/free"), 0, "a foreign ComfyUI on 8188 keeps its models");
        })
    }

    #[test]
    fn style_transfer_and_upscale_record_their_size() {
        let p = with_seed(json!({ "prompt": "oil", "inputImage": "a.png", "denoise": 0.5, "aspect": "4:5", "slug": "s", "jobId": "j" }), 4);
        let g = LiveTemplates.fill("style-transfer", &p).unwrap();
        let m = gen_meta_from("style-transfer", &p, &g);
        assert_eq!((m.width, m.height), (512, 640));
        let dir = tmp("png");
        let f = dir.join("up.png");
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&2048u32.to_be_bytes());
        b.extend_from_slice(&2560u32.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        std::fs::write(&f, &b).unwrap();
        assert_eq!(png_size(&f), Some((2048, 2560)));
        std::fs::write(&f, b"PNG not really").unwrap();
        assert_eq!(png_size(&f), None);
    }

    #[test]
    fn admission_policy() {
        assert!(admit(&sig()).is_ok());
        assert!(admit(&Signals { runnable: 0, ..sig() }).unwrap_err().contains("nothing runnable"));
        assert!(admit(&Signals { foreground_waiting: 1, ..sig() }).unwrap_err().contains("Tony is waiting"));
        assert!(admit(&Signals { ms_since_interactive: Some(179_999), ..sig() }).unwrap_err().contains("mid-conversation"));
        assert!(admit(&Signals { ms_since_interactive: Some(180_000), ..sig() }).is_ok());
        assert!(admit(&Signals { arbiter_idle_ms: Some(60_000), ..sig() }).unwrap_err().contains("last Tony turn"));
        assert!(admit(&Signals { arbiter_idle_ms: Some(600_000), ..sig() }).is_ok());
        assert!(admit(&Signals { idle_wait: Some("coder build running".into()), ..sig() }).unwrap_err().contains("coder build"));
        // Run now skips the policy, never the conversation checks.
        assert!(admit(&Signals { run_now: true, ms_since_interactive: Some(5_000), ..sig() }).is_err());
        assert!(admit(&Signals { run_now: true, foreground_waiting: 1, ..sig() }).is_err());
        assert!(admit(&Signals { run_now: true, policy: Policy::Manual, ..sig() }).is_ok());
        assert!(admit(&Signals { run_now: true, policy: Policy::Overnight, ..sig() }).is_ok());
        assert!(admit(&Signals { policy: Policy::Manual, ..sig() }).unwrap_err().contains("Run now"));
        // Overnight window edges: [01:00, 06:00).
        let night = |m: u32| admit(&Signals { policy: Policy::Overnight, local_minutes: m, ..sig() }).is_ok();
        assert!(!night(59), "00:59");
        assert!(night(60), "01:00");
        assert!(night(5 * 60 + 59), "05:59");
        assert!(!night(6 * 60), "06:00");
        assert!(!night(0) && !night(23 * 60 + 59));
        assert!(admit(&Signals { policy: Policy::Overnight, local_minutes: 14 * 60, away: true, ..sig() }).is_ok(), "Away mode counts as overnight");
        assert!(admit(&Signals { policy: Policy::Overnight, local_minutes: 120, foreground_waiting: 1, ..sig() }).is_err());
    }

    #[test]
    fn preempt_signals() {
        let since = 1_000_000;
        assert_eq!(preempt_reason(0, 0, None, since, since + 50_000), None);
        assert!(preempt_reason(1, 0, None, since, since + 1).is_some());
        assert!(preempt_reason(0, since + 1, None, since, since + 10).is_some());
        assert_eq!(preempt_reason(0, since - 1, None, since, since + 10), None);
        assert!(preempt_reason(0, 0, Some(1_000), since, since + 5_000).is_some(), "a turn 1 s ago, batch 5 s old");
        assert_eq!(preempt_reason(0, 0, Some(900_000), since, since + 5_000), None);
    }

    #[test]
    fn crash_marker_recovery_kills_only_our_comfy() {
        let run_rec = |io: &FakeIo| {
            let os = OsState::default();
            tauri::async_runtime::block_on(recover_from_marker(io, &os.slot, 50))
        };
        let io = FakeIo::new(Step::None);
        assert!(run_rec(&io).is_none(), "no marker, nothing to do");
        assert!(io.calls().is_empty());
        write_marker_file(&io.marker, &CrashMarker { started_at: 5, pid: Some(4242), python: "py".into(), jobs: vec!["j".into()], snapshot: vec![TONY.into()] }).unwrap();
        let v = run_rec(&io).unwrap();
        assert_eq!(io.calls(), vec!["kill 4242", "verify", "clear-marker"]);
        assert_eq!(v["restore"]["ok"], true);
        assert!(!io.marker.exists());

        let mut io = FakeIo::new(Step::None);
        io.ours = false;
        io.restore_ok = false;
        write_marker_file(&io.marker, &CrashMarker { started_at: 5, pid: Some(4242), ..Default::default() }).unwrap();
        let v = run_rec(&io).unwrap();
        assert_eq!(io.calls(), vec!["verify"], "never kills a ComfyUI we didn't start");
        assert!(v["notes"][0].as_str().unwrap().contains("left alone"));
        assert!(io.marker.exists(), "a failed verify keeps the marker");
    }

    #[test]
    fn our_comfy_is_our_python_started_after_the_marker() {
        let py = r"C:\ComfyUI\ComfyUI_windows_portable\python_embeded\python.exe";
        let m = CrashMarker { started_at: 1_700_000_000_000, pid: Some(1), python: py.into(), ..Default::default() };
        assert!(is_our_comfy(Some(Path::new(py)), 1_700_000_001, &m));
        assert!(is_our_comfy(Some(Path::new(&py.to_uppercase())), 1_700_000_001, &m), "case-insensitive on Windows");
        assert!(!is_our_comfy(Some(Path::new(r"C:\Python313\python.exe")), 1_700_000_001, &m), "another python");
        assert!(!is_our_comfy(Some(Path::new(py)), 1_699_999_000, &m), "a reused pid that is older than the marker");
        assert!(!is_our_comfy(None, 1_700_000_001, &m));
        assert!(!is_our_comfy(Some(Path::new(py)), 1_700_000_001, &CrashMarker { python: String::new(), ..m.clone() }));
    }

    #[test]
    fn extra_model_paths_yaml_is_generated_and_written_only_on_change() {
        let y = extra_model_paths_yaml(&[DEFAULT_MODEL_ROOT.into(), "  ".into()]);
        let expected = concat!(
            "# Generated by Command Center (comfy.rs) from the Director model roots setting. Edits are overwritten.\n",
            "director_0:\n",
            "    base_path: 'D:\\AI Models Media and Vision'\n",
            "    checkpoints: |\n        sdxl-turbo\n        checkpoints\n",
            "    vae: |\n        vae\n",
            "    loras: |\n        loras\n",
            "    upscale_models: |\n        upscalers\n        upscale_models\n",
            "    controlnet: |\n        controlnet\n",
            "    clip: |\n        clip\n        text_encoders\n",
            "    text_encoders: |\n        text_encoders\n        clip\n",
            "    clip_vision: |\n        clip_vision\n",
            "    diffusion_models: |\n        diffusion_models\n        unet\n",
            "    embeddings: |\n        embeddings\n",
        );
        assert_eq!(y, expected);
        assert!(extra_model_paths_yaml(&["E:\\Nic's models".into()]).contains("base_path: 'E:\\Nic''s models'"));
        let dir = tmp("yaml");
        let p = ComfyPaths { python: dir.join("python.exe"), comfy_dir: dir.join("ComfyUI"), hub: dir.join("hub") };
        assert!(prepare_dirs(&p, &[DEFAULT_MODEL_ROOT.into()]).unwrap(), "first write");
        assert!(!prepare_dirs(&p, &[DEFAULT_MODEL_ROOT.into()]).unwrap(), "unchanged → not rewritten");
        assert!(prepare_dirs(&p, &["E:\\models".into()]).unwrap(), "changed → rewritten");
        assert!(p.output().is_dir() && p.user().is_dir() && p.temp().is_dir() && p.input().is_dir() && p.hub.join("logs").is_dir());
        let none = extra_model_paths_yaml(&[r"relative\dir".into()]);
        assert!(none.ends_with("director_no_roots:\n") && !none.contains("base_path"), "never an all-comment file: {none}");
        assert!(!p.comfy_dir.exists(), "nothing is written into the ComfyUI folder");
    }

    #[test]
    fn the_command_line_is_exactly_headless() {
        let args = command_args(&ComfyPaths::live());
        assert_eq!(
            args,
            vec![
                "-s",
                r"C:\ComfyUI\ComfyUI_windows_portable\ComfyUI\main.py",
                "--listen",
                "127.0.0.1",
                "--port",
                "8188",
                "--disable-auto-launch",
                "--disable-api-nodes",
                "--extra-model-paths-config",
                r"G:\ai-hub\comfy\extra_model_paths.yaml",
                "--output-directory",
                r"G:\ai-hub\comfy\output",
                "--user-directory",
                r"G:\ai-hub\comfy\user",
                "--temp-directory",
                r"G:\ai-hub\comfy\temp",
                "--input-directory",
                r"G:\ai-hub\comfy\input",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("windows-standalone-build") || a.contains(".bat")));
        assert_eq!(ComfyPaths::live().python, PathBuf::from(r"C:\ComfyUI\ComfyUI_windows_portable\python_embeded\python.exe"));
    }

    #[test]
    fn models_are_found_by_category_or_name() {
        let io = FakeIo::new(Step::None);
        let roots = io.models_root();
        assert!(find_model(&roots, CKPT).unwrap().ends_with("sdxl-turbo/sd_xl_turbo_1.0_fp16.safetensors") || find_model(&roots, CKPT).unwrap().ends_with(r"sdxl-turbo\sd_xl_turbo_1.0_fp16.safetensors"));
        assert!(find_model(&roots, "sd_xl_turbo_1.0_fp16.safetensors").is_some(), "bare name searches every category");
        assert!(find_model(&roots, "vae/sd_xl_turbo_1.0_fp16.safetensors").is_none(), "wrong category");
        assert!(find_model(&roots, "checkpoints/../sdxl-turbo/sd_xl_turbo_1.0_fp16.safetensors").is_none());
        assert!(find_model(&[], CKPT).is_none());
        assert_eq!(missing_models(&roots, &[CKPT.into(), UPSCALER.into()]), vec![UPSCALER.to_string()]);
    }

    #[test]
    fn history_parsing_and_provenance() {
        assert_eq!(parse_history("p", &json!({})), HistoryState::Pending);
        assert_eq!(parse_history("p", &json!({ "p": { "status": { "status_str": "running", "completed": false }, "outputs": {} } })), HistoryState::Pending);
        let done = parse_history("p", &json!({ "p": { "status": { "status_str": "success", "completed": true }, "outputs": {
            "9": { "images": [{ "filename": "a.png", "subfolder": "x", "type": "output" }, { "filename": "t.png", "subfolder": "", "type": "temp" }] },
            "12": { "gifs": [{ "filename": "clip.mp4", "subfolder": "", "type": "output" }] },
        } } }));
        let HistoryState::Done(files) = done else { panic!("{done:?}") };
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.filename == "a.png" && f.subfolder == "x" && f.media == "image"));
        assert!(files.iter().any(|f| f.filename == "clip.mp4" && f.media == "video"));
        let err = parse_history("p", &json!({ "p": { "status": { "status_str": "error", "messages": [["execution_start", {}], ["execution_error", { "exception_message": "boom\n", "node_type": "VAEDecode" }]] } } }));
        assert_eq!(err, HistoryState::Error("boom (VAEDecode)".into()));
        assert_eq!(safe_name("../../evil.png").as_deref(), Some("evil.png"));
        assert_eq!(safe_name(".."), None);
        let g = gen_meta_from("sdxl-turbo-txt2img", &json!({ "prompt": "a cat", "negative": "blur" }), &FakeTemplates.fill("x", &json!({ "seed": 9 })).unwrap());
        assert_eq!((g.prompt.as_str(), g.negative.as_str(), g.seed, g.steps, g.cfg, g.sampler.as_str(), g.width, g.height), ("a cat", "blur", 9, 1, 0.0, "euler_ancestral", 512, 512));
    }

    #[test]
    fn comfy_rest_calls_against_a_mock() {
        tauri::async_runtime::block_on(async {
            let srv = serve(|r: &Req| match (r.method.as_str(), r.path.as_str()) {
                ("POST", "/prompt") if r.body["prompt"]["bad"].is_object() => Resp::status(400, json!({ "error": { "type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation" }, "node_errors": { "4": { "errors": [{ "message": "Value not in list: ckpt_name" }] } } })),
                ("POST", "/prompt") => Resp::json(json!({ "prompt_id": "abc", "number": 1, "node_errors": {} })),
                ("GET", "/history/abc") => Resp::json(json!({ "abc": { "status": { "status_str": "success", "completed": true }, "outputs": {} } })),
                ("GET", p) if p.starts_with("/view?") => Resp { status: 200, body: "PNGBYTES".into(), sse: None, delay_ms: 0, abort: false },
                ("GET", "/system_stats") => Resp::json(json!({ "system": { "comfyui_version": "0.46.0" } })),
                _ => Resp::json(json!({})),
            })
            .await;
            let c = ComfyHttp { http: reqwest::Client::new(), base: srv.base.clone() };
            assert_eq!(c.system_stats(Duration::from_secs(2)).await.unwrap()["system"]["comfyui_version"], "0.46.0");
            assert_eq!(c.submit(&json!({ "3": {} }), "cc-1").await.unwrap(), "abc");
            let e = c.submit(&json!({ "bad": {} }), "cc-1").await.unwrap_err();
            assert!(e.contains("HTTP 400") && e.contains("failed validation") && e.contains("4: Value not in list"), "{e}");
            assert!(matches!(parse_history("abc", &c.history("abc").await.unwrap()), HistoryState::Done(_)));
            let f = OutFile { node: "9".into(), filename: "a b.png".into(), subfolder: "sub".into(), kind: "output".into(), media: "image".into() };
            assert_eq!(c.view(&f).await.unwrap(), b"PNGBYTES");
            c.interrupt().await;
            c.free().await;
            let reqs = srv.reqs();
            let prompt = reqs.iter().find(|r| r.path == "/prompt").unwrap();
            assert_eq!(prompt.body, json!({ "prompt": { "3": {} }, "client_id": "cc-1" }));
            let view = reqs.iter().find(|r| r.path.starts_with("/view")).unwrap();
            assert_eq!(view.path, "/view?filename=a+b.png&subfolder=sub&type=output");
            assert_eq!(srv.count("POST", "/interrupt"), 1);
            assert_eq!(reqs.iter().find(|r| r.path == "/free").unwrap().body, json!({ "unload_models": true, "free_memory": true }));
        })
    }

    #[test]
    fn live_templates_fill_a_queued_job() {
        let store = Store::memory();
        let j = store.enqueue("short-film", "scene-still", with_seed(json!({ "prompt": "a lighthouse at dusk", "aspect": "16:9" }), 42), &[]);
        let p = job_params(&j);
        assert_eq!((p["slug"].as_str(), p["jobId"].as_str()), (Some("short-film"), Some(j.id.as_str())));
        let g = LiveTemplates.fill("scene-still", &p).unwrap();
        let prefix = format!("director/short-film/{}", j.id);
        assert!(g.as_object().unwrap().values().any(|n| n["class_type"] == "SaveImage" && n["inputs"]["filename_prefix"] == prefix.as_str()));
        let m = gen_meta_from("scene-still", &p, &g);
        assert_eq!((m.seed, m.steps, m.cfg, m.sampler.as_str(), m.scheduler.as_str(), m.width, m.height), (p["seed"].as_u64().unwrap(), 1, 1.0, "euler_ancestral", "sd_turbo", 896, 512));
        assert_eq!(m.checkpoint, "sd_xl_turbo_1.0_fp16.safetensors");
        assert_eq!(LiveTemplates.output_nodes("scene-still"), vec!["9".to_string()]);
        assert!(LiveTemplates.check("scene-still").is_ok());
        assert!(LiveTemplates.check("broll-motion").unwrap_err().contains("not built yet"));
        assert!(LiveTemplates.check("nope").unwrap_err().contains("unknown template"));
        // The D: layout (sdxl-turbo/) satisfies the checkpoint; the upscaler is absent.
        let io = FakeIo::new(Step::None);
        let roots = io.models_root();
        assert!(missing_models(&roots, &LiveTemplates.required_models("scene-still")).is_empty());
        assert_eq!(needs_text(&missing_models(&roots, &LiveTemplates.required_models("upscale"))), "needs model upscale_models/4x-UltraSharp.safetensors");
        assert!(!missing_models(&roots, &LiveTemplates.required_models("broll-motion")).is_empty());
    }

    #[test]
    fn a_seed_is_picked_once_and_kept() {
        let a = with_seed(json!({ "prompt": "x" }), 1);
        let b = with_seed(json!({ "prompt": "x" }), 2);
        assert!(a["seed"].as_u64().unwrap() < (1u64 << 53));
        assert_ne!(a["seed"], b["seed"]);
        assert_eq!(with_seed(json!({ "seed": 7 }), 99)["seed"], 7, "a given seed is kept");
        assert!(with_seed(Value::Null, 3)["seed"].is_u64());
    }

    #[test]
    fn an_absolute_input_still_is_staged_into_our_input_dir() {
        let dir = tmp("stage");
        let src = dir.join("project").join("raw");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("still.png"), b"png").unwrap();
        let input = dir.join("input");
        let p = stage_input(&json!({ "inputImage": src.join("still.png").to_string_lossy(), "denoise": 0.5 }), &input, "cj1").unwrap();
        assert_eq!(p["inputImage"], "cj1/still.png");
        assert_eq!(p["denoise"], 0.5);
        assert_eq!(std::fs::read(input.join("cj1").join("still.png")).unwrap(), b"png");
        assert!(crate::commands::comfy_templates::validate_input_image(p["inputImage"].as_str().unwrap()).is_ok());
        // A relative name (already in the input dir / an earlier output) passes through.
        let rel = json!({ "inputImage": "director/x/a.png [output]" });
        assert_eq!(stage_input(&rel, &input, "cj2").unwrap(), rel);
        assert_eq!(stage_input(&json!({}), &input, "cj3").unwrap(), json!({}));
        assert!(stage_input(&json!({ "inputImage": dir.join("missing.png").to_string_lossy() }), &input, "cj4").is_err());
    }
}
