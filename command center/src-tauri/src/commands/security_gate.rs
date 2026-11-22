//! `security`: the deterministic zero-trust gate (CPU only, zero VRAM, no model).
//!
//! - **Path gate** (`check_path`): before any packet worker reads or writes, a path must sit
//!   under an allowed root and match no denylist rule. The Finance vault (`vault/finance`) is
//!   refused to every mesh agent (librarian, prompter, coder, designer, observer); only the
//!   `financer` boundary (`finance_vault.rs`) opens it, and it never goes through this gate.
//! - **Secret scanner** (`scan_secrets`): regex rules for key material plus a Shannon-entropy
//!   check for long high-entropy tokens. `gate_output` fails CLOSED on any hit: the output is
//!   dropped, never stored, and the task fails.
//! - After a packet closes (done or failed closed), Security sends the purge handshake to the
//!   Garbage daemon (`garbage::handshake`) so the packet's scratch is wiped.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// Agents of the main mesh (never the vault).
pub const MESH_AGENTS: [&str; 6] = ["librarian", "prompter", "coder", "designer", "observer", "security"];

/// Path fragments no packet worker may read or write (lower-case, `/` separators).
pub const DENY: [&str; 12] = ["vault/finance", "/.ssh", "/.gnupg", "/.aws", "/.env", ".env.", "credentials", "id_rsa", "id_ed25519", ".pem", ".pfx", "/appdata/roaming/microsoft/credentials"];

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Lexically normalised absolute path (`..` resolved without touching the disk); Err when it
/// escapes its root or isn't absolute.
pub fn normalize(p: &Path) -> Result<PathBuf, String> {
    if !p.is_absolute() {
        return Err(format!("{}: not an absolute path", p.display()));
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    return Err("path traversal".into());
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// May `agent` touch `path` (read or write) given the allowed `roots`? (pure)
pub fn check_path(agent: &str, path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let raw = path.to_string_lossy();
    if raw.contains("..") && raw.split(['/', '\\']).any(|s| s == "..") {
        return Err(format!("SECURITY: path traversal refused ({raw})"));
    }
    let p = normalize(path).map_err(|e| format!("SECURITY: {e}"))?;
    let n = format!("/{}", norm(&p));
    if let Some(rule) = DENY.iter().find(|d| n.contains(*d)) {
        let what = if rule.starts_with("vault") { "the Finance vault is sealed off from the agent mesh" } else { "a denylisted secret location" };
        return Err(format!("SECURITY: {agent} may not touch {} ({what})", p.display()));
    }
    if MESH_AGENTS.contains(&agent) || agent == "garbage" {
        let ok = roots.iter().filter_map(|r| normalize(r).ok()).any(|r| p.starts_with(&r));
        if !ok {
            return Err(format!("SECURITY: {} is outside the allowed roots", p.display()));
        }
        return Ok(p);
    }
    Err(format!("SECURITY: unknown agent {agent}"))
}

fn secret_rules() -> &'static [(&'static str, regex::Regex)] {
    static R: OnceLock<Vec<(&'static str, regex::Regex)>> = OnceLock::new();
    R.get_or_init(|| {
        [
            ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            ("openai-key", r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}"),
            ("anthropic-key", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
            ("github-token", r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
            ("aws-key", r"\bAKIA[0-9A-Z]{16}\b"),
            ("google-key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
            ("slack-token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
            ("jwt", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
            ("assignment", r#"(?i)\b(api[_-]?key|secret|password|passwd|token|bearer)\b\s*[:=]\s*['"]?[A-Za-z0-9/+_\-]{16,}"#),
        ]
        .into_iter()
        .map(|(k, p)| (k, regex::Regex::new(p).unwrap()))
        .collect()
    })
}

/// Shannon entropy in bits per char (pure).
pub fn entropy(s: &str) -> f64 {
    let n = s.chars().count() as f64;
    if n == 0.0 {
        return 0.0;
    }
    let mut counts = std::collections::HashMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0u32) += 1;
    }
    counts.values().map(|&k| {
        let p = k as f64 / n;
        -p * p.log2()
    }).sum()
}

/// Every secret-looking finding in `text`: rule names (deduped). Long tokens that mix upper,
/// lower and digits with entropy ≥ 4.3 bits/char count as `high-entropy` (hex hashes don't:
/// they top out at 4.0).
pub fn scan_secrets(text: &str, known: &[String]) -> Vec<&'static str> {
    let mut hits: Vec<&'static str> = secret_rules().iter().filter(|(_, r)| r.is_match(text)).map(|(k, _)| *k).collect();
    if known.iter().any(|k| k.len() >= 8 && text.contains(k.as_str())) {
        hits.push("known-secret");
    }
    let high = text.split(|c: char| c.is_whitespace() || "\"'`,;()[]{}<>".contains(c)).any(|t| {
        t.len() >= 32 && t.chars().any(|c| c.is_ascii_uppercase()) && t.chars().any(|c| c.is_ascii_lowercase()) && t.chars().any(|c| c.is_ascii_digit()) && !t.contains("://") && entropy(t) >= 4.3
    });
    if high {
        hits.push("high-entropy");
    }
    hits.dedup();
    hits
}

/// Post-execution gate: Ok(output) or a fail-closed error naming the rules (never the secret).
pub fn gate_output(task_id: &str, output: &str, known: &[String]) -> Result<(), String> {
    let hits = scan_secrets(output, known);
    if hits.is_empty() {
        Ok(())
    } else {
        Err(format!("SECURITY_FAIL_CLOSED: {task_id} output matched {}; it was dropped", hits.join(", ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<PathBuf> {
        vec![PathBuf::from(r"G:\agentic os"), PathBuf::from(r"C:\Users\nic\AppData\Roaming\os.agentic.commandcenter\packets")]
    }

    #[test]
    fn mesh_agents_are_blocked_from_the_finance_vault() {
        let vault = PathBuf::from(r"C:\Users\nic\AppData\Roaming\os.agentic.commandcenter\vault\finance\ledger.aosv");
        let with_vault_root = [roots(), vec![PathBuf::from(r"C:\Users\nic\AppData\Roaming\os.agentic.commandcenter")]].concat();
        for agent in MESH_AGENTS {
            let e = check_path(agent, &vault, &with_vault_root).unwrap_err();
            assert!(e.contains("Finance vault"), "{agent}: {e}");
        }
        assert!(check_path("garbage", &vault, &with_vault_root).is_err(), "Garbage can't touch it either");
        assert!(check_path("librarian", Path::new(r"G:\agentic os\vault\finance\x.md"), &roots()).is_err());
    }

    #[test]
    fn traversal_roots_and_denylist() {
        assert!(check_path("coder", Path::new(r"G:\agentic os\command center\src\App.tsx"), &roots()).is_ok());
        assert!(check_path("coder", Path::new(r"G:\agentic os\..\Windows\system32\x"), &roots()).unwrap_err().contains("traversal"));
        assert!(check_path("coder", Path::new(r"D:\elsewhere\file.txt"), &roots()).unwrap_err().contains("outside"));
        assert!(check_path("librarian", Path::new(r"G:\agentic os\.env"), &roots()).is_err());
        assert!(check_path("librarian", Path::new(r"G:\agentic os\certs\server.pem"), &roots()).is_err());
        assert!(check_path("librarian", Path::new("relative/path.md"), &roots()).is_err());
    }

    #[test]
    fn secret_scanner_fails_closed_on_leaks_and_passes_clean_output() {
        let leaks = [
            "Use OPENAI key sk-proj-abcdefghijklmnopqrstuvwxyz0123",
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
            "export GITHUB=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "api_key = 'Q2xhdWRlQ29kZVNlY3JldEtleTEyMzQ1Ng'",
            "token AKIAIOSFODNN7EXAMPLE in the log",
            "aZ3kP9qL2mX7vB4nR8tY1wE6uI0oS5dF2gH7jK",
        ];
        for l in leaks {
            assert!(gate_output("t1", l, &[]).unwrap_err().starts_with("SECURITY_FAIL_CLOSED"), "{l}");
        }
        assert!(gate_output("t1", "the cached value is hunter2-long-known-value", &["hunter2-long-known-value".into()]).is_err());
        for clean in ["Patched token refresh; the expired-token test passes.", "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "See https://example.com/a/very/long/path/with/LotsOf/Segments123"] {
            assert!(gate_output("t1", clean, &[]).is_ok(), "{clean}");
        }
    }
}
