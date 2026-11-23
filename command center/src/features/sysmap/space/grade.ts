/**
 * Ambient grade for the active nebula: the dominant colour (tints every sprite so it shares the
 * backdrop's light) and the brightest region (the direction rim light comes from).
 */
export type RGB = readonly [number, number, number];

export interface Grade {
  /** Dominant nebula colour, normalised so its brightest channel is 255. */
  tint: RGB;
  /** Colour of the brightest region (rim light). */
  light: RGB;
  /** Unit vector from the viewport centre towards the brightest region. */
  dir: { x: number; y: number };
}

export const NEUTRAL_GRADE: Grade = { tint: [200, 210, 255], light: [220, 225, 255], dir: { x: -0.6, y: -0.8 } };

const norm = (c: RGB): RGB => {
  const m = Math.max(1, ...c);
  return [Math.round((c[0] / m) * 255), Math.round((c[1] / m) * 255), Math.round((c[2] / m) * 255)];
};

/**
 * Grade a decoded wallpaper: a 48×27 reduction, a luminance²-weighted mean for the tint, and the
 * brightest 3×3 block for the light. Pure apart from one tiny scratch canvas.
 */
export function analyzeImage(img: CanvasImageSource): Grade {
  const W = 48;
  const H = 27;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return NEUTRAL_GRADE;
  g.drawImage(img, 0, 0, W, H);
  let d: Uint8ClampedArray;
  try {
    d = g.getImageData(0, 0, W, H).data;
  } catch {
    return NEUTRAL_GRADE;
  }
  return gradeFromPixels(d, W, H);
}

/** Pure core of `analyzeImage` (RGBA bytes, row-major). */
export function gradeFromPixels(d: ArrayLike<number>, W: number, H: number): Grade {
  let r = 0;
  let gg = 0;
  let b = 0;
  let wsum = 0;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const R = d[i * 4];
    const G = d[i * 4 + 1];
    const B = d[i * 4 + 2];
    const l = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
    lum[i] = l;
    const w = l * l;
    r += R * w;
    gg += G * w;
    b += B * w;
    wsum += w;
  }
  if (wsum < 1e-6) return NEUTRAL_GRADE;
  let best = -1;
  let bx = W / 2;
  let by = H / 2;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let s = 0;
      for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) s += lum[(y + k) * W + x + j];
      if (s > best) {
        best = s;
        bx = x;
        by = y;
      }
    }
  }
  const li = (by * W + bx) * 4;
  const dx = bx - W / 2;
  const dy = by - H / 2;
  const len = Math.hypot(dx, dy);
  return {
    tint: norm([r / wsum, gg / wsum, b / wsum]),
    light: norm([d[li], d[li + 1], d[li + 2]]),
    dir: len > 0.5 ? { x: dx / len, y: dy / len } : NEUTRAL_GRADE.dir,
  };
}

/** Grades for the procedural nebula fallbacks (index-matched to NEBULAE). */
export const NEBULA_GRADES: readonly Grade[] = [
  { tint: [170, 140, 255], light: [200, 170, 255], dir: { x: -0.7, y: -0.7 } },
  { tint: [120, 220, 235], light: [150, 235, 255], dir: { x: 0.8, y: -0.6 } },
  { tint: [210, 140, 220], light: [240, 170, 230], dir: { x: 0, y: -1 } },
];
