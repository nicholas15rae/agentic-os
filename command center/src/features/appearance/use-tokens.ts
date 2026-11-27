import { useAppearance, resolvedFor } from "./appearance-store";
import { useNav } from "@/stores/nav";
import type { WidgetFrame } from "./theme";

/** Settings → Appearance's default widget frame on the page on screen. */
export function useDefaultFrame(): WidgetFrame {
  const section = useNav((s) => s.section);
  return useAppearance((s) => resolvedFor(s, section).widgetFrame);
}
