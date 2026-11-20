//! Live smoke tests (tf-plan §4.3–4.5). ALL `#[ignore]`: run each one only with `--exact`, e.g.
//! `cargo test --lib -- --ignored --exact commands::taskworker::tests::live::live_smoke_lmstudio_direct`.
//!
//! Local services only ($0): LM Studio on :1235 (the model already loaded; never a JIT load)
//! and, for the session test, AnythingLLM on :3001. Scratch tasks.db / staging / notes under
//! `TF_SMOKE_ROOT` (default: the OS temp dir). The gateway mirror points at a closed port on
//! purpose (best-effort path). No offload engines, no verifier, no research, no ingest.
//!
//! Optional env overrides (the final-part smoke uses them):
//! - `TF_SMOKE_INTENT` / `TF_SMOKE_TITLE`: the task text and title (default: the tip calculator).
//! - `TF_SMOKE_STAGING`: write the artifact under this staging root instead of `<scratch>/staging`.
//! - `TF_SMOKE_SOURCES_NOTES` / `TF_SMOKE_SOURCES_HUB`: real read-only Librarian sources
//!   (e.g. `memory/tony`, `C:\ai-hub`). Tony's own note is still written to the scratch notes dir.
//!
//! Every run snapshots the Librarian's read sources before and after and asserts that nothing
//! changed there except the worker's own writes (tasks.db, the Coder's `staging/<slug>/`, Tony's
//! scratch note): zero writes attributable to the Librarian path.

use super::*;
use std::sync::atomic::AtomicU64;

const LM_BASE: &str = "http://127.0.0.1:1235";
const ALLM_BASE: &str = "http://127.0.0.1:3001";
const INTENT: &str = "single-page tip calculator with bill, tip % and split inputs";

fn env_opt(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

type Snapshot = BTreeMap<PathBuf, (u64, Option<std::time::SystemTime>)>;

/// (size, mtime) of every regular file under `roots` (links are not followed).
fn tree_snapshot(roots: &[PathBuf]) -> Snapshot {
    let mut out = Snapshot::new();
    let mut stack: Vec<PathBuf> = roots.to_vec();
    while let Some(d) = stack.pop() {
        let Ok(md) = std::fs::symlink_metadata(&d) else { continue };
        if md.file_type().is_symlink() {
            continue;
        }
        if md.is_file() {
            out.insert(d, (md.len(), md.modified().ok()));
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                stack.push(e.path());
            }
        }
    }
    out
}

/// Paths added, removed or modified between two snapshots, outside the `allowed` prefixes.
fn unexpected_writes(before: &Snapshot, after: &Snapshot, allowed: &[PathBuf]) -> Vec<String> {
    let ok = |p: &Path| allowed.iter().any(|a| p.starts_with(a));
    let mut v = Vec::new();
    for (p, m) in after {
        if before.get(p) != Some(m) && !ok(p) {
            v.push(format!("changed {}", p.display()));
        }
    }
    for p in before.keys() {
        if !after.contains_key(p) && !ok(p) {
            v.push(format!("removed {}", p.display()));
        }
    }
    v
}

fn scratch(tag: &str) -> PathBuf {
    let base = std::env::var("TF_SMOKE_ROOT").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    let d = base.join(format!("smoke-{tag}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::create_dir_all(&d).unwrap();
    eprintln!("[smoke] scratch root: {}", d.display());
    d
}

/// The ONE model LM Studio has loaded (`/api/v0/models`). Panics (skips) otherwise, so a smoke
/// run never triggers a JIT load of a second model.
fn loaded_model() -> String {
    tauri::async_runtime::block_on(async {
        let v: Value = reqwest::Client::new().get(format!("{LM_BASE}/api/v0/models")).timeout(Duration::from_secs(5)).send().await.expect("LM Studio :1235 is down").json().await.expect("bad /api/v0/models");
        let loaded: Vec<String> = v["data"].as_array().into_iter().flatten().filter(|m| m["state"] == "loaded" && m["type"] != "embeddings").filter_map(|m| m["id"].as_str().map(String::from)).collect();
        assert_eq!(loaded.len(), 1, "expected exactly one loaded LLM, found {loaded:?}; skipping");
        loaded[0].clone()
    })
}

/// Peak GPU memory (MiB) sampled every 5 s by `nvidia-smi` until `stop` is set.
fn vram_sampler(stop: Arc<AtomicBool>) -> (Arc<AtomicU64>, std::thread::JoinHandle<()>) {
    let peak = Arc::new(AtomicU64::new(0));
    let p = peak.clone();
    let h = std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            if let Ok(o) = std::process::Command::new("nvidia-smi").args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"]).output() {
                if let Some(mb) = String::from_utf8_lossy(&o.stdout).lines().next().and_then(|l| l.trim().parse::<u64>().ok()) {
                    p.fetch_max(mb, Ordering::SeqCst);
                }
            }
            for _ in 0..50 {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
    (peak, h)
}

struct SmokeEnv {
    slot: &'static GpuSlot,
    bridge: BridgeState,
    settings: WorkerSettings,
    live: LiveModel<'static>,
    counts: Mutex<HashMap<String, usize>>,
    by: Mutex<Vec<(String, String)>>,
    max_active: AtomicUsize,
}

impl SmokeEnv {
    fn new(root: &Path, allm: Option<(super::super::super::allm::AllmReader, BTreeMap<String, String>)>) -> Self {
        let mut settings = settings_for(root);
        settings.librarian_audit = true;
        // The real gate: headless Edge runtime smoke on the staged page (skipped without Edge).
        settings.runtime_smoke = true;
        // The Librarian reads the task history through its read-only connection.
        settings.sources.tasks_db = Some(root.join("tasks.db"));
        if let Some(s) = env_opt("TF_SMOKE_STAGING") {
            settings.staging_root = PathBuf::from(&s);
            settings.sources.staging_root = Some(PathBuf::from(s));
        }
        if let Some(n) = env_opt("TF_SMOKE_SOURCES_NOTES") {
            settings.sources.notes_root = Some(PathBuf::from(n));
        }
        if let Some(h) = env_opt("TF_SMOKE_SOURCES_HUB") {
            settings.sources.hub_roots = vec![PathBuf::from(h)];
        }
        eprintln!("[smoke] staging root: {}", settings.staging_root.display());
        Self {
            slot: Box::leak(Box::new(GpuSlot::default())),
            bridge: BridgeState::with_policy(BridgePolicy { read: Tier::Allow, write: Tier::Ask, execute: Tier::Ask, network: Tier::Allow }),
            settings,
            live: LiveModel { http: reqwest::Client::new(), lm_base: format!("{LM_BASE}/v1"), lm_model: loaded_model(), lm_key: None, allm, os_name: "Tony".into(), settle: Duration::from_secs(20), tony_priority_pct: 90, caches: Box::leak(Box::default()) },
            counts: Mutex::default(),
            by: Mutex::default(),
            max_active: AtomicUsize::new(0),
        }
    }
    fn count(&self, s: &str) -> usize {
        self.counts.lock().unwrap().get(s).copied().unwrap_or(0)
    }
    /// Everything the Librarian reads (plus the scratch root itself).
    fn watched(&self, root: &Path) -> Vec<PathBuf> {
        let s = &self.settings.sources;
        let mut v = vec![root.to_path_buf()];
        v.extend(s.notes_root.clone());
        v.extend(s.hub_roots.iter().cloned());
        v.extend(s.staging_root.clone());
        v
    }
}

impl WorkerEnv for SmokeEnv {
    fn settings(&self) -> Result<WorkerSettings, String> {
        Ok(self.settings.clone())
    }
    fn slot(&self) -> &GpuSlot {
        self.slot
    }
    fn bridge(&self) -> &BridgeState {
        &self.bridge
    }
    fn model(&self, call: ModelCall) -> BoxFuture<'_, Result<ModelReply, String>> {
        Box::pin(async move {
            assert!(call.offload.is_none(), "no offload in a smoke run");
            *self.counts.lock().unwrap().entry(call.stage.to_string()).or_insert(0) += 1;
            let t0 = Instant::now();
            let r = self.live.ask(self.slot, &call).await;
            self.max_active.fetch_max(self.slot.view().active.len(), Ordering::SeqCst);
            eprintln!("[smoke] {} {} → {} in {:.1}s", call.agent, call.stage, r.as_ref().map(|r| r.by.clone()).unwrap_or_else(|e| format!("error: {e}")), t0.elapsed().as_secs_f32());
            if let Ok(r) = &r {
                self.by.lock().unwrap().push((call.stage.to_string(), r.by.clone()));
            }
            r
        })
    }
    fn web_search(&self, _q: String) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async { Err("smoke: no research".to_string()) })
    }
    fn fetch_url(&self, _u: String) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async { Err("smoke: no research".to_string()) })
    }
    fn gateway(&self, method: reqwest::Method, path: String, body: Option<Value>) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            // A closed port: proves the mirrors are best-effort.
            let mut rb = reqwest::Client::new().request(method, format!("http://127.0.0.1:9{path}")).timeout(Duration::from_secs(3));
            if let Some(b) = body {
                rb = rb.json(&b);
            }
            rb.send().await.map(|_| Value::Null).map_err(super::super::super::dispatch::short)
        })
    }
    fn verifier(&self, _o: String, _p: String) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async { panic!("the verifier never runs in a smoke") })
    }
    fn ingest(&self, _t: String, _x: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { panic!("noIngest: nothing is written to AnythingLLM") })
    }
    fn legacy(&self, _e: &str, _p: Value) {}
}

fn smoke_task(store: &TaskStore) -> Envelope {
    let intent = env_opt("TF_SMOKE_INTENT").unwrap_or_else(|| INTENT.to_string());
    let title = env_opt("TF_SMOKE_TITLE").unwrap_or_else(|| "Tip calculator".to_string());
    eprintln!("[smoke] intent: {intent}");
    let args = CreateArgs { raw_intent: intent, title: Some(title), source: "typed".into(), options: Some(json!({ "localOnly": true, "noVerify": true, "noIngest": true })), ..Default::default() };
    create_task(store, &args, 2, &[]).unwrap().0
}

fn smoke_asserts(root: &Path, e: &Envelope, env: &SmokeEnv, peak_mb: u64, t0: Instant, before: &Snapshot) {
    let secret_re = regex::Regex::new(r"sk-[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9._~+/=\-]{8,}").unwrap();
    eprintln!("[smoke] status {} stage {:?} iteration {}/{} error {:?} rows {} peak VRAM {peak_mb} MiB, {:.0}s", e.status, e.stage, e.iteration_count, e.max_iterations, e.error, e.handoff_log.len(), t0.elapsed().as_secs_f32());
    assert!(e.status == "review_ready" || e.status == "failed", "{}", e.status);
    assert!(e.handoff_log.len() >= 6);
    let slug = e.project_slug.clone().expect("slug");
    let sroot = env.settings.staging_root.clone();
    let page = sroot.join(&slug).join("index.html");
    eprintln!("[smoke] artifact: {} ({})", page.display(), if page.is_file() { "present" } else { "missing" });
    if e.status == "review_ready" {
        assert!(page.is_file(), "{}", page.display());
        let st: Value = serde_json::from_str(&std::fs::read_to_string(sroot.join(&slug).join(".status.json")).unwrap()).unwrap();
        assert_eq!(st["status"], "review_ready");
    } else {
        eprintln!("[smoke] failed with eval reasons: {}", e.last_eval);
    }
    for h in &e.handoff_log {
        assert!(!secret_re.is_match(&serde_json::to_string(h).unwrap()), "secret pattern in a row");
    }
    assert!(env.max_active.load(Ordering::SeqCst) <= 1);
    assert!(peak_mb == 0 || peak_mb < 11_500, "peak VRAM {peak_mb} MiB");
    assert!(t0.elapsed() < Duration::from_secs(30 * 60));
    // Librarian: it ran (pre-flight at least), always through LM Studio direct, and wrote nothing.
    assert!(env.count("preflight") >= 1, "the Librarian pre-flight never ran");
    let lib_routes: Vec<_> = env.by.lock().unwrap().iter().filter(|(s, _)| s == "preflight" || s == "audit").cloned().collect();
    eprintln!("[smoke] librarian calls: {lib_routes:?}");
    assert!(lib_routes.iter().all(|(_, by)| by.starts_with("lmstudio-direct")), "the Librarian only reads through LM Studio direct");
    let notes = serde_json::to_string(&e.librarian_notes).unwrap();
    eprintln!("[smoke] librarian_notes: {} bytes, brief present: {}", notes.len(), e.librarian_notes.get("librarian_brief").is_some());
    let mut allowed = vec![root.join("tasks.db"), root.join("tasks.db-wal"), root.join("tasks.db-shm"), root.join("tasks.db-journal"), sroot.join(&slug)];
    allowed.extend(env.settings.notes_root.clone());
    let after = tree_snapshot(&env.watched(root));
    let bad = unexpected_writes(before, &after, &allowed);
    eprintln!("[smoke] librarian write violations: {} (watched {} files)", bad.len(), after.len());
    assert!(bad.is_empty(), "writes outside the worker's own paths: {bad:?}");
}

fn run_live(store: &TaskStore, env: &SmokeEnv) {
    let stats = WorkerStats::default();
    let forced = Mutex::new(HashMap::new());
    let w = Worker { store, env, tuning: Tuning { attempts: 2, retry_backoff: Duration::from_secs(3), fg_wait_max: Duration::from_secs(60), ..Default::default() }, stats: &stats, forced_offload: &forced };
    tauri::async_runtime::block_on(w.run_until_idle(60));
    eprintln!("[smoke] mirror failures (expected, closed port): {}", stats.mirror_failed.load(Ordering::SeqCst));
}

/// §4.3: the whole loop through LM Studio direct.
#[test]
#[ignore = "live: LM Studio :1235 (run with --exact)"]
fn live_smoke_lmstudio_direct() {
    let root = scratch("lmstudio");
    let store = TaskStore::default();
    store.init(&root).unwrap();
    let env = SmokeEnv::new(&root, None);
    let stop = Arc::new(AtomicBool::new(false));
    let (peak, h) = vram_sampler(stop.clone());
    let t0 = Instant::now();
    let t = smoke_task(&store);
    let before = tree_snapshot(&env.watched(&root));
    run_live(&store, &env);
    stop.store(true, Ordering::SeqCst);
    let _ = h.join();
    let e = get(&store, &t.task_id);
    smoke_asserts(&root, &e, &env, peak.load(Ordering::SeqCst), t0, &before);
    assert!(env.by.lock().unwrap().iter().all(|(_, by)| by.starts_with("lmstudio-direct")));
}

fn allm_key() -> Option<String> {
    std::env::var("ANYTHINGLLM_API_KEY").ok().filter(|k| !k.is_empty()).or_else(|| super::super::super::secrets::get(&super::super::super::dispatch::DispatchState::default(), "anythingllm"))
}

/// §4.4: the same through AnythingLLM task sessions (prompter-dispatcher, designer, coder),
/// where each workspace verifiably chats with the loaded model. Additive only.
#[test]
#[ignore = "live: AnythingLLM :3001 + LM Studio :1235 (run with --exact)"]
fn live_smoke_allm_session() {
    use super::super::super::allm::{AllmConn, AllmReader};
    let key = allm_key().expect("no AnythingLLM key (ANYTHINGLLM_API_KEY or the keychain); skipping");
    let slugs: BTreeMap<String, String> = [("prompter", "prompter-dispatcher"), ("designer", "designer"), ("coder", "coder")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    let mk = || AllmReader::new(AllmConn::with_key(&super::super::super::dispatch::DispatchState::default(), ALLM_BASE, key.clone()));
    let threads = |r: &AllmReader| -> BTreeMap<String, usize> {
        tauri::async_runtime::block_on(async {
            let mut m = BTreeMap::new();
            for s in ["prompter-dispatcher", "designer", "coder", "librarian"] {
                let n = r.get_workspace(s, 10).await.map(|w| w["threads"].as_array().map_or(0, |a| a.len())).unwrap_or(usize::MAX);
                m.insert(s.to_string(), n);
            }
            m
        })
    };
    let probe = mk();
    let before = threads(&probe);
    let root = scratch("allm");
    let store = TaskStore::default();
    store.init(&root).unwrap();
    let env = SmokeEnv::new(&root, Some((mk(), slugs)));
    let stop = Arc::new(AtomicBool::new(false));
    let (peak, h) = vram_sampler(stop.clone());
    let t0 = Instant::now();
    let t = smoke_task(&store);
    let snap = tree_snapshot(&env.watched(&root));
    run_live(&store, &env);
    stop.store(true, Ordering::SeqCst);
    let _ = h.join();
    let e = get(&store, &t.task_id);
    smoke_asserts(&root, &e, &env, peak.load(Ordering::SeqCst), t0, &snap);
    assert_eq!(before, threads(&probe), "no thread was created in any workspace");
    eprintln!("[smoke] AnythingLLM session id: task-{} (find / delete it in the workspace chat logs)", e.task_id);
    eprintln!("[smoke] routes: {:?}", env.by.lock().unwrap());
    assert!(env.by.lock().unwrap().iter().filter(|(s, _)| s == "preflight" || s == "audit").all(|(_, by)| by.starts_with("lmstudio-direct")), "the Librarian never chats in a workspace");
}

/// §4.5: run until `code` starts, drop the worker, reopen + recover, finish; nothing before
/// `code` is asked again.
#[test]
#[ignore = "live: LM Studio :1235 (run with --exact)"]
fn live_smoke_resume() {
    let root = scratch("resume");
    let env = SmokeEnv::new(&root, None);
    let id;
    {
        let store = TaskStore::default();
        store.init(&root).unwrap();
        id = smoke_task(&store).task_id;
        let stats = WorkerStats::default();
        let forced = Mutex::new(HashMap::new());
        let w = Worker { store: &store, env: &env, tuning: tuning(), stats: &stats, forced_offload: &forced };
        for _ in 0..12 {
            if get(&store, &id).stage.as_deref() == Some("code") || envelope::TERMINAL.contains(&get(&store, &id).status.as_str()) {
                break;
            }
            tauri::async_runtime::block_on(w.run_once()).unwrap();
        }
        let e = get(&store, &id);
        assert_eq!(e.stage.as_deref(), Some("code"), "{:?}", e.error);
        // The worker claimed `code`, then "died".
        store.transition(&id, expect_of(&e), Next::stage("code").unwrap(), &Patch { lease_until: Some(Some(envelope::now_ms() + 3_600_000)), ..Default::default() }, &HandoffRow::new("coder", "coder", "stage_started", "verbose", "Coder is building the prototype"), &[]).unwrap();
    }
    let store = TaskStore::default();
    store.init(&root).unwrap();
    assert_eq!(store.recover_interrupted().unwrap(), vec![id.clone()]);
    run_live(&store, &env);
    let e = get(&store, &id);
    eprintln!("[smoke] resumed to {} ({:?})", e.status, e.error);
    for s in ["triage", "preflight", "spec", "design", "merge"] {
        assert_eq!(env.count(s), 1, "{s} was asked again after the restart");
    }
}
