//! Quarantine: Garbage and Security never hard-delete business data.
//!
//! A flagged item is staged, not deleted, in this order:
//! 1. **Snapshot**: its bytes are copied to `<config>/staging/quarantine/<itemId>/snapshot.bin`
//!    (`create_new`, fsynced), read back and checked against their SHA-256.
//! 2. **Metadata**: `meta.json` records `{itemId, businessId, sourceAgent, reasonCode, reason,
//!    timestamp, backupPath, sha256, kind, rel, status}`.
//! 3. **Move**: only then is the original removed from the business's folder.
//!
//! The only hard delete is **Approve Purge**: it needs `approved: true` from the review queue
//! (else `PERMISSION_REQUIRED:purge`), drops the snapshot and keeps `meta.json` as a tombstone.
//! **Reject & Restore** re-verifies the snapshot hash and puts the bytes back into the SAME
//! business (never another), refusing to overwrite anything already there.
//!
//! Every step is gated by `integrity::ensure` (fail closed) and written to the audit log.
//! Kinds:
//! - `note`: a file in a business's memory folder.
//! - `blocked_write`: a write Security refused (cross-domain). There is no original to move, and
//!   restoring it releases the write into the business.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::business_registry::Store;
use super::ops_scope::{BusinessScope, CrossHit};

pub const SNAPSHOT: &str = "snapshot.bin";
pub const META: &str = "meta.json";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Note,
    BlockedWrite,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QStatus {
    Pending,
    Purged,
    Restored,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QItem {
    pub item_id: String,
    pub business_id: String,
    pub source_agent: String,
    /// `cross_domain` | `empty_file` | `temp_leftover` | `flagged`.
    pub reason_code: String,
    pub reason: String,
    pub timestamp: u64,
    pub backup_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub kind: Kind,
    /// The path inside the business's folder it came from / goes back to.
    pub rel: String,
    pub status: QStatus,
    #[serde(default)]
    pub resolved_at: Option<u64>,
}

pub struct Quarantine {
    root: PathBuf,
    lock: Mutex<()>,
}

fn new_item_id() -> String {
    format!("q-{}", super::envelope::new_task_id(super::arbiter::now_ms() as i64).to_ascii_lowercase().replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "-"))
}

fn valid_item_id(id: &str) -> bool {
    id.starts_with("q-") && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn audit(actor: &str, action: &str, q: &QItem, detail: &str) {
    let _ = super::ops_audit::append(actor, action, &q.business_id, &q.item_id, &format!("{} {} ({}){}", q.reason_code, q.rel, q.source_agent, if detail.is_empty() { String::new() } else { format!(": {detail}") }));
}

impl Quarantine {
    pub fn new(root: PathBuf) -> Self {
        Self { root, lock: Mutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn item_dir(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_item_id(id) {
            return Err(format!("invalid review item id {:?}", id.chars().take(40).collect::<String>()));
        }
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        super::staging::safe_join(&self.root, id)
    }

    fn write_meta(&self, q: &QItem) -> Result<(), String> {
        let dir = self.item_dir(&q.item_id)?;
        super::staging::atomic_write(&dir.join(META), &serde_json::to_vec_pretty(q).map_err(|e| e.to_string())?)
    }

    /// Snapshot `bytes` into a fresh item folder and verify it; returns the snapshot path.
    fn snapshot(&self, id: &str, bytes: &[u8]) -> Result<(PathBuf, String), String> {
        use std::io::Write;
        let dir = self.item_dir(id)?;
        std::fs::create_dir(&dir).map_err(|e| format!("quarantine {}: {e}", dir.display()))?;
        let snap = dir.join(SNAPSHOT);
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&snap).map_err(|e| format!("snapshot: {e}"))?;
        f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| format!("snapshot: {e}"))?;
        drop(f);
        let want = super::integrity::sha256_hex(bytes);
        let back = std::fs::read(&snap).map_err(|e| format!("snapshot read-back: {e}"))?;
        if super::integrity::sha256_hex(&back) != want {
            let _ = std::fs::remove_dir_all(&dir);
            return Err("snapshot read-back didn't match; nothing was moved".into());
        }
        Ok((snap, want))
    }

    /// Stage a note out of a business's folder (Garbage sweep or an explicit flag).
    pub fn stage_note(&self, scope: &BusinessScope, rel: &str, source_agent: &str, reason_code: &str, reason: &str) -> Result<QItem, String> {
        super::integrity::ensure()?;
        let _g = self.lock.lock().unwrap();
        let src = scope.jail(rel)?;
        let md = std::fs::symlink_metadata(&src).map_err(|e| format!("{rel}: {e}"))?;
        if !md.is_file() || super::staging::is_reparse(&src) {
            return Err(format!("{rel}: not a regular file"));
        }
        let bytes = std::fs::read(&src).map_err(|e| format!("{rel}: {e}"))?;
        let id = new_item_id();
        let (snap, sha) = self.snapshot(&id, &bytes)?;
        let q = QItem {
            item_id: id,
            business_id: scope.id().into(),
            source_agent: source_agent.into(),
            reason_code: reason_code.into(),
            reason: reason.chars().take(300).collect(),
            timestamp: super::arbiter::now_ms(),
            backup_path: snap.to_string_lossy().into_owned(),
            sha256: sha,
            bytes: bytes.len() as u64,
            kind: Kind::Note,
            rel: rel.replace('\\', "/"),
            status: QStatus::Pending,
            resolved_at: None,
        };
        self.write_meta(&q)?;
        // Move: the original goes only after the snapshot and metadata are safely on disk.
        std::fs::remove_file(&src).map_err(|e| format!("{rel}: staged, but the original couldn't be moved: {e}"))?;
        audit(source_agent, "quarantine", &q, "");
        Ok(q)
    }

    /// Stage a write Security refused (nothing was written to the business).
    pub fn stage_blocked_write(&self, scope: &BusinessScope, rel: &str, text: &str, source_agent: &str, hits: &[CrossHit]) -> Result<QItem, String> {
        super::integrity::ensure()?;
        let _g = self.lock.lock().unwrap();
        let id = new_item_id();
        let (snap, sha) = self.snapshot(&id, text.as_bytes())?;
        let mut others: Vec<&str> = hits.iter().map(|h| h.business_id.as_str()).collect();
        others.dedup();
        let q = QItem {
            item_id: id,
            business_id: scope.id().into(),
            source_agent: source_agent.into(),
            reason_code: "cross_domain".into(),
            reason: format!("mentions another business ({})", others.join(", ")),
            timestamp: super::arbiter::now_ms(),
            backup_path: snap.to_string_lossy().into_owned(),
            sha256: sha,
            bytes: text.len() as u64,
            kind: Kind::BlockedWrite,
            rel: rel.replace('\\', "/"),
            status: QStatus::Pending,
            resolved_at: None,
        };
        self.write_meta(&q)?;
        audit(source_agent, "block_write", &q, "");
        Ok(q)
    }

    pub fn get(&self, id: &str) -> Result<QItem, String> {
        let dir = self.item_dir(id)?;
        let b = std::fs::read(dir.join(META)).map_err(|_| format!("no review item {id}"))?;
        serde_json::from_slice(&b).map_err(|e| format!("review item {id}: {e}"))
    }

    /// Every item, newest first.
    pub fn list(&self) -> Vec<QItem> {
        let Ok(rd) = std::fs::read_dir(&self.root) else { return vec![] };
        let mut v: Vec<QItem> = rd.flatten().filter_map(|e| e.file_name().to_str().filter(|n| valid_item_id(n)).and_then(|n| self.get(n).ok())).collect();
        v.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then(b.item_id.cmp(&a.item_id)));
        v
    }

    pub fn pending(&self) -> Vec<QItem> {
        self.list().into_iter().filter(|q| q.status == QStatus::Pending).collect()
    }

    fn read_snapshot(&self, q: &QItem) -> Result<Vec<u8>, String> {
        let b = std::fs::read(self.item_dir(&q.item_id)?.join(SNAPSHOT)).map_err(|e| format!("snapshot: {e}"))?;
        if super::integrity::sha256_hex(&b) != q.sha256 {
            return Err(format!("snapshot of {} failed its checksum; it was not restored", q.item_id));
        }
        Ok(b)
    }

    /// A text preview for Inspect (first 2000 characters; binary shows nothing).
    pub fn preview(&self, q: &QItem) -> Option<String> {
        let b = self.read_snapshot(q).ok()?;
        String::from_utf8(b).ok().map(|s| s.chars().take(2000).collect())
    }

    /// The ONLY hard delete: the user approved it in the review queue.
    pub fn purge(&self, id: &str, approved: bool) -> Result<QItem, String> {
        super::integrity::ensure()?;
        if !approved {
            return Err("PERMISSION_REQUIRED:purge".into());
        }
        let _g = self.lock.lock().unwrap();
        let mut q = self.get(id)?;
        if q.status != QStatus::Pending {
            return Err(format!("{id} is already {:?}", q.status).to_lowercase());
        }
        let snap = self.item_dir(id)?.join(SNAPSHOT);
        match std::fs::remove_file(&snap) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("purge {id}: {e}")),
        }
        q.status = QStatus::Purged;
        q.resolved_at = Some(super::arbiter::now_ms());
        self.write_meta(&q)?;
        audit("user", "purge_approved", &q, "");
        Ok(q)
    }

    /// Put an item back into its own business (or release a blocked write into it).
    pub fn restore(&self, id: &str, store: &Store) -> Result<QItem, String> {
        super::integrity::ensure()?;
        let _g = self.lock.lock().unwrap();
        let mut q = self.get(id)?;
        if q.status != QStatus::Pending {
            return Err(format!("{id} is already {:?}", q.status).to_lowercase());
        }
        let scope = store.scope(&q.business_id)?;
        let bytes = self.read_snapshot(&q)?;
        match q.kind {
            Kind::Note => {
                let target = scope.jail(&q.rel)?;
                if std::fs::symlink_metadata(&target).is_ok() {
                    return Err(format!("{} already exists in {}; move it aside first", q.rel, q.business_id));
                }
                let target = super::staging::ensure_parent(scope.memory_dir(), &q.rel)?;
                super::staging::atomic_write(&target, &bytes)?;
                scope.jail(&q.rel)?;
            }
            Kind::BlockedWrite => {
                let text = String::from_utf8(bytes).map_err(|_| "a blocked write must be text".to_string())?;
                scope.write_note_reviewed(&q.rel, &text)?;
            }
        }
        q.status = QStatus::Restored;
        q.resolved_at = Some(super::arbiter::now_ms());
        self.write_meta(&q)?;
        audit("user", "restore", &q, "");
        Ok(q)
    }

    /// Garbage's deterministic sweep of one business: empty notes and stale temp leftovers are
    /// STAGED (never deleted). Rules come from the verified `garbage.rules.json`.
    pub fn sweep(&self, scope: &BusinessScope, now_ms: u64) -> Result<Vec<QItem>, String> {
        let rules = super::integrity::ensure()?.garbage.sweep;
        let mut out = vec![];
        let min_age = rules.temp_min_age_minutes * 60_000;
        let mut cands: Vec<(String, &str, &str)> = vec![];
        fn walk(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, std::fs::Metadata)>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if super::staging::is_reparse(&p) {
                    continue;
                }
                match std::fs::symlink_metadata(&p) {
                    Ok(md) if md.is_dir() => walk(root, &p, out),
                    Ok(md) if md.is_file() => out.push((p, md)),
                    _ => {}
                }
            }
        }
        let mut files = vec![];
        walk(scope.memory_dir(), scope.memory_dir(), &mut files);
        for (p, md) in files {
            let Ok(rel) = p.strip_prefix(scope.memory_dir()) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let age = md.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| now_ms.saturating_sub(d.as_millis() as u64)).unwrap_or(0);
            if rules.temp_leftovers && name.starts_with(".tmp-") && name.ends_with(".part") && age >= min_age {
                cands.push((rel, "temp_leftover", "an interrupted write left this temp file behind"));
            } else if rules.empty_files && md.len() == 0 {
                cands.push((rel, "empty_file", "the note is empty"));
            }
        }
        cands.sort();
        for (rel, code, why) in cands.into_iter().take(rules.max_items_per_sweep) {
            match self.stage_note(scope, &rel, "garbage", code, why) {
                Ok(q) => out.push(q),
                Err(e) => eprintln!("[garbage] {}: {rel}: {e}", scope.id()),
            }
        }
        Ok(out)
    }
}

static GLOBAL: OnceLock<Quarantine> = OnceLock::new();

/// lib.rs setup: `<config>/staging/quarantine`.
pub fn init(config_dir: &Path) {
    let _ = GLOBAL.set(Quarantine::new(config_dir.join("staging").join("quarantine")));
}

pub fn global() -> Result<&'static Quarantine, String> {
    GLOBAL.get().ok_or_else(|| "the quarantine isn't initialised".into())
}

/// An explicit flag (the user, or Tony on their word): stage one note for review.
#[tauri::command]
pub fn quarantine_flag_note(business_id: String, rel: String, reason: Option<String>) -> Result<Value, String> {
    let store = super::business_registry::store()?;
    let scope = store.scope(&business_id)?;
    let q = global()?.stage_note(&scope, &rel, "user", "flagged", reason.as_deref().unwrap_or("flagged for review"))?;
    Ok(serde_json::to_value(q).unwrap_or(Value::Null))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::business_registry::tests::active_store;
    use super::*;

    pub(crate) fn q_in(dir: &Path) -> Quarantine {
        Quarantine::new(dir.join("staging").join("quarantine"))
    }

    #[test]
    fn garbage_stages_with_a_verified_snapshot_and_never_hard_deletes() {
        let (s, dir) = active_store("quar");
        let reg = s.snapshot();
        let q = q_in(&dir);
        let e = s.scope("supplements_ecom").unwrap();
        e.write_note(&reg, "inventory/old.md", "Whey isolate: 40 units").unwrap();
        let item = q.stage_note(&e, "inventory/old.md", "garbage", "flagged", "stale").unwrap();
        // Moved, not deleted: gone from the business, intact in quarantine.
        assert!(e.read_note("inventory/old.md").is_err());
        let snap = PathBuf::from(&item.backup_path);
        assert!(snap.starts_with(q.root()) && snap.is_file());
        assert_eq!(super::super::integrity::sha256_hex(&std::fs::read(&snap).unwrap()), item.sha256);
        assert_eq!((item.business_id.as_str(), item.source_agent.as_str(), item.status), ("supplements_ecom", "garbage", QStatus::Pending));
        let meta: QItem = serde_json::from_slice(&std::fs::read(snap.parent().unwrap().join(META)).unwrap()).unwrap();
        assert_eq!(meta, item);
        // No purge without approval: the snapshot survives.
        assert_eq!(q.purge(&item.item_id, false).unwrap_err(), "PERMISSION_REQUIRED:purge");
        assert!(snap.is_file());
        // Reject & Restore: byte-identical, in the same business.
        let r = q.restore(&item.item_id, &s).unwrap();
        assert_eq!(r.status, QStatus::Restored);
        assert_eq!(e.read_note("inventory/old.md").unwrap(), "Whey isolate: 40 units");
        assert!(q.restore(&item.item_id, &s).is_err(), "only once");
        // Approve Purge: the only hard delete, tombstone kept.
        let item2 = q.stage_note(&e, "inventory/old.md", "garbage", "flagged", "stale").unwrap();
        let p = q.purge(&item2.item_id, true).unwrap();
        assert_eq!(p.status, QStatus::Purged);
        assert!(!PathBuf::from(&item2.backup_path).exists());
        assert_eq!(q.get(&item2.item_id).unwrap().status, QStatus::Purged);
        assert!(q.restore(&item2.item_id, &s).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tampered_snapshot_is_never_restored() {
        let (s, dir) = active_store("quar-tamper");
        let reg = s.snapshot();
        let q = q_in(&dir);
        let t = s.scope("trades_contracting").unwrap();
        t.write_note(&reg, "a.md", "original").unwrap();
        let item = q.stage_note(&t, "a.md", "garbage", "flagged", "x").unwrap();
        std::fs::write(&item.backup_path, b"evil").unwrap();
        assert!(q.restore(&item.item_id, &s).unwrap_err().contains("checksum"));
        assert!(t.read_note("a.md").is_err());
        // Ids can't walk out of the quarantine.
        for bad in ["../x", "q-../../a", "Q-1", "q-1/..", ""] {
            assert!(q.get(bad).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blocked_writes_wait_for_the_user() {
        let (s, dir) = active_store("quar-block");
        let reg = s.snapshot();
        let q = q_in(&dir);
        let e = s.scope("supplements_ecom").unwrap();
        let text = "Pallet from Trades & Contracting yard";
        let hits = super::super::ops_scope::cross_domain_hits(&e, &reg, text);
        assert!(!hits.is_empty());
        let item = q.stage_blocked_write(&e, "notes/pallet.md", text, "security", &hits).unwrap();
        assert_eq!((item.kind, item.reason_code.as_str()), (Kind::BlockedWrite, "cross_domain"));
        assert!(item.reason.contains("trades_contracting"));
        assert!(e.list_notes().is_empty(), "nothing written yet");
        // The user releases it: written into Supplements (the business it was meant for) only.
        q.restore(&item.item_id, &s).unwrap();
        assert_eq!(e.read_note("notes/pallet.md").unwrap(), text);
        assert!(s.scope("trades_contracting").unwrap().list_notes().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sweep_stages_empty_and_stale_temp_files_only() {
        let (s, dir) = active_store("quar-sweep");
        let reg = s.snapshot();
        let q = q_in(&dir);
        let t = s.scope("trades_contracting").unwrap();
        t.write_note(&reg, "keep.md", "real note").unwrap();
        std::fs::write(t.memory_dir().join("empty.md"), b"").unwrap();
        std::fs::write(t.memory_dir().join(".tmp-abc.part"), b"half").unwrap();
        // A fresh temp file is left alone (the write may still be running).
        let now = super::super::arbiter::now_ms();
        let staged = q.sweep(&t, now).unwrap();
        assert_eq!(staged.iter().map(|i| i.reason_code.as_str()).collect::<Vec<_>>(), ["empty_file"]);
        let later = q.sweep(&t, now + 2 * 3_600_000).unwrap();
        assert_eq!(later.iter().map(|i| i.reason_code.as_str()).collect::<Vec<_>>(), ["temp_leftover"]);
        assert_eq!(t.list_notes(), ["keep.md"]);
        assert_eq!(q.pending().len(), 2);
        assert!(q.pending().iter().all(|i| PathBuf::from(&i.backup_path).is_file()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
