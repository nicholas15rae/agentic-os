//! RAG memory lifecycle: Harvest → Condense → Fine-tune dataset → Locked vault,
//! then (optionally) flush the remote cache, and mount / unmount condensed
//! Memory Books back into AnythingLLM when they're needed.
//!
//!   A. Pull & verify  — AnythingLLM chats (each mapped workspace + Tony's
//!      monthly threads), the month's training logs, droplet Qdrant cache
//!      payloads; bundled and SHA-256'd.
//!   B. Condense       — the local model distils the month into a Memory Book
//!      (summary_YYYY_MM.md) + a searchable ledger (ledger_YYYY_MM.json).
//!   C. Dataset        — deduplicated instruction pairs (ChatML / Alpaca /
//!      ShareGPT) in finetune_dataset_YYYY_MM.jsonl for Unsloth / LM Studio.
//!   D. Vault          — everything lands in `<vault>/YYYY-MM/`. With a vault
//!      password set (OS keychain), content files are AES-256-GCM encrypted
//!      (key = PBKDF2-SHA256, 600k rounds); the ledger stays readable metadata.
//!
//! Flushing remote data is destructive: it requires the backup's checksum to
//! re-verify and the destructive-action gate (confirmation card).

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

use super::allm::{self, AllmConn, AllmReader, AllmWriter, ThreadMap};
use super::bridge::BridgeState;
use super::dispatch::{run_chat, short, ChatMessage, DispatchState, Priority};
use super::hygiene;
use super::os_core::{self, OsConfig, OsState};

// ── Crypto ──────────────────────────────────────────────────────────────────

const MAGIC: &[u8; 5] = b"AOSV1";
const ROUNDS: u32 = 600_000;

fn derive(pass: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(pass.as_bytes(), salt, ROUNDS, &mut key);
    key
}

pub fn seal(data: &[u8], pass: &str) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::rand_core::RngCore;
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive(pass, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher.encrypt(&nonce, data).map_err(|_| "encryption failed")?;
    let mut out = Vec::with_capacity(5 + 16 + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open(data: &[u8], pass: &str) -> Result<Vec<u8>, String> {
    if data.len() < 33 || &data[..5] != MAGIC {
        return Err("not a vault file".into());
    }
    let key = derive(pass, &data[5..21]);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher.decrypt(Nonce::from_slice(&data[21..33]), &data[33..]).map_err(|_| "wrong vault password or corrupted file".into())
}

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// The read-only `C:\ai-hub` is never a Memory Vault write target (Nic's decision: the hub stays
/// read-only). Reading an existing archive there still works; writing fails closed, before anything
/// is created.
const VAULT_UNDER_HUB: &str = r"the Memory Vault dir is under the read-only C:\ai-hub; choose another vault dir in Settings (nothing was written)";

fn refuse_hub_vault(dir: &Path) -> Result<(), String> {
    if os_core::under_read_only_hub(dir) {
        Err(VAULT_UNDER_HUB.into())
    } else {
        Ok(())
    }
}

/// Write `name` (or `name.enc` when a vault password is set). Returns the file name.
fn vault_write(dir: &Path, name: &str, data: &[u8], pass: Option<&str>) -> Result<String, String> {
    refuse_hub_vault(dir)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (fname, bytes) = match pass {
        Some(p) => (format!("{name}.enc"), seal(data, p)?),
        None => (name.to_string(), data.to_vec()),
    };
    std::fs::write(dir.join(&fname), bytes).map_err(|e| e.to_string())?;
    Ok(fname)
}

fn vault_read(dir: &Path, fname: &str) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(dir.join(fname)).map_err(|e| format!("{fname}: {e}"))?;
    if fname.ends_with(".enc") {
        let pass = os_core::os_secret("vault").ok_or("this archive is locked — set the vault password in Settings")?;
        open(&raw, &pass)
    } else {
        Ok(raw)
    }
}

// ── Ledger ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Mount {
    pub target: String,
    pub workspace: String,
    pub location: String,
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LedgerEntry {
    pub id: String,
    pub month: String,
    pub created_at: u64,
    pub sha256: String,
    pub verified: bool,
    pub encrypted: bool,
    pub records: usize,
    pub pairs: usize,
    pub summary_tokens: usize,
    pub agents: Vec<String>,
    pub sources: BTreeMap<String, usize>,
    pub files: BTreeMap<String, String>,
    pub mounts: Vec<Mount>,
    pub flushed_at: Option<u64>,
    pub condensed_by: String,
    pub notes: Vec<String>,
    /// Section headings of the Memory Book — the searchable index.
    pub topics: Vec<String>,
    /// `previous_day` | `previous_week` | `previous_month` | `since_last_harvest` | `month` (older ledgers: empty).
    pub period_kind: String,
    /// `YYYY-MM` months the period touches (Tony's monthly threads).
    pub months: Vec<String>,
    /// Unix secs `[from, to)` of the harvested window.
    pub from: i64,
    pub to: i64,
    /// kind → SHA-256 of each vault file's plaintext, re-verified on disk before the ledger.
    pub checksums: BTreeMap<String, String>,
}

fn vault_dir(cfg: &OsConfig) -> PathBuf {
    PathBuf::from(&cfg.memory.vault_dir)
}

fn ledger_path(cfg: &OsConfig, month: &str) -> PathBuf {
    vault_dir(cfg).join(month).join(format!("ledger_{}.json", month.replace('-', "_")))
}

fn save_ledger(cfg: &OsConfig, l: &LedgerEntry) -> Result<(), String> {
    let p = ledger_path(cfg, &l.month);
    refuse_hub_vault(&p)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_string_pretty(l).unwrap()).map_err(|e| e.to_string())
}

fn load_ledger(cfg: &OsConfig, month: &str) -> Result<LedgerEntry, String> {
    let s = std::fs::read_to_string(ledger_path(cfg, month)).map_err(|_| format!("no Memory Book for {month}"))?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_ledger(os: State<'_, OsState>) -> Vec<LedgerEntry> {
    let cfg = os.snapshot();
    let mut out: Vec<LedgerEntry> = std::fs::read_dir(vault_dir(&cfg))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| load_ledger(&cfg, &e.file_name().to_string_lossy()).ok())
        .collect();
    out.sort_by(|a, b| b.month.cmp(&a.month));
    out
}

fn valid_month(m: &str) -> bool {
    m.len() == 7 && m.as_bytes()[4] == b'-' && m[..4].chars().all(|c| c.is_ascii_digit()) && m[5..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n))
}

/// `[start, end)` of a calendar month as unix secs (the month `Period`'s bounds).
#[cfg(test)]
fn month_bounds(month: &str) -> (i64, i64) {
    hygiene::month_period(month).map(|p| p.bounds()).unwrap_or((0, 0))
}

// ── Harvest ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    step: String,
    detail: String,
}

fn progress(app: &Option<tauri::AppHandle>, step: &str, detail: impl Into<String>) {
    if let Some(a) = app {
        let _ = a.emit("memory-progress", Progress { step: step.into(), detail: detail.into() });
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Record {
    source: String,
    agent: String,
    role: String,
    content: String,
    at: i64,
}

/// Thread slugs to READ for a month (pure): the persisted (OS-created) thread if it is still in
/// the workspace, plus any thread an older API names exactly `<osName> · YYYY-MM`.
pub(crate) fn threads_to_pull(persisted: Option<&str>, live: &[(String, Option<String>)], legacy_name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(p) = persisted.filter(|p| live.iter().any(|(s, _)| s == p)) {
        out.push(p.to_string());
    }
    for (s, n) in live {
        if n.as_deref() == Some(legacy_name) && !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

/// Thread slugs to DELETE for a month (pure): ONLY the persisted thread the OS created and
/// recorded, and only while it is still live. Pre-existing / duplicate threads (whatever their
/// name) are never selected.
pub(crate) fn threads_to_flush(persisted: Option<&str>, live: &[(String, Option<String>)]) -> Vec<String> {
    persisted.filter(|p| live.iter().any(|(s, _)| s == p)).map(|p| vec![p.to_string()]).unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
async fn pull_allm(reader: &AllmReader, map: &dyn ThreadMap, slug: &str, month: &str, thread_name: &str, (from, to): (i64, i64), agent: &str, label: &str, out: &mut Vec<Record>) -> Result<usize, String> {
    let mut n = 0;
    let mut push = |v: &Value, source: &str, out: &mut Vec<Record>| {
        for h in v["history"].as_array().into_iter().flatten() {
            let at = h["sentAt"].as_i64().unwrap_or(0);
            if at != 0 && (at < from || at >= to) {
                continue;
            }
            let content = h["content"].as_str().unwrap_or("").trim();
            if content.is_empty() {
                continue;
            }
            out.push(Record { source: source.into(), agent: agent.into(), role: h["role"].as_str().unwrap_or("user").into(), content: content.into(), at });
            n += 1;
        }
    };
    let v = reader.workspace_chats(slug, 20).await?;
    push(&v, &format!("{label}:{slug}"), out);
    let live = reader.get_workspace(slug, 10).await.map(|ws| allm::thread_list(&ws)).unwrap_or_default();
    let persisted = map.get(reader.base(), slug, &allm::tony_key(month));
    for ts in threads_to_pull(persisted.as_deref(), &live, thread_name) {
        if let Ok(v) = reader.thread_chats(slug, &ts, 20).await {
            push(&v, &format!("{label}:{slug}/{ts}"), out);
        }
    }
    Ok(n)
}

fn pull_training_logs(repo: &Path, month: &str, (from, to): (i64, i64), out: &mut Vec<Record>) -> usize {
    let mut n = 0;
    let dir = repo.join("training_logs");
    let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.contains(month) || !name.ends_with(".jsonl") {
            continue;
        }
        for line in std::fs::read_to_string(e.path()).unwrap_or_default().lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let at = v["ts"].as_i64().map(|t| t / 1000).unwrap_or(0);
            if at != 0 && (at < from || at >= to) {
                continue;
            }
            if v["type"] == "os-turn" && !v["private"].is_null() {
                // A private (booking / finance / comms) turn kept only its length: never a pair.
                continue;
            } else if v["type"] == "os-turn" {
                let agent = v["role"].as_str().unwrap_or("general").to_string();
                out.push(Record { source: format!("training_logs/{name}"), agent: agent.clone(), role: "user".into(), content: v["upstream"].as_str().unwrap_or("").into(), at });
                out.push(Record { source: format!("training_logs/{name}"), agent, role: "assistant".into(), content: v["downstream"].as_str().unwrap_or("").into(), at });
                n += 2;
            } else {
                out.push(Record { source: format!("training_logs/{name}"), agent: "system".into(), role: "event".into(), content: v.to_string(), at });
                n += 1;
            }
        }
    }
    n
}

async fn pull_qdrant(state: &DispatchState, base: &str, coll: &str, out: &mut Vec<Record>) -> Result<usize, String> {
    let mut offset = Value::Null;
    let mut n = 0;
    for _ in 0..20 {
        let v: Value = state
            .http
            .post(format!("{}/collections/{coll}/points/scroll", base.trim_end_matches('/')))
            .json(&json!({ "limit": 256, "with_payload": true, "with_vector": false, "offset": offset }))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(short)?
            .error_for_status()
            .map_err(short)?
            .json()
            .await
            .map_err(short)?;
        for p in v["result"]["points"].as_array().into_iter().flatten() {
            out.push(Record { source: format!("qdrant:{coll}"), agent: "droplet".into(), role: "vector".into(), content: p["payload"].to_string(), at: 0 });
            n += 1;
        }
        offset = v["result"]["next_page_offset"].clone();
        if offset.is_null() {
            break;
        }
    }
    Ok(n)
}

/// User/assistant pairs in order, per agent.
fn pairs(records: &[Record]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut by_source: BTreeMap<&str, Vec<&Record>> = BTreeMap::new();
    for r in records.iter().filter(|r| r.role == "user" || r.role == "assistant") {
        by_source.entry(r.source.as_str()).or_default().push(r);
    }
    for recs in by_source.values() {
        let mut pending: Option<&Record> = None;
        for r in recs {
            match (r.role.as_str(), pending) {
                ("user", _) => pending = Some(r),
                ("assistant", Some(u)) => {
                    out.push((u.agent.clone(), u.content.clone(), r.content.clone()));
                    pending = None;
                }
                _ => {}
            }
        }
    }
    out
}

fn low_signal(a: &str) -> bool {
    let l = a.to_lowercase();
    a.trim().len() < 20
        || ["i am unable", "i'm unable", "i don't have access", "i do not have access", "as an ai", "unreachable", "timed out", "all providers failed", "error:"].iter().any(|p| l.contains(p))
}

fn dataset(cfg: &OsConfig, prs: &[(String, String, String)]) -> (String, usize) {
    let mut seen = HashSet::new();
    let sys = format!("You are {}, the user's personal AI operating system.", cfg.os_name);
    let mut lines = Vec::new();
    for (_, u, a) in prs {
        if u.trim().len() < 4 || low_signal(a) {
            continue;
        }
        let norm = format!("{}\u{1}{}", u.trim().to_lowercase(), a.trim().to_lowercase());
        if !seen.insert(sha256_hex(norm.as_bytes())) {
            continue;
        }
        let v = match cfg.memory.dataset_format.as_str() {
            "alpaca" => json!({ "instruction": u.trim(), "input": "", "output": a.trim() }),
            "sharegpt" => json!({ "conversations": [{ "from": "system", "value": sys }, { "from": "human", "value": u.trim() }, { "from": "gpt", "value": a.trim() }] }),
            _ => json!({ "messages": [{ "role": "system", "content": sys }, { "role": "user", "content": u.trim() }, { "role": "assistant", "content": a.trim() }] }),
        };
        lines.push(v.to_string());
    }
    let n = lines.len();
    (lines.join("\n") + if n > 0 { "\n" } else { "" }, n)
}

const BOOK_SECTIONS: &str = "## Key facts\n## Client & contact preferences\n## Booking rules & availability\n## Code patterns & fixes\n## High-performing prompts\n## Open threads & follow-ups";

async fn condense(state: &DispatchState, os: &OsState, month: &str, prs: &[(String, String, String)], app: &Option<tauri::AppHandle>) -> (String, String) {
    if prs.is_empty() {
        return (format!("# Memory Book — {month}\n\nNo conversations were recorded this month.\n"), "none".into());
    }
    let transcript: Vec<String> = prs.iter().map(|(ag, u, a)| format!("[{ag}] USER: {}\n[{ag}] ASSISTANT: {}", u.chars().take(1200).collect::<String>(), a.chars().take(1800).collect::<String>())).collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for t in transcript {
        if cur.len() + t.len() > 10_000 && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push_str(&t);
        cur.push_str("\n\n");
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks.truncate(16);
    let mut notes = Vec::new();
    let mut by = String::new();
    for (i, c) in chunks.iter().enumerate() {
        progress(app, "condense", format!("chunk {}/{}", i + 1, chunks.len()));
        let msgs = vec![
            ChatMessage::new("system", format!("Extract durable memory from these conversations as terse bullet points under these headings (skip empty ones):\n{BOOK_SECTIONS}\nOnly facts actually stated. Keep names, dates, prices, rules. No commentary.")),
            ChatMessage::new("user", c.clone()),
        ];
        match run_chat(state, os, msgs, Priority::Background, None, Some(180)).await {
            Ok(r) => {
                by = r.provider_id;
                notes.push(r.content);
            }
            Err(e) => notes.push(format!("(chunk {} not condensed: {e})", i + 1)),
        }
    }
    progress(app, "condense", "merging");
    let merged = if notes.len() > 1 {
        let msgs = vec![
            ChatMessage::new("system", format!("Merge these partial notes into ONE Memory Book in markdown with exactly these headings:\n{BOOK_SECTIONS}\nDeduplicate, keep every concrete fact, newest wins on conflict. Under 1500 words.")),
            ChatMessage::new("user", notes.join("\n\n---\n\n")),
        ];
        run_chat(state, os, msgs, Priority::Background, None, Some(240)).await.map(|r| r.content).unwrap_or_else(|_| notes.join("\n\n"))
    } else {
        notes.join("\n\n")
    };
    (format!("# Memory Book — {month}\n\n_{} conversations · condensed by {}_\n\n{merged}\n", prs.len(), if by.is_empty() { "fallback" } else { &by }), by)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestRequest {
    month: Option<String>,
    /// `previous_day` | `previous_week` | `previous_month` | `since_last_harvest` (wins over `month`).
    #[serde(default)]
    period: Option<String>,
}

/// D16: Booking workspaces (`agent_prompts::NEVER_TOUCH`) are never read, flushed or mounted into.
fn never_touch(slug: &str) -> bool {
    super::agent_prompts::NEVER_TOUCH.contains(&slug.trim())
}

/// `(slug, role)` pairs a harvest reads, and how many Booking mappings were skipped (pure).
pub fn harvest_slugs(workspaces: &BTreeMap<String, String>) -> (BTreeSet<(String, String)>, usize) {
    let mut skipped = 0;
    let slugs = workspaces
        .iter()
        .filter(|(_, s)| !s.is_empty())
        .filter(|(_, s)| {
            let keep = !never_touch(s);
            skipped += usize::from(!keep);
            keep
        })
        .map(|(r, s)| (s.clone(), r.clone()))
        .collect();
    (slugs, skipped)
}

/// Workspaces a flush may delete Tony's month thread from (Booking excluded; pure).
pub fn flush_slugs(workspaces: &BTreeMap<String, String>) -> BTreeSet<String> {
    workspaces.values().filter(|s| !s.is_empty() && !never_touch(s)).cloned().collect()
}

/// A Memory Book may not be mounted into a Booking workspace.
pub fn check_mount_workspace(ws: &str) -> Result<(), String> {
    if never_touch(ws) {
        return Err("Memory Books cannot mount into a Booking workspace; pick another in Settings".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn memory_harvest(app: tauri::AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: HarvestRequest) -> Result<LedgerEntry, String> {
    let period = match (&req.period, &req.month) {
        (Some(name), _) => {
            let last = hygiene::from_ts(os.snapshot().memory.last_verified_harvest_at);
            hygiene::named_period(name, chrono::Local::now().naive_local(), last).ok_or("period must be previous_day, previous_week, previous_month or since_last_harvest (after a first verified harvest)")?
        }
        (None, m) => {
            let month = m.clone().unwrap_or_else(super::agents::month_tag);
            hygiene::month_period(&month).ok_or("month must be YYYY-MM")?
        }
    };
    let _g = hygiene::begin_harvest()?;
    harvest_period(&state, &os, &bridge, &period, Some(app)).await.map(|(l, _)| l)
}

/// The real vault behind the handshake (blocking pool only: PBKDF2 + AES per file).
struct DiskVault {
    dir: PathBuf,
    pass: Option<String>,
}

impl hygiene::VaultIo for DiskVault {
    fn write(&mut self, name: &str, data: &[u8]) -> Result<String, String> {
        vault_write(&self.dir, name, data, self.pass.as_deref())
    }
    fn read(&mut self, fname: &str) -> Result<Vec<u8>, String> {
        let raw = std::fs::read(self.dir.join(fname)).map_err(|e| format!("{fname}: {e}"))?;
        match (&self.pass, fname.ends_with(".enc")) {
            (Some(p), true) => open(&raw, p),
            (None, true) => Err("sealed file but no vault key".into()),
            _ => Ok(raw),
        }
    }
}

fn lc_audit(step: &str, ok: bool, detail: &str) {
    hygiene::audit("lifecycle", step, ok, detail);
}

/// Period-aware harvest with the strict handshake: snapshot → condense → seal every file into
/// the locked vault → SHA-256 re-read of every file → ledger. Returns the ledger and the sealed
/// checksums; ANY failed write / checksum is an `Err` and nothing destructive may follow.
pub async fn harvest_period(state: &DispatchState, os: &OsState, bridge: &BridgeState, period: &hygiene::Period, app: Option<tauri::AppHandle>) -> Result<(LedgerEntry, hygiene::Sealed), String> {
    let id = period.id.as_str();
    if !hygiene::valid_period_id(id) {
        return Err("bad harvest period".into());
    }
    let cfg = os.snapshot();
    // Fail before any pull (harvest only ever writes into the vault dir).
    refuse_hub_vault(&vault_dir(&cfg).join(id))?;
    let repo = PathBuf::from(state.snapshot().gateway.workdir);
    let bounds = period.bounds();
    let mut records = Vec::new();
    let mut sources = BTreeMap::new();
    let mut notes = Vec::new();
    lc_audit("snapshot", true, &format!("{id} ({:?}) pull started", period.kind));

    // A. Snapshot
    progress(&app, "pull", "AnythingLLM workspaces");
    let (slugs, skipped) = harvest_slugs(&cfg.anythingllm.workspaces);
    if skipped > 0 {
        notes.push(format!("skipped {skipped} booking workspace mapping(s) (never read)"));
    }
    let map = allm::thread_map();
    match super::secrets::get(state, "anythingllm") {
        Some(key) => {
            let reader = AllmReader::new(AllmConn::from_cfg_key(state, &cfg, key));
            for (slug, role) in &slugs {
                let mut n_total = 0;
                for month in &period.months {
                    let thread_name = format!("{} · {month}", cfg.os_name);
                    match pull_allm(&reader, map, slug, month, &thread_name, bounds, role, "local", &mut records).await {
                        Ok(n) => n_total += n,
                        Err(e) => notes.push(format!("{slug}: {e}")),
                    }
                }
                sources.insert(format!("anythingllm:{slug}"), n_total);
            }
        }
        None => notes.push("AnythingLLM key missing — workspaces skipped".into()),
    }
    if cfg.droplet.enabled && cfg.memory.storage != "local" && !cfg.privacy.kill_switch {
        progress(&app, "pull", "droplet");
        if let Some(key) = os_core::os_secret("anythingllm-remote") {
            let reader = AllmReader::new(AllmConn::with_key(state, &cfg.droplet.anythingllm_url, key));
            for (slug, role) in &slugs {
                for month in &period.months {
                    let thread_name = format!("{} · {month}", cfg.os_name);
                    if let Ok(n) = pull_allm(&reader, map, slug, month, &thread_name, bounds, role, "droplet", &mut records).await {
                        *sources.entry(format!("droplet-anythingllm:{slug}")).or_insert(0) += n;
                    }
                }
            }
        }
        for c in &cfg.memory.cache_collections {
            match pull_qdrant(state, &cfg.droplet.qdrant_url, c, &mut records).await {
                Ok(n) => {
                    sources.insert(format!("qdrant:{c}"), n);
                }
                Err(e) => notes.push(format!("qdrant {c}: {e}")),
            }
        }
    }
    progress(&app, "pull", "training logs");
    let mut tl = 0;
    for month in &period.months {
        tl += pull_training_logs(&repo, month, bounds, &mut records);
    }
    sources.insert("training_logs".into(), tl);
    lc_audit("snapshot", true, &format!("{id}: {} records from {} source(s)", records.len(), sources.len()));

    let bundle = json!({ "schema": "agentic-os.memory.v1", "month": id, "period": period, "harvestedAt": os_core::now_secs(), "osName": cfg.os_name, "sources": sources, "records": records });
    let raw = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;

    // B. Condense (Memory Book) + C. Dataset (ChatML / Alpaca / ShareGPT)
    let prs = pairs(&records);
    let (book, by) = condense(state, os, id, &prs, &app).await;
    let topics: Vec<String> = book.lines().filter(|l| l.starts_with("## ")).map(|l| l[3..].trim().to_string()).collect();
    progress(&app, "dataset", format!("{} candidate pairs", prs.len()));
    let (jsonl, n_pairs) = dataset(&cfg, &prs);
    lc_audit("condense", true, &format!("{id}: book {} chars by {}, {n_pairs} pairs", book.len(), if by.is_empty() { "fallback" } else { &by }));

    // D. Seal + verify on disk (blocking pool: PBKDF2 + AES-256-GCM per file, SHA-256 re-reads).
    let pass = os_core::os_secret("vault");
    let encrypted = pass.is_some();
    let dir = vault_dir(&cfg).join(id);
    let m_ = id.replace('-', "_");
    let artifacts = vec![
        hygiene::Artifact { kind: "raw".into(), name: format!("raw_backup_{m_}.json"), data: raw },
        hygiene::Artifact { kind: "summary".into(), name: format!("summary_{m_}.md"), data: book.clone().into_bytes() },
        hygiene::Artifact { kind: "dataset".into(), name: format!("finetune_dataset_{m_}.jsonl"), data: jsonl.into_bytes() },
    ];
    progress(&app, "verify", "sealing + checksumming the vault files");
    let seal_dir = dir.clone();
    let sealed = tauri::async_runtime::spawn_blocking(move || {
        let mut io = DiskVault { dir: seal_dir, pass };
        hygiene::seal_and_verify(&mut io, &artifacts, &mut |step, ok, detail| lc_audit(step, ok, &detail))
    })
    .await
    .map_err(|e| format!("vault task failed: {e}"))?;
    let sealed = match sealed {
        Ok(s) => s,
        Err(e) => {
            progress(&app, "abort", e.clone());
            bridge.log(json!({ "type": "memory-harvest", "period": id, "aborted": e }));
            return Err(format!("harvest aborted, nothing destructive ran: {e}"));
        }
    };

    // E. Ledger (keeps mounts from an earlier harvest of the same period)
    let prev = load_ledger(&cfg, id).ok();
    let agents: BTreeSet<String> = records.iter().map(|r| r.agent.clone()).filter(|a| a != "system").collect();
    if !encrypted {
        notes.push("no vault password set — files are NOT encrypted".into());
    }
    let entry = LedgerEntry {
        id: id.to_string(),
        month: id.to_string(),
        created_at: os_core::now_secs(),
        sha256: sealed.sha256.get("raw").cloned().unwrap_or_default(),
        verified: true,
        encrypted,
        records: records.len(),
        pairs: n_pairs,
        summary_tokens: book.len() / 4,
        agents: agents.into_iter().collect(),
        sources,
        files: sealed.files.clone(),
        mounts: prev.as_ref().map(|p| p.mounts.clone()).unwrap_or_default(),
        flushed_at: None,
        condensed_by: by,
        notes,
        topics,
        period_kind: serde_json::to_value(period.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
        months: period.months.clone(),
        from: bounds.0,
        to: bounds.1,
        checksums: sealed.sha256.clone(),
    };
    save_ledger(&cfg, &entry)?;
    bridge.log(json!({ "type": "memory-harvest", "month": id, "records": entry.records, "pairs": entry.pairs, "encrypted": entry.encrypted, "sha256": entry.sha256 }));
    lc_audit("done", true, &format!("{id}: {} records sealed + verified ({})", entry.records, if encrypted { "AES-256-GCM" } else { "unencrypted" }));
    progress(&app, "done", format!("{} records → {}", entry.records, dir.display()));
    Ok((entry, sealed))
}

/// One scheduled (or forced) lifecycle run: harvest with the handshake, persist
/// `lastVerifiedHarvestAt`, then — only after every file verified, and only with the consent
/// toggles on — flush the cloud and / or prune Tony's local threads (the next turn opens a fresh
/// thread seeded with the newest summary).
pub async fn lifecycle_run(app: &tauri::AppHandle, period: &hygiene::Period, scheduled: bool) -> Result<String, String> {
    let state = app.state::<DispatchState>();
    let os = app.state::<OsState>();
    let bridge = app.state::<BridgeState>();
    let _g = hygiene::begin_harvest()?;
    let res = harvest_period(&state, &os, &bridge, period, Some(app.clone())).await;
    let plan = {
        let cfg = os.snapshot();
        hygiene::destructive_plan(&res.as_ref().map(|(_, s)| s.clone()).map_err(|e| e.clone()), cfg.memory.auto_flush, cfg.memory.prune_threads)
    };
    let (entry, _) = res?;
    if scheduled {
        let kind = period.kind;
        let id = period.id.clone();
        os.update(|c| {
            c.memory.last_verified_harvest_at = os_core::now_secs();
            if kind == hygiene::PeriodKind::PreviousMonth {
                c.memory.last_auto_month = id.clone();
            }
            Ok(())
        })?;
    }
    let mut report = vec![format!("{}: {} records sealed + verified", entry.month, entry.records)];
    if plan.cloud_flush || plan.prune_threads {
        lc_audit("flush", true, &format!("{}: cloud flush {} · thread prune {}", entry.month, plan.cloud_flush, plan.prune_threads));
        match flush(&state, &os, &bridge, &entry.month, plan.prune_threads, plan.cloud_flush, true).await {
            Ok(r) => {
                for line in &r {
                    lc_audit("flush", true, line);
                }
                report.extend(r);
                if plan.prune_threads {
                    // The summary seed: the next Tony thread opens with the newest summary.
                    let dir = vault_dir(&os.snapshot()).join(&entry.month);
                    let fname = entry.files.get("summary").cloned().unwrap_or_default();
                    let book = tauri::async_runtime::spawn_blocking(move || vault_read(&dir, &fname).ok().and_then(|b| String::from_utf8(b).ok())).await.ok().flatten();
                    hygiene::set_seed(hygiene::seed_text().or(book));
                    lc_audit("prune", true, "summary seed armed for the next thread");
                }
            }
            Err(e) => {
                lc_audit("flush", false, &e);
                report.push(format!("flush failed: {e}"));
            }
        }
    } else {
        lc_audit("flush", true, "skipped (consent off) — vault copy kept, cloud untouched");
    }
    Ok(report.join(" · "))
}

// ── Flush ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushRequest {
    month: String,
    /// Also delete Tony's monthly threads in the LOCAL AnythingLLM.
    #[serde(default)]
    include_local: bool,
    #[serde(default)]
    approved: bool,
}

#[tauri::command]
pub async fn memory_flush(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: FlushRequest) -> Result<Vec<String>, String> {
    flush(&state, &os, &bridge, &req.month, req.include_local, true, req.approved).await
}

/// Flush the period's remote cache (`include_remote`) and / or Tony's local threads
/// (`include_local`). `month` is any vault period id. The backup re-verifies first.
pub async fn flush(state: &DispatchState, os: &OsState, bridge: &BridgeState, month: &str, include_local: bool, include_remote: bool, approved: bool) -> Result<Vec<String>, String> {
    let cfg = os.snapshot();
    if !hygiene::valid_period_id(month) {
        return Err("bad period id".into());
    }
    if cfg.privacy.destructive_gate && !approved {
        return Err("PERMISSION_REQUIRED:destructive".into());
    }
    let mut l = load_ledger(&cfg, month)?;
    // Re-verify the local backup before anything remote is wiped (blocking pool: decrypt + hash).
    let dir = vault_dir(&cfg).join(month);
    let raw_name = l.files.get("raw").cloned().ok_or("ledger has no raw backup")?;
    let want = l.sha256.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || vault_read(&dir, &raw_name).map(|raw| sha256_hex(&raw) == want)).await.map_err(|e| e.to_string())??;
    if !ok {
        hygiene::audit("lifecycle", "abort", false, &format!("{month}: raw backup checksum mismatch at flush time"));
        return Err("local backup checksum mismatch — refusing to flush".into());
    }
    let mut report = vec![format!("backup verified · sha256 {}…", &l.sha256[..12.min(l.sha256.len())])];
    let months: Vec<String> = if !l.months.is_empty() {
        l.months.clone()
    } else if valid_month(month) {
        vec![month.to_string()]
    } else {
        vec![]
    };
    let mut targets: Vec<(String, String, String)> = Vec::new(); // (label, base, key)
    if include_remote && cfg.droplet.enabled && !cfg.privacy.kill_switch {
        if let Some(k) = os_core::os_secret("anythingllm-remote") {
            targets.push(("droplet AnythingLLM".into(), cfg.droplet.anythingllm_url.clone(), k));
        }
    }
    if include_local {
        if let Some(k) = super::secrets::get(state, "anythingllm") {
            targets.push(("local AnythingLLM".into(), cfg.anythingllm.base_url.clone(), k));
        }
    }
    // Only threads the OS created AND recorded in its thread map are deleted; pre-existing or
    // duplicate threads (e.g. older "Tony · YYYY-MM" copies) are left alone.
    let map = allm::thread_map();
    for (label, base, key) in &targets {
        let conn = AllmConn::with_key(state, base, key.clone());
        let reader = AllmReader::new(conn.clone());
        let writer = AllmWriter::for_memory(conn);
        for slug in &flush_slugs(&cfg.anythingllm.workspaces) {
            let live = reader.get_workspace(slug, 10).await.map(|ws| allm::thread_list(&ws)).unwrap_or_default();
            for mo in &months {
                let thread_name = format!("{} · {mo}", cfg.os_name);
                let persisted = map.get(base, slug, &allm::tony_key(mo));
                for ts in threads_to_flush(persisted.as_deref(), &live) {
                    match writer.delete_thread(slug, &ts, 10).await {
                        Ok(_) => report.push(format!("{label}: deleted thread “{thread_name}” in {slug}")),
                        Err(e) => report.push(format!("{label}: {slug} thread not deleted ({e})")),
                    }
                }
            }
        }
    }
    os.allm_threads.lock().unwrap().clear();
    if include_remote && cfg.droplet.enabled && !cfg.privacy.kill_switch {
        for c in &cfg.memory.cache_collections {
            let r = state.http.delete(format!("{}/collections/{c}", cfg.droplet.qdrant_url.trim_end_matches('/'))).timeout(Duration::from_secs(15)).send().await;
            report.push(match r {
                Ok(r) if r.status().is_success() => format!("droplet Qdrant: dropped cache collection {c}"),
                Ok(r) => format!("droplet Qdrant: {c} → HTTP {}", r.status().as_u16()),
                Err(e) => format!("droplet Qdrant: {c} → {}", short(e)),
            });
        }
    } else if include_remote && !cfg.memory.cache_collections.is_empty() {
        report.push("droplet off — Qdrant cache untouched".into());
    }
    if targets.is_empty() && (cfg.memory.cache_collections.is_empty() || !include_remote) {
        report.push("nothing to flush (droplet off / no cache collections / no local prune)".into());
    }
    l.flushed_at = Some(os_core::now_secs());
    save_ledger(&cfg, &l)?;
    bridge.log(json!({ "type": "memory-flush", "month": month, "report": report }));
    Ok(report)
}

// ── Purge raw vectors & re-sync scrolls ─────────────────────────────────────

/// "Purge Raw Vectors & Re-sync Scrolls": distill pending raw notes (a compaction, deferred
/// when busy), turn on Embed-scrolls-only, un-embed + remove Tony's raw `Idea:` task-note
/// documents from the Librarian workspace (the notes stay on disk), and un-embed duplicate scroll
/// copies (same content hash per the CLI's sync ledger; the ledger's current copy always stays).
#[tauri::command]
pub async fn memory_purge_raw_vectors(app: tauri::AppHandle, approved: Option<bool>) -> Result<Value, String> {
    let os = app.state::<OsState>();
    let state = app.state::<DispatchState>();
    let bridge = app.state::<BridgeState>();
    let cfg = os.snapshot();
    if cfg.privacy.destructive_gate && !approved.unwrap_or(false) {
        return Err("PERMISSION_REQUIRED:destructive".into());
    }
    let pa = |step: &str, ok: bool, d: &str| hygiene::audit("purge", step, ok, d);
    pa("start", true, "purge raw vectors & re-sync scrolls");
    // 1. Distill what's pending first, so nothing only lives in a raw note's embedding.
    let compact = super::compaction::run_compact(&app, true).await;
    let compact_line = compact.deferred.clone().map(|d| format!("compaction deferred: {d}")).or(compact.error.clone().map(|e| format!("compaction error: {e}"))).unwrap_or_else(|| "pending notes distilled".into());
    pa("distill", compact.error.is_none(), &compact_line);
    // 2. New notes stop embedding from now on.
    if !cfg.memory.scrolls.embed_only {
        os.update(|c| {
            c.memory.scrolls.embed_only = true;
            Ok(())
        })?;
        pa("embed-only", true, "Embed scrolls only switched on");
    }
    // 3. Plan from the live workspaces + the CLI sync ledger (read-only).
    let conn = AllmConn::local(&state, &cfg)?;
    let reader = AllmReader::new(conn.clone());
    let writer = AllmWriter::for_memory(conn);
    let note_ws = cfg.anythingllm.workspaces.get("librarian").filter(|s| !s.is_empty()).cloned();
    let scroll_ws = cfg.memory.scrolls.sanitized_workspace();
    let state_json = PathBuf::from(state.snapshot().gateway.workdir).join("data").join("memory-scrolls").join("state.json");
    let ledger = tauri::async_runtime::spawn_blocking(move || hygiene::read_sync_ledger(&state_json)).await.unwrap_or_default();
    let mut slugs: Vec<String> = note_ws.into_iter().collect();
    if !slugs.contains(&scroll_ws) {
        slugs.push(scroll_ws);
    }
    let mut removed_notes = 0;
    let mut removed_dupes = 0;
    let mut kept = 0;
    for slug in slugs.iter().filter(|s| !never_touch(s)) {
        let ws = reader.get_workspace(slug, 15).await?;
        let plan = hygiene::plan_purge(&hygiene::ws_docs(&ws), &ledger);
        kept += plan.kept_scrolls;
        let mut un_embed: Vec<String> = plan.raw_notes.clone();
        un_embed.extend(plan.scroll_dupes.iter().cloned());
        if un_embed.is_empty() {
            pa("plan", true, &format!("{slug}: nothing to purge ({} scroll group(s) kept)", plan.kept_scrolls));
            continue;
        }
        match writer.update_embeddings(slug, &[], &un_embed, 120).await {
            Ok(_) => {
                removed_notes += plan.raw_notes.len();
                removed_dupes += plan.scroll_dupes.len();
                pa("un-embed", true, &format!("{slug}: {} raw note(s), {} duplicate scroll(s)", plan.raw_notes.len(), plan.scroll_dupes.len()));
            }
            Err(e) => {
                pa("un-embed", false, &format!("{slug}: {e}"));
                return Err(format!("{slug}: un-embed failed ({e}); nothing was removed"));
            }
        }
        if !plan.raw_notes.is_empty() {
            if let Err(e) = writer.remove_documents(&plan.raw_notes, 120).await {
                pa("remove", false, &format!("{slug}: {e} (already un-embedded)"));
            }
        }
    }
    let out = json!({ "compaction": compact_line, "rawNotesRemoved": removed_notes, "scrollDuplicatesRemoved": removed_dupes, "scrollsKept": kept, "embedOnly": true });
    pa("done", true, &out.to_string());
    bridge.log(json!({ "type": "memory-purge-raw", "result": out }));
    Ok(out)
}

// ── Mount / unmount ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRequest {
    month: String,
    /// "local" | "droplet"
    target: String,
    #[serde(default)]
    approved: bool,
}

/// Mount / unmount input check (pure): `month` is a real YYYY-MM (it becomes a vault path) and
/// `target` is local or droplet.
pub(crate) fn validate_mount_request(month: &str, target: &str) -> Result<(), String> {
    if !hygiene::valid_period_id(month) {
        return Err("month must be YYYY-MM".into());
    }
    if !matches!(target, "local" | "droplet") {
        return Err("target must be local or droplet".into());
    }
    Ok(())
}

fn mount_endpoint(state: &DispatchState, cfg: &OsConfig, target: &str) -> Result<(String, String), String> {
    match target {
        "local" => Ok((cfg.anythingllm.base_url.clone(), super::secrets::get(state, "anythingllm").ok_or("AnythingLLM key missing")?)),
        "droplet" => {
            if !cfg.droplet.enabled {
                return Err("droplet is switched off".into());
            }
            if cfg.privacy.kill_switch || cfg.compute.mode == os_core::ComputeMode::Local {
                return Err("kill switch / LOCAL ONLY — cloud mounts are blocked".into());
            }
            Ok((cfg.droplet.anythingllm_url.clone(), os_core::os_secret("anythingllm-remote").ok_or("remote AnythingLLM key missing")?))
        }
        _ => Err("target must be local or droplet".into()),
    }
}

#[tauri::command]
pub async fn memory_mount(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: MountRequest) -> Result<LedgerEntry, String> {
    validate_mount_request(&req.month, &req.target)?;
    let cfg = os.snapshot();
    // D16: never ingest into a Booking workspace (checked before any I/O).
    check_mount_workspace(&cfg.memory.mount_workspace)?;
    if req.target == "droplet" {
        os_core::gate(&bridge, cfg.permissions.cloud, "cloud", req.approved, json!({ "action": "memory-mount", "month": req.month }))?;
    }
    let mut l = load_ledger(&cfg, &req.month)?;
    if l.mounts.iter().any(|m| m.target == req.target) {
        return Ok(l);
    }
    let (base, key) = mount_endpoint(&state, &cfg, &req.target)?;
    let book = String::from_utf8(vault_read(&vault_dir(&cfg).join(&req.month), l.files.get("summary").ok_or("no summary")?)?).map_err(|e| e.to_string())?;
    let ws = cfg.memory.mount_workspace.clone();
    let writer = AllmWriter::for_memory(AllmConn::with_key(&state, &base, key));
    let v = writer.raw_text_ingest(&book, &ws, &format!("Memory Book {}", req.month), "agentic-os memory vault", 120).await?;
    let location = v["documents"][0]["location"].as_str().ok_or("AnythingLLM did not return the document location")?.to_string();
    l.mounts.push(Mount { target: req.target.clone(), workspace: ws, location, at: os_core::now_secs() });
    save_ledger(&cfg, &l)?;
    bridge.log(json!({ "type": "memory-mount", "month": req.month, "target": req.target }));
    Ok(l)
}

#[tauri::command]
pub async fn memory_unmount(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, req: MountRequest) -> Result<LedgerEntry, String> {
    validate_mount_request(&req.month, &req.target)?;
    let cfg = os.snapshot();
    let mut l = load_ledger(&cfg, &req.month)?;
    let Some(m) = l.mounts.iter().find(|m| m.target == req.target).cloned() else { return Ok(l) };
    let (base, key) = mount_endpoint(&state, &cfg, &req.target)?;
    let writer = AllmWriter::for_memory(AllmConn::with_key(&state, &base, key));
    let _ = writer.update_embeddings(&m.workspace, &[], std::slice::from_ref(&m.location), 60).await;
    writer.remove_documents(std::slice::from_ref(&m.location), 60).await?;
    l.mounts.retain(|x| x.target != req.target);
    save_ledger(&cfg, &l)?;
    bridge.log(json!({ "type": "memory-unmount", "month": req.month, "target": req.target }));
    Ok(l)
}

/// Decrypt one archive file into `<vault>/<month>/unlocked/` (for training / reading).
#[tauri::command]
pub fn memory_export(os: State<'_, OsState>, month: String, kind: String) -> Result<String, String> {
    let cfg = os.snapshot();
    if !hygiene::valid_period_id(&month) {
        return Err("bad period id".into());
    }
    let l = load_ledger(&cfg, &month)?;
    let fname = l.files.get(&kind).ok_or("kind must be raw, summary or dataset")?;
    let dir = vault_dir(&cfg).join(&month);
    let bytes = vault_read(&dir, fname)?;
    let out_dir = dir.join("unlocked");
    refuse_hub_vault(&out_dir)?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out = out_dir.join(fname.trim_end_matches(".enc"));
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_writes_under_the_read_only_hub_are_refused() {
        // Lexical refusals: nothing is created (the guard runs before create_dir_all / write).
        for d in [r"C:\ai-hub\vault\locked-archives\2026-11", r"c:/AI-HUB/vault/x", r"\\localhost\C$\ai-hub\vault\2026-11"] {
            let dir = Path::new(d);
            assert_eq!(vault_write(dir, "raw_backup_2026_11.json", b"{}", None), Err(VAULT_UNDER_HUB.to_string()), "{d}");
            assert_eq!(refuse_hub_vault(&dir.join("unlocked")), Err(VAULT_UNDER_HUB.to_string()));
        }
        let mut cfg = OsConfig::default();
        cfg.memory.vault_dir = r"C:\ai-hub\vault\locked-archives".into();
        let l = LedgerEntry { month: "2026-11".into(), ..Default::default() };
        assert_eq!(save_ledger(&cfg, &l), Err(VAULT_UNDER_HUB.to_string()));
        // A vault elsewhere still writes.
        let base = std::env::temp_dir().join(format!("aos-vault-guard-{}-{}", std::process::id(), os_core::now_secs()));
        assert_eq!(vault_write(&base.join("2026-11"), "x.json", b"{}", None), Ok("x.json".to_string()));
        cfg.memory.vault_dir = base.to_string_lossy().into_owned();
        assert!(save_ledger(&cfg, &l).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn seal_roundtrip() {
        let ct = seal(b"secret memory", "correct horse battery").unwrap();
        assert_eq!(open(&ct, "correct horse battery").unwrap(), b"secret memory");
        assert!(open(&ct, "wrong").is_err());
    }

    #[test]
    fn months() {
        assert!(valid_month("2026-11"));
        assert!(!valid_month("2026-13"));
        let (a, b) = month_bounds("2026-02");
        assert!(b - a >= 28 * 86400 && b - a <= 29 * 86400 + 3600);
    }

    #[test]
    fn mount_rejects_traversal_and_bad_months() {
        assert!(validate_mount_request("2026-11", "local").is_ok());
        assert!(validate_mount_request("2026-11", "droplet").is_ok());
        for m in ["..\\..\\x", "../../x", "2026-13", "2026-00", "2026-1", "26-11", "2026/11", ""] {
            assert!(validate_mount_request(m, "local").is_err(), "{m}");
        }
        assert!(validate_mount_request("2026-11", "remote").is_err());
    }

    fn live(v: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        v.iter().map(|(s, n)| (s.to_string(), n.map(String::from))).collect()
    }

    #[test]
    fn pull_and_flush_use_persisted_threads() {
        // Live shape: no names; 12 historical duplicates plus the one the OS recorded.
        let names: Vec<String> = (0..12).map(|i| format!("d{i}")).collect();
        let mut ws: Vec<(&str, Option<&str>)> = names.iter().map(|n| (n.as_str(), None)).collect();
        ws.push(("mine", None));
        let ws = live(&ws);
        assert_eq!(threads_to_pull(Some("mine"), &ws, "Tony · 2026-11"), vec!["mine".to_string()]);
        assert_eq!(threads_to_flush(Some("mine"), &ws), vec!["mine".to_string()]);
        // Nothing recorded → nothing pulled from threads, nothing deleted.
        assert!(threads_to_pull(None, &ws, "Tony · 2026-11").is_empty());
        assert!(threads_to_flush(None, &ws).is_empty());
        // A recorded slug that no longer exists is skipped.
        assert!(threads_to_flush(Some("gone"), &ws).is_empty());
        // An older API with names: name matches are READ, but never deleted.
        let named = live(&[("a", Some("Tony · 2026-11")), ("b", Some("Tony · 2026-11")), ("mine", Some("Tony · 2026-11"))]);
        assert_eq!(threads_to_pull(Some("mine"), &named, "Tony · 2026-11"), vec!["mine", "a", "b"]);
        assert_eq!(threads_to_flush(Some("mine"), &named), vec!["mine".to_string()]);
        assert!(threads_to_flush(None, &named).is_empty());
    }

    #[test]
    fn flush_deletes_only_the_persisted_thread_over_http() {
        use super::super::allm::mock::{start, Req, Resp};
        tauri::async_runtime::block_on(async {
            let srv = start(|r: &Req| {
                if r.method == "GET" {
                    return Resp::json(json!({ "workspace": { "slug": "booking", "threads": [{ "slug": "dup-1" }, { "slug": "dup-2" }, { "slug": "mine" }] } }));
                }
                Resp::json(json!({}))
            })
            .await;
            let st = DispatchState::default();
            let conn = AllmConn::with_key(&st, &srv.base, "k".into());
            let reader = AllmReader::new(conn.clone());
            let writer = AllmWriter::for_memory(conn);
            let map = super::super::allm::MemThreads::default();
            map.put(&srv.base, "booking", &super::super::allm::tony_key("2026-11"), "mine");
            let live = reader.get_workspace("booking", 5).await.map(|ws| super::super::allm::thread_list(&ws)).unwrap();
            for ts in threads_to_flush(map.get(&srv.base, "booking", "tony:2026-11").as_deref(), &live) {
                writer.delete_thread("booking", &ts, 5).await.unwrap();
            }
            let deletes: Vec<String> = srv.reqs().into_iter().filter(|r| r.method == "DELETE").map(|r| r.path).collect();
            assert_eq!(deletes, vec!["/api/v1/workspace/booking/thread/mine".to_string()]);
        });
    }

    fn ws_map() -> BTreeMap<String, String> {
        [("general", "my-workspace"), ("booking", "booking"), ("librarian", "librarian"), ("coder", "coder"), ("ops", ""), ("dup", "librarian")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn booking_workspaces_are_never_harvested_flushed_or_mounted() {
        let (slugs, skipped) = harvest_slugs(&ws_map());
        assert_eq!(skipped, 2);
        let names: BTreeSet<&str> = slugs.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(names, ["coder", "librarian"].into_iter().collect());
        assert_eq!(flush_slugs(&ws_map()), ["coder".to_string(), "librarian".to_string()].into_iter().collect());
        for ws in ["my-workspace", "booking", " booking "] {
            assert!(check_mount_workspace(ws).unwrap_err().contains("Booking workspace"), "{ws}");
        }
        assert!(check_mount_workspace("librarian").is_ok());
    }

    #[test]
    fn harvest_and_flush_send_zero_requests_to_booking_slugs() {
        use super::super::allm::mock::{start, Req, Resp};
        tauri::async_runtime::block_on(async {
            let srv = start(|r: &Req| {
                if r.method == "GET" {
                    return Resp::json(json!({ "workspace": { "slug": "x", "threads": [{ "slug": "mine" }] }, "history": [] }));
                }
                Resp::json(json!({}))
            })
            .await;
            let st = DispatchState::default();
            let conn = AllmConn::with_key(&st, &srv.base, "k".into());
            let reader = AllmReader::new(conn.clone());
            let writer = AllmWriter::for_memory(conn);
            let map = super::super::allm::MemThreads::default();
            for slug in ["my-workspace", "booking", "librarian", "coder"] {
                map.put(&srv.base, slug, &super::super::allm::tony_key("2026-11"), "mine");
            }
            // The harvest pull loop over `harvest_slugs`.
            let (slugs, _) = harvest_slugs(&ws_map());
            let mut out = Vec::new();
            for (slug, role) in &slugs {
                let _ = pull_allm(&reader, &map, slug, "2026-11", "Tony · 2026-11", month_bounds("2026-11"), role, "local", &mut out).await;
            }
            // The flush delete loop over `flush_slugs`.
            for slug in &flush_slugs(&ws_map()) {
                let live = reader.get_workspace(slug, 5).await.map(|ws| super::super::allm::thread_list(&ws)).unwrap_or_default();
                for ts in threads_to_flush(map.get(&srv.base, slug, "tony:2026-11").as_deref(), &live) {
                    writer.delete_thread(slug, &ts, 5).await.unwrap();
                }
            }
            let reqs = srv.reqs();
            assert!(!reqs.is_empty());
            assert!(reqs.iter().all(|r| !r.path.contains("my-workspace") && !r.path.contains("/booking")), "{:?}", reqs.iter().map(|r| r.path.clone()).collect::<Vec<_>>());
            assert!(reqs.iter().any(|r| r.method == "DELETE" && r.path == "/api/v1/workspace/librarian/thread/mine"));
        });
    }

    #[test]
    fn dataset_dedupes_and_filters() {
        let cfg = OsConfig::default();
        let prs = vec![
            ("booking".into(), "When is the shoot?".into(), "Thursday at 9am at the studio on King.".into()),
            ("booking".into(), "When is the shoot?".into(), "Thursday at 9am at the studio on King.".into()),
            ("general".into(), "weather?".into(), "I am unable to access real-time data.".into()),
        ];
        let (s, n) = dataset(&cfg, &prs);
        assert_eq!(n, 1, "{s}");
        assert!(s.contains("\"messages\""));
    }
}
