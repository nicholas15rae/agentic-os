//! Files the app, `gabagool-cli` and the gateway share in the security dir:
//!
//! - `state.json`: `{epoch, hardLocked, …}`. Every lock bumps `epoch`, which revokes every
//!   elevation token in flight; `hardLocked` is the remote failsafe's latch (only
//!   `gabagool-cli clear-lock` + the PIN releases it). Unreadable = hard-locked (fail closed).
//! - `elevation.key`: the HMAC key for elevation tokens (hex, generated once).
//! - `remote_kill.key`: the remote failsafe secret (hex; `CC_REMOTE_KILL_SECRET` overrides).
//! - `security.lock`: a cross-process mutex (create-new file) for state + audit writes.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const STATE: &str = "state.json";
pub const ELEVATION_KEY: &str = "elevation.key";
pub const REMOTE_KILL_KEY: &str = "remote_kill.key";
const LOCK: &str = "security.lock";

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SharedState {
    pub epoch: u64,
    pub hard_locked: bool,
    pub hard_locked_at: Option<f64>,
    pub hard_lock_reason: Option<String>,
    pub hard_lock_source: Option<String>,
    pub updated_at: f64,
}

/// Cross-process lock guard; the file is removed on drop.
pub struct FileLock(PathBuf);

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Take `<dir>/security.lock` (create-new), waiting up to ~2 s; a lock older than 10 s is stale
/// (its holder died) and is broken.
pub fn lock(dir: &Path) -> std::io::Result<FileLock> {
    let p = dir.join(LOCK);
    std::fs::create_dir_all(dir)?;
    for _ in 0..200 {
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => return Ok(FileLock(p)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > Duration::from_secs(10));
                if stale {
                    let _ = std::fs::remove_file(&p);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "security.lock is held"))
}

/// Atomic write: temp file + rename.
pub fn write_atomic(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = p.with_extension(format!("tmp-{}", super::token::random_hex(3)));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, p).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The shared state; missing = default (unlocked, epoch 0); unreadable = hard-locked.
pub fn read(dir: &Path) -> SharedState {
    match std::fs::read_to_string(dir.join(STATE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SharedState::default(),
        Err(_) => fail_closed(),
        Ok(t) => serde_json::from_str(&t).unwrap_or_else(|_| fail_closed()),
    }
}

fn fail_closed() -> SharedState {
    SharedState { hard_locked: true, hard_lock_reason: Some("unreadable state.json (fail closed)".into()), ..Default::default() }
}

/// Read-modify-write under the cross-process lock; returns the new state.
pub fn update(dir: &Path, f: impl FnOnce(&mut SharedState)) -> std::io::Result<SharedState> {
    let _g = lock(dir)?;
    let mut s = read(dir);
    f(&mut s);
    s.updated_at = super::now();
    write_atomic(&dir.join(STATE), serde_json::to_string_pretty(&s).unwrap_or_default().as_bytes())?;
    Ok(s)
}

/// New epoch: every elevation token minted before now is dead.
pub fn bump_epoch(dir: &Path) -> std::io::Result<u64> {
    update(dir, |s| s.epoch += 1).map(|s| s.epoch)
}

pub fn hard_lock(dir: &Path, reason: &str, source: &str) -> std::io::Result<SharedState> {
    update(dir, |s| {
        s.epoch += 1;
        if !s.hard_locked {
            s.hard_locked = true;
            s.hard_locked_at = Some(super::now());
            s.hard_lock_reason = Some(reason.chars().take(200).collect());
            s.hard_lock_source = Some(source.chars().take(80).collect());
        }
    })
}

pub fn clear_hard_lock(dir: &Path) -> std::io::Result<SharedState> {
    update(dir, |s| {
        s.epoch += 1;
        s.hard_locked = false;
        s.hard_locked_at = None;
        s.hard_lock_reason = None;
        s.hard_lock_source = None;
    })
}

fn read_key(p: &Path) -> Option<Vec<u8>> {
    let t = std::fs::read_to_string(p).ok()?;
    let k = super::unhex(t.trim())?;
    (k.len() >= 16).then_some(k)
}

/// The elevation HMAC key, generated (32 random bytes) on first use.
pub fn elevation_key(dir: &Path) -> std::io::Result<Vec<u8>> {
    let p = dir.join(ELEVATION_KEY);
    if let Some(k) = read_key(&p) {
        return Ok(k);
    }
    let _g = lock(dir)?;
    if let Some(k) = read_key(&p) {
        return Ok(k);
    }
    let hexkey = super::token::random_hex(32);
    write_atomic(&p, hexkey.as_bytes())?;
    Ok(super::unhex(&hexkey).unwrap_or_default())
}

/// The remote failsafe secret: `CC_REMOTE_KILL_SECRET` (env / repo `.env`) or `remote_kill.key`.
pub fn remote_kill_secret(dir: &Path) -> Option<String> {
    if let Some(v) = super::alerts::secret("CC_REMOTE_KILL_SECRET", dir) {
        return Some(v);
    }
    std::fs::read_to_string(dir.join(REMOTE_KILL_KEY)).ok().map(|s| s.trim().to_string()).filter(|s| s.len() >= 32)
}

/// Generate (or rotate) `remote_kill.key`; returns the new secret (shown once by the CLI).
pub fn rotate_remote_kill_secret(dir: &Path) -> std::io::Result<String> {
    let s = super::token::random_hex(32);
    let _g = lock(dir)?;
    write_atomic(&dir.join(REMOTE_KILL_KEY), s.as_bytes())?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-sec-shared-{}", super::super::token::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn epoch_hard_lock_and_fail_closed() {
        let d = tmp();
        assert_eq!(read(&d), SharedState::default());
        assert_eq!(bump_epoch(&d).unwrap(), 1);
        let s = hard_lock(&d, "phone", "webhook").unwrap();
        assert!(s.hard_locked && s.epoch == 2 && s.hard_lock_source.as_deref() == Some("webhook"));
        // Re-locking keeps the first cause but still revokes.
        let s = hard_lock(&d, "again", "cli").unwrap();
        assert_eq!((s.epoch, s.hard_lock_reason.as_deref()), (3, Some("phone")));
        let s = clear_hard_lock(&d).unwrap();
        assert!(!s.hard_locked && s.epoch == 4);
        std::fs::write(d.join(STATE), "garbage").unwrap();
        assert!(read(&d).hard_locked, "unreadable state fails closed");
        assert!(!d.join(LOCK).exists(), "lock released");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keys_are_generated_once() {
        let d = tmp();
        let k1 = elevation_key(&d).unwrap();
        assert_eq!(k1.len(), 32);
        assert_eq!(elevation_key(&d).unwrap(), k1);
        let s = rotate_remote_kill_secret(&d).unwrap();
        assert_eq!(s.len(), 64);
        let _ = std::fs::remove_dir_all(&d);
    }
}
