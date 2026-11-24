//! Language Hub (live translator, tutor, phrase library) — self-contained.
//!
//! * Library: ONE SQLite file, `<repo>/data/language-hub/library.db`, shared with the gateway's
//!   `language_hub_api.py` (the phone's path to the same file). Nothing here touches the vault,
//!   memory tiers, Tony's threads or any other store, and nothing else reads this file.
//! * STT: English goes to the configured Whisper (Tony's `base.en`). Every other language, and
//!   auto-detect, goes to an on-demand multilingual `whisper-server` sidecar on 127.0.0.1:8179,
//!   started on first use and stopped by `lang_release` (the Hub unmounting) or after
//!   `SIDECAR_IDLE` with no request. The sidecar sits in a kill-on-close Job, so it never
//!   outlives the app. Same mic gate as `stt_transcribe`.
//! * TTS: the engine, model and voice the user picks in the Hub's Voice panel (any configured TTS
//!   provider: Kokoro by default, ElevenLabs, XTTS…), stored in this file's `settings` table so the
//!   phone shares it. Kokoro with no voice picked uses one per language; a language it has no voice
//!   for answers `UNSUPPORTED_LANG` and the webview falls back. ElevenLabs is refused while the
//!   kill switch is on (`KILL_SWITCH`), and the webview then falls back to a local voice.
//! * LLM: the `policy.primaryLocal` provider (LM Studio), JSON-only prompts built in TypeScript,
//!   with reasoning switched off per request (fast, and the JSON isn't starved by a think block).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::dispatch::{short, DispatchState, Kind, Provider};
use super::voice::{mic_enabled, synth_local, MIC_DISABLED};

pub const CATEGORIES: [&str; 3] = ["public_capture", "my_translation", "lesson_vocab"];
pub const MASTERY: [&str; 3] = ["new", "learning", "mastered"];
pub const LEVELS: [&str; 3] = ["beginner", "intermediate", "conversational"];
const MAX_TEXT: usize = 4000;
const MAX_NOTE: usize = 500;
const MAX_AUDIO: usize = 16 * 1024 * 1024;
const SIDECAR_PORT: u16 = 8179;
const SIDECAR_IDLE: Duration = Duration::from_secs(180);
/// Multilingual whisper.cpp models, best first. `.en` models can't detect or transcribe other languages.
const ML_MODELS: [&str; 8] = ["large-v3-turbo", "large-v3-turbo-q5_0", "large-v3-turbo-q8_0", "medium", "small", "small-q5_1", "base", "tiny"];

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS phrases(
  id TEXT PRIMARY KEY,
  timestamp REAL NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  phonetic_guide TEXT,
  context_note TEXT,
  category TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  mastery_status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS phrases_ts ON phrases(timestamp DESC);
CREATE TABLE IF NOT EXISTS tracks(
  lang TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  got INTEGER NOT NULL DEFAULT 0,
  again INTEGER NOT NULL DEFAULT 0,
  lessons INTEGER NOT NULL DEFAULT 0,
  updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

// ── Types (snake_case on the wire = the column names) ───────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LangEntry {
    pub id: String,
    pub timestamp: f64,
    pub source_lang: String,
    pub target_lang: String,
    pub source_text: String,
    pub translated_text: String,
    pub phonetic_guide: Option<String>,
    pub context_note: Option<String>,
    pub category: String,
    pub favorite: bool,
    pub mastery_status: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct NewLangEntry {
    pub source_lang: String,
    pub target_lang: String,
    pub source_text: String,
    pub translated_text: String,
    #[serde(default)]
    pub phonetic_guide: Option<String>,
    #[serde(default)]
    pub context_note: Option<String>,
    pub category: String,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub mastery_status: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct LangEntryPatch {
    #[serde(default)]
    pub context_note: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub mastery_status: Option<String>,
    #[serde(default)]
    pub translated_text: Option<String>,
    #[serde(default)]
    pub phonetic_guide: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LangTrack {
    pub lang: String,
    pub level: String,
    pub got: i64,
    pub again: i64,
    pub lessons: i64,
    pub updated: f64,
}

#[derive(Serialize, Debug)]
pub struct SttResult {
    text: String,
    language: Option<String>,
    engine: String,
}

/// A TTS provider the Hub can speak with (from providers.json; keys never leave Rust).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEngineInfo {
    id: String,
    label: String,
    engine: String,
    /// Runs on this machine (false = cloud, e.g. ElevenLabs).
    local: bool,
    model: String,
    voice: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LangStatus {
    db_path: String,
    entries: i64,
    multilingual_model: Option<String>,
    sidecar_running: bool,
    local_tts: bool,
    llm_model: Option<String>,
}

// ── Validation (pure) ───────────────────────────────────────────────────────

/// `en`, `it`, `la`, `ja`, `pt-BR`, `zh-Hans`; `auto` only where the caller allows it.
pub fn valid_lang(s: &str, allow_auto: bool) -> bool {
    if s == "auto" {
        return allow_auto;
    }
    let mut parts = s.split('-');
    let base = parts.next().unwrap_or_default();
    if !(2..=3).contains(&base.len()) || !base.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    match (parts.next(), parts.next()) {
        (None, _) => true,
        (Some(r), None) => (2..=4).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric()),
        _ => false,
    }
}

fn clip_opt(s: Option<String>, max: usize) -> Option<String> {
    s.map(|v| v.trim().chars().take(max).collect::<String>()).filter(|v| !v.is_empty())
}

pub fn validate_new(e: &NewLangEntry) -> Result<(), String> {
    if !valid_lang(&e.source_lang, true) || !valid_lang(&e.target_lang, false) {
        return Err("bad language code".into());
    }
    if !CATEGORIES.contains(&e.category.as_str()) {
        return Err("bad category".into());
    }
    if let Some(m) = &e.mastery_status {
        if !MASTERY.contains(&m.as_str()) {
            return Err("bad mastery_status".into());
        }
    }
    let src = e.source_text.trim();
    let dst = e.translated_text.trim();
    if src.is_empty() || dst.is_empty() || src.chars().count() > MAX_TEXT || dst.chars().count() > MAX_TEXT {
        return Err(format!("source_text and translated_text must be 1–{MAX_TEXT} characters"));
    }
    Ok(())
}

static SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn new_id() -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("lh-{:x}-{:x}", nanos, (n ^ std::process::id() as u64) & 0xffff_ffff)
}

// ── Store (pure over a Connection, so tests use an in-memory DB) ────────────

pub fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("language hub: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(3000)).map_err(|e| e.to_string())?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn row_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<LangEntry> {
    Ok(LangEntry {
        id: r.get("id")?,
        timestamp: r.get("timestamp")?,
        source_lang: r.get("source_lang")?,
        target_lang: r.get("target_lang")?,
        source_text: r.get("source_text")?,
        translated_text: r.get("translated_text")?,
        phonetic_guide: r.get("phonetic_guide")?,
        context_note: r.get("context_note")?,
        category: r.get("category")?,
        favorite: r.get::<_, i64>("favorite")? != 0,
        mastery_status: r.get("mastery_status")?,
    })
}

pub fn list(c: &Connection) -> Result<Vec<LangEntry>, String> {
    let mut st = c.prepare("SELECT * FROM phrases ORDER BY timestamp DESC LIMIT 10000").map_err(|e| e.to_string())?;
    let rows = st.query_map([], row_entry).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get(c: &Connection, id: &str) -> Result<Option<LangEntry>, String> {
    c.query_row("SELECT * FROM phrases WHERE id=?1", [id], row_entry).optional().map_err(|e| e.to_string())
}

pub fn save(c: &Connection, e: NewLangEntry) -> Result<LangEntry, String> {
    validate_new(&e)?;
    let entry = LangEntry {
        id: new_id(),
        timestamp: now_ms(),
        source_lang: e.source_lang,
        target_lang: e.target_lang,
        source_text: e.source_text.trim().to_string(),
        translated_text: e.translated_text.trim().to_string(),
        phonetic_guide: clip_opt(e.phonetic_guide, MAX_TEXT),
        context_note: clip_opt(e.context_note, MAX_NOTE),
        category: e.category,
        favorite: e.favorite.unwrap_or(false),
        mastery_status: e.mastery_status.unwrap_or_else(|| "new".into()),
    };
    c.execute(
        "INSERT INTO phrases(id,timestamp,source_lang,target_lang,source_text,translated_text,phonetic_guide,context_note,category,favorite,mastery_status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![entry.id, entry.timestamp, entry.source_lang, entry.target_lang, entry.source_text, entry.translated_text, entry.phonetic_guide, entry.context_note, entry.category, entry.favorite as i64, entry.mastery_status],
    )
    .map_err(|e| e.to_string())?;
    Ok(entry)
}

pub fn update(c: &Connection, id: &str, p: LangEntryPatch) -> Result<LangEntry, String> {
    let mut e = get(c, id)?.ok_or("not found")?;
    if let Some(n) = p.context_note {
        e.context_note = clip_opt(Some(n), MAX_NOTE);
    }
    if let Some(f) = p.favorite {
        e.favorite = f;
    }
    if let Some(m) = p.mastery_status {
        if !MASTERY.contains(&m.as_str()) {
            return Err("bad mastery_status".into());
        }
        e.mastery_status = m;
    }
    if let Some(t) = p.translated_text {
        let t = t.trim();
        if t.is_empty() || t.chars().count() > MAX_TEXT {
            return Err("bad translated_text".into());
        }
        e.translated_text = t.to_string();
    }
    if let Some(ph) = p.phonetic_guide {
        e.phonetic_guide = clip_opt(Some(ph), MAX_TEXT);
    }
    c.execute(
        "UPDATE phrases SET context_note=?2, favorite=?3, mastery_status=?4, translated_text=?5, phonetic_guide=?6 WHERE id=?1",
        params![e.id, e.context_note, e.favorite as i64, e.mastery_status, e.translated_text, e.phonetic_guide],
    )
    .map_err(|e| e.to_string())?;
    Ok(e)
}

/// Permanent delete (the archive is the user's own; there's no soft-delete here).
pub fn delete(c: &mut Connection, ids: &[String]) -> Result<usize, String> {
    if ids.len() > 10_000 {
        return Err("too many ids".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut n = 0;
    for id in ids {
        n += tx.execute("DELETE FROM phrases WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

pub fn tracks(c: &Connection) -> Result<Vec<LangTrack>, String> {
    let mut st = c.prepare("SELECT lang,level,got,again,lessons,updated FROM tracks ORDER BY updated DESC").map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok(LangTrack { lang: r.get(0)?, level: r.get(1)?, got: r.get(2)?, again: r.get(3)?, lessons: r.get(4)?, updated: r.get(5)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn save_track(c: &Connection, mut t: LangTrack) -> Result<LangTrack, String> {
    if !valid_lang(&t.lang, false) || !LEVELS.contains(&t.level.as_str()) {
        return Err("bad track".into());
    }
    t.got = t.got.clamp(0, 1_000_000);
    t.again = t.again.clamp(0, 1_000_000);
    t.lessons = t.lessons.clamp(0, 1_000_000);
    t.updated = now_ms();
    c.execute(
        "INSERT INTO tracks(lang,level,got,again,lessons,updated) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(lang) DO UPDATE SET level=?2,got=?3,again=?4,lessons=?5,updated=?6",
        params![t.lang, t.level, t.got, t.again, t.lessons, t.updated],
    )
    .map_err(|e| e.to_string())?;
    Ok(t)
}

/// Hub settings (e.g. "voice"): small JSON values keyed by a short name.
pub fn valid_setting_key(k: &str) -> bool {
    (1..=40).contains(&k.len()) && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' || c == '.') && !k.contains("..")
}

pub fn get_setting(c: &Connection, key: &str) -> Result<Option<Value>, String> {
    if !valid_setting_key(key) {
        return Err("bad setting key".into());
    }
    let raw: Option<String> = c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
}

pub fn set_setting(c: &Connection, key: &str, value: &Value) -> Result<(), String> {
    if !valid_setting_key(key) {
        return Err("bad setting key".into());
    }
    let raw = value.to_string();
    if raw.len() > 64 * 1024 {
        return Err("setting too large".into());
    }
    c.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2", params![key, raw]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Languages ElevenLabs accepts as `language_code` (Latin isn't one: the model reads it unaided).
pub fn eleven_lang(lang: &str) -> Option<&str> {
    let base = lang.split('-').next().unwrap_or_default();
    const OK: [&str; 29] = ["en", "es", "fr", "it", "ja", "pt", "de", "zh", "ko", "hi", "ar", "ru", "el", "nl", "pl", "tr", "vi", "sv", "da", "fi", "no", "cs", "ro", "uk", "id", "ms", "ta", "fil", "hu"];
    OK.contains(&base).then_some(base)
}

// ── State ───────────────────────────────────────────────────────────────────

struct Sidecar {
    child: std::process::Child,
    _job: Option<crate::proc::Job>,
    last_used: Instant,
}

#[derive(Default)]
pub struct LangHubState {
    conn: Mutex<Option<(PathBuf, Connection)>>,
    sidecar: Mutex<Option<Sidecar>>,
    /// Serialises sidecar start-up (two quick captures must not spawn two servers).
    starting: tokio::sync::Mutex<()>,
}

/// `<gateway workdir>/data/language-hub/library.db` — the same file the gateway opens.
pub fn db_path(dispatch: &DispatchState) -> PathBuf {
    PathBuf::from(dispatch.snapshot().gateway.workdir).join("data").join("language-hub").join("library.db")
}

impl LangHubState {
    fn with<T>(&self, dispatch: &DispatchState, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let path = db_path(dispatch);
        let mut g = self.conn.lock().unwrap();
        if g.as_ref().map(|(p, _)| p != &path).unwrap_or(true) {
            *g = Some((path.clone(), open_db(&path)?));
        }
        f(&mut g.as_mut().unwrap().1)
    }

    fn sidecar_alive(&self) -> bool {
        let mut g = self.sidecar.lock().unwrap();
        match g.as_mut() {
            Some(s) => matches!(s.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    fn touch(&self) {
        if let Some(s) = self.sidecar.lock().unwrap().as_mut() {
            s.last_used = Instant::now();
        }
    }

    /// Stop the sidecar we started (one the gateway started is left to the gateway).
    fn stop_sidecar(&self) -> bool {
        if let Some(mut s) = self.sidecar.lock().unwrap().take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
            return true;
        }
        false
    }
}

// ── Provider helpers ────────────────────────────────────────────────────────

fn stt_main(d: &DispatchState) -> Result<Provider, String> {
    let cfg = d.snapshot();
    cfg.providers.iter().find(|p| p.id == cfg.policy.stt && p.kind == Kind::Stt).cloned().ok_or_else(|| "no STT provider configured".into())
}

fn kokoro(d: &DispatchState) -> Option<Provider> {
    d.snapshot().providers.into_iter().find(|p| p.kind == Kind::Tts && p.engine.as_deref() == Some("kokoro"))
}

fn llm(d: &DispatchState) -> Result<Provider, String> {
    let cfg = d.snapshot();
    let want = cfg.policy.primary_local.clone();
    cfg.providers
        .iter()
        .find(|p| p.id == want && p.kind == Kind::Local)
        .or_else(|| cfg.providers.iter().find(|p| p.kind == Kind::Local && !p.needs_key))
        .cloned()
        .ok_or_else(|| "no local LLM provider configured".into())
}

/// Kokoro voice for a language code (base subtag), None when Kokoro has no voice for it.
pub fn kokoro_voice(lang: &str) -> Option<&'static str> {
    Some(match lang.split('-').next().unwrap_or_default() {
        "en" => "af_heart",
        "es" => "ef_dora",
        "fr" => "ff_siwis",
        "it" => "if_sara",
        "ja" => "jf_alpha",
        "pt" => "pf_dora",
        "hi" => "hf_alpha",
        "zh" => "zf_xiaobei",
        _ => return None,
    })
}

/// The best multilingual ggml model in `dir`: the preference list first, then any non-`.en` file.
pub fn pick_ml_model(dir: &Path) -> Option<PathBuf> {
    for m in ML_MODELS {
        let p = dir.join(format!("ggml-{m}.bin"));
        if p.is_file() {
            return Some(p);
        }
    }
    let mut others: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            n.starts_with("ggml-") && n.ends_with(".bin") && !n.contains(".en") && !n.contains("silero") && !n.contains("vad")
        })
        .collect();
    others.sort();
    others.into_iter().next()
}

fn models_dir(d: &DispatchState) -> Option<PathBuf> {
    d.snapshot().providers.into_iter().find(|p| p.kind == Kind::Stt && p.engine.as_deref() == Some("whispercpp")).and_then(|p| p.models_dir).map(PathBuf::from)
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

async fn ensure_sidecar(d: &DispatchState, hub: &LangHubState, app: &tauri::AppHandle) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{SIDECAR_PORT}/v1");
    let _g = hub.starting.lock().await;
    if hub.sidecar_alive() || port_open(SIDECAR_PORT) {
        hub.touch();
        return Ok(url);
    }
    hub.stop_sidecar(); // a dead child: reap it
    let dir = models_dir(d).ok_or("LANG_STT_NO_MULTILINGUAL: no whisper.cpp modelsDir configured")?;
    let model = pick_ml_model(&dir).ok_or_else(|| format!("LANG_STT_NO_MULTILINGUAL: put a multilingual model (e.g. ggml-small.bin) in {}", dir.display()))?;
    let exe = dir.parent().map(|p| p.join("bin").join(if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" })).filter(|p| p.is_file()).ok_or("LANG_STT_NO_MULTILINGUAL: whisper-server not found next to the models folder")?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["-m", &model.to_string_lossy(), "--host", "127.0.0.1", "--port", &SIDECAR_PORT.to_string(), "--inference-path", "/v1/audio/transcriptions", "-t", "6", "-l", "auto"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("whisper sidecar: {e}"))?;
    let job = crate::proc::Job::kill_on_close().ok();
    if let Some(j) = &job {
        let _ = j.assign(&child);
    }
    *hub.sidecar.lock().unwrap() = Some(Sidecar { child, _job: job, last_used: Instant::now() });
    // Model load: a few seconds for small, longer for large.
    let t0 = Instant::now();
    while !port_open(SIDECAR_PORT) {
        if !hub.sidecar_alive() {
            hub.stop_sidecar();
            return Err("whisper sidecar exited during start-up".into());
        }
        if t0.elapsed() > Duration::from_secs(90) {
            hub.stop_sidecar();
            return Err("whisper sidecar did not start within 90 s".into());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    eprintln!("[language-hub] multilingual whisper sidecar up ({})", model.display());
    // Idle reaper: zero overhead once the Hub goes quiet.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let hub = handle.state::<LangHubState>();
            let idle = hub.sidecar.lock().unwrap().as_ref().map(|s| s.last_used.elapsed());
            match idle {
                None => break,
                Some(t) if t > SIDECAR_IDLE => {
                    hub.stop_sidecar();
                    eprintln!("[language-hub] sidecar stopped (idle)");
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(url)
}

/// First JSON object in a model reply (think blocks and code fences tolerated).
pub fn first_json_object(text: &str) -> Option<Value> {
    let cleaned = super::dispatch::strip_think(text);
    let bytes = cleaned.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'{' {
            let mut it = serde_json::Deserializer::from_str(&cleaned[i..]).into_iter::<Value>();
            if let Some(Ok(v)) = it.next() {
                if v.is_object() {
                    return Some(v);
                }
            }
        }
    }
    None
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn lang_library_list(d: State<'_, DispatchState>, hub: State<'_, LangHubState>) -> Result<Vec<LangEntry>, String> {
    hub.with(&d, |c| list(c))
}

#[tauri::command]
pub fn lang_library_save(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, entry: NewLangEntry) -> Result<LangEntry, String> {
    hub.with(&d, |c| save(c, entry))
}

#[tauri::command]
pub fn lang_library_update(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, id: String, patch: LangEntryPatch) -> Result<LangEntry, String> {
    hub.with(&d, |c| update(c, &id, patch))
}

#[tauri::command]
pub fn lang_library_delete(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, ids: Vec<String>) -> Result<usize, String> {
    hub.with(&d, |c| delete(c, &ids))
}

#[tauri::command]
pub fn lang_tracks_list(d: State<'_, DispatchState>, hub: State<'_, LangHubState>) -> Result<Vec<LangTrack>, String> {
    hub.with(&d, |c| tracks(c))
}

#[tauri::command]
pub fn lang_track_save(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, track: LangTrack) -> Result<LangTrack, String> {
    hub.with(&d, |c| save_track(c, track))
}

#[tauri::command]
pub fn lang_status(d: State<'_, DispatchState>, hub: State<'_, LangHubState>) -> Result<LangStatus, String> {
    let entries = hub.with(&d, |c| c.query_row("SELECT COUNT(*) FROM phrases", [], |r| r.get(0)).map_err(|e| e.to_string()))?;
    Ok(LangStatus {
        db_path: db_path(&d).to_string_lossy().into_owned(),
        entries,
        multilingual_model: models_dir(&d).and_then(|m| pick_ml_model(&m)).and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
        sidecar_running: hub.sidecar_alive() || port_open(SIDECAR_PORT),
        local_tts: kokoro(&d).is_some(),
        llm_model: llm(&d).ok().map(|p| p.model),
    })
}

/// Raw WAV body; header `x-lang`: `auto` | a language code. Same mic gate as `stt_transcribe`.
#[tauri::command]
pub async fn lang_stt(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, app: tauri::AppHandle, request: Request<'_>) -> Result<SttResult, String> {
    if !mic_enabled() {
        return Err(MIC_DISABLED.into());
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw WAV bytes".into());
    };
    if bytes.len() < 1024 || bytes.len() > MAX_AUDIO {
        return Err("audio too short or too long".into());
    }
    let lang = request.headers().get("x-lang").and_then(|v| v.to_str().ok()).unwrap_or("auto").to_string();
    if !valid_lang(&lang, true) {
        return Err("bad language code".into());
    }
    let audio = bytes.clone();
    let (base, model, key, engine) = if lang == "en" {
        let p = stt_main(&d)?;
        let key = d.key_for(&p)?;
        (p.base_url.clone(), p.model.clone(), key, "whisper")
    } else {
        (ensure_sidecar(&d, &hub, &app).await?, "whisper-1".to_string(), None, "whisper-multilingual")
    };
    let part = reqwest::multipart::Part::bytes(audio).file_name("speech.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new().part("file", part).text("model", model).text("response_format", "verbose_json").text("temperature", "0");
    form = form.text("language", lang.split('-').next().unwrap_or("auto").to_string());
    let mut rb = d.http.post(format!("{}/audio/transcriptions", base.trim_end_matches('/'))).timeout(Duration::from_secs(180)).multipart(form);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let body: Value = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.json().await.map_err(short)?;
    hub.touch();
    if !mic_enabled() {
        return Ok(SttResult { text: String::new(), language: None, engine: engine.into() });
    }
    let text = body["text"].as_str().unwrap_or_default().trim().to_string();
    let junk = ["[BLANK_AUDIO]", "(silence)", "[ Silence ]", "[silence]"];
    let text = if junk.iter().any(|j| text.eq_ignore_ascii_case(j)) { String::new() } else { text };
    let language = body["language"].as_str().map(str::to_string).or_else(|| (lang != "auto").then(|| lang.clone()));
    Ok(SttResult { text, language, engine: engine.into() })
}

/// Audio for `text` in `lang` on the chosen TTS provider (`engine` = provider id; default Kokoro).
/// `voice` / `model` override the provider's own. Errors the webview treats as "fall back":
/// `UNSUPPORTED_LANG`, `NO_LOCAL_TTS`, `KILL_SWITCH`, or the engine's own failure.
#[tauri::command]
pub async fn lang_tts(
    d: State<'_, DispatchState>,
    os: State<'_, super::os_core::OsState>,
    text: String,
    lang: String,
    engine: Option<String>,
    voice: Option<String>,
    model: Option<String>,
) -> Result<Response, String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 2000 {
        return Err("text must be 1–2000 characters".into());
    }
    let voice = voice.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v.len() <= 128);
    let p = match engine.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        Some(id) => d.snapshot().providers.into_iter().find(|p| p.id == id && p.kind == Kind::Tts).ok_or_else(|| format!("no TTS provider '{id}'"))?,
        None => kokoro(&d).ok_or("NO_LOCAL_TTS")?,
    };
    if p.engine.as_deref() == Some("elevenlabs") {
        if os.snapshot().privacy.kill_switch {
            return Err("KILL_SWITCH".into());
        }
        let voice_id = voice.or_else(|| p.voice.clone()).ok_or("pick an ElevenLabs voice in the Language Hub's Voice panel")?;
        let mut p = p.clone();
        p.language = eleven_lang(&lang).map(str::to_string);
        let bytes = super::elevenlabs::synthesize(&d, &p, text, &voice_id, model.as_deref(), None).await.map_err(|e| e.reason())?;
        return Ok(Response::new(bytes));
    }
    // Local engines (Kokoro / XTTS): an explicit voice wins, else Kokoro's voice for the language.
    let voice = match voice {
        Some(v) => v,
        None if p.engine.as_deref() == Some("kokoro") => kokoro_voice(&lang).ok_or("UNSUPPORTED_LANG")?.to_string(),
        None => p.voice.clone().ok_or("UNSUPPORTED_LANG")?,
    };
    let bytes = synth_local(&d, &p, text, Some(voice)).await?;
    Ok(Response::new(bytes))
}

/// The TTS providers the Voice panel offers (ids, engines, default model/voice — never keys).
#[tauri::command]
pub fn lang_voice_engines(d: State<'_, DispatchState>) -> Vec<VoiceEngineInfo> {
    d.snapshot()
        .providers
        .into_iter()
        .filter(|p| p.kind == Kind::Tts)
        .map(|p| VoiceEngineInfo {
            local: p.engine.as_deref() != Some("elevenlabs"),
            engine: p.engine.clone().unwrap_or_else(|| "kokoro".into()),
            label: p.label.clone(),
            id: p.id,
            model: p.model,
            voice: p.voice,
        })
        .collect()
}

#[tauri::command]
pub fn lang_settings_get(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, key: String) -> Result<Option<Value>, String> {
    hub.with(&d, |c| get_setting(c, &key))
}

#[tauri::command]
pub fn lang_settings_set(d: State<'_, DispatchState>, hub: State<'_, LangHubState>, key: String, value: Value) -> Result<(), String> {
    hub.with(&d, |c| set_setting(c, &key, &value))
}

/// One JSON-only completion on the local LLM (prompts are built in TypeScript).
#[tauri::command]
pub async fn lang_llm_json(d: State<'_, DispatchState>, system: String, prompt: String) -> Result<Value, String> {
    if system.len() > 8000 || prompt.len() > 12000 {
        return Err("prompt too long".into());
    }
    let p = llm(&d)?;
    let key = d.key_for(&p)?;
    let mut messages = vec![serde_json::json!({"role": "system", "content": system}), serde_json::json!({"role": "user", "content": prompt})];
    for attempt in 0..2 {
        // Thinking off: a reasoning model (qwen3.x) otherwise spends the whole budget on <think>
        // and returns no JSON (~90 s → ~2 s). Servers that don't know these fields ignore them.
        let body = serde_json::json!({
            "model": p.model, "messages": messages, "temperature": 0.3, "max_tokens": 1200, "stream": false,
            "reasoning_effort": "none", "chat_template_kwargs": { "enable_thinking": false },
        });
        let mut rb = d.http.post(format!("{}/chat/completions", p.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(120)).json(&body);
        if let Some(k) = &key {
            rb = rb.bearer_auth(k);
        }
        let v: Value = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.json().await.map_err(short)?;
        let content = v["choices"][0]["message"]["content"].as_str().unwrap_or_default();
        if let Some(j) = first_json_object(content) {
            return Ok(j);
        }
        if attempt == 0 {
            messages.push(serde_json::json!({"role": "user", "content": "Return ONLY the JSON object, nothing else."}));
        }
    }
    Err("the local model returned no JSON".into())
}

/// The Hub closed: stop the multilingual sidecar now instead of waiting for the idle reaper.
#[tauri::command]
pub fn lang_release(hub: State<'_, LangHubState>) -> bool {
    hub.stop_sidecar()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    fn entry(src: &str) -> NewLangEntry {
        NewLangEntry {
            source_lang: "it".into(),
            target_lang: "en".into(),
            source_text: src.into(),
            translated_text: "Good morning".into(),
            phonetic_guide: Some("bwon JOR-no".into()),
            context_note: Some("  Heard at coffee shop ".into()),
            category: "public_capture".into(),
            favorite: None,
            mastery_status: None,
        }
    }

    #[test]
    fn lang_codes() {
        for ok in ["en", "it", "la", "ja", "pt-BR", "zh-Hans", "fil"] {
            assert!(valid_lang(ok, false), "{ok}");
        }
        assert!(valid_lang("auto", true));
        for bad in ["auto", "EN", "e", "english", "pt-", "pt-BR-x", "../x", ""] {
            assert!(!valid_lang(bad, false), "{bad}");
        }
    }

    #[test]
    fn save_list_update_delete_roundtrip() {
        let mut c = mem();
        let a = save(&c, entry("Buongiorno")).unwrap();
        let b = save(&c, entry("Ciao")).unwrap();
        assert_eq!(a.context_note.as_deref(), Some("Heard at coffee shop"));
        assert_eq!(a.mastery_status, "new");
        assert!(!a.favorite);
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 2);
        let u = update(&c, &a.id, LangEntryPatch { favorite: Some(true), mastery_status: Some("learning".into()), context_note: Some("".into()), ..Default::default() }).unwrap();
        assert!(u.favorite);
        assert_eq!(u.mastery_status, "learning");
        assert_eq!(u.context_note, None);
        assert_eq!(get(&c, &a.id).unwrap().unwrap(), u);
        assert!(update(&c, &a.id, LangEntryPatch { mastery_status: Some("expert".into()), ..Default::default() }).is_err());
        assert_eq!(delete(&mut c, &[a.id.clone(), "nope".into()]).unwrap(), 1);
        let rest = list(&c).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, b.id);
    }

    #[test]
    fn rejects_bad_entries() {
        let c = mem();
        let mut e = entry("x");
        e.category = "vault".into();
        assert!(save(&c, e).is_err());
        let mut e = entry("x");
        e.target_lang = "auto".into();
        assert!(save(&c, e).is_err());
        let mut e = entry("   ");
        e.translated_text = "y".into();
        assert!(save(&c, e).is_err());
        // auto is a fine *source* (an undetected capture).
        let mut e = entry("x");
        e.source_lang = "auto".into();
        assert!(save(&c, e).is_ok());
    }

    #[test]
    fn tracks_upsert() {
        let c = mem();
        let t = LangTrack { lang: "la".into(), level: "beginner".into(), got: 3, again: -4, lessons: 1, updated: 0.0 };
        let s = save_track(&c, t.clone()).unwrap();
        assert_eq!(s.again, 0);
        save_track(&c, LangTrack { level: "intermediate".into(), got: 5, ..t.clone() }).unwrap();
        let all = tracks(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].level.as_str(), all[0].got), ("intermediate", 5));
        assert!(save_track(&c, LangTrack { level: "fluent".into(), ..t }).is_err());
    }

    #[test]
    fn settings_roundtrip() {
        let c = mem();
        assert_eq!(get_setting(&c, "voice").unwrap(), None);
        let v = serde_json::json!({"engine": "elevenlabs", "voices": {"elevenlabs": {"*": "abc"}}});
        set_setting(&c, "voice", &v).unwrap();
        set_setting(&c, "voice", &v).unwrap(); // upsert
        assert_eq!(get_setting(&c, "voice").unwrap(), Some(v));
        assert!(set_setting(&c, "../x", &serde_json::json!(1)).is_err());
        assert!(set_setting(&c, "big", &serde_json::json!("x".repeat(70_000))).is_err());
        assert_eq!(eleven_lang("pt-BR"), Some("pt"));
        assert_eq!(eleven_lang("la"), None);
    }

    #[test]
    fn json_extraction() {
        assert_eq!(first_json_object("<think>hmm {no}</think>```json\n{\"a\":1}\n```").unwrap()["a"], 1);
        assert_eq!(first_json_object("Sure! {\"translation\":\"Ciao {amico}\"} trailing").unwrap()["translation"], "Ciao {amico}");
        assert!(first_json_object("no json here").is_none());
    }

    #[test]
    fn kokoro_voices_and_models() {
        assert_eq!(kokoro_voice("it"), Some("if_sara"));
        assert_eq!(kokoro_voice("pt-BR"), Some("pf_dora"));
        assert_eq!(kokoro_voice("la"), None);
        let dir = std::env::temp_dir().join(format!("lh-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ggml-base.en.bin"), b"x").unwrap();
        assert_eq!(pick_ml_model(&dir), None);
        std::fs::write(dir.join("ggml-small.bin"), b"x").unwrap();
        assert_eq!(pick_ml_model(&dir).unwrap().file_name().unwrap(), "ggml-small.bin");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
