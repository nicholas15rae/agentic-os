//! The IPC gate: `lib.rs` wraps the generated invoke handler so EVERY app command passes through
//! `decide` before its handler runs. The webview can't skip it: there is no other way into Rust.
//!
//! - `security_*` commands always pass (each checks its own preconditions).
//! - Hard-locked (remote failsafe) → `HARD_LOCKED`, even with the layer disabled.
//! - Security disabled in the config → everything else passes.
//! - No live session (startup, idle, hourly re-verification, manual) → `LOCKED`.
//! - A command a protected module lists as mutating, without a live elevation for that module
//!   → `STEP_UP_REQUIRED:<module>` (the webview shows the PIN modal and retries).

use serde_json::Value;

use super::commands::{after_auto_lock, rt};
use super::config::SecurityConfig;
use super::session::Policy;

/// Pure decision for one invoke (the session lock is taken by the caller).
pub fn decide_with(cfg: &SecurityConfig, hard: bool, sessions: &mut super::session::Sessions, cmd: &str, args: Option<&Value>, now: f64) -> Result<(), String> {
    if cmd.starts_with("security_") {
        return Ok(());
    }
    if hard || sessions.is_hard_locked() {
        return Err("HARD_LOCKED: the remote failsafe locked this app; release it with `gabagool-cli clear-lock`".into());
    }
    if !cfg.enabled {
        return Ok(());
    }
    let p = Policy::from_config(cfg);
    sessions.tick(&p, now);
    if !sessions.is_live() {
        return Err("LOCKED: the Command Center is locked; unlock it first".into());
    }
    if let Some(m) = cfg.module_for_invoke(cmd, args) {
        if sessions.use_elevation(m, &p, now).is_none() {
            return Err(format!("STEP_UP_REQUIRED:{m}: {m} is read-only; confirm with your PIN to make changes"));
        }
    }
    Ok(())
}

/// Gate one invoke against the live state.
pub fn decide(cmd: &str, args: Option<&Value>) -> Result<(), String> {
    if cmd.starts_with("security_") {
        return Ok(());
    }
    let cfg = super::config::get();
    let r = rt();
    if !cfg.enabled && !r.is_hard() {
        return Ok(());
    }
    let (res, locked_now) = {
        let mut s = r.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let before = s.is_live();
        let res = decide_with(&cfg, r.is_hard(), &mut s, cmd, args, super::now());
        (res, if before && !s.is_live() { s.reason() } else { None })
    };
    if let Some(reason) = locked_now {
        after_auto_lock(reason);
    }
    if let Err(e) = &res {
        if e.starts_with("STEP_UP_REQUIRED") {
            note_denied(cmd, e);
        }
    }
    res
}

/// Audit refused step-ups, at most once per command per minute.
fn note_denied(cmd: &str, e: &str) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static LAST: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);
    let now = super::now();
    {
        let mut g = LAST.lock().unwrap_or_else(|p| p.into_inner());
        let m = g.get_or_insert_with(HashMap::new);
        if m.get(cmd).is_some_and(|t| now - t < 60.0) {
            return;
        }
        m.insert(cmd.to_string(), now);
    }
    let module = e.split(':').nth(1).unwrap_or("");
    super::audit::log("read_only_block", super::audit::Severity::Info, super::audit::Outcome::Failure, Some(module), "desktop-ui", serde_json::json!({ "command": cmd }));
}

#[cfg(test)]
mod tests {
    use super::super::session::Sessions;
    use super::*;
    use serde_json::json;

    #[test]
    fn locked_hard_locked_and_step_up() {
        let cfg = SecurityConfig::default();
        let p = Policy::from_config(&cfg);
        let mut s = Sessions::default();
        assert!(decide_with(&cfg, false, &mut s, "security_status", None, 0.0).is_ok());
        assert!(decide_with(&cfg, false, &mut s, "system_stats", None, 0.0).unwrap_err().starts_with("LOCKED"));
        s.unlock_pin(true, true, &p, 0.0, "s".into()).unwrap();
        assert!(decide_with(&cfg, false, &mut s, "system_stats", None, 1.0).is_ok());
        // Read-only by default: viewing passes, mutating needs step-up.
        assert!(decide_with(&cfg, false, &mut s, "finance_ledger_list", None, 1.0).is_ok());
        assert_eq!(decide_with(&cfg, false, &mut s, "finance_ledger_write", None, 1.0).unwrap_err().split(':').take(2).collect::<Vec<_>>(), ["STEP_UP_REQUIRED", "finance"]);
        let mic = json!({"patch": {"voice": {"micEnabled": false}}});
        assert!(decide_with(&cfg, false, &mut s, "os_config_update", Some(&mic), 1.0).is_ok());
        let mcp = json!({"patch": {"mcps": []}});
        assert!(decide_with(&cfg, false, &mut s, "os_config_update", Some(&mcp), 1.0).unwrap_err().starts_with("STEP_UP_REQUIRED:settings"));
        s.elevate("settings", true, &p, 2.0).unwrap();
        assert!(decide_with(&cfg, false, &mut s, "os_config_update", Some(&mcp), 3.0).is_ok());
        assert!(decide_with(&cfg, false, &mut s, "finance_ledger_write", None, 3.0).is_err(), "elevation is per module");
        // Idle past the timeout: the next invoke finds it locked.
        assert!(decide_with(&cfg, false, &mut s, "system_stats", None, 3.0 + p.idle_s).unwrap_err().starts_with("LOCKED"));
        assert!(decide_with(&cfg, true, &mut s, "system_stats", None, 0.0).unwrap_err().starts_with("HARD_LOCKED"));
        let off = SecurityConfig { enabled: false, ..SecurityConfig::default() };
        assert!(decide_with(&off, false, &mut Sessions::default(), "finance_ledger_write", None, 0.0).is_ok());
        assert!(decide_with(&off, true, &mut Sessions::default(), "system_stats", None, 0.0).unwrap_err().starts_with("HARD_LOCKED"), "the failsafe works even with the layer off");
    }
}
