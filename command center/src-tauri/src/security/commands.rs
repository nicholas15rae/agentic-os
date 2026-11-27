//! Runtime state + the `security_*` Tauri commands (the only commands the IPC gate always lets
//! through, so each one checks its own preconditions).
//!
//! The webview gets status, unlock / step-up results and short-lived elevation tokens. It never
//! gets a PIN hash, a key, or a way to set the PIN (that's `gabagool-cli set-pin`).

use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::audit::{self, Outcome, Severity};
use super::session::{BioOutcome, Factor, LockReason, Policy, Refusal, SessionView, Sessions};
use super::{companion, config, pin, shared, token};

/// Emitted with a `Status` whenever the lock state, an elevation or the hard lock changes.
pub const STATE_EVENT: &str = "security-state";

pub struct Runtime {
    pub sessions: Mutex<Sessions>,
    app: OnceLock<AppHandle>,
    hard: AtomicBool,
    epoch: AtomicU64,
    /// Held across our own epoch bumps so the watcher never mistakes one for a revocation.
    epoch_guard: Mutex<()>,
    bio_cache: Mutex<(f64, bool)>,
}

static RT: OnceLock<Runtime> = OnceLock::new();

pub fn rt() -> &'static Runtime {
    RT.get_or_init(|| Runtime { sessions: Mutex::new(Sessions::default()), app: OnceLock::new(), hard: AtomicBool::new(false), epoch: AtomicU64::new(0), epoch_guard: Mutex::new(()), bio_cache: Mutex::new((0.0, false)) })
}

impl Runtime {
    pub fn is_hard(&self) -> bool {
        self.hard.load(Ordering::SeqCst)
    }
    fn sessions(&self) -> std::sync::MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// True while the remote failsafe holds the app (background workers check this).
pub fn hard_locked() -> bool {
    RT.get().is_some_and(|r| r.is_hard())
}

fn policy() -> Policy {
    Policy::from_config(&config::get())
}

fn bump_epoch() {
    let r = rt();
    let _g = r.epoch_guard.lock().unwrap_or_else(|p| p.into_inner());
    match shared::bump_epoch(&super::dir()) {
        Ok(e) => r.epoch.store(e, Ordering::SeqCst),
        Err(e) => eprintln!("[security] epoch bump failed: {e}"),
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModuleView {
    pub module: String,
    pub read_only_by_default: bool,
    pub elevated_until: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub hard_locked: bool,
    pub hard_lock_reason: Option<String>,
    pub pin_set: bool,
    pub pin_min_length: usize,
    pub biometric_available: bool,
    pub companion_enabled: bool,
    pub companion_paired: bool,
    /// This device holds a companion signing key (it's someone's companion phone).
    pub companion_device: bool,
    pub platform: &'static str,
    pub device_id: String,
    pub session: SessionView,
    pub modules: Vec<ModuleView>,
    pub idle_lock_minutes: f64,
    pub reauth_minutes: f64,
    pub elevation_idle_minutes: f64,
    pub elevation_max_minutes: f64,
    pub now: f64,
}

fn bio_available(app: &AppHandle) -> bool {
    if !config::get().biometric.enabled {
        return false;
    }
    let r = rt();
    let now = super::now();
    {
        let c = r.bio_cache.lock().unwrap_or_else(|p| p.into_inner());
        if now - c.0 < 60.0 {
            return c.1;
        }
    }
    let v = super::biometric::available(app);
    *r.bio_cache.lock().unwrap_or_else(|p| p.into_inner()) = (now, v);
    v
}

pub fn status(app: &AppHandle) -> Status {
    let dir = super::dir();
    let cfg = config::get();
    let p = Policy::from_config(&cfg);
    let now = super::now();
    let r = rt();
    let session = {
        let mut s = r.sessions();
        s.tick(&p, now);
        s.view(&p, now)
    };
    let st = shared::read(&dir);
    let modules = cfg
        .modules
        .iter()
        .map(|(m, pol)| ModuleView { module: m.clone(), read_only_by_default: pol.read_only_by_default, elevated_until: session.elevations.iter().find(|e| &e.module == m).map(|e| e.expires_at) })
        .collect();
    Status {
        enabled: cfg.enabled,
        hard_locked: r.is_hard(),
        hard_lock_reason: st.hard_lock_reason,
        pin_set: pin::is_set(&dir),
        pin_min_length: cfg.pin.min_length,
        biometric_available: bio_available(app),
        companion_enabled: cfg.companion.enabled,
        companion_paired: companion::pair_key(&dir).is_some(),
        companion_device: companion::device_key(&dir).is_some(),
        platform: platform(),
        device_id: super::device_id(&dir),
        session,
        modules,
        idle_lock_minutes: cfg.session.idle_lock_minutes,
        reauth_minutes: cfg.session.reauth_minutes,
        elevation_idle_minutes: cfg.elevation.idle_minutes,
        elevation_max_minutes: cfg.elevation.max_minutes,
        now,
    }
}

fn emit(app: &AppHandle) {
    let _ = app.emit(STATE_EVENT, status(app));
}

fn emit_global() {
    if let Some(app) = rt().app.get() {
        emit(app);
    }
}

/// A session just auto-locked (idle / hourly): revoke tokens, audit, tell the webview.
pub fn after_auto_lock(reason: LockReason) {
    bump_epoch();
    let event = match reason {
        LockReason::Idle => "inactivity_lock",
        LockReason::Reauth => "reverify_required",
        _ => "session_locked",
    };
    audit::log(event, Severity::Info, Outcome::Info, None, "desktop", json!({ "reason": reason.as_str() }));
    emit_global();
}

fn engage_privacy_lockdown(app: &AppHandle) -> Result<(), String> {
    let os = app.state::<crate::commands::os_core::OsState>();
    os.update(|c| {
        c.privacy.kill_switch = true;
        Ok(())
    })
    .map(|_| ())
}

/// Startup: resolve the dir, load the config, sync the shared state and start the watcher.
pub fn install(app: &AppHandle, repo: Option<PathBuf>, config_dir: &Path) {
    super::set_dir(super::resolve_dir(repo.as_deref(), Some(config_dir)));
    let dir = super::dir();
    let r = rt();
    let _ = r.app.set(app.clone());
    let cfg = config::get();
    if let Err(e) = shared::elevation_key(&dir) {
        eprintln!("[security] elevation key: {e}");
    }
    let st = shared::read(&dir);
    r.epoch.store(st.epoch, Ordering::SeqCst);
    if st.hard_locked {
        r.hard.store(true, Ordering::SeqCst);
        r.sessions().hard_lock();
        let _ = engage_privacy_lockdown(app);
    }
    audit::log(
        "app_start",
        if cfg.enabled { Severity::Info } else { Severity::Warn },
        Outcome::Info,
        None,
        "desktop",
        json!({ "enabled": cfg.enabled, "pinSet": pin::is_set(&dir), "hardLocked": st.hard_locked, "dir": dir.display().to_string() }),
    );
    if !cfg.enabled {
        eprintln!("[security] WARNING: security.config.json has enabled=false; the app lock is OFF");
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("security-watch".into())
        .spawn(move || watch_loop(app))
        .ok();
}

fn watch_loop(app: AppHandle) {
    let r = rt();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let dir = super::dir();
        let st = shared::read(&dir);
        // Remote failsafe (CLI / webhook) engaged or released.
        if st.hard_locked && !r.is_hard() {
            r.hard.store(true, Ordering::SeqCst);
            r.sessions().hard_lock();
            if let Err(e) = engage_privacy_lockdown(&app) {
                eprintln!("[security] privacy lockdown: {e}");
            }
            audit::log("hard_lock", Severity::Critical, Outcome::Success, None, st.hard_lock_source.as_deref().unwrap_or("external"), json!({ "reason": st.hard_lock_reason }));
            emit(&app);
        } else if !st.hard_locked && r.is_hard() {
            r.hard.store(false, Ordering::SeqCst);
            r.sessions().release_hard_lock();
            emit(&app);
        }
        // Someone else bumped the epoch (another process locked / revoked): lock here too.
        {
            let _g = r.epoch_guard.lock().unwrap_or_else(|p| p.into_inner());
            if st.epoch != r.epoch.load(Ordering::SeqCst) {
                r.epoch.store(st.epoch, Ordering::SeqCst);
                let locked = r.sessions().lock(LockReason::Revoked);
                drop(_g);
                if locked {
                    audit::log("session_revoked", Severity::Warn, Outcome::Info, None, "external", json!({ "epoch": st.epoch }));
                    emit(&app);
                }
            }
        }
        // Idle / hourly auto-lock and elevation expiry.
        let p = policy();
        let (locked, expired) = {
            let mut s = r.sessions();
            let locked = s.tick(&p, super::now());
            (locked, s.take_expired())
        };
        for m in &expired {
            audit::log("elevation_expired", Severity::Info, Outcome::Info, Some(m), "desktop", json!({ "mode": "read-only" }));
        }
        if let Some(reason) = locked {
            after_auto_lock(reason);
        } else if !expired.is_empty() {
            emit(&app);
        }
    }
}

fn refusal_audit(e: &Refusal, module: Option<&str>, what: &str) {
    match e {
        Refusal::BadPin { remaining } => audit::log(&format!("{what}_failure"), Severity::Warn, Outcome::Failure, module, "desktop-ui", json!({ "factor": "pin", "remaining": remaining })),
        Refusal::LockedOut { until } => audit::log("pin_lockout", Severity::Critical, Outcome::Failure, module, "desktop-ui", json!({ "until": until })),
        _ => {}
    }
}

fn hard_err() -> String {
    Refusal::HardLocked.message()
}

/// Lockout check before any Argon2 work.
fn precheck() -> Result<(), String> {
    let r = rt();
    if r.is_hard() {
        return Err(hard_err());
    }
    r.sessions().check_lockout(super::now()).map_err(|e| e.message())
}

async fn pin_ok(pin_text: String) -> Result<bool, String> {
    let dir = super::dir();
    if !pin::is_set(&dir) {
        return Err("PIN_NOT_SET: set one first with `gabagool-cli set-pin`".into());
    }
    // Argon2id (64 MiB) off the async runtime threads.
    tauri::async_runtime::spawn_blocking(move || pin::check(&dir, &pin_text)).await.map_err(|e| e.to_string())
}

async fn second_available(app: &AppHandle) -> bool {
    let cfg = config::get();
    bio_available(app) || companion::reachable(&cfg.companion.gateway_url, &super::dir(), cfg.companion.enabled).await
}

#[tauri::command]
pub fn security_status(app: AppHandle) -> Status {
    status(&app)
}

/// User input happened (the webview throttles this). Never revives a locked session.
#[tauri::command]
pub fn security_touch() {
    let p = policy();
    let now = super::now();
    let locked = {
        let mut s = rt().sessions();
        let l = s.tick(&p, now);
        s.touch(now);
        l
    };
    if let Some(reason) = locked {
        after_auto_lock(reason);
    }
}

#[tauri::command]
pub async fn security_unlock_pin(app: AppHandle, pin: String) -> Result<Status, String> {
    precheck()?;
    let ok = pin_ok(pin).await?;
    let p = policy();
    let needs_second = rt().sessions().view(&p, super::now()).needs_second_factor;
    let avail = if ok && needs_second { second_available(&app).await } else { true };
    let reason = rt().sessions().reason();
    let res = rt().sessions().unlock_pin(ok, avail, &p, super::now(), token::random_hex(12));
    match res {
        Ok(u) => {
            let event = if u.resumed { "reverify_success" } else { "login_success" };
            let factors: Vec<&str> = std::iter::once("pin").chain(u.second.map(|f| if f == Factor::Biometric { "biometric" } else { "companion" })).collect();
            audit::log(event, Severity::Info, Outcome::Success, None, "desktop-ui", json!({ "factors": factors, "after": reason.map(|r| r.as_str()) }));
            if u.fallback {
                audit::log("second_factor_fallback", Severity::Warn, Outcome::Success, None, "desktop-ui", json!({ "reason": "no biometric or companion reachable; PIN-only resume" }));
            }
            emit(&app);
            Ok(status(&app))
        }
        Err(e) => {
            refusal_audit(&e, None, "login");
            emit(&app);
            Err(e.message())
        }
    }
}

#[tauri::command]
pub async fn security_biometric(app: AppHandle) -> Result<Status, String> {
    precheck()?;
    if !config::get().biometric.enabled {
        return Err("BIOMETRIC_UNAVAILABLE: biometrics are off in security.config.json".into());
    }
    if rt().sessions().is_live() {
        return Err(Refusal::NotLocked.message());
    }
    if let Err(e) = super::biometric::verify(&app, "Unlock the Command Center").await {
        if !e.starts_with("BIOMETRIC_CANCELLED") && !e.starts_with("BIOMETRIC_UNAVAILABLE") {
            audit::log("login_failure", Severity::Warn, Outcome::Failure, None, "desktop-ui", json!({ "factor": "biometric", "error": e }));
        }
        return Err(e);
    }
    let reason = rt().sessions().reason();
    let res = rt().sessions().second_factor(Factor::Biometric, &policy(), super::now(), token::random_hex(12));
    match res {
        Ok(BioOutcome::Unlocked) => audit::log("login_success", Severity::Info, Outcome::Success, None, "desktop-ui", json!({ "factors": ["biometric"], "after": reason.map(|r| r.as_str()) })),
        Ok(BioOutcome::SecondNoted) => audit::log("second_factor_ok", Severity::Info, Outcome::Success, None, "desktop-ui", json!({ "factor": "biometric" })),
        Err(e) => return Err(e.message()),
    }
    emit(&app);
    Ok(status(&app))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionTicket {
    pub id: String,
    pub expires_at: f64,
}

/// Ask the paired phone to approve: an unlock (locked app, `module` absent) or a step-up for a
/// protected `module` (live session, `elevation.allowCompanion`).
#[tauri::command]
pub async fn security_companion_request(app: AppHandle, module: Option<String>) -> Result<CompanionTicket, String> {
    precheck()?;
    let cfg = config::get();
    if !cfg.companion.enabled {
        return Err("COMPANION_DISABLED: companion approval is off in security.config.json".into());
    }
    let purpose = match &module {
        Some(m) => {
            known_module(m)?;
            if !cfg.elevation.allow_companion {
                return Err("COMPANION_DISABLED: phone step-up is off (elevation.allowCompanion)".into());
            }
            if !rt().sessions().is_live() {
                return Err(Refusal::NoSession.message());
            }
            format!("step_up:{m}")
        }
        None => {
            if rt().sessions().is_live() {
                return Err(Refusal::NotLocked.message());
            }
            rt().sessions().reason().map(|r| r.as_str()).unwrap_or("unlock").to_string()
        }
    };
    let dir = super::dir();
    let (id, expires_at) = companion::request(&cfg.companion.gateway_url, &dir, &super::device_id(&dir), &purpose, cfg.companion.approval_timeout_seconds).await?;
    audit::log("companion_requested", Severity::Info, Outcome::Info, module.as_deref(), "desktop-ui", json!({ "id": id, "purpose": purpose }));
    let _ = app;
    Ok(CompanionTicket { id, expires_at })
}

#[tauri::command]
pub async fn security_companion_poll(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    if rt().is_hard() {
        return Err(hard_err());
    }
    let cfg = config::get();
    match companion::poll(&cfg.companion.gateway_url, &super::dir(), &id).await {
        Ok(companion::PollState::Approved { device, purpose }) => {
            if let Some(module) = purpose.strip_prefix("step_up:") {
                let exp = rt().sessions().elevate_companion(module, &policy(), super::now()).map_err(|e| e.message())?;
                audit::log("step_up_unlock", Severity::Info, Outcome::Success, Some(module), "companion", json!({ "mode": "unlocked", "factor": "companion", "companion": device, "expiresAt": exp }));
                emit(&app);
                let g = grant(module, exp)?;
                return Ok(json!({ "state": "approved", "grant": g }));
            }
            let res = rt().sessions().second_factor(Factor::Companion, &policy(), super::now(), token::random_hex(12));
            res.map_err(|e| e.message())?;
            audit::log("second_factor_ok", Severity::Info, Outcome::Success, None, "desktop-ui", json!({ "factor": "companion", "companion": device }));
            emit(&app);
            Ok(json!({ "state": "approved" }))
        }
        Ok(companion::PollState::Denied) => {
            audit::log("login_failure", Severity::Warn, Outcome::Failure, None, "desktop-ui", json!({ "factor": "companion", "error": "denied on the phone" }));
            Ok(json!({ "state": "denied" }))
        }
        Ok(companion::PollState::Expired) => Ok(json!({ "state": "expired" })),
        Ok(companion::PollState::Pending) => Ok(json!({ "state": "pending" })),
        Err(e) => {
            if e.starts_with("COMPANION_BAD_SIGNATURE") {
                audit::log("login_failure", Severity::Critical, Outcome::Failure, None, "desktop-ui", json!({ "factor": "companion", "error": "forged approval signature" }));
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub fn security_lock(app: AppHandle) -> Status {
    if rt().sessions().lock(LockReason::Manual) {
        bump_epoch();
        audit::log("manual_lock", Severity::Info, Outcome::Info, None, "desktop-ui", json!({}));
        emit(&app);
    }
    status(&app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationGrant {
    pub module: String,
    /// For the gateway's `X-CC-Elevation` header (HMAC, bound to module + epoch).
    pub token: String,
    pub expires_at: f64,
}

fn grant(module: &str, expires_at: f64) -> Result<ElevationGrant, String> {
    let r = rt();
    let key = shared::elevation_key(&super::dir()).map_err(|e| e.to_string())?;
    let sid = r.sessions().session_id().unwrap_or("").to_string();
    let claims = token::Claims { m: module.into(), sid, exp: expires_at.floor() as u64, ep: r.epoch.load(Ordering::SeqCst) };
    Ok(ElevationGrant { module: module.into(), token: token::mint(&key, &claims), expires_at })
}

fn known_module(module: &str) -> Result<(), String> {
    if config::get().modules.contains_key(module) {
        Ok(())
    } else {
        Err(format!("unknown protected module: {module}"))
    }
}

/// Step-up: the PIN unlocks `module` (Read-Only → unlocked) for a short window.
#[tauri::command]
pub async fn security_elevate(app: AppHandle, module: String, pin: String) -> Result<ElevationGrant, String> {
    known_module(&module)?;
    precheck()?;
    if !rt().sessions().is_live() {
        return Err(Refusal::NoSession.message());
    }
    let ok = pin_ok(pin).await?;
    let res = rt().sessions().elevate(&module, ok, &policy(), super::now());
    match res {
        Ok(exp) => {
            audit::log("step_up_unlock", Severity::Info, Outcome::Success, Some(&module), "desktop-ui", json!({ "mode": "unlocked", "expiresAt": exp }));
            emit(&app);
            grant(&module, exp)
        }
        Err(e) => {
            refusal_audit(&e, Some(&module), "step_up");
            if matches!(e, Refusal::LockedOut { .. }) {
                // A PIN lockout during step-up also locks the session.
                if rt().sessions().lock(LockReason::Manual) {
                    bump_epoch();
                }
            }
            emit(&app);
            Err(e.message())
        }
    }
}

/// A fresh gateway token for a live elevation (refreshes its idle timer).
#[tauri::command]
pub fn security_elevation_token(module: String) -> Result<ElevationGrant, String> {
    known_module(&module)?;
    if rt().is_hard() {
        return Err(hard_err());
    }
    let p = policy();
    let exp = {
        let mut s = rt().sessions();
        s.tick(&p, super::now());
        if !s.is_live() {
            return Err(Refusal::NoSession.message());
        }
        s.use_elevation(&module, &p, super::now())
    };
    match exp {
        Some(exp) => grant(&module, exp),
        None => Err(format!("STEP_UP_REQUIRED:{module}: {module} is read-only; confirm with your PIN to make changes")),
    }
}

/// Back to Read-Only now.
#[tauri::command]
pub fn security_drop_elevation(app: AppHandle, module: String) -> Status {
    if rt().sessions().drop_elevation(&module) {
        bump_epoch();
        audit::log("step_down", Severity::Info, Outcome::Info, Some(&module), "desktop-ui", json!({ "mode": "read-only" }));
        emit(&app);
    }
    status(&app)
}

/// The front-page kill switch (after its 3-click ARM → CONFIRM → EXECUTE sequence): engage the
/// outbound privacy lockdown. The safe direction: allowed even while locked. Turning it OFF is
/// an ordinary `os_config_update`, which needs a settings step-up.
#[tauri::command]
pub fn security_lockdown_engage(app: AppHandle, source: Option<String>) -> Result<crate::commands::os_core::OsConfig, String> {
    let os = app.state::<crate::commands::os_core::OsState>();
    let before = os.snapshot().privacy.kill_switch;
    let next = os.update(|c| {
        c.privacy.kill_switch = true;
        Ok(())
    })?;
    if !before {
        app.state::<crate::commands::bridge::BridgeState>().log(json!({ "type": "os-config", "killSwitch": true, "computeMode": next.compute.mode }));
    }
    let src: String = source.unwrap_or_else(|| "front-page".into()).chars().take(60).collect();
    audit::log("kill_switch", Severity::Critical, Outcome::Success, None, &format!("desktop-ui:{src}"), json!({ "reason": "outbound privacy lockdown engaged", "wasOn": before }));
    Ok(next)
}

/// The newest audit entries (unlocked session only).
#[tauri::command]
pub fn security_audit_recent(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    if rt().is_hard() || !rt().sessions().is_live() {
        return Err(Refusal::NoSession.message());
    }
    Ok(audit::recent(&super::dir(), limit.unwrap_or(100).min(1000)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSignature {
    pub sig: String,
    pub device_id: String,
}

/// Companion phone: approve a desktop's unlock request (own biometric check first).
#[tauri::command]
pub async fn security_companion_sign(app: AppHandle, id: String, nonce: String, desktop: Option<String>, purpose: Option<String>) -> Result<CompanionSignature, String> {
    if rt().is_hard() || !rt().sessions().is_live() {
        return Err(Refusal::NoSession.message());
    }
    if id.len() > 64 || nonce.len() > 64 {
        return Err("malformed request".into());
    }
    let prompt = match purpose.as_deref().and_then(|p| p.strip_prefix("step_up:")) {
        Some(m) => format!("Allow changes to {m} on your desktop Command Center"),
        None => "Approve the Command Center unlock on your desktop".into(),
    };
    super::biometric::verify(&app, &prompt).await?;
    let dir = super::dir();
    let device_id = super::device_id(&dir);
    let sig = companion::sign(&dir, &id, &nonce, &device_id)?;
    audit::log("companion_approved", Severity::Info, Outcome::Success, None, "companion", json!({ "id": id, "desktop": desktop, "purpose": purpose }));
    Ok(CompanionSignature { sig, device_id })
}

/// A live session with a live `settings` elevation (the same gate pairing and every other
/// settings change uses), or the refusal to show.
fn require_settings_step_up(what: &str) -> Result<(), String> {
    if rt().is_hard() {
        return Err(hard_err());
    }
    let p = policy();
    let now = super::now();
    let mut s = rt().sessions();
    s.tick(&p, now);
    if !s.is_live() {
        return Err(Refusal::NoSession.message());
    }
    if s.use_elevation("settings", &p, now).is_none() {
        return Err(format!("STEP_UP_REQUIRED:settings: confirm with your PIN to {what}"));
    }
    Ok(())
}

/// Companion phone: store the pairing key shown by `gabagool-cli pair-companion`, or the text of
/// the desktop's pairing QR (`gbgpair1|…`, refused once expired). Needs a settings step-up on
/// this device.
#[tauri::command]
pub fn security_companion_store_key(app: AppHandle, key: String) -> Result<Status, String> {
    require_settings_step_up("pair this device")?;
    let (key, desktop) = companion::parse_pair_input(&key, super::now())?;
    let place = companion::device_store(&super::dir(), &key)?;
    audit::log("companion_paired", Severity::Warn, Outcome::Success, Some("settings"), "desktop-ui", json!({ "stored": place, "via": if desktop.is_some() { "qr" } else { "key" }, "desktop": desktop }));
    emit(&app);
    Ok(status(&app))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingQr {
    /// The QR text (`gbgpair1|key|expires|desktop`); shown once, never stored by the webview.
    pub payload: String,
    pub expires_at: f64,
}

/// Desktop: pair a phone with a QR code. Generates a NEW pairing key (exactly like
/// `gabagool-cli pair-companion`, so a previously paired phone must pair again) and returns it as a
/// one-time payload that expires after `PAIR_QR_TTL_S`. Needs a settings step-up.
#[tauri::command]
pub fn security_companion_pair_qr(app: AppHandle) -> Result<PairingQr, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("PAIR_QR_DESKTOP: the pairing QR is shown on the desktop; scan it with this phone".into());
    }
    require_settings_step_up("pair a phone")?;
    let dir = super::dir();
    let was_paired = companion::pair_key(&dir).is_some();
    let key = companion::pair_generate(&dir)?;
    let expires_at = super::now() + companion::PAIR_QR_TTL_S;
    let payload = companion::pair_payload(&key, expires_at, &super::device_id(&dir));
    audit::log("companion_pair_qr", Severity::Warn, Outcome::Success, Some("settings"), "desktop-ui", json!({ "replaced": was_paired, "expiresAt": expires_at }));
    emit(&app);
    Ok(PairingQr { payload, expires_at })
}

/// Settings → Security: the idle lock (5–120 min) and hard re-auth (30–720 min) timers, written to
/// `security.config.json` (hot-reloaded). Needs a settings step-up; the values are clamped here.
#[tauri::command]
pub fn security_session_set(app: AppHandle, idle_lock_minutes: f64, reauth_minutes: f64) -> Result<Status, String> {
    require_settings_step_up("change the lock timers")?;
    let next = config::session_from_ui(idle_lock_minutes, reauth_minutes)?;
    let before = config::get().session;
    config::set_session_in(&super::dir(), &next)?;
    audit::log(
        "session_config_changed",
        Severity::Warn,
        Outcome::Success,
        Some("settings"),
        "desktop-ui",
        json!({ "idleLockMinutes": [before.idle_lock_minutes, next.idle_lock_minutes], "reauthMinutes": [before.reauth_minutes, next.reauth_minutes] }),
    );
    emit(&app);
    Ok(status(&app))
}

#[derive(serde::Deserialize)]
pub struct InboxAlert {
    pub id: String,
    pub ts: u64,
    pub severity: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub sig: String,
}

/// Companion phone: which inbox alerts were really signed by the paired desktop (true) and
/// which only came through the gateway (false: unsigned, e.g. raised by the gateway itself).
#[tauri::command]
pub fn security_companion_check_alerts(alerts: Vec<InboxAlert>) -> Vec<bool> {
    let Some(key) = companion::device_key(&super::dir()) else { return vec![false; alerts.len()] };
    alerts.iter().map(|a| !a.sig.is_empty() && token::alert_verify(&key, &a.id, a.ts, &a.severity, &a.title, &a.body, &a.sig)).collect()
}

/// Phone / tablet only: set the first PIN in the app (there is no gabagool-cli there). Refused
/// on the desktop and once a PIN exists: changing it needs the existing PIN via the CLI path, and
/// wiping app data to get back here also wipes the pairing key, so it can't approve anything.
#[tauri::command]
pub async fn security_pin_setup(app: AppHandle, pin: String) -> Result<Status, String> {
    if !cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("PIN_SETUP_DESKTOP: on the desktop set the PIN with `gabagool-cli set-pin`".into());
    }
    precheck()?;
    let dir = super::dir();
    if pin::is_set(&dir) {
        return Err("PIN_ALREADY_SET: a PIN is already set on this device".into());
    }
    let min = config::get().pin.min_length;
    let place = tokio::task::spawn_blocking(move || pin::store(&super::dir(), &pin, min)).await.map_err(|e| e.to_string())??;
    audit::log("pin_changed", Severity::Warn, Outcome::Success, None, "mobile-setup", json!({ "stored": place, "first": true }));
    emit(&app);
    Ok(status(&app))
}
