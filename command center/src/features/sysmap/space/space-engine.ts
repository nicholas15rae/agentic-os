/**
 * Orbital Ecosystem ambient space engine — one 2D canvas (`pointer-events: none`) between the
 * wallpaper / starfield layers and the WebGL star map. Back to front:
 *
 *   Layer 1  Death Star easter egg: rare, small, far-plane graded, slow parallax drift.
 *   Layer 2  Debris field (multi-depth tumbling asteroids) + E46 flight events along Bézier
 *            curves: solo cruises, and dogfight sorties of 2–4 back-to-back passes that
 *            alternate the E46 being chased (shooting back) and chasing (under return fire),
 *            each re-entering from the side the last left — banking, Z-depth scaling, and a
 *            side ↔ rear (GABAGOUL plate) swap when the ship recedes.
 *   Layer 3  Procedural FX, additive (`lighter`): blue / red bolts with hot cores, ion and
 *            engine trails scaled by speed, shield flashes and impact sparks, thruster bloom.
 *
 * Every sprite is pre-baked once per nebula grade (scaled, ambient-tinted, rim-lit, and a
 * blurred low-contrast far variant), so a frame is only `drawImage` calls. Particles, bolts and
 * rocks live in fixed pools (no per-frame allocation). Delta time is clamped; the loop stops
 * entirely while inactive (window hidden / page left).
 */
import { bezier, bezierTangent, CENTRE_CLEARANCE, planCurve, type Curve } from "./flyby-model";
import { NEUTRAL_GRADE, type Grade, type RGB } from "./grade";
import type { Parallax } from "./parallax";
import { ASTEROID_BAKE_WIDTH, SPRITE_META, SPRITE_URLS, type SpriteMeta } from "./space-assets";

/** Tuning knobs. Times in seconds; sizes as fractions of the viewport's short side. */
export const BACKDROP_CONFIG = {
  /** Frame cap for this canvas (the WebGL map runs at its own 30 fps cap). */
  maxFps: 60,
  /** Wallpaper sway speed, degrees per minute, and its ± range in degrees. */
  nebulaRotationSpeed: 0.8,
  nebulaRotationRange: 2.5,
  /** Wallpaper drift amplitude, px. */
  nebulaDriftPx: 26,
  /** Seconds each wallpaper holds before crossfading, and the crossfade length. */
  wallpaperCycleInterval: 240,
  wallpaperCrossfade: 5,
  /** Seconds between Death Star appearances (randomised in this range), and how long it stays. */
  deathStarRarity: [300, 720] as const,
  deathStarDuration: [100, 160] as const,
  deathStarOpacity: 0.3,
  deathStarSize: [0.1, 0.2] as const,
  /** Seconds between flight events (randomised), and the share that are dogfights. */
  flybyFrequency: [55, 130] as const,
  dogfightProbability: 0.6,
  /** A dogfight is a sortie of back-to-back passes that alternate chased ↔ chasing. */
  sortiePasses: [2, 4] as const,
  /** Seconds between passes of a sortie (they re-enter from the side the last one left). */
  sortieGap: [1.5, 4] as const,
  /** Cooldown multiplier for the side being chased when it shoots back (higher = fewer shots). */
  returnFireRate: 1.7,
  shipOpacity: 0.78,
  /** E46 drawn width at depth 1. */
  e46Size: 0.2,
  enemySize: 0.085,
  debrisCount: 8,
  debrisOpacity: 0.5,
  /** Additive glow strength for bolts, trails and thrusters (0–1.5). */
  fxBloomIntensity: 0.85,
  /** How strongly sprites take the nebula's dominant colour (0–1). */
  spriteColorGradeStrength: 0.35,
  /** Rim light from the nebula's brightest region (0–1). */
  rimLightStrength: 0.32,
  /** Midground keeps this far from the sun (fraction of the short side). */
  centreClearance: CENTRE_CLEARANCE,
};

export type FlightKind = "solo" | "chased" | "pursuit";
export type TriggerKind = FlightKind | "station" | "random";

// ── small utils ──────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrapAngle = (a: number) => {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
};
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Halving steps then a final high-quality resample (big ratios alias otherwise). */
function downscale(img: HTMLImageElement, maxW: number): HTMLCanvasElement {
  const k = Math.min(1, maxW / img.naturalWidth);
  const w = Math.round(img.naturalWidth * k);
  const h = Math.round(img.naturalHeight * k);
  let cur: CanvasImageSource = img;
  let cw = img.naturalWidth;
  let ch = img.naturalHeight;
  while (cw / 2 > w) {
    const n = makeCanvas(cw / 2, ch / 2);
    const g = n.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, n.width, n.height);
    cur = n;
    cw = n.width;
    ch = n.height;
  }
  const out = makeCanvas(w, h);
  const g = out.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

const FAR_FILTER = "blur(1.1px) contrast(0.78) brightness(0.7) saturate(0.72)";

/** Grade one variant: depth filter → ambient multiply tint → alpha restore → rim light. */
function bake(base: HTMLCanvasElement, grade: Grade, far: boolean, mirror: boolean, rim: number): HTMLCanvasElement {
  const pad = far ? 3 : 0;
  const c = makeCanvas(base.width + pad * 2, base.height + pad * 2);
  const g = c.getContext("2d")!;
  const shape = (filter: string) => {
    g.save();
    g.filter = filter;
    if (mirror) {
      g.translate(c.width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(base, pad, pad);
    g.restore();
  };
  shape(far ? FAR_FILTER : "none");
  g.globalCompositeOperation = "multiply";
  g.fillStyle = css(mix([255, 255, 255], grade.tint, BACKDROP_CONFIG.spriteColorGradeStrength));
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "destination-in";
  shape(far ? "blur(1.1px)" : "none");
  if (rim > 0) {
    g.globalCompositeOperation = "source-atop";
    const cx = c.width / 2;
    const cy = c.height / 2;
    const r = Math.hypot(c.width, c.height) / 2;
    const grd = g.createLinearGradient(cx + grade.dir.x * r, cy + grade.dir.y * r, cx, cy);
    grd.addColorStop(0, css(grade.light, rim));
    grd.addColorStop(0.5, css(grade.light, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
  }
  g.globalCompositeOperation = "source-over";
  return c;
}

function glowTexture(c: RGB): HTMLCanvasElement {
  const t = makeCanvas(64, 64);
  const g = t.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, css(c, 0.85));
  grd.addColorStop(0.5, css(c, 0.22));
  grd.addColorStop(1, css(c, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return t;
}

// ── entities ─────────────────────────────────────────────────────────────────

interface Sprite {
  name: string;
  meta: SpriteMeta;
  base: HTMLCanvasElement;
  aspect: number;
  /** [near, far] × [normal, mirrored]; rocks and the station never mirror. */
  v: [[HTMLCanvasElement, HTMLCanvasElement | null], [HTMLCanvasElement, HTMLCanvasElement | null]] | null;
}

const BLUE: RGB = [90, 190, 255];
const RED: RGB = [255, 70, 55];
const HOT: RGB = [255, 225, 190];

interface Particle {
  on: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  /** 0 blue · 1 red · 2 spark · 3 shield ring */
  kind: 0 | 1 | 2 | 3;
}

interface Bolt {
  on: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  life: number;
  blue: boolean;
  target: Ship | null;
  grazed: boolean;
}

interface Rock {
  sprite: Sprite;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  size: number;
}

interface Ship {
  player: boolean;
  side: Sprite;
  rear: Sprite | null;
  /** Seconds behind the event clock. */
  lag: number;
  lateral: number;
  weaveAmp: number;
  weaveF: number;
  weaveP: number;
  width: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  speed: number;
  heading: number;
  turn: number;
  rearMix: number;
  visible: boolean;
  u: number;
  fireCd: number;
  /** Ships this one shoots at (nearest visible in range); empty = holds fire. */
  foes: Ship[];
  /** Cooldown multiplier: 1 attacking, `returnFireRate` when shooting back while chased. */
  fireRate: number;
  /** Draw-state cache for FX anchoring. */
  draw: { sprite: Sprite; mirror: boolean; rot: number; sy: number; w: number; h: number } | null;
}

interface Flight {
  curve: Curve;
  z0: number;
  z1: number;
  dur: number;
  t: number;
  ships: Ship[];
}

interface Station {
  x: number;
  y: number;
  vx: number;
  vy: number;
  d: number;
  t: number;
  life: number;
}

const P_MAX = 700;
const B_MAX = 64;

// ── engine ───────────────────────────────────────────────────────────────────

export class SpaceEngine {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private raf = 0;
  private last = 0;
  private active = false;
  private reduced = false;
  private auto = true;
  private intensity = 1;
  private grade: Grade = NEUTRAL_GRADE;
  private gradeTarget: Grade = NEUTRAL_GRADE;
  private gradeFrom: Grade = NEUTRAL_GRADE;
  private gradeT = 1;
  private gradeStep = -1;
  private sprites = new Map<string, Sprite>();
  private asteroids: Sprite[] = [];
  private loaded = false;
  private particles: Particle[] = Array.from({ length: P_MAX }, () => ({ on: false, x: 0, y: 0, z: 1, vx: 0, vy: 0, life: 0, max: 1, size: 1, kind: 0 }));
  private pCursor = 0;
  private bolts: Bolt[] = Array.from({ length: B_MAX }, () => ({ on: false, x: 0, y: 0, z: 1, vx: 0, vy: 0, life: 0, blue: true, target: null, grazed: false }));
  private rocks: Rock[] = [];
  private flight: Flight | null = null;
  private station: Station | null = null;
  /** First appearances come early so the page visibly comes alive; then the normal cadence. */
  private nextFlight = rand(8, 20);
  /** Passes still to fly in the current sortie, the gap timer, and where the last pass left. */
  private sortie = { left: 0, gap: 0, kind: "chased" as FlightKind, exit: null as { x: number; y: number } | null };
  private nextStation = rand(60, 150);
  private glow: Record<"blue" | "red" | "hot", HTMLCanvasElement>;
  private par = { x: 0, y: 0 };
  private disposed = false;
  private canvas: HTMLCanvasElement;
  private parallax: Parallax;

  constructor(canvas: HTMLCanvasElement, parallax: Parallax) {
    this.canvas = canvas;
    this.parallax = parallax;
    this.ctx = canvas.getContext("2d")!;
    this.glow = { blue: glowTexture(BLUE), red: glowTexture(RED), hot: glowTexture(HOT) };
    void this.load();
  }

  // ── public API ──

  setSize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const first = !this.w;
    this.w = w;
    this.h = h;
    if (first || !this.rocks.length) this.seedRocks();
    if (!this.active) this.render();
  }

  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    cancelAnimationFrame(this.raf);
    if (on) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  setOptions(o: { reduced: boolean; auto: boolean; intensity: number }) {
    this.reduced = o.reduced;
    this.auto = o.auto;
    if (o.intensity !== this.intensity) {
      this.intensity = o.intensity;
      this.seedRocks();
    }
  }

  /** New nebula grade: sprites re-grade over the wallpaper crossfade (a few re-bakes). */
  setGrade(g: Grade) {
    this.gradeFrom = this.grade;
    this.gradeTarget = g;
    this.gradeT = 0;
    this.gradeStep = -1;
    if (!this.loaded) {
      this.grade = g;
      this.gradeT = 1;
    }
  }

  trigger(kind: TriggerKind) {
    if (kind === "station") return void this.spawnStation();
    const k: FlightKind = kind === "random" ? this.pickFlight() : kind;
    this.flight = null;
    this.startEvent(k);
  }

  dispose() {
    this.disposed = true;
    this.setActive(false);
    this.parallax.dispose();
  }

  // ── loading & grading ──

  private async load() {
    const entries = [...SPRITE_URLS.entries()];
    const imgs = await Promise.all(
      entries.map(async ([name, url]) => {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        try {
          await img.decode();
          return [name, img] as const;
        } catch {
          return null;
        }
      }),
    );
    if (this.disposed) return;
    for (const e of imgs) {
      if (!e) continue;
      const [name, img] = e;
      const meta: SpriteMeta = SPRITE_META[name] ?? { nose: 0, thrusters: [], bakeWidth: ASTEROID_BAKE_WIDTH };
      const base = downscale(img, meta.bakeWidth);
      const s: Sprite = { name, meta, base, aspect: base.height / base.width, v: null };
      this.sprites.set(name, s);
      if (name.startsWith("asteroid_")) this.asteroids.push(s);
    }
    this.loaded = true;
    this.rebake();
    this.seedRocks();
  }

  private rebake() {
    for (const s of this.sprites.values()) {
      const rock = s.name.startsWith("asteroid_");
      const rim = rock ? 0 : BACKDROP_CONFIG.rimLightStrength;
      const ds = s.name === "death_star";
      const mirrors = !rock && !ds;
      const far = bake(s.base, this.grade, true, false, rim);
      s.v = [
        [ds ? far : bake(s.base, this.grade, false, false, rim), mirrors ? bake(s.base, this.grade, false, true, rim) : null],
        [far, mirrors ? bake(s.base, this.grade, true, true, rim) : null],
      ];
    }
  }

  private stepGrade(dt: number) {
    if (this.gradeT >= 1) return;
    this.gradeT = Math.min(1, this.gradeT + dt / Math.max(0.5, BACKDROP_CONFIG.wallpaperCrossfade));
    // Re-bake in 5 steps across the crossfade, not every frame.
    const step = Math.min(5, Math.floor(this.gradeT * 5));
    if (step === this.gradeStep) return;
    this.gradeStep = step;
    const k = step / 5;
    const a = this.gradeFrom;
    const b = this.gradeTarget;
    const dx = a.dir.x + (b.dir.x - a.dir.x) * k;
    const dy = a.dir.y + (b.dir.y - a.dir.y) * k;
    const len = Math.hypot(dx, dy) || 1;
    this.grade = { tint: mix(a.tint, b.tint, k), light: mix(a.light, b.light, k), dir: { x: dx / len, y: dy / len } };
    if (this.loaded) this.rebake();
  }

  // ── spawning ──

  private get minSide() {
    return Math.min(this.w, this.h) || 1;
  }

  private seedRocks() {
    if (!this.asteroids.length || !this.w) return;
    const n = Math.round(BACKDROP_CONFIG.debrisCount * (this.intensity < 1 ? 0.7 : 1));
    this.rocks = Array.from({ length: n }, (_, i) => {
      const s = pick(this.asteroids);
      const z = 0.25 + (i / Math.max(1, n - 1)) * 0.65 + rand(-0.05, 0.05);
      const dir = rand(0, TAU);
      const sp = rand(5, 16) * z;
      return { sprite: s, x: rand(0, this.w), y: rand(0, this.h), z, vx: Math.cos(dir) * sp - 3 * z, vy: Math.sin(dir) * sp * 0.5, rot: rand(0, TAU), vrot: rand(-0.25, 0.25), size: (s.base.width / ASTEROID_BAKE_WIDTH) * this.minSide * rand(0.06, 0.1) * z };
    });
    this.rocks.sort((a, b) => a.z - b.z);
  }

  private pickFlight(): FlightKind {
    return Math.random() < BACKDROP_CONFIG.dogfightProbability ? (Math.random() < 0.5 ? "chased" : "pursuit") : "solo";
  }

  private newShip(player: boolean, lag: number, lateral: number): Ship | null {
    const side = player ? this.sprites.get("e46_side") : this.sprites.get(pick(["enemy_fighter_1", "enemy_fighter_2"].filter((n) => this.sprites.has(n))) ?? "");
    if (!side) return null;
    const width = (player ? BACKDROP_CONFIG.e46Size : BACKDROP_CONFIG.enemySize) * this.minSide;
    return { player, side, rear: player ? (this.sprites.get("e46_rear") ?? null) : null, lag, lateral, weaveAmp: 0, weaveF: rand(0.6, 1.1), weaveP: rand(0, TAU), width, x: -9999, y: -9999, z: 1, vx: 0, vy: 0, speed: 0, heading: 0, turn: 0, rearMix: 0, visible: false, u: 0, fireCd: rand(0.6, 1.6), foes: [], fireRate: 1, draw: null };
  }

  /** A fresh event: dogfights open a sortie of alternating passes. */
  private startEvent(kind: FlightKind) {
    const dogfight = kind !== "solo";
    const [a, b] = BACKDROP_CONFIG.sortiePasses;
    this.sortie = { left: dogfight ? Math.floor(rand(a, b + 1)) - 1 : 0, gap: 0, kind, exit: null };
    this.spawnFlight(kind);
  }

  private spawnFlight(kind: FlightKind) {
    if (!this.loaded || !this.w) return;
    const curve = planCurve(this.w, this.h, this.minSide * 0.35, BACKDROP_CONFIG.centreClearance);
    // Next pass of a sortie: fly back in from the side the last pass left by.
    const exit = this.sortie.exit;
    if (exit && Math.hypot(curve.p0.x - exit.x, curve.p0.y - exit.y) > Math.hypot(curve.p3.x - exit.x, curve.p3.y - exit.y)) {
      [curve.p0, curve.p3] = [curve.p3, curve.p0];
      [curve.p1, curve.p2] = [curve.p2, curve.p1];
    }
    this.sortie.kind = kind;
    this.sortie.exit = curve.p3;
    const len = Math.hypot(curve.p3.x - curve.p0.x, curve.p3.y - curve.p0.y) * 1.15;
    // Solo cruises sometimes bank away into the distance (rear plate view).
    const recede = kind === "solo" && Math.random() < 0.5;
    const z0 = recede ? rand(0.85, 1) : rand(0.6, 0.95);
    // Dogfights hold roughly level depth, so only a real bank-away flips to the rear view.
    const z1 = recede ? rand(0.32, 0.45) : clamp(z0 + rand(-0.1, 0.15), 0.5, 1);
    const speed = rand(170, 240) * ((z0 + z1) / 2) * (kind === "solo" ? 0.85 : 1.15);
    const dur = len / speed;
    const ships: Ship[] = [];
    const player = this.newShip(true, kind === "pursuit" ? rand(1.6, 2.2) : 0, 0);
    if (!player) return;
    // The E46 jinks hard when chased and still weaves when hunting.
    player.weaveAmp = this.minSide * (kind === "chased" ? rand(0.03, 0.05) : kind === "pursuit" ? rand(0.015, 0.03) : 0);
    ships.push(player);
    if (kind !== "solo") {
      const n = kind === "chased" ? (Math.random() < 0.5 ? 2 : 3) : 2;
      for (let i = 0; i < n; i++) {
        const lag = kind === "chased" ? rand(1.0, 1.6) + i * rand(0.45, 0.8) : i * rand(0.35, 0.6);
        const e = this.newShip(false, lag, (i % 2 ? 1 : -1) * this.minSide * rand(0.02, 0.06));
        if (!e) continue;
        e.weaveAmp = this.minSide * rand(0.01, 0.025);
        ships.push(e);
      }
      // Both sides shoot in every dogfight: the hunters at full rate, the hunted shooting back.
      const enemies = ships.filter((s) => !s.player);
      player.foes = enemies;
      player.fireRate = kind === "chased" ? BACKDROP_CONFIG.returnFireRate : 1;
      for (const e of enemies) {
        e.foes = [player];
        e.fireRate = kind === "pursuit" ? BACKDROP_CONFIG.returnFireRate : 1;
      }
    }
    const maxLag = Math.max(...ships.map((s) => s.lag));
    this.flight = { curve, z0, z1, dur, t: 0, ships };
    this.nextFlight = rand(...BACKDROP_CONFIG.flybyFrequency) + dur + maxLag;
  }

  private spawnStation() {
    if (!this.loaded || !this.w || !this.sprites.has("death_star")) return;
    const d = rand(...BACKDROP_CONFIG.deathStarSize) * this.minSide;
    const left = Math.random() < 0.5;
    this.station = {
      x: left ? rand(0.1, 0.26) * this.w : rand(0.74, 0.9) * this.w,
      y: rand(0.14, 0.3) * this.h,
      vx: (left ? 1 : -1) * rand(1.5, 4),
      vy: rand(-1, 1),
      d,
      t: 0,
      life: rand(...BACKDROP_CONFIG.deathStarDuration),
    };
    this.nextStation = rand(...BACKDROP_CONFIG.deathStarRarity) + this.station.life;
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, life: number, size: number, kind: Particle["kind"]) {
    // Ring-buffer pool: the oldest particle is recycled when full (no allocation, ever).
    const p = this.particles[this.pCursor];
    this.pCursor = (this.pCursor + 1) % P_MAX;
    p.on = true;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.life = life;
    p.max = life;
    p.size = size;
    p.kind = kind;
  }

  private burst(x: number, y: number, z: number, n: number, kind: 2 | 3) {
    if (kind === 3) return this.emit(x, y, z, 0, 0, 0.45, 26 * z, 3);
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, 160) * z;
      this.emit(x, y, z, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.18, 0.45), rand(1.2, 2.6) * z, 2);
    }
  }

  private fire(s: Ship) {
    if (!s.visible) return;
    // Nearest visible foe in range (ahead or, when shooting back, behind).
    let t: Ship | null = null;
    let dist = this.w * 0.7;
    for (const f of s.foes) {
      if (!f.visible) continue;
      const d = Math.hypot(f.x - s.x, f.y - s.y);
      if (d < dist) {
        t = f;
        dist = d;
      }
    }
    if (!t) return;
    const b = this.bolts.find((x) => !x.on);
    if (!b) return;
    // Muzzle on the hull edge facing the target (nose guns forward, tail guns back).
    const aim = Math.atan2(t.y - s.y, t.x - s.x);
    const edge = s.width * s.z * 0.4;
    const ox = s.x + Math.cos(aim) * edge;
    const oy = s.y + Math.sin(aim) * edge;
    // Aim at where the target will be, with enough jitter that some shots graze.
    const sp = 900 * s.z;
    const lead = dist / sp;
    const a = Math.atan2(t.y + t.vy * lead - oy, t.x + t.vx * lead - ox) + rand(-0.07, 0.07);
    Object.assign(b, { on: true, x: ox, y: oy, z: s.z, vx: Math.cos(a) * sp + s.vx, vy: Math.sin(a) * sp + s.vy, life: 1.1, blue: s.player, target: t, grazed: false });
  }

  // ── simulation ──

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const fps = this.reduced && !this.flight ? 12 : BACKDROP_CONFIG.maxFps;
    if (this.last && now - this.last < 1000 / fps - 0.5) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    this.update(dt);
    this.render();
  };

  private update(dt: number) {
    this.stepGrade(dt);
    this.par = this.parallax.sample(this.w, this.h);
    if (!this.loaded) return;

    // Schedules (sim time: they freeze with the loop).
    if (this.auto && !this.reduced) {
      this.nextFlight -= dt;
      this.nextStation -= dt;
      if (this.nextFlight <= 0 && !this.flight && !this.sortie.left) this.startEvent(this.pickFlight());
      if (this.nextStation <= 0 && !this.station) this.spawnStation();
    }

    // Debris drift + tumble.
    const still = this.reduced;
    for (const r of this.rocks) {
      if (still) continue;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.rot += r.vrot * dt;
      const m = r.size;
      if (r.x < -m) r.x = this.w + m;
      if (r.x > this.w + m) r.x = -m;
      if (r.y < -m) r.y = this.h + m;
      if (r.y > this.h + m) r.y = -m;
    }

    // Station.
    const st = this.station;
    if (st) {
      st.t += dt;
      if (!still) {
        st.x += st.vx * dt;
        st.y += st.vy * dt;
      }
      if (st.t > st.life) this.station = null;
    }

    this.updateFlight(dt);
    // Sortie: once a pass clears, the next one comes back the other way with roles swapped.
    if (!this.flight && this.sortie.left > 0) {
      this.sortie.gap -= dt;
      if (this.sortie.gap <= 0) {
        this.sortie.left--;
        this.spawnFlight(this.sortie.kind === "chased" ? "pursuit" : "chased");
      }
    }

    // Bolts.
    for (const b of this.bolts) {
      if (!b.on) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < -80 || b.y < -80 || b.x > this.w + 80 || b.y > this.h + 80) {
        b.on = false;
        continue;
      }
      const t = b.target;
      if (t && t.visible) {
        const r = t.width * t.z * 0.28;
        const d = Math.hypot(t.x - b.x, t.y - b.y);
        if (d < r) {
          // Hits are absorbed by shields: a flash, never a kill (it's ambient).
          this.burst(b.x, b.y, b.z, 0, 3);
          this.burst(b.x, b.y, b.z, 5, 2);
          b.on = false;
          continue;
        }
        if (d < r * 2.2 && !b.grazed) {
          b.grazed = true;
          this.burst(b.x, b.y, b.z, 3, 2);
        }
      }
      for (const r of this.rocks) {
        if (Math.abs(r.z - b.z) > 0.35) continue;
        if (Math.hypot(r.x - b.x, r.y - b.y) < r.size * 0.42) {
          this.burst(b.x, b.y, b.z, 9, 2);
          b.on = false;
          break;
        }
      }
    }

    // Particles.
    for (const p of this.particles) {
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.on = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.kind === 2 ? 0.9 : 0.96;
      p.vx *= drag;
      p.vy *= drag;
    }
  }

  private updateFlight(dt: number) {
    const f = this.flight;
    if (!f) return;
    f.t += dt;
    let alive = false;
    for (const s of f.ships) {
      const u = (f.t - s.lag) / f.dur;
      s.u = u;
      if (u < 0 || u > 1) {
        s.visible = false;
        if (u < 0) alive = true;
        continue;
      }
      alive = true;
      const p = bezier(f.curve, u);
      const tg = bezierTangent(f.curve, u);
      const tl = Math.hypot(tg.x, tg.y) || 1;
      const nx = -tg.y / tl;
      const ny = tg.x / tl;
      const off = s.lateral + s.weaveAmp * Math.sin(s.weaveF * f.t * TAU * 0.35 + s.weaveP);
      const x = p.x + nx * off;
      const y = p.y + ny * off;
      const z = f.z0 + (f.z1 - f.z0) * smooth(0, 1, u);
      if (s.visible && dt > 0) {
        s.vx = (x - s.x) / dt;
        s.vy = (y - s.y) / dt;
        s.speed = Math.hypot(s.vx, s.vy);
        const hd = Math.atan2(s.vy, s.vx);
        const dh = wrapAngle(hd - s.heading);
        s.turn += (dh / Math.max(dt, 1e-3) - s.turn) * Math.min(1, dt * 4);
        s.heading = wrapAngle(s.heading + dh * Math.min(1, dt * 6));
        // Receding (depth falling) shows the rear GABAGOUL view.
        const dz = (z - s.z) / dt;
        s.rearMix += ((dz < -0.07 ? 1 : 0) - s.rearMix) * Math.min(1, dt * 2.5);
      } else {
        s.heading = Math.atan2(tg.y, tg.x);
      }
      s.x = x;
      s.y = y;
      s.z = z;
      s.visible = true;
      // Firing.
      if (s.foes.length && dt > 0) {
        s.fireCd -= dt;
        if (s.fireCd <= 0) {
          this.fire(s);
          s.fireCd = (Math.random() < 0.35 ? 0.12 : rand(0.45, 1.3)) * s.fireRate;
        }
      }
    }
    if (!alive) {
      this.flight = null;
      this.sortie.gap = rand(...BACKDROP_CONFIG.sortieGap);
    }
  }

  // ── rendering ──

  private centreFade(x: number, y: number) {
    const d = Math.hypot(x - this.w / 2, y - this.h / 2) / this.minSide;
    const c = BACKDROP_CONFIG.centreClearance;
    return smooth(c * 0.7, c * 1.3, d);
  }

  private render() {
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);
    if (!this.loaded || !this.w) return;
    const k = this.intensity;
    const P = this.par;

    // Layer 1 — Death Star (far plane, barely moves with the camera).
    const st = this.station;
    const ds = this.sprites.get("death_star");
    if (st && ds?.v) {
      const env = smooth(0, 10, st.t) * (1 - smooth(st.life - 10, st.life, st.t));
      g.globalAlpha = BACKDROP_CONFIG.deathStarOpacity * env * k;
      const img = ds.v[1][0];
      g.drawImage(img, st.x + P.x * 0.06 - st.d / 2, st.y + P.y * 0.06 - st.d / 2, st.d, st.d);
    }

    // Layer 2a — debris (back to front).
    for (const r of this.rocks) {
      const v = r.sprite.v;
      if (!v) continue;
      const a = BACKDROP_CONFIG.debrisOpacity * k * (0.3 + 0.7 * r.z) * this.centreFade(r.x, r.y);
      if (a < 0.01) continue;
      g.globalAlpha = a;
      const img = r.z < 0.55 ? v[1][0] : v[0][0];
      g.save();
      g.translate(r.x + P.x * r.z * 0.5, r.y + P.y * r.z * 0.5);
      g.rotate(r.rot);
      g.drawImage(img, -r.size / 2, -r.size / 2, r.size, r.size * r.sprite.aspect);
      g.restore();
    }

    // Layer 3a — engine trails (behind the hulls), additive.
    g.globalCompositeOperation = "lighter";
    const bloom = BACKDROP_CONFIG.fxBloomIntensity;
    for (const p of this.particles) {
      if (!p.on || p.kind > 1) continue;
      const t = p.life / p.max;
      const s = p.size * (0.6 + (1 - t) * 1.4);
      g.globalAlpha = t * 0.55 * bloom * k;
      g.drawImage(p.kind === 0 ? this.glow.blue : this.glow.red, p.x + P.x * p.z * 0.5 - s, p.y + P.y * p.z * 0.5 - s, s * 2, s * 2);
    }
    g.globalCompositeOperation = "source-over";

    // Layer 2b — ships (far to near).
    const f = this.flight;
    if (f) {
      const ships = f.ships.filter((s) => s.visible).sort((a, b) => a.z - b.z);
      for (const s of ships) this.drawShip(s);
    }

    // Layer 3b — bolts, sparks, shield flashes, thruster bloom.
    g.globalCompositeOperation = "lighter";
    for (const b of this.bolts) {
      if (!b.on) continue;
      const c = b.blue ? BLUE : RED;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const len = 30 * b.z;
      const x = b.x + P.x * b.z * 0.5;
      const y = b.y + P.y * b.z * 0.5;
      const tx = x - (b.vx / sp) * len;
      const ty = y - (b.vy / sp) * len;
      g.globalAlpha = 0.35 * bloom * k;
      g.strokeStyle = css(c);
      g.lineCap = "round";
      g.lineWidth = 6 * b.z;
      g.beginPath();
      g.moveTo(tx, ty);
      g.lineTo(x, y);
      g.stroke();
      g.globalAlpha = 0.95 * k;
      g.strokeStyle = b.blue ? "rgba(225,245,255,1)" : "rgba(255,215,205,1)";
      g.lineWidth = 1.6 * b.z;
      g.beginPath();
      g.moveTo(tx, ty);
      g.lineTo(x, y);
      g.stroke();
      const hs = 9 * b.z;
      g.globalAlpha = 0.5 * bloom * k;
      g.drawImage(b.blue ? this.glow.blue : this.glow.red, x - hs, y - hs, hs * 2, hs * 2);
    }
    for (const p of this.particles) {
      if (!p.on || p.kind < 2) continue;
      const t = p.life / p.max;
      const x = p.x + P.x * p.z * 0.5;
      const y = p.y + P.y * p.z * 0.5;
      if (p.kind === 2) {
        g.globalAlpha = t * 0.9 * k;
        g.drawImage(this.glow.hot, x - p.size * 2, y - p.size * 2, p.size * 4, p.size * 4);
      } else {
        g.globalAlpha = t * 0.55 * bloom * k;
        g.strokeStyle = "rgba(160,220,255,1)";
        g.lineWidth = 1.5 * p.z;
        g.beginPath();
        g.arc(x, y, p.size * (1.4 - t * 0.6), 0, TAU);
        g.stroke();
      }
    }
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
  }

  private drawShip(s: Ship) {
    const g = this.ctx;
    const P = this.par;
    const k = this.intensity;
    const edge = smooth(0, 0.06, s.u) * (1 - smooth(0.94, 1, s.u));
    const base = BACKDROP_CONFIG.shipOpacity * k * (0.45 + 0.55 * s.z) * this.centreFade(s.x, s.y) * edge;
    if (base < 0.01) return;
    const x = s.x + P.x * s.z * 0.5;
    const y = s.y + P.y * s.z * 0.5;
    const bank = clamp(s.turn * 0.25, -0.35, 0.35);
    const layers: [Sprite, number][] = s.rear && s.rearMix > 0.02 ? [[s.side, 1 - s.rearMix], [s.rear, s.rearMix]] : [[s.side, 1]];
    let anchor: Ship["draw"] = null;
    for (const [sp, mixA] of layers) {
      if (!sp.v || mixA < 0.02) continue;
      const enemy = !s.player;
      // Mirror so the art always faces the direction of travel, then rotate the remainder.
      const facesLeft = Math.cos(sp.meta.nose) < 0;
      const goingLeft = Math.cos(s.heading) < 0;
      const mirror = facesLeft !== goingLeft;
      const nose = mirror ? Math.PI - sp.meta.nose : sp.meta.nose;
      const lim = enemy ? Math.PI : 0.55;
      const rot = clamp(wrapAngle(s.heading - nose), -lim, lim) + (enemy ? 0 : bank * 0.5);
      const sy = 1 - Math.min(0.28, Math.abs(bank) * 0.6);
      const w = s.width * s.z * (sp === s.rear ? 0.9 : 1);
      const h = w * sp.aspect;
      const nearK = smooth(0.45, 0.75, s.z);
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.scale(1, sy);
      const m = mirror ? 1 : 0;
      if (nearK < 0.98) {
        g.globalAlpha = base * mixA * (1 - nearK);
        g.drawImage(sp.v[1][m] ?? sp.v[1][0], -w / 2, -h / 2, w, h);
      }
      if (nearK > 0.02) {
        g.globalAlpha = base * mixA * nearK;
        g.drawImage(sp.v[0][m] ?? sp.v[0][0], -w / 2, -h / 2, w, h);
      }
      g.restore();
      if (!anchor || mixA >= 0.5) anchor = { sprite: sp, mirror, rot, sy, w, h };
    }
    s.draw = anchor;
    if (anchor) this.thrusters(s, anchor, x, y, base);
  }

  /** Thruster bloom (drawn now) and trail emission (drawn next frame, behind the hull). */
  private thrusters(s: Ship, d: NonNullable<Ship["draw"]>, x: number, y: number, alpha: number) {
    const g = this.ctx;
    const P = this.par;
    const cos = Math.cos(d.rot);
    const sin = Math.sin(d.rot);
    const dirx = Math.cos(s.heading);
    const diry = Math.sin(s.heading);
    const speedK = clamp(s.speed / 200, 0.3, 1.6);
    const bloom = BACKDROP_CONFIG.fxBloomIntensity;
    g.globalCompositeOperation = "lighter";
    for (const [tx, ty] of d.sprite.meta.thrusters) {
      const lx = ((d.mirror ? 1 - tx : tx) - 0.5) * d.w;
      const ly = (ty - 0.5) * d.h * d.sy;
      const wx = x + lx * cos - ly * sin;
      const wy = y + lx * sin + ly * cos;
      const r = (s.player ? 11 : 8) * s.z * (0.8 + speedK * 0.3);
      g.globalAlpha = Math.min(1, alpha * 1.3) * bloom;
      g.drawImage(s.player ? this.glow.blue : this.glow.red, wx - r, wy - r, r * 2, r * 2);
      // Emit in simulation space (undo the parallax the draw added).
      if (!this.reduced || this.flight) {
        const n = s.player ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const back = rand(25, 55) * speedK * s.z;
          this.emit(wx - P.x * s.z * 0.5, wy - P.y * s.z * 0.5, s.z, -dirx * back + rand(-8, 8), -diry * back + rand(-8, 8), rand(0.3, 0.65) * (0.7 + speedK * 0.3), (s.player ? 4.2 : 3.2) * s.z, s.player ? 0 : 1);
        }
      }
    }
    g.globalCompositeOperation = "source-over";
  }
}
