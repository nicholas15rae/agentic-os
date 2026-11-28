//! Section 26: desktop Tony's switch to the built-in llama.cpp engine (engine/llama_engine.py).
//!
//! The switch lives in `engine.json` beside providers.json (the gateway reads the same file):
//! `enabled` (the gateway may run llama-server) and `route_tony` (Tony's chat goes to it). Both are
//! false by default, and anything wrong with the file (missing, unreadable, a non-loopback host)
//! reads as OFF, so Tony stays exactly on LM Studio.
//!
//! ON (`enabled && route_tony`), `effective` rewrites a COPY of the provider config for chat
//! turns only (`DispatchState::chat_snapshot`): `lmstudio` in the chain becomes `llamacpp`, which
//! is also made `primary_local`, with the base URL and alias from engine.json. LM Studio is NOT
//! kept behind it as a fallback: with one model on a 12 GB card, a request to an unloaded LM
//! Studio model would make it JIT-load a second copy next to the engine. The rest of the chain
//! (AnythingLLM, the gateway, the droplet) still catches a failed turn. providers.json itself is
//! never rewritten, so turning the switch off puts the chain back exactly as it was.
//!
//! `engine_switch_get` / `engine_switch_set` are the Settings toggle. Turning Tony ON is refused
//! unless the engine is enabled and answering `/health` with a model, so a click can never point
//! Tony at nothing.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::dispatch::{Config, DispatchState, Kind};

pub const FILE: &str = "engine.json";
pub const ENGINE_ID: &str = "llamacpp";
pub const LMSTUDIO_ID: &str = "lmstudio";
const DEFAULT_PORT: u16 = 1238;
const DEFAULT_ALIAS: &str = "qwen/qwen3.5-9b";
/// Ports the engine may never use (engine/llama_engine.py RESERVED_PORTS).
const RESERVED: [u16; 4] = [1235, 1236, 1237, 8080];

/// The parts of engine.json the desktop needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRoute {
    pub enabled: bool,
    pub route_tony: bool,
    pub route_agents: bool,
    pub base_url: String,
    pub alias: String,
}

impl EngineRoute {
    /// Desktop Tony's chat goes to the engine.
    pub fn tony_on(&self) -> bool {
        self.enabled && self.route_tony
    }
    /// The engine's origin (`http://127.0.0.1:1238`), for `/health`.
    pub fn origin(&self) -> String {
        self.base_url.trim_end_matches('/').trim_end_matches("/v1").to_string()
    }
}

fn loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Parse engine.json. None = unreadable or unsafe (a non-loopback host, a reserved port): OFF.
pub fn parse(text: &str) -> Option<EngineRoute> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let v: Map<String, Value> = serde_json::from_str(text).ok()?;
    let b = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let host = v.get("host").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = match v.get("port") {
        None => DEFAULT_PORT,
        Some(p) => u16::try_from(p.as_u64()?).ok()?,
    };
    if !loopback(host) || RESERVED.contains(&port) {
        return None;
    }
    let alias = v.get("alias").and_then(Value::as_str).filter(|a| !a.trim().is_empty()).unwrap_or(DEFAULT_ALIAS);
    let host = if host == "::1" { "[::1]" } else { host };
    Some(EngineRoute { enabled: b("enabled"), route_tony: b("route_tony"), route_agents: b("route_agents"), base_url: format!("http://{host}:{port}/v1"), alias: alias.to_string() })
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// engine.json in `dir`. Missing / broken: OFF (None).
pub fn read(dir: &Path) -> Option<EngineRoute> {
    std::fs::read_to_string(path_in(dir)).ok().and_then(|t| parse(&t))
}

/// The provider config chat turns use: `cfg` unchanged unless the route is ON (pure).
pub fn effective(mut cfg: Config, route: Option<&EngineRoute>) -> Config {
    let Some(r) = route.filter(|r| r.tony_on()) else { return cfg };
    match cfg.providers.iter_mut().find(|p| p.id == ENGINE_ID) {
        Some(p) => {
            p.base_url = r.base_url.clone();
            p.model = r.alias.clone();
            p.kind = Kind::Local;
        }
        None => {
            let mut p = cfg.providers.iter().find(|p| p.id == LMSTUDIO_ID).cloned().unwrap_or_else(|| Config::default().providers.into_iter().find(|p| p.id == ENGINE_ID).expect("default llamacpp"));
            p.id = ENGINE_ID.into();
            p.label = "Built-in engine (llama.cpp)".into();
            p.kind = Kind::Local;
            p.base_url = r.base_url.clone();
            p.model = r.alias.clone();
            p.needs_key = false;
            p.custom = false;
            cfg.providers.push(p);
        }
    }
    let mut chain: Vec<String> = cfg.policy.chain.iter().map(|id| if id == LMSTUDIO_ID { ENGINE_ID.to_string() } else { id.clone() }).collect();
    if !chain.iter().any(|id| id == ENGINE_ID) {
        chain.insert(0, ENGINE_ID.into());
    }
    let mut seen = std::collections::HashSet::new();
    chain.retain(|id| seen.insert(id.clone()));
    cfg.policy.chain = chain;
    if cfg.policy.primary_local == LMSTUDIO_ID {
        cfg.policy.primary_local = ENGINE_ID.into();
    }
    cfg
}

/// Which backend Tony's chat uses right now (for the UI and `infra_status`).
pub fn chat_backend(route: Option<&EngineRoute>) -> &'static str {
    if route.is_some_and(EngineRoute::tony_on) {
        "engine"
    } else {
        "lmstudio"
    }
}

// ── Settings toggle ───────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SwitchView {
    /// engine.json as the desktop reads it (None: missing or unsafe = everything off).
    pub route: Option<EngineRoute>,
    /// Where Tony's chat goes now: "engine" | "lmstudio".
    pub chat: &'static str,
    /// Memory / documents: still AnythingLLM + the vault on the desktop (the engine's doc store
    /// runs on the gateway; joining it to the vault is Nic's call).
    pub memory: &'static str,
    /// Compaction (memory scrolls) follows Tony's chat backend.
    pub compaction: &'static str,
    /// `/health` of the engine: "ok" | "loading" | "down" | "error".
    pub health: String,
    /// The model the engine serves (its /v1/models), if up.
    pub served: Option<String>,
    pub path: String,
}

pub async fn health(http: &reqwest::Client, origin: &str) -> (String, Option<String>) {
    let h = match http.get(format!("{origin}/health")).timeout(Duration::from_secs(3)).send().await {
        Ok(r) if r.status().is_success() => "ok",
        Ok(r) if r.status().as_u16() == 503 => "loading",
        Ok(_) => "error",
        Err(_) => "down",
    };
    let served = if h == "ok" {
        match http.get(format!("{origin}/v1/models")).timeout(Duration::from_secs(3)).send().await {
            Ok(r) => r.json::<Value>().await.ok().and_then(|v| v["data"][0]["id"].as_str().map(String::from)),
            Err(_) => None,
        }
    } else {
        None
    };
    (h.to_string(), served)
}

async fn view(state: &DispatchState) -> Result<SwitchView, String> {
    let dir = state.config_dir().ok_or("no config folder yet")?;
    let route = read(&dir);
    let origin = route.as_ref().map(EngineRoute::origin).unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    let (health, served) = health(&state.http, &origin).await;
    let chat = chat_backend(route.as_ref());
    Ok(SwitchView { route, chat, memory: "anythingllm", compaction: chat, health, served, path: path_in(&dir).display().to_string() })
}

#[tauri::command]
pub async fn engine_switch_get(state: tauri::State<'_, DispatchState>) -> Result<SwitchView, String> {
    view(&state).await
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwitchPatch {
    pub enabled: Option<bool>,
    pub route_tony: Option<bool>,
    pub route_agents: Option<bool>,
}

/// Why turning Tony ON must be refused, if it must (pure): the engine has to be enabled and
/// answering with a model first.
pub fn refuse_tony_on(enabled: bool, health: &str, served: Option<&str>) -> Option<String> {
    if !enabled {
        return Some("Turn the built-in engine on first (and let it load Tony's model).".into());
    }
    if health != "ok" || served.is_none() {
        return Some(format!("The built-in engine isn't answering yet ({health}). Start it (gateway: Load on the Built-in engine card), then switch Tony."));
    }
    None
}

/// Merge `patch` into engine.json's object, keeping every other key (pure). Turning the engine
/// off also turns both routes off, so a stale `route_tony` can never point at a stopped engine.
pub fn merged(existing: Option<&str>, patch: &SwitchPatch) -> Result<Map<String, Value>, String> {
    let mut m: Map<String, Value> = match existing {
        Some(t) if !t.trim().is_empty() => serde_json::from_str(t.strip_prefix('\u{feff}').unwrap_or(t)).map_err(|e| format!("engine.json is unreadable ({e}); fix or delete it first"))?,
        _ => Map::new(),
    };
    for (k, v) in [("enabled", patch.enabled), ("route_tony", patch.route_tony), ("route_agents", patch.route_agents)] {
        if let Some(v) = v {
            m.insert(k.into(), Value::Bool(v));
        }
    }
    if patch.enabled == Some(false) {
        m.insert("route_tony".into(), Value::Bool(false));
        m.insert("route_agents".into(), Value::Bool(false));
    }
    Ok(m)
}

#[tauri::command]
pub async fn engine_switch_set(state: tauri::State<'_, DispatchState>, patch: SwitchPatch) -> Result<SwitchView, String> {
    let dir = state.config_dir().ok_or("no config folder yet")?;
    let path = path_in(&dir);
    let existing = std::fs::read_to_string(&path).ok();
    let m = merged(existing.as_deref(), &patch)?;
    let after = parse(&serde_json::to_string(&m).map_err(|e| e.to_string())?).ok_or("engine.json would be unsafe (host/port); not saved")?;
    if patch.route_tony == Some(true) || (patch.route_agents == Some(true)) {
        let (h, served) = health(&state.http, &after.origin()).await;
        if let Some(why) = refuse_tony_on(after.enabled, &h, served.as_deref()) {
            return Err(why);
        }
    }
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("save {}: {e}", path.display()))?;
    crate::security::audit::log("engine_switch", crate::security::audit::Severity::Warn, crate::security::audit::Outcome::Success, Some("engine"), "settings", serde_json::json!({ "enabled": after.enabled, "routeTony": after.route_tony, "routeAgents": after.route_agents }));
    view(&state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> EngineRoute {
        parse(r#"{"enabled":true,"route_tony":true}"#).unwrap()
    }

    #[test]
    fn off_by_default_and_fails_closed() {
        let d = Config::default();
        for t in ["", "{broken", r#"{"route_tony":true}"#, r#"{"enabled":true}"#, r#"{"enabled":true,"route_tony":true,"host":"0.0.0.0"}"#, r#"{"enabled":true,"route_tony":true,"port":1235}"#] {
            let r = parse(t);
            assert!(!r.as_ref().is_some_and(EngineRoute::tony_on), "{t}");
            let e = effective(d.clone(), r.as_ref());
            assert_eq!(e.policy.chain, d.policy.chain, "{t}");
            assert_eq!(e.policy.primary_local, "lmstudio");
            assert_eq!(chat_backend(r.as_ref()), "lmstudio");
        }
        assert!(read(Path::new("Z:/definitely/not/here")).is_none());
    }

    #[test]
    fn on_swaps_lmstudio_for_the_engine_without_a_lmstudio_fallback() {
        let d = Config::default();
        let e = effective(d.clone(), Some(&on()));
        assert_eq!(e.policy.chain[0], "llamacpp");
        assert!(!e.policy.chain.iter().any(|id| id == "lmstudio"));
        assert_eq!(e.policy.chain.len(), d.policy.chain.len());
        assert_eq!(e.policy.primary_local, "llamacpp");
        let p = e.providers.iter().find(|p| p.id == "llamacpp").unwrap();
        assert_eq!((p.base_url.as_str(), p.model.as_str()), ("http://127.0.0.1:1238/v1", "qwen/qwen3.5-9b"));
        assert_eq!(chat_backend(Some(&on())), "engine");
        // The verifier and every other provider are untouched.
        assert_eq!(e.policy.verifier, d.policy.verifier);
        assert_eq!(e.providers.iter().find(|p| p.id == "lmstudio").unwrap().base_url, "http://127.0.0.1:1235/v1");
    }

    #[test]
    fn on_with_an_old_providers_json_adds_the_engine_and_custom_port_alias() {
        let mut d = Config::default();
        d.providers.retain(|p| p.id != "llamacpp");
        d.policy.chain = vec!["agentic-os".into(), "lmstudio".into()];
        let r = parse(r#"{"enabled":true,"route_tony":true,"port":1240,"alias":"my-model"}"#).unwrap();
        let e = effective(d, Some(&r));
        assert_eq!(e.policy.chain, vec!["agentic-os".to_string(), "llamacpp".to_string()]);
        let p = e.providers.iter().find(|p| p.id == "llamacpp").unwrap();
        assert_eq!((p.base_url.as_str(), p.model.as_str(), p.kind), ("http://127.0.0.1:1240/v1", "my-model", Kind::Local));
        assert_eq!(r.origin(), "http://127.0.0.1:1240");
        // A chain without LM Studio gets the engine in front, once.
        let mut d = Config::default();
        d.policy.chain = vec!["droplet".into()];
        assert_eq!(effective(d, Some(&on())).policy.chain, vec!["llamacpp".to_string(), "droplet".to_string()]);
    }

    #[test]
    fn switch_merge_keeps_other_keys_and_off_clears_the_routes() {
        let m = merged(Some(r#"{"model_path":"D:/m.gguf","enabled":true,"route_tony":true,"ctx":32768}"#), &SwitchPatch { enabled: Some(false), ..Default::default() }).unwrap();
        assert_eq!(m["model_path"], "D:/m.gguf");
        assert_eq!(m["ctx"], 32768);
        assert_eq!((m["enabled"].as_bool(), m["route_tony"].as_bool(), m["route_agents"].as_bool()), (Some(false), Some(false), Some(false)));
        let m = merged(None, &SwitchPatch { route_tony: Some(true), ..Default::default() }).unwrap();
        assert_eq!(m.len(), 1);
        assert!(merged(Some("{broken"), &SwitchPatch::default()).is_err());
    }

    #[test]
    fn tony_on_is_refused_until_the_engine_answers() {
        assert!(refuse_tony_on(false, "ok", Some("qwen")).is_some());
        assert!(refuse_tony_on(true, "down", None).is_some());
        assert!(refuse_tony_on(true, "loading", None).is_some());
        assert!(refuse_tony_on(true, "ok", None).is_some());
        assert!(refuse_tony_on(true, "ok", Some("qwen/qwen3.5-9b")).is_none());
    }

    #[test]
    fn chat_snapshot_reads_engine_json_beside_providers_json() {
        let dir = std::env::temp_dir().join(format!("cc-engine-route-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let st = DispatchState::default();
        st.set_path_for_tests(dir.join("providers.json"));
        assert_eq!(st.chat_snapshot().policy.chain[0], "lmstudio");
        std::fs::write(dir.join(FILE), r#"{"enabled":true,"route_tony":true}"#).unwrap();
        assert_eq!(st.chat_snapshot().policy.chain[0], "llamacpp");
        assert_eq!(st.snapshot().policy.chain[0], "lmstudio", "Settings' own view never changes");
        std::fs::write(dir.join(FILE), r#"{"enabled":false,"route_tony":true}"#).unwrap();
        assert_eq!(st.chat_snapshot().policy.chain[0], "lmstudio");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── Engine control calls (the Engine / Models screen) ──────────────────────────

/// The engine sidecar (`python -m engine.serve`): the engine's routes from the branch's code while
/// the real gateway runs code without them.
pub const SIDECAR: &str = "http://127.0.0.1:8081";

/// Only the engine's own routes go through `engine_call` (pure).
pub fn engine_path_ok(method: &str, path: &str) -> bool {
    matches!(method, "GET" | "POST" | "PUT") && path.starts_with("/api/engine/") && !path.contains("..") && !path.contains('#') && path.len() < 512
}

/// Where to try, in order: the gateway, then the sidecar (pure).
pub fn engine_bases(gateway: &str) -> Vec<String> {
    let g = gateway.trim_end_matches('/').to_string();
    if g == SIDECAR {
        vec![g]
    } else {
        vec![g, SIDECAR.to_string()]
    }
}

/// One `/api/engine/*` call: the gateway first; a 404 there (its code has no engine routes yet)
/// or no answer at all tries the sidecar. Err = "<status> <detail>" like the gateway client.
#[tauri::command]
pub async fn engine_call(state: tauri::State<'_, DispatchState>, method: String, path: String, body: Option<Value>, timeout_secs: Option<u64>) -> Result<Value, String> {
    let method = method.to_ascii_uppercase();
    if !engine_path_ok(&method, &path) {
        return Err("only /api/engine/* routes".into());
    }
    let secs = timeout_secs.unwrap_or(15).clamp(1, 600);
    let mut last = String::from("engine routes not reachable (gateway and sidecar)");
    for base in engine_bases(&state.snapshot().gateway.url) {
        let url = format!("{base}{path}");
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut rq = state.http.request(m, &url).timeout(Duration::from_secs(secs));
        if let Some(b) = &body {
            rq = rq.json(b);
        }
        match rq.send().await {
            Ok(r) if r.status().as_u16() == 404 => last = format!("404 at {base} (no engine routes there)"),
            Ok(r) => {
                let code = r.status();
                let v = r.json::<Value>().await.unwrap_or(Value::Null);
                if code.is_success() {
                    return Ok(v);
                }
                return Err(format!("{} {}", code.as_u16(), v["detail"].as_str().unwrap_or("")));
            }
            Err(e) => last = format!("{base}: {}", super::dispatch::short(e)),
        }
    }
    Err(last)
}

#[cfg(test)]
mod call_tests {
    use super::*;

    #[test]
    fn only_engine_routes_and_gateway_first() {
        assert!(engine_path_ok("GET", "/api/engine/models?fit=1"));
        assert!(engine_path_ok("POST", "/api/engine/test"));
        for (m, p) in [("GET", "/api/os/inbox"), ("DELETE", "/api/engine/status"), ("GET", "/api/engine/../os/gpu"), ("GET", "http://evil/api/engine/x")] {
            assert!(!engine_path_ok(m, p), "{m} {p}");
        }
        assert_eq!(engine_bases("http://127.0.0.1:8080/"), vec!["http://127.0.0.1:8080".to_string(), SIDECAR.to_string()]);
        assert_eq!(engine_bases(SIDECAR), vec![SIDECAR.to_string()]);
    }
}
