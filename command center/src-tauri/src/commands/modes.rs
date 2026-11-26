//! Tony modes (Phase 2 Part C): a small rule set swapped into Tony's system prompt on his next
//! turn. No extra model, no restart, zero VRAM: a mode is runtime state plus prompt text.
//!
//! - `modes.json` (beside os.json, ~3 KB) holds the custom modes and the active id. The presets
//!   (`BUILTIN_IDS`) are re-seeded from code on every load, so they always mean the same thing
//!   (D12); a preset can be duplicated, never edited or deleted.
//! - `mode_block` is the deterministic prompt block (curiosity dial, verbosity, dispatch policy,
//!   the ON DUTY line, the mode's own notes). It ends Tony's own system message (never a
//!   sub-agent's or Booking's), so everything above it is the same in every mode.
//! - `dispatch_allowed` is the pure policy gate every pipeline build passes (`task_create`,
//!   `capture_task`, `task_from_idea`, the inbox `task`): `surface_only` queues nothing,
//!   `auto` (skipping the spoken Tier-3 offer) is honoured only under `auto_dispatch`.
//! - `tts_interrupt_level` maps onto `feedback.sensitivity` (silent 0 · milestones_only 1 ·
//!   full 2); a manual narration change is a temporary override (cleared by a switch or reset).
//! - Overrides (curiosity / dispatch / verbosity / feedback) live in memory only (D18).
//! - Learning (`LEARNING_ID`): Nic trains Tony one-on-one. Dispatch is hard-locked to
//!   `surface_only` (an override can't lift it), the MODE block carries `LEARNING_PROTOCOL`
//!   instead of the Solo line, and `agents.rs` / the worker / the webview isolate the turn
//!   (no routing, live tools, sub-agent calls, background builds or other voices).
//! - Switchboard: a mode may carry an overlay (`ModeSwitchboard`: the agents on duty and the MCP
//!   servers left live; `None` = everything, today's behaviour), on top of the master switchboard
//!   in os.json (`os_core::SwitchboardConfig`: frozen in every mode). Freezing is a runtime mask
//!   (`agent_live` / `tool_live`): os.json, grants and toggles are never changed, so a frozen
//!   agent or tool comes back exactly as it was. Tony and the always-live tools are never frozen.
//!
//! No prompt text here may contain the format word that flips `dispatch::skip_agentic_os`, the
//! thinking switch, or the novelty mode's name (enforced by `validate_mode` and the tests).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use super::os_core::{OsState, SwitchboardConfig};

// ── Schema (the spec's snake_case names, exactly) ───────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Curiosity {
    Low,
    Medium,
    High,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verbosity {
    Terse,
    Balanced,
    Conversational,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DispatchPolicy {
    SurfaceOnly,
    AskBeforeDispatch,
    AutoDispatch,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TtsInterrupt {
    Silent,
    MilestonesOnly,
    Full,
}

/// A mode's switchboard overlay: the agents on duty (routing role ids) and the tools left live
/// (os.json `mcps[].id`) in this mode. Every other agent and server is frozen while it is active.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ModeSwitchboard {
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TonyMode {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub curiosity_level: Curiosity,
    pub verbosity: Verbosity,
    pub agent_dispatch_policy: DispatchPolicy,
    pub tts_interrupt_level: TtsInterrupt,
    #[serde(default)]
    pub prompt_modifier: String,
    #[serde(default)]
    pub is_novelty: bool,
    /// `None`: no overlay (every agent and tool the master switchboard leaves live).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switchboard: Option<ModeSwitchboard>,
    /// Learning: tonight's overnight training run is requested while this mode is used.
    #[serde(default)]
    pub night_training: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ModesFile {
    #[serde(default = "file_version")]
    pub version: u32,
    pub active_mode_id: String,
    pub modes: Vec<TonyMode>,
}

/// A file with no `version` is a v1 file.
fn file_version() -> u32 {
    1
}

/// v2: the Operations preset and the switchboard fields (`normalize` rewrites a v1 file).
pub const MODES_FILE_VERSION: u32 = 2;

impl Default for ModesFile {
    fn default() -> Self {
        Self { version: MODES_FILE_VERSION, active_mode_id: DEFAULT_MODE_ID.into(), modes: presets() }
    }
}

/// The presets, in switcher order. Read-only (D12); `is_preset` is derived from this list.
pub const BUILTIN_IDS: [&str; 8] = ["surface", "brainstorm", "builder", "operations", "executive", "coach", "learning", "gabagool"];
/// Preset ids added after v1: a v1 file's custom mode with one of these ids is renamed, not lost.
pub const NEW_BUILTIN_IDS: [&str; 1] = ["operations"];
/// The first-launch mode: `ask_before_dispatch` is today's Tier-3 behaviour (D11).
pub const DEFAULT_MODE_ID: &str = "brainstorm";
/// The novelty overlay (D19): toggled by the cue system, never the active work mode.
pub const NOVELTY_ID: &str = "gabagool";
/// One-on-one training with Tony: Tony only, dispatch locked to Solo, lessons saved as pathways.
pub const LEARNING_ID: &str = "learning";

pub fn is_builtin(id: &str) -> bool {
    BUILTIN_IDS.contains(&id)
}

#[allow(clippy::too_many_arguments)]
fn preset(id: &str, name: &str, icon: &str, c: Curiosity, v: Verbosity, d: DispatchPolicy, t: TtsInterrupt, modifier: &str, novelty: bool) -> TonyMode {
    TonyMode {
        id: id.into(),
        name: name.into(),
        icon: icon.into(),
        curiosity_level: c,
        verbosity: v,
        agent_dispatch_policy: d,
        tts_interrupt_level: t,
        prompt_modifier: modifier.into(),
        is_novelty: novelty,
        switchboard: None,
        night_training: false,
    }
}

/// A preset with its switchboard overlay (`agents` on duty, `tools` left live).
fn on_duty(m: TonyMode, agents: &[&str], tools: &[&str]) -> TonyMode {
    TonyMode { switchboard: Some(ModeSwitchboard { agents: agents.iter().map(|s| s.to_string()).collect(), tools: tools.iter().map(|s| s.to_string()).collect() }), ..m }
}

pub const BRAINSTORM_NOTES: &str = "Refine raw ideas with sharp follow-ups; when one firms up, offer to park it in the Brainstorm list or hand it off.";
pub const COACH_NOTES: &str = "Be a grounded, high-energy accountability partner: name the next concrete step and push Nic to take it.";
pub const LEARNING_NOTES: &str = "Be curious: ask Nic what he's doing, how and why.";

/// The switchboard overlays of the presets (agents on duty; tools left live).
pub const BUILDER_AGENTS: [&str; 3] = ["prompter", "designer", "coder"];
pub const BUILDER_TOOLS: [&str; 8] = ["filesystem", "git", "fetch", "brave-search", "knowledge-graph", "time", "weather", "spotify"];
pub const OPERATIONS_AGENTS: [&str; 2] = ["ops", "bizops"];
pub const OPERATIONS_TOOLS: [&str; 9] = ["gmail", "whatsapp", "knowledge-graph", "filesystem", "maps", "fetch", "time", "weather", "instagram"];
/// The Librarian is not on Executive duty: it runs only as its scheduled script (frozen on the
/// master switchboard by default, `os_core::default_frozen_agents`).
pub const EXECUTIVE_AGENTS: [&str; 2] = ["bizops", "finance"];
pub const EXECUTIVE_TOOLS: [&str; 5] = ["knowledge-graph", "gmail", "brave-search", "time", "weather"];

/// The eight presets (spec §2 + Operations + Learning), in `BUILTIN_IDS` order.
pub fn presets() -> Vec<TonyMode> {
    use Curiosity::*;
    use DispatchPolicy::*;
    use TtsInterrupt::*;
    use Verbosity::*;
    vec![
        preset("surface", "Surface / Solo", "message-circle", Medium, Balanced, SurfaceOnly, Silent, "", false),
        preset("brainstorm", "Brainstorming", "lightbulb", High, Conversational, AskBeforeDispatch, MilestonesOnly, BRAINSTORM_NOTES, false),
        on_duty(preset("builder", "Builder", "hammer", Medium, Balanced, AutoDispatch, Full, "", false), &BUILDER_AGENTS, &BUILDER_TOOLS),
        on_duty(preset("operations", "Operations", "clipboard-list", Medium, Balanced, AskBeforeDispatch, MilestonesOnly, "", false), &OPERATIONS_AGENTS, &OPERATIONS_TOOLS),
        on_duty(preset("executive", "Executive", "briefcase", Low, Terse, AskBeforeDispatch, MilestonesOnly, "", false), &EXECUTIVE_AGENTS, &EXECUTIVE_TOOLS),
        preset("coach", "Motivation / Coach", "flame", Medium, Balanced, SurfaceOnly, MilestonesOnly, COACH_NOTES, false),
        TonyMode { night_training: true, ..on_duty(preset("learning", "Learning", "graduation-cap", High, Balanced, SurfaceOnly, Silent, LEARNING_NOTES, false), &[], &[]) },
        preset(NOVELTY_ID, "Gabagool Mode", "\u{1F35D}", Medium, Balanced, SurfaceOnly, Silent, "", true),
    ]
}

// ── Prompt blocks (pure constants, mirrored verbatim in src/features/modes/modes.ts) ─

pub const CURIOSITY_LOW: &str = "CURIOSITY LOW: answer directly in 1–2 sentences; no follow-up questions unless you are blocked.";
pub const CURIOSITY_MEDIUM: &str = "CURIOSITY MEDIUM: natural pace; at most 1 focused clarifying question, only if it helps.";
pub const CURIOSITY_HIGH: &str = "CURIOSITY HIGH: be an active brainstorming partner: probe edge cases, offer 1–2 creative angles, stay curious.";
pub const VERBOSITY_TERSE: &str = "VERBOSITY TERSE: shortest useful answer; short confirmations; zero filler.";
pub const VERBOSITY_CONVERSATIONAL: &str = "VERBOSITY CONVERSATIONAL: up to 4 short sentences when it helps the conversation.";
pub const DISPATCH_SOLO: &str = "SOLO MODE: nothing is handed to the Prompter, Designer or Coder now. If Nic wants something built, offer to park it, or say it can be queued once he switches modes.";
pub const DISPATCH_AUTO: &str = "BUILDER MODE: the app queues a clear build for the Prompter as soon as Nic commits; never say it was queued unless the app confirms it.";
/// Learning mode's rules (in place of the Solo line). The `[[LEARN …]]` lines are pulled out of
/// the reply by `learning::parse_tags` before anything is shown, spoken or logged.
pub const LEARNING_PROTOCOL: &str = "LEARNING MODE: Nic is training you; offer no builds or hand-offs. Distill each lesson into a rule; ask one sharp question on edge cases or clashes with LEARNED; echo it back (So when X, you want Y?) before saving unless he says save now. To save, add a line per lesson: [[LEARN category | when | rule or fact | confirmed or provisional]], category one of preference, workflow, rule, persona, domain_knowledge, correction. Confirm briefly.";
/// The whole block's cap (the ON DUTY line, then the mode's own notes, are clipped to fit).
pub const MODE_BLOCK_MAX: usize = 800;
pub const MODIFIER_MAX: usize = 280;

pub fn curiosity_line(c: Curiosity) -> &'static str {
    match c {
        Curiosity::Low => CURIOSITY_LOW,
        Curiosity::Medium => CURIOSITY_MEDIUM,
        Curiosity::High => CURIOSITY_HIGH,
    }
}

pub fn verbosity_line(v: Verbosity) -> &'static str {
    match v {
        Verbosity::Terse => VERBOSITY_TERSE,
        Verbosity::Balanced => "",
        Verbosity::Conversational => VERBOSITY_CONVERSATIONAL,
    }
}

pub fn dispatch_line(d: DispatchPolicy) -> &'static str {
    match d {
        DispatchPolicy::SurfaceOnly => DISPATCH_SOLO,
        DispatchPolicy::AskBeforeDispatch => "",
        DispatchPolicy::AutoDispatch => DISPATCH_AUTO,
    }
}

/// Narration level for a mode (D17): silent 0 · milestones_only 1 · full 2 (verbose 3 is a
/// manual override only).
pub fn feedback_for(t: TtsInterrupt) -> u8 {
    match t {
        TtsInterrupt::Silent => 0,
        TtsInterrupt::MilestonesOnly => 1,
        TtsInterrupt::Full => 2,
    }
}

// ── Effective state (mode + temporary overrides) ────────────────────────────

/// Manual changes that override the active mode until a switch or a reset (in memory only).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Overrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curiosity: Option<Curiosity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<DispatchPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<Verbosity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<u8>,
}

impl Overrides {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self == &Overrides::default()
    }
}

/// What Tony's next turn runs under.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Effective {
    pub mode_id: String,
    pub name: String,
    pub icon: String,
    pub curiosity: Curiosity,
    pub verbosity: Verbosity,
    pub dispatch: DispatchPolicy,
    pub feedback_level: u8,
    pub prompt_modifier: String,
    pub is_novelty: bool,
    /// Which fields an override changed (`curiosity`, `dispatch`, `verbosity`, `feedback`).
    pub overridden: Vec<&'static str>,
    /// The active mode's switchboard overlay (`None`: no overlay).
    pub switchboard: Option<ModeSwitchboard>,
    pub night_training: bool,
}

/// The active mode (an unknown id falls back to the default preset).
pub fn active_mode(f: &ModesFile) -> TonyMode {
    f.modes
        .iter()
        .find(|m| m.id == f.active_mode_id)
        .or_else(|| f.modes.iter().find(|m| m.id == DEFAULT_MODE_ID))
        .cloned()
        .unwrap_or_else(|| presets().into_iter().find(|m| m.id == DEFAULT_MODE_ID).expect("default preset"))
}

pub fn effective(f: &ModesFile, o: &Overrides) -> Effective {
    let m = active_mode(f);
    let mut overridden = vec![];
    if o.curiosity.is_some() {
        overridden.push("curiosity");
    }
    // Learning locks dispatch to Solo: a dispatch override never applies (nor counts) there.
    let learning = m.id == LEARNING_ID;
    if o.dispatch.is_some() && !learning {
        overridden.push("dispatch");
    }
    if o.verbosity.is_some() {
        overridden.push("verbosity");
    }
    if o.feedback.is_some() {
        overridden.push("feedback");
    }
    Effective {
        mode_id: m.id,
        name: m.name,
        icon: m.icon,
        curiosity: o.curiosity.unwrap_or(m.curiosity_level),
        verbosity: o.verbosity.unwrap_or(m.verbosity),
        dispatch: if learning { DispatchPolicy::SurfaceOnly } else { o.dispatch.unwrap_or(m.agent_dispatch_policy) },
        feedback_level: o.feedback.map(|f| f.min(3)).unwrap_or_else(|| feedback_for(m.tts_interrupt_level)),
        prompt_modifier: m.prompt_modifier,
        is_novelty: m.is_novelty,
        overridden,
        switchboard: m.switchboard,
        night_training: m.night_training,
    }
}

/// Is this turn running under Learning mode (Tony-only training)?
pub fn is_learning(e: &Effective) -> bool {
    e.mode_id == LEARNING_ID
}

// ── Switchboard (pure) ──────────────────────────────────────────────────────

/// Tools that are live in every mode, whatever any switchboard says: the clock, a skill's own
/// text and the mode switch (how Nic always gets out of a mode by voice).
pub const ALWAYS_LIVE_TOOLS: [&str; 3] = ["time", "skills.read", "tony.set_mode"];
/// The server ids behind `ALWAYS_LIVE_TOOLS` (`time.now` is on `time`; the other two are synthetic).
pub const ALWAYS_LIVE_SERVERS: [&str; 3] = ["time", "skills", "tony"];
/// System scripts that are never switchboard agents (never frozen).
pub const SYSTEM_AGENTS: [&str; 4] = ["security", "observer", "garbage", "trading"];
/// The build pipeline's agents: a queued build waits while any of them is frozen.
pub const PIPELINE_AGENTS: [&str; 3] = ["prompter", "designer", "coder"];
/// Prefix of a tool call refused because its server is frozen (`tool_frozen_error`).
pub const MODE_FROZEN: &str = "MODE_FROZEN";
/// Per-list cap of a mode's overlay.
pub const SWITCHBOARD_LIST_MAX: usize = 16;

/// The switchboard id of a role / packet target / workspace: Tony's aliases → `general`,
/// `financer` → `finance`, a business workspace `bizops_<id>` → `bizops`.
pub fn board_agent(id: &str) -> String {
    let a = id.trim().to_ascii_lowercase();
    if super::roles::is_tony_id(&a) {
        "general".into()
    } else if a == "financer" {
        "finance".into()
    } else if a.starts_with("bizops_") {
        "bizops".into()
    } else {
        a
    }
}

/// `agent` is frozen in every mode (the master switchboard).
pub fn agent_globally_frozen(g: &SwitchboardConfig, agent: &str) -> bool {
    let a = board_agent(agent);
    a != "general" && !SYSTEM_AGENTS.contains(&a.as_str()) && g.frozen_agents.iter().any(|f| board_agent(f) == a)
}

/// `agent` may work this turn: not globally frozen, and on duty in the mode's overlay (no
/// overlay = everyone). Tony and the system scripts are always live.
pub fn agent_live(e: &Effective, g: &SwitchboardConfig, agent: &str) -> bool {
    let a = board_agent(agent);
    if a == "general" || SYSTEM_AGENTS.contains(&a.as_str()) {
        return true;
    }
    !agent_globally_frozen(g, &a) && e.switchboard.as_ref().map_or(true, |b| b.agents.iter().any(|x| board_agent(x) == a))
}

/// MCP server `server` (an os.json id) is live this turn: always-live, or not globally frozen
/// and listed in the mode's overlay (no overlay = every server).
pub fn tool_live(e: &Effective, g: &SwitchboardConfig, server: &str) -> bool {
    let s = server.trim();
    if ALWAYS_LIVE_SERVERS.contains(&s) {
        return true;
    }
    !g.frozen_tools.iter().any(|f| f == s) && e.switchboard.as_ref().map_or(true, |b| b.tools.iter().any(|t| t == s))
}

/// "Builder" → "in Builder mode"; the master switchboard → "on the master switchboard".
fn frozen_where(e: &Effective, master: bool) -> String {
    if master {
        return "on the master switchboard".into();
    }
    let name = one_line(&e.name);
    let name = if name.to_ascii_lowercase().ends_with(" mode") { name[..name.len() - 5].to_string() } else { name };
    format!("in {name} mode")
}

/// "<Agent> is frozen in <Mode> mode" (or "… on the master switchboard"); `None`: live.
pub fn agent_frozen_reason(e: &Effective, g: &SwitchboardConfig, agent: &str) -> Option<String> {
    if agent_live(e, g, agent) {
        return None;
    }
    let a = board_agent(agent);
    Some(format!("{} is frozen {}", super::agents::role_label(&a, ""), frozen_where(e, agent_globally_frozen(g, &a))))
}

/// "<label> is frozen in <Mode> mode" for server `server`; `None`: live.
pub fn tool_frozen_reason(e: &Effective, g: &SwitchboardConfig, server: &str, label: &str) -> Option<String> {
    if tool_live(e, g, server) {
        return None;
    }
    Some(format!("{label} is frozen {}", frozen_where(e, g.frozen_tools.iter().any(|f| f == server.trim()))))
}

/// The call-time refusal of a frozen server's tool: "MODE_FROZEN: <server> is frozen in <Mode> mode".
pub fn tool_frozen_error(e: &Effective, g: &SwitchboardConfig, server: &str) -> Option<String> {
    tool_frozen_reason(e, g, server, server).map(|r| format!("{MODE_FROZEN}: {r}"))
}

/// The first build-pipeline agent that is frozen (a queued build waits for it), with why. A
/// master-switchboard freeze is named first: switching modes won't start the build.
pub fn pipeline_frozen(e: &Effective, g: &SwitchboardConfig) -> Option<String> {
    let master = PIPELINE_AGENTS.iter().find(|a| agent_globally_frozen(g, a));
    master.into_iter().chain(PIPELINE_AGENTS.iter()).find_map(|a| agent_frozen_reason(e, g, a))
}

/// A build-pipeline agent is frozen on the master switchboard (in every mode): a queued build
/// starts only once Nic thaws it there.
pub fn pipeline_frozen_on_master(g: &SwitchboardConfig) -> bool {
    PIPELINE_AGENTS.iter().any(|a| agent_globally_frozen(g, a))
}

/// The mode's ON DUTY line (an overlay, outside Learning): its agents' labels, sorted, so the
/// text is deterministic. `None`: no overlay, or Learning (its protocol already forbids hand-offs).
pub fn on_duty_line(e: &Effective) -> Option<String> {
    if is_learning(e) {
        return None;
    }
    let b = e.switchboard.as_ref()?;
    let mut labels: Vec<String> = b.agents.iter().map(|a| board_agent(a)).filter(|a| a != "general").map(|a| super::agents::role_label(&a, "")).collect();
    labels.sort();
    labels.dedup();
    Some(if labels.is_empty() { "ON DUTY: none; every agent is frozen this mode.".to_string() } else { format!("ON DUTY: {}; every other agent is frozen this mode.", labels.join(", ")) })
}

/// Tony's MODE block: the LAST block of his system message, right before `/no_think` (the cached
/// prompt prefix above it stays the same in every mode). Deterministic: the same effective state
/// always gives the same text; empty lines are skipped; at most `MODE_BLOCK_MAX` chars (the ON
/// DUTY line, then the mode's notes, are clipped to fit). A novelty mode injects nothing.
pub fn mode_block(e: &Effective) -> String {
    if e.is_novelty {
        return String::new();
    }
    let mut s = format!("\n\nMODE: {}. These MODE rules override the STYLE length rule.", one_line(&e.name));
    let dispatch = if is_learning(e) { LEARNING_PROTOCOL } else { dispatch_line(e.dispatch) };
    for line in [curiosity_line(e.curiosity), verbosity_line(e.verbosity), dispatch] {
        if !line.is_empty() {
            s.push('\n');
            s.push_str(line);
        }
    }
    if let Some(duty) = on_duty_line(e) {
        let room = MODE_BLOCK_MAX.saturating_sub(s.chars().count() + 1);
        if room > 0 {
            s.push('\n');
            s.extend(duty.chars().take(room));
        }
    }
    let notes = one_line(&e.prompt_modifier);
    if !notes.is_empty() {
        let head = "\nMODE NOTES: ";
        let room = MODE_BLOCK_MAX.saturating_sub(s.chars().count() + head.chars().count());
        if room > 0 {
            s.push_str(head);
            s.extend(notes.chars().take(room));
        }
    }
    s
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── Dispatch gate (pure) ────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchKind {
    /// A Prompter → Designer → Coder build. `auto`: queued without the spoken Tier-3 offer.
    BuildPipeline { auto: bool },
    /// A hand-off to one sub-agent (the offer card's agent target). The webview applies it
    /// (`tier3Action`); Rust keeps it in the truth table so both sides share one rule.
    #[cfg_attr(not(test), allow(dead_code))]
    AgentHandoff,
}

pub const MODE_SURFACE_ONLY: &str = "MODE_SURFACE_ONLY";
pub const MODE_NOT_AUTO: &str = "MODE_NOT_AUTO";

pub fn dispatch_allowed(policy: DispatchPolicy, kind: DispatchKind) -> Result<(), &'static str> {
    match (policy, kind) {
        (DispatchPolicy::SurfaceOnly, _) => Err(MODE_SURFACE_ONLY),
        (DispatchPolicy::AutoDispatch, _) => Ok(()),
        (_, DispatchKind::BuildPipeline { auto: true }) => Err(MODE_NOT_AUTO),
        _ => Ok(()),
    }
}

/// The error a refused build returns (the prefix is what the webview's calm-error map keys on).
pub fn refusal_message(code: &str) -> String {
    match code {
        MODE_SURFACE_ONLY => format!("{MODE_SURFACE_ONLY}: Solo mode is on; nothing was queued."),
        MODE_NOT_AUTO => format!("{MODE_NOT_AUTO}: only Builder mode queues a build without your yes; nothing was queued."),
        other => format!("{other}: nothing was queued."),
    }
}

/// `dispatch_allowed` with the user-facing refusal.
pub fn check_dispatch(policy: DispatchPolicy, kind: DispatchKind) -> Result<(), String> {
    dispatch_allowed(policy, kind).map_err(refusal_message)
}

// ── Validation ──────────────────────────────────────────────────────────────

/// Words no mode text may carry into Tony's prompt: the format word flips the provider chain
/// (`dispatch::skip_agentic_os`), the thinking switch must stay the last line, and the novelty
/// word is never the model's to say (TONY_STYLE).
fn banned_word(s: &str) -> Option<&'static str> {
    let l = s.to_lowercase();
    if l.contains("json") {
        Some("json")
    } else if l.contains("/no_think") {
        Some("/no_think")
    } else if l.contains("gabagool") {
        Some("gabagool")
    } else {
        None
    }
}

/// One mode's own fields (D14).
pub fn validate_mode(m: &TonyMode) -> Result<(), String> {
    if !super::roles::valid_agent_id(&m.id) {
        return Err("mode id: lowercase letters, digits, - or _ (max 32)".into());
    }
    let name = m.name.trim();
    let n = name.chars().count();
    if n == 0 || n > 32 || name.chars().any(char::is_control) {
        return Err("mode name: 1–32 characters".into());
    }
    let i = m.icon.trim().chars().count();
    if i == 0 || i > 32 || m.icon.chars().any(char::is_control) {
        return Err("mode icon: 1–32 characters".into());
    }
    if m.prompt_modifier.chars().count() > MODIFIER_MAX {
        return Err(format!("behaviour rules: at most {MODIFIER_MAX} characters"));
    }
    if m.prompt_modifier.chars().any(char::is_control) {
        return Err("behaviour rules: one line, no control characters".into());
    }
    if !m.is_novelty {
        for (what, text) in [("mode name", name), ("behaviour rules", m.prompt_modifier.as_str())] {
            if let Some(w) = banned_word(text) {
                return Err(format!("{what} can't contain \"{w}\" (it would change how Tony's prompt is handled)"));
            }
        }
    }
    if let Some(b) = &m.switchboard {
        if b.agents.len() > SWITCHBOARD_LIST_MAX || b.tools.len() > SWITCHBOARD_LIST_MAX {
            return Err(format!("switchboard: at most {SWITCHBOARD_LIST_MAX} agents and {SWITCHBOARD_LIST_MAX} tools"));
        }
        for a in &b.agents {
            // Agent labels reach Tony's prompt (the ON DUTY line): ids only, never Tony himself.
            if !super::roles::valid_agent_id(a) || super::roles::is_tony_id(a) || banned_word(a).is_some() {
                return Err(format!("switchboard agent \"{a}\": a sub-agent id (lowercase letters, digits, - or _), never Tony"));
            }
        }
        if let Some(t) = b.tools.iter().find(|t| !super::dispatch::valid_id(t)) {
            return Err(format!("switchboard tool \"{t}\": an MCP server id"));
        }
    }
    Ok(())
}

impl ModesFile {
    fn find(&self, id: &str) -> Option<&TonyMode> {
        self.modes.iter().find(|m| m.id == id)
    }

    /// Add or replace a CUSTOM mode (D12: a preset can't be overwritten; ids are unique).
    /// `is_new`: create (refuse an existing id) vs edit (the id must exist).
    pub fn upsert(&mut self, m: TonyMode, is_new: bool) -> Result<(), String> {
        validate_mode(&m)?;
        if is_builtin(&m.id) {
            return Err("presets can't be edited: duplicate it to make it yours".into());
        }
        if m.is_novelty {
            return Err("only the built-in novelty mode can be a novelty".into());
        }
        let pos = self.modes.iter().position(|x| x.id == m.id);
        match (pos, is_new) {
            (Some(_), true) => Err(format!("a mode with id \"{}\" already exists", m.id)),
            (None, false) => Err(format!("mode \"{}\" not found", m.id)),
            (Some(i), false) => {
                self.modes[i] = TonyMode { name: m.name.trim().into(), ..m };
                Ok(())
            }
            (None, true) => {
                self.modes.push(TonyMode { name: m.name.trim().into(), ..m });
                Ok(())
            }
        }
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        if is_builtin(id) {
            return Err("presets can't be deleted".into());
        }
        if self.active_mode_id == id {
            return Err("switch to another mode before deleting this one".into());
        }
        let before = self.modes.len();
        self.modes.retain(|m| m.id != id);
        if self.modes.len() == before {
            return Err(format!("mode \"{id}\" not found"));
        }
        Ok(())
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        let m = self.find(id).ok_or_else(|| format!("mode \"{id}\" not found"))?;
        if m.is_novelty {
            return Err("Gabagool Mode is a novelty overlay: toggle it, it never replaces the work mode".into());
        }
        self.active_mode_id = id.into();
        Ok(())
    }

    /// A unique custom id from a name ("My Focus" → `my-focus`, then `my-focus-2`…).
    pub fn unique_id(&self, name: &str) -> String {
        let mut base: String = name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        if base.is_empty() || !base.as_bytes()[0].is_ascii_lowercase() {
            base = format!("mode-{base}");
        }
        base.truncate(26);
        let base = base.trim_end_matches('-').to_string();
        let taken = |id: &str| is_builtin(id) || self.find(id).is_some();
        if !taken(&base) {
            return base;
        }
        (2..).map(|n| format!("{base}-{n}")).find(|id| !taken(id)).expect("an id is always free")
    }

    /// A custom copy of `id` named `new_name` (the novelty overlay can't be copied).
    pub fn duplicate(&mut self, id: &str, new_name: &str) -> Result<TonyMode, String> {
        let src = self.find(id).cloned().ok_or_else(|| format!("mode \"{id}\" not found"))?;
        if src.is_novelty {
            return Err("Gabagool Mode can't be duplicated".into());
        }
        let name = if new_name.trim().is_empty() { format!("{} copy", src.name) } else { new_name.trim().to_string() };
        let name: String = name.chars().take(32).collect();
        let copy = TonyMode { id: self.unique_id(&name), name, ..src };
        self.upsert(copy.clone(), true)?;
        Ok(copy)
    }

    /// Re-seed the presets from code (D12), keep valid custom modes, repair the active id. A
    /// custom mode of an older file whose id became a preset (`NEW_BUILTIN_IDS`) is renamed to a
    /// free id and kept (the active id follows it), never silently dropped.
    pub fn normalize(mut self) -> ModesFile {
        let older = self.version < MODES_FILE_VERSION;
        let rows: Vec<TonyMode> = self.modes.drain(..).filter(|m| !m.is_novelty && validate_mode(m).is_ok()).collect();
        let mut modes = presets();
        let mut collided = vec![];
        for m in rows {
            if is_builtin(&m.id) {
                if older && NEW_BUILTIN_IDS.contains(&m.id.as_str()) {
                    collided.push(m);
                }
            } else if !modes.iter().any(|x| x.id == m.id) {
                modes.push(m);
            }
        }
        let mut active = self.active_mode_id;
        for m in collided {
            let id = ModesFile { version: MODES_FILE_VERSION, active_mode_id: String::new(), modes: modes.clone() }.unique_id(&m.name);
            if active == m.id {
                active = id.clone();
            }
            modes.push(TonyMode { id, ..m });
        }
        let active_ok = modes.iter().any(|m| m.id == active && !m.is_novelty);
        ModesFile { version: MODES_FILE_VERSION, active_mode_id: if active_ok { active } else { DEFAULT_MODE_ID.into() }, modes }
    }
}

// ── Store ───────────────────────────────────────────────────────────────────

/// How `modes.json` was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadOutcome {
    /// No file: presets seeded (feedback is NOT touched, D11).
    Seeded,
    Loaded,
    /// Unreadable: moved aside to `modes.json.bad`, presets used.
    Corrupt,
}

/// Read (or seed) `modes.json` at `path`. Never panics; a corrupt file is moved aside.
/// The bool: the file on disk must be (re)written (seeded, repaired or normalised).
pub fn load_file(path: &Path) -> (ModesFile, LoadOutcome, bool) {
    match std::fs::read_to_string(path) {
        Err(_) => (ModesFile::default(), LoadOutcome::Seeded, true),
        Ok(s) => match serde_json::from_str::<ModesFile>(&s) {
            Ok(raw) => {
                let f = raw.clone().normalize();
                let changed = f != raw;
                (f, LoadOutcome::Loaded, changed)
            }
            Err(e) => {
                eprintln!("[modes] modes.json invalid ({e}); using the presets");
                let _ = std::fs::rename(path, path.with_extension("json.bad"));
                (ModesFile::default(), LoadOutcome::Corrupt, true)
            }
        },
    }
}

/// Atomic write (tmp + rename).
fn write_file(path: &Path, f: &ModesFile) -> Result<(), String> {
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(f).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Live modes: the file, its path (None in tests: nothing is written) and the overrides.
#[derive(Default)]
pub struct ModeStore {
    file: RwLock<ModesFile>,
    path: RwLock<Option<PathBuf>>,
    overrides: Mutex<Overrides>,
}

/// A partial override patch (absent = unchanged).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct OverridePatch {
    #[serde(default)]
    pub curiosity: Option<Curiosity>,
    #[serde(default)]
    pub dispatch: Option<DispatchPolicy>,
    #[serde(default)]
    pub verbosity: Option<Verbosity>,
}

impl ModeStore {
    /// Load `dir/modes.json` (seeding it when missing). Returns how it went.
    pub fn load_or_init(&self, dir: &Path) -> LoadOutcome {
        let path = dir.join("modes.json");
        let (f, outcome, write) = load_file(&path);
        if write {
            if let Err(e) = write_file(&path, &f) {
                eprintln!("[modes] couldn't write modes.json: {e}");
            }
        }
        *self.file.write().unwrap() = f;
        *self.path.write().unwrap() = Some(path);
        *self.overrides.lock().unwrap() = Overrides::default();
        outcome
    }

    pub fn file(&self) -> ModesFile {
        self.file.read().unwrap().clone()
    }

    pub fn overrides(&self) -> Overrides {
        self.overrides.lock().unwrap().clone()
    }

    pub fn effective(&self) -> Effective {
        effective(&self.file.read().unwrap(), &self.overrides.lock().unwrap())
    }

    /// The active mode's own narration level (ignoring overrides).
    pub fn mode_feedback(&self) -> u8 {
        feedback_for(active_mode(&self.file.read().unwrap()).tts_interrupt_level)
    }

    fn mutate<T>(&self, f: impl FnOnce(&mut ModesFile) -> Result<T, String>) -> Result<T, String> {
        let mut next = self.file();
        let out = f(&mut next)?;
        if let Some(p) = self.path.read().unwrap().clone() {
            write_file(&p, &next)?;
        }
        *self.file.write().unwrap() = next;
        Ok(out)
    }

    /// Switch the work mode: overrides are cleared (D18).
    pub fn set_active(&self, id: &str) -> Result<Effective, String> {
        self.mutate(|f| f.set_active(id))?;
        *self.overrides.lock().unwrap() = Overrides::default();
        Ok(self.effective())
    }

    pub fn apply_override(&self, p: &OverridePatch) -> Effective {
        {
            let mut o = self.overrides.lock().unwrap();
            if p.curiosity.is_some() {
                o.curiosity = p.curiosity;
            }
            // Learning locks dispatch to Solo (the webview disables the dial; a phone patch is ignored).
            if p.dispatch.is_some() && active_mode(&self.file.read().unwrap()).id != LEARNING_ID {
                o.dispatch = p.dispatch;
            }
            if p.verbosity.is_some() {
                o.verbosity = p.verbosity;
            }
        }
        self.effective()
    }

    /// A manual narration level (NarrationControl / the narration voice intent): an override
    /// unless it equals the mode's own level.
    pub fn note_feedback(&self, level: u8) {
        let mode = self.mode_feedback();
        self.overrides.lock().unwrap().feedback = (level != mode).then_some(level);
    }

    pub fn clear_overrides(&self) -> Effective {
        *self.overrides.lock().unwrap() = Overrides::default();
        self.effective()
    }

    pub fn upsert(&self, m: TonyMode, is_new: bool) -> Result<(), String> {
        self.mutate(|f| f.upsert(m, is_new))
    }

    pub fn duplicate(&self, id: &str, new_name: &str) -> Result<TonyMode, String> {
        self.mutate(|f| f.duplicate(id, new_name))
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.mutate(|f| f.delete(id))
    }

    /// `tony_modes_get` / the `tony-mode-changed` payload.
    pub fn view(&self) -> Value {
        let f = self.file();
        json!({
            "modes": f.modes,
            "active_mode_id": f.active_mode_id,
            "effective": self.effective(),
            "overrides": self.overrides(),
            "builtin_ids": BUILTIN_IDS,
        })
    }

    /// The phone mirror's `mode` block (`/api/os/state`). `promptTail` is the exact MODE block
    /// Tony's system message ends with (the gateway appends it verbatim); `switchboard` carries
    /// the rule's inputs (`agents` / `tools`: the mode's overlay, `null` = none; `frozenAgents` /
    /// `frozenTools`: the master switchboard), so a reader applies `agent_live` / `tool_live`.
    pub fn mirror(&self, global: &SwitchboardConfig) -> Value {
        let e = self.effective();
        let list: Vec<Value> = self.file().modes.iter().map(|m| json!({ "id": m.id, "name": m.name, "icon": m.icon, "isNovelty": m.is_novelty })).collect();
        json!({
            "id": e.mode_id,
            "name": e.name,
            "icon": e.icon,
            "curiosity": e.curiosity,
            "verbosity": e.verbosity,
            "dispatch": e.dispatch,
            "feedbackLevel": e.feedback_level,
            "overridden": e.overridden,
            "list": list,
            "nightTraining": e.night_training,
            "promptTail": mode_block(&e),
            "switchboard": {
                "agents": e.switchboard.as_ref().map(|b| b.agents.clone()),
                "tools": e.switchboard.as_ref().map(|b| b.tools.clone()),
                "frozenAgents": global.frozen_agents,
                "frozenTools": global.frozen_tools,
            },
        })
    }
}

// ── Operations shared by the commands and the phone inbox ───────────────────

pub const MODE_CHANGED_EVENT: &str = "tony-mode-changed";

/// Switch mode: modes.json, then `feedback.sensitivity` from the mode's tts level (the switch's
/// own write is never an override), then the phone mirror.
pub fn switch_mode(os: &OsState, id: &str) -> Result<Effective, String> {
    os.modes.set_active(id)?;
    let lvl = os.modes.mode_feedback();
    os.update(|c| {
        c.feedback.sensitivity = lvl;
        Ok(())
    })?;
    Ok(os.modes.effective())
}

/// Clear the overrides and restore the mode's narration level.
pub fn reset_overrides(os: &OsState) -> Result<Effective, String> {
    os.modes.clear_overrides();
    let lvl = os.modes.mode_feedback();
    os.update(|c| {
        c.feedback.sensitivity = lvl;
        Ok(())
    })?;
    Ok(os.modes.effective())
}

pub fn override_mode(os: &OsState, p: &OverridePatch) -> Effective {
    let e = os.modes.apply_override(p);
    os.refresh_mirror();
    e
}

/// The phone's inbox `command` mode keys (`modeId`, `overrides`, `resetOverrides`). `None` when
/// the payload carries none of them.
pub fn apply_inbox_command(os: &OsState, p: &Value) -> Result<Option<Effective>, String> {
    let mut out = None;
    if let Some(id) = p["modeId"].as_str() {
        out = Some(switch_mode(os, id)?);
    }
    if p["resetOverrides"].as_bool() == Some(true) {
        out = Some(reset_overrides(os)?);
    }
    if let Some(o) = p.get("overrides").filter(|v| v.is_object()) {
        let patch: OverridePatch = serde_json::from_value(o.clone()).map_err(|e| format!("bad overrides: {e}"))?;
        out = Some(override_mode(os, &patch));
    }
    Ok(out)
}

static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// lib.rs setup: lets a tool-driven switch (`tony.set_mode`) tell the webview, like the menu does.
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// A work mode from what Tony (or a person) calls it: the id, the display name, or an alias
/// ("coach", "motivation", "exec", "solo", "study", "brainstorming"…). Never Gabagool (a toggle,
/// not a work mode). Pure.
pub fn resolve_work_mode(q: &str) -> Option<&'static str> {
    let q = q.trim().to_ascii_lowercase().replace(['/', '-', '_'], " ");
    let q = q.trim_end_matches(" mode").split_whitespace().collect::<Vec<_>>().join(" ");
    const ALIASES: [(&str, &[&str]); 7] = [
        ("surface", &["surface", "solo", "surface solo"]),
        ("builder", &["builder", "build", "building"]),
        ("operations", &["operations", "ops", "operation", "operational", "business operations"]),
        ("coach", &["coach", "coaching", "motivation", "motivational", "motivation coach", "motivational coach"]),
        ("brainstorm", &["brainstorm", "brainstorming"]),
        ("executive", &["executive", "exec", "strategy", "high level strategy"]),
        ("learning", &["learning", "learn", "study", "training"]),
    ];
    ALIASES.iter().find(|(_, a)| a.contains(&q.as_str())).map(|(id, _)| *id)
}

/// `tony.set_mode`: Tony switches its own work mode when the user asks in natural words ("act
/// like my coach right now"). The same `switch_mode` + change event as the top-bar menu.
pub fn set_mode_by_tool(os: &OsState, mode: &str) -> Result<String, String> {
    let id = resolve_work_mode(mode).ok_or_else(|| format!("unknown mode \"{mode}\" — use surface, builder, operations, coach, brainstorm, executive or learning"))?;
    let e = switch_mode(os, id)?;
    if let Some(app) = APP.get() {
        emit_changed(app, os);
    }
    let name = os.modes.view()["modes"].as_array().and_then(|a| a.iter().find(|m| m["id"] == id)).and_then(|m| m["name"].as_str().map(String::from)).unwrap_or_else(|| id.to_string());
    let _ = e;
    Ok(format!("Switched mode: {name}. From your next reply on you follow that mode's rules."))
}

fn emit_changed(app: &tauri::AppHandle, os: &OsState) {
    use tauri::{Emitter, Manager};
    let _ = app.emit(MODE_CHANGED_EVENT, os.modes.view());
    // A build the switchboard held (a pipeline agent frozen) resumes now, not on the next 15 s tick.
    if let Some(ws) = app.try_state::<super::taskworker::WorkerState>() {
        ws.notify.notify_one();
    }
    // The tools a turn can use follow the mode's switchboard: tell the webview, and start the
    // servers that just became live so the first turn in the new mode doesn't wait on a cold start.
    super::mcp::emit_tools_changed(app, "mode-changed");
    let app = app.clone();
    tauri::async_runtime::spawn(async move { super::mcp::warm_live(&app).await });
}

/// Tell the webview the mode changed (the phone inbox path).
pub fn notify_changed(app: &tauri::AppHandle) {
    use tauri::Manager;
    emit_changed(app, app.state::<OsState>().inner());
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn tony_modes_get(os: tauri::State<'_, OsState>) -> Value {
    os.modes.view()
}

#[tauri::command]
pub fn tony_mode_set_active(app: tauri::AppHandle, os: tauri::State<'_, OsState>, id: String) -> Result<Value, String> {
    switch_mode(&os, &id)?;
    emit_changed(&app, &os);
    Ok(os.modes.view())
}

#[tauri::command]
pub fn tony_mode_override(app: tauri::AppHandle, os: tauri::State<'_, OsState>, patch: OverridePatch) -> Result<Value, String> {
    override_mode(&os, &patch);
    emit_changed(&app, &os);
    Ok(os.modes.view())
}

#[tauri::command]
pub fn tony_mode_reset(app: tauri::AppHandle, os: tauri::State<'_, OsState>) -> Result<Value, String> {
    reset_overrides(&os)?;
    emit_changed(&app, &os);
    Ok(os.modes.view())
}

/// Create or edit a mode. Editing the ACTIVE mode keeps narration in step with its (possibly
/// new) tts level, but a manual narration override survives: it stays the level in effect (and
/// in os.json) unless it now equals the edited mode's own level, which makes it redundant.
pub fn upsert_mode(os: &OsState, mode: TonyMode, is_new: bool) -> Result<(), String> {
    let active_edit = !is_new && mode.id == os.modes.effective().mode_id;
    os.modes.upsert(mode, is_new)?;
    if active_edit {
        if let Some(l) = os.modes.overrides().feedback {
            os.modes.note_feedback(l);
        }
        let lvl = os.modes.effective().feedback_level;
        os.update(|c| {
            c.feedback.sensitivity = lvl;
            Ok(())
        })?;
    } else {
        os.refresh_mirror();
    }
    Ok(())
}

/// Create (`is_new` default true) or edit a custom mode.
#[tauri::command]
pub fn tony_mode_upsert(app: tauri::AppHandle, os: tauri::State<'_, OsState>, mode: TonyMode, is_new: Option<bool>) -> Result<Value, String> {
    upsert_mode(&os, mode, is_new.unwrap_or(true))?;
    emit_changed(&app, &os);
    Ok(os.modes.view())
}

#[tauri::command]
pub fn tony_mode_duplicate(app: tauri::AppHandle, os: tauri::State<'_, OsState>, id: String, new_name: Option<String>) -> Result<Value, String> {
    let m = os.modes.duplicate(&id, new_name.as_deref().unwrap_or(""))?;
    os.refresh_mirror();
    emit_changed(&app, &os);
    Ok(json!({ "mode": m, "view": os.modes.view() }))
}

#[tauri::command]
pub fn tony_mode_delete(app: tauri::AppHandle, os: tauri::State<'_, OsState>, id: String) -> Result<Value, String> {
    os.modes.delete(&id)?;
    os.refresh_mirror();
    emit_changed(&app, &os);
    Ok(os.modes.view())
}

#[cfg(test)]
mod tests;
