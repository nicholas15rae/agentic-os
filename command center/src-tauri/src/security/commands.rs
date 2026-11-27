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

/// Serializes the restart snapshot's save / clear (a save that read a live session can never land
/// after a lock's clear), and remembers whether this run wrote one since the last revoke.
static PERSIST: Mutex<bool> = Mutex::new(false);
/// The keychain refused a key rotation: no more snapshots this run (fail closed).
static PERSIST_OFF: AtomicBool = AtomicBool::new(false);

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
    /// Section pass: the paired phone's approval logs in on its own (PIN = fallback).
    pub companion_unlocks: bool,
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
    /// Section pass: an unlocked session survives an app restart (desktop).
    pub persist_across_restarts: bool,
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
    let (locked, session) = {
        let mut s = r.sessions();
        let l = s.tick(&p, now);
        (l, s.view(&p, now))
    };
    // A session past its deadline locks here like everywhere else: revoke, audit, clear the snapshot.
    if let Some(reason) = locked {
        after_auto_lock(reason);
    }
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
        companion_unlocks: cfg.companion.enabled && cfg.companion.unlocks_alone,
        companion_device: companion::device_key(&dir).is_some(),
        platform: platform(),
        device_id: super::device_id(&dir),
        session,
        modules,
        idle_lock_minutes: cfg.session.idle_lock_minutes,
        reauth_minutes: cfg.session.reauth_minutes,
        elevation_idle_minutes: cfg.elevation.idle_minutes,
        elevation_max_minutes: cfg.elevation.max_minutes,
        persist_across_restarts: cfg.persist_enabled(),
        now,
    }
}

fn emit(app: &AppHandle) {
    // Status first: its tick may lock an overdue session (and then clears the snapshot itself).
    let st = status(app);
    persist_now(app);
    let _ = app.emit(STATE_EVENT, st);
}

/// Where this app instance keeps its restart snapshot (`persist`): its own local data folder.
fn persist_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("security"))
}

/// Keep the restart snapshot in step with the session: saved while live, deleted on any lock.
fn persist_now(app: &AppHandle) {
    let Some(dir) = persist_dir(app) else { return };
    let cfg = config::get();
    let mut saved = PERSIST.lock().unwrap_or_else(|p| p.into_inner());
    // Snapshot and epoch read together, under the sessions guard.
    let live = if cfg.persist_enabled() && !rt().is_hard() && !PERSIST_OFF.load(Ordering::SeqCst) {
        let s = rt().sessions();
        s.snapshot().map(|x| (x, rt().epoch.load(Ordering::SeqCst)))
    } else {
        None
    };
    match live {
        Some(((id, verified, activity), epoch)) => {
            super::persist::save(&dir, &super::persist::Snapshot { v: 1, id, verified, activity, epoch });
            *saved = true;
        }
        None => {
            super::persist::clear(&dir);
            // A lock: rotate the sealing key so no earlier copy of the file can come back.
            if *saved {
                if !super::persist::revoke() {
                    PERSIST_OFF.store(true, Ordering::SeqCst);
                    eprintln!("[security] couldn't rotate the session key; restart persistence is off for this run");
                }
                *saved = false;
            }
        }
    }
}

/// Start-up: bring back a session saved before the restart, when it is still valid.
fn restore_session(app: &AppHandle, cfg: &config::SecurityConfig) {
    let Some(dir) = persist_dir(app) else { return };
    if !cfg.persist_enabled() || rt().is_hard() {
        super::persist::clear(&dir);
        return;
    }
    let Some(s) = super::persist::load(&dir) else { return };
    let p = Policy::from_config(cfg);
    let now = super::now();
    match super::persist::refuse(&s, now, rt().epoch.load(Ordering::SeqCst), p.idle_s, p.reauth_s) {
        None => {
            if rt().sessions().restore(s.id.clone(), s.verified, s.activity) {
                audit::log("session_restored", Severity::Info, Outcome::Success, None, "desktop", json!({ "verifiedAgoS": (now - s.verified) as u64, "idleS": (now - s.activity) as u64 }));
            }
        }
        Some(why) => {
            super::persist::clear(&dir);
            if !super::persist::revoke() {
                PERSIST_OFF.store(true, Ordering::SeqCst);
            }
            audit::log("session_not_restored", Severity::Info, Outcome::Info, None, "desktop", json!({ "why": why }));
        }
    }
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
    restore_session(app, &cfg);
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
    } else if let Some(app) = rt().app.get() {
        // Fresh activity in the restart snapshot (the webview throttles touches to 30 s).
        persist_now(app);
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
    /// The 2-digit number the desktop shows and the phone user types (never sent to the gateway).
    pub code: String,
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
    let (id, expires_at, code) = companion::request(&cfg.companion.gateway_url, &dir, &super::device_id(&dir), &purpose, cfg.companion.approval_timeout_seconds).await?;
    audit::log("companion_requested", Severity::Info, Outcome::Info, module.as_deref(), "desktop-ui", json!({ "id": id, "purpose": purpose }));
    let _ = app;
    Ok(CompanionTicket { id, expires_at, code })
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
            let unlocked = res.map_err(|e| e.message())? == BioOutcome::Unlocked;
            if unlocked {
                audit::log("login_success", Severity::Info, Outcome::Success, None, "companion", json!({ "factor": "companion", "companion": device, "purpose": purpose }));
            } else {
                audit::log("second_factor_ok", Severity::Info, Outcome::Success, None, "desktop-ui", json!({ "factor": "companion", "companion": device }));
            }
            emit(&app);
            Ok(json!({ "state": "approved", "unlocked": unlocked }))
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
pub async fn security_companion_sign(app: AppHandle, id: String, nonce: String, desktop: Option<String>, purpose: Option<String>, code: Option<String>) -> Result<CompanionSignature, String> {
    if rt().is_hard() || !rt().sessions().is_live() {
        return Err(Refusal::NoSession.message());
    }
    let code = code.unwrap_or_default();
    if id.len() > 64 || nonce.len() > 64 || code.len() != 2 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("type the 2-digit number shown on your desktop".into());
    }
    let prompt = match purpose.as_deref().and_then(|p| p.strip_prefix("step_up:")) {
        Some(m) => format!("Allow changes to {m} on your desktop Command Center"),
        None => "Approve the Command Center unlock on your desktop".into(),
    };
    super::biometric::verify(&app, &prompt).await?;
    let dir = super::dir();
    let device_id = super::device_id(&dir);
    let sig = companion::sign(&dir, &id, &nonce, &device_id, &code)?;
    audit::log("companion_approved", Severity::Info, Outcome::Success, None, "companion", json!({ "id": id, "desktop": desktop, "purpose": purpose }));
    Ok(CompanionSignature { sig, device_id })
}

/// The four session timeouts Settings → Security edits (minutes).
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timeouts {
    pub idle_lock_minutes: f64,
    pub reauth_minutes: f64,
    pub elevation_idle_minutes: f64,
    pub elevation_max_minutes: f64,
    /// Stay unlocked across app restarts (None: leave the setting as it is).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_across_restarts: Option<bool>,
}

/// `text` (security.config.json) with the four timeouts replaced, clamped like every load; every
/// other field is kept as written. Pure.
pub fn with_timeouts(text: &str, t: &Timeouts) -> Result<(String, Timeouts), String> {
    let mut v: serde_json::Value = if text.trim().is_empty() { json!({}) } else { serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("security.config.json is unreadable ({e})"))? };
    let obj = v.as_object_mut().ok_or("security.config.json is not an object")?;
    let session = obj.entry("session").or_insert_with(|| json!({}));
    session["idleLockMinutes"] = json!(t.idle_lock_minutes);
    session["reauthMinutes"] = json!(t.reauth_minutes);
    if let Some(p) = t.persist_across_restarts {
        session["persistAcrossRestarts"] = json!(p);
    }
    let elev = obj.entry("elevation").or_insert_with(|| json!({}));
    elev["idleMinutes"] = json!(t.elevation_idle_minutes);
    elev["maxMinutes"] = json!(t.elevation_max_minutes);
    let c: config::SecurityConfig = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
    let c = c.clamped();
    let applied = Timeouts { idle_lock_minutes: c.session.idle_lock_minutes, reauth_minutes: c.session.reauth_minutes, elevation_idle_minutes: c.elevation.idle_minutes, elevation_max_minutes: c.elevation.max_minutes, persist_across_restarts: t.persist_across_restarts.map(|_| c.session.persist_across_restarts) };
    // Store the clamped values, so the file says what is actually in force.
    v["session"]["idleLockMinutes"] = json!(applied.idle_lock_minutes);
    v["session"]["reauthMinutes"] = json!(applied.reauth_minutes);
    v["elevation"]["idleMinutes"] = json!(applied.elevation_idle_minutes);
    v["elevation"]["maxMinutes"] = json!(applied.elevation_max_minutes);
    Ok((serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?, applied))
}

/// Settings → Security: change the session timeouts (needs a settings step-up). Hot-reloaded.
#[tauri::command]
pub fn security_set_timeouts(app: AppHandle, timeouts: Timeouts) -> Result<Status, String> {
    if rt().is_hard() {
        return Err(hard_err());
    }
    let p = policy();
    if rt().sessions().use_elevation("settings", &p, super::now()).is_none() {
        return Err("STEP_UP_REQUIRED:settings: confirm with your PIN to change the timeouts".into());
    }
    let path = super::dir().join(config::FILE);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (out, applied) = with_timeouts(&text, &timeouts)?;
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    audit::log("timeouts_changed", Severity::Warn, Outcome::Success, Some("settings"), "desktop-ui", serde_json::to_value(&applied).unwrap_or_default());
    emit(&app);
    Ok(status(&app))
}

/// Companion phone: store the pairing key shown by `gabagool-cli pair-companion` (needs a
/// settings step-up on this device).
#[tauri::command]
pub fn security_companion_store_key(app: AppHandle, key: String) -> Result<Status, String> {
    if rt().is_hard() {
        return Err(hard_err());
    }
    let p = policy();
    if rt().sessions().use_elevation("settings", &p, super::now()).is_none() {
        return Err("STEP_UP_REQUIRED:settings: confirm with your PIN to pair this device".into());
    }
    let place = companion::device_store(&super::dir(), &key)?;
    audit::log("companion_paired", Severity::Warn, Outcome::Success, Some("settings"), "desktop-ui", json!({ "stored": place }));
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

#[cfg(test)]
mod timeout_tests {
    use super::*;

    #[test]
    fn timeouts_are_written_clamped_and_everything_else_is_kept() {
        let text = r#"{"enabled":true,"session":{"idleLockMinutes":15,"reauthMinutes":60},"elevation":{"idleMinutes":5,"maxMinutes":10,"allowCompanion":false},"pin":{"maxAttempts":7}}"#;
        let want = Timeouts { idle_lock_minutes: 30.0, reauth_minutes: 120.0, elevation_idle_minutes: 15.0, elevation_max_minutes: 60.0, persist_across_restarts: Some(false) };
        let (out, applied) = with_timeouts(text, &want).unwrap();
        assert_eq!(applied, want);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["elevation"]["allowCompanion"], false, "other fields kept");
        assert_eq!(v["pin"]["maxAttempts"], 7);
        assert_eq!(v["session"]["idleLockMinutes"], 30.0);
        // Out of range: clamped, and the file says what is in force.
        assert_eq!(v["session"]["persistAcrossRestarts"], false);
        let wild = Timeouts { idle_lock_minutes: 999.0, reauth_minutes: 1.0, elevation_idle_minutes: 90.0, elevation_max_minutes: 5.0, persist_across_restarts: None };
        let (out, applied) = with_timeouts(text, &wild).unwrap();
        assert_eq!((applied.idle_lock_minutes, applied.reauth_minutes, applied.elevation_idle_minutes), (120.0, 5.0, 30.0));
        assert!(applied.elevation_max_minutes >= applied.elevation_idle_minutes);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session"]["idleLockMinutes"], 120.0);
        // A missing file starts from the defaults.
        assert!(with_timeouts("", &want).is_ok());
        assert!(with_timeouts("not json", &want).is_err());
    }
}
