//! Trash (section pass, "never lose a build"). Deleting a Staging Hub build or a Build Runners
//! row no longer erases anything: its folders (staging output, steer copies, the frozen promoted
//! widget) MOVE into `<app config dir>/trash/<id>/files/<n>/`, next to a `manifest.json` that
//! keeps the build card (or the runner's task id) and where every folder came from. Restore moves
//! them back; items older than `RETENTION_DAYS` are swept for good. Nothing here deletes data
//! that isn't already in the trash.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const TRASH_DIR: &str = "trash";
pub const MANIFEST: &str = "manifest.json";
pub const RETENTION_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// Where the folder lived (restored back there).
    pub from: String,
    /// Its folder under `files/` in this trash entry.
    pub stored: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    /// "build" (a Staging Hub card) | "runner" (a Build Runners task).
    pub kind: String,
    pub title: String,
    pub deleted_at: i64,
    pub expires_at: i64,
    /// The removed hub `Build` (kind "build"), put back on restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<Value>,
    /// The dismissed worker task (kind "runner"), un-dismissed on restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub items: Vec<TrashItem>,
}

pub fn trash_root(config_dir: &Path) -> PathBuf {
    config_dir.join(TRASH_DIR)
}

/// A trash id: `t-<ms>-<source id>` (letters, digits, `-` only, ≤ 96). Pure.
pub fn trash_id(source: &str, now: i64) -> String {
    let src: String = source.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    format!("t-{now}-{src}")
}

pub fn valid_trash_id(id: &str) -> bool {
    (3..=96).contains(&id.len()) && id.starts_with("t-") && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Copy a folder tree (a move across volumes: staging on G:, the config dir on C:). A symlink or
/// junction is skipped, never followed: the source's `remove_dir_all` removes only the link, so
/// its target is untouched (the trashed copy just doesn't carry the link).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        let ft = e.file_type()?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            copy_tree(&e.path(), &t)?;
        } else {
            std::fs::copy(e.path(), &t)?;
        }
    }
    Ok(())
}

/// Copy back into `to` every file of `from` that `to` no longer has (a locked file that survived
/// is never overwritten): undoes a half-finished source removal.
fn fill_missing(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            fill_missing(&e.path(), &t)?;
        } else if !t.exists() {
            std::fs::copy(e.path(), &t)?;
        }
    }
    Ok(())
}

/// Move `from` to `to` (which must not exist): a rename on the same volume, else copy then
/// remove the source. Never leaves the data half-moved: when the source can't be fully removed
/// (a file held open), whatever was removed is copied back from the copy, the copy is dropped,
/// and the call fails with the source intact.
pub fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(e) = copy_tree(from, to) {
        let _ = std::fs::remove_dir_all(to);
        return Err(format!("couldn't copy {} ({e})", from.display()));
    }
    // Windows: a preview server or Explorer may hold a handle for a moment.
    let mut last = String::new();
    for _ in 0..5 {
        match std::fs::remove_dir_all(from) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
    }
    // Put the source back together before giving up; only then drop the copy.
    if let Err(e) = fill_missing(to, from) {
        return Err(format!("couldn't remove {} ({last}) nor rebuild it ({e}); the full copy is kept at {}", from.display(), to.display()));
    }
    let _ = std::fs::remove_dir_all(to);
    Err(format!("couldn't remove {} ({last}); left in place", from.display()))
}

fn write_manifest(dir: &Path, e: &TrashEntry) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(e).map_err(|x| x.to_string())?;
    super::buildhub::atomic_write(&dir.join(MANIFEST), &text)
}

/// Put `dirs` (those that exist) into a new trash entry. The manifest (with the card) is written
/// BEFORE anything moves and again after each move, so a moved folder is always listed and
/// restorable. Returns the entry (even with no folders: the card is still recoverable) and the
/// folders that could not be moved (left in place, never deleted).
pub fn put(config_dir: &Path, kind: &str, title: &str, source_id: &str, build: Option<Value>, task_id: Option<String>, dirs: &[PathBuf], now: i64) -> Result<(TrashEntry, Vec<String>), String> {
    let id = trash_id(source_id, now);
    let dir = trash_root(config_dir).join(&id);
    std::fs::create_dir_all(dir.join("files")).map_err(|e| format!("couldn't create the trash ({e})"))?;
    let mut entry = TrashEntry { id, kind: kind.into(), title: title.chars().take(200).collect(), deleted_at: now, expires_at: now + RETENTION_DAYS * DAY_MS, build, task_id, items: vec![] };
    if let Err(e) = write_manifest(&dir, &entry) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("couldn't write the trash entry ({e}); nothing was moved"));
    }
    let mut left = Vec::new();
    for (i, d) in dirs.iter().filter(|d| d.exists()).enumerate() {
        let stored = format!("{i}");
        match move_dir(d, &dir.join("files").join(&stored)) {
            Ok(()) => {
                entry.items.push(TrashItem { from: d.display().to_string(), stored });
                if let Err(e) = write_manifest(&dir, &entry) {
                    eprintln!("[trash] manifest update failed ({e}); rewriting on the next move");
                }
            }
            Err(e) => {
                eprintln!("[trash] {}: {e}", d.display());
                left.push(d.display().to_string());
            }
        }
    }
    write_manifest(&dir, &entry)?;
    Ok((entry, left))
}

/// Every trash entry, newest first (an unreadable manifest is skipped).
pub fn list(config_dir: &Path) -> Vec<TrashEntry> {
    let Ok(rd) = std::fs::read_dir(trash_root(config_dir)) else { return vec![] };
    let mut v: Vec<TrashEntry> = rd.flatten().filter_map(|e| std::fs::read(e.path().join(MANIFEST)).ok()).filter_map(|b| serde_json::from_slice(&b).ok()).collect();
    v.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    v
}

pub fn get(config_dir: &Path, id: &str) -> Result<TrashEntry, String> {
    if !valid_trash_id(id) {
        return Err("bad trash id".into());
    }
    let b = std::fs::read(trash_root(config_dir).join(id).join(MANIFEST)).map_err(|_| format!("{id} is not in the trash"))?;
    serde_json::from_slice(&b).map_err(|e| e.to_string())
}

/// Move the entry's folders back where they came from. Resumable: an item already moved back is
/// dropped from the manifest as it goes, so a restore that failed part way picks up where it
/// stopped. Refuses (moving nothing) while a pending destination is occupied again. The entry
/// itself stays until the caller has the card back (`drop_entry`). Returns the entry as it was.
pub fn restore_files(config_dir: &Path, id: &str) -> Result<TrashEntry, String> {
    let e = get(config_dir, id)?;
    let dir = trash_root(config_dir).join(id);
    let files = dir.join("files");
    let pending: Vec<TrashItem> = e.items.iter().filter(|i| files.join(&i.stored).exists()).cloned().collect();
    if let Some(busy) = pending.iter().find(|i| Path::new(&i.from).exists()) {
        return Err(format!("{} exists again — move it away first", busy.from));
    }
    let mut now = TrashEntry { items: pending.clone(), ..e.clone() };
    for i in &pending {
        move_dir(&files.join(&i.stored), Path::new(&i.from))?;
        now.items.retain(|x| x.stored != i.stored);
        let _ = write_manifest(&dir, &now);
    }
    Ok(e)
}

/// Remove a restored entry (only a folder inside the trash).
pub fn drop_entry(config_dir: &Path, id: &str) {
    if valid_trash_id(id) {
        let _ = std::fs::remove_dir_all(trash_root(config_dir).join(id));
    }
}

/// Delete one entry for good (only ever a folder inside the trash).
pub fn purge(config_dir: &Path, id: &str) -> Result<(), String> {
    get(config_dir, id)?;
    std::fs::remove_dir_all(trash_root(config_dir).join(id)).map_err(|e| e.to_string())
}

/// Entries past `expires_at`. Pure.
pub fn expired(entries: &[TrashEntry], now: i64) -> Vec<String> {
    entries.iter().filter(|e| e.expires_at <= now).map(|e| e.id.clone()).collect()
}

/// Delete expired entries; returns how many went.
pub fn sweep(config_dir: &Path, now: i64) -> usize {
    expired(&list(config_dir), now).iter().filter(|id| purge(config_dir, id).is_ok()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-trash-{name}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn delete_moves_and_restore_brings_back() {
        let root = tmp("roundtrip");
        let cfg = root.join("config");
        let out = root.join("staging").join("clock");
        std::fs::create_dir_all(out.join("assets")).unwrap();
        std::fs::write(out.join("index.html"), "<html>clock</html>").unwrap();
        std::fs::write(out.join("assets").join("a.png"), [1u8, 2, 3]).unwrap();
        let missing = root.join("never-existed");
        let (e, left) = put(&cfg, "build", "E46 clock", "b-abc", Some(serde_json::json!({"x":1})), None, &[out.clone(), missing], 1_000).unwrap();
        assert!(left.is_empty());
        assert!(!out.exists(), "moved, not copied");
        assert_eq!(e.items.len(), 1);
        assert_eq!(e.expires_at, 1_000 + 30 * DAY_MS);
        assert_eq!(list(&cfg).len(), 1);
        let back = restore_files(&cfg, &e.id).unwrap();
        assert_eq!(back.build, Some(serde_json::json!({"x":1})));
        assert_eq!(std::fs::read_to_string(out.join("index.html")).unwrap(), "<html>clock</html>");
        assert_eq!(std::fs::read(out.join("assets").join("a.png")).unwrap(), [1, 2, 3]);
        // The entry stays until the caller has the card back; a second restore is a no-op.
        assert_eq!(list(&cfg).len(), 1);
        assert!(restore_files(&cfg, &e.id).is_ok());
        drop_entry(&cfg, &e.id);
        assert!(list(&cfg).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_refuses_an_occupied_destination() {
        let root = tmp("occupied");
        let cfg = root.join("config");
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let (e, _) = put(&cfg, "runner", "x", "t1", None, Some("t1".into()), &[out.clone()], 5).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        assert!(restore_files(&cfg, &e.id).unwrap_err().contains("exists again"));
        assert_eq!(list(&cfg).len(), 1, "nothing lost");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_restore_that_stopped_part_way_resumes() {
        let root = tmp("resume");
        let cfg = root.join("config");
        let (a, b) = (root.join("a"), root.join("b"));
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("f"), "x").unwrap();
        }
        let (e, _) = put(&cfg, "build", "two", "b-two", None, None, &[a.clone(), b.clone()], 1).unwrap();
        // A restore that stopped after the first folder went back (no manifest update).
        let files = trash_root(&cfg).join(&e.id).join("files");
        move_dir(&files.join("0"), &a).unwrap();
        // The already-restored folder must not block the retry.
        restore_files(&cfg, &e.id).unwrap();
        assert!(a.join("f").is_file() && b.join("f").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fill_missing_rebuilds_a_half_removed_source_without_overwriting() {
        let root = tmp("fill");
        let (src, copy) = (root.join("src"), root.join("copy"));
        std::fs::create_dir_all(src.join("d")).unwrap();
        std::fs::write(src.join("keep"), "locked-and-newer").unwrap();
        std::fs::create_dir_all(copy.join("d")).unwrap();
        std::fs::write(copy.join("keep"), "old").unwrap();
        std::fs::write(copy.join("gone"), "g").unwrap();
        std::fs::write(copy.join("d").join("deep"), "d").unwrap();
        fill_missing(&copy, &src).unwrap();
        assert_eq!(std::fs::read_to_string(src.join("keep")).unwrap(), "locked-and-newer");
        assert_eq!(std::fs::read_to_string(src.join("gone")).unwrap(), "g");
        assert_eq!(std::fs::read_to_string(src.join("d").join("deep")).unwrap(), "d");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_expired_entries_are_swept_and_ids_are_checked() {
        let root = tmp("sweep");
        let cfg = root.join("config");
        put(&cfg, "build", "old", "b-old", None, None, &[], 0).unwrap();
        put(&cfg, "build", "new", "b-new", None, None, &[], 20 * DAY_MS).unwrap();
        assert_eq!(sweep(&cfg, 31 * DAY_MS), 1);
        assert_eq!(list(&cfg).iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), ["new"]);
        assert!(purge(&cfg, "../../etc").is_err());
        assert!(!valid_trash_id("t-1/..") && valid_trash_id(&trash_id("b-x", 9)));
        let _ = std::fs::remove_dir_all(&root);
    }
}
