//! Vocal handoff cue pool (Thought-to-Product Phase 5): an editable JSON file,
//! `<app config dir>/handoff-cues.json`, seeded from the bundled default on first use. The webview
//! only reads it (it plays the cues over the existing TTS pipeline); nothing here touches audio.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use tauri::{AppHandle, Manager};

pub const POOL_FILE: &str = "handoff-cues.json";
pub const DEFAULT_POOL: &str = include_str!("../../../src/features/voice/handoff-cues.json");
const LINES_MAX: usize = 40;
const LINE_MAX: usize = 90;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Nicknames {
    pub nic: Vec<String>,
    pub tony: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub version: u32,
    pub max_seconds: f64,
    pub nicknames: Nicknames,
    #[serde(default)]
    pub agent_names: BTreeMap<String, String>,
    pub tony_open: Vec<String>,
    pub agent_reply: BTreeMap<String, Vec<String>>,
    pub tony_close: Vec<String>,
}

fn tidy(v: &mut Vec<String>) {
    v.retain(|l| !l.trim().is_empty() && l.chars().count() <= LINE_MAX);
    v.truncate(LINES_MAX);
}

/// Parse + sanitise a pool (pure). Errors when a required list ends up empty.
pub fn parse_pool(text: &str) -> Result<Pool, String> {
    let mut p: Pool = serde_json::from_str(text).map_err(|e| format!("{POOL_FILE}: {e}"))?;
    p.max_seconds = if p.max_seconds.is_finite() { p.max_seconds.clamp(2.0, 5.0) } else { 5.0 };
    for v in [&mut p.tony_open, &mut p.tony_close, &mut p.nicknames.nic, &mut p.nicknames.tony] {
        tidy(v);
    }
    for v in p.agent_reply.values_mut() {
        tidy(v);
    }
    if p.tony_open.is_empty() || p.tony_close.is_empty() || p.agent_reply.get("default").is_none_or(|d| d.is_empty()) {
        return Err(format!("{POOL_FILE}: tonyOpen, tonyClose and agentReply.default need at least one line of ≤ {LINE_MAX} chars"));
    }
    Ok(p)
}

/// Read `dir/handoff-cues.json`, seeding it from the default when missing. A broken file is left
/// for Nic to fix and the default is used meanwhile.
pub fn load(dir: &Path) -> (Pool, String) {
    let path = dir.join(POOL_FILE);
    if !path.exists() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&path, DEFAULT_POOL);
    }
    let pool = std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| parse_pool(&t)).unwrap_or_else(|e| {
        eprintln!("[handoff] {e}; using the built-in pool");
        parse_pool(DEFAULT_POOL).expect("bundled pool is valid")
    });
    (pool, path.display().to_string())
}

#[tauri::command]
pub fn handoff_pool_get(app: AppHandle) -> Result<Value, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let (pool, path) = load(&dir);
    Ok(serde_json::json!({ "pool": pool, "path": path }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_pool_is_valid_and_short() {
        let p = parse_pool(DEFAULT_POOL).unwrap();
        assert!(p.max_seconds <= 5.0);
        assert!(p.tony_open.iter().chain(&p.tony_close).all(|l| l.chars().count() <= LINE_MAX));
        for role in ["coder", "designer", "prompter", "librarian", "booking", "ops"] {
            assert!(p.agent_names.contains_key(role), "{role}");
        }
    }

    #[test]
    fn broken_or_empty_pools_fall_back() {
        assert!(parse_pool("{").is_err());
        let mut v: Value = serde_json::from_str(DEFAULT_POOL).unwrap();
        v["tonyOpen"] = serde_json::json!(["x".repeat(200)]);
        assert!(parse_pool(&v.to_string()).is_err(), "over-long lines are dropped, leaving nothing");
        let mut v: Value = serde_json::from_str(DEFAULT_POOL).unwrap();
        v["maxSeconds"] = serde_json::json!(30);
        assert_eq!(parse_pool(&v.to_string()).unwrap().max_seconds, 5.0);
    }

    #[test]
    fn load_seeds_the_editable_file_then_reads_edits() {
        let dir = std::env::temp_dir().join(format!("handoff-{}-{}", std::process::id(), chrono::Utc::now().timestamp_millis()));
        let (p, path) = load(&dir);
        assert!(Path::new(&path).is_file());
        assert_eq!(p, parse_pool(DEFAULT_POOL).unwrap());
        let mut v: Value = serde_json::from_str(DEFAULT_POOL).unwrap();
        v["tonyClose"] = serde_json::json!(["Fuhgeddaboudit."]);
        std::fs::write(&path, v.to_string()).unwrap();
        assert_eq!(load(&dir).0.tony_close, vec!["Fuhgeddaboudit.".to_string()]);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&dir).0, parse_pool(DEFAULT_POOL).unwrap(), "a broken edit never kills the cues");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
