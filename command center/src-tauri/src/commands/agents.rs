//! Core OS orchestrator ("Tony").
//!
//! One read-only turn runs a 4-stage pipeline natively — it never depends
//! on a gateway CLI agent being installed:
//!
//!   1. Live context: the dashboard's current state (weather, nodes, GPU,
//!      alarms…) + MASTER_IDENTITY.md + attached skills go into the system
//!      prompt, so "what's the weather" is answered from real data.
//!   2. Delegation: specialist roles go to their AnythingLLM workspace
//!      (`/api/v1/workspace/{slug}/thread/{thread}/chat`) and the exchange is
//!      returned as visible TONY → AGENT / AGENT → TONY steps.
//!   3. Step-in: if the sub-agent errors or times out (or the request is a
//!      plain system question), the OS answers itself with its own tools.
//!   4. Overseer: `overseer_ask` (button) or optional auto-escalation sends
//!      the turn to Claude / Gemini / the droplet for a second opinion.
//!
//! Mutating actions never come through here — they still go plan → confirm
//! card → approve() in the webview.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

use super::allm::{AllmConn, AllmReader, ChatRequest, ChatTarget, Threads};
use super::bridge::BridgeState;
use super::dispatch::{extract_json, run_chat, short, ChatMessage, DispatchState, Priority};
use super::os_core::{self, OsConfig, OsState};

// ── AnythingLLM ─────────────────────────────────────────────────────────────
// Raw requests, thread resolution and message hygiene live in `allm.rs`; this is the
// slot-holding, Tony-facing layer on top of it.

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub slug: String,
    pub name: String,
    pub threads: usize,
    /// The workspace's own chat / agent model; `None` = AnythingLLM's system default.
    pub chat_provider: Option<String>,
    pub chat_model: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_model: Option<String>,
}

/// `/v1/workspaces` JSON -> the fields the app shows (slug, name, thread count, models). Nothing else.
pub(crate) fn parse_workspaces(v: &Value) -> Vec<WorkspaceInfo> {
    let s = |w: &Value, k: &str| w[k].as_str().map(str::trim).filter(|x| !x.is_empty()).map(String::from);
    v["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| WorkspaceInfo {
            slug: w["slug"].as_str().unwrap_or("").into(),
            name: w["name"].as_str().unwrap_or("").into(),
            threads: w["threads"].as_array().map(|t| t.len()).unwrap_or(0),
            chat_provider: s(w, "chatProvider"),
            chat_model: s(w, "chatModel"),
            agent_provider: s(w, "agentProvider"),
            agent_model: s(w, "agentModel"),
        })
        .collect()
}

/// Every AnythingLLM workspace, with models. The API key stays in Rust.
pub(crate) async fn fetch_workspaces(state: &DispatchState, cfg: &OsConfig, secs: u64) -> Result<Vec<WorkspaceInfo>, String> {
    let reader = AllmReader::new(AllmConn::local(state, cfg)?);
    Ok(parse_workspaces(&reader.list_workspaces(secs).await?))
}

#[tauri::command]
pub async fn anythingllm_workspaces(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<Vec<WorkspaceInfo>, String> {
    fetch_workspaces(&state, &os.snapshot(), 8).await
}

pub fn month_tag() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

/// Thread resolution context for this process: the persisted map (tasks.db) + the session cache.
fn allm_threads<'a>(os: &'a OsState, cfg: &'a OsConfig) -> Threads<'a> {
    Threads { map: super::allm::thread_map(), cache: &os.allm_threads, os_name: &cfg.os_name, month: month_tag() }
}

/// Ask one workspace in Tony's monthly thread. Returns (answer, source titles).
pub(crate) async fn workspace_chat(state: &DispatchState, os: &OsState, slug: &str, role: &str, message: &str) -> Result<(String, Vec<String>), String> {
    workspace_chat_t(state, os, slug, role, message, None, true, ChatTarget::TonyMonthly).await
}

/// Same, with a timeout, slot priority and target of the caller's choosing (the worker uses
/// `ChatTarget::TaskSession`). The slot is held for the call and, after a timeout, for the
/// settle window (`scheduler.settleSecs`), since the server may still be generating.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn workspace_chat_t(state: &DispatchState, os: &OsState, slug: &str, role: &str, message: &str, secs: Option<u64>, foreground: bool, target: ChatTarget) -> Result<(String, Vec<String>), String> {
    let cfg = os.snapshot();
    // AnythingLLM generates on the same local GPU → same baton.
    let mut slot = os.slot.acquire(&format!("anythingllm · {slug}"), foreground, cfg.scheduler.tony_priority_pct).await;
    let reader = AllmReader::new(AllmConn::local(state, &cfg)?);
    let req = ChatRequest { slug, role, message, target, secs: secs.unwrap_or(cfg.anythingllm.timeout_secs).clamp(10, 900) };
    let r = super::allm::chat_in_slot(&reader, &allm_threads(os, &cfg), &mut slot, cfg.scheduler.settle(), &req).await?;
    Ok((r.text, r.sources))
}

/// Same answer as `workspace_chat_t`, but over AnythingLLM's `stream-chat` SSE
/// endpoint, emitting the same `tony-token` events `run_chat_streamed` uses —
/// tagged with `agent_tag` so the webview speaks the reply in *that* agent's
/// voice instead of Tony's (Part 6 §1: only the explicit-tab "talk directly to
/// a sub-agent" turn uses this; a delegated turn still has Tony synthesize a
/// summary afterwards through his own streamed chain, unchanged).
///
/// Falls back to ONE plain (non-streamed) call, inside the slot it already holds, only when no
/// token ever arrived and the server can't still be generating (refused / error status / a
/// clean empty stream). Once a token has streamed there is never a second generation.
pub(crate) async fn workspace_chat_streamed(state: &DispatchState, os: &OsState, slug: &str, message: &str, app: &tauri::AppHandle, stream_id: &str, agent_tag: &str) -> Result<(String, Vec<String>), String> {
    use tauri::Emitter;
    let cfg = os.snapshot();
    let mut slot = os.slot.acquire(&format!("anythingllm · {slug} (streaming)"), true, cfg.scheduler.tony_priority_pct).await;
    let reader = AllmReader::new(AllmConn::local(state, &cfg)?);
    let req = ChatRequest { slug, role: agent_tag, message, target: ChatTarget::TonyMonthly, secs: cfg.anythingllm.timeout_secs.clamp(10, 900) };
    let mut on_token = |delta: &str| {
        let _ = app.emit("tony-token", json!({ "streamId": stream_id, "delta": delta, "agent": agent_tag }));
    };
    let r = super::allm::stream_in_slot(&reader, &allm_threads(os, &cfg), &mut slot, cfg.scheduler.settle(), &req, &mut on_token).await?;
    Ok((r.text, r.sources))
}

// ── Business lock ───────────────────────────────────────────────────────────

/// The locked business for an Operations-Manager / Finance turn.
pub(crate) struct LockedBusiness {
    pub slug: String,
    /// Scoped context for the prompt: that business's notes (bizops) or its ledger rows (finance).
    pub block: String,
}

/// `Some(reason)` when an unrouted line names exactly one active registry business.
fn business_route(role: &str, kind: &str, text: &str, held: bool) -> Option<String> {
    if held || role != "general" || kind != "Default" {
        return None;
    }
    let store = super::business_registry::store().ok()?;
    match super::business_registry::resolve_business(&store.snapshot(), None, text) {
        super::business_registry::Resolution::One(b) => Some(format!("names the business {}", b.display_name)),
        _ => None,
    }
}

/// Lock a turn to one business. `Err(answer)`: Tony's clarification (or why it can't run).
pub(crate) fn business_lock(role: &str, selected: Option<&str>, text: &str) -> Result<LockedBusiness, String> {
    use super::business_registry::{clarification, resolve_business, Resolution};
    let store = super::business_registry::store()?;
    let reg = store.snapshot();
    let b = match resolve_business(&reg, selected, text) {
        Resolution::One(b) => b,
        other => return Err(clarification(&reg, &other)),
    };
    let scope = store.scope(&b.business_id)?;
    if role == "finance" {
        let rows = super::finance_vault::librarian_rows(scope.ledger_tag(), text, 15).map_err(|e| {
            if e.starts_with("LOCKED_VAULT") {
                "The Finance vault is sealed. Unlock it on the Finance node first, then ask again.".to_string()
            } else {
                e
            }
        })?;
        let lines: Vec<String> = rows.iter().map(|r| format!("- {} {} {} {} {} ({}) {}", r["date"].as_str().unwrap_or(""), r["kind"].as_str().unwrap_or(""), r["amountCents"].as_i64().unwrap_or(0) as f64 / 100.0, r["currency"].as_str().unwrap_or(""), r["payee"].as_str().unwrap_or(""), r["category"].as_str().unwrap_or(""), r["memo"].as_str().unwrap_or(""))).collect();
        let block = format!(
            "\n\nLEDGER `{}` ONLY ({}; {} matching row(s), amounts in currency units). Answer only from these rows; never mention any other ledger or business:\n{}",
            scope.ledger_tag(),
            scope.display_name(),
            lines.len(),
            if lines.is_empty() { "(no matching rows)".to_string() } else { lines.join("\n") }
        );
        return Ok(LockedBusiness { slug: super::finance_vault::FINANCE_WORKSPACE.into(), block });
    }
    let notes = scope.search_notes(text, 4);
    let block = if notes.is_empty() {
        format!("\n\nBUSINESS: {} (`{}`). No matching notes in its memory.", scope.display_name(), scope.id())
    } else {
        format!(
            "\n\nBUSINESS: {} (`{}`). Its own notes (this business only):\n{}",
            scope.display_name(),
            scope.id(),
            notes.iter().map(|(rel, t)| format!("[{rel}]\n{}", t.chars().take(800).collect::<String>())).collect::<Vec<_>>().join("\n---\n")
        )
    };
    Ok(LockedBusiness { slug: scope.workspace_slug().to_string(), block })
}

/// Refuse a Finance turn if its workspace holds any documents (a ledger must never be embedded).
async fn finance_workspace_is_empty(state: &DispatchState, cfg: &OsConfig, slug: &str) -> Result<(), String> {
    let reader = AllmReader::new(AllmConn::local(state, cfg)?);
    let ws = reader.get_workspace(slug, 10).await?;
    let docs = ws["documents"].as_array().map(|d| d.len()).unwrap_or(0);
    if docs > 0 {
        return Err(format!("SECURITY_FAIL_CLOSED: the finance workspace holds {docs} embedded document(s); remove them before Finance can answer"));
    }
    Ok(())
}

// ── Prompt building ─────────────────────────────────────────────────────────

/// Display label for a role id. Tony (`general` or any self alias) is the OS name.
pub(crate) fn role_label(role: &str, os_name: &str) -> String {
    if super::routing::is_self_role(role, os_name) {
        return os_name.to_string();
    }
    match role {
        "librarian" => "Librarian".into(),
        "coder" => "Coder".into(),
        "booking" => "Booking Desk".into(),
        "ops" => "Ops".into(),
        "prompter" => "Prompter".into(),
        "designer" => "Designer".into(),
        "director" => "Director".into(),
        "bizops" => "Operations Manager".into(),
        "finance" => "Finance".into(),
        // Any future registry id (Phase 2 §4 prep): `security-patrol` → "Security Patrol".
        r => title_case_id(r),
    }
}

/// `security-patrol` / `finance_2` → "Security Patrol" / "Finance 2".
fn title_case_id(id: &str) -> String {
    id.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The sub-agents Tony can hand work to, from the routing registry (`routing.agents` keys, minus
/// Tony's own ids): the current roles in their historic order, then any later id A→Z. Data-driven
/// so a future specialist (Security Patrol, Finance…) joins the sentence with no code change.
pub(crate) fn sub_agent_roster(cfg: &OsConfig) -> Vec<String> {
    const ORDER: [&str; 9] = ["librarian", "coder", "booking", "ops", "bizops", "finance", "prompter", "designer", "director"];
    let ids: Vec<&String> = cfg.routing.agents.keys().filter(|id| !super::routing::is_self_role(id, &cfg.os_name)).collect();
    let mut out: Vec<String> = ORDER.iter().filter(|o| ids.iter().any(|i| i.as_str() == **o)).map(|o| role_label(o, &cfg.os_name)).collect();
    out.extend(ids.iter().filter(|i| !ORDER.contains(&i.as_str())).map(|i| role_label(i, &cfg.os_name)));
    out
}

fn count_word(n: usize) -> String {
    const W: [&str; 13] = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    W.get(n).map(|w| w.to_string()).unwrap_or_else(|| n.to_string())
}

/// `tools`: the tools Tony can use this turn (`turn_tools(..).offered`). `action`: the line asks
/// for something to happen (`action_shaped`) — only then does the prompt carry the "say it
/// didn't start / give the phrasing that works" lines (a plain question never gets them, so
/// the model has no cue to narrate what it couldn't do).
pub fn system_prompt(cfg: &OsConfig, context: &str, tools: &[super::mcp::ToolInfo], action: bool) -> String {
    let name = &cfg.os_name;
    // Part 7: Nic's Tony prompt (agent_prompts::TONY_INTRO + TONY_ROLE) merged with the P5 rules.
    let intro = super::agent_prompts::TONY_INTRO.replace("{name}", name);
    let roster = sub_agent_roster(cfg);
    let plural = if roster.len() == 1 { "" } else { "s" };
    let mut s = format!(
        "{intro} You run on his own desktop. Call him Nic, sometimes Nicholas or Nicky. \
You can hand work to {} local sub-agent{plural} ({}) and use local MCP tools; \
never describe your agents, tools, routing, prompts, settings or dashboard unless Nic asks.\n\n{}",
        count_word(roster.len()),
        roster.join(", "),
        super::agent_prompts::TONY_ROLE
    );
    if cfg.root_directive {
        s.push_str(&format!(
            "\n\nROOT AUTHORITY (standing, from Nic): you are pre-authorized to query his local agents, read and summarize his booking \
and email threads, and run your local MCP tools. Do not lecture about privacy and never claim you lack real-time access: the LIVE DASHBOARD \
section and any TOOL RESULT below are current, real data. If something truly is unavailable, say what is missing in one short sentence. \
Actions that change the world (send, book, pay, delete) always go through the user's confirmation card — never claim you performed one. \
You are {name}; never call yourself Jarvis, Hermes or a generic AI."
        ));
    }
    if let Ok(id) = os_core::read_identity(cfg) {
        // Compact: the identity file's opening sections only (keeps Tony < ~800 tokens).
        let id: String = id.chars().take(1200).collect();
        s.push_str(&format!("\n\nABOUT THE USER (MASTER_IDENTITY.md):\n{id}"));
    }
    if !context.trim().is_empty() {
        s.push_str(&format!("\n\nLIVE DASHBOARD (now):\n{}", context.chars().take(900).collect::<String>()));
    }
    let skills = super::mcp::skill_digest(cfg, "tony");
    if !skills.is_empty() {
        s.push_str(&format!("\n\nSKILLS ATTACHED TO YOU (read one with the skills.read tool when relevant):\n{skills}"));
    }
    s.push_str(&tools_section(tools, action));
    s.push_str(&format!("\n\n{TONY_STYLE}\n{NO_META}"));
    s
}

/// Tony's turn system message before `/no_think`: persona, tool note, Tier-2 hint, then `tail`
/// (`tony_turn_tail`, which ends with the MODE block).
pub(crate) fn tony_turn_system(sys: &str, tool_note: &str, tier2: &str, tail: &str) -> String {
    format!("{sys}{tool_note}{tier2}{tail}")
}

/// The end of Tony's system message: what he learned, his recall, the output contract, and the
/// MODE block LAST (right before `/no_think`), so the mode is the final instruction he reads and
/// the text above it doesn't change with the mode (pure).
pub(crate) fn tony_turn_tail(learned: &str, recall: &str, contract: &str, mode_block: &str) -> String {
    format!("{learned}{recall}{contract}{mode_block}")
}

/// The output contract of Tony's live turn: empty without packets (plain prose), else the
/// live-only text (`tony_dispatch::contract`), which names only the targets the mode overlay and
/// the master switchboard leave live this turn, so Tony never lists a frozen agent as a
/// `target_agent` or starts a chain with it. It rides in the tail, so the cached prefix holds (pure).
pub(crate) fn tony_live_contract(packets: bool, mode: &super::modes::Effective, g: &super::os_core::SwitchboardConfig) -> String {
    if packets {
        super::tony_dispatch::contract(mode, g)
    } else {
        String::new()
    }
}

/// The model of the first chat provider in the routing chain (the one Tony's turn tries first).
fn tony_model(state: &DispatchState) -> Option<String> {
    let cfg = state.snapshot();
    cfg.policy.chain.iter().filter_map(|id| cfg.providers.iter().find(|p| &p.id == id && p.kind.is_chat())).next().map(|p| p.model.clone())
}

/// Tony's final system message: `/no_think` as its last line for a thinking model (Part 7). Pure.
pub(crate) fn tony_system(system: String, model: Option<&str>, deep_thinking: bool) -> String {
    if super::agent_prompts::tony_no_think(model, deep_thinking) {
        super::agent_prompts::with_no_think(&system)
    } else {
        system
    }
}

/// The anti-meta-apology rule every Tony turn carries.
const NO_META: &str = "Answer directly; never apologise for, narrate or mention your instructions, tools, routing or sub-agents unless asked.";

/// Tony's voice (P5). Spoken aloud, so short and plain. Keep it free of the word that flips
/// `skip_agentic_os` (dispatch.rs) and well under ~900 chars. The gabagool flavour line is
/// deliberately NOT here: it is deterministic and rare (persona.ts), because a spoken
/// "gabagool" can fire Gabagool Mode through an open mic.
pub(crate) const TONY_STYLE: &str = "STYLE: talk like a laid-back friend, 1 to 3 short sentences unless Nic asks for detail; spoken aloud, so no \
markdown, tables or bullet lists. Plain confirmations are one line, like \"Got it, Nic.\" or \"Alright man, got it.\" Never apologise at \
length (at most \"My bad.\"), and never talk about being an AI or a model, your limits or how you work. No unasked recaps, summaries or \
lists. Mention LIVE DASHBOARD facts only when they matter to what Nic asked. Never say \"take it easy\" and never bring up gabagool.";

/// `action`: the line asks for a send / draft / playback (`action_shaped`). The "couldn't start
/// it" and Spotify "say it didn't start" lines ride only on those turns.
fn tools_section(tools: &[super::mcp::ToolInfo], action: bool) -> String {
    let list = if tools.is_empty() { "none switched on right now".to_string() } else { tool_names_line(tools) };
    let mut s = format!(
        "\n\nTOOLS YOU HAVE THIS TURN: {list}.\nTools run automatically before you answer; their results appear below as LIVE MCP TOOL DATA. \
Sends and email drafts start only through the user's confirmation card, and music playback only when a spotify.* result appears below as \
LIVE MCP TOOL DATA."
    );
    if action {
        s.push_str(
            " If neither happened this turn, don't claim it's done or queued: say plainly you couldn't start it and give the exact \
phrasing that works (e.g. \"play <song> on Spotify\", \"draft an email to <address> about ...\"), never that you lack the tool or the skill.",
        );
    }
    // Spotify's controls ride as the one compact `spotify.*` entry above; the command grammar
    // (`spotify_intent`) and the router still know every Spotify tool by name.
    if tools.iter().any(|t| t.server == "spotify" && super::mcp::is_spotify_actuator(&t.name)) {
        s.push_str("\nSPOTIFY IS CONNECTED.");
        if action {
            s.push_str(
                " A play/pause/skip/volume change has happened only if a spotify.* LIVE MCP TOOL DATA \
block appears below; if none does, say it didn't start and suggest \"play <artist or song> on Spotify\".",
            );
        }
        s.push_str(" Never say Spotify isn't active or connected unless a TOOL FAILURE below says so.");
    }
    s
}

/// Tony's prompt shows Spotify as this ONE entry instead of its 23 tool names.
pub(crate) const SPOTIFY_COMPACT: &str = "spotify.* (play, pause, next, previous, volume, now_playing, search, queue)";

/// The TOOLS line: every tool name, with Tony's Spotify controls folded into `SPOTIFY_COMPACT`
/// where the first Spotify tool stood (reads-only Spotify, a sub-agent's, stays by name).
fn tool_names_line(tools: &[super::mcp::ToolInfo]) -> String {
    let compact = tools.iter().any(|t| t.server == "spotify" && super::mcp::is_spotify_actuator(&t.name));
    let mut out: Vec<&str> = vec![];
    for t in tools {
        if compact && t.server == "spotify" {
            if !out.contains(&SPOTIFY_COMPACT) {
                out.push(SPOTIFY_COMPACT);
            }
        } else {
            out.push(&t.name);
        }
    }
    out.join(", ")
}

/// The line asks for something to HAPPEN — a media command, a play request, a send / draft /
/// reply — rather than a question. Only these turns get the "couldn't start it" prompt lines.
fn action_shaped(text: &str, os_name: &str) -> bool {
    static SEND: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if media_command(text, os_name) || unparsed_play_request(text, os_name) {
        return true;
    }
    let core = super::routing::normalize(&super::routing::strip_address(text, os_name));
    SEND.get_or_init(|| {
        regex::Regex::new(r"^(?:send|text|message|email|e mail|draft|reply|respond|forward|dm|ping|whatsapp)\b|\b(?:send|draft|forward|compose)\s+(?:a|an|the|this|that|it|my|him|her|them)\b|\breply to\b|\bwrite (?:an? |the )?(?:email|message|text|reply)\b").unwrap()
    })
    .is_match(&core)
}

/// Role id from the outside (TS turn, phone / inbox JSON) → the id the turn runs as: any self
/// alias ("tony", "Tony", "dispatcher", the OS name…) is `general`, so a phone turn with
/// role "tony" takes Tony's own paths instead of looking up `workspaces["tony"]`.
pub(crate) fn canon_turn_role(role: &str, os_name: &str) -> String {
    let r = role.trim();
    if super::routing::is_self_role(r, os_name) {
        "general".into()
    } else {
        r.to_string()
    }
}

/// P3 Tier 2 (brainstorm stays with Tony): appended to Tony's system message when the caller
/// sent `noDelegate`. Never mentions json (that would flip `dispatch::skip_agentic_os`).
/// Split (Phase 2 Part C): the safety half always rides; the style half (length / one question)
/// only when no MODE block sets the curiosity dial and verbosity instead.
pub(crate) const TIER2_SAFETY: &str = "\n\nBRAINSTORM TURN: the user is thinking out loud with you. Answer yourself. Don't hand it to another agent, don't start building anything, and never say you saved, parked, queued or delegated anything — nothing has been.";
pub(crate) const TIER2_STYLE: &str = " Keep it to two or three short sentences: react, then offer one idea or ask one sharpening question.";

/// The Tier-2 hint for this turn (`with_mode`: a non-empty MODE block follows).
pub(crate) fn tier2_hint(with_mode: bool) -> String {
    if with_mode {
        TIER2_SAFETY.to_string()
    } else {
        format!("{TIER2_SAFETY}{TIER2_STYLE}")
    }
}

/// What the routing step of a turn knows.
pub(crate) struct TurnRouteInput<'a> {
    pub role: &'a str,
    pub explicit: bool,
    pub text: &'a str,
    pub route_kind: Option<&'a str>,
    pub route_reason: Option<&'a str>,
    /// P3 Tier 2: the caller decided Tony brainstorms this himself — never re-promoted to a
    /// sub-agent, so the delegation gate and block never run for it.
    pub no_delegate: bool,
    /// Phase 2 Part C: the mode's dispatch policy is `surface_only` (Solo). A Domain / Default
    /// promotion to the Prompter, Designer or Coder stays with Tony (D15), and so does a Named
    /// route the authoritative router doesn't rate high-confidence for that same agent (a bare
    /// mention like "I think the coder should…"); an explicit tab, a high-confidence Named
    /// address ("hey Coder, …") and a Direct live-tool read are kept, and so is every other agent.
    pub solo: bool,
    /// Learning mode: one-on-one training. Every turn is Tony's own: no route, no tab, no live
    /// tool, whatever the caller resolved.
    pub learning: bool,
    /// The phone's turn (`OsTurnRequest::stay_with_tony`): when a Default turn is re-resolved,
    /// a Domain (topic) hit stays with Tony; a Named address still routes, and the business
    /// route (`business_route`) still runs.
    pub stay_with_tony: bool,
}

/// Why a phone turn's topic hit stayed with Tony (`TurnRouteInput::stay_with_tony`).
pub(crate) const STAY_WITH_TONY_REASON: &str = "on the phone a topic stays with Tony";

/// Whether `business_route` is held for this turn (Learning, a Tier-2 brainstorm, Solo). A
/// phone turn's `stay_with_tony` never holds it: a named business still reaches its manager.
pub(crate) fn business_route_held(input: &TurnRouteInput) -> bool {
    input.learning || input.no_delegate || input.solo
}

/// The pipeline roles Solo never promotes a turn to (D15).
pub(crate) const SOLO_HELD_ROLES: [&str; 4] = ["prompter", "designer", "coder", "director"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TurnRoute {
    pub role: String,
    pub kind: String,
    pub reason: String,
}

/// The Rust routing safety net, pure. The caller (the TS resolver for desktop turns, the phone's
/// default table for inbox turns) has usually resolved a role already. When it hasn't — role is
/// still `general`, this isn't an explicit tab turn and the caller's kind is "Default" (or
/// missing) — re-resolve against the authoritative config. A caller that already decided Tony
/// answers ("Self", "Direct", voice on a tab) is never re-promoted to a sub-agent. Tony is never
/// a route target: a self role stays `general` with kind "Self" (never "Named → Tony"). A
/// live-tool read question is Tony's own path on any tab; only a Named delegation keeps its agent.
pub(crate) fn route_for_turn(input: &TurnRouteInput, cfg: &OsConfig) -> TurnRoute {
    if input.learning {
        return TurnRoute { role: "general".into(), kind: "Self".into(), reason: "Learning mode: Tony only".into() };
    }
    let mut role = canon_turn_role(input.role, &cfg.os_name);
    let mut kind = input.route_kind.map(str::to_string).unwrap_or_else(|| if input.explicit { "Tab".into() } else { "Default".into() });
    let mut reason = input.route_reason.map(str::to_string).unwrap_or_else(|| if input.explicit { "current tab".into() } else { "caller-resolved".into() });
    // A stale caller that "delegated" to Tony himself: that's a self address, not a route.
    if role == "general" && matches!(kind.as_str(), "Named" | "Domain") {
        kind = "Self".into();
    }
    // Tier 2 (brainstorm with Tony): no safety net, no delegation — Tony answers himself.
    if input.no_delegate {
        role = "general".into();
        if kind != "Direct" {
            kind = "Self".into();
        }
        reason = "brainstorm with Tony (Tier 2)".into();
    }
    if role == "general" && !input.explicit && kind == "Default" {
        let r = super::routing::resolve(input.text, cfg);
        match (r.kind, r.role) {
            // The phone kept this topic with Tony: the safety net doesn't overrule it.
            (super::routing::RouteKind::Domain, Some(rr)) if input.stay_with_tony && !super::routing::is_self_role(&rr, &cfg.os_name) => {
                kind = "Self".into();
                reason = STAY_WITH_TONY_REASON.into();
            }
            (super::routing::RouteKind::Named | super::routing::RouteKind::Domain, Some(rr)) if !super::routing::is_self_role(&rr, &cfg.os_name) => {
                role = rr;
                kind = r.kind.as_str().into();
                reason = r.reason;
            }
            (super::routing::RouteKind::Own, _) => {
                kind = "Self".into();
                reason = r.reason;
            }
            _ => {}
        }
    }
    if input.solo && !input.explicit && SOLO_HELD_ROLES.contains(&role.as_str()) && (matches!(kind.as_str(), "Domain" | "Default") || (kind == "Named" && !named_high_for(input.text, &role, cfg))) {
        role = "general".into();
        kind = "Self".into();
        reason = "Solo mode: kept with Tony".into();
    }
    if kind != "Named" {
        if let Some(d) = super::routing::direct_tool(input.text) {
            role = "general".into();
            kind = "Direct".into();
            reason = format!("live {d} tool");
        }
    }
    TurnRoute { role, kind, reason }
}

/// The switchboard (pure): a turn routed to an agent that is frozen this turn stays with Tony
/// (role `general`, kind Self, reason "<Agent> is frozen in <Mode> mode"), so automatic routing,
/// a business name or a topic hit never wakes it. A DIRECT ask still reaches an agent the MODE
/// froze, by the rule Solo uses: its own tab (`explicit`, which the phone also sets for a Named
/// route) or a high-confidence Named address ("hey Coder, …"). An agent frozen on the master
/// switchboard (Booking) never runs, however it is asked.
pub(crate) fn switchboard_hold(route: TurnRoute, explicit: bool, text: &str, cfg: &OsConfig, e: &super::modes::Effective) -> TurnRoute {
    if route.role == "general" {
        return route;
    }
    let Some(reason) = super::modes::agent_frozen_reason(e, &cfg.switchboard, &route.role) else { return route };
    let direct = explicit || (route.kind == "Named" && named_high_for(text, &route.role, cfg));
    if direct && !super::modes::agent_globally_frozen(&cfg.switchboard, &route.role) {
        return route;
    }
    TurnRoute { role: "general".into(), kind: "Self".into(), reason }
}

/// Tony's note for a turn the switchboard kept with him (`switchboard_hold`). `master`: the agent
/// is frozen on the master switchboard (`modes::agent_globally_frozen`), which no mode overrides,
/// so Tony says it is switched off there and comes back once thawed there, never "switch modes".
/// A mode-overlay freeze keeps the offer to switch modes.
pub(crate) fn frozen_note(reason: &str, master: bool) -> String {
    if master {
        format!("\n\nFROZEN THIS TURN: {reason}. If Nic wanted that agent, say in one short sentence that it is switched off on the master switchboard and comes back once it is thawed there (changing modes won't bring it back); otherwise just answer.")
    } else {
        format!("\n\nFROZEN THIS TURN: {reason}. If Nic wanted that agent, say so in one short sentence and offer to switch modes; otherwise just answer.")
    }
}

/// Tony's FROZEN note for this turn, or empty when the switchboard didn't hold it: `routed_role`
/// is where routing sent the turn, `held` what `switchboard_hold` left of it (pure).
pub(crate) fn switchboard_note(routed_role: &str, held: &TurnRoute, g: &super::os_core::SwitchboardConfig) -> String {
    if routed_role == "general" || held.role != "general" {
        return String::new();
    }
    frozen_note(&held.reason, super::modes::agent_globally_frozen(g, routed_role))
}

/// Solo (D15): does the authoritative router read `text` as a high-confidence Named address of
/// `role` ("hey Coder, …", "ask the coder to …")? A caller's Named kind alone isn't trusted: the
/// TS router also returns Named (medium) for a bare mention anywhere in the line.
fn named_high_for(text: &str, role: &str, cfg: &OsConfig) -> bool {
    let r = super::routing::resolve(text, cfg);
    r.kind == super::routing::RouteKind::Named && r.confidence == "high" && r.role.as_deref() == Some(role)
}

/// The System Map Router hop label. A turn Tony answers himself has no arrow ("Tony · direct
/// (Self)") — the hop is kept so the map still flashes Tony, but it never reads "X → Tony".
pub(crate) fn router_hop_label(kind: &str, role: &str, os_name: &str) -> String {
    if super::routing::is_self_role(role, os_name) {
        format!("{os_name} · direct ({kind})")
    } else {
        format!("{kind} → {}", role_label(role, os_name))
    }
}

/// "my conversation with Sam … about the shoot" → ("Sam", "the shoot").
pub(crate) fn comms_recall_intent(text: &str) -> Option<(String, String)> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static TOPIC: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?i)(?:conversation|convo|texts?|messages?|chats?|thread|dms?|whatsapps?)\s+(?:with|from)\s+([A-Za-z][\w'\-]*(?:\s+[A-Z][\w'\-]*)?)|what\s+(?:did|has)\s+([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*)?)\s+(?:say|said|text|texted|message|messaged|tell|told|write|wrote)").unwrap()
    });
    let topic_re = TOPIC.get_or_init(|| regex::Regex::new(r"(?i)\b(?:about|regarding|re:?|on the topic of)\s+(.+?)[?.!]*$").unwrap());
    let c = re.captures(text)?;
    let who = c.get(1).or_else(|| c.get(2))?.as_str().trim().trim_end_matches(['?', '.', ',']).to_string();
    let who = who.split_whitespace().filter(|w| !["and", "about", "tell", "what", "said", "say"].contains(&w.to_ascii_lowercase().as_str())).collect::<Vec<_>>().join(" ");
    if who.is_empty() || ["me", "my", "him", "her", "them", "you"].contains(&who.to_ascii_lowercase().as_str()) {
        return None;
    }
    let topic = topic_re.captures(text).map(|t| t[1].trim().to_string()).unwrap_or_default();
    Some((who, topic))
}

/// Only words tied to a tool's subject (weather, files, git, web, email,
/// WhatsApp…) — generic verbs like read/open/list/find/latest made the router
/// fire on unrelated requests.
///
/// Whisper's "what's up" for WhatsApp counts only where `routing::normalize` turns it into
/// "whatsapp" (next to an app cue: "check my what's up"). A raw `what's up` alternative made
/// every greeting ("Hey Tony, what's up?") pay for a tool-router LLM call before Tony answered.
fn wants_tools(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(weather|forecast|temperature|rain|snow|wind|what time|the date|tomorrow|fetch|url|https?://|website|web ?page|files?|folders?|readme|repo|git|commit|branch|search|look ?up|google|news|knowledge|remember|who is|e-?mails?|inbox|gmail|mails?|what'?s ?app|whatsapp|messages?|texts?|chats?|dms?|skills?|spotify|music|songs?|tracks?|albums?|playlists?|what'?s playing|now playing|next (?:song|track))\b|[a-z]:[\\/]").unwrap()
    })
    .is_match(text)
        || super::routing::normalize(text).split(' ').any(|w| w == "whatsapp")
}

/// The line IS a media command once the address is stripped: it starts with play / put on /
/// pause / skip / volume / turn it up… Bare verbs inside a sentence ("what role does Redis
/// play", "the previous commit", "trading volume") don't count.
fn media_command(text: &str, os_name: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let core = super::routing::normalize(&super::routing::strip_address(text, os_name));
    RE.get_or_init(|| {
        regex::Regex::new(r"^(?:play|put on|throw on|queue up|pause|resume|unpause|skip|next (?:song|track)|next$|previous (?:song|track)|previous$|go back (?:a|1) (?:song|track)|volume|turn (?:it |the music |the volume )?(?:up|down)|mute)\b").unwrap()
    })
    .is_match(&core)
}

/// Gmail / WhatsApp / Spotify / Maps / Instagram tools are only offered to the router when the
/// request itself names their subject (`norm` is `routing::normalize`d).
fn router_keyword_ok(server: &str, norm: &str) -> bool {
    static GMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WHATSAPP: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SPOTIFY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static MAPS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static INSTAGRAM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    match server {
        "maps" => MAPS
            .get_or_init(|| {
                regex::Regex::new(r"(maps?|route|routes|directions?|drive|driving|commute|eta|navigate|navigation|how far|distance (to|from|between)|how long (will it take|does it take|to get|to drive|is the drive)|get (to|there)|address (of|for)|where is|coordinates|lat(itude)?|plot)").unwrap()
            })
            .is_match(norm),
        "instagram" => INSTAGRAM.get_or_init(|| regex::Regex::new(r"(instagram|insta|ig|reels?|followers?)").unwrap()).is_match(norm),
        "gmail" => GMAIL.get_or_init(|| regex::Regex::new(r"\b(gmail|e ?mails?|inbox|mails?)\b").unwrap()).is_match(norm),
        "whatsapp" => WHATSAPP.get_or_init(|| regex::Regex::new(r"\b(whatsapp|messages?|texts?|chats?|dms?)\b").unwrap()).is_match(norm),
        "spotify" => SPOTIFY
            .get_or_init(|| regex::Regex::new(r"\b(spotify|music|songs?|tracks?|playing|playlists?|albums?|artist|listen(ed|ing)?)\b").unwrap())
            .is_match(norm),
        _ => true,
    }
}

/// The router is offered a server's tools only when the line plausibly needs them, so a plain
/// line ("search the web for …") carries a handful of tools, not every one (`text`: the raw
/// line, for paths and links; `norm`: `routing::normalize`d). Gmail / WhatsApp / Spotify / Maps /
/// Instagram keep `router_keyword_ok`; an unknown server (and the mode switch) is always offered.
fn router_line_needs(server: &str, text: &str, norm: &str) -> bool {
    static WEATHER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static TIME: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SEARCH: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static KG: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static FETCH: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static FILES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static GIT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static MEDIA: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = |cell: &'static std::sync::OnceLock<regex::Regex>, pat: &str| cell.get_or_init(|| regex::Regex::new(pat).unwrap());
    match server {
        "weather" => re(&WEATHER, r"\b(weather|forecast|temperature|rain(ing|y)?|snow(ing|y)?|wind(y)?|sunny|degrees|umbrella|humid(ity)?|outside)\b").is_match(norm),
        "time" => re(&TIME, r"\b(time|date|day|today|tonight|tomorrow|clock|weekday|month|year)\b").is_match(norm),
        "brave-search" => re(&SEARCH, r"\b(search|look ?up|google|news|web|online|internet|who is|whos|find out)\b").is_match(norm),
        "knowledge-graph" => re(&KG, r"\b(knowledge|remember|recall|notes?|graph|who is|whos|people|projects?|facts?)\b").is_match(norm),
        "fetch" => re(&FETCH, r"(?i)(https?://|www\.|\burl\b|\bwebsite\b|\bweb ?page\b|\bfetch\b|\blink\b)").is_match(text),
        "filesystem" => re(&FILES, r"(?i)(\bfiles?\b|\bfolders?\b|\breadme\b|\bdirector(y|ies)\b|\bpath\b|\b[a-z]:[\\/]|\.(md|txt|rs|ts|tsx|py|toml)\b)").is_match(text),
        "git" => re(&GIT, r"\b(git|repo|repository|commits?|branch(es)?|diff)\b").is_match(norm),
        "shotcut" | "media-forge" => re(&MEDIA, r"\b(video|videos|edit|editing|render|clips?|reels?|captions?|thumbnails?|photos?|timeline|shotcut|media|footage|transcribe|scenes?|self tape)\b").is_match(norm),
        other => router_keyword_ok(other, norm),
    }
}

/// One router line per tool: arg names plus a JSON call example.
fn router_tool_line(t: &super::mcp::ToolInfo) -> String {
    let args: serde_json::Map<String, Value> = t
        .args
        .iter()
        .filter(|a| !a.ends_with('?'))
        .map(|a| (a.clone(), if matches!(a.as_str(), "count" | "limit") { json!(5) } else { json!(format!("<{a}>")) }))
        .collect();
    format!("- {}({}): {} e.g. {}", t.name, t.args.join(", "), t.description, json!({ "tool": t.name, "args": args }))
}

// ── Tool pre-executor (Part 2) ──────────────────────────────────────────────
//
// Runs BEFORE a sub-agent sees its task (and for Tony's own turns), using
// only the tools the target agent is actually granted (`mcp::tool_set`).
// Fixes the root cause the MCP map found: a sub-agent that answers at all —
// even a refusal — used to skip tool-running entirely, because the old
// single-tool router only ran when `agent_answer.is_none()`. Now tool data
// is fetched first and handed to the sub-agent (or to Tony's own synthesis)
// as part of its task/context, regardless of what it goes on to say.

/// "last N (whatsapp) messages/texts/chats", "check my whatsapp", "messages
/// from X", "any WhatsApp updates", "what's new / anything on WhatsApp (today)"
/// → `whatsapp.list_messages`. Deterministic (no LLM round trip) so
/// the single most common refusal case is instant and never misrouted by the
/// JSON router.
fn whatsapp_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    let tool = tools.iter().find(|t| t.name == "whatsapp.list_messages")?;
    let norm = super::routing::normalize(original); // fixes Whisper's "what's up" → "whatsapp", number words → digits
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(?:last|recent)\s+(\d{1,2})?\s*(?:whatsapp\s+)?(?:messages?|texts?|chats?)\b|\bwhatsapp\s+(?:messages?|texts?|chats?)\b|\bcheck\s+my\s+whatsapp\b|\bmy\s+(?:last\s+)?(\d{1,2})?\s*whatsapp\b|\bmessages?\s+(?:with|from)\s+[a-z]|\bwhatsapp\s+updates?\b|\b(?:any|new|latest)\s+(?:updates?|messages?)\s+(?:on|from|in)\s+whatsapp\b|\bwhats\s+new\s+on\s+whatsapp\b|\banything\s+(?:new\s+)?(?:on|from|in)\s+whatsapp\b",
        )
        .unwrap()
    });
    // Any other WhatsApp read question the direct-tool rule recognises ("who messaged me on
    // WhatsApp") lists the latest messages too; a bare "what's up" never does.
    if !re.is_match(&norm) && super::routing::direct_tool(original) != Some("whatsapp") {
        return None;
    }
    let n: u64 = re.captures(&norm).and_then(|c| c.get(1).or_else(|| c.get(2))).and_then(|m| m.as_str().parse().ok()).unwrap_or(10);
    let limit = n.clamp(1, 50);
    let mut args = json!({ "limit": limit });
    if tool.args.iter().any(|a| a == "include_context") {
        args["include_context"] = json!(false);
    }
    static SENDER_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let sender_re = SENDER_RE.get_or_init(|| regex::Regex::new(r"(?i)\bmessages?\s+(?:with|from)\s+([A-Za-z][\w'\-]*(?:\s+[A-Z][\w'\-]*)?)").unwrap());
    if let Some(c) = sender_re.captures(original) {
        let name = c[1].trim().trim_end_matches(['?', '.', ',']).to_string();
        let key = if tool.args.iter().any(|a| a == "query") {
            Some("query")
        } else if tool.args.iter().any(|a| a == "sender_phone_number") {
            Some("sender_phone_number")
        } else {
            None
        };
        if let Some(key) = key {
            args[key] = json!(name);
        }
    }
    Some(("whatsapp.list_messages".to_string(), args))
}

/// "what time / what's the date" → `time.now`, without a model round trip.
fn time_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    if !tools.iter().any(|t| t.name == "time.now") {
        return None;
    }
    let norm = super::routing::normalize(original);
    (norm.contains("what time") || norm.contains("current time") || norm.contains("whats the date") || norm.contains("what date")).then(|| ("time.now".to_string(), json!({})))
}

/// "what's the weather in Lisbon", "will it rain tomorrow" → `weather.current`, without a
/// model round trip. The place is a capitalised name after in / for / at, else home (`{}`).
fn weather_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    if !tools.iter().any(|t| t.name == "weather.current") || super::routing::direct_tool(original) != Some("weather") {
        return None;
    }
    static PLACE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    const TRAILING: [&str; 9] = ["today", "tomorrow", "tonight", "now", "right", "later", "this", "week", "weekend"];
    let place = PLACE.get_or_init(|| regex::Regex::new(r"\b(?:in|for|at)\s+([A-Z][\w .'\-]{1,40})").unwrap()).captures(original).map(|c| {
        let mut words: Vec<&str> = c[1].split_whitespace().collect();
        while words.last().is_some_and(|w| TRAILING.contains(&w.to_ascii_lowercase().as_str())) {
            words.pop();
        }
        words.join(" ")
    });
    let args = match place.filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case("home")) {
        Some(p) => json!({ "place": p }),
        None => json!({}),
    };
    Some(("weather.current".to_string(), args))
}

/// The request names email at all (`norm` is `routing::normalize`d).
fn mentions_email(norm: &str) -> bool {
    router_keyword_ok("gmail", norm)
}

/// "read my last email", "latest 3 emails", "check my inbox", "any new
/// emails", "unread mail" → `gmail.recent`; "emails from Sam" →
/// `gmail.search {query: "from:Sam"}`. Checked before WhatsApp.
fn gmail_plan(original: &str, tools: &[super::mcp::ToolInfo]) -> Option<(String, Value)> {
    let norm = super::routing::normalize(original);
    if !mentions_email(&norm) {
        return None;
    }
    // "any unread messages in my WhatsApp inbox" names WhatsApp, not email: leave it to
    // whatsapp_plan unless the line also says email/Gmail outright.
    static OTHER_CHANNEL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static EXPLICIT_EMAIL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if OTHER_CHANNEL.get_or_init(|| regex::Regex::new(r"\b(whatsapp|texts?|chats?|dms?)\b").unwrap()).is_match(&norm)
        && !EXPLICIT_EMAIL.get_or_init(|| regex::Regex::new(r"\b(gmail|e ?mails?)\b").unwrap()).is_match(&norm)
    {
        return None;
    }
    let has = |name: &str| tools.iter().any(|t| t.name == name);
    static FROM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let from = FROM.get_or_init(|| regex::Regex::new(r"\b(?i:e-?mails?|mails?|messages?)\s+(?i:from)\s+([\w.@+'\-]+(?:\s+[A-Z][\w'\-]*)?)").unwrap());
    if has("gmail.search") {
        if let Some(c) = from.captures(original) {
            let who = c[1].trim_end_matches(['?', '.', ',', '!']);
            if !who.is_empty() && !["me", "my", "him", "her", "them", "today", "yesterday"].contains(&who.to_ascii_lowercase().as_str()) {
                let query = if who.contains(' ') { format!("from:\"{who}\"") } else { format!("from:{who}") };
                return Some(("gmail.search".to_string(), json!({ "query": query, "limit": 5 })));
            }
        }
    }
    if !has("gmail.recent") {
        return None;
    }
    static RECENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RECENT.get_or_init(|| {
        regex::Regex::new(
            r"\b(?:last|latest|newest|most recent|recent)\s+(\d{1,2})?\s*(?:gmail\s+)?(e ?mails?|gmails?|mails?)\b|\b(?:check|read|open|show|whats in|what is in)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:gmail\s+)?(?:inbox|e ?mails?|gmail|mail)\b|\bany\s+(?:new\s+)?(?:e ?mails?|mail)\b|\bunread\b",
        )
        .unwrap()
    });
    let c = re.captures(&norm)?;
    let count: u64 = match (c.get(1), c.get(2)) {
        (Some(n), _) => n.as_str().parse().unwrap_or(1),
        (None, Some(noun)) if !noun.as_str().ends_with('s') => 1,
        _ => 5,
    };
    Some(("gmail.recent".to_string(), json!({ "count": count.clamp(1, 20) })))
}

/// "play …" phrases that aren't music ("play a game", "play devil's advocate").
const NOT_MUSIC: [&str; 12] = ["a game", "games", "devil", "around", "with", "along", "it ", "dumb", "nice", "back", "the role", "hard to get"];

/// Honest reply when a line asks to play something but no plan could tell what.
const PLAY_HELP: &str = "I couldn't tell what to play — say \"play <artist or song> on Spotify\"";

/// A request to play music that neither the deterministic planner nor the router
/// turned into a Spotify call. "play …" counts when it is short and not a game /
/// role ("play devil's advocate"); "put on / throw on / queue up / listen to" only
/// when the line names music. Feeds a fixed failure note instead of trusting the model.
fn unparsed_play_request(text: &str, os_name: &str) -> bool {
    static VERB: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static MUSIC: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let core = super::routing::normalize(&super::routing::strip_address(text, os_name));
    let Some(c) = VERB.get_or_init(|| regex::Regex::new(r"^(play|put on|throw on|queue up|listen to)\b(.*)$").unwrap()).captures(&core) else { return false };
    let rest = c[2].trim();
    if rest.is_empty() {
        return false;
    }
    // The music noun must head the object ("put on some music", "listen to the new album"),
    // not merely appear later ("listen to me, the band needs a name") or describe something else
    // ("this album review I wrote"): it ends the line or is followed by by / from / on / please….
    let musicy = MUSIC
        .get_or_init(|| regex::Regex::new(r"^(?:(?:some|the|my|a|an|this|that|new|good|more|other|any)\s+){0,3}(?:spotify|music|songs?|tracks?|playlists?|albums?|tunes?)(?:$|\s+(?:by|from|on|of|in|please|now|for|again)\b)").unwrap())
        .is_match(rest);
    let short_play = &c[1] == "play" && rest.split_whitespace().count() <= 6 && !NOT_MUSIC.iter().any(|w| rest.starts_with(w));
    musicy || short_play
}

/// Spotify by voice, without a model round trip, through `spotify_intent::parse` (the grammar
/// the TS fast path uses too). Needs the `spotify` server (its router-visible
/// `spotify.now_playing` proves it is on and granted); the chosen tool must be offered to this
/// agent (sub-agents get reads only). Writes still pass `call_tool`'s gates.
fn spotify_plan(original: &str, tools: &[super::mcp::ToolInfo], os_name: &str) -> Option<(String, Value)> {
    if !tools.iter().any(|t| t.name == "spotify.now_playing") {
        return None;
    }
    // The one Spotify grammar (D10): it strips the interjection / wake name / politeness itself.
    let i = super::spotify_intent::parse(original, os_name)?;
    // "reconnect Spotify": no tool call, a fixed reply (D15).
    if i.tool == super::spotify_intent::RECONNECT {
        return Some((i.tool, json!({})));
    }
    // Only tools this agent was offered: sub-agents get Spotify reads, never playback.
    tools.iter().any(|t| t.name == i.tool).then_some((i.tool, i.args))
}

/// A Spotify write the Rust tool path held back for the approval card (D14).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingSpotifyCall {
    pub name: String,
    pub args: Value,
    pub summary: String,
    pub required: String,
}

/// Pure (D14): a `PERMISSION_REQUIRED:<x>` refusal of a Spotify write becomes the exact call
/// the card will run — only when the caller can show cards (`askCards`).
fn pending_from(err: &str, name: &str, args: &Value, ask_cards: bool) -> Option<PendingSpotifyCall> {
    let name = super::spotify_intent::canonical(name);
    if !ask_cards || !super::spotify_intent::is_write_tool(name) || !err.starts_with("PERMISSION_REQUIRED:") {
        return None;
    }
    let args = super::spotify_intent::normalize_args(name, args).unwrap_or_else(|_| args.clone());
    let required = err.split_whitespace().next().unwrap_or(err).to_string();
    Some(PendingSpotifyCall { name: name.to_string(), summary: super::spotify_intent::summary_for(name, &args), args, required })
}

/// Fixed reason when WhatsApp is on but none of its tools answered.
const WHATSAPP_DOWN: &str = "the WhatsApp bridge isn't answering — start whatsapp-bridge (the Go bridge), then check WhatsApp Bridge in Settings → Skills & MCP Library";

/// Tool shapes a planner needs to recognise a request for a server that listed nothing:
/// the built-in listing, or WhatsApp's read tool (it is an external stdio server).
fn planner_tools(id: &str) -> Vec<super::mcp::ToolInfo> {
    match id {
        "whatsapp" => vec![super::mcp::ToolInfo { name: "whatsapp.list_messages".into(), description: String::new(), server: id.into(), args: vec!["limit".into()] }],
        _ => super::mcp::builtin_tools(id),
    }
}

/// Where a prefetched tool call came from.
#[derive(Clone, Copy, Debug, PartialEq)]
enum PlanSource {
    Deterministic,
    Router,
}

/// Pure (D26): a Spotify result spoken as-is (no LLM synthesis) — any deterministic-plan result,
/// and router-chosen writes. Router-chosen reads still go through synthesis.
fn verbatim_answer(source: PlanSource, is_write: bool, reply: &str) -> Option<String> {
    (source == PlanSource::Deterministic || is_write).then(|| reply.to_string())
}

fn deterministic_plan(text: &str, tools: &[super::mcp::ToolInfo], os_name: &str) -> Option<(String, Value)> {
    gmail_plan(text, tools)
        .or_else(|| whatsapp_plan(text, tools))
        .or_else(|| spotify_plan(text, tools, os_name))
        .or_else(|| time_plan(text, tools))
        .or_else(|| weather_plan(text, tools))
}

/// Text appended to Tony's (or a delegated agent's) prompt: the live tool data,
/// and/or an instruction to report the tool failure honestly.
fn tool_note(os_name: &str, raw: &str, failure: Option<&(String, String)>) -> String {
    let mut note = String::new();
    if !raw.is_empty() {
        note.push_str(&format!(
            "{raw}\n\nYou have live tool access through {os_name}. The data above was fetched just now; answer from it directly. Never say you lack access to WhatsApp, email, files or the internet."
        ));
    }
    if let Some((tool, err)) = failure {
        note.push_str(&format!("\n\n[TOOL FAILURE - {tool}]: {err}. Tell the user what failed in one short sentence, no apology; never say you lack the tool or the skill."));
    }
    note
}

/// What the tool pre-executor produced for one turn.
#[derive(Default)]
struct Prefetch {
    block: String,
    steps: Vec<OsStep>,
    used: Option<String>,
    /// (tool, error) of the call that failed — reported honestly to the model.
    failure: Option<(String, String)>,
    /// The tools offered this turn (router-visible; listed in Tony's system prompt).
    tools: Vec<super::mcp::ToolInfo>,
    /// The caller can raise approval cards (`OsTurnRequest.askCards`, D14).
    ask_cards: bool,
    /// Raw error of the last failed call (the `failure` text is humanized).
    last_error: Option<String>,
    /// A Spotify write held back for the approval card (D14): the turn returns it, no LLM call.
    pending_spotify: Option<PendingSpotifyCall>,
    /// A Spotify reply that IS the answer (D26): the turn returns it verbatim, no LLM call.
    verbatim: Option<String>,
}

impl Prefetch {
    /// After a `spotify.*` call: pin a write the gate held back, or keep the reply verbatim.
    fn spotify_outcome(&mut self, name: &str, args: &Value, res: Option<&str>, source: PlanSource) {
        if !name.starts_with("spotify.") {
            return;
        }
        let write = super::spotify_intent::is_write_tool(name);
        match res {
            Some(reply) => self.verbatim = verbatim_answer(source, write, reply),
            None => {
                if let Some(p) = self.last_error.as_deref().and_then(|e| pending_from(e, name, args, self.ask_cards)) {
                    self.pending_spotify = Some(p);
                    self.failure = None;
                }
            }
        }
    }
}

/// A tool error without the server's stderr tail: the step and the System Map keep the
/// full (scrubbed) text; the model only needs the status.
fn without_stderr(e: &str) -> &str {
    e.split(" — stderr: ").next().unwrap_or(e)
}

fn humanize_tool_error(e: &str) -> String {
    if let Some(rest) = e.strip_prefix(super::mcp::READ_ONLY_PREFIX) {
        rest.split_once(" — ").map_or(rest, |(_, why)| why).to_string()
    } else if let Some(what) = e.strip_prefix("PERMISSION_DENIED:") {
        format!("the {what} permission is set to Deny in Settings → Permissions")
    } else if let Some(what) = e.strip_prefix("PERMISSION_REQUIRED:") {
        format!("the {what} permission is set to Ask and this turn wasn't approved")
    } else {
        e.to_string()
    }
}

impl Prefetch {
    /// Run one tool call (bounded by `secs`) and record its step plus either
    /// its data or its failure. Returns the output on success.
    async fn call(&mut self, state: &DispatchState, os: &OsState, bridge: &BridgeState, name: &str, args: &Value, approved: bool, agent: &str, secs: Duration) -> Option<String> {
        let t0 = Instant::now();
        // A cold-starting MCP server answers "still starting" within CHAT_START_WAIT instead of
        // holding the turn; its start carries on and the next turn reuses the running server.
        let wait = Some(super::mcp::CHAT_START_WAIT.min(secs));
        let res = tokio::time::timeout(secs, super::mcp::call_tool_with(state, os, bridge, name, args, approved, agent, wait)).await;
        let ms = t0.elapsed().as_millis();
        match res {
            Ok(Ok(out)) => {
                self.steps.push(step("tool", "os", name, format!("{args}\n→ {}", out.chars().take(600).collect::<String>()), true, ms));
                let server = name.split('.').next().unwrap_or(name);
                self.block.push_str(&format!("\n\n[LIVE MCP TOOL DATA - {server}]:\n{}", out.chars().take(2000).collect::<String>()));
                self.used = Some(name.to_string());
                Some(out)
            }
            Ok(Err(e)) => {
                let starting = super::mcp::is_starting_error(&e);
                let label = if e.starts_with("PERMISSION_") { "blocked" } else if starting { "starting" } else { "failed" };
                self.steps.push(step("tool", "os", name, format!("{label}: {e}"), false, ms));
                let why = if starting { format!("{} is still starting up (cold start) — ask again in a few seconds", super::mcp::server_of_tool(name)) } else { humanize_tool_error(without_stderr(&e)) };
                self.failure = Some((name.to_string(), why));
                self.last_error = Some(e);
                None
            }
            Err(_) => {
                super::trace::emit(super::trace::Hop::Tool, name, false, ms, Some("timed out"));
                // The dropped call_tool future never reached its own record_call.
                super::mcp::record_call(super::mcp::server_of_tool(name), ms as u64, Some("timed out"), super::os_core::now_secs());
                self.steps.push(step("tool", "os", name, format!("{name} timed out"), false, ms));
                self.failure = Some((name.to_string(), "timed out".into()));
                None
            }
        }
    }
}

/// Run the JSON tool router, restricted to `tools` (minus Gmail/WhatsApp
/// tools the request doesn't name), for up to two sequential calls (so a
/// second lookup can build on the first), capped by `deadline`.
async fn run_tool_router(
    state: &DispatchState,
    os: &OsState,
    bridge: &BridgeState,
    tools: &[super::mcp::ToolInfo],
    context: &str,
    text: &str,
    approved: bool,
    agent: &str,
    os_name: &str,
    deadline: Instant,
    out: &mut Prefetch,
) {
    let offered = router_offer(tools, text, os_name);
    if offered.is_empty() {
        return;
    }
    let mut extra = String::new();
    for _ in 0..2 {
        let router = router_prompt(&offered, context, &extra);
        let mut msgs = vec![ChatMessage::new("system", router), ChatMessage::new("user", text.to_string())];
        let mut replied = false;
        let mut parsed = None;
        for attempt in 0..2 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let Ok(r) = run_chat(state, os, msgs.clone(), Priority::Interactive, None, Some(left.as_secs().clamp(1, 15))).await else { break };
            replied = true;
            if let Some(j) = extract_json(&r.content) {
                parsed = Some(j);
                break;
            }
            if attempt == 0 {
                msgs.push(ChatMessage::new("assistant", r.content));
                msgs.push(ChatMessage::new("user", "JSON only — reply with exactly one JSON object {\"tool\": …, \"args\": {…}} and nothing else."));
            }
        }
        if !replied {
            break;
        }
        // Not JSON / an unoffered tool is a visible (non-error) step; synthesis still proceeds.
        let Some(j) = parsed else {
            out.steps.push(step("tool", "os", "router", "no tool (router reply not JSON)", true, 0));
            break;
        };
        if j["tool"].is_null() {
            break; // router decided no tool is needed — expected, not a failure
        }
        let Some(name) = j["tool"].as_str().filter(|n| offered.iter().any(|t| t.name == *n)).map(String::from) else {
            out.steps.push(step("tool", "os", "router", format!("no tool (router named an unmatched tool: {})", j["tool"]), true, 0));
            break;
        };
        let args = if j["args"].is_object() { j["args"].clone() } else { json!({}) };
        let call_secs = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(15));
        if call_secs.is_zero() {
            out.steps.push(step("tool", "os", &name, format!("{name} skipped — out of time"), false, 0));
            break;
        }
        // Goes through `mcp::call_tool`: MCP permission gate, kill switch, logging.
        let res = out.call(state, os, bridge, &name, &args, approved, agent, call_secs).await;
        out.spotify_outcome(&name, &args, res.as_deref(), PlanSource::Router);
        match res {
            // One media action per turn: never let a second router pass play/skip again.
            Some(_) if super::mcp::is_spotify_actuator(&name) => break,
            Some(res) => extra = format!("\n\nTool {name} already returned:\n{}", res.chars().take(500).collect::<String>()),
            None => break,
        }
    }
}

/// The tools the JSON router is offered for `text`: only the servers the line plausibly needs
/// (`router_line_needs`; Gmail / WhatsApp / Spotify / Maps / Instagram when the request names
/// their subject); Spotify's playback controls also for a line that is itself a media command
/// ("skip", "turn it up"). Spotify library edits (playlists, Liked Songs) only when the line
/// names the library (D25).
fn router_offer<'a>(tools: &'a [super::mcp::ToolInfo], text: &str, os_name: &str) -> Vec<&'a super::mcp::ToolInfo> {
    static LIBRARY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let norm = super::routing::normalize(text);
    let command = media_command(text, os_name);
    let library = LIBRARY.get_or_init(|| regex::Regex::new(r"\b(playlists?|liked songs|library|favou?rites|like|unlike|save|unsave|heart)\b").unwrap()).is_match(&norm);
    tools
        .iter()
        .filter(|t| {
            if t.server == "spotify" && super::spotify_intent::is_library_write(&t.name) {
                return library;
            }
            router_line_needs(&t.server, text, &norm) || (command && super::mcp::is_spotify_actuator(&t.name))
        })
        .collect()
}

/// The router's system prompt: one line per offered tool (args + example call).
fn router_prompt(offered: &[&super::mcp::ToolInfo], context: &str, extra: &str) -> String {
    let list = offered.iter().map(|t| router_tool_line(t)).collect::<Vec<_>>().join("\n");
    format!(
        "You route a request to at most ONE tool. Tools:\n{list}\n\nLIVE DASHBOARD:\n{}{extra}\n\nReply ONLY with JSON: {{\"tool\": \"<tool name>\" or null, \"args\": {{…}}}}. \
Use null if the dashboard/previous tool result already answers it or no tool helps. Spotify controls (spotify.play, spotify.pause, \
spotify.next, spotify.volume, …) only when the user plainly asks to play, pause, skip or change the music. \
Spotify tools control Spotify only — never use them for YouTube, videos or local sounds. Use library tools only when the user \
explicitly asks to change a playlist or Liked Songs.",
        context.chars().take(1500).collect::<String>()
    )
}

/// The tools a turn of `agent` can use — the ONE builder `prefetch_tools` and
/// `tony_tools_preview` share. A Deny MCP tier means none.
async fn turn_tools(state: &DispatchState, os: &OsState, cfg: &OsConfig, agent: &str) -> super::mcp::ToolSet {
    if cfg.permissions.mcp == super::bridge::Tier::Deny {
        return super::mcp::ToolSet { all: vec![], offered: vec![] };
    }
    super::mcp::tool_set(state, os, agent).await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TonyToolsPreview {
    /// Every tool of the servers Tony's turn can use (incl. ones the router never sees).
    all: Vec<String>,
    /// The subset offered to Tony's LLM router (and listed in his system prompt).
    router_offered: Vec<String>,
    /// The Spotify server is on, connected, not blocked by the kill switch and not
    /// denied by the MCP permission tier.
    spotify_ready: bool,
}

fn tools_preview(set: &super::mcp::ToolSet, spotify_ready: bool) -> TonyToolsPreview {
    TonyToolsPreview { all: set.all.iter().map(|t| t.name.clone()).collect(), router_offered: set.offered.iter().map(|t| t.name.clone()).collect(), spotify_ready }
}

/// Diagnostics: the tool names Tony's next turn would see. Names only — no
/// arguments, results or secrets.
#[tauri::command]
pub async fn tony_tools_preview(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<TonyToolsPreview, String> {
    let cfg = os.snapshot();
    let set = turn_tools(&state, &os, &cfg, "general").await;
    let spotify_ready = spotify_ready(&cfg, || super::spotify::readiness(&state).is_ok());
    Ok(tools_preview(&set, spotify_ready))
}

/// Same rule as `spotify::may_read`: kill switch off, MCP tier not Deny, server on, connected.
fn spotify_ready(cfg: &OsConfig, connected: impl FnOnce() -> bool) -> bool {
    !cfg.privacy.kill_switch && cfg.permissions.mcp != super::bridge::Tier::Deny && cfg.mcps.iter().any(|m| m.id == "spotify" && m.enabled) && connected()
}

/// Fetch live tool data for `agent`'s upcoming turn (its own granted tools;
/// Tony's own turns pass `"general"` and, like every agent, get only the enabled
/// servers granted to him that the switchboard leaves live this turn,
/// `mcp::servers_for`). Tries a deterministic plan first (instant, no LLM
/// call), then — if the text still plausibly wants a tool — the JSON router,
/// restricted to that agent's tools. Mutating tools are never offered
/// (`mcp::offered_to_router`, enforced inside `mcp::tool_set`; Tony's Spotify media controls are the one allowlisted exception). The whole
/// thing is capped at ~20s so one dead server can't stall the turn.
#[allow(clippy::too_many_arguments)]
async fn prefetch_tools(state: &DispatchState, os: &OsState, bridge: &BridgeState, cfg: &OsConfig, agent: &str, text: &str, context: &str, approved: bool, ask_cards: bool, cue_playing: bool) -> Prefetch {
    let mut out = Prefetch { ask_cards, ..Prefetch::default() };
    if cfg.permissions.mcp == super::bridge::Tier::Deny {
        return out;
    }
    let mut tools = turn_tools(state, os, cfg, agent).await.offered;
    // Cue precedence (G20): "volume 30" while Gabagool plays is the cue's — neither the grammar
    // nor the router may turn it into a Spotify volume change.
    if super::spotify_intent::cue_owns_volume(text, &cfg.os_name, cue_playing) {
        tools.retain(|t| t.name != "spotify.volume");
    }
    out.tools = tools.clone();
    let deadline = Instant::now() + Duration::from_secs(20);
    if let Some((name, args)) = deterministic_plan(text, &tools, &cfg.os_name) {
        // "reconnect Spotify" on the Rust path: a fixed reply, no tool, no browser (D15).
        if name == super::spotify_intent::RECONNECT {
            out.steps.push(step("tool", "os", &name, "fixed reply (sign-in happens in Settings → Integrations)", true, 0));
            out.verbatim = Some(super::spotify::RUST_RECONNECT.into());
            return out;
        }
        let secs = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(18));
        let res = out.call(state, os, bridge, &name, &args, approved, agent, secs).await;
        out.spotify_outcome(&name, &args, res.as_deref(), PlanSource::Deterministic);
        return out;
    }
    // Asked for email / Spotify / WhatsApp but that server can't serve it (off / no
    // backend / not connected): say why instead of letting the model invent a refusal.
    type Planner = fn(&str, &[super::mcp::ToolInfo], &str) -> Option<(String, Value)>;
    let planners: [(&str, Planner); 3] = [("gmail", |t, tools, _| gmail_plan(t, tools)), ("spotify", spotify_plan), ("whatsapp", |t, tools, _| whatsapp_plan(t, tools))];
    let mode = os.modes.effective();
    for (id, plan) in planners {
        // Tony respects his grants like every agent (`McpServer::grants("general")`).
        let server = cfg.mcps.iter().find(|m| m.id == id && m.grants(agent));
        if let Some(server) = server.filter(|_| !tools.iter().any(|t| t.server == id) && plan(text, &planner_tools(id), &cfg.os_name).is_some()) {
            // Frozen by the switchboard first ("Gmail is frozen in Builder mode"), then switched
            // off / no backend; an enabled stdio WhatsApp server that listed nothing is a bridge
            // that isn't running.
            let frozen = super::modes::tool_frozen_reason(&mode, &cfg.switchboard, id, &server.name);
            if let Some(reason) = frozen.or_else(|| super::mcp::unavailable_reason(state, cfg, id)).or_else(|| (id == "whatsapp").then(|| WHATSAPP_DOWN.to_string())) {
                out.steps.push(step("tool", "os", id, format!("failed: {reason}"), false, 0));
                out.failure = Some((id.into(), reason));
                return out;
            }
        }
    }
    if !tools.is_empty() && (wants_tools(text) || media_command(text, &cfg.os_name)) {
        run_tool_router(state, os, bridge, &tools, context, text, approved, agent, &cfg.os_name, deadline, &mut out).await;
    }
    // A "play …" line nothing could act on: a fixed, honest reply instead of letting the
    // local model claim Spotify is off (or guess what was meant).
    if out.used.is_none() && out.failure.is_none() && out.pending_spotify.is_none() && tools.iter().any(|t| t.server == "spotify") && unparsed_play_request(text, &cfg.os_name) {
        out.steps.push(step("tool", "os", "spotify.play", format!("failed: {PLAY_HELP}"), false, 0));
        out.failure = Some(("spotify.play".into(), PLAY_HELP.into()));
    }
    out
}

// ── The turn ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OsTurnRequest {
    pub(crate) text: String,
    /// Sub-agent role: librarian | coder | booking | ops | prompter | designer | general.
    pub(crate) role: String,
    /// The user opened that agent's tab (talk to it directly, no synthesis).
    #[serde(default)]
    pub(crate) explicit: bool,
    /// How the caller (the TS resolver) already classified this turn —
    /// "Named" | "Domain" | "Tab" | "Llm" | "Default" | "Direct". Echoed back on
    /// `OsTurnResult` unless the Rust safety net below re-resolves it.
    #[serde(default)]
    pub(crate) route_kind: Option<String>,
    #[serde(default)]
    pub(crate) route_reason: Option<String>,
    #[serde(default)]
    pub(crate) history: Vec<ChatMessage>,
    /// Live dashboard state rendered as text by the webview.
    #[serde(default)]
    pub(crate) context: String,
    #[serde(default)]
    pub(crate) approved: bool,
    /// An approved Tier-3 delegation card (TS `approve()`, scopes `["delegation"]`): satisfies
    /// the delegation gate ONLY. Ask-tier tools the turn prefetches stay unapproved (they come
    /// back blocked), because that card never named them. See `turn_approvals`.
    #[serde(default)]
    pub(crate) delegation_approved: bool,
    /// Stream Tony's answer as `tony-token` events under this id.
    #[serde(default)]
    pub(crate) stream_id: Option<String>,
    /// System Map trace this turn's `os-trace` steps join (the webview's own hops use it
    /// too). Missing or malformed = a fresh id.
    #[serde(default)]
    pub(crate) trace_id: Option<String>,
    /// The caller can show approval cards (TS `osRun`): a Spotify write held by the Ask tier
    /// returns `pendingSpotify` instead of a failure note (D14). Phone / inbox leave it false.
    #[serde(default)]
    pub(crate) ask_cards: bool,
    /// A Gabagool cue is playing (TS `cuePlayingNow()`): a bare volume line ("volume 30") is
    /// the cue's, so Spotify volume is not offered this turn (`spotify_intent::cue_owns_volume`).
    #[serde(default)]
    pub(crate) cue_playing: bool,
    /// P3 Tier 2: Tony brainstorms this himself — no routing safety net, no delegation, and
    /// the Tier-2 hint rides on his system message. Missing (phone / old webview) = false.
    #[serde(default)]
    pub(crate) no_delegate: bool,
    /// The phone's turn (TS `routeFor(…, { phone })`): a topic (Domain) hit stays with Tony, so
    /// the safety net below doesn't re-promote a Default turn to a Domain agent the phone kept
    /// with him. A Named address still routes. Missing (desktop / old phone) = false.
    #[serde(default)]
    pub(crate) stay_with_tony: bool,
    /// The Business Switcher's selection (a registry `businessId`). Operations-Manager and
    /// Finance turns are locked to exactly one business (`business_lock`); missing = resolve
    /// from the text, and ask if that isn't exactly one.
    #[serde(default)]
    pub(crate) active_business_id: Option<String>,
}

/// `(delegation gate approved, Ask-tier tools approved)` for a turn. `approved` (the turn's own
/// card said yes) covers both; `delegation_approved` (a Tier-3 delegation card) covers the
/// delegation gate alone — never a blanket yes for gmail / filesystem / MCP. Pure.
pub(crate) fn turn_approvals(approved: bool, delegation_approved: bool) -> (bool, bool) {
    (approved || delegation_approved, approved)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OsStep {
    /// delegate | reply | tool | step-in | error | overseer | verify
    pub(crate) kind: String,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) text: String,
    pub(crate) ok: bool,
    pub(crate) ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTurnResult {
    pub(crate) answer: String,
    pub(crate) steps: Vec<OsStep>,
    pub(crate) provider_id: String,
    pub(crate) delegated_to: Option<String>,
    pub(crate) tool: Option<String>,
    pub(crate) latency_ms: u128,
    pub(crate) reason: String,
    pub(crate) redacted: bool,
    /// Comms thread the answer quotes from ("Jump to Thread in Comms →").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) comms_thread: Option<String>,
    /// Final role this turn was routed to (after the Rust safety net, if it fired).
    pub(crate) routed_role: String,
    pub(crate) route_reason: String,
    /// "Named" | "Domain" | "Tab" | "Llm" | "Default".
    pub(crate) route_kind: String,
    /// The Spotify write the card must run (D14); `answer` is "" then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pending_spotify: Option<PendingSpotifyCall>,
    /// Who produced `answer`: "agent" (the sub-agent itself), "os" (Tony's synthesis — also
    /// when he stepped in for a failed agent), "overseer", or "tool".
    pub(crate) answered_by: String,
    /// Learning mode: the pathways this turn saved / updated (the "Memory saved" pill).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) learned: Vec<super::learning::Saved>,
    /// Tony's dispatch packet, when his reply was one with tasks (held / pending / queued).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dispatch: Option<super::tony_dispatch::DispatchView>,
}

pub(crate) fn step(kind: &str, from: &str, to: &str, text: impl Into<String>, ok: bool, ms: u128) -> OsStep {
    OsStep { kind: kind.into(), from: from.into(), to: to.into(), text: text.into(), ok, ms }
}

#[tauri::command]
pub async fn os_turn(app: tauri::AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: OsTurnRequest) -> Result<OsTurnResult, String> {
    let Some(sid) = req.stream_id.clone().filter(|s| !s.is_empty()) else {
        return run_os_turn(&state, &os, &bridge, req, Some(&app)).await;
    };
    // Phase 2 "cut it": `os_turn_cancel {streamId}` drops this whole future — every in-flight
    // reqwest stream (LLM SSE, AnythingLLM stream-chat) and the compute slot go with it, and a
    // dropped connection stops the server generating.
    let cancel = TURN_CANCELS.register(&sid);
    let turn = std::pin::pin!(run_os_turn(&state, &os, &bridge, req, Some(&app)));
    let cancelled = std::pin::pin!(cancel.notified());
    let out = match futures_util::future::select(turn, cancelled).await {
        futures_util::future::Either::Left((r, _)) => r,
        futures_util::future::Either::Right(_) => Err(TURN_CANCELLED.into()),
    };
    TURN_CANCELS.finish(&sid);
    out
}

/// Error text of a turn stopped by `os_turn_cancel` (the webview stays silent on it).
pub(crate) const TURN_CANCELLED: &str = "turn cancelled";

/// streamId → cancel signal. A cancel that arrives before its turn registers leaves a stored
/// permit (`Notify::notify_one`), so the turn ends as soon as it starts.
pub(crate) struct TurnCancels(std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Notify>>>);

impl TurnCancels {
    fn slot(&self, id: &str) -> std::sync::Arc<tokio::sync::Notify> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Pre-cancels for turns that never ran would otherwise accumulate.
        if m.len() > 64 {
            m.retain(|_, n| std::sync::Arc::strong_count(n) > 1);
        }
        m.entry(id.to_string()).or_insert_with(|| std::sync::Arc::new(tokio::sync::Notify::new())).clone()
    }
    pub(crate) fn register(&self, id: &str) -> std::sync::Arc<tokio::sync::Notify> {
        self.slot(id)
    }
    pub(crate) fn cancel(&self, id: &str) {
        self.slot(id).notify_one();
    }
    pub(crate) fn finish(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}

pub(crate) static TURN_CANCELS: std::sync::LazyLock<TurnCancels> = std::sync::LazyLock::new(|| TurnCancels(Default::default()));

/// Stop an in-flight `os_turn` by its `streamId` (Phase 2 "cut it"). Unknown ids are harmless.
#[tauri::command]
pub fn os_turn_cancel(stream_id: String) {
    if !stream_id.is_empty() && stream_id.len() <= 128 {
        TURN_CANCELS.cancel(&stream_id);
    }
}

#[cfg(test)]
mod turn_steps_tests {
    use super::*;

    #[test]
    fn hot_path_history_is_capped_by_turns_chars_and_total() {
        let h: Vec<ChatMessage> = (0..20).map(|i| ChatMessage::new(if i % 2 == 0 { "user" } else { "assistant" }, format!("{i}:{}", "x".repeat(900)))).collect();
        let c = cap_history(h.clone(), 6, 100_000, 100_000);
        assert_eq!(c.len(), 6);
        assert!(c[0].content.starts_with("14:") && c[5].content.starts_with("19:"), "the newest six, in order");
        // Per-message clip.
        let c = cap_history(h.clone(), 6, 100_000, 300);
        assert!(c.iter().all(|m| m.content.chars().count() <= 301));
        // Total cap: oldest go first; the newest always stays.
        let c = cap_history(h.clone(), 6, 2000, 100_000);
        assert_eq!(c.len(), 2);
        assert!(c[1].content.starts_with("19:"));
        let c = cap_history(h, 6, 10, 100_000);
        assert_eq!(c.len(), 1);
        assert!(cap_history(vec![], 6, 10, 10).is_empty());
        // Scroll summary block.
        assert_eq!(scroll_summary_block(None, 900), "");
        assert_eq!(scroll_summary_block(Some("facts"), 0), "");
        let b = scroll_summary_block(Some(&"y".repeat(5000)), 900);
        assert!(b.contains("LATEST MEMORY SCROLL") && b.len() < 1100, "{}", b.len());
    }

    /// Regression: tool output and the delegate prompt (with raw live tool data and the identity
    /// file) reached chat / localStorage / the phone mirror unscrubbed and verbatim.
    #[test]
    fn steps_are_scrubbed_and_the_delegate_step_names_its_attachments() {
        let mut s = vec![step("tool", "os", "gmail.search", "q=invoice\n→ token sk-abcdefghijklmnopqrstuvwx1234 in the body", true, 3)];
        scrub_steps(&mut s, &[]);
        assert!(!s[0].text.contains("sk-abcdefghijklmnopqrstuvwx1234"), "{}", s[0].text);
        let shown = delegate_shown("Request: fix the build", true, 1834);
        assert!(shown.starts_with("Request: fix the build"));
        assert!(shown.contains("[+ MASTER_IDENTITY.md attached]") && shown.contains("1834 chars"));
        assert_eq!(delegate_shown("Request: x", false, 0), "Request: x");
    }
}

#[cfg(test)]
mod turn_cancel_tests {
    use super::*;
    use futures_util::FutureExt;

    #[test]
    fn cancel_wakes_a_registered_turn() {
        let c = TurnCancels(Default::default());
        let n = c.register("a");
        assert!(n.notified().now_or_never().is_none(), "not cancelled yet");
        c.cancel("a");
        assert!(n.notified().now_or_never().is_some());
        c.finish("a");
        assert!(c.0.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_before_register_is_kept() {
        let c = TurnCancels(Default::default());
        c.cancel("b");
        let n = c.register("b");
        assert!(n.notified().now_or_never().is_some(), "an early cut still stops the turn");
        // Another stream id is unaffected.
        assert!(c.register("other").notified().now_or_never().is_none());
    }
}

pub async fn run_os_turn(state: &DispatchState, os: &OsState, bridge: &BridgeState, req: OsTurnRequest, app: Option<&tauri::AppHandle>) -> Result<OsTurnResult, String> {
    run_os_turn_streaming(state, os, bridge, req, app, None).await
}

/// D2: where an inbox (phone) turn's answer streams while Tony writes it. Called with each new
/// think-filtered piece of Tony's OWN final answer (his direct reply or his synthesis of a
/// delegated one), in order; never with a sub-agent's reply, a tool's verbatim answer or an
/// overseer's. The desktop webview never sees these pieces (no `tony-token` events).
pub(crate) type AnswerSink = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

/// `run_os_turn`, with Tony's final answer streamed into `sink` (an inbox turn, D2). `None` is
/// exactly `run_os_turn`.
pub(crate) async fn run_os_turn_streaming(state: &DispatchState, os: &OsState, bridge: &BridgeState, req: OsTurnRequest, app: Option<&tauri::AppHandle>, sink: Option<AnswerSink>) -> Result<OsTurnResult, String> {
    // Phase 3: a live Tony turn keeps idle memory compaction away (entry and exit).
    let _touch = super::compaction::Touch::start();
    let id = req.trace_id.clone().filter(|t| super::trace::valid_id(t)).unwrap_or_else(super::trace::new_id);
    // Compute arbiter: the user is here (idle timer reset) and the turn's end-to-end latency.
    let t_turn = Instant::now();
    super::arbiter::get().touch_foreground();
    // Agent Conversation of a delegated turn: `turn:<stream id|trace id>`.
    let conv = super::transcript::turn_conv(req.stream_id.as_deref().filter(|s| !s.is_empty()).unwrap_or(&id));
    let (explicit, request) = (req.explicit, req.text.trim().to_string());
    let mut r = super::trace::scoped(id, os_turn_traced(state, os, bridge, req, app, &conv, sink.as_ref())).await?;
    super::arbiter::get().record_tony_turn(t_turn.elapsed().as_millis() as u64);
    // Steps are shown in chat, persisted in localStorage and mirrored to the phone: scrub them.
    let known = super::devqueue::known_secrets(state, os);
    scrub_steps(&mut r.steps, &known);
    if !explicit {
        record_turn(&conv, &request, &r.steps, Some(&r.answer), None, &known);
    }
    Ok(r)
}

/// Does a turn's step list involve another agent (a delegation or an overseer escalation)? Only
/// those become an Agent Conversation: a plain Tony turn (or a tab's own direct chat, which IS
/// that agent's thread) has nothing to review. Pure.
pub(crate) fn involves_agents(steps: &[OsStep]) -> bool {
    steps.iter().any(|s| s.kind == "delegate" || s.kind == "overseer")
}

/// Record a delegated turn in the Agent Conversation transcript (best-effort).
fn record_turn(conv: &str, request: &str, steps: &[OsStep], answer: Option<&str>, error: Option<&str>, known: &[String]) {
    if !involves_agents(steps) {
        return;
    }
    let rows: Vec<(String, String, String, String, bool)> = steps.iter().map(|s| (s.kind.clone(), s.from.clone(), s.to.clone(), s.text.clone(), s.ok)).collect();
    super::transcript::record_turn(conv, request, super::transcript::turn_messages(request, &rows, answer, error), known);
}

/// System Map label for a model call: `provider · model`.
fn model_label(state: &DispatchState, provider_id: &str) -> String {
    match state.snapshot().providers.iter().find(|p| p.id == provider_id).map(|p| p.model.clone()).filter(|m| !m.is_empty()) {
        Some(model) => format!("{provider_id} · {model}"),
        None => provider_id.to_string(),
    }
}

/// `run_os_turn`'s body, inside its trace scope: emits router / rules / memory / model steps.
/// Rolling history for one turn (pure): the last `keep` messages, each clipped to `msg_chars`,
/// then the oldest dropped until the total fits `total_chars` (the newest always stays).
pub(crate) fn cap_history(history: Vec<ChatMessage>, keep: usize, total_chars: usize, msg_chars: usize) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = history
        .into_iter()
        .rev()
        .take(keep)
        .map(|m| ChatMessage { content: super::envelope::clip(&m.content, msg_chars), role: m.role })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    while out.len() > 1 && out.iter().map(|m| m.content.len()).sum::<usize>() > total_chars {
        out.remove(0);
    }
    out
}

/// The newest Memory Scroll summary as a prompt block (pure; empty when off / unknown).
pub(crate) fn scroll_summary_block(seed: Option<&str>, max: usize) -> String {
    match seed.map(str::trim).filter(|s| !s.is_empty() && max > 0) {
        Some(s) => super::learning::neutral(&format!("\nLATEST MEMORY SCROLL (your condensed long-term memory; use only if relevant):\n{}\n", super::envelope::clip(s, max))),
        None => String::new(),
    }
}

async fn os_turn_traced(state: &DispatchState, os: &OsState, bridge: &BridgeState, req: OsTurnRequest, app: Option<&tauri::AppHandle>, conv: &str, sink: Option<&AnswerSink>) -> Result<OsTurnResult, String> {
    use super::trace::{emit, emit_with, Hop};
    let (state, os, bridge) = (state, os, bridge);
    let started = Instant::now();
    let cfg = os.snapshot();
    let text = req.text.trim().to_string();
    if text.is_empty() || text.len() > 20_000 {
        return Err("empty or oversized request".into());
    }

    // ── Routing safety net ──
    // The caller (the TS resolver, for desktop turns; the phone's own default
    // trigger table, for inbox turns) has usually already resolved a role.
    // When it hasn't — role is still "general" and this isn't an explicit
    // tab turn — re-resolve here against the *authoritative* config (every
    // custom trigger the user saved), which the phone path can't see.
    // Self aliases ("tony", "dispatcher"…) are canonicalised to general; Tony is never a
    // route target; the direct live-tool backstop covers phone / inbox / stale callers.
    // Phase 2 Part C: the mode this turn runs under (switching applies from the next turn).
    let mode = os.modes.effective();
    let solo = mode.dispatch == super::modes::DispatchPolicy::SurfaceOnly;
    // Learning mode: Tony only. No routing, comms recall, live tools, Spotify or delegation run;
    // the only side effect is a pathway write (below).
    let learning = super::modes::is_learning(&mode);
    let route_input = TurnRouteInput { role: &req.role, explicit: req.explicit, text: &text, route_kind: req.route_kind.as_deref(), route_reason: req.route_reason.as_deref(), no_delegate: req.no_delegate, solo, learning, stay_with_tony: req.stay_with_tony };
    let TurnRoute { role, kind: route_kind, reason: route_reason } = route_for_turn(&route_input, &cfg);
    // A registered business named in an otherwise unrouted line ("how's Corner Bakery doing?")
    // is the Operations Manager's: registry names are data, not routing triggers.
    let (role, route_kind, route_reason) = match business_route(&role, &route_kind, &text, business_route_held(&route_input)) {
        Some(reason) => ("bizops".to_string(), "Domain".to_string(), reason),
        None => (role, route_kind, route_reason),
    };
    // The switchboard, after the business route (a business name can't pull a frozen Biz Ops in).
    let routed = TurnRoute { role, kind: route_kind, reason: route_reason };
    let routed_role = routed.role.clone();
    let held = switchboard_hold(routed, req.explicit, &text, &cfg, &mode);
    // A master-switchboard freeze says "thaw it there", a mode freeze "switch modes".
    let frozen_hint = switchboard_note(&routed_role, &held, &cfg.switchboard);
    let TurnRoute { role, kind: route_kind, reason: route_reason } = held;
    // Route kind + target only (the reason can quote the request).
    emit(Hop::Router, &router_hop_label(&route_kind, &role, &cfg.os_name), true, started.elapsed().as_millis(), None);

    let mut steps: Vec<OsStep> = Vec::new();
    let mut delegated_to = None;
    let mut agent_answer: Option<String> = None;
    let mut comms_thread: Option<String> = None;

    // ── Conversational recall: "look at my conversation with Sam — what did they say about X?" ──
    if let Some((who, topic)) = (!learning).then(|| comms_recall_intent(&text)).flatten() {
        let t0 = Instant::now();
        steps.push(step("delegate", "os", "librarian", format!("Search the {who} conversation (SMS / WhatsApp / calls) for: {}", if topic.is_empty() { "anything recent" } else { &topic }), true, 0));
        // Hot path: capped hits and a hard lookup budget; a slow search falls back to a direct answer.
        let hp = &cfg.memory.hot_path;
        let limit = (hp.rag_top_k as usize * 3).clamp(3, 10);
        let found = match tokio::time::timeout(Duration::from_millis(hp.rag_timeout_ms as u64), super::pipeline::comms_search(state, &cfg, &who, &topic, limit)).await {
            Ok(r) => r,
            Err(_) => Err(format!("lookup timed out after {} ms — answering directly", hp.rag_timeout_ms)),
        };
        match found {
            Ok((quotes, thread)) if !quotes.is_empty() => {
                steps.push(step("reply", "librarian", "os", quotes.clone(), true, t0.elapsed().as_millis()));
                agent_answer = Some(format!("Exact quotes from the conversation with {who}:\n{quotes}"));
                delegated_to = Some("comms-history".into());
                comms_thread = thread;
            }
            Ok(_) => steps.push(step("reply", "librarian", "os", format!("No messages with {who} match that."), false, t0.elapsed().as_millis())),
            Err(e) => steps.push(step("error", "librarian", "os", format!("Comms history unavailable: {e}"), false, t0.elapsed().as_millis())),
        }
        // Outcome only: the contact and topic are the request's own words.
        let (ok, failed) = steps.last().map(|s| (s.ok, s.kind == "error")).unwrap_or((false, false));
        emit(Hop::Memory, "comms history search", ok, t0.elapsed().as_millis(), failed.then_some("comms history unavailable"));
    }
    let keep = cfg.scheduler.history_turns.max(2) as usize;
    let hp = cfg.memory.hot_path.clone();
    let history: Vec<ChatMessage> = cap_history(req.history, keep, hp.history_chars as usize, hp.history_msg_chars as usize);
    let history_chars: usize = history.iter().map(|m| m.content.len()).sum::<usize>() + text.len();

    // ── Tool pre-executor (Part 2) — runs BEFORE delegation, using only the
    // target agent's own granted tools, and regardless of whether a
    // sub-agent later answers (that gate used to skip tools entirely). ──
    let prefetch_agent = if role == "general" { "general" } else { role.as_str() };
    // The delegation gate runs BEFORE any tool: a PERMISSION_REQUIRED here makes the UI
    // re-run the whole turn with approved=true, so a prefetched action (a Spotify skip)
    // would otherwise run once now and again on the retry — or run although the user said no.
    // ── Business lock (Operations Manager / Finance) ── exactly one business, or Tony asks.
    let lock = if !learning && matches!(role.as_str(), "bizops" | "finance") { Some(business_lock(&role, req.active_business_id.as_deref(), &text)) } else { None };
    let (slug, business_block) = match lock {
        Some(Err(answer)) => {
            let res = OsTurnResult {
                answer,
                steps,
                provider_id: "bizops".into(),
                delegated_to: None,
                tool: None,
                latency_ms: started.elapsed().as_millis(),
                reason: "business not locked (clarification)".into(),
                redacted: false,
                comms_thread: None,
                routed_role: role.clone(),
                route_reason: route_reason.clone(),
                route_kind: route_kind.clone(),
                pending_spotify: None,
                answered_by: "tony".into(),
                learned: vec![],
                dispatch: None,
            };
            emit(Hop::Router, "business lock → clarification", true, started.elapsed().as_millis(), None);
            log_turn(bridge, &role, &text, &res, &super::devqueue::known_secrets(state, os));
            return Ok(res);
        }
        Some(Ok(b)) if role == "bizops" => (Some(b.slug), b.block),
        Some(Ok(b)) => {
            // Finance: its one workspace must hold no documents (the ledger is never embedded).
            let slug = cfg.anythingllm.workspaces.get("finance").filter(|s| s.as_str() == super::finance_vault::FINANCE_WORKSPACE).cloned();
            if let Some(sl) = &slug {
                finance_workspace_is_empty(state, &cfg, sl).await?;
            }
            (slug, b.block)
        }
        None => (cfg.anythingllm.workspaces.get(&role).filter(|s| !s.is_empty()).cloned(), String::new()),
    };
    let (delegation_ok, tools_ok) = turn_approvals(req.approved, req.delegation_approved);
    if role != "general" && comms_thread.is_none() {
        if let Some(slug) = &slug {
            os_core::gate(bridge, cfg.permissions.delegation, "delegation", delegation_ok, json!({ "workspace": slug }))?;
        }
    }
    let pre = if comms_thread.is_none() && !learning { prefetch_tools(state, os, bridge, &cfg, prefetch_agent, &text, &req.context, tools_ok, req.ask_cards, req.cue_playing).await } else { Prefetch::default() };
    steps.extend(pre.steps);
    // Steps reach the webview as they happen ("os-step"), so a turn that then fails or is cut
    // ("cut it") still shows what was asked and answered.
    let known = super::devqueue::known_secrets(state, os);
    let mut emitted = emit_steps(app, req.stream_id.as_deref(), &steps, 0, &known);
    let tool_note = tool_note(&cfg.os_name, &pre.block, pre.failure.as_ref());
    let tool_used = pre.used;

    // ── Spotify on Tony's tool path ── a write held by the Ask tier (D14) or a reply that is the
    // answer (D26) ends the turn here, before any model call.
    if role == "general" {
        let spotify_turn = |answer: String, tool: Option<String>, reason: &str, pending: Option<PendingSpotifyCall>, steps: Vec<OsStep>| OsTurnResult {
            answer,
            steps,
            provider_id: "spotify".into(),
            delegated_to: None,
            tool,
            latency_ms: started.elapsed().as_millis(),
            reason: reason.into(),
            redacted: false,
            comms_thread: None,
            routed_role: role.clone(),
            route_reason: route_reason.clone(),
            route_kind: route_kind.clone(),
            pending_spotify: pending,
            answered_by: "tool".into(),
            learned: vec![],
            dispatch: None,
        };
        if let Some(p) = pre.pending_spotify {
            let res = spotify_turn(String::new(), Some(p.name.clone()), "spotify approval card", Some(p), steps);
            log_turn(bridge, &role, &text, &res, &known);
            return Ok(res);
        }
        if let Some(reply) = pre.verbatim {
            // Spoken like a streamed answer: one `tony-token` chunk under the turn's stream id.
            if let (Some(app), Some(sid)) = (app, req.stream_id.as_deref()) {
                use tauri::Emitter;
                let _ = app.emit("tony-token", json!({ "streamId": sid, "delta": reply }));
            }
            let res = spotify_turn(reply, tool_used.clone(), "spotify reply (verbatim)", None, steps);
            log_turn(bridge, &role, &text, &res, &known);
            return Ok(res);
        }
    }

    // ── 2. Delegation ── (gated above, before the tool pre-executor)
    if role != "general" && comms_thread.is_none() {
        if let Some(slug) = slug {
            let label = role_label(&role, &cfg.os_name);
            // A skill's body rides along only when this task matches it (within a budget).
            let skills = super::mcp::relevant_skills(&cfg, &role, &text, super::mcp::SKILL_BUDGET);
            if !skills.names.is_empty() {
                emit(Hop::Rules, &format!("skill {} → {label}", skills.names.join(", ")), true, 0, None);
            }
            // Designer / Prompter / Director also get the user's identity file (taste, brand, goals).
            let identity = if matches!(role.as_str(), "designer" | "prompter" | "director") {
                let r = os_core::read_identity(&cfg);
                emit(Hop::Rules, &format!("MASTER_IDENTITY.md → {label}"), r.is_ok(), 0, r.as_ref().err().map(|_| "identity file not readable"));
                r.map(|i| format!("\n\nABOUT THE USER (MASTER_IDENTITY.md):\n{}", i.chars().take(2000).collect::<String>())).unwrap_or_default()
            } else {
                String::new()
            };
            let base = if req.explicit {
                text.clone()
            } else {
                format!("[{} → {label} agent] The user asked {} (their OS) to get this from you. Answer from your workspace data and documents; be specific and concise.\n\nRequest: {text}", cfg.os_name, cfg.os_name)
            };
            let task = format!("{base}{identity}{}{business_block}{tool_note}", skills.block);
            // The chat shows the request as sent, with the identity file, skill text and raw live
            // tool data named rather than pasted (they stay in the prompt; never in a transcript).
            let mut shown = delegate_shown(&base, !identity.is_empty(), tool_note.chars().count());
            if !skills.names.is_empty() {
                shown.push_str(&format!("\n\n[+ skill attached: {}]", skills.names.join(", ")));
            }
            steps.push(step("delegate", "os", &role, shown, true, 0));
            emitted = emit_steps(app, req.stream_id.as_deref(), &steps, emitted, &known);
            let t0 = Instant::now();
            // Talking directly to this agent's tab (no Tony synthesis to follow):
            // stream its reply with its OWN voice as it arrives, instead of
            // waiting for the whole answer (Part 6 §1). A delegated turn that
            // Tony is about to summarize skips this — streaming the raw
            // sub-agent reply there would be heard twice (once raw, once as
            // Tony's synthesis moments later).
            let chat_result = match (req.explicit, req.stream_id.as_deref(), app) {
                (true, Some(sid), Some(app)) => workspace_chat_streamed(state, os, &slug, &task, app, sid, &role).await,
                _ => workspace_chat(state, os, &slug, &role, &task).await,
            };
            // A Librarian read is a memory hop (cargo); any other sub-agent is a model call (engine).
            let hop = if role == "librarian" { Hop::Memory } else { Hop::Model };
            let hop_label = format!("{label} · anythingllm/{slug}");
            match &chat_result {
                Ok(_) => emit(hop, &hop_label, true, t0.elapsed().as_millis(), None),
                Err(e) => emit_with(hop, &hop_label, false, t0.elapsed().as_millis(), Some(e), None, &super::devqueue::known_secrets(state, os)),
            }
            match chat_result {
                Ok((answer, sources)) => {
                    let src = if sources.is_empty() { String::new() } else { format!("\n\nSources: {}", sources.join(", ")) };
                    steps.push(step("reply", &role, "os", format!("{answer}{src}"), true, t0.elapsed().as_millis()));
                    // Phase 2 §4 announcer handoff: a delegated agent's answer goes to the webview
                    // the moment it lands, so it can speak in its own voice while Tony's synthesis
                    // (shown, not spoken in that mode) is still generating.
                    if let (false, Some(sid), Some(app)) = (req.explicit, req.stream_id.as_deref(), app) {
                        use tauri::Emitter;
                        let _ = app.emit("os-agent-reply", json!({ "streamId": sid, "agent": role, "text": answer }));
                    }
                    delegated_to = Some(slug.clone());
                    agent_answer = Some(answer);
                }
                Err(e) => {
                    steps.push(step("error", &role, "os", format!("{label} agent failed: {e}"), false, t0.elapsed().as_millis()));
                    steps.push(step("step-in", "os", "user", format!("{} stepped in with its own tools.", cfg.os_name), true, 0));
                }
            }
            emitted = emit_steps(app, req.stream_id.as_deref(), &steps, emitted, &known);
        }
    }

    // Explicit tab + the agent answered: that IS the answer.
    if let (true, Some(a)) = (req.explicit, &agent_answer) {
        let res = OsTurnResult {
            answer: a.clone(),
            steps,
            provider_id: format!("anythingllm:{}", delegated_to.clone().unwrap_or_default()),
            delegated_to,
            tool: tool_used.clone(),
            latency_ms: started.elapsed().as_millis(),
            reason: "direct to sub-agent".into(),
            redacted: false,
            comms_thread: None,
            routed_role: role.clone(),
            route_reason: route_reason.clone(),
            route_kind: route_kind.clone(),
            pending_spotify: None,
            answered_by: "agent".into(),
            learned: vec![],
            dispatch: None,
        };
        log_turn(bridge, &role, &text, &res, &known);
        return Ok(res);
    }

    // ── 1 + 3. OS context + synthesis ──
    // The tool data for a delegated (non-general) turn already rode along in
    // the task above; Tony's own turns (role == "general") get it here, in
    // his own system prompt, since there was no delegated task to carry it.
    let t_rules = Instant::now();
    let sys = system_prompt(&cfg, &req.context, &pre.tools, action_shaped(&text, &cfg.os_name));
    if sys.contains("ABOUT THE USER (MASTER_IDENTITY.md)") {
        emit(Hop::Rules, "system prompt + MASTER_IDENTITY.md", true, t_rules.elapsed().as_millis(), None);
    } else {
        emit(Hop::Rules, "system prompt (no identity)", false, t_rules.elapsed().as_millis(), Some("MASTER_IDENTITY.md not readable — check the identity path in Settings"));
    }
    let sys_tool_note = if role == "general" { tool_note.clone() } else { String::new() };

    let mut user_msg = text.clone();
    if let Some(a) = &agent_answer {
        user_msg = format!(
            "{text}\n\n[{} agent's reply — summarize it for the user in your own voice, keep the specifics (names, dates, times), don't invent anything]:\n{a}",
            role_label(&role, &cfg.os_name)
        );
    }
    // Phase 2 Part C: the MODE block (Tony's own turns only — never a sub-agent or Booking).
    let mode_block = if role == "general" { super::modes::mode_block(&mode) } else { String::new() };
    // P3 Tier 2: appended here, outside `system_prompt`, so the persona text stays as it is.
    let tier2 = if req.no_delegate && role == "general" { tier2_hint(!mode_block.is_empty()) } else { String::new() };
    // Part 7: `/no_think` on its own last line when Tony's model thinks by default (Qwen3 family)
    // and Deep thinking is off — after every hint and the MODE block, so it stays the last line.
    // Learning: what Nic already taught that bears on this turn (every mode: confirmed only;
    // Learning: provisional too, so a clash is caught before saving). Tony's own turns only.
    let pathways = super::learning::live_path(&cfg, &state.snapshot().gateway.workdir);
    let learned_block = match (&pathways, role == "general") {
        (Some(p), true) => {
            let t0 = Instant::now();
            let f = super::learning::load(p);
            let hits = super::learning::relevant(&f, &text, if learning { 6 } else { 4 }, !learning);
            if !hits.is_empty() {
                emit(Hop::Memory, &format!("learning · {} pathway(s) recalled", hits.len()), true, t0.elapsed().as_millis(), None);
            }
            super::learning::learned_block(&hits, learning)
        }
        _ => String::new(),
    };
    // Two-tier memory (Tier 1, `tony` namespace): up to 3 earlier exchanges that share words with
    // this one, ≤ 450 chars, prompt-safe. Private turns are never stored, so never recalled.
    // Hot path: capped hits / chars, looked up on the blocking pool under a hard budget; on a
    // timeout Tony answers directly without it. The newest Memory Scroll summary rides along
    // (cached; no disk read here).
    let tony_recall = if role == "general" && private_turn(&role, &text, None).is_none() {
        let t0 = Instant::now();
        let (q, k, chars) = (text.clone(), hp.rag_top_k as usize, hp.rag_chunk_chars as usize);
        let looked = tokio::time::timeout(Duration::from_millis(hp.rag_timeout_ms as u64), tauri::async_runtime::spawn_blocking(move || super::memtier::query("tony", "tony", &q, k, chars, false))).await;
        let recall = match looked {
            Ok(Ok(hits)) => super::learning::neutral(&super::memtier::recall_block("EARLIER WITH NIC (your memory; use only if relevant)", &hits)),
            _ => {
                emit(Hop::Memory, "memory recall skipped (lookup budget) — answering directly", false, t0.elapsed().as_millis(), Some("recall timed out"));
                String::new()
            }
        };
        format!("{recall}{}", scroll_summary_block(super::hygiene::seed_text().as_deref(), hp.scroll_summary_chars as usize))
    } else {
        String::new()
    };
    // Phase 3b: Tony's dispatch packet (spoken_reply + tasks), on his own turns outside Learning
    // and the novelty overlay. Off in os.json (`roster.tonyPackets`) → plain prose as before.
    let packets = role == "general" && !learning && !mode.is_novelty && cfg.roster.tony_packets;
    let contract = tony_live_contract(packets, &mode, &cfg.switchboard);
    // The MODE block is the LAST block, right before `/no_think`: everything above it (persona,
    // the full roster, style) is the same in every mode, so a switch keeps the cached prefix.
    let tail = tony_turn_tail(&learned_block, &tony_recall, &contract, &mode_block);
    let mut msgs = vec![ChatMessage::new("system", tony_system(tony_turn_system(&sys, &sys_tool_note, &format!("{tier2}{frozen_hint}"), &tail), tony_model(state).as_deref(), cfg.compute.deep_thinking))];
    super::arbiter::get().note_context(msgs.iter().map(|m| m.content.len()).sum::<usize>() + history_chars);
    msgs.extend(history);
    msgs.push(ChatMessage::new("user", user_msg));

    let t_model = Instant::now();
    let answer = match (tony_stream(app.is_some(), req.stream_id.is_some(), sink.is_some()), app, req.stream_id.as_deref(), sink) {
        // D2: an inbox turn — Tony's answer goes to the phone (via the gateway), not the webview.
        (TonyStream::Sink, _, _, Some(sink)) => run_chat_streamed_into(state, os, msgs.clone(), Some(90), sink).await,
        (TonyStream::Events, Some(app), Some(sid), _) => super::dispatch::run_chat_streamed(state, os, msgs.clone(), Some(90), app, sid).await,
        _ => run_chat(state, os, msgs.clone(), Priority::Interactive, None, Some(90)).await,
    };
    match &answer {
        Ok(r) => emit_with(Hop::Model, &model_label(state, &r.provider_id), true, t_model.elapsed().as_millis(), None, r.tps, &[]),
        Err(e) => emit_with(Hop::Model, &format!("{} chat chain", cfg.os_name), false, t_model.elapsed().as_millis(), Some(e), None, &super::devqueue::known_secrets(state, os)),
    }
    let res = match answer {
        Ok(r) => r,
        Err(e) => {
            let mut e = e;
            if cfg.overseer.auto_escalate {
                steps.push(step("error", "os", "user", format!("local chain failed: {e}"), false, 0));
                let t0 = Instant::now();
                // A user is waiting on this turn: the external engine gets 30 s, not 180 s.
                let escalated = overseer_call(state, os, &cfg, &msgs, OverseerOrigin::Turn).await;
                match &escalated {
                    Ok((_, engine, _)) => emit(Hop::Model, &format!("overseer · {engine}"), true, t0.elapsed().as_millis(), None),
                    Err(e) => emit_with(Hop::Model, "overseer", false, t0.elapsed().as_millis(), Some(e), None, &super::devqueue::known_secrets(state, os)),
                }
                match escalated {
                    Ok((answer, engine, redacted)) => {
                        steps.push(step("overseer", &engine, "os", "auto-escalated", true, t0.elapsed().as_millis()));
                        let out = OsTurnResult {
                            answer,
                            steps,
                            provider_id: engine,
                            delegated_to,
                            tool: tool_used,
                            latency_ms: started.elapsed().as_millis(),
                            reason: "auto-escalated to overseer".into(),
                            redacted,
                            comms_thread: comms_thread.clone(),
                            routed_role: role.clone(),
                            route_reason: route_reason.clone(),
                            route_kind: route_kind.clone(),
                            pending_spotify: None,
                            answered_by: "overseer".into(),
                            learned: vec![],
                            dispatch: None,
                        };
                        log_turn(bridge, &role, &text, &out, &known);
                        return Ok(out);
                    }
                    // The overseer failed too: never drop an agent reply that DID arrive — fall
                    // through to the raw-reply hand-over below (as without auto-escalation).
                    Err(oe) => {
                        steps.push(step("error", "overseer", "os", format!("overseer failed: {oe}"), false, t0.elapsed().as_millis()));
                        e = format!("{e}; overseer: {oe}");
                    }
                }
            }
            // The sub-agent answered but no model is up to summarize: hand it over as-is.
            if let Some(a) = agent_answer {
                let out = OsTurnResult {
                    answer: a,
                    steps,
                    provider_id: format!("anythingllm:{}", delegated_to.clone().unwrap_or_default()),
                    delegated_to,
                    tool: tool_used,
                    latency_ms: started.elapsed().as_millis(),
                    reason: format!("synthesis failed ({e}) — raw agent reply"),
                    redacted: false,
                    comms_thread: comms_thread.clone(),
                    routed_role: role.clone(),
                    route_reason: route_reason.clone(),
                    route_kind: route_kind.clone(),
                    pending_spotify: None,
                    answered_by: "agent".into(),
                    learned: vec![],
                    dispatch: None,
                };
                log_turn(bridge, &role, &text, &out, &known);
                return Ok(out);
            }
            // Nothing answered. What Tony DID send and hear (the delegate prompt, the agent's
            // error, tool results) still reaches the chat and the audit log.
            let known = super::devqueue::known_secrets(state, os);
            emit_steps(app, req.stream_id.as_deref(), &steps, emitted, &known);
            log_failed_turn(bridge, &role, &text, &steps, &e, &known);
            if !req.explicit {
                let mut shown = steps.clone();
                scrub_steps(&mut shown, &known);
                record_turn(conv, &text, &shown, None, Some(&e), &known);
            }
            return Err(e);
        }
    };
    // If the model's final answer is itself bare JSON or a tool-call (it
    // decided to "answer" with the router shape instead of prose), ask it
    // once more for plain sentences rather than showing/speaking raw JSON.
    // `[[LEARN …]]` lines never reach the chat, TTS or logs; they are saved only in Learning mode.
    let (content, drafts) = if role == "general" { super::learning::parse_tags(&res.content) } else { (res.content, vec![]) };
    let content = if content.trim().is_empty() && !drafts.is_empty() { "Got it, saved.".to_string() } else { content };
    // The packet: its spoken_reply is the answer; its tasks go through the mode gate.
    let mut dispatch_view = None;
    let packet = if packets { super::tony_dispatch::parse(&content) } else { None };
    let answer_text = match packet {
        Some(Ok(d)) => {
            dispatch_view = super::tony_dispatch::route(app, os, &d);
            d.spoken_reply
        }
        Some(Err(e)) => {
            eprintln!("[tony] dispatch packet refused: {e}");
            dispatch_view = Some(super::tony_dispatch::DispatchView { id: format!("pkt-{}", super::arbiter::now_ms()), state: "invalid".into(), priority: "normal".into(), reason: super::envelope::clip(&e, 200), tasks: vec![] });
            match super::tony_dispatch::spoken_of(&content) {
                Some(sp) => sp,
                None => ensure_prose(state, os, &msgs, content).await,
            }
        }
        None => ensure_prose(state, os, &msgs, content).await,
    };
    let learned = match (&pathways, learning && !drafts.is_empty()) {
        (Some(p), true) => commit_lessons(app, p, &drafts, &known),
        _ => vec![],
    };
    if role == "general" && private_turn(&role, &text, None).is_none() && !answer_text.trim().is_empty() {
        let digest = format!("Nic: {} | Tony: {}", super::envelope::clip(&super::envelope::one_line(&text), 180), super::envelope::clip(&super::envelope::one_line(&answer_text), 220));
        super::memtier::put("tony", "tony", &super::devqueue::scrub(&digest, &known), &["turn"]);
    }
    let out = OsTurnResult {
        answer: answer_text,
        steps,
        provider_id: res.provider_id,
        delegated_to,
        tool: tool_used,
        latency_ms: started.elapsed().as_millis(),
        reason: res.reason,
        redacted: res.redacted,
        comms_thread,
        routed_role: role.clone(),
        route_reason,
        route_kind,
        pending_spotify: None,
        answered_by: "os".into(),
        learned,
        dispatch: dispatch_view,
    };
    log_turn(bridge, &role, &text, &out, &known);
    Ok(out)
}

/// Learning mode: save the reply's lessons (memory trace hop for the System Map), then re-index
/// the store in the Librarian's workspace in the background (never delays the reply).
fn commit_lessons(app: Option<&tauri::AppHandle>, path: &std::path::Path, drafts: &[super::learning::Draft], known: &[String]) -> Vec<super::learning::Saved> {
    use super::trace::{emit, Hop};
    let t0 = Instant::now();
    match super::learning::commit(path, drafts, super::compaction::now_ms(), known) {
        Ok(saved) => {
            let changed = saved.iter().filter(|s| s.outcome != "unchanged").count();
            emit(Hop::Memory, &format!("learning · {changed} pathway(s) saved"), true, t0.elapsed().as_millis(), None);
            if let (true, Some(app)) = (changed > 0, app) {
                let (app, path) = (app.clone(), path.to_path_buf());
                tauri::async_runtime::spawn(async move {
                    use tauri::Manager;
                    let t0 = Instant::now();
                    let r = super::learning::index(app.state::<DispatchState>().inner(), app.state::<OsState>().inner(), path).await;
                    emit(Hop::Memory, "learning · pathways indexed (librarian storage)", r.is_ok(), t0.elapsed().as_millis(), r.as_ref().err().map(|_| "Librarian index failed"));
                });
            }
            saved
        }
        Err(e) => {
            eprintln!("[learning] save failed: {e}");
            emit(Hop::Memory, "learning · pathway save", false, t0.elapsed().as_millis(), Some("couldn't write the pathway store"));
            vec![]
        }
    }
}

/// The delegate step as the chat shows it: the request as sent, with the attached identity file
/// and live tool data named (and sized) instead of pasted. Pure.
pub(crate) fn delegate_shown(base: &str, identity: bool, tool_chars: usize) -> String {
    let mut s = base.to_string();
    if identity {
        s.push_str("\n\n[+ MASTER_IDENTITY.md attached]");
    }
    if tool_chars > 0 {
        s.push_str(&format!("\n\n[+ live tool data attached: {tool_chars} chars]"));
    }
    s
}

/// Emit `steps[from..]` as `os-step` events for the turn's stream (scrubbed), so the webview can
/// show what was sent / answered even when the turn then fails or is cut. Returns the new mark.
fn emit_steps(app: Option<&tauri::AppHandle>, stream_id: Option<&str>, steps: &[OsStep], from: usize, known: &[String]) -> usize {
    if let (Some(app), Some(sid)) = (app, stream_id) {
        use tauri::Emitter;
        for (i, s) in steps.iter().enumerate().skip(from) {
            let mut s = s.clone();
            s.text = super::devqueue::scrub(&s.text, known);
            let _ = app.emit("os-step", json!({ "streamId": sid, "index": i, "step": s }));
        }
    }
    steps.len()
}

/// Every step's text through the secret scrub (tool output / agent replies can carry a token
/// pasted into an email or a doc). Pure.
pub(crate) fn scrub_steps(steps: &mut [OsStep], known: &[String]) {
    for s in steps {
        s.text = super::devqueue::scrub(&s.text, known);
    }
}

// ── D2: Tony's answer streamed into a sink (inbox turns) ────────────────────

/// Where Tony's final model call streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TonyStream {
    /// An inbox turn's `AnswerSink` (D2): the phone gets it through the gateway.
    Sink,
    /// `tony-token` events under the desktop turn's stream id (the webview's live bubble / voice).
    Events,
    /// One plain call (no streaming).
    Off,
}

/// Pure. A sink wins (only an inbox turn has one, and no webview listens for it); otherwise the
/// desktop's own streaming, exactly as before.
pub(crate) fn tony_stream(app: bool, stream_id: bool, sink: bool) -> TonyStream {
    if sink {
        TonyStream::Sink
    } else if app && stream_id {
        TonyStream::Events
    } else {
        TonyStream::Off
    }
}

/// One OpenAI-style SSE answer as it arrives, parsed the way `dispatch::run_chat_streamed`
/// parses it: `data:` lines, `[DONE]` or a `finish_reason` (a complete answer), `usage`, and the
/// content deltas through the think filter. Lines are split on raw bytes, so a character split
/// across two network chunks is never mangled. Pure.
#[derive(Default)]
pub(crate) struct SseAnswer {
    buf: Vec<u8>,
    filter: super::dispatch::ThinkFilter,
    /// The visible (think-filtered) answer so far.
    pub(crate) content: String,
    /// The model finished ([DONE] / a finish_reason); a stream that just stops is cut off.
    pub(crate) completed: bool,
    deltas: u32,
    usage_tokens: Option<u64>,
    first_at: Option<Instant>,
    last_at: Option<Instant>,
}

impl SseAnswer {
    /// Feed one network chunk; every new visible piece goes to `on_text`, in order.
    pub(crate) fn push(&mut self, chunk: &[u8], on_text: &mut dyn FnMut(&str)) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                self.completed = true;
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if v["choices"][0]["finish_reason"].as_str().is_some_and(|r| !r.is_empty()) {
                self.completed = true;
            }
            if let Some(u) = v["usage"]["completion_tokens"].as_u64() {
                self.usage_tokens = Some(u);
            }
            if let Some(d) = v["choices"][0]["delta"]["content"].as_str().filter(|d| !d.is_empty()) {
                self.deltas = self.deltas.saturating_add(1);
                let now = Instant::now();
                self.last_at = Some(now);
                self.first_at.get_or_insert(now);
                let shown = self.filter.feed(d);
                if !shown.is_empty() {
                    self.content.push_str(&shown);
                    on_text(&shown);
                }
            }
        }
    }

    /// End of stream: the think filter's held-back tail (never an unclosed think block).
    pub(crate) fn finish(&mut self, on_text: &mut dyn FnMut(&str)) {
        let tail = std::mem::take(&mut self.filter).finish();
        if !tail.is_empty() {
            self.content.push_str(&tail);
            on_text(&tail);
        }
    }

    fn tps(&self) -> Option<f64> {
        let (f, l) = (self.first_at?, self.last_at?);
        super::trace::tokens_per_sec(self.deltas, self.usage_tokens, l.duration_since(f).as_secs_f64() * 1000.0)
    }
}

/// D2: Tony's answer with token streaming into `sink` instead of `tony-token` events, so an
/// inbox turn reaches the phone as it is written and the desktop webview never sees it. The same
/// provider choice, GPU slot, think filter, cut-off mark and fallbacks as
/// `dispatch::run_chat_streamed` (keep the two in step): the first chain provider when it is
/// local, else one plain `run_chat`, which streams nothing.
pub(crate) async fn run_chat_streamed_into(state: &DispatchState, os: &OsState, messages: Vec<ChatMessage>, max_secs: Option<u64>, sink: &AnswerSink) -> Result<super::dispatch::DispatchResult, String> {
    use super::dispatch::{stream_outcome, DispatchResult, Kind, CUT_OFF_MARK};
    use futures_util::StreamExt;
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let first = cfg.policy.chain.iter().filter_map(|id| cfg.providers.iter().find(|p| &p.id == id && p.kind.is_chat())).next().cloned();
    let chars: usize = messages.iter().map(|m| m.content.len()).sum();
    let vram = if osc.compute.mode == os_core::ComputeMode::Hybrid { os_core::vram_pct().await } else { None };
    let shaped = first.map(|p| os_core::shape_chain(&osc, vec![p], vram, chars, false).0).unwrap_or_default();
    let Some(p) = shaped.into_iter().next().filter(|p| p.kind == Kind::Local && p.id != "anythingllm" && !os_core::is_remote(p)) else {
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    };
    let started = Instant::now();
    let slot = os.slot.acquire(&format!("{} · Tony (streaming)", p.id), true, osc.scheduler.tony_priority_pct).await;
    let mut body = json!({ "model": p.model, "messages": messages, "stream": true });
    if !osc.compute.deep_thinking {
        body["reasoning_effort"] = json!("none");
    }
    let mut rb = state.http.post(format!("{}/chat/completions", p.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(max_secs.unwrap_or(cfg.policy.local_timeout_secs))).json(&body);
    if let Some(k) = state.key_for(&p)? {
        rb = rb.bearer_auth(k);
    }
    let res = match rb.send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(_) => {
            drop(slot);
            return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
        }
    };
    let mut stream = res.bytes_stream();
    let mut sse = SseAnswer::default();
    let mut on_text = |t: &str| sink(t);
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        sse.push(&chunk, &mut on_text);
    }
    sse.finish(&mut on_text);
    if sse.content.trim().is_empty() {
        drop(slot);
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    }
    let (content, reason) = stream_outcome(sse.content.trim(), sse.completed);
    if !sse.completed {
        sink(CUT_OFF_MARK);
    }
    Ok(DispatchResult { provider_id: p.id.clone(), content, fell_back: false, reason, latency_ms: started.elapsed().as_millis(), redacted: false, tps: sse.tps() })
}

#[cfg(test)]
mod answer_sink_tests {
    use super::super::allm::mock::{start, Resp};
    use super::*;
    use std::sync::{Arc, Mutex};

    /// D2: only an inbox turn (it has a sink) streams there; desktop turns stream exactly as
    /// before (`tony-token` events with a stream id, else one plain call).
    #[test]
    fn only_an_inbox_turn_streams_into_a_sink() {
        assert_eq!(tony_stream(true, false, true), TonyStream::Sink, "an inbox turn");
        assert_eq!(tony_stream(true, true, true), TonyStream::Sink, "even if the phone sent a stream id");
        assert_eq!(tony_stream(false, false, true), TonyStream::Sink);
        assert_eq!(tony_stream(true, true, false), TonyStream::Events, "a desktop turn");
        assert_eq!(tony_stream(true, false, false), TonyStream::Off);
        assert_eq!(tony_stream(false, true, false), TonyStream::Off);
    }

    fn sse(deltas: &[&str], finish: bool) -> String {
        let mut s: String = deltas.iter().map(|d| format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": d } }] }))).collect();
        if finish {
            s.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"completion_tokens\":9}}\n\ndata: [DONE]\n\n");
        }
        s
    }

    /// The SSE parse hands out the think-filtered answer in order, whatever the network chunking
    /// (even one byte at a time, splitting multi-byte characters).
    #[test]
    fn sse_answers_stream_think_filtered_and_survive_any_chunking() {
        let body = sse(&["<thi", "nk>plan the reply</th", "ink>Hi Nic", ", café ", "😀. Done."], true);
        for size in [1, 3, 7, body.len()] {
            let mut a = SseAnswer::default();
            let mut got = Vec::<String>::new();
            for chunk in body.as_bytes().chunks(size) {
                a.push(chunk, &mut |t| got.push(t.to_string()));
            }
            a.finish(&mut |t| got.push(t.to_string()));
            assert_eq!(got.concat(), "Hi Nic, café 😀. Done.", "chunk size {size}");
            assert_eq!(a.content, got.concat());
            assert!(a.completed, "finish_reason / [DONE]");
            assert!(!got.iter().any(|g| g.contains("plan") || g.contains('<')), "{got:?}");
        }
        let mut a = SseAnswer::default();
        a.push(sse(&["Half an ans"], false).as_bytes(), &mut |_| {});
        assert!(!a.completed, "a stream that just stops is not complete");
    }

    fn sink_into(got: &Arc<Mutex<Vec<String>>>) -> AnswerSink {
        let g = got.clone();
        Arc::new(move |t: &str| g.lock().unwrap().push(t.to_string()))
    }

    fn local_llm(base: &str) -> (DispatchState, OsState) {
        let state = DispatchState::default();
        state
            .update(|c| {
                c.providers.iter_mut().find(|p| p.id == "lmstudio").unwrap().base_url = format!("{base}/v1");
                Ok(())
            })
            .unwrap();
        let os = OsState::default();
        os.update(|c| {
            c.compute.mode = os_core::ComputeMode::Local;
            Ok(())
        })
        .unwrap();
        (state, os)
    }

    /// D2: an inbox turn's answer streams into its sink as the model writes it (think-filtered),
    /// and the returned answer is the same text.
    #[test]
    fn tonys_answer_streams_into_the_sink() {
        tauri::async_runtime::block_on(async {
            let srv = start(|r| {
                if r.path.ends_with("/chat/completions") {
                    Resp::sse(vec![
                        json!({ "choices": [{ "delta": { "content": "<think>hmm</think>Hi Nic. " } }] }),
                        json!({ "choices": [{ "delta": { "content": "The build " } }] }),
                        json!({ "choices": [{ "delta": { "content": "is green." }, "finish_reason": "stop" }] }),
                    ])
                } else {
                    Resp::status(404, json!({}))
                }
            })
            .await;
            let (state, os) = local_llm(&srv.base);
            let got: Arc<Mutex<Vec<String>>> = Arc::default();
            let r = run_chat_streamed_into(&state, &os, vec![ChatMessage::new("user", "status?")], Some(10), &sink_into(&got)).await.unwrap();
            assert_eq!(r.content, "Hi Nic. The build is green.");
            assert_eq!(r.provider_id, "lmstudio");
            let got = got.lock().unwrap().clone();
            assert_eq!(got, vec!["Hi Nic. ", "The build ", "is green."], "piece by piece, as generated");
            let req = srv.reqs().into_iter().find(|q| q.path.ends_with("/chat/completions")).unwrap();
            assert_eq!(req.body["stream"], json!(true));
        });
    }

    /// D2: a stream the model never finished is marked cut off in the sink too, so the phone's
    /// partial matches the answer it then gets.
    #[test]
    fn a_cut_off_answer_is_marked_in_the_sink() {
        tauri::async_runtime::block_on(async {
            let srv = start(|_| {
                let mut r = Resp::sse(vec![json!({ "choices": [{ "delta": { "content": "The landing page has three" } }] })]);
                r.abort = true;
                r
            })
            .await;
            let (state, os) = local_llm(&srv.base);
            let got: Arc<Mutex<Vec<String>>> = Arc::default();
            let r = run_chat_streamed_into(&state, &os, vec![ChatMessage::new("user", "the page?")], Some(10), &sink_into(&got)).await.unwrap();
            assert!(r.content.ends_with(super::super::dispatch::CUT_OFF_MARK), "{}", r.content);
            assert_eq!(got.lock().unwrap().concat(), r.content);
        });
    }
}

/// Roles whose turns never reach `training_logs/` as text: the folder is read by memory harvest
/// (fine-tune pairs) and uploaded by Drive sync. Finance phrases route to `ops` until a Finance
/// agent exists.
const PRIVATE_LOG_ROLES: [&str; 3] = ["booking", "ops", "finance"];

/// Why a turn's text stays out of the training log, if it does: a private role, a comms-history
/// recall (other people's messages), or a request about money / bookkeeping on any route. Pure.
pub(crate) fn private_turn(role: &str, text: &str, delegated_to: Option<&str>) -> Option<&'static str> {
    static FINANCE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let finance = FINANCE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(?:receipts?|invoices?|invoic(?:e|ed|ing)|cheques?|hst|gst|income|salary|salaries|wages?|paycheck|paycheque|bank(?:ing)?|expenses?|bookkeeping|taxe?s|budget(?:s|ing)?|refunds?|reimburse\w*|owe[sd]?|debts?|loans?|mortgage|rent payment|credit card|debit card)\b|[$£€]\s?\d",
        )
        .unwrap()
    });
    match role {
        "booking" => Some("booking"),
        "ops" | "finance" => Some("finance"),
        _ if delegated_to == Some("comms-history") => Some("comms"),
        _ if finance.is_match(text) => Some("finance"),
        _ => None,
    }
}

/// The text fields of a turn record: scrubbed of known secrets, or replaced by a length marker
/// for a private turn (which is also flagged so memory harvest never turns it into a pair).
fn turn_text(private: Option<&str>, text: &str, known: &[String]) -> Value {
    match private {
        Some(kind) => json!(format!("[private {kind} turn: {} chars]", text.chars().count())),
        None => json!(super::devqueue::scrub(text, known)),
    }
}

/// The audit-log record of a turn that produced no answer (its steps still count).
fn log_failed_turn(bridge: &BridgeState, role: &str, text: &str, steps: &[OsStep], err: &str, known: &[String]) {
    let private = private_turn(role, text, None);
    let mut rec = json!({
        "type": "os-turn",
        "role": role,
        "upstream": turn_text(private, text, known),
        "error": super::devqueue::scrub(&err.chars().take(300).collect::<String>(), known),
        "steps": steps.len(),
        "stepKinds": steps.iter().map(|s| format!("{}:{}→{}", s.kind, s.from, s.to)).collect::<Vec<_>>(),
    });
    if let Some(kind) = private {
        rec["private"] = json!(kind);
        // The error can quote the request (or the agent's reply to it).
        rec["error"] = json!("[private]");
    }
    bridge.log(rec);
}

/// The whole trimmed reply is itself a JSON object / fenced JSON / tool-call
/// wrapper (not merely prose that happens to mention `{…}` somewhere) — the
/// model answered in the router's shape instead of talking to the user.
fn looks_like_bare_json(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    (t.starts_with('{') || t.starts_with("```json") || t.starts_with("<tool_call>")) && extract_json(t).is_some()
}

/// Re-ask once, in plain sentences, when the final answer is bare JSON/a
/// tool-call (Part 6 §3). Best-effort: any failure, or a retry that's still
/// bare JSON, keeps the original text rather than losing the answer.
async fn ensure_prose(state: &DispatchState, os: &OsState, msgs: &[ChatMessage], content: String) -> String {
    if !looks_like_bare_json(&content) {
        return content;
    }
    let mut retry = msgs.to_vec();
    retry.push(ChatMessage::new("user", "Answer that in plain sentences for the user — no JSON, no tool-call syntax."));
    match run_chat(state, os, retry, Priority::Interactive, None, Some(20)).await {
        Ok(r) if !looks_like_bare_json(&r.content) => r.content,
        _ => content,
    }
}

fn log_turn(bridge: &BridgeState, role: &str, text: &str, r: &OsTurnResult, known: &[String]) {
    bridge.log(turn_record(role, text, r, known));
}

/// The `os-turn` training-log record. Pure (tests read it).
fn turn_record(role: &str, text: &str, r: &OsTurnResult, known: &[String]) -> Value {
    let private = private_turn(role, text, r.delegated_to.as_deref());
    let mut rec = json!({
        "type": "os-turn",
        "role": role,
        "upstream": turn_text(private, text, known),
        "downstream": turn_text(private, &r.answer, known),
        "provider": r.provider_id,
        "delegatedTo": r.delegated_to,
        "tool": r.tool,
        "steps": r.steps.len(),
        "latencyMs": r.latency_ms as u64,
    });
    if let Some(kind) = private {
        rec["private"] = json!(kind);
    }
    rec
}

// ── Overseer / external engines ─────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverseerRequest {
    question: String,
    #[serde(default)]
    transcript: Vec<ChatMessage>,
    #[serde(default)]
    context: String,
    /// Override the configured engine for this one call.
    engine: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverseerResult {
    answer: String,
    engine: String,
    latency_ms: u128,
    redacted: bool,
}

#[tauri::command]
pub async fn overseer_ask(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: OverseerRequest) -> Result<OverseerResult, String> {
    let started = Instant::now();
    let mut cfg = os.snapshot();
    if let Some(e) = req.engine {
        cfg.overseer.engine = e;
    }
    let sys = format!(
        "You are the Overseer: a senior reviewer that {} (the user's local AI OS) escalates to. Review the conversation, correct mistakes, \
and give the best concrete answer or next step. Be direct and brief. Values like [CLIENT_1] or [EMAIL_1] are privacy placeholders — keep them as-is.\n\nLIVE DASHBOARD:\n{}",
        cfg.os_name,
        req.context.chars().take(2000).collect::<String>()
    );
    let mut msgs = vec![ChatMessage::new("system", sys)];
    msgs.extend(req.transcript.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev());
    msgs.push(ChatMessage::new("user", req.question));
    let (answer, engine, redacted) = overseer_call(&state, &os, &cfg, &msgs, OverseerOrigin::Explicit).await?;
    bridge.log(json!({ "type": "overseer", "engine": engine, "redacted": redacted, "latencyMs": started.elapsed().as_millis() as u64 }));
    Ok(OverseerResult { answer, engine, latency_ms: started.elapsed().as_millis(), redacted })
}

/// Who an overseer call is for, which sets the external engine's time budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverseerOrigin {
    /// Auto-escalation inside a live turn (`run_os_turn`: desktop chat and voice, a phone inbox
    /// turn). Someone is waiting, and the local chain has already failed once.
    Turn,
    /// `overseer_ask`: "Ask the Overseer", the manual-mode card review, the Settings check. The
    /// user asked for the slow reviewer, so it keeps the long budget.
    Explicit,
}

/// Seconds an external overseer engine (Claude / Gemini, CLI or API) gets. Pure. A live turn
/// caps it at 30 s instead of making the user wait up to three minutes on a cold CLI.
pub(crate) fn overseer_external_secs(origin: OverseerOrigin) -> u64 {
    match origin {
        OverseerOrigin::Turn => 30,
        OverseerOrigin::Explicit => 180,
    }
}

async fn overseer_call(state: &DispatchState, os: &OsState, cfg: &OsConfig, msgs: &[ChatMessage], origin: OverseerOrigin) -> Result<(String, String, bool), String> {
    match cfg.overseer.engine.as_str() {
        "droplet" => {
            let r = run_chat(state, os, msgs.to_vec(), Priority::Interactive, Some("droplet".into()), Some(120)).await?;
            Ok((r.content, "droplet".into(), r.redacted))
        }
        "local" => {
            let r = run_chat(state, os, msgs.to_vec(), Priority::Interactive, Some("verifier".into()), Some(120)).await?;
            Ok((r.content, r.provider_id, r.redacted))
        }
        engine => {
            let (a, red) = external_chat(state, os, engine, msgs, overseer_external_secs(origin)).await?;
            Ok((a, engine.to_string(), red))
        }
    }
}

#[cfg(test)]
mod overseer_budget_tests {
    use super::*;

    #[test]
    fn a_live_turn_caps_the_external_overseer_at_30_s() {
        assert_eq!(overseer_external_secs(OverseerOrigin::Turn), 30);
    }

    #[test]
    fn an_explicit_overseer_ask_keeps_the_long_budget() {
        assert_eq!(overseer_external_secs(OverseerOrigin::Explicit), 180);
    }
}

/// Claude / Gemini via CLI or API. Kill switch + cloud permission enforced,
/// prompt diffused and the reply re-hydrated locally.
pub(crate) async fn external_chat(state: &DispatchState, os: &OsState, engine: &str, messages: &[ChatMessage], max_secs: u64) -> Result<(String, bool), String> {
    external_chat_in(state, os, engine, messages, max_secs, None).await
}

/// `external_chat` with the CLI's working directory (the worker's offloaded Coder runs inside
/// `staging/<slug>`). A CLI that outlives its timeout is killed with its whole process tree.
pub(crate) async fn external_chat_in(state: &DispatchState, os: &OsState, engine: &str, messages: &[ChatMessage], max_secs: u64, cwd: Option<&std::path::Path>) -> Result<(String, bool), String> {
    external_chat_abortable(state, os, engine, messages, max_secs, cwd, None).await
}

/// `external_chat_in` with an abort token: a CLI engine's whole process tree is killed as soon
/// as the token fires (an API engine is cancelled by dropping the future).
pub(crate) async fn external_chat_abortable(state: &DispatchState, os: &OsState, engine: &str, messages: &[ChatMessage], max_secs: u64, cwd: Option<&std::path::Path>, abort: Option<std::sync::Arc<super::job_abort::Token>>) -> Result<(String, bool), String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err("kill switch is on — external engines are blocked".into());
    }
    if cfg.compute.mode == os_core::ComputeMode::Local {
        return Err("LOCAL ONLY mode — external engines are blocked".into());
    }
    if cfg.permissions.cloud == super::bridge::Tier::Deny {
        return Err("PERMISSION_DENIED:cloud".into());
    }
    let mut red = super::privacy::Redactor::default();
    let msgs: Vec<ChatMessage> = if cfg.privacy.diffuser {
        messages.iter().map(|m| ChatMessage::new(&m.role, red.redact(&m.content, &cfg.privacy.sensitive_terms))).collect()
    } else {
        messages.to_vec()
    };
    if cfg.privacy.diffuser {
        os.record_redaction(&format!("ext:{engine}"), serde_json::to_value(&msgs).unwrap_or_default(), red.replacements.clone());
    }
    let secs = max_secs.clamp(10, 600);
    let out = match engine {
        "claude-cli" => cli(&["claude.cmd", "claude"], &["-p", "--output-format", "text"], flatten(&msgs), secs, cwd, abort.clone()).await?,
        "gemini-cli" => cli(&["gemini.cmd", "gemini"], &[], flatten(&msgs), secs, cwd, abort.clone()).await?,
        "llm-cli" => cli(&["llm.exe", "llm"], &["prompt"], flatten(&msgs), secs, cwd, abort.clone()).await?,
        "claude-api" => claude_api(state, &cfg, &msgs, secs).await?,
        "gemini-api" => gemini_api(state, &cfg, &msgs, secs).await?,
        other => return Err(format!("unknown engine {other}")),
    };
    let redacted = !red.replacements.is_empty();
    Ok((red.rehydrate(out.trim()), redacted))
}

fn flatten(msgs: &[ChatMessage]) -> String {
    msgs.iter().map(|m| format!("### {}\n{}", m.role.to_uppercase(), m.content)).collect::<Vec<_>>().join("\n\n")
}

/// Kill a process and every descendant (`taskkill /T /F`): an npm-shim CLI (`claude.cmd`)
/// runs node as a grandchild that `Child::kill` alone would orphan.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x0800_0000).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Run a fixed CLI with the prompt on stdin (never on the command line), optionally inside `cwd`.
async fn cli(programs: &[&'static str], args: &[&'static str], input: String, secs: u64, cwd: Option<&std::path::Path>, abort: Option<std::sync::Arc<super::job_abort::Token>>) -> Result<String, String> {
    let programs = programs.to_vec();
    let args = args.to_vec();
    let cwd = cwd.map(std::path::Path::to_path_buf);
    if let Some(d) = &cwd {
        if !d.is_dir() {
            return Err(format!("CLI working directory {} does not exist", d.display()));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = String::new();
        for program in programs {
            // Resolve npm/uv shims explicitly (no PATHEXT lookup in CreateProcess).
            let resolved = super::clihub::resolve(program.trim_end_matches(".cmd").trim_end_matches(".exe"));
            let mut c = match &resolved {
                Some(p) => Command::new(p),
                None => Command::new(program),
            };
            c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            if let Some(d) = &cwd {
                c.current_dir(d);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            let mut child = match c.spawn() {
                Ok(ch) => ch,
                Err(e) => {
                    last = format!("{program}: {e}");
                    continue;
                }
            };
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            let input = input.clone();
            std::thread::spawn(move || {
                let _ = stdin.write_all(input.as_bytes());
            });
            let mut out = child.stdout.take().ok_or("no stdout")?;
            let mut err = child.stderr.take().ok_or("no stderr")?;
            let reader = std::thread::spawn(move || {
                let mut s = String::new();
                let _ = out.read_to_string(&mut s);
                s
            });
            let ereader = std::thread::spawn(move || {
                let mut s = String::new();
                let _ = err.read_to_string(&mut s);
                s
            });
            let deadline = Instant::now() + Duration::from_secs(secs);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let o = reader.join().unwrap_or_default();
                        let e = ereader.join().unwrap_or_default();
                        if status.success() && !o.trim().is_empty() {
                            return Ok(o);
                        }
                        return Err(format!("{program} failed: {}", if e.trim().is_empty() { o } else { e }.chars().take(300).collect::<String>()));
                    }
                    Ok(None) if Instant::now() > deadline => {
                        kill_tree(&mut child);
                        return Err(format!("{program} timed out after {secs}s"));
                    }
                    Ok(None) if abort.as_ref().is_some_and(|a| a.is_aborted()) => {
                        kill_tree(&mut child);
                        return Err(super::job_abort::CANCELLED.into());
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(150)),
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        Err(format!("CLI not installed ({last})"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Anthropic Messages API (raw HTTP — there is no official Rust SDK).
async fn claude_api(state: &DispatchState, cfg: &OsConfig, msgs: &[ChatMessage], secs: u64) -> Result<String, String> {
    // env / repo .env / keychain. Safe for an unscoped env key: the host below is hard-coded.
    let key = super::envfile::os_key(state, "anthropic").ok_or("add an Anthropic API key in Settings → Integrations → Overseer, or set ANTHROPIC_API_KEY in the repo-root .env")?;
    let system: Vec<&str> = msgs.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
    // Alternate user/assistant, merging consecutive same-role turns; must start with user.
    let mut turns: Vec<(String, String)> = Vec::new();
    for m in msgs.iter().filter(|m| m.role != "system") {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        match turns.last_mut() {
            Some((r, c)) if r == role => {
                c.push_str("\n\n");
                c.push_str(&m.content);
            }
            _ => turns.push((role.into(), m.content.clone())),
        }
    }
    if turns.first().is_some_and(|t| t.0 == "assistant") {
        turns.insert(0, ("user".into(), "(conversation so far)".into()));
    }
    let body = json!({
        "model": cfg.overseer.claude_model,
        "max_tokens": 16000,
        "system": system.join("\n\n"),
        "messages": turns.iter().map(|(r, c)| json!({ "role": r, "content": c })).collect::<Vec<_>>(),
        "output_config": { "effort": "medium" },
        // Server-side refusal fallback: a declined turn is retried on a suitable model.
        "fallbacks": "default",
    });
    let r = state
        .http
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .json(&body)
        .timeout(Duration::from_secs(secs))
        .send()
        .await
        .map_err(short)?;
    let status = r.status();
    let v: Value = r.json().await.map_err(short)?;
    if !status.is_success() {
        return Err(format!("Claude API {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("error")));
    }
    if v["stop_reason"] == "refusal" {
        return Err(format!("Claude declined ({})", v["stop_details"]["category"].as_str().unwrap_or("policy")));
    }
    let text: Vec<&str> = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    if text.is_empty() {
        return Err("Claude returned no text".into());
    }
    Ok(text.join("\n"))
}

async fn gemini_api(state: &DispatchState, cfg: &OsConfig, msgs: &[ChatMessage], secs: u64) -> Result<String, String> {
    // env / repo .env / keychain. Safe for an unscoped env key: the host below is hard-coded.
    let key = super::envfile::os_key(state, "gemini").ok_or("add a Gemini API key in Settings → Integrations → Overseer, or set GEMINI_API_KEY in the repo-root .env")?;
    let system: Vec<&str> = msgs.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
    let contents: Vec<Value> = msgs
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| json!({ "role": if m.role == "assistant" { "model" } else { "user" }, "parts": [{ "text": m.content }] }))
        .collect();
    let model = &cfg.overseer.gemini_model;
    if !model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("invalid Gemini model id".into());
    }
    let r = state
        .http
        .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&json!({ "systemInstruction": { "parts": [{ "text": system.join("\n\n") }] }, "contents": contents }))
        .timeout(Duration::from_secs(secs))
        .send()
        .await
        .map_err(short)?;
    let status = r.status();
    let v: Value = r.json().await.map_err(short)?;
    if !status.is_success() {
        return Err(format!("Gemini API {}: {}", status.as_u16(), v["error"]["message"].as_str().unwrap_or("error")));
    }
    let text: Vec<&str> = v["candidates"][0]["content"]["parts"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect();
    if text.is_empty() {
        return Err("Gemini returned no text".into());
    }
    Ok(text.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(answer: &str, delegated_to: Option<&str>) -> OsTurnResult {
        OsTurnResult {
            answer: answer.into(),
            steps: vec![],
            provider_id: "lmstudio".into(),
            delegated_to: delegated_to.map(String::from),
            tool: None,
            latency_ms: 12,
            reason: String::new(),
            redacted: false,
            comms_thread: None,
            routed_role: "general".into(),
            route_reason: String::new(),
            route_kind: "Default".into(),
            pending_spotify: None,
            answered_by: "os".into(),
            learned: vec![],
            dispatch: None,
        }
    }

    #[test]
    fn private_turns_never_reach_the_training_log_as_text() {
        // Booking and finance (ops) routes, a comms recall, and money talk on Tony's own route.
        for (role, text, deleg, kind) in [
            ("booking", "book the Thursday callback with Sam", None, "booking"),
            ("ops", "log the deck job hours", None, "finance"),
            ("finance", "categorise last week", None, "finance"),
            ("general", "what did Maria say about the shoot", Some("comms-history"), "comms"),
            ("general", "how much HST did I pay on the Home Depot receipt", None, "finance"),
            ("general", "add $42.10 to the gear budget", None, "finance"),
        ] {
            let rec = turn_record(role, text, &turn("The receipt total was $118.40 with HST 13.62", deleg), &[]);
            assert_eq!(rec["private"], kind, "{role}: {text}");
            let line = rec.to_string();
            assert!(!line.contains(text) && !line.contains("118.40"), "text leaked: {line}");
            assert_eq!(rec["upstream"], format!("[private {kind} turn: {} chars]", text.chars().count()));
            assert_eq!(rec["latencyMs"], 12);
        }
    }

    #[test]
    fn ordinary_turns_keep_their_text_scrubbed_of_secrets() {
        let known = vec!["hunter2-secret-value".to_string()];
        let rec = turn_record("general", "what's the weather in Toronto", &turn("Sunny; key hunter2-secret-value and api_key=abcdef1234567890", None), &known);
        assert!(rec["private"].is_null());
        assert_eq!(rec["upstream"], "what's the weather in Toronto");
        let down = rec["downstream"].as_str().unwrap();
        assert!(!down.contains("hunter2-secret-value") && !down.contains("abcdef1234567890") && down.starts_with("Sunny"), "{down}");
        // Everyday words that are not money talk stay logged.
        for t in ["check the weather", "play some jazz", "build me a protein calculator"] {
            assert_eq!(private_turn("general", t, None), None, "{t}");
        }
    }

    #[test]
    fn recall_intent() {
        let (w, t) = comms_recall_intent("Hey Tony, look at my conversation with Sam and tell me what they said about the shoot").unwrap();
        assert_eq!(w, "Sam");
        assert_eq!(t, "the shoot");
        let (w, _) = comms_recall_intent("what did Maria Lopez text me yesterday?").unwrap();
        assert_eq!(w, "Maria Lopez");
        assert!(comms_recall_intent("what's the weather").is_none());
    }

    #[test]
    fn tool_hint() {
        assert!(wants_tools("what's the weather like"));
        assert!(wants_tools("read C:\\ai-hub\\README.md"));
        assert!(!wants_tools("tell me a joke"));
        // Part 2's widened gaps: the exact refusal-causing phrases from the MCP map.
        // Whisper's "what's up" next to an app cue is WhatsApp (via routing::normalize).
        assert!(wants_tools("check my what's up"));
        assert!(wants_tools("check my whatsapp"));
        assert!(wants_tools("last message in my WhatsApp group"));
        assert!(wants_tools("any texts from Sam?"));
        assert!(wants_tools("what's in my inbox"));
        // Generic verbs alone no longer wake the router.
        assert!(!wants_tools("integrate this into Cloud Code"));
        assert!(!wants_tools("open the latest status page"));
        assert!(!wants_tools("find me a good name for the band"));
    }

    /// Regression: the raw `what'?s ?up` alternative sent every greeting through
    /// run_tool_router (an extra LLM routing call, up to 15 s) before Tony answered.
    #[test]
    fn a_whats_up_greeting_never_wakes_the_tool_router() {
        for line in ["Hey Tony, what's up?", "what's up", "whats up", "what's up tony", "hey what's up, any updates?", "so I'm on my phone now hey tony what's up"] {
            assert!(!wants_tools(line), "a greeting is not a tool request: {line}");
        }
        // The app itself, spelled or misheard next to an app cue, still reaches the router.
        for line in ["check my whatsapp", "check my WhatsApp", "check my what's up", "open whats up", "any what's up messages", "check my whats app"] {
            assert!(wants_tools(line), "WhatsApp request: {line}");
        }
    }

    fn gmail_tools() -> Vec<super::super::mcp::ToolInfo> {
        super::super::mcp::builtin_tools("gmail")
    }

    #[test]
    fn gmail_plan_reads_recent_mail() {
        let plan = |t: &str| gmail_plan(t, &gmail_tools());
        assert_eq!(plan("Hey Tony, can you read me my last Gmail mail?"), Some(("gmail.recent".into(), json!({ "count": 1 }))));
        assert_eq!(plan("what's my latest email"), Some(("gmail.recent".into(), json!({ "count": 1 }))));
        assert_eq!(plan("read my last three e-mails"), Some(("gmail.recent".into(), json!({ "count": 3 }))));
        assert_eq!(plan("most recent emails please"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("check my inbox"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("Hey Tony, check Gmail").unwrap().0, "gmail.recent");
        assert_eq!(plan("check gmail").unwrap().0, "gmail.recent");
        assert_eq!(plan("check inbox").unwrap().0, "gmail.recent");
        assert_eq!(plan("open the inbox").unwrap().0, "gmail.recent");
        assert_eq!(plan("check email").unwrap().0, "gmail.recent");
        assert_eq!(plan("any new emails?"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("do I have unread mail"), Some(("gmail.recent".into(), json!({ "count": 5 }))));
        assert_eq!(plan("last 99 emails").unwrap().1["count"], 20);
    }

    #[test]
    fn gmail_plan_searches_by_sender() {
        assert_eq!(gmail_plan("any emails from Sam?", &gmail_tools()), Some(("gmail.search".into(), json!({ "query": "from:Sam", "limit": 5 }))));
        assert_eq!(gmail_plan("show me emails from Maria Lopez about the shoot", &gmail_tools()).unwrap().1["query"], "from:\"Maria Lopez\"");
        assert_eq!(gmail_plan("last email from sam@acme.ca.", &gmail_tools()).unwrap().1["query"], "from:sam@acme.ca");
    }

    #[test]
    fn gmail_plan_needs_email_words_and_the_tool() {
        assert!(gmail_plan("check my last 5 whatsapp messages", &gmail_tools()).is_none());
        assert!(gmail_plan("what's the weather", &gmail_tools()).is_none());
        assert!(gmail_plan("read my last email", &[]).is_none());
        // Without gmail.search, a sender request falls back to recent mail.
        let recent_only: Vec<_> = gmail_tools().into_iter().filter(|t| t.name == "gmail.recent").collect();
        assert_eq!(gmail_plan("any new emails from Sam", &recent_only).unwrap().0, "gmail.recent");
        // Email beats WhatsApp in the combined plan.
        let mut all = gmail_tools();
        all.extend(whatsapp_tool());
        assert_eq!(deterministic_plan("read my last email", &all, "Tony").unwrap().0, "gmail.recent");
        assert_eq!(deterministic_plan("check my whatsapp", &all, "Tony").unwrap().0, "whatsapp.list_messages");
        assert_eq!(deterministic_plan("any unread messages in my WhatsApp inbox?", &all, "Tony").unwrap().0, "whatsapp.list_messages");
        assert_eq!(gmail_plan("any unread emails, not texts", &gmail_tools()).unwrap().0, "gmail.recent");
    }

    #[test]
    fn router_keyword_gate() {
        let n = super::super::routing::normalize;
        assert!(router_keyword_ok("gmail", &n("anything in my E-mail?")));
        assert!(router_keyword_ok("gmail", &n("check the inbox")));
        assert!(!router_keyword_ok("gmail", &n("integrate this into Cloud Code")));
        assert!(router_keyword_ok("whatsapp", &n("what did the group say on what's app")));
        assert!(router_keyword_ok("whatsapp", &n("any new messages")));
        assert!(!router_keyword_ok("whatsapp", &n("what's the weather")));
        assert!(router_keyword_ok("weather", &n("anything")));
    }

    #[test]
    fn router_lines_carry_args_and_an_example() {
        let line = router_tool_line(&gmail_tools()[1]);
        assert!(line.starts_with("- gmail.search(query, limit?): "), "{line}");
        assert!(line.ends_with(r#"e.g. {"args":{"query":"<query>"},"tool":"gmail.search"}"#), "{line}");
    }

    #[test]
    fn review_feed4_a_delegation_card_approves_the_delegation_gate_only() {
        let req = |v: Value| {
            let r = serde_json::from_value::<OsTurnRequest>(v).unwrap();
            turn_approvals(r.approved, r.delegation_approved)
        };
        // The Tier-3 card: delegation yes, Ask-tier tools (gmail / fs / MCP) still unapproved.
        assert_eq!(req(json!({ "text": "x", "role": "booking", "delegationApproved": true })), (true, false));
        // The turn's own card (gated() re-run): both.
        assert_eq!(req(json!({ "text": "x", "role": "booking", "approved": true })), (true, true));
        // Missing (phone / old webview): neither.
        assert_eq!(req(json!({ "text": "x", "role": "booking" })), (false, false));
    }

    #[test]
    fn failure_note_is_honest() {
        let failure = ("gmail.recent".to_string(), "Gmail: no backend — add it".to_string());
        let note = tool_note("Tony", "", Some(&failure));
        assert!(note.contains("[TOOL FAILURE - gmail.recent]: Gmail: no backend — add it. Tell the user what failed in one short sentence, no apology; never say you lack the tool or the skill."));
        assert!(!note.contains("live tool access"));
        let ok = tool_note("Tony", "\n\n[LIVE MCP TOOL DATA - gmail]:\n1 email", None);
        assert!(ok.contains("You have live tool access through Tony") && !ok.contains("TOOL FAILURE"));
        assert_eq!(tool_note("Tony", "", None), "");
        assert_eq!(humanize_tool_error("PERMISSION_REQUIRED:mcp"), "the mcp permission is set to Ask and this turn wasn't approved");
        assert_eq!(humanize_tool_error("PERMISSION_READ_ONLY:sqlite — SQLite is set to read-only, so sqlite.write_query is blocked"), "SQLite is set to read-only, so sqlite.write_query is blocked");
    }

    #[test]
    fn tools_section_lists_names_and_never_lacks_skill() {
        let tools: Vec<_> = gmail_tools().into_iter().filter(|t| t.name == "gmail.recent").chain(super::super::mcp::builtin_tools("weather")).collect();
        let s = tools_section(&tools, true);
        assert!(s.contains("TOOLS YOU HAVE THIS TURN: gmail.recent, weather.current."));
        assert!(s.contains("never that you lack the tool or the skill"));
        assert!(s.contains("don't claim it's done or queued"));
        assert!(!s.contains("SPOTIFY IS CONNECTED"));
        assert!(tools_section(&[], true).contains("none switched on"));
        assert!(tools_section(&[], false).contains("none switched on"));
    }

    #[test]
    fn plain_questions_get_no_meta_apology_lines() {
        let tools: Vec<_> = gmail_tools().into_iter().filter(|t| t.name == "gmail.recent").chain(spotify_tools()).collect();
        let plain = tools_section(&tools, false);
        assert!(plain.contains("TOOLS YOU HAVE THIS TURN:") && plain.contains("SPOTIFY IS CONNECTED"), "{plain}");
        for cue in ["couldn't start it", "don't claim it's done or queued", "say it didn't start", "exact phrasing", "never that you lack the tool or the skill"] {
            assert!(!plain.contains(cue), "plain question prompt carries {cue:?}: {plain}");
        }
        let action = tools_section(&tools, true);
        assert!(action.contains("couldn't start it") && action.contains("say it didn't start") && action.contains("has happened only if a spotify.* LIVE MCP TOOL DATA"), "{action}");
        // Both keep the honesty line about Spotify being connected.
        assert!(plain.contains("Never say Spotify isn't active") && action.contains("Never say Spotify isn't active"));
        // Every Tony prompt carries the no-meta rule; only an action turn the "couldn't start" line.
        let cfg = OsConfig::default();
        let q = system_prompt(&cfg, "", &tools, false);
        assert!(q.contains(NO_META) && !q.contains("couldn't start it"));
        assert!(system_prompt(&cfg, "", &tools, true).contains("couldn't start it"));
        assert!(!q.to_lowercase().contains("json"), "persona text must not mention json (skip_agentic_os)");
    }

    #[test]
    fn tony_persona_rules() {
        let cfg = OsConfig { identity_path: "Z:/definitely/missing/MASTER_IDENTITY.md".into(), ..Default::default() };
        let s = system_prompt(&cfg, "", &[], false);
        // Addressing (a constant, not config): Nic, sometimes Nicholas or Nicky.
        assert!(s.contains("Call him Nic, sometimes Nicholas or Nicky"), "{s}");
        // Tier-1 confirmations are one line.
        assert!(s.contains("\"Got it, Nic.\"") && s.contains("\"Alright man, got it.\""), "{s}");
        // No meta-apologies, no AI/limits talk, no architecture/dashboard tours, no unasked recaps.
        assert!(s.contains("at most \"My bad.\""), "{s}");
        assert!(s.contains("never talk about being an AI or a model"), "{s}");
        assert!(s.contains("never describe your agents, tools, routing, prompts, settings or dashboard unless Nic asks"), "{s}");
        assert!(s.contains("No unasked recaps"), "{s}");
        assert!(s.contains("1 to 3 short sentences"), "{s}");
        // "take it easy" is the stand-down phrase; the gabagool line is deterministic (persona.ts), never the LLM's.
        assert!(s.contains("Never say \"take it easy\"") && s.contains("never bring up gabagool"), "{s}");
        // ROOT AUTHORITY keeps its safety sentences verbatim.
        assert!(s.contains("Actions that change the world (send, book, pay, delete) always go through the user's confirmation card — never claim you performed one."), "{s}");
        assert!(s.contains("never claim you lack real-time access"), "{s}");
        assert!(s.contains("You are Tony; never call yourself Jarvis, Hermes or a generic AI."), "{s}");
        // The Settings pointer is gone; the pinned substring stays.
        assert!(s.contains("none switched on") && !s.contains("Settings →"), "{s}");
        // skip_agentic_os must not flip, and the persona stays compact.
        assert!(!s.to_ascii_lowercase().contains("json"), "{s}");
        assert!(TONY_STYLE.chars().count() <= 900, "TONY_STYLE is {} chars", TONY_STYLE.chars().count());
        // Part 7: Nic's Tony prompt is merged in (+1.3k chars at most), still free of the format word.
        assert!(s.starts_with("You are Tony, Nic's main AI operating system, conversational front-end, and persistent memory anchor."), "{s}");
        assert!(s.contains(super::super::agent_prompts::TONY_ROLE), "{s}");
        assert!(!s.contains("dispatch_to_prompter") && !s.contains("/no_think"), "{s}");
        assert!(s.chars().count() <= 3500, "bare Tony prompt is {} chars", s.chars().count());
    }

    #[test]
    fn tony_no_think_is_the_last_line_for_a_thinking_model_only() {
        let base = format!("{}{}", system_prompt(&OsConfig::default(), "", &[], false), tier2_hint(false));
        let t = tony_system(base.clone(), Some("qwen/qwen3.5-9b"), false);
        assert_eq!(t.lines().last(), Some("/no_think"));
        // Phase 2 Part C: with the MODE block (every preset), `/no_think` is still the last line,
        // once, and the block sits right before it.
        for m in super::super::modes::presets() {
            let f = super::super::modes::ModesFile { active_mode_id: m.id.clone(), ..Default::default() };
            let block = super::super::modes::mode_block(&super::super::modes::effective(&f, &Default::default()));
            let sys = tony_turn_system(&system_prompt(&OsConfig::default(), "", &[], false), "", &tier2_hint(!block.is_empty()), &block);
            let t = tony_system(sys.clone(), Some("qwen/qwen3.5-9b"), false);
            assert_eq!(t.lines().last(), Some("/no_think"), "{}", m.id);
            assert_eq!(t.matches("/no_think").count(), 1, "{}", m.id);
            assert!(t.starts_with(&sys) && sys.ends_with(&block), "{}", m.id);
            if !block.is_empty() {
                assert!(t.contains("MODE: ") && t.find("MODE: ").unwrap() < t.find("/no_think").unwrap(), "{}", m.id);
            }
            assert!(!super::super::dispatch::skip_agentic_os(&[ChatMessage::new("system", t)], None), "{}", m.id);
        }
        assert_eq!(t.matches("/no_think").count(), 1);
        assert!(t.starts_with(&base) && !super::super::dispatch::skip_agentic_os(&[ChatMessage::new("system", t.clone())], None));
        assert_eq!(tony_system(base.clone(), Some("qwen/qwen3.5-9b"), true), base, "Deep thinking on");
        assert_eq!(tony_system(base.clone(), Some("google/gemma-4-e4b"), false), base);
        assert_eq!(tony_system(base.clone(), None, false), base);
    }

    #[test]
    fn action_shaped_lines_are_commands_not_questions() {
        for t in ["play some bilmuri", "Hey Tony, pause the music", "skip this song", "put on some music", "send a whatsapp to Sam saying I'm late", "draft an email to sam@acme.ca about the shoot", "reply to Maria", "text Sam that I'm running late", "tony, email the forecast to Sam"] {
            assert!(action_shaped(t, "Tony"), "{t}");
        }
        for t in ["what's the time", "thanks tony", "what do you think about the layout", "any whatsapp updates", "what role does redis play", "who emailed me today", "how's the weather", "what's playing"] {
            assert!(!action_shaped(t, "Tony"), "{t}");
        }
    }

    #[test]
    fn canon_turn_role_folds_self_aliases() {
        for r in ["tony", "Tony", " general ", "dispatcher", "orchestrator", "os", "jarvis"] {
            assert_eq!(canon_turn_role(r, "Tony"), "general", "{r}");
        }
        assert_eq!(canon_turn_role("friday", "Friday"), "general");
        assert_eq!(canon_turn_role("booking", "Tony"), "booking");
        assert_eq!(role_label("general", "Tony"), "Tony");
        assert_eq!(role_label("tony", "Friday"), "Friday");
        assert_eq!(role_label("booking", "Tony"), "Booking Desk");
    }

    #[test]
    fn route_for_turn_never_routes_to_tony() {
        let cfg = OsConfig::default();
        let rt = |role: &str, explicit: bool, text: &str, kind: Option<&str>| route_for_turn(&TurnRouteInput { role, explicit, text, route_kind: kind, route_reason: None, no_delegate: false, solo: false, learning: false, stay_with_tony: false }, &cfg);
        // Self address: stays general, kind Self.
        for text in ["thanks tony", "tony what do you think", "system status", "ask the dispatcher to check the build"] {
            let r = rt("general", false, text, None);
            assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"), "{text}");
        }
        // Phone / inbox: role "tony" with a stale Named kind is a self address, not a route.
        let r = rt("tony", false, "tony what do you think", Some("Named"));
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"));
        // A real delegation through Tony still reaches the agent.
        let r = rt("general", false, "ask tony to ask the coder to fix the build", None);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("coder", "Named"));
        // The caller's Tab / explicit turns are untouched; Direct reads stay Tony's.
        assert_eq!(rt("prompter", true, "what's the time", Some("Tab")).role, "prompter");
        let r = rt("general", false, "any whatsapp updates", None);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Direct"));
        // A caller-resolved Default with no hit stays Default.
        assert_eq!(rt("general", false, "good morning", None).kind, "Default");
        // The phone's Default is re-resolved against the full config…
        let r = rt("general", false, "redo the color palette and layout", Some("Default"));
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("designer", "Domain"));
        // …but a caller that already decided Tony answers (voice on a tab, Self) is never re-promoted.
        let r = rt("general", false, "redo the color palette and layout", Some("Self"));
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"));
    }

    #[test]
    fn route_for_turn_no_delegate_keeps_tony() {
        let cfg = OsConfig::default();
        let rt = |text: &str, kind: Option<&str>, no_delegate: bool| route_for_turn(&TurnRouteInput { role: "general", explicit: false, text, route_kind: kind, route_reason: None, no_delegate, solo: false, learning: false, stay_with_tony: false }, &cfg);
        // Without the flag the phone's Default is re-promoted to the Designer (today's net)…
        let r = rt("redo the color palette and layout", Some("Default"), false);
        assert_eq!(r.role, "designer");
        // …with it (Tier 2), Tony keeps the brainstorm: no safety net, no delegation.
        for text in ["what if the layout used a sidebar", "redo the color palette and layout", "help me write a prompt for the landing page"] {
            for kind in [None, Some("Default"), Some("Domain"), Some("Self")] {
                let r = rt(text, kind, true);
                assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"), "{text} {kind:?}");
            }
        }
        // A stale caller role is still forced back to Tony.
        let r = route_for_turn(&TurnRouteInput { role: "designer", explicit: false, text: "what if the layout used a sidebar", route_kind: Some("Domain"), route_reason: None, no_delegate: true, solo: false, learning: false, stay_with_tony: false }, &cfg);
        assert_eq!(r.role, "general");
        // A live-tool read stays Tony's Direct path.
        assert_eq!(rt("any whatsapp updates", None, true).kind, "Direct");
    }

    #[test]
    fn os_turn_request_no_delegate_defaults_false() {
        let r: OsTurnRequest = serde_json::from_value(serde_json::json!({ "text": "hi", "role": "general" })).unwrap();
        assert!(!r.no_delegate);
        let r: OsTurnRequest = serde_json::from_value(serde_json::json!({ "text": "hi", "role": "general", "noDelegate": true })).unwrap();
        assert!(r.no_delegate);
    }

    /// Integration review (C): the phone's `stayWithTony` rides on the turn request.
    #[test]
    fn os_turn_request_stay_with_tony_is_camel_case_and_defaults_false() {
        let r: OsTurnRequest = serde_json::from_value(serde_json::json!({ "text": "hi", "role": "general" })).unwrap();
        assert!(!r.stay_with_tony, "desktop / an older phone");
        let r: OsTurnRequest = serde_json::from_value(serde_json::json!({ "text": "hi", "role": "general", "stayWithTony": true })).unwrap();
        assert!(r.stay_with_tony);
        let r: OsTurnRequest = serde_json::from_value(serde_json::json!({ "text": "hi", "role": "general", "stayWithTony": false })).unwrap();
        assert!(!r.stay_with_tony);
    }

    fn phone_turn<'a>(text: &'a str, route_kind: Option<&'a str>, stay_with_tony: bool) -> TurnRouteInput<'a> {
        TurnRouteInput { role: "general", explicit: false, text, route_kind, route_reason: None, no_delegate: false, solo: false, learning: false, stay_with_tony }
    }

    /// Integration review (C): the phone kept a topic hit with Tony (TS `routeFor` 'phone'), but
    /// the Rust safety net re-resolved its Default turn and handed it to the Domain agent anyway.
    #[test]
    fn route_for_turn_keeps_a_phone_topic_with_tony() {
        let cfg = OsConfig::default();
        for (text, agent) in [("redo the color palette and layout", "designer"), ("write code for a timer script", "coder")] {
            // Desktop (no flag): the safety net still promotes the Default turn.
            let r = route_for_turn(&phone_turn(text, Some("Default"), false), &cfg);
            assert_eq!((r.role.as_str(), r.kind.as_str()), (agent, "Domain"), "{text}");
            // Phone: the topic stays with Tony.
            for kind in [None, Some("Default")] {
                let r = route_for_turn(&phone_turn(text, kind, true), &cfg);
                assert_eq!(r, TurnRoute { role: "general".into(), kind: "Self".into(), reason: STAY_WITH_TONY_REASON.into() }, "{text} {kind:?}");
            }
        }
        assert_eq!(STAY_WITH_TONY_REASON, "on the phone a topic stays with Tony");
        // A live-tool read is still Tony's Direct path.
        assert_eq!(route_for_turn(&phone_turn("any whatsapp updates", None, true), &cfg).kind, "Direct");
    }

    /// Integration review (C): `stayWithTony` holds topics only; a Named address still routes.
    #[test]
    fn route_for_turn_phone_named_address_still_routes() {
        let cfg = OsConfig::default();
        for text in ["ask the coder to fix the build", "hey Coder, write a timer script", "ask tony to ask the coder to fix the build"] {
            for stay in [false, true] {
                let r = route_for_turn(&phone_turn(text, Some("Default"), stay), &cfg);
                assert_eq!((r.role.as_str(), r.kind.as_str()), ("coder", "Named"), "{text} stay={stay}");
            }
        }
        // A self address is still Tony's own turn, with or without the flag.
        let r = route_for_turn(&phone_turn("thanks tony", None, true), &cfg);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"));
        assert_ne!(r.reason, STAY_WITH_TONY_REASON);
    }

    /// Integration review (C): `stayWithTony` never holds the business route: a line naming a
    /// registered business with no topic hit stays an unrouted general Default turn (the only
    /// kind `business_route` looks at), and the hold covers Learning / Tier 2 / Solo only.
    #[test]
    fn a_phone_turn_still_reaches_the_business_route() {
        let cfg = OsConfig::default();
        let input = phone_turn("how's Corner Bakery doing?", Some("Default"), true);
        let r = route_for_turn(&input, &cfg);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Default"));
        assert!(!business_route_held(&input), "stayWithTony is not a business hold");
        let held = |no_delegate: bool, solo: bool, learning: bool| business_route_held(&TurnRouteInput { no_delegate, solo, learning, ..phone_turn("x", None, true) });
        assert!(held(true, false, false) && held(false, true, false) && held(false, false, true));
        assert!(!held(false, false, false));
    }

    #[test]
    fn tier2_hint_is_safe() {
        for h in [tier2_hint(false), tier2_hint(true)] {
            assert!(!h.to_lowercase().contains("json"), "{h}");
            assert!(h.contains("never say you saved"), "{h}");
            assert!(h.contains("Don't hand it to another agent"), "{h}");
        }
        // The style half (length / one question) rides only when no MODE block sets it.
        assert!(tier2_hint(false).contains("two or three short sentences"));
        assert!(!tier2_hint(true).contains("two or three short sentences"));
        assert_eq!(tier2_hint(false), format!("{TIER2_SAFETY}{TIER2_STYLE}"));
    }

    #[test]
    fn tony_prompt_with_each_mode_block_stays_compact_and_safe() {
        let cfg = OsConfig { identity_path: "Z:/definitely/missing/MASTER_IDENTITY.md".into(), ..Default::default() };
        let bare = system_prompt(&cfg, "", &[], false);
        for m in super::super::modes::presets() {
            let f = super::super::modes::ModesFile { active_mode_id: m.id.clone(), ..Default::default() };
            let block = super::super::modes::mode_block(&super::super::modes::effective(&f, &Default::default()));
            let s = tony_turn_system(&bare, "", "", &block);
            assert!(s.chars().count() <= 3500 + 700, "{} is {} chars", m.id, s.chars().count());
            assert!(!s.to_ascii_lowercase().contains("json"), "{}", m.id);
            assert!(!s.contains("/no_think"), "{}", m.id);
            // TONY_STYLE stays intact; the MODE block only adds rules after it.
            assert!(s.contains("1 to 3 short sentences") && s.contains(TONY_STYLE), "{}", m.id);
            assert_eq!(s.to_ascii_lowercase().matches("gabagool").count(), bare.to_ascii_lowercase().matches("gabagool").count(), "{}", m.id);
        }
    }

    #[test]
    fn roster_sentence_is_built_from_the_registry() {
        let cfg = OsConfig { identity_path: "Z:/definitely/missing/MASTER_IDENTITY.md".into(), ..Default::default() };
        // The default registry keeps today's sentence byte for byte.
        assert!(system_prompt(&cfg, "", &[], false).contains("You can hand work to nine local sub-agents (Librarian, Coder, Booking Desk, Ops, Operations Manager, Finance, Prompter, Designer, Director) and use local MCP tools;"));
        // A future specialist joins it with no code change.
        let mut more = cfg.clone();
        more.routing.agents.insert("security-patrol".into(), Default::default());
        let s = system_prompt(&more, "", &[], false);
        assert!(s.contains("ten local sub-agents (Librarian, Coder, Booking Desk, Ops, Operations Manager, Finance, Prompter, Designer, Director, Security Patrol)"), "{s}");
        assert_eq!(role_label("security-patrol", "Tony"), "Security Patrol");
        assert_eq!(role_label("finance", "Tony"), "Finance");
        assert_eq!(role_label("finance_2", "Tony"), "Finance 2");
        // Self ids never appear as a sub-agent.
        let mut selfy = cfg.clone();
        selfy.routing.agents.insert("tony".into(), Default::default());
        assert!(!sub_agent_roster(&selfy).iter().any(|r| r == "Tony"));
    }

    #[test]
    fn route_for_turn_learning_keeps_every_turn_with_tony() {
        let cfg = OsConfig::default();
        let rt = |role: &str, explicit: bool, text: &str, kind: Option<&str>| route_for_turn(&TurnRouteInput { role, explicit, text, route_kind: kind, route_reason: None, no_delegate: false, solo: true, learning: true, stay_with_tony: false }, &cfg);
        // A high-confidence Named address, an explicit tab, a Booking line and a live-tool read
        // all stay Tony's own turn in Learning mode.
        for (role, explicit, text, kind) in [
            ("coder", false, "hey Coder, write a timer script", Some("Named")),
            ("booking", true, "book a table for two", Some("Tab")),
            ("general", false, "book me a table at 7", Some("Default")),
            ("general", false, "what's on my calendar today", None),
        ] {
            let r = rt(role, explicit, text, kind);
            assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"), "{text}");
            assert_eq!(r.reason, "Learning mode: Tony only");
        }
    }

    #[test]
    fn route_for_turn_solo_keeps_pipeline_promotions_with_tony() {
        let cfg = OsConfig::default();
        let rt = |role: &str, explicit: bool, text: &str, kind: Option<&str>, solo: bool| route_for_turn(&TurnRouteInput { role, explicit, text, route_kind: kind, route_reason: None, no_delegate: false, solo, learning: false, stay_with_tony: false }, &cfg);
        // A Default line the safety net would hand to the Coder stays with Tony under Solo.
        assert_eq!(rt("general", false, "write code for a timer script", Some("Default"), false).role, "coder");
        let r = rt("general", false, "write code for a timer script", Some("Default"), true);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"));
        // A caller-resolved Domain hit on the Designer / Prompter stays with Tony too.
        for role in ["designer", "prompter", "coder"] {
            let r = rt(role, false, "redo the color palette and layout", Some("Domain"), true);
            assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"), "{role}");
        }
        // Explicit tab and Named are kept.
        assert_eq!(rt("coder", true, "fix the build", Some("Tab"), true).role, "coder");
        let r = rt("general", false, "ask the coder to fix the build", None, true);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("coder", "Named"));
        let r = rt("coder", false, "tell the coder to write a timer script", Some("Named"), true);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("coder", "Named"), "a high-confidence address survives Solo");
        // Fix pass: a caller's medium-confidence Named (a bare mention) is held under Solo…
        let r = rt("coder", false, "I think the coder should write a timer script", Some("Named"), true);
        assert_eq!((r.role.as_str(), r.kind.as_str()), ("general", "Self"));
        // …but not outside Solo.
        assert_eq!(rt("coder", false, "I think the coder should write a timer script", Some("Named"), false).role, "coder");
        // Direct live-tool reads still win.
        assert_eq!(rt("general", false, "any whatsapp updates", None, true).kind, "Direct");
        // Booking / Librarian / Ops routing is unchanged.
        let a = rt("booking", false, "check the casting call availability", Some("Domain"), true);
        let b = rt("booking", false, "check the casting call availability", Some("Domain"), false);
        assert_eq!(a, b);
        assert_eq!(a.role, "booking");
    }

    #[test]
    fn router_hop_never_points_tony_at_himself() {
        assert_eq!(router_hop_label("Default", "general", "Tony"), "Tony · direct (Default)");
        assert_eq!(router_hop_label("Self", "general", "Tony"), "Tony · direct (Self)");
        assert!(!router_hop_label("Direct", "general", "Tony").contains('→'));
        assert_eq!(router_hop_label("Named", "booking", "Tony"), "Named → Booking Desk");
    }

    #[test]
    fn tools_section_folds_spotify_into_one_compact_entry() {
        let mut tools = super::super::mcp::builtin_tools("weather");
        tools.extend(spotify_tools());
        tools.extend(super::super::mcp::builtin_tools("time"));
        let s = tools_section(&tools, true);
        // ONE entry where the first Spotify tool stood, instead of 23 names (and no args list).
        assert!(s.contains(&format!("TOOLS YOU HAVE THIS TURN: weather.current, {SPOTIFY_COMPACT}, time.now.")), "{s}");
        assert_eq!(SPOTIFY_COMPACT, "spotify.* (play, pause, next, previous, volume, now_playing, search, queue)");
        assert_eq!(s.matches("spotify.").count(), s.matches("spotify.*").count(), "no single Spotify tool name: {s}");
        assert!(!s.contains("spotify.play(") && !s.contains("uri") && !s.contains("_id"), "{s}");
        assert!(s.contains("SPOTIFY IS CONNECTED."));
        // Far shorter than the 23 names it replaces.
        let names: usize = spotify_tools().iter().map(|t| t.name.len() + 2).sum();
        assert!(SPOTIFY_COMPACT.len() * 3 < names, "{} vs {names}", SPOTIFY_COMPACT.len());
        // Sub-agents (reads only) keep the names and get no control line.
        let reads = super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), false);
        let r = tools_section(&reads, true);
        assert!(!r.contains("SPOTIFY IS CONNECTED") && r.contains("spotify.now_playing") && !r.contains(SPOTIFY_COMPACT), "{r}");
        // The command grammar still plans every Spotify tool (it reads the full list, not the line).
        assert_eq!(spotify_plan("skip this song", &spotify_tools(), "Tony").map(|p| p.0).as_deref(), Some("spotify.next"));
    }

    #[test]
    fn the_mode_block_ends_tonys_message_and_the_prefix_is_the_same_in_every_mode() {
        let cfg = OsConfig { identity_path: "Z:/definitely/missing/MASTER_IDENTITY.md".into(), ..Default::default() };
        let sys = system_prompt(&cfg, "", &[], false);
        let mut seen = vec![];
        for m in super::super::modes::presets() {
            let f = super::super::modes::ModesFile { active_mode_id: m.id.clone(), ..Default::default() };
            let e = super::super::modes::effective(&f, &Default::default());
            let block = super::super::modes::mode_block(&e);
            let tail = tony_turn_tail("\n\nLEARNED: x", "\n\nEARLIER: y", super::super::tony_dispatch::CONTRACT, &block);
            let msg = tony_system(tony_turn_system(&sys, "", "", &tail), Some("qwen/qwen3.5-9b"), false);
            // MODE is the last block, right before the /no_think line.
            let body = msg.trim_end_matches(super::super::agent_prompts::NO_THINK).trim_end();
            assert!(body.ends_with(block.trim_end()), "{}: {msg}", m.id);
            if !block.is_empty() {
                assert!(msg.find("OUTPUT CONTRACT").unwrap() < msg.find("\n\nMODE: ").unwrap(), "{}", m.id);
                assert!(msg.find("EARLIER: y").unwrap() < msg.find("\n\nMODE: ").unwrap(), "{}", m.id);
            }
            // Everything before the tail is byte-identical across modes (cache-stable prefix),
            // and the roster sentence keeps the FULL registry even when the mode froze agents.
            assert!(msg.starts_with(&sys), "{}", m.id);
            assert!(sys.contains("You can hand work to nine local sub-agents (Librarian, Coder, Booking Desk, Ops, Operations Manager, Finance, Prompter, Designer, Director)"));
            seen.push(block);
        }
        assert!(seen.iter().any(|b| b.contains("ON DUTY: Coder, Designer, Prompter;")));
        assert_eq!(tony_turn_tail("a", "b", "c", "d"), "abcd");
    }

    /// The `target_agent` list and the chain line of the contract inside a whole system message.
    fn contract_parts(msg: &str) -> (Vec<String>, String) {
        let (_, rest) = msg.split_once("\"target_agent\": \"").unwrap_or_else(|| panic!("no packet contract: {msg}"));
        let targets = rest.split('"').next().unwrap().split('|').map(str::to_string).collect();
        let chain = msg.lines().find_map(|l| l.strip_prefix("- Chain with depends_on: ")).unwrap_or_default().to_string();
        (targets, chain)
    }

    /// Source pin for the two call sites in `os_turn_traced` (the helpers are tested on their
    /// own; this guards the wiring, e.g. against a merge putting back the static CONTRACT or a
    /// direct `frozen_note(.., false)`). Split on lines, not "\n}\n", so CRLF checkouts work.
    #[test]
    fn os_turn_uses_the_live_contract_and_the_switchboard_note() {
        let src = include_str!("agents.rs");
        let lines: Vec<&str> = src.lines().collect();
        let start = lines.iter().position(|l| l.starts_with("async fn os_turn_traced(")).expect("os_turn_traced");
        let end = start + lines[start..].iter().position(|l| *l == "}").expect("end of os_turn_traced");
        let body = lines[start..=end].join("\n");
        assert!(body.contains("tony_live_contract(packets, &mode, &cfg.switchboard)"), "Tony's live turn must send the live-only contract");
        assert!(body.contains("switchboard_note(&routed_role, &held, &cfg.switchboard)"), "the held route must get the master/mode-aware note");
        assert!(!body.contains("tony_dispatch::CONTRACT"), "the static contract names frozen agents");
        assert!(!body.contains("frozen_note("), "go through switchboard_note, which knows a master freeze");
    }

    #[test]
    fn tonys_live_turn_sends_the_live_only_contract() {
        // The default master switchboard freezes the Librarian (and Booking) in every mode.
        let cfg = OsConfig { identity_path: "Z:/definitely/missing/MASTER_IDENTITY.md".into(), ..Default::default() };
        assert!(super::super::modes::agent_globally_frozen(&cfg.switchboard, "librarian"));
        let sys = system_prompt(&cfg, "", &[], false);
        let eff = |id: &str| super::super::modes::effective(&super::super::modes::ModesFile { active_mode_id: id.into(), ..Default::default() }, &Default::default());
        // Tony's whole live system message for `mode` under `g`, built the way os_turn_traced builds it.
        let whole = |mode: &str, g: &super::super::os_core::SwitchboardConfig| {
            let e = eff(mode);
            let contract = tony_live_contract(true, &e, g);
            let tail = tony_turn_tail("", "", &contract, &super::super::modes::mode_block(&e));
            tony_system(tony_turn_system(&sys, "", "", &tail), Some("qwen/qwen3.5-9b"), false)
        };
        // Builder: the Librarian is never a target_agent and never starts (or joins) the chain.
        let b = whole("builder", &cfg.switchboard);
        let (targets, chain) = contract_parts(&b);
        assert!(!targets.iter().any(|t| t == "librarian"), "{targets:?}");
        assert!(!chain.is_empty() && !chain.starts_with("librarian") && !chain.contains("librarian"), "{chain}");
        assert!(chain.starts_with("prompter locks the spec"), "{chain}");
        assert!(!b.contains("librarian stages context") && !b.contains("librarian finds and stages"), "{b}");
        // Every target the message names is live this turn.
        for t in &targets {
            assert!(super::super::modes::agent_live(&eff("builder"), &cfg.switchboard, t), "{t}");
        }
        // No overlay (Brainstorm) under the default master switchboard: still no Librarian.
        let (targets, chain) = contract_parts(&whole("brainstorm", &cfg.switchboard));
        assert!(!targets.iter().any(|t| t == "librarian") && !chain.contains("librarian"), "{targets:?} / {chain}");
        // Thawed on the master switchboard (Booking alone frozen): the Librarian leads again.
        let thawed = super::super::os_core::SwitchboardConfig { frozen_agents: vec!["booking".into()], ..Default::default() };
        let (targets, chain) = contract_parts(&whole("brainstorm", &thawed));
        assert!(targets.iter().any(|t| t == "librarian") && chain.starts_with("librarian stages context"), "{targets:?} / {chain}");
        // No packets (Learning, the novelty overlay, roster.tonyPackets off, a sub-agent turn): prose.
        assert_eq!(tony_live_contract(false, &eff("builder"), &cfg.switchboard), "");
    }

    #[test]
    fn switchboard_hold_keeps_frozen_agents_with_tony_but_lets_a_direct_ask_through() {
        let cfg = OsConfig::default();
        let eff = |id: &str| super::super::modes::effective(&super::super::modes::ModesFile { active_mode_id: id.into(), ..Default::default() }, &Default::default());
        let r = |role: &str, kind: &str| TurnRoute { role: role.into(), kind: kind.into(), reason: "caller".into() };
        let hold = |route: TurnRoute, explicit: bool, text: &str, mode: &str| switchboard_hold(route, explicit, text, &cfg, &eff(mode));
        // Automatic routing (topic, default, a business name) never reaches a frozen agent.
        let h = hold(r("coder", "Domain"), false, "write code for a timer script", "operations");
        assert_eq!((h.role.as_str(), h.kind.as_str(), h.reason.as_str()), ("general", "Self", "Coder is frozen in Operations mode"));
        let h = hold(r("bizops", "Domain"), false, "how's Corner Bakery doing", "builder");
        assert_eq!((h.role.as_str(), h.reason.as_str()), ("general", "Operations Manager is frozen in Builder mode"));
        // A medium Named (a bare mention) is held too, like Solo.
        assert_eq!(hold(r("coder", "Named"), false, "I think the coder should write a timer script", "operations").role, "general");
        // A DIRECT ask goes through: its own tab, or a high-confidence Named address.
        assert_eq!(hold(r("coder", "Tab"), true, "fix the build", "operations").role, "coder");
        assert_eq!(hold(r("coder", "Named"), false, "tell the coder to write a timer script", "operations").role, "coder");
        // On-duty agents and modes with no overlay are untouched; Tony's own turns too.
        assert_eq!(hold(r("coder", "Domain"), false, "write code", "builder"), r("coder", "Domain"));
        assert_eq!(hold(r("ops", "Domain"), false, "check the droplet", "brainstorm"), r("ops", "Domain"));
        assert_eq!(hold(r("general", "Self"), false, "hi", "operations"), r("general", "Self"));
        // Booking is frozen on the master switchboard: never runs, not even from its tab.
        for (kind, explicit, text) in [("Tab", true, "book a table"), ("Named", false, "hey booking desk, check my availability"), ("Domain", false, "casting call availability")] {
            let h = hold(r("booking", kind), explicit, text, "brainstorm");
            assert_eq!((h.role.as_str(), h.kind.as_str(), h.reason.as_str()), ("general", "Self", "Booking Desk is frozen on the master switchboard"), "{kind}");
        }
        // Thawed on the master switchboard: Booking routes as before.
        let mut thawed = cfg.clone();
        thawed.switchboard.frozen_agents.clear();
        assert_eq!(switchboard_hold(r("booking", "Domain"), false, "casting call availability", &thawed, &eff("brainstorm")).role, "booking");
        // Tony's note names the reason, and never the format word.
        let n = frozen_note("Coder is frozen in Operations mode", false);
        assert!(n.contains("Coder is frozen in Operations mode") && n.contains("offer to switch modes") && !n.to_lowercase().contains("json"), "{n}");
        // A master-switchboard freeze: switched off there, back once thawed there; no mode advice.
        let m = frozen_note("Booking Desk is frozen on the master switchboard", true);
        assert!(m.contains("Booking Desk is frozen on the master switchboard") && m.contains("switched off on the master switchboard") && m.contains("thawed there"), "{m}");
        assert!(!m.contains("switch modes") && !m.contains("offer to switch") && !m.to_lowercase().contains("json"), "{m}");
        // The turn's note follows where the freeze lives: Booking (master) vs the Coder (mode).
        let note = |routed: &str, explicit: bool, text: &str, mode: &str| switchboard_note(routed, &hold(r(routed, "Domain"), explicit, text, mode), &cfg.switchboard);
        let b = note("booking", false, "casting call availability", "brainstorm");
        assert!(b.contains("switched off on the master switchboard") && !b.contains("switch modes"), "{b}");
        let c = note("coder", false, "write code for a timer script", "operations");
        assert!(c.contains("Coder is frozen in Operations mode") && c.contains("offer to switch modes") && !c.contains("master switchboard"), "{c}");
        // The Librarian, frozen on the master switchboard AND off duty in Builder: the master wins.
        let l = note("librarian", false, "find the auth docs", "builder");
        assert!(l.contains("Librarian is frozen on the master switchboard") && l.contains("thawed there") && !l.contains("switch modes"), "{l}");
        // Not held (on duty, Tony's own turn, a direct ask through a mode freeze): no note.
        assert_eq!(note("coder", false, "write code", "builder"), "");
        assert_eq!(note("general", false, "hi", "operations"), "");
        assert_eq!(note("coder", true, "fix the build", "operations"), "");
    }

    #[test]
    fn the_router_is_offered_only_the_servers_a_line_needs() {
        let mut tools = vec![];
        for id in ["weather", "time", "fetch", "filesystem", "git", "knowledge-graph", "brave-search", "gmail", "maps"] {
            tools.extend(super::super::mcp::router_filter(&super::super::mcp::builtin_tools(id), true));
        }
        tools.push(super::super::mcp::ToolInfo { name: "shotcut.probe_media".into(), description: "x".into(), server: "shotcut".into(), args: vec![] });
        tools.push(super::super::mcp::ToolInfo { name: super::super::mcp::TONY_SET_MODE.into(), description: "x".into(), server: "tony".into(), args: vec!["mode".into()] });
        let names = |line: &str| router_offer(&tools, line, "Tony").iter().map(|t| t.name.clone()).collect::<Vec<_>>();
        assert_eq!(names("search the web for the best pizza in town"), vec!["web.search", super::super::mcp::TONY_SET_MODE]);
        assert_eq!(names("will it rain tomorrow in Lisbon"), vec!["weather.current", "time.now", super::super::mcp::TONY_SET_MODE]);
        assert_eq!(names(r"read C:\ai-hub\README.md"), vec!["fs.list", "fs.read", super::super::mcp::TONY_SET_MODE]);
        assert_eq!(names("fetch https://example.com/docs"), vec!["fetch.url", super::super::mcp::TONY_SET_MODE]);
        assert_eq!(names("what's the git status of the repo"), vec!["git.status", super::super::mcp::TONY_SET_MODE]);
        assert_eq!(names("what do you remember about the Corner Bakery project"), vec!["kg.search", super::super::mcp::TONY_SET_MODE]);
        assert!(names("render the self tape clip").contains(&"shotcut.probe_media".to_string()));
        assert!(!names("search the web for pizza").contains(&"shotcut.probe_media".to_string()));
        // The keyword-gated servers keep their gates.
        assert!(names("check my inbox").contains(&"gmail.recent".to_string()));
        assert!(!names("search the web for pizza").iter().any(|n| n.starts_with("gmail.") || n.starts_with("maps.")));
    }

    #[test]
    fn tony_router_prompt_offers_spotify_play_when_ready() {
        // Spotify ready → its listing is every builtin tool; Tony's filter keeps the allowlist.
        let mut ready = super::super::mcp::builtin_tools("spotify");
        ready.extend(gmail_tools());
        let offered_all = super::super::mcp::router_filter(&ready, true);
        for line in ["aye tony can you play some bilmuri", "put on something chill", "skip this song", "turn it up", "volume 30"] {
            assert!(wants_tools(line) || media_command(line, "Tony"), "{line}");
            let offered = router_offer(&offered_all, line, "Tony");
            let prompt = router_prompt(&offered, "", "");
            assert!(prompt.contains("- spotify.play(query?, type?, playlist_name?, device_name?, shuffle?)"), "{line}: {prompt}");
            assert!(prompt.contains("never use them for YouTube"), "{line}");
            assert!(!prompt.contains("gmail.create_draft"), "{line}");
            // No library words: no library edits on offer.
            assert!(!offered.iter().any(|t| super::super::spotify_intent::is_library_write(&t.name)), "{line}");
        }
        // A non-music line doesn't drag Spotify into the router.
        assert!(router_offer(&offered_all, "what's the weather", "Tony").iter().all(|t| t.server != "spotify"));
        // Sub-agents' routers never see playback.
        let sub = super::super::mcp::router_filter(&ready, false);
        assert!(!router_prompt(&router_offer(&sub, "play some jazz", "Tony"), "", "").contains("spotify.play("));
    }

    #[test]
    fn bare_media_verbs_inside_a_sentence_never_unlock_spotify_controls() {
        let offered_all = super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), true);
        for line in ["What role does Redis play in our stack?", "what's NVDA's trading volume", "what was the previous commit", "should I pause the migration"] {
            assert!(!media_command(line, "Tony"), "{line}");
            assert!(!router_offer(&offered_all, line, "Tony").iter().any(|t| super::super::mcp::is_spotify_actuator(&t.name)), "{line}");
        }
        assert!(!wants_tools("what role does redis play in our stack"));
        assert!(!wants_tools("what's NVDA's trading volume"));
        assert!(!wants_tools("should I pause the migration"));
        // Anchored commands and music lines still reach the router.
        assert!(media_command("Hey Tony, pause", "Tony") && media_command("next song", "Tony") && media_command("turn it down", "Tony"));
        assert!(router_offer(&offered_all, "is this song any good", "Tony").iter().any(|t| t.name == "spotify.now_playing"));
    }

    #[test]
    fn spotify_ready_respects_the_mcp_tier() {
        let mut cfg = OsConfig::default();
        let mut s = super::super::os_core::McpServer::default();
        s.id = "spotify".into();
        s.enabled = true;
        cfg.mcps = vec![s];
        cfg.permissions.mcp = super::super::bridge::Tier::Allow;
        assert!(spotify_ready(&cfg, || true));
        assert!(!spotify_ready(&cfg, || false));
        cfg.permissions.mcp = super::super::bridge::Tier::Deny;
        assert!(!spotify_ready(&cfg, || true), "Deny: Tony can't call Spotify, so it isn't ready");
        cfg.permissions.mcp = super::super::bridge::Tier::Allow;
        cfg.privacy.kill_switch = true;
        assert!(!spotify_ready(&cfg, || true));
    }

    #[test]
    fn tool_failure_for_the_model_drops_the_stderr_tail() {
        assert_eq!(without_stderr("SQLite: exited before replying to tools/call (exit code 1) — stderr: --api-key abc"), "SQLite: exited before replying to tools/call (exit code 1)");
        assert_eq!(without_stderr("plain error"), "plain error");
    }

    #[test]
    fn tools_preview_reports_names_only() {
        let all = {
            let mut v = gmail_tools();
            v.extend(super::super::mcp::builtin_tools("spotify"));
            v
        };
        let set = super::super::mcp::ToolSet { offered: super::super::mcp::router_filter(&all, true), all };
        let p = tools_preview(&set, true);
        assert!(p.all.contains(&"gmail.create_draft".to_string()));
        assert!(!p.router_offered.contains(&"gmail.create_draft".to_string()));
        assert!(p.router_offered.contains(&"spotify.play".to_string()));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["spotifyReady"], true);
        assert!(json["routerOffered"].is_array() && json["all"].is_array());
    }

    #[test]
    fn unparsed_play_lines_fail_honestly() {
        assert!(unparsed_play_request("play something", "Tony"));
        assert!(unparsed_play_request("aye tony play it", "Tony"));
        assert!(unparsed_play_request("put on some songs from the new bilmuri album please", "Tony"));
        assert!(!unparsed_play_request("play devil's advocate on my business plan", "Tony"));
        assert!(!unparsed_play_request("I want to play a game with you tonight after dinner", "Tony"));
        assert!(!unparsed_play_request("listen to me carefully", "Tony"));
        assert!(!unparsed_play_request("tell me a joke", "Tony"));
        assert!(!unparsed_play_request("play", "Tony"));
        // A music noun later in the line doesn't make it a playback request.
        assert!(!unparsed_play_request("Listen to me, the band needs a new name", "Tony"));
        assert!(!unparsed_play_request("listen to this album review I wrote and tell me if it's fair", "Tony"));
        assert!(unparsed_play_request("listen to the new album", "Tony"));
        assert!(unparsed_play_request("put on some music", "Tony"));
    }

    #[test]
    fn spotify_prompt_never_promises_playback() {
        let s = tools_section(&spotify_tools(), true);
        assert!(!s.contains("run when the user asks"), "{s}");
        assert!(s.contains("has happened only if a spotify.* LIVE MCP TOOL DATA"), "{s}");
    }

    #[test]
    fn sub_agents_never_get_playback_from_the_deterministic_plan() {
        let reads = super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), false);
        assert!(spotify_plan("skip this song and check the build", &reads, "Tony").is_none());
        assert!(spotify_plan("pause the music", &reads, "Tony").is_none());
        assert!(spotify_plan("play jazz on spotify", &reads, "Tony").is_none());
        assert_eq!(spotify_plan("what's playing", &reads, "Tony").map(|p| p.0).as_deref(), Some("spotify.now_playing"));
    }

    #[test]
    fn json_extracted() {
        assert_eq!(extract_json("sure: {\"tool\": null}").unwrap()["tool"], Value::Null);
    }

    #[test]
    fn bare_json_detection() {
        assert!(looks_like_bare_json(r#"{"tool": "x", "args": {}}"#));
        assert!(looks_like_bare_json("```json\n{\"a\": 1}\n```"));
        assert!(looks_like_bare_json(r#"<tool_call>{"tool": "x"}</tool_call>"#));
        // Prose that merely contains a brace somewhere is not "bare" JSON.
        assert!(!looks_like_bare_json("Sure — here's a plan: {\"tool\": \"x\"} is one option."));
        assert!(!looks_like_bare_json("The weather is 5°C and overcast."));
        assert!(!looks_like_bare_json(""));
    }

    fn whatsapp_tool() -> Vec<super::super::mcp::ToolInfo> {
        vec![super::super::mcp::ToolInfo {
            name: "whatsapp.list_messages".into(),
            description: "List messages".into(),
            server: "whatsapp".into(),
            args: vec!["limit".into(), "include_context".into(), "sender_phone_number".into(), "query".into()],
        }]
    }

    #[test]
    fn whatsapp_plan_extracts_limit_and_defaults() {
        let (name, args) = whatsapp_plan("check my last 5 whatsapp messages", &whatsapp_tool()).unwrap();
        assert_eq!(name, "whatsapp.list_messages");
        assert_eq!(args["limit"], 5);
        assert_eq!(args["include_context"], false);

        // Number word, not digit — exercises routing::normalize's conversion.
        let (_, args) = whatsapp_plan("what are my last five whatsapp texts", &whatsapp_tool()).unwrap();
        assert_eq!(args["limit"], 5);

        // No number at all → default 10.
        let (_, args) = whatsapp_plan("check my whatsapp", &whatsapp_tool()).unwrap();
        assert_eq!(args["limit"], 10);

        // Whisper's "WhatsApp" → "what's up" mangle, caught via routing::normalize.
        let (name, _) = whatsapp_plan("check my what's up messages", &whatsapp_tool()).unwrap();
        assert_eq!(name, "whatsapp.list_messages");

        // Cap at 50 even if a huge number is spoken.
        let (_, args) = whatsapp_plan("last 99 whatsapp messages", &whatsapp_tool()).unwrap();
        assert_eq!(args["limit"], 50);
    }

    #[test]
    fn whatsapp_plan_extracts_sender_name() {
        let (_, args) = whatsapp_plan("messages from Maria Lopez", &whatsapp_tool()).unwrap();
        assert_eq!(args["query"], "Maria Lopez");
    }

    #[test]
    fn whatsapp_plan_absent_without_the_tool() {
        assert!(whatsapp_plan("check my last 5 whatsapp messages", &[]).is_none());
        assert!(whatsapp_plan("tell me a joke", &whatsapp_tool()).is_none());
    }

    #[test]
    fn whatsapp_plan_covers_update_phrasings_but_not_greetings_or_writes() {
        for t in ["any WhatsApp updates?", "what's new on whats app", "anything on WhatsApp today?", "Hey Tony, any new messages on WhatsApp", "who messaged me on WhatsApp"] {
            let (name, args) = whatsapp_plan(t, &whatsapp_tool()).unwrap_or_else(|| panic!("{t}"));
            assert_eq!(name, "whatsapp.list_messages", "{t}");
            assert_eq!(args["limit"], 10, "{t}");
        }
        for t in ["what's up", "reply to Sam on WhatsApp", "send a whatsapp to Maria"] {
            assert!(whatsapp_plan(t, &whatsapp_tool()).is_none(), "{t}");
        }
    }

    #[test]
    fn weather_plan_reads_place_or_home() {
        let tools = super::super::mcp::builtin_tools("weather");
        assert_eq!(weather_plan("what's the weather in Lisbon tomorrow?", &tools), Some(("weather.current".into(), json!({ "place": "Lisbon" }))));
        assert_eq!(weather_plan("Is it going to rain in New York City today", &tools), Some(("weather.current".into(), json!({ "place": "New York City" }))));
        assert_eq!(weather_plan("will it rain tomorrow", &tools), Some(("weather.current".into(), json!({}))));
        assert_eq!(weather_plan("how cold is it outside", &tools), Some(("weather.current".into(), json!({}))));
        assert!(weather_plan("play purple rain", &tools).is_none());
        assert!(weather_plan("what's the weather", &[]).is_none());
        // Chained after the other deterministic planners.
        assert_eq!(deterministic_plan("weather forecast for Paris", &tools, "Tony").map(|p| p.0).as_deref(), Some("weather.current"));
    }

    #[test]
    fn whatsapp_planner_shape_matches_its_requests() {
        assert!(whatsapp_plan("any WhatsApp updates", &planner_tools("whatsapp")).is_some());
        let names = |v: Vec<super::super::mcp::ToolInfo>| v.into_iter().map(|t| t.name).collect::<Vec<_>>();
        assert_eq!(names(planner_tools("gmail")), names(super::super::mcp::builtin_tools("gmail")));
    }

    fn spotify_tools() -> Vec<super::super::mcp::ToolInfo> {
        // What `turn_tools` hands Tony's planner: the router-visible Spotify tools (reads + media controls).
        super::super::mcp::router_filter(&super::super::mcp::builtin_tools("spotify"), true)
    }

    #[test]
    fn spotify_plan_strips_interjections_and_the_wake_name() {
        let plan = |t: &str| spotify_plan(t, &spotify_tools(), "Tony");
        assert_eq!(plan("aye tony can you play some bilmuri"), Some(("spotify.play".into(), json!({ "query": "bilmuri", "prefer_playlist": true }))));
        assert_eq!(plan("Aye, Tony, play Bilmuri on Spotify."), Some(("spotify.play".into(), json!({ "query": "Bilmuri" }))));
        assert_eq!(plan("ayy tony pause the music").map(|p| p.0).as_deref(), Some("spotify.pause"));
        assert_eq!(plan("yo jarvis what's playing").map(|p| p.0).as_deref(), Some("spotify.now_playing"));
        // A renamed OS is stripped too.
        assert_eq!(spotify_plan("hey friday, play some jazz", &spotify_tools(), "Friday").unwrap().1, json!({ "query": "jazz", "prefer_playlist": true }));
        // Negatives: the name as an artist, a credit, non-music, an anchored pause.
        assert_eq!(plan("play tony bennett").unwrap().1, json!({ "query": "tony bennett" }));
        assert_eq!(plan("play something by tony").unwrap().1, json!({ "query": "tony", "type": "artist" }));
        assert!(plan("aye that's a play I'd make").is_none());
        assert!(plan("how do I turn off spotify autoplay").is_none());
        // A renamed OS addressed at the END is dropped too; a credit stays.
        let friday = |t: &str| spotify_plan(t, &spotify_tools(), "Friday");
        assert_eq!(friday("Play Bilmuri on Spotify, Friday.").unwrap().1, json!({ "query": "Bilmuri" }));
        assert_eq!(friday("play something by friday").unwrap().1, json!({ "query": "friday", "type": "artist" }));
        assert_eq!(friday("pause, Friday").map(|p| p.0).as_deref(), Some("spotify.pause"));
    }

    #[test]
    fn spotify_plan_controls_and_reads() {
        let plan = |t: &str| spotify_plan(t, &spotify_tools(), "Tony");
        let tool = |t: &str| plan(t).map(|p| p.0);
        assert_eq!(tool("What's playing?").as_deref(), Some("spotify.now_playing"));
        assert_eq!(tool("hey tony what song is this").as_deref(), Some("spotify.now_playing"));
        assert_eq!(tool("pause the music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("Pause.").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("pause my music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("stop playing music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("turn off Spotify").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("Hey Tony, can you pause the music please").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("Pause the music, Tony.").as_deref(), Some("spotify.pause"));
        assert_ne!(tool("how do I turn off spotify autoplay on my phone").as_deref(), Some("spotify.pause"));
        assert_ne!(tool("remind me at 11 to stop playing my music").as_deref(), Some("spotify.pause"));
        assert_eq!(tool("resume spotify").as_deref(), Some("spotify.resume"));
        assert_eq!(tool("skip this song").as_deref(), Some("spotify.next"));
        assert_eq!(tool("next track please").as_deref(), Some("spotify.next"));
        assert_eq!(tool("go back a track").as_deref(), Some("spotify.previous"));
        assert_eq!(tool("previous song").as_deref(), Some("spotify.previous"));
        assert_eq!(tool("what have I been listening to").as_deref(), Some("spotify.recently_played"));
        assert_eq!(tool("show my playlists").as_deref(), Some("spotify.list_playlists"));
        assert_eq!(plan("spotify volume 30"), Some(("spotify.volume".into(), json!({ "percent": 30 }))));
        assert_eq!(plan("volume 40"), Some(("spotify.volume".into(), json!({ "percent": 40 }))));
        assert_eq!(plan("set the volume to 150").unwrap().1["percent"], 100);
        assert_eq!(tool("shuffle on").as_deref(), Some("spotify.shuffle"));
        assert_eq!(tool("skip to 1:30").as_deref(), Some("spotify.seek"));
        assert_eq!(tool("what's in the queue").as_deref(), Some("spotify.get_queue"));
        // Library edits come from the grammar too; the card / gates apply when they run.
        assert_eq!(plan("add this song to my Late Night playlist"), Some(("spotify.add_to_playlist".into(), json!({ "playlist_name": "Late Night", "track_query": "current", "create": false }))));
        assert_eq!(tool("like this song").as_deref(), Some("spotify.like_track"));
        // "reconnect Spotify": a fixed reply on the Rust path, no tool.
        assert_eq!(plan("reconnect spotify"), Some((super::super::spotify_intent::RECONNECT.into(), json!({}))));
        // Tony's speech and the mic stay Tony's.
        for line in ["stop", "repeat that", "unmute", "I like this", "what's next"] {
            assert!(plan(line).is_none(), "{line}");
        }
    }

    #[test]
    fn spotify_plan_play_requests() {
        let plan = |t: &str| spotify_plan(t, &spotify_tools(), "Tony");
        assert_eq!(plan("play Woke Up This Morning on Spotify"), Some(("spotify.play".into(), json!({ "query": "Woke Up This Morning" }))));
        // "X by Y" stays whole: the resolver splits it (and falls back to the whole query).
        assert_eq!(plan("Hey Tony, play One More Time by Daft Punk").unwrap().1, json!({ "query": "One More Time by Daft Punk" }));
        assert_eq!(plan("can you play some jazz").unwrap().1, json!({ "query": "jazz", "prefer_playlist": true }));
        assert_eq!(plan("play the album Discovery").unwrap().1, json!({ "query": "Discovery", "type": "album" }));
        assert_eq!(plan("play my Gym playlist on spotify").unwrap().1, json!({ "playlist_name": "Gym" }));
        assert_eq!(plan("play songs by Frank Sinatra").unwrap().1, json!({ "query": "Frank Sinatra", "type": "artist" }));
        assert_eq!(plan("play music").unwrap().0, "spotify.resume");
        assert_eq!(plan("Play Daft Punk on Spotify, Tony.").unwrap().1["query"], "Daft Punk");
        assert_eq!(plan("play Bilmuri on my phone").unwrap().1, json!({ "query": "Bilmuri", "device_name": "my phone" }));
        // Not music requests.
        assert!(plan("play devil's advocate on my business plan").is_none());
        assert!(plan("can you explain how the playoffs work").is_none());
        assert!(plan("I want to play a game with you tonight after dinner").is_none());
        assert!(plan("play it cool with the client").is_none());
        assert!(plan("tell me a joke").is_none());
    }

    #[test]
    fn spotify_plan_needs_the_server() {
        assert!(spotify_plan("pause the music", &[], "Tony").is_none());
        assert!(spotify_plan("play jazz on spotify", &[], "Tony").is_none());
        let mut all = gmail_tools();
        all.extend(spotify_tools());
        assert_eq!(deterministic_plan("read my last email", &all, "Tony").unwrap().0, "gmail.recent");
        assert_eq!(deterministic_plan("what's playing", &all, "Tony").unwrap().0, "spotify.now_playing");
        assert!(wants_tools("what's playing on spotify"));
        assert!(router_keyword_ok("spotify", &super::super::routing::normalize("put on some music")));
        assert!(!router_keyword_ok("spotify", &super::super::routing::normalize("what's the weather")));
    }

    #[test]
    fn router_offers_library_writes_only_with_library_words() {
        let offered_all = spotify_tools();
        let names = |line: &str| router_offer(&offered_all, line, "Tony").into_iter().map(|t| t.name.clone()).collect::<Vec<_>>();
        let lib = names("remove this from my late night playlist");
        assert!(lib.contains(&"spotify.remove_from_playlist".to_string()) && lib.contains(&"spotify.add_to_playlist".to_string()), "{lib:?}");
        let liked = names("put this song in my liked songs");
        assert!(liked.contains(&"spotify.like_track".to_string()), "{liked:?}");
        let skip = names("skip this");
        assert!(skip.contains(&"spotify.next".to_string()), "{skip:?}");
        assert!(!skip.iter().any(|n| super::super::spotify_intent::is_library_write(n)), "{skip:?}");
        assert!(!names("turn it up").iter().any(|n| super::super::spotify_intent::is_library_write(n)));
    }

    #[test]
    fn ask_cards_return_the_pending_call() {
        let args = json!({ "playlist_name": "Late Night", "track_query": "Tell Me" });
        assert_eq!(pending_from("PERMISSION_REQUIRED:mcp", "spotify.remove_from_playlist", &args, false), None, "no askCards: today's failure note");
        let p = pending_from("PERMISSION_REQUIRED:mcp", "spotify.remove_from_playlist", &args, true).expect("pending");
        assert_eq!(p.name, "spotify.remove_from_playlist");
        assert_eq!(p.args, json!({ "playlist_name": "Late Night", "track_query": "Tell Me" }));
        assert_eq!(p.summary, "Remove Tell Me from your Late Night playlist");
        assert_eq!(p.required, "PERMISSION_REQUIRED:mcp");
        let d = pending_from("PERMISSION_REQUIRED:destructive", "spotify.unlike_track", &json!({}), true).unwrap();
        assert_eq!((d.required.as_str(), d.args.clone()), ("PERMISSION_REQUIRED:destructive", json!({ "track_query": "current" })));
        // Reads never pend, other errors never pend, other servers never pend.
        assert_eq!(pending_from("PERMISSION_REQUIRED:mcp", "spotify.now_playing", &json!({}), true), None);
        assert_eq!(pending_from("PERMISSION_DENIED:mcp", "spotify.play", &json!({ "query": "x" }), true), None);
        assert_eq!(pending_from("PERMISSION_REQUIRED:mcp", "gmail.create_draft", &json!({}), true), None);
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("required").is_some() && json.get("summary").is_some() && json.get("name").is_some());
    }

    #[test]
    fn spotify_write_reply_is_verbatim() {
        assert_eq!(verbatim_answer(PlanSource::Deterministic, false, "Now playing X."), Some("Now playing X.".into()));
        assert_eq!(verbatim_answer(PlanSource::Deterministic, true, "Paused Spotify."), Some("Paused Spotify.".into()));
        assert_eq!(verbatim_answer(PlanSource::Router, true, "Playing Bilmuri on Spotify."), Some("Playing Bilmuri on Spotify.".into()));
        assert_eq!(verbatim_answer(PlanSource::Router, false, "Now playing X."), None, "router reads are synthesised");
        // Through Prefetch: a write result pins the answer; a held write pins the card.
        let mut p = Prefetch { ask_cards: true, ..Prefetch::default() };
        p.spotify_outcome("spotify.pause", &json!({}), Some("Paused Spotify."), PlanSource::Router);
        assert_eq!(p.verbatim.as_deref(), Some("Paused Spotify."));
        let mut p = Prefetch { ask_cards: true, last_error: Some("PERMISSION_REQUIRED:mcp".into()), failure: Some(("spotify.pause".into(), "x".into())), ..Prefetch::default() };
        p.spotify_outcome("spotify.pause", &json!({}), None, PlanSource::Deterministic);
        assert_eq!(p.pending_spotify.as_ref().map(|c| c.summary.as_str()), Some("Pause Spotify"));
        assert!(p.failure.is_none(), "the card replaces the failure note");
        // Non-Spotify tools are untouched.
        let mut p = Prefetch::default();
        p.spotify_outcome("weather.current", &json!({}), Some("5°C"), PlanSource::Deterministic);
        assert!(p.verbatim.is_none());
    }

    #[test]
    fn reconnect_on_the_rust_path_is_a_fixed_reply() {
        let plan = spotify_plan("hey tony reconnect spotify", &spotify_tools(), "Tony").unwrap();
        assert_eq!(plan.0, super::super::spotify_intent::RECONNECT);
        assert!(!super::super::mcp::builtin_tools("spotify").iter().any(|t| t.name == plan.0), "never an MCP tool");
        let s = super::super::spotify::RUST_RECONNECT;
        assert_eq!(s, "To sign in to Spotify again, open Settings → Integrations on the PC and press Reconnect.");
    }

    #[test]
    fn time_plan_matches_only_with_the_tool() {
        let time_tool = vec![super::super::mcp::ToolInfo { name: "time.now".into(), description: "x".into(), server: "time".into(), args: vec![] }];
        assert!(time_plan("what time is it", &time_tool).is_some());
        assert!(time_plan("what time is it", &[]).is_none());
        assert!(time_plan("tell me a joke", &time_tool).is_none());
    }
}

/// Read-only prompt-size probe for Tony (opt-in): his TOOLS section, the tool router's prompt on a
/// plain line and the whole system message, built by the real prompt builders from the LIVE
/// os.json (read, never written) plus the stdio servers' listings from `CC_MEASURE_TOOLS` (a JSON
/// `{server: [{name, description, args}]}` captured without starting them).
/// `CC_MEASURE_TOOLS=<file> cargo test --lib measure_live_prompt_sizes -- --ignored --nocapture`
#[cfg(test)]
mod measure {
    use super::*;

    /// The live os.json as the app would load it after this build: the one-time tool-owner
    /// migration applied IN MEMORY only (nothing is written, no backup is made).
    fn live_cfg() -> Option<OsConfig> {
        let dir = std::env::var_os("APPDATA").map(std::path::PathBuf::from)?.join("os.agentic.commandcenter");
        let text = std::fs::read_to_string(dir.join("os.json")).ok()?;
        let mut cfg = serde_json::from_str::<OsConfig>(&text).ok()?;
        if super::super::os_core::needs_tool_owner_migration(&text) {
            let skills = std::path::PathBuf::from(&cfg.skills.dir);
            super::super::os_core::migrate_tool_owners(&mut cfg, |n| skills.join(n).join("SKILL.md").exists());
        }
        Some(cfg)
    }

    fn eff(id: &str) -> super::super::modes::Effective {
        let f = super::super::modes::ModesFile { active_mode_id: id.into(), ..Default::default() };
        super::super::modes::effective(&f, &Default::default())
    }

    fn listed(cfg: &OsConfig, e: &super::super::modes::Effective, agent: &str, ext: &Value) -> Vec<super::super::mcp::ToolInfo> {
        let mut out = vec![];
        for s in super::super::mcp::servers_for(cfg, e, agent) {
            let tools = if s.transport == "builtin" {
                super::super::mcp::builtin_tools(&s.id)
            } else {
                ext[&s.id]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|t| super::super::mcp::ToolInfo {
                        name: t["name"].as_str().unwrap_or("").into(),
                        description: t["description"].as_str().unwrap_or("").chars().take(200).collect(),
                        server: s.id.clone(),
                        args: t["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(String::from)).collect(),
                    })
                    .collect()
            };
            out.extend(super::super::mcp::visible_tools(&s, tools));
        }
        out
    }

    #[test]
    #[ignore]
    fn measure_live_prompt_sizes() {
        let Some(cfg) = live_cfg() else {
            eprintln!("no live os.json");
            return;
        };
        let ext: Value = std::env::var("CC_MEASURE_TOOLS").ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok()).unwrap_or(json!({}));
        let plain = "search the web for the best pizza in town";
        // Brainstorm: no overlay (grants only). Builder / Operations / Executive: grants + overlay.
        for mode in ["brainstorm", "builder", "operations", "executive"] {
            let e = eff(mode);
            // The live-only contract, as Tony's live turn sends it in this mode.
            let contract = tony_live_contract(cfg.roster.tony_packets, &e, &cfg.switchboard);
            let set = super::super::mcp::assemble_tools(&cfg, "general", listed(&cfg, &e, "general", &ext));
            let offered = router_offer(&set.offered, plain, &cfg.os_name);
            let router = router_prompt(&offered, "", "");
            let tools = tools_section(&set.offered, false);
            let sys = system_prompt(&cfg, "", &set.offered, false);
            let block = super::super::modes::mode_block(&e);
            let whole = tony_turn_system(&sys, "", "", &tony_turn_tail("", "", &contract, &block));
            println!(
                "MEASURE mode={mode} all={} offered={} tools_section_chars={} router_plain_tools={} router_plain_chars={} system_prompt_chars={} system_message_chars={} mode_block_chars={}",
                set.all.len(),
                set.offered.len(),
                tools.chars().count(),
                offered.len(),
                router.chars().count(),
                sys.chars().count(),
                whole.chars().count(),
                block.chars().count()
            );
            println!("MEASURE mode={mode} offered: {}", set.offered.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", "));
            println!("MEASURE mode={mode} router_plain: {}", offered.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", "));
        }
        // The worst router line for Tony: every gated subject named at once.
        let e = eff("brainstorm");
        let set = super::super::mcp::assemble_tools(&cfg, "general", listed(&cfg, &e, "general", &ext));
        let worst = "search my email inbox, whatsapp messages, spotify playlists, maps route and instagram followers, the weather and the time, and remember the notes";
        let offered = router_offer(&set.offered, worst, &cfg.os_name);
        println!("MEASURE worst_router_tools={} worst_router_chars={}", offered.len(), router_prompt(&offered, "", "").chars().count());
        for agent in ["designer", "director", "coder"] {
            let set = super::super::mcp::assemble_tools(&cfg, agent, listed(&cfg, &e, agent, &ext));
            let skills = super::super::mcp::relevant_skills(&cfg, agent, "redesign the landing page layout and polish the hero animation for the website", super::super::mcp::SKILL_BUDGET);
            println!("MEASURE agent={agent} all={} offered={} skills={:?} skill_chars={}", set.all.len(), set.offered.len(), skills.names, skills.block.chars().count());
        }
    }
}

/// Live smoke test against the real local services. Opt-in:
/// `cargo test --lib live_os_turn -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_os_turn() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let bridge = BridgeState::default();
            let cfg = os.snapshot();

            // 1. Workspaces
            match fetch_workspaces(&state, &cfg, 8).await.map(|w| w.into_iter().map(|w| w.slug).collect::<Vec<_>>()) {
                Ok(slugs) => {
                    println!("WORKSPACES: {slugs:?}");
                    if let Some(slug) = ["booking", "librarian"].iter().filter_map(|r| cfg.anythingllm.workspaces.get(*r)).find(|s| slugs.contains(s)) {
                        let t0 = Instant::now();
                        let r = workspace_chat(&state, &os, slug, "booking", "[Tony → Booking agent] Retrieve and summarize the last 5 incoming booking messages.").await;
                        println!("BOOKING ({}ms): {}", t0.elapsed().as_millis(), r.map(|x| x.0.chars().take(300).collect::<String>()).unwrap_or_else(|e| format!("ERR {e}")));
                    }
                }
                Err(e) => println!("ANYTHINGLLM: {e}"),
            }

            // 2. Weather tool
            println!("TOOL weather: {:?}", super::super::mcp::call_tool(&state, &os, &bridge, "weather.current", &json!({}), false, "tony").await.map(|s| s.lines().next().unwrap_or("").to_string()));

            // 3. Answer from live context (no refusal)
            let sys = system_prompt(&cfg, "Weather (Toronto): 5°C Overcast, wind 11 km/h", &[], false);
            let t0 = Instant::now();
            let r = run_chat(&state, &os, vec![ChatMessage::new("system", sys), ChatMessage::new("user", "What's the weather like right now?")], Priority::Interactive, None, Some(90)).await;
            println!("CHAT ({}ms): {:?}", t0.elapsed().as_millis(), r.map(|x| format!("[{}] ({}) {}", x.provider_id, x.reason, x.content.chars().take(300).collect::<String>())));
        });
    }

    /// What Tony's next turn really gets, from the live os.json + keychain presence.
    /// Names only; makes no Spotify API call and runs no tool.
    /// `cargo test --lib live_tony_tools_payload -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_tony_tools_payload() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let cfg = os.snapshot();
            let set = turn_tools(&state, &os, &cfg, "general").await;
            let ready = spotify_ready(&cfg, || super::super::spotify::readiness(&state).is_ok());
            let spotify = |v: &[super::super::mcp::ToolInfo]| v.iter().filter(|t| t.server == "spotify").map(|t| t.name.clone()).collect::<Vec<_>>();
            println!("SPOTIFY READY: {ready}");
            println!("ALL ({}), spotify: {:?}", set.all.len(), spotify(&set.all));
            println!("ROUTER OFFERED ({}), spotify: {:?}", set.offered.len(), spotify(&set.offered));
            let line = "aye tony can you play some bilmuri";
            println!("DETERMINISTIC PLAN for {line:?}: {:?}", deterministic_plan(line, &set.offered, &cfg.os_name));
            let offer = router_offer(&set.offered, line, &cfg.os_name);
            println!("ROUTER OFFER for {line:?}: {:?}", offer.iter().map(|t| t.name.as_str()).collect::<Vec<_>>());
            let sys = system_prompt(&cfg, "", &set.offered, true);
            println!("SYSTEM PROMPT lists spotify.play: {}", sys.contains("spotify.play"));
            assert!(ready, "Spotify is not ready (disconnected, off, kill switch or MCP Deny)");
            assert!(set.offered.iter().any(|t| t.name == "spotify.play"), "spotify.play missing from Tony's router tools");
        });
    }
}

/// `cargo test --lib live_droplet -- --ignored --nocapture` — the app's own path to the droplet.
#[cfg(test)]
mod live_droplet {
    use super::*;

    #[test]
    #[ignore]
    fn live_droplet() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let os = OsState::default();
            os.load_or_init(&dir, std::path::Path::new(&state.snapshot().gateway.workdir));
            let cfg = os.snapshot();
            let sys = system_prompt(&cfg, "Weather (Toronto): 5°C Overcast, wind 11 km/h", &[], false);
            let t0 = Instant::now();
            let r = run_chat(&state, &os, vec![ChatMessage::new("system", sys), ChatMessage::new("user", "Quick check — what's the weather, and email sam@acme.ca says what?")], Priority::Interactive, Some("droplet".into()), Some(120)).await;
            match r {
                Ok(x) => println!("DROPLET ({}ms, redacted={}): [{}] {}", t0.elapsed().as_millis(), x.redacted, x.provider_id, x.content.chars().take(300).collect::<String>()),
                Err(e) => println!("DROPLET ERR: {e}"),
            }
            let rec = os.last_redaction.lock().unwrap().clone();
            if let Some(rec) = rec {
                println!("LEFT THE MACHINE (user msg): {}", rec.payload[1]["content"].as_str().unwrap_or("").chars().take(120).collect::<String>());
            }
        });
    }
}

// The live AnythingLLM write tests (create workspaces, model settings, /no_think) moved to
// `allm.rs` (`mod live_writes`) so raw AnythingLLM access stays in one module; they now also
// require ALLM_LIVE_WRITE=1.
