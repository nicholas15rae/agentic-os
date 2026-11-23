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

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaProject {
    pub slug: String,
    pub title: String,
    pub status: String,
    pub root: String,
    pub created_at: String,
    pub updated_at: String,
    pub source: Source,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineClip {
    pub id: String,
    pub asset_id: String,
    pub in_sec: f64,
    pub out_sec: f64,
    pub fade_ms: u32,
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

const MIGRATIONS: &[&str] = &["CREATE TABLE project (slug TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE asset (id TEXT PRIMARY KEY, project TEXT NOT NULL, json TEXT NOT NULL, added_at TEXT NOT NULL);
     CREATE INDEX asset_project ON asset(project, added_at);
     CREATE TABLE plan (id TEXT PRIMARY KEY, project TEXT NOT NULL, json TEXT NOT NULL);
     CREATE TABLE render (id TEXT PRIMARY KEY, project TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE INDEX render_project ON render(project, created_at);"];

fn sql_err(e: rusqlite::Error) -> String {
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
    /// media-forge job id → project slug, while a render is live.
    jobs: Mutex<HashMap<String, String>>,
    /// Serialises manifest read-modify-write per process.
    manifest_lock: Mutex<()>,
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

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.conn.lock().unwrap();
        if g.is_none() {
            let path = self.path.lock().unwrap().clone().ok_or("media library isn't initialised")?;
            *g = Some(open_db(&path)?);
        }
        f(g.as_mut().expect("connection just opened"))
    }

    fn projects_root(&self) -> PathBuf {
        self.root.lock().unwrap().clone().unwrap_or_else(|| PathBuf::from(os_core::MEDIA_ROOT).join("projects"))
    }

    #[cfg(test)]
    pub(crate) fn in_memory(root: &Path) -> Self {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        let s = Self::default();
        *s.conn.lock().unwrap() = Some(c);
        *s.root.lock().unwrap() = Some(root.to_path_buf());
        s
    }
}

// ── Small helpers ──────────────────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn short_id(prefix: &str) -> String {
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

fn ext_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn kind_for_ext(ext: &str) -> Option<&'static str> {
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

fn unique_path(dir: &Path, name: &str) -> PathBuf {
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

fn inside(path: &Path, root: &Path) -> bool {
    match (dunce_canon(path), dunce_canon(root)) {
        (Some(p), Some(r)) => p.starts_with(r),
        _ => false,
    }
}

/// Canonical path without the `\\?\` prefix (so comparisons and the webview's asset URLs agree).
fn dunce_canon(p: &Path) -> Option<PathBuf> {
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

fn project_root(state: &MediaState, slug: &str) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("bad project slug: {slug:?}"));
    }
    Ok(state.projects_root().join(slug))
}

fn load_project(state: &MediaState, slug: &str) -> Result<MediaProject, String> {
    state
        .with(|c| c.query_row("SELECT json FROM project WHERE slug = ?1", [slug], |r| r.get::<_, String>(0)).optional().map_err(sql_err))?
        .ok_or_else(|| format!("no media project {slug:?}"))
        .and_then(|j| serde_json::from_str(&j).map_err(|e| e.to_string()))
}

fn save_project(state: &MediaState, p: &MediaProject) -> Result<(), String> {
    let j = serde_json::to_string(p).map_err(|e| e.to_string())?;
    state.with(|c| c.execute("INSERT INTO project (slug, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(slug) DO UPDATE SET json = ?2, updated_at = ?3", params![p.slug, j, p.updated_at]).map(|_| ()).map_err(sql_err))?;
    let root = PathBuf::from(&p.root);
    write_atomic(&root.join("project.json"), serde_json::to_string_pretty(p).map_err(|e| e.to_string())?.as_bytes())
}

fn set_status(state: &MediaState, slug: &str, status: &str) {
    if let Ok(mut p) = load_project(state, slug) {
        if p.status != status {
            p.status = status.into();
            p.updated_at = now_iso();
            let _ = save_project(state, &p);
        }
    }
}

fn list_assets(state: &MediaState, slug: &str) -> Result<Vec<MediaAsset>, String> {
    state.with(|c| {
        let mut st = c.prepare("SELECT json FROM asset WHERE project = ?1 ORDER BY added_at, id").map_err(sql_err)?;
        let rows = st.query_map([slug], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
    })
}

fn save_asset(state: &MediaState, a: &MediaAsset) -> Result<(), String> {
    let j = serde_json::to_string(a).map_err(|e| e.to_string())?;
    state.with(|c| c.execute("INSERT OR REPLACE INTO asset (id, project, json, added_at) VALUES (?1, ?2, ?3, ?4)", params![a.id, a.project, j, a.added_at]).map(|_| ()).map_err(sql_err))
}

fn list_renders(state: &MediaState, slug: &str) -> Result<Vec<VerifiedRender>, String> {
    state.with(|c| {
        let mut st = c.prepare("SELECT json FROM render WHERE project = ?1 ORDER BY created_at DESC").map_err(sql_err)?;
        let rows = st.query_map([slug], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
    })
}

fn default_manifest(slug: &str) -> TimelineManifest {
    TimelineManifest {
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
    }
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("working").join("timeline_manifest.json")
}

fn load_manifest(root: &Path, slug: &str) -> TimelineManifest {
    std::fs::read_to_string(manifest_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| default_manifest(slug))
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
    for sub in ["raw", "working", "renders"] {
        std::fs::create_dir_all(root.join(sub)).map_err(|e| format!("create {}: {e}", root.join(sub).display()))?;
    }
    let brief = source.brief.map(|b| b.chars().take(8000).collect::<String>());
    let now = now_iso();
    let p = MediaProject {
        slug: slug.clone(),
        title: title.into(),
        status: "intake".into(),
        root: root.to_string_lossy().to_string(),
        created_at: now.clone(),
        updated_at: now,
        source: Source { from: source.from, ref_id: source.ref_id.map(|r| r.chars().take(120).collect()), brief },
    };
    save_project(state, &p)?;
    let m = default_manifest(&slug);
    write_atomic(&manifest_path(&root), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())?;
    Ok(p)
}

// ── Ingest ─────────────────────────────────────────────────────────────────────

/// Finish an ingest: `staged` is already inside `raw/` (copied or uploaded). Marks it
/// read-only, probes it, makes a thumbnail and records the asset.
fn finalize_asset(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, staged: &Path, display: &str, role: &str, read_only: bool) -> Result<MediaAsset, String> {
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
    };
    save_asset(state, &a)?;
    let mut p = load_project(state, slug)?;
    if p.status == "intake" {
        p.status = "awaiting_media".into();
    }
    p.updated_at = now_iso();
    save_project(state, &p)?;
    Ok(a)
}

fn check_role(role: &str) -> Result<(), String> {
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

fn remove_staged(p: &Path) {
    if let Ok(meta) = std::fs::metadata(p) {
        let mut perm = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(p, perm);
    }
    let _ = std::fs::remove_file(p);
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
    if m.version != 1 || m.project != slug {
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
    }
    if !["nic", "director"].contains(&m.updated_by.as_str()) {
        return Err("updatedBy must be nic or director".into());
    }
    Ok(())
}

pub(crate) fn manifest_save(state: &MediaState, slug: &str, mut m: TimelineManifest) -> Result<TimelineManifest, String> {
    let _g = state.manifest_lock.lock().unwrap();
    load_project(state, slug)?;
    let root = project_root(state, slug)?;
    let current = load_manifest(&root, slug);
    if m.revision != current.revision {
        return Err(format!("STALE_REVISION: the timeline changed (now revision {}); reload it", current.revision));
    }
    validate_manifest(&m, slug, &list_assets(state, slug)?)?;
    m.revision = current.revision + 1;
    m.updated_at = now_iso();
    write_atomic(&manifest_path(&root), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())?;
    if !m.clips.is_empty() {
        set_status(state, slug, "editing");
    }
    Ok(m)
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

pub(crate) fn build_plan(state: &MediaState, slug: &str, proposed_by: &str) -> Result<RenderPlan, String> {
    if !["director", "nic"].contains(&proposed_by) {
        return Err("proposedBy must be director or nic".into());
    }
    load_project(state, slug)?;
    let root = project_root(state, slug)?;
    let m = load_manifest(&root, slug);
    if m.clips.is_empty() {
        return Err("the timeline has no clips yet".into());
    }
    let assets = list_assets(state, slug)?;
    validate_manifest(&m, slug, &assets)?;
    let name_of = |id: &str| assets.iter().find(|a| a.id == id).map(|a| a.name.clone()).unwrap_or_default();
    let (w, h) = dims_for(&m.output.aspect);
    let total: f64 = m.clips.iter().map(|c| c.out_sec - c.in_sec).sum();
    let cap = m.output.max_size_mb.map(|x| format!(" · ≤ {x} MB")).unwrap_or_default();
    let plan = RenderPlan {
        plan_id: short_id("p"),
        project: slug.into(),
        manifest_revision: m.revision,
        sources: m.clips.iter().map(|c| PlanSource { asset_id: c.asset_id.clone(), name: name_of(&c.asset_id), in_sec: c.in_sec, out_sec: c.out_sec }).collect(),
        audio: m.audio.iter().map(|l| PlanAudio { asset_id: l.asset_id.clone(), name: name_of(&l.asset_id), start_sec: l.start_sec, volume: l.volume }).collect(),
        output_name: slugify(&m.output.name),
        output_spec: format!("{w}×{h} · H.264/AAC · {} LUFS · {:.1} s{cap}", m.output.loudness_lufs, total),
        render_mode: "cpu_only".into(),
        proposed_by: proposed_by.into(),
    };
    let j = serde_json::to_string(&plan).map_err(|e| e.to_string())?;
    state.with(|c| c.execute("INSERT INTO plan (id, project, json) VALUES (?1, ?2, ?3)", params![plan.plan_id, slug, j]).map(|_| ()).map_err(sql_err))?;
    Ok(plan)
}

fn load_plan(state: &MediaState, plan_id: &str) -> Result<RenderPlan, String> {
    state
        .with(|c| c.query_row("SELECT json FROM plan WHERE id = ?1", [plan_id], |r| r.get::<_, String>(0)).optional().map_err(sql_err))?
        .ok_or_else(|| format!("no render plan {plan_id:?}"))
        .and_then(|j| serde_json::from_str(&j).map_err(|e| e.to_string()))
}

/// The media-forge `render_timeline` spec for an approved plan (paths resolved from the
/// project's own assets; nothing from the model).
pub(crate) fn render_spec(m: &TimelineManifest, assets: &[MediaAsset]) -> Result<Value, String> {
    let by_id: HashMap<&str, &MediaAsset> = assets.iter().map(|a| (a.id.as_str(), a)).collect();
    let (w, h) = dims_for(&m.output.aspect);
    let clips: Result<Vec<Value>, String> = m
        .clips
        .iter()
        .map(|c| {
            let a = by_id.get(c.asset_id.as_str()).ok_or("clip asset missing")?;
            Ok(json!({ "path": a.path, "kind": a.kind, "in": c.in_sec, "out": c.out_sec, "fade_ms": c.fade_ms }))
        })
        .collect();
    let audio: Result<Vec<Value>, String> = m
        .audio
        .iter()
        .map(|l| {
            let a = by_id.get(l.asset_id.as_str()).ok_or("audio asset missing")?;
            Ok(json!({ "path": a.path, "start": l.start_sec, "in": l.in_sec, "out": l.out_sec, "volume": l.volume }))
        })
        .collect();
    Ok(json!({
        "version": 1, "project": m.project, "width": w, "height": h, "fps": 30,
        "clips": clips?, "audio": audio?, "clip_audio_volume": m.clip_audio_volume,
        "loudness_lufs": m.output.loudness_lufs, "max_size_mb": m.output.max_size_mb,
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

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_projects(app: tauri::AppHandle) -> Result<Vec<MediaProject>, String> {
    blocking(move || {
        let st = app.state::<MediaState>();
        st.with(|c| {
            let mut s = c.prepare("SELECT json FROM project ORDER BY updated_at DESC").map_err(sql_err)?;
            let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?;
            Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
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

#[tauri::command]
pub async fn media_render_execute(app: tauri::AppHandle, slug: String, plan_id: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("PERMISSION_REQUIRED:media-render — approve the Render Plan first".into());
    }
    let app2 = app.clone();
    let (plan, spec_path, out_path, manifest) = {
        let (slug, plan_id) = (slug.clone(), plan_id.clone());
        blocking(move || {
            let st = app2.state::<MediaState>();
            let plan = load_plan(&st, &plan_id)?;
            if plan.project != slug {
                return Err("that plan belongs to another project".into());
            }
            let root = project_root(&st, &slug)?;
            let m = load_manifest(&root, &slug);
            if m.revision != plan.manifest_revision {
                return Err("STALE_PLAN: the timeline changed after this plan was made; make a new plan".into());
            }
            let assets = list_assets(&st, &slug)?;
            validate_manifest(&m, &slug, &assets)?;
            let spec = render_spec(&m, &assets)?;
            let spec_path = root.join("working").join(format!("render_{}.json", plan.plan_id));
            write_atomic(&spec_path, serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?.as_bytes())?;
            let out = next_render_path(&root, &plan.output_name);
            Ok((plan, spec_path, out, m))
        })
        .await?
    };
    let cfg = app.state::<OsState>().snapshot();
    if !cfg.mcps.iter().any(|m| m.id == "media-forge" && m.enabled) {
        return Err("Media Forge is off: turn it on in Settings → MCP Registry".into());
    }
    let args = json!({ "spec_path": spec_path.to_string_lossy(), "output": out_path.to_string_lossy(), "wait_s": 0 });
    let res = {
        let (d, o, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
        super::mcp::call_tool(&d, &o, &b, "media-forge.render_timeline", &args, true, "director").await?
    };
    let job = tool_json(&res);
    let job_id = job["id"].as_str().ok_or_else(|| format!("media-forge did not start a job: {}", res.chars().take(300).collect::<String>()))?.to_string();
    app.state::<MediaState>().jobs.lock().unwrap().insert(job_id.clone(), slug.clone());
    {
        let st = app.state::<MediaState>();
        set_status(&st, &slug, "rendering");
    }
    render_event(&app, &slug, &job_id, "queued", 0.0, None, "queued", json!({}));
    let expect: f64 = manifest.clips.iter().map(|c| c.out_sec - c.in_sec).sum();
    let (w, h) = dims_for(&manifest.output.aspect);
    let cap = manifest.output.max_size_mb;
    let lufs_target = manifest.output.loudness_lufs;
    tauri::async_runtime::spawn(watch_render(app.clone(), slug, job_id.clone(), plan, out_path, expect, w, h, cap, lufs_target));
    Ok(json!({ "jobId": job_id }))
}

#[allow(clippy::too_many_arguments)]
async fn watch_render(app: tauri::AppHandle, slug: String, job_id: String, plan: RenderPlan, out: PathBuf, expect: f64, w: u32, h: u32, cap: Option<f64>, _lufs: i32) {
    let mut failures = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let res = {
            let (d, o, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
            super::mcp::call_tool(&d, &o, &b, "media-forge.job_status", &json!({ "job_id": job_id, "wait_s": 2 }), true, "director").await
        };
        let v = match res {
            Ok(t) => tool_json(&t),
            Err(e) => {
                failures += 1;
                if failures >= 10 {
                    finish_failed(&app, &slug, &job_id, &format!("lost track of the render: {e}"));
                    return;
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
            "queued" | "running" => render_event(&app, &slug, &job_id, &status, pct, eta, &stage, json!({})),
            "done" => {
                let lufs = v["result"]["loudness_measured"].as_f64();
                let app2 = app.clone();
                let (slug2, plan2, out2) = (slug.clone(), plan.clone(), out.clone());
                let verdict = blocking(move || {
                    let cfg = app2.state::<OsState>().snapshot();
                    let ffprobe = media_bin(&cfg, "ffprobe").ok_or("ffprobe not found")?;
                    if !out2.is_file() {
                        return Err(format!("the render reported done but {} is not on disk", out2.display()));
                    }
                    let size = std::fs::metadata(&out2).map(|m| m.len()).unwrap_or(0);
                    let pr = probe(&ffprobe, &out2)?;
                    let verify = verify_render(&pr, size, expect, w, h, cap);
                    if !verify.ok {
                        return Err(format!("render failed verification: {}", verify.checks.join("; ")));
                    }
                    let r = VerifiedRender {
                        id: short_id("r"),
                        project: slug2.clone(),
                        plan_id: plan2.plan_id.clone(),
                        path: dunce_canon(&out2).unwrap_or(out2.clone()).to_string_lossy().to_string(),
                        duration_sec: pr.duration.unwrap_or(0.0),
                        width: pr.width.unwrap_or(0),
                        height: pr.height.unwrap_or(0),
                        size_bytes: size,
                        loudness_lufs: lufs,
                        verify,
                        created_at: now_iso(),
                    };
                    let st = app2.state::<MediaState>();
                    let j = serde_json::to_string(&r).map_err(|e| e.to_string())?;
                    st.with(|c| c.execute("INSERT INTO render (id, project, json, created_at) VALUES (?1, ?2, ?3, ?4)", params![r.id, r.project, j, r.created_at]).map(|_| ()).map_err(sql_err))?;
                    set_status(&st, &slug2, "ready");
                    Ok(r)
                })
                .await;
                app.state::<MediaState>().jobs.lock().unwrap().remove(&job_id);
                match verdict {
                    Ok(r) => render_event(&app, &slug, &job_id, "done", 100.0, Some(0.0), "verified", json!({ "render": r })),
                    Err(e) => finish_failed(&app, &slug, &job_id, &e),
                }
                return;
            }
            "cancelled" => {
                app.state::<MediaState>().jobs.lock().unwrap().remove(&job_id);
                set_status(&app.state::<MediaState>(), &slug, "editing");
                render_event(&app, &slug, &job_id, "cancelled", pct, None, "cancelled", json!({}));
                return;
            }
            _ => {
                let err = v["error"].as_str().unwrap_or("the render failed").to_string();
                finish_failed(&app, &slug, &job_id, &err);
                return;
            }
        }
    }
}

fn finish_failed(app: &tauri::AppHandle, slug: &str, job_id: &str, err: &str) {
    app.state::<MediaState>().jobs.lock().unwrap().remove(job_id);
    set_status(&app.state::<MediaState>(), slug, "editing");
    let err: String = err.chars().take(800).collect();
    render_event(app, slug, job_id, "failed", 0.0, None, "failed", json!({ "error": err }));
}

#[tauri::command]
pub async fn media_render_cancel(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
    if !app.state::<MediaState>().jobs.lock().unwrap().contains_key(&job_id) {
        return Err("no live render with that id".into());
    }
    let (d, o, b) = (app.state::<super::dispatch::DispatchState>(), app.state::<OsState>(), app.state::<super::bridge::BridgeState>());
    super::mcp::call_tool(&d, &o, &b, "media-forge.job_cancel", &json!({ "job_id": job_id }), true, "director").await.map(|_| ())
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
        MediaAsset { id: id.into(), project: "p".into(), kind: kind.into(), role: "clip".into(), name: format!("{id}.x"), path: format!("C:/x/{id}"), read_only: true, size_bytes: 1, duration_sec: dur, width: Some(1920), height: Some(1080), thumb_path: None, added_at: now_iso() }
    }

    fn clip(id: &str, asset: &str, i: f64, o: f64) -> TimelineClip {
        TimelineClip { id: id.into(), asset_id: asset.into(), in_sec: i, out_sec: o, fade_ms: 0 }
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
        m.audio = vec![AudioLayer { id: "l1".into(), asset_id: "a".into(), start_sec: 1.0, in_sec: 0.0, out_sec: 5.0, volume: 0.8 }];
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
        m.shot_list = vec![ShotSlot { id: "s1".into(), label: "Hook".into(), instructions: "15 s".into(), kind: "video".into(), target_sec: Some(15.0), asset_id: None, status: "needed".into() }];
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
        m.clips = vec![clip("c1", "v", 1.0, 9.0), clip("c2", "i", 0.0, 3.0)];
        let spec = render_spec(&m, &assets).unwrap();
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
}
