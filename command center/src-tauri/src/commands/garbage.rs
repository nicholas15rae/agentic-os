//! The Garbage daemon: deterministic maintenance, NOT an agent.
//!
//! - Not in `AgentRole` / `TaskPacket`, never routed to, never calls a model: 0 VRAM.
//! - Started at boot (`lib.rs`). Two triggers:
//!   1. **Schedule + quotas**: hourly at most (`every`), only when the user is idle, it applies TTLs and a size quota to its allowlisted
//!      roots (oldest first until under quota).
//!   2. **Purge handshake**: `handshake(packet_id)` from Security when a packet closes (done or
//!      failed closed) wipes that packet's scratch at once.
//! - **Hard path allowlist** (`Allow`): it can only ever delete inside
//!   `<config>/packets` (packet scratch), `<config>/security/dumps` and compress inside
//!   `<config>/memory-tiers`. Every target passes `security_gate::check_path("garbage", …)`
//!   (so `vault/finance` and secret locations are refused) AND the allowlist; workspace source,
//!   task locks (tasks.db), staging builds and the Finance vault are never reachable.
//! - Compresses stale Memory Module snapshots (`archive.jsonl` over `ARCHIVE_ROLL_BYTES`) into
//!   `archive-<ts>.jsonl.gz`, and graduates stale Active-RAG entries (`memtier::graduate`).

use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// Floor for the scheduled hygiene pass (`roster.garbage_minutes` can only lengthen it). It used
/// to tick every 5 min and retry every 60 s whenever another daemon held the stagger slot, which
/// read as "sweeping every minute"; the librarian plan wants hourly, idle-only maintenance.
pub const MIN_EVERY_MINUTES: u32 = 60;
/// First scheduled pass after boot (handshake purges still run at once).
const BOOT_DELAY: Duration = Duration::from_secs(300);
/// Retry after a deferral (user busy, another daemon in the stagger slot).
const DEFER_RETRY: Duration = Duration::from_secs(600);
/// Quiet window (minutes since the last interactive turn) a scheduled pass waits for.
const QUIET_MINS: u32 = 5;
/// A pass put off this long (always busy) runs anyway.
const MAX_DEFER: Duration = Duration::from_secs(6 * 3600);

/// The effective scheduled cadence for a configured `roster.garbage_minutes`.
pub fn every(minutes: u32) -> Duration {
    Duration::from_secs(u64::from(minutes.max(MIN_EVERY_MINUTES)) * 60)
}

/// Minutes shown in the UI for a configured value (the clamped, real cadence).
pub fn every_minutes(minutes: u32) -> u32 {
    minutes.max(MIN_EVERY_MINUTES)
}
/// Packet scratch older than this is purged even without a handshake.
pub const SCRATCH_TTL: Duration = Duration::from_secs(24 * 3600);
/// Packet scratch quota (bytes): over it, the oldest packet dirs go first.
pub const SCRATCH_QUOTA: u64 = 200 * 1024 * 1024;
pub const ARCHIVE_ROLL_BYTES: u64 = 4 * 1024 * 1024;

/// What the daemon may touch: exactly these roots.
#[derive(Clone, Debug)]
pub struct Allow {
    pub scratch: PathBuf,
    pub dumps: PathBuf,
    pub memory: PathBuf,
}

impl Allow {
    pub fn for_config(dir: &Path) -> Self {
        Self { scratch: dir.join("packets"), dumps: dir.join("security").join("dumps"), memory: dir.join("memory-tiers") }
    }

    fn roots(&self) -> Vec<PathBuf> {
        vec![self.scratch.clone(), self.dumps.clone(), self.memory.clone()]
    }

    /// The double gate every delete / rewrite passes.
    pub fn permit(&self, p: &Path) -> Result<PathBuf, String> {
        super::security_gate::check_path("garbage", p, &self.roots())
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    /// Unix ms of the last tick / handshake handled.
    pub heartbeat_at: Option<u64>,
    pub last_purge_at: Option<u64>,
    /// Unix ms of the last scheduled pass that actually ran (a deferral is only a heartbeat).
    pub last_pass_at: Option<u64>,
    /// Why the last scheduled pass was put off, cleared when one runs.
    pub deferred: Option<String>,
    pub last_result: Value,
    pub handshakes: u64,
    pub refused: u64,
}

fn status() -> &'static Mutex<Status> {
    static S: OnceLock<Mutex<Status>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Status { last_result: Value::Null, ..Default::default() }))
}

pub fn snapshot() -> Status {
    status().lock().unwrap().clone()
}

fn chan() -> &'static (tokio::sync::mpsc::UnboundedSender<String>, Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<String>>>) {
    static C: OnceLock<(tokio::sync::mpsc::UnboundedSender<String>, Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<String>>>)> = OnceLock::new();
    C.get_or_init(|| {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (tx, Mutex::new(Some(rx)))
    })
}

/// Security's purge handshake: wipe `<scratch>/<packet_id>` now (validated id only).
pub fn handshake(packet_id: &str) {
    if valid_id(packet_id) {
        let _ = chan().0.send(packet_id.to_string());
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| {
                    let m = e.metadata();
                    match m {
                        Ok(m) if m.is_dir() => dir_size(&e.path()),
                        Ok(m) => m.len(),
                        Err(_) => 0,
                    }
                })
                .sum()
        })
        .unwrap_or(0)
}

fn modified(p: &Path) -> SystemTime {
    std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Delete one path after both gates. Never follows a link out (symlink metadata).
fn purge_path(a: &Allow, p: &Path, refused: &mut u64) -> bool {
    let Ok(ok) = a.permit(p) else {
        *refused += 1;
        return false;
    };
    let Ok(meta) = std::fs::symlink_metadata(&ok) else { return false };
    if meta.file_type().is_symlink() {
        return std::fs::remove_file(&ok).is_ok();
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(&ok).is_ok()
    } else {
        std::fs::remove_file(&ok).is_ok()
    }
}

/// Wipe one packet's scratch (the handshake).
pub fn purge_packet(a: &Allow, packet_id: &str) -> Result<bool, String> {
    if !valid_id(packet_id) {
        return Err("bad packet id".into());
    }
    let p = a.scratch.join(packet_id);
    if !p.exists() {
        return Ok(false);
    }
    let mut refused = 0;
    let ok = purge_path(a, &p, &mut refused);
    status().lock().unwrap().refused += refused;
    Ok(ok)
}

/// One scheduled pass: TTLs, the scratch quota, archive compression, memory graduation.
pub fn pass(a: &Allow, dump_keep_days: u32, graduate_days: u32, quota: u64, now: SystemTime) -> Value {
    let mut refused = 0u64;
    let mut scratch_purged = 0;
    // 1. Packet scratch past its TTL.
    let mut dirs: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(&a.scratch).map(|rd| rd.flatten().map(|e| (modified(&e.path()), e.path())).collect()).unwrap_or_default();
    dirs.sort();
    dirs.retain(|(t, p)| {
        let old = now.duration_since(*t).map(|d| d >= SCRATCH_TTL).unwrap_or(false);
        if old && purge_path(a, p, &mut refused) {
            scratch_purged += 1;
            false
        } else {
            true
        }
    });
    // 2. Scratch quota: oldest first.
    let mut total: u64 = dirs.iter().map(|(_, p)| if p.is_dir() { dir_size(p) } else { std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) }).sum();
    for (_, p) in &dirs {
        if total <= quota {
            break;
        }
        let sz = if p.is_dir() { dir_size(p) } else { std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) };
        if purge_path(a, p, &mut refused) {
            total = total.saturating_sub(sz);
            scratch_purged += 1;
        }
    }
    // 3. Security dumps past their TTL.
    let keep = Duration::from_secs(dump_keep_days.max(1) as u64 * 86_400);
    let mut dumps = 0;
    if let Ok(rd) = std::fs::read_dir(&a.dumps) {
        for e in rd.flatten() {
            let p = e.path();
            if now.duration_since(modified(&p)).map(|d| d >= keep).unwrap_or(false) && purge_path(a, &p, &mut refused) {
                dumps += 1;
            }
        }
    }
    // 4. Stale memory snapshots: roll big archives into gzip, then graduate stale Tier-1 entries.
    let mut compressed = 0;
    if let Ok(rd) = std::fs::read_dir(&a.memory) {
        for e in rd.flatten() {
            let arch = e.path().join("archive.jsonl");
            if std::fs::metadata(&arch).map(|m| m.len() > ARCHIVE_ROLL_BYTES).unwrap_or(false) && a.permit(&arch).is_ok() && compress(&arch, now).is_ok() {
                compressed += 1;
            }
        }
    }
    let graduated = super::memtier::graduate(graduate_days);
    let out = json!({ "scratchPurged": scratch_purged, "dumpsPurged": dumps, "archivesCompressed": compressed, "graduated": graduated, "refused": refused });
    let mut s = status().lock().unwrap();
    s.refused += refused;
    s.last_result = out.clone();
    out
}

fn compress(arch: &Path, now: SystemTime) -> Result<(), String> {
    let ts = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let gz = arch.with_file_name(format!("archive-{ts}.jsonl.gz"));
    let body = std::fs::read(arch).map_err(|e| e.to_string())?;
    let f = std::fs::File::create(&gz).map_err(|e| e.to_string())?;
    let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
    enc.write_all(&body).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())?;
    std::fs::remove_file(arch).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    super::arbiter::now_ms()
}

/// The daemon (lib.rs boot): handshakes as they come, a scheduled idle-only pass every `every(..)`.
pub async fn daemon(app: tauri::AppHandle) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_config_dir() else { return };
    let a = Allow::for_config(&dir);
    let Some(mut rx) = chan().1.lock().unwrap().take() else { return };
    {
        let mut s = status().lock().unwrap();
        s.running = true;
        s.heartbeat_at = Some(now_ms());
    }
    // Next scheduled pass: `every(roster.garbage_minutes)` after a pass (or a market-hours hold),
    // DEFER_RETRY while the user is active or another daemon holds the stagger slot.
    let mut next = tokio::time::Instant::now() + BOOT_DELAY;
    let mut deferred_since: Option<tokio::time::Instant> = None;
    let defer = |why: String| {
        let mut s = status().lock().unwrap();
        s.heartbeat_at = Some(now_ms());
        s.deferred = Some(why);
    };
    loop {
        tokio::select! {
            Some(id) = rx.recv() => {
                // Fail closed: a tampered rules file halts every automated purge (integrity.rs).
                if let Err(e) = super::integrity::ensure() {
                    eprintln!("[garbage] handshake {id} held: {e}");
                    continue;
                }
                let r = purge_packet(&a, &id);
                let mut s = status().lock().unwrap();
                s.handshakes += 1;
                s.heartbeat_at = Some(now_ms());
                if matches!(r, Ok(true)) {
                    s.last_purge_at = Some(now_ms());
                }
                drop(s);
                super::arbiter::get().handoff("security", "garbage", &format!("purge handshake {id}"));
            }
            _ = tokio::time::sleep_until(next) => {
                let r = app.state::<super::os_core::OsState>().snapshot().roster.clone();
                next = tokio::time::Instant::now() + every(r.garbage_minutes);
                if super::integrity::ensure().is_err() {
                    continue;
                }
                // Alive either way: a held / deferred pass still counts as a heartbeat (system_health),
                // but never as a sweep (`last_pass_at`).
                if let Some(why) = super::stagger::garbage_hold_reason(now_ms()) {
                    super::stagger::note_deferred("garbage", &why);
                    defer(why);
                    continue;
                }
                // Idle-only: no voice turn or Tony speaking, and the quiet window over. Builds and
                // queued tasks don't count (one stuck task would starve maintenance forever), and
                // after MAX_DEFER of continuous deferral the pass runs anyway (it is cheap file work).
                let starved = deferred_since.is_some_and(|t: tokio::time::Instant| t.elapsed() >= MAX_DEFER);
                if let Some(why) = super::compaction::user_busy_reason(&app, QUIET_MINS).filter(|_| !starved) {
                    super::stagger::note_deferred("garbage", &why);
                    defer(why);
                    deferred_since.get_or_insert_with(tokio::time::Instant::now);
                    next = tokio::time::Instant::now() + DEFER_RETRY;
                    continue;
                }
                deferred_since = None;
                if let Err(why) = super::stagger::claim("garbage", super::stagger::gap_seconds()) {
                    defer(why);
                    next = tokio::time::Instant::now() + DEFER_RETRY;
                    continue;
                }
                let (a2, keep, grad) = (a.clone(), r.dump_keep_days, r.graduate_after_days);
                let res = super::arbiter::get().run_task("garbage", "hygiene pass", async move {
                    tauri::async_runtime::spawn_blocking(move || Ok(pass(&a2, keep, grad, SCRATCH_QUOTA, SystemTime::now()))).await.map_err(|e| e.to_string())?
                }).await;
                let mut s = status().lock().unwrap();
                s.heartbeat_at = Some(now_ms());
                s.last_pass_at = Some(now_ms());
                s.deferred = None;
                if let Ok(v) = res {
                    let did = ["scratchPurged", "dumpsPurged", "archivesCompressed"].iter().any(|k| v[*k].as_u64().unwrap_or(0) > 0);
                    if did {
                        s.last_purge_at = Some(now_ms());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_pass_is_hourly_at_most_often() {
        // The old 30-min roster value (and anything shorter) is lifted to the hourly floor.
        assert_eq!(every(1), Duration::from_secs(3600));
        assert_eq!(every(30), Duration::from_secs(3600));
        assert_eq!(every_minutes(30), 60);
        // A longer setting is honoured.
        assert_eq!(every(180), Duration::from_secs(3 * 3600));
        assert_eq!(every_minutes(180), 180);
        // Deferrals retry far slower than the old 60 s loop, and can't starve the pass for good.
        assert!(DEFER_RETRY >= Duration::from_secs(600));
        assert!(MAX_DEFER <= Duration::from_secs(6 * 3600));
        // Only the USER defers it: a queued / stuck build never does (user_busy has no task input).
        use super::super::compaction::{user_busy, IdleWait};
        let now = 10_000_000;
        assert!(user_busy(None, 0, now, 300_000).is_none(), "never interacted: idle");
        assert!(user_busy(None, now - 400_000, now, 300_000).is_none(), "quiet window over");
        assert!(matches!(user_busy(None, now - 60_000, now, 300_000), Some(IdleWait::Quiet { .. })));
        assert!(matches!(user_busy(Some((false, true, false)), 0, now, 300_000), Some(IdleWait::Voice)));
    }

    fn setup(tag: &str) -> (PathBuf, Allow) {
        let dir = std::env::temp_dir().join(format!("garbage-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), Allow::for_config(&dir))
    }

    #[test]
    fn handshake_purges_only_that_packet_and_never_workspace_or_vault_files() {
        let _g = super::super::memtier::test_lock();
        let (dir, a) = setup("hs");
        let pkt = a.scratch.join("pkt-1");
        let other = a.scratch.join("pkt-2");
        std::fs::create_dir_all(&pkt).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(pkt.join("fix_token_refresh.md"), "draft").unwrap();
        std::fs::write(other.join("keep.md"), "keep").unwrap();
        // Active workspace + task lock + vault next to it.
        let ws = dir.join("workspace").join("src");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("main.rs"), "fn main(){}").unwrap();
        std::fs::write(dir.join("tasks.db"), "lock").unwrap();
        let vault = dir.join("vault").join("finance");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("ledger.aosv"), "sealed").unwrap();

        assert_eq!(purge_packet(&a, "pkt-1"), Ok(true));
        assert!(!pkt.exists() && other.join("keep.md").exists());
        assert!(purge_packet(&a, "../workspace").is_err(), "ids can't walk out");
        // The gates themselves refuse anything outside the allowlist.
        for p in [ws.join("main.rs"), dir.join("tasks.db"), vault.join("ledger.aosv")] {
            assert!(a.permit(&p).is_err(), "{}", p.display());
        }
        // A full scheduled pass leaves them alone too.
        super::super::memtier::reset_for_test(None);
        pass(&a, 7, 7, SCRATCH_QUOTA, SystemTime::now() + Duration::from_secs(400 * 86_400));
        assert!(ws.join("main.rs").exists() && dir.join("tasks.db").exists() && vault.join("ledger.aosv").exists());
        assert!(!other.exists(), "past its TTL, the other packet's scratch goes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quota_purges_oldest_scratch_and_ttl_keeps_fresh_dumps() {
        let _g = super::super::memtier::test_lock();
        super::super::memtier::reset_for_test(None);
        let (dir, a) = setup("quota");
        std::fs::create_dir_all(&a.dumps).unwrap();
        std::fs::write(a.dumps.join("today.jsonl"), "{}").unwrap();
        // Two packets; the quota forces the older one out (written first).
        for (id, n) in [("pkt-old", 1), ("pkt-new", 2)] {
            let d = a.scratch.join(id);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("blob.bin"), vec![n as u8; 1024]).unwrap();
            std::thread::sleep(Duration::from_millis(30));
        }
        let v = pass(&a, 7, 7, SCRATCH_QUOTA, SystemTime::now());
        assert_eq!(v["scratchPurged"], 0, "under quota, inside TTL: nothing goes");
        assert!(a.dumps.join("today.jsonl").exists());
        // Over a 1.5 KB quota: the oldest packet goes, the newest stays.
        let v = pass(&a, 7, 7, 1500, SystemTime::now());
        assert_eq!(v["scratchPurged"], 1);
        assert!(!a.scratch.join("pkt-old").exists() && a.scratch.join("pkt-new").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn big_archives_are_compressed_in_place() {
        let _g = super::super::memtier::test_lock();
        super::super::memtier::reset_for_test(None);
        let (dir, a) = setup("gz");
        let ns = a.memory.join("build_circle");
        std::fs::create_dir_all(&ns).unwrap();
        std::fs::write(ns.join("archive.jsonl"), vec![b'x'; (ARCHIVE_ROLL_BYTES + 10) as usize]).unwrap();
        let v = pass(&a, 7, 7, SCRATCH_QUOTA, SystemTime::now());
        assert_eq!(v["archivesCompressed"], 1);
        assert!(!ns.join("archive.jsonl").exists());
        assert!(std::fs::read_dir(&ns).unwrap().flatten().any(|e| e.file_name().to_string_lossy().ends_with(".jsonl.gz")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
