import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { installEditingKeyGuard } from "./lib/editing-keys";
import { RootErrorBoundary } from "./core/RootErrorBoundary";
import { PHONE_LITE } from "./lib/phone-lite";
import { installBrowserMotionWatcher } from "./lib/motion";
import { isTauri } from "./lib/platform";
import { useSettings } from "./stores/settings";
import { installAppearance } from "./features/appearance/install";
import { resolvedFor, useAppearance } from "./features/appearance/appearance-store";
import { useNav } from "./stores/nav";

// Before any component adds its own keydown listener: text-editing shortcuts belong to the field.
installEditingKeyGuard();
// Android app: solid glass instead of live blur (see lib/phone-lite.ts and `.phone-lite` in index.css).
if (PHONE_LITE) document.documentElement.classList.add("phone-lite");
// Motion level (full / calm / off) before the first render: `<html data-motion>` + canvas loops.
installBrowserMotionWatcher({
  isTauri: isTauri(),
  calmWhenIdle: () => useSettings.getState().calmWhenIdle !== false,
  onCalmSetting: (fn) => useSettings.subscribe((s, prev) => s.calmWhenIdle !== prev.calmWhenIdle && fn()),
  // Settings → Appearance → Motion (app-wide, or the page's own) also drives the canvas loops.
  motionPref: () => resolvedFor(useAppearance.getState(), useNav.getState().section).motion,
  onMotionPref: (fn) => {
    const a = useAppearance.subscribe(fn);
    const n = useNav.subscribe((s, p) => s.section !== p.section && fn());
    return () => (a(), n());
  },
});

// Settings → Appearance: the theme's CSS variables before the first paint (and on every change).
installAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
