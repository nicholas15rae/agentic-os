import { useAppearance, resolvedFor } from "./appearance-store";
import { useNav } from "@/stores/nav";
import type { WidgetFrame } from "./theme";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { animationsOn } from "@/core/widgets/tap-anim";

/** UI fixes 5: do widget tap animations play on the page on screen (Widget animations on, Motion full, no OS reduced motion)? */
export function useWidgetAnimations(): boolean {
  const section = useNav((s) => s.section);
  const app = useAppearance((s) => resolvedFor(s, section).animations);
  const motion = useAppearance((s) => resolvedFor(s, section).motion);
  const os = usePrefersReducedMotion();
  return animationsOn({ appSwitch: app, motion, osReduced: os });
}

/** Settings → Appearance's default widget frame on the page on screen. */
export function useDefaultFrame(): WidgetFrame {
  const section = useNav((s) => s.section);
  return useAppearance((s) => resolvedFor(s, section).widgetFrame);
}
