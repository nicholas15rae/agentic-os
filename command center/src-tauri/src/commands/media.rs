//! Director Suite backend (docs/proposals/director-suite-plan.md, locked contract §3).
//!
//! Projects live in `C:\ai-hub\media\projects\<slug>\{raw, working, renders}`:
//! - `raw/` holds ingested originals: copies only, marked read-only, never modified;
//! - `working/` holds `timeline_manifest.json` (the single source of truth shared by the quick
//!   editor and the Director), `chat.jsonl`, thumbnails, voiceovers and render specs;
//! - `renders/` holds verified outputs only.
//!
//! `media.db` (app config dir, `user_version` ladder like devqueue.rs) indexes projects, assets,
//! plans and verified renders as JSON rows. Renders run ONLY from `media_render_execute` with
//! `approved: true` (the Render Plan card): Rust builds the spec from the saved manifest, starts
//! media-forge's `render_timeline` job as the Director (role-gated: media servers only; CPU
//! libx264), polls it, verifies the file itself (exists, > 0 bytes, ffprobe streams, duration,
//! resolution, size cap) and only then lists it. Nothing here runs from a model reply.
//!
//! v2 (docs/proposals/director-suite-v2-contract.md): projects gain a creative brief, a speed and a
//! review (project.json), a watched `inbox/` and `working/captions/`; manifests are version 2
//! (captions, color, platform outputs, notes) and v1 files load as v2 with defaults; asset rows gain
//! tags / transcript / flags / moments / slotId (media.db v3 columns). v1 statuses map on read:
//! intake→brief, awaiting_media→shooting, rendering→editing, ready→review.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

use super::os_core::{self, OsState};

const MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 9 * 1024 * 1024;
const MAX_VOICEOVER_BYTES: usize = 300 * 1024 * 1024;
const CHAT_KEEP: usize = 200;
const RENDER_EVENT: &str = "media-render";
const INGEST_EVENT: &str = "media-ingest";
/// v2 §8: intake pipeline progress (emitted by the intake tick).
pub(crate) const INTAKE_EVENT: &str = "media-intake";
const MAX_NOTES: usize = 500;
const MAX_TAGS: usize = 12;
const MAX_MOMENTS: usize = 50;

pub(crate) const PROJECT_STATUSES: [&str; 5] = ["brief", "shooting", "editing", "review", "done"];
pub(crate) const PLATFORMS: [&str; 7] = ["reels", "tiktok", "ig_feed", "youtube", "shorts", "self_tape", "custom"];
const ASPECTS: [&str; 4] = ["16:9", "9:16", "4:5", "1:1"];
const FRAMINGS: [&str; 7] = ["wide", "medium", "mcu", "closeup", "insert", "overhead", "pov"];
const SLOT_SOURCES: [&str; 3] = ["film", "generate", "stock"];
const TRANSITIONS: [&str; 3] = ["cut", "crossfade", "fade_black"];
const CAPTION_STYLES: [&str; 4] = ["clean", "bold_pop", "karaoke", "minimal"];
const COLOR_PRESETS: [&str; 6] = ["none", "warm", "cool", "punchy", "film", "bw"];
const SPEEDS: [&str; 3] = ["rough", "polish", "full_ai"];
const BRIEF_KEYS: [&str; 11] = ["idea", "goal", "platform", "lengthSec", "aspect", "tone", "references", "guessed", "approved", "updatedBy", "updatedAt"];

const VIDEO_EXT: [&str; 7] = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts"];
const IMAGE_EXT: [&str; 6] = ["jpg", "jpeg", "png", "webp", "bmp", "tif"];
const AUDIO_EXT: [&str; 9] = ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm", "wma"];

// ── Contract types (camelCase on the wire, as contract.ts) ─────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub from: String,
    pub ref_id: Option<String>,
    pub brief: Option<String>,
}

fn d_rough() -> String {
    "rough".into()
}
fn d_film() -> String {
    "film".into()
}
fn d_one() -> f64 {
    1.0
}

/// contract.ts `CreativeBrief` (v2 §1).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreativeBrief {
    pub idea: String,
    pub goal: String,
    pub platform: String,
    pub length_sec: f64,
    pub aspect: String,
    pub tone: String,
    pub references: Vec<String>,
    pub guessed: Vec<String>,
    pub approved: bool,
    pub updated_by: String,
    pub updated_at: String,
}

/// contract.ts `ReviewRound` (v2 §5).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRound {
    pub round: u8,
    pub render_id: String,
    pub notes: Vec<String>,
    pub status: String,
    pub summary: String,
}

/// `project.json` → `review` (v2 §5).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectReview {
    pub rounds: Vec<ReviewRound>,
    pub open_decisions: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaProject {
    pub slug: String,
    pub title: String,
    /// v2 status; v1 rows are mapped on read (`upgrade_status`).
    pub status: String,
    pub root: String,
    pub created_at: String,
    pub updated_at: String,
    pub source: Source,
    #[serde(default)]
    pub brief: Option<CreativeBrief>,
    #[serde(default = "d_rough")]
    pub speed: String,
    #[serde(default)]
    pub review: ProjectReview,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetFlag {
    pub kind: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Moment {
    pub id: String,
    pub in_sec: f64,
    pub out_sec: f64,
    pub label: String,
    pub score: f64,
    pub by: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetTranscript {
    pub path: String,
    pub lang: String,
    pub words: u32,
    pub first_speech_sec: Option<f64>,
    pub last_speech_sec: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub project: String,
    pub kind: String,
    pub role: String,
    pub name: String,
    pub path: String,
    pub read_only: bool,
    pub size_bytes: u64,
    pub duration_sec: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumb_path: Option<String>,
    pub added_at: String,
    // v2 (v1 rows load with the defaults; media.db v3 keeps them in their own columns)
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub transcript: Option<AssetTranscript>,
    #[serde(default)]
    pub flags: Vec<AssetFlag>,
    #[serde(default)]
    pub moments: Vec<Moment>,
    #[serde(default)]
    pub slot_id: Option<String>,
    /// Shot-cut times in seconds (media-forge detect_scenes, after the probe; video only, ≤ 200).
    /// `None` = not detected (yet); `Some([])` = one continuous shot. Kept in the json column.
    #[serde(default)]
    pub scenes: Option<Vec<f64>>,
    /// Part 2: how a generated still/clip was made (ComfyUI). `None` for filmed/imported media and
    /// every v1/v2 row. Kept in the json column (no migration); the full record, with the exact
    /// API workflow, is the `working/gen/<id>.gen.json` sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<GenMeta>,
}

/// Provenance of one generated asset (ComfyUI). Every field defaults so a partial or older
/// record still loads. `workflow` (the API prompt graph sent to ComfyUI) lives only in the
/// sidecar: the copy on the asset row drops it to keep asset lists small.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GenMeta {
    pub template: String,
    pub prompt: String,
    pub negative: String,
    pub seed: u64,
    pub steps: u32,
    pub cfg: f64,
    pub sampler: String,
    pub scheduler: String,
    pub width: u32,
    pub height: u32,
    pub denoise: f64,
    /// Checkpoint file name (filled from `checkpoint_path` when empty).
    pub checkpoint: String,
    /// Where the checkpoint is on disk (hashed once per path+size+mtime, cached in media.db kv).
    pub checkpoint_path: Option<String>,
    pub checkpoint_sha256: Option<String>,
    pub comfyui_version: String,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub workflow: Value,
    pub comfy_job_id: String,
    pub prompt_id: String,
    pub render_ms: u64,
    pub peak_vram_mb: Option<u64>,
    /// Whether faster-whisper STT stayed resident on the GPU during the render (`None` = unknown).
    pub whisper_resident: Option<bool>,
    pub created_at: String,
    /// Generated video only (the caller knows frames / fps; there is no probe here).
    pub duration_sec: Option<f64>,
    /// `working/gen/<asset-id>.gen.json` (set by `ingest_generated`).
    pub sidecar_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShotSlot {
    pub id: String,
    pub label: String,
    pub instructions: String,
    pub kind: String,
    pub target_sec: Option<f64>,
    pub asset_id: Option<String>,
    pub status: String,
    // v2
    #[serde(default)]
    pub framing: Option<String>,
    #[serde(default)]
    pub action: String,
    #[serde(default = "d_film")]
    pub source: String,
    #[serde(default)]
    pub phone_tips: Vec<String>,
    #[serde(default)]
    pub filmed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transition {
    pub kind: String,
    pub ms: u32,
}

impl Default for Transition {
    fn default() -> Self {
        Self { kind: "cut".into(), ms: 0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineClip {
    pub id: String,
    pub asset_id: String,
    pub in_sec: f64,
    pub out_sec: f64,
    pub fade_ms: u32,
    // v2
    #[serde(default)]
    pub transition_in: Transition,
    #[serde(default = "d_one")]
    pub punch_in: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioLayer {
    pub id: String,
    pub asset_id: String,
    pub start_sec: f64,
    pub in_sec: f64,
    pub out_sec: f64,
    pub volume: f64,
    // v2
    #[serde(default)]
    pub fade_in_ms: u32,
    #[serde(default)]
    pub fade_out_ms: u32,
    #[serde(default)]
    pub duck_under_voice: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionTrack {
    pub enabled: bool,
    pub style: String,
    pub position: String,
    pub max_words_per_line: u32,
}

impl Default for CaptionTrack {
    fn default() -> Self {
        Self { enabled: false, style: "clean".into(), position: "lower".into(), max_words_per_line: 4 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorLook {
    pub preset: String,
    pub strength: f64,
}

impl Default for ColorLook {
    fn default() -> Self {
        Self { preset: "none".into(), strength: 0.5 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformPreset {
    pub platform: String,
    pub aspect: String,
    pub loudness_lufs: i32,
    pub max_size_mb: Option<f64>,
    pub max_sec: Option<f64>,
}

/// contract.ts `Note` (v2 §5). Rust owns notes: `media_note_add` / `media_note_resolve` write them
/// and `manifest_save` keeps the saved ones rather than the client's copy.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub id: String,
    pub render_id: Option<String>,
    pub at_sec: Option<f64>,
    pub text: String,
    pub by: String,
    pub via_voice: bool,
    pub resolved: bool,
    pub at: String,
}

/// `media_note_add`'s `note` argument: `Omit<Note, "id" | "at" | "resolved">`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteInput {
    pub render_id: Option<String>,
    pub at_sec: Option<f64>,
    pub text: String,
    pub by: String,
    pub via_voice: bool,
}

/// contract.ts `Deliverable` (v2 §6).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deliverable {
    pub platform: String,
    pub render_id: String,
    pub path: String,
    pub caption_path: Option<String>,
    pub thumb_path: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntakeStatus {
    pub inbox: String,
    pub pending: u32,
    pub processing: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputSpec {
    pub aspect: String,
    pub loudness_lufs: i32,
    pub max_size_mb: Option<f64>,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineManifest {
    pub version: u32,
    pub project: String,
    pub revision: u64,
    pub clips: Vec<TimelineClip>,
    pub audio: Vec<AudioLayer>,
    pub clip_audio_volume: f64,
    pub output: OutputSpec,
    pub shot_list: Vec<ShotSlot>,
    pub updated_by: String,
    pub updated_at: String,
    // v2
    #[serde(default)]
    pub captions: CaptionTrack,
    #[serde(default)]
    pub color: ColorLook,
    #[serde(default)]
    pub outputs: Vec<PlatformPreset>,
    #[serde(default)]
    pub notes: Vec<Note>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanSource {
    pub asset_id: String,
    pub name: String,
    pub in_sec: f64,
    pub out_sec: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanAudio {
    pub asset_id: String,
    pub name: String,
    pub start_sec: f64,
    pub volume: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub plan_id: String,
    pub project: String,
    pub manifest_revision: u64,
    pub sources: Vec<PlanSource>,
    pub audio: Vec<PlanAudio>,
    pub output_name: String,
    pub output_spec: String,
    pub render_mode: String,
    pub proposed_by: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyInfo {
    pub ok: bool,
    pub checks: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedRender {
    pub id: String,
    pub project: String,
    pub plan_id: String,
    pub path: String,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub loudness_lufs: Option<f64>,
    pub verify: VerifyInfo,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatLine {
    pub role: String,
    pub text: String,
    pub at: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpReady {
    pub enabled: bool,
    pub healthy: bool,
    pub tools: u32,
    pub error: Option<String>,
}

// ── Schema / state ─────────────────────────────────────────────────────────────

pub(crate) const MIGRATIONS: &[&str] = &[
    "CREATE TABLE project (slug TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE asset (id TEXT PRIMARY KEY, project TEXT NOT NULL, json TEXT NOT NULL, added_at TEXT NOT NULL);
     CREATE INDEX asset_project ON asset(project, added_at);
     CREATE TABLE plan (id TEXT PRIMARY KEY, project TEXT NOT NULL, json TEXT NOT NULL);
     CREATE TABLE render (id TEXT PRIMARY KEY, project TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE INDEX render_project ON render(project, created_at);",
    // v2: cloud sync records (gdrive.rs) and app-wide key/value settings (Drive inbox/outbox).
    "CREATE TABLE drive_sync (id TEXT PRIMARY KEY, provider TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('pull','push')), project TEXT NOT NULL, local_path TEXT NOT NULL, drive_file_id TEXT NOT NULL, name TEXT NOT NULL, size_bytes INTEGER NOT NULL, web_view_link TEXT, at TEXT NOT NULL);
     CREATE INDEX drive_sync_project ON drive_sync(project, at);
     CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // v3 (Director Suite v2 §9): JSON columns for the new asset fields. Every v1 row keeps its json
    // and reads the column defaults (no tags/flags/moments, no transcript, no slot).
    "ALTER TABLE asset ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
     ALTER TABLE asset ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';
     ALTER TABLE asset ADD COLUMN moments TEXT NOT NULL DEFAULT '[]';
     ALTER TABLE asset ADD COLUMN transcript TEXT;
     ALTER TABLE asset ADD COLUMN slot_id TEXT;
     CREATE INDEX asset_slot ON asset(project, slot_id);",
];

pub(crate) fn sql_err(e: rusqlite::Error) -> String {
    format!("media library: {e}")
}

pub(crate) fn migrate(conn: &mut Connection) -> Result<u32, String> {
    let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(sql_err)?;
    if v as usize > MIGRATIONS.len() {
        return Err(format!("media library: media.db is schema v{v}, newer than this app (v{})", MIGRATIONS.len()));
    }
    for (i, step) in MIGRATIONS.iter().enumerate().skip(v as usize) {
        let tx = conn.transaction().map_err(sql_err)?;
        tx.execute_batch(step).map_err(sql_err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
    }
    Ok(MIGRATIONS.len() as u32)
}

fn open_db(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(sql_err)?;
    conn.busy_timeout(Duration::from_millis(3000)).map_err(sql_err)?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql_err)?;
    migrate(&mut conn)?;
    Ok(conn)
}

struct Upload {
    slug: String,
    name: String,
    role: String,
    total: u64,
    received: u64,
    part: PathBuf,
}

#[derive(Default)]
pub struct MediaState {
    conn: Mutex<Option<Connection>>,
    path: Mutex<Option<PathBuf>>,
    /// Projects root override (tests); `None` = `C:\ai-hub\media\projects`.
    root: Mutex<Option<PathBuf>>,
    uploads: Mutex<HashMap<String, Upload>>,
    /// Render job id (the first output's media-forge job id) → the live batch, while it runs.
    jobs: Mutex<HashMap<String, LiveRender>>,
    /// Serialises manifest read-modify-write per process.
    manifest_lock: Mutex<()>,
    /// Serialises every project row read-modify-write (status, brief, review rounds) per process.
    /// Lock order: `manifest_lock` before `project_lock`, never the other way round.
    project_lock: Mutex<()>,
    /// Projects with a render batch being prepared or running (one live batch per project).
    rendering: Mutex<HashSet<String>>,
    /// v2 intake: per-project pipeline state, filled by the intake tick.
    intake: Mutex<HashMap<String, IntakeInfo>>,
    /// v2 pipeline queue (new intake assets and `media_transcribe` picks), drained one at a time.
    transcribe_queue: Mutex<VecDeque<IntakeJob>>,
    /// v2 intake: the size each inbox file had at the last tick (stable = unchanged for 2 ticks).
    inbox_seen: Mutex<HashMap<PathBuf, InboxSeen>>,
}

/// One multi-output render batch (one approval): the media-forge job running now, and whether Nic
/// cancelled it (the outputs after it are then skipped).
#[derive(Clone, Debug, Default)]
pub(crate) struct LiveRender {
    pub forge_job: String,
    pub cancelled: bool,
}

/// A queued pipeline pass for one asset: `analyze` = probe flags too (new intake files); a
/// `media_transcribe` pick only transcribes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IntakeJob {
    pub slug: String,
    pub asset_id: String,
    pub analyze: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct InboxSeen {
    pub size: u64,
    /// Last-write time at the last tick: a file is stable only when size *and* mtime held.
    pub mtime: Option<std::time::SystemTime>,
    /// This size/mtime failed permanently (unsupported, unreadable media): don't retry until the
    /// file changes.
    pub failed: bool,
    /// A transient failure (locked, ffprobe missing, db busy): retry from this moment.
    pub retry_at: Option<std::time::Instant>,
    /// Transient failures in a row (the backoff doubles with each).
    pub attempts: u32,
}

impl InboxSeen {
    fn fresh(size: u64, mtime: Option<std::time::SystemTime>) -> Self {
        Self { size, mtime, failed: false, retry_at: None, attempts: 0 }
    }
}

/// One stable inbox file, as the tick saw it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InboxFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: Option<std::time::SystemTime>,
}

/// Why an inbox file wasn't ingested: `Permanent` waits for the file to change; `Transient` is
/// retried with backoff.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum IntakeFail {
    Permanent(String),
    Transient(String),
}

impl IntakeFail {
    pub(crate) fn text(&self) -> &str {
        match self {
            Self::Permanent(e) | Self::Transient(e) => e,
        }
    }
}

#[derive(Default, Clone, Debug)]
pub(crate) struct IntakeInfo {
    pub processing: Option<String>,
    pub last_error: Option<String>,
}

impl MediaState {
    pub fn init(&self, dir: &Path) {
        let path = dir.join("media.db");
        *self.path.lock().unwrap() = Some(path.clone());
        match std::fs::create_dir_all(dir).map_err(|e| e.to_string()).and_then(|_| open_db(&path)) {
            Ok(c) => *self.conn.lock().unwrap() = Some(c),
            Err(e) => eprintln!("[media] {e}"),
        }
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.conn.lock().unwrap();
        if g.is_none() {
            let path = self.path.lock().unwrap().clone().ok_or("media library isn't initialised")?;
            *g = Some(open_db(&path)?);
        }
        f(g.as_mut().expect("connection just opened"))
    }

    pub(crate) fn projects_root(&self) -> PathBuf {
        self.root.lock().unwrap().clone().unwrap_or_else(|| PathBuf::from(os_core::MEDIA_ROOT).join("projects"))
    }

    #[cfg(test)]
    pub(crate) fn in_memory(root: &Path) -> Self {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        Self::with_conn(c, root)
    }

    #[cfg(test)]
    pub(crate) fn with_conn(c: Connection, root: &Path) -> Self {
        let s = Self::default();
        *s.conn.lock().unwrap() = Some(c);
        *s.root.lock().unwrap() = Some(root.to_path_buf());
        s
    }
}

// ── Small helpers ──────────────────────────────────────────────────────────────

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub(crate) fn short_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}{}", base36(ms), base36(n % 1296))
}

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// `"My Self-Tape: Scene 2!"` → `my-self-tape-scene-2` (a-z0-9-, ≤ 40, never empty).
pub(crate) fn slugify(title: &str) -> String {
    let mut s = String::new();
    for c in title.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 40 {
            break;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "project".into()
    } else {
        s
    }
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 48 && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !slug.starts_with('-')
}

/// A plain file name for `raw/`: no separators, reserved characters or leading dots.
pub(crate) fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut s: String = base.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().trim_start_matches('.').to_string();
    if s.is_empty() {
        s = "media".into();
    }
    if s.chars().count() > 120 {
        let ext = Path::new(&s).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let stem: String = s.chars().take(100).collect();
        s = if ext.is_empty() { stem } else { format!("{stem}.{ext}") };
    }
    s
}

pub(crate) fn ext_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

pub(crate) fn kind_for_ext(ext: &str) -> Option<&'static str> {
    if IMAGE_EXT.contains(&ext) {
        Some("image")
    } else if VIDEO_EXT.contains(&ext) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext) {
        Some("audio")
    } else {
        None
    }
}

const ROLES: [&str; 7] = ["clip", "photo", "slate", "outro", "voiceover", "music", "sfx"];

pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "media".into());
    let ext = ext_of(name);
    for n in 2.. {
        let cand = dir.join(if ext.is_empty() { format!("{stem}-{n}") } else { format!("{stem}-{n}.{ext}") });
        if !cand.exists() {
            return cand;
        }
    }
    unreachable!()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    let mut last = None;
    for i in 0..8 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(50 * (i + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!("save {}: {}", path.display(), last.map(|e| e.to_string()).unwrap_or_default()))
}

fn set_read_only(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perm = meta.permissions();
        perm.set_readonly(true);
        let _ = std::fs::set_permissions(path, perm);
    }
}

pub(crate) fn inside(path: &Path, root: &Path) -> bool {
    match (dunce_canon(path), dunce_canon(root)) {
        (Some(p), Some(r)) => p.starts_with(r),
        _ => false,
    }
}

/// Canonical path without the `\\?\` prefix (so comparisons and the webview's asset URLs agree).
pub(crate) fn dunce_canon(p: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(p).ok()?;
    let s = c.to_string_lossy();
    Some(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()))
}

// ── ffprobe / ffmpeg ───────────────────────────────────────────────────────────

/// ffprobe / ffmpeg: media-forge's own MEDIA_FF* override in os.json, then PATH (winget's
/// links), then Shotcut's bundled copy.
fn media_bin(cfg: &os_core::OsConfig, name: &str) -> Option<String> {
    let key = if name == "ffprobe" { "MEDIA_FFPROBE" } else { "MEDIA_FFMPEG" };
    if let Some(v) = cfg.mcps.iter().find(|m| m.id == "media-forge").and_then(|m| m.env.get(key)).filter(|v| Path::new(v.as_str()).is_file()) {
        return Some(v.clone());
    }
    if let Ok(r) = crate::exe_resolve::resolve_program(name, &BTreeMap::new(), None) {
        return Some(r.program.to_string_lossy().to_string());
    }
    let bundled = Path::new(r"C:\Program Files\Shotcut").join(format!("{name}.exe"));
    bundled.is_file().then(|| bundled.to_string_lossy().to_string())
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Probe {
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub has_video: bool,
    pub has_audio: bool,
}

fn run_hidden(program: &str, args: &[&str], timeout: Duration) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    let child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => {
            crate::proc::kill_tree(pid);
            Err(format!("{program} timed out"))
        }
    }
}

pub(crate) fn parse_probe(json_text: &str) -> Probe {
    let v: Value = serde_json::from_str(json_text).unwrap_or(Value::Null);
    let mut p = Probe { duration: v["format"]["duration"].as_str().and_then(|d| d.parse().ok()), ..Default::default() };
    for s in v["streams"].as_array().into_iter().flatten() {
        match s["codec_type"].as_str() {
            Some("video") if s["disposition"]["attached_pic"].as_i64() != Some(1) => {
                p.has_video = true;
                let (mut w, mut h) = (s["width"].as_u64().map(|x| x as u32), s["height"].as_u64().map(|x| x as u32));
                let rot = s["side_data_list"].as_array().into_iter().flatten().find_map(|d| d["rotation"].as_i64()).unwrap_or(0);
                if rot.abs() == 90 || rot.abs() == 270 {
                    std::mem::swap(&mut w, &mut h);
                }
                p.width = p.width.or(w);
                p.height = p.height.or(h);
            }
            Some("audio") => p.has_audio = true,
            _ => {}
        }
    }
    p
}

fn probe(ffprobe: &str, path: &Path) -> Result<Probe, String> {
    let ps = path.to_string_lossy().to_string();
    let out = run_hidden(ffprobe, &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &ps], Duration::from_secs(60))?;
    if !out.status.success() {
        return Err(format!("ffprobe could not read {}: {}", path.display(), String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()));
    }
    Ok(parse_probe(&String::from_utf8_lossy(&out.stdout)))
}

fn make_thumb(ffmpeg: &str, src: &Path, kind: &str, duration: Option<f64>, out: &Path) -> Option<String> {
    let _ = std::fs::create_dir_all(out.parent()?);
    let s = src.to_string_lossy().to_string();
    let o = out.to_string_lossy().to_string();
    let at = format!("{:.2}", duration.map(|d| (d / 3.0).min(1.0)).unwrap_or(0.0));
    let args: Vec<&str> = if kind == "video" {
        vec!["-y", "-hide_banner", "-loglevel", "error", "-ss", &at, "-i", &s, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", &o]
    } else {
        vec!["-y", "-hide_banner", "-loglevel", "error", "-i", &s, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", &o]
    };
    let ok = run_hidden(ffmpeg, &args, Duration::from_secs(60)).map(|o| o.status.success()).unwrap_or(false);
    (ok && out.is_file()).then(|| out.to_string_lossy().to_string())
}

// ── Projects ───────────────────────────────────────────────────────────────────

pub(crate) fn project_root(state: &MediaState, slug: &str) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("bad project slug: {slug:?}"));
    }
    Ok(state.projects_root().join(slug))
}

/// v1 → v2 project status (v2 values pass through; anything unknown reads as "brief").
pub(crate) fn upgrade_status(s: &str) -> &'static str {
    match s {
        "intake" | "brief" => "brief",
        "awaiting_media" | "shooting" => "shooting",
        "editing" | "rendering" => "editing",
        "ready" | "review" => "review",
        "done" => "done",
        _ => "brief",
    }
}

fn status_rank(s: &str) -> usize {
    PROJECT_STATUSES.iter().position(|x| *x == s).unwrap_or(0)
}

/// A project row (v1 or v2) as v2. The upgraded status is written back on the next save.
pub(crate) fn parse_project(j: &str) -> Result<MediaProject, String> {
    let mut p: MediaProject = serde_json::from_str(j).map_err(|e| e.to_string())?;
    p.status = upgrade_status(&p.status).into();
    if !SPEEDS.contains(&p.speed.as_str()) {
        p.speed = d_rough();
    }
    Ok(p)
}

pub(crate) fn load_project(state: &MediaState, slug: &str) -> Result<MediaProject, String> {
    state
        .with(|c| c.query_row("SELECT json FROM project WHERE slug = ?1", [slug], |r| r.get::<_, String>(0)).optional().map_err(sql_err))?
        .ok_or_else(|| format!("no media project {slug:?}"))
        .and_then(|j| parse_project(&j))
}

/// v2 folders: `inbox/` (watched) and `working/captions/`. Created with the project, and lazily for
/// projects made before v2.
pub(crate) fn ensure_project_dirs(root: &Path) -> Result<(), String> {
    for sub in ["raw", "working", "renders", "inbox"] {
        std::fs::create_dir_all(root.join(sub)).map_err(|e| format!("create {}: {e}", root.join(sub).display()))?;
    }
    let cap = root.join("working").join("captions");
    std::fs::create_dir_all(&cap).map_err(|e| format!("create {}: {e}", cap.display()))
}

fn save_project(state: &MediaState, p: &MediaProject) -> Result<(), String> {
    let j = serde_json::to_string(p).map_err(|e| e.to_string())?;
    state.with(|c| c.execute("INSERT INTO project (slug, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(slug) DO UPDATE SET json = ?2, updated_at = ?3", params![p.slug, j, p.updated_at]).map(|_| ()).map_err(sql_err))?;
    let root = PathBuf::from(&p.root);
    write_atomic(&root.join("project.json"), serde_json::to_string_pretty(p).map_err(|e| e.to_string())?.as_bytes())
}

/// Automatic status moves only go forward (brief → shooting → editing → review → done); Nic can
/// move a project anywhere by hand with `media_project_update`.
fn advance_status(state: &MediaState, slug: &str, status: &str) {
    let _g = state.project_lock.lock().unwrap();
    if let Ok(mut p) = load_project(state, slug) {
        if status_rank(status) > status_rank(&p.status) {
            p.status = status.into();
            p.updated_at = now_iso();
            let _ = save_project(state, &p);
        }
    }
}

const ASSET_COLS: &str = "json, tags, flags, moments, transcript, slot_id";

/// An asset row: the json (v1 or v2) with the v3 columns laid over it (the columns own the v2 fields).
fn asset_from_row(r: &rusqlite::Row) -> rusqlite::Result<Option<MediaAsset>> {
    let j: String = r.get(0)?;
    let (tags, flags, moments): (String, String, String) = (r.get(1)?, r.get(2)?, r.get(3)?);
    let (transcript, slot_id): (Option<String>, Option<String>) = (r.get(4)?, r.get(5)?);
    let Ok(mut a) = serde_json::from_str::<MediaAsset>(&j) else { return Ok(None) };
    a.tags = serde_json::from_str(&tags).unwrap_or_default();
    a.flags = serde_json::from_str(&flags).unwrap_or_default();
    a.moments = serde_json::from_str(&moments).unwrap_or_default();
    a.transcript = transcript.and_then(|t| serde_json::from_str(&t).ok());
    a.slot_id = slot_id;
    Ok(Some(a))
}

fn list_assets(state: &MediaState, slug: &str) -> Result<Vec<MediaAsset>, String> {
    state.with(|c| {
        let mut st = c.prepare(&format!("SELECT {ASSET_COLS} FROM asset WHERE project = ?1 ORDER BY added_at, id")).map_err(sql_err)?;
        let rows = st.query_map([slug], asset_from_row).map_err(sql_err)?;
        Ok(rows.filter_map(|r| r.ok().flatten()).collect())
    })
}

fn load_asset(state: &MediaState, slug: &str, id: &str) -> Result<MediaAsset, String> {
    state
        .with(|c| c.query_row(&format!("SELECT {ASSET_COLS} FROM asset WHERE project = ?1 AND id = ?2"), [slug, id], asset_from_row).optional().map_err(sql_err))?
        .flatten()
        .ok_or_else(|| format!("no asset {id:?} in this project"))
}

fn save_asset(state: &MediaState, a: &MediaAsset) -> Result<(), String> {
    let j = serde_json::to_string(a).map_err(|e| e.to_string())?;
    let js = |v: serde_json::Result<String>| v.map_err(|e| e.to_string());
    let (tags, flags, moments) = (js(serde_json::to_string(&a.tags))?, js(serde_json::to_string(&a.flags))?, js(serde_json::to_string(&a.moments))?);
    let transcript = a.transcript.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
    state.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO asset (id, project, json, added_at, tags, flags, moments, transcript, slot_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![a.id, a.project, j, a.added_at, tags, flags, moments, transcript, a.slot_id],
        )
        .map(|_| ())
        .map_err(sql_err)
    })
}

fn list_renders(state: &MediaState, slug: &str) -> Result<Vec<VerifiedRender>, String> {
    state.with(|c| {
        let mut st = c.prepare("SELECT json FROM render WHERE project = ?1 ORDER BY created_at DESC").map_err(sql_err)?;
        let rows = st.query_map([slug], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
    })
}

fn default_manifest(slug: &str) -> TimelineManifest {
    upgrade_manifest(TimelineManifest {
        version: 1,
        project: slug.into(),
        revision: 0,
        clips: vec![],
        audio: vec![],
        clip_audio_volume: 1.0,
        output: OutputSpec { aspect: "16:9".into(), loudness_lufs: -16, max_size_mb: None, name: slug.into() },
        shot_list: vec![],
        updated_by: "nic".into(),
        updated_at: now_iso(),
        captions: CaptionTrack::default(),
        color: ColorLook::default(),
        outputs: vec![],
        notes: vec![],
    })
}

/// v1 → v2 (pure): serde already filled every new field with its default; this sets the version
/// and gives a manifest without outputs the v1 `output` as its single (custom) output.
pub(crate) fn upgrade_manifest(mut m: TimelineManifest) -> TimelineManifest {
    m.version = 2;
    if m.outputs.is_empty() {
        m.outputs.push(PlatformPreset { platform: "custom".into(), aspect: m.output.aspect.clone(), loudness_lufs: m.output.loudness_lufs, max_size_mb: m.output.max_size_mb, max_sec: None });
    }
    m
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("working").join("timeline_manifest.json")
}

/// Lenient load for display only (project open): an unreadable manifest shows as empty. Anything
/// that writes the manifest or acts on it uses `load_manifest_strict`.
fn load_manifest(root: &Path, slug: &str) -> TimelineManifest {
    load_manifest_strict(root, slug).unwrap_or_else(|e| {
        eprintln!("[media] {slug}: {e}");
        default_manifest(slug)
    })
}

/// The saved manifest, or the default only when there is no file yet. A file that exists but
/// can't be read or parsed is an error, so a writer never replaces the timeline with an empty one.
pub(crate) fn load_manifest_strict(root: &Path, slug: &str) -> Result<TimelineManifest, String> {
    let path = manifest_path(root);
    match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str::<TimelineManifest>(&t).map(upgrade_manifest).map_err(|e| format!("MANIFEST_UNREADABLE: {} doesn't parse ({e}); it was left as it is", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default_manifest(slug)),
        Err(e) => Err(format!("MANIFEST_UNREADABLE: can't read {} ({e}); it was left as it is", path.display())),
    }
}

pub(crate) fn create_project(state: &MediaState, title: &str, source: Option<Source>) -> Result<MediaProject, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("give the project a title (up to 120 characters)".into());
    }
    let source = source.unwrap_or(Source { from: "suite".into(), ref_id: None, brief: None });
    if !["suite", "brainstorm", "playplace"].contains(&source.from.as_str()) {
        return Err(format!("unknown project source {:?}", source.from));
    }
    let base = slugify(title);
    let mut slug = base.clone();
    let mut n = 2;
    while load_project(state, &slug).is_ok() || state.projects_root().join(&slug).exists() {
        slug = format!("{base}-{n}");
        n += 1;
    }
    let root = state.projects_root().join(&slug);
    ensure_project_dirs(&root)?;
    let brief = source.brief.map(|b| b.chars().take(8000).collect::<String>());
    let now = now_iso();
    let p = MediaProject {
        slug: slug.clone(),
        title: title.into(),
        status: "brief".into(),
        root: root.to_string_lossy().to_string(),
        created_at: now.clone(),
        updated_at: now,
        source: Source { from: source.from, ref_id: source.ref_id.map(|r| r.chars().take(120).collect()), brief },
        brief: None,
        speed: d_rough(),
        review: ProjectReview::default(),
    };
    save_project(state, &p)?;
    let m = default_manifest(&slug);
    write_atomic(&manifest_path(&root), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())?;
    Ok(p)
}

// ── Ingest ─────────────────────────────────────────────────────────────────────

/// Finish an ingest: `staged` is already inside `raw/` (copied or uploaded). Marks it
/// read-only, probes it, makes a thumbnail and records the asset.
pub(crate) fn finalize_asset(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, staged: &Path, display: &str, role: &str, read_only: bool) -> Result<MediaAsset, String> {
    let ext = ext_of(display);
    let ffprobe = media_bin(cfg, "ffprobe").ok_or("ffprobe not found (install FFmpeg or Shotcut)")?;
    let pr = probe(&ffprobe, staged)?;
    let kind = match kind_for_ext(&ext) {
        Some("image") => "image",
        _ if pr.has_video => "video",
        _ if pr.has_audio => "audio",
        _ => return Err(format!("{display}: no video or audio stream")),
    };
    // One role from the picker covers every file it picked: fit it to what each file is.
    let role = match (kind, role) {
        ("audio", "clip" | "photo" | "slate" | "outro") => "music",
        ("image", "clip" | "voiceover" | "music" | "sfx") => "photo",
        ("video", "photo" | "voiceover" | "music" | "sfx") => "clip",
        (_, r) => r,
    };
    let id = short_id("a");
    let root = project_root(state, slug)?;
    if read_only {
        set_read_only(staged);
    }
    let thumb = if kind == "audio" { None } else { media_bin(cfg, "ffmpeg").and_then(|ff| make_thumb(&ff, staged, kind, pr.duration, &root.join("working").join("thumbs").join(format!("{id}.jpg")))) };
    let a = MediaAsset {
        id,
        project: slug.into(),
        kind: kind.into(),
        role: role.into(),
        name: display.into(),
        path: dunce_canon(staged).unwrap_or_else(|| staged.to_path_buf()).to_string_lossy().to_string(),
        read_only,
        size_bytes: std::fs::metadata(staged).map(|m| m.len()).unwrap_or(0),
        duration_sec: if kind == "image" { None } else { pr.duration.map(|d| (d * 1000.0).round() / 1000.0) },
        width: pr.width,
        height: pr.height,
        thumb_path: thumb,
        added_at: now_iso(),
        ..Default::default()
    };
    save_asset(state, &a)?;
    // v1 moved intake → awaiting_media here. v2 has no "first file" trigger: shooting comes from an
    // approved brief, editing from filled film slots or clips on the timeline. The asset is saved:
    // touching the project's timestamp is best-effort so a failure here never orphans it.
    let _g = state.project_lock.lock().unwrap();
    if let Ok(mut p) = load_project(state, slug) {
        p.updated_at = now_iso();
        let _ = save_project(state, &p);
    }
    Ok(a)
}

pub(crate) fn check_role(role: &str) -> Result<(), String> {
    ROLES.contains(&role).then_some(()).ok_or_else(|| format!("unknown asset role {role:?}"))
}

pub(crate) fn ingest_paths(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, paths: &[String], role: &str) -> Result<Vec<MediaAsset>, String> {
    check_role(role)?;
    load_project(state, slug)?;
    if paths.is_empty() || paths.len() > 100 {
        return Err("pick between 1 and 100 files".into());
    }
    let raw = project_root(state, slug)?.join("raw");
    std::fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
    let mut out = vec![];
    for p in paths {
        let src = PathBuf::from(p);
        if !src.is_file() {
            return Err(format!("not a file: {p}"));
        }
        let name = safe_file_name(&src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        if kind_for_ext(&ext_of(&name)).is_none() {
            return Err(format!("{name}: not a supported video, photo or audio file"));
        }
        let dst = unique_path(&raw, &name);
        // A copy: the original is never moved, opened for writing or touched again.
        std::fs::copy(&src, &dst).map_err(|e| format!("copy {name}: {e}"))?;
        match finalize_asset(state, cfg, slug, &dst, &name, role, true) {
            Ok(a) => out.push(a),
            Err(e) => {
                remove_staged(&dst);
                return Err(e);
            }
        }
    }
    Ok(out)
}

pub(crate) fn remove_staged(p: &Path) {
    if let Ok(meta) = std::fs::metadata(p) {
        let mut perm = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(p, perm);
    }
    let _ = std::fs::remove_file(p);
}

// ── Part 2: generated media provenance ─────────────────────────────────────────

/// Copy `src` to a new file `dst` and compare the two byte for byte (as the intake does); the
/// partial copy is removed on any failure.
fn copy_byte_checked(src: &Path, dst: &Path) -> Result<(), String> {
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let res = (|| -> std::io::Result<bool> {
        let mut a = std::fs::File::open(src)?;
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
        std::io::copy(&mut a, &mut out)?;
        out.sync_all()?;
        drop(out);
        same_content(&mut a, dst)
    })();
    match res {
        Ok(true) => Ok(()),
        Ok(false) => {
            remove_staged(dst);
            Err(format!("{name}: the raw/ copy doesn't match the generated file"))
        }
        Err(e) => {
            remove_staged(dst);
            Err(format!("copy {name}: {e}"))
        }
    }
}

fn ckpt_hash_key(path: &Path) -> String {
    format!("ckpt-sha256:{}", path.to_string_lossy())
}

/// SHA-256 of a checkpoint (hex), computed once per file: cached in media.db kv by path, size and
/// mtime, so a 7 GB file is only read again when it changes.
#[cfg_attr(not(test), allow(dead_code))] // called by the ComfyUI bridge (Part 2)
pub(crate) fn checkpoint_sha256(state: &MediaState, path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let p = dunce_canon(path).unwrap_or_else(|| path.to_path_buf());
    let meta = std::fs::metadata(&p).map_err(|e| format!("checkpoint {}: {e}", p.display()))?;
    let (size, mt) = (meta.len(), mtime_ms(meta.modified().ok()));
    let key = ckpt_hash_key(&p);
    let cached: Option<Value> = state.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [&key], |r| r.get::<_, String>(0)).optional().map_err(sql_err)).ok().flatten().and_then(|s| serde_json::from_str(&s).ok());
    if let Some(v) = cached {
        if v["size"].as_u64() == Some(size) && v["mtimeMs"].as_u64() == Some(mt) {
            if let Some(h) = v["sha256"].as_str() {
                return Ok(h.to_string());
            }
        }
    }
    let mut f = std::fs::File::open(&p).map_err(|e| format!("checkpoint {}: {e}", p.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("checkpoint {}: {e}", p.display()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let hex = format!("{:x}", h.finalize());
    let v = json!({ "size": size, "mtimeMs": mt, "sha256": hex }).to_string();
    let _ = state.with(|c| c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![key, v]).map(|_| ()).map_err(sql_err));
    Ok(hex)
}

/// Ingest a generated still (PNG, …) or clip (mp4) into `raw/`: a byte-checked, read-only copy like
/// any intake, role `photo` / `clip`, with `generation` on the asset and the full provenance
/// (including the exact API workflow) written to `working/gen/<asset-id>.gen.json`. No probe or
/// thumbnail: the generator already knows the size (a still is its own thumbnail in the bin).
/// Nothing is recorded if any step fails.
#[cfg_attr(not(test), allow(dead_code))] // called by the ComfyUI bridge (Part 2)
pub(crate) fn ingest_generated(state: &MediaState, slug: &str, file: &Path, meta: &GenMeta) -> Result<MediaAsset, String> {
    load_project(state, slug)?;
    let name = safe_file_name(&file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let (kind, role) = match kind_for_ext(&ext_of(&name)) {
        Some("image") => ("image", "photo"),
        Some("video") => ("video", "clip"),
        _ => return Err(format!("{name}: a generated asset must be an image or a video")),
    };
    let size = std::fs::metadata(file).map_err(|e| format!("{name}: {e}"))?.len();
    if !file.is_file() || size == 0 {
        return Err(format!("{name}: the generated file is missing or empty"));
    }
    let root = project_root(state, slug)?;
    let raw = root.join("raw");
    let gen_dir = root.join("working").join("gen");
    std::fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&gen_dir).map_err(|e| e.to_string())?;
    let dst = unique_path(&raw, &name);
    copy_byte_checked(file, &dst)?;
    set_read_only(&dst);
    let id = short_id("a");
    let mut g = meta.clone();
    if g.checkpoint.is_empty() {
        if let Some(n) = g.checkpoint_path.as_deref().and_then(|p| Path::new(p).file_name()) {
            g.checkpoint = n.to_string_lossy().to_string();
        }
    }
    if g.checkpoint_sha256.as_deref().is_none_or(str::is_empty) {
        // Best effort: an unreadable checkpoint leaves the hash unknown, it never blocks the ingest.
        g.checkpoint_sha256 = g.checkpoint_path.as_deref().and_then(|p| checkpoint_sha256(state, Path::new(p)).ok());
    }
    if g.created_at.is_empty() {
        g.created_at = now_iso();
    }
    let sidecar = gen_dir.join(format!("{id}.gen.json"));
    g.sidecar_path = Some(sidecar.to_string_lossy().to_string());
    let mut doc = serde_json::to_value(&g).map_err(|e| e.to_string())?;
    doc["assetId"] = json!(id);
    doc["file"] = json!(dst.file_name().map(|n| n.to_string_lossy().to_string()));
    doc["workflow"] = g.workflow.clone(); // the exact graph sent, `null` when none was given
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    if let Err(e) = write_atomic(&sidecar, pretty.as_bytes()) {
        remove_staged(&dst);
        return Err(e);
    }
    g.workflow = Value::Null;
    let a = MediaAsset {
        id,
        project: slug.into(),
        kind: kind.into(),
        role: role.into(),
        name: name.clone(),
        path: dunce_canon(&dst).unwrap_or_else(|| dst.clone()).to_string_lossy().to_string(),
        read_only: true,
        size_bytes: size,
        duration_sec: if kind == "video" { g.duration_sec.filter(|d| d.is_finite() && *d > 0.0) } else { None },
        width: (g.width > 0).then_some(g.width),
        height: (g.height > 0).then_some(g.height),
        thumb_path: None,
        added_at: now_iso(),
        generation: Some(g),
        ..Default::default()
    };
    if let Err(e) = save_asset(state, &a) {
        remove_staged(&dst);
        let _ = std::fs::remove_file(&sidecar);
        return Err(e);
    }
    let _g = state.project_lock.lock().unwrap();
    if let Ok(mut p) = load_project(state, slug) {
        p.updated_at = now_iso();
        let _ = save_project(state, &p);
    }
    Ok(a)
}

pub(crate) fn ingest_begin(state: &MediaState, slug: &str, name: &str, size: u64, role: &str) -> Result<String, String> {
    check_role(role)?;
    load_project(state, slug)?;
    let name = safe_file_name(name);
    if kind_for_ext(&ext_of(&name)).is_none() {
        return Err(format!("{name}: not a supported video, photo or audio file"));
    }
    if size == 0 || size > MAX_UPLOAD_BYTES {
        return Err("file is empty or larger than 20 GB".into());
    }
    let dir = project_root(state, slug)?.join("working").join(".uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = short_id("u");
    let part = dir.join(format!("{id}.part"));
    std::fs::File::create(&part).map_err(|e| e.to_string())?;
    state.uploads.lock().unwrap().insert(id.clone(), Upload { slug: slug.into(), name, role: role.into(), total: size, received: 0, part });
    Ok(id)
}

pub(crate) fn ingest_chunk(state: &MediaState, upload_id: &str, offset: u64, bytes: &[u8]) -> Result<(String, u64, u64), String> {
    if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
        return Err("chunk must be 1 byte to 9 MB".into());
    }
    let mut ups = state.uploads.lock().unwrap();
    let up = ups.get_mut(upload_id).ok_or("unknown or finished upload")?;
    if offset != up.received {
        return Err(format!("out-of-order chunk: expected offset {}, got {offset}", up.received));
    }
    if up.received + bytes.len() as u64 > up.total {
        return Err("more bytes than the declared size".into());
    }
    let mut f = std::fs::OpenOptions::new().write(true).open(&up.part).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    up.received += bytes.len() as u64;
    Ok((up.slug.clone(), up.received, up.total))
}

pub(crate) fn ingest_finish(state: &MediaState, cfg: &os_core::OsConfig, upload_id: &str) -> Result<MediaAsset, String> {
    let up = state.uploads.lock().unwrap().remove(upload_id).ok_or("unknown or finished upload")?;
    if up.received != up.total {
        let _ = std::fs::remove_file(&up.part);
        return Err(format!("upload incomplete: {} of {} bytes", up.received, up.total));
    }
    let dst = unique_path(&project_root(state, &up.slug)?.join("raw"), &up.name);
    std::fs::rename(&up.part, &dst).map_err(|e| format!("stage {}: {e}", up.name))?;
    finalize_asset(state, cfg, &up.slug, &dst, &up.name, &up.role, true).inspect_err(|_| remove_staged(&dst))
}

pub(crate) fn voiceover_save(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, bytes: &[u8], mime: &str) -> Result<MediaAsset, String> {
    let ext = match mime {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/wav" => "wav",
        other => return Err(format!("unsupported voiceover type {other:?}")),
    };
    if bytes.is_empty() || bytes.len() > MAX_VOICEOVER_BYTES {
        return Err("voiceover is empty or too large".into());
    }
    load_project(state, slug)?;
    let dir = project_root(state, slug)?.join("working").join("voiceover");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut n = 1;
    let path = loop {
        let p = dir.join(format!("vo_v{n:03}.{ext}"));
        if !p.exists() {
            break p;
        }
        n += 1;
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    finalize_asset(state, cfg, slug, &path, &name, "voiceover", false).inspect_err(|_| {
        let _ = std::fs::remove_file(&path);
    })
}

// ── Manifest ───────────────────────────────────────────────────────────────────

fn finite_in(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

/// Every rule of contract.ts `TimelineManifest`, checked against the project's assets.
pub(crate) fn validate_manifest(m: &TimelineManifest, slug: &str, assets: &[MediaAsset]) -> Result<(), String> {
    if m.version != 2 || m.project != slug {
        return Err("manifest is for another project or version".into());
    }
    if m.clips.len() > 200 || m.audio.len() > 50 || m.shot_list.len() > 30 {
        return Err("too many clips, audio layers or shot slots".into());
    }
    let by_id: HashMap<&str, &MediaAsset> = assets.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut ids = std::collections::HashSet::new();
    for c in &m.clips {
        if c.id.is_empty() || c.id.len() > 40 || !ids.insert(c.id.as_str()) {
            return Err(format!("bad or duplicate clip id {:?}", c.id));
        }
        let a = by_id.get(c.asset_id.as_str()).ok_or_else(|| format!("clip {} uses an asset that isn't in this project", c.id))?;
        if a.kind == "audio" {
            return Err(format!("clip {} is audio: put it on the audio lane", c.id));
        }
        if c.fade_ms > 2000 {
            return Err(format!("clip {}: fade over 2000 ms", c.id));
        }
        if !TRANSITIONS.contains(&c.transition_in.kind.as_str()) || c.transition_in.ms > 1500 {
            return Err(format!("clip {}: transition must be cut, crossfade or fade_black, 0–1500 ms", c.id));
        }
        if !finite_in(c.punch_in, 1.0, 1.5) {
            return Err(format!("clip {}: punch-in must be 1.0–1.5", c.id));
        }
        if a.kind == "image" {
            if c.in_sec != 0.0 || !finite_in(c.out_sec, 0.2, 60.0) {
                return Err(format!("still {} must hold 0.2–60 s", c.id));
            }
        } else {
            let dur = a.duration_sec.unwrap_or(0.0);
            if !(finite_in(c.in_sec, 0.0, dur) && finite_in(c.out_sec, 0.0, dur + 0.05) && c.in_sec < c.out_sec) {
                return Err(format!("clip {}: in/out {}–{} outside 0–{dur}", c.id, c.in_sec, c.out_sec));
            }
        }
    }
    for l in &m.audio {
        if l.id.is_empty() || l.id.len() > 40 || !ids.insert(l.id.as_str()) {
            return Err(format!("bad or duplicate audio id {:?}", l.id));
        }
        let a = by_id.get(l.asset_id.as_str()).ok_or_else(|| format!("audio {} uses an asset that isn't in this project", l.id))?;
        if a.kind == "image" {
            return Err(format!("audio {} is an image", l.id));
        }
        let dur = a.duration_sec.unwrap_or(0.0);
        if !(finite_in(l.start_sec, 0.0, 36_000.0) && finite_in(l.in_sec, 0.0, dur) && finite_in(l.out_sec, 0.0, dur + 0.05) && l.in_sec < l.out_sec && finite_in(l.volume, 0.0, 2.0)) {
            return Err(format!("audio {}: bad start/in/out/volume", l.id));
        }
        if l.fade_in_ms > 10_000 || l.fade_out_ms > 10_000 {
            return Err(format!("audio {}: fades must be 0–10000 ms", l.id));
        }
    }
    if !finite_in(m.clip_audio_volume, 0.0, 2.0) {
        return Err("clip audio volume must be 0–2".into());
    }
    if !["16:9", "9:16", "4:5", "1:1"].contains(&m.output.aspect.as_str()) || ![-14, -16, -18].contains(&m.output.loudness_lufs) {
        return Err("output aspect or loudness not allowed".into());
    }
    if m.output.max_size_mb.is_some_and(|x| !finite_in(x, 1.0, 4096.0)) || m.output.name.trim().is_empty() || m.output.name.chars().count() > 80 {
        return Err("output size cap or name not allowed".into());
    }
    for s in &m.shot_list {
        if s.id.is_empty() || s.id.len() > 40 || s.label.chars().count() > 120 || s.instructions.chars().count() > 1000 {
            return Err(format!("shot slot {:?} is too long", s.id));
        }
        if !["video", "image", "audio"].contains(&s.kind.as_str()) || !["needed", "attached", "approved"].contains(&s.status.as_str()) {
            return Err(format!("shot slot {}: bad kind or status", s.id));
        }
        if s.target_sec.is_some_and(|t| !finite_in(t, 0.0, 36_000.0)) {
            return Err(format!("shot slot {}: bad target length", s.id));
        }
        if let Some(a) = &s.asset_id {
            if !by_id.contains_key(a.as_str()) {
                return Err(format!("shot slot {} points at an asset that isn't in this project", s.id));
            }
        }
        if s.framing.as_deref().is_some_and(|f| !FRAMINGS.contains(&f)) || !SLOT_SOURCES.contains(&s.source.as_str()) {
            return Err(format!("shot slot {}: bad framing or source", s.id));
        }
        if s.action.chars().count() > 500 || s.phone_tips.len() > 4 || s.phone_tips.iter().any(|t| t.trim().is_empty() || t.chars().count() > 120) {
            return Err(format!("shot slot {}: action over 500 characters, or more than 4 phone tips (each 1–120 characters)", s.id));
        }
    }
    let slot_ids: HashSet<&str> = m.shot_list.iter().map(|s| s.id.as_str()).collect();
    if slot_ids.len() != m.shot_list.len() {
        return Err("duplicate shot slot id".into());
    }
    if !CAPTION_STYLES.contains(&m.captions.style.as_str()) || !["lower", "middle"].contains(&m.captions.position.as_str()) || !(1..=12).contains(&m.captions.max_words_per_line) {
        return Err("captions: bad style, position or words per line (1–12)".into());
    }
    if !COLOR_PRESETS.contains(&m.color.preset.as_str()) || !finite_in(m.color.strength, 0.0, 1.0) {
        return Err("color: bad preset or strength (0–1)".into());
    }
    if m.outputs.is_empty() || m.outputs.len() > 4 {
        return Err("give the manifest 1–4 outputs".into());
    }
    let mut platforms = HashSet::new();
    for o in &m.outputs {
        if !PLATFORMS.contains(&o.platform.as_str()) || !platforms.insert(o.platform.as_str()) {
            return Err(format!("output {:?}: unknown or repeated platform", o.platform));
        }
        if !ASPECTS.contains(&o.aspect.as_str()) || ![-14, -16, -18].contains(&o.loudness_lufs) {
            return Err(format!("output {}: aspect or loudness not allowed", o.platform));
        }
        if o.max_size_mb.is_some_and(|x| !finite_in(x, 1.0, 4096.0)) || o.max_sec.is_some_and(|x| !finite_in(x, 1.0, 600.0)) {
            return Err(format!("output {}: size cap 1–4096 MB, length cap 1–600 s", o.platform));
        }
    }
    validate_notes(&m.notes)?;
    if !["nic", "director"].contains(&m.updated_by.as_str()) {
        return Err("updatedBy must be nic or director".into());
    }
    Ok(())
}

fn validate_notes(notes: &[Note]) -> Result<(), String> {
    if notes.len() > MAX_NOTES {
        return Err(format!("more than {MAX_NOTES} review notes"));
    }
    let mut ids = HashSet::new();
    for n in notes {
        if n.id.is_empty() || n.id.len() > 40 || !ids.insert(n.id.as_str()) {
            return Err(format!("bad or duplicate note id {:?}", n.id));
        }
        if n.render_id.as_deref().is_some_and(|r| r.is_empty() || r.len() > 40) || n.at_sec.is_some_and(|t| !finite_in(t, 0.0, 36_000.0)) {
            return Err(format!("note {}: bad render id or time", n.id));
        }
        if n.text.trim().is_empty() || n.text.chars().count() > 2000 || n.by != "nic" || n.at.len() > 40 {
            return Err(format!("note {}: text must be 1–2000 characters, by nic", n.id));
        }
    }
    Ok(())
}

/// Every "film" slot has footage (the shooting → editing trigger; manifest.ts `filmSlotsFilled`).
pub(crate) fn film_slots_filled(m: &TimelineManifest) -> bool {
    let mut film = m.shot_list.iter().filter(|s| s.source == "film").peekable();
    film.peek().is_some() && film.all(|s| s.asset_id.is_some())
}

pub(crate) fn manifest_save(state: &MediaState, slug: &str, m: TimelineManifest) -> Result<TimelineManifest, String> {
    let _g = state.manifest_lock.lock().unwrap();
    load_project(state, slug)?;
    let root = project_root(state, slug)?;
    let current = load_manifest_strict(&root, slug)?;
    if m.revision != current.revision {
        return Err(format!("STALE_REVISION: the timeline changed (now revision {}); reload it", current.revision));
    }
    // A v1-shaped save is upgraded; notes are Rust's (note_add / note_resolve), never the client's copy.
    let mut m = upgrade_manifest(m);
    m.notes = current.notes;
    let assets = list_assets(state, slug)?;
    validate_manifest(&m, slug, &assets)?;
    m.revision = current.revision + 1;
    m.updated_at = now_iso();
    write_atomic(&manifest_path(&root), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())?;
    sync_slot_mirror(state, &m, &assets);
    // Contract §1: shooting → editing once every film slot is filled. Clips on the timeline also
    // mean editing has begun (kept from v1 so a quick edit without a shot list still moves on).
    if film_slots_filled(&m) || !m.clips.is_empty() {
        advance_status(state, slug, "editing");
    }
    Ok(m)
}

/// `MediaAsset.slotId` mirrors `ShotSlot.assetId`: after a save, every asset points at the slot
/// that holds it (or none).
fn sync_slot_mirror(state: &MediaState, m: &TimelineManifest, assets: &[MediaAsset]) {
    let holder: HashMap<&str, &str> = m.shot_list.iter().filter_map(|s| s.asset_id.as_deref().map(|a| (a, s.id.as_str()))).collect();
    for a in assets {
        let want = holder.get(a.id.as_str()).map(|s| s.to_string());
        if a.slot_id != want {
            let _ = state.with(|c| c.execute("UPDATE asset SET slot_id = ?3 WHERE project = ?1 AND id = ?2", params![a.project, a.id, want]).map(|_| ()).map_err(sql_err));
        }
    }
}

// ── v2: brief, project update, asset update ───────────────────────────────────

pub(crate) fn validate_brief(b: &CreativeBrief) -> Result<(), String> {
    if b.idea.trim().is_empty() || b.idea.chars().count() > 8000 {
        return Err("brief: the idea must be 1–8000 characters".into());
    }
    if b.goal.chars().count() > 300 || b.tone.chars().count() > 200 {
        return Err("brief: goal up to 300 characters, tone up to 200".into());
    }
    if !PLATFORMS.contains(&b.platform.as_str()) || !ASPECTS.contains(&b.aspect.as_str()) {
        return Err("brief: unknown platform or aspect".into());
    }
    if !finite_in(b.length_sec, 5.0, 600.0) {
        return Err("brief: length must be 5–600 s".into());
    }
    if b.references.len() > 10 || b.references.iter().any(|r| r.trim().is_empty() || r.chars().count() > 500) {
        return Err("brief: up to 10 references, each 1–500 characters".into());
    }
    let mut seen = HashSet::new();
    if b.guessed.iter().any(|g| !BRIEF_KEYS.contains(&g.as_str()) || !seen.insert(g.as_str())) {
        return Err("brief: \"guessed\" lists unknown or repeated fields".into());
    }
    if !["nic", "director"].contains(&b.updated_by.as_str()) {
        return Err("brief: updatedBy must be nic or director".into());
    }
    // Approval is Nic's click; a Director draft is only ever a suggestion.
    if b.approved && b.updated_by != "nic" {
        return Err("PERMISSION_REQUIRED: only Nic approves a brief".into());
    }
    Ok(())
}

pub(crate) fn project_update(state: &MediaState, slug: &str, title: Option<String>, brief: Option<CreativeBrief>, status: Option<String>, speed: Option<String>) -> Result<MediaProject, String> {
    let _g = state.project_lock.lock().unwrap();
    let mut p = load_project(state, slug)?;
    if let Some(t) = title {
        let t = t.trim();
        if t.is_empty() || t.chars().count() > 120 {
            return Err("give the project a title (up to 120 characters)".into());
        }
        p.title = t.into();
    }
    if let Some(s) = &speed {
        if !SPEEDS.contains(&s.as_str()) {
            return Err(format!("unknown speed {s:?}"));
        }
        p.speed = s.clone();
    }
    if let Some(mut b) = brief {
        validate_brief(&b)?;
        b.updated_at = now_iso();
        // Contract §1: an approved brief moves a project out of "brief".
        if b.approved && status.is_none() && p.status == "brief" {
            p.status = "shooting".into();
        }
        p.brief = Some(b);
    }
    if let Some(s) = status {
        if !PROJECT_STATUSES.contains(&s.as_str()) {
            return Err(format!("unknown project status {s:?}"));
        }
        p.status = s; // by hand: any status
    }
    p.updated_at = now_iso();
    save_project(state, &p)?;
    Ok(p)
}

/// Tags: trimmed, lowercase, 1–32 characters, ≤ 12, duplicates dropped.
pub(crate) fn clean_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = vec![];
    for t in tags {
        let t = t.trim().to_lowercase();
        if t.is_empty() || t.chars().count() > 32 || t.chars().any(|c| c.is_control()) {
            return Err(format!("tag {t:?} must be 1–32 characters"));
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    if out.len() > MAX_TAGS {
        return Err(format!("up to {MAX_TAGS} tags"));
    }
    Ok(out)
}

pub(crate) fn validate_moments(moments: &[Moment], asset: &MediaAsset) -> Result<(), String> {
    if moments.len() > MAX_MOMENTS {
        return Err(format!("up to {MAX_MOMENTS} moments per asset"));
    }
    let dur = asset.duration_sec.filter(|d| *d > 0.0).unwrap_or(86_400.0);
    let mut ids = HashSet::new();
    for m in moments {
        if m.id.is_empty() || m.id.len() > 40 || !ids.insert(m.id.as_str()) {
            return Err(format!("bad or duplicate moment id {:?}", m.id));
        }
        if !(finite_in(m.in_sec, 0.0, dur) && finite_in(m.out_sec, 0.0, dur + 0.05) && m.in_sec < m.out_sec) {
            return Err(format!("moment {}: in/out outside 0–{dur}", m.id));
        }
        if !finite_in(m.score, 0.0, 1.0) || m.label.chars().count() > 120 || !["director", "nic"].contains(&m.by.as_str()) {
            return Err(format!("moment {}: score 0–1, label up to 120 characters, by director or nic", m.id));
        }
    }
    Ok(())
}

/// `slot_id`: `None` leaves it, `Some("")` clears it (api.ts sends a contract `null` as ""), any
/// other value must be a slot in the saved shot list.
pub(crate) fn asset_update(state: &MediaState, slug: &str, asset_id: &str, tags: Option<Vec<String>>, moments: Option<Vec<Moment>>, slot_id: Option<String>) -> Result<MediaAsset, String> {
    load_project(state, slug)?;
    let mut a = load_asset(state, slug, asset_id)?;
    if let Some(t) = tags {
        a.tags = clean_tags(&t)?;
    }
    if let Some(ms) = moments {
        validate_moments(&ms, &a)?;
        a.moments = ms;
    }
    if let Some(s) = slot_id {
        if s.is_empty() {
            a.slot_id = None;
        } else {
            let m = load_manifest_strict(&project_root(state, slug)?, slug)?;
            if !m.shot_list.iter().any(|x| x.id == s) {
                return Err(format!("no shot slot {s:?} in this project"));
            }
            a.slot_id = Some(s);
        }
    }
    save_asset(state, &a)?;
    Ok(a)
}

// ── v2: review notes and rounds ───────────────────────────────────────────────

pub(crate) fn note_add(state: &MediaState, slug: &str, input: NoteInput) -> Result<Note, String> {
    let _g = state.manifest_lock.lock().unwrap();
    let _pg = state.project_lock.lock().unwrap();
    let mut p = load_project(state, slug)?;
    let root = project_root(state, slug)?;
    let text = input.text.trim().to_string();
    if let Some(r) = &input.render_id {
        if !list_renders(state, slug)?.iter().any(|x| &x.id == r) {
            return Err(format!("no verified render {r:?} in this project"));
        }
    }
    let note = Note { id: short_id("n"), render_id: input.render_id, at_sec: input.at_sec.map(|t| (t * 1000.0).round() / 1000.0), text, by: input.by, via_voice: input.via_voice, resolved: false, at: now_iso() };
    let mut m = load_manifest_strict(&root, slug)?;
    m.notes.push(note.clone());
    validate_notes(&m.notes)?;
    // Notes don't bump the revision: the editor's next save keeps them (manifest_save).
    write_atomic(&manifest_path(&root), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())?;
    if let Some(r) = &note.render_id {
        let renders = list_renders(state, slug)?;
        if let Some(round) = round_index(&p.review, r, &renders).map(|i| &mut p.review.rounds[i]) {
            round.notes.push(note.id.clone());
            p.updated_at = now_iso();
            save_project(state, &p)?;
        }
    }
    Ok(note)
}

pub(crate) fn note_resolve(state: &MediaState, slug: &str, note_id: &str) -> Result<(), String> {
    let _g = state.manifest_lock.lock().unwrap();
    load_project(state, slug)?;
    let root = project_root(state, slug)?;
    let mut m = load_manifest_strict(&root, slug)?;
    let n = m.notes.iter_mut().find(|n| n.id == note_id).ok_or_else(|| format!("no note {note_id:?}"))?;
    n.resolved = true;
    write_atomic(&manifest_path(&root), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())
}

/// Contract §5: a verified render opens a review round (round 1, then round 2; the round before it
/// becomes "revised"). There's no round 3: later renders add no round.
pub(crate) fn record_review_round(review: &mut ProjectReview, render_id: &str) {
    if review.rounds.len() >= 2 || review.rounds.iter().any(|r| r.render_id == render_id) {
        return;
    }
    for r in review.rounds.iter_mut().filter(|r| r.status == "open") {
        r.status = "revised".into();
    }
    review.rounds.push(ReviewRound { round: review.rounds.len() as u8 + 1, render_id: render_id.into(), notes: vec![], status: "open".into(), summary: String::new() });
}

// ── v2: intake (§3) ───────────────────────────────────────────────────────────

pub(crate) fn intake_status(state: &MediaState, slug: &str) -> Result<IntakeStatus, String> {
    load_project(state, slug)?;
    let root = project_root(state, slug)?;
    ensure_project_dirs(&root)?;
    let inbox = root.join("inbox");
    let pending = std::fs::read_dir(&inbox)
        .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false) && !e.file_name().to_string_lossy().starts_with('.')).count())
        .unwrap_or(0) as u32;
    let info = state.intake.lock().unwrap().get(slug).cloned().unwrap_or_default();
    Ok(IntakeStatus { inbox: dunce_canon(&inbox).unwrap_or(inbox).to_string_lossy().to_string(), pending, processing: info.processing, last_error: info.last_error })
}

/// The Whisper model the pipeline forces: the local **tiny.en** (media-forge resolves the name to the
/// copy already on disk and never downloads). small.en is better but a ~480 MB download: ask first.
pub(crate) const TRANSCRIBE_MODEL: &str = "tiny.en";
/// How long one transcription may take before the pipeline gives up on it.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// Brightness (8-bit YAVG, 16–235 video range) below / above which a shot is flagged.
const DARK_YAVG: f64 = 40.0;
const BRIGHT_YAVG: f64 = 225.0;
/// Peak level (dBFS) at or below which a track counts as silent.
const SILENT_DB: f64 = -50.0;

/// media-forge as the intake pipeline sees it: a tool call returning the tool's JSON. The app's
/// version goes through `mcp::call_tool` as the Director; tests pass a mock.
pub(crate) trait Forge {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String>;
}

/// The `media-intake` event (contract §8): `stage` = ingested | probed | transcribed | failed
/// ("matched" is the webview's, after its `match_footage` turn).
pub(crate) fn intake_event(slug: &str, asset_id: Option<&str>, stage: &str, detail: &str) -> Value {
    json!({ "slug": slug, "assetId": asset_id.unwrap_or(""), "stage": stage, "detail": detail.chars().take(800).collect::<String>() })
}

fn set_intake(state: &MediaState, slug: &str, f: impl FnOnce(&mut IntakeInfo)) {
    f(state.intake.lock().unwrap().entry(slug.to_string()).or_default());
}

fn intake_failed(state: &MediaState, slug: &str, asset_id: Option<&str>, err: &str, emit: &dyn Fn(Value)) {
    let err: String = err.chars().take(800).collect();
    eprintln!("[media intake] {slug}: {err}");
    set_intake(state, slug, |i| i.last_error = Some(err.clone()));
    emit(intake_event(slug, asset_id, "failed", &err));
}

/// The role a dropped file gets, from its extension (ingest fits it to the probed kind anyway).
pub(crate) fn role_for_ext(ext: &str) -> &'static str {
    match kind_for_ext(ext) {
        Some("image") => "photo",
        Some("audio") => "music",
        _ => "clip",
    }
}

/// Names the watcher leaves alone: hidden files and the partial files browsers / sync tools write.
fn inbox_ignored(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.starts_with('.') || l.starts_with('~') || [".part", ".partial", ".tmp", ".crdownload", ".download", ".opdownload"].iter().any(|x| l.ends_with(x))
}

/// The stable files in one inbox: present at the last tick with the same, non-zero size and the
/// same last-write time (not failed permanently at that state, and past any retry backoff).
/// Updates what was seen; forgets files that went away.
pub(crate) fn stable_inbox_files(state: &MediaState, inbox: &Path) -> Vec<InboxFile> {
    let mut now: Vec<InboxFile> = std::fs::read_dir(inbox)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false) && !inbox_ignored(&e.file_name().to_string_lossy()))
                .map(|e| {
                    let meta = e.metadata().ok();
                    InboxFile { path: e.path(), size: meta.as_ref().map(|m| m.len()).unwrap_or(0), mtime: meta.and_then(|m| m.modified().ok()) }
                })
                .collect()
        })
        .unwrap_or_default();
    now.sort_by(|a, b| a.path.cmp(&b.path));
    let mut seen = state.inbox_seen.lock().unwrap();
    seen.retain(|p, _| !p.starts_with(inbox) || now.iter().any(|f| &f.path == p));
    let at = std::time::Instant::now();
    let mut stable = vec![];
    for f in now {
        match seen.get(&f.path) {
            Some(s) if s.size == f.size && s.mtime == f.mtime => {
                // Empty, failed at this state, or backing off: wait.
                if f.size > 0 && !s.failed && s.retry_at.map_or(true, |t| at >= t) {
                    stable.push(f);
                }
            }
            _ => {
                seen.insert(f.path.clone(), InboxSeen::fresh(f.size, f.mtime));
            }
        }
    }
    stable
}

/// A permanent failure: skipped until the file changes.
fn mark_inbox_failed(state: &MediaState, f: &InboxFile) {
    state.inbox_seen.lock().unwrap().insert(f.path.clone(), InboxSeen { failed: true, ..InboxSeen::fresh(f.size, f.mtime) });
}

/// A transient failure: retried after 10 s, 20 s, 40 s … (capped at 10 min) while unchanged.
fn mark_inbox_retry(state: &MediaState, f: &InboxFile) {
    let mut seen = state.inbox_seen.lock().unwrap();
    let attempts = seen.get(&f.path).filter(|s| s.size == f.size && s.mtime == f.mtime).map_or(0, |s| s.attempts) + 1;
    let wait = Duration::from_secs((10u64 << attempts.saturating_sub(1).min(6)).min(600));
    seen.insert(f.path.clone(), InboxSeen { retry_at: Some(std::time::Instant::now() + wait), attempts, ..InboxSeen::fresh(f.size, f.mtime) });
}

/// Open the inbox file for reading only if nobody has it open for writing (Windows: no
/// FILE_SHARE_WRITE, so a copy/sync still writing it makes this fail). While the handle is held,
/// no one else can open it for writing either.
fn open_exclusive_read(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(0x0000_0001); // FILE_SHARE_READ only
    }
    o.open(path)
}

/// Byte-for-byte: does `a` (read from its start) hold exactly what the file at `b` holds?
fn same_content(a: &mut std::fs::File, b: &Path) -> std::io::Result<bool> {
    use std::io::Read;
    fn fill(f: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut n = 0;
        while n < buf.len() {
            match f.read(&mut buf[n..])? {
                0 => break,
                k => n += k,
            }
        }
        Ok(n)
    }
    a.seek(SeekFrom::Start(0))?;
    let mut fb = std::fs::File::open(b)?;
    let (mut x, mut y) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let (n, m) = (fill(a, &mut x)?, fill(&mut fb, &mut y)?);
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// media.db kv: an inbox file that was ingested but whose inbox copy couldn't be deleted, so a
/// later tick (or the next app start) only retries the delete and never ingests it twice.
fn inbox_ingested_key(path: &Path) -> String {
    format!("inbox-ingested:{}", path.to_string_lossy())
}

fn mtime_ms(t: Option<std::time::SystemTime>) -> u64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

fn remember_ingested(state: &MediaState, f: &InboxFile, asset_id: &str) {
    let v = json!({ "size": f.size, "mtimeMs": mtime_ms(f.mtime), "assetId": asset_id }).to_string();
    let _ = state.with(|c| c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![inbox_ingested_key(&f.path), v]).map(|_| ()).map_err(sql_err));
}

/// The asset an unchanged inbox file was already ingested as (a record for an older version of
/// the file is dropped).
fn already_ingested(state: &MediaState, f: &InboxFile) -> Option<String> {
    let key = inbox_ingested_key(&f.path);
    let v: Value = state.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [&key], |r| r.get::<_, String>(0)).optional().map_err(sql_err)).ok().flatten().and_then(|s| serde_json::from_str(&s).ok())?;
    if v["size"].as_u64() == Some(f.size) && v["mtimeMs"].as_u64() == Some(mtime_ms(f.mtime)) {
        return v["assetId"].as_str().map(String::from);
    }
    forget_ingested(state, &f.path);
    None
}

fn forget_ingested(state: &MediaState, path: &Path) {
    let _ = state.with(|c| c.execute("DELETE FROM kv WHERE key = ?1", [inbox_ingested_key(path)]).map(|_| ()).map_err(sql_err));
}

/// Ingest one stable inbox file, safely: the file is opened so no one else can be writing it,
/// copied into `raw/`, the copy compared byte for byte and the source re-checked (size and mtime
/// unchanged), and only then recorded as an asset. Nothing is recorded if any check fails. The
/// inbox copy is deleted last; `Ok((asset, Some(msg)))` = ingested, but the inbox copy is still
/// there (the caller remembers it so it's never ingested twice).
pub(crate) fn intake_ingest(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, f: &InboxFile) -> Result<(MediaAsset, Option<String>), IntakeFail> {
    use IntakeFail::{Permanent, Transient};
    let path = &f.path;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = ext_of(&name);
    if kind_for_ext(&ext).is_none() {
        return Err(Permanent(format!("{name}: not a supported video, photo or audio file (left in the inbox)")));
    }
    load_project(state, slug).map_err(Transient)?;
    let mut src = open_exclusive_read(path).map_err(|e| Transient(format!("{name} is still being written or is open elsewhere ({e}); retrying")))?;
    let ffprobe = media_bin(cfg, "ffprobe").ok_or_else(|| Transient("ffprobe not found (install FFmpeg or Shotcut); the inbox file is kept and retried".into()))?;
    let unchanged = |m: &std::fs::Metadata| m.len() == f.size && m.modified().ok() == f.mtime;
    if !src.metadata().map(|m| unchanged(&m)).unwrap_or(false) {
        return Err(Transient(format!("{name} changed since the last check; waiting for it to settle")));
    }
    let raw = project_root(state, slug).map_err(Transient)?.join("raw");
    std::fs::create_dir_all(&raw).map_err(|e| Transient(e.to_string()))?;
    let display = safe_file_name(&name);
    let dst = unique_path(&raw, &display);
    let copied = (|| -> std::io::Result<bool> {
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&dst)?;
        std::io::copy(&mut src, &mut out)?;
        out.sync_all()?;
        drop(out);
        same_content(&mut src, &dst)
    })();
    let fail = |e: String| {
        remove_staged(&dst);
        Err(Transient(e))
    };
    match copied {
        Err(e) => return fail(format!("copy {name}: {e}; the inbox copy is kept")),
        Ok(false) => return fail(format!("{name}: the raw/ copy doesn't match the inbox file; the inbox copy is kept")),
        Ok(true) => {}
    }
    if !std::fs::metadata(path).map(|m| unchanged(&m)).unwrap_or(false) {
        return fail(format!("{name} changed while it was copied; the inbox copy is kept"));
    }
    drop(src);
    // Media ffprobe can't read (or with no streams) stays unreadable until the file changes.
    let pr = match probe(&ffprobe, &dst) {
        Ok(pr) => pr,
        Err(e) => {
            remove_staged(&dst);
            return Err(Permanent(e));
        }
    };
    if kind_for_ext(&ext) != Some("image") && !pr.has_video && !pr.has_audio {
        remove_staged(&dst);
        return Err(Permanent(format!("{display}: no video or audio stream")));
    }
    let a = match finalize_asset(state, cfg, slug, &dst, &display, role_for_ext(&ext), true) {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    remove_staged(path);
    let left = path.exists().then(|| format!("{name} was ingested, but its inbox copy couldn't be removed (is it open somewhere?); retrying the delete"));
    Ok((a, left))
}

/// `(w, h)` against the brief's aspect: a flag when the ratio is more than 8% off.
pub(crate) fn aspect_flag(w: u32, h: u32, aspect: &str) -> Option<AssetFlag> {
    let (aw, ah) = aspect.split_once(':').and_then(|(a, b)| Some((a.parse::<f64>().ok()?, b.parse::<f64>().ok()?)))?;
    if w == 0 || h == 0 || aw <= 0.0 || ah <= 0.0 {
        return None;
    }
    let off = (w as f64 / h as f64) / (aw / ah);
    let shape = |r: f64| if r > 1.05 { "landscape" } else if r < 0.95 { "portrait" } else { "square" };
    ((off - 1.0).abs() > 0.08).then(|| AssetFlag { kind: "wrong_aspect".into(), detail: format!("{w}×{h} is {}; the brief is {aspect} ({})", shape(w as f64 / h as f64), shape(aw / ah)) })
}

/// Mean of the `lavfi.signalstats.YAVG=` lines ffmpeg's metadata filter prints.
pub(crate) fn parse_yavg(text: &str) -> Option<f64> {
    let v: Vec<f64> = text.lines().filter_map(|l| l.trim().strip_prefix("lavfi.signalstats.YAVG=")).filter_map(|x| x.trim().parse::<f64>().ok()).filter(|x| x.is_finite()).collect();
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

pub(crate) fn exposure_flag(yavg: f64) -> Option<AssetFlag> {
    let pct = ((yavg - 16.0) / 219.0 * 100.0).clamp(0.0, 100.0);
    if yavg < DARK_YAVG {
        Some(AssetFlag { kind: "dark".into(), detail: format!("mean brightness {pct:.0}%") })
    } else if yavg > BRIGHT_YAVG {
        Some(AssetFlag { kind: "overexposed".into(), detail: format!("mean brightness {pct:.0}%") })
    } else {
        None
    }
}

/// `max_volume: -91.0 dB` from ffmpeg's volumedetect.
pub(crate) fn parse_max_volume(text: &str) -> Option<f64> {
    text.lines().find_map(|l| l.split("max_volume:").nth(1)).and_then(|r| r.trim().trim_end_matches("dB").trim().parse().ok())
}

/// A cheap brightness sample: up to 5 frames (1 fps) from ~10 s near the start, scaled down,
/// 8-bit. `None` when ffmpeg isn't there or can't read it (the check is then skipped).
fn sample_yavg(ffmpeg: &str, path: &Path, kind: &str, duration: Option<f64>) -> Option<f64> {
    let p = path.to_string_lossy().to_string();
    let vf = "fps=1,scale=160:-2,format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-";
    let ss = format!("{:.2}", duration.map(|d| (d * 0.1).min(2.0)).unwrap_or(0.0));
    let mut args = vec!["-hide_banner", "-nostats", "-loglevel", "error"];
    if kind == "video" {
        args.extend(["-ss", ss.as_str(), "-t", "10"]);
    }
    args.extend(["-i", p.as_str(), "-vf", vf, "-frames:v", "5", "-an", "-f", "null", "-"]);
    let out = run_hidden(ffmpeg, &args, Duration::from_secs(90)).ok()?;
    parse_yavg(&String::from_utf8_lossy(&out.stdout))
}

/// Peak level of the first 10 minutes of audio (ffmpeg volumedetect, CPU).
fn sample_peak_db(ffmpeg: &str, path: &Path) -> Option<f64> {
    let p = path.to_string_lossy().to_string();
    let out = run_hidden(ffmpeg, &["-hide_banner", "-nostats", "-t", "600", "-i", &p, "-vn", "-af", "volumedetect", "-f", "null", "-"], Duration::from_secs(180)).ok()?;
    parse_max_volume(&String::from_utf8_lossy(&out.stderr))
}

/// Probe-based flags (contract §3): too_short (< 1 s), wrong_aspect (vs the brief), dark /
/// overexposed (signalstats sample, skipped without ffmpeg), silent (no audio track, or a peak at
/// or below -50 dBFS). Returns the flags and whether there is sound worth transcribing.
pub(crate) fn probe_flags(cfg: &os_core::OsConfig, a: &MediaAsset, brief_aspect: Option<&str>) -> Result<(Vec<AssetFlag>, bool), String> {
    let path = PathBuf::from(&a.path);
    let ffprobe = media_bin(cfg, "ffprobe").ok_or("ffprobe not found (install FFmpeg or Shotcut)")?;
    let pr = probe(&ffprobe, &path)?;
    let ffmpeg = media_bin(cfg, "ffmpeg");
    let mut flags = vec![];
    let dur = a.duration_sec.or(pr.duration);
    if a.kind != "image" && dur.is_some_and(|d| d < 1.0) {
        flags.push(AssetFlag { kind: "too_short".into(), detail: format!("{:.2} s long", dur.unwrap_or(0.0)) });
    }
    if a.kind != "audio" {
        if let (Some(asp), Some(w), Some(h)) = (brief_aspect, a.width.or(pr.width), a.height.or(pr.height)) {
            flags.extend(aspect_flag(w, h, asp));
        }
        if let Some(y) = ffmpeg.as_deref().and_then(|ff| sample_yavg(ff, &path, &a.kind, a.duration_sec)) {
            flags.extend(exposure_flag(y));
        }
    }
    let mut sound = false;
    if a.kind != "image" {
        if !pr.has_audio {
            flags.push(AssetFlag { kind: "silent".into(), detail: "no audio track".into() });
        } else {
            // One volumedetect pass gives both: silent (peak ≤ -50 dBFS) and clipped (peak ≥ -0.1 dBFS).
            let peak = ffmpeg.as_deref().and_then(|ff| sample_peak_db(ff, &path));
            match peak {
                Some(db) if db <= SILENT_DB => flags.push(AssetFlag { kind: "silent".into(), detail: format!("peak {db:.0} dBFS") }),
                _ => sound = true,
            }
            flags.extend(peak.and_then(clipped_flag));
        }
    }
    Ok((flags, sound))
}

/// Peak level (dBFS) at or above which a track counts as clipped (volumedetect prints one decimal).
const CLIPPED_DB: f64 = -0.1;

/// `clipped_audio` from a volumedetect peak (contract §3 flag kinds).
pub(crate) fn clipped_flag(peak_db: f64) -> Option<AssetFlag> {
    (peak_db.is_finite() && peak_db >= CLIPPED_DB).then(|| AssetFlag { kind: "clipped_audio".into(), detail: format!("peak {peak_db:.1} dBFS: the loudest parts may be distorted") })
}

/// How long one scene detection may take before the pipeline gives up on it.
const SCENES_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// At most this many cut times are kept on an asset.
pub(crate) const MAX_SCENE_CUTS: usize = 200;

/// Cut times (seconds, ms precision, ascending, > 0) from media-forge detect_scenes' result
/// (`{scene_count, scenes: [{index, start, end, duration}]}`): every scene start but the first.
pub(crate) fn scene_cuts(result: &Value) -> Result<Vec<f64>, String> {
    let scenes = result["scenes"].as_array().ok_or("detect_scenes returned no scenes")?;
    let mut cuts: Vec<f64> = scenes.iter().filter_map(|s| s["start"].as_f64()).filter(|t| t.is_finite() && *t > 0.001).map(|t| (t * 1000.0).round() / 1000.0).collect();
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    cuts.dedup();
    cuts.truncate(MAX_SCENE_CUTS);
    Ok(cuts)
}

/// CPU shot detection of one video asset through media-forge `detect_scenes` (no thumbnails);
/// stores the cut times on the asset.
pub(crate) fn detect_asset_scenes(state: &MediaState, forge: &dyn Forge, slug: &str, asset_id: &str) -> Result<Vec<f64>, String> {
    let a = load_asset(state, slug, asset_id)?;
    if a.kind != "video" {
        return Err(format!("{}: only video has shots", a.name));
    }
    let args = json!({ "path": a.path, "project": slug, "thumbnails": false, "wait_s": 0 });
    let cuts = scene_cuts(&forge_job(forge, "detect_scenes", &args, SCENES_TIMEOUT)?)?;
    let mut a = load_asset(state, slug, asset_id)?;
    a.scenes = Some(cuts.clone());
    save_asset(state, &a)?;
    Ok(cuts)
}

/// Flags of the given kinds are replaced by `fresh` (other kinds, e.g. media-forge's, are kept).
pub(crate) fn merge_flags(old: &[AssetFlag], fresh: Vec<AssetFlag>, kinds: &[&str]) -> Vec<AssetFlag> {
    let mut out: Vec<AssetFlag> = old.iter().filter(|f| !kinds.contains(&f.kind.as_str())).cloned().collect();
    for f in fresh {
        if !out.iter().any(|x| x.kind == f.kind) {
            out.push(f);
        }
    }
    out
}

const PROBE_FLAG_KINDS: [&str; 6] = ["too_short", "wrong_aspect", "dark", "overexposed", "silent", "clipped_audio"];

/// The transcript summary stored on the asset, from media-forge's transcribe .json
/// (`{language, segments: [{start, end, text, words?: [{w, s, e, p}]}]}`).
pub(crate) fn transcript_summary(path: &str, json_text: &str) -> Result<AssetTranscript, String> {
    let v: Value = serde_json::from_str(json_text).map_err(|e| format!("transcript {path}: {e}"))?;
    let segs = v["segments"].as_array().ok_or_else(|| format!("transcript {path}: no segments"))?;
    let (mut words, mut first, mut last) = (0u32, None::<f64>, None::<f64>);
    for s in segs {
        let ws = s["words"].as_array().filter(|w| !w.is_empty());
        let n = match ws {
            Some(w) => w.iter().filter(|x| x["w"].as_str().is_some_and(|t| !t.trim().is_empty())).count(),
            None => s["text"].as_str().map(|t| t.split_whitespace().count()).unwrap_or(0),
        };
        if n == 0 {
            continue;
        }
        words += n as u32;
        let start = ws.and_then(|w| w.first()).and_then(|x| x["s"].as_f64()).or(s["start"].as_f64());
        let end = ws.and_then(|w| w.last()).and_then(|x| x["e"].as_f64()).or(s["end"].as_f64());
        first = first.or(start);
        last = end.or(last);
    }
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    Ok(AssetTranscript { path: path.into(), lang: v["language"].as_str().unwrap_or("en").chars().take(12).collect(), words, first_speech_sec: first.map(r3), last_speech_sec: last.map(r3) })
}

/// Start a media-forge job tool and wait for it (job_status long-polls), up to `timeout`.
pub(crate) fn forge_job(forge: &dyn Forge, tool: &str, args: &Value, timeout: Duration) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut v = forge.call(tool, args)?;
    loop {
        match v["status"].as_str() {
            Some("done") => return Ok(v["result"].clone()),
            Some("queued" | "running") => {}
            Some("cancelled") => return Err(format!("{tool} was cancelled")),
            Some(_) => return Err(v["error"].as_str().unwrap_or("the job failed").to_string()),
            None => return Err(format!("media-forge did not start a {tool} job: {}", v.to_string().chars().take(300).collect::<String>())),
        }
        let id = v["id"].as_str().ok_or("job without an id")?.to_string();
        if std::time::Instant::now() >= deadline {
            let _ = forge.call("job_cancel", &json!({ "job_id": id }));
            return Err(format!("{tool} took longer than {} min; cancelled", timeout.as_secs() / 60));
        }
        v = forge.call("job_status", &json!({ "job_id": id, "wait_s": 30 }))?;
    }
}

/// CPU transcription of one asset through media-forge `transcribe_batch` (local tiny.en, output
/// stem = the asset id → `working/captions/<id>.json`). Stores the summary; 0 words → `no_speech`.
pub(crate) fn transcribe_asset(state: &MediaState, forge: &dyn Forge, slug: &str, asset_id: &str) -> Result<AssetTranscript, String> {
    let a = load_asset(state, slug, asset_id)?;
    if a.kind == "image" {
        return Err(format!("{}: a photo has nothing to transcribe", a.name));
    }
    let args = json!({ "paths": [a.path], "project": slug, "model": TRANSCRIBE_MODEL, "output_stems": [a.id], "word_timestamps": true, "wait_s": 0 });
    let res = forge_job(forge, "transcribe_batch", &args, TRANSCRIBE_TIMEOUT)?;
    let item = res["results"].as_array().and_then(|r| r.first()).cloned().ok_or("transcribe_batch returned no result")?;
    if item["ok"].as_bool() != Some(true) {
        return Err(format!("{}: {}", a.name, item["error"].as_str().unwrap_or("transcription failed")));
    }
    let jpath = PathBuf::from(item["json"].as_str().ok_or("transcribe_batch returned no .json path")?);
    let root = project_root(state, slug)?;
    if !inside(&jpath, &root) {
        return Err("the transcript landed outside this project".into());
    }
    let canon = dunce_canon(&jpath).unwrap_or(jpath.clone()).to_string_lossy().to_string();
    let t = transcript_summary(&canon, &std::fs::read_to_string(&jpath).map_err(|e| format!("read {}: {e}", jpath.display()))?)?;
    // Re-read before writing: Nic may have tagged it meanwhile.
    let mut a = load_asset(state, slug, asset_id)?;
    let speech = if t.words == 0 { vec![AssetFlag { kind: "no_speech".into(), detail: "no words heard".into() }] } else { vec![] };
    a.flags = merge_flags(&a.flags, speech, &["no_speech"]);
    a.transcript = Some(t.clone());
    save_asset(state, &a)?;
    Ok(t)
}

/// One pipeline pass (one asset): probe flags (new intake files), then transcription when there's
/// sound. Each stage emits `media-intake`; a failure ends the pass with the error.
pub(crate) fn run_intake_job(state: &MediaState, cfg: &os_core::OsConfig, forge: &dyn Forge, job: &IntakeJob, emit: &dyn Fn(Value)) -> Result<(), String> {
    let (slug, id) = (job.slug.as_str(), job.asset_id.as_str());
    let a = load_asset(state, slug, id)?;
    set_intake(state, slug, |i| i.processing = Some(a.name.clone()));
    let mut transcribe = a.kind != "image";
    if job.analyze {
        let aspect = load_project(state, slug)?.brief.map(|b| b.aspect);
        let (flags, sound) = probe_flags(cfg, &a, aspect.as_deref())?;
        let mut fresh = load_asset(state, slug, id)?;
        fresh.flags = merge_flags(&fresh.flags, flags, &PROBE_FLAG_KINDS);
        save_asset(state, &fresh)?;
        let mut detail = if fresh.flags.is_empty() { "no problems found".to_string() } else { fresh.flags.iter().map(|f| f.kind.as_str()).collect::<Vec<_>>().join(", ") };
        // Shot cuts (CPU) before "probed", so the refresh that event triggers carries them. Optional:
        // without PySceneDetect / Media Forge the pass carries on to transcription.
        if a.kind == "video" {
            match detect_asset_scenes(state, forge, slug, id) {
                Ok(cuts) => detail.push_str(&format!("; {} shot{}", cuts.len() + 1, if cuts.is_empty() { "" } else { "s" })),
                Err(e) => eprintln!("[media intake] {slug}/{id}: scene detection skipped: {e}"),
            }
        }
        emit(intake_event(slug, Some(id), "probed", &detail));
        transcribe &= sound;
    }
    if transcribe {
        let t = transcribe_asset(state, forge, slug, id)?;
        emit(intake_event(slug, Some(id), "transcribed", &format!("{} words ({})", t.words, t.lang)));
    }
    Ok(())
}

/// One pass of the watched-folder intake (contract §3), for every project: ingest the inbox files
/// that are stable (size unchanged across two ticks), then run the queued pipeline passes one at a
/// time. Each error lands in that project's `lastError` and a `failed` event; the pass carries on.
pub(crate) fn intake_tick_once(state: &MediaState, cfg: &os_core::OsConfig, forge: &dyn Forge, emit: &dyn Fn(Value)) -> Result<(), String> {
    let slugs: Vec<String> = state.with(|c| {
        let mut st = c.prepare("SELECT slug FROM project ORDER BY slug").map_err(sql_err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })?;
    for slug in &slugs {
        let Ok(root) = project_root(state, slug) else { continue };
        let inbox = root.join("inbox");
        if !inbox.is_dir() {
            continue;
        }
        for f in stable_inbox_files(state, &inbox) {
            // Ingested before, but its inbox copy couldn't be deleted: retry only the delete.
            if already_ingested(state, &f).is_some() {
                remove_staged(&f.path);
                if f.path.exists() {
                    mark_inbox_retry(state, &f);
                } else {
                    forget_ingested(state, &f.path);
                    state.inbox_seen.lock().unwrap().remove(&f.path);
                }
                continue;
            }
            let name = f.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            set_intake(state, slug, |i| i.processing = Some(name.clone()));
            match intake_ingest(state, cfg, slug, &f) {
                Ok((a, left)) => {
                    emit(intake_event(slug, Some(&a.id), "ingested", &a.name));
                    state.transcribe_queue.lock().unwrap().push_back(IntakeJob { slug: slug.clone(), asset_id: a.id.clone(), analyze: true });
                    match left {
                        None => {
                            state.inbox_seen.lock().unwrap().remove(&f.path);
                        }
                        Some(msg) => {
                            remember_ingested(state, &f, &a.id);
                            mark_inbox_retry(state, &f);
                            intake_failed(state, slug, None, &msg, emit);
                        }
                    }
                }
                Err(e) => {
                    match &e {
                        IntakeFail::Permanent(_) => mark_inbox_failed(state, &f),
                        IntakeFail::Transient(_) => mark_inbox_retry(state, &f),
                    }
                    intake_failed(state, slug, None, e.text(), emit);
                }
            }
            set_intake(state, slug, |i| i.processing = None);
        }
    }
    loop {
        let Some(job) = state.transcribe_queue.lock().unwrap().pop_front() else { break };
        match run_intake_job(state, cfg, forge, &job, emit) {
            Ok(()) => set_intake(state, &job.slug, |i| i.last_error = None),
            Err(e) => intake_failed(state, &job.slug, Some(&job.asset_id), &e, emit),
        }
        set_intake(state, &job.slug, |i| i.processing = None);
    }
    Ok(())
}

/// media-forge through the MCP layer, as the Director (media servers only; CPU). Runs on the intake
/// thread, which is not an async context, so it may block on the call.
struct AppForge(tauri::AppHandle);

impl Forge for AppForge {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        let app = &self.0;
        if !app.state::<OsState>().snapshot().mcps.iter().any(|m| m.id == "media-forge" && m.enabled) {
            return Err("Media Forge is off: turn it on in Settings → MCP Registry to transcribe".into());
        }
        let name = format!("media-forge.{tool}");
        let text = tauri::async_runtime::block_on(async {
            let (d, o, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
            super::mcp::call_tool(&d, &o, &b, &name, args, true, "director").await
        })?;
        Ok(tool_json(&text))
    }
}

/// The 10-second intake tick (contract §3), on its own thread so a long transcription never holds
/// the UI or the async runtime. Spawned once from lib.rs.
pub fn spawn_intake(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new().name("media-intake".into()).spawn(move || {
        let forge = AppForge(app.clone());
        let emit = |v: Value| {
            let _ = app.emit(INTAKE_EVENT, v);
        };
        loop {
            std::thread::sleep(Duration::from_secs(10));
            let cfg = app.state::<OsState>().snapshot();
            let st = app.state::<MediaState>();
            let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| intake_tick_once(&st, &cfg, &forge, &emit)));
            match run {
                Ok(Err(e)) => eprintln!("[media intake] {e}"),
                Err(_) => eprintln!("[media intake] a tick panicked; carrying on"),
                Ok(Ok(())) => {}
            }
        }
    });
    if let Err(e) = spawned {
        eprintln!("[media intake] could not start: {e}");
    }
}

/// `media_transcribe`: queue video/audio assets for the CPU transcription pass (the intake
/// thread drains the queue within 10 s). Returns how many were newly queued.
pub(crate) fn transcribe_enqueue(state: &MediaState, slug: &str, asset_ids: &[String]) -> Result<u32, String> {
    load_project(state, slug)?;
    if asset_ids.is_empty() || asset_ids.len() > 50 {
        return Err("pick between 1 and 50 assets".into());
    }
    let assets = list_assets(state, slug)?;
    for id in asset_ids {
        let a = assets.iter().find(|a| &a.id == id).ok_or_else(|| format!("no asset {id:?} in this project"))?;
        if a.kind == "image" {
            return Err(format!("{}: a photo has nothing to transcribe", a.name));
        }
    }
    let mut q = state.transcribe_queue.lock().unwrap();
    let mut n = 0;
    for id in asset_ids {
        if !q.iter().any(|j| j.slug == slug && &j.asset_id == id) {
            q.push_back(IntakeJob { slug: slug.into(), asset_id: id.clone(), analyze: false });
            n += 1;
        }
    }
    Ok(n)
}

// ── v2: approve final (§6) ───────────────────────────────────────────────────

/// Which output a render was made for, when the batch didn't record it (renders from before v2):
/// the first output whose frame size matches, else "custom".
pub(crate) fn platform_for_render(r: &VerifiedRender, outputs: &[PlatformPreset]) -> String {
    outputs.iter().find(|o| dims_for(&o.aspect) == (r.width, r.height)).map(|o| o.platform.clone()).unwrap_or_else(|| "custom".into())
}

fn copy_verified(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("render has no file name")?;
    let size = std::fs::metadata(src).map(|m| m.len()).map_err(|e| e.to_string())?;
    let same = dir.join(&name);
    if std::fs::metadata(&same).map(|m| m.len() == size).unwrap_or(false) {
        return Ok(same); // approved before: idempotent
    }
    let dst = unique_path(dir, &name);
    std::fs::copy(src, &dst).map_err(|e| format!("copy {name}: {e}"))?;
    if std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0) != size {
        let _ = std::fs::remove_file(&dst);
        return Err(format!("the copy of {name} is incomplete"));
    }
    Ok(dst)
}

/// A sidecar next to the render with the same stem (captions: .srt/.ass/.vtt, thumb: .jpg/.png).
fn sidecar(render: &Path, exts: &[&str]) -> Option<PathBuf> {
    let stem = render.file_stem()?.to_string_lossy().to_string();
    let dir = render.parent()?;
    exts.iter().map(|e| dir.join(format!("{stem}.{e}"))).find(|p| p.is_file())
}

/// "Approve final": copies each verified render (and its caption/thumb sidecars) to
/// `renders/final/<platform>/`, marks the review rounds approved and moves the project to done.
/// Only from Nic's click (`approved: true`); nothing is posted or deleted.
pub(crate) fn approve_final(state: &MediaState, slug: &str, render_ids: &[String], approved: bool) -> Result<Vec<Deliverable>, String> {
    if !approved {
        return Err("PERMISSION_REQUIRED:media-approve-final — Nic approves the final cut".into());
    }
    load_project(state, slug)?;
    let unique: HashSet<&String> = render_ids.iter().collect();
    if render_ids.is_empty() || render_ids.len() > 4 || unique.len() != render_ids.len() {
        return Err("approve 1–4 different renders".into());
    }
    let root = project_root(state, slug)?;
    let renders = list_renders(state, slug)?;
    let m = load_manifest_strict(&root, slug)?;
    let mut picked = vec![];
    for id in render_ids {
        let r = renders.iter().find(|r| &r.id == id).ok_or_else(|| format!("no verified render {id:?} in this project"))?;
        let path = PathBuf::from(&r.path);
        if !r.verify.ok || !path.is_file() || !inside(&path, &state.projects_root()) {
            return Err(format!("render {id} isn't a verified file inside this project any more"));
        }
        if std::fs::metadata(&path).map(|x| x.len()).unwrap_or(0) != r.size_bytes {
            return Err(format!("render {id} changed on disk since it was verified"));
        }
        picked.push((r.clone(), path));
    }
    let mut out = vec![];
    for (r, path) in picked {
        let platform = stored_platform(state, &r.id).filter(|p| PLATFORMS.contains(&p.as_str())).unwrap_or_else(|| platform_for_render(&r, &m.outputs));
        let dir = root.join("renders").join("final").join(&platform);
        let file = copy_verified(&path, &dir)?;
        let caption = sidecar(&path, &["srt", "ass", "vtt"]).map(|c| copy_verified(&c, &dir)).transpose()?;
        let thumb = sidecar(&path, &["jpg", "png"]).map(|t| copy_verified(&t, &dir)).transpose()?;
        let s = |p: PathBuf| dunce_canon(&p).unwrap_or(p).to_string_lossy().to_string();
        out.push(Deliverable { platform, render_id: r.id.clone(), path: s(file), caption_path: caption.map(s), thumb_path: thumb.map(s) });
    }
    // The copies can take minutes: only now take the lock and re-load, so a note, round or brief
    // written meanwhile isn't overwritten by a stale copy.
    let _g = state.project_lock.lock().unwrap();
    let mut p = load_project(state, slug)?;
    let renders = list_renders(state, slug)?;
    let hit: Vec<usize> = render_ids.iter().filter_map(|id| round_index(&p.review, id, &renders)).collect();
    for i in hit {
        p.review.rounds[i].status = "approved".into();
    }
    p.status = "done".into();
    p.updated_at = now_iso();
    save_project(state, &p)?;
    // Kept so the deliverables (and the Biz Ops entry point) survive a project switch or restart.
    let j = serde_json::to_string(&out).map_err(|e| e.to_string())?;
    state.with(|c| c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![format!("deliverables:{slug}"), j]).map(|_| ()).map_err(sql_err))?;
    Ok(out)
}

/// The deliverables of the last "Approve final", still on disk (a file that's gone is dropped).
pub(crate) fn deliverables_get(state: &MediaState, slug: &str) -> Result<Vec<Deliverable>, String> {
    load_project(state, slug)?;
    let j = state.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [format!("deliverables:{slug}")], |r| r.get::<_, String>(0)).optional().map_err(sql_err))?;
    let all: Vec<Deliverable> = j.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    Ok(all.into_iter().filter(|d| Path::new(&d.path).is_file()).collect())
}

#[tauri::command]
pub async fn media_deliverables_get(app: tauri::AppHandle, slug: String) -> Result<Vec<Deliverable>, String> {
    blocking(move || deliverables_get(&app.state::<MediaState>(), &slug)).await
}

// ── Chat ───────────────────────────────────────────────────────────────────────

pub(crate) fn chat_log(state: &MediaState, slug: &str, append: Option<(String, String)>) -> Result<Vec<ChatLine>, String> {
    load_project(state, slug)?;
    let path = project_root(state, slug)?.join("working").join("chat.jsonl");
    if let Some((role, text)) = append {
        if !["nic", "director"].contains(&role.as_str()) {
            return Err("chat role must be nic or director".into());
        }
        let line = ChatLine { role, text: text.chars().take(20_000).collect(), at: now_iso() };
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
        writeln!(f, "{}", serde_json::to_string(&line).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<ChatLine> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let skip = lines.len().saturating_sub(CHAT_KEEP);
    Ok(lines.into_iter().skip(skip).collect())
}

// ── Render plan / spec ─────────────────────────────────────────────────────────

pub(crate) fn dims_for(aspect: &str) -> (u32, u32) {
    match aspect {
        "9:16" => (1080, 1920),
        "4:5" => (1080, 1350),
        "1:1" => (1080, 1080),
        _ => (1920, 1080),
    }
}

/// Contract §5: after round 2 the Director only lists open decisions; a third Director render
/// (a third revise) is refused. Nic can still render by hand (it adds no round).
pub(crate) fn check_review_limit(review: &ProjectReview, proposed_by: &str) -> Result<(), String> {
    if proposed_by == "director" && review.rounds.len() >= 2 {
        return Err("REVIEW_LIMIT: this cut has had its 2 review rounds, so there's no round 3. The Director lists the open decisions instead; Nic can still start a render by hand.".into());
    }
    Ok(())
}

pub(crate) fn build_plan(state: &MediaState, slug: &str, proposed_by: &str) -> Result<RenderPlan, String> {
    if !["director", "nic"].contains(&proposed_by) {
        return Err("proposedBy must be director or nic".into());
    }
    let p = load_project(state, slug)?;
    check_review_limit(&p.review, proposed_by)?;
    let root = project_root(state, slug)?;
    let m = load_manifest_strict(&root, slug)?;
    if m.clips.is_empty() {
        return Err("the timeline has no clips yet".into());
    }
    let assets = list_assets(state, slug)?;
    validate_manifest(&m, slug, &assets)?;
    // Every output's spec must build now (e.g. captions need transcripts), not after approval.
    for o in &m.outputs {
        render_spec(&m, &assets, o, &root)?;
    }
    let name_of = |id: &str| assets.iter().find(|a| a.id == id).map(|a| a.name.clone()).unwrap_or_default();
    let plan = RenderPlan {
        plan_id: short_id("p"),
        project: slug.into(),
        manifest_revision: m.revision,
        sources: m.clips.iter().map(|c| PlanSource { asset_id: c.asset_id.clone(), name: name_of(&c.asset_id), in_sec: c.in_sec, out_sec: c.out_sec }).collect(),
        audio: m.audio.iter().map(|l| PlanAudio { asset_id: l.asset_id.clone(), name: name_of(&l.asset_id), start_sec: l.start_sec, volume: l.volume }).collect(),
        output_name: slugify(&m.output.name),
        output_spec: outputs_text(&m),
        render_mode: "cpu_only".into(),
        proposed_by: proposed_by.into(),
    };
    let j = serde_json::to_string(&plan).map_err(|e| e.to_string())?;
    state.with(|c| c.execute("INSERT INTO plan (id, project, json) VALUES (?1, ?2, ?3)", params![plan.plan_id, slug, j]).map(|_| ()).map_err(sql_err))?;
    Ok(plan)
}

/// The plan card's output line: one entry per output ("reels 1080×1920 · … | youtube …"); a single
/// custom output reads exactly as v1 did. v2 looks (captions, colour, transitions) are appended.
pub(crate) fn outputs_text(m: &TimelineManifest) -> String {
    let total = expected_duration(m);
    let one = |o: &PlatformPreset| {
        let (w, h) = dims_for(&o.aspect);
        let cap = o.max_size_mb.map(|x| format!(" · ≤ {x} MB")).unwrap_or_default();
        let over = o.max_sec.filter(|s| total > *s + 0.05).map(|s| format!(" · over its {s:.0} s cap")).unwrap_or_default();
        format!("{w}×{h} · H.264/AAC · {} LUFS · {total:.1} s{cap}{over}", o.loudness_lufs)
    };
    let mut s = match m.outputs.as_slice() {
        [o] if o.platform == "custom" => one(o),
        outs => outs.iter().map(|o| format!("{} {}", o.platform, one(o))).collect::<Vec<_>>().join(" | "),
    };
    let mut extra = vec![];
    if m.captions.enabled {
        extra.push(format!("captions {}", m.captions.style));
    }
    if m.color.preset != "none" && m.color.strength > 0.0 {
        extra.push(format!("{} look", m.color.preset));
    }
    let xf = m.clips.iter().enumerate().filter(|(k, c)| spec_transition(*k, c).0 != "cut").count();
    if xf > 0 {
        extra.push(format!("{xf} transition{}", if xf == 1 { "" } else { "s" }));
    }
    if !extra.is_empty() {
        s.push_str(&format!(" · {}", extra.join(" · ")));
    }
    s
}

fn load_plan(state: &MediaState, plan_id: &str) -> Result<RenderPlan, String> {
    state
        .with(|c| c.query_row("SELECT json FROM plan WHERE id = ?1", [plan_id], |r| r.get::<_, String>(0)).optional().map_err(sql_err))?
        .ok_or_else(|| format!("no render plan {plan_id:?}"))
        .and_then(|j| serde_json::from_str(&j).map_err(|e| e.to_string()))
}

/// Does the manifest use anything spec v1 can't express? A v1 (or v1-equivalent) manifest keeps
/// the v1 spec, so old projects render exactly as before.
pub(crate) fn needs_spec_v2(m: &TimelineManifest) -> bool {
    m.clips.iter().enumerate().any(|(k, c)| spec_transition(k, c).0 != "cut" || c.punch_in != 1.0)
        || m.audio.iter().any(|l| l.fade_in_ms > 0 || l.fade_out_ms > 0 || l.duck_under_voice)
        || m.captions.enabled
        || (m.color.preset != "none" && m.color.strength > 0.0)
}

/// The transition media-forge will apply: 0 ms is a cut, and the first clip can't crossfade
/// (from nothing), so it cuts in.
pub(crate) fn spec_transition(k: usize, c: &TimelineClip) -> (&str, u32) {
    match c.transition_in.kind.as_str() {
        _ if c.transition_in.ms == 0 => ("cut", 0),
        "crossfade" if k == 0 => ("cut", 0),
        "crossfade" => ("crossfade", c.transition_in.ms),
        "fade_black" => ("fade_black", c.transition_in.ms),
        _ => ("cut", 0),
    }
}

/// The render's expected length, as media-forge lays it out: each crossfade overlaps its clips by
/// its length, capped at 45% of the shorter neighbour (fade_black dips without overlap).
pub(crate) fn expected_duration(m: &TimelineManifest) -> f64 {
    let lens: Vec<f64> = m.clips.iter().map(|c| c.out_sec - c.in_sec).collect();
    if !needs_spec_v2(m) {
        return lens.iter().sum();
    }
    let mut t = 0.0;
    for (k, c) in m.clips.iter().enumerate() {
        if let ("crossfade", ms) = spec_transition(k, c) {
            let cap = lens[k].min(lens[k - 1]) * 0.45;
            t -= ((ms as f64 / 1000.0).min(cap) * 1000.0).round() / 1000.0;
        }
        t += lens[k];
    }
    t
}

/// A transcript file on disk for a clip's asset (stored absolute; a relative one is under the project).
fn transcript_file(a: &MediaAsset, root: &Path) -> Option<String> {
    let t = a.transcript.as_ref()?;
    let p = PathBuf::from(&t.path);
    let p = if p.is_absolute() { p } else { root.join(p) };
    p.is_file().then(|| dunce_canon(&p).unwrap_or(p).to_string_lossy().to_string())
}

/// The media-forge `render_timeline` spec for one output of an approved plan (paths resolved from
/// the project's own assets; nothing from the model). Spec v2 (transitions, punch-in, layer fades
/// and ducking, captions from each clip's transcript, colour) when the manifest uses any of it,
/// else the v1 spec unchanged.
pub(crate) fn render_spec(m: &TimelineManifest, assets: &[MediaAsset], out: &PlatformPreset, root: &Path) -> Result<Value, String> {
    let by_id: HashMap<&str, &MediaAsset> = assets.iter().map(|a| (a.id.as_str(), a)).collect();
    let (w, h) = dims_for(&out.aspect);
    let v2 = needs_spec_v2(m);
    let mut any_transcript = false;
    let mut clips = vec![];
    for (k, c) in m.clips.iter().enumerate() {
        let a = by_id.get(c.asset_id.as_str()).ok_or("clip asset missing")?;
        let mut j = json!({ "path": a.path, "kind": a.kind, "in": c.in_sec, "out": c.out_sec, "fade_ms": c.fade_ms });
        if v2 {
            let (kind, ms) = spec_transition(k, c);
            let transcript = if m.captions.enabled && a.kind == "video" { transcript_file(a, root) } else { None };
            any_transcript |= transcript.is_some();
            let o = j.as_object_mut().expect("object");
            o.insert("transition_in".into(), json!({ "kind": kind, "ms": ms }));
            o.insert("punch_in".into(), json!(c.punch_in));
            o.insert("transcript".into(), json!(transcript));
        }
        clips.push(j);
    }
    let mut audio = vec![];
    for l in &m.audio {
        let a = by_id.get(l.asset_id.as_str()).ok_or("audio asset missing")?;
        let mut j = json!({ "path": a.path, "start": l.start_sec, "in": l.in_sec, "out": l.out_sec, "volume": l.volume });
        if v2 {
            let o = j.as_object_mut().expect("object");
            o.insert("fade_in_ms".into(), json!(l.fade_in_ms));
            o.insert("fade_out_ms".into(), json!(l.fade_out_ms));
            o.insert("duck_under_voice".into(), json!(l.duck_under_voice));
        }
        audio.push(j);
    }
    if !v2 {
        return Ok(json!({
            "version": 1, "project": m.project, "width": w, "height": h, "fps": 30,
            "clips": clips, "audio": audio, "clip_audio_volume": m.clip_audio_volume,
            "loudness_lufs": out.loudness_lufs, "max_size_mb": out.max_size_mb,
        }));
    }
    if m.captions.enabled && !any_transcript {
        return Err("captions are on, but none of the video clips has a transcript yet: transcribe them first (or turn captions off)".into());
    }
    let c = &m.captions;
    Ok(json!({
        "version": 2, "project": m.project, "width": w, "height": h, "fps": 30,
        "clips": clips, "audio": audio, "clip_audio_volume": m.clip_audio_volume,
        "loudness_lufs": out.loudness_lufs, "max_size_mb": out.max_size_mb,
        "captions": { "enabled": c.enabled, "style": c.style, "position": c.position, "max_words_per_line": c.max_words_per_line },
        "color": { "preset": m.color.preset, "strength": m.color.strength },
    }))
}

fn next_render_path(root: &Path, name: &str) -> PathBuf {
    let dir = root.join("renders");
    let _ = std::fs::create_dir_all(&dir);
    let mut n = 1;
    loop {
        let p = dir.join(format!("{name}_v{n:03}.mp4"));
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

/// Rust's own check of a finished render (never trusts the tool's word).
pub(crate) fn verify_render(pr: &Probe, size: u64, expect_sec: f64, w: u32, h: u32, cap_mb: Option<f64>) -> VerifyInfo {
    let mut checks = vec![];
    let mut ok = true;
    let mut check = |pass: bool, msg: String| {
        ok &= pass;
        checks.push(format!("{} {msg}", if pass { "✓" } else { "✗" }));
    };
    check(size > 0, format!("file on disk, {size} bytes"));
    check(pr.has_video && pr.has_audio, "video and audio streams".into());
    let d = pr.duration.unwrap_or(0.0);
    check(d > 0.0 && (d - expect_sec).abs() <= (expect_sec * 0.02).max(0.5), format!("duration {d:.2} s (expected {expect_sec:.2} s)"));
    check(pr.width == Some(w) && pr.height == Some(h), format!("resolution {}×{} (expected {w}×{h})", pr.width.unwrap_or(0), pr.height.unwrap_or(0)));
    if let Some(cap) = cap_mb {
        check(size as f64 <= cap * 1024.0 * 1024.0, format!("{:.1} MB within the {cap} MB cap", size as f64 / 1048576.0));
    }
    VerifyInfo { ok, checks }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_projects(app: tauri::AppHandle) -> Result<Vec<MediaProject>, String> {
    blocking(move || {
        let st = app.state::<MediaState>();
        st.with(|c| {
            let mut s = c.prepare("SELECT json FROM project ORDER BY updated_at DESC").map_err(sql_err)?;
            let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?;
            Ok(rows.filter_map(|r| r.ok()).filter_map(|j| parse_project(&j).ok()).collect())
        })
    })
    .await
}

#[tauri::command]
pub async fn media_project_create(app: tauri::AppHandle, title: String, source: Option<Source>) -> Result<MediaProject, String> {
    blocking(move || create_project(&app.state::<MediaState>(), &title, source)).await
}

#[tauri::command]
pub async fn media_project_get(app: tauri::AppHandle, slug: String) -> Result<Value, String> {
    blocking(move || {
        let st = app.state::<MediaState>();
        let project = load_project(&st, &slug)?;
        let root = project_root(&st, &slug)?;
        let _ = ensure_project_dirs(&root); // v2 folders for projects made before v2
        Ok(json!({ "project": project, "assets": list_assets(&st, &slug)?, "manifest": load_manifest(&root, &slug), "renders": list_renders(&st, &slug)? }))
    })
    .await
}

#[tauri::command]
pub async fn media_ingest_paths(app: tauri::AppHandle, slug: String, paths: Vec<String>, role: String) -> Result<Vec<MediaAsset>, String> {
    blocking(move || {
        let cfg = app.state::<OsState>().snapshot();
        ingest_paths(&app.state::<MediaState>(), &cfg, &slug, &paths, &role)
    })
    .await
}

#[tauri::command]
pub async fn media_ingest_begin(app: tauri::AppHandle, slug: String, name: String, size_bytes: u64, role: String) -> Result<Value, String> {
    blocking(move || ingest_begin(&app.state::<MediaState>(), &slug, &name, size_bytes, &role).map(|id| json!({ "uploadId": id }))).await
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.as_slice()),
        _ => Err("send the bytes as the raw request body".into()),
    }
}

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("missing header {name}"))
}

/// Raw body = the chunk bytes; headers `x-upload-id`, `x-offset`.
#[tauri::command]
pub async fn media_ingest_chunk(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let upload_id = header(&request, "x-upload-id")?.to_string();
    let offset: u64 = header(&request, "x-offset")?.parse().map_err(|_| "bad x-offset".to_string())?;
    let bytes = raw_body(&request)?.to_vec();
    let app2 = app.clone();
    let uid = upload_id.clone();
    let (slug, received, total) = blocking(move || ingest_chunk(&app2.state::<MediaState>(), &uid, offset, &bytes)).await?;
    let _ = app.emit(INGEST_EVENT, json!({ "slug": slug, "uploadId": upload_id, "received": received, "total": total }));
    Ok(json!({ "received": received }))
}

#[tauri::command]
pub async fn media_ingest_finish(app: tauri::AppHandle, upload_id: String) -> Result<MediaAsset, String> {
    blocking(move || {
        let cfg = app.state::<OsState>().snapshot();
        ingest_finish(&app.state::<MediaState>(), &cfg, &upload_id)
    })
    .await
}

/// Raw body = the recording; headers `x-slug`, `x-mime`.
#[tauri::command]
pub async fn media_voiceover_save(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<MediaAsset, String> {
    let slug = header(&request, "x-slug")?.to_string();
    let mime = header(&request, "x-mime")?.split(';').next().unwrap_or("").trim().to_string();
    let bytes = raw_body(&request)?.to_vec();
    blocking(move || {
        let cfg = app.state::<OsState>().snapshot();
        voiceover_save(&app.state::<MediaState>(), &cfg, &slug, &bytes, &mime)
    })
    .await
}

#[tauri::command]
pub async fn media_manifest_save(app: tauri::AppHandle, slug: String, manifest: TimelineManifest) -> Result<TimelineManifest, String> {
    blocking(move || manifest_save(&app.state::<MediaState>(), &slug, manifest)).await
}

#[derive(Deserialize)]
pub struct ChatAppend {
    role: String,
    text: String,
}

#[tauri::command]
pub async fn media_chat_log(app: tauri::AppHandle, slug: String, append: Option<ChatAppend>) -> Result<Vec<ChatLine>, String> {
    blocking(move || chat_log(&app.state::<MediaState>(), &slug, append.map(|a| (a.role, a.text)))).await
}

#[tauri::command]
pub async fn media_render_plan(app: tauri::AppHandle, slug: String, proposed_by: String) -> Result<RenderPlan, String> {
    blocking(move || build_plan(&app.state::<MediaState>(), &slug, &proposed_by)).await
}

fn tool_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| json!({ "raw": text }))
}

fn render_event(app: &tauri::AppHandle, slug: &str, job_id: &str, status: &str, pct: f64, eta: Option<f64>, stage: &str, extra: Value) {
    let mut v = json!({ "slug": slug, "jobId": job_id, "status": status, "pct": pct, "etaSec": eta, "stage": stage });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    let _ = app.emit(RENDER_EVENT, v);
}

/// One output of an approved render batch: its spec file, target file and verification bounds.
#[derive(Clone, Debug)]
pub(crate) struct RenderOut {
    pub platform: String,
    pub spec_path: PathBuf,
    pub out: PathBuf,
    pub w: u32,
    pub h: u32,
    pub cap: Option<f64>,
}

/// Write every output's spec for an approved plan (one output: `render_<plan>.json` →
/// `<name>_vNNN.mp4`, as v1; several: `render_<plan>_<platform>.json` → `<name>_<platform>_vNNN.mp4`).
pub(crate) fn prepare_outputs(m: &TimelineManifest, assets: &[MediaAsset], plan: &RenderPlan, root: &Path) -> Result<Vec<RenderOut>, String> {
    let many = m.outputs.len() > 1;
    let mut outs = vec![];
    for o in &m.outputs {
        let spec = render_spec(m, assets, o, root)?;
        let tag = if many { format!("_{}", o.platform) } else { String::new() };
        let spec_path = root.join("working").join(format!("render_{}{tag}.json", plan.plan_id));
        write_atomic(&spec_path, serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?.as_bytes())?;
        let (w, h) = dims_for(&o.aspect);
        outs.push(RenderOut { platform: o.platform.clone(), spec_path, out: next_render_path(root, &format!("{}{tag}", plan.output_name)), w, h, cap: o.max_size_mb });
    }
    Ok(outs)
}

async fn start_render_job(app: &tauri::AppHandle, o: &RenderOut) -> Result<String, String> {
    let args = json!({ "spec_path": o.spec_path.to_string_lossy(), "output": o.out.to_string_lossy(), "wait_s": 0 });
    let res = {
        let (d, os, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
        super::mcp::call_tool(&d, &os, &b, "media-forge.render_timeline", &args, true, "director").await?
    };
    tool_json(&res)["id"].as_str().map(String::from).ok_or_else(|| format!("media-forge did not start a job: {}", res.chars().take(300).collect::<String>()))
}

#[tauri::command]
pub async fn media_render_execute(app: tauri::AppHandle, slug: String, plan_id: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("PERMISSION_REQUIRED:media-render — approve the Render Plan first".into());
    }
    // One live batch per project: a double click, a re-sent card or a second plan waits its turn
    // (two batches would pick the same output paths). Released when the batch ends.
    claim_render(&app.state::<MediaState>(), &slug)?;
    let claim = RenderClaim { app: app.clone(), slug: slug.clone() };
    let app2 = app.clone();
    let (plan, outs, expect) = {
        let (slug, plan_id) = (slug.clone(), plan_id.clone());
        blocking(move || {
            let st = app2.state::<MediaState>();
            let plan = load_plan(&st, &plan_id)?;
            check_plan_executable(&st, &slug, &plan)?;
            let root = project_root(&st, &slug)?;
            let m = load_manifest_strict(&root, &slug)?;
            if m.revision != plan.manifest_revision {
                return Err("STALE_PLAN: the timeline changed after this plan was made; make a new plan".into());
            }
            let assets = list_assets(&st, &slug)?;
            validate_manifest(&m, &slug, &assets)?;
            let outs = prepare_outputs(&m, &assets, &plan, &root)?;
            Ok((plan, outs, expected_duration(&m)))
        })
        .await?
    };
    let cfg = app.state::<OsState>().snapshot();
    if !cfg.mcps.iter().any(|m| m.id == "media-forge" && m.enabled) {
        return Err("Media Forge is off: turn it on in Settings → MCP Registry".into());
    }
    // The first output starts now (so a refusal reaches the card); its job id names the batch.
    let job_id = start_render_job(&app, &outs[0]).await?;
    // Executed: the same plan can't start a second batch later.
    mark_plan_used(&app.state::<MediaState>(), &plan.plan_id);
    app.state::<MediaState>().jobs.lock().unwrap().insert(job_id.clone(), LiveRender { forge_job: job_id.clone(), cancelled: false });
    // v2: no "rendering" status (the job shows it); the project stays where it is.
    render_event(&app, &slug, &job_id, "queued", 0.0, None, &stage_label(&outs[0].platform, 0, outs.len(), "queued"), json!({}));
    tauri::async_runtime::spawn(run_outputs(app.clone(), slug, job_id.clone(), plan, outs, expect, claim));
    Ok(json!({ "jobId": job_id }))
}

/// Claim the project's one live render batch (`RenderClaim` releases it).
pub(crate) fn claim_render(state: &MediaState, slug: &str) -> Result<(), String> {
    if !state.rendering.lock().unwrap().insert(slug.to_string()) {
        return Err("RENDER_BUSY: a render for this project is already running; wait for it to finish (or cancel it)".into());
    }
    Ok(())
}

pub(crate) fn release_render(state: &MediaState, slug: &str) {
    state.rendering.lock().unwrap().remove(slug);
}

/// Releases the project's render claim when the batch ends, however it ends.
struct RenderClaim {
    app: tauri::AppHandle,
    slug: String,
}

impl Drop for RenderClaim {
    fn drop(&mut self) {
        release_render(&self.app.state::<MediaState>(), &self.slug);
    }
}

fn plan_used_key(plan_id: &str) -> String {
    format!("plan-used:{plan_id}")
}

pub(crate) fn mark_plan_used(state: &MediaState, plan_id: &str) {
    let _ = state.with(|c| c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![plan_used_key(plan_id), now_iso()]).map(|_| ()).map_err(sql_err));
}

/// At execute time (not only when the plan was made): the plan is this project's, hasn't run
/// already, and a Director plan still fits the 2-round review cap (contract §5).
pub(crate) fn check_plan_executable(state: &MediaState, slug: &str, plan: &RenderPlan) -> Result<(), String> {
    if plan.project != slug {
        return Err("that plan belongs to another project".into());
    }
    let used = state.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [plan_used_key(&plan.plan_id)], |r| r.get::<_, String>(0)).optional().map_err(sql_err))?;
    if used.is_some() {
        return Err("PLAN_USED: this plan has already been rendered; make a new plan".into());
    }
    let p = load_project(state, slug)?;
    check_review_limit(&p.review, &plan.proposed_by)
}

/// After starting output k > 0: record its media-forge job on the batch and say whether Nic
/// cancelled the batch while the start was in flight (then the new job must be cancelled too).
pub(crate) fn adopt_forge_job(jobs: &Mutex<HashMap<String, LiveRender>>, batch: &str, forge_job: &str) -> bool {
    match jobs.lock().unwrap().get_mut(batch) {
        Some(l) => {
            l.forge_job = forge_job.to_string();
            l.cancelled
        }
        None => true,
    }
}

/// "reels 1/2 · encoding" for a batch; the bare stage for a single output.
pub(crate) fn stage_label(platform: &str, k: usize, n: usize, stage: &str) -> String {
    if n <= 1 {
        stage.to_string()
    } else if stage.is_empty() {
        format!("{platform} {}/{n}", k + 1)
    } else {
        format!("{platform} {}/{n} · {stage}", k + 1)
    }
}

/// Overall percent for output `k` of `n` at `pct` through its own render.
pub(crate) fn batch_pct(k: usize, n: usize, pct: f64) -> f64 {
    ((k as f64 + pct.clamp(0.0, 100.0) / 100.0) / n.max(1) as f64 * 1000.0).round() / 10.0
}

enum Outcome {
    Done(VerifiedRender),
    Failed(String),
    Cancelled,
}

/// The approved batch: each output rendered in turn (one media-forge job at a time, CPU), each
/// verified by Rust before it's listed. A failure or a cancel stops the outputs after it.
async fn run_outputs(app: tauri::AppHandle, slug: String, batch: String, plan: RenderPlan, outs: Vec<RenderOut>, expect: f64, claim: RenderClaim) {
    let _claim = claim; // held until the batch ends
    let n = outs.len();
    for (k, o) in outs.iter().enumerate() {
        let forge_job = if k == 0 {
            batch.clone()
        } else {
            if app.state::<MediaState>().jobs.lock().unwrap().get(&batch).map_or(true, |l| l.cancelled) {
                app.state::<MediaState>().jobs.lock().unwrap().remove(&batch);
                render_event(&app, &slug, &batch, "cancelled", batch_pct(k, n, 0.0), None, "cancelled", json!({}));
                return;
            }
            match start_render_job(&app, o).await {
                Ok(id) => {
                    if adopt_forge_job(&app.state::<MediaState>().jobs, &batch, &id) {
                        // Cancelled while this output was starting: stop the job that just began.
                        let (d, os, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
                        let _ = super::mcp::call_tool(&d, &os, &b, "media-forge.job_cancel", &json!({ "job_id": id }), true, "director").await;
                        app.state::<MediaState>().jobs.lock().unwrap().remove(&batch);
                        render_event(&app, &slug, &batch, "cancelled", batch_pct(k, n, 0.0), None, "cancelled", json!({}));
                        return;
                    }
                    render_event(&app, &slug, &batch, "queued", batch_pct(k, n, 0.0), None, &stage_label(&o.platform, k, n, "queued"), json!({}));
                    id
                }
                Err(e) => return finish_failed(&app, &slug, &batch, &format!("{}: {e}", o.platform)),
            }
        };
        match watch_one(&app, &slug, &batch, &forge_job, k, n, &plan, o, expect).await {
            Outcome::Done(r) => {
                if k + 1 == n {
                    app.state::<MediaState>().jobs.lock().unwrap().remove(&batch);
                }
                render_event(&app, &slug, &batch, "done", batch_pct(k + 1, n, 0.0), Some(0.0), &stage_label(&o.platform, k, n, "verified"), json!({ "render": r }));
            }
            Outcome::Failed(e) => return finish_failed(&app, &slug, &batch, &if n > 1 { format!("{}: {e}", o.platform) } else { e }),
            Outcome::Cancelled => {
                app.state::<MediaState>().jobs.lock().unwrap().remove(&batch);
                render_event(&app, &slug, &batch, "cancelled", batch_pct(k, n, 0.0), None, "cancelled", json!({}));
                return;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn watch_one(app: &tauri::AppHandle, slug: &str, batch: &str, job_id: &str, k: usize, n: usize, plan: &RenderPlan, o: &RenderOut, expect: f64) -> Outcome {
    let mut failures = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let res = {
            let (d, os, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
            super::mcp::call_tool(&d, &os, &b, "media-forge.job_status", &json!({ "job_id": job_id, "wait_s": 2 }), true, "director").await
        };
        let v = match res {
            Ok(t) => tool_json(&t),
            Err(e) => {
                failures += 1;
                if failures >= 10 {
                    return Outcome::Failed(format!("lost track of the render: {e}"));
                }
                continue;
            }
        };
        failures = 0;
        let status = v["status"].as_str().unwrap_or("running").to_string();
        let pct = v["progress_pct"].as_f64().unwrap_or(0.0);
        let eta = v["eta_s"].as_f64();
        let stage = v["stage"].as_str().unwrap_or("").to_string();
        match status.as_str() {
            "queued" | "running" => render_event(app, slug, batch, &status, batch_pct(k, n, pct), eta, &stage_label(&o.platform, k, n, &stage), json!({})),
            "done" => {
                let lufs = v["result"]["loudness_measured"].as_f64();
                let app2 = app.clone();
                let (slug2, plan_id, o2) = (slug.to_string(), plan.plan_id.clone(), o.clone());
                let verdict = blocking(move || {
                    let cfg = app2.state::<OsState>().snapshot();
                    verify_and_record(&app2.state::<MediaState>(), &cfg, &slug2, &plan_id, &o2, expect, lufs)
                })
                .await;
                return match verdict {
                    Ok(r) => Outcome::Done(r),
                    Err(e) => Outcome::Failed(e),
                };
            }
            "cancelled" => return Outcome::Cancelled,
            _ => return Outcome::Failed(v["error"].as_str().unwrap_or("the render failed").to_string()),
        }
    }
}

/// A finished output, checked by Rust (never the tool's word): on disk, probed, `verify_render`
/// passed. Then it's listed (`record_render`) and opens / joins its review round. Sync (the
/// batch runs it on a blocking thread).
pub(crate) fn verify_and_record(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, plan_id: &str, o: &RenderOut, expect: f64, lufs: Option<f64>) -> Result<VerifiedRender, String> {
    let ffprobe = media_bin(cfg, "ffprobe").ok_or("ffprobe not found")?;
    if !o.out.is_file() {
        return Err(format!("the render reported done but {} is not on disk", o.out.display()));
    }
    let size = std::fs::metadata(&o.out).map(|m| m.len()).unwrap_or(0);
    let pr = probe(&ffprobe, &o.out)?;
    let verify = verify_render(&pr, size, expect, o.w, o.h, o.cap);
    if !verify.ok {
        return Err(format!("render failed verification: {}", verify.checks.join("; ")));
    }
    let r = VerifiedRender {
        id: short_id("r"),
        project: slug.to_string(),
        plan_id: plan_id.to_string(),
        path: dunce_canon(&o.out).unwrap_or(o.out.clone()).to_string_lossy().to_string(),
        duration_sec: pr.duration.unwrap_or(0.0),
        width: pr.width.unwrap_or(0),
        height: pr.height.unwrap_or(0),
        size_bytes: size,
        loudness_lufs: lufs,
        verify,
        created_at: now_iso(),
    };
    record_render(state, &r, Some(&o.platform))?;
    on_verified_render(state, slug, &r.id);
    Ok(r)
}

/// List a verified render, remembering which output (platform) it was made for (media.db kv
/// `render-platform:<id>`; the VerifiedRender shape stays the contract's).
pub(crate) fn record_render(state: &MediaState, r: &VerifiedRender, platform: Option<&str>) -> Result<(), String> {
    let j = serde_json::to_string(r).map_err(|e| e.to_string())?;
    state.with(|c| {
        c.execute("INSERT INTO render (id, project, json, created_at) VALUES (?1, ?2, ?3, ?4)", params![r.id, r.project, j, r.created_at]).map_err(sql_err)?;
        if let Some(p) = platform {
            c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![format!("render-platform:{}", r.id), p]).map_err(sql_err)?;
        }
        Ok(())
    })
}

fn stored_platform(state: &MediaState, render_id: &str) -> Option<String> {
    state.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [format!("render-platform:{render_id}")], |r| r.get::<_, String>(0)).optional().map_err(sql_err)).ok().flatten()
}

/// The round a render belongs to: its own, or the round opened by another output of the same
/// approved batch (same plan).
pub(crate) fn round_index(review: &ProjectReview, render_id: &str, renders: &[VerifiedRender]) -> Option<usize> {
    let plan_of = |id: &str| renders.iter().find(|r| r.id == id).map(|r| r.plan_id.clone());
    let plan = plan_of(render_id);
    review.rounds.iter().position(|x| x.render_id == render_id || (plan.is_some() && plan_of(&x.render_id) == plan))
}

/// Contract §1/§5: a verified render moves the project to review and opens a review round (one
/// round per approved batch: the other outputs of the same plan join it).
pub(crate) fn on_verified_render(state: &MediaState, slug: &str, render_id: &str) {
    let _g = state.project_lock.lock().unwrap();
    if let Ok(mut p) = load_project(state, slug) {
        let renders = list_renders(state, slug).unwrap_or_default();
        if round_index(&p.review, render_id, &renders).is_none() {
            record_review_round(&mut p.review, render_id);
        }
        if status_rank("review") > status_rank(&p.status) {
            p.status = "review".into();
        }
        p.updated_at = now_iso();
        let _ = save_project(state, &p);
    }
}

fn finish_failed(app: &tauri::AppHandle, slug: &str, job_id: &str, err: &str) {
    app.state::<MediaState>().jobs.lock().unwrap().remove(job_id);
    // v2: a failed render leaves the status alone (v1 reset it to editing from "rendering").
    let err: String = err.chars().take(800).collect();
    render_event(app, slug, job_id, "failed", 0.0, None, "failed", json!({ "error": err }));
}

/// Cancels the batch: the output rendering now is stopped and the ones after it are skipped.
#[tauri::command]
pub async fn media_render_cancel(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
    let forge_job = {
        let st = app.state::<MediaState>();
        let mut jobs = st.jobs.lock().unwrap();
        let live = jobs.get_mut(&job_id).ok_or("no live render with that id")?;
        live.cancelled = true;
        live.forge_job.clone()
    };
    let (d, o, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
    super::mcp::call_tool(&d, &o, &b, "media-forge.job_cancel", &json!({ "job_id": forge_job }), true, "director").await.map(|_| ())
}

#[tauri::command]
pub async fn media_readiness(app: tauri::AppHandle, os: State<'_, OsState>, dispatch: State<'_, super::dispatch::DispatchState>) -> Result<Value, String> {
    let cfg = os.snapshot();
    let statuses = super::mcp::cached_statuses(&dispatch, &os);
    let ready = |id: &str| -> McpReady {
        let enabled = cfg.mcps.iter().any(|m| m.id == id && m.enabled);
        let s = statuses.iter().find(|s| s["id"] == id);
        let status = s.and_then(|s| s["status"].as_str()).unwrap_or("unknown");
        let tools = s.and_then(|s| s["tools"].as_u64().or_else(|| s["tools"].as_array().map(|a| a.len() as u64))).unwrap_or(0) as u32;
        McpReady { enabled, healthy: enabled && status == "ok", tools, error: s.and_then(|s| s["error"].as_str()).map(String::from) }
    };
    let ffmpeg_found = {
        let cfg2 = cfg.clone();
        let _ = &app;
        blocking(move || Ok(media_bin(&cfg2, "ffprobe").is_some())).await?
    };
    Ok(json!({ "shotcut": ready("shotcut"), "mediaForge": ready("media-forge"), "ffmpegFound": ffmpeg_found }))
}

// ── v2 commands (contract §8) ──

#[tauri::command]
pub async fn media_project_update(app: tauri::AppHandle, slug: String, title: Option<String>, brief: Option<CreativeBrief>, status: Option<String>, speed: Option<String>) -> Result<MediaProject, String> {
    blocking(move || project_update(&app.state::<MediaState>(), &slug, title, brief, status, speed)).await
}

/// `slot_id`: "" clears (api.ts maps the contract's `null`), absent leaves it.
#[tauri::command]
pub async fn media_asset_update(app: tauri::AppHandle, slug: String, asset_id: String, tags: Option<Vec<String>>, moments: Option<Vec<Moment>>, slot_id: Option<String>) -> Result<MediaAsset, String> {
    blocking(move || asset_update(&app.state::<MediaState>(), &slug, &asset_id, tags, moments, slot_id)).await
}

#[tauri::command]
pub async fn media_intake_status(app: tauri::AppHandle, slug: String) -> Result<IntakeStatus, String> {
    blocking(move || intake_status(&app.state::<MediaState>(), &slug)).await
}

#[tauri::command]
pub async fn media_transcribe(app: tauri::AppHandle, slug: String, asset_ids: Vec<String>) -> Result<Value, String> {
    blocking(move || transcribe_enqueue(&app.state::<MediaState>(), &slug, &asset_ids).map(|n| json!({ "queued": n }))).await
}

#[tauri::command]
pub async fn media_note_add(app: tauri::AppHandle, slug: String, note: NoteInput) -> Result<Note, String> {
    blocking(move || note_add(&app.state::<MediaState>(), &slug, note)).await
}

#[tauri::command]
pub async fn media_note_resolve(app: tauri::AppHandle, slug: String, note_id: String) -> Result<(), String> {
    blocking(move || note_resolve(&app.state::<MediaState>(), &slug, &note_id)).await
}

/// The review rounds and open decisions, as stored in project.json (contract §5).
pub(crate) fn review_get(state: &MediaState, slug: &str) -> Result<ProjectReview, String> {
    load_project(state, slug).map(|p| p.review)
}

#[tauri::command]
pub async fn media_review_get(app: tauri::AppHandle, slug: String) -> Result<ProjectReview, String> {
    blocking(move || review_get(&app.state::<MediaState>(), &slug)).await
}

pub(crate) const MAX_REVIEW_SUMMARY: usize = 2000;
pub(crate) const MAX_OPEN_DECISIONS: usize = 12;
pub(crate) const MAX_DECISION_CHARS: usize = 300;

/// Store the Director's words on the review (contract §5): a round's "choices" summary (that round
/// must exist: rounds open with verified renders) and/or the open-decisions list (replaced whole).
/// Text only: nothing renders, resolves or changes status.
pub(crate) fn review_write(state: &MediaState, slug: &str, round: u8, summary: Option<String>, open_decisions: Option<Vec<String>>) -> Result<ProjectReview, String> {
    if round != 1 && round != 2 {
        return Err("round must be 1 or 2".into());
    }
    if summary.is_none() && open_decisions.is_none() {
        return Err("nothing to write: give a summary or open decisions".into());
    }
    let summary = summary.map(|s| s.trim().to_string());
    if summary.as_ref().is_some_and(|s| s.chars().count() > MAX_REVIEW_SUMMARY) {
        return Err(format!("the round summary is over {MAX_REVIEW_SUMMARY} characters"));
    }
    let decisions = match open_decisions {
        None => None,
        Some(ds) => {
            if ds.len() > MAX_OPEN_DECISIONS {
                return Err(format!("up to {MAX_OPEN_DECISIONS} open decisions"));
            }
            let mut out: Vec<String> = vec![];
            for d in ds {
                let t = d.trim();
                if t.is_empty() {
                    return Err("an open decision is empty".into());
                }
                if t.chars().count() > MAX_DECISION_CHARS {
                    return Err(format!("an open decision is over {MAX_DECISION_CHARS} characters"));
                }
                if !out.iter().any(|x| x == t) {
                    out.push(t.to_string());
                }
            }
            Some(out)
        }
    };
    // Same lock as note_add, which also rewrites project.json's review.
    let _g = state.manifest_lock.lock().unwrap();
    let _pg = state.project_lock.lock().unwrap();
    let mut p = load_project(state, slug)?;
    if let Some(s) = summary {
        let r = p.review.rounds.iter_mut().find(|r| r.round == round).ok_or_else(|| format!("there's no review round {round} yet (a round opens with a verified render)"))?;
        r.summary = s;
    }
    if let Some(d) = decisions {
        p.review.open_decisions = d;
    }
    p.updated_at = now_iso();
    save_project(state, &p)?;
    Ok(p.review)
}

#[tauri::command]
pub async fn media_review_write(app: tauri::AppHandle, slug: String, round: u8, summary: Option<String>, open_decisions: Option<Vec<String>>) -> Result<ProjectReview, String> {
    blocking(move || review_write(&app.state::<MediaState>(), &slug, round, summary, open_decisions)).await
}

/// Only from Nic's "Approve final" click.
#[tauri::command]
pub async fn media_approve_final(app: tauri::AppHandle, slug: String, render_ids: Vec<String>, approved: bool) -> Result<Vec<Deliverable>, String> {
    blocking(move || approve_final(&app.state::<MediaState>(), &slug, &render_ids, approved)).await
}

#[tauri::command]
pub async fn media_reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = app.state::<MediaState>().projects_root();
    let p = PathBuf::from(&path);
    if !inside(&p, &root) {
        return Err("only files inside the Director projects folder can be revealed".into());
    }
    let canon = dunce_canon(&p).ok_or("no such file")?;
    let arg = format!("/select,{}", canon.display());
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(arg);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("media-test-{}", short_id("t")));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn asset(id: &str, kind: &str, dur: Option<f64>) -> MediaAsset {
        MediaAsset { id: id.into(), project: "p".into(), kind: kind.into(), role: "clip".into(), name: format!("{id}.x"), path: format!("C:/x/{id}"), read_only: true, size_bytes: 1, duration_sec: dur, width: Some(1920), height: Some(1080), thumb_path: None, added_at: now_iso(), ..Default::default() }
    }

    fn slot(id: &str, asset: Option<&str>) -> ShotSlot {
        ShotSlot { id: id.into(), label: "Hook".into(), instructions: "15 s".into(), kind: "video".into(), target_sec: Some(15.0), asset_id: asset.map(String::from), status: if asset.is_some() { "attached" } else { "needed" }.into(), framing: None, action: String::new(), source: "film".into(), phone_tips: vec![], filmed: false }
    }

    fn clip(id: &str, asset: &str, i: f64, o: f64) -> TimelineClip {
        TimelineClip { id: id.into(), asset_id: asset.into(), in_sec: i, out_sec: o, fade_ms: 0, transition_in: Transition::default(), punch_in: 1.0 }
    }

    #[test]
    fn slugs_and_file_names_are_safe() {
        assert_eq!(slugify("My Self-Tape: Scene 2!"), "my-self-tape-scene-2");
        assert_eq!(slugify("   ***  "), "project");
        assert!(slugify(&"a".repeat(200)).len() <= 40);
        assert_eq!(safe_file_name(r"..\..\evil:name?.mp4"), "evil_name_.mp4");
        assert_eq!(safe_file_name("C:/clips/take 1.MOV"), "take 1.MOV");
        assert_eq!(safe_file_name("..."), "media");
        assert!(valid_slug("ok-1") && !valid_slug("../x") && !valid_slug("A") && !valid_slug(""));
    }

    #[test]
    fn manifest_rules_hold() {
        let assets = vec![asset("v", "video", Some(10.0)), asset("i", "image", None), asset("a", "audio", Some(5.0))];
        let mut m = default_manifest("p");
        m.clips = vec![clip("c1", "v", 1.0, 9.0), clip("c2", "i", 0.0, 3.0)];
        m.audio = vec![AudioLayer { id: "l1".into(), asset_id: "a".into(), start_sec: 1.0, in_sec: 0.0, out_sec: 5.0, volume: 0.8, fade_in_ms: 0, fade_out_ms: 0, duck_under_voice: false }];
        assert_eq!(validate_manifest(&m, "p", &assets), Ok(()));
        let bad = |f: &dyn Fn(&mut TimelineManifest)| {
            let mut x = m.clone();
            f(&mut x);
            validate_manifest(&x, "p", &assets).is_err()
        };
        assert!(bad(&|x| x.clips[0].out_sec = 11.0)); // past the clip
        assert!(bad(&|x| x.clips[0].in_sec = 9.5)); // in after out
        assert!(bad(&|x| x.clips[1].out_sec = 90.0)); // still held too long
        assert!(bad(&|x| x.clips[0].asset_id = "ghost".into())); // not this project's asset
        assert!(bad(&|x| x.clips[1].id = "c1".into())); // duplicate id
        assert!(bad(&|x| x.clips.push(clip("c3", "a", 0.0, 1.0)))); // audio as a clip
        assert!(bad(&|x| x.audio[0].volume = 3.0));
        assert!(bad(&|x| x.output.aspect = "21:9".into()));
        assert!(bad(&|x| x.output.loudness_lufs = -23));
        assert!(bad(&|x| x.project = "other".into()));
        assert!(bad(&|x| x.clip_audio_volume = f64::NAN));
    }

    #[test]
    fn project_manifest_and_chat_round_trip_with_revisions() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Quick Stitch Test", None).unwrap();
        assert_eq!(p.slug, "quick-stitch-test");
        assert!(root.join("quick-stitch-test").join("raw").is_dir() && root.join("quick-stitch-test").join("renders").is_dir());
        let p2 = create_project(&st, "Quick Stitch Test", Some(Source { from: "brainstorm".into(), ref_id: Some("n1".into()), brief: Some("idea".into()) })).unwrap();
        assert_eq!(p2.slug, "quick-stitch-test-2");
        assert!(create_project(&st, "x", Some(Source { from: "evil".into(), ref_id: None, brief: None })).is_err());

        let m0 = load_manifest(Path::new(&p.root), &p.slug);
        let mut m = m0.clone();
        m.shot_list = vec![slot("s1", None)];
        let saved = manifest_save(&st, &p.slug, m.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        // A save from the old revision is refused, not merged.
        assert!(manifest_save(&st, &p.slug, m).unwrap_err().starts_with("STALE_REVISION"));
        assert_eq!(load_manifest(Path::new(&p.root), &p.slug).shot_list.len(), 1);

        chat_log(&st, &p.slug, Some(("nic".into(), "hi".into()))).unwrap();
        let log = chat_log(&st, &p.slug, Some(("director".into(), "hey".into()))).unwrap();
        assert_eq!(log.iter().map(|l| l.role.as_str()).collect::<Vec<_>>(), ["nic", "director"]);
        assert!(chat_log(&st, &p.slug, Some(("tony".into(), "x".into()))).is_err());
        assert!(build_plan(&st, &p.slug, "director").unwrap_err().contains("no clips"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn chunked_upload_is_ordered_and_bounded() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Uploads", None).unwrap();
        assert!(ingest_begin(&st, &p.slug, "notes.txt", 10, "clip").is_err());
        assert!(ingest_begin(&st, &p.slug, "a.mp4", 10, "villain").is_err());
        let id = ingest_begin(&st, &p.slug, "../../a.mp4", 10, "clip").unwrap();
        assert!(ingest_chunk(&st, &id, 5, b"hello").unwrap_err().contains("out-of-order"));
        assert_eq!(ingest_chunk(&st, &id, 0, b"hello").unwrap().1, 5);
        assert!(ingest_chunk(&st, &id, 5, b"toolong!").unwrap_err().contains("more bytes"));
        assert_eq!(ingest_chunk(&st, &id, 5, b"world").unwrap().1, 10);
        let up = st.uploads.lock().unwrap().get(&id).map(|u| (u.name.clone(), u.part.clone())).unwrap();
        assert_eq!(up.0, "a.mp4"); // separators stripped
        assert!(up.1.starts_with(root.join("uploads").join("working")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn render_spec_and_verification() {
        let assets = vec![asset("v", "video", Some(10.0)), asset("i", "image", None)];
        let mut m = default_manifest("p");
        m.output.aspect = "9:16".into();
        m.outputs[0].aspect = "9:16".into();
        m.clips = vec![clip("c1", "v", 1.0, 9.0), clip("c2", "i", 0.0, 3.0)];
        let spec = render_spec(&m, &assets, &m.outputs[0], Path::new("C:/x")).unwrap();
        assert_eq!((spec["width"].as_u64(), spec["height"].as_u64()), (Some(1080), Some(1920)));
        assert_eq!(spec["clips"][1]["kind"], "image");
        assert_eq!(spec["clips"][0]["path"], "C:/x/v");
        let good = Probe { duration: Some(11.0), width: Some(1080), height: Some(1920), has_video: true, has_audio: true };
        assert!(verify_render(&good, 1000, 11.0, 1080, 1920, Some(10.0)).ok);
        assert!(!verify_render(&good, 0, 11.0, 1080, 1920, None).ok);
        assert!(!verify_render(&Probe { has_audio: false, ..good.clone() }, 10, 11.0, 1080, 1920, None).ok);
        assert!(!verify_render(&Probe { duration: Some(8.0), ..good.clone() }, 10, 11.0, 1080, 1920, None).ok);
        assert!(!verify_render(&good, 20 * 1024 * 1024, 11.0, 1080, 1920, Some(10.0)).ok);
        let p = parse_probe(r#"{"format":{"duration":"4.5"},"streams":[{"codec_type":"video","width":1920,"height":1080,"side_data_list":[{"rotation":-90}]},{"codec_type":"audio"}]}"#);
        assert_eq!((p.width, p.height, p.has_audio, p.duration), (Some(1080), Some(1920), true, Some(4.5)));
    }

    // ── v2 (docs/proposals/director-suite-v2-contract.md) ──

    fn brief(by: &str, approved: bool) -> CreativeBrief {
        CreativeBrief {
            idea: "a moody dance reel in the rain".into(),
            goal: "get booked for a dance gig".into(),
            platform: "reels".into(),
            length_sec: 30.0,
            aspect: "9:16".into(),
            tone: "moody, slow, warm".into(),
            references: vec!["like the last reel".into()],
            guessed: vec!["lengthSec".into()],
            approved,
            updated_by: by.into(),
            updated_at: String::new(),
        }
    }

    fn put_asset(st: &MediaState, slug: &str, id: &str, kind: &str, dur: Option<f64>) -> MediaAsset {
        let a = MediaAsset { project: slug.into(), ..asset(id, kind, dur) };
        save_asset(st, &a).unwrap();
        a
    }

    fn put_render(st: &MediaState, slug: &str, id: &str, path: &Path, w: u32, h: u32) -> VerifiedRender {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let r = VerifiedRender { id: id.into(), project: slug.into(), plan_id: "p-1".into(), path: path.to_string_lossy().to_string(), duration_sec: 3.0, width: w, height: h, size_bytes: size, loudness_lufs: None, verify: VerifyInfo { ok: true, checks: vec![] }, created_at: now_iso() };
        let j = serde_json::to_string(&r).unwrap();
        st.with(|c| c.execute("INSERT INTO render (id, project, json, created_at) VALUES (?1, ?2, ?3, ?4)", params![r.id, r.project, j, r.created_at]).map(|_| ()).map_err(sql_err)).unwrap();
        r
    }

    const V1_MANIFEST: &str = r#"{"version":1,"project":"old","revision":7,
        "clips":[{"id":"c1","assetId":"v","inSec":1,"outSec":4,"fadeMs":200}],
        "audio":[{"id":"l1","assetId":"a","startSec":0,"inSec":0,"outSec":5,"volume":0.8}],
        "clipAudioVolume":0.5,"output":{"aspect":"9:16","loudnessLufs":-18,"maxSizeMb":100,"name":"old"},
        "shotList":[{"id":"s1","label":"Hook","instructions":"","kind":"video","targetSec":3,"assetId":"v","status":"attached"}],
        "updatedBy":"director","updatedAt":"2026-11-22T00:00:00Z"}"#;

    #[test]
    fn v1_manifest_loads_as_v2_with_defaults() {
        let m = upgrade_manifest(serde_json::from_str(V1_MANIFEST).unwrap());
        assert_eq!((m.version, m.revision, m.clip_audio_volume), (2, 7, 0.5));
        assert_eq!(m.clips[0].transition_in, Transition { kind: "cut".into(), ms: 0 });
        assert_eq!((m.clips[0].punch_in, m.clips[0].fade_ms), (1.0, 200));
        assert_eq!((m.audio[0].fade_in_ms, m.audio[0].fade_out_ms, m.audio[0].duck_under_voice), (0, 0, false));
        let s = &m.shot_list[0];
        assert_eq!((s.framing.clone(), s.action.as_str(), s.source.as_str(), s.phone_tips.len(), s.filmed), (None, "", "film", 0, false));
        assert_eq!(m.captions, CaptionTrack::default());
        assert_eq!(m.color, ColorLook::default());
        assert_eq!(m.outputs, vec![PlatformPreset { platform: "custom".into(), aspect: "9:16".into(), loudness_lufs: -18, max_size_mb: Some(100.0), max_sec: None }]);
        assert!(m.notes.is_empty());
        let assets = vec![asset("v", "video", Some(10.0)), asset("a", "audio", Some(5.0))];
        assert_eq!(validate_manifest(&m, "old", &assets), Ok(()));
        // The same file read from disk by load_manifest.
        let root = tmp_root();
        std::fs::create_dir_all(root.join("working")).unwrap();
        std::fs::write(manifest_path(&root), V1_MANIFEST).unwrap();
        assert_eq!(load_manifest(&root, "old"), m);
        // A v2 manifest round-trips unchanged.
        let again: TimelineManifest = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(upgrade_manifest(again), m);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_manifest_rules_hold() {
        let assets = vec![asset("v", "video", Some(10.0)), asset("a", "audio", Some(5.0))];
        let mut m = default_manifest("p");
        m.clips = vec![clip("c1", "v", 0.0, 4.0)];
        m.audio = vec![AudioLayer { id: "l1".into(), asset_id: "a".into(), start_sec: 0.0, in_sec: 0.0, out_sec: 5.0, volume: 1.0, fade_in_ms: 500, fade_out_ms: 2000, duck_under_voice: true }];
        m.shot_list = vec![slot("s1", Some("v"))];
        m.notes = vec![Note { id: "n1".into(), render_id: Some("r-1".into()), at_sec: Some(2.0), text: "tighter".into(), by: "nic".into(), via_voice: false, resolved: false, at: now_iso() }];
        assert_eq!(validate_manifest(&m, "p", &assets), Ok(()));
        let bad = |f: &dyn Fn(&mut TimelineManifest)| {
            let mut x = m.clone();
            f(&mut x);
            validate_manifest(&x, "p", &assets).is_err()
        };
        assert!(bad(&|x| x.version = 1)); // only upgraded manifests validate
        assert!(bad(&|x| x.clips[0].transition_in = Transition { kind: "wipe".into(), ms: 0 }));
        assert!(bad(&|x| x.clips[0].transition_in = Transition { kind: "crossfade".into(), ms: 1501 }));
        assert!(!bad(&|x| x.clips[0].transition_in = Transition { kind: "fade_black".into(), ms: 1500 }));
        assert!(bad(&|x| x.clips[0].punch_in = 1.6));
        assert!(bad(&|x| x.clips[0].punch_in = 0.9));
        assert!(bad(&|x| x.clips[0].punch_in = f64::NAN));
        assert!(bad(&|x| x.audio[0].fade_out_ms = 10_001));
        assert!(bad(&|x| x.shot_list[0].framing = Some("dutch".into())));
        assert!(!bad(&|x| x.shot_list[0].framing = Some("closeup".into())));
        assert!(bad(&|x| x.shot_list[0].source = "borrow".into()));
        assert!(bad(&|x| x.shot_list[0].phone_tips = vec!["a".into(); 5]));
        assert!(bad(&|x| x.shot_list[0].phone_tips = vec!["  ".into()]));
        assert!(bad(&|x| x.shot_list[0].action = "x".repeat(501)));
        assert!(bad(&|x| x.shot_list.push(slot("s1", None)))); // duplicate slot id
        assert!(bad(&|x| x.captions.max_words_per_line = 0));
        assert!(bad(&|x| x.captions.max_words_per_line = 13));
        assert!(bad(&|x| x.captions.style = "comic".into()));
        assert!(bad(&|x| x.captions.position = "top".into()));
        assert!(bad(&|x| x.color.preset = "sepia".into()));
        assert!(bad(&|x| x.color.strength = 1.01));
        assert!(bad(&|x| x.outputs.clear()));
        assert!(bad(&|x| {
            let o = x.outputs[0].clone();
            x.outputs.push(o); // repeated platform
        }));
        assert!(bad(&|x| {
            for p in ["reels", "tiktok", "youtube", "shorts"] {
                x.outputs.push(PlatformPreset { platform: p.into(), aspect: "9:16".into(), loudness_lufs: -14, max_size_mb: None, max_sec: Some(60.0) });
            }
        })); // 5 outputs
        assert!(bad(&|x| x.outputs[0].platform = "myspace".into()));
        assert!(bad(&|x| x.outputs[0].loudness_lufs = -23));
        assert!(bad(&|x| x.outputs[0].max_sec = Some(601.0)));
        assert!(bad(&|x| x.outputs[0].max_size_mb = Some(0.5)));
        assert!(bad(&|x| x.notes[0].by = "director".into()));
        assert!(bad(&|x| x.notes[0].text = " ".into()));
        assert!(bad(&|x| x.notes[0].at_sec = Some(-1.0)));
        assert!(bad(&|x| {
            let n = x.notes[0].clone();
            x.notes.push(n);
        }));
    }

    #[test]
    fn v1_project_rows_read_as_v2() {
        assert_eq!(["intake", "awaiting_media", "editing", "rendering", "ready", "done", "???"].map(upgrade_status), ["brief", "shooting", "editing", "editing", "review", "done", "brief"]);
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        for (slug, status) in [("a", "intake"), ("b", "awaiting_media"), ("c", "rendering"), ("d", "ready")] {
            let j = format!(r#"{{"slug":"{slug}","title":"Old","status":"{status}","root":"x","createdAt":"t","updatedAt":"t","source":{{"from":"suite","refId":null,"brief":"the handoff"}}}}"#);
            st.with(|c| c.execute("INSERT INTO project (slug, json, updated_at) VALUES (?1, ?2, 't')", params![slug, j]).map(|_| ()).map_err(sql_err)).unwrap();
        }
        let got: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| load_project(&st, s).unwrap().status).collect();
        assert_eq!(got, ["brief", "shooting", "editing", "review"]);
        let p = load_project(&st, "a").unwrap();
        assert_eq!((p.brief, p.speed.as_str(), p.review, p.source.brief.as_deref()), (None, "rough", ProjectReview::default(), Some("the handoff")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_db_v3_migration_keeps_v1_asset_rows() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(MIGRATIONS[0]).unwrap();
        c.execute_batch(MIGRATIONS[1]).unwrap();
        c.execute_batch("PRAGMA user_version = 2").unwrap();
        let v1 = r#"{"id":"a-old","project":"p","kind":"video","role":"clip","name":"take.mp4","path":"C:/x/take.mp4","readOnly":true,"sizeBytes":5,"durationSec":10.0,"width":1920,"height":1080,"thumbPath":null,"addedAt":"2026-11-20T00:00:00Z"}"#;
        c.execute("INSERT INTO asset (id, project, json, added_at) VALUES ('a-old', 'p', ?1, '2026-11-20T00:00:00Z')", [v1]).unwrap();
        assert_eq!(migrate(&mut c).unwrap(), 3);
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0)).unwrap(), 3);
        assert_eq!(migrate(&mut c).unwrap(), 3); // idempotent
        let root = tmp_root();
        let st = MediaState::with_conn(c, &root);
        let a = &list_assets(&st, "p").unwrap()[0];
        assert_eq!((a.id.as_str(), a.duration_sec, a.tags.len(), a.flags.len(), a.moments.len(), a.transcript.clone(), a.slot_id.clone()), ("a-old", Some(10.0), 0, 0, 0, None, None));
        // v2 fields round-trip through their columns.
        let mut b = a.clone();
        b.tags = vec!["rain".into()];
        b.flags = vec![AssetFlag { kind: "dark".into(), detail: "mean luma 12%".into() }];
        b.transcript = Some(AssetTranscript { path: "working/captions/a-old.json".into(), lang: "en".into(), words: 12, first_speech_sec: Some(0.4), last_speech_sec: Some(8.0) });
        save_asset(&st, &b).unwrap();
        assert_eq!(load_asset(&st, "p", "a-old").unwrap(), b);
        // A newer schema than this app is refused.
        let mut newer = Connection::open_in_memory().unwrap();
        newer.execute_batch("PRAGMA user_version = 9").unwrap();
        assert!(migrate(&mut newer).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_project_create_update_and_brief_rules() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Rain Reel", None).unwrap();
        assert_eq!((p.status.as_str(), p.speed.as_str(), p.brief.is_none()), ("brief", "rough", true));
        let r = Path::new(&p.root);
        assert!(r.join("inbox").is_dir() && r.join("working").join("captions").is_dir());
        let json: Value = serde_json::from_str(&std::fs::read_to_string(r.join("project.json")).unwrap()).unwrap();
        assert!(json["review"]["rounds"].is_array() && json["speed"] == "rough");

        // Brief validation.
        let bad = |f: &dyn Fn(&mut CreativeBrief)| {
            let mut b = brief("director", false);
            f(&mut b);
            validate_brief(&b).is_err()
        };
        assert_eq!(validate_brief(&brief("director", false)), Ok(()));
        assert!(bad(&|b| b.idea = "  ".into()));
        assert!(bad(&|b| b.length_sec = 4.0));
        assert!(bad(&|b| b.length_sec = 601.0));
        assert!(bad(&|b| b.platform = "myspace".into()));
        assert!(bad(&|b| b.aspect = "21:9".into()));
        assert!(bad(&|b| b.references = vec!["x".into(); 11]));
        assert!(bad(&|b| b.guessed = vec!["budget".into()]));
        assert!(bad(&|b| b.guessed = vec!["tone".into(), "tone".into()]));
        assert!(bad(&|b| b.updated_by = "tony".into()));
        assert!(bad(&|b| b.goal = "g".repeat(301)));
        // Only Nic approves.
        assert!(project_update(&st, &p.slug, None, Some(brief("director", true)), None, None).unwrap_err().starts_with("PERMISSION_REQUIRED"));
        // A draft keeps the status; Nic's approval moves brief → shooting.
        let d = project_update(&st, &p.slug, None, Some(brief("director", false)), None, None).unwrap();
        assert_eq!(d.status, "brief");
        assert!(!d.brief.as_ref().unwrap().updated_at.is_empty());
        let a = project_update(&st, &p.slug, Some(" Rain Reel 2 ".into()), Some(brief("nic", true)), None, Some("polish".into())).unwrap();
        assert_eq!((a.status.as_str(), a.title.as_str(), a.speed.as_str()), ("shooting", "Rain Reel 2", "polish"));
        assert_eq!(load_project(&st, &p.slug).unwrap(), a);
        // By hand: any status; bad values refused.
        assert_eq!(project_update(&st, &p.slug, None, None, Some("brief".into()), None).unwrap().status, "brief");
        assert!(project_update(&st, &p.slug, None, None, Some("ready".into()), None).is_err());
        assert!(project_update(&st, &p.slug, None, None, None, Some("warp".into())).is_err());
        assert!(project_update(&st, &p.slug, Some("".into()), None, None, None).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_asset_update_and_slot_mirror() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Tags", None).unwrap();
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        assert_eq!(clean_tags(&[" Rain ".into(), "rain".into(), "Night".into()]).unwrap(), ["rain", "night"]);
        assert!(clean_tags(&(0..13).map(|i| format!("t{i}")).collect::<Vec<_>>()).is_err());
        assert!(clean_tags(&["".into()]).is_err());
        let a = asset_update(&st, &p.slug, "v", Some(vec!["Rain".into()]), None, None).unwrap();
        assert_eq!(a.tags, ["rain"]);
        let mo = |i: f64, o: f64, score: f64| Moment { id: "m1".into(), in_sec: i, out_sec: o, label: "the spin".into(), score, by: "director".into() };
        assert_eq!(asset_update(&st, &p.slug, "v", None, Some(vec![mo(1.0, 3.0, 0.9)]), None).unwrap().moments.len(), 1);
        assert!(asset_update(&st, &p.slug, "v", None, Some(vec![mo(1.0, 11.0, 0.9)]), None).is_err()); // past the clip
        assert!(asset_update(&st, &p.slug, "v", None, Some(vec![mo(3.0, 1.0, 0.9)]), None).is_err()); // in after out
        assert!(asset_update(&st, &p.slug, "v", None, Some(vec![mo(1.0, 3.0, 1.5)]), None).is_err()); // score
        assert!(asset_update(&st, &p.slug, "v", None, Some(vec![mo(1.0, 2.0, 0.5), mo(2.0, 3.0, 0.5)]), None).is_err()); // dup id
        assert!(asset_update(&st, &p.slug, "v", None, None, Some("s9".into())).is_err()); // no such slot
        assert!(asset_update(&st, &p.slug, "ghost", None, None, None).is_err());
        // Saving a manifest whose slot holds the asset sets the mirror; detaching clears it.
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        m.shot_list = vec![slot("s1", Some("v"))];
        let saved = manifest_save(&st, &p.slug, m).unwrap();
        assert_eq!(load_asset(&st, &p.slug, "v").unwrap().slot_id.as_deref(), Some("s1"));
        assert_eq!(asset_update(&st, &p.slug, "v", None, None, Some("".into())).unwrap().slot_id, None);
        assert_eq!(asset_update(&st, &p.slug, "v", None, None, Some("s1".into())).unwrap().slot_id.as_deref(), Some("s1"));
        let mut m2 = saved.clone();
        m2.shot_list[0].asset_id = None;
        m2.shot_list[0].status = "needed".into();
        manifest_save(&st, &p.slug, m2).unwrap();
        assert_eq!(load_asset(&st, &p.slug, "v").unwrap().slot_id, None);
        assert_eq!(load_asset(&st, &p.slug, "v").unwrap().tags, ["rain"]); // the rest survives
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_status_moves_forward_from_existing_triggers() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Moves", None).unwrap();
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        project_update(&st, &p.slug, None, Some(brief("nic", true)), None, None).unwrap();
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        m.shot_list = vec![slot("s1", None), ShotSlot { source: "generate".into(), ..slot("s2", None) }];
        let m = manifest_save(&st, &p.slug, m).unwrap();
        assert_eq!(load_project(&st, &p.slug).unwrap().status, "shooting"); // a film slot is still empty
        let mut m2 = m.clone();
        m2.shot_list[0].asset_id = Some("v".into());
        m2.shot_list[0].status = "attached".into();
        assert!(film_slots_filled(&m2));
        manifest_save(&st, &p.slug, m2).unwrap();
        assert_eq!(load_project(&st, &p.slug).unwrap().status, "editing"); // the generate slot doesn't count
        on_verified_render(&st, &p.slug, "r-1");
        let q = load_project(&st, &p.slug).unwrap();
        assert_eq!(q.status, "review");
        assert_eq!(q.review.rounds.len(), 1);
        // A later edit save doesn't pull a project back out of review.
        let cur = load_manifest(Path::new(&p.root), &p.slug);
        manifest_save(&st, &p.slug, cur).unwrap();
        assert_eq!(load_project(&st, &p.slug).unwrap().status, "review");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_notes_are_rust_owned_and_rounds_stop_at_two() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Notes", None).unwrap();
        let file = Path::new(&p.root).join("renders").join("notes_v001.mp4");
        std::fs::write(&file, b"render").unwrap();
        put_render(&st, &p.slug, "r-1", &file, 1920, 1080);
        on_verified_render(&st, &p.slug, "r-1");
        let input = |render: Option<&str>, text: &str| NoteInput { render_id: render.map(String::from), at_sec: Some(2.5), text: text.into(), by: "nic".into(), via_voice: false };
        assert!(note_add(&st, &p.slug, input(Some("r-ghost"), "x")).is_err());
        assert!(note_add(&st, &p.slug, input(Some("r-1"), "   ")).is_err());
        assert!(note_add(&st, &p.slug, NoteInput { by: "director".into(), ..input(None, "x") }).is_err());
        let rev_before = load_manifest(Path::new(&p.root), &p.slug).revision;
        let n = note_add(&st, &p.slug, input(Some("r-1"), "  tighter open ")).unwrap();
        assert_eq!((n.text.as_str(), n.resolved, n.id.starts_with("n-")), ("tighter open", false, true));
        let m = load_manifest(Path::new(&p.root), &p.slug);
        assert_eq!((m.notes.len(), m.revision), (1, rev_before)); // no revision bump
        assert_eq!(load_project(&st, &p.slug).unwrap().review.rounds[0].notes, vec![n.id.clone()]);
        // A client save without the note keeps it.
        let mut client = m.clone();
        client.notes.clear();
        assert_eq!(manifest_save(&st, &p.slug, client).unwrap().notes.len(), 1);
        note_resolve(&st, &p.slug, &n.id).unwrap();
        assert!(load_manifest(Path::new(&p.root), &p.slug).notes[0].resolved);
        assert!(note_resolve(&st, &p.slug, "n-ghost").is_err());
        // Rounds: 1 → 2 (round 1 revised), never a round 3.
        let mut rv = ProjectReview::default();
        record_review_round(&mut rv, "r-1");
        record_review_round(&mut rv, "r-1");
        record_review_round(&mut rv, "r-2");
        record_review_round(&mut rv, "r-3");
        assert_eq!(rv.rounds.iter().map(|r| (r.round, r.render_id.as_str(), r.status.as_str())).collect::<Vec<_>>(), [(1, "r-1", "revised"), (2, "r-2", "open")]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_approve_final_copies_verified_renders() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Final", None).unwrap();
        let renders = Path::new(&p.root).join("renders");
        let vert = renders.join("final_v001.mp4");
        std::fs::write(&vert, b"vertical render").unwrap();
        std::fs::write(renders.join("final_v001.srt"), b"1\n00:00:00,000 --> 00:00:01,000\nhi\n").unwrap();
        let wide = renders.join("final_v002.mp4");
        std::fs::write(&wide, b"wide render!").unwrap();
        put_render(&st, &p.slug, "r-1", &vert, 1080, 1920);
        put_render(&st, &p.slug, "r-2", &wide, 1920, 1080);
        on_verified_render(&st, &p.slug, "r-1");
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        m.outputs = vec![
            PlatformPreset { platform: "reels".into(), aspect: "9:16".into(), loudness_lufs: -14, max_size_mb: None, max_sec: Some(90.0) },
            PlatformPreset { platform: "youtube".into(), aspect: "16:9".into(), loudness_lufs: -14, max_size_mb: None, max_sec: None },
        ];
        manifest_save(&st, &p.slug, m).unwrap();

        assert!(approve_final(&st, &p.slug, &["r-1".into()], false).unwrap_err().starts_with("PERMISSION_REQUIRED"));
        assert!(approve_final(&st, &p.slug, &[], true).is_err());
        assert!(approve_final(&st, &p.slug, &["r-1".into(), "r-1".into()], true).is_err());
        assert!(approve_final(&st, &p.slug, &["r-ghost".into()], true).is_err());
        assert_ne!(load_project(&st, &p.slug).unwrap().status, "done");

        let out = approve_final(&st, &p.slug, &["r-1".into(), "r-2".into()], true).unwrap();
        assert_eq!(out.iter().map(|d| d.platform.as_str()).collect::<Vec<_>>(), ["reels", "youtube"]);
        let reel = PathBuf::from(&out[0].path);
        assert!(reel.starts_with(dunce_canon(&renders.join("final").join("reels")).unwrap()));
        assert_eq!(std::fs::read(&reel).unwrap(), b"vertical render");
        assert!(out[0].caption_path.as_deref().is_some_and(|c| c.ends_with("final_v001.srt")));
        assert_eq!((out[1].caption_path.clone(), out[1].thumb_path.clone()), (None, None));
        assert!(vert.is_file()); // the original stays
        let q = load_project(&st, &p.slug).unwrap();
        assert_eq!((q.status.as_str(), q.review.rounds[0].status.as_str()), ("done", "approved"));
        // Approving again reuses the same copies.
        assert_eq!(approve_final(&st, &p.slug, &["r-1".into()], true).unwrap()[0].path, out[0].path);
        // A render that changed on disk after verification is refused.
        std::fs::write(&wide, b"tampered, longer bytes").unwrap();
        assert!(approve_final(&st, &p.slug, &["r-2".into()], true).unwrap_err().contains("changed on disk"));
        // Frame size matches no output → custom.
        let r = VerifiedRender { width: 1080, height: 1080, ..put_render(&st, &p.slug, "r-3", &vert, 1080, 1080) };
        assert_eq!(platform_for_render(&r, &load_manifest(Path::new(&p.root), &p.slug).outputs), "custom");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_intake_status_and_transcribe_queue() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Intake", None).unwrap();
        let inbox = Path::new(&p.root).join("inbox");
        std::fs::remove_dir_all(&inbox).unwrap(); // a project from before v2
        let s0 = intake_status(&st, &p.slug).unwrap();
        assert!(inbox.is_dir() && s0.pending == 0 && s0.processing.is_none() && s0.last_error.is_none());
        std::fs::write(inbox.join("take1.mp4"), b"x").unwrap();
        std::fs::write(inbox.join(".partial"), b"x").unwrap();
        std::fs::create_dir_all(inbox.join("sub")).unwrap();
        assert_eq!(intake_status(&st, &p.slug).unwrap().pending, 1);
        
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        put_asset(&st, &p.slug, "i", "image", None);
        assert!(transcribe_enqueue(&st, &p.slug, &["i".into()]).is_err());
        assert!(transcribe_enqueue(&st, &p.slug, &["ghost".into()]).is_err());
        assert!(transcribe_enqueue(&st, &p.slug, &[]).is_err());
        assert_eq!(transcribe_enqueue(&st, &p.slug, &["v".into()]), Ok(1));
        assert_eq!(transcribe_enqueue(&st, &p.slug, &["v".into()]), Ok(0)); // already queued
        assert!(intake_status(&st, "nope").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── v2 behaviour: intake pipeline, spec v2 + outputs, review rounds ──

    /// media-forge stand-in: transcribe_batch writes a words .json for the asset's stem and hands
    /// back a running job; job_status finishes it. Every call is logged.
    struct MockForge {
        root: PathBuf,
        words: Vec<&'static str>,
        calls: std::cell::RefCell<Vec<(String, Value)>>,
        pending: std::cell::RefCell<Option<Value>>,
    }

    impl MockForge {
        fn new(root: &Path, words: &[&'static str]) -> Self {
            Self { root: root.to_path_buf(), words: words.to_vec(), calls: Default::default(), pending: Default::default() }
        }
        fn tools(&self) -> Vec<String> {
            self.calls.borrow().iter().map(|(t, _)| t.clone()).collect()
        }
    }

    impl Forge for MockForge {
        fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
            self.calls.borrow_mut().push((tool.to_string(), args.clone()));
            match tool {
                "transcribe_batch" => {
                    let (slug, stem) = (args["project"].as_str().unwrap(), args["output_stems"][0].as_str().unwrap());
                    let js = self.root.join(slug).join("working").join("captions").join(format!("{stem}.json"));
                    let words: Vec<Value> = self.words.iter().enumerate().map(|(i, w)| json!({ "w": w, "s": 0.5 + i as f64 * 0.4, "e": 0.8 + i as f64 * 0.4, "p": 0.9 })).collect();
                    let segs = if words.is_empty() { json!([]) } else { json!([{ "start": 0.5, "end": 2.0, "text": self.words.join(" "), "words": words }]) };
                    std::fs::write(&js, json!({ "language": "en", "duration": 3.0, "segments": segs }).to_string()).unwrap();
                    *self.pending.borrow_mut() = Some(json!({ "results": [{ "path": args["paths"][0], "ok": true, "json": js.to_string_lossy() }], "done": 1, "failed": 0 }));
                    Ok(json!({ "id": "job-1", "status": "running", "progress_pct": 10.0 }))
                }
                "job_status" => Ok(json!({ "id": "job-1", "status": "done", "result": self.pending.borrow().clone() })),
                // Two shots: a cut at 1.2 s (done at once, as a short job's first answer can be).
                "detect_scenes" => Ok(json!({ "id": "job-s", "status": "done", "result": { "scene_count": 2, "scenes": [{ "index": 0, "start": 0.0, "end": 1.2 }, { "index": 1, "start": 1.2, "end": 2.0 }] } })),
                other => Err(format!("unexpected tool {other}")),
            }
        }
    }

    type Events = std::cell::RefCell<Vec<Value>>;

    fn stages(ev: &Events) -> Vec<String> {
        ev.borrow().iter().map(|e| e["stage"].as_str().unwrap().to_string()).collect()
    }

    /// A short test clip made by ffmpeg (CPU libx264), or None when ffmpeg isn't installed.
    fn make_clip(dir: &Path, name: &str, video: &str, audio: Option<&str>, secs: f64) -> Option<PathBuf> {
        let ff = media_bin(&os_core::OsConfig::default(), "ffmpeg")?;
        let out = dir.join(name);
        let t = format!("{secs}");
        let mut args = vec!["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", video];
        if let Some(a) = audio {
            args.extend(["-f", "lavfi", "-i", a]);
        }
        args.extend(["-t", t.as_str(), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
        if audio.is_some() {
            args.extend(["-c:a", "aac", "-shortest"]);
        }
        let o = out.to_string_lossy().to_string();
        args.push(o.as_str());
        run_hidden(&ff, &args, Duration::from_secs(60)).ok().filter(|r| r.status.success()).map(|_| out)
    }

    #[test]
    fn v2_intake_pure_checks() {
        assert_eq!(role_for_ext("mov"), "clip");
        assert_eq!(role_for_ext("heic"), "clip"); // unknown → refused later by ingest
        assert_eq!((role_for_ext("png"), role_for_ext("m4a")), ("photo", "music"));
        assert!(inbox_ignored(".DS_Store") && inbox_ignored("take.mp4.part") && inbox_ignored("x.crdownload") && !inbox_ignored("take.mp4"));
        assert_eq!(aspect_flag(1080, 1920, "9:16"), None);
        assert_eq!(aspect_flag(1080, 1350, "4:5"), None);
        let f = aspect_flag(1920, 1080, "9:16").unwrap();
        assert_eq!(f.kind, "wrong_aspect");
        assert!(f.detail.contains("landscape") && f.detail.contains("9:16"), "{}", f.detail);
        assert!(aspect_flag(1080, 1080, "16:9").is_some() && aspect_flag(0, 0, "16:9").is_none() && aspect_flag(10, 10, "wide").is_none());
        let txt = "frame:0 pts:0 pts_time:0\nlavfi.signalstats.YAVG=20.000000\nframe:1\nlavfi.signalstats.YAVG=30.0\n";
        assert_eq!(parse_yavg(txt), Some(25.0));
        assert_eq!(parse_yavg("nothing"), None);
        assert_eq!(exposure_flag(25.0).unwrap().kind, "dark");
        assert_eq!(exposure_flag(240.0).unwrap().kind, "overexposed");
        assert_eq!(exposure_flag(120.0), None);
        assert_eq!(parse_max_volume("[Parsed_volumedetect_0 @ 0x1] mean_volume: -91.0 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -91.0 dB"), Some(-91.0));
        assert_eq!(parse_max_volume("no audio"), None);
        let old = vec![AssetFlag { kind: "dark".into(), detail: "old".into() }, AssetFlag { kind: "blurry".into(), detail: "forge".into() }];
        let merged = merge_flags(&old, vec![AssetFlag { kind: "too_short".into(), detail: "0.5 s".into() }], &PROBE_FLAG_KINDS);
        assert_eq!(merged.iter().map(|f| f.kind.as_str()).collect::<Vec<_>>(), ["blurry", "too_short"]); // re-probe replaces its own kinds only
        // Transcript summaries: word timestamps, or segment text when a file has no words.
        let t = transcript_summary("C:/p/a.json", r#"{"language":"en","segments":[{"start":0.4,"end":1.0,"text":" hi there","words":[{"w":"hi","s":0.42,"e":0.6,"p":1},{"w":"there","s":0.6,"e":0.95,"p":1}]},{"start":2,"end":3.5,"text":"bye now ok"}]}"#).unwrap();
        assert_eq!((t.words, t.first_speech_sec, t.last_speech_sec, t.lang.as_str()), (5, Some(0.42), Some(3.5), "en"));
        let none = transcript_summary("x", r#"{"language":"en","segments":[]}"#).unwrap();
        assert_eq!((none.words, none.first_speech_sec), (0, None));
        assert!(transcript_summary("x", "not json").is_err() && transcript_summary("x", "{}").is_err());
        // forge_job: errors, cancels and timeouts are reported, never hang.
        struct Fixed(Value);
        impl Forge for Fixed {
            fn call(&self, tool: &str, _: &Value) -> Result<Value, String> {
                Ok(if tool == "job_cancel" { json!({}) } else { self.0.clone() })
            }
        }
        assert_eq!(forge_job(&Fixed(json!({ "id": "j", "status": "failed", "error": "model missing" })), "transcribe_batch", &json!({}), Duration::from_secs(5)), Err("model missing".into()));
        assert!(forge_job(&Fixed(json!({ "id": "j", "status": "cancelled" })), "t", &json!({}), Duration::from_secs(5)).unwrap_err().contains("cancelled"));
        assert!(forge_job(&Fixed(json!({ "raw": "boom" })), "t", &json!({}), Duration::from_secs(5)).unwrap_err().contains("did not start"));
        assert!(forge_job(&Fixed(json!({ "id": "j", "status": "running" })), "t", &json!({}), Duration::ZERO).unwrap_err().contains("cancelled"));
    }

    #[test]
    fn v2_intake_tick_waits_for_stable_files_and_reports_errors() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Inbox", None).unwrap();
        let inbox = Path::new(&p.root).join("inbox");
        let forge = MockForge::new(&root, &["hi"]);
        let ev: Events = Default::default();
        let emit = |v: Value| ev.borrow_mut().push(v);
        let cfg = os_core::OsConfig::default();
        std::fs::write(inbox.join("notes.txt"), b"not media").unwrap();
        std::fs::write(inbox.join("take.mp4.part"), b"still copying").unwrap();
        std::fs::write(inbox.join("empty.mp4"), b"").unwrap();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert!(ev.borrow().is_empty(), "first sighting: nothing is stable yet");
        // Growing between ticks → still not stable.
        std::fs::write(inbox.join("notes.txt"), b"not media, longer").unwrap();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert!(ev.borrow().is_empty());
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert_eq!(stages(&ev), ["failed"]);
        assert!(ev.borrow()[0]["detail"].as_str().unwrap().contains("notes.txt"));
        let s = intake_status(&st, &p.slug).unwrap();
        assert!(s.last_error.as_deref().unwrap().contains("not a supported") && s.processing.is_none());
        assert!(inbox.join("notes.txt").is_file() && inbox.join("take.mp4.part").is_file()); // nothing deleted
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert_eq!(ev.borrow().len(), 1, "a failed file isn't retried until it changes");
        assert!(list_assets(&st, &p.slug).unwrap().is_empty() && forge.tools().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_intake_ingests_flags_and_transcribes_real_clips() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Drop", None).unwrap();
        project_update(&st, &p.slug, None, Some(brief("nic", true)), None, None).unwrap(); // 9:16
        let inbox = Path::new(&p.root).join("inbox");
        let scratch = root.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let Some(talk) = make_clip(&scratch, "talk.mp4", "testsrc=size=320x240:rate=15", Some("sine=frequency=440:sample_rate=48000"), 2.0) else {
            eprintln!("ffmpeg not found: skipping the real-clip intake test");
            return;
        };
        let dark = make_clip(&scratch, "dark.mp4", "color=c=black:size=180x320:rate=15", Some("anullsrc=r=48000:cl=stereo"), 0.6).unwrap();
        std::fs::copy(&talk, inbox.join("talk.mp4")).unwrap();
        std::fs::copy(&dark, inbox.join("dark.mp4")).unwrap();
        let forge = MockForge::new(&root, &["hello", "there"]);
        let ev: Events = Default::default();
        let emit = |v: Value| ev.borrow_mut().push(v);
        let cfg = os_core::OsConfig::default();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert!(ev.borrow().is_empty());
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        // Ingested in name order, then one pipeline pass at a time.
        assert_eq!(stages(&ev), ["ingested", "ingested", "probed", "probed", "transcribed"], "{:?}", ev.borrow());
        assert!(std::fs::read_dir(&inbox).unwrap().next().is_none(), "inbox copies deleted after the raw copy checked out");
        let assets = list_assets(&st, &p.slug).unwrap();
        assert_eq!(assets.len(), 2);
        let by = |n: &str| assets.iter().find(|a| a.name == n).unwrap().clone();
        let (d, t) = (by("dark.mp4"), by("talk.mp4"));
        assert!(Path::new(&t.path).starts_with(dunce_canon(&Path::new(&p.root).join("raw")).unwrap()) && t.read_only && t.role == "clip");
        let kinds = |a: &MediaAsset| a.flags.iter().map(|f| f.kind.clone()).collect::<Vec<_>>();
        assert_eq!(kinds(&t), ["wrong_aspect"], "320×240 against a 9:16 brief");
        let dk = kinds(&d);
        for k in ["too_short", "dark", "silent"] {
            assert!(dk.contains(&k.to_string()), "dark.mp4 flags {dk:?}");
        }
        assert!(!dk.contains(&"wrong_aspect".to_string()));
        // Only the clip with sound went to transcription, with the local tiny.en model.
        let calls = forge.calls.borrow();
        let tb: Vec<&Value> = calls.iter().filter(|(t, _)| t == "transcribe_batch").map(|(_, a)| a).collect();
        assert_eq!(tb.len(), 1);
        assert_eq!((tb[0]["model"].as_str(), tb[0]["output_stems"][0].as_str(), tb[0]["project"].as_str()), (Some("tiny.en"), Some(t.id.as_str()), Some(p.slug.as_str())));
        // Both videos got a CPU scene pass after the probe (no thumbnails), cut times on the asset.
        let ds: Vec<&Value> = calls.iter().filter(|(t, _)| t == "detect_scenes").map(|(_, a)| a).collect();
        assert_eq!(ds.len(), 2);
        assert_eq!((ds[0]["thumbnails"].as_bool(), ds[0]["project"].as_str()), (Some(false), Some(p.slug.as_str())));
        let order: Vec<&str> = calls.iter().map(|(t, _)| t.as_str()).filter(|t| *t != "job_status").collect();
        assert_eq!(order, ["detect_scenes", "detect_scenes", "transcribe_batch"]);
        drop(calls);
        assert_eq!((t.scenes.clone(), d.scenes.clone()), (Some(vec![1.2]), Some(vec![1.2])));
        assert!(ev.borrow().iter().any(|e| e["stage"] == "probed" && e["detail"].as_str().unwrap().contains("2 shots")), "{:?}", ev.borrow());
        let tr = t.transcript.clone().unwrap();
        assert_eq!((tr.words, tr.lang.as_str(), tr.first_speech_sec), (2, "en", Some(0.5)));
        assert!(tr.path.ends_with(&format!("{}.json", t.id)));
        assert!(d.transcript.is_none());
        let s = intake_status(&st, &p.slug).unwrap();
        assert_eq!((s.pending, s.processing, s.last_error), (0, None, None));
        // media_transcribe re-runs only the transcription (no re-probe); 0 words → no_speech.
        let quiet = MockForge::new(&root, &[]);
        assert_eq!(transcribe_enqueue(&st, &p.slug, &[t.id.clone()]), Ok(1));
        ev.borrow_mut().clear();
        intake_tick_once(&st, &cfg, &quiet, &emit).unwrap();
        assert_eq!(stages(&ev), ["transcribed"]);
        let t2 = load_asset(&st, &p.slug, &t.id).unwrap();
        assert_eq!(t2.transcript.as_ref().unwrap().words, 0);
        assert_eq!(kinds(&t2), ["wrong_aspect", "no_speech"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_transcribe_queue_survives_errors() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Queue", None).unwrap();
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        put_asset(&st, &p.slug, "w", "video", Some(10.0));
        struct Broken;
        impl Forge for Broken {
            fn call(&self, _: &str, _: &Value) -> Result<Value, String> {
                Err("Media Forge is off".into())
            }
        }
        let ev: Events = Default::default();
        let emit = |v: Value| ev.borrow_mut().push(v);
        transcribe_enqueue(&st, &p.slug, &["v".into(), "w".into()]).unwrap();
        intake_tick_once(&st, &os_core::OsConfig::default(), &Broken, &emit).unwrap();
        // Both passes ran (one failing doesn't stop the next); the error is kept for the panel.
        assert_eq!(stages(&ev), ["failed", "failed"]);
        assert_eq!(ev.borrow()[1]["assetId"], "w");
        assert_eq!(intake_status(&st, &p.slug).unwrap().last_error.as_deref(), Some("Media Forge is off"));
        assert!(st.transcribe_queue.lock().unwrap().is_empty());
        // A transcript outside the project is refused; a clean pass clears lastError.
        let forge = MockForge::new(&root, &["one"]);
        transcribe_enqueue(&st, &p.slug, &["v".into()]).unwrap();
        intake_tick_once(&st, &os_core::OsConfig::default(), &forge, &emit).unwrap();
        assert_eq!(load_asset(&st, &p.slug, "v").unwrap().transcript.unwrap().words, 1);
        assert_eq!(intake_status(&st, &p.slug).unwrap().last_error, None);
        struct Elsewhere(PathBuf);
        impl Forge for Elsewhere {
            fn call(&self, _: &str, _: &Value) -> Result<Value, String> {
                Ok(json!({ "id": "j", "status": "done", "result": { "results": [{ "ok": true, "json": self.0.to_string_lossy() }] } }))
            }
        }
        let outside = root.join("outside.json");
        std::fs::write(&outside, r#"{"language":"en","segments":[]}"#).unwrap();
        assert!(transcribe_asset(&st, &Elsewhere(outside), &p.slug, "w").unwrap_err().contains("outside this project"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn v2_edit(m: &mut TimelineManifest) {
        m.clips = vec![
            TimelineClip { transition_in: Transition { kind: "crossfade".into(), ms: 500 }, ..clip("c1", "v", 0.0, 4.0) }, // first clip: cut in
            TimelineClip { transition_in: Transition { kind: "crossfade".into(), ms: 1500 }, punch_in: 1.2, ..clip("c2", "v", 4.0, 6.0) }, // capped at 0.9 s
            TimelineClip { transition_in: Transition { kind: "fade_black".into(), ms: 400 }, ..clip("c3", "i", 0.0, 3.0) },
        ];
        m.audio = vec![AudioLayer { id: "l1".into(), asset_id: "a".into(), start_sec: 0.0, in_sec: 0.0, out_sec: 5.0, volume: 0.6, fade_in_ms: 500, fade_out_ms: 1500, duck_under_voice: true }];
        m.captions = CaptionTrack { enabled: true, style: "bold_pop".into(), position: "middle".into(), max_words_per_line: 3 };
        m.color = ColorLook { preset: "warm".into(), strength: 0.7 };
    }

    #[test]
    fn v2_render_spec_maps_the_manifest() {
        let root = tmp_root();
        let words = root.join("v.json");
        std::fs::write(&words, "{}").unwrap();
        let mut v = asset("v", "video", Some(10.0));
        v.transcript = Some(AssetTranscript { path: words.to_string_lossy().to_string(), lang: "en".into(), words: 3, first_speech_sec: None, last_speech_sec: None });
        let assets = vec![v, asset("i", "image", None), asset("a", "audio", Some(5.0))];
        let mut m = default_manifest("p");
        v2_edit(&mut m);
        assert_eq!(validate_manifest(&m, "p", &assets), Ok(()));
        let reels = PlatformPreset { platform: "reels".into(), aspect: "9:16".into(), loudness_lufs: -14, max_size_mb: Some(100.0), max_sec: Some(90.0) };
        let s = render_spec(&m, &assets, &reels, &root).unwrap();
        let keys = |v: &Value| {
            let mut k = v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
            k.sort();
            k
        };
        // Exactly media-forge's v2 key sets (it refuses unknown keys).
        assert_eq!(keys(&s), ["audio", "captions", "clip_audio_volume", "clips", "color", "fps", "height", "loudness_lufs", "max_size_mb", "project", "version", "width"]);
        assert_eq!(keys(&s["clips"][0]), ["fade_ms", "in", "kind", "out", "path", "punch_in", "transcript", "transition_in"]);
        assert_eq!(keys(&s["audio"][0]), ["duck_under_voice", "fade_in_ms", "fade_out_ms", "in", "out", "path", "start", "volume"]);
        assert_eq!((s["version"].as_u64(), s["width"].as_u64(), s["height"].as_u64(), s["loudness_lufs"].as_i64(), s["max_size_mb"].as_f64()), (Some(2), Some(1080), Some(1920), Some(-14), Some(100.0)));
        assert_eq!(s["clips"][0]["transition_in"], json!({ "kind": "cut", "ms": 0 }));
        assert_eq!(s["clips"][1]["transition_in"], json!({ "kind": "crossfade", "ms": 1500 }));
        assert_eq!(s["clips"][1]["punch_in"].as_f64(), Some(1.2));
        assert_eq!(s["clips"][2]["transition_in"], json!({ "kind": "fade_black", "ms": 400 }));
        assert_eq!(s["clips"][0]["transcript"].as_str(), Some(dunce_canon(&words).unwrap().to_string_lossy().as_ref()));
        assert_eq!(s["clips"][2]["transcript"], Value::Null); // a still has no speech
        assert_eq!(s["audio"][0]["duck_under_voice"], true);
        assert_eq!((s["audio"][0]["fade_in_ms"].as_u64(), s["audio"][0]["fade_out_ms"].as_u64()), (Some(500), Some(1500)));
        assert_eq!(s["captions"], json!({ "enabled": true, "style": "bold_pop", "position": "middle", "max_words_per_line": 3 }));
        assert_eq!(s["color"], json!({ "preset": "warm", "strength": 0.7 }));
        // 4 + 2 + 3 − the crossfade capped at 45% of the 2 s clip.
        assert!((expected_duration(&m) - 8.1).abs() < 1e-9, "{}", expected_duration(&m));
        // Captions need a transcript on disk.
        let mut no_words = assets.clone();
        no_words[0].transcript = None;
        assert!(render_spec(&m, &no_words, &reels, &root).unwrap_err().contains("transcribe them first"));
        let mut off = m.clone();
        off.captions.enabled = false;
        let s2 = render_spec(&off, &no_words, &reels, &root).unwrap();
        assert_eq!((s2["version"].as_u64(), s2["clips"][0]["transcript"].clone()), (Some(2), Value::Null));
        // A v1-equivalent manifest (a loaded v1 file) still gets the v1 spec, unchanged.
        let v1 = upgrade_manifest(serde_json::from_str(V1_MANIFEST).unwrap());
        let old_assets = vec![asset("v", "video", Some(10.0)), asset("a", "audio", Some(5.0))];
        assert!(!needs_spec_v2(&v1));
        let s1 = render_spec(&v1, &old_assets, &v1.outputs[0], &root).unwrap();
        assert_eq!(keys(&s1), ["audio", "clip_audio_volume", "clips", "fps", "height", "loudness_lufs", "max_size_mb", "project", "version", "width"]);
        assert_eq!(keys(&s1["clips"][0]), ["fade_ms", "in", "kind", "out", "path"]);
        assert_eq!((s1["version"].as_u64(), s1["width"].as_u64(), s1["loudness_lufs"].as_i64(), s1["max_size_mb"].as_f64()), (Some(1), Some(1080), Some(-18), Some(100.0)));
        assert_eq!(expected_duration(&v1), 3.0);
        // A 0 ms transition is a cut; a crossfade on clip 1 alone isn't a v2 feature.
        let mut cuts = v1.clone();
        cuts.clips[0].transition_in = Transition { kind: "crossfade".into(), ms: 800 };
        assert!(!needs_spec_v2(&cuts));
        cuts.clips[0].transition_in = Transition { kind: "fade_black".into(), ms: 0 };
        assert!(!needs_spec_v2(&cuts));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_multi_output_plan_and_specs() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Multi", None).unwrap();
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        m.clips = vec![clip("c1", "v", 0.0, 4.0), TimelineClip { transition_in: Transition { kind: "crossfade".into(), ms: 1000 }, ..clip("c2", "v", 4.0, 8.0) }];
        m.color = ColorLook { preset: "film".into(), strength: 0.5 };
        m.outputs = vec![
            PlatformPreset { platform: "reels".into(), aspect: "9:16".into(), loudness_lufs: -14, max_size_mb: None, max_sec: Some(5.0) },
            PlatformPreset { platform: "youtube".into(), aspect: "16:9".into(), loudness_lufs: -14, max_size_mb: Some(500.0), max_sec: None },
        ];
        manifest_save(&st, &p.slug, m).unwrap();
        let plan = build_plan(&st, &p.slug, "nic").unwrap();
        assert_eq!(plan.output_spec, "reels 1080×1920 · H.264/AAC · -14 LUFS · 7.0 s · over its 5 s cap | youtube 1920×1080 · H.264/AAC · -14 LUFS · 7.0 s · ≤ 500 MB · film look · 1 transition");
        let root_p = Path::new(&p.root);
        let m = load_manifest(root_p, &p.slug);
        let outs = prepare_outputs(&m, &list_assets(&st, &p.slug).unwrap(), &plan, root_p).unwrap();
        assert_eq!(outs.iter().map(|o| (o.platform.as_str(), o.w, o.h, o.cap)).collect::<Vec<_>>(), [("reels", 1080, 1920, None), ("youtube", 1920, 1080, Some(500.0))]);
        assert_eq!(outs[0].out.file_name().unwrap().to_string_lossy(), "multi_reels_v001.mp4");
        assert_eq!(outs[1].out.file_name().unwrap().to_string_lossy(), "multi_youtube_v001.mp4");
        let spec0: Value = serde_json::from_str(&std::fs::read_to_string(&outs[0].spec_path).unwrap()).unwrap();
        let spec1: Value = serde_json::from_str(&std::fs::read_to_string(&outs[1].spec_path).unwrap()).unwrap();
        assert_eq!((spec0["width"].as_u64(), spec1["width"].as_u64(), spec1["max_size_mb"].as_f64()), (Some(1080), Some(1920), Some(500.0)));
        assert_ne!(outs[0].spec_path, outs[1].spec_path);
        // One output (the v1 default): v1 names and the v1 plan text.
        let q = create_project(&st, "Single", None).unwrap();
        put_asset(&st, &q.slug, "w", "video", Some(10.0));
        let mut m1 = load_manifest(Path::new(&q.root), &q.slug);
        m1.clips = vec![clip("c1", "w", 1.0, 3.5)];
        manifest_save(&st, &q.slug, m1).unwrap();
        let plan1 = build_plan(&st, &q.slug, "director").unwrap();
        assert_eq!(plan1.output_spec, "1920×1080 · H.264/AAC · -16 LUFS · 2.5 s");
        let m1 = load_manifest(Path::new(&q.root), &q.slug);
        let o1 = prepare_outputs(&m1, &list_assets(&st, &q.slug).unwrap(), &plan1, Path::new(&q.root)).unwrap();
        assert_eq!((o1.len(), o1[0].out.file_name().unwrap().to_string_lossy().to_string()), (1, "single_v001.mp4".to_string()));
        assert!(o1[0].spec_path.ends_with(format!("render_{}.json", plan1.plan_id)));
        // Progress across the batch.
        assert_eq!((batch_pct(0, 2, 50.0), batch_pct(1, 2, 50.0), batch_pct(2, 2, 0.0), batch_pct(0, 1, 40.0)), (25.0, 75.0, 100.0, 40.0));
        assert_eq!((stage_label("reels", 0, 2, "encoding"), stage_label("reels", 0, 1, "encoding")), ("reels 1/2 · encoding".to_string(), "encoding".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_review_rounds_per_batch_and_no_round_three() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Rounds", None).unwrap();
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        m.clips = vec![clip("c1", "v", 0.0, 3.0)];
        m.outputs = vec![
            PlatformPreset { platform: "reels".into(), aspect: "9:16".into(), loudness_lufs: -14, max_size_mb: None, max_sec: None },
            PlatformPreset { platform: "tiktok".into(), aspect: "9:16".into(), loudness_lufs: -14, max_size_mb: None, max_sec: None },
        ];
        manifest_save(&st, &p.slug, m).unwrap();
        let renders = Path::new(&p.root).join("renders");
        let mk = |id: &str, plan: &str, platform: &str| {
            let f = renders.join(format!("{id}.mp4"));
            std::fs::write(&f, id.as_bytes()).unwrap();
            let r = VerifiedRender { id: id.into(), project: p.slug.clone(), plan_id: plan.into(), path: f.to_string_lossy().to_string(), duration_sec: 3.0, width: 1080, height: 1920, size_bytes: id.len() as u64, loudness_lufs: None, verify: VerifyInfo { ok: true, checks: vec![] }, created_at: now_iso() };
            record_render(&st, &r, Some(platform)).unwrap();
            on_verified_render(&st, &p.slug, id);
        };
        // Round 1: both outputs of one approved batch share it.
        mk("r-a", "p-1", "reels");
        mk("r-b", "p-1", "tiktok");
        let rv = review_get(&st, &p.slug).unwrap();
        assert_eq!(rv.rounds.iter().map(|r| (r.round, r.render_id.as_str(), r.status.as_str())).collect::<Vec<_>>(), [(1, "r-a", "open")]);
        assert_eq!(load_project(&st, &p.slug).unwrap().status, "review");
        // A note on the second output's render joins round 1.
        let n = note_add(&st, &p.slug, NoteInput { render_id: Some("r-b".into()), at_sec: Some(1.0), text: "tighter".into(), by: "nic".into(), via_voice: false }).unwrap();
        assert_eq!(review_get(&st, &p.slug).unwrap().rounds[0].notes, vec![n.id]);
        // The Director can revise once: round 2.
        assert_eq!(check_review_limit(&review_get(&st, &p.slug).unwrap(), "director"), Ok(()));
        build_plan(&st, &p.slug, "director").unwrap();
        mk("r-c", "p-2", "reels");
        let rv = review_get(&st, &p.slug).unwrap();
        assert_eq!(rv.rounds.iter().map(|r| (r.round, r.status.as_str())).collect::<Vec<_>>(), [(1, "revised"), (2, "open")]);
        // A third Director revise is refused with a clear message; Nic can still render by hand.
        let e = build_plan(&st, &p.slug, "director").unwrap_err();
        assert!(e.starts_with("REVIEW_LIMIT") && e.contains("no round 3"), "{e}");
        build_plan(&st, &p.slug, "nic").unwrap();
        mk("r-d", "p-3", "reels");
        assert_eq!(review_get(&st, &p.slug).unwrap().rounds.len(), 2);
        // Approve final: the recorded platform picks the folder (both outputs are 9:16).
        let out = approve_final(&st, &p.slug, &["r-a".into(), "r-b".into()], true).unwrap();
        assert_eq!(out.iter().map(|d| d.platform.as_str()).collect::<Vec<_>>(), ["reels", "tiktok"]);
        assert!(PathBuf::from(&out[1].path).starts_with(dunce_canon(&renders.join("final").join("tiktok")).unwrap()));
        let q = load_project(&st, &p.slug).unwrap();
        assert_eq!((q.status.as_str(), q.review.rounds[0].status.as_str(), q.review.rounds[1].status.as_str()), ("done", "approved", "open")); // only the approved batch's round changes
        // Stored in project.json too.
        let pj: Value = serde_json::from_str(&std::fs::read_to_string(Path::new(&p.root).join("project.json")).unwrap()).unwrap();
        assert_eq!(pj["review"]["rounds"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_scene_cuts_and_clipped_flag_pure() {
        let r = json!({ "scene_count": 4, "scenes": [{ "start": 0.0 }, { "start": 3.33333 }, { "start": 1.5 }, { "start": 1.5 }, { "end": 9.0 }] });
        assert_eq!(scene_cuts(&r), Ok(vec![1.5, 3.333]));
        assert_eq!(scene_cuts(&json!({ "scene_count": 1, "scenes": [{ "start": 0.0, "end": 5.0 }] })), Ok(vec![])); // one continuous shot
        assert!(scene_cuts(&json!({})).is_err());
        let many: Vec<Value> = (0..400).map(|i| json!({ "start": i as f64 * 0.5 })).collect();
        let cuts = scene_cuts(&json!({ "scenes": many })).unwrap();
        assert_eq!((cuts.len(), cuts[0]), (MAX_SCENE_CUTS, 0.5));
        assert_eq!(clipped_flag(0.0).unwrap().kind, "clipped_audio");
        assert!(clipped_flag(-0.1).is_some() && clipped_flag(-0.2).is_none() && clipped_flag(-18.0).is_none() && clipped_flag(f64::NAN).is_none());
        // A re-probe replaces an old clipped flag (it's a probe kind); detect_scenes on a photo is refused.
        let merged = merge_flags(&[AssetFlag { kind: "clipped_audio".into(), detail: "old".into() }], vec![], &PROBE_FLAG_KINDS);
        assert!(merged.is_empty());
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Stills", None).unwrap();
        put_asset(&st, &p.slug, "ph", "image", None);
        let forge = MockForge::new(&root, &[]);
        assert!(detect_asset_scenes(&st, &forge, &p.slug, "ph").unwrap_err().contains("only video"));
        assert!(forge.tools().is_empty());
        // v1 asset json (no scenes key) reads as None; a stored list round-trips.
        assert_eq!(load_asset(&st, &p.slug, "ph").unwrap().scenes, None);
        let mut v = put_asset(&st, &p.slug, "v", "video", Some(5.0));
        v.scenes = Some(vec![1.0, 2.5]);
        save_asset(&st, &v).unwrap();
        assert_eq!(load_asset(&st, &p.slug, "v").unwrap().scenes, Some(vec![1.0, 2.5]));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_clipped_audio_flag_and_scene_failure_on_a_real_clip() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Loud", None).unwrap();
        let scratch = root.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        // Full-scale square wave: peaks at 0 dBFS. A quiet sine (-18 dBFS) beside it isn't flagged.
        let Some(loud) = make_clip(&scratch, "loud.mp4", "testsrc=size=160x120:rate=15", Some("aevalsrc=exprs=sgn(sin(2*PI*220*t)):s=48000"), 1.5) else {
            eprintln!("ffmpeg not found: skipping the clipped-audio test");
            return;
        };
        let calm = make_clip(&scratch, "calm.mp4", "testsrc=size=160x120:rate=15", Some("sine=frequency=440:sample_rate=48000"), 1.5).unwrap();
        let a = ingest_paths(&st, &os_core::OsConfig::default(), &p.slug, &[loud.to_string_lossy().to_string(), calm.to_string_lossy().to_string()], "clip").unwrap();
        let cfg = os_core::OsConfig::default();
        let (lf, lsound) = probe_flags(&cfg, &a[0], None).unwrap();
        assert!(lsound && lf.iter().any(|f| f.kind == "clipped_audio"), "{lf:?}");
        let (cf, _) = probe_flags(&cfg, &a[1], None).unwrap();
        assert!(!cf.iter().any(|f| f.kind == "clipped_audio"), "{cf:?}");
        // Scene detection failing (no PySceneDetect / Media Forge off) doesn't stop the pass.
        struct NoScenes(MockForge);
        impl Forge for NoScenes {
            fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
                if tool == "detect_scenes" {
                    return Err("PySceneDetect is not installed".into());
                }
                self.0.call(tool, args)
            }
        }
        let forge = NoScenes(MockForge::new(&root, &["loud"]));
        let ev: Events = Default::default();
        let emit = |v: Value| ev.borrow_mut().push(v);
        run_intake_job(&st, &cfg, &forge, &IntakeJob { slug: p.slug.clone(), asset_id: a[0].id.clone(), analyze: true }, &emit).unwrap();
        assert_eq!(stages(&ev), ["probed", "transcribed"]);
        let got = load_asset(&st, &p.slug, &a[0].id).unwrap();
        assert_eq!(got.scenes, None);
        assert!(got.flags.iter().any(|f| f.kind == "clipped_audio") && got.transcript.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn v2_review_write_stores_summary_and_open_decisions() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Words", None).unwrap();
        // No round yet: a summary is refused, open decisions alone are fine.
        assert!(review_write(&st, &p.slug, 1, Some("tight".into()), None).unwrap_err().contains("no review round 1"));
        let rv = review_write(&st, &p.slug, 1, None, Some(vec![" Music or no music? ".into(), "Music or no music?".into()])).unwrap();
        assert_eq!(rv.open_decisions, ["Music or no music?"]); // trimmed, de-duplicated
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        m.clips = vec![clip("c1", "v", 0.0, 3.0)];
        manifest_save(&st, &p.slug, m).unwrap();
        let f = Path::new(&p.root).join("renders").join("r-1.mp4");
        std::fs::write(&f, b"r-1").unwrap();
        record_render(&st, &VerifiedRender { id: "r-1".into(), project: p.slug.clone(), plan_id: "p-1".into(), path: f.to_string_lossy().to_string(), duration_sec: 3.0, width: 1080, height: 1920, size_bytes: 3, loudness_lufs: None, verify: VerifyInfo { ok: true, checks: vec![] }, created_at: now_iso() }, None).unwrap();
        on_verified_render(&st, &p.slug, "r-1");
        let rv = review_write(&st, &p.slug, 1, Some("  Opened on the laugh; cut the second take.  ".into()), None).unwrap();
        assert_eq!(rv.rounds[0].summary, "Opened on the laugh; cut the second take.");
        assert_eq!(rv.open_decisions, ["Music or no music?"], "a summary-only write keeps the decisions");
        assert_eq!(rv.rounds[0].status, "open", "writing words never changes a round's status");
        assert!(review_write(&st, &p.slug, 2, Some("x".into()), None).unwrap_err().contains("no review round 2"));
        // Limits and shape.
        assert!(review_write(&st, &p.slug, 3, None, Some(vec![])).unwrap_err().contains("1 or 2"));
        assert!(review_write(&st, &p.slug, 1, None, None).unwrap_err().contains("nothing to write"));
        assert!(review_write(&st, &p.slug, 1, Some("x".repeat(MAX_REVIEW_SUMMARY + 1)), None).unwrap_err().contains("2000"));
        assert!(review_write(&st, &p.slug, 1, None, Some(vec!["d".into(); MAX_OPEN_DECISIONS + 1])).unwrap_err().contains("12"));
        assert!(review_write(&st, &p.slug, 1, None, Some(vec!["y".repeat(MAX_DECISION_CHARS + 1)])).unwrap_err().contains("300"));
        assert!(review_write(&st, &p.slug, 1, None, Some(vec!["  ".into()])).unwrap_err().contains("empty"));
        assert!(review_write(&st, "nope", 1, None, Some(vec![])).is_err());
        // An empty list clears; the stored review is what media_review_get and project.json show.
        review_write(&st, &p.slug, 1, None, Some(vec![])).unwrap();
        let got = review_get(&st, &p.slug).unwrap();
        assert_eq!((got.rounds[0].summary.as_str(), got.open_decisions.len()), ("Opened on the laugh; cut the second take.", 0));
        let pj: Value = serde_json::from_str(&std::fs::read_to_string(Path::new(&p.root).join("project.json")).unwrap()).unwrap();
        assert_eq!(pj["review"]["rounds"][0]["summary"], "Opened on the laugh; cut the second take.");
        assert!(pj["review"]["openDecisions"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── Review-fix regressions ──

    #[test]
    fn fix_inbox_needs_stable_mtime_and_retries_transient_errors() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Mtime", None).unwrap();
        let inbox = Path::new(&p.root).join("inbox");
        let f = inbox.join("take.mp4");
        std::fs::write(&f, vec![0u8; 64]).unwrap();
        assert!(stable_inbox_files(&st, &inbox).is_empty(), "first sighting");
        // Same size, new mtime (a preallocated file being filled in): not stable.
        let h = std::fs::OpenOptions::new().write(true).open(&f).unwrap();
        h.set_modified(std::time::SystemTime::now() + Duration::from_secs(5)).unwrap();
        drop(h);
        assert!(stable_inbox_files(&st, &inbox).is_empty(), "mtime moved");
        let s = stable_inbox_files(&st, &inbox);
        assert_eq!(s.len(), 1);
        // A transient failure backs off but isn't permanent.
        mark_inbox_retry(&st, &s[0]);
        assert!(stable_inbox_files(&st, &inbox).is_empty(), "backing off");
        st.inbox_seen.lock().unwrap().get_mut(&f).unwrap().retry_at = Some(std::time::Instant::now());
        assert_eq!(stable_inbox_files(&st, &inbox).len(), 1, "retried after the backoff");
        assert_eq!(st.inbox_seen.lock().unwrap()[&f].attempts, 1);
        mark_inbox_retry(&st, &s[0]);
        assert_eq!(st.inbox_seen.lock().unwrap()[&f].attempts, 2);
        // A permanent one waits for a change.
        mark_inbox_failed(&st, &s[0]);
        assert!(stable_inbox_files(&st, &inbox).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn fix_inbox_file_open_for_writing_is_never_ingested() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Locked", None).unwrap();
        let inbox = Path::new(&p.root).join("inbox");
        let f = inbox.join("phone.mp4");
        std::fs::write(&f, vec![0u8; 4096]).unwrap();
        let writer = std::fs::OpenOptions::new().write(true).open(&f).unwrap(); // a copy still in progress
        let forge = MockForge::new(&root, &[]);
        let ev: Events = Default::default();
        let emit = |v: Value| ev.borrow_mut().push(v);
        let cfg = os_core::OsConfig::default();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert_eq!(stages(&ev), ["failed"]);
        assert!(ev.borrow()[0]["detail"].as_str().unwrap().contains("still being written"));
        assert!(f.is_file() && list_assets(&st, &p.slug).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(Path::new(&p.root).join("raw")).unwrap().count(), 0, "no partial raw copy left");
        let seen = st.inbox_seen.lock().unwrap()[&f];
        assert!(!seen.failed && seen.retry_at.is_some(), "transient: retried, not skipped for good");
        drop(writer);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fix_inbox_ingested_but_kept_only_retries_the_delete() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Kept", None).unwrap();
        let inbox = Path::new(&p.root).join("inbox");
        let f = inbox.join("take.mp4");
        std::fs::write(&f, b"bytes").unwrap();
        let meta = std::fs::metadata(&f).unwrap();
        let file = InboxFile { path: f.clone(), size: meta.len(), mtime: meta.modified().ok() };
        remember_ingested(&st, &file, "a-1");
        assert_eq!(already_ingested(&st, &file).as_deref(), Some("a-1"));
        let forge = MockForge::new(&root, &[]);
        let ev: Events = Default::default();
        let emit = |v: Value| ev.borrow_mut().push(v);
        let cfg = os_core::OsConfig::default();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        intake_tick_once(&st, &cfg, &forge, &emit).unwrap();
        assert!(!f.exists(), "the delete was retried");
        assert!(ev.borrow().is_empty() && list_assets(&st, &p.slug).unwrap().is_empty(), "never ingested a second time");
        assert_eq!(already_ingested(&st, &file), None);
        // A record for an older version of the file doesn't match a changed one.
        remember_ingested(&st, &file, "a-1");
        assert_eq!(already_ingested(&st, &InboxFile { size: 99, ..file.clone() }), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fix_unreadable_manifest_is_never_replaced() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Corrupt", None).unwrap();
        let mp = manifest_path(Path::new(&p.root));
        let junk = b"{ \"version\": 2, \"clips\": [ truncated".to_vec();
        std::fs::write(&mp, &junk).unwrap();
        let note = NoteInput { render_id: None, at_sec: None, text: "hi".into(), by: "nic".into(), via_voice: false };
        assert!(note_add(&st, &p.slug, note).unwrap_err().starts_with("MANIFEST_UNREADABLE"));
        assert!(note_resolve(&st, &p.slug, "n-x").unwrap_err().starts_with("MANIFEST_UNREADABLE"));
        assert!(manifest_save(&st, &p.slug, default_manifest(&p.slug)).unwrap_err().starts_with("MANIFEST_UNREADABLE"));
        assert!(build_plan(&st, &p.slug, "nic").unwrap_err().starts_with("MANIFEST_UNREADABLE"));
        assert_eq!(std::fs::read(&mp).unwrap(), junk, "left as it was");
        // No file yet = the default (a new project).
        std::fs::remove_file(&mp).unwrap();
        assert_eq!(load_manifest_strict(Path::new(&p.root), &p.slug).unwrap().revision, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fix_cancel_during_output_start_is_kept() {
        let jobs: Mutex<HashMap<String, LiveRender>> = Default::default();
        jobs.lock().unwrap().insert("b".into(), LiveRender { forge_job: "j1".into(), cancelled: false });
        assert!(!adopt_forge_job(&jobs, "b", "j2"));
        assert_eq!(jobs.lock().unwrap()["b"].forge_job, "j2");
        jobs.lock().unwrap().get_mut("b").unwrap().cancelled = true; // Cancel clicked while j3 starts
        assert!(adopt_forge_job(&jobs, "b", "j3"), "the new job must be cancelled too");
        assert_eq!(jobs.lock().unwrap()["b"].forge_job, "j3");
        assert!(adopt_forge_job(&jobs, "gone", "j4"));
    }

    #[test]
    fn fix_one_live_batch_per_project_and_plans_run_once_within_the_round_cap() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Batches", None).unwrap();
        claim_render(&st, &p.slug).unwrap();
        assert!(claim_render(&st, &p.slug).unwrap_err().starts_with("RENDER_BUSY"));
        claim_render(&st, "other").unwrap();
        release_render(&st, &p.slug);
        claim_render(&st, &p.slug).unwrap();
        put_asset(&st, &p.slug, "v", "video", Some(10.0));
        let mut m = load_manifest(Path::new(&p.root), &p.slug);
        m.clips = vec![clip("c1", "v", 0.0, 3.0)];
        manifest_save(&st, &p.slug, m).unwrap();
        let plan = build_plan(&st, &p.slug, "director").unwrap();
        assert_eq!(check_plan_executable(&st, &p.slug, &plan), Ok(()));
        assert!(check_plan_executable(&st, "other", &plan).is_err());
        // Two rounds open while the Director's plan waits (a hand render meanwhile): refused at execute.
        let renders = Path::new(&p.root).join("renders");
        for (id, pl) in [("r-1", "p-a"), ("r-2", "p-b")] {
            let f = renders.join(format!("{id}.mp4"));
            std::fs::write(&f, id.as_bytes()).unwrap();
            let r = VerifiedRender { id: id.into(), project: p.slug.clone(), plan_id: pl.into(), path: f.to_string_lossy().to_string(), duration_sec: 3.0, width: 1920, height: 1080, size_bytes: 3, loudness_lufs: None, verify: VerifyInfo { ok: true, checks: vec![] }, created_at: now_iso() };
            record_render(&st, &r, None).unwrap();
            on_verified_render(&st, &p.slug, id);
        }
        assert_eq!(review_get(&st, &p.slug).unwrap().rounds.len(), 2);
        assert!(check_plan_executable(&st, &p.slug, &plan).unwrap_err().starts_with("REVIEW_LIMIT"));
        let nic = build_plan(&st, &p.slug, "nic").unwrap();
        assert_eq!(check_plan_executable(&st, &p.slug, &nic), Ok(()));
        mark_plan_used(&st, &nic.plan_id);
        assert!(check_plan_executable(&st, &p.slug, &nic).unwrap_err().starts_with("PLAN_USED"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fix_project_writes_dont_drop_review_rounds_and_deliverables_persist() {
        let root = tmp_root();
        let st = std::sync::Arc::new(MediaState::in_memory(&root));
        let p = create_project(&st, "Race", None).unwrap();
        let f = Path::new(&p.root).join("renders").join("r-1.mp4");
        std::fs::write(&f, b"render").unwrap();
        put_render(&st, &p.slug, "r-1", &f, 1920, 1080);
        let (a, b) = (st.clone(), st.clone());
        let slug = p.slug.clone();
        let edits = std::thread::spawn(move || {
            for i in 0..40 {
                project_update(&a, &slug, Some(format!("Race {i}")), None, None, None).unwrap();
            }
        });
        let slug = p.slug.clone();
        let round = std::thread::spawn(move || on_verified_render(&b, &slug, "r-1"));
        edits.join().unwrap();
        round.join().unwrap();
        let q = load_project(&st, &p.slug).unwrap();
        assert_eq!((q.review.rounds.len(), q.status.as_str(), q.title.as_str()), (1, "review", "Race 39"));
        // Approve final: the deliverables come back after a project switch or restart.
        assert!(deliverables_get(&st, &p.slug).unwrap().is_empty());
        let out = approve_final(&st, &p.slug, &["r-1".into()], true).unwrap();
        assert_eq!(deliverables_get(&st, &p.slug).unwrap(), out);
        assert_eq!(load_project(&st, &p.slug).unwrap().review.rounds[0].status, "approved");
        std::fs::remove_file(&out[0].path).unwrap();
        assert!(deliverables_get(&st, &p.slug).unwrap().is_empty(), "a deliverable that's gone is dropped");
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Part 2 provenance: `ingest_generated`, the sidecar, the checkpoint hash cache (temp dirs only).
#[cfg(test)]
mod gen_tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("media-gen-test-{}", short_id("t")));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn meta(ckpt: Option<&Path>) -> GenMeta {
        GenMeta {
            template: "sdxl-turbo-still".into(),
            prompt: "a neon dance studio at night".into(),
            negative: "blurry".into(),
            seed: 424242,
            steps: 4,
            cfg: 1.0,
            sampler: "euler_ancestral".into(),
            scheduler: "normal".into(),
            width: 1024,
            height: 576,
            denoise: 1.0,
            checkpoint_path: ckpt.map(|p| p.to_string_lossy().to_string()),
            comfyui_version: "0.46.0".into(),
            workflow: json!({ "3": { "class_type": "KSampler", "inputs": { "seed": 424242, "steps": 4 } } }),
            comfy_job_id: "g-1".into(),
            prompt_id: "6f1c-prompt".into(),
            render_ms: 2150,
            peak_vram_mb: Some(7300),
            whisper_resident: Some(true),
            ..Default::default()
        }
    }

    fn sha_hex(b: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(b))
    }

    #[test]
    fn ingest_generated_copies_read_only_and_writes_the_sidecar() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let p = create_project(&st, "Gen Test", None).unwrap();
        let out = root.join("comfy-out");
        std::fs::create_dir_all(&out).unwrap();
        let png = out.join("ComfyUI_00001_.png");
        let bytes: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&png, &bytes).unwrap();
        let ckpt = out.join("sd_xl_turbo_1.0_fp16.safetensors");
        std::fs::write(&ckpt, b"fake checkpoint bytes").unwrap();

        let a = ingest_generated(&st, &p.slug, &png, &meta(Some(&ckpt))).unwrap();
        assert_eq!((a.kind.as_str(), a.role.as_str(), a.read_only), ("image", "photo", true));
        assert_eq!((a.width, a.height, a.duration_sec, a.size_bytes), (Some(1024), Some(576), None, 5000));
        let raw = Path::new(&a.path);
        assert!(raw.starts_with(dunce_canon(&Path::new(&p.root).join("raw")).unwrap()));
        assert_eq!(std::fs::read(raw).unwrap(), bytes, "byte-identical copy");
        assert!(std::fs::metadata(raw).unwrap().permissions().readonly());
        assert!(png.is_file(), "the ComfyUI output is copied, never moved");

        let g = a.generation.as_ref().unwrap();
        assert_eq!(g.checkpoint, "sd_xl_turbo_1.0_fp16.safetensors");
        assert_eq!(g.checkpoint_sha256.as_deref(), Some(sha_hex(b"fake checkpoint bytes").as_str()));
        assert!(g.workflow.is_null(), "the asset row doesn't carry the workflow graph");
        assert!(!g.created_at.is_empty());

        // The sidecar: every field, plus the exact workflow.
        let side = Path::new(&p.root).join("working").join("gen").join(format!("{}.gen.json", a.id));
        assert_eq!(g.sidecar_path.as_deref(), Some(side.to_string_lossy().as_ref()));
        let s: Value = serde_json::from_str(&std::fs::read_to_string(&side).unwrap()).unwrap();
        for k in ["template", "prompt", "negative", "seed", "steps", "cfg", "sampler", "scheduler", "width", "height", "denoise", "checkpoint", "checkpointSha256", "comfyuiVersion", "workflow", "comfyJobId", "promptId", "renderMs", "peakVramMb", "whisperResident", "createdAt"] {
            assert!(s.get(k).is_some(), "sidecar misses {k}");
        }
        assert_eq!(s["workflow"], meta(None).workflow);
        assert_eq!((s["seed"].as_u64(), s["assetId"].as_str(), s["comfyuiVersion"].as_str()), (Some(424242), Some(a.id.as_str()), Some("0.46.0")));
        assert_eq!(s["whisperResident"], json!(true));

        // Stored and listed with its provenance; a second render of the same name doesn't clobber.
        assert_eq!(load_asset(&st, &p.slug, &a.id).unwrap(), a);
        let b = ingest_generated(&st, &p.slug, &png, &GenMeta { whisper_resident: None, peak_vram_mb: None, ..meta(None) }).unwrap();
        assert_ne!(a.path, b.path);
        assert_eq!(b.generation.as_ref().unwrap().checkpoint_sha256, None, "no checkpoint path = unknown hash");
        assert_eq!(list_assets(&st, &p.slug).unwrap().len(), 2);
        let s2: Value = serde_json::from_str(&std::fs::read_to_string(b.generation.unwrap().sidecar_path.unwrap()).unwrap()).unwrap();
        assert!(s2["whisperResident"].is_null() && s2["peakVramMb"].is_null());

        // A generated clip: role clip, the caller's duration; audio / unknown files are refused.
        let mp4 = out.join("gen.mp4");
        std::fs::write(&mp4, b"not really an mp4").unwrap();
        let v = ingest_generated(&st, &p.slug, &mp4, &GenMeta { duration_sec: Some(2.5), ..meta(None) }).unwrap();
        assert_eq!((v.kind.as_str(), v.role.as_str(), v.duration_sec), ("video", "clip", Some(2.5)));
        let wav = out.join("x.wav");
        std::fs::write(&wav, b"x").unwrap();
        assert!(ingest_generated(&st, &p.slug, &wav, &meta(None)).is_err());
        assert!(ingest_generated(&st, &p.slug, &out.join("missing.png"), &meta(None)).is_err());
        let empty = out.join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(ingest_generated(&st, &p.slug, &empty, &meta(None)).is_err());
        assert!(ingest_generated(&st, "no-such-project", &png, &meta(None)).is_err());
        assert_eq!(list_assets(&st, &p.slug).unwrap().len(), 3, "failed ingests record nothing");

        for e in std::fs::read_dir(Path::new(&p.root).join("raw")).unwrap() {
            remove_staged(&e.unwrap().path());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn checkpoint_hash_is_cached_by_path_size_and_mtime() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        let ckpt = root.join("model.safetensors");
        std::fs::write(&ckpt, b"weights v1").unwrap();
        let h1 = checkpoint_sha256(&st, &ckpt).unwrap();
        assert_eq!(h1, sha_hex(b"weights v1"));
        // Prove the second call reads the cache, not the file: plant a marker under the same size+mtime.
        let key = ckpt_hash_key(&dunce_canon(&ckpt).unwrap());
        let mut v: Value = serde_json::from_str(&st.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [&key], |r| r.get::<_, String>(0)).map_err(sql_err)).unwrap()).unwrap();
        v["sha256"] = json!("cached-marker");
        st.with(|c| c.execute("UPDATE kv SET value = ?2 WHERE key = ?1", params![key, v.to_string()]).map(|_| ()).map_err(sql_err)).unwrap();
        assert_eq!(checkpoint_sha256(&st, &ckpt).unwrap(), "cached-marker");
        // A changed file (size differs) is hashed again and the cache refreshed.
        std::fs::write(&ckpt, b"weights v2, longer").unwrap();
        assert_eq!(checkpoint_sha256(&st, &ckpt).unwrap(), sha_hex(b"weights v2, longer"));
        assert_eq!(checkpoint_sha256(&st, &ckpt).unwrap(), sha_hex(b"weights v2, longer"));
        assert!(checkpoint_sha256(&st, &root.join("absent.safetensors")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn old_asset_rows_load_without_generation() {
        // A v1 row (no v2 fields) and a v2 row (no generation) both load with `generation: None`,
        // and an asset without provenance serialises without the key.
        let v1 = r#"{"id":"a-1","project":"p","kind":"video","role":"clip","name":"a.mp4","path":"C:/x/a.mp4","readOnly":true,"sizeBytes":1,"durationSec":2.0,"width":null,"height":null,"thumbPath":null,"addedAt":"t"}"#;
        let a: MediaAsset = serde_json::from_str(v1).unwrap();
        assert!(a.generation.is_none() && a.scenes.is_none());
        let v2 = serde_json::to_string(&MediaAsset { tags: vec!["x".into()], scenes: Some(vec![]), ..a.clone() }).unwrap();
        assert!(!v2.contains("generation"));
        assert!(serde_json::from_str::<MediaAsset>(&v2).unwrap().generation.is_none());
        // A partial generation record (older bridge) fills the rest with defaults.
        let g: MediaAsset = serde_json::from_str(&v1.replace(r#""addedAt":"t""#, r#""addedAt":"t","generation":{"template":"t1","seed":7}"#)).unwrap();
        let gm = g.generation.unwrap();
        assert_eq!((gm.template.as_str(), gm.seed, gm.steps, gm.workflow.is_null()), ("t1", 7, 0, true));
        // Through the db: a row written before Part 2 still lists.
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        st.with(|c| c.execute("INSERT INTO asset (id, project, json, added_at, tags, flags, moments) VALUES ('a-1', 'p', ?1, 't', '[]', '[]', '[]')", [v1]).map(|_| ()).map_err(sql_err)).unwrap();
        let rows = list_assets(&st, "p").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].generation.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The live Director Suite E2E run (#[ignore]d, E2E_LIVE=1): media_e2e.rs.
#[cfg(test)]
#[path = "media_e2e.rs"]
mod e2e_live;
