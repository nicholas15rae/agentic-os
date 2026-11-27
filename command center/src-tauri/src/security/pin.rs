//! The local PIN: Argon2id (PHC string), never stored or logged in plaintext.
//!
//! The hash lives in the OS keychain (`security-pin@security`); where no keychain exists
//! (Android) it falls back to `<dir>/pin.phc`. Setting it is a CLI job (`gabagool-cli set-pin`),
//! so the webview can never create or replace the PIN.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use std::path::Path;

const ACCOUNT: &str = "security-pin@security";
const FILE: &str = "pin.phc";

fn argon() -> Argon2<'static> {
    // OWASP-grade: 64 MiB, 3 passes, 1 lane (tests use a tiny cost).
    #[cfg(not(test))]
    let p = Params::new(64 * 1024, 3, 1, None).expect("argon2 params");
    #[cfg(test)]
    let p = Params::new(1024, 1, 1, None).expect("argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, p)
}

/// A PIN is `min_len`..=32 ASCII digits (pure).
pub fn validate(pin: &str, min_len: usize) -> Result<(), String> {
    if pin.len() < min_len || pin.len() > 32 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("the PIN must be {min_len}–32 digits"));
    }
    if pin.chars().all(|c| c == pin.chars().next().unwrap_or('0')) {
        return Err("the PIN can't be one repeated digit".into());
    }
    if "01234567890123456789".contains(pin) || "98765432109876543210".contains(pin) {
        return Err("the PIN can't be a straight run of digits".into());
    }
    Ok(())
}

pub fn hash(pin: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    argon().hash_password(pin.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| e.to_string())
}

/// Constant-time Argon2id verification against a stored PHC string.
pub fn verify(pin: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else { return false };
    // Verify with the parameters embedded in the hash (not the current defaults).
    Argon2::default().verify_password(pin.as_bytes(), &parsed).is_ok()
}

fn entry() -> Option<keyring::Entry> {
    super::keychain(ACCOUNT)
}

/// The stored PHC string (keychain first, then `<dir>/pin.phc`).
pub fn load(dir: &Path) -> Option<String> {
    if let Some(v) = entry().and_then(|e| e.get_password().ok()).filter(|v| v.starts_with("$argon2id$")) {
        return Some(v);
    }
    std::fs::read_to_string(dir.join(FILE)).ok().map(|s| s.trim().to_string()).filter(|s| s.starts_with("$argon2id$"))
}

pub fn is_set(dir: &Path) -> bool {
    load(dir).is_some()
}

/// Hash and store a new PIN; returns where it went ("keychain" or "file").
pub fn store(dir: &Path, pin: &str, min_len: usize) -> Result<&'static str, String> {
    validate(pin, min_len)?;
    let phc = hash(pin)?;
    if let Some(e) = entry() {
        if e.set_password(&phc).is_ok() && e.get_password().ok().as_deref() == Some(phc.as_str()) {
            let _ = std::fs::remove_file(dir.join(FILE));
            return Ok("keychain");
        }
    }
    super::shared::write_atomic(&dir.join(FILE), phc.as_bytes()).map_err(|e| e.to_string())?;
    Ok("file")
}

/// Check `pin` against the stored hash (false when none is set).
pub fn check(dir: &Path, pin: &str) -> bool {
    load(dir).is_some_and(|phc| verify(pin, &phc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2id_hash_verifies_and_never_holds_plaintext() {
        let h = hash("482916").unwrap();
        assert!(h.starts_with("$argon2id$v=19$"));
        assert!(!h.contains("482916"));
        assert!(verify("482916", &h));
        assert!(!verify("482917", &h));
        assert!(!verify("482916", "not-a-hash"));
        assert_ne!(hash("482916").unwrap(), h, "random salt");
    }

    #[test]
    fn pin_rules() {
        assert!(validate("482916", 6).is_ok());
        assert!(validate("48291", 6).is_err());
        assert!(validate("48a916", 6).is_err());
        assert!(validate("111111", 6).is_err());
        assert!(validate("123456", 6).is_err());
        assert!(validate("654321", 6).is_err());
    }
}
