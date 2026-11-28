import type { TapAnim, WidgetLook } from "./look";

/**
 * UI fixes 5: a widget's small animation when tapped (pure). Off app-wide with Settings →
 * Appearance → Widget animations (per page too), per widget in its Look panel (style and
 * strength, saved with the page and its mode preset), and always off under reduced motion or
 * Motion: Reduced / Off. Safety controls never animate (nothing between a tap and the stop).
 */
export const TAP_ANIMS: readonly TapAnim[] = ["none", "bounce", "flip", "glow", "expand"];
export const TAP_LABEL: Record<TapAnim, string> = { none: "None", bounce: "Bounce", flip: "Flip", glow: "Glow", expand: "Expand" };

export const STRENGTH_MIN = 0.25;
export const STRENGTH_MAX = 1.5;
export const clampStrength = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(STRENGTH_MAX, Math.max(STRENGTH_MIN, v)) : 1);

/** The widget's own pick, else a bounce (a page's big panel and the chromeless hero stay still unless asked). Pure. */
export function tapAnimOf(look: WidgetLook | undefined, def: { panel?: boolean; chromeless?: boolean; locked?: boolean }): TapAnim {
  if (def.locked) return "none";
  const own = look?.tapAnim;
  if (own && TAP_ANIMS.includes(own)) return own;
  return def.panel || def.chromeless ? "none" : "bounce";
}

/** Should a tap animate at all? Pure. */
export function animationsOn(o: { appSwitch: "on" | "off"; motion: "full" | "reduced" | "off"; osReduced: boolean }): boolean {
  return o.appSwitch === "on" && o.motion === "full" && !o.osReduced;
}

export interface TapMotion {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The keyframes for one tap. Transform / opacity / shadow only, short (under 600 ms), ending where
 * they started so nothing is left mid-way. `accentRgb` is the theme's second accent ("0, 229, 195"). Pure.
 */
export function tapMotion(anim: TapAnim, strength: number, accentRgb = "0, 229, 195"): TapMotion | null {
  const k = clampStrength(strength);
  switch (anim) {
    case "bounce":
      return {
        keyframes: [{ transform: "scale(1)" }, { transform: `scale(${r3(1 - 0.035 * k)})`, offset: 0.3 }, { transform: `scale(${r3(1 + 0.018 * k)})`, offset: 0.68 }, { transform: "scale(1)" }],
        options: { duration: 340, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      };
    case "flip":
      return {
        keyframes: [
          { transform: "perspective(900px) rotateY(0deg)" },
          { transform: `perspective(900px) rotateY(${r3(14 * k)}deg)`, offset: 0.4 },
          { transform: `perspective(900px) rotateY(${r3(-4 * k)}deg)`, offset: 0.75 },
          { transform: "perspective(900px) rotateY(0deg)" },
        ],
        options: { duration: 460, easing: "cubic-bezier(0.45, 0, 0.2, 1)" },
      };
    case "glow":
      return {
        keyframes: [
          { boxShadow: `0 0 0 0 rgba(${accentRgb}, 0)` },
          { boxShadow: `0 0 ${Math.round(22 * k)}px ${Math.round(2 * k)}px rgba(${accentRgb}, ${r3(Math.min(0.6, 0.4 * k))})`, offset: 0.35 },
          { boxShadow: `0 0 0 0 rgba(${accentRgb}, 0)` },
        ],
        options: { duration: 560, easing: "ease-out" },
      };
    case "expand":
      return {
        keyframes: [{ transform: "scale(1)" }, { transform: `scale(${r3(1 + 0.04 * k)})`, offset: 0.45 }, { transform: "scale(1)" }],
        options: { duration: 380, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      };
    default:
      return null;
  }
}
