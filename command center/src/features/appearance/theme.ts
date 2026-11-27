/**
 * Settings → Appearance (AGENTS.md, "Everything Is Customizable"): the design tokens every
 * component reads as CSS variables. Pure: defaults, validation, the CSS variables a set of tokens
 * becomes, built-in themes. `appearance-store.ts` keeps what you picked; `install.ts` applies it.
 *
 * Resolution order (later wins): DEFAULT_TOKENS → the active theme → your app-wide edits → this
 * page's overrides. Reset to default clears the last three.
 */

export type CardStyle = "glass" | "solid" | "outline";
export type FontChoice = "jakarta" | "system" | "rounded" | "serif" | "mono";
export type MotionPref = "full" | "reduced" | "off";
export type WidgetFrame = "glass" | "ultra" | "solid" | "frameless";

export interface ThemeTokens {
  /** Energy / action colour (buttons, active states). */
  accent: string;
  accentLight: string;
  /** Sync / healthy colour. */
  accent2: string;
  /** The window background behind the wallpaper. */
  canvas: string;
  /** Text: primary, secondary, faint. */
  ink: string;
  ink2: string;
  ink3: string;
  /** Card background opacity (0-1) and blur (px). */
  glassAlpha: number;
  glassBlur: number;
  cardStyle: CardStyle;
  /** Card border width (px) and edge brightness (0-1). */
  borderWidth: number;
  borderAlpha: number;
  /** Corner radius of a card (px); every other radius scales with it. */
  radius: number;
  /** Shadow depth (0 = flat, 1 = default, 2 = deep). */
  shadow: number;
  font: FontChoice;
  /** Text size (1 = 100 %). */
  fontScale: number;
  /** Spacing and density (1 = default; lower is tighter). */
  density: number;
  /** Icon line weight. */
  iconStroke: number;
  /** How a new widget is framed. */
  widgetFrame: WidgetFrame;
  motion: MotionPref;
}

/** Exactly the look the app shipped with (styles/index.css before tokens). */
export const DEFAULT_TOKENS: ThemeTokens = {
  accent: "#ff7a2f",
  accentLight: "#ffb36b",
  accent2: "#00e5c3",
  canvas: "#0b0d11",
  ink: "#f8fafc",
  ink2: "#a1a8b8",
  ink3: "#5a6275",
  glassAlpha: 0.62,
  glassBlur: 20,
  cardStyle: "glass",
  borderWidth: 1,
  borderAlpha: 0.16,
  radius: 20,
  shadow: 1,
  font: "jakarta",
  fontScale: 1,
  density: 1,
  iconStroke: 2,
  widgetFrame: "glass",
  motion: "full",
};

export type TokenKey = keyof ThemeTokens;
export type TokenPatch = Partial<ThemeTokens>;

const COLOR_KEYS = ["accent", "accentLight", "accent2", "canvas", "ink", "ink2", "ink3"] as const satisfies readonly TokenKey[];
const RANGES: Partial<Record<TokenKey, [number, number]>> = {
  glassAlpha: [0, 1],
  glassBlur: [0, 40],
  borderWidth: [0, 4],
  borderAlpha: [0, 1],
  radius: [0, 32],
  shadow: [0, 2],
  fontScale: [0.8, 1.4],
  density: [0.75, 1.3],
  iconStroke: [1, 3],
};
const ENUMS: Partial<Record<TokenKey, readonly string[]>> = {
  cardStyle: ["glass", "solid", "outline"],
  font: ["jakarta", "system", "rounded", "serif", "mono"],
  widgetFrame: ["glass", "ultra", "solid", "frameless"],
  motion: ["full", "reduced", "off"],
};
/** The slider bounds the control centre shows (same as validation). */
export const RANGE_OF = RANGES as Record<string, [number, number]>;
export const OPTIONS_OF = ENUMS as Record<string, readonly string[]>;

const HEX = /^#[0-9a-f]{6}$/i;

/** Keep only known, valid tokens (an import or an old save can hold anything). Pure. */
export function sanitizePatch(raw: unknown): TokenPatch {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Own keys only: "constructor", "__proto__"… are inherited names, never tokens.
    if (!Object.hasOwn(DEFAULT_TOKENS, k)) continue;
    if ((COLOR_KEYS as readonly string[]).includes(k)) {
      if (typeof v === "string" && HEX.test(v)) out[k] = v.toLowerCase();
    } else if (Object.hasOwn(RANGES, k)) {
      const [lo, hi] = RANGES[k as TokenKey]!;
      if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
    } else if (Object.hasOwn(ENUMS, k)) {
      if (typeof v === "string" && ENUMS[k as TokenKey]!.includes(v)) out[k] = v;
    }
  }
  return out as TokenPatch;
}

/** sRGB relative luminance of a #rrggbb colour. Pure. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG contrast ratio of two #rrggbb colours (1-21). Pure. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Minimum contrast against the cards text sits on: body text, secondary text, faint hints, accents. */
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_SOFT_CONTRAST = 3;
export const MIN_FAINT_CONTRAST = 2;

/** The colour cards actually paint (glass / solid cards are the dark card fill; outline cards show the background). Pure. */
export function cardColor(t: Pick<ThemeTokens, "cardStyle" | "canvas">): string {
  return t.cardStyle === "outline" ? t.canvas : CARD_HEX;
}
const CARD_HEX = "#181c26";

/**
 * DEFAULT_TOKENS with each layer laid on top (later wins), validated, and never unreadable: each
 * text / accent colour that loses contrast with the cards (and, for body text, the background)
 * falls back to its default on its own. Pure.
 */
export function resolveTokens(...layers: (TokenPatch | null | undefined)[]): ThemeTokens {
  const t = { ...DEFAULT_TOKENS, ...Object.assign({}, ...layers.map((l) => sanitizePatch(l))) } as ThemeTokens;
  const on = cardColor(t);
  const ok = (c: string, min: number) => contrast(c, on) >= min && contrast(c, t.canvas) >= Math.min(min, MIN_SOFT_CONTRAST);
  if (!ok(t.ink, MIN_TEXT_CONTRAST)) t.ink = DEFAULT_TOKENS.ink;
  if (!ok(t.ink2, MIN_SOFT_CONTRAST)) t.ink2 = DEFAULT_TOKENS.ink2;
  if (!ok(t.ink3, MIN_FAINT_CONTRAST)) t.ink3 = DEFAULT_TOKENS.ink3;
  for (const k of ["accent", "accentLight", "accent2"] as const) if (contrast(t[k], on) < MIN_SOFT_CONTRAST) t[k] = DEFAULT_TOKENS[k];
  // A default text colour on a background picked for other text: keep the shipped background.
  if (contrast(t.ink, t.canvas) < MIN_SOFT_CONTRAST) t.canvas = DEFAULT_TOKENS.canvas;
  return t;
}

const FONT_STACK: Record<FontChoice, string> = {
  jakarta: '"Plus Jakarta Sans Variable", ui-sans-serif, system-ui, sans-serif',
  system: 'system-ui, "Segoe UI", Roboto, ui-sans-serif, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Plus Jakarta Sans Variable", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono Variable", ui-monospace, "Cascadia Mono", monospace',
};

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgb = (hex: string) => channels(hex).join(", ");
/** `a` mixed with `b` (`w` of a). Pure. */
const mix = (a: string, b: string, w: number) => `#${channels(a).map((x, i) => Math.round(x * w + channels(b)[i] * (1 - w)).toString(16).padStart(2, "0")).join("")}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The CSS custom properties a set of tokens becomes. Tailwind's own variables (`--color-*`,
 * `--font-sans`, `--spacing`) are overridden directly, so every utility follows; `--cc-*` feed the
 * glass / pill / field utilities and the `fs-*` / `r-*` text-size and radius utilities. Pure.
 */
export function tokensToCss(t: ThemeTokens): Record<string, string> {
  const card = "24, 28, 38";
  const bg =
    t.cardStyle === "solid" ? `rgba(${card}, ${r3(Math.max(0.94, t.glassAlpha))})` : t.cardStyle === "outline" ? "rgba(0, 0, 0, 0)" : `rgba(${card}, ${r3(t.glassAlpha)})`;
  const blur = t.cardStyle === "glass" ? t.glassBlur : 0;
  const edge = t.cardStyle === "outline" ? Math.max(0.35, t.borderAlpha) : t.borderAlpha;
  return {
    "--color-amber": t.accent,
    "--color-amber-light": t.accentLight,
    "--color-teal": t.accent2,
    "--color-canvas": t.canvas,
    "--color-ink": t.ink,
    "--color-ink-2": t.ink2,
    "--color-ink-3": t.ink3,
    "--font-sans": FONT_STACK[t.font],
    "--spacing": `${r3(0.25 * t.density)}rem`,
    "--radius-card": `${t.radius}px`,
    "--radius-module": `${r3(t.radius * 0.7)}px`,
    "--cc-accent-rgb": rgb(t.accent),
    "--cc-accent-light-rgb": rgb(t.accentLight),
    "--cc-accent2-rgb": rgb(t.accent2),
    // The shipped second-accent highlight and button gradient end, followed when the accents change.
    "--cc-accent2-light-rgb": t.accent2 === DEFAULT_TOKENS.accent2 ? "45, 212, 191" : rgb(mix(t.accent2, "#ffffff", 0.8)),
    "--cc-accent-end": t.accent === DEFAULT_TOKENS.accent ? "#ff6b4a" : mix(t.accent, "#ff3a6a", 0.85),
    "--cc-card-bg": bg,
    "--cc-glass-blur": `${blur}px`,
    "--cc-border-w": `${t.borderWidth}px`,
    "--cc-edge": String(r3(edge)),
    "--cc-shadow": String(r3(t.shadow)),
    "--cc-radius-scale": String(r3(t.radius / DEFAULT_TOKENS.radius)),
    "--cc-font-scale": String(r3(t.fontScale)),
    "--cc-icon-stroke": String(r3(t.iconStroke)),
  };
}

export interface Theme {
  id: string;
  name: string;
  tokens: TokenPatch;
  builtin?: boolean;
}

/** Ready-made themes (each is only what differs from the default). */
export const BUILTIN_THEMES: Theme[] = [
  { id: "default", name: "Neo-Glass (default)", tokens: {}, builtin: true },
  { id: "midnight", name: "Midnight solid", tokens: { cardStyle: "solid", glassAlpha: 0.96, accent: "#7c9cff", accentLight: "#a9bcff", accent2: "#4ade80", shadow: 1.4 }, builtin: true },
  { id: "outline", name: "Clean outline", tokens: { cardStyle: "outline", borderWidth: 1.5, borderAlpha: 0.4, shadow: 0, radius: 12, font: "system" }, builtin: true },
  { id: "large", name: "Large and roomy", tokens: { fontScale: 1.15, density: 1.15, radius: 24, iconStroke: 2.25 }, builtin: true },
];
