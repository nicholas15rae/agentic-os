// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UI fixes 3: the hand-fixed fortune cookie widget (assets-src/widgets/fortune-cookie, copied to
 * staging/fortune-cookie). Keeps the ids the build checks probe, the style kit, and the crack drawn
 * with transforms on two halves (the old build set clip-path to SVG path syntax, which the browser
 * rejects, so the cookie never cracked).
 */
const html = readFileSync(fileURLToPath(new URL("../../../assets-src/widgets/fortune-cookie/index.html", import.meta.url)), "utf8");

describe("fortune cookie widget", () => {
  it("keeps every brief point's element", () => {
    for (const id of ["cookie", "fortune-text", "new-fortune-btn", "history-container", "l1", "l2", "l3", "l4", "l5", "l6"]) expect(html).toContain(`id="${id}"`);
  });

  it("cracks with two halves, never an invalid clip-path", () => {
    expect(html).toContain('class="half left"');
    expect(html).toContain('class="half right"');
    expect(html).not.toMatch(/clipPath\s*=|clip-path\s*:\s*['"]?M/);
  });

  it("follows the style kit, a daily fortune, history of five and reduced motion", () => {
    expect(html).toContain('d.type === "cc-theme"');
    expect(html).toContain("seeded(\"fortune:\" + day)");
    expect(html).toContain(".slice(0, 5)");
    expect(html).toContain("prefers-reduced-motion");
  });
});
