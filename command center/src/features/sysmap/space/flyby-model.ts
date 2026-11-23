/**
 * Flyby flight planning (pure, unit-tested): peripheral edge-to-edge paths that keep clear of the
 * central sun, heading / mirroring, corner peeks, and weighted picks.
 */
export interface Pt {
  x: number;
  y: number;
}

export interface FlightPlan {
  from: Pt;
  to: Pt;
  /** Degrees, applied after the mirror. */
  angle: number;
  /** Mirror horizontally (sprites face right; leftward travel mirrors instead of flipping upside-down). */
  flip: boolean;
}

/** Paths never pass closer than this fraction of the short side to the viewport centre. */
export const CENTRE_CLEARANCE = 0.26;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const range = (r: readonly [number, number], rnd: () => number) => lerp(r[0], r[1], rnd());

/** Distance from point p to segment ab. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Heading of a path: rightward travel rotates; leftward mirrors and rotates the other way. */
export function heading(from: Pt, to: Pt): { angle: number; flip: boolean } {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  if (Math.abs(deg) <= 90) return { angle: deg, flip: false };
  let a = deg - 180;
  if (a <= -180) a += 360;
  return { angle: a, flip: true };
}

/** A band position near one edge: [0.04, 0.24] or [0.76, 0.96] of the span. */
function outerBand(rnd: () => number): number {
  return rnd() < 0.5 ? lerp(0.04, 0.24, rnd()) : lerp(0.76, 0.96, rnd());
}

function crossOnce(w: number, h: number, m: number, rnd: () => number): [Pt, Pt] {
  const horizontal = rnd() < 0.72;
  const forward = rnd() < 0.5;
  if (horizontal) {
    const y0 = outerBand(rnd) * h;
    let y1 = y0 + (rnd() - 0.5) * 0.16 * h;
    y1 = y0 < h / 2 ? Math.min(Math.max(y1, 0.02 * h), 0.3 * h) : Math.max(Math.min(y1, 0.98 * h), 0.7 * h);
    const a = { x: -m, y: y0 };
    const b = { x: w + m, y: y1 };
    return forward ? [a, b] : [b, a];
  }
  const x0 = outerBand(rnd) * w;
  let x1 = x0 + (rnd() - 0.5) * 0.12 * w;
  x1 = x0 < w / 2 ? Math.min(Math.max(x1, 0.02 * w), 0.28 * w) : Math.max(Math.min(x1, 0.98 * w), 0.72 * w);
  const a = { x: x0, y: -m };
  const b = { x: x1, y: h + m };
  return forward ? [a, b] : [b, a];
}

function streakOnce(w: number, h: number, m: number, rnd: () => number): [Pt, Pt] {
  // Enter through the top or bottom edge near a corner, leave through that corner's side edge.
  const top = rnd() < 0.6;
  const left = rnd() < 0.5;
  const ex = lerp(0.04, 0.42, rnd()) * w;
  const sy = lerp(0.08, 0.45, rnd()) * h;
  const from = { x: left ? ex : w - ex, y: top ? -m : h + m };
  const to = { x: left ? -m : w + m, y: top ? sy : h - sy };
  return rnd() < 0.5 ? [from, to] : [to, from];
}

/** Plan an edge-to-edge pass that stays in the periphery (retries until it clears the centre). */
export function planPath(motion: "cross" | "streak", w: number, h: number, margin: number, rnd: () => number = Math.random): FlightPlan {
  const centre = { x: w / 2, y: h / 2 };
  const clear = CENTRE_CLEARANCE * Math.min(w, h);
  let best: [Pt, Pt] | null = null;
  let bestD = -1;
  for (let i = 0; i < 24; i++) {
    const p = motion === "cross" ? crossOnce(w, h, margin, rnd) : streakOnce(w, h, margin, rnd);
    const d = segDist(centre, p[0], p[1]);
    if (d > bestD) {
      best = p;
      bestD = d;
    }
    if (d >= clear) break;
  }
  const [from, to] = best!;
  return { from, to, ...heading(from, to) };
}

/** A cubic Bézier flight curve. */
export interface Curve {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}

export function bezier(c: Curve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
}

/** First derivative (direction of travel, unnormalised). */
export function bezierTangent(c: Curve, t: number): Pt {
  const u = 1 - t;
  return {
    x: 3 * u * u * (c.p1.x - c.p0.x) + 6 * u * t * (c.p2.x - c.p1.x) + 3 * t * t * (c.p3.x - c.p2.x),
    y: 3 * u * u * (c.p1.y - c.p0.y) + 6 * u * t * (c.p2.y - c.p1.y) + 3 * t * t * (c.p3.y - c.p2.y),
  };
}

/** Closest approach of a curve to a point (sampled). */
export function curveClearance(c: Curve, p: Pt, samples = 32): number {
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const q = bezier(c, i / samples);
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best;
}

/**
 * A smooth edge-to-edge flight curve through the periphery: endpoints from `planPath`, the two
 * control points bowed sideways, retried until the whole curve clears the centre (the sun).
 */
export function planCurve(w: number, h: number, margin: number, clearance = CENTRE_CLEARANCE, rnd: () => number = Math.random): Curve {
  const centre = { x: w / 2, y: h / 2 };
  const need = clearance * Math.min(w, h);
  let best: Curve | null = null;
  let bestD = -1;
  for (let i = 0; i < 24; i++) {
    const { from, to } = planPath("cross", w, h, margin, rnd);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / len, y: dx / len };
    const bow = () => (rnd() - 0.5) * 0.28 * Math.min(w, h);
    const b1 = bow();
    const b2 = bow();
    const c: Curve = {
      p0: from,
      p1: { x: from.x + dx / 3 + n.x * b1, y: from.y + dy / 3 + n.y * b1 },
      p2: { x: from.x + (2 * dx) / 3 + n.x * b2, y: from.y + (2 * dy) / 3 + n.y * b2 },
      p3: to,
    };
    const d = curveClearance(c, centre);
    if (d > bestD) {
      best = c;
      bestD = d;
    }
    if (d >= need) break;
  }
  return best!;
}

/** Weighted random pick (null for an empty list). */
export function pickWeighted<T extends { weight: number }>(items: readonly T[], rnd: () => number = Math.random): T | null {
  const total = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (!items.length || total <= 0) return null;
  let r = rnd() * total;
  for (const i of items) {
    r -= Math.max(0, i.weight);
    if (r < 0) return i;
  }
  return items[items.length - 1];
}
