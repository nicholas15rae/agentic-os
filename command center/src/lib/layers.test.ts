// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Layer-stack guard (App.tsx's comment is the map). The ConfirmCard must paint above every
 * full-screen overlay, because a modal can raise a card itself: the Brainstorm intake's
 * "Dispatch to Play Place" does, and with the card under the modal (z-60 vs z-80) it could not
 * be clicked and timed out ("Cancelled (timed out) — nothing was sent."). Toasts sit above the
 * card so a failure toast is never hidden behind it.
 *
 * The scan reads class TEXT, not just `className="…"` tags (r17 review): a className written as
 * a template literal or a cn()/clsx() call, an arrow-function attribute before className, and
 * variant / important z utilities (`md:z-[100]`, `!z-[100]`) are all read; and every string in
 * src holding both `fixed` and `inset-0` must be one the scan parsed, so a new style of writing
 * an overlay fails here instead of slipping past.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

/** A Tailwind utility token, with any variant prefixes (`md:`, `lg:hover:`) and `!` (either end) allowed. */
const utility = (name: string) => new RegExp(`^!?(?:[a-z0-9-]+:)*!?${name}!?$`);
const Z_TOKEN = /^!?(?:[a-z0-9-]+:)*!?z-(?:\[(\d+)\]|(\d+))!?$/;
const FIXED = utility("fixed");
const INSET0 = utility("inset-0");

const tokens = (cls: string) => cls.split(/[\s"'`{}()?,+$]+/).filter(Boolean);

/** The highest positive z-index utility in a class text: `z-[80]`, `z-50`, `md:z-[100]`, `!z-[100]` (never `-z-10`). */
function zOf(cls: string): number | null {
  let best: number | null = null;
  for (const t of tokens(cls)) {
    const m = t.match(Z_TOKEN);
    if (m) best = Math.max(best ?? 0, Number(m[1] ?? m[2]));
  }
  return best;
}

const isFullScreen = (cls: string) => {
  const ts = tokens(cls);
  return ts.some((t) => FIXED.test(t)) && ts.some((t) => INSET0.test(t));
};

/** Index just past the string literal opening at `i` (a template's `${…}` parts are skipped whole). */
function skipString(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") j += 2;
    else if (c === q) return j + 1;
    else if (q === "`" && c === "$" && text[j + 1] === "{") j = skipBalanced(text, j + 1);
    else j++;
  }
  return j;
}

/** Index just past the bracket that closes the one opening at `i` (`{`/`(`), skipping strings. */
function skipBalanced(text: string, i: number): number {
  const open = text[i];
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(text, j);
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
    j++;
  }
  return j;
}

/** End of the JSX tag that contains `from` (its `>` at brace depth 0; `=>` inside `{…}` is skipped). */
function tagEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length) {
    const c = text[j];
    if (c === "{") j = skipBalanced(text, j);
    else if (c === '"' || c === "'" || c === "`") j = skipString(text, j);
    else if (c === ">") return j + 1;
    else j++;
  }
  return j;
}

type Layer = { file: string; z: number | null; cls: string; dialog: boolean; start: number; end: number };

/** Every class text in `text`: `className="…"` / `className={…}` (any expression) and cn()/clsx() calls. */
function parse(text: string, file: string): Layer[] {
  const out: Layer[] = [];
  const attr = /className\s*=\s*(["{])/g;
  for (let m = attr.exec(text); m; m = attr.exec(text)) {
    const at = m.index + m[0].length - 1;
    const end = m[1] === '"' ? skipString(text, at) : skipBalanced(text, at);
    const cls = text.slice(at, end);
    const tagStart = text.lastIndexOf("<", m.index);
    const tag = tagStart >= 0 ? text.slice(tagStart, tagEnd(text, end)) : "";
    out.push({ file, z: zOf(cls), cls, dialog: /role="dialog"/.test(tag), start: at, end });
    attr.lastIndex = end;
  }
  const call = /\b(?:cn|clsx|classNames|twMerge)\s*\(/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    const at = m.index + m[0].length - 1;
    if (out.some((l) => at >= l.start && at < l.end)) continue;
    const end = skipBalanced(text, at);
    const cls = text.slice(at, end);
    out.push({ file, z: zOf(cls), cls, dialog: false, start: at, end });
  }
  return out;
}

/** Every string literal in `text` holding both `fixed` and `inset-0` (comments dropped first). */
function overlayStrings(text: string): { start: number; end: number; s: string }[] {
  const out: { start: number; end: number; s: string }[] = [];
  const lit = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length)).replace(/(^|[^:\\])\/\/.*$/gm, (c, p: string) => p + " ".repeat(c.length - p.length));
  for (let m = lit.exec(noComments); m; m = lit.exec(noComments)) {
    if (isFullScreen(m[0])) out.push({ start: m.index, end: m.index + m[0].length, s: m[0] });
  }
  return out;
}

function scan(): { layers: Layer[]; unparsed: string[] } {
  const layers: Layer[] = [];
  const unparsed: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const found = parse(text, rel);
    layers.push(...found.filter((l) => l.z !== null));
    for (const s of overlayStrings(text)) {
      if (!found.some((l) => s.start >= l.start && s.end <= l.end)) unparsed.push(`${rel}: ${s.s}`);
    }
  }
  return { layers, unparsed };
}

const fixedOnly = (l: Layer) => tokens(l.cls).some((t) => FIXED.test(t));

describe("layer stack", () => {
  const { layers: all, unparsed } = scan();
  const card = all.filter((l) => l.file === "features/orchestrator/ConfirmCard.tsx" && isFullScreen(l.cls));
  const toasts = all.filter((l) => l.file === "components/Toasts.tsx" && fixedOnly(l));

  it("finds the ConfirmCard overlay and the Toasts layer", () => {
    expect(card).toHaveLength(1);
    expect(toasts).toHaveLength(1);
  });

  it("parses every `fixed inset-0` string in src (an unparsed overlay would slip past the guard)", () => {
    expect(unparsed).toEqual([]);
  });

  it("puts the ConfirmCard above every full-screen modal or drawer (it can be raised from inside one)", () => {
    const overlays = all.filter((l) => isFullScreen(l.cls) && l.file !== "features/orchestrator/ConfirmCard.tsx");
    // The scan must actually see the modals it guards (a regex that matched nothing would pass).
    const dialogs = overlays.filter((l) => l.dialog);
    expect(dialogs.map((l) => l.file)).toEqual(
      expect.arrayContaining(["features/buildhub/IntakeModal.tsx", "sections/PlayPlaceSection.tsx", "sections/settings/OsSettings.tsx", "sections/settings/LibrarySettings.tsx"]),
    );
    expect(overlays.map((l) => l.file)).toEqual(expect.arrayContaining(["sections/AgentsSection.tsx"]));
    for (const o of overlays) {
      expect(card[0].z, `${o.file} (z-${o.z}) must sit under the ConfirmCard`).toBeGreaterThan(o.z!);
    }
  });

  it("puts the Toasts above the ConfirmCard", () => {
    expect(toasts[0].z).toBeGreaterThan(card[0].z!);
  });

  it("reads z utilities (positive only, variants and ! included, the max wins)", () => {
    expect(zOf("fixed inset-0 z-[60] grid")).toBe(60);
    expect(zOf("fixed inset-0 -z-10")).toBeNull();
    expect(zOf("fixed inset-0 lg:-z-10")).toBeNull();
    expect(zOf("absolute z-50 w-60")).toBe(50);
    expect(zOf("fixed inset-0 z-[80] md:z-[100]")).toBe(100);
    expect(zOf("fixed inset-0 !z-[100]")).toBe(100);
    expect(zOf("fixed inset-0 z-[100]!")).toBe(100);
  });

  // The r17 review's mutations that passed the old tag regex: each must now be read as an overlay
  // above the card (z-90).
  it("reads overlays written in the codebase's other styles", () => {
    const over = (snippet: string) => parse(snippet, "x.tsx").filter((l) => isFullScreen(l.cls) && l.z !== null).map((l) => l.z);
    // M3: an arrow-function attribute before className.
    expect(over(`<div onClick={() => setDrawer(false)} className="fixed inset-0 z-[95] flex">`)).toEqual([95]);
    // M4: a template-literal className.
    expect(over("<div className={`fixed inset-0 z-[95] grid ${open ? \"flex\" : \"hidden\"}`} role=\"dialog\">")).toEqual([95]);
    // M7 / M8: variant and important z utilities.
    expect(over(`<div className="fixed inset-0 z-[85] md:z-[100] flex">`)).toEqual([100]);
    expect(over(`<div className="fixed inset-0 !z-[100] grid">`)).toEqual([100]);
    // cn() / clsx() arguments, inside className or not.
    expect(over(`<div className={cn("fixed inset-0", open && "z-[95]")}>`)).toEqual([95]);
    expect(over(`const overlay = clsx("fixed inset-0 z-[96]", cls);`)).toEqual([96]);
    // The dialog flag survives an arrow attribute before role.
    const d = parse(`<div onClick={() => close()} className="fixed inset-0 z-[80]" role="dialog">`, "x.tsx");
    expect(d[0].dialog).toBe(true);
  });

  it("flags a `fixed inset-0` string the scan cannot attribute to a class text", () => {
    const text = `const OVERLAY = "fixed inset-0 z-[99]";\n// a comment saying "fixed inset-0" is ignored\nexport const X = () => <div className={OVERLAY} />;`;
    const found = parse(text, "x.tsx");
    const loose = overlayStrings(text).filter((s) => !found.some((l) => s.start >= l.start && s.end <= l.end));
    expect(loose.map((s) => s.s)).toEqual(['"fixed inset-0 z-[99]"']);
  });
});
