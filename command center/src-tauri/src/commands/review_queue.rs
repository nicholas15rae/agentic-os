//! Human-in-the-loop review queue: one calm digest instead of per-file popups.
//!
//! - Items are quarantine entries (`quarantine.rs`): Garbage sweeps, Security's blocked writes
//!   and explicit flags. The panel groups them by business and then by reason, and offers
//!   **Approve Purge** (`approved: true`, the only hard delete), **Reject & Restore** and
//!   **Inspect**, per item or per batch.
//! - **Digest**: a background pass (every 5 min) runs Garbage's sweep of each active business,
//!   then emits ONE `review-digest` event when pending items reach `review.threshold`
//!   (re-armed once the count drops back below it) or at `review.digestHour` once a day while
//!   anything is waiting. The UI shows a badge, never a popup.
//! - **Webhook** (off by default): the same digest as COUNTS ONLY, posted from Rust to a URL kept
//!   in its own keychain service. It never includes names, paths, amounts, reasons in free text
//!   or contents ([`webhook_payload`]).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use super::os_core::ReviewConfig;
use super::quarantine::{QItem, QStatus};

pub const WEBHOOK_SERVICE: &str = "agentic-os-review-webhook";
const WEBHOOK_ACCOUNT: &str = "digest-url";
pub const TICK: Duration = Duration::from_secs(300);

// ── Digest decision (pure) ──────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DigestState {
    /// `YYYY-MM-DD` of the last daily digest.
    pub last_day: String,
    /// The threshold digest already fired for the current run of pending items.
    pub threshold_fired: bool,
    pub last_sent_at: u64,
}

/// `Some("threshold" | "daily")` when a digest is due; updates `st`. Pure.
pub fn digest_due(pending: usize, cfg: &ReviewConfig, st: &mut DigestState, today: &str, hour: u32) -> Option<&'static str> {
    let threshold = cfg.threshold.max(1) as usize;
    if pending < threshold {
        st.threshold_fired = false;
    }
    if pending == 0 {
        return None;
    }
    if pending >= threshold && !st.threshold_fired {
        st.threshold_fired = true;
        return Some("threshold");
    }
    if hour >= cfg.digest_hour.min(23) && st.last_day != today {
        st.last_day = today.to_string();
        return Some("daily");
    }
    None
}

// ── Webhook ─────────────────────────────────────────────────────────────────

/// The external digest: counts and business ids only.
pub fn webhook_payload(pending: &[QItem], trigger: &str, now_ms: u64) -> Value {
    let mut by_business: BTreeMap<String, usize> = BTreeMap::new();
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    for q in pending {
        *by_business.entry(q.business_id.clone()).or_default() += 1;
        let code = match q.reason_code.as_str() {
            c @ ("cross_domain" | "empty_file" | "temp_leftover" | "flagged") => c,
            _ => "other",
        };
        *reasons.entry(code.to_string()).or_default() += 1;
    }
    let oldest_hours = pending.iter().map(|q| q.timestamp).min().map(|t| now_ms.saturating_sub(t) / 3_600_000).unwrap_or(0);
    json!({
        "source": "agentic-os",
        "kind": "review-digest",
        "trigger": trigger,
        "pending": pending.len(),
        "byBusiness": by_business,
        "reasons": reasons,
        "oldestHours": oldest_hours,
        "summary": format!("{} item(s) waiting for review in Agentic OS", pending.len()),
    })
}

/// http(s), a host, no whitespace or control characters, a sane length.
pub fn validate_webhook_url(u: &str) -> Result<String, String> {
    let u = u.trim();
    if u.is_empty() || u.len() > 1000 || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("webhook URL: one http(s) URL".into());
    }
    let parsed = reqwest::Url::parse(u).map_err(|e| format!("webhook URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().map_or(true, str::is_empty) {
        return Err("webhook URL: must be http(s) with a host".into());
    }
    Ok(u.to_string())
}

fn webhook_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(WEBHOOK_SERVICE, WEBHOOK_ACCOUNT).map_err(|e| e.to_string())
}

fn webhook_url() -> Option<String> {
    webhook_entry().ok()?.get_password().ok()
}

pub async fn post_webhook(http: &reqwest::Client, url: &str, payload: &Value) -> Result<(), String> {
    let url = validate_webhook_url(url)?;
    let r = http.post(url).timeout(Duration::from_secs(10)).json(payload).send().await.map_err(|e| format!("webhook: {}", super::dispatch::short(e)))?;
    if !r.status().is_success() {
        return Err(format!("webhook: HTTP {}", r.status().as_u16()));
    }
    Ok(())
}

// ── Queue views ─────────────────────────────────────────────────────────────

fn display_names() -> BTreeMap<String, String> {
    super::business_registry::store().map(|s| s.snapshot().businesses.into_iter().map(|b| (b.business_id, b.display_name)).collect()).unwrap_or_default()
}

/// Pending items grouped by business, then by reason code.
pub fn grouped(pending: &[QItem], names: &BTreeMap<String, String>) -> Value {
    let mut by: BTreeMap<&str, BTreeMap<&str, Vec<&QItem>>> = BTreeMap::new();
    for q in pending {
        by.entry(q.business_id.as_str()).or_default().entry(q.reason_code.as_str()).or_default().push(q);
    }
    Value::Array(
        by.into_iter()
            .map(|(b, reasons)| {
                json!({
                    "businessId": b,
                    "displayName": names.get(b).cloned().unwrap_or_else(|| b.to_string()),
                    "count": reasons.values().map(Vec::len).sum::<usize>(),
                    "reasons": reasons.into_iter().map(|(code, items)| json!({ "reasonCode": code, "items": items })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

// ── Daemon ──────────────────────────────────────────────────────────────────

fn digest_state() -> &'static Mutex<DigestState> {
    static S: std::sync::OnceLock<Mutex<DigestState>> = std::sync::OnceLock::new();
    S.get_or_init(|| Mutex::new(DigestState::default()))
}

fn state_path() -> Option<std::path::PathBuf> {
    super::quarantine::global().ok().map(|q| q.root().join("digest-state.json"))
}

fn load_state() {
    if let Some(p) = state_path() {
        if let Ok(b) = std::fs::read(&p) {
            if let Ok(s) = serde_json::from_slice::<DigestState>(&b) {
                *digest_state().lock().unwrap() = s;
            }
        }
    }
}

fn save_state(s: &DigestState) {
    if let Some(p) = state_path() {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = super::staging::atomic_write(&p, &serde_json::to_vec(s).unwrap_or_default());
    }
}

/// One pass: Garbage sweep of every active business (integrity-gated), then the digest.
pub async fn pass(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let (Ok(store), Ok(q)) = (super::business_registry::store(), super::quarantine::global()) else { return };
    if super::integrity::ensure().is_ok() {
        let now = super::arbiter::now_ms();
        for b in store.snapshot().businesses.iter().filter(|b| b.status == super::business_registry::BusinessStatus::Active) {
            if let Ok(scope) = store.scope(&b.business_id) {
                if let Err(e) = q.sweep(&scope, now) {
                    eprintln!("[garbage] sweep {}: {e}", b.business_id);
                }
            }
        }
    }
    let pending = q.pending();
    let cfg = app.state::<super::os_core::OsState>().snapshot().review;
    let local = chrono::Local::now();
    let trigger = {
        let mut st = digest_state().lock().unwrap();
        let t = digest_due(pending.len(), &cfg, &mut st, &local.format("%Y-%m-%d").to_string(), chrono::Timelike::hour(&local));
        if t.is_some() {
            st.last_sent_at = super::arbiter::now_ms();
        }
        save_state(&st);
        t
    };
    let Some(trigger) = trigger else { return };
    let names = display_names();
    let _ = app.emit("review-digest", json!({ "trigger": trigger, "pending": pending.len(), "groups": grouped(&pending, &names) }));
    super::events::publish_note("garbage", "review_digest", "milestone", &format!("{} item(s) are waiting in the Review Queue", pending.len()), None);
    if cfg.webhook_enabled {
        if let Some(url) = webhook_url() {
            let http = app.state::<super::dispatch::DispatchState>().http.clone();
            let payload = webhook_payload(&pending, trigger, super::arbiter::now_ms());
            let res = post_webhook(&http, &url, &payload).await;
            let _ = super::ops_audit::append("review", "webhook_digest", "", "", &match &res {
                Ok(()) => format!("sent ({} pending, {trigger})", pending.len()),
                Err(e) => format!("failed: {e}"),
            });
        }
    }
}

/// lib.rs boot: a pass every `TICK` (the first after a short grace).
pub async fn daemon(app: tauri::AppHandle) {
    load_state();
    tokio::time::sleep(Duration::from_secs(60)).await;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        pass(&app).await;
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn review_list() -> Result<Value, String> {
    let q = super::quarantine::global()?;
    let all = q.list();
    let pending: Vec<QItem> = all.iter().filter(|i| i.status == QStatus::Pending).cloned().collect();
    let resolved: Vec<&QItem> = all.iter().filter(|i| i.status != QStatus::Pending).take(20).collect();
    Ok(json!({ "pending": pending.len(), "groups": grouped(&pending, &display_names()), "recentlyResolved": resolved, "integrity": super::integrity::tripped() }))
}

#[tauri::command]
pub fn review_inspect(item_id: String) -> Result<Value, String> {
    let q = super::quarantine::global()?;
    let item = q.get(&item_id)?;
    Ok(json!({ "item": item, "preview": q.preview(&item) }))
}

/// Approve Purge for one or more items. Without `approved: true` nothing is deleted.
#[tauri::command]
pub fn review_approve(item_ids: Vec<String>, approved: Option<bool>) -> Result<Value, String> {
    if approved != Some(true) {
        return Err("PERMISSION_REQUIRED:purge".into());
    }
    let q = super::quarantine::global()?;
    let results: Vec<Value> = item_ids.iter().take(500).map(|id| match q.purge(id, true) {
        Ok(i) => json!({ "itemId": id, "ok": true, "status": i.status }),
        Err(e) => json!({ "itemId": id, "ok": false, "error": e }),
    }).collect();
    Ok(json!({ "results": results }))
}

/// Reject & Restore for one or more items.
#[tauri::command]
pub fn review_reject(item_ids: Vec<String>) -> Result<Value, String> {
    let q = super::quarantine::global()?;
    let store = super::business_registry::store()?;
    let results: Vec<Value> = item_ids.iter().take(500).map(|id| match q.restore(id, store) {
        Ok(i) => json!({ "itemId": id, "ok": true, "status": i.status }),
        Err(e) => json!({ "itemId": id, "ok": false, "error": e }),
    }).collect();
    Ok(json!({ "results": results }))
}

#[tauri::command]
pub fn review_settings(os: tauri::State<'_, super::os_core::OsState>) -> Value {
    let url = webhook_url();
    json!({ "config": os.snapshot().review, "webhookConfigured": url.is_some(), "webhookHost": url.as_deref().and_then(super::secrets::url_host) })
}

#[tauri::command]
pub fn review_config_set(config: ReviewConfig, os: tauri::State<'_, super::os_core::OsState>) -> Result<Value, String> {
    if config.digest_hour > 23 || !(1..=1000).contains(&config.threshold) {
        return Err("digestHour 0–23, threshold 1–1000".into());
    }
    if config.webhook_enabled && webhook_url().is_none() {
        return Err("set a webhook URL first".into());
    }
    os.update(|c| {
        c.review = config.clone();
        Ok(())
    })?;
    Ok(json!({ "config": config }))
}

#[tauri::command]
pub fn review_webhook_set(url: String) -> Result<Value, String> {
    let u = validate_webhook_url(&url)?;
    webhook_entry()?.set_password(&u).map_err(|e| format!("keychain: {e}"))?;
    let _ = super::ops_audit::append("user", "webhook_set", "", "", &super::secrets::url_host(&u).unwrap_or_default());
    Ok(json!({ "webhookConfigured": true, "webhookHost": super::secrets::url_host(&u) }))
}

#[tauri::command]
pub fn review_webhook_clear(os: tauri::State<'_, super::os_core::OsState>) -> Result<Value, String> {
    if let Ok(e) = webhook_entry() {
        let _ = e.delete_credential();
    }
    os.update(|c| {
        c.review.webhook_enabled = false;
        Ok(())
    })?;
    let _ = super::ops_audit::append("user", "webhook_clear", "", "", "");
    Ok(json!({ "webhookConfigured": false }))
}

/// Send a test digest (counts only) to the configured webhook now.
#[tauri::command]
pub async fn review_webhook_test(state: tauri::State<'_, super::dispatch::DispatchState>) -> Result<Value, String> {
    let url = webhook_url().ok_or("set a webhook URL first")?;
    let pending = super::quarantine::global().map(|q| q.pending()).unwrap_or_default();
    post_webhook(&state.http, &url, &webhook_payload(&pending, "test", super::arbiter::now_ms())).await?;
    Ok(json!({ "sent": true, "pending": pending.len() }))
}

#[cfg(test)]
mod tests {
    use super::super::business_registry::tests::active_store;
    use super::super::quarantine::tests::q_in;
    use super::*;

    #[test]
    fn the_digest_is_batched_never_per_item() {
        let cfg = ReviewConfig { digest_hour: 18, threshold: 3, webhook_enabled: false };
        let mut st = DigestState::default();
        // Below the threshold, before the hour: quiet.
        assert_eq!(digest_due(1, &cfg, &mut st, "2026-11-22", 9), None);
        assert_eq!(digest_due(2, &cfg, &mut st, "2026-11-22", 9), None);
        // Crossing it fires once, not again for every new item.
        assert_eq!(digest_due(3, &cfg, &mut st, "2026-11-22", 9), Some("threshold"));
        assert_eq!(digest_due(7, &cfg, &mut st, "2026-11-22", 10), None);
        // Daily at the hour, once per day.
        assert_eq!(digest_due(7, &cfg, &mut st, "2026-11-22", 18), Some("daily"));
        assert_eq!(digest_due(7, &cfg, &mut st, "2026-11-22", 21), None);
        // Cleared below the threshold re-arms it.
        assert_eq!(digest_due(0, &cfg, &mut st, "2026-11-22", 22), None);
        assert_eq!(digest_due(3, &cfg, &mut st, "2026-11-22", 22), Some("threshold"));
        // Nothing pending: never a digest.
        let mut fresh = DigestState::default();
        assert_eq!(digest_due(0, &cfg, &mut fresh, "2026-11-23", 23), None);
    }

    #[test]
    fn the_webhook_payload_carries_counts_only() {
        let (s, dir) = active_store("webhook");
        let reg = s.snapshot();
        let q = q_in(&dir);
        let t = s.scope("trades_contracting").unwrap();
        t.write_note(&reg, "clients/henderson-invoice-4411.md", "Henderson owes $18,250.00 for the Elm St job").unwrap();
        q.stage_note(&t, "clients/henderson-invoice-4411.md", "user", "flagged", "Henderson dispute, $18,250").unwrap();
        let e = s.scope("supplements_ecom").unwrap();
        let text = "masonry pallets";
        q.stage_blocked_write(&e, "notes/x.md", text, "security", &super::super::ops_scope::cross_domain_hits(&e, &reg, text)).unwrap();
        let p = webhook_payload(&q.pending(), "daily", super::super::arbiter::now_ms());
        assert_eq!(p["pending"], 2);
        assert_eq!(p["byBusiness"]["trades_contracting"], 1);
        assert_eq!(p["reasons"]["cross_domain"], 1);
        let wire = p.to_string();
        for leak in ["Henderson", "18,250", "18250", "Elm", "clients/", "invoice-4411", "masonry", "pallets", "notes/x.md", "sha", "backup", "dispute"] {
            assert!(!wire.contains(leak), "{leak} leaked: {wire}");
        }
        // The grouped in-app view does carry the detail the user needs.
        let g = grouped(&q.pending(), &BTreeMap::new());
        assert_eq!(g.as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webhook_urls_are_validated() {
        for ok in ["https://hooks.example.com/abc", "http://127.0.0.1:3000/whatsapp/digest"] {
            assert!(validate_webhook_url(ok).is_ok(), "{ok}");
        }
        for bad in ["", "ftp://x", "file:///C:/x", "javascript:alert(1)", "https://", "https://a b.com", "notaurl"] {
            assert!(validate_webhook_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn post_webhook_sends_the_payload() {
        tauri::async_runtime::block_on(async {
            use super::super::allm::mock::{start, Resp};
            let srv = start(|_| Resp::json(json!({ "ok": true }))).await;
            let p = json!({ "pending": 1 });
            post_webhook(&reqwest::Client::new(), &format!("{}/hook", srv.base), &p).await.unwrap();
            let r = &srv.reqs()[0];
            assert_eq!((r.method.as_str(), r.path.as_str(), &r.body), ("POST", "/hook", &p));
        });
    }
}
