import { describe, expect, it } from "vitest";
import { gradeFromPixels, NEUTRAL_GRADE } from "./grade";

function image(W: number, H: number, px: (x: number, y: number) => [number, number, number]) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      d.set([r, g, b, 255], (y * W + x) * 4);
    }
  return d;
}

describe("gradeFromPixels", () => {
  it("takes the dominant colour and points the light at the brightest region", () => {
    // Dim violet everywhere, a bright amber blob in the upper right.
    const d = image(48, 27, (x, y) => (x > 36 && x < 42 && y > 3 && y < 8 ? [255, 190, 90] : [60, 30, 90]));
    const g = gradeFromPixels(d, 48, 27);
    expect(g.light[0]).toBe(255);
    expect(g.light[2]).toBeLessThan(g.light[0]);
    expect(g.dir.x).toBeGreaterThan(0.5);
    expect(g.dir.y).toBeLessThan(0);
    expect(Math.max(...g.tint)).toBe(255);
  });

  it("falls back to neutral on a black frame", () => {
    expect(gradeFromPixels(image(48, 27, () => [0, 0, 0]), 48, 27)).toEqual(NEUTRAL_GRADE);
  });
});
