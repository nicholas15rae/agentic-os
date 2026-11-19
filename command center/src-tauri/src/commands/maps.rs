//! Maps: geocoding, routing and ETA behind a provider interface (`MapProvider`).
//!
//! Google Maps is on hold; the only provider today is the zero-cost OpenStreetMap
//! stack (`Osm`):
//!   - geocoding: Nominatim (`/search`, `/reverse`), with `User-Agent: Gabagool-CommandCenter/1.0`,
//!     a global ≤1 request/second limiter and an in-memory cache (Nominatim usage policy;
//!     geocode on submit only, never as-you-type);
//!   - routing: the public OSRM demo server (driving profile, GeoJSON geometry, steps).
//!     It has **no live traffic**, so every ETA is labelled a baseline driving estimate.
//!
//! Tony's `maps.*` builtin tools are read-only. `maps.route` also emits a `map-route`
//! event so the Route Map widget draws the line. All calls run here in Rust (a webview
//! can't set a User-Agent, and the limiter must be global). The kill switch blocks them.
//! Swapping in another provider later means implementing `MapProvider` and returning it
//! from `provider()`; the tools, commands and UI only see `Place` / `Route`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

use super::dispatch::{short, DispatchState};
use super::os_core::OsState;

pub const USER_AGENT: &str = "Gabagool-CommandCenter/1.0";
const NOMINATIM: &str = "https://nominatim.openstreetmap.org";
const OSRM: &str = "https://router.project-osrm.org";
/// Home when `MAP_HOME` (env / repo-root .env) isn't set: Toronto, as for `weather.current`.
const DEFAULT_HOME: (f64, f64, &str) = (43.6532, -79.3832, "Toronto (city centre)");
pub const TRAFFIC_NOTE: &str = "Baseline driving estimate — no live traffic (OpenStreetMap routing).";
const GEO_TTL: Duration = Duration::from_secs(24 * 3600);
const ROUTE_TTL: Duration = Duration::from_secs(5 * 60);
const CACHE_MAX: usize = 500;
const MAX_STOPS: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub lat: f64,
    pub lng: f64,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub instruction: String,
    pub distance_m: f64,
    pub duration_s: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub provider: String,
    pub distance_m: f64,
    pub duration_s: f64,
    /// Origin, any stops, destination — in driving order.
    pub waypoints: Vec<Place>,
    pub steps: Vec<Step>,
    /// GeoJSON `LineString` (lng, lat pairs).
    pub geometry: Value,
    pub traffic_aware: bool,
    pub note: String,
    /// Turn-by-turn hand-off to the phone (Google Maps directions URL).
    pub open_in_maps: String,
}

/// What every map backend implements. Tools, commands and the UI only see `Place` / `Route`.
#[allow(async_fn_in_trait)]
pub trait MapProvider {
    fn id(&self) -> &'static str;
    async fn geocode(&self, query: &str) -> Result<Vec<Place>, String>;
    async fn reverse(&self, lat: f64, lng: f64) -> Result<Place, String>;
    /// Driving route through `points` (≥ 2, in order).
    async fn route(&self, points: &[Place]) -> Result<Route, String>;
}

/// The active provider. Google Maps can be returned from here again later.
pub fn provider(state: &DispatchState) -> Osm<'_> {
    Osm { http: &state.http }
}

/// "Open in Maps": hands turn-by-turn navigation to the phone. Provider-independent.
pub fn open_in_maps_url(dest: &Place, stops: &[Place]) -> String {
    let mut u = format!("https://www.google.com/maps/dir/?api=1&destination={:.6},{:.6}&travelmode=driving", dest.lat, dest.lng);
    if !stops.is_empty() {
        let w: Vec<String> = stops.iter().map(|p| format!("{:.6},{:.6}", p.lat, p.lng)).collect();
        u.push_str("&waypoints=");
        u.push_str(&w.join("%7C"));
    }
    u
}

// ── OpenStreetMap ──────────────────────────────────────────────────────────

pub struct Osm<'a> {
    http: &'a reqwest::Client,
}

static NOMINATIM_LAST: tokio::sync::Mutex<Option<Instant>> = tokio::sync::Mutex::const_new(None);
static GEO_CACHE: Mutex<Option<HashMap<String, (Instant, Vec<Place>)>>> = Mutex::new(None);
static ROUTE_CACHE: Mutex<Option<HashMap<String, (Instant, Route)>>> = Mutex::new(None);

fn cache_get<T: Clone>(cache: &Mutex<Option<HashMap<String, (Instant, T)>>>, key: &str, ttl: Duration) -> Option<T> {
    let g = cache.lock().unwrap();
    g.as_ref()?.get(key).filter(|(at, _)| at.elapsed() < ttl).map(|(_, v)| v.clone())
}

fn cache_put<T>(cache: &Mutex<Option<HashMap<String, (Instant, T)>>>, key: String, v: T, ttl: Duration) {
    let mut g = cache.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    if m.len() >= CACHE_MAX {
        m.retain(|_, (at, _)| at.elapsed() < ttl);
        if m.len() >= CACHE_MAX {
            if let Some(oldest) = m.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                m.remove(&oldest);
            }
        }
    }
    m.insert(key, (Instant::now(), v));
}

/// Wait until ≥ 1 s has passed since the previous Nominatim request (global, across tasks).
async fn nominatim_slot() {
    let mut last = NOMINATIM_LAST.lock().await;
    if let Some(t) = *last {
        let wait = Duration::from_millis(1000).saturating_sub(t.elapsed());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
    *last = Some(Instant::now());
}

/// Cache key: case-folded, whitespace-collapsed query.
pub(crate) fn norm_query(q: &str) -> String {
    q.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

pub(crate) fn parse_nominatim(v: &Value) -> Vec<Place> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let lat = r["lat"].as_str()?.parse().ok()?;
            let lng = r["lon"].as_str()?.parse().ok()?;
            Some(Place { lat, lng, label: r["display_name"].as_str().unwrap_or("").to_string() })
        })
        .collect()
}

impl Osm<'_> {
    async fn nominatim(&self, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
        nominatim_slot().await;
        let r = self
            .http
            .get(format!("{NOMINATIM}/{path}"))
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .query(query)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("Nominatim {}", short(e)))?;
        if !r.status().is_success() {
            return Err(format!("Nominatim HTTP {}", r.status().as_u16()));
        }
        r.json().await.map_err(|e| format!("Nominatim {}", short(e)))
    }
}

impl MapProvider for Osm<'_> {
    fn id(&self) -> &'static str {
        "osm"
    }

    async fn geocode(&self, query: &str) -> Result<Vec<Place>, String> {
        let q = query.trim();
        if q.is_empty() || q.len() > 300 {
            return Err("geocode needs an address or place name".into());
        }
        let key = format!("f:{}", norm_query(q));
        if let Some(hit) = cache_get(&GEO_CACHE, &key, GEO_TTL) {
            return Ok(hit);
        }
        let v = self.nominatim("search", &[("q", q.to_string()), ("format", "jsonv2".into()), ("limit", "3".into())]).await?;
        let places = parse_nominatim(&v);
        cache_put(&GEO_CACHE, key, places.clone(), GEO_TTL);
        Ok(places)
    }

    async fn reverse(&self, lat: f64, lng: f64) -> Result<Place, String> {
        check_coord(lat, lng)?;
        let key = format!("r:{lat:.5},{lng:.5}");
        if let Some(hit) = cache_get(&GEO_CACHE, &key, GEO_TTL).and_then(|v| v.into_iter().next()) {
            return Ok(hit);
        }
        let v = self.nominatim("reverse", &[("lat", lat.to_string()), ("lon", lng.to_string()), ("format", "jsonv2".into())]).await?;
        if let Some(e) = v["error"].as_str() {
            return Err(format!("Nominatim: {e}"));
        }
        let p = Place { lat, lng, label: v["display_name"].as_str().unwrap_or("").to_string() };
        cache_put(&GEO_CACHE, key, vec![p.clone()], GEO_TTL);
        Ok(p)
    }

    async fn route(&self, points: &[Place]) -> Result<Route, String> {
        if points.len() < 2 {
            return Err("a route needs a start and a destination".into());
        }
        let coords: Vec<String> = points.iter().map(|p| format!("{:.6},{:.6}", p.lng, p.lat)).collect(); // OSRM: lon,lat
        let key = coords.join(";");
        if let Some(hit) = cache_get(&ROUTE_CACHE, &key, ROUTE_TTL) {
            return Ok(hit);
        }
        let r = self
            .http
            .get(format!("{OSRM}/route/v1/driving/{key}"))
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .query(&[("overview", "full"), ("geometries", "geojson"), ("steps", "true")])
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("OSRM {}", short(e)))?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.map_err(|e| format!("OSRM {}", short(e)))?;
        let route = parse_osrm(&v, points).map_err(|e| if status == 200 { e } else { format!("OSRM HTTP {status}: {e}") })?;
        cache_put(&ROUTE_CACHE, key, route.clone(), ROUTE_TTL);
        Ok(route)
    }
}

fn check_coord(lat: f64, lng: f64) -> Result<(), String> {
    if lat.is_finite() && lng.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng) {
        Ok(())
    } else {
        Err("coordinates out of range".into())
    }
}

/// "43.65,-79.38" → a Place without a geocoding call.
pub(crate) fn parse_latlng(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.trim().split_once(',')?;
    let (lat, lng) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
    check_coord(lat, lng).ok()?;
    Some((lat, lng))
}

/// One OSRM step as a sentence: "Turn left onto King Street West".
pub(crate) fn step_text(s: &Value) -> String {
    let m = &s["maneuver"];
    let kind = m["type"].as_str().unwrap_or("continue");
    let modifier = m["modifier"].as_str().unwrap_or("");
    let road = s["name"].as_str().filter(|n| !n.is_empty()).or_else(|| s["ref"].as_str().filter(|n| !n.is_empty()));
    let onto = road.map(|r| format!(" onto {r}")).unwrap_or_default();
    let dir = if modifier.is_empty() { String::new() } else { format!(" {modifier}") };
    match kind {
        "depart" => format!("Head out{}", road.map(|r| format!(" on {r}")).unwrap_or_default()),
        "arrive" => "Arrive at your destination".into(),
        "turn" | "end of road" => format!("Turn{dir}{onto}"),
        "new name" | "continue" => format!("Continue{dir}{onto}"),
        "merge" => format!("Merge{dir}{onto}"),
        "on ramp" => format!("Take the ramp{dir}{onto}"),
        "off ramp" => format!("Take the exit{dir}{onto}"),
        "fork" => format!("Keep{dir} at the fork{onto}"),
        "roundabout" | "rotary" => {
            let exit = m["exit"].as_u64().map(|n| format!(", exit {n}")).unwrap_or_default();
            format!("At the roundabout{exit}{onto}")
        }
        other => format!("{}{dir}{onto}", capitalise(other)),
    }
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

pub(crate) fn parse_osrm(v: &Value, points: &[Place]) -> Result<Route, String> {
    if v["code"].as_str() != Some("Ok") {
        let msg = v["message"].as_str().or(v["code"].as_str()).unwrap_or("no route");
        return Err(format!("no driving route found ({msg})"));
    }
    let r = &v["routes"][0];
    let steps = r["legs"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|leg| leg["steps"].as_array().cloned().unwrap_or_default())
        .map(|s| Step { instruction: step_text(&s), distance_m: s["distance"].as_f64().unwrap_or(0.0), duration_s: s["duration"].as_f64().unwrap_or(0.0) })
        .collect();
    let dest = points.last().cloned().ok_or("no destination")?;
    Ok(Route {
        provider: "osm".into(),
        distance_m: r["distance"].as_f64().unwrap_or(0.0),
        duration_s: r["duration"].as_f64().unwrap_or(0.0),
        waypoints: points.to_vec(),
        steps,
        geometry: r["geometry"].clone(),
        traffic_aware: false,
        note: TRAFFIC_NOTE.into(),
        open_in_maps: open_in_maps_url(&dest, &points[1..points.len() - 1]),
    })
}

pub(crate) fn fmt_duration(s: f64) -> String {
    let m = (s / 60.0).round() as u64;
    match m {
        0 => "under a minute".into(),
        1..=59 => format!("{m} min"),
        _ => format!("{} h {} min", m / 60, m % 60),
    }
}

pub(crate) fn fmt_distance(m: f64) -> String {
    if m < 1000.0 {
        format!("{} m", (m / 10.0).round() * 10.0)
    } else {
        format!("{:.1} km", m / 1000.0)
    }
}

/// The tool's answer for Tony (voice/chat): ETA, distance, the no-traffic note, first steps, link.
pub(crate) fn route_summary(r: &Route) -> String {
    let names: Vec<&str> = r.waypoints.iter().map(|p| short_label(&p.label)).collect();
    let mut out = format!(
        "Driving {} → {}: about {} for {}. {}\n",
        names.first().copied().unwrap_or("start"),
        names.last().copied().unwrap_or("destination"),
        fmt_duration(r.duration_s),
        fmt_distance(r.distance_m),
        r.note
    );
    if names.len() > 2 {
        out.push_str(&format!("Stops in order: {}\n", names[1..names.len() - 1].join(" → ")));
    }
    let shown: Vec<String> = r.steps.iter().filter(|s| s.distance_m > 0.0 || s.instruction.starts_with("Arrive")).take(8).enumerate().map(|(i, s)| format!("{}. {} ({})", i + 1, s.instruction, fmt_distance(s.distance_m))).collect();
    if !shown.is_empty() {
        out.push_str("Directions:\n");
        out.push_str(&shown.join("\n"));
        if r.steps.len() > shown.len() {
            out.push_str(&format!("\n… {} more steps on the map.", r.steps.len() - shown.len()));
        }
    }
    out.push_str(&format!("\nOpen in Maps: {}", r.open_in_maps));
    out
}

/// First one or two comma parts of a Nominatim display name.
fn short_label(label: &str) -> &str {
    let mut idx = None;
    for (n, (i, _)) in label.match_indices(',').enumerate() {
        if n == 1 {
            idx = Some(i);
            break;
        }
    }
    idx.map_or(label, |i| &label[..i])
}

// ── Resolution (address / "lat,lng" / home) ─────────────────────────────────

async fn resolve(p: &impl MapProvider, state: &DispatchState, text: &str) -> Result<Place, String> {
    let t = text.trim();
    if t.is_empty() || matches!(t.to_lowercase().as_str(), "home" | "here" | "my place" | "my house") {
        return home(p, state).await;
    }
    if let Some((lat, lng)) = parse_latlng(t) {
        return Ok(Place { lat, lng, label: format!("{lat:.5}, {lng:.5}") });
    }
    p.geocode(t).await?.into_iter().next().ok_or_else(|| format!("couldn't find \"{t}\" on the map — try a fuller address"))
}

/// `MAP_HOME` (address or "lat,lng") from env / repo-root .env, else Toronto city centre.
async fn home(p: &impl MapProvider, state: &DispatchState) -> Result<Place, String> {
    match super::envfile::env_or_file(state, "MAP_HOME") {
        Some(h) if parse_latlng(&h).is_some() => {
            let (lat, lng) = parse_latlng(&h).unwrap();
            Ok(Place { lat, lng, label: "Home".into() })
        }
        Some(h) => p.geocode(&h).await?.into_iter().next().map(|mut pl| {
            pl.label = format!("Home, {}", pl.label);
            pl
        }).ok_or_else(|| "MAP_HOME in .env couldn't be found on the map".into()),
        None => Ok(Place { lat: DEFAULT_HOME.0, lng: DEFAULT_HOME.1, label: DEFAULT_HOME.2.into() }),
    }
}

/// Stops given as a JSON array or a "|"/";"-separated string.
pub(crate) fn split_stops(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|s| s.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
        Some(Value::String(s)) => s.split(['|', ';']).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
        _ => vec![],
    }
}

pub async fn plan_route(state: &DispatchState, destination: &str, origin: Option<&str>, stops: &[String]) -> Result<Route, String> {
    if destination.trim().is_empty() {
        return Err("maps.route needs a destination".into());
    }
    if stops.len() > MAX_STOPS {
        return Err(format!("at most {MAX_STOPS} stops per route"));
    }
    let p = provider(state);
    let mut points = vec![resolve(&p, state, origin.unwrap_or("")).await?];
    for s in stops {
        points.push(resolve(&p, state, s).await?);
    }
    points.push(resolve(&p, state, destination).await?);
    p.route(&points).await
}

fn emit_route(r: &Route) {
    use tauri::Emitter;
    if let Some(app) = super::trace::app() {
        let _ = app.emit("map-route", r);
    }
}

fn blocked(os: &OsState) -> Result<(), String> {
    if os.snapshot().privacy.kill_switch {
        Err("kill switch is on — maps use online OpenStreetMap services".into())
    } else {
        Ok(())
    }
}

fn arg<'a>(args: &'a Value, k: &str) -> &'a str {
    args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn num(args: &Value, k: &str) -> Option<f64> {
    args.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str()?.trim().parse().ok()))
}

/// `name` is a `maps.*` builtin tool (all read-only).
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value) -> Result<String, String> {
    blocked(os)?;
    match name {
        "maps.route" => {
            let origin = arg(args, "origin");
            let stops = split_stops(args.get("stops"));
            let r = plan_route(state, arg(args, "destination"), (!origin.is_empty()).then_some(origin), &stops).await?;
            emit_route(&r);
            Ok(route_summary(&r))
        }
        "maps.geocode" => {
            let hits = provider(state).geocode(arg(args, "query")).await?;
            if hits.is_empty() {
                return Ok(format!("No match for \"{}\".", arg(args, "query")));
            }
            Ok(hits.iter().map(|p| format!("{} ({:.5}, {:.5})", p.label, p.lat, p.lng)).collect::<Vec<_>>().join("\n"))
        }
        "maps.reverse" => {
            let (lat, lng) = (num(args, "lat").ok_or("maps.reverse needs lat")?, num(args, "lng").ok_or("maps.reverse needs lng")?);
            let p = provider(state).reverse(lat, lng).await?;
            Ok(if p.label.is_empty() { "No address found there.".into() } else { p.label })
        }
        _ => Err(format!("unknown maps tool {name}")),
    }
}

// ── Tauri commands (Route Map widget, Settings) ─────────────────────────────

#[tauri::command]
pub async fn map_route(state: State<'_, DispatchState>, os: State<'_, OsState>, destination: String, origin: Option<String>, stops: Option<Vec<String>>) -> Result<Route, String> {
    blocked(&os)?;
    let r = plan_route(&state, &destination, origin.as_deref().filter(|s| !s.trim().is_empty()), &stops.unwrap_or_default()).await?;
    emit_route(&r);
    Ok(r)
}

#[tauri::command]
pub async fn map_geocode(state: State<'_, DispatchState>, os: State<'_, OsState>, query: String) -> Result<Vec<Place>, String> {
    blocked(&os)?;
    provider(&state).geocode(&query).await
}

#[tauri::command]
pub async fn map_reverse(state: State<'_, DispatchState>, os: State<'_, OsState>, lat: f64, lng: f64) -> Result<Place, String> {
    blocked(&os)?;
    provider(&state).reverse(lat, lng).await
}

/// "Open in Maps": opens Google Maps directions in the system browser / phone hand-off.
/// The URL is built here from coordinates, so the webview can't open an arbitrary link.
#[tauri::command]
pub fn map_open_in_maps(lat: f64, lng: f64, stops: Option<Vec<Place>>) -> Result<String, String> {
    check_coord(lat, lng)?;
    let stops = stops.unwrap_or_default();
    for s in &stops {
        check_coord(s.lat, s.lng)?;
    }
    let url = open_in_maps_url(&Place { lat, lng, label: String::new() }, &stops);
    super::spotify::open_browser(&url).map_err(|e| format!("couldn't open the browser: {e}"))?;
    Ok(url)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MapsStatus {
    pub provider: &'static str,
    /// "ok" | "error" | "off" (tools switched off) | "blocked" (kill switch)
    pub status: &'static str,
    pub detail: String,
    pub home_set: bool,
    pub latency_ms: Option<u64>,
}

static PROBE: Mutex<Option<(Instant, Result<u64, String>)>> = Mutex::new(None);

/// Live health: a tiny OSRM route (cached 60 s, `force` re-probes). Nominatim isn't
/// probed, so status checks never spend its 1 req/s budget.
#[tauri::command]
pub async fn maps_status(state: State<'_, DispatchState>, os: State<'_, OsState>, force: Option<bool>) -> Result<MapsStatus, String> {
    let cfg = os.snapshot();
    let home_set = super::envfile::env_or_file(&state, "MAP_HOME").is_some();
    let pid = provider(&state).id();
    let base = |status, detail: String, latency_ms| MapsStatus { provider: pid, status, detail, home_set, latency_ms };
    if cfg.privacy.kill_switch {
        return Ok(base("blocked", "Kill switch is on — online map services are blocked.".into(), None));
    }
    if !cfg.mcps.iter().any(|m| m.id == "maps" && m.enabled) {
        return Ok(base("off", "Maps tools are switched off.".into(), None));
    }
    let cached = PROBE.lock().unwrap().clone().filter(|(at, _)| !force.unwrap_or(false) && at.elapsed() < Duration::from_secs(60));
    let res = match cached {
        Some((_, r)) => r,
        None => {
            let started = Instant::now();
            let r = state
                .http
                .get(format!("{OSRM}/route/v1/driving/-79.3832,43.6532;-79.3800,43.6540"))
                .header(reqwest::header::USER_AGENT, USER_AGENT)
                .query(&[("overview", "false")])
                .timeout(Duration::from_secs(6))
                .send()
                .await
                .map_err(|e| format!("OSRM {}", short(e)))
                .and_then(|r| if r.status().is_success() { Ok(started.elapsed().as_millis() as u64) } else { Err(format!("OSRM HTTP {}", r.status().as_u16())) });
            *PROBE.lock().unwrap() = Some((Instant::now(), r.clone()));
            r
        }
    };
    Ok(match res {
        Ok(ms) => base("ok", "OpenStreetMap: OpenFreeMap tiles · Nominatim geocoding · OSRM routing (no live traffic)".into(), Some(ms)),
        Err(e) => base("error", e, None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn osrm_fixture() -> Value {
        json!({
            "code": "Ok",
            "routes": [{
                "distance": 5230.4, "duration": 754.2,
                "geometry": { "type": "LineString", "coordinates": [[-79.38, 43.65], [-79.40, 43.66]] },
                "legs": [{ "steps": [
                    { "distance": 120.0, "duration": 30.0, "name": "Bay Street", "maneuver": { "type": "depart" } },
                    { "distance": 5100.0, "duration": 720.0, "name": "King Street West", "maneuver": { "type": "turn", "modifier": "left" } },
                    { "distance": 0.0, "duration": 0.0, "name": "", "maneuver": { "type": "arrive" } }
                ]}]
            }]
        })
    }

    fn pts() -> Vec<Place> {
        vec![
            Place { lat: 43.65, lng: -79.38, label: "Union Station, Front Street, Toronto".into() },
            Place { lat: 43.66, lng: -79.40, label: "123 King Street West, Toronto, Ontario".into() },
        ]
    }

    #[test]
    fn osrm_route_parsed_with_geometry_steps_and_note() {
        let r = parse_osrm(&osrm_fixture(), &pts()).unwrap();
        assert_eq!(r.provider, "osm");
        assert_eq!(r.geometry["type"], "LineString");
        assert_eq!(r.steps.len(), 3);
        assert_eq!(r.steps[1].instruction, "Turn left onto King Street West");
        assert_eq!(r.steps[0].instruction, "Head out on Bay Street");
        assert!(!r.traffic_aware);
        assert_eq!(r.open_in_maps, "https://www.google.com/maps/dir/?api=1&destination=43.660000,-79.400000&travelmode=driving");
    }

    #[test]
    fn route_summary_has_eta_traffic_note_and_link() {
        let s = route_summary(&parse_osrm(&osrm_fixture(), &pts()).unwrap());
        assert!(s.starts_with("Driving Union Station, Front Street → 123 King Street West, Toronto: about 13 min for 5.2 km."), "{s}");
        assert!(s.contains("no live traffic"));
        assert!(s.contains("2. Turn left onto King Street West (5.1 km)"));
        assert!(s.contains("Open in Maps: https://www.google.com/maps/dir/"));
    }

    #[test]
    fn osrm_error_and_waypoints() {
        assert!(parse_osrm(&json!({ "code": "NoRoute", "message": "Impossible route" }), &pts()).unwrap_err().contains("Impossible route"));
        let mut three = pts();
        three.insert(1, Place { lat: 43.7, lng: -79.5, label: "Stop".into() });
        let u = open_in_maps_url(&three[2], &three[1..2]);
        assert!(u.ends_with("&waypoints=43.700000,-79.500000"));
    }

    #[test]
    fn nominatim_results_and_query_cache_key() {
        let v = json!([{ "lat": "43.6426", "lon": "-79.3871", "display_name": "CN Tower, Toronto" }, { "lat": "bad" }]);
        assert_eq!(parse_nominatim(&v), vec![Place { lat: 43.6426, lng: -79.3871, label: "CN Tower, Toronto".into() }]);
        assert_eq!(norm_query("  CN   Tower  Toronto "), "cn tower toronto");
    }

    #[test]
    fn latlng_and_stops_parsing() {
        assert_eq!(parse_latlng("43.65, -79.38"), Some((43.65, -79.38)));
        assert_eq!(parse_latlng("123 Main St, Toronto"), None);
        assert_eq!(parse_latlng("95,10"), None);
        assert_eq!(split_stops(Some(&json!("A | B;C"))), ["A", "B", "C"]);
        assert_eq!(split_stops(Some(&json!(["A", " ", "B"]))), ["A", "B"]);
    }

    #[test]
    fn durations_and_distances() {
        assert_eq!(fmt_duration(20.0), "under a minute");
        assert_eq!(fmt_duration(754.0), "13 min");
        assert_eq!(fmt_duration(3900.0), "1 h 5 min");
        assert_eq!(fmt_distance(347.0), "350 m");
        assert_eq!(fmt_distance(5230.0), "5.2 km");
    }

    #[test]
    fn route_cache_round_trips_and_caps() {
        let r = parse_osrm(&osrm_fixture(), &pts()).unwrap();
        static C: Mutex<Option<HashMap<String, (Instant, Route)>>> = Mutex::new(None);
        for i in 0..(CACHE_MAX + 5) {
            cache_put(&C, format!("k{i}"), r.clone(), ROUTE_TTL);
        }
        assert!(C.lock().unwrap().as_ref().unwrap().len() <= CACHE_MAX);
        assert_eq!(cache_get(&C, &format!("k{}", CACHE_MAX + 4), ROUTE_TTL), Some(r));
        assert_eq!(cache_get::<Route>(&C, "k0", ROUTE_TTL), None);
    }

    #[test]
    fn nominatim_limiter_spaces_requests_one_second_apart() {
        tauri::async_runtime::block_on(async {
            let t0 = Instant::now();
            nominatim_slot().await;
            nominatim_slot().await;
            nominatim_slot().await;
            // The first may go at once (or wait out a slot another test used); the next two wait ≥ 1 s each.
            assert!(t0.elapsed() >= Duration::from_millis(1990), "{:?}", t0.elapsed());
        });
    }
}
