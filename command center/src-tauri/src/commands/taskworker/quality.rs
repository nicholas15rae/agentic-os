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
//! because quoted code only proves an element exists — hence the probes (AD-11). A later review
//! found the probes optional and the 9B verifier copying its expectations from the page's own
//! code (a round-trip toggle, a formula's own output passed): behavioural criteria now NEED a
//! probe that ran and passed, and Nic's own values are pinned here as intent checks (AD-12). Run 3
//! then staged a page stuck on "Loading..." with a 9B verifier writing numbers as text: those are
//! read as numbers, stuck outputs fail the gate, pinned values are corrected rather than rejected,
//! a switch must show a change, Nic's unit is checked on load, and a passing probe on an element of
//! its own outranks stale quoted code (AD-13).

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

// ── Intent checks: Nic's own values, pinned in Rust (AD-12) ─────────────────

/// What an intent check pins.
#[derive(Debug, Clone, PartialEq)]
pub enum CheckKind {
    /// On a fresh load, before any action, the page shows Nic's default (`IntentCheck::value`).
    Default,
    /// After switching from `from` to `to`, Nic's default reads the converted `value`.
    Convert { from: String, to: String, start: f64 },
    /// The choices for Nic's range read these labels, ascending.
    Order(Vec<String>),
    /// On a fresh load the unit control has Nic's default unit (`unit`, a unit key) selected,
    /// not the other unit of the pair (AD-13).
    Unit { unit: String, other: String },
}

/// A check derived from Nic's request with its expected value computed here: the verifier only
/// supplies selectors and actions, never the expectation.
#[derive(Debug, Clone, PartialEq)]
pub struct IntentCheck {
    pub kind: CheckKind,
    /// The pinned number (Default / Convert; 0 for Order).
    pub value: f64,
    pub tol: f64,
    /// The numbered criterion the verifier reads (the pinned value stated).
    pub criterion: String,
}

impl IntentCheck {
    /// The pinned expectation as the verifier is told it ("74.84", "3, 4, 5").
    pub fn pinned(&self) -> String {
        match &self.kind {
            CheckKind::Order(v) => v.join(", "),
            CheckKind::Unit { unit, .. } => unit_label(unit),
            _ => fmt_num(self.value),
        }
    }
    pub fn need(&self) -> Need {
        let convert = matches!(self.kind, CheckKind::Convert { .. });
        Need { probe: true, action: convert, fresh: !convert, value: convert, check: Some(self.clone()), toggle: false, shows: Vec::new(), zero: false }
    }
    /// Its probe proves a number (Default / Convert): a read of a big container cannot.
    fn numeric(&self) -> bool {
        matches!(self.kind, CheckKind::Default | CheckKind::Convert { .. })
    }
}

/// The tolerance for a pinned number: 0.6 % of it, at least 0.5. Pure.
fn pin_tol(v: f64) -> f64 {
    (v.abs() * 0.006).max(0.5)
}

/// A number as the prompt states it: at most 2 decimals, no trailing zeros. Pure.
fn fmt_num(v: f64) -> String {
    let s = format!("{:.2}", (v * 100.0).round() / 100.0);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

/// A unit-conversion family key for a unit word ("lbs" → "lb", "inches" → "in"). Pure.
fn unit_key(u: &str) -> Option<&'static str> {
    let u = u.to_lowercase();
    Some(match u.trim_end_matches('s') {
        "lb" | "pound" => "lb",
        "kg" | "kilogram" | "kilo" => "kg",
        "mile" | "mi" => "mi",
        "km" | "kilometer" | "kilometre" => "km",
        "°f" | "fahrenheit" => "°f",
        "°c" | "celsius" => "°c",
        "oz" | "ounce" => "oz",
        "g" | "gram" => "g",
        "inche" | "inch" | "in" => "in",
        "cm" | "centimeter" | "centimetre" => "cm",
        "feet" | "ft" | "foot" => "ft",
        "meter" | "metre" | "m" => "m",
        _ => return None,
    })
}

/// The unit pairs a request may name, by key.
const UNIT_PAIRS: [(&str, &str); 6] = [("lb", "kg"), ("mi", "km"), ("°f", "°c"), ("oz", "g"), ("in", "cm"), ("ft", "m")];

/// (every spelling — used in an "a/b" pair; the unambiguous ones — used with "or" / "and" / "to").
fn unit_spellings(key: &str) -> (&'static str, &'static str) {
    match key {
        "lb" => ("lbs?|pounds?", "lbs?|pounds?"),
        "kg" => ("kgs?|kilograms?|kilos?", "kgs?|kilograms?|kilos?"),
        "mi" => ("mi|miles?", "miles?"),
        "km" => ("kms?|kilomet(?:er|re)s?", "kms?|kilomet(?:er|re)s?"),
        "°f" => ("°f|f|fahrenheit", "°f|fahrenheit"),
        "°c" => ("°c|c|celsius|centigrade", "°c|celsius|centigrade"),
        "oz" => ("oz|ounces?", "oz|ounces?"),
        "g" => ("g|grams?", "grams?"),
        "in" => ("in|inch|inches", "inch|inches"),
        "cm" => ("cms?|centimet(?:er|re)s?", "cms?|centimet(?:er|re)s?"),
        "ft" => ("ft|feet|foot", "ft|feet|foot"),
        _ => ("m|met(?:er|re)s?", "met(?:er|re)s?"),
    }
}

fn unit_label(key: &str) -> String {
    match key {
        "°f" => "°F".into(),
        "°c" => "°C".into(),
        k => k.to_string(),
    }
}

fn convert_unit(from: &str, to: &str, x: f64) -> Option<f64> {
    Some(match (from, to) {
        ("lb", "kg") => x * 0.453_592_37,
        ("kg", "lb") => x / 0.453_592_37,
        ("mi", "km") => x * 1.609_344,
        ("km", "mi") => x / 1.609_344,
        ("°f", "°c") => (x - 32.0) * 5.0 / 9.0,
        ("°c", "°f") => x * 9.0 / 5.0 + 32.0,
        ("oz", "g") => x * 28.349_523_125,
        ("g", "oz") => x / 28.349_523_125,
        ("in", "cm") => x * 2.54,
        ("cm", "in") => x / 2.54,
        ("ft", "m") => x * 0.3048,
        ("m", "ft") => x / 0.3048,
        _ => return None,
    })
}

/// Does the (ASCII-lowercased) request name the unit pair, as "lb/kg" or "pounds or kilograms"?
fn names_pair(lower: &str, a: &str, b: &str) -> bool {
    let (a_all, a_long) = unit_spellings(a);
    let (b_all, b_long) = unit_spellings(b);
    let pat = |x: &str, y: &str, sep: &str| format!(r"(?:^|[^a-z°])(?:{x}){sep}(?:{y})(?:$|[^a-z])");
    let words = r"\s*(?:/|<->|↔|⇄)\s*";
    let link = r"\s+(?:or|and|to|vs\.?|versus|into)\s+";
    [pat(a_all, b_all, words), pat(b_all, a_all, words), pat(a_long, b_long, link), pat(b_long, a_long, link)].iter().any(|p| regex::Regex::new(p).is_ok_and(|r| r.is_match(lower)))
}

/// How an occurrence of a literal is stated.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stated {
    /// As the page's default: "default 165 lb", "starts at …", "… by default".
    Default,
    /// As a fact about Nic: "I'm 165 lbs", "I am …", "my weight is …" — a default only when the
    /// request also asks for that quantity (`personal_pinned`).
    Personal,
}

/// Is this occurrence of a literal (number at byte `p`, unit ending at `end`) stated as Nic's
/// default, or as a personal stat? A default: "default 165 lb", "starts at …", "… by default",
/// or a back-reference to it (`back_reference`: "I weigh 165 lbs; use that as the default", "…
/// that's the default"). Personal: "I'm …", "I am …", "I weigh …", "my weight is …", "my
/// weight (165 pounds)", "my daily run is …" — never "my last 10 lbs" or "my old 30 lb pack"
/// (an adjective after "my" is not a stat about Nic). Pure.
fn stated_default(lower: &str, p: usize, end: usize) -> Option<Stated> {
    static STRONG: OnceLock<regex::Regex> = OnceLock::new();
    static PERSONAL: OnceLock<regex::Regex> = OnceLock::new();
    static AFTER: OnceLock<regex::Regex> = OnceLock::new();
    let strong = rx(&STRONG, r"(?:\bdefaults?\b(?:\s+[a-z]+){0,2}|\bstarts?\s+(?:at|with|on))[\s:=(]*$");
    let personal = rx(
        &PERSONAL,
        r"(?:\bi['’]?m|\bi\s+am|\bi\s+weigh(?:s)?|\bmy\s+(?:(?:current|actual|own|usual|present|starting|body)\s+){0,2}weight(?:\s+(?:is|of))?|\bmy\s+[a-z]+(?:\s+[a-z]+)?\s+(?:is|=))[\s:=(]*$",
    );
    let after = rx(&AFTER, r"^[\s,)]*(?:by\s+default|as\s+(?:the\s+|a\s+|my\s+)?default|\(?\s*default\b)");
    let a = floor_boundary(lower, p.saturating_sub(48));
    let mut win = &lower[a..p];
    // Within the same sentence only.
    if let Some(i) = win.rfind(['\n', '!', '?', ';']).into_iter().chain(win.rfind(". ")).max() {
        win = &win[i + 1..];
    }
    let tail = &lower[end..floor_boundary(lower, end + 90)];
    if strong.is_match(win) || after.is_match(&lower[end..]) || back_reference(tail) {
        Some(Stated::Default)
    } else if personal.is_match(win) {
        Some(Stated::Personal)
    } else {
        None
    }
}

/// Does the text right after a value (its unit included) refer back to it as the default? Within
/// the value's own clause ("165 lbs, so use that as the default"), or — when a sentence end
/// follows the value at once — in the next clause, which must BE the back-reference ("165 lbs;
/// use that as the default", "165 lb. That's the default."). "default" must end its clause or be
/// followed by value / weight / setting … or a preposition: "make it the default tab", "this is
/// the default page I open" and "It's the default tool on my phone" name something else. Never
/// across a further sentence end or another number. Pure.
fn back_reference(tail: &str) -> bool {
    static SAME: OnceLock<regex::Regex> = OnceLock::new();
    static NEXT: OnceLock<regex::Regex> = OnceLock::new();
    const CORE: &str = r"(?:(?:use|make|set|keep|treat|take)\s+(?:that|this|it)\s+(?:as\s+)?(?:the\s+|my\s+|a\s+|our\s+)?(?:starting\s+)?default|(?:that|this|it)(?:['’]s|\s+is|\s+should\s+be|\s+will\s+be)\s+(?:the\s+|my\s+)?(?:starting\s+)?default)";
    const END: &str = r"(?:\s+(?:value|weight|setting|number|amount|entry|one))?\s*(?:$|[,:()]|\s+(?:for|on|in|when|if|please|and|so|but)\b)";
    let same = rx(&SAME, &format!(r"^[^\d]{{0,60}}?\b{CORE}{END}"));
    let next = rx(&NEXT, &format!(r"^{CORE}{END}"));
    let stop = |s: &str| s.find(['.', '!', '?', ';', '\n']).unwrap_or(s.len());
    let rest = tail.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ')');
    if rest.starts_with(['.', '!', '?', ';', '\n']) {
        let next_clause = rest[1..].trim_start();
        next.is_match(&next_clause[..stop(next_clause)])
    } else {
        same.is_match(&rest[..stop(rest)])
    }
}

/// The request's sentences with their byte offsets (split at ". ", "!", "?", ";", newlines). Pure.
fn sentences(lower: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = lower.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        let end = matches!(c, b'\n' | b'!' | b'?' | b';') || (c == b'.' && b.get(i + 1).map_or(true, |n| n.is_ascii_whitespace()));
        if end {
            out.push((start, &lower[start..i]));
            start = i + 1;
        }
    }
    out.push((start, &lower[start..]));
    out
}

/// A personal stat ("I'm 165 lbs", "my run is 5 miles") is pinned as the page's default only when
/// the request also asks for that quantity: its unit pair is named ("lb/kg"), or a word of its
/// unit appears in another sentence that asks for a default, an input, a field or a toggle.
/// "I'm 28 years old" in a protein-calculator request pins nothing. Pure.
fn personal_pinned(lower: &str, l: &Literal, at: (usize, usize)) -> bool {
    static ASKS: OnceLock<regex::Regex> = OnceLock::new();
    if let Some(k) = unit_key(&l.unit) {
        if UNIT_PAIRS.iter().any(|(a, b)| (k == *a || k == *b) && names_pair(lower, a, b)) {
            return true;
        }
    }
    let asks = rx(&ASKS, r"\b(?:defaults?|inputs?|fields?|enter|slider|picker|selector|toggle|switch)\b");
    let words = unit_words(&l.unit);
    sentences(lower).into_iter().any(|(s, text)| {
        let holds_it = s <= at.0 && at.1 <= s + text.len();
        !holds_it && asks.is_match(text) && words.iter().any(|w| has_word(text, w))
    })
}

/// The checks Nic's request clearly pins, computed here (at most `MAX_CHECKS`; nothing when
/// unclear): (a) a literal stated as a default (a personal stat only when the request also asks
/// for that quantity) → on load the page shows it; (b) a unit pair named in the request plus such
/// a default in one of its units → after switching, the converted number; (c) an integer range
/// "N-M <noun>" (1 ≤ M-N ≤ 6) itself offered as choices → the options read N..M ascending; (d)
/// such a default in one unit of a named pair → that unit is selected on load (AD-13). Generic:
/// no app-specific paths. Pure.
pub fn intent_checks(text: &str) -> Vec<IntentCheck> {
    static UNIT_AT: OnceLock<regex::Regex> = OnceLock::new();
    let unit_at = UNIT_AT.get_or_init(|| regex::Regex::new(&format!(r"^\s?({UNITS})(?:$|[^\w/])")).unwrap());
    // ASCII lowercasing keeps every byte offset.
    let lower = text.to_ascii_lowercase();
    let mut defaults: Vec<(Literal, f64)> = Vec::new();
    for l in intent_literals(text).into_iter().filter(|l| l.low.is_none()) {
        let Ok(v) = l.number.parse::<f64>() else { continue };
        let words = unit_words(&l.unit);
        let mut forms = vec![l.number.clone()];
        forms.extend(grouped(&l.number));
        let stated = forms.iter().any(|f| {
            number_positions(&lower, f).into_iter().any(|p| {
                let e = p + f.len();
                let Some(c) = unit_at.captures(&lower[e..]).filter(|c| unit_words(&c[1]) == words) else { return false };
                let end = e + c.get(1).map_or(0, |m| m.end());
                match stated_default(&lower, p, end) {
                    Some(Stated::Default) => true,
                    Some(Stated::Personal) => personal_pinned(&lower, &l, (p, end)),
                    None => false,
                }
            })
        });
        if stated {
            defaults.push((l, v));
        }
    }
    // Two different defaults for one unit family (Nic changed his mind): pin neither.
    let fam = |l: &Literal| unit_words(&l.unit);
    let defaults: Vec<(Literal, f64)> = defaults.iter().filter(|(l, v)| !defaults.iter().any(|(m, w)| fam(m) == fam(l) && w != v)).cloned().collect();
    let mut out: Vec<IntentCheck> = Vec::new();
    for (l, v) in &defaults {
        out.push(IntentCheck {
            kind: CheckKind::Default,
            value: *v,
            tol: pin_tol(*v),
            criterion: format!("On a fresh load, before any action, the page shows Nic's default \"{}\" (pinned value: {}; expect_value or expect_text, no action first)", l.phrase, fmt_num(*v)),
        });
        let Some(from) = unit_key(&l.unit) else { continue };
        for (a, b) in UNIT_PAIRS {
            let to = if from == a { b } else if from == b { a } else { continue };
            if !names_pair(&lower, a, b) {
                continue;
            }
            let Some(c) = convert_unit(from, to, *v) else { continue };
            out.push(IntentCheck {
                kind: CheckKind::Convert { from: from.to_string(), to: to.to_string(), start: *v },
                value: c,
                tol: pin_tol(c),
                criterion: format!("After switching the unit from {} to {}, the value shown for Nic's \"{}\" reads the converted number (pinned value: {}; the probe switches the unit first, then expects it)", unit_label(from), unit_label(to), l.phrase, fmt_num(c)),
            });
        }
    }
    out.extend(range_checks(text));
    // (d) A default in one unit of a named pair: that unit is the one selected on load (165
    // shown while kg is active is not Nic's default). After the ranges, so a cap cuts it first.
    for (l, _) in &defaults {
        let Some(home) = unit_key(&l.unit) else { continue };
        for (a, b) in UNIT_PAIRS {
            let other = if home == a { b } else if home == b { a } else { continue };
            if !names_pair(&lower, a, b) || out.iter().any(|c| matches!(&c.kind, CheckKind::Unit { unit, .. } if unit == home)) || default_unit_named(&lower, other) {
                continue;
            }
            out.push(IntentCheck {
                kind: CheckKind::Unit { unit: home.to_string(), other: other.to_string() },
                value: 0.0,
                tol: 0.0,
                criterion: format!(
                    "On a fresh load, before any action, the unit control has Nic's unit {} selected, not {} (pinned unit: {}; expect on the unit select, radio group or unit buttons first, no action)",
                    unit_label(home),
                    unit_label(other),
                    unit_label(home)
                ),
            });
        }
    }
    out.truncate(MAX_CHECKS);
    out
}

/// The unit system a unit key belongs to.
fn metric(key: &str) -> bool {
    matches!(key, "kg" | "km" | "°c" | "g" | "cm" | "m")
}

/// Does the (ASCII-lowercased) request name `key` as the default UNIT ("default unit kg", "the
/// lb/kg toggle should default to kg", "kg by default", "start in kg", "metric by default")? Then
/// Nic's personal stat in the other unit says nothing about the unit selected on load. Pure.
fn default_unit_named(lower: &str, key: &str) -> bool {
    let (_, long) = unit_spellings(key);
    let short = match key {
        "lb" => "lbs?",
        "kg" => "kgs?",
        "mi" => "mi",
        "km" => "kms?",
        "°f" => "°f|f",
        "°c" => "°c|c",
        "oz" => "oz",
        "g" => "g",
        "in" => "inch|inches",
        "cm" => "cms?",
        "ft" => "ft",
        _ => "met(?:er|re)s?",
    };
    let system = if metric(key) { "metric" } else { "imperial|us customary" };
    let u = format!(r"(?:{long}|{short}|{system})");
    let pats = [
        format!(r"\bdefaults?\s+(?:the\s+)?(?:unit|units|system)?\s*(?:is\s+|of\s+|to\s+|=\s*|:\s*|in\s+)?(?:the\s+)?{u}(?:$|[^a-z])"),
        format!(r"(?:^|[^a-z°]){u}\s+(?:units?\s+)?(?:by|as\s+the|as)\s+default\b"),
        format!(r"\b(?:starts?|start\s+it|starting)\s+(?:out\s+)?(?:in|on|with)\s+(?:the\s+)?{u}(?:$|[^a-z])"),
        format!(r"\bdefault\s+(?:unit|units|system)\s*(?:should\s+be\s+|is\s+|=\s*|:\s*)?{u}(?:$|[^a-z])"),
    ];
    pats.iter().any(|p| regex::Regex::new(p).is_ok_and(|r| r.is_match(lower)))
}

/// Every unit key the pinned checks use (`unit_key`), for validating stored steps.
const UNIT_KEYS: [&str; 12] = ["lb", "kg", "mi", "km", "°f", "°c", "oz", "g", "in", "cm", "ft", "m"];

/// The pair partner of a unit key, if it has one.
fn pair_of(key: &str) -> Option<&'static str> {
    UNIT_PAIRS.iter().find_map(|(a, b)| if *a == key { Some(*b) } else if *b == key { Some(*a) } else { None })
}

/// At most this many intent checks are added to the verifier's criteria.
pub const MAX_CHECKS: usize = 4;

/// (c): "3-5 meals" / "3 to 5 meals" (integers, 1 ≤ M-N ≤ 6) that are themselves offered as
/// choices: a choice word right before the range ("split (3-5 meals)", "pick 2 to 4 laps",
/// "choose from 3-5 plans", "split it across 3-5 meals") or right after its noun ("3-5 meal
/// options", "3-5 meals as buttons"); "3 to 5 meals per day" only with a choice word in its
/// sentence or a per-meal split asked for (never "I drink 6-8 glasses a day").
/// A "button" or "toggle" elsewhere in the sentence does not make "5-10 questions" a choice;
/// never a measured range ("20-25 minutes", "8-12 reps"). At most 2. Pure.
fn range_checks(text: &str) -> Vec<IntentCheck> {
    static RANGE: OnceLock<regex::Regex> = OnceLock::new();
    static BEFORE: OnceLock<regex::Regex> = OnceLock::new();
    static AFTER: OnceLock<regex::Regex> = OnceLock::new();
    static MEASURE: OnceLock<regex::Regex> = OnceLock::new();
    static PER_DAY: OnceLock<regex::Regex> = OnceLock::new();
    static CHOICE: OnceLock<regex::Regex> = OnceLock::new();
    static SPLIT_ASK: OnceLock<regex::Regex> = OnceLock::new();
    let range = rx(&RANGE, r"(?i)(?:^|[^\w.,])(\d{1,3})\s?(?:-|–|to)\s?(\d{1,3})\s?([a-z]{2,20})\b");
    let before = rx(&BEFORE, r"(?i)\b(?:split|splits|splitting|spread|divide|dividing|choose|choosing|choice|choices|pick|picking|select|selecting|selector|option|options|dropdown|tabs?)\b(?:\s+(?:of|from|between|into|in|any|a|an|the|number|count|it|them|this|that|across|over|among|up|out|evenly))*\s*[(:]?\s*$");
    let after = rx(&AFTER, r"(?i)^[\s)]*(?:(?:as|in)\s+)?(?:(?:a|an|the)\s+)?(?:split|splits|options?|choices?|buttons?|tabs?|dropdown|selector|picker|toggle)\b");
    // "3 to 5 meals per day" is a daily count Nic picks from only with a choice word in its own
    // sentence, or for meals in a request that asks for a per-meal split: "I drink 6-8 glasses a
    // day" and "I eat 3 to 5 meals per day. Build a running tally" describe habits, not choices.
    let per_day = rx(&PER_DAY, r"(?i)^[\s)]*(?:a|per|each|every)\s+day\b");
    let choice_word = rx(&CHOICE, r"(?i)\b(?:split|splits|splitting|choose|choosing|choice|choices|pick|picking|select|selecting|selector|options?|dropdown|picker|between)\b");
    let split_ask = rx(&SPLIT_ASK, r"(?i)\b(?:split|splits|splitting|per[- ]meal|divid\w*|spread)\b");
    let measure = rx(&MEASURE, r"(?i)^(?:lbs?|pounds?|kgs?|kilos?|kilograms?|grams?|g|oz|ounces?|cups?|ml|liters?|litres?|kcal|calories|cal|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|percent|miles?|km|meters?|metres?|feet|ft|inches|dollars?|usd|bpm|reps?|sets?|times|am|pm|of|to|and|or|per|times)$");
    let mut out: Vec<IntentCheck> = Vec::new();
    for c in range.captures_iter(text) {
        let (Ok(lo), Ok(hi)) = (c[1].parse::<u32>(), c[2].parse::<u32>()) else { continue };
        if hi <= lo || hi - lo > 6 || measure.is_match(&c[3]) {
            continue;
        }
        let (n1, noun) = (c.get(1).unwrap(), c.get(3).unwrap());
        let a = floor_boundary(text, n1.start().saturating_sub(40));
        let z = floor_boundary(text, noun.end() + 40);
        let daily = per_day.is_match(&text[noun.end()..z]) && {
            let lower = text.to_ascii_lowercase();
            let sentence = sentences(&lower).into_iter().find(|(s, t)| *s <= n1.start() && noun.end() <= s + t.len()).map(|(_, t)| t.to_string()).unwrap_or_default();
            choice_word.is_match(&sentence) || ((c[3].eq_ignore_ascii_case("meals") || c[3].eq_ignore_ascii_case("meal")) && split_ask.is_match(text))
        };
        if !before.is_match(&text[a..n1.start()]) && !after.is_match(&text[noun.end()..z]) && !daily {
            continue;
        }
        let order: Vec<String> = (lo..=hi).map(|x| x.to_string()).collect();
        if out.iter().any(|o| o.kind == CheckKind::Order(order.clone())) {
            continue;
        }
        let phrase = format!("{}-{} {}", lo, hi, &c[3]);
        out.push(IntentCheck { criterion: format!("The choices for Nic's \"{phrase}\" read {} in ascending order (pinned order: {}; expect_order)", order.join(", "), order.join(", ")), kind: CheckKind::Order(order), value: 0.0, tol: 0.0 });
        if out.len() >= 2 {
            break;
        }
    }
    out
}

// ── Which criteria need a probe ─────────────────────────────────────────────

/// What a requested criterion needs from its probe.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Need {
    /// Behavioural: it counts as met only when a probe for it ran and passed (where probes run).
    pub probe: bool,
    /// Its probe must act (set / select / click) before its first expectation.
    pub action: bool,
    /// An on-load default / initial state / order: its probe must expect BEFORE any action (a
    /// probe that clicks "lb" and then sees "lb" active proves nothing about the default).
    pub fresh: bool,
    /// It computes or converts a value: a probe that only checks a class or a count cannot
    /// prove it.
    pub value: bool,
    /// A pinned intent check: the probe's expectation must be the pinned value.
    pub check: Option<IntentCheck>,
    /// It toggles / switches / converts a unit: its probe must show a change (`shows_change`).
    pub toggle: bool,
    /// The placeholder kinds the criterion itself asks the page to show ("show a dash (—) until
    /// a bill is typed": `Placeholder::Dash`): its probe may expect that text
    /// (`expects_placeholder`); a broken value (NaN, undefined) never.
    pub shows: Vec<Placeholder>,
    /// The criterion itself names a zero outcome ("makes the tip $0.00", "never below 0", "no
    /// tip"): a zero read is what it asks for, so `zero_rule` lets one through when the probe
    /// proves a change on another element (AD-13 round 5, `names_zero`).
    pub zero: bool,
}

/// A kind of placeholder text (`placeholder_kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placeholder {
    /// "Loading...", "Calculating".
    Wait,
    /// "--", "—", "–".
    Dash,
    /// "…", "...".
    Ellipsis,
    /// NaN, undefined, null, [object Object]: never a value to expect.
    Broken,
}

/// The placeholder kinds a criterion names as what the page should show (`Need::shows`). Pure.
pub fn named_placeholders(criterion: &str) -> Vec<Placeholder> {
    static WAIT: OnceLock<regex::Regex> = OnceLock::new();
    static DASH: OnceLock<regex::Regex> = OnceLock::new();
    static DOTS: OnceLock<regex::Regex> = OnceLock::new();
    let mut out = Vec::new();
    if rx(&WAIT, r"(?i)\b(?:loading|calculating)\b").is_match(criterion) {
        out.push(Placeholder::Wait);
    }
    // The mark itself counts only quoted or in brackets ("a dash (—)", "shows '--'"): a dash used
    // as punctuation in the sentence names nothing.
    if rx(&DASH, r#"(?i)\b(?:(?:em|en)[- ]?)?dash(?:es)?\b|\bhyphens?\b|[("'“‘]\s*(?:[—–]+|-{2,})\s*[)"'”’]"#).is_match(criterion) {
        out.push(Placeholder::Dash);
    }
    if rx(&DOTS, r#"(?i)\bellipsis\b|[("'“‘]\s*(?:…|\.{3})\s*[)"'”’]"#).is_match(criterion) {
        out.push(Placeholder::Ellipsis);
    }
    out
}

/// A criterion about behaviour: something that changes, computes, converts, toggles, totals,
/// adds / removes, resets, orders, saves / restores or shows a default — or one carrying one of
/// Nic's literal values. Pure.
pub fn behavioural(criterion: &str, lits: &[Literal]) -> bool {
    behaviour_words(criterion) || computes(criterion) || carries_literal(criterion, lits)
}

fn behaviour_words(criterion: &str) -> bool {
    static B: OnceLock<regex::Regex> = OnceLock::new();
    rx(&B, r"(?i)\b(?:chang(?:e|es|ed|ing)|comput(?:e|es|ed|ing)|calculat(?:e|es|ed|ing|ion|ions)|recalculat\w*|convert(?:s|ed|ing)?|conversions?|toggl(?:e|es|ed|ing)|switch(?:es|ed|ing)?|totals?|totall?ed|totall?ing|sums?|summed|adds?|added|adding|remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|resets?|resetting|clears|cleared|clearing|order(?:s|ed|ing)?|sort(?:s|ed|ing)?|sav(?:e|es|ed|ing)|restor(?:e|es|ed|ing)|persist\w*|remember\w*|defaults?|initial(?:ly)?|on (?:page )?load|updat(?:e|es|ed|ing)|increment\w*|decrement\w*)\b").is_match(criterion)
}

fn carries_literal(criterion: &str, lits: &[Literal]) -> bool {
    let lower = criterion.to_lowercase();
    lits.iter().any(|l| !number_positions(&lower, &l.number).is_empty() || l.low.as_deref().is_some_and(|lo| !number_positions(&lower, lo).is_empty()))
}

/// Does the criterion describe something a person DOES (click, switch to, type, add, save …)?
/// Only verbs and action phrases count: "selected" / "active" are states, and "the toggle" or
/// "the switch" are things ("the lb unit is selected by default", "the lb/kg toggle starts on
/// lb" describe the page on load). Pure.
fn acts(criterion: &str) -> bool {
    static A: OnceLock<regex::Regex> = OnceLock::new();
    static AFTER: OnceLock<regex::Regex> = OnceLock::new();
    let a = rx(&A, r"(?i)\b(?:click\w*|tap(?:s|ped|ping)?|press(?:es|ed|ing)?|switch(?:es|ed|ing)|toggl(?:es|ed|ing)|convert(?:s|ed|ing)?|chang(?:e|es|ed|ing)|enter(?:s|ed|ing)|typ(?:es|ed|ing)|adds?|added|adding|remov\w*|delet\w*|reset(?:s|ting)?|reload\w*|sav(?:e|es|ed|ing)|restor\w*|updat(?:e|es|ed|ing)|recalculat\w*|selecting|picking|choosing|submit\w*|increment\w*|decrement\w*)\b");
    let after = rx(&AFTER, r"(?i)\b(?:after|when|once|upon|then)\s+(?:\w+\s+){0,3}?(?:switch|toggle|select|pick|choose|type|enter|tap|press)\w*");
    a.is_match(criterion) || after.is_match(criterion)
}

/// An "on load / default / initial / order" criterion with no action in it: its probe expects
/// first, before any action. Pure.
fn on_load(criterion: &str) -> bool {
    static L: OnceLock<regex::Regex> = OnceLock::new();
    let l = rx(&L, r"(?i)\b(?:defaults?|initial(?:ly)?|on (?:a |the )?(?:fresh |first |page )?(?:load|open)|when the page (?:loads|opens)|at (?:start(?:up)?|first)|pre-?filled|pre-?selected|starts? (?:at|with|on|as|out)|in (?:the )?(?:\w+ )?order|order|ordered|ascending|descending|sorted|listed)\b");
    l.is_match(criterion) && !acts(criterion)
}

/// It computes or converts a value (a class or a count cannot prove it) — a sum, a tally, a
/// (running) total or what "adds up" too, so a running-tally criterion gets the must-change mark
/// (`must_change`, AD-13 round 4). Pure.
fn computes(criterion: &str) -> bool {
    static C: OnceLock<regex::Regex> = OnceLock::new();
    rx(&C, r"(?i)\b(?:comput\w*|calculat\w*|recalculat\w*|convert\w*|conversions?|divid\w*|multipl\w*|averag\w*|per[- ](?:meal|person|day|serving|head|item)|sums?|summ(?:ed|ing|s)|tall(?:y|ies|ied|ying)|totals?|totall?(?:ed|ing)|(?:adds?|added|adding)\s+up)\b").is_match(criterion)
}

/// The need of one requested criterion (an intent check's comes from `IntentCheck::need`): a
/// behavioural one acts first unless it is an on-load / default / order check, which expects
/// first; one that is behavioural only because it carries Nic's literal ("Shows 165 lb") needs an
/// action only when it names one. Pure.
pub fn need_of(criterion: &str, lits: &[Literal]) -> Need {
    let probe = behavioural(criterion, lits);
    let fresh = probe && on_load(criterion);
    let action = probe && !fresh && (behaviour_words(criterion) || computes(criterion) || acts(criterion));
    let shows = named_placeholders(criterion);
    // A criterion that asks for a placeholder ("the tip and total show a dash (—) on load") is
    // checked by that text, not by a number.
    Need { probe, action, fresh, value: probe && computes(criterion) && shows.is_empty(), check: None, toggle: action && toggles(criterion), shows, zero: names_zero(criterion) }
}

/// A criterion that names a zero outcome: a 0 among its numbers ("$0.00", "never below 0", "back
/// to 0 g"), or zero / none / nothing / no tip / never negative (AD-13 round 5: "Choosing the No
/// tip option makes the tip $0.00", "grams left …, never below 0"). Pure.
fn names_zero(criterion: &str) -> bool {
    static Z: OnceLock<regex::Regex> = OnceLock::new();
    numbers_in(criterion).iter().any(|x| x.abs() < 1e-9) || rx(&Z, r"(?i)\b(?:zero|none|nothing|no[- ]tip|never (?:goes )?(?:below|under|less than|negative))\b").is_match(criterion)
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
    /// The body of any function, named or not (an arrow callback too): its open token.
    body: Option<usize>,
}

/// Does the `{` at token `k` open a function body (named, anonymous or an arrow)?
fn is_fn_body(t: &[Tok], k: usize) -> bool {
    if k == 0 {
        return false;
    }
    if t[k - 1].t == Tk::P(b'A') || fn_name_before(t, k).is_some() {
        return true;
    }
    t[k - 1].t == Tk::P(b')') && open_paren(t, k - 1).is_some_and(|o| (o >= 1 && is_id(&t[o - 1], "function")) || (o >= 2 && is_id(&t[o - 2], "function")))
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
    // The innermost function body (any function) each token is in.
    let mut scope: Vec<Option<usize>> = Vec::with_capacity(n);
    let mut flags: HashSet<String> = HashSet::new();
    let mut uses: Vec<usize> = Vec::new();
    for k in 0..n {
        info.push((stack.iter().any(|f| f.is_try), stack.iter().filter_map(|f| f.fn_id).collect()));
        scope.push(stack.iter().rev().find_map(|f| f.body));
        match &toks[k].t {
            Tk::P(b'{') => {
                let is_try = k > 0 && is_id(&toks[k - 1], "try");
                let fn_id = fn_name_before(&toks, k).map(|nm| {
                    fns.push((nm, k, n));
                    fns.len() - 1
                });
                let body = is_fn_body(&toks, k).then_some(k);
                stack.push(Frame { is_try, fn_id, try_storage: false, body });
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
            // Guarded by a storage-ok flag read in an `if` of the same function: the use sits in
            // that `if`'s branch (or after the flag in its condition), or after `if (!flag) return`.
            let from = scope[k].unwrap_or(0);
            !(from..k).any(|q| scope[q] == scope[k] && flag_if_guards(&toks, &flags, q, k))
        })
        .map(|k| toks[k].pos)
        .collect()
}

/// The token closing the bracket opened at `open` (`(`/`[`/`{`), if any.
fn close_of(t: &[Tok], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (j, tok) in t.iter().enumerate().skip(open) {
        match tok.t {
            Tk::P(b'(') | Tk::P(b'[') | Tk::P(b'{') => depth += 1,
            Tk::P(b')') | Tk::P(b']') | Tk::P(b'}') => {
                depth -= 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            _ => {}
        }
    }
    None
}

/// The last token of the statement starting at `s`: a `{ … }` block, else up to the first `;`
/// (or the enclosing block's `}`) at depth 0.
fn statement_end(t: &[Tok], s: usize) -> usize {
    if t.get(s).map(|x| &x.t) == Some(&Tk::P(b'{')) {
        return close_of(t, s).unwrap_or(t.len().saturating_sub(1));
    }
    let mut depth = 0i32;
    for (j, tok) in t.iter().enumerate().skip(s) {
        match tok.t {
            Tk::P(b'(') | Tk::P(b'[') | Tk::P(b'{') => depth += 1,
            Tk::P(b')') | Tk::P(b']') | Tk::P(b'}') => {
                if depth == 0 {
                    return j.saturating_sub(1);
                }
                depth -= 1;
            }
            Tk::P(b';') if depth == 0 => return j,
            _ => {}
        }
    }
    t.len().saturating_sub(1)
}

/// Does the `if` at token `q` guard the storage use at token `k` with a storage-ok flag? Yes when
/// its condition reads a flag (`if (ok)` / `if (storageOk())`) and `k` is inside its branch or
/// after that flag inside the condition itself (`if (ok && localStorage…)`), or when the
/// condition is a negated flag whose branch returns (`if (!ok) return;`) and `k` comes after it.
/// Any other earlier mention of the flag guards nothing.
fn flag_if_guards(t: &[Tok], flags: &HashSet<String>, q: usize, k: usize) -> bool {
    if !is_id(&t[q], "if") || t.get(q + 1).map(|x| &x.t) != Some(&Tk::P(b'(')) {
        return false;
    }
    let Some(close) = close_of(t, q + 1) else { return false };
    let reads = |lo: usize, hi: usize| -> (bool, bool) {
        let (mut pos, mut neg) = (false, false);
        for c in lo..hi {
            if matches!(&t[c].t, Tk::Id(w) if flags.contains(w)) && t.get(c + 1).map(|x| &x.t) != Some(&Tk::P(b'=')) {
                if c > 0 && t[c - 1].t == Tk::P(b'!') {
                    neg = true;
                } else {
                    pos = true;
                }
            }
        }
        (pos, neg)
    };
    if k < close {
        return k > q + 1 && reads(q + 2, k).0;
    }
    let (pos, neg) = reads(q + 2, close);
    let end = statement_end(t, close + 1);
    if pos && k <= end {
        return true;
    }
    let returns = is_id(&t[close + 1], "return") || (t[close + 1].t == Tk::P(b'{') && t.get(close + 2).is_some_and(|x| is_id(x, "return")));
    neg && returns && k > end
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
/// then the markup with the scripts pulled out and CSS bodies dropped. The markup's middle is cut
/// first, the scripts' middle only when the scripts alone do not fit; `.1` = anything was cut
/// (a criterion whose code was cut may then be "not shown" rather than unmet). Pure.
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
        // The scripts whole, the markup's middle cut when it does not fit: that is a cut too (the
        // omitted markup can hold the very buttons a criterion is about).
        let m = cut_middle(&markup, room - len(&js));
        let cut = m != markup;
        return (format!("{head}{js}{mid}{m}"), cut);
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
    /// What `enforce` changed in the probe (a pinned value substituted), for the record.
    pub note: Option<String>,
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
            note: None,
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

/// The acceptance criteria verify reads (`taskworker::verify_plan`); `MAX_CHECKS` intent checks
/// are added after them.
pub const MAX_CRITERIA: usize = 10;

/// The verifier's new probes run per verify pass (required ones first, the pinned intent checks
/// first among them), the failed ones carried from an earlier pass, and steps per probe. Every
/// criterion verify reads can need one, so the cap never cuts a required probe; the whole run
/// stays bounded by its total time cap (`run_probes`), probes past it are "not run".
pub const MAX_PROBES: usize = MAX_CRITERIA + MAX_CHECKS;
pub const MAX_CARRIED: usize = 6;
pub const MAX_STEPS: usize = 8;

/// One validated probe for one answer (index into `Answers::list`).
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub answer: usize,
    pub criterion: String,
    pub steps: Vec<Value>,
    /// Carried over from an earlier verify where it failed (`open_probes`): re-run whatever the
    /// verifier writes this time.
    pub carried: bool,
    /// Its criterion acts and computes a value (`Need::action && Need::value`): the harness
    /// records what each read after the first action showed before it, and a probe whose every
    /// passing read still shows that is a failure, "nothing changed after …" (P1-3 c).
    pub change: bool,
}

/// Does this criterion's probe have to show a change (`Probe::change`)? Pure.
fn must_change(need: Option<&Need>) -> bool {
    need.is_some_and(|n| n.action && n.value)
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

/// A number from a JSON number or a numeric string ("74.8", " 74.8 kg", "1,200"). Pure.
fn finite(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(lead_number)).filter(|x| x.is_finite() && x.abs() < 1e12)
}

/// The number a string leads with (a currency sign and thousands commas allowed). Pure.
fn lead_number(s: &str) -> Option<f64> {
    static N: OnceLock<regex::Regex> = OnceLock::new();
    let c = rx(&N, r"^\s*[$€£]?\s*(-?\d[\d,]*(?:\.\d+)?)").captures(s)?;
    c[1].replace(',', "").parse().ok()
}

/// Every number in a string, as the harness reads them (`nums` in PROBE_JS): a dash after a digit
/// or a letter is a range dash, not a sign ("132-165 g" is 132 and 165); thousands groups are
/// one number ("1,200"), a lone 1-2 digit comma fraction is a decimal comma ("74,8"). At most 6.
/// Pure.
pub fn numbers_in(s: &str) -> Vec<f64> {
    static N: OnceLock<regex::Regex> = OnceLock::new();
    static THOUSANDS: OnceLock<regex::Regex> = OnceLock::new();
    static DECIMAL_COMMA: OnceLock<regex::Regex> = OnceLock::new();
    let b = s.as_bytes();
    let mut out = Vec::new();
    for m in rx(&N, r"\d[\d,]*(?:\.\d+)?").find_iter(s) {
        let neg = m.start() >= 1 && b[m.start() - 1] == b'-' && !(m.start() >= 2 && (b[m.start() - 2].is_ascii_alphanumeric() || b[m.start() - 2] == b')'));
        let sign = if neg { -1.0 } else { 1.0 };
        let t = m.as_str().trim_end_matches(',');
        if rx(&THOUSANDS, r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$").is_match(t) {
            out.extend(t.replace(',', "").parse::<f64>().ok().map(|x| sign * x));
        } else if rx(&DECIMAL_COMMA, r"^\d+,\d{1,2}$").is_match(t) {
            out.extend(t.replace(',', ".").parse::<f64>().ok().map(|x| sign * x));
        } else {
            for (i, part) in t.split(',').enumerate() {
                let sg = if i == 0 { sign } else { 1.0 };
                out.extend(part.parse::<f64>().ok().map(|x| sg * x));
            }
        }
    }
    out.retain(|x| x.is_finite() && x.abs() < 1e12);
    out.truncate(6);
    out
}

/// The tolerance a number written as exact text ("26 g" in `equals`, "132 - 165 g" in
/// `contains`) is matched with: two decimals.
const EXACT_TOL: f64 = 0.005;

/// The default tolerance for an `approx` without one: 1 % of the largest number, at least 0.5.
fn approx_tol(ns: &[f64]) -> f64 {
    (ns.iter().fold(0.0f64, |m, x| m.max(x.abs())) * 0.01).max(0.5)
}

/// A `contains` that is a number, optionally with a currency sign and a unit word ("40 g",
/// "$39.33 per person", "3 meals"): (sign, number, unit). The harness then matches the number as
/// a whole number token ("0" never matches "40 g"). Pure.
fn numeric_contains(c: &str) -> Option<(String, String, String)> {
    static N: OnceLock<regex::Regex> = OnceLock::new();
    let m = rx(&N, r"(?i)^\s*([$€£]?)\s*(-?\d+(?:[.,]\d+)*)\s*((?:[a-z%°/]{1,12})(?:\s[a-z]{1,12})?)?\s*$").captures(c)?;
    Some((m[1].to_string(), m[2].to_string(), m.get(3).map(|u| u.as_str().to_lowercase()).unwrap_or_default()))
}

/// A step's field under any name a small model uses for it.
fn field<'a>(st: &'a Value, names: &[&str]) -> &'a Value {
    names.iter().map(|k| &st[*k]).find(|v| !v.is_null()).unwrap_or(&Value::Null)
}

/// The op a small model meant: "fill" / "type" / "input" → set, "choose" → select, "press" /
/// "tap" → click, "assert_text" / "expect" → expect_text. Pure.
fn op_alias(op: &str) -> String {
    let op = op.trim().to_lowercase().replace(['-', ' '], "_");
    match op.as_str() {
        "fill" | "type" | "input" | "enter" | "set_value" | "type_text" => "set",
        "choose" | "select_option" => "select",
        "press" | "tap" => "click",
        "assert_text" | "expect" | "assert" | "check_text" => "expect_text",
        "assert_value" | "check_value" => "expect_value",
        "refresh" => "reload",
        _ => return op,
    }
    .to_string()
}

/// A step's op under any key a small model uses for it: the first one holding a string
/// (`{"step": 1, "type": "click"}` is a click, not op 1). Pure.
fn op_field(st: &Value) -> &str {
    ["op", "action", "step", "type"].iter().filter_map(|k| st[*k].as_str()).map(str::trim).find(|s| !s.is_empty()).unwrap_or("")
}

/// Validate one probe from the model (untrusted): known ops only, a safe selector charset,
/// capped strings and numbers, at most `MAX_STEPS` steps, and at least one expectation. Common
/// small-model variations are NORMALISED, not rejected (keys "action" / "type" / "step" → op,
/// "selector" / "target" / "css" → sel, "text" / "val" → value, op aliases, numeric strings, a
/// single step given as an object, the list given as a JSON string, and wait / sleep / pause
/// steps, which are dropped: the harness already settles after actions and polls expectations).
/// Returns the normalised steps the harness runs. Pure.
pub fn parse_probe(v: &Value) -> Result<Vec<Value>, String> {
    if let Some(s) = v.as_str() {
        let s = s.trim();
        if s.len() > 8000 {
            return Err("the probe is too long".into());
        }
        let inner: Value = serde_json::from_str(s).map_err(|_| "the probe is not a list of steps".to_string())?;
        if inner.is_string() {
            return Err("the probe is not a list of steps".into());
        }
        return parse_probe(&inner);
    }
    let single;
    let steps = match v.as_array().or_else(|| v["steps"].as_array()) {
        Some(a) => a,
        None if v.is_object() && !op_field(v).is_empty() => {
            single = vec![v.clone()];
            &single
        }
        None => return Err("the probe is not a list of steps".into()),
    };
    let waits = |st: &Value| matches!(op_alias(op_field(st)).as_str(), "wait" | "sleep" | "pause" | "delay" | "wait_for" | "settle");
    if steps.len() > MAX_STEPS * 2 {
        return Err(format!("the probe has {} steps (at most {MAX_STEPS})", steps.len()));
    }
    let real = steps.iter().filter(|s| !waits(s)).count();
    if real == 0 {
        return Err("the probe has no steps".into());
    }
    if real > MAX_STEPS {
        return Err(format!("the probe has {real} steps (at most {MAX_STEPS})"));
    }
    let mut out = Vec::new();
    for (i, st) in steps.iter().enumerate() {
        if waits(st) {
            continue;
        }
        let op = op_alias(op_field(st));
        let n = i + 1;
        let sel = field(st, &["sel", "selector", "target", "css"]).as_str().unwrap_or("").trim().to_string();
        let need_sel = |s: &str| if sel_ok(s) { Ok(()) } else { Err(format!("step {n}: unusable selector {:?}", clip_chars(s, 40))) };
        let nth = st["nth"].as_u64().or_else(|| st["nth"].as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0).min(50);
        let text = |names: &[&str], max: usize| str_or_num(field(st, names)).map(|s| s.chars().take(max).collect::<String>());
        let norm_step = match op.as_str() {
            "set" | "select" => {
                need_sel(&sel)?;
                let value = text(&["value", "text", "val"], 200).ok_or(format!("step {n}: {op} needs a value"))?;
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
                let tol_given = finite(&st["tol"]).map(f64::abs);
                // Several numbers in one expectation ("132 - 165 g"): ALL of them must show
                // (number-aware: "132-165g" on the page passes); one → approx that number.
                let numeric = |s: &mut Value, ns: &[f64], tol: f64| {
                    if ns.len() == 1 {
                        s["approx"] = json!(ns[0]);
                    } else {
                        s["all"] = json!(ns);
                    }
                    s["tol"] = json!(tol);
                };
                // A text expectation: a number with its sign / unit stays a whole-number token
                // match ("40 g", "$39.33"); several numbers become all-of; other text a substring.
                let contains = |s: &mut Value, c: &str| {
                    let ns = numbers_in(c);
                    if ns.len() >= 2 {
                        numeric(s, &ns, tol_given.unwrap_or(EXACT_TOL));
                    } else {
                        if let Some((pre, num, unit)) = numeric_contains(c) {
                            s["num"] = json!({ "pre": pre, "n": num, "unit": unit });
                        }
                        s["contains"] = json!(c);
                    }
                };
                // A bare expected value ("value" / "text" / "expected"): a number → approx, else contains.
                let bare = field(st, &["value", "text", "val", "expected"]);
                let bare_num = str_or_num(bare).filter(|b| numeric_contains(b).is_some_and(|(_, _, u)| u.is_empty())).and_then(|_| finite(bare));
                if let Some(c) = text(&["contains"], 200).filter(|c| !c.trim().is_empty()) {
                    contains(&mut s, &c);
                } else if let Some(c) = text(&["equals"], 200) {
                    // "26 g" / "26g" / "26": the number, not the exact spelling.
                    match numbers_in(&c) {
                        ns if !ns.is_empty() => numeric(&mut s, &ns, tol_given.unwrap_or(EXACT_TOL)),
                        _ => s["equals"] = json!(c),
                    }
                } else if let Some(all) = st["all"].as_array().filter(|a| !a.is_empty()) {
                    // The all-of form itself (a carried probe is validated again).
                    let ns: Vec<f64> = all.iter().filter_map(finite).take(6).collect();
                    if ns.len() != all.len().min(6) {
                        return Err(format!("step {n}: {op} \"all\" needs numbers"));
                    }
                    numeric(&mut s, &ns, tol_given.unwrap_or_else(|| approx_tol(&ns)));
                } else if let Some(a) = st["approx"].as_f64().filter(|x| x.is_finite() && x.abs() < 1e12) {
                    s["approx"] = json!(a);
                    s["tol"] = json!(tol_given.unwrap_or_else(|| approx_tol(&[a])));
                } else if let Some(a) = st["approx"].as_str() {
                    // The 9B writes "approx" as text: "132 - 165 g", "26 g", "~74.8".
                    let ns = numbers_in(a);
                    if ns.is_empty() {
                        return Err(format!("step {n}: {op} \"approx\" needs a number"));
                    }
                    numeric(&mut s, &ns, tol_given.unwrap_or_else(|| approx_tol(&ns)));
                } else if let Some(a) = bare_num {
                    s["approx"] = json!(a);
                    s["tol"] = json!(tol_given.unwrap_or_else(|| approx_tol(&[a])));
                } else if let Some(c) = text(&["value", "text", "val", "expected"], 200).filter(|c| !c.trim().is_empty()) {
                    contains(&mut s, &c);
                } else {
                    return Err(format!("step {n}: {op} needs contains, equals or approx"));
                }
                s
            }
            "expect_unit" => {
                // Nic's default unit selected on the unit control (written by `pin`, or carried):
                // unit keys only, never free text (they become regexes in the harness).
                need_sel(&sel)?;
                let unit = st["unit"].as_str().unwrap_or("");
                let other = st["other"].as_str().unwrap_or("");
                if !UNIT_KEYS.contains(&unit) || pair_of(unit) != Some(other) {
                    return Err(format!("step {n}: expect_unit needs a unit pair"));
                }
                json!({ "op": op, "sel": sel, "unit": unit, "other": other })
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

/// The valid probes to run (at most `MAX_PROBES`): the pinned intent checks' first, then the
/// other behavioural criteria's (`needs`, indexed by requested criterion), then the rest, each
/// group in answer order. Pure.
pub fn probes_of(answers: &Answers, needs: &[Need]) -> Vec<Probe> {
    let mut v: Vec<((bool, bool), Probe)> = answers
        .list
        .iter()
        .enumerate()
        .filter_map(|(i, a)| match &a.probe {
            Some(Ok(steps)) => {
                let need = a.idx.and_then(|x| needs.get(x));
                let rank = (!need.is_some_and(|n| n.probe), !need.is_some_and(|n| n.check.is_some()));
                Some((rank, Probe { answer: i, criterion: a.name.clone(), steps: steps.clone(), carried: false, change: must_change(need) }))
            }
            _ => None,
        })
        .collect();
    v.sort_by_key(|(rank, p)| (*rank, p.answer));
    v.into_iter().map(|(_, p)| p).take(MAX_PROBES).collect()
}

fn is_action(st: &Value) -> bool {
    matches!(st["op"].as_str(), Some("set" | "select" | "click"))
}

fn is_read(st: &Value) -> bool {
    matches!(st["op"].as_str(), Some("expect_text" | "expect_value"))
}

/// A selector that reads the whole page (`body`, `html`, `main`, `:root`, `*`): "any number
/// somewhere on the page" proves nothing about one value (AD-13). Pure.
pub fn weak_sel(sel: &str) -> bool {
    sel.split(',').all(|part| {
        let last = part.trim().rsplit([' ', '>', '~', '+']).next().unwrap_or("").trim().to_ascii_lowercase();
        matches!(last.as_str(), "" | "body" | "html" | "main" | ":root" | "*")
    })
}

/// The numbers an expect_text / expect_value step expects (approx, all-of, else the numbers in
/// its contains / equals). Pure.
fn expected_numbers(st: &Value) -> Vec<f64> {
    if let Some(a) = st["approx"].as_f64() {
        return vec![a];
    }
    if let Some(all) = st["all"].as_array() {
        return all.iter().filter_map(Value::as_f64).collect();
    }
    st["contains"].as_str().or_else(|| st["equals"].as_str()).map(numbers_in).unwrap_or_default()
}

/// The single number a read expects (a read expecting several — a range — is never the one a
/// pinned value is held to: it reads another element). Pure.
fn single_number(st: &Value) -> Option<f64> {
    let n = expected_numbers(st);
    (n.len() == 1).then(|| n[0])
}

/// The step expecting the pinned number, rewritten to the pinned value and its tolerance.
fn pinned_step(st: &Value, c: &IntentCheck) -> Value {
    let mut s = json!({ "op": st["op"], "sel": st["sel"], "nth": st["nth"] });
    s["approx"] = json!((c.value * 100.0).round() / 100.0);
    s["tol"] = json!(c.tol);
    s
}

/// A selector or value split into lowercase words ("#lbBtn" → "lb btn", "kg-toggle" → "kg
/// toggle"). Pure.
fn words_of(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut prev_lower = false;
    for ch in s.chars() {
        if ch.is_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        if ch.is_alphanumeric() || ch == '°' {
            out.extend(ch.to_lowercase());
        } else {
            out.push(' ');
        }
    }
    out
}

/// The unit key an action names in its selector or value ("click #kg-toggle" → kg, "select
/// #unit=lbs" → lb), by the unambiguous spellings only. Pure.
fn action_unit(st: &Value) -> Option<&'static str> {
    let text = format!(" {} {} ", words_of(st["sel"].as_str().unwrap_or("")), words_of(st["value"].as_str().unwrap_or("")));
    UNIT_KEYS.iter().copied().find(|k| regex::Regex::new(&format!(r"[^a-z°](?:{})[^a-z]", unit_spellings(k).1)).is_ok_and(|r| r.is_match(&text)))
}

/// A read of the converted quantity itself: a selector naming weight, mass or a unit of the pair
/// ("#weight", "#weightDisplay", "#kgValue"), or an input read (`expect_value`) of an element not
/// named as an output (target / total / result …). Pure.
fn quantity_sel(st: &Value, from: &str, to: &str) -> bool {
    static OUT: OnceLock<regex::Regex> = OnceLock::new();
    static QTY: OnceLock<regex::Regex> = OnceLock::new();
    let w = format!(" {} ", words_of(st["sel"].as_str().unwrap_or("")));
    let output = rx(&OUT, r"\s(?:targets?|totals?|results?|displays?|outputs?|summary|amounts?|tally|protein|per|meals?|goal|range|max|min)\s").is_match(&w);
    let qty = rx(&QTY, r"\s(?:weight|wt|mass|body|units?|value|converted)\s").is_match(&w)
        || regex::Regex::new(&format!(r"\s(?:{}|{})\s", unit_spellings(from).0, unit_spellings(to).0)).is_ok_and(|r| r.is_match(&w));
    qty || (!output && st["op"] == "expect_value")
}

/// A control that switches between two states: its selector names a toggle, a switch, a unit, a
/// mode or a unit of a pair ("#unitToggle", "#kg", ".mode-switch"), or its value is on / off. A
/// "+" stepper or an "Add" button clicked twice is not one. Pure.
fn toggle_like(st: &Value) -> bool {
    static T: OnceLock<regex::Regex> = OnceLock::new();
    let t = rx(&T, r"(?:^|\s)(?:toggles?|switch(?:es)?|units?|modes?|system|flip|on|off)(?:\s|$)");
    action_unit(st).is_some() || t.is_match(&words_of(st["sel"].as_str().unwrap_or(""))) || t.is_match(&words_of(st["value"].as_str().unwrap_or("")))
}

/// Do these steps (the ones before a read) switch something and then switch it back, with
/// nothing typed in between? Yes when one toggle-like control (`toggle_like`) is clicked an even
/// number of times, or the last unit-naming action names `home` (Nic's starting unit) after
/// another of its pair was chosen — or, with no known home unit, names the other unit of the
/// pair the first one named. A `set` between the two switches makes it a real conversion ("kg,
/// type 80, back to lb, expect 176.37"), not a round trip. The reason, or None. Pure.
fn round_trip(steps: &[Value], home: Option<&str>) -> Option<String> {
    let set_between = |a: usize, b: usize| a < b && steps[a + 1..b].iter().any(|s| s["op"] == "set");
    let mut clicks: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, a) in steps.iter().enumerate().filter(|(_, a)| a["op"] == "click" && toggle_like(a)) {
        let key = at(a);
        match clicks.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(i),
            None => clicks.push((key, vec![i])),
        }
    }
    if let Some((k, v)) = clicks.iter().find(|(_, v)| v.len() >= 2 && v.len() % 2 == 0 && !set_between(v[0], v[v.len() - 1])) {
        return Some(format!("it clicks {k} {} times, which switches it back", v.len()));
    }
    let units: Vec<(usize, &'static str)> = steps.iter().enumerate().filter(|(_, a)| is_action(a)).filter_map(|(i, a)| action_unit(a).map(|u| (i, u))).collect();
    let (Some(&(_, first)), Some(&(li, last))) = (units.first(), units.last()) else { return None };
    let back = match home {
        Some(h) => last == h && units.iter().any(|(_, u)| pair_of(u) == Some(h)),
        None => pair_of(first) == Some(last),
    };
    let (ai, away) = units.iter().copied().find(|(_, u)| *u != last).unwrap_or((li, first));
    (back && !set_between(ai, li)).then(|| format!("it switches to {} and back to {} before it reads", unit_label(away), unit_label(last)))
}

/// Hold a probe for an intent check to Nic's pinned value: the expectation is the value computed
/// here (the model only supplies selectors and actions). Correct, don't reject (AD-13): an Order
/// probe always gets the pinned list; a Convert probe whose single-number read follows the switch
/// gets the pinned number in its place when it reads the weight element (`quantity_sel`, or one of
/// `known`, the elements the Default probe read on load) and expected the starting value or a
/// wrong factor; a round trip is still rejected. A Unit probe's step on the unit control (not a
/// number read) becomes `expect_unit`. A Default read
/// must expect the pinned number (another number may be another element). The step held is chosen
/// by its number, not its position: extra reads and a return toggle after the converted value are
/// kept as the model wrote them. Reads of the whole page (`weak_sel`) never count. Returns the
/// steps and a note when a value was substituted. Pure.
fn pin(steps: &[Value], c: &IntentCheck, known: &[String]) -> Result<(Vec<Value>, Option<String>), String> {
    let v = c.pinned();
    let mut out = steps.to_vec();
    let near = |x: f64| (x - c.value).abs() <= c.tol;
    let specific_read = |i: usize| is_read(&steps[i]) && !weak_sel(steps[i]["sel"].as_str().unwrap_or(""));
    // (index, number) of every specific read that expects ONE number, in [from, to).
    let numeric = |from: usize, to: usize| -> Vec<(usize, f64)> { (from..to).filter(|&i| specific_read(i)).filter_map(|i| single_number(&steps[i]).map(|x| (i, x))).collect() };
    let weak_only = |from: usize, to: usize| (from..to).any(|i| is_read(&steps[i])) && !(from..to).any(specific_read);
    let whole_page = format!("read it from the element that shows it, not the whole page (body / html / main): use the pinned value {v}");
    let first_action = steps.iter().position(is_action).unwrap_or(steps.len());
    match &c.kind {
        CheckKind::Default => {
            if !steps[..first_action].iter().any(is_read) {
                return Err(if first_action < steps.len() {
                    format!("check Nic's default on a fresh load, before any set / select / click (pinned value {v})")
                } else {
                    format!("expect Nic's default on the element that shows it (expect_value / expect_text, \"approx\": {v})")
                });
            }
            let reads = numeric(0, first_action);
            match reads.iter().find(|(_, x)| near(*x)).or(reads.first()) {
                Some(&(k, x)) if near(x) => out[k] = pinned_step(&steps[k], c),
                Some(&(_, x)) => return Err(format!("it expects {}, but Nic's value is pinned: use the pinned value {v}", fmt_num(x))),
                None if weak_only(0, first_action) => return Err(whole_page),
                None => return Err(format!("expect a number: use the pinned value {v} (\"approx\": {v})")),
            }
            Ok((out, None))
        }
        CheckKind::Convert { from, to, start } => {
            if first_action >= steps.len() || !steps[first_action..].iter().any(is_read) {
                return Err(if steps.iter().any(is_action) || !steps.iter().any(is_read) {
                    format!("after switching to {}, expect the converted value (\"approx\": {v})", unit_label(to))
                } else {
                    format!("switch the unit to {} first (click / select its control), then expect the converted value {v}", unit_label(to))
                });
            }
            let reads = numeric(first_action + 1, steps.len());
            // The read holding the converted value: one that already expects it; else one that
            // expected the starting value (it read the right element; the page or the model never
            // converted) or a plausible wrong factor (within 25 % of the pinned number).
            // Substituted only on the element that shows the converted quantity (the weight input,
            // a unit-named element, or the one the Default probe read on load): with Nic's own
            // numbers a target's upper bound can equal his weight (165 g at 1 g/lb), and that read
            // must not become a 74.84 probe on a correct page.
            let plausible = |x: f64| (x - start).abs() <= (start.abs() * 0.006).max(0.5) || (x - c.value).abs() <= c.value.abs() * 0.25;
            let read_before = |i: usize| steps[..first_action].iter().any(|s| is_read(s) && at(s) == at(&steps[i]));
            let holds_it = |i: usize| known.contains(&at(&steps[i])) || read_before(i) || quantity_sel(&steps[i], from, to);
            let Some(&(k, x)) = reads.iter().find(|(_, x)| near(*x)).or_else(|| reads.iter().find(|(i, x)| plausible(*x) && holds_it(*i))) else {
                return Err(match reads.first() {
                    Some(&(_, x)) => format!("it expects {}, but the converted value is pinned: use the pinned value {v}", fmt_num(x)),
                    None if weak_only(first_action + 1, steps.len()) => whole_page,
                    None => format!("expect a number: use the pinned value {v} (\"approx\": {v})"),
                });
            };
            if let Some(why) = round_trip(&steps[..k], Some(from)) {
                return Err(format!("{why} (a round trip proves nothing): switch to {} once and use the pinned value {v}", unit_label(to)));
            }
            out[k] = pinned_step(&steps[k], c);
            let note = (!near(x)).then(|| format!("pinned value substituted: the probe expected {}, the pinned value {v} was put in its place", fmt_num(x)));
            Ok((out, note))
        }
        CheckKind::Order(want) => {
            let k = steps.iter().position(|s| s["op"] == "expect_order").ok_or(format!("use expect_order with the pinned order {v}"))?;
            let got: Vec<Option<f64>> = steps[k]["order"].as_array().map(|a| a.iter().map(|x| x.as_str().and_then(lead_number)).collect()).unwrap_or_default();
            let want_n: Vec<Option<f64>> = want.iter().map(|w| lead_number(w)).collect();
            let said = steps[k]["order"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            out[k]["order"] = json!(want);
            let note = (got != want_n).then(|| format!("pinned value substituted: the probe expected the order {said}, the pinned order {v} was put in its place"));
            Ok((out, note))
        }
        CheckKind::Unit { unit, other } => {
            // The step on the unit control: one whose selector or expected value names a unit of
            // the pair (or "unit"), else one that does not expect a number (a class, a label),
            // else the first — never a read of the number input when a unit step is there.
            let cands: Vec<usize> = (0..first_action).filter(|&i| is_expect(&steps[i]) && steps[i]["sel"].as_str().is_some_and(|x| !weak_sel(x))).collect();
            let number_read = |i: usize| is_read(&steps[i]) && !expected_numbers(&steps[i]).is_empty();
            let k = cands.iter().copied().find(|&i| names_unit(&steps[i], unit, other)).or_else(|| cands.iter().copied().find(|&i| !number_read(i))).or(cands.first().copied()).ok_or_else(|| {
                if first_action < steps.len() {
                    format!("check the unit control on a fresh load, before any set / select / click (pinned unit {v})")
                } else {
                    format!("expect on the unit control (its select, radio group or unit buttons): it is held to the pinned unit {v}")
                }
            })?;
            out[k] = json!({ "op": "expect_unit", "sel": steps[k]["sel"], "unit": unit, "other": other });
            Ok((out, None))
        }
    }
}

/// Does a step's selector or expected value name a unit of the pair, or the unit control itself
/// ("#lbBtn", ".unit-btn", "#unitSystem", contains "kg")? Pure.
fn names_unit(st: &Value, unit: &str, other: &str) -> bool {
    let text = format!(
        " {} {} {} {} {} ",
        words_of(st["sel"].as_str().unwrap_or("")),
        words_of(st["value"].as_str().unwrap_or("")),
        words_of(st["cls"].as_str().or_else(|| st["class"].as_str()).unwrap_or("")),
        words_of(st["contains"].as_str().unwrap_or("")),
        words_of(st["equals"].as_str().unwrap_or(""))
    );
    let pat = format!(r"[^a-z°](?:units?|system|{}|{})[^a-z]", unit_spellings(unit).0, unit_spellings(other).0);
    regex::Regex::new(&pat).is_ok_and(|r| r.is_match(&text))
}

fn is_expect(st: &Value) -> bool {
    st["op"].as_str().is_some_and(|o| o.starts_with("expect_"))
}

/// The index of the probe's first action (set / select / click). Pure.
fn first_action(steps: &[Value]) -> Option<usize> {
    steps.iter().position(is_action)
}

/// Does the probe read a value (text, a value, an order), not only a class or a count? Pure.
fn reads_value(steps: &[Value]) -> bool {
    steps.iter().any(|s| is_read(s) || s["op"] == "expect_order")
}

/// A read of a NUMBER from an element of its own: `approx`, all-of, or a number-aware `contains`
/// ("40 g"). A text `contains` ("Loading", "kg") is not one. Pure.
fn numeric_read(st: &Value) -> bool {
    is_read(st) && !weak_sel(st["sel"].as_str().unwrap_or("")) && (st["approx"].is_number() || st["all"].is_array() || st["num"].is_object())
}

/// A read of a form control rather than of what the page computed: a selector some action of
/// the probe sets / selects / clicks, or one that names an input / select ("#weightInput",
/// "#activitySelect", "input[type=number]"; its last compound only). `expect_value` alone says
/// nothing: the 9B uses it on output elements too. Pure.
fn control_read(st: &Value, steps: &[Value]) -> bool {
    static CTRL: OnceLock<regex::Regex> = OnceLock::new();
    if !is_read(st) {
        return false;
    }
    let sel = st["sel"].as_str().unwrap_or("").trim();
    let last = sel.rsplit([' ', '>', '+', '~']).next().unwrap_or(sel);
    steps.iter().any(|a| is_action(a) && a["sel"].as_str().is_some_and(|s| s.trim() == sel)) || rx(&CTRL, r"(?i)^(?:input|select|textarea)\b|input|select(?:or)?$|dropdown|slider|picker").is_match(last)
}

/// A value criterion (computes / converts) is decided by a number read from the element that
/// shows it, among its deciding reads (P1-3 a): a text `contains`, a class, a count or an order
/// cannot prove a computation. Pure.
fn value_rule(deciding: &[Value]) -> Result<(), String> {
    if deciding.iter().any(numeric_read) {
        return Ok(());
    }
    let specific_text = deciding.iter().any(|s| is_read(s) && !weak_sel(s["sel"].as_str().unwrap_or("")));
    Err(if specific_text {
        "it expects text, not the computed number: expect the number itself (\"approx\": the value you computed) on the element that shows it".to_string()
    } else if deciding.iter().any(is_read) {
        "it reads the value from the whole page (body / html / main): expect the element that shows the computed number".to_string()
    } else if reads_value(deciding) {
        "it only checks an order: expect the computed value itself (expect_text / expect_value with the number)".to_string()
    } else {
        "it only checks a class or a count: expect the computed value itself (expect_text / expect_value with the number)".to_string()
    })
}

/// Text a page shows while it has not rendered, or when it computed from missing data: never a
/// value to expect ("Loading...", "Calculating", "NaN", "undefined", "null", "--", "…",
/// "[object Object]") unless its criterion asks for it (`Need::shows`). Which kind, if any. Pure.
pub fn placeholder_kind(s: &str) -> Option<Placeholder> {
    static WAIT: OnceLock<regex::Regex> = OnceLock::new();
    static BROKEN: OnceLock<regex::Regex> = OnceLock::new();
    static DASH: OnceLock<regex::Regex> = OnceLock::new();
    let t = s.trim();
    if rx(&BROKEN, r"(?:^|[^\w])(?:NaN|undefined|null|\[object Object\])(?:[^\w]|$)").is_match(t) {
        Some(Placeholder::Broken)
    } else if rx(&WAIT, r"(?i)^(?:[^:]{0,30}:\s*)?(?:loading|calculating)\b").is_match(t) {
        Some(Placeholder::Wait)
    } else if rx(&DASH, r"(?i)^(?:-{2,}|[–—]+|…|\.{3})\s*[a-z%]{0,6}$").is_match(t) {
        Some(if t.starts_with(['…', '.']) { Placeholder::Ellipsis } else { Placeholder::Dash })
    } else {
        None
    }
}

/// The first expectation that expects a placeholder (`placeholder_kind`) its criterion does not
/// ask for (`Need::shows`: "show a dash (—) until a bill is typed" may expect "—"; NaN or
/// undefined never): the reason, or None (P1-3 b). Pure.
fn expects_placeholder(steps: &[Value], shows: &[Placeholder]) -> Option<String> {
    steps.iter().filter(|s| is_read(s)).find_map(|s| {
        let said = s["contains"].as_str().or_else(|| s["equals"].as_str())?;
        let kind = placeholder_kind(said)?;
        (kind == Placeholder::Broken || !shows.contains(&kind)).then(|| format!("it expects \"{}\" on {}, a placeholder a broken page shows: expect the real value Nic should see", clip_chars(said.trim(), 30), at(s)))
    })
}

/// An action that asks for a zero: a reset / clear / remove / undo control, a "none" or 0 option
/// ("#resetTally", "#tip-0", "#tipNone", `button[data-pct="0"]`, select "none", "0%" or "0.00",
/// set "0"). Pure.
fn zeroing(st: &Value) -> bool {
    static Z: OnceLock<regex::Regex> = OnceLock::new();
    static CAMEL: OnceLock<regex::Regex> = OnceLock::new();
    static ATTR: OnceLock<regex::Regex> = OnceLock::new();
    let z = rx(&Z, r"(?i)reset|clear|remov|delet|undo|\bnone\b|zero|no[-_ ]?tip|(?:^|[^0-9.])0$|[-_]0(?:[^0-9.]|$)");
    // "#tipNone" (no word boundary before a camel-case None) and an attribute selector whose value
    // is 0 ("[data-pct='0']", "[value=0]", "[data-tip=\"0.00\"]"): AD-13 round 5.
    let camel = rx(&CAMEL, r"[a-z0-9]None(?:[^a-z]|$)");
    let attr = rx(&ATTR, r#"=\s*["']?\s*0(?:\.0+)?\s*%?\s*["']?\s*\]"#);
    let sel = st["sel"].as_str().unwrap_or("");
    let value_zero = |v: &str| z.is_match(v.trim()) || lead_number(v).is_some_and(|x| x == 0.0);
    is_action(st) && (z.is_match(sel) || camel.is_match(sel) || attr.is_match(sel) || st["value"].as_str().is_some_and(value_zero))
}

/// An action that puts a real, non-zero input in: a `set` of a non-zero number, or a `select` of
/// an option that is not a zero / "none" one ("4", "4 meals", "active"; AD-13 round 4). Pure.
fn nonzero_input(st: &Value) -> bool {
    let v = st["value"].as_str().unwrap_or("").trim();
    match st["op"].as_str() {
        Some("set") => lead_number(v).is_some_and(|x| x != 0.0),
        Some("select") => !v.is_empty() && lead_number(v).is_none_or(|x| x != 0.0),
        _ => false,
    }
}

/// The probe's reads that expect only zero, sorted (`zero_reads`, `asked_zero_reads`): (after a
/// non-zero `set` / `select` (`nonzero_input`) with no zeroing action between, after a zeroing
/// action). Pure.
fn zero_marks(steps: &[Value]) -> (Vec<usize>, Vec<usize>) {
    let (mut armed, mut asked) = (false, false);
    let (mut z, mut n0) = (Vec::new(), Vec::new());
    for (i, st) in steps.iter().enumerate() {
        if zeroing(st) {
            (armed, asked) = (false, true);
        } else if nonzero_input(st) {
            armed = true;
        } else if is_read(st) {
            let ns = expected_numbers(st);
            if !ns.is_empty() && ns.iter().all(|x| x.abs() < 1e-9) {
                if armed {
                    z.push(i);
                } else if asked {
                    n0.push(i);
                }
            }
        }
    }
    (z, n0)
}

/// A read after a non-zero `set` / `select` (`nonzero_input`) that expects only zero ("set grams
/// 30, expect the total ≈0", "select 4 meals, expect ≈0 per meal"), with no reset / clear / remove
/// / zero option between (`zeroing`): a zero that was
/// already there proves nothing, so when NOTHING the probe reads changed after its action (an
/// action that really changed a control) and this read still shows what it showed before the
/// first action, the harness fails the probe as "nothing changed" (P1-3 b). A probe that proves a
/// change elsewhere ("set bill 80, click no tip, expect tip 0, expect total 80") passes. The step
/// indices. Pure.
pub fn zero_reads(steps: &[Value]) -> Vec<usize> {
    zero_marks(steps).0
}

/// A read that expects only zero after a reset / clear / remove / zero option (`zeroing`): the
/// zero was asked for, so it neither proves nor disproves a change (the harness leaves it out of
/// "nothing changed", `n0`). The step indices. Pure.
pub fn asked_zero_reads(steps: &[Value]) -> Vec<usize> {
    zero_marks(steps).1
}

/// A criterion about switching something: a toggle, a switch, a conversion or a unit. Pure.
fn toggles(criterion: &str) -> bool {
    static T: OnceLock<regex::Regex> = OnceLock::new();
    rx(&T, r"(?i)\b(?:toggl\w*|switch\w*|convert\w*|conversions?|units?)\b").is_match(criterion)
}

/// A toggle / switch / convert / unit probe must show a CHANGE (AD-13): at least one read after an
/// action that (a) does not follow a round trip (`round_trip`) and (b) when it expects numbers,
/// does not expect only the value the probe itself set into that element or the element's known
/// value on load (`initial`, from Nic's pinned default). A reversible probe (switch, read the
/// converted value, switch back, read the start) passes on its first read. Pure.
fn shows_change(steps: &[Value], initial: &[(String, f64)], home: Option<&str>) -> Result<(), String> {
    let Some(first_action) = steps.iter().position(is_action) else { return Err("it never switches anything: do the click / select that switches, then expect the result".into()) };
    let mut why: Option<String> = None;
    for k in (first_action + 1)..steps.len() {
        if !is_expect(&steps[k]) {
            continue;
        }
        if let Some(r) = round_trip(&steps[..k], home) {
            why.get_or_insert(format!("{r} (a round trip proves nothing): switch once, then expect the changed result"));
            continue;
        }
        let ns = if is_read(&steps[k]) { expected_numbers(&steps[k]) } else { vec![] };
        if !ns.is_empty() {
            let key = at(&steps[k]);
            let set = steps[..k].iter().filter(|s| s["op"] == "set" && at(s) == key).filter_map(|s| s["value"].as_str().and_then(lead_number));
            let start = initial.iter().filter(|(s, _)| *s == key).map(|(_, x)| *x);
            let olds: Vec<f64> = set.chain(start).collect();
            let same = |x: f64, o: f64| (x - o).abs() <= (o.abs() * 0.006).max(0.01);
            if !olds.is_empty() && ns.iter().all(|x| olds.iter().any(|o| same(*x, *o))) {
                let said = ns.iter().map(|x| fmt_num(*x)).collect::<Vec<_>>().join(" and ");
                why.get_or_insert(format!("it expects {said} on {key}, the value it had before the switch: expect the changed value (a switch that changes nothing passes that probe)"));
                continue;
            }
        }
        return Ok(());
    }
    Err(why.unwrap_or_else(|| "it expects nothing after the switch: expect the changed result".into()))
}

/// The rules for a criterion's own probe that is not a pinned intent check (`enforce`): the
/// steps to run and a note, or why it is rejected. Pure.
///
/// - An on-load / default / order criterion (`fresh`) is decided by the reads BEFORE the first
///   action (an action can trigger the first render and hide a page that never renders on
///   load, P2-4): it must expect first, and the steps after its first action are dropped (noted).
/// - A criterion that acts (`action`) needs an action with at least one expectation after it;
///   reads before the action are allowed (the 9B's "expect 165, click, expect the result"), and
///   the reads after the first action decide (P1-1).
/// - A value criterion (computes / converts) is decided by a number read of its own element
///   among the deciding reads (`value_rule`).
/// - A toggle / switch / convert / unit one must show a change (`shows_change`).
fn own_rules(steps: &[Value], need: &Need, initial: &[(String, f64)], home: Option<&str>) -> Result<(Vec<Value>, Option<String>), String> {
    let fa = first_action(steps);
    if need.fresh {
        let cut = fa.unwrap_or(steps.len());
        if !steps[..cut].iter().any(is_expect) {
            return Err("it acts before it checks: this is about the page on a fresh load, so expect it FIRST, before any set / select / click".to_string());
        }
        let pre = steps[..cut].to_vec();
        if need.value {
            // A read of a control (the weight input's default, a select) is not the computed
            // value: the truncation must never let it decide (review of P2-4).
            let shown: Vec<Value> = pre.iter().filter(|s| !control_read(s, steps)).cloned().collect();
            if let Err(why) = value_rule(&shown) {
                if !pre.iter().any(numeric_read) {
                    return Err(why);
                }
                // Its reads before the action only read controls: the computed number it reads
                // after the action (the 9B's "expect the input's 165, select Active, expect the
                // range") decides, so the whole probe runs.
                let after: Vec<Value> = steps[cut..].iter().filter(|s| !control_read(s, steps)).cloned().collect();
                if value_rule(&after).is_ok() {
                    return Ok((steps.to_vec(), Some("on-load check: its reads before the first action only read a control, so the computed value it reads after the action decides".to_string())));
                }
                return Err("it reads only a control (an input or select) before its first action, never the computed value: expect the computed number on the element that shows it".to_string());
            }
        }
        let note =(cut < steps.len()).then(|| "on-load check: only its reads before the first action decide (an action can trigger the first render); the steps after it were not run".to_string());
        return Ok((pre, note));
    }
    if need.action {
        let Some(fa) = fa else { return Err("it only reads the page: do the set / select / click that triggers the behaviour first, then expect the result".to_string()) };
        if !steps[fa + 1..].iter().any(is_expect) {
            return Err("it expects nothing after its action: do the set / select / click that triggers the behaviour, then expect the result".to_string());
        }
        if need.value {
            value_rule(&steps[fa + 1..])?;
            zero_rule(steps, true, need.zero)?;
        }
        if need.toggle {
            shows_change(steps, initial, home)?;
        }
        return Ok((steps.to_vec(), None));
    }
    if need.value {
        value_rule(steps)?;
        zero_rule(steps, false, need.zero)?;
    }
    Ok((steps.to_vec(), None))
}

/// A computed value expected to be 0 when nobody asked for a zero (AD-13 round 4, the critic's
/// fixed3-c: "select 4 meals, expect ≈0 per meal" on a page that correctly shows 37): what a page
/// that computed nothing shows, so the probe is the verifier's to fix (asked once more), never a
/// Coder loop that "fixes" a correct page to match. Rejected: a read after a non-zero `set` /
/// `select` that expects only 0 (`zero_reads`) with no later non-zero read of the same element
/// (a "0 before, 30 after add" pair is a real change); and, for a criterion that acts and
/// computes (`acting`), a probe whose every number read after its first action is 0 with no
/// reset / clear / zero option (`zeroing`) — it never does what produces the value. A zero asked
/// for (`asked_zero_reads`) is always fine. A zero the criterion itself names (`zero`: "makes
/// the tip $0.00", "never below 0") is fine when a read after the first action expects a
/// non-zero number on another element that is not a control the probe drives (the change is
/// proven there: "set bill 80, click no tip, expect tip 0, expect total 80"; "add 165 g, expect
/// left 0, expect tally 165"); the harness still fails it when nothing changed (AD-13 round 5).
/// Pure.
fn zero_rule(steps: &[Value], acting: bool, zero: bool) -> Result<(), String> {
    let elsewhere = |key: &str| {
        first_action(steps).is_some_and(|fa| steps[fa + 1..].iter().any(|s| is_read(s) && at(s) != key && !control_read(s, steps) && expected_numbers(s).iter().any(|x| x.abs() > 1e-9)))
    };
    for i in zero_reads(steps) {
        let key = at(&steps[i]);
        let later = steps[i + 1..].iter().any(|s| is_read(s) && at(s) == key && expected_numbers(s).iter().any(|x| x.abs() > 1e-9));
        if !later && !(zero && elsewhere(&key)) {
            let did = steps[..i].iter().filter(|s| nonzero_input(s)).map(action).collect::<Vec<_>>().join(", ");
            return Err(format!("it expects 0 on {key} after {did}, the value a page that computed nothing shows: expect the number Nic should see after that input (work it out from his request), or reset / clear first when zero is the point"));
        }
    }
    if acting && !steps.iter().any(zeroing) {
        if let Some(fa) = first_action(steps) {
            let ns: Vec<f64> = steps[fa + 1..].iter().filter(|s| is_read(s)).flat_map(expected_numbers).collect();
            if !ns.is_empty() && ns.iter().all(|x| x.abs() < 1e-9) {
                return Err("it expects only 0 after its actions, what a page that did nothing shows: do the input that produces the value (type the number, pick the option, click add), then expect the computed result".to_string());
            }
        }
    }
    Ok(())
}

/// Hold each answer's probe to what its criterion needs: an intent check's probe to the pinned
/// value (rewritten or substituted, or rejected with "use the pinned value X"); any probe that
/// expects a placeholder ("Loading", "NaN", "--") is rejected; the criterion's own probe to
/// `own_rules` (on-load ones decided before any action, acting ones after their first action,
/// value ones by a number, toggles by a change). A probe that breaks a rule becomes
/// `Err(reason)`; a pinned value put in place of the model's, or steps dropped, are noted on
/// the answer. Pure.
pub fn enforce(answers: &mut Answers, needs: &[Need]) {
    // What is known about the page on load: Nic's default unit, and his pinned default on the
    // element its probe reads.
    let home: Option<String> = needs.iter().find_map(|n| match n.check.as_ref().map(|c| &c.kind) {
        Some(CheckKind::Convert { from, .. }) | Some(CheckKind::Unit { unit: from, .. }) => Some(from.clone()),
        _ => None,
    });
    let mut initial: Vec<(String, f64)> = Vec::new();
    for a in &answers.list {
        let Some(c) = a.idx.and_then(|i| needs.get(i)).and_then(|n| n.check.as_ref()).filter(|c| c.kind == CheckKind::Default) else { continue };
        if let Some(Ok(steps)) = &a.probe {
            if let Ok((pinned, _)) = pin(steps, c, &[]) {
                let first_action = pinned.iter().position(is_action).unwrap_or(pinned.len());
                let want = (c.value * 100.0).round() / 100.0;
                initial.extend(pinned[..first_action].iter().filter(|s| s["approx"].as_f64() == Some(want)).map(|s| (at(s), c.value)));
            }
        }
    }
    let known: Vec<String> = initial.iter().map(|(s, _)| s.clone()).collect();
    for a in answers.list.iter_mut() {
        let Some(need) = a.idx.and_then(|i| needs.get(i)) else { continue };
        let Some(Ok(steps)) = &a.probe else { continue };
        let checked = match expects_placeholder(steps, &need.shows) {
            Some(why) => Err(why),
            None => match &need.check {
                Some(c) => pin(steps, c, &known),
                None => own_rules(steps, need, &initial, home.as_deref()),
            },
        };
        let (checked, note) = match checked {
            Ok((s, n)) => (Ok(s), n),
            Err(e) => (Err(e), None),
        };
        a.note = note;
        a.probe = Some(checked);
    }
}

/// The probes that failed on an earlier verify (`last_eval.open_probes`), matched to this
/// verify's answers by requested criterion (else by name), to run again alongside the verifier's
/// new ones: a bug a probe caught cannot pass the next round on quoted code alone. A criterion
/// left unanswered is already a verify gap; one whose new probe has the very same steps runs
/// once. The steps are validated again (stored data is still untrusted). Pure.
pub fn carried_probes(open: &Value, answers: &Answers, fresh: &[Probe], needs: &[Need]) -> Vec<Probe> {
    let mut out: Vec<Probe> = Vec::new();
    for o in open.as_array().into_iter().flatten().take(MAX_CARRIED) {
        let Ok(steps) = parse_probe(&o["steps"]) else { continue };
        let name = o["criterion"].as_str().unwrap_or("");
        let idx = o["idx"].as_u64().map(|x| x as usize);
        let answer = answers.list.iter().position(|a| idx.is_some() && a.idx == idx).or_else(|| answers.list.iter().position(|a| !name.is_empty() && a.name == name));
        let Some(answer) = answer else { continue };
        if fresh.iter().chain(out.iter()).any(|p| p.answer == answer && p.steps == steps) {
            continue;
        }
        let change = must_change(answers.list[answer].idx.and_then(|x| needs.get(x)));
        out.push(Probe { answer, criterion: answers.list[answer].name.clone(), steps, carried: true, change });
    }
    out
}

/// The probes to re-check on the next verify: every probe that failed this time (a carried one
/// also when its selector now matches nothing, unless a new probe for the same criterion passed),
/// and carried ones that could not run. Keyed by requested criterion. Pure.
pub fn open_probes(probes: &[Probe], run: &ProbeRun, answers: &Answers) -> Value {
    let results: &[ProbeResult] = match run {
        ProbeRun::Ran(v) if v.len() == probes.len() => v,
        _ => &[],
    };
    let fresh_passed = |answer: usize| probes.iter().zip(results).any(|(p, r)| !p.carried && p.answer == answer && r.ran && r.passed);
    let mut out: Vec<Value> = Vec::new();
    for (i, p) in probes.iter().enumerate() {
        let keep = match results.get(i) {
            Some(r) if r.ran => !r.passed && (!r.error || (p.carried && !fresh_passed(p.answer))),
            _ => p.carried,
        };
        let mut entry = json!({ "idx": answers.list.get(p.answer).and_then(|a| a.idx), "criterion": p.criterion, "steps": p.steps });
        // What it found, for the wrong-number guard (`wrong_number_suspects`, AD-13 round 4).
        if let Some(r) = results.get(i).filter(|r| r.ran) {
            entry["detail"] = json!(r.detail);
        }
        if keep && !out.iter().any(|o| o["steps"] == entry["steps"] && o["idx"] == entry["idx"]) {
            out.push(entry);
        }
    }
    out.truncate(MAX_CARRIED);
    Value::Array(out)
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
            } else if let Some(all) = st["all"].as_array() {
                let ns: Vec<String> = all.iter().filter_map(Value::as_f64).map(fmt_num).collect();
                format!("expected {} {what} to show {} (±{})", at(st), ns.join(" and "), st["tol"].as_f64().unwrap_or(0.0))
            } else {
                format!("expected {} {what} ≈{} (±{})", at(st), st["approx"].as_f64().unwrap_or(0.0), st["tol"].as_f64().unwrap_or(0.0))
            }
        }
        "expect_class" => format!("expected {} {} class \"{}\"", at(st), if st["present"] == false { "not to have" } else { "to have" }, st["cls"].as_str().unwrap_or("")),
        "expect_count" => format!("expected {} element(s) matching {}", st["count"], at(st)),
        "expect_unit" => format!("expected {} to have {} selected", at(st), unit_label(st["unit"].as_str().unwrap_or(""))),
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
    /// The probe was carried over from an earlier failure (`Probe::carried`).
    pub carried: bool,
    /// It passed with at least one read of an element of its own (not the whole page, not a
    /// container of more than `BIG_TEXT` chars): a passing probe that proves its criterion even
    /// when the quoted code is stale (AD-13).
    pub specific: bool,
    /// …and one of those reads is of a value (text / value / order / unit).
    pub value_specific: bool,
    /// The probe's selector matched nothing on the page (`nomatch`): the one probe error the
    /// PAGE can cause (an element it should have is missing, P1-2).
    pub missing: bool,
}

/// A read element with more text than this is a container, not the value (`data-tf-probe` `w`).
pub const BIG_TEXT: usize = 200;

/// (specific, value_specific) for a probe that passed: its reads, minus whole-page selectors and
/// the text reads the harness found on a big container (`big`, step indices). Pure.
fn specificity(steps: &[Value], big: &[usize]) -> (bool, bool) {
    let mut any = false;
    let mut value = false;
    for (i, st) in steps.iter().enumerate() {
        if !is_expect(st) || weak_sel(st["sel"].as_str().unwrap_or("")) || (is_read(st) && big.contains(&i)) {
            continue;
        }
        any = true;
        if is_read(st) || st["op"] == "expect_order" || st["op"] == "expect_unit" {
            value = true;
        }
    }
    (any, value)
}

/// The probe run as a whole.
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeRun {
    /// Not run (no probes, no Edge, runtime checks off): the evidence-only rule applies.
    Skipped(String),
    /// Each probe's result. `run_probes` runs every probe on its own, so a probe that hangs or
    /// navigates away is that probe's failure (`unfinished`), never a whole run thrown away.
    Ran(Vec<ProbeResult>),
}

impl ProbeRun {
    pub fn summary(&self) -> Value {
        match self {
            ProbeRun::Skipped(r) => json!({ "ran": false, "skipped": r }),
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
                return ProbeResult { answer: p.answer, ran: false, passed: false, error: false, detail: "not run (the page ran out of time)".into(), carried: p.carried, specific: false, value_specific: false, missing: false };
            };
            if r["ok"] == true {
                let big: Vec<usize> = r["w"].as_array().map(|a| a.iter().filter_map(Value::as_u64).map(|x| x as usize).collect()).unwrap_or_default();
                let (specific, value_specific) = specificity(&p.steps, &big);
                let detail = if big.is_empty() { "passed".to_string() } else { format!("passed, but step {} read a container of more than {BIG_TEXT} characters", big.iter().map(|i| (i + 1).to_string()).collect::<Vec<_>>().join(", ")) };
                return ProbeResult { answer: p.answer, ran: true, passed: true, error: false, detail, carried: p.carried, specific, value_specific, missing: false };
            }
            let k = r["at"].as_u64().unwrap_or(0) as usize;
            let st = p.steps.get(k).cloned().unwrap_or(Value::Null);
            let got = clip_chars(&r["got"].as_str().map(String::from).unwrap_or_else(|| r["got"].to_string()), 120);
            let after = actions_before(p, k).map(|a| format!("after {a}")).unwrap_or_else(|| "on a fresh load".to_string());
            // What the page produced comes FIRST: a fix line is clipped from its end, and the
            // value is what the Coder needs most.
            let (error, detail) = match r["k"].as_str().unwrap_or("") {
                "nomatch" => (true, format!("{} matches nothing (probe step {})", at(&st), k + 1)),
                "nolabels" => (true, format!("{} shows {got}, which does not name the expected {} (probe step {})", at(&st), st["order"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default(), k + 1)),
                "nooption" => (true, format!("{} has no option \"{}\" (it shows \"{got}\")", at(&st), st["value"].as_str().unwrap_or(""))),
                "nounit" => (true, format!("{} shows no selected unit (it shows \"{got}\"): point it at the unit select, the radio group or the unit buttons (probe step {})", at(&st), k + 1)),
                "threw" => (false, format!("the page threw: {got}; after {}", actions_before(p, k + 1).unwrap_or_default())),
                // A read after the action that still shows what it showed before it (P1-3 c).
                "same" => (false, format!("nothing changed after {}: {} still shows {got}, as it did before", actions_before(p, k).unwrap_or_else(|| "its action".into()), at(&st))),
                _ => (false, format!("got {got}; {} {after}", want(&st))),
            };
            ProbeResult { answer: p.answer, ran: true, passed: false, error, detail: clip_chars(&detail, 220), carried: p.carried, specific: false, value_specific: false, missing: r["k"] == "nomatch" }
        })
        .collect()
}

/// The actions (set / select / click / reload) among the first `k` steps, joined; None if none.
fn actions_before(p: &Probe, k: usize) -> Option<String> {
    let did: Vec<String> = p.steps.iter().take(k).filter(|s| !s["op"].as_str().unwrap_or("").starts_with("expect_")).map(action).collect();
    (!did.is_empty()).then(|| did.join(", "))
}

/// A probe whose page never produced a result (it hung, kept reloading, or navigated / replaced
/// itself): a FAILURE of that probe, never a silent skip. `partial` is the harness's
/// `data-tf-probe-partial` record (`{s}` = steps started) when Edge still printed the page; it
/// names the step in flight. Pure.
pub fn unfinished(p: &Probe, partial: Option<&Value>, why: &str) -> ProbeResult {
    let started = partial.and_then(|v| v["s"].as_u64()).map(|s| s as usize);
    let doing = match started {
        Some(s) if s >= 1 => match actions_before(p, s) {
            Some(a) => format!("after {a}"),
            None => "while checking the fresh page".to_string(),
        },
        Some(_) => "on load, before the probe's first step".to_string(),
        None => match actions_before(p, p.steps.len()) {
            Some(a) => format!("during {a}"),
            None => "while checking the fresh page".to_string(),
        },
    };
    let detail = format!("the page hung or navigated away {doing} ({})", clip_chars(why, 90));
    ProbeResult { answer: p.answer, ran: true, passed: false, error: false, detail: clip_chars(&detail, 220), carried: p.carried, specific: false, value_specific: false, missing: false }
}

// ── Judging ─────────────────────────────────────────────────────────────────

/// The verifier's per-criterion verdicts checked against the code and the probes.
#[derive(Debug, Clone, PartialEq)]
pub struct Judged {
    /// One fix line per criterion that is not met, has no evidence in the code, or whose probe
    /// failed (probe failures first).
    pub unmet: Vec<String>,
    /// The requested criterion (0-based) each `unmet` line is about, in the same order (None for
    /// an answer that matched no requested criterion).
    pub unmet_idx: Vec<Option<usize>>,
    /// Criteria the verifier did not judge, or whose code was cut from its view ("not shown").
    /// Never counted as unmet; named as known blockers when the build is staged.
    pub not_judged: Vec<String>,
    /// Behavioural criteria the verifier called met with no probe that ran and passed (missing,
    /// rejected, matching nothing, or past the cap): never met, never a Coder loop (the page may
    /// be fine) — the verify is asked once more, then each is a known blocker.
    pub gaps: Vec<ProbeGap>,
    /// The checked list (criterion, met, evidence found, probe) for the envelope.
    pub criteria: Value,
    /// The verifier returned no per-criterion list at all.
    pub absent: bool,
    /// Criteria that need no probe (layout, offline, responsive …) called met with quoted code
    /// that is not in the page and nothing else proving them (P1-4): the VERIFIER's to fix (asked
    /// once more), then a note — never a Coder loop, never "does not work".
    pub stale: Vec<StaleQuote>,
}

/// A criterion whose quoted code is not in the page (stale, paraphrased or missing) with nothing
/// else proving it (`Judged::stale`).
#[derive(Debug, Clone, PartialEq)]
pub struct StaleQuote {
    /// The requested criterion's number (1-based).
    pub n: Option<usize>,
    pub criterion: String,
}

/// The note a stale quote leaves when the build is staged. Pure.
pub fn stale_line(q: &StaleQuote) -> String {
    format!("couldn't confirm in the code: {} (the verifier's quoted code is not in the page)", clip_chars(&q.criterion, 120))
}

/// How a stale-quote retry reason ends (`prompt_verify` lists these apart from probe gaps).
pub const STALE_TAIL: &str = "the quoted code is not in the page: copy 1-3 lines that implement it VERBATIM";

/// The retry reason for a stale quote (the verifier copies the code verbatim this time). Pure.
pub fn stale_feedback(stale: &[StaleQuote]) -> Vec<String> {
    stale.iter().map(|q| format!("{}{}: {STALE_TAIL}", q.n.map(|n| format!("{n}. ")).unwrap_or_default(), clip_chars(&q.criterion, 120))).collect()
}

/// A behavioural criterion without a working probe, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeGap {
    /// The requested criterion's number (1-based).
    pub n: Option<usize>,
    pub criterion: String,
    pub why: String,
    /// The verifier can fix it on a retry (no probe, a rejected one, a selector matching
    /// nothing); `false` for a probe skipped by the cap or the time budget.
    pub fixable: bool,
    /// One of Nic's pinned intent checks (listed first, never dropped silently; AD-13).
    pub pinned: bool,
    /// The PAGE can cause it: the probe ran and its selector matched nothing (an element the
    /// criterion needs is missing). The only gap that may send the Coder another pass (P1-2): no
    /// probe given, a rejected one, a weak read, an unreadable unit control (a control that exists
    /// but shows no selection the harness can read), a missing option or labels are the
    /// verifier's or the harness's, which the Coder cannot fix.
    pub page: bool,
}

impl ProbeGap {
    /// The harness could not read which unit the page's control shows (`nounit`) even after the
    /// retry: the Coder cannot change what the harness sees, so this is a known note — never a
    /// Coder loop, never "does not work" (AD-13 review).
    pub fn unreadable(&self) -> bool {
        self.pinned && self.why.contains("shows no selected unit")
    }
}

/// The reasons fed back to the verifier on its one retry: per criterion it can fix, why no probe
/// for it worked (the parse error, the selector that matched nothing, the pinned value to use).
/// Nic's pinned checks first. Pure.
pub fn probe_feedback(gaps: &[ProbeGap]) -> Vec<String> {
    let mut v: Vec<&ProbeGap> = gaps.iter().filter(|g| g.fixable).collect();
    v.sort_by_key(|g| !g.pinned);
    v.into_iter().map(|g| clip_chars(&format!("{}{}: {}", g.n.map(|n| format!("{n}. ")).unwrap_or_default(), clip_chars(&g.criterion, 120), g.why), 300)).collect()
}

// ── The wrong-number guard (AD-13 round 4) ──────────────────────────────────

/// A short, stable signature of a page's live code, whitespace / quote / case normalised: an
/// unchanged page after a Coder pass has the same one (`wrong_number_guard`). FNV-1a. Pure.
pub fn page_sig(html: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in norm(&live_code(html)).bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// How a recheck reason starts in the verify retry (`prompt_verify` lists these on their own).
pub const RECHECK_HEAD: &str = "RECHECK ";

/// What the wrong-number guard decided for this verify's failing probes, by requested criterion
/// (0-based).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Guard {
    /// Failed again after a Coder pass with the same value (same steps, same detail), or on a page
    /// the Coder returned unchanged: the expectation may be wrong, so the verifier is asked to
    /// confirm or correct it once BEFORE any further Coder pass for it.
    pub suspects: Vec<usize>,
    /// Kept by the verifier on its recheck (or already kept on an earlier pass): a known blocker,
    /// never another Coder loop for that probe.
    pub held: Vec<usize>,
}

/// The wrong-number guard (AD-13 round 4: the critic's fixed3-b looped the Coder twice on a
/// correct page whose probe expected 74.8-93 g after a unit switch — a real Coder would "fix" the
/// page to match). `prev` = the open probes recorded by the last verify (`idx`, `steps`,
/// `detail`, `page`, `kept`); `fails` = this verify's probe failures (requested criterion,
/// steps, detail); `page` = this page's `page_sig`; `rechecked` = the criteria the verifier was
/// just asked to recheck on this claim (their failures now are its answer: kept). Pure.
pub fn wrong_number_guard(prev: &Value, fails: &[(usize, Vec<Value>, String)], page: &str, rechecked: &[usize]) -> Guard {
    let mut g = Guard::default();
    for (idx, steps, detail) in fails {
        if g.suspects.contains(idx) || g.held.contains(idx) {
            continue;
        }
        let before: Vec<&Value> = prev.as_array().into_iter().flatten().filter(|o| o["idx"].as_u64() == Some(*idx as u64)).collect();
        if rechecked.contains(idx) || before.iter().any(|o| o["kept"] == true) {
            g.held.push(*idx);
        } else if before.iter().any(|o| (o["steps"] == Value::Array(steps.clone()) && o["detail"].as_str() == Some(detail.as_str())) || o["page"].as_str() == Some(page)) {
            g.suspects.push(*idx);
        }
    }
    g
}

/// The lines of the page's live code that name the elements a probe touches (`#id` selectors),
/// at most 4, joined: the code the verifier rechecks its expectation against. Pure.
pub fn code_for(html: &str, steps: &[Value], max: usize) -> String {
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    let code = live_code(html);
    let mut ids: Vec<String> = Vec::new();
    for st in steps {
        for c in rx(&ID, r"#([A-Za-z_][\w-]*)").captures_iter(st["sel"].as_str().unwrap_or("")) {
            if !ids.contains(&c[1].to_string()) {
                ids.push(c[1].to_string());
            }
        }
    }
    let mut lines: Vec<String> = Vec::new();
    // The element that shows the value first (the last read), then the controls.
    for id in ids.iter().rev() {
        for l in code.lines().map(str::trim).filter(|l| l.contains(id.as_str()) && (l.contains('=') || l.contains('('))) {
            let l = clip_chars(l, 160);
            if lines.len() < 4 && !lines.contains(&l) {
                lines.push(l);
            }
        }
    }
    clip_chars(&lines.join(" | "), max)
}

/// The recheck reason for one suspect probe (`prompt_verify` asks the verifier to confirm or
/// correct the expectation). Pure.
pub fn recheck_line(n: usize, criterion: &str, detail: &str, code: &str) -> String {
    let code = if code.is_empty() { String::new() } else { format!(" The page's code for it: {code}") };
    clip_chars(&format!("{RECHECK_HEAD}{n}. {}: {detail} — the same after the Coder's fix pass.{code}", clip_chars(criterion, 120)), 700)
}

/// A rechecked criterion whose old probe was set aside for the verifier's answer to the recheck
/// and whose new probe passes only because it no longer expects what the old one did
/// (`disputed_rechecks`, AD-13 round 5).
#[derive(Debug, Clone, PartialEq)]
pub struct Dispute {
    /// The requested criterion (0-based).
    pub idx: usize,
    /// The unchecked line for the verdict and the voice.
    pub line: String,
    /// The old probe's steps and what it found, carried (kept) to the next verify.
    pub steps: Vec<Value>,
    pub detail: String,
}

/// The longest a dispute line may be (the verdict lists clip their items to it).
pub const DISPUTE_LINE: usize = 240;

/// The unchecked line for a disputed recheck (AD-13 round 6): the head, the criterion and what
/// the verifier now expects ("now expected …") always fit in `DISPUTE_LINE`; the old probe's
/// finding ("before: got 41g; expected … ≈37 …") takes what is left, and is the only part cut
/// (left out when too little room remains to say anything). Pure.
pub fn dispute_line(criterion: &str, now: &str, before: &str) -> String {
    let head = format!("couldn't be checked: on recheck the verifier switched to the page's value, for {}; now {}", clip_chars(criterion, 56), clip_chars(now, 70));
    let room = DISPUTE_LINE.saturating_sub(head.chars().count() + "; before: ".len());
    if before.is_empty() || room < 16 {
        return head;
    }
    format!("{head}; before: {}", clip_chars(before, room))
}

/// Does `new` still expect everything `old` expected? Each of the old probe's expectations must
/// be matched by one of the new probe's: a number within either step's tolerance (at least 0.6 %
/// or 0.01), anything else by the same expectation fields (selector and position aside). Pure.
fn keeps_expectations(old: &[Value], new: &[Value]) -> bool {
    let strip = |st: &Value| {
        let mut v = st.clone();
        if let Some(o) = v.as_object_mut() {
            o.remove("sel");
            o.remove("nth");
        }
        v
    };
    let reads_new: Vec<&Value> = new.iter().filter(|s| is_expect(s)).collect();
    old.iter().filter(|s| is_expect(s)).all(|o| {
        let ons = if is_read(o) { expected_numbers(o) } else { vec![] };
        if ons.is_empty() {
            let k = strip(o);
            return reads_new.iter().any(|n| strip(n) == k);
        }
        let ns: Vec<(f64, f64)> = reads_new.iter().filter(|n| is_read(n)).flat_map(|n| expected_numbers(n).into_iter().map(|x| (x, n["tol"].as_f64().unwrap_or(0.0)))).collect();
        let otol = o["tol"].as_f64().unwrap_or(0.0);
        ons.iter().all(|x| ns.iter().any(|(y, t)| (x - y).abs() <= otol.max(*t).max(x.abs() * 0.006).max(0.01)))
    })
}

/// The wrong-number guard's blind spot (AD-13 round 5, the critic's permeal-bug page): a recheck
/// answer that copies the value the page showed ("got 41g; expected ≈37" → the verifier, tracing
/// the buggy code, now expects 41) would turn a failing criterion into a pass on the same
/// evidence. `dropped` = the carried probes set aside for a rechecked criterion's new probe;
/// `probes` / `run` = what ran this time; `prev` = the last verify's open probes (their
/// `detail`). A new probe that passed while no longer expecting what the old one expected
/// (`keeps_expectations`) is a disputed expectation: the page's value and the copy cannot be
/// told apart, so the criterion is not counted as met (unverified at most) and never sent to
/// the Coder. A new probe that keeps the old expectation and passes (a selector fixed), or one
/// that fails (held by the guard), is not a dispute. Pure.
pub fn disputed_rechecks(prev: &Value, dropped: &[Probe], probes: &[Probe], run: &ProbeRun, answers: &Answers) -> Vec<Dispute> {
    let results: &[ProbeResult] = match run {
        ProbeRun::Ran(v) if v.len() == probes.len() => v,
        _ => return vec![],
    };
    let mut out: Vec<Dispute> = Vec::new();
    for d in dropped {
        let Some(idx) = answers.list.get(d.answer).and_then(|a| a.idx) else { continue };
        if out.iter().any(|x| x.idx == idx) {
            continue;
        }
        let Some((p, _)) = probes.iter().zip(results).find(|(p, r)| !p.carried && p.answer == d.answer && r.ran && r.passed) else { continue };
        if keeps_expectations(&d.steps, &p.steps) {
            continue;
        }
        let before = prev.as_array().into_iter().flatten().find(|o| o["idx"].as_u64() == Some(idx as u64) && o["steps"] == Value::Array(d.steps.clone())).and_then(|o| o["detail"].as_str()).unwrap_or("").to_string();
        let now = p.steps.iter().rev().find(|s| is_expect(s)).map(want).unwrap_or_default();
        let line = dispute_line(&d.criterion, &now, &before);
        out.push(Dispute { idx, line, steps: d.steps.clone(), detail: before });
    }
    out
}

/// Judge the answers: a criterion counts only when the model says it is met AND quotes code that
/// is really in the page, and its probe (if it ran) did not fail. A probe whose selector matches
/// nothing is reported but only counts against a criterion that also has no evidence. Where
/// probes run (`probes_on`), a behavioural criterion (`needs`, by requested criterion) counts as
/// met only when a probe for it ran and passed; otherwise it is a `ProbeGap`. A passing probe
/// proves a behavioural criterion when it read an element of its own (`ProbeResult::specific`):
/// stale or paraphrased quoted code is then only noted (`evidence_found: false` + a note), never
/// a Coder fix (AD-13). A value criterion (computes / converts, or a pinned number) is proven only
/// by a passing read of the value itself, not of the whole page or a big container. Pure.
pub fn judge(answers: &Answers, html: &str, cut: bool, run: &ProbeRun, needs: &[Need], probes_on: bool) -> Judged {
    let hn = norm(html);
    let results: &[ProbeResult] = match run {
        ProbeRun::Ran(v) => v,
        _ => &[],
    };
    let skipped = match run {
        ProbeRun::Skipped(r) => format!("skipped: {r}"),
        ProbeRun::Ran(_) => format!("skipped: at most {MAX_PROBES} probes run"),
    };
    let (mut probe_lines, mut other, mut not_judged, mut gaps, mut out, mut stale) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut probe_idx, mut other_idx): (Vec<Option<usize>>, Vec<Option<usize>>) = (Vec::new(), Vec::new());
    for (i, a) in answers.list.iter().enumerate() {
        let name: String = clip_chars(&a.name, 100);
        let found = !a.evidence.is_empty() && evidence_found(&hn, &a.evidence);
        let need = a.idx.and_then(|x| needs.get(x));
        let required = probes_on && need.is_some_and(|n| n.probe);
        let res = results.iter().find(|r| r.answer == i && !r.carried);
        let again: Vec<&ProbeResult> = results.iter().filter(|r| r.answer == i && r.carried).collect();
        let mut probe_json = match (&a.probe, res) {
            (Some(Err(why)), _) => json!({ "ran": false, "passed": false, "error": true, "detail": format!("probe rejected: {why}") }),
            (Some(Ok(_)), Some(r)) => json!({ "ran": r.ran, "passed": r.passed, "error": r.error, "detail": r.detail }),
            (Some(Ok(_)), None) => json!({ "ran": false, "passed": false, "error": false, "detail": skipped }),
            (None, _) => Value::Null,
        };
        if !again.is_empty() {
            let rechecked: Vec<Value> = again.iter().map(|r| json!({ "ran": r.ran, "passed": r.passed, "error": r.error, "detail": r.detail })).collect();
            if probe_json.is_null() {
                probe_json = json!({});
            }
            probe_json["rechecked"] = json!(rechecked);
        }
        let probe_failed = res.is_some_and(|r| r.ran && !r.passed && !r.error);
        // A probe that failed on an earlier pass and fails again — or now matches nothing while no
        // new probe for this criterion passed — is a failure, whatever the quoted code says.
        let fresh_passed = res.is_some_and(|r| r.ran && r.passed);
        let failed_again = again.iter().find(|r| r.ran && !r.passed && (!r.error || !fresh_passed));
        // A value is proven only by a read of the value itself (not the whole page or a container).
        let value_need = need.is_some_and(|n| n.value || n.check.as_ref().is_some_and(IntentCheck::numeric));
        let counts = |r: &ProbeResult| r.ran && r.passed && (!value_need || r.value_specific);
        let passing: Vec<&ProbeResult> = res.into_iter().chain(again.iter().copied()).filter(|r| r.ran && r.passed).collect();
        let proven = passing.iter().any(|r| counts(r));
        let weak_pass = !proven && !passing.is_empty();
        // A passing probe that read an element of its own proves its criterion even when the
        // quoted code is stale or paraphrased (the evidence is then only noted) — a criterion that
        // needs no probe too, when the verifier gave one anyway (P1-4).
        let proven_specific = passing.iter().any(|r| counts(r) && r.specific);
        let behavioural = need.is_some_and(|n| n.probe);
        let mut evidence_note: Option<&str> = None;
        let probe_note = res.filter(|r| r.error).map(|r| format!("; its probe: {}", r.detail)).or_else(|| match &a.probe {
            Some(Err(why)) => Some(format!("; its probe was rejected: {why}")),
            _ => None,
        });
        // ≤ 300 chars a line (`FIX_LINE`): name ≤ 60, detail ≤ 220, the observed value first.
        let (n_probe, n_other) = (probe_lines.len(), other.len());
        if probe_failed {
            probe_lines.push(format!("probe failed for {}: {}", clip_chars(&a.name, 60), res.map(|r| r.detail.as_str()).unwrap_or("")));
        } else if let Some(r) = failed_again {
            let what = if r.error { "a probe that failed before now matches nothing for" } else { "probe failed again for" };
            probe_lines.push(clip_chars(&format!("{what} {}: {}", clip_chars(&a.name, 50), r.detail), 300));
        } else {
            match a.met {
                Some(false) => {
                    let why = if a.fix.is_empty() { String::new() } else { format!(" ({})", clip_chars(&a.fix, 90)) };
                    other.push(format!("not met: {name}{why}"));
                }
                Some(true) => {
                    // The probe decides a behavioural criterion (its probe held to the rules in
                    // `enforce`): passed with a read of its own element, it proves the criterion
                    // whatever the quote says; with no quote at all, it stands in for the evidence;
                    // still unproven where probes run, it is a gap below, not a Coder fix.
                    let stands_in = proven_specific || (behavioural && a.evidence.trim().is_empty() && (proven || required));
                    // A stale quote with nothing proving the criterion: where its probe is required,
                    // the gap below stands for it; one that needs no probe is the verifier's to fix
                    // (`stale`); only a behavioural one where probes cannot run (and one verify
                    // cannot place) keeps the evidence rule and goes to the Coder.
                    let unquoted = !found && !stands_in;
                    if unquoted && !required {
                        if need.is_some_and(|n| !n.probe) {
                            stale.push(StaleQuote { n: a.idx.map(|x| x + 1), criterion: a.name.clone() });
                        } else {
                            other.push(format!("no working code found for: {name} (implement it for real{})", probe_note.unwrap_or_default()));
                        }
                    }
                    if !found && proven_specific && !a.evidence.trim().is_empty() {
                        evidence_note = Some("the quoted code is not in the page (stale or paraphrased); its passing probe proves the criterion");
                    }
                    if required && (!proven || unquoted) {
                        let pinned = need.and_then(|n| n.check.as_ref()).map(|c| format!(" (pinned value {})", c.pinned())).unwrap_or_default();
                        // The cap and the time budget are not the verifier's to fix.
                        let (why, fixable, page) = match (&a.probe, res) {
                            _ if weak_pass => (format!("its probe passed, but read the value from the whole page or a container of more than {BIG_TEXT} characters: expect the element that shows it{pinned}"), true, false),
                            _ if proven => (format!("its probe passed but read no element of its own, and the quoted code is not in the page: expect the element that shows it{pinned}"), true, false),
                            (Some(Err(why)), _) => (format!("its probe was rejected: {why}"), true, false),
                            (Some(Ok(_)), Some(r)) if r.error => (format!("its probe did not run: {}", r.detail), true, r.missing),
                            (Some(Ok(_)), Some(r)) => (r.detail.clone(), r.ran, false),
                            (Some(Ok(_)), None) => (skipped.clone(), false, false),
                            (None, _) => (format!("no probe was given{pinned}"), true, false),
                        };
                        let pinned = need.is_some_and(|n| n.check.is_some());
                        gaps.push(ProbeGap { n: a.idx.map(|x| x + 1), criterion: a.name.clone(), why: clip_chars(&why, 220), fixable, pinned, page });
                    }
                }
                None if cut => not_judged.push(format!("not shown to the verifier (code cut for length): {name}")),
                None => not_judged.push(format!("verify did not judge: {name}")),
            }
        }
        probe_idx.resize(probe_lines.len().max(n_probe), a.idx);
        other_idx.resize(other.len().max(n_other), a.idx);
        let mut row = json!({ "n": a.idx.map(|x| x + 1), "criterion": a.name, "met": a.met, "evidence_found": found, "evidence": a.evidence.chars().take(160).collect::<String>(), "probe": probe_json });
        if required {
            row["needs_probe"] = json!(true);
        }
        if let Some(c) = need.and_then(|n| n.check.as_ref()) {
            row["pinned"] = json!(c.pinned());
        }
        if let Some(n) = &a.note {
            row["probe_note"] = json!(n);
        }
        if let Some(n) = evidence_note {
            row["evidence_note"] = json!(n);
        }
        out.push(row);
    }
    not_judged.extend(answers.missing.iter().map(|m| format!("verify did not judge: {}", clip_chars(m, 100))));
    probe_lines.extend(other);
    probe_idx.extend(other_idx);
    Judged { unmet: probe_lines, unmet_idx: probe_idx, not_judged, gaps, criteria: Value::Array(out), absent: answers.list.is_empty(), stale }
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
/// blocked access records the calling line), then after load (and 800 ms of virtual time) record
/// the output-like elements still showing a placeholder (`stuck`, BEFORE any interaction: a page
/// that only renders once a control changes shows "Loading..." to Nic) — sampled again 1.5 s
/// later, and only those still showing the same text count (a page that renders after a short
/// "Calculating..." delay is fine) — fill the inputs, change the selects, click the buttons still
/// on the page, and write the result onto <html>.
///
/// Output-like: an `<output>`, or an element whose id / class names a display, result, total,
/// target, output, summary, amount, readout, answer or tally (form controls never). Visible text
/// of at most 60 chars that is just "Loading" / "Calculating" (with dots, an optional "Label:"
/// before it; "Carb loading" is a value), holds NaN, undefined, null, Infinity or [object Object]
/// as a token, or — only when every visible text / number input on the page is filled in, so
/// there is everything to compute from — is only dashes / an ellipsis (an optional unit after
/// it). A select alone, or an empty bill / grams field, leaves "--" an empty state (a tip total
/// before the bill, a tally before the first food). Empty-state copy ("No foods yet") never
/// counts; of nested matches the innermost is kept; at most 4. NaN, undefined and [object Object]
/// are never valid UI text: any visible leaf element showing one as a token counts, whatever it
/// is named ("NaN%" in a progress label, P2-3), unless the page's own markup already holds that
/// leaf with that text (`ST`, `static_broken`: a typeof quiz's "undefined" answer button, a
/// cheat-sheet cell "NaN"; an output-like container is read without such leaves, `live`) and no
/// script replaced its text (`T`, a mutation observer: a script that writes "NaN g" over the same
/// markup still counts) — only text the scripts put there counts. "null" / "Infinity" /
/// "Loading" / "--" stay limited to output-like elements.
const SMOKE_JS: &str = r#"var ST=__STATIC__,T=[];try{new MutationObserver(function(rs){rs.forEach(function(r){var e=r.type==='characterData'?r.target.parentElement:r.target;if(e&&(r.type==='characterData'||r.removedNodes.length)&&T.length<2000&&T.indexOf(e)<0)T.push(e)})}).observe(document,{childList:true,subtree:true,characterData:true})}catch(x){}
var H=[];function site(){try{var f=String(new Error().stack||'').split('\n')[3]||'';var m=f.match(/:(\d+):\d+\)?\s*$/);if(m&&H.length<40)H.push(+m[1])}catch(x){}}
function block(n){try{Object.defineProperty(window,n,{configurable:true,get:function(){site();throw new DOMException(n+' is blocked here (guard storage with try/catch)','SecurityError')}})}catch(x){}}
block('localStorage');block('sessionStorage');
function txt(e){return String(e.innerText||'').replace(/\s+/g,' ').trim()}
function fixed(e){return !e.children.length&&T.indexOf(e)<0&&ST.indexOf((e.id?'#'+e.id:e.tagName.toLowerCase())+'|'+txt(e).toLowerCase())>=0}
function live(el){if(!ST.length)return txt(el);if(!el.children.length)return fixed(el)?'':txt(el);var o=[],w=document.createTreeWalker(el,4),n;while((n=w.nextNode())){var p=n.parentElement;if(p&&p!==el&&fixed(p))continue;o.push(n.nodeValue)}return o.join(' ').replace(/\s+/g,' ').trim()}
function stuck(){var pat=/(display|result|total|target|output|summary|amount|readout|answer|tally)/i;
var ins=Array.prototype.filter.call(document.querySelectorAll('input'),function(i){return /^(text|number|search|tel|range|)$/.test((i.type||'').toLowerCase())&&i.getClientRects().length>0});
var st=ins.length>0&&ins.every(function(i){return String(i.value).trim()!==''});
var c=[];Array.prototype.forEach.call(document.querySelectorAll('output,[id],[class]'),function(el){if(c.length>=12)return;if(/^(INPUT|SELECT|TEXTAREA|BUTTON|SCRIPT|STYLE|OPTION|LABEL|HTML|BODY|HEAD|TITLE|META|LINK|TEMPLATE)$/.test(el.tagName))return;
var n=(el.id||'')+' '+(typeof el.className==='string'?el.className:'');if(el.tagName!=='OUTPUT'&&!pat.test(n))return;
if(!el.getClientRects().length)return;var cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none')return;
var t=txt(el);if(!t||t.length>60)return;
if(/^([^:]{0,30}:\s*)?(loading|calculating)(\.{1,3}|\u2026)?$/i.test(t)||/(^|[^\w])(NaN|undefined|null|-?Infinity|\[object Object\])(?![\w])/.test(live(el))||(st&&/^(-{2,}|[\u2013\u2014]+|\u2026|\.{3})\s*[a-z%]{0,6}$/i.test(t)))c.push(el)});
if(document.body)Array.prototype.forEach.call(document.body.querySelectorAll('*'),function(el){if(c.length>=12||el.children.length||c.indexOf(el)>=0)return;if(/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION|CODE|PRE|KBD|SAMP)$/.test(el.tagName))return;
if(!el.getClientRects().length)return;var cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none')return;var t=txt(el);if(t&&t.length<=120&&/(^|[^\w])(NaN|undefined|\[object Object\])(?![\w])/.test(t)&&!fixed(el))c.push(el)});
c=c.filter(function(e){return !c.some(function(d){return d!==e&&e.contains(d)})});
return c.slice(0,4).map(function(e){var k=typeof e.className==='string'?e.className.trim():'';return {sel:e.id?'#'+e.id:e.tagName.toLowerCase()+(k?'.'+k.split(/\s+/)[0]:''),text:txt(e).slice(0,40)}})}
addEventListener('load',function(){setTimeout(function(){var PH=[];try{PH=stuck()}catch(x){}
function go(){var L=E.length;
try{document.querySelectorAll('input').forEach(function(i){var t=(i.type||'text').toLowerCase();if(t==='number'||t==='range'){i.value='50'}else if(t==='checkbox'||t==='radio'){i.checked=!i.checked}else if(t==='text'||t==='search'||t===''){i.value='Test item'}else{return}
i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}))});
document.querySelectorAll('select').forEach(function(s){if(s.options.length>1){s.selectedIndex=1;s.dispatchEvent(new Event('change',{bubbles:true}))}});
Array.prototype.slice.call(document.querySelectorAll('button'),0,30).forEach(function(b){if(!b.isConnected||b.disabled)return;b.click()})}catch(x){rec('while using the page: '+x.message)}
setTimeout(function(){document.documentElement.setAttribute('data-tf-smoke',JSON.stringify({errors:E,load:L,storage:H,stuck:PH}))},300)}
if(!PH.length){go();return}
setTimeout(function(){var again=[];try{again=stuck()}catch(x){}PH=PH.filter(function(a){return again.some(function(b){return b.sel===a.sel&&b.text===a.text})});go()},1500)},800)});"#;

/// The probe runner (storage NOT blocked). Its state lives in `window.name` across reloads: every
/// probe starts on a fresh load with storage cleared; `reload` reloads keeping storage; a step is
/// saved before it acts, so a page that reloads itself resumes at the next step. Progress is also
/// mirrored onto <html> (`data-tf-probe-partial`), so a page that never finishes still shows which
/// step was in flight. Leaving the page (a link, `location.href = …`) is cancelled through the
/// Navigation API; reloads and same-document navigations go through.
///
/// `set` behaves like typing: focus, keydown, the value, input, keyup, change, blur (a checkbox /
/// radio is clicked when its state must change). Every action is followed by a settle wait, and
/// an expectation is polled for a while before it fails (debounced handlers, late renders).
/// Expectations read form controls by state: an input's value, a select's value AND its selected
/// label, a checkbox's checked state. `approx` passes when ANY number in the text is within tol
/// (a range "120 - 165 g", "165 lbs (74.8 kg)", a decimal comma). A numeric `contains` (`num`,
/// set by `parse_probe`: "40 g", "$39.33") matches the number as a whole number token, its unit
/// after it ("0" never matches "40 g", "40" never "140 g"; an all-zero fraction may follow on
/// either side, so "$92" matches "$92.00" and "92.50" matches "92.5"); other text is a case-insensitive
/// substring. `all` (set by `parse_probe` for "132 - 165 g") passes only when EVERY listed number
/// is in the text (within tol). `expect_order` matches labels
/// case-insensitively (exact, then by leading number, then contained); `attr` falls back to the
/// text when no element carries it; values that name fewer than two of the expected labels are a
/// broken probe (`nolabels`), not a page failure. `expect_unit` (Nic's default unit, AD-13) reads
/// the unit control: a select's selected option, the checked radio / checkbox (an unchecked
/// checkbox labelled with the other unit means this one), or the element(s) marked active /
/// selected / on / aria-pressed / aria-checked / aria-selected / aria-current (any class token
/// such as "unit-active" or "btn-selected", never "inactive") — among the matches, else inside
/// the first match, else among its siblings of the same tag. A checkbox slider with no unit in its
/// label reads the unit texts beside it (unchecked = the one before it). A lone toggle button with
/// no marker and no unit-named sibling shows its current unit as its text ("lb"; "Switch to kg"
/// means lb). Unit buttons marked only by colour: the one coloured button among grey ones. A unit
/// system names its units ("Imperial" = lb). The selected label must name the unit and not the
/// other one; a control that shows no selected unit of the pair is a broken probe (`nounit`).
/// A text read that passed on an element with more than `BIG_TEXT` chars of text is recorded
/// (`w`, step indices): a container, not the value.
///
/// Before / after (P1-3 c): for a probe marked `change` (`C`, an acting value criterion) or with a
/// zero read after a typed number (`z` steps, `zero_reads`), right before its first action the
/// harness records what each text / value read after it shows (`S.b`). When NO read after the
/// action changed (`S.ch`), a marked probe whose passing reads still show that, or a probe whose
/// `z` read still shows it, fails as `same` ("nothing changed after …"); one read that changed
/// clears the probe. A read whose element did not exist before counts as changed. The rule needs
/// an action that really changed a control (`S.ac`: a typed value that differs, a select moved to
/// another option, a checkbox / radio that flipped, any other click): selecting the option
/// already selected, or typing the value already there, proves nothing either way (review of
/// P1-3 c). A zero asked for (`n0`, `asked_zero_reads`: after a reset / clear / zero option)
/// counts neither way.
const PROBE_JS: &str = r#"var P=__PROBES__;var C=__CHANGE__;var S=null;try{S=JSON.parse(window.name)}catch(x){}
if(!S||S.k!=='__tfp'){S={k:'__tfp',p:0,s:0,R:[]}}
if(S.s===0){S.w=[];S.b=null;S.ch=0;S.sm=[];S.sg='';S.ac=0;S.zs=-1;S.zg='';try{localStorage.clear();sessionStorage.clear()}catch(x){}}
var WAIT=500,POLL=100,PATIENCE=1200,BIG=__BIG__;
function mark(){try{document.documentElement.setAttribute('data-tf-probe-partial',JSON.stringify({p:S.p,s:S.s,R:S.R}))}catch(x){}}
function save(){window.name=JSON.stringify(S);mark()}
mark();
try{if(window.navigation){navigation.addEventListener('navigate',function(e){if(e.navigationType==='reload'||e.hashChange||(e.destination&&e.destination.sameDocument)||!e.cancelable)return;e.preventDefault()})}}catch(x){}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(a&&!/^#/.test(a.getAttribute('href')||'')&&!(e.defaultPrevented))e.preventDefault()},false);
function done(r){if(r.ok&&S.b&&!S.ch&&S.ac){if(C[S.p]&&S.sm&&S.sm.length)r={ok:false,k:'same',at:S.sm[0],got:S.sg};else if(S.zs>=0)r={ok:false,k:'same',at:S.zs,got:S.zg}}if(S.w&&S.w.length)r.w=S.w;S.w=[];S.R.push(r);S.p++;S.s=0;if(S.p<P.length){save();location.reload()}else{window.name='';mark();document.documentElement.setAttribute('data-tf-probe',JSON.stringify(S.R))}}
function all(q){try{return Array.prototype.slice.call(document.querySelectorAll(q))}catch(x){return null}}
function fa(){var q=P[S.p]||[];for(var i=0;i<q.length;i++){if(/^(set|select|click)$/.test(q[i].op))return i}return -1}
function watch(){return !!C[S.p]||(P[S.p]||[]).some(function(t){return t.z})}
function snap(i){var q=P[S.p];S.b={};for(var j=i+1;j<q.length;j++){var t=q[j];if(t.op==='expect_text'||t.op==='expect_value'){var m=all(t.sel),e=m?(m[t.nth||0]||null):null;if(e)S.b[String(j)]=reads(e,t.op).join(' / ')}}save()}
function nm(s){return String(s==null?'':s).replace(/\s+/g,' ').trim()}
function nums(s){var o=[],re=/-?\d[\d,]*(?:\.\d+)?/g,m,t;s=String(s);while((m=re.exec(s))){t=m[0];if(t.charAt(0)==='-'&&m.index>0&&/[\w)]/.test(s.charAt(m.index-1)))t=t.slice(1);t=t.replace(/,+$/,'');if(/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)){o.push(parseFloat(t.replace(/,/g,'')))}else if(/^-?\d+,\d{1,2}$/.test(t)){o.push(parseFloat(t.replace(',','.')))}else{t.split(',').forEach(function(x){var v=parseFloat(x);if(!isNaN(v))o.push(v)})}}return o}
function tick(el){var ty=(el.type||'').toLowerCase();return el.tagName==='INPUT'&&(ty==='checkbox'||ty==='radio')}
function reads(el,op){if(el.tagName==='SELECT'){var o=el.options&&el.options[el.selectedIndex];return [nm(el.value),o?nm(o.textContent):'']}
if(tick(el))return el.checked?['checked','true','on','yes']:['unchecked','false','off','no'];
if(/^(INPUT|TEXTAREA|OUTPUT)$/.test(el.tagName))return [nm(el.value)];
return [nm(op==='expect_value'?el.textContent:(el.innerText||el.textContent))]}
function hit(el){if(typeof el.click==='function')el.click();else el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}))}
function ev(el,n,b,key){var e;try{if(key!=null){e=new KeyboardEvent(n,{bubbles:b,cancelable:true,key:key})}else if(/^(focus|blur|focusin|focusout)$/.test(n)){e=new FocusEvent(n,{bubbles:b})}else{e=new Event(n,{bubbles:b})}}catch(x){e=new Event(n,{bubbles:b})}el.dispatchEvent(e)}
function typeIn(el,v){var key=v?String(v).slice(-1):'Unidentified';ev(el,'focus',false);ev(el,'focusin',true);ev(el,'keydown',true,key);el.value=v;ev(el,'input',true);ev(el,'keyup',true,key);ev(el,'change',true);ev(el,'blur',false);ev(el,'focusout',true)}
function lead(s){var m=String(s).match(/^\D{0,12}?(-?\d+(?:\.\d+)?)/);return m?parseFloat(m[1]):null}
function esc(s){return String(s).replace(/[.*+?^${}()|[\]\\\/]/g,'\\$&')}
function numIn(g,q){try{var n=String(q.n);if(/^-?\d+\.\d*0$/.test(n))n=n.replace(/0+$/,'').replace(/\.$/,'');return new RegExp('(^|[^0-9.,])'+(q.pre?esc(q.pre)+'\\s*':'')+esc(n)+(/\./.test(n)?'0*':'(?:[.,]0+)?')+'(?![0-9]|[.,][0-9])'+(q.unit?'\\s*'+esc(q.unit):''),'i').test(g)}catch(x){return false}}
function order(st,l){var hasA=st.attr&&l.some(function(e){return e.hasAttribute(st.attr)});
var v=l.map(function(e){return nm(hasA?e.getAttribute(st.attr):(e.innerText||e.textContent))});
var want=st.order.map(function(x){return nm(x).toLowerCase()});
function which(s){s=s.toLowerCase();var i=want.indexOf(s);if(i>=0)return i;var n=lead(s);if(n!==null){for(i=0;i<want.length;i++){if(lead(want[i])===n)return i}}for(i=0;i<want.length;i++){if(want[i]&&s.indexOf(want[i])>=0)return i}return -1}
var w=[];v.forEach(function(s){var i=which(s);if(i>=0)w.push(i)});
var seen=w.filter(function(x,j){return w.indexOf(x)===j});var got=v.slice(0,12).join(', ');
if(seen.length<2)return {ok:false,k:'nolabels',got:got};
return {ok:w.join(',')===want.map(function(x,j){return j}).join(','),got:got}}
function unitOf(st,l){var U=new RegExp('(^|[^a-z\u00b0])(?:'+st.U+')(?![a-z])','i'),O=new RegExp('(^|[^a-z\u00b0])(?:'+st.O+')(?![a-z])','i');
function lab(e){var t=nm(e.innerText||e.textContent||'');var v=e.getAttribute('value')||e.getAttribute('data-unit')||e.getAttribute('aria-label')||'';if(e.id){try{var f=document.querySelector('label[for="'+e.id+'"]');if(f)t+=' '+nm(f.textContent)}catch(x){}}var p=e.closest?e.closest('label'):null;if(p)t+=' '+nm(p.textContent);return nm(t+' '+v).toLowerCase()}
function on(e){var c=(typeof e.className==='string'?e.className:'').split(/\s+/);return c.some(function(t){return /^(on|checked)$/i.test(t)||(/^([a-z0-9]+-)*(active|selected|current|chosen|checked)(-[a-z0-9]+)*$/i.test(t)&&!/(^|-)(not|non|un|in)-/i.test(t))})||['aria-pressed','aria-checked','aria-selected'].some(function(a){return e.getAttribute(a)==='true'})||(e.getAttribute('aria-current')!=null&&e.getAttribute('aria-current')!=='false')}
function one(t){t=nm(t).toLowerCase();var u=U.test(t),o=O.test(t);return u&&!o?'u':o&&!u?'o':''}
function txt(e){return nm(e.innerText||e.textContent||'')}
function sides(e){var n=(e.closest&&e.closest('label'))||e;for(var d=0;d<2&&n;d++){var p=n.previousElementSibling,q=n.nextElementSibling;var a=p?one(txt(p)):'',b=q?one(txt(q)):'';if(a&&b&&a!==b)return [a,b];n=n.parentElement}return null}
var Q=[],seen=false;
function put(w){Q.push(w==='u'?st.UL:st.OL)}
function scan(list){list.forEach(function(e){if(!e||!e.getAttribute)return;if(e.tagName==='SELECT'){seen=true;var o=e.options[e.selectedIndex];if(o)Q.push((nm(o.textContent)+' '+o.value).toLowerCase())}else if(tick(e)){seen=true;var t=lab(e);if(!one(t)&&(e.type||'').toLowerCase()==='checkbox'){var sd=sides(e);if(sd){put(e.checked?sd[1]:sd[0]);return}}if(e.checked)Q.push(t);else if((e.type||'').toLowerCase()==='checkbox'){if(O.test(t)&&!U.test(t))Q.push(st.UL);else if(U.test(t)&&!O.test(t))Q.push(st.OL)}}else if(on(e)){seen=true;Q.push(lab(e))}})}
scan(l);
if(!seen&&l.length){scan(Array.prototype.slice.call(l[0].querySelectorAll('select,input,button,[role=button],[role=radio],[role=tab],[aria-pressed],[aria-checked],[aria-selected],.active,.selected')))}
var sib=l.length===1&&l[0].parentElement?Array.prototype.slice.call(l[0].parentElement.children).filter(function(e){return e!==l[0]&&e.tagName===l[0].tagName}):[];
if(!seen&&sib.length){scan(sib)}
if(!seen&&l.length===1&&!l[0].querySelector('select,input')&&!sib.some(function(e){return one(txt(e))})){var t1=nm(txt(l[0])||l[0].value||'').toLowerCase(),w=one(t1);if(w){seen=true;var m=(w==='u'?U:O).exec(t1);var pre=m?t1.slice(0,m.index+m[1].length):'';put(/(\bto|\bswitch|\buse|\bshow|\bconvert|\bchange|\u2192|->)\W*(in\W+)?$/i.test(pre)?(w==='u'?'o':'u'):w)}}
if(!seen){var gr=(l.length>1?l:l.concat(sib)).filter(function(e){return one(txt(e))});if(gr.length>=2){var col=gr.filter(function(e){return chroma(e)>=60}),grey=gr.filter(function(e){return chroma(e)<30});if(col.length===1&&grey.length===gr.length-1){seen=true;put(one(txt(col[0])))}}}
Q=Q.filter(function(t){return !(U.test(t)&&O.test(t))});
if(!seen||!Q.some(function(t){return U.test(t)||O.test(t)}))return {ok:false,k:'nounit',got:l.map(function(e){return nm(e.innerText||e.textContent||e.value||'')}).join(' / ').slice(0,120)};
return {ok:Q.some(function(t){return U.test(t)})&&!Q.some(function(t){return O.test(t)}),got:Q.join(' / ').slice(0,120)}}
function chroma(e){try{var m=getComputedStyle(e).backgroundColor.match(/[\d.]+/g);if(!m||m.length<3||(m.length>3&&+m[3]<0.5))return 0;return Math.max(+m[0],+m[1],+m[2])-Math.min(+m[0],+m[1],+m[2])}catch(x){return 0}}
function check(st,el,l){var ok=false,got='';
if(st.op==='expect_text'||st.op==='expect_value'){var r=reads(el,st.op),ex=tick(el);
got=ex?r[0]:r.filter(function(x,j){return x!==''&&r.indexOf(x)===j}).join(' / ');
for(var j=0;j<r.length&&!ok;j++){var g=r[j].toLowerCase();
if(st.contains!=null){var c=nm(st.contains).toLowerCase();ok=ex?g===c:(st.num?numIn(g,st.num):g.indexOf(c)>=0)}
else if(st.equals!=null){ok=g===nm(st.equals).toLowerCase()}
else if(st.all!=null){var ns=nums(r[j]);ok=st.all.every(function(a){return ns.some(function(x){return Math.abs(x-a)<=st.tol})})}
else{ok=nums(r[j]).some(function(x){return Math.abs(x-st.approx)<=st.tol})}}
return {ok:ok,got:got}}
if(st.op==='expect_unit')return unitOf(st,l);
if(st.op==='expect_class')return {ok:el.classList.contains(st.cls)===st.present,got:nm(el.className)||'(no class)'};
if(st.op==='expect_count')return {ok:l.length===st.count,got:String(l.length)};
if(st.op==='expect_order')return order(st,l);
return {ok:false,got:''}}
function expect(st,i,t){var l=all(st.sel);var many=st.op==='expect_count'||st.op==='expect_order'||st.op==='expect_unit';var el=l?(l[st.nth||0]||null):null;
var r=(!l||(!many&&!el)||(st.op==='expect_unit'&&!l.length))?{ok:false,k:'nomatch',got:''}:check(st,el,l);
if(r.ok){var tv=st.op==='expect_text'||st.op==='expect_value';if(tv&&el&&!/^(INPUT|SELECT|TEXTAREA|OUTPUT)$/.test(el.tagName)&&String(el.innerText||el.textContent||'').length>BIG){S.w=(S.w||[]).concat([i])}
if(tv&&el&&S.b&&i>fa()){var same=Object.prototype.hasOwnProperty.call(S.b,String(i))&&S.b[String(i)]===reads(el,st.op).join(' / '),g=String(r.got).slice(0,120);if(!same){S.ch=1}else if(!st.n0){S.sm.push(i);if(!S.sg)S.sg=g;if(st.z&&S.zs<0){S.zs=i;S.zg=g}}}
setTimeout(step,0);return}
if(t<PATIENCE){setTimeout(function(){expect(st,i,t+POLL)},POLL);return}
done({ok:false,k:r.k||'fail',at:i,got:String(r.got).slice(0,120)})}
function step(){if(S.p>=P.length)return;var st=P[S.p][S.s];if(!st){done({ok:true});return}
var i=S.s;S.s++;save();var n0=E.length;
if(st.op==='reload'){location.reload();return}
if(/^expect_/.test(st.op)){expect(st,i,0);return}
var l=all(st.sel);var el=l?(l[st.nth||0]||null):null;if(!el){done({ok:false,k:'nomatch',at:i});return}
if(i===fa()&&!S.b&&watch())snap(i);
if(st.op==='set'){if(tick(el)){var on=/^(true|1|on|yes|checked)$/i.test(st.value);if(el.checked!==on){el.click();S.ac=1}}else{var v0=el.value;typeIn(el,st.value);if(el.value!==v0)S.ac=1}}
else if(st.op==='select'){var o=-1,os=el.options||[];for(var k=0;k<os.length;k++){if(os[k].value===st.value||nm(os[k].textContent).toLowerCase()===nm(st.value).toLowerCase()){o=k;break}}if(o<0){done({ok:false,k:'nooption',at:i,got:nm(el.value)});return}if(el.selectedIndex!==o)S.ac=1;ev(el,'focus',false);el.selectedIndex=o;ev(el,'input',true);ev(el,'change',true);ev(el,'blur',false);ev(el,'focusout',true)}
else if(st.op==='click'){var c0=tick(el)?el.checked:null;hit(el);if(c0===null||el.checked!==c0)S.ac=1}
setTimeout(function(){if(E.length>n0){done({ok:false,k:'threw',at:i,got:E[n0]});return}step()},WAIT)}
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
    let st = serde_json::to_string(&static_broken(html)).unwrap_or_else(|_| "[]".into());
    with_prelude(html, &format!("{GUARDS}{SMOKE_JS}").replace(['\r', '\n'], "").replace("__STATIC__", &js_data(&st)))
}

/// The leaf elements the page's own markup writes with NaN / undefined / null / Infinity /
/// [object Object] in their text, as the smoke keys them: "#id|text" (an element with an id) or
/// "tag|text", the text whitespace-collapsed and lowercased (`SMOKE_JS` skips these, also inside
/// an output-like container such as "#answers": static copy, not a value computed from missing
/// data). Scripts, styles, templates and comments are left out; at most 200. Pure.
pub fn static_broken(html: &str) -> Vec<String> {
    static SKIP: OnceLock<regex::Regex> = OnceLock::new();
    static LEAF: OnceLock<regex::Regex> = OnceLock::new();
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    static BROKEN: OnceLock<regex::Regex> = OnceLock::new();
    let body = rx(&SKIP, r"(?is)<!--.*?-->|<script\b.*?</script\s*>|<style\b.*?</style\s*>|<template\b.*?</template\s*>").replace_all(html, " ");
    let mut out: Vec<String> = Vec::new();
    for c in rx(&LEAF, r"<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>([^<]+)</([a-zA-Z][a-zA-Z0-9-]*)\s*>").captures_iter(&body) {
        if !c[1].eq_ignore_ascii_case(&c[4]) {
            continue;
        }
        let text = c[3].replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !rx(&BROKEN, r"(?:^|[^\w])(?:NaN|undefined|null|-?Infinity|\[object Object\])(?:[^\w]|$)").is_match(&text) {
            continue;
        }
        let key = match rx(&ID, r#"(?i)(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).captures(&c[2]) {
            Some(m) => format!("#{}", m.get(1).or(m.get(2)).or(m.get(3)).map(|x| x.as_str()).unwrap_or("")),
            None => c[1].to_ascii_lowercase(),
        };
        let k = format!("{key}|{}", text.to_lowercase());
        if !out.contains(&k) && out.len() < 200 {
            out.push(k);
        }
    }
    out
}

/// JSON made safe inside an inline <script>: '<', '>', '&' and non-ASCII as \u escapes (a page
/// without a charset still reads the data right). Pure.
fn js_data(json: &str) -> String {
    let mut data = String::new();
    for ch in json.chars() {
        match ch {
            '<' | '>' | '&' => data.push_str(&format!("\\u{:04x}", ch as u32)),
            c if c.is_ascii() => data.push(c),
            c => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    data.push_str(&format!("\\u{:04x}", u));
                }
            }
        }
    }
    data
}

/// What names a unit on a unit control: its spellings, plus its system ("Imperial" / "US" for
/// lb, mi, °F, oz, in, ft; "Metric" / "SI" for kg, km, °C, g, cm, m). Pure.
fn unit_pattern(key: &str) -> String {
    format!("{}|{}", unit_spellings(key).0, if metric(key) { "metric|si" } else { "imperial|us|us customary" })
}

/// The page with the probe runner injected (the probes as inert JSON; an `expect_unit` step gets
/// its unit spellings from the table here, never from the stored step). Non-ASCII is escaped
/// (`\u00b0` for "°"), so a page without a charset still reads the data right. Pure.
pub fn with_probes(html: &str, probes: &[Probe]) -> String {
    let steps: Vec<Vec<Value>> = probes
        .iter()
        .map(|p| {
            let (zero, asked) = (zero_reads(&p.steps), asked_zero_reads(&p.steps));
            p.steps
                .iter()
                .enumerate()
                .map(|(i, st)| {
                    let mut st = st.clone();
                    if zero.contains(&i) {
                        st["z"] = json!(1);
                    }
                    if asked.contains(&i) {
                        st["n0"] = json!(1);
                    }
                    if let (true, Some(u), Some(o)) = (st["op"] == "expect_unit", st["unit"].as_str().map(String::from), st["other"].as_str().map(String::from)) {
                        st["U"] = json!(unit_pattern(&u));
                        st["O"] = json!(unit_pattern(&o));
                        st["UL"] = json!(unit_label(&u).to_lowercase());
                        st["OL"] = json!(unit_label(&o).to_lowercase());
                    }
                    st
                })
                .collect()
        })
        .collect();
    let data = js_data(&serde_json::to_string(&steps).unwrap_or_else(|_| "[]".into()));
    // Newlines go first (JSON has none raw), then the data.
    let change: Vec<u8> = probes.iter().map(|p| u8::from(p.change)).collect();
    let change = serde_json::to_string(&change).unwrap_or_else(|_| "[]".into());
    let js = format!("{GUARDS}{PROBE_JS}").replace(['\r', '\n'], "").replace("__BIG__", &BIG_TEXT.to_string()).replace("__CHANGE__", &change).replace("__PROBES__", &data);
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

/// The output-like elements the smoke found still showing a placeholder after load, before any
/// interaction: (selector, text). Pure.
pub fn parse_stuck(dom: &str) -> Vec<(String, String)> {
    attr_json(dom, "data-tf-smoke")
        .and_then(|v| v["stuck"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| Some((clip_chars(x["sel"].as_str()?, 60), clip_chars(x["text"].as_str()?, 40))))
        .take(4)
        .collect()
}

/// The gate's fix line for outputs still showing a placeholder: "the page still shows
/// 'Loading...' in #targetDisplay after it loaded (render on startup)"; a broken value (NaN,
/// undefined, [object Object]) is named as one: "the page shows 'NaN%' in #progressText after it
/// loaded (a value computed from missing data: compute it from real values on startup)". Pure.
pub fn stuck_line(stuck: &[(String, String)]) -> String {
    static BROKEN: OnceLock<regex::Regex> = OnceLock::new();
    let broken = |t: &str| rx(&BROKEN, r"(?:^|[^\w])(?:NaN|undefined|\[object Object\])(?:[^\w]|$)").is_match(t);
    let part = |v: Vec<&(String, String)>| v.iter().take(3).map(|(sel, text)| format!("'{text}' in {sel}")).collect::<Vec<_>>().join(" and ");
    let (bad, waiting): (Vec<&(String, String)>, Vec<&(String, String)>) = stuck.iter().partition(|(_, t)| broken(t));
    let mut out = Vec::new();
    if !waiting.is_empty() || bad.is_empty() {
        out.push(format!("the page still shows {} after it loaded (render on startup)", part(waiting)));
    }
    if !bad.is_empty() {
        out.push(format!("the page shows {} after it loaded (a value computed from missing data: compute it from real values on startup)", part(bad)));
    }
    out.join("; ")
}

/// The smoke result out of a `--dump-dom` print: (errors, how many happened on load, the page
/// lines where a blocked storage access happened). Pure.
pub fn parse_dump(dom: &str) -> Option<(Vec<String>, usize, Vec<usize>)> {
    let v = attr_json(dom, "data-tf-smoke")?;
    let errs = v["errors"].as_array()?.iter().filter_map(|e| e.as_str()).map(String::from).collect();
    let lines = v["storage"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as usize).collect()).unwrap_or_default();
    Some((errs, v["load"].as_u64().unwrap_or(0) as usize, lines))
}

/// Can probes run on this machine at all (a local Edge)?
pub fn edge_available() -> bool {
    browser().is_some()
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
    /// Ran but gave no result (timeout, the page hung, reloaded forever or navigated away), with
    /// whatever page Edge still printed.
    Failed(String, Option<String>),
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
                    drop(job);
                    let dom = std::fs::read_to_string(&out_path).ok().filter(|d| !d.trim().is_empty());
                    return EdgeOut::Failed(format!("no result after {}s: the page hung, kept reloading or never finished", timeout.as_secs()), dom);
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
        return EdgeOut::Failed("the page navigated away, replaced itself or never finished the check".into(), Some(dom));
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
    /// Ran: uncaught errors as fix lines, the page lines where a blocked storage access
    /// happened (each one was caught when `errors` has no storage error), and the output-like
    /// elements still showing a placeholder after load, before any interaction (selector, text).
    Ran { errors: Vec<String>, storage_lines: Vec<usize>, stuck: Vec<(String, String)> },
}

/// Load the page in headless Edge (network unreachable, own throwaway profile, storage blocked),
/// note what still shows a placeholder after load, exercise its controls, and report what threw.
/// Blocking.
pub fn runtime_smoke(page: &Path, timeout: Duration) -> Smoke {
    let Ok(html) = std::fs::read_to_string(page) else { return Smoke::Skipped("the staged page could not be read".into()) };
    match run_edge(&with_harness(&html), "data-tf-smoke", timeout, 5000) {
        EdgeOut::Unavailable(r) => Smoke::Skipped(r),
        EdgeOut::Failed(r, _) => Smoke::Failed(r),
        EdgeOut::Dom(dom) => match parse_dump(&dom) {
            Some((errs, load, lines)) => Smoke::Ran {
                errors: errs.iter().enumerate().map(|(i, e)| if i < load { format!("the page throws on load: {e}") } else { format!("the page throws when its controls are used: {e}") }).collect(),
                storage_lines: lines,
                stuck: parse_stuck(&dom),
            },
            None => Smoke::Failed("the page's result could not be read".into()),
        },
    }
}

/// Run the verifier's probes in headless Edge (storage working), each probe in its own Edge run on
/// a fresh load: a probe that hangs the page or navigates away is THAT probe's failure (with the
/// step in flight when Edge still printed the page) and never costs the other probes their
/// results. `each` caps one probe, `total` the whole run (probes past it are "not run"). Blocking.
pub fn run_probes(page: &Path, probes: &[Probe], each: Duration, total: Duration) -> ProbeRun {
    if probes.is_empty() {
        return ProbeRun::Skipped("no probes".into());
    }
    let Ok(html) = std::fs::read_to_string(page) else { return ProbeRun::Skipped("the staged page could not be read".into()) };
    let deadline = Instant::now() + total;
    let mut out: Vec<ProbeResult> = Vec::new();
    for p in probes {
        let left = deadline.saturating_duration_since(Instant::now());
        let not_run = |why: String| ProbeResult { answer: p.answer, ran: false, passed: false, error: false, detail: why, carried: p.carried, specific: false, value_specific: false, missing: false };
        if left < Duration::from_secs(3) {
            out.push(not_run("not run (the probes ran out of time)".into()));
            continue;
        }
        let one = std::slice::from_ref(p);
        // Virtual time: the load, then per step a settle wait or an expectation's patience.
        let budget = 2500 + 1400 * p.steps.len() as u64;
        match run_edge(&with_probes(&html, one), "data-tf-probe", left.min(each), budget) {
            EdgeOut::Unavailable(r) if out.is_empty() => return ProbeRun::Skipped(r),
            EdgeOut::Unavailable(r) => out.push(not_run(format!("not run ({r})"))),
            EdgeOut::Dom(dom) => match attr_json(&dom, "data-tf-probe") {
                Some(v) => out.extend(probe_results(one, &v)),
                None => out.push(unfinished(p, attr_json(&dom, "data-tf-probe-partial").as_ref(), "its result could not be read")),
            },
            EdgeOut::Failed(r, dom) => out.push(unfinished(p, dom.as_deref().and_then(|d| attr_json(d, "data-tf-probe-partial")).as_ref(), &r)),
        }
    }
    ProbeRun::Ran(out)
}

#[cfg(test)]
mod tests;
