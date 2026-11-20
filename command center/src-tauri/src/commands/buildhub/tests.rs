use super::*;
use serde_json::json;

const STAGING: &str = r"D:\Art Apps\agentic os\staging";
const EXT: &str = r"C:\ai-hub\external-builds";

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
    assert_eq!(v["output_directory"], r"C:\ai-hub\external-builds\tip-calc");
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
    h.record_smoke("b-a", smoke_pass(), 5).unwrap_err(); // not smoke_testing yet: fine either way
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
    h.steer("b-a", "  make   the CTA bigger ", 100, &[]).unwrap();
    let o = &h.get("b-a").unwrap().envelope.human_override[0];
    assert_eq!((o.directive.as_str(), o.priority.as_str(), o.applied_at), ("make the CTA bigger", "high", None));
    assert_eq!(override_lines(&h.get("b-a").unwrap().envelope), vec!["make the CTA bigger".to_string()]);
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
    let long = format!("use token sk-abcdefghijklmnopqrstuv0123 {}", "x".repeat(900));
    h.steer("b-a", &long, 1, &[]).unwrap();
    let d = &h.get("b-a").unwrap().envelope.human_override[0].directive;
    assert!(d.chars().count() <= OVERRIDE_MAX);
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
    let mk = |t: &str| super::super::taskworker::CreateArgs { raw_intent: format!("build {t}"), title: Some(t.into()), thread: None, source: "playplace".into(), idea_id: None, options: None, dedupe_key: Some(format!("k-{t}")) };
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
