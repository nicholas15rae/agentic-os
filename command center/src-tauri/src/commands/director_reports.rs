//! Director reports (docs/proposals/director-suite-v2-plan.md Part 5).
//!
//! Four moments leave a short Director report in the inbox: a brief the Director drafted, film
//! shots with no footage once intake settles, a ComfyUI batch done, and a revision round opened. Each
//! one goes out as a bus-only `agent_report` note (`events::publish_note`), the path the webview
//! already routes to the report player: it waits for Tony (`canSpeak`) and always adds the inbox
//! entry. Nothing here touches the voice or comms code.
//!
//! Summaries are templates (never model or user text): the project is named by its slug, and the
//! trace id `media:<slug>` ties the entry to the project. Every report is de-duplicated through
//! media.db `kv` (`report:<kind>:<slug>` → a fingerprint), so a restart doesn't repeat one either.

use rusqlite::{params, OptionalExtension};

use super::media::{self, MediaProject, MediaState};

pub(crate) const AGENT: &str = "director";
pub(crate) const EVENT_TYPE: &str = "agent_report";
const SEVERITY: &str = "milestone";

/// The project as spoken: its slug with dashes as spaces. Pure.
pub(crate) fn spoken(slug: &str) -> String {
    let s = slug.replace(['-', '_'], " ");
    let s = s.trim();
    if s.is_empty() {
        "the project".into()
    } else {
        s.chars().take(48).collect()
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Report lines (≤ 120 chars; the webview puts "Nic, " in front). Pure.
pub(crate) fn brief_text(slug: &str) -> String {
    format!("the {} brief is drafted and ready for a look.", spoken(slug))
}

pub(crate) fn gaps_text(slug: &str, unfilled: usize) -> String {
    format!("{} in {} still {} no footage.", plural(unfilled, "film shot", "film shots"), spoken(slug), if unfilled == 1 { "has" } else { "have" })
}

pub(crate) fn comfy_text(slug: &str, done: usize, failed: usize) -> String {
    let p = spoken(slug);
    match (done, failed) {
        (d, 0) => format!("the ComfyUI batch for {p} is done: {} in the bin.", plural(d, "image", "images")),
        (0, f) => format!("the ComfyUI batch for {p} didn't make it: {} failed.", plural(f, "job", "jobs")),
        (d, f) => format!("the ComfyUI batch for {p} is done: {} in the bin, {f} failed.", plural(d, "image", "images")),
    }
}

pub(crate) fn review_text(slug: &str, round: u8) -> String {
    format!("{} round {round} is ready for review on the verified shelf.", spoken(slug))
}

pub(crate) fn trace_for(slug: &str) -> String {
    format!("media:{slug}")
}

/// True the first time `fingerprint` is seen for `key` (and stores it); false for a repeat or when
/// media.db can't be read (no report rather than a repeated one).
pub(crate) fn first_time(state: &MediaState, key: &str, fingerprint: &str) -> bool {
    state
        .with(|c| {
            let old: Option<String> = c.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(media::sql_err)?;
            if old.as_deref() == Some(fingerprint) {
                return Ok(false);
            }
            c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![key, fingerprint]).map_err(media::sql_err)?;
            Ok(true)
        })
        .unwrap_or(false)
}

fn send(slug: &str, text: &str) {
    super::events::publish_note(AGENT, EVENT_TYPE, SEVERITY, text, Some(&trace_for(slug)));
}

/// The report for a saved brief, or None. Only a Director draft reports, once per cycle: Nic's own
/// saves (an edit, an approval, accepting a held draft) are never reported back and start a new
/// cycle, so a run of Director redrafts in between reports once. Decides and records only.
pub(crate) fn brief_report(state: &MediaState, p: &MediaProject) -> Option<String> {
    let b = p.brief.as_ref()?;
    let key = format!("report:brief:{}", p.slug);
    if b.approved || b.updated_by != "director" {
        first_time(state, &key, "nic");
        return None;
    }
    first_time(state, &key, "drafted").then(|| brief_text(&p.slug))
}

pub(crate) fn brief_saved(state: &MediaState, p: &MediaProject) {
    if let Some(t) = brief_report(state, p) {
        send(&p.slug, &t);
    }
}

/// Film shots that still have no footage once intake settles: empty film slots minus the clips of
/// the same kind that no slot holds yet (those are waiting to be matched, so their shots aren't
/// counted). Pure.
pub(crate) fn missing_footage(m: &media::TimelineManifest, assets: &[media::MediaAsset]) -> usize {
    let held: std::collections::HashSet<&str> = m.shot_list.iter().filter_map(|s| s.asset_id.as_deref()).collect();
    let mut kinds: Vec<&str> = m.shot_list.iter().filter(|s| s.source == "film" && s.asset_id.is_none()).map(|s| s.kind.as_str()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
        .iter()
        .map(|k| {
            let empty = m.shot_list.iter().filter(|s| s.source == "film" && s.asset_id.is_none() && s.kind == *k).count();
            let spare = assets.iter().filter(|a| a.kind == *k && !held.contains(a.id.as_str())).count();
            empty.saturating_sub(spare)
        })
        .sum()
}

/// Reports only when the count of shots with no footage goes up (a new shot list, a cleared slot):
/// filling slots one by one stays quiet. The count is always stored. None for a finished project.
pub(crate) fn gaps_report(state: &MediaState, slug: &str) -> Option<String> {
    let p = media::load_project(state, slug).ok()?;
    if p.status == "done" {
        return None;
    }
    let root = media::project_root(state, slug).ok()?;
    let m = media::load_manifest_strict(&root, slug).ok()?;
    let assets = media::list_assets(state, slug).ok()?;
    let n = missing_footage(&m, &assets);
    let key = format!("report:gaps:{slug}");
    let before: Option<usize> = state
        .with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [&key], |r| r.get::<_, String>(0)).optional().map_err(media::sql_err))
        .ok()?
        .and_then(|v| v.parse().ok());
    if before == Some(n) {
        return None;
    }
    // Stored first: a report goes out only once the new count is on record.
    if !first_time(state, &key, &n.to_string()) {
        return None;
    }
    (n > before.unwrap_or(0)).then(|| gaps_text(slug, n))
}

pub(crate) fn footage_gaps(state: &MediaState, slug: &str) {
    if let Some(t) = gaps_report(state, slug) {
        send(slug, &t);
    }
}

/// One report per ComfyUI batch and project (`started_at` names the batch). None when nothing finished.
pub(crate) fn comfy_report(state: &MediaState, slug: &str, done: usize, failed: usize, started_at: u64) -> Option<String> {
    if done == 0 && failed == 0 {
        return None;
    }
    first_time(state, &format!("report:comfy:{slug}"), &started_at.to_string()).then(|| comfy_text(slug, done, failed))
}

pub(crate) fn comfy_batch(state: &MediaState, slug: &str, done: usize, failed: usize, started_at: u64) {
    if let Some(t) = comfy_report(state, slug, done, failed, started_at) {
        send(slug, &t);
    }
}

/// One report per revision round opened (round 2 on). Round 1 is the first verified render, which
/// the render-done report already covers.
pub(crate) fn round_report(state: &MediaState, slug: &str, round: u8, render_id: &str) -> Option<String> {
    if round < 2 {
        return None;
    }
    first_time(state, &format!("report:review:{slug}"), &format!("{round}:{render_id}")).then(|| review_text(slug, round))
}

pub(crate) fn review_round(state: &MediaState, slug: &str, round: u8, render_id: &str) {
    if let Some(t) = round_report(state, slug, round, render_id) {
        send(slug, &t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::media::{create_project, CreativeBrief};

    fn tmp_state() -> (MediaState, std::path::PathBuf) {
        let d = std::env::temp_dir().join(format!("director-reports-{}", media::short_id("t")));
        std::fs::create_dir_all(&d).unwrap();
        (MediaState::in_memory(&d), d)
    }

    fn brief(approved: bool, by: &str, at: &str) -> CreativeBrief {
        CreativeBrief { idea: "x".into(), goal: "y".into(), platform: "reels".into(), length_sec: 30.0, aspect: "9:16".into(), tone: "warm".into(), references: vec![], guessed: vec![], approved, updated_by: by.into(), updated_at: at.into() }
    }

    #[test]
    fn report_lines_are_short_templates_that_name_the_project() {
        for t in [brief_text("my-self-tape"), gaps_text("my-self-tape", 3), gaps_text("a", 1), comfy_text("my-self-tape", 4, 0), comfy_text("p", 0, 2), comfy_text("p", 3, 1), review_text("my-self-tape", 2)] {
            assert!(t.chars().count() <= 100, "{t}");
            assert!(!t.contains("Nic"), "the webview adds the name: {t}");
        }
        assert!(brief_text("my-self-tape").contains("my self tape"));
        assert_eq!(gaps_text("a", 1), "1 film shot in a still has no footage.");
        assert_eq!(gaps_text("a", 2), "2 film shots in a still have no footage.");
        assert_eq!(comfy_text("p", 3, 1), "the ComfyUI batch for p is done: 3 images in the bin, 1 failed.");
        assert_eq!(trace_for("demo"), "media:demo");
        assert_eq!(spoken("--"), "the project");
    }

    #[test]
    fn only_director_drafts_report_once_per_cycle_of_nic_saves() {
        let (st, _d) = tmp_state();
        let mut p = create_project(&st, "Brief Test", None).unwrap();
        assert_eq!(brief_report(&st, &p), None, "no brief yet");
        p.brief = Some(brief(false, "nic", "t1"));
        assert_eq!(brief_report(&st, &p), None, "Nic's own draft isn't reported back");
        p.brief = Some(brief(false, "director", "t2"));
        assert!(brief_report(&st, &p).unwrap().contains("drafted"));
        p.brief = Some(brief(false, "director", "t3"));
        assert_eq!(brief_report(&st, &p), None, "a redraft in the same cycle: once");
        p.brief = Some(brief(true, "nic", "t4"));
        assert_eq!(brief_report(&st, &p), None, "Nic's approval isn't reported back");
        p.brief = Some(brief(false, "nic", "t5"));
        assert_eq!(brief_report(&st, &p), None, "accepting a held draft is Nic's save");
        p.brief = Some(brief(false, "director", "t6"));
        assert!(brief_report(&st, &p).is_some(), "a draft after Nic's save reports again");
    }

    #[test]
    fn a_title_or_status_change_never_reports_the_stored_brief() {
        let (st, _d) = tmp_state();
        let p = create_project(&st, "Old Draft", None).unwrap();
        // A Director draft saved before Part 5 (no kv row yet).
        let mut q = media::load_project(&st, &p.slug).unwrap();
        q.brief = Some(brief(false, "director", "t0"));
        media::save_project(&st, &q).unwrap();
        media::project_update(&st, &p.slug, Some("Old Draft 2".into()), None, Some("review".into()), None).unwrap();
        let kv: Option<String> = st.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [format!("report:brief:{}", p.slug)], |r| r.get(0)).optional().map_err(media::sql_err)).unwrap();
        assert_eq!(kv, None, "no brief in the call: nothing decided");
    }

    #[test]
    fn footage_gaps_report_only_when_the_missing_count_goes_up() {
        let (st, _d) = tmp_state();
        let p = create_project(&st, "Gap Test", None).unwrap();
        let root = media::project_root(&st, &p.slug).unwrap();
        let write = |slots: &[(&str, Option<&str>, &str)]| {
            let mut m = media::load_manifest_strict(&root, &p.slug).unwrap();
            m.shot_list = slots
                .iter()
                .map(|(id, a, src)| media::ShotSlot { id: (*id).into(), label: "Hook".into(), instructions: String::new(), kind: "video".into(), target_sec: None, asset_id: a.map(String::from), status: "needed".into(), framing: None, action: String::new(), source: (*src).into(), phone_tips: vec![], filmed: false })
                .collect();
            std::fs::write(root.join("working").join("timeline_manifest.json"), serde_json::to_string(&m).unwrap()).unwrap();
        };
        assert_eq!(gaps_report(&st, &p.slug), None, "no shot list: nothing to report");
        write(&[("s1", None, "film"), ("s2", None, "film"), ("g1", None, "generate")]);
        assert_eq!(gaps_report(&st, &p.slug).as_deref(), Some("2 film shots in gap test still have no footage."));
        assert_eq!(gaps_report(&st, &p.slug), None, "same gaps: once");
        write(&[("s1", Some("a1"), "film"), ("s2", None, "film")]);
        assert_eq!(gaps_report(&st, &p.slug), None, "a slot filled: progress stays quiet");
        write(&[("s1", Some("a1"), "film"), ("s2", Some("a2"), "film")]);
        assert_eq!(gaps_report(&st, &p.slug), None, "all filled");
        write(&[("s1", Some("a1"), "film"), ("s2", None, "film")]);
        assert_eq!(gaps_report(&st, &p.slug).as_deref(), Some("1 film shot in gap test still has no footage."), "a gap that comes back reports again");
        write(&[("s1", None, "film"), ("s2", None, "film"), ("s3", None, "film")]);
        assert!(gaps_report(&st, &p.slug).unwrap().starts_with("3 film shots"), "a longer shot list reports");
    }

    #[test]
    fn clips_no_slot_holds_yet_cover_empty_slots_of_their_kind() {
        let slot = |id: &str, kind: &str, a: Option<&str>, src: &str| media::ShotSlot { id: id.into(), label: "x".into(), instructions: String::new(), kind: kind.into(), target_sec: None, asset_id: a.map(String::from), status: "needed".into(), framing: None, action: String::new(), source: src.into(), phone_tips: vec![], filmed: false };
        let asset = |id: &str, kind: &str| media::MediaAsset { id: id.into(), kind: kind.into(), ..Default::default() };
        let (st, _d) = tmp_state();
        let p = create_project(&st, "Cover", None).unwrap();
        let mut m = media::load_manifest_strict(&media::project_root(&st, &p.slug).unwrap(), &p.slug).unwrap();
        m.shot_list = vec![slot("s1", "video", Some("a1"), "film"), slot("s2", "video", None, "film"), slot("s3", "video", None, "film"), slot("s4", "image", None, "film"), slot("g1", "video", None, "generate")];
        assert_eq!(missing_footage(&m, &[]), 3);
        assert_eq!(missing_footage(&m, &[asset("a1", "video"), asset("a2", "video")]), 2, "a2 waits to be matched: one video shot covered");
        assert_eq!(missing_footage(&m, &[asset("a2", "video"), asset("a3", "video"), asset("a4", "video")]), 1, "spare clips never go below zero; the photo shot stays");
        assert_eq!(missing_footage(&m, &[asset("a2", "video"), asset("a3", "video"), asset("i1", "image")]), 0);
    }

    #[test]
    fn comfy_and_review_reports_are_deduplicated() {
        let (st, _d) = tmp_state();
        assert_eq!(comfy_report(&st, "demo", 0, 0, 1), None, "nothing finished");
        assert!(comfy_report(&st, "demo", 2, 0, 100).is_some());
        assert_eq!(comfy_report(&st, "demo", 2, 0, 100), None, "same batch");
        assert!(comfy_report(&st, "demo", 1, 1, 200).is_some(), "next batch");
        assert!(comfy_report(&st, "other", 1, 0, 200).is_some(), "per project");
        assert_eq!(round_report(&st, "demo", 1, "r1"), None, "round 1: the render-done report covers it");
        assert_eq!(round_report(&st, "demo", 2, "r2").as_deref(), Some("demo round 2 is ready for review on the verified shelf."));
        assert_eq!(round_report(&st, "demo", 2, "r2"), None);
        assert!(round_report(&st, "demo", 3, "r3").is_some());
    }
}
