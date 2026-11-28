//! Tony's latency fast path (Section 26 round 2). Three switches in `fastpath.json` beside
//! providers.json, ALL OFF by default (missing or broken file = all off, today's behaviour):
//!
//!   smallTalkSkipsTools  a whole-line greeting / thanks / "how's it going" never runs the tool
//!                        planner or the router (the TOOLS line in his prompt is kept as is, so
//!                        the cached prompt prefix still holds). Today a small-talk line that
//!                        names a tool word ("thanks for the weather") can wake the router.
//!   instantCues          a whole-line time / date / weather / PC-stats ask is answered with no
//!                        model run (from the clock or the stats cache); anything the cache can't
//!                        answer falls through to the normal turn. Same idea as the desktop
//!                        voice path's S20.10 cues, now on every turn (phone, inbox, typed).
//!   statsCache           a background job keeps CPU / RAM / GPU / VRAM / GPU temperature
//!                        (every 5 s) and home weather (every 10 min) in memory; Tony's home
//!                        `weather.current` and the stats cue read it instead of a live lookup.
//!
//! "What's pending" is deliberately NOT a cue: it stays Tony's live Finance read (Nic's S20.10
//! decision). Music controls already answer without the model (the Spotify verbatim path).

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use super::routing::{normalize, strip_address};

pub const FILE: &str = "fastpath.json";
pub const STATS_EVERY: Duration = Duration::from_secs(5);
pub const WEATHER_EVERY: Duration = Duration::from_secs(600);
/// A cached weather reading older than this is never used (the live tool runs instead).
pub const WEATHER_FRESH: Duration = Duration::from_secs(1800);
/// Stats older than this are never used.
pub const STATS_FRESH: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FastPath {
    pub small_talk_skips_tools: bool,
    pub instant_cues: bool,
    pub stats_cache: bool,
}

/// fastpath.json in `dir`; missing / unreadable = everything off.
pub fn read(dir: &Path) -> FastPath {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok()).unwrap_or_default()
}

pub fn write(dir: &Path, f: &FastPath) -> Result<(), String> {
    let path = dir.join(FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(f).map_err(|e| e.to_string())?).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("save {}: {e}", path.display()))
}

fn core(text: &str, os_name: &str) -> String {
    normalize(&strip_address(text, os_name)).trim().to_string()
}

/// A whole line of small talk (pure). Anything with a request in it is not.
pub fn small_talk(text: &str, os_name: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let c = core(text, os_name);
    if c.is_empty() {
        // "Hey Tony" is all address: nothing but a greeting (or his name) was said.
        return !normalize(text).trim().is_empty();
    }
    if c.split(' ').count() > 8 {
        return false;
    }
    RE.get_or_init(|| {
        regex::Regex::new(r"^(?:(?:hey|hi|hello|yo|sup|morning|good (?:morning|afternoon|evening|night)|evening|night)(?: there| man| buddy| bud| pal)?|how(?:'?s| is| are)? (?:it going|you|you doing|things|life|your day)(?: today)?|what'?s up|whats up|how are you(?: doing)?|thanks?(?: you)?(?: so much| a lot)?(?: man| buddy)?(?:,? that'?s all(?: for now)?)?|thank you(?: so much)?|cheers|cool|nice|great|awesome|perfect|ok(?:ay)?|got it|sounds good|that'?s all(?: for now)?|never ?mind|nevermind|see you(?: later)?|later|bye|good ?bye|talk (?:to you )?later|you there|are you there)$").unwrap()
    })
    .is_match(&c)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cue {
    Time,
    Date,
    Weather,
    Stats,
}

/// A whole-line ask an instant cue answers (pure).
pub fn instant_cue(text: &str, os_name: &str) -> Option<Cue> {
    static RE: std::sync::OnceLock<[regex::Regex; 4]> = std::sync::OnceLock::new();
    let c = core(text, os_name);
    let re = RE.get_or_init(|| {
        [
            regex::Regex::new(r"^(?:what(?:'?s| is)? (?:the )?time(?: is it)?(?: now| right now)?|what time is it(?: now| right now)?|time|(?:got|do you have) the time|tell me the time)$").unwrap(),
            regex::Regex::new(r"^(?:what(?:'?s| is)? (?:the |today'?s )?date(?: today)?|what day is (?:it|today)|what'?s today|what is today|which day is it)$").unwrap(),
            regex::Regex::new(r"^(?:what(?:'?s| is)? the weather(?: like)?(?: (?:today|now|right now|outside|out there))?|how'?s the weather(?: (?:today|now|outside))?|weather|is it (?:cold|hot|warm|raining|snowing) (?:out|outside)(?: today)?|how cold is it(?: out| outside)?|what'?s it like (?:out|outside))$").unwrap(),
            regex::Regex::new(r"^(?:how'?s|how is|check|what'?s|what is)? ?(?:my |the )?(?:gpu|cpu|vram|pc|computer|system)(?: (?:doing|load|usage|temp|temperature|stats|status))?(?: (?:doing|looking|like))?|(?:gpu|cpu) (?:temp|temperature|usage|load)|how hot is (?:my |the )?(?:gpu|pc|computer)$").unwrap(),
        ]
    });
    [Cue::Time, Cue::Date, Cue::Weather, Cue::Stats].into_iter().zip(re.iter()).find(|(_, r)| r.is_match(&c)).map(|(cue, _)| cue)
}

// ── The cache ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Stats {
    pub at: Instant,
    pub cpu_pct: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub gpu: Option<super::system::GpuStats>,
}

#[derive(Default)]
struct Cache {
    stats: Option<Stats>,
    /// (when, the weather tool's full text for home)
    weather: Option<(Instant, String)>,
}

fn cache() -> &'static RwLock<Cache> {
    static C: std::sync::OnceLock<RwLock<Cache>> = std::sync::OnceLock::new();
    C.get_or_init(RwLock::default)
}

pub fn put_stats(s: Stats) {
    cache().write().unwrap().stats = Some(s);
}

pub fn put_weather(text: String) {
    cache().write().unwrap().weather = Some((Instant::now(), text));
}

/// Home weather, if a fresh enough reading is cached.
pub fn cached_weather() -> Option<String> {
    cache().read().unwrap().weather.as_ref().filter(|(at, _)| at.elapsed() < WEATHER_FRESH).map(|(_, t)| t.clone())
}

pub fn cached_stats() -> Option<Stats> {
    cache().read().unwrap().stats.clone().filter(|s| s.at.elapsed() < STATS_FRESH)
}

#[cfg(test)]
pub fn clear_cache() {
    *cache().write().unwrap() = Cache::default();
}

// ── Answers (pure) ────────────────────────────────────────────────────────────

/// "Toronto: 3°C (feels -1°C), overcast, …\n<forecast>" → "In Toronto it's 3°C (feels -1°C), overcast, …"
pub fn weather_brief(full: &str) -> Option<String> {
    let first = full.lines().next()?.trim();
    let (label, rest) = first.split_once(": ")?;
    (!rest.is_empty() && !rest.contains("NaN")).then(|| format!("In {label} it's {rest}"))
}

pub fn stats_brief(s: &Stats) -> String {
    let mut out = format!("CPU at {:.0}%, RAM {:.1} of {:.0} GB", s.cpu_pct, s.mem_used_mb as f64 / 1024.0, s.mem_total_mb as f64 / 1024.0);
    if let Some(g) = &s.gpu {
        out.push_str(&format!("; GPU {:.0}% busy, VRAM {:.1} of {:.0} GB", g.util_pct, g.vram_used_mb as f64 / 1024.0, g.vram_total_mb as f64 / 1024.0));
        if let Some(t) = g.temp_c {
            out.push_str(&format!(", {t:.0}°C"));
        }
    }
    out.push('.');
    out
}

/// The instant answer, or None when this cue can't be answered from what's loaded (the normal
/// turn runs instead). `now` is the local clock.
pub fn answer(cue: Cue, now: chrono::DateTime<chrono::Local>, weather: Option<&str>, stats: Option<&Stats>) -> Option<String> {
    match cue {
        Cue::Time => Some(format!("It's {}.", now.format("%-I:%M %p"))),
        Cue::Date => Some(format!("It's {}.", now.format("%A, %B %-d"))),
        Cue::Weather => weather.and_then(weather_brief),
        Cue::Stats => stats.map(stats_brief),
    }
}

/// The tool name the turn's step and result report for a cue.
pub fn cue_tool(cue: Cue) -> &'static str {
    match cue {
        Cue::Time | Cue::Date => "time.now",
        Cue::Weather => "weather.current",
        Cue::Stats => "system.stats",
    }
}

// ── The background job ────────────────────────────────────────────────────────

/// Started once at app start-up. Does nothing while `statsCache` is off (checked every tick).
pub fn spawn(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let mut last_weather: Option<Instant> = None;
        loop {
            tokio::time::sleep(STATS_EVERY).await;
            let st = app.state::<super::dispatch::DispatchState>();
            let Some(dir) = st.config_dir() else { continue };
            if !read(&dir).stats_cache {
                continue;
            }
            if let Ok(s) = super::system::sample(&app.state::<super::system::SysState>()) {
                put_stats(Stats { at: Instant::now(), cpu_pct: s.cpu_pct, mem_used_mb: s.mem_used_mb, mem_total_mb: s.mem_total_mb, gpu: super::system::gpu_cached() });
            }
            if last_weather.is_none_or(|t| t.elapsed() >= WEATHER_EVERY) {
                last_weather = Some(Instant::now());
                if let Ok(w) = super::mcp::weather(&st, "").await {
                    put_weather(w);
                }
            }
        }
    });
}

#[tauri::command]
pub fn fastpath_get(state: tauri::State<'_, super::dispatch::DispatchState>) -> Result<FastPath, String> {
    Ok(state.config_dir().map(|d| read(&d)).unwrap_or_default())
}

#[tauri::command]
pub fn fastpath_set(state: tauri::State<'_, super::dispatch::DispatchState>, value: FastPath) -> Result<FastPath, String> {
    let dir = state.config_dir().ok_or("no config folder yet")?;
    write(&dir, &value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_by_default_and_fails_closed() {
        let dir = std::env::temp_dir().join(format!("cc-fastpath-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read(&dir), FastPath::default());
        std::fs::write(dir.join(FILE), "{broken").unwrap();
        assert_eq!(read(&dir), FastPath::default());
        let on = FastPath { small_talk_skips_tools: true, instant_cues: true, stats_cache: false };
        write(&dir, &on).unwrap();
        assert_eq!(read(&dir), on);
        std::fs::write(dir.join(FILE), r#"{"instantCues":true}"#).unwrap();
        assert_eq!(read(&dir), FastPath { instant_cues: true, ..Default::default() });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_talk_is_whole_line_only() {
        for t in ["Hey Tony", "hi", "How's it going?", "Thanks, that's all for now", "thank you so much", "good morning", "you there?", "ok", "Tony, how are you doing?"] {
            assert!(small_talk(t, "Tony"), "{t} -> {:?}", core(t, "Tony"));
        }
        for t in ["thanks for the weather, what about tomorrow", "hey can you check my email", "how's the weather", "what time is it", "play some music", "hi tony what's on my calendar", ""] {
            assert!(!small_talk(t, "Tony"), "{t}");
        }
    }

    #[test]
    fn instant_cues_match_whole_simple_asks_only() {
        assert_eq!(instant_cue("What time is it?", "Tony"), Some(Cue::Time));
        assert_eq!(instant_cue("Tony, what's the time", "Tony"), Some(Cue::Time));
        assert_eq!(instant_cue("What day is it", "Tony"), Some(Cue::Date));
        assert_eq!(instant_cue("What's the weather like?", "Tony"), Some(Cue::Weather));
        assert_eq!(instant_cue("is it cold outside", "Tony"), Some(Cue::Weather));
        assert_eq!(instant_cue("how's my GPU doing", "Tony"), Some(Cue::Stats));
        assert_eq!(instant_cue("gpu temp", "Tony"), Some(Cue::Stats));
        for t in ["what time is my meeting", "what's the weather in Paris", "what time does the store close", "weather for the weekend", "remind me what day the party is", "how's the droplet", "what's pending"] {
            assert_eq!(instant_cue(t, "Tony"), None, "{t}");
        }
    }

    #[test]
    fn answers_come_from_the_clock_and_the_cache_or_not_at_all() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 11, 27, 17, 46, 0).unwrap();
        assert_eq!(answer(Cue::Time, now, None, None).as_deref(), Some("It's 5:46 PM."));
        assert_eq!(answer(Cue::Date, now, None, None).as_deref(), Some("It's Friday, November 27."));
        assert_eq!(answer(Cue::Weather, now, None, None), None, "no cached reading: the live tool runs");
        let w = "Toronto: 3°C (feels -1°C), overcast, humidity 80%, wind 12 km/h.\n2026-11-27: overcast, 0–5°C, precip 10%";
        assert_eq!(answer(Cue::Weather, now, Some(w), None).as_deref(), Some("In Toronto it's 3°C (feels -1°C), overcast, humidity 80%, wind 12 km/h."));
        assert_eq!(weather_brief("Toronto: NaN°C"), None);
        let s = Stats { at: Instant::now(), cpu_pct: 12.4, mem_used_mb: 20_480, mem_total_mb: 65_536, gpu: Some(super::super::system::GpuStats { name: "RTX 3060".into(), util_pct: 23.0, vram_used_mb: 10_749, vram_total_mb: 12_288, temp_c: Some(54.0) }) };
        assert_eq!(answer(Cue::Stats, now, None, Some(&s)).as_deref(), Some("CPU at 12%, RAM 20.0 of 64 GB; GPU 23% busy, VRAM 10.5 of 12 GB, 54°C."));
        assert_eq!(answer(Cue::Stats, now, None, None), None);
    }

    #[test]
    fn the_cache_expires() {
        clear_cache();
        assert!(cached_weather().is_none() && cached_stats().is_none());
        put_weather("Toronto: 3°C".into());
        assert_eq!(cached_weather().as_deref(), Some("Toronto: 3°C"));
        put_stats(Stats { at: Instant::now() - STATS_FRESH - Duration::from_secs(1), cpu_pct: 1.0, mem_used_mb: 1, mem_total_mb: 2, gpu: None });
        assert!(cached_stats().is_none(), "stale stats are never used");
        clear_cache();
    }
}
