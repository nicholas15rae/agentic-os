use super::*;
use serde_json::json;

const STAGING: &str = r"D:\Art Apps\agentic os\staging";
const EXT: &str = r"G:\ai-hub\external-builds";

fn env(id: &str, slug: &str, runtime: Runtime, worker: AssignedWorker) -> TaskEnvelope {
    let dir = expected_dir(runtime, slug, Path::new(STAGING), Path::new(EXT));
    TaskEnvelope {
        build_id: id.into(),
        project_slug: slug.into(),
        title: format!("Build {slug}"),
        target_runtime: runtime,
        output_directory: dir.display().to_string(),
        spec_summary: "A tiny thing".into(),
        milestones: vec!["Spec locked".into(), "Ready".into()],
        acceptance_criteria: vec!["Renders".into()],
        assigned_worker: worker,
        preview_url: None,
        status: Status::Queued,
        human_override: vec![],
    }
}

fn hub_with(ids: &[(&str, AssignedWorker)]) -> HubFile {
    let mut h = HubFile::default();
    for (i, (id, w)) in ids.iter().enumerate() {
        h.enqueue(env(id, &format!("slug-{i}"), Runtime::InternalWidget, *w), "brief".into(), vec![], i as i64).unwrap();
    }
    h
}

fn smoke_fail(what: &str) -> SmokeReport {
    smoke::finish(vec![smoke::Check { name: what.into(), ok: false, required: true, detail: "boom".into() }], 1, 1)
}

fn smoke_pass() -> SmokeReport {
    smoke::finish(vec![smoke::Check { name: "entry-exists".into(), ok: true, required: true, detail: "ok".into() }], 1, 1)
}

// ── TaskEnvelope schema ──

#[test]
fn envelope_wire_format_is_the_spec_contract() {
    let e = env("b-1", "tip-calc", Runtime::ExternalOs, AssignedWorker::Claude);
    let v = serde_json::to_value(&e).unwrap();
    for k in ["build_id", "project_slug", "title", "target_runtime", "output_directory", "spec_summary", "milestones", "acceptance_criteria", "assigned_worker", "preview_url", "status"] {
        assert!(v.get(k).is_some(), "missing {k}");
    }
    assert_eq!(v["target_runtime"], "external_os");
    assert_eq!(v["assigned_worker"], "claude");
    assert_eq!(v["status"], "queued");
    assert_eq!(v["preview_url"], Value::Null);
    assert_eq!(v["output_directory"], r"G:\ai-hub\external-builds\tip-calc");
    let back: TaskEnvelope = serde_json::from_value(v).unwrap();
    assert_eq!(back, e);
}

#[test]
fn envelope_rejects_unknown_fields_and_bad_enums() {
    let mut v = serde_json::to_value(env("b-1", "x", Runtime::InternalWidget, AssignedWorker::Coder)).unwrap();
    v["sneaky"] = json!(true);
    assert!(serde_json::from_value::<TaskEnvelope>(v).is_err());
    let mut v = serde_json::to_value(env("b-1", "x", Runtime::InternalWidget, AssignedWorker::Coder)).unwrap();
    v["target_runtime"] = json!("cloud");
    assert!(serde_json::from_value::<TaskEnvelope>(v).is_err());
    let mut v = serde_json::to_value(env("b-1", "x", Runtime::InternalWidget, AssignedWorker::Coder)).unwrap();
    v["status"] = json!("done");
    assert!(serde_json::from_value::<TaskEnvelope>(v).is_err());
    // human_override is optional on the wire.
    let mut v = serde_json::to_value(env("b-1", "x", Runtime::InternalWidget, AssignedWorker::Coder)).unwrap();
    v.as_object_mut().unwrap().remove("human_override");
    assert!(serde_json::from_value::<TaskEnvelope>(v).is_ok());
}

#[test]
fn validate_new_enforces_the_runtime_directory_and_shapes() {
    let dir = expected_dir(Runtime::InternalWidget, "ok-slug", Path::new(STAGING), Path::new(EXT));
    let good = env("b-9", "ok-slug", Runtime::InternalWidget, AssignedWorker::Coder);
    assert!(validate_new(good.clone(), &dir, &[]).is_ok());
    // Case / slash differences are the same Windows path.
    let mut e = good.clone();
    e.output_directory = e.output_directory.to_uppercase().replace('\\', "/");
    assert!(validate_new(e, &dir, &[]).is_ok());
    let mut e = good.clone();
    e.output_directory = r"C:\Windows\System32".into();
    assert!(validate_new(e, &dir, &[]).unwrap_err().contains("output_directory"));
    let mut e = good.clone();
    e.project_slug = "Bad Slug".into();
    assert!(validate_new(e, &dir, &[]).is_err());
    let mut e = good.clone();
    e.build_id = "nope".into();
    assert!(validate_new(e, &dir, &[]).is_err());
    let mut e = good.clone();
    e.milestones.clear();
    assert!(validate_new(e, &dir, &[]).is_err());
    let mut e = good.clone();
    e.status = Status::Building;
    assert!(validate_new(e, &dir, &[]).is_err());
    let mut e = good.clone();
    e.preview_url = Some("https://evil.example".into());
    assert!(validate_new(e, &dir, &[]).is_err());
    let mut e = good.clone();
    e.preview_url = Some("http://127.0.0.1:5173/".into());
    assert!(validate_new(e, &dir, &[]).is_ok());
    // Overrides can't be smuggled in at enqueue; secrets are scrubbed.
    let mut e = good;
    e.human_override.push(HumanOverride { directive: "x".into(), priority: "high".into(), at: 0, applied_at: None, applied_stage: None, auto: false });
    e.spec_summary = "uses key sk-abcdefghijklmnopqrstuvwx1234".into();
    let out = validate_new(e, &dir, &[]).unwrap();
    assert!(out.human_override.is_empty());
    assert!(!out.spec_summary.contains("sk-abcdefghijklmnopqrstuvwx1234"));
}

#[test]
fn external_base_must_live_outside_the_repo() {
    let repo = Path::new(r"D:\Art Apps\agentic os");
    assert!(validate_external_base(EXT, repo).is_ok());
    assert!(validate_external_base(r"D:\Art Apps\agentic os\builds", repo).is_err());
    assert!(validate_external_base(r"C:\", repo).is_err());
    assert!(validate_external_base("relative/dir", repo).is_err());
}

// ── FIFO ordering ──

#[test]
fn fifo_one_build_per_lane_in_enqueue_order() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Designer), ("b-c", AssignedWorker::Claude), ("b-d", AssignedWorker::Coder)]);
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-a"));
    assert_eq!(h.next_for(Lane::Claude).as_deref(), Some("b-c"));
    h.get_mut("b-a").unwrap().worker_task_id = Some("t-1".into());
    assert_eq!(h.next_for(Lane::Worker), None, "lane busy: nothing else starts");
    // Finished → the next in order.
    // Not waiting on a check: the report is kept, nothing else changes (review #2).
    assert_eq!(h.record_smoke("b-a", smoke_pass(), 5).unwrap(), Status::Queued);
    h.get_mut("b-a").unwrap().envelope.status = Status::ReadyForMerge;
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-b"));
    let seqs: Vec<u64> = h.builds.iter().map(|b| b.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4]);
}

#[test]
fn fifo_is_deterministic_and_reorder_only_moves_waiting_builds() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder), ("b-c", AssignedWorker::Coder)]);
    h.reorder("b-c", "top").unwrap();
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-c"));
    h.reorder("b-c", "down").unwrap();
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-a"));
    h.reorder("b-a", "up").unwrap(); // already first: no-op
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-a"));
    h.get_mut("b-a").unwrap().worker_task_id = Some("t".into());
    assert!(h.reorder("b-a", "down").is_err(), "a dispatched build stays put");
    assert!(h.reorder("b-b", "sideways").is_err());
    let order: Vec<&str> = h.builds.iter().map(|b| b.envelope.build_id.as_str()).collect();
    assert_eq!(order, vec!["b-a", "b-c", "b-b"]);
}

#[test]
fn enqueue_rejects_duplicates_instead_of_dropping() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    assert!(h.enqueue(env("b-a", "other", Runtime::InternalWidget, AssignedWorker::Coder), "".into(), vec![], 9).is_err());
    assert!(h.enqueue(env("b-z", "slug-0", Runtime::InternalWidget, AssignedWorker::Coder), "".into(), vec![], 9).is_err());
    assert_eq!(h.builds.len(), 1);
}

// ── Worker sync, smoke and repair routing ──

fn running(h: &mut HubFile, id: &str) {
    h.get_mut(id).unwrap().worker_task_id = Some(format!("t-{id}"));
    let w = WorkerSnap { status: "coding".into(), stage: Some("code".into()), iteration: 1, max_iterations: 3, ..Default::default() };
    assert_eq!(h.apply_worker(id, &w, 10).unwrap(), Effect::None);
    assert_eq!(h.get(id).unwrap().envelope.status, Status::Building);
    let w = WorkerSnap { status: "review_ready".into(), stage: Some("done".into()), ..Default::default() };
    assert_eq!(h.apply_worker(id, &w, 20).unwrap(), Effect::Smoke);
    assert_eq!(h.get(id).unwrap().envelope.status, Status::SmokeTesting);
}

#[test]
fn smoke_pass_is_ready_for_merge_and_unlocks_promote() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    assert!(h.promote("b-a", 1).is_err());
    running(&mut h, "b-a");
    assert_eq!(h.record_smoke("b-a", smoke_pass(), 30).unwrap(), Status::ReadyForMerge);
    assert_eq!(h.get("b-a").unwrap().progress, 100);
    h.promote("b-a", 31).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Deployed);
}

#[test]
fn repair_auto_routing_after_two_failed_smoke_tests() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder)]);
    running(&mut h, "b-a");
    // First failure: one automatic repair pass, the failure becomes an override, and the build
    // keeps its place at the head of the lane (b-b does not jump it).
    assert_eq!(h.record_smoke("b-a", smoke_fail("scripts-balanced"), 30).unwrap(), Status::Queued);
    let b = h.get("b-a").unwrap();
    assert_eq!(b.smoke.failures, 1);
    assert!(b.worker_task_id.is_none());
    assert!(b.envelope.human_override.iter().any(|o| o.auto && o.directive.contains("scripts-balanced")));
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-a"));
    // Second failure → Repair Queue with the exact failed assertions and trace.
    running(&mut h, "b-a");
    assert_eq!(h.record_smoke("b-a", smoke_fail("body"), 40).unwrap(), Status::RepairQueue);
    let b = h.get("b-a").unwrap();
    let r = b.repair.as_ref().unwrap();
    assert!(r.auto);
    assert_eq!(r.failed_assertions, vec!["body: boom".to_string()]);
    assert!(r.trace.contains("smoke test failed"));
    // The lane moves on.
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-b"));
}

#[test]
fn a_failed_worker_run_goes_straight_to_repair_with_its_error() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    h.get_mut("b-a").unwrap().worker_task_id = Some("t".into());
    let w = WorkerSnap { status: "failed".into(), error: Some("Coder returned no HTML".into()), ..Default::default() };
    h.apply_worker("b-a", &w, 5).unwrap();
    let b = h.get("b-a").unwrap();
    assert_eq!(b.envelope.status, Status::RepairQueue);
    assert_eq!(b.repair.as_ref().unwrap().failed_assertions, vec!["worker: Coder returned no HTML".to_string()]);
}

#[test]
fn manual_repair_and_requeue_reenter_at_the_tail_with_a_fresh_budget() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder)]);
    running(&mut h, "b-a");
    h.record_smoke("b-a", smoke_fail("portable"), 30).unwrap();
    h.to_repair("b-a", "sent by Nic", "trace", vec!["portable: x".into()], false, 31).unwrap();
    assert!(!h.get("b-a").unwrap().repair.as_ref().unwrap().auto);
    assert!(h.requeue("b-b", None, 32, &[]).is_err(), "only repair-queue builds re-enter");
    h.requeue("b-a", Some("use relative paths only"), 33, &[]).unwrap();
    let b = h.builds.last().unwrap();
    assert_eq!(b.envelope.build_id, "b-a");
    assert_eq!(b.envelope.status, Status::Queued);
    assert_eq!(b.smoke, SmokeState::default());
    let d: Vec<&str> = b.envelope.human_override.iter().map(|o| o.directive.as_str()).collect();
    assert!(d.contains(&"use relative paths only"));
    assert!(d.iter().any(|x| x.contains("portable: x")));
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-b"));
}

// ── Steer injection ──

#[test]
fn steer_appends_a_high_priority_override_and_marks_it_applied_at_the_next_step() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    h.get_mut("b-a").unwrap().worker_task_id = Some("t".into());
    // A pasted master prompt keeps its shape: line breaks survive, CRLF and runs of blank lines are tidied.
    h.steer("b-a", "  make the CTA bigger  \r\n\r\n\r\n\r\n  - and darker ", 100, &[]).unwrap();
    let o = &h.get("b-a").unwrap().envelope.human_override[0];
    assert_eq!((o.directive.as_str(), o.priority.as_str(), o.applied_at), ("make the CTA bigger\n\n  - and darker", "high", None));
    assert_eq!(override_lines(&h.get("b-a").unwrap().envelope), vec!["make the CTA bigger\n\n  - and darker".to_string()]);
    // A row from a step that was already running doesn't count; the next stage start does.
    let row = |seq, at, ev: &str| WorkerRow { seq, at, event_type: ev.into(), severity: "handoff".into(), from: "prompter".into(), to: "coder".into(), text: "x".into(), stage: Some("code".into()) };
    let w = WorkerSnap { status: "coding".into(), stage: Some("code".into()), rows: vec![row(1, 90, "stage_started"), row(2, 120, "stage_completed")], ..Default::default() };
    h.apply_worker("b-a", &w, 121).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.human_override[0].applied_at, None);
    let w = WorkerSnap { status: "coding".into(), stage: Some("evaluate".into()), rows: vec![row(3, 130, "stage_started")], ..Default::default() };
    h.apply_worker("b-a", &w, 131).unwrap();
    let o = &h.get("b-a").unwrap().envelope.human_override[0];
    assert_eq!((o.applied_at, o.applied_stage.as_deref()), (Some(130), Some("code")));
    // Steering never changes the build's status (no restart).
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Building);
    assert!(h.steer("b-a", "   ", 140, &[]).is_err());
}

#[test]
fn steer_text_is_scrubbed_and_capped() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    let long = format!("use token sk-abcdefghijklmnopqrstuv0123 {}", "x".repeat(OVERRIDE_MAX + 900));
    h.steer("b-a", &long, 1, &[]).unwrap();
    let d = h.get("b-a").unwrap().envelope.human_override[0].directive.clone();
    assert!(d.chars().count() <= OVERRIDE_MAX);
    // A long master prompt (well past the old 500-char cap) goes through whole.
    let prompt = (1..=120).map(|i| format!("## Section {i}\nKeep the layout from section {i} and add the details below.")).collect::<Vec<_>>().join("\n\n");
    assert!(prompt.chars().count() > 5000);
    h.steer("b-a", &prompt, 2, &[]).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.human_override[1].directive, prompt);
    let n = prompt.chars().count();
    assert!(h.get("b-a").unwrap().logs.iter().any(|l| l.text.starts_with("Steer received") && l.text.contains(&format!("{} chars", super::group(n)))), "the log states the exact size");
    // The next agent step logs the injection with the same count.
    let row = WorkerRow { seq: 9, at: 50, event_type: "stage_started".into(), severity: "handoff".into(), from: "prompter".into(), to: "coder".into(), text: "x".into(), stage: Some("code".into()) };
    h.get_mut("b-a").unwrap().worker_task_id = Some("t".into());
    h.apply_worker("b-a", &WorkerSnap { status: "coding".into(), stage: Some("code".into()), rows: vec![row], ..Default::default() }, 51).unwrap();
    assert!(h.get("b-a").unwrap().logs.iter().any(|l| l.text == format!("✓ Steer injected into the code step: all {n} chars")));
    assert!(!d.contains("sk-abcdefghijklmnopqrstuv0123"));
}

#[test]
fn the_worker_prompt_header_carries_the_overrides() {
    envelope::set_overrides("t-steer-hdr", vec!["dark theme only".into()]);
    assert_eq!(envelope::overrides("t-steer-hdr"), vec!["dark theme only".to_string()]);
    envelope::set_overrides("t-steer-hdr", vec![]);
    assert!(envelope::overrides("t-steer-hdr").is_empty());
}

// ── Pause / resume ──

#[test]
fn pause_holds_state_and_resume_returns_to_it() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder)]);
    h.get_mut("b-a").unwrap().worker_task_id = Some("t".into());
    h.apply_worker("b-a", &WorkerSnap { status: "designing".into(), stage: Some("design".into()), ..Default::default() }, 1).unwrap();
    let before = h.get("b-a").unwrap().progress;
    h.pause("b-a", 2).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Paused);
    // While paused, worker progress still logs but never advances the status (no smoke, no repair).
    assert_eq!(h.apply_worker("b-a", &WorkerSnap { status: "review_ready".into(), ..Default::default() }, 3).unwrap(), Effect::None);
    assert_eq!(h.apply_worker("b-a", &WorkerSnap { status: "failed".into(), ..Default::default() }, 3).unwrap(), Effect::None);
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Paused);
    assert_eq!(h.get("b-a").unwrap().progress, before);
    // A paused build frees its lane.
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-b"));
    h.resume("b-a", 4).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Building);
    assert!(h.resume("b-a", 5).is_err());
    assert!(h.pause("b-a", 6).is_ok());
    h.get_mut("b-a").unwrap().envelope.status = Status::Deployed;
    assert!(h.pause("b-a", 7).is_err());
}

#[test]
fn a_paused_task_is_never_claimed_by_the_worker() {
    let store = TaskStore::in_memory();
    let mk = |t: &str| super::super::taskworker::CreateArgs { raw_intent: format!("build {t}"), title: Some(t.into()), thread: None, source: "playplace".into(), idea_id: None, options: None, dedupe_key: Some(format!("k-{t}")), project_slug: None };
    let (a, _) = super::super::taskworker::create_task(&store, &mk("first"), 3, &[]).unwrap();
    let (b, _) = super::super::taskworker::create_task(&store, &mk("second"), 3, &[]).unwrap();
    // Whichever the worker would claim first, pause it: the other one must run instead.
    let head = store.with(|c| envelope::list(c, None, 10, false)).unwrap().iter().map(|e| (e.created_at, e.task_id.clone())).min().unwrap().1;
    let other = if head == a.task_id { b.task_id.clone() } else { a.task_id.clone() };
    envelope::set_paused(&head, true);
    let got = store.with(|c| envelope::claim_next(c, envelope::now_ms(), 60_000)).unwrap().unwrap();
    assert_eq!(got.task_id, other, "the paused head is skipped, the next task runs");
    // With both unavailable (one paused, one leased) nothing is claimed.
    assert!(store.with(|c| envelope::claim_next(c, envelope::now_ms(), 60_000)).unwrap().is_none());
    envelope::set_paused(&head, false);
    assert_eq!(store.with(|c| envelope::claim_next(c, envelope::now_ms(), 60_000)).unwrap().unwrap().task_id, head);
}

// ── Smoke lint & preview path guard ──

#[test]
fn smoke_lint_catches_structure_escape_and_portability() {
    let ok = "<!doctype html><html><body><script>let a = 1;</script><style>p{}</style></body></html>";
    assert!(smoke::lint_html(ok, Runtime::InternalWidget).iter().filter(|c| c.required).all(|c| c.ok));
    let bad = "<html><body><script>top.location = 'x'; fetch('http://localhost:8080/api')</body>";
    let failed: Vec<String> = smoke::lint_html(bad, Runtime::InternalWidget).into_iter().filter(|c| c.required && !c.ok).map(|c| c.name).collect();
    assert!(failed.contains(&"scripts-balanced".to_string()));
    assert!(failed.contains(&"sandbox-safe".to_string()));
    assert!(failed.contains(&"portable".to_string()));
    // The escape rule applies to dashboard widgets only; "task-" is not a key.
    let ext = "<html><body><script>window.top.focus(); const id = 'task-12345678901234567890';</script></body></html>";
    assert!(smoke::lint_html(ext, Runtime::ExternalOs).iter().filter(|c| c.required).all(|c| c.ok));
    // Remote assets are advisory.
    let cdn = r#"<html><body><script src="https://cdn.tailwindcss.com"></script></body></html>"#;
    let c = smoke::lint_html(cdn, Runtime::InternalWidget);
    assert!(c.iter().any(|c| c.name == "self-contained" && !c.ok && !c.required));
    assert!(smoke::finish(c, 0, 0).passed);
}

#[test]
fn smoke_run_on_a_folder() {
    let dir = std::env::temp_dir().join(format!("buildhub-smoke-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let r = smoke::run(&dir, Runtime::InternalWidget, 1);
    assert!(!r.passed);
    assert!(r.failed_assertions[0].starts_with("entry-exists"));
    std::fs::write(dir.join("index.html"), "<!doctype html><html><head><title>t</title></head><body><h1>Hello there, this is a widget</h1><script>document.querySelector('h1').textContent = 'ok';</script></body></html>").unwrap();
    let r = smoke::run(&dir, Runtime::InternalWidget, 2);
    assert!(r.passed, "{:?}", r.failed_assertions);
    std::fs::write(dir.join("index.html"), "<!doctype html><html><head><title>t</title></head><body><h1>Hello there, this is a widget</h1><script>const = ;</script></body></html>").unwrap();
    let r = smoke::run(&dir, Runtime::InternalWidget, 3);
    if r.checks.iter().any(|c| c.name == "script-syntax" && c.required) {
        assert!(!r.passed, "node --check catches the syntax error");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn preview_paths_never_escape_the_root() {
    let dir = std::env::temp_dir().join(format!("buildhub-prev-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(dir.join("css")).unwrap();
    std::fs::write(dir.join("index.html"), "x").unwrap();
    std::fs::write(dir.join("css").join("a.css"), "x").unwrap();
    assert!(preview::resolve(&dir, "/").is_some());
    assert!(preview::resolve(&dir, "/css/a.css?v=3").is_some());
    assert!(preview::resolve(&dir, "/css%2Fa.css").is_some());
    assert!(preview::resolve(&dir, "/../secret.txt").is_none());
    assert!(preview::resolve(&dir, "/%2e%2e/secret.txt").is_none());
    assert!(preview::resolve(&dir, "/C:/Windows/win.ini").is_none());
    assert!(preview::resolve(&dir, "/missing.js").is_none());
    assert_eq!(preview::content_type(Path::new("a.mjs")), "text/javascript; charset=utf-8");
    assert!(preview::is_loopback_url("http://127.0.0.1:5173/"));
    assert!(!preview::is_loopback_url("http://127.0.0.1/"));
    assert!(!preview::is_loopback_url("https://example.com:443/"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn preview_server_serves_the_output_folder() {
    let dir = std::env::temp_dir().join(format!("buildhub-srv-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<p>peek</p>").unwrap();
    tauri::async_runtime::block_on(async {
        let p = preview::start(dir.clone()).await.unwrap();
        let http = reqwest::Client::new();
        let r = http.get(p.url()).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert_eq!(r.text().await.unwrap(), "<p>peek</p>");
        assert!(preview::reachable(&http, &p.url()).await);
        let r = http.get(format!("{}../x", p.url())).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 404);
        p.stop();
    });
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Intake ──

#[test]
fn intake_questions_parse_and_always_end_with_runtime_and_worker() {
    let reply = r#"Sure! {"questions": [{"question": "Who uses it?", "options": ["Just me", "My team"]}, {"question": "bad", "options": ["one"]}, {"question": "Offline?", "options": ["Yes", "No", "Doesn't matter"]}]}"#;
    let qs = parse_questions(reply).unwrap();
    assert_eq!(qs.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), vec!["q1", "q2"]);
    assert!(parse_questions("no json").is_none());
    let f = fallback_questions();
    assert!((3..=5).contains(&f.len()));
    let ids: Vec<&str> = f.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(&ids[ids.len() - 2..], ["runtime", "worker"]);
}

#[test]
fn worker_brief_carries_the_contract() {
    let h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    let s = worker_brief(h.get("b-a").unwrap());
    assert!(s.contains("BUILD CONTRACT"));
    assert!(s.contains("INTERNAL WIDGET"));
    assert!(s.contains("- Renders"));
    assert!(s.chars().count() <= BRIEF_MAX);
}

// ── Path B scaffolding (against a temp dir — never C:\ai-hub in tests) ──

#[test]
fn external_scaffold_and_copy_into_a_temp_base() {
    let base = std::env::temp_dir().join(format!("buildhub-ext-{}-{}", std::process::id(), now_ms()));
    let mut e = env("b-ext", "tip-calc", Runtime::ExternalOs, AssignedWorker::Coder);
    e.output_directory = expected_dir(Runtime::ExternalOs, "tip-calc", Path::new(STAGING), &base).display().to_string();
    assert!(e.output_directory.starts_with(&base.display().to_string()));
    scaffold_external(&e).unwrap();
    let out = PathBuf::from(&e.output_directory);
    assert!(out.join("app").is_dir());
    assert!(std::fs::read_to_string(out.join("README.md")).unwrap().contains("- [ ] Renders"));
    let back: TaskEnvelope = serde_json::from_str(&std::fs::read_to_string(out.join("task-envelope.json")).unwrap()).unwrap();
    assert_eq!(back, e);
    // The worker's staged output is copied into <slug>\app (dotfiles skipped), then smoke-tested there.
    let staged = base.join("staged");
    std::fs::create_dir_all(staged.join("css")).unwrap();
    std::fs::write(staged.join("index.html"), "<!doctype html><html><head><title>t</title></head><body><h1>Tip calculator app here</h1><p>ok ok ok ok ok ok ok</p></body></html>").unwrap();
    std::fs::write(staged.join("css").join("a.css"), "p{}").unwrap();
    std::fs::write(staged.join(".status.json"), "{}").unwrap();
    assert_eq!(copy_tree(&staged, &served_dir(&e)).unwrap(), 2);
    assert!(!served_dir(&e).join(".status.json").exists());
    assert!(smoke::run(&served_dir(&e), Runtime::ExternalOs, 1).passed);
    let _ = std::fs::remove_dir_all(&base);
}

// ── Review fixes (play-place-review-findings.md) ──

#[test]
fn review0_preview_rejects_unc_rooted_and_backslash_paths_before_touching_the_fs() {
    for bad in [r"\\evil.example@SSL\share\x", r"\Windows\win.ini", r"a\b", "C:/x", "a/../b", "./a", "a/./b", "x\0y", "/abs"] {
        assert!(!preview::safe_rel(bad), "{bad:?}");
    }
    for good in ["", "index.html", "css/a.css", "a//b.js"] {
        assert!(preview::safe_rel(good), "{good:?}");
    }
    let dir = std::env::temp_dir().join(format!("buildhub-unc-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "x").unwrap();
    for raw in ["/%5C%5Cevil.example%40SSL%5Cshare%5Cx", "/%5C%5C10.0.0.5%5Cs%5Cx", "/%5CWindows%5Cwin.ini", "//%5C%5Chost%5Cs", "/%2e/index.html"] {
        assert!(preview::resolve(&dir, raw).is_none(), "{raw}");
    }
    assert!(preview::resolve(&dir, "/").is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn review2_a_late_smoke_result_never_fails_and_clears_the_flags() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    running(&mut h, "b-a");
    let token = h.begin_smoke("b-a", true).unwrap();
    h.get_mut("b-a").unwrap().committing = true;
    // Nic sent it to Repair while the check ran.
    h.to_repair("b-a", "sent by Nic", "", vec![], false, 30).unwrap();
    assert_eq!(h.fold_smoke("b-a", token, smoke_fail("body"), 31).unwrap(), Some(Status::RepairQueue));
    let b = h.get("b-a").unwrap();
    assert!(!b.smoke.running && !b.committing);
    assert_eq!(b.smoke.failures, 0, "a stale check doesn't count against the build");
    assert!(b.smoke.last.is_some());
    // Requeue also clears committing.
    h.get_mut("b-a").unwrap().committing = true;
    h.requeue("b-a", None, 32, &[]).unwrap();
    assert!(!h.get("b-a").unwrap().committing);
}

#[test]
fn review3_24_a_build_stuck_in_smoke_testing_is_recovered_on_load() {
    let dir = std::env::temp_dir().join(format!("buildhub-recover-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut f = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder)]);
    running(&mut f, "b-a");
    {
        let b = f.get_mut("b-a").unwrap();
        b.smoke.running = true; // the app exited mid-check
        b.committing = true;
    }
    std::fs::write(dir.join(HUB_FILE), serde_json::to_vec(&f).unwrap()).unwrap();
    let st = HubState::default();
    st.init(&dir);
    let mut snap = st.snapshot();
    {
        let b = snap.get("b-a").unwrap();
        assert!(!b.smoke.running && !b.committing);
        assert_eq!(b.envelope.status, Status::SmokeTesting);
    }
    assert_eq!(snap.needs_smoke(), vec!["b-a".to_string()], "the hub loop re-runs its check");
    // Once the re-run check lands, the lane moves on.
    snap.record_smoke("b-a", smoke_pass(), 40).unwrap();
    assert_eq!(snap.next_for(Lane::Worker).as_deref(), Some("b-b"));
    let _ = std::fs::remove_dir_all(&dir);
}


#[test]
fn review6_23_no_hub_command_runs_on_the_main_thread() {
    // Normalised: a Windows checkout (core.autocrlf) gives CRLF here.
    let src = include_str!("../buildhub.rs").replace("\r\n", "\n");
    let lines: Vec<&str> = src.lines().collect();
    let mut n = 0;
    for (i, l) in lines.iter().enumerate() {
        if l.trim() == "#[tauri::command]" {
            n += 1;
            let next = lines[i + 1].trim();
            assert!(next.starts_with("pub async fn "), "sync command (runs on the UI thread): {next}");
        }
    }
    assert!(n >= 18, "found {n} commands");
    // build_smoke runs the check through the blocking pool.
    let smoke_cmd = &src[src.find("pub async fn build_smoke").unwrap()..];
    let body = &smoke_cmd[..smoke_cmd.find("\n}\n").unwrap()];
    assert!(body.contains("blocking(move || Ok(smoke::run("), "{body}");
}

#[test]
fn review4_release_cancels_a_live_worker_task_and_hold_keeps_repair_paused() {
    assert!(hold_worker(Status::Paused) && hold_worker(Status::RepairQueue));
    assert!(!hold_worker(Status::Building) && !hold_worker(Status::Queued));
    let store = TaskStore::in_memory();
    let args = super::super::taskworker::CreateArgs { raw_intent: "build x".into(), title: Some("x".into()), thread: None, source: "playplace".into(), idea_id: None, options: None, dedupe_key: Some("k-release".into()), project_slug: None };
    let (t, _) = super::super::taskworker::create_task(&store, &args, 3, &[]).unwrap();
    envelope::set_paused(&t.task_id, true);
    assert!(release_worker_task(&store, &t.task_id, &[]), "a live task is cancelled");
    let e = store.with(|c| envelope::get_bare(c, &t.task_id)).unwrap().unwrap();
    assert_eq!(e.status, "failed");
    assert!(!envelope::is_paused(&t.task_id));
    assert!(store.with(|c| envelope::claim_next(c, envelope::now_ms(), 60_000)).unwrap().is_none(), "nothing left for the worker to run");
    assert!(!release_worker_task(&store, &t.task_id, &[]), "a terminal task is left alone");
}

#[test]
fn review5_34_claude_pause_never_reopens_finished_work() {
    assert_eq!(claude_pause_target("Queued").unwrap(), Some("Pending"));
    assert_eq!(claude_pause_target("Pending").unwrap(), Some("Pending"));
    assert_eq!(claude_pause_target("Done").unwrap(), None);
    assert!(claude_pause_target("In Progress").is_err());
    assert_eq!(claude_resume_target("Pending"), Some("Queued"));
    assert_eq!(claude_resume_target("Done"), None);
    // Paused at the smoke checkpoint → resumes there, and the loop re-runs the check.
    let mut h = hub_with(&[("b-c", AssignedWorker::Claude)]);
    {
        let b = h.get_mut("b-c").unwrap();
        b.dev_task_id = Some("d1".into());
        b.envelope.status = Status::SmokeTesting;
    }
    h.pause("b-c", 1).unwrap();
    h.resume("b-c", 2).unwrap();
    assert_eq!(h.get("b-c").unwrap().envelope.status, Status::SmokeTesting);
    assert_eq!(h.needs_smoke(), vec!["b-c".to_string()]);
}

#[test]
fn review16_intake_takes_the_gpu_baton_and_falls_back_when_busy() {
    tauri::async_runtime::block_on(async {
        let slot = super::super::scheduler::GpuSlot::default();
        let held = slot.acquire("Tony", true, 90).await;
        assert!(intake_slot(&slot, 90, Duration::from_millis(150)).await.is_none(), "busy: standard questions, no queueing");
        drop(held);
        let g = intake_slot(&slot, 90, Duration::from_millis(500)).await;
        assert!(g.is_some());
        assert!(!slot.is_idle(), "the intake holds the baton while it asks");
    });
}

#[test]
fn review20_30_peek_watches_and_late_output() {
    let mut w = PeekWatches::default();
    w.watch("b-a");
    w.unwatch("b-a"); // closed while the open call was still probing
    assert!(!w.commit("b-a", true, 1), "a late open can't re-add a closed peek");
    assert!(w.ids().is_empty());
    w.watch("b-a");
    assert!(w.commit("b-a", false, 2));
    w.update("b-a", true, 3);
    assert_eq!(w.get("b-a"), Some((true, 3)));
    // A watched peek gets its server as soon as the output folder appears.
    assert!(!should_start_preview(None, false, false));
    assert!(should_start_preview(None, false, true));
    assert!(!should_start_preview(None, true, true));
    assert!(!should_start_preview(Some("http://127.0.0.1:5173/"), false, true));
}

#[test]
fn review7_claude_item_binds_only_to_a_build_still_waiting() {
    let mut h = hub_with(&[("b-c", AssignedWorker::Claude)]);
    assert!(h.bind_dev("b-c", "d1", 1).unwrap());
    assert!(!h.bind_dev("b-c", "d2", 2).unwrap(), "already bound");
    assert_eq!(h.get("b-c").unwrap().dev_task_id.as_deref(), Some("d1"));
    assert!(!h.bind_dev("b-gone", "d3", 3).unwrap(), "removed meanwhile: the caller deletes the orphan item");
    let mut h = hub_with(&[("b-p", AssignedWorker::Claude)]);
    h.pause("b-p", 1).unwrap();
    assert!(!h.bind_dev("b-p", "d4", 2).unwrap(), "paused meanwhile");
}

#[test]
fn review33_steer_on_a_mid_run_claude_build_says_when_it_applies() {
    let mut h = hub_with(&[("b-c", AssignedWorker::Claude)]);
    h.get_mut("b-c").unwrap().envelope.status = Status::Building;
    h.steer("b-c", "dark mode", 1, &[]).unwrap();
    assert!(h.get("b-c").unwrap().logs.iter().any(|l| l.text.contains("next hand-off")));
}

#[test]
fn review18_promote_drops_the_live_widget_preview() {
    let dir = std::env::temp_dir().join(format!("buildhub-evict-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "x").unwrap();
    tauri::async_runtime::block_on(async {
        let mut map = HashMap::new();
        map.insert("b-a#widget".to_string(), preview::start(dir.clone()).await.unwrap());
        map.insert("b-a".to_string(), preview::start(dir.clone()).await.unwrap());
        assert_eq!(evict_previews(&mut map, "b-a", true), 1, "promote drops only the widget server");
        assert!(map.contains_key("b-a") && !map.contains_key("b-a#widget"));
        assert_eq!(evict_previews(&mut map, "b-a", false), 1, "remove drops the rest");
        assert!(map.is_empty());
    });
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Thoughtform pipeline hardening (regressions) ──

/// Regression: the hub's dedupe key used '#', which the task store rejects
/// (`[A-Za-z0-9-_.:]` only), so EVERY Coder / Designer hub build failed to reach the worker.
#[test]
fn a_hub_hand_off_creates_its_worker_task_in_the_hubs_folder() {
    let store = TaskStore::in_memory();
    let h = hub_with(&[("b-tip", AssignedWorker::Coder)]);
    let b = h.get("b-tip").unwrap();
    let args = super::super::taskworker::CreateArgs {
        raw_intent: worker_brief(b),
        title: Some(b.envelope.title.clone()),
        thread: Some("auto".into()),
        source: "playplace".into(),
        idea_id: None,
        options: Some(json!({})),
        dedupe_key: Some(worker_dedupe_key(&b.envelope.build_id, now_ms())),
        project_slug: Some(b.envelope.project_slug.clone()),
    };
    let (t, created) = super::super::taskworker::create_task(&store, &args, 3, &[]).expect("the hub's dedupe key is accepted");
    assert!(created);
    assert_eq!(t.project_slug.as_deref(), Some(b.envelope.project_slug.as_str()), "a repair pass reuses the hub's folder");
    assert_eq!(t.raw_intent.memory_reference["thread"], "auto");
}

/// Regression: the contract (target runtime, acceptance criteria) was appended AFTER an up to
/// 8000-char brief and then cut off; the worker's Prompter only reads the head of the request.
#[test]
fn the_contract_leads_the_worker_brief_even_with_a_full_brief() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    h.get_mut("b-a").unwrap().brief = format!("Intake interview:\n- What does done look like? → MUST work offline\n\n{}", "note text ".repeat(BRIEF_MAX / 9));
    let s = worker_brief(h.get("b-a").unwrap());
    assert!(s.chars().count() <= BRIEF_MAX);
    assert!(s.starts_with("BUILD CONTRACT"), "{}", &s[..60]);
    assert!(s.contains("INTERNAL WIDGET") && s.contains("- Renders"));
    assert!(s.contains("MUST work offline"), "the interview answers come right after the contract");
    assert!(s.contains("[…brief truncated to fit…]"), "a cut is marked");
    let head: String = s.chars().take(super::super::taskworker::RAW_IN).collect();
    assert!(head.contains("Acceptance criteria") && head.contains("MUST work offline"), "the Prompter's window holds the contract and answers");
    // Short briefs are untouched apart from the order.
    let h = hub_with(&[("b-b", AssignedWorker::Coder)]);
    assert!(worker_brief(h.get("b-b").unwrap()).ends_with("brief"));
}

/// Regression: the Claude item body (capped at 8000) lost the output path and every HUMAN
/// OVERRIDE (including the auto smoke-repair directive) because they were appended last.
#[test]
fn the_claude_brief_keeps_destination_and_overrides_first() {
    let mut h = hub_with(&[("b-c", AssignedWorker::Claude)]);
    h.get_mut("b-c").unwrap().brief = "x".repeat(9000);
    h.steer("b-c", "dark theme only", 1, &[]).unwrap();
    let s = claude_brief(h.get("b-c").unwrap());
    assert!(s.chars().count() <= CLAUDE_BODY_MAX);
    assert!(s.starts_with("Write the result to:") && s.contains("index.html"));
    assert!(s.contains("HUMAN OVERRIDES (highest priority):\n- dark theme only"));
    assert!(s.contains("BUILD CONTRACT"));
}

/// Regression: a steer on a ready-for-merge / smoke-testing build was accepted and sat
/// "⏳ next step" forever (no agent step runs again).
#[test]
fn steer_is_refused_once_no_agent_step_will_run() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    for s in [Status::ReadyForMerge, Status::SmokeTesting, Status::RepairQueue] {
        h.get_mut("b-a").unwrap().envelope.status = s;
        let err = h.steer("b-a", "bigger buttons", 1, &[]).unwrap_err();
        assert!(err.contains("Repair"), "{err}");
    }
    assert!(h.get("b-a").unwrap().envelope.human_override.is_empty());
}

/// Regression: a failure while paused was counted, and the Resume re-check counted the same
/// output again: the build skipped its automatic repair pass and went straight to repair.
#[test]
fn a_smoke_failure_while_paused_is_counted_once_after_resume() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    running(&mut h, "b-a");
    h.pause("b-a", 21).unwrap();
    assert_eq!(h.record_smoke("b-a", smoke_fail("body"), 22).unwrap(), Status::Paused);
    assert_eq!(h.get("b-a").unwrap().smoke.failures, 0);
    h.resume("b-a", 23).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::SmokeTesting);
    assert_eq!(h.record_smoke("b-a", smoke_fail("body"), 24).unwrap(), Status::Queued, "the one automatic repair pass");
    assert_eq!(h.get("b-a").unwrap().smoke.failures, 1);
}

/// Regression: the worker task was created before the bind and never undone, so a build removed
/// / paused meanwhile left an unowned task running.
#[test]
fn a_worker_task_binds_only_to_a_build_still_waiting_for_it() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-p", AssignedWorker::Coder)]);
    assert!(h.bind_worker("b-a", "t-1", 1).unwrap());
    assert_eq!(h.get("b-a").unwrap().worker_task_id.as_deref(), Some("t-1"));
    assert!(!h.bind_worker("b-a", "t-2", 2).unwrap(), "already bound");
    assert!(!h.bind_worker("b-gone", "t-3", 3).unwrap(), "removed meanwhile");
    h.pause("b-p", 4).unwrap();
    assert!(!h.bind_worker("b-p", "t-4", 5).unwrap(), "paused meanwhile");
    let store = TaskStore::in_memory();
    let args = super::super::taskworker::CreateArgs { raw_intent: "build x".into(), source: "playplace".into(), dedupe_key: Some("k-orphan".into()), ..Default::default() };
    let (t, _) = super::super::taskworker::create_task(&store, &args, 3, &[]).unwrap();
    let e = release_worker_task_env(&store, &t.task_id, &[]).expect("the orphan is cancelled");
    assert_eq!(e.status, "failed");
}

/// Regression: rows the task committed after review_ready (Read-report discrepancies, card
/// created) never reached the card log once the build moved to the smoke checkpoint.
#[test]
fn late_worker_rows_still_reach_the_card_log() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    running(&mut h, "b-a");
    let before = h.get("b-a").unwrap().logs.len();
    let row = WorkerRow { seq: 50, at: 30, event_type: "discrepancy".into(), severity: "milestone".into(), from: "librarian".into(), to: "tony".into(), text: "Read-report: x is missing".into(), stage: Some("done".into()) };
    let w = WorkerSnap { status: "review_ready".into(), rows: vec![row], ..Default::default() };
    assert_eq!(h.apply_rows("b-a", &w).unwrap(), 1);
    assert_eq!(h.apply_rows("b-a", &w).unwrap(), 0, "never twice");
    let b = h.get("b-a").unwrap();
    assert_eq!(b.logs.len(), before + 1);
    assert!(b.logs.last().unwrap().text.contains("Read-report"));
    assert_eq!(b.envelope.status, Status::SmokeTesting, "rows only: no status effect");
}

/// Regression: the preview server was cached by build id and never re-checked, so Live Peek kept
/// serving the first folder after the output moved.
#[test]
fn a_preview_on_a_moved_output_folder_is_stale() {
    assert!(!preview_is_stale(Path::new(r"D:\x\staging\tip"), Path::new("d:/x/staging/tip/")));
    assert!(preview_is_stale(Path::new(r"D:\x\staging\tip"), Path::new(r"D:\x\staging\tip-2")));
}

/// Regression: a Claude run that ended without Done (item back to Queued) left the card
/// "working" forever, the failure note unseen, and the Claude lane blocked.
#[test]
fn an_unfinished_claude_run_is_detected_with_its_note() {
    assert!(claude_run_failed("Queued", Status::Building));
    assert!(!claude_run_failed("Queued", Status::Queued), "not started yet");
    assert!(!claude_run_failed("In Progress", Status::Building));
    assert_eq!(claude_note(&json!({ "note": "verify failed:\n 2 tests" })).as_deref(), Some("verify failed: 2 tests"));
    assert_eq!(claude_note(&json!({})), None);
    // Its output lands in the gitignored staging folder (the run calls that "no changes"): a
    // fresh index.html there is the output, smoke-tested instead of failed.
    assert!(claude_output_ready(Some(2_000), Some(1_000)));
    assert!(!claude_output_ready(Some(500), Some(1_000)), "a stale file from before the run");
    assert!(!claude_output_ready(None, Some(1_000)));
}

/// Regression: Remove / Repair left the build's waiting Dev Fix item queued, so Claude could
/// still build a dropped build and a re-queue made a second item.
#[test]
fn a_dropped_builds_waiting_dev_item_is_deleted() {
    assert_eq!(dev_item_release("Queued"), DevItemRelease::Delete);
    assert_eq!(dev_item_release("Pending"), DevItemRelease::Delete);
    assert_eq!(dev_item_release("In Progress"), DevItemRelease::Running);
    assert_eq!(dev_item_release("Done"), DevItemRelease::Keep);
}

/// Regression: the smoke test checked every inline script as a strict ES module and only
/// skipped a few types, failing valid pages (GLSL shaders, JSON-LD, sloppy classic scripts).
#[test]
fn smoke_checks_only_real_javascript_with_the_right_goal() {
    let scripts = r#"<script type="x-shader/x-fragment">void main(){ gl_FragColor = vec4(1.0); }</script>
<script type="application/ld+json">{"@type":"Thing"}</script>
<script data-src="lazy.js">var package = 1; with (Math) { max(1, 2); }</script>
<script type="module">export const a = 1;</script>"#;
    let s = smoke::inline_scripts_typed(scripts);
    assert_eq!(s.len(), 2, "{s:?}");
    assert!(s[0].0.starts_with("var package") && !s[0].1, "data-src is not src; classic script");
    assert!(s[1].1, "type=module is a module");
    assert!(smoke::inline_scripts(r#"<script src="a.js"></script>"#).is_empty());
    // End to end (when Node is on PATH): a sloppy classic script and a shader pass the check.
    let dir = std::env::temp_dir().join(format!("buildhub-sloppy-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), format!("<!doctype html><html><head><title>t</title></head><body><h1>A widget with a shader and a classic script</h1>{scripts}</body></html>")).unwrap();
    let r = smoke::run(&dir, Runtime::InternalWidget, 1);
    assert!(!r.failed_assertions.iter().any(|f| f.starts_with("script-syntax")), "{:?}", r.failed_assertions);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Regression: status on demand read tasks.db only, so a build in the Repair Queue was reported
/// as "ready for review" and an idle worker said "No builds in progress." over a queued build.
#[test]
fn status_on_demand_reports_the_hubs_state() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder)]);
    h.get_mut("b-a").unwrap().worker_task_id = Some("t-a".into());
    h.to_repair("b-a", "failed the smoke test 2 times", "", vec![], true, 1).unwrap();
    let v = status_with_hub(json!({ "text": "\"Build slug-0\" is ready for review in staging/slug-0.", "task_id": "t-a" }), &h, None);
    assert!(v["text"].as_str().unwrap().contains("Repair Queue: failed the smoke test 2 times"), "{v}");
    let v = status_with_hub(json!({ "text": "No builds in progress.", "task_id": null }), &h, None);
    let t = v["text"].as_str().unwrap();
    assert!(t.contains("Build slug-1") && t.contains("queued"), "{t}");
    h.get_mut("b-b").unwrap().envelope.status = Status::SmokeTesting;
    let v = status_with_hub(json!({ "text": "I don't have a build with that name.", "task_id": null }), &h, Some("slug-1"));
    assert!(v["text"].as_str().unwrap().contains("smoke-tested"));
}

/// Regression: smoke outcomes (pass / repair pass / Repair Queue) never reached the chat.
#[test]
fn smoke_outcomes_have_a_chat_line() {
    assert_eq!(smoke_outcome_line("Tip", Status::ReadyForMerge, &[]).unwrap().0, "milestone");
    let (sev, l) = smoke_outcome_line("Tip", Status::Queued, &["body: boom".into()]).unwrap();
    assert!(sev == "milestone" && l.contains("body: boom") && l.contains("repair pass"));
    assert_eq!(smoke_outcome_line("Tip", Status::RepairQueue, &["x".into()]).unwrap().0, "critical");
    assert!(smoke_outcome_line("Tip", Status::Paused, &[]).is_none());
}

#[test]
fn review_feed1_a_hub_record_opens_the_hub_card_so_nested_runs_never_vanish() {
    // A build queued before the feed existed (or dispatched before build_enqueue opened its card):
    // no hub conversation yet. The hand-off must open it, nest the worker task under it, and land.
    let s = tr::TranscriptStore::in_memory();
    let e = env("b-old", "old-slug", Runtime::InternalWidget, AssignedWorker::Coder);
    let child = OpenConv { conv_id: tr::task_conv("t-1"), kind: "task", title: "pass".into(), thread: Some("auto".into()), ..Default::default() };
    nest_under_hub_in(&s, &e, child, &[]);
    hub_record_in(&s, &e, Some(Status::Building), NewMessage::new("staging", "prompter", "handoff", "Pass 1 handed to the agent pipeline").body("brief"), &[]);
    hub_record_in(&s, &e, None, NewMessage::new("nic", "coder", "override", "Steer: bigger buttons").body("bigger buttons"), &[]);
    let roots = s.list(50, None, true).unwrap();
    assert_eq!(roots.len(), 1, "the hub card is a root; the task nests under it");
    assert_eq!(roots[0].conv_id, tr::hub_conv("b-old"));
    let page = s.page(&tr::hub_conv("b-old"), None, 50).unwrap().expect("hub conversation exists");
    assert_eq!(page.messages.len(), 2, "the hand-off and the steer both landed");
    assert_eq!(page.children.len(), 1);
    assert_eq!(page.children[0].conv_id, tr::task_conv("t-1"));
}

#[test]
fn review_feed3_hub_records_scrub_the_known_values() {
    let s = tr::TranscriptStore::in_memory();
    let e = env("b-sec", "sec-slug", Runtime::InternalWidget, AssignedWorker::Claude);
    let known = vec!["SYNTH-NOTE-VALUE-7731".to_string()];
    let dev = OpenConv { conv_id: tr::dev_conv("d-1"), kind: "dev", title: "x".into(), thread: Some("auto".into()), ..Default::default() };
    nest_under_hub_in(&s, &e, dev, &known);
    hub_record_in(&s, &e, None, NewMessage::new("nic", "claude", "override", "Steer: use SYNTH-NOTE-VALUE-7731").body("token SYNTH-NOTE-VALUE-7731 here"), &known);
    hub_record_in(&s, &e, Some(Status::RepairQueue), NewMessage::new("staging", "tony", "repair", "repair").body("trace with SYNTH-NOTE-VALUE-7731").failed(), &known);
    let page = s.page(&tr::hub_conv("b-sec"), None, 50).unwrap().unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.children.len(), 1);
    for h in &page.messages {
        assert!(!h.summary.contains("SYNTH-NOTE-VALUE-7731"));
        let full = s.message(h.seq).unwrap().unwrap();
        assert!(!full.body.contains("SYNTH-NOTE-VALUE-7731"), "known value persisted: {}", full.body);
    }
}

// ── Review round 2 ──

#[test]
fn round2_smoke_tokens_a_stale_check_never_overwrites_a_newer_one() {
    let mut h = hub_with(&[("b-x", AssignedWorker::Coder)]);
    {
        let b = h.get_mut("b-x").unwrap();
        b.envelope.target_runtime = Runtime::ExternalOs;
        b.worker_task_id = Some("t".into());
        b.envelope.status = Status::SmokeTesting;
    }
    let bg = h.begin_smoke("b-x", true).unwrap(); // background check, still copying files
    assert!(h.get("b-x").unwrap().committing);
    let manual = h.begin_smoke("b-x", false).unwrap(); // Nic's "Re-run check" while it runs
    assert_eq!(h.fold_smoke("b-x", manual, smoke_pass(), 10).unwrap(), Some(Status::ReadyForMerge));
    {
        let b = h.get("b-x").unwrap();
        assert!(b.committing && b.smoke.running, "the manual check never clears the background copy's flags");
    }
    // The older background check lands late with a failure: discarded, nothing regresses.
    assert_eq!(h.fold_smoke("b-x", bg, smoke_fail("body"), 11).unwrap(), None);
    let b = h.get("b-x").unwrap();
    assert_eq!(b.envelope.status, Status::ReadyForMerge);
    assert!(b.smoke.last.as_ref().unwrap().passed, "Ready for merge never sits on a failed report");
    assert!(!b.committing && !b.smoke.running, "its owner cleared the flags");
    assert!(h.clone().promote("b-x", 12).is_ok());
}

#[test]
fn round2_a_check_from_before_a_requeue_can_not_land_as_the_new_runs_result() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    running(&mut h, "b-a");
    let old = h.begin_smoke("b-a", true).unwrap();
    h.to_repair("b-a", "sent by Nic", "", vec![], false, 1).unwrap();
    h.requeue("b-a", None, 2, &[]).unwrap();
    running(&mut h, "b-a");
    let new = h.begin_smoke("b-a", true).unwrap();
    assert!(new > old);
    assert_eq!(h.fold_smoke("b-a", old, smoke_pass(), 3).unwrap(), None);
    let b = h.get("b-a").unwrap();
    assert_eq!(b.envelope.status, Status::SmokeTesting);
    assert!(b.smoke.running, "the new run still owns its flags");
    assert_eq!(h.fold_smoke("b-a", new, smoke_pass(), 4).unwrap(), Some(Status::ReadyForMerge));
}

#[test]
fn round2_steer_on_a_build_paused_at_a_checkpoint_is_refused_with_a_reason() {
    let mut h = hub_with(&[("b-c", AssignedWorker::Claude)]);
    {
        let b = h.get_mut("b-c").unwrap();
        b.dev_task_id = Some("d1".into());
        b.envelope.status = Status::SmokeTesting;
    }
    h.pause("b-c", 1).unwrap();
    let err = h.steer("b-c", "dark mode", 2, &[]).unwrap_err();
    assert!(err.contains("paused smoke testing") && err.contains("Repair"), "{err}");
    assert!(h.get("b-c").unwrap().envelope.human_override.is_empty());
    // Paused mid-build is still steerable: the next step will run.
    let mut h = hub_with(&[("b-w", AssignedWorker::Coder)]);
    h.get_mut("b-w").unwrap().envelope.status = Status::Building;
    h.pause("b-w", 1).unwrap();
    assert!(h.steer("b-w", "bigger buttons", 2, &[]).is_ok());
}

#[test]
fn round2_claude_lane_overrides_are_marked_delivered_and_midrun_is_said_once() {
    let mut h = hub_with(&[("b-c", AssignedWorker::Claude)]);
    h.steer("b-c", "dark mode", 5, &[]).unwrap();
    assert_eq!(h.get("b-c").unwrap().envelope.human_override[0].applied_at, None);
    h.mark_delivered("b-c", 9, "claude hand-off").unwrap();
    let o = &h.get("b-c").unwrap().envelope.human_override[0];
    assert_eq!((o.applied_at, o.applied_stage.as_deref()), (Some(9), Some("claude hand-off")));
    // Item In Progress while the hub still says Queued: the steer is logged, once.
    h.steer("b-c", "and a footer", 10, &[]).unwrap();
    h.note_claude_midrun("b-c", 11).unwrap();
    h.note_claude_midrun("b-c", 12).unwrap();
    let n = h.get("b-c").unwrap().logs.iter().filter(|l| l.text.starts_with("Claude Code is mid-run")).count();
    assert_eq!(n, 1);
}

#[test]
fn round2_external_slug_picks_a_free_suffix_instead_of_refusing() {
    let base = std::env::temp_dir().join(format!("buildhub-slug-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(base.join("tip-calc")).unwrap(); // a removed build's folder stays
    let mut h = HubFile::default();
    assert_eq!(free_external_slug("tip-calc", &base, &h, path_taken).unwrap(), "tip-calc-2");
    // A slug a hub build still holds (even deployed, whose folder may be gone) is never reused.
    h.enqueue(env("b-d", "tip-calc-2", Runtime::ExternalOs, AssignedWorker::Coder), "".into(), vec![], 1).unwrap();
    assert_eq!(free_external_slug("tip-calc", &base, &h, path_taken).unwrap(), "tip-calc-3");
    assert!(path_taken(&base.join("tip-calc")));
    assert!(!path_taken(&base.join("nope")));
    let _ = std::fs::remove_dir_all(&base);
}

fn temp_hub(tag: &str) -> (HubState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("buildhub-{tag}-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let st = HubState::default();
    st.init(&dir);
    (st, dir)
}

#[test]
fn round2_enqueue_staged_real_ordering_and_rollback() {
    let (st, dir) = temp_hub("enq");
    let base = dir.join("ext");
    let mk = |id: &str| {
        let mut e = env(id, "tip-calc", Runtime::ExternalOs, AssignedWorker::Coder);
        e.output_directory = base.join("tip-calc").display().to_string();
        e
    };
    // 1. Success: the scaffold runs INSIDE the hub transaction (the pass loop can't dispatch the
    //    build before its folder exists), and the enqueue is persisted.
    let got = enqueue_staged(&st, mk("b-1"), "brief".into(), vec![], &base, 1, |e| {
        assert!(st.file.try_lock().is_err(), "scaffold runs under the hub lock");
        scaffold_external(e)
    })
    .unwrap();
    assert_eq!(got.project_slug, "tip-calc");
    assert!(base.join("tip-calc").join("README.md").is_file());
    let saved: HubFile = serde_json::from_str(&std::fs::read_to_string(dir.join(HUB_FILE)).unwrap()).unwrap();
    assert!(saved.get("b-1").is_some());
    // 2. The same title while that build is in flight: refused with the "already staged"
    //    message, before any scaffold.
    let err = enqueue_staged(&st, mk("b-2"), "".into(), vec![], &base, 2, |_| panic!("must not scaffold")).unwrap_err();
    assert!(err.contains("already staged"), "{err}");
    // 3. Once that build is removed, its folder stays: the re-push gets a free suffixed slug.
    st.with(|f| f.remove("b-1").map(|_| ())).unwrap();
    let again = enqueue_staged(&st, mk("b-3"), "".into(), vec![], &base, 3, scaffold_external).unwrap();
    assert_eq!(again.project_slug, "tip-calc-2");
    assert_eq!(PathBuf::from(&again.output_directory), base.join("tip-calc-2"));
    assert_eq!(st.snapshot().get("b-3").unwrap().envelope.project_slug, "tip-calc-2");
    // 4. A failing scaffold rolls everything back: no build, no folder, nothing persisted.
    let err = enqueue_staged(&st, mk("b-4"), "".into(), vec![], &base, 4, |e| {
        std::fs::create_dir_all(&e.output_directory).unwrap();
        Err("disk full".into())
    })
    .unwrap_err();
    assert_eq!(err, "disk full");
    assert!(st.snapshot().get("b-4").is_none());
    assert!(!base.join("tip-calc-3").exists());
    let saved: HubFile = serde_json::from_str(&std::fs::read_to_string(dir.join(HUB_FILE)).unwrap()).unwrap();
    assert!(saved.get("b-4").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn round2_intake_call_holds_the_baton_and_a_timeout_keeps_it_settling() {
    use std::sync::atomic::{AtomicBool, Ordering};
    tauri::async_runtime::block_on(async {
        let slot = super::super::scheduler::GpuSlot::default();
        // Busy: the call never runs.
        let held = slot.acquire("Tony", true, 90).await;
        let ran = AtomicBool::new(false);
        let r = ask_in_slot(&slot, 90, Duration::from_millis(120), Duration::from_millis(400), || async {
            ran.store(true, Ordering::SeqCst);
            Ok("x".to_string())
        })
        .await;
        assert!(r.is_none() && !ran.load(Ordering::SeqCst));
        drop(held);
        // A clean answer releases the baton at once.
        let r = ask_in_slot(&slot, 90, Duration::from_millis(500), Duration::from_millis(400), || async {
            assert!(!slot.is_idle(), "the call runs inside the baton");
            Ok("q".to_string())
        })
        .await;
        assert_eq!(r.as_deref(), Some("q"));
        assert!(slot.is_idle());
        // A timeout: the baton settles before the next holder (LM Studio may still be generating).
        let r = ask_in_slot(&slot, 90, Duration::from_millis(500), Duration::from_millis(400), || async { Err(true) }).await;
        assert!(r.is_none());
        assert!(!slot.is_idle(), "still settling right after the timeout");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(slot.is_idle());
        // Any other failure: released at once.
        let r = ask_in_slot(&slot, 90, Duration::from_millis(500), Duration::from_millis(400), || async { Err(false) }).await;
        assert!(r.is_none() && slot.is_idle());
    });
    // build_intake_questions goes through it, and checks the provider before taking the baton.
    let src = include_str!("../buildhub.rs");
    let body = &src[src.find("pub async fn build_intake_questions").unwrap()..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let (prov, ask) = (body.find("provider(\"lmstudio\")").unwrap(), body.find("ask_in_slot(").unwrap());
    assert!(prov < ask, "provider check first");
    assert!(!body.contains("intake_slot("), "no un-armed baton path left");
}

#[test]
fn round2_peek_watches_are_ref_counted_in_any_order() {
    // React StrictMode: open, close, open — the close may land first or last.
    for order in [["w", "u", "w"], ["u", "w", "w"], ["w", "w", "u"]] {
        let mut w = PeekWatches::default();
        for op in order {
            if op == "w" { w.watch("b-a") } else { w.unwatch("b-a") }
        }
        assert!(w.watched("b-a"), "{order:?}: one Peek is really open");
        assert!(w.commit("b-a", true, 1));
        w.unwatch("b-a");
        assert!(!w.watched("b-a") && w.get("b-a").is_none(), "{order:?}: closed for good");
    }
    let mut w = PeekWatches::default();
    w.watch("b-a");
    w.watch("b-a");
    w.forget("b-a"); // the build was removed
    assert!(w.ids().is_empty());
}

// ── Cancel / Delete ──

#[test]
fn cancel_stops_for_good_and_hands_back_the_bound_work() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Claude)]);
    assert!(h.bind_worker("b-a", "t-1", 5).unwrap());
    h.get_mut("b-a").unwrap().envelope.status = Status::Building;
    h.get_mut("b-a").unwrap().smoke.running = true;
    let bound = h.cancel("b-a", "cancelled by Nic", 9).unwrap();
    assert_eq!(bound, (Some("t-1".into()), None));
    let b = h.get("b-a").unwrap();
    assert_eq!(b.envelope.status, Status::Cancelled);
    assert!(b.worker_task_id.is_none() && !b.smoke.running && b.paused_from.is_none());
    assert_eq!(b.finished_at, Some(9));
    assert!(b.logs.last().unwrap().text.contains("Cancelled"));
    // Not in flight any more: the lane hands the next build out.
    assert!(!HubFile::in_flight(b));
    assert_eq!(status_str(Status::Cancelled), "cancelled");
    assert!(hold_worker(Status::Cancelled));
    // Twice is an error; so is a deployed build.
    assert!(h.cancel("b-a", "again", 10).is_err());
    h.get_mut("b-b").unwrap().envelope.status = Status::Deployed;
    assert!(h.cancel("b-b", "x", 10).is_err());
}

#[test]
fn a_cancelled_build_is_removable_requeueable_and_swept_by_clear_failed() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder), ("b-c", AssignedWorker::Coder)]);
    assert!(h.bind_worker("b-a", "t-1", 5).unwrap());
    h.get_mut("b-a").unwrap().envelope.status = Status::Building;
    // Running: Remove alone refuses (Delete cancels first).
    assert!(h.remove("b-a").is_err());
    h.cancel("b-a", "x", 6).unwrap();
    h.to_repair("b-b", "sent by Nic", "", vec![], false, 7).unwrap();
    let mut failed = h.failed_ids();
    failed.sort();
    assert_eq!(failed, vec!["b-a".to_string(), "b-b".to_string()]);
    // Re-queue works from Cancelled (fresh pass, unbound) …
    h.requeue("b-a", Some("try again"), 8, &[]).unwrap();
    let b = h.get("b-a").unwrap();
    assert_eq!(b.envelope.status, Status::Queued);
    assert!(b.logs.last().unwrap().text.contains("after a cancel"));
    // … and a cancelled build can be removed.
    h.cancel("b-c", "x", 9).unwrap();
    assert!(h.remove("b-c").is_ok());
    assert!(h.get("b-c").is_none());
}

#[test]
fn delete_purges_only_the_hubs_own_folder() {
    let staging = Path::new(STAGING);
    let ext = Path::new(EXT);
    let e = env("b-1", "tip-calc", Runtime::InternalWidget, AssignedWorker::Coder);
    assert_eq!(purgeable_dir(&e, staging, ext), Some(staging.join("tip-calc")));
    let x = env("b-2", "tip-calc", Runtime::ExternalOs, AssignedWorker::Claude);
    assert_eq!(purgeable_dir(&x, staging, ext), Some(ext.join("tip-calc")));
    // Pointing anywhere else (edited by hand, or a root): never deleted.
    let mut moved = e.clone();
    moved.output_directory = r"C:\Users\nic\Documents".into();
    assert_eq!(purgeable_dir(&moved, staging, ext), None);
    for bad in ["", ".", "..", r"..\..\Windows", "a/b", "C:"] {
        let mut b = e.clone();
        b.project_slug = bad.into();
        b.output_directory = staging.join(bad).display().to_string();
        assert_eq!(purgeable_dir(&b, staging, ext), None, "slug {bad:?}");
    }
    assert_eq!(purgeable_dir(&e, Path::new(""), ext), None);
}

#[test]
fn orphan_reaper_targets_only_unbound_live_hub_tasks() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    assert!(h.bind_worker("b-a", "t-bound", 1).unwrap());
    assert!(is_orphan("t-lost", "queued", Some("b-gone:1700000000000"), &h));
    assert!(!is_orphan("t-bound", "queued", Some("b-a:1700000000000"), &h), "bound to a build");
    assert!(!is_orphan("t-done", "failed", Some("b-gone:1"), &h), "already terminal");
    assert!(!is_orphan("t-chat", "queued", Some("idea-42"), &h), "not a hub task");
    assert!(!is_orphan("t-none", "queued", None, &h));
    assert!(!is_orphan("t-odd", "queued", Some("b-x:"), &h));
}

#[test]
fn cancelled_status_round_trips_on_the_wire() {
    let mut e = env("b-1", "x", Runtime::InternalWidget, AssignedWorker::Coder);
    e.status = Status::Cancelled;
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["status"], "cancelled");
    assert_eq!(serde_json::from_value::<TaskEnvelope>(v).unwrap().status, Status::Cancelled);
}

// ── Rework from the dashboard ──

fn promoted(h: &mut HubFile, id: &str) {
    running(h, id);
    h.record_smoke(id, smoke_pass(), 30).unwrap();
    h.promote(id, 31).unwrap();
}

#[test]
fn rework_reopens_a_promoted_widget_at_the_tail_and_keeps_it_promoted() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder), ("b-b", AssignedWorker::Coder)]);
    promoted(&mut h, "b-a");
    h.rework("b-a", "  make the seconds hand thinner  ", 40, &[]).unwrap();
    let b = h.builds.last().unwrap();
    assert_eq!(b.envelope.build_id, "b-a");
    assert_eq!(b.envelope.status, Status::Queued);
    assert_eq!(b.promoted_at, Some(31), "the live tile keeps its promoted copy");
    assert_eq!(b.smoke.attempts, 0);
    assert_eq!(b.smoke.failures, 0);
    assert!(b.smoke.last.is_none());
    let o = &b.envelope.human_override;
    assert_eq!(o.last().unwrap().directive, "make the seconds hand thinner");
    assert!(!o.last().unwrap().auto);
    assert!(o.iter().any(|x| x.auto && x.directive.contains("current files")));
    // b-b was waiting first: the reworked build goes behind it.
    assert_eq!(h.next_for(Lane::Worker).as_deref(), Some("b-b"));
    // Passing again re-enables promote, which keeps it a promoted widget.
    running(&mut h, "b-a");
    h.record_smoke("b-a", smoke_pass(), 50).unwrap();
    h.promote("b-a", 51).unwrap();
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Deployed);
    assert_eq!(h.get("b-a").unwrap().promoted_at, Some(51));
}

#[test]
fn rework_refuses_unpromoted_builds_external_apps_and_empty_text() {
    let mut h = hub_with(&[("b-a", AssignedWorker::Coder)]);
    assert!(h.rework("b-a", "anything", 1, &[]).is_err(), "not promoted yet");
    promoted(&mut h, "b-a");
    assert!(h.rework("b-a", "   
 ", 40, &[]).is_err(), "empty directive");
    assert_eq!(h.get("b-a").unwrap().envelope.status, Status::Deployed, "a refused rework changes nothing");
    let mut x = HubFile::default();
    x.enqueue(env("b-x", "ext", Runtime::ExternalOs, AssignedWorker::Coder), "brief".into(), vec![], 0).unwrap();
    running(&mut x, "b-x");
    x.record_smoke("b-x", smoke_pass(), 30).unwrap();
    x.promote("b-x", 31).unwrap();
    assert!(x.rework("b-x", "change it", 40, &[]).is_err(), "external apps aren't dashboard tiles");
}

#[test]
fn html_title_reads_the_page_name_for_the_widget_tray() {
    assert_eq!(html_title("<html><head><TITLE>
  Clock Faces Widget </title></head>").as_deref(), Some("Clock Faces Widget"));
    assert_eq!(html_title("<title lang=\"en\">Tips &amp; Tricks</title>").as_deref(), Some("Tips & Tricks"));
    assert_eq!(html_title("<title>   </title>"), None);
    assert_eq!(html_title("<p>no title</p>"), None);
    assert_eq!(html_title(&format!("<title>{}</title>", "x".repeat(200))).map(|t| t.len()), Some(60));
}
