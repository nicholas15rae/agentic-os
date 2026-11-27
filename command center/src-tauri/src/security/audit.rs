//! `security_audit.jsonl`: the append-only, hash-chained security trail.
//!
//! One JSON object per line. Each line carries `prev` = SHA-256 of the previous line's exact bytes
//! (`"genesis"` for the first), so editing or deleting any line breaks the chain at the next one
//! (`verify`). Writers (app, CLI, gateway) take the shared `security.lock` and open the file in
//! append mode only; nothing ever rewrites it.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const FILE: &str = "security_audit.jsonl";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    Critical,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Success,
    Failure,
    Info,
}

/// What happened (the caller fills these; `append` adds time, sequence, device and chain).
#[derive(Clone, Debug)]
pub struct Event<'a> {
    pub event: &'a str,
    pub severity: Severity,
    pub outcome: Outcome,
    pub module: Option<&'a str>,
    /// Who / where from: `desktop-ui`, `cli`, `webhook:100.64.0.7`, …
    pub source: &'a str,
    pub detail: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Line<'a> {
    ts: String,
    unix: f64,
    seq: u64,
    event: &'a str,
    severity: Severity,
    outcome: Outcome,
    module: Option<&'a str>,
    device_id: &'a str,
    source: &'a str,
    detail: &'a Value,
    prev: String,
}

fn sha256_hex(b: &[u8]) -> String {
    super::hex(&Sha256::digest(b))
}

/// The last non-empty line of the file (reads at most the trailing 64 KiB).
fn last_line(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(64 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines().rev().find(|l| !l.trim().is_empty()).map(str::to_string)
}

/// Append one event; returns the written line.
pub fn append_in(dir: &Path, ev: &Event) -> std::io::Result<String> {
    let path = dir.join(FILE);
    let device = super::device_id(dir);
    let _g = super::shared::lock(dir)?;
    let (prev, seq) = match last_line(&path) {
        Some(l) => {
            let seq = serde_json::from_str::<Value>(&l).ok().and_then(|v| v["seq"].as_u64()).unwrap_or(0) + 1;
            (sha256_hex(l.as_bytes()), seq)
        }
        None => ("genesis".to_string(), 0),
    };
    let now = super::now();
    let ts = chrono::DateTime::<chrono::Utc>::from_timestamp_millis((now * 1000.0) as i64).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default();
    let line = Line { ts, unix: now, seq, event: ev.event, severity: ev.severity, outcome: ev.outcome, module: ev.module, device_id: &device, source: ev.source, detail: &ev.detail, prev };
    let text = serde_json::to_string(&line).map_err(std::io::Error::other)?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    f.write_all(format!("{text}\n").as_bytes())?;
    f.flush()?;
    Ok(text)
}

/// Append to the process security dir, then raise an alert when the config lists the event.
/// Never fails the caller: an audit write error is printed. The handle (when an alert went out)
/// lets a short-lived process wait for delivery.
pub fn record(ev: Event) -> Option<std::thread::JoinHandle<()>> {
    let dir = super::dir();
    if let Err(e) = append_in(&dir, &ev) {
        eprintln!("[security] audit write failed ({}): {e}", ev.event);
    }
    super::alerts::maybe_alert(&dir, &ev)
}

/// Shorthand for `record` (alert delivery continues in the background).
pub fn log(event: &str, severity: Severity, outcome: Outcome, module: Option<&str>, source: &str, detail: Value) {
    let _ = record(Event { event, severity, outcome, module, source, detail });
}

/// The newest `limit` entries (newest first).
pub fn recent(dir: &Path, limit: usize) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(dir.join(FILE)) else { return vec![] };
    text.lines().rev().filter(|l| !l.trim().is_empty()).take(limit).filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Chain check: Ok(lines) or Err((line number, problem)).
pub fn verify(dir: &Path) -> Result<usize, (usize, String)> {
    let Ok(text) = std::fs::read_to_string(dir.join(FILE)) else { return Ok(0) };
    let mut prev: Option<&str> = None;
    let mut n = 0;
    for (i, l) in text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(l).map_err(|e| (i + 1, format!("not JSON: {e}")))?;
        let want = prev.map(|p| sha256_hex(p.as_bytes())).unwrap_or_else(|| "genesis".into());
        if v["prev"].as_str() != Some(want.as_str()) {
            return Err((i + 1, "chain broken: prev hash does not match the line before".into()));
        }
        prev = Some(l);
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chain_appends_and_detects_tampering() {
        let d = std::env::temp_dir().join(format!("cc-sec-audit-{}", super::super::token::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..3 {
            append_in(&d, &Event { event: "login_failure", severity: Severity::Warn, outcome: Outcome::Failure, module: None, source: "test", detail: json!({"i": i}) }).unwrap();
        }
        assert_eq!(verify(&d), Ok(3));
        let r = recent(&d, 2);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["seq"], 2);
        assert_eq!(r[0]["detail"]["i"], 2);
        assert!(r[0]["deviceId"].as_str().unwrap().len() > 8);
        let text = std::fs::read_to_string(d.join(FILE)).unwrap();
        std::fs::write(d.join(FILE), text.replacen("\"i\":0", "\"i\":9", 1)).unwrap();
        assert_eq!(verify(&d).unwrap_err().0, 2, "editing line 1 breaks line 2's link");
        let _ = std::fs::remove_dir_all(&d);
    }
}
