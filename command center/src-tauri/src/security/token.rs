//! HMAC-SHA256 primitives shared with the gateway (`security_api.py` mirrors these exactly).
//!
//! - Elevation token: `v1.<b64url(json claims)>.<b64url(hmac(key, "v1." + b64claims))>`, claims
//!   `{m: module, sid, exp: unix secs, ep: epoch}`. The gateway accepts it only for `m`, before
//!   `exp`, while `ep` equals the epoch in `state.json` and the app isn't hard-locked.
//! - Remote kill webhook: `X-CC-Signature: sha256=<hex(hmac(secret, "<ts>.<raw body>"))>` with
//!   `X-CC-Timestamp: <unix secs>`, accepted within the configured skew.
//! - Companion approval: `hex(hmac(pairKey, "approve|<id>|<nonce>|<deviceId>"))`.

use argon2::password_hash::rand_core::{OsRng, RngCore};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// `n` random bytes from the OS CSPRNG, hex-encoded.
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    OsRng.fill_bytes(&mut b);
    super::hex(&b)
}

pub fn hmac_bytes(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}

/// Constant-time HMAC check.
pub fn hmac_verify(key: &[u8], msg: &[u8], tag: &[u8]) -> bool {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    m.update(msg);
    m.verify_slice(tag).is_ok()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Claims {
    pub m: String,
    pub sid: String,
    pub exp: u64,
    pub ep: u64,
}

pub fn mint(key: &[u8], claims: &Claims) -> String {
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default());
    let signed = format!("v1.{body}");
    let tag = URL_SAFE_NO_PAD.encode(hmac_bytes(key, signed.as_bytes()));
    format!("{signed}.{tag}")
}

/// Verify a token for `module` at `now` against the current `epoch` (pure).
pub fn verify(key: &[u8], token: &str, module: &str, now: u64, epoch: u64) -> Result<Claims, &'static str> {
    let mut parts = token.trim().splitn(3, '.');
    let (Some("v1"), Some(body), Some(tag)) = (parts.next(), parts.next(), parts.next()) else { return Err("malformed") };
    let tag = URL_SAFE_NO_PAD.decode(tag).map_err(|_| "malformed")?;
    if !hmac_verify(key, format!("v1.{body}").as_bytes(), &tag) {
        return Err("bad signature");
    }
    let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).map_err(|_| "malformed")?).map_err(|_| "malformed")?;
    if claims.m != module {
        return Err("wrong module");
    }
    if now >= claims.exp {
        return Err("expired");
    }
    if claims.ep != epoch {
        return Err("revoked");
    }
    Ok(claims)
}

/// `sha256=<hex>` for the remote kill webhook.
pub fn webhook_signature(secret: &[u8], ts: &str, body: &[u8]) -> String {
    let mut msg = format!("{ts}.").into_bytes();
    msg.extend_from_slice(body);
    format!("sha256={}", super::hex(&hmac_bytes(secret, &msg)))
}

/// Check a webhook signature (with or without the `sha256=` prefix) and its timestamp skew.
pub fn verify_webhook(secret: &[u8], ts: &str, body: &[u8], sig: &str, now: f64, max_skew: f64) -> Result<(), &'static str> {
    let t: f64 = ts.trim().parse().map_err(|_| "bad timestamp")?;
    if (now - t).abs() > max_skew {
        return Err("stale timestamp");
    }
    let hexsig = sig.trim().strip_prefix("sha256=").unwrap_or(sig.trim());
    let tag = super::unhex(hexsig).ok_or("bad signature")?;
    let mut msg = format!("{}.", ts.trim()).into_bytes();
    msg.extend_from_slice(body);
    if hmac_verify(secret, &msg, &tag) {
        Ok(())
    } else {
        Err("bad signature")
    }
}

pub fn companion_message(id: &str, nonce: &str, device: &str) -> String {
    format!("approve|{id}|{nonce}|{device}")
}

pub fn companion_sign(pair_key: &[u8], id: &str, nonce: &str, device: &str) -> String {
    super::hex(&hmac_bytes(pair_key, companion_message(id, nonce, device).as_bytes()))
}

pub fn companion_verify(pair_key: &[u8], id: &str, nonce: &str, device: &str, sig_hex: &str) -> bool {
    super::unhex(sig_hex).is_some_and(|tag| hmac_verify(pair_key, companion_message(id, nonce, device).as_bytes(), &tag))
}

fn alert_message(id: &str, ts: u64, severity: &str, title: &str, body: &str) -> String {
    format!("alert|{id}|{ts}|{severity}|{title}|{body}")
}

/// A desktop alert for the companion phone, signed with the pairing key (the gateway only
/// relays it and can't forge one).
pub fn alert_sign(pair_key: &[u8], id: &str, ts: u64, severity: &str, title: &str, body: &str) -> String {
    super::hex(&hmac_bytes(pair_key, alert_message(id, ts, severity, title, body).as_bytes()))
}

pub fn alert_verify(pair_key: &[u8], id: &str, ts: u64, severity: &str, title: &str, body: &str, sig_hex: &str) -> bool {
    super::unhex(sig_hex).is_some_and(|tag| hmac_verify(pair_key, alert_message(id, ts, severity, title, body).as_bytes(), &tag))
}

/// Constant-time equality for two secrets of possibly different length.
pub fn secret_eq(a: &str, b: &str) -> bool {
    // Compare HMACs of both under a random key: equal-length, constant-time, no length leak.
    let k = random_hex(16);
    hmac_verify(k.as_bytes(), a.as_bytes(), &hmac_bytes(k.as_bytes(), b.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevation_token_binds_module_expiry_and_epoch() {
        let key = b"0123456789abcdef0123456789abcdef";
        let c = Claims { m: "trading".into(), sid: "s1".into(), exp: 1_000, ep: 7 };
        let t = mint(key, &c);
        assert!(t.starts_with("v1."));
        assert_eq!(verify(key, &t, "trading", 999, 7).unwrap(), c);
        assert_eq!(verify(key, &t, "finance", 999, 7).unwrap_err(), "wrong module");
        assert_eq!(verify(key, &t, "trading", 1_000, 7).unwrap_err(), "expired");
        assert_eq!(verify(key, &t, "trading", 999, 8).unwrap_err(), "revoked");
        assert_eq!(verify(b"another-key", &t, "trading", 999, 7).unwrap_err(), "bad signature");
        // Tampered claims fail the signature.
        let forged = mint(key, &Claims { exp: 9_999, ..c.clone() });
        let mixed = format!("{}.{}", forged.rsplit_once('.').unwrap().0, t.rsplit_once('.').unwrap().1);
        assert_eq!(verify(key, &mixed, "trading", 999, 7).unwrap_err(), "bad signature");
        assert_eq!(verify(key, "nonsense", "trading", 0, 0).unwrap_err(), "malformed");
    }

    /// The same vectors are pinned in tests/test_security_layer.py: Rust mints, Python verifies.
    #[test]
    fn cross_language_vectors() {
        let key = b"0123456789abcdef0123456789abcdef";
        let t = mint(key, &Claims { m: "trading".into(), sid: "s1".into(), exp: 1000, ep: 7 });
        assert_eq!(t, "v1.eyJtIjoidHJhZGluZyIsInNpZCI6InMxIiwiZXhwIjoxMDAwLCJlcCI6N30.QsAV98QFC2VYH9O6jLxaImj4hFqcf6DLSCkDwrXxGn4");
        assert_eq!(webhook_signature(b"remote-secret", "1700000000", br#"{"reason":"phone"}"#), "sha256=338b3922e7e2848a8fc0e383180807fd869ca09d0a3b1a00fa98326b4c2e6731");
    }

    #[test]
    fn webhook_signature_and_replay_window() {
        let s = b"remote-secret";
        let body = br#"{"reason":"phone"}"#;
        let sig = webhook_signature(s, "1700000000", body);
        assert!(sig.starts_with("sha256="));
        assert!(verify_webhook(s, "1700000000", body, &sig, 1_700_000_030.0, 120.0).is_ok());
        assert!(verify_webhook(s, "1700000000", body, sig.trim_start_matches("sha256="), 1_700_000_030.0, 120.0).is_ok());
        assert_eq!(verify_webhook(s, "1700000000", body, &sig, 1_700_000_500.0, 120.0).unwrap_err(), "stale timestamp");
        assert_eq!(verify_webhook(s, "1700000000", b"{}", &sig, 1_700_000_000.0, 120.0).unwrap_err(), "bad signature");
        assert_eq!(verify_webhook(b"other", "1700000000", body, &sig, 1_700_000_000.0, 120.0).unwrap_err(), "bad signature");
    }

    #[test]
    fn companion_and_secret_eq() {
        let k = b"pair";
        let sig = companion_sign(k, "req1", "n1", "phone-1");
        assert!(companion_verify(k, "req1", "n1", "phone-1", &sig));
        assert!(!companion_verify(k, "req1", "n2", "phone-1", &sig));
        assert!(!companion_verify(b"x", "req1", "n1", "phone-1", &sig));
        assert!(secret_eq("abc", "abc") && !secret_eq("abc", "abd") && !secret_eq("abc", "abcd"));
    }
}
