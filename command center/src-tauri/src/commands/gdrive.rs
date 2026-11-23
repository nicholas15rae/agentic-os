//! Google Drive ⇄ Director Suite (docs/proposals/director-gdrive-plan.md, locked contract §3).
//!
//! - Auth is the installed-app flow: a loopback listener on `127.0.0.1:<random>`, PKCE S256 and a
//!   random `state`. Only the refresh token is stored (keychain id `gdrive-token`); access tokens
//!   live in memory and are refreshed on expiry or on a 401 (the request is retried once).
//!   The OAuth client is the `{clientId, clientSecret}` JSON Settings → Integrations → Google
//!   saves under keychain id `google`. Tokens, codes and secrets are never logged or returned.
//! - Pull streams a Drive file into `projects/<slug>/working/.uploads/<transfer>.part`, checks
//!   Drive's `sha256Checksum` when present, then lands it in `raw/` exactly like a local ingest.
//! - Push uploads a verified render only (a `render` row whose file is inside the projects root),
//!   resumable in 8 MiB chunks, resuming from the server's `Range` after a 5xx / network error.
//! - Share ("anyone with the link: viewer") only for a file this app pushed (a `drive_sync` push row).
//!
//! Push and share need `approved: true` from their confirm cards. Nothing is ever deleted on Drive.
//! HTTP goes through the `CloudProvider` seam; `GoogleDrive` keeps every base URL in a field so
//! the tests point it at a local mock server.

use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use super::dispatch::DispatchState;
use super::media::{self, MediaAsset, MediaState, VerifiedRender};
use super::os_core::OsState;
use super::secrets;

const PROVIDER: &str = "gdrive";
const CLIENT_KEY: &str = "google";
const TOKEN_KEY: &str = "gdrive-token";
const APP_TAG: &str = "agentic-os-director";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const SCOPES: &str = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const LIST_FIELDS: &str = "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,videoMediaMetadata,imageMediaMetadata,appProperties)";
const META_FIELDS: &str = "id,name,mimeType,size,sha256Checksum,trashed";
const TRANSFER_EVENT: &str = "cloud-transfer";
const STATUS_EVENT: &str = "cloud-status";
const MAX_PULL_FILES: usize = 20;
const MAX_PULL_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const UPLOAD_CHUNK: u64 = 8 * 1024 * 1024;
const MAX_RETRIES: u32 = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
const JSON_TIMEOUT: Duration = Duration::from_secs(30);
const EMIT_EVERY: Duration = Duration::from_millis(500);
const KEEP_FINISHED: usize = 20;

const NOT_CONNECTED: &str = "Google Drive isn't connected — press Connect Google Drive";
const NO_CLIENT: &str = "add your Google OAuth client in Settings → Integrations → Google first";
const REAUTH: &str = "Google Drive sign-in expired or was revoked — connect again";
const KILL_SWITCH: &str = "kill switch is on — Google Drive is a cloud service";
const CANCELLED: &str = "cancelled";

// ── Contract types (camelCase on the wire, as contract.ts) ─────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudFolderRef {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub provider: String,
    pub client_configured: bool,
    pub connected: bool,
    pub account: Option<String>,
    pub inbox_folder: Option<CloudFolderRef>,
    pub outbox_folder: Option<CloudFolderRef>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub mime_type: String,
    pub size_bytes: Option<u64>,
    pub duration_sec: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub modified_at: String,
    pub web_view_link: Option<String>,
    pub owned_by_app: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudListing {
    pub folder: CloudFolderRef,
    pub parents: Vec<CloudFolderRef>,
    pub items: Vec<CloudItem>,
    pub next_page_token: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drive_file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_view_link: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudTransfer {
    pub id: String,
    pub provider: String,
    pub direction: String,
    pub name: String,
    pub project: String,
    pub status: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub error: Option<String>,
    pub result: Option<TransferResult>,
    pub started_at: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncRecord {
    pub id: String,
    pub provider: String,
    pub direction: String,
    pub project: String,
    pub local_path: String,
    pub drive_file_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub web_view_link: Option<String>,
    pub at: String,
}

// ── Validation ─────────────────────────────────────────────────────────────────

fn check_provider(p: &str) -> Result<(), String> {
    if p == PROVIDER {
        Ok(())
    } else {
        Err(format!("unsupported cloud provider {p:?} (only \"gdrive\")"))
    }
}

/// Drive file / folder ids: `[A-Za-z0-9_-]{1,200}` (also admits the `root` alias).
pub(crate) fn valid_drive_id(id: &str) -> bool {
    (1..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A value inside a single-quoted Drive query string.
pub(crate) fn escape_q(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// The `q` for files.list: children of `folder` (not trashed), optionally filtered by name.
pub(crate) fn list_query(folder: &str, query: Option<&str>) -> Result<String, String> {
    if !valid_drive_id(folder) {
        return Err("bad Drive folder id".into());
    }
    let mut q = format!("'{folder}' in parents and trashed=false");
    if let Some(s) = query.map(str::trim).filter(|s| !s.is_empty()) {
        if s.chars().count() > 200 || s.chars().any(char::is_control) {
            return Err("search text must be up to 200 characters".into());
        }
        q.push_str(&format!(" and name contains '{}'", escape_q(s)));
    }
    Ok(q)
}

fn valid_page_token(t: &str) -> bool {
    !t.is_empty() && t.len() <= 2048 && t.bytes().all(|b| b.is_ascii_graphic())
}

pub(crate) fn kind_of(mime: &str) -> &'static str {
    if mime == FOLDER_MIME {
        "folder"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("audio/") {
        "audio"
    } else {
        "other"
    }
}

fn num(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.parse().ok())
}

pub(crate) fn item_from(v: &Value) -> CloudItem {
    let mime = v["mimeType"].as_str().unwrap_or("").to_string();
    let vm = &v["videoMediaMetadata"];
    let im = &v["imageMediaMetadata"];
    let dim = |k: &str| num(&vm[k]).or_else(|| num(&im[k])).map(|x| x as u32);
    CloudItem {
        id: v["id"].as_str().unwrap_or("").into(),
        name: v["name"].as_str().unwrap_or("").into(),
        kind: kind_of(&mime).into(),
        size_bytes: num(&v["size"]),
        duration_sec: num(&vm["durationMillis"]).map(|ms| ms as f64 / 1000.0),
        width: dim("width"),
        height: dim("height"),
        modified_at: v["modifiedTime"].as_str().unwrap_or("").into(),
        web_view_link: v["webViewLink"].as_str().map(String::from),
        owned_by_app: v["appProperties"]["createdBy"].as_str() == Some(APP_TAG),
        mime_type: mime,
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn net_err(e: reqwest::Error) -> String {
    // `without_url`: URLs never carry secrets here, but keep error text minimal anyway.
    format!("Google Drive unreachable: {}", e.without_url())
}

/// A Drive / OAuth error body → a short message (never echoes request data).
fn api_error(status: u16, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let msg: String = v["error"]["message"].as_str().or_else(|| v["error_description"].as_str()).or_else(|| v["error"].as_str()).unwrap_or("").chars().take(300).collect();
    if msg.is_empty() {
        format!("Google Drive answered HTTP {status}")
    } else {
        format!("Google Drive answered HTTP {status}: {msg}")
    }
}

async fn json_of(r: reqwest::Response) -> Result<Value, String> {
    let status = r.status().as_u16();
    let text = r.text().await.map_err(net_err)?;
    if !(200..300).contains(&status) {
        return Err(api_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|_| format!("Google Drive sent an unreadable reply (HTTP {status})"))
}

// ── OAuth client / token storage ───────────────────────────────────────────────

#[derive(Clone, Debug)]
pub(crate) struct OAuthClient {
    pub id: String,
    pub secret: String,
}

/// The `{clientId, clientSecret}` JSON from Settings → Integrations → Google.
pub(crate) fn parse_client(json_text: &str) -> Option<OAuthClient> {
    let v: Value = serde_json::from_str(json_text).ok()?;
    let id = v["clientId"].as_str()?.trim().to_string();
    let secret = v["clientSecret"].as_str()?.trim().to_string();
    (!id.is_empty() && !secret.is_empty()).then_some(OAuthClient { id, secret })
}

/// Where the refresh token lives (keychain in the app, memory in tests).
pub(crate) trait TokenStore: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, v: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

struct AppKeychain(tauri::AppHandle);

impl TokenStore for AppKeychain {
    fn get(&self) -> Option<String> {
        secrets::get(&self.0.state::<DispatchState>(), TOKEN_KEY)
    }
    fn set(&self, v: &str) -> Result<(), String> {
        secrets::set(&self.0.state::<DispatchState>(), TOKEN_KEY, v)
    }
    fn delete(&self) -> Result<(), String> {
        secrets::delete(&self.0.state::<DispatchState>(), TOKEN_KEY)
    }
}

pub(crate) struct Access {
    token: String,
    expires: Instant,
}

#[derive(Debug, PartialEq)]
pub(crate) struct TokenReply {
    pub access: String,
    pub expires_in: u64,
    pub refresh: Option<String>,
}

pub(crate) fn parse_token_reply(status: u16, body: &str) -> Result<TokenReply, String> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let err = v["error"].as_str().unwrap_or("");
        if err == "invalid_grant" {
            return Err(REAUTH.into());
        }
        let code: String = err.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect();
        return Err(format!("Google sign-in failed (HTTP {status}{}{code})", if code.is_empty() { "" } else { ", " }));
    }
    let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("Google sent no access token")?.to_string();
    Ok(TokenReply { access, expires_in: v["expires_in"].as_u64().unwrap_or(3600), refresh: v["refresh_token"].as_str().filter(|s| !s.is_empty()).map(String::from) })
}

// ── PKCE / authorize URL / loopback ────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; N];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b
}

/// 64 characters from the RFC 7636 unreserved set (`A-Z a-z 0-9 - _`, unbiased: 64 symbols).
pub(crate) fn random_verifier() -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    random_bytes::<64>().iter().map(|b| A[(b & 63) as usize] as char).collect()
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn auth_url(base: &str, client_id: &str, redirect: &str, challenge: &str, state: &str) -> Result<String, String> {
    url::Url::parse_with_params(
        base,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map(|u| u.to_string())
    .map_err(|e| format!("bad Google auth URL: {e}"))
}

#[derive(Debug, PartialEq)]
enum Callback {
    Code { code: String, state: String },
    Denied { error: String, state: String },
    Other,
}

fn parse_callback(head: &str) -> Callback {
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else { return Callback::Other };
    let Ok(u) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Other };
    if u.path() != "/" {
        return Callback::Other;
    }
    let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty());
    let state = get("state").unwrap_or_default();
    match (get("code"), get("error")) {
        (Some(code), _) => Callback::Code { code, state },
        (None, Some(error)) => Callback::Denied { error, state },
        _ => Callback::Other,
    }
}

fn html_reply(status: &str, message: &str) -> String {
    let body = format!("<!doctype html><meta charset=\"utf-8\"><title>Google Drive</title><body style=\"font-family:system-ui;background:#0b0d11;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0\"><p>{message}</p></body>");
    format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}", body.len())
}

/// Serve the loopback redirect until the request carrying `expected` state arrives.
async fn wait_for_code(listener: tokio::net::TcpListener, expected: &str) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| format!("Google sign-in listener failed: {e}"))?;
        let mut buf = Vec::with_capacity(2048);
        let read = tokio::time::timeout(Duration::from_secs(5), async {
            let mut chunk = [0u8; 2048];
            while buf.len() < 8192 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
        })
        .await;
        if read.is_err() {
            continue;
        }
        let (reply, outcome) = match parse_callback(&String::from_utf8_lossy(&buf)) {
            Callback::Code { code, state } if state == expected => (html_reply("200 OK", "Google Drive connected — you can close this tab."), Some(Ok(code))),
            Callback::Denied { error, state } if state == expected => {
                let msg = if error == "access_denied" { "Google Drive sign-in was cancelled".to_string() } else { format!("Google Drive sign-in failed ({})", error.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect::<String>()) };
                (html_reply("200 OK", "Google Drive wasn't connected — you can close this tab."), Some(Err(msg)))
            }
            Callback::Code { .. } | Callback::Denied { .. } => (html_reply("400 Bad Request", "This sign-in link is stale — press Connect again."), None),
            Callback::Other => (html_reply("404 Not Found", "Not found."), None),
        };
        let _ = sock.write_all(reply.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(o) = outcome {
            return o;
        }
    }
}

// ── Provider seam ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FileMeta {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<u64>,
    pub sha256: Option<String>,
    pub trashed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Downloaded {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Uploaded {
    pub id: String,
    pub web_view_link: Option<String>,
    pub sha256: Option<String>,
    pub local_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct UploadMeta {
    pub name: String,
    pub parent: Option<String>,
    pub project: String,
    pub render_id: String,
    pub mime: String,
}

/// Cancel flag + progress callback for one transfer.
#[derive(Clone)]
pub(crate) struct Ctl {
    pub cancel: Arc<AtomicBool>,
    pub progress: Arc<dyn Fn(u64) + Send + Sync>,
}

impl Ctl {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// One cloud storage backend. The UI only speaks the `cloud_*` commands; a second provider
/// (Dropbox) implements this and is selected by the `provider` argument.
pub(crate) trait CloudProvider: Send + Sync {
    /// Signed-in account (e-mail).
    fn about(&self) -> impl Future<Output = Result<String, String>> + Send;
    fn list(&self, folder: Option<&str>, query: Option<&str>, page: Option<&str>) -> impl Future<Output = Result<CloudListing, String>> + Send;
    fn file_meta(&self, id: &str) -> impl Future<Output = Result<FileMeta, String>> + Send;
    fn download(&self, id: &str, part: &Path, ctl: &Ctl) -> impl Future<Output = Result<Downloaded, String>> + Send;
    fn upload_resumable(&self, local: &Path, meta: &UploadMeta, ctl: &Ctl) -> impl Future<Output = Result<Uploaded, String>> + Send;
    /// "Anyone with the link: viewer"; returns the web link.
    fn share(&self, id: &str) -> impl Future<Output = Result<String, String>> + Send;
}

#[derive(Clone, Debug)]
pub(crate) struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
    pub api: String,
    pub upload: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            api: "https://www.googleapis.com/drive/v3".into(),
            upload: "https://www.googleapis.com/upload/drive/v3".into(),
        }
    }
}

pub(crate) struct GoogleDrive {
    pub ep: Endpoints,
    pub http: reqwest::Client,
    pub client: OAuthClient,
    pub store: Arc<dyn TokenStore>,
    pub access: Arc<Mutex<Option<Access>>>,
    /// Upload chunk size (8 MiB; Google wants multiples of 256 KiB).
    pub chunk: u64,
    /// First retry backoff; doubles per consecutive failure.
    pub retry_base_ms: u64,
}

enum Step {
    Continue(u64),
    Done(Value),
}

enum PutErr {
    Retry(String),
    Fatal(String),
}

/// `Range: bytes=0-N` → the next offset (N + 1); no header → 0.
pub(crate) fn next_offset(range: Option<&str>) -> u64 {
    range.and_then(|r| r.trim().strip_prefix("bytes=")).and_then(|r| r.split('-').nth(1)).and_then(|n| n.trim().parse::<u64>().ok()).map(|n| n + 1).unwrap_or(0)
}

fn same_origin(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default(),
        _ => false,
    }
}

async fn revoke_token(http: &reqwest::Client, url: &str, token: &str) {
    let _ = http.post(url).form(&[("token", token)]).timeout(Duration::from_secs(10)).send().await;
}

impl GoogleDrive {
    fn cached(&self) -> Option<String> {
        let g = self.access.lock().unwrap();
        g.as_ref().filter(|a| a.expires > Instant::now() + Duration::from_secs(30)).map(|a| a.token.clone())
    }

    fn remember(&self, r: &TokenReply) {
        *self.access.lock().unwrap() = Some(Access { token: r.access.clone(), expires: Instant::now() + Duration::from_secs(r.expires_in.max(60)) });
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenReply, String> {
        let r = self.http.post(&self.ep.token).form(form).timeout(JSON_TIMEOUT).send().await.map_err(net_err)?;
        let status = r.status().as_u16();
        let body = r.text().await.map_err(net_err)?;
        parse_token_reply(status, &body)
    }

    /// A usable access token: the cached one, or a fresh one from the refresh token.
    pub(crate) async fn token(&self, force: bool) -> Result<String, String> {
        if !force {
            if let Some(t) = self.cached() {
                return Ok(t);
            }
        }
        let refresh = self.store.get().ok_or(NOT_CONNECTED)?;
        let r = self.token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &self.client.id), ("client_secret", &self.client.secret)]).await?;
        if let Some(new_refresh) = &r.refresh {
            if *new_refresh != refresh {
                self.store.set(new_refresh)?;
            }
        }
        self.remember(&r);
        Ok(r.access)
    }

    /// Authorization code → tokens. Stores ONLY the refresh token; the access token stays in memory.
    pub(crate) async fn exchange_code(&self, code: &str, verifier: &str, redirect: &str) -> Result<(), String> {
        let r = self
            .token_request(&[("grant_type", "authorization_code"), ("code", code), ("code_verifier", verifier), ("redirect_uri", redirect), ("client_id", &self.client.id), ("client_secret", &self.client.secret)])
            .await?;
        let refresh = r.refresh.clone().ok_or("Google returned no refresh token — remove the app at myaccount.google.com/permissions and connect again")?;
        self.store.set(&refresh)?;
        self.remember(&r);
        Ok(())
    }

    /// Send with a bearer token; on 401 refresh once and retry.
    async fn authed(&self, build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
        let t = self.token(false).await?;
        let r = build(&self.http).bearer_auth(&t).send().await.map_err(net_err)?;
        if r.status().as_u16() != 401 {
            return Ok(r);
        }
        let t = self.token(true).await?;
        build(&self.http).bearer_auth(&t).send().await.map_err(net_err)
    }

    async fn get_json(&self, url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        json_of(self.authed(|h| h.get(url).query(query).timeout(JSON_TIMEOUT)).await?).await
    }

    async fn folder_ref(&self, id: &str) -> Result<(CloudFolderRef, Option<String>, String), String> {
        let v = self.get_json(&format!("{}/files/{id}", self.ep.api), &[("fields", "id,name,mimeType,parents")]).await?;
        let parent = v["parents"][0].as_str().filter(|p| valid_drive_id(p)).map(String::from);
        Ok((CloudFolderRef { id: v["id"].as_str().unwrap_or(id).into(), name: v["name"].as_str().unwrap_or("").into() }, parent, v["mimeType"].as_str().unwrap_or("").into()))
    }

    async fn put_chunk(&self, session: &str, buf: Vec<u8>, range: String) -> Result<Step, PutErr> {
        let r = self.authed(|h| h.put(session).header(reqwest::header::CONTENT_RANGE, range.clone()).body(buf.clone()).timeout(Duration::from_secs(300))).await;
        Self::step(r).await
    }

    async fn query_offset(&self, session: &str, total: u64) -> Result<Step, PutErr> {
        let r = self.authed(|h| h.put(session).header(reqwest::header::CONTENT_RANGE, format!("bytes */{total}")).body(Vec::new()).timeout(JSON_TIMEOUT)).await;
        Self::step(r).await
    }

    async fn step(r: Result<reqwest::Response, String>) -> Result<Step, PutErr> {
        let r = match r {
            Ok(r) => r,
            Err(e) if e == NOT_CONNECTED || e == REAUTH || e.starts_with("Google sign-in failed") => return Err(PutErr::Fatal(e)),
            Err(e) => return Err(PutErr::Retry(e)),
        };
        let status = r.status().as_u16();
        match status {
            200 | 201 => json_of(r).await.map(Step::Done).map_err(PutErr::Retry),
            308 => Ok(Step::Continue(next_offset(r.headers().get(reqwest::header::RANGE).and_then(|v| v.to_str().ok())))),
            404 | 410 => Err(PutErr::Fatal("the Drive upload session expired — upload again".into())),
            500..=599 => Err(PutErr::Retry(format!("Google Drive answered HTTP {status}"))),
            _ => {
                let body = r.text().await.unwrap_or_default();
                Err(PutErr::Fatal(api_error(status, &body)))
            }
        }
    }
}

fn read_range(f: &mut std::fs::File, from: u64, to: u64) -> Result<Vec<u8>, String> {
    f.seek(SeekFrom::Start(from)).map_err(|e| format!("read render: {e}"))?;
    let mut buf = vec![0u8; (to - from) as usize];
    f.read_exact(&mut buf).map_err(|e| format!("read render: {e}"))?;
    Ok(buf)
}

impl CloudProvider for GoogleDrive {
    async fn about(&self) -> Result<String, String> {
        let v = self.get_json(&format!("{}/about", self.ep.api), &[("fields", "user(emailAddress)")]).await?;
        v["user"]["emailAddress"].as_str().map(String::from).ok_or_else(|| "Google Drive did not say which account is signed in".into())
    }

    async fn list(&self, folder: Option<&str>, query: Option<&str>, page: Option<&str>) -> Result<CloudListing, String> {
        let parent = folder.unwrap_or("root");
        let q = list_query(parent, query)?;
        if let Some(p) = page {
            if !valid_page_token(p) {
                return Err("bad page token".into());
            }
        }
        // Folder + breadcrumb first, so a non-folder id fails before listing.
        let (folder, parents) = match folder {
            None => (CloudFolderRef { id: "root".into(), name: "My Drive".into() }, vec![]),
            Some(id) => {
                let (me, mut next, mime) = self.folder_ref(id).await?;
                if mime != FOLDER_MIME {
                    return Err("that Drive item is not a folder".into());
                }
                let mut parents = vec![];
                for _ in 0..10 {
                    let Some(pid) = next.take() else { break };
                    let (p, up, _) = self.folder_ref(&pid).await?;
                    parents.push(p);
                    next = up;
                }
                parents.reverse();
                // My Drive's real id → the `root` alias the UI uses (folderId null = root).
                if parents.first().is_some() {
                    let (root, _, _) = self.folder_ref("root").await?;
                    if parents[0].id == root.id {
                        parents[0] = CloudFolderRef { id: "root".into(), name: "My Drive".into() };
                    }
                }
                (me, parents)
            }
        };
        let mut params: Vec<(&str, &str)> = vec![("q", &q), ("fields", LIST_FIELDS), ("pageSize", "100"), ("orderBy", "folder,modifiedTime desc")];
        if let Some(p) = page {
            params.push(("pageToken", p));
        }
        let v = self.get_json(&format!("{}/files", self.ep.api), &params).await?;
        let items = v["files"].as_array().map(|a| a.iter().map(item_from).collect()).unwrap_or_default();
        let next_page_token = v["nextPageToken"].as_str().map(String::from);
        Ok(CloudListing { folder, parents, items, next_page_token })
    }

    async fn file_meta(&self, id: &str) -> Result<FileMeta, String> {
        if !valid_drive_id(id) {
            return Err("bad Drive file id".into());
        }
        let v = self.get_json(&format!("{}/files/{id}", self.ep.api), &[("fields", META_FIELDS)]).await?;
        Ok(FileMeta {
            id: v["id"].as_str().unwrap_or(id).into(),
            name: v["name"].as_str().unwrap_or("").into(),
            mime_type: v["mimeType"].as_str().unwrap_or("").into(),
            size: num(&v["size"]),
            sha256: v["sha256Checksum"].as_str().filter(|s| !s.is_empty()).map(String::from),
            trashed: v["trashed"].as_bool().unwrap_or(false),
        })
    }

    async fn download(&self, id: &str, part: &Path, ctl: &Ctl) -> Result<Downloaded, String> {
        if !valid_drive_id(id) {
            return Err("bad Drive file id".into());
        }
        let url = format!("{}/files/{id}", self.ep.api);
        let r = self.authed(|h| h.get(&url).query(&[("alt", "media")])).await?;
        let status = r.status().as_u16();
        if !(200..300).contains(&status) {
            let body = r.text().await.unwrap_or_default();
            return Err(api_error(status, &body));
        }
        let file = std::fs::File::create(part).map_err(|e| format!("create {}: {e}", part.display()))?;
        let mut out = std::io::BufWriter::with_capacity(1 << 20, file);
        let mut hasher = Sha256::new();
        let mut n = 0u64;
        let mut stream = r.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if ctl.cancelled() {
                return Err(CANCELLED.into());
            }
            let c = chunk.map_err(net_err)?;
            n += c.len() as u64;
            if n > MAX_PULL_BYTES {
                return Err("the Drive file is larger than 20 GB".into());
            }
            out.write_all(&c).map_err(|e| format!("write {}: {e}", part.display()))?;
            hasher.update(&c);
            (ctl.progress)(n);
        }
        out.flush().map_err(|e| format!("write {}: {e}", part.display()))?;
        Ok(Downloaded { bytes: n, sha256: hex(&hasher.finalize()) })
    }

    async fn upload_resumable(&self, local: &Path, meta: &UploadMeta, ctl: &Ctl) -> Result<Uploaded, String> {
        let mut file = std::fs::File::open(local).map_err(|e| format!("open {}: {e}", local.display()))?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();
        if total == 0 {
            return Err("the render is empty".into());
        }
        let mut body = json!({ "name": meta.name, "appProperties": { "createdBy": APP_TAG, "project": meta.project, "renderId": meta.render_id } });
        if let Some(p) = &meta.parent {
            body["parents"] = json!([p]);
        }
        let init_url = format!("{}/files", self.ep.upload);
        let r = self
            .authed(|h| {
                h.post(&init_url)
                    .query(&[("uploadType", "resumable"), ("fields", "id,webViewLink,sha256Checksum")])
                    .header("X-Upload-Content-Type", meta.mime.as_str())
                    .header("X-Upload-Content-Length", total.to_string())
                    .json(&body)
                    .timeout(JSON_TIMEOUT)
            })
            .await?;
        let status = r.status().as_u16();
        if !(200..300).contains(&status) {
            let b = r.text().await.unwrap_or_default();
            return Err(api_error(status, &b));
        }
        let session = r.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).map(String::from).ok_or("Google Drive did not open an upload session")?;
        if !same_origin(&session, &self.ep.upload) {
            return Err("Google Drive returned an upload session on an unexpected host".into());
        }
        let mut offset = 0u64;
        let mut hashed = 0u64;
        let mut hasher = Sha256::new();
        let mut fails = 0u32;
        let mut need_query = false;
        let done = loop {
            if ctl.cancelled() {
                // Best effort: Google drops the half-finished session on DELETE.
                let _ = self.http.delete(&session).timeout(Duration::from_secs(10)).send().await;
                return Err(CANCELLED.into());
            }
            let outcome = if need_query || offset >= total {
                self.query_offset(&session, total).await
            } else {
                let end = (offset + self.chunk).min(total);
                let buf = read_range(&mut file, offset, end)?;
                // Every byte is hashed exactly once, in order: chunks are contiguous reads and the
                // server's Range never runs ahead of what was sent.
                if end > hashed {
                    hasher.update(&buf[(hashed.max(offset) - offset) as usize..]);
                    hashed = end;
                }
                self.put_chunk(&session, buf, format!("bytes {offset}-{}/{total}", end - 1)).await
            };
            need_query = false;
            match outcome {
                Ok(Step::Done(v)) => break v,
                Ok(Step::Continue(o)) => {
                    let o = o.min(total);
                    if o > offset {
                        fails = 0;
                    } else {
                        fails += 1;
                        if fails > MAX_RETRIES {
                            return Err("the Drive upload stalled".into());
                        }
                    }
                    offset = o;
                    (ctl.progress)(offset);
                }
                Err(PutErr::Fatal(e)) => return Err(e),
                Err(PutErr::Retry(e)) => {
                    fails += 1;
                    if fails > MAX_RETRIES {
                        return Err(format!("upload failed after {MAX_RETRIES} retries: {e}"));
                    }
                    let wait = self.retry_base_ms.saturating_mul(1 << (fails - 1).min(5)).min(30_000);
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                    need_query = true;
                }
            }
        };
        if hashed < total {
            let rest = read_range(&mut file, hashed, total)?;
            hasher.update(&rest);
        }
        (ctl.progress)(total);
        let id = done["id"].as_str().filter(|s| valid_drive_id(s)).ok_or("Google Drive did not return the new file id")?.to_string();
        Ok(Uploaded { id, web_view_link: done["webViewLink"].as_str().map(String::from), sha256: done["sha256Checksum"].as_str().filter(|s| !s.is_empty()).map(String::from), local_sha256: hex(&hasher.finalize()) })
    }

    async fn share(&self, id: &str) -> Result<String, String> {
        if !valid_drive_id(id) {
            return Err("bad Drive file id".into());
        }
        let url = format!("{}/files/{id}/permissions", self.ep.api);
        let body = json!({ "role": "reader", "type": "anyone" });
        json_of(self.authed(|h| h.post(&url).query(&[("fields", "id")]).json(&body).timeout(JSON_TIMEOUT)).await?).await?;
        let v = self.get_json(&format!("{}/files/{id}", self.ep.api), &[("fields", "webViewLink")]).await?;
        v["webViewLink"].as_str().map(String::from).ok_or_else(|| "Google Drive did not return a link".into())
    }
}

// ── Transfers ──────────────────────────────────────────────────────────────────

pub(crate) type Sink = Arc<dyn Fn(&CloudTransfer) + Send + Sync>;

struct Live {
    t: CloudTransfer,
    cancel: Arc<AtomicBool>,
    last_emit: Instant,
}

#[derive(Default)]
pub(crate) struct Book {
    live: Vec<Live>,
    done: VecDeque<CloudTransfer>,
}

/// Live + recently finished transfers; emits `cloud-transfer` on every status change and at most
/// every 500 ms while bytes move.
#[derive(Clone)]
pub(crate) struct Tracker {
    book: Arc<Mutex<Book>>,
    sink: Sink,
}

impl Tracker {
    pub(crate) fn new(book: Arc<Mutex<Book>>, sink: Sink) -> Self {
        Self { book, sink }
    }

    pub(crate) fn create(&self, direction: &str, name: &str, project: &str, total: u64) -> (String, Arc<AtomicBool>) {
        let t = CloudTransfer {
            id: media::short_id("x"),
            provider: PROVIDER.into(),
            direction: direction.into(),
            name: name.into(),
            project: project.into(),
            status: "queued".into(),
            bytes_done: 0,
            bytes_total: total,
            error: None,
            result: None,
            started_at: media::now_iso(),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let id = t.id.clone();
        self.book.lock().unwrap().live.push(Live { t: t.clone(), cancel: cancel.clone(), last_emit: Instant::now() });
        (self.sink)(&t);
        (id, cancel)
    }

    fn update(&self, id: &str, force: bool, f: impl FnOnce(&mut CloudTransfer)) {
        let out = {
            let mut b = self.book.lock().unwrap();
            let Some(l) = b.live.iter_mut().find(|l| l.t.id == id) else { return };
            let before = l.t.status.clone();
            f(&mut l.t);
            if force || l.t.status != before || l.last_emit.elapsed() >= EMIT_EVERY {
                l.last_emit = Instant::now();
                Some(l.t.clone())
            } else {
                None
            }
        };
        if let Some(t) = out {
            (self.sink)(&t);
        }
    }

    pub(crate) fn start(&self, id: &str) {
        self.update(id, false, |t| t.status = "running".into());
    }

    pub(crate) fn progress(&self, id: &str, done: u64) {
        self.update(id, false, |t| {
            t.status = "running".into();
            t.bytes_done = done.min(t.bytes_total.max(done));
        });
    }

    pub(crate) fn finish(&self, id: &str, status: &str, error: Option<String>, result: Option<TransferResult>) {
        let out = {
            let mut b = self.book.lock().unwrap();
            let Some(i) = b.live.iter().position(|l| l.t.id == id) else { return };
            let mut t = b.live.remove(i).t;
            t.status = status.into();
            t.error = error.map(|e| e.chars().take(800).collect());
            if status == "done" {
                t.bytes_done = t.bytes_total.max(t.bytes_done);
                t.result = result;
            }
            b.done.push_front(t.clone());
            b.done.truncate(KEEP_FINISHED);
            t
        };
        (self.sink)(&out);
    }

    /// Settle a transfer from its outcome (`Err("cancelled")` → cancelled).
    pub(crate) fn settle(&self, id: &str, r: Result<TransferResult, String>) {
        match r {
            Ok(res) => self.finish(id, "done", None, Some(res)),
            Err(e) if e == CANCELLED => self.finish(id, "cancelled", None, None),
            Err(e) => self.finish(id, "failed", Some(e), None),
        }
    }

    pub(crate) fn cancel(&self, id: &str) -> bool {
        let b = self.book.lock().unwrap();
        match b.live.iter().find(|l| l.t.id == id) {
            Some(l) => {
                l.cancel.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<CloudTransfer> {
        let b = self.book.lock().unwrap();
        b.live.iter().map(|l| l.t.clone()).chain(b.done.iter().cloned()).collect()
    }

    fn ctl(&self, id: &str, cancel: &Arc<AtomicBool>) -> Ctl {
        let (t, id) = (self.clone(), id.to_string());
        Ctl { cancel: cancel.clone(), progress: Arc::new(move |n| t.progress(&id, n)) }
    }
}

// ── media.db: drive_sync + kv ──────────────────────────────────────────────────

fn kv_get(m: &MediaState, key: &str) -> Option<String> {
    m.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get::<_, String>(0)).optional().map_err(media::sql_err)).ok().flatten()
}

fn kv_set(m: &MediaState, key: &str, value: Option<&str>) -> Result<(), String> {
    m.with(|c| {
        match value {
            Some(v) => c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![key, v]),
            None => c.execute("DELETE FROM kv WHERE key = ?1", [key]),
        }
        .map(|_| ())
        .map_err(media::sql_err)
    })
}

fn folder_kv(m: &MediaState, key: &str) -> Option<CloudFolderRef> {
    kv_get(m, key).and_then(|j| serde_json::from_str(&j).ok())
}

pub(crate) fn folders(m: &MediaState) -> (Option<CloudFolderRef>, Option<CloudFolderRef>) {
    (folder_kv(m, "gdrive.inbox"), folder_kv(m, "gdrive.outbox"))
}

fn check_folder(f: &CloudFolderRef) -> Result<CloudFolderRef, String> {
    let name = f.name.trim();
    if !valid_drive_id(&f.id) || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err("bad Drive folder".into());
    }
    Ok(CloudFolderRef { id: f.id.clone(), name: name.into() })
}

/// `None` = leave as is, `Some(None)` = clear, `Some(Some(f))` = set.
pub(crate) fn set_folders(m: &MediaState, inbox: Option<Option<CloudFolderRef>>, outbox: Option<Option<CloudFolderRef>>) -> Result<(), String> {
    for (key, v) in [("gdrive.inbox", inbox), ("gdrive.outbox", outbox)] {
        match v {
            None => {}
            Some(None) => kv_set(m, key, None)?,
            Some(Some(f)) => kv_set(m, key, Some(&serde_json::to_string(&check_folder(&f)?).map_err(|e| e.to_string())?))?,
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_sync(m: &MediaState, direction: &str, project: &str, local_path: &str, file_id: &str, name: &str, size: u64, link: Option<&str>) -> Result<CloudSyncRecord, String> {
    let r = CloudSyncRecord {
        id: media::short_id("s"),
        provider: PROVIDER.into(),
        direction: direction.into(),
        project: project.into(),
        local_path: local_path.into(),
        drive_file_id: file_id.into(),
        name: name.into(),
        size_bytes: size,
        web_view_link: link.map(String::from),
        at: media::now_iso(),
    };
    m.with(|c| {
        c.execute(
            "INSERT INTO drive_sync (id, provider, direction, project, local_path, drive_file_id, name, size_bytes, web_view_link, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![r.id, r.provider, r.direction, r.project, r.local_path, r.drive_file_id, r.name, r.size_bytes as i64, r.web_view_link, r.at],
        )
        .map(|_| ())
        .map_err(media::sql_err)
    })?;
    Ok(r)
}

pub(crate) fn history(m: &MediaState, slug: Option<&str>) -> Result<Vec<CloudSyncRecord>, String> {
    m.with(|c| {
        let mut st = c
            .prepare("SELECT id, provider, direction, project, local_path, drive_file_id, name, size_bytes, web_view_link, at FROM drive_sync WHERE ?1 IS NULL OR project = ?1 ORDER BY at DESC, rowid DESC LIMIT 500")
            .map_err(media::sql_err)?;
        let rows = st
            .query_map([slug], |r| {
                Ok(CloudSyncRecord {
                    id: r.get(0)?,
                    provider: r.get(1)?,
                    direction: r.get(2)?,
                    project: r.get(3)?,
                    local_path: r.get(4)?,
                    drive_file_id: r.get(5)?,
                    name: r.get(6)?,
                    size_bytes: r.get::<_, i64>(7)?.max(0) as u64,
                    web_view_link: r.get(8)?,
                    at: r.get(9)?,
                })
            })
            .map_err(media::sql_err)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

// ── Pull ───────────────────────────────────────────────────────────────────────

fn ext_for_mime(m: &str) -> Option<&'static str> {
    Some(match m {
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        "video/webm" => "webm",
        "video/x-msvideo" => "avi",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tif",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => return None,
    })
}

/// The `raw/` file name for a Drive file: sanitised, with an extension from the MIME type when
/// the Drive name has no media extension.
pub(crate) fn pull_name(name: &str, mime: &str) -> String {
    let n = media::safe_file_name(name);
    if media::kind_for_ext(&media::ext_of(&n)).is_some() {
        return n;
    }
    match ext_for_mime(mime) {
        Some(e) => format!("{n}.{e}"),
        None => n,
    }
}

/// Only real video / image / audio files up to 20 GB.
pub(crate) fn check_pullable(m: &FileMeta) -> Result<(), String> {
    if m.trashed {
        return Err(format!("{} is in the Drive trash", m.name));
    }
    if m.mime_type == FOLDER_MIME {
        return Err(format!("{} is a folder — open it and pick files", m.name));
    }
    if m.mime_type.starts_with("application/vnd.google-apps.") {
        return Err(format!("{} is a Google Docs/Sheets/Slides file, not media", m.name));
    }
    if !matches!(kind_of(&m.mime_type), "video" | "image" | "audio") {
        return Err(format!("{} is not a video, photo or audio file", m.name));
    }
    match m.size {
        Some(s) if s > 0 && s <= MAX_PULL_BYTES => Ok(()),
        Some(0) | None => Err(format!("{} is empty or has no downloadable content", m.name)),
        _ => Err(format!("{} is larger than 20 GB", m.name)),
    }
}

pub(crate) struct PullJob {
    pub transfer: String,
    pub cancel: Arc<AtomicBool>,
    pub meta: FileMeta,
}

/// Stream one Drive file into `part` and check Drive's SHA-256. On any failure (including a
/// checksum mismatch or a cancel) the part file is deleted.
pub(crate) async fn fetch_to_part<P: CloudProvider>(p: &P, tracker: &Tracker, job: &PullJob, part: &Path) -> Result<u64, String> {
    if job.cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.into());
    }
    tracker.start(&job.transfer);
    let ctl = tracker.ctl(&job.transfer, &job.cancel);
    let res = p.download(&job.meta.id, part, &ctl).await.and_then(|d| match &job.meta.sha256 {
        Some(want) if !want.eq_ignore_ascii_case(&d.sha256) => Err(format!("{}: SHA-256 mismatch after download (Drive {want}, got {}) — nothing was imported", job.meta.name, d.sha256)),
        _ => Ok(d.bytes),
    });
    if res.is_err() {
        let _ = std::fs::remove_file(part);
    }
    res
}

/// Move a verified part into `raw/` (never overwriting) and record it. `finalize` is
/// `media::finalize_asset(…, read_only = true)` in the app.
pub(crate) fn land_pull(m: &MediaState, slug: &str, part: &Path, display: &str, file_id: &str, size: u64, finalize: impl FnOnce(&Path, &str) -> Result<MediaAsset, String>) -> Result<MediaAsset, String> {
    let raw = media::project_root(m, slug)?.join("raw");
    if let Err(e) = std::fs::create_dir_all(&raw) {
        let _ = std::fs::remove_file(part);
        return Err(e.to_string());
    }
    let dst = media::unique_path(&raw, display);
    if let Err(e) = std::fs::rename(part, &dst) {
        let _ = std::fs::remove_file(part);
        return Err(format!("stage {display}: {e}"));
    }
    let a = finalize(&dst, display).inspect_err(|_| media::remove_staged(&dst))?;
    record_sync(m, "pull", slug, &a.path, file_id, display, size, None)?;
    Ok(a)
}

// ── Push / share ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PushSource {
    pub render_id: String,
    pub project: String,
    /// `VerifiedRender.path` exactly as stored (the drive_sync push row's localPath).
    pub render_path: String,
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
}

/// A push needs approval and a verified render whose file is inside the projects root.
pub(crate) fn push_source(m: &MediaState, render_id: &str, approved: bool) -> Result<PushSource, String> {
    if !approved {
        return Err("PERMISSION_REQUIRED:cloud-push — confirm the upload first".into());
    }
    if render_id.is_empty() || render_id.len() > 64 {
        return Err("bad render id".into());
    }
    let json = m
        .with(|c| c.query_row("SELECT json FROM render WHERE id = ?1", [render_id], |r| r.get::<_, String>(0)).optional().map_err(media::sql_err))?
        .ok_or("only verified renders can be uploaded (no such render)")?;
    let r: VerifiedRender = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let path = PathBuf::from(&r.path);
    if !path.is_file() || !media::inside(&path, &m.projects_root()) {
        return Err("the render file is missing or outside the Director projects folder".into());
    }
    let size = std::fs::metadata(&path).map(|x| x.len()).unwrap_or(0);
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "render.mp4".into());
    Ok(PushSource { render_id: r.id, project: r.project, render_path: r.path, path, name, size })
}

fn mime_for(name: &str) -> &'static str {
    match media::ext_of(name).as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/// Upload a render and check Drive's SHA-256 against the local file's.
pub(crate) async fn push_one<P: CloudProvider>(p: &P, tracker: &Tracker, transfer: &str, cancel: &Arc<AtomicBool>, src: &PushSource, parent: Option<String>) -> Result<Uploaded, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.into());
    }
    tracker.start(transfer);
    let meta = UploadMeta { name: src.name.clone(), parent, project: src.project.clone(), render_id: src.render_id.clone(), mime: mime_for(&src.name).into() };
    let up = p.upload_resumable(&src.path, &meta, &tracker.ctl(transfer, cancel)).await?;
    if let Some(remote) = &up.sha256 {
        if !remote.eq_ignore_ascii_case(&up.local_sha256) {
            return Err(format!("SHA-256 mismatch after upload (Drive {remote}, local {}) — the Drive copy is not trustworthy", up.local_sha256));
        }
    }
    Ok(up)
}

/// Share needs approval and a file this app pushed; returns the link and updates the record.
pub(crate) async fn share_file<P: CloudProvider>(p: &P, m: &MediaState, file_id: &str, approved: bool) -> Result<String, String> {
    if !approved {
        return Err("PERMISSION_REQUIRED:cloud-share — confirm the share link first".into());
    }
    if !valid_drive_id(file_id) {
        return Err("bad Drive file id".into());
    }
    let pushed: bool = m.with(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM drive_sync WHERE direction = 'push' AND drive_file_id = ?1)", [file_id], |r| r.get(0)).map_err(media::sql_err))?;
    if !pushed {
        return Err("only files this app uploaded can be shared".into());
    }
    let link = p.share(file_id).await?;
    m.with(|c| c.execute("UPDATE drive_sync SET web_view_link = ?2 WHERE direction = 'push' AND drive_file_id = ?1", params![file_id, link]).map(|_| ()).map_err(media::sql_err))?;
    Ok(link)
}

// ── Connect ────────────────────────────────────────────────────────────────────

/// Installed-app sign-in: loopback listener, PKCE S256, `state`; `open` shows the consent page.
pub(crate) async fn connect_flow(drive: &GoogleDrive, open: impl FnOnce(&str) -> Result<(), String>, timeout: Duration) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("could not open the sign-in listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_verifier();
    let state = b64url(&random_bytes::<24>());
    let url = auth_url(&drive.ep.auth, &drive.client.id, &redirect, &pkce_challenge(&verifier), &state)?;
    open(&url)?;
    let code = tokio::time::timeout(timeout, wait_for_code(listener, &state)).await.map_err(|_| "Google sign-in timed out after 5 minutes — press Connect again".to_string())??;
    drive.exchange_code(&code, &verifier, &redirect).await
}

// ── App state ──────────────────────────────────────────────────────────────────

pub struct GdriveState {
    access: Arc<Mutex<Option<Access>>>,
    account: Mutex<Option<String>>,
    book: Arc<Mutex<Book>>,
    http: reqwest::Client,
    connecting: tokio::sync::Mutex<()>,
}

impl Default for GdriveState {
    fn default() -> Self {
        Self {
            access: Arc::default(),
            account: Mutex::new(None),
            book: Arc::default(),
            // No overall timeout: downloads / uploads run for as long as they need. JSON calls set their own.
            http: reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).pool_idle_timeout(Duration::from_secs(90)).build().expect("http client"),
            connecting: tokio::sync::Mutex::new(()),
        }
    }
}

fn drive_for(app: &tauri::AppHandle) -> Result<GoogleDrive, String> {
    let st = app.state::<GdriveState>();
    let client = secrets::get(&app.state::<DispatchState>(), CLIENT_KEY).and_then(|j| parse_client(&j)).ok_or(NO_CLIENT)?;
    Ok(GoogleDrive { ep: Endpoints::default(), http: st.http.clone(), client, store: Arc::new(AppKeychain(app.clone())), access: st.access.clone(), chunk: UPLOAD_CHUNK, retry_base_ms: 1000 })
}

fn online(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<OsState>().snapshot().privacy.kill_switch {
        Err(KILL_SWITCH.into())
    } else {
        Ok(())
    }
}

fn tracker(app: &tauri::AppHandle) -> Tracker {
    let a = app.clone();
    Tracker::new(app.state::<GdriveState>().book.clone(), Arc::new(move |t: &CloudTransfer| {
        let _ = a.emit(TRANSFER_EVENT, t);
    }))
}

async fn status(app: &tauri::AppHandle) -> CloudStatus {
    let (inbox_folder, outbox_folder) = folders(&app.state::<MediaState>());
    let mut s = CloudStatus { provider: PROVIDER.into(), client_configured: false, connected: false, account: None, inbox_folder, outbox_folder, error: None };
    let Ok(drive) = drive_for(app) else { return s };
    s.client_configured = true;
    if drive.store.get().is_none() {
        return s;
    }
    s.connected = true;
    let cached = app.state::<GdriveState>().account.lock().unwrap().clone();
    if cached.is_some() {
        s.account = cached;
        return s;
    }
    if online(app).is_err() {
        s.error = Some(KILL_SWITCH.into());
        return s;
    }
    match drive.about().await {
        Ok(email) => {
            *app.state::<GdriveState>().account.lock().unwrap() = Some(email.clone());
            s.account = Some(email);
        }
        Err(e) => {
            if e == REAUTH || e == NOT_CONNECTED {
                s.connected = false;
            }
            s.error = Some(e);
        }
    }
    s
}

async fn emit_status(app: &tauri::AppHandle) -> CloudStatus {
    let s = status(app).await;
    let _ = app.emit(STATUS_EVENT, &s);
    s
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cloud_status(app: tauri::AppHandle, provider: String) -> Result<CloudStatus, String> {
    check_provider(&provider)?;
    Ok(status(&app).await)
}

#[tauri::command]
pub async fn cloud_connect(app: tauri::AppHandle, provider: String) -> Result<CloudStatus, String> {
    check_provider(&provider)?;
    online(&app)?;
    // Already connected with a working token: never open a second consent tab (to switch
    // accounts, Disconnect first).
    let current = emit_status(&app).await;
    if current.connected {
        return Ok(current);
    }
    let drive = drive_for(&app)?;
    {
        let st = app.state::<GdriveState>();
        let _g = st.connecting.try_lock().map_err(|_| "a Google sign-in is already waiting in your browser".to_string())?;
        connect_flow(&drive, |u| super::spotify::open_browser(u).map_err(|e| format!("could not open the browser: {e}")), CONNECT_TIMEOUT).await?;
        *st.account.lock().unwrap() = None;
    }
    Ok(emit_status(&app).await)
}

#[tauri::command]
pub async fn cloud_disconnect(app: tauri::AppHandle, provider: String) -> Result<CloudStatus, String> {
    check_provider(&provider)?;
    let token = secrets::get(&app.state::<DispatchState>(), TOKEN_KEY);
    if let (Some(t), Ok(())) = (token, online(&app)) {
        let http = app.state::<GdriveState>().http.clone();
        revoke_token(&http, &Endpoints::default().revoke, &t).await;
    }
    AppKeychain(app.clone()).delete()?;
    {
        let st = app.state::<GdriveState>();
        *st.access.lock().unwrap() = None;
        *st.account.lock().unwrap() = None;
    }
    Ok(emit_status(&app).await)
}

#[tauri::command]
pub async fn cloud_list(app: tauri::AppHandle, provider: String, folder_id: Option<String>, query: Option<String>, page_token: Option<String>) -> Result<CloudListing, String> {
    check_provider(&provider)?;
    if let Some(f) = &folder_id {
        if !valid_drive_id(f) {
            return Err("bad Drive folder id".into());
        }
    }
    online(&app)?;
    let drive = drive_for(&app)?;
    drive.list(folder_id.as_deref(), query.as_deref(), page_token.as_deref()).await
}

/// Args `{ provider, inbox?, outbox? }`: a missing key leaves that folder alone, `null` clears it.
#[tauri::command]
pub async fn cloud_set_folders(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<CloudStatus, String> {
    let tauri::ipc::InvokeBody::Json(args) = request.body() else { return Err("expected JSON arguments".into()) };
    check_provider(args["provider"].as_str().unwrap_or(""))?;
    let pick = |k: &str| -> Result<Option<Option<CloudFolderRef>>, String> {
        match args.get(k) {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(v) => serde_json::from_value::<CloudFolderRef>(v.clone()).map(|f| Some(Some(f))).map_err(|_| format!("{k} must be {{id, name}} or null")),
        }
    };
    let (inbox, outbox) = (pick("inbox")?, pick("outbox")?);
    let app2 = app.clone();
    media::blocking(move || set_folders(&app2.state::<MediaState>(), inbox, outbox)).await?;
    Ok(emit_status(&app).await)
}

#[tauri::command]
pub async fn cloud_pull(app: tauri::AppHandle, provider: String, file_ids: Vec<String>, slug: String, role: String) -> Result<Value, String> {
    check_provider(&provider)?;
    if file_ids.is_empty() || file_ids.len() > MAX_PULL_FILES {
        return Err(format!("pick between 1 and {MAX_PULL_FILES} files"));
    }
    if let Some(bad) = file_ids.iter().find(|id| !valid_drive_id(id)) {
        return Err(format!("bad Drive file id {:?}", bad.chars().take(40).collect::<String>()));
    }
    media::check_role(&role)?;
    let uploads = {
        let m = app.state::<MediaState>();
        media::load_project(&m, &slug)?;
        media::project_root(&m, &slug)?.join("working").join(".uploads")
    };
    std::fs::create_dir_all(&uploads).map_err(|e| e.to_string())?;
    online(&app)?;
    let drive = drive_for(&app)?;
    let mut metas = vec![];
    for id in &file_ids {
        let m = drive.file_meta(id).await?;
        check_pullable(&m)?;
        metas.push(m);
    }
    let tr = tracker(&app);
    let jobs: Vec<PullJob> = metas
        .into_iter()
        .map(|meta| {
            let (transfer, cancel) = tr.create("pull", &meta.name, &slug, meta.size.unwrap_or(0));
            PullJob { transfer, cancel, meta }
        })
        .collect();
    let ids: Vec<String> = jobs.iter().map(|j| j.transfer.clone()).collect();
    tauri::async_runtime::spawn(async move {
        for job in jobs {
            let part = uploads.join(format!("{}.part", job.transfer));
            let res = match fetch_to_part(&drive, &tr, &job, &part).await {
                Err(e) => Err(e),
                Ok(size) => {
                    let (app2, slug2, role2) = (app.clone(), slug.clone(), role.clone());
                    let display = pull_name(&job.meta.name, &job.meta.mime_type);
                    let fid = job.meta.id.clone();
                    media::blocking(move || {
                        let m = app2.state::<MediaState>();
                        let cfg = app2.state::<OsState>().snapshot();
                        land_pull(&m, &slug2, &part, &display, &fid, size, |p, d| media::finalize_asset(&m, &cfg, &slug2, p, d, &role2, true))
                    })
                    .await
                    .map(|a| TransferResult { asset_id: Some(a.id), ..Default::default() })
                }
            };
            tr.settle(&job.transfer, res);
        }
    });
    Ok(json!({ "transferIds": ids }))
}

#[tauri::command]
pub async fn cloud_push(app: tauri::AppHandle, provider: String, render_id: String, folder_id: Option<String>, approved: Option<bool>) -> Result<Value, String> {
    let approved = approved.unwrap_or(false);
    if !approved {
        return Err("PERMISSION_REQUIRED:cloud-push — confirm the upload first".into());
    }
    check_provider(&provider)?;
    if let Some(f) = &folder_id {
        if !valid_drive_id(f) {
            return Err("bad Drive folder id".into());
        }
    }
    let src = {
        let app2 = app.clone();
        let rid = render_id.clone();
        media::blocking(move || push_source(&app2.state::<MediaState>(), &rid, approved)).await?
    };
    online(&app)?;
    let drive = drive_for(&app)?;
    if drive.store.get().is_none() {
        return Err(NOT_CONNECTED.into());
    }
    let parent = folder_id.or_else(|| folders(&app.state::<MediaState>()).1.map(|f| f.id));
    let tr = tracker(&app);
    let (transfer, cancel) = tr.create("push", &src.name, &src.project, src.size);
    let tid = transfer.clone();
    tauri::async_runtime::spawn(async move {
        let res = match push_one(&drive, &tr, &transfer, &cancel, &src, parent).await {
            Err(e) => Err(e),
            Ok(up) => {
                let m = app.state::<MediaState>();
                // webViewLink stays NULL on the row until cloud_share (the UI reads non-null as "shared").
                record_sync(&m, "push", &src.project, &src.render_path, &up.id, &src.name, src.size, None)
                    .map(|_| TransferResult { drive_file_id: Some(up.id.clone()), web_view_link: up.web_view_link.clone(), ..Default::default() })
                    .map_err(|e| format!("uploaded to Drive ({}) but could not record it: {e}", up.id))
            }
        };
        tr.settle(&transfer, res);
    });
    Ok(json!({ "transferId": tid }))
}

#[tauri::command]
pub async fn cloud_share(app: tauri::AppHandle, provider: String, drive_file_id: String, approved: Option<bool>) -> Result<Value, String> {
    let approved = approved.unwrap_or(false);
    if !approved {
        return Err("PERMISSION_REQUIRED:cloud-share — confirm the share link first".into());
    }
    check_provider(&provider)?;
    online(&app)?;
    let drive = drive_for(&app)?;
    let link = share_file(&drive, &app.state::<MediaState>(), &drive_file_id, approved).await?;
    Ok(json!({ "webViewLink": link }))
}

#[tauri::command]
pub fn cloud_cancel(app: tauri::AppHandle, transfer_id: String) -> Result<(), String> {
    if tracker(&app).cancel(&transfer_id) {
        Ok(())
    } else {
        Err("no live transfer with that id".into())
    }
}

#[tauri::command]
pub fn cloud_transfers(app: tauri::AppHandle) -> Vec<CloudTransfer> {
    tracker(&app).snapshot()
}

#[tauri::command]
pub async fn cloud_history(app: tauri::AppHandle, slug: Option<String>) -> Result<Vec<CloudSyncRecord>, String> {
    media::blocking(move || history(&app.state::<MediaState>(), slug.as_deref())).await
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod mock {
    //! A tiny HTTP/1.1 server: raw bodies, request headers and response headers (the allm.rs
    //! mock is JSON-only).
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Clone, Debug)]
    pub struct Req {
        pub method: String,
        pub target: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Req {
        pub fn path(&self) -> &str {
            self.target.split('?').next().unwrap_or("")
        }
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }
        pub fn query(&self, k: &str) -> Option<String> {
            url::Url::parse(&format!("http://x{}", self.target)).ok()?.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
        }
        pub fn form(&self, k: &str) -> Option<String> {
            url::form_urlencoded::parse(&self.body).find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
        }
        pub fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
        }
        pub fn bearer(&self) -> Option<&str> {
            self.header("authorization").and_then(|v| v.strip_prefix("Bearer "))
        }
    }

    pub struct Resp {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Resp {
        pub fn json(status: u16, v: serde_json::Value) -> Self {
            Self { status, headers: vec![("Content-Type".into(), "application/json".into())], body: v.to_string().into_bytes() }
        }
        pub fn bytes(status: u16, b: &[u8]) -> Self {
            Self { status, headers: vec![], body: b.to_vec() }
        }
        pub fn with(mut self, k: &str, v: &str) -> Self {
            self.headers.push((k.into(), v.into()));
            self
        }
    }

    pub struct Server {
        pub base: String,
        pub log: Arc<Mutex<Vec<Req>>>,
    }

    impl Server {
        pub fn reqs(&self) -> Vec<Req> {
            self.log.lock().unwrap().clone()
        }
        pub fn count(&self, method: &str, path: &str) -> usize {
            self.reqs().iter().filter(|r| r.method == method && r.path() == path).count()
        }
    }

    pub async fn start(h: impl Fn(&Req) -> Resp + Send + Sync + 'static) -> Server {
        let handler = Arc::new(h);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log: Arc<Mutex<Vec<Req>>> = Arc::default();
        let log2 = log.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let (handler, log) = (handler.clone(), log2.clone());
                tauri::async_runtime::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 8192];
                    let head_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let headers: Vec<(String, String)> = head.lines().skip(1).filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
                    let len = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = buf[head_end + 4..(head_end + 4 + len).min(buf.len())].to_vec();
                    let mut first = head.lines().next().unwrap_or("").split_whitespace();
                    let req = Req { method: first.next().unwrap_or("").into(), target: first.next().unwrap_or("").into(), headers, body };
                    log.lock().unwrap().push(req.clone());
                    let resp = handler(&req);
                    let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", resp.status, resp.body.len());
                    for (k, v) in &resp.headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.write_all(&resp.body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Server { base, log }
    }
}

#[cfg(test)]
mod tests {
    use super::mock::{start, Req, Resp};
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct MemStore(Mutex<Option<String>>);

    impl TokenStore for MemStore {
        fn get(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn set(&self, v: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(v.into());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    fn drive(base: &str, refresh: Option<&str>) -> (GoogleDrive, Arc<MemStore>) {
        let store = Arc::new(MemStore(Mutex::new(refresh.map(String::from))));
        let d = GoogleDrive {
            ep: Endpoints { auth: format!("{base}/auth"), token: format!("{base}/token"), revoke: format!("{base}/revoke"), api: format!("{base}/drive/v3"), upload: format!("{base}/upload/drive/v3") },
            http: reqwest::Client::new(),
            client: OAuthClient { id: "cid".into(), secret: "csecret".into() },
            store: store.clone(),
            access: Arc::default(),
            chunk: 4,
            retry_base_ms: 1,
        };
        (d, store)
    }

    /// Token endpoint: refresh → "a<n>"; authorization_code → "a-code" + refresh "r-new".
    fn token_resp(r: &Req, n: &AtomicUsize) -> Resp {
        match r.form("grant_type").as_deref() {
            Some("refresh_token") if r.form("refresh_token").as_deref() == Some("r1") && r.form("client_secret").as_deref() == Some("csecret") => {
                let k = n.fetch_add(1, Ordering::SeqCst) + 1;
                Resp::json(200, json!({ "access_token": format!("a{k}"), "expires_in": 3600 }))
            }
            Some("refresh_token") => Resp::json(400, json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." })),
            _ => Resp::json(400, json!({ "error": "unsupported_grant_type" })),
        }
    }

    fn tracker_log() -> (Tracker, Arc<Mutex<Vec<CloudTransfer>>>) {
        let log: Arc<Mutex<Vec<CloudTransfer>>> = Arc::default();
        let l2 = log.clone();
        (Tracker::new(Arc::default(), Arc::new(move |t: &CloudTransfer| l2.lock().unwrap().push(t.clone()))), log)
    }

    fn sha(b: &[u8]) -> String {
        hex(&Sha256::digest(b))
    }

    fn tmp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("gdrive-test-{}", media::short_id("t")));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pkce_matches_rfc7636_and_auth_url_has_every_param() {
        // RFC 7636 appendix B.
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let v = random_verifier();
        assert_eq!(v.len(), 64);
        assert!(v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(v, random_verifier());
        let u = url::Url::parse(&auth_url("https://accounts.google.com/o/oauth2/v2/auth", "cid", "http://127.0.0.1:5555", "chal", "st8").unwrap()).unwrap();
        let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file");
        assert_eq!((q["code_challenge"].as_str(), q["code_challenge_method"].as_str()), ("chal", "S256"));
        assert_eq!((q["state"].as_str(), q["access_type"].as_str(), q["prompt"].as_str()), ("st8", "offline", "consent"));
        assert_eq!(parse_callback("GET /?state=s&code=c&scope=x HTTP/1.1\r\n"), Callback::Code { code: "c".into(), state: "s".into() });
        assert_eq!(parse_callback("GET /?error=access_denied&state=s HTTP/1.1"), Callback::Denied { error: "access_denied".into(), state: "s".into() });
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1"), Callback::Other);
    }

    #[test]
    fn ids_queries_and_provider_are_validated() {
        assert!(valid_drive_id("1AbC_d-9") && valid_drive_id("root") && valid_drive_id(&"a".repeat(200)));
        assert!(!valid_drive_id("") && !valid_drive_id(&"a".repeat(201)) && !valid_drive_id("a'b") && !valid_drive_id("a b") && !valid_drive_id("../x") && !valid_drive_id("a\\b"));
        assert_eq!(list_query("root", None).unwrap(), "'root' in parents and trashed=false");
        assert_eq!(list_query("F1", Some("  ")).unwrap(), "'F1' in parents and trashed=false");
        assert_eq!(list_query("F1", Some(r"it's a \ test")).unwrap(), r"'F1' in parents and trashed=false and name contains 'it\'s a \\ test'");
        assert!(list_query("F1' or '1'='1", None).is_err());
        assert!(list_query("F1", Some(&"x".repeat(201))).is_err());
        assert!(list_query("F1", Some("a\nb")).is_err());
        assert!(check_provider("gdrive").is_ok() && check_provider("dropbox").is_err());
        assert_eq!(next_offset(Some("bytes=0-1234")), 1235);
        assert_eq!(next_offset(None), 0);
        assert_eq!(parse_client(r#"{"clientId":" id ","clientSecret":"s"}"#).map(|c| c.id), Some("id".into()));
        assert!(parse_client(r#"{"clientId":"id"}"#).is_none() && parse_client("nope").is_none());
        // Token errors never echo request data and map invalid_grant to a reconnect message.
        assert_eq!(parse_token_reply(400, r#"{"error":"invalid_grant"}"#).unwrap_err(), REAUTH);
        let e = parse_token_reply(401, r#"{"error":"invalid_client","error_description":"secret xyz"}"#).unwrap_err();
        assert!(e.contains("invalid_client") && !e.contains("xyz"));
        assert!(same_origin("https://www.googleapis.com/upload/drive/v3/files?upload_id=1", "https://www.googleapis.com/upload/drive/v3"));
        assert!(!same_origin("https://evil.example/upload", "https://www.googleapis.com/upload/drive/v3"));
        let m = |mime: &str, size: Option<u64>| FileMeta { id: "f".into(), name: "n".into(), mime_type: mime.into(), size, sha256: None, trashed: false };
        assert!(check_pullable(&m("video/mp4", Some(10))).is_ok());
        assert!(check_pullable(&m(FOLDER_MIME, None)).is_err());
        assert!(check_pullable(&m("application/vnd.google-apps.document", None)).unwrap_err().contains("Google Docs"));
        assert!(check_pullable(&m("application/pdf", Some(10))).is_err());
        assert!(check_pullable(&m("video/mp4", Some(MAX_PULL_BYTES + 1))).unwrap_err().contains("20 GB"));
        assert_eq!(pull_name("clip", "video/quicktime"), "clip.mov");
        assert_eq!(pull_name("IMG_1.JPG", "image/jpeg"), "IMG_1.JPG");
        assert_eq!(pull_name("../a:b.mp4", "video/mp4"), "a_b.mp4");
    }

    #[test]
    fn refreshes_the_token_and_retries_once_on_401() {
        tauri::async_runtime::block_on(async {
            let n = Arc::new(AtomicUsize::new(0));
            let n2 = n.clone();
            let srv = start(move |r: &Req| match r.path() {
                "/token" => token_resp(r, &n2),
                // The first access token is "stale": Drive says 401, the second works.
                "/drive/v3/about" if r.bearer() == Some("a2") => {
                    assert_eq!(r.query("fields").as_deref(), Some("user(emailAddress)"));
                    Resp::json(200, json!({ "user": { "emailAddress": "nic@example.com" } }))
                }
                "/drive/v3/about" => Resp::json(401, json!({ "error": { "code": 401, "message": "Invalid Credentials" } })),
                _ => Resp::json(404, json!({})),
            })
            .await;
            let (d, _) = drive(&srv.base, Some("r1"));
            assert_eq!(d.about().await.unwrap(), "nic@example.com");
            assert_eq!(srv.count("POST", "/token"), 2);
            assert_eq!(srv.count("GET", "/drive/v3/about"), 2);
            // The fresh token is cached: no new token request.
            assert_eq!(d.about().await.unwrap(), "nic@example.com");
            assert_eq!(srv.count("POST", "/token"), 2);

            // A revoked refresh token → reconnect message; no token at all → not connected.
            let (d, _) = drive(&srv.base, Some("r-revoked"));
            assert_eq!(d.about().await.unwrap_err(), REAUTH);
            let (d, _) = drive(&srv.base, None);
            assert_eq!(d.about().await.unwrap_err(), NOT_CONNECTED);
        });
    }

    #[test]
    fn connect_exchanges_the_code_and_stores_only_the_refresh_token() {
        tauri::async_runtime::block_on(async {
            let verifier_seen: Arc<Mutex<Option<(String, String)>>> = Arc::default();
            let v2 = verifier_seen.clone();
            let srv = start(move |r: &Req| {
                if r.path() == "/token" && r.form("grant_type").as_deref() == Some("authorization_code") {
                    assert_eq!(r.form("code").as_deref(), Some("the-code"));
                    assert_eq!((r.form("client_id").as_deref(), r.form("client_secret").as_deref()), (Some("cid"), Some("csecret")));
                    assert!(r.form("redirect_uri").unwrap().starts_with("http://127.0.0.1:"));
                    *v2.lock().unwrap() = Some((r.form("code_verifier").unwrap(), String::new()));
                    return Resp::json(200, json!({ "access_token": "a-code", "expires_in": 3599, "refresh_token": "r-new", "scope": SCOPES }));
                }
                Resp::json(404, json!({}))
            })
            .await;
            let (d, store) = drive(&srv.base, None);
            let challenge: Arc<Mutex<String>> = Arc::default();
            let ch2 = challenge.clone();
            let opener = move |u: &str| -> Result<(), String> {
                let u = url::Url::parse(u).unwrap();
                let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
                *ch2.lock().unwrap() = q["code_challenge"].clone();
                let (redirect, state) = (q["redirect_uri"].clone(), q["state"].clone());
                tauri::async_runtime::spawn(async move {
                    let c = reqwest::Client::new();
                    // A stale state is refused and the listener keeps waiting.
                    let r = c.get(format!("{redirect}/?state=wrong&code=evil")).send().await.unwrap();
                    assert_eq!(r.status().as_u16(), 400);
                    let r = c.get(format!("{redirect}/favicon.ico")).send().await.unwrap();
                    assert_eq!(r.status().as_u16(), 404);
                    let r = c.get(format!("{redirect}/?state={state}&code=the-code&scope=x")).send().await.unwrap();
                    assert_eq!(r.status().as_u16(), 200);
                    assert!(r.text().await.unwrap().contains("close this tab"));
                });
                Ok(())
            };
            connect_flow(&d, opener, Duration::from_secs(10)).await.unwrap();
            assert_eq!(store.get().as_deref(), Some("r-new"));
            assert_eq!(d.cached().as_deref(), Some("a-code"));
            let (verifier, _) = verifier_seen.lock().unwrap().clone().unwrap();
            assert_eq!(verifier.len(), 64);
            assert_eq!(pkce_challenge(&verifier), *challenge.lock().unwrap());

            // Nobody answers → timeout error, nothing stored.
            let (d, store) = drive(&srv.base, None);
            let e = connect_flow(&d, |_| Ok(()), Duration::from_millis(200)).await.unwrap_err();
            assert!(e.contains("timed out") && store.get().is_none());
        });
    }

    #[test]
    fn list_maps_kinds_ownership_pages_and_breadcrumbs() {
        tauri::async_runtime::block_on(async {
            let n = Arc::new(AtomicUsize::new(0));
            let srv = start(move |r: &Req| match r.path() {
                "/token" => token_resp(r, &n),
                "/drive/v3/files" => {
                    let q = r.query("q").unwrap();
                    assert_eq!(r.query("fields").as_deref(), Some(LIST_FIELDS));
                    assert_eq!((r.query("pageSize").as_deref(), r.query("orderBy").as_deref()), (Some("100"), Some("folder,modifiedTime desc")));
                    if q == "'root' in parents and trashed=false" {
                        assert!(r.query("pageToken").is_none());
                        return Resp::json(200, json!({ "nextPageToken": "PT2", "files": [
                            { "id": "F1", "name": "Phone", "mimeType": FOLDER_MIME, "modifiedTime": "2026-11-01T00:00:00Z" },
                            { "id": "V1", "name": "take1.mov", "mimeType": "video/quicktime", "size": "1048576", "modifiedTime": "2026-11-02T00:00:00Z",
                              "webViewLink": "https://drive/v1", "videoMediaMetadata": { "width": 1920, "height": 1080, "durationMillis": "12500" } },
                            { "id": "I1", "name": "still.jpg", "mimeType": "image/jpeg", "size": "2048", "modifiedTime": "2026-11-03T00:00:00Z", "imageMediaMetadata": { "width": 4032, "height": 3024 } },
                            { "id": "A1", "name": "vo.m4a", "mimeType": "audio/mp4", "size": "99", "modifiedTime": "x" },
                            { "id": "R1", "name": "render.mp4", "mimeType": "video/mp4", "size": "5", "modifiedTime": "x", "appProperties": { "createdBy": APP_TAG } },
                            { "id": "D1", "name": "notes", "mimeType": "application/vnd.google-apps.document", "modifiedTime": "x" }
                        ]}));
                    }
                    assert_eq!(q, r"'F2' in parents and trashed=false and name contains 'o\'k'");
                    assert_eq!(r.query("pageToken").as_deref(), Some("PT2"));
                    Resp::json(200, json!({ "files": [] }))
                }
                "/drive/v3/files/F2" => Resp::json(200, json!({ "id": "F2", "name": "Clips", "mimeType": FOLDER_MIME, "parents": ["F1"] })),
                "/drive/v3/files/F1" => Resp::json(200, json!({ "id": "F1", "name": "Phone", "mimeType": FOLDER_MIME, "parents": ["ROOT0"] })),
                "/drive/v3/files/ROOT0" | "/drive/v3/files/root" => Resp::json(200, json!({ "id": "ROOT0", "name": "My Drive", "mimeType": FOLDER_MIME })),
                "/drive/v3/files/V1" => Resp::json(200, json!({ "id": "V1", "name": "take1.mov", "mimeType": "video/quicktime" })),
                _ => Resp::json(404, json!({ "error": { "message": "File not found" } })),
            })
            .await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let l = d.list(None, None, None).await.unwrap();
            assert_eq!(l.folder, CloudFolderRef { id: "root".into(), name: "My Drive".into() });
            assert!(l.parents.is_empty());
            assert_eq!(l.next_page_token.as_deref(), Some("PT2"));
            let kinds: Vec<&str> = l.items.iter().map(|i| i.kind.as_str()).collect();
            assert_eq!(kinds, ["folder", "video", "image", "audio", "video", "other"]);
            let v = &l.items[1];
            assert_eq!((v.size_bytes, v.duration_sec, v.width, v.height), (Some(1048576), Some(12.5), Some(1920), Some(1080)));
            assert_eq!(v.web_view_link.as_deref(), Some("https://drive/v1"));
            assert_eq!((l.items[2].width, l.items[2].height, l.items[2].duration_sec), (Some(4032), Some(3024), None));
            assert_eq!(l.items.iter().map(|i| i.owned_by_app).collect::<Vec<_>>(), [false, false, false, false, true, false]);
            assert_eq!(l.items[0].size_bytes, None);
            // The wire shape is the contract's camelCase.
            let wire = serde_json::to_value(&l).unwrap();
            assert!(wire["items"][1]["mimeType"].is_string() && wire["items"][1]["ownedByApp"].is_boolean() && wire["nextPageToken"] == "PT2");

            let l = d.list(Some("F2"), Some("o'k"), Some("PT2")).await.unwrap();
            assert_eq!(l.folder, CloudFolderRef { id: "F2".into(), name: "Clips".into() });
            assert_eq!(l.parents, vec![CloudFolderRef { id: "root".into(), name: "My Drive".into() }, CloudFolderRef { id: "F1".into(), name: "Phone".into() }]);
            assert!(l.next_page_token.is_none());
            assert!(d.list(Some("V1"), None, None).await.unwrap_err().contains("not a folder"));
            assert!(d.list(Some("bad id"), None, None).await.is_err());
            assert!(d.list(None, None, Some("bad token")).await.is_err());
        });
    }

    #[test]
    fn pull_streams_verifies_sha_and_lands_in_raw() {
        let content: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        let good_sha = sha(&content);
        let body = content.clone();
        tauri::async_runtime::block_on(async {
            let n = Arc::new(AtomicUsize::new(0));
            let srv = start(move |r: &Req| match (r.path(), r.query("alt").as_deref()) {
                ("/token", _) => token_resp(r, &n),
                ("/drive/v3/files/V1", Some("media")) => Resp::bytes(200, &body).with("Content-Type", "video/mp4"),
                ("/drive/v3/files/V1", None) => {
                    assert_eq!(r.query("fields").as_deref(), Some(META_FIELDS));
                    Resp::json(200, json!({ "id": "V1", "name": "take1", "mimeType": "video/mp4", "size": "50000", "sha256Checksum": "abc" }))
                }
                _ => Resp::json(404, json!({ "error": { "message": "File not found" } })),
            })
            .await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let meta = d.file_meta("V1").await.unwrap();
            assert_eq!((meta.size, meta.sha256.as_deref(), meta.mime_type.as_str()), (Some(50_000), Some("abc"), "video/mp4"));
            let root = tmp_root();
            let st = MediaState::in_memory(&root);
            let p = media::create_project(&st, "Drive Pull", None).unwrap();
            let uploads = root.join(&p.slug).join("working").join(".uploads");
            std::fs::create_dir_all(&uploads).unwrap();
            let (tr, log) = tracker_log();

            // Drive's checksum disagrees → failed, and no part file is left behind.
            let (id, cancel) = tr.create("pull", "take1", &p.slug, 50_000);
            let job = PullJob { transfer: id.clone(), cancel, meta: FileMeta { sha256: Some("00".repeat(32)), ..meta.clone() } };
            let part = uploads.join(format!("{id}.part"));
            let e = fetch_to_part(&d, &tr, &job, &part).await.unwrap_err();
            assert!(e.contains("SHA-256 mismatch"), "{e}");
            assert!(!part.exists());
            tr.settle(&id, Err(e));
            assert_eq!(tr.snapshot()[0].status, "failed");
            assert_eq!(std::fs::read_dir(&uploads).unwrap().count(), 0);
            assert!(std::fs::read_dir(root.join(&p.slug).join("raw")).unwrap().next().is_none());

            // Matching checksum (case-insensitive) → the exact bytes, then landed read-only via finalize.
            let (id, cancel) = tr.create("pull", "take1", &p.slug, 50_000);
            let job = PullJob { transfer: id.clone(), cancel, meta: FileMeta { sha256: Some(good_sha.to_uppercase()), ..meta.clone() } };
            let part = uploads.join(format!("{id}.part"));
            let size = fetch_to_part(&d, &tr, &job, &part).await.unwrap();
            assert_eq!(size, 50_000);
            assert_eq!(std::fs::read(&part).unwrap(), content);
            let display = pull_name(&meta.name, &meta.mime_type);
            assert_eq!(display, "take1.mp4");
            std::fs::write(root.join(&p.slug).join("raw").join("take1.mp4"), b"existing").unwrap();
            let a = land_pull(&st, &p.slug, &part, &display, "V1", size, |path, name| {
                Ok(MediaAsset { id: "a-1".into(), project: p.slug.clone(), kind: "video".into(), role: "clip".into(), name: name.into(), path: path.to_string_lossy().to_string(), read_only: true, size_bytes: size, duration_sec: None, width: None, height: None, thumb_path: None, added_at: media::now_iso() })
            })
            .unwrap();
            assert!(a.path.ends_with("take1-2.mp4"), "never overwrites: {}", a.path);
            assert_eq!(std::fs::read(root.join(&p.slug).join("raw").join("take1.mp4")).unwrap(), b"existing");
            assert_eq!(std::fs::read(&a.path).unwrap(), content);
            assert!(!part.exists());
            tr.settle(&id, Ok(TransferResult { asset_id: Some(a.id.clone()), ..Default::default() }));
            let t = &tr.snapshot()[0];
            assert_eq!((t.status.as_str(), t.bytes_done, t.result.as_ref().unwrap().asset_id.as_deref()), ("done", 50_000, Some("a-1")));
            let wire = serde_json::to_value(t).unwrap();
            assert_eq!(wire["result"], json!({ "assetId": "a-1" }));
            let h = history(&st, Some(&p.slug)).unwrap();
            assert_eq!((h.len(), h[0].direction.as_str(), h[0].drive_file_id.as_str(), h[0].size_bytes), (1, "pull", "V1", 50_000));
            assert!(history(&st, Some("other")).unwrap().is_empty());

            // A failing finalize removes the staged raw file again.
            let (id, cancel) = tr.create("pull", "take1", &p.slug, 50_000);
            let job = PullJob { transfer: id.clone(), cancel, meta: FileMeta { sha256: None, ..meta.clone() } };
            let part = uploads.join(format!("{id}.part"));
            fetch_to_part(&d, &tr, &job, &part).await.unwrap();
            let before = std::fs::read_dir(root.join(&p.slug).join("raw")).unwrap().count();
            assert!(land_pull(&st, &p.slug, &part, &display, "V1", size, |_, _| Err("no video stream".into())).is_err());
            assert_eq!(std::fs::read_dir(root.join(&p.slug).join("raw")).unwrap().count(), before);
            tr.settle(&id, Err("no video stream".into()));

            // A cancelled job never downloads.
            let (id, cancel) = tr.create("pull", "take1", &p.slug, 50_000);
            assert!(tr.cancel(&id));
            let job = PullJob { transfer: id.clone(), cancel, meta };
            assert_eq!(fetch_to_part(&d, &tr, &job, &uploads.join("c.part")).await.unwrap_err(), CANCELLED);
            tr.settle(&id, Err(CANCELLED.into()));
            assert_eq!(tr.snapshot()[0].status, "cancelled");
            assert!(!tr.cancel(&id));
            // Every status change was emitted.
            let statuses: Vec<String> = log.lock().unwrap().iter().map(|t| t.status.clone()).collect();
            assert!(statuses.contains(&"queued".into()) && statuses.contains(&"running".into()) && statuses.contains(&"done".into()) && statuses.contains(&"failed".into()));
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// Resumable upload mock: assembles the bytes it accepts; the second chunk first gets a 503,
    /// after which the status query says only 6 bytes arrived (so the client resumes from 6).
    fn upload_server(remote_sha: Arc<Mutex<Option<String>>>) -> impl Fn(&Req) -> Resp + Send + Sync {
        let n = AtomicUsize::new(0);
        let got: Mutex<Vec<u8>> = Mutex::new(vec![]);
        let fail_once = AtomicBool::new(true);
        move |r: &Req| match (r.method.as_str(), r.path()) {
            ("POST", "/token") => token_resp(r, &n),
            ("POST", "/upload/drive/v3/files") => {
                assert_eq!(r.query("uploadType").as_deref(), Some("resumable"));
                assert_eq!(r.query("fields").as_deref(), Some("id,webViewLink,sha256Checksum"));
                assert_eq!((r.header("x-upload-content-type"), r.header("x-upload-content-length")), (Some("video/mp4"), Some("10")));
                let m = r.json();
                assert_eq!(m["name"], "cut_v001.mp4");
                assert_eq!(m["parents"], json!(["OUTBOX"]));
                assert_eq!(m["appProperties"], json!({ "createdBy": APP_TAG, "project": "proj", "renderId": "r-1" }));
                let host = r.header("host").unwrap();
                Resp::json(200, json!({})).with("Location", &format!("http://{host}/upload/drive/v3/files?uploadType=resumable&upload_id=S1"))
            }
            ("PUT", "/upload/drive/v3/files") => {
                assert_eq!(r.query("upload_id").as_deref(), Some("S1"));
                assert!(r.bearer().is_some());
                let cr = r.header("content-range").unwrap().to_string();
                let mut g = got.lock().unwrap();
                if cr == "bytes */10" {
                    g.truncate(6); // pretend only 6 bytes survived the failed request
                    return Resp::bytes(308, b"").with("Range", "bytes=0-5");
                }
                let (range, total) = cr.strip_prefix("bytes ").unwrap().split_once('/').unwrap();
                assert_eq!(total, "10");
                let (a, b) = range.split_once('-').unwrap();
                let (a, b): (usize, usize) = (a.parse().unwrap(), b.parse().unwrap());
                assert_eq!(b - a + 1, r.body.len());
                if a == 4 && fail_once.swap(false, Ordering::SeqCst) {
                    g.extend_from_slice(&r.body); // received, but the reply is lost
                    return Resp::json(503, json!({ "error": { "message": "backend error" } }));
                }
                assert_eq!(a, g.len(), "client resumed from the wrong offset");
                g.extend_from_slice(&r.body);
                if g.len() < 10 {
                    return Resp::bytes(308, b"").with("Range", &format!("bytes=0-{}", g.len() - 1));
                }
                let sha = remote_sha.lock().unwrap().clone().unwrap_or_else(|| hex(&Sha256::digest(&g[..])));
                Resp::json(200, json!({ "id": "DRV1", "webViewLink": "https://drive/DRV1", "sha256Checksum": sha }))
            }
            _ => Resp::json(404, json!({})),
        }
    }

    #[test]
    fn push_resumes_after_308_and_a_503_and_checks_the_checksum() {
        tauri::async_runtime::block_on(async {
            let root = tmp_root();
            let file = root.join("cut_v001.mp4");
            std::fs::write(&file, b"0123456789").unwrap();
            let src = PushSource { render_id: "r-1".into(), project: "proj".into(), render_path: file.to_string_lossy().to_string(), path: file.clone(), name: "cut_v001.mp4".into(), size: 10 };

            let srv = start(upload_server(Arc::default())).await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let (tr, log) = tracker_log();
            let (id, cancel) = tr.create("push", &src.name, "proj", 10);
            let up = push_one(&d, &tr, &id, &cancel, &src, Some("OUTBOX".into())).await.unwrap();
            assert_eq!((up.id.as_str(), up.web_view_link.as_deref()), ("DRV1", Some("https://drive/DRV1")));
            assert_eq!(up.local_sha256, sha(b"0123456789"));
            let puts: Vec<String> = srv.reqs().iter().filter(|r| r.method == "PUT").map(|r| r.header("content-range").unwrap().to_string()).collect();
            assert_eq!(puts, ["bytes 0-3/10", "bytes 4-7/10", "bytes */10", "bytes 6-9/10"]);
            assert!(log.lock().unwrap().iter().any(|t| t.status == "running"));

            // Drive's checksum disagrees with the local file → failed.
            let srv = start(upload_server(Arc::new(Mutex::new(Some("ff".repeat(32)))))).await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let (id, cancel) = tr.create("push", &src.name, "proj", 10);
            let e = push_one(&d, &tr, &id, &cancel, &src, Some("OUTBOX".into())).await.unwrap_err();
            assert!(e.contains("SHA-256 mismatch"), "{e}");

            // An upload session on another host is refused.
            let srv = start(|r: &Req| match r.path() {
                "/token" => token_resp(r, &AtomicUsize::new(0)),
                _ => Resp::json(200, json!({})).with("Location", "https://evil.example/upload?upload_id=1"),
            })
            .await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let (id, cancel) = tr.create("push", &src.name, "proj", 10);
            assert!(push_one(&d, &tr, &id, &cancel, &src, None).await.unwrap_err().contains("unexpected host"));

            // Persistent 5xx → gives up after the retry budget.
            let srv = start(|r: &Req| match (r.method.as_str(), r.path()) {
                (_, "/token") => token_resp(r, &AtomicUsize::new(0)),
                ("POST", _) => {
                    let host = r.header("host").unwrap();
                    Resp::json(200, json!({})).with("Location", &format!("http://{host}/upload/drive/v3/files?upload_id=S9"))
                }
                _ => Resp::json(503, json!({})),
            })
            .await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let (id, cancel) = tr.create("push", &src.name, "proj", 10);
            let e = push_one(&d, &tr, &id, &cancel, &src, None).await.unwrap_err();
            assert!(e.contains("retries"), "{e}");
            assert_eq!(srv.reqs().iter().filter(|r| r.method == "PUT").count(), 1 + MAX_RETRIES as usize);
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    fn insert_render(st: &MediaState, id: &str, path: &Path) {
        let r = VerifiedRender {
            id: id.into(),
            project: "proj".into(),
            plan_id: "p-1".into(),
            path: path.to_string_lossy().to_string(),
            duration_sec: 1.0,
            width: 1920,
            height: 1080,
            size_bytes: 10,
            loudness_lufs: None,
            verify: media::VerifyInfo { ok: true, checks: vec![] },
            created_at: media::now_iso(),
        };
        let j = serde_json::to_string(&r).unwrap();
        st.with(|c| c.execute("INSERT INTO render (id, project, json, created_at) VALUES (?1, 'proj', ?2, ?3)", params![id, j, r.created_at]).map(|_| ()).map_err(media::sql_err)).unwrap();
    }

    #[test]
    fn push_needs_approval_and_a_verified_render_inside_the_projects_root() {
        let base = tmp_root();
        let root = base.join("projects");
        let renders = root.join("proj").join("renders");
        std::fs::create_dir_all(&renders).unwrap();
        let good = renders.join("cut_v001.mp4");
        std::fs::write(&good, b"0123456789").unwrap();
        let outside = base.join("elsewhere.mp4");
        std::fs::write(&outside, b"x").unwrap();
        let st = MediaState::in_memory(&root);
        insert_render(&st, "r-good", &good);
        insert_render(&st, "r-out", &outside);
        insert_render(&st, "r-gone", &renders.join("missing.mp4"));
        assert!(push_source(&st, "r-good", false).unwrap_err().starts_with("PERMISSION_REQUIRED:cloud-push"));
        assert!(push_source(&st, "r-nope", true).unwrap_err().contains("only verified renders"));
        assert!(push_source(&st, "r-out", true).unwrap_err().contains("outside"));
        assert!(push_source(&st, "r-gone", true).unwrap_err().contains("missing"));
        let s = push_source(&st, "r-good", true).unwrap();
        assert_eq!((s.render_id.as_str(), s.project.as_str(), s.name.as_str(), s.size), ("r-good", "proj", "cut_v001.mp4", 10));
        assert_eq!(s.render_path, good.to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn share_needs_approval_and_a_file_this_app_pushed() {
        tauri::async_runtime::block_on(async {
            let n = Arc::new(AtomicUsize::new(0));
            let srv = start(move |r: &Req| match (r.method.as_str(), r.path()) {
                ("POST", "/token") => token_resp(r, &n),
                ("POST", "/drive/v3/files/DRV1/permissions") => {
                    assert_eq!(r.json(), json!({ "role": "reader", "type": "anyone" }));
                    Resp::json(200, json!({ "id": "anyoneWithLink" }))
                }
                ("GET", "/drive/v3/files/DRV1") => Resp::json(200, json!({ "webViewLink": "https://drive.google.com/file/d/DRV1/view" })),
                _ => Resp::json(404, json!({})),
            })
            .await;
            let (d, _) = drive(&srv.base, Some("r1"));
            let root = tmp_root();
            let st = MediaState::in_memory(&root);
            record_sync(&st, "pull", "proj", "C:/raw/a.mp4", "PULLED", "a.mp4", 1, None).unwrap();
            record_sync(&st, "push", "proj", "C:/renders/cut.mp4", "DRV1", "cut.mp4", 10, None).unwrap();
            assert!(share_file(&d, &st, "DRV1", false).await.unwrap_err().starts_with("PERMISSION_REQUIRED:cloud-share"));
            assert!(share_file(&d, &st, "PULLED", true).await.unwrap_err().contains("only files this app uploaded"));
            assert!(share_file(&d, &st, "UNKNOWN", true).await.is_err());
            assert!(share_file(&d, &st, "a'b", true).await.is_err());
            assert_eq!(srv.count("POST", "/drive/v3/files/DRV1/permissions"), 0);
            let link = share_file(&d, &st, "DRV1", true).await.unwrap();
            assert_eq!(link, "https://drive.google.com/file/d/DRV1/view");
            let h = history(&st, None).unwrap();
            let push = h.iter().find(|r| r.direction == "push").unwrap();
            assert_eq!(push.web_view_link.as_deref(), Some(link.as_str()));
            let wire = serde_json::to_value(push).unwrap();
            assert!(wire["driveFileId"] == "DRV1" && wire["localPath"].is_string() && wire["sizeBytes"] == 10);
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn folders_round_trip_through_kv() {
        let root = tmp_root();
        let st = MediaState::in_memory(&root);
        assert_eq!(folders(&st), (None, None));
        let f = |id: &str, name: &str| CloudFolderRef { id: id.into(), name: name.into() };
        set_folders(&st, Some(Some(f("IN1", " Camera "))), Some(Some(f("OUT1", "Renders")))).unwrap();
        assert_eq!(folders(&st), (Some(f("IN1", "Camera")), Some(f("OUT1", "Renders"))));
        set_folders(&st, None, Some(None)).unwrap(); // inbox untouched, outbox cleared
        assert_eq!(folders(&st), (Some(f("IN1", "Camera")), None));
        assert!(set_folders(&st, Some(Some(f("bad id", "x"))), None).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tracker_throttles_progress_and_keeps_twenty_finished() {
        let (tr, log) = tracker_log();
        let (id, _) = tr.create("pull", "a", "p", 100);
        tr.start(&id);
        for i in 1..=50 {
            tr.progress(&id, i);
        }
        // queued + running; the 50 quick progress ticks fall inside one 500 ms window.
        assert_eq!(log.lock().unwrap().len(), 2);
        assert_eq!(tr.snapshot()[0].bytes_done, 50);
        tr.settle(&id, Ok(TransferResult::default()));
        for _ in 0..25 {
            let (id, _) = tr.create("pull", "b", "p", 1);
            tr.settle(&id, Err("boom".into()));
        }
        let snap = tr.snapshot();
        assert_eq!(snap.len(), KEEP_FINISHED);
        assert!(snap.iter().all(|t| t.status == "failed" && t.error.as_deref() == Some("boom")));
        assert!(snap[0].id.starts_with("x-"));
    }

    #[test]
    fn media_db_migrates_v1_to_v2_keeping_rows() {
        let dir = tmp_root();
        let path = dir.join("media.db");
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            c.execute_batch(media::MIGRATIONS[0]).unwrap();
            c.execute_batch("PRAGMA user_version = 1").unwrap();
            c.execute("INSERT INTO project (slug, json, updated_at) VALUES ('old', '{}', 'x')", []).unwrap();
        }
        let mut c = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(media::migrate(&mut c).unwrap(), 2);
        let v: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM project WHERE slug = 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        c.execute("INSERT INTO kv (key, value) VALUES ('k', 'v')", []).unwrap();
        c.execute("INSERT INTO drive_sync (id, provider, direction, project, local_path, drive_file_id, name, size_bytes, at) VALUES ('s', 'gdrive', 'push', 'p', 'l', 'f', 'n', 1, 'x')", []).unwrap();
        assert!(c.execute("INSERT INTO drive_sync (id, provider, direction, project, local_path, drive_file_id, name, size_bytes, at) VALUES ('s2', 'gdrive', 'sideways', 'p', 'l', 'f', 'n', 1, 'x')", []).is_err());
        // Idempotent.
        assert_eq!(media::migrate(&mut c).unwrap(), 2);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
