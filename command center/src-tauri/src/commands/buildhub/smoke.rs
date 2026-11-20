//! Smoke test (Phase 3): a lightweight lint / render-ability check of a build's output before it
//! can be promoted. Deterministic and local: file checks, HTML structure, sandbox-escape and
//! portability lint, plus `node --check` on inline scripts when Node is on PATH (skipped, never
//! failed, without it). Runs on a blocking thread, never the UI thread.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, Instant};

use super::Runtime;

pub const ENTRY: &str = "index.html";
pub const MIN_BYTES: u64 = 120;
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    /// `false` = advisory (shown, never fails the build).
    pub required: bool,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SmokeReport {
    pub passed: bool,
    pub at: i64,
    pub ms: u64,
    pub checks: Vec<Check>,
    /// The required checks that failed, one line each.
    pub failed_assertions: Vec<String>,
    /// A compact error trace for the Repair Queue.
    pub trace: String,
}

fn check(name: &str, ok: bool, required: bool, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok, required, detail: detail.into() }
}

fn count(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

/// Inline `<script>` bodies (no `src=`, not JSON / templates). Pure.
pub fn inline_scripts(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<script") {
        let start = from + i;
        let Some(tag_end) = lower[start..].find('>').map(|j| start + j + 1) else { break };
        let tag = &lower[start..tag_end];
        let Some(close) = lower[tag_end..].find("</script").map(|j| tag_end + j) else { break };
        let skip = tag.contains("src=") || tag.contains("application/json") || tag.contains("text/template") || tag.contains("importmap") || tag.contains("text/babel");
        if !skip {
            let body = html[tag_end..close].trim();
            if !body.is_empty() {
                out.push(body.to_string());
            }
        }
        from = close + 8;
    }
    out
}

/// The static checks over one HTML document (pure, unit-tested).
pub fn lint_html(html: &str, runtime: Runtime) -> Vec<Check> {
    let lower = html.to_ascii_lowercase();
    let mut v = Vec::new();
    v.push(check("html-document", lower.contains("<html") || lower.contains("<!doctype html"), true, "has <!doctype html> / <html>"));
    v.push(check("body", lower.contains("<body"), true, "has a <body>"));
    let (so, sc) = (count(&lower, "<script"), count(&lower, "</script>"));
    v.push(check("scripts-balanced", so == sc, true, format!("{so} <script> / {sc} </script>")));
    let (yo, yc) = (count(&lower, "<style"), count(&lower, "</style>"));
    v.push(check("styles-balanced", yo == yc, true, format!("{yo} <style> / {yc} </style>")));
    let local = ["file:///", "c:\\", "c:/users", "localhost:8080", "127.0.0.1:8080"];
    let hit = local.iter().find(|p| lower.contains(*p));
    v.push(check("portable", hit.is_none(), true, hit.map(|p| format!("references a local path or the gateway ({p})")).unwrap_or_else(|| "no local paths / gateway calls".into())));
    static SECRET: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = SECRET.get_or_init(|| regex::Regex::new(r#"(?i)\bsk-[a-z0-9_-]{16,}|\bapi[_-]?key\s*[:=]\s*["'][^"'\s]{12,}|\bbearer\s+[a-z0-9._~+/-]{24,}"#).unwrap());
    let s = re.find(html).map(|m| m.as_str().chars().take(6).collect::<String>());
    v.push(check("no-secrets", s.is_none(), true, s.map(|p| format!("looks like a credential ({p}…)")).unwrap_or_else(|| "no credential-shaped strings".into())));
    if runtime == Runtime::InternalWidget {
        let escape = ["top.location", "parent.location", "window.top", "window.parent.postmessage", "document.cookie"];
        let e = escape.iter().find(|p| lower.contains(*p));
        v.push(check("sandbox-safe", e.is_none(), true, e.map(|p| format!("tries to reach outside its sandbox ({p})")).unwrap_or_else(|| "stays inside its sandbox".into())));
    }
    let remote = count(&lower, "src=\"http") + count(&lower, "href=\"http");
    v.push(check("self-contained", remote == 0, false, if remote == 0 { "no remote assets".to_string() } else { format!("{remote} remote asset(s) (needs internet to render as designed)") }));
    v
}

/// `node --check` one script (`None` when Node isn't available). 10 s cap.
fn node_check(code: &str, dir: &Path, i: usize) -> Option<Result<(), String>> {
    let path = dir.join(format!(".smoke-inline-{i}.mjs"));
    std::fs::write(&path, code).ok()?;
    let mut cmd = std::process::Command::new("node");
    cmd.arg("--check").arg(&path).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = match cmd.spawn() {
        Ok(mut child) => {
            let t0 = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break child.wait_with_output().ok(),
                    Ok(None) if t0.elapsed() > Duration::from_secs(10) => {
                        let _ = child.kill();
                        break None;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                    Err(_) => break None,
                }
            }
        }
        Err(_) => None,
    };
    let _ = std::fs::remove_file(&path);
    let out = out?;
    if out.status.success() {
        Some(Ok(()))
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().find(|l| l.contains("SyntaxError")).unwrap_or_else(|| err.lines().last().unwrap_or("syntax error"));
        Some(Err(line.trim().chars().take(240).collect()))
    }
}

/// Run the smoke test over `dir` (the build's served output). Blocking.
pub fn run(dir: &Path, runtime: Runtime, now_ms: i64) -> SmokeReport {
    let t0 = Instant::now();
    let mut checks = Vec::new();
    let entry = dir.join(ENTRY);
    let meta = std::fs::metadata(&entry).ok();
    checks.push(check("entry-exists", meta.as_ref().is_some_and(|m| m.is_file()), true, format!("{}", entry.display())));
    if let Some(m) = meta.filter(|m| m.is_file()) {
        let n = m.len();
        checks.push(check("size", (MIN_BYTES..=MAX_BYTES).contains(&n), true, format!("{n} bytes (allowed {MIN_BYTES}–{MAX_BYTES})")));
        if let Ok(bytes) = std::fs::read(&entry) {
            let html = String::from_utf8_lossy(&bytes).into_owned();
            checks.extend(lint_html(&html, runtime));
            let scripts = inline_scripts(&html);
            let mut ran = false;
            for (i, s) in scripts.iter().enumerate().take(8) {
                match node_check(s, dir, i) {
                    Some(Ok(())) => ran = true,
                    Some(Err(e)) => {
                        ran = true;
                        checks.push(check("script-syntax", false, true, format!("inline script #{}: {e}", i + 1)));
                    }
                    None => break,
                }
            }
            if ran && !checks.iter().any(|c| c.name == "script-syntax") {
                checks.push(check("script-syntax", true, true, format!("{} inline script(s) parse (node --check)", scripts.len().min(8))));
            } else if !ran && !scripts.is_empty() {
                checks.push(check("script-syntax", true, false, "skipped: Node.js not found on PATH"));
            }
        }
    }
    finish(checks, now_ms, t0.elapsed().as_millis() as u64)
}

/// Fold checks into a report (pure).
pub fn finish(checks: Vec<Check>, now_ms: i64, ms: u64) -> SmokeReport {
    let failed: Vec<String> = checks.iter().filter(|c| c.required && !c.ok).map(|c| format!("{}: {}", c.name, c.detail)).collect();
    let trace = if failed.is_empty() { String::new() } else { format!("smoke test failed ({} check(s)):\n  {}", failed.len(), failed.join("\n  ")) };
    SmokeReport { passed: failed.is_empty(), at: now_ms, ms, checks, failed_assertions: failed, trace }
}
