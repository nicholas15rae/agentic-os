//! Quality-gate unit tests, plus real headless-Edge runs (skipped where Edge is not installed;
//! temp files only, the network unreachable).

use super::*;

#[test]
fn literals_keep_nics_numbers_units_ranges_and_thousands() {
    let l = intent_literals("I'm 165 lbs and want 3-5 meals a day, about 0.8 g/kg. Works offline.");
    let p: Vec<&str> = l.iter().map(|l| l.phrase.as_str()).collect();
    assert_eq!(p, vec!["165 lbs", "3-5 meals", "0.8 g/kg"]);
    assert_eq!((l[1].low.as_deref(), l[1].number.as_str()), (Some("3"), "5"), "a range stays a range");
    assert!(intent_literals("Build a pomodoro timer with a soft chime").is_empty());
    assert_eq!(literals_line("a 25 min timer, then a 25 minute review and a 5 min break"), "25 min; 5 min", "same number + unit family is deduped");
    assert_eq!(intent_literals("weigh 70kg")[0].phrase, "70kg");
    // Thousands separators: the whole number, never "000 steps".
    let t = intent_literals("a goal of 10,000 steps a day and about 2,000 calories");
    assert_eq!(t.iter().map(|l| (l.number.as_str(), l.phrase.as_str())).collect::<Vec<_>>(), vec![("10000", "10,000 steps"), ("2000", "2,000 calories")]);
    assert_eq!(intent_literals("3 to 5 meals")[0].phrase, "3 to 5 meals");
    // "from 180 to 165 lbs" is a change, not a range.
    let d = intent_literals("I went from 180 to 165 lbs");
    assert_eq!((d[0].phrase.as_str(), d[0].low.clone()), ("165 lbs", None));
}

#[test]
fn a_page_that_lost_the_value_or_its_unit_is_flagged() {
    let lits = intent_literals("I'm 165 lbs");
    assert!(missing_literals(r#"<input id="w" value="165"> <span>lb</span>"#, &lits).is_empty());
    assert_eq!(missing_literals(r#"<input id="w" value="75"> kg"#, &lits).len(), 1);
    assert_eq!(missing_literals(r#"<input value="1650"> lb"#, &lits).len(), 1, "1650 is not 165");
    assert_eq!(missing_literals(r#"<input value="165"> kg"#, &lits).len(), 1, "the unit must be there too");
    // CSS never supplies a value or a unit: `background` contains "kg", rgb() contains 165.
    let kg = intent_literals("I weigh 70 kg");
    assert_eq!(missing_literals(r#"<style>body{background:#fff}</style><label>Weight (lbs)</label><input value="70">"#, &kg).len(), 1, "background is not kg");
    assert!(missing_literals(r#"<style>body{background:#fff}</style><label>Weight (kg)</label><input value="70">"#, &kg).is_empty());
    let far = format!(r#"<style>.ok{{color:rgb(34,165,94)}}</style><p>{}</p><p>lb</p>"#, "filler text ".repeat(30));
    assert_eq!(missing_literals(&far, &lits).len(), 1, "165 in CSS and a far-away lb do not make 165 lbs");
    assert!(missing_literals("<script>let state = { unit: 'lbs', // default\n weight: 165 };</script>", &lits).is_empty(), "number and unit near each other in code");
    // Thousands: 10000 or 10,000 on the page both carry Nic's 10,000 steps.
    let steps = intent_literals("10,000 steps a day");
    assert!(missing_literals(r#"<label>Daily steps goal</label><input type="number" value="10000">"#, &steps).is_empty());
    assert!(missing_literals(r#"<p>Goal: 10,000 steps</p>"#, &steps).is_empty());
    assert_eq!(missing_literals(r#"<style>a{color:#000}</style><p>steps</p>"#, &steps).len(), 1);
    // A range needs every end.
    let meals = intent_literals("3-5 meals a day");
    assert!(missing_literals(r#"<button data-meals="3">3 meals</button><button data-meals="4">4</button><button data-meals="5">5 meals</button>"#, &meals).is_empty());
    let one = missing_literals(r#"<p>5 meals</p>"#, &meals);
    assert!(one.len() == 1 && one[0].contains("range \"3-5 meals\""), "{one:?}");
}

#[test]
fn script_ids_must_exist_in_the_markup() {
    let html = r#"<input id="weight"><div id='out'></div><p id=bare></p><script>
        document.getElementById("weight"); document.querySelector('#out'); document.getElementById('bare');
        document.getElementById('ghost'); const d = document.createElement('p'); d.id = 'made';
        document.getElementById('made'); el.innerHTML = `<b id="tpl"></b>`; document.getElementById("tpl");
    </script>"#;
    assert_eq!(dom_id_gaps(html), vec!["ghost".to_string()]);
    // A commented-out lookup or a <pre> sample is not code that runs.
    let commented = r#"<p id="a"></p><pre>document.getElementById('sample')</pre><!-- getElementById('old') --><script>
        // const old = document.getElementById('legacy-total');
        /* document.getElementById('gone') */ document.getElementById('a');
    </script>"#;
    assert!(dom_id_gaps(commented).is_empty(), "{:?}", dom_id_gaps(commented));
    // data-id="x", a JS variable named id, or x.id = getId() never define an element id.
    let fake_defs = r#"<li data-id="summary"></li><script>const id = 'total'; x.id = getId();
        document.getElementById('summary').textContent = 1; document.getElementById('total'); document.getElementById('getId');</script>"#;
    assert_eq!(dom_id_gaps(fake_defs), vec!["summary".to_string(), "total".to_string(), "getId".to_string()]);
}

#[test]
fn storage_outside_try_is_counted() {
    let page = |s: &str| format!("<html><body><script>{s}</script></body></html>");
    assert_eq!(unguarded_storage(&page("const s = JSON.parse(localStorage.getItem('a') || '{}');")), 1);
    assert_eq!(unguarded_storage(&page("function load(){ try { return localStorage.getItem('a') } catch (e) { return null } }")), 0);
    assert_eq!(unguarded_storage(&page("try { x() } catch (e) { localStorage.clear() }")), 1, "a catch block is not guarded");
    assert_eq!(unguarded_storage(&page("// localStorage.getItem('x')\nconst t = 'localStorage';")), 0, "comments and strings are skipped");
    // A helper only ever called inside try is guarded (also through another such helper)…
    assert_eq!(unguarded_storage(&page("function save(){ localStorage.setItem('k','v') }\nfunction persist(){ save() }\nbtn.onclick = () => { try { persist() } catch (e) {} };")), 0);
    let arrow = page("const save = () => { localStorage.setItem('k', 'v') };\ntry { save() } catch (e) {}");
    assert_eq!(unguarded_storage(&arrow), 0);
    // …but not when it is also used unguarded (a direct call or a handler reference).
    assert_eq!(unguarded_storage(&page("function save(){ localStorage.setItem('k','v') }\ntry { save() } catch (e) {}\nbtn.addEventListener('click', save);")), 1);
    // A storage-ok flag set inside a try that touched storage guards later uses.
    assert_eq!(unguarded_storage(&page("let ok = false; try { localStorage.setItem('t','t'); ok = true } catch (e) {}\nfunction save(){ if (!ok) return; localStorage.setItem('k','v') }\nsave();")), 0);
    assert_eq!(unguarded_storage(&page("function storageOk(){ try { localStorage.setItem('t','t'); localStorage.removeItem('t'); return true } catch (e) { return false } }\nif (storageOk()) localStorage.setItem('k', 'v');")), 0);
    let iife = page("const canStore = (() => { try { localStorage.setItem('t', '1'); return true } catch { return false } })();\nfunction save(){ if (canStore) localStorage.setItem('k', 'v') }\nsave();");
    assert_eq!(unguarded_storage(&iife), 0);
    // Lines are page lines.
    let lined = "<html>\n<body>\n<script>\nlet a = 1;\nconst s = localStorage.getItem('a');\n</script></body></html>";
    assert_eq!(unguarded_storage_lines(lined), vec![5]);
}

#[test]
fn evidence_must_be_real_code_from_the_page() {
    let html = "<script>\nfunction addFood(name, grams) {\n  state.items.push({ name, grams });\n  render();\n  updateDisplay();\n}\nfunction toggleUnit(unit) { state.unit = unit; }\n</script>";
    let hn = norm(html);
    assert!(evidence_found(&hn, "state.items.push({ name, grams });"));
    assert!(evidence_found(&hn, "function addFood(name, grams) {\n...\nrender();"), "a dropped generic call line is fine");
    // One made-up line next to a real generic call is not evidence.
    assert!(!evidence_found(&hn, "els.weightInput.value = toKg(state.weight);\nupdateDisplay();"));
    assert!(!evidence_found(&hn, "updateDisplay();"), "a bare generic call proves nothing");
    assert!(!evidence_found(&hn, "unit"), "a word that occurs somewhere proves nothing");
    assert!(!evidence_found(&hn, "state.items.push({ name, grams });\nstate.total += grams;"), "every quoted line must be there");
    assert!(evidence_found(&hn, "function toggleUnit(unit) { state.unit = unit; }"));
}

fn crit_list() -> Vec<String> {
    vec!["The lb/kg toggle converts the weight".into(), "Meal split offers 3, 4 and 5 meals in order".into(), "Saved state is shown after a reload".into()]
}

#[test]
fn answers_are_read_leniently_and_matched_to_the_requested_criteria() {
    let a = read_answers(
        &json!([
            { "n": 2, "criterion": "split", "met": "yes", "evidence": ["const a = 1;", "const b = 2;"] },
            { "criterion": "The lb/kg toggle converts the weight", "met": 1, "evidence": "x" },
            { "criterion": "3. saved state", "met": "not shown" }
        ]),
        &crit_list(),
    );
    assert_eq!(a.list.iter().map(|x| x.idx).collect::<Vec<_>>(), vec![Some(1), Some(0), Some(2)]);
    assert_eq!(a.list.iter().map(|x| x.met).collect::<Vec<_>>(), vec![Some(true), Some(true), None]);
    assert_eq!(a.list[0].evidence, "const a = 1;\nconst b = 2;", "an evidence array is joined");
    assert!(a.missing.is_empty());
    assert!(a.incomplete(false), "an undecided criterion whose code was shown: ask again");
    assert!(!a.incomplete(true), "…unless its code was cut from the view");
    // Fewer answers than criteria: the rest are missing (never silently passed).
    let b = read_answers(&json!([{ "criterion": "page renders", "met": true, "evidence": "<div class=\"container\">" }]), &crit_list());
    assert_eq!(b.missing.len(), 3, "an unrelated answer covers nothing");
    assert!(b.incomplete(true));
    // Same count, unmatched names: taken by position.
    let c = read_answers(&json!([{ "criterion": "a", "met": true }, { "criterion": "b", "met": true }, { "criterion": "c", "met": false }]), &crit_list());
    assert_eq!(c.list.iter().map(|x| x.idx).collect::<Vec<_>>(), vec![Some(0), Some(1), Some(2)]);
    assert!(read_answers(&Value::Null, &crit_list()).list.is_empty());
}

#[test]
fn probe_steps_are_validated_as_untrusted_data() {
    let ok = parse_probe(&json!([{ "op": "set", "sel": "#weight-input", "value": 165 }, { "op": "CLICK", "sel": "#kg-toggle" }, { "op": "expect_value", "sel": "#weight-input", "approx": "74.8" }])).unwrap();
    assert_eq!(ok[0], json!({ "op": "set", "sel": "#weight-input", "nth": 0, "value": "165" }));
    assert_eq!(ok[1]["op"], "click");
    assert_eq!(ok[2]["approx"].as_f64(), Some(74.8));
    assert!((ok[2]["tol"].as_f64().unwrap() - 0.748).abs() < 1e-9, "default tolerance: 1% (at least 0.5)");
    assert!(parse_probe(&json!({ "steps": [{ "op": "expect_order", "sel": ".split-btn", "attr": "data-meals", "order": [3, 4, 5] }] })).unwrap()[0]["order"] == json!(["3", "4", "5"]));
    let bad = |v: Value| parse_probe(&v).unwrap_err();
    assert!(bad(json!([{ "op": "click", "sel": "#a" }])).contains("expects nothing"));
    assert!(bad(json!([{ "op": "eval", "js": "alert(1)" }])).contains("unknown op"));
    assert!(bad(json!([{ "op": "click", "sel": "a</script><script>x()" }, { "op": "expect_count", "sel": "a", "count": 1 }])).contains("selector"));
    assert!(bad(json!([{ "op": "expect_text", "sel": "#a{color:red}" , "contains": "x" }])).contains("selector"));
    assert!(bad(json!([{ "op": "expect_text", "sel": "#a" }])).contains("contains, equals or approx"));
    assert!(bad(json!([{ "op": "expect_class", "sel": "#a", "class": "x\" onload=\"y" }])).contains("class name"));
    assert!(bad(json!([{ "op": "expect_order", "sel": "#a", "order": ["1"] }])).contains("2-12"));
    assert!(bad(json!(vec![json!({ "op": "click", "sel": "#a" }); 9])).contains("at most 8"));
    assert!(bad(json!("click the button")).contains("not a list"));
    // Values are inert JSON in the harness: a closing script tag cannot break out.
    let p = Probe { answer: 0, criterion: "x".into(), carried: false, steps: parse_probe(&json!([{ "op": "set", "sel": "#a", "value": "</script><script>alert(1)</script>" }, { "op": "expect_count", "sel": "#a", "count": 1 }])).unwrap() };
    let page = with_probes("<html><head></head><body></body></html>", &[p]);
    assert_eq!(page.matches("</script>").count(), 1, "only the harness's own closing tag");
    assert!(page.contains("\\u003c/script\\u003e"));
}

fn probe(answer: usize, steps: Value) -> Probe {
    Probe { answer, criterion: format!("c{answer}"), steps: parse_probe(&steps).unwrap(), carried: false }
}

#[test]
fn probe_results_name_the_steps_and_both_values() {
    let toggle = probe(0, json!([{ "op": "set", "sel": "#weight-input", "value": "165" }, { "op": "click", "sel": "#kg-toggle" }, { "op": "expect_value", "sel": "#weight-input", "approx": 74.8, "tol": 0.5 }]));
    let order = probe(1, json!([{ "op": "expect_order", "sel": ".split-btn", "attr": "data-meals", "order": ["3", "4", "5"] }]));
    let ghost = probe(2, json!([{ "op": "click", "sel": "#nope" }, { "op": "expect_count", "sel": ".row", "count": 1 }]));
    let threw = probe(3, json!([{ "op": "click", "sel": "#go", "nth": 1 }, { "op": "expect_count", "sel": ".row", "count": 1 }]));
    let r = probe_results(
        &[toggle, order, ghost, threw.clone(), threw],
        &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }, { "ok": false, "k": "fail", "at": 0, "got": "3, 5, 4" }, { "ok": false, "k": "nomatch", "at": 0 }, { "ok": false, "k": "threw", "at": 0, "got": "Uncaught TypeError: x is undefined" }]),
    );
    // What the page produced leads (a fix line is clipped from its end).
    assert_eq!(r[0].detail, "got 165; expected #weight-input value ≈74.8 (±0.5) after set #weight-input=165, click #kg-toggle");
    assert_eq!(r[1].detail, "got 3, 5, 4; expected .split-btn (data-meals) in the order 3, 4, 5 on a fresh load");
    assert!(r[2].error && r[2].detail.contains("#nope matches nothing"), "{:?}", r[2]);
    assert!(!r[3].error && r[3].detail.starts_with("the page threw: Uncaught TypeError: x is undefined; after click #go[1]"), "{:?}", r[3]);
    assert!(!r[4].ran, "a probe the page never reached");
}

#[test]
fn judging_counts_probe_failures_first_and_a_broken_probe_only_without_evidence() {
    let html = "<script>\nfunction toggleUnit(unit) { if (unit === 'kg') { state.unit = 'kg'; } }\nconst splits = [3, 5, 4];\n</script>";
    let answers = read_answers(
        &json!([
            { "n": 1, "criterion": "The lb/kg toggle converts the weight", "met": true, "evidence": "function toggleUnit(unit) { if (unit === 'kg') { state.unit = 'kg'; } }",
              "probe": [{ "op": "set", "sel": "#w", "value": "165" }, { "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }] },
            { "n": 2, "criterion": "Meal split offers 3, 4 and 5 meals in order", "met": true, "evidence": "const splits = [3, 5, 4];",
              "probe": [{ "op": "expect_order", "sel": ".nope", "order": ["3", "4", "5"] }] },
            { "n": 3, "criterion": "Saved state is shown after a reload", "met": true, "evidence": "Object.assign(state, saved); // made up",
              "probe": [{ "op": "click", "sel": "#ghost" }, { "op": "expect_count", "sel": ".x", "count": 1 }] }
        ]),
        &crit_list(),
    );
    let probes = probes_of(&answers, &[]);
    assert_eq!(probes.len(), 3);
    let run = ProbeRun::Ran(probe_results(&probes, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }, { "ok": false, "k": "nomatch", "at": 0 }, { "ok": false, "k": "nomatch", "at": 0 }])));
    let j = judge(&answers, html, false, &run, &[], false);
    assert_eq!(j.unmet.len(), 2, "{:?}", j.unmet);
    assert!(j.unmet[0].starts_with("probe failed for The lb/kg toggle converts the weight: got 165; expected #w value ≈74.8"), "{:?}", j.unmet);
    // Criterion 2: its probe's selector matched nothing but the evidence is real: not counted.
    assert!(!j.unmet.iter().any(|u| u.contains("Meal split")));
    assert_eq!(j.criteria[1]["probe"]["error"], true);
    // Criterion 3: no real evidence AND a broken probe: unmet, with the probe named.
    assert!(j.unmet[1].starts_with("no working code found for: Saved state") && j.unmet[1].contains("#ghost matches nothing"), "{:?}", j.unmet);
    // Probes that did not run: evidence decides, the record says why.
    let skipped = judge(&answers, html, false, &ProbeRun::Skipped("Edge is not installed".into()), &[], false);
    assert_eq!(skipped.unmet.len(), 1, "only the unevidenced one");
    assert_eq!(skipped.criteria[0]["probe"]["detail"], "skipped: Edge is not installed");
    // Undecided criteria: "not shown" when the code was cut, never unmet.
    let shown = read_answers(&json!([{ "n": 1, "criterion": "x", "met": null }]), &crit_list()[..1]);
    let j = judge(&shown, html, true, &ProbeRun::Skipped("no probes".into()), &[], false);
    assert!(j.unmet.is_empty() && j.not_judged[0].starts_with("not shown to the verifier"), "{j:?}");
    // A rejected probe is reported, never run.
    let rejected = read_answers(&json!([{ "n": 1, "criterion": "x", "met": true, "evidence": "function toggleUnit(unit) {", "probe": [{ "op": "eval" }] }]), &crit_list()[..1]);
    assert!(probes_of(&rejected, &[]).is_empty());
    let j = judge(&rejected, html, false, &ProbeRun::Skipped("no probes".into()), &[], false);
    assert!(j.criteria[0]["probe"]["detail"].as_str().unwrap().starts_with("probe rejected"));
    assert!(judge(&read_answers(&Value::Null, &crit_list()), html, false, &ProbeRun::Skipped(String::new()), &[], false).absent);
}

#[test]
fn the_verifier_reads_the_scripts_first_and_whole() {
    // The protein-tracker-2 shape: lots of CSS and markup, the buggy functions mid-script.
    let css = format!("<style>{}</style>", ".card { padding: 1rem; background: #fff; border-radius: 12px; }\n".repeat(90));
    let markup = "<div class=\"card\"><label>Weight</label><input id=\"w\"></div>\n".repeat(40);
    let script = format!("<script>\n{}\nfunction toggleUnit(unit) {{ state.unit = unit; if (state.unit !== unit) {{ convert(); }} }}\n{}\n</script>", "const a = 1; // setup line\n".repeat(150), "const z = 2; // render line\n".repeat(80));
    let html = format!("<!doctype html><html><head>{css}</head><body>{markup}{script}</body></html>");
    assert!(html.chars().count() > 14_000);
    let (view, cut) = verify_view(&html, 11_000);
    assert!(!cut);
    assert!(view.chars().count() <= 11_000, "{}", view.chars().count());
    assert!(view.contains("function toggleUnit(unit)"), "the middle of the script is shown");
    assert!(view.find("toggleUnit").unwrap() < view.find("<label>").unwrap(), "scripts first");
    assert!(view.contains("/* CSS omitted */") && !view.contains("border-radius"));
    // Scripts alone too long: their middle is cut as a last resort, and the view says so.
    let huge = format!("<html><body><p>x</p><script>{}</script></body></html>", "let v = 1; // a long script line here\n".repeat(600));
    let (view, cut) = verify_view(&huge, 11_000);
    assert!(cut && view.contains("chars omitted") && view.chars().count() <= 11_000);
    assert_eq!(verify_view("<p>short</p>", 11_000).1, false);
}

#[test]
fn harnesses_go_first_in_head_on_one_line_and_the_dump_parses() {
    let page = "<!doctype html><html><head><title>t</title></head>\n<body>\n</body></html>";
    let h = with_harness(page);
    assert!(h.find("data-tf-smoke").unwrap() < h.find("<title>").unwrap());
    assert_eq!(h.matches('\n').count(), page.matches('\n').count(), "the page keeps its line numbers");
    assert!(with_harness("<p>bare</p>").starts_with("<script>"));
    let dom = r#"<html data-tf-smoke="{&quot;errors&quot;:[&quot;Uncaught TypeError: x is null&quot;,&quot;b&quot;],&quot;load&quot;:1,&quot;storage&quot;:[5,9]}"><head>"#;
    assert_eq!(parse_dump(dom), Some((vec!["Uncaught TypeError: x is null".to_string(), "b".to_string()], 1, vec![5, 9])));
    assert_eq!(parse_dump("<html><head>"), None);
}

// ── Real headless Edge (skipped where it is not installed) ─────────────────

fn edge_dir(tag: &str) -> Option<PathBuf> {
    browser()?;
    let dir = std::env::temp_dir().join(format!("tf-smoke-test-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    Some(dir)
}

/// A page that crashes on load with storage blocked is caught; a guarded one is clean; a handler
/// error is caught; buttons removed by an earlier click are not clicked; a guarded storage line
/// the smoke reached is reported; an export button neither downloads nor hangs Edge.
#[test]
fn runtime_smoke_catches_an_unguarded_storage_crash() {
    let Some(dir) = edge_dir("smoke") else { return };
    let w = |name: &str, html: &str| {
        let p = dir.join(name);
        std::fs::write(&p, html).unwrap();
        p
    };
    let bad = w("bad.html", "<!doctype html><html><head><title>x</title></head><body><p id=o>--</p><script>const s = localStorage.getItem('a'); document.getElementById('o').textContent = 'ok';</script></body></html>");
    let good = w("good.html", "<!doctype html><html><head><title>x</title></head><body><input id=w type=number><p id=o>--</p><script>let s=null; try { s = localStorage.getItem('a') } catch (e) {} document.getElementById('w').addEventListener('input', e => { document.getElementById('o').textContent = e.target.value * 2 });</script></body></html>");
    let handler = w("handler.html", "<!doctype html><html><head><title>x</title></head><body><button id=b>Add</button><script>document.getElementById('b').onclick = () => { document.getElementById('nope').textContent = 1 };</script></body></html>");
    let list = w("list.html", "<!doctype html><html><head><title>x</title></head><body><ul id=l></ul><script>let items=[{name:'a'},{name:'b'}];function render(){const l=document.getElementById('l');l.innerHTML='';items.forEach((it,i)=>{const b=document.createElement('button');b.textContent='del';b.onclick=()=>{const x=items[i];items.splice(i,1);render();document.title=x.name+' removed'};l.appendChild(b)})}render();</script></body></html>");
    let caught_html = "<!doctype html>\n<html><head><title>x</title></head><body>\n<script>\nconst fns = [() => localStorage.setItem('k', 'v')];\ntry { fns[0]() } catch (e) {}\n</script></body></html>";
    let caught = w("caught.html", caught_html);
    let export = w("export.html", "<!doctype html><html><head><title>x</title></head><body><button id=x>Export CSV</button><script>document.getElementById('x').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['a,b'],{type:'text/csv'}));a.download='tf-export-test.csv';document.body.appendChild(a);a.click();};</script></body></html>");
    let t = Duration::from_secs(30);
    match runtime_smoke(&bad, t) {
        Smoke::Ran { errors, .. } => assert!(errors.iter().any(|e| e.contains("on load") && e.contains("localStorage")), "{errors:?}"),
        o => panic!("{o:?}"),
    }
    assert!(matches!(runtime_smoke(&good, t), Smoke::Ran { errors, .. } if errors.is_empty()));
    match runtime_smoke(&handler, t) {
        Smoke::Ran { errors, .. } => assert!(errors.iter().any(|e| e.contains("controls are used")), "{errors:?}"),
        o => panic!("{o:?}"),
    }
    assert!(matches!(runtime_smoke(&list, t), Smoke::Ran { errors, .. } if errors.is_empty()), "a detached delete button is never clicked");
    // The scan flags the arrow (no try around it); the smoke saw that very line caught.
    let lines = unguarded_storage_lines(caught_html);
    assert_eq!(lines, vec![4]);
    match runtime_smoke(&caught, t) {
        Smoke::Ran { errors, storage_lines } => assert!(errors.is_empty() && storage_lines.contains(&4), "{errors:?} {storage_lines:?}"),
        o => panic!("{o:?}"),
    }
    let t0 = Instant::now();
    assert!(matches!(runtime_smoke(&export, t), Smoke::Ran { errors, .. } if errors.is_empty()));
    assert!(t0.elapsed() < Duration::from_secs(20), "an export button does not keep Edge alive");
    let _ = std::fs::remove_dir_all(&dir);
}

const PROTEIN_BUG: &str = r#"<!doctype html>
<html><head><title>Protein</title></head><body>
<input id="weight-input" type="number" value="165">
<div><button id="kg-toggle" class="unit active">kg</button><button id="lbs-toggle" class="unit">lbs</button></div>
<div><button class="split-btn" data-meals="3">3</button><button class="split-btn active" data-meals="5">5</button><button class="split-btn" data-meals="4">4</button></div>
<p id="target">--</p>
<script>
let state = { unit: 'lbs', weight: 165 };
const w = document.getElementById('weight-input');
function render() { w.value = state.weight; document.getElementById('target').textContent = Math.round(state.weight * 0.8) + ' g'; }
function save() { try { localStorage.setItem('st', JSON.stringify(state)) } catch (e) {} }
function toggleUnit(unit) {
  const v = parseFloat(w.value);
  if (unit === 'kg') { state.unit = 'kg'; } else { state.unit = 'lbs'; }
  if (state.unit !== unit) { const nv = unit === 'kg' ? v * 0.453592 : v / 0.453592; state.weight = parseFloat(nv.toFixed(1)); }
  document.getElementById('kg-toggle').classList.toggle('active', state.unit === 'kg');
  document.getElementById('lbs-toggle').classList.toggle('active', state.unit === 'lbs');
  render(); save();
}
function init() {
  render();
  try { const s = JSON.parse(localStorage.getItem('st') || 'null'); if (s) Object.assign(state, s); } catch (e) {}
  document.getElementById('kg-toggle').addEventListener('click', () => toggleUnit('kg'));
  document.getElementById('lbs-toggle').addEventListener('click', () => toggleUnit('lbs'));
  w.addEventListener('input', () => { state.weight = parseFloat(w.value) || 0; save(); });
}
init();
</script></body></html>"#;

/// The protein-tracker-2 bugs as a page, and the same page fixed.
fn protein_fixed() -> String {
    PROTEIN_BUG
        .replace("if (state.unit !== unit) { const nv = unit === 'kg' ? v * 0.453592 : v / 0.453592; state.weight = parseFloat(nv.toFixed(1)); }\n", "")
        .replace("  if (unit === 'kg') { state.unit = 'kg'; } else { state.unit = 'lbs'; }\n", "  if (state.unit !== unit) { const nv = unit === 'kg' ? v * 0.453592 : v / 0.453592; state.weight = parseFloat(nv.toFixed(1)); state.unit = unit; }\n")
        .replace("  if (state.unit !== unit) { const nv = unit === 'kg' ? v * 0.453592 : v / 0.453592; state.weight = parseFloat(nv.toFixed(1)); }\n", "")
        .replace("class=\"unit active\">kg", "class=\"unit\">kg")
        .replace("class=\"unit\">lbs", "class=\"unit active\">lbs")
        .replace("data-meals=\"5\">5</button><button class=\"split-btn\" data-meals=\"4\">4", "data-meals=\"4\">4</button><button class=\"split-btn\" data-meals=\"5\">5")
        .replace("  render();\n  try { const s = JSON.parse(localStorage.getItem('st') || 'null'); if (s) Object.assign(state, s); } catch (e) {}\n", "  try { const s = JSON.parse(localStorage.getItem('st') || 'null'); if (s) Object.assign(state, s); } catch (e) {}\n  render();\n")
}

fn protein_probes() -> Vec<Probe> {
    vec![
        probe(0, json!([{ "op": "set", "sel": "#weight-input", "value": "165" }, { "op": "click", "sel": "#kg-toggle" }, { "op": "expect_value", "sel": "#weight-input", "approx": 74.8, "tol": 0.5 }])),
        probe(1, json!([{ "op": "expect_order", "sel": ".split-btn", "attr": "data-meals", "order": ["3", "4", "5"] }])),
        probe(2, json!([{ "op": "expect_class", "sel": "#lbs-toggle", "class": "active", "present": true }, { "op": "expect_class", "sel": "#kg-toggle", "class": "active", "present": false }])),
        probe(3, json!([{ "op": "set", "sel": "#weight-input", "value": "170" }, { "op": "reload" }, { "op": "expect_value", "sel": "#weight-input", "approx": 170, "tol": 0.5 }])),
        // A fresh load per probe: the 170 saved above must not leak in here.
        probe(4, json!([{ "op": "expect_value", "sel": "#weight-input", "approx": 165, "tol": 0.5 }, { "op": "expect_text", "sel": "#target", "contains": "132 g" }])),
        probe(5, json!([{ "op": "click", "sel": "#nope" }, { "op": "expect_count", "sel": ".split-btn", "count": 3 }])),
    ]
}

/// Real headless Edge: the probes catch every protein-tracker-2 behavioural bug the 9B verifier
/// passed (toggle never converts, split order 3,5,4, kg marked active, saved state never shown),
/// and the fixed page passes them. Each probe runs on a fresh load.
#[test]
fn probes_catch_the_protein_tracker_bugs_in_a_real_browser() {
    let Some(dir) = edge_dir("probes") else { return };
    let bug = dir.join("bug.html");
    std::fs::write(&bug, PROTEIN_BUG).unwrap();
    let fixed = dir.join("fixed.html");
    let fixed_html = protein_fixed();
    assert_ne!(fixed_html, PROTEIN_BUG);
    std::fs::write(&fixed, &fixed_html).unwrap();
    let probes = protein_probes();
    let t = Duration::from_secs(40);
    let ProbeRun::Ran(b) = run_probes(&bug, &probes, t, t * 6) else { panic!("edge ran") };
    let d: Vec<&str> = b.iter().map(|r| r.detail.as_str()).collect();
    assert!(b[0].ran && !b[0].passed && !b[0].error && d[0].starts_with("got 165; expected #weight-input value ≈74.8 (±0.5)"), "{d:?}");
    assert!(!b[1].passed && d[1].contains("got 3, 5, 4"), "{d:?}");
    assert!(!b[2].passed && d[2].contains("#lbs-toggle"), "{d:?}");
    assert!(!b[3].passed && d[3] == "got 165; expected #weight-input value ≈170 (±0.5) after set #weight-input=170, reload", "{d:?}");
    assert!(b[4].passed, "{d:?}");
    assert!(b[5].error && d[5].contains("#nope matches nothing"), "{d:?}");
    let ProbeRun::Ran(f) = run_probes(&fixed, &probes, t, t * 6) else { panic!("edge ran") };
    let fd: Vec<&str> = f.iter().map(|r| r.detail.as_str()).collect();
    assert!(f[..5].iter().all(|r| r.passed), "{fd:?}");
    assert!(f[5].error, "{fd:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Review fixes on the probes (af2bc62) ────────────────────────────────────

/// A storage-ok flag guards only the use inside its `if` branch (or after `if (!flag) return`);
/// any other earlier mention of a flag function guards nothing.
#[test]
fn a_storage_flag_guards_only_its_own_branch() {
    let page = |s: &str| format!("<html><body><script>{s}</script></body></html>");
    let load = "function loadState(){ try { const raw = localStorage.getItem('pt'); if (!raw) return false; Object.assign(state, JSON.parse(raw)); return true; } catch (e) { return false; } }\n";
    // The finding's pattern: `if (loadState())` guards the toast, not the later setItem.
    assert_eq!(unguarded_storage(&page(&format!("{load}function init(){{ if (loadState()) showToast('Welcome back'); render(); localStorage.setItem('lastVisit', Date.now()); }}\ninit();"))), 1);
    // Inside the branch (statement or block) it is guarded.
    assert_eq!(unguarded_storage(&page(&format!("{load}function init(){{ if (loadState()) localStorage.setItem('lastVisit', 1); }}"))), 0);
    assert_eq!(unguarded_storage(&page(&format!("{load}function init(){{ if (loadState()) {{ render(); localStorage.setItem('lastVisit', 1); }} }}"))), 0);
    // A negated flag only guards after an early return, not after an early anything-else.
    let ok = "let ok = false; try { localStorage.setItem('t','t'); ok = true } catch (e) {}\n";
    assert_eq!(unguarded_storage(&page(&format!("{ok}function save(){{ if (!ok) {{ return; }} localStorage.setItem('k','v') }}"))), 0);
    assert_eq!(unguarded_storage(&page(&format!("{ok}function save(){{ if (!ok) console.log('no'); localStorage.setItem('k','v') }}"))), 1);
    // A flag read in an unrelated call / a nested callback's early return guards nothing.
    assert_eq!(unguarded_storage(&page(&format!("{ok}function save(){{ log(ok); localStorage.setItem('k','v') }}"))), 1);
    assert_eq!(unguarded_storage(&page(&format!("{ok}function save(){{ list.forEach(x => {{ if (!ok) return; }}); localStorage.setItem('k','v') }}"))), 1);
    // The flag before the use inside the condition itself.
    assert_eq!(unguarded_storage(&page(&format!("{ok}if (ok && localStorage.getItem('k')) go();"))), 0);
}

/// Only the markup's middle cut (the scripts fit whole) is a cut too: the omitted markup can hold
/// the very buttons a criterion is about, so those criteria may be "not shown".
#[test]
fn a_markup_only_cut_is_reported_as_a_cut() {
    let script = format!("<script>\n{}</script>", "const value = compute(1); // a script line\n".repeat(180));
    let markup = "<div class=\"row\"><button class=\"split-btn\" data-meals=\"3\">3 meals</button></div>\n".repeat(45);
    let html = format!("<html><body>{markup}{script}</body></html>");
    let (view, cut) = verify_view(&html, 11_000);
    assert!(view.contains("chars omitted"), "the markup was cut");
    assert!(cut, "a markup cut is reported");
    assert!(view.chars().count() <= 11_000);
    assert!(!view[..view.find("the page's markup").unwrap()].contains("chars omitted"), "the scripts are whole");
}

/// A probe fix line keeps what the page produced even with a long criterion and step trail.
#[test]
fn a_probe_fix_line_keeps_the_observed_value() {
    let long = probe(0, json!([
        { "op": "set", "sel": "#protein-goal-input", "value": "150" }, { "op": "select", "sel": "#meal-count-select", "value": "4" },
        { "op": "click", "sel": "#save-settings-btn" }, { "op": "reload" },
        { "op": "expect_text", "sel": ".meal-card .protein-amount", "nth": 2, "contains": "37.5g" }
    ]));
    let r = probe_results(&[long], &json!([{ "ok": false, "k": "fail", "at": 4, "got": "50g" }]));
    let crit = "Each meal card shows the per-meal protein share once the goal and the meal count are saved and the page is reloaded later";
    let answers = Answers { list: vec![Answer { idx: Some(0), name: crit.into(), met: Some(true), evidence: String::new(), fix: String::new(), probe: Some(Ok(vec![])) }], missing: vec![] };
    let j = judge(&answers, "", false, &ProbeRun::Ran(r), &[], false);
    assert!(j.unmet[0].chars().count() <= 300, "{}", j.unmet[0].chars().count());
    assert!(j.unmet[0].contains("got 50g;"), "{}", j.unmet[0]);
}

/// A probe that never finished is that probe's failure, naming the step in flight when known.
#[test]
fn an_unfinished_probe_is_a_failure_of_that_probe() {
    let p = probe(1, json!([{ "op": "set", "sel": "#w", "value": "165" }, { "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }]));
    let r = unfinished(&p, Some(&json!({ "p": 0, "s": 2, "R": [] })), "no result after 20s");
    assert!(r.ran && !r.passed && !r.error && r.answer == 1, "{r:?}");
    assert_eq!(r.detail, "the page hung or navigated away after set #w=165, click #kg (no result after 20s)");
    let none = unfinished(&p, None, "no result after 20s");
    assert!(none.detail.contains("during set #w=165, click #kg"), "{}", none.detail);
    assert!(unfinished(&p, Some(&json!({ "s": 0 })), "x").detail.contains("on load"));
    // Judged as a probe failure even with real evidence.
    let html = "<script>function toggleUnit(unit) { state.unit = unit; convert(); }</script>";
    let answers = read_answers(&json!([{ "n": 1, "criterion": "The lb/kg toggle converts the weight", "met": true, "evidence": "function toggleUnit(unit) { state.unit = unit; convert(); }", "probe": [{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }] }]), &crit_list()[..1]);
    let hung = unfinished(&probes_of(&answers, &[])[0], None, "no result after 20s");
    let j = judge(&answers, html, false, &ProbeRun::Ran(vec![hung]), &[], false);
    assert!(j.unmet[0].starts_with("probe failed for The lb/kg toggle converts the weight: the page hung"), "{:?}", j.unmet);
}

/// A probe that failed once is carried to the next verify and run again whatever the verifier
/// writes then; it fails the criterion again (also when it now matches nothing and no new probe
/// for it passed) and stays open until it passes.
#[test]
fn a_failed_probe_is_carried_and_rechecked() {
    let html = "<script>\nfunction toggleUnit(unit) { state.unit = unit; if (state.unit !== unit) convert(); }\n</script>";
    let ev = "function toggleUnit(unit) { state.unit = unit; if (state.unit !== unit) convert(); }";
    let steps = json!([{ "op": "set", "sel": "#w", "value": "165" }, { "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }]);
    // Pass 1: the verifier's probe fails; it is recorded as open, keyed by criterion.
    let a1 = read_answers(&json!([{ "n": 1, "criterion": "The lb/kg toggle converts the weight", "met": true, "evidence": ev, "probe": steps }]), &crit_list());
    let p1 = probes_of(&a1, &[]);
    let run1 = ProbeRun::Ran(probe_results(&p1, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }])));
    let open = open_probes(&p1, &run1, &a1);
    assert_eq!(open.as_array().unwrap().len(), 1);
    assert_eq!(open[0]["idx"], 0);
    // Pass 2: the verifier quotes the code and writes no probe: the carried one still runs.
    let a2 = read_answers(&json!([{ "n": 1, "criterion": "lb/kg toggle", "met": true, "evidence": ev }]), &crit_list());
    let carried = carried_probes(&open, &a2, &probes_of(&a2, &[]));
    assert_eq!(carried.len(), 1);
    assert!(carried[0].carried && carried[0].answer == 0);
    let again = ProbeRun::Ran(probe_results(&carried, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }])));
    let j = judge(&a2, html, false, &again, &[], false);
    assert!(j.unmet[0].starts_with("probe failed again for lb/kg toggle: got 165;"), "{:?}", j.unmet);
    assert_eq!(j.criteria[0]["probe"]["rechecked"][0]["passed"], false);
    assert_eq!(open_probes(&carried, &again, &a2).as_array().unwrap().len(), 1, "still open");
    // The Coder renamed the button: the carried probe matches nothing and nothing new passed.
    let gone = ProbeRun::Ran(probe_results(&carried, &json!([{ "ok": false, "k": "nomatch", "at": 1 }])));
    let j = judge(&a2, html, false, &gone, &[], false);
    assert!(j.unmet[0].starts_with("a probe that failed before now matches nothing for lb/kg toggle"), "{:?}", j.unmet);
    // …but a new probe for the same criterion that passes settles it, and closes the old one.
    let a3 = read_answers(&json!([{ "n": 1, "criterion": "lb/kg toggle", "met": true, "evidence": ev, "probe": [{ "op": "click", "sel": "#to-kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }] }]), &crit_list());
    let mut all = probes_of(&a3, &[]);
    let more = carried_probes(&open, &a3, &all);
    all.extend(more);
    assert_eq!(all.len(), 2);
    let run3 = ProbeRun::Ran(probe_results(&all, &json!([{ "ok": true }, { "ok": false, "k": "nomatch", "at": 1 }])));
    assert!(judge(&a3, html, false, &run3, &[], false).unmet.is_empty());
    assert_eq!(open_probes(&all, &run3, &a3), json!([]));
    // Passing again closes it; a run that never happened keeps it open.
    let passed = ProbeRun::Ran(probe_results(&carried, &json!([{ "ok": true }])));
    assert!(judge(&a2, html, false, &passed, &[], false).unmet.is_empty());
    assert_eq!(open_probes(&carried, &passed, &a2), json!([]));
    assert_eq!(open_probes(&carried, &ProbeRun::Skipped("no Edge".into()), &a2).as_array().unwrap().len(), 1);
    // The same steps written again by the verifier run once.
    let a4 = read_answers(&json!([{ "n": 1, "criterion": "lb/kg toggle", "met": true, "evidence": ev, "probe": steps }]), &crit_list());
    assert!(carried_probes(&open, &a4, &probes_of(&a4, &[])).is_empty());
}

const PROBE_FIX_PAGE: &str = r#"<!doctype html><html><head><title>t</title></head><body>
<p id="range">120 - 165 g</p><p id="both">165 lbs (74.8 kg)</p><p id="comma">74,8 kg</p>
<input id="w" type="number" value="74.8">
<select id="unit"><option value="kg">kg</option><option value="lbs" selected>lbs</option></select>
<select id="act"><option value="1.2">Light</option><option value="1.6" selected>Moderate</option></select>
<div><button class="split" data-split="3">3 Meals</button><button class="split" data-split="4">4 Meals</button><button class="split" data-split="5">5 Meals</button></div>
<ul><li class="meal">Breakfast</li><li class="meal">Lunch</li><li class="meal">Dinner</li></ul>
<input id="k" type="number"><p id="kout">0</p><input id="d" type="number"><p id="dout">0</p>
<input id="b" type="number"><p id="bout">0</p><input id="cb" type="checkbox"><p id="cbout">off</p>
<a id="away" href="https://example.invalid/learn">Learn more</a>
<button id="go" onclick="location.href='missing.html'">Go</button><button id="hang" onclick="while(true){}">Hang</button>
<script>
const $ = (i) => document.getElementById(i);
$('k').addEventListener('keyup', () => { $('kout').textContent = $('k').value * 2; });
let t; $('d').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { $('dout').textContent = $('d').value * 2; }, 300); });
$('b').onblur = () => { $('bout').textContent = $('b').value * 2; };
$('cb').addEventListener('click', () => { $('cbout').textContent = $('cb').checked ? 'on' : 'off'; });
</script></body></html>"#;

/// Real headless Edge: numbers anywhere in the text, form controls read by state, order labels
/// matched loosely, typing-like events and settle waits, navigation blocked, and a probe that hangs
/// the page fails alone without costing the other probes their results.
#[test]
fn probes_read_pages_like_a_person_and_a_hang_fails_only_its_probe() {
    let Some(dir) = edge_dir("probe-fixes") else { return };
    let page = dir.join("page.html");
    std::fs::write(&page, PROBE_FIX_PAGE).unwrap();
    let probes = vec![
        probe(0, json!([
            { "op": "expect_text", "sel": "#range", "approx": 165 }, { "op": "expect_text", "sel": "#both", "approx": 74.8 },
            { "op": "expect_text", "sel": "#comma", "approx": 74.8 }, { "op": "expect_text", "sel": "#w", "approx": 74.8 },
            { "op": "expect_value", "sel": "#act", "equals": "Moderate" }, { "op": "expect_text", "sel": "#act", "contains": "moderate" }
        ])),
        probe(1, json!([{ "op": "expect_text", "sel": "#unit", "contains": "kg" }])),
        probe(2, json!([
            { "op": "expect_order", "sel": ".split", "attr": "data-meals", "order": ["3", "4", "5"] },
            { "op": "expect_order", "sel": ".meal", "order": ["breakfast", "lunch", "dinner"] }
        ])),
        probe(3, json!([{ "op": "expect_order", "sel": ".split", "order": ["Small", "Medium", "Large"] }])),
        probe(4, json!([
            { "op": "set", "sel": "#k", "value": "21" }, { "op": "set", "sel": "#d", "value": "21" }, { "op": "set", "sel": "#b", "value": "21" },
            { "op": "set", "sel": "#cb", "value": "true" }, { "op": "expect_text", "sel": "#kout", "approx": 42 },
            { "op": "expect_text", "sel": "#dout", "approx": 42 }, { "op": "expect_text", "sel": "#bout", "approx": 42 }, { "op": "expect_text", "sel": "#cbout", "equals": "on" }
        ])),
        probe(5, json!([{ "op": "click", "sel": "#away" }, { "op": "click", "sel": "#go" }, { "op": "expect_text", "sel": "#range", "contains": "120" }])),
        probe(6, json!([{ "op": "set", "sel": "#w", "value": "5" }, { "op": "click", "sel": "#hang" }, { "op": "expect_count", "sel": ".split", "count": 3 }])),
        probe(7, json!([{ "op": "expect_text", "sel": "#range", "approx": 999 }])),
    ];
    let ProbeRun::Ran(r) = run_probes(&page, &probes, Duration::from_secs(10), Duration::from_secs(150)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    assert_eq!(r.len(), 8, "{d:?}");
    assert!(r[0].passed, "any number in the text, an input's value, a select's label: {d:?}");
    assert!(!r[1].passed && !r[1].error && d[1].contains("got lbs"), "a select reads its selected option only: {d:?}");
    assert!(r[2].passed, "labels by leading number / case, attr falls back to the text: {d:?}");
    assert!(r[3].error && d[3].contains("does not name the expected Small, Medium, Large"), "{d:?}");
    assert!(r[4].passed, "keyup, debounce, blur and a checkbox click handler all ran: {d:?}");
    assert!(r[5].passed, "leaving the page is blocked: {d:?}");
    assert!(r[6].ran && !r[6].passed && !r[6].error && d[6].contains("the page hung or navigated away") && d[6].contains("click #hang"), "{d:?}");
    assert!(r[7].ran && !r[7].passed && d[7].starts_with("got 120 - 165 g;"), "the probe after the hang still ran: {d:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Required probes and pinned intent checks (AD-12) ────────────────────────

const PROTEIN_ASK: &str = "Build me a protein intake calculator. I'm 165 lbs, so default 165 lb, with a lb/kg toggle and a per-meal split (3-5 meals).";

/// Nic's own values become checks whose expectations are computed here: the default on load,
/// the converted number after switching units, and the range's choices in order. Generic (a
/// temperature request gets the same treatment) and conservative (nothing when unclear).
#[test]
fn intent_checks_pin_nics_own_values() {
    let c = intent_checks(PROTEIN_ASK);
    assert_eq!(c.len(), 3, "{c:#?}");
    assert_eq!((&c[0].kind, c[0].value), (&CheckKind::Default, 165.0));
    match &c[1].kind {
        CheckKind::Convert { from, to, start } => assert_eq!((from.as_str(), to.as_str(), *start), ("lb", "kg", 165.0)),
        k => panic!("{k:?}"),
    }
    assert!((c[1].value - 74.84).abs() < 0.01 && (c[1].tol - 0.5).abs() < 1e-9, "{:?}", c[1]);
    assert_eq!(c[2].kind, CheckKind::Order(vec!["3".into(), "4".into(), "5".into()]));
    assert!(c[0].criterion.contains("pinned value: 165;"), "{}", c[0].criterion);
    assert!(c[1].criterion.contains("from lb to kg") && c[1].criterion.contains("pinned value: 74.84;"), "{}", c[1].criterion);
    assert!(c[2].criterion.contains("pinned order: 3, 4, 5"), "{}", c[2].criterion);
    // Another domain, same rules: °F/°C with a stated default.
    let t = intent_checks("A thermostat card. Default to 72°F, with a °F/°C switch.");
    assert_eq!(t.len(), 2, "{t:#?}");
    assert!((t[1].value - 22.22).abs() < 0.01 && t[1].criterion.contains("from °F to °C"), "{t:#?}");
    let m = intent_checks("My daily run is 5 miles; show it in miles or km and let me pick 2 to 4 laps between breaks.");
    assert_eq!(m.iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["5", "8.05", "2, 3, 4"], "{m:#?}");
    // Nothing when it is not clearly a default, a named pair or a choice.
    assert!(intent_checks("I went from 180 to 165 lbs").is_empty());
    assert!(intent_checks("Convert 165 lb for me, with lb/kg shown").is_empty(), "not stated as a default");
    assert!(intent_checks("a 25-30 minute workout with 8-12 reps, choose a plan").is_empty(), "measured ranges are not choices");
    assert!(intent_checks("show 3-5 meals").is_empty(), "a range with no choice word");
    assert_eq!(intent_checks("Build a weight log, default 165 lb").len(), 1, "a default without a unit pair");
    assert!(intent_checks("I'm 165 lbs").is_empty(), "a personal stat the request never asks for");
    assert!(intent_checks("default 5 meals. Actually, default to 4 meals.").is_empty(), "Nic changed his mind: pin neither");
}

/// Review fix: "I'm …" / "my … is …" is a fact about Nic, pinned as the page's default only when
/// the request also asks for that quantity (its unit pair, or a field / default / toggle for it).
#[test]
fn a_personal_stat_is_pinned_only_when_the_page_asks_for_it() {
    let c = intent_checks("I'm 28 years old and lift 4 days a week. Build a protein calculator with default 165 lb, lb/kg toggle.");
    assert_eq!(c.iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["165", "74.84"], "{c:#?}");
    assert!(!c.iter().any(|x| x.criterion.contains("28")), "{c:#?}");
    assert!(intent_checks("I'm 6 ft and 30 years old; build me a habit tracker").is_empty());
    // Asked for: a unit pair for it, or a field for it in another sentence.
    assert_eq!(intent_checks("I'm 165 lbs; show my weight in lb or kg").iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["165", "74.84"]);
    assert_eq!(intent_checks("I am 30 years old. Add an age field in years.").iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["30"]);
    // The protein request still pins all three.
    assert_eq!(intent_checks(PROTEIN_ASK).len(), 3);
}

/// Review fix: a small range is a choice only when a choice word governs it ("split (3-5
/// meals)", "pick 2 to 4 laps", "3-5 meal options"), never because "button" or "toggle" occurs
/// nearby.
#[test]
fn a_range_is_a_choice_only_when_a_choice_word_governs_it() {
    for ask in [
        "Make a quiz app with 5-10 questions per round and a button to restart",
        "Habit tracker for 3-5 habits with a dark mode toggle",
        "Shopping list, 1-3 items per row, delete button on each",
        "Summaries of 2-4 sentences with a copy button",
        "A board game timer for 2-6 players, tap a button to switch turns",
    ] {
        assert!(intent_checks(ask).is_empty(), "{ask}: {:#?}", intent_checks(ask));
    }
    for (ask, want) in [
        (PROTEIN_ASK, "3, 4, 5"),
        ("let me pick 2 to 4 laps between breaks", "2, 3, 4"),
        ("Offer 3-5 meal options per day", "3, 4, 5"),
        ("a split into 2-4 groups", "2, 3, 4"),
        ("Choose from 1-3 servings", "1, 2, 3"),
    ] {
        let c = intent_checks(ask);
        assert!(c.iter().any(|x| matches!(x.kind, CheckKind::Order(_)) && x.pinned() == want), "{ask}: {c:#?}");
    }
}

/// Which criteria need a probe, and which may start with an expectation.
#[test]
fn behavioural_criteria_need_probes() {
    let lits = intent_literals(PROTEIN_ASK);
    for c in ["The lb/kg toggle converts the weight", "Saved state is restored after a reload", "Adding a food updates the total", "Reset clears the log", "Meal split offers 3, 4 and 5 meals in order", "Shows the default weight on load", "Uses Nic's 165 lb"] {
        assert!(behavioural(c, &lits), "{c}");
    }
    for c in ["Has a dark card layout", "Works offline", "Readable on a phone"] {
        assert!(!behavioural(c, &lits), "{c}");
    }
    assert!(need_of("The lb/kg toggle converts the weight", &lits).action);
    assert!(!need_of("Shows the default weight on load", &lits).action, "an on-load default needs no action");
    assert!(!need_of("Meal split offers 3, 4 and 5 meals in order", &lits).action);
    assert!(need_of("Switching to kg converts the default weight", &lits).action, "a default that is switched still needs the switch");
    assert_eq!(need_of("Works offline", &lits), Need::default());
}

/// Review fix: a default / initial-state / order criterion is an on-load check even when it
/// names a state ("selected") or a thing ("the toggle"): its probe expects FIRST, and one that
/// clicks before it checks (which passes on a page where kg was active at start) is rejected.
#[test]
fn on_load_criteria_expect_before_they_act() {
    let lits = intent_literals(PROTEIN_ASK);
    for c in [
        "The lb unit is selected by default (kg is not active on load)",
        "Weight defaults to 165 lb and the lb/kg toggle starts on lb",
        "The lb button is selected by default",
        "Meal split buttons appear in the correct order (3, 4, 5)",
        "Shows 165 lb when the page opens",
    ] {
        let n = need_of(c, &lits);
        assert!(n.probe && n.fresh && !n.action, "{c}: {n:?}");
    }
    // Behavioural only through Nic's literal, and no action named: no action required.
    let n = need_of("Uses Nic's 165 lb", &lits);
    assert!(n.probe && !n.action, "{n:?}");
    // An action phrase still wins over a default cue.
    for c in ["Switching to kg converts the default weight", "After a switch to kg the default weight reads in kg", "When the user selects kg, the default weight is converted"] {
        let n = need_of(c, &lits);
        assert!(n.action && !n.fresh, "{c}: {n:?}");
    }
    let crits = vec!["The lb unit is selected by default (kg is not active on load)".to_string(), "Meal split buttons appear in the correct order (3, 4, 5)".to_string()];
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &lits)).collect();
    let run = |p0: Value, p1: Value| {
        let mut a = read_answers(&json!([{ "n": 1, "criterion": crits[0], "met": true, "evidence": "", "probe": p0 }, { "n": 2, "criterion": crits[1], "met": true, "evidence": "", "probe": p1 }]), &crits);
        enforce(&mut a, &needs);
        a.list.into_iter().map(|x| x.probe.unwrap()).collect::<Vec<_>>()
    };
    // The natural probes pass the rules.
    let r = run(json!([{ "op": "expect_class", "sel": "#lb", "class": "active" }, { "op": "expect_class", "sel": "#kg", "class": "active", "present": false }]), json!([{ "op": "expect_order", "sel": ".split-btn", "order": ["3", "4", "5"] }]));
    assert!(r[0].is_ok() && r[1].is_ok(), "{r:?}");
    // Acting first proves nothing about the page on load.
    let r = run(json!([{ "op": "click", "sel": "#lb" }, { "op": "expect_class", "sel": "#lb", "class": "active" }]), json!([{ "op": "click", "sel": ".split-btn" }, { "op": "expect_order", "sel": ".split-btn", "order": ["3", "4", "5"] }]));
    assert!(r[0].as_ref().unwrap_err().contains("expect it FIRST"), "{r:?}");
    assert!(r[1].as_ref().unwrap_err().contains("expect it FIRST"), "{r:?}");
}

/// Review fix: a criterion that computes or converts a value is not proven by a class or a
/// count (the split button gets "active" on a page whose split never updates).
#[test]
fn a_computed_value_needs_a_probe_that_reads_it() {
    let crits = vec!["The per-meal split divides the daily target by the chosen number of meals".to_string(), "Reset clears the log".to_string()];
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    assert!(needs[0].value && !needs[1].value);
    let mut a = read_answers(
        &json!([
            { "n": 1, "criterion": crits[0], "met": true, "evidence": "", "probe": [{ "op": "click", "sel": ".split-btn", "nth": 1 }, { "op": "expect_class", "sel": ".split-btn", "nth": 1, "class": "active" }] },
            { "n": 2, "criterion": crits[1], "met": true, "evidence": "", "probe": [{ "op": "click", "sel": "#reset" }, { "op": "expect_count", "sel": ".row", "count": 0 }] }
        ]),
        &crits,
    );
    enforce(&mut a, &needs);
    assert!(a.list[0].probe.as_ref().unwrap().as_ref().unwrap_err().contains("only checks a class or a count"), "{:?}", a.list[0].probe);
    assert!(a.list[1].probe.as_ref().unwrap().is_ok(), "a count is the right check for a reset");
}

/// Review fix: a passing probe stands in only for evidence the verifier did not give. Quoted
/// code that is not in the page is reported whatever the probe did, and a criterion that is not
/// behavioural still needs real evidence.
#[test]
fn a_passing_probe_never_covers_made_up_evidence() {
    let html = "<script>\nfunction split(n) { state.meals = n; render(); }\n</script>";
    let crits = vec!["The per-meal split divides the daily target by the chosen number of meals".to_string(), "Works offline: no CDN scripts".to_string()];
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    let probe = json!([{ "op": "click", "sel": ".split-btn" }, { "op": "expect_text", "sel": "#per-meal", "contains": "40 g" }]);
    let judged = |evidence: &str| {
        let a = read_answers(&json!([{ "n": 1, "criterion": crits[0], "met": true, "evidence": evidence, "probe": probe }, { "n": 2, "criterion": crits[1], "met": true, "evidence": "const cdn = none; // all inline here", "probe": probe }]), &crits);
        let p = probes_of(&a, &needs);
        judge(&a, html, false, &ProbeRun::Ran(probe_results(&p, &json!([{ "ok": true }, { "ok": true }]))), &needs, true)
    };
    let made_up = judged("perMeal = total / meals");
    assert!(made_up.unmet.iter().any(|u| u.starts_with("no working code found for: The per-meal split")), "{:?}", made_up.unmet);
    assert!(made_up.unmet.iter().any(|u| u.starts_with("no working code found for: Works offline")), "{:?}", made_up.unmet);
    // No quote at all: the behavioural criterion's passing probe stands in; the other still needs code.
    let none = judged("");
    assert!(!none.unmet.iter().any(|u| u.contains("per-meal split")), "{:?}", none.unmet);
    assert!(none.unmet.iter().any(|u| u.starts_with("no working code found for: Works offline")), "{:?}", none.unmet);
}

/// Review fix: the pinned step is chosen by its number, not by its position, so a correct probe
/// with an extra read or a return toggle is held to the pinned value instead of rejected.
#[test]
fn pinned_probes_keep_extra_reads_and_return_toggles() {
    let checks = intent_checks(PROTEIN_ASK);
    let expected: Vec<String> = checks.iter().map(|c| c.criterion.clone()).collect();
    let needs: Vec<Need> = checks.iter().map(|c| c.need()).collect();
    let enforced = |n: usize, probe: Value| {
        let mut a = read_answers(&json!([{ "n": n, "criterion": expected[n - 1], "met": true, "evidence": "", "probe": probe }]), &expected);
        enforce(&mut a, &needs);
        a.list.remove(0).probe.unwrap()
    };
    let pinned_kg = json!({ "op": "expect_value", "sel": "#weight", "nth": 0, "approx": 74.84, "tol": 0.5 });
    // A trailing unit read.
    let r = enforced(2, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#weight", "approx": 74.8 }, { "op": "expect_text", "sel": "#unit", "contains": "kg" }])).unwrap();
    assert_eq!((&r[1], r[2]["contains"].as_str()), (&pinned_kg, Some("kg")));
    // The stronger reversible probe: there and back.
    let r = enforced(2, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#weight", "approx": 74.8 }, { "op": "click", "sel": "#lb" }, { "op": "expect_value", "sel": "#weight", "approx": 165 }])).unwrap();
    assert_eq!(r[1], pinned_kg);
    assert_eq!(r[3]["approx"].as_f64(), Some(165.0), "the return step is the model's own");
    // Default: a unit read first, the number after it.
    let r = enforced(1, json!([{ "op": "expect_text", "sel": "#unit", "contains": "lb" }, { "op": "expect_value", "sel": "#weight", "approx": 165 }])).unwrap();
    assert_eq!(r[1]["approx"].as_f64(), Some(165.0));
    assert_eq!(r[0]["contains"].as_str(), Some("lb"));
    // Still rejected: a round trip that never expects the converted value, and no number at all.
    assert!(enforced(2, json!([{ "op": "click", "sel": "#kg" }, { "op": "click", "sel": "#lb" }, { "op": "expect_value", "sel": "#weight", "approx": 165 }])).unwrap_err().contains("round trip"));
    assert!(enforced(2, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_text", "sel": "#unit", "contains": "kg" }])).unwrap_err().contains("expect a number"));
    assert!(enforced(1, json!([{ "op": "expect_text", "sel": "#unit", "contains": "lb" }])).unwrap_err().contains("expect a number"));
}

/// Review fix: more shapes a 9B model writes are read, not rejected: one step as an object, the
/// list as a JSON string, wait steps (dropped), and a numeric "step" next to the "type" op.
#[test]
fn parse_probe_reads_more_small_model_shapes() {
    let one = parse_probe(&json!({ "op": "expect_value", "sel": "#weight", "approx": 165 })).unwrap();
    assert_eq!((one.len(), one[0]["op"].as_str(), one[0]["sel"].as_str(), one[0]["approx"].as_f64()), (1, Some("expect_value"), Some("#weight"), Some(165.0)));
    let s = parse_probe(&json!("[{\"op\":\"click\",\"sel\":\"#kg\"},{\"op\":\"expect_text\",\"sel\":\"#w\",\"contains\":\"74.8\"}]")).unwrap();
    assert_eq!(s.len(), 2);
    let w = parse_probe(&json!([{ "op": "click", "sel": "#kg" }, { "op": "wait", "ms": 300 }, { "action": "sleep" }, { "op": "expect_text", "sel": "#w", "contains": "kg" }])).unwrap();
    assert_eq!(w.iter().map(|x| x["op"].as_str().unwrap()).collect::<Vec<_>>(), vec!["click", "expect_text"]);
    let t = parse_probe(&json!([{ "step": 1, "type": "click", "selector": "#kg" }, { "step": 2, "type": "expect_text", "selector": "#w", "contains": "kg" }])).unwrap();
    assert_eq!(t[0], json!({ "op": "click", "sel": "#kg", "nth": 0 }));
    // Still untrusted data: a string that is not a list, waits only, a nested string.
    assert!(parse_probe(&json!("click the button")).unwrap_err().contains("not a list"));
    assert!(parse_probe(&json!([{ "op": "wait" }])).unwrap_err().contains("no steps"));
    assert!(parse_probe(&json!("\"[]\"")).unwrap_err().contains("not a list"));
    assert!(parse_probe(&json!({ "sel": "#a" })).unwrap_err().contains("not a list"));
}

/// A probe for an intent check must expect the pinned value (it is rewritten to it), a convert
/// probe must switch first and never expect its starting value (round trip), and a behavioural
/// probe must act before it expects.
#[test]
fn pinned_probes_are_held_to_nics_values() {
    let checks = intent_checks(PROTEIN_ASK);
    let mut expected = crit_list();
    let lits = intent_literals(PROTEIN_ASK);
    let mut needs: Vec<Need> = expected.iter().map(|c| need_of(c, &lits)).collect();
    for c in &checks {
        expected.push(c.criterion.clone());
        needs.push(c.need());
    }
    let ans = |n: usize, probe: Value| json!({ "n": n, "criterion": expected[n - 1], "met": true, "evidence": "x", "probe": probe });
    let enforced = |list: Vec<Value>| {
        let mut a = read_answers(&Value::Array(list), &expected);
        enforce(&mut a, &needs);
        a.list.into_iter().map(|x| x.probe.unwrap()).collect::<Vec<_>>()
    };
    let r = enforced(vec![
        // 1: behavioural, reads only → rejected; 2: on-load order → fine without an action.
        ans(1, json!([{ "op": "expect_value", "sel": "#w", "approx": 74.8 }])),
        ans(2, json!([{ "op": "expect_count", "sel": ".m", "count": 3 }])),
        // 4: default — an action first is rejected.
        ans(4, json!([{ "op": "set", "sel": "#w", "value": "165" }, { "op": "expect_value", "sel": "#w", "approx": 165 }])),
        // 5: convert — the round trip the 9B verifier wrote.
        ans(5, json!([{ "op": "click", "sel": "#kg" }, { "op": "click", "sel": "#lb" }, { "op": "expect_value", "sel": "#w", "approx": 165 }])),
        // 6: order — the page's own order.
        ans(6, json!([{ "op": "expect_order", "sel": ".m", "order": ["3", "5", "4"] }])),
    ]);
    assert!(r[0].as_ref().unwrap_err().contains("only reads the page"), "{:?}", r[0]);
    assert!(r[1].is_ok());
    assert!(r[2].as_ref().unwrap_err().contains("before any set / select / click (pinned value 165)"), "{:?}", r[2]);
    assert!(r[3].as_ref().unwrap_err().contains("round trip") && r[3].as_ref().unwrap_err().contains("use the pinned value 74.84"), "{:?}", r[3]);
    assert!(r[4].as_ref().unwrap_err().contains("use the pinned order 3, 4, 5"), "{:?}", r[4]);
    // The page's own wrong factor; an order check without expect_order; no switch at all.
    let r = enforced(vec![
        ans(5, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 72.6 }])),
        ans(6, json!([{ "op": "expect_count", "sel": ".m", "count": 3 }])),
    ]);
    assert!(r[0].as_ref().unwrap_err().contains("it expects 72.6, but the converted value is pinned: use the pinned value 74.84"), "{:?}", r[0]);
    assert!(r[1].as_ref().unwrap_err().contains("use expect_order"), "{:?}", r[1]);
    assert!(enforced(vec![ans(5, json!([{ "op": "expect_value", "sel": "#w", "approx": 74.84 }]))])[0].as_ref().unwrap_err().contains("switch the unit to kg first"));
    // Right: rewritten to the value computed here (the model's "74.8 kg" text becomes approx).
    let r = enforced(vec![
        ans(4, json!([{ "op": "expect_value", "sel": "#w", "contains": "165" }])),
        ans(5, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_text", "sel": "#w", "contains": "74.8 kg" }])),
        ans(6, json!([{ "op": "expect_order", "sel": ".m", "order": ["3 meals", "4 meals", "5 meals"] }])),
    ]);
    let s4 = r[0].as_ref().unwrap();
    assert_eq!(s4[0], json!({ "op": "expect_value", "sel": "#w", "nth": 0, "approx": 165.0, "tol": 0.99 }));
    let s5 = r[1].as_ref().unwrap();
    assert_eq!(s5[1], json!({ "op": "expect_text", "sel": "#w", "nth": 0, "approx": 74.84, "tol": 0.5 }));
    assert_eq!(r[2].as_ref().unwrap()[0]["order"], json!(["3", "4", "5"]));
}

/// Where probes run, a behavioural criterion is met only when a probe for it ran and passed;
/// without one it is a gap (never a Coder loop) that names why; a passing probe stands in for
/// evidence; the cap runs the behavioural criteria's probes first.
#[test]
fn a_behavioural_criterion_needs_a_probe_that_ran_and_passed() {
    let html = "<script>\nfunction toggleUnit(unit) { state.unit = unit; convert(); }\n</script>";
    let ev = "function toggleUnit(unit) { state.unit = unit; convert(); }";
    let crits = vec!["The lb/kg toggle converts the weight".to_string(), "Has a dark card layout".to_string(), "Saved state is restored after a reload".to_string()];
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    // Only quoted code, no probe: a gap for the behavioural one, nothing for the layout.
    let a = read_answers(&json!([{ "n": 1, "criterion": crits[0], "met": true, "evidence": ev }, { "n": 2, "criterion": crits[1], "met": true, "evidence": ev }]), &crits[..2]);
    let j = judge(&a, html, false, &ProbeRun::Skipped("the verifier gave no probes".into()), &needs, true);
    assert!(j.unmet.is_empty(), "{:?}", j.unmet);
    assert_eq!(j.gaps, vec![ProbeGap { n: Some(1), criterion: crits[0].clone(), why: "no probe was given".into(), fixable: true }]);
    assert_eq!(j.criteria[0]["needs_probe"], true);
    assert_eq!(probe_feedback(&j.gaps), vec!["1. The lb/kg toggle converts the weight: no probe was given".to_string()]);
    // Probes cannot run here (no Edge / runtime checks off): the evidence-only rule.
    assert!(judge(&a, html, false, &ProbeRun::Skipped("Edge is not installed".into()), &needs, false).gaps.is_empty());
    // Rejected, matching nothing, past the cap: each a gap with its reason.
    let a = read_answers(
        &json!([
            { "n": 1, "criterion": crits[0], "met": true, "evidence": ev, "probe": [{ "op": "eval" }] },
            { "n": 3, "criterion": crits[2], "met": true, "evidence": ev, "probe": [{ "op": "set", "sel": "#w", "value": "170" }, { "op": "reload" }, { "op": "expect_value", "sel": "#w", "approx": 170 }] }
        ]),
        &crits,
    );
    let p = probes_of(&a, &needs);
    let nomatch = ProbeRun::Ran(probe_results(&p, &json!([{ "ok": false, "k": "nomatch", "at": 0 }])));
    let j = judge(&a, html, false, &nomatch, &needs, true);
    assert!(j.gaps[0].why.starts_with("its probe was rejected: step 1: unknown op"), "{:?}", j.gaps);
    assert_eq!(j.gaps[1].why, "its probe did not run: #w matches nothing (probe step 1)");
    assert!(j.unmet.is_empty(), "{:?}", j.unmet);
    let j = judge(&a, html, false, &ProbeRun::Ran(vec![]), &needs, true);
    assert_eq!(j.gaps[1].why, format!("skipped: at most {MAX_PROBES} probes run"));
    // The cap is not the verifier's to fix: never fed back to it (no retry is spent on it).
    assert!(!j.gaps[1].fixable && j.gaps[0].fixable);
    assert_eq!(probe_feedback(&j.gaps).len(), 1, "{:?}", probe_feedback(&j.gaps));
    // A passing probe settles it, even without quoted code; a failing one is a Coder fix as before.
    let a = read_answers(&json!([{ "n": 3, "criterion": crits[2], "met": true, "evidence": "", "probe": [{ "op": "set", "sel": "#w", "value": "170" }, { "op": "reload" }, { "op": "expect_value", "sel": "#w", "approx": 170 }] }]), &crits);
    let p = probes_of(&a, &needs);
    let ok = judge(&a, html, false, &ProbeRun::Ran(probe_results(&p, &json!([{ "ok": true }]))), &needs, true);
    assert!(ok.unmet.is_empty() && ok.gaps.is_empty(), "{ok:?}");
    let bad = judge(&a, html, false, &ProbeRun::Ran(probe_results(&p, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }]))), &needs, true);
    assert!(bad.unmet[0].starts_with("probe failed for Saved state") && bad.gaps.is_empty(), "{bad:?}");
    // The cap: behavioural criteria's probes run first.
    let many: Vec<String> = (0..16).map(|i| if i < 4 { format!("Has a nice card layout number {i}") } else { format!("Adding item {i} updates the total") }).collect();
    let many_needs: Vec<Need> = many.iter().map(|c| need_of(c, &[])).collect();
    let list: Vec<Value> = many.iter().enumerate().map(|(i, c)| json!({ "n": i + 1, "criterion": c, "met": true, "evidence": "x", "probe": [{ "op": "click", "sel": "#add" }, { "op": "expect_count", "sel": ".row", "count": 1 }] })).collect();
    let a = read_answers(&Value::Array(list), &many);
    let p = probes_of(&a, &many_needs);
    assert_eq!(p.len(), MAX_PROBES);
    assert!(p[..12].iter().all(|x| x.answer >= 4) && p[12].answer == 0, "{:?}", p.iter().map(|x| x.answer).collect::<Vec<_>>());
}

/// Review fix: every criterion verify can read (10 acceptance criteria + 4 intent checks) gets
/// its probe run, the pinned checks first, so the cap never turns Nic's own "3-5 meals" order
/// check (the last criterion) into a gap.
#[test]
fn the_probe_cap_covers_every_criterion_and_runs_the_pinned_checks_first() {
    assert!(MAX_PROBES >= MAX_CRITERIA + MAX_CHECKS);
    let checks = intent_checks(PROTEIN_ASK);
    let mut crits: Vec<String> = (0..MAX_CRITERIA).map(|i| format!("Adding item {i} updates the total")).collect();
    let mut needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    for c in &checks {
        crits.push(c.criterion.clone());
        needs.push(c.need());
    }
    let step = |c: &str| if c.contains("pinned order") { json!([{ "op": "expect_order", "sel": ".m", "order": ["3", "4", "5"] }]) } else { json!([{ "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": ".total", "contains": "1 item" }]) };
    let list: Vec<Value> = crits.iter().enumerate().map(|(i, c)| json!({ "n": i + 1, "criterion": c, "met": true, "evidence": "", "probe": step(c) })).collect();
    let a = read_answers(&Value::Array(list), &crits);
    let p = probes_of(&a, &needs);
    assert_eq!(p.len(), crits.len(), "nothing cut");
    let first: Vec<usize> = p.iter().take(checks.len()).map(|x| a.list[x.answer].idx.unwrap()).collect();
    assert_eq!(first, (MAX_CRITERIA..MAX_CRITERIA + checks.len()).collect::<Vec<_>>(), "the pinned checks run first");
}

/// Small-model variations are normalised, not rejected; a numeric contains is marked for
/// whole-number matching.
#[test]
fn probe_steps_from_a_small_model_are_normalised() {
    let ok = parse_probe(&json!([
        { "action": "fill", "selector": "#bill", "text": "80" },
        { "type": "tap", "target": "#tip-15" },
        { "step": "choose", "css": "#people", "val": 2 },
        { "op": "assert_text", "sel": "#total", "value": "92" },
        { "op": "expect", "sel": "#each", "text": "per person" },
        { "op": "expect_value", "sel": "#total", "approx": "92.0", "tol": "0.5" },
        { "op": "Expect-Text", "sel": "#each", "contains": "$46 per person", "nth": "1" }
    ]))
    .unwrap();
    assert_eq!(ok[0], json!({ "op": "set", "sel": "#bill", "nth": 0, "value": "80" }));
    assert_eq!(ok[1], json!({ "op": "click", "sel": "#tip-15", "nth": 0 }));
    assert_eq!(ok[2], json!({ "op": "select", "sel": "#people", "nth": 0, "value": "2" }));
    assert_eq!((ok[3]["op"].as_str(), ok[3]["approx"].as_f64()), (Some("expect_text"), Some(92.0)), "a bare number → approx");
    assert_eq!((ok[4]["contains"].as_str(), ok[4].get("num")), (Some("per person"), None), "bare text → contains");
    assert_eq!((ok[5]["approx"].as_f64(), ok[5]["tol"].as_f64()), (Some(92.0), Some(0.5)));
    assert_eq!((ok[6]["op"].as_str(), ok[6]["nth"].as_u64()), (Some("expect_text"), Some(1)));
    assert_eq!(ok[6]["num"], json!({ "pre": "$", "n": "46", "unit": "per person" }));
    assert_eq!(parse_probe(&json!([{ "op": "expect_text", "sel": "#a", "contains": "40 g" }])).unwrap()[0]["num"], json!({ "pre": "", "n": "40", "unit": "g" }));
    // The security posture holds through the aliases.
    assert!(parse_probe(&json!([{ "action": "tap", "target": "a</script>" }, { "op": "expect_count", "sel": "a", "count": 1 }])).unwrap_err().contains("selector"));
    assert!(parse_probe(&json!([{ "action": "eval", "js": "x()" }])).unwrap_err().contains("unknown op"));
}

/// Real headless Edge: a numeric contains matches a whole number ("0" is not in "40 g", "40" is
/// not in "140 g"); text stays a substring.
#[test]
fn a_numeric_contains_matches_whole_numbers_in_a_real_browser() {
    let Some(dir) = edge_dir("numeric") else { return };
    let page = dir.join("page.html");
    std::fs::write(&page, "<!doctype html><html><head><title>t</title></head><body><p id=a>40 g</p><p id=b>140 g</p><p id=c>$39.33 per person</p><p id=d>1,200 kcal</p><p id=e>Total: $92.00</p><p id=f>92.50 each</p></body></html>").unwrap();
    let c = |i: usize, sel: &str, s: &str| probe(i, json!([{ "op": "expect_text", "sel": sel, "contains": s }]));
    // An all-zero fraction may follow (toFixed(2) money) on either side; any other may not.
    let probes = vec![c(0, "#a", "0"), c(1, "#b", "40"), c(2, "#a", "40 g"), c(3, "#c", "$39.33"), c(4, "#c", "9.33"), c(5, "#c", "Per Person"), c(6, "#d", "1,200 kcal"), c(7, "#b", "140 g"), c(8, "#e", "$92"), c(9, "#e", "92"), c(10, "#e", "92.5"), c(11, "#f", "92.5 each"), c(12, "#e", "92.00"), c(13, "#f", "92")];
    let ProbeRun::Ran(r) = run_probes(&page, &probes, Duration::from_secs(20), Duration::from_secs(240)) else { panic!("edge ran") };
    let got: Vec<bool> = r.iter().map(|x| x.passed).collect();
    assert_eq!(got, vec![false, false, true, true, false, true, true, true, true, true, false, true, true, false], "{:?}", r.iter().map(|x| &x.detail).collect::<Vec<_>>());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Real headless Edge: a temp folder whose path holds '#' and '%' still loads as a file URL
/// (`url::Url::from_file_path` percent-encodes them; a hand-built URL would cut at '#').
#[test]
fn a_temp_path_with_hash_and_percent_still_loads() {
    let Some(exe) = browser() else { return };
    let dir = std::env::temp_dir().join(format!("tf-smoke-test-a#b%41c-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = edge_in(&exe, &dir, &with_harness("<!doctype html><html><head><title>t</title></head><body><p>ok</p></body></html>"), "data-tf-smoke", Duration::from_secs(30), 3000);
    for _ in 0..10 {
        if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    match out {
        EdgeOut::Dom(dom) => assert_eq!(parse_dump(&dom).map(|d| d.0), Some(vec![])),
        EdgeOut::Failed(r, _) | EdgeOut::Unavailable(r) => panic!("{r}"),
    }
}
