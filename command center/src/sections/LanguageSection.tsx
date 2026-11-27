import { useEffect } from "react";
import { LayoutSurface } from "@/core/widgets/LayoutSurface";
import { panelShown, revealPanel } from "@/core/widgets/reveal";
import type { WidgetProps } from "@/core/widgets/types";
import { HubTabBar, HubViews, useHubLifecycle } from "@/features/language/LanguageHub";
import { useHub } from "@/features/language/store";
import { VoicePanel } from "@/features/language/VoicePanel";
import { useLanguageLayout } from "./language/panels";
import { useHubVoiceOpen } from "./language/voice-open-store";

/**
 * Language Hub on the shared layout system: the view tabs and the open view are two panels (move,
 * resize, hide, add back, per mode, Reset). The view lives in the Hub store, so picking a tab (or
 * opening Voice) always lands on a visible content panel. The page still loads the library once and,
 * on leaving, stops playback and releases the on-demand Whisper sidecar.
 */
export function LanguageSection() {
  useHubLifecycle();
  const view = useHub((s) => s.view);
  const voiceOpen = useHubVoiceOpen((s) => s.open);
  useEffect(() => {
    if (!panelShown(useLanguageLayout.getState(), "lg-content")) revealPanel(useLanguageLayout, "lg-content", "Language Hub");
  }, [view, voiceOpen]);
  // The drawer is per visit, as it was on the old page.
  useEffect(() => () => useHubVoiceOpen.getState().close(), []);
  return <LayoutSurface store={useLanguageLayout} label="Language" />;
}

/** The view pills, the engine badge and the Voice toggle. */
export function LanguageTabBar({ display, setBadge }: WidgetProps) {
  const open = useHubVoiceOpen((s) => s.open);
  const toggle = useHubVoiceOpen((s) => s.toggle);
  const libCount = useHub((s) => s.library.length);
  const loaded = useHub((s) => s.libraryLoaded);
  useEffect(() => setBadge?.(loaded && libCount ? String(libCount) : null), [loaded, libCount, setBadge]);
  return <HubTabBar compact={display === "compact"} voiceOpen={open} onToggleVoice={toggle} />;
}

/** The Voice settings (when open) and the open view. */
export function LanguageContent({ display }: WidgetProps) {
  const open = useHubVoiceOpen((s) => s.open);
  const close = useHubVoiceOpen((s) => s.close);
  return (
    <div className="space-y-4">
      {open && <VoicePanel onClose={close} />}
      <HubViews compact={display === "compact"} />
    </div>
  );
}
