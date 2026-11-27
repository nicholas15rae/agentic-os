import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { encodeQr, qrSvgPath, type QrMatrix } from "./qr";

/** Rasterise the matrix (4 px per module, 4-module quiet zone) and decode it with jsqr. */
function decode(q: QrMatrix): string | null {
  const scale = 4;
  const quiet = 4;
  const w = (q.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }
  return jsQR(px, w, w)?.data ?? null;
}

describe("the pairing QR encoder", () => {
  it("round-trips short and long payloads through a real decoder", () => {
    const pairing = `gbgpair1|${"a1b2c3d4".repeat(8)}|1795000000|DESKTOP-NIC-0f3a9c21`;
    for (const text of ["hi", "HELLO WORLD 123", pairing, "x".repeat(150), "ü-é-✓ unicode", "z".repeat(400)]) {
      const q = encodeQr(text);
      expect(q.size).toBe(q.version * 4 + 17);
      expect(decode(q), `v${q.version} ${text.slice(0, 20)}`).toBe(text);
    }
  });

  it("picks the smallest version and refuses what can't fit", () => {
    expect(encodeQr("hi").version).toBe(1);
    expect(encodeQr("x".repeat(100)).version).toBeGreaterThanOrEqual(5);
    expect(() => encodeQr("x".repeat(500))).toThrow(/too long/);
  });

  it("draws one path with a quiet zone", () => {
    const q = encodeQr("hi");
    const { path, viewBox } = qrSvgPath(q);
    expect(viewBox).toBe(q.size + 8);
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true); // the finder's top-left corner
  });
});
