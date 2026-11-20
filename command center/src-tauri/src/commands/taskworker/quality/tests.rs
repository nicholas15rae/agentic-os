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
    let probes = probes_of(&answers);
    assert_eq!(probes.len(), 3);
    let run = ProbeRun::Ran(probe_results(&probes, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }, { "ok": false, "k": "nomatch", "at": 0 }, { "ok": false, "k": "nomatch", "at": 0 }])));
    let j = judge(&answers, html, false, &run);
    assert_eq!(j.unmet.len(), 2, "{:?}", j.unmet);
    assert!(j.unmet[0].starts_with("probe failed for The lb/kg toggle converts the weight: got 165; expected #w value ≈74.8"), "{:?}", j.unmet);
    // Criterion 2: its probe's selector matched nothing but the evidence is real: not counted.
    assert!(!j.unmet.iter().any(|u| u.contains("Meal split")));
    assert_eq!(j.criteria[1]["probe"]["error"], true);
    // Criterion 3: no real evidence AND a broken probe: unmet, with the probe named.
    assert!(j.unmet[1].starts_with("no working code found for: Saved state") && j.unmet[1].contains("#ghost matches nothing"), "{:?}", j.unmet);
    // Probes that did not run: evidence decides, the record says why.
    let skipped = judge(&answers, html, false, &ProbeRun::Skipped("Edge is not installed".into()));
    assert_eq!(skipped.unmet.len(), 1, "only the unevidenced one");
    assert_eq!(skipped.criteria[0]["probe"]["detail"], "skipped: Edge is not installed");
    // Undecided criteria: "not shown" when the code was cut, never unmet.
    let shown = read_answers(&json!([{ "n": 1, "criterion": "x", "met": null }]), &crit_list()[..1]);
    let j = judge(&shown, html, true, &ProbeRun::Skipped("no probes".into()));
    assert!(j.unmet.is_empty() && j.not_judged[0].starts_with("not shown to the verifier"), "{j:?}");
    // A rejected probe is reported, never run.
    let rejected = read_answers(&json!([{ "n": 1, "criterion": "x", "met": true, "evidence": "function toggleUnit(unit) {", "probe": [{ "op": "eval" }] }]), &crit_list()[..1]);
    assert!(probes_of(&rejected).is_empty());
    let j = judge(&rejected, html, false, &ProbeRun::Skipped("no probes".into()));
    assert!(j.criteria[0]["probe"]["detail"].as_str().unwrap().starts_with("probe rejected"));
    assert!(judge(&read_answers(&Value::Null, &crit_list()), html, false, &ProbeRun::Skipped(String::new())).absent);
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
    let j = judge(&answers, "", false, &ProbeRun::Ran(r));
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
    let hung = unfinished(&probes_of(&answers)[0], None, "no result after 20s");
    let j = judge(&answers, html, false, &ProbeRun::Ran(vec![hung]));
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
    let p1 = probes_of(&a1);
    let run1 = ProbeRun::Ran(probe_results(&p1, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }])));
    let open = open_probes(&p1, &run1, &a1);
    assert_eq!(open.as_array().unwrap().len(), 1);
    assert_eq!(open[0]["idx"], 0);
    // Pass 2: the verifier quotes the code and writes no probe: the carried one still runs.
    let a2 = read_answers(&json!([{ "n": 1, "criterion": "lb/kg toggle", "met": true, "evidence": ev }]), &crit_list());
    let carried = carried_probes(&open, &a2, &probes_of(&a2));
    assert_eq!(carried.len(), 1);
    assert!(carried[0].carried && carried[0].answer == 0);
    let again = ProbeRun::Ran(probe_results(&carried, &json!([{ "ok": false, "k": "fail", "at": 2, "got": "165" }])));
    let j = judge(&a2, html, false, &again);
    assert!(j.unmet[0].starts_with("probe failed again for lb/kg toggle: got 165;"), "{:?}", j.unmet);
    assert_eq!(j.criteria[0]["probe"]["rechecked"][0]["passed"], false);
    assert_eq!(open_probes(&carried, &again, &a2).as_array().unwrap().len(), 1, "still open");
    // The Coder renamed the button: the carried probe matches nothing and nothing new passed.
    let gone = ProbeRun::Ran(probe_results(&carried, &json!([{ "ok": false, "k": "nomatch", "at": 1 }])));
    let j = judge(&a2, html, false, &gone);
    assert!(j.unmet[0].starts_with("a probe that failed before now matches nothing for lb/kg toggle"), "{:?}", j.unmet);
    // …but a new probe for the same criterion that passes settles it, and closes the old one.
    let a3 = read_answers(&json!([{ "n": 1, "criterion": "lb/kg toggle", "met": true, "evidence": ev, "probe": [{ "op": "click", "sel": "#to-kg" }, { "op": "expect_value", "sel": "#w", "approx": 74.8 }] }]), &crit_list());
    let mut all = probes_of(&a3);
    let more = carried_probes(&open, &a3, &all);
    all.extend(more);
    assert_eq!(all.len(), 2);
    let run3 = ProbeRun::Ran(probe_results(&all, &json!([{ "ok": true }, { "ok": false, "k": "nomatch", "at": 1 }])));
    assert!(judge(&a3, html, false, &run3).unmet.is_empty());
    assert_eq!(open_probes(&all, &run3, &a3), json!([]));
    // Passing again closes it; a run that never happened keeps it open.
    let passed = ProbeRun::Ran(probe_results(&carried, &json!([{ "ok": true }])));
    assert!(judge(&a2, html, false, &passed).unmet.is_empty());
    assert_eq!(open_probes(&carried, &passed, &a2), json!([]));
    assert_eq!(open_probes(&carried, &ProbeRun::Skipped("no Edge".into()), &a2).as_array().unwrap().len(), 1);
    // The same steps written again by the verifier run once.
    let a4 = read_answers(&json!([{ "n": 1, "criterion": "lb/kg toggle", "met": true, "evidence": ev, "probe": steps }]), &crit_list());
    assert!(carried_probes(&open, &a4, &probes_of(&a4)).is_empty());
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
