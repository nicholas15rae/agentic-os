import { useAppearance, resolvedFor } from "./appearance-store";
import { DEFAULT_TOKENS, tokensToCss, type ThemeTokens } from "./theme";
import { useNav } from "@/stores/nav";

/**
 * Applies the look in force (theme → app-wide edits → this page's overrides) as CSS variables on
 * <html>, and again whenever it or the page changes. Returns the uninstaller.
 */
export function installAppearance(): () => void {
  if (typeof document === "undefined") return () => undefined;
  let last = "";
  const apply = () => {
    const t = resolvedFor(useAppearance.getState(), useNav.getState().section);
    const key = JSON.stringify(t);
    if (key === last) return;
    last = key;
    applyTokens(document.documentElement, t);
  };
  apply();
  const offA = useAppearance.subscribe(apply);
  const offN = useNav.subscribe((s, p) => s.section !== p.section && apply());
  return () => {
    offA();
    offN();
  };
}

/** Writes the tokens onto `el` (the page, or the control centre's preview box). */
export function applyTokens(el: HTMLElement, t: ThemeTokens): void {
  for (const [k, v] of Object.entries(tokensToCss(t))) el.style.setProperty(k, v);
  const d = el.dataset;
  if (t.motion === "full") delete d.motionPref;
  else d.motionPref = t.motion;
  if (t.iconStroke === DEFAULT_TOKENS.iconStroke) delete d.iconStroke;
  else d.iconStroke = String(t.iconStroke);
  d.cardStyle = t.cardStyle;
}
