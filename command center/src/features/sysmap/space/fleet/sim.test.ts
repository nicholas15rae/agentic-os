import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { curveClearance, FLEET_CONFIG, FleetSim } from "./sim";

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("FleetSim", () => {
  it("plans passes that clear the sun", () => {
    const sim = new FleetSim(seeded(7));
    for (let i = 0; i < 40; i++) {
      const c = sim.planCurve(i % 3 ? "chased" : "pursuit", null);
      expect(curveClearance(c)).toBeGreaterThan(FLEET_CONFIG.sunClearance);
    }
  });

  it("flies an alternating sortie with both sides firing, never through the sun", () => {
    const sim = new FleetSim(seeded(3));
    sim.auto = false;
    sim.trigger("chased");
    const kinds: string[] = [];
    let blue = 0;
    let red = 0;
    let closest = Infinity;
    let last: unknown = null;
    for (let i = 0; i < 60 * 200 && kinds.length < 2; i++) {
      sim.update(1 / 60);
      const f = sim.flight;
      if (f && f !== last) {
        kinds.push(f.kind);
        last = f;
      }
      for (const s of f?.ships ?? []) closest = Math.min(closest, s.pos.length());
      for (const b of sim.bolts) if (b.on && b.life > FLEET_CONFIG.boltRange / FLEET_CONFIG.boltSpeed + 0.28) b.blue ? blue++ : red++;
    }
    expect(kinds.slice(0, 2)).toEqual(["chased", "pursuit"]);
    expect(blue).toBeGreaterThan(0);
    expect(red).toBeGreaterThan(0);
    expect(closest).toBeGreaterThan(FLEET_CONFIG.sunClearance * 0.9);
  });

  it("courier runs swing past agent planets", () => {
    const sim = new FleetSim(seeded(11));
    sim.planets = new Map([
      ["a", new THREE.Vector3(12, 0, 0)],
      ["b", new THREE.Vector3(-15, 0, 8)],
    ]);
    const c = sim.planCurve("solo", null);
    const pts = [c.v1, c.v2].map((v) => Math.round(Math.hypot(v.x, v.z)));
    expect(pts.sort()).toEqual([12, 17]);
  });

  it("keeps the capital ship on its outer orbit", () => {
    const sim = new FleetSim(seeded(1));
    const p = new THREE.Vector3();
    const f = new THREE.Vector3();
    for (let a = 0; a < Math.PI * 2; a += 0.5) {
      sim.capitalPose(p, f, a);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(60);
      expect(f.length()).toBeCloseTo(1);
    }
  });
});
