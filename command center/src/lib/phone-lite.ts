/**
 * Phone performance mode (the Android app). The desktop look stacks ~35 live `backdrop-filter`
 * blurs over an always-moving background (weather canvas + drifting wallpaper), so every frame
 * re-blurs the whole screen: on a Galaxy S22 that kept Android's RenderThread at ~60 % and the
 * WebView main thread at ~50 % with nothing happening. On the phone the background holds still
 * (reduced motion) and the glass is solid-translucent (`.phone-lite` in index.css).
 * No imports on purpose: read at module load by the media-query hook and main.tsx.
 */
export const PHONE_LITE: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
