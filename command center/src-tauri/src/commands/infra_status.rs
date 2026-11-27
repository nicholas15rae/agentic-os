//! `system.status`: Tony's one read-only infrastructure tool, so "is the droplet up?", "is Docker
//! running?" or "are my servers up?" get a real answer on any turn, the phone's included (its
//! LIVE DASHBOARD is empty).
//!
//! It only looks. Every check is a short GET or a local status read:
//!   - the droplet: its model endpoint (the droplet link loop's last result when it is under
//!     `DROPLET_CACHE_SECS` old, else one GET of `/models`, as that loop does), plus the droplet's
//!     row in NetBird's own peer list (`netbird status --json`, a local daemon read);
//!   - the gateway, Bionic, speech-to-text, Kokoro and n8n: the System Map's own probes
//!     (`services::probe`, the same health URLs as `G:\ai-startup\ai-stack.config.ps1`);
//!   - Docker: one `GET /_ping` on the engine's named pipe (what `docker version` asks first).
//!
//! It never starts, stops, wakes (`netbird up`), reloads or changes anything, and a droplet that
//! is switched off in Settings, or the kill switch, means the droplet is not contacted at all.

use serde_json::Value;
use std::time::{Duration, Instant};

use super::dispatch::{short, Config, DispatchState, Kind, Provider};
use super::os_core::{self, OsConfig, OsState};

/// The server id (os.json `mcps[].id`) and its one tool.
pub(crate) const SERVER: &str = "system";
pub(crate) const TOOL: &str = "system.status";

/// Each loopback health GET (they all run at once).
const LOCAL_TIMEOUT: Duration = Duration::from_millis(2000);
/// The droplet's model endpoint, over the mesh.
const DROPLET_TIMEOUT: Duration = Duration::from_millis(3000);
/// `netbird status --json` (a local CLI; the call is abandoned, not waited on, past this).
const CLI_TIMEOUT: Duration = Duration::from_millis(3000);
/// Docker's engine pipe.
const DOCKER_TIMEOUT: Duration = Duration::from_millis(2000);
/// The droplet link loop probes every 15 s: a "connected" result this fresh is used as it is.
const DROPLET_CACHE_SECS: u64 = 30;

/// The app's note after a `system.status` result (in the TURN CONTEXT, after the tool data; never
/// in the system message). Measured on qwen3.5-9b with the droplet down: without it Tony offered
/// to "kick it back up" and once dispatched a Coder task to restart the droplet over ssh.
pub(crate) const ANSWER_NOTE: &str = "\n\nSYSTEM STATUS CHECK: answer what Nic asked from the status above in a sentence or two: name anything down or partly up with its reason, and say the rest is up (a latency only if he asks). This check only looks; it can't restart, fix or reboot anything. Don't offer to, and don't dispatch a task for it, unless Nic asks for that himself.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Health {
    Up,
    /// Reachable, but not all of it answers (the droplet on NetBird with its model server down).
    Partial,
    Down,
    /// Switched off by Nic (droplet switch, kill switch): not contacted, not a fault.
    Off,
}

impl Health {
    fn word(self) -> &'static str {
        match self {
            Health::Up => "UP",
            Health::Partial => "PARTLY UP",
            Health::Down => "DOWN",
            Health::Off => "OFF",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub label: String,
    pub health: Health,
    pub latency_ms: Option<u128>,
    pub detail: String,
}

/// `ANSWER_NOTE` when this turn's tool (`Prefetch::used`) was `system.status`, else "" (pure).
pub(crate) fn answer_note(used: Option<&str>) -> &'static str {
    if used == Some(TOOL) {
        ANSWER_NOTE
    } else {
        ""
    }
}

fn row(label: &str, health: Health, latency_ms: Option<u128>, detail: impl Into<String>) -> Row {
    Row { label: label.into(), health, latency_ms, detail: detail.into() }
}

// ── The report (pure) ────────────────────────────────────────────────────────

/// The tool's text: a summary line first (what a "is X up?" answer needs), then one line per
/// node. `clock`: the local time of the check ("12:41 AM").
pub(crate) fn render(rows: &[Row], clock: &str) -> String {
    let checked: Vec<&Row> = rows.iter().filter(|r| r.health != Health::Off).collect();
    let up = checked.iter().filter(|r| r.health == Health::Up).count();
    let names = |h: Health| rows.iter().filter(|r| r.health == h).map(|r| r.label.as_str()).collect::<Vec<_>>().join(", ");
    let mut summary = if up == checked.len() { format!("all {up} checked are up") } else { format!("{up} of {} checked are up", checked.len()) };
    for (h, what) in [(Health::Down, "down"), (Health::Partial, "partly up"), (Health::Off, "switched off, not checked")] {
        let n = names(h);
        if !n.is_empty() {
            summary.push_str(&format!("; {what}: {n}"));
        }
    }
    let mut out = format!("SYSTEM STATUS at {clock} (live read-only checks; nothing was started or changed): {summary}.");
    for r in rows {
        let ms = r.latency_ms.map(|m| format!(", {m} ms")).unwrap_or_default();
        let detail = if r.detail.is_empty() { String::new() } else { format!(" ({})", r.detail) };
        out.push_str(&format!("\n- {}: {}{ms}{detail}", r.label, r.health.word()));
    }
    out
}

/// The droplet link loop's last result (`OsState.runtime["droplet"]`) when it says "connected"
/// and is at most `DROPLET_CACHE_SECS` old: (latency ms, age s). Anything else is probed again.
pub(crate) fn fresh_droplet_link(v: Option<&Value>, now: u64) -> Option<(u128, u64)> {
    let v = v?;
    let at = v["at"].as_u64()?;
    let age = now.checked_sub(at)?;
    (v["state"].as_str() == Some("connected") && age <= DROPLET_CACHE_SECS).then(|| (v["latencyMs"].as_u64().unwrap_or(0) as u128, age))
}

/// NetBird's view of the droplet, from `netbird status --json`: its peer row whose `netbirdIp`
/// is `host`. `latency` is a Go duration in nanoseconds.
pub(crate) fn netbird_peer_note(status: &Value, host: &str) -> String {
    let mgmt = status["management"]["connected"].as_bool().unwrap_or(false);
    let signal = status["signal"]["connected"].as_bool().unwrap_or(false);
    let peer = status["peers"]["details"].as_array().into_iter().flatten().find(|p| p["netbirdIp"].as_str().map(|ip| ip.split('/').next().unwrap_or(ip)) == Some(host));
    let mesh = if mgmt && signal { "" } else { "; this PC's NetBird is not fully connected (management/signal)" };
    let Some(p) = peer else {
        return format!("not in NetBird's peer list{mesh}");
    };
    let state = p["status"].as_str().unwrap_or("unknown").to_ascii_lowercase();
    let kind = p["connectionType"].as_str().filter(|k| !k.is_empty() && *k != "-");
    let ms = p["latency"].as_u64().filter(|n| *n > 0).map(|ns| ns / 1_000_000);
    let extra = match (kind, ms) {
        (Some(k), Some(ms)) => format!(" ({k}, {ms} ms)"),
        (Some(k), None) => format!(" ({k})"),
        (None, Some(ms)) => format!(" ({ms} ms)"),
        (None, None) => String::new(),
    };
    format!("NetBird peer {state}{extra}{mesh}")
}

/// The droplet's row from its model-endpoint result and NetBird's note.
pub(crate) fn droplet_row(label: &str, model: Result<(u128, Option<u64>), String>, netbird: &str) -> Row {
    match model {
        Ok((ms, Some(age))) => row(label, Health::Up, Some(ms), format!("model server answered {age} s ago in the app's 15-second check; {netbird}")),
        Ok((ms, None)) => row(label, Health::Up, Some(ms), format!("model server answered; {netbird}")),
        // Reachable on the mesh: the box is there, its model server isn't answering.
        Err(e) if netbird.starts_with("NetBird peer connected") => row(label, Health::Partial, None, format!("model server not answering ({e}); {netbird}, so the droplet itself is reachable")),
        Err(e) => row(label, Health::Down, None, format!("model server not answering ({e}); {netbird}")),
    }
}

/// Docker's `/_ping` reply so far: `None` until the status line and headers are in, then
/// `Ok` for HTTP 200 and the status otherwise.
pub(crate) fn docker_ping_reply(buf: &[u8]) -> Option<Result<(), String>> {
    let text = String::from_utf8_lossy(buf);
    let head_end = text.find("\r\n\r\n")?;
    let status = text[..head_end].lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("").to_string();
    Some(if status == "200" { Ok(()) } else { Err(format!("engine answered HTTP {}", if status.is_empty() { "?" } else { status.as_str() })) })
}

/// The local services the tool reports, in order (pure): the gateway, the primary local model
/// (Bionic), every local speech-to-text server (the one `policy.stt` names marked as in use),
/// local TTS (Kokoro) and local n8n. A remote provider (cloud TTS, a droplet n8n) is left out:
/// the droplet has its own row and nothing else off this PC is "infrastructure" here.
pub(crate) fn status_targets(cfg: &Config) -> Vec<Provider> {
    let all = super::services::targets(cfg);
    let local = |p: &&Provider| !os_core::is_remote(p);
    let mut out: Vec<Provider> = Vec::new();
    out.extend(all.iter().filter(|p| p.id == "gateway").cloned());
    if let Some(p) = all.iter().find(|p| p.id == cfg.policy.primary_local).filter(local) {
        out.push(p.clone());
    }
    let mut stt: Vec<Provider> = all.iter().filter(|p| p.kind == Kind::Stt).filter(local).cloned().collect();
    // The one in use first.
    stt.sort_by_key(|p| p.id != cfg.policy.stt);
    for mut p in stt {
        p.label = format!("{} (speech-to-text, {})", p.label, if p.id == cfg.policy.stt { "in use" } else { "fallback" });
        out.push(p);
    }
    for kind in [Kind::Tts, Kind::N8n] {
        out.extend(all.iter().filter(|p| p.kind == kind).filter(local).cloned());
    }
    // One row per URL (the verifier shares Bionic's).
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.base_url.trim_end_matches('/').to_string()));
    out
}

// ── The probes ───────────────────────────────────────────────────────────────

/// Run every check at once and render the report.
pub(crate) async fn report(state: &DispatchState, os: &OsState) -> String {
    // Tony's model row follows the Section 26 engine switch (engine_route.rs).
    let cfg = state.chat_snapshot();
    let osc = os.snapshot();
    let cached = os.runtime.lock().unwrap().get("droplet").cloned();
    let locals = futures_util::future::join_all(status_targets(&cfg).into_iter().map(|p| super::services::probe(state, &osc, p, LOCAL_TIMEOUT)));
    let (locals, droplet, docker) = tokio::join!(locals, droplet(state, &osc, cached), timed_docker());
    let mut rows = vec![droplet];
    // Docker right before the containers it runs (Kokoro, n8n).
    let (before, after): (Vec<_>, Vec<_>) = locals.into_iter().partition(|h| !matches!(h.kind.as_str(), "tts" | "n8n"));
    rows.extend(before.into_iter().map(health_row));
    rows.push(docker);
    rows.extend(after.into_iter().map(health_row));
    render(&rows, &chrono::Local::now().format("%-I:%M %p").to_string())
}

fn health_row(h: super::services::ServiceHealth) -> Row {
    let health = if h.manual {
        Health::Off
    } else if h.up {
        Health::Up
    } else {
        Health::Down
    };
    let detail = if h.up { String::new() } else { h.detail };
    row(&h.label, health, h.up.then_some(h.latency_ms), detail)
}

async fn droplet(state: &DispatchState, osc: &OsConfig, cached: Option<Value>) -> Row {
    let d = &osc.droplet;
    let host = d.host.trim();
    let label = if host.is_empty() { "Droplet (over NetBird)".to_string() } else { format!("Droplet ({host} over NetBird)") };
    let netbird = netbird_note(host).await;
    if !d.enabled {
        return row(&label, Health::Off, None, format!("switched off in Settings, not contacted; {netbird}"));
    }
    if osc.privacy.kill_switch {
        return row(&label, Health::Off, None, format!("the kill switch is on, not contacted; {netbird}"));
    }
    let model = match fresh_droplet_link(cached.as_ref(), os_core::now_secs()) {
        Some((ms, age)) => Ok((ms, Some(age))),
        None => model_probe(state, &d.model_url).await.map(|ms| (ms, None)),
    };
    droplet_row(&label, model, &netbird)
}

/// One GET of the droplet's `/models`, exactly as the link loop does (401 = there, wants a key).
async fn model_probe(state: &DispatchState, url: &str) -> Result<u128, String> {
    if url.trim().is_empty() {
        return Err("no model URL set".into());
    }
    let t0 = Instant::now();
    let r = state.http.get(format!("{}/models", url.trim_end_matches('/'))).timeout(DROPLET_TIMEOUT).send().await.map_err(short)?;
    if r.status().is_success() || r.status().as_u16() == 401 {
        Ok(t0.elapsed().as_millis())
    } else {
        Err(format!("HTTP {}", r.status().as_u16()))
    }
}

/// NetBird's view of the droplet (a local read of the daemon's status; never `netbird up`).
async fn netbird_note(host: &str) -> String {
    if host.is_empty() {
        return "no droplet host set".into();
    }
    let run = tauri::async_runtime::spawn_blocking(|| crate::proc::stdout("netbird", &["status", "--json"]));
    match tokio::time::timeout(CLI_TIMEOUT, run).await {
        Ok(Ok(Ok(out))) => match serde_json::from_str::<Value>(&out) {
            Ok(v) => netbird_peer_note(&v, host),
            Err(_) => "NetBird status unreadable".into(),
        },
        Ok(Ok(Err(e))) => format!("NetBird not answering: {}", e.chars().take(120).collect::<String>()),
        Ok(Err(e)) => format!("NetBird check failed: {e}"),
        Err(_) => "NetBird status timed out".into(),
    }
}

async fn timed_docker() -> Row {
    const LABEL: &str = "Docker engine";
    let t0 = Instant::now();
    match tokio::time::timeout(DOCKER_TIMEOUT, docker_ping()).await {
        Ok(Ok(())) => row(LABEL, Health::Up, Some(t0.elapsed().as_millis()), ""),
        Ok(Err(e)) => row(LABEL, Health::Down, None, e),
        Err(_) => row(LABEL, Health::Down, None, "no answer within 2 s (starting up?)"),
    }
}

/// `GET /_ping` over a connected engine stream.
async fn ping_over<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut s: S) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    s.write_all(b"GET /_ping HTTP/1.0\r\nHost: docker\r\n\r\n").await.map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        let n = s.read(&mut chunk).await.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk[..n]);
        if let Some(r) = docker_ping_reply(&buf) {
            return r;
        }
        if n == 0 || buf.len() > 4096 {
            return Err("engine gave no HTTP answer".into());
        }
    }
}

#[cfg(windows)]
async fn docker_ping() -> Result<(), String> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut last = String::from("Docker isn't running (no engine pipe)");
    for name in [r"\\.\pipe\docker_engine", r"\\.\pipe\dockerDesktopLinuxEngine"] {
        match ClientOptions::new().open(name) {
            Ok(pipe) => return ping_over(pipe).await,
            // 2 = no such pipe (Docker not running); 231 = all instances busy.
            Err(e) if e.raw_os_error() == Some(2) => {}
            Err(e) => last = format!("engine pipe: {e}"),
        }
    }
    Err(last)
}

#[cfg(unix)]
async fn docker_ping() -> Result<(), String> {
    let s = tokio::net::UnixStream::connect("/var/run/docker.sock").await.map_err(|e| format!("Docker isn't running ({e})"))?;
    ping_over(s).await
}

#[cfg(not(any(windows, unix)))]
async fn docker_ping() -> Result<(), String> {
    Err("not checked on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn up(label: &str, ms: u128) -> Row {
        row(label, Health::Up, Some(ms), "")
    }

    #[test]
    fn report_leads_with_a_summary_and_lists_every_node() {
        let rows = vec![
            row("Droplet (100.84.235.228 over NetBird)", Health::Up, Some(84), "model server answered; NetBird peer connected (P2P, 28 ms)"),
            up("Gateway (server.py)", 3),
            up("Bionic (LM Studio)", 12),
            row("Whisper STT (speech-to-text, fallback)", Health::Down, None, "connection refused"),
            up("Docker engine", 9),
            up("n8n", 6),
        ];
        let out = render(&rows, "12:41 AM");
        let first = out.lines().next().unwrap();
        assert_eq!(first, "SYSTEM STATUS at 12:41 AM (live read-only checks; nothing was started or changed): 5 of 6 checked are up; down: Whisper STT (speech-to-text, fallback).");
        assert!(out.contains("\n- Droplet (100.84.235.228 over NetBird): UP, 84 ms (model server answered; NetBird peer connected (P2P, 28 ms))"), "{out}");
        assert!(out.contains("\n- Gateway (server.py): UP, 3 ms\n"), "{out}");
        assert!(out.contains("\n- Whisper STT (speech-to-text, fallback): DOWN (connection refused)"), "{out}");
        assert_eq!(out.lines().count(), 7);
    }

    #[test]
    fn switched_off_nodes_are_named_but_not_counted() {
        let rows = vec![row("Droplet", Health::Off, None, "switched off in Settings, not contacted"), up("Gateway", 2), row("Droplet model", Health::Partial, None, "x")];
        let out = render(&rows, "9:05 PM");
        assert!(out.starts_with("SYSTEM STATUS at 9:05 PM (live read-only checks; nothing was started or changed): 1 of 2 checked are up; partly up: Droplet model; switched off, not checked: Droplet."), "{out}");
        assert!(out.contains("- Droplet: OFF (switched off in Settings, not contacted)"), "{out}");
        let all = render(&[up("Gateway", 2), up("n8n", 4)], "1:00 AM");
        assert!(all.contains("): all 2 checked are up."), "{all}");
    }

    #[test]
    fn a_fresh_connected_link_is_reused_and_anything_else_is_probed() {
        let link = |state: &str, at: u64| json!({ "state": state, "detail": "100.84.235.228", "latencyMs": 84, "at": at });
        assert_eq!(fresh_droplet_link(Some(&link("connected", 1000)), 1012), Some((84, 12)));
        assert_eq!(fresh_droplet_link(Some(&link("connected", 1000)), 1000 + DROPLET_CACHE_SECS), Some((84, DROPLET_CACHE_SECS)));
        assert_eq!(fresh_droplet_link(Some(&link("connected", 1000)), 1001 + DROPLET_CACHE_SECS), None, "stale");
        for s in ["offline", "checking", "reconnecting", "disabled"] {
            assert_eq!(fresh_droplet_link(Some(&link(s, 1000)), 1001), None, "{s}");
        }
        assert_eq!(fresh_droplet_link(None, 5), None);
        assert_eq!(fresh_droplet_link(Some(&link("connected", 2000)), 1000), None, "a clock that went back");
    }

    fn netbird(peers: Value) -> Value {
        json!({ "management": { "connected": true }, "signal": { "connected": true }, "netbirdIp": "100.84.91.149/16", "peers": { "details": peers } })
    }

    #[test]
    fn netbird_note_reads_the_droplet_peer() {
        let v = netbird(json!([
            { "fqdn": "old.netbird.cloud", "netbirdIp": "100.84.1.36", "status": "Idle", "latency": 0, "connectionType": "-" },
            { "fqdn": "ubuntu-s-1vcpu-2gb-70gb-intel-tor1.netbird.cloud", "netbirdIp": "100.84.235.228", "status": "Connected", "latency": 28_227_829u64, "connectionType": "P2P" }
        ]));
        assert_eq!(netbird_peer_note(&v, "100.84.235.228"), "NetBird peer connected (P2P, 28 ms)");
        assert_eq!(netbird_peer_note(&v, "100.84.1.36"), "NetBird peer idle");
        assert_eq!(netbird_peer_note(&v, "100.84.0.9"), "not in NetBird's peer list");
        let mut down = v.clone();
        down["signal"]["connected"] = json!(false);
        assert_eq!(netbird_peer_note(&down, "100.84.235.228"), "NetBird peer connected (P2P, 28 ms); this PC's NetBird is not fully connected (management/signal)");
    }

    #[test]
    fn droplet_row_tells_a_dead_model_server_from_a_dead_droplet() {
        let r = droplet_row("Droplet", Ok((84, Some(6))), "NetBird peer connected (P2P, 28 ms)");
        assert_eq!((r.health, r.latency_ms), (Health::Up, Some(84)));
        assert_eq!(r.detail, "model server answered 6 s ago in the app's 15-second check; NetBird peer connected (P2P, 28 ms)");
        assert_eq!(droplet_row("Droplet", Ok((90, None)), "NetBird peer idle").detail, "model server answered; NetBird peer idle");
        let partial = droplet_row("Droplet", Err("HTTP 502".into()), "NetBird peer connected (P2P, 28 ms)");
        assert_eq!(partial.health, Health::Partial);
        assert!(partial.detail.contains("so the droplet itself is reachable"), "{}", partial.detail);
        let down = droplet_row("Droplet", Err("timed out".into()), "NetBird peer idle");
        assert_eq!((down.health, down.latency_ms), (Health::Down, None));
        assert_eq!(down.detail, "model server not answering (timed out); NetBird peer idle");
    }

    /// The answer note rides only on a turn that ran `system.status`, inside the TURN CONTEXT
    /// (Tony's system message stays byte-stable), and holds the "never offer a fix" rule.
    #[test]
    fn answer_note_only_after_a_status_check() {
        assert_eq!(answer_note(Some(TOOL)), ANSWER_NOTE);
        assert_eq!(answer_note(Some("weather.current")), "");
        assert_eq!(answer_note(None), "");
        assert!(ANSWER_NOTE.contains("can't restart, fix or reboot anything") && ANSWER_NOTE.contains("don't dispatch a task"), "{ANSWER_NOTE}");
        let block = super::super::agents::turn_context_block(&super::super::agents::TurnContext { tool_note: &format!("[LIVE MCP TOOL DATA - system]:\nx{ANSWER_NOTE}"), ..Default::default() });
        assert!(block.starts_with(super::super::agents::TURN_CONTEXT_HEAD) && block.contains("SYSTEM STATUS CHECK:"), "{block}");
    }

    #[test]
    fn docker_ping_reply_waits_for_the_headers() {
        assert_eq!(docker_ping_reply(b"HTTP/1.0 200 OK\r\nApi-Version: 1.47"), None);
        assert_eq!(docker_ping_reply(b"HTTP/1.0 200 OK\r\nApi-Version: 1.47\r\nContent-Length: 2\r\n\r\nOK"), Some(Ok(())));
        assert_eq!(docker_ping_reply(b"HTTP/1.1 500 Internal Server Error\r\n\r\n"), Some(Err("engine answered HTTP 500".into())));
        assert_eq!(docker_ping_reply(b"\r\n\r\n"), Some(Err("engine answered HTTP ?".into())));
    }

    /// The default providers: the gateway, Bionic, the speech-to-text in use, Kokoro and n8n, each
    /// once; never the droplet, AnythingLLM, the verifier, ElevenLabs or Google.
    #[test]
    fn targets_are_the_local_infrastructure_only() {
        let mut cfg = Config::default();
        let mut fw = cfg.providers.iter().find(|p| p.id == "whisper").unwrap().clone();
        fw.id = "faster-whisper".into();
        fw.label = "faster-whisper (GPU)".into();
        fw.base_url = "http://127.0.0.1:8177/v1".into();
        fw.engine = Some("fasterwhisper".into());
        cfg.providers.push(fw);
        cfg.policy.stt = "faster-whisper".into();
        let t = status_targets(&cfg);
        let ids: Vec<&str> = t.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["gateway", "lmstudio", "faster-whisper", "whisper", "kokoro", "n8n"]);
        assert_eq!(t[2].label, "faster-whisper (GPU) (speech-to-text, in use)");
        assert_eq!(t[3].label, "Whisper STT (speech-to-text, fallback)");
        // A remote n8n (a droplet's) is not this tool's to probe.
        cfg.providers.iter_mut().find(|p| p.id == "n8n").unwrap().base_url = "http://100.84.235.228:5678".into();
        assert!(!status_targets(&cfg).iter().any(|p| p.id == "n8n"));
    }

    /// Opt-in probe of the real report on this PC:
    /// `cargo test --lib infra_status::tests::live_report -- --ignored --nocapture`.
    /// Reads COPIES of the live providers.json / os.json (`load_or_init` rewrites the file it
    /// loads, so never the live one) and an OsState with no paths (nothing persisted, no phone
    /// mirror written). The checks themselves only read.
    #[test]
    #[ignore]
    fn live_report() {
        tauri::async_runtime::block_on(async {
            let live = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let copy = std::env::temp_dir().join(format!("infra-status-probe-{}", std::process::id()));
            std::fs::create_dir_all(&copy).unwrap();
            std::fs::copy(live.join("providers.json"), copy.join("providers.json")).unwrap();
            let state = DispatchState::default();
            state.load_or_init(&copy);
            let os = OsState::default();
            let saved: OsConfig = serde_json::from_str(&std::fs::read_to_string(live.join("os.json")).unwrap()).unwrap();
            os.update(|c| {
                c.droplet = saved.droplet.clone();
                c.privacy = saved.privacy.clone();
                Ok(())
            })
            .unwrap();
            let t0 = Instant::now();
            let out = report(&state, &os).await;
            println!("{out}\n(took {} ms)", t0.elapsed().as_millis());
            let _ = std::fs::remove_dir_all(&copy);
        });
    }

    #[test]
    fn off_and_down_service_rows() {
        let h = |up: bool, manual: bool| super::super::services::ServiceHealth { id: "n8n".into(), label: "n8n".into(), kind: "n8n".into(), up, latency_ms: 7, detail: if up { "200".into() } else { "connection refused".into() }, manual };
        assert_eq!(health_row(h(true, false)), up("n8n", 7));
        assert_eq!(health_row(h(false, false)), row("n8n", Health::Down, None, "connection refused"));
        assert_eq!(health_row(h(false, true)).health, Health::Off);
    }
}
