//! The packet queue dispatcher: runs a validated `TonyDispatch` packet's tasks in `depends_on`
//! order, one GPU step at a time, through the Security and Observer gates.
//!
//! - **DAG**: `tony_dispatch::order` gives a dependency order (cycles were refused at
//!   validation). A task runs only when every dependency is `done`; a failed / halted / refused
//!   dependency blocks its dependents (`blocked`), so a branch stops cleanly.
//! - **GPU relay**: `prompter`, `coder` and `designer` are the only lanes that infer. They run one
//!   at a time across ALL packets (`GPU_RELAY`, a single-holder async mutex), and each model call
//!   also takes the shared `GpuSlot` (Tony preempts it; a preempted step re-runs, no attempt used).
//!   Everything else (librarian staging, security, observer, routing, validation) is CPU-only.
//! - **Security** (zero VRAM): before a task runs, every absolute path in its inputs passes
//!   `security_gate::check_path` (the Finance vault and secret locations are refused); after, its
//!   output passes the secret scanner and fails CLOSED on any hit (dropped, no retry).
//! - **Observer** (zero VRAM): every output is checked against the task's `acceptance_criteria`.
//!   A criterion passes on a matching `[PASS] …` verdict line (with no `[FAIL]` for it) or a
//!   machine check (contains '…', non-empty, no secrets). A miss is retried with the missing
//!   criteria as feedback, at most `RETRY_CAP` times; an identical output twice is drift and halts
//!   at once. Past the cap the branch halts with a structured error for Tony.
//! - When the packet closes, Security sends the purge handshake to the Garbage daemon.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use super::tony_dispatch::{TaskPacket, TonyDispatch};

/// Retries after the first attempt (Observer's hard cap).
pub const RETRY_CAP: u32 = 2;
/// Preemptions tolerated per task before it gives up (Tony talking a lot is not a failure).
const PREEMPT_MAX: u32 = 30;
pub const CONTEXT_MAX: usize = 6000;
pub const OUTPUT_MAX: usize = 12_000;
pub const GPU_AGENTS: [&str; 4] = ["prompter", "coder", "designer", "director"];

pub fn is_gpu(agent: &str) -> bool {
    GPU_AGENTS.contains(&agent)
}

/// The single-holder GPU relay for packet steps.
fn relay() -> &'static tokio::sync::Mutex<()> {
    static R: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    R.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Done,
    Failed,
    Halted,
    Blocked,
    Refused,
    Held,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub criterion: String,
    pub pass: bool,
    pub how: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub task_id: String,
    pub target_agent: String,
    pub status: Status,
    pub attempts: u32,
    pub preempted: u32,
    pub output: Option<String>,
    pub error: Option<String>,
    pub verdicts: Vec<Verdict>,
}

/// How a task's step is executed (the real one calls the model / reads files; tests simulate).
pub trait Exec: Send + Sync {
    fn run<'a>(&'a self, t: &'a TaskPacket, context: &'a str, attempt: u32, feedback: Option<&'a str>) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
}

/// What the gates need.
#[derive(Clone, Debug, Default)]
pub struct Gates {
    pub roots: Vec<PathBuf>,
    pub known: Vec<String>,
}

// ── Observer ────────────────────────────────────────────────────────────────

fn toks(s: &str) -> std::collections::BTreeSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() >= 3).map(str::to_string).collect()
}

fn overlaps(a: &str, b: &str) -> bool {
    let (x, y) = (toks(a), toks(b));
    if x.is_empty() {
        return false;
    }
    x.intersection(&y).count() * 2 >= x.len()
}

fn machine_check(c: &str, output: &str, known: &[String]) -> Option<(bool, String)> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"(?i)\b(?:contains?|includes?|mentions?)\s+["'`]([^"'`]{1,200})["'`]"#).unwrap());
    if let Some(cap) = re.captures(c) {
        let want = &cap[1];
        return Some((output.contains(want), format!("output contains '{want}'")));
    }
    let l = c.to_lowercase();
    if (l.contains("no ") || l.contains("zero ")) && ["secret", "credential", "token", "api key", "leak"].iter().any(|k| l.contains(k)) {
        let hits = super::security_gate::scan_secrets(output, known);
        return Some((hits.is_empty(), "secret scan of the output".into()));
    }
    if l.contains("non-empty") || l.contains("not empty") {
        return Some((!output.trim().is_empty(), "output is non-empty".into()));
    }
    None
}

/// Check one output against a task's acceptance criteria (pure).
pub fn observe(t: &TaskPacket, output: &str, known: &[String]) -> Vec<Verdict> {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    t.acceptance_criteria
        .iter()
        .map(|c| {
            if let Some((pass, how)) = machine_check(c, output, known) {
                return Verdict { criterion: c.clone(), pass, how };
            }
            let tagged = |tag: &str| lines.iter().any(|l| l.to_uppercase().starts_with(tag) && overlaps(c, l));
            let pass = tagged("[PASS]") && !tagged("[FAIL]");
            Verdict { criterion: c.clone(), pass, how: if pass { "verdict line".into() } else { "no [PASS] line for it".into() } }
        })
        .collect()
}

fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.trim().hash(&mut h);
    h.finish()
}

fn abs_inputs(t: &TaskPacket) -> Vec<PathBuf> {
    t.inputs
        .iter()
        .filter_map(|i| {
            let s = i.trim().trim_start_matches("file:").trim_start_matches("path:");
            let p = PathBuf::from(s);
            (p.is_absolute() || s.contains("..")).then_some(p)
        })
        .collect()
}

/// Dependency outputs a task sees (`output:<id>` inputs and its `depends_on`), clipped.
fn context_for(t: &TaskPacket, outputs: &BTreeMap<String, String>) -> String {
    let mut ids: Vec<String> = t.depends_on.clone();
    for i in &t.inputs {
        if let Some(id) = i.trim().strip_prefix("output:") {
            if !ids.iter().any(|x| x == id) {
                ids.push(id.to_string());
            }
        }
    }
    let mut s = String::new();
    for id in ids {
        if let Some(o) = outputs.get(&id) {
            s.push_str(&format!("\n--- output of {id} ---\n{o}\n"));
        }
    }
    super::envelope::clip(&s, CONTEXT_MAX)
}

// ── The dispatcher ──────────────────────────────────────────────────────────

/// Run every task of `d` (already validated) and return one result per task, in DAG order.
pub async fn run_dag(d: &TonyDispatch, exec: &dyn Exec, gates: &Gates) -> Vec<TaskResult> {
    let order = super::tony_dispatch::order(&d.tasks).unwrap_or_default();
    let mut results: Vec<TaskResult> = vec![];
    let mut outputs: BTreeMap<String, String> = BTreeMap::new();
    for t in &order {
        let mk = |status: Status, attempts: u32, error: Option<String>| TaskResult { task_id: t.task_id.clone(), target_agent: t.target_agent.clone(), status, attempts, preempted: 0, output: None, error, verdicts: vec![] };
        // A failed / halted / refused dependency blocks the branch.
        if let Some(dep) = t.depends_on.iter().find(|dep| results.iter().find(|r| &r.task_id == *dep).map(|r| r.status != Status::Done).unwrap_or(true)) {
            results.push(mk(Status::Blocked, 0, Some(format!("dependency {dep} did not complete"))));
            continue;
        }
        if t.target_agent == "financer" {
            results.push(mk(Status::Held, 0, Some("Finance is a sealed vault: it acts only on your unlock or a validated ledger write".into())));
            continue;
        }
        // Security, before: every path the task names.
        if let Some(e) = abs_inputs(t).iter().find_map(|p| super::security_gate::check_path(&t.target_agent, p, &gates.roots).err()) {
            results.push(mk(Status::Refused, 0, Some(e)));
            continue;
        }
        let ctx = context_for(t, &outputs);
        let mut feedback: Option<String> = None;
        let mut prev: Option<u64> = None;
        let mut attempt = 0;
        let mut preempted = 0;
        let res = loop {
            attempt += 1;
            let run = async {
                if is_gpu(&t.target_agent) {
                    let _relay = relay().lock().await;
                    exec.run(t, &ctx, attempt, feedback.as_deref()).await
                } else {
                    exec.run(t, &ctx, attempt, feedback.as_deref()).await
                }
            };
            let out = match run.await {
                Err(e) if super::scheduler::is_preempted(&e) && preempted < PREEMPT_MAX => {
                    preempted += 1;
                    attempt -= 1; // Tony took the GPU: not an attempt
                    continue;
                }
                Err(e) if attempt <= RETRY_CAP => {
                    feedback = Some(format!("The last attempt failed: {e}"));
                    continue;
                }
                Err(e) => break TaskResult { error: Some(format!("halted after {attempt} attempt(s): {e}")), ..mk(Status::Halted, attempt, None) },
                Ok(o) => super::envelope::clip(&o, OUTPUT_MAX),
            };
            // Security, after: fail closed, never retried, never stored.
            if let Err(e) = super::security_gate::gate_output(&t.task_id, &out, &gates.known) {
                break mk(Status::Failed, attempt, Some(e));
            }
            let verdicts = observe(t, &out, &gates.known);
            if verdicts.iter().all(|v| v.pass) {
                break TaskResult { output: Some(out), verdicts, ..mk(Status::Done, attempt, None) };
            }
            let h = hash(&out);
            let missing: Vec<String> = verdicts.iter().filter(|v| !v.pass).map(|v| v.criterion.clone()).collect();
            if prev == Some(h) {
                break TaskResult { verdicts, error: Some(format!("halted: loop/drift, attempt {attempt} repeated the previous output")), ..mk(Status::Halted, attempt, None) };
            }
            if attempt > RETRY_CAP {
                break TaskResult { verdicts, error: Some(format!("halted at the retry cap ({RETRY_CAP} retries): unmet {}", missing.join("; "))), ..mk(Status::Halted, attempt, None) };
            }
            prev = Some(h);
            feedback = Some(format!("Observer: these acceptance criteria are not met yet: {}. Fix them and end with one [PASS]/[FAIL] line per criterion.", missing.join("; ")));
        };
        let res = TaskResult { preempted, ..res };
        if let (Status::Done, Some(o)) = (res.status, &res.output) {
            outputs.insert(t.task_id.clone(), o.clone());
        }
        results.push(res);
    }
    results
}

// ── The real executor ───────────────────────────────────────────────────────

pub fn step_prompt(t: &TaskPacket, context: &str, feedback: Option<&str>) -> (String, String) {
    let role = match t.target_agent.as_str() {
        "prompter" => "You are the Prompter: turn the request into a strict technical spec with acceptance tests.",
        "coder" => "You are the Coder: write the exact code or script asked for (complete, runnable), with a one-line run note.",
        "director" => "You are the Director: turn the media request into a shot / asset checklist and an edit plan (clip order, trims, captions, loudness target, output spec). Never claim a render ran.",
        _ => "You are the Designer: lay out the UI/UX: component hierarchy, styling and the visual flow.",
    };
    let system = format!("{role} Stay strictly inside the constraints. Never print secrets, keys or tokens. End with one line per acceptance criterion: `[PASS] <criterion>: <evidence>` or `[FAIL] <criterion>: <why>`.");
    let mut user = format!("Task {} ({}): {}\n", t.task_id, t.target_agent, t.action);
    for (k, v) in [("Inputs", &t.inputs), ("Constraints", &t.constraints), ("Acceptance criteria", &t.acceptance_criteria)] {
        if !v.is_empty() {
            user.push_str(&format!("{k}:\n- {}\n", v.join("\n- ")));
        }
    }
    if !context.is_empty() {
        user.push_str(&format!("\nEarlier steps:{context}"));
    }
    if let Some(f) = feedback {
        user.push_str(&format!("\n\n{f}"));
    }
    (system, user)
}

/// Librarian staging (CPU): allowed text files named in the inputs (≤ 64 KB, ≤ 5) plus a deep
/// recall over the mesh memory namespaces.
fn stage(t: &TaskPacket, roots: &[PathBuf]) -> String {
    let mut s = String::new();
    for p in abs_inputs(t).into_iter().take(5) {
        match super::security_gate::check_path("librarian", &p, roots) {
            Ok(p) => match std::fs::metadata(&p) {
                Ok(m) if m.is_file() && m.len() <= 64 * 1024 => match std::fs::read_to_string(&p) {
                    Ok(body) => s.push_str(&format!("\n[staged] {} ({} bytes)\n{}\n", p.display(), m.len(), super::envelope::clip(&body, 1500))),
                    Err(_) => s.push_str(&format!("\n[skipped] {} (not text)\n", p.display())),
                },
                Ok(m) if m.is_dir() => {
                    let names: Vec<String> = std::fs::read_dir(&p).map(|rd| rd.flatten().take(40).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
                    s.push_str(&format!("\n[staged dir] {}: {}\n", p.display(), names.join(", ")));
                }
                Ok(_) => s.push_str(&format!("\n[skipped] {} (over 64 KB)\n", p.display())),
                Err(_) => s.push_str(&format!("\n[missing] {}\n", p.display())),
            },
            Err(e) => s.push_str(&format!("\n[refused] {e}\n")),
        }
    }
    let q = format!("{} {}", t.action, t.inputs.join(" "));
    for ns in ["build_circle", "librarian", "tony"] {
        for e in super::memtier::query("librarian", ns, &q, 3, 1500, true) {
            s.push_str(&format!("\n[memory:{ns}] {}\n", e.text));
        }
    }
    if s.trim().is_empty() {
        s = "[staged] nothing matched the inputs or memory".into();
    }
    s
}

/// A deterministic report that echoes each criterion it actually checked (Security / Observer / Librarian lanes).
fn report(t: &TaskPacket, checks: &dyn Fn(&str) -> Option<(bool, String)>) -> String {
    t.acceptance_criteria
        .iter()
        .map(|c| match checks(c) {
            Some((true, ev)) => format!("[PASS] {c}: {ev}"),
            Some((false, ev)) => format!("[FAIL] {c}: {ev}"),
            None => format!("[FAIL] {c}: not something this lane can verify deterministically"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub struct LiveExec {
    pub app: tauri::AppHandle,
    pub roots: Vec<PathBuf>,
    pub known: Vec<String>,
}

impl Exec for LiveExec {
    fn run<'a>(&'a self, t: &'a TaskPacket, context: &'a str, _attempt: u32, feedback: Option<&'a str>) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            use tauri::Manager;
            match t.target_agent.as_str() {
                "prompter" | "coder" | "designer" | "director" => {
                    let (system, user) = step_prompt(t, context, feedback);
                    let st = self.app.state::<super::dispatch::DispatchState>();
                    let os = self.app.state::<super::os_core::OsState>();
                    let msgs = vec![super::dispatch::ChatMessage::new("system", system), super::dispatch::ChatMessage::new("user", user)];
                    super::dispatch::run_chat(&st, &os, msgs, super::dispatch::Priority::Background, None, Some(240)).await.map(|r| r.content)
                }
                "librarian" => {
                    let body = stage(t, &self.roots);
                    let staged = !body.contains("nothing matched");
                    Ok(format!("{body}\n{}", report(t, &|c: &str| {
                        let l = c.to_lowercase();
                        (l.contains("path") || l.contains("stag") || l.contains("return") || l.contains("found")).then(|| (staged, if staged { "staged above".to_string() } else { "nothing staged".to_string() }))
                    })))
                }
                "security" => {
                    let hits = super::security_gate::scan_secrets(context, &self.known);
                    if !hits.is_empty() {
                        return Err(format!("SECURITY_FAIL_CLOSED: earlier output matched {}", hits.join(", ")));
                    }
                    Ok(report(t, &|c: &str| {
                        let l = c.to_lowercase();
                        if ["secret", "credential", "token", "key", "leak", "regex"].iter().any(|k| l.contains(k)) {
                            Some((true, "secret scan of every earlier output: 0 matches".into()))
                        } else if ["purge", "ephemeral", "staging", "scratch", "empty"].iter().any(|k| l.contains(k)) {
                            Some((true, "purge handshake to the Garbage daemon is sent when this packet closes".into()))
                        } else {
                            None
                        }
                    }))
                }
                "observer" => Ok(report(t, &|c: &str| {
                    let l = c.to_lowercase();
                    (l.contains("pass") || l.contains("verif") || l.contains("criteria") || l.contains("test")).then(|| (!context.is_empty(), if context.is_empty() { "no earlier output to verify".into() } else { "every earlier step passed its own acceptance gate".into() }))
                })),
                other => Err(format!("no executor for {other}")),
            }
        })
    }
}

// ── Live registry (health check) ────────────────────────────────────────────

#[derive(Default)]
struct Registry {
    running: BTreeMap<String, usize>,
    finished: u64,
    halted: u64,
    last: Option<Value>,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn health() -> Value {
    let r = registry().lock().unwrap();
    json!({ "running": r.running.len(), "queuedTasks": r.running.values().sum::<usize>(), "finished": r.finished, "halted": r.halted, "gpuRelayBusy": relay().try_lock().is_err(), "last": r.last })
}

pub const RESULT_EVENT: &str = "packet-result";

/// Run a packet in the background (the caller returns at once). On close: results to the
/// webview (`packet-result`), a milestone for Tony, shared memory, then the purge handshake.
pub fn spawn(app: tauri::AppHandle, id: String, d: TonyDispatch) {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok();
    let os = app.state::<super::os_core::OsState>();
    let cfg = os.snapshot();
    let mut roots: Vec<PathBuf> = cfg.fs_roots.iter().map(PathBuf::from).collect();
    roots.push(PathBuf::from(&app.state::<super::dispatch::DispatchState>().snapshot().gateway.workdir));
    if let Some(d) = &dir {
        roots.push(d.join("packets"));
    }
    let known = super::devqueue::known_secrets(app.state::<super::dispatch::DispatchState>().inner(), os.inner());
    registry().lock().unwrap().running.insert(id.clone(), d.tasks.len());
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let exec = LiveExec { app: app.clone(), roots: roots.clone(), known: known.clone() };
        let results = run_dag(&d, &exec, &Gates { roots, known }).await;
        // Scratch: the outputs for this packet's lifetime only.
        if let Some(dir) = &dir {
            let s = dir.join("packets").join(&id);
            if std::fs::create_dir_all(&s).is_ok() {
                for r in results.iter().filter(|r| r.output.is_some()) {
                    let _ = std::fs::write(s.join(format!("{}.md", r.task_id)), r.output.as_deref().unwrap_or(""));
                }
            }
        }
        let halted: Vec<&TaskResult> = results.iter().filter(|r| r.status != Status::Done).collect();
        let summary = if halted.is_empty() {
            format!("Packet done: {} task(s) passed their acceptance checks", results.len())
        } else {
            format!("Packet stopped: {}", halted.iter().map(|r| format!("{} {:?}: {}", r.task_id, r.status, r.error.clone().unwrap_or_default())).collect::<Vec<_>>().join("; "))
        };
        for r in results.iter().filter(|r| r.status == Status::Done) {
            super::memtier::put(&r.target_agent, "build_circle", &format!("[packet {id} · {}] {}", r.task_id, super::envelope::clip(r.output.as_deref().unwrap_or(""), 800)), &[&format!("task:{id}")]);
        }
        super::memtier::mark_done("build_circle", &format!("task:{id}"));
        let payload = json!({ "id": id, "summary": summary, "results": results });
        let _ = app.emit(RESULT_EVENT, &payload);
        super::events::publish_note("tony", "packet_done", if halted.is_empty() { "milestone" } else { "handoff" }, &super::envelope::clip(&summary, 280), None);
        {
            let mut r = registry().lock().unwrap();
            r.running.remove(&id);
            r.finished += 1;
            if !halted.is_empty() {
                r.halted += 1;
            }
            r.last = Some(json!({ "id": id, "summary": summary, "at": super::arbiter::now_ms() }));
        }
        // Security closes the packet: the purge handshake.
        super::arbiter::get().handoff("security", "garbage", "packet closed");
        super::garbage::handshake(&id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use std::sync::Arc;

    fn pkt(id: &str, agent: &str, deps: &[&str], crit: &[&str]) -> TaskPacket {
        TaskPacket { task_id: id.into(), target_agent: agent.into(), action: format!("Do the {id} step"), inputs: vec![], constraints: vec![], acceptance_criteria: crit.iter().map(|s| s.to_string()).collect(), depends_on: deps.iter().map(|s| s.to_string()).collect() }
    }

    fn packet(tasks: Vec<TaskPacket>) -> TonyDispatch {
        TonyDispatch { spoken_reply: "queued".into(), requires_dispatch: true, priority: "normal".into(), tasks }
    }

    /// Scripted executor: per task id, a list of outputs by attempt (the last repeats).
    struct Script {
        out: BTreeMap<String, Vec<Result<String, String>>>,
        calls: AtomicU32,
        gpu_now: AtomicUsize,
        gpu_max: AtomicUsize,
    }

    impl Script {
        fn new(pairs: &[(&str, Vec<Result<&str, &str>>)]) -> Self {
            Self { out: pairs.iter().map(|(k, v)| (k.to_string(), v.iter().map(|r| r.map(str::to_string).map_err(str::to_string)).collect())).collect(), calls: AtomicU32::new(0), gpu_now: AtomicUsize::new(0), gpu_max: AtomicUsize::new(0) }
        }
    }

    impl Exec for Script {
        fn run<'a>(&'a self, t: &'a TaskPacket, _c: &'a str, attempt: u32, _f: Option<&'a str>) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let g = is_gpu(&t.target_agent);
                if g {
                    let n = self.gpu_now.fetch_add(1, Ordering::SeqCst) + 1;
                    self.gpu_max.fetch_max(n, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    self.gpu_now.fetch_sub(1, Ordering::SeqCst);
                }
                let v = &self.out[&t.task_id];
                v[((attempt - 1) as usize).min(v.len() - 1)].clone()
            })
        }
    }

    #[test]
    fn malformed_packets_never_reach_a_worker() {
        for bad in [
            r#"{"spoken_reply": "", "requires_dispatch": true, "tasks": []}"#,
            r#"{"spoken_reply": "ok", "requires_dispatch": true, "priority": "asap", "tasks": []}"#,
            r#"{"spoken_reply": "ok", "requires_dispatch": true, "tasks": [{"task_id": "a1", "target_agent": "garbage", "action": "Purge things", "acceptance_criteria": ["x"]}]}"#,
            r#"{"spoken_reply": "ok", "requires_dispatch": true, "tasks": [{"task_id": "a1", "target_agent": "coder", "action": "Write it", "acceptance_criteria": []}]}"#,
            r#"{"spoken_reply": "ok", "requires_dispatch": true, "tasks": [{"task_id": "a1", "target_agent": "coder", "action": "Write it", "acceptance_criteria": ["x"], "depends_on": ["a1"]}]}"#,
            r#"{"spoken_reply": "ok", "requires_dispatch": "yes", "tasks": []}"#,
            r#"{"spoken_reply": "ok", "requires_dispatch": true, "tasks": [{"task_id": "a1", "target_agent": "coder", "acceptance_criteria": ["x"]}]}"#,
        ] {
            let r = super::super::tony_dispatch::parse(bad).expect("it is packet-shaped");
            assert!(r.is_err(), "{bad}");
        }
        // Nothing parsed → nothing to run: the executor was never called.
        let s = Script::new(&[]);
        assert_eq!(s.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn dag_order_gpu_relay_and_blocking() {
        tauri::async_runtime::block_on(async {
            let s = Arc::new(Script::new(&[
                ("spec", vec![Ok("[PASS] spec locked: yes")]),
                ("code", vec![Ok("[PASS] it compiles: cargo ok")]),
                ("ui", vec![Ok("[PASS] layout drawn: yes")]),
                ("bad", vec![Err("boom")]),
                ("after_bad", vec![Ok("never")]),
            ]));
            let d = packet(vec![pkt("code", "coder", &["spec"], &["it compiles"]), pkt("spec", "prompter", &[], &["spec locked"]), pkt("ui", "designer", &["spec"], &["layout drawn"]), pkt("bad", "coder", &[], &["works"]), pkt("after_bad", "designer", &["bad"], &["x"])]);
            // Two packets at once: the GPU relay still runs one GPU step at a time.
            let (s1, s2, d1, d2) = (s.clone(), s.clone(), d.clone(), d.clone());
            let a = tauri::async_runtime::spawn(async move { run_dag(&d1, s1.as_ref(), &Gates::default()).await });
            let b = tauri::async_runtime::spawn(async move { run_dag(&d2, s2.as_ref(), &Gates::default()).await });
            let (ra, _) = (a.await.unwrap(), b.await.unwrap());
            assert_eq!(s.gpu_max.load(Ordering::SeqCst), 1, "single-slot GPU relay");
            let ids: Vec<&str> = ra.iter().map(|r| r.task_id.as_str()).collect();
            assert!(ids.iter().position(|x| *x == "spec") < ids.iter().position(|x| *x == "code"), "{ids:?}");
            let st = |id: &str| ra.iter().find(|r| r.task_id == id).unwrap().status;
            assert_eq!((st("spec"), st("code"), st("ui")), (Status::Done, Status::Done, Status::Done));
            assert_eq!(st("bad"), Status::Halted);
            assert_eq!(st("after_bad"), Status::Blocked);
        });
    }

    #[test]
    fn observer_halts_a_retry_loop_at_the_cap() {
        tauri::async_runtime::block_on(async {
            // Different (non-repeating) failing outputs: retried up to the cap, then halted.
            let s = Script::new(&[("t1", vec![Ok("draft one"), Ok("draft two"), Ok("draft three"), Ok("draft four")])]);
            let r = run_dag(&packet(vec![pkt("t1", "coder", &[], &["tests pass"])]), &s, &Gates::default()).await;
            assert_eq!(r[0].status, Status::Halted);
            assert_eq!(r[0].attempts, 1 + RETRY_CAP);
            assert_eq!(s.calls.load(Ordering::SeqCst), 1 + RETRY_CAP, "never past the cap");
            assert!(r[0].error.as_deref().unwrap().contains("retry cap"));
            // The same output twice: drift, halted at the 2nd attempt.
            let s = Script::new(&[("t1", vec![Ok("same thing")])]);
            let r = run_dag(&packet(vec![pkt("t1", "coder", &[], &["tests pass"])]), &s, &Gates::default()).await;
            assert_eq!((r[0].status, r[0].attempts), (Status::Halted, 2));
            assert!(r[0].error.as_deref().unwrap().contains("drift"));
            // A retry that fixes it passes.
            let s = Script::new(&[("t1", vec![Ok("nope"), Ok("[PASS] tests pass: 12/12 green")])]);
            let r = run_dag(&packet(vec![pkt("t1", "coder", &[], &["tests pass"])]), &s, &Gates::default()).await;
            assert_eq!((r[0].status, r[0].attempts), (Status::Done, 2));
        });
    }

    #[test]
    fn security_fails_closed_on_a_leaked_secret_and_refuses_vault_inputs() {
        tauri::async_runtime::block_on(async {
            let s = Script::new(&[("leak", vec![Ok("[PASS] works: here is the key sk-proj-abcdefghijklmnopqrstuvwxyz0123")]), ("next", vec![Ok("[PASS] x: y")])]);
            let r = run_dag(&packet(vec![pkt("leak", "coder", &[], &["works"]), pkt("next", "designer", &["leak"], &["x"])]), &s, &Gates::default()).await;
            assert_eq!(r[0].status, Status::Failed);
            assert!(r[0].error.as_deref().unwrap().starts_with("SECURITY_FAIL_CLOSED") && r[0].output.is_none());
            assert_eq!(s.calls.load(Ordering::SeqCst), 1, "fail closed: no retry");
            assert_eq!(r[1].status, Status::Blocked);
            // A mesh agent pointed at the vault is refused before it runs.
            let mut t = pkt("read", "librarian", &[], &["x"]);
            t.inputs = vec![r"C:\Users\nic\AppData\Roaming\os.agentic.commandcenter\vault\finance\ledger.aosv".into()];
            let s = Script::new(&[("read", vec![Ok("[PASS] x: y")])]);
            let r = run_dag(&packet(vec![t]), &s, &Gates { roots: vec![PathBuf::from(r"C:\Users\nic\AppData\Roaming\os.agentic.commandcenter")], known: vec![] }).await;
            assert_eq!(r[0].status, Status::Refused);
            assert_eq!(s.calls.load(Ordering::SeqCst), 0);
            // Financer is held, never run.
            let s = Script::new(&[]);
            let r = run_dag(&packet(vec![pkt("budget", "financer", &[], &["x"])]), &s, &Gates::default()).await;
            assert_eq!(r[0].status, Status::Held);
        });
    }

    #[test]
    fn observer_machine_checks() {
        let t = pkt("t", "coder", &[], &["Output contains 'fn main'", "No raw tokens printed in log output", "Result is non-empty"]);
        let v = observe(&t, "fn main() {}", &[]);
        assert!(v.iter().all(|x| x.pass), "{v:?}");
        let v = observe(&t, "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", &[]);
        assert!(!v[0].pass && !v[1].pass);
        let t = pkt("t", "coder", &[], &["Unit test for expired token refresh passes"]);
        assert!(observe(&t, "[PASS] Unit test for expired token refresh passes: 1 passed", &[])[0].pass);
        assert!(!observe(&t, "[PASS] unit test refresh passes\n[FAIL] unit test expired token refresh: flaky", &[])[0].pass);
    }
}
