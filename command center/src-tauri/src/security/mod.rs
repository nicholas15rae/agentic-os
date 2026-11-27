//! Sovereign security layer: app lock, step-up elevation, audit trail, alerts and the remote
//! failsafe. Enforcement lives here (Rust), never in the webview:
//!
//! - **IPC gate** (`gate`): every app command passes through `gate::decide` before its handler
//!   runs. A locked or hard-locked app refuses everything except `security_*`; commands a
//!   protected module lists as mutating need a live step-up elevation.
//! - **Sessions** (`session`): PIN (Argon2id, `pin`), biometrics (`biometric`) and companion
//!   approval (`companion`); an idle auto-lock and an hourly re-verification that needs double
//!   verification to resume.
//! - **Gateway tokens** (`token`): short-lived HMAC elevation tokens the Python gateway verifies
//!   for trading / finance / settings HTTP routes (`security_api.py`), bound to the shared
//!   revocation epoch in `state.json` (`shared`).
//! - **Audit** (`audit`): append-only, hash-chained `security_audit.jsonl`.
//! - **Alerts** (`alerts`): SMS (Twilio or a webhook / n8n) with an SMTP mirror; credentials from
//!   the environment, the repo `.env` or the OS keychain, never from code or the webview.
//! - **Failsafe** (`failsafe`): the headless emergency kill shared by `gabagool-cli` and the
//!   gateway webhook.
//!
//! Tunables live in `<dir>/security.config.json` (`config`), hot-reloaded and clamped. `<dir>` is
//! `<repo>/data/security` (shared with the gateway), overridable with `AGENTIC_OS_SECURITY_DIR`.

pub mod alerts;
pub mod audit;
pub mod biometric;
pub mod commands;
pub mod companion;
pub mod config;
pub mod failsafe;
pub mod gate;
pub mod pin;
pub mod session;
pub mod shared;
pub mod token;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// OS keychain service shared with `commands::secrets` (accounts here end in `@security`).
pub const KEYRING_SERVICE: &str = "agentic-os-command-center";

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Unix time in seconds (fractional).
/// The OS-keychain entry for `account`. None on Android/iOS: keyring 3 has no backend there and
/// would silently fall back to an in-memory mock (the value would vanish at restart), so callers
/// use their file in the app-private data folder instead.
pub fn keychain(account: &str) -> Option<keyring::Entry> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return None;
    }
    keyring::Entry::new(KEYRING_SERVICE, account).ok()
}

pub fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Where the shared security files live: `AGENTIC_OS_SECURITY_DIR`, else `<repo>/data/security`
/// (repo = providers.json `gateway.workdir`), else `<fallback>/security` (mobile: no repo).
pub fn resolve_dir(repo: Option<&Path>, fallback: Option<&Path>) -> PathBuf {
    if let Ok(d) = std::env::var("AGENTIC_OS_SECURITY_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d.trim());
        }
    }
    if let Some(r) = repo.filter(|r| !r.as_os_str().is_empty() && r.exists()) {
        return r.join("data").join("security");
    }
    fallback.map(|f| f.join("security")).unwrap_or_else(|| PathBuf::from("security"))
}

/// The repo (`<dir>/../..`) when `dir` is `<repo>/data/security`.
pub fn repo_of(dir: &Path) -> Option<PathBuf> {
    let data = dir.parent()?;
    (data.file_name()? == "data").then(|| data.parent().map(Path::to_path_buf)).flatten()
}

/// The app config dir the desktop build uses (`%APPDATA%\os.agentic.commandcenter` on Windows),
/// for the CLI, which runs without Tauri.
pub fn app_config_dir_guess() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }?;
    Some(base.join("os.agentic.commandcenter"))
}

/// providers.json `gateway.workdir` and `gateway.url`, read without Tauri (CLI).
pub fn providers_gateway(config_dir: &Path) -> (Option<PathBuf>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(config_dir.join("providers.json")) else { return (None, None) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return (None, None) };
    let g = &v["gateway"];
    (g["workdir"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from), g["url"].as_str().map(str::to_string))
}

/// Set once at startup (app or CLI); later calls are ignored.
pub fn set_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DIR.set(dir);
}

/// The security dir (set by `set_dir`; a relative `security/` before that).
pub fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| PathBuf::from("security"))
}

/// Stable per-install device id (`<dir>/device.id`) plus the host name, for audit entries.
pub fn device_id(dir: &Path) -> String {
    let p = dir.join("device.id");
    let id = match std::fs::read_to_string(&p) {
        Ok(s) if s.trim().len() >= 8 => s.trim().to_string(),
        _ => {
            let id = token::random_hex(8);
            let _ = std::fs::write(&p, &id);
            id
        }
    };
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "device".into());
    format!("{host}-{id}")
}

/// Hex encoding (lower-case).
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex decoding; None on odd length or a non-hex digit.
pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip_and_repo_of() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
        assert_eq!(unhex("000fff").unwrap(), vec![0, 15, 255]);
        assert!(unhex("abc").is_none() && unhex("zz").is_none());
        let d = PathBuf::from(r"G:\agentic os\data\security");
        assert_eq!(repo_of(&d).unwrap(), PathBuf::from(r"G:\agentic os"));
        assert!(repo_of(Path::new(r"C:\x\security")).is_none());
    }
}
