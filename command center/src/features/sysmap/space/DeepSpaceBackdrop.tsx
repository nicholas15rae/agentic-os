import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { DROP_IN_BACKDROPS } from "./space-assets";
import { analyzeImage, NEBULA_GRADES, type Grade } from "./grade";
import { createParallax, type CameraView } from "./parallax";
import { BACKDROP_CONFIG, SpaceEngine } from "./space-engine";
import { useSpace, type SpaceMode } from "./space-store";

export type { CameraView } from "./parallax";

interface Size {
  w: number;
  h: number;
}

const STAR_FPS = 30;

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ── Parallax starfield (one 2D canvas, 30 fps) ───────────────────────────────

interface StarTier {
  depth: number;
  /** One star per this many CSS px². */
  per: number;
  r: [number, number];
  a: [number, number];
  /** Drift, px / s at depth 1. */
  drift: number;
}
const TIERS: readonly StarTier[] = [
  { depth: 0.16, per: 2600, r: [0.35, 0.75], a: [0.22, 0.5], drift: 2.2 },
  { depth: 0.42, per: 7000, r: [0.5, 1.05], a: [0.32, 0.72], drift: 4.2 },
  { depth: 1, per: 19000, r: [0.8, 1.55], a: [0.5, 0.92], drift: 7.5 },
];
const STAR_TINTS = ["#ffffff", "#ffe2be", "#bed2ff", "#ffc8a0"];
const DUST_TINTS = ["120,90,255", "40,170,210", "200,90,160"];

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
  tw: number;
  ph: number;
}

function buildTier(t: StarTier, i: number, area: number, density: number): Star[][] {
  const rnd = seeded(101 + i * 977);
  const n = Math.min(900, Math.round((area / t.per) * density));
  const groups: Star[][] = STAR_TINTS.map(() => []);
  for (let k = 0; k < n; k++) {
    const s = { x: rnd(), y: rnd(), r: t.r[0] + rnd() * (t.r[1] - t.r[0]), a: t.a[0] + rnd() * (t.a[1] - t.a[0]), tw: rnd() < 0.3 ? 0.4 + rnd() * 1.2 : 0, ph: rnd() * 6.28 };
    groups[Math.floor(rnd() * STAR_TINTS.length)].push(s);
  }
  return groups;
}

function dustSprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, `rgba(${rgb},1)`);
  grd.addColorStop(0.45, `rgba(${rgb},0.35)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return c;
}

function Starfield({ size, mode, active, reduced, view }: { size: Size; mode: Exclude<SpaceMode, "minimal">; active: boolean; reduced: boolean; view: MutableRefObject<CameraView> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w || !size.h || !active) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const par = createParallax(view, () => ref.current);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const density = mode === "cinema" ? 1.25 : 1;
    const dustAmt = mode === "cinema" ? 1.25 : 0.85;
    const tiers = TIERS.map((t, i) => buildTier(t, i, size.w * size.h, density));
    const sprites = DUST_TINTS.map(dustSprite);
    const drnd = seeded(7);
    const dust = Array.from({ length: 16 }, () => ({ x: drnd(), y: drnd(), r: 70 + drnd() * 190, a: (0.02 + drnd() * 0.035) * dustAmt, c: Math.floor(drnd() * sprites.length) }));
    const pad = 40;
    const FW = size.w + pad * 2;
    const FH = size.h + pad * 2;
    const wrap = (v: number, m: number) => ((v % m) + m) % m;
    let raf = 0;
    let last = 0;
    let t = 0;
    let sig = "";
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / STAR_FPS - 1) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!reduced) t += dt;
      const P = par.sample(size.w, size.h);
      // Reduced motion: no drift or twinkle; redraw only when the view actually moved.
      if (reduced) {
        const s = `${P.x.toFixed(1)}|${P.y.toFixed(1)}`;
        if (s === sig) return;
        sig = s;
      }
      ctx.clearRect(0, 0, size.w, size.h);
      for (const b of dust) {
        const x = wrap(b.x * (size.w + b.r * 2) + t * 0.8 + P.x * 0.1, size.w + b.r * 2) - b.r;
        const y = wrap(b.y * (size.h + b.r * 2) + t * 0.15 + P.y * 0.1, size.h + b.r * 2) - b.r;
        ctx.globalAlpha = b.a;
        ctx.drawImage(sprites[b.c], x - b.r, y - b.r, b.r * 2, b.r * 2);
      }
      tiers.forEach((groups, i) => {
        const tier = TIERS[i];
        const ox = (t * tier.drift * 3 + P.x) * tier.depth;
        const oy = (t * tier.drift * 0.6 + P.y) * tier.depth;
        groups.forEach((stars, c) => {
          ctx.fillStyle = STAR_TINTS[c];
          for (const s of stars) {
            const x = wrap(s.x * FW + ox, FW) - pad;
            const y = wrap(s.y * FH + oy, FH) - pad;
            if (x < -2 || y < -2 || x > size.w + 2 || y > size.h + 2) continue;
            ctx.globalAlpha = s.tw ? s.a * (0.7 + 0.3 * Math.sin(t * s.tw + s.ph)) : s.a;
            ctx.fillRect(x - s.r, y - s.r, s.r * 2, s.r * 2);
          }
        });
      });
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      par.dispose();
    };
  }, [size.w, size.h, mode, active, reduced, view]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

// ── Layer 0 · Nebula wallpapers (compositor-only sway + drift, crossfade) ────

/** Procedural fallback skies (used when the drop-in folder is empty). */
const NEBULAE = [
  "radial-gradient(ellipse 55% 42% at 22% 28%, rgba(92,56,178,0.5), transparent 70%), radial-gradient(ellipse 48% 40% at 80% 72%, rgba(18,108,150,0.42), transparent 72%), radial-gradient(ellipse 30% 26% at 64% 18%, rgba(180,72,124,0.22), transparent 70%), linear-gradient(160deg, #05030f, #020308 58%, #02060c)",
  "radial-gradient(ellipse 60% 45% at 75% 25%, rgba(24,130,140,0.4), transparent 70%), radial-gradient(ellipse 50% 42% at 18% 78%, rgba(120,48,150,0.42), transparent 72%), radial-gradient(ellipse 26% 22% at 38% 30%, rgba(60,90,200,0.25), transparent 70%), linear-gradient(200deg, #020a0e, #020308 55%, #07030d)",
  "radial-gradient(ellipse 58% 40% at 50% 12%, rgba(150,60,110,0.36), transparent 70%), radial-gradient(ellipse 45% 40% at 12% 50%, rgba(40,70,170,0.4), transparent 72%), radial-gradient(ellipse 40% 34% at 88% 60%, rgba(70,40,160,0.36), transparent 72%), linear-gradient(180deg, #06030c, #020308 60%, #020509)",
];

interface Plate {
  key: string;
  img?: string;
  css?: string;
}

/** Cover scale for a W×H plate swaying ±θ and drifting ±d px (never shows a corner). */
export function coverScale(w: number, h: number, deg: number, driftPx: number): number {
  if (!w || !h) return 1.2;
  const t = (Math.abs(deg) * Math.PI) / 180;
  const aspect = Math.max(w / h, h / w);
  return Math.cos(t) + aspect * Math.sin(t) + (2 * driftPx) / Math.min(w, h) + 0.01;
}

/** Ultra-slow continuous sway (rotation) + drift on one plate; paused while inactive. */
function NebulaPlate({ plate, visible, opacity, active, reduced, size }: { plate: Plate; visible: boolean; opacity: number; active: boolean; reduced: boolean; size: Size }) {
  const ref = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  const R = BACKDROP_CONFIG.nebulaRotationRange;
  const D = BACKDROP_CONFIG.nebulaDriftPx;
  const scale = coverScale(size.w, size.h, R, D);
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || typeof el.animate !== "function") return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const dx = (Math.random() - 0.5) * 2 * D;
    const dy = (Math.random() - 0.5) * 2 * D;
    // One sweep −R → +R at nebulaRotationSpeed °/min, ping-ponging forever (sine-eased ends).
    const sweepMs = ((2 * R) / Math.max(0.05, BACKDROP_CONFIG.nebulaRotationSpeed)) * 60_000;
    anim.current = el.animate(
      [{ transform: `translate(${-dx}px, ${-dy}px) rotate(${-R * dir}deg) scale(${scale})` }, { transform: `translate(${dx}px, ${dy}px) rotate(${R * dir}deg) scale(${scale})` }],
      { duration: sweepMs, easing: "ease-in-out", iterations: Infinity, direction: "alternate", iterationStart: Math.random() },
    );
    if (!active) anim.current.pause();
    return () => anim.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, scale]);
  useEffect(() => {
    if (!anim.current) return;
    if (active) anim.current.play();
    else anim.current.pause();
  }, [active]);
  return (
    <div className="absolute inset-0 transition-opacity ease-in-out starting:opacity-0" style={{ opacity: visible ? opacity : 0, transitionDuration: `${BACKDROP_CONFIG.wallpaperCrossfade}s`, willChange: "opacity" }}>
      <div ref={ref} className="absolute inset-0" style={{ transform: `scale(${scale})`, willChange: "transform", background: plate.css }}>
        {plate.img && <img src={plate.img} alt="" draggable={false} decoding="async" className="absolute inset-0 h-full w-full object-cover" />}
      </div>
    </div>
  );
}

function Wallpapers({ mode, active, reduced, size, onGrade }: { mode: Exclude<SpaceMode, "minimal">; active: boolean; reduced: boolean; size: Size; onGrade: (g: Grade) => void }) {
  const imgs = DROP_IN_BACKDROPS;
  const count = imgs.length || NEBULAE.length;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * count));
  const [plates, setPlates] = useState<Plate[]>([]);
  const nextReq = useSpace((s) => s.nextReq);
  const seenReq = useRef(nextReq);
  const gradeCb = useRef(onGrade);
  gradeCb.current = onGrade;

  // Long ambient cycle, only while visible.
  useEffect(() => {
    if (!active || count < 2) return;
    const t = setTimeout(() => setIdx((i) => (i + 1) % count), BACKDROP_CONFIG.wallpaperCycleInterval * 1000);
    return () => clearTimeout(t);
  }, [active, count, idx]);
  // Manual "Next Backdrop".
  useEffect(() => {
    if (nextReq === seenReq.current) return;
    seenReq.current = nextReq;
    setIdx((i) => (i + 1) % count);
  }, [nextReq, count]);

  // Decode off-screen, sample its grade, then add as the top plate (at most two alive).
  useEffect(() => {
    let cancelled = false;
    const push = (p: Plate) => !cancelled && setPlates((prev) => [...prev.slice(-1), p]);
    if (!imgs.length) {
      gradeCb.current(NEBULA_GRADES[idx % NEBULA_GRADES.length]);
      push({ key: `neb-${idx}-${Date.now()}`, css: NEBULAE[idx % NEBULAE.length] });
      return () => void (cancelled = true);
    }
    const src = imgs[idx % imgs.length];
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    img
      .decode()
      .then(() => !cancelled && gradeCb.current(analyzeImage(img)))
      .catch(() => undefined)
      .then(() => push({ key: `img-${idx}-${Date.now()}`, img: src }));
    return () => {
      cancelled = true;
    };
  }, [idx, imgs]);
  useEffect(() => {
    if (plates.length < 2) return;
    const t = setTimeout(() => setPlates((p) => p.slice(-1)), BACKDROP_CONFIG.wallpaperCrossfade * 1000 + 400);
    return () => clearTimeout(t);
  }, [plates]);

  const hasImages = imgs.length > 0;
  const opacity = hasImages ? (mode === "cinema" ? 0.95 : 0.8) : mode === "cinema" ? 1 : 0.85;
  return (
    <>
      {plates.map((p, i) => (
        <NebulaPlate key={p.key} plate={p} visible={i === plates.length - 1} opacity={opacity} active={active} reduced={reduced} size={size} />
      ))}
      {/* Unified grade: one cool cosmic tint, an obsidian scrim and a radial vignette over every
          plate, so transitions read as one continuous galaxy and the HUD stays sharp. */}
      <div className="absolute inset-0" style={{ background: "linear-gradient(155deg, rgba(34,18,84,0.28), rgba(4,24,44,0.22) 55%, rgba(30,10,46,0.26))" }} />
      <div className="absolute inset-0" style={{ background: `rgba(2,3,8,${mode === "cinema" ? 0.16 : 0.26})` }} />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(2,3,8,0.82)_100%)]" />
    </>
  );
}

// ── Layers 1–3 · Space engine canvas ─────────────────────────────────────────

function EngineLayer({ size, mode, active, reduced, view, engineRef, gradeRef }: { size: Size; mode: Exclude<SpaceMode, "minimal">; active: boolean; reduced: boolean; view: MutableRefObject<CameraView>; engineRef: MutableRefObject<SpaceEngine | null>; gradeRef: MutableRefObject<Grade | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const auto = useSpace((s) => s.flybys);
  const flybyReq = useSpace((s) => s.flybyReq);
  const seenReq = useRef(flybyReq);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const e = new SpaceEngine(cv, createParallax(view, () => ref.current));
    engineRef.current = e;
    if (gradeRef.current) e.setGrade(gradeRef.current);
    return () => {
      e.dispose();
      engineRef.current = null;
    };
  }, [view, engineRef, gradeRef]);
  useEffect(() => engineRef.current?.setSize(size.w, size.h), [size.w, size.h, engineRef]);
  useEffect(() => engineRef.current?.setOptions({ reduced, auto, intensity: mode === "cinema" ? 1 : 0.75 }), [reduced, auto, mode, engineRef]);
  useEffect(() => engineRef.current?.setActive(active && size.w > 0), [active, size.w, engineRef]);
  useEffect(() => {
    if (flybyReq === seenReq.current) return;
    seenReq.current = flybyReq;
    engineRef.current?.trigger(useSpace.getState().flybyKind);
  }, [flybyReq, engineRef]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

// ── Stack ────────────────────────────────────────────────────────────────────

/**
 * The Orbital Ecosystem's deep-space backdrop, back to front, all `pointer-events: none` beneath
 * the WebGL star map: nebula plates → unified grade → parallax starfield → space engine canvas
 * (Death Star, debris, E46 flight events, additive FX).
 *
 * Mounted only while Page 3 shows; every loop and timer stops while `active` is false (window
 * hidden / minimised). `wallpapers={false}` when the user's own imported backdrop (Wallpaper
 * manager) is showing: that layer stays in charge of the image.
 */
export function DeepSpaceBackdrop({ mode, active, reduced, view, wallpapers }: { mode: Exclude<SpaceMode, "minimal">; active: boolean; reduced: boolean; view: MutableRefObject<CameraView>; wallpapers: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const engine = useRef<SpaceEngine | null>(null);
  // The latest nebula grade, kept for an engine that mounts after the first plate.
  const grade = useRef<Grade | null>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      const h = Math.round(e.contentRect.height);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 z-0 select-none overflow-hidden" data-space-backdrop={mode}>
      {wallpapers && <Wallpapers mode={mode} active={active} reduced={reduced} size={size} onGrade={(g) => {
            grade.current = g;
            engine.current?.setGrade(g);
          }}
        />}
      <Starfield size={size} mode={mode} active={active} reduced={reduced} view={view} />
      <EngineLayer size={size} mode={mode} active={active} reduced={reduced} view={view} engineRef={engine} gradeRef={grade} />
    </div>
  );
}
