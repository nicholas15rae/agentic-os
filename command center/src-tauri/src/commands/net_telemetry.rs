//! Gateway popover network diagnostics: internet status + live ping, live RX/TX throughput, and
//! an on-demand ISP speed test.
//!
//! * `get_network_telemetry` is cheap (one TCP connect + an OS counter read). The webview polls it
//!   ONLY while the Gateway popover is open; nothing here runs in the background.
//! * Ping = TCP connect round-trip to 1.1.1.1:443 (fallback 8.8.8.8:443): no raw ICMP socket
//!   (needs admin on Windows), no HTTP payload.
//! * Throughput = byte deltas of the OS interface counters (sysinfo `Networks`) between two polls,
//!   across physical interfaces (loopback / virtual adapters skipped).
//! * `run_speed_test` only on the user's click: a timed ~10 MB download and ~3 MB upload against
//!   Cloudflare's speed endpoints, plus unloaded / loaded ping. Refused while the kill switch is on.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use super::os_core::OsState;

const PING_TARGETS: [&str; 2] = ["1.1.1.1:443", "8.8.8.8:443"];
const PING_TIMEOUT: Duration = Duration::from_millis(1500);
const DOWN_BYTES: u64 = 10_000_000;
const UP_BYTES: usize = 3_000_000;
const PHASE_TIMEOUT: Duration = Duration::from_secs(20);
pub const SPEED_EVENT: &str = "speed-test-progress";

// ── Pure helpers ────────────────────────────────────────────────────────────

/// Adapters that are not a real uplink (loopback, VPN / VM / container virtual NICs).
pub fn is_virtual(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["loopback", "lo", "vethernet", "virtualbox", "vmware", "hyper-v", "wsl", "docker", "tailscale", "zerotier", "isatap", "teredo", "bluetooth", "npcap", "pseudo"]
        .iter()
        .any(|v| if *v == "lo" { n == "lo" } else { n.contains(v) })
}

/// "Wi-Fi" / "Ethernet" / "Cellular" from an adapter name (else the name itself).
pub fn interface_kind(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    if n.contains("wi-fi") || n.contains("wifi") || n.contains("wlan") || n.contains("wireless") || n.starts_with("wl") {
        "Wi-Fi".into()
    } else if n.contains("ethernet") || n.starts_with("eth") || n.starts_with("en") || n.contains("lan") {
        "Ethernet".into()
    } else if n.contains("cellular") || n.contains("wwan") || n.contains("mobile") {
        "Cellular".into()
    } else {
        name.to_string()
    }
}

/// Bytes/second between two counter readings (0 after a counter reset or a too-short gap).
pub fn rate(prev: u64, now: u64, secs: f64) -> f64 {
    if secs < 0.05 || now < prev {
        0.0
    } else {
        (now - prev) as f64 / secs
    }
}

/// Megabits per second for `bytes` moved in `secs`.
pub fn mbps(bytes: u64, secs: f64) -> f64 {
    if secs <= 0.0 {
        0.0
    } else {
        (bytes as f64 * 8.0) / secs / 1_000_000.0
    }
}

// ── Live telemetry ──────────────────────────────────────────────────────────

struct Sampler {
    nets: sysinfo::Networks,
    last: Option<(Instant, u64, u64)>,
}

fn sampler() -> &'static Mutex<Sampler> {
    static S: OnceLock<Mutex<Sampler>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Sampler { nets: sysinfo::Networks::new_with_refreshed_list(), last: None }))
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetTelemetry {
    pub connected: bool,
    pub interface_name: Option<String>,
    pub interface_kind: Option<String>,
    pub ping_ms: Option<f64>,
    pub ping_target: Option<String>,
    /// Bytes/s since the previous poll (null on the first poll after the popover opened).
    pub down_bps: Option<f64>,
    pub up_bps: Option<f64>,
    pub at: i64,
}

/// TCP-connect round trip to the first answering target.
async fn tcp_ping() -> Option<(f64, String)> {
    for t in PING_TARGETS {
        let t0 = Instant::now();
        if let Ok(Ok(_s)) = tokio::time::timeout(PING_TIMEOUT, tokio::net::TcpStream::connect(t)).await {
            return Some((t0.elapsed().as_secs_f64() * 1000.0, t.split(':').next().unwrap_or(t).to_string()));
        }
    }
    None
}

/// Read the counters (blocking pool): totals across real uplinks + the busiest one's name.
fn read_counters() -> (Option<(Instant, u64, u64)>, (u64, u64), Option<String>) {
    let mut s = sampler().lock().unwrap();
    s.nets.refresh(true);
    let mut rx = 0u64;
    let mut tx = 0u64;
    let mut busiest: Option<(String, u64)> = None;
    for (name, d) in s.nets.list() {
        if is_virtual(name) {
            continue;
        }
        let (r, t) = (d.total_received(), d.total_transmitted());
        rx += r;
        tx += t;
        if busiest.as_ref().map_or(true, |(_, b)| r + t > *b) && r + t > 0 {
            busiest = Some((name.clone(), r + t));
        }
    }
    let prev = s.last.replace((Instant::now(), rx, tx));
    (prev, (rx, tx), busiest.map(|(n, _)| n))
}

/// One telemetry poll (the Gateway popover calls it every ~2 s while it is open).
#[tauri::command]
pub async fn get_network_telemetry() -> Result<NetTelemetry, String> {
    let ping = tcp_ping();
    let counters = tauri::async_runtime::spawn_blocking(read_counters);
    let (ping, counters) = tokio::join!(ping, counters);
    let (prev, (rx, tx), iface) = counters.map_err(|e| e.to_string())?;
    let (down, up) = match prev {
        Some((t, r0, t0)) => {
            let secs = t.elapsed().as_secs_f64();
            // A gap longer than a minute is a re-open, not a rate.
            if secs > 60.0 {
                (None, None)
            } else {
                (Some(rate(r0, rx, secs)), Some(rate(t0, tx, secs)))
            }
        }
        None => (None, None),
    };
    Ok(NetTelemetry {
        connected: ping.is_some(),
        interface_kind: iface.as_deref().map(interface_kind),
        interface_name: iface,
        ping_ms: ping.as_ref().map(|p| (p.0 * 10.0).round() / 10.0),
        ping_target: ping.map(|p| p.1),
        down_bps: down,
        up_bps: up,
        at: chrono::Utc::now().timestamp_millis(),
    })
}

/// The popover closed: forget the last sample so the next open starts clean.
#[tauri::command]
pub fn network_telemetry_stop() {
    sampler().lock().unwrap().last = None;
}

// ── Speed test ──────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub ping_ms: Option<f64>,
    pub loaded_ping_ms: Option<f64>,
    pub down_bytes: u64,
    pub up_bytes: u64,
    pub at: i64,
}

static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn progress(app: &AppHandle, phase: &str) {
    let _ = app.emit(SPEED_EVENT, serde_json::json!({ "phase": phase }));
}

/// The best of three small round trips (TCP connect), ms.
async fn ping_best() -> Option<f64> {
    let mut best: Option<f64> = None;
    for _ in 0..3 {
        if let Some((ms, _)) = tcp_ping().await {
            best = Some(best.map_or(ms, |b: f64| b.min(ms)));
        }
    }
    best.map(|b| (b * 10.0).round() / 10.0)
}

async fn download(http: &reqwest::Client) -> Result<(u64, f64), String> {
    use futures_util::StreamExt;
    let t0 = Instant::now();
    let res = http.get(format!("https://speed.cloudflare.com/__down?bytes={DOWN_BYTES}")).send().await.map_err(|e| format!("download: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download: HTTP {}", res.status()));
    }
    let mut got = 0u64;
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        got += chunk.map_err(|e| format!("download: {e}"))?.len() as u64;
    }
    Ok((got, t0.elapsed().as_secs_f64()))
}

async fn upload(http: &reqwest::Client) -> Result<(u64, f64), String> {
    let body = vec![0u8; UP_BYTES];
    let t0 = Instant::now();
    let res = http.post("https://speed.cloudflare.com/__up").header("content-type", "application/octet-stream").body(body).send().await.map_err(|e| format!("upload: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("upload: HTTP {}", res.status()));
    }
    Ok((UP_BYTES as u64, t0.elapsed().as_secs_f64()))
}

/// On-demand ISP speed test (only from the popover's Test Speed button). Emits
/// `speed-test-progress` phases: ping → download → upload → done.
#[tauri::command]
pub async fn run_speed_test(app: AppHandle, os: State<'_, OsState>) -> Result<SpeedResult, String> {
    if os.snapshot().privacy.kill_switch {
        return Err("kill switch is on — no outbound speed test".into());
    }
    if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("a speed test is already running".into());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _done = Done;
    let http = reqwest::Client::builder().timeout(PHASE_TIMEOUT).build().map_err(|e| e.to_string())?;
    progress(&app, "ping");
    let ping = ping_best().await;
    progress(&app, "download");
    // Loaded ping: one round trip measured while the download saturates the link.
    let loaded = async {
        tokio::time::sleep(Duration::from_millis(600)).await;
        tcp_ping().await.map(|p| (p.0 * 10.0).round() / 10.0)
    };
    let (down, loaded) = tokio::join!(download(&http), loaded);
    let (down_bytes, down_secs) = down?;
    progress(&app, "upload");
    let (up_bytes, up_secs) = upload(&http).await?;
    progress(&app, "done");
    let round = |v: f64| (v * 10.0).round() / 10.0;
    Ok(SpeedResult {
        download_mbps: round(mbps(down_bytes, down_secs)),
        upload_mbps: round(mbps(up_bytes, up_secs)),
        ping_ms: ping,
        loaded_ping_ms: loaded,
        down_bytes,
        up_bytes,
        at: chrono::Utc::now().timestamp_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_adapters() {
        assert_eq!(interface_kind("Wi-Fi"), "Wi-Fi");
        assert_eq!(interface_kind("WLAN 2"), "Wi-Fi");
        assert_eq!(interface_kind("Ethernet 3"), "Ethernet");
        assert_eq!(interface_kind("eth0"), "Ethernet");
        assert_eq!(interface_kind("Cellular"), "Cellular");
        assert_eq!(interface_kind("Hamachi"), "Hamachi");
        for v in ["Loopback Pseudo-Interface 1", "vEthernet (WSL)", "VirtualBox Host-Only Network", "Tailscale", "Docker Desktop"] {
            assert!(is_virtual(v), "{v}");
        }
        for r in ["Wi-Fi", "Ethernet", "eth0", "Local Area Connection"] {
            assert!(!is_virtual(r), "{r}");
        }
    }

    #[test]
    fn rates_and_megabits() {
        assert_eq!(rate(1000, 3000, 2.0), 1000.0);
        assert_eq!(rate(5000, 100, 2.0), 0.0, "a counter reset is not negative traffic");
        assert_eq!(rate(0, 100, 0.0), 0.0);
        assert!((mbps(10_000_000, 1.0) - 80.0).abs() < 1e-9);
        assert_eq!(mbps(1, 0.0), 0.0);
    }
}
