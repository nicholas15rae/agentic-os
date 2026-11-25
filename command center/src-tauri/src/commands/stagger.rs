//! Daemon staggering: Observer, Security and Garbage never start a pass within
//! `roster.daemonGapSeconds` of each other, and Garbage's hygiene pass (graduation, compression,
//! purges) holds during US market hours (`roster.marketHoursHold`, `roster.marketHours`, New York
//! time, Mon–Fri; exchange holidays are not modelled).
//!
//! A daemon that is turned away is not lost: it stays due and asks again on its next tick.
//! Every decision (ran / deferred + why) lands in a small ring that the diagnostic reports carry
//! (`daemonSchedule`), so the effect is visible on disk.

use chrono::{Datelike, Duration as CDuration, NaiveDate, TimeZone, Timelike, Utc, Weekday};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

pub const DAEMONS: [&str; 3] = ["observer", "security", "garbage"];

/// The daemon gap in force (`orchestrator_policy.json` → `tradingHours.daemonGapSeconds`, hot).
pub fn gap_seconds() -> u32 {
    super::policy::current().trading_hours.daemon_gap_seconds
}

/// Should Garbage's scheduled hygiene pass hold right now? Some(reason) when it should (policy, hot).
pub fn garbage_hold_reason(now_ms: u64) -> Option<String> {
    let p = super::policy::current();
    (p.trading_hours.hold_garbage_hygiene && p.in_trading_hours(now_ms)).then(|| format!("trading hours {} New York", p.trading_hours.window))
}
const LOG_MAX: usize = 60;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub at: u64,
    pub job: String,
    pub ran: bool,
    /// Why it was deferred (None when it ran).
    pub reason: Option<String>,
}

#[derive(Default)]
struct State {
    last_start: Option<(String, u64)>,
    log: VecDeque<Decision>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// May `job` start now (pure)? `busy`: another daemon is mid-pass. `gap_ms`: spacing between starts.
pub fn decide(job: &str, now: u64, last_start: Option<(&str, u64)>, busy: Option<&str>, gap_ms: u64) -> Result<(), String> {
    if let Some(other) = busy.filter(|b| *b != job) {
        return Err(format!("{other} is mid-pass"));
    }
    match last_start {
        Some((other, at)) if other != job && now.saturating_sub(at) < gap_ms => Err(format!("{other} started {}s ago (gap {}s)", now.saturating_sub(at) / 1000, gap_ms / 1000)),
        _ => Ok(()),
    }
}

fn record(job: &str, now: u64, r: &Result<(), String>) {
    let mut s = state().lock().unwrap();
    if r.is_ok() {
        s.last_start = Some((job.to_string(), now));
    }
    s.log.push_back(Decision { at: now, job: job.into(), ran: r.is_ok(), reason: r.as_ref().err().cloned() });
    while s.log.len() > LOG_MAX {
        s.log.pop_front();
    }
}

/// Which daemon (other than `job`) is running a pass right now, from the arbiter's live node view.
fn busy_daemon(job: &str) -> Option<String> {
    super::arbiter::get().nodes().into_iter().find(|n| n["state"] == "ACTIVE" && n["id"].as_str().is_some_and(|id| id != job && DAEMONS.contains(&id))).and_then(|n| n["id"].as_str().map(str::to_string))
}

/// Ask for a start slot for `job` (records the decision). `Ok`: start now.
pub fn claim(job: &str, gap_seconds: u32) -> Result<(), String> {
    let now = super::arbiter::now_ms();
    let busy = busy_daemon(job);
    let last = state().lock().unwrap().last_start.clone();
    let r = decide(job, now, last.as_ref().map(|(j, t)| (j.as_str(), *t)), busy.as_deref(), gap_seconds as u64 * 1000);
    record(job, now, &r);
    r
}

/// Log a deferral decided elsewhere (Garbage's market-hours hold).
pub fn note_deferred(job: &str, reason: &str) {
    record(job, super::arbiter::now_ms(), &Err(reason.to_string()));
}

/// Recent decisions, oldest first.
pub fn recent() -> Vec<Decision> {
    state().lock().unwrap().log.iter().cloned().collect()
}

// ── US market hours (America/New_York, computed without a tz database) ──────

fn nth_sunday(year: i32, month: u32, n: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid date");
    let to_sun = (7 - first.weekday().num_days_from_sunday()) % 7;
    first + CDuration::days((to_sun + 7 * (n - 1)) as i64)
}

/// New York's UTC offset in hours at `utc_ms` (-4 during US DST, else -5). DST runs from the second
/// Sunday of March 02:00 EST (07:00 UTC) to the first Sunday of November 02:00 EDT (06:00 UTC).
pub fn ny_offset_hours(utc_ms: u64) -> i64 {
    let t = Utc.timestamp_millis_opt(utc_ms as i64).single().unwrap_or_else(Utc::now);
    let y = t.year();
    let start = nth_sunday(y, 3, 2).and_hms_opt(7, 0, 0).unwrap().and_utc();
    let end = nth_sunday(y, 11, 1).and_hms_opt(6, 0, 0).unwrap().and_utc();
    if t >= start && t < end {
        -4
    } else {
        -5
    }
}

/// "09:30-16:00" → (570, 960) minutes after midnight (pure).
pub fn parse_window(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.trim().split_once('-')?;
    let m = |x: &str| -> Option<u32> {
        let (h, mi) = x.trim().split_once(':')?;
        let (h, mi): (u32, u32) = (h.parse().ok()?, mi.parse().ok()?);
        (h < 24 && mi < 60).then_some(h * 60 + mi)
    };
    let (lo, hi) = (m(a)?, m(b)?);
    (lo < hi).then_some((lo, hi))
}

fn ny_time(utc_ms: u64) -> chrono::DateTime<Utc> {
    Utc.timestamp_millis_opt(utc_ms as i64).single().unwrap_or_else(Utc::now) + CDuration::hours(ny_offset_hours(utc_ms))
}

/// Is `utc_ms` inside the New York window on ANY day (pure)? A bad window = never.
pub fn in_window_any_day(utc_ms: u64, window: &str) -> bool {
    let Some((lo, hi)) = parse_window(window) else { return false };
    let ny = ny_time(utc_ms);
    (lo..hi).contains(&(ny.hour() * 60 + ny.minute()))
}

/// Is `utc_ms` inside the New York trading window on a weekday (pure)? A bad window = never.
pub fn in_market_hours(utc_ms: u64, window: &str) -> bool {
    !matches!(ny_time(utc_ms).weekday(), Weekday::Sat | Weekday::Sun) && in_window_any_day(utc_ms, window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> u64 {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis() as u64
    }

    #[test]
    fn gap_and_busy_rules() {
        assert!(decide("security", 100_000, None, None, 90_000).is_ok());
        assert!(decide("security", 100_000, Some(("garbage", 50_000)), None, 90_000).is_err());
        assert!(decide("security", 200_000, Some(("garbage", 50_000)), None, 90_000).is_ok());
        // Its own last start never blocks it (its own interval governs that).
        assert!(decide("security", 100_000, Some(("security", 99_000)), None, 90_000).is_ok());
        assert!(decide("observer", 900_000, None, Some("garbage"), 90_000).unwrap_err().contains("garbage is mid-pass"));
        assert!(decide("observer", 900_000, None, Some("observer"), 90_000).is_ok());
    }

    #[test]
    fn new_york_dst_edges() {
        // 2026: DST from Sun 8 Mar to Sun 1 Nov.
        assert_eq!(nth_sunday(2026, 3, 2), NaiveDate::from_ymd_opt(2026, 3, 8).unwrap());
        assert_eq!(nth_sunday(2026, 11, 1), NaiveDate::from_ymd_opt(2026, 11, 1).unwrap());
        assert_eq!(ny_offset_hours(utc(2026, 3, 8, 6, 59)), -5);
        assert_eq!(ny_offset_hours(utc(2026, 3, 8, 7, 0)), -4);
        assert_eq!(ny_offset_hours(utc(2026, 11, 1, 5, 59)), -4);
        assert_eq!(ny_offset_hours(utc(2026, 11, 1, 6, 0)), -5);
    }

    #[test]
    fn market_window() {
        let w = "09:30-16:00";
        // Tue 24 Nov 2026 (EST, UTC-5): 09:29 / 09:30 / 15:59 / 16:00 New York.
        assert!(!in_market_hours(utc(2026, 11, 24, 14, 29), w));
        assert!(in_market_hours(utc(2026, 11, 24, 14, 30), w));
        assert!(in_market_hours(utc(2026, 11, 24, 20, 59), w));
        assert!(!in_market_hours(utc(2026, 11, 24, 21, 0), w));
        // Summer (EDT, UTC-4): 10:00 New York = 14:00 UTC.
        assert!(in_market_hours(utc(2026, 7, 15, 14, 0), w));
        // Saturday.
        assert!(!in_market_hours(utc(2026, 11, 28, 15, 0), w));
        assert!(!in_market_hours(utc(2026, 11, 24, 15, 0), "bad"));
        assert_eq!(parse_window(" 9:30 - 16:00 "), Some((570, 960)));
        assert_eq!(parse_window("16:00-09:30"), None);
    }
}
