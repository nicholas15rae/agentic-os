//! Instagram API with Instagram Login (`graph.instagram.com`, Graph API v26.0).
//!
//! Credentials: `INSTAGRAM_ACCESS_TOKEN` (env, else the repo-root `.env`, else the
//! `instagram-token` keychain entry Settings saves) — read fresh on every call, and never
//! sent to the webview. `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` are optional here (the
//! webhook in `server.py` uses the secret to check Meta's signature).
//!
//! Long-lived tokens last 60 days. `refresh_loop` renews them (`grant_type=ig_refresh_token`,
//! valid once a token is ≥ 24 h old) when under 15 days remain or the expiry is unknown, and
//! keeps the renewed token in the internal keychain entry `instagram-refreshed`, bound to a
//! fingerprint of the base token: paste a new token and the stored one is ignored.
//!
//! Tools: `instagram.get_profile`, `instagram.list_media`, `instagram.list_comments` are
//! read-only (router-safe). `instagram.reply_comment` and `instagram.publish_post` are
//! mutating: refused from the router (`is_mutating_tool`, and `approved` is always false
//! there) and run only through `instagram_reply_comment` / `instagram_publish_post` after the
//! user approves the confirmation card. The kill switch blocks everything (cloud service).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

use super::bridge::BridgeState;
use super::dispatch::{short, DispatchState};
use super::envfile::KeySource;
use super::os_core::{self, OsState};

const API: &str = "https://graph.instagram.com/v26.0";
const REFRESH_URL: &str = "https://graph.instagram.com/refresh_access_token";
pub const SECRET: &str = "instagram-token";
pub const REFRESHED: &str = "instagram-refreshed";
pub(crate) const NO_TOKEN: &str = "Instagram: no access token — set INSTAGRAM_ACCESS_TOKEN in the repo-root .env (or paste it in Settings → Integrations)";
const REFRESH_WITHIN: u64 = 15 * 24 * 3600;
const REFRESH_RETRY: Duration = Duration::from_secs(12 * 3600);
const CAPTION_MAX: usize = 2200;

/// The renewed token, bound to the base token it came from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Refreshed {
    access_token: String,
    expires_at: u64,
    refreshed_at: u64,
    base_fp: String,
}

pub(crate) fn fingerprint(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.trim().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The token to use: a stored renewal of the current base token, else the base token.
pub(crate) fn pick_token(base: Option<String>, stored: Option<Refreshed>) -> Option<(String, Option<Refreshed>)> {
    let base = base?.trim().to_string();
    if base.is_empty() {
        return None;
    }
    match stored.filter(|r| r.base_fp == fingerprint(&base) && r.expires_at > os_core::now_secs()) {
        Some(r) => Some((r.access_token.clone(), Some(r))),
        None => Some((base, None)),
    }
}

fn stored() -> Option<Refreshed> {
    serde_json::from_str(&os_core::os_secret(REFRESHED)?).ok()
}

fn base_token(state: &DispatchState) -> Option<String> {
    super::envfile::os_key(state, SECRET)
}

fn token(state: &DispatchState) -> Result<(String, Option<Refreshed>), String> {
    pick_token(base_token(state), stored()).ok_or_else(|| NO_TOKEN.into())
}

/// A Graph error body → a short message (never contains the token).
pub(crate) fn graph_error(status: u16, body: &Value) -> String {
    let e = &body["error"];
    let msg = e["message"].as_str().unwrap_or("request failed");
    match e["code"].as_i64() {
        Some(190) => "Instagram token is invalid or expired — paste a fresh INSTAGRAM_ACCESS_TOKEN (Settings → Integrations shows its status)".into(),
        Some(10) | Some(200) => format!("Instagram permission missing: {msg}"),
        Some(4) | Some(17) | Some(32) | Some(613) => "Instagram rate limit reached — try again later".into(),
        Some(c) => format!("Instagram error {c}: {msg}"),
        None => format!("Instagram HTTP {status}: {msg}"),
    }
}

async fn graph(state: &DispatchState, method: reqwest::Method, path: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let (tok, _) = token(state)?;
    let url = format!("{API}/{}", path.trim_start_matches('/'));
    let mut q: Vec<(&str, String)> = params.to_vec();
    q.push(("access_token", tok));
    let req = if method == reqwest::Method::GET { state.http.get(&url).query(&q) } else { state.http.post(&url).form(&q) };
    let r = req.header(reqwest::header::USER_AGENT, super::maps::USER_AGENT).timeout(Duration::from_secs(20)).send().await.map_err(|e| format!("Instagram {}", short(e)))?;
    let status = r.status().as_u16();
    let body: Value = r.json().await.map_err(|e| format!("Instagram {}", short(e)))?;
    if (200..300).contains(&status) && body.get("error").is_none() {
        Ok(body)
    } else {
        Err(graph_error(status, &body))
    }
}

fn blocked(os: &OsState) -> Result<(), String> {
    if os.snapshot().privacy.kill_switch {
        Err("kill switch is on — Instagram is a cloud service".into())
    } else {
        Ok(())
    }
}

fn arg<'a>(args: &'a Value, k: &str) -> &'a str {
    args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn arg_num(args: &Value, k: &str, default: u64, max: u64) -> u64 {
    args.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())).unwrap_or(default).clamp(1, max)
}

fn arg_bool(args: &Value, k: &str) -> bool {
    args.get(k).is_some_and(|v| v.as_bool().unwrap_or_else(|| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case("true"))))
}

/// Graph ids are numeric (media, comments, users).
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_digit())
}

const PROFILE_FIELDS: &str = "user_id,username,name,account_type,followers_count,follows_count,media_count";

pub(crate) fn format_profile(v: &Value) -> String {
    let n = |k: &str| v[k].as_u64().map(|x| x.to_string()).unwrap_or_else(|| "?".into());
    format!(
        "Instagram @{} ({}{}): {} followers · following {} · {} posts.",
        v["username"].as_str().unwrap_or("?"),
        v["account_type"].as_str().unwrap_or("account").to_lowercase().replace('_', " "),
        v["name"].as_str().filter(|s| !s.is_empty()).map(|s| format!(", {s}")).unwrap_or_default(),
        n("followers_count"),
        n("follows_count"),
        n("media_count")
    )
}

fn compact(s: &str, max: usize) -> String {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s
    }
}

pub(crate) fn format_media(items: &[Value], insights: &[(String, String)]) -> String {
    if items.is_empty() {
        return "No posts yet.".into();
    }
    items
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let id = m["id"].as_str().unwrap_or("");
            let kind = match (m["media_product_type"].as_str(), m["media_type"].as_str()) {
                (Some("REELS"), _) => "Reel",
                (_, Some("CAROUSEL_ALBUM")) => "Carousel",
                (_, Some("VIDEO")) => "Video",
                _ => "Photo",
            };
            let date = m["timestamp"].as_str().and_then(|t| t.get(..10)).unwrap_or("");
            let mut line = format!(
                "{}. {kind} {date} — {} likes, {} comments — \"{}\" (id {id}) {}",
                i + 1,
                m["like_count"].as_u64().unwrap_or(0),
                m["comments_count"].as_u64().unwrap_or(0),
                compact(m["caption"].as_str().unwrap_or(""), 90),
                m["permalink"].as_str().unwrap_or("")
            );
            if let Some((_, s)) = insights.iter().find(|(mid, _)| mid == id) {
                line.push_str(&format!("\n   insights: {s}"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn format_insights(v: &Value) -> String {
    let parts: Vec<String> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some(format!("{} {}", m["name"].as_str()?, m["values"][0]["value"].as_u64().or(m["total_value"]["value"].as_u64())?)))
        .collect();
    if parts.is_empty() {
        "none".into()
    } else {
        parts.join(", ")
    }
}

pub(crate) fn format_comments(v: &Value) -> String {
    let rows: Vec<String> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let replies = c["replies"]["data"].as_array().map(|r| r.len()).unwrap_or(0);
            format!(
                "- @{}: \"{}\" ({}, comment id {}{})",
                c["username"].as_str().or(c["from"]["username"].as_str()).unwrap_or("?"),
                compact(c["text"].as_str().unwrap_or(""), 200),
                c["timestamp"].as_str().and_then(|t| t.get(..10)).unwrap_or(""),
                c["id"].as_str().unwrap_or(""),
                if replies > 0 { format!(", {replies} replies") } else { String::new() }
            )
        })
        .collect();
    if rows.is_empty() {
        "No comments.".into()
    } else {
        rows.join("\n")
    }
}

/// `name` is an `instagram.*` builtin. The two writes need `approved` (only the Tauri commands pass it).
pub(crate) async fn tool(state: &DispatchState, os: &OsState, name: &str, args: &Value, approved: bool) -> Result<String, String> {
    blocked(os)?;
    match name {
        "instagram.get_profile" => Ok(format_profile(&graph(state, reqwest::Method::GET, "me", &[("fields", PROFILE_FIELDS.into())]).await?)),
        "instagram.list_media" => {
            let limit = arg_num(args, "limit", 5, 25);
            let v = graph(state, reqwest::Method::GET, "me/media", &[("fields", "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count".into()), ("limit", limit.to_string())]).await?;
            let items = v["data"].as_array().cloned().unwrap_or_default();
            let mut insights = Vec::new();
            if arg_bool(args, "insights") {
                for m in items.iter().take(3) {
                    let Some(id) = m["id"].as_str() else { continue };
                    let s = match graph(state, reqwest::Method::GET, &format!("{id}/insights"), &[("metric", "reach,likes,comments,saved,shares".into())]).await {
                        Ok(v) => format_insights(&v),
                        Err(e) => format!("unavailable ({e})"),
                    };
                    insights.push((id.to_string(), s));
                }
            }
            Ok(format_media(&items, &insights))
        }
        "instagram.list_comments" => {
            let id = arg(args, "media_id");
            if !valid_id(id) {
                return Err("instagram.list_comments needs a media_id (from instagram.list_media)".into());
            }
            let limit = arg_num(args, "limit", 20, 50);
            let v = graph(state, reqwest::Method::GET, &format!("{id}/comments"), &[("fields", "id,text,username,timestamp,replies{id}".into()), ("limit", limit.to_string())]).await?;
            Ok(format_comments(&v))
        }
        "instagram.reply_comment" => {
            if !approved {
                return Err("PERMISSION_REQUIRED:instagram-reply".into());
            }
            let (id, message) = reply_fields(args)?;
            let v = graph(state, reqwest::Method::POST, &format!("{id}/replies"), &[("message", message.clone())]).await?;
            Ok(format!("Replied on Instagram: \"{}\" (reply id {}).", compact(&message, 80), v["id"].as_str().unwrap_or("?")))
        }
        "instagram.publish_post" => {
            if !approved {
                return Err("PERMISSION_REQUIRED:instagram-publish".into());
            }
            publish(state, &publish_fields(args)?).await
        }
        _ => Err(format!("unknown Instagram tool {name}")),
    }
}

pub(crate) fn reply_fields(args: &Value) -> Result<(String, String), String> {
    let id = arg(args, "comment_id");
    let message = arg(args, "message");
    if !valid_id(id) {
        return Err("a reply needs the comment id (from instagram.list_comments)".into());
    }
    if message.is_empty() || message.chars().count() > 2200 {
        return Err("a reply needs a message (up to 2,200 characters)".into());
    }
    Ok((id.to_string(), message.to_string()))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PublishFields {
    pub image_url: Option<String>,
    pub video_url: Option<String>,
    pub caption: String,
}

/// Media must be a public https URL (Meta fetches it); never loopback / private / mesh.
pub(crate) fn public_media_url(raw: &str) -> Result<String, String> {
    let u = url::Url::parse(raw.trim()).map_err(|_| "the media URL isn't a valid URL".to_string())?;
    if u.scheme() != "https" {
        return Err("the media URL must be https (Instagram downloads it from the public internet)".into());
    }
    let private = match u.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || d.ends_with(".internal")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || (ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1])),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        None => true,
    };
    if private {
        return Err("the media URL must be publicly reachable, not a local or private address".into());
    }
    Ok(u.to_string())
}

pub(crate) fn publish_fields(args: &Value) -> Result<PublishFields, String> {
    let image = arg(args, "image_url");
    let video = arg(args, "video_url");
    let caption = arg(args, "caption").to_string();
    if image.is_empty() == video.is_empty() {
        return Err("a post needs exactly one of image_url or video_url (a public https link)".into());
    }
    if caption.chars().count() > CAPTION_MAX {
        return Err("captions are limited to 2,200 characters".into());
    }
    Ok(PublishFields {
        image_url: (!image.is_empty()).then(|| public_media_url(image)).transpose()?,
        video_url: (!video.is_empty()).then(|| public_media_url(video)).transpose()?,
        caption,
    })
}

/// Two-step container flow: `POST /{user}/media` → wait for FINISHED → `POST /{user}/media_publish`.
async fn publish(state: &DispatchState, f: &PublishFields) -> Result<String, String> {
    let me = graph(state, reqwest::Method::GET, "me", &[("fields", "user_id,username".into())]).await?;
    let user = me["user_id"].as_str().map(String::from).or_else(|| me["user_id"].as_u64().map(|n| n.to_string())).or_else(|| me["id"].as_str().map(String::from)).ok_or("Instagram didn't return your user id")?;
    let mut params = vec![("caption", f.caption.clone())];
    match (&f.image_url, &f.video_url) {
        (Some(img), _) => params.push(("image_url", img.clone())),
        (_, Some(vid)) => {
            params.push(("media_type", "REELS".into()));
            params.push(("video_url", vid.clone()));
        }
        _ => return Err("nothing to publish".into()),
    }
    let container = graph(state, reqwest::Method::POST, &format!("{user}/media"), &params).await?;
    let cid = container["id"].as_str().ok_or("Instagram didn't return a media container")?.to_string();
    // Images are usually ready at once; Reels take a while to process.
    let tries = if f.video_url.is_some() { 60 } else { 10 };
    let mut ready = false;
    for _ in 0..tries {
        let s = graph(state, reqwest::Method::GET, &cid, &[("fields", "status_code,status".into())]).await?;
        match s["status_code"].as_str().unwrap_or("") {
            "FINISHED" => {
                ready = true;
                break;
            }
            "ERROR" | "EXPIRED" => return Err(format!("Instagram couldn't process the media ({}) — nothing was published", s["status"].as_str().unwrap_or("error"))),
            _ => tokio::time::sleep(Duration::from_secs(5)).await,
        }
    }
    if !ready {
        return Err("Instagram is still processing the media — nothing was published yet; try again in a minute".into());
    }
    let published = graph(state, reqwest::Method::POST, &format!("{user}/media_publish"), &[("creation_id", cid)]).await?;
    let mid = published["id"].as_str().unwrap_or("").to_string();
    let link = if valid_id(&mid) {
        graph(state, reqwest::Method::GET, &mid, &[("fields", "permalink".into())]).await.ok().and_then(|v| v["permalink"].as_str().map(String::from))
    } else {
        None
    };
    Ok(format!("Published to Instagram @{}{}.", me["username"].as_str().unwrap_or("?"), link.map(|l| format!(" — {l}")).unwrap_or_default()))
}

// ── Token refresh ───────────────────────────────────────────────────────────

static LAST_ATTEMPT: Mutex<Option<Instant>> = Mutex::new(None);

/// Refresh when the expiry is unknown or under 15 days away.
pub(crate) fn refresh_due(current: Option<&Refreshed>, now: u64) -> bool {
    current.is_none_or(|r| r.expires_at.saturating_sub(now) < REFRESH_WITHIN)
}

/// Renew the long-lived token now. Ok(expires_at).
pub(crate) async fn refresh_now(state: &DispatchState) -> Result<u64, String> {
    let base = base_token(state).ok_or(NO_TOKEN)?;
    let (tok, _) = token(state)?;
    *LAST_ATTEMPT.lock().unwrap() = Some(Instant::now());
    let r = state
        .http
        .get(REFRESH_URL)
        .query(&[("grant_type", "ig_refresh_token"), ("access_token", tok.as_str())])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Instagram refresh {}", short(e)))?;
    let status = r.status().as_u16();
    let body: Value = r.json().await.map_err(|e| format!("Instagram refresh {}", short(e)))?;
    let new = body["access_token"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| graph_error(status, &body))?;
    let now = os_core::now_secs();
    let rec = Refreshed { access_token: new.to_string(), expires_at: now + body["expires_in"].as_u64().unwrap_or(60 * 24 * 3600), refreshed_at: now, base_fp: fingerprint(&base) };
    os_core::os_secret_store(REFRESHED, &serde_json::to_string(&rec).map_err(|e| e.to_string())?)?;
    *STATUS.lock().unwrap() = None;
    Ok(rec.expires_at)
}

/// Background renewal: checks every 6 h; retries a failed/too-early refresh after 12 h.
pub async fn refresh_loop(app: tauri::AppHandle) {
    tokio::time::sleep(Duration::from_secs(90)).await;
    loop {
        let state = app.state::<DispatchState>();
        let os = app.state::<OsState>();
        let on = os.snapshot().mcps.iter().any(|m| m.id == "instagram" && m.enabled) && !os.snapshot().privacy.kill_switch;
        let recent = LAST_ATTEMPT.lock().unwrap().is_some_and(|t| t.elapsed() < REFRESH_RETRY);
        if on && !recent {
            if let Ok((_, current)) = token(&state) {
                if refresh_due(current.as_ref(), os_core::now_secs()) {
                    match refresh_now(&state).await {
                        Ok(_) => eprintln!("[instagram] token renewed"),
                        Err(e) => eprintln!("[instagram] token refresh skipped: {e}"),
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstagramStatus {
    /// "ok" | "error" | "missing" | "off" | "blocked"
    pub status: String,
    pub source: Option<KeySource>,
    pub username: Option<String>,
    pub account_type: Option<String>,
    pub followers: Option<u64>,
    pub media_count: Option<u64>,
    /// Unix seconds; None = unknown (the pasted token hasn't been renewed by the app yet).
    pub token_expires_at: Option<u64>,
    pub refreshed_at: Option<u64>,
    pub detail: String,
}

static STATUS: Mutex<Option<(Instant, InstagramStatus)>> = Mutex::new(None);

/// Live status: `GET /me` (cached 60 s; `force` re-checks). Settings polls this, so a token
/// added to `.env` shows as connected without a restart.
#[tauri::command]
pub async fn instagram_status(state: State<'_, DispatchState>, os: State<'_, OsState>, force: Option<bool>) -> Result<InstagramStatus, String> {
    let cfg = os.snapshot();
    let source = super::envfile::key_source(&state, SECRET);
    let picked = token(&state).ok();
    let mut st = InstagramStatus {
        source: Some(source),
        token_expires_at: picked.as_ref().and_then(|(_, r)| r.as_ref().map(|r| r.expires_at)),
        refreshed_at: picked.as_ref().and_then(|(_, r)| r.as_ref().map(|r| r.refreshed_at)),
        ..Default::default()
    };
    if picked.is_none() {
        st.status = "missing".into();
        st.detail = NO_TOKEN.into();
        return Ok(st);
    }
    if cfg.privacy.kill_switch {
        st.status = "blocked".into();
        st.detail = "Kill switch is on — Instagram is a cloud service.".into();
        return Ok(st);
    }
    if !cfg.mcps.iter().any(|m| m.id == "instagram" && m.enabled) {
        st.status = "off".into();
        st.detail = "Instagram tools are switched off.".into();
        return Ok(st);
    }
    let fp = picked.as_ref().map(|(t, _)| fingerprint(t));
    if !force.unwrap_or(false) {
        if let Some((at, cached)) = STATUS.lock().unwrap().clone() {
            if at.elapsed() < Duration::from_secs(60) && cached.detail.ends_with(&format!("#{}", fp.clone().unwrap_or_default())) {
                return Ok(InstagramStatus { detail: cached.detail.rsplit_once(" #").map(|(d, _)| d.to_string()).unwrap_or_default(), ..cached });
            }
        }
    }
    match graph(&state, reqwest::Method::GET, "me", &[("fields", PROFILE_FIELDS.into())]).await {
        Ok(v) => {
            st.status = "ok".into();
            st.username = v["username"].as_str().map(String::from);
            st.account_type = v["account_type"].as_str().map(String::from);
            st.followers = v["followers_count"].as_u64();
            st.media_count = v["media_count"].as_u64();
            st.detail = format_profile(&v);
        }
        Err(e) => {
            st.status = "error".into();
            st.detail = e;
        }
    }
    let mut cached = st.clone();
    cached.detail = format!("{} #{}", cached.detail, fp.unwrap_or_default());
    *STATUS.lock().unwrap() = Some((Instant::now(), cached));
    Ok(st)
}

#[tauri::command]
pub async fn instagram_refresh_token(state: State<'_, DispatchState>, os: State<'_, OsState>) -> Result<String, String> {
    blocked(&os)?;
    let exp = refresh_now(&state).await?;
    let days = exp.saturating_sub(os_core::now_secs()) / 86_400;
    Ok(format!("Instagram token renewed — valid for about {days} more days."))
}

fn approved_gate(os: &OsState, bridge: &BridgeState, tool: &str, approved: Option<bool>, deny_code: &str) -> Result<(), String> {
    if !approved.unwrap_or(false) {
        return Err(format!("PERMISSION_REQUIRED:{deny_code}"));
    }
    let cfg = os.snapshot();
    os_core::gate(bridge, cfg.permissions.mcp, "mcp", true, json!({ "tool": tool }))?;
    if !cfg.mcps.iter().any(|m| m.id == "instagram" && m.enabled) {
        return Err("Instagram is switched off — enable it in Settings → Skills & MCP Library".into());
    }
    Ok(())
}

/// Approved-card path for comment replies.
#[tauri::command]
pub async fn instagram_reply_comment(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, comment_id: String, message: String, approved: Option<bool>) -> Result<String, String> {
    approved_gate(&os, &bridge, "instagram.reply_comment", approved, "instagram-reply")?;
    let out = tool(&state, &os, "instagram.reply_comment", &json!({ "comment_id": comment_id, "message": message }), true).await;
    bridge.log(json!({ "type": "os-tool", "tool": "instagram.reply_comment", "ok": out.is_ok() }));
    out
}

/// Approved-card path for publishing a post / Reel live.
#[tauri::command]
pub async fn instagram_publish_post(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, caption: String, image_url: Option<String>, video_url: Option<String>, approved: Option<bool>) -> Result<String, String> {
    approved_gate(&os, &bridge, "instagram.publish_post", approved, "instagram-publish")?;
    let out = tool(&state, &os, "instagram.publish_post", &json!({ "caption": caption, "image_url": image_url.unwrap_or_default(), "video_url": video_url.unwrap_or_default() }), true).await;
    bridge.log(json!({ "type": "os-tool", "tool": "instagram.publish_post", "ok": out.is_ok() }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(base: &str, exp: u64) -> Refreshed {
        Refreshed { access_token: "renewed".into(), expires_at: exp, refreshed_at: 1, base_fp: fingerprint(base) }
    }

    #[test]
    fn stored_renewal_used_only_for_its_own_base_token() {
        let far = os_core::now_secs() + 30 * 86_400;
        assert_eq!(pick_token(Some("base".into()), Some(rec("base", far))).unwrap().0, "renewed");
        // A newly pasted token wins over a renewal of the old one.
        assert_eq!(pick_token(Some("new".into()), Some(rec("base", far))).unwrap().0, "new");
        // An expired renewal falls back to the base token.
        assert_eq!(pick_token(Some("base".into()), Some(rec("base", 10))).unwrap().0, "base");
        assert_eq!(pick_token(None, Some(rec("base", far))), None);
        assert_eq!(pick_token(Some("  ".into()), None), None);
    }

    #[test]
    fn refresh_due_when_unknown_or_close_to_expiry() {
        let now = 1_000_000_000;
        assert!(refresh_due(None, now));
        assert!(refresh_due(Some(&rec("b", now + 10 * 86_400)), now));
        assert!(!refresh_due(Some(&rec("b", now + 40 * 86_400)), now));
    }

    #[test]
    fn graph_errors_mapped_without_tokens() {
        assert!(graph_error(400, &json!({ "error": { "message": "Error validating access token", "code": 190 } })).contains("invalid or expired"));
        assert!(graph_error(400, &json!({ "error": { "message": "x", "code": 4 } })).contains("rate limit"));
        assert_eq!(graph_error(500, &json!({})), "Instagram HTTP 500: request failed");
    }

    #[test]
    fn profile_media_and_comments_formatted() {
        let p = json!({ "username": "gabagool", "account_type": "BUSINESS", "name": "Nic", "followers_count": 1200, "follows_count": 80, "media_count": 42 });
        assert_eq!(format_profile(&p), "Instagram @gabagool (business, Nic): 1200 followers · following 80 · 42 posts.");
        let media = vec![json!({ "id": "1789", "media_type": "VIDEO", "media_product_type": "REELS", "timestamp": "2026-11-01T10:00:00+0000", "like_count": 10, "comments_count": 2, "caption": "Set day", "permalink": "https://www.instagram.com/reel/x/" })];
        let s = format_media(&media, &[("1789".into(), "reach 500".into())]);
        assert!(s.starts_with("1. Reel 2026-11-01 — 10 likes, 2 comments — \"Set day\" (id 1789)"), "{s}");
        assert!(s.contains("insights: reach 500"));
        let ins = json!({ "data": [{ "name": "reach", "values": [{ "value": 500 }] }, { "name": "saved", "total_value": { "value": 7 } }] });
        assert_eq!(format_insights(&ins), "reach 500, saved 7");
        let c = json!({ "data": [{ "id": "555", "text": "Love it", "username": "fan", "timestamp": "2026-11-02T00:00:00+0000", "replies": { "data": [{ "id": "1" }] } }] });
        assert_eq!(format_comments(&c), "- @fan: \"Love it\" (2026-11-02, comment id 555, 1 replies)");
    }

    #[test]
    fn publish_and_reply_fields_validated() {
        assert!(publish_fields(&json!({ "caption": "hi" })).is_err());
        assert!(publish_fields(&json!({ "image_url": "https://x.com/a.jpg", "video_url": "https://x.com/b.mp4" })).is_err());
        assert!(publish_fields(&json!({ "image_url": "http://x.com/a.jpg" })).is_err());
        for bad in ["https://localhost/a.jpg", "https://127.0.0.1/a.jpg", "https://192.168.1.4/a.jpg", "https://100.70.1.2/a.jpg", "https://[::1]/a.jpg"] {
            assert!(publish_fields(&json!({ "image_url": bad })).is_err(), "{bad}");
        }
        let f = publish_fields(&json!({ "image_url": "https://cdn.example.com/a.jpg", "caption": "New headshots" })).unwrap();
        assert_eq!(f.image_url.as_deref(), Some("https://cdn.example.com/a.jpg"));
        assert!(reply_fields(&json!({ "comment_id": "abc", "message": "thanks" })).is_err());
        assert!(reply_fields(&json!({ "comment_id": "123", "message": "" })).is_err());
        assert_eq!(reply_fields(&json!({ "comment_id": "123", "message": "thanks!" })).unwrap(), ("123".into(), "thanks!".into()));
    }

    #[test]
    fn writes_refuse_without_approval() {
        let st = DispatchState::default();
        let os = OsState::default();
        tauri::async_runtime::block_on(async {
            for t in ["instagram.reply_comment", "instagram.publish_post"] {
                let e = tool(&st, &os, t, &json!({}), false).await.unwrap_err();
                assert!(e.starts_with("PERMISSION_REQUIRED:"), "{t}: {e}");
            }
        });
    }
}
