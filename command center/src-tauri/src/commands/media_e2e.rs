//! Live end-to-end run of Director Suite Part 1 (docs/proposals/director-suite-v2-plan.md §1
//! test gate), against REAL components and nothing mocked:
//!   * media.rs (project, watched-inbox intake, manifest saves, plans, verify, review, finals),
//!   * media-forge from this worktree over stdio MCP (CPU faster-whisper tiny.en, CPU libx264),
//!   * the already-loaded Qwen on LM Studio / Bionic for every Director turn
//!     (system prompt from director.rs `director_messages` + `tony_system`),
//!   * the page's own TS modules (context, action parser, manifest ops) through the opt-in vitest
//!     step runner `src/features/director/e2e/director-live.e2e.ts`.
//!
//! `#[ignore]`d and gated on `E2E_LIVE=1`, so `cargo test` never runs it:
//!   $env:E2E_LIVE="1"; cargo test --lib e2e_live_demo_reel -- --ignored --nocapture
//!
//! It never modifies the source clip (it copies it), never deletes a project, never loads or
//! unloads a model and never sets MEDIA_ALLOW_GPU. Its media.db is a fresh scratch file (so the
//! intake tick only ever sees this project, and the app's own db is never migrated or touched);
//! the project itself lives in the real projects root. Everything it saw is written to the
//! project's working/e2e/report.json and report.md.

use super::*;
use crate::commands::director::{director_messages, DirectorTurnRequest, HistoryMsg};
use std::cell::{Cell, RefCell};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Instant;

const SOURCE: &str = r"C:\Users\nicho\Downloads\Nicholas_Rae_Demo_Reel.mp4";
const PY: &str = r"G:\agentic os\command center\mcp\media-forge\.venv\Scripts\python.exe";
const LM: &str = "http://127.0.0.1:1235";
const MODEL: &str = "qwen/qwen3.5-9b";
const TITLE: &str = "E2E Demo Reel";
const IDEA: &str = "Cut my demo reel into a 15-second Instagram Reel that gets me noticed by casting directors: open on my strongest moment, punchy, captions on.";
const NOTE: &str = "Tighten the middle and end on a stronger beat.";
const TURN_SECS: u64 = 120;
const PROMPT_CAP: usize = 24_000;
/** How many times Nic types the ask again when a step's card never lands (each re-ask may get the page's own auto-fix). */
const NIC_REASKS: u32 = 2;

fn cc_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().expect("command center").to_path_buf()
}
fn forge_dir() -> PathBuf {
    cc_root().join("mcp").join("media-forge")
}
fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

// ── media-forge over stdio MCP (a minimal JSON-RPC client) ─────────────────────

struct StdioForge {
    child: RefCell<Child>,
    stdin: RefCell<ChildStdin>,
    rx: mpsc::Receiver<String>,
    next: Cell<u64>,
    t0: Instant,
    /// One entry per tool call: tool, start (ms since the forge started), ms, job status/id.
    log: RefCell<Vec<Value>>,
}

impl StdioForge {
    fn start(stderr_log: &Path) -> Result<Self, String> {
        let dir = forge_dir();
        let err = std::fs::File::create(stderr_log).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(PY);
        // The env os_core.rs `media_mcp("media-forge", …)` gives it; MEDIA_ALLOW_GPU is never set.
        cmd.arg(dir.join("server.py"))
            .current_dir(&dir)
            .env("PYTHONPATH", &dir)
            .env("PYTHONIOENCODING", "utf-8")
            .env("MEDIA_ROOT", os_core::MEDIA_ROOT)
            .env("MEDIA_CPU_PCT", "70")
            .env("WHISPER_DEVICE", "cpu")
            .env("WHISPER_COMPUTE", "int8")
            .env_remove("MEDIA_ALLOW_GPU")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("start media-forge: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(l) = line else { break };
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        let f = Self { child: RefCell::new(child), stdin: RefCell::new(stdin), rx, next: Cell::new(1), t0: Instant::now(), log: Default::default() };
        f.rpc("initialize", json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "director-e2e", "version": "1.0" } }), Duration::from_secs(120))?;
        f.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        Ok(f)
    }

    fn send(&self, v: &Value) -> Result<(), String> {
        let mut w = self.stdin.borrow_mut();
        writeln!(w, "{v}").and_then(|_| w.flush()).map_err(|e| format!("media-forge stdin: {e}"))
    }

    fn rpc(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next.get();
        self.next.set(id + 1);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self.rx.recv_timeout(left).map_err(|_| format!("media-forge: no answer to {method} in {} s", timeout.as_secs()))?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("method").is_some() {
                if let Some(rid) = v.get("id") {
                    // A server request (ping): answer it so the server never stalls.
                    let _ = self.send(&json!({ "jsonrpc": "2.0", "id": rid, "result": {} }));
                }
                continue;
            }
            if v["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(e) = v.get("error") {
                return Err(format!("media-forge {method}: {e}"));
            }
            return Ok(v["result"].clone());
        }
    }
}

impl Forge for StdioForge {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        let at = ms(self.t0);
        let t = Instant::now();
        let res = self.rpc("tools/call", json!({ "name": tool, "arguments": args }), Duration::from_secs(600));
        let out = res.and_then(|r| {
            let text: Vec<String> = r["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str().map(String::from)).collect();
            let joined = if text.is_empty() { r.to_string() } else { text.join("\n") };
            if r["isError"].as_bool() == Some(true) {
                Err(joined.chars().take(500).collect())
            } else {
                Ok(tool_json(&joined))
            }
        });
        let entry = match &out {
            Ok(v) => json!({ "tool": tool, "atMs": at, "ms": ms(t), "status": v["status"], "jobId": v["id"], "progress": v["progress_pct"], "stage": v["stage"], "error": v["error"] }),
            Err(e) => json!({ "tool": tool, "atMs": at, "ms": ms(t), "callError": e }),
        };
        self.log.borrow_mut().push(entry);
        out
    }
}

impl Drop for StdioForge {
    fn drop(&mut self) {
        let _ = self.child.borrow_mut().kill();
    }
}

// ── the run ────────────────────────────────────────────────────────────────────

/// What Nic's chat panel holds (director-store `chat`): Nic's line, the Director's prose.
struct Chat {
    role: &'static str,
    text: String,
    /// A page-sent auto-fix line (director-chat chatHistory labels it as the app's).
    auto_fix: bool,
}

/// director-chat.ts AUTO_FIX_HISTORY_LABEL.
const AUTO_FIX_HISTORY_LABEL: &str = "(sent by the app, not Nic)";

/// What sendDirectorTurn knows about a turn (the step runner's turn.json).
#[derive(Default, Clone)]
struct TurnInfo {
    nic_line: Option<String>,
    brief_idea: Option<String>,
    only: Option<Vec<String>>,
    /// The page's one automatic corrective turn: `shown` is what the chat shows and logs.
    fix_shown: Option<String>,
}

/// A failed or timed-out request (not an HTTP error status or a bad body).
fn is_transport_error(e: &str) -> bool {
    e.starts_with("LM Studio: error sending request") || e.contains("timed out") || e.contains("operation timed out")
}

struct Run {
    t0: Instant,
    st: MediaState,
    cfg: os_core::OsConfig,
    slug: String,
    root: PathBuf,
    e2e: PathBuf,
    steps: Vec<Value>,
    turns: Vec<Value>,
    errors: Vec<String>,
    stubs: Vec<String>,
    chat: Vec<Chat>,
    facts: serde_json::Map<String, Value>,
    pending_plan: Option<(RenderPlan, Vec<String>)>,
    /// The live media-forge once started (plans measure black bars through it).
    forge: Option<std::rc::Rc<StdioForge>>,
    /// Automatic corrective turns the page sent (director-chat.ts, at most one per Nic turn).
    auto_retries: u32,
    /// Lines Nic had to type again because a reply (after its auto-fix) still lacked the action.
    nic_reasks: u32,
}

/// One Director turn's outcome after Rust applied its effects.
struct TurnOut {
    /// Action types that applied (did something other than be refused).
    types: Vec<String>,
    /// The page's one auto-fix turn ({ prompt, shown, only }), if this reply needs one.
    auto_fix: Option<Value>,
}

impl Run {
    fn step(&mut self, name: &str, t: Instant, ok: bool, data: Value) {
        eprintln!("[e2e] {name}: {} in {} ms", if ok { "ok" } else { "FAILED" }, ms(t));
        self.steps.push(json!({ "step": name, "ok": ok, "ms": ms(t), "data": data }));
    }

    fn snapshot(&self) -> Result<Value, String> {
        let p = load_project(&self.st, &self.slug)?;
        Ok(json!({
            "project": p,
            "assets": list_assets(&self.st, &self.slug)?,
            "manifest": load_manifest_strict(&self.root, &self.slug)?,
            "review": p.review,
            "renders": list_renders(&self.st, &self.slug)?,
            // What the page's media_transcript_lines gives its TRANSCRIPT section.
            "transcripts": transcript_lines(&self.st, &self.slug, None).unwrap_or_default(),
        }))
    }

    /// The opt-in vitest step (real TS modules) on a snapshot in `dir`.
    fn ts_step(&self, step: &str, dir: &Path) -> Result<Value, String> {
        let out = Command::new("node")
            .args(["node_modules/vitest/vitest.mjs", "run", "--config", "src/features/director/e2e/vitest.e2e.config.ts", "--reporter", "dot"])
            .current_dir(cc_root())
            .env("E2E_LIVE", "1")
            .env("E2E_STEP", step)
            .env("E2E_DIR", dir)
            .output()
            .map_err(|e| format!("node: {e}"))?;
        if !out.status.success() {
            let tail = |b: &[u8]| String::from_utf8_lossy(b).chars().rev().take(1500).collect::<String>().chars().rev().collect::<String>();
            return Err(format!("vitest {step} failed: {}\n{}", tail(&out.stdout), tail(&out.stderr)));
        }
        let p = dir.join(format!("out-{step}.json"));
        serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?).map_err(|e| e.to_string())
    }

    /// LM Studio, the way dispatch.rs `run_chat_streamed` asks it (non-streamed here), temperature 0.4.
    fn chat_call(&self, msgs: &[crate::commands::dispatch::ChatMessage]) -> Result<(String, u64, Value), String> {
        let body = json!({
            "model": MODEL,
            "messages": msgs.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
            "stream": false, "temperature": 0.4, "reasoning_effort": "none",
        });
        let t = Instant::now();
        let v: Value = tauri::async_runtime::block_on(async {
            let r = reqwest::Client::new().post(format!("{LM}/v1/chat/completions")).timeout(Duration::from_secs(TURN_SECS)).json(&body).send().await.map_err(|e| format!("LM Studio: {e}"))?;
            let r = r.error_for_status().map_err(|e| format!("LM Studio: {e}"))?;
            r.json::<Value>().await.map_err(|e| format!("LM Studio body: {e}"))
        })?;
        let answer = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
        Ok((answer, ms(t), v["usage"].clone()))
    }

    /// One Director chat turn exactly as the page sends it (director-chat.ts + director.rs), then
    /// the page's parse, then Rust carrying out every effect (Nic's accept clicks included).
    /// `wanted`: the action this line asks for; one corrective follow-up if the reply had invalid
    /// blocks or lacked it.
    fn turn(&mut self, label: &str, nic: &str, wanted: &str) -> Result<TurnOut, String> {
        let mut out = self.send_turn(label, nic, wanted)?;
        for k in 1..=NIC_REASKS {
            if out.types.iter().any(|t| t == wanted) {
                break;
            }
            // Not the app's doing: Nic, seeing no card, would ask again. Typed by Nic, so it
            // goes through sendDirectorTurn like any line (and may get its own auto-fix).
            self.nic_reasks += 1;
            self.errors.push(format!("turn {label}: no {wanted} applied (after the page's auto-fix, if any): Nic asks again ({k} of {NIC_REASKS})"));
            let tag = if k == 1 { format!("{label}-reask") } else { format!("{label}-reask{k}") };
            let again = self.send_turn(&tag, &format!("I don't see a {wanted} card yet. Please send it as a director-action block."), wanted)?;
            out.types.extend(again.types);
        }
        Ok(out)
    }

    /// sendDirectorTurn (director-chat.ts): Nic's line, then at most ONE automatic corrective turn
    /// when the reply had invalid blocks, a refused plan or a no-op revision. The fix applies only
    /// the failed types (fixAllowlist) and is never fixed again.
    fn send_turn(&mut self, label: &str, nic: &str, wanted: &str) -> Result<TurnOut, String> {
        let info = TurnInfo { nic_line: Some(nic.to_string()), ..Default::default() };
        let mut out = self.one_turn(label, nic, wanted, &info)?;
        if let Some(fix) = out.auto_fix.take() {
            self.auto_retries += 1;
            let only: Option<Vec<String>> = fix["only"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect());
            let prompt = fix["prompt"].as_str().unwrap_or("").to_string();
            let finfo = TurnInfo { nic_line: info.nic_line.clone(), brief_idea: None, only, fix_shown: Some(fix["shown"].as_str().unwrap_or("").to_string()) };
            let again = self.one_turn(&format!("{label}-autofix"), &prompt, wanted, &finfo)?;
            out.types.extend(again.types);
        }
        Ok(out)
    }

    /// media_plan_check on each plan the reply holds, as checkedBody sends it (clips + checkPlanFor).
    /// An IPC-level failure applies the plan unchecked with a warning, as plan-check.ts does.
    fn plan_checks(&mut self, label: &str, dir: &Path) -> Result<Vec<Value>, String> {
        let plans = self.ts_step("plans", dir)?;
        let mut out = vec![];
        for p in plans["plans"].as_array().cloned().unwrap_or_default() {
            let r = (|| -> Result<PlanCheck, String> {
                let clips: Vec<CheckClip> = serde_json::from_value(p["clips"].clone()).map_err(|e| format!("clips: {e}"))?;
                let plan: Option<CheckPlan> = match p.get("plan") {
                    Some(v) if !v.is_null() => Some(serde_json::from_value(v.clone()).map_err(|e| format!("plan: {e}"))?),
                    _ => None,
                };
                plan_check_with(&self.st, &self.slug, clips, plan)
            })();
            out.push(match r {
                Ok(r) => serde_json::to_value(&r).map_err(|e| e.to_string())?,
                Err(e) => {
                    self.errors.push(format!("turn {label}: media_plan_check failed ({e}): the page applies that plan unchecked"));
                    let clips = p["clips"].clone();
                    json!({ "clips": clips, "totalSec": 0, "targetSec": null, "warnings": [format!("the plan check didn't run ({e}): applied as written")], "refusals": [] })
                }
            });
        }
        std::fs::write(dir.join("plan-check.json"), serde_json::to_string_pretty(&out).unwrap()).map_err(|e| e.to_string())?;
        Ok(out)
    }

    fn one_turn(&mut self, label: &str, nic: &str, wanted: &str, info: &TurnInfo) -> Result<TurnOut, String> {
        let t = Instant::now();
        let dir = self.e2e.join(format!("turn-{label}"));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("snapshot.json"), serde_json::to_string_pretty(&self.snapshot()?).unwrap()).map_err(|e| e.to_string())?;
        let ctx = self.ts_step("context", &dir)?;
        let context = ctx["context"].as_str().unwrap_or("").to_string();
        // director-chat.ts chatHistory: the last 10 non-empty messages (Director = its prose).
        let hist: Vec<HistoryMsg> = self
            .chat
            .iter()
            .filter(|m| !m.text.trim().is_empty())
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|m| HistoryMsg { role: if m.role == "nic" { "user".into() } else { "assistant".into() }, content: if m.auto_fix { format!("{AUTO_FIX_HISTORY_LABEL} {}", m.text) } else { m.text.clone() } })
            .collect();
        // What the chat shows and logs for this line: an auto-fix shows its short "[auto-fix]" line.
        let shown = info.fix_shown.clone().unwrap_or_else(|| nic.to_string());
        let is_fix = info.fix_shown.is_some();
        std::fs::write(dir.join("turn.json"), serde_json::to_string_pretty(&json!({ "nicLine": info.nic_line, "briefIdea": info.brief_idea, "only": info.only, "isFix": is_fix })).unwrap()).map_err(|e| e.to_string())?;
        let req = DirectorTurnRequest { text: nic.into(), history: hist, context: context.clone(), stream_id: None };
        let mut msgs = director_messages(&req, None)?;
        if let Some(first) = msgs.first_mut() {
            first.content = crate::commands::agents::tony_system(std::mem::take(&mut first.content), Some(MODEL), false);
        }
        let system_chars = msgs[0].content.chars().count();
        let total: usize = msgs.iter().map(|m| m.content.chars().count()).sum();
        if total >= PROMPT_CAP {
            return Err(format!("turn {label}: prompt {total} chars would overflow to the droplet"));
        }
        std::fs::write(dir.join("prompt.json"), serde_json::to_string_pretty(&msgs.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>()).unwrap()).map_err(|e| e.to_string())?;
        let _ = chat_log(&self.st, &self.slug, Some(("nic".into(), shown.clone())));
        let mut call = self.chat_call(&msgs);
        // A transport error (LM Studio busy with another client until the turn cap; runs 12-13) is
        // the environment, not the Director: retry the same turn once and say so in the report.
        if let Err(e) = &call {
            if is_transport_error(e) {
                self.errors.push(format!("turn {label}: {e}; retried once (LM Studio busy, not a Director defect)"));
                call = self.chat_call(&msgs);
            }
        }
        let (answer, latency, usage) = match call {
            Ok(x) => x,
            Err(e) => {
                self.turns.push(json!({ "turn": label, "nic": nic, "wanted": wanted, "modelError": e, "promptChars": total }));
                return Err(e);
            }
        };
        std::fs::write(dir.join("reply.txt"), &answer).map_err(|e| e.to_string())?;
        let _ = chat_log(&self.st, &self.slug, Some(("director".into(), answer.clone())));
        // checkedBody: the plan check runs on every plan before it applies (snapping, refusals,
        // the revision no-op test via unchangedSinceRender).
        let has_plan = answer.contains("propose_edit_plan") || answer.contains("revise_edit");
        let checks = if has_plan { self.plan_checks(label, &dir)? } else { vec![] };
        let applied = self.ts_step("apply", &dir)?;
        let prose = applied["parsed"]["prose"].as_str().unwrap_or("").to_string();
        self.chat.push(Chat { role: "nic", text: shown.clone(), auto_fix: is_fix });
        self.chat.push(Chat { role: "director", text: if prose.is_empty() { "(actions only)".into() } else { prose }, auto_fix: false });
        let actions = applied["parsed"]["actions"].as_array().cloned().unwrap_or_default();
        let types: Vec<String> = applied["appliedTypes"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(String::from)).collect();
        let effects = applied["effects"].as_array().cloned().unwrap_or_default();
        let results = self.apply_effects(&effects);
        let auto_fix = applied["autoFix"].clone();
        eprintln!("[e2e] turn {label}: {latency} ms, applied {types:?}, errors {}, refusals {}, autoFix {}", applied["parsed"]["errors"], applied["refusals"], !auto_fix.is_null());
        self.turns.push(json!({
            "turn": label, "nic": shown, "sentToModel": nic, "isAutoFix": is_fix, "only": info.only, "wanted": wanted, "systemChars": system_chars, "contextChars": context.chars().count(), "promptChars": total,
            "historyMsgs": msgs.len().saturating_sub(2), "latencyMs": latency, "wallMs": ms(t), "usage": usage,
            "reply": answer, "actions": actions, "appliedTypes": types, "ignored": applied["parsed"]["ignored"], "errors": applied["parsed"]["errors"], "notes": applied["notes"],
            "planChecks": checks, "warnings": applied["warnings"], "refusals": applied["refusals"], "autoFix": auto_fix,
            "effects": effects.iter().map(|e| json!({ "kind": e["kind"], "why": e["why"], "by": e["by"] })).collect::<Vec<_>>(), "effectResults": results,
        }));
        Ok(TurnOut { types, auto_fix: if auto_fix.is_null() || is_fix { None } else { Some(auto_fix) } })
    }

    /// Carry out the page's effects through the real media.rs functions (what api.* would invoke).
    fn apply_effects(&mut self, effects: &[Value]) -> Vec<Value> {
        let mut out = vec![];
        for e in effects {
            let kind = e["kind"].as_str().unwrap_or("");
            let r: Result<Value, String> = (|| match kind {
                "project_update" => {
                    let b: CreativeBrief = serde_json::from_value(e["brief"].clone()).map_err(|x| format!("brief shape: {x}"))?;
                    project_update(&self.st, &self.slug, None, Some(b), None, None).map(|p| json!({ "status": p.status }))
                }
                "brief_held" => Ok(json!("held (approved brief kept)")),
                "manifest_save" => {
                    let mut m: TimelineManifest = serde_json::from_value(e["manifest"].clone()).map_err(|x| format!("manifest shape: {x}"))?;
                    // The store tracks the saved revision locally; here the disk is the only writer.
                    m.revision = load_manifest_strict(&self.root, &self.slug)?.revision;
                    m.updated_by = e["by"].as_str().unwrap_or("nic").into();
                    manifest_save(&self.st, &self.slug, m).map(|m| json!({ "revision": m.revision, "clips": m.clips.len(), "slots": m.shot_list.len() }))
                }
                "asset_slot" => asset_update(&self.st, &self.slug, e["assetId"].as_str().unwrap_or(""), None, None, Some(e["slotId"].as_str().unwrap_or("").into())).map(|a| json!({ "slotId": a.slot_id })),
                "asset_moments" => {
                    let ms: Vec<Moment> = serde_json::from_value(e["moments"].clone()).map_err(|x| format!("moments shape: {x}"))?;
                    asset_update(&self.st, &self.slug, e["assetId"].as_str().unwrap_or(""), None, Some(ms), None).map(|a| json!({ "moments": a.moments.len() }))
                }
                "review_write" => {
                    let ds: Option<Vec<String>> = e.get("openDecisions").and_then(|d| serde_json::from_value(d.clone()).ok());
                    review_write(&self.st, &self.slug, e["round"].as_u64().unwrap_or(1) as u8, e["summary"].as_str().map(String::from), ds).map(|r| json!({ "rounds": r.rounds.len() }))
                }
                "render_plan" => {
                    // requestPlan → media_render_plan → build_plan_with (framing auto: detect_bars via the live forge).
                    let plan = match &self.forge {
                        Some(f) => build_plan_with(&self.st, &**f, &self.slug, "director")?,
                        None => build_plan(&self.st, &self.slug, "director")?,
                    };
                    let resolves: Vec<String> = e["resolves"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
                    let framing: Vec<String> = plan.sources.iter().enumerate().map(|(k, s)| format!("clip {}: {}", k + 1, s.framing)).collect();
                    let j = json!({ "planId": plan.plan_id, "outputSpec": plan.output_spec, "sources": plan.sources.len(), "framing": framing, "warnings": plan.warnings });
                    self.pending_plan = Some((plan, resolves));
                    Ok(j)
                }
                "refused" => Err(format!("refused by the page: {}", e["why"])),
                other => Err(format!("unknown effect {other}")),
            })();
            match r {
                Ok(v) => out.push(json!({ "kind": kind, "ok": v })),
                Err(err) => {
                    self.errors.push(format!("effect {kind}: {err}"));
                    out.push(json!({ "kind": kind, "error": err }));
                }
            }
        }
        out
    }

    /// Nic's "Approve & Render" (media_render_execute + run_outputs + watch_one, synchronously):
    /// every output rendered CPU-only by media-forge render_timeline, then verified by Rust.
    fn render(&mut self, forge: &StdioForge, label: &str) -> Result<Vec<VerifiedRender>, String> {
        let t = Instant::now();
        let (plan, resolves) = self.pending_plan.take().ok_or("no render plan raised")?;
        claim_render(&self.st, &self.slug)?;
        let res = (|| -> Result<(Vec<VerifiedRender>, Vec<Value>), String> {
            check_plan_executable(&self.st, &self.slug, &plan)?;
            let m = load_manifest_strict(&self.root, &self.slug)?;
            if m.revision != plan.manifest_revision {
                return Err("STALE_PLAN".into());
            }
            let assets = list_assets(&self.st, &self.slug)?;
            validate_manifest(&m, &self.slug, &assets)?;
            let outs = prepare_outputs(&m, &assets, &plan, &self.root)?;
            let expect = expected_duration(&m);
            let mut renders = vec![];
            let mut timing = vec![];
            for (k, o) in outs.iter().enumerate() {
                let to = Instant::now();
                let start = forge.call("render_timeline", &json!({ "spec_path": o.spec_path.to_string_lossy(), "output": o.out.to_string_lossy(), "wait_s": 0 }))?;
                let id = start["id"].as_str().ok_or_else(|| format!("media-forge did not start a job: {start}"))?.to_string();
                if k == 0 {
                    mark_plan_used(&self.st, &plan.plan_id);
                    // approvePlan: a waiting revision's notes resolve with Nic's render approval.
                    for n in &resolves {
                        match note_resolve(&self.st, &self.slug, n) {
                            Err(e) if e.starts_with("UNCHANGED_PLAN") => self.errors.push(format!("note {n} stayed open: {e}")),
                            r => r?,
                        }
                    }
                }
                let mut last_stage = String::new();
                let mut stages = vec![];
                let r = loop {
                    std::thread::sleep(Duration::from_millis(1000));
                    let v = forge.call("job_status", &json!({ "job_id": id, "wait_s": 2 }))?;
                    let stage = v["stage"].as_str().unwrap_or("").to_string();
                    if stage != last_stage {
                        stages.push(json!({ "atMs": ms(to), "stage": stage, "pct": v["progress_pct"] }));
                        last_stage = stage;
                    }
                    match v["status"].as_str().unwrap_or("running") {
                        "queued" | "running" => continue,
                        "done" => break verify_and_record(&self.st, &self.cfg, &self.slug, &plan.plan_id, o, expect, v["result"]["loudness_measured"].as_f64())?,
                        s => return Err(format!("render {s}: {}", v["error"].as_str().unwrap_or("the render failed"))),
                    }
                };
                timing.push(json!({ "platform": o.platform, "ms": ms(to), "stages": stages, "expectSec": expect, "render": r }));
                renders.push(r);
            }
            Ok((renders, timing))
        })();
        release_render(&self.st, &self.slug);
        let ok = res.is_ok();
        let data = match &res {
            Ok((_, timing)) => json!({ "plan": plan, "resolvedNotes": resolves, "outputs": timing }),
            Err(e) => json!({ "plan": plan, "error": e }),
        };
        self.step(label, t, ok, data);
        res.map(|(r, _)| r)
    }
}

/// `ffmpeg -af ebur128` integrated loudness (the summary's "I: … LUFS").
fn ebur128(ffmpeg: &str, path: &Path) -> Option<f64> {
    let p = path.to_string_lossy().to_string();
    let out = run_hidden(ffmpeg, &["-hide_banner", "-nostats", "-i", &p, "-af", "ebur128", "-f", "null", "-"], Duration::from_secs(300)).ok()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    let summary = text.rsplit("Summary:").next()?;
    summary.lines().find_map(|l| l.trim().strip_prefix("I:")).and_then(|r| r.trim().trim_end_matches("LUFS").trim().parse().ok())
}

fn frame(ffmpeg: &str, src: &Path, at: f64, out: &Path) -> bool {
    let (s, o, t) = (src.to_string_lossy().to_string(), out.to_string_lossy().to_string(), format!("{at:.2}"));
    run_hidden(ffmpeg, &["-y", "-hide_banner", "-loglevel", "error", "-ss", &t, "-i", &s, "-frames:v", "1", "-q:v", "3", &o], Duration::from_secs(60)).map(|r| r.status.success()).unwrap_or(false) && out.is_file()
}

fn file_sig(p: &Path) -> Option<(u64, Option<std::time::SystemTime>)> {
    std::fs::metadata(p).ok().map(|m| (m.len(), m.modified().ok()))
}

#[test]
#[ignore = "live: real media-forge, the loaded Qwen on LM Studio and the real projects root; run with E2E_LIVE=1 -- --ignored"]
fn e2e_live_demo_reel() {
    if std::env::var("E2E_LIVE").as_deref() != Ok("1") {
        eprintln!("E2E_LIVE is not 1: skipping the live Director Suite run");
        return;
    }
    let t0 = Instant::now();
    // ── preflight: the model must already be loaded (never load or unload one) ──
    let loaded: Value = tauri::async_runtime::block_on(async { reqwest::Client::new().get(format!("{LM}/api/v0/models")).timeout(Duration::from_secs(10)).send().await.ok()?.json::<Value>().await.ok() }).unwrap_or(Value::Null);
    let state = loaded["data"].as_array().into_iter().flatten().find(|m| m["id"] == MODEL).map(|m| m["state"].clone()).unwrap_or(Value::Null);
    assert_eq!(state, json!("loaded"), "{MODEL} isn't loaded in LM Studio ({state}); this run never loads a model");
    let src_sig = file_sig(Path::new(SOURCE)).expect("the source reel is missing");

    // ── step 1: project in the real projects root, scratch media.db ──
    let t = Instant::now();
    let scratch = PathBuf::from(r"F:\claude-scratch\director-e2e").join(short_id("run"));
    std::fs::create_dir_all(&scratch).unwrap();
    let mut conn = Connection::open(scratch.join("media.db")).unwrap();
    migrate(&mut conn).unwrap();
    let st = MediaState::with_conn(conn, &PathBuf::from(os_core::MEDIA_ROOT).join("projects"));
    let p = create_project(&st, TITLE, None).expect("create project");
    let root = PathBuf::from(&p.root);
    let e2e = root.join("working").join("e2e");
    std::fs::create_dir_all(&e2e).unwrap();
    let mut run = Run { t0, st, cfg: os_core::OsConfig::default(), slug: p.slug.clone(), root: root.clone(), e2e: e2e.clone(), steps: vec![], turns: vec![], errors: vec![], stubs: vec![], chat: vec![], facts: Default::default(), pending_plan: None, forge: None, auto_retries: 0, nic_reasks: 0 };
    run.stubs.push(format!("media.db is a fresh scratch db ({}) so the intake tick only sees this project and the app's db is never migrated; the project folder is in the real projects root but the running app's project list won't show it", scratch.join("media.db").display()));
    run.stubs.push("LM Studio called directly (non-streamed) instead of dispatch::run_chat_streamed; same messages, reasoning_effort none, temperature 0.4 (the app sends no temperature)".into());
    run.stubs.push("Nic's clicks (approve brief, accept every match / moment, Approve & Render, Approve final) are made by the harness through the same media.rs functions the IPC commands call".into());
    run.step("1 create project", t, true, json!({ "slug": p.slug, "root": p.root, "status": p.status }));

    let result = drive(&mut run);
    if let Err(e) = &result {
        run.errors.push(format!("run stopped: {e}"));
    }
    // The source must be untouched.
    let after = file_sig(Path::new(SOURCE));
    run.facts.insert("sourceUnchanged".into(), json!(after == Some(src_sig)));
    run.facts.insert("totalMs".into(), json!(ms(run.t0)));
    run.facts.insert("autoRetries".into(), json!(run.auto_retries));
    run.facts.insert("nicReasks".into(), json!(run.nic_reasks));
    if let Ok(p) = load_project(&run.st, &run.slug) {
        let idea = p.brief.as_ref().map(|b| b.idea.clone());
        run.facts.insert("briefIdea".into(), json!({ "idea": idea, "verbatim": idea.as_deref() == Some(IDEA) }));
    }
    let _ = std::fs::copy(scratch.join("media.db"), e2e.join("media.db"));
    write_report(&run);
    eprintln!("[e2e] report: {}", e2e.join("report.md").display());
    assert!(result.is_ok(), "{:?}", result.err());
    assert_eq!(after, Some(src_sig), "the source reel changed");
}

fn drive(run: &mut Run) -> Result<(), String> {
    // ── step 2: inbox copy + the real intake with live media-forge ──
    let t = Instant::now();
    let inbox = run.root.join("inbox");
    let dst = inbox.join("Nicholas_Rae_Demo_Reel.mp4");
    std::fs::copy(SOURCE, &dst).map_err(|e| format!("copy the reel into the inbox: {e}"))?;
    run.step("2a copy reel into inbox", t, true, json!({ "bytes": std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0) }));
    let t = Instant::now();
    let forge = std::rc::Rc::new(StdioForge::start(&run.e2e.join("media-forge.stderr.log"))?);
    run.forge = Some(forge.clone());
    let status = forge.call("media_status", &json!({})).unwrap_or(Value::Null);
    run.step("2b start media-forge (worktree code, stdio MCP)", t, true, json!({ "mediaStatus": status }));
    let t = Instant::now();
    let events: RefCell<Vec<Value>> = Default::default();
    let emit = |v: Value| {
        eprintln!("[e2e] intake {} {}", v["stage"], v["detail"]);
        events.borrow_mut().push(json!({ "atMs": ms(t), "event": v }));
    };
    let mut ticks = 0;
    loop {
        ticks += 1;
        intake_tick_once(&run.st, &run.cfg, &*forge, &emit)?;
        let assets = list_assets(&run.st, &run.slug)?;
        let queued = run.st.transcribe_queue.lock().unwrap().len();
        if !assets.is_empty() && queued == 0 && !dst.exists() {
            break;
        }
        if ticks > 30 {
            return Err(format!("intake didn't finish after {ticks} ticks: {:?}", intake_status(&run.st, &run.slug)));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let assets = list_assets(&run.st, &run.slug)?;
    let a = assets.first().cloned().ok_or("no asset")?;
    let log = forge.log.borrow().clone();
    let tb = log.iter().find(|e| e["tool"] == "transcribe_batch").cloned();
    let whisper_ms = tb.as_ref().and_then(|s| {
        let id = s["jobId"].clone();
        let end = log.iter().filter(|e| e["jobId"] == id && e["status"] == "done").last()?;
        Some(end["atMs"].as_u64()? + end["ms"].as_u64()? - s["atMs"].as_u64()?)
    });
    let sc = log.iter().find(|e| e["tool"] == "detect_scenes").cloned();
    let scenes_ms = sc.as_ref().and_then(|s| {
        let id = s["jobId"].clone();
        let end = log.iter().filter(|e| e["jobId"] == id && (e["status"] == "done" || e["status"] == "failed")).last()?;
        Some(end["atMs"].as_u64()? + end["ms"].as_u64()? - s["atMs"].as_u64()?)
    });
    let st = intake_status(&run.st, &run.slug)?;
    let ok = a.transcript.as_ref().is_some_and(|t| t.words > 0) && st.last_error.is_none();
    run.facts.insert("whisperMs".into(), json!(whisper_ms));
    run.step(
        "2c intake (tick → ingest → probe flags → scenes → tiny.en CPU transcript)",
        t,
        ok,
        json!({
            "ticks": ticks, "events": events.borrow().clone(), "intakeStatus": st, "whisperMs": whisper_ms, "scenesMs": scenes_ms,
            "asset": { "id": a.id, "name": a.name, "kind": a.kind, "durationSec": a.duration_sec, "w": a.width, "h": a.height, "sizeBytes": a.size_bytes, "readOnly": a.read_only, "path": a.path,
                       "flags": a.flags, "transcript": a.transcript, "scenes": a.scenes, "sceneCount": a.scenes.as_ref().map(|c| c.len() + 1) },
            "forgeCalls": log,
        }),
    );

    // ── step 3: Director turns on the loaded Qwen ──
    let t = Instant::now();
    // Nic types the idea, then asks for the brief (a suite project starts with no handoff text).
    let first = format!("{IDEA}

Draft the brief.");
    let out = run.turn("a-brief", &first, "draft_brief");
    run.step("3a turn: draft the brief", t, out.as_ref().is_ok_and(|o| o.types.iter().any(|x| x == "draft_brief")), json!({ "types": out.as_ref().map(|o| o.types.clone()).ok() }));
    out?;
    // Nic's "Approve brief" click (approveBrief: updatedBy nic, approved true).
    let t = Instant::now();
    let mut b = load_project(&run.st, &run.slug)?.brief.ok_or("the Director's brief didn't land")?;
    b.approved = true;
    b.updated_by = "nic".into();
    let p = project_update(&run.st, &run.slug, None, Some(b.clone()), None, None)?;
    run.step("3a' Nic approves the brief", t, p.status == "shooting", json!({ "status": p.status, "brief": p.brief }));

    let t = Instant::now();
    let out = run.turn("b-shots", "give me the shot list for this — I already have the reel, so plan it from the footage", "populate_shot_list");
    let m = load_manifest_strict(&run.root, &run.slug)?;
    run.step("3b turn: shot list", t, out.as_ref().is_ok_and(|o| o.types.iter().any(|x| x == "populate_shot_list")) && !m.shot_list.is_empty(), json!({ "slots": m.shot_list }));
    out?;

    let t = Instant::now();
    let out = run.turn("c-match", "The reel is in the bin. Match it to the shot list and mark its best 2–4 second moments.", "match_footage");
    let m = load_manifest_strict(&run.root, &run.slug)?;
    let a = load_asset(&run.st, &run.slug, &a.id)?;
    run.step(
        "3c turn: match footage + moments",
        t,
        out.as_ref().is_ok_and(|o| o.types.iter().any(|x| x == "match_footage")),
        json!({ "attached": m.shot_list.iter().map(|s| json!({ "slot": s.id, "asset": s.asset_id, "status": s.status })).collect::<Vec<_>>(), "moments": a.moments, "assetSlot": a.slot_id, "status": load_project(&run.st, &run.slug)?.status }),
    );
    out?;

    let t = Instant::now();
    let out = run.turn("d-plan", "propose the edit plan", "propose_edit_plan");
    let m = load_manifest_strict(&run.root, &run.slug)?;
    run.step(
        "3d turn: edit plan",
        t,
        out.as_ref().is_ok_and(|o| o.types.iter().any(|x| x == "propose_edit_plan")) && run.pending_plan.is_some(),
        json!({ "clips": m.clips, "output": m.output, "outputs": m.outputs, "captions": m.captions, "color": m.color, "expectedSec": expected_duration(&m), "plan": run.pending_plan.as_ref().map(|(p, _)| p.clone()) }),
    );
    out?;

    // ── step 4: Approve & Render, round 1 ──
    let r1 = run.render(&forge, "4 render round 1 (CPU libx264, verified)")?;
    let r1 = r1.first().cloned().ok_or("no round-1 render")?;
    let review = review_get(&run.st, &run.slug)?;
    let m1 = load_manifest_strict(&run.root, &run.slug)?;
    run.facts.insert("round1".into(), json!({ "render": r1, "review": review, "clips": m1.clips, "expectedSec": expected_duration(&m1) }));

    // ── step 5: Nic's note at ~5 s, Director revise_edit, round 2, approve final ──
    let t = Instant::now();
    let note = note_add(&run.st, &run.slug, NoteInput { render_id: Some(r1.id.clone()), at_sec: Some(5.0), text: NOTE.into(), by: "nic".into(), via_voice: false })?;
    run.step("5a Nic's note on round 1", t, true, json!({ "note": note }));
    let t = Instant::now();
    let out = run.turn("e-revise", "I left you a note on the first cut. Revise the edit.", "revise_edit");
    let m = load_manifest_strict(&run.root, &run.slug)?;
    run.step(
        "5b turn: revise_edit",
        t,
        out.as_ref().is_ok_and(|o| o.types.iter().any(|x| x == "revise_edit")) && run.pending_plan.is_some(),
        json!({ "clips": m.clips, "captions": m.captions, "color": m.color, "outputs": m.outputs, "expectedSec": expected_duration(&m), "review": review_get(&run.st, &run.slug)? }),
    );
    out?;
    let r2 = run.render(&forge, "5c render round 2 (CPU libx264, verified)")?;
    let review = review_get(&run.st, &run.slug)?;
    let m2 = load_manifest_strict(&run.root, &run.slug)?;
    let same_clips = plans_equivalent(&m1, &m2);
    let same_bytes = r2.first().is_some_and(|r| r.size_bytes == r1.size_bytes);
    run.facts.insert("round2".into(), json!({ "renders": r2, "review": review, "notes": m2.notes, "clips": m2.clips, "expectedSec": expected_duration(&m2), "sameClipsAsRound1": same_clips, "sameBytesAsRound1": same_bytes }));
    let t = Instant::now();
    let ids: Vec<String> = r2.iter().map(|r| r.id.clone()).collect();
    let dels = approve_final(&run.st, &run.slug, &ids, true)?;
    let p = load_project(&run.st, &run.slug)?;
    let reels = run.root.join("renders").join("final").join("reels");
    let reels_files: Vec<String> = std::fs::read_dir(&reels).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    run.step("5d approve final", t, !dels.is_empty() && p.status == "done", json!({ "deliverables": dels, "status": p.status, "review": p.review, "finalReelsDir": reels, "finalReelsFiles": reels_files }));
    if reels_files.is_empty() {
        run.errors.push(format!("renders/final/reels/ has no files (deliverable platforms: {:?})", dels.iter().map(|d| d.platform.clone()).collect::<Vec<_>>()));
    }

    // ── step 6: measure the final file ──
    let t = Instant::now();
    let fin = PathBuf::from(&dels.first().ok_or("no deliverable")?.path);
    let ffmpeg = media_bin(&run.cfg, "ffmpeg").ok_or("ffmpeg not found")?;
    let ffprobe = media_bin(&run.cfg, "ffprobe").ok_or("ffprobe not found")?;
    let pr = probe(&ffprobe, &fin)?;
    let size = std::fs::metadata(&fin).map(|m| m.len()).unwrap_or(0);
    let lufs = ebur128(&ffmpeg, &fin);
    let dur = pr.duration.unwrap_or(0.0);
    let mut frames = vec![];
    for (name, at) in [("start", 0.3), ("middle", dur / 2.0), ("end", (dur - 0.4).max(0.0))] {
        let out = run.e2e.join(format!("frame_{name}.jpg"));
        if frame(&ffmpeg, &fin, at, &out) {
            frames.push(out.to_string_lossy().to_string());
        } else {
            run.errors.push(format!("frame {name} @ {at:.2}s not extracted"));
        }
    }
    let fin_facts = json!({ "path": fin, "durationSec": pr.duration, "width": pr.width, "height": pr.height, "sizeMb": (size as f64 / 1_048_576.0 * 100.0).round() / 100.0, "integratedLufs": lufs, "frames": frames });
    run.facts.insert("final".into(), fin_facts.clone());
    run.step("6 measure final", t, lufs.is_some() && frames.len() == 3, fin_facts);
    Ok(())
}

fn write_report(run: &Run) {
    let ok_steps = run.steps.iter().filter(|s| s["ok"] == true).count();
    let rep = json!({
        "scenario": { "idea": IDEA, "source": SOURCE, "note": NOTE, "model": MODEL, "endpoint": format!("{LM}/v1/chat/completions") },
        "project": { "slug": run.slug, "root": run.root },
        "summary": { "steps": run.steps.len(), "stepsOk": ok_steps, "turns": run.turns.len(), "errors": run.errors.len() },
        "facts": run.facts, "steps": run.steps, "turns": run.turns, "errors": run.errors, "stubs": run.stubs,
    });
    let _ = std::fs::write(run.e2e.join("report.json"), serde_json::to_string_pretty(&rep).unwrap_or_default());
    let mut md = format!("# Director Suite Part 1, live E2E\n\nProject `{}` at `{}`. {} of {} steps passed, {} Director calls, total {:.1} min.\n\nIdea: \"{IDEA}\"\n\n## Steps\n\n| Step | Result | Time |\n|---|---|---|\n", run.slug, run.root.display(), ok_steps, run.steps.len(), run.turns.len(), ms(run.t0) as f64 / 60_000.0);
    for s in &run.steps {
        md.push_str(&format!("| {} | {} | {:.1} s |\n", s["step"].as_str().unwrap_or(""), if s["ok"] == true { "pass" } else { "FAIL" }, s["ms"].as_u64().unwrap_or(0) as f64 / 1000.0));
    }
    md.push_str("\n## Director turns\n");
    for t in &run.turns {
        md.push_str(&format!(
            "\n### {} — {}: \"{}\"\n\nPrompt {} chars (system {}, context {}), latency {} ms, usage `{}`.\nActions: `{}` (applied: `{}`). Errors: `{}`.\nPlan-check warnings: `{}`. Refusals: `{}`. Auto-fix requested: {}.\n\n```text\n{}\n```\n",
            t["turn"].as_str().unwrap_or(""),
            if t["isAutoFix"] == true { "the page (auto-fix)" } else { "Nic" },
            t["nic"].as_str().unwrap_or(""),
            t["promptChars"],
            t["systemChars"],
            t["contextChars"],
            t["latencyMs"],
            t["usage"],
            t["actions"].as_array().map(|a| a.iter().filter_map(|x| x["type"].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
            t["appliedTypes"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
            t["errors"],
            t["warnings"],
            t["refusals"],
            if t["autoFix"].is_null() { "no" } else { "yes" },
            t["reply"].as_str().or(t["modelError"].as_str()).unwrap_or("").replace("```", "'''"),
        ));
    }
    md.push_str("\n## Facts\n\n```json\n");
    md.push_str(&serde_json::to_string_pretty(&run.facts).unwrap_or_default());
    md.push_str("\n```\n\n## Errors\n\n");
    for e in &run.errors {
        md.push_str(&format!("- {e}\n"));
    }
    md.push_str("\n## Stubs / deviations\n\n");
    for s in &run.stubs {
        md.push_str(&format!("- {s}\n"));
    }
    let _ = std::fs::write(run.e2e.join("report.md"), md);
}

#[test]
fn only_transport_errors_are_retried() {
    assert!(is_transport_error("LM Studio: error sending request for url (http://127.0.0.1:1235/v1/chat/completions)"));
    assert!(is_transport_error("LM Studio: operation timed out"));
    assert!(!is_transport_error("LM Studio: HTTP status client error (400 Bad Request)"));
    assert!(!is_transport_error("LM Studio body: expected value at line 1 column 1"));
}
