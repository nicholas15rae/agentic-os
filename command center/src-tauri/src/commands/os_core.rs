//! Core OS settings: identity ("Tony"), compute routing (local / hybrid /
//! cloud), droplet, AnythingLLM workspaces, skills + MCP registry, OS master
//! permissions, privacy shield and the memory lifecycle. Stored in
//! `os.json` next to providers.json — never edited from the webview except
//! through the validated commands below.
//!
//! A mirror without secrets is written to `<repo>/data/command-center/os-state.json`
//! so the gateway can serve it to the phone (`GET /api/os/state`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::Duration;
use tauri::State;

use super::bridge::{BridgeState, Tier};
use super::dispatch::{short, DispatchState, Provider};
use super::privacy::Replacement;

// ── Config ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ComputeMode {
    /// 100 % local hardware; every remote/cloud call is blocked, the Claude CLI engines included
    /// (help desk, verifier, Coder offload).
    Local,
    /// Local first; offload BACKGROUND work when VRAM is over the threshold or the prompt is
    /// huge. Tony's own chat turns never overflow (`shape_tony_turn`), and with cloud routing on
    /// Ask (the default) an unpinned remote backend is never used at all (Section 20.6).
    #[default]
    Hybrid,
    /// Remote/droplet first to keep the GPU free; local stays as fallback.
    Cloud,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ComputeConfig {
    pub mode: ComputeMode,
    pub vram_threshold_pct: f32,
    pub heavy_context_chars: usize,
    /// Let reasoning models (Qwen3.5…) think before *answers*. Off = much faster.
    /// Internal calls (planner, tool router, verifier) never think either way.
    pub deep_thinking: bool,
}
impl Default for ComputeConfig {
    fn default() -> Self {
        Self { mode: ComputeMode::Hybrid, vram_threshold_pct: 90.0, heavy_context_chars: 24_000, deep_thinking: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct DropletConfig {
    /// Master switch. Off = shown as OFFLINE (MANUAL) and never contacted.
    pub enabled: bool,
    pub host: String,
    pub qdrant_url: String,
    pub n8n_url: String,
    /// OpenAI-compatible model / proxy endpoint (Ollama, vLLM, OpenRouter bridge…).
    pub model_url: String,
    pub anythingllm_url: String,
}
impl Default for DropletConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: "100.64.0.10".into(),
            qdrant_url: "http://100.64.0.10:6333".into(),
            n8n_url: "http://100.64.0.10:5678".into(),
            model_url: "http://100.64.0.10:8000/v1".into(),
            anythingllm_url: "http://100.64.0.10:3001".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AnythingLlmConfig {
    pub base_url: String,
    /// Agent role → workspace slug.
    pub workspaces: BTreeMap<String, String>,
    pub timeout_secs: u64,
}
impl Default for AnythingLlmConfig {
    fn default() -> Self {
        let ws = [("librarian", "librarian"), ("coder", "coder"), ("booking", "booking"), ("general", "my-workspace"), ("prompter", "prompter-dispatcher"), ("designer", "designer"), ("director", "director"), ("finance", "finance")];
        Self {
            base_url: "http://127.0.0.1:3001".into(),
            workspaces: ws.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            timeout_secs: 90,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentTriggers {
    /// Phrases that name this agent directly ("booking desk", "casting").
    pub names: Vec<String>,
    /// Topic phrases that imply this agent ("whatsapp", "write code").
    pub domains: Vec<String>,
}

fn trig(names: &[&str], domains: &[&str]) -> AgentTriggers {
    AgentTriggers { names: names.iter().map(|s| s.to_string()).collect(), domains: domains.iter().map(|s| s.to_string()).collect() }
}

/// The user's exact default trigger matrix (Part 1 spec). Keyed by role id.
pub fn default_routing_agents() -> BTreeMap<String, AgentTriggers> {
    let mut m = BTreeMap::new();
    // Section 20.1: the frozen Booking Desk has NO topics. Acting logistics (auditions, casting
    // calls, bookings, the agency) are Tony's; recording / editing a self-tape is the Director's.
    // It keeps its NAMES only, so addressing it ("ask the booking desk…") still resolves to it
    // (kind Named) and the switchboard keeps the turn with Tony with the FROZEN note.
    m.insert("booking".to_string(), trig(BOOKING_NAMES, &[]));
    m.insert(
        "prompter".to_string(),
        trig(
            &["prompter", "prompt builder", "spec writer", "architect prompt"],
            &["write a prompt", "build a prompt", "break it into phases", "master prompt", "prompt for claude"],
        ),
    );
    m.insert(
        "coder".to_string(),
        trig(
            &["coder", "developer", "dev agent", "engineer"],
            &["write code", "fix bug", "tauri", "rust", "typescript", "react", "git commit", "repo", "script", "terminal"],
        ),
    );
    m.insert(
        "designer".to_string(),
        trig(&["designer", "ui agent", "ux agent"], &["ui", "ux", "layout", "css", "color palette", "prototype", "play place", "mockup", "animation"]),
    );
    // Plain "self-tape" is Tony's (scheduling one, the audition it is for); recording or editing
    // one is the Director's (the longer phrase out-scores Tony's topic).
    m.insert("director".to_string(), trig(&["director", "editor", "media agent", "video editor"], DIRECTOR_DOMAINS));
    m.insert(
        "librarian".to_string(),
        trig(&["librarian", "memory", "vault", "researcher"], &["search vault", "rag", "knowledge graph", "find document", "notes", "lookup"]),
    );
    // Section 20.2, one owner per topic. Contracting work (masonry, job sites, subcontractors, job
    // quotes / estimates, the future Job Desk) is Tony's until a Job Desk exists
    // (`CONTRACTING_TO_TONY`), and so is infrastructure (droplet, Docker, n8n: his LIVE
    // DASHBOARD); Biz Ops = BF Supplements / the Born Fortuna store / Instagram / e-commerce; money
    // is Finance's; the calendar, schedule and reminders are Tony's.
    m.insert("bizops".to_string(), trig(&["bizops", "operations manager", "ops manager", "business manager", "operations", "business"], BIZOPS_DOMAINS));
    m.insert("finance".to_string(), trig(&["finance", "finance agent", "bookkeeper", "bookkeeping", "accountant"], FINANCE_DOMAINS));
    // Tony has no name triggers: addressing him ("thanks tony", "ask the dispatcher…") is
    // `routing::SELF_NAMES` → kind Self, never a delegation to himself. His topics only mark a
    // line as his own when no agent's topic matched.
    m.insert("general".to_string(), trig(&[], GENERAL_DOMAINS));
    m
}

/// The Booking Desk's own names (no topic words: "casting", "audition", "talent agent" are Tony's).
pub(crate) const BOOKING_NAMES: &[&str] = &["booking desk", "booking agent", "B&Co"];
/// Director topics (media); the self-tape recording / editing phrases came from Booking.
const DIRECTOR_DOMAINS: &[&str] = &[
    "edit video", "self-tape edit", "render", "captions", "reel", "short-form", "thumbnail", "headshot", "photo edit", "b-roll",
    "record a self-tape", "record my self-tape", "film a self-tape", "film my self-tape", "self-tape recording", "edit my self-tape", "edit the self-tape",
];
/// Contracting phrases (the future Job Desk): Tony's topics until a Job Desk agent exists.
const CONTRACTING_TO_TONY: &[&str] = &["job desk", "contracting", "masonry", "job site", "job sites", "subcontractor", "subcontractors", "quote", "quotes", "estimate", "estimates"];
/// Biz Ops: the store and the brand (Section 20.2).
const BIZOPS_DOMAINS: &[&str] = &["inventory", "fulfillment", "open orders", "bf supplements", "supplements", "born fortuna", "instagram", "ecommerce", "online store"];
/// Finance: money (Section 20.2; commissions are acting money).
const FINANCE_DOMAINS: &[&str] = &["ledger", "expenses", "receipt", "receipts", "invoice", "invoices", "cheque", "cheques", "money", "hst", "commission", "commissions", "cash flow", "profit", "p&l", "my books"];
/// Tony: his calendar / schedule / reminders, infrastructure (he reads it on the LIVE DASHBOARD)
/// and, for now, acting (auditions, bookings, the agency) and contracting (no Job Desk yet).
const GENERAL_DOMAINS: &[&str] = &[
    "system status", "switch model", "droplet", "docker", "n8n", "server status", "calendar", "schedule", "reminder", "reminders", "remind me",
    "audition", "auditions", "casting", "casting call", "casting email", "casting emails", "self-tape", "self tape", "callback", "wardrobe", "availability",
    "bookings", "talent agent", "my agent", "agency", "imperious", "draft email to agent",
    "job desk", "contracting", "masonry", "job site", "job sites", "subcontractor", "subcontractors", "quote", "quotes", "estimate", "estimates",
];

/// Section 20.1 / 20.2 one-time re-split: (old owner, phrase) pairs removed from a saved config,
/// exactly these (anything else the user added stays). Booking's whole row is cleared separately.
const ROUTING_MOVED_OFF: &[(&str, &str)] = &[
    ("bizops", "invoice"), ("bizops", "quote"), ("bizops", "job site"), ("bizops", "subcontractor"), ("bizops", "contracting"), ("bizops", "masonry"),
];
/// …and the (new owner, phrase) pairs added once, names marked `n:`.
const ROUTING_ADDED: &[(&str, &str)] = &[
    // Contracting goes to Tony (`CONTRACTING_TO_TONY`).
    ("general", "job desk"), ("general", "contracting"), ("general", "masonry"), ("general", "job site"), ("general", "job sites"), ("general", "subcontractor"), ("general", "subcontractors"), ("general", "quote"), ("general", "quotes"), ("general", "estimate"), ("general", "estimates"),
    ("bizops", "born fortuna"), ("bizops", "instagram"), ("bizops", "online store"),
    ("finance", "invoice"), ("finance", "invoices"), ("finance", "cheque"), ("finance", "cheques"), ("finance", "money"), ("finance", "hst"), ("finance", "commission"), ("finance", "commissions"),
    ("director", "record a self-tape"), ("director", "record my self-tape"), ("director", "film a self-tape"), ("director", "film my self-tape"), ("director", "self-tape recording"), ("director", "edit my self-tape"), ("director", "edit the self-tape"),
    ("general", "calendar"), ("general", "schedule"), ("general", "reminder"), ("general", "reminders"), ("general", "remind me"),
    ("general", "audition"), ("general", "auditions"), ("general", "casting"), ("general", "casting call"), ("general", "casting email"), ("general", "casting emails"), ("general", "self-tape"), ("general", "self tape"), ("general", "callback"), ("general", "wardrobe"), ("general", "availability"),
    ("general", "bookings"), ("general", "talent agent"), ("general", "my agent"), ("general", "agency"), ("general", "imperious"), ("general", "draft email to agent"),
];

/// The routing re-split (Sections 20.1 / 20.2), once: Booking's topics emptied (only its own
/// `BOOKING_NAMES` stay), the moved phrases off their old owners, the new phrases on their new
/// owners (deduped, case-insensitive).
pub(crate) fn resplit_routing(cfg: &mut OsConfig) {
    if let Some(b) = cfg.routing.agents.get_mut("booking") {
        b.names.retain(|n| BOOKING_NAMES.iter().any(|k| super::routing::normalize(k) == super::routing::normalize(n)));
        b.domains.clear();
    }
    for (role, phrase) in ROUTING_MOVED_OFF {
        if let Some(t) = cfg.routing.agents.get_mut(*role) {
            let same = |p: &String| super::routing::normalize(p) == super::routing::normalize(phrase);
            t.names.retain(|n| !same(n));
            t.domains.retain(|d| !same(d));
        }
    }
    for (role, entry) in ROUTING_ADDED {
        let t = cfg.routing.agents.entry(role.to_string()).or_default();
        let (list, phrase) = match entry.strip_prefix("n:") {
            Some(n) => (&mut t.names, n),
            None => (&mut t.domains, *entry),
        };
        if !list.iter().any(|x| super::routing::normalize(x) == super::routing::normalize(phrase)) {
            list.push(phrase.to_string());
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RoutingConfig {
    /// Switch the visible Agents tab to a delegated agent automatically.
    pub auto_switch: bool,
    /// Role → its name/domain triggers (Part 1 routing matrix).
    pub agents: BTreeMap<String, AgentTriggers>,
}
impl Default for RoutingConfig {
    fn default() -> Self {
        Self { auto_switch: true, agents: default_routing_agents() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillsConfig {
    pub dir: String,
    /// Skill name → agents it is attached to ("tony", "booking", "coder", "librarian", "bizops", "claude").
    pub grants: BTreeMap<String, Vec<String>>,
}
impl Default for SkillsConfig {
    fn default() -> Self {
        Self { dir: default_skills_dir(), grants: BTreeMap::new() }
    }
}

fn default_skills_dir() -> String {
    let hub = PathBuf::from(r"G:\ai-hub\skills");
    if hub.is_dir() {
        return hub.display().to_string();
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let claude = PathBuf::from(home).join(".claude").join("skills");
        if claude.is_dir() {
            return claude.display().to_string();
        }
    }
    hub.display().to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    /// "builtin" (implemented natively in Rust) | "stdio" | "http".
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub description: String,
    /// Part 2 per-agent grant list: which sub-agents (plus Tony's own fallback
    /// tool router) may use this server's tools. `None`, an empty list, or a
    /// list containing `"all"` all mean "every agent". Missing on disk for any
    /// config saved before this field existed — `load_or_init` backfills it
    /// per id from `default_mcp_grants`. Tony (`general`/`tony`) respects this
    /// list like every other agent (the tool-owner split; `mcp::servers_for`).
    #[serde(default)]
    pub agents: Option<Vec<String>>,
    /// stdio: seconds to wait for the server's `initialize` reply (cold start), 5–600.
    /// Unset = 120 s for package launchers (npx / uvx / uv / pnpm / pnpx / bunx / pipx /
    /// serena), else 45 s. Also raises the per-call timeout of its tool calls above the
    /// 60 s default (a lower value never shortens it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
    /// stdio: the folder the server runs in (absolute). Unset = the repo (gateway workdir).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Never list or run this server's mutating tools (`mcp::is_mutating_tool`) for any
    /// caller — router, sub-agents, pipelines, the Settings tester.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
}

impl McpServer {
    /// Does this server's grant list cover `agent`? Tony is `general` here like
    /// any other id (`"tony"` and the other self aliases match it).
    pub fn grants(&self, agent: &str) -> bool {
        match &self.agents {
            None => true,
            Some(v) if v.is_empty() => true,
            Some(v) => agent_matches(v, agent),
        }
    }
}

/// `"tony"` (and every other self alias: dispatcher, orchestrator, os, jarvis — see
/// `routing::SELF_ROLE_IDS`) is accepted as an alias of `"general"` everywhere a role id is
/// compared (ground rule) — never renamed on disk in grant lists, just treated the same.
pub(crate) fn canon_agent(a: &str) -> &str {
    if super::routing::is_self_role(a, "") {
        "general"
    } else {
        a
    }
}

/// Self-alias keys in `routing.agents` / `anythingllm.workspaces` ("tony", "dispatcher", the OS
/// name…) fold into `general` (default B-a: canonicalised, not rejected). Triggers merge into
/// general's lists (deduped); a workspace slug only fills general when it has none.
pub(crate) fn canonicalize_self_keys(cfg: &mut OsConfig) {
    let os_name = cfg.os_name.clone();
    let alias = |k: &str| k != "general" && super::routing::is_self_role(k, &os_name);
    let keys: Vec<String> = cfg.routing.agents.keys().filter(|k| alias(k)).cloned().collect();
    for k in keys {
        let Some(t) = cfg.routing.agents.remove(&k) else { continue };
        let g = cfg.routing.agents.entry("general".into()).or_default();
        for n in t.names {
            if !g.names.iter().any(|x| x.eq_ignore_ascii_case(&n)) {
                g.names.push(n);
            }
        }
        for d in t.domains {
            if !g.domains.iter().any(|x| x.eq_ignore_ascii_case(&d)) {
                g.domains.push(d);
            }
        }
    }
    let keys: Vec<String> = cfg.anythingllm.workspaces.keys().filter(|k| alias(k)).cloned().collect();
    for k in keys {
        if let Some(slug) = cfg.anythingllm.workspaces.remove(&k) {
            let g = cfg.anythingllm.workspaces.entry("general".into()).or_default();
            if g.is_empty() {
                *g = slug;
            }
        }
    }
}

/// True if `agent` is covered by a grant list: an explicit `"all"` entry or
/// an id match (treating `"tony"`/`"general"` as the same id). Used for both
/// MCP server grants and skill grants (`SkillsConfig.grants`), both of which
/// accept `"all"` as a wildcard.
pub fn agent_matches(list: &[String], agent: &str) -> bool {
    let agent = canon_agent(agent);
    list.iter().any(|a| a == "all" || canon_agent(a) == agent)
}

/// The default per-agent MCP grants, by server id: the user's tool-ownership split (switchboard
/// spec). Tony (`general`) respects these like every other agent: gmail (reads + the draft card),
/// WhatsApp (read-only server), Brave, weather, time, Spotify, maps and the knowledge graph are his.
/// Coder: filesystem, git, fetch. Designer: filesystem. Director: Shotcut, Media Forge,
/// filesystem (never Tony). Biz Ops: Instagram. Librarian: knowledge graph,
/// filesystem. Prompter: fetch, filesystem, knowledge graph (reads; it is a read-only role).
/// Finance / a trader: none yet. Booking is frozen on the master switchboard but keeps the
/// servers it had, so it comes back exactly as it was if Nic ever thaws it. Any id not named
/// here (a future or user-added server) defaults to every agent ("all"); never `[]`, which also
/// means everyone.
pub fn default_mcp_grants(id: &str) -> Vec<String> {
    let list: &[&str] = match id {
        "weather" | "spotify" | "brave-search" => &["general"],
        "gmail" | "whatsapp" | "time" => &["general"],
        // Google Calendar: Tony's own (reads, and the calendar-add card).
        "calendar" => &["general"],
        // Finance (read-only `finance.ask`, Section 11.10): Tony's alone. The finance role may
        // also read it if Nic grants it; `mcp::finance_reader_refusal` refuses everyone else.
        "finance" => &["general"],
        // Infrastructure status (read-only `system.status`): Tony's, since the Ops agent is gone.
        "system" => &["general"],
        "knowledge-graph" => &["general", "librarian", "prompter"],
        "filesystem" => &["coder", "designer", "director", "librarian", "prompter"],
        "git" => &["coder"],
        "fetch" => &["coder", "prompter"],
        // One owner per integration (Section 21.1): Maps is Tony's; Instagram is Biz Ops' (Tony
        // only reads it, as a mode extra: `TONY_READ_ONLY_SERVERS`).
        "maps" => &["general"],
        "instagram" => &["bizops"],
        // Local media servers: only the Director edits and renders through them.
        "shotcut" | "media-forge" => &["director"],
        _ => &["all"],
    };
    list.iter().map(|s| s.to_string()).collect()
}

/// Servers Tony may only READ, whoever owns them (Section 21.1): Instagram's replies and
/// publishing are Biz Ops'. Enforced in `mcp` (listing and call gate) and in the TS planner.
pub const TONY_READ_ONLY_SERVERS: [&str; 1] = ["instagram"];
/// Servers only the Director runs: never Tony, by grant or by a mode extra (Section 21.1).
pub const DIRECTOR_ONLY_SERVERS: [&str; 2] = ["shotcut", "media-forge"];
/// Roles whose AnythingLLM workspace is never used for a LIVE delegation (chat / voice turns,
/// Section 20.8): the turn stays with Tony. The mapping itself stays in os.json, because the
/// scheduled Librarian scripts (documenter, Memory Scrolls sync, the preflight) still read it.
pub const LIVE_UNMAPPED_ROLES: [&str; 2] = ["booking", "librarian"];

/// The workspace a live turn may delegate `role` to: its mapping, unless the role is one of
/// `LIVE_UNMAPPED_ROLES` (then `None`: Tony answers himself). Pure.
pub fn live_workspace(cfg: &OsConfig, role: &str) -> Option<String> {
    if LIVE_UNMAPPED_ROLES.contains(&role) {
        return None;
    }
    cfg.anythingllm.workspaces.get(role).filter(|s| !s.is_empty()).cloned()
}

/// Section 21.1, once: one owner per integration. WhatsApp → Tony only; Shotcut / Media Forge →
/// the Director only (and out of every Tony mode extra); Instagram → Biz Ops (Tony keeps his
/// read-only Operations extra); Maps → Tony. Every other server only loses the Booking Desk
/// (frozen), as `strip_booking_tools` already does. `enabled` / `read_only` are never touched.
pub(crate) fn apply_integration_owners(cfg: &mut OsConfig) {
    for m in cfg.mcps.iter_mut() {
        let owners: Option<&[&str]> = match m.id.as_str() {
            "whatsapp" => Some(&["general"]),
            "shotcut" | "media-forge" => Some(&["director"]),
            "instagram" => Some(&["bizops"]),
            "maps" => Some(&["general"]),
            _ => None,
        };
        if let Some(o) = owners {
            m.agents = Some(o.iter().map(|s| s.to_string()).collect());
        }
    }
    for extras in cfg.tony_mode_tools.values_mut() {
        extras.retain(|s| !DIRECTOR_ONLY_SERVERS.contains(&s.as_str()));
    }
    strip_booking_tools(cfg);
}

/// Server ids whose grants the one-time tool-owner migration rewrites (`default_mcp_grants`).
pub const TOOL_OWNER_SERVERS: [&str; 15] = ["weather", "time", "fetch", "filesystem", "git", "knowledge-graph", "brave-search", "gmail", "calendar", "spotify", "maps", "instagram", "whatsapp", "shotcut", "media-forge"];

/// Skill grants of the tool-owner split: the Designer's two design skills, the Director's motion
/// vocabulary. Tony has none (a skill body is injected into a sub-agent's task only when the task
/// matches it, `mcp::relevant_skills`).
pub const DESIGNER_SKILLS: [&str; 2] = ["impeccable", "design-taste-frontend"];
pub const DIRECTOR_SKILLS: [&str; 1] = ["animation-vocabulary"];

// ── Master switchboard ──────────────────────────────────────────────────────

/// `switchboard.version` once the tool-owner migration ran (and for a fresh config).
pub const SWITCHBOARD_VERSION: u32 = 1;

/// The master (global) switchboard: agents (routing role ids) and tools (`mcps[].id`) that are
/// frozen in EVERY mode. A runtime mask, like a mode's overlay (`modes::ModeSwitchboard`): a
/// frozen agent or server keeps all of its settings and returns exactly as it was. `version` is
/// the one-time tool-owner migration's flag (0 = an os.json saved before it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchboardConfig {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_frozen_agents")]
    pub frozen_agents: Vec<String>,
    #[serde(default)]
    pub frozen_tools: Vec<String>,
}

/// Frozen on a fresh master switchboard (and by the one-time migration): Booking, and the
/// Librarian, which runs only as its scheduled script (internal / scheduled Librarian calls are
/// not switchboard turns and stay ungated).
pub const DEFAULT_FROZEN_AGENTS: [&str; 2] = ["booking", "librarian"];

fn default_frozen_agents() -> Vec<String> {
    DEFAULT_FROZEN_AGENTS.iter().map(|s| s.to_string()).collect()
}

impl Default for SwitchboardConfig {
    fn default() -> Self {
        Self { version: SWITCHBOARD_VERSION, frozen_agents: default_frozen_agents(), frozen_tools: vec![] }
    }
}

impl SwitchboardConfig {
    /// An os.json with no `switchboard` key: Booking and the Librarian frozen, migration still to run.
    fn legacy() -> Self {
        Self { version: 0, ..Self::default() }
    }
}

fn builtin(id: &str, name: &str, enabled: bool, description: &str) -> McpServer {
    McpServer {
        id: id.into(),
        name: name.into(),
        transport: "builtin".into(),
        command: String::new(),
        args: vec![],
        env: BTreeMap::new(),
        url: String::new(),
        enabled,
        builtin: true,
        description: description.into(),
        agents: None,
        ..Default::default()
    }
}

pub fn default_mcps() -> Vec<McpServer> {
    let mut v = vec![
        builtin("weather", "Weather / Open-Meteo", true, "Live conditions and 3-day forecast for any place."),
        builtin("time", "Time (America/Toronto)", true, "Current local date and time."),
        builtin("fetch", "Fetch", true, "Download a web page as plain text."),
        builtin("filesystem", "Filesystem", true, "List and read files under the allowed roots (C:\\ai-hub, this project)."),
        builtin("git", "Git", true, "Status and recent commits of a repository under the allowed roots."),
        builtin("knowledge-graph", "Knowledge Graph", true, "Search D:\\ai-hub-memory\\knowledge-graph.json (shared with Memory Scrolls)."),
        builtin("brave-search", "Brave Search", false, "Web search (needs a Brave API key in Settings)."),
        builtin("gmail", "Gmail", false, "Search and read your inbox via your Google Apps Script deployment (or the read-only n8n workflow \"gmail-recent\")."),
        builtin("spotify", "Spotify", false, "Now playing, playback control, recent tracks and playlists (connect in Settings → Integrations)."),
        builtin("maps", "Maps / OpenStreetMap", true, "Geocoding (Nominatim), driving routes and ETAs (OSRM, no live traffic) and the Route Map widget. No key needed."),
        builtin("instagram", "Instagram", true, "Your Instagram Professional account: profile stats, recent posts and insights, comments. Replies and publishing only after the confirmation card (needs INSTAGRAM_ACCESS_TOKEN)."),
        builtin("calendar", "Google Calendar", true, "Your upcoming events through the Google Apps Script deployment AnythingLLM's Calendar agent uses (imported on first use). Adding an event only after the confirmation card; never invites."),
        builtin("finance", "Finance (read-only)", true, "Tony answers money questions from the Finance records on the local gateway: what you owe an agent, income and expenses by area, pending money, unpaid invoices, HST dates. Read-only summaries, never raw rows; changes stay on the Finance screens."),
        builtin("system", "System status (read-only)", true, "Tony checks whether the droplet (over NetBird), the gateway, Bionic, speech-to-text, Kokoro, Docker and n8n are up, with latency. Short read-only probes; never starts, stops or changes anything."),
        McpServer {
            id: "whatsapp".into(),
            name: "WhatsApp Bridge".into(),
            transport: "stdio".into(),
            command: "uv".into(),
            args: vec!["--directory".into(), r"G:\ai-hub\whatsapp-mcp\whatsapp-mcp-server".into(), "run".into(), "main.py".into()],
            env: BTreeMap::new(),
            url: String::new(),
            enabled: false,
            builtin: true,
            description: "lharries/whatsapp-mcp — start the Go bridge (whatsapp-bridge) first.".into(),
            agents: None,
            // Read-only by default: send_message / send_file are refused for every caller.
            read_only: true,
            ..Default::default()
        },
        media_mcp(
            "shotcut",
            "Shotcut (MLT)",
            "python",
            &[r"G:\ai-hub\mcp\shotcut-mcp\scripts\shotcut_mcp_server.py"],
            &[
                // The LADSPA module's plugin scan hangs melt on this machine.
                ("MLT_REPOSITORY_DENY", "libmltladspa"),
                ("SHOTCUT_MCP_ALLOWED_ROOTS", MEDIA_ROOT),
                ("SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS", "1"),
                ("SHOTCUT_MCP_MAX_ACTIVE_RENDERS", "1"),
            ],
            "matrodrigs/shotcut-mcp — multi-track MLT timelines, QC, previews and job-based renders inside G:\\ai-hub\\media. Needs Shotcut installed.",
        ),
        media_mcp(
            "media-forge",
            "Media Forge",
            "uv",
            &["--directory", MEDIA_FORGE_DIR, "run", "server.py"],
            &[("MEDIA_ROOT", MEDIA_ROOT), ("MEDIA_CPU_PCT", "70"), ("WHISPER_DEVICE", "cpu"), ("WHISPER_COMPUTE", "int8")],
            "Local trim / loudness / assemble / reframe + captions, CPU Whisper transcripts, scene detection and photo batches (command center/mcp/media-forge). Never writes into raw/.",
        ),
    ];
    for m in &mut v {
        m.agents = Some(default_mcp_grants(&m.id));
    }
    v
}

/// The Director's media root: every media MCP is confined to it.
pub const MEDIA_ROOT: &str = r"G:\ai-hub\media";
/// media-forge's uv project (in this repo, outside the Tauri bundle).
const MEDIA_FORGE_DIR: &str = r"G:\agentic os\command center\mcp\media-forge";

/// A local media MCP: off until Nic turns it on in Settings, granted to the Director only,
/// the longest per-call budget (renders past it run as background jobs). `MEDIA_ALLOW_GPU`
/// is never set here: GPU encodes stay refused and `mcp::gpu_refusal` guards the rest.
fn media_mcp(id: &str, name: &str, command: &str, args: &[&str], env: &[(&str, &str)], description: &str) -> McpServer {
    McpServer {
        id: id.into(),
        name: name.into(),
        transport: "stdio".into(),
        command: command.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        enabled: false,
        builtin: true,
        description: description.into(),
        timeout_secs: Some(600),
        read_only: false,
        ..Default::default()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OsPermissions {
    /// Tony → AnythingLLM sub-agents.
    pub delegation: Tier,
    /// Tony runs its own MCP tools.
    pub mcp: Tier,
    /// Filesystem MCP read access (writes are never exposed to the model).
    pub filesystem: Tier,
    /// Anything that leaves this machine (cloud models, droplet, overseer).
    pub cloud: Tier,
}
impl Default for OsPermissions {
    fn default() -> Self {
        // Cloud / droplet routing sends data off the machine: Ask (Section 20.7).
        Self { delegation: Tier::Allow, mcp: Tier::Allow, filesystem: Tier::Allow, cloud: Tier::Ask }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PrivacyConfig {
    pub diffuser: bool,
    pub network_lock: bool,
    pub kill_switch: bool,
    pub destructive_gate: bool,
    /// Client names, venues, anything else to always redact.
    pub sensitive_terms: Vec<String>,
}
impl Default for PrivacyConfig {
    fn default() -> Self {
        Self { diffuser: true, network_lock: true, kill_switch: false, destructive_gate: true, sensitive_terms: vec![] }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OverseerConfig {
    /// "claude-cli" | "claude-api" | "gemini-cli" | "gemini-api" | "droplet" | "local".
    pub engine: String,
    pub claude_model: String,
    pub gemini_model: String,
    /// Off = only the "Ask Claude Overseer" button escalates.
    pub auto_escalate: bool,
    /// Manual Overseer Mode: every mutating plan also gets an overseer review on the card.
    pub manual_mode: bool,
}
impl Default for OverseerConfig {
    fn default() -> Self {
        Self {
            engine: "claude-cli".into(),
            claude_model: "claude-opus-5-5".into(),
            gemini_model: "gemini-2.5-pro".into(),
            auto_escalate: false,
            manual_mode: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryConfig {
    /// "local" | "droplet" | "hybrid" — where Memory Books get mounted for RAG.
    pub storage: String,
    /// Legacy "Auto-run monthly" (read once by the `vault-cadence` migration, never written back).
    #[serde(skip_serializing)]
    pub auto_monthly: bool,
    /// "Auto-regulate Vault & Lifecycle": the standing consent for scheduled harvests (and, with
    /// `auto_flush` / `prune_threads`, the destructive steps after a verified backup).
    pub auto_run_enabled: bool,
    /// "daily" | "weekly" | "monthly" (`hygiene::Cadence`; anything else reads as monthly).
    pub cadence: String,
    /// Local hour of the daily / weekly / monthly slot (default 03:00).
    #[serde(deserialize_with = "de_clamped::<_, 0, 23>")]
    pub target_hour: u8,
    /// Weekly quiet window weekday, 0 = Sunday … 6 = Saturday.
    #[serde(deserialize_with = "de_clamped::<_, 0, 6>")]
    pub weekly_day: u8,
    /// Unix secs of the last harvest whose vault files passed their SHA-256 re-read (0 = never).
    pub last_verified_harvest_at: u64,
    /// After a verified harvest, also delete Tony's OS-created local AnythingLLM threads for the
    /// period (the next turn opens a fresh thread seeded with the newest summary). Off by default.
    pub prune_threads: bool,
    pub auto_flush: bool,
    pub vault_dir: String,
    /// "chatml" | "alpaca" | "sharegpt".
    pub dataset_format: String,
    /// Workspace that receives mounted Memory Books.
    pub mount_workspace: String,
    /// Droplet Qdrant collections treated as disposable cache (flushed after backup).
    pub cache_collections: Vec<String>,
    pub last_auto_month: String,
    /// Tony's documenter root. Empty = `<gateway.workdir>/memory/tony` (gitignored).
    pub notes_dir: String,
    /// Pipeline output root (`<root>/<project slug>/`). Empty = `<gateway.workdir>/staging` (gitignored).
    pub staging_dir: String,
    /// Phase 3 tiered memory ("Memory Scrolls"): where scrolls live, auto-compaction knobs.
    pub scrolls: ScrollsConfig,
    /// Tony's hot path: rolling-history and RAG lookup caps.
    pub hot_path: HotPathConfig,
}
impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            storage: "local".into(),
            auto_monthly: false,
            auto_run_enabled: false,
            cadence: "monthly".into(),
            target_hour: 3,
            weekly_day: 0,
            last_verified_harvest_at: 0,
            prune_threads: false,
            auto_flush: false,
            vault_dir: r"G:\ai-hub\vault\locked-archives".into(),
            dataset_format: "chatml".into(),
            mount_workspace: "my-workspace".into(),
            cache_collections: vec![],
            last_auto_month: String::new(),
            notes_dir: String::new(),
            staging_dir: String::new(),
            scrolls: ScrollsConfig::default(),
            hot_path: HotPathConfig::default(),
        }
    }
}

/// Caps on what one Tony turn carries and how long its memory lookups may take (`memory.hotPath`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HotPathConfig {
    /// Total characters of rolling history sent with a turn (oldest dropped first).
    #[serde(deserialize_with = "de_clamped_u32::<_, 1000, 32000>")]
    pub history_chars: u32,
    /// Any single history message is clipped to this many characters.
    #[serde(deserialize_with = "de_clamped_u32::<_, 200, 8000>")]
    pub history_msg_chars: u32,
    /// Memory / RAG lookup budget before Tony answers directly without it.
    #[serde(deserialize_with = "de_clamped_u32::<_, 1500, 2500>")]
    pub rag_timeout_ms: u32,
    /// Recall hits per lookup.
    #[serde(deserialize_with = "de_clamped_u32::<_, 1, 8>")]
    pub rag_top_k: u32,
    /// Characters of recalled memory per lookup.
    #[serde(deserialize_with = "de_clamped_u32::<_, 200, 2000>")]
    pub rag_chunk_chars: u32,
    /// Characters of the newest Memory Scroll summary added to a turn (0 = off).
    #[serde(deserialize_with = "de_clamped_u32::<_, 0, 4000>")]
    pub scroll_summary_chars: u32,
}
impl Default for HotPathConfig {
    fn default() -> Self {
        Self { history_chars: 6000, history_msg_chars: 1500, rag_timeout_ms: 2000, rag_top_k: 3, rag_chunk_chars: 450, scroll_summary_chars: 900 }
    }
}

/// The live Phase 3 memory root (Nic's decision): scrolls and the knowledge graph live on G: (the
/// project drive), never under the read-only hub. Nothing in the app creates it (the host `--apply` does).
#[cfg(test)]
pub const DEFAULT_MEMORY_DIR: &str = r"G:\ai-hub-memory";
/// `G:\ai-hub-memory\scrolls`: the Tier-2 Memory Scrolls (the only layer embedded in RAG).
pub const DEFAULT_SCROLLS_DIR: &str = r"G:\ai-hub-memory\scrolls";
/// `G:\ai-hub-memory\knowledge-graph.json`: the one knowledge graph the app's `kg.search` and the
/// Phase 3 CLI share.
pub const DEFAULT_KG_PATH: &str = r"G:\ai-hub-memory\knowledge-graph.json";
/// The read-only hub: no Memory Scrolls write target (scrolls / archive dir) may resolve under it.
pub const READ_ONLY_HUB_ROOT: &str = r"G:\ai-hub";
/// Where the hub lived before the move to G: (now a junction to it). Still refused, so a write
/// through the old path can never slip past the guard.
pub const LEGACY_HUB_ROOT: &str = r"C:\ai-hub";

/// A comparable, lexical form of a Windows path: backslashes, no `\\?\` / `\\.\` prefix, `.` and
/// `..` collapsed, trailing dots / spaces of each component dropped (as Win32 does), lower case.
fn hub_path_key(s: &str) -> String {
    let mut s = s.trim().replace('/', "\\");
    for pre in [r"\\?\UNC\", r"\\.\UNC\"] {
        if s.len() >= pre.len() && s[..pre.len()].eq_ignore_ascii_case(pre) {
            s = format!(r"\\{}", &s[pre.len()..]);
        }
    }
    for pre in [r"\\?\", r"\\.\"] {
        if let Some(rest) = s.strip_prefix(pre) {
            s = rest.to_string();
        }
    }
    // `\\host\C$\...` (an administrative drive share; `canonicalize` of one is `\\?\UNC\host\C$\...`)
    // maps back to `C:\...` for any host: fail closed, a remote C$\ai-hub is refused too.
    if let Some(rest) = s.strip_prefix(r"\\") {
        let mut it = rest.splitn(3, '\\');
        if let (Some(host), Some(share)) = (it.next(), it.next()) {
            let b = share.as_bytes();
            if !host.is_empty() && b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b'$' {
                s = format!(r"{}:\{}", b[0] as char, it.next().unwrap_or(""));
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    for (i, part) in s.split('\\').enumerate() {
        match part {
            "." => continue,
            ".." => {
                if out.len() > 1 {
                    out.pop();
                }
                continue;
            }
            "" if i > 0 => continue,
            _ => {}
        }
        let p = part.trim_end_matches(['.', ' ']);
        out.push(p.to_lowercase());
    }
    out.join("\\")
}

/// `p` with its deepest existing ancestor canonicalized (symlinks / junctions resolved) and the
/// missing tail re-appended; `None` when no ancestor resolves.
fn canonical_prefix(p: &Path) -> Option<String> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = std::fs::canonicalize(&cur) {
            let mut out = c;
            for t in tail.iter().rev() {
                out.push(t);
            }
            return Some(out.to_string_lossy().into_owned());
        }
        tail.push(cur.file_name()?.to_os_string());
        if !cur.pop() {
            return None;
        }
    }
}

/// True when `p` is (or lies under) `root`, compared case-insensitively on both the literal path
/// and its resolved form, so a junction elsewhere that lands inside `root` is caught too.
pub fn path_under_root(p: &Path, root: &str) -> bool {
    let raw = p.to_string_lossy();
    if raw.trim().is_empty() {
        return false;
    }
    let mut roots = vec![hub_path_key(root)];
    if let Ok(c) = std::fs::canonicalize(root) {
        roots.push(hub_path_key(&c.to_string_lossy()));
    }
    let mut cands = vec![hub_path_key(&raw)];
    if let Some(c) = canonical_prefix(p) {
        cands.push(hub_path_key(&c));
    }
    cands.iter().any(|c| roots.iter().any(|r| !r.is_empty() && (c == r || c.starts_with(&format!("{r}\\")))))
}

/// True when `p` resolves under the read-only hub (`G:\ai-hub`, or its old `C:\ai-hub` path).
pub fn under_read_only_hub(p: &Path) -> bool {
    [READ_ONLY_HUB_ROOT, LEGACY_HUB_ROOT].iter().any(|r| path_under_root(p, r))
}

/// Phase 3 Memory Scrolls (`memory.scrolls`). Rust only READS scrolls (Librarian) and launches
/// the host `memory_scrolls` CLI; it never writes `.env` (the archive dir lives here or in env).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScrollsConfig {
    /// Empty = `G:\ai-hub-memory\scrolls`. A value under the read-only hub is refused
    /// (`sanitized()` falls back to the default).
    pub scrolls_dir: String,
    /// Cold archive root. Empty = the CLI's resolution (env, `.env`, `D:\ai-hub-archive`, `./archive/memory`).
    /// A value under `C:\ai-hub` is refused like `scrolls_dir`.
    pub archive_dir: String,
    /// AnythingLLM workspace the changed scrolls sync into (never a Booking workspace).
    pub workspace: String,
    /// True = Tony's per-note documenter ingest is skipped (scrolls are the only embedded layer).
    pub embed_only: bool,
    /// Idle auto-compaction (off by default; the manual button always works).
    pub auto_compact: bool,
    #[serde(deserialize_with = "de_clamped_u32::<_, 8, 1024>")]
    pub threshold_kb: u32,
    #[serde(deserialize_with = "de_clamped_u32::<_, 5, 500>")]
    pub threshold_turns: u32,
    /// Minutes without a voice / Tony turn before an auto run.
    #[serde(deserialize_with = "de_clamped_u32::<_, 2, 240>")]
    pub quiet_mins: u32,
    #[serde(deserialize_with = "de_clamped_u32::<_, 60, 3600>")]
    pub check_secs: u32,
    /// LM calls per auto run (`--max-batches`).
    #[serde(deserialize_with = "de_clamped_u32::<_, 1, 4>")]
    pub max_batches_auto: u32,
}
impl Default for ScrollsConfig {
    fn default() -> Self {
        Self { scrolls_dir: String::new(), archive_dir: String::new(), workspace: "librarian".into(), embed_only: false, auto_compact: false, threshold_kb: 50, threshold_turns: 25, quiet_mins: 10, check_secs: 300, max_batches_auto: 1 }
    }
}
impl ScrollsConfig {
    /// The workspace, refused (-> `librarian`) when it is a Booking slug or not a valid slug.
    pub fn sanitized_workspace(&self) -> String {
        let w = self.workspace.trim();
        let ok = !w.is_empty() && w.len() <= 64 && w.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && w.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !ok || super::agent_prompts::NEVER_TOUCH.contains(&w) {
            "librarian".into()
        } else {
            w.to_string()
        }
    }

    /// A copy with every value read-safe (workspace sanitised; a scrolls / archive dir under the
    /// read-only `C:\ai-hub` dropped, so the default applies; numbers are clamped on load).
    pub fn sanitized(&self) -> Self {
        Self { workspace: self.sanitized_workspace(), scrolls_dir: not_under_hub(&self.scrolls_dir), archive_dir: not_under_hub(&self.archive_dir), ..self.clone() }
    }

    /// The scrolls root (configured or the default; a configured dir under `C:\ai-hub` is refused).
    pub fn scrolls_root(&self) -> std::path::PathBuf {
        let d = not_under_hub(&self.scrolls_dir);
        std::path::PathBuf::from(if d.is_empty() { DEFAULT_SCROLLS_DIR } else { d.as_str() })
    }
}

/// `d` trimmed, or empty when it resolves under the read-only `C:\ai-hub`.
fn not_under_hub(d: &str) -> String {
    let t = d.trim();
    if t.is_empty() || under_read_only_hub(Path::new(t)) {
        String::new()
    } else {
        t.to_string()
    }
}

/// Clamp-on-read for small integer settings (an out-of-range value in os.json or a patch is
/// pulled into range instead of failing the whole config).
fn de_clamped<'de, D: serde::Deserializer<'de>, const LO: u8, const HI: u8>(d: D) -> Result<u8, D::Error> {
    let v = i64::deserialize(d)?;
    Ok(v.clamp(LO as i64, HI as i64) as u8)
}

fn de_clamped_u32<'de, D: serde::Deserializer<'de>, const LO: u32, const HI: u32>(d: D) -> Result<u32, D::Error> {
    let v = i64::deserialize(d)?;
    Ok(v.clamp(LO as i64, HI as i64) as u32)
}

/// Agent narration (the agent event bus → voice).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct FeedbackConfig {
    /// 0 silent (toasts only) · 1 milestones + failures · 2 + handoffs · 3 verbose. Clamped 0–3.
    #[serde(deserialize_with = "de_clamped::<_, 0, 3>")]
    pub sensitivity: u8,
    /// "roster" = each agent's own voice from the roster (providers.json agentVoices, Kokoro
    /// defaults for gaps); "kokoro" = local Kokoro only (spares the ElevenLabs quota).
    pub narration_engine: String,
}
impl Default for FeedbackConfig {
    fn default() -> Self {
        // Narration on local Kokoro: spares ElevenLabs credits and its concurrency 429s; Tony's
        // replies and agent reports keep their ElevenLabs voices (Section 20.4).
        Self { sensitivity: 1, narration_engine: "kokoro".into() }
    }
}

/// The sequential TaskEnvelope worker.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkerConfig {
    pub enabled: bool,
    /// Designer/Coder loop budget, clamped to 1–15 (`envelope::MAX_LOOP_ITERATIONS` is the hard cap).
    #[serde(deserialize_with = "de_clamped::<_, 1, 15>")]
    pub max_iterations: u8,
    /// Per-handoff verifier (off: its verdict was advisory only).
    pub verify: bool,
    /// Honour `scheduler.offloadPct` for the code stage (CLI engines only; never under the
    /// kill switch or compute = Local).
    pub offload_code: bool,
    /// Librarian truth audit after the deterministic gate.
    pub librarian_audit: bool,
}
impl Default for WorkerConfig {
    fn default() -> Self {
        // Section pass: Prompter → Designer → Coder, max two revision rounds, no Librarian audit.
        Self { enabled: true, max_iterations: 2, verify: false, offload_code: true, librarian_audit: false }
    }
}

/// Hard mic sovereignty + the deterministic activation gate (Phase 2 Part B). `micEnabled`
/// seeds `voice::MIC_ENABLED` at startup, so a mic locked off stays locked off after a relaunch.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceConfig {
    pub mic_enabled: bool,
    /// Absolute speech gate in dBFS (the slider and the meter share this scale). Clamped -70..-10.
    #[serde(deserialize_with = "de_activation_db")]
    pub activation_db: f32,
    /// Extra dB a barge-in over Tony needs (speakers; a headset gets 2 dB less). Clamped 0..20.
    #[serde(deserialize_with = "de_barge_margin_db")]
    pub barge_margin_db: f32,
    /// True once the webview has written `activation_db` (a slider move or the first startup
    /// sync). An os.json from before Part B gets the serde default -44 dB with this false, so the
    /// desktop pushes its v7-migrated local gate up instead of adopting that default.
    pub activation_db_set: bool,
}
impl Default for VoiceConfig {
    fn default() -> Self {
        Self { mic_enabled: true, activation_db: -44.0, barge_margin_db: 6.0, activation_db_set: false }
    }
}
pub const ACTIVATION_DB_RANGE: (f32, f32) = (-70.0, -10.0);
pub const BARGE_MARGIN_DB_RANGE: (f32, f32) = (0.0, 20.0);

fn de_clamped_f32<'de, D: serde::Deserializer<'de>>(d: D, (lo, hi): (f32, f32)) -> Result<f32, D::Error> {
    let v = f64::deserialize(d)?;
    Ok(if v.is_finite() { (v as f32).clamp(lo, hi) } else { lo })
}
fn de_activation_db<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    de_clamped_f32(d, ACTIVATION_DB_RANGE)
}
fn de_barge_margin_db<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    de_clamped_f32(d, BARGE_MARGIN_DB_RANGE)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OsConfig {
    pub os_name: String,
    pub wake_words: Vec<String>,
    pub identity_path: String,
    pub root_directive: bool,
    pub compute: ComputeConfig,
    pub droplet: DropletConfig,
    pub anythingllm: AnythingLlmConfig,
    pub skills: SkillsConfig,
    pub mcps: Vec<McpServer>,
    pub routing: RoutingConfig,
    pub fs_roots: Vec<String>,
    pub permissions: OsPermissions,
    pub privacy: PrivacyConfig,
    pub overseer: OverseerConfig,
    pub memory: MemoryConfig,
    pub scheduler: super::scheduler::SchedulerConfig,
    pub feedback: FeedbackConfig,
    pub worker: WorkerConfig,
    pub voice: VoiceConfig,
    /// The whiteboard roster's scripts (Booking scan, Security / Garbage / Observer cadence,
    /// Finance vault re-seal): see `arbiter::RosterConfig`.
    pub roster: super::arbiter::RosterConfig,
    /// The HITL review queue: digest hour / threshold and the optional webhook switch (its URL
    /// lives in the OS keychain, `review_queue::WEBHOOK_SERVICE`).
    pub review: ReviewConfig,
    /// Gmail: where Nic's editable booking-mail instruction lives (`gmail::booking_spec`).
    pub gmail: GmailConfig,
    /// One-time config migrations already applied (`apply_migrations`), so a setting the user
    /// changes afterwards is never flipped back.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub migrations: Vec<String>,
    /// The master switchboard: agents / tools frozen in every mode (`modes::agent_live`). Missing
    /// on disk = a config saved before it (version 0: the tool-owner migration runs once).
    #[serde(default = "SwitchboardConfig::legacy")]
    pub switchboard: SwitchboardConfig,
    /// Tony's tools by mode (section pass): the servers each mode ADDS to his always-on base
    /// (his own grants in `mcps[].agents`, live in every mode unless frozen on the master
    /// switchboard). Keyed by mode id; a mode not listed adds nothing. Edited as pills in
    /// Settings → Master switchboard, like every other agent's.
    #[serde(default = "default_tony_mode_tools")]
    pub tony_mode_tools: BTreeMap<String, Vec<String>>,
}

/// Tony's per-mode extras: Builder adds Git and the filesystem, Operations the business tools,
/// Executive web page reads. Learning and the conversational modes add nothing (his base stays on).
pub fn default_tony_mode_tools() -> BTreeMap<String, Vec<String>> {
    let m: [(&str, &[&str]); 3] = [("builder", &["git", "filesystem"]), ("operations", &["maps", "instagram", "fetch"]), ("executive", &["fetch"])];
    m.into_iter().map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect())).collect()
}

/// The servers mode `mode_id` adds to Tony's base. Pure.
pub fn tony_mode_extras<'a>(cfg: &'a OsConfig, mode_id: &str) -> &'a [String] {
    cfg.tony_mode_tools.get(mode_id).map(Vec::as_slice).unwrap_or(&[])
}

impl Default for OsConfig {
    fn default() -> Self {
        Self {
            os_name: "Tony".into(),
            wake_words: vec!["hey tony".into(), "yo tony".into(), "tony".into()],
            identity_path: r"G:\ai-hub\master\MASTER_IDENTITY.md".into(),
            root_directive: true,
            compute: ComputeConfig::default(),
            droplet: DropletConfig::default(),
            anythingllm: AnythingLlmConfig::default(),
            skills: SkillsConfig::default(),
            mcps: default_mcps(),
            routing: RoutingConfig::default(),
            fs_roots: vec![r"G:\ai-hub".into()],
            permissions: OsPermissions::default(),
            privacy: PrivacyConfig::default(),
            overseer: OverseerConfig::default(),
            memory: MemoryConfig::default(),
            scheduler: super::scheduler::SchedulerConfig::default(),
            feedback: FeedbackConfig::default(),
            worker: WorkerConfig::default(),
            voice: VoiceConfig::default(),
            roster: super::arbiter::RosterConfig::default(),
            review: ReviewConfig::default(),
            gmail: GmailConfig::default(),
            migrations: vec![],
            switchboard: SwitchboardConfig::default(),
            tony_mode_tools: default_tony_mode_tools(),
        }
    }
}

/// Gmail settings (`gmail.rs`). The Apps Script credentials live in the keychain / `.env`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GmailConfig {
    /// The booking-mail check's instruction file (line 1 `query: …`, line 2 `read: N`, then Nic's
    /// rules), re-read on every scan; missing = the built-in default query.
    pub booking_instructions_path: String,
    /// Settings → Comms: which inbox every Gmail read / search covers. "primary" (the default:
    /// `category:primary in:inbox`, no Promotions / Social / Updates / Forums unless Nic names one)
    /// or "all". Any other value reads as "primary" (`gmail::scoped_query`).
    pub inbox_scope: String,
}
impl Default for GmailConfig {
    fn default() -> Self {
        Self { booking_instructions_path: super::gmail::BOOKING_INSTRUCTIONS_DEFAULT_PATH.into(), inbox_scope: super::gmail::SCOPE_PRIMARY.into() }
    }
}

/// The review queue's digest (`review_queue.rs`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewConfig {
    /// Local hour (0–23) of the daily digest when items are waiting.
    pub digest_hour: u32,
    /// Pending items that trigger a digest before the daily one.
    pub threshold: u32,
    /// Also push the counts-only digest to the configured webhook.
    pub webhook_enabled: bool,
}
impl Default for ReviewConfig {
    fn default() -> Self {
        Self { digest_hour: 18, threshold: 10, webhook_enabled: false }
    }
}

/// Migration id: WhatsApp became read-only by default.
const MIGRATE_WHATSAPP_READ_ONLY: &str = "whatsapp-read-only";
/// Section pass: the frozen Booking Desk loses every tool pill and skill, and its "messages" /
/// "texts" routing phrases (Tony reads Gmail and WhatsApp himself).
const MIGRATE_BOOKING_NO_TOOLS: &str = "booking-no-tools";
/// Section pass: the build chain drops the Librarian (no audit stage) and gets two revision
/// rounds; a saved 3 (the old default) becomes 2, any other choice is kept.
const MIGRATE_BUILD_CHAIN: &str = "build-chain-no-librarian";
/// Migration id: Tony's own name left `routing.agents.general.names` (kind Self handles it).
const MIGRATE_SELF_ROUTING: &str = "self-routing";
/// Migration id: "Auto-run monthly" became "Auto-regulate Vault & Lifecycle" + a cadence.
pub(crate) const MIGRATE_VAULT_CADENCE: &str = "vault-cadence";
/// Migration id: business / finance triggers got their own `bizops` and `finance` rows.
pub(crate) const MIGRATE_BIZOPS_SPLIT: &str = "bizops-split";
/// Migration id: local-only compute, cloud routing on Ask, no Overseer auto-escalation.
pub(crate) const MIGRATE_LOCAL_SAFE_DEFAULTS: &str = "local-safe-defaults";
/// Migration id: Booking lost every trigger; contracting → Tony, money → finance, the store →
/// bizops, calendar / acting → Tony (Sections 20.1 / 20.2, `resplit_routing`).
pub(crate) const MIGRATE_ROUTING_RESPLIT: &str = "routing-resplit";
/// Migration id: one owner per integration (Section 21.1, `apply_integration_owners`).
pub(crate) const MIGRATE_INTEGRATION_OWNERS: &str = "integration-owners";
/// Migration id: the Booking Desk's own names came back (`BOOKING_NAMES`, none of its topics), so
/// addressing the frozen desk is Named and held with Tony's FROZEN note (`restore_booking_names`).
pub(crate) const MIGRATE_BOOKING_NAMES: &str = "booking-names";
/// Migration id: Tony's read-only Finance tool (Section 11.10): the `finance` server is granted to
/// Tony only, once (`grant_finance_read`).
pub(crate) const MIGRATE_FINANCE_READ: &str = "finance-read";
/// Migration id: the contracting phrases became Tony's topics (`contracting_to_tony`), for a config
/// that already ran an earlier `routing-resplit` which put them on another row. (The id is the one
/// saved configs already record.)
pub(crate) const MIGRATE_CONTRACTING_TO_TONY: &str = "ops-phrases-to-tony";
/// Migration id: the infrastructure agent (role id `REMOVED_OPS_ROLE`) was removed (2026-11); its
/// topics and tools are Tony's (`remove_ops_agent`).
pub(crate) const MIGRATE_OPS_REMOVED: &str = "ops-removed";
/// The removed infrastructure agent's role id. Only its removal names it.
pub(crate) const REMOVED_OPS_ROLE: &str = "ops";
/// Backup suffix of the removal: `os.json.bak-<YYYYMMDD-HHMMSS>-ops-removed`.
pub(crate) const OPS_REMOVED_TAG: &str = "ops-removed";

/// One-time upgrades of a saved config. `read_only: false` is never written to disk, so an
/// older os.json can't say whether WhatsApp was left writable on purpose: mark it read-only
/// once, record that, and leave any later untick alone.
pub(crate) fn apply_migrations(cfg: &mut OsConfig) {
    if !cfg.migrations.iter().any(|m| m == MIGRATE_WHATSAPP_READ_ONLY) {
        for m in cfg.mcps.iter_mut().filter(|m| m.id == "whatsapp") {
            m.read_only = true;
        }
        cfg.migrations.push(MIGRATE_WHATSAPP_READ_ONLY.into());
    }
    // "tony" in general.names made "thanks tony" a Named route to Tony himself (the
    // "TONY → TONY" relay). Self-address is `routing::SELF_NAMES` now; drop it once.
    if !cfg.migrations.iter().any(|m| m == MIGRATE_SELF_ROUTING) {
        if let Some(g) = cfg.routing.agents.get_mut("general") {
            g.names.retain(|n| super::routing::normalize(n) != "tony");
        }
        cfg.migrations.push(MIGRATE_SELF_ROUTING.into());
    }
    // `autoMonthly: true` → `{ autoRunEnabled: true, cadence: "monthly" }` (the month already
    // harvested stays recorded, so the first slot after the upgrade doesn't repeat it).
    if !cfg.migrations.iter().any(|m| m == MIGRATE_VAULT_CADENCE) {
        if cfg.memory.auto_monthly {
            cfg.memory.auto_run_enabled = true;
            cfg.memory.cadence = "monthly".into();
            if cfg.memory.last_verified_harvest_at == 0 {
                cfg.memory.last_verified_harvest_at = super::hygiene::month_end_secs(&cfg.memory.last_auto_month).unwrap_or(0);
            }
        }
        cfg.memory.auto_monthly = false;
        cfg.migrations.push(MIGRATE_VAULT_CADENCE.into());
    }
    // Business paperwork and money got their own rows: back-fill them once. (The removed
    // infrastructure agent's row, which used to carry those phrases, goes whole in
    // `remove_ops_agent`.)
    if !cfg.migrations.iter().any(|m| m == MIGRATE_BIZOPS_SPLIT) {
        for (role, t) in default_routing_agents().into_iter().filter(|(r, _)| r == "bizops" || r == "finance") {
            cfg.routing.agents.entry(role).or_insert(t);
        }
        cfg.migrations.push(MIGRATE_BIZOPS_SPLIT.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_BOOKING_NO_TOOLS) {
        strip_booking_tools(cfg);
        cfg.migrations.push(MIGRATE_BOOKING_NO_TOOLS.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_BUILD_CHAIN) {
        cfg.worker.librarian_audit = false;
        if cfg.worker.max_iterations == 3 {
            cfg.worker.max_iterations = 2;
        }
        cfg.migrations.push(MIGRATE_BUILD_CHAIN.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_LOCAL_SAFE_DEFAULTS) {
        apply_local_safe_defaults(cfg);
        cfg.migrations.push(MIGRATE_LOCAL_SAFE_DEFAULTS.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_ROUTING_RESPLIT) {
        resplit_routing(cfg);
        cfg.migrations.push(MIGRATE_ROUTING_RESPLIT.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_INTEGRATION_OWNERS) {
        apply_integration_owners(cfg);
        cfg.migrations.push(MIGRATE_INTEGRATION_OWNERS.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_BOOKING_NAMES) {
        restore_booking_names(cfg);
        cfg.migrations.push(MIGRATE_BOOKING_NAMES.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_CONTRACTING_TO_TONY) {
        contracting_to_tony(cfg);
        cfg.migrations.push(MIGRATE_CONTRACTING_TO_TONY.into());
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_FINANCE_READ) {
        grant_finance_read(cfg);
        cfg.migrations.push(MIGRATE_FINANCE_READ.into());
    }
    // A config that never had the removed infrastructure agent has nothing to undo: record it, so
    // a role Nic adds under that id later is left alone. One that has it is migrated with a backup
    // first (`migrate_saved_ops_removal`, from `load_or_init`).
    if !cfg.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED) && !carries_removed_ops(cfg) {
        cfg.migrations.push(MIGRATE_OPS_REMOVED.into());
    }
}

/// Once (Section 11.10): the `finance` server (back-filled from `default_mcps` on load) is granted
/// to Tony only, so a row saved under that id earlier (or with "all") never hands the books to
/// another agent. `enabled` is left as saved. Afterwards Nic's own grant edits stand.
pub(crate) fn grant_finance_read(cfg: &mut OsConfig) {
    for m in cfg.mcps.iter_mut().filter(|m| m.id == "finance") {
        m.agents = Some(vec!["general".into()]);
    }
}

/// Once: the contracting phrases (`CONTRACTING_TO_TONY`) become Tony's topics (deduped,
/// case-insensitive). The row that held them before (the removed infrastructure agent's) goes in
/// `remove_ops_agent`.
pub(crate) fn contracting_to_tony(cfg: &mut OsConfig) {
    let norm = super::routing::normalize;
    let g = cfg.routing.agents.entry("general".to_string()).or_default();
    for p in CONTRACTING_TO_TONY {
        if !g.domains.iter().any(|x| norm(x) == norm(p)) {
            g.domains.push(p.to_string());
        }
    }
}

fn is_removed_ops(id: &str) -> bool {
    id.trim().eq_ignore_ascii_case(REMOVED_OPS_ROLE)
}

/// Does `cfg` still carry the removed infrastructure agent: its route, its AnythingLLM link, an
/// MCP or skill grant, or a master-switchboard freeze? Pure.
pub(crate) fn carries_removed_ops(cfg: &OsConfig) -> bool {
    cfg.routing.agents.keys().any(|k| is_removed_ops(k))
        || cfg.anythingllm.workspaces.keys().any(|k| is_removed_ops(k))
        || cfg.mcps.iter().any(|m| m.agents.iter().flatten().any(|a| is_removed_ops(a)))
        || cfg.skills.grants.values().flatten().any(|a| is_removed_ops(a))
        || cfg.switchboard.frozen_agents.iter().any(|a| is_removed_ops(a))
}

/// One-time: the removed infrastructure agent leaves a saved config. Its topics (droplet, Docker,
/// n8n, any of Nic's own) become Tony's (deduped, case-insensitive) and its row and AnythingLLM
/// link go (the workspace itself stays in AnythingLLM, untouched); every MCP grant it held passes
/// to Tony (Maps; never an empty list, which means everyone); its skill grants and its
/// master-switchboard freeze go. Nothing else changes. Pure.
pub(crate) fn remove_ops_agent(cfg: &mut OsConfig) {
    let norm = super::routing::normalize;
    let topics: Vec<String> = cfg.routing.agents.iter().filter(|(k, _)| is_removed_ops(k)).flat_map(|(_, t)| t.domains.clone()).collect();
    cfg.routing.agents.retain(|k, _| !is_removed_ops(k));
    if !topics.is_empty() {
        let g = cfg.routing.agents.entry("general".to_string()).or_default();
        for p in topics {
            if !norm(&p).is_empty() && !g.domains.iter().any(|x| norm(x) == norm(&p)) {
                g.domains.push(p);
            }
        }
    }
    cfg.anythingllm.workspaces.retain(|k, _| !is_removed_ops(k));
    for agents in cfg.mcps.iter_mut().filter_map(|m| m.agents.as_mut()) {
        if agents.iter().any(|a| is_removed_ops(a)) {
            agents.retain(|a| !is_removed_ops(a));
            if !agent_matches(agents, "general") {
                agents.push("general".into());
            }
        }
    }
    for agents in cfg.skills.grants.values_mut() {
        agents.retain(|a| !is_removed_ops(a));
    }
    cfg.skills.grants.retain(|_, a| !a.is_empty());
    cfg.switchboard.frozen_agents.retain(|a| !is_removed_ops(a));
    if !cfg.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED) {
        cfg.migrations.push(MIGRATE_OPS_REMOVED.into());
    }
}

/// The removal for a config read from `path` (`text` = the file as saved): backup first; no
/// backup, no migration (it isn't recorded, so the next launch tries again).
pub(crate) fn migrate_saved_ops_removal(cfg: &mut OsConfig, path: &Path, text: &str) -> Option<PathBuf> {
    if cfg.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED) || !carries_removed_ops(cfg) {
        return None;
    }
    match backup_os_json(path, text, OPS_REMOVED_TAG) {
        Ok(b) => {
            remove_ops_agent(cfg);
            eprintln!("[os] removed the infrastructure agent (its topics and Maps are Tony's); previous os.json saved as {}", b.display());
            Some(b)
        }
        Err(e) => {
            eprintln!("[os] infrastructure-agent removal skipped, backup failed ({e}); it runs on the next launch");
            None
        }
    }
}

/// Once: put the Booking Desk's own names (`BOOKING_NAMES`) back on its row (deduped,
/// case-insensitive). Its topics are never restored.
pub(crate) fn restore_booking_names(cfg: &mut OsConfig) {
    let t = cfg.routing.agents.entry("booking".to_string()).or_default();
    for n in BOOKING_NAMES {
        if !t.names.iter().any(|x| super::routing::normalize(x) == super::routing::normalize(n)) {
            t.names.push(n.to_string());
        }
    }
}

/// Section 20.6/20.7 + 21.5: nothing leaves the machine on its own. Cloud / droplet routing
/// Allow → Ask (an unpinned remote backend is then never used, so Hybrid can't overflow to the
/// droplet's Qwen3 0.6B; Tony's turns never overflow anyway, `shape_tony_turn`); the Overseer
/// never auto-escalates a conversation to Claude. The compute mode is left alone: Local only
/// would also block the on-demand Claude CLI (help desk, verifier, Coder offload). Deny stays. Once.
pub(crate) fn apply_local_safe_defaults(cfg: &mut OsConfig) {
    // Cloud mode is a deliberate remote-first choice: Ask would strip every remote provider from it.
    if cfg.permissions.cloud == Tier::Allow && cfg.compute.mode != ComputeMode::Cloud {
        cfg.permissions.cloud = Tier::Ask;
    }
    cfg.overseer.auto_escalate = false;
    // Narration lines on local Kokoro (Section 20.4).
    cfg.feedback.narration_engine = "kokoro".into();
}

/// The Booking Desk gets no tools: off every server's grant list and every skill grant, and its
/// messages / texts phrases leave its routing row. A list naming ONLY Booking becomes `["none"]`
/// (an empty list would mean everyone); `"all"` stays `"all"`, and `servers_for` gives a frozen
/// agent nothing anyway.
pub(crate) fn strip_booking_tools(cfg: &mut OsConfig) {
    let booking = |a: &String| a.trim().eq_ignore_ascii_case("booking");
    for m in cfg.mcps.iter_mut() {
        if let Some(v) = m.agents.as_mut() {
            if v.iter().any(booking) {
                v.retain(|a| !booking(a));
                if v.is_empty() {
                    v.push("none".into());
                }
            }
        }
    }
    for agents in cfg.skills.grants.values_mut() {
        agents.retain(|a| !booking(a));
    }
    cfg.skills.grants.retain(|_, a| !a.is_empty());
    if let Some(b) = cfg.routing.agents.get_mut("booking") {
        b.domains.retain(|d| {
            let n = super::routing::normalize(d);
            !(n.contains("message") || n.contains("text"))
        });
    }
}

/// Backup suffix of the tool-owner migration: `os.json.bak-<YYYYMMDD-HHMMSS>-tool-owners`.
pub(crate) const TOOL_OWNERS_TAG: &str = "tool-owners";

/// A saved os.json from before the master switchboard (`switchboard.version` missing or < 1).
/// Read from the raw text, so a lenient parse that fell back to the defaults can't hide it.
pub(crate) fn needs_tool_owner_migration(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v["switchboard"]["version"].as_u64()).unwrap_or(0) < u64::from(SWITCHBOARD_VERSION)
}

/// One-time (switchboard v1): every known server's grants become the tool-owner split
/// (`default_mcp_grants`), the skill grants become the Designer's two design skills and the
/// Director's motion vocabulary (Tony none; other agents' skills are kept), Booking and the
/// Librarian (`DEFAULT_FROZEN_AGENTS`) are frozen on the master switchboard and the version is
/// set, so it never runs twice. `enabled` is never touched: a server Nic switched off stays off.
/// `has_skill`: the skill exists in the library.
pub(crate) fn migrate_tool_owners(cfg: &mut OsConfig, has_skill: impl Fn(&str) -> bool) {
    for m in cfg.mcps.iter_mut().filter(|m| TOOL_OWNER_SERVERS.contains(&m.id.as_str())) {
        m.agents = Some(default_mcp_grants(&m.id));
    }
    for (name, agents) in cfg.skills.grants.iter_mut() {
        agents.retain(|a| match canon_agent(a) {
            "general" => false,
            "designer" => DESIGNER_SKILLS.contains(&name.as_str()),
            "director" => DIRECTOR_SKILLS.contains(&name.as_str()),
            _ => true,
        });
    }
    cfg.skills.grants.retain(|_, a| !a.is_empty());
    for (agent, names) in [("designer", &DESIGNER_SKILLS[..]), ("director", &DIRECTOR_SKILLS[..])] {
        for name in names.iter().filter(|n| has_skill(n)) {
            let e = cfg.skills.grants.entry(name.to_string()).or_default();
            if !e.iter().any(|x| x == agent) {
                e.push(agent.into());
            }
        }
    }
    let sb = &mut cfg.switchboard;
    for a in DEFAULT_FROZEN_AGENTS {
        if !sb.frozen_agents.iter().any(|f| f == a) {
            sb.frozen_agents.push(a.into());
        }
    }
    sb.version = SWITCHBOARD_VERSION;
}

/// Designer / Director start with their skills while they have none attached (skills that exist).
fn seed_skill_grants(cfg: &mut OsConfig, has_skill: impl Fn(&str) -> bool) {
    for (agent, names) in [("designer", &DESIGNER_SKILLS[..]), ("director", &DIRECTOR_SKILLS[..])] {
        if cfg.skills.grants.values().any(|a| a.iter().any(|x| x == agent)) {
            continue;
        }
        for name in names.iter().filter(|n| has_skill(n)) {
            cfg.skills.grants.entry(name.to_string()).or_default().push(agent.into());
        }
    }
}

/// Copy the saved os.json aside before a migration rewrites it (never overwrites a backup).
fn backup_os_json(path: &Path, text: &str, tag: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = path.with_file_name(format!("os.json.bak-{stamp}-{tag}"));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&backup).map_err(|e| format!("{}: {e}", backup.display()))?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(backup)
}

/// The tool-owner migration for a config read from `path` (`text` = the file as saved): backup
/// first; no backup, no migration (version stays 0, so the next launch tries again).
pub(crate) fn migrate_saved_tool_owners(cfg: &mut OsConfig, path: &Path, text: &str) -> Option<PathBuf> {
    if !needs_tool_owner_migration(text) {
        return None;
    }
    match backup_os_json(path, text, TOOL_OWNERS_TAG) {
        Ok(b) => {
            let dir = PathBuf::from(&cfg.skills.dir);
            migrate_tool_owners(cfg, |n| dir.join(n).join("SKILL.md").exists());
            eprintln!("[os] tool owners migrated (switchboard v{SWITCHBOARD_VERSION}); previous os.json saved as {}", b.display());
            Some(b)
        }
        Err(e) => {
            eprintln!("[os] tool-owner migration skipped, backup failed ({e}); it runs on the next launch");
            None
        }
    }
}

// ── State ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRecord {
    pub at: u64,
    pub destination: String,
    pub payload: serde_json::Value,
    pub replacements: Vec<Replacement>,
}

/// Parse os.json without ever silently resetting it. A single bad or out-of-date field used to
/// make the whole parse fail, fall back to `OsConfig::default()` and save that over the file: the
/// droplet went "OFFLINE (manual)" with its host reset to the placeholder, and every other
/// setting reset too. Now each top-level section is kept if it parses and only a broken section
/// falls back to its default; the original file is copied aside first so nothing is lost.
pub fn parse_os_config_lenient(text: &str, path: &Path) -> OsConfig {
    let err = match serde_json::from_str::<OsConfig>(text) {
        Ok(c) => return c,
        Err(e) => e,
    };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let backup = path.with_file_name(format!("os.json.invalid-{stamp}"));
    let _ = std::fs::write(&backup, text);
    let (cfg, dropped) = recover_os_config(text);
    eprintln!("[os] os.json didn't parse ({err}); kept the readable sections, reset {dropped:?}; original saved as {}", backup.display());
    cfg
}

/// Section-by-section recovery: start from the defaults and take each top-level key from `text`
/// whenever the config still parses with it. Returns the config and the keys that were reset.
pub fn recover_os_config(text: &str) -> (OsConfig, Vec<String>) {
    let Ok(serde_json::Value::Object(file)) = serde_json::from_str::<serde_json::Value>(text) else {
        return (OsConfig::default(), vec!["(whole file: not JSON)".into()]);
    };
    let mut merged = serde_json::to_value(OsConfig::default()).unwrap_or_else(|_| serde_json::json!({}));
    let mut dropped = Vec::new();
    for (k, v) in file {
        let Some(obj) = merged.as_object_mut() else { break };
        let prev = obj.insert(k.clone(), v);
        if serde_json::from_value::<OsConfig>(merged.clone()).is_err() {
            let obj = merged.as_object_mut().expect("object");
            match prev {
                Some(p) => obj.insert(k.clone(), p),
                None => obj.remove(&k),
            };
            dropped.push(k);
        }
    }
    (serde_json::from_value(merged).unwrap_or_default(), dropped)
}

#[derive(Default)]
pub struct OsState {
    config: RwLock<OsConfig>,
    path: RwLock<Option<PathBuf>>,
    mirror: RwLock<Option<PathBuf>>,
    pub(crate) last_redaction: Mutex<Option<RedactionRecord>>,
    /// Last good MCP listing per server id: (unix secs, server fingerprint, tools). The
    /// fingerprint (`mcp::server_fingerprint`) covers the command line, env, URL and
    /// token, so editing / reinstalling a server never serves its old listing.
    pub(crate) mcp_tools: Mutex<BTreeMap<String, (u64, u64, Vec<super::mcp::ToolInfo>)>>,
    /// AnythingLLM workspace slug → this month's Tony thread slug.
    pub(crate) allm_threads: Mutex<BTreeMap<String, String>>,
    /// The local-GPU baton (Tony-first scheduler).
    pub(crate) slot: super::scheduler::GpuSlot,
    /// Live, non-persisted status merged into the phone mirror (droplet link…).
    pub(crate) runtime: Mutex<serde_json::Map<String, serde_json::Value>>,
    /// Tony's modes (Phase 2 Part C): `modes.json` beside os.json + in-memory overrides.
    pub(crate) modes: super::modes::ModeStore,
    /// Learning mode's pending core-memory proposals and the spoken-answer marker (decision 5):
    /// one store per app, so desktop, phone and voice answer the same ones.
    pub(crate) proposals: super::learning::Proposals,
}

impl OsState {
    pub fn load_or_init(&self, dir: &Path, repo: &Path) {
        let path = dir.join("os.json");
        *self.path.write().unwrap() = Some(path.clone());
        *self.mirror.write().unwrap() = Some(repo.join("data").join("command-center").join("os-state.json"));
        let saved = std::fs::read_to_string(&path).ok();
        let mut cfg = match saved.as_deref() {
            Some(s) => parse_os_config_lenient(s, &path),
            None => OsConfig::default(),
        };
        // Self-alias keys ("tony", "dispatcher"…) fold into general before any back-fill.
        canonicalize_self_keys(&mut cfg);
        // Upgrades: add new built-in MCPs without touching the user's toggles.
        for d in default_mcps() {
            if !cfg.mcps.iter().any(|m| m.id == d.id) {
                cfg.mcps.push(d);
            }
        }
        // …and new role → workspace mappings (Phase 2: designer; then director).
        for (role, slug) in AnythingLlmConfig::default().workspaces {
            cfg.anythingllm.workspaces.entry(role).or_insert(slug);
        }
        // Routing matrix (Part 1): add any role missing from an older config
        // without touching triggers the user already edited.
        for (role, triggers) in default_routing_agents() {
            cfg.routing.agents.entry(role).or_insert(triggers);
        }
        // Per-agent MCP grants (Part 2): back-fill ids saved before this field
        // existed (agents == None on disk) from the same by-id defaults used
        // for fresh installs. A server the user has already edited keeps
        // whatever list they set, "all" included.
        for m in cfg.mcps.iter_mut() {
            if m.agents.is_none() {
                m.agents = Some(default_mcp_grants(&m.id));
            }
        }
        apply_migrations(&mut cfg);
        // Switchboard v1, once: the tool-owner split (a timestamped backup of os.json first).
        if let Some(text) = saved.as_deref() {
            migrate_saved_tool_owners(&mut cfg, &path, text);
            // The removed infrastructure agent leaves the saved config, once (a backup first).
            migrate_saved_ops_removal(&mut cfg, &path, text);
        }
        // Designer / Director start with their skills attached (impeccable + design-taste-frontend;
        // animation-vocabulary).
        let skills_dir = std::path::PathBuf::from(&cfg.skills.dir);
        seed_skill_grants(&mut cfg, |n| skills_dir.join(n).join("SKILL.md").exists());
        self.slot.set_capacity(cfg.scheduler.max_concurrency as usize);
        // A mic locked off last session stays locked off (Phase 2 Part B, D2).
        super::voice::MIC_ENABLED.store(cfg.voice.mic_enabled, std::sync::atomic::Ordering::SeqCst);
        let feedback = cfg.feedback.sensitivity;
        *self.config.write().unwrap() = cfg;
        // Seeding never rewrites `feedback.sensitivity` (D11): narration keeps Nic's setting
        // until he first switches mode. A saved level that differs from the mode's own is shown
        // as an override (so the mode panel tells the truth), cleared by the next switch / reset.
        self.modes.load_or_init(dir);
        self.modes.note_feedback(feedback);
        let _ = self.persist();
    }

    pub fn snapshot(&self) -> OsConfig {
        self.config.read().unwrap().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut OsConfig) -> Result<(), String>) -> Result<OsConfig, String> {
        let mut next = self.snapshot();
        f(&mut next)?;
        canonicalize_self_keys(&mut next);
        validate(&next)?;
        self.slot.set_capacity(next.scheduler.max_concurrency as usize);
        *self.config.write().unwrap() = next.clone();
        self.persist()?;
        Ok(next)
    }

    pub(crate) fn persist(&self) -> Result<(), String> {
        let cfg = self.snapshot();
        if let Some(p) = self.path.read().unwrap().clone() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            // Atomic, like providers.json: never leave a truncated os.json behind.
            super::staging::atomic_write(&p, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?.as_bytes())?;
        }
        if let Some(m) = self.mirror.read().unwrap().clone() {
            if let Some(d) = m.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(m, self.mirror_value(&cfg).to_string());
        }
        Ok(())
    }

    /// The phone mirror with Tony's current mode (Phase 2 Part C).
    pub(crate) fn mirror_value(&self, cfg: &OsConfig) -> serde_json::Value {
        let mut m = mirror_json(cfg, self.runtime.lock().unwrap().clone());
        m["mode"] = self.modes.mirror(&cfg.switchboard);
        m
    }

    /// Re-write the phone mirror (a mode override changed; os.json itself didn't).
    pub(crate) fn refresh_mirror(&self) {
        let _ = self.persist();
    }

    /// Update a live status field (e.g. droplet link) and refresh the phone mirror.
    pub fn set_runtime(&self, key: &str, value: serde_json::Value) {
        let changed = self.runtime.lock().unwrap().insert(key.into(), value.clone()) != Some(value);
        if changed {
            let _ = self.persist();
        }
    }

    pub fn record_redaction(&self, destination: &str, payload: serde_json::Value, replacements: Vec<Replacement>) {
        *self.last_redaction.lock().unwrap() = Some(RedactionRecord { at: now_secs(), destination: destination.into(), payload, replacements });
    }
}

/// The phone mirror (`os-state.json`, served as `/api/os/state`): non-secret settings only.
pub(crate) fn mirror_json(cfg: &OsConfig, runtime: serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "osName": cfg.os_name,
        "wakeWords": cfg.wake_words,
        "computeMode": cfg.compute.mode,
        "droplet": { "enabled": cfg.droplet.enabled, "host": cfg.droplet.host },
        "privacy": { "diffuser": cfg.privacy.diffuser, "networkLock": cfg.privacy.network_lock, "killSwitch": cfg.privacy.kill_switch, "destructiveGate": cfg.privacy.destructive_gate },
        "memory": { "storage": cfg.memory.storage, "autoRun": cfg.memory.auto_run_enabled, "cadence": cfg.memory.cadence, "autoFlush": cfg.memory.auto_flush },
        "scheduler": { "profile": cfg.scheduler.profile, "tonyPriorityPct": cfg.scheduler.tony_priority_pct, "offloadPct": cfg.scheduler.offload_pct, "maxConcurrency": cfg.scheduler.max_concurrency },
        // Phase 2 Part B: the phone locks its own mic when the desktop's is locked off.
        "voice": { "micEnabled": cfg.voice.mic_enabled, "activationDb": cfg.voice.activation_db },
        "runtime": serde_json::Value::Object(runtime),
        "updatedAt": now_secs(),
    })
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn validate(c: &OsConfig) -> Result<(), String> {
    let name = c.os_name.trim();
    if name.is_empty() || name.len() > 32 || !name.chars().all(|ch| ch.is_alphanumeric() || ch == ' ' || ch == '-' || ch == '_') {
        return Err("OS name: 1–32 letters, digits, spaces or dashes".into());
    }
    for u in [&c.droplet.qdrant_url, &c.droplet.n8n_url, &c.droplet.model_url, &c.droplet.anythingllm_url, &c.anythingllm.base_url] {
        if !u.is_empty() && !super::dispatch::valid_url(u) {
            return Err(format!("invalid URL: {u}"));
        }
    }
    if !(10.0..=100.0).contains(&c.compute.vram_threshold_pct) {
        return Err("VRAM threshold must be 10–100 %".into());
    }
    let sc = &c.scheduler;
    if !["sequential", "hybrid", "parallel"].contains(&sc.profile.as_str()) || !(50..=100).contains(&sc.tony_priority_pct) || !(1..=8).contains(&sc.max_concurrency) || sc.offload_pct > 100 || !(2..=20).contains(&sc.history_turns) {
        return Err("scheduler: profile sequential|hybrid|parallel, Tony priority 50–100 %, 1–8 slots, offload 0–100 %, 2–20 history turns".into());
    }
    if !["claude-cli", "gemini-cli", "llm-cli", "claude-api", "gemini-api", "droplet"].contains(&sc.offload_engine.as_str()) {
        return Err("unknown offload engine".into());
    }
    if !["local", "droplet", "hybrid"].contains(&c.memory.storage.as_str()) {
        return Err("memory storage must be local, droplet or hybrid".into());
    }
    if !["chatml", "alpaca", "sharegpt"].contains(&c.memory.dataset_format.as_str()) {
        return Err("dataset format must be chatml, alpaca or sharegpt".into());
    }
    if !["claude-cli", "claude-api", "gemini-cli", "gemini-api", "droplet", "local"].contains(&c.overseer.engine.as_str()) {
        return Err("unknown overseer engine".into());
    }
    if !["roster", "kokoro"].contains(&c.feedback.narration_engine.as_str()) {
        return Err("narration engine must be roster or kokoro".into());
    }
    let v = &c.voice;
    if !(ACTIVATION_DB_RANGE.0..=ACTIVATION_DB_RANGE.1).contains(&v.activation_db) || !(BARGE_MARGIN_DB_RANGE.0..=BARGE_MARGIN_DB_RANGE.1).contains(&v.barge_margin_db) {
        return Err("voice: activation threshold -70..-10 dB, barge margin 0..20 dB".into());
    }
    for (name, dir) in [("notes", &c.memory.notes_dir), ("staging", &c.memory.staging_dir)] {
        if !dir.trim().is_empty() && !std::path::Path::new(dir.trim()).is_absolute() {
            return Err(format!("memory {name} directory must be an absolute path (or empty for the default)"));
        }
    }
    for (role, slug) in &c.anythingllm.workspaces {
        if !super::dispatch::valid_id(role) || !(slug.is_empty() || slug.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')) {
            return Err(format!("invalid workspace mapping {role} → {slug}"));
        }
    }
    for (role, triggers) in &c.routing.agents {
        if !super::dispatch::valid_id(role) {
            return Err(format!("invalid routing role id: {role}"));
        }
        if triggers.names.len() > 200 || triggers.domains.len() > 200 {
            return Err(format!("routing.{role}: at most 200 triggers per list"));
        }
        if triggers.names.iter().any(|s| s.trim().is_empty()) || triggers.domains.iter().any(|s| s.trim().is_empty()) {
            return Err(format!("routing.{role}: triggers cannot be empty strings"));
        }
    }
    let sb = &c.switchboard;
    if sb.frozen_agents.len() > 32 || sb.frozen_tools.len() > 64 {
        return Err("switchboard: at most 32 frozen agents and 64 frozen tools".into());
    }
    for a in &sb.frozen_agents {
        if !super::dispatch::valid_id(a) || super::routing::is_self_role(a, &c.os_name) {
            return Err(format!("switchboard: \"{a}\" can't be frozen (an agent id, never {} himself)", c.os_name));
        }
    }
    if let Some(t) = sb.frozen_tools.iter().find(|t| !super::dispatch::valid_id(t) || super::modes::ALWAYS_LIVE_SERVERS.contains(&t.as_str())) {
        return Err(format!("switchboard: \"{t}\" can't be frozen (an MCP server id; time, skills and the mode switch always stay live)"));
    }
    let mut ids = std::collections::HashSet::new();
    for m in &c.mcps {
        if !super::dispatch::valid_id(&m.id) || !ids.insert(m.id.clone()) {
            return Err(format!("invalid or duplicate MCP id: {}", m.id));
        }
        match m.transport.as_str() {
            "builtin" => {}
            "stdio" if !m.command.trim().is_empty() => {}
            "http" if super::dispatch::valid_url(&m.url) => {}
            _ => return Err(format!("MCP {}: stdio needs a command, http needs a URL", m.name)),
        }
        if let Some(t) = m.timeout_secs {
            if !(5..=600).contains(&t) {
                return Err(format!("MCP {}: startup timeout must be 5–600 seconds", m.name));
            }
        }
        if let Some(dir) = &m.cwd {
            if dir.len() > 1024 || !std::path::Path::new(dir.trim()).is_absolute() {
                return Err(format!("MCP {}: working folder must be an absolute path", m.name));
            }
        }
        if let Some(agents) = &m.agents {
            if agents.len() > 20 {
                return Err(format!("MCP {}: at most 20 agent grants", m.name));
            }
            for a in agents {
                if a != "all" && !super::dispatch::valid_id(a) {
                    return Err(format!("MCP {}: invalid agent grant \"{a}\"", m.name));
                }
            }
        }
    }
    Ok(())
}

// ── Routing helpers used by dispatch.rs ─────────────────────────────────────

/// Host of a URL, lowercased.
pub fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase())).unwrap_or_default()
}

pub fn is_loopback_host(h: &str) -> bool {
    h == "localhost" || h == "::1" || h == "[::1]" || h.starts_with("127.") || h.ends_with(".localhost")
}

/// Leaves this machine (droplet over NetBird counts — it's someone else's disk).
pub fn is_remote(p: &Provider) -> bool {
    !is_loopback_host(&host_of(&p.base_url))
}

pub fn is_droplet(p: &Provider, os: &OsConfig) -> bool {
    p.id == "droplet" || (!os.droplet.host.is_empty() && host_of(&p.base_url) == os.droplet.host)
}

/// Apply compute mode, kill switch, droplet switch and the cloud permission to a
/// provider chain. Returns the reordered chain and a note for the UI.
pub fn shape_chain(os: &OsConfig, mut chain: Vec<Provider>, vram_pct: Option<f32>, chars: usize, pinned: bool) -> (Vec<Provider>, Vec<String>) {
    let mut notes = Vec::new();
    let before = chain.len();
    chain.retain(|p| !(is_droplet(p, os) && !os.droplet.enabled));
    if chain.len() < before {
        notes.push("droplet off (manual)".into());
    }
    let block_remote = if os.privacy.kill_switch {
        Some("kill switch on — local only")
    } else if os.compute.mode == ComputeMode::Local {
        Some("LOCAL ONLY mode")
    } else if os.permissions.cloud == Tier::Deny {
        Some("cloud routing denied")
    } else if os.permissions.cloud == Tier::Ask && !pinned {
        Some("cloud routing set to Ask — pin a remote backend to use it")
    } else {
        None
    };
    if let Some(why) = block_remote {
        let n = chain.len();
        chain.retain(|p| !is_remote(p));
        if chain.len() < n {
            notes.push(why.into());
        }
        return (chain, notes);
    }
    let remote_first = match os.compute.mode {
        ComputeMode::Cloud => {
            notes.push("CLOUD PRIORITY".into());
            true
        }
        ComputeMode::Hybrid => {
            if let Some(v) = vram_pct.filter(|v| *v >= os.compute.vram_threshold_pct) {
                notes.push(format!("VRAM {v:.0}% ≥ {:.0}% → offload", os.compute.vram_threshold_pct));
                true
            } else if chars >= os.compute.heavy_context_chars {
                notes.push(format!("heavy context ({chars} chars) → offload"));
                true
            } else {
                false
            }
        }
        ComputeMode::Local => false,
    };
    if remote_first {
        chain.sort_by_key(|p| !is_remote(p)); // stable: remote providers first
    }
    (chain, notes)
}

/// `shape_chain` for Tony's own chat turns (interactive / streamed answers): Hybrid never
/// auto-overflows them. Tony's model sits at ~86% VRAM on its own, so a 90% threshold sent real
/// turns to the droplet's tiny model (Section 20.6). Cloud mode, the kill switch, Ask/Deny and
/// the droplet switch still apply exactly as in `shape_chain`.
pub fn shape_tony_turn(os: &OsConfig, chain: Vec<Provider>) -> (Vec<Provider>, Vec<String>) {
    shape_chain(os, chain, None, 0, false)
}

/// Current VRAM %, if an NVIDIA GPU is visible.
pub async fn vram_pct() -> Option<f32> {
    let gpu = tauri::async_runtime::spawn_blocking(super::system::gpu_now).await.ok().flatten()?;
    Some(gpu.vram_used_mb as f32 / gpu.vram_total_mb.max(1) as f32 * 100.0)
}

/// Enforce an OS master permission tier. Ask → `PERMISSION_REQUIRED:<what>` unless approved.
pub fn gate(bridge: &BridgeState, tier: Tier, what: &str, approved: bool, detail: serde_json::Value) -> Result<(), String> {
    let outcome = match tier {
        Tier::Deny => Err(format!("PERMISSION_DENIED:{what}")),
        Tier::Ask if !approved => Err(format!("PERMISSION_REQUIRED:{what}")),
        _ => Ok(()),
    };
    if outcome.is_err() || tier != Tier::Allow {
        bridge.log(serde_json::json!({ "type": "permission", "action": what, "decision": match &outcome { Ok(()) => "allow".to_string(), Err(e) => e.clone() }, "detail": detail }));
    }
    outcome
}

// ── OS-level secrets (not bound to a provider) ──────────────────────────────
//
// Each name maps to a fixed host in Rust, so these keys can only ever be sent
// to that service. The webview can set / check / delete, never read.

const SERVICE: &str = "agentic-os-command-center";
pub const OS_SECRETS: [&str; 15] = [
    "anthropic", "gemini", "brave", "twelvedata", "vault", "gateway-token", "anythingllm-remote", "gmail-script-id", "gmail-script-key",
    // Google Calendar's Apps Script deployment (`calendar.rs`): only ever sent to script.google.com.
    "gcal-script-id", "gcal-script-key",
    // Remote MCP tokens: each is only ever sent to its own host (see `mcp::REMOTE_AUTH`).
    "github-pat", "sentry-token", "agentmail-key",
    // Instagram API with Instagram Login (`instagram.rs`): only ever sent to graph.instagram.com.
    "instagram-token",
];

/// Secrets only Rust writes (OAuth state). The webview can neither set nor delete them
/// (`os_secret_set` / `os_secret_delete` refuse); `devqueue::known_secrets` still scrubs them.
pub const INTERNAL_SECRETS: [&str; 4] = ["spotify-refresh", "spotify-session", "spotify-grant", "instagram-refreshed"];

fn os_entry(name: &str) -> Result<keyring::Entry, String> {
    if !OS_SECRETS.contains(&name) && !INTERNAL_SECRETS.contains(&name) {
        return Err("unknown secret".into());
    }
    keyring::Entry::new(SERVICE, &format!("os:{name}")).map_err(|e| e.to_string())
}

/// Webview-manageable names only (Settings secret rows).
fn webview_secret(name: &str) -> Result<(), String> {
    if OS_SECRETS.contains(&name) {
        Ok(())
    } else {
        Err("unknown secret".into())
    }
}

pub(crate) fn os_secret(name: &str) -> Option<String> {
    os_entry(name).ok()?.get_password().ok()
}

/// Like `os_secret`, but tells "no such entry" (`Ok(None)`) apart from a keychain
/// failure (`Err`), so a Credential Manager hiccup doesn't read as "logged out".
/// The error text names the failure kind only, never a value.
pub(crate) fn os_secret_lookup(name: &str) -> Result<Option<String>, String> {
    match os_entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed ({})", keyring_error_kind(&e))),
    }
}

fn keyring_error_kind(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::PlatformFailure(_) => "platform failure",
        keyring::Error::NoStorageAccess(_) => "no storage access",
        keyring::Error::BadEncoding(_) => "bad encoding",
        keyring::Error::TooLong(..) => "too long",
        keyring::Error::Invalid(..) => "invalid",
        keyring::Error::Ambiguous(_) => "ambiguous",
        _ => "other",
    }
}

/// Rust-side writes (OAuth refresh tokens, imported credentials) — never via the webview.
pub(crate) fn os_secret_store(name: &str, value: &str) -> Result<(), String> {
    os_entry(name)?.set_password(value).map_err(|e| e.to_string())
}

pub(crate) fn os_secret_clear(name: &str) -> Result<(), String> {
    match os_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn os_secret_set(name: String, value: String) -> Result<(), String> {
    let v = value.trim();
    super::secrets::check_secret_value(v)?;
    if name == "vault" && v.len() < 10 {
        return Err("vault password must be at least 10 characters".into());
    }
    webview_secret(&name)?;
    os_secret_store(&name, v)
}

/// Keychain presence only (the gateway-token chip uses it). Settings key rows use
/// `envfile::os_secret_sources`, which also knows about the env / repo `.env`.
#[tauri::command]
pub fn os_secret_status() -> BTreeMap<String, bool> {
    OS_SECRETS.iter().map(|n| (n.to_string(), os_secret(n).is_some())).collect()
}

#[tauri::command]
pub fn os_secret_delete(name: String) -> Result<(), String> {
    webview_secret(&name)?;
    os_secret_clear(&name)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn os_config_get(os: State<'_, OsState>) -> OsConfig {
    os.snapshot()
}

/// Recursively merge `src` into `dst` (objects merge key by key at every
/// depth; arrays and scalars replace wholesale). Used so a patch to a deeply
/// nested section — e.g. `routing.agents.booking.names` — never wipes its
/// siblings (every other role, every other field) the way a shallow merge would.
fn merge_json(dst: &mut serde_json::Value, src: &serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
            for (k, v) in s {
                match d.get_mut(k) {
                    Some(slot) => merge_json(slot, v),
                    None => {
                        d.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (d, s) => *d = s.clone(),
    }
}

/// Deep-merge a JSON patch into the config (objects merge at every depth;
/// arrays and scalars replace wholesale — see `merge_json`).
#[tauri::command]
pub fn os_config_update(app: tauri::AppHandle, os: State<'_, OsState>, state: State<'_, DispatchState>, bridge: State<'_, BridgeState>, patch: serde_json::Value) -> Result<OsConfig, String> {
    let before = os.snapshot();
    // Locking the mic is a dead line before anything else (even if the write below fails).
    if patch["voice"]["micEnabled"].as_bool() == Some(false) {
        super::voice::set_mic_enabled(&app, false);
    }
    let next = os.update(|cfg| {
        let mut cur = serde_json::to_value(&*cfg).map_err(|e| e.to_string())?;
        let (Some(dst), Some(src)) = (cur.as_object_mut(), patch.as_object()) else { return Err("patch must be an object".into()) };
        for (k, v) in src {
            match dst.get_mut(k) {
                Some(slot) => merge_json(slot, v),
                None => return Err(format!("unknown setting: {k}")),
            }
        }
        *cfg = serde_json::from_value(cur).map_err(|e| format!("invalid settings: {e}"))?;
        Ok(())
    })?;
    // A manual narration level (NarrationControl / the narration voice intent) overrides the
    // mode's tts level until the next switch or reset (D17). The mode switch writes through
    // `os.update`, never this path, so it is never recorded as an override.
    if note_manual_feedback(&os, &before, &next) {
        // The override chip / Reset in the Mode Panel and ModePill follow `tony-mode-changed`.
        super::modes::notify_changed(&app);
    }
    // Only an actual change applies: an unrelated patch never re-opens a mic locked off live.
    if next.voice.mic_enabled != before.voice.mic_enabled {
        super::voice::set_mic_enabled(&app, next.voice.mic_enabled);
    }
    // Keep the droplet provider's endpoint in step with the droplet card.
    if next.droplet.model_url != before.droplet.model_url && !next.droplet.model_url.is_empty() {
        let url = next.droplet.model_url.clone();
        let _ = state.update(|c| {
            if let Some(p) = c.providers.iter_mut().find(|p| p.id == "droplet") {
                p.base_url = url;
            }
            Ok(())
        });
    }
    if next.privacy.kill_switch != before.privacy.kill_switch || next.compute.mode != before.compute.mode {
        bridge.log(serde_json::json!({ "type": "os-config", "killSwitch": next.privacy.kill_switch, "computeMode": next.compute.mode }));
    }
    if next.privacy.network_lock && !before.privacy.network_lock {
        ensure_gateway_token(&state);
    }
    // The MCP registry (or the MCP permission tier) changed: the tools a turn can use did too.
    let mcp_view = |c: &OsConfig| serde_json::to_value((&c.mcps, c.permissions.mcp, &c.switchboard)).ok();
    if mcp_view(&next) != mcp_view(&before) {
        super::mcp::emit_tools_changed(&app, "mcp-registry-saved");
    }
    Ok(next)
}

/// `os_config_update` changed `feedback.sensitivity` by hand: record it as a mode override
/// (cleared when it matches the mode's own level) and refresh the phone mirror. True when the
/// level changed (the caller then tells the webview the mode view changed).
pub(crate) fn note_manual_feedback(os: &OsState, before: &OsConfig, next: &OsConfig) -> bool {
    if next.feedback.sensitivity == before.feedback.sensitivity {
        return false;
    }
    os.modes.note_feedback(next.feedback.sensitivity);
    os.refresh_mirror();
    true
}

/// MASTER_IDENTITY.md (truncated), for the OS system prompt and Settings preview.
#[tauri::command]
pub fn os_identity(os: State<'_, OsState>) -> Result<String, String> {
    read_identity(&os.snapshot())
}

pub fn read_identity(cfg: &OsConfig) -> Result<String, String> {
    let s = std::fs::read_to_string(&cfg.identity_path).map_err(|e| format!("{}: {e}", cfg.identity_path))?;
    Ok(s.chars().take(6000).collect())
}

#[tauri::command]
pub fn privacy_last_payload(os: State<'_, OsState>) -> Option<RedactionRecord> {
    os.last_redaction.lock().unwrap().clone()
}

/// Preview what the diffuser would send (Settings → "Test the diffuser").
#[tauri::command]
pub fn privacy_preview(os: State<'_, OsState>, text: String) -> serde_json::Value {
    let mut r = super::privacy::Redactor::default();
    let red = r.redact(&text, &os.snapshot().privacy.sensitive_terms);
    serde_json::json!({ "redacted": red, "replacements": r.replacements })
}

// ── Droplet ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbe {
    id: String,
    label: String,
    url: String,
    up: bool,
    detail: String,
    latency_ms: u128,
}

async fn probe(state: &DispatchState, id: &str, label: &str, url: &str, path: &str, bearer: Option<String>) -> EndpointProbe {
    let started = std::time::Instant::now();
    if url.is_empty() {
        return EndpointProbe { id: id.into(), label: label.into(), url: url.into(), up: false, detail: "not set".into(), latency_ms: 0 };
    }
    let mut rb = state.http.get(format!("{}{path}", url.trim_end_matches('/'))).timeout(Duration::from_secs(4));
    if let Some(b) = bearer {
        rb = rb.bearer_auth(b);
    }
    let (up, detail) = match rb.send().await {
        Ok(r) if r.status().is_success() => (true, format!("{}", r.status().as_u16())),
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => (true, "reachable · auth required".into()),
        Ok(r) => (false, format!("HTTP {}", r.status().as_u16())),
        Err(e) => (false, short(e)),
    };
    EndpointProbe { id: id.into(), label: label.into(), url: url.into(), up, detail, latency_ms: started.elapsed().as_millis() }
}

/// Test & reconnect: probe every droplet endpoint (works even while the switch is off).
#[tauri::command]
pub async fn droplet_test(os: State<'_, OsState>, state: State<'_, DispatchState>) -> Result<Vec<EndpointProbe>, String> {
    let d = os.snapshot().droplet;
    let key = state.provider("droplet").and_then(|p| state.key_for(&p).ok().flatten());
    let (a, b, c, e) = (
        probe(&state, "model", "Model / proxy", &d.model_url, "/models", key),
        probe(&state, "qdrant", "Qdrant vector DB", &d.qdrant_url, "/healthz", None),
        probe(&state, "n8n", "n8n webhooks", &d.n8n_url, "/healthz", None),
        probe(&state, "anythingllm", "AnythingLLM (remote)", &d.anythingllm_url, "/api/ping", None),
    );
    Ok(vec![a.await, b.await, c.await, e.await])
}

// ── Network lock ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenFinding {
    port: u16,
    service: String,
    bind: String,
    exposed: bool,
    fix: String,
}

/// Which known service ports listen on every interface (0.0.0.0 / [::]) rather
/// than loopback or the NetBird mesh. We can't rebind other apps; we report and
/// say exactly how to fix each.
#[tauri::command]
pub async fn network_audit() -> Result<Vec<ListenFinding>, String> {
    let out = tauri::async_runtime::spawn_blocking(|| crate::proc::stdout("netstat", &["-ano", "-p", "TCP"])).await.map_err(|e| e.to_string())??;
    let known: [(u16, &str, &str); 8] = [
        (1234, "LM Studio", "LM Studio → Developer → Server settings → untick “Serve on local network”."),
        (1235, "Bionic (LM Studio)", "Server settings → untick “Serve on local network”."),
        (3001, "AnythingLLM", "AnythingLLM Desktop binds all interfaces by default — block port 3001 inbound in Windows Firewall."),
        (5678, "n8n (Docker)", "Recreate the container with -p 127.0.0.1:5678:5678."),
        (8080, "Gateway (server.py)", "Start with --host 127.0.0.1 (the default) or your NetBird IP."),
        (8178, "Whisper", "Start whisper-server with --host 127.0.0.1."),
        (8880, "Kokoro", "Recreate the container with -p 127.0.0.1:8880:8880."),
        (8888, "AnythingLLM collector", "Internal to AnythingLLM; block inbound 8888 in Windows Firewall."),
    ];
    let mut found: BTreeMap<u16, ListenFinding> = BTreeMap::new();
    for line in out.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[0] != "TCP" || cols[3] != "LISTENING" {
            continue;
        }
        let local = cols[1];
        let Some((addr, port)) = local.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        let Some((_, name, fix)) = known.iter().find(|(p, _, _)| *p == port) else { continue };
        let exposed = addr == "0.0.0.0" || addr == "[::]";
        let entry = found.entry(port).or_insert(ListenFinding { port, service: name.to_string(), bind: addr.to_string(), exposed, fix: String::new() });
        if exposed {
            entry.exposed = true;
            entry.bind = addr.to_string();
        }
        entry.fix = if entry.exposed { fix.to_string() } else { String::new() };
    }
    Ok(found.into_values().collect())
}

/// Gateway bearer token for zero-trust mode: desktop (loopback) is trusted;
/// anything else (the phone over NetBird) must present this token. Written to
/// `<repo>/data/command-center/gateway.token` for server.py (that folder is
/// gitignored). Returns true if a token exists.
pub fn ensure_gateway_token(state: &DispatchState) -> bool {
    let token = match os_secret("gateway-token") {
        Some(t) => t,
        None => {
            let t = random_token();
            if os_entry("gateway-token").and_then(|e| e.set_password(&t).map_err(|e| e.to_string())).is_err() {
                return false;
            }
            t
        }
    };
    write_token_file(state, &token);
    true
}

fn write_token_file(state: &DispatchState, token: &str) {
    let dir = PathBuf::from(state.snapshot().gateway.workdir).join("data").join("command-center");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("gateway.token"), token);
}

fn random_token() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; 32];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Make a new gateway token and show it ONCE so it can be typed into the phone.
#[tauri::command]
pub fn gateway_token_rotate(state: State<'_, DispatchState>) -> Result<String, String> {
    let t = random_token();
    os_entry("gateway-token")?.set_password(&t).map_err(|e| e.to_string())?;
    write_token_file(&state, &t);
    Ok(t)
}

/// Bearer for gateway / droplet calls when the network lock is on.
pub fn mesh_bearer(os: &OsConfig) -> Option<String> {
    if os.privacy.network_lock {
        os_secret("gateway-token")
    } else {
        None
    }
}


// ── Droplet connection manager ──────────────────────────────────────────────
//
// After a reboot the NetBird client can come up "Idle" or logged out, so the
// droplet looks dead. Every 15 s (while the droplet switch is on): probe the
// model endpoint; after two misses run `netbird up`, re-probe, and publish the
// state (`droplet-status` event + phone mirror) for the top-bar badge.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DropletLink {
    pub state: String,
    pub detail: String,
    pub latency_ms: u128,
    pub at: u64,
}

async fn droplet_probe(state: &DispatchState, url: &str) -> Result<u128, String> {
    let t0 = std::time::Instant::now();
    let r = state.http.get(format!("{}/models", url.trim_end_matches('/'))).timeout(Duration::from_secs(5)).send().await.map_err(short)?;
    // 401 = the server is there and wants its key — that's "connected".
    if r.status().is_success() || r.status().as_u16() == 401 {
        Ok(t0.elapsed().as_millis())
    } else {
        Err(format!("HTTP {}", r.status().as_u16()))
    }
}

fn netbird_up() -> String {
    match crate::proc::stdout("netbird", &["up"]) {
        Ok(o) => o.lines().last().unwrap_or("netbird up").trim().to_string(),
        Err(e) => e,
    }
}

pub async fn droplet_link_loop(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let mut misses = 0u32;
    let mut was_disabled = false;
    loop {
        let os = app.state::<OsState>();
        let st = app.state::<DispatchState>();
        let cfg = os.snapshot();
        // Bloat guard: a switched-off droplet is announced once, then checked every 60 s for a
        // config change (it used to emit + log every 15 s forever).
        if !cfg.droplet.enabled {
            misses = 0;
            if !was_disabled {
                was_disabled = true;
                let link = DropletLink { state: "disabled".into(), detail: "switched off".into(), latency_ms: 0, at: now_secs() };
                let _ = app.emit("droplet-status", link.clone());
                super::introspect::loop_ran("droplet", true, "disabled: switched off");
                os.set_runtime("droplet", serde_json::to_value(&link).unwrap_or_default());
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
            continue;
        }
        was_disabled = false;
        let link = {
            match droplet_probe(&st, &cfg.droplet.model_url).await {
                Ok(ms) => {
                    misses = 0;
                    DropletLink { state: "connected".into(), detail: cfg.droplet.host.clone(), latency_ms: ms, at: now_secs() }
                }
                Err(e) => {
                    misses += 1;
                    if misses >= 2 && misses % 2 == 0 {
                        // Wake the mesh, then re-check right away.
                        let out = tauri::async_runtime::spawn_blocking(netbird_up).await.unwrap_or_default();
                        let _ = app.emit("droplet-status", DropletLink { state: "reconnecting".into(), detail: out.chars().take(120).collect(), latency_ms: 0, at: now_secs() });
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        match droplet_probe(&st, &cfg.droplet.model_url).await {
                            Ok(ms) => {
                                misses = 0;
                                DropletLink { state: "connected".into(), detail: format!("{} (reconnected)", cfg.droplet.host), latency_ms: ms, at: now_secs() }
                            }
                            Err(e2) => DropletLink { state: "offline".into(), detail: format!("{e2} — netbird up tried"), latency_ms: 0, at: now_secs() },
                        }
                    } else {
                        DropletLink { state: if misses == 1 { "checking".into() } else { "offline".into() }, detail: e, latency_ms: 0, at: now_secs() }
                    }
                }
            }
        };
        let _ = app.emit("droplet-status", link.clone());
        super::introspect::loop_ran("droplet", link.state != "offline", &format!("{}: {}", link.state, link.detail));
        os.set_runtime("droplet", serde_json::to_value(&link).unwrap_or_default());
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

#[tauri::command]
pub async fn droplet_link(os: State<'_, OsState>, state: State<'_, DispatchState>) -> Result<DropletLink, String> {
    let cfg = os.snapshot();
    if !cfg.droplet.enabled {
        return Ok(DropletLink { state: "disabled".into(), detail: "switched off".into(), latency_ms: 0, at: now_secs() });
    }
    Ok(match droplet_probe(&state, &cfg.droplet.model_url).await {
        Ok(ms) => DropletLink { state: "connected".into(), detail: cfg.droplet.host.clone(), latency_ms: ms, at: now_secs() },
        Err(e) => DropletLink { state: "offline".into(), detail: e, latency_ms: 0, at: now_secs() },
    })
}

#[tauri::command]
pub fn gpu_slot_view(os: State<'_, OsState>) -> super::scheduler::SlotView {
    os.slot.view()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_bad_section_does_not_reset_the_droplet() {
        // A good droplet section next to a section of the wrong type (e.g. written by another
        // version): the droplet must survive; only the broken section goes back to defaults.
        let mut v = serde_json::to_value(OsConfig::default()).unwrap();
        v["droplet"] = json!({ "enabled": true, "host": "100.84.1.36", "modelUrl": "http://100.84.1.36:8000/v1" });
        v["compute"] = json!("not-an-object");
        let text = v.to_string();
        assert!(serde_json::from_str::<OsConfig>(&text).is_err(), "the fixture must not parse as a whole");
        let (cfg, dropped) = recover_os_config(&text);
        assert!(cfg.droplet.enabled);
        assert_eq!(cfg.droplet.host, "100.84.1.36");
        assert_eq!(cfg.droplet.model_url, "http://100.84.1.36:8000/v1");
        assert_eq!(dropped, vec!["compute".to_string()]);
    }

    #[test]
    fn lenient_parse_keeps_a_copy_of_the_bad_file() {
        let dir = std::env::temp_dir().join(format!("os-lenient-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("os.json");
        let text = r#"{"droplet":{"enabled":true,"host":"h"},"compute":7}"#;
        let cfg = parse_os_config_lenient(text, &path);
        assert!(cfg.droplet.enabled);
        let copies: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("os.json.invalid-")).collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(std::fs::read_to_string(copies[0].path()).unwrap(), text);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn voice_defaults_clamp_and_mirror() {
        // An os.json from before Part B (no `voice` key) loads with the mic on and -44 / 6 dB.
        let old: OsConfig = serde_json::from_value(json!({ "osName": "Tony", "feedback": { "sensitivity": 2 } })).unwrap();
        assert!(old.voice.mic_enabled);
        assert_eq!((old.voice.activation_db, old.voice.barge_margin_db), (-44.0, 6.0));
        assert!(!old.voice.activation_db_set, "a defaulted gate is not a user value");
        assert!(validate(&old).is_ok());
        let set: OsConfig = serde_json::from_value(json!({ "voice": { "activationDb": -56, "activationDbSet": true } })).unwrap();
        assert!(set.voice.activation_db_set);
        assert_eq!(serde_json::to_value(&set).unwrap()["voice"]["activationDbSet"], true);
        // Out-of-range values clamp on load and on the os_config_update path.
        let hot: OsConfig = serde_json::from_value(json!({ "voice": { "activationDb": 5, "bargeMarginDb": 99 } })).unwrap();
        assert_eq!((hot.voice.activation_db, hot.voice.barge_margin_db), (-10.0, 20.0));
        let cold: OsConfig = serde_json::from_value(json!({ "voice": { "activationDb": -90, "bargeMarginDb": -3 } })).unwrap();
        assert_eq!((cold.voice.activation_db, cold.voice.barge_margin_db), (-70.0, 0.0));
        assert!(cold.voice.mic_enabled, "a partial voice block keeps the mic default");
        let mut cur = serde_json::to_value(OsConfig::default()).unwrap();
        merge_json(&mut cur, &json!({ "voice": { "micEnabled": false, "activationDb": -38.5 } }));
        let next: OsConfig = serde_json::from_value(cur).unwrap();
        assert!(!next.voice.mic_enabled);
        assert_eq!(next.voice.activation_db, -38.5);
        assert_eq!(next.voice.barge_margin_db, 6.0);
        let v = serde_json::to_value(&next).unwrap();
        assert_eq!(v["voice"]["micEnabled"], false);
        // The phone mirror carries the mic state (and the gate) — nothing else from `voice`.
        let m = mirror_json(&next, serde_json::Map::new());
        assert_eq!(m["voice"]["micEnabled"], false);
        assert_eq!(m["voice"]["activationDb"], -38.5);
        assert_eq!(m["osName"], "Tony");
        let mut bad = OsConfig::default();
        bad.voice.activation_db = 3.0;
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn scrolls_config_defaults_migrate_sanitize_and_clamp() {
        // An os.json from before Phase 3 (no `memory.scrolls`) loads with the defaults.
        let old: OsConfig = serde_json::from_value(json!({ "osName": "Tony", "memory": { "storage": "local", "mountWorkspace": "my-workspace" } })).unwrap();
        let s = &old.memory.scrolls;
        assert_eq!(*s, ScrollsConfig::default());
        assert!(!s.auto_compact && !s.embed_only, "auto-compaction and embed-only default off");
        assert_eq!((s.threshold_kb, s.threshold_turns, s.quiet_mins, s.check_secs, s.max_batches_auto), (50, 25, 10, 300, 1));
        assert_eq!(s.workspace, "librarian");
        assert_eq!(s.scrolls_root(), PathBuf::from(DEFAULT_SCROLLS_DIR));
        let v = serde_json::to_value(&old).unwrap();
        assert_eq!(v["memory"]["scrolls"]["thresholdKb"], 50);
        assert_eq!(v["memory"]["scrolls"]["autoCompact"], false);
        assert_eq!(v["memory"]["scrolls"]["embedOnly"], false);
        // Booking / invalid workspaces sanitise to `librarian`.
        for bad in ["my-workspace", "booking", "bad slug", "", "Upper", "-x"] {
            let c: OsConfig = serde_json::from_value(json!({ "memory": { "scrolls": { "workspace": bad } } })).unwrap();
            assert_eq!(c.memory.scrolls.sanitized_workspace(), "librarian", "{bad:?}");
            assert_eq!(c.memory.scrolls.sanitized().workspace, "librarian", "{bad:?}");
        }
        let ok: OsConfig = serde_json::from_value(json!({ "memory": { "scrolls": { "workspace": "memory-2" , "scrollsDir": "D:/scrolls" } } })).unwrap();
        assert_eq!(ok.memory.scrolls.sanitized_workspace(), "memory-2");
        assert_eq!(ok.memory.scrolls.scrolls_root(), PathBuf::from("D:/scrolls"));
        // Clamps on load and on the os_config_update path.
        let hot: OsConfig = serde_json::from_value(json!({ "memory": { "scrolls": { "thresholdKb": 99999, "thresholdTurns": 9999, "quietMins": 9999, "checkSecs": 1, "maxBatchesAuto": 9 } } })).unwrap();
        let h = &hot.memory.scrolls;
        assert_eq!((h.threshold_kb, h.threshold_turns, h.quiet_mins, h.check_secs, h.max_batches_auto), (1024, 500, 240, 60, 4));
        let mut cur = serde_json::to_value(OsConfig::default()).unwrap();
        merge_json(&mut cur, &json!({ "memory": { "scrolls": { "thresholdKb": 1, "autoCompact": true } } }));
        let next: OsConfig = serde_json::from_value(cur).unwrap();
        assert_eq!(next.memory.scrolls.threshold_kb, 8);
        assert!(next.memory.scrolls.auto_compact);
        assert_eq!(next.memory.scrolls.threshold_turns, 25, "a partial patch keeps the other defaults");
    }

    #[test]
    fn scrolls_and_graph_default_to_the_g_memory_root() {
        assert_eq!(DEFAULT_SCROLLS_DIR, r"G:\ai-hub-memory\scrolls");
        assert_eq!(DEFAULT_KG_PATH, r"G:\ai-hub-memory\knowledge-graph.json");
        assert!(DEFAULT_SCROLLS_DIR.starts_with(DEFAULT_MEMORY_DIR) && DEFAULT_KG_PATH.starts_with(DEFAULT_MEMORY_DIR));
        assert_eq!(super::super::mcp::KG_PATH, DEFAULT_KG_PATH, "the app's kg.search and Phase 3 share one graph");
        assert!(!under_read_only_hub(Path::new(DEFAULT_SCROLLS_DIR)) && !under_read_only_hub(Path::new(DEFAULT_KG_PATH)));
        assert_eq!(ScrollsConfig::default().scrolls_root(), PathBuf::from(r"G:\ai-hub-memory\scrolls"));
    }

    #[test]
    fn scrolls_dir_under_the_read_only_hub_is_refused() {
        let refused = [
            r"C:\ai-hub",
            r"C:\ai-hub\memory\scrolls",
            "c:/AI-HUB/memory/scrolls/",
            r"C:\x\..\ai-hub\memory",
            r"\\?\C:\ai-hub\memory",
            r"\\.\C:\AI-hub\memory",
            r"C:\ai-hub.\memory",
            "  C:\\ai-hub\\memory  ",
            // The admin share of C: (any host; `net use Z: \\localhost\C$` canonicalizes to this too).
            r"\\localhost\C$\ai-hub\memory\scrolls",
            r"\\127.0.0.1\c$\ai-hub\m",
            "//localhost/c$/ai-hub/m",
            r"\\?\UNC\localhost\c$\ai-hub\m",
            r"\\Server\C$\AI-HUB",
            r"\\localhost\c$\x\..\ai-hub\memory",
            // The hub's home since the move to G:.
            r"G:\ai-hub",
            "g:/AI-HUB/memory/scrolls",
            r"\\localhost\G$\ai-hub\m",
        ];
        for d in refused {
            assert!(under_read_only_hub(Path::new(d)), "{d:?}");
            let c: OsConfig = serde_json::from_value(json!({ "memory": { "scrolls": { "scrollsDir": d, "archiveDir": d } } })).unwrap();
            let s = c.memory.scrolls.sanitized();
            assert_eq!((s.scrolls_dir.as_str(), s.archive_dir.as_str()), ("", ""), "{d:?} falls back to the default");
            assert_eq!(c.memory.scrolls.scrolls_root(), PathBuf::from(DEFAULT_SCROLLS_DIR), "{d:?}");
        }
        for d in [r"C:\ai-hub2\scrolls", r"C:\ai-hubx", r"D:\ai-hub-memory\scrolls", r"D:\ai-hub\memory", "D:/scrolls", "", r"\\localhost\c$\ai-hub2", r"\\localhost\d$\ai-hub-memory\scrolls", r"\\localhost\c$", r"\\server\share\ai-hub", r"G:\ai-hub-memory\scrolls", r"G:\ai-hub2"] {
            assert!(!under_read_only_hub(Path::new(d)), "{d:?}");
        }
        let ok: OsConfig = serde_json::from_value(json!({ "memory": { "scrolls": { "scrollsDir": "E:/scrolls", "archiveDir": "E:/arch" } } })).unwrap();
        let s = ok.memory.scrolls.sanitized();
        assert_eq!((s.scrolls_dir.as_str(), s.archive_dir.as_str()), ("E:/scrolls", "E:/arch"));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_into_a_protected_root_is_caught() {
        let base = std::env::temp_dir().join(format!("aos-hubguard-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let hub = base.join("fake-hub");
        std::fs::create_dir_all(hub.join("memory")).unwrap();
        let link = base.join("link");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&hub).output().map(|o| o.status.success()).unwrap_or(false);
        let root = hub.to_string_lossy().into_owned();
        assert!(path_under_root(&hub.join("memory").join("scrolls"), &root));
        assert!(!path_under_root(&base.join("elsewhere").join("scrolls"), &root));
        if made {
            assert!(path_under_root(&link.join("memory").join("scrolls"), &root), "junction resolved");
            assert!(path_under_root(&PathBuf::from(link.to_string_lossy().to_uppercase()).join("MEMORY"), &root), "case-insensitive through the junction");
            let _ = std::fs::remove_dir(&link); // the junction only, never its target
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn feedback_and_worker_default_and_clamp() {
        // An existing os.json (no feedback / worker / new memory keys) loads unchanged.
        let old: OsConfig = serde_json::from_value(json!({ "osName": "Tony", "memory": { "storage": "local" } })).unwrap();
        assert_eq!(old.feedback.sensitivity, 1);
        assert_eq!(old.feedback.narration_engine, "kokoro");
        // Section pass: Prompter -> Designer -> Coder (no Librarian), two revision rounds.
        assert!(old.worker.enabled && !old.worker.verify && old.worker.offload_code && !old.worker.librarian_audit);
        assert_eq!(old.worker.max_iterations, 2);
        assert_eq!((old.memory.notes_dir.as_str(), old.memory.staging_dir.as_str()), ("", ""));
        let hot: OsConfig = serde_json::from_value(json!({ "feedback": { "sensitivity": 7 }, "worker": { "maxIterations": 99 } })).unwrap();
        assert_eq!((hot.feedback.sensitivity, hot.worker.max_iterations), (3, 15));
        let cold: OsConfig = serde_json::from_value(json!({ "feedback": { "sensitivity": -2 }, "worker": { "maxIterations": 0 } })).unwrap();
        assert_eq!((cold.feedback.sensitivity, cold.worker.max_iterations), (0, 1));
        // The os_config_update path (merge_json + from_value) clamps a patch the same way.
        let mut cur = serde_json::to_value(OsConfig::default()).unwrap();
        merge_json(&mut cur, &json!({ "feedback": { "sensitivity": 7 } }));
        let next: OsConfig = serde_json::from_value(cur).unwrap();
        assert_eq!(next.feedback.sensitivity, 3);
        assert!(validate(&next).is_ok());
        let v = serde_json::to_value(&next).unwrap();
        assert_eq!(v["feedback"]["narrationEngine"], "kokoro");
        assert_eq!(v["worker"]["librarianAudit"], false, "section pass: no Librarian in the build chain");
        let mut bad = OsConfig::default();
        bad.feedback.narration_engine = "elevenlabs".into();
        assert!(validate(&bad).is_err());
        let mut rel = OsConfig::default();
        rel.memory.staging_dir = "staging".into();
        assert!(validate(&rel).is_err());
    }

    #[test]
    fn merge_json_is_recursive_and_keeps_siblings() {
        let mut dst = json!({
            "routing": {
                "autoSwitch": true,
                "agents": {
                    "booking": { "names": ["booking"], "domains": ["whatsapp"] },
                    "coder": { "names": ["coder"], "domains": ["rust"] }
                }
            },
            "osName": "Tony"
        });
        // A patch touching only booking.names must not disturb coder, booking.domains or autoSwitch.
        let patch = json!({ "routing": { "agents": { "booking": { "names": ["booking", "casting"] } } } });
        merge_json(&mut dst, &patch);
        assert_eq!(dst["routing"]["autoSwitch"], json!(true));
        assert_eq!(dst["routing"]["agents"]["booking"]["names"], json!(["booking", "casting"]));
        assert_eq!(dst["routing"]["agents"]["booking"]["domains"], json!(["whatsapp"]));
        assert_eq!(dst["routing"]["agents"]["coder"]["names"], json!(["coder"]));
        assert_eq!(dst["osName"], json!("Tony"));
    }

    #[test]
    fn merge_json_replaces_arrays_wholesale() {
        let mut dst = json!({ "a": [1, 2, 3] });
        merge_json(&mut dst, &json!({ "a": [9] }));
        assert_eq!(dst["a"], json!([9]));
    }

    #[test]
    fn routing_defaults_cover_every_role() {
        let agents = default_routing_agents();
        for role in ["booking", "prompter", "coder", "designer", "director", "librarian", "bizops", "finance", "general"] {
            let t = agents.get(role).unwrap_or_else(|| panic!("missing default routing role {role}"));
            // Tony (general) has none on purpose: addressing him is routing::SELF_NAMES (kind Self);
            // the frozen Booking Desk keeps only its own names (Section 20.1).
            assert_eq!(t.names.is_empty(), role == "general", "{role} name triggers");
        }
        assert_eq!(agents["booking"], trig(BOOKING_NAMES, &[]), "Booking has its names and no topics");
        for topic in ["booking", "casting", "audition", "talent agent"] {
            assert!(!agents["booking"].names.iter().any(|n| n == topic), "{topic} is not a Booking name");
        }
        // A WhatsApp read is Tony's live tool, and Whisper's "what's up" greeting used to land on
        // Booking through these two: neither is a Booking topic any more.
        assert!(!agents["booking"].domains.contains(&"whatsapp".to_string()));
        assert!(!agents["booking"].domains.contains(&"messages".to_string()));
        // Nor is any messages / texts read: Tony reads Gmail and WhatsApp himself (section pass).
        assert!(!agents["booking"].domains.iter().any(|d| d.contains("message") || d.contains("text")));
        // Casting logistics are Tony's now; recording / editing a tape is the Director's.
        assert!(agents["general"].domains.contains(&"self-tape".to_string()));
        assert!(!agents["director"].domains.contains(&"self-tape".to_string()));
        assert!(agents["director"].domains.contains(&"record my self-tape".to_string()));
        // The removed infrastructure agent has no row: infrastructure and job quotes / estimates
        // are Tony's own topics.
        assert!(!agents.keys().any(|k| is_removed_ops(k)));
        for t in ["droplet", "docker", "n8n", "server status", "quote", "estimate", "estimates"] {
            assert!(agents["general"].domains.contains(&t.to_string()), "{t}");
            assert!(!agents.iter().any(|(r, a)| r != "general" && a.domains.contains(&t.to_string())), "{t} has one owner");
        }
    }

    /// Sections 20.1 / 20.2: the one-time re-split removes exactly the moved phrases from their old
    /// owners (a phrase of the user's own stays), empties Booking, adds the new owners' phrases,
    /// runs once, and leaves a fresh config equal to the defaults.
    #[test]
    fn contracting_becomes_tonys_once() {
        use super::super::routing::{resolve, RouteKind};
        let mut cfg = OsConfig::default();
        // A config that already ran the older resplit, which put contracting on another row.
        cfg.migrations = vec![MIGRATE_WHATSAPP_READ_ONLY.into(), MIGRATE_SELF_ROUTING.into(), MIGRATE_VAULT_CADENCE.into(), MIGRATE_BIZOPS_SPLIT.into(), MIGRATE_BOOKING_NO_TOOLS.into(), MIGRATE_BUILD_CHAIN.into(), MIGRATE_LOCAL_SAFE_DEFAULTS.into(), MIGRATE_ROUTING_RESPLIT.into(), MIGRATE_INTEGRATION_OWNERS.into(), MIGRATE_BOOKING_NAMES.into()];
        cfg.routing.agents.get_mut("general").unwrap().domains.retain(|d| !CONTRACTING_TO_TONY.contains(&d.as_str()));
        cfg.routing.agents.get_mut("general").unwrap().domains.push("Quote".into());
        apply_migrations(&mut cfg);
        for p in CONTRACTING_TO_TONY {
            assert_eq!(cfg.routing.agents["general"].domains.iter().filter(|d| d.eq_ignore_ascii_case(p)).count(), 1, "{p} is Tony's once");
        }
        let r = resolve("send the masonry quote to the subcontractor", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("general"), RouteKind::Own));
        // Once: a phrase Nic takes off Tony by hand stays off.
        cfg.routing.agents.get_mut("general").unwrap().domains.retain(|d| d != "masonry");
        apply_migrations(&mut cfg);
        assert!(!cfg.routing.agents["general"].domains.contains(&"masonry".to_string()));
    }

    #[test]
    fn routing_resplit_moves_exactly_the_moved_phrases_once() {
        use super::super::routing::resolve;
        let mut cfg = OsConfig::default();
        cfg.migrations = vec![MIGRATE_WHATSAPP_READ_ONLY.into(), MIGRATE_SELF_ROUTING.into(), MIGRATE_VAULT_CADENCE.into(), MIGRATE_BIZOPS_SPLIT.into(), MIGRATE_BOOKING_NO_TOOLS.into(), MIGRATE_LOCAL_SAFE_DEFAULTS.into()];
        // The pre-Section-20 rows, plus one phrase of the user's own on each.
        cfg.routing.agents.insert("booking".into(), trig(&["booking", "booking desk", "casting", "audition"], &["casting call", "self-tape", "wardrobe", "availability", "draft email to agent"]));
        cfg.routing.agents.insert("bizops".into(), trig(&["bizops", "business"], &["invoice", "quote", "job site", "subcontractor", "inventory", "bf supplements", "contracting", "masonry", "ecommerce", "shopify"]));
        apply_migrations(&mut cfg);
        let a = &cfg.routing.agents;
        // Booking keeps only its own names (the topic-ish "booking" / "casting" / "audition" go).
        assert_eq!(a["booking"], trig(BOOKING_NAMES, &[]));
        // Contracting is Tony's (no Job Desk yet).
        assert!(a["general"].domains.contains(&"masonry".to_string()) && a["general"].domains.contains(&"job desk".to_string()));
        assert!(a["bizops"].domains.contains(&"shopify".to_string()) && a["bizops"].domains.contains(&"instagram".to_string()));
        for gone in ["invoice", "quote", "job site", "subcontractor", "contracting", "masonry"] {
            assert!(!a["bizops"].domains.iter().any(|d| d == gone), "{gone} left bizops");
        }
        assert!(a["finance"].domains.contains(&"invoice".to_string()) && a["finance"].domains.contains(&"commissions".to_string()));
        assert!(a["general"].domains.contains(&"calendar".to_string()) && a["general"].domains.contains(&"audition".to_string()));
        for (text, role) in [("send the masonry quote to the subcontractor", "general"), ("how many bf supplements orders on instagram", "bizops"), ("log the hst on that invoice", "finance"), ("edit my self-tape for the audition", "director")] {
            assert_eq!(resolve(text, &cfg).role.as_deref(), Some(role), "{text}");
        }
        for text in ["check the casting call availability", "schedule the audition", "did imperious send the bookings"] {
            let r = resolve(text, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some("general"), super::super::routing::RouteKind::Own), "{text}");
        }
        // Once: a phrase the user puts back afterwards stays.
        cfg.routing.agents.get_mut("bizops").unwrap().domains.push("invoice".into());
        apply_migrations(&mut cfg);
        assert!(cfg.routing.agents["bizops"].domains.contains(&"invoice".to_string()));
        // A fresh config already is the outcome.
        let mut fresh = OsConfig::default();
        let before = fresh.routing.agents.clone();
        resplit_routing(&mut fresh);
        assert_eq!(fresh.routing.agents, before);
    }

    /// A config that already ran the re-split (Booking emptied) gets the desk's NAMES back once,
    /// never its topics; a name the user later removes stays removed.
    #[test]
    fn booking_names_come_back_once_without_topics() {
        let mut cfg = OsConfig::default();
        cfg.migrations = vec![MIGRATE_WHATSAPP_READ_ONLY.into(), MIGRATE_SELF_ROUTING.into(), MIGRATE_VAULT_CADENCE.into(), MIGRATE_BIZOPS_SPLIT.into(), MIGRATE_BOOKING_NO_TOOLS.into(), MIGRATE_LOCAL_SAFE_DEFAULTS.into(), MIGRATE_ROUTING_RESPLIT.into(), MIGRATE_INTEGRATION_OWNERS.into()];
        cfg.routing.agents.insert("booking".into(), AgentTriggers::default());
        apply_migrations(&mut cfg);
        assert_eq!(cfg.routing.agents["booking"], trig(BOOKING_NAMES, &[]));
        let r = super::super::routing::resolve("ask the booking desk to check my availability", &cfg);
        assert_eq!((r.role.as_deref(), r.kind), (Some("booking"), super::super::routing::RouteKind::Named));
        // Once: the user drops "B&Co"; it stays dropped.
        cfg.routing.agents.get_mut("booking").unwrap().names.retain(|n| n != "B&Co");
        apply_migrations(&mut cfg);
        assert!(!cfg.routing.agents["booking"].names.iter().any(|n| n == "B&Co"));
    }

    /// Section 21.1: one owner per integration, by default and by the one-time migration.
    #[test]
    fn integration_owners_one_owner_each_once() {
        let grants = |c: &OsConfig, id: &str| c.mcps.iter().find(|m| m.id == id).and_then(|m| m.agents.clone()).unwrap_or_default();
        let fresh = OsConfig::default();
        assert_eq!(grants(&fresh, "whatsapp"), ["general"]);
        assert_eq!(grants(&fresh, "maps"), ["general"]);
        assert_eq!(grants(&fresh, "instagram"), ["bizops"]);
        assert_eq!(grants(&fresh, "shotcut"), ["director"]);
        assert_eq!(grants(&fresh, "media-forge"), ["director"]);
        assert!(grants(&fresh, "gmail") == ["general"], "every gmail tool is Tony's");
        // A saved config from before: Booking on WhatsApp / Gmail, Tony on Shotcut, maps the Coder's.
        let mut cfg = OsConfig::default();
        cfg.migrations = vec![MIGRATE_WHATSAPP_READ_ONLY.into(), MIGRATE_SELF_ROUTING.into(), MIGRATE_VAULT_CADENCE.into(), MIGRATE_BIZOPS_SPLIT.into(), MIGRATE_BOOKING_NO_TOOLS.into(), MIGRATE_LOCAL_SAFE_DEFAULTS.into(), MIGRATE_ROUTING_RESPLIT.into()];
        let set = |c: &mut OsConfig, id: &str, a: &[&str]| c.mcps.iter_mut().find(|m| m.id == id).unwrap().agents = Some(a.iter().map(|s| s.to_string()).collect());
        set(&mut cfg, "whatsapp", &["general", "booking"]);
        set(&mut cfg, "gmail", &["general", "booking"]);
        set(&mut cfg, "shotcut", &["director", "general"]);
        set(&mut cfg, "instagram", &["bizops", "general"]);
        set(&mut cfg, "maps", &["coder"]);
        set(&mut cfg, "filesystem", &["coder", "booking", "librarian"]);
        cfg.tony_mode_tools.insert("builder".into(), vec!["git".into(), "media-forge".into()]);
        apply_migrations(&mut cfg);
        assert_eq!(grants(&cfg, "whatsapp"), ["general"]);
        assert_eq!(grants(&cfg, "gmail"), ["general"]);
        assert_eq!(grants(&cfg, "shotcut"), ["director"]);
        assert_eq!(grants(&cfg, "instagram"), ["bizops"]);
        assert_eq!(grants(&cfg, "maps"), ["general"]);
        assert_eq!(grants(&cfg, "filesystem"), ["coder", "librarian"], "other servers only lose the frozen Booking Desk");
        assert_eq!(cfg.tony_mode_tools["builder"], ["git"]);
        // Once.
        set(&mut cfg, "maps", &["coder"]);
        apply_migrations(&mut cfg);
        assert_eq!(grants(&cfg, "maps"), ["coder"]);
    }

    /// Section 11.10: the read-only Finance server is a builtin, on, Tony's alone, by default and
    /// by the one-time migration (a saved "all" is narrowed once; a later edit stands).
    #[test]
    fn finance_read_server_is_tonys_once() {
        let grants = |c: &OsConfig| c.mcps.iter().find(|m| m.id == "finance").and_then(|m| m.agents.clone()).unwrap_or_default();
        let fresh = OsConfig::default();
        let f = fresh.mcps.iter().find(|m| m.id == "finance").expect("finance builtin");
        assert!(f.enabled && f.builtin && f.transport == "builtin");
        assert_eq!(grants(&fresh), ["general"]);
        assert_eq!(default_mcp_grants("finance"), ["general"]);
        let mut cfg = OsConfig::default();
        cfg.migrations = vec![MIGRATE_WHATSAPP_READ_ONLY.into(), MIGRATE_SELF_ROUTING.into(), MIGRATE_VAULT_CADENCE.into(), MIGRATE_BIZOPS_SPLIT.into(), MIGRATE_BOOKING_NO_TOOLS.into(), MIGRATE_LOCAL_SAFE_DEFAULTS.into(), MIGRATE_ROUTING_RESPLIT.into(), MIGRATE_INTEGRATION_OWNERS.into(), MIGRATE_BOOKING_NAMES.into()];
        cfg.mcps.iter_mut().find(|m| m.id == "finance").unwrap().agents = Some(vec!["all".into()]);
        cfg.mcps.iter_mut().find(|m| m.id == "finance").unwrap().enabled = false;
        apply_migrations(&mut cfg);
        assert_eq!(grants(&cfg), ["general"]);
        assert!(!cfg.mcps.iter().find(|m| m.id == "finance").unwrap().enabled, "a server Nic switched off stays off");
        assert!(cfg.migrations.iter().any(|m| m == MIGRATE_FINANCE_READ));
        // Once: Nic grants the finance role too; the migration never takes it back.
        cfg.mcps.iter_mut().find(|m| m.id == "finance").unwrap().agents = Some(vec!["general".into(), "finance".into()]);
        apply_migrations(&mut cfg);
        assert_eq!(grants(&cfg), ["general", "finance"]);
    }

    /// The read-only infrastructure status server (`system.status`): a builtin, on, Tony's alone.
    #[test]
    fn system_status_server_is_tonys() {
        let s = OsConfig::default().mcps.into_iter().find(|m| m.id == "system").expect("system builtin");
        assert!(s.enabled && s.builtin && s.transport == "builtin" && !s.read_only);
        assert_eq!(s.agents.as_deref(), Some(&["general".to_string()][..]));
        assert_eq!(default_mcp_grants("system"), ["general"]);
        // An older os.json gets the row from `default_mcps` on load, grant included.
        let d = default_mcps().into_iter().find(|m| m.id == "system").unwrap();
        assert_eq!(d.agents.as_deref(), Some(&["general".to_string()][..]));
    }

    /// Section 20.8: live delegation never reaches the Librarian / Booking workspaces; the mapping
    /// stays for the scheduled Librarian scripts.
    #[test]
    fn live_delegation_skips_the_unmapped_roles() {
        let cfg = OsConfig::default();
        assert_eq!(live_workspace(&cfg, "librarian"), None);
        assert_eq!(live_workspace(&cfg, "booking"), None);
        assert_eq!(cfg.anythingllm.workspaces.get("librarian").map(String::as_str), Some("librarian"), "kept for the scheduled scripts");
        assert_eq!(live_workspace(&cfg, "coder").as_deref(), Some("coder"));
        assert_eq!(cfg.anythingllm.timeout_secs, 90);
    }

    #[test]
    fn validate_rejects_empty_trigger_strings() {
        let mut c = OsConfig::default();
        c.routing.agents.get_mut("coder").unwrap().names.push("  ".into());
        assert!(validate(&c).is_err());
    }

    #[test]
    fn mcp_grants_match_the_tool_owner_split() {
        let cases: [(&str, &[&str]); 15] = [
            ("weather", &["general"]),
            ("calendar", &["general"]),
            ("spotify", &["general"]),
            ("brave-search", &["general"]),
            ("gmail", &["general"]),
            ("whatsapp", &["general"]),
            ("time", &["general"]),
            ("knowledge-graph", &["general", "librarian", "prompter"]),
            ("filesystem", &["coder", "designer", "director", "librarian", "prompter"]),
            ("git", &["coder"]),
            ("fetch", &["coder", "prompter"]),
            ("maps", &["general"]),
            ("instagram", &["bizops"]),
            ("shotcut", &["director"]),
            ("media-forge", &["director"]),
        ];
        for (id, want) in cases {
            assert_eq!(default_mcp_grants(id), want.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{id}");
        }
        assert_eq!(default_mcp_grants("some-future-server"), vec!["all".to_string()]);
        // Every known server is in the migration's list, and Tony owns none of the media servers.
        assert_eq!(TOOL_OWNER_SERVERS.len(), cases.len());
        for (id, _) in cases {
            assert!(TOOL_OWNER_SERVERS.contains(&id), "{id}");
        }
        let tony: Vec<&str> = cases.iter().filter(|(id, _)| agent_matches(&default_mcp_grants(id), "tony")).map(|(id, _)| *id).collect();
        assert_eq!(tony, ["weather", "calendar", "spotify", "brave-search", "gmail", "whatsapp", "time", "knowledge-graph", "maps"]);
        for (agent, want) in [("coder", &["filesystem", "git", "fetch"][..]), ("designer", &["filesystem"]), ("director", &["filesystem", "shotcut", "media-forge"]), ("bizops", &["instagram"]), ("librarian", &["knowledge-graph", "filesystem"]), ("prompter", &["knowledge-graph", "filesystem", "fetch"]), ("finance", &[]), ("trader", &[])] {
            let mut got: Vec<&str> = cases.iter().filter(|(id, _)| agent_matches(&default_mcp_grants(id), agent)).map(|(id, _)| *id).collect();
            let mut want = want.to_vec();
            got.sort();
            want.sort();
            assert_eq!(got, want, "{agent}");
        }
    }

    #[test]
    fn mcp_server_grants_is_all_or_list() {
        let open = McpServer { agents: None, ..blank_mcp() };
        assert!(open.grants("coder"));
        assert!(open.grants("anyone"));

        let all = McpServer { agents: Some(vec!["all".into()]), ..blank_mcp() };
        assert!(all.grants("coder"));

        let scoped = McpServer { agents: Some(vec!["coder".into(), "bizops".into()]), ..blank_mcp() };
        assert!(scoped.grants("coder"));
        assert!(scoped.grants("bizops"));
        assert!(!scoped.grants("booking"));
        // Tony is NOT special-cased: he respects grants like every other agent.
        assert!(!scoped.grants("general") && !scoped.grants("tony"));
        let tony = McpServer { agents: Some(vec!["general".into()]), ..blank_mcp() };
        assert!(tony.grants("general") && tony.grants("tony") && tony.grants("Tony") && !tony.grants("coder"));
    }

    fn blank_mcp() -> McpServer {
        McpServer { id: "x".into(), name: "X".into(), transport: "builtin".into(), enabled: true, builtin: true, ..Default::default() }
    }

    #[test]
    fn default_mcps_carry_exact_grants() {
        let mcps = default_mcps();
        let whatsapp = mcps.iter().find(|m| m.id == "whatsapp").unwrap();
        assert_eq!(whatsapp.agents, Some(vec!["general".to_string()]));
        let weather = mcps.iter().find(|m| m.id == "weather").unwrap();
        assert_eq!(weather.agents, Some(vec!["general".to_string()]));
        let spotify = mcps.iter().find(|m| m.id == "spotify").unwrap();
        assert!(!spotify.enabled && spotify.transport == "builtin");
        // Google Calendar: Tony's own builtin, on by default (no backend = no tools listed).
        let cal = mcps.iter().find(|m| m.id == "calendar").unwrap();
        assert!(cal.enabled && cal.transport == "builtin" && !cal.read_only);
        assert_eq!(cal.agents, Some(vec!["general".to_string()]));
        assert!(OS_SECRETS.contains(&"gcal-script-id") && OS_SECRETS.contains(&"gcal-script-key"));
        // The booking-mail instruction path: serde default, kept when saved.
        let c: OsConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c.gmail.booking_instructions_path, r"G:\ai-hub\protocols\booking-email-check.md");
        let c: OsConfig = serde_json::from_str(r#"{"gmail":{"bookingInstructionsPath":"D:\\x.md"}}"#).unwrap();
        assert_eq!(c.gmail.booking_instructions_path, r"D:\x.md");
        // Settings → Comms inbox scope: an os.json saved before it existed gets Primary only.
        assert_eq!(c.gmail.inbox_scope, "primary");
        let c: OsConfig = serde_json::from_str(r#"{"gmail":{"inboxScope":"all"}}"#).unwrap();
        assert_eq!((c.gmail.inbox_scope.as_str(), c.gmail.booking_instructions_path.as_str()), ("all", r"G:\ai-hub\protocols\booking-email-check.md"));
    }

    #[test]
    fn load_or_init_backfills_agents_only_when_missing() {
        // Simulates an os.json saved before this field existed: `agents` is
        // absent entirely (serde default → None after parsing), AND a server
        // the user has already edited (agents: Some(["booking"])) must be
        // left exactly as they set it.
        let raw = r#"{"mcps":[
            {"id":"whatsapp","name":"WhatsApp Bridge","transport":"stdio","command":"uv","args":[],"env":{},"url":"","enabled":false,"builtin":true,"description":""},
            {"id":"git","name":"Git","transport":"builtin","command":"","args":[],"env":{},"url":"","enabled":true,"builtin":true,"description":"","agents":["booking"]}
        ]}"#;
        let mut cfg: OsConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.mcps[0].agents, None);
        for m in cfg.mcps.iter_mut() {
            if m.agents.is_none() {
                m.agents = Some(default_mcp_grants(&m.id));
            }
        }
        assert_eq!(cfg.mcps[0].agents, Some(vec!["general".to_string()]));
        assert_eq!(cfg.mcps[1].agents, Some(vec!["booking".to_string()])); // untouched: user-edited value kept
    }

    #[test]
    fn whatsapp_is_read_only_by_default_and_migrated_once() {
        assert!(default_mcps().iter().find(|m| m.id == "whatsapp").unwrap().read_only);
        // An os.json saved before the default: readOnly absent (= false), no migration marker.
        let raw = r#"{"mcps":[{"id":"whatsapp","name":"WhatsApp Bridge","transport":"stdio","enabled":true},{"id":"git","name":"Git","transport":"builtin","enabled":true}]}"#;
        let mut cfg: OsConfig = serde_json::from_str(raw).unwrap();
        assert!(!cfg.mcps[0].read_only);
        apply_migrations(&mut cfg);
        assert!(cfg.mcps[0].read_only);
        assert!(!cfg.mcps[1].read_only, "only WhatsApp");
        // The user unticks Read-only later: the saved marker keeps the migration from re-running.
        cfg.mcps[0].read_only = false;
        let saved = serde_json::to_string(&cfg).unwrap();
        let mut reloaded: OsConfig = serde_json::from_str(&saved).unwrap();
        apply_migrations(&mut reloaded);
        assert!(!reloaded.mcps[0].read_only);
        assert_eq!(reloaded.migrations, vec![MIGRATE_WHATSAPP_READ_ONLY.to_string(), MIGRATE_SELF_ROUTING.to_string(), MIGRATE_VAULT_CADENCE.to_string(), MIGRATE_BIZOPS_SPLIT.to_string(), MIGRATE_BOOKING_NO_TOOLS.to_string(), MIGRATE_BUILD_CHAIN.to_string(), MIGRATE_LOCAL_SAFE_DEFAULTS.to_string(), MIGRATE_ROUTING_RESPLIT.to_string(), MIGRATE_INTEGRATION_OWNERS.to_string(), MIGRATE_BOOKING_NAMES.to_string(), MIGRATE_CONTRACTING_TO_TONY.to_string(), MIGRATE_FINANCE_READ.to_string(), MIGRATE_OPS_REMOVED.to_string()]);
    }

    #[test]
    fn bizops_split_backfills_the_business_and_finance_rows_once() {
        // A saved pre-split config: no bizops / finance rows.
        let mut cfg = OsConfig::default();
        cfg.routing.agents.remove("bizops");
        cfg.routing.agents.remove("finance");
        // Only the bizops split here (the later re-split has its own test).
        cfg.migrations = vec![MIGRATE_ROUTING_RESPLIT.into(), MIGRATE_INTEGRATION_OWNERS.into()];
        apply_migrations(&mut cfg);
        assert_eq!(cfg.routing.agents["bizops"], default_routing_agents()["bizops"]);
        assert!(cfg.routing.agents["finance"].names.contains(&"finance".to_string()));
        // Routing now sends business paperwork to bizops and money questions to Finance.
        assert_eq!(super::super::routing::resolve("check the bf supplements inventory", &cfg).role.as_deref(), Some("bizops"));
        assert_eq!(super::super::routing::resolve("ask the bookkeeper about expenses", &cfg).role.as_deref(), Some("finance"));
        // Once: a row Nic deletes afterwards stays deleted.
        cfg.routing.agents.remove("bizops");
        apply_migrations(&mut cfg);
        assert!(!cfg.routing.agents.contains_key("bizops"));
        // The finance workspace mapping is exactly finance → finance (not an anomaly).
        assert!(!super::super::finance_vault::finance_mapping_anomaly(&OsConfig::default().anythingllm.workspaces));
    }

    #[test]
    fn local_safe_defaults_migrate_once_and_tony_turns_never_overflow() {
        let fresh = OsConfig::default();
        assert_eq!(fresh.compute.mode, ComputeMode::Hybrid, "Local only would block the on-demand Claude CLI");
        assert_eq!(fresh.permissions.cloud, Tier::Ask);
        assert!(!fresh.overseer.auto_escalate);
        // A config saved before Section 20: cloud Allow, auto-escalate on, roster narration.
        let mut cfg = OsConfig::default();
        cfg.permissions.cloud = Tier::Allow;
        cfg.overseer.auto_escalate = true;
        cfg.feedback.narration_engine = "roster".into();
        apply_migrations(&mut cfg);
        assert_eq!((cfg.compute.mode, cfg.permissions.cloud, cfg.overseer.auto_escalate), (ComputeMode::Hybrid, Tier::Ask, false));
        assert_eq!(cfg.feedback.narration_engine, "kokoro");
        // Once: switching back afterwards is the user's choice.
        cfg.permissions.cloud = Tier::Allow;
        apply_migrations(&mut cfg);
        assert_eq!(cfg.permissions.cloud, Tier::Allow);
        // A deliberate Deny is kept, and so is Allow in deliberate Cloud mode.
        let mut c2 = OsConfig::default();
        c2.permissions.cloud = Tier::Deny;
        apply_local_safe_defaults(&mut c2);
        assert_eq!(c2.permissions.cloud, Tier::Deny);
        let mut c3 = OsConfig::default();
        c3.compute.mode = ComputeMode::Cloud;
        c3.permissions.cloud = Tier::Allow;
        apply_local_safe_defaults(&mut c3);
        assert_eq!(c3.permissions.cloud, Tier::Allow);

        let local = super::super::dispatch::Config::default().providers.into_iter().find(|p| p.kind.is_chat() && !is_remote(p)).expect("a local chat provider");
        let mut remote = local.clone();
        remote.id = "remote".into();
        remote.base_url = "https://api.example.com/v1".into();
        // On Ask (the default) Hybrid never reaches an unpinned remote backend, even over the threshold.
        let (asked, _) = shape_chain(&OsConfig::default(), vec![local.clone(), remote.clone()], Some(95.0), 0, false);
        assert_eq!(asked.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec![local.id.as_str()]);
        // Allow + VRAM over the threshold: background work offloads, Tony's turn doesn't.
        let (bg, _) = shape_chain(&cfg, vec![local.clone(), remote.clone()], Some(95.0), 0, false);
        assert_eq!(bg[0].id, remote.id, "background work may overflow");
        let (tony, _) = shape_tony_turn(&cfg, vec![local.clone(), remote]);
        assert_eq!(tony[0].id, local.id, "Tony's chat turn stays local");
    }

    #[test]
    fn self_routing_migration_drops_tony_from_general_once() {
        assert!(default_routing_agents()["general"].names.is_empty(), "fresh installs have no self name trigger");
        let raw = r#"{"routing":{"autoSwitch":true,"agents":{"general":{"names":["tony","Tony","boss"],"domains":["system status"]}}}}"#;
        let mut cfg: OsConfig = serde_json::from_str(raw).unwrap();
        apply_migrations(&mut cfg);
        assert_eq!(cfg.routing.agents["general"].names, vec!["boss".to_string()]);
        // Re-adding it later is the user's choice: the marker keeps the migration from re-running.
        cfg.routing.agents.get_mut("general").unwrap().names.push("tony".into());
        apply_migrations(&mut cfg);
        assert_eq!(cfg.routing.agents["general"].names, vec!["boss".to_string(), "tony".to_string()]);
        // …and resolve() still never routes "thanks tony" to a Named Tony.
        let r = super::super::routing::resolve("thanks tony", &cfg);
        assert_eq!(r.kind, super::super::routing::RouteKind::Own);
    }

    #[test]
    fn self_alias_keys_fold_into_general() {
        let raw = r#"{"routing":{"autoSwitch":true,"agents":{
            "general":{"names":[],"domains":["system status"]},
            "tony":{"names":["boss"],"domains":["System Status","uptime"]},
            "Dispatcher":{"names":["chief"],"domains":[]}
        }},"anythingllm":{"baseUrl":"http://127.0.0.1:3001","timeoutSecs":90,"workspaces":{"tony":"tony-ws","orchestrator":"other","coder":"coder"}}}"#;
        let mut cfg: OsConfig = serde_json::from_str(raw).unwrap();
        canonicalize_self_keys(&mut cfg);
        let g = &cfg.routing.agents["general"];
        assert_eq!(g.names, vec!["chief".to_string(), "boss".to_string()]); // BTreeMap order: "Dispatcher" < "tony"
        assert_eq!(g.domains, vec!["system status".to_string(), "uptime".to_string()]);
        assert!(!cfg.routing.agents.contains_key("tony") && !cfg.routing.agents.contains_key("Dispatcher"));
        // general had no workspace: the first alias's slug fills it; the rest are dropped.
        assert_eq!(cfg.anythingllm.workspaces.get("general").map(String::as_str), Some("other"));
        assert_eq!(cfg.anythingllm.workspaces.keys().cloned().collect::<Vec<_>>(), vec!["coder".to_string(), "general".to_string()]);
        // An existing general slug always wins.
        let mut cfg = OsConfig::default();
        cfg.anythingllm.workspaces.insert("tony".into(), "tony-ws".into());
        canonicalize_self_keys(&mut cfg);
        assert_eq!(cfg.anythingllm.workspaces["general"], "my-workspace");
        assert!(!cfg.anythingllm.workspaces.contains_key("tony"));
        // The OS name is a self key too.
        let mut cfg = OsConfig::default();
        cfg.os_name = "Friday".into();
        cfg.routing.agents.insert("friday".into(), AgentTriggers { names: vec!["fri".into()], domains: vec![] });
        canonicalize_self_keys(&mut cfg);
        assert!(cfg.routing.agents["general"].names.contains(&"fri".to_string()));
        assert!(agent_matches(&["dispatcher".to_string()], "general") && agent_matches(&["tony".to_string()], "general"));
    }

    #[test]
    fn validate_rejects_bad_agent_grant() {
        let mut c = OsConfig::default();
        c.mcps[0].agents = Some(vec!["not a valid id!".into()]);
        assert!(validate(&c).is_err());
        c.mcps[0].agents = Some(vec!["all".into()]);
        assert!(validate(&c).is_ok());
    }

    #[test]
    fn validate_mcp_timeout_and_cwd() {
        let mut c = OsConfig::default();
        for (t, ok) in [(4, false), (5, true), (600, true), (601, false)] {
            c.mcps[0].timeout_secs = Some(t);
            assert_eq!(validate(&c).is_ok(), ok, "timeout {t}");
        }
        c.mcps[0].timeout_secs = None;
        c.mcps[0].cwd = Some("relative\\dir".into());
        assert!(validate(&c).is_err());
        c.mcps[0].cwd = Some(if cfg!(windows) { r"D:\Art Apps\agentic os".into() } else { "/tmp".into() });
        assert!(validate(&c).is_ok());
    }

    #[test]
    fn mcp_server_without_new_fields_still_loads() {
        let m: McpServer = serde_json::from_str(r#"{"id":"s","name":"S","transport":"stdio","command":"npx","enabled":true}"#).unwrap();
        assert_eq!((m.timeout_secs, m.cwd.as_deref()), (None, None));
        // Unset fields are not written back.
        let out = serde_json::to_string(&m).unwrap();
        assert!(!out.contains("timeoutSecs") && !out.contains("cwd"), "{out}");
        let m: McpServer = serde_json::from_str(r#"{"id":"s","name":"S","transport":"stdio","command":"npx","enabled":true,"timeoutSecs":90,"cwd":"C:\\x"}"#).unwrap();
        assert_eq!((m.timeout_secs, m.cwd.as_deref()), (Some(90), Some("C:\\x")));
    }

    #[test]
    fn agent_matches_accepts_all_or_exact() {
        assert!(agent_matches(&["all".to_string()], "coder"));
        assert!(agent_matches(&["coder".to_string()], "coder"));
        assert!(!agent_matches(&["coder".to_string()], "booking"));
    }

    #[test]
    fn auto_monthly_migrates_to_the_lifecycle_cadence_once() {
        // An os.json from before the cadence: auto-run monthly on, October already harvested.
        let mut cfg: OsConfig = serde_json::from_value(json!({ "memory": { "autoMonthly": true, "autoFlush": true, "lastAutoMonth": "2026-10" } })).unwrap();
        assert!(cfg.memory.auto_monthly && !cfg.memory.auto_run_enabled);
        apply_migrations(&mut cfg);
        assert!(cfg.memory.auto_run_enabled && !cfg.memory.auto_monthly);
        assert_eq!(cfg.memory.cadence, "monthly");
        assert!(cfg.memory.auto_flush, "the flush consent is kept");
        assert_eq!(cfg.memory.last_verified_harvest_at, super::super::hygiene::month_end_secs("2026-10").unwrap(), "October counts as harvested");
        assert!(cfg.migrations.iter().any(|m| m == MIGRATE_VAULT_CADENCE));
        // The legacy key is never written back; the new ones are.
        let v = serde_json::to_value(&cfg).unwrap();
        assert!(v["memory"].get("autoMonthly").is_none());
        assert_eq!((v["memory"]["autoRunEnabled"].as_bool(), v["memory"]["cadence"].as_str(), v["memory"]["targetHour"].as_u64()), (Some(true), Some("monthly"), Some(3)));
        // Applied once: turning it off afterwards sticks across a reload.
        cfg.memory.auto_run_enabled = false;
        let mut reloaded: OsConfig = serde_json::from_value(serde_json::to_value(&cfg).unwrap()).unwrap();
        apply_migrations(&mut reloaded);
        assert!(!reloaded.memory.auto_run_enabled);
        // auto_monthly off: nothing switches on, defaults stay.
        let mut off: OsConfig = serde_json::from_value(json!({ "memory": { "autoMonthly": false } })).unwrap();
        apply_migrations(&mut off);
        assert!(!off.memory.auto_run_enabled);
        assert_eq!((off.memory.cadence.as_str(), off.memory.target_hour, off.memory.weekly_day, off.memory.last_verified_harvest_at), ("monthly", 3, 0, 0));
        // Out-of-range hour / weekday clamp instead of failing the whole config.
        let c: OsConfig = serde_json::from_value(json!({ "memory": { "targetHour": 99, "weeklyDay": -3, "hotPath": { "ragTimeoutMs": 9000, "ragTopK": 0 } } })).unwrap();
        assert_eq!((c.memory.target_hour, c.memory.weekly_day), (23, 0));
        assert_eq!((c.memory.hot_path.rag_timeout_ms, c.memory.hot_path.rag_top_k), (2500, 1));
        assert_eq!(MemoryConfig::default().hot_path.rag_timeout_ms, 2000);
    }

    // ── Master switchboard + the one-time tool-owner migration ──────────────

    #[test]
    fn switchboard_defaults_legacy_and_camel_case() {
        let d = OsConfig::default();
        // Booking and the Librarian (scheduled script only) are frozen on a fresh install.
        assert_eq!(d.switchboard, SwitchboardConfig { version: 1, frozen_agents: vec!["booking".into(), "librarian".into()], frozen_tools: vec![] });
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["switchboard"], json!({ "version": 1, "frozenAgents": ["booking", "librarian"], "frozenTools": [] }));
        // An os.json saved before the switchboard: both frozen, migration still to run.
        let old: OsConfig = serde_json::from_str(r#"{"osName":"Tony"}"#).unwrap();
        assert_eq!(old.switchboard, SwitchboardConfig { version: 0, frozen_agents: vec!["booking".into(), "librarian".into()], frozen_tools: vec![] });
        // A saved choice is kept as is (Nic thawed Booking).
        let thawed: OsConfig = serde_json::from_str(r#"{"switchboard":{"version":1,"frozenAgents":[],"frozenTools":["instagram"]}}"#).unwrap();
        assert_eq!((thawed.switchboard.frozen_agents.len(), thawed.switchboard.frozen_tools.clone()), (0, vec!["instagram".to_string()]));
        assert!(needs_tool_owner_migration(r#"{"osName":"Tony"}"#));
        assert!(needs_tool_owner_migration(r#"{"switchboard":{"version":0}}"#));
        assert!(needs_tool_owner_migration("not json"));
        assert!(!needs_tool_owner_migration(r#"{"switchboard":{"version":1}}"#));
        assert!(!needs_tool_owner_migration(&serde_json::to_string(&d).unwrap()));
    }

    #[test]
    fn validate_never_freezes_tony_or_the_always_live_tools() {
        let ok = |f: &dyn Fn(&mut SwitchboardConfig)| {
            let mut c = OsConfig::default();
            f(&mut c.switchboard);
            validate(&c).is_ok()
        };
        assert!(ok(&|_| {}));
        assert!(ok(&|s| s.frozen_tools = vec!["instagram".into(), "media-forge".into()]));
        assert!(!ok(&|s| s.frozen_agents.push("general".into())));
        assert!(!ok(&|s| s.frozen_agents.push("Tony".into())));
        assert!(!ok(&|s| s.frozen_agents.push("bad id!".into())));
        for t in ["time", "skills", "tony"] {
            assert!(!ok(&|s| s.frozen_tools = vec![t.into()]), "{t}");
        }
    }

    /// The live shape before the switchboard: the old default grants, one server switched off,
    /// the Designer's eight skills and a Tony skill.
    fn pre_switchboard_os_json(skills_dir: &Path) -> String {
        let old_grants = |id: &str| -> Vec<&str> {
            match id {
                "whatsapp" | "gmail" => vec!["booking"],
                "time" => vec!["booking", "coder"],
                "filesystem" => vec!["booking", "coder", "librarian", "prompter", "designer", "director"],
                "knowledge-graph" => vec!["booking", "librarian", "prompter"],
                "git" => vec!["coder"],
                "fetch" => vec!["coder", "librarian", "prompter", "designer"],
                "brave-search" => vec!["coder", "librarian"],
                "shotcut" | "media-forge" => vec!["director"],
                _ => vec!["all"],
            }
        };
        let mcps: Vec<serde_json::Value> = default_mcps()
            .into_iter()
            // Added after the switchboard: an os.json this old never had it (load back-fills it).
            .filter(|m| m.id != "system")
            .map(|m| {
                let mut v = serde_json::to_value(&m).unwrap();
                v["agents"] = json!(old_grants(&m.id));
                v["enabled"] = json!(m.id != "maps");
                v
            })
            .collect();
        let mut grants = serde_json::Map::new();
        for n in ["animate", "design-taste-frontend", "emil-design-eng", "frontend-design", "impeccable", "stitch-generate-design", "stitch-manage-design-system", "taste-design"] {
            grants.insert(n.into(), json!(["designer"]));
        }
        grants.insert("daily-standup".into(), json!(["tony", "coder"]));
        json!({ "osName": "Tony", "mcps": mcps, "skills": { "dir": skills_dir.display().to_string(), "grants": grants }, "migrations": ["whatsapp-read-only", "self-routing", "vault-cadence", "bizops-split"] }).to_string()
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-os-switchboard-{tag}-{}-{}", std::process::id(), now_secs()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tool_owner_migration_backs_up_first_runs_once_and_keeps_toggles() {
        // `load_or_init` seeds the global mic flag: share the mic tests' lock.
        let _mic = super::super::voice::mic_gate_tests::lock();
        let root = tmp("migrate");
        let (dir, repo, skills) = (root.join("cfg"), root.join("repo"), root.join("skills"));
        for n in ["impeccable", "design-taste-frontend", "animation-vocabulary", "taste-design"] {
            std::fs::create_dir_all(skills.join(n)).unwrap();
            std::fs::write(skills.join(n).join("SKILL.md"), format!("---\nname: {n}\ndescription: x\n---\nbody")).unwrap();
        }
        std::fs::create_dir_all(&dir).unwrap();
        let saved = pre_switchboard_os_json(&skills);
        std::fs::write(dir.join("os.json"), &saved).unwrap();
        let os = OsState::default();
        os.load_or_init(&dir, &repo);
        let cfg = os.snapshot();
        // 1. The backup holds the file exactly as it was, named os.json.bak-<YYYYMMDD-HHMMSS>-tool-owners.
        let backups: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.file_name().unwrap().to_string_lossy().ends_with("-tool-owners")).collect();
        assert_eq!(backups.len(), 1, "{backups:?}");
        let name = backups[0].file_name().unwrap().to_string_lossy().into_owned();
        let stamp = name.trim_start_matches("os.json.bak-").trim_end_matches("-tool-owners");
        assert!(stamp.len() == 15 && stamp.as_bytes()[8] == b'-' && stamp.chars().filter(|c| c.is_ascii_digit()).count() == 14, "{name}");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), saved);
        // 2. Grants are the split; toggles are untouched (maps stays off).
        for m in &cfg.mcps {
            assert_eq!(m.agents, Some(default_mcp_grants(&m.id)), "{}", m.id);
            assert_eq!(m.enabled, m.id != "maps", "{}: a server Nic switched off stays off", m.id);
        }
        assert!(cfg.mcps.iter().find(|m| m.id == "whatsapp").unwrap().read_only);
        // 3. Skills: the Designer's two, the Director's motion vocabulary, Tony none; others kept.
        let who = |n: &str| cfg.skills.grants.get(n).cloned().unwrap_or_default();
        assert_eq!(who("impeccable"), vec!["designer"]);
        assert_eq!(who("design-taste-frontend"), vec!["designer"]);
        assert_eq!(who("animation-vocabulary"), vec!["director"]);
        for n in ["taste-design", "animate", "emil-design-eng", "frontend-design", "stitch-generate-design"] {
            assert!(!cfg.skills.grants.contains_key(n), "{n}");
        }
        assert_eq!(who("daily-standup"), vec!["coder"], "Tony's grant is dropped, the Coder keeps its own");
        // 4. Booking and the Librarian frozen, version set, saved.
        assert_eq!(cfg.switchboard, SwitchboardConfig { version: 1, frozen_agents: vec!["booking".into(), "librarian".into()], frozen_tools: vec![] });
        let on_disk: OsConfig = serde_json::from_str(&std::fs::read_to_string(dir.join("os.json")).unwrap()).unwrap();
        assert_eq!(on_disk.switchboard.version, 1);
        assert_eq!(on_disk.switchboard.frozen_agents, vec!["booking".to_string(), "librarian".to_string()]);
        // 5. Never twice: Nic re-grants git to Tony and re-enables maps; a restart keeps both, no new backup.
        os.update(|c| {
            c.mcps.iter_mut().find(|m| m.id == "git").unwrap().agents = Some(vec!["coder".into(), "general".into()]);
            c.mcps.iter_mut().find(|m| m.id == "maps").unwrap().enabled = true;
            Ok(())
        })
        .unwrap();
        let again = OsState::default();
        again.load_or_init(&dir, &repo);
        let c2 = again.snapshot();
        assert_eq!(c2.mcps.iter().find(|m| m.id == "git").unwrap().agents, Some(vec!["coder".to_string(), "general".to_string()]));
        assert!(c2.mcps.iter().find(|m| m.id == "maps").unwrap().enabled);
        let n = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with("-tool-owners")).count();
        assert_eq!(n, 1, "the migration never runs twice");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_build_chain_drops_the_librarian_and_an_old_default_of_3_becomes_2_once() {
        let mut cfg: OsConfig = serde_json::from_value(json!({ "worker": { "maxIterations": 3, "librarianAudit": true } })).unwrap();
        apply_migrations(&mut cfg);
        assert_eq!((cfg.worker.max_iterations, cfg.worker.librarian_audit), (2, false));
        // A deliberate choice is kept, and a later change sticks.
        let mut picked: OsConfig = serde_json::from_value(json!({ "worker": { "maxIterations": 5 } })).unwrap();
        apply_migrations(&mut picked);
        assert_eq!(picked.worker.max_iterations, 5);
        cfg.worker.librarian_audit = true;
        let mut again: OsConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        apply_migrations(&mut again);
        assert!(again.worker.librarian_audit);
    }

    /// The live os.json shape before the removal: the infrastructure agent's route (its infra
    /// topics plus one of Nic's own), its AnythingLLM link, its Maps grant, a skill grant and a
    /// master-switchboard freeze (the old section-pass placeholder).
    fn with_removed_ops(mut cfg: OsConfig) -> OsConfig {
        let id = REMOVED_OPS_ROLE.to_string();
        cfg.routing.agents.insert(id.clone(), trig(&[REMOVED_OPS_ROLE, "infra", "infrastructure"], &["droplet", "docker", "n8n", "server status", "grafana"]));
        cfg.anythingllm.workspaces.insert(id.clone(), id.clone());
        for m in cfg.mcps.iter_mut() {
            match m.id.as_str() {
                "maps" => m.agents = Some(vec![id.clone()]),
                "time" => m.agents = Some(vec!["general".into(), id.clone()]),
                _ => {}
            }
        }
        cfg.skills.grants.insert("daily-standup".into(), vec![id.clone()]);
        cfg.skills.grants.insert("impeccable".into(), vec!["designer".into(), id.clone()]);
        cfg.switchboard.frozen_agents.push(id);
        cfg
    }

    #[test]
    fn the_removed_infrastructure_agent_leaves_the_config_and_tony_takes_its_work() {
        use super::super::routing::{resolve, RouteKind};
        let mut cfg = with_removed_ops(OsConfig::default());
        assert!(carries_removed_ops(&cfg));
        // apply_migrations leaves a config that still carries it to the backed-up path.
        apply_migrations(&mut cfg);
        assert!(carries_removed_ops(&cfg) && !cfg.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED));
        remove_ops_agent(&mut cfg);
        assert!(!carries_removed_ops(&cfg));
        assert!(cfg.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED));
        // Its topics are Tony's (once each), Nic's own one too; the other rows are untouched.
        let d = OsConfig::default();
        for t in ["droplet", "docker", "n8n", "server status", "grafana"] {
            assert_eq!(cfg.routing.agents["general"].domains.iter().filter(|x| *x == t).count(), 1, "{t}");
        }
        assert!(cfg.routing.agents.iter().all(|(r, t)| r == "general" || d.routing.agents.get(r) == Some(t)));
        for line in ["is the droplet healthy", "restart the n8n docker container", "check grafana"] {
            let r = resolve(line, &cfg);
            assert_eq!((r.role.as_deref(), r.kind), (Some("general"), RouteKind::Own), "{line}");
        }
        // Maps passes to Tony (never an empty list, which means everyone); a shared grant drops it.
        let grants = |id: &str| cfg.mcps.iter().find(|m| m.id == id).unwrap().agents.clone().unwrap();
        assert_eq!(grants("maps"), ["general"]);
        assert_eq!(grants("time"), ["general"]);
        // Its own skill goes, a shared one keeps its other agent, its freeze goes; Booking's stays.
        assert!(!cfg.skills.grants.contains_key("daily-standup"));
        assert_eq!(cfg.skills.grants["impeccable"], ["designer"]);
        assert_eq!(cfg.switchboard.frozen_agents, ["booking", "librarian"]);
        assert_eq!(cfg.anythingllm.workspaces, d.anythingllm.workspaces);
        // Tony's roster sentence no longer counts it.
        assert!(!super::super::agents::sub_agent_roster(&cfg).iter().any(|r| is_removed_ops(r)));
        // Once: a role Nic adds under that id later is left alone.
        cfg.routing.agents.insert(REMOVED_OPS_ROLE.into(), trig(&["infra"], &[]));
        apply_migrations(&mut cfg);
        assert!(cfg.routing.agents.contains_key(REMOVED_OPS_ROLE));
        // A config that never had it just records the migration.
        let mut fresh = OsConfig::default();
        apply_migrations(&mut fresh);
        assert!(fresh.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED) && !carries_removed_ops(&fresh));
    }

    #[test]
    fn the_removal_backs_up_os_json_first_and_runs_once() {
        // `load_or_init` seeds the global mic flag: share the mic tests' lock.
        let _mic = super::super::voice::mic_gate_tests::lock();
        let root = tmp("ops-removed");
        let (dir, repo) = (root.join("cfg"), root.join("repo"));
        std::fs::create_dir_all(&dir).unwrap();
        let mut before = with_removed_ops(OsConfig::default());
        before.migrations = vec![MIGRATE_WHATSAPP_READ_ONLY.into(), MIGRATE_SELF_ROUTING.into(), MIGRATE_VAULT_CADENCE.into(), MIGRATE_BIZOPS_SPLIT.into()];
        let saved = serde_json::to_string_pretty(&before).unwrap();
        std::fs::write(dir.join("os.json"), &saved).unwrap();
        let os = OsState::default();
        os.load_or_init(&dir, &repo);
        let backups = || -> Vec<PathBuf> { std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.file_name().unwrap().to_string_lossy().ends_with(&format!("-{OPS_REMOVED_TAG}"))).collect() };
        let b = backups();
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!(std::fs::read_to_string(&b[0]).unwrap(), saved, "the backup is the file exactly as it was");
        assert!(!carries_removed_ops(&os.snapshot()));
        let on_disk: OsConfig = serde_json::from_str(&std::fs::read_to_string(dir.join("os.json")).unwrap()).unwrap();
        assert!(!carries_removed_ops(&on_disk) && on_disk.migrations.iter().any(|m| m == MIGRATE_OPS_REMOVED));
        assert_eq!(on_disk.mcps.iter().find(|m| m.id == "maps").unwrap().agents, Some(vec!["general".to_string()]));
        assert!(on_disk.routing.agents["general"].domains.contains(&"droplet".to_string()));
        // A restart: no second backup, nothing re-removed.
        let again = OsState::default();
        again.load_or_init(&dir, &repo);
        assert_eq!(backups().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_migration_freezes_booking_and_the_librarian_once_and_keeps_other_freezes() {
        // A version-0 switchboard that froze nothing (or only another agent): both are added,
        // after what was already frozen, never twice.
        for (before, want) in [(vec![], vec!["booking", "librarian"]), (vec!["designer"], vec!["designer", "booking", "librarian"]), (vec!["librarian"], vec!["librarian", "booking"])] {
            let mut cfg = OsConfig::default();
            cfg.switchboard = SwitchboardConfig { version: 0, frozen_agents: before.iter().map(|s| s.to_string()).collect(), frozen_tools: vec!["instagram".into()] };
            migrate_tool_owners(&mut cfg, |_| false);
            assert_eq!(cfg.switchboard.frozen_agents, want, "{before:?}");
            assert_eq!((cfg.switchboard.version, cfg.switchboard.frozen_tools.clone()), (SWITCHBOARD_VERSION, vec!["instagram".to_string()]));
            migrate_tool_owners(&mut cfg, |_| false);
            assert_eq!(cfg.switchboard.frozen_agents, want, "idempotent: {before:?}");
        }
        // Already migrated (version 1): the saved switchboard is never rewritten, so a Librarian
        // Nic thawed stays thawed.
        let root = tmp("thawed-librarian");
        let path = root.join("os.json");
        let saved = r#"{"osName":"Tony","switchboard":{"version":1,"frozenAgents":["booking"],"frozenTools":[]}}"#;
        let mut cfg: OsConfig = serde_json::from_str(saved).unwrap();
        assert_eq!(migrate_saved_tool_owners(&mut cfg, &path, saved), None);
        assert_eq!(cfg.switchboard.frozen_agents, vec!["booking".to_string()]);
        assert!(std::fs::read_dir(&root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("tool-owners")), "no backup either");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_fresh_install_needs_no_migration_and_seeds_the_skill_grants() {
        let root = tmp("fresh");
        let skills = root.join("skills");
        for n in ["impeccable", "design-taste-frontend", "animation-vocabulary"] {
            std::fs::create_dir_all(skills.join(n)).unwrap();
            std::fs::write(skills.join(n).join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        }
        let mut cfg = OsConfig::default();
        cfg.skills.dir = skills.display().to_string();
        cfg.skills.grants.clear();
        seed_skill_grants(&mut cfg, |n| skills.join(n).join("SKILL.md").exists());
        assert_eq!(cfg.skills.grants.get("impeccable"), Some(&vec!["designer".to_string()]));
        assert_eq!(cfg.skills.grants.get("design-taste-frontend"), Some(&vec!["designer".to_string()]));
        assert_eq!(cfg.skills.grants.get("animation-vocabulary"), Some(&vec!["director".to_string()]));
        assert!(!cfg.skills.grants.values().any(|a| agent_matches(a, "tony")));
        // Seeding again adds nothing; a missing skill is never granted.
        let before = cfg.skills.grants.clone();
        seed_skill_grants(&mut cfg, |_| true);
        assert_eq!(cfg.skills.grants, before);
        // No saved file: nothing to migrate and no backup.
        let mut fresh = OsConfig::default();
        assert_eq!(migrate_saved_tool_owners(&mut fresh, &root.join("os.json"), &serde_json::to_string(&OsConfig::default()).unwrap()), None);
        assert!(std::fs::read_dir(&root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("tool-owners")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_backup_no_migration() {
        let root = tmp("nobackup");
        // The backup's folder doesn't exist: the migration is skipped and stays due.
        let missing = root.join("gone").join("os.json");
        let mut cfg: OsConfig = serde_json::from_str(r#"{"osName":"Tony"}"#).unwrap();
        assert_eq!(migrate_saved_tool_owners(&mut cfg, &missing, r#"{"osName":"Tony"}"#), None);
        assert_eq!(cfg.switchboard.version, 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
