//! App / inference footprint vs total system load.
//!
//! A sampler thread (~1 s period) splits the machine's load into the **app** (this process + all
//! its descendants, plus the inference stack by name: LM Studio `llama-server` / `lms` /
//! "LM Studio", AnythingLLM, Bionic, the app's `whisper-server` STT sidecars and the Python
//! gateway) and **other** (everything else), so a
//! report or the Live Observer can tell "the agents are slow" apart from "TWS's Chromium is eating
//! the CPU". The sampler runs only while at least one [`Guard`] is alive ([`acquire`]) and stops
//! within ~1–2 s of the last one dropping: no Live mode and no run in flight = zero cost.
//!
//! CPU / RAM per process: `sysinfo`. `cpu_pct` everywhere is a share of the WHOLE machine (0–100):
//! sysinfo's per-process figure is per-core (up to 100 × cores) and is divided by the logical CPU
//! count here. System CPU / RAM: sysinfo totals. System GPU util / VRAM: the resident nvidia-smi
//! sampler (`system::gpu_now`, on this background thread only).
//!
//! GPU per process (Windows only): PDH counters, since nvidia-smi can't attribute on WDDM.
//! - `\GPU Engine(*)\Utilization Percentage`, instances like
//!   `pid_1234_luid_0x00000000_0x0000D1B4_phys_0_eng_3_engtype_3D`. Choice: per pid, utilisation is
//!   **summed over the engine instances of the same (adapter, engine type)** and the pid's figure is
//!   the **max over engine types** — exactly how Task Manager's GPU column works. That way a CUDA
//!   job (`engtype_Compute_*` / `Cuda`) and a 3D job are each seen at their real load without
//!   double counting copy / video engines. A group (app / other) sums its pids per engine type
//!   first, then takes the max; capped at 100.
//! - `\GPU Process Memory(*)\Dedicated Usage` (bytes per `pid_…_luid_…_phys_…` instance), summed
//!   per pid over adapters.
//!
//! If PDH is unavailable (non-Windows, counters disabled, a query fails) every per-process GPU
//! field is `None`. Nothing here panics. Payloads are names and numbers only.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Sampler period.
pub const PERIOD: Duration = Duration::from_millis(1000);
/// Cold start: gap between the priming refresh and the first published Split (CPU deltas need
/// ~200 ms), so `latest()` is populated ~250 ms after the first `acquire()`, not after a PERIOD.
const COLD_GAP: Duration = Duration::from_millis(200);
/// Shortest sleep between steady passes.
const MIN_REST: Duration = Duration::from_millis(200);
/// `latest()` returns None for a sample older than this.
pub const FRESH: Duration = Duration::from_secs(3);
/// Rows in `Split::top_other`.
pub const TOP_OTHER: usize = 5;
/// Names listed in `other.processes` (by CPU).
const OTHER_NAMES: usize = 10;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    /// Share of the whole machine, 0–100.
    pub cpu_pct: f32,
    pub ram_used_gb: f64,
    pub gpu_util_pct: Option<f32>,
    pub vram_used_mb: Option<u64>,
    pub processes: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pub name: String,
    pub pid: u32,
    pub cpu_pct: f32,
    pub gpu_util_pct: Option<f32>,
    pub vram_used_mb: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Split {
    pub at: u64,
    pub system: Footprint,
    pub vram_total_mb: Option<u64>,
    pub app: Footprint,
    pub other: Footprint,
    pub top_other: Vec<ProcRow>,
}

// ── Pure: process classification ────────────────────────────────────────────

/// One process as the classifier sees it (synthetic in tests).
#[derive(Clone, Debug, Default)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Image name without `.exe`, original case.
    pub name: String,
    /// Lower-cased command line (only needed for python / uvicorn).
    pub cmd: String,
    /// Seconds since the epoch (guards against a reused parent pid).
    pub start: u64,
    /// Whole-machine share, 0–100.
    pub cpu_pct: f32,
    pub mem_bytes: u64,
}

/// `foo.exe` / `FOO.EXE` → `foo`. Boundary-safe: a multi-byte name whose last 4 bytes are not a
/// char boundary is returned unchanged instead of panicking.
fn strip_exe(name: &str) -> &str {
    let n = name.len();
    if n > 4 && name.get(n - 4..).is_some_and(|ext| ext.eq_ignore_ascii_case(".exe")) {
        name.get(..n - 4).unwrap_or(name)
    } else {
        name
    }
}

/// The app-stack display name for a process matched by name / command line (pure). None = not part
/// of the inference stack by name (it may still be app as a descendant of this process).
pub fn stack_name(name: &str, cmd: &str) -> Option<&'static str> {
    let n = strip_exe(name).to_ascii_lowercase();
    match n.as_str() {
        "command-center" | "command_center" => return Some("command-center"),
        "llama-server" => return Some("llama-server"),
        "lms" => return Some("lms"),
        // The app's own speech-to-text sidecars (services.rs / language_hub.rs).
        "whisper-server" => return Some("whisper-server"),
        "lm studio" | "lmstudio" | "lm-studio" => return Some("LM Studio"),
        _ => {}
    }
    if n.starts_with("anythingllm") {
        return Some("AnythingLLM");
    }
    if n.starts_with("bionic") {
        return Some("Bionic");
    }
    let pythonish = n.starts_with("python") || n == "uvicorn" || n == "py";
    // The gateway is `command_center_api` (uvicorn or direct). A bare uvicorn only counts when its
    // command line points into this repo, so another project's uvicorn stays "other".
    if pythonish && (cmd.contains("command_center_api") || (cmd.contains("uvicorn") && (cmd.contains("agentic os") || cmd.contains("agentic_os") || cmd.contains("agentic-os")))) {
        return Some("gateway");
    }
    None
}

/// Pids in the app tree: `root` + every process matched by [`stack_name`], plus all their
/// descendants. A child counts only if it started no earlier than its parent (a reused parent pid
/// does not adopt strangers). Pure.
pub fn app_pids(procs: &[ProcInfo], root: u32) -> HashSet<u32> {
    let by_pid: HashMap<u32, &ProcInfo> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        if let Some(pp) = p.parent.filter(|pp| *pp != p.pid) {
            let ok = by_pid.get(&pp).map(|par| p.start >= par.start).unwrap_or(false);
            if ok {
                children.entry(pp).or_default().push(p.pid);
            }
        }
    }
    let mut out = HashSet::new();
    let mut stack: Vec<u32> = procs.iter().filter(|p| p.pid == root || stack_name(&p.name, &p.cmd).is_some()).map(|p| p.pid).collect();
    while let Some(pid) = stack.pop() {
        if out.insert(pid) {
            if let Some(c) = children.get(&pid) {
                stack.extend(c.iter().copied());
            }
        }
    }
    out
}

// ── Pure: PDH instance names + GPU aggregation ──────────────────────────────

/// `pid_1234_luid_0x0_0xD1B4_phys_0_eng_3_engtype_3D` → (1234, "0x0_0xD1B4|3D"). Pure.
pub fn parse_engine_instance(name: &str) -> Option<(u32, String)> {
    let pid = parse_pid(name)?;
    let luid = name.split("luid_").nth(1).and_then(|r| r.split("_phys").next()).unwrap_or("");
    let eng = name.split("engtype_").nth(1)?;
    if eng.is_empty() {
        return None;
    }
    Some((pid, format!("{luid}|{eng}")))
}

/// `pid_1234_…` → 1234. Pure.
pub fn parse_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("pid_")?;
    let digits: &str = rest.split('_').next()?;
    digits.parse().ok()
}

/// Per-pid GPU readings from one PDH collection.
#[derive(Clone, Debug, Default)]
pub struct GpuByPid {
    /// pid → (adapter|engine type) → utilisation summed over that type's engines.
    pub util: HashMap<u32, HashMap<String, f64>>,
    /// pid → dedicated VRAM bytes (summed over adapters).
    pub vram: HashMap<u32, u64>,
}

impl GpuByPid {
    /// Fold raw `(instance, value)` pairs from both counters (pure).
    pub fn from_raw(engines: &[(String, f64)], memory: &[(String, i64)]) -> Self {
        let mut g = GpuByPid::default();
        for (inst, v) in engines {
            if let Some((pid, key)) = parse_engine_instance(inst) {
                if v.is_finite() && *v > 0.0 {
                    *g.util.entry(pid).or_default().entry(key).or_default() += v;
                }
            }
        }
        for (inst, v) in memory {
            if let Some(pid) = parse_pid(inst) {
                *g.vram.entry(pid).or_default() += (*v).max(0) as u64;
            }
        }
        g
    }

    /// Task-Manager-style utilisation of one pid (max over engine types), capped at 100.
    pub fn pid_util(&self, pid: u32) -> f32 {
        self.util.get(&pid).map(|m| m.values().copied().fold(0.0_f64, f64::max)).unwrap_or(0.0).min(100.0) as f32
    }

    /// A group's utilisation: sum its pids per engine type, then the max type, capped at 100.
    pub fn group_util(&self, pids: impl IntoIterator<Item = u32>) -> f32 {
        let mut per: HashMap<&str, f64> = HashMap::new();
        for pid in pids {
            if let Some(m) = self.util.get(&pid) {
                for (k, v) in m {
                    *per.entry(k.as_str()).or_default() += v;
                }
            }
        }
        per.values().copied().fold(0.0_f64, f64::max).min(100.0) as f32
    }

    pub fn pid_vram_mb(&self, pid: u32) -> u64 {
        self.vram.get(&pid).copied().unwrap_or(0) / 1_048_576
    }

    pub fn group_vram_mb(&self, pids: impl IntoIterator<Item = u32>) -> u64 {
        pids.into_iter().map(|p| self.vram.get(&p).copied().unwrap_or(0)).sum::<u64>() / 1_048_576
    }
}

/// System-wide totals for one sample.
#[derive(Clone, Debug, Default)]
pub struct SystemTotals {
    pub cpu_pct: f32,
    pub ram_used_bytes: u64,
    pub gpu_util_pct: Option<f32>,
    pub vram_used_mb: Option<u64>,
    pub vram_total_mb: Option<u64>,
}

const GB: f64 = 1_073_741_824.0;

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Split one sample into system / app / other (pure). CPU and RAM of "other" are the system total
/// minus the app (so the two add up and kernel / idle-accounting overhead lands in "other"); GPU of
/// both groups comes from the PDH per-pid readings (None when PDH gave nothing).
pub fn split(at: u64, procs: &[ProcInfo], root: u32, sys: &SystemTotals, gpu: Option<&GpuByPid>) -> Split {
    let app = app_pids(procs, root);
    let (mut app_cpu, mut app_mem) = (0.0_f32, 0_u64);
    let mut app_names = BTreeSet::new();
    let mut others: Vec<&ProcInfo> = vec![];
    for p in procs {
        if app.contains(&p.pid) {
            app_cpu += p.cpu_pct;
            app_mem += p.mem_bytes;
            let name = stack_name(&p.name, &p.cmd).map(str::to_string).unwrap_or_else(|| strip_exe(&p.name).to_string());
            app_names.insert(name);
        } else if p.pid != 0 {
            others.push(p);
        }
    }
    others.sort_by(|a, b| b.cpu_pct.partial_cmp(&a.cpu_pct).unwrap_or(std::cmp::Ordering::Equal));
    let mut other_names: Vec<String> = vec![];
    for p in &others {
        let n = strip_exe(&p.name).to_string();
        if !other_names.contains(&n) {
            other_names.push(n);
        }
        if other_names.len() >= OTHER_NAMES {
            break;
        }
    }
    let other_pids = || procs.iter().map(|p| p.pid).filter(|p| !app.contains(p));
    let top_other = others
        .iter()
        .take(TOP_OTHER)
        .map(|p| ProcRow { name: strip_exe(&p.name).to_string(), pid: p.pid, cpu_pct: round1(p.cpu_pct), gpu_util_pct: gpu.map(|g| round1(g.pid_util(p.pid))), vram_used_mb: gpu.map(|g| g.pid_vram_mb(p.pid)) })
        .collect();
    let app_cpu = app_cpu.min(100.0);
    let app_ram = app_mem as f64 / GB;
    let sys_ram = sys.ram_used_bytes as f64 / GB;
    Split {
        at,
        system: Footprint { cpu_pct: round1(sys.cpu_pct), ram_used_gb: round2(sys_ram), gpu_util_pct: sys.gpu_util_pct.map(round1), vram_used_mb: sys.vram_used_mb, processes: vec![] },
        vram_total_mb: sys.vram_total_mb,
        app: Footprint { cpu_pct: round1(app_cpu), ram_used_gb: round2(app_ram), gpu_util_pct: gpu.map(|g| round1(g.group_util(app.iter().copied()))), vram_used_mb: gpu.map(|g| g.group_vram_mb(app.iter().copied())), processes: app_names.into_iter().collect() },
        other: Footprint {
            cpu_pct: round1((sys.cpu_pct - app_cpu).max(0.0)),
            ram_used_gb: round2((sys_ram - app_ram).max(0.0)),
            gpu_util_pct: gpu.map(|g| round1(g.group_util(other_pids()))),
            vram_used_mb: gpu.map(|g| g.group_vram_mb(other_pids())),
            processes: other_names,
        },
        top_other,
    }
}

// ── PDH (Windows) ───────────────────────────────────────────────────────────

#[cfg(windows)]
mod pdh {
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
    };

    const ERROR_SUCCESS: u32 = 0;
    /// A formatted array larger than this is refused (a corrupt size never allocates gigabytes).
    const MAX_BUF: u32 = 16 * 1024 * 1024;

    /// One open PDH query with the two wildcard GPU counters. Owned by the sampler thread only.
    pub struct Query {
        q: PDH_HQUERY,
        engine: PDH_HCOUNTER,
        memory: Option<PDH_HCOUNTER>,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl Query {
        pub fn open() -> Option<Query> {
            unsafe {
                let mut q = PDH_HQUERY::default();
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != ERROR_SUCCESS {
                    return None;
                }
                let e = wide("\\GPU Engine(*)\\Utilization Percentage");
                let mut engine = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(q, PCWSTR(e.as_ptr()), 0, &mut engine) != ERROR_SUCCESS {
                    let _ = PdhCloseQuery(q);
                    return None;
                }
                let m = wide("\\GPU Process Memory(*)\\Dedicated Usage");
                let mut memory = PDH_HCOUNTER::default();
                let memory = (PdhAddEnglishCounterW(q, PCWSTR(m.as_ptr()), 0, &mut memory) == ERROR_SUCCESS).then_some(memory);
                // Prime the rate counter: the first formatted read needs two collections.
                let _ = PdhCollectQueryData(q);
                Some(Query { q, engine, memory })
            }
        }

        /// One collection: (engine instance, util %) and (memory instance, bytes). None = failed.
        pub fn collect(&self) -> Option<(Vec<(String, f64)>, Vec<(String, i64)>)> {
            unsafe {
                if PdhCollectQueryData(self.q) != ERROR_SUCCESS {
                    return None;
                }
                let engines = read_array(self.engine, PDH_FMT_DOUBLE, |v| v.Anonymous.doubleValue)?;
                let memory = self.memory.and_then(|c| read_array(c, PDH_FMT_LARGE, |v| v.Anonymous.largeValue)).unwrap_or_default();
                Some((engines, memory))
            }
        }
    }

    impl Drop for Query {
        fn drop(&mut self) {
            unsafe {
                let _ = PdhCloseQuery(self.q);
            }
        }
    }

    unsafe fn read_array<T>(c: PDH_HCOUNTER, fmt: PDH_FMT, get: impl Fn(&windows::Win32::System::Performance::PDH_FMT_COUNTERVALUE) -> T) -> Option<Vec<(String, T)>> {
        let (mut size, mut count) = (0u32, 0u32);
        let r = unsafe { PdhGetFormattedCounterArrayW(c, fmt, &mut size, &mut count, None) };
        if r == ERROR_SUCCESS && count == 0 {
            return Some(vec![]);
        }
        if r != PDH_MORE_DATA || size == 0 || size > MAX_BUF {
            return None;
        }
        // u64 backing keeps the item structs (which hold pointers / f64) 8-byte aligned.
        let mut buf: Vec<u64> = vec![0; (size as usize).div_ceil(8) + 1];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let r = unsafe { PdhGetFormattedCounterArrayW(c, fmt, &mut size, &mut count, Some(items)) };
        if r != ERROR_SUCCESS {
            return None;
        }
        let cap = buf.len() * 8 / std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let n = (count as usize).min(cap);
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let it = unsafe { &*items.add(i) };
            let st = it.FmtValue.CStatus;
            if st != PDH_CSTATUS_VALID_DATA && st != PDH_CSTATUS_NEW_DATA {
                continue;
            }
            if it.szName.is_null() {
                continue;
            }
            let name = unsafe { it.szName.to_string() }.unwrap_or_default();
            out.push((name, get(&it.FmtValue)));
        }
        Some(out)
    }
}

#[cfg(not(windows))]
mod pdh {
    pub struct Query;
    impl Query {
        pub fn open() -> Option<Query> {
            None
        }
        pub fn collect(&self) -> Option<(Vec<(String, f64)>, Vec<(String, i64)>)> {
            None
        }
    }
}

// ── Sampler (refcounted) ────────────────────────────────────────────────────

struct Sampler {
    refs: AtomicUsize,
    running: AtomicBool,
    latest: Mutex<Option<(Instant, Split)>>,
}

fn sampler() -> &'static Sampler {
    static S: std::sync::OnceLock<Sampler> = std::sync::OnceLock::new();
    S.get_or_init(|| Sampler { refs: AtomicUsize::new(0), running: AtomicBool::new(false), latest: Mutex::new(None) })
}

/// Keeps the sampler running while alive (RAII). Cheap to create and drop.
#[must_use = "the sampler stops when the Guard drops"]
pub struct Guard(());

impl Drop for Guard {
    fn drop(&mut self) {
        sampler().refs.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Start (or keep) the ~1 s sampler; it stops within ~1–2 s after the last Guard drops.
pub fn acquire() -> Guard {
    let s = sampler();
    s.refs.fetch_add(1, Ordering::SeqCst);
    if !s.running.swap(true, Ordering::SeqCst) {
        let spawned = std::thread::Builder::new().name("procstats".into()).spawn(run);
        if spawned.is_err() {
            s.running.store(false, Ordering::SeqCst);
        }
    }
    Guard(())
}

/// The newest split, None if none within the last 3 s (sampler off or just starting).
pub fn latest() -> Option<Split> {
    sampler().latest.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(at, _)| at.elapsed() < FRESH).map(|(_, s)| s.clone())
}

/// Is the sampler thread alive (tests / status)?
pub fn running() -> bool {
    sampler().running.load(Ordering::SeqCst)
}

fn read_procs(sys: &mut sysinfo::System, ncpu: f32) -> Vec<ProcInfo> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    // cmd is read once per process (OnlyIfNotSet): only python / uvicorn need it.
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory().with_cmd(UpdateKind::OnlyIfNotSet));
    sys.processes()
        .iter()
        .map(|(pid, p)| {
            let name = p.name().to_string_lossy().into_owned();
            let low = name.to_ascii_lowercase();
            let cmd = if low.starts_with("python") || low.starts_with("uvicorn") || low == "py.exe" {
                p.cmd().iter().map(|a| a.to_string_lossy().to_ascii_lowercase()).collect::<Vec<_>>().join(" ")
            } else {
                String::new()
            };
            ProcInfo { pid: pid.as_u32(), parent: p.parent().map(|pp| pp.as_u32()), name, cmd, start: p.start_time(), cpu_pct: p.cpu_usage() / ncpu, mem_bytes: p.memory() }
        })
        .collect()
}

/// Publish / sleep cadence of the sampler loop (pure, so the cold start is testable): the first
/// (priming) pass publishes nothing and is followed by a short [`COLD_GAP`]; every later pass
/// publishes and keeps the steady ~[`PERIOD`].
#[derive(Default)]
struct Cadence {
    primed: bool,
}

impl Cadence {
    /// Does the pass that just refreshed publish a Split?
    fn publish(&self) -> bool {
        self.primed
    }

    /// Sleep after a pass (`since_start`: since the pass began, `since_refresh`: since its
    /// refresh ended); marks the sampler primed.
    fn after_pass(&mut self, since_start: Duration, since_refresh: Duration) -> Duration {
        if std::mem::replace(&mut self.primed, true) {
            PERIOD.saturating_sub(since_start).max(MIN_REST)
        } else {
            COLD_GAP.saturating_sub(since_refresh)
        }
    }
}

/// Resets `running` if the sampler thread unwinds, so a later [`acquire`] starts a new sampler.
/// A normal exit leaves the flag alone (the loop already cleared it, or another sampler owns it).
struct ResetOnUnwind<'a>(&'a AtomicBool);

impl Drop for ResetOnUnwind<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.store(false, Ordering::SeqCst);
        }
    }
}

fn run() {
    let s = sampler();
    let _reset = ResetOnUnwind(&s.running);
    let me = std::process::id();
    let mut sys = sysinfo::System::new();
    sys.refresh_cpu_all();
    let ncpu = (sys.cpus().len().max(1)) as f32;
    let pdh = pdh::Query::open();
    let mut cadence = Cadence::default();
    loop {
        if s.refs.load(Ordering::SeqCst) == 0 {
            s.running.store(false, Ordering::SeqCst);
            // A Guard taken between the check and the store: resume unless another thread won.
            if s.refs.load(Ordering::SeqCst) == 0 || s.running.swap(true, Ordering::SeqCst) {
                break;
            }
        }
        let t0 = Instant::now();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let procs = read_procs(&mut sys, ncpu);
        let gpu = pdh.as_ref().and_then(|q| q.collect()).map(|(e, m)| GpuByPid::from_raw(&e, &m));
        let refreshed = Instant::now();
        // Sampler thread, never the UI: a cold nvidia-smi read (~80 ms) once is fine here. On the
        // priming pass it only warms the reading, inside the COLD_GAP wait.
        let g = super::system::gpu_now();
        if cadence.publish() {
            let totals = SystemTotals { cpu_pct: sys.global_cpu_usage(), ram_used_bytes: sys.used_memory(), gpu_util_pct: g.as_ref().map(|g| g.util_pct), vram_used_mb: g.as_ref().map(|g| g.vram_used_mb), vram_total_mb: g.as_ref().map(|g| g.vram_total_mb) };
            let sp = split(super::arbiter::now_ms(), &procs, me, &totals, gpu.as_ref());
            *s.latest.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), sp));
        }
        let rest = cadence.after_pass(t0.elapsed(), refreshed.elapsed());
        std::thread::sleep(rest);
    }
}

/// Footprints keyed for reports: element-wise peak of two footprints (pure; used for "peak during
/// a run" by callers that keep a running max).
pub fn peak(a: &Footprint, b: &Footprint) -> Footprint {
    let mx = |x: Option<f32>, y: Option<f32>| match (x, y) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    };
    let mxu = |x: Option<u64>, y: Option<u64>| match (x, y) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    };
    let mut names: BTreeMap<String, ()> = a.processes.iter().map(|n| (n.clone(), ())).collect();
    names.extend(b.processes.iter().map(|n| (n.clone(), ())));
    Footprint { cpu_pct: a.cpu_pct.max(b.cpu_pct), ram_used_gb: a.ram_used_gb.max(b.ram_used_gb), gpu_util_pct: mx(a.gpu_util_pct, b.gpu_util_pct), vram_used_mb: mxu(a.vram_used_mb, b.vram_used_mb), processes: names.into_keys().collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: Option<u32>, name: &str, start: u64, cpu: f32) -> ProcInfo {
        ProcInfo { pid, parent, name: name.into(), cmd: String::new(), start, cpu_pct: cpu, mem_bytes: 1_073_741_824 }
    }

    #[test]
    fn stack_names() {
        assert_eq!(stack_name("llama-server.exe", ""), Some("llama-server"));
        assert_eq!(stack_name("LM Studio.exe", ""), Some("LM Studio"));
        assert_eq!(stack_name("lms.exe", ""), Some("lms"));
        assert_eq!(stack_name("whisper-server.exe", ""), Some("whisper-server"));
        assert_eq!(stack_name("AnythingLLM.exe", ""), Some("AnythingLLM"));
        assert_eq!(stack_name("bionic-server", ""), Some("Bionic"));
        assert_eq!(stack_name("python.exe", "python -m uvicorn command_center_api:app"), Some("gateway"));
        assert_eq!(stack_name("pythonw.exe", "g:\\agentic os\\.venv\\pythonw.exe -m uvicorn x:app"), Some("gateway"));
        assert_eq!(stack_name("python.exe", "python -m uvicorn quantgress.main:app"), None);
        assert_eq!(stack_name("python.exe", "python train.py"), None);
        assert_eq!(stack_name("chrome.exe", "command_center_api"), None);
    }

    #[test]
    fn app_tree_includes_descendants_and_named_stacks() {
        let procs = vec![
            p(1, None, "System", 0, 1.0),
            p(100, Some(1), "command-center.exe", 10, 2.0),
            p(101, Some(100), "msedgewebview2.exe", 11, 1.0),
            p(102, Some(101), "msedgewebview2.exe", 12, 0.5),
            p(200, Some(1), "LM Studio.exe", 5, 0.5),
            p(201, Some(200), "llama-server.exe", 6, 3.0),
            p(202, Some(201), "conhost.exe", 7, 0.1),
            p(300, Some(1), "tws.exe", 3, 15.0),
            p(301, Some(300), "chromium.exe", 4, 18.0),
            // Parent pid 100 reused: this process started BEFORE command-center, not its child.
            p(400, Some(100), "spotify.exe", 2, 4.0),
        ];
        let app = app_pids(&procs, 100);
        let mut v: Vec<_> = app.into_iter().collect();
        v.sort();
        assert_eq!(v, vec![100, 101, 102, 200, 201, 202]);
    }

    #[test]
    fn engine_instance_parsing() {
        assert_eq!(parse_engine_instance("pid_1234_luid_0x00000000_0x0000D1B4_phys_0_eng_3_engtype_3D"), Some((1234, "0x00000000_0x0000D1B4|3D".into())));
        assert_eq!(parse_engine_instance("pid_9_luid_0x0_0x1_phys_0_eng_1_engtype_Compute_0"), Some((9, "0x0_0x1|Compute_0".into())));
        assert_eq!(parse_engine_instance("pid_x_luid_0_engtype_3D"), None);
        assert_eq!(parse_engine_instance("_Total"), None);
        assert_eq!(parse_pid("pid_77_luid_0x0_0x1_phys_0"), Some(77));
        assert_eq!(parse_pid("garbage"), None);
    }

    #[test]
    fn gpu_aggregation_is_task_manager_style() {
        let eng = |pid: u32, e: u32, ty: &str, v: f64| (format!("pid_{pid}_luid_0x0_0x1_phys_0_eng_{e}_engtype_{ty}"), v);
        let engines = vec![eng(10, 0, "3D", 30.0), eng(10, 1, "3D", 20.0), eng(10, 5, "Copy", 70.0), eng(11, 0, "3D", 40.0), eng(12, 2, "Compute_0", 95.0), eng(12, 0, "3D", 1.0), (String::from("bogus"), 50.0)];
        let mem = vec![("pid_10_luid_0x0_0x1_phys_0".to_string(), 512 * 1_048_576_i64), ("pid_10_luid_0x0_0x2_phys_0".to_string(), 512 * 1_048_576), ("pid_12_luid_0x0_0x1_phys_0".to_string(), 8_000 * 1_048_576)];
        let g = GpuByPid::from_raw(&engines, &mem);
        assert_eq!(g.pid_util(10), 70.0); // max(3D 50, Copy 70)
        assert_eq!(g.pid_util(12), 95.0);
        assert_eq!(g.pid_util(99), 0.0);
        assert_eq!(g.group_util([10, 11]), 90.0); // 3D: 50 + 40
        assert_eq!(g.group_util([10, 11, 12]), 95.0); // capped by max type
        assert_eq!(g.pid_vram_mb(10), 1024);
        assert_eq!(g.group_vram_mb([10, 12]), 9024);
    }

    #[test]
    fn split_adds_up_and_ranks_other() {
        let mut procs = vec![
            p(100, None, "command-center.exe", 10, 2.0),
            p(201, None, "llama-server.exe", 6, 3.0),
            p(300, None, "tws.exe", 3, 15.0),
            p(301, Some(300), "chromium.exe", 4, 18.0),
            p(302, None, "spotify.exe", 4, 1.0),
            p(303, None, "spotify.exe", 4, 0.5),
        ];
        procs.push(ProcInfo { cmd: "python -m uvicorn command_center_api:app".into(), ..p(150, None, "python.exe", 11, 1.2) });
        let sys = SystemTotals { cpu_pct: 41.0, ram_used_bytes: 20 * 1_073_741_824, gpu_util_pct: Some(97.0), vram_used_mb: Some(9640), vram_total_mb: Some(12288) };
        let g = GpuByPid::from_raw(&[("pid_201_luid_0x0_0x1_phys_0_eng_0_engtype_Compute_0".into(), 88.0), ("pid_301_luid_0x0_0x1_phys_0_eng_0_engtype_3D".into(), 9.0)], &[]);
        let s = split(5, &procs, 100, &sys, Some(&g));
        assert_eq!(s.app.cpu_pct, 6.2);
        assert_eq!(s.other.cpu_pct, 34.8);
        assert_eq!(s.app.ram_used_gb, 3.0);
        assert_eq!(s.other.ram_used_gb, 17.0);
        assert_eq!(s.app.gpu_util_pct, Some(88.0));
        assert_eq!(s.other.gpu_util_pct, Some(9.0));
        assert_eq!(s.app.processes, vec!["command-center", "gateway", "llama-server"]);
        assert_eq!(s.other.processes, vec!["chromium", "tws", "spotify"]);
        assert_eq!(s.top_other.len(), 4);
        assert_eq!(s.top_other[0].name, "chromium");
        assert_eq!(s.top_other[0].gpu_util_pct, Some(9.0));
        assert_eq!(s.vram_total_mb, Some(12288));
        // No PDH: per-process GPU is None, never zero.
        let s = split(5, &procs, 100, &sys, None);
        assert_eq!(s.app.gpu_util_pct, None);
        assert_eq!(s.top_other[0].vram_used_mb, None);
        assert_eq!(s.system.gpu_util_pct, Some(97.0));
    }

    #[test]
    fn strip_exe_is_char_boundary_safe() {
        assert_eq!(strip_exe("テスト"), "テスト"); // 9 bytes: byte n-4 is mid-char (used to panic)
        assert_eq!(strip_exe("テスト.exe"), "テスト");
        assert_eq!(strip_exe("a.exe"), "a");
        assert_eq!(strip_exe("A.EXE"), "A");
        assert_eq!(strip_exe("exe"), "exe");
        assert_eq!(strip_exe(".exe"), ".exe");
        assert_eq!(strip_exe(""), "");
        assert_eq!(stack_name("テスト", ""), None);
        // A multi-byte process name goes through the whole split without panicking.
        let procs = vec![p(100, None, "command-center.exe", 1, 1.0), p(5, None, "テスト", 1, 2.0), p(6, None, "ü", 1, 0.5)];
        let s = split(1, &procs, 100, &SystemTotals::default(), None);
        assert_eq!(s.top_other[0].name, "テスト");
        assert_eq!(s.other.processes, vec!["テスト", "ü"]);
    }

    #[test]
    fn cold_start_publishes_on_the_second_pass_after_a_short_gap() {
        let mut c = Cadence::default();
        // Priming pass: nothing published, next pass ~COLD_GAP after the refresh, not a PERIOD.
        assert!(!c.publish());
        assert_eq!(c.after_pass(Duration::from_millis(120), Duration::from_millis(30)), Duration::from_millis(170));
        assert_eq!(Cadence::default().after_pass(Duration::from_millis(400), Duration::from_millis(250)), Duration::ZERO);
        // Second pass publishes; from then on the steady ~1 s period.
        assert!(c.publish());
        assert_eq!(c.after_pass(Duration::from_millis(100), Duration::from_millis(20)), Duration::from_millis(900));
        assert!(c.publish());
        assert_eq!(c.after_pass(Duration::from_millis(1500), Duration::ZERO), MIN_REST);
    }

    #[test]
    fn running_flag_resets_only_when_the_sampler_unwinds() {
        static FLAG: AtomicBool = AtomicBool::new(true);
        let r = std::thread::spawn(|| {
            let _reset = ResetOnUnwind(&FLAG);
            panic!("sampler blew up");
        })
        .join();
        assert!(r.is_err());
        assert!(!FLAG.load(Ordering::SeqCst), "an unwinding sampler must clear `running`");
        // A normal exit leaves the flag to the loop (another sampler may own it by then).
        static OWNED: AtomicBool = AtomicBool::new(true);
        std::thread::spawn(|| {
            let _reset = ResetOnUnwind(&OWNED);
        })
        .join()
        .unwrap();
        assert!(OWNED.load(Ordering::SeqCst));
    }

    #[test]
    fn peak_is_elementwise() {
        let a = Footprint { cpu_pct: 5.0, ram_used_gb: 2.0, gpu_util_pct: None, vram_used_mb: Some(100), processes: vec!["a".into()] };
        let b = Footprint { cpu_pct: 3.0, ram_used_gb: 4.0, gpu_util_pct: Some(50.0), vram_used_mb: Some(50), processes: vec!["b".into()] };
        let p = peak(&a, &b);
        assert_eq!((p.cpu_pct, p.ram_used_gb, p.gpu_util_pct, p.vram_used_mb), (5.0, 4.0, Some(50.0), Some(100)));
        assert_eq!(p.processes, vec!["a", "b"]);
    }

    /// Real machine check (PDH + sysinfo), run explicitly:
    /// `cargo test --lib procstats::tests::live_sampler -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_sampler() {
        let q = pdh::Query::open();
        println!("pdh open: {}", q.is_some());
        std::thread::sleep(Duration::from_millis(1100));
        if let Some(q) = &q {
            let t0 = Instant::now();
            let r = q.collect();
            println!("pdh collect took {} ms", t0.elapsed().as_millis());
            match r {
                Some((e, m)) => {
                    println!("engine instances: {}, memory instances: {}", e.len(), m.len());
                    let g = GpuByPid::from_raw(&e, &m);
                    let mut top: Vec<_> = g.util.keys().map(|pid| (g.pid_util(*pid), *pid, g.pid_vram_mb(*pid))).collect();
                    top.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
                    println!("top gpu pids: {:?}", &top[..top.len().min(5)]);
                }
                None => println!("collect failed"),
            }
        }
        let mut sys = sysinfo::System::new();
        let t0 = Instant::now();
        let n = read_procs(&mut sys, 1.0).len();
        let t1 = Instant::now();
        read_procs(&mut sys, 1.0);
        println!("sysinfo processes: {n}, first refresh {} ms, steady refresh {} ms", (t1 - t0).as_millis(), t1.elapsed().as_millis());
        let g = acquire();
        let t0 = Instant::now();
        while latest().is_none() && t0.elapsed() < Duration::from_secs(6) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let cold = t0.elapsed();
        println!("cold start: first split after {} ms", cold.as_millis());
        println!("{}", serde_json::to_string_pretty(&latest()).unwrap());
        // Was priming + a whole PERIOD (> 1 s); now priming + COLD_GAP + one refresh.
        assert!(cold < Duration::from_millis(1000), "first split took {} ms", cold.as_millis());
        drop(g);
        std::thread::sleep(Duration::from_millis(2500));
        assert!(!running(), "sampler must stop after the last Guard");
    }
}
