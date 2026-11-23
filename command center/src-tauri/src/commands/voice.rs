//! Voice I/O through local servers.
//!
//!   STT: Whisper  — POST {base}/audio/transcriptions (multipart, 16 kHz mono WAV)
//!                   whisper.cpp models switch live via POST {origin}/load
//!   TTS: Kokoro   — POST {base}/audio/speech → mp3; voices from GET {base}/audio/voices
//!        XTTS     — POST {origin}/tts_to_audio/ {text, speaker_wav, language} → wav
//!                   (Coqui XTTS api-server; a speaker = a reference .wav)
//!
//! Custom voices are written to the TTS provider's `voicesDir` (mount that
//! folder into the Kokoro / XTTS container). Audio crosses IPC as raw bytes.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::dispatch::{canon_role, short, AgentVoice, DispatchState, Kind, Provider};
use super::elevenlabs;

const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024; // ~8 min of 16 kHz mono PCM
const MAX_VOICE_BYTES: usize = 200 * 1024 * 1024; // .pth / .onnx voice models can be large
const VOICE_EXTS: [&str; 8] = ["wav", "mp3", "flac", "ogg", "pt", "pth", "onnx", "json"];
/// Samples ElevenLabs can clone from.
const CLONE_EXTS: [&str; 6] = ["wav", "mp3", "flac", "ogg", "m4a", "webm"];
const MAX_CLONE_BYTES: usize = 11 * 1024 * 1024;

fn origin(base: &str) -> String {
    url::Url::parse(base).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| base.to_string())
}

fn stt_provider(state: &DispatchState) -> Result<Provider, String> {
    let id = state.snapshot().policy.stt;
    state.provider(&id).filter(|p| p.kind == Kind::Stt).ok_or_else(|| "no STT provider configured".into())
}

fn tts_provider(state: &DispatchState) -> Result<Provider, String> {
    let id = state.snapshot().policy.tts;
    state.provider(&id).filter(|p| p.kind == Kind::Tts).ok_or_else(|| "no TTS provider configured".into())
}

fn voices_dir(state: &DispatchState, p: &Provider) -> Option<PathBuf> {
    p.voices_dir.as_ref().map(PathBuf::from).or_else(|| state.config_dir().map(|d| d.join("voices")))
}

// ── Hard mic sovereignty (Phase 2 Part B) ────────────────────────────────────
//
// `MIC_ENABLED` is the authoritative mic flag on the desktop (seeded from os.json
// `voice.micEnabled` at startup). While it is false the line is dead at this layer too:
// `transcribe_bytes` refuses before any provider lookup or HTTP (this is the only client of
// the Whisper server on :8178), and the native cpal engine is halted and refuses to start.
// The webview has its own gate (`mic-gate.ts`); this one holds even if that one is bypassed.

/// False = mic locked off: zero STT requests, no native capture.
pub static MIC_ENABLED: AtomicBool = AtomicBool::new(true);
/// `{ enabled: bool }`: the authoritative state changed (UI toggle, phone, os.json patch).
pub const MIC_STATE_EVENT: &str = "mic-state";
/// The global hotkey was pressed while the mic is locked off (the webview shows a toast).
pub const MIC_LOCKED_EVENT: &str = "mic-locked";
/// The error `transcribe_bytes` returns while the mic is locked off.
pub const MIC_DISABLED: &str = "mic disabled";

pub fn mic_enabled() -> bool {
    MIC_ENABLED.load(Ordering::SeqCst)
}

/// Apply a mic state now: the atomic first (so an in-flight STT request sees it), then the
/// webview event, then (on mute) halt the native recorder. Persisting is the caller's job.
pub fn set_mic_enabled(app: &tauri::AppHandle, on: bool) {
    use tauri::{Emitter, Manager};
    MIC_ENABLED.store(on, Ordering::SeqCst);
    let _ = app.emit(MIC_STATE_EVENT, serde_json::json!({ "enabled": on }));
    if !on {
        if let Some(engine) = app.try_state::<crate::audio::commands::AudioEngineState>() {
            crate::audio::commands::stop_now(&engine);
        }
    }
}

/// The Mic switch. Disable applies at once (a failed os.json write is logged, the mute
/// still holds this session); enable is persisted first, so a failed write leaves it muted.
#[tauri::command]
pub fn mic_set_enabled(app: tauri::AppHandle, os: State<'_, super::os_core::OsState>, enabled: bool) -> Result<bool, String> {
    let persist = |on: bool| {
        os.update(|c| {
            c.voice.mic_enabled = on;
            Ok(())
        })
    };
    if !enabled {
        set_mic_enabled(&app, false);
        if let Err(e) = persist(false) {
            eprintln!("[mic] locked off (not saved: {e})");
        }
        return Ok(false);
    }
    persist(true)?;
    set_mic_enabled(&app, true);
    Ok(true)
}

/// The webview's hydration read (`mic-gate.ts` `hydrateMic`).
#[tauri::command]
pub fn mic_get() -> bool {
    mic_enabled()
}

// ── STT ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn stt_transcribe(state: State<'_, DispatchState>, request: Request<'_>) -> Result<String, String> {
    // No compaction `Touch` here: with the wake-word mic armed, every VAD utterance (room noise,
    // wake-word candidates) is transcribed, and touching on each one kept the idle compactor's
    // quiet window from ever elapsing. A real command reaches Tony's turn, which touches.
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw WAV bytes".into());
    };
    transcribe_bytes(state.inner(), bytes.clone()).await
}

/// One WAV → text. Refuses while the mic is locked off (before any provider lookup or HTTP),
/// and drops the transcript of a request that was in flight when the mic was locked.
pub(crate) async fn transcribe_bytes(state: &DispatchState, audio: Vec<u8>) -> Result<String, String> {
    if !mic_enabled() {
        return Err(MIC_DISABLED.into());
    }
    if audio.len() < 1024 || audio.len() > MAX_AUDIO_BYTES {
        return Err("audio too short or too long".into());
    }
    let p = stt_provider(state)?;
    let key = state.key_for(&p)?;

    let part = reqwest::multipart::Part::bytes(audio).file_name("speech.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", p.model.clone())
        .text("response_format", "json")
        .text("temperature", "0");
    if let Some(lang) = p.language.clone() {
        form = form.text("language", lang);
    }
    // Vocabulary biasing (Phase 2 §1). whisper.cpp's server reads the `prompt` multipart
    // field on every inference route (incl. `--inference-path /v1/audio/transcriptions`),
    // as does the OpenAI-style API; servers that don't know it ignore the extra field.
    let prompt = effective_stt_prompt(&p);
    if let Some(pr) = prompt.clone() {
        form = form.text("prompt", pr);
    }

    let mut rb = state
        .http
        .post(format!("{}/audio/transcriptions", p.base_url.trim_end_matches('/')))
        // Relaxed/continuous Brainstorm dictation can hand Whisper up to a ~2 min clip
        // (MAX_AUDIO_BYTES ≈ 8 min of audio); 60 s was too tight for that on a slow CPU.
        .timeout(Duration::from_secs(180))
        .multipart(form);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let body: serde_json::Value = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.json().await.map_err(short)?;
    // Locked off while Whisper was working: nothing heard before the mute reaches Tony.
    if !mic_enabled() {
        return Ok(String::new());
    }
    let text = body["text"].as_str().unwrap_or_default().trim().to_string();
    // Whisper emits these on silence (the client-side VAD avoids most of it).
    let junk = ["[BLANK_AUDIO]", "(silence)", "[ Silence ]", "[silence]"];
    if junk.iter().any(|j| text.eq_ignore_ascii_case(j)) {
        return Ok(String::new());
    }
    // base.en sometimes reads its prompt back on a near-silent clip.
    if prompt.as_deref().is_some_and(|pr| echoes_prompt(&text, pr)) {
        eprintln!("[stt] dropped a transcript that repeats the vocabulary prompt");
        return Ok(String::new());
    }
    Ok(text)
}

/// The prompt to send: the provider's own (empty = none), else the built-in default.
fn effective_stt_prompt(p: &Provider) -> Option<String> {
    let s = p.stt_prompt.clone().unwrap_or_else(|| super::dispatch::DEFAULT_STT_PROMPT.to_string());
    Some(s.trim().to_string()).filter(|s| !s.is_empty())
}

fn prompt_words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(|w| w.replace('\'', "").to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// The spoken reflex phrases (and their address words). A line made only of these is a real
/// command even when the prompt lists the same words ("Take it easy, cut it").
const REFLEX_PHRASES: &[&[&str]] = &[&["take", "it", "easy"], &["take", "it", "ease"], &["cut", "it", "out"], &["cut", "it"], &["cut", "that"], &["whoa"], &["madone"], &["aspetta"], &["hey"], &["yo"], &["tony"], &["ok"], &["okay"], &["man"]];

fn only_reflex_phrases(words: &[String]) -> bool {
    let mut i = 0;
    'outer: while i < words.len() {
        for p in REFLEX_PHRASES {
            if words.len() - i >= p.len() && p.iter().zip(&words[i..]).all(|(a, b)| a == b) {
                i += p.len();
                continue 'outer;
            }
        }
        return false;
    }
    true
}

/// Hallucination guard: true when the transcript is MOSTLY the prompt read back — the words
/// covered by runs of 4+ consecutive prompt words (in prompt order, case- and
/// punctuation-insensitive) make up at least 70% of it. A long real dictation that merely
/// contains a 4-word run ("…loop in the booking desk, librarian and ops…") is never thrown
/// away whole, and a line made only of reflex phrases ("Take it easy, cut it") always passes.
pub(crate) fn echoes_prompt(text: &str, prompt: &str) -> bool {
    const RUN: usize = 4;
    let t = prompt_words(text);
    let p = prompt_words(prompt);
    if t.len() < RUN || p.len() < RUN || only_reflex_phrases(&t) {
        return false;
    }
    let mut covered = vec![false; t.len()];
    for (i, w) in t.windows(RUN).enumerate() {
        if p.windows(RUN).any(|q| q == w) {
            covered[i..i + RUN].iter_mut().for_each(|c| *c = true);
        }
    }
    let n = covered.iter().filter(|c| **c).count();
    n * 10 >= t.len() * 7
}

/// Whisper selector: model variant + language. whisper.cpp loads the new
/// model immediately (POST /load) when `modelsDir` holds ggml-<variant>.bin.
#[tauri::command]
pub async fn stt_configure(state: State<'_, DispatchState>, model: Option<String>, language: Option<String>) -> Result<String, String> {
    let p = stt_provider(&state)?;
    let mut note = "saved".to_string();
    if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
        if !m.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c)) {
            return Err("bad model name".into());
        }
        if p.engine.as_deref() == Some("whispercpp") {
            if let Some(dir) = p.models_dir.as_deref() {
                let file = Path::new(dir).join(format!("ggml-{m}.bin"));
                if !file.exists() {
                    return Err(format!("{} not found — download it into {dir}", file.display()));
                }
                let form = reqwest::multipart::Form::new().text("model", file.to_string_lossy().into_owned());
                state
                    .http
                    .post(format!("{}/load", origin(&p.base_url)))
                    .timeout(Duration::from_secs(120))
                    .multipart(form)
                    .send()
                    .await
                    .map_err(short)?
                    .error_for_status()
                    .map_err(short)?;
                note = format!("loaded ggml-{m}.bin");
            } else {
                note = "saved — set modelsDir to hot-swap whisper.cpp models".into();
            }
        }
    }
    state.update(|cfg| {
        let t = cfg.providers.iter_mut().find(|x| x.id == p.id).ok_or("provider vanished")?;
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            t.model = m;
        }
        if let Some(l) = language {
            t.language = Some(l).filter(|s| !s.is_empty() && s != "auto");
        }
        Ok(())
    })?;
    Ok(note)
}

// ── TTS ──────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    id: String,
    source: &'static str, // "server" | "custom"
    file: Option<String>,
    /// Display name when it differs from the id (ElevenLabs voice IDs are opaque).
    label: Option<String>,
    /// ElevenLabs: cloned | professional | generated | premade
    category: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicesView {
    provider: String,
    engine: String,
    current: Option<String>,
    voices_dir: Option<String>,
    voices: Vec<VoiceInfo>,
    server_error: Option<String>,
    /// Where the API key came from (cloud engines only): env | env-file | keychain | missing.
    key_source: Option<elevenlabs::KeySource>,
}

/// Every voice the TTS server reports, plus custom files in voicesDir.
/// `engine` (Part 3: the voice roster, previewing an engine the global
/// `policy.tts` isn't currently set to) picks that provider by its `engine`
/// field instead of the policy default; omit it for the old behaviour.
#[tauri::command]
pub async fn tts_voices(state: State<'_, DispatchState>, engine: Option<String>) -> Result<VoicesView, String> {
    let p = match engine.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(want) => state.snapshot().providers.into_iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() == Some(want)).ok_or_else(|| format!("no TTS provider configured for engine '{want}'"))?,
        None => tts_provider(&state)?,
    };
    let engine = p.engine.clone().unwrap_or_else(|| "kokoro".into());

    // ElevenLabs: the account's voices (cloned first), fetched live.
    if engine == "elevenlabs" {
        let (_, key_source) = elevenlabs::api_key(&state, &p);
        let (voices, server_error) = match elevenlabs::list_voices(&state, &p).await {
            Ok(v) => (
                v.into_iter().map(|v| VoiceInfo { id: v.id, source: "server", file: None, label: Some(v.name), category: Some(v.category) }).collect(),
                None,
            ),
            Err(e) => (vec![], Some(e)),
        };
        return Ok(VoicesView { provider: p.id.clone(), engine, current: p.voice.clone(), voices_dir: None, voices, server_error, key_source: Some(key_source) });
    }

    let mut voices = Vec::new();
    let mut server_error = None;

    let url = if engine == "xtts" { format!("{}/speakers_list", origin(&p.base_url)) } else { format!("{}/audio/voices", p.base_url.trim_end_matches('/')) };
    match state.http.get(url).timeout(Duration::from_secs(5)).send().await {
        Ok(r) if r.status().is_success() => {
            let v: serde_json::Value = r.json().await.map_err(short)?;
            // Kokoro: {"voices":[...]}; XTTS: [...] (strings or {name}).
            let list = v.get("voices").cloned().unwrap_or(v);
            for item in list.as_array().into_iter().flatten() {
                let id = item.as_str().map(String::from).or_else(|| item["name"].as_str().map(String::from));
                if let Some(id) = id {
                    voices.push(VoiceInfo { id, source: "server", file: None, label: None, category: None });
                }
            }
        }
        Ok(r) => server_error = Some(format!("HTTP {}", r.status().as_u16())),
        Err(e) => server_error = Some(short(e)),
    }

    let dir = voices_dir(&state, &p);
    if let Some(d) = dir.as_ref().filter(|d| d.exists()) {
        for entry in std::fs::read_dir(d).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if VOICE_EXTS.contains(&ext.as_str()) {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if !voices.iter().any(|v| v.id == stem) {
                    voices.push(VoiceInfo { id: stem, source: "custom", file: path.file_name().map(|f| f.to_string_lossy().into_owned()), label: None, category: None });
                }
            }
        }
    }
    voices.sort_by(|a, b| (a.source, &a.id).cmp(&(b.source, &b.id)));
    Ok(VoicesView {
        provider: p.id.clone(),
        engine,
        current: p.voice.clone(),
        voices_dir: dir.map(|d| d.to_string_lossy().into_owned()),
        voices,
        server_error,
        key_source: None,
    })
}

/// "Add / Load Custom Voice": raw file bytes in, header `x-filename` (+ optional `x-voice-name`).
/// ElevenLabs: instant-clones the sample and returns the new voice ID.
/// Local engines: saved into voicesDir so the TTS server (with that folder mounted) can load it.
#[tauri::command]
pub async fn tts_voice_upload(state: State<'_, DispatchState>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file bytes".into());
    };
    let p = tts_provider(&state)?;
    if p.engine.as_deref() == Some("elevenlabs") {
        let raw_name = request.headers().get("x-filename").and_then(|h| h.to_str().ok()).unwrap_or("voice.mp3");
        let file = Path::new(raw_name).file_name().and_then(|n| n.to_str()).unwrap_or("voice.mp3").to_string();
        let ext = Path::new(&file).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !CLONE_EXTS.contains(&ext.as_str()) {
            return Err(format!("ElevenLabs clones from audio: use {}", CLONE_EXTS.join(", ")));
        }
        if bytes.is_empty() || bytes.len() > MAX_CLONE_BYTES {
            return Err("voice sample must be under 11 MB (30 s – 2 min of clean speech is ideal)".into());
        }
        let name = request
            .headers()
            .get("x-voice-name")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.trim().chars().take(60).collect::<String>())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Path::new(&file).file_stem().and_then(|s| s.to_str()).unwrap_or("Custom voice").to_string());
        return elevenlabs::add_voice(&state, &p, &name, &file, bytes.to_vec()).await;
    }
    if bytes.is_empty() || bytes.len() > MAX_VOICE_BYTES {
        return Err("file empty or larger than 200 MB".into());
    }
    let raw_name = request.headers().get("x-filename").and_then(|h| h.to_str().ok()).unwrap_or("voice.wav");
    let name = Path::new(raw_name).file_name().and_then(|n| n.to_str()).unwrap_or("voice.wav");
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !VOICE_EXTS.contains(&ext.as_str()) {
        return Err(format!("unsupported voice file .{ext} (use {})", VOICE_EXTS.join(", ")));
    }
    let stem: String = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(48)
        .collect();
    let dir = voices_dir(&state, &p).ok_or("no voicesDir configured")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{stem}.{ext}")), bytes).map_err(|e| e.to_string())?;
    Ok(stem)
}

/// Built-in Kokoro voice a sub-agent (or a worker narrator: verifier, staging, system) speaks
/// with when the roster has no row for it, so a handoff ("Here's Ops.") or a narration line
/// never answers in Tony's own voice. Runtime only: providers.json is never rewritten. Tony
/// ("general") has no default: he keeps the local provider's own voice.
pub(crate) fn default_agent_voice(role: &str) -> Option<&'static str> {
    match role {
        "booking" => Some("am_michael"),
        "prompter" => Some("bm_george"),
        "coder" => Some("am_adam"),
        "designer" => Some("af_nicole"),
        "director" => Some("bm_daniel"),
        "librarian" => Some("bf_emma"),
        "ops" => Some("am_eric"),
        "verifier" => Some("bm_lewis"),
        "staging" => Some("af_sarah"),
        "system" => Some("am_liam"),
        _ => None,
    }
}

/// The voice a LOCAL engine should speak `role` with (ElevenLabs fallback, kill switch, a
/// `localOnly` narration line), so per-agent voices survive an ElevenLabs outage: the agent's
/// own Kokoro roster voice, else its built-in Kokoro default, else the local provider's own
/// voice (Tony, unknown speakers). A non-Kokoro local engine (XTTS) keeps its own voice:
/// Kokoro voice names mean nothing to it. Pure.
pub(crate) fn local_voice_for(role: Option<&str>, roster: &std::collections::BTreeMap<String, AgentVoice>, local_engine: Option<&str>, local_default: Option<&str>) -> Option<String> {
    let own = || local_default.map(str::to_string);
    if local_engine != Some("kokoro") {
        return own();
    }
    let Some(role) = role else { return own() };
    if let Some(v) = roster.get(role).filter(|av| av.engine == "kokoro").and_then(|av| av.voice.clone()).filter(|v| !v.trim().is_empty()) {
        return Some(v);
    }
    default_agent_voice(role).map(str::to_string).or_else(own)
}

/// The roster entry to speak `agent` with: that agent's own entry; else, when Kokoro is
/// configured (`kokoro`), the agent's built-in Kokoro default (auto-speak off) — also with
/// an empty roster, so every agent keeps a distinct voice; else Tony's ("general"); else `None`. Only consulted when
/// `agent` is actually named — a call that never identifies a speaker (a cue clip's own
/// voice, a Settings preview) skips the roster entirely and keeps using the single
/// global `policy.tts` provider, exactly as before Part 3's roster existed.
/// `agent` is already canonicalized ("tony" → "general") by the caller.
fn roster_entry_for(agent_voices: &std::collections::BTreeMap<String, AgentVoice>, agent: Option<&str>, kokoro: bool) -> Option<AgentVoice> {
    let agent = agent?;
    if let Some(own) = agent_voices.get(agent) {
        return Some(own.clone());
    }
    if let Some(voice) = default_agent_voice(agent).filter(|_| kokoro) {
        return Some(AgentVoice { engine: "kokoro".into(), voice: Some(voice.into()), model: None, auto_speak: false });
    }
    agent_voices.get("general").cloned()
}

/// 1–2000 *characters* (was bytes — a non-ASCII reply under the character
/// cap could still be rejected as "too long").
fn text_len_ok(s: &str) -> bool {
    (1..=2000).contains(&s.chars().count())
}

// ── TTS breaker (P1): one failed ElevenLabs call per reply, not one per sentence ──
//
// A reply is synthesized sentence by sentence, often several calls in flight at once.
// Before the breaker, a model/key problem (eleven_v3's 400s, a dead key) failed EVERY
// sentence: N doomed API calls and N "Voice fell back" notices per reply. Now the
// first failure trips the reply's `utterance_id`, its remaining sentences go straight to
// local TTS, and exactly one `tts-fallback` event is emitted. 402 (paid voice) and 429
// (rate/quota) also pause ElevenLabs for a while. Pure (time injected) so it is unit-
// tested; held in a module static, so neither `DispatchState` nor `lib.rs` changes.

/// Forget utterances after this long (a reply never takes 5 min).
const BREAKER_TTL: Duration = Duration::from_secs(300);
/// Bound on every map: ids come from the webview.
const BREAKER_CAP: usize = 64;
/// No utterance id: one notice per reason per 10 s.
const EMIT_DEDUPE: Duration = Duration::from_secs(10);
/// 402 = this voice needs a paid plan; pause only that voice.
const VOICE_COOLDOWN_SECS: u64 = 120;
/// 429 without a usable Retry-After.
const GLOBAL_COOLDOWN_SECS: u64 = 30;
/// Clamp a Retry-After so a huge value can't silence the cloud voice for hours.
const MAX_COOLDOWN_SECS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BreakScope {
    /// This reply only (400/401/403/422, timeouts, unreachable, config errors).
    Utterance,
    /// This voice id, every reply (402).
    Voice,
    /// Every ElevenLabs call (429).
    Global,
}

impl BreakScope {
    fn as_str(self) -> &'static str {
        match self {
            BreakScope::Utterance => "utterance",
            BreakScope::Voice => "voice",
            BreakScope::Global => "global",
        }
    }
}

/// Why a call is short-circuited: who it applies to, the status that caused it, and
/// (for a cooldown) how long is left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Block {
    pub scope: BreakScope,
    pub status: Option<u16>,
    pub remaining_secs: u64,
}

impl Block {
    /// The error an explicit preview gets instead of an API call.
    fn preview_error(&self) -> String {
        let code = self.status.map(|c| format!("HTTP {c}")).unwrap_or_else(|| "unreachable".into());
        match self.scope {
            BreakScope::Utterance => format!("ElevenLabs skipped for this reply ({code})"),
            _ => format!("ElevenLabs paused {}s ({code})", self.remaining_secs),
        }
    }
}

/// What to put in a `tts-fallback` event (never more than one per fallback event).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Notice {
    /// "utterance" | "voice" | "global" | "call" (no utterance id).
    pub scope: &'static str,
    pub status: Option<u16>,
    pub cooldown_secs: Option<u64>,
}

/// What a failure does to the breaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Effect {
    Utterance,
    Cooldown(BreakScope, u64),
    Nothing,
}

fn effect_of(status: Option<u16>, retry_after: Option<u64>) -> Effect {
    match status {
        // Timeout / unreachable / no key / bad voice id: the next sentence fails the same way.
        None => Effect::Utterance,
        Some(400 | 401 | 403 | 422) => Effect::Utterance,
        Some(402) => Effect::Cooldown(BreakScope::Voice, VOICE_COOLDOWN_SECS),
        Some(429) => Effect::Cooldown(BreakScope::Global, retry_after.filter(|s| *s > 0).unwrap_or(GLOBAL_COOLDOWN_SECS).min(MAX_COOLDOWN_SECS)),
        // 404 (one voice gone), 5xx (transient): fall back for this call only, keep trying.
        Some(_) => Effect::Nothing,
    }
}

#[derive(Debug, Clone)]
struct UttState {
    at: Instant,
    tripped: Option<Option<u16>>,
    announced: bool,
}

#[derive(Debug, Clone)]
struct Cooldown {
    until: Instant,
    status: u16,
    announced: bool,
}

#[derive(Debug, Default)]
pub(crate) struct TtsBreaker {
    utts: HashMap<String, UttState>,
    /// "*" (global) or "voice:<id>".
    cooldowns: HashMap<String, Cooldown>,
    /// No-id notices: reason → when last reported.
    recent: HashMap<String, Instant>,
}

fn secs_left(until: Instant, now: Instant) -> u64 {
    let d = until.saturating_duration_since(now);
    (d.as_secs() + u64::from(d.subsec_nanos() > 0)).max(1)
}

/// Drop the oldest entries until `map` fits under the cap.
fn cap_map<V>(map: &mut HashMap<String, V>, at: impl Fn(&V) -> Instant) {
    while map.len() > BREAKER_CAP {
        let Some(oldest) = map.iter().min_by_key(|(_, v)| at(v)).map(|(k, _)| k.clone()) else { break };
        map.remove(&oldest);
    }
}

impl TtsBreaker {
    fn voice_key(voice: &str) -> String {
        format!("voice:{voice}")
    }

    /// The active cooldown covering `voice` (global first), if any.
    fn cooldown_for(&self, voice: &str, now: Instant) -> Option<(String, &Cooldown)> {
        ["*".to_string(), Self::voice_key(voice)].into_iter().find_map(|k| {
            let c = self.cooldowns.get(&k).filter(|c| c.until > now)?;
            Some((k, c))
        })
    }

    fn prune(&mut self, now: Instant) {
        self.utts.retain(|_, u| now.saturating_duration_since(u.at) < BREAKER_TTL);
        self.cooldowns.retain(|_, c| c.until > now);
        self.recent.retain(|_, t| now.saturating_duration_since(*t) < EMIT_DEDUPE);
        cap_map(&mut self.utts, |u| u.at);
        cap_map(&mut self.cooldowns, |c| c.until);
        cap_map(&mut self.recent, |t| *t);
    }

    /// Should a call for `utt`/`voice` skip ElevenLabs right now?
    pub(crate) fn blocked(&self, utt: Option<&str>, voice: &str, now: Instant) -> Option<Block> {
        if let Some((k, c)) = self.cooldown_for(voice, now) {
            let scope = if k == "*" { BreakScope::Global } else { BreakScope::Voice };
            return Some(Block { scope, status: Some(c.status), remaining_secs: secs_left(c.until, now) });
        }
        let u = self.utts.get(utt?)?;
        let status = u.tripped?;
        (now.saturating_duration_since(u.at) < BREAKER_TTL).then_some(Block { scope: BreakScope::Utterance, status, remaining_secs: 0 })
    }

    /// Record a failed call. True only on a closed→open transition (this call tripped
    /// the utterance or started a cooldown); concurrent failures of the same utterance
    /// or inside an active cooldown return false. Check-and-insert happens under the
    /// caller's single lock, so exactly one of N parallel failures sees `true`.
    pub(crate) fn record_failure(&mut self, utt: Option<&str>, voice: &str, status: Option<u16>, retry_after: Option<u64>, now: Instant) -> bool {
        self.prune(now);
        let mut opened = false;
        let trip_utt = match effect_of(status, retry_after) {
            Effect::Nothing => false,
            Effect::Utterance => true,
            Effect::Cooldown(scope, secs) => {
                let key = if scope == BreakScope::Global { "*".to_string() } else { Self::voice_key(voice) };
                if !self.cooldowns.get(&key).is_some_and(|c| c.until > now) {
                    self.cooldowns.insert(key, Cooldown { until: now + Duration::from_secs(secs), status: status.unwrap_or_default(), announced: false });
                    opened = true;
                }
                true
            }
        };
        if let (true, Some(id)) = (trip_utt, utt) {
            let u = self.utts.entry(id.to_string()).or_insert(UttState { at: now, tripped: None, announced: false });
            if u.tripped.is_none() {
                u.tripped = Some(status);
                opened = true;
            }
        }
        cap_map(&mut self.utts, |u| u.at);
        cap_map(&mut self.cooldowns, |c| c.until);
        opened
    }

    /// Whether this live fallback (a failed call, or one skipped by the breaker) gets a
    /// `tts-fallback` event: once per cooldown window, else once per utterance, else
    /// (no id) once per `reason` per 10 s.
    pub(crate) fn announce(&mut self, utt: Option<&str>, voice: &str, status: Option<u16>, reason: &str, now: Instant) -> Option<Notice> {
        self.prune(now);
        let mut notice = None;
        let mut covered = false;
        if let Some((k, c)) = self.cooldown_for(voice, now).map(|(k, c)| (k, c.clone())) {
            covered = true;
            if !c.announced {
                if let Some(entry) = self.cooldowns.get_mut(&k) {
                    entry.announced = true;
                }
                let scope = if k == "*" { BreakScope::Global } else { BreakScope::Voice };
                notice = Some(Notice { scope: scope.as_str(), status: Some(c.status), cooldown_secs: Some(secs_left(c.until, now)) });
            }
        }
        if let Some(id) = utt {
            // Only a reply the breaker actually tripped (or a cooldown covers) is "on local for
            // this reply". A 404 / 5xx falls back for this one call and the next sentence tries
            // ElevenLabs again, so it gets a per-call notice and leaves the reply unannounced: a
            // later real trip of the same reply still gets its one line.
            let tripped = self.utts.get(id).is_some_and(|u| u.tripped.is_some());
            if covered || tripped {
                let u = self.utts.entry(id.to_string()).or_insert(UttState { at: now, tripped: None, announced: false });
                let first = !u.announced;
                u.announced = true;
                cap_map(&mut self.utts, |u| u.at);
                if covered || !first {
                    return notice;
                }
                return Some(Notice { scope: BreakScope::Utterance.as_str(), status, cooldown_secs: None });
            }
        } else if covered {
            return notice;
        }
        if self.recent.get(reason).is_some_and(|t| now.saturating_duration_since(*t) < EMIT_DEDUPE) {
            return None;
        }
        self.recent.insert(reason.to_string(), now);
        cap_map(&mut self.recent, |t| *t);
        Some(Notice { scope: "call", status, cooldown_secs: None })
    }
}

fn breaker() -> &'static Mutex<TtsBreaker> {
    static B: OnceLock<Mutex<TtsBreaker>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(TtsBreaker::default()))
}

fn with_breaker<T>(f: impl FnOnce(&mut TtsBreaker) -> T) -> T {
    let mut g = breaker().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut g)
}

/// A webview-supplied utterance id: 1–64 chars of `[A-Za-z0-9-]`, else `None`
/// (the call then uses the per-call path with the 10 s notice dedupe).
pub(crate) fn valid_utterance_id(id: Option<String>) -> Option<String> {
    id.filter(|s| (1..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// An opaque, stable tag for one voice id (the webview dedupes per-voice cooldown notices
/// by it). A hash, so the event never carries the voice id itself.
fn voice_tag(voice: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    voice.hash(&mut h);
    format!("v{:016x}", h.finish())
}

/// The `tts-fallback` event body. No key material: the reason is our own hint text
/// or ElevenLabs' `detail`, clipped. `cooldownKey` names the cooldown a notice is
/// about ("*" = global, a voice tag for a per-voice 402 pause), so two voices'
/// pauses are two notices.
fn fallback_payload(to: &str, reason: &str, n: &Notice, utt: Option<&str>, voice: &str) -> serde_json::Value {
    let cooldown_key = match n.scope {
        "global" => Some("*".to_string()),
        "voice" => Some(voice_tag(voice)),
        _ => None,
    };
    serde_json::json!({
        "from": "elevenlabs",
        "to": to,
        "reason": reason,
        "status": n.status,
        "utteranceId": utt,
        "cooldownSecs": n.cooldown_secs,
        "scope": n.scope,
        "cooldownKey": cooldown_key,
    })
}

/// A cached line (`pinId`) came back from a local engine instead of the configured cloud
/// voice: tell the webview not to keep that audio for the session.
fn emit_unpin(app: &tauri::AppHandle, pin: Option<&str>) {
    use tauri::Emitter;
    if let Some(id) = pin {
        let _ = app.emit("tts-unpin", serde_json::json!({ "pinId": id }));
    }
}

#[tauri::command]
pub async fn tts_synthesize(
    state: State<'_, DispatchState>,
    os: State<'_, super::os_core::OsState>,
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
    agent: Option<String>,
    // Part 6 §2: the sentence spoken immediately before this one in the same
    // reply, so ElevenLabs can keep prosody continuous across the
    // sentence-by-sentence calls the streaming pipeline makes. Ignored by
    // local engines (Kokoro/XTTS) and by previews/cue clips that don't pass it.
    previous_text: Option<String>,
    // P1: the reply this sentence belongs to (the TTS breaker's scope). Optional;
    // invalid ids are ignored (per-call behaviour with a deduped notice).
    utterance_id: Option<String>,
    // A `cache: true` line the webview keeps for the session. When a local engine answers it
    // instead of ElevenLabs (breaker cooldown, failure, kill switch), Rust emits `tts-unpin`
    // so that fallback audio plays once and is not pinned. Same id rules as `utterance_id`.
    pin_id: Option<String>,
    // Part 6 narration with `feedback.narrationEngine = "kokoro"`: speak on the local engine
    // (Kokoro) in this agent's local voice, sparing the ElevenLabs quota. Without a local TTS
    // provider the line takes the normal roster path instead.
    local_only: Option<bool>,
) -> Result<Response, String> {
    use tauri::Emitter;
    let _touch = super::compaction::Touch::start();
    let utt = valid_utterance_id(utterance_id);
    let pin = valid_utterance_id(pin_id);
    let text = text.trim();
    if !text_len_ok(text) {
        return Err("text must be 1–2000 characters".into());
    }
    // `explicit` is the caller's own `voice` argument (previews, cue clips) —
    // it keeps deciding whether a failed ElevenLabs call may fall back to a
    // local engine, exactly as before the roster existed. The roster below
    // only decides WHICH provider/voice/model a plain live reply uses.
    let explicit = voice.filter(|v| !v.is_empty());

    // Part 3: per-agent voice roster — that agent's entry, else Tony's
    // ("general"), else nothing (today's single `policy.tts` provider).
    let cfg = state.snapshot();
    let role = agent.as_deref().map(canon_role);
    let kokoro = cfg.providers.iter().any(|x| x.kind == Kind::Tts && x.engine.as_deref() == Some("kokoro"));
    let roster = roster_entry_for(&cfg.agent_voices, role.as_deref(), kokoro);
    // The local voice for this speaker on whichever local engine answers (fallbacks below).
    let local_voice = |local: &Provider| local_voice_for(role.as_deref(), &cfg.agent_voices, local.engine.as_deref(), local.voice.as_deref());
    if local_only == Some(true) && explicit.is_none() {
        if let Some(local) = cfg.providers.iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() != Some("elevenlabs")) {
            let bytes = synth_local(&state, local, text, local_voice(local)).await?;
            return Ok(Response::new(bytes));
        }
    }
    let (p, roster_voice, roster_model) = match &roster {
        Some(av) => match cfg.providers.iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() == Some(av.engine.as_str())).cloned() {
            Some(b) => (b, av.voice.clone(), av.model.clone()),
            // The roster names an engine with no matching provider configured:
            // fall back to the policy provider rather than erroring the whole turn.
            None => (tts_provider(&state)?, av.voice.clone(), av.model.clone()),
        },
        None => (tts_provider(&state)?, None, None),
    };

    // Kill switch / LOCAL ONLY: never send speech text to the cloud — speak locally.
    // Only the kill switch silences ElevenLabs. LOCAL ONLY is about where the *thinking*
    // runs — taking away the user's cloned voice there was a bug (fell back to Kokoro).
    let lockdown = os.snapshot().privacy.kill_switch;
    if p.engine.as_deref() == Some("elevenlabs") && lockdown {
        let local = state.snapshot().providers.into_iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() != Some("elevenlabs")).ok_or("kill switch on and no local TTS configured")?;
        let bytes = synth_local(&state, &local, text, local_voice(&local)).await?;
        emit_unpin(&app, pin.as_deref());
        return Ok(Response::new(bytes));
    }
    if p.engine.as_deref() == Some("elevenlabs") {
        let chosen = explicit.clone().or_else(|| roster_voice.clone()).or_else(|| p.voice.clone()).ok_or("pick an ElevenLabs voice in Settings → Voice")?;
        let model = roster_model.as_deref().filter(|m| !m.is_empty());
        let local_tts = || state.snapshot().providers.into_iter().find(|x| x.kind == Kind::Tts && x.engine.as_deref() != Some("elevenlabs"));

        // P1 breaker: this reply already failed, or ElevenLabs is paused (402/429).
        if let Some(block) = with_breaker(|b| b.blocked(utt.as_deref(), &chosen, Instant::now())) {
            // An explicit preview must never swap voices silently: say why instead.
            if explicit.is_some() {
                return Err(block.preview_error());
            }
            // Live: straight to local, no API call. A cooldown nobody was told about
            // yet (started by a preview) gets its one notice here.
            let local = local_tts().ok_or_else(|| block.preview_error())?;
            let bytes = synth_local(&state, &local, text, local_voice(&local)).await?;
            emit_unpin(&app, pin.as_deref());
            let reason = block.status.map(|c| format!("HTTP {c}")).unwrap_or_else(|| "unreachable".into());
            if let Some(n) = with_breaker(|b| b.announce(utt.as_deref(), &chosen, block.status, &reason, Instant::now())) {
                let _ = app.emit("tts-fallback", fallback_payload(&local.id, &reason, &n, utt.as_deref(), &chosen));
            }
            return Ok(Response::new(bytes));
        }

        match elevenlabs::synthesize(&state, &p, text, &chosen, model, previous_text.as_deref()).await {
            Ok(bytes) => return Ok(Response::new(bytes)),
            // Live speech (no explicit voice = a real reply, not a preview — a roster
            // voice counts as live here): fall back to local TTS so Jarvis still talks
            // when ElevenLabs is offline or out of quota.
            Err(e) if explicit.is_none() => {
                let now = Instant::now();
                with_breaker(|b| b.record_failure(utt.as_deref(), &chosen, e.status, e.retry_after, now));
                if let Some(local) = local_tts() {
                    if let Ok(bytes) = synth_local(&state, &local, text, local_voice(&local)).await {
                        emit_unpin(&app, pin.as_deref());
                        let reason = e.reason();
                        // Reported to the UI (not only stderr) so a silent voice swap is
                        // visible — once per reply / cooldown, not once per sentence.
                        if let Some(n) = with_breaker(|b| b.announce(utt.as_deref(), &chosen, e.status, &reason, Instant::now())) {
                            eprintln!("[tts] ElevenLabs failed ({e}); spoke with {} instead", local.label);
                            let _ = app.emit("tts-fallback", fallback_payload(&local.id, &reason, &n, utt.as_deref(), &chosen));
                        }
                        return Ok(Response::new(bytes));
                    }
                }
                return Err(e.to_string());
            }
            Err(e) => {
                // A preview's 402/429 still pauses live replies (same account/voice).
                with_breaker(|b| b.record_failure(utt.as_deref(), &chosen, e.status, e.retry_after, Instant::now()));
                return Err(e.to_string());
            }
        }
    }
    let bytes = synth_local(&state, &p, text, explicit.or(roster_voice)).await?;
    Ok(Response::new(bytes))
}

/// Kokoro / XTTS on this machine.
async fn synth_local(state: &DispatchState, p: &Provider, text: &str, voice: Option<String>) -> Result<Vec<u8>, String> {
    let key = state.key_for(p)?;
    let voice = voice.or_else(|| p.voice.clone()).unwrap_or_else(|| "af_bella".into());

    let mut rb = if p.engine.as_deref() == Some("xtts") {
        state.http.post(format!("{}/tts_to_audio/", origin(&p.base_url))).json(&serde_json::json!({
            "text": text,
            "speaker_wav": voice,
            "language": p.language.clone().unwrap_or_else(|| "en".into()),
        }))
    } else {
        state.http.post(format!("{}/audio/speech", p.base_url.trim_end_matches('/'))).json(&serde_json::json!({
            "model": p.model,
            "input": text,
            "voice": voice,
            "response_format": "mp3",
            "speed": 1.05,
        }))
    };
    rb = rb.timeout(Duration::from_secs(45));
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let bytes = rb.send().await.map_err(short)?.error_for_status().map_err(short)?.bytes().await.map_err(short)?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod stt_prompt_tests {
    use super::super::dispatch::{Config, DEFAULT_STT_PROMPT};
    use super::*;

    #[test]
    fn prompt_echo_is_dropped() {
        let p = DEFAULT_STT_PROMPT;
        assert!(echoes_prompt("Tony, Gabagool mode. Take it easy.", p));
        assert!(echoes_prompt("prompter designer coder booking desk", p));
        assert!(echoes_prompt("WhatsApp, Gmail, Spotify, Tauri", p));
        // Case/punctuation-insensitive and found mid-transcript.
        assert!(echoes_prompt("uh BOOKING-DESK, librarian and ops!", p));
    }

    #[test]
    fn short_real_phrases_pass() {
        let p = DEFAULT_STT_PROMPT;
        for ok in ["Cut it.", "cut it", "Take it easy.", "take it easy", "Take it ease.", "take it ease", "Whoa.", "madone", "aspetta", "Tony, cut it", "play Bilmuri on Spotify", "check my Gmail", "tell the Booking Desk to check WhatsApp", "take it easy on the bass"] {
            assert!(!echoes_prompt(ok, p), "{ok} must pass");
        }
        // P5: the stand-down said with its address words is a real line, never an echo (the prompt
        // keeps "Take it easy." as its own sentence, not after "Tony"/"Hey").
        for ok in ["Hey, take it easy", "Tony, take it easy", "Hey Tony, take it easy man", "hey take it easy"] {
            assert!(!echoes_prompt(ok, p), "{ok} must pass");
        }
        // Prompt words out of prompt order are a real sentence, not an echo.
        assert!(!echoes_prompt("Spotify Gmail WhatsApp Tauri", p));
        // An empty/short prompt never drops anything.
        assert!(!echoes_prompt("take it ease cut it", "cut it"));
    }

    /// Regression: ANY 4-word prompt run threw the whole transcript away — a long dictated idea
    /// that mentions "the booking desk, librarian and ops", or the reflex combo "Take it easy,
    /// cut it" (so the cut never fired).
    #[test]
    fn a_real_line_that_contains_a_prompt_run_is_kept() {
        let p = DEFAULT_STT_PROMPT;
        let idea = "I want a landing page with a hero, a pricing table and a signup form, and then loop in the booking desk, librarian and ops so they know it's coming. Make the colors warm.";
        assert!(!echoes_prompt(idea, p), "a long dictation is never dropped whole");
        for ok in ["Take it easy, cut it.", "take it easy cut it", "Hey Tony, take it easy, cut it", "Cut it, take it easy."] {
            assert!(!echoes_prompt(ok, p), "{ok} must pass");
        }
        // A read-back is still dropped.
        assert!(echoes_prompt("Tony, Gabagool mode. Take it easy. Cut it. Whoa.", p));
    }

    #[test]
    fn prompt_field_defaults_and_can_be_disabled() {
        let cfg = Config::default();
        let mut whisper = cfg.providers.iter().find(|p| p.kind == Kind::Stt).cloned().expect("default STT provider");
        assert_eq!(whisper.stt_prompt, None);
        assert_eq!(effective_stt_prompt(&whisper).as_deref(), Some(DEFAULT_STT_PROMPT));
        whisper.stt_prompt = Some("   ".into());
        assert_eq!(effective_stt_prompt(&whisper), None, "empty prompt = no prompt field");
        whisper.stt_prompt = Some(" Custom words. ".into());
        assert_eq!(effective_stt_prompt(&whisper).as_deref(), Some("Custom words."));
        // providers.json round trip: camelCase `sttPrompt`, omitted when unset.
        let json = serde_json::to_value(&whisper).unwrap();
        assert_eq!(json["sttPrompt"], " Custom words. ");
        whisper.stt_prompt = None;
        assert!(serde_json::to_value(&whisper).unwrap().get("sttPrompt").is_none());
        let back: Provider = serde_json::from_value(serde_json::json!({"id":"w","label":"W","kind":"stt","baseUrl":"http://x","model":"m","needsKey":false,"sttPrompt":"Hi there."})).unwrap();
        assert_eq!(back.stt_prompt.as_deref(), Some("Hi there."));
    }
}

#[cfg(test)]
mod part3_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn av(engine: &str, voice: &str) -> AgentVoice {
        AgentVoice { engine: engine.into(), voice: Some(voice.into()), model: None, auto_speak: false }
    }

    #[test]
    fn roster_entry_prefers_the_named_agent() {
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("elevenlabs", "tony-voice"));
        m.insert("booking".into(), av("kokoro", "booking-voice"));
        let got = roster_entry_for(&m, Some("booking"), true).unwrap();
        assert_eq!(got.voice.as_deref(), Some("booking-voice"));
    }

    #[test]
    fn roster_entry_falls_back_to_general() {
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("elevenlabs", "tony-voice"));
        // "coder" has no entry of its own and Kokoro isn't configured.
        let got = roster_entry_for(&m, Some("coder"), false).unwrap();
        assert_eq!(got.voice.as_deref(), Some("tony-voice"));
        // An unknown speaker always falls back to Tony.
        assert_eq!(roster_entry_for(&m, Some("overseer"), true).unwrap().voice.as_deref(), Some("tony-voice"));
    }

    #[test]
    fn roster_gaps_get_distinct_kokoro_defaults_at_runtime() {
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("elevenlabs", "tony-voice"));
        m.insert("booking".into(), av("elevenlabs", "booking-voice"));
        let ops = roster_entry_for(&m, Some("ops"), true).unwrap();
        let lib = roster_entry_for(&m, Some("librarian"), true).unwrap();
        assert_eq!((ops.engine.as_str(), ops.auto_speak), ("kokoro", false));
        assert_eq!(lib.engine, "kokoro");
        assert_ne!(ops.voice, lib.voice);
        // The user's own choices win, and Tony never gets a default.
        assert_eq!(roster_entry_for(&m, Some("booking"), true).unwrap().voice.as_deref(), Some("booking-voice"));
        assert_eq!(roster_entry_for(&m, Some("general"), true).unwrap().voice.as_deref(), Some("tony-voice"));
        // Every sub-agent default is distinct.
        let ids: std::collections::BTreeSet<_> = ["booking", "prompter", "coder", "designer", "director", "librarian", "ops", "verifier", "staging", "system"].iter().filter_map(|r| default_agent_voice(r)).collect();
        assert_eq!(ids.len(), 10);
        // An empty roster (per-agent voices never set up) still gives each agent its own
        // Kokoro default when Kokoro is configured (Part 6: the old `!is_empty()` guard is gone)…
        assert_eq!(roster_entry_for(&BTreeMap::new(), Some("ops"), true).unwrap().voice.as_deref(), Some("am_eric"));
        // …and the single policy voice without Kokoro.
        assert!(roster_entry_for(&BTreeMap::new(), Some("ops"), false).is_none());
    }

    #[test]
    fn local_voice_for_gives_every_narrator_a_distinct_voice_with_an_empty_roster() {
        // Part 6: the ElevenLabs fallback / kill switch / `localOnly` narration keep a distinct
        // voice per speaker (they used to collapse to the local provider's one voice).
        let empty: BTreeMap<String, AgentVoice> = BTreeMap::new();
        let voices: Vec<Option<String>> = super::super::dispatch::NARRATOR_IDS.iter().map(|r| local_voice_for(Some(r), &empty, Some("kokoro"), Some("af_bella"))).collect();
        assert!(voices.iter().all(Option::is_some), "{voices:?}");
        let distinct: std::collections::BTreeSet<_> = voices.iter().flatten().collect();
        assert_eq!(distinct.len(), super::super::dispatch::NARRATOR_IDS.len(), "{voices:?}");
        // Tony keeps the local provider's own voice.
        assert_eq!(local_voice_for(Some("general"), &empty, Some("kokoro"), Some("af_bella")).as_deref(), Some("af_bella"));
    }

    #[test]
    fn narrators_get_kokoro_defaults_but_tony_never_does() {
        for r in ["verifier", "staging", "system"] {
            assert!(default_agent_voice(r).is_some(), "{r}");
        }
        assert!(default_agent_voice("general").is_none());
        // With Kokoro configured and an empty roster, a worker narrator gets its own voice,
        // never Tony's (the old fallback made a verifier line sound exactly like him).
        let v = roster_entry_for(&BTreeMap::new(), Some("verifier"), true).unwrap();
        assert_eq!((v.engine.as_str(), v.voice.as_deref()), ("kokoro", Some("bm_lewis")));
    }

    #[test]
    fn local_voice_for_prefers_the_agents_own_kokoro_row() {
        let mut m = BTreeMap::new();
        m.insert("coder".into(), av("kokoro", "my-coder"));
        m.insert("designer".into(), av("elevenlabs", "eleven-designer"));
        assert_eq!(local_voice_for(Some("coder"), &m, Some("kokoro"), Some("af_bella")).as_deref(), Some("my-coder"));
        // An ElevenLabs voice id means nothing to Kokoro: the built-in default instead.
        assert_eq!(local_voice_for(Some("designer"), &m, Some("kokoro"), Some("af_bella")).as_deref(), Some("af_nicole"));
        // XTTS (or any non-Kokoro local engine) keeps its own voice.
        assert_eq!(local_voice_for(Some("coder"), &m, Some("xtts"), Some("speaker.wav")).as_deref(), Some("speaker.wav"));
        // No speaker named (a preview): the provider's voice.
        assert_eq!(local_voice_for(None, &m, Some("kokoro"), None), None);
        // Unknown speakers fall back to the provider's voice.
        assert_eq!(local_voice_for(Some("overseer"), &m, Some("kokoro"), Some("af_bella")).as_deref(), Some("af_bella"));
    }

    #[test]
    fn roster_entry_skips_the_roster_when_no_agent_is_named() {
        // A cue clip's own voice or a bare Settings preview never names a
        // speaker — the roster (including its "general" fallback) must not
        // kick in, so `policy.tts` keeps deciding exactly as before Part 3.
        let mut m = BTreeMap::new();
        m.insert("general".into(), av("kokoro", "tony-voice"));
        assert!(roster_entry_for(&m, None, true).is_none());
    }

    #[test]
    fn roster_entry_none_when_roster_is_empty() {
        let m: BTreeMap<String, AgentVoice> = BTreeMap::new();
        assert!(roster_entry_for(&m, Some("general"), true).is_none());
        assert!(roster_entry_for(&m, None, true).is_none());
    }

    #[test]
    fn text_len_counts_characters_not_bytes() {
        // Multi-byte text that is well under 2000 *characters* but would be
        // over 2000 *bytes* at a much shorter character count — the old
        // `.len()` (byte) check could reject a short, valid reply like this.
        let s: String = "é".repeat(1999); // 1999 chars, 3998 bytes
        assert!(text_len_ok(&s));
        assert!(!text_len_ok(""));
        assert!(!text_len_ok(&"x".repeat(2001)));
        assert!(text_len_ok(&"x".repeat(2000)));
    }
}

#[cfg(test)]
mod breaker_tests {
    use super::*;

    const V: &str = "QhEKgDl6KUJsO1FPiuSD";

    #[test]
    fn breaker_trips_once_per_utterance() {
        let mut b = TtsBreaker::default();
        let t0 = Instant::now();
        // N parallel sentences of one reply all 400: only the first is the transition.
        assert!(b.record_failure(Some("u1"), V, Some(400), None, t0));
        assert!(!b.record_failure(Some("u1"), V, Some(400), None, t0));
        assert!(!b.record_failure(Some("u1"), V, Some(401), None, t0));
        assert_eq!(b.blocked(Some("u1"), V, t0), Some(Block { scope: BreakScope::Utterance, status: Some(400), remaining_secs: 0 }));
        // Another reply (and a call with no id) still tries ElevenLabs.
        assert_eq!(b.blocked(Some("u2"), V, t0), None);
        assert_eq!(b.blocked(None, V, t0), None);
        // Exactly one notice for the reply, however many sentences fell back.
        let n = b.announce(Some("u1"), V, Some(400), "HTTP 400", t0).expect("first notice");
        assert_eq!(n, Notice { scope: "utterance", status: Some(400), cooldown_secs: None });
        for _ in 0..5 {
            assert_eq!(b.announce(Some("u1"), V, Some(400), "HTTP 400", t0), None);
        }
        assert!(b.announce(Some("u2"), V, Some(400), "HTTP 400", t0).is_some());
    }

    #[test]
    fn breaker_codes() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        // 400 / 401 / timeouts: this utterance only, no cooldown.
        for status in [Some(400), Some(401), None] {
            let mut b = TtsBreaker::default();
            assert!(b.record_failure(Some("u"), V, status, None, t0), "{status:?} trips");
            assert!(b.blocked(Some("u"), V, t0).is_some());
            assert_eq!(b.blocked(Some("other"), V, t0), None, "{status:?} must not cool down");
        }
        // 404 and 5xx don't trip at all.
        for status in [404, 500, 503] {
            let mut b = TtsBreaker::default();
            assert!(!b.record_failure(Some("u"), V, Some(status), None, t0), "{status}");
            assert_eq!(b.blocked(Some("u"), V, t0), None, "{status}");
        }
        // 402: this voice is paused 120 s for every reply; other voices are not.
        let mut b = TtsBreaker::default();
        assert!(b.record_failure(Some("u"), V, Some(402), None, t0));
        let blk = b.blocked(Some("new"), V, t0 + s(10)).expect("voice cooldown");
        assert_eq!((blk.scope, blk.status, blk.remaining_secs), (BreakScope::Voice, Some(402), 110));
        assert_eq!(b.blocked(Some("new"), "SomeOtherVoice12345", t0 + s(10)), None);
        assert_eq!(b.blocked(Some("new"), V, t0 + s(121)), None, "cooldown ends");
        // 429: global, honours Retry-After, default 30 s.
        let mut b = TtsBreaker::default();
        assert!(b.record_failure(None, V, Some(429), Some(60), t0));
        assert!(!b.record_failure(None, V, Some(429), Some(60), t0 + s(1)), "already open");
        let blk = b.blocked(None, "AnyVoiceAtAll12345", t0 + s(15)).expect("global cooldown");
        assert_eq!((blk.scope, blk.remaining_secs), (BreakScope::Global, 45));
        assert_eq!(b.blocked(None, V, t0 + s(61)), None);
        let mut b = TtsBreaker::default();
        b.record_failure(None, V, Some(429), None, t0);
        assert!(b.blocked(None, V, t0 + s(29)).is_some());
        assert!(b.blocked(None, V, t0 + s(31)).is_none());
        // A huge Retry-After is clamped.
        let mut b = TtsBreaker::default();
        b.record_failure(None, V, Some(429), Some(86_400), t0);
        assert!(b.blocked(None, V, t0 + s(MAX_COOLDOWN_SECS + 1)).is_none());
        // The preview message names the pause.
        let blk = Block { scope: BreakScope::Global, status: Some(429), remaining_secs: 12 };
        assert_eq!(blk.preview_error(), "ElevenLabs paused 12s (HTTP 429)");
    }

    #[test]
    fn breaker_cooldown_notice_once_per_window() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let mut b = TtsBreaker::default();
        b.record_failure(Some("a"), V, Some(429), Some(60), t0);
        let n = b.announce(Some("a"), V, Some(429), "HTTP 429", t0).unwrap();
        assert_eq!((n.scope, n.cooldown_secs), ("global", Some(60)));
        // Other replies inside the window (in flight or skipped): no further notice.
        assert_eq!(b.announce(Some("b"), V, Some(429), "HTTP 429", t0 + s(5)), None);
        assert_eq!(b.announce(None, V, Some(429), "HTTP 429", t0 + s(5)), None);
        // A new window after it ends gets a new notice.
        b.record_failure(Some("c"), V, Some(429), None, t0 + s(70));
        assert!(b.announce(Some("c"), V, Some(429), "HTTP 429", t0 + s(70)).is_some());
        // A cooldown a preview started (never announced) is announced by the first live skip.
        let mut b = TtsBreaker::default();
        b.record_failure(None, V, Some(402), None, t0);
        let n = b.announce(Some("live"), V, Some(402), "HTTP 402", t0 + s(1)).unwrap();
        assert_eq!((n.scope, n.cooldown_secs), ("voice", Some(119)));
        assert_eq!(b.announce(Some("live2"), V, Some(402), "HTTP 402", t0 + s(2)), None);
    }

    #[test]
    fn breaker_no_id_dedupes_by_reason() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let mut b = TtsBreaker::default();
        assert_eq!(b.announce(None, V, Some(400), "HTTP 400", t0).map(|n| n.scope), Some("call"));
        assert_eq!(b.announce(None, V, Some(400), "HTTP 400", t0 + s(9)), None);
        assert!(b.announce(None, V, None, "ElevenLabs timed out", t0 + s(9)).is_some(), "different reason");
        assert!(b.announce(None, V, Some(400), "HTTP 400", t0 + s(11)).is_some(), "window over");
    }

    #[test]
    fn breaker_prunes_and_caps() {
        let t0 = Instant::now();
        let mut b = TtsBreaker::default();
        for i in 0..200 {
            b.record_failure(Some(&format!("u{i}")), V, Some(400), None, t0 + Duration::from_millis(i));
            b.announce(None, V, Some(400), &format!("reason {i}"), t0 + Duration::from_millis(i));
        }
        assert!(b.utts.len() <= BREAKER_CAP, "{}", b.utts.len());
        assert!(b.recent.len() <= BREAKER_CAP);
        // The newest survive the cap, the oldest are evicted.
        assert!(b.blocked(Some("u199"), V, t0 + Duration::from_secs(1)).is_some());
        assert!(b.blocked(Some("u0"), V, t0 + Duration::from_secs(1)).is_none());
        // Everything is forgotten after 5 min.
        let later = t0 + BREAKER_TTL + Duration::from_secs(1);
        assert!(b.blocked(Some("u199"), V, later).is_none());
        b.record_failure(Some("fresh"), V, Some(500), None, later);
        assert!(b.utts.is_empty());
        assert!(b.recent.is_empty());
    }

    #[test]
    fn utterance_id_validation() {
        let ok = "3f2b9c1e-8a4d-4f6b-9c2d-1e5f7a8b9c0d-general";
        assert_eq!(valid_utterance_id(Some(ok.into())).as_deref(), Some(ok));
        assert_eq!(valid_utterance_id(Some("a".into())).as_deref(), Some("a"));
        assert_eq!(valid_utterance_id(Some("x".repeat(64))).map(|s| s.len()), Some(64));
        let long = "x".repeat(65);
        for bad in ["", long.as_str(), "has space", "under_score", "slash/../x", "\u{e9}moji", "semi;colon"] {
            assert_eq!(valid_utterance_id(Some(bad.to_string())), None, "{bad:?}");
        }
        assert_eq!(valid_utterance_id(None), None);
    }

    #[test]
    fn fallback_payload_shape() {
        let n = Notice { scope: "utterance", status: Some(400), cooldown_secs: None };
        let v = fallback_payload("kokoro", "HTTP 400 \u{b7} bad", &n, Some("u1"), V);
        assert_eq!(v["from"], "elevenlabs");
        assert_eq!(v["to"], "kokoro");
        assert_eq!(v["reason"], "HTTP 400 \u{b7} bad");
        assert_eq!(v["status"], 400);
        assert_eq!(v["utteranceId"], "u1");
        assert!(v["cooldownSecs"].is_null());
        assert_eq!(v["scope"], "utterance");
        assert!(v["cooldownKey"].is_null());
        assert_eq!(v.as_object().unwrap().len(), 8, "no extra fields (nothing key-shaped)");
    }

    #[test]
    fn fallback_payload_cooldown_key_is_per_voice_and_opaque() {
        // Fix pass: two voices' 402 pauses must be two webview notices, so the event names
        // which cooldown it is about, as a hash, never the voice id itself.
        let n = Notice { scope: "voice", status: Some(402), cooldown_secs: Some(120) };
        let a = fallback_payload("kokoro", "HTTP 402", &n, Some("u1"), V);
        let b = fallback_payload("kokoro", "HTTP 402", &n, Some("u2"), "AnotherVoiceId98765");
        let (ka, kb) = (a["cooldownKey"].as_str().unwrap(), b["cooldownKey"].as_str().unwrap());
        assert_ne!(ka, kb);
        assert_eq!(Some(ka), fallback_payload("kokoro", "HTTP 402", &n, None, V)["cooldownKey"].as_str(), "stable per voice");
        assert!(!a.to_string().contains(V), "voice id never in the payload");
        let g = Notice { scope: "global", status: Some(429), cooldown_secs: Some(30) };
        assert_eq!(fallback_payload("kokoro", "HTTP 429", &g, None, V)["cooldownKey"], "*");
    }

    #[test]
    fn non_tripping_failure_is_a_per_call_notice_not_the_reply() {
        // Fix pass: a 503 / 404 falls back for this call only (the next sentence tries
        // ElevenLabs again), so it must not announce "for this reply" or use up the reply's
        // one notice.
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let mut b = TtsBreaker::default();
        assert!(!b.record_failure(Some("u1"), V, Some(503), None, t0));
        let n = b.announce(Some("u1"), V, Some(503), "HTTP 503", t0).expect("a notice");
        assert_eq!(n.scope, "call");
        // Same reason within 10 s: deduped like any per-call notice.
        assert!(!b.record_failure(Some("u1"), V, Some(503), None, t0 + s(1)));
        assert_eq!(b.announce(Some("u1"), V, Some(503), "HTTP 503", t0 + s(1)), None);
        assert_eq!(b.blocked(Some("u1"), V, t0 + s(1)), None, "the reply is not tripped");
        // A later real trip of the same reply still gets its one "for this reply" notice.
        assert!(b.record_failure(Some("u1"), V, Some(400), None, t0 + s(2)));
        let n = b.announce(Some("u1"), V, Some(400), "HTTP 400", t0 + s(2)).expect("trip notice");
        assert_eq!(n, Notice { scope: "utterance", status: Some(400), cooldown_secs: None });
        assert_eq!(b.announce(Some("u1"), V, Some(400), "HTTP 400", t0 + s(3)), None);
    }
}

/// Phase 2 Part B: the hard mic gate at the Rust STT client (the only client of Whisper :8178).
/// A scripted local server counts every request that reaches it.
#[cfg(test)]
pub(crate) mod mic_gate_tests {
    use super::*;
    use crate::commands::allm::mock::{start, Resp};
    use std::sync::Arc;

    /// The tests here and in `audio::commands` share the global `MIC_ENABLED`: run them one at a time.
    pub(crate) static MIC_TEST_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
        MIC_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A DispatchState whose STT provider (the built-in "whisper") points at `base`. No path: nothing is written.
    fn state_at(base: &str) -> DispatchState {
        let st = DispatchState::default();
        st.update(|c| {
            c.policy.stt = "whisper".into();
            let p = c.providers.iter_mut().find(|p| p.id == "whisper").expect("built-in whisper provider");
            p.base_url = format!("{base}/v1");
            Ok(())
        })
        .expect("point whisper at the test server");
        st
    }

    fn wav() -> Vec<u8> {
        vec![0u8; 4096]
    }

    #[test]
    fn muted_mic_sends_zero_stt_requests() {
        let _g = lock();
        tauri::async_runtime::block_on(async {
            let srv = start(|_| Resp::json(serde_json::json!({ "text": "should never be heard" }))).await;
            let st = state_at(&srv.base);
            MIC_ENABLED.store(false, Ordering::SeqCst);
            let r = transcribe_bytes(&st, wav()).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            MIC_ENABLED.store(true, Ordering::SeqCst);
            assert_eq!(r, Err(MIC_DISABLED.to_string()));
            assert_eq!(srv.reqs().len(), 0, "a muted mic must never reach the Whisper server");
            // The refusal comes before validation too: even an empty clip is "mic disabled".
            MIC_ENABLED.store(false, Ordering::SeqCst);
            assert_eq!(transcribe_bytes(&st, vec![]).await, Err(MIC_DISABLED.to_string()));
            MIC_ENABLED.store(true, Ordering::SeqCst);
        });
    }

    #[test]
    fn live_mic_sends_exactly_one_request() {
        let _g = lock();
        tauri::async_runtime::block_on(async {
            let srv = start(|_| Resp::json(serde_json::json!({ "text": " hello tony " }))).await;
            let st = state_at(&srv.base);
            MIC_ENABLED.store(true, Ordering::SeqCst);
            let r = transcribe_bytes(&st, wav()).await;
            assert_eq!(r, Ok("hello tony".to_string()));
            assert_eq!(srv.count("POST", "/v1/audio/transcriptions"), 1);
            assert_eq!(srv.reqs().len(), 1);
        });
    }

    #[test]
    fn muting_mid_request_drops_the_transcript() {
        let _g = lock();
        tauri::async_runtime::block_on(async {
            let srv = start(|_| Resp::json(serde_json::json!({ "text": "heard before the mute" })).delayed(500)).await;
            let st = Arc::new(state_at(&srv.base));
            MIC_ENABLED.store(true, Ordering::SeqCst);
            let st2 = Arc::clone(&st);
            let job = tauri::async_runtime::spawn(async move { transcribe_bytes(&st2, wav()).await });
            // Wait until the request is at the server, then lock the mic while it "transcribes".
            for _ in 0..100 {
                if !srv.reqs().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(srv.reqs().len(), 1, "the request should be in flight");
            MIC_ENABLED.store(false, Ordering::SeqCst);
            let r = job.await.expect("join");
            MIC_ENABLED.store(true, Ordering::SeqCst);
            assert_eq!(r, Ok(String::new()));
        });
    }
}
