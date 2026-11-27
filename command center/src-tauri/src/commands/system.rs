use serde::Serialize;
use std::sync::Mutex;
use sysinfo::System;
use tauri::State;

use crate::proc;

pub struct SysState(Mutex<System>);

impl Default for SysState {
    fn default() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self(Mutex::new(sys))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub name: String,
    pub util_pct: f32,
    pub vram_used_mb: u64,
    pub vram_total_mb: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    cpu_pct: f32,
    mem_used_mb: u64,
    mem_total_mb: u64,
    hostname: Option<String>,
    gpu: Option<GpuStats>,
}

#[tauri::command]
pub fn system_stats(state: State<'_, SysState>) -> Result<SystemStats, String> {
    sample(&state)
}

/// One CPU / RAM / GPU reading (shared by `system_stats` and `system_introspect`).
pub(crate) fn sample(state: &SysState) -> Result<SystemStats, String> {
    let (cpu_pct, mem_used_mb, mem_total_mb) = {
        let mut sys = state.0.lock().map_err(|_| "system state poisoned")?;
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (sys.global_cpu_usage(), sys.used_memory() / 1_048_576, sys.total_memory() / 1_048_576)
    };
    Ok(SystemStats {
        cpu_pct,
        mem_used_mb,
        mem_total_mb,
        hostname: System::host_name(),
        gpu: gpu_now(),
    })
}

/// CPU % and RAM used / total MB, without touching the GPU (the arbiter HUD's poll).
pub(crate) fn ram_cpu(state: &SysState) -> (f32, u64, u64) {
    match state.0.lock() {
        Ok(mut sys) => {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            (sys.global_cpu_usage(), sys.used_memory() / 1_048_576, sys.total_memory() / 1_048_576)
        }
        Err(_) => (0.0, 0, 0),
    }
}

/// CPU model name and logical thread count (read once; they don't change while running).
pub(crate) fn cpu_info() -> (Option<String>, usize) {
    static INFO: std::sync::OnceLock<(Option<String>, usize)> = std::sync::OnceLock::new();
    INFO.get_or_init(|| {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        let brand = sys.cpus().first().map(|c| c.brand().trim().to_string()).filter(|b| !b.is_empty());
        (brand, sys.cpus().len())
    })
    .clone()
}

// ── Resident GPU sampler ────────────────────────────────────────────────────
//
// Every `system_stats` poll, background `run_chat` (`gpu_busy`), hybrid `vram_pct` and System
// Map refresh used to spawn a fresh `nvidia-smi` (~40–80 ms of CPU and a process each). Now one
// `nvidia-smi … -lms 2000` stays resident while someone is asking and prints a line every 2 s;
// readers take the latest line. It exits after `GPU_IDLE` without a reader, so a closed window
// or an idle night costs nothing.

/// How often the resident sampler prints a reading.
pub const GPU_SAMPLE_MS: u64 = 2000;
/// A reading older than this is stale (the sampler died or is just starting).
const GPU_FRESH: std::time::Duration = std::time::Duration::from_millis(GPU_SAMPLE_MS * 3);
/// The sampler stops after this long without a reader.
const GPU_IDLE: std::time::Duration = std::time::Duration::from_secs(90);

struct GpuMonitor {
    latest: Mutex<Option<(std::time::Instant, GpuStats)>>,
    demand: Mutex<std::time::Instant>,
    running: std::sync::atomic::AtomicBool,
    /// nvidia-smi isn't there (AMD / no driver): never try the resident sampler again.
    absent: std::sync::atomic::AtomicBool,
}

fn monitor() -> &'static GpuMonitor {
    static M: std::sync::OnceLock<GpuMonitor> = std::sync::OnceLock::new();
    M.get_or_init(|| GpuMonitor { latest: Mutex::new(None), demand: Mutex::new(std::time::Instant::now()), running: false.into(), absent: false.into() })
}

/// The newest GPU reading (≤ 6 s old) from the resident sampler, started on demand. On a cold
/// start (no reading yet) it takes one blocking `query_gpu`, so the first caller still gets data.
pub fn gpu_now() -> Option<GpuStats> {
    use std::sync::atomic::Ordering;
    let m = monitor();
    *m.demand.lock().unwrap() = std::time::Instant::now();
    if let Some((at, g)) = m.latest.lock().unwrap().as_ref() {
        if at.elapsed() < GPU_FRESH {
            ensure_sampler();
            return Some(g.clone());
        }
    }
    if m.absent.load(Ordering::SeqCst) {
        return None;
    }
    let g = query_gpu();
    match &g {
        Some(g) => *m.latest.lock().unwrap() = Some((std::time::Instant::now(), g.clone())),
        None => m.absent.store(true, Ordering::SeqCst),
    }
    ensure_sampler();
    g
}

/// The cached reading only (never blocks, never spawns): for hot paths like the arbiter snapshot.
pub fn gpu_cached() -> Option<GpuStats> {
    *monitor().demand.lock().unwrap() = std::time::Instant::now();
    ensure_sampler();
    monitor().latest.lock().unwrap().as_ref().filter(|(at, _)| at.elapsed() < GPU_FRESH).map(|(_, g)| g.clone())
}

/// Is the resident sampler alive (System Map / morning report)?
pub fn gpu_sampler_running() -> bool {
    monitor().running.load(std::sync::atomic::Ordering::SeqCst)
}

fn parse_gpu_line(line: &str) -> Option<GpuStats> {
    let mut parts = line.split(',').map(str::trim);
    Some(GpuStats { name: parts.next()?.to_string(), util_pct: parts.next()?.parse().ok()?, vram_used_mb: parts.next()?.parse().ok()?, vram_total_mb: parts.next()?.parse().ok()? })
}

fn ensure_sampler() {
    use std::io::BufRead;
    use std::sync::atomic::Ordering;
    let m = monitor();
    if m.absent.load(Ordering::SeqCst) || m.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let ms = GPU_SAMPLE_MS.to_string();
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits", "-lms", &ms]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            m.absent.store(true, Ordering::SeqCst);
            m.running.store(false, Ordering::SeqCst);
            return;
        }
    };
    let Some(out) = child.stdout.take() else {
        let _ = child.kill();
        m.running.store(false, Ordering::SeqCst);
        return;
    };
    let spawned = std::thread::Builder::new().name("gpu-sampler".into()).spawn(move || {
        let m = monitor();
        for line in std::io::BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if let Some(g) = parse_gpu_line(&line) {
                *m.latest.lock().unwrap() = Some((std::time::Instant::now(), g));
            }
            if m.demand.lock().unwrap().elapsed() > GPU_IDLE {
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        m.running.store(false, Ordering::SeqCst);
    });
    if spawned.is_err() {
        m.running.store(false, Ordering::SeqCst);
    }
}

/// First NVIDIA GPU via nvidia-smi. Returns None on AMD/Intel/no driver.
/// TODO(cline): add AMD (rocm-smi) / Apple (powermetrics) probes if needed.
pub fn query_gpu() -> Option<GpuStats> {
    let out = proc::stdout(
        "nvidia-smi",
        &["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
    )
    .ok()?;
    let line = out.lines().next()?;
    let mut parts = line.split(',').map(str::trim);
    Some(GpuStats {
        name: parts.next()?.to_string(),
        util_pct: parts.next()?.parse().ok()?,
        vram_used_mb: parts.next()?.parse().ok()?,
        vram_total_mb: parts.next()?.parse().ok()?,
    })
}
