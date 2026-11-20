//! Tony modes (Phase 2 Part C): a small rule set swapped into Tony's system prompt on his next
//! turn. No extra model, no restart, zero VRAM: a mode is runtime state plus prompt text.
//!
//! - `modes.json` (beside os.json, ~3 KB) holds the custom modes and the active id. The six
//!   presets (`BUILTIN_IDS`) are re-seeded from code on every load, so they always mean the same
//!   thing (D12); a preset can be duplicated, never edited or deleted.
//! - `mode_block` is the deterministic prompt block (curiosity dial, verbosity, dispatch policy,
//!   the mode's own notes). It is appended to Tony's own turns only (never a sub-agent or Booking).
//! - `dispatch_allowed` is the pure policy gate every pipeline build passes (`task_create`,
//!   `capture_task`, `task_from_idea`, the inbox `task`): `surface_only` queues nothing,
//!   `auto` (skipping the spoken Tier-3 offer) is honoured only under `auto_dispatch`.
//! - `tts_interrupt_level` maps onto `feedback.sensitivity` (silent 0 · milestones_only 1 ·
//!   full 2); a manual narration change is a temporary override (cleared by a switch or reset).
//! - Overrides (curiosity / dispatch / verbosity / feedback) live in memory only (D18).
//!
//! No prompt text here may contain the format word that flips `dispatch::skip_agentic_os`, the
//! thinking switch, or the novelty mode's name (enforced by `validate_mode` and the tests).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use super::os_core::OsState;

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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ModesFile {
    #[serde(default = "file_version")]
    pub version: u32,
    pub active_mode_id: String,
    pub modes: Vec<TonyMode>,
}

fn file_version() -> u32 {
    1
}

impl Default for ModesFile {
    fn default() -> Self {
        Self { version: 1, active_mode_id: DEFAULT_MODE_ID.into(), modes: presets() }
    }
}

/// The presets, in switcher order. Read-only (D12); `is_preset` is derived from this list.
pub const BUILTIN_IDS: [&str; 6] = ["surface", "brainstorm", "builder", "executive", "coach", "gabagool"];
/// The first-launch mode: `ask_before_dispatch` is today's Tier-3 behaviour (D11).
pub const DEFAULT_MODE_ID: &str = "brainstorm";
/// The novelty overlay (D19): toggled by the cue system, never the active work mode.
pub const NOVELTY_ID: &str = "gabagool";

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
    }
}

pub const BRAINSTORM_NOTES: &str = "Refine raw ideas with sharp follow-ups; when one firms up, offer to park it in the Brainstorm list or hand it off.";
pub const COACH_NOTES: &str = "Be a grounded, high-energy accountability partner: name the next concrete step and push Nic to take it.";

/// The six presets (spec §2), in `BUILTIN_IDS` order.
pub fn presets() -> Vec<TonyMode> {
    use Curiosity::*;
    use DispatchPolicy::*;
    use TtsInterrupt::*;
    use Verbosity::*;
    vec![
        preset("surface", "Surface / Solo", "message-circle", Medium, Balanced, SurfaceOnly, Silent, "", false),
        preset("brainstorm", "Brainstorming", "lightbulb", High, Conversational, AskBeforeDispatch, MilestonesOnly, BRAINSTORM_NOTES, false),
        preset("builder", "Builder", "hammer", Medium, Balanced, AutoDispatch, Full, "", false),
        preset("executive", "Executive", "briefcase", Low, Terse, AskBeforeDispatch, MilestonesOnly, "", false),
        preset("coach", "Motivation / Coach", "flame", Medium, Balanced, SurfaceOnly, MilestonesOnly, COACH_NOTES, false),
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
/// The whole block's cap (the mode's own notes are clipped to fit).
pub const MODE_BLOCK_MAX: usize = 700;
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
    if o.dispatch.is_some() {
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
        dispatch: o.dispatch.unwrap_or(m.agent_dispatch_policy),
        feedback_level: o.feedback.map(|f| f.min(3)).unwrap_or_else(|| feedback_for(m.tts_interrupt_level)),
        prompt_modifier: m.prompt_modifier,
        is_novelty: m.is_novelty,
        overridden,
    }
}

/// Tony's MODE block (appended after the persona, before `/no_think`). Deterministic: the same
/// effective state always gives the same text; empty lines are skipped; at most 700 chars (the
/// mode's notes are clipped to fit). A novelty mode injects nothing.
pub fn mode_block(e: &Effective) -> String {
    if e.is_novelty {
        return String::new();
    }
    let mut s = format!("\n\nMODE: {}. These MODE rules override the STYLE length rule.", one_line(&e.name));
    for line in [curiosity_line(e.curiosity), verbosity_line(e.verbosity), dispatch_line(e.dispatch)] {
        if !line.is_empty() {
            s.push('\n');
            s.push_str(line);
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

    /// Re-seed the presets from code (D12), keep valid custom modes, repair the active id.
    pub fn normalize(mut self) -> ModesFile {
        let custom: Vec<TonyMode> = self.modes.drain(..).filter(|m| !is_builtin(&m.id) && !m.is_novelty && validate_mode(m).is_ok()).collect();
        let mut modes = presets();
        for m in custom {
            if !modes.iter().any(|x| x.id == m.id) {
                modes.push(m);
            }
        }
        let active_ok = modes.iter().any(|m| m.id == self.active_mode_id && !m.is_novelty);
        ModesFile { version: 1, active_mode_id: if active_ok { self.active_mode_id } else { DEFAULT_MODE_ID.into() }, modes }
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
            if p.dispatch.is_some() {
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

    /// The phone mirror's `mode` block (`/api/os/state`).
    pub fn mirror(&self) -> Value {
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

fn emit_changed(app: &tauri::AppHandle, os: &OsState) {
    use tauri::Emitter;
    let _ = app.emit(MODE_CHANGED_EVENT, os.modes.view());
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
