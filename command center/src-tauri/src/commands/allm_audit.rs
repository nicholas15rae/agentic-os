//! Read-only AnythingLLM workspace audit (Tauri command `anythingllm_workspace_audit`).
//!
//! GETs only (`/v1/workspaces`, `/v1/system` LLM keys, LM Studio `/api/v1/models`); it REPORTS
//! and never writes, renames, re-maps or deletes anything. Findings:
//! - duplicate display names (`my-workspace` and `booking` are both "Booking");
//! - a role mapped to a workspace named for another role (`general` → "Booking");
//! - two roles sharing a slug; a mapped slug that doesn't exist;
//! - unused workspaces (no threads) and workspaces no role maps to;
//! - no pinned chat provider (AnythingLLM's system default);
//! - `chatMode` automatic / agent on a pipeline or Librarian role (agent tools can run);
//! - leading / trailing spaces in a name ("Librarian ");
//! - a chat / agent model that isn't the model LM Studio has loaded (a second model would JIT-load);
//! - AnythingLLM's LM Studio token limit above the loaded context;
//! - the keychain host for the AnythingLLM key differing from `anythingllm.baseUrl`.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::State;

use super::agents::WorkspaceInfo;
use super::allm::{AllmConn, AllmReader, LlmSettings};
use super::dispatch::DispatchState;
use super::os_core::{OsConfig, OsState};

/// Roles whose turns run as pipeline stages (or the read-only Librarian): agent / automatic
/// chat mode there means a stage could call AnythingLLM's global tools.
pub const GUARDED_ROLES: [&str; 4] = ["prompter", "designer", "coder", "librarian"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditWorkspace {
    pub slug: String,
    /// Exactly as AnythingLLM stores it (spaces included).
    pub name: String,
    pub threads: usize,
    pub chat_mode: Option<String>,
    pub chat_provider: Option<String>,
    pub chat_model: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_model: Option<String>,
    /// Roles mapped to this slug in os.json.
    pub roles: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditFinding {
    /// duplicate_name | name_mismatch | shared_slug | dead_slug | unused | unmapped |
    /// no_pinned_provider | automatic_mode | name_whitespace | model_mismatch |
    /// token_limit_mismatch | key_host_mismatch
    pub kind: String,
    /// "warn" | "info"
    pub severity: String,
    pub slugs: Vec<String>,
    pub role: Option<String>,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub key: String,
    pub context: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllmAudit {
    pub workspaces: Vec<AuditWorkspace>,
    pub loaded_model: Option<LoadedModel>,
    pub llm_settings: Option<LlmSettings>,
    pub findings: Vec<AuditFinding>,
    /// Always true: the audit made GET requests only.
    pub read_only: bool,
}

fn opt(w: &Value, k: &str) -> Option<String> {
    w[k].as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from)
}

/// `/v1/workspaces` JSON → audit rows (pure).
pub fn parse(v: &Value, roles: &BTreeMap<String, String>) -> Vec<AuditWorkspace> {
    v["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            let slug = w["slug"].as_str().unwrap_or("").to_string();
            AuditWorkspace {
                roles: roles.iter().filter(|(_, s)| **s == slug).map(|(r, _)| r.clone()).collect(),
                slug,
                name: w["name"].as_str().unwrap_or("").to_string(),
                threads: w["threads"].as_array().map(|t| t.len()).unwrap_or(0),
                chat_mode: opt(w, "chatMode"),
                chat_provider: opt(w, "chatProvider"),
                chat_model: opt(w, "chatModel"),
                agent_provider: opt(w, "agentProvider"),
                agent_model: opt(w, "agentModel"),
            }
        })
        .collect()
}

fn norm(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Words that name a role in a workspace name.
fn role_words(role: &str, os_name: &str) -> Vec<String> {
    let mut w: Vec<String> = match role {
        "general" => vec!["general".into(), "tony".into()],
        "prompter" => vec!["prompter".into(), "dispatcher".into()],
        "booking" => vec!["booking".into()],
        r => vec![r.to_string()],
    };
    if role == "general" && !os_name.trim().is_empty() {
        w.push(os_name.trim().to_lowercase());
    }
    w
}

fn names_role(name: &str, role: &str, os_name: &str) -> bool {
    let n = norm(name);
    let words: Vec<&str> = n.split(|c: char| !c.is_alphanumeric()).filter(|x| !x.is_empty()).collect();
    role_words(role, os_name).iter().any(|r| words.contains(&r.as_str()))
}

/// The role a workspace NAME belongs to, if it names a different role than `role` (pure).
pub fn name_mismatch(role: &str, name: &str, os_name: &str, all_roles: &[String]) -> Option<String> {
    if names_role(name, role, os_name) {
        return None;
    }
    all_roles.iter().find(|r| r.as_str() != role && names_role(name, r, os_name)).cloned()
}

/// Other workspaces whose (normalised) display name equals this one's (pure).
pub fn duplicates_of(slug: &str, name: &str, all: &[(String, String)]) -> Vec<String> {
    let n = norm(name);
    if n.is_empty() {
        return vec![];
    }
    all.iter().filter(|(s, other)| s != slug && norm(other) == n).map(|(s, _)| s.clone()).collect()
}

/// A workspace model that isn't the loaded one (pure). `None` = fine or unknown.
pub fn model_mismatch(chat: Option<&str>, agent: Option<&str>, loaded: Option<&str>) -> Option<String> {
    let loaded = loaded?;
    [("chat", chat), ("agent", agent)].iter().find_map(|(k, m)| m.filter(|m| *m != loaded).map(|m| format!("{k} model {m} ≠ loaded {loaded}")))
}

fn finding(kind: &str, severity: &str, slugs: Vec<String>, role: Option<&str>, detail: String) -> AuditFinding {
    AuditFinding { kind: kind.into(), severity: severity.into(), slugs, role: role.map(String::from), detail }
}

/// The whole audit (pure).
pub fn audit(workspaces_json: &Value, roles: &BTreeMap<String, String>, os_name: &str, loaded: Option<LoadedModel>, settings: Option<LlmSettings>, key_host_note: Option<String>) -> AllmAudit {
    let ws = parse(workspaces_json, roles);
    let names: Vec<(String, String)> = ws.iter().map(|w| (w.slug.clone(), w.name.clone())).collect();
    let role_ids: Vec<String> = roles.keys().cloned().collect();
    let loaded_key = loaded.as_ref().map(|l| l.key.clone());
    let mut f: Vec<AuditFinding> = vec![];

    // Duplicate display names (one finding per group).
    let mut seen: Vec<String> = vec![];
    for w in &ws {
        let dups = duplicates_of(&w.slug, &w.name, &names);
        if !dups.is_empty() && !seen.contains(&norm(&w.name)) {
            seen.push(norm(&w.name));
            let mut slugs = vec![w.slug.clone()];
            slugs.extend(dups);
            f.push(finding("duplicate_name", "warn", slugs.clone(), None, format!("{} workspaces are named \"{}\": {}", slugs.len(), w.name.trim(), slugs.join(", "))));
        }
    }
    // Per mapped role.
    let mut by_slug: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (role, slug) in roles.iter().filter(|(_, s)| !s.is_empty()) {
        by_slug.entry(slug.as_str()).or_default().push(role.as_str());
        let Some(w) = ws.iter().find(|w| &w.slug == slug) else {
            f.push(finding("dead_slug", "warn", vec![slug.clone()], Some(role), format!("role {role} maps to \"{slug}\", which doesn't exist")));
            continue;
        };
        if let Some(other) = name_mismatch(role, &w.name, os_name, &role_ids) {
            f.push(finding("name_mismatch", "warn", vec![slug.clone()], Some(role), format!("role {role} maps to \"{slug}\", a workspace named \"{}\" (a {other} name)", w.name.trim())));
        }
        if w.chat_provider.is_none() {
            f.push(finding("no_pinned_provider", if GUARDED_ROLES.contains(&role.as_str()) { "warn" } else { "info" }, vec![slug.clone()], Some(role), format!("\"{slug}\" has no pinned chat provider (AnythingLLM's system default)")));
        }
        if let Some(mode) = w.chat_mode.as_deref().filter(|m| matches!(*m, "automatic" | "agent")) {
            f.push(finding("automatic_mode", if GUARDED_ROLES.contains(&role.as_str()) { "warn" } else { "info" }, vec![slug.clone()], Some(role), format!("\"{slug}\" ({role}) is in chatMode \"{mode}\": AnythingLLM's global agent tools can run there")));
        }
    }
    for (slug, rs) in &by_slug {
        if rs.len() > 1 {
            f.push(finding("shared_slug", "info", vec![slug.to_string()], None, format!("roles {} share \"{slug}\"", rs.join(", "))));
        }
    }
    // Per workspace.
    for w in &ws {
        if w.name != w.name.trim() {
            f.push(finding("name_whitespace", "info", vec![w.slug.clone()], None, format!("\"{}\" has leading or trailing spaces in its name", w.name)));
        }
        if w.threads == 0 {
            f.push(finding("unused", "info", vec![w.slug.clone()], w.roles.first().map(String::as_str), format!("\"{}\" has no threads", w.slug)));
        }
        if w.roles.is_empty() {
            f.push(finding("unmapped", "info", vec![w.slug.clone()], None, format!("no role maps to \"{}\"", w.slug)));
        }
        if let Some(m) = model_mismatch(w.chat_model.as_deref(), w.agent_model.as_deref(), loaded_key.as_deref()) {
            f.push(finding("model_mismatch", "warn", vec![w.slug.clone()], w.roles.first().map(String::as_str), format!("\"{}\": {m} (a second model would load next to it)", w.slug)));
        }
    }
    if let (Some(limit), Some(ctx)) = (settings.as_ref().and_then(|s| s.lmstudio_token_limit), loaded.as_ref().and_then(|l| l.context)) {
        if limit > ctx {
            f.push(finding("token_limit_mismatch", "warn", vec![], None, format!("AnythingLLM budgets {limit} tokens for LM Studio but the loaded model has a {ctx} context")));
        }
    }
    if let Some(note) = key_host_note {
        f.push(finding("key_host_mismatch", "warn", vec![], None, note));
    }
    AllmAudit { workspaces: ws, loaded_model: loaded, llm_settings: settings, findings: f, read_only: true }
}

/// Per-role flags for the System Map's agents block (pure): duplicateOf, unused, nameMismatch,
/// modelMismatch.
pub fn role_flags(role: &str, slug: &str, workspaces: &[WorkspaceInfo], os_name: &str, all_roles: &[String], loaded: Option<&str>) -> Value {
    let Some(w) = workspaces.iter().find(|w| w.slug == slug) else {
        return serde_json::json!({ "duplicateOf": [], "unused": null, "nameMismatch": null, "modelMismatch": null });
    };
    let names: Vec<(String, String)> = workspaces.iter().map(|w| (w.slug.clone(), w.name.clone())).collect();
    serde_json::json!({
        "duplicateOf": duplicates_of(slug, &w.name, &names),
        "unused": w.threads == 0,
        "nameMismatch": name_mismatch(role, &w.name, os_name, all_roles),
        "modelMismatch": model_mismatch(w.chat_model.as_deref(), w.agent_model.as_deref(), loaded),
    })
}

/// The LLM LM Studio has loaded (GET `/api/v1/models` on the `lmstudio` provider's origin).
pub(crate) async fn loaded_lmstudio_model(state: &DispatchState, secs: u64) -> Option<LoadedModel> {
    let p = state.provider("lmstudio")?;
    let u = url::Url::parse(&p.base_url).ok()?;
    let v: Value = state.http.get(format!("{}/api/v1/models", u.origin().ascii_serialization())).timeout(Duration::from_secs(secs)).send().await.ok()?.json().await.ok()?;
    pick_loaded(&v)
}

/// The first loaded LLM in an LM Studio `/api/v1/models` listing (pure).
pub fn pick_loaded(v: &Value) -> Option<LoadedModel> {
    v["models"].as_array()?.iter().filter(|m| m["type"] == "llm").find_map(|m| {
        let inst = m["loaded_instances"].as_array()?.first()?;
        Some(LoadedModel { key: m["key"].as_str()?.to_string(), context: inst["config"]["context_length"].as_u64() })
    })
}

pub(crate) async fn run(state: &DispatchState, cfg: &OsConfig) -> Result<AllmAudit, String> {
    let note = super::secrets::warn_allm_host_mismatch(state, &cfg.anythingllm.base_url);
    let reader = AllmReader::new(AllmConn::local(state, cfg)?);
    let ws = reader.list_workspaces(8).await?;
    let settings = reader.llm_settings(8).await.ok();
    let loaded = loaded_lmstudio_model(state, 5).await;
    Ok(audit(&ws, &cfg.anythingllm.workspaces, &cfg.os_name, loaded, settings, note))
}

/// Read-only workspace audit for Settings / the System Map.
#[tauri::command]
pub async fn anythingllm_workspace_audit(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<AllmAudit, String> {
    run(&state, &os.snapshot()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The live install as mapped on 2026-11-19 (names, modes and models from the read-only audit).
    fn live_fixture() -> (Value, BTreeMap<String, String>) {
        let t = |n: usize| (0..n).map(|i| json!({ "user_id": null, "slug": format!("t{i}") })).collect::<Vec<_>>();
        let ws = json!({ "workspaces": [
            { "slug": "my-workspace", "name": "Booking", "chatMode": "automatic", "chatProvider": "lmstudio", "chatModel": "qwen/qwen3.5-9b", "agentProvider": "lmstudio", "agentModel": "qwen/qwen3.5-9b", "threads": t(1) },
            { "slug": "coder", "name": "Coder", "chatMode": "chat", "chatProvider": "lmstudio", "chatModel": "qwen/qwen3.5-9b", "agentProvider": "lmstudio", "agentModel": "qwen2.5-coder-14b-instruct", "threads": t(2) },
            { "slug": "librarian", "name": "Librarian ", "chatMode": "automatic", "chatProvider": null, "chatModel": null, "threads": t(1) },
            { "slug": "prompter-dispatcher", "name": "Prompter / Dispatcher", "chatMode": "chat", "chatProvider": "lmstudio", "chatModel": "qwen/qwen3.5-9b", "agentProvider": "lmstudio", "agentModel": "qwen/qwen3.5-9b", "threads": t(3) },
            { "slug": "booking", "name": "Booking", "chatMode": "chat", "chatProvider": null, "threads": t(12) },
            { "slug": "ops", "name": "Ops", "chatMode": "chat", "chatProvider": null, "threads": [] },
            { "slug": "designer", "name": "Designer", "chatMode": "chat", "chatProvider": null, "threads": [] }
        ]});
        let roles = [("booking", "booking"), ("coder", "coder"), ("designer", "designer"), ("general", "my-workspace"), ("librarian", "librarian"), ("ops", "ops"), ("prompter", "prompter-dispatcher")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        (ws, roles)
    }

    fn has(a: &AllmAudit, kind: &str, slug: &str) -> bool {
        a.findings.iter().any(|f| f.kind == kind && (slug.is_empty() || f.slugs.iter().any(|s| s == slug)))
    }

    #[test]
    fn audit_flags_the_live_shaped_fixture() {
        let (ws, roles) = live_fixture();
        let loaded = Some(LoadedModel { key: "qwen/qwen3.5-9b".into(), context: Some(16384) });
        let settings = Some(LlmSettings { llm_provider: Some("lmstudio".into()), lmstudio_model_pref: Some("qwen/qwen3.5-9b".into()), lmstudio_token_limit: Some(32768) });
        let a = audit(&ws, &roles, "Tony", loaded, settings, None);
        assert!(a.read_only);
        // Two "Booking": one finding naming both slugs.
        let dup: Vec<&AuditFinding> = a.findings.iter().filter(|f| f.kind == "duplicate_name").collect();
        assert_eq!(dup.len(), 1);
        assert_eq!(dup[0].slugs, vec!["my-workspace".to_string(), "booking".to_string()]);
        // general → "Booking".
        assert!(a.findings.iter().any(|f| f.kind == "name_mismatch" && f.role.as_deref() == Some("general") && f.detail.contains("booking name")));
        assert_eq!(a.findings.iter().filter(|f| f.kind == "name_mismatch").count(), 1, "{:#?}", a.findings);
        // ops / designer unused.
        assert!(has(&a, "unused", "ops") && has(&a, "unused", "designer"));
        assert!(!has(&a, "unused", "booking"));
        // No pinned provider: designer and librarian (warn), booking / ops (info).
        let np = |slug: &str| a.findings.iter().find(|f| f.kind == "no_pinned_provider" && f.slugs[0] == slug).map(|f| f.severity.clone());
        assert_eq!(np("designer").as_deref(), Some("warn"));
        assert_eq!(np("librarian").as_deref(), Some("warn"));
        assert_eq!(np("booking").as_deref(), Some("info"));
        assert_eq!(np("coder"), None);
        // Librarian automatic (warn) + trailing space; general automatic is info only.
        assert!(a.findings.iter().any(|f| f.kind == "automatic_mode" && f.role.as_deref() == Some("librarian") && f.severity == "warn"));
        assert!(a.findings.iter().any(|f| f.kind == "automatic_mode" && f.role.as_deref() == Some("general") && f.severity == "info"));
        assert!(has(&a, "name_whitespace", "librarian"));
        // Coder's agent model ≠ the loaded 9B.
        assert!(a.findings.iter().any(|f| f.kind == "model_mismatch" && f.slugs[0] == "coder" && f.detail.contains("qwen2.5-coder-14b-instruct")));
        assert!(!has(&a, "model_mismatch", "prompter-dispatcher"));
        // 32k budget against a 16k context.
        assert!(has(&a, "token_limit_mismatch", ""));
        // Nothing dead, nothing unmapped (every slug has a role).
        assert!(!has(&a, "dead_slug", "") && !has(&a, "unmapped", ""));
    }

    #[test]
    fn dead_shared_and_unmapped() {
        let ws = json!({ "workspaces": [{ "slug": "a", "name": "A", "threads": [{ "slug": "x" }] }, { "slug": "spare", "name": "Spare", "threads": [] }] });
        let roles = [("coder", "a"), ("designer", "a"), ("ops", "gone"), ("booking", "")].iter().map(|(r, s)| (r.to_string(), s.to_string())).collect();
        let a = audit(&ws, &roles, "Tony", None, None, Some("host differs".into()));
        assert!(has(&a, "dead_slug", "gone"));
        assert!(has(&a, "shared_slug", "a"));
        assert!(has(&a, "unmapped", "spare"));
        assert!(has(&a, "key_host_mismatch", ""));
        assert!(!has(&a, "model_mismatch", ""), "no loaded model known → no model claims");
    }

    #[test]
    fn role_flags_for_the_system_map() {
        let (ws, roles) = live_fixture();
        let infos = super::super::agents::parse_workspaces(&ws);
        let all: Vec<String> = roles.keys().cloned().collect();
        let g = role_flags("general", "my-workspace", &infos, "Tony", &all, Some("qwen/qwen3.5-9b"));
        assert_eq!(g["duplicateOf"], json!(["booking"]));
        assert_eq!(g["nameMismatch"], json!("booking"));
        assert_eq!(g["unused"], json!(false));
        let c = role_flags("coder", "coder", &infos, "Tony", &all, Some("qwen/qwen3.5-9b"));
        assert!(c["modelMismatch"].as_str().unwrap().contains("agent model"));
        assert_eq!(c["nameMismatch"], Value::Null);
        assert_eq!(role_flags("ops", "ops", &infos, "Tony", &all, None)["unused"], json!(true));
        assert_eq!(role_flags("prompter", "prompter-dispatcher", &infos, "Tony", &all, None)["nameMismatch"], Value::Null);
        assert_eq!(role_flags("ops", "missing", &infos, "Tony", &all, None)["unused"], Value::Null);
    }

    #[test]
    fn pick_loaded_model() {
        let v = json!({ "models": [
            { "key": "text-embedding-nomic", "type": "embedding", "loaded_instances": [{ "id": "e" }] },
            { "key": "qwen2.5-coder-14b-instruct", "type": "llm", "loaded_instances": [] },
            { "key": "qwen/qwen3.5-9b", "type": "llm", "loaded_instances": [{ "id": "q", "config": { "context_length": 16384 } }] }
        ]});
        assert_eq!(pick_loaded(&v), Some(LoadedModel { key: "qwen/qwen3.5-9b".into(), context: Some(16384) }));
        assert_eq!(pick_loaded(&json!({ "models": [] })), None);
    }

    /// The audit command's HTTP traffic is GET-only (mocked AnythingLLM + LM Studio).
    #[test]
    fn audit_makes_get_requests_only() {
        use super::super::allm::mock::{start, Req, Resp};
        tauri::async_runtime::block_on(async {
            let (ws, _) = live_fixture();
            let srv = start(move |r: &Req| match r.path.as_str() {
                "/api/v1/workspaces" => Resp::json(ws.clone()),
                "/api/v1/system" => Resp::json(json!({ "settings": { "LMStudioTokenLimit": "32768", "LLMProvider": "lmstudio", "SomeKey": "secret-value" } })),
                "/api/v1/models" => Resp::json(json!({ "models": [{ "key": "qwen/qwen3.5-9b", "type": "llm", "loaded_instances": [{ "id": "q", "config": { "context_length": 16384 } }] }] })),
                _ => Resp::status(404, json!({})),
            })
            .await;
            let st = DispatchState::default();
            st.update(|c| {
                for p in c.providers.iter_mut().filter(|p| p.id == "lmstudio") {
                    p.base_url = format!("{}/v1", srv.base);
                }
                Ok(())
            })
            .unwrap();
            let mut cfg = OsConfig::default();
            cfg.anythingllm.base_url = srv.base.clone();
            let reader = AllmReader::new(AllmConn::from_cfg_key(&st, &cfg, "k".into()));
            let w = reader.list_workspaces(5).await.unwrap();
            let settings = reader.llm_settings(5).await.ok();
            let loaded = loaded_lmstudio_model(&st, 5).await;
            let a = audit(&w, &cfg.anythingllm.workspaces, &cfg.os_name, loaded, settings.clone(), None);
            assert_eq!(settings.unwrap().lmstudio_token_limit, Some(32768));
            assert!(!serde_json::to_string(&a).unwrap().contains("secret-value"), "only the LLM keys of /v1/system are kept");
            assert!(has(&a, "duplicate_name", "booking"));
            assert!(srv.reqs().iter().all(|r| r.method == "GET"), "{:?}", srv.reqs());
            assert_eq!(srv.reqs().len(), 3);
        });
    }

    /// Live, read-only: `cargo test --lib live_allm_audit -- --ignored --nocapture`.
    /// GET /v1/workspaces, /v1/system and LM Studio /api/v1/models only — never a POST.
    #[test]
    #[ignore]
    fn live_allm_audit() {
        tauri::async_runtime::block_on(async {
            // Read os.json / providers.json WITHOUT load_or_init (which re-saves them).
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
            let providers = read("providers.json");
            let state = DispatchState::default(); // no path → `update` never writes a file
            state
                .update(|c| {
                    for p in c.providers.iter_mut() {
                        if let Some(src) = providers["providers"].as_array().and_then(|a| a.iter().find(|x| x["id"] == p.id.as_str())) {
                            if let Some(b) = src["baseUrl"].as_str() {
                                p.base_url = b.into();
                            }
                            if let Some(m) = src["model"].as_str() {
                                p.model = m.into();
                            }
                        }
                    }
                    Ok(())
                })
                .unwrap();
            let cfg: OsConfig = serde_json::from_value(read("os.json")).unwrap_or_default();
            match run(&state, &cfg).await {
                Ok(a) => {
                    println!("LOADED {:?}", a.loaded_model);
                    for w in &a.workspaces {
                        println!("WS {:<22} name={:?} mode={:?} chat={:?}/{:?} agent={:?} threads={} roles={:?}", w.slug, w.name, w.chat_mode, w.chat_provider, w.chat_model, w.agent_model, w.threads, w.roles);
                    }
                    for f in &a.findings {
                        println!("{} {:<22} {}", f.severity.to_uppercase(), f.kind, f.detail);
                    }
                }
                Err(e) => println!("AUDIT FAILED: {e}"),
            }
        });
    }
}
