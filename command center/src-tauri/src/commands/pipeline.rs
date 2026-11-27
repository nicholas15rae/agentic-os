//! Ideas, Play Place actions, Comms recall/WhatsApp, and the phone → desktop queue.
//!
//! The Idea-to-Execution pipeline itself is the sequential TaskEnvelope worker
//! (`taskworker.rs`, Part 5): Tony → Prompter → Librarian → Prompter → Designer → Prompter →
//! Coder → checks → Librarian audit → Prompter verify → `staging/<slug>/`. What stays here:
//!
//! - thin compatibility shims for the old commands (`idea_capture` / `idea_pipeline_run` →
//!   a task, `pipeline_resume` → `task_retry`), until the webview calls `task_*` directly;
//! - the Play Place actions (iterate / approve / commit), still inline;
//! - `inbox_loop`: every phone queue item is CLAIMED first; build kinds only create a task and
//!   answer at once (the worker runs it), Tony turns and commands run inline.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use super::agents::{workspace_chat_t, OsStep};
use super::bridge::BridgeState;
use super::dispatch::{extract_json, run_chat, short, ChatMessage, DispatchState, Priority};
use super::envelope::{clip, one_line, TaskStore};
use super::os_core::{self, OsConfig, OsState};
use super::taskworker::{self, CreateArgs};

// ── Gateway client (loopback; carries the mesh token when the lock is on) ──

/// Per-request timeout of every gateway call (`gw`).
const GW_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) async fn gw(state: &DispatchState, os: &OsConfig, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    gw_t(state, os, method, path, body, GW_TIMEOUT).await
}

/// `gw` with its own request timeout (the inbox long-poll needs more than 20 s, a delta less).
pub(crate) async fn gw_t(state: &DispatchState, os: &OsConfig, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value, String> {
    let base = state.snapshot().gateway.url;
    let mut rb = state.http.request(method, format!("{}{path}", base.trim_end_matches('/'))).timeout(timeout);
    if let Some(t) = os_core::mesh_bearer(os) {
        rb = rb.bearer_auth(t);
    }
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let r = rb.send().await.map_err(short)?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("gateway {}: {}", status.as_u16(), v["detail"].as_str().unwrap_or("error")));
    }
    Ok(v)
}

fn slug(cfg: &OsConfig, role: &str) -> Result<String, String> {
    cfg.anythingllm.workspaces.get(role).filter(|s| !s.is_empty()).cloned().ok_or_else(|| format!("no AnythingLLM workspace mapped for {role} (Settings → Services)"))
}

/// The last ```html … ``` block (or a bare <!doctype html> document).
pub(crate) fn extract_html(text: &str) -> Option<String> {
    let low = text.to_ascii_lowercase();
    if let Some(start) = low.rfind("```html") {
        let body = &text[start + 7..];
        let end = body.find("```").unwrap_or(body.len());
        let h = body[..end].trim();
        if h.len() > 40 {
            return Some(h.to_string());
        }
    }
    let s = low.find("<!doctype html").or_else(|| low.find("<html"))?;
    let e = low.rfind("</html>").map(|e| e + 7).unwrap_or(text.len());
    (e > s).then(|| text[s..e].trim().to_string())
}

fn slugify(s: &str) -> String {
    let mut out: String = s.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(48).collect::<String>().trim_end_matches('-').to_string()
}

// ── Events (Play Place actions) ─────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepEvent {
    pipeline_id: String,
    idea_id: Option<String>,
    card_id: Option<String>,
    stage: String,
    pct: u8,
    /// Dispatcher tab the step is logged in.
    thread: String,
    #[serde(flatten)]
    step: OsStep,
}

struct Run<'a> {
    app: &'a AppHandle,
    id: String,
    idea_id: Option<String>,
    steps: Vec<OsStep>,
}

impl Run<'_> {
    fn emit(&mut self, stage: &str, pct: u8, thread: &str, step: OsStep, card_id: Option<String>) {
        let ev = StepEvent { pipeline_id: self.id.clone(), idea_id: self.idea_id.clone(), card_id, stage: stage.into(), pct, thread: thread.into(), step: step.clone() };
        let _ = self.app.emit("pipeline-step", ev);
        // Phone HUD progress (best-effort).
        let app = self.app.clone();
        let body = json!({ "ideaId": self.idea_id.clone().unwrap_or_else(|| self.id.clone()), "pipelineId": self.id, "stage": stage, "pct": pct, "label": format!("{} → {}", step.from, step.to) });
        self.steps.push(step);
        tauri::async_runtime::spawn(async move {
            let st = app.state::<DispatchState>();
            let os = app.state::<OsState>().snapshot();
            let _ = gw(&st, &os, reqwest::Method::POST, "/api/pipeline/progress", Some(body)).await;
        });
    }

    /// Non-blocking verifier at a Play Place handoff (never under the kill switch).
    fn verify(&self, handoff: &str, thread: &str, original: &str, payload: &str) {
        let app = self.app.clone();
        let (id, idea, thread, handoff) = (self.id.clone(), self.idea_id.clone(), thread.to_string(), handoff.to_string());
        let msg = format!(
            "Original request: \"{}\"\nHandoff {handoff} payload:\n{}\n\nCheck: valid JSON/structure where JSON is expected, no invented file paths or tool calls, and aligned with the original request. Reply ONLY JSON {{\"ok\": boolean, \"issues\": [string]}}.",
            original.chars().take(1500).collect::<String>(),
            payload.chars().take(4000).collect::<String>()
        );
        tauri::async_runtime::spawn(async move {
            let st = app.state::<DispatchState>();
            let os = app.state::<OsState>();
            if os.snapshot().privacy.kill_switch {
                return;
            }
            let t0 = Instant::now();
            let r = run_chat(&st, &os, vec![ChatMessage::new("system", "You are a terse verifier."), ChatMessage::new("user", msg)], Priority::Background, Some("verifier".into()), Some(45)).await;
            let (ok, text) = match r.ok().and_then(|r| extract_json(&r.content)) {
                Some(j) if j["ok"].as_bool() == Some(true) => (true, format!("✓ {handoff} verified")),
                Some(j) => (false, format!("⚠ {handoff}: {}", j["issues"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default())),
                None => (true, format!("{handoff}: verifier unavailable (non-blocking)")),
            };
            let step = super::agents::step("verify", "verifier", "os", text, ok, t0.elapsed().as_millis());
            let _ = app.emit("pipeline-step", StepEvent { pipeline_id: id, idea_id: idea, card_id: None, stage: "verify".into(), pct: 0, thread, step });
        });
    }
}

/// Ask a role for a Play Place action. `offload` = an external engine (Claude/Gemini/llm CLI…)
/// instead of the local GPU. Otherwise: its AnythingLLM workspace, then the local chain as
/// stand-in. BACKGROUND work: Tony keeps the GPU first. (The task worker never uses this.)
async fn ask(state: &DispatchState, os: &OsState, role: &str, prompt: &str, secs: u64, offload: Option<&str>) -> Result<(String, String), String> {
    if let Some(engine) = offload {
        let (a, _) = super::agents::external_chat(state, os, engine, &[ChatMessage::new("user", prompt.to_string())], secs).await?;
        return Ok((a, format!("ext:{engine}")));
    }
    let cfg = os.snapshot();
    if let Ok(s) = slug(&cfg, role) {
        if let Ok((a, _)) = workspace_chat_t(state, os, &s, role, prompt, Some(secs), false, super::allm::ChatTarget::TonyMonthly).await {
            return Ok((a, format!("anythingllm:{s}")));
        }
    }
    let r = run_chat(state, os, vec![ChatMessage::new("user", prompt.to_string())], Priority::Background, None, Some(secs)).await.map_err(|e| format!("{role} unavailable: {e}"))?;
    Ok((r.content, format!("{} (stand-in for {role})", r.provider_id)))
}

// ── Compatibility shims → TaskEnvelope worker ───────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaResult {
    idea: Value,
    reply: String,
    steps: Vec<OsStep>,
    task_id: String,
}

/// A short working title from the user's words (the Prompter's triage names it properly).
fn working_title(text: &str) -> String {
    let t = one_line(text);
    clip(&t.split(' ').take(8).collect::<Vec<_>>().join(" "), 60)
}

/// The task an inbox item already created (its queue id is the dedupe key).
fn task_for_dedupe(store: &TaskStore, key: &str) -> Option<String> {
    store.with(|c| Ok(c.query_row("SELECT task_id FROM task_envelope WHERE dedupe_key = ?1", rusqlite::params![key], |r| r.get::<_, String>(0)).ok())).ok().flatten()
}

/// Approved build (Tier-3 yes / Build prototype click / the phone's `capture:true`): a ledger
/// idea (best-effort mirror) and a queued task. Returns at once; the worker does the rest.
pub async fn capture_task(app: &AppHandle, state: &DispatchState, os: &OsState, text: &str, source: &str, dedupe: Option<String>) -> Result<IdeaResult, String> {
    // Phase 2 Part C: Tony's mode gates every build (Solo queues nothing).
    super::modes::check_dispatch(os.modes.effective().dispatch, super::modes::DispatchKind::BuildPipeline { auto: false })?;
    let cfg = os.snapshot();
    let store = app.state::<TaskStore>();
    let known = super::devqueue::known_secrets(state, os);
    if let Some(id) = dedupe.as_deref().and_then(|k| task_for_dedupe(store.inner(), k)) {
        let e = store.with(|c| super::envelope::get_bare(c, &id))?.ok_or("task vanished")?;
        return Ok(IdeaResult { idea: json!({ "id": e.idea_id.clone().unwrap_or_else(|| e.task_id.clone()), "title": e.title, "tasks": [], "taskId": e.task_id }), reply: format!("\"{}\" is already queued.", e.title), steps: vec![], task_id: e.task_id });
    }
    let title = working_title(text);
    let item = gw(state, &cfg, reqwest::Method::POST, "/api/cc/c/ideas", Some(json!({ "title": title, "idea": text, "summary": "", "tasks": [], "spec": {}, "status": "prototyping", "by": cfg.os_name }))).await.ok();
    let idea_id = item.as_ref().and_then(|i| i["id"].as_str()).filter(|s| !s.is_empty()).map(String::from);
    let args = CreateArgs { raw_intent: text.to_string(), title: Some(title), thread: None, source: source.into(), idea_id, options: None, dedupe_key: dedupe, project_slug: None };
    let (e, _) = taskworker::create_task(store.inner(), &args, cfg.worker.max_iterations, &known)?;
    taskworker::announce_queued(app, &e);
    let mut idea = item.unwrap_or_else(|| json!({ "id": e.task_id, "title": e.title, "tasks": [] }));
    idea["taskId"] = json!(e.task_id);
    let mode = os.modes.effective();
    let reply = queued_reply(&e.title, super::modes::pipeline_frozen(&mode, &cfg.switchboard).as_deref(), super::modes::pipeline_frozen_on_master(&cfg.switchboard));
    Ok(IdeaResult { idea, reply, steps: vec![], task_id: e.task_id })
}

/// What Tony says for a queued build. The switchboard froze a pipeline agent: the build stays
/// queued (never dropped) and the worker starts it once Nic switches modes, or, for a freeze on
/// the master switchboard (`on_master`: every mode), once he thaws it there (pure).
pub(crate) fn queued_reply(title: &str, frozen: Option<&str>, on_master: bool) -> String {
    match frozen {
        Some(why) if on_master => format!("Queued \"{title}\". {why}, so it starts once it's thawed on the switchboard."),
        Some(why) => format!("Queued \"{title}\". {why}, so it starts when you switch modes."),
        None => format!("Queued \"{title}\" for the Prompter. Ask me where the build's at anytime."),
    }
}

/// A ledger idea → a task (an open task for the same idea is returned, not duplicated).
pub async fn task_from_idea(app: &AppHandle, state: &DispatchState, os: &OsState, idea_id: &str, dedupe: Option<String>) -> Result<Value, String> {
    super::modes::check_dispatch(os.modes.effective().dispatch, super::modes::DispatchKind::BuildPipeline { auto: false })?;
    let store = app.state::<TaskStore>();
    if let Some(e) = store.with(|c| super::envelope::get_bare(c, idea_id))? {
        // Already a task id (the shim's `idea.id` when the ledger was unreachable).
        return Ok(json!({ "taskId": e.task_id, "created": false, "cardId": e.card_id, "hasHtml": false, "steps": [] }));
    }
    let cfg = os.snapshot();
    let list = gw(state, &cfg, reqwest::Method::GET, "/api/pipeline/ideas", None).await?;
    let idea = list["items"].as_array().into_iter().flatten().find(|i| i["id"] == idea_id).cloned().ok_or("idea not found in the ledger")?;
    let title = idea["title"].as_str().unwrap_or("Prototype").to_string();
    let text = idea["idea"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or(&title).to_string();
    let args = CreateArgs { raw_intent: text, title: Some(title), thread: None, source: "ledger".into(), idea_id: Some(idea_id.to_string()), options: None, dedupe_key: dedupe, project_slug: None };
    let (e, created) = taskworker::create_task(store.inner(), &args, cfg.worker.max_iterations, &super::devqueue::known_secrets(state, os))?;
    if created {
        let _ = gw(state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/ideas/{idea_id}"), Some(json!({ "status": "prototyping", "taskId": e.task_id }))).await;
    }
    taskworker::announce_queued(app, &e);
    Ok(json!({ "taskId": e.task_id, "created": created, "cardId": e.card_id, "hasHtml": false, "steps": [] }))
}

/// Shim: an approved build → a queued task (no blocking model call any more).
#[tauri::command]
pub async fn idea_capture(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, text: String) -> Result<IdeaResult, String> {
    capture_task(&app, &state, &os, &text, "typed", None).await
}

/// Shim: a ledger "Run" → `task_create{idea_id}`. Returns at once with `{taskId}`.
#[tauri::command]
pub async fn idea_pipeline_run(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, idea_id: String) -> Result<Value, String> {
    task_from_idea(&app, &state, &os, &idea_id, None).await
}

/// The task id behind a "Retry step" action, or a clear error for an old checkpoint path.
pub(crate) fn resume_target(checkpoint: &str) -> Result<&str, String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let c = checkpoint.trim();
    if RE.get_or_init(|| regex::Regex::new(r"^t-\d{1,16}-[a-z0-9]{6}$").unwrap()).is_match(c) {
        return Ok(c);
    }
    Err("That's a checkpoint from the old pipeline, which the task worker replaced: it can't be resumed. Start the build again from the Ideas Ledger (Run).".into())
}

/// Shim: Retry / Offload on a failed step → `task_retry` (the checkpoint is the task id).
#[tauri::command]
pub fn pipeline_resume(app: AppHandle, checkpoint: String, offload: Option<String>) -> Result<Value, String> {
    let id = resume_target(&checkpoint)?.to_string();
    let e = taskworker::task_retry(app, id, offload)?;
    Ok(json!({ "taskId": e.task_id, "status": e.status, "stage": e.stage, "cardId": e.card_id }))
}

const PROTOTYPE_RULES: &str = "Output ONE complete, self-contained HTML document in a single ```html fenced block: Tailwind via <script src=\"https://cdn.tailwindcss.com\"></script>, vanilla JS (or React via https://esm.sh if truly needed), realistic sample data, every button wired, dark cinematic glass look unless the brief says otherwise, mobile-first. No external images except https URLs. No explanations outside the code block beyond 3 short lines.";

/// Blueprint text without the big code block (for threads and briefs).
fn strip_code(s: &str) -> String {
    let re = regex::Regex::new(r"(?s)```html.*?(```|$)").unwrap();
    re.replace_all(s, "[prototype HTML staged in the Play Place]").trim().to_string()
}

// ── Play Place actions ──────────────────────────────────────────────────────

async fn card(state: &DispatchState, cfg: &OsConfig, id: &str) -> Result<Value, String> {
    gw(state, cfg, reqwest::Method::GET, &format!("/api/play-place/{id}"), None).await
}

#[tauri::command]
pub async fn playplace_iterate(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, card_id: String, notes: String, target: String) -> Result<Value, String> {
    let cfg = os.snapshot();
    let role = if target == "designer" { "designer" } else { "coder" };
    let c = card(&state, &cfg, &card_id).await?;
    let mut run = Run { app: &app, id: format!("tweak-{}", os_core::now_secs()), idea_id: c["ideaId"].as_str().map(String::from), steps: vec![] };
    let q = format!(
        "[{} → {}] Revise this prototype. Revision notes from the user: {notes}\n\nKeep everything that works. {PROTOTYPE_RULES}\n\nCURRENT PROTOTYPE:\n```html\n{}\n```",
        cfg.os_name,
        if role == "designer" { "Designer" } else { "Coder" },
        c["html"].as_str().unwrap_or("").chars().take(40_000).collect::<String>()
    );
    run.emit("tweak", 20, role, super::agents::step("delegate", "tony", role, format!("Revise “{}”: {notes}", c["title"].as_str().unwrap_or("")), true, 0), Some(card_id.clone()));
    let t0 = Instant::now();
    let (out, by) = ask(&state, &os, role, &q, 600, None).await?;
    let html = extract_html(&out).ok_or_else(|| format!("{role} returned no HTML: {}", out.chars().take(200).collect::<String>()))?;
    let mut versions = c["versions"].as_array().cloned().unwrap_or_default();
    versions.push(json!({ "at": os_core::now_secs(), "by": role, "notes": notes }));
    let updated = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "html": html, "versions": versions, "status": "staged", "lastBy": by }))).await?;
    run.emit("tweak", 100, role, super::agents::step("reply", role, "tony", format!("Revised ({} KB). {}", html.len() / 1024, strip_code(&out).chars().take(300).collect::<String>()), true, t0.elapsed().as_millis()), Some(card_id));
    Ok(updated)
}

#[tauri::command]
pub async fn playplace_approve(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, card_id: String) -> Result<Value, String> {
    let cfg = os.snapshot();
    let c = card(&state, &cfg, &card_id).await?;
    let before = c["status"].as_str().filter(|s| !s.is_empty() && *s != "building").unwrap_or("staged").to_string();
    let _ = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": "building" }))).await;
    let r = approve_inner(&app, &state, &os, &cfg, &c, &card_id).await;
    if r.is_err() {
        // Never leave the card stuck in "building".
        let _ = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": before }))).await;
    }
    r
}

async fn approve_inner(app: &AppHandle, state: &DispatchState, os: &OsState, cfg: &OsConfig, c: &Value, card_id: &str) -> Result<Value, String> {
    let mut run = Run { app, id: format!("approve-{}", os_core::now_secs()), idea_id: c["ideaId"].as_str().map(String::from), steps: vec![] };
    let q = format!(
        "[Prompter] The user APPROVED this prototype's look and flow. Write technical build instructions for the Coder to turn it into a production feature: stack, file tree, components, state/data model, API calls, step-by-step tasks, acceptance tests. Don't invent existing file paths — propose new ones.\n\nIdea: {}\nBlueprint: {}\nPrototype HTML (reference):\n{}",
        c["idea"].as_str().unwrap_or(""),
        c["blueprint"].as_str().unwrap_or("").chars().take(4000).collect::<String>(),
        c["html"].as_str().unwrap_or("").chars().take(12_000).collect::<String>()
    );
    let t0 = Instant::now();
    let (plan, _) = ask(state, os, "prompter", &q, 300, None).await?;
    run.emit("approve", 40, "prompter", super::agents::step("reply", "prompter", "coder", &plan, true, t0.elapsed().as_millis()), Some(card_id.to_string()));
    run.verify("Prompter → Coder (build)", "coder", c["idea"].as_str().unwrap_or(""), &plan);
    let t0 = Instant::now();
    let offload = {
        let c = os.snapshot();
        (c.scheduler.offload_pct >= 50 && !c.privacy.kill_switch).then(|| c.scheduler.offload_engine.clone())
    };
    let (impl_out, _) = ask(state, os, "coder", &format!("[Prompter → Coder] Build instructions for an approved prototype. Start the implementation: list the files you'd create and give the core code for each.\n\n{plan}"), 600, offload.as_deref()).await?;
    run.emit("approve", 100, "coder", super::agents::step("reply", "coder", "tony", impl_out.chars().take(3000).collect::<String>(), true, t0.elapsed().as_millis()), Some(card_id.to_string()));
    let updated = gw(state, cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": "approved", "buildPlan": plan, "coderOutput": impl_out }))).await?;
    if let Some(i) = c["ideaId"].as_str() {
        let _ = gw(state, cfg, reqwest::Method::PATCH, &format!("/api/cc/c/ideas/{i}"), Some(json!({ "status": "approved" }))).await;
    }
    Ok(updated)
}

/// `play-place/<date>-<slug>` under Tony's notes root.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn commit_dir_rel(date: &str, title: &str) -> String {
    commit_dir_rel_with(date, title, |_| false)
}

/// `commit_dir_rel`, skipping folders `taken` says belong to another card (a different card
/// with a same-slug title, committed the same day, is never overwritten).
pub(crate) fn commit_dir_rel_with(date: &str, title: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = slugify(title);
    let slug = super::staging::slug_for(if base.is_empty() { "prototype" } else { &base }, |s| taken(&format!("play-place/{date}-{s}")));
    format!("play-place/{date}-{slug}")
}

/// The marker file naming the card a Vault commit folder belongs to.
const COMMIT_CARD_FILE: &str = ".card";

/// Is `root/rel` an existing commit folder of a card other than `card_id`? (A re-commit of the
/// same card reuses its folder.)
pub(crate) fn commit_dir_taken(root: &Path, rel: &str, card_id: &str) -> bool {
    let d = root.join(rel);
    d.exists() && std::fs::read_to_string(d.join(COMMIT_CARD_FILE)).map(|s| s.trim() != card_id).unwrap_or(true)
}

fn write_note_file(root: &Path, rel: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let target = super::staging::ensure_parent(root, rel)?;
    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
        return Err(format!("{rel} is a directory"));
    }
    super::staging::atomic_write(&target, bytes)?;
    Ok(target)
}

#[tauri::command]
pub async fn playplace_commit(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, card_id: String) -> Result<Value, String> {
    let cfg = os.snapshot();
    let c = card(&state, &cfg, &card_id).await?;
    let title = c["title"].as_str().unwrap_or("prototype").to_string();
    let workdir = PathBuf::from(state.snapshot().gateway.workdir);
    let root = super::documenter::notes_root(&cfg, &workdir)?;
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let dir_rel = commit_dir_rel_with(&chrono::Local::now().format("%Y-%m-%d").to_string(), &title, |rel| commit_dir_taken(&root, rel, &card_id));
    let spec = format!(
        "# {title}\n\n## Idea\n{}\n\n## Design brief\n{}\n\n## Blueprint\n{}\n\n## Build plan\n{}\n",
        c["idea"].as_str().unwrap_or(""),
        c["brief"].as_str().unwrap_or(""),
        c["blueprint"].as_str().unwrap_or(""),
        c["buildPlan"].as_str().unwrap_or("(not approved for build yet)")
    );
    let spec_path = write_note_file(&root, &format!("{dir_rel}/spec.md"), spec.as_bytes())?;
    write_note_file(&root, &format!("{dir_rel}/{COMMIT_CARD_FILE}"), card_id.as_bytes())?;
    write_note_file(&root, &format!("{dir_rel}/prototype.html"), c["html"].as_str().unwrap_or("").as_bytes())?;
    write_note_file(&root, &format!("{dir_rel}/prompt-chain.json"), serde_json::to_string_pretty(&json!({ "buildPrompt": c["buildPrompt"], "chain": c["chain"], "versions": c["versions"] })).unwrap_or_default().as_bytes())?;
    let dir = spec_path.parent().map(Path::to_path_buf).unwrap_or(root);
    // Tony's documenter indexes his own note (best-effort; a failure is surfaced as an event).
    let indexed = super::documenter::ingest(&state, &os, super::roles::Role::Tony, &format!("Prototype: {title}"), &spec).await.is_ok();
    bridge.log(json!({ "type": "playplace-commit", "card": card_id, "dir": dir.display().to_string() }));
    gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": "committed", "vaultPath": dir.display().to_string(), "librarianIndexed": indexed }))).await
}

// ── Comms: recall + WhatsApp ────────────────────────────────────────────────

/// Exact quotes with timestamps from the gateway's comms history (and WhatsApp
/// MCP, if enabled). Returns (formatted quotes, comms thread key).
pub async fn comms_search(state: &DispatchState, cfg: &OsConfig, who: &str, topic: &str, limit: usize) -> Result<(String, Option<String>), String> {
    let q = format!("/api/comms/search?contact={}&q={}&limit={}", urlenc(who), urlenc(topic), limit.clamp(1, 10));
    let v = gw(state, cfg, reqwest::Method::GET, &q, None).await?;
    let results = v["results"].as_array().cloned().unwrap_or_default();
    let thread = results.last().and_then(|r| r["thread"].as_str().map(String::from));
    let lines: Vec<String> = results
        .iter()
        .map(|r| format!("[{}] {} {}: “{}”", r["when"].as_str().unwrap_or(""), if r["direction"] == "out" { "You →" } else { "" }, r["contact"].as_str().unwrap_or(who), r["body"].as_str().unwrap_or("")))
        .collect();
    Ok((lines.join("\n"), thread))
}

fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[tauri::command]
pub async fn comms_whatsapp(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, action: String, args: Value) -> Result<String, String> {
    let tool = match action.as_str() {
        "chats" => "whatsapp.list_chats",
        "messages" => "whatsapp.list_messages",
        "contacts" => "whatsapp.search_contacts",
        _ => return Err("action must be chats, messages or contacts (sending goes through comms_whatsapp_send)".into()),
    };
    super::mcp::call_tool(&state, &os, &bridge, tool, &args, true, "tony").await
}

/// The gateway's contact key (`os_api._thread_key`, sms/whatsapp): a JID or email lowercased, a
/// phone number's last 10 digits. Trust is matched on this key exactly, never by substring.
pub(crate) fn comms_contact_key(address: &str) -> String {
    let a = address.trim();
    if a.contains('@') {
        return a.to_lowercase();
    }
    let digits: String = a.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 10 {
        digits[digits.len() - 10..].to_string()
    } else if !digits.is_empty() {
        digits
    } else if !a.is_empty() {
        a.to_lowercase()
    } else {
        "unknown".into()
    }
}

/// Is `recipient` an Instant Send contact? Only a contact whose normalized key equals the
/// recipient's key exactly, and is marked trusted, counts (the gateway's `?q=` search is a LIKE,
/// so a trusted "4165551234" also comes back for a recipient "1234" — that must not count).
pub(crate) fn is_trusted_exact(contacts: &[Value], recipient: &str) -> bool {
    let key = comms_contact_key(recipient);
    if key == "unknown" {
        return false;
    }
    contacts.iter().any(|x| x["trusted"].as_i64() == Some(1) && x["address"].as_str().is_some_and(|a| comms_contact_key(a) == key))
}

/// The send's origin, normalized: kebab-case, lowercase (`ui_typed` → `ui-typed`).
pub(crate) fn comms_send_origin(origin: Option<&str>) -> String {
    origin.map(|o| o.trim().to_ascii_lowercase().replace('_', "-")).filter(|o| !o.is_empty()).unwrap_or_else(|| "agent".into())
}

/// Instant Send rule (decision 5): only a reply typed by hand in the Chat box (`ui-typed`) to an
/// exactly trusted contact may skip the card. Every other origin (a UI card, voice, Tony, an agent,
/// or none) needs `approved` from the confirmation card.
pub(crate) fn comms_send_allowed(approved: bool, origin: &str, trusted: bool) -> Result<(), String> {
    if approved || (origin == "ui-typed" && trusted) {
        Ok(())
    } else {
        Err("PERMISSION_REQUIRED:send".into())
    }
}

/// Send a WhatsApp message. Requires `approved` (the confirmation card), unless `origin` is
/// `ui-typed` (typed by hand in the Chat box) and the contact is exactly trusted (Instant Send).
#[tauri::command]
pub async fn comms_whatsapp_send(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, recipient: String, message: String, approved: Option<bool>, origin: Option<String>) -> Result<String, String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err("kill switch is on — WhatsApp is outbound traffic".into());
    }
    let approved = approved.unwrap_or(false);
    let origin = comms_send_origin(origin.as_deref());
    // Only look trust up when it could matter (an unapproved hand-typed reply).
    let trusted = if !approved && origin == "ui-typed" {
        gw(&state, &cfg, reqwest::Method::GET, &format!("/api/comms/contacts?q={}", urlenc(&comms_contact_key(&recipient))), None)
            .await
            .ok()
            .and_then(|v| v["contacts"].as_array().cloned())
            .is_some_and(|c| is_trusted_exact(&c, &recipient))
    } else {
        false
    };
    comms_send_allowed(approved, &origin, trusted)?;
    let out = super::mcp::call_tool(&state, &os, &bridge, "whatsapp.send_message", &json!({ "recipient": recipient, "message": message }), true, "tony").await?;
    bridge.log(json!({ "type": "comms-send", "channel": "whatsapp", "trusted": trusted, "origin": origin, "approved": approved, "chars": message.len() }));
    let _ = gw(&state, &cfg, reqwest::Method::POST, "/api/comms/sms", Some(json!({ "address": recipient, "body": message, "direction": "out", "channel": "whatsapp" }))).await;
    Ok(out)
}

// ── Phone → desktop queue ───────────────────────────────────────────────────

/// What one queued phone item becomes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum InboxAction {
    /// kind `task`: create a TaskEnvelope (dedupe = the queue id) and answer at once.
    Task(CreateArgs),
    /// kind `pipeline`: a ledger idea → a task.
    Pipeline(String),
    /// An approved Tier-3 build from the phone (`capture: true`): ledger idea + task.
    Capture(String),
    /// An idea-shaped turn from a stale phone build (no tier flags): saved to the ledger only.
    /// It never starts a build without an approved yes.
    Park(String),
    Turn,
    Command,
    PlayPlace,
    /// The phone's approved confirmation card (`kind: action`): one carded tool, run through the
    /// same approved-only path as the desktop card (`run_approved_action`). Never a gateway agent.
    Action,
    /// A Capture that arrived under Solo mode: parked in the Ideas Ledger, not queued.
    SoloPark(String),
    Unknown,
}

/// The raw intent of a `task` payload: a string, or `{text}`.
fn task_intent(p: &Value) -> String {
    p["raw_intent"].as_str().or_else(|| p["raw_intent"]["text"].as_str()).or_else(|| p["rawIntent"].as_str()).unwrap_or("").to_string()
}

/// Route one queue item (pure).
pub(crate) fn inbox_action(queue_id: &str, kind: Option<&str>, p: &Value) -> InboxAction {
    let text = || p["text"].as_str().unwrap_or("").to_string();
    match kind {
        Some("task") => InboxAction::Task(CreateArgs {
            raw_intent: task_intent(p),
            title: p["title"].as_str().map(String::from),
            thread: p["thread"].as_str().map(String::from),
            source: "phone".into(),
            idea_id: p["idea_id"].as_str().or_else(|| p["ideaId"].as_str()).map(String::from),
            options: p.get("options").cloned().filter(Value::is_object),
            dedupe_key: Some(queue_id.to_string()),
            project_slug: None,
        }),
        Some("pipeline") => InboxAction::Pipeline(p["ideaId"].as_str().unwrap_or("").to_string()),
        Some("turn") => match inbox_turn_route(p) {
            InboxTurnRoute::Capture => InboxAction::Capture(text()),
            InboxTurnRoute::Park => InboxAction::Park(text()),
            InboxTurnRoute::OsTurn => InboxAction::Turn,
        },
        Some("command") => InboxAction::Command,
        Some("playplace") => InboxAction::PlayPlace,
        Some("action") => InboxAction::Action,
        _ => InboxAction::Unknown,
    }
}

/// How long the desktop holds an item's claim (the gateway caps it at 900 s).
fn claim_lease(kind: Option<&str>) -> u64 {
    match kind {
        Some("playplace") => 900,
        Some("turn") | Some("command") => 300,
        _ => 120,
    }
}

/// Save a stale client's idea to the ledger (no task, no model call). `solo`: the phone's
/// approved Capture arrived while Tony's mode is Solo (surface_only), so it is parked instead.
async fn park_idea(state: &DispatchState, os: &OsState, text: &str, solo: bool) -> Result<Value, String> {
    let cfg = os.snapshot();
    let title = working_title(text);
    let item = gw(state, &cfg, reqwest::Method::POST, "/api/cc/c/ideas", Some(json!({ "title": title, "idea": text, "summary": "", "tasks": [], "spec": {}, "status": "captured", "by": cfg.os_name }))).await?;
    let answer = if solo { SOLO_PARK_REPLY.to_string() } else { format!("Saved \"{title}\" to your Ideas Ledger. Tap Run there when you want it built.") };
    Ok(json!({ "answer": answer, "ideaId": item["id"], "steps": [] }))
}

/// The phone's Capture under Solo (Phase 2 Part C, D15).
pub(crate) const SOLO_PARK_REPLY: &str = "Solo mode is on: saved it to your Ideas Ledger; tap Run there once you switch modes.";

/// Tony's mode applied to a routed inbox item (pure): under Solo a Capture is parked instead of
/// queued. A `task` is gated at creation (`create_task_gated`, with the payload's `auto`) and a
/// `pipeline` in `task_from_idea`, so a refused build creates zero envelopes.
pub(crate) fn mode_inbox_action(a: InboxAction, policy: super::modes::DispatchPolicy) -> InboxAction {
    match a {
        InboxAction::Capture(text) if policy == super::modes::DispatchPolicy::SurfaceOnly => InboxAction::SoloPark(text),
        other => other,
    }
}

/// Run one claimed item. Build kinds only create a task (the worker runs it), so a slow build
/// never blocks the queue; Tony turns and commands run inline; Play Place actions run inline
/// under the claim lease. `claim_token`: this desktop's claim, which a Tony turn's streamed
/// answer is posted under (D2).
async fn run_inbox_item(app: &AppHandle, id: &str, kind: Option<&str>, p: &Value, claim_token: Option<&str>) -> Result<Value, String> {
    let st = app.state::<DispatchState>();
    let os = app.state::<OsState>();
    let policy = os.modes.effective().dispatch;
    match mode_inbox_action(inbox_action(id, kind, p), policy) {
        InboxAction::Task(args) => {
            let max = os.snapshot().worker.max_iterations;
            let auto = p["auto"].as_bool().unwrap_or(false);
            let (e, created) = taskworker::create_task_gated(app.state::<TaskStore>().inner(), &args, max, &super::devqueue::known_secrets(&st, &os), policy, auto)?;
            taskworker::announce_queued(app, &e);
            Ok(json!({ "taskId": e.task_id, "created": created, "status": e.status, "title": e.title }))
        }
        InboxAction::Pipeline(idea) => task_from_idea(app, &st, &os, &idea, Some(id.to_string())).await,
        InboxAction::Capture(text) => capture_task(app, &st, &os, &text, "phone", Some(id.to_string())).await.map(|r| json!({ "answer": r.reply, "idea": r.idea, "steps": r.steps, "taskId": r.task_id })),
        InboxAction::Park(text) => park_idea(&st, &os, &text, false).await,
        InboxAction::SoloPark(text) => park_idea(&st, &os, &text, true).await,
        InboxAction::Command => {
            // Phase 2 Part B: the phone can lock (and unlock) the desktop mic. A lock is a dead
            // line before the write; an unlock applies only once it is saved.
            let mic = p["micEnabled"].as_bool();
            if mic == Some(false) {
                super::voice::set_mic_enabled(app, false);
            }
            os.update(|c| {
                if let Some(k) = p["killSwitch"].as_bool() {
                    c.privacy.kill_switch = k;
                }
                if let Some(m) = p["computeMode"].as_str() {
                    c.compute.mode = serde_json::from_value(json!(m)).map_err(|_| "bad compute mode".to_string())?;
                }
                if let Some(m) = mic {
                    c.voice.mic_enabled = m;
                }
                Ok(())
            })
            .and_then(|c| {
                if mic == Some(true) {
                    super::voice::set_mic_enabled(app, true);
                }
                // Phase 2 Part C: the phone switches Tony's mode / sets or resets overrides.
                let mut out = json!({ "killSwitch": c.privacy.kill_switch, "computeMode": c.compute.mode, "micEnabled": c.voice.mic_enabled });
                if let Some(e) = super::modes::apply_inbox_command(&os, p)? {
                    super::modes::notify_changed(app);
                    out["mode"] = json!({ "id": e.mode_id, "name": e.name, "overridden": e.overridden });
                }
                // Decision 5: the phone's card answers Tony's pending core-memory proposal.
                if let Some(m) = super::agents::memory_inbox_command(app, &st, &os, p) {
                    out["memory"] = m?;
                }
                Ok(out)
            })
        }
        InboxAction::Turn => {
            let bridge = app.state::<BridgeState>();
            let req: Result<super::agents::OsTurnRequest, _> = serde_json::from_value(p.clone());
            match req {
                Ok(r) => {
                    // D2: Tony's answer reaches the phone through the gateway while he writes it;
                    // the result posted afterwards stays the whole, authoritative answer.
                    let deltas = claim_token.map(|t| InboxDeltas::start(app, id, t));
                    let out = super::agents::run_os_turn_streaming(&st, &os, &bridge, r, Some(app), deltas.as_ref().map(InboxDeltas::sink)).await;
                    if let Some(d) = deltas {
                        d.finish().await;
                    }
                    out.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
                }
                Err(e) => Err(e.to_string()),
            }
        }
        InboxAction::PlayPlace => {
            let card = p["cardId"].as_str().unwrap_or("").to_string();
            match p["action"].as_str() {
                Some("approve") => playplace_approve(app.clone(), app.state(), app.state(), card).await,
                Some("iterate") => playplace_iterate(app.clone(), app.state(), app.state(), card, p["notes"].as_str().unwrap_or("").to_string(), p["target"].as_str().unwrap_or("coder").to_string()).await,
                Some("commit") => playplace_commit(app.state(), app.state(), app.state(), card).await,
                _ => Err("playplace action must be approve, iterate or commit".into()),
            }
        }
        InboxAction::Action => {
            let bridge = app.state::<BridgeState>();
            run_approved_action(&st, &os, &bridge, p).await
        }
        InboxAction::Unknown => Err("unknown queue item".into()),
    }
}

/// The tools a phone card may approve through the inbox (os_api.py `_ACTION_TOOLS`).
pub(crate) const APPROVED_ACTION_TOOLS: [&str; 2] = [super::calendar::CREATE, "gmail.create_draft"];

/// A phone `action` payload `{tool, args, planId, approvedAt}` → (tool, args), re-validated here
/// (the gateway checked it too): an allowlisted tool, an args object, an approval stamp. Pure.
pub(crate) fn approved_action(p: &Value) -> Result<(&'static str, Value), String> {
    let tool = p["tool"].as_str().unwrap_or("");
    let tool = APPROVED_ACTION_TOOLS.iter().copied().find(|t| *t == tool).ok_or("that action can't be approved from the phone")?;
    if !p["approvedAt"].as_str().is_some_and(|a| !a.trim().is_empty()) {
        return Err("the action wasn't approved on the card".into());
    }
    let args = p["args"].clone();
    if !args.is_object() {
        return Err("the approved action has no arguments".into());
    }
    Ok((tool, args))
}

/// The IPC gate's hard-lock rule for the phone's approved card (`security::gate::decide_with`):
/// while the remote failsafe holds the app nothing the phone approved runs, exactly as the desktop
/// card's `gcal_create_event` / `gmail_create_draft` get `HARD_LOCKED`. An idle / manual LOCK of the
/// desktop session doesn't refuse it: that lock guards the desktop's own screen, and the phone's
/// card (behind the gateway token) is the approval, like every other phone inbox item. Pure.
pub(crate) fn approved_action_lock(hard_locked: bool) -> Result<(), String> {
    if hard_locked {
        return Err("HARD_LOCKED: the remote failsafe locked this app; nothing was done. Release it with `gabagool-cli clear-lock`".into());
    }
    Ok(())
}

/// Run the phone's approved card: the calendar add or Gmail draft through its approved-only path
/// (hard lock, permission gate, kill switch, switched-on check, no content logged), answered as
/// `answer`.
async fn run_approved_action(st: &DispatchState, os: &OsState, bridge: &BridgeState, p: &Value) -> Result<Value, String> {
    run_approved_action_with(st, os, bridge, p, crate::security::commands::hard_locked()).await
}

/// `run_approved_action` with the remote failsafe's state passed in (tests).
async fn run_approved_action_with(st: &DispatchState, os: &OsState, bridge: &BridgeState, p: &Value, hard_locked: bool) -> Result<Value, String> {
    approved_action_lock(hard_locked)?;
    let (tool, args) = approved_action(p)?;
    let s = |k: &str| args[k].as_str().unwrap_or("").to_string();
    let answer = if tool == super::calendar::CREATE {
        super::calendar::create_event_approved(st, os, bridge, &args, true, "phone").await?
    } else {
        super::gmail::create_draft_approved(st, os, bridge, s("to"), s("subject"), s("body"), true).await?
    };
    Ok(json!({ "answer": answer, "tool": tool }))
}

/// Claim and run what the phone HUD queued on the gateway (Tony turns, builds, Play Place
/// actions, lockdown commands). An item someone else holds (409) is skipped.
///
/// Cadence (`inbox_wait`): straight back to the gateway after running an item (a turn the phone
/// queued meanwhile is claimed at once, not 3 s later); 3 s for five minutes after the inbox last
/// held an item (the phone is in use) and for the first minute after app start; 10 s otherwise;
/// 5 s for the first three failed polls in a row (a restarted gateway is polled again inside the
/// phone's 12 s pickup window), then 15 s while the gateway stays down. Idle polling stays inside
/// the phone's 15 s "desktop alive" window. It used to poll every 3 s forever, on a blocking-pool
/// thread, even with no phone at all.
///
/// D1: the list call is a long-poll (`?wait=20`, 30 s client timeout). A current gateway answers
/// as soon as an item is listable (a phone turn is claimed within moments, not up to 3-10 s
/// later) and counts the desktop as seen while the call is open; its empty answer carries
/// `waited`, so the loop lists again at once (`inbox_next_wait`). An old gateway (no `waited`)
/// keeps the cadence above.
///
/// D2: a Tony turn's answer streams to the gateway as `/delta`s while he writes it
/// (`InboxDeltas`); the result posted afterwards stays the whole answer.
///
/// While an item runs, its claim is renewed every 30 s (`renewing_claim`): the lease never lapses
/// under a long turn, and every renewal counts the desktop as seen, so the gateway keeps
/// reporting it busy (not gone) to the phone. A 404 / 409 ends the renewals, never the run.
///
/// Results (`deliver_result`): a result POST that fails is retried in the background with
/// backoff while the item's lease is renewed, so the gateway never re-offers an item this desktop
/// already ran. Items it ran are remembered with their result bodies (`RanItems`): one listed
/// again gets the stored result, never a second run (no double side effects).
pub async fn inbox_loop(app: AppHandle) {
    let started = Instant::now();
    let mut wait = INBOX_FAST;
    let mut last_item: Option<Instant> = None;
    let mut down_streak = 0u32;
    let ran = RanMemory::default();
    loop {
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let st = app.state::<DispatchState>();
        let os = app.state::<OsState>();
        let cfg = os.snapshot();
        // D1: a long-poll. A current gateway holds the call open until an item is listable or
        // 20 s pass (and reports the desktop as seen meanwhile); an old one answers at once.
        // The loop registry hears from the loop every few seconds while it waits.
        let list = gw_t(&st, &cfg, reqwest::Method::GET, INBOX_LIST_PATH, None, INBOX_LIST_TIMEOUT);
        let v = match beating(list, INBOX_BEAT, || super::introspect::loop_ran("inbox", true, "waiting for phone items")).await {
            Ok(v) => {
                down_streak = 0;
                let n = v["items"].as_array().map_or(0, |a| a.len());
                super::introspect::loop_ran("inbox", true, &format!("{n} queued item(s)"));
                if n > 0 {
                    last_item = Some(Instant::now());
                }
                v
            }
            Err(e) => {
                super::introspect::loop_ran("inbox", false, &e);
                down_streak = down_streak.saturating_add(1);
                wait = inbox_wait(InboxPoll::GatewayDown, started.elapsed(), last_item.map(|t| t.elapsed()), down_streak);
                continue;
            }
        };
        ran_lock(&ran).prune(Instant::now());
        // How long a current gateway held the list call open (absent: an old gateway).
        let waited = v["waited"].as_f64();
        let items = v["items"].as_array().cloned().unwrap_or_default();
        let n_listed = items.len();
        // GET /api/os/inbox lists only pending items and running ones whose lease ran out, never
        // one under a live lease. What each listed item came to decides the next wait
        // (`inbox_round`): only a claim this desktop won earns an immediate re-poll.
        let mut claims = Vec::new();
        for item in items {
            let Some(id) = inbox_item_id(&item) else {
                claims.push(InboxClaim::BadId);
                continue;
            };
            let kind = item["kind"].as_str();
            // Ran here already (its result never landed, or the gateway lost it): answer with the
            // stored result. Running it again would repeat its side effects.
            let listed = ran_lock(&ran).listed(&id, Instant::now());
            if let Listed::Repost { body, retry } = listed {
                claims.push(InboxClaim::Reposted);
                deliver_result(&app, &ran, &id, kind, body, retry).await;
                continue;
            }
            // Claim first: nothing runs twice, and a crash leaves it re-claimable after the lease.
            let claim = gw(&st, &cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/claim"), Some(json!({ "lease_secs": claim_lease(kind) }))).await;
            claims.push(InboxClaim::of(&claim));
            let claim = match claim {
                Ok(c) => c,
                Err(e) => {
                    // 409: another claimer won the race, or it finished / expired since the list.
                    if !e.contains("409") {
                        eprintln!("[inbox] claim {id}: {e}");
                    }
                    continue;
                }
            };
            let token = claim["claim_token"].as_str();
            let run = run_inbox_item(&app, &id, kind, &item["payload"], token);
            // Its claim is renewed every 30 s while it runs (best-effort, never fails the turn):
            // the lease never lapses under a long turn, and the gateway keeps reading the desktop
            // as busy rather than gone, so the phone waits for Tony instead of falling back.
            let result = match token {
                Some(t) => {
                    let (app, id) = (&app, id.as_str());
                    renewing_claim(run, CLAIM_RENEW_EVERY, move || async move {
                        let r = renew_claim(app, id, kind, t).await;
                        let outcome = ClaimRenewal::of(&r, t);
                        if outcome == ClaimRenewal::Stop {
                            eprintln!("[inbox] claim {id}: renewal stopped ({})", r.err().unwrap_or_else(|| "now held under another token".into()));
                        }
                        outcome
                    })
                    .await
                }
                None => run.await,
            };
            let mut body = match result {
                Ok(v) => json!({ "ok": true, "result": v }),
                Err(e) => json!({ "ok": false, "error": e }),
            };
            if let Some(t) = claim["claim_token"].as_str() {
                body["claim_token"] = json!(t);
            }
            ran_lock(&ran).remember(&id, body.clone(), ran_memory(kind), Instant::now());
            deliver_result(&app, &ran, &id, kind, body, true).await;
        }
        let poll = inbox_round(&claims);
        if poll == InboxPoll::RanItem {
            // A turn can run for a minute or more: the active window counts from its end.
            last_item = Some(Instant::now());
        }
        wait = inbox_next_wait(poll, INBOX_LIST_WAIT, waited, n_listed, started.elapsed(), last_item.map(|t| t.elapsed()), down_streak);
    }
}

/// D1: how long the list call asks a current gateway to wait for an item to list
/// (`INBOX_LIST_PATH` carries it; a test keeps the two in step).
const INBOX_LIST_WAIT: Duration = Duration::from_secs(20);
/// D1: the list call. A current gateway waits up to `wait` seconds for an item to list.
const INBOX_LIST_PATH: &str = "/api/os/inbox?wait=20";
/// Client timeout of the long-poll list call: the gateway's 20 s wait plus slack.
const INBOX_LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// While a long-poll is open the loop still reports to the loop registry this often (its
/// overdue check expects a pass every few seconds).
const INBOX_BEAT: Duration = Duration::from_secs(5);
/// The least time between two long-poll list calls that found nothing: a gateway that said it
/// waited but barely did (the item it woke for was claimed elsewhere first) is not hammered.
const INBOX_LONG_POLL_FLOOR: Duration = Duration::from_secs(1);

/// The wait before the next list call. Pure. `asked`: the `wait` the list call asked for. A
/// current gateway (`waited` present) that was asked to wait and listed nothing already waited
/// for the phone, so the loop lists again at once (never sooner than `INBOX_LONG_POLL_FLOOR`
/// after the last call began). Everything else keeps `inbox_wait`'s cadence: a call that asked
/// for no wait (a current gateway reports `waited: 0.0` for `wait=0` too, so `waited` alone
/// doesn't make it a long-poll), an old gateway (no `waited`), a round that listed items (a won
/// claim re-polls at once; refused, bad-id or re-posted items back off as before), and a
/// gateway that is down.
pub(crate) fn inbox_next_wait(poll: InboxPoll, asked: Duration, waited: Option<f64>, listed: usize, since_start: Duration, since_item: Option<Duration>, down_streak: u32) -> Duration {
    match waited {
        Some(w) if !asked.is_zero() && listed == 0 && poll == InboxPoll::NothingRan => INBOX_LONG_POLL_FLOOR.saturating_sub(Duration::try_from_secs_f64(w).unwrap_or(Duration::ZERO)),
        _ => inbox_wait(poll, since_start, since_item, down_streak),
    }
}

/// `fut`'s output, calling `beat` every `every` while it is pending.
pub(crate) async fn beating<F: std::future::Future>(fut: F, every: Duration, mut beat: impl FnMut()) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    loop {
        tokio::select! {
            out = &mut fut => return out,
            _ = tokio::time::sleep(every) => beat(),
        }
    }
}

// ── D2: an inbox turn's answer, streamed to the gateway as `/delta`s ────────

/// Visible text waits at most this long before it is posted (a sentence end posts it sooner).
const DELTA_FLUSH: Duration = Duration::from_millis(400);
/// A delta post that failed (not a 404 / 409) is tried again after this, same seq and text.
const DELTA_RETRY_GAP: Duration = Duration::from_millis(500);
/// Failed delta posts in a row before an item's stream is given up (its result still lands).
const DELTA_MAX_FAILURES: u32 = 3;
/// Per-request timeout of one delta post (loopback; a hung gateway must not hold the stream).
const DELTA_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a finished turn waits for a delta post still on the wire before its result is
/// posted (so the deltas land first); past it the post is dropped.
const DELTA_DRAIN: Duration = Duration::from_secs(2);

/// An inbox turn's delta stream: the sink Tony's answer streams into, and the task that posts it.
struct InboxDeltas {
    sink: super::agents::AnswerSink,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl InboxDeltas {
    fn start(app: &AppHandle, id: &str, claim_token: &str) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let sink: super::agents::AnswerSink = Arc::new(move |piece: &str| {
            let _ = tx.send(piece.to_string());
        });
        let cfg = app.state::<OsState>().snapshot();
        let (app, id, token) = (app.clone(), id.to_string(), claim_token.to_string());
        let task = tauri::async_runtime::spawn(pump_deltas(rx, move |seq, text| {
            let (app, cfg, id, token) = (app.clone(), cfg.clone(), id.clone(), token.clone());
            async move { post_delta(&app.state::<DispatchState>(), &cfg, &id, &token, seq, &text).await }
        }));
        InboxDeltas { sink, task }
    }

    fn sink(&self) -> super::agents::AnswerSink {
        self.sink.clone()
    }

    /// The turn is over: close the stream (unposted text is dropped, the result carries it) and
    /// give a delta still on the wire `DELTA_DRAIN` to land.
    async fn finish(self) {
        let InboxDeltas { sink, mut task } = self;
        drop(sink);
        if tokio::time::timeout(DELTA_DRAIN, &mut task).await.is_err() {
            task.abort();
        }
    }
}

/// `POST /api/os/inbox/{id}/delta {claim_token, seq, text}`: one piece of a running turn's answer.
pub(crate) async fn post_delta(state: &DispatchState, cfg: &OsConfig, id: &str, claim_token: &str, seq: u64, text: &str) -> Result<Value, String> {
    gw_t(state, cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/delta"), Some(json!({ "claim_token": claim_token, "seq": seq, "text": text })), DELTA_TIMEOUT).await
}

/// Post a turn's streamed answer as `/delta`s (`post(seq, text)`) until the stream closes (the
/// turn ended) or the gateway refuses it. Best-effort: nothing here can fail the turn.
pub(crate) async fn pump_deltas<P, F>(mut rx: tokio::sync::mpsc::UnboundedReceiver<String>, mut post: P)
where
    P: FnMut(u64, String) -> F,
    F: std::future::Future<Output = Result<Value, String>>,
{
    let mut ds = DeltaStream::default();
    loop {
        // Refused, given up, or diverged: done (dropping `rx` makes the sink's sends no-ops).
        if ds.stopped {
            return;
        }
        let got = match ds.deadline() {
            Some(at) => tokio::time::timeout_at(tokio::time::Instant::from_std(at), rx.recv()).await.ok(),
            None => Some(rx.recv().await),
        };
        match got {
            Some(Some(piece)) => ds.feed(&piece, Instant::now()),
            // The turn ended: its result is the whole answer.
            Some(None) => return,
            // A flush or retry is due.
            None => {}
        }
        while let Ok(piece) = rx.try_recv() {
            ds.feed(&piece, Instant::now());
        }
        while let Some((seq, text)) = ds.due(Instant::now()) {
            let r = post(seq, text).await;
            ds.posted(DeltaPost::of(&r), Instant::now());
        }
    }
}

/// What a delta post came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeltaPost {
    /// Stored (or an idempotent repeat of a seq the gateway already has).
    Accepted,
    /// 404 (unknown item, or an old gateway without `/delta`) or 409 (not running any more, a
    /// newer claim, a seq gap): stop streaming this item.
    Stop,
    /// Anything else (timeout, gateway down, 5xx): the same seq and text again, a few times.
    Retry,
}

impl DeltaPost {
    /// Pure.
    pub(crate) fn of(r: &Result<Value, String>) -> Self {
        match r {
            Ok(_) => DeltaPost::Accepted,
            Err(e) if matches!(gateway_status(e), Some(404 | 409)) => DeltaPost::Stop,
            Err(_) => DeltaPost::Retry,
        }
    }
}

/// The delta state of one inbox turn. Pure (the caller passes the clock).
///
/// `feed` takes the think-filtered stream; what is posted is its VISIBLE text (`visible_answer`:
/// a dispatch packet's spoken_reply, never `[[LEARN …]]` tags), so the gateway's `partial` only
/// ever grows. Should the visible text stop extending what was already sent, streaming stops
/// for that item (the result is authoritative). One post at a time: seq n+1 is only sent once
/// seq n was accepted, and a failed post is retried with exactly the same seq and text (the
/// gateway answers a repeat of a stored seq with a no-op 200).
#[derive(Debug, Default)]
pub(crate) struct DeltaStream {
    raw: String,
    /// Visible text already handed out (posted, in flight or pending).
    shown: String,
    pending: String,
    pending_since: Option<Instant>,
    /// The last seq the gateway accepted (0: none yet).
    seq: u64,
    inflight: Option<(u64, String)>,
    retry_at: Option<Instant>,
    failures: u32,
    pub(crate) stopped: bool,
}

impl DeltaStream {
    /// A think-filtered piece of Tony's answer arrived.
    pub(crate) fn feed(&mut self, piece: &str, now: Instant) {
        if self.stopped {
            return;
        }
        self.raw.push_str(piece);
        let visible = visible_answer(&self.raw);
        match visible.strip_prefix(self.shown.as_str()) {
            Some("") => {}
            Some(new) => {
                self.pending.push_str(new);
                self.pending_since.get_or_insert(now);
                self.shown = visible;
            }
            None => self.stopped = true,
        }
    }

    /// The delta to post now, if any: a failed one again once its retry gap is over; else the
    /// pending text at a sentence end, or once it has waited `DELTA_FLUSH`.
    pub(crate) fn due(&mut self, now: Instant) -> Option<(u64, String)> {
        if self.stopped {
            return None;
        }
        // In flight: on the wire (no retry time yet), or failed and waiting out its gap.
        if self.inflight.is_some() {
            if !self.retry_at.is_some_and(|t| now >= t) {
                return None;
            }
            self.retry_at = None;
            return self.inflight.clone();
        }
        let since = self.pending_since?;
        if !(has_sentence_end(&self.pending) || now.saturating_duration_since(since) >= DELTA_FLUSH) {
            return None;
        }
        self.pending_since = None;
        let d = (self.seq + 1, std::mem::take(&mut self.pending));
        self.inflight = Some(d.clone());
        self.retry_at = None;
        Some(d)
    }

    /// When `due` may next have something (`None`: nothing is waiting).
    pub(crate) fn deadline(&self) -> Option<Instant> {
        if self.stopped {
            return None;
        }
        if self.inflight.is_some() {
            return self.retry_at;
        }
        let since = self.pending_since?;
        // A sentence end is due at once (`since` has passed).
        Some(if has_sentence_end(&self.pending) { since } else { since + DELTA_FLUSH })
    }

    /// What the post of the in-flight delta came to.
    pub(crate) fn posted(&mut self, outcome: DeltaPost, now: Instant) {
        match outcome {
            DeltaPost::Accepted => {
                if let Some((seq, _)) = self.inflight.take() {
                    self.seq = seq;
                }
                self.failures = 0;
                self.retry_at = None;
            }
            DeltaPost::Stop => {
                self.stopped = true;
                self.inflight = None;
            }
            DeltaPost::Retry => {
                self.failures += 1;
                if self.failures >= DELTA_MAX_FAILURES {
                    self.stopped = true;
                    self.inflight = None;
                } else {
                    self.retry_at = Some(now + DELTA_RETRY_GAP);
                }
            }
        }
    }
}

/// A sentence (or line) ended somewhere in `s`. Pure.
pub(crate) fn has_sentence_end(s: &str) -> bool {
    s.contains(['.', '!', '?', '…', '\n', '。', '！', '？'])
}

/// The visible part of Tony's streamed (think-filtered) answer, exactly what the desktop shows
/// for the same stream (TS `spokenSoFar(buffered) ?? stripLearnTags(buffered)`), without leading
/// whitespace. Pure.
pub(crate) fn visible_answer(raw: &str) -> String {
    let s = spoken_so_far(raw).unwrap_or_else(|| strip_learn_streaming(raw));
    s.trim_start().to_string()
}

/// TS `looksLikePacket`: a (possibly partial) reply that is a dispatch packet, not prose. Pure.
fn looks_like_packet(text: &str) -> bool {
    static FENCED: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static OPENING: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let t = text.trim_start();
    t.starts_with('{')
        || FENCED.get_or_init(|| regex::Regex::new(r"(?i)^```(?:json)?\s*\{").unwrap()).is_match(t)
        || t == "`"
        || t == "``"
        || OPENING.get_or_init(|| regex::Regex::new(r"(?i)^```(?:j(?:s(?:o(?:n)?)?)?)?\s*$").unwrap()).is_match(t)
}

/// TS `spokenSoFar`: a packet's `spoken_reply`, decoded as far as it has streamed (`None`: not
/// a packet). A half-arrived escape at the end is held back, so the text only ever grows. Pure.
pub(crate) fn spoken_so_far(text: &str) -> Option<String> {
    static KEY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if !looks_like_packet(text) {
        return None;
    }
    let Some(m) = KEY.get_or_init(|| regex::Regex::new(r#""spoken_reply"\s*:\s*""#).unwrap()).find(text) else {
        return Some(String::new());
    };
    let mut out = String::new();
    let mut it = text[m.end()..].chars();
    while let Some(c) = it.next() {
        if c == '"' {
            break;
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(n) = it.next() else { break };
        if n != 'u' {
            out.push(match n {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                'b' => '\u{8}',
                'f' => '\u{c}',
                other => other,
            });
            continue;
        }
        let hex: String = it.by_ref().take(4).collect();
        let Some(u) = (hex.chars().count() == 4).then(|| u32::from_str_radix(&hex, 16).ok()).flatten() else { break };
        if !(0xD800..=0xDBFF).contains(&u) {
            out.push(char::from_u32(u).unwrap_or('\u{FFFD}'));
            continue;
        }
        // A UTF-16 high surrogate: its low half follows as another \uXXXX.
        let next: Vec<char> = it.clone().take(6).collect();
        if next.len() < 6 && next.iter().zip(['\\', 'u']).all(|(a, b)| *a == b) {
            break; // the low half is still on its way: hold the pair back
        }
        let low = (next.len() == 6 && next[0] == '\\' && next[1] == 'u').then(|| u32::from_str_radix(&next[2..].iter().collect::<String>(), 16).ok()).flatten();
        match low {
            Some(l @ 0xDC00..=0xDFFF) => {
                it.by_ref().take(6).for_each(drop);
                out.push(char::from_u32(0x10000 + ((u - 0xD800) << 10) + (l - 0xDC00)).unwrap_or('\u{FFFD}'));
            }
            _ => out.push('\u{FFFD}'),
        }
    }
    Some(out)
}

/// TS `stripLearnTags(text, false)`: `[[LEARN …]]` tags out, a trailing tag that hasn't closed
/// yet (or a `[` / `[[` / `[[LEA…` that may become one) held back, 3+ newlines → 2. Pure.
pub(crate) fn strip_learn_streaming(text: &str) -> String {
    static TAG: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static GAPS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let mut s = TAG.get_or_init(|| regex::Regex::new(r"(?is)\[\[\s*LEARN\b.*?\]\]").unwrap()).replace_all(text, "").into_owned();
    match s.rfind("[[") {
        Some(open) if !s[open..].contains("]]") => {
            let tail = s[open + 2..].trim_start().to_uppercase();
            if tail.starts_with("LEARN") || "LEARN".starts_with(tail.as_str()) {
                s.truncate(open);
            }
        }
        _ => {
            if s.ends_with('[') {
                s.pop();
            }
        }
    }
    GAPS.get_or_init(|| regex::Regex::new(r"\n{3,}").unwrap()).replace_all(&s, "\n\n").into_owned()
}

// ── Inbox results: retry, lease renewal, and the ran-items memory ───────────

/// The items this desktop ran, shared by the loop and its background result retries.
type RanMemory = Arc<Mutex<RanItems>>;

fn ran_lock(m: &RanMemory) -> MutexGuard<'_, RanItems> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One item this desktop ran, and the result body it posts for it (with its `claim_token`).
#[derive(Debug, Clone)]
struct RanItem {
    body: Value,
    /// How long it is remembered once its result settles (`ran_memory`).
    keep: Duration,
    /// When it ran, or when its last result attempt settled.
    since: Instant,
    /// A background retry is posting its result (and renewing its lease) right now.
    retrying: bool,
}

/// What this desktop ran recently. Pure (the caller passes the clock).
#[derive(Debug, Default)]
pub(crate) struct RanItems {
    items: HashMap<String, RanItem>,
}

/// What to do with an item the inbox listed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Listed {
    /// Not run here (or long forgotten): claim it and run it.
    Run,
    /// Ran here already: post the stored result instead of running it again. `retry`: a failed
    /// post may start a background retry (false while one is already running for it).
    Repost { body: Value, retry: bool },
}

impl RanItems {
    pub(crate) fn remember(&mut self, id: &str, body: Value, keep: Duration, now: Instant) {
        self.items.insert(id.to_string(), RanItem { body, keep, since: now, retrying: false });
    }

    /// The 'already ran → post the stored result' decision. An item stays remembered while its
    /// result is being retried, and for `keep` after that.
    pub(crate) fn listed(&self, id: &str, now: Instant) -> Listed {
        match self.items.get(id) {
            Some(e) if e.retrying || now.saturating_duration_since(e.since) < e.keep => Listed::Repost { body: e.body.clone(), retry: !e.retrying },
            _ => Listed::Run,
        }
    }

    /// A background retry still holds this item's result (the loop's own re-post can settle it
    /// first, which ends the retry).
    pub(crate) fn retrying(&self, id: &str) -> bool {
        self.items.get(id).is_some_and(|e| e.retrying)
    }

    /// A background retry took over this item's result.
    pub(crate) fn start_retry(&mut self, id: &str) {
        if let Some(e) = self.items.get_mut(id) {
            e.retrying = true;
        }
    }

    /// Its result was delivered, refused (404 / 409) or given up on: `keep` counts from now.
    pub(crate) fn settle(&mut self, id: &str, now: Instant) {
        if let Some(e) = self.items.get_mut(id) {
            e.retrying = false;
            e.since = now;
        }
    }

    /// Forget items past their memory (never one whose result is still being retried).
    pub(crate) fn prune(&mut self, now: Instant) {
        self.items.retain(|_, e| e.retrying || now.saturating_duration_since(e.since) < e.keep);
    }
}

/// Ten minutes, the floor of how long a ran item is remembered.
const RAN_MEMORY: Duration = Duration::from_secs(10 * 60);
/// Margin past the lease for request time and clock slop.
const RAN_MEMORY_SLACK: Duration = Duration::from_secs(2 * 60);

/// How long a ran item is remembered after its result settles. Pure. The gateway only lists it
/// again once its lease lapses, at most `claim_lease` after the last renewal (a Play Place lease
/// is 15 minutes), so the memory always outlasts the lease.
pub(crate) fn ran_memory(kind: Option<&str>) -> Duration {
    RAN_MEMORY.max(Duration::from_secs(claim_lease(kind)) + RAN_MEMORY_SLACK)
}

/// What a result POST came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResultPost {
    /// The gateway stored it.
    Delivered,
    /// 404 (the item is gone) or 409 (a newer claim superseded this one, or the phone cancelled
    /// it): retrying can never succeed.
    Refused,
    /// Anything else (gateway down or restarting, a timeout, a 5xx, an auth error): retried.
    Retry,
}

impl ResultPost {
    /// Pure.
    pub(crate) fn of(r: &Result<Value, String>) -> Self {
        match r {
            Ok(_) => ResultPost::Delivered,
            Err(e) if matches!(gateway_status(e), Some(404 | 409)) => ResultPost::Refused,
            Err(_) => ResultPost::Retry,
        }
    }
}

/// The HTTP status of a `gw` error ("gateway 409: …"); `None` for a transport error. Pure.
pub(crate) fn gateway_status(e: &str) -> Option<u16> {
    e.strip_prefix("gateway ")?.split(':').next()?.trim().parse().ok()
}

/// Backoff between result attempts: 2, 4, 8, 15 s, then every 30 s.
const RESULT_BACKOFF_SECS: [u64; 5] = [2, 4, 8, 15, 30];
/// How long a failed result is retried. Past it the item's lease lapses and the gateway lists it
/// again; the ran memory then answers with the stored result instead of a second run.
const RESULT_RETRY_BUDGET: Duration = Duration::from_secs(5 * 60);

/// The wait before result attempt `attempt` (0 = the first retry), `elapsed` into the retry;
/// `None` once the next attempt would land past the five-minute budget. Pure.
pub(crate) fn result_retry_wait(attempt: u32, elapsed: Duration) -> Option<Duration> {
    let i = (attempt as usize).min(RESULT_BACKOFF_SECS.len() - 1);
    let d = Duration::from_secs(RESULT_BACKOFF_SECS[i]);
    (elapsed + d <= RESULT_RETRY_BUDGET).then_some(d)
}

async fn post_result(app: &AppHandle, id: &str, body: &Value) -> Result<Value, String> {
    let st = app.state::<DispatchState>();
    let cfg = app.state::<OsState>().snapshot();
    gw(&st, &cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/result"), Some(body.clone())).await
}

/// Renew this desktop's claim on an item it holds (while it runs, and while its result is
/// retried): claiming again with the same `claim_token` extends a live claim (and a lapsed one
/// nobody else took), so the gateway never re-offers it, and counts the desktop as seen.
async fn renew_claim(app: &AppHandle, id: &str, kind: Option<&str>, token: &str) -> Result<Value, String> {
    let st = app.state::<DispatchState>();
    let cfg = app.state::<OsState>().snapshot();
    post_claim_renewal(&st, &cfg, id, kind, token).await
}

/// `POST /api/os/inbox/{id}/claim {claim_token, lease_secs}`: the renewal call itself.
pub(crate) async fn post_claim_renewal(state: &DispatchState, cfg: &OsConfig, id: &str, kind: Option<&str>, token: &str) -> Result<Value, String> {
    gw(state, cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/claim"), Some(json!({ "lease_secs": claim_lease(kind), "claim_token": token }))).await
}

/// How often the claim of the item the desktop is running is renewed. The gateway reads a
/// running item as "desktop busy" only while the desktop was seen in the last 90 s (os_api
/// `DESKTOP_RUN_SEEN_SECS`: three renewals of slack), and the shortest lease is 120 s.
const CLAIM_RENEW_EVERY: Duration = Duration::from_secs(30);

/// What one claim renewal came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimRenewal {
    /// The gateway extended this run's claim.
    Renewed,
    /// 404 (the item is gone), 409 (cancelled, finished, or claimed elsewhere), or a claim that
    /// came back under another token (this run's claim was lost): renewing again can't help.
    Stop,
    /// Anything else (a timeout, the gateway down, a 5xx): tried again at the next renewal.
    Retry,
}

impl ClaimRenewal {
    /// Pure. `token`: the claim this run holds.
    pub(crate) fn of(r: &Result<Value, String>, token: &str) -> Self {
        match r {
            Ok(v) if v["claim_token"].as_str().is_some_and(|t| t != token) => ClaimRenewal::Stop,
            Ok(_) => ClaimRenewal::Renewed,
            Err(e) if matches!(gateway_status(e), Some(404 | 409)) => ClaimRenewal::Stop,
            Err(_) => ClaimRenewal::Retry,
        }
    }
}

/// The renewal schedule of one running item. Pure (the caller passes the clock). The first
/// renewal is due `every` after the claim, each later one `every` after the previous one BEGAN
/// (a slow call never stretches the gap), whatever it came to, until one says `Stop`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ClaimRenewer {
    every: Duration,
    next: Option<Instant>,
}

impl ClaimRenewer {
    pub(crate) fn new(claimed: Instant, every: Duration) -> Self {
        ClaimRenewer { every, next: Some(claimed + every) }
    }

    /// When the next renewal is due (`None`: renewing has stopped for good).
    pub(crate) fn due(&self) -> Option<Instant> {
        self.next
    }

    /// The renewal that began at `began` came to `outcome`.
    pub(crate) fn renewed(&mut self, outcome: ClaimRenewal, began: Instant) {
        self.next = match outcome {
            ClaimRenewal::Stop => None,
            ClaimRenewal::Renewed | ClaimRenewal::Retry => self.next.map(|_| began + self.every),
        };
    }
}

/// `run`'s output, renewing the running item's claim (`renew()`) on `ClaimRenewer`'s schedule
/// until `run` ends. Best-effort: a renewal never fails or holds up the run, and one still on the
/// wire when the run ends is dropped.
pub(crate) async fn renewing_claim<F, R, RF>(run: F, every: Duration, mut renew: R) -> F::Output
where
    F: std::future::Future,
    R: FnMut() -> RF,
    RF: std::future::Future<Output = ClaimRenewal>,
{
    let mut run = std::pin::pin!(run);
    let mut sched = ClaimRenewer::new(Instant::now(), every);
    while let Some(at) = sched.due() {
        tokio::select! {
            biased;
            out = &mut run => return out,
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(at)) => {}
        }
        let began = Instant::now();
        let outcome = tokio::select! {
            biased;
            out = &mut run => return out,
            r = renew() => r,
        };
        sched.renewed(outcome, began);
    }
    run.await
}

/// Post a ran item's result once. A failure that can clear (the gateway down, a timeout, a 5xx)
/// hands it to a background retry (`retry_result`) so the loop keeps serving the phone; a 404 /
/// 409 is final. `may_retry`: false when a background retry already holds this item.
async fn deliver_result(app: &AppHandle, ran: &RanMemory, id: &str, kind: Option<&str>, body: Value, may_retry: bool) {
    let r = post_result(app, id, &body).await;
    match ResultPost::of(&r) {
        ResultPost::Retry if may_retry => {
            if let Err(e) = &r {
                eprintln!("[inbox] result {id}: {e}; retrying");
            }
            ran_lock(ran).start_retry(id);
            tauri::async_runtime::spawn(retry_result(app.clone(), ran.clone(), id.to_string(), kind.map(String::from), body));
        }
        // The running retry keeps at it.
        ResultPost::Retry => {}
        ResultPost::Delivered | ResultPost::Refused => ran_lock(ran).settle(id, Instant::now()),
    }
}

/// Retry a result with backoff for up to five minutes, renewing the item's lease before each
/// attempt (the longest gap, 30 s + two 20 s calls, is well inside the shortest lease, 120 s).
/// Stops on delivery or a 404 / 409.
async fn retry_result(app: AppHandle, ran: RanMemory, id: String, kind: Option<String>, body: Value) {
    let started = Instant::now();
    let token = body["claim_token"].as_str().map(String::from);
    let mut attempt = 0u32;
    let outcome = loop {
        let Some(delay) = result_retry_wait(attempt, started.elapsed()) else {
            break None;
        };
        attempt += 1;
        if let Some(t) = &token {
            let _ = renew_claim(&app, &id, kind.as_deref(), t).await;
        }
        tokio::time::sleep(delay).await;
        // The inbox loop re-posted it meanwhile (the gateway listed it again) and that settled it.
        if !ran_lock(&ran).retrying(&id) {
            break Some(ResultPost::Delivered);
        }
        match ResultPost::of(&post_result(&app, &id, &body).await) {
            ResultPost::Retry => continue,
            done => break Some(done),
        }
    };
    if outcome.is_none() {
        eprintln!("[inbox] result {id}: gave up after {attempt} retries; a re-listing gets the stored result");
    }
    ran_lock(&ran).settle(&id, Instant::now());
}

const INBOX_FAST: Duration = Duration::from_secs(3);
const INBOX_IDLE: Duration = Duration::from_secs(10);
const INBOX_DOWN: Duration = Duration::from_secs(15);
/// The first `INBOX_DOWN_RETRIES` failed polls in a row wait only this long: a gateway restart
/// takes a few seconds, and the phone gives the desktop 12 s to pick a turn up.
const INBOX_DOWN_RETRY: Duration = Duration::from_secs(5);
const INBOX_DOWN_RETRIES: u32 = 3;
/// How long the 3 s cadence lasts after the inbox last held an item.
const INBOX_ACTIVE_WINDOW: Duration = Duration::from_secs(5 * 60);
/// How long the 3 s cadence lasts after app start with no item yet (a phone turn queued while
/// the desktop was starting is picked up fast). Launch alone isn't phone use: 20 polls, not 100.
const INBOX_START_GRACE: Duration = Duration::from_secs(60);

/// How the last inbox poll went, as far as the next wait cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InboxPoll {
    /// The gateway didn't answer the list call.
    GatewayDown,
    /// This desktop claimed and ran at least one item.
    RanItem,
    /// The gateway answered, and nothing was run (empty, or every claim refused).
    NothingRan,
}

/// What became of one item a poll listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InboxClaim {
    /// Its id is missing or unsafe in a URL path: never claimed.
    BadId,
    /// The claim call failed: 409 (another claimer won the race, or it finished / expired since
    /// the list), any other gateway error, or the gateway dropped.
    Refused,
    /// This desktop holds the lease and ran the item.
    Won,
    /// This desktop ran it already (`RanItems`): its stored result was posted again, nothing ran.
    Reposted,
}

impl InboxClaim {
    /// The outcome of a claim call that was made. Pure.
    pub(crate) fn of(claim: &Result<Value, String>) -> Self {
        if claim.is_ok() {
            InboxClaim::Won
        } else {
            InboxClaim::Refused
        }
    }
}

/// A listed item's id, when it is safe to put in `/api/os/inbox/{id}/…`. Pure.
pub(crate) fn inbox_item_id(item: &Value) -> Option<String> {
    let id = item["id"].as_str()?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then(|| id.to_string())
}

/// The per-round decision for `inbox_wait`. Pure. Only a claim this desktop won earns an
/// immediate re-poll. A refused claim or a bad id runs nothing: a bad id stays listed for good,
/// and a refused claim's cause (an auth or schema error, a flaky gateway) can repeat on every
/// round, so counting either would re-poll the gateway back to back.
pub(crate) fn inbox_round(claims: &[InboxClaim]) -> InboxPoll {
    if claims.contains(&InboxClaim::Won) {
        InboxPoll::RanItem
    } else {
        InboxPoll::NothingRan
    }
}

/// How long the inbox loop sleeps before its next poll. Pure. `since_start`: time since the
/// loop started; `since_item`: time since the inbox last held an item (`None`: never, this run);
/// `down_streak`: failed list calls in a row, this one included (0 once the gateway answers).
pub(crate) fn inbox_wait(poll: InboxPoll, since_start: Duration, since_item: Option<Duration>, down_streak: u32) -> Duration {
    match poll {
        // A restarted gateway is polled again inside the phone's 12 s pickup window.
        InboxPoll::GatewayDown if down_streak <= INBOX_DOWN_RETRIES => INBOX_DOWN_RETRY,
        InboxPoll::GatewayDown => INBOX_DOWN,
        // A turn the phone queued while the last one ran is claimed without a sleep.
        InboxPoll::RanItem => Duration::ZERO,
        InboxPoll::NothingRan if since_item.is_some_and(|d| d < INBOX_ACTIVE_WINDOW) => INBOX_FAST,
        InboxPoll::NothingRan if since_start < INBOX_START_GRACE => INBOX_FAST,
        InboxPoll::NothingRan => INBOX_IDLE,
    }
}

/// Where a queued phone turn goes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InboxTurnRoute {
    /// An approved build (`capture: true`): ledger idea + task.
    Capture,
    /// An idea-shaped turn from a stale phone build: saved to the ledger, never built.
    Park,
    /// A normal Tony turn (`run_os_turn`).
    OsTurn,
}

/// P3: the phone's own tier classifier decides. `capture: true` is an approved Tier-3 "yes"
/// on a build-shaped idea; `noDelegate` (a Tier-2 brainstorm) never reaches the Prompter. A
/// current client always sends `noDelegate`; a stale build that sends neither only gets its
/// idea parked in the ledger (an envelope needs an approved yes or a ledger Run).
pub(crate) fn inbox_turn_route(p: &Value) -> InboxTurnRoute {
    if p["noDelegate"].as_bool() == Some(true) {
        return InboxTurnRoute::OsTurn;
    }
    if p["capture"].as_bool() == Some(true) {
        return InboxTurnRoute::Capture;
    }
    if p.get("noDelegate").is_some() {
        return InboxTurnRoute::OsTurn;
    }
    if looks_like_idea(p["text"].as_str().unwrap_or("")) {
        InboxTurnRoute::Park
    } else {
        InboxTurnRoute::OsTurn
    }
}

/// "I've been thinking about building an app that…" → an idea.
pub fn looks_like_idea(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(i'?ve been thinking (about|of)|i'?m thinking (about|of)|i (want|wanna|would like) to (build|make|create)|idea for (an?|my)? ?(app|tool|site|website|product|game|platform|service|plugin|widget)|what if (i|we) (built|made|created)|i have an idea|new idea:|app idea|business idea)\b").unwrap()
    })
    .is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Comms step 1: trust is an exact match on the gateway's normalized key, never a substring
    /// (the gateway's `?q=` is a LIKE, so it hands back near-misses that must not count).
    #[test]
    fn whatsapp_trust_is_an_exact_key_match() {
        assert_eq!(comms_contact_key("+1 (416) 555-1234"), "4165551234");
        assert_eq!(comms_contact_key("14165551234@S.WhatsApp.net"), "14165551234@s.whatsapp.net");
        assert_eq!(comms_contact_key("  "), "unknown");
        let contacts = vec![
            json!({ "address": "4165551234", "name": "Mom", "trusted": 1 }),
            json!({ "address": "14165559999@s.whatsapp.net", "name": "Sam", "trusted": 1 }),
            json!({ "address": "6475550000", "name": "Stranger", "trusted": 0 }),
        ];
        // Exact (after normalizing the formatting / country code / JID case).
        assert!(is_trusted_exact(&contacts, "+1 416-555-1234"));
        assert!(is_trusted_exact(&contacts, "4165551234"));
        assert!(is_trusted_exact(&contacts, "14165559999@S.WHATSAPP.NET"));
        // A substring of a trusted number, or a longer string containing one, is not trusted.
        assert!(!is_trusted_exact(&contacts, "1234"));
        assert!(!is_trusted_exact(&contacts, "555"));
        assert!(!is_trusted_exact(&contacts, "4165551234@s.whatsapp.net"), "a JID is not the SMS number");
        assert!(!is_trusted_exact(&contacts, "16475551234"), "different number, same tail digits elsewhere");
        // An untrusted exact match, an empty recipient, or no contacts at all.
        assert!(!is_trusted_exact(&contacts, "647-555-0000"));
        assert!(!is_trusted_exact(&contacts, ""));
        assert!(!is_trusted_exact(&[], "4165551234"));
        // The old bug: any trusted row in the LIKE result counted, even for an unrelated recipient.
        let like_result = vec![json!({ "address": "4165551234", "trusted": 1 }), json!({ "address": "4165551299", "trusted": 0 })];
        assert!(!is_trusted_exact(&like_result, "4165551299"));
    }

    /// Decision 5: only a hand-typed reply (`ui-typed`) to an exactly trusted contact skips the card;
    /// voice, Tony, agents, a UI card and a missing origin all need `approved`.
    #[test]
    fn whatsapp_send_needs_the_card_unless_typed_by_hand_to_a_trusted_contact() {
        assert_eq!(comms_send_origin(Some("ui_typed")), "ui-typed");
        assert_eq!(comms_send_origin(Some(" UI-Typed ")), "ui-typed");
        assert_eq!(comms_send_origin(None), "agent");
        assert_eq!(comms_send_origin(Some("")), "agent");
        assert!(comms_send_allowed(false, "ui-typed", true).is_ok());
        assert_eq!(comms_send_allowed(false, "ui-typed", false).unwrap_err(), "PERMISSION_REQUIRED:send");
        for o in ["ui-card", "voice", "tony", "agent", "something-else"] {
            assert_eq!(comms_send_allowed(false, o, true).unwrap_err(), "PERMISSION_REQUIRED:send", "{o} to a trusted contact");
            assert!(comms_send_allowed(true, o, true).is_ok(), "{o} approved on the card");
            assert!(comms_send_allowed(true, o, false).is_ok(), "{o} approved on the card");
        }
        assert_eq!(comms_send_allowed(false, &comms_send_origin(None), true).unwrap_err(), "PERMISSION_REQUIRED:send");
    }

    #[test]
    fn inbox_backs_off_when_idle_or_down() {
        let s = Duration::from_secs;
        let quiet = InboxPoll::NothingRan;
        // Well past the start grace: only the last item sets the cadence.
        let up = s(3_600);
        assert_eq!(inbox_wait(quiet, up, Some(s(0)), 0), s(3));
        assert_eq!(inbox_wait(quiet, up, Some(s(60)), 0), s(3), "still fast a minute after the last item");
        assert_eq!(inbox_wait(quiet, up, Some(s(299)), 0), s(3), "fast for five minutes after the last item");
        assert_eq!(inbox_wait(quiet, up, Some(s(300)), 0), s(10), "then idle");
        assert_eq!(inbox_wait(quiet, up, Some(s(86_400)), 0), s(10));
        assert_eq!(inbox_wait(quiet, up, None, 0), s(10), "no item since launch");
        // A gateway that stays down (past the first three failures) backs off to 15 s.
        assert_eq!(inbox_wait(InboxPoll::GatewayDown, s(0), None, 4), s(15), "gateway down at launch");
        assert_eq!(inbox_wait(InboxPoll::GatewayDown, up, Some(s(0)), 4), s(15), "gateway down mid-use");
        assert_eq!(inbox_wait(InboxPoll::GatewayDown, up, Some(s(86_400)), 9), s(15), "gateway down, idle");
    }

    /// Integration review (B): after a failed list call the loop always slept 15 s, so a gateway
    /// that restarted in two seconds wasn't polled again before the phone's 12 s pickup window
    /// closed, and the phone fell back. The first three failures in a row now wait 5 s.
    #[test]
    fn a_restarted_gateway_is_polled_inside_the_phone_pickup_window() {
        let s = Duration::from_secs;
        const PHONE_PICKUP_WINDOW: Duration = Duration::from_secs(12);
        for streak in 1..=3 {
            for (start, item) in [(s(0), None), (s(3_600), Some(s(0))), (s(3_600), Some(s(86_400)))] {
                let w = inbox_wait(InboxPoll::GatewayDown, start, item, streak);
                assert_eq!(w, s(5), "failure #{streak}");
                assert!(w < PHONE_PICKUP_WINDOW);
            }
        }
        for streak in [4, 5, 100, u32::MAX] {
            assert_eq!(inbox_wait(InboxPoll::GatewayDown, s(3_600), Some(s(0)), streak), s(15), "a long outage, failure #{streak}");
        }
        // The streak only matters while the gateway is down.
        assert_eq!(inbox_wait(InboxPoll::NothingRan, s(3_600), Some(s(0)), 7), s(3));
        assert_eq!(inbox_wait(InboxPoll::RanItem, s(3_600), Some(s(0)), 7), Duration::ZERO);
    }

    /// Integration review (A): the backoff for a failed result POST: 2, 4, 8, 15, then 30 s,
    /// for at most five minutes.
    #[test]
    fn result_retry_backs_off_for_five_minutes() {
        let s = Duration::from_secs;
        assert_eq!(result_retry_wait(0, s(0)), Some(s(2)));
        assert_eq!(result_retry_wait(1, s(2)), Some(s(4)));
        assert_eq!(result_retry_wait(2, s(6)), Some(s(8)));
        assert_eq!(result_retry_wait(3, s(14)), Some(s(15)));
        assert_eq!(result_retry_wait(4, s(29)), Some(s(30)));
        assert_eq!(result_retry_wait(50, s(29)), Some(s(30)), "capped at 30 s");
        assert_eq!(result_retry_wait(u32::MAX, s(0)), Some(s(30)));
        // With instant attempts: 13 retries, the last one 299 s in.
        let (mut t, mut n, mut waits) = (Duration::ZERO, 0u32, Vec::new());
        while let Some(d) = result_retry_wait(n, t) {
            waits.push(d.as_secs());
            t += d;
            n += 1;
        }
        assert_eq!(waits, vec![2, 4, 8, 15, 30, 30, 30, 30, 30, 30, 30, 30, 30]);
        assert_eq!(t, s(299));
        // Slow attempts (a hung gateway eats 20 s per call) end it sooner, never past 5 min.
        assert_eq!(result_retry_wait(5, s(270)), Some(s(30)));
        assert_eq!(result_retry_wait(5, s(271)), None);
        assert_eq!(result_retry_wait(0, s(299)), None);
        // The longest gap between lease renewals (a backoff plus a result call and a renewal call)
        // is inside every kind's lease, so the gateway never re-offers an item mid-retry.
        let gap = s(*RESULT_BACKOFF_SECS.iter().max().unwrap()) + GW_TIMEOUT * 2;
        for kind in [None, Some("task"), Some("pipeline"), Some("turn"), Some("command"), Some("playplace")] {
            assert!(gap < s(claim_lease(kind)), "{kind:?}");
        }
    }

    /// Integration review (A): a result POST is retried until it lands or the gateway answers
    /// 404 / 409.
    #[test]
    fn result_posts_stop_on_delivery_or_404_409() {
        assert_eq!(ResultPost::of(&Ok(json!({ "ok": true }))), ResultPost::Delivered);
        assert_eq!(ResultPost::of(&Err("gateway 409: claim superseded".into())), ResultPost::Refused);
        assert_eq!(ResultPost::of(&Err("gateway 409: cancelled".into())), ResultPost::Refused);
        assert_eq!(ResultPost::of(&Err("gateway 404: Not found".into())), ResultPost::Refused);
        for e in ["unreachable", "timed out", "gateway 500: error", "gateway 502: error", "gateway 401: unauthorized", "HTTP 409 Conflict", "error decoding response body"] {
            assert_eq!(ResultPost::of(&Err(e.into())), ResultPost::Retry, "{e}");
        }
        assert_eq!(gateway_status("gateway 409: claim superseded"), Some(409));
        assert_eq!(gateway_status("gateway 404: Not found"), Some(404));
        assert_eq!(gateway_status("unreachable"), None);
        assert_eq!(gateway_status("gateway down"), None);
    }

    /// Integration review (A): an item this desktop ran is never run again while it is
    /// remembered: a re-listing (its result never landed, its lease lapsed) posts the stored
    /// result instead.
    #[test]
    fn an_item_that_already_ran_gets_its_stored_result_not_a_second_run() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let body = json!({ "ok": true, "result": { "answer": "done" }, "claim_token": "tok" });
        let mut ran = RanItems::default();
        assert_eq!(ran.listed("q1", t0), Listed::Run, "never ran here");
        ran.remember("q1", body.clone(), ran_memory(Some("turn")), t0);
        assert_eq!(ran.listed("q1", t0 + s(60)), Listed::Repost { body: body.clone(), retry: true });
        assert_eq!(ran.listed("q1", t0 + s(599)), Listed::Repost { body: body.clone(), retry: true });
        assert_eq!(ran.listed("q2", t0 + s(60)), Listed::Run, "another item runs");
        assert_eq!(ran.listed("q1", t0 + s(600)), Listed::Run, "forgotten after ten minutes");
        // While a background retry holds it: repost, but never start a second retry, and it
        // is remembered for as long as that retry lasts.
        assert!(!ran.retrying("q1"));
        ran.start_retry("q1");
        assert!(ran.retrying("q1") && !ran.retrying("q2"));
        assert_eq!(ran.listed("q1", t0 + s(60)), Listed::Repost { body: body.clone(), retry: false });
        assert_eq!(ran.listed("q1", t0 + s(3_600)), Listed::Repost { body: body.clone(), retry: false });
        ran.prune(t0 + s(3_600));
        assert_eq!(ran.listed("q1", t0 + s(3_600)), Listed::Repost { body: body.clone(), retry: false }, "pruning keeps a retrying item");
        // Settling restarts the memory from that moment.
        let t1 = t0 + s(3_600);
        ran.settle("q1", t1);
        assert!(!ran.retrying("q1"), "a settled item ends its background retry");
        assert_eq!(ran.listed("q1", t1 + s(599)), Listed::Repost { body: body.clone(), retry: true });
        ran.prune(t1 + s(600));
        assert_eq!(ran.listed("q1", t1 + s(600)), Listed::Run);
        assert!(ran.items.is_empty(), "pruned");
        // A re-run (long forgotten) replaces the stored result.
        let newer = json!({ "ok": false, "error": "x", "claim_token": "tok2" });
        ran.remember("q1", newer.clone(), ran_memory(None), t1);
        assert_eq!(ran.listed("q1", t1), Listed::Repost { body: newer, retry: true });
        // Settling or retrying an unknown id is a no-op.
        ran.start_retry("nope");
        ran.settle("nope", t1);
        assert_eq!(ran.listed("nope", t1), Listed::Run);
    }

    /// The memory outlasts every kind's lease: the gateway lists a ran item again only after its
    /// lease lapses, at most `claim_lease` after the last renewal.
    #[test]
    fn ran_memory_outlasts_every_lease() {
        assert_eq!(ran_memory(Some("turn")), Duration::from_secs(600));
        assert_eq!(ran_memory(Some("task")), Duration::from_secs(600));
        assert_eq!(ran_memory(Some("playplace")), Duration::from_secs(900 + 120), "a 15-minute Play Place lease");
        for kind in [None, Some("task"), Some("pipeline"), Some("turn"), Some("command"), Some("playplace")] {
            assert!(ran_memory(kind) > Duration::from_secs(claim_lease(kind)), "{kind:?}");
            assert!(ran_memory(kind) >= RAN_MEMORY);
        }
    }

    /// Regression: launch counted as inbox activity, so every app start polled every 3 s for
    /// five minutes (~100 GETs) with no phone in sight. Now it is one minute (~20).
    #[test]
    fn app_start_alone_gets_a_one_minute_fast_window() {
        let s = Duration::from_secs;
        let quiet = InboxPoll::NothingRan;
        assert_eq!(inbox_wait(quiet, s(0), None, 0), s(3));
        assert_eq!(inbox_wait(quiet, s(59), None, 0), s(3), "a phone turn queued during startup is picked up fast");
        assert_eq!(inbox_wait(quiet, s(60), None, 0), s(10), "launch alone isn't phone use");
        assert_eq!(inbox_wait(quiet, s(299), None, 0), s(10), "not the five-minute active window");
        // A real item inside the grace earns the full five minutes from that item.
        assert_eq!(inbox_wait(quiet, s(90), Some(s(60)), 0), s(3));
        assert_eq!(inbox_wait(quiet, s(329), Some(s(299)), 0), s(3));
        assert_eq!(inbox_wait(quiet, s(330), Some(s(300)), 0), s(10));
        // The whole fast budget for a launch with no phone: 60 s / 3 s = 20 polls.
        let mut t = Duration::ZERO;
        let mut fast = 0;
        while inbox_wait(quiet, t, None, 0) == INBOX_FAST {
            t += INBOX_FAST;
            fast += 1;
        }
        assert_eq!(fast, 20);
    }

    /// D1: a current gateway long-polls the list call, so an empty answer means it already waited
    /// for the phone: the loop lists again at once instead of sleeping 3-10 s on top. An old
    /// gateway (no `waited`) keeps the old cadence; errors keep the down-streak back-off.
    #[test]
    fn a_long_polled_empty_list_is_listed_again_at_once() {
        let s = Duration::from_secs;
        let quiet = InboxPoll::NothingRan;
        let up = s(3_600);
        let asked = INBOX_LIST_WAIT;
        assert_eq!(inbox_next_wait(quiet, asked, Some(20.0), 0, up, None, 0), Duration::ZERO, "idle desktop, full wait");
        assert_eq!(inbox_next_wait(quiet, asked, Some(20.004), 0, up, Some(s(0)), 0), Duration::ZERO, "phone in use");
        assert_eq!(inbox_next_wait(quiet, asked, Some(1.0), 0, s(0), None, 0), Duration::ZERO, "at launch");
        // It barely waited (the item it woke for was claimed elsewhere): never a hot loop.
        assert_eq!(inbox_next_wait(quiet, asked, Some(0.25), 0, up, None, 0), Duration::from_millis(750));
        for odd in [0.0, -3.0, f64::NAN] {
            assert_eq!(inbox_next_wait(quiet, asked, Some(odd), 0, up, None, 0), s(1), "{odd}");
        }
        // An old gateway answers at once: today's 3 s / 10 s cadence.
        assert_eq!(inbox_next_wait(quiet, asked, None, 0, up, None, 0), s(10));
        assert_eq!(inbox_next_wait(quiet, asked, None, 0, up, Some(s(0)), 0), s(3));
        assert_eq!(inbox_next_wait(quiet, asked, None, 0, s(0), None, 0), s(3));
        // Items listed but nothing ran (refused / bad id / re-posted): they stay listable, so a
        // long-poll would answer at once; the old back-off holds, never zero.
        assert_eq!(inbox_next_wait(quiet, asked, Some(0.0), 2, up, Some(s(0)), 0), s(3));
        assert_eq!(inbox_next_wait(quiet, asked, Some(20.0), 1, up, None, 0), s(10));
        // A won claim re-polls at once with either gateway.
        assert_eq!(inbox_next_wait(InboxPoll::RanItem, asked, Some(0.0), 1, up, Some(s(0)), 0), Duration::ZERO);
        assert_eq!(inbox_next_wait(InboxPoll::RanItem, asked, None, 1, up, Some(s(0)), 0), Duration::ZERO);
        // The gateway down: the down-streak back-off, unchanged.
        assert_eq!(inbox_next_wait(InboxPoll::GatewayDown, asked, None, 0, up, None, 1), s(5));
        assert_eq!(inbox_next_wait(InboxPoll::GatewayDown, asked, None, 0, up, None, 4), s(15));
    }

    /// Review (D1): a current gateway reports `waited: 0.0` for a `wait=0` list call too, so
    /// `waited` alone made a call that never long-polled re-list after only the 1 s floor
    /// (a ~1 s hot loop instead of the 3 s / 10 s cadence). Only a call that asked to wait counts.
    #[test]
    fn an_empty_answer_to_a_list_that_asked_no_wait_keeps_the_cadence() {
        let s = Duration::from_secs;
        let quiet = InboxPoll::NothingRan;
        let up = s(3_600);
        let no_wait = Duration::ZERO;
        assert_eq!(inbox_next_wait(quiet, no_wait, Some(0.0), 0, up, None, 0), s(10), "idle");
        assert_eq!(inbox_next_wait(quiet, no_wait, Some(0.0), 0, up, Some(s(0)), 0), s(3), "phone in use");
        assert_eq!(inbox_next_wait(quiet, no_wait, Some(0.0), 0, s(0), None, 0), s(3), "at launch");
        assert_eq!(inbox_next_wait(quiet, no_wait, Some(20.0), 0, up, None, 0), s(10), "whatever it reports");
        // The same answers to the long-poll call the loop actually makes re-list at once.
        assert_eq!(inbox_next_wait(quiet, INBOX_LIST_WAIT, Some(20.0), 0, up, None, 0), Duration::ZERO);
        assert_eq!(inbox_next_wait(quiet, INBOX_LIST_WAIT, Some(0.0), 0, up, None, 0), s(1));
        // Everything else is unchanged by what was asked.
        assert_eq!(inbox_next_wait(InboxPoll::RanItem, no_wait, Some(0.0), 1, up, None, 0), Duration::ZERO);
        assert_eq!(inbox_next_wait(InboxPoll::GatewayDown, no_wait, None, 0, up, None, 1), s(5));
        // The wait the loop passes is the one its list call asks for.
        assert!(!INBOX_LIST_WAIT.is_zero());
        assert_eq!(INBOX_LIST_PATH, format!("/api/os/inbox?wait={}", INBOX_LIST_WAIT.as_secs()));
    }

    /// Review (claim renewal): what a renewal came to. Only a 404 / 409, or a claim handed back
    /// under another token, ends the renewals; anything that can clear is tried again.
    #[test]
    fn claim_renewals_stop_on_404_409_or_a_lost_claim() {
        let ok = |t: &str| Ok(json!({ "id": "q-1", "status": "running", "claim_token": t }));
        assert_eq!(ClaimRenewal::of(&ok("tok"), "tok"), ClaimRenewal::Renewed);
        assert_eq!(ClaimRenewal::of(&Ok(json!({ "ok": true })), "tok"), ClaimRenewal::Renewed, "no token in the answer");
        assert_eq!(ClaimRenewal::of(&ok("other"), "tok"), ClaimRenewal::Stop, "this run's claim was lost");
        assert_eq!(ClaimRenewal::of(&Err("gateway 409: not claimable (status cancelled)".into()), "tok"), ClaimRenewal::Stop);
        assert_eq!(ClaimRenewal::of(&Err("gateway 409: claimed by someone else".into()), "tok"), ClaimRenewal::Stop);
        assert_eq!(ClaimRenewal::of(&Err("gateway 404: Not found".into()), "tok"), ClaimRenewal::Stop);
        for e in ["unreachable", "timed out", "gateway 500: error", "gateway 502: error", "gateway 401: unauthorized", "gateway 400: lease_secs must be 1..900", "error decoding response body"] {
            assert_eq!(ClaimRenewal::of(&Err(e.into()), "tok"), ClaimRenewal::Retry, "{e}");
        }
    }

    /// Review (claim renewal): a running item's claim is renewed 30 s after the claim and every
    /// 30 s after each renewal began, whatever a renewal came to, until one says Stop. The gap
    /// between two renewals that land stays inside every lease and inside the gateway's 90 s
    /// "desktop still running it" window.
    #[test]
    fn a_running_items_claim_is_renewed_every_30_s() {
        let s = Duration::from_secs;
        let t0 = Instant::now();
        let mut r = ClaimRenewer::new(t0, CLAIM_RENEW_EVERY);
        assert_eq!(CLAIM_RENEW_EVERY, s(30));
        assert_eq!(r.due(), Some(t0 + s(30)), "first renewal 30 s after the claim");
        r.renewed(ClaimRenewal::Renewed, t0 + s(30));
        assert_eq!(r.due(), Some(t0 + s(60)));
        // A failed renewal (gateway down, timeout) keeps the schedule.
        r.renewed(ClaimRenewal::Retry, t0 + s(60));
        assert_eq!(r.due(), Some(t0 + s(90)));
        // Counted from when it began: a slow call never stretches the gap.
        r.renewed(ClaimRenewal::Renewed, t0 + s(91));
        assert_eq!(r.due(), Some(t0 + s(121)));
        r.renewed(ClaimRenewal::Stop, t0 + s(121));
        assert_eq!(r.due(), None, "404 / 409: no more renewals");
        r.renewed(ClaimRenewal::Renewed, t0 + s(151));
        assert_eq!(r.due(), None, "stopped for good");
        // Worst case between two renewals reaching the gateway: one sent at once, the next a full
        // gateway timeout late.
        let gap = CLAIM_RENEW_EVERY + GW_TIMEOUT;
        assert!(gap < s(90), "os_api DESKTOP_RUN_SEEN_SECS");
        for kind in [None, Some("task"), Some("pipeline"), Some("turn"), Some("command"), Some("playplace")] {
            assert!(gap < s(claim_lease(kind)), "{kind:?}");
        }
    }

    /// Review (claim renewal): `renewing_claim` renews while the run is pending, returns the run's
    /// own output, stops renewing on Stop, and never lets a renewal hold up or fail the run.
    #[test]
    fn a_claim_is_renewed_while_its_item_runs_and_never_holds_it_up() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let ms = Duration::from_millis;
        tauri::async_runtime::block_on(async {
            // A 330 ms run, renewed every 60 ms: about five renewals, then its own output.
            let n = AtomicU32::new(0);
            let out = renewing_claim(
                async {
                    tokio::time::sleep(ms(330)).await;
                    Ok::<_, String>(json!({ "answer": "hi" }))
                },
                ms(60),
                || async {
                    n.fetch_add(1, Ordering::SeqCst);
                    ClaimRenewal::Renewed
                },
            )
            .await;
            assert_eq!(out, Ok(json!({ "answer": "hi" })));
            let renewals = n.load(Ordering::SeqCst);
            assert!((4..=5).contains(&renewals), "{renewals} renewals in 330 ms");
            // A failing gateway (Retry) keeps renewing; the run's error passes through as is.
            let n = AtomicU32::new(0);
            let out = renewing_claim(
                async {
                    tokio::time::sleep(ms(200)).await;
                    Err::<Value, _>("model offline".to_string())
                },
                ms(60),
                || async {
                    n.fetch_add(1, Ordering::SeqCst);
                    ClaimRenewal::Retry
                },
            )
            .await;
            assert_eq!(out, Err("model offline".into()));
            assert!(n.load(Ordering::SeqCst) >= 2, "retried");
            // Stop (404 / 409): one renewal, and the run still finishes.
            let n = AtomicU32::new(0);
            let out = renewing_claim(
                async {
                    tokio::time::sleep(ms(300)).await;
                    7
                },
                ms(50),
                || async {
                    n.fetch_add(1, Ordering::SeqCst);
                    ClaimRenewal::Stop
                },
            )
            .await;
            assert_eq!(out, 7);
            assert_eq!(n.load(Ordering::SeqCst), 1, "no renewal after a Stop");
            // A run that finishes at once is never renewed.
            let n = AtomicU32::new(0);
            let out = renewing_claim(async { 1 }, ms(50), || async {
                n.fetch_add(1, Ordering::SeqCst);
                ClaimRenewal::Renewed
            })
            .await;
            assert_eq!((out, n.load(Ordering::SeqCst)), (1, 0));
            // A renewal that hangs (a hung gateway) never holds up the run's end.
            let begun = Instant::now();
            let out = renewing_claim(
                async {
                    tokio::time::sleep(ms(150)).await;
                    "done"
                },
                ms(30),
                || std::future::pending::<ClaimRenewal>(),
            )
            .await;
            assert_eq!(out, "done");
            assert!(begun.elapsed() < ms(1_000), "{:?}", begun.elapsed());
        });
    }

    /// Review (claim renewal): the renewal reaches the gateway as a claim under this desktop's
    /// token, with the kind's lease (300 s for a Tony turn).
    #[test]
    fn claim_renewals_reach_the_gateway_in_the_agreed_shape() {
        use super::super::allm::mock::{start, Resp};
        tauri::async_runtime::block_on(async {
            let srv = start(|r| {
                if r.path.contains("/q-gone/") {
                    Resp::status(409, json!({ "detail": "not claimable (status cancelled)" }))
                } else {
                    Resp::json(json!({ "id": "q-1", "status": "running", "claim_token": r.body["claim_token"] }))
                }
            })
            .await;
            let st = DispatchState::default();
            st.update(|c| {
                c.gateway.url = srv.base.clone();
                Ok(())
            })
            .unwrap();
            let cfg = OsState::default().snapshot();
            let r = post_claim_renewal(&st, &cfg, "q-1", Some("turn"), "tok").await;
            assert_eq!(ClaimRenewal::of(&r, "tok"), ClaimRenewal::Renewed);
            let gone = post_claim_renewal(&st, &cfg, "q-gone", Some("turn"), "tok").await;
            assert_eq!(ClaimRenewal::of(&gone, "tok"), ClaimRenewal::Stop);
            let req = &srv.reqs()[0];
            assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/api/os/inbox/q-1/claim"));
            assert_eq!(req.body, json!({ "claim_token": "tok", "lease_secs": 300 }));
        });
    }

    /// D1: the list call asks the gateway to wait 20 s, with a client timeout that outlives it,
    /// and the loop keeps reporting to the loop registry (overdue after 3 × 3 s + 10 s) meanwhile.
    #[test]
    fn the_list_call_long_polls_inside_its_client_timeout() {
        assert_eq!(INBOX_LIST_PATH, "/api/os/inbox?wait=20");
        assert!(INBOX_LIST_TIMEOUT >= Duration::from_secs(25) && INBOX_LIST_TIMEOUT > GW_TIMEOUT);
        assert!(INBOX_BEAT < Duration::from_secs(3 * 3 + 10));
        tauri::async_runtime::block_on(async {
            let mut beats = 0;
            let out = beating(
                async {
                    tokio::time::sleep(Duration::from_millis(280)).await;
                    7
                },
                Duration::from_millis(60),
                || beats += 1,
            )
            .await;
            assert_eq!(out, 7);
            assert!((3..=5).contains(&beats), "{beats} beats in 280 ms");
            let mut none = 0;
            assert_eq!(beating(async { 1 }, Duration::from_millis(60), || none += 1).await, 1);
            assert_eq!(none, 0, "a call that answers at once never beats");
        });
    }

    /// D1: the long-poll call carries its own timeout (`gw_t`), not `gw`'s fixed 20 s, which a
    /// 20 s gateway wait would always hit.
    #[test]
    fn gateway_calls_honour_their_own_timeout() {
        use super::super::allm::mock::{start, Resp};
        tauri::async_runtime::block_on(async {
            let srv = start(|_| Resp::json(json!({ "items": [], "waited": 0.3 })).delayed(300)).await;
            let st = DispatchState::default();
            st.update(|c| {
                c.gateway.url = srv.base.clone();
                Ok(())
            })
            .unwrap();
            let cfg = OsState::default().snapshot();
            let e = gw_t(&st, &cfg, reqwest::Method::GET, INBOX_LIST_PATH, None, Duration::from_millis(100)).await.unwrap_err();
            assert_eq!(e, "timed out");
            let v = gw_t(&st, &cfg, reqwest::Method::GET, INBOX_LIST_PATH, None, Duration::from_secs(5)).await.unwrap();
            assert_eq!(v["waited"], json!(0.3));
            assert!(srv.reqs().iter().all(|r| r.method == "GET" && r.path == "/api/os/inbox?wait=20"));
        });
    }

    /// D2: what reaches the phone is what the desktop shows for the same stream: a dispatch
    /// packet's spoken_reply (decoded as far as it has arrived), never the JSON or a `[[LEARN]]`
    /// tag, and it only ever grows.
    #[test]
    fn the_streamed_text_is_the_visible_answer() {
        assert_eq!(visible_answer("  Hi Nic. All good."), "Hi Nic. All good.");
        assert_eq!(visible_answer("Got it.\n[[LEARN rule | always | short answers | confirmed]]\nAnything else?"), "Got it.\n\nAnything else?");
        for partial in ["Got it.\n[", "Got it.\n[[", "Got it.\n[[LEA", "Got it.\n[[ learn rule | always"] {
            assert_eq!(visible_answer(partial), "Got it.\n", "{partial:?}");
        }
        assert_eq!(visible_answer("See [[notes]] here"), "See [[notes]] here");
        assert_eq!(visible_answer("a [[x"), "a [[x");
        // Packets.
        assert_eq!(visible_answer(r#"{"spoken_reply": "On it — \"two\" tasks.\nDone", "tasks": []}"#), "On it \u{2014} \"two\" tasks.\nDone");
        assert_eq!(visible_answer(r#"{"spoken_"#), "");
        assert_eq!(visible_answer(r#"{"spoken_reply": "On it \"#), "On it ");
        assert_eq!(visible_answer(r#"{"spoken_reply": "On it \u20"#), "On it ");
        assert_eq!(visible_answer("```json\n{\"spoken_reply\": \"  Hi"), "Hi");
        for opening in ["`", "``", "```", "```js", "{", "  {\"tasks\": []"] {
            assert_eq!(visible_answer(opening), "", "{opening:?}");
        }
        assert_eq!(visible_answer("```python\nprint(1)"), "```python\nprint(1)", "a code block is prose");
        // Every prefix extends the one before (an emoji's surrogate pair is held back until whole).
        let packet = r#"{"spoken_reply": "ok 😀! Tab\there.", "tasks": [{"task_id": "t1"}]}"#;
        let prose = "Sure.\n[[LEARN rule | always | be brief]]\n\n\nNext: the plan… done. [x] ok";
        for (text, end) in [(packet, "ok \u{1F600}! Tab\there."), (prose, "Sure.\n\nNext: the plan… done. [x] ok")] {
            let mut last = String::new();
            for i in (1..=text.len()).filter(|i| text.is_char_boundary(*i)) {
                let v = visible_answer(&text[..i]);
                assert!(v.starts_with(&last), "{:?} → {v:?} after {last:?}", &text[..i]);
                last = v;
            }
            assert_eq!(last, end);
        }
    }

    /// D2: text is posted at a sentence end, or once it has waited ~400 ms; one post at a time,
    /// seq 1, 2, 3… advancing only on an accepted post.
    #[test]
    fn deltas_post_at_sentence_ends_or_after_400_ms() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut d = DeltaStream::default();
        assert_eq!((d.due(t0), d.deadline()), (None, None), "nothing streamed yet");
        d.feed("Hello", t0);
        assert_eq!(d.due(t0 + ms(399)), None, "no sentence end yet");
        assert_eq!(d.deadline(), Some(t0 + ms(400)));
        d.feed(" Nic", t0 + ms(100));
        assert_eq!(d.due(t0 + ms(400)), Some((1, "Hello Nic".into())), "never older than ~400 ms");
        d.feed(". How", t0 + ms(410));
        assert_eq!(d.due(t0 + ms(410)), None, "seq 1 is still on the wire");
        assert_eq!(d.deadline(), None);
        d.posted(DeltaPost::Accepted, t0 + ms(420));
        assert_eq!(d.deadline(), Some(t0 + ms(410)), "a sentence end is due at once");
        assert_eq!(d.due(t0 + ms(420)), Some((2, ". How".into())));
        d.posted(DeltaPost::Accepted, t0 + ms(430));
        d.feed(" are you?", t0 + ms(440));
        assert_eq!(d.due(t0 + ms(440)), Some((3, " are you?".into())));
        d.posted(DeltaPost::Accepted, t0 + ms(450));
        assert_eq!(d.due(t0 + ms(9_000)), None);
        assert!(!d.stopped);
        assert!(has_sentence_end("ok.") && has_sentence_end("line\n") && has_sentence_end("真的。") && has_sentence_end("wait…"));
        assert!(!has_sentence_end("no end yet,"));
    }

    /// D2: a post that may or may not have landed (timeout, 5xx) is repeated with the SAME seq
    /// and text, never merged with newer text (a repeat of a stored seq is the gateway's no-op);
    /// three failures in a row give the stream up.
    #[test]
    fn a_failed_delta_is_retried_with_the_same_seq_and_text() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut d = DeltaStream::default();
        d.feed("One.", t0);
        assert_eq!(d.due(t0), Some((1, "One.".into())));
        d.posted(DeltaPost::Retry, t0 + ms(10));
        d.feed(" Two.", t0 + ms(20));
        assert_eq!(d.due(t0 + ms(20)), None, "the retry waits out its gap");
        assert_eq!(d.deadline(), Some(t0 + ms(10) + DELTA_RETRY_GAP));
        let at = t0 + ms(10) + DELTA_RETRY_GAP;
        assert_eq!(d.due(at), Some((1, "One.".into())));
        assert_eq!(d.due(at), None, "on the wire again");
        d.posted(DeltaPost::Accepted, at);
        assert_eq!(d.due(at), Some((2, " Two.".into())), "newer text goes in the next seq");
        let mut t = at;
        for n in 1..=DELTA_MAX_FAILURES {
            d.posted(DeltaPost::Retry, t);
            t += DELTA_RETRY_GAP;
            if n < DELTA_MAX_FAILURES {
                assert_eq!(d.due(t), Some((2, " Two.".into())), "attempt {}", n + 1);
            }
        }
        assert!(d.stopped, "given up after {DELTA_MAX_FAILURES} failures");
        d.feed(" Three.", t);
        assert_eq!((d.due(t + ms(5_000)), d.deadline()), (None, None));
    }

    /// D2: a 404 (old gateway, unknown item) or 409 (finished, cancelled, superseded, a seq gap)
    /// stops the item's stream for good.
    #[test]
    fn a_refused_delta_stops_the_stream() {
        let t0 = Instant::now();
        for e in ["gateway 409: not running", "gateway 409: seq gap", "gateway 404: Not Found"] {
            let mut d = DeltaStream::default();
            d.feed("Hi.", t0);
            assert!(d.due(t0).is_some());
            d.posted(DeltaPost::of(&Err(e.into())), t0);
            assert!(d.stopped, "{e}");
            d.feed(" More.", t0);
            assert_eq!(d.due(t0 + Duration::from_secs(1)), None, "{e}");
        }
        assert_eq!(DeltaPost::of(&Ok(json!({ "ok": true }))), DeltaPost::Accepted);
        for e in ["timed out", "unreachable", "gateway 500: error", "gateway 401: unauthorized", "gateway 422: bad body"] {
            assert_eq!(DeltaPost::of(&Err(e.into())), DeltaPost::Retry, "{e}");
        }
    }

    /// D2: a dispatch packet streams as JSON, but only its spoken_reply is posted; and should the
    /// visible text ever stop extending what was sent, the stream stops (the result is whole).
    #[test]
    fn deltas_carry_only_visible_text() {
        let t0 = Instant::now();
        let mut d = DeltaStream::default();
        for piece in ["{\"spoken", "_reply\": \"On it", ".\", \"tasks\": [{\"task_id\": \"t1\"}]}"] {
            d.feed(piece, t0);
        }
        assert_eq!(d.due(t0), Some((1, "On it.".into())));
        d.posted(DeltaPost::Accepted, t0);
        assert_eq!(d.due(t0 + Duration::from_secs(1)), None, "the rest of the packet is never sent");
        let mut d = DeltaStream::default();
        d.feed("Noted.\n[[LEARN rule | always | brief]]", t0);
        assert_eq!(d.due(t0), Some((1, "Noted.\n".into())));
        let mut d = DeltaStream { shown: "Hello there".into(), ..Default::default() };
        d.feed("Hello world", t0);
        assert!(d.stopped, "diverged from what was sent");
    }

    /// D2 end to end on the pump: contiguous seqs, a 400 ms flush without a sentence end, an
    /// immediate post at one, and the stream closes with the turn (unposted text is dropped:
    /// the result carries it).
    #[test]
    fn the_pump_posts_the_stream_until_the_turn_ends() {
        tauri::async_runtime::block_on(async {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let posts: Arc<Mutex<Vec<(u64, String)>>> = Arc::default();
            let p2 = posts.clone();
            let pump = tauri::async_runtime::spawn(pump_deltas(rx, move |seq, text| {
                p2.lock().unwrap().push((seq, text));
                async { Ok::<Value, String>(json!({ "ok": true })) }
            }));
            let count = |p: &Arc<Mutex<Vec<(u64, String)>>>| p.lock().unwrap().len();
            tx.send("Hello".into()).unwrap();
            tokio::time::sleep(Duration::from_millis(250)).await;
            assert_eq!(count(&posts), 0, "held: no sentence end, under 400 ms");
            tokio::time::sleep(Duration::from_millis(400)).await;
            assert_eq!(posts.lock().unwrap().clone(), vec![(1, "Hello".to_string())], "flushed after ~400 ms");
            let t = Instant::now();
            tx.send(" Nic. How".into()).unwrap();
            while count(&posts) < 2 && t.elapsed() < Duration::from_secs(2) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(t.elapsed() < Duration::from_millis(350), "a sentence end posts at once ({:?})", t.elapsed());
            tx.send(" are".into()).unwrap();
            drop(tx);
            tokio::time::timeout(Duration::from_secs(2), pump).await.expect("the pump ends with the turn").unwrap();
            assert_eq!(posts.lock().unwrap().clone(), vec![(1, "Hello".to_string()), (2, " Nic. How".to_string())]);
        });
    }

    /// D2: on 409 the pump stops posting (and ends) although the turn goes on; a retry repeats
    /// the same seq and text.
    #[test]
    fn the_pump_stops_on_409_and_retries_the_same_seq() {
        tauri::async_runtime::block_on(async {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let posts: Arc<Mutex<Vec<(u64, String)>>> = Arc::default();
            let p2 = posts.clone();
            let pump = tauri::async_runtime::spawn(pump_deltas(rx, move |seq, text| {
                let n = {
                    let mut g = p2.lock().unwrap();
                    g.push((seq, text));
                    g.len()
                };
                async move {
                    match n {
                        1 => Err("timed out".to_string()),
                        2 => Ok(json!({ "ok": true })),
                        _ => Err("gateway 409: not running".to_string()),
                    }
                }
            }));
            tx.send("One.".into()).unwrap();
            tokio::time::sleep(DELTA_RETRY_GAP + Duration::from_millis(150)).await;
            tx.send(" Two.".into()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), pump).await.expect("a 409 ends the pump").unwrap();
            assert!(tx.send(" Three.".into()).is_err(), "nothing listens any more");
            assert_eq!(posts.lock().unwrap().clone(), vec![(1, "One.".to_string()), (1, "One.".to_string()), (2, " Two.".to_string())]);
        });
    }

    /// D2: the delta reaches the gateway in the agreed shape, and a 409 there stops the stream.
    #[test]
    fn deltas_reach_the_gateway_in_the_agreed_shape() {
        use super::super::allm::mock::{start, Resp};
        tauri::async_runtime::block_on(async {
            let srv = start(|r| if r.body["seq"] == json!(2) { Resp::status(409, json!({ "detail": "not running" })) } else { Resp::json(json!({ "ok": true, "partialSeq": 1 })) }).await;
            let st = DispatchState::default();
            st.update(|c| {
                c.gateway.url = srv.base.clone();
                Ok(())
            })
            .unwrap();
            let cfg = OsState::default().snapshot();
            assert_eq!(DeltaPost::of(&post_delta(&st, &cfg, "q-1", "tok", 1, "Hi.").await), DeltaPost::Accepted);
            let refused = post_delta(&st, &cfg, "q-1", "tok", 2, " More.").await;
            assert_eq!(refused.as_ref().unwrap_err(), "gateway 409: not running");
            assert_eq!(DeltaPost::of(&refused), DeltaPost::Stop);
            let r = &srv.reqs()[0];
            assert_eq!((r.method.as_str(), r.path.as_str()), ("POST", "/api/os/inbox/q-1/delta"));
            assert_eq!(r.body, json!({ "claim_token": "tok", "seq": 1, "text": "Hi." }));
        });
    }

    #[test]
    fn inbox_polls_again_at_once_after_running_an_item() {
        let s = Duration::from_secs;
        // A turn the phone queued while the last one ran is claimed without a sleep. (The loop
        // only ever reports RanItem after the gateway answered: a dropped gateway is
        // GatewayDown on the next list call, which backs off 5 s, then 15 s.)
        // The loop stamps `last_item` just before, so `since_item` is always ~0 with RanItem.
        assert_eq!(inbox_wait(InboxPoll::RanItem, s(0), Some(s(0)), 0), Duration::ZERO);
    }

    #[test]
    fn only_a_won_claim_earns_an_immediate_re_poll() {
        use InboxClaim::*;
        assert_eq!(inbox_round(&[]), InboxPoll::NothingRan, "empty inbox");
        assert_eq!(inbox_round(&[BadId]), InboxPoll::NothingRan, "a malformed id stays listed: no hot loop");
        assert_eq!(inbox_round(&[Refused]), InboxPoll::NothingRan, "409: someone else won the claim");
        assert_eq!(inbox_round(&[BadId, Refused, Refused]), InboxPoll::NothingRan);
        assert_eq!(inbox_round(&[Won]), InboxPoll::RanItem);
        assert_eq!(inbox_round(&[Refused, BadId, Won]), InboxPoll::RanItem);
        // Re-posting a stored result runs nothing: no immediate re-poll.
        assert_eq!(inbox_round(&[Reposted]), InboxPoll::NothingRan);
        assert_eq!(inbox_round(&[Reposted, Won]), InboxPoll::RanItem);
        // So a round of only refused / bad items sleeps (3 s in the active window), never zero.
        let s = Duration::from_secs;
        assert_eq!(inbox_wait(inbox_round(&[Refused, BadId]), s(3_600), Some(s(0)), 0), s(3));
        assert_eq!(inbox_wait(inbox_round(&[Won]), s(3_600), Some(s(0)), 0), Duration::ZERO);
    }

    #[test]
    fn claim_results_map_to_won_or_refused() {
        assert_eq!(InboxClaim::of(&Ok(json!({ "claim_token": "t", "status": "running" }))), InboxClaim::Won);
        assert_eq!(InboxClaim::of(&Err("gateway 409: claimed by someone else".into())), InboxClaim::Refused);
        assert_eq!(InboxClaim::of(&Err("gateway 409: not claimable (status done)".into())), InboxClaim::Refused);
        assert_eq!(InboxClaim::of(&Err("gateway 401: unauthorized".into())), InboxClaim::Refused);
        assert_eq!(InboxClaim::of(&Err("error sending request".into())), InboxClaim::Refused);
    }

    #[test]
    fn inbox_item_ids_must_be_url_safe() {
        assert_eq!(inbox_item_id(&json!({ "id": "a1B2-c3" })).as_deref(), Some("a1B2-c3"));
        for bad in [json!({}), json!({ "id": "" }), json!({ "id": 42 }), json!({ "id": "../x" }), json!({ "id": "a/b" }), json!({ "id": "a?b=c" }), json!({ "id": "a b" })] {
            assert_eq!(inbox_item_id(&bad), None, "{bad}");
        }
    }

    #[test]
    fn html_extracted() {
        let t = "Here you go:\n```html\n<!doctype html><html><body><h1>Hi there friend</h1></body></html>\n```\nDone.";
        assert!(extract_html(t).unwrap().starts_with("<!doctype html>"));
        assert!(extract_html("no code").is_none());
    }

    #[test]
    fn ideas_detected() {
        assert!(looks_like_idea("I've been thinking about building a tool that tracks auditions"));
        assert!(looks_like_idea("I have an idea for an app"));
        assert!(!looks_like_idea("what's the weather"));
    }

    #[test]
    fn inbox_turn_routes() {
        let idea = "I've been thinking about building a tool that tracks auditions";
        // Tier 2 from a current phone: never the Prompter, even when it's idea-shaped.
        assert_eq!(inbox_turn_route(&json!({ "text": idea, "noDelegate": true })), InboxTurnRoute::OsTurn);
        assert_eq!(inbox_turn_route(&json!({ "text": idea, "noDelegate": true, "capture": true })), InboxTurnRoute::OsTurn);
        // A current client that isn't brainstorming: a normal turn, no idea shortcut.
        assert_eq!(inbox_turn_route(&json!({ "text": idea, "noDelegate": false })), InboxTurnRoute::OsTurn);
        // An approved Tier-3 build "yes" from the phone.
        assert_eq!(inbox_turn_route(&json!({ "text": idea, "noDelegate": false, "capture": true })), InboxTurnRoute::Capture);
        // Stale phone builds: the idea is parked, never built without an approved yes.
        assert_eq!(inbox_turn_route(&json!({ "text": idea })), InboxTurnRoute::Park);
        assert_eq!(inbox_turn_route(&json!({ "text": "what's the weather" })), InboxTurnRoute::OsTurn);
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("Audition Tracker — v2!"), "audition-tracker-v2");
    }

    #[test]
    fn inbox_routes_task_kinds_to_the_store_only() {
        let a = inbox_action("q1", Some("task"), &json!({ "raw_intent": { "text": "a tip calculator" }, "title": "Tip calc", "thread": "general", "ideaId": "i9", "options": { "localOnly": true } }));
        assert_eq!(
            a,
            InboxAction::Task(CreateArgs { raw_intent: "a tip calculator".into(), title: Some("Tip calc".into()), thread: Some("general".into()), source: "phone".into(), idea_id: Some("i9".into()), options: Some(json!({ "localOnly": true })), dedupe_key: Some("q1".into()), project_slug: None })
        );
        assert_eq!(inbox_action("q2", Some("task"), &json!({ "raw_intent": "plain string" })), InboxAction::Task(CreateArgs { raw_intent: "plain string".into(), source: "phone".into(), dedupe_key: Some("q2".into()), ..Default::default() }));
        assert_eq!(inbox_action("q3", Some("pipeline"), &json!({ "ideaId": "abc" })), InboxAction::Pipeline("abc".into()));
        assert_eq!(inbox_action("q4", Some("turn"), &json!({ "text": "build it", "capture": true, "noDelegate": false })), InboxAction::Capture("build it".into()));
        assert_eq!(inbox_action("q5", Some("turn"), &json!({ "text": "I have an idea for an app" })), InboxAction::Park("I have an idea for an app".into()));
        assert_eq!(inbox_action("q6", Some("turn"), &json!({ "text": "hi", "noDelegate": true })), InboxAction::Turn);
        assert_eq!(inbox_action("q7", Some("playplace"), &json!({})), InboxAction::PlayPlace);
        assert_eq!(inbox_action("q8", Some("nope"), &json!({})), InboxAction::Unknown);
        assert_eq!(inbox_action("q9", Some("action"), &json!({ "tool": "calendar.create_event" })), InboxAction::Action);
        assert_eq!(claim_lease(Some("playplace")), 900);
        assert_eq!(claim_lease(Some("task")), 120);
    }

    /// The phone's approved card: only the two carded tools, with an approval stamp and an args
    /// object; anything else is refused before any tool runs.
    #[test]
    fn approved_actions_are_allowlisted_and_stamped() {
        let ok = approved_action(&json!({ "tool": "calendar.create_event", "args": { "title": "Shoot" }, "planId": "p1", "approvedAt": "2026-11-26T15:00:00Z" })).unwrap();
        assert_eq!(ok, ("calendar.create_event", json!({ "title": "Shoot" })));
        assert_eq!(approved_action(&json!({ "tool": "gmail.create_draft", "args": {}, "approvedAt": "x" })).unwrap().0, "gmail.create_draft");
        for bad in [
            json!({ "tool": "gmail.send", "args": {}, "approvedAt": "x" }),
            json!({ "tool": "whatsapp.send_message", "args": {}, "approvedAt": "x" }),
            json!({ "tool": "calendar.create_event", "args": {} }),
            json!({ "tool": "calendar.create_event", "args": {}, "approvedAt": " " }),
            json!({ "tool": "calendar.create_event", "args": "title", "approvedAt": "x" }),
        ] {
            assert!(approved_action(&bad).is_err(), "{bad}");
        }
    }

    /// The remote failsafe stops the phone's approved card too (the desktop card gets HARD_LOCKED
    /// from the IPC gate); an unlocked app lets it through to the approved-only path.
    #[test]
    fn a_hard_lock_refuses_the_phones_approved_action() {
        let e = approved_action_lock(true).unwrap_err();
        assert!(e.starts_with("HARD_LOCKED") && e.contains("nothing was done"), "{e}");
        assert!(approved_action_lock(false).is_ok());
        // The live check reads the same runtime flag the background workers honour.
        assert_eq!(approved_action_lock(crate::security::commands::hard_locked()).is_ok(), !crate::security::commands::hard_locked());
    }

    /// Review notes (A2): the phone's approved card is refused at every gate, for both tools,
    /// before any Apps Script call: HARD_LOCKED, no approval stamp, MCP Deny, the server switched
    /// off, a mode / master-switchboard freeze (the Gmail draft used to skip it), the kill switch.
    #[test]
    fn the_phones_approved_action_refuses_at_every_gate() {
        tauri::async_runtime::block_on(async {
            let (st, bridge) = (DispatchState::default(), BridgeState::default());
            let env = |f: &dyn Fn(&mut super::super::os_core::OsConfig)| {
                let os = OsState::default();
                os.update(|c| {
                    for m in c.mcps.iter_mut().filter(|m| m.id == "calendar" || m.id == "gmail") {
                        m.enabled = true;
                    }
                    c.privacy.kill_switch = false;
                    f(c);
                    Ok(())
                })
                .unwrap();
                os
            };
            let cal = json!({ "tool": "calendar.create_event", "args": { "title": "zqx shoot", "startTime": "2030-01-02T09:00" }, "planId": "p1", "approvedAt": "2026-11-26T15:00:00Z" });
            let draft = json!({ "tool": "gmail.create_draft", "args": { "to": "sam@agency.ca", "subject": "Hi", "body": "zqx" }, "planId": "p2", "approvedAt": "2026-11-26T15:00:00Z" });
            let run = |os: OsState, p: Value, locked: bool| {
                let (st, bridge) = (&st, &bridge);
                async move { run_approved_action_with(st, &os, bridge, &p, locked).await }
            };
            for p in [&cal, &draft] {
                let tool = p["tool"].as_str().unwrap();
                assert!(run(env(&|_| {}), p.clone(), true).await.unwrap_err().starts_with("HARD_LOCKED"), "{tool}");
                let mut unstamped = p.clone();
                unstamped.as_object_mut().unwrap().remove("approvedAt");
                assert_eq!(run(env(&|_| {}), unstamped, false).await.unwrap_err(), "the action wasn't approved on the card", "{tool}");
                let e = run(env(&|c| c.permissions.mcp = super::super::bridge::Tier::Deny), p.clone(), false).await.unwrap_err();
                assert!(e.starts_with("PERMISSION_DENIED:mcp"), "{tool}: {e}");
                let server = if tool == "gmail.create_draft" { "gmail" } else { "calendar" };
                let e = run(env(&|c| c.mcps.iter_mut().filter(|m| m.id == server).for_each(|m| m.enabled = false)), p.clone(), false).await.unwrap_err();
                assert!(e.contains("is switched off"), "{tool}: {e}");
                let e = run(env(&|c| c.switchboard.frozen_tools = vec![server.into()]), p.clone(), false).await.unwrap_err();
                assert_eq!(e, format!("MODE_FROZEN: {server} is frozen on the master switchboard"), "{tool}");
                let builder = env(&|_| {});
                builder.modes.set_active("builder").unwrap();
                // Gmail and Calendar are Tony's always-on base (section pass): Builder never freezes them.
                assert!(!run(builder, p.clone(), false).await.unwrap_err().starts_with("MODE_FROZEN"), "{tool}");
                let e = run(env(&|c| c.privacy.kill_switch = true), p.clone(), false).await.unwrap_err();
                assert!(e.starts_with("kill switch is on"), "{tool}: {e}");
            }
            // Only the two allowlisted tools ever run.
            let send = json!({ "tool": "gmail.send", "args": {}, "approvedAt": "x" });
            assert!(run(env(&|_| {}), send, false).await.unwrap_err().contains("can't be approved"));
        });
    }

    /// The inbox's task path is a synchronous insert: it returns with the task `queued` and
    /// never waits on a model; the same queue id twice is the same task.
    #[test]
    fn inbox_task_enqueues_without_running_it() {
        let store = TaskStore::in_memory();
        let InboxAction::Task(args) = inbox_action("q-123", Some("task"), &json!({ "raw_intent": "a tip calculator" })) else { panic!("task") };
        let t0 = Instant::now();
        let (e, created) = taskworker::create_task(&store, &args, 3, &[]).unwrap();
        assert!(created && e.status == "queued" && e.stage.is_none());
        assert!(t0.elapsed() < Duration::from_millis(500));
        let (again, created2) = taskworker::create_task(&store, &args, 3, &[]).unwrap();
        assert_eq!((again.task_id, created2), (e.task_id.clone(), false));
        assert_eq!(task_for_dedupe(&store, "q-123"), Some(e.task_id));
    }

    /// The switchboard: a build whose pipeline agent is frozen is queued (never dropped) and says so.
    #[test]
    fn a_build_queued_while_the_pipeline_is_frozen_says_when_it_starts() {
        assert_eq!(queued_reply("Tip calculator", None, false), "Queued \"Tip calculator\" for the Prompter. Ask me where the build's at anytime.");
        assert_eq!(queued_reply("Tip calculator", Some("Prompter is frozen in Operations mode"), false), "Queued \"Tip calculator\". Prompter is frozen in Operations mode, so it starts when you switch modes.");
        let operations = super::super::modes::effective(&super::super::modes::ModesFile { active_mode_id: "operations".into(), ..Default::default() }, &Default::default());
        assert_eq!(super::super::modes::pipeline_frozen(&operations, &Default::default()).as_deref(), Some("Prompter is frozen in Operations mode"));
        assert!(!super::super::modes::pipeline_frozen_on_master(&Default::default()), "the default master switchboard leaves the pipeline live");
    }

    /// A GLOBAL freeze (the master switchboard, every mode): switching modes won't start the
    /// build, so Tony says it starts once it's thawed there.
    #[test]
    fn a_build_held_by_the_master_switchboard_says_it_starts_once_thawed() {
        let eff = |id: &str| super::super::modes::effective(&super::super::modes::ModesFile { active_mode_id: id.into(), ..Default::default() }, &Default::default());
        let g = super::super::os_core::SwitchboardConfig { version: 1, frozen_agents: vec!["booking".into(), "coder".into()], frozen_tools: vec![] };
        let reply = |mode: &str| queued_reply("Tip calculator", super::super::modes::pipeline_frozen(&eff(mode), &g).as_deref(), super::super::modes::pipeline_frozen_on_master(&g));
        assert_eq!(reply("builder"), "Queued \"Tip calculator\". Coder is frozen on the master switchboard, so it starts once it's thawed on the switchboard.");
        // Operations also froze the Prompter for the mode, but the master freeze is what holds it.
        assert_eq!(reply("operations"), reply("builder"));
        assert!(!reply("brainstorm").contains("switch modes"));
    }

    /// Phase 2 Part C: the phone's builds go through Tony's mode.
    #[test]
    fn inbox_builds_follow_tonys_mode() {
        use super::super::modes::DispatchPolicy::*;
        let count = |store: &TaskStore| store.with(|c| super::super::envelope::list(c, None, 50, false)).unwrap().len();
        // Solo: an inbox `task` is refused with MODE_SURFACE_ONLY and creates zero envelopes.
        let store = TaskStore::in_memory();
        let InboxAction::Task(args) = inbox_action("q-solo", Some("task"), &json!({ "raw_intent": "a tip calculator" })) else { panic!("task") };
        let err = taskworker::create_task_gated(&store, &args, 3, &[], SurfaceOnly, false).unwrap_err();
        assert!(err.starts_with("MODE_SURFACE_ONLY"), "{err}");
        assert_eq!(count(&store), 0);
        // …and a phone Capture is parked in the Ideas Ledger instead of queued.
        let cap = inbox_action("q-cap", Some("turn"), &json!({ "text": "build it", "capture": true }));
        assert_eq!(mode_inbox_action(cap.clone(), SurfaceOnly), InboxAction::SoloPark("build it".into()));
        for p in [AskBeforeDispatch, AutoDispatch] {
            assert_eq!(mode_inbox_action(cap.clone(), p), InboxAction::Capture("build it".into()));
        }
        assert!(SOLO_PARK_REPLY.contains("Ideas Ledger") && SOLO_PARK_REPLY.starts_with("Solo mode is on"));
        // Other kinds pass through untouched.
        assert_eq!(mode_inbox_action(InboxAction::Turn, SurfaceOnly), InboxAction::Turn);
        // Ask: a plain approved task is queued; `auto` is refused (MODE_NOT_AUTO), zero envelopes.
        let err = taskworker::create_task_gated(&store, &args, 3, &[], AskBeforeDispatch, true).unwrap_err();
        assert!(err.starts_with("MODE_NOT_AUTO"), "{err}");
        assert_eq!(count(&store), 0);
        let (e, _) = taskworker::create_task_gated(&store, &args, 3, &[], AskBeforeDispatch, false).unwrap();
        assert!(e.options.get("autoDispatched").is_none());
        // Builder: `auto` is honoured and recorded.
        let store = TaskStore::in_memory();
        let (e, created) = taskworker::create_task_gated(&store, &args, 3, &[], AutoDispatch, true).unwrap();
        assert!(created);
        assert_eq!(e.options["autoDispatched"], json!(true));
    }

    #[test]
    fn inbox_command_switches_tonys_mode() {
        let os = OsState::default();
        let e = super::super::modes::apply_inbox_command(&os, &json!({ "modeId": "builder" })).unwrap().unwrap();
        assert_eq!(e.mode_id, "builder");
        assert_eq!(os.modes.effective().mode_id, "builder");
        assert_eq!(os.snapshot().feedback.sensitivity, 2);
        // Overrides and reset ride the same command.
        let e = super::super::modes::apply_inbox_command(&os, &json!({ "overrides": { "curiosity": "low" } })).unwrap().unwrap();
        assert_eq!(e.overridden, vec!["curiosity"]);
        let e = super::super::modes::apply_inbox_command(&os, &json!({ "resetOverrides": true })).unwrap().unwrap();
        assert!(e.overridden.is_empty());
        // No mode keys: nothing to do. The novelty overlay never becomes the work mode.
        assert!(super::super::modes::apply_inbox_command(&os, &json!({ "killSwitch": true })).unwrap().is_none());
        assert!(super::super::modes::apply_inbox_command(&os, &json!({ "modeId": "gabagool" })).is_err());
        assert_eq!(os.modes.effective().mode_id, "builder");
    }

    #[test]
    fn legacy_checkpoints_get_a_clear_error() {
        let e = resume_target(r"C:\ai-hub\memory\checkpoints\pipe-1700000000-3-build-failed.json").unwrap_err();
        assert!(e.contains("old pipeline") && e.contains("Ideas Ledger"), "{e}");
        assert!(resume_target("../../etc").is_err());
        assert_eq!(resume_target("t-1763500000000-ab12cd").unwrap(), "t-1763500000000-ab12cd");
    }

    #[test]
    fn commit_dir_is_a_safe_relative_path() {
        assert_eq!(commit_dir_rel("2026-11-19", "Audition Tracker — v2!"), "play-place/2026-11-19-audition-tracker-v2");
        assert_eq!(commit_dir_rel("2026-11-19", "!!!"), "play-place/2026-11-19-prototype");
        assert!(super::super::staging::check_rel(&commit_dir_rel("2026-11-19", "..\\..\\x")).is_ok());
    }

    /// Regression: two different cards with same-slug titles committed the same day shared one
    /// folder, so the second commit silently replaced the first card's spec / prototype / chain.
    #[test]
    fn a_second_card_never_overwrites_another_cards_vault_commit() {
        let root = std::env::temp_dir().join(format!("pp-commit-{}-{}", std::process::id(), super::super::envelope::now_ms()));
        let first = commit_dir_rel_with("2026-11-19", "Tip Calculator", |rel| commit_dir_taken(&root, rel, "card-a"));
        std::fs::create_dir_all(root.join(&first)).unwrap();
        std::fs::write(root.join(&first).join(COMMIT_CARD_FILE), "card-a").unwrap();
        // The same card re-committing reuses its folder…
        assert_eq!(commit_dir_rel_with("2026-11-19", "Tip Calculator", |rel| commit_dir_taken(&root, rel, "card-a")), first);
        // …another card with a same-slug title gets its own.
        let second = commit_dir_rel_with("2026-11-19", "Tip calculator!", |rel| commit_dir_taken(&root, rel, "card-b"));
        assert_ne!(second, first);
        assert_eq!(second, "play-place/2026-11-19-tip-calculator-2");
        let _ = std::fs::remove_dir_all(&root);
    }
}
