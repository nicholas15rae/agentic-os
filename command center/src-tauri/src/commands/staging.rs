//! Staging: the only place pipeline output is written, `<staging root>/<slug>/…`.
//!
//! - Root: `memory.stagingDir` in os.json, else `<gateway.workdir>/staging` (gitignored).
//!   A root that is (or sits under) a reparse point / symlink is refused.
//! - `resolve` refuses absolute paths, drive / UNC / `\\?\` prefixes, `..`, `:` (ADS and
//!   drive-relative), NUL and other forbidden characters, Windows device names in any
//!   component, trailing dots / spaces and over-long paths; it then walks every existing
//!   component refusing reparse points and checks the canonical result stays inside the root.
//! - `write_artifact` is the single write path: Coder only, behind the Permission Bridge
//!   (`staging-write`, Write scope, pre-consented, so a `deny` tier still wins), extension
//!   allowlist, 2 MB per file / 20 MB per slug, `create_new` temp file + rename (never writes
//!   through an existing hardlink), then re-verifies the final path.
#![cfg_attr(not(test), allow(dead_code))] // the Coder stage (Part 5) is the caller

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

use super::bridge::{Actor, BridgeState, Scope};
use super::os_core::OsConfig;
use super::roles::Role;

pub const FILE_MAX: u64 = 2 * 1024 * 1024;
pub const SLUG_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const REL_MAX: usize = 200;
pub const SLUG_MAX_LEN: usize = 48;
pub const EXTENSIONS: [&str; 8] = ["html", "css", "js", "json", "md", "svg", "png", "txt"];
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn reserved(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name).trim_end_matches([' ', '.']).to_ascii_lowercase();
    RESERVED.contains(&base.as_str()) || base == "conin$" || base == "conout$"
}

// ── Slugs ───────────────────────────────────────────────────────────────────

/// `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`, and not a device name.
pub fn validate_slug(s: &str) -> Result<String, String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$").unwrap());
    if !re.is_match(s) || reserved(s) {
        return Err(format!("invalid project slug {:?}: 1–{SLUG_MAX_LEN} of a-z 0-9 and inner dashes, not a device name", clip_dbg(s)));
    }
    Ok(s.to_string())
}

fn clip_dbg(s: &str) -> String {
    s.chars().take(60).collect()
}

fn slugify(title: &str) -> String {
    let mut out: String = title.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').to_string()
}

fn cut(base: &str, max: usize) -> String {
    base.chars().take(max).collect::<String>().trim_end_matches('-').to_string()
}

/// A valid, unused slug for `title`: `taken` says whether a candidate already exists;
/// duplicates get `-2`, `-3`, …
pub fn slug_for(title: &str, taken: impl Fn(&str) -> bool) -> String {
    let mut base = cut(&slugify(title), SLUG_MAX_LEN);
    if validate_slug(&base).is_err() {
        base = if base.is_empty() { "task".into() } else { format!("{base}-app") };
        base = cut(&base, SLUG_MAX_LEN);
        if validate_slug(&base).is_err() {
            base = "task".into();
        }
    }
    if !taken(&base) {
        return base;
    }
    for n in 2..10_000u32 {
        let suffix = format!("-{n}");
        let cand = format!("{}{suffix}", cut(&base, SLUG_MAX_LEN - suffix.len()));
        if validate_slug(&cand).is_ok() && !taken(&cand) {
            return cand;
        }
    }
    format!("task-{}", super::envelope::now_ms())
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// A symlink, junction or other reparse point (Windows), or a symlink elsewhere.
pub fn is_reparse(p: &Path) -> bool {
    let Ok(md) = std::fs::symlink_metadata(p) else { return false };
    if md.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// `memory.stagingDir`, else `<workdir>/staging`. The root and its ancestors up to the
/// repo (or, for a root outside the repo, the root itself) must not be reparse points.
pub fn staging_root(cfg: &OsConfig, workdir: &Path) -> Result<PathBuf, String> {
    configured_root(&cfg.memory.staging_dir, workdir, "staging")
}

pub(crate) fn configured_root(configured: &str, workdir: &Path, default_rel: &str) -> Result<PathBuf, String> {
    let c = configured.trim();
    let root = if c.is_empty() { default_rel.split('/').fold(workdir.to_path_buf(), |p, s| p.join(s)) } else { PathBuf::from(c) };
    if !root.is_absolute() {
        return Err(format!("{} must be an absolute path", root.display()));
    }
    check_root(&root, workdir)?;
    Ok(root)
}

fn check_root(root: &Path, workdir: &Path) -> Result<(), String> {
    let mut p = Some(root);
    while let Some(cur) = p {
        if is_reparse(cur) {
            return Err(format!("refusing {}: {} is a link / junction", root.display(), cur.display()));
        }
        if cur == workdir || !root.starts_with(workdir) {
            break;
        }
        p = cur.parent();
    }
    Ok(())
}

/// Validate a relative path (`/` or `\` separated) component by component.
pub fn check_rel(rel: &str) -> Result<Vec<String>, String> {
    let bad = |why: &str| Err(format!("invalid path {:?}: {why}", clip_dbg(rel)));
    if rel.is_empty() {
        return bad("empty");
    }
    if rel.chars().count() > REL_MAX {
        return bad("too long");
    }
    if rel.contains('\0') || rel.chars().any(|c| c.is_control()) {
        return bad("control character");
    }
    if rel.contains(':') {
        return bad("':' (drive or alternate data stream)");
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return bad("absolute / UNC");
    }
    if rel.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
        return bad("forbidden character");
    }
    let mut out = Vec::new();
    for part in rel.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return bad("empty, '.' or '..' component");
        }
        if part.ends_with('.') || part.ends_with(' ') || part.starts_with(' ') {
            return bad("component ends with '.' or space");
        }
        if reserved(part) {
            return bad("reserved device name");
        }
        out.push(part.to_string());
    }
    // Belt and braces: std's own parse must agree it's a plain relative path.
    let joined: PathBuf = out.iter().collect();
    if joined.components().any(|c| !matches!(c, Component::Normal(_))) {
        return bad("not a plain relative path");
    }
    Ok(out)
}

/// `root/<parts…>` after `check_rel`, refusing reparse points on every existing component
/// and any canonical escape from `root`.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = check_rel(rel)?;
    if is_reparse(root) {
        return Err(format!("refusing {}: the root is a link / junction", root.display()));
    }
    let mut p = root.to_path_buf();
    for part in &parts {
        p.push(part);
        if is_reparse(&p) {
            return Err(format!("refusing {}: a link / junction is in the way", p.display()));
        }
    }
    verify_inside(root, &p)?;
    Ok(p)
}

/// The deepest existing ancestor of `p` must canonicalize inside the canonical `root`.
fn verify_inside(root: &Path, p: &Path) -> Result<(), String> {
    let Ok(croot) = std::fs::canonicalize(root) else { return Ok(()) }; // root not created yet: nothing to escape through
    let mut probe = Some(p);
    while let Some(cur) = probe {
        if cur.exists() {
            let c = std::fs::canonicalize(cur).map_err(|e| format!("{}: {e}", cur.display()))?;
            if !c.starts_with(&croot) {
                return Err(format!("refusing {}: it resolves outside {}", p.display(), root.display()));
            }
            return Ok(());
        }
        probe = cur.parent();
    }
    Ok(())
}

/// `root/<slug>/<rel>`.
pub fn resolve(root: &Path, slug: &str, rel: &str) -> Result<PathBuf, String> {
    let slug = validate_slug(slug)?;
    safe_join(root, &format!("{slug}/{rel}"))
}

fn dir_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            match std::fs::symlink_metadata(&p) {
                Ok(md) if md.is_dir() && !is_reparse(&p) => dir_bytes(&p),
                Ok(md) if md.is_file() => md.len(),
                _ => 0,
            }
        })
        .sum()
}

/// Atomic write: `create_new` temp beside the target, then rename over it (replaces the
/// directory entry, so an existing hardlink's other names keep their content).
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = target.parent().ok_or("no parent directory")?;
    let tmp = dir.join(format!(".tmp-{}.part", super::envelope::new_task_id(super::envelope::now_ms())));
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, target)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", target.display()));
    }
    Ok(())
}

/// Create `root/rel`'s parent directories, refusing any link / junction on the way.
pub(crate) fn ensure_parent(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let target = safe_join(root, rel)?;
    std::fs::create_dir_all(target.parent().ok_or("no parent directory")?).map_err(|e| format!("create {}: {e}", root.display()))?;
    // Re-check after creating: nothing may have been swapped in meanwhile.
    safe_join(root, rel)
}

/// What the Coder wrote: recorded in `code_artifacts`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Artifact {
    pub path: String,
    pub rel: String,
    pub sha256: String,
    pub bytes: u64,
}

fn check_ext(rel: &str) -> Result<(), String> {
    let ext = Path::new(rel).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext {
        Some(e) if EXTENSIONS.contains(&e.as_str()) => Ok(()),
        _ => Err(format!("{:?}: only {} files may be staged", clip_dbg(rel), EXTENSIONS.join(", "))),
    }
}

fn gate(bridge: &BridgeState, role: Role, slug: &str, rel: &str, bytes: usize) -> Result<(), String> {
    if !role.may_write_staging() {
        return Err(format!("PERMISSION_ROLE:{role} may not write to staging"));
    }
    bridge.check("staging-write", &[Scope::Write], false, Actor::Scheduler, true, serde_json::json!({ "role": role.as_str(), "slug": slug, "rel": rel, "bytes": bytes }))
}

/// The Coder's only write path: `root/<slug>/<rel>`.
pub fn write_artifact(bridge: &BridgeState, role: Role, root: &Path, slug: &str, rel: &str, bytes: &[u8]) -> Result<Artifact, String> {
    let slug = validate_slug(slug)?;
    check_rel(rel)?;
    check_ext(rel)?;
    gate(bridge, role, &slug, rel, bytes.len())?;
    if bytes.len() as u64 > FILE_MAX {
        return Err(format!("{rel}: {} bytes is over the {} MB per-file cap", bytes.len(), FILE_MAX / (1024 * 1024)));
    }
    std::fs::create_dir_all(root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let full_rel = format!("{slug}/{rel}");
    let target = ensure_parent(root, &full_rel)?;
    let existing = std::fs::symlink_metadata(&target).ok().filter(|m| m.is_file()).map(|m| m.len()).unwrap_or(0);
    let used = dir_bytes(&root.join(&slug));
    if used.saturating_sub(existing) + bytes.len() as u64 > SLUG_MAX_BYTES {
        return Err(format!("{slug}: staging is capped at {} MB per project", SLUG_MAX_BYTES / (1024 * 1024)));
    }
    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
        return Err(format!("{full_rel} is a directory"));
    }
    atomic_write(&target, bytes)?;
    // Re-verify the written path: still no link anywhere, still inside the root.
    if let Err(e) = safe_join(root, &full_rel).and_then(|p| if is_reparse(&p) { Err("the written file is a link".to_string()) } else { Ok(p) }) {
        let _ = std::fs::remove_file(&target);
        return Err(e);
    }
    Ok(Artifact { path: target.display().to_string(), rel: rel.replace('\\', "/"), sha256: hex(&Sha256::digest(bytes)), bytes: bytes.len() as u64 })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::bridge::{BridgePolicy, Tier};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("staging-{tag}-{}-{}", std::process::id(), super::super::envelope::new_task_id(super::super::envelope::now_ms())));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn allow() -> BridgeState {
        BridgeState::with_policy(BridgePolicy { read: Tier::Allow, write: Tier::Ask, execute: Tier::Ask, network: Tier::Allow })
    }

    #[test]
    fn slug_table() {
        for ok in ["audition-tracker", "a1", "a", "status-card", &"a".repeat(48)] {
            assert!(validate_slug(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-a", "a-", "A", "a_b", "a.b", "con", "nul", "com1", "lpt9", &"a".repeat(49), "..", "a/b", "a b"] {
            assert!(validate_slug(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn slug_for_dedupes_and_stays_valid() {
        assert_eq!(slug_for("Audition Tracker!", |_| false), "audition-tracker");
        assert_eq!(slug_for("Audition Tracker", |s| s == "audition-tracker"), "audition-tracker-2");
        assert_eq!(slug_for("Audition Tracker", |s| s == "audition-tracker" || s == "audition-tracker-2"), "audition-tracker-3");
        assert_eq!(slug_for("!!!", |_| false), "task");
        assert_eq!(slug_for("CON", |_| false), "con-app");
        let long = slug_for(&"word ".repeat(30), |s| !s.ends_with("-2"));
        assert!(validate_slug(&long).is_ok() && long.ends_with("-2") && long.len() <= SLUG_MAX_LEN, "{long}");
    }

    #[test]
    fn rel_path_rejections() {
        for bad in [
            "../x", "a/../x", "C:x", "C:\\x", "\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x", "a.html:evil", "nul.txt", "NUL", "x. ", "x.", " x", "a\0b", "/abs", "\\abs", "a//b", "./a", "a*b", "a?b", &"a".repeat(201), "",
        ] {
            assert!(check_rel(bad).is_err(), "{bad:?} should be rejected");
        }
        for ok in ["index.html", "assets/app.js", ".iterations/1.html", ".status.json", "a\\b.css"] {
            assert!(check_rel(ok).is_ok(), "{ok:?}");
        }
        let root = tmp("rel");
        assert!(resolve(&root, "a1", "../escape.html").is_err());
        assert!(resolve(&root, "A1", "index.html").is_err());
        assert_eq!(resolve(&root, "a1", "x/index.html").unwrap(), root.join("a1").join("x").join("index.html"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn coder_writes_atomically_with_caps() {
        let root = tmp("write");
        let b = allow();
        let a = write_artifact(&b, Role::Coder, &root, "status-card", "index.html", b"<!doctype html><p>hi</p>").unwrap();
        assert_eq!(std::fs::read(root.join("status-card").join("index.html")).unwrap(), b"<!doctype html><p>hi</p>");
        assert_eq!((a.bytes, a.sha256.len(), a.rel.as_str()), (24, 64, "index.html"));
        write_artifact(&b, Role::Coder, &root, "status-card", ".iterations/1.html", b"old").unwrap();
        // Overwrite replaces content; no temp files linger.
        write_artifact(&b, Role::Coder, &root, "status-card", "index.html", b"v2").unwrap();
        assert_eq!(std::fs::read(root.join("status-card").join("index.html")).unwrap(), b"v2");
        let leftovers: Vec<_> = std::fs::read_dir(root.join("status-card")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-")).collect();
        assert!(leftovers.is_empty());
        assert!(write_artifact(&b, Role::Coder, &root, "status-card", "run.exe", b"x").unwrap_err().contains("only html"));
        assert!(write_artifact(&b, Role::Coder, &root, "status-card", "noext", b"x").is_err());
        assert!(write_artifact(&b, Role::Coder, &root, "status-card", "big.txt", &vec![b'x'; (FILE_MAX + 1) as usize]).unwrap_err().contains("per-file cap"));
        // Per-slug cap: 10 × 2 MB fills it, the 11th is refused.
        let chunk = vec![b'y'; FILE_MAX as usize];
        let mut refused = false;
        for i in 0..11 {
            if let Err(e) = write_artifact(&b, Role::Coder, &root, "fill", &format!("f{i}.txt"), &chunk) {
                assert!(e.contains("per project"), "{e}");
                refused = true;
                break;
            }
        }
        assert!(refused);
        // Rewriting an existing file of the same size still fits (its old bytes don't count twice).
        assert!(write_artifact(&b, Role::Coder, &root, "fill", "f0.txt", &chunk).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn roles_and_tiers_gate_writes() {
        let root = tmp("perm");
        for r in [Role::Tony, Role::Prompter, Role::Librarian, Role::Designer] {
            let e = write_artifact(&allow(), r, &root, "x1", "index.html", b"x").unwrap_err();
            assert!(e.starts_with("PERMISSION_ROLE:"), "{e}");
        }
        let deny = BridgeState::with_policy(BridgePolicy { read: Tier::Allow, write: Tier::Deny, execute: Tier::Ask, network: Tier::Allow });
        assert_eq!(write_artifact(&deny, Role::Coder, &root, "x1", "index.html", b"x").unwrap_err(), "PERMISSION_DENIED:write");
        assert!(!root.join("x1").exists(), "nothing written when refused");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hardlink_is_not_written_through() {
        let root = tmp("hard");
        let outside = tmp("hard-outside");
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, b"original").unwrap();
        std::fs::create_dir_all(root.join("h1")).unwrap();
        let link = root.join("h1").join("index.html");
        if std::fs::hard_link(&victim, &link).is_err() {
            eprintln!("hardlink unsupported here; skipped");
            return;
        }
        write_artifact(&allow(), Role::Coder, &root, "h1", "index.html", b"replaced").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"original");
        assert_eq!(std::fs::read(&link).unwrap(), b"replaced");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn junction_escape_is_refused() {
        let root = tmp("junction");
        let outside = tmp("junction-outside");
        let j = root.join("j1");
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&j).arg(&outside).output().map(|o| o.status.success()).unwrap_or(false);
        if !ok || !j.exists() {
            eprintln!("mklink /J unavailable; skipped");
            return;
        }
        assert!(is_reparse(&j));
        let e = write_artifact(&allow(), Role::Coder, &root, "j1", "index.html", b"x").unwrap_err();
        assert!(e.contains("link / junction"), "{e}");
        assert!(!outside.join("index.html").exists());
        // A root that is itself a junction is refused too.
        assert!(check_root(&j, &root).is_err());
        assert!(configured_root(&j.display().to_string(), &root, "staging").is_err());
        let _ = std::fs::remove_dir(&j); // removes the junction, not the target
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn root_defaults_and_overrides() {
        let wd = tmp("root");
        let mut cfg = OsConfig::default();
        assert_eq!(staging_root(&cfg, &wd).unwrap(), wd.join("staging"));
        cfg.memory.staging_dir = wd.join("elsewhere").display().to_string();
        assert_eq!(staging_root(&cfg, &wd).unwrap(), wd.join("elsewhere"));
        cfg.memory.staging_dir = "relative/dir".into();
        assert!(staging_root(&cfg, &wd).is_err());
        let _ = std::fs::remove_dir_all(&wd);
    }
}
