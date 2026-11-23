import { describe, expect, it } from "vitest";
import { bezier, bezierTangent, CENTRE_CLEARANCE, curveClearance, heading, pickWeighted, planCurve, planPath, segDist } from "./flyby-model";

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe("flyby paths", () => {
  for (const [w, h] of [
    [1600, 900],
    [900, 700],
    [420, 800],
  ]) {
    it(`cross and streak paths keep clear of the centre at ${w}×${h}`, () => {
      const rnd = seeded(w + h);
      const c = { x: w / 2, y: h / 2 };
      for (let i = 0; i < 300; i++) {
        for (const m of ["cross", "streak"] as const) {
          const p = planPath(m, w, h, 80, rnd);
          expect(segDist(c, p.from, p.to)).toBeGreaterThanOrEqual(CENTRE_CLEARANCE * Math.min(w, h) - 1e-6);
        }
      }
    });
  }

  it("cross paths start and end off-screen", () => {
    const rnd = seeded(3);
    const off = (p: { x: number; y: number }) => p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 600;
    for (let i = 0; i < 100; i++) {
      const p = planPath("cross", 1000, 600, 60, rnd);
      expect(off(p.from) && off(p.to)).toBe(true);
    }
  });

  it("Bézier flight curves keep clear of the centre and start / end off-screen", () => {
    const rnd = seeded(21);
    for (const [w, h] of [
      [1600, 900],
      [1174, 574],
    ]) {
      for (let i = 0; i < 200; i++) {
        const c = planCurve(w, h, 90, CENTRE_CLEARANCE, rnd);
        expect(curveClearance(c, { x: w / 2, y: h / 2 })).toBeGreaterThanOrEqual(CENTRE_CLEARANCE * Math.min(w, h) - 1e-6);
        const off = (p: { x: number; y: number }) => p.x < 0 || p.x > w || p.y < 0 || p.y > h;
        expect(off(c.p0) && off(c.p3)).toBe(true);
      }
    }
  });
});

describe("bezier", () => {
  it("hits its endpoints and points along the chord on a straight curve", () => {
    const c = { p0: { x: 0, y: 0 }, p1: { x: 10, y: 0 }, p2: { x: 20, y: 0 }, p3: { x: 30, y: 0 } };
    expect(bezier(c, 0)).toEqual({ x: 0, y: 0 });
    expect(bezier(c, 1)).toEqual({ x: 30, y: 0 });
    expect(bezier(c, 0.5).x).toBeCloseTo(15);
    const t = bezierTangent(c, 0.3);
    expect(t.x).toBeGreaterThan(0);
    expect(t.y).toBeCloseTo(0);
  });
});

describe("heading", () => {
  it("rotates rightward travel and mirrors leftward travel", () => {
    expect(heading({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ angle: 0, flip: false });
    expect(heading({ x: 10, y: 0 }, { x: 0, y: 0 })).toEqual({ angle: 0, flip: true });
    const upLeft = heading({ x: 10, y: 10 }, { x: 0, y: 0 });
    expect(upLeft.flip).toBe(true);
    expect(upLeft.angle).toBeCloseTo(45);
    expect(heading({ x: 0, y: 0 }, { x: 10, y: 10 }).angle).toBeCloseTo(45);
  });
});

describe("pickWeighted", () => {
  it("respects weights and handles empty lists", () => {
    expect(pickWeighted([])).toBeNull();
    expect(pickWeighted([{ id: "a", weight: 0 }, { id: "b", weight: 1 }], () => 0.99)?.id).toBe("b");
    expect(pickWeighted([{ id: "a", weight: 3 }, { id: "b", weight: 1 }], () => 0.5)?.id).toBe("a");
  });
});
