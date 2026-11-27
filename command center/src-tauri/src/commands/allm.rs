//! AnythingLLM client (Part 3). The ONLY module that talks to AnythingLLM's HTTP API.
//!
//! - [`AllmConn`]: base URL + key + pooled client. The raw request (`call`) is private to this
//!   module, so every other module goes through one of the two typed views below.
//! - [`AllmReader`]: list / read workspaces and chat logs, and chat. Chat always sanitises the
//!   delegated message (a leading `@agent` or `/command` is stripped, so no caller can flip a
//!   workspace into agent mode or reset it), uses `mode:"query"` for the Librarian and `"chat"`
//!   otherwise, and posts to one of three [`ChatTarget`]s. The reader has no ingest / embed /
//!   delete methods at all.
//! - [`AllmWriter`]: raw-text ingest, embeddings, document removal, thread deletion and model
//!   settings. Constructible only through `for_memory` (memory.rs), `for_documenter`
//!   (documenter.rs; the legacy `pipeline.rs` ingest until Part 5) and `for_model_lab`
//!   (modellab.rs). A unit test enforces those call sites.
//!
//! Tony's monthly thread per workspace is resolved through a persisted
//! `(base, workspace, key) → thread_slug` map (tasks.db `allm_thread`), verified against the
//! workspace's live `threads[].slug` list (the API returns threads WITHOUT a name), with one
//! creation per key at a time. Nothing here ever deletes a thread except `AllmWriter`.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::dispatch::{short, DispatchState, ThinkFilter};
use super::envelope::TaskStore;
use super::os_core::OsConfig;
use super::scheduler::SlotGuard;

// ── Connection ──────────────────────────────────────────────────────────────

/// One AnythingLLM endpoint. Cloning is cheap (the reqwest client is shared).
#[derive(Clone)]
pub(crate) struct AllmConn {
    http: reqwest::Client,
    base: String,
    key: String,
}

impl AllmConn {
    /// The local AnythingLLM from `os.json anythingllm.baseUrl`, key from the OS keychain.
    pub(crate) fn local(state: &DispatchState, cfg: &OsConfig) -> Result<Self, String> {
        super::secrets::warn_allm_host_mismatch(state, &cfg.anythingllm.base_url);
        let key = super::secrets::get(state, "anythingllm").ok_or_else(|| "add your AnythingLLM API key in Settings → Services (AnythingLLM RAG → key)".to_string())?;
        Ok(Self::from_cfg_key(state, cfg, key))
    }

    /// The local endpoint with an explicit key (`local` without the keychain read).
    pub(crate) fn from_cfg_key(state: &DispatchState, cfg: &OsConfig, key: String) -> Self {
        Self { http: state.http.clone(), base: cfg.anythingllm.base_url.clone(), key }
    }

    /// An endpoint whose base and key the caller already resolved (memory mounts: local or droplet).
    pub(crate) fn with_key(state: &DispatchState, base: &str, key: String) -> Self {
        Self { http: state.http.clone(), base: base.to_string(), key }
    }

    pub(crate) fn base(&self) -> &str {
        &self.base
    }

    #[cfg(test)]
    pub(crate) fn test(base: &str) -> Self {
        Self { http: reqwest::Client::new(), base: base.to_string(), key: "test-key".into() }
    }

    /// The raw request. Module-private on purpose.
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, secs: u64) -> Result<Value, String> {
        let url = format!("{}/api{}", self.base.trim_end_matches('/'), path);
        let mut rb = self.http.request(method, url).bearer_auth(&self.key).timeout(Duration::from_secs(secs)).header("Accept", "application/json");
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        let r = rb.send().await.map_err(short)?;
        let status = r.status();
        let text = r.text().await.map_err(short)?;
        if !status.is_success() {
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"].as_str().or(v["message"].as_str()).map(String::from)).unwrap_or_else(|| text.chars().take(160).collect());
            return Err(match status.as_u16() {
                401 | 403 => "AnythingLLM rejected the API key".into(),
                404 => format!("not found ({msg})"),
                _ => format!("HTTP {} {msg}", status.as_u16()),
            });
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
}

/// A reqwest-level timeout (`dispatch::short` maps it to "timed out").
pub(crate) fn is_timeout(e: &str) -> bool {
    e.contains("timed out")
}

// ── Message / slug hygiene ──────────────────────────────────────────────────

/// AnythingLLM workspace and thread slugs: 1–80 of `[A-Za-z0-9_-]` (they go into URL paths).
pub(crate) fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_slug(s: &str) -> Result<(), String> {
    if valid_slug(s) {
        Ok(())
    } else {
        Err(format!("invalid AnythingLLM workspace or thread slug {:?}", s.chars().take(40).collect::<String>()))
    }
}

/// Strip every leading `@agent` (any case) and `/command` (`/reset`, `/exit`, …) from a delegated
/// message, so a relayed line can't switch the workspace into agent mode or run a slash command.
/// Only a whole leading token is removed: `/src/app.ts is broken` and `@agentic os` stay intact.
pub fn sanitize_message(msg: &str) -> String {
    let mut s = msg.trim_start();
    loop {
        let token_end = s.find(char::is_whitespace).unwrap_or(s.len());
        let token = &s[..token_end];
        let strip = token.eq_ignore_ascii_case("@agent") || (token.len() > 1 && token.starts_with('/') && token[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        if !strip {
            break;
        }
        s = s[token_end..].trim_start();
    }
    s.to_string()
}

/// AnythingLLM chat mode per role: the Librarian answers from documents only (`query`: no agent
/// tools, no free generation); every other role chats.
pub fn mode_for_role(role: &str) -> &'static str {
    if role == "librarian" {
        "query"
    } else {
        "chat"
    }
}

/// Where a workspace chat goes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ChatTarget {
    /// Tony's monthly thread in the workspace (created once, persisted, verified).
    TonyMonthly,
    /// The worker's per-task session: `POST /v1/workspace/{slug}/chat` with
    /// `sessionId:"task-<id>"`. No thread is created, so task history never bleeds into Tony's.
    #[cfg_attr(not(test), allow(dead_code))] // the Part 5 worker is the caller
    TaskSession(String),
    /// The workspace's default chat log.
    #[allow(dead_code)]
    Default,
}

pub(crate) struct ChatRequest<'a> {
    pub slug: &'a str,
    pub role: &'a str,
    pub message: &'a str,
    pub target: ChatTarget,
    pub secs: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChatReply {
    pub text: String,
    pub sources: Vec<String>,
}

/// A task id as it may appear in a session id.
fn session_safe(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect()
}

/// The chat body (pure; tests assert on it).
pub(crate) fn chat_body(role: &str, message: &str, session: Option<&str>) -> Result<Value, String> {
    let message = sanitize_message(message);
    if message.trim().is_empty() {
        return Err("nothing to send once the @agent / slash-command prefix is removed".into());
    }
    let mut b = json!({ "message": message, "mode": mode_for_role(role) });
    if let Some(s) = session {
        b["sessionId"] = json!(s);
    }
    Ok(b)
}

// ── Persisted thread map ────────────────────────────────────────────────────

/// `(base, workspace, key) → thread_slug`.
pub(crate) trait ThreadMap: Send + Sync {
    fn get(&self, base: &str, workspace: &str, key: &str) -> Option<String>;
    fn put(&self, base: &str, workspace: &str, key: &str, thread: &str);
}

impl ThreadMap for TaskStore {
    fn get(&self, base: &str, workspace: &str, key: &str) -> Option<String> {
        self.with(|c| super::envelope::thread_get(c, base, workspace, key)).ok().flatten()
    }
    fn put(&self, base: &str, workspace: &str, key: &str, thread: &str) {
        if let Err(e) = self.with(|c| super::envelope::thread_put(c, base, workspace, key, thread)) {
            eprintln!("[allm] thread map not saved: {e}");
        }
    }
}

/// In-memory fallback (tests; tasks.db unavailable).
#[derive(Default)]
pub(crate) struct MemThreads(Mutex<BTreeMap<(String, String, String), String>>);

impl ThreadMap for MemThreads {
    fn get(&self, base: &str, workspace: &str, key: &str) -> Option<String> {
        self.0.lock().unwrap().get(&(base.into(), workspace.into(), key.into())).cloned()
    }
    fn put(&self, base: &str, workspace: &str, key: &str, thread: &str) {
        self.0.lock().unwrap().insert((base.into(), workspace.into(), key.into()), thread.into());
    }
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called once from `lib.rs` setup so the thread map can reach tasks.db.
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// tasks.db when the app is up and the store opened; else a process-local map.
pub(crate) fn thread_map() -> &'static dyn ThreadMap {
    use tauri::Manager;
    if let Some(app) = APP.get() {
        if let Some(store) = app.try_state::<TaskStore>() {
            let store: &'static TaskStore = store.inner();
            if store.path().is_some() {
                return store;
            }
        }
    }
    static MEM: OnceLock<MemThreads> = OnceLock::new();
    MEM.get_or_init(MemThreads::default)
}

/// The thread-map key for Tony's monthly thread.
pub(crate) fn tony_key(month: &str) -> String {
    format!("tony:{month}")
}

/// Everything thread resolution needs besides the connection.
pub(crate) struct Threads<'a> {
    pub map: &'a dyn ThreadMap,
    /// Slugs verified this session (`OsState.allm_threads`): skips the GET on every call.
    pub cache: &'a Mutex<BTreeMap<String, String>>,
    pub os_name: &'a str,
    pub month: String,
}

/// One async mutex per (base, workspace, key), so concurrent first calls create ONE thread.
fn key_lock(k: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default).lock().unwrap().entry(k.to_string()).or_default().clone()
}

/// `GET /v1/workspace/{slug}` → the workspace object (the API returns an object or a 1-array).
fn unwrap_workspace(v: &Value) -> Value {
    if v["workspace"].is_array() {
        v["workspace"][0].clone()
    } else {
        v["workspace"].clone()
    }
}

/// `(slug, name?)` of every thread in a workspace object. Live AnythingLLM omits `name`.
pub(crate) fn thread_list(ws: &Value) -> Vec<(String, Option<String>)> {
    ws["threads"].as_array().into_iter().flatten().filter_map(|t| Some((t["slug"].as_str()?.to_string(), t["name"].as_str().map(String::from)))).collect()
}

/// Which existing thread to reuse (pure): the persisted slug if it is still in the workspace,
/// else (an older API that returns names) a thread with exactly the monthly name. `None` = create.
pub(crate) fn pick_thread(persisted: Option<&str>, threads: &[(String, Option<String>)], name: &str) -> Option<String> {
    if let Some(p) = persisted.filter(|p| threads.iter().any(|(s, _)| s == p)) {
        return Some(p.to_string());
    }
    threads.iter().find(|(_, n)| n.as_deref() == Some(name)).map(|(s, _)| s.clone())
}

// ── Thread rotation seed ────────────────────────────────────────────────────

/// Characters of the carried-over summary in a fresh thread's first message.
pub(crate) const SEED_CHARS: usize = 1200;

fn fresh_threads() -> &'static Mutex<std::collections::HashSet<String>> {
    static F: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

fn thread_path(slug: &str, thread: &str) -> String {
    format!("/v1/workspace/{slug}/thread/{thread}/")
}

/// The message, prefixed with the newest Memory Scroll summary when `path` is the first chat of
/// a thread this session just created (consumed once).
pub(crate) fn seed_if_fresh(path: &str, message: &str) -> String {
    let hit = {
        let mut f = fresh_threads().lock().unwrap();
        let k = f.iter().find(|k| path.starts_with(k.as_str())).cloned();
        k.map(|k| f.remove(&k)).unwrap_or(false)
    };
    if hit {
        super::hygiene::seeded_message(super::hygiene::seed_text().as_deref(), message, SEED_CHARS)
    } else {
        message.to_string()
    }
}

// ── Reader ──────────────────────────────────────────────────────────────────

/// Read and chat only. Has no ingest, embedding, document or thread-delete method.
pub(crate) struct AllmReader(AllmConn);

/// The subset of `/v1/system` settings the app reads (nothing else is kept or shown).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub llm_provider: Option<String>,
    pub lmstudio_model_pref: Option<String>,
    pub lmstudio_token_limit: Option<u64>,
}

/// What a streamed chat produced.
pub(crate) struct StreamOutcome {
    pub content: String,
    pub sources: Vec<String>,
    /// Any non-empty delta arrived (even one the think filter hid): the server generated.
    pub any_token: bool,
    /// The server sent `close:true` (or ended the stream without a transport error).
    pub complete: bool,
    pub error: Option<String>,
}

/// Why a stream never started; `retry_safe` = the server can't still be generating.
pub(crate) struct StreamStartError {
    pub msg: String,
    pub retry_safe: bool,
}

impl AllmReader {
    pub(crate) fn new(conn: AllmConn) -> Self {
        Self(conn)
    }

    pub(crate) fn base(&self) -> &str {
        self.0.base()
    }

    /// `GET /v1/workspaces` (raw JSON).
    pub(crate) async fn list_workspaces(&self, secs: u64) -> Result<Value, String> {
        self.0.call(reqwest::Method::GET, "/v1/workspaces", None, secs).await
    }

    /// `GET /v1/workspace/{slug}` → the workspace object; "not found" when it doesn't exist.
    pub(crate) async fn get_workspace(&self, slug: &str, secs: u64) -> Result<Value, String> {
        check_slug(slug)?;
        let v = self.0.call(reqwest::Method::GET, &format!("/v1/workspace/{slug}"), None, secs).await?;
        let ws = unwrap_workspace(&v);
        if ws.is_null() {
            return Err(format!("workspace \"{slug}\" not found — map the role to an existing workspace in Settings"));
        }
        Ok(ws)
    }

    /// The workspace's default chat log.
    pub(crate) async fn workspace_chats(&self, slug: &str, secs: u64) -> Result<Value, String> {
        check_slug(slug)?;
        self.0.call(reqwest::Method::GET, &format!("/v1/workspace/{slug}/chats?limit=2000&orderBy=asc"), None, secs).await
    }

    pub(crate) async fn thread_chats(&self, slug: &str, thread: &str, secs: u64) -> Result<Value, String> {
        check_slug(slug)?;
        check_slug(thread)?;
        self.0.call(reqwest::Method::GET, &format!("/v1/workspace/{slug}/thread/{thread}/chats"), None, secs).await
    }

    /// LLM-related system settings only.
    pub(crate) async fn llm_settings(&self, secs: u64) -> Result<LlmSettings, String> {
        let v = self.0.call(reqwest::Method::GET, "/v1/system", None, secs).await?;
        let s = &v["settings"];
        let text = |k: &str| s[k].as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from);
        Ok(LlmSettings {
            llm_provider: text("LLMProvider"),
            lmstudio_model_pref: text("LMStudioModelPref"),
            lmstudio_token_limit: s["LMStudioTokenLimit"].as_u64().or_else(|| s["LMStudioTokenLimit"].as_str().and_then(|x| x.trim().parse().ok())),
        })
    }

    /// This month's Tony thread in `slug`: persisted slug if still live, else a legacy name
    /// match, else ONE `thread/new` (serialised per key). Never deletes anything.
    pub(crate) async fn tony_thread(&self, threads: &Threads<'_>, slug: &str) -> Result<String, String> {
        check_slug(slug)?;
        let key = tony_key(&threads.month);
        let ck = format!("{}|{slug}|{key}", self.base());
        if let Some(t) = threads.cache.lock().unwrap().get(&ck) {
            return Ok(t.clone());
        }
        let lock = key_lock(&ck);
        let _held = lock.lock().await;
        if let Some(t) = threads.cache.lock().unwrap().get(&ck) {
            return Ok(t.clone());
        }
        let ws = self.get_workspace(slug, 8).await?;
        let name = format!("{} · {}", threads.os_name, threads.month);
        let persisted = threads.map.get(self.base(), slug, &key);
        let thread = match pick_thread(persisted.as_deref(), &thread_list(&ws), &name) {
            Some(t) => t,
            None => {
                let v = self.0.call(reqwest::Method::POST, &format!("/v1/workspace/{slug}/thread/new"), Some(json!({ "name": name })), 8).await?;
                let t = v["thread"]["slug"].as_str().ok_or("AnythingLLM did not return a thread")?.to_string();
                check_slug(&t)?;
                // Thread rotation: the first message of the new thread carries the newest summary.
                fresh_threads().lock().unwrap().insert(thread_path(slug, &t));
                t
            }
        };
        if persisted.as_deref() != Some(thread.as_str()) {
            threads.map.put(self.base(), slug, &key, &thread);
        }
        threads.cache.lock().unwrap().insert(ck, thread.clone());
        Ok(thread)
    }

    /// `(path suffix base, sessionId)` for a request. `stream` picks `stream-chat`.
    async fn chat_route(&self, threads: &Threads<'_>, req: &ChatRequest<'_>, stream: bool) -> Result<(String, Option<String>), String> {
        check_slug(req.slug)?;
        let slug = req.slug;
        let verb = if stream { "stream-chat" } else { "chat" };
        Ok(match &req.target {
            ChatTarget::TonyMonthly => {
                let session = Some(format!("tony-{}", threads.month));
                match self.tony_thread(threads, slug).await {
                    Ok(t) => (format!("/v1/workspace/{slug}/thread/{t}/{verb}"), session),
                    Err(e) if e.contains("not found") => return Err(e),
                    Err(_) => {
                        bus(req.role, "allm_call_fallback", "thread unavailable, using the workspace chat");
                        (format!("/v1/workspace/{slug}/{verb}"), session)
                    }
                }
            }
            ChatTarget::TaskSession(id) => {
                let id = session_safe(id);
                if id.is_empty() {
                    return Err("task session needs a task id".into());
                }
                (format!("/v1/workspace/{slug}/{verb}"), Some(format!("task-{id}")))
            }
            ChatTarget::Default => (format!("/v1/workspace/{slug}/{verb}"), None),
        })
    }

    /// One blocking chat call. No slot handling here (see `chat_in_slot`).
    pub(crate) async fn chat(&self, threads: &Threads<'_>, req: &ChatRequest<'_>) -> Result<ChatReply, String> {
        let (path, session) = self.chat_route(threads, req, false).await?;
        let message = seed_if_fresh(&path, req.message);
        let body = chat_body(req.role, &message, session.as_deref())?;
        let v = self.0.call(reqwest::Method::POST, &path, Some(body), req.secs.clamp(10, 900)).await?;
        if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty() && *e != "null") {
            return Err(e.to_string());
        }
        let text = v["textResponse"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            return Err("the agent returned an empty answer".into());
        }
        let sources = v["sources"].as_array().into_iter().flatten().filter_map(|s| s["title"].as_str().map(String::from)).take(5).collect();
        Ok(ChatReply { text: super::dispatch::strip_think(&text), sources })
    }

    /// `stream-chat` SSE (`data: {textResponse, sources, close, error}` per chunk). Visible
    /// deltas go to `on_token`. Never re-runs anything itself.
    pub(crate) async fn stream_chat(&self, threads: &Threads<'_>, req: &ChatRequest<'_>, on_token: &mut (dyn FnMut(&str) + Send)) -> Result<StreamOutcome, StreamStartError> {
        use futures_util::StreamExt;
        let (path, session) = self.chat_route(threads, req, true).await.map_err(|msg| StreamStartError { retry_safe: false, msg })?;
        let message = seed_if_fresh(&path, req.message);
        let body = chat_body(req.role, &message, session.as_deref()).map_err(|msg| StreamStartError { retry_safe: false, msg })?;
        let url = format!("{}/api{}", self.0.base.trim_end_matches('/'), path);
        let sent = self.0.http.post(&url).bearer_auth(&self.0.key).timeout(Duration::from_secs(req.secs.clamp(10, 900))).header("Accept", "text/event-stream").json(&body).send().await;
        let response = match sent {
            Ok(r) if r.status().is_success() => r,
            // The server answered with an error status: nothing is generating.
            Ok(r) => return Err(StreamStartError { msg: format!("HTTP {}", r.status().as_u16()), retry_safe: true }),
            // Refused / unreachable: nothing reached the server. A timeout may still be generating.
            Err(e) => return Err(StreamStartError { retry_safe: e.is_connect(), msg: short(e) }),
        };
        let mut stream = response.bytes_stream();
        let mut buf = String::new();
        let mut filter = ThinkFilter::new();
        let mut out = StreamOutcome { content: String::new(), sources: vec![], any_token: false, complete: false, error: None };
        let mut transport_ok = true;
        'outer: while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                transport_ok = false;
                break;
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf.drain(..=nl);
                let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty() && *e != "null") {
                    out.error = Some(e.to_string());
                    out.complete = true;
                    break 'outer;
                }
                if let Some(d) = v["textResponse"].as_str().filter(|d| !d.is_empty()) {
                    out.any_token = true;
                    let shown = filter.feed(d);
                    if !shown.is_empty() {
                        out.content.push_str(&shown);
                        on_token(&shown);
                    }
                }
                if let Some(arr) = v["sources"].as_array().filter(|a| !a.is_empty()) {
                    out.sources = arr.iter().filter_map(|s| s["title"].as_str().map(String::from)).take(5).collect();
                }
                if v["close"].as_bool() == Some(true) {
                    out.complete = true;
                    break 'outer;
                }
            }
        }
        if transport_ok {
            out.complete = true;
        }
        let tail = filter.finish();
        if !tail.is_empty() {
            out.content.push_str(&tail);
            on_token(&tail);
        }
        out.content = out.content.trim().to_string();
        Ok(out)
    }
}

// ── Call flows (slot settle + bus events) ───────────────────────────────────

/// A verbose, bus-only event (never logged). Template text only.
fn bus(role: &str, event_type: &str, what: &str) {
    super::events::publish_note(role, event_type, "verbose", &format!("{role}: {what}"), None);
}

/// A blocking chat inside an already-held slot. The guard is armed for the settle window while
/// the request runs and disarmed on a clean finish; a timeout (or the future being dropped)
/// leaves it armed, so the slot stays held while the server may still be generating.
pub(crate) async fn chat_in_slot(reader: &AllmReader, threads: &Threads<'_>, guard: &mut SlotGuard, settle: Duration, req: &ChatRequest<'_>) -> Result<ChatReply, String> {
    bus(req.role, "allm_call_started", "call started");
    guard.arm_settle(settle);
    match reader.chat(threads, req).await {
        Ok(r) => {
            guard.disarm();
            bus(req.role, "allm_call_done", "call done");
            Ok(r)
        }
        Err(e) if is_timeout(&e) => {
            bus(req.role, "allm_call_timeout", "call timed out");
            Err(e)
        }
        Err(e) => {
            guard.disarm();
            bus(req.role, "allm_call_done", "call failed");
            Err(e)
        }
    }
}

/// Streamed chat inside a held slot. Falls back to ONE non-streamed call — reusing the same
/// guard — only when no token was ever received and the server can't still be generating.
pub(crate) async fn stream_in_slot(reader: &AllmReader, threads: &Threads<'_>, guard: &mut SlotGuard, settle: Duration, req: &ChatRequest<'_>, on_token: &mut (dyn FnMut(&str) + Send)) -> Result<ChatReply, String> {
    bus(req.role, "allm_call_started", "streaming call started");
    guard.arm_settle(settle);
    match reader.stream_chat(threads, req, on_token).await {
        Err(e) if e.retry_safe => {
            guard.disarm();
            bus(req.role, "allm_call_fallback", "stream unavailable, asking once without streaming");
            chat_in_slot(reader, threads, guard, settle, req).await
        }
        Err(e) => {
            if is_timeout(&e.msg) {
                bus(req.role, "allm_call_timeout", "streaming call timed out");
            } else {
                guard.disarm();
            }
            Err(e.msg)
        }
        Ok(o) => {
            if o.complete {
                guard.disarm();
            }
            if let Some(e) = o.error {
                bus(req.role, "allm_call_done", "streaming call failed");
                return Err(e);
            }
            if o.content.is_empty() {
                if !o.any_token && o.complete {
                    bus(req.role, "allm_call_fallback", "empty stream, asking once without streaming");
                    return chat_in_slot(reader, threads, guard, settle, req).await;
                }
                bus(req.role, "allm_call_done", "streaming call returned nothing visible");
                return Err("the agent returned an empty answer".into());
            }
            bus(req.role, "allm_call_done", "streaming call done");
            Ok(ChatReply { text: o.content, sources: o.sources })
        }
    }
}

// ── Writer ──────────────────────────────────────────────────────────────────

/// Writes to AnythingLLM. Only the memory lifecycle, Tony's documenter, the Model Lab and the
/// workspace-prompt setter may build one (`for_memory` / `for_documenter` / `for_model_lab` /
/// `for_prompts`; enforced by a unit test).
pub(crate) struct AllmWriter(AllmConn);

impl AllmWriter {
    /// memory.rs only: Memory Book mount / unmount and the monthly thread flush.
    pub(crate) fn for_memory(conn: AllmConn) -> Self {
        Self(conn)
    }

    /// documenter.rs only (and the legacy `pipeline.rs` Librarian ingest until Part 5).
    pub(crate) fn for_documenter(conn: AllmConn) -> Self {
        Self(conn)
    }

    /// modellab.rs only: "make this model Tony's brain".
    pub(crate) fn for_model_lab(conn: AllmConn) -> Self {
        Self(conn)
    }

    /// agent_prompts.rs only: Nic's four specialist workspace prompts (after verbatim backups;
    /// never the Booking workspaces).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn for_prompts(conn: AllmConn) -> Self {
        Self(conn)
    }

    /// business_registry.rs only: provision one business's isolated workspace (`bizops_<id>`).
    pub(crate) fn for_ops_provision(conn: AllmConn) -> Self {
        Self(conn)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn base(&self) -> &str {
        self.0.base()
    }

    /// `GET /v1/workspace/{slug}` → the workspace object, `None` when it doesn't exist.
    pub(crate) async fn find_workspace(&self, slug: &str, secs: u64) -> Result<Option<Value>, String> {
        check_slug(slug)?;
        match self.0.call(reqwest::Method::GET, &format!("/v1/workspace/{slug}"), None, secs).await {
            Ok(v) => {
                let ws = unwrap_workspace(&v);
                Ok((!ws.is_null()).then_some(ws))
            }
            Err(e) if e.starts_with("not found") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `POST /v1/workspace/new` (chat mode, the given prompt / model) → the slug AnythingLLM gave it.
    pub(crate) async fn create_workspace(&self, name: &str, prompt: &str, chat_model: Option<&str>, secs: u64) -> Result<String, String> {
        let mut body = json!({ "name": name, "openAiPrompt": prompt, "openAiTemp": 0.4, "openAiHistory": 20, "chatMode": "chat" });
        if let Some(m) = chat_model.filter(|m| !m.trim().is_empty()) {
            body["chatProvider"] = json!("lmstudio");
            body["chatModel"] = json!(m);
        }
        let v = self.0.call(reqwest::Method::POST, "/v1/workspace/new", Some(body), secs).await?;
        v["workspace"]["slug"].as_str().map(String::from).ok_or_else(|| "AnythingLLM created no workspace slug".into())
    }

    /// `POST /v1/document/raw-text` into `workspaces` (comma-separated slugs).
    pub(crate) async fn raw_text_ingest(&self, text: &str, workspaces: &str, title: &str, doc_source: &str, secs: u64) -> Result<Value, String> {
        for w in workspaces.split(',').map(str::trim).filter(|w| !w.is_empty()) {
            check_slug(w)?;
        }
        self.0.call(reqwest::Method::POST, "/v1/document/raw-text", Some(json!({ "textContent": text, "addToWorkspaces": workspaces, "metadata": { "title": title, "docSource": doc_source } })), secs).await
    }

    pub(crate) async fn update_embeddings(&self, slug: &str, adds: &[String], deletes: &[String], secs: u64) -> Result<Value, String> {
        check_slug(slug)?;
        self.0.call(reqwest::Method::POST, &format!("/v1/workspace/{slug}/update-embeddings"), Some(json!({ "adds": adds, "deletes": deletes })), secs).await
    }

    pub(crate) async fn remove_documents(&self, names: &[String], secs: u64) -> Result<Value, String> {
        self.0.call(reqwest::Method::DELETE, "/v1/system/remove-documents", Some(json!({ "names": names })), secs).await
    }

    /// Delete one thread. memory.rs passes only OS-created, persisted thread slugs.
    pub(crate) async fn delete_thread(&self, slug: &str, thread: &str, secs: u64) -> Result<Value, String> {
        check_slug(slug)?;
        check_slug(thread)?;
        self.0.call(reqwest::Method::DELETE, &format!("/v1/workspace/{slug}/thread/{thread}"), None, secs).await
    }

    /// `POST /v1/system/update-env` with the given settings.
    pub(crate) async fn update_env(&self, settings: Value, secs: u64) -> Result<Value, String> {
        self.0.call(reqwest::Method::POST, "/v1/system/update-env", Some(settings), secs).await
    }

    /// `POST /v1/workspace/{slug}/update` with the given fields.
    pub(crate) async fn update_workspace(&self, slug: &str, fields: Value, secs: u64) -> Result<Value, String> {
        check_slug(slug)?;
        self.0.call(reqwest::Method::POST, &format!("/v1/workspace/{slug}/update"), Some(fields), secs).await
    }

    /// Workspaces, for the Model Lab's "same model everywhere" pass (read, via the writer's conn).
    pub(crate) async fn list_workspaces(&self, secs: u64) -> Result<Value, String> {
        self.0.call(reqwest::Method::GET, "/v1/workspaces", None, secs).await
    }
}

// ── Test HTTP server ────────────────────────────────────────────────────────

/// A tiny scripted HTTP/1.1 server on 127.0.0.1 for the AnythingLLM / LM Studio tests:
/// records every request and answers from a handler (JSON, or SSE chunks, with optional delay).
#[cfg(test)]
pub(crate) mod mock {
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Clone, Debug)]
    pub struct Req {
        pub method: String,
        pub path: String,
        pub body: Value,
        pub auth: bool,
    }

    pub struct Resp {
        pub status: u16,
        pub body: String,
        pub sse: Option<Vec<String>>,
        pub delay_ms: u64,
        /// Close the socket mid-stream (after the SSE chunks) without finishing.
        pub abort: bool,
    }

    impl Resp {
        pub fn json(v: Value) -> Self {
            Self { status: 200, body: v.to_string(), sse: None, delay_ms: 0, abort: false }
        }
        pub fn status(code: u16, v: Value) -> Self {
            Self { status: code, body: v.to_string(), sse: None, delay_ms: 0, abort: false }
        }
        pub fn sse(chunks: Vec<Value>) -> Self {
            Self { status: 200, body: String::new(), sse: Some(chunks.into_iter().map(|c| format!("data: {c}\n\n")).collect()), delay_ms: 0, abort: false }
        }
        pub fn delayed(mut self, ms: u64) -> Self {
            self.delay_ms = ms;
            self
        }
    }

    pub type Handler = Arc<dyn Fn(&Req) -> Resp + Send + Sync>;

    pub struct Server {
        pub base: String,
        pub log: Arc<Mutex<Vec<Req>>>,
    }

    impl Server {
        pub fn reqs(&self) -> Vec<Req> {
            self.log.lock().unwrap().clone()
        }
        pub fn count(&self, method: &str, path_contains: &str) -> usize {
            self.reqs().iter().filter(|r| r.method == method && r.path.contains(path_contains)).count()
        }
    }

    pub async fn start(h: impl Fn(&Req) -> Resp + Send + Sync + 'static) -> Server {
        let handler: Handler = Arc::new(h);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log: Arc<Mutex<Vec<Req>>> = Arc::default();
        let log2 = log.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let (handler, log) = (handler.clone(), log2.clone());
                tauri::async_runtime::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = &buf[head_end + 4..(head_end + 4 + len).min(buf.len())];
                    let mut first = head.lines().next().unwrap_or("").split_whitespace();
                    let req = Req {
                        method: first.next().unwrap_or("").to_string(),
                        path: first.next().unwrap_or("").to_string(),
                        body: serde_json::from_slice(body).unwrap_or(Value::Null),
                        auth: head.lines().any(|l| l.to_ascii_lowercase().starts_with("authorization: bearer ")),
                    };
                    log.lock().unwrap().push(req.clone());
                    let resp = handler(&req);
                    if resp.delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(resp.delay_ms)).await;
                    }
                    match resp.sse {
                        Some(chunks) => {
                            let _ = sock.write_all(format!("HTTP/1.1 {} OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n", resp.status).as_bytes()).await;
                            for c in chunks {
                                let _ = sock.write_all(c.as_bytes()).await;
                                let _ = sock.flush().await;
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                            if resp.abort {
                                return;
                            }
                        }
                        None => {
                            let _ = sock.write_all(format!("HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", resp.status, resp.body.len(), resp.body).as_bytes()).await;
                        }
                    }
                    let _ = sock.shutdown().await;
                });
            }
        });
        Server { base, log }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::mock::{start, Req, Resp};
    use super::*;
    use crate::commands::scheduler::GpuSlot;

    fn threads<'a>(map: &'a dyn ThreadMap, cache: &'a Mutex<BTreeMap<String, String>>) -> Threads<'a> {
        Threads { map, cache, os_name: "Tony", month: "2026-11".into() }
    }

    /// AnythingLLM-shaped workspace handler: threads WITHOUT names (live shape); `thread/new`
    /// returns `t-new-<n>`; chat answers "ok".
    fn allm_handler(threads: Vec<&'static str>) -> impl Fn(&Req) -> Resp + Send + Sync {
        let n = Arc::new(Mutex::new(0usize));
        move |r: &Req| {
            if r.method == "GET" && r.path.starts_with("/api/v1/workspace/") && !r.path.contains("/chats") {
                return Resp::json(json!({ "workspace": [{ "slug": "booking", "threads": threads.iter().map(|t| json!({ "user_id": null, "slug": t })).collect::<Vec<_>>() }] }));
            }
            if r.path.ends_with("/thread/new") {
                let mut g = n.lock().unwrap();
                *g += 1;
                return Resp::json(json!({ "thread": { "slug": format!("t-new-{}", *g) } })).delayed(80);
            }
            if r.path.ends_with("/chat") {
                return Resp::json(json!({ "textResponse": "ok", "sources": [{ "title": "doc" }] }));
            }
            Resp::status(404, json!({ "error": "nope" }))
        }
    }

    #[test]
    fn thread_slug_reused_without_name() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec!["t-old", "t-persisted"])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let map = MemThreads::default();
            map.put(&srv.base, "booking", "tony:2026-11", "t-persisted");
            let cache = Mutex::default();
            assert_eq!(r.tony_thread(&threads(&map, &cache), "booking").await.unwrap(), "t-persisted");
            assert_eq!(srv.count("POST", "/thread/new"), 0, "a live persisted slug is reused");
        });
    }

    #[test]
    fn stale_persisted_slug_creates_new_and_persists() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec!["t-other"])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let map = MemThreads::default();
            map.put(&srv.base, "booking", "tony:2026-11", "t-gone");
            let cache = Mutex::default();
            let t = r.tony_thread(&threads(&map, &cache), "booking").await.unwrap();
            assert_eq!(t, "t-new-1");
            assert_eq!(srv.count("POST", "/thread/new"), 1);
            assert_eq!(map.get(&srv.base, "booking", "tony:2026-11").as_deref(), Some("t-new-1"));
            let new_req = srv.reqs().into_iter().find(|q| q.path.ends_with("/thread/new")).unwrap();
            assert_eq!(new_req.body["name"], "Tony · 2026-11");
            assert!(srv.reqs().iter().all(|q| q.method != "DELETE"), "the stale thread is never deleted");
        });
    }

    #[test]
    fn persisted_map_survives_a_restart_in_tasks_db() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec![])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let store = TaskStore::in_memory();
            let t1 = r.tony_thread(&threads(&store, &Mutex::default()), "booking").await.unwrap();
            // "Restart": empty session cache, same store; the workspace now lists the thread.
            let srv2 = start(allm_handler(vec!["t-new-1"])).await;
            let r2 = AllmReader::new(AllmConn::test(&srv2.base));
            store.put(&srv2.base, "booking", "tony:2026-11", &t1);
            let t2 = r2.tony_thread(&threads(&store, &Mutex::default()), "booking").await.unwrap();
            assert_eq!(t1, t2);
            assert_eq!(srv2.count("POST", "/thread/new"), 0);
        });
    }

    #[test]
    fn concurrent_tony_thread_creates_exactly_one() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec![])).await;
            let r = Arc::new(AllmReader::new(AllmConn::test(&srv.base)));
            let map: &'static MemThreads = Box::leak(Box::default());
            let cache: &'static Mutex<BTreeMap<String, String>> = Box::leak(Box::default());
            let mut hs = vec![];
            for _ in 0..2 {
                let r = r.clone();
                hs.push(tauri::async_runtime::spawn(async move { r.tony_thread(&Threads { map, cache, os_name: "Tony", month: "2026-11".into() }, "booking").await }));
            }
            let mut got = vec![];
            for h in hs {
                got.push(h.await.unwrap().unwrap());
            }
            assert_eq!(got[0], got[1]);
            assert_eq!(srv.count("POST", "/thread/new"), 1, "exactly one thread/new for concurrent first calls");
        });
    }

    #[test]
    fn librarian_uses_query_mode_and_strips_agent_for_every_role() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec![])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let map = MemThreads::default();
            let cache = Mutex::default();
            for role in ["librarian", "coder", "booking", "prompter", "designer", "general"] {
                let req = ChatRequest { slug: "booking", role, message: "@agent /reset  find the invoice", target: ChatTarget::TaskSession("t-1".into()), secs: 10 };
                r.chat(&threads(&map, &cache), &req).await.unwrap();
                let last = srv.reqs().into_iter().rev().find(|q| q.path.ends_with("/chat")).unwrap();
                assert_eq!(last.body["message"], "find the invoice", "{role}");
                assert_eq!(last.body["mode"], if role == "librarian" { "query" } else { "chat" }, "{role}");
                assert!(last.auth);
            }
        });
    }

    #[test]
    fn task_session_posts_session_id_and_creates_no_thread() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec![])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let map = MemThreads::default();
            let cache = Mutex::default();
            let req = ChatRequest { slug: "coder", role: "coder", message: "build it", target: ChatTarget::TaskSession("t-1700000000000-abc123".into()), secs: 10 };
            let rep = r.chat(&threads(&map, &cache), &req).await.unwrap();
            assert_eq!(rep, ChatReply { text: "ok".into(), sources: vec!["doc".into()] });
            let reqs = srv.reqs();
            assert_eq!(reqs.len(), 1, "{reqs:?}");
            assert_eq!(reqs[0].path, "/api/v1/workspace/coder/chat");
            assert_eq!(reqs[0].body["sessionId"], "task-t-1700000000000-abc123");
            assert_eq!(srv.count("POST", "/thread/new"), 0);
            assert_eq!(srv.count("GET", "/workspace/"), 0);
        });
    }

    #[test]
    fn tony_monthly_goes_to_the_thread() {
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec![])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let map = MemThreads::default();
            let cache = Mutex::default();
            let req = ChatRequest { slug: "booking", role: "booking", message: "hi", target: ChatTarget::TonyMonthly, secs: 10 };
            r.chat(&threads(&map, &cache), &req).await.unwrap();
            r.chat(&threads(&map, &cache), &req).await.unwrap();
            let chats: Vec<Req> = srv.reqs().into_iter().filter(|q| q.path.ends_with("/chat")).collect();
            assert_eq!(chats[0].path, "/api/v1/workspace/booking/thread/t-new-1/chat");
            assert_eq!(chats[0].body["sessionId"], "tony-2026-11");
            assert_eq!(srv.count("POST", "/thread/new"), 1);
            assert_eq!(srv.count("GET", "/api/v1/workspace/booking"), 1, "verified once per session, then cached");
        });
    }

    #[test]
    fn sanitize_table() {
        assert_eq!(sanitize_message("@agent do it"), "do it");
        assert_eq!(sanitize_message("  @AGENT   /reset\n/exit hello"), "hello");
        assert_eq!(sanitize_message("/src/app.ts is broken"), "/src/app.ts is broken");
        assert_eq!(sanitize_message("@agentic os is cool"), "@agentic os is cool");
        assert_eq!(sanitize_message("[Tony → Coder agent] /reset please"), "[Tony → Coder agent] /reset please");
        assert_eq!(sanitize_message("/"), "/");
        assert!(chat_body("coder", "@agent /reset", None).is_err());
        assert_eq!(chat_body("librarian", "x", Some("task-1")).unwrap(), json!({ "message": "x", "mode": "query", "sessionId": "task-1" }));
    }

    #[test]
    fn slugs_are_checked_before_any_request() {
        assert!(valid_slug("prompter-dispatcher") && valid_slug("my_workspace") && valid_slug("0f9c-11"));
        for bad in ["", "../x", "a/b", "a?b", "a b", "a%2f"] {
            assert!(!valid_slug(bad), "{bad}");
        }
        tauri::async_runtime::block_on(async {
            let srv = start(allm_handler(vec![])).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            assert!(r.get_workspace("../system", 5).await.is_err());
            assert!(srv.reqs().is_empty());
        });
    }

    fn stream_handler(chunks: Vec<Value>, abort: bool, chat_calls: Arc<Mutex<usize>>) -> impl Fn(&Req) -> Resp + Send + Sync {
        move |r: &Req| {
            if r.path.ends_with("/stream-chat") {
                let mut s = Resp::sse(chunks.clone());
                s.abort = abort;
                return s;
            }
            if r.path.ends_with("/chat") {
                *chat_calls.lock().unwrap() += 1;
                return Resp::json(json!({ "textResponse": "non-streamed" }));
            }
            Resp::status(404, json!({}))
        }
    }

    fn run_stream(srv_base: &str, slot: &GpuSlot) -> (Result<ChatReply, String>, Vec<String>) {
        tauri::async_runtime::block_on(async {
            let r = AllmReader::new(AllmConn::test(srv_base));
            let map = MemThreads::default();
            let cache = Mutex::default();
            let mut guard = slot.acquire("t", true, 90).await;
            let mut toks = vec![];
            let req = ChatRequest { slug: "coder", role: "coder", message: "hi", target: ChatTarget::TaskSession("t1".into()), secs: 10 };
            let res = stream_in_slot(&r, &threads(&map, &cache), &mut guard, Duration::from_millis(1), &req, &mut |t: &str| toks.push(t.to_string())).await;
            (res, toks)
        })
    }

    #[test]
    fn no_stream_rerun_after_first_token() {
        // The server streamed (a think block only, then broke off): no second generation.
        let calls = Arc::new(Mutex::new(0));
        let srv = tauri::async_runtime::block_on(start(stream_handler(vec![json!({ "textResponse": "<think>planning" })], true, calls.clone())));
        let (res, toks) = run_stream(&srv.base, &GpuSlot::default());
        assert!(res.is_err());
        assert!(toks.is_empty());
        assert_eq!(*calls.lock().unwrap(), 0, "never re-run once the server has streamed a token");

        // Visible tokens then a broken stream: the partial answer stands, no re-run.
        let calls = Arc::new(Mutex::new(0));
        let srv = tauri::async_runtime::block_on(start(stream_handler(vec![json!({ "textResponse": "Hel" }), json!({ "textResponse": "lo" })], true, calls.clone())));
        let (res, toks) = run_stream(&srv.base, &GpuSlot::default());
        assert_eq!(res.unwrap().text, "Hello");
        assert_eq!(toks.concat(), "Hello");
        assert_eq!(*calls.lock().unwrap(), 0);
    }

    #[test]
    fn stream_failure_before_any_token_reruns_once_in_the_same_slot() {
        // HTTP 500 on stream-chat: the server isn't generating, so ONE non-streamed call — and it
        // must not deadlock on the (capacity-1) slot the caller still holds.
        let calls = Arc::new(Mutex::new(0usize));
        let c2 = calls.clone();
        let srv = tauri::async_runtime::block_on(start(move |r: &Req| {
            if r.path.ends_with("/stream-chat") {
                return Resp::status(500, json!({ "error": "boom" }));
            }
            *c2.lock().unwrap() += 1;
            Resp::json(json!({ "textResponse": "non-streamed" }))
        }));
        let slot = GpuSlot::default();
        let (res, _) = run_stream(&srv.base, &slot);
        assert_eq!(res.unwrap().text, "non-streamed");
        assert_eq!(*calls.lock().unwrap(), 1);

        // A clean but empty stream (no token at all): also exactly one re-run.
        let calls = Arc::new(Mutex::new(0));
        let srv = tauri::async_runtime::block_on(start(stream_handler(vec![json!({ "close": true })], false, calls.clone())));
        let (res, _) = run_stream(&srv.base, &slot);
        assert_eq!(res.unwrap().text, "non-streamed");
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[test]
    fn chat_timeout_keeps_the_slot_for_the_settle_window() {
        tauri::async_runtime::block_on(async {
            let srv = start(|_r: &Req| Resp::json(json!({ "textResponse": "late" })).delayed(11_500)).await;
            let r = AllmReader::new(AllmConn::test(&srv.base));
            let map = MemThreads::default();
            let cache = Mutex::default();
            let slot = GpuSlot::default();
            let mut guard = slot.acquire("worker", false, 50).await;
            let req = ChatRequest { slug: "coder", role: "coder", message: "hi", target: ChatTarget::TaskSession("t1".into()), secs: 10 };
            let e = chat_in_slot(&r, &threads(&map, &cache), &mut guard, Duration::from_millis(400), &req).await.unwrap_err();
            assert!(is_timeout(&e), "{e}");
            assert!(guard.settle_armed());
            drop(guard);
            let t0 = std::time::Instant::now();
            let _g = slot.acquire("tony", true, 90).await;
            assert!(t0.elapsed() >= Duration::from_millis(350), "{:?}", t0.elapsed());
        });
    }

    /// Acceptance: raw AnythingLLM requests live only in this module, and the writer is built
    /// only where it is allowed.
    #[test]
    fn raw_calls_and_writer_constructors_are_confined() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("commands");
        let raw = regex::Regex::new(r"(^|[^A-Za-z0-9_])(allm|allm_key)\(").unwrap();
        let allowed: [(&str, &[&str]); 5] = [
            ("AllmWriter::for_memory(", &["memory.rs"]),
            ("AllmWriter::for_documenter(", &["documenter.rs", "pipeline.rs"]),
            ("AllmWriter::for_model_lab(", &["modellab.rs"]),
            ("AllmWriter::for_prompts(", &["agent_prompts.rs"]),
            ("AllmWriter::for_ops_provision(", &["business_registry.rs"]),
        ];
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name == "allm.rs" {
                continue;
            }
            let src = std::fs::read_to_string(e.path()).unwrap();
            assert!(!raw.is_match(&src), "{name} makes a raw AnythingLLM call");
            for (ctor, files) in allowed {
                if src.contains(ctor) {
                    assert!(files.contains(&name.as_str()), "{name} builds {ctor}");
                }
            }
        }
    }

    /// The reader has no write path: its impl block names no write endpoint.
    #[test]
    fn reader_has_no_ingest_or_delete() {
        let src = include_str!("allm.rs");
        let start = src.find("impl AllmReader {").unwrap();
        let end = start + src[start..].find("\n}\n").unwrap();
        let reader = &src[start..end];
        for w in ["raw-text", "update-embeddings", "remove-documents", "Method::DELETE", "update-env", "/update\"", "fn raw_text_ingest", "fn delete_thread"] {
            assert!(!reader.contains(w), "AllmReader must not contain {w}");
        }
    }
}

/// Live AnythingLLM WRITES (moved here from agents.rs so raw access stays in this module).
/// Each one changes the user's AnythingLLM: they need `--ignored` AND `ALLM_LIVE_WRITE=1`
/// (`live_allm_llm` only reads unless `ALLM_SET` is also set).
#[cfg(test)]
mod live_writes {
    use super::*;

    fn conn() -> AllmConn {
        let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let state = DispatchState::default();
        state.load_or_init(&dir);
        let key = super::super::secrets::get(&state, "anythingllm").expect("AnythingLLM key");
        AllmConn::with_key(&state, "http://127.0.0.1:3001", key)
    }

    fn writes_allowed() -> bool {
        let ok = std::env::var("ALLM_LIVE_WRITE").is_ok_and(|v| v == "1");
        if !ok {
            println!("SKIPPED: set ALLM_LIVE_WRITE=1 to let this test write to AnythingLLM");
        }
        ok
    }

    /// One-off: create the sub-agent workspaces Tony delegates to, if missing.
    /// `ALLM_LIVE_WRITE=1 cargo test --lib live_create_workspaces -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_create_workspaces() {
        if !writes_allowed() {
            return;
        }
        tauri::async_runtime::block_on(async {
            let c = conn();
            let v = c.call(reqwest::Method::GET, "/v1/workspaces", None, 8).await.unwrap();
            let have: Vec<String> = v["workspaces"].as_array().into_iter().flatten().filter_map(|w| w["slug"].as_str().map(String::from)).collect();
            let want = [
                ("booking", "Booking", "You are the Booking agent of Tony, the user's personal AI operating system. You handle the user's bookings: auditions, gigs, shoots, client jobs, appointments and reservations. Answer from the documents and messages in this workspace: who, what, when, where, rate and status. Quote dates, times and names exactly; if something isn't in your data, say so plainly. Never confirm, send or book anything yourself — propose it and Tony will ask the user."),
                ("ops", "Ops", "You are the Ops agent of Tony, the user's personal AI operating system. You cover infrastructure: Docker, n8n workflows, the droplet over NetBird, GPU/VRAM, services and backups. Report status as short telemetry lines, flag anything degraded first, and give exact commands for fixes. Never run or change anything yourself."),
                ("designer", "Designer", "You are the Designer agent of Tony, the user's personal AI operating system — a senior UI/UX designer. Never give generic advice. Always answer with concrete, buildable specs: (1) design tokens as JSON (color, type scale, spacing, radius, shadow, motion), (2) a component hierarchy, (3) a layout wireframe in ASCII or bullet form per breakpoint, and when asked for a prototype (4) ONE self-contained HTML file using Tailwind via CDN (and React via ESM CDN only if needed) inside a ```html fenced block. Dark, cinematic, glass aesthetic unless told otherwise; accessible contrast; purposeful motion."),
                ("director", "Director", "You are the Director agent of Tony, the user's personal AI operating system: a senior film/video director, offline/online editor, sound mixer and photo retoucher for acting self-tapes, YouTube long-form, short-form reels and headshot/stills batches. Be direct and practical, like a sharp post-production collaborator. Ask only for the exact missing shots, specs (aspect ratio, max file size, platform or casting requirement) or creative direction. Before any multi-clip edit, give a short edit plan: clip order, trim in/out points, transitions, captions, loudness target (-18 LUFS casting, -16 LUFS web) and output spec. Never overwrite or delete original raw files; work only on copies inside the project folder under G:\\ai-hub\\media. Renders run on the CPU; never ask for the GPU while Tony is using it. After every render, verify it (duration, audio and video streams, resolution, file size) before calling it done, and never claim a render ran unless a tool result shows it."),
            ];
            for (slug, name, prompt) in want {
                if have.iter().any(|h| h == slug) {
                    println!("EXISTS {slug}");
                    continue;
                }
                let r = c.call(reqwest::Method::POST, "/v1/workspace/new", Some(json!({ "name": name, "openAiPrompt": prompt, "openAiTemp": 0.4, "openAiHistory": 20, "chatMode": "chat" })), 20).await;
                match r {
                    Ok(v) => println!("CREATED {} -> slug {}", name, v["workspace"]["slug"].as_str().unwrap_or("?")),
                    Err(e) => println!("FAILED {slug}: {e}"),
                }
            }
        });
    }

    /// AnythingLLM model settings. Read: `cargo test --lib live_allm_llm -- --ignored --nocapture`.
    /// Write: same with ALLM_SET=1 and ALLM_LIVE_WRITE=1 (points AnythingLLM's LLM at LM Studio :1235).
    #[test]
    #[ignore]
    fn live_allm_llm() {
        tauri::async_runtime::block_on(async {
            let c = conn();
            if std::env::var("ALLM_SET").is_ok() && writes_allowed() {
                let r = c.call(reqwest::Method::POST, "/v1/system/update-env", Some(json!({ "LLMProvider": "lmstudio", "LMStudioBasePath": "http://127.0.0.1:1235/v1", "LMStudioModelPref": "qwen/qwen3.5-9b", "LMStudioTokenLimit": 32768 })), 20).await;
                println!("UPDATE: {r:?}");
                // Coder ran qwen2.5-coder-14b — a second big model that can't share 12 GB with the 9B.
                let r = c.call(reqwest::Method::POST, "/v1/workspace/coder/update", Some(json!({ "chatProvider": "lmstudio", "chatModel": "qwen/qwen3.5-9b" })), 20).await;
                println!("CODER: {:?}", r.map(|v| v["workspace"]["chatModel"].clone()));
            }
            let r = AllmReader::new(c.clone());
            println!("SETTINGS {:?}", r.llm_settings(10).await);
            let w = r.list_workspaces(10).await.unwrap();
            for ws in w["workspaces"].as_array().into_iter().flatten() {
                println!("WS {} provider={} model={}", ws["slug"], ws["chatProvider"], ws["chatModel"]);
            }
        });
    }

    /// Add Qwen3's /no_think switch to every workspace prompt.
    /// `ALLM_LIVE_WRITE=1 cargo test --lib live_no_think -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_no_think() {
        if !writes_allowed() {
            return;
        }
        tauri::async_runtime::block_on(async {
            let c = conn();
            const DEFAULT: &str = "Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed.";
            let v = c.call(reqwest::Method::GET, "/v1/workspaces", None, 10).await.unwrap();
            for w in v["workspaces"].as_array().unwrap() {
                let slug = w["slug"].as_str().unwrap_or("");
                let prompt = w["openAiPrompt"].as_str().filter(|p| !p.trim().is_empty()).unwrap_or(DEFAULT).to_string();
                if prompt.contains("/no_think") {
                    println!("NOTHINK {slug}: already set");
                    continue;
                }
                let r = c.call(reqwest::Method::POST, &format!("/v1/workspace/{slug}/update"), Some(json!({ "openAiPrompt": format!("{prompt}\n/no_think") })), 20).await;
                println!("NOTHINK {slug}: {}", if r.is_ok() { "added" } else { "FAILED" });
            }
        });
    }
}


#[cfg(test)]
mod seed_tests {
    use super::*;

    #[test]
    fn a_fresh_thread_opens_with_the_newest_summary_once() {
        fresh_threads().lock().unwrap().insert(thread_path("seedws", "t1"));
        super::super::hygiene::set_seed(Some("Nic prefers tea over coffee".into()));
        let first = seed_if_fresh("/v1/workspace/seedws/thread/t1/stream-chat", "hello");
        assert!(first.contains("Nic prefers tea over coffee") && first.ends_with("hello"), "{first}");
        assert_eq!(seed_if_fresh("/v1/workspace/seedws/thread/t1/stream-chat", "again"), "again", "consumed once");
        assert_eq!(seed_if_fresh("/v1/workspace/seedws/chat", "plain"), "plain", "the workspace chat is never seeded");
    }
}
