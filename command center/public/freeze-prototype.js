// Prototype-pollution hardening for the desktop app's own document only.
//
// This replaces Tauri's `app.security.freezePrototype`. On Windows, wry injects every
// initialization script into ALL frames ("scripts are always added to subframes regardless
// of the for_main_frame_only option"), so Tauri's freeze also ran inside the cross-origin
// TradingView chart iframe. Its bundle assigns `x.toString = ...` on plain objects, which
// throws "Cannot assign to read only property 'toString'" once Object.prototype is frozen,
// and the chart stayed a blank white box with a spinner.
//
// Loaded as a classic (blocking) script from index.html, so it runs before any module in
// the app bundle. Desktop only, matching the old behaviour: the phone/web build never froze.
if (window.__TAURI_INTERNALS__ && window === window.top) Object.freeze(Object.prototype);
