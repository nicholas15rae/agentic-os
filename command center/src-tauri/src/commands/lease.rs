//! Loopback GPU lease API for the gateway (Trading = Tier 1).
//!
//! An always-on HTTP/1.1 server on `127.0.0.1:8792` so the Python gateway can hold the desktop's
//! GPU slot while the Trading Agent generates: it queues at its policy tier (label
//! `gateway · trading`, so the tiers and the arbiter both see Trading) and, while it holds, no
//! desktop job runs alongside it on the card.
//!
//! - `POST /arbiter/acquire {"node":"trading","maxWaitMs":90000,"ttlMs":120000}` → blocks until the
//!   slot is granted: `200 {"leaseId","waitedMs","tier","ttlMs"}`; `408` once `maxWaitMs` passes
//!   (the waiter is dropped cleanly); `403` for a node outside [`ALLOWED_NODES`]. A client that
//!   hangs up while waiting gives its place back.
//! - `POST /arbiter/release {"leaseId"}` → `200 {"released":true|false}`.
//! - `GET /arbiter/state` → the slot's `SlotDetail`.
//!
//! Leases auto-release after `ttlMs` (default 120 s, max 300 s); an expired lease keeps the permit
//! for a 1.5 s settle window (its generation may still be finishing).
//!
//! Auth: `Authorization: Bearer <token>`, compared in constant time. The token is 256 random bits
//! minted at every launch and written to `<config>/telemetry/lease.token` (one line, no newline;
//! under %APPDATA%, so only this Windows user can read it). The gateway re-reads the file after a
//! 401. The mesh bearer is NOT used: it only exists while Network Lock is on. No token file (the
//! telemetry folder could not be written) → every request gets `503`. Loopback only, 8 KB request cap, 64
//! headers, 5 s read timeout, at most 16 connections. Telemetry (`lease` events) carries labels
//! and numbers only.

use super::scheduler::{GpuSlot, SlotGuard};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const PORT: u16 = 8792;
/// `<config>/telemetry/lease.token`: this launch's bearer token for the gateway.
pub const TOKEN_FILE: &str = "lease.token";
/// Nodes the gateway may lease the GPU for.
pub const ALLOWED_NODES: [&str; 1] = ["trading"];
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_HEADERS: usize = 64;
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_CONNECTIONS: usize = 16;
pub const DEFAULT_TTL_MS: u64 = 120_000;
pub const MAX_TTL_MS: u64 = 300_000;
const MIN_TTL_MS: u64 = 1_000;
pub const DEFAULT_MAX_WAIT_MS: u64 = 90_000;
pub const MAX_WAIT_CAP_MS: u64 = 600_000;
/// An expired lease's generation may still be running: keep the permit this long.
pub const EXPIRY_SETTLE: Duration = Duration::from_millis(1_500);

fn ms(d: Duration) -> u64 {
    d.as_millis().min(u64::MAX as u128) as u64
}

// ── HTTP parsing (pure) ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub method: String,
    /// Without the query string.
    pub path: String,
    /// Lower-cased names.
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// A status + reason the server answers with (no echo of the request).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Fail {
    pub status: u16,
    pub msg: String,
}

fn fail(status: u16, msg: impl Into<String>) -> Fail {
    Fail { status, msg: msg.into() }
}

/// Parse one request from the bytes read so far. `Ok(None)` = incomplete, read more. Pure.
pub(crate) fn parse_request(buf: &[u8]) -> Result<Option<Request>, Fail> {
    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        if buf.len() >= MAX_REQUEST_BYTES {
            return Err(fail(431, "request head too large"));
        }
        return Ok(None);
    };
    let head = std::str::from_utf8(&buf[..end]).map_err(|_| fail(400, "request head is not UTF-8"))?;
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or("").split(' ');
    let (Some(method), Some(target), Some(version), None) = (start.next(), start.next(), start.next(), start.next()) else {
        return Err(fail(400, "malformed request line"));
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) || !target.starts_with('/') || !version.starts_with("HTTP/1.") {
        return Err(fail(400, "malformed request line"));
    }
    let mut headers: Vec<(String, String)> = vec![];
    for line in lines {
        if headers.len() >= MAX_HEADERS {
            return Err(fail(431, "too many headers"));
        }
        let (k, v) = line.split_once(':').ok_or_else(|| fail(400, "malformed header"))?;
        if k.is_empty() || k.bytes().any(|b| b == b' ' || b == b'\t') {
            return Err(fail(400, "malformed header"));
        }
        headers.push((k.to_ascii_lowercase(), v.trim().to_string()));
    }
    if headers.iter().any(|(k, _)| k == "transfer-encoding") {
        return Err(fail(400, "chunked bodies are not supported; send Content-Length"));
    }
    let lens: Vec<&str> = headers.iter().filter(|(k, _)| k == "content-length").map(|(_, v)| v.as_str()).collect();
    let len = match lens.as_slice() {
        [] => 0,
        [v] => v.parse::<usize>().map_err(|_| fail(400, "bad Content-Length"))?,
        _ => return Err(fail(400, "duplicate Content-Length")),
    };
    let body_start = end + 4;
    if body_start.saturating_add(len) > MAX_REQUEST_BYTES {
        return Err(fail(413, "request too large"));
    }
    if buf.len() < body_start + len {
        return Ok(None);
    }
    Ok(Some(Request { method: method.to_string(), path: target.split('?').next().unwrap_or("").to_string(), headers, body: buf[body_start..body_start + len].to_vec() }))
}

// ── Auth (pure) ─────────────────────────────────────────────────────────────

/// Equal without an early exit (both sides hashed, so the length doesn't leak either).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let (da, db) = (Sha256::digest(a), Sha256::digest(b));
    da.iter().zip(db.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `Authorization` header vs this launch's lease token. No token → 503 (accept nothing). Pure.
pub(crate) fn authorize(header: Option<&str>, token: Option<&str>) -> Result<(), Fail> {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return Err(fail(503, "no lease token (telemetry folder not writable)"));
    };
    let presented = header
        .map(str::trim)
        .and_then(|h| h.get(..7).filter(|p| p.eq_ignore_ascii_case("bearer ")).map(|_| h[7..].trim()))
        .unwrap_or("");
    if presented.is_empty() || !ct_eq(presented.as_bytes(), token.as_bytes()) {
        return Err(fail(401, "unauthorized"));
    }
    Ok(())
}

// ── Routing (pure) ──────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub(crate) enum Route {
    Acquire { node: String, max_wait: Duration, ttl: Duration },
    Release { lease_id: String },
    State,
}

pub(crate) fn clamp_ttl(ttl_ms: Option<u64>) -> Duration {
    Duration::from_millis(ttl_ms.unwrap_or(DEFAULT_TTL_MS).clamp(MIN_TTL_MS, MAX_TTL_MS))
}

pub(crate) fn clamp_wait(max_wait_ms: Option<u64>) -> Duration {
    Duration::from_millis(max_wait_ms.unwrap_or(DEFAULT_MAX_WAIT_MS).min(MAX_WAIT_CAP_MS))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcquireBody {
    node: String,
    max_wait_ms: Option<u64>,
    ttl_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseBody {
    lease_id: String,
}

pub(crate) fn route(req: &Request) -> Result<Route, Fail> {
    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/arbiter/acquire") => {
            let b: AcquireBody = serde_json::from_slice(&req.body).map_err(|_| fail(400, "body must be JSON {\"node\", \"maxWaitMs\"?, \"ttlMs\"?}"))?;
            let node = b.node.trim().to_ascii_lowercase();
            if !ALLOWED_NODES.contains(&node.as_str()) {
                return Err(fail(403, format!("node not allowed (allowed: {})", ALLOWED_NODES.join(", "))));
            }
            Ok(Route::Acquire { node, max_wait: clamp_wait(b.max_wait_ms), ttl: clamp_ttl(b.ttl_ms) })
        }
        ("POST", "/arbiter/release") => {
            let b: ReleaseBody = serde_json::from_slice(&req.body).map_err(|_| fail(400, "body must be JSON {\"leaseId\"}"))?;
            let id = b.lease_id.trim();
            if id.is_empty() || id.len() > 128 {
                return Err(fail(400, "bad leaseId"));
            }
            Ok(Route::Release { lease_id: id.to_string() })
        }
        ("GET", "/arbiter/state") => Ok(Route::State),
        (_, "/arbiter/acquire" | "/arbiter/release" | "/arbiter/state") => Err(fail(405, "method not allowed")),
        _ => Err(fail(404, "not found")),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

pub(crate) fn response(status: u16, body: &Value) -> Vec<u8> {
    let b = body.to_string();
    format!("HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{b}", reason(status), b.len()).into_bytes()
}

// ── Leases ──────────────────────────────────────────────────────────────────

struct Lease {
    guard: SlotGuard,
    node: String,
    granted: Instant,
    ttl: Duration,
}

#[derive(Default)]
pub(crate) struct Leases {
    map: Mutex<HashMap<String, Lease>>,
}

impl Leases {
    fn take(&self, id: &str) -> Option<Lease> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(id)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Released by the gateway: the generation is done, the permit goes at once.
    pub(crate) fn release(&self, id: &str) -> bool {
        let Some(mut l) = self.take(id) else { return false };
        l.guard.disarm();
        super::live::event("lease", json!({ "action": "released", "node": l.node, "heldMs": ms(l.granted.elapsed()) }));
        drop(l);
        true
    }

    /// The TTL ran out: keep the permit for the settle window before it goes.
    fn expire(&self, id: &str) -> bool {
        let Some(mut l) = self.take(id) else { return false };
        l.guard.arm_settle(EXPIRY_SETTLE);
        super::live::event("lease", json!({ "action": "expired", "node": l.node, "heldMs": ms(l.granted.elapsed()), "ttlMs": ms(l.ttl) }));
        drop(l);
        true
    }
}

fn new_lease_id() -> String {
    use std::hash::BuildHasher;
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let mut h = Sha256::new();
    h.update(n.to_le_bytes());
    h.update(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos().to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    // `RandomState` is seeded from the OS's randomness.
    h.update(std::collections::hash_map::RandomState::new().hash_one(n).to_le_bytes());
    h.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Hold `guard` as a lease that auto-expires after `ttl`. Returns the lease id.
fn grant(leases: &Arc<Leases>, guard: SlotGuard, node: &str, ttl: Duration) -> String {
    let id = new_lease_id();
    leases.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), Lease { guard, node: node.to_string(), granted: Instant::now(), ttl });
    let (l, id2) = (leases.clone(), id.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ttl).await;
        l.expire(&id2);
    });
    id
}

// ── Server ──────────────────────────────────────────────────────────────────

pub(crate) struct Ctx {
    slot: GpuSlot,
    /// This launch's lease token (None = it could not be written to disk, so nothing is accepted).
    token: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    tony_pct: Arc<dyn Fn() -> u8 + Send + Sync>,
    leases: Arc<Leases>,
}

/// Start the lease server (lib.rs setup). A taken port is logged (`error` event), never a panic.
pub fn init(app: &tauri::AppHandle) {
    use super::os_core::OsState;
    use tauri::Manager;
    let a2 = app.clone();
    // A fresh 256-bit token per launch, readable by the gateway from the telemetry folder.
    let token: Option<String> = super::policy::telemetry_root().and_then(|root| {
        let t = format!("{}{}", new_lease_id(), new_lease_id());
        super::staging::atomic_write(&root.join(TOKEN_FILE), t.as_bytes()).ok().map(|_| t)
    });
    if token.is_none() {
        super::live::event("error", json!({ "source": "lease", "error": "lease token not written; the lease API will refuse every request" }));
    }
    let ctx = Arc::new(Ctx {
        slot: app.state::<OsState>().slot.share(),
        token: Arc::new(move || token.clone()),
        tony_pct: Arc::new(move || a2.state::<OsState>().snapshot().scheduler.tony_priority_pct),
        leases: Arc::new(Leases::default()),
    });
    tauri::async_runtime::spawn(async move {
        match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PORT)).await {
            Ok(l) => serve(l, ctx).await,
            Err(e) => super::live::event("error", json!({ "source": "lease", "port": PORT, "error": format!("bind failed: {:?}", e.kind()) })),
        }
    });
}

async fn serve(listener: TcpListener, ctx: Arc<Ctx>) {
    let conns = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (sock, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = conns.clone().try_acquire_owned() else {
            let _ = sock.try_write(&response(503, &json!({ "error": "too many connections" })));
            continue;
        };
        let ctx = ctx.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            handle(sock, &ctx).await;
        });
    }
}

async fn read_request(sock: &mut TcpStream) -> Result<Request, Fail> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 2048];
    loop {
        // Never buffer more than one byte past the cap (parse_request then refuses it).
        let room = (MAX_REQUEST_BYTES + 1).saturating_sub(buf.len()).min(tmp.len());
        if room == 0 {
            return Err(fail(413, "request too large"));
        }
        let n = sock.read(&mut tmp[..room]).await.map_err(|_| fail(400, "read failed"))?;
        if n == 0 {
            return Err(fail(400, "connection closed mid-request"));
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(req) = parse_request(&buf)? {
            return Ok(req);
        }
    }
}

/// Resolves when the client hangs up (bytes it sends meanwhile are ignored).
async fn wait_closed(sock: &mut TcpStream) {
    let mut b = [0u8; 512];
    loop {
        match sock.read(&mut b).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

struct Outcome {
    status: u16,
    body: Value,
    /// A lease granted by this request: released again if the answer can't be delivered.
    lease: Option<String>,
}

fn answer(status: u16, body: Value) -> Option<Outcome> {
    Some(Outcome { status, body, lease: None })
}

async fn handle(mut sock: TcpStream, ctx: &Ctx) {
    let out = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut sock)).await {
        Err(_) => answer(408, json!({ "error": "request read timeout" })),
        Ok(Err(f)) => answer(f.status, json!({ "error": f.msg })),
        Ok(Ok(req)) => dispatch(&mut sock, ctx, req).await,
    };
    let Some(out) = out else { return };
    let bytes = response(out.status, &out.body);
    let wrote = matches!(tokio::time::timeout(WRITE_TIMEOUT, sock.write_all(&bytes)).await, Ok(Ok(())));
    if !wrote {
        if let Some(id) = out.lease {
            ctx.leases.release(&id);
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), sock.shutdown()).await;
    // Lingering close: drain what the client still sends (an oversized body, say) so closing with
    // unread bytes doesn't reset the connection before it has read the answer. Bounded.
    let _ = tokio::time::timeout(Duration::from_millis(500), async {
        let mut b = [0u8; 2048];
        let mut total = 0usize;
        while total < 64 * 1024 {
            match sock.read(&mut b).await {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n,
            }
        }
    })
    .await;
}

async fn dispatch(sock: &mut TcpStream, ctx: &Ctx, req: Request) -> Option<Outcome> {
    let tf = ctx.token.clone();
    let token = tauri::async_runtime::spawn_blocking(move || tf()).await.ok().flatten();
    if let Err(f) = authorize(req.header("authorization"), token.as_deref()) {
        return answer(f.status, json!({ "error": f.msg }));
    }
    let route = match route(&req) {
        Ok(r) => r,
        Err(f) => return answer(f.status, json!({ "error": f.msg })),
    };
    match route {
        Route::State => answer(200, serde_json::to_value(ctx.slot.detail()).unwrap_or(Value::Null)),
        Route::Release { lease_id } => answer(200, json!({ "released": ctx.leases.release(&lease_id) })),
        Route::Acquire { node, max_wait, ttl } => {
            let label = format!("gateway · {node}");
            let pct = (ctx.tony_pct)();
            let t0 = Instant::now();
            // Cancel-safe: on a timeout or a hang-up the acquire future is dropped, and with it
            // the queued waiter.
            let got = tokio::select! {
                r = tokio::time::timeout(max_wait, ctx.slot.acquire(&label, false, pct)) => Some(r),
                _ = wait_closed(sock) => None,
            };
            let waited = ms(t0.elapsed());
            match got {
                None => {
                    super::live::event("lease", json!({ "action": "abandoned", "node": node, "waitMs": waited }));
                    None
                }
                Some(Err(_)) => {
                    super::live::event("lease", json!({ "action": "timeout", "node": node, "waitMs": waited }));
                    answer(408, json!({ "error": "gpu slot not acquired within maxWaitMs", "waitedMs": waited }))
                }
                Some(Ok(guard)) => {
                    let tier = guard.tier();
                    let id = grant(&ctx.leases, guard, &node, ttl);
                    super::live::event("lease", json!({ "action": "acquired", "node": node, "waitMs": waited, "tier": tier, "ttlMs": ms(ttl) }));
                    Some(Outcome { status: 200, body: json!({ "leaseId": id, "waitedMs": waited, "tier": tier, "ttlMs": ms(ttl) }), lease: Some(id) })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::policy::Policy;

    fn req(raw: &str) -> Request {
        parse_request(raw.as_bytes()).unwrap().unwrap()
    }

    #[test]
    fn parses_requests_and_bounds_them() {
        let r = req("POST /arbiter/acquire?x=1 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nContent-Length: 4\r\n\r\nabcdEXTRA");
        assert_eq!((r.method.as_str(), r.path.as_str(), r.body.as_slice()), ("POST", "/arbiter/acquire", b"abcd".as_slice()));
        assert_eq!(r.header("authorization"), Some("Bearer t"));
        // Incomplete head / body: read more.
        assert_eq!(parse_request(b"GET /arbiter/state HTTP/1.1\r\nHost: x\r\n"), Ok(None));
        assert_eq!(parse_request(b"POST /arbiter/release HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc"), Ok(None));
        // Bounds.
        let big = format!("POST /x HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_REQUEST_BYTES);
        assert_eq!(parse_request(big.as_bytes()).unwrap_err().status, 413);
        assert_eq!(parse_request(&vec![b'a'; MAX_REQUEST_BYTES]).unwrap_err().status, 431);
        let many: String = (0..=MAX_HEADERS).map(|i| format!("X-{i}: v\r\n")).collect();
        assert_eq!(parse_request(format!("GET / HTTP/1.1\r\n{many}\r\n").as_bytes()).unwrap_err().status, 431);
        // Malformed.
        for bad in ["GET\r\n\r\n", "get / HTTP/1.1\r\n\r\n", "GET / HTTP/2\r\n\r\n", "GET / HTTP/1.1\r\nNoColon\r\n\r\n", "GET / HTTP/1.1\r\nContent-Length: x\r\n\r\n", "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", "GET / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na"] {
            assert_eq!(parse_request(bad.as_bytes()).unwrap_err().status, 400, "{bad:?}");
        }
    }

    #[test]
    fn auth_needs_the_mesh_token() {
        assert_eq!(authorize(Some("Bearer abc"), None).unwrap_err().status, 503);
        assert_eq!(authorize(Some("Bearer abc"), Some("  ")).unwrap_err().status, 503);
        assert_eq!(authorize(None, Some("abc")).unwrap_err().status, 401);
        assert_eq!(authorize(Some("Bearer abd"), Some("abc")).unwrap_err().status, 401);
        assert_eq!(authorize(Some("Bearer abcd"), Some("abc")).unwrap_err().status, 401);
        assert_eq!(authorize(Some("Basic abc"), Some("abc")).unwrap_err().status, 401);
        assert_eq!(authorize(Some("Bearer "), Some("abc")).unwrap_err().status, 401);
        assert!(authorize(Some("Bearer abc"), Some("abc")).is_ok());
        assert!(authorize(Some("bearer abc"), Some("abc")).is_ok());
        assert!(ct_eq(b"x", b"x") && !ct_eq(b"x", b"y") && !ct_eq(b"x", b"xx"));
    }

    #[test]
    fn routes_and_clamps() {
        let post = |path: &str, body: &str| req(&format!("POST {path} HTTP/1.1\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert_eq!(
            route(&post("/arbiter/acquire", r#"{"node":"trading","maxWaitMs":5000,"ttlMs":999999}"#)),
            Ok(Route::Acquire { node: "trading".into(), max_wait: Duration::from_secs(5), ttl: Duration::from_millis(MAX_TTL_MS) })
        );
        assert_eq!(route(&post("/arbiter/acquire", r#"{"node":" Trading "}"#)), Ok(Route::Acquire { node: "trading".into(), max_wait: Duration::from_millis(DEFAULT_MAX_WAIT_MS), ttl: Duration::from_millis(DEFAULT_TTL_MS) }));
        assert_eq!(route(&post("/arbiter/acquire", r#"{"node":"coder"}"#)).unwrap_err().status, 403);
        assert_eq!(route(&post("/arbiter/acquire", "nope")).unwrap_err().status, 400);
        assert_eq!(route(&post("/arbiter/release", r#"{"leaseId":"ab12"}"#)), Ok(Route::Release { lease_id: "ab12".into() }));
        assert_eq!(route(&post("/arbiter/release", r#"{"leaseId":""}"#)).unwrap_err().status, 400);
        assert_eq!(route(&req("GET /arbiter/state HTTP/1.1\r\n\r\n")), Ok(Route::State));
        assert_eq!(route(&req("GET /arbiter/acquire HTTP/1.1\r\n\r\n")).unwrap_err().status, 405);
        assert_eq!(route(&req("GET /live HTTP/1.1\r\n\r\n")).unwrap_err().status, 404);
        assert_eq!(clamp_ttl(Some(10)), Duration::from_millis(MIN_TTL_MS));
        assert_eq!(clamp_wait(Some(u64::MAX)), Duration::from_millis(MAX_WAIT_CAP_MS));
        assert_eq!(clamp_wait(Some(0)), Duration::ZERO);
        let r = response(408, &json!({ "error": "x" }));
        let s = String::from_utf8(r).unwrap();
        assert!(s.starts_with("HTTP/1.1 408 Request Timeout\r\n") && s.ends_with("\r\n\r\n{\"error\":\"x\"}"), "{s}");
        assert_ne!(new_lease_id(), new_lease_id());
        assert_eq!(new_lease_id().len(), 32);
    }

    #[test]
    fn leases_expire_with_a_settle_window_and_release_at_once() {
        tauri::async_runtime::block_on(async {
            let slot = GpuSlot::with_policy(Policy::default());
            let leases = Arc::new(Leases::default());
            let g = slot.acquire("gateway · trading", false, 50).await;
            assert_eq!(g.tier(), 1);
            let id = grant(&leases, g, "trading", Duration::from_millis(100));
            assert_eq!(leases.len(), 1);
            assert!(!leases.release("not-a-lease"));
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(leases.len(), 0, "expired");
            assert!(!leases.release(&id), "already gone");
            assert_eq!(slot.view().settling, 1, "an expired lease settles before the permit goes");
            assert!(slot.view().active.is_empty());
            // Released by the gateway: immediate.
            let slot = GpuSlot::with_policy(Policy::default());
            let g = slot.acquire("gateway · trading", false, 50).await;
            let id = grant(&leases, g, "trading", Duration::from_secs(60));
            assert!(leases.release(&id));
            assert!(!leases.release(&id));
            assert!(slot.is_idle());
        });
    }

    async fn call(addr: std::net::SocketAddr, raw: String) -> (u16, Value) {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut out = vec![];
        let mut b = [0u8; 4096];
        while let Ok(n) = s.read(&mut b).await {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&b[..n]);
        }
        let text = String::from_utf8(out).unwrap();
        let status = text.split(' ').nth(1).unwrap().parse().unwrap();
        let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn http(method: &str, path: &str, token: Option<&str>, body: &str) -> String {
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    }

    async fn start(token: Option<&'static str>) -> (std::net::SocketAddr, GpuSlot) {
        let slot = GpuSlot::with_policy(Policy::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ctx = Arc::new(Ctx { slot: slot.share(), token: Arc::new(move || token.map(str::to_string)), tony_pct: Arc::new(|| 90), leases: Arc::new(Leases::default()) });
        tauri::async_runtime::spawn(serve(listener, ctx));
        (addr, slot)
    }

    #[test]
    fn serves_acquire_state_release_over_loopback() {
        tauri::async_runtime::block_on(async {
            let (addr, slot) = start(Some("s3cret")).await;
            let acquire = r#"{"node":"trading","maxWaitMs":200}"#;
            assert_eq!(call(addr, http("GET", "/arbiter/state", None, "")).await.0, 401);
            assert_eq!(call(addr, http("GET", "/arbiter/state", Some("wrong"), "")).await.0, 401);
            assert_eq!(call(addr, http("POST", "/arbiter/acquire", Some("s3cret"), r#"{"node":"coder"}"#)).await.0, 403);
            let (st, v) = call(addr, http("POST", "/arbiter/acquire", Some("s3cret"), acquire)).await;
            assert_eq!(st, 200, "{v}");
            assert_eq!(v["tier"], 1);
            assert_eq!(v["ttlMs"], DEFAULT_TTL_MS);
            let id = v["leaseId"].as_str().unwrap().to_string();
            let (st, d) = call(addr, http("GET", "/arbiter/state", Some("s3cret"), "")).await;
            assert_eq!(st, 200);
            assert_eq!(d["holders"][0]["label"], "gateway · trading");
            assert_eq!(d["holders"][0]["tier"], 1);
            assert_eq!(d["holders"][0]["node"], "trading");
            // Held: a second lease times out cleanly.
            let (st, v) = call(addr, http("POST", "/arbiter/acquire", Some("s3cret"), acquire)).await;
            assert_eq!(st, 408, "{v}");
            assert!(v["waitedMs"].as_u64().unwrap() >= 190);
            assert_eq!(slot.view().queued_background, 0, "the timed-out waiter left the queue");
            // A client that hangs up while waiting gives its place back.
            {
                let mut s = TcpStream::connect(addr).await.unwrap();
                s.write_all(http("POST", "/arbiter/acquire", Some("s3cret"), r#"{"node":"trading","maxWaitMs":60000}"#).as_bytes()).await.unwrap();
                tokio::time::sleep(Duration::from_millis(150)).await;
                assert_eq!(slot.view().queued_background, 1);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(slot.view().queued_background, 0, "abandoned waiter dropped");
            let (st, v) = call(addr, http("POST", "/arbiter/release", Some("s3cret"), &format!(r#"{{"leaseId":"{id}"}}"#))).await;
            assert_eq!((st, v["released"].as_bool()), (200, Some(true)));
            let (_, v) = call(addr, http("POST", "/arbiter/release", Some("s3cret"), &format!(r#"{{"leaseId":"{id}"}}"#))).await;
            assert_eq!(v["released"].as_bool(), Some(false));
            assert!(slot.is_idle());
            // Oversized bodies are refused before anything else.
            let big = "x".repeat(MAX_REQUEST_BYTES);
            assert_eq!(call(addr, http("POST", "/arbiter/acquire", Some("s3cret"), &big)).await.0, 413);
        });
    }

    #[test]
    fn no_mesh_token_accepts_nothing() {
        tauri::async_runtime::block_on(async {
            let (addr, slot) = start(None).await;
            let (st, v) = call(addr, http("POST", "/arbiter/acquire", Some("anything"), r#"{"node":"trading"}"#)).await;
            assert_eq!((st, v["error"].as_str()), (503, Some("no lease token (telemetry folder not writable)")));
            assert_eq!(call(addr, http("GET", "/arbiter/state", None, "")).await.0, 503);
            assert!(slot.is_idle());
        });
    }
}
