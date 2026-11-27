//! Out-of-band alerts over the channels in `alerts.channels`, in order: the paired companion
//! phone (default; signed, queued in the gateway mailbox), a webhook such as a local n8n flow
//! (default fallback), Twilio SMS and SMTP email (opt-in). Unconfigured channels are skipped.
//!
//! Credentials resolve per call: process environment → `<repo>/.env` → OS keychain account
//! `<NAME>@security`. Nothing is hard-coded, logged or sent to the webview. Alert text carries the
//! event, module, device and time only, never a PIN, token or secret.
//!
//! | Variable | Use |
//! |---|---|
//! | (none) | companion: just `gabagool-cli pair-companion` |
//! | `CC_ALERT_SMS_TO` | Twilio destination phone (E.164) |
//! | `CC_TWILIO_ACCOUNT_SID`, `CC_TWILIO_AUTH_TOKEN`, `CC_TWILIO_FROM` | Twilio |
//! | `CC_ALERT_WEBHOOK_URL`, `CC_ALERT_WEBHOOK_SECRET` (optional HMAC) | webhook / n8n |
//! | `CC_SMTP_HOST`, `CC_SMTP_PORT` (587 STARTTLS / 465 TLS), `CC_SMTP_USER`, `CC_SMTP_PASS`, `CC_ALERT_EMAIL_FROM`, `CC_ALERT_EMAIL_TO` | email |

use super::audit::{Event, Severity};
use super::config::SecurityConfig;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Alert {
    pub event: String,
    pub title: String,
    pub body: String,
    pub severity: Severity,
}

/// A credential: env → repo `.env` → keychain (`<name>@security`). Empty = absent.
pub fn secret(name: &str, dir: &Path) -> Option<String> {
    if let Ok(v) = std::env::var(name) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    if let Some(repo) = super::repo_of(dir) {
        if let Ok(text) = std::fs::read_to_string(repo.join(".env")) {
            if let Some(v) = crate::commands::envfile::parse_env_text(&text, name) {
                return Some(v);
            }
        }
    }
    super::keychain(&format!("{name}@security"))?.get_password().ok().filter(|v| !v.trim().is_empty())
}

/// The human text for an audit event (pure).
pub fn compose(ev: &Event, device: &str) -> Alert {
    let what = match ev.event {
        "login_success" => "App unlocked".to_string(),
        "login_failure" => "Failed unlock attempt".to_string(),
        "pin_lockout" => "PIN locked out after repeated failures".to_string(),
        "reverify_success" => "Session re-verified".to_string(),
        "second_factor_fallback" => "Unlocked with PIN only (no second factor reachable)".to_string(),
        "hard_lock" => "HARD LOCK engaged".to_string(),
        "remote_kill" => "REMOTE EMERGENCY KILL executed".to_string(),
        "remote_kill_rejected" => "Rejected remote kill attempt".to_string(),
        "kill_switch" => "Kill switch engaged".to_string(),
        "trading_kill_switch" => "Trading kill switch tripped".to_string(),
        "pin_changed" => "Security PIN changed".to_string(),
        "unknown_device" => "Unknown device tried to reach the gateway".to_string(),
        other => other.replace('_', " "),
    };
    let module = ev.module.map(|m| format!(" [{m}]")).unwrap_or_default();
    let reason = ev.detail.get("reason").and_then(|v| v.as_str()).map(|r| format!(" — {}", r.chars().take(80).collect::<String>())).unwrap_or_default();
    let tag = match ev.severity {
        Severity::Critical => "CRITICAL",
        Severity::Warn => "WARN",
        Severity::Info => "INFO",
    };
    let when = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    Alert {
        event: ev.event.into(),
        title: format!("[Command Center {tag}] {what}"),
        body: format!("{what}{module}{reason}. Device {device}, source {}, {when}. Not you? Run `gabagool-cli emergency-kill`.", ev.source).chars().take(300).collect(),
        severity: ev.severity,
    }
}

static LAST: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);

/// Throttle: same event at most once per `min_interval` seconds; critical always passes.
fn throttled(event: &str, critical: bool, min_interval: f64, now: f64) -> bool {
    if critical || min_interval <= 0.0 {
        return false;
    }
    let mut g = LAST.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if m.get(event).is_some_and(|t| now - t < min_interval) {
        return true;
    }
    m.insert(event.to_string(), now);
    false
}

/// Raise an alert for `ev` when the config lists it (in a background thread). The handle lets a
/// short-lived process (the CLI) wait for delivery.
pub fn maybe_alert(dir: &Path, ev: &Event) -> Option<std::thread::JoinHandle<()>> {
    let cfg = super::config::get_in(dir);
    if !cfg.alerts.enabled || !cfg.alerts.events.iter().any(|e| e == ev.event) {
        return None;
    }
    if throttled(ev.event, ev.severity == Severity::Critical, cfg.alerts.min_interval_seconds, super::now()) {
        return None;
    }
    let alert = compose(ev, &super::device_id(dir));
    let dir = dir.to_path_buf();
    Some(std::thread::spawn(move || {
        report(&alert.event, &deliver_blocking(&dir, &cfg, &alert));
    }))
}

/// What one channel did with an alert.
#[derive(Debug, PartialEq)]
pub enum Delivery {
    Sent,
    /// Not configured (unpaired, no URL, no credentials): skipped without an error.
    Skipped(String),
    Failed(String),
}

/// Send now (blocking). Channels are tried in `alerts.channels` order until one takes the alert
/// (all configured ones with `fanOut`). Returns each channel tried and its outcome.
pub fn deliver_blocking(dir: &Path, cfg: &SecurityConfig, alert: &Alert) -> Vec<(String, Delivery)> {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return vec![("runtime".into(), Delivery::Failed(e.to_string()))],
    };
    let mut out = vec![];
    for ch in &cfg.alerts.channels {
        let r = match ch.as_str() {
            "companion" => rt.block_on(send_companion(dir, &cfg.companion.gateway_url, alert)),
            "webhook" => rt.block_on(send_webhook(dir, alert)),
            "twilio" => rt.block_on(send_twilio(dir, alert)),
            "email" => send_smtp(dir, alert),
            _ => continue,
        };
        let sent = r == Delivery::Sent;
        out.push((ch.clone(), r));
        if sent && !cfg.alerts.fan_out {
            break;
        }
    }
    out
}

/// One log line per alert: quiet when nothing is configured, loud only when a configured
/// channel failed and none delivered.
fn report(event: &str, results: &[(String, Delivery)]) {
    let sent: Vec<&str> = results.iter().filter(|(_, r)| *r == Delivery::Sent).map(|(c, _)| c.as_str()).collect();
    let failed: Vec<String> = results.iter().filter_map(|(c, r)| if let Delivery::Failed(e) = r { Some(format!("{c}: {e}")) } else { None }).collect();
    if !sent.is_empty() {
        eprintln!("[security] alert '{event}' sent via {}", sent.join(", "));
    } else if !failed.is_empty() {
        eprintln!("[security] alert '{event}' not delivered ({}); it is still in security_audit.jsonl", failed.join("; "));
    }
}

/// Queue the alert in the gateway's companion inbox, signed with the pairing key so the phone
/// can tell it really came from this desktop.
async fn send_companion(dir: &Path, gateway: &str, a: &Alert) -> Delivery {
    let Some(key) = super::companion::pair_key(dir) else { return Delivery::Skipped("no phone paired".into()) };
    let id = super::token::random_hex(12);
    let ts = super::now() as u64;
    let severity = severity_str(a.severity);
    let sig = super::token::alert_sign(&key, &id, ts, severity, &a.title, &a.body);
    let body = json!({ "id": id, "ts": ts, "event": a.event, "severity": severity, "title": a.title, "body": a.body, "device": super::device_id(dir), "sig": sig });
    let c = match client() {
        Ok(c) => c,
        Err(e) => return Delivery::Failed(e),
    };
    match c.post(format!("{}/api/security/companion/alert", gateway.trim_end_matches('/'))).json(&body).send().await {
        Ok(r) if r.status().is_success() => Delivery::Sent,
        Ok(r) => Delivery::Failed(format!("gateway answered {}", r.status())),
        Err(_) => Delivery::Failed("gateway unreachable".into()),
    }
}

pub fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::Critical => "critical",
        Severity::Warn => "warn",
        Severity::Info => "info",
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())
}

macro_rules! need {
    ($dir:expr, $name:expr) => {
        match secret($name, $dir) {
            Some(v) => v,
            None => return Delivery::Skipped(format!("{} is not set", $name)),
        }
    };
}

fn outcome(r: Result<(), String>) -> Delivery {
    match r {
        Ok(()) => Delivery::Sent,
        Err(e) => Delivery::Failed(e),
    }
}

async fn send_twilio(dir: &Path, a: &Alert) -> Delivery {
    let sid = need!(dir, "CC_TWILIO_ACCOUNT_SID");
    let token = need!(dir, "CC_TWILIO_AUTH_TOKEN");
    let from = need!(dir, "CC_TWILIO_FROM");
    let to = need!(dir, "CC_ALERT_SMS_TO");
    outcome(twilio(a, sid, token, from, to).await)
}

async fn twilio(a: &Alert, sid: String, token: String, from: String, to: String) -> Result<(), String> {
    if !sid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("CC_TWILIO_ACCOUNT_SID is not an account SID".into());
    }
    let r = client()?
        .post(format!("https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"))
        .basic_auth(&sid, Some(&token))
        .form(&[("To", to.as_str()), ("From", from.as_str()), ("Body", a.body.as_str())])
        .send()
        .await
        .map_err(|e| format!("twilio unreachable ({})", e.without_url()))?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!("twilio answered {}", r.status()))
    }
}

async fn send_webhook(dir: &Path, a: &Alert) -> Delivery {
    let url = need!(dir, "CC_ALERT_WEBHOOK_URL");
    outcome(webhook(dir, a, url).await)
}

async fn webhook(dir: &Path, a: &Alert, url: String) -> Result<(), String> {
    let body = serde_json::to_vec(&json!({
        "event": a.event, "title": a.title, "body": a.body,
        "severity": a.severity, "to": secret("CC_ALERT_SMS_TO", dir), "ts": super::now(),
    }))
    .map_err(|e| e.to_string())?;
    let mut req = client()?.post(&url).header("Content-Type", "application/json");
    if let Some(s) = secret("CC_ALERT_WEBHOOK_SECRET", dir) {
        let ts = format!("{}", super::now() as u64);
        req = req.header("X-CC-Timestamp", &ts).header("X-CC-Signature", super::token::webhook_signature(s.as_bytes(), &ts, &body));
    }
    let r = req.body(body).send().await.map_err(|e| format!("webhook unreachable ({})", e.without_url()))?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!("webhook answered {}", r.status()))
    }
}

fn send_smtp(dir: &Path, a: &Alert) -> Delivery {
    let host = need!(dir, "CC_SMTP_HOST");
    let to = need!(dir, "CC_ALERT_EMAIL_TO");
    outcome(smtp(dir, a, host, to))
}

fn smtp(dir: &Path, a: &Alert, host: String, to: String) -> Result<(), String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};
    let from = secret("CC_ALERT_EMAIL_FROM", dir).or_else(|| secret("CC_SMTP_USER", dir)).ok_or("CC_ALERT_EMAIL_FROM is not set")?;
    let port: u16 = secret("CC_SMTP_PORT", dir).and_then(|p| p.parse().ok()).unwrap_or(587);
    let msg = Message::builder()
        .from(from.parse().map_err(|_| "CC_ALERT_EMAIL_FROM is not an address")?)
        .to(to.parse().map_err(|_| "CC_ALERT_EMAIL_TO is not an address")?)
        .subject(a.title.clone())
        .body(a.body.clone())
        .map_err(|e| e.to_string())?;
    let builder = if port == 465 { SmtpTransport::relay(&host) } else { SmtpTransport::starttls_relay(&host) }.map_err(|e| e.to_string())?;
    let mut builder = builder.port(port).timeout(Some(Duration::from_secs(15)));
    if let (Some(u), Some(p)) = (secret("CC_SMTP_USER", dir), secret("CC_SMTP_PASS", dir)) {
        builder = builder.credentials(Credentials::new(u, p));
    }
    builder.build().send(&msg).map(|_| ()).map_err(|e| format!("smtp: {e}"))
}

#[cfg(test)]
mod tests {
    use super::super::audit::Outcome;
    use super::*;

    #[test]
    fn compose_never_includes_detail_secrets_and_throttles() {
        let ev = Event { event: "remote_kill", severity: Severity::Critical, outcome: Outcome::Success, module: Some("trading"), source: "webhook:100.64.0.7", detail: json!({"reason": "phone shortcut", "token": "SECRET-VALUE"}) };
        let a = compose(&ev, "DESK-1");
        assert!(a.title.contains("CRITICAL") && a.body.contains("REMOTE EMERGENCY KILL") && a.body.contains("[trading]") && a.body.contains("phone shortcut"));
        assert!(!a.body.contains("SECRET-VALUE"));
        assert!(a.body.chars().count() <= 300);
        assert!(!throttled("t-ev", false, 30.0, 100.0));
        assert!(throttled("t-ev", false, 30.0, 110.0));
        assert!(!throttled("t-ev", false, 30.0, 131.0));
        assert!(!throttled("t-ev", true, 30.0, 132.0), "critical is never throttled");
    }

    #[test]
    fn unconfigured_channels_are_skipped_not_failed() {
        let dir = std::env::temp_dir().join(format!("cc-alert-skip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = SecurityConfig::default();
        cfg.alerts.channels = vec!["webhook".into(), "twilio".into(), "email".into()];
        let a = Alert { event: "t".into(), title: "t".into(), body: "b".into(), severity: Severity::Info };
        if ["CC_ALERT_WEBHOOK_URL", "CC_TWILIO_ACCOUNT_SID", "CC_SMTP_HOST"].iter().any(|k| std::env::var(k).is_ok()) {
            return; // a real channel is configured in this shell: nothing to assert safely
        }
        let out = deliver_blocking(&dir, &cfg, &a);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|(_, r)| matches!(r, Delivery::Skipped(_))), "{out:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn companion_alerts_are_signed_with_the_pairing_key() {
        let k = b"0123456789abcdef0123456789abcdef";
        let sig = crate::security::token::alert_sign(k, "a1", 1700000000, "critical", "T", "B");
        assert!(crate::security::token::alert_verify(k, "a1", 1700000000, "critical", "T", "B", &sig));
        assert!(!crate::security::token::alert_verify(k, "a1", 1700000000, "critical", "T", "B (edited)", &sig));
        assert!(!crate::security::token::alert_verify(b"another-key-another-key-another!", "a1", 1700000000, "critical", "T", "B", &sig));
    }
}
