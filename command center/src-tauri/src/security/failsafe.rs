//! The headless emergency kill, shared by `gabagool-cli emergency-kill` and (mirrored in Python)
//! the gateway webhook. It needs no GUI and no unlocked session:
//!
//! 1. **Revoke + hard-lock**: `state.json` → `hardLocked`, new epoch. Every elevation token dies
//!    at once; the running app sees it within a second, drops every session, refuses every IPC
//!    command but `security_*` and engages the outbound privacy kill switch.
//! 2. **Sever trading execution**: writes the desk lock `TRADING_LOCKED.json` (same file and
//!    format the trading kill switch uses), which the running bridge honours immediately: new
//!    intents are rejected and the executor places nothing. Open positions and broker-side
//!    bracket orders are NOT touched unless `remoteKill.flattenPositions` is on.
//! 3. **Audit + alert**: a `CRITICAL` `remote_kill` entry and an SMS confirmation.

use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub step: &'static str,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KillReport {
    pub ok: bool,
    pub incident_id: String,
    pub steps: Vec<Step>,
}

/// `TRADING_DATA_DIR`, else `<repo>/data/trading`.
pub fn trading_dir(repo: Option<&Path>) -> Option<PathBuf> {
    if let Ok(d) = std::env::var("TRADING_DATA_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d.trim()));
        }
    }
    repo.map(|r| r.join("data").join("trading"))
}

/// Write the desk lock unless one is already held (a lock is only ever widened).
pub fn write_trading_lock(tdir: &Path, reason: &str, actor: &str, incident: &str) -> std::io::Result<bool> {
    std::fs::create_dir_all(tdir)?;
    let p = tdir.join("TRADING_LOCKED.json");
    if p.exists() {
        return Ok(false);
    }
    let data = json!({ "locked": true, "at": super::now(), "reason": reason, "actor": actor, "incidentId": incident, "source": "security-failsafe" });
    super::shared::write_atomic(&p, serde_json::to_string_pretty(&data).unwrap_or_default().as_bytes())?;
    Ok(true)
}

/// Run the failsafe. `tdir` = the trading data dir (`trading_dir`); `gateway` (URL) is only used
/// when `flattenPositions` is on.
pub fn emergency_kill(dir: &Path, tdir: Option<&Path>, gateway: Option<&str>, reason: &str, source: &str) -> (KillReport, Option<std::thread::JoinHandle<()>>) {
    let incident = format!("sec-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let cfg = super::config::get_in(dir);
    let mut steps = vec![];
    match super::shared::hard_lock(dir, reason, source) {
        Ok(s) => steps.push(Step { step: "revoke-sessions", ok: true, detail: format!("hard lock on, epoch {} (every session and elevation token revoked)", s.epoch) }),
        Err(e) => steps.push(Step { step: "revoke-sessions", ok: false, detail: e.to_string() }),
    }
    match tdir {
        Some(t) => match write_trading_lock(t, &format!("remote failsafe: {reason}"), source, &incident) {
            Ok(true) => steps.push(Step { step: "trading-lock", ok: true, detail: format!("{} written; the bridge refuses new orders", t.join("TRADING_LOCKED.json").display()) }),
            Ok(false) => steps.push(Step { step: "trading-lock", ok: true, detail: "desk lock already held".into() }),
            Err(e) => steps.push(Step { step: "trading-lock", ok: false, detail: e.to_string() }),
        },
        None => steps.push(Step { step: "trading-lock", ok: false, detail: "no repo / TRADING_DATA_DIR to write the desk lock into".into() }),
    }
    if cfg.remote_kill.flatten_positions {
        steps.push(flatten(gateway, reason));
    } else {
        steps.push(Step { step: "positions", ok: true, detail: "left untouched (remoteKill.flattenPositions is off)".into() });
    }
    let ok = steps.iter().filter(|s| s.step != "positions").all(|s| s.ok);
    let ev = super::audit::Event {
        event: "remote_kill",
        severity: super::audit::Severity::Critical,
        outcome: if ok { super::audit::Outcome::Success } else { super::audit::Outcome::Failure },
        module: Some("trading"),
        source,
        detail: json!({ "reason": reason, "incidentId": incident, "steps": steps }),
    };
    if let Err(e) = super::audit::append_in(dir, &ev) {
        steps.push(Step { step: "audit", ok: false, detail: e.to_string() });
    }
    let alert = super::alerts::maybe_alert(dir, &ev);
    (KillReport { ok, incident_id: incident, steps }, alert)
}

fn flatten(gateway: Option<&str>, reason: &str) -> Step {
    let Some(g) = gateway else { return Step { step: "positions", ok: false, detail: "flattenPositions is on but no gateway URL is known".into() } };
    let url = format!("{}/api/trading/kill-switch", g.trim_end_matches('/'));
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return Step { step: "positions", ok: false, detail: e.to_string() },
    };
    let r = rt.block_on(async {
        let c = reqwest::Client::builder().timeout(std::time::Duration::from_secs(50)).build().map_err(|e| e.to_string())?;
        let r = c.post(&url).json(&json!({ "reason": format!("remote failsafe: {reason}"), "dryRun": false })).send().await.map_err(|e| e.without_url().to_string())?;
        Ok::<_, String>(r.status())
    });
    match r {
        Ok(s) if s.is_success() => Step { step: "positions", ok: true, detail: "trading E-stop called: cancel + flatten started".into() },
        Ok(s) => Step { step: "positions", ok: false, detail: format!("trading E-stop answered {s}") },
        Err(e) => Step { step: "positions", ok: false, detail: format!("trading E-stop unreachable ({e}); the desk lock still holds") },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_hard_locks_writes_desk_lock_and_audits_without_touching_positions() {
        let root = std::env::temp_dir().join(format!("cc-sec-kill-{}", super::super::token::random_hex(4)));
        let dir = root.join("data").join("security");
        std::fs::create_dir_all(&dir).unwrap();
        // Alerts off for the test (no network).
        std::fs::write(dir.join(super::super::config::FILE), r#"{"alerts":{"enabled":false}}"#).unwrap();
        let tdir = root.join("data").join("trading");
        let (r, alert) = emergency_kill(&dir, Some(&tdir), None, "test", "cli");
        assert!(alert.is_none());
        assert!(r.ok, "{r:?}");
        assert!(super::super::shared::read(&dir).hard_locked);
        let lock: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("data/trading/TRADING_LOCKED.json")).unwrap()).unwrap();
        assert_eq!(lock["locked"], true);
        assert_eq!(lock["incidentId"], r.incident_id.as_str());
        assert!(r.steps.iter().any(|s| s.step == "positions" && s.detail.contains("untouched")));
        let a = super::super::audit::recent(&dir, 1);
        assert_eq!(a[0]["event"], "remote_kill");
        assert_eq!(a[0]["severity"], "critical");
        // A second kill keeps the first desk lock.
        let (r2, _) = emergency_kill(&dir, Some(&tdir), None, "again", "cli");
        assert!(r2.steps.iter().any(|s| s.detail.contains("already held")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
