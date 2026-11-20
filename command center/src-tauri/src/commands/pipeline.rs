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
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use super::agents::{workspace_chat_t, OsStep};
use super::bridge::BridgeState;
use super::dispatch::{extract_json, run_chat, short, ChatMessage, DispatchState, Priority};
use super::envelope::{clip, one_line, TaskStore};
use super::os_core::{self, OsConfig, OsState};
use super::taskworker::{self, CreateArgs};

// ── Gateway client (loopback; carries the mesh token when the lock is on) ──

pub(crate) async fn gw(state: &DispatchState, os: &OsConfig, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let base = state.snapshot().gateway.url;
    let mut rb = state.http.request(method, format!("{}{path}", base.trim_end_matches('/'))).timeout(Duration::from_secs(20));
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
    Ok(IdeaResult { idea, reply: format!("Queued \"{}\" for the Prompter. Ask me where the build's at anytime.", e.title), steps: vec![], task_id: e.task_id })
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
pub async fn comms_search(state: &DispatchState, cfg: &OsConfig, who: &str, topic: &str) -> Result<(String, Option<String>), String> {
    let q = format!("/api/comms/search?contact={}&q={}&limit=10", urlenc(who), urlenc(topic));
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

/// Send a WhatsApp message. Requires `approved` (the confirmation card), unless
/// the contact is marked trusted in Comms (Instant Send).
#[tauri::command]
pub async fn comms_whatsapp_send(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, recipient: String, message: String, approved: Option<bool>) -> Result<String, String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err("kill switch is on — WhatsApp is outbound traffic".into());
    }
    let trusted = gw(&state, &cfg, reqwest::Method::GET, &format!("/api/comms/contacts?q={}", urlenc(&recipient)), None)
        .await
        .ok()
        .and_then(|v| v["contacts"].as_array().cloned())
        .is_some_and(|c| c.iter().any(|x| x["trusted"].as_i64() == Some(1)));
    if !approved.unwrap_or(false) && !trusted {
        return Err("PERMISSION_REQUIRED:send".into());
    }
    let out = super::mcp::call_tool(&state, &os, &bridge, "whatsapp.send_message", &json!({ "recipient": recipient, "message": message }), true, "tony").await?;
    bridge.log(json!({ "type": "comms-send", "channel": "whatsapp", "trusted": trusted, "chars": message.len() }));
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
/// under the claim lease.
async fn run_inbox_item(app: &AppHandle, id: &str, kind: Option<&str>, p: &Value) -> Result<Value, String> {
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
                Ok(out)
            })
        }
        InboxAction::Turn => {
            let bridge = app.state::<BridgeState>();
            let req: Result<super::agents::OsTurnRequest, _> = serde_json::from_value(p.clone());
            match req {
                Ok(r) => super::agents::run_os_turn(&st, &os, &bridge, r, Some(app)).await.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
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
        InboxAction::Unknown => Err("unknown queue item".into()),
    }
}

/// Every 3 s: claim and run what the phone HUD queued on the gateway (Tony turns, builds,
/// Play Place actions, lockdown commands). An item someone else holds (409) is skipped.
pub async fn inbox_loop(app: AppHandle) {
    loop {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(3))).await.ok();
        let st = app.state::<DispatchState>();
        let os = app.state::<OsState>();
        let cfg = os.snapshot();
        let v = match gw(&st, &cfg, reqwest::Method::GET, "/api/os/inbox", None).await {
            Ok(v) => {
                let n = v["items"].as_array().map_or(0, |a| a.len());
                super::introspect::loop_ran("inbox", true, &format!("{n} queued item(s)"));
                v
            }
            Err(e) => {
                super::introspect::loop_ran("inbox", false, &e);
                continue;
            }
        };
        for item in v["items"].as_array().cloned().unwrap_or_default() {
            let id = item["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                continue;
            }
            let kind = item["kind"].as_str();
            // Claim first: nothing runs twice, and a crash leaves it re-claimable after the lease.
            let claim = match gw(&st, &cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/claim"), Some(json!({ "lease_secs": claim_lease(kind) }))).await {
                Ok(c) => c,
                Err(e) => {
                    if !e.contains("409") {
                        eprintln!("[inbox] claim {id}: {e}");
                    }
                    continue;
                }
            };
            let result = run_inbox_item(&app, &id, kind, &item["payload"]).await;
            let mut body = match result {
                Ok(v) => json!({ "ok": true, "result": v }),
                Err(e) => json!({ "ok": false, "error": e }),
            };
            if let Some(t) = claim["claim_token"].as_str() {
                body["claim_token"] = json!(t);
            }
            let _ = gw(&st, &cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/result"), Some(body)).await;
        }
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
        assert_eq!(claim_lease(Some("playplace")), 900);
        assert_eq!(claim_lease(Some("task")), 120);
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
