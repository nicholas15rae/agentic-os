//! Tell WebView2 when the main window is hidden or minimised, so the page stops rendering.
//!
//! Tauri's `Window::hide()` and a minimise only hide the outer HWND. wry 0.57 never calls
//! `ICoreWebView2Controller::put_IsVisible(false)` for either, and our WebView2 browser args
//! (`--disable-backgrounding-occluded-windows`, `CalculateNativeWinOcclusion` off) stop Chromium
//! from noticing by itself. So the page kept `document.visibilityState == "visible"`, every
//! requestAnimationFrame loop and CSS animation kept running, and the WebView2 gpu-process held
//! 25-33 % of the RTX 3060's 3D engine with the window in the tray (measured 2026-11-26). That
//! slowed faster-whisper on the same card (3 s clip: 0.33 s → 0.50 s).
//!
//! With `IsVisible = false` the page really goes hidden: `visibilitychange` fires, rAF stops and
//! the compositor produces no frames. Hidden-page timer throttling stays off
//! (`--disable-background-timer-throttling` in tauri.conf.json), so voice, reminders and the
//! wake word keep their timing in the tray.
//!
//! [`sync`] reads the real window state and pushes it into the controller only when it changed.
//! It runs after close → hide, in `show_main`, on window events, and from a 1 s poll: the logon
//! launcher starts the app with `SW_HIDE`, and an outside `ShowWindow` raises no window event.
//! The webview also gets a [`EVENT`] (`true` = visible) so the UI can follow without relying on
//! `document.hidden` alone.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager, Runtime, WebviewWindow};

/// Event the webview receives with the window's visibility (`true` = showing).
pub const EVENT: &str = "window-visibility";

/// How often the poll re-checks the window (covers `SW_HIDE` at launch and outside `ShowWindow`).
const POLL: Duration = Duration::from_secs(1);

const UNKNOWN: u8 = 0;
const SHOWN: u8 = 1;
const HIDDEN: u8 = 2;

/// What the controller was last told (`UNKNOWN` until the first sync).
static LAST: AtomicU8 = AtomicU8::new(UNKNOWN);

/// The page should render only while the window is on screen: shown and not minimised.
pub fn should_render(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

/// `Some(state)` when the controller must be told `state`, `None` when it already was.
fn transition(last: u8, render: bool) -> Option<bool> {
    let want = if render { SHOWN } else { HIDDEN };
    (last != want).then_some(render)
}

/// Read the window and update the controller if needed. Call on the main thread: Tauri answers
/// `is_visible` / `with_webview` inline there, so the read and the write can't interleave with a
/// hide or show coming from another thread.
pub fn sync<R: Runtime>(w: &WebviewWindow<R>) {
    let visible = w.is_visible().unwrap_or(true);
    let minimized = w.is_minimized().unwrap_or(false);
    apply(w, should_render(visible, minimized));
}

/// Push `render` into the WebView2 controller and tell the page, once per change.
pub fn apply<R: Runtime>(w: &WebviewWindow<R>, render: bool) {
    let Some(render) = transition(LAST.load(Ordering::SeqCst), render) else { return };
    LAST.store(if render { SHOWN } else { HIDDEN }, Ordering::SeqCst);
    #[cfg(windows)]
    let _ = w.with_webview(move |pw| {
        // SAFETY: a plain COM property setter on the live controller, called on the UI thread.
        if let Err(e) = unsafe { pw.controller().SetIsVisible(render) } {
            eprintln!("[webview] SetIsVisible({render}) failed: {e}");
        }
    });
    let _ = w.emit(EVENT, render);
}

/// Sync `main` on the main thread (safe to call from any thread).
pub fn sync_main<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(w) = app.get_webview_window("main") else { return };
    let w2 = w.clone();
    let _ = w.run_on_main_thread(move || sync(&w2));
}

/// Start the 1 s poll for the lifetime of the app.
pub fn spawn_poll<R: Runtime>(app: tauri::AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL).await;
            sync_main(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_only_when_shown_and_not_minimised() {
        assert!(should_render(true, false));
        assert!(!should_render(false, false));
        assert!(!should_render(true, true));
        assert!(!should_render(false, true));
    }

    #[test]
    fn tells_the_controller_once_per_change() {
        assert_eq!(transition(UNKNOWN, true), Some(true));
        assert_eq!(transition(UNKNOWN, false), Some(false));
        assert_eq!(transition(SHOWN, true), None);
        assert_eq!(transition(SHOWN, false), Some(false));
        assert_eq!(transition(HIDDEN, false), None);
        assert_eq!(transition(HIDDEN, true), Some(true));
    }
}
