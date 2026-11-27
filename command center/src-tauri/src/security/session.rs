//! The session lifecycle as a pure state machine (time is passed in, so every rule is testable).
//!
//! - Cold start (`Startup`) unlocks with the PIN, or biometrics alone, unless the config makes
//!   entry need a second factor too.
//! - A live session suspends after `idleLockMinutes` without input (`Idle`) or `reauthMinutes`
//!   after its last verification regardless of input (`Reauth`); a manual lock or an external
//!   epoch change does the same (`Manual`, `Revoked`). Resuming needs DOUBLE verification:
//!   biometric-or-companion (fresh within 2 min) AND the PIN, with a PIN-only fallback when no
//!   second factor is reachable (if the config allows it).
//! - `HardLock` (remote failsafe) can't be lifted here at all.
//! - Step-up elevation per module: the PIN again; it reverts to Read-Only after `idleMinutes`
//!   unused or `maxMinutes` in any case, and every lock drops it.
//! - Wrong PINs (unlock or step-up) share one counter: `maxAttempts` in a row → lockout.

use serde::Serialize;
use std::collections::BTreeMap;

use super::config::SecurityConfig;

/// A satisfied second factor stays usable for this long.
pub const SECOND_FACTOR_TTL: f64 = 120.0;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum LockReason {
    Startup,
    Idle,
    Reauth,
    Manual,
    Revoked,
    HardLock,
}

impl LockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Idle => "idle",
            Self::Reauth => "reauth",
            Self::Manual => "manual",
            Self::Revoked => "revoked",
            Self::HardLock => "hard-lock",
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Factor {
    Pin,
    Biometric,
    Companion,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub idle_s: f64,
    pub reauth_s: f64,
    pub elev_idle_s: f64,
    pub elev_max_s: f64,
    pub max_attempts: u32,
    pub lockout_s: f64,
    pub entry_second: bool,
    pub resume_double: bool,
    pub pin_fallback: bool,
}

impl Policy {
    pub fn from_config(c: &SecurityConfig) -> Self {
        Self {
            idle_s: c.session.idle_lock_minutes * 60.0,
            reauth_s: c.session.reauth_minutes * 60.0,
            elev_idle_s: c.elevation.idle_minutes * 60.0,
            elev_max_s: c.elevation.max_minutes * 60.0,
            max_attempts: c.pin.max_attempts,
            lockout_s: c.pin.lockout_seconds,
            entry_second: c.entry.require_second_factor,
            resume_double: c.resume.require_double_verification,
            pin_fallback: c.resume.pin_fallback_when_offline,
        }
    }
}

#[derive(Clone, Debug)]
struct Elev {
    granted: f64,
    used: f64,
}

#[derive(Clone, Debug)]
struct Live {
    id: String,
    verified: f64,
    activity: f64,
    elevations: BTreeMap<String, Elev>,
}

#[derive(Debug, PartialEq)]
pub enum Refusal {
    LockedOut { until: f64 },
    BadPin { remaining: u32 },
    SecondFactorRequired,
    HardLocked,
    NotLocked,
    NoSession,
}

impl Refusal {
    /// Stable error text for the webview (prefix = machine code).
    pub fn message(&self) -> String {
        match self {
            Self::LockedOut { until } => format!("LOCKED_OUT:{until:.0}: too many wrong PINs; try again later"),
            Self::BadPin { remaining } => format!("BAD_PIN:{remaining}: wrong PIN ({remaining} attempt(s) left before the lockout)"),
            Self::SecondFactorRequired => "SECOND_FACTOR_REQUIRED: confirm with biometrics or the companion phone first, then the PIN".into(),
            Self::HardLocked => "HARD_LOCKED: the remote failsafe locked this app; release it with `gabagool-cli clear-lock`".into(),
            Self::NotLocked => "NOT_LOCKED: the session is already unlocked".into(),
            Self::NoSession => "LOCKED: unlock the app first".into(),
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Unlocked {
    pub resumed: bool,
    pub fallback: bool,
    pub second: Option<Factor>,
}

#[derive(Debug, PartialEq)]
pub enum BioOutcome {
    Unlocked,
    SecondNoted,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElevationView {
    pub module: String,
    pub expires_at: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub locked: bool,
    pub reason: Option<LockReason>,
    pub session_id: Option<String>,
    pub verified_at: Option<f64>,
    pub reauth_at: Option<f64>,
    pub idle_at: Option<f64>,
    pub needs_second_factor: bool,
    pub second_factor: Option<Factor>,
    pub failures: u32,
    pub lockout_until: Option<f64>,
    pub elevations: Vec<ElevationView>,
}

#[derive(Debug)]
pub struct Sessions {
    live: Option<Live>,
    reason: LockReason,
    resuming: Option<String>,
    second: Option<(Factor, f64)>,
    failures: u32,
    lockout_until: f64,
    /// Modules whose elevation lapsed in `tick` (for the audit), drained by `take_expired`.
    expired: Vec<String>,
}

impl Default for Sessions {
    fn default() -> Self {
        Self { live: None, reason: LockReason::Startup, resuming: None, second: None, failures: 0, lockout_until: 0.0, expired: vec![] }
    }
}

impl Sessions {
    pub fn is_live(&self) -> bool {
        self.live.is_some()
    }

    /// Why it's locked (None while live).
    pub fn reason(&self) -> Option<LockReason> {
        (!self.is_live()).then_some(self.reason)
    }

    pub fn session_id(&self) -> Option<&str> {
        self.live.as_ref().map(|l| l.id.as_str())
    }

    fn needs_second(&self, p: &Policy) -> bool {
        match self.reason {
            LockReason::Startup => p.entry_second,
            LockReason::HardLock => true,
            _ => p.resume_double,
        }
    }

    fn second_fresh(&self, now: f64) -> Option<Factor> {
        self.second.filter(|(_, at)| now - at <= SECOND_FACTOR_TTL).map(|(f, _)| f)
    }

    fn suspend(&mut self, r: LockReason) {
        if let Some(l) = self.live.take() {
            self.resuming = Some(l.id);
        }
        self.reason = r;
        self.second = None;
    }

    /// Expire elevations and auto-lock; returns the new lock reason when the session just locked.
    pub fn tick(&mut self, p: &Policy, now: f64) -> Option<LockReason> {
        let l = self.live.as_mut()?;
        let expired = &mut self.expired;
        l.elevations.retain(|m, e| {
            let keep = now - e.used < p.elev_idle_s && now - e.granted < p.elev_max_s;
            if !keep {
                expired.push(m.clone());
            }
            keep
        });
        let r = if now - l.verified >= p.reauth_s {
            Some(LockReason::Reauth)
        } else if now - l.activity >= p.idle_s {
            Some(LockReason::Idle)
        } else {
            None
        };
        if let Some(r) = r {
            self.suspend(r);
        }
        r
    }

    /// User input (the caller ticks first, so an expired session stays locked).
    pub fn touch(&mut self, now: f64) {
        if let Some(l) = self.live.as_mut() {
            l.activity = now;
        }
    }

    /// Manual / revocation lock; true when a live session was locked. Never downgrades a hard lock.
    pub fn lock(&mut self, r: LockReason) -> bool {
        if self.reason == LockReason::HardLock && !self.is_live() {
            return false;
        }
        let was = self.is_live();
        self.suspend(r);
        was
    }

    pub fn hard_lock(&mut self) {
        self.live = None;
        self.resuming = None;
        self.second = None;
        self.reason = LockReason::HardLock;
    }

    /// The CLI released the hard lock: stay locked, now as `Revoked` (double verification).
    pub fn release_hard_lock(&mut self) {
        if self.reason == LockReason::HardLock {
            self.reason = LockReason::Revoked;
        }
    }

    pub fn is_hard_locked(&self) -> bool {
        self.reason == LockReason::HardLock && !self.is_live()
    }

    pub fn check_lockout(&self, now: f64) -> Result<(), Refusal> {
        if now < self.lockout_until {
            return Err(Refusal::LockedOut { until: self.lockout_until });
        }
        Ok(())
    }

    /// Count one PIN check (shared by unlock and step-up).
    fn pin_attempt(&mut self, ok: bool, p: &Policy, now: f64) -> Result<(), Refusal> {
        self.check_lockout(now)?;
        if ok {
            self.failures = 0;
            return Ok(());
        }
        self.failures += 1;
        if self.failures >= p.max_attempts {
            self.failures = 0;
            self.lockout_until = now + p.lockout_s;
            return Err(Refusal::LockedOut { until: self.lockout_until });
        }
        Err(Refusal::BadPin { remaining: p.max_attempts - self.failures })
    }

    fn open(&mut self, now: f64, new_id: String) -> bool {
        let resumed = self.resuming.is_some();
        let id = self.resuming.take().unwrap_or(new_id);
        self.live = Some(Live { id, verified: now, activity: now, elevations: BTreeMap::new() });
        self.second = None;
        resumed
    }

    /// A verified biometric / companion approval while locked: unlocks a cold start on its own
    /// (when the config allows), otherwise it is held as the second factor for the PIN.
    pub fn second_factor(&mut self, f: Factor, p: &Policy, now: f64, new_id: String) -> Result<BioOutcome, Refusal> {
        if self.is_hard_locked() {
            return Err(Refusal::HardLocked);
        }
        if self.is_live() {
            return Err(Refusal::NotLocked);
        }
        self.check_lockout(now)?;
        if f == Factor::Biometric && self.reason == LockReason::Startup && !p.entry_second {
            self.failures = 0;
            self.open(now, new_id);
            return Ok(BioOutcome::Unlocked);
        }
        self.second = Some((f, now));
        Ok(BioOutcome::SecondNoted)
    }

    /// Unlock with the PIN (`ok` = it verified). `second_available` = a second factor could be
    /// used right now (for the offline fallback).
    pub fn unlock_pin(&mut self, ok: bool, second_available: bool, p: &Policy, now: f64, new_id: String) -> Result<Unlocked, Refusal> {
        if self.is_hard_locked() {
            return Err(Refusal::HardLocked);
        }
        if self.is_live() {
            return Err(Refusal::NotLocked);
        }
        self.pin_attempt(ok, p, now)?;
        let second = self.second_fresh(now);
        let mut fallback = false;
        if self.needs_second(p) && second.is_none() {
            if !second_available && p.pin_fallback {
                fallback = true;
            } else {
                return Err(Refusal::SecondFactorRequired);
            }
        }
        let resumed = self.open(now, new_id);
        Ok(Unlocked { resumed, fallback, second })
    }

    /// Step-up for `module` (`ok` = the PIN verified); returns when the elevation expires.
    pub fn elevate(&mut self, module: &str, ok: bool, p: &Policy, now: f64) -> Result<f64, Refusal> {
        if !self.is_live() {
            return Err(Refusal::NoSession);
        }
        self.pin_attempt(ok, p, now)?;
        let l = self.live.as_mut().ok_or(Refusal::NoSession)?;
        l.elevations.insert(module.to_string(), Elev { granted: now, used: now });
        l.activity = now;
        Ok(now + p.elev_idle_s.min(p.elev_max_s))
    }

    /// Step-up approved by the paired phone (its own biometric; signature checked by the caller):
    /// no PIN attempt is spent.
    pub fn elevate_companion(&mut self, module: &str, p: &Policy, now: f64) -> Result<f64, Refusal> {
        if self.is_hard_locked() {
            return Err(Refusal::HardLocked);
        }
        let l = self.live.as_mut().ok_or(Refusal::NoSession)?;
        l.elevations.insert(module.to_string(), Elev { granted: now, used: now });
        l.activity = now;
        Ok(now + p.elev_idle_s.min(p.elev_max_s))
    }

    fn expiry(e: &Elev, p: &Policy) -> f64 {
        (e.used + p.elev_idle_s).min(e.granted + p.elev_max_s)
    }

    /// Use a live elevation (refreshes its idle timer); None when there is none.
    pub fn use_elevation(&mut self, module: &str, p: &Policy, now: f64) -> Option<f64> {
        let l = self.live.as_mut()?;
        let e = l.elevations.get_mut(module)?;
        if now >= Self::expiry(e, p) {
            l.elevations.remove(module);
            return None;
        }
        e.used = now;
        Some(Self::expiry(e, p))
    }

    /// Elevations that lapsed since the last call.
    pub fn take_expired(&mut self) -> Vec<String> {
        std::mem::take(&mut self.expired)
    }

    pub fn drop_elevation(&mut self, module: &str) -> bool {
        self.live.as_mut().is_some_and(|l| l.elevations.remove(module).is_some())
    }

    pub fn view(&self, p: &Policy, now: f64) -> SessionView {
        let l = self.live.as_ref();
        SessionView {
            locked: l.is_none(),
            reason: self.reason(),
            session_id: l.map(|l| l.id.clone()),
            verified_at: l.map(|l| l.verified),
            reauth_at: l.map(|l| l.verified + p.reauth_s),
            idle_at: l.map(|l| l.activity + p.idle_s),
            needs_second_factor: l.is_none() && self.needs_second(p) && self.second_fresh(now).is_none(),
            second_factor: self.second_fresh(now),
            failures: self.failures,
            lockout_until: (now < self.lockout_until).then_some(self.lockout_until),
            elevations: l.map(|l| l.elevations.iter().map(|(m, e)| ElevationView { module: m.clone(), expires_at: Self::expiry(e, p) }).collect()).unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pol() -> Policy {
        Policy::from_config(&SecurityConfig::default())
    }

    fn unlocked(at: f64) -> Sessions {
        let mut s = Sessions::default();
        s.unlock_pin(true, true, &pol(), at, "s1".into()).unwrap();
        s
    }

    #[test]
    fn cold_start_pin_or_biometric_alone() {
        let p = pol();
        let mut s = Sessions::default();
        assert_eq!(s.reason(), Some(LockReason::Startup));
        assert_eq!(s.unlock_pin(true, true, &p, 0.0, "a".into()).unwrap(), Unlocked { resumed: false, fallback: false, second: None });
        assert!(s.is_live());
        let mut s = Sessions::default();
        assert_eq!(s.second_factor(Factor::Biometric, &p, 0.0, "b".into()).unwrap(), BioOutcome::Unlocked);
        // Companion alone is never enough: it's held for the PIN.
        let mut s = Sessions::default();
        assert_eq!(s.second_factor(Factor::Companion, &p, 0.0, "c".into()).unwrap(), BioOutcome::SecondNoted);
        assert!(!s.is_live());
    }

    #[test]
    fn idle_and_hourly_locks_need_double_verification() {
        let p = pol();
        let mut s = unlocked(0.0);
        assert_eq!(s.tick(&p, 14.0 * 60.0), None);
        s.touch(14.0 * 60.0);
        assert_eq!(s.tick(&p, 28.0 * 60.0), None, "activity at 14 min keeps it open");
        assert_eq!(s.tick(&p, 29.5 * 60.0), Some(LockReason::Idle));
        // PIN alone is refused while a second factor is reachable…
        assert_eq!(s.unlock_pin(true, true, &p, 1800.0, "x".into()).unwrap_err(), Refusal::SecondFactorRequired);
        // …biometric + PIN resumes the same session.
        assert_eq!(s.second_factor(Factor::Biometric, &p, 1801.0, "x".into()).unwrap(), BioOutcome::SecondNoted);
        let u = s.unlock_pin(true, true, &p, 1802.0, "x".into()).unwrap();
        assert_eq!(u, Unlocked { resumed: true, fallback: false, second: Some(Factor::Biometric) });
        assert_eq!(s.session_id(), Some("s1"));
        // Hourly: activity can't stop the hard re-verification window.
        for m in (31..=100).step_by(5) {
            s.touch(m as f64 * 60.0);
            if let Some(r) = s.tick(&p, m as f64 * 60.0 + 1.0) {
                assert_eq!(r, LockReason::Reauth);
                assert!(m as f64 * 60.0 + 1.0 >= 1802.0 + 3600.0);
                return;
            }
        }
        panic!("the 60-minute re-verification never fired");
    }

    #[test]
    fn stale_second_factor_and_offline_fallback() {
        let p = pol();
        let mut s = unlocked(0.0);
        s.lock(LockReason::Manual);
        s.second_factor(Factor::Companion, &p, 10.0, "x".into()).unwrap();
        assert_eq!(s.unlock_pin(true, true, &p, 10.0 + SECOND_FACTOR_TTL + 1.0, "x".into()).unwrap_err(), Refusal::SecondFactorRequired);
        let u = s.unlock_pin(true, false, &p, 200.0, "x".into()).unwrap();
        assert!(u.fallback && u.resumed);
        let strict = Policy { pin_fallback: false, ..pol() };
        let mut s = unlocked(0.0);
        s.lock(LockReason::Manual);
        assert_eq!(s.unlock_pin(true, false, &strict, 5.0, "x".into()).unwrap_err(), Refusal::SecondFactorRequired);
    }

    #[test]
    fn wrong_pins_lock_out_across_unlock_and_step_up() {
        let p = pol();
        let mut s = Sessions::default();
        for left in (1..p.max_attempts).rev() {
            assert_eq!(s.unlock_pin(false, true, &p, 1.0, "x".into()).unwrap_err(), Refusal::BadPin { remaining: left });
        }
        let until = 1.0 + p.lockout_s;
        assert_eq!(s.unlock_pin(false, true, &p, 1.0, "x".into()).unwrap_err(), Refusal::LockedOut { until });
        assert_eq!(s.unlock_pin(true, true, &p, 2.0, "x".into()).unwrap_err(), Refusal::LockedOut { until }, "even the right PIN waits");
        assert!(s.unlock_pin(true, true, &p, until, "x".into()).is_ok());
        assert_eq!(s.elevate("trading", false, &p, until + 1.0).unwrap_err(), Refusal::BadPin { remaining: p.max_attempts - 1 });
    }

    #[test]
    fn elevation_reverts_to_read_only() {
        let p = pol(); // 5 min idle, 10 min max
        let mut s = unlocked(0.0);
        assert_eq!(s.use_elevation("trading", &p, 1.0), None, "read-only by default");
        assert_eq!(s.elevate("trading", true, &p, 10.0).unwrap(), 310.0);
        assert!(s.use_elevation("trading", &p, 250.0).is_some());
        assert!(s.use_elevation("trading", &p, 500.0).is_some(), "idle timer restarts on use");
        assert_eq!(s.use_elevation("trading", &p, 609.0), Some(610.0), "max lifetime caps it");
        assert_eq!(s.use_elevation("trading", &p, 611.0), None);
        assert_eq!(s.use_elevation("finance", &p, 20.0), None, "per module");
        s.elevate("settings", true, &p, 700.0).unwrap();
        s.touch(700.0);
        assert_eq!(s.tick(&p, 1001.0), None);
        assert!(s.view(&p, 1001.0).elevations.is_empty(), "5 min unused → dropped");
        assert_eq!(s.take_expired(), vec!["settings".to_string()]);
        assert!(s.take_expired().is_empty());
        s.elevate("settings", true, &p, 1001.0).unwrap();
        s.lock(LockReason::Manual);
        s.second_factor(Factor::Biometric, &p, 1002.0, "x".into()).unwrap();
        s.unlock_pin(true, true, &p, 1003.0, "x".into()).unwrap();
        assert_eq!(s.use_elevation("settings", &p, 1004.0), None, "a lock drops every elevation");
    }

    #[test]
    fn hard_lock_cannot_be_unlocked_in_app() {
        let p = pol();
        let mut s = unlocked(0.0);
        s.hard_lock();
        assert_eq!(s.unlock_pin(true, false, &p, 1.0, "x".into()).unwrap_err(), Refusal::HardLocked);
        assert_eq!(s.second_factor(Factor::Biometric, &p, 1.0, "x".into()).unwrap_err(), Refusal::HardLocked);
        assert!(!s.lock(LockReason::Idle), "a lock never downgrades the hard lock");
        assert!(s.is_hard_locked());
        s.release_hard_lock();
        assert_eq!(s.reason(), Some(LockReason::Revoked));
        assert_eq!(s.unlock_pin(true, true, &p, 2.0, "x".into()).unwrap_err(), Refusal::SecondFactorRequired);
        let v = s.view(&p, 2.0);
        assert!(v.locked && v.needs_second_factor && v.session_id.is_none());
    }

    #[test]
    fn phone_step_up_needs_a_live_session_and_spends_no_pin_attempt() {
        let p = pol();
        let mut locked = Sessions::default();
        assert_eq!(locked.elevate_companion("trading", &p, 1.0).unwrap_err(), Refusal::NoSession);
        let mut s = unlocked(0.0);
        assert_eq!(s.elevate_companion("trading", &p, 10.0).unwrap(), 310.0);
        assert!(s.use_elevation("trading", &p, 20.0).is_some());
        assert_eq!(s.use_elevation("finance", &p, 20.0), None, "only the approved module");
        s.hard_lock();
        assert_eq!(s.elevate_companion("trading", &p, 30.0).unwrap_err(), Refusal::HardLocked);
    }
}
