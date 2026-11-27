//! Provider configuration + LLM routing.
//!
//! The webview sends `{messages, priority, provider?, maxSecs?}`; Rust decides
//! WHERE it runs, injects the API key from the keychain, and reports what
//! happened.
//!
//! Chat policy:
//!   * interactive  → walk `policy.chain` in order (default: LM Studio →
//!                    AnythingLLM → Agentic OS → droplet) until one answers
//!   * background   → if the GPU is over threshold, skip local entries
//!   * explicit `provider` → that provider only (used for the verifier)
//!
//! Every endpoint comes from `<app-config>/providers.json`. Settings may switch
//! models, voices, base URLs and the chain at runtime. That is safe because
//! API keys are bound to their provider's host (see secrets.rs): re-pointing
//! a provider can never send its key somewhere new. Spawning the gateway is
//! file-only (see services.rs).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};
use tauri::State;

use super::os_core::{self, OsState};
use super::{secrets, system};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// OpenAI-compatible chat on this machine / LAN (LM Studio, AnythingLLM, llama.cpp, Ollama).
    Local,
    /// OpenAI-compatible chat elsewhere (droplet over NetBird, hosted APIs).
    Cloud,
    /// Agentic OS server.py `/api/chat` (opencode / agy / claude / gemini / llm CLIs).
    AgenticOs,
    /// OpenAI-compatible `/audio/transcriptions` (whisper.cpp server, speaches).
    Stt,
    /// Text-to-speech (Kokoro-FastAPI or Coqui XTTS api-server).
    Tts,
    /// n8n base URL; workflows map names → webhook paths.
    N8n,
    /// Credentials-only integrations (e.g. Google OAuth client). Never called for chat.
    Integration,
}

impl Kind {
    pub fn is_chat(self) -> bool {
        matches!(self, Kind::Local | Kind::Cloud | Kind::AgenticOs)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub base_url: String,
    pub model: String,
    pub needs_key: bool,
    /// TTS voice id (Kokoro "am_michael", XTTS speaker file stem).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    /// STT: "whispercpp" | "openai" (speaches / faster-whisper). TTS: "kokoro" | "xtts".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// STT language code ("en", "fr", …) or None for auto-detect. TTS language for XTTS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// STT (whisper.cpp): folder holding ggml-<variant>.bin for hot model switching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_dir: Option<String>,
    /// TTS: folder for custom voices (mount it into Kokoro / XTTS — see HANDOFF.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voices_dir: Option<String>,
    /// STT: Whisper vocabulary-biasing prompt, sent as the multipart `prompt` field.
    /// `None` = the built-in default (`DEFAULT_STT_PROMPT`); `Some("")` = send none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_prompt: Option<String>,
    /// Added from Settings (removable there). Built-ins are not.
    #[serde(default)]
    pub custom: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// Background work skips local providers when GPU utilisation is above this…
    pub gpu_util_max: f32,
    /// …or VRAM use is above this percentage.
    pub vram_max_pct: f32,
    pub primary_local: String,
    pub fallback_cloud: String,
    /// Ordered failover for chat. Empty = [primaryLocal, fallbackCloud].
    #[serde(default)]
    pub chain: Vec<String>,
    /// Cross-checks mutating plans against the user's words (runs locally by default).
    #[serde(default = "default_verifier")]
    pub verifier: String,
    #[serde(default = "default_stt")]
    pub stt: String,
    #[serde(default = "default_tts")]
    pub tts: String,
    pub local_timeout_secs: u64,
    pub cloud_timeout_secs: u64,
}

fn default_verifier() -> String {
    "verifier".into()
}
fn default_stt() -> String {
    "whisper".into()
}
fn default_tts() -> String {
    "kokoro".into()
}

/// An n8n workflow the orchestrator may call. `mutating: false` workflows
/// (e.g. "calendar-upcoming", "gmail-digest") can be read by widgets without a
/// confirmation; anything else only runs after the human approves.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum WorkflowSpec {
    Path(String),
    Full {
        path: String,
        #[serde(default = "yes")]
        mutating: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

fn yes() -> bool {
    true
}

impl WorkflowSpec {
    pub fn path(&self) -> &str {
        match self {
            WorkflowSpec::Path(p) => p,
            WorkflowSpec::Full { path, .. } => path,
        }
    }
    pub fn mutating(&self) -> bool {
        match self {
            WorkflowSpec::Path(_) => true,
            WorkflowSpec::Full { mutating, .. } => *mutating,
        }
    }
}

/// How the desktop app keeps the Agentic OS gateway (server.py) alive.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    pub url: String,
    pub autostart: bool,
    pub workdir: String,
    pub command: String,
    pub args: Vec<String>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        // At build time this crate lives in "<repo>/command center/src-tauri", so the repo is two up.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent).map(PathBuf::from).unwrap_or_default();
        Self {
            url: "http://127.0.0.1:8080".into(),
            autostart: true,
            workdir: repo.to_string_lossy().into_owned(),
            command: "python".into(),
            args: vec!["server.py".into(), "--port".into(), "8080".into()],
        }
    }
}

/// n8n session telemetry + Google Drive backup. n8n *instances* are simply the
/// providers of kind `n8n` (local Docker + any remote droplets), so they share
/// host-bound keychain storage with everything else.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelinesConfig {
    /// POLL_INTERVAL_SECONDS
    #[serde(default = "default_poll")]
    pub poll_interval_seconds: u64,
    /// GDRIVE_SYNC_WEBHOOK_URL — an n8n webhook whose workflow writes to Google Drive.
    #[serde(default)]
    pub gdrive_sync_webhook_url: String,
    /// GDRIVE_TRACKED_PATHS — folders/files to back up. "@os-config" = this
    /// app's config files (providers.json, permissions.json, gateway config).
    #[serde(default = "default_tracked")]
    pub gdrive_tracked_paths: Vec<String>,
    /// AUTO_SYNC_ENABLED
    #[serde(default)]
    pub auto_sync_enabled: bool,
    #[serde(default = "default_auto_hours")]
    pub auto_sync_hours: f64,
    /// Also sync when the app closes cleanly (only if auto-sync is on).
    #[serde(default = "yes")]
    pub sync_on_exit: bool,
}

fn default_poll() -> u64 {
    15
}
fn default_auto_hours() -> f64 {
    6.0
}
fn default_tracked() -> Vec<String> {
    let repo = GatewayConfig::default().workdir;
    vec![
        Path::new(&repo).join("training_logs").to_string_lossy().into_owned(),
        Path::new(&repo).join("memory").to_string_lossy().into_owned(),
        "@os-config".into(),
    ]
}

impl Default for PipelinesConfig {
    fn default() -> Self {
        Self {
            poll_interval_seconds: default_poll(),
            gdrive_sync_webhook_url: String::new(),
            gdrive_tracked_paths: default_tracked(),
            auto_sync_enabled: false,
            auto_sync_hours: default_auto_hours(),
            sync_on_exit: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub providers: Vec<Provider>,
    pub policy: Policy,
    /// Named n8n workflows: name → webhook path (or {path, mutating, description})
    /// under the `n8n` provider's baseUrl. Only these names can ever be called.
    #[serde(default)]
    pub n8n_workflows: BTreeMap<String, WorkflowSpec>,
    #[serde(default)]
    pub gateway: GatewayConfig,
    #[serde(default)]
    pub pipelines: PipelinesConfig,
    /// Part 3: per-agent TTS voice roster, keyed by role id ("general" = Tony).
    /// Empty by default — nothing here means "use policy.tts" exactly as before.
    #[serde(default)]
    pub agent_voices: BTreeMap<String, AgentVoice>,
    /// The roster's master "All Tony" switch: every agent report speaks in Tony's voice, whatever
    /// each row's `ownVoice` says (the rows keep their settings for when it goes off).
    #[serde(default)]
    pub agent_voices_all_tony: bool,
    /// One-time providers.json migrations already applied (`apply_provider_migrations`), so a
    /// setting the user changes back afterwards is never overwritten again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub migrations: Vec<String>,
}

/// Section 20.3: only Tony auto-speaks; specialists speak their final reports through the
/// queued per-agent report voices (Comms inbox), never their live chatter.
pub(crate) const MIGRATE_AUTOSPEAK_TONY_ONLY: &str = "autospeak-tony-only";

/// Live test 11-27: the Gmail tab names joined the Whisper hint list. A provider whose prompt is
/// the old default word for word gets the new one; an edited or cleared ("" = none) prompt is kept.
pub(crate) const MIGRATE_STT_PROMPT_GMAIL_TABS: &str = "stt-prompt-gmail-tabs";

/// Apply the one-time providers.json migrations. Returns true when anything changed.
pub(crate) fn apply_provider_migrations(cfg: &mut Config) -> bool {
    let mut changed = false;
    if !cfg.migrations.iter().any(|m| m == MIGRATE_AUTOSPEAK_TONY_ONLY) {
        for (role, v) in cfg.agent_voices.iter_mut() {
            if role != "general" && v.auto_speak {
                v.auto_speak = false;
            }
        }
        cfg.migrations.push(MIGRATE_AUTOSPEAK_TONY_ONLY.into());
        changed = true;
    }
    if !cfg.migrations.iter().any(|m| m == MIGRATE_STT_PROMPT_GMAIL_TABS) {
        for p in cfg.providers.iter_mut().filter(|p| p.kind == Kind::Stt) {
            if p.stt_prompt.as_deref().map(str::trim) == Some(PREVIOUS_STT_PROMPT) {
                p.stt_prompt = Some(DEFAULT_STT_PROMPT.to_string());
            }
        }
        cfg.migrations.push(MIGRATE_STT_PROMPT_GMAIL_TABS.into());
        changed = true;
    }
    changed
}

/// Agent ids a voice-roster entry (or any other per-agent config in this
/// file) can key on. Kept local here rather than importing `roles.ts`'s
/// list from the TS side: the roster lives in providers.json, not OsConfig,
/// so it has no Rust-side shared list of its own yet.
pub(crate) const ROLE_IDS: [&str; 7] = ["general", "booking", "prompter", "coder", "designer", "director", "librarian"];

/// `"tony"` is accepted as an alias of `"general"` (ground rule) wherever a
/// role id arrives from the outside (Settings UI, `tts_synthesize`'s `agent`).
pub(crate) fn canon_role(r: &str) -> String {
    let r = r.trim().to_ascii_lowercase();
    if r == "tony" {
        "general".into()
    } else {
        r
    }
}

pub(crate) fn valid_role(r: &str) -> bool {
    ROLE_IDS.contains(&r)
}

/// Part 6: every id that can SPEAK (narration, a roster voice): the routing roles plus the
/// task worker's non-routing speakers. `ROLE_IDS` stays the routing list.
/// `trading` speaks only its own reports (Comms inbox / urgent alerts): it has a roster voice
/// but is never a routing role (arbiter.rs keeps it boxed to the Financer).
pub(crate) const NARRATOR_IDS: [&str; 11] = ["general", "booking", "prompter", "coder", "designer", "director", "librarian", "verifier", "staging", "system", "trading"];

/// A voice-roster key (`agentVoices`, `agent_voice_update`): any `NARRATOR_IDS` entry.
pub(crate) fn valid_narrator(r: &str) -> bool {
    valid_role(r) || NARRATOR_IDS[ROLE_IDS.len()..].contains(&r)
}

/// Part 3: one agent's voice. `engine` is "elevenlabs" or "kokoro" (the two
/// engines this app drives); `voice`/`model` override the matching
/// provider's own `voice`/`model` when set, and fall back to them when not.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentVoice {
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub auto_speak: bool,
    /// "Speak in own voice": an agent report plays in this row's voice (unset = on). Off = Tony's
    /// voice reads the report. Overridden by `agentVoicesAllTony`, and remembered under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_voice: Option<bool>,
}

fn default_voice_engine() -> String {
    "elevenlabs".into()
}

fn p(id: &str, label: &str, kind: Kind, base_url: &str, model: &str, needs_key: bool) -> Provider {
    Provider {
        id: id.into(),
        label: label.into(),
        kind,
        base_url: base_url.into(),
        model: model.into(),
        needs_key,
        voice: None,
        engine: None,
        language: None,
        models_dir: None,
        voices_dir: None,
        stt_prompt: None,
        custom: false,
    }
}

impl Default for Config {
    fn default() -> Self {
        let mut kokoro = p("kokoro", "Kokoro TTS", Kind::Tts, "http://127.0.0.1:8880/v1", "kokoro", false);
        kokoro.voice = Some("am_michael".into());
        kokoro.engine = Some("kokoro".into());
        // ElevenLabs cloud TTS. Key comes from ELEVENLABS_API_KEY / the project .env / keychain
        // (see elevenlabs.rs); the voice is whichever account voice is picked in Settings.
        let mut eleven = p("elevenlabs", "ElevenLabs", Kind::Tts, "https://api.elevenlabs.io/v1", "eleven_v4", false);
        eleven.engine = Some("elevenlabs".into());
        eleven.voice = Some("QhEKgDl6KUJsO1FPiuSD".into());
        let mut whisper = p("whisper", "Whisper STT", Kind::Stt, "http://127.0.0.1:8178/v1", "base.en", false);
        whisper.engine = Some("whispercpp".into());
        whisper.language = Some("en".into());
        Self {
            providers: vec![
                // Heavy lifting: your local (uncensored) model in LM Studio.
                p("lmstudio", "LM Studio", Kind::Local, "http://127.0.0.1:1235/v1", "local-model", false),
                p("anythingllm", "AnythingLLM RAG", Kind::Local, "http://127.0.0.1:3001/api/v1/openai", "my-workspace", true),
                // Reach the droplet over NetBird; replace with its 100.x address.
                p("droplet", "Cloud Droplet", Kind::Cloud, "http://100.64.0.10:8000/v1", "deepseek-r1-distill", true),
                // Zero-cost verifier on LM Studio. Load a DIFFERENT model than the planner
                // for an independent second opinion, then pick it in Settings.
                p("verifier", "Verifier (local LM Studio)", Kind::Local, "http://127.0.0.1:1235/v1", "local-model", false),
                p("agentic-os", "Agentic OS (opencode)", Kind::AgenticOs, "http://127.0.0.1:8080", "opencode", false),
                // whisper.cpp: `whisper-server -m ggml-base.en.bin --port 8178 --inference-path /v1/audio/transcriptions`
                whisper,
                kokoro,
                eleven,
                // Bound to the local Docker container on first run (see n8n_discover).
                p("n8n", "n8n (Docker)", Kind::N8n, "http://127.0.0.1:5678", "-", false),
                p("google", "Google (Gmail + Calendar)", Kind::Integration, "https://oauth2.googleapis.com", "-", true),
                // Section 26: the built-in llama.cpp engine (engine/llama_engine.py, off by default).
                // NOT in policy.chain and never primary: nothing routes to it until Nic switches.
                p("llamacpp", "Built-in engine (llama.cpp)", Kind::Local, "http://127.0.0.1:1238/v1", "qwen/qwen3.5-9b", false),
            ],
            policy: Policy {
                gpu_util_max: 85.0,
                vram_max_pct: 90.0,
                primary_local: "lmstudio".into(),
                fallback_cloud: "droplet".into(),
                chain: vec!["lmstudio".into(), "anythingllm".into(), "agentic-os".into(), "droplet".into()],
                verifier: default_verifier(),
                stt: default_stt(),
                tts: default_tts(),
                local_timeout_secs: 90,
                cloud_timeout_secs: 120,
            },
            n8n_workflows: BTreeMap::new(),
            gateway: GatewayConfig::default(),
            pipelines: PipelinesConfig::default(),
            agent_voices: BTreeMap::new(),
            agent_voices_all_tony: false,
            // A fresh install starts with every migration's outcome already in place.
            migrations: vec![MIGRATE_AUTOSPEAK_TONY_ONLY.into(), MIGRATE_STT_PROMPT_GMAIL_TABS.into()],
        }
    }
}

pub struct DispatchState {
    config: RwLock<Config>,
    path: RwLock<Option<PathBuf>>,
    /// What this process knows about providers.json on disk (`Disk`). `update` re-reads a file
    /// someone else changed since (a hand edit, a script) before saving, so a Settings save never
    /// puts back an old in-memory copy over it. Keys this build doesn't know are not kept, and a
    /// file it can't parse is copied aside before a save replaces it. The write lock is also held
    /// across a whole `update`, so two saves never interleave.
    disk: RwLock<Disk>,
    pub(crate) http: reqwest::Client,
}

/// (modified time, length) of providers.json.
type DiskStamp = (std::time::SystemTime, u64);

#[derive(Default)]
struct Disk {
    /// providers.json's stamp when this process last read or wrote it.
    stamp: Option<DiskStamp>,
    /// providers.json exists but could not be loaded (unreadable, invalid), so memory holds only
    /// the defaults: a save would put them over Nic's whole config. `update` refuses with this
    /// message until the file is fixed (it is then reloaded) or deleted. Never set for a 0-byte
    /// file (nothing to lose: the next save repairs it).
    unloaded: Option<String>,
}

fn disk_stamp(path: &Path) -> Option<DiskStamp> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Copy a providers.json this process could not load to `providers.json.invalid-<ms>` beside it,
/// before anything can replace it. The copy's path, or None when the copy failed.
fn keep_invalid_copy(path: &Path) -> Option<PathBuf> {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let to = path.with_file_name(format!("providers.json.invalid-{ms}"));
    std::fs::copy(path, &to).ok().map(|_| to)
}

/// The refusal `update` gives while providers.json can't be loaded (`Disk::unloaded`).
fn unloaded_note(path: &Path, why: &str, copy: Option<&Path>) -> String {
    let copy = copy.map(|c| format!(" A copy is at {}.", c.display())).unwrap_or_default();
    format!("{} is {why}, so the app is running on defaults and won't save over it. Fix or delete it, then try again.{copy}", path.display())
}

/// Parse providers.json and bring it up to date the way every load does: the hermes label
/// migration, any default provider the file lacks, and an empty chain filled in. `Err` = invalid.
fn parse_providers(text: &str) -> Result<Config, String> {
    // A UTF-8 BOM (Windows PowerShell 5.1 `Set-Content -Encoding UTF8`): serde_json rejects it.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut cfg = serde_json::from_str::<Config>(text).map_err(|e| format!("unreadable ({e})"))?;
    validate(&cfg).map_err(|e| format!("invalid ({e})"))?;
    // The hermes CLI is gone: rewrite the stale "Agentic OS (hermes)" label
    // (and a hermes model) so Settings stops advertising it. Saved by the caller.
    if migrate_hermes(&mut cfg) {
        eprintln!("[dispatch] migrated stale hermes provider label/model");
    }
    if apply_provider_migrations(&mut cfg) {
        eprintln!("[dispatch] applied providers.json migrations: {}", cfg.migrations.join(", "));
    }
    for d in &Config::default().providers {
        if !cfg.providers.iter().any(|p| p.id == d.id) {
            cfg.providers.push(d.clone());
        }
    }
    if cfg.policy.chain.is_empty() {
        cfg.policy.chain = vec![cfg.policy.primary_local.clone(), cfg.policy.fallback_cloud.clone()];
    }
    Ok(cfg)
}

impl Default for DispatchState {
    fn default() -> Self {
        Self {
            config: RwLock::new(Config::default()),
            path: RwLock::new(None),
            disk: RwLock::new(Disk::default()),
            // Long-lived pooled connections: the first TLS handshake to ElevenLabs/Claude costs
            // ~1 s, so keep sockets alive between turns (the TTS warm loop pings every 60 s).
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(4))
                .pool_idle_timeout(Duration::from_secs(300))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .expect("http client"),
        }
    }
}

impl DispatchState {
    /// Load `providers.json`, writing defaults if missing and appending any new
    /// default providers on upgrade. Invalid or unreadable files are reported and
    /// never written over (defaults stay active, saves are refused, a copy is kept)
    /// rather than crashing the app. Only a missing file gets the defaults written.
    pub fn load_or_init(&self, dir: &Path) {
        let path = dir.join("providers.json");
        *self.path.write().unwrap() = Some(path.clone());
        let mut disk = self.disk.write().unwrap();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(None),
            // Not UTF-8 (a UTF-16 `Out-File`), a sharing violation...: there, just not readable.
            Err(e) => Err(Some(format!("unreadable ({e})"))),
        };
        let cfg = match text {
            Ok(text) => {
                disk.stamp = disk_stamp(&path);
                match parse_providers(&text) {
                    Ok(cfg) => cfg,
                    Err(e) => {
                        eprintln!("[dispatch] {} {e} — using defaults", path.display());
                        if !text.is_empty() {
                            disk.unloaded = Some(unloaded_note(&path, &e, keep_invalid_copy(&path).as_deref()));
                        }
                        return;
                    }
                }
            }
            Err(None) => Config::default(),
            Err(Some(e)) => {
                eprintln!("[dispatch] {} {e} — using defaults", path.display());
                disk.stamp = disk_stamp(&path);
                disk.unloaded = Some(unloaded_note(&path, &e, keep_invalid_copy(&path).as_deref()));
                return;
            }
        };
        *self.config.write().unwrap() = cfg;
        match self.write_file() {
            Ok(stamp) => disk.stamp = stamp.or(disk.stamp),
            Err(e) => eprintln!("[dispatch] {e}"),
        }
    }

    pub(crate) fn snapshot(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    /// Apply a change, validate the result, and write providers.json. All-or-nothing.
    ///
    /// When providers.json changed on disk since this process last read or wrote it, it is
    /// re-read first (with the same upgrades a load makes), so the change lands on what is on
    /// disk now rather than on a stale copy: a Settings save in an app started before a hand
    /// edit (B1's switch to faster-whisper, FX1's sttPrompt) no longer reverts that edit.
    /// While providers.json can't be loaded at all (`Disk::unloaded`: memory holds only the
    /// defaults), a save is refused instead of putting the defaults over it.
    pub(crate) fn update(&self, f: impl FnOnce(&mut Config) -> Result<(), String>) -> Result<Config, String> {
        let mut disk = self.disk.write().unwrap();
        self.reload_if_changed(&mut disk);
        if let Some(why) = &disk.unloaded {
            return Err(why.clone());
        }
        let mut next = self.snapshot();
        f(&mut next)?;
        validate(&next)?;
        *self.config.write().unwrap() = next.clone();
        if let Some(stamp) = self.write_file()? {
            disk.stamp = Some(stamp);
        }
        Ok(next)
    }

    /// Re-read providers.json when its stamp differs from the one recorded. A file that can't be
    /// loaded is copied aside (`keep_invalid_copy`) and logged; then memory decides. A loaded
    /// config stays in memory and the save that follows replaces the file; defaults standing in
    /// for an unloadable file (`Disk::unloaded`) never do. A deleted file ends `unloaded`. While
    /// `unloaded`, the file is re-read on every save even unchanged (a read that failed on a
    /// passing sharing violation loads once it is free); it is copied only when it changed.
    fn reload_if_changed(&self, disk: &mut Disk) {
        let Some(path) = self.path.read().unwrap().clone() else { return };
        let now = disk_stamp(&path);
        if now.is_none() {
            if matches!(std::fs::metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
                disk.unloaded = None;
            }
            return;
        }
        let changed = now != disk.stamp;
        if !changed && disk.unloaded.is_none() {
            return;
        }
        match std::fs::read_to_string(&path) {
            // 0 bytes: nothing to keep, the save that follows repairs it.
            Ok(t) if t.is_empty() => disk.unloaded = None,
            read => match read.map_err(|e| format!("unreadable ({e})")).and_then(|t| parse_providers(&t)) {
                Ok(cfg) => {
                    *self.config.write().unwrap() = cfg;
                    disk.unloaded = None;
                    eprintln!("[dispatch] providers.json changed on disk: reloaded before saving");
                }
                Err(e) if changed => {
                    let copy = keep_invalid_copy(&path);
                    eprintln!("[dispatch] providers.json changed on disk but is {e}: copied to {}", copy.as_deref().map_or("(copy failed)".into(), |c| c.display().to_string()));
                    if disk.unloaded.is_some() {
                        disk.unloaded = Some(unloaded_note(&path, &e, copy.as_deref()));
                    }
                }
                // Still the file `unloaded` names (and its copy): nothing new.
                Err(_) => {}
            },
        }
        disk.stamp = now;
    }

    /// Write the in-memory config to providers.json; `Ok(Some(stamp))` = written, `Ok(None)` =
    /// no file (a test state) or the stamp could not be read back.
    fn write_file(&self) -> Result<Option<DiskStamp>, String> {
        let Some(path) = self.path.read().unwrap().clone() else { return Ok(None) };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let json = serde_json::to_string_pretty(&*self.config.read().unwrap()).map_err(|e| e.to_string())?;
        // Atomic (temp + fsync + rename): a plain write truncates first, so a crash or a second
        // app instance mid-write left a 0-byte providers.json and every launch fell back to defaults.
        super::staging::atomic_write(&path, json.as_bytes()).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(disk_stamp(&path))
    }

    pub(crate) fn config_dir(&self) -> Option<PathBuf> {
        self.path.read().unwrap().as_ref().and_then(|p| p.parent().map(PathBuf::from))
    }

    pub(crate) fn provider(&self, id: &str) -> Option<Provider> {
        self.config.read().ok()?.providers.iter().find(|p| p.id == id).cloned()
    }

    /// `host[:port]` of a provider — used to bind keychain entries to a destination.
    pub fn provider_host(&self, id: &str) -> Option<String> {
        let p = self.provider(id)?;
        let u = url::Url::parse(&p.base_url).ok()?;
        Some(match u.port() {
            Some(port) => format!("{}:{port}", u.host_str()?),
            None => u.host_str()?.to_string(),
        })
    }

    /// Bearer key for a provider, if it needs one.
    pub(crate) fn key_for(&self, p: &Provider) -> Result<Option<String>, String> {
        if !p.needs_key {
            return Ok(None);
        }
        secrets::get(self, &p.id).map(Some).ok_or_else(|| format!("no API key stored for {}", p.label))
    }
}

pub(crate) fn valid_url(s: &str) -> bool {
    url::Url::parse(s).map(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some()).unwrap_or(false)
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn validate(cfg: &Config) -> Result<(), String> {
    for p in &cfg.providers {
        if !valid_id(&p.id) {
            return Err(format!("bad provider id '{}'", p.id));
        }
        if !valid_url(&p.base_url) {
            return Err(format!("{}: baseUrl must be http(s)", p.id));
        }
    }
    let kind_of = |id: &str| cfg.providers.iter().find(|p| p.id == id).map(|p| p.kind);
    const EXT: [&str; 4] = ["ext:claude-cli", "ext:claude-api", "ext:gemini-cli", "ext:gemini-api"];
    for id in cfg.policy.chain.iter().chain([&cfg.policy.verifier]) {
        if id == &cfg.policy.verifier && EXT.contains(&id.as_str()) {
            continue;
        }
        if !kind_of(id).is_some_and(Kind::is_chat) {
            return Err(format!("'{id}' is not a chat provider"));
        }
    }
    if kind_of(&cfg.policy.stt).is_some_and(|k| k != Kind::Stt) || kind_of(&cfg.policy.tts).is_some_and(|k| k != Kind::Tts) {
        return Err("policy.stt / policy.tts must name STT / TTS providers".into());
    }
    for (name, wf) in &cfg.n8n_workflows {
        if !valid_id(name) || wf.path().contains("://") || wf.path().contains("..") {
            return Err(format!("bad n8n workflow '{name}'"));
        }
    }
    let pl = &cfg.pipelines;
    if !pl.gdrive_sync_webhook_url.is_empty() && !valid_url(&pl.gdrive_sync_webhook_url) {
        return Err("Drive sync webhook must be an http(s) URL".into());
    }
    if !(5..=3600).contains(&pl.poll_interval_seconds) || !(0.25..=168.0).contains(&pl.auto_sync_hours) || pl.gdrive_tracked_paths.len() > 32 {
        return Err("poll 5–3600 s, auto-sync 0.25–168 h, at most 32 tracked paths".into());
    }
    for (role, v) in &cfg.agent_voices {
        if !valid_narrator(role) {
            return Err(format!("agentVoices: unknown role '{role}'"));
        }
        if v.engine != "elevenlabs" && v.engine != "kokoro" {
            return Err(format!("agentVoices.{role}: engine must be 'elevenlabs' or 'kokoro'"));
        }
        if v.voice.as_ref().is_some_and(|s| s.chars().count() > 120) || v.model.as_ref().is_some_and(|s| s.chars().count() > 64) {
            return Err(format!("agentVoices.{role}: voice/model too long"));
        }
    }
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    #[serde(flatten)]
    provider: Provider,
    has_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersView {
    providers: Vec<ProviderInfo>,
    policy: Policy,
    /// Part 3: the voice roster, by role id.
    agent_voices: BTreeMap<String, AgentVoice>,
    /// The roster's master "All Tony" switch.
    agent_voices_all_tony: bool,
}

fn view(state: &DispatchState, cfg: Config) -> ProvidersView {
    let agent_voices = cfg.agent_voices.clone();
    let agent_voices_all_tony = cfg.agent_voices_all_tony;
    ProvidersView {
        providers: cfg
            .providers
            .into_iter()
            .map(|mut p| {
                let has_key = p.needs_key && secrets::get(state, &p.id).is_some();
                // Settings shows the prompt actually in effect (the default until edited).
                if p.kind == Kind::Stt && p.stt_prompt.is_none() {
                    p.stt_prompt = Some(DEFAULT_STT_PROMPT.to_string());
                }
                ProviderInfo { provider: p, has_key }
            })
            .collect(),
        policy: cfg.policy,
        agent_voices,
        agent_voices_all_tony,
    }
}

#[tauri::command]
pub fn providers_list(state: State<'_, DispatchState>) -> ProvidersView {
    view(&state, state.snapshot())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPatch {
    id: String,
    label: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    language: Option<String>,
    engine: Option<String>,
    models_dir: Option<String>,
    voices_dir: Option<String>,
    stt_prompt: Option<String>,
}

/// Whisper vocabulary bias (Phase 2 §1). Natural speech on purpose, not a comma list:
/// Whisper treats the prompt as preceding transcript, so it biases spelling best this way.
/// "Take it easy." (P5: the hold / stand-down family) stays its own sentence, never right after
/// "Tony"/"Hey", so a real 4-word "Tony, take it easy" can't match a prompt run in `echoes_prompt`.
/// "Nic" is in it so Whisper stops writing "Nick", and the Gmail tab names so it stops hearing
/// "promotions" as "permissions" (live test 11-27); it must equal language_hub_api.DEFAULT_STT_PROMPT
/// and stt/bench/bench.py PROMPT (tests/test_language_hub.py pins all three).
pub const DEFAULT_STT_PROMPT: &str = "Tony, Nic, Gabagool mode. Take it easy. Cut it. Whoa. Madone, aspetta. Prompter, Designer, Coder, Booking Desk and Librarian. Bilmuri, Erra. WhatsApp, Gmail, Spotify, Tauri, Kokoro, Serena, checkpoint. Inbox: Primary tab, Promotions tab, Social tab, Updates tab, Forums tab.";

/// The default before the Gmail tab names (11-26). An STT provider still holding exactly this text
/// (Settings saved the default verbatim, never edited) is moved to [`DEFAULT_STT_PROMPT`] once.
pub(crate) const PREVIOUS_STT_PROMPT: &str = "Tony, Nic, Gabagool mode. Take it easy. Cut it. Whoa. Madone, aspetta. Prompter, Designer, Coder, Booking Desk and Librarian. Bilmuri, Erra. WhatsApp, Gmail, Spotify, Tauri, Kokoro, Serena, checkpoint.";

/// Switch model / voice / URL etc. for one provider (Settings dropdowns).
#[tauri::command]
pub fn providers_update(state: State<'_, DispatchState>, patch: ProviderPatch) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        let p = cfg.providers.iter_mut().find(|p| p.id == patch.id).ok_or("unknown provider")?;
        let short = |s: String, n: usize| s.trim().chars().take(n).collect::<String>();
        if let Some(v) = patch.label {
            p.label = short(v, 60);
        }
        if let Some(v) = patch.base_url {
            p.base_url = v.trim().trim_end_matches('/').to_string();
        }
        if let Some(v) = patch.model {
            p.model = short(v, 200);
        }
        if let Some(v) = patch.voice {
            p.voice = Some(short(v, 120)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.language {
            p.language = Some(short(v, 12)).filter(|s| !s.is_empty() && s != "auto");
        }
        if let Some(v) = patch.engine {
            p.engine = Some(short(v, 24)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.models_dir {
            p.models_dir = Some(short(v, 400)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.voices_dir {
            p.voices_dir = Some(short(v, 400)).filter(|s| !s.is_empty());
        }
        if let Some(v) = patch.stt_prompt {
            // Kept as Some("") when cleared: an empty prompt means "send none", not "use the default".
            p.stt_prompt = Some(short(v, 800));
        }
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVoicePatch {
    engine: Option<String>,
    voice: Option<String>,
    model: Option<String>,
    auto_speak: Option<bool>,
    #[serde(default)]
    own_voice: Option<bool>,
}

/// Pure merge of a patch into one roster entry, kept separate from the
/// command below so it is unit-testable without a live `DispatchState`.
pub(crate) fn apply_agent_voice_patch(entry: &mut AgentVoice, patch: AgentVoicePatch) -> Result<(), String> {
    if let Some(v) = patch.engine {
        let v = v.trim().to_ascii_lowercase();
        if v != "elevenlabs" && v != "kokoro" {
            return Err("engine must be 'elevenlabs' or 'kokoro'".into());
        }
        entry.engine = v;
    }
    if let Some(v) = patch.voice {
        entry.voice = Some(v.trim().chars().take(120).collect::<String>()).filter(|s| !s.is_empty());
    }
    if let Some(v) = patch.model {
        entry.model = Some(v.trim().chars().take(64).collect::<String>()).filter(|s| !s.is_empty());
    }
    if let Some(v) = patch.auto_speak {
        entry.auto_speak = v;
    }
    if let Some(v) = patch.own_voice {
        // On is the default: store only the exception, so an untouched row stays as it was.
        entry.own_voice = (!v).then_some(false);
    }
    Ok(())
}

/// Settings → Voice: edit one agent's roster row ("tony" accepted as an
/// alias of "general"). A role with no entry yet starts from the app's
/// default engine (ElevenLabs) before the patch is applied.
#[tauri::command]
pub fn agent_voice_update(state: State<'_, DispatchState>, role: String, patch: AgentVoicePatch) -> Result<ProvidersView, String> {
    let role = canon_role(&role);
    if !valid_narrator(&role) {
        return Err(format!("unknown agent role '{role}'"));
    }
    let cfg = state.update(|cfg| {
        let entry = cfg.agent_voices.entry(role.clone()).or_insert_with(|| AgentVoice { engine: default_voice_engine(), voice: None, model: None, auto_speak: false, own_voice: None });
        apply_agent_voice_patch(entry, patch)
    })?;
    Ok(view(&state, cfg))
}

/// Settings → Voice: the roster's master "All Tony" switch (every agent report in Tony's voice).
/// The per-agent `ownVoice` switches are left untouched, so turning it off restores them.
#[tauri::command]
pub fn agent_voices_all_tony(state: State<'_, DispatchState>, on: bool) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        cfg.agent_voices_all_tony = on;
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProvider {
    id: String,
    label: String,
    kind: Kind,
    base_url: String,
    model: String,
    needs_key: bool,
}

/// Add a custom chat endpoint (e.g. Ollama, llama.cpp, vLLM on the LAN).
#[tauri::command]
pub fn provider_add(state: State<'_, DispatchState>, provider: NewProvider) -> Result<ProvidersView, String> {
    if !provider.kind.is_chat() {
        return Err("custom providers must be chat endpoints".into());
    }
    let cfg = state.update(|cfg| {
        if cfg.providers.iter().any(|p| p.id == provider.id) {
            return Err("that id already exists".into());
        }
        let mut np = p(&provider.id, &provider.label, provider.kind, provider.base_url.trim_end_matches('/'), &provider.model, provider.needs_key);
        np.custom = true;
        cfg.providers.push(np);
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[tauri::command]
pub fn provider_remove(state: State<'_, DispatchState>, id: String) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        let idx = cfg.providers.iter().position(|p| p.id == id).ok_or("unknown provider")?;
        if !cfg.providers[idx].custom {
            return Err("built-in providers can't be removed".into());
        }
        cfg.providers.remove(idx);
        cfg.policy.chain.retain(|c| c != &id);
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPatch {
    chain: Option<Vec<String>>,
    verifier: Option<String>,
    stt: Option<String>,
    tts: Option<String>,
    gpu_util_max: Option<f32>,
    vram_max_pct: Option<f32>,
}

/// Orchestrator switcher: reorder the failover chain, pick the verifier, STT and TTS.
#[tauri::command]
pub fn policy_update(state: State<'_, DispatchState>, patch: PolicyPatch) -> Result<ProvidersView, String> {
    let cfg = state.update(|cfg| {
        if let Some(chain) = patch.chain {
            if chain.is_empty() || chain.len() > 8 {
                return Err("chain needs 1–8 providers".into());
            }
            cfg.policy.primary_local = chain[0].clone();
            cfg.policy.chain = chain;
        }
        if let Some(v) = patch.verifier {
            cfg.policy.verifier = v;
        }
        if let Some(v) = patch.stt {
            cfg.policy.stt = v;
        }
        if let Some(v) = patch.tts {
            cfg.policy.tts = v;
        }
        if let Some(v) = patch.gpu_util_max {
            cfg.policy.gpu_util_max = v.clamp(10.0, 100.0);
        }
        if let Some(v) = patch.vram_max_pct {
            cfg.policy.vram_max_pct = v.clamp(10.0, 100.0);
        }
        Ok(())
    })?;
    Ok(view(&state, cfg))
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ChatMessage {
    pub(crate) role: String,
    pub(crate) content: String,
}

impl ChatMessage {
    pub(crate) fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into() }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Interactive,
    Background,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    messages: Vec<ChatMessage>,
    priority: Priority,
    provider: Option<String>,
    /// Per-request cap (e.g. the planner wants an answer in ~12 s or falls back).
    max_secs: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub(crate) provider_id: String,
    pub(crate) content: String,
    pub(crate) fell_back: bool,
    pub(crate) reason: String,
    pub(crate) latency_ms: u128,
    /// The prompt left this machine through the privacy diffuser.
    pub(crate) redacted: bool,
    /// Tokens/s of a streamed reply (System Map trace only; never serialized).
    #[serde(skip)]
    pub(crate) tps: Option<f64>,
}

#[tauri::command]
pub async fn dispatch_chat(state: State<'_, DispatchState>, os: State<'_, OsState>, req: DispatchRequest) -> Result<DispatchResult, String> {
    run_chat(&state, &os, req.messages, req.priority, req.provider, req.max_secs).await
}

/// The chat chain, shared by `dispatch_chat`, the OS orchestrator and memory
/// condensation. Applies compute mode (local / hybrid / cloud), the droplet
/// switch, the kill switch, and the privacy diffuser for anything remote.
pub(crate) async fn run_chat(
    state: &DispatchState,
    os: &OsState,
    messages: Vec<ChatMessage>,
    priority: Priority,
    provider: Option<String>,
    max_secs: Option<u64>,
) -> Result<DispatchResult, String> {
    if messages.is_empty() || messages.len() > 64 {
        return Err("1–64 messages required".into());
    }
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let find = |id: &str| cfg.providers.iter().find(|p| p.id == id && p.kind.is_chat()).cloned();

    // External verifier / overseer engines ("ext:claude-cli" …).
    if let Some(id) = &provider {
        let id = if id == "verifier" { cfg.policy.verifier.as_str() } else { id.as_str() };
        if let Some(engine) = id.strip_prefix("ext:") {
            let started = Instant::now();
            let (content, redacted) = super::agents::external_chat(state, os, engine, &messages, max_secs.unwrap_or(120)).await?;
            return Ok(DispatchResult {
                provider_id: format!("ext:{engine}"),
                content,
                fell_back: false,
                reason: "external engine".into(),
                latency_ms: started.elapsed().as_millis(),
                redacted,
                tps: None,
            });
        }
    }

    let chars: usize = messages.iter().map(|m| m.content.len()).sum();
    // The Agentic OS gateway forwards only the last user message: a planner / router /
    // verifier call would lose its system prompt and come back as prose, not JSON.
    let skip_gateway = skip_agentic_os(&messages, max_secs);
    let (plan, mut reason): (Vec<Provider>, String) = if let Some(id) = &provider {
        // "verifier" is an alias for whatever the policy names.
        let id = if id == "verifier" { cfg.policy.verifier.as_str() } else { id.as_str() };
        let p = find(id).ok_or("unknown chat provider")?;
        let (shaped, notes) = os_core::shape_chain(&osc, vec![p], None, chars, true);
        if shaped.is_empty() {
            return Err(format!("{id} is blocked: {}", notes.join(", ")));
        }
        (shaped, format!("pinned to {id}"))
    } else {
        let chain: Vec<Provider> = cfg.policy.chain.iter().filter_map(|id| find(id)).collect();
        let busy = if priority == Priority::Background { gpu_busy(&cfg.policy).await } else { None };
        let chain: Vec<Provider> = match &busy {
            Some(_) if chain.iter().any(|p| p.kind != Kind::Local) => chain.into_iter().filter(|p| p.kind != Kind::Local).collect(),
            _ => chain,
        };
        // Interactive turns (Tony's chat) never auto-overflow; background work may.
        let (mut shaped, notes) = if priority == Priority::Interactive {
            os_core::shape_tony_turn(&osc, chain)
        } else {
            let vram = if osc.compute.mode == os_core::ComputeMode::Hybrid { os_core::vram_pct().await } else { None };
            os_core::shape_chain(&osc, chain, vram, chars, false)
        };
        let mut r = busy.map(|w| format!("background + {w} → off-GPU")).unwrap_or_else(|| "chain".into());
        if !notes.is_empty() {
            r = format!("{r} · {}", notes.join(", "));
        }
        if skip_gateway && shaped.iter().any(|p| p.kind == Kind::AgenticOs) {
            shaped.retain(|p| p.kind != Kind::AgenticOs);
            r = format!("{r} · agentic-os skipped (system prompt + JSON)");
        }
        (shaped, r)
    };
    if plan.is_empty() {
        return Err(format!("no reachable providers — {reason}"));
    }

    let mut errors = Vec::new();
    for (i, p) in plan.iter().enumerate() {
        let started = Instant::now();
        let diffuse = os_core::is_remote(p) && osc.privacy.diffuser;
        let mut redactor = super::privacy::Redactor::default();
        let outbound: Vec<ChatMessage> = if diffuse {
            messages.iter().map(|m| ChatMessage::new(&m.role, redactor.redact(&m.content, &osc.privacy.sensitive_terms))).collect()
        } else {
            messages.clone()
        };
        if diffuse {
            os.record_redaction(&p.id, serde_json::to_value(&outbound).unwrap_or_default(), redactor.replacements.clone());
        }
        // Local GPU generations take the baton; Tony (interactive) goes first.
        let _slot = if !os_core::is_remote(p) && p.kind != Kind::AgenticOs {
            Some(os.slot.acquire(&format!("{} · {}", p.id, if priority == Priority::Interactive { "Tony" } else { "background" }), priority == Priority::Interactive, osc.scheduler.tony_priority_pct).await)
        } else {
            None
        };
        // Hot potato: a background generation on the local GPU stops the moment Tony queues; the
        // caller (the worker) parks and re-runs it. Never falls through to the next provider.
        let result = if _slot.is_some() && priority == Priority::Background {
            let preempted = os.slot.background_preempted();
            tokio::select! {
                r = call(state, &osc, &cfg.policy, p, &outbound, max_secs) => r,
                _ = preempted => return Err(format!("{}: Tony took the GPU", super::scheduler::PREEMPTED)),
            }
        } else {
            call(state, &osc, &cfg.policy, p, &outbound, max_secs).await
        };
        match result {
            Ok(content) => {
                if i > 0 {
                    reason = format!("{} → {}", errors.join("; "), p.id);
                }
                return Ok(DispatchResult {
                    provider_id: p.id.clone(),
                    content: if diffuse { redactor.rehydrate(&content) } else { content },
                    fell_back: i > 0,
                    reason,
                    latency_ms: started.elapsed().as_millis(),
                    redacted: diffuse && !redactor.replacements.is_empty(),
                    tps: None,
                });
            }
            Err(e) => errors.push(format!("{}: {e}", p.id)),
        }
    }
    Err(format!("all providers failed — {}", errors.join(" | ")))
}

async fn gpu_busy(policy: &Policy) -> Option<String> {
    let gpu = tauri::async_runtime::spawn_blocking(system::gpu_now).await.ok().flatten()?;
    let vram_pct = gpu.vram_used_mb as f32 / gpu.vram_total_mb.max(1) as f32 * 100.0;
    if gpu.util_pct > policy.gpu_util_max {
        Some(format!("GPU {:.0}%", gpu.util_pct))
    } else if vram_pct > policy.vram_max_pct {
        Some(format!("VRAM {vram_pct:.0}%"))
    } else {
        None
    }
}

async fn call(state: &DispatchState, osc: &os_core::OsConfig, policy: &Policy, p: &Provider, messages: &[ChatMessage], max_secs: Option<u64>) -> Result<String, String> {
    let base_timeout = if p.kind == Kind::Cloud { policy.cloud_timeout_secs } else { policy.local_timeout_secs };
    let timeout = Duration::from_secs(max_secs.map_or(base_timeout, |m| m.clamp(3, base_timeout)));
    let base = p.base_url.trim_end_matches('/');

    if p.kind == Kind::AgenticOs {
        // server.py: POST /api/chat {agent, message} → {status, response: {content}}. It takes the
        // last user message alone: Nic's words (and a delegated reply), never Tony's turn-context
        // block (dashboard, tool data, recall), exactly what it got when that block sat in the
        // system message it drops.
        let last = messages.iter().rev().find(|m| m.role == "user").map(|m| super::agents::strip_turn_context(&m.content).to_string()).unwrap_or_default();
        let mut rb = state.http.post(format!("{base}/api/chat")).timeout(timeout).json(&serde_json::json!({ "agent": p.model, "message": last }));
        if let Some(t) = os_core::mesh_bearer(osc) {
            rb = rb.bearer_auth(t);
        }
        let res = rb.send().await.map_err(short)?;
        let status = res.status();
        if !status.is_success() {
            // 503 = "CLI not installed": an Err so the chain falls through, never a reply.
            let detail = res.json::<serde_json::Value>().await.ok().and_then(|b| b["detail"].as_str().map(str::to_owned));
            return Err(match detail {
                Some(d) => format!("HTTP {} — {}", status.as_u16(), gateway_detail(&d)),
                None => format!("HTTP {status}"),
            });
        }
        let body: serde_json::Value = res.json().await.map_err(short)?;
        let content = body["response"]["content"].as_str().ok_or("malformed gateway reply")?;
        if let Some(e) = gateway_reply_error(content) {
            return Err(e);
        }
        return Ok(content.to_owned());
    }

    // OpenAI-compatible /chat/completions (LM Studio, AnythingLLM, vLLM, Ollama, OpenRouter).
    // AnythingLLM's shim embeds the last user message as its RAG search query: Tony's turn-context
    // block goes back into the system message there, so the search sees Nic's words only.
    let folded;
    let messages = if is_allm_shim(p) {
        folded = super::agents::fold_turn_context(messages);
        &folded[..]
    } else {
        messages
    };
    let mut rb = state
        .http
        .post(format!("{base}/chat/completions"))
        .timeout(timeout)
        .json(&{
            let mut body = serde_json::json!({ "model": p.model, "messages": messages, "stream": false });
            // Reasoning models think for hundreds of tokens before answering (Qwen3.5 on
            // LM Studio/Bionic: 12 s and an empty reply vs 0.8 s). Short-budget internal
            // calls (planner, router, verifier: ≤ 45 s) never think; answers think only
            // with Deep thinking on. AnythingLLM's OpenAI shim doesn't take the field.
            let internal = max_secs.is_some_and(|m| m <= 45);
            if p.kind == Kind::Local && p.id != "anythingllm" && (internal || !osc.compute.deep_thinking) {
                body["reasoning_effort"] = serde_json::json!("none");
            }
            body
        });
    if let Some(key) = state.key_for(p)? {
        rb = rb.bearer_auth(key);
    } else if os_core::is_droplet(p, osc) {
        if let Some(t) = os_core::mesh_bearer(osc) {
            rb = rb.bearer_auth(t);
        }
    }
    let res = rb.send().await.map_err(short)?;
    let body: serde_json::Value = res.error_for_status().map_err(short)?.json().await.map_err(short)?;
    Ok(usable_text_from_message(&body["choices"][0]["message"]).ok_or("malformed completion")?)
}

/// Pull something usable out of a chat completion's `message`, instead of
/// requiring a plain string `content` (Part 6 §3 — "never malformed
/// completion when there's usable text"). Some models answer a router/tool
/// prompt with `content: null` and a `tool_calls` array, or put their whole
/// answer in `reasoning_content` when the server strips `content`. Preferred
/// order: a real string `content`; else the first `tool_calls` entry, mapped
/// to the `{"tool":…, "args":…}` shape the router expects; else
/// `reasoning_content` prose. `None` only when literally nothing is usable.
pub(crate) fn usable_text_from_message(msg: &Value) -> Option<String> {
    if let Some(s) = msg["content"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(strip_think(s));
    }
    if let Some(tc) = msg["tool_calls"].as_array().and_then(|a| a.first()) {
        let f = &tc["function"];
        let name = f["name"].as_str().unwrap_or_default();
        if !name.is_empty() {
            let args = f["arguments"].as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or_else(|| f["arguments"].clone());
            return Some(json!({ "tool": name, "args": args }).to_string());
        }
    }
    if let Some(r) = msg["reasoning_content"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(strip_think(r));
    }
    None
}

/// AnythingLLM's OpenAI-compatible shim (`/api/v1/openai`, the default `anythingllm` provider): it
/// runs its workspace RAG search on the last user message. Pure.
pub(crate) fn is_allm_shim(p: &Provider) -> bool {
    p.id == "anythingllm" || p.base_url.trim_end_matches('/').ends_with("/api/v1/openai")
}

/// Planner / router / verifier calls (short budget) that carry a system prompt expect
/// JSON shaped by that prompt. The Agentic OS gateway drops system prompts, so it is
/// excluded from such chains (a pinned `provider` is left alone).
pub(crate) fn skip_agentic_os(messages: &[ChatMessage], max_secs: Option<u64>) -> bool {
    let system: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "system").collect();
    if system.is_empty() {
        return false;
    }
    let internal = max_secs.is_some_and(|m| m <= 45);
    internal || system.iter().any(|m| m.content.to_ascii_lowercase().contains("json"))
}

/// server.py's error strings that older gateways returned with HTTP 200. They are
/// failures, not answers: returning Err lets the chain fall through.
pub(crate) fn gateway_reply_error(content: &str) -> Option<String> {
    let t = content.trim_start();
    const FAIL: [&str; 4] = ["⚠ Agent", "⚠ Error communicating", "⏱ Agent", "Unknown agent:"];
    FAIL.iter().any(|p| t.starts_with(p)).then(|| gateway_detail(t))
}

/// One short line of a gateway error (no markdown, capped).
fn gateway_detail(s: &str) -> String {
    let line = s.trim().trim_start_matches(['⚠', '⏱']).trim().lines().next().unwrap_or("").to_string();
    line.chars().take(160).collect()
}

/// One-time migration: the hermes CLI was removed. Returns true when anything changed.
pub(crate) fn migrate_hermes(cfg: &mut Config) -> bool {
    let mut changed = false;
    for p in cfg.providers.iter_mut() {
        if p.label.to_lowercase().contains("hermes") {
            p.label = "Agentic OS (opencode)".into();
            changed = true;
        }
        if p.kind == Kind::AgenticOs && p.model.eq_ignore_ascii_case("hermes") {
            p.model = "opencode".into();
            changed = true;
        }
    }
    changed
}

pub(crate) fn strip_think(s: &str) -> String {
    match (s.find("<think>"), s.find("</think>")) {
        (Some(a), Some(b)) if b > a => format!("{}{}", &s[..a], &s[b + 8..]).trim().to_string(),
        _ => s.trim().to_string(),
    }
}

/// Filters `<think>…</think>` out of a token-by-token stream, including an
/// unclosed block (the model was still "thinking" when the turn ended). Feed
/// every delta as it arrives; `feed` returns only the text that is safe to
/// show/speak right now — never think content, and never a partial tag (a
/// `<think>` split across two deltas is held back until it resolves one way
/// or the other). Using this on the LIVE stream, instead of only on the final
/// `content` (as `strip_think` does), is what keeps the webview's `buffered`
/// text identical to the final answer: there is no separate stripping pass
/// afterwards to drift out of sync with the `spokenUpTo` offsets already
/// computed against the raw stream (Part 6 §1's "spokenUpTo offset drift").
pub struct ThinkFilter {
    pending: String,
    in_think: bool,
}

impl ThinkFilter {
    pub fn new() -> Self {
        Self { pending: String::new(), in_think: false }
    }

    pub fn feed(&mut self, delta: &str) -> String {
        self.pending.push_str(delta);
        let mut out = String::new();
        loop {
            if self.in_think {
                if let Some(pos) = self.pending.find("</think>") {
                    self.pending.drain(..pos + "</think>".len());
                    self.in_think = false;
                    continue;
                }
                // Still inside the block: hold everything but a short tail (long
                // enough to still catch "</think>" split across the next feed),
                // so a never-closing block can't grow `pending` without bound.
                let keep = "</think>".len() - 1;
                if self.pending.len() > keep {
                    let cut = floor_char_boundary(&self.pending, self.pending.len() - keep);
                    self.pending.drain(..cut);
                }
                break;
            }
            if let Some(pos) = self.pending.find("<think>") {
                out.push_str(&self.pending[..pos]);
                self.pending.drain(..pos + "<think>".len());
                self.in_think = true;
                continue;
            }
            // No full "<think>" seen yet — hold back only a tail that could still
            // be the START of one, so a stray "<" isn't flushed too eagerly.
            let hold = partial_tag_suffix_len(&self.pending, "<think>");
            let safe_len = self.pending.len() - hold;
            out.push_str(&self.pending[..safe_len]);
            self.pending.drain(..safe_len);
            break;
        }
        out
    }

    /// End of stream: whatever is left, unless it's an unclosed `<think>`
    /// block (dropped — a scratchpad that never closed has nothing to show).
    pub fn finish(self) -> String {
        if self.in_think {
            String::new()
        } else {
            self.pending
        }
    }
}

impl Default for ThinkFilter {
    fn default() -> Self {
        Self::new()
    }
}

fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Longest suffix of `s` that is a (possibly empty) prefix of `tag`, so a
/// partially-arrived tag ("<thi") is never mistaken for literal text.
fn partial_tag_suffix_len(s: &str, tag: &str) -> usize {
    let max = (tag.len() - 1).min(s.len());
    for len in (1..=max).rev() {
        let start = s.len() - len;
        if !s.is_char_boundary(start) {
            continue;
        }
        if s.as_bytes()[start..] == tag.as_bytes()[..len] {
            return len;
        }
    }
    0
}

// ── Model-agnostic JSON / tool-call extraction (Part 6) ─────────────────────
//
// Replaces the naive "first `{` … last `}`" copies that used to live in
// agents.rs and pipeline.rs (and are mirrored in TS `plan.ts` and Python
// `command_center_api.py`). Handles: a model's reasoning scratchpad sitting
// right next to the JSON, a ```json fence, more than one `{…}` span in the
// reply (tries each, outermost first), light formatting slips, and either
// `{"tool":…,"args":…}` or the OpenAI-style `{"name":…,"arguments":…}` shape.

fn strip_think_loose(s: &str) -> String {
    let mut out = s.to_string();
    loop {
        match (out.find("<think>"), out.find("</think>")) {
            (Some(a), Some(b)) if b > a => out = format!("{}{}", &out[..a], &out[b + 8..]),
            (Some(a), None) => {
                out.truncate(a);
                break;
            }
            _ => break,
        }
    }
    out.trim().to_string()
}

fn fenced_json(s: &str) -> Option<&str> {
    let lower = s.to_ascii_lowercase();
    let start = lower.find("```json")? + "```json".len();
    let end = s[start..].find("```")?;
    Some(s[start..start + end].trim())
}

/// `{`-at-`i` to its matching `}`, skipping braces that appear inside a
/// quoted string. `None` if it never balances (truncated output).
fn matching_brace(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut escape = false;
    for (i, &c) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every outermost `{…}` span in `s`, in order. Nested objects inside a
/// matched span are not reported separately (they're already covered by it).
fn balanced_spans(s: &str) -> Vec<(usize, usize)> {
    let bytes = s.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(s, i) {
                spans.push((i, end));
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    spans
}

/// Trailing commas before `}`/`]`, and curly quotes a model sometimes emits
/// instead of straight ones.
fn light_repair(s: &str) -> String {
    static TRAILING_COMMA: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TRAILING_COMMA.get_or_init(|| regex::Regex::new(r",\s*([}\]])").unwrap());
    let s = s.replace(['\u{201c}', '\u{201d}'], "\"").replace(['\u{2018}', '\u{2019}'], "'");
    re.replace_all(&s, "$1").into_owned()
}

/// An OpenAI-style tool call (`{"name":…, "arguments":…}`) is also usable as
/// `{"tool":…, "args":…}` — add the aliases so every existing caller that
/// reads `j["tool"]`/`j["args"]` keeps working without knowing which shape
/// the model used.
fn normalize_tool_shape(mut v: Value) -> Value {
    if v.get("tool").is_none() {
        if let (Some(name), true) = (v.get("name").and_then(Value::as_str).map(str::to_owned), v.get("arguments").is_some()) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("tool".into(), Value::String(name));
                obj.insert("args".into(), obj.get("arguments").cloned().unwrap_or(Value::Null));
            }
        }
    }
    v
}

pub(crate) fn extract_json(text: &str) -> Option<Value> {
    let cleaned = strip_think_loose(text);
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(f) = fenced_json(&cleaned) {
        candidates.push(f);
    }
    let without_tool_tags = cleaned.replace("<tool_call>", "").replace("</tool_call>", "");
    let spans = balanced_spans(&without_tool_tags);
    for (a, b) in &spans {
        candidates.push(&without_tool_tags[*a..=*b]);
    }
    for c in candidates {
        for attempt in [c.to_string(), light_repair(c)] {
            if let Ok(v) = serde_json::from_str::<Value>(&attempt) {
                if v.is_object() {
                    return Some(normalize_tool_shape(v));
                }
            }
        }
    }
    None
}

/// Error text without the URL (keeps internal addresses out of the UI log).
pub(crate) fn short(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "unreachable".into()
    } else if let Some(s) = e.status() {
        format!("HTTP {s}")
    } else {
        e.without_url().to_string()
    }
}


/// Tony's answer with SSE token streaming (`tony-token` events) from the first
/// local OpenAI-compatible backend; falls back to `run_chat` on anything else.
pub(crate) async fn run_chat_streamed(state: &DispatchState, os: &OsState, messages: Vec<ChatMessage>, max_secs: Option<u64>, app: &tauri::AppHandle, stream_id: &str) -> Result<DispatchResult, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    let cfg = state.snapshot();
    let osc = os.snapshot();
    let first = cfg.policy.chain.iter().filter_map(|id| cfg.providers.iter().find(|p| &p.id == id && p.kind.is_chat())).next().cloned();
    // Tony's turn never auto-overflows (section 20-21 safe defaults: `shape_tony_turn`).
    let shaped = first.clone().map(|p| os_core::shape_tony_turn(&osc, vec![p]).0).unwrap_or_default();
    // An AnythingLLM shim (any id: `is_allm_shim`) never streams: only `call` folds Tony's turn
    // context out of the last user message, which the shim embeds as its search query.
    let Some(p) = shaped.into_iter().next().filter(|p| p.kind == Kind::Local && !is_allm_shim(p) && !os_core::is_remote(p)) else {
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    };
    let started = Instant::now();
    let _slot = os.slot.acquire(&format!("{} · Tony (streaming)", p.id), true, osc.scheduler.tony_priority_pct).await;
    let mut body = serde_json::json!({ "model": p.model, "messages": messages, "stream": true });
    if !osc.compute.deep_thinking {
        body["reasoning_effort"] = serde_json::json!("none");
    }
    let mut rb = state.http.post(format!("{}/chat/completions", p.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(max_secs.unwrap_or(cfg.policy.local_timeout_secs))).json(&body);
    if let Some(k) = state.key_for(&p)? {
        rb = rb.bearer_auth(k);
    }
    let res = match rb.send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(_) => {
            drop(_slot);
            return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
        }
    };
    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    // Filtering `<think>…</think>` out of the LIVE stream (not only the final
    // `content`, as before) keeps the webview's `buffered` text exactly equal
    // to what this function returns — see `ThinkFilter`'s doc comment.
    let mut filter = ThinkFilter::new();
    let mut content = String::new();
    // Generation rate for the System Map trace: content deltas between the first and last token.
    let (mut deltas, mut usage_tokens, mut first_at, mut last_at) = (0u32, None::<u64>, None::<Instant>, Instant::now());
    // Did the model actually finish ([DONE] / a finish_reason)? A timeout or a dropped
    // connection mid-body ends the loop too, and must never pass for a complete answer.
    let mut completed = false;
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                completed = true;
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if v["choices"][0]["finish_reason"].as_str().is_some_and(|r| !r.is_empty()) {
                    completed = true;
                }
                if let Some(u) = v["usage"]["completion_tokens"].as_u64() {
                    usage_tokens = Some(u);
                }
                if let Some(d) = v["choices"][0]["delta"]["content"].as_str().filter(|d| !d.is_empty()) {
                    deltas = deltas.saturating_add(1);
                    last_at = Instant::now();
                    first_at.get_or_insert(last_at);
                    let shown = filter.feed(d);
                    if !shown.is_empty() {
                        content.push_str(&shown);
                        let _ = app.emit("tony-token", serde_json::json!({ "streamId": stream_id, "delta": shown }));
                    }
                }
            }
        }
    }
    content.push_str(&filter.finish());
    if content.trim().is_empty() {
        drop(_slot);
        return run_chat(state, os, messages, Priority::Interactive, None, max_secs).await;
    }
    let tps = first_at.and_then(|f| super::trace::tokens_per_sec(deltas, usage_tokens, last_at.duration_since(f).as_secs_f64() * 1000.0));
    let (content, reason) = stream_outcome(content.trim(), completed);
    if !completed {
        let _ = app.emit("tony-token", serde_json::json!({ "streamId": stream_id, "delta": CUT_OFF_MARK }));
    }
    Ok(DispatchResult { provider_id: p.id.clone(), content, fell_back: false, reason, latency_ms: started.elapsed().as_millis(), redacted: false, tps })
}

/// Appended to a streamed answer the model never finished (timeout / dropped connection).
pub const CUT_OFF_MARK: &str = " … [cut off: the model stopped mid-answer]";

/// A streamed answer and its reason: one that never reached [DONE] / a finish_reason is marked
/// as cut off (in the text Nic reads and hears, and in the reason), never passed off as whole. Pure.
pub fn stream_outcome(content: &str, completed: bool) -> (String, String) {
    if completed {
        (content.to_string(), "chain · streamed".into())
    } else {
        (format!("{content}{CUT_OFF_MARK}"), "chain · streamed · cut off".into())
    }
}

#[cfg(test)]
mod part4_tests {
    use super::*;

    /// Regression: a stream that broke mid-answer (90 s timeout, dropped connection) returned
    /// the partial text as a complete answer with normal meta.
    #[test]
    fn a_stream_that_never_finished_is_marked_cut_off() {
        let (c, r) = stream_outcome("The landing page has three", false);
        assert!(c.starts_with("The landing page has three") && c.contains("cut off"), "{c}");
        assert!(r.contains("cut off"));
        let (c, r) = stream_outcome("Done.", true);
        assert_eq!((c.as_str(), r.as_str()), ("Done.", "chain · streamed"));
    }

    /// Section 26: the built-in engine is listed but off the request path. Tony stays on
    /// LM Studio (primary, first in the chain) and no chain or default picks the engine.
    #[test]
    fn builtin_engine_is_listed_but_never_routed() {
        let c = Config::default();
        let e = c.providers.iter().find(|p| p.id == "llamacpp").expect("llamacpp provider");
        assert_eq!(e.base_url, "http://127.0.0.1:1238/v1");
        assert_eq!(c.policy.primary_local, "lmstudio");
        assert_eq!(c.policy.chain.first().map(String::as_str), Some("lmstudio"));
        assert!(!c.policy.chain.iter().any(|id| id == "llamacpp"));
        assert_ne!(c.policy.fallback_cloud, "llamacpp");
        assert_ne!(c.policy.verifier, "llamacpp");
        // the first local provider (language_hub fallback) is still LM Studio
        assert_eq!(c.providers.iter().find(|p| p.kind == Kind::Local).map(|p| p.id.as_str()), Some("lmstudio"));
    }

    #[test]
    fn hermes_label_and_model_migrate() {
        let mut cfg = Config::default();
        let gw = cfg.providers.iter_mut().find(|p| p.id == "agentic-os").unwrap();
        gw.label = "Agentic OS (Hermes)".into();
        gw.model = "hermes".into();
        assert!(migrate_hermes(&mut cfg));
        let gw = cfg.providers.iter().find(|p| p.id == "agentic-os").unwrap();
        assert_eq!(gw.label, "Agentic OS (opencode)");
        assert_eq!(gw.model, "opencode");
        // Idempotent; other providers untouched.
        assert!(!migrate_hermes(&mut cfg));
        assert!(cfg.providers.iter().any(|p| p.label == "LM Studio"));
    }

    #[test]
    fn migrate_keeps_llm_model() {
        let mut cfg = Config::default();
        let gw = cfg.providers.iter_mut().find(|p| p.id == "agentic-os").unwrap();
        gw.label = "Agentic OS (hermes)".into();
        gw.model = "llm".into();
        assert!(migrate_hermes(&mut cfg));
        assert_eq!(cfg.providers.iter().find(|p| p.id == "agentic-os").unwrap().model, "llm");
    }

    #[test]
    fn gateway_error_bodies_are_errors() {
        assert!(gateway_reply_error("⚠ Agent 'hermes' CLI not installed. Install it and try again.").is_some());
        assert!(gateway_reply_error("  ⚠ Agent 'opencode' CLI not installed.").unwrap().starts_with("Agent 'opencode'"));
        assert!(gateway_reply_error("⏱ Agent 'opencode' timed out.\n\nRun …").is_some());
        assert!(gateway_reply_error("⚠ Error communicating with llm: boom").is_some());
        assert!(gateway_reply_error("Unknown agent: x").is_some());
        assert!(gateway_reply_error("Sure — the weather is mild today.").is_none());
        assert!(gateway_reply_error("Note: ⚠ Agent names are case sensitive").is_none());
    }

    #[test]
    fn agentic_os_skipped_for_internal_json_calls() {
        let sys = ChatMessage::new("system", "You are a planner. Reply with ONLY JSON.");
        let user = ChatMessage::new("user", "turn off gabagool mode");
        // planner (system + short budget)
        assert!(skip_agentic_os(&[sys.clone(), user.clone()], Some(15)));
        // system prompt that asks for JSON, no budget
        assert!(skip_agentic_os(&[sys, user.clone()], None));
        // plain chat with a persona, long budget → gateway stays in the chain
        let persona = ChatMessage::new("system", "You are Tony, a calm assistant.");
        assert!(!skip_agentic_os(&[persona.clone(), user.clone()], Some(120)));
        assert!(!skip_agentic_os(&[persona, user.clone()], None));
        // no system prompt → nothing is lost
        assert!(!skip_agentic_os(&[user], Some(15)));
    }
}

#[cfg(test)]
mod part3_tests {
    use super::*;

    #[test]
    fn canon_role_aliases_tony_to_general() {
        assert_eq!(canon_role("tony"), "general");
        assert_eq!(canon_role("Tony"), "general");
        assert_eq!(canon_role("  TONY  "), "general");
        assert_eq!(canon_role("booking"), "booking");
        assert_eq!(canon_role("Booking"), "booking");
    }

    #[test]
    fn narrator_ids_are_the_roles_plus_the_worker_speakers() {
        for r in ROLE_IDS {
            assert!(NARRATOR_IDS.contains(&r) && valid_narrator(r), "{r}");
        }
        for r in ["verifier", "staging", "system", "trading"] {
            assert!(valid_narrator(r) && !valid_role(r), "{r} narrates but never routes");
        }
        assert_eq!(NARRATOR_IDS.len(), ROLE_IDS.len() + 4);
        assert!(!valid_narrator("tony") && !valid_narrator("overseer"));
    }

    #[test]
    fn valid_role_matches_the_seven_roles_only() {
        for r in ROLE_IDS {
            assert!(valid_role(r), "{r} should be a valid role");
        }
        assert!(!valid_role("tony")); // caller must canon_role() first
        assert!(!valid_role("overseer"));
        assert!(!valid_role(""));
    }

    #[test]
    fn agent_voices_pass_validation_when_well_formed() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("general".into(), AgentVoice { engine: "elevenlabs".into(), voice: Some("QhEKgDl6KUJsO1FPiuSD".into()), model: Some("eleven_v4".into()), auto_speak: false, own_voice: None });
        cfg.agent_voices.insert("booking".into(), AgentVoice { engine: "kokoro".into(), voice: Some("am_michael".into()), model: None, auto_speak: true, own_voice: None });
        assert!(validate(&cfg).is_ok());
    }

    #[test]
    fn agent_voices_reject_unknown_role() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("overseer".into(), AgentVoice { engine: "elevenlabs".into(), voice: None, model: None, auto_speak: false, own_voice: None });
        assert!(validate(&cfg).unwrap_err().contains("unknown role"));
    }

    #[test]
    fn agent_voices_reject_bad_engine() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("coder".into(), AgentVoice { engine: "xtts".into(), voice: None, model: None, auto_speak: false, own_voice: None });
        assert!(validate(&cfg).unwrap_err().contains("engine must be"));
    }

    #[test]
    fn agent_voices_reject_oversized_fields() {
        let mut cfg = Config::default();
        cfg.agent_voices.insert("coder".into(), AgentVoice { engine: "kokoro".into(), voice: Some("x".repeat(121)), model: None, auto_speak: false, own_voice: None });
        assert!(validate(&cfg).unwrap_err().contains("too long"));
    }

    #[test]
    fn apply_agent_voice_patch_merges_only_given_fields() {
        let mut entry = AgentVoice { engine: "elevenlabs".into(), voice: Some("old-voice".into()), model: Some("eleven_v4".into()), auto_speak: false, own_voice: None };
        apply_agent_voice_patch(&mut entry, AgentVoicePatch { engine: None, voice: Some("new-voice".into()), model: None, auto_speak: Some(true), own_voice: None }).unwrap();
        assert_eq!(entry.engine, "elevenlabs"); // untouched
        assert_eq!(entry.voice.as_deref(), Some("new-voice"));
        assert_eq!(entry.model.as_deref(), Some("eleven_v4")); // untouched
        assert!(entry.auto_speak);
    }

    #[test]
    fn apply_agent_voice_patch_rejects_bad_engine() {
        let mut entry = AgentVoice { engine: "kokoro".into(), voice: None, model: None, auto_speak: false, own_voice: None };
        let err = apply_agent_voice_patch(&mut entry, AgentVoicePatch { engine: Some("xtts".into()), voice: None, model: None, auto_speak: None, own_voice: None }).unwrap_err();
        assert!(err.contains("elevenlabs"));
        assert_eq!(entry.engine, "kokoro"); // unchanged on error
    }

    #[test]
    fn apply_agent_voice_patch_clearing_voice_with_blank_string() {
        let mut entry = AgentVoice { engine: "kokoro".into(), voice: Some("am_michael".into()), model: None, auto_speak: false, own_voice: None };
        apply_agent_voice_patch(&mut entry, AgentVoicePatch { engine: None, voice: Some("   ".into()), model: None, auto_speak: None, own_voice: None }).unwrap();
        assert_eq!(entry.voice, None); // blank clears it, matching every other trimmed-string patch field in this file
    }
}

#[cfg(test)]
mod part6_tests {
    use super::*;

    // ── ThinkFilter ──────────────────────────────────────────────────────────

    #[test]
    fn think_filter_passes_plain_text_through() {
        let mut f = ThinkFilter::new();
        assert_eq!(f.feed("Hello "), "Hello ");
        assert_eq!(f.feed("there."), "there.");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn think_filter_strips_a_closed_block_in_one_feed() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <think>scratch</think> after."));
        out.push_str(&f.finish());
        assert_eq!(out, "Before  after.");
    }

    #[test]
    fn think_filter_handles_the_open_tag_split_across_feeds() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <thi"));
        out.push_str(&f.feed("nk>scratch</think> after."));
        out.push_str(&f.finish());
        assert_eq!(out, "Before  after.");
    }

    #[test]
    fn think_filter_handles_the_close_tag_split_across_feeds() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <think>scratch</thi"));
        out.push_str(&f.feed("nk> after."));
        out.push_str(&f.finish());
        assert_eq!(out, "Before  after.");
    }

    #[test]
    fn think_filter_drops_an_unclosed_block_at_end_of_stream() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("Before <think>never closes"));
        out.push_str(&f.finish()); // dropped, not shown
        assert_eq!(out, "Before ");
    }

    #[test]
    fn think_filter_handles_multiple_blocks() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        out.push_str(&f.feed("A <think>x</think> B <think>y</think> C"));
        out.push_str(&f.finish());
        assert_eq!(out, "A  B  C");
    }

    #[test]
    fn think_filter_never_flushes_a_stray_bracket_as_a_partial_tag() {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        // "5 < 10" should never be mistaken for the start of "<think>".
        out.push_str(&f.feed("5 < 10, done."));
        out.push_str(&f.finish());
        assert_eq!(out, "5 < 10, done.");
    }

    // ── extract_json ─────────────────────────────────────────────────────────

    #[test]
    fn extract_json_plain_object() {
        assert_eq!(extract_json(r#"{"tool": "x", "args": {}}"#).unwrap()["tool"], "x");
    }

    #[test]
    fn extract_json_strips_a_closed_think_block_first() {
        let v = extract_json(r#"<think>let me think about {"fake": 1}</think>{"tool": "real", "args": {}}"#).unwrap();
        assert_eq!(v["tool"], "real");
    }

    #[test]
    fn extract_json_strips_an_unclosed_think_block() {
        // Nothing usable follows an unclosed scratchpad — None, not a crash.
        assert!(extract_json(r#"<think>still thinking about {"tool":"x"}"#).is_none());
    }

    #[test]
    fn extract_json_prefers_a_json_fence() {
        let text = "Sure, here you go:\n```json\n{\"tool\": \"fenced\", \"args\": {\"a\": 1}}\n```\nHope that helps.";
        assert_eq!(extract_json(text).unwrap()["tool"], "fenced");
    }

    #[test]
    fn extract_json_tries_each_brace_span_when_the_first_is_junk() {
        // The first `{…}` isn't even valid JSON on its own; the second is.
        let text = r#"note: {this isn't json} but then {"tool": "second", "args": {}}"#;
        assert_eq!(extract_json(text).unwrap()["tool"], "second");
    }

    #[test]
    fn extract_json_ignores_braces_inside_string_values() {
        let text = r#"{"tool": "x", "args": {"note": "use { and } in prose"}}"#;
        let v = extract_json(text).unwrap();
        assert_eq!(v["tool"], "x");
        assert_eq!(v["args"]["note"], "use { and } in prose");
    }

    #[test]
    fn extract_json_repairs_trailing_commas_and_smart_quotes() {
        let text = "{\u{201c}tool\u{201d}: \u{201c}x\u{201d}, \u{201c}args\u{201d}: {\u{201c}a\u{201d}: 1,},}";
        let v = extract_json(text).unwrap();
        assert_eq!(v["tool"], "x");
        assert_eq!(v["args"]["a"], 1);
    }

    #[test]
    fn extract_json_accepts_tool_call_tag_wrapper() {
        let text = r#"<tool_call>{"tool": "wrapped", "args": {}}</tool_call>"#;
        assert_eq!(extract_json(text).unwrap()["tool"], "wrapped");
    }

    #[test]
    fn extract_json_normalizes_name_arguments_shape() {
        let text = r#"{"name": "whatsapp.list_messages", "arguments": {"limit": 5}}"#;
        let v = extract_json(text).unwrap();
        assert_eq!(v["tool"], "whatsapp.list_messages");
        assert_eq!(v["args"]["limit"], 5);
        // Original keys stay too — callers reading either shape still work.
        assert_eq!(v["name"], "whatsapp.list_messages");
    }

    #[test]
    fn extract_json_none_when_there_is_no_json_at_all() {
        assert!(extract_json("just a plain sentence, no JSON here").is_none());
    }

    #[test]
    fn extract_json_none_on_empty_input() {
        assert!(extract_json("").is_none());
    }

    // ── usable_text_from_message ─────────────────────────────────────────────

    #[test]
    fn usable_text_prefers_plain_content() {
        let msg = json!({ "content": "hello", "tool_calls": [{"function": {"name": "x", "arguments": "{}"}}] });
        assert_eq!(usable_text_from_message(&msg).unwrap(), "hello");
    }

    #[test]
    fn usable_text_falls_back_to_tool_calls_when_content_is_null() {
        let msg = json!({ "content": Value::Null, "tool_calls": [{"function": {"name": "whatsapp.list_messages", "arguments": "{\"limit\":5}"}}] });
        let v: Value = serde_json::from_str(&usable_text_from_message(&msg).unwrap()).unwrap();
        assert_eq!(v["tool"], "whatsapp.list_messages");
        assert_eq!(v["args"]["limit"], 5);
    }

    #[test]
    fn usable_text_accepts_a_tool_call_with_object_arguments() {
        let msg = json!({ "content": Value::Null, "tool_calls": [{"function": {"name": "time.now", "arguments": {}}}] });
        let v: Value = serde_json::from_str(&usable_text_from_message(&msg).unwrap()).unwrap();
        assert_eq!(v["tool"], "time.now");
    }

    #[test]
    fn usable_text_falls_back_to_reasoning_content() {
        let msg = json!({ "content": Value::Null, "reasoning_content": "<think>x</think>here's my answer" });
        assert_eq!(usable_text_from_message(&msg).unwrap(), "here's my answer");
    }

    #[test]
    fn usable_text_none_when_nothing_is_usable() {
        let msg = json!({ "content": Value::Null });
        assert!(usable_text_from_message(&msg).is_none());
    }
}

#[cfg(test)]
mod persist_tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aos-providers-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn persist_writes_whole_file_and_leaves_no_temp() {
        let d = dir();
        DispatchState::default().load_or_init(&d);
        let text = std::fs::read_to_string(d.join("providers.json")).unwrap();
        assert!(serde_json::from_str::<Config>(&text).is_ok());
        let stray: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name() != "providers.json").collect();
        assert!(stray.is_empty(), "temp files left: {stray:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_providers_file_is_not_overwritten_with_defaults() {
        let d = dir();
        std::fs::write(d.join("providers.json"), "").unwrap();
        let st = DispatchState::default();
        st.load_or_init(&d);
        assert_eq!(std::fs::metadata(d.join("providers.json")).unwrap().len(), 0);
        // Nothing to lose in 0 bytes: the next save repairs it, and no copy is kept.
        st.update(|c| {
            c.policy.local_timeout_secs = 45;
            Ok(())
        })
        .unwrap();
        assert!(serde_json::from_str::<Config>(&std::fs::read_to_string(d.join("providers.json")).unwrap()).is_ok());
        assert!(std::fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with("providers.json.invalid-")));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// providers.json as someone outside this process left it: policy.stt switched to a custom
    /// faster-whisper provider (B1's 09:49 switch, made while the app was running).
    fn edited_on_disk(d: &Path) {
        let mut cfg = Config::default();
        let mut fw = cfg.providers.iter().find(|p| p.id == "whisper").expect("built-in whisper").clone();
        fw.id = "faster-whisper".into();
        fw.label = "faster-whisper (GPU)".into();
        fw.base_url = "http://127.0.0.1:8177/v1".into();
        fw.model = "large-v3-turbo".into();
        fw.engine = Some("fasterwhisper".into());
        fw.custom = true;
        fw.stt_prompt = Some("Tony, Nic.".into());
        cfg.providers.push(fw);
        cfg.policy.stt = "faster-whisper".into();
        std::fs::write(d.join("providers.json"), serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
    }

    fn on_disk(d: &Path) -> Config {
        serde_json::from_str(&std::fs::read_to_string(d.join("providers.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_save_never_puts_a_stale_copy_over_an_outside_edit() {
        let d = dir();
        let st = DispatchState::default();
        st.load_or_init(&d); // the app starts: defaults (policy.stt "whisper") in memory and on disk
        assert_eq!(st.snapshot().policy.stt, "whisper");
        edited_on_disk(&d);
        st.update(|c| {
            c.policy.local_timeout_secs = 45; // any Settings save
            Ok(())
        })
        .unwrap();
        let saved = on_disk(&d);
        assert_eq!(saved.policy.stt, "faster-whisper", "the outside switch survives the save");
        let fw = saved.providers.iter().find(|p| p.id == "faster-whisper").expect("the faster-whisper provider is kept");
        assert_eq!((fw.engine.as_deref(), fw.stt_prompt.as_deref()), (Some("fasterwhisper"), Some("Tony, Nic.")));
        assert_eq!(saved.policy.local_timeout_secs, 45, "and the save itself landed");
        assert_eq!(st.snapshot().policy.stt, "faster-whisper", "memory follows the file");
        // Defaults the file lacked are merged in as a load would.
        assert!(Config::default().providers.iter().all(|p| saved.providers.iter().any(|q| q.id == p.id)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn its_own_saves_are_not_reloaded_and_a_broken_file_keeps_the_memory_copy() {
        let d = dir();
        let st = DispatchState::default();
        st.load_or_init(&d);
        st.update(|c| {
            c.policy.local_timeout_secs = 33;
            Ok(())
        })
        .unwrap();
        st.update(|c| {
            c.policy.cloud_timeout_secs = 77;
            Ok(())
        })
        .unwrap();
        let saved = on_disk(&d);
        assert_eq!((saved.policy.local_timeout_secs, saved.policy.cloud_timeout_secs), (33, 77));
        // A half-written or hand-broken file: the save goes on from memory and repairs it, and
        // the broken edit is kept beside it first.
        std::fs::write(d.join("providers.json"), "{ not json").unwrap();
        st.update(|c| {
            c.policy.local_timeout_secs = 34;
            Ok(())
        })
        .unwrap();
        let saved = on_disk(&d);
        assert_eq!((saved.policy.local_timeout_secs, saved.policy.cloud_timeout_secs), (34, 77));
        assert_eq!(invalid_copies(&d), vec![b"{ not json".to_vec()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The bytes of every `providers.json.invalid-*` copy in `d`.
    fn invalid_copies(d: &Path) -> Vec<Vec<u8>> {
        let mut out: Vec<_> = std::fs::read_dir(d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("providers.json.invalid-")).map(|e| std::fs::read(e.path()).unwrap()).collect();
        out.sort();
        out
    }

    fn bump(c: &mut Config) -> Result<(), String> {
        c.policy.local_timeout_secs = 45; // any Settings save (providers_update, n8n_discover adopt...)
        Ok(())
    }

    #[test]
    fn a_bom_prefixed_file_loads() {
        let d = dir();
        edited_on_disk(&d);
        let text = std::fs::read_to_string(d.join("providers.json")).unwrap();
        std::fs::write(d.join("providers.json"), format!("\u{feff}{text}")).unwrap(); // PS 5.1 Set-Content -Encoding UTF8
        let st = DispatchState::default();
        st.load_or_init(&d);
        assert_eq!(st.snapshot().policy.stt, "faster-whisper", "the BOM is not a reason to fall back to defaults");
        st.update(bump).unwrap();
        assert_eq!(on_disk(&d).policy.stt, "faster-whisper");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_invalid_file_is_never_replaced_by_the_defaults() {
        let d = dir();
        edited_on_disk(&d);
        let good = std::fs::read_to_string(d.join("providers.json")).unwrap();
        // A hand edit that left a trailing comma.
        let broken = format!("{},\n}}", good.trim_end().trim_end_matches('}').trim_end());
        assert!(serde_json::from_str::<Value>(&broken).is_err());
        std::fs::write(d.join("providers.json"), &broken).unwrap();
        let st = DispatchState::default();
        st.load_or_init(&d);
        assert_eq!(st.snapshot().policy.stt, "whisper", "defaults in memory");
        // The first Settings save used to write defaults + that one change over the whole file.
        let err = st.update(bump).unwrap_err();
        assert!(err.contains("Fix or delete it") && err.contains("providers.json.invalid-"), "{err}");
        assert_eq!(std::fs::read_to_string(d.join("providers.json")).unwrap(), broken, "the file is untouched");
        assert_eq!(invalid_copies(&d), vec![broken.clone().into_bytes()], "one copy, however many saves are refused");
        assert!(st.update(bump).is_err());
        assert_eq!(invalid_copies(&d).len(), 1);
        // Nic fixes the file: it is reloaded and the save lands on it.
        std::fs::write(d.join("providers.json"), &good).unwrap();
        st.update(bump).unwrap();
        let saved = on_disk(&d);
        assert_eq!((saved.policy.stt.as_str(), saved.policy.local_timeout_secs), ("faster-whisper", 45));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_file_is_not_overwritten_at_load_and_deleting_it_resets() {
        let d = dir();
        edited_on_disk(&d);
        // UTF-16 LE with a BOM (Windows PowerShell 5.1 `Out-File` / `>`): not UTF-8.
        let text = std::fs::read_to_string(d.join("providers.json")).unwrap();
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        std::fs::write(d.join("providers.json"), &utf16).unwrap();
        let st = DispatchState::default();
        st.load_or_init(&d);
        assert_eq!(std::fs::read(d.join("providers.json")).unwrap(), utf16, "not replaced by the defaults at startup");
        assert_eq!(invalid_copies(&d), vec![utf16.clone()]);
        assert!(st.update(bump).is_err());
        assert_eq!(std::fs::read(d.join("providers.json")).unwrap(), utf16);
        // Deleting it is the way back to defaults.
        std::fs::remove_file(d.join("providers.json")).unwrap();
        st.update(bump).unwrap();
        assert_eq!((on_disk(&d).policy.stt.as_str(), on_disk(&d).policy.local_timeout_secs), ("whisper", 45));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_another_process_held_at_load_is_loaded_once_it_is_free() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = dir();
        edited_on_disk(&d);
        // A sharing violation (an editor or a backup tool holding it, no sharing) at startup.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(d.join("providers.json")).unwrap();
        let st = DispatchState::default();
        st.load_or_init(&d);
        assert_eq!(st.snapshot().policy.stt, "whisper", "unreadable at load: defaults in memory");
        assert!(st.update(bump).is_err(), "and never saved over it");
        drop(held);
        // Same file, same stamp: re-read anyway, and the save lands on Nic's config.
        st.update(bump).unwrap();
        let saved = on_disk(&d);
        assert_eq!((saved.policy.stt.as_str(), saved.policy.local_timeout_secs), ("faster-whisper", 45));
        let _ = std::fs::remove_dir_all(&d);
    }
}
