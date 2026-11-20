//! The build quality gate's deterministic checks (no model): Nic's exact values carried into the
//! page, no external code (the page must work offline), DOM ids the script uses exist, storage
//! access guarded, per-criterion evidence from the verifier really present in the code, a
//! headless-browser runtime smoke (load + light interaction with storage blocked and the network
//! unreachable), and the verifier's behavioural probes (a tiny step DSL — set / click / expect —
//! run in the same headless browser, a fresh page load per probe). Everything here is pure except
//! `runtime_smoke` / `run_probes`, which spawn a local headless Edge on a temp copy of the page and
//! never touch the network.
//!
//! Why (2026-11-20 protein-app runs): a build passed every stage while its core feature never
//! worked, it loaded Tailwind from a CDN against "works offline", lost Nic's "165 lb", and crashed
//! on load when storage was blocked. After the first gate a re-run still passed real behavioural
//! bugs (the lb/kg toggle never converted, the meal split read 3,5,4, saved state was never shown)
//! because quoted code only proves an element exists — hence the probes (AD-11).

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

fn rx(cell: &'static OnceLock<regex::Regex>, pat: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pat).unwrap())
}

fn clip_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>())
    }
}

// ── Nic's exact values ──────────────────────────────────────────────────────

/// A number-with-unit Nic said ("165 lbs", "3-5 meals"): kept verbatim through spec → brief → code.
#[derive(Debug, Clone, PartialEq)]
pub struct Literal {
    /// The (upper) number, thousands separators removed ("10000" for "10,000").
    pub number: String,
    /// The lower bound when Nic gave a range ("3" of "3-5 meals").
    pub low: Option<String>,
    pub unit: String,
    /// As Nic wrote it ("165 lbs", "3-5 meals", "10,000 steps").
    pub phrase: String,
}

/// Units worth carrying. Ambiguous one-letter words ("in", "m", "l") are left out on purpose.
const UNITS: &str = r"lbs?|pounds?|kgs?|kilograms?|kilos?|g/kg|grams?|g|oz|ounces?|cups?|ml|liters?|litres?|kcal|calories|cal|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|%|percent|meals?|servings?|snacks?|steps?|reps?|sets?|miles?|km|meters?|feet|ft|inches|°f|°c|dollars?|usd|bpm|words?|items?|players?|levels?|rounds?";
/// A number as Nic writes it: thousands groups ("10,000") or plain, with decimals.
const NUM: &str = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,6}(?:\.\d+)?";

/// Nic's numbers-with-units, in order, deduped, at most 8. A range ("3-5 meals", "3 to 5 meals")
/// stays one literal. Pure.
pub fn intent_literals(text: &str) -> Vec<Literal> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        let p = r"(?i)(?:^|[^\w.,])(?:(N)\s?(?:-|–|to)\s?)?(N)\s?(U)(?:$|[^\w/])".replace("(N)", &format!("({NUM})")).replace("(U)", &format!("({UNITS})"));
        regex::Regex::new(&p).unwrap()
    });
    let mut out: Vec<Literal> = Vec::new();
    // Overlapping matches (the trailing boundary char is consumed): scan from each match's unit end.
    let mut from = 0;
    while let Some(c) = re.captures_at(text, from) {
        let (n, u) = (c.get(2).unwrap(), c.get(3).unwrap());
        from = u.end();
        let number = n.as_str().replace(',', "");
        let mut low = c.get(1).map(|m| m.as_str().replace(',', ""));
        let mut start = c.get(1).map(|m| m.start()).unwrap_or(n.start());
        // "from 180 to 165 lbs" is not a range: only low < high is.
        let ordered = matches!((low.as_deref().and_then(|l| l.parse::<f64>().ok()), number.parse::<f64>().ok()), (Some(a), Some(b)) if a < b);
        if !ordered {
            low = None;
            start = n.start();
        }
        let lit = Literal { number, low, unit: u.as_str().to_lowercase(), phrase: text[start..u.end()].to_string() };
        if !out.iter().any(|l| l.number == lit.number && l.low == lit.low && unit_words(&l.unit) == unit_words(&lit.unit)) {
            out.push(lit);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// Words a page may use for the unit (matched as whole words, an "s"/"es" plural allowed). Pure.
fn unit_words(unit: &str) -> Vec<String> {
    let u = unit.to_lowercase();
    let stem = u.trim_end_matches('s');
    let w: &[&str] = match stem {
        "lb" | "pound" => &["lb", "pound"],
        "kg" | "kilogram" | "kilo" => &["kg", "kilo", "kilogram"],
        "g/kg" => &["g/kg", "per kg", "/kg"],
        "g" | "gram" => &["g", "gram"],
        "oz" | "ounce" => &["oz", "ounce"],
        "kcal" | "calorie" | "cal" => &["kcal", "cal", "calorie"],
        "minute" | "min" => &["min", "minute"],
        "hour" | "hr" => &["hour", "hr"],
        "second" | "sec" => &["sec", "second"],
        "%" | "percent" => &["%", "percent"],
        _ => &[],
    };
    if w.is_empty() {
        vec![stem.to_string()]
    } else {
        w.iter().map(|s| s.to_string()).collect()
    }
}

/// `w` as a whole word in `hay` (no letter glued on either side; a plural "s"/"es" allowed). Pure.
fn has_word(hay: &str, w: &str) -> bool {
    let b = hay.as_bytes();
    let starts_alpha = w.as_bytes().first().is_some_and(|c| c.is_ascii_alphabetic());
    let ends_alpha = w.as_bytes().last().is_some_and(|c| c.is_ascii_alphabetic());
    let mut from = 0;
    while let Some(i) = hay[from..].find(w) {
        let s = from + i;
        let mut e = s + w.len();
        if ends_alpha {
            if hay[e..].starts_with("es") && !b.get(e + 2).is_some_and(|c| c.is_ascii_alphabetic()) {
                e += 2;
            } else if hay[e..].starts_with('s') {
                e += 1;
            }
        }
        let before_ok = !starts_alpha || s == 0 || !b[s - 1].is_ascii_alphabetic();
        let after_ok = !ends_alpha || e >= b.len() || !b[e].is_ascii_alphabetic();
        if before_ok && after_ok {
            return true;
        }
        from = s + w.len().max(1);
        while from < hay.len() && !hay.is_char_boundary(from) {
            from += 1;
        }
        if from >= hay.len() {
            break;
        }
    }
    false
}

/// "10000" → "10,000" (the grouped spelling of a long integer part). Pure.
fn grouped(num: &str) -> Option<String> {
    let (int, frac) = num.split_once('.').map(|(a, b)| (a, Some(b))).unwrap_or((num, None));
    if int.len() < 4 || !int.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut g = String::new();
    for (i, ch) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            g.push(',');
        }
        g.push(ch);
    }
    Some(match frac {
        Some(f) => format!("{g}.{f}"),
        None => g,
    })
}

/// Byte offsets where `num` occurs as a whole number (not part of a longer number or decimal;
/// a thousands group "x,ddd" counts as part of the number). Pure.
fn number_positions(hay: &str, num: &str) -> Vec<usize> {
    let b = hay.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_digit());
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = hay[from..].find(num) {
        let s = from + i;
        let e = s + num.len();
        let thousands_after = b.get(e) == Some(&b',') && digit(e + 1) && digit(e + 2) && digit(e + 3) && !digit(e + 4);
        let num_is_group = num.len() == 3 && num.bytes().all(|c| c.is_ascii_digit());
        let before_ok = s == 0 || !(b[s - 1].is_ascii_digit() || (b[s - 1] == b'.' && s >= 2 && b[s - 2].is_ascii_digit()) || (b[s - 1] == b',' && num_is_group && s >= 2 && b[s - 2].is_ascii_digit()));
        let after_ok = e >= b.len() || !(b[e].is_ascii_digit() || (b[e] == b'.' && digit(e + 1)) || thousands_after);
        if before_ok && after_ok {
            out.push(s);
        }
        from = s + 1;
    }
    out
}

/// The page's text where Nic's values can live: CSS, inline styles, comments and colours removed
/// (`background` contains "kg", `rgb(34,165,94)` contains 165), lowercased. Pure.
fn value_text(html: &str) -> String {
    static RS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let rs = RS.get_or_init(|| {
        [r"(?is)<style\b.*?</style\s*>", r"(?s)<!--.*?-->", r"(?s)/\*.*?\*/", r"(?m)(?:^|[\s;{}(),])//[^\n]*", r#"(?i)\sstyle\s*=\s*(?:"[^"]*"|'[^']*')"#, r"#[0-9a-fA-F]{3,8}\b", r"(?i)\b(?:rgba?|hsla?)\([^)]*\)"]
            .iter()
            .map(|p| regex::Regex::new(p).unwrap())
            .collect()
    });
    let mut s = html.to_string();
    for r in rs {
        s = r.replace_all(&s, " ").into_owned();
    }
    s.to_lowercase()
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Does the page carry the literal — the number with a word of its unit close by? Pure.
fn literal_present(hay: &str, l: &Literal) -> bool {
    let words = unit_words(&l.unit);
    let near = |num: &str| {
        let mut forms = vec![num.to_string()];
        forms.extend(grouped(num));
        forms.iter().any(|f| {
            number_positions(hay, f).into_iter().any(|p| {
                let a = floor_boundary(hay, p.saturating_sub(120));
                let z = floor_boundary(hay, p + f.len() + 120);
                words.iter().any(|w| has_word(&hay[a..z], w))
            })
        })
    };
    near(&l.number) && l.low.as_deref().map_or(true, near)
}

/// One line per literal the page lost: the number missing, or no word of its unit near it. Pure.
pub fn missing_literals(html: &str, lits: &[Literal]) -> Vec<String> {
    let hay = value_text(html);
    lits.iter()
        .filter(|l| !literal_present(&hay, l))
        .map(|l| {
            if l.low.is_some() {
                format!("Nic's exact range \"{}\" (offer it as given, every value in it, with its unit; it is missing from the page)", l.phrase)
            } else {
                format!("Nic's exact value \"{}\" (use it as given with its unit, e.g. as the default; it is missing from the page)", l.phrase)
            }
        })
        .collect()
}

/// "165 lbs; 3-5 meals" for a prompt (empty when there are none). Pure.
pub fn literals_line(text: &str) -> String {
    intent_literals(text).into_iter().map(|l| l.phrase).collect::<Vec<_>>().join("; ")
}

// ── Inline scripts ──────────────────────────────────────────────────────────

fn js_type(t: &str) -> bool {
    let t = t.trim().trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase();
    let t = t.split(';').next().unwrap_or("").trim().to_string();
    matches!(t.as_str(), "module" | "" | "text/javascript" | "application/javascript" | "text/ecmascript" | "application/ecmascript" | "application/x-javascript" | "text/x-javascript" | "javascript")
}

/// Byte ranges of the page's inline JavaScript bodies (no `src`, a JS type). Pure.
fn script_spans(html: &str) -> Vec<(usize, usize)> {
    static SRC: OnceLock<regex::Regex> = OnceLock::new();
    static TYPE: OnceLock<regex::Regex> = OnceLock::new();
    let src = rx(&SRC, r#"(?i)[\s"']src\s*="#);
    let ty = rx(&TYPE, r#"(?i)[\s"']type\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#);
    // ASCII lowercasing keeps every byte offset.
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<script") {
        let start = from + i;
        let Some(tag_end) = lower[start..].find('>').map(|j| start + j + 1) else { break };
        let tag = &lower[start..tag_end];
        let Some(close) = lower[tag_end..].find("</script").map(|j| tag_end + j) else { break };
        let is_js = ty.captures(tag).map(|c| js_type(&c[1])).unwrap_or(true);
        if is_js && !src.is_match(tag) && !html[tag_end..close].trim().is_empty() {
            out.push((tag_end, close));
        }
        from = close + 8;
    }
    out
}

/// JavaScript with its comments removed (strings kept verbatim). Pure.
fn strip_js_comments(src: &str) -> String {
    let b = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            out.push(b' ');
            continue;
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            let s = i;
            i += 1;
            while i < b.len() && b[i] != c {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(b.len());
            out.extend_from_slice(&b[s..i]);
            continue;
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The page with HTML comments, `<pre>` samples and JS comments removed: what really runs. Pure.
fn live_code(html: &str) -> String {
    static C: OnceLock<regex::Regex> = OnceLock::new();
    let mut out = String::with_capacity(html.len());
    let mut last = 0;
    for (s, e) in script_spans(html) {
        out.push_str(&html[last..s]);
        out.push_str(&strip_js_comments(&html[s..e]));
        last = e;
    }
    out.push_str(&html[last..]);
    rx(&C, r"(?is)<!--.*?-->|<pre\b.*?</pre\s*>").replace_all(&out, " ").into_owned()
}

/// Ids the script looks up by a literal string that no element (a tag's `id=` — markup or a
/// template string — or `el.id = '…'` / `setAttribute('id', '…')`) defines. Commented-out
/// lookups do not count; `data-id=` and a JS variable named `id` are not ids. At most 6. Pure.
pub fn dom_id_gaps(html: &str) -> Vec<String> {
    static USE: OnceLock<regex::Regex> = OnceLock::new();
    static TAG: OnceLock<regex::Regex> = OnceLock::new();
    static ATTR: OnceLock<regex::Regex> = OnceLock::new();
    static JS: OnceLock<regex::Regex> = OnceLock::new();
    let used = rx(&USE, r#"(?:getElementById\(\s*["']([A-Za-z][\w:-]*)["']\s*\)|querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)["']\s*\))"#);
    let tag = rx(&TAG, r"<[A-Za-z][\w-]*(?:\s[^<>]*)?>");
    let attr = rx(&ATTR, r#"(?i)\sid\s*=\s*\\?["']?([A-Za-z][\w:-]*)"#);
    let js = rx(&JS, r#"\.id\s*=\s*["'`]([A-Za-z][\w:-]*)["'`]|setAttribute\(\s*["']id["']\s*,\s*["'`]([A-Za-z][\w:-]*)"#);
    let mut defined: HashSet<String> = HashSet::new();
    for t in tag.find_iter(html) {
        defined.extend(attr.captures_iter(t.as_str()).filter_map(|c| c.get(1)).map(|m| m.as_str().to_string()));
    }
    defined.extend(js.captures_iter(html).filter_map(|c| c.get(1).or_else(|| c.get(2))).map(|m| m.as_str().to_string()));
    let code = live_code(html);
    let mut out: Vec<String> = Vec::new();
    for c in used.captures_iter(&code) {
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

// ── Storage guard scan ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tk {
    Id(String),
    /// Punctuation; `=>` is `A`, `==` / `===` / `!=` are `q`.
    P(u8),
    Lit,
}

struct Tok {
    t: Tk,
    pos: usize,
}

fn is_id(t: &Tok, w: &str) -> bool {
    matches!(&t.t, Tk::Id(x) if x == w)
}

fn js_tokens(src: &str) -> Vec<Tok> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            let s = i;
            i += 1;
            while i < b.len() && b[i] != c {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            out.push(Tok { t: Tk::Lit, pos: s });
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' || c == b'$' {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                i += 1;
            }
            out.push(Tok { t: Tk::Id(src[s..i].to_string()), pos: s });
            continue;
        }
        if c.is_ascii_digit() {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                i += 1;
            }
            out.push(Tok { t: Tk::Lit, pos: s });
            continue;
        }
        if c.is_ascii_whitespace() || !c.is_ascii() {
            i += 1;
            continue;
        }
        let s = i;
        let t = if c == b'=' && b.get(i + 1) == Some(&b'>') {
            i += 2;
            b'A'
        } else if (c == b'=' || c == b'!') && b.get(i + 1) == Some(&b'=') {
            i += 2;
            while b.get(i) == Some(&b'=') {
                i += 1;
            }
            b'q'
        } else {
            i += 1;
            c
        };
        out.push(Tok { t: Tk::P(t), pos: s });
    }
    out
}

fn open_paren(t: &[Tok], close: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut j = close;
    loop {
        match t[j].t {
            Tk::P(b')') => depth += 1,
            Tk::P(b'(') => {
                depth -= 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            _ => {}
        }
        if j == 0 {
            return None;
        }
        j -= 1;
    }
}

/// `NAME = <fn>` / `NAME: <fn>` / `NAME = (<fn>)()` before token `start` (a function's head).
fn assigned_name(t: &[Tok], start: usize) -> Option<String> {
    let mut j = start;
    if j > 0 && is_id(&t[j - 1], "async") {
        j -= 1;
    }
    if j > 0 && t[j - 1].t == Tk::P(b'(') {
        j -= 1;
    }
    if j >= 2 && (t[j - 1].t == Tk::P(b'=') || t[j - 1].t == Tk::P(b':')) {
        if let Tk::Id(nm) = &t[j - 2].t {
            return Some(nm.clone());
        }
    }
    None
}

/// The name of the function whose body opens at token `k` (`{`), if it has one.
fn fn_name_before(t: &[Tok], k: usize) -> Option<String> {
    if k == 0 {
        return None;
    }
    let j = k - 1;
    if t[j].t == Tk::P(b'A') {
        if j == 0 {
            return None;
        }
        let p = j - 1;
        let start = match &t[p].t {
            Tk::P(b')') => open_paren(t, p)?,
            Tk::Id(_) => p,
            _ => return None,
        };
        return assigned_name(t, start);
    }
    if t[j].t == Tk::P(b')') {
        let o = open_paren(t, j)?;
        if o == 0 {
            return None;
        }
        if let Tk::Id(nm) = &t[o - 1].t {
            if o >= 2 && is_id(&t[o - 2], "function") {
                return Some(nm.clone());
            }
            if nm == "function" {
                return assigned_name(t, o - 1);
            }
            // Method shorthand `save() {` (not a control statement, not a call `.x() {`).
            let control = ["if", "for", "while", "switch", "catch", "with", "return", "typeof"];
            if !control.contains(&nm.as_str()) && !(o >= 2 && t[o - 2].t == Tk::P(b'.')) {
                return Some(nm.clone());
            }
        }
    }
    None
}

struct Frame {
    is_try: bool,
    fn_id: Option<usize>,
    try_storage: bool,
}

/// Byte offsets (in `src`) of localStorage / sessionStorage uses that are not guarded. Guarded:
/// inside a `try { … }` block; inside a named function every reference of which is itself
/// guarded (a helper only ever called inside `try`); or after a storage-ok flag in the same
/// function (`ok = true` / `return true` set inside a `try` that touched storage, e.g.
/// `if (!ok) return; localStorage.setItem(…)` or `if (storageOk()) …`). A heuristic. Pure.
fn storage_sites(src: &str) -> Vec<usize> {
    let toks = js_tokens(src);
    let n = toks.len();
    let mut stack: Vec<Frame> = Vec::new();
    // (name, body open token, body close token)
    let mut fns: Vec<(String, usize, usize)> = Vec::new();
    let mut info: Vec<(bool, Vec<usize>)> = Vec::with_capacity(n);
    let mut flags: HashSet<String> = HashSet::new();
    let mut uses: Vec<usize> = Vec::new();
    for k in 0..n {
        info.push((stack.iter().any(|f| f.is_try), stack.iter().filter_map(|f| f.fn_id).collect()));
        match &toks[k].t {
            Tk::P(b'{') => {
                let is_try = k > 0 && is_id(&toks[k - 1], "try");
                let fn_id = fn_name_before(&toks, k).map(|nm| {
                    fns.push((nm, k, n));
                    fns.len() - 1
                });
                stack.push(Frame { is_try, fn_id, try_storage: false });
            }
            Tk::P(b'}') => {
                if let Some(f) = stack.pop() {
                    if let Some(id) = f.fn_id {
                        fns[id].2 = k;
                    }
                }
            }
            Tk::Id(w) if w == "localStorage" || w == "sessionStorage" => {
                uses.push(k);
                if let Some(f) = stack.iter_mut().rev().find(|f| f.is_try) {
                    f.try_storage = true;
                }
            }
            Tk::Id(w) if w == "true" => {
                if stack.iter().rev().find(|f| f.is_try).is_some_and(|f| f.try_storage) {
                    if k >= 2 && toks[k - 1].t == Tk::P(b'=') {
                        if let Tk::Id(x) = &toks[k - 2].t {
                            flags.insert(x.clone());
                        }
                    }
                    if k >= 1 && is_id(&toks[k - 1], "return") {
                        if let Some(id) = stack.iter().rev().find_map(|f| f.fn_id) {
                            flags.insert(fns[id].0.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    // Helpers whose every reference is guarded (fixpoint: a helper called only from such a helper).
    let refs: Vec<Vec<usize>> = fns
        .iter()
        .map(|(name, open, close)| {
            (0..n)
                .filter(|&k| matches!(&toks[k].t, Tk::Id(w) if w == name))
                .filter(|&k| !(k > *open && k < *close))
                .filter(|&k| !(k > 0 && is_id(&toks[k - 1], "function")))
                .filter(|&k| !matches!(toks.get(k + 1).map(|t| &t.t), Some(Tk::P(b'=')) | Some(Tk::P(b':'))))
                .collect()
        })
        .collect();
    let mut guarded = vec![false; fns.len()];
    loop {
        let mut changed = false;
        for id in 0..fns.len() {
            if !guarded[id] && !refs[id].is_empty() && refs[id].iter().all(|&r| info[r].0 || info[r].1.iter().any(|&m| guarded[m])) {
                guarded[id] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    uses.into_iter()
        .filter(|&k| {
            let (in_try, encl) = &info[k];
            if *in_try || encl.iter().any(|&m| guarded[m]) {
                return false;
            }
            // A flag READ before the use in the same function (not its declaration / assignment).
            let from = encl.last().map(|&m| fns[m].1).unwrap_or(0);
            !(from..k).any(|q| {
                matches!(&toks[q].t, Tk::Id(w) if flags.contains(w))
                    && !(q > 0 && ["function", "let", "const", "var"].iter().any(|d| is_id(&toks[q - 1], d)))
                    && toks.get(q + 1).map(|t| &t.t) != Some(&Tk::P(b'='))
            })
        })
        .map(|k| toks[k].pos)
        .collect()
}

/// The line (1-based, in the page) of every unguarded storage use in the inline scripts. Pure.
pub fn unguarded_storage_lines(html: &str) -> Vec<usize> {
    script_spans(html).into_iter().flat_map(|(s, e)| storage_sites(&html[s..e]).into_iter().map(move |p| s + p)).map(|off| html[..off].matches('\n').count() + 1).collect()
}

/// How many storage uses are unguarded. Pure.
#[cfg_attr(not(test), allow(dead_code))]
pub fn unguarded_storage(html: &str) -> usize {
    unguarded_storage_lines(html).len()
}

// ── What the verifier reads ─────────────────────────────────────────────────

fn tidy(s: &str) -> String {
    s.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

fn dedent(s: &str) -> String {
    s.lines().map(str::trim).collect::<Vec<_>>().join("\n")
}

fn cut_middle(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let marker_room = 40;
    let keep = max.saturating_sub(marker_room);
    let head = keep * 3 / 4;
    let tail = keep - head;
    let h: String = s.chars().take(head).collect();
    let t: String = s.chars().skip(n - tail).collect();
    format!("{h}\n/* … {} chars omitted … */\n{t}", n - head - tail)
}

/// The page's code as the verifier reads it: every inline script FIRST (whole when it fits),
/// then the markup with the scripts pulled out and CSS bodies dropped. The middle of the scripts
/// is cut only when the scripts alone do not fit; `.1` = that happened (a criterion whose code
/// was cut may then be "not shown" rather than unmet). Pure.
pub fn verify_view(html: &str, max: usize) -> (String, bool) {
    static STYLE: OnceLock<regex::Regex> = OnceLock::new();
    let spans = script_spans(html);
    let scripts: Vec<String> = spans.iter().map(|&(s, e)| tidy(&html[s..e])).collect();
    let mut markup = String::new();
    let mut last = 0;
    for (i, &(s, e)) in spans.iter().enumerate() {
        markup.push_str(&html[last..s]);
        markup.push_str(&format!("/* script {} is shown above */", i + 1));
        last = e;
    }
    markup.push_str(&html[last..]);
    let markup = tidy(&rx(&STYLE, r"(?is)(<style\b[^>]*>).*?(</style\s*>)").replace_all(&markup, "$1/* CSS omitted */$2"));
    let mut js = scripts.iter().enumerate().map(|(i, s)| format!("/* script {} */\n{s}", i + 1)).collect::<Vec<_>>().join("\n");
    let (head, mid) = ("/* ── the page's inline JavaScript ── */\n", "\n/* ── the page's markup (scripts shown above, CSS omitted) ── */\n");
    let len = |s: &str| s.chars().count();
    let room = max.saturating_sub(len(head) + len(mid));
    if len(&js) + len(&markup) <= room {
        return (format!("{head}{js}{mid}{markup}"), false);
    }
    js = dedent(&js);
    let markup = dedent(&markup);
    let markup_floor = len(&markup).min(1500);
    if len(&js) + markup_floor <= room {
        let m = cut_middle(&markup, room - len(&js));
        return (format!("{head}{js}{mid}{m}"), false);
    }
    let j = cut_middle(&js, room.saturating_sub(markup_floor));
    let m = cut_middle(&markup, markup_floor);
    (format!("{head}{j}{mid}{m}"), true)
}

// ── Evidence ────────────────────────────────────────────────────────────────

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['\'', '`'], "\"").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A fragment that proves nothing: braces / punctuation, or a bare generic call (`render();`,
/// `updateDisplay();`, `this.save()`). Pure.
fn trivial(f: &str) -> bool {
    static CALL: OnceLock<regex::Regex> = OnceLock::new();
    if f.chars().filter(|c| c.is_alphanumeric()).count() < 3 {
        return true;
    }
    rx(&CALL, r"^[\w$.]+\(\s*\)\s*[;)]*\s*;?$").is_match(f) || matches!(f, "} else {" | "else {" | "return;" | "break;" | "});" | "})" | "try {" | "} catch (e) {")
}

/// Does the verifier's quoted code really occur in the page? The evidence is split into lines
/// (and on "…"/"..."); fragments that prove nothing (braces, a bare `render();`) are dropped;
/// EVERY remaining fragment must be in the page (whitespace / quote normalised) and together they
/// must be ≥ 20 chars. Pure.
pub fn evidence_found(html_norm: &str, evidence: &str) -> bool {
    let frags: Vec<String> = evidence.split(['\n', '…']).flat_map(|l| l.split("...")).map(norm).map(|f| f.trim().to_string()).filter(|f| !f.is_empty() && !trivial(f)).collect();
    !frags.is_empty() && frags.iter().all(|f| html_norm.contains(f.as_str())) && frags.iter().map(|f| f.chars().count()).sum::<usize>() >= 20
}

// ── The verifier's per-criterion answers ────────────────────────────────────

/// One per-criterion answer from the verifier, read leniently (a 9B model writes `"met": "yes"`,
/// `1`, or evidence as an array of lines).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    /// The requested criterion it answers (0-based), when it could be matched.
    pub idx: Option<usize>,
    pub name: String,
    /// `None` = the model did not say (or said "not shown").
    pub met: Option<bool>,
    pub evidence: String,
    pub fix: String,
    /// The validated probe steps, or why the probe was rejected. `None` = no probe.
    pub probe: Option<Result<Vec<Value>, String>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Answers {
    pub list: Vec<Answer>,
    /// Requested criteria no answer covered.
    pub missing: Vec<String>,
}

impl Answers {
    /// Worth asking the verifier again: no list at all, a requested criterion left out, or one
    /// left undecided although all of its code was shown.
    pub fn incomplete(&self, cut: bool) -> bool {
        self.list.is_empty() || !self.missing.is_empty() || (!cut && self.list.iter().any(|a| a.met.is_none()))
    }
}

fn tri(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_f64().and_then(|x| if x == 1.0 { Some(true) } else if x == 0.0 { Some(false) } else { None }),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" | "yes" | "y" | "met" | "pass" | "passed" | "1" => Some(true),
            "false" | "no" | "n" | "not met" | "unmet" | "fail" | "failed" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n").trim().to_string(),
        _ => String::new(),
    }
}

fn words(s: &str) -> HashSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(String::from).collect()
}

/// Which requested criterion an answer is about: an explicit number ("n": 2 / "2. …"), else the
/// best word overlap with a criterion not yet taken. Pure.
fn match_index(c: &Value, name: &str, expected: &[String], taken: &[bool]) -> Option<usize> {
    for k in ["n", "id", "index", "number"] {
        let x = c[k].as_u64().or_else(|| c[k].as_str().and_then(|s| s.trim().trim_start_matches('#').parse().ok()));
        if let Some(x) = x.filter(|x| *x >= 1 && (*x as usize) <= expected.len()) {
            return Some(x as usize - 1);
        }
    }
    static LEAD: OnceLock<regex::Regex> = OnceLock::new();
    if let Some(c) = rx(&LEAD, r"^\s*#?(\d{1,2})[.):]\s").captures(name) {
        if let Ok(x) = c[1].parse::<usize>() {
            if x >= 1 && x <= expected.len() {
                return Some(x - 1);
            }
        }
    }
    let nn = norm(name);
    let aw = words(name);
    let mut best: Option<(usize, f64)> = None;
    for (i, ex) in expected.iter().enumerate() {
        if taken[i] {
            continue;
        }
        let en = norm(ex);
        let contained = nn.chars().count() >= 12 && en.chars().count() >= 12 && (en.contains(&nn) || nn.contains(&en));
        let score = if !nn.is_empty() && (en == nn || contained) {
            1.0
        } else {
            let ew = words(ex);
            let common = aw.intersection(&ew).count();
            if common < 2 {
                0.0
            } else {
                common as f64 / aw.len().min(ew.len()).max(1) as f64
            }
        };
        if score >= 0.6 && best.map_or(true, |(_, b)| score > b) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

/// Read the verifier's `criteria` array against the requested list. Pure.
pub fn read_answers(criteria: &Value, expected: &[String]) -> Answers {
    let arr = criteria.as_array().cloned().unwrap_or_default();
    let mut taken = vec![false; expected.len()];
    let mut list: Vec<Answer> = Vec::new();
    for c in arr.iter().take(16) {
        let name = c["criterion"].as_str().or_else(|| c["name"].as_str()).unwrap_or("").trim().to_string();
        let idx = match_index(c, &name, expected, &taken);
        if name.is_empty() && idx.is_none() {
            continue;
        }
        if let Some(i) = idx {
            taken[i] = true;
        }
        let name = if name.is_empty() { idx.map(|i| expected[i].clone()).unwrap_or_default() } else { name };
        let probe = match &c["probe"] {
            Value::Null => None,
            p => Some(parse_probe(p)),
        };
        list.push(Answer {
            idx,
            name: name.chars().take(160).collect(),
            met: tri(&c["met"]).or_else(|| tri(&c["pass"])),
            evidence: text_of(&c["evidence"]),
            fix: Some(text_of(&c["fix"])).filter(|f| !f.is_empty()).unwrap_or_else(|| text_of(&c["reason"])).chars().take(120).collect(),
            probe,
        });
    }
    // Same count, unmatched answers in order: take them by position.
    if list.len() == expected.len() {
        for (p, a) in list.iter_mut().enumerate() {
            if a.idx.is_none() && !taken[p] {
                a.idx = Some(p);
                taken[p] = true;
            }
        }
    }
    let missing = expected.iter().enumerate().filter(|(i, _)| !taken[*i]).map(|(_, e)| e.clone()).collect();
    Answers { list, missing }
}

// ── Probes: the step DSL ────────────────────────────────────────────────────

/// Probes run per verify pass, and steps per probe.
pub const MAX_PROBES: usize = 6;
pub const MAX_STEPS: usize = 8;

/// One validated probe for one answer (index into `Answers::list`).
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub answer: usize,
    pub criterion: String,
    pub steps: Vec<Value>,
}

fn sel_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 160 && s.chars().all(|c| c.is_ascii_alphanumeric() || " #.-_:[]=\"'>~+*,()^$|".contains(c))
}

fn word_ok(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn str_or_num(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok())).filter(|x| x.is_finite() && x.abs() < 1e12)
}

/// Validate one probe from the model (untrusted): known ops only, a safe selector charset,
/// capped strings and numbers, at most `MAX_STEPS` steps, and at least one expectation.
/// Returns the normalised steps the harness runs. Pure.
pub fn parse_probe(v: &Value) -> Result<Vec<Value>, String> {
    let steps = v.as_array().or_else(|| v["steps"].as_array()).ok_or("the probe is not a list of steps")?;
    if steps.is_empty() {
        return Err("the probe has no steps".into());
    }
    if steps.len() > MAX_STEPS {
        return Err(format!("the probe has {} steps (at most {MAX_STEPS})", steps.len()));
    }
    let mut out = Vec::new();
    for (i, st) in steps.iter().enumerate() {
        let op = st["op"].as_str().unwrap_or("").trim().to_lowercase();
        let n = i + 1;
        let sel = st["sel"].as_str().or_else(|| st["selector"].as_str()).unwrap_or("").trim().to_string();
        let need_sel = |s: &str| if sel_ok(s) { Ok(()) } else { Err(format!("step {n}: unusable selector {:?}", clip_chars(s, 40))) };
        let nth = st["nth"].as_u64().unwrap_or(0).min(50);
        let text = |k: &str, max: usize| str_or_num(&st[k]).map(|s| s.chars().take(max).collect::<String>());
        let norm_step = match op.as_str() {
            "set" | "select" => {
                need_sel(&sel)?;
                let value = text("value", 200).ok_or(format!("step {n}: {op} needs a value"))?;
                json!({ "op": op, "sel": sel, "nth": nth, "value": value })
            }
            "click" => {
                need_sel(&sel)?;
                json!({ "op": op, "sel": sel, "nth": nth })
            }
            "reload" => json!({ "op": "reload" }),
            "expect_text" | "expect_value" => {
                need_sel(&sel)?;
                let mut s = json!({ "op": op, "sel": sel, "nth": nth });
                if let Some(c) = text("contains", 200).filter(|c| !c.trim().is_empty()) {
                    s["contains"] = json!(c);
                } else if let Some(c) = text("equals", 200) {
                    s["equals"] = json!(c);
                } else if let Some(a) = finite(&st["approx"]) {
                    let tol = finite(&st["tol"]).map(f64::abs).unwrap_or_else(|| (a.abs() * 0.01).max(0.5));
                    s["approx"] = json!(a);
                    s["tol"] = json!(tol);
                } else {
                    return Err(format!("step {n}: {op} needs contains, equals or approx"));
                }
                s
            }
            "expect_class" => {
                need_sel(&sel)?;
                let cls = st["class"].as_str().or_else(|| st["cls"].as_str()).unwrap_or("").trim().to_string();
                if !word_ok(&cls, 60) {
                    return Err(format!("step {n}: expect_class needs a class name"));
                }
                let present = tri(&st["present"]).unwrap_or(true);
                json!({ "op": op, "sel": sel, "nth": nth, "cls": cls, "present": present })
            }
            "expect_count" => {
                need_sel(&sel)?;
                let count = st["count"].as_u64().or_else(|| st["count"].as_str().and_then(|s| s.trim().parse().ok())).filter(|c| *c <= 1000).ok_or(format!("step {n}: expect_count needs a count"))?;
                json!({ "op": op, "sel": sel, "count": count })
            }
            "expect_order" => {
                need_sel(&sel)?;
                let order: Vec<String> = st["order"].as_array().map(|a| a.iter().filter_map(str_or_num).map(|s| s.trim().chars().take(60).collect::<String>()).collect()).unwrap_or_default();
                if order.len() < 2 || order.len() > 12 {
                    return Err(format!("step {n}: expect_order needs 2-12 values"));
                }
                let mut s = json!({ "op": op, "sel": sel, "order": order });
                if let Some(a) = st["attr"].as_str().map(str::trim).filter(|a| !a.is_empty()) {
                    if !word_ok(a, 40) {
                        return Err(format!("step {n}: unusable attribute name"));
                    }
                    s["attr"] = json!(a);
                }
                s
            }
            "" => return Err(format!("step {n} has no op")),
            other => return Err(format!("step {n}: unknown op {:?}", clip_chars(other, 20))),
        };
        out.push(norm_step);
    }
    if !out.iter().any(|s| s["op"].as_str().is_some_and(|o| o.starts_with("expect_"))) {
        return Err("the probe expects nothing".into());
    }
    Ok(out)
}

/// The valid probes to run (at most `MAX_PROBES`, in answer order). Pure.
pub fn probes_of(answers: &Answers) -> Vec<Probe> {
    answers
        .list
        .iter()
        .enumerate()
        .filter_map(|(i, a)| match &a.probe {
            Some(Ok(steps)) => Some(Probe { answer: i, criterion: a.name.clone(), steps: steps.clone() }),
            _ => None,
        })
        .take(MAX_PROBES)
        .collect()
}

fn at(st: &Value) -> String {
    let sel = st["sel"].as_str().unwrap_or("");
    match st["nth"].as_u64().unwrap_or(0) {
        0 => sel.to_string(),
        k => format!("{sel}[{k}]"),
    }
}

fn action(st: &Value) -> String {
    match st["op"].as_str().unwrap_or("") {
        "set" => format!("set {}={}", at(st), st["value"].as_str().unwrap_or("")),
        "select" => format!("select {}={}", at(st), st["value"].as_str().unwrap_or("")),
        "click" => format!("click {}", at(st)),
        "reload" => "reload".into(),
        o => o.to_string(),
    }
}

fn want(st: &Value) -> String {
    let op = st["op"].as_str().unwrap_or("");
    match op {
        "expect_text" | "expect_value" => {
            let what = if op == "expect_value" { "value" } else { "text" };
            if let Some(c) = st["contains"].as_str() {
                format!("expected {} {what} to contain \"{c}\"", at(st))
            } else if let Some(c) = st["equals"].as_str() {
                format!("expected {} {what} = \"{c}\"", at(st))
            } else {
                format!("expected {} {what} ≈{} (±{})", at(st), st["approx"].as_f64().unwrap_or(0.0), st["tol"].as_f64().unwrap_or(0.0))
            }
        }
        "expect_class" => format!("expected {} {} class \"{}\"", at(st), if st["present"] == false { "not to have" } else { "to have" }, st["cls"].as_str().unwrap_or("")),
        "expect_count" => format!("expected {} element(s) matching {}", st["count"], at(st)),
        "expect_order" => format!(
            "expected {}{} in the order {}",
            at(st),
            st["attr"].as_str().map(|a| format!(" ({a})")).unwrap_or_default(),
            st["order"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default()
        ),
        _ => op.to_string(),
    }
}

/// What one probe found.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub answer: usize,
    pub ran: bool,
    pub passed: bool,
    /// The probe itself was broken (its selector matches nothing / no such option), not the page.
    pub error: bool,
    pub detail: String,
}

/// The probe run as a whole.
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeRun {
    /// Not run (no probes, no Edge, runtime checks off): the evidence-only rule applies.
    Skipped(String),
    /// Edge ran but gave no result (timeout, the page hung or navigated away): skipped too.
    Failed(String),
    Ran(Vec<ProbeResult>),
}

impl ProbeRun {
    pub fn summary(&self) -> Value {
        match self {
            ProbeRun::Skipped(r) => json!({ "ran": false, "skipped": r }),
            ProbeRun::Failed(r) => json!({ "ran": false, "failed": r }),
            ProbeRun::Ran(v) => json!({ "ran": true, "count": v.len(), "passed": v.iter().filter(|r| r.passed).count() }),
        }
    }
}

/// The harness's per-probe records (`[{ok,k,at,got}]`) read back into results. Pure.
pub fn probe_results(probes: &[Probe], raw: &Value) -> Vec<ProbeResult> {
    let arr = raw.as_array().cloned().unwrap_or_default();
    probes
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let Some(r) = arr.get(i) else {
                return ProbeResult { answer: p.answer, ran: false, passed: false, error: false, detail: "not run (the page ran out of time)".into() };
            };
            if r["ok"] == true {
                return ProbeResult { answer: p.answer, ran: true, passed: true, error: false, detail: "passed".into() };
            }
            let k = r["at"].as_u64().unwrap_or(0) as usize;
            let st = p.steps.get(k).cloned().unwrap_or(Value::Null);
            let got = clip_chars(&r["got"].as_str().map(String::from).unwrap_or_else(|| r["got"].to_string()), 120);
            let did: Vec<String> = p.steps.iter().take(k).filter(|s| !s["op"].as_str().unwrap_or("").starts_with("expect_")).map(action).collect();
            let after = if did.is_empty() { "on a fresh load".to_string() } else { format!("after {}", did.join(", ")) };
            let (error, detail) = match r["k"].as_str().unwrap_or("") {
                "nomatch" => (true, format!("{} matches nothing (probe step {})", at(&st), k + 1)),
                "nooption" => (true, format!("{} has no option \"{}\" (it shows \"{got}\")", at(&st), st["value"].as_str().unwrap_or(""))),
                "threw" => {
                    let upto: Vec<String> = p.steps.iter().take(k + 1).filter(|s| !s["op"].as_str().unwrap_or("").starts_with("expect_")).map(action).collect();
                    (false, format!("after {} the page threw: {got}", upto.join(", ")))
                }
                _ => (false, format!("{after} {}, got {got}", want(&st))),
            };
            ProbeResult { answer: p.answer, ran: true, passed: false, error, detail: clip_chars(&detail, 220) }
        })
        .collect()
}

// ── Judging ─────────────────────────────────────────────────────────────────

/// The verifier's per-criterion verdicts checked against the code and the probes.
#[derive(Debug, Clone, PartialEq)]
pub struct Judged {
    /// One fix line per criterion that is not met, has no evidence in the code, or whose probe
    /// failed (probe failures first).
    pub unmet: Vec<String>,
    /// Criteria the verifier did not judge, or whose code was cut from its view ("not shown").
    /// Never counted as unmet; named as known blockers when the build is staged.
    pub not_judged: Vec<String>,
    /// The checked list (criterion, met, evidence found, probe) for the envelope.
    pub criteria: Value,
    /// The verifier returned no per-criterion list at all.
    pub absent: bool,
}

/// Judge the answers: a criterion counts only when the model says it is met AND quotes code that
/// is really in the page, and its probe (if it ran) did not fail. A probe whose selector matches
/// nothing is reported but only counts against a criterion that also has no evidence. Pure.
pub fn judge(answers: &Answers, html: &str, cut: bool, run: &ProbeRun) -> Judged {
    let hn = norm(html);
    let results: &[ProbeResult] = match run {
        ProbeRun::Ran(v) => v,
        _ => &[],
    };
    let (mut probe_lines, mut other, mut not_judged, mut out) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (i, a) in answers.list.iter().enumerate() {
        let name: String = clip_chars(&a.name, 100);
        let found = !a.evidence.is_empty() && evidence_found(&hn, &a.evidence);
        let res = results.iter().find(|r| r.answer == i);
        let probe_json = match (&a.probe, res) {
            (Some(Err(why)), _) => json!({ "ran": false, "passed": false, "error": true, "detail": format!("probe rejected: {why}") }),
            (Some(Ok(_)), Some(r)) => json!({ "ran": r.ran, "passed": r.passed, "error": r.error, "detail": r.detail }),
            (Some(Ok(_)), None) => json!({ "ran": false, "passed": false, "error": false, "detail": match run { ProbeRun::Skipped(r) | ProbeRun::Failed(r) => format!("skipped: {r}"), ProbeRun::Ran(_) => format!("skipped: at most {MAX_PROBES} probes run") } }),
            (None, _) => Value::Null,
        };
        let probe_failed = res.is_some_and(|r| r.ran && !r.passed && !r.error);
        let probe_note = res.filter(|r| r.error).map(|r| format!("; its probe: {}", r.detail)).or_else(|| match &a.probe {
            Some(Err(why)) => Some(format!("; its probe was rejected: {why}")),
            _ => None,
        });
        if probe_failed {
            probe_lines.push(format!("probe failed for {}: {}", clip_chars(&a.name, 80), res.map(|r| r.detail.as_str()).unwrap_or("")));
        } else {
            match a.met {
                Some(false) => {
                    let why = if a.fix.is_empty() { String::new() } else { format!(" ({})", clip_chars(&a.fix, 90)) };
                    other.push(format!("not met: {name}{why}"));
                }
                Some(true) if !found => other.push(format!("no working code found for: {name} (implement it for real{})", probe_note.unwrap_or_default())),
                Some(true) => {}
                None if cut => not_judged.push(format!("not shown to the verifier (code cut for length): {name}")),
                None => not_judged.push(format!("verify did not judge: {name}")),
            }
        }
        out.push(json!({ "n": a.idx.map(|x| x + 1), "criterion": a.name, "met": a.met, "evidence_found": found, "evidence": a.evidence.chars().take(160).collect::<String>(), "probe": probe_json }));
    }
    not_judged.extend(answers.missing.iter().map(|m| format!("verify did not judge: {}", clip_chars(m, 100))));
    probe_lines.extend(other);
    Judged { unmet: probe_lines, not_judged, criteria: Value::Array(out), absent: answers.list.is_empty() }
}

// ── Headless Edge (Windows) ─────────────────────────────────────────────────

/// Shared by both harnesses: stub dialogs / window.open, stop form submits, and never let a
/// download start (an export button would otherwise write into the user's Downloads and keep Edge
/// alive). `rec` filters the harmless ResizeObserver loop notice.
const GUARDS: &str = r#"var E=[];function rec(m){m=String(m);if(/^ResizeObserver loop/.test(m))return;if(E.length<8)E.push(m.slice(0,200))}
addEventListener('error',function(e){rec(e.message||'error')});
addEventListener('unhandledrejection',function(e){var r=e.reason;rec('unhandled promise rejection: '+(r&&r.message||r))});
window.alert=function(){};window.confirm=function(){return true};window.prompt=function(){return ''};window.open=function(){return null};
document.addEventListener('submit',function(e){e.preventDefault()},true);
function dl(a){return !!a&&(a.hasAttribute('download')||/^(blob|data):/i.test(a.getAttribute('href')||''))}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a'):null;if(dl(a))e.preventDefault()},true);
var AC=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(dl(this))return;return AC.apply(this,arguments)};"#;

/// The smoke: storage blocked (a sandboxed preview or a locked-down browser throws on it; each
/// blocked access records the calling line), then after load fill the inputs, change the selects,
/// click the buttons still on the page, and write the result onto <html>.
const SMOKE_JS: &str = r#"var H=[];function site(){try{var f=String(new Error().stack||'').split('\n')[3]||'';var m=f.match(/:(\d+):\d+\)?\s*$/);if(m&&H.length<40)H.push(+m[1])}catch(x){}}
function block(n){try{Object.defineProperty(window,n,{configurable:true,get:function(){site();throw new DOMException(n+' is blocked here (guard storage with try/catch)','SecurityError')}})}catch(x){}}
block('localStorage');block('sessionStorage');
addEventListener('load',function(){setTimeout(function(){var L=E.length;
try{document.querySelectorAll('input').forEach(function(i){var t=(i.type||'text').toLowerCase();if(t==='number'||t==='range'){i.value='50'}else if(t==='checkbox'||t==='radio'){i.checked=!i.checked}else if(t==='text'||t==='search'||t===''){i.value='Test item'}else{return}
i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}))});
document.querySelectorAll('select').forEach(function(s){if(s.options.length>1){s.selectedIndex=1;s.dispatchEvent(new Event('change',{bubbles:true}))}});
Array.prototype.slice.call(document.querySelectorAll('button'),0,30).forEach(function(b){if(!b.isConnected||b.disabled)return;b.click()})}catch(x){rec('while using the page: '+x.message)}
setTimeout(function(){document.documentElement.setAttribute('data-tf-smoke',JSON.stringify({errors:E,load:L,storage:H}))},300)},300)});"#;

/// The probe runner (storage NOT blocked). Its state lives in `window.name` across reloads: every
/// probe starts on a fresh load with storage cleared; `reload` reloads keeping storage; a step is
/// saved before it acts, so a page that reloads itself resumes at the next step.
const PROBE_JS: &str = r#"var P=__PROBES__;var S=null;try{S=JSON.parse(window.name)}catch(x){}
if(!S||S.k!=='__tfp'){S={k:'__tfp',p:0,s:0,R:[]}}
if(S.s===0){try{localStorage.clear();sessionStorage.clear()}catch(x){}}
function save(){window.name=JSON.stringify(S)}
function done(r){S.R.push(r);S.p++;S.s=0;if(S.p<P.length){save();location.reload()}else{window.name='';document.documentElement.setAttribute('data-tf-probe',JSON.stringify(S.R))}}
function all(q){try{return Array.prototype.slice.call(document.querySelectorAll(q))}catch(x){return null}}
function nm(s){return String(s==null?'':s).replace(/\s+/g,' ').trim()}
function num(s){var m=String(s).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);return m?parseFloat(m[0]):null}
function val(el){return /^(INPUT|SELECT|TEXTAREA|OUTPUT)$/.test(el.tagName)?el.value:(el.textContent||'')}
function fire(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}
function step(){if(S.p>=P.length)return;var st=P[S.p][S.s];if(!st){done({ok:true});return}
var i=S.s;S.s++;save();var n0=E.length;
if(st.op==='reload'){location.reload();return}
var l=all(st.sel);if(!l){done({ok:false,k:'nomatch',at:i});return}
var el=l[st.nth||0]||null;var many=st.op==='expect_count'||st.op==='expect_order';
if(!many&&!el){done({ok:false,k:'nomatch',at:i});return}
if(st.op==='set'){if(el.type==='checkbox'||el.type==='radio'){el.checked=/^(true|1|on|yes|checked)$/i.test(st.value)}else{el.value=st.value}fire(el)}
else if(st.op==='select'){var o=-1,os=el.options||[];for(var k=0;k<os.length;k++){if(os[k].value===st.value||nm(os[k].textContent).toLowerCase()===nm(st.value).toLowerCase()){o=k;break}}if(o<0){done({ok:false,k:'nooption',at:i,got:nm(el.value)});return}el.selectedIndex=o;fire(el)}
else if(st.op==='click'){el.click()}
else{var ok=true,got='';
if(st.op==='expect_text'||st.op==='expect_value'){got=nm(st.op==='expect_value'?val(el):(el.innerText||el.textContent));
if(st.contains!=null){ok=got.toLowerCase().indexOf(nm(st.contains).toLowerCase())>=0}else if(st.equals!=null){ok=got.toLowerCase()===nm(st.equals).toLowerCase()}else{var x=num(got);ok=x!==null&&Math.abs(x-st.approx)<=st.tol}}
else if(st.op==='expect_class'){ok=el.classList.contains(st.cls)===st.present;got=nm(el.className)||'(no class)'}
else if(st.op==='expect_count'){ok=l.length===st.count;got=String(l.length)}
else if(st.op==='expect_order'){var v=l.map(function(e){return nm(st.attr?e.getAttribute(st.attr):(e.innerText||e.textContent))});var w=v.filter(function(y){return st.order.indexOf(y)>=0});ok=w.join('\u0001')===st.order.join('\u0001');got=v.slice(0,12).join(', ')}
if(!ok){done({ok:false,k:'fail',at:i,got:String(got).slice(0,120)});return}
setTimeout(step,0);return}
setTimeout(function(){if(E.length>n0){done({ok:false,k:'threw',at:i,got:E[n0]});return}step()},80)}
addEventListener('load',function(){setTimeout(step,150)});"#;

/// `js` (newlines removed, so the page keeps its line numbers) injected first in <head> (or after
/// <html>, or at the top). Pure.
fn with_prelude(html: &str, js: &str) -> String {
    static HEAD: OnceLock<regex::Regex> = OnceLock::new();
    static HTML: OnceLock<regex::Regex> = OnceLock::new();
    let tag = format!("<script>(function(){{{}}})();</script>", js.replace(['\r', '\n'], ""));
    if let Some(m) = rx(&HEAD, r"(?i)<head\b[^>]*>").find(html).or_else(|| rx(&HTML, r"(?i)<html\b[^>]*>").find(html)) {
        format!("{}{tag}{}", &html[..m.end()], &html[m.end()..])
    } else {
        format!("{tag}{html}")
    }
}

/// The page with the smoke harness injected. Pure.
pub fn with_harness(html: &str) -> String {
    with_prelude(html, &format!("{GUARDS}{SMOKE_JS}"))
}

/// The page with the probe runner injected (the probes as inert JSON). Pure.
pub fn with_probes(html: &str, probes: &[Probe]) -> String {
    let steps: Vec<&Vec<Value>> = probes.iter().map(|p| &p.steps).collect();
    let data = serde_json::to_string(&steps).unwrap_or_else(|_| "[]".into()).replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    // Newlines go first (JSON has none raw), then the data.
    let js = format!("{GUARDS}{PROBE_JS}").replace(['\r', '\n'], "").replace("__PROBES__", &data);
    with_prelude(html, &js)
}

/// An attribute's JSON value out of a `--dump-dom` print. Pure.
fn attr_json(dom: &str, attr: &str) -> Option<Value> {
    let needle = format!("{attr}=\"");
    let i = dom.find(&needle)? + needle.len();
    let j = dom[i..].find('"')? + i;
    let raw = dom[i..j].replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'").replace("&nbsp;", "\u{a0}").replace("&amp;", "&");
    serde_json::from_str(&raw).ok()
}

/// The smoke result out of a `--dump-dom` print: (errors, how many happened on load, the page
/// lines where a blocked storage access happened). Pure.
pub fn parse_dump(dom: &str) -> Option<(Vec<String>, usize, Vec<usize>)> {
    let v = attr_json(dom, "data-tf-smoke")?;
    let errs = v["errors"].as_array()?.iter().filter_map(|e| e.as_str()).map(String::from).collect();
    let lines = v["storage"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as usize).collect()).unwrap_or_default();
    Some((errs, v["load"].as_u64().unwrap_or(0) as usize, lines))
}

fn browser() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(|k| std::env::var_os(k)).map(|p| PathBuf::from(p).join("Microsoft").join("Edge").join("Application").join("msedge.exe")).find(|p| p.is_file())
}

/// Remove `tf-smoke-*` folders a killed / crashed app left in %TEMP% (older than 15 min). Once
/// per process.
fn sweep_stale() {
    static DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if DONE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for d in rd.flatten() {
        let old = d.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(15 * 60));
        if d.file_name().to_string_lossy().starts_with("tf-smoke-") && d.path().is_dir() && old {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

enum EdgeOut {
    /// Could not run at all (no Edge, no temp dir, Edge printed nothing).
    Unavailable(String),
    /// Ran but gave no result (timeout, the page hung, reloaded forever or navigated away).
    Failed(String),
    Dom(String),
}

fn dump_has(path: &Path, needle: &str) -> bool {
    std::fs::read_to_string(path).ok().is_some_and(|d| d.find(needle).is_some_and(|i| d[i + needle.len()..].contains('"')))
}

/// Load `page_html` in headless Edge: a temp copy, its own throwaway profile (downloads pointed
/// into the temp folder), the network unreachable, a kill-on-close job (Edge dies with the app),
/// a timeout. Returns the dumped DOM once it carries `attr`. Blocking.
fn run_edge(page_html: &str, attr: &str, timeout: Duration, budget_ms: u64) -> EdgeOut {
    let Some(exe) = browser() else { return EdgeOut::Unavailable("Edge is not installed".into()) };
    sweep_stale();
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("tf-smoke-{}-{nanos}-{}", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    if std::fs::create_dir_all(&dir).is_err() {
        return EdgeOut::Unavailable("no temp folder".into());
    }
    let r = edge_in(&exe, &dir, page_html, attr, timeout, budget_ms);
    // The profile may still be locked for a moment by Edge's helpers: best effort.
    for _ in 0..10 {
        if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    r
}

fn edge_in(exe: &Path, dir: &Path, page_html: &str, attr: &str, timeout: Duration, budget_ms: u64) -> EdgeOut {
    let file = dir.join("index.html");
    let downloads = dir.join("downloads");
    let prefs = dir.join("profile").join("Default");
    if std::fs::write(&file, page_html).is_err() || std::fs::create_dir_all(&downloads).is_err() || std::fs::create_dir_all(&prefs).is_err() {
        return EdgeOut::Unavailable("could not write the temp copy".into());
    }
    let dl = downloads.to_string_lossy();
    let seeded = json!({ "download": { "default_directory": dl, "prompt_for_download": false, "directory_upgrade": true }, "savefile": { "default_directory": dl } });
    let _ = std::fs::write(prefs.join("Preferences"), seeded.to_string());
    // A real file URL ('#', '%', spaces and non-ASCII percent-encoded).
    let Ok(url) = url::Url::from_file_path(&file) else { return EdgeOut::Unavailable("the temp path is not a file URL".into()) };
    let out_path = dir.join("dom.txt");
    let Ok(out) = std::fs::File::create(&out_path) else { return EdgeOut::Unavailable("could not create the output file".into()) };
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND"])
        .arg(format!("--virtual-time-budget={budget_ms}"))
        .arg("--dump-dom")
        .arg(format!("--user-data-dir={}", dir.join("profile").display()))
        .arg(url.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(std::process::Stdio::null());
    // CREATE_NO_WINDOW, in a kill-on-close job.
    let (mut child, job) = match crate::proc::spawn_in_job(&mut cmd, 0x0800_0000) {
        Ok(x) => x,
        Err(e) => return EdgeOut::Unavailable(format!("Edge did not start: {e}")),
    };
    let kill = |child: &mut std::process::Child, job: &Option<crate::proc::Job>| {
        if let Some(j) = job {
            j.kill();
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    let needle = format!("{attr}=\"");
    let t0 = Instant::now();
    let mut polls = 0u32;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if t0.elapsed() > timeout {
                    kill(&mut child, &job);
                    return EdgeOut::Failed(format!("no result after {}s: the page hung, kept reloading or never finished", timeout.as_secs()));
                }
                polls += 1;
                // The result is already printed but Edge lingers (e.g. after a download): done.
                if polls % 5 == 0 && dump_has(&out_path, &needle) {
                    kill(&mut child, &job);
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                kill(&mut child, &job);
                return EdgeOut::Unavailable(format!("Edge: {e}"));
            }
        }
    }
    // Ends any helper still running.
    drop(job);
    let dom = std::fs::read_to_string(&out_path).unwrap_or_default();
    if dom.trim().is_empty() {
        return EdgeOut::Unavailable("Edge printed no page".into());
    }
    if !dom.contains(&needle) {
        return EdgeOut::Failed("the page navigated away or replaced itself before the check finished".into());
    }
    EdgeOut::Dom(dom)
}

/// The runtime smoke's outcome.
#[derive(Debug, Clone, PartialEq)]
pub enum Smoke {
    /// Not run (no Edge, runtime checks off, the page unreadable): the gate uses the static checks.
    Skipped(String),
    /// Ran but produced no result (timeout, the page hung / kept reloading / navigated away):
    /// a gate failure, never a silent pass.
    Failed(String),
    /// Ran: uncaught errors as fix lines, and the page lines where a blocked storage access
    /// happened (each one was caught when `errors` has no storage error).
    Ran { errors: Vec<String>, storage_lines: Vec<usize> },
}

/// Load the page in headless Edge (network unreachable, own throwaway profile, storage blocked),
/// exercise its controls, and report what threw. Blocking.
pub fn runtime_smoke(page: &Path, timeout: Duration) -> Smoke {
    let Ok(html) = std::fs::read_to_string(page) else { return Smoke::Skipped("the staged page could not be read".into()) };
    match run_edge(&with_harness(&html), "data-tf-smoke", timeout, 5000) {
        EdgeOut::Unavailable(r) => Smoke::Skipped(r),
        EdgeOut::Failed(r) => Smoke::Failed(r),
        EdgeOut::Dom(dom) => match parse_dump(&dom) {
            Some((errs, load, lines)) => Smoke::Ran {
                errors: errs.iter().enumerate().map(|(i, e)| if i < load { format!("the page throws on load: {e}") } else { format!("the page throws when its controls are used: {e}") }).collect(),
                storage_lines: lines,
            },
            None => Smoke::Failed("the page's result could not be read".into()),
        },
    }
}

/// Run the verifier's probes in headless Edge (storage working, a fresh load per probe). Blocking.
pub fn run_probes(page: &Path, probes: &[Probe], timeout: Duration) -> ProbeRun {
    if probes.is_empty() {
        return ProbeRun::Skipped("no probes".into());
    }
    let Ok(html) = std::fs::read_to_string(page) else { return ProbeRun::Skipped("the staged page could not be read".into()) };
    let budget = 2000 + 1500 * probes.len() as u64;
    match run_edge(&with_probes(&html, probes), "data-tf-probe", timeout, budget) {
        EdgeOut::Unavailable(r) => ProbeRun::Skipped(r),
        EdgeOut::Failed(r) => ProbeRun::Failed(r),
        EdgeOut::Dom(dom) => match attr_json(&dom, "data-tf-probe") {
            Some(v) => ProbeRun::Ran(probe_results(probes, &v)),
            None => ProbeRun::Failed("the probe results could not be read".into()),
        },
    }
}

#[cfg(test)]
mod tests;
