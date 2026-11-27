//! ElevenLabs text-to-speech: dynamic voice loading + synthesis with the
//! voice the user picked.
//!
//! REST, no SDK (there's no official Rust one): base `https://api.elevenlabs.io`,
//! key in the `xi-api-key` header.
//!
//! The API key is read at call time, never stored in config, never sent to
//! the webview and never logged. Resolution order:
//!   1. `ELEVENLABS_API_KEY` environment variable
//!   2. `ELEVENLABS_API_KEY=` line in the project's `.env` (written by
//!      `npx @elevenlabs/cli onboard`), i.e. `<repo>/.env`
//!   3. the OS keychain entry for the `elevenlabs` provider (Settings)

use futures_util::StreamExt;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

use super::dispatch::{DispatchState, Provider};
use super::secrets;

pub const ENV_KEY: &str = "ELEVENLABS_API_KEY";

/// Models offered in Settings (from ElevenLabs' TTS docs) when the live
/// `GET /v1/models` lookup (`list_models`) fails or the key is missing.
pub const MODELS: [&str; 6] = ["eleven_v4", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_flash_v2", "eleven_multilingual_v2", "eleven_v3"];

/// Models that accept the request-stitching extras: the `optimize_streaming_latency`
/// query parameter and the `previous_text` / `next_text` body fields. A strict,
/// case-insensitive ALLOWLIST: `eleven_v3` 400s on them (the live bug — every
/// sentence after the first carried `previous_text`, every call carried the latency
/// parameter), `eleven_v4*` 400s on the latency parameter, and an unknown or future
/// model gets the plain request, which every model accepts.
pub(crate) fn supports_stitching(model: &str) -> bool {
    const STITCHING: [&str; 3] = ["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"];
    let m = model.trim();
    STITCHING.iter().any(|s| s.eq_ignore_ascii_case(m))
}

/// The last `max` characters of `s` (ElevenLabs caps the context fields at 1000).
fn tail_chars(s: &str, max: usize) -> String {
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(max)).collect()
}

/// The `/stream` query string and JSON body for one TTS call. Pure (no key, no
/// network) so the exact request every caller sends — live replies, Settings
/// previews, cue clips, all of which go through `synthesize` — is unit-testable.
/// Stitching extras are only added for `supports_stitching` models; a blank
/// context string is never sent.
pub(crate) fn tts_request(model: &str, text: &str, language: Option<&str>, previous_text: Option<&str>, next_text: Option<&str>) -> (String, serde_json::Value) {
    let mut body = serde_json::json!({
        "text": text,
        "model_id": model,
        // Eleven v4 accepts only stability + similarity_boost.
        "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 },
    });
    if let Some(lang) = language.filter(|l| !l.is_empty() && !model.eq_ignore_ascii_case("eleven_multilingual_v2")) {
        body["language_code"] = lang.into();
    }
    let stitching = supports_stitching(model);
    if stitching {
        if let Some(prev) = previous_text.filter(|s| !s.trim().is_empty()) {
            body["previous_text"] = tail_chars(prev, 1000).into();
        }
        if let Some(next) = next_text.filter(|s| !s.trim().is_empty()) {
            body["next_text"] = next.chars().take(1000).collect::<String>().into();
        }
    }
    let query = if stitching { "output_format=mp3_44100_128&optimize_streaming_latency=3" } else { "output_format=mp3_44100_128" };
    (query.to_string(), body)
}

/// A failed `synthesize`, with the numeric status kept so the TTS breaker
/// (`voice.rs`) can tell a 400 from a 429. `Display` is the same human text the
/// old `String` error carried, so callers that only show it are unchanged.
/// Never contains key material: `message`/`detail` come from our own hints and
/// ElevenLabs' `detail` field only.
#[derive(Debug, Clone)]
pub struct ElevenError {
    /// HTTP status; `None` for transport failures and local config errors.
    pub status: Option<u16>,
    /// The full, actionable message (`explain()`'s hint + detail).
    pub message: String,
    /// ElevenLabs' own `detail` text (may be empty), for compact notices.
    pub detail: String,
    /// `Retry-After` in seconds, when the response carried a numeric one.
    pub retry_after: Option<u64>,
    /// The request timed out (no status).
    pub timeout: bool,
}

impl ElevenError {
    fn local(message: impl Into<String>) -> Self {
        Self { status: None, message: message.into(), detail: String::new(), retry_after: None, timeout: false }
    }

    /// Short reason for the `tts-fallback` notice: "HTTP 400 · <≤60 chars of detail>",
    /// or the message itself (≤60 chars) when there is no status.
    pub fn reason(&self) -> String {
        let clip = |s: &str| {
            let s = s.trim();
            if s.chars().count() > 60 {
                format!("{}…", s.chars().take(59).collect::<String>())
            } else {
                s.to_string()
            }
        };
        match self.status {
            Some(code) if self.detail.trim().is_empty() => format!("HTTP {code}"),
            Some(code) => format!("HTTP {code} · {}", clip(&self.detail)),
            None => clip(&self.message),
        }
    }
}

impl std::fmt::Display for ElevenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<ElevenError> for String {
    fn from(e: ElevenError) -> String {
        e.message
    }
}

/// `Retry-After` as whole seconds (the HTTP-date form is ignored).
fn retry_after_secs(res: &reqwest::Response) -> Option<u64> {
    res.headers().get(reqwest::header::RETRY_AFTER)?.to_str().ok()?.trim().parse::<u64>().ok()
}

pub use super::envfile::KeySource;

/// The key and where it came from. Never exposed beyond this crate.
pub(crate) fn api_key(state: &DispatchState, p: &Provider) -> (Option<String>, KeySource) {
    if let Some((v, src)) = super::envfile::env_or_file_src(state, ENV_KEY) {
        return (Some(v), src);
    }
    if let Some(v) = secrets::get(state, &p.id) {
        return (Some(v), KeySource::Keychain);
    }
    (None, KeySource::Missing)
}

pub(crate) fn valid_voice_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// ElevenLabs' REST host, pinned regardless of `p.base_url`. An env-var or
/// `.env` key (unlike the keychain, which is bound to provider@host — see
/// `api_key` above) is not scoped to a destination; `base_url` is editable
/// in Settings, so basing the request on it would let that edit redirect an
/// unscoped key to a different host. The key only ever goes to ElevenLabs.
fn base(_p: &Provider) -> String {
    "https://api.elevenlabs.io".to_string()
}

/// Turn an ElevenLabs error response into something a person can act on.
async fn explain(res: reqwest::Response) -> String {
    explain_detail(res).await.0
}

/// `explain`, plus ElevenLabs' raw `detail` text (for the compact fallback notice).
async fn explain_detail(res: reqwest::Response) -> (String, String) {
    let code = res.status().as_u16();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    let detail = body["detail"]["message"].as_str().or(body["detail"]["status"].as_str()).or(body["detail"].as_str()).unwrap_or("").to_string();
    (explain_text(code, &detail), detail)
}

fn explain_text(code: u16, detail: &str) -> String {
    let hint = match code {
        401 => "ElevenLabs rejected the API key — re-run `npx -y @elevenlabs/cli@latest onboard init`",
        402 => "this voice needs a paid ElevenLabs plan (cloned and Voice Library voices aren't available to free accounts via the API)",
        404 => "voice not found on this ElevenLabs account",
        422 => "ElevenLabs rejected the request (check the voice and model)",
        429 => "ElevenLabs quota or rate limit reached",
        _ => "ElevenLabs request failed",
    };
    if detail.is_empty() {
        format!("{hint} (HTTP {code})")
    } else {
        format!("{hint} (HTTP {code}: {})", detail.chars().take(160).collect::<String>())
    }
}

#[derive(Serialize)]
pub struct ElevenVoice {
    pub id: String,
    pub name: String,
    /// cloned | professional | generated | premade | …
    pub category: String,
}

/// Every voice on the account, cloned voices first.
pub async fn list_voices(state: &DispatchState, p: &Provider) -> Result<Vec<ElevenVoice>, String> {
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let res = state
        .http
        .get(format!("{}/v1/voices", base(p)))
        .header("xi-api-key", key)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut voices: Vec<ElevenVoice> = body["voices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some(ElevenVoice {
                id: v["voice_id"].as_str()?.to_string(),
                name: v["name"].as_str().unwrap_or("(unnamed)").to_string(),
                category: v["category"].as_str().unwrap_or("premade").to_string(),
            })
        })
        .collect();
    let rank = |c: &str| match c {
        "cloned" => 0,
        "professional" => 1,
        "generated" => 2,
        _ => 3,
    };
    voices.sort_by(|a, b| rank(&a.category).cmp(&rank(&b.category)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(voices)
}

/// Text-to-speech-capable model ids from a `GET /v1/models` body. Split out
/// from `list_models` so the JSON shape is unit-testable without a network call.
pub(crate) fn tts_models_from_body(body: &serde_json::Value) -> Vec<String> {
    body.as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["can_do_text_to_speech"].as_bool().unwrap_or(false))
        .filter_map(|m| m["model_id"].as_str().map(String::from))
        .collect()
}

/// Every model the account can use for TTS, fetched live. Callers fall back
/// to the static `MODELS` list on any error (no key, offline, empty result).
pub async fn list_models(state: &DispatchState, p: &Provider) -> Result<Vec<String>, String> {
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let res = state
        .http
        .get(format!("{}/v1/models", base(p)))
        .header("xi-api-key", key)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let ids = tts_models_from_body(&body);
    if ids.is_empty() {
        return Err("ElevenLabs reported no text-to-speech models".into());
    }
    Ok(ids)
}

/// Instant voice clone: upload a sample (mp3/wav/m4a/flac/ogg) → new voice ID on the account.
pub async fn add_voice(state: &DispatchState, p: &Provider, name: &str, file_name: &str, bytes: Vec<u8>) -> Result<String, String> {
    let (key, _) = api_key(state, p);
    let key = key.ok_or(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding"))?;
    let mime = match Path::new(file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "audio/mpeg",
    };
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name.to_string()).mime_str(mime).map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("name", name.to_string())
        .text("remove_background_noise", "true")
        .part("files", part);
    let res = state
        .http
        .post(format!("{}/v1/voices/add", base(p)))
        .header("xi-api-key", key)
        .multipart(form)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "ElevenLabs timed out".to_string() } else { "ElevenLabs unreachable".to_string() })?;
    if !res.status().is_success() {
        return Err(explain(res).await);
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    body["voice_id"].as_str().map(String::from).ok_or_else(|| "ElevenLabs didn't return a voice ID".into())
}

/// Speak `text` with `voice_id` (mp3). The voice is always the caller's choice.
/// `model_override` (Part 3: an agent's roster model) wins over `p.model` when
/// set. `previous_text` (Part 6 §2 — the sentence spoken immediately before
/// this one in the same reply, when there is one) is passed through so
/// prosody stays continuous across the sentence-by-sentence calls the
/// streaming sentence pipeline makes, instead of each sentence sounding like
/// the start of a new thought.
///
/// Uses ElevenLabs' `/stream` endpoint rather than the plain one: lower
/// time-to-first-byte, even though the bytes are still collected fully here
/// before returning (the webview needs a complete file for `decodeAudioData`).
/// `optimize_streaming_latency=3` and `previous_text` are only sent to models
/// that accept them (`supports_stitching`); see `tts_request`.
/// The voice queue's single lane: at most ONE ElevenLabs synthesis in flight at a time, across
/// every caller (live replies, prefetched sentences, agent reports, Language Hub). ElevenLabs
/// answers concurrent requests over the plan's limit with HTTP 429 even when credits are fine,
/// so the requests line up here instead (FIFO: tokio's semaphore is fair).
static LANE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// ElevenLabs 429s seen this run (shown in the log line; the file keeps the history).
static RATE_LIMITED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One `elevenlabs-429.jsonl` line: when, which voice / model, the Retry-After, how long the
/// request queued for the lane, the running count and ElevenLabs' own message. Pure.
pub fn rate_limit_line(at: &str, voice_id: &str, model: &str, retry_after: Option<u64>, queued_ms: u128, count: u64, message: &str) -> String {
    serde_json::json!({ "at": at, "voice": voice_id, "model": model, "retryAfter": retry_after, "queuedMs": queued_ms as u64, "count": count, "message": message }).to_string()
}

/// Log a 429: stderr always, plus a line in `<config>/telemetry/elevenlabs-429.jsonl` once
/// telemetry is initialised.
fn log_rate_limit(voice_id: &str, model: &str, retry_after: Option<u64>, queued_ms: u128, message: &str) {
    let count = RATE_LIMITED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let line = rate_limit_line(&chrono::Local::now().to_rfc3339(), voice_id, model, retry_after, queued_ms, count, message);
    eprintln!("[tts] ElevenLabs 429 #{count} (queued {queued_ms} ms, retry-after {retry_after:?}): {message}");
    if let Some(dir) = super::diagnostics::telemetry_dir().and_then(Path::parent) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("elevenlabs-429.jsonl")) {
            let _ = writeln!(f, "{line}");
        }
    }
}

pub async fn synthesize(state: &DispatchState, p: &Provider, text: &str, voice_id: &str, model_override: Option<&str>, previous_text: Option<&str>) -> Result<Vec<u8>, ElevenError> {
    let queued = std::time::Instant::now();
    // Held until the whole body is read: the stream is the request ElevenLabs counts.
    let _lane = LANE.acquire().await.map_err(|_| ElevenError::local("ElevenLabs voice queue closed"))?;
    let queued_ms = queued.elapsed().as_millis();
    if !valid_voice_id(voice_id) {
        return Err(ElevenError::local(format!("'{voice_id}' isn't an ElevenLabs voice ID — pick one in Settings → Voice")));
    }
    let (key, _) = api_key(state, p);
    let key = key.ok_or_else(|| ElevenError::local(format!("no ElevenLabs key — set {ENV_KEY} or run the ElevenLabs onboarding")))?;
    let model = model_override.filter(|m| !m.is_empty()).unwrap_or_else(|| if p.model.is_empty() || p.model == "-" { "eleven_v4" } else { p.model.as_str() });
    let (query, body) = tts_request(model, text, p.language.as_deref(), previous_text, None);
    let res = state
        .http
        .post(format!("{}/v1/text-to-speech/{voice_id}/stream?{query}", base(p)))
        .header("xi-api-key", key)
        .json(&body)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| {
            let timeout = e.is_timeout();
            ElevenError { timeout, ..ElevenError::local(if timeout { "ElevenLabs timed out" } else { "ElevenLabs unreachable" }) }
        })?;
    if !res.status().is_success() {
        // Status and Retry-After first: `explain_detail` consumes the response.
        let status = res.status().as_u16();
        let retry_after = retry_after_secs(&res);
        let (message, detail) = explain_detail(res).await;
        if status == 429 {
            log_rate_limit(voice_id, model, retry_after, queued_ms, &message);
        }
        return Err(ElevenError { status: Some(status), message, detail, retry_after, timeout: false });
    }
    let mut stream = res.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(|e| {
            let timeout = e.is_timeout();
            ElevenError { timeout, ..ElevenError::local(if timeout { "ElevenLabs timed out" } else { "ElevenLabs stream interrupted" }) }
        })?);
    }
    Ok(bytes)
}

#[cfg(test)]
mod lane_tests {
    use super::*;

    #[test]
    fn one_synthesis_at_a_time() {
        assert_eq!(LANE.available_permits(), 1);
    }

    #[test]
    fn rate_limit_line_is_one_json_object() {
        let l = rate_limit_line("2026-11-26T10:00:00-05:00", "abc", "eleven_turbo_v2_5", Some(30), 1200, 3, "too many concurrent requests");
        let v: serde_json::Value = serde_json::from_str(&l).unwrap();
        assert_eq!(v["retryAfter"], 30);
        assert_eq!(v["queuedMs"], 1200);
        assert_eq!(v["count"], 3);
        assert!(!l.contains('\n'));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_ids() {
        assert!(valid_voice_id("QhEKgDl6KUJsO1FPiuSD"));
        assert!(!valid_voice_id("am_michael"));
        assert!(!valid_voice_id("../../v1/user"));
    }

    #[test]
    fn stitching_allowlist() {
        // Stripped: v3 (the live 400s), every v4, and anything unknown.
        for m in ["eleven_v3", "ELEVEN_V3", "eleven_v4", "eleven_v4_conversational", "ELEVEN_V4", "eleven_flash_v2", "eleven_turbo_v2", "some_future_model", ""] {
            assert!(!supports_stitching(m), "{m} must not get stitching extras");
        }
        // Kept, case-insensitively.
        for m in ["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2", "ELEVEN_FLASH_V2_5", " eleven_turbo_v2_5 "] {
            assert!(supports_stitching(m), "{m} keeps stitching extras");
        }
    }

    #[test]
    fn tts_request_v3_strips_latency_and_context() {
        for model in ["eleven_v3", "eleven_v4", "mystery_model"] {
            let (q, body) = tts_request(model, "Second sentence.", Some("en"), Some("First sentence."), Some("Third sentence."));
            assert!(!q.contains("optimize_streaming_latency"), "{model}: {q}");
            assert_eq!(q, "output_format=mp3_44100_128");
            assert!(body.get("previous_text").is_none(), "{model}");
            assert!(body.get("next_text").is_none(), "{model}");
            assert_eq!(body["model_id"], model);
            assert_eq!(body["text"], "Second sentence.");
            assert_eq!(body["language_code"], "en");
            assert_eq!(body["voice_settings"]["stability"], 0.5);
        }
        // No language → no language_code.
        let (_, body) = tts_request("eleven_v3", "Hi.", None, None, None);
        assert!(body.get("language_code").is_none());
    }

    #[test]
    fn tts_request_turbo_keeps_latency_and_context() {
        let long = format!("{}END", "x".repeat(1500));
        for model in ["eleven_turbo_v2_5", "eleven_flash_v2_5"] {
            let (q, body) = tts_request(model, "Next.", Some("en"), Some(&long), Some("After."));
            assert!(q.contains("optimize_streaming_latency=3"), "{model}: {q}");
            let prev = body["previous_text"].as_str().unwrap();
            assert_eq!(prev.chars().count(), 1000, "keeps the LAST 1000 chars");
            assert!(prev.ends_with("END"));
            assert_eq!(body["next_text"], "After.");
            assert_eq!(body["language_code"], "en");
        }
        // Multilingual keeps stitching but never gets language_code.
        let (q, body) = tts_request("eleven_multilingual_v2", "Next.", Some("en"), Some("Before."), None);
        assert!(q.contains("optimize_streaming_latency=3"));
        assert_eq!(body["previous_text"], "Before.");
        assert!(body.get("language_code").is_none());
        assert!(body.get("next_text").is_none());
        // Blank context is never sent.
        let (_, body) = tts_request("eleven_turbo_v2_5", "Next.", None, Some("   "), Some(""));
        assert!(body.get("previous_text").is_none());
        assert!(body.get("next_text").is_none());
    }

    #[test]
    fn eleven_error_reason_is_compact() {
        let e = ElevenError { status: Some(400), message: explain_text(400, "bad"), detail: "bad".into(), retry_after: None, timeout: false };
        assert_eq!(e.reason(), "HTTP 400 · bad");
        assert_eq!(e.to_string(), "ElevenLabs request failed (HTTP 400: bad)");
        let long = ElevenError { detail: "d".repeat(200), ..e.clone() };
        assert!(long.reason().chars().count() <= 71);
        let bare = ElevenError { detail: String::new(), ..e };
        assert_eq!(bare.reason(), "HTTP 400");
        let t = ElevenError { timeout: true, ..ElevenError::local("ElevenLabs timed out") };
        assert_eq!(t.reason(), "ElevenLabs timed out");
        assert_eq!(String::from(t), "ElevenLabs timed out");
    }

    #[test]
    fn base_is_pinned_regardless_of_base_url() {
        let p = Provider { id: "elevenlabs".into(), label: "x".into(), kind: super::super::dispatch::Kind::Tts, base_url: "https://evil.example.com/v1".into(), model: "-".into(), needs_key: false, voice: None, engine: Some("elevenlabs".into()), language: None, models_dir: None, voices_dir: None, stt_prompt: None, custom: false };
        assert_eq!(base(&p), "https://api.elevenlabs.io");
    }

    #[test]
    fn tts_models_from_body_filters_by_capability() {
        let body = serde_json::json!([
            { "model_id": "eleven_v4", "can_do_text_to_speech": true },
            { "model_id": "eleven_turbo_v2_5", "can_do_text_to_speech": true },
            { "model_id": "scribe_v1", "can_do_text_to_speech": false },
            { "model_id": "no_flag_field" },
        ]);
        assert_eq!(tts_models_from_body(&body), vec!["eleven_v4".to_string(), "eleven_turbo_v2_5".to_string()]);
    }

    #[test]
    fn tts_models_from_body_handles_non_array() {
        assert_eq!(tts_models_from_body(&serde_json::json!({"error": "nope"})), Vec::<String>::new());
    }
}

/// `cargo test --lib live_tts_latency -- --ignored --nocapture` — v4 vs flash with the configured voice.
#[cfg(test)]
mod live_latency {
    use super::*;

    #[test]
    #[ignore]
    fn live_tts_latency() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let mut p = state.provider("elevenlabs").expect("elevenlabs provider");
            let voice = p.voice.clone().unwrap_or_default();
            for model in ["eleven_v4", "eleven_flash_v2_5"] {
                p.model = model.into();
                for _ in 0..2 {
                    let t0 = std::time::Instant::now();
                    let r = synthesize(&state, &p, "Yo, it's Tony. Weather's five degrees and overcast.", &voice, None, None).await;
                    println!("TTS {model}: {} ms ({})", t0.elapsed().as_millis(), r.map(|b| format!("{} KB", b.len() / 1024)).unwrap_or_else(|e| e.to_string()));
                }
            }
        });
    }
}

/// `cargo test --lib live_voice_info -- --ignored --nocapture` — which models each cloned voice supports.
#[cfg(test)]
mod live_voice_info {
    use super::*;

    #[test]
    #[ignore]
    fn live_voice_info() {
        tauri::async_runtime::block_on(async {
            let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
            let state = DispatchState::default();
            state.load_or_init(&dir);
            let p = state.provider("elevenlabs").unwrap();
            let (key, src) = api_key(&state, &p);
            println!("CONFIG voice={:?} model={} key_source={:?}", p.voice, p.model, src);
            let key = key.expect("key");
            let sub: serde_json::Value = state.http.get("https://api.elevenlabs.io/v1/user/subscription").header("xi-api-key", &key).send().await.unwrap().json().await.unwrap();
            println!("QUOTA tier={} used={} limit={} resets={}", sub["tier"], sub["character_count"], sub["character_limit"], sub["next_character_count_reset_unix"]);
            let v: serde_json::Value = state.http.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", &key).send().await.unwrap().json().await.unwrap();
            for vc in v["voices"].as_array().unwrap().iter().filter(|x| x["category"] != "premade") {
                println!(
                    "VOICE {} | {} | category={} | hq_models={} | fine_tuning={}",
                    vc["voice_id"].as_str().unwrap_or(""),
                    vc["name"].as_str().unwrap_or(""),
                    vc["category"],
                    vc["high_quality_base_model_ids"],
                    vc["fine_tuning"]["state"]
                );
            }
        });
    }
}
