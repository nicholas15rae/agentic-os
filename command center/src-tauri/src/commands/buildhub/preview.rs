//! Live Read-In / Peek View server (Phase 3): one tiny loopback static-file server per build,
//! serving that build's output folder at `http://127.0.0.1:<port>/`. It only reads files, so
//! opening, refreshing or closing a preview can never touch the build (the worker writes the
//! folder; this only serves it). GET/HEAD only, no directory listing, no path escape, no-store.

use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Preview {
    /// The folder this server serves (a build whose output folder moved needs a new server).
    pub root: PathBuf,
    pub port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Preview {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
    pub fn stop(&self) {
        self.task.abort();
    }
}

/// Map a request path onto a file under `root` (pure apart from `canonicalize`). `None` = 404.
pub fn resolve(root: &Path, raw: &str) -> Option<PathBuf> {
    let path = raw.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(path)?;
    let rel = decoded.trim_start_matches('/');
    // Validate BEFORE any filesystem call: on Windows `join` with a UNC / rooted path replaces the
    // root, and `canonicalize` would open it (an outbound SMB / WebDAV hop that offers NTLM).
    if !safe_rel(rel) {
        return None;
    }
    let rel = if rel.is_empty() || rel.ends_with('/') { format!("{rel}index.html") } else { rel.to_string() };
    let real_root = std::fs::canonicalize(root).ok()?;
    let real = std::fs::canonicalize(real_root.join(&rel)).ok()?;
    (real.starts_with(&real_root) && real.is_file()).then_some(real)
}

/// A request path relative to the served root, made only of plain names (pure). URLs use '/', so
/// a backslash, a drive colon or a NUL is never legitimate; every component must be `Normal` (no
/// prefix, root, `.` or `..`).
pub fn safe_rel(rel: &str) -> bool {
    if rel.contains(['\\', ':', '\0']) || rel.starts_with('/') || rel.split('/').any(|seg| seg == "." || seg == "..") {
        return false;
    }
    Path::new(rel).components().all(|c| matches!(c, std::path::Component::Normal(_)))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

const MAX_FILE: u64 = 16 * 1024 * 1024;

async fn serve_one(mut sock: tokio::net::TcpStream, root: PathBuf) {
    let mut buf = vec![0u8; 8192];
    let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let (status, ctype, body): (&str, &str, Vec<u8>) = if method != "GET" && method != "HEAD" {
        ("405 Method Not Allowed", "text/plain", b"method not allowed".to_vec())
    } else {
        match resolve(&root, path).filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= MAX_FILE)) {
            Some(p) => match std::fs::read(&p) {
                Ok(b) => ("200 OK", content_type(&p), b),
                Err(_) => ("500 Internal Server Error", "text/plain", b"read error".to_vec()),
            },
            None => ("404 Not Found", "text/plain", b"not found".to_vec()),
        }
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(header.as_bytes()).await;
    if method != "HEAD" {
        let _ = sock.write_all(&body).await;
    }
    let _ = sock.shutdown().await;
}

/// Bind `127.0.0.1:0` and serve `root` until stopped.
pub async fn start(root: PathBuf) -> Result<Preview, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("preview server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let r = root.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let r = r.clone();
            tauri::async_runtime::spawn(serve_one(sock, r));
        }
    });
    Ok(Preview { root, port, task })
}

/// Is a preview URL answering? (2 s; any HTTP answer below 500 counts.) Loopback only.
pub async fn reachable(http: &reqwest::Client, url: &str) -> bool {
    if !is_loopback_url(url) {
        return false;
    }
    http.get(url).timeout(Duration::from_secs(2)).send().await.is_ok_and(|r| r.status().as_u16() < 500)
}

/// Only loopback http URLs may be bound as a build's preview (pure).
pub fn is_loopback_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1") | Some("localhost")) && u.port().is_some()
}
