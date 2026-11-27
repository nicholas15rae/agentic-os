use super::*;
use serde_json::json;

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cc-modes-test-{tag}-{}-{}", std::process::id(), super::super::os_core::now_secs()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn eff(id: &str) -> Effective {
    let f = ModesFile { active_mode_id: id.into(), ..Default::default() };
    effective(&f, &Overrides::default())
}

fn custom(id: &str) -> TonyMode {
    TonyMode {
        id: id.into(),
        name: "Deep Focus".into(),
        icon: "sparkles".into(),
        curiosity_level: Curiosity::Low,
        verbosity: Verbosity::Terse,
        agent_dispatch_policy: DispatchPolicy::AskBeforeDispatch,
        tts_interrupt_level: TtsInterrupt::Silent,
        prompt_modifier: "Keep answers about the current task.".into(),
        is_novelty: false,
        switchboard: None,
        night_training: false,
    }
}

fn board(agents: &[&str], tools: &[&str]) -> Option<ModeSwitchboard> {
    Some(ModeSwitchboard { agents: agents.iter().map(|s| s.to_string()).collect(), tools: tools.iter().map(|s| s.to_string()).collect() })
}

#[test]
fn presets_are_the_spec_table_in_order() {
    let p = presets();
    assert_eq!(p.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), BUILTIN_IDS.to_vec());
    use Curiosity as C;
    use DispatchPolicy as D;
    use TtsInterrupt as T;
    use Verbosity as V;
    let want = [
        ("surface", "Surface / Solo", C::Medium, V::Balanced, D::SurfaceOnly, T::Silent, "message-circle"),
        ("brainstorm", "Brainstorming", C::High, V::Conversational, D::AskBeforeDispatch, T::MilestonesOnly, "lightbulb"),
        ("builder", "Builder", C::Medium, V::Balanced, D::AutoDispatch, T::Full, "hammer"),
        ("operations", "Operations", C::Medium, V::Balanced, D::AskBeforeDispatch, T::MilestonesOnly, "clipboard-list"),
        ("executive", "Executive", C::Low, V::Terse, D::AskBeforeDispatch, T::MilestonesOnly, "briefcase"),
        ("coach", "Motivation / Coach", C::Medium, V::Balanced, D::SurfaceOnly, T::MilestonesOnly, "flame"),
        ("learning", "Learning", C::High, V::Balanced, D::SurfaceOnly, T::Silent, "graduation-cap"),
        ("gabagool", "Gabagool Mode", C::Medium, V::Balanced, D::SurfaceOnly, T::Silent, "\u{1F35D}"),
    ];
    for (m, w) in p.iter().zip(want) {
        assert_eq!((m.id.as_str(), m.name.as_str(), m.curiosity_level, m.verbosity, m.agent_dispatch_policy, m.tts_interrupt_level, m.icon.as_str()), w);
        assert_eq!(m.is_novelty, m.id == "gabagool", "{}", m.id);
        assert!(validate_mode(m).is_ok(), "{}", m.id);
    }
    assert_eq!(p[1].prompt_modifier, BRAINSTORM_NOTES);
    assert_eq!(p[5].prompt_modifier, COACH_NOTES);
    assert_eq!(p[6].prompt_modifier, LEARNING_NOTES);
    for i in [0, 2, 3, 4, 7] {
        assert!(p[i].prompt_modifier.is_empty(), "{}", p[i].id);
    }
    assert_eq!(ModesFile::default().active_mode_id, "brainstorm");
    assert!(BUILTIN_IDS.iter().all(|id| is_builtin(id)) && !is_builtin("deep-focus"));
    assert_eq!(NOVELTY_ID, BUILTIN_IDS[7]);
    assert_eq!(LEARNING_ID, BUILTIN_IDS[6]);
    assert_eq!(BUILTIN_IDS[3], "operations", "Operations sits right after Builder");
    assert_eq!(ModesFile::default().version, MODES_FILE_VERSION);
}

#[test]
fn presets_carry_the_switchboard_spec() {
    let p = presets();
    let row = |id: &str| p.iter().find(|m| m.id == id).unwrap().clone();
    assert_eq!(row("builder").switchboard, board(&["prompter", "designer", "coder"], &["filesystem", "git", "fetch", "brave-search", "knowledge-graph", "time", "weather", "spotify"]));
    assert_eq!(row("operations").switchboard, board(&["ops", "bizops"], &["gmail", "calendar", "whatsapp", "knowledge-graph", "filesystem", "maps", "fetch", "time", "weather", "instagram"]));
    assert_eq!(row("executive").switchboard, board(&["bizops", "finance"], &["knowledge-graph", "gmail", "calendar", "brave-search", "time", "weather"]));
    assert!(!EXECUTIVE_AGENTS.contains(&"librarian"), "the Librarian runs only as its scheduled script");
    // A2: Google Calendar mirrors Gmail in every preset: live where Gmail is, frozen where it is.
    let sb = SwitchboardConfig::default();
    for id in BUILTIN_IDS {
        let e = eff(id);
        assert_eq!(tool_live(&e, &sb, "calendar"), tool_live(&e, &sb, "gmail"), "{id}");
        assert_eq!(tool_frozen_error(&e, &sb, "calendar").is_some(), tool_frozen_error(&e, &sb, "gmail").is_some(), "{id}");
    }
    assert!(tool_live(&eff("operations"), &sb, "calendar") && tool_live(&eff("executive"), &sb, "calendar"));
    assert!(!tool_live(&eff("builder"), &sb, "calendar") && !tool_live(&eff(LEARNING_ID), &sb, "calendar"));
    assert_eq!(row("learning").switchboard, board(&[], &[]));
    for id in ["surface", "brainstorm", "coach", "gabagool"] {
        assert_eq!(row(id).switchboard, None, "{id}: no overlay, today's behaviour");
    }
    for m in &p {
        assert_eq!(m.night_training, m.id == LEARNING_ID, "{}", m.id);
    }
    assert_eq!(LEARNING_NOTES, "Be curious: ask Nic what he's doing, how and why.");
    // Executive keeps its dials.
    let x = row("executive");
    assert_eq!((x.curiosity_level, x.verbosity, x.agent_dispatch_policy, x.tts_interrupt_level), (Curiosity::Low, Verbosity::Terse, DispatchPolicy::AskBeforeDispatch, TtsInterrupt::MilestonesOnly));
    // Effective carries both.
    let e = eff("builder");
    assert_eq!(e.switchboard, row("builder").switchboard);
    assert!(!e.night_training && eff(LEARNING_ID).night_training);
}

#[test]
fn serde_uses_the_spec_snake_case_keys() {
    let v = serde_json::to_value(&presets()[1]).unwrap();
    assert_eq!(
        v,
        json!({ "id": "brainstorm", "name": "Brainstorming", "icon": "lightbulb", "curiosity_level": "high", "verbosity": "conversational", "agent_dispatch_policy": "ask_before_dispatch", "tts_interrupt_level": "milestones_only", "prompt_modifier": BRAINSTORM_NOTES, "is_novelty": false, "night_training": false })
    );
    // The overlay is snake_case beside the other fields, and absent when there is none.
    let b = serde_json::to_value(&presets()[2]).unwrap();
    assert_eq!(b["switchboard"]["agents"], json!(["prompter", "designer", "coder"]));
    assert_eq!(serde_json::to_value(&presets()[6]).unwrap()["night_training"], true);
    assert_eq!(serde_json::to_value(DispatchPolicy::SurfaceOnly).unwrap(), "surface_only");
    assert_eq!(serde_json::to_value(DispatchPolicy::AutoDispatch).unwrap(), "auto_dispatch");
    assert_eq!(serde_json::to_value(TtsInterrupt::Full).unwrap(), "full");
    assert_eq!(serde_json::to_value(Verbosity::Terse).unwrap(), "terse");
    assert_eq!(serde_json::to_value(Curiosity::Low).unwrap(), "low");
    let f = ModesFile::default();
    let back: ModesFile = serde_json::from_value(serde_json::to_value(&f).unwrap()).unwrap();
    assert_eq!(back, f);
    assert!(serde_json::to_value(&f).unwrap().get("active_mode_id").is_some());
    // Old/partial custom rows default the optional fields (no overlay, no night training).
    let m: TonyMode = serde_json::from_value(json!({ "id": "x", "name": "X", "icon": "flame", "curiosity_level": "low", "verbosity": "terse", "agent_dispatch_policy": "surface_only", "tts_interrupt_level": "silent" })).unwrap();
    assert!(m.prompt_modifier.is_empty() && !m.is_novelty && m.switchboard.is_none() && !m.night_training);
}

#[test]
fn mode_block_is_the_deterministic_curiosity_dial() {
    let mut e = eff("executive");
    let low = mode_block(&e);
    assert!(low.contains("1–2 sentences") && low.contains("no follow-up questions"), "{low}");
    assert!(low.starts_with("\n\nMODE: Executive. These MODE rules override the STYLE length rule.\n"), "{low}");
    assert!(low.contains(VERBOSITY_TERSE));
    e.curiosity = Curiosity::Medium;
    let med = mode_block(&e);
    assert!(med.contains("at most 1"), "{med}");
    e.curiosity = Curiosity::High;
    let high = mode_block(&e);
    assert!(high.contains("edge cases") && high.contains("1–2 creative angles"), "{high}");
    // Only the CURIOSITY line changes, and the same state always gives the same text.
    let lines = |s: &str| s.lines().map(String::from).collect::<Vec<_>>();
    let (a, b) = (lines(&low), lines(&high));
    assert_eq!(a.len(), b.len());
    let diff: Vec<usize> = (0..a.len()).filter(|i| a[*i] != b[*i]).collect();
    assert_eq!(diff.len(), 1);
    assert!(a[diff[0]].starts_with("CURIOSITY LOW") && b[diff[0]].starts_with("CURIOSITY HIGH"));
    assert_eq!(mode_block(&e), mode_block(&e.clone()));
    // Balanced / ask add no line; Solo and Builder add theirs; notes ride last.
    let ask = mode_block(&eff("brainstorm"));
    assert!(!ask.contains("SOLO MODE") && !ask.contains("BUILDER MODE") && ask.ends_with(&format!("MODE NOTES: {BRAINSTORM_NOTES}")), "{ask}");
    assert!(mode_block(&eff("surface")).contains(DISPATCH_SOLO));
    assert!(mode_block(&eff("builder")).contains(DISPATCH_AUTO));
    assert!(!mode_block(&eff("builder")).contains("VERBOSITY"));
    // Novelty injects nothing.
    assert_eq!(mode_block(&eff("gabagool")), "");
}

#[test]
fn no_block_or_preset_carries_a_banned_word_and_blocks_stay_small() {
    let consts = [CURIOSITY_LOW, CURIOSITY_MEDIUM, CURIOSITY_HIGH, VERBOSITY_TERSE, VERBOSITY_CONVERSATIONAL, DISPATCH_SOLO, DISPATCH_AUTO, BRAINSTORM_NOTES, COACH_NOTES];
    for c in consts {
        let l = c.to_lowercase();
        assert!(!l.contains("json") && !l.contains("/no_think") && !l.contains("gabagool"), "{c}");
    }
    for m in presets() {
        let b = mode_block(&eff(&m.id));
        let l = b.to_lowercase();
        assert!(!l.contains("json") && !l.contains("/no_think") && !l.contains("gabagool"), "{}: {b}", m.id);
        assert!(b.chars().count() <= MODE_BLOCK_MAX, "{}", m.id);
    }
    // Worst case: high + conversational + Solo + a 280-char note still fits in the cap.
    let e = Effective { curiosity: Curiosity::High, verbosity: Verbosity::Conversational, dispatch: DispatchPolicy::SurfaceOnly, prompt_modifier: "x".repeat(280), name: "N".repeat(32), ..eff("surface") };
    let b = mode_block(&e);
    assert!(b.chars().count() <= MODE_BLOCK_MAX, "{}", b.chars().count());
    assert!(b.contains("MODE NOTES: xxx"));
    // …and with the longest overlay a custom mode can hold (16 ids of 32 chars), Builder dials.
    let long: Vec<String> = (0..16).map(|i| format!("{}{i:02}", "a".repeat(30))).collect();
    let e = Effective { switchboard: Some(ModeSwitchboard { agents: long, tools: vec![] }), dispatch: DispatchPolicy::AutoDispatch, ..e };
    assert!(mode_block(&e).chars().count() <= MODE_BLOCK_MAX, "{}", mode_block(&e).chars().count());
    assert_eq!(MODE_BLOCK_MAX, 800);
    // Source guard: the format word in modes.rs appears only in code lines, never in a prompt constant.
    let src = include_str!("../modes.rs");
    for line in src.lines().filter(|l| l.trim_start().starts_with("pub const") && l.contains(": &str = \"")) {
        let l = line.to_lowercase();
        assert!(!l.contains("json") && !l.contains("/no_think"), "{line}");
    }
}

#[test]
fn validate_mode_rejects_the_traps() {
    assert!(validate_mode(&custom("deep-focus")).is_ok());
    for bad in ["Return JSON please", "use Json output", "x /no_think", "say gabagool"] {
        let m = TonyMode { prompt_modifier: bad.into(), ..custom("deep-focus") };
        assert!(validate_mode(&m).is_err(), "{bad}");
    }
    assert!(validate_mode(&TonyMode { prompt_modifier: "line one\nline two".into(), ..custom("deep-focus") }).is_err());
    assert!(validate_mode(&TonyMode { prompt_modifier: "x".repeat(281), ..custom("deep-focus") }).is_err());
    assert!(validate_mode(&TonyMode { prompt_modifier: "x".repeat(280), ..custom("deep-focus") }).is_ok());
    assert!(validate_mode(&TonyMode { name: "".into(), ..custom("deep-focus") }).is_err());
    assert!(validate_mode(&TonyMode { name: "n".repeat(33), ..custom("deep-focus") }).is_err());
    assert!(validate_mode(&TonyMode { name: "JSON mode".into(), ..custom("deep-focus") }).is_err());
    assert!(validate_mode(&TonyMode { icon: "".into(), ..custom("deep-focus") }).is_err());
    for id in ["Deep", "9x", "a b", "../x", ""] {
        assert!(validate_mode(&custom(id)).is_err(), "{id:?}");
    }

    let mut f = ModesFile::default();
    // Builtins can't be overwritten, deleted, or (novelty) activated.
    assert!(f.upsert(TonyMode { id: "builder".into(), ..custom("x") }, false).is_err());
    assert!(f.upsert(TonyMode { id: "builder".into(), ..custom("x") }, true).is_err());
    assert!(f.delete("surface").is_err());
    assert!(f.set_active("gabagool").is_err());
    assert!(f.set_active("nope").is_err());
    // Duplicate id refused; the active mode can't be deleted.
    f.upsert(custom("deep-focus"), true).unwrap();
    assert!(f.upsert(custom("deep-focus"), true).is_err());
    f.set_active("deep-focus").unwrap();
    assert!(f.delete("deep-focus").is_err());
    f.set_active("builder").unwrap();
    f.delete("deep-focus").unwrap();
    assert!(f.delete("deep-focus").is_err());
    // A custom novelty is refused; the novelty can't be duplicated.
    assert!(f.upsert(TonyMode { is_novelty: true, ..custom("fun") }, true).is_err());
    assert!(f.duplicate("gabagool", "More pasta").is_err());
}

#[test]
fn duplicate_makes_a_unique_custom_copy() {
    let mut f = ModesFile::default();
    let a = f.duplicate("executive", "").unwrap();
    assert_eq!((a.id.as_str(), a.name.as_str()), ("executive-copy", "Executive copy"));
    assert_eq!((a.curiosity_level, a.verbosity), (Curiosity::Low, Verbosity::Terse));
    let b = f.duplicate("executive", "").unwrap();
    assert_eq!(b.id, "executive-copy-2");
    let c = f.duplicate("builder", "Builder").unwrap();
    assert_eq!(c.id, "builder-2", "a preset id is never reused");
    assert_eq!(f.modes.iter().filter(|m| m.id == "executive").count(), 1);
    assert_eq!(f.modes.len(), 11);
    // A copy keeps the preset's switchboard (and is then the user's to edit).
    assert_eq!(a.switchboard, presets()[4].switchboard);
}

#[test]
fn effective_applies_overrides_until_a_switch_or_reset() {
    assert_eq!((feedback_for(TtsInterrupt::Silent), feedback_for(TtsInterrupt::MilestonesOnly), feedback_for(TtsInterrupt::Full)), (0, 1, 2));
    let s = ModeStore::default();
    assert_eq!(s.effective().mode_id, "brainstorm");
    assert_eq!(s.effective().feedback_level, 1);
    let e = s.apply_override(&OverridePatch { curiosity: Some(Curiosity::Low), ..Default::default() });
    assert_eq!(e.curiosity, Curiosity::Low);
    assert_eq!(e.overridden, vec!["curiosity"]);
    assert_eq!(e.dispatch, DispatchPolicy::AskBeforeDispatch, "untouched fields keep the mode's");
    assert!(mode_block(&e).contains(CURIOSITY_LOW));
    let e = s.clear_overrides();
    assert_eq!((e.curiosity, e.overridden.len()), (Curiosity::High, 0));
    s.apply_override(&OverridePatch { dispatch: Some(DispatchPolicy::SurfaceOnly), ..Default::default() });
    s.note_feedback(3);
    assert_eq!(s.effective().feedback_level, 3);
    assert_eq!(s.effective().overridden, vec!["dispatch", "feedback"]);
    // A switch clears every override.
    let e = s.set_active("executive").unwrap();
    assert!(e.overridden.is_empty());
    assert_eq!((e.dispatch, e.feedback_level), (DispatchPolicy::AskBeforeDispatch, 1));
    // A manual level equal to the mode's own is not an override.
    s.note_feedback(1);
    assert!(s.overrides().is_empty());
}

#[test]
fn dispatch_gate_truth_table() {
    use DispatchKind::*;
    use DispatchPolicy::*;
    let cells = [
        (SurfaceOnly, BuildPipeline { auto: false }, Err(MODE_SURFACE_ONLY)),
        (SurfaceOnly, BuildPipeline { auto: true }, Err(MODE_SURFACE_ONLY)),
        (SurfaceOnly, AgentHandoff, Err(MODE_SURFACE_ONLY)),
        (AskBeforeDispatch, BuildPipeline { auto: false }, Ok(())),
        (AskBeforeDispatch, BuildPipeline { auto: true }, Err(MODE_NOT_AUTO)),
        (AskBeforeDispatch, AgentHandoff, Ok(())),
        (AutoDispatch, BuildPipeline { auto: false }, Ok(())),
        (AutoDispatch, BuildPipeline { auto: true }, Ok(())),
        (AutoDispatch, AgentHandoff, Ok(())),
    ];
    for (p, k, want) in cells {
        assert_eq!(dispatch_allowed(p, k), want, "{p:?} {k:?}");
    }
    assert!(check_dispatch(SurfaceOnly, AgentHandoff).unwrap_err().starts_with("MODE_SURFACE_ONLY: Solo mode is on"));
    assert!(check_dispatch(AskBeforeDispatch, BuildPipeline { auto: true }).unwrap_err().starts_with("MODE_NOT_AUTO: "));
}

#[test]
fn load_or_init_seeds_restores_and_survives_corruption() {
    // Missing file: eight presets, active brainstorm, written to disk.
    let d = tmp_dir("seed");
    let s = ModeStore::default();
    assert_eq!(s.load_or_init(&d), LoadOutcome::Seeded);
    assert_eq!(s.file().modes.len(), 8);
    assert_eq!(s.file().active_mode_id, "brainstorm");
    let on_disk: ModesFile = serde_json::from_str(&std::fs::read_to_string(d.join("modes.json")).unwrap()).unwrap();
    assert_eq!(on_disk, ModesFile::default());
    assert!(!d.join("modes.json.tmp").exists(), "atomic write leaves no tmp file");

    // Custom modes survive; a tampered builtin is restored from code; the file stays compact.
    let mut f = ModesFile::default();
    f.modes.push(custom("deep-focus"));
    f.modes[2].agent_dispatch_policy = DispatchPolicy::SurfaceOnly; // builder tampered
    f.modes[0].prompt_modifier = "Return JSON".into();
    f.active_mode_id = "deep-focus".into();
    std::fs::write(d.join("modes.json"), serde_json::to_string(&f).unwrap()).unwrap();
    let s = ModeStore::default();
    assert_eq!(s.load_or_init(&d), LoadOutcome::Loaded);
    let got = s.file();
    assert_eq!(&got.modes[..8], &presets()[..]);
    assert_eq!(got.modes[8], custom("deep-focus"));
    assert_eq!(got.active_mode_id, "deep-focus");
    assert!(std::fs::metadata(d.join("modes.json")).unwrap().len() < 6144);

    // Unknown active id → brainstorm. Novelty active → brainstorm.
    for bad in ["ghost", "gabagool"] {
        std::fs::write(d.join("modes.json"), json!({ "version": 1, "active_mode_id": bad, "modes": [] }).to_string()).unwrap();
        let s = ModeStore::default();
        s.load_or_init(&d);
        assert_eq!(s.effective().mode_id, "brainstorm", "{bad}");
    }

    // Corrupt: moved aside, presets used, no panic.
    std::fs::write(d.join("modes.json"), "{ not valid").unwrap();
    let s = ModeStore::default();
    assert_eq!(s.load_or_init(&d), LoadOutcome::Corrupt);
    assert_eq!(s.file(), ModesFile::default());
    assert!(d.join("modes.json.bad").exists());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn seeding_never_touches_narration() {
    let os = OsState::default();
    os.update(|c| {
        c.feedback.sensitivity = 3;
        Ok(())
    })
    .unwrap();
    let d = tmp_dir("feedback");
    os.modes.load_or_init(&d);
    assert_eq!(os.snapshot().feedback.sensitivity, 3, "D11: first seeding keeps Nic's narration level");
    // OsState::load_or_init then records the saved level as an override, so the panel is truthful.
    os.modes.note_feedback(os.snapshot().feedback.sensitivity);
    assert_eq!(os.modes.effective().feedback_level, 3);
    assert_eq!(os.modes.effective().overridden, vec!["feedback"]);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn switching_maps_tts_level_onto_narration_and_manual_changes_are_overrides() {
    let os = OsState::default();
    switch_mode(&os, "surface").unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 0);
    switch_mode(&os, "builder").unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 2);
    assert!(os.modes.overrides().is_empty(), "the switch's own write is never an override");
    // A manual narration change (os_config_update path) is an override; reset restores the mode's.
    let before = os.snapshot();
    let next = os
        .update(|c| {
            c.feedback.sensitivity = 3;
            Ok(())
        })
        .unwrap();
    super::super::os_core::note_manual_feedback(&os, &before, &next);
    assert_eq!(os.modes.overrides().feedback, Some(3));
    assert_eq!(os.modes.effective().feedback_level, 3);
    reset_overrides(&os).unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 2);
    assert!(os.modes.overrides().is_empty());
    // The novelty overlay never becomes the work mode.
    assert!(switch_mode(&os, "gabagool").is_err());
    assert_eq!(os.modes.effective().mode_id, "builder");
}

#[test]
fn editing_the_active_mode_keeps_a_manual_narration_override() {
    // Fix pass: a rename of the active custom mode used to write the mode's own level to os.json
    // while the override (and the panel) still said 3.
    let os = OsState::default();
    let d = tmp_dir("upsert-feedback");
    os.modes.load_or_init(&d);
    upsert_mode(&os, custom("deep-focus"), true).unwrap();
    switch_mode(&os, "deep-focus").unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 0);
    let before = os.snapshot();
    let next = os
        .update(|c| {
            c.feedback.sensitivity = 3;
            Ok(())
        })
        .unwrap();
    assert!(super::super::os_core::note_manual_feedback(&os, &before, &next), "a level change is reported (tony-mode-changed)");
    assert!(!super::super::os_core::note_manual_feedback(&os, &next, &next));
    let mut renamed = custom("deep-focus");
    renamed.name = "Deeper Focus".into();
    upsert_mode(&os, renamed, false).unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 3, "the manual level stays in effect");
    assert_eq!(os.modes.effective().feedback_level, 3);
    assert_eq!(os.modes.effective().overridden, vec!["feedback"]);
    // Editing the mode's own level to match the override makes the override redundant.
    let before = os.snapshot();
    let next = os
        .update(|c| {
            c.feedback.sensitivity = 2;
            Ok(())
        })
        .unwrap();
    super::super::os_core::note_manual_feedback(&os, &before, &next);
    assert_eq!(os.modes.overrides().feedback, Some(2));
    let mut loud = custom("deep-focus");
    loud.tts_interrupt_level = TtsInterrupt::Full;
    upsert_mode(&os, loud, false).unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 2);
    assert!(os.modes.overrides().feedback.is_none(), "an override equal to the mode's level is dropped");
    // No override: the edit follows the mode's new level.
    reset_overrides(&os).unwrap();
    let mut quiet = custom("deep-focus");
    quiet.tts_interrupt_level = TtsInterrupt::MilestonesOnly;
    upsert_mode(&os, quiet, false).unwrap();
    assert_eq!(os.snapshot().feedback.sensitivity, 1);
    assert!(os.modes.overrides().is_empty());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn mirror_and_view_carry_the_mode() {
    let os = OsState::default();
    switch_mode(&os, "executive").unwrap();
    override_mode(&os, &OverridePatch { curiosity: Some(Curiosity::High), ..Default::default() });
    let m = os.mirror_value(&os.snapshot());
    assert_eq!(m["mode"]["id"], "executive");
    assert_eq!(m["mode"]["curiosity"], "high");
    assert_eq!(m["mode"]["dispatch"], "ask_before_dispatch");
    assert_eq!(m["mode"]["feedbackLevel"], 1);
    assert_eq!(m["mode"]["overridden"], json!(["curiosity"]));
    assert_eq!(m["mode"]["list"].as_array().unwrap().len(), 8);
    assert_eq!(m["mode"]["list"][7], json!({ "id": "gabagool", "name": "Gabagool Mode", "icon": "\u{1F35D}", "isNovelty": true }));
    // The gateway's end-of-prompt text and the switchboard's inputs.
    assert_eq!(m["mode"]["promptTail"], json!(mode_block(&os.modes.effective())));
    assert!(m["mode"]["promptTail"].as_str().unwrap().contains("ON DUTY: Finance, Operations Manager; every other agent is frozen this mode."));
    assert_eq!(m["mode"]["switchboard"], json!({ "agents": ["bizops", "finance"], "tools": ["knowledge-graph", "gmail", "calendar", "brave-search", "time", "weather"], "frozenAgents": ["booking", "librarian"], "frozenTools": [] }));
    assert_eq!(m["mode"]["nightTraining"], false);
    switch_mode(&os, "surface").unwrap();
    let m = os.mirror_value(&os.snapshot());
    assert_eq!(m["mode"]["switchboard"]["agents"], Value::Null, "no overlay");
    assert_eq!(m["mode"]["switchboard"]["frozenAgents"], json!(["booking", "librarian"]));
    switch_mode(&os, "executive").unwrap();
    override_mode(&os, &OverridePatch { curiosity: Some(Curiosity::High), ..Default::default() });
    assert!(m["voice"].is_object(), "Part B's mirror keys are kept");
    let v = os.modes.view();
    assert_eq!(v["active_mode_id"], "executive");
    assert_eq!(v["builtin_ids"], json!(BUILTIN_IDS));
    assert_eq!(v["overrides"], json!({ "curiosity": "high" }));
    assert_eq!(v["effective"]["curiosity"], "high");
}

#[test]
fn learning_locks_dispatch_to_solo_and_carries_the_protocol() {
    let s = ModeStore::default();
    s.set_active(LEARNING_ID).unwrap();
    let e = s.effective();
    assert!(is_learning(&e));
    assert_eq!((e.curiosity, e.dispatch, e.feedback_level), (Curiosity::High, DispatchPolicy::SurfaceOnly, 0));
    // A dispatch override (the phone, a stale webview) never lifts the lock, nor shows as one.
    let e = s.apply_override(&OverridePatch { dispatch: Some(DispatchPolicy::AutoDispatch), ..Default::default() });
    assert_eq!(e.dispatch, DispatchPolicy::SurfaceOnly);
    assert!(e.overridden.is_empty());
    // Curiosity stays adjustable.
    let e = s.apply_override(&OverridePatch { curiosity: Some(Curiosity::Low), ..Default::default() });
    assert_eq!((e.curiosity, e.overridden.clone()), (Curiosity::Low, vec!["curiosity"]));
    let b = mode_block(&e);
    assert!(b.contains(LEARNING_PROTOCOL) && b.contains(CURIOSITY_LOW));
    assert!(!b.contains(DISPATCH_SOLO), "the protocol replaces the Solo line");
    assert!(dispatch_allowed(e.dispatch, DispatchKind::BuildPipeline { auto: false }).is_err());
    // Every dial combination stays inside the block cap.
    for c in [Curiosity::Low, Curiosity::Medium, Curiosity::High] {
        for v in [Verbosity::Terse, Verbosity::Balanced, Verbosity::Conversational] {
            let e = Effective { curiosity: c, verbosity: v, ..eff(LEARNING_ID) };
            assert!(mode_block(&e).chars().count() <= MODE_BLOCK_MAX, "{c:?} {v:?}");
        }
    }
    // Leaving Learning: an override set elsewhere works again.
    s.set_active("brainstorm").unwrap();
    assert_eq!(s.apply_override(&OverridePatch { dispatch: Some(DispatchPolicy::AutoDispatch), ..Default::default() }).dispatch, DispatchPolicy::AutoDispatch);
}

/// Decision 5: one curious follow-up at a time, the echo, then the core-memories question with the
/// proposal tag; nothing claims a save. The question is the app's own constant, word for word, and
/// the notes survive the busiest dials (Conversational) in full.
#[test]
fn the_learning_protocol_asks_curious_follow_ups_and_the_core_question() {
    for part in ["one curious follow-up at a time (who, how, why, when)", "(So when X, you want Y?)", "[[LEARN category | when | rule or fact | confirmed]]", "Nothing is saved until he says yes."] {
        assert!(LEARNING_PROTOCOL.contains(part), "{part}");
    }
    assert!(LEARNING_PROTOCOL.contains(super::super::learning::CORE_QUESTION));
    assert!(!LEARNING_PROTOCOL.contains('"'), "the TS mirror test reads the constant between plain quotes");
    let l = LEARNING_PROTOCOL.to_lowercase();
    assert!(!l.contains("json") && !l.contains("gabagool") && !l.contains("save now"), "{l}");
    let busiest = Effective { curiosity: Curiosity::High, verbosity: Verbosity::Conversational, ..eff(LEARNING_ID) };
    let b = mode_block(&busiest);
    assert!(b.chars().count() <= MODE_BLOCK_MAX && b.ends_with(&format!("\nMODE NOTES: {LEARNING_NOTES}")), "{}: {b}", b.chars().count());
}

#[test]
fn tool_mode_names_resolve_to_work_modes_only() {
    for (q, id) in [
        ("builder", "builder"),
        ("Build mode", "builder"),
        ("coach", "coach"),
        ("Motivation / Coach", "coach"),
        ("motivational", "coach"),
        ("exec", "executive"),
        ("Executive", "executive"),
        ("solo", "surface"),
        ("Surface / Solo", "surface"),
        ("brainstorming", "brainstorm"),
        ("study", "learning"),
        ("learning mode", "learning"),
        ("operations", "operations"),
        ("Operations mode", "operations"),
        ("ops", "operations"),
    ] {
        assert_eq!(resolve_work_mode(q), Some(id), "{q}");
    }
    for q in ["gabagool", "Gabagool Mode", "", "turbo", "local"] {
        assert_eq!(resolve_work_mode(q), None, "{q}");
    }
    // Every id it can return is a real preset.
    for id in ["surface", "builder", "operations", "coach", "brainstorm", "executive", "learning"] {
        assert!(presets().iter().any(|p| p.id == id), "{id}");
    }
}

// ── Switchboard ─────────────────────────────────────────────────────────────

fn global(frozen_agents: &[&str], frozen_tools: &[&str]) -> SwitchboardConfig {
    SwitchboardConfig { version: 1, frozen_agents: frozen_agents.iter().map(|s| s.to_string()).collect(), frozen_tools: frozen_tools.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn live_is_not_globally_frozen_and_on_duty_in_the_overlay() {
    let g = global(&["booking"], &["instagram"]);
    let builder = eff("builder");
    let brainstorm = eff("brainstorm");
    // No overlay: everyone but the globally frozen Booking.
    for a in ["coder", "ops", "bizops", "finance", "librarian", "director", "security-patrol"] {
        assert!(agent_live(&brainstorm, &g, a), "{a}");
    }
    assert!(!agent_live(&brainstorm, &g, "booking") && !agent_live(&builder, &g, "Booking"));
    // Builder: only its three are on duty.
    for (a, live) in [("prompter", true), ("designer", true), ("coder", true), ("ops", false), ("bizops", false), ("bizops_corner_bakery", false), ("finance", false), ("financer", false), ("librarian", false), ("director", false)] {
        assert_eq!(agent_live(&builder, &g, a), live, "{a}");
    }
    // Tony and the system scripts are never frozen, whatever the lists say.
    let hostile = global(&["general", "tony", "security"], &[]);
    for a in ["general", "tony", "Tony", "dispatcher", "", "security", "observer", "garbage", "trading"] {
        assert!(agent_live(&eff(LEARNING_ID), &hostile, a), "{a:?}");
    }
    // A business workspace and the packet name fold onto their agents.
    assert_eq!(board_agent("bizops_trades"), "bizops");
    assert_eq!(board_agent("financer"), "finance");
    assert!(agent_live(&eff("executive"), &g, "bizops_trades") && agent_live(&eff("executive"), &g, "financer"));
    // Tools: always-live servers, the global freeze, the overlay.
    for s in ["time", "skills", "tony"] {
        assert!(tool_live(&eff(LEARNING_ID), &global(&[], &["time", "skills", "tony"]), s), "{s}");
    }
    assert!(!tool_live(&brainstorm, &g, "instagram"), "globally frozen in every mode");
    assert!(tool_live(&brainstorm, &g, "shotcut"), "no overlay: every server");
    for (s, live) in [("filesystem", true), ("git", true), ("spotify", true), ("weather", true), ("gmail", false), ("whatsapp", false), ("maps", false), ("shotcut", false), ("media-forge", false)] {
        assert_eq!(tool_live(&builder, &g, s), live, "{s}");
    }
    assert!(!tool_live(&eff("operations"), &g, "instagram"), "the master switchboard wins over a mode that lists it");
    assert_eq!(ALWAYS_LIVE_TOOLS, ["time", "skills.read", "tony.set_mode"]);
}

#[test]
fn frozen_reasons_name_the_agent_and_the_mode() {
    let g = global(&["booking"], &["instagram"]);
    assert_eq!(agent_frozen_reason(&eff("builder"), &g, "ops").as_deref(), Some("Ops is frozen in Builder mode"));
    assert_eq!(agent_frozen_reason(&eff("builder"), &g, "bizops").as_deref(), Some("Operations Manager is frozen in Builder mode"));
    assert_eq!(agent_frozen_reason(&eff("brainstorm"), &g, "booking").as_deref(), Some("Booking Desk is frozen on the master switchboard"));
    assert_eq!(agent_frozen_reason(&eff("builder"), &g, "coder"), None);
    assert_eq!(tool_frozen_error(&eff("builder"), &g, "gmail").as_deref(), Some("MODE_FROZEN: gmail is frozen in Builder mode"));
    assert_eq!(tool_frozen_error(&eff("brainstorm"), &g, "instagram").as_deref(), Some("MODE_FROZEN: instagram is frozen on the master switchboard"));
    assert_eq!(tool_frozen_error(&eff("builder"), &g, "time"), None);
    assert_eq!(tool_frozen_reason(&eff("executive"), &g, "maps", "Maps / OpenStreetMap").as_deref(), Some("Maps / OpenStreetMap is frozen in Executive mode"));
    // A custom name that already ends in "mode" isn't doubled.
    let e = Effective { name: "Deep Focus Mode".into(), ..eff("builder") };
    assert_eq!(agent_frozen_reason(&e, &g, "ops").as_deref(), Some("Ops is frozen in Deep Focus mode"));
    // The build pipeline waits while any of its agents is frozen.
    assert_eq!(pipeline_frozen(&eff("builder"), &g), None);
    assert_eq!(pipeline_frozen(&eff("brainstorm"), &g), None);
    assert_eq!(pipeline_frozen(&eff("operations"), &g).as_deref(), Some("Prompter is frozen in Operations mode"));
    assert!(pipeline_frozen(&eff(LEARNING_ID), &g).is_some());
    // A master-switchboard freeze is named first (switching modes won't start the build).
    let designer_off = global(&["booking", "designer"], &[]);
    assert_eq!(pipeline_frozen(&eff("operations"), &designer_off).as_deref(), Some("Designer is frozen on the master switchboard"));
    assert!(pipeline_frozen_on_master(&designer_off) && !pipeline_frozen_on_master(&g) && !pipeline_frozen_on_master(&SwitchboardConfig::default()));
}

#[test]
fn the_default_master_switchboard_freezes_the_librarian_in_every_mode() {
    let g = SwitchboardConfig::default();
    for m in presets() {
        let e = eff(&m.id);
        assert!(!agent_live(&e, &g, "librarian") && !agent_live(&e, &g, "booking"), "{}", m.id);
        assert_eq!(agent_frozen_reason(&e, &g, "librarian").as_deref(), Some("Librarian is frozen on the master switchboard"), "{}", m.id);
    }
    // Executive's overlay no longer lists it; the rest of its duty roster is live.
    assert!(agent_live(&eff("executive"), &g, "bizops") && agent_live(&eff("executive"), &g, "finance"));
    // Thawed on the master switchboard: live wherever the mode has no overlay, still off Executive duty.
    let thawed = global(&["booking"], &[]);
    assert!(agent_live(&eff("brainstorm"), &thawed, "librarian"));
    assert_eq!(agent_frozen_reason(&eff("executive"), &thawed, "librarian").as_deref(), Some("Librarian is frozen in Executive mode"));
}

#[test]
fn on_duty_line_is_deterministic_and_ends_the_block_before_the_notes() {
    assert_eq!(on_duty_line(&eff("builder")).as_deref(), Some("ON DUTY: Coder, Designer, Prompter; every other agent is frozen this mode."));
    assert_eq!(on_duty_line(&eff("operations")).as_deref(), Some("ON DUTY: Operations Manager, Ops; every other agent is frozen this mode."));
    assert_eq!(on_duty_line(&eff("executive")).as_deref(), Some("ON DUTY: Finance, Operations Manager; every other agent is frozen this mode."));
    for id in ["surface", "brainstorm", "coach", "gabagool", LEARNING_ID] {
        assert_eq!(on_duty_line(&eff(id)), None, "{id}");
    }
    // Order in the overlay doesn't matter (sorted labels); an empty overlay outside Learning says so.
    let shuffled = Effective { switchboard: board(&["coder", "prompter", "designer", "coder"], &[]), ..eff("builder") };
    assert_eq!(on_duty_line(&shuffled), on_duty_line(&eff("builder")));
    let none = Effective { switchboard: board(&[], &[]), ..eff("builder") };
    assert_eq!(on_duty_line(&none).as_deref(), Some("ON DUTY: none; every agent is frozen this mode."));
    // Placement: after the dial lines, before MODE NOTES.
    let b = mode_block(&eff("builder"));
    assert!(b.ends_with(&format!("{DISPATCH_AUTO}\nON DUTY: Coder, Designer, Prompter; every other agent is frozen this mode.")), "{b}");
    let notes = Effective { prompt_modifier: "Stay on the spec.".into(), ..eff("builder") };
    assert!(mode_block(&notes).ends_with("every other agent is frozen this mode.\nMODE NOTES: Stay on the spec."));
    // Learning: the protocol, then its own notes in full, no ON DUTY line.
    let l = mode_block(&eff(LEARNING_ID));
    assert!(l.contains(LEARNING_PROTOCOL) && l.ends_with(&format!("\nMODE NOTES: {LEARNING_NOTES}")) && !l.contains("ON DUTY"), "{l}");
    assert!(l.chars().count() <= MODE_BLOCK_MAX);
}

#[test]
fn a_v1_file_is_upgraded_and_a_custom_operations_mode_is_renamed_not_lost() {
    let d = tmp_dir("ops-collision");
    let mine = TonyMode { id: "operations".into(), name: "Operations".into(), ..custom("operations") };
    let v1 = json!({ "version": 1, "active_mode_id": "operations", "modes": [presets()[0], mine] });
    std::fs::write(d.join("modes.json"), v1.to_string()).unwrap();
    let s = ModeStore::default();
    assert_eq!(s.load_or_init(&d), LoadOutcome::Loaded);
    let f = s.file();
    assert_eq!(f.version, MODES_FILE_VERSION);
    let renamed = f.modes.iter().find(|m| m.id == "operations-2").expect("the custom mode is kept under a free id");
    assert_eq!((renamed.name.as_str(), renamed.curiosity_level, renamed.prompt_modifier.as_str()), ("Operations", Curiosity::Low, "Keep answers about the current task."));
    assert_eq!(f.active_mode_id, "operations-2", "the active id follows the rename");
    assert_eq!(f.modes.iter().find(|m| m.id == "operations").unwrap(), &presets()[3], "the id is the preset now");
    // Written back as v2; reloading doesn't rename again.
    let on_disk: ModesFile = serde_json::from_str(&std::fs::read_to_string(d.join("modes.json")).unwrap()).unwrap();
    assert_eq!(on_disk, f);
    let again = ModeStore::default();
    again.load_or_init(&d);
    assert_eq!(again.file(), f);
    // A v2 file's "operations" row is the preset: a tampered copy is restored, not kept.
    let mut tampered = f.clone();
    tampered.modes.iter_mut().find(|m| m.id == "operations").unwrap().switchboard = None;
    assert_eq!(tampered.normalize().modes.iter().find(|m| m.id == "operations").unwrap(), &presets()[3]);
    // A v1 file without that id upgrades with nothing renamed.
    let plain = ModesFile { version: 1, active_mode_id: "builder".into(), modes: vec![custom("deep-focus")] }.normalize();
    assert_eq!((plain.version, plain.modes.len(), plain.active_mode_id.as_str()), (MODES_FILE_VERSION, 9, "builder"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn validate_mode_checks_the_overlay() {
    let ok = TonyMode { switchboard: board(&["coder", "security-patrol"], &["filesystem", "media-forge"]), ..custom("deep-focus") };
    assert!(validate_mode(&ok).is_ok());
    for bad in [
        board(&["tony"], &[]),
        board(&["general"], &[]),
        board(&["Coder"], &[]),
        board(&["../x"], &[]),
        board(&["json-agent"], &[]),
        board(&[], &["bad id!"]),
    ] {
        assert!(validate_mode(&TonyMode { switchboard: bad.clone(), ..custom("deep-focus") }).is_err(), "{bad:?}");
    }
    let many: Vec<String> = (0..17).map(|i| format!("a{i}")).collect();
    assert!(validate_mode(&TonyMode { switchboard: Some(ModeSwitchboard { agents: many.clone(), tools: vec![] }), ..custom("deep-focus") }).is_err());
    assert!(validate_mode(&TonyMode { switchboard: Some(ModeSwitchboard { agents: vec![], tools: many }), ..custom("deep-focus") }).is_err());
    let sixteen: Vec<String> = (0..16).map(|i| format!("a{i}")).collect();
    assert!(validate_mode(&TonyMode { switchboard: Some(ModeSwitchboard { agents: sixteen, tools: vec![] }), ..custom("deep-focus") }).is_ok());
}

#[test]
fn the_worker_holds_queued_builds_while_a_pipeline_agent_is_frozen() {
    use super::super::taskworker::worker_held;
    let g = global(&["booking"], &[]);
    for (id, held) in [("builder", false), ("brainstorm", false), ("surface", false), ("coach", false), ("operations", true), ("executive", true), (LEARNING_ID, true)] {
        assert_eq!(worker_held(&eff(id), &g), held, "{id}");
    }
    // A custom overlay without the Designer holds the queue too; with all three it runs.
    let partial = Effective { switchboard: board(&["prompter", "coder"], &[]), ..eff("brainstorm") };
    assert!(worker_held(&partial, &g));
    let full = Effective { switchboard: board(&["prompter", "designer", "coder", "ops"], &[]), ..eff("brainstorm") };
    assert!(!worker_held(&full, &g));
    // The master switchboard freezing the Coder holds it in every mode.
    assert!(worker_held(&eff("builder"), &global(&["coder"], &[])));
}
