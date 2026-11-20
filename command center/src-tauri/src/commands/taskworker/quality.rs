//! The build quality gate's deterministic checks (no model): Nic's exact values carried into the
//! page, no external code (the page must work offline), DOM ids the script uses exist, storage
//! access guarded, per-criterion evidence from the verifier really present in the code, and an
//! optional headless-browser runtime smoke (load + light interaction with storage blocked and the
//! network unreachable). Everything here is pure except `runtime_smoke`, which spawns a local
//! headless Edge on a temp copy of the page and never touches the network.
//!
//! Why (2026-11-20 protein-app run): a build passed every stage while its core feature never
//! worked, it loaded Tailwind from a CDN against "works offline", lost Nic's "165 lb", and crashed
//! on load when storage was blocked. The old gate only checked structure and keyword coverage.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A number-with-unit Nic said ("165 lbs", "3 meals"): kept verbatim through spec → brief → code.
#[derive(Debug, Clone, PartialEq)]
pub struct Literal {
    pub number: String,
    pub unit: String,
    /// As Nic wrote it ("165 lbs").
    pub phrase: String,
}

/// Units worth carrying. Ambiguous one-letter words ("in", "m", "l") are left out on purpose.
const UNITS: &str = r"lbs?|pounds?|kgs?|kilograms?|kilos?|g/kg|grams?|g|oz|ounces?|cups?|ml|liters?|litres?|kcal|calories|cal|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|%|percent|meals?|servings?|snacks?|steps?|reps?|sets?|miles?|km|meters?|feet|ft|inches|°f|°c|dollars?|usd|bpm|words?|items?|players?|levels?|rounds?";

/// Nic's numbers-with-units, in order, deduped, at most 8. Pure.
pub fn intent_literals(text: &str) -> Vec<Literal> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(&format!(r"(?i)(?:^|[^\w.])(\d{{1,6}}(?:\.\d+)?)\s?({UNITS})(?:$|[^\w/])")).unwrap());
    let mut out: Vec<Literal> = Vec::new();
    // Overlapping matches (the trailing boundary char is consumed): scan from each match's unit end.
    let mut from = 0;
    while let Some(c) = re.captures_at(text, from) {
        let (n, u) = (c.get(1).unwrap(), c.get(2).unwrap());
        from = u.end();
        let lit = Literal { number: n.as_str().to_string(), unit: u.as_str().to_lowercase(), phrase: text[n.start()..u.end()].to_string() };
        if !out.iter().any(|l| l.number == lit.number && unit_family(&l.unit) == unit_family(&lit.unit)) {
            out.push(lit);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// Spellings a page may use for the unit (lowercase stems). Pure.
fn unit_family(unit: &str) -> &'static [&'static str] {
    match unit.trim_end_matches('s') {
        "lb" | "pound" => &["lb", "pound"],
        "kg" | "kilogram" | "kilo" => &["kg", "kilo"],
        "g/kg" => &["g/kg", "per kg", "/kg"],
        "g" | "gram" => &["g", "gram"],
        "oz" | "ounce" => &["oz", "ounce"],
        "kcal" | "calorie" | "cal" => &["cal"],
        "minute" | "min" => &["min"],
        "hour" | "hr" => &["hour", "hr"],
        "second" | "sec" => &["sec"],
        "%" | "percent" => &["%", "percent"],
        "meal" => &["meal"],
        "serving" => &["serving"],
        _ => &[],
    }
}

/// The literal's number as a whole token (not part of a longer number). Pure.
fn number_present(hay: &str, num: &str) -> bool {
    let b = hay.as_bytes();
    let mut from = 0;
    while let Some(i) = hay[from..].find(num) {
        let s = from + i;
        let e = s + num.len();
        let before_ok = s == 0 || !(b[s - 1].is_ascii_digit() || (b[s - 1] == b'.' && s >= 2 && b[s - 2].is_ascii_digit()));
        let after_ok = e >= b.len() || !(b[e].is_ascii_digit() || (b[e] == b'.' && e + 1 < b.len() && b[e + 1].is_ascii_digit()));
        if before_ok && after_ok {
            return true;
        }
        from = s + 1;
    }
    false
}

/// One line per literal the page lost. Pure.
pub fn missing_literals(html: &str, lits: &[Literal]) -> Vec<String> {
    let low = html.to_lowercase();
    lits.iter()
        .filter(|l| {
            let fam = unit_family(&l.unit);
            !number_present(&low, &l.number) || (!fam.is_empty() && !fam.iter().any(|u| low.contains(u)))
        })
        .map(|l| format!("Nic's exact value \"{}\" (use it as given, e.g. as the default; it is missing from the page)", l.phrase))
        .collect()
}

/// "165 lbs; 3 meals" for a prompt (empty when there are none). Pure.
pub fn literals_line(text: &str) -> String {
    intent_literals(text).into_iter().map(|l| l.phrase).collect::<Vec<_>>().join("; ")
}

/// Ids the script looks up by a literal string that no element (markup, template string or
/// `el.id = …`) defines. At most 6. Pure.
pub fn dom_id_gaps(html: &str) -> Vec<String> {
    static USE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static DEF: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let used = USE.get_or_init(|| regex::Regex::new(r#"(?:getElementById\(\s*["']([A-Za-z][\w:-]*)["']\s*\)|querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)["']\s*\))"#).unwrap());
    let def = DEF.get_or_init(|| regex::Regex::new(r#"(?i)(?:\bid\s*=\s*\\?["']?|\.id\s*=\s*["']|setAttribute\(\s*["']id["']\s*,\s*["'])([A-Za-z][\w:-]*)"#).unwrap());
    let defined: std::collections::HashSet<&str> = def.captures_iter(html).filter_map(|c| c.get(1)).map(|m| m.as_str()).collect();
    let mut out: Vec<String> = Vec::new();
    for c in used.captures_iter(html) {
        let id = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str()).unwrap_or("");
        if !id.is_empty() && !defined.contains(id) && !out.iter().any(|o| o == id) {
            out.push(id.to_string());
            if out.len() >= 6 {
                break;
            }
        }
    }
    out
}

/// localStorage / sessionStorage uses outside any `try { … }` block, over the page's inline
/// scripts. A heuristic scanner (comments and string literals skipped). Pure.
pub fn unguarded_storage(html: &str) -> usize {
    super::super::buildhub::smoke::inline_scripts(html).iter().map(|s| unguarded_in(s)).sum()
}

fn unguarded_in(src: &str) -> usize {
    let b = src.as_bytes();
    let mut i = 0;
    let mut stack: Vec<bool> = Vec::new();
    let mut pending_try = false;
    let mut n = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            i += 1;
            while i < b.len() && b[i] != c {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            pending_try = false;
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' || c == b'$' {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                i += 1;
            }
            let w = &src[s..i];
            // A property named like it (`obj.localStorage`) still reads the real thing; count it.
            if w == "try" {
                pending_try = true;
                continue;
            }
            if (w == "localStorage" || w == "sessionStorage") && !stack.iter().any(|t| *t) {
                n += 1;
            }
            pending_try = false;
            continue;
        }
        match c {
            b'{' => {
                stack.push(pending_try);
                pending_try = false;
            }
            b'}' => {
                stack.pop();
                pending_try = false;
            }
            c if c.is_ascii_whitespace() => {}
            _ => pending_try = false,
        }
        i += 1;
    }
    n
}

/// The page's code for a verifier prompt: whole when it fits, else head + tail with a marker. Pure.
pub fn code_excerpt(html: &str, max: usize) -> String {
    let n = html.chars().count();
    if n <= max {
        return html.to_string();
    }
    let head = max * 3 / 4;
    let tail = max - head;
    let h: String = html.chars().take(head).collect();
    let t: String = html.chars().skip(n - tail).collect();
    format!("{h}\n/* … {} chars omitted … */\n{t}", n - head - tail)
}

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['\'', '`'], "\"").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Does the verifier's quoted code really occur in the page? Any fragment of ≥10 chars (split on
/// lines and "…") found after whitespace/quote normalisation counts. Pure.
pub fn evidence_found(html_norm: &str, evidence: &str) -> bool {
    let frags: Vec<String> = evidence.split(['\n', '…']).flat_map(|l| l.split("...")).map(norm).map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
    if frags.iter().any(|f| f.chars().count() >= 10 && html_norm.contains(f.as_str())) {
        return true;
    }
    let whole = norm(evidence);
    whole.chars().count() >= 4 && frags.iter().all(|f| f.chars().count() < 10) && html_norm.contains(whole.as_str())
}

/// The verifier's per-criterion verdicts checked against the code.
#[derive(Debug, Clone, PartialEq)]
pub struct Judged {
    /// One fix line per criterion that is not met or has no evidence in the code.
    pub unmet: Vec<String>,
    /// The checked list (criterion, met, evidence found) for the envelope.
    pub criteria: Value,
    /// The verifier returned no per-criterion list at all.
    pub absent: bool,
}

/// Judge the verifier's `criteria` array against the page. A criterion counts only when the model
/// says it is met AND quotes code that is really in the page. Pure.
pub fn judge_criteria(criteria: &Value, html: &str) -> Judged {
    let hn = norm(html);
    let arr = criteria.as_array().cloned().unwrap_or_default();
    let mut unmet = Vec::new();
    let mut out = Vec::new();
    for c in arr.iter().take(12) {
        let name = c["criterion"].as_str().or_else(|| c["name"].as_str()).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let name: String = name.chars().take(160).collect();
        let met = c["met"].as_bool().or_else(|| c["pass"].as_bool()).unwrap_or(false);
        let ev = c["evidence"].as_str().unwrap_or("").trim();
        let found = !ev.is_empty() && evidence_found(&hn, ev);
        if !met {
            let why = c["fix"].as_str().or_else(|| c["reason"].as_str()).map(|r| format!(" ({})", r.chars().take(120).collect::<String>())).unwrap_or_default();
            unmet.push(format!("not met: {name}{why}"));
        } else if !found {
            unmet.push(format!("no working code found for: {name} (implement it for real)"));
        }
        out.push(json!({ "criterion": name, "met": met, "evidence_found": found, "evidence": ev.chars().take(160).collect::<String>() }));
    }
    Judged { absent: out.is_empty(), unmet, criteria: Value::Array(out) }
}

// ── Runtime smoke (headless Edge, Windows) ─────────────────────────────────

/// Injected first in <head>: records uncaught errors, blocks storage (a sandboxed preview or a
/// locked-down browser throws on it), stubs dialogs and form submits, then after load fills the
/// inputs, changes the selects and clicks the buttons, and writes the result onto <html>.
const HARNESS: &str = r#"(function(){var E=[];function rec(m){if(E.length<8)E.push(String(m).slice(0,200))}
addEventListener('error',function(e){rec(e.message||'error')});
addEventListener('unhandledrejection',function(e){var r=e.reason;rec('unhandled promise rejection: '+(r&&r.message||r))});
function block(n){try{Object.defineProperty(window,n,{configurable:true,get:function(){throw new DOMException(n+' is blocked here (guard storage with try/catch)','SecurityError')}})}catch(x){}}
block('localStorage');block('sessionStorage');
window.alert=function(){};window.confirm=function(){return true};window.prompt=function(){return ''};
document.addEventListener('submit',function(e){e.preventDefault()},true);
addEventListener('load',function(){setTimeout(function(){var L=E.length;
try{document.querySelectorAll('input').forEach(function(i){var t=(i.type||'text').toLowerCase();if(t==='number'||t==='range'){i.value='50'}else if(t==='checkbox'||t==='radio'){i.checked=!i.checked}else if(t==='text'||t==='search'||t===''){i.value='Test item'}else{return}
i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}))});
document.querySelectorAll('select').forEach(function(s){if(s.options.length>1){s.selectedIndex=1;s.dispatchEvent(new Event('change',{bubbles:true}))}});
Array.prototype.slice.call(document.querySelectorAll('button'),0,30).forEach(function(b){b.click()})}catch(x){rec('while using the page: '+x.message)}
setTimeout(function(){document.documentElement.setAttribute('data-tf-smoke',JSON.stringify({errors:E,load:L}))},300)},300)})})();"#;

/// The page with the harness injected right after <head> (or <html>, or at the top). Pure.
pub fn with_harness(html: &str) -> String {
    static HEAD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static HTML: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let tag = format!("<script>{HARNESS}</script>");
    let head = HEAD.get_or_init(|| regex::Regex::new(r"(?i)<head\b[^>]*>").unwrap());
    let htm = HTML.get_or_init(|| regex::Regex::new(r"(?i)<html\b[^>]*>").unwrap());
    if let Some(m) = head.find(html).or_else(|| htm.find(html)) {
        format!("{}{tag}{}", &html[..m.end()], &html[m.end()..])
    } else {
        format!("{tag}{html}")
    }
}

/// The harness result out of a `--dump-dom` print: (errors, how many happened on load). Pure.
pub fn parse_dump(dom: &str) -> Option<(Vec<String>, usize)> {
    let i = dom.find("data-tf-smoke=\"")? + "data-tf-smoke=\"".len();
    let j = dom[i..].find('"')? + i;
    let raw = dom[i..j].replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'").replace("&amp;", "&");
    let v: Value = serde_json::from_str(&raw).ok()?;
    let errs = v["errors"].as_array()?.iter().filter_map(|e| e.as_str()).map(String::from).collect();
    Some((errs, v["load"].as_u64().unwrap_or(0) as usize))
}

fn browser() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(|k| std::env::var_os(k)).map(|p| PathBuf::from(p).join("Microsoft").join("Edge").join("Application").join("msedge.exe")).find(|p| p.is_file())
}

/// Load the page in headless Edge (network unreachable, own throwaway profile, storage blocked),
/// exercise its controls, and return the uncaught errors as fix lines. `None` = could not run
/// (no Edge, timeout, no result): the gate then relies on the static checks. Blocking.
pub fn runtime_smoke(page: &Path, timeout: Duration) -> Option<Vec<String>> {
    let exe = browser()?;
    let html = std::fs::read_to_string(page).ok()?;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("tf-smoke-{}-{nanos}-{}", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).ok()?;
    let r = (|| {
        let file = dir.join("index.html");
        std::fs::write(&file, with_harness(&html)).ok()?;
        let out_path = dir.join("dom.txt");
        let out = std::fs::File::create(&out_path).ok()?;
        let url = format!("file:///{}", file.display().to_string().replace('\\', "/").replace(' ', "%20"));
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=5000", "--dump-dom"])
            .arg(format!("--user-data-dir={}", dir.join("profile").display()))
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(out)
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().ok()?;
        let t0 = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if t0.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return None,
            }
        }
        let dom = std::fs::read_to_string(&out_path).ok()?;
        let (errs, load) = parse_dump(&dom)?;
        Some(errs.iter().enumerate().map(|(i, e)| if i < load { format!("the page throws on load: {e}") } else { format!("the page throws when its controls are used: {e}") }).collect())
    })();
    // The profile may still be locked for a moment by Edge's helpers: best effort.
    for _ in 0..10 {
        if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_keep_nics_numbers_and_units() {
        let l = intent_literals("I'm 165 lbs and want 3-5 meals a day, about 0.8 g/kg. Works offline.");
        let p: Vec<&str> = l.iter().map(|l| l.phrase.as_str()).collect();
        assert_eq!(p, vec!["165 lbs", "5 meals", "0.8 g/kg"]);
        assert!(intent_literals("Build a pomodoro timer with a soft chime").is_empty());
        assert_eq!(literals_line("a 25 min timer, then a 25 minute review and a 5 min break"), "25 min; 5 min", "same number + unit family is deduped");
        assert_eq!(intent_literals("weigh 70kg")[0].phrase, "70kg");
    }

    #[test]
    fn a_page_that_lost_the_value_or_its_unit_is_flagged() {
        let lits = intent_literals("I'm 165 lbs");
        assert!(missing_literals(r#"<input id="w" value="165"> <span>lb</span>"#, &lits).is_empty());
        assert_eq!(missing_literals(r#"<input id="w" value="75"> kg"#, &lits).len(), 1);
        assert_eq!(missing_literals(r#"<input value="1650"> lb"#, &lits).len(), 1, "1650 is not 165");
        assert_eq!(missing_literals(r#"<input value="165"> kg"#, &lits).len(), 1, "the unit must be there too");
    }

    #[test]
    fn script_ids_must_exist_in_the_markup() {
        let html = r#"<input id="weight"><div id='out'></div><script>
            document.getElementById("weight"); document.querySelector('#out');
            document.getElementById('ghost'); const d = document.createElement('p'); d.id = 'made';
            document.getElementById('made'); el.innerHTML = `<b id="tpl"></b>`; document.getElementById("tpl");
        </script>"#;
        assert_eq!(dom_id_gaps(html), vec!["ghost".to_string()]);
    }

    #[test]
    fn storage_outside_try_is_counted() {
        let page = |s: &str| format!("<html><body><script>{s}</script></body></html>");
        assert_eq!(unguarded_storage(&page("const s = JSON.parse(localStorage.getItem('a') || '{}');")), 1);
        assert_eq!(unguarded_storage(&page("function load(){ try { return localStorage.getItem('a') } catch (e) { return null } }")), 0);
        assert_eq!(unguarded_storage(&page("try { x() } catch (e) { localStorage.clear() }")), 1, "a catch block is not guarded");
        assert_eq!(unguarded_storage(&page("// localStorage.getItem('x')\nconst t = 'localStorage';")), 0, "comments and strings are skipped");
    }

    #[test]
    fn evidence_must_be_real_code_from_the_page() {
        let html = "<script>\nfunction addFood(name, grams) {\n  state.items.push({ name, grams });\n  render();\n}\n</script>";
        let j = judge_criteria(
            &json!([
                { "criterion": "foods can be added", "met": true, "evidence": "state.items.push({ name, grams });" },
                { "criterion": "lb/kg toggle", "met": true, "evidence": "unitToggle.addEventListener('click', swap)" },
                { "criterion": "meal split", "met": false, "evidence": "", "fix": "add per-meal targets" },
                { "criterion": "evidence paraphrased across lines", "met": true, "evidence": "function addFood(name, grams) {\n...\nrender();" }
            ]),
            html,
        );
        assert_eq!(j.unmet.len(), 2, "{:?}", j.unmet);
        assert!(j.unmet[0].contains("lb/kg toggle") && j.unmet[1].contains("meal split") && j.unmet[1].contains("per-meal"));
        assert!(!j.absent);
        assert!(judge_criteria(&Value::Null, html).absent);
    }

    #[test]
    fn harness_goes_first_in_head_and_the_dump_parses() {
        let h = with_harness("<!doctype html><html><head><title>t</title></head><body></body></html>");
        assert!(h.find("data-tf-smoke").unwrap() < h.find("<title>").unwrap());
        assert!(with_harness("<p>bare</p>").starts_with("<script>"));
        let dom = r#"<html data-tf-smoke="{&quot;errors&quot;:[&quot;Uncaught TypeError: x is null&quot;,&quot;b&quot;],&quot;load&quot;:1}"><head>"#;
        assert_eq!(parse_dump(dom), Some((vec!["Uncaught TypeError: x is null".to_string(), "b".to_string()], 1)));
        assert_eq!(parse_dump("<html><head>"), None);
    }

    #[test]
    fn code_excerpt_keeps_head_and_tail() {
        let s = "a".repeat(100) + &"b".repeat(100);
        let x = code_excerpt(&s, 40);
        assert!(x.starts_with("aaa") && x.ends_with("bbb") && x.contains("omitted"));
        assert_eq!(code_excerpt("short", 40), "short");
    }

    /// Real headless Edge (skipped where it isn't installed): a page that crashes on load with
    /// storage blocked is caught; a guarded one is clean. Never touches the network.
    #[test]
    fn runtime_smoke_catches_an_unguarded_storage_crash() {
        if browser().is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("tf-smoke-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("bad.html");
        std::fs::write(&bad, "<!doctype html><html><head><title>x</title></head><body><p id=o>--</p><script>const s = localStorage.getItem('a'); document.getElementById('o').textContent = 'ok';</script></body></html>").unwrap();
        let good = dir.join("good.html");
        std::fs::write(&good, "<!doctype html><html><head><title>x</title></head><body><input id=w type=number><p id=o>--</p><script>let s=null; try { s = localStorage.getItem('a') } catch (e) {} document.getElementById('w').addEventListener('input', e => { document.getElementById('o').textContent = e.target.value * 2 });</script></body></html>").unwrap();
        let handler = dir.join("handler.html");
        std::fs::write(&handler, "<!doctype html><html><head><title>x</title></head><body><button id=b>Add</button><script>document.getElementById('b').onclick = () => { document.getElementById('nope').textContent = 1 };</script></body></html>").unwrap();
        let b = runtime_smoke(&bad, Duration::from_secs(30)).expect("edge ran");
        assert!(b.iter().any(|e| e.contains("on load") && e.contains("localStorage")), "{b:?}");
        assert_eq!(runtime_smoke(&good, Duration::from_secs(30)), Some(vec![]));
        let h = runtime_smoke(&handler, Duration::from_secs(30)).expect("edge ran");
        assert!(h.iter().any(|e| e.contains("controls are used")), "{h:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
