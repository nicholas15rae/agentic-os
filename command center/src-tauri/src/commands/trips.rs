//! Maps trips: the calendar's next 48 h as journeys (decision 43). A trip is a timed event in the
//! horizon with a physical location; it is sorted into audition / booking / job / other by
//! keyword lists the user can edit (`maps-trip-words.json`). Virtual meetings (Zoom, Meet, Teams,
//! a link, "Online", "Self-tape") are listed as virtual and never geocoded or routed.
//!
//! For each trip: the address is geocoded once (Canada-biased near the start point; a match more
//! than 150 km away is "unresolved"; a 30-day disk cache, so a restart doesn't re-geocode), routed
//! from the start point WITHOUT touching the map widget's route (`maps::route_quiet`), and given
//! "leave by" = start − ETA − a 15 min buffer (decision 45), rounded down to the minute. One bad
//! address or route only marks that trip; the view never fails as a whole.
//!
//! Start point (desktop): `MAP_HOME` (env / repo .env), else a device fix under 500 m accuracy
//! (at most 30 min old, handed in by the widget), else the weather location the widget hands in,
//! else Toronto city centre. The source is always reported.
//!
//! Gates: the calendar read is `calendar::fetch_events` (kill switch, MCP permission, Calendar
//! on, modes freeze). Every geocode / route call is behind `maps_gate` (kill switch, MCP
//! permission, Maps on, modes freeze), and the kill switch is re-checked before each call, so
//! flipping it mid-refresh stops the next one. Nobody approves a background read, so an Ask tier
//! refuses it; the publisher then backs off to 30 min (each refusal writes a permission line).
//!
//! Publisher (desktop only, spawned in lib.rs): every ~10 min it recomputes and PUTs the
//! snapshot to the loopback gateway (`PUT /api/maps/trips`; the gateway keeps it under
//! `data/command-center/`, git-ignored, writes from the PC only). Each minute it also asks
//! `GET /api/maps/refresh` (`{pending: bool}`) whether the phone requested a refresh; the next
//! PUT clears that request. Background reads never run the AnythingLLM credential import.
//!
//! Untrusted text: event titles, locations and descriptions can come from third-party invites.
//! They are display-only: never handed to an agent, never followed, never logged. The
//! description is read only by the keyword classifier and is not in the view.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

use super::bridge::BridgeState;
use super::calendar::{self, CalEvent};
use super::dispatch::DispatchState;
use super::maps::{self, Place, Route};
use super::os_core::{self, OsState};

/// Default horizon (decision 43) and the longest the command accepts.
pub(crate) const HORIZON_H: u32 = 48;
const HORIZON_MAX_H: u32 = 168;
/// Default leave-by buffer (decision 45) and the largest the command accepts.
pub(crate) const BUFFER_MIN: u32 = 15;
const BUFFER_MAX_MIN: u32 = 120;
pub(crate) const MAX_TRIPS: usize = 8;
/// An event that started this recently is still listed (running late).
const STARTED_GRACE_MS: i64 = 30 * 60_000;
const DEVICE_MAX_ACCURACY_M: f64 = 500.0;
const DEVICE_MAX_AGE_MS: i64 = 30 * 60_000;
/// The name the maps permission gate logs (never any event text).
pub(crate) const TRIPS_TOOL: &str = "maps.trips";
pub(crate) const MAPS_KILLED: &str = "kill switch is on — maps use online OpenStreetMap services";
pub(crate) const MAPS_OFF: &str = "Maps tools are switched off — enable Maps in Settings → Skills & MCP Library";
/// `maps_trips` on the phone: it reads the desktop's snapshot from the gateway instead.
pub(crate) const PHONE_USE_GATEWAY: &str = "PHONE_USE_GATEWAY";
const IDLE: &str = "no trip needs a map lookup";
pub(crate) const WORDS_FILE: &str = "maps-trip-words.json";
const WORDS_PER_KIND: usize = 30;
const WORD_MAX: usize = 40;
const WEATHER_LABEL_MAX: usize = 120;
pub(crate) const SNAPSHOT_PATH: &str = "/api/maps/trips";
pub(crate) const REFRESH_PATH: &str = "/api/maps/refresh";
pub(crate) const REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);
/// While the MCP permission tier refuses background reads.
pub(crate) const BACKOFF_EVERY: Duration = Duration::from_secs(30 * 60);
const TICK: Duration = Duration::from_secs(60);
const START_DELAY: Duration = Duration::from_secs(90);
/// A phone refresh request never recomputes more often than this.
const ASK_MIN_GAP: Duration = Duration::from_secs(60);
/// The command answers from the last view this young unless forced.
const CACHED_VIEW_FOR: Duration = Duration::from_secs(120);

// ── Types (the TripsView contract, camelCase) ──────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TripKind {
    Audition,
    Booking,
    Job,
    Other,
}

/// The editable keyword lists, matched as whole words (a trailing "s" allowed), case-insensitive.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KindWords {
    #[serde(default)]
    pub audition: Vec<String>,
    #[serde(default)]
    pub booking: Vec<String>,
    #[serde(default)]
    pub job: Vec<String>,
}

impl Default for KindWords {
    fn default() -> Self {
        let v = |w: &[&str]| w.iter().map(|s| s.to_string()).collect();
        Self {
            audition: v(&["audition", "callback", "self-tape", "casting", "chemistry read"]),
            booking: v(&["booking", "shoot", "set", "call time", "fitting", "wardrobe", "rehearsal"]),
            job: v(&["job", "site", "estimate", "install", "reno", "walkthrough"]),
        }
    }
}

fn clean_word(w: &str) -> Option<String> {
    let w: String = w.chars().filter(|c| !c.is_control()).collect();
    let w = w.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    (!w.is_empty() && w.chars().count() <= WORD_MAX && w.chars().any(char::is_alphanumeric)).then_some(w)
}

impl KindWords {
    /// Lower-cased, spaces collapsed, control characters out, no duplicates, at most
    /// `WORDS_PER_KIND` per list of at most `WORD_MAX` characters each. Pure.
    pub(crate) fn sanitized(&self) -> Self {
        let list = |l: &[String]| {
            let mut out: Vec<String> = Vec::new();
            for w in l.iter().filter_map(|w| clean_word(w)) {
                if out.len() == WORDS_PER_KIND {
                    break;
                }
                if !out.contains(&w) {
                    out.push(w);
                }
            }
            out
        };
        Self { audition: list(&self.audition), booking: list(&self.booking), job: list(&self.job) }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripEvent {
    /// The calendar id, else "h:" + a hash of title and start (`CalEvent::key`).
    pub id: String,
    pub title: String,
    pub kind: TripKind,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub location_text: String,
    pub source: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripEta {
    pub duration_s: f64,
    pub distance_m: f64,
    /// Always false until a traffic provider is chosen (decision 39: none).
    pub traffic_aware: bool,
    pub typical_duration_s: Option<f64>,
    pub traffic_delay_s: Option<f64>,
    pub provider: String,
    pub computed_at_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trip {
    pub event: TripEvent,
    /// The resolved place; its label is the geocoder's full address, so a wrong pin is visible.
    pub place: Option<Place>,
    /// "resolved" | "virtual" | "unresolved"
    pub place_status: &'static str,
    pub eta: Option<TripEta>,
    pub leave_by_ms: Option<i64>,
    pub open_in_maps: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripOrigin {
    pub lat: f64,
    pub lng: f64,
    pub label: String,
    /// "home" | "device" | "weather" | "default"
    pub source: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripsView {
    pub trips: Vec<Trip>,
    pub origin: TripOrigin,
    pub horizon_hours: u32,
    pub buffer_min: u32,
    pub fetched_at_ms: i64,
    /// "ok" | "no-backend" | "off" | "frozen" | "blocked" | "error" (`calendar::read_state`)
    pub calendar: &'static str,
    /// Why a part is missing (refusals, MAP_HOME not found); empty when all is well.
    pub detail: String,
    /// "ok" | "idle" (nothing to look up) | "blocked" | "off" | "frozen" | "error"
    pub maps: &'static str,
    pub traffic_provider: Option<String>,
}

/// A device fix the widget hands in (navigator.geolocation); `at_ms` is stamped on receipt.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFix {
    pub lat: f64,
    pub lng: f64,
    pub accuracy_m: f64,
    #[serde(default)]
    pub at_ms: i64,
}

/// The weather location the widget hands in (settings.weatherLocation: `{lat, lon, label}`).
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct WeatherSpot {
    pub lat: f64,
    #[serde(alias = "lon")]
    pub lng: f64,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Params {
    pub now_ms: i64,
    pub horizon_h: u32,
    pub buffer_min: u32,
    pub words: KindWords,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct OriginInputs {
    /// `MAP_HOME` as written (an address or "lat,lng").
    pub home: Option<String>,
    /// `MAP_HOME`'s geocode from the disk cache (no network).
    pub home_cached: Option<Place>,
    pub device: Option<DeviceFix>,
    pub weather: Option<WeatherSpot>,
}

// ── Pure pieces ─────────────────────────────────────────────────────────────

/// " lower case words " with every non-alphanumeric run as one space, padded. Pure.
fn words_of(s: &str) -> String {
    let mut out = String::from(" ");
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out
}

/// Is `word` (one or more words) in the padded `hay`, also as a plural? Pure.
fn has_word(hay: &str, word: &str) -> bool {
    let w = words_of(word);
    if w.trim().is_empty() {
        return false;
    }
    hay.contains(&w) || hay.contains(&format!("{}s ", w.trim_end()))
}

/// The trip's kind: the title decides first (audition, then booking, then job), then the
/// description; else Other. Pure.
pub(crate) fn classify(title: &str, desc: &str, words: &KindWords) -> TripKind {
    let kinds = [(TripKind::Audition, &words.audition), (TripKind::Booking, &words.booking), (TripKind::Job, &words.job)];
    for text in [title, desc] {
        let hay = words_of(text);
        if let Some((k, _)) = kinds.iter().find(|(_, l)| l.iter().any(|w| has_word(&hay, w))) {
            return *k;
        }
    }
    TripKind::Other
}

const MEETING_HOSTS: [&str; 9] = ["zoom.us", "zoom.com", "meet.google.com", "teams.microsoft.com", "teams.live.com", "webex.com", "whereby.com", "gotomeeting.com", "skype.com"];
const VIRTUAL_WORDS: [&str; 17] = [
    "zoom", "google meet", "microsoft teams", "ms teams", "teams meeting", "webex", "skype", "facetime", "whereby", "online", "virtual", "remote", "self tape", "selftape", "video call", "phone call", "conference call",
];
const PLACEHOLDERS: [&str; 9] = ["tbd", "tba", "tbc", "to be determined", "to be confirmed", "to be announced", "see description", "n a", "none"];

/// "100 queen st" — a short number followed by a word. Pure.
fn has_street_number(w: &str) -> bool {
    let t: Vec<&str> = w.split_whitespace().collect();
    t.windows(2).any(|p| p[0].starts_with(|c: char| c.is_ascii_digit()) && p[0].len() <= 6 && p[1].chars().any(char::is_alphabetic))
}

/// A virtual meeting rather than a place: a meeting-service link, any other link without a
/// street address, or meeting words ("Zoom", "Online", "Self-tape") without a street number
/// ("Zoom Studios, 123 King St W" stays physical). Pure.
pub(crate) fn is_virtual(loc: &str) -> bool {
    let l = loc.to_lowercase();
    if MEETING_HOSTS.iter().any(|h| l.contains(h)) {
        return true;
    }
    let w = words_of(&l);
    let street = has_street_number(&w);
    if (l.contains("://") || l.contains("www.")) && !street {
        return true;
    }
    if matches!(w.trim(), "teams" | "phone" | "meet" | "call") {
        return true;
    }
    VIRTUAL_WORDS.iter().any(|v| has_word(&w, v)) && !street
}

/// "TBD", "N/A", "See description": no location at all. Pure.
pub(crate) fn is_placeholder(loc: &str) -> bool {
    let w = words_of(loc);
    PLACEHOLDERS.contains(&w.trim())
}

/// Leave by = start − ETA − buffer, rounded DOWN to the minute (never late). Pure.
pub(crate) fn leave_by(start_ms: i64, eta_s: f64, buffer_min: u32) -> i64 {
    let eta_ms = if eta_s.is_finite() && eta_s > 0.0 { (eta_s * 1000.0).ceil() as i64 } else { 0 };
    (start_ms - eta_ms - buffer_min as i64 * 60_000).div_euclid(60_000) * 60_000
}

fn toronto_date(ms: i64) -> NaiveDate {
    let utc = chrono::DateTime::from_timestamp_millis(ms).map(|d| d.naive_utc()).unwrap_or_default();
    (utc + chrono::Duration::hours(calendar::toronto_offset_at_utc(utc) as i64)).date()
}

/// The Toronto dates [from, to) the calendar read covers: the grace before now through the
/// horizon's end. Pure.
pub(crate) fn window(now_ms: i64, horizon_h: u32) -> (NaiveDate, NaiveDate) {
    let from = toronto_date(now_ms - STARTED_GRACE_MS);
    let last = toronto_date(now_ms + horizon_h as i64 * 3_600_000);
    (from, last.succ_opt().unwrap_or(last))
}

/// The events that are trips: timed, starting within [now − grace, now + horizon], with a
/// location that isn't a placeholder; by start, at most `MAX_TRIPS`. Pure.
pub(crate) fn candidates<'a>(events: &'a [CalEvent], p: &Params) -> Vec<&'a CalEvent> {
    let end = p.now_ms + p.horizon_h as i64 * 3_600_000;
    let mut v: Vec<&CalEvent> = events
        .iter()
        .filter(|e| !e.all_day && e.start_ms >= p.now_ms - STARTED_GRACE_MS && e.start_ms <= end)
        .filter(|e| e.location.as_deref().is_some_and(|l| !l.trim().is_empty() && !is_placeholder(l)))
        .collect();
    v.sort_by_key(|e| e.start_ms);
    v.truncate(MAX_TRIPS);
    v
}

fn device_ok(d: &DeviceFix, now_ms: i64) -> bool {
    maps::check_coord(d.lat, d.lng).is_ok()
        && d.accuracy_m.is_finite()
        && d.accuracy_m > 0.0
        && d.accuracy_m < DEVICE_MAX_ACCURACY_M
        && d.at_ms <= now_ms + 60_000
        && now_ms - d.at_ms <= DEVICE_MAX_AGE_MS
}

/// Which refusal stopped the map lookups → the view's `maps` state. Pure.
pub(crate) fn maps_state_of(e: &str) -> &'static str {
    if e == MAPS_KILLED || e.starts_with("PERMISSION_") {
        "blocked"
    } else if e == MAPS_OFF {
        "off"
    } else if e.starts_with(super::modes::MODE_FROZEN) {
        "frozen"
    } else {
        "error"
    }
}

/// How long the publisher waits after a view: 30 min while the MCP permission tier refuses
/// background reads, else ~10 min. Pure.
pub(crate) fn next_interval(v: &TripsView) -> Duration {
    if v.calendar == "blocked" && v.detail.starts_with("PERMISSION_") {
        BACKOFF_EVERY
    } else {
        REFRESH_EVERY
    }
}

/// The gateway base for the snapshot: always loopback (the gateway takes trips writes from the
/// PC only), keeping the configured scheme and port. Pure.
pub(crate) fn loopback_base(gateway_url: &str) -> Result<String, String> {
    let mut u = reqwest::Url::parse(gateway_url.trim()).map_err(|_| "the gateway URL is malformed".to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("the gateway URL must be http(s)".into());
    }
    if !matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) {
        u.set_host(Some("127.0.0.1")).map_err(|_| "the gateway URL can't point at loopback".to_string())?;
    }
    u.set_path("");
    u.set_query(None);
    u.set_fragment(None);
    Ok(u.as_str().trim_end_matches('/').to_string())
}

fn push_detail(d: &mut String, s: &str) {
    if !d.is_empty() {
        d.push_str(" · ");
    }
    d.push_str(s);
}

// ── Gates ───────────────────────────────────────────────────────────────────

/// Before any geocode / route call: kill switch, the MCP permission tier (unapproved: an Ask
/// tier refuses), Maps switched on, the modes / switchboard freeze.
pub(crate) fn maps_gate(os: &OsState, bridge: &BridgeState) -> Result<(), String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err(MAPS_KILLED.into());
    }
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", false, json!({ "tool": TRIPS_TOOL }))?;
    if !cfg.mcps.iter().any(|m| m.id == "maps" && m.enabled) {
        return Err(MAPS_OFF.into());
    }
    if let Some(e) = super::modes::tool_frozen_error(&os.modes.effective(), &cfg.switchboard, "maps") {
        return Err(e);
    }
    Ok(())
}

/// The cheap re-check before each call (no log line).
fn kill_check(os: &OsState) -> Result<(), String> {
    if os.snapshot().privacy.kill_switch {
        Err(MAPS_KILLED.into())
    } else {
        Ok(())
    }
}

// ── Assembly (network injected) ─────────────────────────────────────────────

/// The start point: MAP_HOME, a good device fix, the weather location, Toronto. Only an
/// uncached MAP_HOME address reaches `geo`, and only when the maps gate passed.
async fn resolve_origin<A, G, GF>(inp: &OriginInputs, now_ms: i64, net: &Result<(), String>, allowed: &A, geo: &G) -> (TripOrigin, Option<String>)
where
    A: Fn() -> Result<(), String>,
    G: Fn(String, Place) -> GF,
    GF: Future<Output = Result<Vec<Place>, String>>,
{
    let mut note = None;
    if let Some(h) = inp.home.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
        if let Some((lat, lng)) = maps::parse_latlng(h) {
            return (TripOrigin { lat, lng, label: "Home".into(), source: "home" }, None);
        }
        let hit = match (&inp.home_cached, net) {
            (Some(p), _) => Some(p.clone()),
            (None, Ok(())) if allowed().is_ok() => geo(h.to_string(), maps::default_home()).await.ok().and_then(|c| c.into_iter().next()),
            _ => None,
        };
        match hit {
            Some(p) => return (TripOrigin { lat: p.lat, lng: p.lng, label: format!("Home, {}", p.label), source: "home" }, None),
            None if net.is_ok() => note = Some("MAP_HOME in .env couldn't be found on the map"),
            None => note = Some("MAP_HOME wasn't looked up (map lookups are off or not needed)"),
        }
    }
    let note = note.map(String::from);
    if let Some(d) = inp.device.filter(|d| device_ok(d, now_ms)) {
        return (TripOrigin { lat: d.lat, lng: d.lng, label: format!("Current location (±{} m)", d.accuracy_m.round() as i64), source: "device" }, note);
    }
    if let Some(w) = inp.weather.as_ref().filter(|w| maps::check_coord(w.lat, w.lng).is_ok()) {
        let label = if w.label.trim().is_empty() { "Weather location".to_string() } else { w.label.clone() };
        return (TripOrigin { lat: w.lat, lng: w.lng, label, source: "weather" }, note);
    }
    let d = maps::default_home();
    (TripOrigin { lat: d.lat, lng: d.lng, label: d.label, source: "default" }, note)
}

/// The trips for `events` (already `candidates`): virtual ones never reach the network; each
/// distinct address is geocoded once and each distinct place routed once per run; every error
/// stays on its own trip. `allowed` runs before every call.
pub(crate) async fn assemble<A, G, GF, R, RF>(events: &[&CalEvent], origin: &Place, p: &Params, net: &Result<(), String>, allowed: A, geo: &G, route: &R) -> Vec<Trip>
where
    A: Fn() -> Result<(), String>,
    G: Fn(String, Place) -> GF,
    GF: Future<Output = Result<Vec<Place>, String>>,
    R: Fn(Vec<Place>) -> RF,
    RF: Future<Output = Result<Route, String>>,
{
    let mut places: HashMap<String, Result<Place, String>> = HashMap::new();
    let mut routes: HashMap<String, Result<Route, String>> = HashMap::new();
    let mut out = Vec::with_capacity(events.len());
    for e in events {
        let loc = e.location.clone().unwrap_or_default();
        let event = TripEvent {
            id: e.key(),
            title: e.title.clone(),
            kind: classify(&e.title, e.description.as_deref().unwrap_or(""), &p.words),
            start_ms: e.start_ms,
            end_ms: e.end_ms,
            location_text: loc.clone(),
            source: "gcal",
        };
        let mut trip = Trip { event, place: None, place_status: "unresolved", eta: None, leave_by_ms: None, open_in_maps: None, error: None };
        if is_virtual(&loc) {
            trip.place_status = "virtual";
            out.push(trip);
            continue;
        }
        let placed = match net {
            Err(e) => Err(e.clone()),
            Ok(()) => {
                let k = maps::norm_query(&loc);
                match places.get(&k) {
                    Some(r) => r.clone(),
                    None => {
                        let r = match allowed() {
                            Ok(()) => geo(loc.clone(), origin.clone()).await.and_then(|c| maps::pick_near(&c, origin)),
                            Err(e) => Err(e),
                        };
                        places.insert(k, r.clone());
                        r
                    }
                }
            }
        };
        let place = match placed {
            Ok(pl) => pl,
            Err(err) => {
                trip.error = Some(err);
                out.push(trip);
                continue;
            }
        };
        trip.place_status = "resolved";
        trip.open_in_maps = Some(maps::open_in_maps_url(&place, &[]));
        let rk = format!("{:.5},{:.5}", place.lat, place.lng);
        let routed = match routes.get(&rk) {
            Some(r) => r.clone(),
            None => {
                let r = match allowed() {
                    Ok(()) => route(vec![origin.clone(), place.clone()]).await,
                    Err(e) => Err(e),
                };
                routes.insert(rk, r.clone());
                r
            }
        };
        match routed {
            Ok(r) => {
                trip.leave_by_ms = Some(leave_by(e.start_ms, r.duration_s, p.buffer_min));
                trip.eta = Some(TripEta {
                    duration_s: r.duration_s,
                    distance_m: r.distance_m,
                    traffic_aware: r.traffic_aware,
                    typical_duration_s: None,
                    traffic_delay_s: None,
                    provider: r.provider,
                    computed_at_ms: p.now_ms,
                });
            }
            Err(err) => trip.error = Some(err),
        }
        trip.place = Some(place);
        out.push(trip);
    }
    out
}

/// The whole view with every network call injected: `read_cal` is the gated calendar read,
/// `geo` a (cached) biased geocode, `route` the quiet router. The maps gate runs only when some
/// trip needs a lookup.
pub(crate) async fn compute_with<C, CF, G, GF, R, RF>(os: &OsState, bridge: &BridgeState, p: &Params, inp: &OriginInputs, read_cal: C, geo: G, route: R) -> TripsView
where
    C: FnOnce(NaiveDate, NaiveDate) -> CF,
    CF: Future<Output = Result<Vec<CalEvent>, String>>,
    G: Fn(String, Place) -> GF,
    GF: Future<Output = Result<Vec<Place>, String>>,
    R: Fn(Vec<Place>) -> RF,
    RF: Future<Output = Result<Route, String>>,
{
    let (from, to) = window(p.now_ms, p.horizon_h);
    let (cal_state, mut detail, events) = match read_cal(from, to).await {
        Ok(ev) => ("ok", String::new(), ev),
        Err(e) => (calendar::read_state(&e), e, Vec::new()),
    };
    let cands = candidates(&events, p);
    let need_net = cands.iter().any(|e| !is_virtual(e.location.as_deref().unwrap_or("")));
    let net = if need_net { maps_gate(os, bridge) } else { Err(IDLE.to_string()) };
    let maps_state = match &net {
        Ok(()) => "ok",
        Err(_) if !need_net => "idle",
        Err(e) => maps_state_of(e),
    };
    let allowed = || kill_check(os);
    let (origin, note) = resolve_origin(inp, p.now_ms, &net, &allowed, &geo).await;
    let start = Place { lat: origin.lat, lng: origin.lng, label: origin.label.clone() };
    let trips = assemble(&cands, &start, p, &net, allowed, &geo, &route).await;
    if let (Err(e), true) = (&net, need_net) {
        push_detail(&mut detail, e);
    }
    if let Some(n) = note {
        push_detail(&mut detail, &n);
    }
    TripsView {
        trips,
        origin,
        horizon_hours: p.horizon_h,
        buffer_min: p.buffer_min,
        fetched_at_ms: p.now_ms,
        calendar: cal_state,
        detail,
        maps: maps_state,
        traffic_provider: None,
    }
}

// ── Keyword file ────────────────────────────────────────────────────────────

/// `<repo>/data/command-center/maps-trip-words.json`; missing or unreadable → the defaults.
pub(crate) fn load_words(dir: &Path) -> KindWords {
    std::fs::read_to_string(dir.join(WORDS_FILE)).ok().and_then(|s| serde_json::from_str::<KindWords>(&s).ok()).map(|w| w.sanitized()).unwrap_or_default()
}

/// Saves the sanitized lists atomically and returns them.
pub(crate) fn save_words(dir: &Path, w: &KindWords) -> Result<KindWords, String> {
    let w = w.sanitized();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(WORDS_FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&w).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(w)
}

// ── The real path (desktop) ─────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
struct Hints {
    device: Option<DeviceFix>,
    weather: Option<WeatherSpot>,
    horizon_h: Option<u32>,
    buffer_min: Option<u32>,
}

/// What the widget last handed in (memory only, never written to disk).
static HINTS: Mutex<Hints> = Mutex::new(Hints { device: None, weather: None, horizon_h: None, buffer_min: None });
static LAST: Mutex<Option<(Instant, TripsView)>> = Mutex::new(None);
/// One refresh at a time (the command and the publisher share the caches).
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Store the widget's hints; true when the horizon, buffer or weather location changed (the
/// cached view no longer fits). Invalid coordinates are dropped.
fn set_hints(horizon: Option<u32>, buffer: Option<u32>, device: Option<DeviceFix>, weather: Option<WeatherSpot>, now: i64) -> bool {
    let mut h = lock(&HINTS);
    let mut changed = false;
    if let Some(x) = horizon.map(|x| x.clamp(1, HORIZON_MAX_H)) {
        changed |= h.horizon_h.unwrap_or(HORIZON_H) != x;
        h.horizon_h = Some(x);
    }
    if let Some(x) = buffer.map(|x| x.min(BUFFER_MAX_MIN)) {
        changed |= h.buffer_min.unwrap_or(BUFFER_MIN) != x;
        h.buffer_min = Some(x);
    }
    if let Some(d) = device.filter(|d| maps::check_coord(d.lat, d.lng).is_ok() && d.accuracy_m.is_finite() && d.accuracy_m > 0.0) {
        h.device = Some(DeviceFix { at_ms: now, ..d });
    }
    if let Some(mut w) = weather.filter(|w| maps::check_coord(w.lat, w.lng).is_ok()) {
        let label: String = w.label.chars().filter(|c| !c.is_control()).take(WEATHER_LABEL_MAX).collect();
        w.label = label.trim().to_string();
        changed |= h.weather.as_ref() != Some(&w);
        h.weather = Some(w);
    }
    changed
}

/// Recompute with the real network (behind the gates). `allow_import`: only a user-opened
/// widget may run the calendar's one-off AnythingLLM credential import; the background
/// publisher never does.
async fn refresh(state: &DispatchState, os: &OsState, bridge: &BridgeState, allow_import: bool) -> TripsView {
    let _one = REFRESH_LOCK.lock().await;
    let hints = lock(&HINTS).clone();
    let dir = maps::cc_data_dir(state);
    let cache = dir.join(maps::GEO_DISK_FILE);
    let now = now_ms();
    let p = Params { now_ms: now, horizon_h: hints.horizon_h.unwrap_or(HORIZON_H), buffer_min: hints.buffer_min.unwrap_or(BUFFER_MIN), words: load_words(&dir) };
    let home = super::envfile::env_or_file(state, "MAP_HOME");
    let home_cached = home
        .as_deref()
        .filter(|h| maps::parse_latlng(h).is_none() && !h.trim().is_empty())
        .and_then(|h| maps::disk_peek(&cache, &maps::near_key(h.trim(), &maps::default_home()), now))
        .and_then(|c| c.into_iter().next());
    let inp = OriginInputs { home, home_cached, device: hints.device, weather: hints.weather };
    let creds = calendar::has_creds(state);
    let read_cal = |from: NaiveDate, to: NaiveDate| async move {
        if allow_import || creds {
            calendar::fetch_events(state, os, bridge, from, to).await
        } else {
            // Gates still run first (so a refusal reads right), then "no backend", no import.
            calendar::fetch_events_with(os, bridge, from, to, |_, _| std::future::ready(Err::<Value, String>(calendar::NO_BACKEND.into()))).await
        }
    };
    let cache_ref = &cache;
    let geo = move |q: String, center: Place| async move {
        let key = maps::near_key(&q, &center);
        maps::cached_geocode(cache_ref, &key, now, || async { maps::provider(state).geocode_near(&q, &center).await }).await
    };
    let route = move |pts: Vec<Place>| async move { maps::route_quiet(state, &pts).await };
    let view = compute_with(os, bridge, &p, &inp, read_cal, geo, route).await;
    *lock(&LAST) = Some((Instant::now(), view.clone()));
    view
}

fn fresh_last(max_age: Duration) -> Option<TripsView> {
    lock(&LAST).as_ref().filter(|(at, _)| at.elapsed() < max_age).map(|(_, v)| v.clone())
}

async fn publish(http: &reqwest::Client, gateway_url: &str, bearer: Option<String>, view: &TripsView) -> Result<(), String> {
    let base = loopback_base(gateway_url)?;
    let mut rb = http.put(format!("{base}{SNAPSHOT_PATH}")).timeout(Duration::from_secs(5)).json(view);
    if let Some(t) = bearer {
        rb = rb.bearer_auth(t);
    }
    let r = rb.send().await.map_err(super::dispatch::short)?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!("gateway HTTP {}", r.status().as_u16()))
    }
}

/// Did the phone ask for a refresh (`GET /api/maps/refresh` → `{pending: true}`)? Any failure
/// (gateway down, an older gateway without the route) is "no".
async fn phone_asked(http: &reqwest::Client, gateway_url: &str, bearer: Option<String>) -> bool {
    let Ok(base) = loopback_base(gateway_url) else { return false };
    let mut rb = http.get(format!("{base}{REFRESH_PATH}")).timeout(Duration::from_secs(2));
    if let Some(t) = bearer {
        rb = rb.bearer_auth(t);
    }
    match rb.send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().and_then(|v| v["pending"].as_bool()).unwrap_or(false),
        _ => false,
    }
}

/// The background publisher (desktop): keeps the gateway's snapshot fresh whether or not the
/// widget is on screen or the window is hidden.
pub async fn publisher_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(START_DELAY).await;
    let mut last: Option<Instant> = None;
    let mut every = REFRESH_EVERY;
    let mut last_err: Option<String> = None;
    loop {
        let st = app.state::<DispatchState>();
        let os = app.state::<OsState>();
        let bridge = app.state::<BridgeState>();
        let url = st.snapshot().gateway.url;
        let bearer = os_core::mesh_bearer(&os.snapshot());
        let since = last.map(|t| t.elapsed());
        let due = since.map_or(true, |s| s >= every);
        let asked = !due && since.is_some_and(|s| s >= ASK_MIN_GAP) && phone_asked(&st.http, &url, bearer.clone()).await;
        if due || asked {
            let view = refresh(&st, &os, &bridge, false).await;
            every = next_interval(&view);
            last = Some(Instant::now());
            let res = publish(&st.http, &url, bearer, &view).await.err();
            if res != last_err {
                if let Some(e) = &res {
                    eprintln!("[trips] snapshot not published: {e}");
                }
                last_err = res;
            }
        }
        tokio::time::sleep(TICK).await;
    }
}

fn spawn_publish(state: &DispatchState, os: &OsState, view: TripsView) {
    let http = state.http.clone();
    let url = state.snapshot().gateway.url;
    let bearer = os_core::mesh_bearer(&os.snapshot());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = publish(&http, &url, bearer, &view).await {
            eprintln!("[trips] snapshot not published: {e}");
        }
    });
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The Maps widget's trips (desktop). `device` / `weather` are origin hints kept in memory;
/// the answer is the last view when it is under 2 min old and nothing changed, unless `force`.
/// Each fresh view is also published to the gateway. On the phone: `PHONE_USE_GATEWAY`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn maps_trips(
    state: State<'_, DispatchState>,
    os: State<'_, OsState>,
    bridge: State<'_, BridgeState>,
    horizon_hours: Option<u32>,
    buffer_min: Option<u32>,
    device: Option<DeviceFix>,
    weather: Option<WeatherSpot>,
    force: Option<bool>,
) -> Result<TripsView, String> {
    if cfg!(mobile) {
        return Err(PHONE_USE_GATEWAY.into());
    }
    let changed = set_hints(horizon_hours, buffer_min, device, weather, now_ms());
    if !force.unwrap_or(false) && !changed {
        if let Some(v) = fresh_last(CACHED_VIEW_FOR) {
            return Ok(v);
        }
    }
    let view = refresh(&state, &os, &bridge, true).await;
    spawn_publish(&state, &os, view.clone());
    Ok(view)
}

/// The trip keyword lists (defaults until edited).
#[tauri::command]
pub fn maps_trip_words(state: State<'_, DispatchState>) -> KindWords {
    load_words(&maps::cc_data_dir(&state))
}

/// Save edited keyword lists (sanitized; the stored lists are returned). The next view uses them.
#[tauri::command]
pub fn maps_trip_words_set(state: State<'_, DispatchState>, words: KindWords) -> Result<KindWords, String> {
    let w = save_words(&maps::cc_data_dir(&state), &words)?;
    *lock(&LAST) = None;
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::super::bridge::Tier;
    use super::*;
    use std::sync::Arc;

    fn ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    const NOW: &str = "2026-11-26T15:00:00-05:00";

    fn params() -> Params {
        Params { now_ms: ms(NOW), horizon_h: HORIZON_H, buffer_min: BUFFER_MIN, words: KindWords::default() }
    }

    fn ev(title: &str, start: &str, loc: Option<&str>) -> CalEvent {
        CalEvent {
            id: None,
            title: title.into(),
            start: start.into(),
            start_ms: ms(start),
            end: None,
            end_ms: None,
            all_day: false,
            location: loc.map(String::from),
            description: None,
        }
    }

    fn home() -> Place {
        Place { lat: 43.6532, lng: -79.3832, label: "Home".into() }
    }

    fn route_of(pts: &[Place], secs: f64) -> Route {
        Route {
            provider: "osm".into(),
            distance_m: 5230.0,
            duration_s: secs,
            waypoints: pts.to_vec(),
            steps: vec![],
            geometry: Value::Null,
            traffic_aware: false,
            note: maps::TRAFFIC_NOTE.into(),
            open_in_maps: String::new(),
        }
    }

    type Log = Arc<Mutex<Vec<String>>>;

    /// A fake geocoder: "bad" fails, "far" only matches Vancouver, the rest resolve near home.
    fn fake_geo(log: Log) -> impl Fn(String, Place) -> std::future::Ready<Result<Vec<Place>, String>> {
        move |q: String, _center: Place| {
            log.lock().unwrap().push(q.clone());
            let lq = q.to_lowercase();
            std::future::ready(if lq.contains("bad") {
                Err("Nominatim HTTP 500".into())
            } else if lq.contains("far") {
                Ok(vec![Place { lat: 49.2827, lng: -123.1207, label: "Vancouver, BC".into() }])
            } else {
                // A distinct point per address (by length), all near home.
                Ok(vec![Place { lat: 43.6 + q.len() as f64 * 0.001, lng: -79.3860, label: format!("{q}, Toronto, Ontario, Canada") }])
            })
        }
    }

    /// A fake router: 754.2 s, except to a place at lat 43.7 (fails).
    fn fake_route(log: Log) -> impl Fn(Vec<Place>) -> std::future::Ready<Result<Route, String>> {
        move |pts: Vec<Place>| {
            log.lock().unwrap().push(pts.last().map(|p| p.label.clone()).unwrap_or_default());
            std::future::ready(if pts.last().is_some_and(|p| (p.lat - 43.7).abs() < 1e-9) { Err("no driving route found (NoRoute)".into()) } else { Ok(route_of(&pts, 754.2)) })
        }
    }

    #[test]
    fn classifier_sorts_by_editable_keywords() {
        let w = KindWords::default();
        let c = |t: &str, desc: &str| classify(t, desc, &w);
        assert_eq!(c("Audition – Netflix day player", ""), TripKind::Audition);
        assert_eq!(c("CALLBACK: Bell spot", ""), TripKind::Audition);
        assert_eq!(c("Self-Tape due", ""), TripKind::Audition);
        assert_eq!(c("Chemistry read w/ lead", ""), TripKind::Audition);
        assert_eq!(c("Fitting", ""), TripKind::Booking);
        assert_eq!(c("Bell commercial shoot", ""), TripKind::Booking);
        assert_eq!(c("Call times posted", ""), TripKind::Booking, "plural matches");
        assert_eq!(c("Kitchen reno walkthrough", ""), TripKind::Job);
        assert_eq!(c("Install estimate – Smith", ""), TripKind::Job);
        assert_eq!(c("Dentist", ""), TripKind::Other);
        // Whole words only: "settle" is not "set", "jobless" is not "job", "sitemap" not "site".
        assert_eq!(c("Settle invoice, jobless sitemap", ""), TripKind::Other);
        // The title wins over the description; the description decides when the title can't.
        assert_eq!(c("Fitting", "for the audition next week"), TripKind::Booking);
        assert_eq!(c("Meeting with Dana", "Casting at the studio"), TripKind::Audition);
        // Audition beats booking in the same text.
        assert_eq!(c("Audition booking confirmed", ""), TripKind::Audition);
        // Edited lists take effect, sanitized.
        let custom = KindWords { audition: vec![], booking: vec!["  Gig ".into(), "gig".into(), "\u{7}".into()], job: vec!["Site Visit".into()] }.sanitized();
        assert_eq!(custom.booking, vec!["gig"]);
        assert_eq!(custom.job, vec!["site visit"]);
        assert_eq!(classify("Audition", "", &custom), TripKind::Other);
        assert_eq!(classify("GIG at the Rex", "", &custom), TripKind::Booking);
        assert_eq!(classify("Site visit — 12 Elm", "", &custom), TripKind::Job);
        let many = KindWords { audition: (0..50).map(|i| format!("w{i}")).collect(), booking: vec!["x".repeat(WORD_MAX + 1)], job: vec![] }.sanitized();
        assert_eq!((many.audition.len(), many.booking.len()), (WORDS_PER_KIND, 0));
    }

    #[test]
    fn virtual_meetings_and_placeholders_are_detected() {
        for v in [
            "https://us02web.zoom.us/j/81234567890?pwd=abc",
            "Zoom",
            "via Zoom",
            "meet.google.com/abc-defg-hij",
            "Google Meet",
            "Microsoft Teams Meeting",
            "Teams",
            "Online",
            "Self-tape",
            "self tape at home",
            "Phone call",
            "https://example.com/room/7",
            "Webex",
        ] {
            assert!(is_virtual(v), "{v}");
        }
        for p in ["100 Queen St W, Toronto", "Pinewood Toronto Studios, 225 Commissioners St", "Wardrobe, Stage 4", "Zoom Studios, 123 King St W", "Virtual Stage Inc, 40 Carl Hall Rd", "CN Tower"] {
            assert!(!is_virtual(p), "{p}");
        }
        for p in ["TBD", "tba", "N/A", "See description", "to be confirmed"] {
            assert!(is_placeholder(p), "{p}");
        }
        assert!(!is_placeholder("100 Queen St W"));
    }

    #[test]
    fn leave_by_is_start_minus_eta_minus_buffer_rounded_down() {
        let start = ms("2026-11-27T10:00:00-05:00");
        // 754.2 s (12 min 34.2 s) + 15 min → 09:32:25.8 → 09:32.
        assert_eq!(leave_by(start, 754.2, 15), ms("2026-11-27T09:32:00-05:00"));
        assert_eq!(leave_by(start, 0.0, 15), ms("2026-11-27T09:45:00-05:00"));
        assert_eq!(leave_by(start, 3600.0, 0), ms("2026-11-27T09:00:00-05:00"));
        assert_eq!(leave_by(start, 60.001, 0), ms("2026-11-27T09:58:00-05:00"), "never rounds toward late");
        assert_eq!(leave_by(start, f64::NAN, 15), leave_by(start, 0.0, 15));
        assert_eq!(leave_by(start, -5.0, 15), leave_by(start, 0.0, 15));
    }

    #[test]
    fn the_window_covers_the_horizon_in_toronto_dates() {
        assert_eq!(window(ms(NOW), 48), (d("2026-11-26"), d("2026-11-29")));
        assert_eq!(window(ms("2026-11-26T23:50:00-05:00"), 48), (d("2026-11-26"), d("2026-11-29")));
        assert_eq!(window(ms("2026-11-27T00:10:00-05:00"), 48), (d("2026-11-26"), d("2026-11-30")), "the grace reaches back before midnight");
        // Across the fall change: 48 real hours from Oct 31 23:00 EDT end Nov 2 22:00 EST.
        assert_eq!(window(ms("2026-10-31T23:00:00-04:00"), 48), (d("2026-10-31"), d("2026-11-03")));
        let (from, to) = window(ms(NOW), HORIZON_MAX_H);
        assert!(calendar::events_body(from, to).is_ok(), "the longest horizon fits one calendar read");
    }

    #[test]
    fn assemble_geocodes_each_address_once_and_isolates_failures() {
        tauri::async_runtime::block_on(async {
            let p = params();
            let mut events = vec![
                ev("Audition – test", "2026-11-27T10:00:00-05:00", Some("100 Queen St W, Toronto")),
                ev("Callback", "2026-11-27T14:00:00-05:00", Some("100  QUEEN st w, toronto")),
                ev("Fitting", "2026-11-27T09:00:00-05:00", Some("bad address 9")),
                ev("Zoom read", "2026-11-27T11:00:00-05:00", Some("https://zoom.us/j/123")),
                ev("Far shoot", "2026-11-27T12:00:00-05:00", Some("far place")),
                ev("No location", "2026-11-27T12:30:00-05:00", None),
                ev("Placeholder", "2026-11-27T12:40:00-05:00", Some("TBD")),
                ev("Past", "2026-11-26T13:00:00-05:00", Some("1 Past St")),
                ev("Just started", "2026-11-26T14:45:00-05:00", Some("5 Late Ave")),
                ev("Beyond horizon", "2026-11-28T15:01:00-05:00", Some("2 Later Rd")),
            ];
            let mut all_day = ev("Hold", "2026-11-27T00:00:00-05:00", Some("3 Allday Blvd"));
            all_day.all_day = true;
            events.push(all_day);
            let (geo_log, route_log): (Log, Log) = (Arc::default(), Arc::default());
            let cands = candidates(&events, &p);
            let titles: Vec<&str> = cands.iter().map(|e| e.title.as_str()).collect();
            assert_eq!(titles, ["Just started", "Fitting", "Audition – test", "Zoom read", "Far shoot", "Callback"], "sorted, in the horizon, timed, located");
            let trips = assemble(&cands, &home(), &p, &Ok(()), || Ok(()), &fake_geo(geo_log.clone()), &fake_route(route_log.clone())).await;
            assert_eq!(trips.len(), 6);
            // One geocode per distinct address (the two Queen St spellings share one); none for Zoom.
            assert_eq!(geo_log.lock().unwrap().len(), 4, "{:?}", geo_log.lock().unwrap());
            assert!(!geo_log.lock().unwrap().iter().any(|q| q.contains("zoom")));
            // The two Queen St trips share one place, so one route.
            assert_eq!(route_log.lock().unwrap().len(), 2, "{:?}", route_log.lock().unwrap());
            let by = |t: &str| trips.iter().find(|x| x.event.title == t).unwrap();
            let a = by("Audition – test");
            assert_eq!((a.event.kind, a.place_status), (TripKind::Audition, "resolved"));
            assert_eq!(a.leave_by_ms, Some(ms("2026-11-27T09:32:00-05:00")));
            assert_eq!(a.eta.as_ref().map(|e| (e.duration_s, e.traffic_aware)), Some((754.2, false)));
            assert!(a.open_in_maps.as_deref().unwrap().starts_with("https://www.google.com/maps/dir/?api=1&destination=43.623000,-79.386000"), "{:?}", a.open_in_maps);
            assert!(a.place.as_ref().unwrap().label.contains("Toronto, Ontario"), "the resolved address is shown");
            assert_eq!(by("Callback").place, a.place);
            let bad = by("Fitting");
            assert_eq!((bad.place_status, bad.error.as_deref(), bad.event.kind), ("unresolved", Some("Nominatim HTTP 500"), TripKind::Booking));
            let far = by("Far shoot");
            assert_eq!(far.place_status, "unresolved");
            assert!(far.error.as_deref().unwrap().contains("km away"));
            let z = by("Zoom read");
            assert_eq!((z.place_status, z.eta.is_none(), z.error.is_none()), ("virtual", true, true));
            assert_eq!(by("Just started").place_status, "resolved");
        });
    }

    #[test]
    fn a_failed_route_stays_on_its_trip_and_the_cap_holds() {
        tauri::async_runtime::block_on(async {
            let p = params();
            let geo = |q: String, _c: Place| {
                std::future::ready(Ok::<_, String>(vec![if q.contains("island") { Place { lat: 43.7, lng: -79.4, label: "Island".into() } } else { Place { lat: 43.66, lng: -79.39, label: q } }]))
            };
            let route_log: Log = Arc::default();
            let events: Vec<CalEvent> = (0..12).map(|i| ev(&format!("Shoot {i}"), &format!("2026-11-27T{:02}:00:00-05:00", 8 + i), Some(if i == 3 { "Toronto island" } else { "10 Main St" }))).collect();
            let cands = candidates(&events, &p);
            assert_eq!(cands.len(), MAX_TRIPS);
            let trips = assemble(&cands, &home(), &p, &Ok(()), || Ok(()), &geo, &fake_route(route_log)).await;
            assert_eq!(trips.len(), MAX_TRIPS);
            let broken = &trips[3];
            assert_eq!((broken.place_status, broken.eta.is_none(), broken.leave_by_ms), ("resolved", true, None));
            assert!(broken.error.as_deref().unwrap().contains("NoRoute"));
            assert!(trips.iter().enumerate().filter(|(i, _)| *i != 3).all(|(_, t)| t.eta.is_some() && t.error.is_none()));
        });
    }

    #[test]
    fn origin_prefers_home_then_a_good_device_fix_then_weather() {
        tauri::async_runtime::block_on(async {
            let now = ms(NOW);
            let geo_log: Log = Arc::default();
            let geo = fake_geo(geo_log.clone());
            let ok = || Ok::<(), String>(());
            let good = DeviceFix { lat: 43.70, lng: -79.40, accuracy_m: 35.0, at_ms: now - 60_000 };
            let weather = WeatherSpot { lat: 43.1, lng: -79.1, label: "Niagara".into() };
            let all = OriginInputs { home: Some("43.65, -79.38".into()), home_cached: None, device: Some(good), weather: Some(weather.clone()) };
            let (o, note) = resolve_origin(&all, now, &Ok(()), &ok, &geo).await;
            assert_eq!((o.source, o.lat, note), ("home", 43.65, None));
            let no_home = OriginInputs { home: None, ..all.clone() };
            assert_eq!(resolve_origin(&no_home, now, &Ok(()), &ok, &geo).await.0.source, "device");
            // Coarse (≥ 500 m) or stale fixes are ignored.
            for bad in [DeviceFix { accuracy_m: 800.0, ..good }, DeviceFix { accuracy_m: 500.0, ..good }, DeviceFix { at_ms: now - DEVICE_MAX_AGE_MS - 1, ..good }, DeviceFix { accuracy_m: f64::NAN, ..good }] {
                let o = resolve_origin(&OriginInputs { device: Some(bad), ..no_home.clone() }, now, &Ok(()), &ok, &geo).await.0;
                assert_eq!((o.source, o.label.as_str()), ("weather", "Niagara"), "{bad:?}");
            }
            let o = resolve_origin(&OriginInputs::default(), now, &Ok(()), &ok, &geo).await.0;
            assert_eq!(o.source, "default");
            assert!(geo_log.lock().unwrap().is_empty(), "no lookup so far");
            // An address MAP_HOME: the disk cache first, else one lookup when allowed.
            let cached = Place { lat: 43.66, lng: -79.39, label: "1 Home Rd, Toronto".into() };
            let addr = OriginInputs { home: Some("1 Home Rd".into()), home_cached: Some(cached), ..no_home.clone() };
            let (o, _) = resolve_origin(&addr, now, &Err(IDLE.into()), &ok, &geo).await;
            assert_eq!((o.source, o.label.as_str()), ("home", "Home, 1 Home Rd, Toronto"));
            assert!(geo_log.lock().unwrap().is_empty());
            let uncached = OriginInputs { home_cached: None, ..addr.clone() };
            let (o, note) = resolve_origin(&uncached, now, &Ok(()), &ok, &geo).await;
            assert_eq!((o.source, note), ("home", None));
            assert_eq!(geo_log.lock().unwrap().as_slice(), ["1 Home Rd"]);
            // Blocked: no lookup, fall through, say why.
            let (o, note) = resolve_origin(&uncached, now, &Err(MAPS_KILLED.into()), &ok, &geo).await;
            assert_eq!(o.source, "device");
            assert!(note.unwrap().contains("MAP_HOME wasn't looked up"));
            let killed = || Err::<(), String>(MAPS_KILLED.into());
            let _ = resolve_origin(&uncached, now, &Ok(()), &killed, &geo).await;
            assert_eq!(geo_log.lock().unwrap().len(), 1, "the kill re-check stops the home lookup too");
        });
    }

    fn gate_env(f: impl FnOnce(&mut os_core::OsConfig)) -> OsState {
        let os = OsState::default();
        os.update(|c| {
            for m in c.mcps.iter_mut().filter(|m| m.id == "calendar" || m.id == "maps") {
                m.enabled = true;
            }
            c.privacy.kill_switch = false;
            f(c);
            Ok(())
        })
        .unwrap();
        os
    }

    fn cal_reply() -> Value {
        json!({ "events": [
            { "title": "Audition – test", "startTime": "2026-11-27T15:00:00.000Z", "location": "100 Queen St W, Toronto" },
            { "title": "Zoom chemistry read", "startTime": "2026-11-27T17:00:00.000Z", "location": "https://zoom.us/j/1" },
            { "title": "Site walkthrough", "startTime": "2026-11-27T19:00:00.000Z", "location": "12 Elm St, Toronto" }
        ] })
    }

    struct Counts {
        cal: Log,
        geo: Log,
        route: Log,
    }

    async fn run(os: &OsState, bridge: &BridgeState) -> (TripsView, Counts) {
        let c = Counts { cal: Arc::default(), geo: Arc::default(), route: Arc::default() };
        let cal_log = c.cal.clone();
        let fake_cal = move |a: &'static str, _v: Value| {
            cal_log.lock().unwrap().push(a.to_string());
            std::future::ready(Ok::<Value, String>(cal_reply()))
        };
        let inp = OriginInputs { home: Some("43.6532,-79.3832".into()), ..Default::default() };
        let view = compute_with(os, bridge, &params(), &inp, |f, t| calendar::fetch_events_with(os, bridge, f, t, fake_cal), fake_geo(c.geo.clone()), fake_route(c.route.clone())).await;
        (view, c)
    }

    fn calls(c: &Counts) -> (usize, usize, usize) {
        (c.cal.lock().unwrap().len(), c.geo.lock().unwrap().len(), c.route.lock().unwrap().len())
    }

    #[test]
    fn the_whole_view_with_every_gate_open() {
        tauri::async_runtime::block_on(async {
            let bridge = BridgeState::default();
            let (v, c) = run(&gate_env(|_| {}), &bridge).await;
            assert_eq!(calls(&c), (1, 2, 2));
            assert_eq!((v.calendar, v.maps, v.detail.as_str(), v.origin.source), ("ok", "ok", "", "home"));
            assert_eq!(v.trips.iter().map(|t| (t.event.kind, t.place_status)).collect::<Vec<_>>(), [(TripKind::Audition, "resolved"), (TripKind::Audition, "virtual"), (TripKind::Job, "resolved")]);
            assert_eq!((v.horizon_hours, v.buffer_min, v.traffic_provider.clone()), (48, 15, None));
            // The contract's camelCase names, and a full view stays far under the gateway's 64 KB.
            let j = serde_json::to_value(&v).unwrap();
            for k in ["trips", "origin", "horizonHours", "bufferMin", "fetchedAtMs", "calendar", "detail", "maps", "trafficProvider"] {
                assert!(j.get(k).is_some(), "{k}");
            }
            let t = &j["trips"][0];
            assert_eq!((t["placeStatus"].as_str(), t["event"]["kind"].as_str(), t["event"]["source"].as_str()), (Some("resolved"), Some("audition"), Some("gcal")));
            for k in ["leaveByMs", "openInMaps", "eta", "place"] {
                assert!(t.get(k).is_some(), "{k}");
            }
            assert!(t["event"].get("startMs").is_some() && t["event"].get("locationText").is_some() && t["eta"].get("durationS").is_some());
            assert!(t["event"].get("description").is_none(), "the description never leaves Rust");
        });
    }

    #[test]
    fn kill_switch_and_mcp_permission_block_every_network_call() {
        tauri::async_runtime::block_on(async {
            let bridge = BridgeState::default();
            let (v, c) = run(&gate_env(|c| c.privacy.kill_switch = true), &bridge).await;
            assert_eq!(calls(&c), (0, 0, 0), "kill switch: no calendar, geocode or route call");
            assert_eq!((v.calendar, v.trips.len()), ("blocked", 0));
            for tier in [Tier::Deny, Tier::Ask] {
                let os = gate_env(|c| c.permissions.mcp = tier);
                let (v, c) = run(&os, &bridge).await;
                assert_eq!(calls(&c), (0, 0, 0), "{tier:?}");
                assert_eq!(v.calendar, "blocked");
                assert!(v.detail.starts_with("PERMISSION_"), "{}", v.detail);
                assert_eq!(next_interval(&v), BACKOFF_EVERY, "an unapproved tier backs the publisher off");
                assert!(maps_gate(&os, &bridge).unwrap_err().starts_with("PERMISSION_"));
            }
            assert_eq!(maps_gate(&gate_env(|c| c.privacy.kill_switch = true), &bridge).unwrap_err(), MAPS_KILLED);
            // Maps off / frozen: the calendar still reads, but no map lookup runs.
            let (v, c) = run(&gate_env(|c| c.mcps.iter_mut().filter(|m| m.id == "maps").for_each(|m| m.enabled = false)), &bridge).await;
            assert_eq!(calls(&c), (1, 0, 0));
            assert_eq!((v.calendar, v.maps), ("ok", "off"));
            assert!(v.trips.iter().filter(|t| t.place_status != "virtual").all(|t| t.place_status == "unresolved" && t.error.as_deref() == Some(MAPS_OFF)));
            assert!(v.detail.contains("Maps tools are switched off"));
            let (v, c) = run(&gate_env(|c| c.switchboard.frozen_tools = vec!["maps".into()]), &bridge).await;
            assert_eq!((calls(&c), v.maps), ((1, 0, 0), "frozen"));
            assert_eq!(next_interval(&v), REFRESH_EVERY);
        });
    }

    #[test]
    fn a_kill_switch_flipped_mid_refresh_stops_the_next_call() {
        tauri::async_runtime::block_on(async {
            let os = gate_env(|_| {});
            let bridge = BridgeState::default();
            let geo_n = std::sync::atomic::AtomicU32::new(0);
            let route_log: Log = Arc::default();
            let geo = |_q: String, _c: Place| {
                geo_n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                os.update(|c| {
                    c.privacy.kill_switch = true;
                    Ok(())
                })
                .unwrap();
                std::future::ready(Ok::<_, String>(vec![Place { lat: 43.66, lng: -79.39, label: "x".into() }]))
            };
            let fake_cal = |_: &'static str, _: Value| std::future::ready(Ok::<Value, String>(cal_reply()));
            let inp = OriginInputs { home: Some("43.6532,-79.3832".into()), ..Default::default() };
            let v = compute_with(&os, &bridge, &params(), &inp, |f, t| calendar::fetch_events_with(&os, &bridge, f, t, fake_cal), geo, fake_route(route_log.clone())).await;
            assert_eq!(geo_n.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(route_log.lock().unwrap().is_empty());
            assert!(v.trips.iter().filter(|t| t.place_status != "virtual").all(|t| t.eta.is_none() && t.error.as_deref() == Some(MAPS_KILLED)));
        });
    }

    #[test]
    fn no_located_events_means_no_map_gate_and_no_permission_line() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("trips-idle-{}-{}", std::process::id(), now_ms()));
            std::fs::create_dir_all(&dir).unwrap();
            let bridge = BridgeState::default();
            bridge.init(&dir, dir.join("logs"));
            // Maps under Ask would log; with only a virtual event nothing asks.
            let os = gate_env(|_| {});
            let reply = json!([{ "title": "Zoom", "startTime": "2026-11-27T15:00:00.000Z", "location": "Zoom" }]);
            let fake_cal = |_: &'static str, _: Value| std::future::ready(Ok::<Value, String>(reply.clone()));
            let geo_log: Log = Arc::default();
            let v = compute_with(&os, &bridge, &params(), &OriginInputs::default(), |f, t| calendar::fetch_events_with(&os, &bridge, f, t, fake_cal), fake_geo(geo_log.clone()), fake_route(Arc::default())).await;
            assert_eq!((v.maps, v.trips.len(), v.trips[0].place_status, v.origin.source), ("idle", 1, "virtual", "default"));
            assert!(geo_log.lock().unwrap().is_empty());
            // An MCP-gated lookup logs the tool name only, never an address or a title.
            let ask = gate_env(|c| c.permissions.mcp = Tier::Ask);
            assert!(maps_gate(&ask, &bridge).is_err());
            let log: String = std::fs::read_dir(dir.join("logs")).map(|r| r.filter_map(|e| std::fs::read_to_string(e.ok()?.path()).ok()).collect()).unwrap_or_default();
            assert!(log.contains(TRIPS_TOOL) && !log.contains("Queen") && !log.contains("Zoom"), "{log}");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn keyword_file_round_trips_and_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("trips-words-{}-{}", std::process::id(), now_ms()));
        assert_eq!(load_words(&dir), KindWords::default(), "missing file → defaults");
        let saved = save_words(&dir, &KindWords { audition: vec!["Audition".into(), "audition".into()], booking: vec![], job: vec!["Site".into()] }).unwrap();
        assert_eq!(saved, KindWords { audition: vec!["audition".into()], booking: vec![], job: vec!["site".into()] });
        assert_eq!(load_words(&dir), saved, "an emptied list stays empty");
        std::fs::write(dir.join(WORDS_FILE), "{oops").unwrap();
        assert_eq!(load_words(&dir), KindWords::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_snapshot_goes_to_loopback_only() {
        assert_eq!(loopback_base("http://127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(loopback_base(" http://localhost:8080/ ").unwrap(), "http://localhost:8080");
        assert_eq!(loopback_base("http://[::1]:8080/x?y=1").unwrap(), "http://[::1]:8080");
        assert_eq!(loopback_base("http://100.64.12.7:8080/").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(loopback_base("https://mortadella.netbird.cloud:8443").unwrap(), "https://127.0.0.1:8443");
        assert!(loopback_base("not a url").is_err());
        assert!(loopback_base("file:///C:/x").is_err());
    }

    #[test]
    fn hints_are_validated_and_change_the_view_only_when_they_matter() {
        let now = ms(NOW);
        *lock(&HINTS) = Hints::default();
        assert!(!set_hints(None, None, None, None, now));
        assert!(!set_hints(Some(48), Some(15), None, None, now), "the defaults are no change");
        assert!(set_hints(Some(500), None, None, None, now));
        assert_eq!(lock(&HINTS).horizon_h, Some(HORIZON_MAX_H));
        assert!(!set_hints(None, None, Some(DeviceFix { lat: 43.7, lng: -79.4, accuracy_m: 20.0, at_ms: 0 }), None, now), "a new fix alone keeps the cached view");
        assert_eq!(lock(&HINTS).device.map(|d| d.at_ms), Some(now), "stamped on receipt");
        assert!(!set_hints(None, None, Some(DeviceFix { lat: 95.0, lng: 0.0, accuracy_m: 20.0, at_ms: 0 }), None, now));
        assert_eq!(lock(&HINTS).device.map(|d| d.lat), Some(43.7), "a bad fix is dropped");
        let w: WeatherSpot = serde_json::from_value(json!({ "lat": 43.1, "lon": -79.1, "label": "Niagara\u{7}" })).unwrap();
        assert!(set_hints(None, None, None, Some(w.clone()), now));
        assert_eq!(lock(&HINTS).weather.as_ref().map(|w| w.label.as_str()), Some("Niagara"));
        assert!(!set_hints(None, None, None, Some(w), now));
        *lock(&HINTS) = Hints::default();
    }

    /// Trip routing never redraws the widget's route: nothing in this file emits `map-route`,
    /// and the quiet router in maps.rs doesn't either.
    #[test]
    fn trip_routing_never_touches_the_widget_route() {
        let me = include_str!("trips.rs");
        let (emit, cmd) = (["emit", "_route"].concat(), ["map_route", "("].concat());
        assert!(!me.contains(&emit) && !me.contains(&cmd) && !me.contains(&["Emit", "ter"].concat()));
        let m = include_str!("maps.rs");
        let body = &m[m.find("async fn route_quiet").unwrap()..];
        let body = &body[..body.find("\n}").unwrap()];
        assert!(!body.contains("emit"), "{body}");
    }
}
