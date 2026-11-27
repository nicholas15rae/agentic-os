//! Phase 3 host trigger: idle auto-compaction and the Settings "Compact & Sync Memory" button.
//!
//! The Rust host never writes scrolls, the knowledge graph, the cold archive or AnythingLLM
//! itself. It launches the host orchestrator CLI (`python -m memory_scrolls compact --json`)
//! while HOLDING the GPU slot (and tells the child so via `AOS_GPU_SLOT_HELD`), reads its NDJSON
//! progress, yields to Tony's queued foreground turns while the child is distilling (D19), and
//! reports a scrubbed outcome (`memory-compaction` event + one bridge log line).
//!
//! Idle = no GPU holder / queue / settle window (no LLM generation), no open task (a Coder
//! build), no Claude Code fix, no live voice turn / TTS playback and, for automatic runs only,
//! no Tony turn inside the quiet window. An ARMED wake-word mic is idle: VAD energy outside an
//! assistant turn (room noise, a wake-word candidate) and wake-word STT never count as busy —
//! they used to keep the quiet window from ever elapsing, so the pending buffer grew far past
//! its threshold. Auto-compaction is OFF by default (`memory.scrolls.autoCompact`).
//!
//! High-water mark: at 2× the threshold a low-priority compaction runs BETWEEN turns (the quiet
//! window is skipped, everything else still has to be idle, and Tony queueing kills it while it
//! distills). After a clean auto run that leaves the buffer over its threshold, the next check
//! runs again (backlog drain) instead of waiting for new material.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::claude_fix::Exit;
use super::envelope::clip;
use super::os_core::ScrollsConfig;
use super::scheduler::SlotView;

/// The GPU slot label the compaction holds (the CLI checks the same token).
pub const SLOT_LABEL: &str = "memory · compact";
/// Webview event with every outcome.
pub const EVENT: &str = "memory-compaction";
/// The CLI's "deferred" exit code.
pub const EXIT_DEFERRED: i32 = 75;
/// LM calls for a manual run (the CLI default).
pub const MANUAL_MAX_BATCHES: u32 = 4;
const RUN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// Without new work the auto loop still re-checks the pending size this often.
const STATUS_EVERY: Duration = Duration::from_secs(30 * 60);
/// Longest wait for the (already idle) GPU slot before deferring.
const SLOT_WAIT: Duration = Duration::from_secs(30);

/// Last Tony turn / TTS activity (epoch ms). Wake-word STT does not touch it.
pub static LAST_INTERACTIVE_MS: AtomicU64 = AtomicU64::new(0);
/// New Tier-1 material since the last status check (starts true: check once after launch).
static DIRTY: AtomicBool = AtomicBool::new(true);
static RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_RESULT: Mutex<Option<Value>> = Mutex::new(None);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// A Tony turn / STT / TTS call started or ended (cheap; called on the hot path).
pub fn touch() {
    LAST_INTERACTIVE_MS.store(now_ms(), Ordering::Relaxed);
    DIRTY.store(true, Ordering::Relaxed);
}

/// `touch()` now and again when dropped (entry and exit of a Tony turn / STT / TTS call).
pub struct Touch;
impl Touch {
    pub fn start() -> Self {
        touch();
        Touch
    }
}
impl Drop for Touch {
    fn drop(&mut self) {
        touch();
        // Between turns: the loop checks the high-water mark (cheap; it ignores the kick below it).
        kick().notify_one();
    }
}

fn kick() -> &'static tokio::sync::Notify {
    static K: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    K.get_or_init(tokio::sync::Notify::new)
}

/// A task finished (new Tier-1 material); cheap.
pub fn mark_dirty() {
    DIRTY.store(true, Ordering::Relaxed);
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Why compaction must wait (structured, for the Settings badge).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IdleWait {
    Gpu,
    ForegroundQueued,
    BackgroundQueued,
    Settling,
    Build,
    ClaudeFix,
    Voice,
    Quiet { secs_left: u64 },
}

impl IdleWait {
    /// The short reason (event / log text; stable strings).
    pub fn reason(&self) -> String {
        match self {
            Self::Gpu => "gpu busy".into(),
            Self::ForegroundQueued => "foreground queued".into(),
            Self::BackgroundQueued => "background queued".into(),
            Self::Settling => "gpu settling".into(),
            Self::Build => "coder build running".into(),
            Self::ClaudeFix => "claude fix running".into(),
            Self::Voice => "voice active".into(),
            Self::Quiet { .. } => "recent activity".into(),
        }
    }
}

/// Why compaction must wait right now (`None` = idle). Pure. The compaction's own slot label is
/// ignored, so the re-check after acquiring the slot sees only other holders. `audio` is
/// `(turn_active, playing, in_speech)`: only an assistant turn (generating / speaking) or TTS
/// playback is busy — speech energy while the wake-word mic is merely armed is not.
#[allow(clippy::too_many_arguments)]
pub fn idle_wait(view: &SlotView, open_tasks: usize, claude_fix_busy: bool, audio: Option<(bool, bool, bool)>, last_ms: u64, now_ms: u64, quiet_ms: u64, manual: bool) -> Option<IdleWait> {
    if view.active.iter().any(|a| a != SLOT_LABEL) {
        return Some(IdleWait::Gpu);
    }
    if view.queued_foreground > 0 {
        return Some(IdleWait::ForegroundQueued);
    }
    if view.queued_background > 0 {
        return Some(IdleWait::BackgroundQueued);
    }
    if view.settling > 0 {
        return Some(IdleWait::Settling);
    }
    if open_tasks > 0 {
        return Some(IdleWait::Build);
    }
    if claude_fix_busy {
        return Some(IdleWait::ClaudeFix);
    }
    if let Some((turn, playing, _speech)) = audio {
        if turn || playing {
            return Some(IdleWait::Voice);
        }
    }
    if !manual && last_ms > 0 {
        let since = now_ms.saturating_sub(last_ms);
        if since < quiet_ms {
            return Some(IdleWait::Quiet { secs_left: (quiet_ms - since).div_ceil(1000) });
        }
    }
    None
}

/// `idle_wait` as its short reason text (`None` = idle).
#[allow(clippy::too_many_arguments)]
#[cfg_attr(not(test), allow(dead_code))]
pub fn idle_reason(view: &SlotView, open_tasks: usize, claude_fix_busy: bool, audio: Option<(bool, bool, bool)>, last_ms: u64, now_ms: u64, quiet_ms: u64, manual: bool) -> Option<String> {
    idle_wait(view, open_tasks, claude_fix_busy, audio, last_ms, now_ms, quiet_ms, manual).map(|w| w.reason())
}

/// The inline status badge next to "Auto-compact when idle".
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdleBadge {
    /// "ready" | "waiting" | "compacting" | "off"
    pub state: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secs_left: Option<u64>,
}

/// Badge text (pure): `Idle — Ready`, `Waiting: Voice active`, `Waiting: Quiet window 45s`,
/// `Compacting…`.
pub fn badge(auto: bool, running: bool, wait: Option<&IdleWait>) -> IdleBadge {
    if running {
        return IdleBadge { state: "compacting", label: "Compacting…".into(), secs_left: None };
    }
    let (label, secs) = match wait {
        None => ("Idle — Ready".to_string(), None),
        Some(IdleWait::Quiet { secs_left }) => (
            if *secs_left >= 120 { format!("Waiting: Quiet window {}m", secs_left.div_ceil(60)) } else { format!("Waiting: Quiet window {secs_left}s") },
            Some(*secs_left),
        ),
        Some(IdleWait::Voice) => ("Waiting: Voice active".into(), None),
        Some(IdleWait::Gpu) => ("Waiting: LLM generating".into(), None),
        Some(IdleWait::ForegroundQueued) => ("Waiting: Tony's turn queued".into(), None),
        Some(IdleWait::BackgroundQueued) => ("Waiting: GPU queue".into(), None),
        Some(IdleWait::Settling) => ("Waiting: GPU settling".into(), None),
        Some(IdleWait::Build) => ("Waiting: Build running".into(), None),
        Some(IdleWait::ClaudeFix) => ("Waiting: Claude fix running".into(), None),
    };
    if !auto {
        return IdleBadge { state: "off", label: if wait.is_none() { "Off — Idle (manual only)".into() } else { format!("Off — {}", label.trim_start_matches("Waiting: ")) }, secs_left: None };
    }
    IdleBadge { state: if wait.is_none() { "ready" } else { "waiting" }, label, secs_left: secs }
}

/// Which kind of run (quiet window, LM batches, log label).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The Settings button (and purge / sweep): ignores the threshold and the quiet window.
    Manual,
    /// The idle loop over the threshold.
    Auto,
    /// At / over the 2× high-water mark, between turns: quiet window skipped, more batches.
    HighWater,
}

impl Mode {
    fn skips_quiet(self) -> bool {
        self != Mode::Auto
    }
    fn batches(self, auto_batches: u32) -> u32 {
        if self == Mode::Auto {
            auto_batches
        } else {
            MANUAL_MAX_BATCHES
        }
    }
}

/// The CLI `status --json` says the raw buffer crossed a threshold (bytes OR turns).
pub fn threshold_hit(status: &Value, threshold_kb: u32, threshold_turns: u32) -> bool {
    let p = &status["pending"];
    p["bytes"].as_u64().unwrap_or(0) >= threshold_kb as u64 * 1024 || p["turns"].as_u64().unwrap_or(0) >= threshold_turns as u64
}

/// While the child distills (an LM generation may be in flight), queued foreground work kills
/// it; during `write` / `sync` it is let finish (seconds) so the sync ledger never misses a doc.
pub fn should_kill(phase: &str, fg_queued: usize) -> bool {
    phase == "distill" && fg_queued > 0
}

/// One NDJSON stdout line of the CLI.
#[derive(Debug, PartialEq)]
pub enum Line {
    Phase(String),
    Result(Value),
    Other,
}

pub fn parse_line(line: &str) -> Line {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return Line::Other };
    match v["event"].as_str() {
        Some("phase") => v["phase"].as_str().map(|p| Line::Phase(p.to_string())).unwrap_or(Line::Other),
        Some("result") => Line::Result(v),
        _ => Line::Other,
    }
}

/// The interpreter to run the CLI with: the gateway's own Python when it is one, else `python`.
pub fn python_program(gateway_command: &str) -> String {
    let c = gateway_command.trim();
    let stem = Path::new(c).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if !c.is_empty() && (stem.starts_with("python") || stem == "py") {
        c.to_string()
    } else {
        "python".into()
    }
}

/// A CLI launch: no secret is ever in `args` (the AnythingLLM key travels in `env` only).
#[derive(Clone, PartialEq)]
pub struct CliSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

impl std::fmt::Debug for CliSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: Vec<(&str, &str)> = self.env.iter().map(|(k, v)| (k.as_str(), if k.contains("KEY") { "[redacted]" } else { v.as_str() })).collect();
        f.debug_struct("CliSpec").field("program", &self.program).field("args", &self.args).field("cwd", &self.cwd).field("env", &env).finish()
    }
}

impl CliSpec {
    #[cfg(test)]
    pub fn env_get(&self, k: &str) -> Option<&str> {
        self.env.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
    }

    fn to_command(&self) -> std::process::Command {
        let mut c = std::process::Command::new(&self.program);
        c.args(&self.args).current_dir(&self.cwd);
        for (k, v) in &self.env {
            c.env(k, v);
        }
        c
    }
}

/// `python -m memory_scrolls <sub_args>` in the repo. `hold_slot` = the host holds the GPU slot
/// for the child (compact only; `status` never takes it).
pub fn build_command(python: &str, workdir: &Path, sub_args: &[String], sc: &ScrollsConfig, lm_base: Option<&str>, allm_key: Option<&str>, hold_slot: bool) -> CliSpec {
    let mut args = vec!["-m".to_string(), "memory_scrolls".to_string()];
    args.extend(sub_args.iter().cloned());
    let mut env: Vec<(String, String)> = vec![
        ("PYTHONIOENCODING".into(), "utf-8".into()),
        ("PYTHONUTF8".into(), "1".into()),
        ("AOS_REPO_ROOT".into(), workdir.display().to_string()),
        ("MEMORY_SCROLLS_WORKSPACE".into(), sc.sanitized_workspace()),
    ];
    if let Some(b) = lm_base.map(str::trim).filter(|b| !b.is_empty()) {
        env.push(("AOS_LMSTUDIO_BASE".into(), b.to_string()));
    }
    // Never hand the CLI a dir under the read-only C:\ai-hub (the CLI refuses it too). A configured
    // scrolls dir that was dropped is replaced by the default explicitly, so the CLI writes where the
    // Settings card and the Librarian read (it also ignores a hub value it finds in os.json itself).
    let configured_scrolls = !sc.scrolls_dir.trim().is_empty();
    let sc = sc.sanitized();
    if !sc.scrolls_dir.is_empty() {
        env.push(("MEMORY_SCROLLS_DIR".into(), sc.scrolls_dir.clone()));
    } else if configured_scrolls {
        env.push(("MEMORY_SCROLLS_DIR".into(), super::os_core::DEFAULT_SCROLLS_DIR.into()));
    }
    if !sc.archive_dir.is_empty() {
        env.push(("MEMORY_ARCHIVE_DIR".into(), sc.archive_dir.clone()));
    }
    if hold_slot {
        env.push(("AOS_GPU_SLOT_HELD".into(), SLOT_LABEL.into()));
    }
    if let Some(k) = allm_key.filter(|k| !k.is_empty()) {
        env.push(("ANYTHINGLLM_API_KEY".into(), k.to_string()));
    }
    CliSpec { program: python.to_string(), args, cwd: workdir.to_path_buf(), env }
}

/// What a run came to (the Settings card and the event show it as one line).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactOutcome {
    /// Why it did not run / stopped early (busy, yielded, the CLI's own deferral).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The CLI result (archive ids, scrolls updated, sync counts, warnings), scrubbed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<i32>,
    pub manual: bool,
    pub at: u64,
}

impl CompactOutcome {
    fn deferred(reason: &str, manual: bool) -> Self {
        Self { deferred: Some(reason.to_string()), manual, at: now_ms(), ..Default::default() }
    }
}

/// Scrub every string of a JSON value (re-parsed; on a parse failure the scrubbed text stands).
pub fn scrub_value(v: &Value, known: &[String]) -> Value {
    let s = super::devqueue::scrub(&v.to_string(), known);
    serde_json::from_str(&s).unwrap_or(Value::String(clip(&s, 2000)))
}

/// Map the child's exit + last `result` line to an outcome. Pure.
pub fn outcome_from(exit: &Exit, result: Option<Value>, stderr_tail: &str, manual: bool, known: &[String]) -> CompactOutcome {
    let mut out = CompactOutcome { manual, at: now_ms(), ..Default::default() };
    let result = result.map(|mut r| {
        if let Some(o) = r.as_object_mut() {
            o.remove("event");
        }
        scrub_value(&r, known)
    });
    match exit {
        Exit::Cancelled => out.deferred = Some("yielded to foreground".into()),
        Exit::TimedOut => out.error = Some("timed out after 15 minutes".into()),
        Exit::Code(code) => {
            out.exit = *code;
            match code {
                Some(0) => out.result = result,
                Some(EXIT_DEFERRED) => {
                    out.deferred = Some(result.as_ref().and_then(|r| r["deferred"].as_str().map(|s| clip(s, 200))).unwrap_or_else(|| "deferred".into()));
                }
                _ => {
                    let msg = result.as_ref().and_then(|r| r["error"].as_str().map(String::from)).unwrap_or_else(|| {
                        let tail = stderr_tail.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
                        if tail.is_empty() {
                            format!("exited with code {}", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
                        } else {
                            tail
                        }
                    });
                    out.error = Some(clip(&super::devqueue::scrub(&msg, known), 300));
                }
            }
        }
    }
    out
}

// ── App wiring ──────────────────────────────────────────────────────────────

/// Non-terminal tasks in tasks.db (read-only connection, SELECT only). 0 when unavailable.
fn open_tasks(store: &super::envelope::TaskStore) -> usize {
    let Some(path) = store.path() else { return 0 };
    let Ok(conn) = super::envelope::open_read_only(&path) else { return 0 };
    let terminal = super::envelope::TERMINAL.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
    conn.query_row(&format!("SELECT COUNT(*) FROM task_envelope WHERE status NOT IN ({terminal})"), [], |r| r.get::<_, i64>(0)).map(|n| n.max(0) as usize).unwrap_or(0)
}

/// `idle_wait` over the running app's live signals.
pub fn current_idle_wait(app: &tauri::AppHandle, quiet_mins: u32, manual: bool) -> Option<IdleWait> {
    use tauri::Manager;
    let os = app.state::<super::os_core::OsState>();
    let view = os.slot.view();
    let open = open_tasks(app.state::<super::envelope::TaskStore>().inner());
    let fix = app.state::<super::claude_fix::ClaudeFixState>().is_busy();
    let audio = app.state::<crate::audio::commands::AudioEngineState>().activity();
    idle_wait(&view, open, fix, audio, LAST_INTERACTIVE_MS.load(Ordering::Relaxed), now_ms(), quiet_mins as u64 * 60_000, manual)
}

/// Is the USER busy (a voice turn / Tony speaking, or an interactive turn inside the quiet
/// window)? Unlike `current_idle_wait` it ignores builds, queued tasks, the GPU baton and Claude
/// fixes: cheap file maintenance (the Garbage daemon) must not be starved by a task that sits
/// queued or stuck for days.
pub fn user_busy_reason(app: &tauri::AppHandle, quiet_mins: u32) -> Option<String> {
    use tauri::Manager;
    let audio = app.state::<crate::audio::commands::AudioEngineState>().activity();
    user_busy(audio, LAST_INTERACTIVE_MS.load(Ordering::Relaxed), now_ms(), quiet_mins as u64 * 60_000).map(|w| w.reason())
}

/// Pure part of `user_busy_reason`.
pub fn user_busy(audio: Option<(bool, bool, bool)>, last_ms: u64, now_ms: u64, quiet_ms: u64) -> Option<IdleWait> {
    if let Some((turn, playing, _speech)) = audio {
        if turn || playing {
            return Some(IdleWait::Voice);
        }
    }
    let since = now_ms.saturating_sub(last_ms);
    (last_ms > 0 && since < quiet_ms).then(|| IdleWait::Quiet { secs_left: (quiet_ms - since).div_ceil(1000) })
}

/// `idle_reason` over the running app's live signals.
pub fn current_idle_reason(app: &tauri::AppHandle, quiet_mins: u32, manual: bool) -> Option<String> {
    current_idle_wait(app, quiet_mins, manual).map(|w| w.reason())
}

struct Launch {
    python: String,
    workdir: PathBuf,
    lm_base: Option<String>,
    key: Option<String>,
    known: Vec<String>,
}

fn launch_inputs(app: &tauri::AppHandle, with_key: bool) -> Launch {
    use tauri::Manager;
    let st = app.state::<super::dispatch::DispatchState>();
    let os = app.state::<super::os_core::OsState>();
    let gw = st.snapshot().gateway;
    let key = if with_key { super::secrets::get(&st, "anythingllm") } else { None };
    let mut known = super::devqueue::known_secrets(&st, &os);
    known.extend(key.clone());
    Launch { python: python_program(&gw.command), workdir: PathBuf::from(gw.workdir), lm_base: st.provider("lmstudio").map(|p| p.base_url), key, known }
}

/// Run the CLI to completion off the async runtime. `cancel` kills it (whole job).
async fn run_cli(spec: CliSpec, deadline: Duration, cancel: Arc<AtomicBool>, phase: Arc<Mutex<String>>) -> Result<(Exit, Option<Value>, String), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = spec.to_command();
        let mut result: Option<Value> = None;
        let r = super::claude_fix::run_process(&mut cmd, None, Instant::now() + deadline, &cancel, |l| match parse_line(l) {
            Line::Phase(p) => *phase.lock().unwrap() = p,
            Line::Result(v) => result = Some(v),
            Line::Other => {}
        });
        r.map(|(exit, err)| (exit, result, err)).map_err(|e| format!("could not start {}: {e}", spec.program))
    })
    .await
    .map_err(|e| format!("compaction task failed: {e}"))?
}

/// `python -m memory_scrolls status --json` (read-only, no GPU slot, 10 s).
pub async fn run_status(app: &tauri::AppHandle) -> Result<Value, String> {
    use tauri::Manager;
    let sc = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.sanitized();
    let l = launch_inputs(app, false);
    let mut spec = build_command(&l.python, &l.workdir, &["status".into(), "--json".into()], &sc, l.lm_base.as_deref(), None, false);
    spec.env.retain(|(k, _)| k != "AOS_GPU_SLOT_HELD");
    let (exit, result, err) = run_cli(spec, STATUS_TIMEOUT, Arc::new(AtomicBool::new(false)), Arc::default()).await?;
    let out = outcome_from(&exit, result, &err, true, &l.known);
    match (out.result, out.error, out.deferred) {
        (Some(r), _, _) => Ok(r),
        (_, Some(e), _) => Err(e),
        (_, _, Some(d)) => Err(d),
        _ => Err("no status".into()),
    }
}

/// Clears `RUNNING` however the run ends.
struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// One compaction run (manual button or the idle loop). Never throws: busy / yielded / CLI
/// deferrals come back as `deferred`.
pub async fn run_compact(app: &tauri::AppHandle, manual: bool) -> CompactOutcome {
    run_compact_mode(app, if manual { Mode::Manual } else { Mode::Auto }).await
}

pub async fn run_compact_mode(app: &tauri::AppHandle, mode: Mode) -> CompactOutcome {
    use tauri::{Emitter, Manager};
    let manual = mode == Mode::Manual;
    let out = if RUNNING.swap(true, Ordering::SeqCst) {
        CompactOutcome::deferred("a compaction is already running", manual)
    } else {
        let _g = RunningGuard;
        compact_inner(app, mode).await
    };
    *LAST_RESULT.lock().unwrap() = serde_json::to_value(&out).ok();
    let _ = app.emit(EVENT, &out);
    if out.deferred.is_none() || manual {
        let r = out.result.as_ref();
        app.state::<super::bridge::BridgeState>().log(json!({
            "type": "memory-compaction",
            "manual": manual,
            "deferred": out.deferred,
            "error": out.error,
            "archives": r.and_then(|r| r["archive_ids"].as_array().map(|a| a.len())).unwrap_or(0),
            "scrollsUpdated": r.and_then(|r| r["scrolls_updated"].as_array().map(|a| a.len())).unwrap_or(0),
            "llm": r.and_then(|r| r["llm"].as_str()).unwrap_or(""),
            "highWater": mode == Mode::HighWater,
        }));
    }
    if out.deferred.is_none() {
        super::hygiene::audit("compaction", if mode == Mode::HighWater { "high-water" } else if manual { "manual" } else { "auto" }, out.error.is_none(), out.error.as_deref().unwrap_or("compacted + synced"));
        // The newest scroll becomes the thread seed / hot-path summary (blocking pool).
        let root = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.scrolls_root();
        tauri::async_runtime::spawn(super::hygiene::refresh_seed(root));
    }
    eprintln!("[memory] compaction ({}): {}", if manual { "manual" } else { "auto" }, out.deferred.as_deref().or(out.error.as_deref()).unwrap_or("done"));
    out
}

async fn compact_inner(app: &tauri::AppHandle, mode: Mode) -> CompactOutcome {
    use tauri::Manager;
    let manual = mode == Mode::Manual;
    let quiet_skip = mode.skips_quiet();
    let os = app.state::<super::os_core::OsState>();
    let cfg = os.snapshot();
    let sc = cfg.memory.scrolls.sanitized();
    if let Some(r) = current_idle_reason(app, sc.quiet_mins, quiet_skip) {
        return CompactOutcome::deferred(&r, manual);
    }
    let Ok(mut guard) = tokio::time::timeout(SLOT_WAIT, os.slot.acquire(SLOT_LABEL, false, cfg.scheduler.tony_priority_pct)).await else {
        return CompactOutcome::deferred("gpu busy", manual);
    };
    // Something may have started while the slot was being taken.
    if let Some(r) = current_idle_reason(app, sc.quiet_mins, quiet_skip) {
        return CompactOutcome::deferred(&r, manual);
    }
    guard.arm_settle(cfg.scheduler.settle());
    let l = launch_inputs(app, true);
    let batches = mode.batches(sc.max_batches_auto);
    let spec = build_command(&l.python, &l.workdir, &["compact".into(), "--json".into(), "--max-batches".into(), batches.to_string()], &sc, l.lm_base.as_deref(), l.key.as_deref(), true);
    let cancel = Arc::new(AtomicBool::new(false));
    let phase: Arc<Mutex<String>> = Arc::default();
    let done = Arc::new(AtomicBool::new(false));
    // D19 watcher: Tony queued while the child distills -> kill it (the slot then settles).
    {
        let (app, cancel, phase, done) = (app.clone(), cancel.clone(), phase.clone(), done.clone());
        tauri::async_runtime::spawn(async move {
            while !done.load(Ordering::SeqCst) {
                let fg = app.state::<super::os_core::OsState>().slot.view().queued_foreground;
                if should_kill(&phase.lock().unwrap(), fg) {
                    cancel.store(true, Ordering::SeqCst);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
    }
    let ran = run_cli(spec, RUN_TIMEOUT, cancel, phase).await;
    done.store(true, Ordering::SeqCst);
    match ran {
        Ok((exit, result, err)) => {
            if matches!(exit, Exit::Code(_)) {
                // The child ended on its own: no generation is in flight.
                guard.disarm();
            }
            outcome_from(&exit, result, &err, manual, &l.known)
        }
        Err(e) => {
            guard.disarm();
            CompactOutcome { error: Some(clip(&super::devqueue::scrub(&e, &l.known), 300)), manual, at: now_ms(), ..Default::default() }
        }
    }
}

/// Idle auto-compaction (spawned once in lib.rs). Off unless `memory.scrolls.autoCompact`;
/// never queues behind voice; the regular check runs every `checkSecs`, and the end of a turn
/// wakes it early only when the buffer is at the 2× high-water mark.
pub async fn compaction_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(Duration::from_secs(90)).await;
    let mut last_status: Option<Instant> = None;
    let mut next_check = tokio::time::Instant::now();
    loop {
        let kicked = tokio::select! {
            _ = tokio::time::sleep_until(next_check) => false,
            _ = kick().notified() => true,
        };
        let sc = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.sanitized();
        if !kicked {
            next_check = tokio::time::Instant::now() + Duration::from_secs(sc.check_secs.max(60) as u64);
        }
        if !sc.auto_compact || is_running() || super::hygiene::is_harvesting() {
            continue;
        }
        let hw = super::hygiene::last_pending().is_some_and(|(b, t)| super::hygiene::high_water(b, t, sc.threshold_kb, sc.threshold_turns));
        if kicked {
            if !hw {
                continue;
            }
            // Between turns: let the reply's TTS finish, then run at low priority.
            let mut clear = false;
            for _ in 0..12 {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if current_idle_reason(&app, sc.quiet_mins, true).is_none() {
                    clear = true;
                    break;
                }
            }
            if !clear {
                continue;
            }
        } else if !hw && !app.state::<super::os_core::OsState>().slot.is_idle() {
            continue;
        }
        let due = last_status.is_none_or(|t: Instant| t.elapsed() >= STATUS_EVERY);
        if !hw && !DIRTY.load(Ordering::Relaxed) && !due {
            continue;
        }
        if current_idle_reason(&app, sc.quiet_mins, hw).is_some() {
            continue;
        }
        DIRTY.store(false, Ordering::Relaxed);
        last_status = Some(Instant::now());
        match run_status(&app).await {
            Ok(st) => {
                super::hygiene::note_pending(&st);
                if threshold_hit(&st, sc.threshold_kb, sc.threshold_turns) {
                    let p = &st["pending"];
                    let high = super::hygiene::high_water(p["bytes"].as_u64().unwrap_or(0), p["turns"].as_u64().unwrap_or(0), sc.threshold_kb, sc.threshold_turns);
                    let out = run_compact_mode(&app, if high { Mode::HighWater } else { Mode::Auto }).await;
                    // Backlog drain: a clean run may leave the buffer over its threshold (one
                    // batch per auto run) — re-check on the next tick instead of waiting for new
                    // material or the 30-minute status timer.
                    if out.deferred.is_none() && out.error.is_none() {
                        DIRTY.store(true, Ordering::Relaxed);
                    }
                }
            }
            Err(e) => eprintln!("[memory] compaction status: {}", clip(&e, 200)),
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Settings "Compact & Sync Memory": runs now if idle (the size threshold and the quiet window
/// are ignored); a busy system comes back as `deferred`, never an error.
#[tauri::command]
pub async fn memory_compact(app: tauri::AppHandle) -> Result<CompactOutcome, String> {
    Ok(run_compact(&app, true).await)
}

/// The Settings card: CLI `status --json` + auto settings, the last outcome, running / idle state.
#[tauri::command]
pub async fn memory_compaction_status(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri::Manager;
    let sc = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.sanitized();
    let status = if is_running() { Err("a compaction is running".to_string()) } else { run_status(&app).await };
    if let Ok(st) = &status {
        super::hygiene::note_pending(st);
    }
    let known = launch_inputs(&app, false).known;
    let wait = idle_state_wait(&app, sc.quiet_mins).await;
    let pending = super::hygiene::last_pending();
    let v = json!({
        "status": status.as_ref().ok(),
        "statusError": status.as_ref().err(),
        "auto": sc.auto_compact,
        "embedOnly": sc.embed_only,
        "workspace": sc.workspace,
        "thresholds": { "kb": sc.threshold_kb, "turns": sc.threshold_turns },
        "quietMins": sc.quiet_mins,
        "lastResult": LAST_RESULT.lock().unwrap().clone(),
        "running": is_running(),
        "idleReason": current_idle_reason(&app, sc.quiet_mins, true),
        "badge": badge(sc.auto_compact, is_running(), wait.as_ref()),
        "highWater": pending.is_some_and(|(b, t)| super::hygiene::high_water(b, t, sc.threshold_kb, sc.threshold_turns)),
        "preset": super::hygiene::preset_name(sc.threshold_kb, sc.threshold_turns),
    });
    Ok(scrub_value(&v, &known))
}

/// The live idle wait for the badge (auto rules: quiet window included), off the main thread
/// (it opens tasks.db read-only).
async fn idle_state_wait(app: &tauri::AppHandle, quiet_mins: u32) -> Option<IdleWait> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || current_idle_wait(&a, quiet_mins, false)).await.ok().flatten()
}

/// The inline badge next to "Auto-compact when idle" (cheap: no CLI; polled by Settings).
#[tauri::command]
pub async fn memory_idle_state(app: tauri::AppHandle) -> Result<IdleBadge, String> {
    use tauri::Manager;
    let sc = app.state::<super::os_core::OsState>().snapshot().memory.scrolls.sanitized();
    let wait = idle_state_wait(&app, sc.quiet_mins).await;
    Ok(badge(sc.auto_compact, is_running(), wait.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(active: &[&str], fg: usize, bg: usize, settling: usize) -> SlotView {
        SlotView { active: active.iter().map(|s| s.to_string()).collect(), queued_foreground: fg, queued_background: bg, capacity: 1, settling, waiting: vec![], away: false }
    }

    #[test]
    fn idle_reason_names_each_busy_signal() {
        let idle = view(&[], 0, 0, 0);
        let now = 10_000_000;
        let quiet = 10 * 60_000;
        let r = |v: &SlotView, open: usize, fix: bool, audio: Option<(bool, bool, bool)>, last: u64, manual: bool| idle_reason(v, open, fix, audio, last, now, quiet, manual);
        assert_eq!(r(&view(&["tony"], 0, 0, 0), 0, false, None, 0, true).as_deref(), Some("gpu busy"));
        assert_eq!(r(&view(&[], 1, 0, 0), 0, false, None, 0, true).as_deref(), Some("foreground queued"));
        assert_eq!(r(&view(&[], 0, 1, 0), 0, false, None, 0, true).as_deref(), Some("background queued"));
        assert_eq!(r(&view(&[], 0, 0, 1), 0, false, None, 0, true).as_deref(), Some("gpu settling"));
        assert_eq!(r(&idle, 2, false, None, 0, true).as_deref(), Some("coder build running"));
        assert_eq!(r(&idle, 0, true, None, 0, true).as_deref(), Some("claude fix running"));
        for a in [(true, false, false), (false, true, false), (true, false, true)] {
            assert_eq!(r(&idle, 0, false, Some(a), 0, true).as_deref(), Some("voice active"), "{a:?}");
        }
        // An armed wake-word mic hearing room noise (speech energy, no assistant turn) is idle.
        assert_eq!(r(&idle, 0, false, Some((false, false, true)), 0, true), None);
        assert_eq!(r(&idle, 0, false, Some((false, false, true)), 0, false), None);
        // The quiet window: auto runs wait, the manual button ignores it.
        assert_eq!(r(&idle, 0, false, Some((false, false, false)), now - 60_000, false).as_deref(), Some("recent activity"));
        assert_eq!(r(&idle, 0, false, Some((false, false, false)), now - 60_000, true), None);
        assert_eq!(r(&idle, 0, false, None, now - quiet - 1, false), None, "the quiet window has passed");
        assert_eq!(r(&idle, 0, false, None, 0, false), None, "no activity yet");
        // All clear.
        assert_eq!(r(&idle, 0, false, None, 0, true), None);
        // The compaction's own slot label does not count as busy (re-check after acquiring).
        assert_eq!(r(&view(&[SLOT_LABEL], 0, 0, 0), 0, false, None, 0, true), None);
        assert_eq!(r(&view(&[SLOT_LABEL, "tony"], 0, 0, 0), 0, false, None, 0, true).as_deref(), Some("gpu busy"));
    }

    #[test]
    fn threshold_is_bytes_or_turns() {
        let s = |b: u64, t: u64| json!({ "pending": { "bytes": b, "turns": t, "records": 1 } });
        assert!(!threshold_hit(&s(50 * 1024 - 1, 24), 50, 25));
        assert!(threshold_hit(&s(50 * 1024, 0), 50, 25));
        assert!(threshold_hit(&s(0, 25), 50, 25));
        assert!(!threshold_hit(&json!({}), 50, 25), "a status without pending never triggers");
    }

    #[test]
    fn build_command_keeps_secrets_out_of_args_and_holds_the_slot() {
        let mut sc = ScrollsConfig::default();
        let key = "allm-SECRET-KEY-123";
        let c = build_command("python", Path::new("D:/repo"), &["compact".into(), "--json".into(), "--max-batches".into(), "1".into()], &sc, Some("http://127.0.0.1:1235/v1"), Some(key), true);
        assert_eq!(c.program, "python");
        assert_eq!(c.args, vec!["-m", "memory_scrolls", "compact", "--json", "--max-batches", "1"]);
        assert!(c.args.iter().all(|a| !a.contains(key)));
        assert_eq!(c.env_get("ANYTHINGLLM_API_KEY"), Some(key));
        assert_eq!(c.env_get("AOS_GPU_SLOT_HELD"), Some(SLOT_LABEL));
        assert_eq!(c.env_get("AOS_LMSTUDIO_BASE"), Some("http://127.0.0.1:1235/v1"));
        assert_eq!(c.env_get("PYTHONIOENCODING"), Some("utf-8"));
        assert_eq!(c.env_get("MEMORY_SCROLLS_WORKSPACE"), Some("librarian"));
        // Unset dirs are not passed (the CLI resolves them; nothing is written to .env).
        assert_eq!((c.env_get("MEMORY_SCROLLS_DIR"), c.env_get("MEMORY_ARCHIVE_DIR")), (None, None));
        assert!(!format!("{c:?}").contains(key), "Debug redacts the key");
        sc.scrolls_dir = "D:/scrolls".into();
        sc.archive_dir = "E:/arch".into();
        sc.workspace = "booking".into();
        let s = build_command("python", Path::new("D:/repo"), &["status".into(), "--json".into()], &sc, None, None, false);
        assert_eq!((s.env_get("MEMORY_SCROLLS_DIR"), s.env_get("MEMORY_ARCHIVE_DIR")), (Some("D:/scrolls"), Some("E:/arch")));
        assert_eq!(s.env_get("MEMORY_SCROLLS_WORKSPACE"), Some("librarian"), "a Booking workspace is never passed");
        // A scrolls / archive dir under the read-only C:\ai-hub is never passed: the scrolls dir is
        // replaced by the default (what Settings and the Librarian show), the archive dir is left to
        // the CLI chain (which skips a hub archiveDir from os.json).
        for hub in [r"c:/AI-HUB/memory/scrolls", r"\\localhost\C$\ai-hub\memory\scrolls"] {
            sc.scrolls_dir = hub.into();
            sc.archive_dir = r"\\?\UNC\localhost\c$\ai-hub\archive".into();
            let s = build_command("python", Path::new("D:/repo"), &["status".into(), "--json".into()], &sc, None, None, false);
            assert_eq!((s.env_get("MEMORY_SCROLLS_DIR"), s.env_get("MEMORY_ARCHIVE_DIR")), (Some(crate::commands::os_core::DEFAULT_SCROLLS_DIR), None), "{hub}");
        }
        assert_eq!((s.env_get("AOS_GPU_SLOT_HELD"), s.env_get("ANYTHINGLLM_API_KEY"), s.env_get("AOS_LMSTUDIO_BASE")), (None, None, None));
    }

    #[test]
    fn python_program_prefers_the_gateway_python() {
        assert_eq!(python_program("python"), "python");
        assert_eq!(python_program(r"D:\repo\.venv\Scripts\python.exe"), r"D:\repo\.venv\Scripts\python.exe");
        assert_eq!(python_program("py"), "py");
        assert_eq!(python_program("uvicorn"), "python");
        assert_eq!(python_program(""), "python");
    }

    #[test]
    fn ndjson_lines_parse() {
        assert_eq!(parse_line(r#"{"event":"phase","phase":"distill"}"#), Line::Phase("distill".into()));
        assert!(matches!(parse_line(r#"{"event":"result","exit":0,"archive_ids":["arch-2026-11-19-01"]}"#), Line::Result(v) if v["archive_ids"][0] == "arch-2026-11-19-01"));
        assert_eq!(parse_line("Traceback (most recent call last):"), Line::Other);
        assert_eq!(parse_line(r#"{"event":"phase"}"#), Line::Other);
        assert_eq!(parse_line(""), Line::Other);
    }

    #[test]
    fn preemption_only_while_distilling() {
        assert!(should_kill("distill", 1));
        for p in ["preflight", "collect", "archive", "write", "sync", "done", ""] {
            assert!(!should_kill(p, 3), "{p}");
        }
        assert!(!should_kill("distill", 0));
    }

    #[test]
    fn outcomes_map_exit_codes_and_scrub() {
        let secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789".to_string();
        let ok = outcome_from(&Exit::Code(Some(0)), Some(json!({ "event": "result", "exit": 0, "archive_ids": ["arch-2026-11-19-01"], "warnings": [format!("key {secret}")] })), "", true, &[]);
        assert_eq!(ok.exit, Some(0));
        let r = ok.result.unwrap();
        assert!(r.get("event").is_none());
        assert_eq!(r["archive_ids"][0], "arch-2026-11-19-01");
        assert!(!r.to_string().contains(&secret), "{r}");
        let d = outcome_from(&Exit::Code(Some(75)), Some(json!({ "event": "result", "exit": 75, "deferred": "gpu busy (tony)" })), "", false, &[]);
        assert_eq!(d.deferred.as_deref(), Some("gpu busy (tony)"));
        assert!(d.result.is_none() && d.error.is_none());
        let y = outcome_from(&Exit::Cancelled, None, "", false, &[]);
        assert_eq!(y.deferred.as_deref(), Some("yielded to foreground"));
        let t = outcome_from(&Exit::TimedOut, None, "", false, &[]);
        assert!(t.error.unwrap().contains("timed out"));
        let e = outcome_from(&Exit::Code(Some(2)), Some(json!({ "event": "result", "exit": 2, "error": "the pinned archive root is missing" })), "", true, &[]);
        assert_eq!(e.error.as_deref(), Some("the pinned archive root is missing"));
        let crash = outcome_from(&Exit::Code(Some(1)), None, &format!("Traceback\nValueError: bad {secret}\n"), true, &[]);
        let msg = crash.error.unwrap();
        assert!(msg.starts_with("ValueError") && !msg.contains(&secret), "{msg}");
        let known = vec!["hunter2-known-value".to_string()];
        let k = outcome_from(&Exit::Code(Some(0)), Some(json!({ "warnings": ["hunter2-known-value leaked"] })), "", true, &known);
        assert!(!k.result.unwrap().to_string().contains("hunter2-known-value"));
        // Serialised for the webview: camelCase, no empty fields.
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["deferred"], "gpu busy (tony)");
        assert!(v.get("result").is_none() && v.get("error").is_none());
    }

    #[test]
    fn dirty_and_touch_flags() {
        DIRTY.store(false, Ordering::SeqCst);
        mark_dirty();
        assert!(DIRTY.load(Ordering::SeqCst));
        let before = LAST_INTERACTIVE_MS.load(Ordering::SeqCst);
        touch();
        assert!(LAST_INTERACTIVE_MS.load(Ordering::SeqCst) >= before.max(1));
    }

    /// The host trigger only launches the CLI: it never writes scrolls, the knowledge graph,
    /// the archive, AnythingLLM or `.env` itself.
    #[test]
    fn module_has_no_direct_write_paths() {
        let src = include_str!("compaction.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        // (split literals keep a plain grep of this file for the banned names empty)
        for w in ["AllmWriter", "AllmConn", concat!("remove", "_documents"), concat!("remove", "-documents"), concat!("for", "_scrolls"), "fs::write", "File::create", "OpenOptions", "remove_file", "rename(", "kg_upsert", "envfile::", "set_var"] {
            assert!(!body.contains(w), "compaction.rs must not contain {w}");
        }
    }

    #[test]
    fn idle_wait_and_badges() {
        let idle = view(&[], 0, 0, 0);
        let now = 10_000_000;
        let quiet = 10 * 60_000;
        // Quiet window: seconds left, rounded up.
        let w = idle_wait(&idle, 0, false, Some((false, false, false)), now - (quiet - 45_000), now, quiet, false);
        assert_eq!(w, Some(IdleWait::Quiet { secs_left: 45 }));
        assert_eq!(badge(true, false, w.as_ref()), IdleBadge { state: "waiting", label: "Waiting: Quiet window 45s".into(), secs_left: Some(45) });
        let w = idle_wait(&idle, 0, false, None, now - 1_000, now, quiet, false);
        assert_eq!(badge(true, false, w.as_ref()).label, "Waiting: Quiet window 10m");
        // High-water / manual runs skip the quiet window.
        assert_eq!(idle_wait(&idle, 0, false, None, now - 1_000, now, quiet, true), None);
        assert_eq!(badge(true, false, None), IdleBadge { state: "ready", label: "Idle — Ready".into(), secs_left: None });
        assert_eq!(badge(true, false, Some(&IdleWait::Voice)).label, "Waiting: Voice active");
        assert_eq!(badge(true, true, Some(&IdleWait::Voice)).label, "Compacting…");
        assert_eq!(badge(false, false, None).state, "off");
        assert_eq!(badge(false, false, Some(&IdleWait::Build)).label, "Off — Build running");
        // Every wait keeps its stable reason string.
        assert_eq!(IdleWait::Quiet { secs_left: 3 }.reason(), "recent activity");
        assert_eq!(IdleWait::ClaudeFix.reason(), "claude fix running");
        // Serialized for the webview.
        let v = serde_json::to_value(badge(true, false, Some(&IdleWait::Quiet { secs_left: 45 }))).unwrap();
        assert_eq!((v["state"].as_str(), v["secsLeft"].as_u64()), (Some("waiting"), Some(45)));
    }

    #[test]
    fn modes_pick_quiet_window_and_batches() {
        assert!(!Mode::Auto.skips_quiet() && Mode::HighWater.skips_quiet() && Mode::Manual.skips_quiet());
        assert_eq!(Mode::Auto.batches(1), 1);
        assert_eq!(Mode::HighWater.batches(1), MANUAL_MAX_BATCHES);
        assert_eq!(Mode::Manual.batches(2), MANUAL_MAX_BATCHES);
    }
}
