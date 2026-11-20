//! Transcript store tests: in-memory or temp-file `transcripts.db`, synthetic data only.

use super::*;
use crate::commands::envelope::{self, NewEnvelope};
use serde_json::json;

/// A fake key-shaped string (never a real credential).
const FAKE_KEY: &str = "sk-ant-api03-FAKEfakeFAKEfake0123456789abcdefXYZ";
/// A synthetic "known" secret value (as if from the keychain).
const KNOWN: &str = "hunter2-synthetic-known-value";

fn known() -> Vec<String> {
    vec![KNOWN.to_string()]
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("transcript-{tag}-{}-{}", std::process::id(), envelope::new_task_id(envelope::now_ms())));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn conv(s: &TranscriptStore, id: &str, kind: &'static str) -> TranscriptConversation {
    s.open(&OpenConv { conv_id: id.into(), kind, title: format!("Conversation {id}"), ..Default::default() }, &[]).unwrap()
}

fn msg(kind: &'static str, summary: &str, at: i64) -> NewMessage {
    NewMessage::new("prompter", "coder", kind, summary).at(at)
}

/// A real envelope + its first committed handoff row (in-memory tasks.db).
fn task(text: &str, thread: Option<&str>) -> (rusqlite::Connection, Envelope) {
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    envelope::migrate(&mut c).unwrap();
    let (env, _, _) = envelope::create(&mut c, &NewEnvelope { raw_intent: text.into(), source: "voice".into(), thread: thread.map(str::to_string), ..Default::default() }, &[]).unwrap();
    (c, env)
}

// ── Pure helpers ────────────────────────────────────────────────────────────

#[test]
fn participants_threads_and_ids() {
    assert_eq!(participant("os"), "tony");
    assert_eq!(participant("general"), "tony");
    assert_eq!(participant("user"), "nic");
    assert_eq!(participant("Coder"), "coder");
    assert_eq!(participant("spotify.play"), "tool");
    assert_eq!(participant("claude-cli"), "claude-cli");
    assert_eq!(participant("9lives"), "system");
    assert_eq!(participant("has space"), "system");
    assert!(participant(&"a".repeat(80)).len() <= 32);
    assert_eq!(conv_thread(Some("coder")), "coder");
    assert_eq!(conv_thread(Some("phone")), "auto");
    assert_eq!(conv_thread(None), "auto");
    assert_eq!(conv_thread(Some("general")), "general");
    assert_eq!(task_conv("t-1-abc"), "task:t-1-abc");
    assert_eq!(hub_conv("b 1/../x"), "hub:b1..x");
    assert_eq!(dev_conv("d1"), "dev:d1");
    assert!(turn_conv(&"x".repeat(400)).len() <= 120);
}

#[test]
fn bodies_are_kept_whole_or_truncated_head_and_tail() {
    let (b, n, t) = clip_body("short body");
    assert_eq!((b.as_str(), n, t), ("short body", 10, false));
    let exact = "e".repeat(BODY_MAX);
    assert!(!clip_body(&exact).2);
    let long: String = format!("{}{}{}", "H".repeat(BODY_HEAD), "m".repeat(20_000), "T".repeat(BODY_TAIL));
    let (b, n, t) = clip_body(&long);
    assert!(t);
    assert_eq!(n as usize, long.chars().count());
    assert!(b.starts_with(&"H".repeat(BODY_HEAD)) && b.ends_with(&"T".repeat(BODY_TAIL)));
    assert!(b.contains(&format!("kept the first 12000 and last 4000 of {} characters", long.chars().count())));
    assert!(b.chars().count() <= 16_500, "fits the column CHECK");
    // Multibyte text is cut on characters, never bytes.
    let (b, _, t) = clip_body(&"é".repeat(BODY_MAX + 10));
    assert!(t && b.chars().count() <= 16_500);
}

#[test]
fn summaries_are_one_line_scrubbed_capped_and_never_empty() {
    let s = clean_summary(&format!("the key is {FAKE_KEY}\nand {KNOWN} too"), &known());
    assert!(!s.contains(FAKE_KEY) && !s.contains(KNOWN) && !s.contains('\n'), "{s}");
    assert!(clean_summary(&"word ".repeat(200), &[]).chars().count() <= SUMMARY_MAX);
    assert_eq!(clean_summary("   ", &[]), "note");
    let (b, _, _) = clean_body(&format!("Authorization: Bearer {FAKE_KEY}\n{KNOWN}"), &known());
    assert!(!b.contains(FAKE_KEY) && !b.contains(KNOWN), "{b}");
}

// ── Store ───────────────────────────────────────────────────────────────────

#[test]
fn schema_is_versioned_and_a_newer_file_is_refused() {
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    assert_eq!(migrate(&mut c).unwrap(), 1);
    assert_eq!(migrate(&mut c).unwrap(), 1, "idempotent");
    c.execute_batch("PRAGMA user_version = 99").unwrap();
    assert!(migrate(&mut c).unwrap_err().contains("newer than this app"));
}

#[test]
fn messages_are_append_only() {
    let s = TranscriptStore::in_memory();
    conv(&s, "task:t-1", "task");
    s.append("task:t-1", &msg("handoff", "spec ready", 10), &[]).unwrap().unwrap();
    let err = s.with(|c| c.execute("UPDATE message SET summary = 'changed'", []).map_err(|e| e.to_string())).unwrap_err();
    assert!(err.contains("append-only"), "{err}");
    // Bad kinds / unknown conversations are refused, never written.
    assert!(s.append("task:t-1", &NewMessage::new("a", "b", "gossip", "x"), &[]).is_err());
    assert!(s.append("task:nope", &msg("note", "x", 1), &[]).unwrap_err().contains("no such conversation"));
    assert!(s.open(&OpenConv { conv_id: "bad id!".into(), kind: "task", ..Default::default() }, &[]).is_err());
    assert!(s.open(&OpenConv { conv_id: "x:1".into(), kind: "chat", ..Default::default() }, &[]).is_err());
}

#[test]
fn a_fake_key_and_known_values_never_reach_the_store_or_the_event() {
    let s = TranscriptStore::in_memory();
    conv(&s, "turn:r1", "turn");
    let m = NewMessage::new("os", "librarian", "handoff", format!("use {FAKE_KEY}")).body(format!("token={FAKE_KEY}\npassword: {KNOWN}\nplain words stay"));
    let ev = s.append("turn:r1", &m, &known()).unwrap().unwrap();
    let wire = serde_json::to_string(&ev).unwrap();
    assert!(!wire.contains(FAKE_KEY) && !wire.contains(KNOWN), "{wire}");
    assert!(wire.contains("\"from\":\"tony\""), "os → tony: {wire}");
    assert!(ev.message.body_chars > 0 && !wire.contains("plain words"), "the event carries the head only");
    let full = s.message(ev.message.seq).unwrap().unwrap();
    assert!(full.body.contains("plain words stay"));
    assert!(!full.body.contains(FAKE_KEY) && !full.body.contains(KNOWN), "{}", full.body);
    // Nothing anywhere in the file holds the values.
    let dump: String = s.with(|c| c.query_row("SELECT group_concat(summary || body, '|') FROM message", [], |r| r.get(0)).map_err(|e| e.to_string())).unwrap();
    assert!(!dump.contains(FAKE_KEY) && !dump.contains(KNOWN));
    // A camelCase wire shape with the body flattened into the message.
    let v = serde_json::to_value(&full).unwrap();
    for k in ["seq", "convId", "at", "from", "to", "kind", "summary", "bodyChars", "originalChars", "truncated", "ok", "body"] {
        assert!(v.get(k).is_some(), "missing {k}: {v}");
    }
}

#[test]
fn caps_keep_the_important_kinds_and_count_the_rest() {
    let s = TranscriptStore::in_memory();
    conv(&s, "task:t-cap", "task");
    s.with(|c| {
        // Seed the counter as if 800 messages were in (the cap is enforced on the counter).
        c.execute("UPDATE conversation SET message_count = ?1 WHERE conv_id = 'task:t-cap'", params![MESSAGES_PER_CONV_MAX]).map(|_| ()).map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(s.append("task:t-cap", &msg("status", "tick", 1), &[]).unwrap().is_none());
    assert!(s.append("task:t-cap", &msg("reply", "long answer", 2), &[]).unwrap().is_none());
    for k in KEEP_PAST_CAP {
        assert!(s.append("task:t-cap", &msg(k, k, 3), &[]).unwrap().is_some(), "{k} kept past the cap");
    }
    let c = s.page("task:t-cap", None, 50).unwrap().unwrap().conv;
    assert_eq!(c.dropped, 2);
    // The hard ceiling drops even the kept kinds.
    s.with(|c| c.execute("UPDATE conversation SET message_count = ?1 WHERE conv_id = 'task:t-cap'", params![MESSAGES_HARD_MAX]).map(|_| ()).map_err(|e| e.to_string())).unwrap();
    assert!(s.append("task:t-cap", &msg("error", "boom", 4), &[]).unwrap().is_none());
    assert_eq!(s.page("task:t-cap", None, 50).unwrap().unwrap().conv.dropped, 3);
}

#[test]
fn a_real_cap_run_of_800_messages() {
    let s = TranscriptStore::in_memory();
    conv(&s, "dev:d-1", "dev");
    for i in 0..MESSAGES_PER_CONV_MAX {
        assert!(s.append("dev:d-1", &msg("status", &format!("line {i}"), i), &[]).unwrap().is_some());
    }
    assert!(s.append("dev:d-1", &msg("status", "one too many", 900), &[]).unwrap().is_none());
    assert!(s.append("dev:d-1", &msg("error", "but errors stay", 901), &[]).unwrap().is_some());
    let c = s.list(10, None, true).unwrap().remove(0);
    assert_eq!((c.message_count, c.dropped), (MESSAGES_PER_CONV_MAX as u32 + 1, 1));
    assert_eq!(c.last_summary.as_deref(), Some("but errors stay"));
}

#[test]
fn pages_are_ordered_by_time_then_seq_and_paginate() {
    let s = TranscriptStore::in_memory();
    conv(&s, "task:t-ord", "task");
    // Appended out of time order (a backfilled row arrives after newer live ones).
    for (at, sm) in [(300, "c"), (100, "a"), (300, "d"), (200, "b"), (50, "first")] {
        s.append("task:t-ord", &msg("handoff", sm, at), &[]).unwrap();
    }
    let p = s.page("task:t-ord", None, 400).unwrap().unwrap();
    assert_eq!(p.messages.iter().map(|m| m.summary.as_str()).collect::<Vec<_>>(), ["first", "a", "b", "c", "d"]);
    assert!(!p.more);
    assert_eq!(p.conv.created_at, 50, "a conversation starts at its oldest message");
    let p1 = s.page("task:t-ord", None, 2).unwrap().unwrap();
    assert!(p1.more);
    let p2 = s.page("task:t-ord", Some(p1.messages[1].seq), 2).unwrap().unwrap();
    assert_eq!(p2.messages.iter().map(|m| m.summary.as_str()).collect::<Vec<_>>(), ["b", "c"]);
    let p3 = s.page("task:t-ord", Some(p2.messages[1].seq), 2).unwrap().unwrap();
    assert_eq!(p3.messages.iter().map(|m| m.summary.as_str()).collect::<Vec<_>>(), ["d"]);
    assert!(!p3.more);
    assert!(s.page("task:none", None, 10).unwrap().is_none());
}

#[test]
fn handoff_rows_are_mirrored_once_and_backfilled_idempotently() {
    let s = TranscriptStore::in_memory();
    let (mut c, env) = task(&format!("Build me a tip calculator {FAKE_KEY}"), Some("coder"));
    let first = env.handoff_log[0].clone();
    mirror_entry_in(&s, &first, &env, &[]);
    mirror_entry_in(&s, &first, &env, &[]); // a second delivery is a no-op
    let p = s.page(&task_conv(&env.task_id), None, 50).unwrap().unwrap();
    assert_eq!(p.messages.len(), 1);
    assert_eq!(p.conv.thread, "coder", "the thread it was asked in");
    assert_eq!(p.conv.task_id.as_deref(), Some(env.task_id.as_str()));
    let m = &p.messages[0];
    assert_eq!((m.from.as_str(), m.to.as_str(), m.kind.as_str(), m.handoff_seq), ("tony", "prompter", "handoff", Some(first.seq)));
    let body = s.message(m.seq).unwrap().unwrap().body;
    assert!(body.contains("Brief from Tony:") && body.contains("tip calculator"), "{body}");
    assert!(!body.contains(FAKE_KEY));
    // More rows land in tasks.db while the transcript wasn't listening: backfill adds only those.
    let row = envelope::HandoffRow::new("prompter", "prompter", "stage_started", "verbose", "Prompter is triaging");
    let n = envelope::Next::stage("triage").unwrap();
    envelope::transition(&mut c, &env.task_id, envelope::Expect { status: "queued", stage: None, lease: None }, n, &envelope::Patch::default(), &row, &[]).unwrap();
    let env = envelope::get(&c, &env.task_id).unwrap().unwrap();
    assert_eq!(s.backfill_task(&env, &[]).unwrap(), 1);
    assert_eq!(s.backfill_task(&env, &[]).unwrap(), 0);
    let p = s.page(&task_conv(&env.task_id), None, 50).unwrap().unwrap();
    assert_eq!(p.messages.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(), ["handoff", "status"], "a self-addressed stage claim is a status line");
}

#[test]
fn transcript_get_backfills_a_task_from_tasks_db() {
    let s = TranscriptStore::in_memory();
    let tasks = envelope::TaskStore::in_memory();
    // The global hook is uninitialised in tests: nothing is mirrored at create.
    let (e, _) = tasks.create(&NewEnvelope { raw_intent: "Plan a garden widget".into(), source: "typed".into(), ..Default::default() }, &[]).unwrap();
    let p = page_with_backfill(&s, &tasks, &task_conv(&e.task_id), None, None).unwrap();
    assert_eq!(p.messages.len(), 1);
    assert_eq!(p.conv.title, e.title);
    assert!(page_with_backfill(&s, &tasks, "task:t-missing", None, None).unwrap_err().contains("no such conversation"));
}

#[test]
fn entry_messages_keep_the_rows_recipient_and_classify() {
    let (_c, env) = task("Make a timer", None);
    let mut h = env.handoff_log[0].clone();
    h.voice_summary = Some("Passing it to the Coder".into());
    h.summary_payload = json!({ "files": ["index.html"] });
    h.detail_ref = Some("staging/timer/index.html".into());
    let m = entry_message(&h, &env);
    assert_eq!((m.from.as_str(), m.to.as_str()), ("tony", "prompter"));
    assert!(m.body.starts_with("Said: Passing it to the Coder") && m.body.contains("index.html") && m.body.contains("Detail: staging/timer"));
    for (et, from, to, kind, ok) in [
        ("failed", "coder", "tony", "error", false),
        ("discrepancy", "librarian", "librarian", "error", false),
        ("retry", "system", "prompter", "retry", true),
        ("progress", "coder", "tony", "status", true),
        ("handoff", "prompter", "prompter", "status", true),
        ("handoff", "prompter", "designer", "handoff", true),
        ("review_ready", "prompter", "tony", "handoff", true),
    ] {
        let mut x = h.clone();
        x.event_type = et.into();
        x.from_agent = from.into();
        x.to_agent = to.into();
        let m = entry_message(&x, &env);
        assert_eq!((m.kind, m.ok), (kind, ok), "{et} {from}→{to}");
        assert_eq!(m.to, to);
    }
}

#[test]
fn turn_messages_map_every_step() {
    let steps = vec![
        ("delegate".to_string(), "os".to_string(), "booking".to_string(), "[Tony → Booking agent] last 5 messages".to_string(), true),
        ("reply".into(), "booking".into(), "os".into(), "Here are 5 messages".into(), true),
        ("tool".into(), "os".into(), "weather.now".into(), "sunny".into(), true),
        ("error".into(), "librarian".into(), "os".into(), "index down".into(), false),
    ];
    let m = turn_messages("ask booking for the last 5 messages", &steps, Some("You have 5 new messages."), None);
    let shape: Vec<(String, String, &str, bool)> = m.iter().map(|m| (participant(&m.from), participant(&m.to), m.kind, m.ok)).collect();
    assert_eq!(
        shape,
        vec![
            ("nic".into(), "tony".into(), "prompt", true),
            ("tony".into(), "booking".into(), "handoff", true),
            ("booking".into(), "tony".into(), "reply", true),
            ("tony".into(), "tool".into(), "note", true),
            ("librarian".into(), "tony".into(), "error", false),
            ("tony".into(), "nic".into(), "reply", true),
        ]
    );
    let e = turn_messages("x", &[], None, Some("model down"));
    assert_eq!(e.last().map(|m| (m.kind, m.ok)), Some(("error", false)));
}

#[test]
fn conversations_group_per_task_and_hub_builds_nest_their_children() {
    let s = TranscriptStore::in_memory();
    let (_c1, a) = task("First build", None);
    let (_c2, b) = task("Second build", None);
    mirror_entry_in(&s, &a.handoff_log[0], &a, &[]);
    mirror_entry_in(&s, &b.handoff_log[0], &b, &[]);
    record_in(&s, &task_conv(&a.task_id), NewMessage::new("coder", "tony", "reply", "only in A"), &[]);
    let pa = s.page(&task_conv(&a.task_id), None, 50).unwrap().unwrap();
    let pb = s.page(&task_conv(&b.task_id), None, 50).unwrap().unwrap();
    assert_eq!((pa.messages.len(), pb.messages.len()), (2, 1));
    assert!(pa.messages.iter().all(|m| m.conv_id == task_conv(&a.task_id)));
    // A hub build: its worker task and Claude item nest inside; only the hub is a root card.
    s.open(&OpenConv { conv_id: "hub:b-1".into(), kind: "hub", title: "Timer widget".into(), thread: Some("auto".into()), ..Default::default() }, &[]).unwrap();
    s.append("hub:b-1", &NewMessage::new("tony", "coder", "handoff", "Staged"), &[]).unwrap();
    nest_in(&s, &task_conv(&a.task_id), "hub:b-1");
    open_conv_in(&s, OpenConv { conv_id: "dev:d-9".into(), kind: "dev", title: "Timer widget".into(), parent: Some("hub:b-1".into()), ..Default::default() }, &[]);
    let roots: Vec<String> = s.list(50, None, true).unwrap().into_iter().map(|c| c.conv_id).collect();
    assert!(roots.contains(&"hub:b-1".to_string()) && roots.contains(&task_conv(&b.task_id)));
    assert!(!roots.contains(&task_conv(&a.task_id)) && !roots.contains(&"dev:d-9".to_string()));
    assert_eq!(s.list(50, None, false).unwrap().len(), 4);
    let hub = s.page("hub:b-1", None, 50).unwrap().unwrap();
    assert_eq!(hub.children.iter().map(|c| c.conv_id.as_str()).collect::<Vec<_>>(), [task_conv(&a.task_id).as_str(), "dev:d-9"]);
    assert_eq!(hub.children[0].last_summary.as_deref(), Some("only in A"));
    // Re-opening fills only what was empty (the title stays, the parent stays).
    let again = s.open(&OpenConv { conv_id: "hub:b-1".into(), kind: "hub", title: "Other".into(), ..Default::default() }, &[]).unwrap();
    assert_eq!(again.title, "Timer widget");
}

#[test]
fn a_restart_rebuilds_everything_from_the_persisted_rows() {
    let dir = tmp("restart");
    let id;
    {
        let s = TranscriptStore::default();
        s.init(&dir).unwrap();
        conv(&s, "turn:abc", "turn");
        id = s.append("turn:abc", &NewMessage::new("os", "booking", "handoff", "ask booking").body("full prompt text"), &[]).unwrap().unwrap().message.seq;
        s.append("turn:abc", &NewMessage::new("booking", "os", "reply", "five messages"), &[]).unwrap();
        s.set_status("turn:abc", "done").unwrap();
    }
    // A new process: a fresh store over the same file.
    let s = TranscriptStore::default();
    s.init(&dir).unwrap();
    let list = s.list(50, None, true).unwrap();
    assert_eq!(list.len(), 1);
    let c = &list[0];
    assert_eq!((c.conv_id.as_str(), c.message_count, c.status.as_deref(), c.last_from.as_deref()), ("turn:abc", 2, Some("done"), Some("booking")));
    let p = s.page("turn:abc", None, 50).unwrap().unwrap();
    assert_eq!(p.messages.iter().map(|m| m.summary.as_str()).collect::<Vec<_>>(), ["ask booking", "five messages"]);
    assert_eq!(s.message(id).unwrap().unwrap().body, "full prompt text");
    assert!(dir.join("transcripts.db").is_file());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_drops_only_the_oldest_finished_or_idle_roots_past_the_cap() {
    let s = TranscriptStore::in_memory();
    let now = 10 * 24 * 3600 * 1000 * 100;
    for i in 0..(CONVERSATIONS_MAX + 5) {
        let id = format!("task:t-{i:04}");
        conv(&s, &id, "task");
        s.append(&id, &msg("handoff", "x", 1_000 + i), &[]).unwrap();
        s.with(|c| c.execute("UPDATE conversation SET updated_at = ?2 WHERE conv_id = ?1", params![id, now - 1_000_000 + i]).map(|_| ()).map_err(|e| e.to_string())).unwrap();
    }
    // Nothing is finished or idle yet: nothing goes.
    assert_eq!(s.prune(now).unwrap(), 0);
    // The oldest 10 finish; the 5 oldest go (with their messages), the newer finished ones stay.
    for i in 0..10 {
        s.set_status(&format!("task:t-{i:04}"), "review_ready").unwrap();
        s.with(|c| c.execute("UPDATE conversation SET updated_at = ?2 WHERE conv_id = ?1", params![format!("task:t-{i:04}"), now - 2_000_000 + i]).map(|_| ()).map_err(|e| e.to_string())).unwrap();
    }
    assert_eq!(s.prune(now).unwrap(), 5);
    let n: i64 = s.with(|c| c.query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0)).map_err(|e| e.to_string())).unwrap();
    assert_eq!(n, CONVERSATIONS_MAX);
    assert!(s.page("task:t-0000", None, 5).unwrap().is_none());
    assert!(s.page("task:t-0005", None, 5).unwrap().is_some());
    let orphans: i64 = s.with(|c| c.query_row("SELECT COUNT(*) FROM message WHERE conv_id NOT IN (SELECT conv_id FROM conversation)", [], |r| r.get(0)).map_err(|e| e.to_string())).unwrap();
    assert_eq!(orphans, 0, "messages leave with their conversation");
}

#[test]
fn uninitialised_hooks_are_silent_no_ops() {
    let s = TranscriptStore::default();
    let (_c, env) = task("Anything", None);
    record_in(&s, "task:x", msg("note", "x", 1), &[]);
    open_conv_in(&s, OpenConv { conv_id: "task:x".into(), kind: "task", ..Default::default() }, &[]);
    mirror_entry_in(&s, &env.handoff_log[0], &env, &[]);
    status_in(&s, "task:x", "failed");
    assert!(s.with(|_| Ok(())).unwrap_err().contains("isn't initialised"));
    // The process-wide store is never initialised by unit tests either.
    record("task:x", msg("note", "x", 1), &[]);
    mirror_entry(&env.handoff_log[0], &env, &[]);
    // A broken store (unopenable path) stays off and never panics a hook.
    let bad = TranscriptStore::default();
    let file = tmp("bad").join("not-a-dir");
    std::fs::write(&file, b"x").unwrap();
    assert!(bad.init(&file).is_err());
    assert!(bad.unavailable().is_some());
    record_in(&bad, "task:x", msg("note", "x", 1), &[]);
}

// ── Producers in other modules ──────────────────────────────────────────────

#[test]
fn hub_enqueue_records_the_interview_then_the_handoff() {
    use crate::commands::buildhub::{enqueue_messages, smoke_message, AssignedWorker, IntakeLine, Runtime, Status, TaskEnvelope};
    let e = TaskEnvelope {
        build_id: "b-1".into(),
        project_slug: "timer".into(),
        title: "Timer".into(),
        target_runtime: Runtime::InternalWidget,
        output_directory: "staging/timer".into(),
        spec_summary: "A timer".into(),
        milestones: vec!["Spec".into()],
        acceptance_criteria: vec!["Counts down".into(), "Beeps".into()],
        assigned_worker: AssignedWorker::Coder,
        preview_url: None,
        status: Status::Queued,
        human_override: vec![],
    };
    let intake = vec![IntakeLine { q: "Who is it for?".into(), a: format!("Me {FAKE_KEY}") }, IntakeLine { q: "Dark mode?".into(), a: "".into() }];
    let m = enqueue_messages(&e, "Intake interview: …", &intake, true);
    let shape: Vec<(&str, &str, &str)> = m.iter().map(|m| (m.from.as_str(), m.to.as_str(), m.kind)).collect();
    assert_eq!(shape, [("prompter", "nic", "question"), ("nic", "prompter", "answer"), ("prompter", "nic", "question"), ("nic", "prompter", "answer"), ("tony", "coder", "handoff")]);
    assert!(m[3].summary.contains("use your judgment"));
    assert!(m[4].body.starts_with("BUILD CONTRACT") && m[4].body.contains("Counts down"));
    assert_eq!(enqueue_messages(&e, "", &intake, false)[0].from, "system");
    // Stored, the answer's fake key is gone.
    let s = TranscriptStore::in_memory();
    conv(&s, "hub:b-1", "hub");
    for x in m {
        s.append("hub:b-1", &x, &[]).unwrap();
    }
    let dump: String = s.with(|c| c.query_row("SELECT group_concat(summary || body, '|') FROM message", [], |r| r.get(0)).map_err(|e| e.to_string())).unwrap();
    assert!(!dump.contains(FAKE_KEY));
    let pass = smoke_message("Timer", Status::ReadyForMerge, &[]);
    let fail = smoke_message("Timer", Status::Queued, &["has a button".into()]);
    assert!(pass.ok && pass.summary.ends_with("passed"));
    assert!(!fail.ok && fail.body.contains("has a button"));
}

#[test]
fn claude_progress_and_delegated_turns_map_to_messages() {
    use crate::commands::claude_fix::progress_message;
    assert_eq!(progress_message("done", "Verified").kind, "reply");
    let f = progress_message("failed", "verify failed");
    assert_eq!((f.kind, f.ok), ("error", false));
    let p = progress_message("tool", "Edit src/a.rs");
    assert_eq!((p.kind, p.stage.as_deref(), p.from.as_str()), ("status", Some("tool"), "claude"));
    use crate::commands::agents::{involves_agents, step};
    assert!(involves_agents(&[step("delegate", "os", "booking", "x", true, 0)]));
    assert!(involves_agents(&[step("overseer", "claude-cli", "os", "auto-escalated", true, 0)]));
    assert!(!involves_agents(&[step("tool", "os", "weather.now", "sunny", true, 0)]));
}
