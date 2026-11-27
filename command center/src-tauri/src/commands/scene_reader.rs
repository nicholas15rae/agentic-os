//! Director Suite Part 4: auditions (docs/proposals/director-suite-v2-plan.md §4).
//!
//! Scene Reader is a separate app owned by Nic. This module never writes into it, never starts it
//! and never builds it:
//! - `scene_reader_status` probes its Studio server's `/health` (127.0.0.1:5123, ≤ 1.5 s); the page
//!   hides the Scene Reader entry when nothing answers.
//! - `scene_reader_list` reads its voiceover projects and takes. The SQLite library (WAL mode) is
//!   copied with its `-wal` to a temp folder and the copy is read, so nothing is opened, locked or
//!   created under Scene Reader's own folder.
//! - `scene_reader_import` (Nic's Import click only) makes a new Director project (source
//!   `scene_reader`, status brief) and copies the chosen takes (default: the take marked best) into
//!   its `raw/` with the byte-checked copy, then ingests them as voiceover assets. The source files
//!   are never moved, opened for writing or deleted, and a take file has to sit inside Scene
//!   Reader's `media/` folder (no separators, no `..`, no link out of it).
//!
//! Sides (the audition script) arrive as a dropped PDF or text file: `media_sides_save` keeps a
//! read-only copy in `raw/sides/`. A slate (`media_slate_card`) is a 16:9 still with name, role and
//! contact, drawn by ffmpeg and ingested as a `slate` asset; placing it on the timeline stays Nic's.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

use super::media::{self, MediaAsset, MediaProject, MediaState, Source};
use super::os_core::{self, OsState};

/// Scene Reader's Studio server (studio-server/server.py, default port).
pub(crate) const HEALTH_URL: &str = "http://127.0.0.1:5123/health";
pub(crate) const STUDIO_URL: &str = "http://127.0.0.1:5123";
const PROBE_MS: u64 = 1_500;
/// Scene Reader's Tauri identifier (its app data folder under %APPDATA%).
const APP_ID: &str = "com.scenereader.dev";
const DB_FILE: &str = "scene-reader.db";
/// Scene Reader's allowed take extensions (vo.rs).
const TAKE_EXT: [&str; 9] = ["webm", "ogg", "wav", "m4a", "mp4", "mp3", "aac", "flac", "mov"];
const MAX_IMPORT_TAKES: usize = 20;
const SIDES_EXT: [&str; 5] = ["pdf", "txt", "md", "rtf", "fdx"];
const MAX_SIDES_BYTES: usize = 20 * 1024 * 1024;
const SLATE_FIELD_MAX: usize = 80;

// ── Wire types (camelCase, contract.ts) ────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneReaderStatus {
    pub up: bool,
    pub url: String,
    /// Scene Reader's app data folder when its library is there, else null.
    pub projects_root: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SrTake {
    pub id: String,
    pub name: String,
    pub file: String,
    pub dur_sec: f64,
    pub best: bool,
    pub created_at: i64,
    /// The file is in Scene Reader's media folder and can be imported.
    pub available: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SrProject {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub takes: Vec<SrTake>,
    /// The script (copy) length, so the page can say there is one; the text itself goes to the
    /// new project's source brief on import.
    pub copy_chars: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneReaderImport {
    pub project: MediaProject,
    pub assets: Vec<MediaAsset>,
    /// Takes that couldn't come in, with why.
    pub skipped: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidesFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

/// The parts of Scene Reader's `VoProject` / `Take` (vo.rs, camelCase JSON) this reads.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct VoRow {
    id: String,
    title: String,
    copy: String,
    takes: Vec<TakeRow>,
    updated_at: i64,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct TakeRow {
    id: String,
    name: String,
    file: String,
    dur: f64,
    best: bool,
    created_at: i64,
}

// ── Locating Scene Reader ──────────────────────────────────────────────────────

/// `%APPDATA%\com.scenereader.dev` when its library file is there.
pub(crate) fn data_root() -> Option<PathBuf> {
    let r = PathBuf::from(std::env::var_os("APPDATA")?).join(APP_ID);
    r.join(DB_FILE).is_file().then_some(r)
}

/// A take's file inside `<root>/media/`, or why not. Refuses separators, `..`, other extensions,
/// a missing file and anything that resolves outside the media folder (a link out of it).
pub(crate) fn resolve_take(root: &Path, file: &str) -> Result<PathBuf, String> {
    let f = file.trim();
    let plain = !f.is_empty() && f.len() <= 200 && !f.contains(['/', '\\', ':']) && f != "." && f != ".." && !f.starts_with('.');
    if !plain {
        return Err(format!("{file:?} isn't a plain take file name"));
    }
    if !TAKE_EXT.contains(&media::ext_of(f).as_str()) {
        return Err(format!("{f}: not a take Scene Reader records"));
    }
    let dir = root.join("media");
    let p = dir.join(f);
    if !p.is_file() {
        return Err(format!("{f}: not in Scene Reader's media folder"));
    }
    if !media::inside(&p, &dir) {
        return Err(format!("{f}: outside Scene Reader's media folder"));
    }
    Ok(p)
}

/// Removes the temp snapshot folder however the read ends.
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One snapshot of Scene Reader's library: its `-wal` is copied first and the db second (a
/// checkpoint in between then leaves the db copy holding those pages), the copy is opened and read,
/// never the original. A read that fails (a copy caught mid-checkpoint) is retried once.
fn read_rows(root: &Path) -> Result<Vec<VoRow>, String> {
    if !root.join(DB_FILE).is_file() {
        return Err("Scene Reader's library isn't on this PC".into());
    }
    read_rows_once(root).or_else(|_| read_rows_once(root))
}

fn read_rows_once(root: &Path) -> Result<Vec<VoRow>, String> {
    let tmp = TempDir(std::env::temp_dir().join(format!("cc-scene-reader-{}", media::short_id("s"))));
    std::fs::create_dir_all(&tmp.0).map_err(|e| format!("temp folder: {e}"))?;
    let copy = tmp.0.join(DB_FILE);
    // The WAL holds the recent writes; the -shm index is rebuilt from it in the temp folder.
    let wal = root.join(format!("{DB_FILE}-wal"));
    if wal.is_file() {
        std::fs::copy(&wal, tmp.0.join(format!("{DB_FILE}-wal"))).map_err(|e| format!("read Scene Reader's library: {e}"))?;
    }
    std::fs::copy(root.join(DB_FILE), &copy).map_err(|e| format!("read Scene Reader's library: {e}"))?;
    let c = rusqlite::Connection::open(&copy).map_err(|e| format!("open the library copy: {e}"))?;
    let has = c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vo_projects'", [], |_| Ok(())).optional().map_err(media::sql_err)?;
    if has.is_none() {
        return Ok(vec![]);
    }
    let mut st = c.prepare("SELECT data_json FROM vo_projects").map_err(media::sql_err)?;
    let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(media::sql_err)?.collect::<Result<Vec<_>, _>>().map_err(media::sql_err)?;
    Ok(rows.iter().filter_map(|j| serde_json::from_str::<VoRow>(j).ok()).filter(|v| !v.id.is_empty()).collect())
}

/// Scene Reader's voiceover projects with their script text, from one snapshot. Newest first.
fn read_library(root: &Path) -> Result<Vec<(SrProject, String)>, String> {
    let mut out: Vec<(SrProject, String)> = read_rows(root)?
        .into_iter()
        .map(|mut v| {
            let full = std::mem::take(&mut v.copy);
            let mut p = to_project(root, v);
            p.copy_chars = full.chars().count();
            (p, full.chars().take(8000).collect())
        })
        .collect();
    out.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));
    Ok(out)
}

/// Scene Reader's voiceover projects, read from a temp copy of its library (db + WAL). Newest first.
pub(crate) fn read_projects(root: &Path) -> Result<Vec<SrProject>, String> {
    Ok(read_library(root)?.into_iter().map(|(p, _)| p).collect())
}

fn to_project(root: &Path, v: VoRow) -> SrProject {
    let takes = v
        .takes
        .iter()
        .filter(|t| !t.id.is_empty())
        .map(|t| SrTake { id: t.id.clone(), name: take_label(t), file: t.file.clone(), dur_sec: if t.dur.is_finite() { t.dur.max(0.0) } else { 0.0 }, best: t.best, created_at: t.created_at, available: resolve_take(root, &t.file).is_ok() })
        .collect();
    SrProject { id: v.id, title: if v.title.trim().is_empty() { "Untitled".into() } else { v.title.trim().chars().take(120).collect() }, updated_at: v.updated_at, takes, copy_chars: v.copy.chars().count() }
}

fn take_label(t: &TakeRow) -> String {
    let n = t.name.trim();
    if n.is_empty() {
        t.id.clone()
    } else {
        n.chars().take(80).collect()
    }
}

/// The takes an import brings in: the picked ids (each must be in the project), else the best one.
pub(crate) fn pick_takes(p: &SrProject, ids: Option<&[String]>) -> Result<Vec<SrTake>, String> {
    let picked: Vec<SrTake> = match ids.filter(|i| !i.is_empty()) {
        Some(ids) => {
            if ids.len() > MAX_IMPORT_TAKES {
                return Err(format!("pick up to {MAX_IMPORT_TAKES} takes"));
            }
            let mut v = vec![];
            for id in ids {
                let t = p.takes.iter().find(|t| &t.id == id).ok_or_else(|| format!("no take {id:?} in {}", p.title))?;
                if !v.iter().any(|x: &SrTake| x.id == t.id) {
                    v.push(t.clone());
                }
            }
            v
        }
        None => p.takes.iter().filter(|t| t.best).cloned().collect(),
    };
    if picked.is_empty() {
        return Err(format!("No take in {} is marked best. Pick the takes to bring in.", p.title));
    }
    Ok(picked)
}

/// Byte-checked copy of one take into `raw/` under the take's own name. The source is only read.
pub(crate) fn stage_take(src: &Path, raw: &Path, take: &SrTake) -> Result<(PathBuf, String), String> {
    let ext = media::ext_of(&src.to_string_lossy());
    let display = media::safe_file_name(&format!("{}.{ext}", take.name));
    std::fs::create_dir_all(raw).map_err(|e| e.to_string())?;
    let dst = media::unique_path(raw, &display);
    media::copy_byte_checked(src, &dst)?;
    Ok((dst, display))
}

pub(crate) fn import(state: &MediaState, cfg: &os_core::OsConfig, root: &Path, project_id: &str, take_ids: Option<&[String]>) -> Result<SceneReaderImport, String> {
    // One snapshot gives both the takes and the script text.
    let library = read_library(root)?;
    let (p, copy) = library.iter().find(|(p, _)| p.id == project_id).ok_or_else(|| format!("no Scene Reader project {project_id:?}"))?;
    let takes = pick_takes(p, take_ids)?;
    // Every path is checked before anything is made.
    let srcs = takes.iter().map(|t| resolve_take(root, &t.file)).collect::<Result<Vec<_>, _>>()?;
    let title: String = format!("{} audition", p.title).chars().take(120).collect();
    let brief = Some(copy.clone()).filter(|c| !c.trim().is_empty());
    let project = media::create_project(state, &title, Some(Source { from: "scene_reader".into(), ref_id: Some(p.id.clone()), brief }))?;
    // The casting spec: an audition renders through the Self-tape output.
    self_tape_output(state, &project.slug)?;
    let raw = media::project_root(state, &project.slug)?.join("raw");
    let (mut assets, mut skipped) = (vec![], vec![]);
    for (t, src) in takes.iter().zip(srcs) {
        match stage_take(&src, &raw, t) {
            Ok((dst, display)) => match media::finalize_asset(state, cfg, &project.slug, &dst, &display, "voiceover", true) {
                Ok(a) => assets.push(a),
                Err(e) => {
                    media::remove_staged(&dst);
                    skipped.push(format!("{}: {e}", t.name));
                }
            },
            Err(e) => skipped.push(format!("{}: {e}", t.name)),
        }
    }
    let project = media::load_project(state, &project.slug).unwrap_or(project);
    Ok(SceneReaderImport { project, assets, skipped })
}

/// The self-tape preset (manifest.ts PLATFORM_PRESETS.self_tape: 16:9, −18 LUFS, ≤ 100 MB, no
/// length cap).
pub(crate) const SELF_TAPE: (&str, i32, f64) = ("16:9", -18, 100.0);

/// Makes the self-tape preset the manifest's one output, saved through the normal manifest path.
/// Captions stay off (a self-tape never gets them).
pub(crate) fn self_tape_output(state: &MediaState, slug: &str) -> Result<(), String> {
    let root = media::project_root(state, slug)?;
    let mut m = media::load_manifest_strict(&root, slug)?;
    let (aspect, lufs, cap) = SELF_TAPE;
    m.output.aspect = aspect.into();
    m.output.loudness_lufs = lufs;
    m.output.max_size_mb = Some(cap);
    m.outputs = vec![media::PlatformPreset { platform: "self_tape".into(), aspect: aspect.into(), loudness_lufs: lufs, max_size_mb: Some(cap), max_sec: None }];
    m.captions.enabled = false;
    media::manifest_save(state, slug, m).map(|_| ())
}

// ── Sides ──────────────────────────────────────────────────────────────────────

pub(crate) fn sides_dir(state: &MediaState, slug: &str) -> Result<PathBuf, String> {
    media::load_project(state, slug)?;
    Ok(media::project_root(state, slug)?.join("raw").join("sides"))
}

/// A dropped sides file → a new read-only file in `raw/sides/` (never overwrites one).
pub(crate) fn sides_save(state: &MediaState, slug: &str, name: &str, bytes: &[u8]) -> Result<SidesFile, String> {
    let dir = sides_dir(state, slug)?;
    let name = media::safe_file_name(name);
    if !SIDES_EXT.contains(&media::ext_of(&name).as_str()) {
        return Err(format!("{name}: sides come in as a PDF or a text file"));
    }
    if bytes.is_empty() || bytes.len() > MAX_SIDES_BYTES {
        return Err(format!("{name}: sides files are 1 byte to 20 MB"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = media::unique_path(&dir, &name);
    let res = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&dst)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = res {
        media::remove_staged(&dst);
        return Err(format!("save {name}: {e}"));
    }
    media::set_read_only(&dst);
    let shown = dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
    Ok(SidesFile { name: shown, path: dst.to_string_lossy().to_string(), size_bytes: bytes.len() as u64 })
}

pub(crate) fn sides_list(state: &MediaState, slug: &str) -> Result<Vec<SidesFile>, String> {
    let dir = sides_dir(state, slug)?;
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut out: Vec<SidesFile> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| SidesFile { name: e.file_name().to_string_lossy().to_string(), path: e.path().to_string_lossy().to_string(), size_bytes: e.metadata().map(|m| m.len()).unwrap_or(0) })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// `encodeURIComponent` undone (the page percent-encodes the name: headers are ASCII). Pure.
pub(crate) fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// ── Slate ──────────────────────────────────────────────────────────────────────

/// One slate line: a single trimmed line of ≤ 80 chars. Pure.
pub(crate) fn slate_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(SLATE_FIELD_MAX).collect()
}

/// A path as an ffmpeg filter option value (forward slashes, `:` escaped, quoted). Refuses a quote. Pure.
pub(crate) fn ff_path(p: &Path) -> Result<String, String> {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.contains('\'') {
        return Err(format!("{s}: a path with a quote can't go to ffmpeg's drawtext"));
    }
    Ok(format!("'{}'", s.replace(':', "\\:")))
}

/// The drawtext chain for a 1920×1080 slate: one line per text file (name big, then role, then
/// contact). Text comes from files with expansion off, so nothing in it is read as filter syntax. Pure.
pub(crate) fn slate_filter(font: Option<&Path>, lines: &[(PathBuf, u32, &str)]) -> Result<String, String> {
    let font = font.map(ff_path).transpose()?.map(|f| format!("fontfile={f}:")).unwrap_or_default();
    let mut parts = vec![];
    for (file, size, y) in lines {
        parts.push(format!("drawtext={font}textfile={}:expansion=none:fontcolor=white:fontsize={size}:x=(w-text_w)/2:y={y}", ff_path(file)?));
    }
    Ok(parts.join(","))
}

fn slate_font() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into())).join("Fonts");
    ["segoeui.ttf", "arial.ttf"].iter().map(|f| dir.join(f)).find(|p| p.is_file())
}

pub(crate) fn slate_card(state: &MediaState, cfg: &os_core::OsConfig, slug: &str, name: &str, role: &str, contact: &str) -> Result<MediaAsset, String> {
    media::load_project(state, slug)?;
    let (name, role, contact) = (slate_line(name), slate_line(role), slate_line(contact));
    if name.is_empty() {
        return Err("a slate needs a name".into());
    }
    let ffmpeg = media::media_bin(cfg, "ffmpeg").ok_or("ffmpeg not found (install FFmpeg or Shotcut)")?;
    let root = media::project_root(state, slug)?;
    let work = root.join("working").join("slate");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let id = media::short_id("sl");
    let mut lines: Vec<(PathBuf, u32, &str)> = vec![];
    for (i, (text, size, y)) in [(&name, 96u32, "h*0.36"), (&role, 56, "h*0.52"), (&contact, 40, "h*0.64")].into_iter().enumerate() {
        if text.is_empty() {
            continue;
        }
        let f = work.join(format!("{id}-{i}.txt"));
        std::fs::write(&f, text.as_bytes()).map_err(|e| format!("write {}: {e}", f.display()))?;
        lines.push((f, size, y));
    }
    let vf = slate_filter(slate_font().as_deref(), &lines)?;
    let raw = root.join("raw");
    std::fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
    let display = media::safe_file_name(&format!("slate {name}.png"));
    let dst = media::unique_path(&raw, &display);
    let out = dst.to_string_lossy().to_string();
    let args = ["-n", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x101318:s=1920x1080", "-vf", &vf, "-frames:v", "1", &out];
    let run = media::run_hidden(&ffmpeg, &args, Duration::from_secs(30));
    for (f, _, _) in &lines {
        let _ = std::fs::remove_file(f);
    }
    let o = run?;
    if !o.status.success() || !dst.is_file() {
        media::remove_staged(&dst);
        let why = String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("").chars().take(160).collect::<String>();
        return Err(format!("ffmpeg couldn't draw the slate{}", if why.is_empty() { String::new() } else { format!(": {why}") }));
    }
    media::finalize_asset(state, cfg, slug, &dst, &display, "slate", true).inspect_err(|_| media::remove_staged(&dst))
}

// ── Commands ───────────────────────────────────────────────────────────────────

/// Is Scene Reader's Studio answering? (≤ 1.5 s; the page hides the entry when not.)
#[tauri::command]
pub async fn scene_reader_status() -> Result<SceneReaderStatus, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_millis(PROBE_MS)).connect_timeout(Duration::from_millis(PROBE_MS)).build().map_err(|e| e.to_string())?;
    let up = matches!(client.get(HEALTH_URL).send().await, Ok(r) if r.status().is_success());
    Ok(SceneReaderStatus { up, url: STUDIO_URL.into(), projects_root: data_root().map(|r| r.to_string_lossy().to_string()) })
}

/// Scene Reader's projects and takes (read from a temp copy of its library; Nic's click only).
#[tauri::command]
pub async fn scene_reader_list() -> Result<Vec<SrProject>, String> {
    media::blocking(|| read_projects(&data_root().ok_or("Scene Reader's library isn't on this PC")?)).await
}

/// Nic's Import click: a new audition project with copies of the chosen takes (default: best).
#[tauri::command]
pub async fn scene_reader_import(app: tauri::AppHandle, project: String, take_ids: Option<Vec<String>>) -> Result<SceneReaderImport, String> {
    media::blocking(move || {
        let root = data_root().ok_or("Scene Reader's library isn't on this PC")?;
        let cfg = app.state::<OsState>().snapshot();
        import(&app.state::<MediaState>(), &cfg, &root, &project, take_ids.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn media_sides_list(app: tauri::AppHandle, slug: String) -> Result<Vec<SidesFile>, String> {
    media::blocking(move || sides_list(&app.state::<MediaState>(), &slug)).await
}

/// Raw body = the file; headers `x-slug`, `x-name`.
#[tauri::command]
pub async fn media_sides_save(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<SidesFile, String> {
    let h = |n: &str| request.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string).ok_or_else(|| format!("missing header {n}"));
    let (slug, name) = (h("x-slug")?, pct_decode(&h("x-name")?));
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("send the bytes as the raw request body".into()),
    };
    media::blocking(move || sides_save(&app.state::<MediaState>(), &slug, &name, &bytes)).await
}

/// A slate still (name, role, contact) as a `slate` asset. Nothing is placed on the timeline.
#[tauri::command]
pub async fn media_slate_card(app: tauri::AppHandle, slug: String, name: String, role: Option<String>, contact: Option<String>) -> Result<MediaAsset, String> {
    media::blocking(move || {
        let cfg = app.state::<OsState>().snapshot();
        slate_card(&app.state::<MediaState>(), &cfg, &slug, &name, role.as_deref().unwrap_or(""), contact.as_deref().unwrap_or(""))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("scene-reader-test-{tag}-{}", media::short_id("t")));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A fake Scene Reader data folder: a WAL-mode library with one project and its take files.
    fn fake_scene_reader() -> PathBuf {
        let root = tmp("sr");
        std::fs::create_dir_all(root.join("media")).unwrap();
        std::fs::write(root.join("media").join("tk-1.webm"), b"take one bytes").unwrap();
        std::fs::write(root.join("media").join("tk-2.wav"), b"take two bytes").unwrap();
        let c = rusqlite::Connection::open(root.join(DB_FILE)).unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c.execute_batch("CREATE TABLE vo_projects (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)").unwrap();
        let p = serde_json::json!({
            "id": "vo-1", "title": "Coffee spot", "copy": "Wake up *slowly*.", "updatedAt": 20,
            "takes": [
                { "id": "t1", "name": "Take 1", "file": "tk-1.webm", "dur": 12.5, "best": false, "createdAt": 1 },
                { "id": "t2", "name": "Take 2", "file": "tk-2.wav", "dur": 11.0, "best": true, "createdAt": 2 },
                { "id": "t3", "name": "Escape", "file": "../secret.wav", "dur": 1.0, "best": false, "createdAt": 3 }
            ]
        });
        c.execute("INSERT INTO vo_projects (id, data_json, created_at, updated_at) VALUES ('vo-1', ?1, 1, 20)", [p.to_string()]).unwrap();
        let old = serde_json::json!({ "id": "vo-0", "title": "", "takes": [], "updatedAt": 5 });
        c.execute("INSERT INTO vo_projects (id, data_json, created_at, updated_at) VALUES ('vo-0', ?1, 1, 5)", [old.to_string()]).unwrap();
        // Keep the connection open while the test reads: the writes sit in the WAL, as in the live app.
        std::mem::forget(c);
        root
    }

    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut v: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.path().is_file()).map(|e| (e.file_name().to_string_lossy().to_string(), std::fs::read(e.path()).unwrap())).collect();
        v.sort();
        v
    }

    #[test]
    fn take_paths_stay_inside_the_media_folder() {
        let root = fake_scene_reader();
        assert!(resolve_take(&root, "tk-1.webm").is_ok());
        for bad in ["../secret.wav", "..\\x.wav", "media/tk-1.webm", "C:\\x.wav", "C:x.wav", "..", ".hidden.wav", "", "tk-1.exe", "missing.wav"] {
            assert!(resolve_take(&root, bad).is_err(), "{bad:?} must be refused");
        }
        // A file beside media/ (not in it) is refused too.
        std::fs::write(root.join("outside.wav"), b"x").unwrap();
        assert!(resolve_take(&root, "outside.wav").is_err());
    }

    #[test]
    fn listing_reads_a_copy_and_leaves_scene_reader_untouched() {
        let root = fake_scene_reader();
        let before = snapshot(&root);
        let media_before = snapshot(&root.join("media"));
        let ps = read_projects(&root).unwrap();
        assert_eq!(ps.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["vo-1", "vo-0"], "newest first; rows in the WAL are read");
        assert_eq!(ps[1].title, "Untitled");
        let p = &ps[0];
        assert_eq!(p.copy_chars, "Wake up *slowly*.".chars().count());
        assert_eq!(p.takes.iter().map(|t| (t.id.as_str(), t.best, t.available)).collect::<Vec<_>>(), [("t1", false, true), ("t2", true, true), ("t3", false, false)]);
        assert_eq!(snapshot(&root), before, "no file under Scene Reader's folder changed or appeared");
        assert_eq!(snapshot(&root.join("media")), media_before);
        assert!(read_projects(&tmp("none")).is_err(), "no library: an error, not an empty list");
    }

    #[test]
    fn import_picks_best_by_default_and_refuses_unknown_takes() {
        let root = fake_scene_reader();
        let p = read_projects(&root).unwrap().remove(0);
        assert_eq!(pick_takes(&p, None).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t2"]);
        let ids = vec!["t1".to_string(), "t1".to_string(), "t2".to_string()];
        assert_eq!(pick_takes(&p, Some(&ids)).unwrap().len(), 2, "duplicates collapse");
        assert!(pick_takes(&p, Some(&["nope".to_string()])).is_err());
        let mut none_best = p.clone();
        none_best.takes.iter_mut().for_each(|t| t.best = false);
        assert!(pick_takes(&none_best, None).unwrap_err().contains("marked best"));
        assert!(pick_takes(&none_best, Some(&[])).is_err(), "an empty pick falls back to best, of which there is none");
    }

    #[test]
    fn a_take_is_copied_into_raw_and_the_source_is_kept() {
        let root = fake_scene_reader();
        let p = read_projects(&root).unwrap().remove(0);
        let t = p.takes.iter().find(|t| t.id == "t2").unwrap();
        let src = resolve_take(&root, &t.file).unwrap();
        let raw = tmp("raw");
        let (dst, display) = stage_take(&src, &raw, t).unwrap();
        assert_eq!(display, "Take 2.wav");
        assert!(dst.starts_with(&raw));
        assert_eq!(std::fs::read(&dst).unwrap(), b"take two bytes");
        assert_eq!(std::fs::read(&src).unwrap(), b"take two bytes", "the source is only read");
        let (dst2, _) = stage_take(&src, &raw, t).unwrap();
        assert_ne!(dst, dst2, "a second import never overwrites the first copy");
    }

    #[test]
    fn an_import_with_a_take_outside_the_media_folder_makes_no_project() {
        let root = fake_scene_reader();
        let st = MediaState::in_memory(&tmp("proj"));
        let cfg = os_core::OsConfig::default();
        let e = import(&st, &cfg, &root, "vo-1", Some(&["t3".to_string()])).unwrap_err();
        assert!(e.contains("plain take file name"), "{e}");
        assert!(import(&st, &cfg, &root, "vo-9", None).is_err());
        let n: i64 = st.with(|c| c.query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0)).map_err(media::sql_err)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn sides_are_kept_read_only_and_never_overwritten() {
        let st = MediaState::in_memory(&tmp("sides"));
        let p = media::create_project(&st, "Sides Test", None).unwrap();
        let a = sides_save(&st, &p.slug, "Scene 4 sides.pdf", b"%PDF-1.4").unwrap();
        let b = sides_save(&st, &p.slug, "Scene 4 sides.pdf", b"%PDF-1.5").unwrap();
        assert_ne!(a.path, b.path);
        assert!(std::fs::metadata(&a.path).unwrap().permissions().readonly());
        assert!(sides_save(&st, &p.slug, "run.exe", b"MZ").is_err());
        assert!(sides_save(&st, &p.slug, "empty.txt", b"").is_err());
        assert!(sides_save(&st, &p.slug, r"..\..\x.txt", b"hi").unwrap().path.contains("sides"), "the name is made plain");
        assert_eq!(sides_list(&st, &p.slug).unwrap().len(), 3);
        assert!(sides_save(&st, "ghost", "a.txt", b"x").is_err());
    }

    #[test]
    fn sides_names_are_percent_decoded() {
        assert_eq!(pct_decode("Sc%C3%A8ne%204.pdf"), "Scène 4.pdf");
        assert_eq!(pct_decode("plain.txt"), "plain.txt");
        assert_eq!(pct_decode("bad%zz%4"), "bad%zz%4");
    }

    #[test]
    fn slate_text_and_filter_are_safe() {
        assert_eq!(slate_line("  Nic \n  Rae  "), "Nic Rae");
        assert_eq!(slate_line(&"x".repeat(200)).chars().count(), SLATE_FIELD_MAX);
        assert_eq!(ff_path(Path::new(r"C:\Windows\Fonts\arial.ttf")).unwrap(), r"'C\:/Windows/Fonts/arial.ttf'");
        assert!(ff_path(Path::new(r"C:\it's\a.txt")).is_err());
        let f = slate_filter(Some(Path::new(r"C:\Windows\Fonts\arial.ttf")), &[(PathBuf::from(r"C:\p\a.txt"), 96, "h*0.36"), (PathBuf::from(r"C:\p\b.txt"), 56, "h*0.52")]).unwrap();
        assert_eq!(f.matches("drawtext=").count(), 2);
        assert!(f.contains("expansion=none") && f.contains(r"textfile='C\:/p/a.txt'") && f.contains("fontsize=56"));
        assert!(!slate_filter(None, &[(PathBuf::from("a.txt"), 40, "h*0.64")]).unwrap().contains("fontfile"));
    }

    #[test]
    fn an_audition_renders_through_the_self_tape_output() {
        assert!(media::PLATFORMS.contains(&"self_tape"));
        let st = MediaState::in_memory(&tmp("tape"));
        let p = media::create_project(&st, "Tape Test", None).unwrap();
        self_tape_output(&st, &p.slug).unwrap();
        let m = media::load_manifest_strict(&media::project_root(&st, &p.slug).unwrap(), &p.slug).unwrap();
        assert_eq!(m.outputs, vec![media::PlatformPreset { platform: "self_tape".into(), aspect: "16:9".into(), loudness_lufs: -18, max_size_mb: Some(100.0), max_sec: None }]);
        assert_eq!((m.output.aspect.as_str(), m.output.loudness_lufs, m.output.max_size_mb), ("16:9", -18, Some(100.0)));
        assert!(!m.captions.enabled);
    }

    #[test]
    fn an_import_makes_a_self_tape_project_from_one_snapshot() {
        let root = fake_scene_reader();
        let before = snapshot(&root);
        let media_before = snapshot(&root.join("media"));
        let st = MediaState::in_memory(&tmp("imp"));
        let cfg = os_core::OsConfig::default();
        let r = import(&st, &cfg, &root, "vo-1", None).unwrap();
        assert_eq!(r.project.source.brief.as_deref(), Some("Wake up *slowly*."), "the script comes from the same snapshot as the takes");
        assert_eq!(r.assets.len() + r.skipped.len(), 1, "the best take only");
        let m = media::load_manifest_strict(&media::project_root(&st, &r.project.slug).unwrap(), &r.project.slug).unwrap();
        assert_eq!(m.outputs.iter().map(|o| o.platform.as_str()).collect::<Vec<_>>(), ["self_tape"]);
        assert_eq!(snapshot(&root), before, "Scene Reader's folder is untouched");
        assert_eq!(snapshot(&root.join("media")), media_before);
    }
}
