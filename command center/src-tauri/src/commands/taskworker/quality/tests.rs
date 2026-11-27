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
    let p = Probe { answer: 0, criterion: "x".into(), carried: false, change: false, steps: parse_probe(&json!([{ "op": "set", "sel": "#a", "value": "</script><script>alert(1)</script>" }, { "op": "expect_count", "sel": "#a", "count": 1 }])).unwrap() };
    let page = with_probes("<html><head></head><body></body></html>", &[p]);
    assert_eq!(page.matches("</script>").count(), 1, "only the harness's own closing tag");
    assert!(page.contains("\\u003c/script\\u003e"));
}

fn probe(answer: usize, steps: Value) -> Probe {
    Probe { answer, criterion: format!("c{answer}"), steps: parse_probe(&steps).unwrap(), carried: false, change: false }
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
        Smoke::Ran { errors, storage_lines, .. } => assert!(errors.is_empty() && storage_lines.contains(&4), "{errors:?} {storage_lines:?}"),
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
    let answers = Answers { list: vec![Answer { idx: Some(0), name: crit.into(), met: Some(true), evidence: String::new(), fix: String::new(), probe: Some(Ok(vec![])), note: None }], missing: vec![] };
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
    let carried = carried_probes(&open, &a2, &probes_of(&a2, &[]), &[]);
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
    let more = carried_probes(&open, &a3, &all, &[]);
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
    assert!(carried_probes(&open, &a4, &probes_of(&a4, &[]), &[]).is_empty());
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
    assert_eq!(c.len(), 4, "{c:#?}");
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
    // AD-13: the default's unit is the one selected on load (after the ranges: a cap cuts it first).
    assert_eq!(c[3].kind, CheckKind::Unit { unit: "lb".into(), other: "kg".into() });
    assert!(c[3].criterion.contains("pinned unit: lb;") && c[3].criterion.contains("not kg"), "{}", c[3].criterion);
    assert_eq!(c[3].need(), Need { probe: true, action: false, fresh: true, value: false, check: Some(c[3].clone()), toggle: false, shows: vec![], zero: false });
    // Another domain, same rules: °F/°C with a stated default.
    let t = intent_checks("A thermostat card. Default to 72°F, with a °F/°C switch.");
    assert_eq!(t.len(), 3, "{t:#?}");
    assert!((t[1].value - 22.22).abs() < 0.01 && t[1].criterion.contains("from °F to °C"), "{t:#?}");
    assert_eq!(t[2].pinned(), "°F");
    let m = intent_checks("My daily run is 5 miles; show it in miles or km and let me pick 2 to 4 laps between breaks.");
    assert_eq!(m.iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["5", "8.05", "2, 3, 4", "mi"], "{m:#?}");
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
    assert_eq!(c.iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["165", "74.84", "lb"], "{c:#?}");
    assert!(!c.iter().any(|x| x.criterion.contains("28")), "{c:#?}");
    assert!(intent_checks("I'm 6 ft and 30 years old; build me a habit tracker").is_empty());
    // Asked for: a unit pair for it, or a field for it in another sentence.
    assert_eq!(intent_checks("I'm 165 lbs; show my weight in lb or kg").iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["165", "74.84", "lb"]);
    assert_eq!(intent_checks("I am 30 years old. Add an age field in years.").iter().map(|x| x.pinned()).collect::<Vec<_>>(), vec!["30"]);
    // The protein request pins all four (default, converted, order, unit).
    assert_eq!(intent_checks(PROTEIN_ASK).len(), 4);
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

/// AD-13 (critic 7 / 8): a passing probe that read an element of its own proves a behavioural
/// criterion even when the quoted code is stale or paraphrased (recorded as `evidence_found:
/// false` with a note, never a Coder fix); a criterion that is not behavioural still needs real
/// evidence; and a value read of the whole page or of a big container proves nothing (a gap).
#[test]
fn a_passing_specific_probe_proves_a_behaviour_over_stale_evidence() {
    let html = "<script>\nfunction split(n) { state.meals = n; render(); }\n</script>";
    let crits = vec!["The per-meal split divides the daily target by the chosen number of meals".to_string(), "Works offline: no CDN scripts".to_string()];
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    let judged = |evidence: &str, sel: &str, raw: Value| {
        let probe = json!([{ "op": "click", "sel": ".split-btn" }, { "op": "expect_text", "sel": sel, "contains": "40 g" }]);
        let a = read_answers(&json!([{ "n": 1, "criterion": crits[0], "met": true, "evidence": evidence, "probe": probe }, { "n": 2, "criterion": crits[1], "met": true, "evidence": "const cdn = none; // all inline here", "probe": probe }]), &crits);
        let p = probes_of(&a, &needs);
        judge(&a, html, false, &ProbeRun::Ran(probe_results(&p, &raw)), &needs, true)
    };
    let ok = json!([{ "ok": true }, { "ok": true }]);
    // Stale / paraphrased quote, specific passing probe: proven, the quote only noted.
    let stale = judged("perMeal = total / meals", "#per-meal", ok.clone());
    assert!(!stale.unmet.iter().any(|u| u.contains("per-meal split")), "{:?}", stale.unmet);
    assert!(stale.gaps.is_empty(), "{:?}", stale.gaps);
    assert_eq!(stale.criteria[0]["evidence_found"], false);
    assert!(stale.criteria[0]["evidence_note"].as_str().unwrap().contains("stale or paraphrased"), "{}", stale.criteria[0]);
    // A criterion that is not behavioural is proven by its passing specific probe too (P1-4): the
    // stale quote is only noted, never "no working code found".
    assert!(!stale.unmet.iter().any(|u| u.contains("Works offline")) && stale.stale.is_empty(), "{:?}", stale.unmet);
    assert!(stale.criteria[1]["evidence_note"].as_str().unwrap().contains("stale or paraphrased"), "{}", stale.criteria[1]);
    // No quote at all: the passing probe stands in, as before.
    let none = judged("", "#per-meal", ok.clone());
    assert!(!none.unmet.iter().any(|u| u.contains("per-meal split")) && none.gaps.is_empty(), "{none:?}");
    // Critic 8: the number read from the whole page proves nothing about the split…
    let page = judged("", "body", ok.clone());
    assert!(page.gaps[0].why.contains("whole page or a container"), "{:?}", page.gaps);
    // …nor from a big container (the harness reports the step: `w`).
    let big = judged("", "#app", json!([{ "ok": true, "w": [1] }, { "ok": true }]));
    assert!(big.gaps[0].why.contains("more than 200 characters"), "{:?}", big.gaps);
    assert!(big.criteria[0]["probe"]["detail"].as_str().unwrap().contains("read a container"), "{}", big.criteria[0]);
    // …and a stale quote next to a weak read is a gap for the verifier, never a Coder fix (P1-4).
    let weak = judged("perMeal = total / meals", "body", ok);
    assert!(!weak.unmet.iter().any(|u| u.contains("per-meal split")) && weak.gaps[0].why.contains("whole page or a container"), "{weak:?}");
    // The rules reject a whole-page value read up front (enforce), with the reason.
    let mut a = read_answers(&json!([{ "n": 1, "criterion": crits[0], "met": true, "evidence": "", "probe": [{ "op": "click", "sel": ".split-btn" }, { "op": "expect_text", "sel": "main", "approx": 40 }] }]), &crits);
    enforce(&mut a, &needs);
    assert!(a.list[0].probe.as_ref().unwrap().as_ref().unwrap_err().contains("whole page"), "{:?}", a.list[0].probe);
    assert!(weak_sel("body") && weak_sel("html body") && weak_sel(" main ") && weak_sel(":root") && weak_sel("*") && weak_sel("body, main"));
    assert!(!weak_sel("#per-meal") && !weak_sel("main #total") && !weak_sel("main.total") && !weak_sel("body, #total"));
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
        // 6: order — the page's own order: corrected to the pinned one (AD-13), not rejected.
        ans(6, json!([{ "op": "expect_order", "sel": ".m", "order": ["3", "5", "4"] }])),
    ]);
    assert!(r[0].as_ref().unwrap_err().contains("only reads the page"), "{:?}", r[0]);
    assert!(r[1].is_ok());
    assert!(r[2].as_ref().unwrap_err().contains("before any set / select / click (pinned value 165)"), "{:?}", r[2]);
    assert!(r[3].as_ref().unwrap_err().contains("round trip") && r[3].as_ref().unwrap_err().contains("use the pinned value 74.84"), "{:?}", r[3]);
    assert_eq!(r[4].as_ref().unwrap()[0]["order"], json!(["3", "4", "5"]), "{:?}", r[4]);
    // The page's own wrong factor is corrected too (the read already looks at the right element);
    // an order check without expect_order and a read of another number are still rejected.
    let r = enforced(vec![
        ans(5, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 72.6 }])),
        ans(6, json!([{ "op": "expect_count", "sel": ".m", "count": 3 }])),
    ]);
    assert_eq!(r[0].as_ref().unwrap()[1], json!({ "op": "expect_value", "sel": "#w", "nth": 0, "approx": 74.84, "tol": 0.5 }), "{:?}", r[0]);
    assert!(r[1].as_ref().unwrap_err().contains("use expect_order"), "{:?}", r[1]);
    assert!(enforced(vec![ans(5, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 9 }]))])[0].as_ref().unwrap_err().contains("it expects 9, but the converted value is pinned"));
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
    assert_eq!(j.gaps, vec![ProbeGap { n: Some(1), criterion: crits[0].clone(), why: "no probe was given".into(), fixable: true, pinned: false, page: false }]);
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

// ── AD-13: numbers as text, corrected pins, changes, units, recall, stuck pages ─

/// A: the run-3 step shapes — the 9B wrote "approx" (and equals / contains) as TEXT. One number
/// becomes approx that number; several ("132 - 165 g") an all-of check (every number must show,
/// number-aware); nothing is rejected for being a string.
#[test]
fn string_approx_from_the_9b_is_read_as_numbers() {
    let run3 = parse_probe(&json!([{ "op": "expect_text", "sel": "#targetDisplay", "approx": "132 - 165 g", "tol": 0.5 }])).unwrap();
    assert_eq!(run3[0], json!({ "op": "expect_text", "sel": "#targetDisplay", "nth": 0, "all": [132.0, 165.0], "tol": 0.5 }));
    let meal = parse_probe(&json!([{ "op": "expect_text", "sel": "#perMeal", "approx": "26 g" }])).unwrap();
    assert_eq!((meal[0]["approx"].as_f64(), meal[0]["tol"].as_f64()), (Some(26.0), Some(0.5)), "one number, the default tolerance");
    let toggle = parse_probe(&json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": "74.8 - 93 g" }])).unwrap();
    assert_eq!(toggle[1]["all"], json!([74.8, 93.0]));
    assert!((toggle[1]["tol"].as_f64().unwrap() - 0.93).abs() < 1e-9, "1 % of the largest number");
    assert_eq!(parse_probe(&json!([{ "op": "expect_text", "sel": "#w", "approx": "~74.8" }])).unwrap()[0]["approx"].as_f64(), Some(74.8));
    // equals / contains with numbers: the numbers, not the spelling ("26g" on the page passes).
    let eq = parse_probe(&json!([{ "op": "expect_text", "sel": "#m", "equals": "26 g" }])).unwrap();
    assert_eq!((eq[0]["approx"].as_f64(), eq[0]["tol"].as_f64(), eq[0].get("equals")), (Some(26.0), Some(EXACT_TOL), None));
    let range = parse_probe(&json!([{ "op": "expect_text", "sel": "#t", "contains": "132-165 g" }])).unwrap();
    assert_eq!((range[0]["all"].clone(), range[0].get("contains")), (json!([132.0, 165.0]), None));
    // Unchanged: one number in contains stays a whole-number token match with its unit; text stays text.
    assert_eq!(parse_probe(&json!([{ "op": "expect_text", "sel": "#a", "contains": "40 g" }])).unwrap()[0]["num"], json!({ "pre": "", "n": "40", "unit": "g" }));
    assert_eq!(parse_probe(&json!([{ "op": "expect_value", "sel": "#act", "equals": "Moderate" }])).unwrap()[0]["equals"], "Moderate");
    assert!(parse_probe(&json!([{ "op": "expect_text", "sel": "#a", "approx": "lots" }])).unwrap_err().contains("\"approx\" needs a number"));
    // The all-of form survives being carried (stored steps are validated again).
    assert_eq!(parse_probe(&Value::Array(run3.clone())).unwrap(), run3);
    // The fix line names every number.
    let r = probe_results(&[probe(0, Value::Array(run3))], &json!([{ "ok": false, "k": "fail", "at": 0, "got": "Loading..." }]));
    assert_eq!(r[0].detail, "got Loading...; expected #targetDisplay text to show 132 and 165 (±0.5) on a fresh load");
    // Numbers as the harness reads them.
    assert_eq!(numbers_in("132-165g"), vec![132.0, 165.0]);
    assert_eq!(numbers_in("-5 °C, 1,200 kcal, 74,8 kg"), vec![-5.0, 1200.0, 74.8]);
    assert_eq!(numbers_in("x-3"), vec![3.0], "a dash after a letter is not a sign");
}

/// E: correct, don't reject (critic 3) — an Order probe always gets the pinned list; a Convert
/// probe whose one-number read follows the switch gets the pinned number (it already looked at
/// the element that showed the bug); both are noted. Round trips and multi-number reads are not.
#[test]
fn pinned_values_are_substituted_not_rejected() {
    let checks = intent_checks(PROTEIN_ASK);
    let expected: Vec<String> = checks.iter().map(|c| c.criterion.clone()).collect();
    let needs: Vec<Need> = checks.iter().map(|c| c.need()).collect();
    let enforced = |n: usize, probe: Value| {
        let mut a = read_answers(&json!([{ "n": n, "criterion": expected[n - 1], "met": true, "evidence": "", "probe": probe }]), &expected);
        enforce(&mut a, &needs);
        let x = a.list.remove(0);
        (x.probe.unwrap(), x.note)
    };
    // The critic's order 3, 5, 4: run with 3, 4, 5.
    let (p, note) = enforced(3, json!([{ "op": "expect_order", "sel": ".split-btn", "attr": "data-meals", "order": ["3", "5", "4"] }]));
    assert_eq!(p.unwrap()[0]["order"], json!(["3", "4", "5"]));
    assert!(note.unwrap().contains("pinned value substituted: the probe expected the order 3, 5, 4"));
    // The critic's "click kg, expect 165": the read of #w after the switch now expects 74.84.
    let (p, note) = enforced(2, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 165 }]));
    assert_eq!(p.unwrap()[1], json!({ "op": "expect_value", "sel": "#w", "nth": 0, "approx": 74.84, "tol": 0.5 }));
    assert!(note.unwrap().contains("the probe expected 165, the pinned value 74.84 was put in its place"));
    // Already right: no note.
    let (p, note) = enforced(2, json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }]));
    assert!(p.is_ok() && note.is_none());
    // Still rejected: a toggle flipped twice, a switch back to lb, a range read (another element).
    assert!(enforced(2, json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "click", "sel": "#unitToggle" }, { "op": "expect_value", "sel": "#w", "approx": 165 }])).0.unwrap_err().contains("clicks #unitToggle 2 times"));
    assert!(enforced(2, json!([{ "op": "select", "sel": "#unit", "value": "kg" }, { "op": "select", "sel": "#unit", "value": "lbs" }, { "op": "expect_value", "sel": "#w", "approx": 165 }])).0.unwrap_err().contains("switches to kg and back to lb"));
    assert!(enforced(2, json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": "74.8 - 93 g" }])).0.unwrap_err().contains("expect a number"));
    // A Default read of another number may be another element: still rejected with the value.
    assert!(enforced(1, json!([{ "op": "expect_value", "sel": "#w", "approx": 150 }])).0.unwrap_err().contains("use the pinned value 165"));
    // The whole page never holds a pinned value.
    assert!(enforced(1, json!([{ "op": "expect_text", "sel": "body", "approx": 165 }])).0.unwrap_err().contains("not the whole page"));
}

/// F (critic 4): a toggle / switch / convert / unit criterion's probe must show a change — not a
/// round trip, not the value it typed in, not the element's value on load (Nic's pinned default).
#[test]
fn a_toggle_probe_must_show_a_change() {
    let mut crits = vec!["The weight unit toggle switches between lb and kg".to_string(), "Adding a food updates the running total".to_string()];
    let mut needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    assert!(needs[0].toggle && needs[0].action && !needs[1].toggle);
    let run = |crits: &[String], needs: &[Need], list: Vec<Value>| {
        let mut a = read_answers(&Value::Array(list), crits);
        enforce(&mut a, needs);
        a.list.into_iter().map(|x| x.probe.unwrap()).collect::<Vec<_>>()
    };
    let one = |steps: Value| run(&crits, &needs, vec![json!({ "n": 1, "criterion": crits[0], "met": true, "evidence": "", "probe": steps })]).remove(0);
    assert!(one(json!([{ "op": "click", "sel": "#kg" }, { "op": "click", "sel": "#lb" }, { "op": "expect_text", "sel": "#unitLabel", "contains": "lb" }])).unwrap_err().contains("switches to kg and back to lb"));
    assert!(one(json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "click", "sel": "#unitToggle" }, { "op": "expect_class", "sel": "#unitToggle", "class": "on" }])).unwrap_err().contains("round trip"));
    assert!(one(json!([{ "op": "set", "sel": "#w", "value": "165" }, { "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 165 }])).unwrap_err().contains("the value it had before the switch"));
    // A change, or a reversible probe that shows one before it switches back: fine.
    assert!(one(json!([{ "op": "set", "sel": "#w", "value": "165" }, { "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }])).is_ok());
    assert!(one(json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }, { "op": "click", "sel": "#lb" }, { "op": "expect_value", "sel": "#w", "approx": 165 }])).is_ok());
    assert!(one(json!([{ "op": "click", "sel": "#kg" }, { "op": "expect_class", "sel": "#kg", "class": "active" }])).is_ok());
    // Not a toggle: typing a value and seeing it in the total is the point.
    let r = run(&crits, &needs, vec![json!({ "n": 2, "criterion": crits[1], "met": true, "evidence": "", "probe": [{ "op": "set", "sel": "#grams", "value": "30" }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#total", "approx": 30 }] })]);
    assert!(r[0].is_ok(), "{r:?}");
    // The page's value on load is known from Nic's pinned default: expecting it after the switch is no change.
    for c in intent_checks("Protein calculator, default 165 lb, with a lb/kg toggle.") {
        crits.push(c.criterion.clone());
        needs.push(c.need());
    }
    let r = run(&crits, &needs, vec![
        json!({ "n": 1, "criterion": crits[0], "met": true, "evidence": "", "probe": [{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_value", "sel": "#weight", "approx": 165 }] }),
        json!({ "n": 3, "criterion": crits[2], "met": true, "evidence": "", "probe": [{ "op": "expect_value", "sel": "#weight", "approx": 165 }] }),
    ]);
    assert!(r[0].as_ref().unwrap_err().contains("it expects 165 on #weight, the value it had before the switch"), "{r:?}");
    assert!(r[1].is_ok());
}

/// G (critic 5): with a unit pair, Nic's default unit must be the one selected on load; the
/// verifier's read of the unit control becomes an `expect_unit` held to it; unit keys only.
#[test]
fn nics_default_unit_is_checked_on_load() {
    let checks = intent_checks(PROTEIN_ASK);
    let expected: Vec<String> = checks.iter().map(|c| c.criterion.clone()).collect();
    let needs: Vec<Need> = checks.iter().map(|c| c.need()).collect();
    let enforced = |probe: Value| {
        let mut a = read_answers(&json!([{ "n": 4, "criterion": expected[3], "met": true, "evidence": "", "probe": probe }]), &expected);
        enforce(&mut a, &needs);
        a.list.remove(0).probe.unwrap()
    };
    let r = enforced(json!([{ "op": "expect_class", "sel": ".unit-btn", "nth": 1, "class": "active", "present": false }])).unwrap();
    assert_eq!(r[0], json!({ "op": "expect_unit", "sel": ".unit-btn", "unit": "lb", "other": "kg" }));
    assert!(enforced(json!([{ "op": "click", "sel": "#lb" }, { "op": "expect_class", "sel": "#lb", "class": "active" }])).unwrap_err().contains("before any set / select / click (pinned unit lb)"));
    assert!(enforced(json!([{ "op": "expect_text", "sel": "body", "contains": "lb" }])).unwrap_err().contains("unit control"));
    // Stored / model-written expect_unit: known unit pairs only (they become regexes in the harness).
    assert!(parse_probe(&json!([{ "op": "expect_unit", "sel": "#u", "unit": "lb", "other": "kg" }])).is_ok());
    assert!(parse_probe(&json!([{ "op": "expect_unit", "sel": "#u", "unit": "lb", "other": "km" }])).unwrap_err().contains("unit pair"));
    assert!(parse_probe(&json!([{ "op": "expect_unit", "sel": "#u", "unit": ".*", "other": "kg" }])).unwrap_err().contains("unit pair"));
    // The harness gets the spellings from the table, with non-ASCII escaped.
    let p = Probe { answer: 0, criterion: "u".into(), carried: false, change: false, steps: parse_probe(&json!([{ "op": "expect_unit", "sel": "#u", "unit": "°f", "other": "°c" }])).unwrap() };
    let page = with_probes("<html><head></head><body></body></html>", &[p]);
    assert!(page.contains("\"U\":\"\\u00b0f|f|fahrenheit|imperial|us|us customary\"") && page.contains("\"O\":\"\\u00b0c|c|celsius|centigrade|metric|si\"") && page.contains("\"UL\":\"\\u00b0f\""), "{}", &page[page.find("var P=").unwrap()..page.find("var P=").unwrap() + 200]);
    let r = probe_results(&[probe(0, json!([{ "op": "expect_unit", "sel": "#u", "unit": "lb", "other": "kg" }]))], &json!([{ "ok": false, "k": "fail", "at": 0, "got": "kg" }]));
    assert_eq!(r[0].detail, "got kg; expected #u to have lb selected on a fresh load");
}

/// H (critic 6): more ways Nic states his values — "I weigh N", "my weight (N unit)", "use that
/// as the default", "pounds/kilograms", "3 to 5 meals per day", "split it across 3-5 meals" — and
/// still nothing for ages, dates, prices or delivery times.
#[test]
fn intent_recall_reads_more_ways_nic_states_his_values() {
    let pinned = |t: &str| intent_checks(t).iter().map(|x| x.pinned()).collect::<Vec<_>>();
    assert_eq!(pinned("I weigh 165 lbs; use that as the default."), vec!["165"]);
    assert_eq!(pinned("I weigh 165 lbs and want a pounds/kilograms switch."), vec!["165", "74.84", "lb"]);
    assert_eq!(pinned("Track protein for my weight (165 pounds) with a pounds/kilograms switch."), vec!["165", "74.84", "lb"]);
    assert_eq!(pinned("My weight is 165 lbs, show it in lb or kg."), vec!["165", "74.84", "lb"]);
    assert_eq!(pinned("Make it 165 lb. That's the default."), vec!["165"]);
    assert_eq!(pinned("Plan 3 to 5 meals per day and show the per-meal split."), vec!["3, 4, 5"]);
    assert_eq!(pinned("Let me choose 3 to 5 meals per day."), vec!["3, 4, 5"]);
    assert_eq!(pinned("Take my daily protein and split it across 3-5 meals."), vec!["3, 4, 5"]);
    // Negatives: an age next to a back-reference (another number sits between), kids' ages,
    // a delivery time, a price range, dates and a time of day.
    assert_eq!(pinned("I'm 28 years old. I weigh 165 lbs; use that as the default."), vec!["165"]);
    assert!(pinned("My son is 5 years old and my daughter is 8 years old; build a chore chart.").is_empty());
    assert!(pinned("Show that orders ship in 3-5 business days.").is_empty());
    assert!(pinned("Snacks cost 3-5 dollars a day; build a budget tracker.").is_empty());
    assert!(pinned("The trip is June 3-5, plan 2 meals a day.").is_empty());
    assert!(pinned("Remind me from 3-5 pm every day.").is_empty());
    assert!(pinned("I weigh 165 lbs.").is_empty(), "a personal stat the page never asks for");
    assert!(pinned("Use that as the default theme. I'm 165 lbs").is_empty(), "a back-reference before the value refers to something else");
}

/// I + G in a real headless Edge: all-of reads, a big container noted, and Nic's unit read off a
/// select, radios, active buttons, aria-pressed and a lone checkbox — correct pages pass, kg
/// active fails, a control with no selected state is a broken probe.
#[test]
fn numbers_containers_and_units_read_right_in_a_real_browser() {
    let Some(dir) = edge_dir("ad13") else { return };
    let page = dir.join("page.html");
    let filler = "Protein keeps you full and helps muscles recover after training. ".repeat(5);
    std::fs::write(&page, format!(r#"<!doctype html><html><head><title>t</title></head><body>
<p id="target">132-165 g</p><div id="app"><h2>Your plan</h2><p>{filler}</p><p>Daily: 40 g per meal</p></div>
<select id="sel"><option value="lbs" selected>Pounds (lb)</option><option value="kg">Kilograms</option></select>
<label><input type="radio" name="u" value="lb" checked> lb</label><label><input type="radio" name="u" value="kg"> kg</label>
<div id="seg"><button class="unit-btn active">lb</button><button class="unit-btn">kg</button></div>
<div id="bad"><button class="b2">lb</button><button class="b2 selected">kg</button></div>
<div><button id="lbBtn">lb</button><button id="kgBtn" aria-pressed="true">kg</button></div>
<div id="aria"><button aria-pressed="true">LB</button><button aria-pressed="false">KG</button></div>
<label for="useKg">Use kg</label><input type="checkbox" id="useKg">
<div id="plain"><span>lb</span><span>kg</span></div>
</body></html>"#)).unwrap();
    let u = |i: usize, sel: &str| probe(i, json!([{ "op": "expect_unit", "sel": sel, "unit": "lb", "other": "kg" }]));
    let probes = vec![
        probe(0, json!([{ "op": "expect_text", "sel": "#target", "approx": "132 - 165 g" }])),
        probe(1, json!([{ "op": "expect_text", "sel": "#target", "approx": "132 - 170 g" }])),
        probe(2, json!([{ "op": "expect_text", "sel": "#app", "approx": 40 }])),
        u(3, "#sel"),
        u(4, "input[name=u]"),
        u(5, ".unit-btn"),
        u(6, "#bad"),
        u(7, "#lbBtn"),
        u(8, "#aria"),
        u(9, "#useKg"),
        u(10, "#plain"),
    ];
    let ProbeRun::Ran(r) = run_probes(&page, &probes, Duration::from_secs(20), Duration::from_secs(240)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    assert!(r[0].passed && r[0].value_specific, "all-of, number-aware: {d:?}");
    assert!(!r[1].passed && d[1].starts_with("got 132-165 g;"), "{d:?}");
    assert!(r[2].passed && !r[2].value_specific && d[2].contains("read a container"), "a container is not the value: {d:?}");
    assert!(r[3].passed && r[4].passed && r[5].passed && r[8].passed && r[9].passed, "select, radios, active buttons, aria-pressed, an unchecked 'Use kg': {d:?}");
    assert!(!r[6].passed && !r[6].error && d[6].starts_with("got kg"), "kg selected on load: {d:?}");
    assert!(!r[7].passed && !r[7].error, "a sibling marked kg: {d:?}");
    assert!(r[10].error && d[10].contains("shows no selected unit"), "{d:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// B: the runtime smoke notes outputs still showing a placeholder after load, before any
/// interaction (run 3: "Loading..." in #targetDisplay until a control changed), and the gate
/// fails with the exact fix; empty-state copy and an empty calculator's "--" are not flagged.
#[test]
fn a_page_stuck_on_loading_fails_the_gate_in_a_real_browser() {
    let Some(dir) = edge_dir("stuck") else { return };
    let w = |name: &str, html: &str| {
        let p = dir.join(name);
        std::fs::write(&p, html).unwrap();
        p
    };
    let stuck = w("stuck.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="weight" type="number" value="165"><p id="targetDisplay" class="target">Loading...</p><p id="foodSummary">No foods yet</p><script>document.getElementById('weight').addEventListener('input', e => { document.getElementById('targetDisplay').textContent = Math.round(e.target.value * 0.8) + ' - ' + e.target.value + ' g'; });</script></body></html>"#);
    let fixed = w("fixed.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="weight" type="number" value="165"><p id="targetDisplay">Loading...</p><p id="foodSummary">No foods yet</p><script>function render(){ const v = document.getElementById('weight').value; document.getElementById('targetDisplay').textContent = Math.round(v * 0.8) + ' - ' + v + ' g'; } document.getElementById('weight').addEventListener('input', render); render();</script></body></html>"#);
    let nan = w("nan.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="g" type="number" value="150"><select id="meals"><option>3</option><option>4</option></select><div class="meal-result"><span>Per meal:</span> <b id="perMealTotal">NaN g</b></div><script>document.getElementById('perMealTotal').textContent = (Number(document.getElementById('g').value) / Number(undefined)) + ' g';</script></body></html>"#);
    let empty = w("empty.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="bill" type="number" placeholder="Bill"><p id="total">--</p><p id="hiddenResult" style="display:none">Loading...</p><script>document.getElementById('bill').addEventListener('input', e => { document.getElementById('total').textContent = '$' + e.target.value; });</script></body></html>"#);
    let t = Duration::from_secs(30);
    let got = |p: &Path| match runtime_smoke(p, t) {
        Smoke::Ran { stuck, errors, .. } => (stuck, errors),
        o => panic!("{o:?}"),
    };
    let (s, errors) = got(&stuck);
    assert_eq!(s, vec![("#targetDisplay".to_string(), "Loading...".to_string())], "{errors:?}");
    assert_eq!(stuck_line(&s), "the page still shows 'Loading...' in #targetDisplay after it loaded (render on startup)");
    assert!(got(&fixed).0.is_empty(), "rendered on startup; empty-state copy is fine");
    assert_eq!(got(&nan).0, vec![("#perMealTotal".to_string(), "NaN g".to_string())], "the innermost output only");
    assert!(got(&empty).0.is_empty(), "nothing typed yet: '--' is an empty state; a hidden element never counts");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── AD-13 review (round 14): recall, pinning, round trips, smoke and unit reads ──

/// A back-reference to a value stays in its own clause, or is the whole next clause, and
/// "default" must not name something else ("the default page / tab / tool").
#[test]
fn a_back_reference_never_crosses_into_another_sentence_or_names_another_thing() {
    let pinned = |t: &str| intent_checks(t).iter().map(|x| x.pinned()).collect::<Vec<_>>();
    assert!(pinned("I'm 165 lbs. Build me a meal planner; this is the default page I open every morning.").is_empty());
    assert!(pinned("Build a protein tracker for 165 lbs. It's the default tool on my phone.").is_empty());
    assert!(pinned("I'm 165 lbs. Build me a stretching routine timer and make it the default tab.").is_empty());
    assert!(pinned("I'm 165 lbs, make it the default tab of my browser.").is_empty());
    // Still read: right after the value, in its clause or as the whole next clause.
    assert_eq!(pinned("I weigh 165 lbs; use that as the default."), vec!["165"]);
    assert_eq!(pinned("Make it 165 lb. That's the default."), vec!["165"]);
    assert_eq!(pinned("I'm 165 lbs, so use that as the default weight."), vec!["165"]);
    assert_eq!(pinned("I'm 165 lbs, use that as the default for the weight input."), vec!["165"]);
}

/// "my <adjective> 10 lbs" is not a stat about Nic; "my (current) weight …" and "my … is …" are.
#[test]
fn a_personal_stat_needs_a_weight_noun_or_is() {
    let pinned = |t: &str| intent_checks(t).iter().map(|x| x.pinned()).collect::<Vec<_>>();
    assert!(pinned("Build a weight-loss tracker with a lb/kg toggle. I want to lose my last 10 lbs by June.").is_empty());
    assert!(pinned("I carry my old 30 lb pack; build a hiking planner with a lb/kg switch.").is_empty());
    assert_eq!(pinned("My current weight is 165 lbs, show it in lb or kg."), vec!["165", "74.84", "lb"]);
    assert_eq!(pinned("Track protein for my weight (165 pounds) with a pounds/kilograms switch."), vec!["165", "74.84", "lb"]);
    assert_eq!(pinned("My daily run is 5 miles; show it in miles or km."), vec!["5", "8.05", "mi"]);
}

/// "N-M <noun> a/per day" is a habit unless a choice word governs its sentence, or it is meals in
/// a request that asks for a per-meal split.
#[test]
fn a_daily_range_is_a_choice_only_with_a_choice_or_a_meal_split() {
    for ask in [
        "I drink 6-8 glasses a day; build a water intake tracker.",
        "Build a water tracker. I drink 6-8 glasses per day; add a + button to log each glass",
        "I eat 3 to 5 meals per day. Build a running protein tally",
        "I do 4-6 pomodoros a day; show today's count",
        "I take 2-3 walks a day; build something that totals my walks",
        "I have 2-3 coffees a day, track my caffeine.",
    ] {
        assert!(intent_checks(ask).is_empty(), "{ask}: {:#?}", intent_checks(ask));
    }
    let pinned = |t: &str| intent_checks(t).iter().map(|x| x.pinned()).collect::<Vec<_>>();
    assert_eq!(pinned("I eat 3 to 5 meals per day; split my protein per meal."), vec!["3, 4, 5"]);
    assert_eq!(pinned("Let me pick 2-4 sessions a day."), vec!["2, 3, 4"]);
}

/// Nic naming the OTHER unit as the default unit means his stat's unit is not checked as selected.
#[test]
fn no_unit_check_when_nic_names_the_other_default_unit() {
    let pinned = |t: &str| intent_checks(t).iter().map(|x| x.pinned()).collect::<Vec<_>>();
    for ask in [
        "I'm 165 lbs. Build a protein calculator with a lb/kg toggle, default unit kg",
        "I'm 165 lbs. Build a protein calculator; the lb/kg toggle should default to kg.",
        "I'm 165 lbs. Build a protein calculator with a lb/kg toggle, metric by default.",
        "I'm 165 lbs. Build a protein calculator with a lb/kg toggle, kg by default.",
        "I'm 165 lbs. Build a protein calculator with a lb/kg toggle; start in kg.",
    ] {
        let p = pinned(ask);
        assert!(!p.contains(&"lb".to_string()), "{ask}: {p:?}");
        assert_eq!(p, vec!["165", "74.84"], "{ask}");
    }
    // Naming lb (his own unit) as the default keeps the check.
    assert_eq!(pinned("I'm 165 lbs. Build a protein calculator with a lb/kg toggle, default unit lb"), vec!["165", "74.84", "lb"]);
}

/// pin(Unit) rewrites the step on the unit control, not a read of the weight number before it.
#[test]
fn the_unit_pin_rewrites_the_unit_step_not_the_number_read() {
    let checks = intent_checks(PROTEIN_ASK);
    let expected: Vec<String> = checks.iter().map(|c| c.criterion.clone()).collect();
    let needs: Vec<Need> = checks.iter().map(|c| c.need()).collect();
    let enforced = |probe: Value| {
        let mut a = read_answers(&json!([{ "n": 4, "criterion": expected[3], "met": true, "evidence": "", "probe": probe }]), &expected);
        enforce(&mut a, &needs);
        a.list.remove(0).probe.unwrap()
    };
    let r = enforced(json!([{ "op": "expect_value", "sel": "#weight", "approx": 165 }, { "op": "expect_class", "sel": "#lbBtn", "class": "active" }])).unwrap();
    assert_eq!(r[0]["op"], "expect_value", "{r:?}");
    assert_eq!(r[1], json!({ "op": "expect_unit", "sel": "#lbBtn", "unit": "lb", "other": "kg" }));
    // A unit word in the expected text counts too; a non-number read wins over a number read.
    let r = enforced(json!([{ "op": "expect_value", "sel": "#weight", "approx": 165 }, { "op": "expect_text", "sel": "#mode", "contains": "lb" }])).unwrap();
    assert_eq!(r[1]["op"], "expect_unit", "{r:?}");
    let r = enforced(json!([{ "op": "expect_value", "sel": "#weight", "approx": 165 }, { "op": "expect_class", "sel": "#pick", "class": "on" }])).unwrap();
    assert_eq!((r[0]["op"].clone(), r[1]["op"].clone()), (json!("expect_value"), json!("expect_unit")), "{r:?}");
    // Only a number read there: it is the one rewritten (as before).
    assert_eq!(enforced(json!([{ "op": "expect_value", "sel": "#weight", "approx": 165 }])).unwrap()[0]["op"], "expect_unit");
}

/// A set between two switches is a real conversion, and a stepper or "Add" clicked twice is not
/// a toggle flipped back; a toggle flipped back with nothing typed in between still is.
#[test]
fn round_trips_need_a_toggle_and_nothing_typed_between() {
    let crits = vec!["The weight unit toggle switches between lb and kg".to_string(), "Meal count buttons switch the per-meal split".to_string(), "The running tally adds up foods and does not change when switching units".to_string()];
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    assert!(needs.iter().all(|n| n.toggle), "{needs:?}");
    let one = |n: usize, steps: Value| {
        let mut a = read_answers(&json!([{ "n": n, "criterion": crits[n - 1], "met": true, "evidence": "", "probe": steps }]), &crits);
        enforce(&mut a, &needs);
        a.list.remove(0).probe.unwrap()
    };
    assert!(one(1, json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "set", "sel": "#weight", "value": "80" }, { "op": "click", "sel": "#unitToggle" }, { "op": "expect_value", "sel": "#weight", "approx": 176.37 }])).is_ok());
    assert!(one(1, json!([{ "op": "select", "sel": "#unit", "value": "kg" }, { "op": "set", "sel": "#weight", "value": "80" }, { "op": "select", "sel": "#unit", "value": "lb" }, { "op": "expect_value", "sel": "#weight", "approx": 176.37 }])).is_ok());
    assert!(one(2, json!([{ "op": "click", "sel": "#mealsUp" }, { "op": "click", "sel": "#mealsUp" }, { "op": "expect_text", "sel": "#perMeal", "approx": 33 }])).is_ok());
    assert!(one(3, json!([{ "op": "set", "sel": "#grams", "value": "30" }, { "op": "click", "sel": "#addBtn" }, { "op": "click", "sel": "#addBtn" }, { "op": "expect_text", "sel": "#tally", "approx": 60 }])).is_ok());
    // Still a round trip: the toggle flipped back with nothing typed between, or kg → lb alone.
    assert!(one(1, json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "click", "sel": "#unitToggle" }, { "op": "expect_value", "sel": "#weight", "approx": 160 }])).unwrap_err().contains("clicks #unitToggle 2 times"));
    assert!(one(1, json!([{ "op": "select", "sel": "#unit", "value": "kg" }, { "op": "select", "sel": "#unit", "value": "lb" }, { "op": "expect_value", "sel": "#weight", "approx": 160 }])).unwrap_err().contains("switches to kg and back to lb"));
}

/// The converted value is substituted only on the element that shows the weight: a read of the
/// protein target (whose upper bound is 165 g with Nic's numbers) is a gap, never a 74.84 probe.
#[test]
fn convert_substitution_only_on_the_weight_element() {
    let checks = intent_checks(PROTEIN_ASK);
    let expected: Vec<String> = checks.iter().map(|c| c.criterion.clone()).collect();
    let needs: Vec<Need> = checks.iter().map(|c| c.need()).collect();
    let enforced = |list: Vec<Value>| {
        let mut a = read_answers(&Value::Array(list), &expected);
        enforce(&mut a, &needs);
        a.list.into_iter().map(|x| x.probe.unwrap()).collect::<Vec<_>>()
    };
    let conv = |probe: Value| json!({ "n": 2, "criterion": expected[1], "met": true, "evidence": "", "probe": probe });
    for probe in [
        json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_text", "sel": "#targetMax", "approx": "165 g" }]),
        json!([{ "op": "select", "sel": "#unit", "value": "kg" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 165 }]),
    ] {
        let r = enforced(vec![conv(probe)]).remove(0);
        assert!(r.as_ref().unwrap_err().contains("use the pinned value 74.84"), "{r:?}");
    }
    // The weight element is still corrected: named for weight, an input read, or the element the
    // Default probe read on load.
    let r = enforced(vec![conv(json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_text", "sel": "#weightDisplay", "approx": 165 }]))]).remove(0);
    assert_eq!(r.unwrap()[1]["approx"], json!(74.84));
    let r = enforced(vec![
        json!({ "n": 1, "criterion": expected[0], "met": true, "evidence": "", "probe": [{ "op": "expect_text", "sel": "#shown", "approx": 165 }] }),
        conv(json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_text", "sel": "#shown", "approx": 165 }])),
    ]);
    assert_eq!(r[1].as_ref().unwrap()[1]["approx"], json!(74.84), "{r:?}");
}

/// The smoke flags a placeholder only where everything to compute from is there, only the bare
/// word "Loading" / "Calculating", and only when it is still there after a short delay.
#[test]
fn the_stuck_smoke_leaves_empty_states_values_and_short_delays_alone_in_a_real_browser() {
    let Some(dir) = edge_dir("stuck2") else { return };
    let w = |name: &str, html: &str| {
        let p = dir.join(name);
        std::fs::write(&p, html).unwrap();
        p
    };
    let tally = w("tally.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="weight" type="number" value="165"><p id="targetDisplay">132 - 165 g</p><input id="foodName" type="text"><input id="grams" type="number"><select id="meal"><option>Breakfast</option><option>Lunch</option></select><p id="tallyTotal">—</p></body></html>"#);
    let tip = w("tip.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="bill" type="number"><select id="tipPct"><option>15</option><option>20</option></select><p id="tipAmount">--</p><p id="totalAmount">--</p></body></html>"#);
    let goal = w("goal.html", r#"<!doctype html><html><head><title>t</title></head><body><select id="phase"><option>Carb loading</option></select><p id="phaseDisplay">Carb loading</p></body></html>"#);
    let delay = w("delay.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="weight" type="number" value="165"><p id="targetDisplay">Calculating...</p><script>setTimeout(function(){document.getElementById('targetDisplay').textContent='132 - 165 g'},1200)</script></body></html>"#);
    let dash = w("dash.html", r#"<!doctype html><html><head><title>t</title></head><body><input id="weight" type="number" value="165"><select id="act"><option>Active</option></select><p id="targetDisplay">--</p><p id="status" class="result">Target: Loading...</p></body></html>"#);
    let t = Duration::from_secs(30);
    let got = |p: &Path| match runtime_smoke(p, t) {
        Smoke::Ran { stuck, .. } => stuck,
        o => panic!("{o:?}"),
    };
    assert!(got(&tally).is_empty(), "the tally before the first food (its grams field is empty)");
    assert!(got(&tip).is_empty(), "nothing typed in the bill yet; a select alone is nothing to compute from");
    assert!(got(&goal).is_empty(), "'Carb loading' is a value");
    assert!(got(&delay).is_empty(), "rendered after 1.2 s");
    assert_eq!(got(&dash), vec![("#targetDisplay".to_string(), "--".to_string()), ("#status".to_string(), "Target: Loading...".to_string())], "every input filled, still a dash; a labelled Loading");
    let _ = std::fs::remove_dir_all(&dir);
}

/// expect_unit reads the unit-control designs a correct page uses: a lone toggle showing its unit,
/// colour-only buttons, a checkbox slider with the units beside it, "unit-active" classes and
/// Imperial / Metric labels; a control naming no unit of the pair is a broken probe.
#[test]
fn more_unit_controls_read_right_in_a_real_browser() {
    let Some(dir) = edge_dir("units2") else { return };
    let page = dir.join("units.html");
    std::fs::write(&page, r#"<!doctype html><html><head><title>t</title><style>.bg-blue-600{background:#2563eb;color:#fff}.bg-gray-200{background:#e5e7eb}</style></head><body>
<div><button id="unitToggle">lb</button></div>
<div><button id="switchTo">Switch to kg</button></div>
<div><button id="kgToggle">kg</button></div>
<div><button id="lbT" class="px-3 bg-blue-600">lb</button><button id="kgT" class="px-3 bg-gray-200">kg</button></div>
<div><button id="lbR" class="px-3 bg-gray-200">lb</button><button id="kgR" class="px-3 bg-blue-600">kg</button></div>
<div><span>lb</span><label class="switch"><input type="checkbox" id="unitSwitch"><span class="slider"></span></label><span>kg</span></div>
<div><span>lb</span><label class="switch"><input type="checkbox" id="unitSwitchOn" checked><span class="slider"></span></label><span>kg</span></div>
<div><button class="u2-btn u2-active">lb</button><button class="u2-btn inactive">kg</button></div>
<select id="unitSystem"><option value="imperial" selected>Imperial</option><option value="metric">Metric</option></select>
<div><button class="sys active">Imperial</button><button class="sys">Metric</button></div>
<div><button class="m active">Dark</button><button class="m">Light</button></div>
</body></html>"#).unwrap();
    let u = |i: usize, sel: &str| probe(i, json!([{ "op": "expect_unit", "sel": sel, "unit": "lb", "other": "kg" }]));
    let probes = vec![u(0, "#unitToggle"), u(1, "#switchTo"), u(2, "#kgToggle"), u(3, "#lbT"), u(4, "#lbR"), u(5, "#unitSwitch"), u(6, "#unitSwitchOn"), u(7, ".u2-btn"), u(8, "#unitSystem"), u(9, ".sys"), u(10, ".m")];
    let ProbeRun::Ran(r) = run_probes(&page, &probes, Duration::from_secs(20), Duration::from_secs(240)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    for i in [0, 1, 3, 5, 7, 8, 9] {
        assert!(r[i].passed, "{i}: {d:?}");
    }
    for i in [2, 4, 6] {
        assert!(!r[i].passed && !r[i].error, "{i}: kg selected is a page failure: {d:?}");
    }
    assert!(r[10].error && d[10].contains("shows no selected unit"), "{d:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── AD-13 critic round 2 (P1-1 … P2-4) ──────────────────────────────────────

/// The run-3 criteria and their needs (the critic's intent).
fn run3_needs() -> (Vec<String>, Vec<Need>) {
    let crits: Vec<String> = [
        "App calculates correct protein target range for default 165 lbs user with 'Active' preset.",
        "Toggle switch correctly converts weight between lbs and kg without breaking calculation.",
        "Per-meal split divides the total target into equal portions for selected meal count (3-5).",
        "UI is responsive on mobile devices and displays clearly without external assets.",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let needs = crits.iter().map(|c| need_of(c, &[])).collect();
    (crits, needs)
}

fn enforced_one(crits: &[String], needs: &[Need], n: usize, probe: Value) -> (Result<Vec<Value>, String>, Option<String>) {
    let mut a = read_answers(&json!([{ "n": n, "criterion": crits[n - 1], "met": true, "evidence": "", "probe": probe }]), crits);
    enforce(&mut a, needs);
    let x = a.list.remove(0);
    (x.probe.unwrap(), x.note)
}

/// P1-1: a read BEFORE the action no longer invalidates a probe (the 9B's "expect 165, click the
/// toggle, expect the result" / "expect 3, select 5, expect the per-meal value"): it is accepted
/// when an expectation follows the first action, and the value rule is held on the reads AFTER
/// it; a probe that expects nothing after its action, or only reads, is still rejected.
#[test]
fn a_read_before_the_action_is_allowed_and_the_reads_after_it_decide() {
    let (crits, needs) = run3_needs();
    assert!(needs[1].action && needs[1].value && needs[1].toggle && needs[2].action && needs[2].value);
    let toggle = json!([{ "op": "expect_value", "sel": "#weightInput", "approx": 165 }, { "op": "click", "sel": "#unitToggle" }, { "op": "expect_value", "sel": "#weightInput", "approx": "74.8 kg", "tol": 0.5 }]);
    assert!(enforced_one(&crits, &needs, 2, toggle).0.is_ok());
    let split = json!([{ "op": "expect_value", "sel": "#mealSplitSelect", "approx": 3 }, { "op": "select", "sel": "#mealSplitSelect", "value": "5" }, { "op": "expect_text", "sel": "#perMealDisplay", "approx": "30 g", "tol": 0.5 }]);
    let (r, note) = enforced_one(&crits, &needs, 3, split.clone());
    assert_eq!(r.unwrap(), parse_probe(&split).unwrap(), "kept as written");
    assert!(note.is_none());
    // The value rule looks at the reads after the action: a number read before it does not count.
    let class_after = json!([{ "op": "expect_text", "sel": "#perMealDisplay", "approx": 49 }, { "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_class", "sel": "#mealSplitSelect", "class": "on" }]);
    assert!(enforced_one(&crits, &needs, 3, class_after).0.unwrap_err().contains("only checks a class or a count"));
    // Still rejected: nothing expected after the action; reads only.
    let nothing_after = json!([{ "op": "expect_text", "sel": "#perMealDisplay", "approx": 49 }, { "op": "select", "sel": "#mealSplitSelect", "value": "4" }]);
    assert!(enforced_one(&crits, &needs, 3, nothing_after).0.unwrap_err().contains("expects nothing after its action"));
    assert!(enforced_one(&crits, &needs, 3, json!([{ "op": "expect_text", "sel": "#perMealDisplay", "approx": 49 }])).0.unwrap_err().contains("only reads the page"));
    // The must-show-a-change rule still holds for a toggle (on the reads after the switch).
    let same = json!([{ "op": "expect_value", "sel": "#weightInput", "approx": 165 }, { "op": "click", "sel": "#unitToggle" }, { "op": "click", "sel": "#unitToggle" }, { "op": "expect_value", "sel": "#weightInput", "approx": 165 }]);
    assert!(enforced_one(&crits, &needs, 2, same).0.unwrap_err().contains("round trip"));
}

/// P1-3 a / b: a value criterion needs a NUMERIC expectation (a text "contains" such as "g" or
/// "Loading" proves no computation), and no probe may expect a placeholder; a zero expected right
/// after a non-zero number was typed is marked for the before / after check.
#[test]
fn value_criteria_need_a_number_and_placeholders_are_never_expected() {
    let (crits, needs) = run3_needs();
    let text = json!([{ "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_text", "sel": "#perMealDisplay", "contains": "g" }]);
    assert!(enforced_one(&crits, &needs, 3, text).0.unwrap_err().contains("expects text, not the computed number"));
    let number_text = json!([{ "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_text", "sel": "#perMealDisplay", "contains": "37 g" }]);
    assert!(enforced_one(&crits, &needs, 3, number_text).0.is_ok(), "a number-aware contains is a number");
    for ph in ["Loading", "Loading...", "Target: Calculating…", "NaN", "NaN%", "undefined g", "null", "--", "-- g", "…", "...", "[object Object]"] {
        assert!(placeholder_kind(ph).is_some(), "{ph}");
        let p = json!([{ "op": "click", "sel": "#unitToggle" }, { "op": "expect_text", "sel": "#targetDisplay", "contains": ph }, { "op": "expect_value", "sel": "#weightInput", "approx": 74.8 }]);
        assert!(enforced_one(&crits, &needs, 2, p).0.unwrap_err().contains("a placeholder a broken page shows"), "{ph}");
    }
    // The critic's copied "Loading" for an on-load criterion is rejected too.
    assert!(enforced_one(&crits, &needs, 1, json!([{ "op": "expect_text", "sel": "#targetDisplay", "contains": "Loading" }])).0.unwrap_err().contains("placeholder"));
    for ok in ["Carb loading", "No foods yet", "132 - 165 g", "kg", "Nancy", "nullable"] {
        assert!(placeholder_kind(ok).is_none(), "{ok}");
    }
    assert_eq!(zero_reads(&parse_probe(&json!([{ "op": "set", "sel": "#g", "value": "30" }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#total", "approx": 0 }, { "op": "expect_text", "sel": "#total", "approx": 30 }])).unwrap()), vec![2]);
    assert!(zero_reads(&parse_probe(&json!([{ "op": "set", "sel": "#g", "value": "0" }, { "op": "expect_text", "sel": "#total", "approx": 0 }])).unwrap()).is_empty(), "a zero typed in");
    assert!(zero_reads(&parse_probe(&json!([{ "op": "set", "sel": "#name", "value": "Chicken" }, { "op": "expect_text", "sel": "#total", "approx": 0 }])).unwrap()).is_empty(), "no number typed");
}

/// P1-3 c: an acting value criterion's probe is marked to show a change (`Probe::change`, carried
/// probes too), the harness gets the marks, and a "same" record reads "nothing changed after …"
/// as a page failure (loop-worthy), not a broken probe.
#[test]
fn an_acting_value_probe_must_show_a_change() {
    let (crits, needs) = run3_needs();
    let a = read_answers(
        &json!([
            { "n": 1, "criterion": crits[0], "met": true, "evidence": "", "probe": [{ "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }] },
            { "n": 3, "criterion": crits[2], "met": true, "evidence": "", "probe": [{ "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_text", "sel": "#perMealDisplay", "approx": 0 }] }
        ]),
        &crits,
    );
    let p = probes_of(&a, &needs);
    assert_eq!(p.iter().map(|x| x.change).collect::<Vec<_>>(), vec![false, true]);
    let open = json!([{ "idx": 2, "criterion": crits[2], "steps": p[1].steps }]);
    let carried = carried_probes(&open, &a, &[], &needs);
    assert!(carried[0].change && carried[0].carried);
    let html = with_probes("<html><head></head><body></body></html>", &p);
    assert!(html.contains("var C=[0,1];"), "{}", &html[..400]);
    let zero = probe(0, json!([{ "op": "set", "sel": "#g", "value": "30" }, { "op": "expect_text", "sel": "#total", "approx": 0 }]));
    assert!(with_probes("<head></head>", &[zero]).contains("\"z\":1"));
    let r = probe_results(&p, &json!([{ "ok": true }, { "ok": false, "k": "same", "at": 1, "got": "0g" }]));
    assert!(!r[1].error && !r[1].passed && r[1].ran, "{:?}", r[1]);
    assert_eq!(r[1].detail, "nothing changed after select #mealSplitSelect=4: #perMealDisplay still shows 0g, as it did before");
}

/// P1-3 c in a real browser: a select that changes nothing fails as "nothing changed" even when
/// the copied expectation (0) matches; a page that updates passes, and a read that legitimately
/// keeps its value next to one that changes is fine; a zero after a typed number — or, since
/// round 4, after a non-zero select — that was already there fails on its own.
#[test]
fn nothing_changed_after_the_action_fails_in_a_real_browser() {
    let Some(dir) = edge_dir("same") else { return };
    let page = dir.join("same.html");
    std::fs::write(&page, r#"<!doctype html><html><head><title>t</title></head><body>
<select id="meals"><option value="3" selected>3</option><option value="4">4</option></select>
<p id="per">0g</p><p id="live">49g</p><p id="target">132 - 165 g</p>
<input id="g" type="number"><button id="add">Add</button><p id="total">0g</p>
<script>document.getElementById('meals').addEventListener('change',function(e){document.getElementById('live').textContent=Math.round(148.5/+e.target.value)+'g'});</script>
</body></html>"#).unwrap();
    let chg = |i: usize, steps: Value| Probe { change: true, ..probe(i, steps) };
    let probes = vec![
        chg(0, json!([{ "op": "select", "sel": "#meals", "value": "4" }, { "op": "expect_text", "sel": "#per", "approx": 0 }])),
        chg(1, json!([{ "op": "select", "sel": "#meals", "value": "4" }, { "op": "expect_text", "sel": "#live", "approx": 37 }, { "op": "expect_text", "sel": "#target", "approx": 132 }])),
        probe(2, json!([{ "op": "set", "sel": "#g", "value": "30" }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#total", "approx": 0 }])),
        probe(3, json!([{ "op": "select", "sel": "#meals", "value": "4" }, { "op": "expect_text", "sel": "#target", "approx": 132 }])),
        probe(4, json!([{ "op": "select", "sel": "#meals", "value": "4" }, { "op": "expect_text", "sel": "#per", "approx": 0 }])),
    ];
    let ProbeRun::Ran(r) = run_probes(&page, &probes, Duration::from_secs(20), Duration::from_secs(200)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    assert!(!r[0].passed && !r[0].error && d[0].starts_with("nothing changed after select #meals=4: #per still shows 0g"), "{d:?}");
    assert!(r[1].passed, "{d:?}");
    assert!(!r[2].passed && d[2].starts_with("nothing changed after set #g=30, click #add: #total still shows 0g"), "{d:?}");
    assert!(r[3].passed, "no change asked for: {d:?}");
    assert!(!r[4].passed && d[4].starts_with("nothing changed after select #meals=4: #per still shows 0g"), "a zero after a non-zero select: {d:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// P2-4: an on-load criterion is decided by its reads BEFORE the first action (an action can
/// trigger the first render); the steps after it are dropped with a note, and a value one needs a
/// number among those reads.
#[test]
fn an_on_load_criterion_is_decided_before_the_first_action() {
    let (crits, needs) = run3_needs();
    assert!(needs[0].fresh && needs[0].value && !needs[0].action);
    let (r, note) = enforced_one(&crits, &needs, 1, json!([{ "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }, { "op": "select", "sel": "#activitySelect", "value": "active" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }]));
    assert_eq!(r.unwrap().len(), 1, "only the read before the action runs");
    assert!(note.unwrap().contains("only its reads before the first action decide"));
    // Its number read only after the select (which could render the page first): rejected.
    let after = json!([{ "op": "expect_text", "sel": "#targetDisplay", "contains": "g" }, { "op": "select", "sel": "#activitySelect", "value": "active" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }]);
    assert!(enforced_one(&crits, &needs, 1, after).0.unwrap_err().contains("expects text, not the computed number"));
    assert!(enforced_one(&crits, &needs, 1, json!([{ "op": "select", "sel": "#activitySelect", "value": "active" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }])).0.unwrap_err().contains("expect it FIRST"));
    // No action: unchanged, no note.
    let (r, note) = enforced_one(&crits, &needs, 1, json!([{ "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }]));
    assert!(r.is_ok() && note.is_none());
}

/// P1-2: only a gap the PAGE can cause (its probe ran and an element is missing) is marked so;
/// no probe, a rejected probe and a broken option are the verifier's.
#[test]
fn only_a_missing_element_is_a_page_caused_gap() {
    let (crits, needs) = run3_needs();
    let a = read_answers(
        &json!([
            { "n": 1, "criterion": crits[0], "met": true, "evidence": "" },
            { "n": 2, "criterion": crits[1], "met": true, "evidence": "", "probe": [{ "op": "expect_text", "sel": "#x", "approx": 1 }] },
            { "n": 3, "criterion": crits[2], "met": true, "evidence": "", "probe": [{ "op": "select", "sel": "#ghost", "value": "4" }, { "op": "expect_text", "sel": "#per", "approx": 37 }] }
        ]),
        &crits,
    );
    let mut a = a;
    enforce(&mut a, &needs);
    let p = probes_of(&a, &needs);
    let run = ProbeRun::Ran(probe_results(&p, &json!([{ "ok": false, "k": "nomatch", "at": 0 }])));
    let j = judge(&a, "<p>x</p>", false, &run, &needs, true);
    let page: Vec<(Option<usize>, bool)> = j.gaps.iter().map(|g| (g.n, g.page)).collect();
    assert_eq!(page, vec![(Some(1), false), (Some(2), false), (Some(3), true)], "{:?}", j.gaps);
    assert!(j.unmet.is_empty(), "{:?}", j.unmet);
    let r = probe_results(&p, &json!([{ "ok": false, "k": "nooption", "at": 0, "got": "3" }]));
    assert!(r[0].error && !r[0].missing);
}

/// P1-4: a criterion that needs no probe (layout, responsive, offline) with a stale quote and
/// nothing else proving it is the verifier's to fix (`stale`), never "no working code found" for
/// the Coder; a passing specific probe proves it anyway; a required behaviour with a stale quote
/// and no probe is a gap only.
#[test]
fn a_stale_quote_is_the_verifiers_to_fix_never_a_coder_fix() {
    let (crits, needs) = run3_needs();
    let html = "<meta name=\"viewport\" content=\"width=device-width\">";
    let stale_ev = "function calculateEverything() { return correctValues(state); }";
    let a = read_answers(&json!([{ "n": 4, "criterion": crits[3], "met": true, "evidence": stale_ev }, { "n": 3, "criterion": crits[2], "met": true, "evidence": stale_ev }]), &crits);
    for probes_on in [true, false] {
        let j = judge(&a, html, false, &ProbeRun::Skipped("the verifier gave no probes".into()), &needs, probes_on);
        assert!(!j.unmet.iter().any(|u| u.contains("UI is responsive")), "{:?}", j.unmet);
        assert_eq!(j.stale, vec![StaleQuote { n: Some(4), criterion: crits[3].clone() }]);
    }
    let j = judge(&a, html, false, &ProbeRun::Skipped("the verifier gave no probes".into()), &needs, true);
    assert!(j.unmet.is_empty() && j.gaps.len() == 1 && j.gaps[0].n == Some(3), "the required behaviour is a gap only: {j:?}");
    assert!(stale_feedback(&j.stale)[0].ends_with(STALE_TAIL) && stale_line(&j.stale[0]).starts_with("couldn't confirm in the code: UI is responsive"));
    // Run 3's real record: the same criterion with a passing probe of its own element.
    let a = read_answers(&json!([{ "n": 4, "criterion": crits[3], "met": true, "evidence": stale_ev, "probe": [{ "op": "expect_count", "sel": "meta[name=viewport]", "count": 1 }] }]), &crits);
    let p = probes_of(&a, &needs);
    let j = judge(&a, html, false, &ProbeRun::Ran(probe_results(&p, &json!([{ "ok": true }]))), &needs, true);
    assert!(j.unmet.is_empty() && j.stale.is_empty(), "{j:?}");
    assert!(j.criteria[0]["evidence_note"].as_str().unwrap().contains("its passing probe proves the criterion"));
}

/// P2-3: NaN / undefined / [object Object] in ANY visible leaf after load is caught (run 3's
/// "NaN%" in #progressText), "null" is still only flagged on output-like elements, and the gate
/// line names a broken value as one.
#[test]
fn broken_values_in_any_visible_leaf_are_caught_in_a_real_browser() {
    assert_eq!(stuck_line(&[("#progressText".into(), "NaN%".into())]), "the page shows 'NaN%' in #progressText after it loaded (a value computed from missing data: compute it from real values on startup)");
    assert_eq!(
        stuck_line(&[("#targetDisplay".into(), "Loading...".into()), ("#progressText".into(), "NaN%".into())]),
        "the page still shows 'Loading...' in #targetDisplay after it loaded (render on startup); the page shows 'NaN%' in #progressText after it loaded (a value computed from missing data: compute it from real values on startup)"
    );
    let Some(dir) = edge_dir("nanleaf") else { return };
    let w = |name: &str, html: &str| {
        let p = dir.join(name);
        std::fs::write(&p, html).unwrap();
        p
    };
    let nan = w("nan.html", r#"<!doctype html><html><head><title>t</title></head><body><div class="bar"><span id="progressText" class="progress-text">0%</span></div><p class="note">Hello <b>x</b></p><span class="hint">null</span><script>document.getElementById('progressText').textContent = Math.round(undefined) + '%';</script></body></html>"#);
    let obj = w("obj.html", r#"<!doctype html><html><head><title>t</title></head><body><ul id="foods"></ul><span hidden>NaN</span><script>[{ name: 'x' }, 'Chicken'].forEach(function (f) { var li = document.createElement('li'); li.className = 'food'; li.textContent = String(f); document.getElementById('foods').appendChild(li); });</script></body></html>"#);
    let fine = w("fine.html", r#"<!doctype html><html><head><title>t</title></head><body><span id="progressText">0%</span><p>Nancy ate a banana; undefinedness is a word.</p></body></html>"#);
    let t = Duration::from_secs(30);
    let got = |p: &Path| match runtime_smoke(p, t) {
        Smoke::Ran { stuck, .. } => stuck,
        o => panic!("{o:?}"),
    };
    assert_eq!(got(&nan), vec![("#progressText".to_string(), "NaN%".to_string())], "a leaf of any name; 'null' in a hint is left alone");
    assert_eq!(got(&obj), vec![("li.food".to_string(), "[object Object]".to_string())], "a hidden NaN is not shown");
    assert!(got(&fine).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

// ── AD-13 review round 3: correct pages that failed, a broken page that passed ──

/// Review: static copy is not a broken value. A typeof quiz's "undefined" answer button and a
/// cheat-sheet cell "NaN" are the page's own markup (`static_broken`), so the any-leaf scan
/// leaves them alone; the same words written by a script still count.
#[test]
fn static_markup_with_nan_or_undefined_is_not_a_stuck_value() {
    let quiz = r#"<!doctype html><html><head><title>t</title><style>td{color:red}</style></head><body>
<div id="answers"><button class="ans" data-a="undefined">undefined</button><button class="ans">object</button></div>
<table><tr><td>typeof x (never declared)</td><td>undefined</td></tr><tr><td>0 / 0</td><td>NaN</td></tr><tr><td>typeof null</td><td class="result">null</td></tr></table>
<p><small>Leave   blank if undefined</small></p><span id="pct">0%</span>
<!-- <td>NaN%</td> --><script>var s = '<b>NaN</b>';</script></body></html>"#;
    let st = static_broken(quiz);
    assert_eq!(st, vec!["button|undefined", "td|undefined", "td|nan", "td|typeof null", "td|null", "small|leave blank if undefined"], "{st:?}");
    assert!(with_harness(quiz).contains(r#"var ST=["button|undefined","td|undefined","td|nan","td|typeof null","td|null","small|leave blank if undefined"],T=[];"#));
    assert_eq!(static_broken(r#"<p id="out">undefined g</p>"#), vec!["#out|undefined g"]);
    let Some(dir) = edge_dir("staticnan") else { return };
    let w = |name: &str, html: &str| {
        let p = dir.join(name);
        std::fs::write(&p, html).unwrap();
        p
    };
    let ok = w("quiz.html", quiz);
    let bad = w("quiz-bad.html", r#"<!doctype html><html><head><title>t</title></head><body><table><tr><td>0 / 0</td><td>NaN</td></tr></table><button class="ans" id="b2">two</button><span id="pct">0%</span>
<script>document.getElementById('b2').textContent = String(undefined); document.getElementById('pct').textContent = Math.round(undefined) + '%';</script></body></html>"#);
    let t = Duration::from_secs(30);
    let got = |p: &Path| match runtime_smoke(p, t) {
        Smoke::Ran { stuck, .. } => stuck,
        o => panic!("{o:?}"),
    };
    assert!(got(&ok).is_empty(), "the quiz's own markup, also inside the output-like #answers and a .result cell");
    let b = got(&bad);
    assert!(b.contains(&("#b2".to_string(), "undefined".to_string())) && b.contains(&("#pct".to_string(), "NaN%".to_string())) && b.len() == 2, "{b:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Review: a criterion that asks for a dash empty state ("show a dash (—) until a bill is typed")
/// may expect the dash; one that does not is still rejected, and a broken value never passes as
/// asked for. A dash used as punctuation names nothing.
#[test]
fn a_placeholder_the_criterion_asks_for_may_be_expected() {
    let crits: Vec<String> = ["On page load the tip and total show a dash (—) as their empty state.", "On page load the total shows the default — computed from the bill.", "Before any data the list shows \"…\" while it is loading."].iter().map(|s| s.to_string()).collect();
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    assert_eq!(needs[0].shows, vec![Placeholder::Dash]);
    assert!(needs[1].shows.is_empty(), "an em dash as punctuation");
    assert_eq!(needs[2].shows, vec![Placeholder::Wait, Placeholder::Ellipsis]);
    assert_eq!(named_placeholders("Shows '--' until the bill is typed"), vec![Placeholder::Dash]);
    let dash = json!([{ "op": "expect_text", "sel": "#total", "equals": "—" }, { "op": "expect_text", "sel": "#tipAmount", "contains": "—" }]);
    let (r, _) = enforced_one(&crits, &needs, 1, dash.clone());
    assert_eq!(r.unwrap().len(), 2, "the dash it asked for");
    assert!(enforced_one(&crits, &needs, 2, dash).0.unwrap_err().contains("a placeholder a broken page shows"));
    assert!(enforced_one(&crits, &needs, 1, json!([{ "op": "expect_text", "sel": "#total", "contains": "NaN" }])).0.unwrap_err().contains("placeholder"), "never a broken value");
    assert!(enforced_one(&crits, &needs, 1, json!([{ "op": "expect_text", "sel": "#total", "contains": "Loading" }])).0.unwrap_err().contains("placeholder"), "only the kind it names");
    assert!(enforced_one(&crits, &needs, 3, json!([{ "op": "expect_text", "sel": "#list", "contains": "…" }])).0.is_ok());
    assert_eq!(placeholder_kind("— g"), Some(Placeholder::Dash));
    assert_eq!(placeholder_kind("..."), Some(Placeholder::Ellipsis));
    assert_eq!(placeholder_kind("undefined"), Some(Placeholder::Broken));
}

/// Review of P2-4: an on-load value criterion whose reads before the first action only read a
/// control (the weight input's default) is never decided by that read: the computed value it
/// reads after the action decides (the whole probe runs), and with no such read it is rejected.
/// A probe that reads the computed value before acting is still cut there.
#[test]
fn an_on_load_value_criterion_is_never_decided_by_a_control_read() {
    let (crits, needs) = run3_needs();
    assert!(needs[0].fresh && needs[0].value);
    let b4 = json!([{ "op": "expect_value", "sel": "#weightInput", "approx": 165 }, { "op": "select", "sel": "#activitySelect", "value": "active" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": "132 - 165 g" }]);
    let (r, note) = enforced_one(&crits, &needs, 1, b4);
    assert_eq!(r.unwrap().len(), 3, "the computed read after the select runs");
    assert!(note.unwrap().contains("only read a control"));
    let only_input = json!([{ "op": "expect_value", "sel": "#weightInput", "approx": 165 }, { "op": "select", "sel": "#activitySelect", "value": "active" }, { "op": "expect_value", "sel": "#activitySelect", "contains": "active" }]);
    assert!(enforced_one(&crits, &needs, 1, only_input).0.unwrap_err().contains("reads only a control"));
    // The select's own read before it acts is a control read too (the selector it selects).
    let own = json!([{ "op": "expect_text", "sel": "#activity", "approx": 1 }, { "op": "select", "sel": "#activity", "value": "active" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }]);
    assert_eq!(enforced_one(&crits, &needs, 1, own).0.unwrap().len(), 3);
    let pre = json!([{ "op": "expect_value", "sel": "#weightInput", "approx": 165 }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }, { "op": "select", "sel": "#activitySelect", "value": "active" }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 132 }]);
    assert_eq!(enforced_one(&crits, &needs, 1, pre).0.unwrap().len(), 2, "a computed read before the action still decides alone");
}

/// Review of P1-3 b: a zero after a reset / clear / zero option is asked for, and a zero read
/// is not a failure when another read in the probe changed.
#[test]
fn a_zero_after_a_reset_or_a_zero_option_is_asked_for() {
    let steps = |v: Value| parse_probe(&v).unwrap();
    let reset = steps(json!([{ "op": "set", "sel": "#foodGrams", "value": "30" }, { "op": "click", "sel": "#addFood" }, { "op": "expect_text", "sel": "#tally", "approx": 30 }, { "op": "click", "sel": "#resetTally" }, { "op": "expect_text", "sel": "#tally", "approx": 0 }]));
    assert!(zero_reads(&reset).is_empty());
    assert_eq!(asked_zero_reads(&reset), vec![4]);
    let no_tip = steps(json!([{ "op": "set", "sel": "#bill", "value": "80" }, { "op": "click", "sel": "#tip-0" }, { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }, { "op": "expect_text", "sel": "#total", "approx": 80 }]));
    assert!(zero_reads(&no_tip).is_empty());
    assert_eq!(asked_zero_reads(&no_tip), vec![2]);
    let none = steps(json!([{ "op": "set", "sel": "#bill", "value": "80" }, { "op": "select", "sel": "#tip", "value": "none" }, { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }]));
    assert_eq!(asked_zero_reads(&none), vec![2]);
    let plain = steps(json!([{ "op": "set", "sel": "#g", "value": "30" }, { "op": "expect_text", "sel": "#total", "approx": 0 }]));
    assert_eq!((zero_reads(&plain), asked_zero_reads(&plain)), (vec![1], vec![]));
    let html = with_probes("<head></head>", &[probe(0, json!([{ "op": "set", "sel": "#bill", "value": "80" }, { "op": "click", "sel": "#tip-0" }, { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }]))]);
    assert!(html.contains("\"n0\":1") && !html.contains("\"z\":1"));
}

/// Review of P1-3 b / c in a real browser: correct pages pass. A radio already checked (the
/// default 4 meals) set again, or the select's current option chosen again, changes no control,
/// so "nothing changed" is not asked of it. "Set bill 80, no tip, expect tip 0 and total 80"
/// passes (the total changed), as does "add 30 g, expect 30, reset, expect 0". A page that never
/// reacts still fails.
#[test]
fn correct_pages_with_defaults_and_zeros_pass_in_a_real_browser() {
    let Some(dir) = edge_dir("defaults") else { return };
    let page = dir.join("p.html");
    std::fs::write(&page, r#"<!doctype html><html><head><title>t</title></head><body>
<label><input type="radio" name="meals" id="meals-3" value="3">3</label><label><input type="radio" name="meals" id="meals-4" value="4" checked>4</label><label><input type="radio" name="meals" id="meals-5" value="5">5</label>
<select id="split"><option value="3">3</option><option value="4" selected>4</option><option value="5">5</option></select>
<p id="perMeal">37 g</p>
<input id="bill" type="number"><button id="tip-0">No tip</button><button id="tip-15">15%</button><p id="tipAmount">$0.00</p><p id="total">$0.00</p>
<input id="foodGrams" type="number"><button id="addFood">Add</button><button id="resetTally">Reset</button><p id="tally">0 g</p>
<input id="g" type="number"><button id="dead">Add</button><p id="sum">0 g</p>
<script>
var pct = 0, tally = 0;
function per(n) { document.getElementById('perMeal').textContent = Math.round(148.5 / n) + ' g'; }
document.querySelectorAll('input[name=meals]').forEach(function (r) { r.addEventListener('change', function () { per(+r.value); }); });
document.getElementById('split').addEventListener('change', function (e) { per(+e.target.value); });
function tip() { var b = +document.getElementById('bill').value || 0; document.getElementById('tipAmount').textContent = '$' + (b * pct / 100).toFixed(2); document.getElementById('total').textContent = '$' + (b * (1 + pct / 100)).toFixed(2); }
document.getElementById('bill').addEventListener('input', tip);
document.getElementById('tip-0').addEventListener('click', function () { pct = 0; tip(); });
document.getElementById('tip-15').addEventListener('click', function () { pct = 15; tip(); });
document.getElementById('addFood').addEventListener('click', function () { tally += +document.getElementById('foodGrams').value || 0; document.getElementById('tally').textContent = tally + ' g'; });
document.getElementById('resetTally').addEventListener('click', function () { tally = 0; document.getElementById('tally').textContent = '0 g'; });
</script></body></html>"#).unwrap();
    let chg = |i: usize, steps: Value| Probe { change: true, ..probe(i, steps) };
    let probes = vec![
        chg(0, json!([{ "op": "set", "sel": "#meals-4", "value": "true" }, { "op": "expect_text", "sel": "#perMeal", "approx": 37, "tol": 1 }])),
        chg(1, json!([{ "op": "select", "sel": "#split", "value": "4" }, { "op": "expect_text", "sel": "#perMeal", "approx": 37, "tol": 1 }])),
        chg(2, json!([{ "op": "set", "sel": "#meals-5", "value": "true" }, { "op": "expect_text", "sel": "#perMeal", "approx": 30, "tol": 1 }])),
        chg(3, json!([{ "op": "set", "sel": "#bill", "value": "80" }, { "op": "click", "sel": "#tip-0" }, { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }, { "op": "expect_text", "sel": "#total", "approx": 80 }])),
        probe(4, json!([{ "op": "set", "sel": "#foodGrams", "value": "30" }, { "op": "click", "sel": "#addFood" }, { "op": "expect_text", "sel": "#tally", "approx": 30 }, { "op": "click", "sel": "#resetTally" }, { "op": "expect_text", "sel": "#tally", "approx": 0 }])),
        chg(5, json!([{ "op": "set", "sel": "#bill", "value": "80" }, { "op": "click", "sel": "#tip-0" }, { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }])),
        probe(6, json!([{ "op": "set", "sel": "#g", "value": "30" }, { "op": "click", "sel": "#dead" }, { "op": "expect_text", "sel": "#sum", "approx": 0 }])),
        chg(7, json!([{ "op": "select", "sel": "#split", "value": "5" }, { "op": "expect_text", "sel": "#tally", "approx": 0 }])),
    ];
    let ProbeRun::Ran(r) = run_probes(&page, &probes, Duration::from_secs(20), Duration::from_secs(300)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    assert_eq!(r.iter().map(|x| x.passed).collect::<Vec<_>>(), vec![true, true, true, true, true, true, false, false], "{d:?}");
    assert!(d[6].starts_with("nothing changed after set #g=30, click #dead: #sum still shows 0 g"), "{d:?}");
    assert!(d[7].starts_with("nothing changed after select #split=5: #tally still shows 0 g"), "{d:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── AD-13 round 4 ───────────────────────────────────────────────────────────

/// F3 b (critic P1, fixed3-c): an unasked zero expected on a computed value after a non-zero set
/// OR select is rejected (a verifier retry, never a Coder loop); a zero asked for by a reset / a
/// zero option, or a "0 before, 30 after" pair on the same element, is fine.
#[test]
fn an_unasked_zero_on_a_computed_value_after_a_nonzero_input_is_rejected() {
    let crits: Vec<String> = ["Per-meal split divides the total target into equal portions for selected meal count (3-5).", "Running tally accurately sums added food protein grams against the daily target.", "Reset clears the running tally back to 0 g."].iter().map(|s| s.to_string()).collect();
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    let select_zero = json!([{ "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_text", "sel": "#perMealDisplay", "approx": 0 }]);
    let why = enforced_one(&crits, &needs, 1, select_zero.clone()).0.unwrap_err();
    assert!(why.starts_with("it expects 0 on #perMealDisplay after select #mealSplitSelect=4"), "{why}");
    let steps = parse_probe(&select_zero).unwrap();
    assert_eq!(zero_reads(&steps), vec![1], "a non-zero select arms the zero read too");
    assert!(zero_reads(&parse_probe(&json!([{ "op": "select", "sel": "#tip", "value": "0" }, { "op": "expect_text", "sel": "#t", "approx": 0 }])).unwrap()).is_empty(), "a zero option");
    // A zero before the add, the sum after it: a real change.
    let before_after = json!([{ "op": "set", "sel": "#g", "value": "30" }, { "op": "expect_text", "sel": "#total", "approx": 0 }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#total", "approx": 30 }]);
    assert!(enforced_one(&crits, &needs, 2, before_after).0.is_ok());
    // Never does what produces the value: only zeros after typing a name.
    let name_only = json!([{ "op": "click", "sel": "#toggleFoodForm" }, { "op": "set", "sel": "#foodName", "value": "Chicken" }, { "op": "expect_text", "sel": "#intakeDisplay", "approx": 0 }]);
    assert!(enforced_one(&crits, &needs, 2, name_only).0.unwrap_err().starts_with("it expects only 0 after its actions"));
    // A reset asks for its zero.
    let reset = json!([{ "op": "set", "sel": "#foodGrams", "value": "30" }, { "op": "click", "sel": "#addFood" }, { "op": "expect_text", "sel": "#tally", "approx": 30 }, { "op": "click", "sel": "#resetTally" }, { "op": "expect_text", "sel": "#tally", "approx": 0 }]);
    assert!(enforced_one(&crits, &needs, 3, reset).0.is_ok());
    // The right number after the select is fine.
    assert!(enforced_one(&crits, &needs, 1, json!([{ "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_text", "sel": "#perMealDisplay", "approx": 37, "tol": 1.5 }])).0.is_ok());
}

/// F6: sums, tallies, totals, running totals and "adds up" compute a value, so a running-tally
/// criterion gets the must-change mark; a dash empty-state criterion stays a text check.
#[test]
fn a_running_tally_computes_and_must_change() {
    for c in ["Running tally accurately sums added food protein grams against the daily target.", "The running total updates when a food is added.", "Adding foods keeps a tally of protein eaten today.", "The eaten grams add up to the shown total."] {
        let n = need_of(c, &[]);
        assert!(n.probe && n.value && n.action && must_change(Some(&n)), "{c}: {n:?}");
    }
    let dash = need_of("On page load the tip and total show a dash (—) as their empty state.", &[]);
    assert!(!dash.value && dash.shows == vec![Placeholder::Dash], "{dash:?}");
    assert!(!need_of("UI is responsive on mobile devices and works offline.", &[]).value);
}

// ── AD-13 round 5 ───────────────────────────────────────────────────────────

/// F3b review (round 5): correct legitimate-zero probes pass the zero rule. A no-tip option
/// spelled as an attribute selector, a camel-case None id, or a "0%" / "0.00" option is a zero
/// option (`zeroing`), and a zero the criterion names ("$0.00", "never below 0") passes when
/// another, non-control element proves the change. An unasked zero on a criterion that names no
/// zero (fixed3-c) is still rejected, even with a change elsewhere.
#[test]
fn a_zero_the_criterion_asks_for_is_not_rejected() {
    let tip = "Choosing the No tip option makes the tip $0.00 and the total equal to the bill.";
    let left = "Shows the grams left to reach the daily target: the target minus the running total, never below 0.";
    let crits: Vec<String> = [tip, left, "Per-meal split divides the total target into equal portions for selected meal count (3-5)."].iter().map(|s| s.to_string()).collect();
    let needs: Vec<Need> = crits.iter().map(|c| need_of(c, &[])).collect();
    assert!(needs[0].value && needs[0].zero && needs[1].value && needs[1].zero && !needs[2].zero, "{needs:?}");
    for (op, sel, value) in [("click", r#"button[data-pct="0"]"#, ""), ("click", ".tip-btn[data-pct='0']", ""), ("click", "#tipNone", ""), ("select", "#tipPct", "0%"), ("select", "#tipPct", "0.00"), ("select", "#tipPct", "0 %")] {
        let mut act = json!({ "op": op, "sel": sel });
        if !value.is_empty() {
            act["value"] = json!(value);
        }
        let probe = json!([{ "op": "set", "sel": "#bill", "value": "80" }, act, { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }, { "op": "expect_text", "sel": "#total", "approx": 80 }]);
        let steps = parse_probe(&probe).unwrap();
        assert!(zeroing(&steps[1]), "{sel} {value} is a zero option");
        assert!(zero_reads(&steps).is_empty() && asked_zero_reads(&steps) == vec![2], "{sel} {value}");
        assert!(enforced_one(&crits, &needs, 1, probe).0.is_ok(), "{sel} {value}");
        // Without the total read, the zero option alone still asks for its zero.
        let alone = json!([{ "op": "set", "sel": "#bill", "value": "80" }, steps[1].clone(), { "op": "expect_text", "sel": "#tipAmount", "approx": 0 }]);
        assert!(enforced_one(&crits, &needs, 1, alone).0.is_ok(), "{sel} {value}");
    }
    assert!(!zeroing(&json!({ "op": "select", "sel": "#tipPct", "value": "0.5" })) && !zeroing(&json!({ "op": "click", "sel": "button[data-pct='05']" })) && !zeroing(&json!({ "op": "click", "sel": "#nonexistent" })));
    // The goal-reached boundary: add 165 g, left 0, tally 165 (the tally proves the add).
    let boundary = json!([{ "op": "set", "sel": "#grams", "value": "165" }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#left", "approx": 0 }, { "op": "expect_text", "sel": "#tally", "approx": 165 }]);
    assert_eq!(zero_reads(&parse_probe(&boundary).unwrap()), vec![2]);
    assert!(enforced_one(&crits, &needs, 2, boundary).0.is_ok());
    // A zero-naming criterion with only the zero read, or with a non-zero read only on the input it
    // typed into, proves no change: still rejected.
    let lone = json!([{ "op": "set", "sel": "#grams", "value": "165" }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#left", "approx": 0 }]);
    assert!(enforced_one(&crits, &needs, 2, lone).0.unwrap_err().starts_with("it expects 0 on #left"));
    let echo = json!([{ "op": "set", "sel": "#grams", "value": "165" }, { "op": "click", "sel": "#add" }, { "op": "expect_text", "sel": "#left", "approx": 0 }, { "op": "expect_value", "sel": "#grams", "approx": 165 }]);
    assert!(enforced_one(&crits, &needs, 2, echo).0.is_err());
    // fixed3-c stays rejected, even with a non-zero read elsewhere: its criterion names no zero.
    let per_meal = json!([{ "op": "select", "sel": "#mealSplitSelect", "value": "4" }, { "op": "expect_text", "sel": "#perMealDisplay", "approx": 0 }, { "op": "expect_text", "sel": "#targetDisplay", "approx": 150 }]);
    assert!(enforced_one(&crits, &needs, 3, per_meal).0.unwrap_err().starts_with("it expects 0 on #perMealDisplay"));
}

/// AD-13 round 6: a dispute line always says what the verifier now expects (the real permeal
/// runs were cut at 240 chars inside the "before" detail and never reached it); only the old
/// probe's finding is clipped, and it is left out when too little room remains.
#[test]
fn a_dispute_line_always_says_what_is_now_expected() {
    let crit = "Per-meal split divides the total target into equal portions for selected meal count (3-5).";
    let before = "got 41g; expected #perMealDisplay text ≈37 (±1.5) after select #mealSplitSelect=4";
    let now = "expected #perMealDisplay text ≈41 (±1.5)";
    let l = dispute_line(crit, now, before);
    assert!(l.chars().count() <= DISPUTE_LINE, "{l}");
    assert!(l.starts_with("couldn't be checked: on recheck the verifier switched to the page's value, for Per-meal split"), "{l}");
    assert!(l.contains("; now expected #perMealDisplay text ≈41 (±1.5); before: got 41g; expected #perMealDisplay text ≈37 (±1.5"), "{l}");
    // The longest criterion and expectation still fit whole (clipped to their own caps); the
    // "before" detail is what gets cut.
    let long = dispute_line(&"c".repeat(300), &format!("expected #x text ≈41 {}", "n".repeat(300)), &"b".repeat(300));
    assert!(long.chars().count() <= DISPUTE_LINE, "{long}");
    assert!(long.contains(&format!("; now expected #x text ≈41 {}", "n".repeat(30))), "{long}");
    assert!(!long.contains("; before: ") || long.ends_with('\u{2026}'), "{long}");
    let bare = dispute_line(crit, now, "");
    assert!(bare.ends_with(&format!("; now {now}")) && !bare.contains("before"), "{bare}");
    // Real lengths: the whole line is under the cap with the old finding's numbers in it.
    let b = dispute_line(crit, now, &format!("{before} {}", "z".repeat(200)));
    assert!(b.chars().count() <= DISPUTE_LINE && b.ends_with('\u{2026}') && b.contains("≈37"), "{b}");
}

/// Widget builder, end to end on the checking side: the fortune cookie's five brief points as the
/// verifier probes them in a real headless Edge. A page that does all five passes all five; a page
/// that keeps 6 history entries and shows 5 lucky numbers fails exactly those two. The page uses
/// the style kit (variables + the cc-theme listener) like a generated dashboard widget must.
#[test]
fn the_fortune_cookie_brief_is_checked_point_by_point_in_a_real_browser() {
    let Some(dir) = edge_dir("fortune") else { return };
    let page = |keep: usize, lucky: usize| {
        format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><title>Fortune cookie</title>
<style>:root{{--cc-accent:#ff7a2f;--cc-accent-2:#00e5c3;--cc-card:rgba(24,28,38,.62);--cc-text:#f8fafc;--cc-text-2:#a1a8b8;--cc-text-3:#5a6275;--cc-radius:20px;--cc-font:ui-sans-serif,system-ui,sans-serif;--cc-font-scale:1;--cc-border:rgba(255,255,255,.16)}}
body{{background:transparent;color:var(--cc-text);font-family:var(--cc-font)}} .cracked{{transform:rotate(8deg)}} button{{background:var(--cc-accent);border-radius:var(--cc-radius)}}</style>
<script>addEventListener('message',function(e){{var d=e.data;if(d&&d.type==='cc-theme'&&d.vars)for(var k in d.vars)if(k.indexOf('--cc-')===0)document.documentElement.style.setProperty(k,String(d.vars[k]));}});</script>
</head><body>
<button id="cookie" aria-label="Fortune cookie">🥠</button>
<p id="fortune"></p><div id="lucky"></div>
<button id="new">New fortune</button>
<ol id="history"></ol>
<script>
var F=["A fresh start will put you on your way.","Your hard work will soon pay off.","Adventure awaits you this week.","A friend asks only for your time.","Good news will come to you by mail."];
var hist=[];
function tell(){{
  var f=F[Math.floor(Math.random()*F.length)];
  document.getElementById('fortune').textContent=f;
  var n=[];while(n.length<{lucky}){{var x=1+Math.floor(Math.random()*49);if(n.indexOf(x)<0)n.push(x);}}
  document.getElementById('lucky').innerHTML=n.map(function(x){{return '<span>'+x+'</span>';}}).join(' ');
  hist.unshift(f);hist=hist.slice(0,{keep});
  document.getElementById('history').innerHTML=hist.map(function(h){{var li=document.createElement('li');li.textContent=h;return li.outerHTML;}}).join('');
}}
document.getElementById('cookie').addEventListener('click',function(){{this.classList.add('cracked');tell();}});
document.getElementById('new').addEventListener('click',tell);
</script></body></html>"#
        )
    };
    let probes = || {
        vec![
            probe(0, json!([{ "op": "click", "sel": "#cookie" }, { "op": "expect_class", "sel": "#cookie", "class": "cracked", "present": true }])),
            probe(1, json!([{ "op": "click", "sel": "#cookie" }, { "op": "expect_count", "sel": "#fortune:not(:empty)", "count": 1 }])),
            probe(2, json!([{ "op": "click", "sel": "#cookie" }, { "op": "click", "sel": "#new" }, { "op": "expect_count", "sel": "#history li", "count": 2 }])),
            probe(3, json!([{ "op": "click", "sel": "#cookie" }, { "op": "click", "sel": "#new" }, { "op": "click", "sel": "#new" }, { "op": "click", "sel": "#new" }, { "op": "click", "sel": "#new" }, { "op": "click", "sel": "#new" }, { "op": "click", "sel": "#new" }, { "op": "expect_count", "sel": "#history li", "count": 5 }])),
            probe(4, json!([{ "op": "click", "sel": "#cookie" }, { "op": "expect_count", "sel": "#lucky span", "count": 6 }])),
        ]
    };
    let good = dir.join("good.html");
    std::fs::write(&good, page(5, 6)).unwrap();
    let ProbeRun::Ran(r) = run_probes(&good, &probes(), Duration::from_secs(20), Duration::from_secs(240)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    assert!(r.iter().all(|x| x.passed), "every point of a correct cookie passes: {d:?}");
    let bad = dir.join("bad.html");
    std::fs::write(&bad, page(6, 5)).unwrap();
    let ProbeRun::Ran(r) = run_probes(&bad, &probes(), Duration::from_secs(20), Duration::from_secs(240)) else { panic!("edge ran") };
    let d: Vec<&str> = r.iter().map(|x| x.detail.as_str()).collect();
    assert!(r[0].passed && r[1].passed && r[2].passed, "{d:?}");
    assert!(!r[3].passed && !r[3].error, "history kept 6, not the last 5: {d:?}");
    assert!(!r[4].passed && !r[4].error, "5 lucky numbers, not 6: {d:?}");
    let _ = std::fs::remove_dir_all(&dir);
}
