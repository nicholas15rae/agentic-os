//! Local media ducking (P4): while you talk to Tony, the Spotify desktop app's own Windows audio
//! session fades down BY a percentage (default 15 %, so it plays at 85 %) in about 120 ms and
//! ramps back in about 320 ms. WASAPI per-session volume (`ISimpleAudioVolume` on Spotify.exe
//! sessions): local, no network, no account, $0. The Spotify Web API duck in `spotify.rs` is only
//! the fallback for when no local Spotify session exists.
//!
//! ```text
//!  media_duck ─► worker thread (CoInitializeEx MTA, owns every COM object)
//!                 ├─ ToolHelp snapshot → our own process tree (the WebView2 audio utility that
//!                 │  plays Tony and the cues is a grandchild: never ducked)
//!                 ├─ every active render endpoint → its sessions → eligible Spotify.exe sessions
//!                 ├─ media-duck.json written BEFORE the first level change (crash recovery)
//!                 └─ dB fade, timed by Instant::elapsed (10 ms steps; Windows sleeps can be 15.6 ms)
//! ```
//!
//! Rules: the original level is snapshotted once per live duck (never re-snapshotted over our own
//! level); a restore leaves alone a session the user moved since (> 0.02 from what we last set); a
//! duck arriving mid-ramp reverses from the current level. Silent: no logs, no process names.
//! Windows persists each app's session volume and release builds abort on panic, so a crash
//! mid-duck would strand Spotify at 85 %: `recover` (startup) and `restore_now` (exit) undo it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Default reduction (%): plays at 85 % of the level it had.
pub const DEFAULT_REDUCTION: u8 = 15;
/// The Settings slider's top end.
pub const MAX_REDUCTION: u8 = 50;
/// Fade down / ramp up (ms). Hard-coded defaults; callers may only nudge them within bounds.
pub const FADE_DOWN_MS: u32 = 120;
pub const FADE_UP_MS: u32 = 320;
/// A session this far from the level we last set was changed by the user: leave it alone.
pub const USER_MOVED: f32 = 0.02;
/// Float slack on the comparison above.
const EPS: f32 = 1e-4;
/// The only scope (decision: Spotify only, no "all apps" option).
const SCOPE_EXE: &str = "spotify.exe";
/// The dB floor for the fade curve (silence can't be expressed in dB).
const FLOOR_DB: f32 = -60.0;
const FILE_NAME: &str = "media-duck.json";

/// What `media_duck` reports. `spotify_local`: an active Spotify.exe session exists on this PC
/// (ducked or not); the TS side only falls back to the Web API when this is false AND the
/// answer is known (`timed_out` false).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckReport {
    pub ducked: u32,
    pub spotify_local: bool,
    /// The worker didn't answer in time (first call: COM start-up + endpoint scan). The queued
    /// fade may still land, so "no local Spotify" is unknown, not false: no Web API fallback.
    pub timed_out: bool,
}

impl DuckReport {
    /// The report for a duck whose answer never came back (or whose blocking task failed).
    pub fn unknown() -> Self {
        DuckReport { timed_out: true, ..Default::default() }
    }

    /// A worker answer, or `unknown()` when it timed out.
    pub fn or_unknown(r: Option<DuckReport>) -> Self {
        r.unwrap_or_else(Self::unknown)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckStatus {
    /// Sessions currently held below their original level (or ramping back).
    pub ducked: u32,
    /// Sessions from a crashed run still waiting for Spotify to come back.
    pub pending_recovery: u32,
}

// ── Pure helpers (no COM; unit-tested) ──────────────────────────────────────

pub fn clamp_reduction(r: Option<u8>) -> u8 {
    r.unwrap_or(DEFAULT_REDUCTION).min(MAX_REDUCTION)
}

pub fn clamp_fade_down(ms: Option<u32>) -> u32 {
    ms.unwrap_or(FADE_DOWN_MS).clamp(60, 200)
}

pub fn clamp_fade_up(ms: Option<u32>) -> u32 {
    ms.unwrap_or(FADE_UP_MS).clamp(60, 600)
}

/// The ducked level: `original` lowered BY `reduction` %.
pub fn duck_target(original: f32, reduction: u8) -> f32 {
    (original.clamp(0.0, 1.0) * f32::from(100 - reduction.min(100)) / 100.0).clamp(0.0, 1.0)
}

fn to_db(v: f32) -> f32 {
    if v <= 0.0 {
        FLOOR_DB
    } else {
        (20.0 * v.log10()).max(FLOOR_DB)
    }
}

/// The level at progress `t` (0..=1) of a fade from `from` to `to`, interpolated in dB so it
/// sounds even. Exact at both ends, monotonic, never outside the two endpoints.
pub fn fade_curve(from: f32, to: f32, t: f32) -> f32 {
    if t <= 0.0 {
        return from;
    }
    if t >= 1.0 {
        return to;
    }
    let db = to_db(from) + (to_db(to) - to_db(from)) * t;
    let (lo, hi) = if from <= to { (from, to) } else { (to, from) };
    10f32.powf(db / 20.0).clamp(lo, hi)
}

/// Fade progress from wall time (not a step count, so coarse sleeps can't stretch a fade).
pub fn fade_progress(elapsed: Duration, fade_ms: u32) -> f32 {
    if fade_ms == 0 {
        return 1.0;
    }
    (elapsed.as_secs_f32() * 1000.0 / fade_ms as f32).min(1.0)
}

/// `root` and every descendant in a `(pid, parent pid)` snapshot. Terminates on parent cycles and
/// self-parented entries (PID reuse can make either appear in a ToolHelp snapshot).
pub fn own_tree(root: u32, procs: &[(u32, u32)]) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in procs {
        if pid != 0 && pid != ppid {
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut tree = HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        for &k in children.get(&p).map(Vec::as_slice).unwrap_or_default() {
            if tree.insert(k) {
                stack.push(k);
            }
        }
    }
    tree
}

/// One audio session as the scan saw it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionInfo {
    pub pid: u32,
    /// Image file name ("Spotify.exe"); never logged.
    pub exe: String,
    pub system_sounds: bool,
    pub active: bool,
    pub multi_process: bool,
    pub muted: bool,
}

/// The image name is in scope (Spotify.exe, any case, with or without a path).
pub fn in_scope(exe: &str) -> bool {
    exe.rsplit(['\\', '/']).next().unwrap_or(exe).eq_ignore_ascii_case(SCOPE_EXE)
}

/// Spotify is playing through a local session of its own (not ours, not the system sounds).
pub fn is_local_spotify(s: &SessionInfo, own: &HashSet<u32>) -> bool {
    !s.system_sounds && s.active && s.pid != 0 && !own.contains(&s.pid) && in_scope(&s.exe)
}

/// A session the duck may lower: local Spotify, single-process, not muted.
pub fn eligible(s: &SessionInfo, own: &HashSet<u32>) -> bool {
    is_local_spotify(s, own) && !s.multi_process && !s.muted
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreDecision {
    /// Still at the level we set: put the original back.
    Restore,
    /// Someone moved it since: leave it, forget it.
    UserChanged,
}

pub fn restore_decision(last_set: f32, current: f32) -> RestoreDecision {
    if (current - last_set).abs() <= USER_MOVED + EPS {
        RestoreDecision::Restore
    } else {
        RestoreDecision::UserChanged
    }
}

// ── Crash-recovery file ─────────────────────────────────────────────────────

/// One ducked session, written before its level is first changed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Persisted {
    /// The session instance identifier (stable while that Spotify process lives).
    pub key: String,
    pub exe: String,
    pub original: f32,
    pub target: f32,
}

#[derive(Default, Serialize, Deserialize)]
struct DuckFile {
    sessions: Vec<Persisted>,
}

pub fn save(path: &Path, sessions: &[Persisted]) -> std::io::Result<()> {
    if sessions.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let body = serde_json::to_vec(&DuckFile { sessions: sessions.to_vec() }).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

pub fn load(path: &Path) -> Vec<Persisted> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<DuckFile>(&b).ok()).map(|f| f.sessions).unwrap_or_default()
}

/// A session the recovery scan found (any state; never our own tree).
#[derive(Clone, Debug, PartialEq)]
pub struct FoundLevel {
    pub key: String,
    pub exe: String,
    pub level: f32,
}

#[derive(Debug, PartialEq)]
pub enum Recovery {
    /// Put `original` back on these sessions (indices into the scan).
    Restore(Vec<usize>),
    /// The session is there but no longer at the duck level: the user changed it, forget it.
    UserChanged,
    /// No session of that app right now (Spotify closed): keep the entry for later.
    Missing,
}

/// What to do with a stranded duck. The same session if it still exists; otherwise (Spotify was
/// restarted, and Windows kept the per-app level) every session of the same app still at the
/// duck target.
pub fn recover_plan(p: &Persisted, found: &[FoundLevel]) -> Recovery {
    let at_target = |f: &FoundLevel| restore_decision(p.target, f.level) == RestoreDecision::Restore;
    if let Some(i) = found.iter().position(|f| f.key == p.key) {
        return if at_target(&found[i]) { Recovery::Restore(vec![i]) } else { Recovery::UserChanged };
    }
    let same_app: Vec<usize> = (0..found.len()).filter(|&i| exe_eq(&found[i].exe, &p.exe)).collect();
    if same_app.is_empty() {
        return Recovery::Missing;
    }
    let hits: Vec<usize> = same_app.into_iter().filter(|&i| at_target(&found[i])).collect();
    if hits.is_empty() {
        Recovery::UserChanged
    } else {
        Recovery::Restore(hits)
    }
}

fn exe_eq(a: &str, b: &str) -> bool {
    let name = |s: &str| s.rsplit(['\\', '/']).next().unwrap_or(s).to_ascii_lowercase();
    name(a) == name(b)
}

// ── The duck state machine (generic over the session, so it's testable without COM) ─────────

/// One session's volume control.
pub trait SessionVolume {
    fn level(&self) -> Option<f32>;
    /// False = the session is gone (device removed, app closed): forget it.
    fn set_level(&self, v: f32) -> bool;
}

pub struct Candidate<S> {
    pub key: String,
    pub exe: String,
    pub s: S,
}

struct Entry<S> {
    key: String,
    exe: String,
    original: f32,
    last_set: f32,
    from: f32,
    to: f32,
    s: S,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RampKind {
    Down,
    Up,
}

#[derive(Clone, Copy)]
struct Ramp {
    start: Instant,
    ms: u32,
    kind: RampKind,
}

pub struct Engine<S> {
    entries: Vec<Entry<S>>,
    ramp: Option<Ramp>,
}

impl<S> Default for Engine<S> {
    fn default() -> Self {
        Self { entries: Vec::new(), ramp: None }
    }
}

impl<S: SessionVolume> Engine<S> {
    /// Start (or extend) a duck. Known sessions keep their snapshot unless the user moved them;
    /// new ones are snapshotted now. Every entry then fades from where it is to its target.
    /// Returns how many sessions are held down. Nothing changes until `tick`.
    pub fn duck(&mut self, found: Vec<Candidate<S>>, reduction: u8, fade_ms: u32, now: Instant) -> u32 {
        for c in found {
            let Some(cur) = c.s.level() else { continue };
            if let Some(e) = self.entries.iter_mut().find(|e| e.key == c.key) {
                if restore_decision(e.last_set, cur) == RestoreDecision::UserChanged {
                    e.original = cur;
                    e.last_set = cur;
                }
                e.s = c.s;
            } else if cur > 0.0 {
                self.entries.push(Entry { key: c.key, exe: c.exe, original: cur, last_set: cur, from: cur, to: cur, s: c.s });
            }
        }
        for e in &mut self.entries {
            e.from = e.last_set;
            e.to = duck_target(e.original, reduction);
        }
        self.ramp = (!self.entries.is_empty()).then_some(Ramp { start: now, ms: fade_ms, kind: RampKind::Down });
        self.entries.len() as u32
    }

    /// Ramp every session we still own back to its original level; a session the user moved is
    /// dropped untouched. Returns how many are ramping back.
    pub fn restore(&mut self, fade_ms: u32, now: Instant) -> u32 {
        self.entries.retain(|e| e.s.level().is_some_and(|cur| restore_decision(e.last_set, cur) == RestoreDecision::Restore));
        for e in &mut self.entries {
            e.from = e.last_set;
            e.to = e.original;
        }
        self.ramp = (!self.entries.is_empty()).then_some(Ramp { start: now, ms: fade_ms, kind: RampKind::Up });
        self.entries.len() as u32
    }

    /// Apply the ramp at `now`. True = still ramping (call again in a step).
    pub fn tick(&mut self, now: Instant) -> bool {
        let Some(r) = self.ramp else { return false };
        let t = fade_progress(now.saturating_duration_since(r.start), r.ms);
        self.entries.retain_mut(|e| {
            let v = fade_curve(e.from, e.to, t);
            let ok = e.s.set_level(v);
            if ok {
                e.last_set = v;
            }
            ok
        });
        if t >= 1.0 || self.entries.is_empty() {
            self.ramp = None;
            if r.kind == RampKind::Up {
                self.entries.clear(); // back at the original: nothing left to undo
            }
        }
        self.ramp.is_some()
    }

    pub fn ramping(&self) -> bool {
        self.ramp.is_some()
    }

    /// Exit: everything back to its original level at once (no fade), unless the user moved it.
    pub fn restore_now(&mut self) {
        for e in &self.entries {
            if e.s.level().is_some_and(|cur| restore_decision(e.last_set, cur) == RestoreDecision::Restore) {
                e.s.set_level(e.original);
            }
        }
        self.entries.clear();
        self.ramp = None;
    }

    pub fn held(&self) -> u32 {
        self.entries.len() as u32
    }

    /// What the crash-recovery file must hold right now.
    pub fn persisted(&self) -> Vec<Persisted> {
        self.entries.iter().map(|e| Persisted { key: e.key.clone(), exe: e.exe.clone(), original: e.original, target: if self.ramp.map(|r| r.kind) == Some(RampKind::Up) { e.from } else { e.to } }).collect()
    }
}

// ── Public entry points (one worker thread on Windows; no-ops elsewhere) ────

static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn file_path() -> Option<PathBuf> {
    DIR.get().map(|d| d.join(FILE_NAME))
}

#[cfg(windows)]
pub use worker::{duck, recover, restore, restore_now, status};

#[cfg(not(windows))]
pub fn duck(_reduction: u8, _fade_ms: u32, _wait: Duration) -> DuckReport {
    DuckReport::default()
}
#[cfg(not(windows))]
pub fn restore(_fade_ms: u32, _wait: Duration) -> bool {
    false
}
#[cfg(not(windows))]
pub fn status(_wait: Duration) -> DuckStatus {
    DuckStatus::default()
}
#[cfg(not(windows))]
pub fn restore_now() {}
#[cfg(not(windows))]
pub fn recover(dir: &Path) {
    let _ = DIR.set(dir.to_path_buf());
}

#[cfg(windows)]
mod worker {
    use std::sync::mpsc;
    use std::sync::OnceLock;

    use super::*;
    use windows::core::{Interface, GUID, HRESULT};
    use windows::Win32::Media::Audio::{eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

    /// Steps of the fade loop; progress itself comes from wall time.
    const STEP: Duration = Duration::from_millis(10);
    /// Exit must not hang on the worker.
    const EXIT_WAIT: Duration = Duration::from_millis(600);
    /// `GetProcessId`'s success code for a session shared by several processes.
    const AUDCLNT_S_NO_SINGLE_PROCESS: HRESULT = HRESULT(0x0889_000D);
    /// Event context on our SetMasterVolume calls (lets a session listener tell them apart).
    const DUCK_CTX: GUID = GUID::from_u128(0x6a3f_1c52_8d0e_4b7a_9c21_5e4d_7a90_b3c1);

    enum Cmd {
        Duck { reduction: u8, fade_ms: u32, reply: mpsc::SyncSender<DuckReport> },
        Restore { fade_ms: u32, reply: mpsc::SyncSender<bool> },
        RestoreNow { reply: mpsc::SyncSender<()> },
        Status { reply: mpsc::SyncSender<DuckStatus> },
        Recover,
    }

    static WORKER: OnceLock<mpsc::Sender<Cmd>> = OnceLock::new();

    fn sender() -> &'static mpsc::Sender<Cmd> {
        WORKER.get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            let _ = std::thread::Builder::new().name("media-ducker".into()).spawn(move || run(rx));
            tx
        })
    }

    fn ask<T>(make: impl FnOnce(mpsc::SyncSender<T>) -> Cmd, wait: Duration) -> Option<T> {
        let (tx, rx) = mpsc::sync_channel(1);
        sender().send(make(tx)).ok()?;
        rx.recv_timeout(wait).ok()
    }

    /// Duck every eligible Spotify session BY `reduction` % over `fade_ms`. Returns once the fade
    /// has started (it finishes on the worker), or a default report after `wait`.
    pub fn duck(reduction: u8, fade_ms: u32, wait: Duration) -> DuckReport {
        DuckReport::or_unknown(ask(|reply| Cmd::Duck { reduction, fade_ms, reply }, wait))
    }

    /// Ramp back over `fade_ms`. True = the worker didn't answer (still ducked, as far as we know).
    pub fn restore(fade_ms: u32, wait: Duration) -> bool {
        if WORKER.get().is_none() {
            return false; // never ducked this run
        }
        ask(|reply| Cmd::Restore { fade_ms, reply }, wait).unwrap_or(true)
    }

    pub fn status(wait: Duration) -> DuckStatus {
        if WORKER.get().is_none() {
            let pending = file_path().map(|p| load(&p).len() as u32).unwrap_or(0);
            return DuckStatus { ducked: 0, pending_recovery: pending };
        }
        ask(|reply| Cmd::Status { reply }, wait).unwrap_or_default()
    }

    /// App exit: put every ducked session back now (no fade). Never starts the worker.
    pub fn restore_now() {
        if WORKER.get().is_some() {
            let _ = ask(|reply| Cmd::RestoreNow { reply }, EXIT_WAIT);
        }
    }

    /// Startup: remember where the recovery file lives and undo a duck a crash left behind.
    pub fn recover(dir: &Path) {
        let _ = DIR.set(dir.to_path_buf());
        if file_path().is_some_and(|p| !load(&p).is_empty()) {
            let _ = sender().send(Cmd::Recover);
        }
    }

    struct ComInit;
    impl Drop for ComInit {
        fn drop(&mut self) {
            // SAFETY: paired with the successful CoInitializeEx on this same thread.
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }

    struct Sess(ISimpleAudioVolume);

    impl SessionVolume for Sess {
        fn level(&self) -> Option<f32> {
            // SAFETY: a live COM interface owned by this (COM-initialised) thread.
            unsafe { self.0.GetMasterVolume().ok() }
        }
        fn set_level(&self, v: f32) -> bool {
            // SAFETY: as above; the level is clamped to the API's 0..=1 range.
            unsafe { self.0.SetMasterVolume(v.clamp(0.0, 1.0), &DUCK_CTX).is_ok() }
        }
    }

    struct Scanned {
        key: String,
        info: SessionInfo,
        vol: ISimpleAudioVolume,
    }

    struct Worker {
        engine: Engine<Sess>,
        /// Entries from a crashed run whose app wasn't running when we last looked.
        pending: Vec<Persisted>,
    }

    fn run(rx: mpsc::Receiver<Cmd>) {
        // SAFETY: initialises COM for this dedicated thread only; every COM object below is created,
        // used and dropped here. Tokio workers are never COM-initialised, so nothing else touches them.
        let _com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok().then_some(ComInit);
        let mut w = Worker { engine: Engine::default(), pending: file_path().map(|p| load(&p)).unwrap_or_default() };
        loop {
            let cmd = if w.engine.ramping() {
                match rx.recv_timeout(STEP) {
                    Ok(c) => Some(c),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            } else {
                match rx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => return,
                }
            };
            if let Some(c) = cmd {
                w.handle(c);
            }
            let was = w.engine.ramping();
            if was && !w.engine.tick(Instant::now()) {
                w.persist(); // a finished ramp-up leaves nothing to recover
            }
        }
    }

    impl Worker {
        fn handle(&mut self, cmd: Cmd) {
            match cmd {
                Cmd::Duck { reduction, fade_ms, reply } => {
                    let (scan, own) = scan();
                    self.try_recover(&scan, &own);
                    let spotify_local = scan.iter().any(|s| is_local_spotify(&s.info, &own));
                    let ducked = if reduction == 0 {
                        0
                    } else {
                        let found = scan.into_iter().filter(|s| eligible(&s.info, &own)).map(|s| Candidate { key: s.key, exe: s.info.exe, s: Sess(s.vol) }).collect();
                        self.engine.duck(found, reduction, fade_ms, Instant::now())
                    };
                    // Before the first level change: a crash from here on is recoverable.
                    self.persist();
                    self.engine.tick(Instant::now());
                    let _ = reply.send(DuckReport { ducked, spotify_local, timed_out: false });
                }
                Cmd::Restore { fade_ms, reply } => {
                    self.engine.restore(fade_ms, Instant::now());
                    self.engine.tick(Instant::now());
                    if !self.engine.ramping() {
                        self.persist();
                    }
                    let _ = reply.send(false);
                }
                Cmd::RestoreNow { reply } => {
                    self.engine.restore_now();
                    self.persist();
                    let _ = reply.send(());
                }
                Cmd::Status { reply } => {
                    let _ = reply.send(DuckStatus { ducked: self.engine.held(), pending_recovery: self.pending.len() as u32 });
                }
                Cmd::Recover => {
                    if !self.pending.is_empty() {
                        let (scan, own) = scan();
                        self.try_recover(&scan, &own);
                    }
                }
            }
        }

        /// Undo stranded ducks from a crashed run for sessions present now.
        fn try_recover(&mut self, scan: &[Scanned], own: &HashSet<u32>) {
            if self.pending.is_empty() {
                return;
            }
            let candidates: Vec<&Scanned> = scan.iter().filter(|s| s.info.pid != 0 && !s.info.system_sounds && !own.contains(&s.info.pid)).collect();
            let found: Vec<FoundLevel> = candidates
                .iter()
                // SAFETY: a live interface from this thread's scan.
                .map(|s| FoundLevel { key: s.key.clone(), exe: s.info.exe.clone(), level: unsafe { s.vol.GetMasterVolume() }.unwrap_or(-1.0) })
                .collect();
            let before = self.pending.len();
            self.pending.retain(|p| match recover_plan(p, &found) {
                Recovery::Restore(idx) => {
                    for i in idx {
                        Sess(candidates[i].vol.clone()).set_level(p.original);
                    }
                    false
                }
                Recovery::UserChanged => false,
                Recovery::Missing => true,
            });
            if self.pending.len() != before {
                self.persist();
            }
        }

        fn persist(&self) {
            if let Some(p) = file_path() {
                let mut all = self.pending.clone();
                all.extend(self.engine.persisted());
                let _ = save(&p, &all); // best effort, silent
            }
        }
    }

    /// Every session on every active render endpoint, plus our own process tree. Failures just
    /// shrink the list (silent).
    fn scan() -> (Vec<Scanned>, HashSet<u32>) {
        let procs = processes();
        let tree: Vec<(u32, u32)> = procs.iter().map(|(pid, ppid, _)| (*pid, *ppid)).collect();
        // SAFETY: plain Win32 call.
        let me = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() };
        let own = own_tree(me, &tree);
        let names: HashMap<u32, String> = procs.into_iter().map(|(pid, _, exe)| (pid, exe)).collect();
        // SAFETY: COM calls on this COM-initialised thread; every out-string is freed once.
        let sessions = unsafe { sessions(&names) }.unwrap_or_default();
        (sessions, own)
    }

    unsafe fn sessions(names: &HashMap<u32, String>) -> windows::core::Result<Vec<Scanned>> {
        let mut out = Vec::new();
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let Ok(dev) = devices.Item(i) else { continue };
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = mgr.GetSessionEnumerator() else { continue };
            for j in 0..list.GetCount().unwrap_or(0) {
                let Ok(ctl) = list.GetSession(j) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() else { continue };
                let mut pid = 0u32;
                let hr = (Interface::vtable(&ctl2).GetProcessId)(Interface::as_raw(&ctl2), &mut pid);
                if hr.is_err() {
                    continue;
                }
                let key = match ctl2.GetSessionInstanceIdentifier() {
                    Ok(p) if !p.is_null() => {
                        let s = p.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(p.0 as *const _));
                        s
                    }
                    _ => continue,
                };
                let info = SessionInfo {
                    pid,
                    exe: names.get(&pid).cloned().unwrap_or_default(),
                    system_sounds: ctl2.IsSystemSoundsSession().0 == 0, // S_OK = system sounds, S_FALSE = not
                    active: ctl.GetState().is_ok_and(|s| s == AudioSessionStateActive),
                    multi_process: hr == AUDCLNT_S_NO_SINGLE_PROCESS,
                    muted: vol.GetMute().is_ok_and(|m| m.as_bool()),
                };
                out.push(Scanned { key, info, vol });
            }
        }
        Ok(out)
    }

    /// `(pid, parent pid, image name)` for every process (one ToolHelp snapshot).
    fn processes() -> Vec<(u32, u32, String)> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
        let mut out = Vec::new();
        // SAFETY: a stack-allocated, size-initialised PROCESSENTRY32W; the snapshot handle is
        // checked and closed exactly once.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE || snap.is_null() {
                return out;
            }
            let mut pe: PROCESSENTRY32W = std::mem::zeroed();
            pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut pe);
            while ok != 0 {
                let len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
                out.push((pe.th32ProcessID, pe.th32ParentProcessID, String::from_utf16_lossy(&pe.szExeFile[..len])));
                ok = Process32NextW(snap, &mut pe);
            }
            CloseHandle(snap);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct Fake {
        level: Rc<Cell<f32>>,
        gone: Rc<Cell<bool>>,
        sets: Rc<Cell<u32>>,
    }

    impl Fake {
        fn new(v: f32) -> Self {
            Self { level: Rc::new(Cell::new(v)), gone: Rc::new(Cell::new(false)), sets: Rc::new(Cell::new(0)) }
        }
    }

    impl SessionVolume for Fake {
        fn level(&self) -> Option<f32> {
            (!self.gone.get()).then(|| self.level.get())
        }
        fn set_level(&self, v: f32) -> bool {
            if self.gone.get() {
                return false;
            }
            self.sets.set(self.sets.get() + 1);
            self.level.set(v);
            true
        }
    }

    fn cand(key: &str, f: &Fake) -> Candidate<Fake> {
        Candidate { key: key.into(), exe: "Spotify.exe".into(), s: f.clone() }
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    /// Run the ramp to the end with `step` sleeps; returns how long it took (simulated).
    fn run_ramp(e: &mut Engine<Fake>, t0: Instant, step: Duration) -> Duration {
        let mut now = t0;
        while e.tick(now) {
            now += step;
        }
        now - t0
    }

    #[test]
    fn a_duck_that_timed_out_is_unknown_not_no_spotify() {
        // Fix pass: a first media_duck that outlives DUCK_WAIT must not read as "no local
        // Spotify" (the TS side would then also duck over the Web API: 85 % x 85 %).
        let r = DuckReport::or_unknown(None);
        assert!(r.timed_out && !r.spotify_local && r.ducked == 0);
        let v = serde_json::to_value(r).unwrap();
        assert_eq!(v["timedOut"], true);
        let ok = DuckReport { ducked: 1, spotify_local: true, timed_out: false };
        assert_eq!(DuckReport::or_unknown(Some(ok)), ok);
        assert!(!DuckReport::default().timed_out, "the kill-switch answer is a known no");
    }

    #[test]
    fn duck_target_is_by_not_to() {
        assert!(close(duck_target(1.0, 15), 0.85));
        assert!(close(duck_target(0.4, 15), 0.34));
        assert!(close(duck_target(0.5, 0), 0.5));
        assert!(close(duck_target(1.0, 50), 0.5));
        assert_eq!((clamp_reduction(None), clamp_reduction(Some(90)), clamp_reduction(Some(0)), clamp_reduction(Some(25))), (15, 50, 0, 25));
        assert_eq!((clamp_fade_down(None), clamp_fade_down(Some(5)), clamp_fade_down(Some(999))), (120, 60, 200));
        assert_eq!((clamp_fade_up(None), clamp_fade_up(Some(5)), clamp_fade_up(Some(9999))), (320, 60, 600));
    }

    #[test]
    fn fade_curve_is_monotonic_and_exact_at_the_ends() {
        for (from, to) in [(1.0f32, 0.85f32), (0.85, 1.0), (0.4, 0.34), (0.0, 0.5), (0.5, 0.0)] {
            assert_eq!(fade_curve(from, to, 0.0), from);
            assert_eq!(fade_curve(from, to, 1.0), to);
            assert_eq!(fade_curve(from, to, -1.0), from);
            assert_eq!(fade_curve(from, to, 2.0), to);
            let mut prev = from;
            for i in 1..=100 {
                let v = fade_curve(from, to, i as f32 / 100.0);
                assert!(if to < from { v <= prev + 1e-6 } else { v >= prev - 1e-6 }, "monotonic {from}->{to} at {i}");
                assert!(v >= from.min(to) - 1e-6 && v <= from.max(to) + 1e-6);
                prev = v;
            }
        }
    }

    #[test]
    fn fades_finish_on_time_even_with_coarse_sleeps() {
        for (ms, step) in [(FADE_DOWN_MS, 15.6f32), (FADE_UP_MS, 15.6), (FADE_DOWN_MS, 10.0), (FADE_UP_MS, 33.0)] {
            let f = Fake::new(1.0);
            let mut e = Engine::default();
            let t0 = Instant::now();
            e.duck(vec![cand("a", &f)], 15, ms, t0);
            let took = run_ramp(&mut e, t0, Duration::from_secs_f32(step / 1000.0));
            assert!(took.as_secs_f32() * 1000.0 <= ms as f32 + step + 0.5, "{ms} ms fade took {took:?}");
            assert!(close(f.level.get(), 0.85));
        }
        assert_eq!(fade_progress(Duration::from_millis(60), 120), 0.5);
        assert_eq!(fade_progress(Duration::from_millis(500), 120), 1.0);
        assert_eq!(fade_progress(Duration::ZERO, 0), 1.0);
    }

    #[test]
    fn own_tree_covers_webview2_and_stops_on_cycles() {
        // app 100 → WebView2 browser 200 → audio utility 300; 400 is a sibling; Spotify 500 (+ child 501) unrelated.
        let procs = [(100, 1), (200, 100), (300, 200), (400, 1), (500, 4), (501, 500), (600, 700), (700, 600), (800, 800)];
        let t = own_tree(100, &procs);
        assert_eq!(t, HashSet::from([100, 200, 300]));
        assert!(!t.contains(&500) && !t.contains(&501) && !t.contains(&400));
        // A cycle that includes the root still terminates.
        let t = own_tree(600, &procs);
        assert_eq!(t, HashSet::from([600, 700]));
        assert_eq!(own_tree(800, &procs), HashSet::from([800]), "self-parented");
        assert_eq!(own_tree(42, &[]), HashSet::from([42]));
    }

    #[test]
    fn eligibility_table() {
        let own = HashSet::from([100, 300]);
        let base = SessionInfo { pid: 500, exe: "Spotify.exe".into(), active: true, ..Default::default() };
        assert!(eligible(&base, &own));
        assert!(eligible(&SessionInfo { exe: "spotify.exe".into(), ..base.clone() }, &own), "case-insensitive");
        assert!(eligible(&SessionInfo { exe: r"C:\Users\x\AppData\Roaming\Spotify\SPOTIFY.EXE".into(), ..base.clone() }, &own));
        assert!(!eligible(&SessionInfo { exe: "chrome.exe".into(), ..base.clone() }, &own), "out of scope");
        assert!(!eligible(&SessionInfo { exe: "msedgewebview2.exe".into(), ..base.clone() }, &own));
        assert!(!eligible(&SessionInfo { system_sounds: true, ..base.clone() }, &own));
        assert!(!eligible(&SessionInfo { active: false, ..base.clone() }, &own), "inactive");
        assert!(!eligible(&SessionInfo { muted: true, ..base.clone() }, &own));
        assert!(!eligible(&SessionInfo { multi_process: true, ..base.clone() }, &own));
        assert!(!eligible(&SessionInfo { pid: 300, ..base.clone() }, &own), "our own tree");
        assert!(!eligible(&SessionInfo { pid: 0, ..base.clone() }, &own));
        // Spotify is still "local" while muted / multi-process: no Web API fallback then.
        assert!(is_local_spotify(&SessionInfo { muted: true, ..base.clone() }, &own));
        assert!(is_local_spotify(&SessionInfo { multi_process: true, ..base.clone() }, &own));
        assert!(!is_local_spotify(&SessionInfo { active: false, ..base }, &own));
    }

    #[test]
    fn restore_decision_tolerance() {
        assert_eq!(restore_decision(0.85, 0.85), RestoreDecision::Restore);
        assert_eq!(restore_decision(0.85, 0.86), RestoreDecision::Restore);
        assert_eq!(restore_decision(0.85, 0.83), RestoreDecision::Restore);
        assert_eq!(restore_decision(0.85, 0.90), RestoreDecision::UserChanged);
        assert_eq!(restore_decision(0.85, 0.50), RestoreDecision::UserChanged);
    }

    #[test]
    fn duck_then_restore_round_trip() {
        let f = Fake::new(0.6);
        let mut e = Engine::default();
        let t0 = Instant::now();
        assert_eq!(e.duck(vec![cand("a", &f)], 15, 120, t0), 1);
        assert!(close(f.level.get(), 0.6), "nothing changes before the first tick");
        run_ramp(&mut e, t0, Duration::from_millis(10));
        assert!(close(f.level.get(), 0.51));
        assert_eq!(e.held(), 1);
        assert_eq!(e.restore(320, t0), 1);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        assert!(close(f.level.get(), 0.6));
        assert_eq!(e.held(), 0, "fully restored: nothing left");
        assert!(e.persisted().is_empty());
    }

    #[test]
    fn a_re_duck_keeps_the_original_snapshot() {
        let f = Fake::new(1.0);
        let mut e = Engine::default();
        let t0 = Instant::now();
        e.duck(vec![cand("a", &f)], 15, 120, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        e.duck(vec![cand("a", &f)], 15, 120, t0); // talking again: still 0.85, not 0.85 × 0.85
        run_ramp(&mut e, t0, Duration::from_millis(10));
        assert!(close(f.level.get(), 0.85));
        e.restore(320, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        assert!(close(f.level.get(), 1.0));
    }

    #[test]
    fn a_session_the_user_moved_is_left_alone() {
        let f = Fake::new(1.0);
        let mut e = Engine::default();
        let t0 = Instant::now();
        e.duck(vec![cand("a", &f)], 15, 120, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        f.level.set(0.4); // the volume mixer
        let sets = f.sets.get();
        assert_eq!(e.restore(320, t0), 0);
        assert!(!e.tick(t0));
        assert_eq!(f.level.get(), 0.4);
        assert_eq!(f.sets.get(), sets, "never touched");
        // ...and a new duck snapshots the user's new level.
        e.duck(vec![cand("a", &f)], 15, 120, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        assert!(close(f.level.get(), 0.34));
    }

    #[test]
    fn a_duck_mid_restore_reverses_from_the_current_level() {
        let f = Fake::new(1.0);
        let mut e = Engine::default();
        let t0 = Instant::now();
        e.duck(vec![cand("a", &f)], 15, 120, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        e.restore(320, t0);
        e.tick(t0 + Duration::from_millis(160)); // halfway up
        let mid = f.level.get();
        assert!(mid > 0.85 && mid < 1.0);
        let t1 = t0 + Duration::from_millis(160);
        e.duck(vec![cand("a", &f)], 15, 120, t1);
        e.tick(t1);
        assert!(close(f.level.get(), mid), "starts where it is: no jump");
        e.tick(t1 + Duration::from_millis(60));
        assert!(f.level.get() < mid && f.level.get() > 0.85);
        run_ramp(&mut e, t1, Duration::from_millis(10));
        assert!(close(f.level.get(), 0.85), "target from the original snapshot, not the mid level");
        e.restore(320, t1);
        run_ramp(&mut e, t1, Duration::from_millis(10));
        assert!(close(f.level.get(), 1.0));
    }

    #[test]
    fn gone_and_silent_sessions() {
        let gone = Fake::new(0.7);
        let silent = Fake::new(0.0);
        let mut e = Engine::default();
        let t0 = Instant::now();
        assert_eq!(e.duck(vec![cand("g", &gone), cand("s", &silent)], 15, 120, t0), 1, "a session at 0 has nothing to lower");
        gone.gone.set(true);
        assert!(!e.tick(t0 + Duration::from_millis(10)), "the only session vanished: ramp over");
        assert_eq!(e.held(), 0);
        assert_eq!(e.duck(vec![], 15, 120, t0), 0);
        assert!(!e.ramping());
    }

    #[test]
    fn restore_now_is_instant_and_respects_user_changes() {
        let a = Fake::new(1.0);
        let b = Fake::new(0.8);
        let mut e = Engine::default();
        let t0 = Instant::now();
        e.duck(vec![cand("a", &a), cand("b", &b)], 20, 120, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        b.level.set(0.3);
        e.restore_now();
        assert!(close(a.level.get(), 1.0));
        assert_eq!(b.level.get(), 0.3);
        assert_eq!(e.held(), 0);
        assert!(!e.ramping());
    }

    #[test]
    fn persistence_round_trip_and_recovery_plan() {
        let dir = std::env::temp_dir().join(format!("cc-duck-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let f = Fake::new(0.6);
        let mut e = Engine::default();
        e.duck(vec![cand("{a}|spotify", &f)], 15, 120, Instant::now());
        let p = e.persisted();
        assert_eq!(p.len(), 1);
        assert!(close(p[0].original, 0.6) && close(p[0].target, 0.51));
        save(&path, &p).unwrap();
        assert_eq!(load(&path), p);
        save(&path, &[]).unwrap();
        assert!(!path.exists(), "nothing ducked: no file");
        save(&path, &[]).unwrap(); // idempotent
        assert!(load(&path).is_empty());
        std::fs::write(&path, b"not json").unwrap();
        assert!(load(&path).is_empty(), "a corrupt file is ignored");
        let _ = std::fs::remove_dir_all(&dir);

        let stranded = &p[0];
        let at = |key: &str, exe: &str, level: f32| FoundLevel { key: key.into(), exe: exe.into(), level };
        assert_eq!(recover_plan(stranded, &[at("x", "chrome.exe", 0.51), at("{a}|spotify", "Spotify.exe", 0.51)]), Recovery::Restore(vec![1]));
        assert_eq!(recover_plan(stranded, &[at("{a}|spotify", "Spotify.exe", 0.9)]), Recovery::UserChanged);
        // Spotify restarted (new session id) and Windows kept the ducked per-app level.
        assert_eq!(recover_plan(stranded, &[at("{b}|spotify", "SPOTIFY.EXE", 0.51), at("{c}|spotify", "Spotify.exe", 1.0)]), Recovery::Restore(vec![0]));
        assert_eq!(recover_plan(stranded, &[at("{b}|spotify", "Spotify.exe", 1.0)]), Recovery::UserChanged);
        assert_eq!(recover_plan(stranded, &[at("x", "chrome.exe", 0.51)]), Recovery::Missing, "Spotify closed: keep for later");
        assert_eq!(recover_plan(stranded, &[]), Recovery::Missing);
    }

    #[test]
    fn persisted_target_during_a_ramp_up_is_where_it_started() {
        let f = Fake::new(1.0);
        let mut e = Engine::default();
        let t0 = Instant::now();
        e.duck(vec![cand("a", &f)], 15, 120, t0);
        run_ramp(&mut e, t0, Duration::from_millis(10));
        e.restore(320, t0);
        assert!(close(e.persisted()[0].target, 0.85));
    }
}

/// Live check (Windows, Spotify playing on this PC). Never run by default; prints only counts —
/// no tokens, process names or session ids:
///   cargo test --lib live_media_duck_ -- --ignored --nocapture --test-threads=1
#[cfg(all(test, windows))]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_media_duck_1_spotify() {
        let r = duck(15, FADE_DOWN_MS, Duration::from_secs(2));
        println!("ducked sessions: {}, spotify local: {}", r.ducked, r.spotify_local);
        assert!(r.spotify_local, "start Spotify playback on this PC first");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(status(Duration::from_secs(1)).ducked, r.ducked);
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!restore(FADE_UP_MS, Duration::from_secs(1)));
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(status(Duration::from_secs(1)).ducked, 0, "back at the original level");
    }
}
