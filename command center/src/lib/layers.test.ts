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

/** A positive z-index utility in a class string: `z-[80]` or `z-50` (never `-z-10`). */
function zOf(cls: string): number | null {
  const m = cls.match(/(?:^|\s)z-\[(\d+)\](?=\s|$)/) ?? cls.match(/(?:^|\s)z-(\d+)(?=\s|$)/);
  return m ? Number(m[1]) : null;
}

type Layer = { file: string; z: number; cls: string; dialog: boolean };

/** Every `className="…"` with a positive z, plus whether its element is a role="dialog". */
function layers(): Layer[] {
  const out: Layer[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(SRC, file).replace(/\\/g, "/");
    for (const tag of text.match(/<[a-zA-Z][^<>]*className="[^"]*"[^<>]*>/g) ?? []) {
      const cls = tag.match(/className="([^"]*)"/)![1];
      const z = zOf(cls);
      if (z !== null) out.push({ file: rel, z, cls, dialog: /role="dialog"/.test(tag) });
    }
  }
  return out;
}

const fullScreen = (l: Layer) => /(?:^|\s)fixed(?=\s)/.test(l.cls) && /(?:^|\s)inset-0(?=\s)/.test(l.cls);

describe("layer stack", () => {
  const all = layers();
  const card = all.filter((l) => l.file === "features/orchestrator/ConfirmCard.tsx" && fullScreen(l));
  const toasts = all.filter((l) => l.file === "components/Toasts.tsx" && /(?:^|\s)fixed(?=\s)/.test(l.cls));

  it("finds the ConfirmCard overlay and the Toasts layer", () => {
    expect(card).toHaveLength(1);
    expect(toasts).toHaveLength(1);
  });

  it("puts the ConfirmCard above every full-screen modal or drawer (it can be raised from inside one)", () => {
    const overlays = all.filter((l) => fullScreen(l) && l.file !== "features/orchestrator/ConfirmCard.tsx");
    // The scan must actually see the modals it guards (a regex that matched nothing would pass).
    const dialogs = overlays.filter((l) => l.dialog);
    expect(dialogs.map((l) => l.file)).toEqual(
      expect.arrayContaining(["features/buildhub/IntakeModal.tsx", "sections/PlayPlaceSection.tsx"]),
    );
    for (const o of overlays) {
      expect(card[0].z, `${o.file} (z-${o.z}) must sit under the ConfirmCard`).toBeGreaterThan(o.z);
    }
  });

  it("puts the Toasts above the ConfirmCard", () => {
    expect(toasts[0].z).toBeGreaterThan(card[0].z);
  });

  it("reads z utilities (positive only)", () => {
    expect(zOf("fixed inset-0 z-[60] grid")).toBe(60);
    expect(zOf("fixed inset-0 -z-10")).toBeNull();
    expect(zOf("absolute z-50 w-60")).toBe(50);
  });
});
