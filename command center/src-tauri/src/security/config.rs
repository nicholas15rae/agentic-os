//! `security.config.json`: every tunable of the security layer, outside the binary.
//!
//! Hot-reloaded (mtime-checked on each `get`), created with defaults on first run, and clamped on
//! load so a bad edit can't switch a control off by making it absurd (a 10-year idle timeout
//! becomes 120 min). The same file is read by the gateway (`security_api.py`) for its HTTP rules.
//! Secrets never go here: alert credentials come from the environment / `.env` / keychain.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const FILE: &str = "security.config.json";

/// Migration id: `unknown_device` (Section 24) appended once to an explicit `alerts.events`
/// list. Mirrored by `security_api.alert_events` (Python reads the same file).
pub const MIGRATE_UNKNOWN_DEVICE_ALERT: &str = "alerts-unknown-device";
/// Every migration a freshly written file already reflects.
pub const MIGRATIONS: [&str; 1] = [MIGRATE_UNKNOWN_DEVICE_ALERT];

/// What Settings → Security may set (Section 24): idle lock 5–120 min, hard re-auth 30–720 min.
/// The file loader (`clamped`) stays a little wider so a hand edit isn't silently rejected.
pub const IDLE_LOCK_RANGE: (f64, f64) = (5.0, 120.0);
pub const REAUTH_RANGE: (f64, f64) = (30.0, 720.0);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SecurityConfig {
    pub version: u32,
    /// One-time file migrations already applied (`migrate_value`), so a later deliberate edit
    /// (e.g. removing "unknown_device" from `alerts.events`) sticks. Fresh files carry them all.
    pub migrations: Vec<String>,
    /// Master switch. Off = the IPC gate and gateway checks allow everything (audited on start).
    pub enabled: bool,
    pub session: SessionCfg,
    pub pin: PinCfg,
    pub entry: EntryCfg,
    pub resume: ResumeCfg,
    pub elevation: ElevationCfg,
    pub biometric: BiometricCfg,
    pub companion: CompanionCfg,
    /// Protected modules (trading, finance, settings): Read-Only by default.
    pub modules: BTreeMap<String, ModulePolicy>,
    pub alerts: AlertsCfg,
    pub remote_kill: RemoteKillCfg,
    pub gateway: GatewayCfg,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionCfg {
    /// No user input for this long → auto-lock (resume needs double verification).
    pub idle_lock_minutes: f64,
    /// Hard re-verification window: after this long since the last verification the session
    /// locks regardless of activity.
    pub reauth_minutes: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PinCfg {
    pub min_length: usize,
    /// Wrong PINs in a row before the lockout.
    pub max_attempts: u32,
    pub lockout_seconds: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryCfg {
    /// Cold start also needs biometric / companion approval on top of the PIN.
    pub require_second_factor: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ResumeCfg {
    /// Idle / hourly / manual lock → resuming needs biometric-or-companion AND the PIN.
    pub require_double_verification: bool,
    /// No second factor reachable (no Hello, companion offline / unpaired) → the PIN alone
    /// resumes, audited and alerted as `second_factor_fallback`.
    pub pin_fallback_when_offline: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ElevationCfg {
    /// Step-up elevation reverts to Read-Only after this long unused…
    pub idle_minutes: f64,
    /// …and after this long in any case.
    pub max_minutes: f64,
    /// The paired phone may approve a step-up (its own fingerprint) instead of the PIN.
    pub allow_companion: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BiometricCfg {
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CompanionCfg {
    pub enabled: bool,
    /// Gateway the companion phone polls (desktop posts approval requests here).
    pub gateway_url: String,
    pub approval_timeout_seconds: f64,
}

/// One HTTP rule on the gateway: `path` matches exactly, or as a prefix when it ends in `*`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpRule {
    pub method: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModulePolicy {
    pub read_only_by_default: bool,
    /// Rust IPC commands that mutate this module (need a live elevation).
    pub commands: Vec<String>,
    /// Commands guarded only when their arguments touch these JSON pointers (e.g. the shared
    /// `os_config_update` needs step-up for `/patch/privacy` but not for `/patch/voice`).
    pub guarded_args: BTreeMap<String, Vec<String>>,
    /// Gateway routes that mutate this module (need an elevation token).
    pub gateway: Vec<HttpRule>,
}

impl Default for ModulePolicy {
    fn default() -> Self {
        Self { read_only_by_default: true, commands: vec![], guarded_args: BTreeMap::new(), gateway: vec![] }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertsCfg {
    pub enabled: bool,
    /// Delivery channels, tried in order until one takes the alert: "companion" (the paired
    /// phone, via the gateway mailbox), "webhook" (n8n etc.), "twilio", "email". A channel that
    /// isn't configured (no pairing, no URL, no credentials) is skipped silently.
    pub channels: Vec<String>,
    /// Also send every alert to every other configured channel, not just the first that works.
    pub fan_out: bool,
    /// Audit events that raise an out-of-band alert.
    pub events: Vec<String>,
    /// Same event at most once per this many seconds (critical events are never throttled).
    pub min_interval_seconds: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteKillCfg {
    pub enabled: bool,
    /// Webhook timestamp tolerance (replay window).
    pub max_skew_seconds: f64,
    /// Also cancel orders and flatten positions (the trading E-stop). Off: lock only, positions
    /// and broker-side brackets untouched.
    pub flatten_positions: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayCfg {
    /// Loopback requests WITHOUT an Origin header (local scripts: trading agent, healthcheck)
    /// skip the step-up check; a browser / webview always sends Origin. Hard lock still applies.
    pub exempt_loopback_automation: bool,
}

fn rule(method: &str, path: &str) -> HttpRule {
    HttpRule { method: method.into(), path: path.into() }
}

fn default_modules() -> BTreeMap<String, ModulePolicy> {
    let mut m = BTreeMap::new();
    m.insert(
        "trading".into(),
        ModulePolicy {
            read_only_by_default: true,
            commands: vec![],
            guarded_args: BTreeMap::new(),
            gateway: vec![
                rule("POST", "/api/trading/intents*"),
                rule("POST", "/api/trading/mode"),
                rule("POST", "/api/trading/engines/*"),
                rule("POST", "/api/trading/agent/run"),
                rule("POST", "/api/trading/agent/enable"),
                rule("POST", "/api/trading/kill-switch/reset"),
            ],
        },
    );
    let fin: Vec<HttpRule> = ["income", "goals", "invoices", "checks", "receipts"]
        .iter()
        .flat_map(|c| ["POST", "PATCH", "DELETE"].map(|m| rule(m, &format!("/api/cc/c/{c}*"))))
        .collect();
    m.insert(
        "finance".into(),
        ModulePolicy { read_only_by_default: true, commands: vec!["finance_ledger_write".into(), "bizops_finance_handoff".into()], guarded_args: BTreeMap::new(), gateway: fin },
    );
    m.insert(
        "settings".into(),
        ModulePolicy {
            read_only_by_default: true,
            commands: [
                "os_secret_set",
                "os_secret_delete",
                "secret_set",
                "secret_delete",
                "providers_update",
                "provider_add",
                "provider_remove",
                "policy_update",
                "policy_set_mode",
                "bridge_set",
                "gateway_token_rotate",
                "n8n_workflows_set",
                "n8n_instance_add",
                "pipelines_settings_update",
                "review_config_set",
                "review_webhook_set",
                "review_webhook_clear",
                "diag_schedule_set",
                "tony_mode_upsert",
                "tony_mode_delete",
                "cli_install",
            ]
            .map(String::from)
            .to_vec(),
            guarded_args: BTreeMap::from([(
                "os_config_update".to_string(),
                // `gmail` holds the booking check's instruction-file path (read into Tony's prompt).
                ["privacy", "mcps", "permissions", "skills", "fsRoots", "routing", "overseer", "identityPath", "rootDirective", "anythingllm", "droplet", "gmail"].map(|k| format!("/patch/{k}")).to_vec(),
            )]),
            gateway: vec![rule("PUT", "/api/cc/config")],
        },
    );
    m
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            version: 1,
            migrations: MIGRATIONS.map(String::from).to_vec(),
            enabled: true,
            session: SessionCfg::default(),
            pin: PinCfg::default(),
            entry: EntryCfg::default(),
            resume: ResumeCfg::default(),
            elevation: ElevationCfg::default(),
            biometric: BiometricCfg::default(),
            companion: CompanionCfg::default(),
            modules: default_modules(),
            alerts: AlertsCfg::default(),
            remote_kill: RemoteKillCfg::default(),
            gateway: GatewayCfg::default(),
        }
    }
}
impl Default for SessionCfg {
    fn default() -> Self {
        Self { idle_lock_minutes: 15.0, reauth_minutes: 60.0 }
    }
}
impl Default for PinCfg {
    fn default() -> Self {
        Self { min_length: 6, max_attempts: 5, lockout_seconds: 300.0 }
    }
}
impl Default for EntryCfg {
    fn default() -> Self {
        Self { require_second_factor: false }
    }
}
impl Default for ResumeCfg {
    fn default() -> Self {
        Self { require_double_verification: true, pin_fallback_when_offline: true }
    }
}
impl Default for ElevationCfg {
    fn default() -> Self {
        Self { idle_minutes: 5.0, max_minutes: 10.0, allow_companion: true }
    }
}
impl Default for BiometricCfg {
    fn default() -> Self {
        Self { enabled: true }
    }
}
impl Default for CompanionCfg {
    fn default() -> Self {
        Self { enabled: true, gateway_url: "http://127.0.0.1:8080".into(), approval_timeout_seconds: 90.0 }
    }
}
impl Default for AlertsCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            channels: vec!["companion".into(), "webhook".into()],
            fan_out: false,
            events: [
                "login_success",
                "login_failure",
                "pin_lockout",
                "reverify_success",
                "second_factor_fallback",
                "hard_lock",
                "remote_kill",
                "remote_kill_rejected",
                "kill_switch",
                "trading_kill_switch",
                "pin_changed",
                "unknown_device",
            ]
            .map(String::from)
            .to_vec(),
            min_interval_seconds: 30.0,
        }
    }
}
impl Default for RemoteKillCfg {
    fn default() -> Self {
        Self { enabled: true, max_skew_seconds: 120.0, flatten_positions: false }
    }
}
impl Default for GatewayCfg {
    fn default() -> Self {
        Self { exempt_loopback_automation: true }
    }
}

fn clampf(v: f64, lo: f64, hi: f64, dflt: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        dflt
    }
}

impl SecurityConfig {
    /// Bound every tunable to a sane range (pure).
    pub fn clamped(mut self) -> Self {
        let d = SecurityConfig::default();
        self.session.idle_lock_minutes = clampf(self.session.idle_lock_minutes, 1.0, 120.0, d.session.idle_lock_minutes);
        self.session.reauth_minutes = clampf(self.session.reauth_minutes, 5.0, REAUTH_RANGE.1, d.session.reauth_minutes);
        self.pin.min_length = self.pin.min_length.clamp(4, 12);
        self.pin.max_attempts = self.pin.max_attempts.clamp(3, 20);
        self.pin.lockout_seconds = clampf(self.pin.lockout_seconds, 30.0, 3600.0, d.pin.lockout_seconds);
        self.elevation.idle_minutes = clampf(self.elevation.idle_minutes, 1.0, 30.0, d.elevation.idle_minutes);
        self.elevation.max_minutes = clampf(self.elevation.max_minutes, 1.0, 60.0, d.elevation.max_minutes).max(self.elevation.idle_minutes);
        self.companion.approval_timeout_seconds = clampf(self.companion.approval_timeout_seconds, 15.0, 600.0, d.companion.approval_timeout_seconds);
        self.alerts.min_interval_seconds = clampf(self.alerts.min_interval_seconds, 0.0, 3600.0, d.alerts.min_interval_seconds);
        self.alerts.channels.retain(|c| matches!(c.as_str(), "companion" | "webhook" | "twilio" | "email"));
        self.alerts.channels.dedup();
        self.remote_kill.max_skew_seconds = clampf(self.remote_kill.max_skew_seconds, 10.0, 900.0, d.remote_kill.max_skew_seconds);
        self
    }

    /// The protected module that lists `cmd` as mutating, if any (arguments ignored).
    pub fn module_for_command(&self, cmd: &str) -> Option<&str> {
        self.modules.iter().find(|(_, p)| p.commands.iter().any(|c| c == cmd)).map(|(m, _)| m.as_str())
    }

    /// The protected module this invoke mutates: an unconditional command, or a guarded one
    /// whose arguments set any listed JSON pointer. Engaging the privacy kill switch
    /// (`{"patch":{"privacy":{"killSwitch":true}}}` and nothing else) is the safe direction and is
    /// never guarded.
    pub fn module_for_invoke(&self, cmd: &str, args: Option<&serde_json::Value>) -> Option<&str> {
        if let Some(m) = self.module_for_command(cmd) {
            return Some(m);
        }
        let args = args?;
        if cmd == "os_config_update" && args == &serde_json::json!({ "patch": { "privacy": { "killSwitch": true } } }) {
            return None;
        }
        self.modules
            .iter()
            .find(|(_, p)| p.guarded_args.get(cmd).is_some_and(|ptrs| ptrs.iter().any(|ptr| args.pointer(ptr).is_some_and(|v| !v.is_null()))))
            .map(|(m, _)| m.as_str())
    }
}

/// The Security card's session timers, validated and clamped to the UI ranges (pure). Whole
/// minutes; a non-number is refused rather than guessed.
pub fn session_from_ui(idle_lock_minutes: f64, reauth_minutes: f64) -> Result<SessionCfg, String> {
    if !idle_lock_minutes.is_finite() || !reauth_minutes.is_finite() {
        return Err("BAD_SESSION_CONFIG: the lock timers must be numbers of minutes".into());
    }
    Ok(SessionCfg {
        idle_lock_minutes: idle_lock_minutes.round().clamp(IDLE_LOCK_RANGE.0, IDLE_LOCK_RANGE.1),
        reauth_minutes: reauth_minutes.round().clamp(REAUTH_RANGE.0, REAUTH_RANGE.1),
    })
}

/// `text` (the current file, or None when it doesn't exist yet) with only `session.idleLockMinutes`
/// and `session.reauthMinutes` replaced: every other key, known or not, is kept as it is (pure).
/// An unparsable file is refused, never overwritten with the defaults.
pub fn with_session(text: Option<&str>, s: &SessionCfg) -> Result<String, String> {
    let mut v = match text {
        Some(t) => serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')).map_err(|e| format!("BAD_SESSION_CONFIG: {FILE} isn't valid JSON ({e}); fix it by hand first"))?,
        None => serde_json::to_value(SecurityConfig::default()).map_err(|e| e.to_string())?,
    };
    let root = v.as_object_mut().ok_or_else(|| format!("BAD_SESSION_CONFIG: {FILE} isn't a JSON object"))?;
    let session = root.entry("session").or_insert_with(|| serde_json::json!({}));
    if !session.is_object() {
        *session = serde_json::json!({});
    }
    session["idleLockMinutes"] = serde_json::json!(s.idle_lock_minutes);
    session["reauthMinutes"] = serde_json::json!(s.reauth_minutes);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/// Write the session timers into `dir`'s config file (atomic; the mtime check hot-reloads it).
pub fn set_session_in(dir: &Path, s: &SessionCfg) -> Result<(), String> {
    let path = dir.join(FILE);
    let text = std::fs::read_to_string(&path).ok();
    let next = with_session(text.as_deref(), s)?;
    super::shared::write_atomic(&path, next.as_bytes()).map_err(|e| e.to_string())
}

/// One-time, versioned upgrades of a saved file, on the raw JSON so every other key (known or
/// not) is kept as it is (pure). Returns true when `v` changed (the caller writes it back).
/// `alerts-unknown-device`: an explicit `alerts.events` list gets "unknown_device" appended once
/// (a file without the list already gets it from the defaults); the id is recorded in
/// `migrations`, so removing the event afterwards sticks.
pub fn migrate_value(v: &mut serde_json::Value) -> bool {
    let Some(root) = v.as_object_mut() else { return false };
    let done = |root: &serde_json::Map<String, serde_json::Value>, id: &str| root.get("migrations").and_then(|m| m.as_array()).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(id)));
    if done(root, MIGRATE_UNKNOWN_DEVICE_ALERT) {
        return false;
    }
    if let Some(events) = root.get_mut("alerts").and_then(|a| a.get_mut("events")).and_then(|e| e.as_array_mut()) {
        if !events.iter().any(|e| e.as_str() == Some("unknown_device")) {
            events.push(serde_json::json!("unknown_device"));
        }
    }
    let m = root.entry("migrations").or_insert_with(|| serde_json::json!([]));
    if !m.is_array() {
        *m = serde_json::json!([]);
    }
    if let Some(a) = m.as_array_mut() {
        a.push(serde_json::json!(MIGRATE_UNKNOWN_DEVICE_ALERT));
    }
    true
}

/// Read (and clamp) the config at `path`; a missing file is written with the defaults; an
/// unparsable one falls back to the defaults (the strict posture) and says so. A pending
/// one-time migration (`migrate_value`) is applied and written back atomically first.
pub fn load(path: &Path) -> (SecurityConfig, Option<String>) {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let mut v = match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
                Ok(v) => v,
                Err(e) => return (SecurityConfig::default(), Some(format!("{}: {e}; using the defaults", path.display()))),
            };
            let mut warn = None;
            if migrate_value(&mut v) {
                let written = serde_json::to_string_pretty(&v).map_err(|e| e.to_string()).and_then(|s| super::shared::write_atomic(path, s.as_bytes()).map_err(|e| e.to_string()));
                if let Err(e) = written {
                    warn = Some(format!("{}: couldn't save the one-time migration ({e}); applied in memory", path.display()));
                }
            }
            match serde_json::from_value::<SecurityConfig>(v) {
                Ok(c) => (c.clamped(), warn),
                Err(e) => (SecurityConfig::default(), Some(format!("{}: {e}; using the defaults", path.display()))),
            }
        }
        Err(_) => {
            let c = SecurityConfig::default();
            if let Some(p) = path.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = std::fs::write(path, serde_json::to_string_pretty(&c).unwrap_or_default());
            (c, None)
        }
    }
}

struct Cache {
    path: PathBuf,
    mtime: Option<SystemTime>,
    cfg: SecurityConfig,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// The live config for `dir` (re-read when the file's mtime changes).
pub fn get_in(dir: &Path) -> SecurityConfig {
    let path = dir.join(FILE);
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut g = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(c) = g.as_ref() {
        if c.path == path && c.mtime == mtime && mtime.is_some() {
            return c.cfg.clone();
        }
    }
    let (cfg, warn) = load(&path);
    if let Some(w) = warn {
        eprintln!("[security] config: {w}");
    }
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    *g = Some(Cache { path, mtime, cfg: cfg.clone() });
    cfg
}

/// The live config for the process security dir.
pub fn get() -> SecurityConfig {
    get_in(&super::dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_and_clamp() {
        let c = SecurityConfig::default();
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains("\"idleLockMinutes\":15") && s.contains("\"reauthMinutes\":60"));
        let back: SecurityConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back, c);
        let wild: SecurityConfig = serde_json::from_str(r#"{"session":{"idleLockMinutes":1e9,"reauthMinutes":0},"pin":{"maxAttempts":1000,"minLength":1},"elevation":{"idleMinutes":20,"maxMinutes":2}}"#).unwrap();
        let w = wild.clamped();
        assert_eq!(w.session.idle_lock_minutes, 120.0);
        assert_eq!(w.session.reauth_minutes, 5.0);
        assert_eq!(w.pin.max_attempts, 20);
        assert_eq!(w.pin.min_length, 4);
        assert_eq!(w.elevation.max_minutes, 20.0, "max never below idle");
        // A partial file keeps every unspecified default (modules included).
        let inv = |a: serde_json::Value| w.module_for_invoke("os_config_update", Some(&a)).map(str::to_string);
        assert_eq!(inv(serde_json::json!({"patch": {"privacy": {"killSwitch": false}}})).as_deref(), Some("settings"));
        assert_eq!(inv(serde_json::json!({"patch": {"mcps": []}})).as_deref(), Some("settings"));
        assert_eq!(inv(serde_json::json!({"patch": {"gmail": {"bookingInstructionsPath": "x.md"}}})).as_deref(), Some("settings"), "the booking instruction path needs a step-up");
        assert_eq!(inv(serde_json::json!({"patch": {"privacy": {"killSwitch": true}}})), None, "engaging lockdown is never gated");
        assert_eq!(inv(serde_json::json!({"patch": {"voice": {"micEnabled": false}}})), None, "muting the mic is never gated");
        assert_eq!(w.module_for_invoke("secret_set", None), Some("settings"));
        assert_eq!(w.module_for_command("finance_ledger_write"), Some("finance"));
        assert_eq!(w.module_for_command("system_stats"), None);
    }

    #[test]
    fn security_card_session_timers_are_validated_and_saved_in_place() {
        assert_eq!(session_from_ui(1.0, 1.0).unwrap(), SessionCfg { idle_lock_minutes: 5.0, reauth_minutes: 30.0 });
        assert_eq!(session_from_ui(500.0, 5000.0).unwrap(), SessionCfg { idle_lock_minutes: 120.0, reauth_minutes: 720.0 });
        assert_eq!(session_from_ui(20.4, 90.0).unwrap(), SessionCfg { idle_lock_minutes: 20.0, reauth_minutes: 90.0 });
        assert!(session_from_ui(f64::NAN, 60.0).is_err());
        // Defaults are untouched by the new limits.
        assert_eq!(SessionCfg::default(), SessionCfg { idle_lock_minutes: 15.0, reauth_minutes: 60.0 });
        // A 12-hour re-auth set from the card survives the loader's clamp.
        let long: SecurityConfig = serde_json::from_str(r#"{"session":{"idleLockMinutes":30,"reauthMinutes":720}}"#).unwrap();
        assert_eq!(long.clamped().session.reauth_minutes, 720.0);
        // Only the two keys change; unknown keys and other sections stay.
        let s = SessionCfg { idle_lock_minutes: 30.0, reauth_minutes: 240.0 };
        let out = with_session(Some(r#"{"enabled":true,"custom":{"x":1},"session":{"idleLockMinutes":15,"note":"keep"},"pin":{"minLength":8}}"#), &s).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session"]["idleLockMinutes"], 30.0);
        assert_eq!(v["session"]["reauthMinutes"], 240.0);
        assert_eq!(v["session"]["note"], "keep");
        assert_eq!(v["custom"]["x"], 1);
        assert_eq!(v["pin"]["minLength"], 8);
        assert!(with_session(Some("{ broken"), &s).is_err(), "a bad file is never overwritten");
        let fresh: SecurityConfig = serde_json::from_str(&with_session(None, &s).unwrap()).unwrap();
        assert_eq!(fresh.session, s);
        assert_eq!(fresh.modules, SecurityConfig::default().modules);
        // Through the file + hot reload.
        let dir = std::env::temp_dir().join(format!("cc-sec-sess-{}", super::super::token::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(get_in(&dir).session, SessionCfg::default());
        std::thread::sleep(std::time::Duration::from_millis(20));
        set_session_in(&dir, &s).unwrap();
        assert_eq!(get_in(&dir).session, s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Section 24: an existing file with an explicit `alerts.events` list gets "unknown_device"
    /// once (written back, every other key kept); a later removal sticks; fresh files are already
    /// migrated; a file without the list keeps the defaults (which include it).
    #[test]
    fn unknown_device_alert_is_migrated_into_saved_event_lists_once() {
        let dir = std::env::temp_dir().join(format!("cc-sec-mig-{}", super::super::token::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(FILE);
        std::fs::write(&p, r#"{"version":1,"custom":{"keep":true},"alerts":{"enabled":true,"events":["hard_lock","login_failure"]}}"#).unwrap();
        let (c, w) = load(&p);
        assert!(w.is_none(), "{w:?}");
        assert_eq!(c.alerts.events, ["hard_lock", "login_failure", "unknown_device"]);
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(saved["alerts"]["events"], serde_json::json!(["hard_lock", "login_failure", "unknown_device"]));
        assert_eq!(saved["migrations"], serde_json::json!([MIGRATE_UNKNOWN_DEVICE_ALERT]));
        assert_eq!(saved["custom"]["keep"], true, "unknown keys survive");
        // A deliberate removal afterwards sticks.
        std::fs::write(&p, r#"{"version":1,"migrations":["alerts-unknown-device"],"alerts":{"events":["hard_lock"]}}"#).unwrap();
        let before = std::fs::read_to_string(&p).unwrap();
        let (c, _) = load(&p);
        assert_eq!(c.alerts.events, ["hard_lock"]);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), before, "nothing rewritten");
        // Pure: already listed → only the marker; no list → only the marker (defaults have it).
        let mut v = serde_json::json!({"alerts": {"events": ["unknown_device"]}});
        assert!(migrate_value(&mut v));
        assert_eq!(v["alerts"]["events"], serde_json::json!(["unknown_device"]));
        assert!(!migrate_value(&mut v), "once");
        let mut v = serde_json::json!({"alerts": {"enabled": false}});
        assert!(migrate_value(&mut v));
        let c: SecurityConfig = serde_json::from_value(v).unwrap();
        assert!(c.alerts.events.iter().any(|e| e == "unknown_device"));
        // A fresh default file is already migrated.
        let mut fresh = serde_json::to_value(SecurityConfig::default()).unwrap();
        assert!(!migrate_value(&mut fresh));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_created_bad_file_falls_back() {
        let dir = std::env::temp_dir().join(format!("cc-sec-cfg-{}", super::super::token::random_hex(4)));
        let p = dir.join(FILE);
        let (c, w) = load(&p);
        assert!(w.is_none() && p.exists() && c.enabled);
        std::fs::write(&p, "{ not json").unwrap();
        let (c, w) = load(&p);
        assert!(w.is_some() && c == SecurityConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
