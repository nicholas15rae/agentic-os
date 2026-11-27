//! Tauri surface for the native audio engine. Events go out on `audio-engine` as
//! [`EngineEvent`] payloads (`{ type: "speechStart", bargedIn }`, …).

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use super::engine::{self, AudioDevices, EngineEvent, EngineHandle, EngineStatus, EventSink, PlaybackWriter, StartOptions};

pub const EVENT: &str = "audio-engine";
const TONE_RATE: u32 = 24_000; // Kokoro's output rate, so the test tone exercises the resampler

/// Lifecycle: a stop that lands while devices are still opening wins over that start.
enum Slot {
    Idle,
    Starting(u64),
    Running(EngineHandle),
}

struct Inner {
    slot: Slot,
    generation: u64,
}

pub struct AudioEngineState {
    inner: Mutex<Inner>,
}

impl Default for AudioEngineState {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner { slot: Slot::Idle, generation: 0 }) }
    }
}

impl AudioEngineState {
    fn guard(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `(turn_active, playing, in_speech)` while the engine runs, else `None` (Phase 3 idle
    /// check: never compact while a voice turn is live).
    pub fn activity(&self) -> Option<(bool, bool, bool)> {
        match &self.guard().slot {
            Slot::Running(h) => {
                let s = h.status();
                Some((s.turn_active, s.playing, s.in_speech))
            }
            _ => None,
        }
    }

    fn shared(&self) -> Result<Arc<engine::Shared>, String> {
        match &self.guard().slot {
            Slot::Running(h) => Ok(Arc::clone(&h.shared)),
            _ => Err("audio engine isn't running".into()),
        }
    }
}

struct AppSink(AppHandle);

impl EventSink for AppSink {
    fn emit(&self, event: EngineEvent) {
        let _ = self.0.emit(EVENT, event);
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("audio task failed: {e}"))
}

#[tauri::command]
pub async fn audio_engine_devices() -> Result<AudioDevices, String> {
    blocking(engine::list_devices).await?
}

/// Phase 2 Part B: the native recorder never opens while the mic is locked off.
pub(crate) fn start_allowed() -> Result<(), String> {
    if crate::commands::voice::mic_enabled() {
        Ok(())
    } else {
        Err("mic is locked off".into())
    }
}

/// Stop the engine now, from sync code (`voice::set_mic_enabled`): cancels an in-flight start
/// and releases the devices on a helper thread (dropping a handle joins the audio threads).
pub(crate) fn stop_now(state: &AudioEngineState) {
    let handle = {
        let mut inner = state.guard();
        inner.generation += 1; // cancels an in-flight start
        match std::mem::replace(&mut inner.slot, Slot::Idle) {
            Slot::Running(h) => Some(h),
            _ => None,
        }
    };
    if let Some(h) = handle {
        let _ = std::thread::Builder::new().name("audio-engine-stop".into()).spawn(move || drop(h));
    }
}

/// Claim the start slot under the lock (never held across an await). Refused while the mic is
/// locked off, so a muted engine is never started. Returns the claim's generation and a dead
/// engine to drop, if one was in the slot.
fn claim_start(state: &AudioEngineState) -> Result<Result<(u64, Option<EngineHandle>), EngineStatus>, String> {
    start_allowed()?;
    let mut inner = state.guard();
    match &inner.slot {
        Slot::Running(h) if h.shared.is_healthy() => return Ok(Err(h.status())),
        Slot::Starting(_) => return Err("audio engine is already starting".into()),
        _ => {}
    }
    inner.generation += 1;
    let generation = inner.generation;
    // A Running engine here has a failed stream: replace it.
    let dead = match std::mem::replace(&mut inner.slot, Slot::Starting(generation)) {
        Slot::Running(h) => Some(h),
        _ => None,
    };
    Ok(Ok((generation, dead)))
}

#[tauri::command]
pub async fn audio_engine_start(app: AppHandle, state: State<'_, AudioEngineState>, options: Option<StartOptions>) -> Result<EngineStatus, String> {
    let (generation, dead) = match claim_start(&state)? {
        Ok(claim) => claim,
        Err(running) => return Ok(running),
    };
    if let Some(h) = dead {
        blocking(move || drop(h)).await?;
    }
    let opts = options.unwrap_or_default();
    let sink = AppSink(app);
    let started = blocking(move || engine::start(opts, sink)).await.and_then(|r| r);
    let (result, loser) = {
        let mut inner = state.guard();
        let still_ours = matches!(inner.slot, Slot::Starting(g) if g == generation);
        match started {
            // Locked off while the devices were opening: this engine never runs.
            Ok(handle) if !crate::commands::voice::mic_enabled() => {
                if still_ours {
                    inner.slot = Slot::Idle;
                }
                (Err("mic is locked off".to_string()), Some(handle))
            }
            Ok(handle) if still_ours => {
                let status = handle.status();
                inner.slot = Slot::Running(handle);
                (Ok(status), None)
            }
            Ok(handle) => (Err("audio engine start was cancelled by stop".to_string()), Some(handle)),
            Err(e) => {
                if still_ours {
                    inner.slot = Slot::Idle;
                }
                (Err(e), None)
            }
        }
    };
    if let Some(h) = loser {
        let _ = blocking(move || drop(h)).await;
    }
    result
}

#[tauri::command]
pub async fn audio_engine_stop(state: State<'_, AudioEngineState>) -> Result<(), String> {
    let handle = {
        let mut inner = state.guard();
        inner.generation += 1; // cancels an in-flight start
        match std::mem::replace(&mut inner.slot, Slot::Idle) {
            Slot::Running(h) => Some(h),
            _ => None,
        }
    };
    if let Some(h) = handle {
        blocking(move || drop(h)).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn audio_engine_status(state: State<'_, AudioEngineState>) -> EngineStatus {
    match &state.guard().slot {
        Slot::Running(h) => h.status(),
        _ => EngineStatus { level_db: -100.0, ..Default::default() },
    }
}

/// Cut the assistant off now (same path VAD onset takes). Returns false if already cut off.
#[tauri::command]
pub fn audio_engine_barge_in(app: AppHandle, state: State<'_, AudioEngineState>) -> Result<bool, String> {
    let fired = state.shared()?.barge.trigger();
    if fired {
        let _ = app.emit(EVENT, EngineEvent::BargeIn);
    }
    Ok(fired)
}

/// Play a tone as a fake assistant turn, to check output and barge-in by talking over it.
#[tauri::command]
pub fn audio_engine_test_tone(state: State<'_, AudioEngineState>, freq_hz: Option<f32>, ms: Option<u32>) -> Result<(), String> {
    let shared = state.shared()?;
    let freq = freq_hz.unwrap_or(440.0).clamp(50.0, 4_000.0);
    let total = (TONE_RATE as u64 * ms.unwrap_or(3_000).clamp(50, 15_000) as u64 / 1000) as usize;
    std::thread::Builder::new()
        .name("audio-test-tone".into())
        .spawn(move || {
            let turn = shared.barge.begin_turn();
            let mut writer = PlaybackWriter::new(Arc::clone(&shared), turn, TONE_RATE);
            let step = 2.0 * std::f32::consts::PI * freq / TONE_RATE as f32;
            let mut chunk = [0f32; 480];
            let mut n = 0usize;
            let ok = loop {
                if n >= total {
                    break true;
                }
                let len = chunk.len().min(total - n);
                for (i, s) in chunk[..len].iter_mut().enumerate() {
                    *s = 0.2 * (step * (n + i) as f32).sin();
                }
                n += len;
                if writer.write(&chunk[..len]).is_err() {
                    break false;
                }
            };
            if ok {
                let _ = writer.finish();
            }
            shared.barge.end_turn(&turn);
        })
        .map(|_| ())
        .map_err(|e| format!("spawning tone thread: {e}"))
}

// ── Local media ducking (P4, `ducker.rs`) ───────────────────────────────────
//
// A reversible, speech-initiated micro-action (like `spotify_duck`): no card, no bridge log line,
// never an error for "nothing to duck". The kill switch blocks NEW ducks only; a restore is never
// gated (it only undoes this app's own temporary change).

/// First call includes COM start-up and the endpoint scan; later ones take a few ms.
const DUCK_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);
const UNDUCK_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);
const STATUS_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

/// Lower the Spotify desktop app's own session BY `reduction_pct` % (0..=50, default 15) over
/// `fade_ms` (60..=200, default 120). `spotifyLocal` = an active local Spotify session exists.
#[tauri::command]
pub async fn media_duck(os: State<'_, crate::commands::os_core::OsState>, reduction_pct: Option<u8>, fade_ms: Option<u32>) -> Result<super::ducker::DuckReport, String> {
    if os.snapshot().privacy.kill_switch {
        return Ok(super::ducker::DuckReport::default());
    }
    let (r, f) = (super::ducker::clamp_reduction(reduction_pct), super::ducker::clamp_fade_down(fade_ms));
    // A failed blocking task is "unknown" like a timeout: the fade may have been queued.
    Ok(blocking(move || super::ducker::duck(r, f, DUCK_WAIT)).await.unwrap_or_else(|_| super::ducker::DuckReport::unknown()))
}

/// Ramp the ducked sessions back over `fade_ms` (60..=600, default 320); a session moved since is
/// left alone. True = the ducker didn't answer (still ducked as far as we know). Never gated.
#[tauri::command]
pub async fn media_unduck(fade_ms: Option<u32>) -> Result<bool, String> {
    let f = super::ducker::clamp_fade_up(fade_ms);
    Ok(blocking(move || super::ducker::restore(f, UNDUCK_WAIT)).await.unwrap_or(true))
}

#[tauri::command]
pub async fn media_duck_status() -> Result<super::ducker::DuckStatus, String> {
    Ok(blocking(|| super::ducker::status(STATUS_WAIT)).await.unwrap_or_default())
}

#[cfg(test)]
mod mic_gate_tests {
    use super::*;
    use crate::commands::voice::{mic_gate_tests::lock, MIC_ENABLED};
    use std::sync::atomic::Ordering;

    #[test]
    fn muted_mic_never_claims_the_engine() {
        let _g = lock();
        let state = AudioEngineState::default();
        MIC_ENABLED.store(false, Ordering::SeqCst);
        let allowed = start_allowed();
        let claim = claim_start(&state);
        MIC_ENABLED.store(true, Ordering::SeqCst);
        assert!(allowed.is_err());
        assert!(matches!(claim, Err(ref e) if e.contains("locked off")));
        let inner = state.guard();
        assert!(matches!(inner.slot, Slot::Idle), "a refused start leaves the slot idle");
        assert_eq!(inner.generation, 0, "nothing was claimed");
    }

    #[test]
    fn live_mic_claims_and_stop_now_cancels_the_claim() {
        let _g = lock();
        let state = AudioEngineState::default();
        MIC_ENABLED.store(true, Ordering::SeqCst);
        assert!(start_allowed().is_ok());
        let claim = claim_start(&state).expect("claim").expect("not already running");
        assert_eq!(claim.0, 1);
        assert!(matches!(state.guard().slot, Slot::Starting(1)));
        // The mute path: an in-flight start loses its slot (generation bumped, slot idle).
        stop_now(&state);
        let inner = state.guard();
        assert!(matches!(inner.slot, Slot::Idle));
        assert_eq!(inner.generation, 2);
    }
}
