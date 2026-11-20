//! Tony's documenter.
//!
//! - Filesystem half: task notes under `memory.notesDir`, else `<gateway.workdir>/memory/tony`
//!   (gitignored). Same path rules as staging (`staging::safe_join`: no `..`, prefixes, ADS,
//!   device names or links), Markdown / text / JSON only, 256 KB per note, atomic writes. The
//!   note's path goes into the envelope's `raw_intent.memory_reference.memoryDoc`.
//! - AnythingLLM half (Part 4): [`ingest`] indexes a note in the Librarian's workspace through
//!   an `AllmWriter`. Tony ONLY (`RolePolicy.allm == Write`): the Librarian reads that workspace
//!   but never writes it. Best-effort: a failure returns `Err` AND publishes a `mirror_failed`
//!   bus event instead of being swallowed. Secrets are scrubbed before anything leaves.
//!   Collective-memory rule (tf-decisions addendum): envelopes are NOT embedded; callers ingest
//!   only Tony's own notes, never per-task copies.
#![cfg_attr(not(test), allow(dead_code))] // the worker's spec stage (Part 5) is the caller

use std::path::{Path, PathBuf};

use super::allm::{AllmConn, AllmWriter};
use super::dispatch::DispatchState;
use super::envelope::{clip, one_line};
use super::os_core::{OsConfig, OsState};
use super::roles::{AllmAccess, Role};
use super::staging;

pub const NOTE_MAX: usize = 256 * 1024;
pub const NOTE_EXTENSIONS: [&str; 3] = ["md", "txt", "json"];

/// `memory.notesDir`, else `<workdir>/memory/tony`; links / junctions refused like staging.
pub fn notes_root(cfg: &OsConfig, workdir: &Path) -> Result<PathBuf, String> {
    staging::configured_root(&cfg.memory.notes_dir, workdir, "memory/tony")
}

/// `ideas/<YYYY-MM-DD>-<slug>.md`.
pub fn idea_note_rel(date: &str, slug: &str) -> Result<String, String> {
    let ok_date = date.len() == 10 && date.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if !ok_date {
        return Err(format!("bad note date {date:?} (YYYY-MM-DD)"));
    }
    Ok(format!("ideas/{date}-{}.md", staging::validate_slug(slug)?))
}

/// Write (or replace) `root/rel` with `text`. Returns the absolute path written.
pub fn tony_document(root: &Path, rel: &str, text: &str) -> Result<PathBuf, String> {
    let ext = Path::new(rel).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !ext.is_some_and(|e| NOTE_EXTENSIONS.contains(&e.as_str())) {
        return Err(format!("notes must be {} files", NOTE_EXTENSIONS.join(", ")));
    }
    if text.len() > NOTE_MAX {
        return Err(format!("note is over {} KB", NOTE_MAX / 1024));
    }
    std::fs::create_dir_all(root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let target = staging::ensure_parent(root, rel)?;
    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
        return Err(format!("{rel} is a directory"));
    }
    staging::atomic_write(&target, text.as_bytes())?;
    if let Err(e) = staging::safe_join(root, rel) {
        let _ = std::fs::remove_file(&target);
        return Err(e);
    }
    Ok(target)
}

// ── AnythingLLM half ────────────────────────────────────────────────────────

pub const INGEST_MAX: usize = NOTE_MAX;
pub const INGEST_TITLE_MAX: usize = 120;
pub const INGEST_SOURCE: &str = "agentic-os";
/// The (templated) summary of the `mirror_failed` event a failed ingest publishes.
pub const INGEST_FAILED_SUMMARY: &str = "Couldn't index a note in the Librarian workspace. The note is still saved on disk.";

/// Checks before any AnythingLLM write (no network, no keychain): only a role whose policy
/// allows AnythingLLM writes (Tony), a title, non-empty text under the cap.
pub fn check_ingest(actor: Role, title: &str, text: &str) -> Result<(), String> {
    if actor.policy().allm != AllmAccess::Write {
        return Err(format!("PERMISSION_ROLE:{actor} may not write to AnythingLLM (only Tony's documenter indexes notes)"));
    }
    if title.trim().is_empty() {
        return Err("an indexed note needs a title".into());
    }
    if text.trim().is_empty() {
        return Err("nothing to index".into());
    }
    if text.len() > INGEST_MAX {
        return Err(format!("note is over {} KB", INGEST_MAX / 1024));
    }
    Ok(())
}

fn ingest_failed(e: &str) -> String {
    super::events::publish_note("tony", "mirror_failed", "verbose", INGEST_FAILED_SUMMARY, None);
    format!("Librarian index failed: {}", e.chars().take(200).collect::<String>())
}

/// `ingest` with the writer, workspace and known secrets already resolved.
pub(crate) async fn ingest_with(writer: &AllmWriter, workspace: &str, actor: Role, title: &str, text: &str, known: &[String]) -> Result<(), String> {
    check_ingest(actor, title, text)?;
    let title = clip(&super::devqueue::scrub(&one_line(title), known), INGEST_TITLE_MAX);
    let text = super::devqueue::scrub(text, known);
    writer.raw_text_ingest(&text, workspace, &title, INGEST_SOURCE, 60).await.map(|_| ()).map_err(|e| ingest_failed(&e))
}

/// Tony-only: index `text` (a note Tony already saved) in the Librarian's AnythingLLM workspace.
pub async fn ingest(state: &DispatchState, os: &OsState, actor: Role, title: &str, text: &str) -> Result<(), String> {
    check_ingest(actor, title, text)?;
    let cfg = os.snapshot();
    let Some(ws) = cfg.anythingllm.workspaces.get("librarian").filter(|s| !s.is_empty()).cloned() else {
        return Err(ingest_failed("no AnythingLLM workspace is mapped to the Librarian"));
    };
    let conn = AllmConn::local(state, &cfg).map_err(|e| ingest_failed(&e))?;
    let known = super::devqueue::known_secrets(state, os);
    ingest_with(&AllmWriter::for_documenter(conn), &ws, actor, title, text, &known).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("documenter-{tag}-{}-{}", std::process::id(), super::super::envelope::new_task_id(super::super::envelope::now_ms())));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn notes_stay_inside_notes_dir() {
        let wd = tmp("notes");
        let root = notes_root(&OsConfig::default(), &wd).unwrap();
        assert_eq!(root, wd.join("memory").join("tony"));
        let rel = idea_note_rel("2026-11-19", "status-card").unwrap();
        let p = tony_document(&root, &rel, "# Status card\n").unwrap();
        assert_eq!(p, root.join("ideas").join("2026-11-19-status-card.md"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# Status card\n");
        for bad in ["../escape.md", "..\\escape.md", "C:\\x.md", "ideas/nul.md", "a.md:ads", "x.exe", "ideas/"] {
            assert!(tony_document(&root, bad, "x").is_err(), "{bad:?}");
        }
        assert!(!wd.join("memory").join("escape.md").exists());
        assert!(tony_document(&root, "big.md", &"x".repeat(NOTE_MAX + 1)).is_err());
        assert!(idea_note_rel("19-11-2026", "a").is_err());
        assert!(idea_note_rel("2026-11-19", "Bad Slug").is_err());
        let mut cfg = OsConfig::default();
        cfg.memory.notes_dir = wd.join("custom").display().to_string();
        assert_eq!(notes_root(&cfg, &wd).unwrap(), wd.join("custom"));
        let _ = std::fs::remove_dir_all(&wd);
    }
    #[test]
    fn only_tony_ingests_and_secrets_are_scrubbed() {
        use super::super::allm::mock;
        for r in [Role::Librarian, Role::Coder, Role::Prompter, Role::Designer] {
            assert!(check_ingest(r, "t", "x").unwrap_err().starts_with("PERMISSION_ROLE:"), "{r}");
        }
        assert!(check_ingest(Role::Tony, " ", "x").is_err());
        assert!(check_ingest(Role::Tony, "t", " ").is_err());
        assert!(check_ingest(Role::Tony, "t", &"x".repeat(INGEST_MAX + 1)).is_err());
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let srv = mock::start(|_r: &mock::Req| mock::Resp::json(serde_json::json!({ "success": true }))).await;
            let w = AllmWriter::for_documenter(AllmConn::test(&srv.base));
            // A non-Tony actor never reaches the network.
            for r in [Role::Librarian, Role::Coder] {
                assert!(ingest_with(&w, "librarian", r, "Idea", "text", &[]).await.is_err());
            }
            assert!(srv.reqs().is_empty(), "no request for a refused actor");
            let known = vec!["MyKnownSecretValue42".to_string()];
            ingest_with(&w, "librarian", Role::Tony, "Idea: status card\nline two", "spec MyKnownSecretValue42 and sk-abcdefghijklmnopqrstuvwx", &known).await.unwrap();
            let reqs = srv.reqs();
            assert_eq!(reqs.len(), 1);
            assert_eq!(reqs[0].method, "POST");
            assert!(reqs[0].path.ends_with("/v1/document/raw-text"), "{}", reqs[0].path);
            let body = &reqs[0].body;
            assert_eq!(body["addToWorkspaces"], "librarian");
            assert_eq!(body["metadata"]["docSource"], INGEST_SOURCE);
            assert!(!body["metadata"]["title"].as_str().unwrap().contains('\n'));
            let text = body["textContent"].as_str().unwrap();
            assert!(!text.contains("MyKnownSecretValue42") && !text.contains("sk-abcdefghijklmnop"), "{text}");
            // A bad workspace slug is refused before any request.
            assert!(ingest_with(&w, "../x", Role::Tony, "t", "x", &[]).await.is_err());
            assert_eq!(srv.reqs().len(), 1);
        });
    }

    #[test]
    fn failed_ingest_is_an_error_not_a_bool() {
        use super::super::allm::mock;
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let srv = mock::start(|_r: &mock::Req| mock::Resp::status(500, serde_json::json!({ "error": "embedder offline" }))).await;
            let w = AllmWriter::for_documenter(AllmConn::test(&srv.base));
            let e = ingest_with(&w, "librarian", Role::Tony, "Idea", "text", &[]).await.unwrap_err();
            assert!(e.starts_with("Librarian index failed") && e.contains("embedder offline"), "{e}");
        });
    }
}
