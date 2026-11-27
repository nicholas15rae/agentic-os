//! Sessions that survive an app restart (section pass). While the app is unlocked, a small
//! snapshot of the live session (id, last verification, last activity, the shared revocation
//! epoch) is kept in `<app local data>/session.sealed`, signed with an HMAC key that lives in the
//! OS keychain (`session-seal@security`), so the file can't be forged or edited. On start the
//! session comes back only when the signature checks out, the epoch is unchanged (no lock or
//! revocation happened anywhere since), and neither the idle lock nor the re-verification window
//! has run out. Any lock deletes the file. Step-up elevations are never restored.
//! Desktop only: the phone has no keychain (it keeps locking at start and unlocks with biometrics).

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "session.sealed";
const KEY_ACCOUNT: &str = "session-seal@security";
const VERSION: u8 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub v: u8,
    pub id: String,
    pub verified: f64,
    pub activity: f64,
    pub epoch: u64,
}

/// `<json>.<hex hmac>`. Pure.
pub fn seal(key: &[u8], s: &Snapshot) -> String {
    let body = serde_json::to_string(s).unwrap_or_default();
    format!("{body}.{}", super::hex(&super::token::hmac_bytes(key, body.as_bytes())))
}

/// The snapshot, when the tag is genuine (constant-time check). Pure.
pub fn unseal(key: &[u8], text: &str) -> Option<Snapshot> {
    let (body, tag) = text.trim().rsplit_once('.')?;
    let tag = super::unhex(tag)?;
    if !super::token::hmac_verify(key, body.as_bytes(), &tag) {
        return None;
    }
    serde_json::from_str::<Snapshot>(body).ok().filter(|s| s.v == VERSION)
}

/// Why a snapshot can't come back (None = restore it). Pure.
pub fn refuse(s: &Snapshot, now: f64, epoch: u64, idle_s: f64, reauth_s: f64) -> Option<&'static str> {
    if s.epoch != epoch {
        return Some("locked or revoked since");
    }
    // A clock that went backwards, or a snapshot from the future, is never trusted.
    if s.activity > now + 60.0 || s.verified > now + 60.0 || s.activity + 1.0 < s.verified {
        return Some("clock mismatch");
    }
    if now - s.verified >= reauth_s {
        return Some("re-verification due");
    }
    if now - s.activity >= idle_s {
        return Some("idle too long");
    }
    None
}

/// The sealing key from the OS keychain (made once). None where there is no keychain.
fn key() -> Option<Vec<u8>> {
    let e = super::keychain(KEY_ACCOUNT)?;
    if let Some(k) = e.get_password().ok().and_then(|h| super::unhex(&h)).filter(|k| k.len() == 32) {
        return Some(k);
    }
    let fresh = super::token::random_hex(32);
    e.set_password(&fresh).ok()?;
    super::unhex(&fresh)
}

pub fn save(dir: &Path, s: &Snapshot) {
    let Some(k) = key() else { return };
    let _ = std::fs::create_dir_all(dir);
    if let Err(e) = super::shared::write_atomic(&dir.join(FILE), seal(&k, s).as_bytes()) {
        eprintln!("[security] couldn't save the session ({e}); a restart will ask to unlock");
    }
}

pub fn clear(dir: &Path) {
    let p = dir.join(FILE);
    if p.exists() {
        let _ = std::fs::remove_file(p);
    }
}

/// Every sealed copy dies: the keychain's sealing key is replaced with a fresh one. Deleting the
/// file isn't enough on its own (a copy taken earlier could be put back, and the revocation epoch
/// lives in a plain file), so a lock always rotates the key too. False when the keychain refused
/// (the caller then stops saving for the rest of this run: fail closed).
pub fn revoke() -> bool {
    let Some(e) = super::keychain(KEY_ACCOUNT) else { return true };
    e.set_password(&super::token::random_hex(32)).is_ok()
}

/// Read and verify the saved snapshot (any problem: none, and the file is removed).
pub fn load(dir: &Path) -> Option<Snapshot> {
    let text = std::fs::read_to_string(dir.join(FILE)).ok()?;
    let s = key().and_then(|k| unseal(&k, &text));
    if s.is_none() {
        clear(dir);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> Snapshot {
        Snapshot { v: VERSION, id: "s1".into(), verified: 1000.0, activity: 1500.0, epoch: 9 }
    }

    #[test]
    fn a_sealed_session_round_trips_and_any_edit_breaks_it() {
        let k = [7u8; 32];
        let t = seal(&k, &snap());
        assert_eq!(unseal(&k, &t), Some(snap()));
        assert_eq!(unseal(&[8u8; 32], &t), None, "another key");
        let forged = t.replace("\"activity\":1500.0", "\"activity\":9999.0");
        assert_ne!(forged, t);
        assert_eq!(unseal(&k, &forged), None, "edited body");
        assert_eq!(unseal(&k, "garbage"), None);
    }

    #[test]
    fn only_a_fresh_unrevoked_session_comes_back() {
        let s = snap();
        let (idle, reauth) = (900.0, 3600.0);
        assert_eq!(refuse(&s, 1600.0, 9, idle, reauth), None);
        assert_eq!(refuse(&s, 1600.0, 10, idle, reauth), Some("locked or revoked since"));
        assert_eq!(refuse(&s, 1500.0 + idle, 9, idle, reauth), Some("idle too long"));
        assert_eq!(refuse(&Snapshot { activity: 4500.0, ..s.clone() }, 1000.0 + reauth, 9, idle, reauth), Some("re-verification due"));
        assert_eq!(refuse(&s, 1000.0, 9, idle, reauth), Some("clock mismatch"), "the clock went back");
    }

    #[test]
    fn save_load_clear_without_a_keychain_is_a_no_op() {
        let dir = std::env::temp_dir().join(format!("cc-persist-{}", std::process::id()));
        clear(&dir);
        assert_eq!(load(&dir), None);
    }
}
