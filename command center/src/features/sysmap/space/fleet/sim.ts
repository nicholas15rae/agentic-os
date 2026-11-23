/**
 * The Orbital Ecosystem's 3D fleet simulation, in star-map world units (the sun at the origin,
 * the outermost orbit at r ≈ 32). No DOM, no three.js scene: Fleet3D reads this state each frame.
 *
 *   Flights   solo courier runs between two agent planets, and dogfight sorties of 2–4
 *             back-to-back passes that alternate the E46 being chased (shooting back over its
 *             shoulder) and chasing (under return fire), each re-entering from where the last
 *             pass left.
 *   Physics   thrust-limited speed, turn-rate-limited heading in full 3D, real roll into turns,
 *             evasive jinks, lead pursuit with formation slots, separation, and a keep-out
 *             sphere around the sun.
 *   Guns      nose guns ±14°, a tail gun ±29° for the hunted side; bolts lead their target,
 *             shields absorb hits (it's ambient: nobody dies).
 *   Ambient   a tumbling asteroid field, the capital ship's slow outer orbit, a rare far station.
 *
 * Everything lives in fixed pools; dt is clamped by the caller.
 */
import * as THREE from "three";

export type FlightKind = "solo" | "chased" | "pursuit";
export type TriggerKind = FlightKind | "station" | "random";

/** Tuning knobs. Times in seconds, distances in world units. */
export const FLEET_CONFIG = {
  /** Seconds between flight events (randomised), and the share that are dogfights. */
  flybyFrequency: [45, 110] as const,
  dogfightProbability: 0.6,
  sortiePasses: [2, 4] as const,
  sortieGap: [1.5, 4] as const,
  /** Cooldown multiplier for the hunted side when it shoots back (higher = fewer shots). */
  returnFireRate: 1.7,
  /** Flights enter and leave on this sphere around the sun. */
  arena: 60,
  /** Nothing flies closer to the sun than this. */
  sunClearance: 6.5,
  e46Cruise: 8.5,
  boltSpeed: 52,
  boltRange: 36,
  /** Asteroids in the field, and the field's radial band. */
  rockCount: 34,
  rockBand: [36, 66] as const,
  /** The capital ship's slow outer orbit. */
  capitalOrbitPeriod: 960,
  capitalOrbit: { rx: 74, rz: 64, y: -14, tilt: 0.08 },
  /** Rare far station (seconds between, seconds shown). */
  stationRarity: [300, 720] as const,
  stationDuration: [100, 160] as const,
};

const V = THREE.Vector3;
type V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const WORLD_UP = new V(0, 1, 0);

export type Rnd = () => number;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export interface Ship {
  player: boolean;
  role: "lead" | "chase";
  /** Collision / shield radius. */
  radius: number;
  pos: V3;
  vel: V3;
  /** Unit heading. */
  fwd: V3;
  /** Render orientation (model +Z forward, +Y up), rolled into turns. */
  quat: THREE.Quaternion;
  bank: number;
  speed: number;
  cruise: number;
  maxSpeed: number;
  accel: number;
  maxTurn: number;
  trackU: number;
  jinkAmp: number;
  jink: THREE.Vector2;
  jinkTarget: THREE.Vector2;
  jinkT: number;
  quarry: Ship | null;
  slot: { back: number; side: number; vert: number };
  fireCd: number;
  foes: Ship[];
  fireRate: number;
  rearGun: boolean;
  /** Inside the arena (flying the pass, not parked off-stage). */
  live: boolean;
}

export interface Flight {
  kind: FlightKind;
  curve: THREE.CubicBezierCurve3;
  t: number;
  maxT: number;
  ships: Ship[];
}

export interface Bolt {
  on: boolean;
  pos: V3;
  vel: V3;
  life: number;
  blue: boolean;
  target: Ship | null;
  grazed: boolean;
}

/** 0 blue trail · 1 red trail · 2 spark · 3 blue shield flash · 4 red shield flash · 5 blue muzzle · 6 red muzzle */
export type ParticleKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface Particle {
  on: boolean;
  pos: V3;
  vel: V3;
  life: number;
  max: number;
  size: number;
  kind: ParticleKind;
}

export interface Rock {
  pos: V3;
  vel: V3;
  axis: V3;
  angle: number;
  spin: number;
  scale: number;
  variant: number;
}

export interface Station {
  dir: V3;
  drift: V3;
  t: number;
  life: number;
  size: number;
}

export const P_MAX = 900;
export const B_MAX = 64;

/** Nozzle offsets in model space (scaled), set by the renderer from the built models. */
export interface Nozzles {
  e46: V3[];
  fighter: V3[];
}

export class FleetSim {
  flight: Flight | null = null;
  bolts: Bolt[] = Array.from({ length: B_MAX }, () => ({ on: false, pos: new V(), vel: new V(), life: 0, blue: true, target: null, grazed: false }));
  particles: Particle[] = Array.from({ length: P_MAX }, () => ({ on: false, pos: new V(), vel: new V(), life: 0, max: 1, size: 1, kind: 0 as ParticleKind }));
  rocks: Rock[] = [];
  station: Station | null = null;
  /** Capital ship orbit phase (radians). */
  orbit: number;
  auto = true;
  reduced = false;
  nozzles: Nozzles = { e46: [], fighter: [] };
  /** Camera azimuth around the sun (radians, atan2(z, x)): passes enter from the sides of the view. */
  viewAz = Math.PI / 2;
  /** Planet positions for courier runs (shared map, updated by the scene). */
  planets: ReadonlyMap<string, V3> = new Map();

  private rnd: Rnd;
  private pCursor = 0;
  private nextFlight: number;
  private nextStation: number;
  private sortie = { left: 0, gap: 0, kind: "chased" as FlightKind, exit: null as V3 | null };
  // Scratch vectors (no per-frame allocation in the hot loop).
  private s1 = new V();
  private s2 = new V();
  private s3 = new V();
  private s4 = new V();
  private m4 = new THREE.Matrix4();
  private qRoll = new THREE.Quaternion();
  private zAxis = new V(0, 0, 1);

  constructor(rnd: Rnd = Math.random) {
    this.rnd = rnd;
    this.orbit = rnd() * TAU;
    this.nextFlight = this.r(8, 18);
    this.nextStation = this.r(60, 150);
    this.seedRocks();
  }

  private r(a: number, b: number) {
    return a + this.rnd() * (b - a);
  }

  // ── public ──

  trigger(kind: TriggerKind) {
    if (kind === "station") return void this.spawnStation();
    this.flight = null;
    this.startEvent(kind === "random" ? this.pickFlight() : kind);
  }

  update(dt: number) {
    if (dt <= 0) return;
    if (this.auto && !this.reduced) {
      this.nextFlight -= dt;
      this.nextStation -= dt;
      if (this.nextFlight <= 0 && !this.flight && !this.sortie.left) this.startEvent(this.pickFlight());
      if (this.nextStation <= 0 && !this.station) this.spawnStation();
    }
    const still = this.reduced;
    for (const k of this.rocks) {
      if (still) continue;
      k.pos.addScaledVector(k.vel, dt);
      k.angle += k.spin * dt;
      // Keep the field in its band: drifting rocks wrap to the far side.
      const rr = Math.hypot(k.pos.x, k.pos.z);
      if (rr > FLEET_CONFIG.rockBand[1] + 6) k.pos.multiplyScalar(-0.98);
    }
    if (!still) this.orbit = (this.orbit + (dt * TAU) / Math.max(60, FLEET_CONFIG.capitalOrbitPeriod)) % TAU;
    const st = this.station;
    if (st) {
      st.t += dt;
      if (!still) st.dir.addScaledVector(st.drift, dt).normalize();
      if (st.t > st.life) this.station = null;
    }
    this.updateFlight(dt);
    if (!this.flight && this.sortie.left > 0) {
      this.sortie.gap -= dt;
      if (this.sortie.gap <= 0) {
        this.sortie.left--;
        this.spawnFlight(this.sortie.kind === "chased" ? "pursuit" : "chased");
      }
    }
    this.updateBolts(dt);
    for (const p of this.particles) {
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.on = false;
        continue;
      }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(p.kind === 2 ? 0.92 : 0.97);
    }
  }

  /** Capital ship world position and heading for an orbit phase. */
  capitalPose(out: V3, fwd: V3, a = this.orbit) {
    const { rx, rz, y, tilt } = FLEET_CONFIG.capitalOrbit;
    out.set(Math.cos(a) * rx, y, Math.sin(a) * rz);
    out.y += out.z * Math.sin(tilt);
    fwd.set(-Math.sin(a) * rx, 0, Math.cos(a) * rz);
    fwd.y = fwd.z * Math.sin(tilt);
    fwd.normalize();
    return out;
  }

  // ── setup ──

  private seedRocks() {
    const [r0, r1] = FLEET_CONFIG.rockBand;
    this.rocks = Array.from({ length: FLEET_CONFIG.rockCount }, () => {
      const a = this.r(0, TAU);
      const rr = this.r(r0, r1);
      const axis = new V(this.r(-1, 1), this.r(-1, 1), this.r(-1, 1)).normalize();
      // Mostly small, a few big ones (power-law sizes read as a real field).
      const scale = 0.25 + Math.pow(this.rnd(), 3) * 2.6;
      return {
        pos: new V(Math.cos(a) * rr, this.r(-12, 14), Math.sin(a) * rr * 0.85),
        vel: new V(this.r(-0.25, 0.25), this.r(-0.06, 0.06), this.r(-0.25, 0.25)),
        axis,
        angle: this.r(0, TAU),
        spin: this.r(-0.25, 0.25) / (0.6 + scale),
        scale,
        variant: Math.floor(this.r(0, 3)),
      };
    });
  }

  private pickFlight(): FlightKind {
    return this.rnd() < FLEET_CONFIG.dogfightProbability ? (this.rnd() < 0.5 ? "chased" : "pursuit") : "solo";
  }

  private startEvent(kind: FlightKind) {
    const dog = kind !== "solo";
    const [a, b] = FLEET_CONFIG.sortiePasses;
    this.sortie = { left: dog ? Math.floor(this.r(a, b + 1)) - 1 : 0, gap: 0, kind, exit: null };
    this.spawnFlight(kind);
  }

  private spawnStation() {
    const a = this.r(0, TAU);
    const el = this.r(0.12, 0.45);
    this.station = {
      dir: new V(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)),
      drift: new V(this.r(-1, 1), 0, this.r(-1, 1)).multiplyScalar(0.0012),
      t: 0,
      life: this.r(...FLEET_CONFIG.stationDuration),
      size: this.r(22, 40),
    };
    this.nextStation = this.r(...FLEET_CONFIG.stationRarity) + this.station.life;
  }

  /** A pass: enters on the arena sphere, crosses the system clear of the sun, leaves opposite. */
  planCurve(kind: FlightKind, from: V3 | null): THREE.CubicBezierCurve3 {
    const R = FLEET_CONFIG.arena;
    const at = (a: number, y: number) => new V(Math.cos(a) * R, y, Math.sin(a) * R * 0.85);
    // Enter from either side of the current view (never from behind the camera), leave on the other.
    let a0 = this.viewAz + (this.rnd() < 0.5 ? 1 : -1) * this.r(1.25, 2.3);
    if (from) a0 = Math.atan2(from.z / 0.85, from.x) + this.r(-0.25, 0.25);
    const p0 = from ? at(a0, clamp(from.y + this.r(-3, 3), -6, 16)) : at(a0, this.r(-5, 15));
    const p3 = at(a0 + Math.PI + this.r(-0.6, 0.6), this.r(-5, 15));
    let c1: V3;
    let c2: V3;
    let courier = false;
    const names = [...this.planets.keys()];
    if (kind === "solo" && names.length >= 2) {
      // Courier run: swing past one agent planet and on to another.
      const i = Math.floor(this.r(0, names.length));
      let j = Math.floor(this.r(0, names.length - 1));
      if (j >= i) j++;
      c1 = this.planets.get(names[i])!.clone().add(new V(0, this.r(2, 4), 0));
      c2 = this.planets.get(names[j])!.clone().add(new V(0, this.r(2, 4), 0));
      if (c1.distanceToSquared(p0) > c2.distanceToSquared(p0)) [c1, c2] = [c2, c1];
      courier = true;
    } else {
      c1 = p0.clone().multiplyScalar(this.r(0.2, 0.45)).add(new V(this.r(-10, 10), this.r(-2, 10), this.r(-10, 10)));
      c2 = p3.clone().multiplyScalar(this.r(0.2, 0.45)).add(new V(this.r(-10, 10), this.r(-2, 10), this.r(-10, 10)));
    }
    const curve = new THREE.CubicBezierCurve3(p0, c1, c2, p3);
    // Until the whole pass clears the sun: courier runs climb over it (they still call at both
    // planets); combat passes push their middle outwards.
    const min = FLEET_CONFIG.sunClearance * 1.6;
    for (let k = 0; k < 10 && curveClearance(curve) < min; k++) {
      for (const c of [curve.v1, curve.v2]) {
        if (courier) c.y += 2.5;
        else {
          if (c.lengthSq() < 1) c.set(1, 0, 0);
          c.multiplyScalar(1.35).add(new V(0, 1.5, 0));
        }
      }
    }
    return curve;
  }

  private newShip(player: boolean, role: Ship["role"], cruise: number): Ship {
    // Fighters are lighter and more agile than the E46; both bleed speed in hard turns.
    const agile = player ? 1 : 1.3;
    return {
      player,
      role,
      radius: player ? 1.5 : 0.9,
      pos: new V(),
      vel: new V(),
      fwd: new V(1, 0, 0),
      quat: new THREE.Quaternion(),
      bank: 0,
      speed: cruise,
      cruise,
      maxSpeed: cruise * (player ? 1.3 : 1.4),
      accel: 6 * agile,
      maxTurn: 1.15 * agile,
      trackU: 0,
      jinkAmp: 0,
      jink: new THREE.Vector2(),
      jinkTarget: new THREE.Vector2(),
      jinkT: 0,
      quarry: null,
      slot: { back: 0, side: 0, vert: 0 },
      fireCd: this.r(0.8, 1.8),
      foes: [],
      fireRate: 1,
      rearGun: false,
      live: true,
    };
  }

  spawnFlight(kind: FlightKind) {
    const curve = this.planCurve(kind, this.sortie.exit);
    this.sortie.kind = kind;
    this.sortie.exit = curve.v3.clone();
    const cruise = FLEET_CONFIG.e46Cruise * (kind === "solo" ? 0.8 : 1.1) * this.r(0.9, 1.1);
    const t0 = curve.getTangent(0);
    const right = new V().crossVectors(t0, WORLD_UP).normalize();
    const place = (s: Ship, behind: number, beside: number, vert = 0) => {
      s.fwd.copy(t0);
      s.pos.copy(curve.v0).addScaledVector(t0, -behind).addScaledVector(right, beside).addScaledVector(WORLD_UP, vert);
      s.vel.copy(t0).multiplyScalar(s.speed);
      this.orient(s, 0);
    };
    const ships: Ship[] = [];
    const player = this.newShip(true, kind === "pursuit" ? "chase" : "lead", cruise);
    ships.push(player);
    if (kind === "solo") {
      player.jinkAmp = 0.3;
      place(player, 0, 0);
    } else {
      const n = kind === "chased" ? (this.rnd() < 0.5 ? 2 : 3) : 2;
      const enemies = Array.from({ length: n }, (_, i) => this.newShip(false, kind === "pursuit" && i === 0 ? "lead" : "chase", cruise * (kind === "pursuit" ? 1.02 : 1.06)));
      ships.push(...enemies);
      if (kind === "chased") {
        player.jinkAmp = this.r(1.6, 2.6);
        place(player, 0, 0);
        enemies.forEach((e, i) => {
          e.quarry = player;
          e.slot = { back: 2.4 + i * 1.3, side: (i % 2 ? 1 : -1) * this.r(0.6, 1.5), vert: this.r(-0.8, 0.8) };
          place(e, 4 + i * 1.6 + cruise * this.r(0.6, 1.1), e.slot.side, e.slot.vert);
        });
      } else {
        const lead = enemies[0];
        lead.jinkAmp = this.r(1.4, 2.4);
        place(lead, 0, 0);
        enemies.slice(1).forEach((e, i) => {
          e.quarry = lead;
          e.slot = { back: 1.6 + i, side: (i % 2 ? -1 : 1) * this.r(1.2, 2), vert: this.r(-0.6, 0.6) };
          place(e, e.slot.back, e.slot.side, e.slot.vert);
        });
        player.quarry = lead;
        player.slot = { back: 2.6, side: 0, vert: 0.3 };
        place(player, 5 + cruise * this.r(0.8, 1.3), 0);
      }
      player.foes = enemies;
      player.fireRate = kind === "chased" ? FLEET_CONFIG.returnFireRate : 1;
      player.rearGun = kind === "chased";
      for (const e of enemies) {
        e.foes = [player];
        e.fireRate = kind === "pursuit" ? FLEET_CONFIG.returnFireRate : 1;
        e.rearGun = kind === "pursuit";
      }
    }
    const len = curve.getLength();
    const maxT = (len / cruise) * 2.2 + 8;
    this.flight = { kind, curve, t: 0, maxT, ships };
    this.nextFlight = this.r(...FLEET_CONFIG.flybyFrequency) + maxT * 0.6;
  }

  // ── flight ──

  /** Orientation from heading + roll (model +Z forward, +Y up). */
  private orient(s: Ship, yawRate: number, dt = 0) {
    const z = s.fwd;
    const x = this.s1.crossVectors(WORLD_UP, z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = this.s2.crossVectors(z, x);
    this.m4.makeBasis(x, y, z);
    s.quat.setFromRotationMatrix(this.m4);
    // Roll into the turn (right turn → right wing down), eased.
    const want = clamp(-yawRate * 0.6, -1.1, 1.1);
    s.bank += (want - s.bank) * Math.min(1, dt * 3);
    s.quat.multiply(this.qRoll.setFromAxisAngle(this.zAxis, s.bank));
  }

  private updateFlight(dt: number) {
    const f = this.flight;
    if (!f) return;
    f.t += dt;
    const lead = f.ships.find((s) => s.role === "lead") ?? f.ships[0];
    const tgt = this.s3;
    let anyIn = false;
    for (const s of f.ships) {
      let want: number;
      if (s.role === "lead" || !s.quarry) {
        // Pure pursuit along the pass with a speed-scaled lookahead, plus evasive jinks.
        const look = Math.max(4, s.speed * 0.9);
        while (s.trackU < 1 && f.curve.getPoint(s.trackU, this.s4).distanceTo(s.pos) < look) s.trackU = Math.min(1, s.trackU + 0.006);
        f.curve.getPoint(s.trackU, tgt);
        const tg = f.curve.getTangent(s.trackU, this.s4);
        if (s.trackU >= 1) tgt.addScaledVector(tg, look);
        if (s.jinkAmp) {
          s.jinkT -= dt;
          if (s.jinkT <= 0) {
            s.jinkTarget.set(this.r(-1, 1), this.r(-0.6, 0.6)).multiplyScalar(s.jinkAmp);
            s.jinkT = this.r(0.6, 1.5);
          }
          s.jink.lerp(s.jinkTarget, Math.min(1, dt * 1.8));
          const right = this.s1.crossVectors(tg, WORLD_UP).normalize();
          tgt.addScaledVector(right, s.jink.x).addScaledVector(WORLD_UP, s.jink.y);
        }
        const pressed = f.ships.some((o) => o.quarry === s && o.foes.includes(s) && o.pos.distanceTo(s.pos) < 6);
        want = s.cruise * (pressed ? 1.18 : 1);
      } else {
        // Lead the quarry and hold a slot behind / beside / above it; throttle to close.
        const q = s.quarry;
        const d = q.pos.distanceTo(s.pos);
        const tau = clamp(d / Math.max(3, s.speed), 0, 1.2) * 0.6;
        const right = this.s1.crossVectors(q.fwd, WORLD_UP).normalize();
        tgt.copy(q.pos).addScaledVector(q.vel, tau).addScaledVector(q.fwd, -s.slot.back).addScaledVector(right, s.slot.side).addScaledVector(WORLD_UP, s.slot.vert);
        const ahead = this.s2.subVectors(tgt, s.pos).dot(s.fwd);
        want = clamp(q.speed + ahead * 0.9, s.cruise * 0.55, s.maxSpeed);
      }
      // Separation from wingmates, and the keep-out sphere around the sun.
      for (const o of f.ships) {
        if (o === s) continue;
        const away = this.s2.subVectors(s.pos, o.pos);
        const d = away.length() || 1;
        const min = (s.radius + o.radius) * 1.6;
        if (d < min) tgt.addScaledVector(away, ((min - d) * 3) / d);
      }
      const ds = s.pos.length();
      const keep = FLEET_CONFIG.sunClearance * 1.4;
      if (ds < keep) tgt.addScaledVector(s.pos, ((keep - ds) * 4) / (ds || 1));
      // Turn-rate-limited heading, thrust-limited speed; hard turns bleed speed.
      const desired = this.s2.subVectors(tgt, s.pos);
      if (desired.lengthSq() > 1e-6) desired.normalize();
      else desired.copy(s.fwd);
      const ang = s.fwd.angleTo(desired);
      const step = Math.min(ang, s.maxTurn * dt);
      let yawRate = 0;
      if (step > 1e-5) {
        const axis = this.s4.crossVectors(s.fwd, desired);
        if (axis.lengthSq() > 1e-9) {
          axis.normalize();
          s.fwd.applyAxisAngle(axis, step).normalize();
          // Yaw component about the ship's own up (drives the roll).
          this.s1.set(0, 1, 0).applyQuaternion(s.quat);
          yawRate = (axis.dot(this.s1) * step) / dt;
        }
      }
      const bleed = 1 - Math.min(0.22, (step / dt / s.maxTurn) * 0.15);
      s.speed += clamp(want * bleed - s.speed, -s.accel * dt, s.accel * dt);
      s.vel.copy(s.fwd).multiplyScalar(s.speed);
      s.pos.addScaledVector(s.vel, dt);
      this.orient(s, yawRate, dt);
      s.live = s.pos.length() < FLEET_CONFIG.arena * 1.08;
      if (s.live) anyIn = true;
      this.trails(s, dt);
      if (s.foes.length) {
        s.fireCd -= dt;
        if (s.fireCd <= 0) s.fireCd = this.fire(s) ? (this.rnd() < 0.55 ? this.r(0.09, 0.14) : this.r(0.5, 1.3)) * s.fireRate : 0.15;
      }
    }
    if ((lead.trackU >= 1 && !anyIn) || f.t > f.maxT) {
      this.flight = null;
      this.sortie.gap = this.r(...FLEET_CONFIG.sortieGap);
    }
  }

  /** Ion / engine trails from each nozzle, streaming back from the hull. */
  private trails(s: Ship, dt: number) {
    if (this.reduced && !this.flight) return;
    const offs = s.player ? this.nozzles.e46 : this.nozzles.fighter;
    const speedK = clamp(s.speed / FLEET_CONFIG.e46Cruise, 0.4, 1.6);
    const per = Math.max(1, Math.round(dt * 60));
    for (const o of offs) {
      for (let i = 0; i < per; i++) {
        const w = this.s4.copy(o).applyQuaternion(s.quat).add(s.pos);
        // Spread emission along this frame's travel so low frame rates still draw a solid stream.
        w.addScaledVector(s.vel, -dt * (i / per));
        const back = this.r(1.2, 2.6) * speedK;
        this.emit(w, -s.fwd.x * back + this.r(-0.15, 0.15), -s.fwd.y * back + this.r(-0.15, 0.15), -s.fwd.z * back + this.r(-0.15, 0.15), this.r(0.35, 0.7) * (0.7 + speedK * 0.3), s.player ? 0.42 : 0.3, s.player ? 0 : 1);
      }
    }
  }

  emit(at: V3, vx: number, vy: number, vz: number, life: number, size: number, kind: ParticleKind) {
    // Ring-buffer pool: the oldest particle is recycled when full.
    const p = this.particles[this.pCursor];
    this.pCursor = (this.pCursor + 1) % P_MAX;
    p.on = true;
    p.pos.copy(at);
    p.vel.set(vx, vy, vz);
    p.life = life;
    p.max = life;
    p.size = size;
    p.kind = kind;
  }

  private sparks(at: V3, n: number) {
    for (let i = 0; i < n; i++) {
      const d = this.s1.set(this.r(-1, 1), this.r(-1, 1), this.r(-1, 1)).normalize().multiplyScalar(this.r(2, 7));
      this.emit(at, d.x, d.y, d.z, this.r(0.18, 0.45), this.r(0.06, 0.14), 2);
    }
  }

  /** Fire at the nearest foe inside a gun arc. False when nothing is in arc. */
  private fire(s: Ship): boolean {
    if (!s.live) return false;
    let t: Ship | null = null;
    let dist = FLEET_CONFIG.boltRange;
    for (const f of s.foes) {
      if (!f.live) continue;
      const to = this.s1.subVectors(f.pos, s.pos);
      const d = to.length();
      if (d >= dist) continue;
      const off = s.fwd.angleTo(to);
      if (off < 0.25 || (s.rearGun && off > Math.PI - 0.5)) {
        t = f;
        dist = d;
      }
    }
    if (!t) return false;
    const b = this.bolts.find((x) => !x.on);
    if (!b) return false;
    const sp = FLEET_CONFIG.boltSpeed;
    const aim = this.s1.subVectors(t.pos, s.pos).normalize();
    const origin = this.s2.copy(s.pos).addScaledVector(aim, s.radius * 1.1);
    // Lead the target, with enough jitter that some shots graze.
    const lead = this.s3.copy(t.pos).addScaledVector(t.vel, dist / sp);
    lead.x += this.r(-0.5, 0.5);
    lead.y += this.r(-0.5, 0.5);
    lead.z += this.r(-0.5, 0.5);
    const dir = lead.sub(origin).normalize();
    b.on = true;
    b.pos.copy(origin);
    b.vel.copy(dir).multiplyScalar(sp).add(s.vel);
    b.life = FLEET_CONFIG.boltRange / sp + 0.3;
    b.blue = s.player;
    b.target = t;
    b.grazed = false;
    this.emit(origin, s.vel.x, s.vel.y, s.vel.z, 0.08, s.player ? 0.9 : 0.7, s.player ? 5 : 6);
    return true;
  }

  private updateBolts(dt: number) {
    for (const b of this.bolts) {
      if (!b.on) continue;
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) {
        b.on = false;
        continue;
      }
      const t = b.target;
      if (t && t.live) {
        const d = t.pos.distanceTo(b.pos);
        if (d < t.radius) {
          // Shields take it: a flash and sparks, never a kill.
          this.emit(b.pos, t.vel.x, t.vel.y, t.vel.z, 0.4, t.radius * 2.6, t.player ? 3 : 4);
          this.sparks(b.pos, 6);
          b.on = false;
          continue;
        }
        if (d < t.radius * 2.4 && !b.grazed) {
          b.grazed = true;
          this.sparks(b.pos, 3);
        }
      }
      for (const k of this.rocks) {
        if (k.pos.distanceToSquared(b.pos) < k.scale * k.scale * 0.8) {
          this.sparks(b.pos, 10);
          b.on = false;
          break;
        }
      }
    }
  }
}

/** Closest approach of a curve to the origin (sampled). */
export function curveClearance(c: THREE.Curve<THREE.Vector3>, n = 48): number {
  let m = Infinity;
  const p = new V();
  for (let i = 0; i <= n; i++) m = Math.min(m, c.getPoint(i / n, p).length());
  return m;
}
