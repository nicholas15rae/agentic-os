import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { usePoll } from "@/lib/use-poll";
import { isTauri } from "@/lib/platform";
import { useArbiter } from "@/features/arbiter/arbiter-store";
import { pulseEdge } from "@/features/arbiter/agent-graph";
import type { ArbiterNode, Handoff, MemoryRow } from "@/features/arbiter/api";
import { useMemmapData } from "@/features/memmap/use-memmap-data";
import { useSysMap } from "./sysmap-store";
import { SurfaceBackdropLayer, useBackdropActive } from "@/features/wallpaper/SurfaceBackdropLayer";
import { BackdropHudToggle } from "@/features/wallpaper/BackdropHudToggle";
import { DeepSpaceBackdrop, type CameraView } from "./space/DeepSpaceBackdrop";
import { SpaceControls } from "./space/SpaceControls";
import { useSpace } from "./space/space-store";
import { Fleet3D } from "./space/fleet/Fleet3D";
import { agentFor, BUSES, hookupsFor, isRoster, modelName, moonSize, NODE_BUS, NODE_LABEL, orbitPos, ORBITS, ROSTER, surfaceState, SURFACE_TONE, type Orbit, type RosterId } from "./model";
import { ARC_FRAG, ARC_VERT, ATMO_FRAG, BODY_VERT, NEBULA_FRAG, NEBULA_VERT, PLANET_FRAG, RING_FRAG, RING_VERT, STAR_FRAG, STARS_FRAG, STARS_VERT } from "./orbital-shaders";

/** Frame cap while visible (the RTX 3060 runs local inference: never more than this). */
const FPS = 30;
const ARC_MS = 1600;
const POLL_MS = 3000;
const HOME_POS = new THREE.Vector3(0, 30, 46);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);
const NS_OF: Partial<Record<RosterId, string>> = { tony: "tony", prompter: "build_circle", coder: "build_circle", designer: "build_circle", director: "director", librarian: "librarian", booking: "booking", security: "security", observer: "observer" };
const MOONS = [
  { key: "rag", color: "#34d399", label: "RAG" },
  { key: "mem", color: "#38bdf8", label: "MEM" },
  { key: "tool", color: "#fbbf24", label: "MCP" },
] as const;

/** Window visible (minimised / tray-hidden → false). */
function useDocVisible(): boolean {
  const [v, setV] = useState(() => !document.hidden);
  useEffect(() => {
    const on = () => setV(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

/** Shared per-frame world positions (bodies move; arcs, callouts and the camera follow them). */
type Positions = Map<string, THREE.Vector3>;

interface Live {
  nodes: Map<string, ArbiterNode>;
  mems: Map<string, MemoryRow>;
  tools: Record<string, number>;
  models: Record<string, string | null>;
  vaultOpen: boolean;
  holder: string | null;
}

// ── Frame driver ────────────────────────────────────────────────────────────

/** `frameloop="demand"` + a capped rAF that only runs while `running`. Stopped = zero frames. */
function Ticker({ running }: { running: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / FPS - 1) return;
      last = t;
      invalidate();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, invalidate]);
  return null;
}

// ── Backdrop ────────────────────────────────────────────────────────────────

const Nebula = memo(function Nebula() {
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: NEBULA_VERT, fragmentShader: NEBULA_FRAG, side: THREE.BackSide, depthWrite: false }), []);
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <mesh material={mat} renderOrder={-10}>
      <sphereGeometry args={[220, 48, 32]} />
    </mesh>
  );
});

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function Starfield({ time }: { time: MutableRefObject<number> }) {
  const { geo, mat } = useMemo(() => {
    const rnd = seeded(42);
    const N = 3200;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    const col = new Float32Array(N * 3);
    const tints = [new THREE.Color("#ffffff"), new THREE.Color("#ffd9a8"), new THREE.Color("#a8c8ff"), new THREE.Color("#ffb37a")];
    for (let i = 0; i < N; i++) {
      const r = 70 + rnd() * 130;
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
      size[i] = 0.6 + Math.pow(rnd(), 6) * 3.2;
      phase[i] = rnd() * 6.28;
      const c = tints[Math.floor(rnd() * tints.length)];
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    const m = new THREE.ShaderMaterial({ vertexShader: STARS_VERT, fragmentShader: STARS_FRAG, uniforms: { uTime: { value: 0 }, uPx: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { geo: g, mat: m };
  }, []);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat]);
  useFrame(() => {
    mat.uniforms.uTime.value = time.current;
    mat.uniforms.uPx.value = dpr;
  });
  return <points geometry={geo} material={mat} renderOrder={-9} />;
}

/** The galactic disk around the core: a few thousand dust points on loose spiral arms. */
function GalacticDust({ time }: { time: MutableRefObject<number> }) {
  const ref = useRef<THREE.Points>(null);
  const { geo, mat } = useMemo(() => {
    const rnd = seeded(7);
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    const col = new Float32Array(N * 3);
    const warm = new THREE.Color("#ff9a4a");
    const cool = new THREE.Color("#8b7bff");
    for (let i = 0; i < N; i++) {
      const arm = i % 3;
      const r = 3.5 + Math.pow(rnd(), 0.7) * 34;
      const a = arm * ((Math.PI * 2) / 3) + r * 0.16 + (rnd() - 0.5) * 0.9;
      const spread = 0.6 + r * 0.05;
      pos.set([Math.cos(a) * r + (rnd() - 0.5) * spread, (rnd() - 0.5) * (0.35 + 1.4 / (1 + r * 0.2)), Math.sin(a) * r * 0.82 + (rnd() - 0.5) * spread], i * 3);
      size[i] = 0.35 + rnd() * 0.9;
      phase[i] = rnd() * 6.28;
      const c = warm.clone().lerp(cool, Math.min(1, r / 30) * 0.8 + rnd() * 0.2).multiplyScalar(0.45 + rnd() * 0.35);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    const m = new THREE.ShaderMaterial({ vertexShader: STARS_VERT, fragmentShader: STARS_FRAG, uniforms: { uTime: { value: 0 }, uPx: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { geo: g, mat: m };
  }, []);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat]);
  useFrame(() => {
    mat.uniforms.uTime.value = time.current;
    mat.uniforms.uPx.value = dpr;
    if (ref.current) ref.current.rotation.y = -time.current * 0.004;
  });
  return <points ref={ref} geometry={geo} material={mat} />;
}

/** A radial-gradient glow sprite (one 128 px canvas texture, shared). */
function useGlowTexture() {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.2, "rgba(255,220,170,0.55)");
    grd.addColorStop(0.5, "rgba(255,150,60,0.14)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

// ── Orbits ──────────────────────────────────────────────────────────────────

function OrbitRing({ o, color, opacity, dashed = false }: { o: Orbit; color: string; opacity: number; dashed?: boolean }) {
  const line = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      const z = Math.sin(a) * o.radius * 0.82;
      pts.push(new THREE.Vector3(Math.cos(a) * o.radius, -z * Math.sin(o.tilt), z * Math.cos(o.tilt)));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.6, gapSize: 0.5, depthWrite: false }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const l = new THREE.Line(g, m);
    if (dashed) l.computeLineDistances();
    return l;
  }, [o, color, opacity, dashed]);
  useEffect(() => () => (line.geometry.dispose(), (line.material as THREE.Material).dispose()), [line]);
  return <primitive object={line} />;
}

// ── Bodies ──────────────────────────────────────────────────────────────────

function bodyUniforms(o: Orbit, seed: number) {
  return {
    uC0: { value: new THREE.Color(o.palette[0]) },
    uC1: { value: new THREE.Color(o.palette[1]) },
    uC2: { value: new THREE.Color(o.palette[2]) },
    uAtmo: { value: new THREE.Color(o.atmosphere) },
    uSeed: { value: seed },
    uTime: { value: 0 },
    uActive: { value: 0 },
    uDim: { value: 0 },
    uAlert: { value: 0 },
    uBands: { value: 6 + (seed % 5) * 2 },
  };
}

interface BodyProps {
  id: RosterId;
  live: Live;
  time: MutableRefObject<number>;
  positions: Positions;
  flashes: MutableRefObject<Map<string, number>>;
  selected: boolean;
  onPick: (id: RosterId) => void;
  glow: THREE.Texture;
}

function Body({ id, live, time, positions, flashes, selected, onPick, glow }: BodyProps) {
  const o = ORBITS[id];
  const group = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const moonRefs = useRef<(THREE.Mesh | null)[]>([]);
  const seed = ROSTER.indexOf(id) * 1.37 + 0.5;
  const surfaceMat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: BODY_VERT, fragmentShader: o.kind === "star" ? STAR_FRAG : PLANET_FRAG, uniforms: bodyUniforms(o, seed) }),
    [o, seed],
  );
  const atmoMat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: BODY_VERT, fragmentShader: ATMO_FRAG, uniforms: { uAtmo: { value: new THREE.Color(o.atmosphere) }, uStrength: { value: o.kind === "star" ? 1.6 : 1.0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide }),
    [o],
  );
  const ringMat = useMemo(
    () => (o.kind === "vault" ? new THREE.ShaderMaterial({ vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: { uColor: { value: new THREE.Color("#b794ff") }, uSealed: { value: 1 }, uIn: { value: o.size * 1.45 }, uOut: { value: o.size * 2.4 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide }) : null),
    [o],
  );
  useEffect(() => () => (surfaceMat.dispose(), atmoMat.dispose(), ringMat?.dispose()), [surfaceMat, atmoMat, ringMat]);

  const node = live.nodes.get(id);
  const s = surfaceState(node);
  const sealed = id === "finance" && !live.vaultOpen;
  const ns = NS_OF[id];
  const mem = ns ? live.mems.get(ns) : undefined;
  const counts = [mem?.active ?? 0, mem?.archived ?? 0, live.tools[id] ?? 0];
  const moonDist = o.kind === "star" ? o.size * 1.65 : o.size * 2.1;
  useEffect(() => {
    if (!positions.has(id)) positions.set(id, new THREE.Vector3());
  }, [id, positions]);

  useFrame(() => {
    const t = time.current;
    const p = orbitPos(o, t);
    group.current?.position.set(p[0], p[1], p[2]);
    positions.get(id)?.set(p[0], p[1], p[2]);
    if (spin.current) spin.current.rotation.y = t * (o.kind === "star" ? 0.03 : 0.12);
    const u = surfaceMat.uniforms;
    u.uTime.value = t;
    u.uActive.value = s === "ACTIVE" ? 1 : 0;
    u.uDim.value = s === "DORMANT" || s === "OFFLINE" ? 0.55 : s === "IDLE" ? 0.18 : 0;
    if (u.uAlert) u.uAlert.value = s === "ERROR" ? 1 : 0;
    if (ringMat) ringMat.uniforms.uSealed.value = sealed ? 1 : 0;
    const flash = flashes.current.get(id) ?? 0;
    const glowNow = Math.max(0, 1 - (performance.now() - flash) / 900);
    moonRefs.current.forEach((m, i) => {
      if (!m) return;
      const a = t * (0.6 - i * 0.13) + i * 2.1 + seed;
      const r = moonDist + i * (o.size * 0.42 + 0.18);
      m.position.set(Math.cos(a) * r, Math.sin(a * 0.7 + i) * o.size * 0.25, Math.sin(a) * r);
      const base = moonSize(counts[i], o.kind === "star" ? 0.32 : Math.max(0.12, o.size * 0.22));
      m.scale.setScalar(base * (i === 0 ? 1 + glowNow * 0.8 : 1));
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = counts[i] > 0 ? 0.95 : 0.3;
    });
  });

  const pick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onPick(id);
  };
  const bus = BUSES[NODE_BUS[id]];

  return (
    <group ref={group}>
      <group ref={spin}>
        {o.kind === "sentinel" ? (
          <mesh onClick={pick} onDoubleClick={pick} scale={o.size}>
            <octahedronGeometry args={[1, 0]} />
            <meshStandardMaterial color={o.palette[1]} emissive={o.palette[1]} emissiveIntensity={s === "ACTIVE" ? 1.4 : 0.45} metalness={0.8} roughness={0.25} flatShading />
          </mesh>
        ) : (
          <mesh onClick={pick} onDoubleClick={pick} material={surfaceMat} scale={o.size}>
            <sphereGeometry args={[1, o.kind === "star" ? 64 : 56, o.kind === "star" ? 48 : 40]} />
          </mesh>
        )}
      </group>
      {o.kind !== "sentinel" && (
        <mesh material={atmoMat} scale={o.size * (o.kind === "star" ? 1.18 : 1.1)}>
          <sphereGeometry args={[1, 40, 28]} />
        </mesh>
      )}
      {o.kind === "star" && (
        <>
          <sprite scale={o.size * 9}>
            <spriteMaterial map={glow} color="#ffb067" transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={live.holder === "tony" ? 1 : 0.75} />
          </sprite>
          <pointLight intensity={2.4} distance={120} decay={0.6} color="#ffd2a0" />
        </>
      )}
      {o.kind === "vault" && ringMat && (
        <>
          <mesh material={ringMat} rotation={[-Math.PI / 2 + 0.38, 0, 0.2]}>
            <ringGeometry args={[o.size * 1.45, o.size * 2.4, 96, 1]} />
          </mesh>
          {sealed && (
            <mesh scale={o.size * 1.55}>
              <icosahedronGeometry args={[1, 1]} />
              <meshBasicMaterial color="#c4b5fd" wireframe transparent opacity={0.22} depthWrite={false} />
            </mesh>
          )}
        </>
      )}
      {selected && (
        <mesh scale={o.size * (o.kind === "star" ? 1.5 : 1.9)} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1, 1.035, 96]} />
          <meshBasicMaterial color={bus.color} transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {MOONS.map((m, i) => (
        <mesh key={m.key} ref={(el) => void (moonRefs.current[i] = el)} onClick={pick}>
          <sphereGeometry args={[1, 16, 12]} />
          <meshBasicMaterial color={m.color} transparent opacity={0.9} />
        </mesh>
      ))}
    </group>
  );
}

// ── HUD callouts (one DOM overlay, positioned per frame: no per-label React roots) ──

function CalloutSync({ positions, els }: { positions: Positions; els: MutableRefObject<Map<string, HTMLDivElement>> }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    for (const [id, el] of els.current) {
      const p = positions.get(id);
      if (!p || !isRoster(id)) continue;
      v.copy(p);
      v.y += ORBITS[id].size * 1.05;
      v.project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
        el.style.visibility = "hidden";
        continue;
      }
      el.style.visibility = "visible";
      el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-0.5px, -100%)`;
    }
  });
  return null;
}

function Callouts({ live, hud, els, onPick }: { live: Live; hud: "minimal" | "full"; els: MutableRefObject<Map<string, HTMLDivElement>>; onPick: (id: RosterId) => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {ROSTER.map((id) => {
        const o = ORBITS[id];
        const node = live.nodes.get(id);
        const s = surfaceState(node);
        const sealed = id === "finance" && !live.vaultOpen;
        const ns = NS_OF[id];
        const mem = ns ? live.mems.get(ns) : undefined;
        const stem = o.kind === "star" ? 92 : o.kind === "sentinel" ? 44 : 30 + (ROSTER.indexOf(id) % 3) * 18;
        const ragText = id === "finance" ? (sealed ? "vault sealed" : "vault open") : mem ? `RAG ${mem.active} · MEM ${mem.archived} · ${mem.activeKb}KB` : "stateless";
        return (
          <div
            key={id}
            ref={(el) => void (el ? els.current.set(id, el) : els.current.delete(id))}
            className="sysmap-callout absolute left-0 top-0"
            style={{ visibility: "hidden", willChange: "transform" }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <button type="button" className="tag" onClick={() => onPick(id)} style={{ background: "transparent", border: 0, borderLeft: "1px solid rgba(251,146,60,0.9)", textAlign: "left", color: "inherit" }}>
                <div style={{ fontSize: o.kind === "star" ? 12 : 10.5, letterSpacing: "0.14em", color: "#fde6d0", textTransform: "uppercase" }}>{NODE_LABEL[id]}</div>
                <div style={{ fontSize: 9.5, letterSpacing: "0.12em", color: SURFACE_TONE[sealed ? "SEALED" : s] }}>{sealed ? "SEALED" : s}</div>
                {hud === "full" && (
                  <>
                    <div style={{ fontSize: 9.5, color: "#94a3b8" }}>{ragText}</div>
                    <div style={{ fontSize: 9.5, color: "#64748b" }}>
                      {(node?.compute ?? "—").toUpperCase()} · {live.models[id] ?? (node?.compute === "cpu" ? "deterministic" : "—")} · {live.tools[id] ?? 0} MCP
                    </div>
                  </>
                )}
              </button>
              <div className="stem" style={{ height: stem }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Hand-off arcs ────────────────────────────────────────────────────────────

function Arc({ h, positions }: { h: Handoff & { key: number }; positions: Positions }) {
  const N = 64;
  const { line, mat } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const u = new Float32Array(N);
    for (let i = 0; i < N; i++) u[i] = i / (N - 1);
    g.setAttribute("aU", new THREE.BufferAttribute(u, 1));
    const color = h.kind === "token" ? "#5eead4" : isRoster(h.from) ? BUSES[NODE_BUS[h.from]].color : "#fb923c";
    const m = new THREE.ShaderMaterial({ vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, uniforms: { uColor: { value: new THREE.Color(color) }, uProg: { value: 0 }, uFade: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { line: new THREE.Line(g, m), mat: m };
  }, [h]);
  useEffect(() => () => (line.geometry.dispose(), mat.dispose()), [line, mat]);
  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const c = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const pa = positions.get(h.from);
    const pb = positions.get(h.to);
    if (!pa || !pb) return;
    a.copy(pa);
    b.copy(pb);
    c.copy(a).add(b).multiplyScalar(0.5);
    c.y += a.distanceTo(b) * 0.35 + 1.5;
    const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const it = 1 - t;
      attr.setXYZ(i, it * it * a.x + 2 * it * t * c.x + t * t * b.x, it * it * a.y + 2 * it * t * c.y + t * t * b.y, it * it * a.z + 2 * it * t * c.z + t * t * b.z);
    }
    attr.needsUpdate = true;
    const age = Date.now() - h.at;
    mat.uniforms.uProg.value = Math.min(1.15, age / (ARC_MS * 0.7));
    mat.uniforms.uFade.value = Math.max(0, 1 - Math.max(0, age - ARC_MS * 0.6) / (ARC_MS * 0.4));
  });
  return <primitive object={line} />;
}

// ── Camera focus ─────────────────────────────────────────────────────────────

function CameraRig({ focus, positions, controls, homeReq }: { focus: string | null; positions: Positions; controls: MutableRefObject<OrbitControlsImpl | null>; homeReq: number }) {
  const camera = useThree((s) => s.camera);
  const fly = useRef<{ id: string | null; t0: number; offset: THREE.Vector3; prev: THREE.Vector3 } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const p = positions.get(focus);
    if (!p) return;
    const o = isRoster(focus) ? ORBITS[focus] : null;
    const dist = o ? (o.kind === "star" ? 16 : o.size * 7 + 5) : 12;
    const dir = camera.position.clone().sub(p).normalize();
    dir.y = Math.max(dir.y, 0.35);
    dir.normalize();
    fly.current = { id: focus, t0: performance.now(), offset: dir.multiplyScalar(dist), prev: p.clone() };
  }, [focus, positions, camera]);
  // The Deep Inspector covers the right side: shift the projection centre left by half its width
  // so the focused body lands in the visible part of the canvas.
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const shift = focus && size.width > 700 ? Math.min(420, size.width) / 2 : 0;
    if (shift) cam.setViewOffset(size.width, size.height, shift, 0, size.width, size.height);
    else cam.clearViewOffset();
    invalidate();
  }, [focus, size.width, size.height, camera, invalidate]);
  useEffect(() => {
    if (homeReq === 0) return;
    fly.current = { id: null, t0: performance.now(), offset: HOME_POS.clone(), prev: HOME_TARGET.clone() };
  }, [homeReq]);
  useFrame((_, dt) => {
    const f = fly.current;
    const ctl = controls.current;
    if (!f || !ctl) return;
    const target = f.id ? positions.get(f.id) : HOME_TARGET;
    if (!target) return;
    // Frame-rate independent ease, but never slower than 8 % a frame (a throttled window still lands).
    const k = Math.max(0.08, 1 - Math.exp(-Math.min(dt, 0.1) * 3.2));
    const dest = f.id ? target.clone().add(f.offset) : f.offset;
    // Fly until it lands (or 5 s at worst), then follow.
    const flying = (camera.position.distanceTo(dest) > 0.05 || ctl.target.distanceTo(target) > 0.05) && performance.now() - f.t0 < 5000;
    if (flying) {
      ctl.target.lerp(target, k);
      camera.position.lerp(dest, k);
    } else if (f.id) {
      // Settled: ride along with the orbiting body (orbit / zoom stay free).
      const d = target.clone().sub(f.prev);
      ctl.target.add(d);
      camera.position.add(d);
    } else {
      fly.current = null;
    }
    f.prev.copy(target);
    ctl.update();
  });
  return null;
}

/** Feeds the orbit camera's angles to the DOM starfield's parallax (a ref write per frame, no renders). */
function CameraProbe({ controls, view }: { controls: MutableRefObject<OrbitControlsImpl | null>; view: MutableRefObject<CameraView> }) {
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    view.current.az = c.getAzimuthalAngle();
    view.current.pol = c.getPolarAngle();
  });
  return null;
}

/** Transparent clear while a custom backdrop shows; the scene background is null then. */
function ClearAlpha({ backdrop }: { backdrop: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    gl.setClearColor(0x020308, backdrop ? 0 : 1);
    if (backdrop) scene.background = null;
    invalidate();
  }, [backdrop, gl, scene, invalidate]);
  return null;
}

// ── Scene ────────────────────────────────────────────────────────────────────

function Scene({ live, running, reduced, pulses, focus, onPick, homeReq, positions, els, backdrop, stars3d, view }: { live: Live; running: boolean; reduced: boolean; pulses: (Handoff & { key: number })[]; focus: string | null; onPick: (id: RosterId) => void; homeReq: number; positions: Positions; els: MutableRefObject<Map<string, HTMLDivElement>>; backdrop: boolean; stars3d: boolean; view: MutableRefObject<CameraView> }) {
  const time = useRef(0);
  const flashes = useRef(new Map<string, number>());
  const controls = useRef<OrbitControlsImpl | null>(null);
  const glow = useGlowTexture();
  const invalidate = useThree((s) => s.invalidate);
  useFrame((_, dt) => {
    if (running && !reduced) time.current += Math.min(dt, 0.1);
  });
  // Memory reads / writes flash the node's RAG moon.
  useEffect(() => {
    const last = pulses[pulses.length - 1];
    if (!last) return;
    if (last.kind === "memory_read" && isRoster(last.to)) flashes.current.set(last.to, performance.now());
    if (last.kind === "memory_write" && isRoster(last.from)) flashes.current.set(last.from, performance.now());
    invalidate();
  }, [pulses, invalidate]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pulses.some((p) => p.at + ARC_MS > Date.now())) return;
    const t = setTimeout(() => setNow(Date.now()), 300);
    return () => clearTimeout(t);
  }, [pulses, now]);
  const arcs = pulses.filter((p) => now - p.at < ARC_MS && pulseEdge(p) && isRoster(p.from) && isRoster(p.to));

  return (
    <>
      {/* Clean Minimal: the opaque obsidian scene + nebula. Custom backdrop: no scene background,
          a transparent clear, so the DOM backdrop shows through at zero texture VRAM. */}
      {!backdrop && <color attach="background" args={["#020308"]} />}
      <ClearAlpha backdrop={backdrop} />
      <ambientLight intensity={0.12} />
      {!backdrop && <Nebula />}
      {/* Deep Space / Full Cinema: the DOM parallax starfield replaces the GL one (no doubled stars). */}
      {stars3d && <Starfield time={time} />}
      {/* Deep Space / Full Cinema: the fleet flies inside the map itself (real perspective, orbitable). */}
      {!stars3d && <Fleet3D positions={positions} reduced={reduced} />}
      <GalacticDust time={time} />
      {ROSTER.filter((r) => ORBITS[r].radius > 0).map((r, i, all) => {
        const o = ORBITS[r];
        // The two sentinels share one orbit: draw it once.
        if (o.kind === "sentinel" && all.findIndex((x) => ORBITS[x].kind === "sentinel") !== i) return null;
        const c = o.kind === "vault" ? "#a78bfa" : o.kind === "sentinel" ? "#f43f5e" : "#fb923c";
        return <OrbitRing key={r} o={o} color={c} opacity={focus === r ? 0.55 : o.kind === "planet" ? 0.2 : 0.28} dashed={o.kind === "sentinel"} />;
      })}
      {ROSTER.map((r) => (
        <Body key={r} id={r} live={live} time={time} positions={positions} flashes={flashes} selected={focus === r} onPick={onPick} glow={glow} />
      ))}
      {arcs.map((p) => (
        <Arc key={p.key} h={p} positions={positions} />
      ))}
      <CalloutSync positions={positions} els={els} />
      <CameraProbe controls={controls} view={view} />
      <CameraRig focus={focus} positions={positions} controls={controls} homeReq={homeReq} />
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={4} maxDistance={110} maxPolarAngle={Math.PI * 0.92} />
    </>
  );
}

/**
 * Page 3 · Orbital Ecosystem: the roster as a planetary system around Tony's star — procedural
 * GLSL surfaces with star-lit shading and Fresnel atmospheres (no texture packs), RAG / Memory /
 * MCP moons sized by the live counts, HUD callout stems, and energy arcs that fire only when a
 * real hand-off arrives. Drag to orbit, wheel to zoom, click a body to fly in and inspect it.
 *
 * Zero contention: mounted only while Page 3 is active (unmounting disposes the WebGL context);
 * `frameloop="demand"` with a 30 fps cap that stops entirely when the window is hidden /
 * minimised, so local inference never shares the GPU with an idle map.
 */
export function OrbitalEcosystem() {
  const reduced = usePrefersReducedMotion();
  const visible = useDocVisible();
  const snap = useArbiter((s) => s.snap);
  const pulses = useArbiter((s) => s.pulses);
  const { snap: sys } = useMemmapData();
  const inspect = useSysMap((s) => s.inspect);
  const open = useSysMap((s) => s.open);
  const close = useSysMap((s) => s.close);
  const hud = useSysMap((s) => s.hud);
  const setHud = useSysMap((s) => s.setHud);
  const [homeReq, setHomeReq] = useState(0);
  const customBackdrop = useBackdropActive("orbital");
  const spaceMode = useSpace((s) => s.mode);
  const engine = spaceMode !== "minimal";
  // Any DOM backdrop behind the canvas (imported wallpaper or the deep-space engine) → transparent clear.
  const backdrop = customBackdrop || engine;
  const view = useRef<CameraView>({ az: 0, pol: 0 });
  const positions = useMemo<Positions>(() => new Map(ROSTER.map((r) => [r, new THREE.Vector3(...orbitPos(ORBITS[r], 0))])), []);
  const els = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => void useArbiter.getState().start(), []);
  usePoll(() => (isTauri() ? useArbiter.getState().refresh() : Promise.resolve()), POLL_MS);

  const live = useMemo<Live>(() => {
    const tools: Record<string, number> = {};
    const models: Record<string, string | null> = {};
    for (const r of ROSTER) {
      tools[r] = hookupsFor(r, sys?.bus).length;
      models[r] = modelName(agentFor(r, sys?.agents));
    }
    return {
      nodes: new Map((snap?.nodes ?? []).map((n) => [n.id, n] as const)),
      mems: new Map((snap?.memory ?? []).map((m) => [m.namespace, m] as const)),
      tools,
      models,
      vaultOpen: !!snap?.vaultOpen,
      holder: snap?.holder ?? null,
    };
  }, [snap, sys?.bus, sys?.agents]);

  const running = visible;
  return (
    <div className="relative h-full w-full overflow-hidden bg-[#020308]" role="img" aria-label="Orbital ecosystem: the agent roster as a planetary system. Drag to orbit, scroll to zoom, click a planet to inspect it.">
      <SurfaceBackdropLayer surface="orbital" />
      {spaceMode !== "minimal" && <DeepSpaceBackdrop mode={spaceMode} active={visible} reduced={reduced} view={view} wallpapers={!customBackdrop} />}
      <Canvas
        frameloop="demand"
        dpr={[1, 1.5]}
        camera={{ position: [HOME_POS.x, HOME_POS.y, HOME_POS.z], fov: 45, near: 0.1, far: 600 }}
        gl={{ antialias: true, powerPreference: "default", alpha: true }}
        style={{ position: "absolute", inset: 0, zIndex: 10 }}
        onPointerMissed={() => close()}
      >
        <Ticker running={running} />
        <Scene live={live} running={running} reduced={reduced} pulses={pulses} focus={inspect && isRoster(inspect) ? inspect : null} onPick={(id) => open(id)} homeReq={homeReq} positions={positions} els={els} backdrop={backdrop} stars3d={!engine} view={view} />
      </Canvas>
      <div className="absolute inset-0 z-20 pointer-events-none">
        <Callouts live={live} hud={hud} els={els} onPick={(id) => open(id)} />
      </div>

      <div className="pointer-events-none absolute left-4 top-4 z-20 space-y-1 font-mono">
        <p className="text-[12px] tracking-[0.3em] text-[#fde6d0]">ORBITAL ECOSYSTEM</p>
        <p className="text-[10px] tracking-[0.12em] text-ink-3">token {snap?.holder ?? "free"} · {snap?.away ? "AWAY MODE" : "foreground"} · vault {snap ? (snap.vaultOpen ? "open" : "sealed") : "—"}</p>
        <div className="flex gap-3 pt-1 text-[9.5px] text-ink-3">
          {MOONS.map((m) => (
            <span key={m.key} className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: m.color }} /> {m.label} moon
            </span>
          ))}
        </div>
        {!snap && <p className="text-[10px] text-amber-light">{isTauri() ? "Waiting for the engine…" : "Live states need the desktop engine."}</p>}
      </div>
      <div className="absolute bottom-3 left-3 z-20 flex gap-1">
        <button
          type="button"
          className="sysmap-ctl"
          onClick={() => {
            close();
            setHomeReq((n) => n + 1);
          }}
        >
          Reset Camera
        </button>
        <button type="button" className="sysmap-ctl" aria-pressed={hud === "full"} onClick={() => setHud(hud === "full" ? "minimal" : "full")} title="HUD label density">
          HUD Labels: {hud === "full" ? "Full" : "Minimal"}
        </button>
        <BackdropHudToggle surface="orbital" />
        <SpaceControls />
      </div>
    </div>
  );
}

export default OrbitalEcosystem;
