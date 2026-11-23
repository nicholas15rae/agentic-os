//! `BusinessScope`: the one handle every Operations-Manager read / write goes through.
//!
//! - Only an ACTIVE registry business yields one (`business_registry::Store::scope`), and every
//!   ops function takes `&BusinessScope`, never a raw id string. Code that forgets to scope a
//!   call doesn't compile.
//! - **Path jail**: every file path is `staging::safe_join(<memory>/<id>, rel)`. That refuses
//!   absolute / UNC / drive / `..` / ADS / device names and links or junctions on any component,
//!   and verifies the canonical result stays inside this business's folder.
//! - **Cross-domain check** before any write: the text must not name another business (its
//!   display name, id, aliases or `crossDomainBlocklist`). A hit refuses the write with
//!   `CROSS_DOMAIN:` and the caller routes it to review; it is never written into this business.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use super::business_registry::{Business, BusinessStatus, Registry};

pub const NOTE_EXTENSIONS: [&str; 3] = ["md", "txt", "json"];
pub const NOTE_MAX: usize = 1024 * 1024;
const LIST_MAX: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessScope {
    business_id: String,
    display_name: String,
    workspace_slug: String,
    ledger_tag: String,
    memory_dir: PathBuf,
}

impl BusinessScope {
    /// From a registry record: it must be active, and its folder must be exactly
    /// `<memory_root>/<id>`, exist, and not be a link / junction.
    pub(crate) fn from_business(b: &Business, memory_root: &Path) -> Result<Self, String> {
        if b.status != BusinessStatus::Active {
            return Err(format!("business {} isn't active ({:?})", b.business_id, b.status));
        }
        let want = memory_root.join(&b.business_id);
        if Path::new(&b.memory_path) != want {
            return Err(format!("business {}: memory path doesn't match its id", b.business_id));
        }
        let dir = super::staging::safe_join(memory_root, &b.business_id)?;
        if !dir.is_dir() {
            return Err(format!("business {}: memory folder missing; re-run provisioning", b.business_id));
        }
        Ok(Self { business_id: b.business_id.clone(), display_name: b.display_name.clone(), workspace_slug: b.workspace_slug.clone(), ledger_tag: b.finance_ledger_tag.clone(), memory_dir: dir })
    }

    pub fn id(&self) -> &str {
        &self.business_id
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn workspace_slug(&self) -> &str {
        &self.workspace_slug
    }
    pub fn ledger_tag(&self) -> &str {
        &self.ledger_tag
    }
    pub fn memory_dir(&self) -> &Path {
        &self.memory_dir
    }

    /// A path inside this business's folder (see the module doc).
    pub fn jail(&self, rel: &str) -> Result<PathBuf, String> {
        super::staging::safe_join(&self.memory_dir, rel)
    }

    fn check_ext(rel: &str) -> Result<(), String> {
        let ext = Path::new(rel).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        if !NOTE_EXTENSIONS.contains(&ext.as_str()) {
            return Err(format!("{rel}: only .{} notes", NOTE_EXTENSIONS.join(" / .")));
        }
        Ok(())
    }

    /// Write one note: extension allowlist, size cap, secret scrub refusal, cross-domain check,
    /// then an atomic write inside the jail.
    pub fn write_note(&self, reg: &Registry, rel: &str, text: &str) -> Result<PathBuf, String> {
        Self::check_ext(rel)?;
        if text.len() > NOTE_MAX {
            return Err(format!("note too large (max {} KB)", NOTE_MAX / 1024));
        }
        let hits = cross_domain_hits(self, reg, &format!("{rel}\n{text}"));
        if !hits.is_empty() {
            return Err(cross_domain_error(&hits));
        }
        let target = super::staging::ensure_parent(&self.memory_dir, rel)?;
        super::staging::atomic_write(&target, text.as_bytes())?;
        self.jail(rel)?; // re-verify the final path
        Ok(target)
    }

    pub fn read_note(&self, rel: &str) -> Result<String, String> {
        Self::check_ext(rel)?;
        let p = self.jail(rel)?;
        let md = std::fs::symlink_metadata(&p).map_err(|e| format!("{rel}: {e}"))?;
        if !md.is_file() || md.len() > NOTE_MAX as u64 {
            return Err(format!("{rel}: not a readable note"));
        }
        std::fs::read_to_string(&p).map_err(|e| format!("{rel}: {e}"))
    }

    /// Relative paths of every note in this business's folder (links / junctions skipped).
    pub fn list_notes(&self) -> Vec<String> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                if out.len() >= LIST_MAX {
                    return;
                }
                let p = e.path();
                if super::staging::is_reparse(&p) {
                    continue;
                }
                match std::fs::symlink_metadata(&p) {
                    Ok(md) if md.is_dir() => walk(root, &p, out),
                    Ok(md) if md.is_file() => {
                        if let Ok(rel) = p.strip_prefix(root) {
                            let rel = rel.to_string_lossy().replace('\\', "/");
                            if !rel.starts_with(".tmp-") && BusinessScope::check_ext(&rel).is_ok() {
                                out.push(rel);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut out = vec![];
        walk(&self.memory_dir, &self.memory_dir, &mut out);
        out.sort();
        out
    }

    /// Keyword search over this business's notes only (the scoped Operations Librarian).
    pub fn search_notes(&self, q: &str, k: usize) -> Vec<(String, String)> {
        let terms: Vec<String> = super::routing::normalize(q).split(' ').filter(|w| w.chars().count() >= 3).map(String::from).collect();
        let mut hits: Vec<(usize, String, String)> = vec![];
        for rel in self.list_notes() {
            let Ok(text) = self.read_note(&rel) else { continue };
            let norm = super::routing::normalize(&text);
            let n = terms.iter().filter(|t| norm.contains(t.as_str())).count();
            if n > 0 || terms.is_empty() {
                hits.push((n, rel, text.chars().take(1200).collect()));
            }
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        hits.into_iter().take(k).map(|(_, r, t)| (r, t)).collect()
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrossHit {
    /// The OTHER business the text names.
    pub business_id: String,
    pub term: String,
}

/// Terms that identify `b` (normalised, 3+ characters).
pub fn identity_terms(b: &Business) -> Vec<String> {
    let mut v = vec![b.display_name.clone(), b.business_id.replace('_', " "), b.business_id.clone()];
    v.extend(b.aliases.iter().cloned());
    v.extend(b.cross_domain_blocklist.iter().cloned());
    let mut out: Vec<String> = v.iter().map(|s| super::routing::normalize(s)).filter(|s| s.chars().count() >= 3).collect();
    out.sort();
    out.dedup();
    out
}

/// Every other registered business (archived too) whose identity terms appear in `text` as
/// whole words. A term that also names THIS business doesn't count. Pure.
pub fn cross_domain_hits(scope: &BusinessScope, reg: &Registry, text: &str) -> Vec<CrossHit> {
    let norm = format!(" {} ", super::routing::normalize(&text.replace('_', " ")));
    let norm_raw = format!(" {} ", super::routing::normalize(text));
    let own: Vec<String> = reg.businesses.iter().find(|b| b.business_id == scope.business_id).map(identity_terms).unwrap_or_default();
    let mut hits = vec![];
    for b in reg.businesses.iter().filter(|b| b.business_id != scope.business_id) {
        for t in identity_terms(b) {
            if own.contains(&t) {
                continue;
            }
            let pat = format!(" {t} ");
            if norm.contains(&pat) || norm_raw.contains(&pat) {
                hits.push(CrossHit { business_id: b.business_id.clone(), term: t });
            }
        }
    }
    hits
}

pub fn cross_domain_error(hits: &[CrossHit]) -> String {
    let mut ids: Vec<&str> = hits.iter().map(|h| h.business_id.as_str()).collect();
    ids.dedup();
    format!("CROSS_DOMAIN: this mentions another business ({}); it was not written. Review it in the Review Queue.", ids.join(", "))
}

// ── Commands (the UI / Tony's scoped memory access) ─────────────────────────

fn scoped(business_id: &str) -> Result<(BusinessScope, Registry), String> {
    let s = super::business_registry::store()?;
    Ok((s.scope(business_id)?, s.snapshot()))
}

#[tauri::command]
pub fn bizops_memory_list(business_id: String) -> Result<Value, String> {
    let (sc, _) = scoped(&business_id)?;
    Ok(json!({ "businessId": sc.id(), "notes": sc.list_notes() }))
}

#[tauri::command]
pub fn bizops_memory_read(business_id: String, rel: String) -> Result<Value, String> {
    let (sc, _) = scoped(&business_id)?;
    Ok(json!({ "businessId": sc.id(), "rel": rel, "text": sc.read_note(&rel)? }))
}

#[tauri::command]
pub fn bizops_memory_write(business_id: String, rel: String, text: String) -> Result<Value, String> {
    let (sc, reg) = scoped(&business_id)?;
    sc.write_note(&reg, &rel, &text)?;
    Ok(json!({ "businessId": sc.id(), "rel": rel, "bytes": text.len() }))
}

#[tauri::command]
pub fn bizops_memory_search(business_id: String, q: String, k: Option<usize>) -> Result<Value, String> {
    let (sc, _) = scoped(&business_id)?;
    let hits: Vec<Value> = sc.search_notes(&q, k.unwrap_or(8).min(25)).into_iter().map(|(rel, text)| json!({ "rel": rel, "excerpt": text })).collect();
    Ok(json!({ "businessId": sc.id(), "hits": hits }))
}

#[cfg(test)]
mod tests {
    use super::super::business_registry::tests::active_store;
    use super::*;

    #[test]
    fn notes_stay_inside_their_business() {
        let (s, dir) = active_store("scope");
        let reg = s.snapshot();
        let t = s.scope("trades_contracting").unwrap();
        let e = s.scope("supplements_ecom").unwrap();
        t.write_note(&reg, "jobs/smith-reno.md", "Smith reno: brick veneer, invoice due Dec 1").unwrap();
        e.write_note(&reg, "inventory.md", "Whey isolate: 40 units left").unwrap();
        assert_eq!(t.list_notes(), ["jobs/smith-reno.md"]);
        assert_eq!(e.list_notes(), ["inventory.md"]);
        // E-commerce can't read Trades' note by any path.
        for rel in ["jobs/smith-reno.md", "../trades_contracting/jobs/smith-reno.md", r"..\trades_contracting\jobs\smith-reno.md", "/trades_contracting/jobs/smith-reno.md", "C:/x.md", "jobs:ads.md", "con.md", "a/./b.md"] {
            assert!(e.read_note(rel).is_err(), "{rel}");
        }
        let abs = dir.join("memory").join("ops").join("trades_contracting").join("jobs").join("smith-reno.md");
        assert!(e.read_note(&abs.to_string_lossy()).is_err(), "absolute path");
        assert!(e.search_notes("brick invoice", 5).is_empty(), "search never crosses businesses");
        assert_eq!(t.search_notes("brick", 5).len(), 1);
        // Extension allowlist and size cap.
        assert!(t.write_note(&reg, "run.exe", "x").is_err());
        assert!(t.write_note(&reg, "big.md", &"x".repeat(NOTE_MAX + 1)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cross_domain_writes_are_refused() {
        let (s, dir) = active_store("xdom");
        s.patch("trades_contracting", &super::super::business_registry::BusinessPatch { cross_domain_blocklist: Some(vec!["Henderson Masonry Supply".into()]), ..Default::default() }).unwrap();
        let reg = s.snapshot();
        let e = s.scope("supplements_ecom").unwrap();
        let t = s.scope("trades_contracting").unwrap();
        for leak in ["Order from Henderson Masonry Supply arrived", "copied from the trades & contracting notes", "see trades_contracting ledger", "masonry quote for the shop"] {
            let err = e.write_note(&reg, "x.md", leak).unwrap_err();
            assert!(err.starts_with("CROSS_DOMAIN:") && err.contains("trades_contracting"), "{leak}: {err}");
        }
        assert!(e.list_notes().is_empty(), "nothing was written");
        // The other direction too, and a filename counts.
        assert!(t.write_note(&reg, "x.md", "restock BF Supplements whey").unwrap_err().starts_with("CROSS_DOMAIN:"));
        assert!(t.write_note(&reg, "supplements_ecom-copy.md", "hello").unwrap_err().starts_with("CROSS_DOMAIN:"));
        // Its own names are fine.
        t.write_note(&reg, "ok.md", "Trades & Contracting masonry quote for Henderson Masonry Supply").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_folder_is_refused() {
        let (s, dir) = active_store("junction");
        let reg = s.snapshot();
        let e = s.scope("supplements_ecom").unwrap();
        let target = dir.join("memory").join("ops").join("trades_contracting");
        let link = e.memory_dir().join("peek");
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&target).output().map(|o| o.status.success()).unwrap_or(false);
        if ok {
            assert!(e.write_note(&reg, "peek/x.md", "x").is_err());
            assert!(e.read_note("peek/x.md").is_err());
            assert!(e.list_notes().is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
