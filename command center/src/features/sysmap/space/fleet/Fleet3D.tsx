import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import e46Url from "@/assets/orbital-models/e46.glb?url";
import fighterUrl from "@/assets/orbital-models/fighter.glb?url";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DROP_IN_BACKDROPS, SPRITE_URLS } from "../space-assets";
import { useSpace } from "../space-store";
import { useSysMap } from "../../sysmap-store";
import { FOLLOW, followTarget, type FollowTarget } from "./follow";
import { buildCapital, buildE46, buildE46FromMesh, buildFighter, buildFighterFromMesh, buildRockGeometry, glowTexture, rockMaterial, type ShipModel } from "./models";
import { B_MAX, FleetSim, P_MAX, type Particle } from "./sim";

/**
 * The fleet, inside the star map's own 3D scene: E46 courier runs between agent planets and
 * dogfight sorties, laser bolts, ion trails, shield flashes and sparks, a tumbling asteroid field,
 * the Gabagoul capital ship on a slow outer orbit, and a rare far station. Orbit or zoom the
 * camera and you fly around all of it in real perspective.
 *
 * Lit by the sun (a point light at the origin), a key and hemisphere fill tinted by the nebula
 * grade, and the nebula wallpaper itself as the reflection environment. Additive FX never write
 * depth. Runs on the map's capped demand loop: no frames while the window is hidden.
 */

const SHIPS_MAX = 4;
const TMP = new THREE.Object3D();
const UP = new THREE.Vector3(0, 1, 0);
const C = new THREE.Color();

// Particle palette per kind (see ParticleKind).
const PCOL = [
  [0.35, 0.78, 1],
  [1, 0.36, 0.22],
  [1, 0.86, 0.6],
  [0.5, 0.86, 1],
  [1, 0.46, 0.34],
  [0.75, 0.92, 1],
  [1, 0.62, 0.5],
] as const;

const PARTICLE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vAlpha = aAlpha;
  }
`;
const PARTICLE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a *= a;
    // Hot white core fading to the kind's colour.
    vec3 c = mix(vColor, vec3(1.0), smoothstep(0.55, 1.0, a) * 0.6);
    gl_FragColor = vec4(c * a * vAlpha, a * vAlpha);
  }
`;

function particleLook(p: Particle): [number, number] {
  const t = p.life / p.max;
  switch (p.kind) {
    case 0:
    case 1:
      return [p.size * (0.6 + (1 - t) * 1.8), t * 0.55];
    case 2:
      return [p.size, t];
    case 3:
    case 4:
      return [p.size * (1.5 - t * 0.6), t * 0.7];
    default:
      return [p.size * (0.6 + t * 0.6), t];
  }
}

/** The nebula wallpaper as a PMREM reflection environment for the hulls (chrome, glass). */
function NebulaEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const url = DROP_IN_BACKDROPS[0];
    if (!url) return;
    let rt: THREE.WebGLRenderTarget | null = null;
    let dead = false;
    const pm = new THREE.PMREMGenerator(gl);
    new THREE.TextureLoader().load(url, (tex) => {
      if (dead) return tex.dispose();
      tex.colorSpace = THREE.SRGBColorSpace;
      // A small HDR "space studio": the nebula on a sphere, plus a warm and a cool soft panel so
      // chrome, glass and clearcoat catch real highlights instead of a uniformly dark sky.
      const env = new THREE.Scene();
      const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, color: new THREE.Color(1.5, 1.5, 1.5), toneMapped: false }));
      env.add(sky);
      const panel = (w: number, h: number, c: [number, number, number], at: [number, number, number]) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(...c), side: THREE.DoubleSide, toneMapped: false }));
        m.position.set(...at);
        m.lookAt(0, 0, 0);
        env.add(m);
        return m;
      };
      panel(34, 9, [7, 5.6, 4.2], [-30, 6, -36]);
      panel(26, 26, [2.2, 2.7, 3.6], [10, 44, 8]);
      panel(16, 5, [3, 3.4, 4], [38, -4, 24]);
      rt = pm.fromScene(env, 0.02);
      env.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      tex.dispose();
      scene.environment = rt.texture;
      scene.environmentIntensity = 0.9;
      invalidate();
    });
    return () => {
      dead = true;
      if (scene.environment === rt?.texture) scene.environment = null;
      rt?.dispose();
      pm.dispose();
    };
  }, [gl, scene, invalidate]);
  return null;
}

/**
 * Cinematic three-point lighting that travels with the camera, so every angle you orbit to is
 * lit like a render: a hard key from above-left (casting soft shadows across the hero ship), a
 * strong nebula-coloured rim from behind, a faint fill, and the sun as a warm practical.
 */
function FleetLights({ focus }: { focus: MutableRefObject<THREE.Vector3 | null> }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const key = useRef<THREE.DirectionalLight>(null);
  const rim = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.DirectionalLight>(null);
  const grade = useSpace((s) => s.grade);
  const rimColor = (grade ? new THREE.Color(`rgb(${grade.light.map((v) => v | 0).join(",")})`) : new THREE.Color("#c9a8ff")).lerp(new THREE.Color("#ffffff"), 0.25);
  const sky = (grade ? new THREE.Color(`rgb(${grade.tint.map((v) => v | 0).join(",")})`) : new THREE.Color("#8fa0ff")).lerp(new THREE.Color("#ffffff"), 0.4);
  useEffect(() => {
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
  }, [gl]);
  const v = useMemo(() => ({ right: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3(), at: new THREE.Vector3() }), []);
  useFrame(() => {
    // Camera basis: +Z points back towards the viewer.
    camera.matrixWorld.extractBasis(v.right, v.up, v.back);
    // Light around the hero ship when one is on stage, else around the middle of the view.
    const at = focus.current ?? v.at.copy(camera.position).addScaledVector(v.back, -30);
    const place = (l: THREE.DirectionalLight | null, r: number, u: number, b: number) => {
      if (!l) return;
      l.position.copy(at).addScaledVector(v.right, r * 20).addScaledVector(v.up, u * 20).addScaledVector(v.back, b * 20);
      l.target.position.copy(at);
      l.target.updateMatrixWorld();
    };
    place(key.current, -0.55, 0.75, 0.35);
    place(rim.current, 0.35, 0.45, -1);
    place(fill.current, 0.7, -0.1, 0.7);
  });
  return (
    <>
      <pointLight position={[0, 0, 0]} color="#ffc38a" intensity={2.2} distance={0} decay={0} />
      <directionalLight
        ref={key}
        color="#fff4e6"
        intensity={2.6}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-5}
        shadow-camera-right={5}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
        shadow-camera-near={1}
        shadow-camera-far={45}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight ref={rim} color={rimColor} intensity={3.2} />
      <directionalLight ref={fill} color="#bcd0ff" intensity={0.28} />
      <hemisphereLight args={[sky, "#120a18", 0.18]} />
    </>
  );
}

export function Fleet3D({ positions, reduced }: { positions: ReadonlyMap<string, THREE.Vector3>; reduced: boolean }) {
  const auto = useSpace((s) => s.flybys);
  const flybyReq = useSpace((s) => s.flybyReq);
  const seenReq = useRef(flybyReq);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  // The generated (Hunyuan3D) ships replace the hand-built ones once both have loaded (one
  // rebuild, not two); a failed load keeps the hand-built model for that ship.
  const [meshes, setMeshes] = useState<{ e46: THREE.Object3D | null; fighter: THREE.Object3D | null } | null>(null);
  useEffect(() => {
    let dead = false;
    const load = (url: string) => new Promise<THREE.Object3D | null>((res) => new GLTFLoader().load(url, (g) => res(g.scene), undefined, () => res(null)));
    void Promise.all([load(e46Url), load(fighterUrl)]).then(([e46, fighter]) => !dead && setMeshes({ e46, fighter }));
    return () => {
      dead = true;
    };
  }, []);

  const kit = useMemo(() => {
    const glow = glowTexture();
    const e46 = meshes?.e46 ? buildE46FromMesh(glow, meshes.e46) : buildE46(glow);
    const fighters = Array.from({ length: SHIPS_MAX - 1 }, () => (meshes?.fighter ? buildFighterFromMesh(glow, meshes.fighter) : buildFighter(glow)));
    const capital = buildCapital(glow);
    const rockGeos = [0, 1, 2].map((i) => buildRockGeometry(i + 1));
    const rockMat = rockMaterial();
    const boltGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    const boltCore = new THREE.InstancedMesh(boltGeo, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }), B_MAX);
    const boltGlow = new THREE.InstancedMesh(boltGeo, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35, toneMapped: false }), B_MAX);
    for (const m of [boltCore, boltGlow]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, C.set("#ffffff"));
    }
    // Exhaust plume: an open cone, bright at the nozzle and fading along its length.
    const plumeTex = (() => {
      const c = document.createElement("canvas");
      c.width = 4;
      c.height = 128;
      const g = c.getContext("2d")!;
      const grd = g.createLinearGradient(0, 0, 0, 128);
      grd.addColorStop(0, "rgba(255,255,255,0)");
      grd.addColorStop(0.5, "rgba(255,255,255,0.12)");
      grd.addColorStop(0.9, "rgba(255,255,255,0.55)");
      grd.addColorStop(1, "rgba(255,255,255,0.8)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 4, 128);
      return new THREE.CanvasTexture(c);
    })();
    const plumeGeo = new THREE.ConeGeometry(1, 1, 20, 1, true);
    plumeGeo.translate(0, 0.5, 0); // wide base (nozzle end) at y = 0, apex at y = 1
    plumeGeo.rotateX(-Math.PI / 2); // apex trails back along -Z, tapering away from the nozzle
    const plumes = (m: ShipModel, color: string, radius: number) =>
      m.nozzles.map((n) => {
        const mat = new THREE.MeshBasicMaterial({ color, alphaMap: plumeTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
        const p = new THREE.Mesh(plumeGeo, mat);
        // Nozzles are stored post-scale; the plume is a child of the scaled root.
        p.position.copy(n).divideScalar(m.root.scale.x);
        p.scale.set(radius, radius, 1);
        p.userData.radius = radius;
        m.root.add(p);
        return p;
      });
    const e46Plumes = plumes(e46, "#5fe2ff", 0.2);
    const fighterPlumes = fighters.map((f) => plumes(f, "#ff5a3a", 0.16));
    // Hulls cast and catch the key light's soft shadow.
    for (const m of [e46, ...fighters])
      m.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !(mesh.material as THREE.Material).transparent) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(P_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(P_MAX), 1).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(P_MAX), 1).setUsage(THREE.DynamicDrawUsage));
    const pMat = new THREE.ShaderMaterial({ vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, uniforms: { uScale: { value: 400 } }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const points = new THREE.Points(pGeo, pMat);
    points.frustumCulled = false;
    const stationUrl = SPRITE_URLS.get("death_star");
    const station = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0, fog: false }));
    if (stationUrl)
      new THREE.TextureLoader().load(stationUrl, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        station.material.map = t;
        station.material.needsUpdate = true;
      });
    station.visible = false;
    return { glow, e46, fighters, capital, rockGeos, rockMat, boltCore, boltGlow, points, station, e46Plumes, fighterPlumes };
  }, [meshes]);

  const sim = useMemo(() => new FleetSim(), []);
  // Dev-only handle for inspecting the fleet from the console / browser tests.
  const getState = useThree((s) => s.get);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __fleet?: FleetSim; __fleetShot?: () => string; __fleetState?: typeof getState };
    w.__fleet = sim;
    w.__fleetState = getState;
    // Full-resolution frame grab (render + read back in one task, no preserveDrawingBuffer).
    w.__fleetShot = () => {
      const st = getState();
      st.gl.render(st.scene, st.camera);
      return st.gl.domElement.toDataURL("image/png");
    };
    return () => {
      delete w.__fleet;
      delete w.__fleetShot;
      delete w.__fleetState;
    };
  }, [sim, getState]);
  useEffect(() => {
    sim.nozzles = { e46: kit.e46.nozzles, fighter: kit.fighters[0].nozzles };
    // Courier runs visit the agent planets (the vectors update in place as they orbit).
    sim.planets = new Map([...positions].filter(([id, v]) => id !== "tony" && !id.includes(":") && v.lengthSq() > 1));
  }, [sim, kit, positions]);
  useEffect(() => {
    sim.auto = auto;
    sim.reduced = reduced;
  }, [sim, auto, reduced]);
  useEffect(() => {
    if (flybyReq === seenReq.current) return;
    seenReq.current = flybyReq;
    sim.trigger(useSpace.getState().flybyKind);
  }, [flybyReq, sim]);

  // Rock instancing, one InstancedMesh per variant.
  const rockMeshes = useMemo(() => {
    return kit.rockGeos.map((g, v) => {
      const n = sim.rocks.filter((r) => r.variant === v).length;
      const m = new THREE.InstancedMesh(g, kit.rockMat, Math.max(1, n));
      m.count = n;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return m;
    });
  }, [kit, sim]);

  useEffect(
    () => () => {
      const seen = new Set<THREE.Material | THREE.BufferGeometry | THREE.Texture>();
      const all: THREE.Object3D[] = [kit.e46.root, kit.capital.root, ...kit.fighters.map((f) => f.root), kit.boltCore, kit.boltGlow, kit.points, kit.station, ...rockMeshes];
      for (const root of all)
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) seen.add(m.geometry);
          const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
          for (const mat of mats) {
            seen.add(mat);
            for (const v of Object.values(mat)) if (v instanceof THREE.Texture) seen.add(v);
          }
        });
      seen.add(kit.glow);
      for (const r of seen) r.dispose();
    },
    [kit, rockMeshes],
  );

  // Follow-cam targets, and click handlers that start following (planet inspector closes).
  const follow = useMemo(() => {
    const e46 = followTarget("ship:e46", 7, "E46 · GABAGOUL");
    const fighters = kit.fighters.map((_, i) => followTarget(`ship:fighter${i}`, 5, "Interceptor"));
    const capital = followTarget("ship:capital", 62, "Gabagoul capital ship");
    return { e46, fighters, capital };
  }, [kit]);
  const pick = (key: string) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    useSysMap.getState().close();
    useSpace.getState().setFollow(key);
  };
  const hover = (on: boolean) => () => void (document.body.style.cursor = on ? "pointer" : "");
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  /** Where the key light (and its shadow) centres: the followed ship, else the E46 in flight. */
  const hero = useRef<THREE.Vector3 | null>(null);
  const capPos = useMemo(() => new THREE.Vector3(), []);
  const capFwd = useMemo(() => new THREE.Vector3(), []);
  const scratch = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4() }), []);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    sim.viewAz = Math.atan2(camera.position.z, camera.position.x);
    sim.update(dt);
    const now = state.clock.elapsedTime;

    // Ships.
    const f = sim.flight;
    const models: ShipModel[] = [kit.e46, ...kit.fighters];
    for (const m of models) m.root.visible = false;
    follow.e46.visible = false;
    for (const t of follow.fighters) t.visible = false;
    if (f) {
      let fi = 0;
      for (const s of f.ships) {
        const t: FollowTarget | undefined = s.player ? follow.e46 : follow.fighters[fi];
        const m = s.player ? kit.e46 : kit.fighters[fi++];
        if (!m) continue;
        m.root.visible = true;
        if (t) {
          t.pos.copy(s.pos);
          t.fwd.copy(s.fwd);
          t.visible = s.live;
        }
        m.root.position.copy(s.pos);
        m.root.quaternion.copy(s.quat);
        const speedK = THREE.MathUtils.clamp(s.speed / 9, 0.5, 1.5);
        const pl = s.player ? kit.e46Plumes : kit.fighterPlumes[fi - 1];
        for (const [i, p] of (pl ?? []).entries()) {
          const flick = 0.9 + 0.1 * Math.sin(now * 23 + i * 5) + 0.06 * Math.random();
          // Plume length (model metres): longer the harder it's pushing.
          p.scale.z = (s.player ? 3.6 : 2.4) * speedK * flick;
          const r = (p.userData.radius as number) * (0.92 + 0.12 * flick);
          p.scale.x = p.scale.y = r;
        }
        for (const [i, g] of m.glows.entries()) {
          const flick = 0.85 + 0.1 * Math.sin(now * 31 + i * 7) + 0.08 * Math.random();
          g.scale.setScalar((g.userData.base as number) * flick * (0.75 + speedK * 0.35));
        }
      }
    }

    // Bolts: stretched additive cylinders along their velocity.
    let n = 0;
    for (const b of sim.bolts) {
      if (!b.on) continue;
      const dir = scratch.a.copy(b.vel).normalize();
      const len = 2.4;
      scratch.q.setFromUnitVectors(UP, dir);
      TMP.position.copy(b.pos).addScaledVector(dir, -len / 2);
      TMP.quaternion.copy(scratch.q);
      TMP.scale.set(0.045, len, 0.045);
      TMP.updateMatrix();
      kit.boltCore.setMatrixAt(n, TMP.matrix);
      TMP.scale.set(0.16, len * 1.15, 0.16);
      TMP.updateMatrix();
      kit.boltGlow.setMatrixAt(n, TMP.matrix);
      const col = b.blue ? C.setRGB(0.55, 0.9, 1.6) : C.setRGB(1.8, 0.35, 0.25);
      kit.boltGlow.setColorAt(n, col);
      kit.boltCore.setColorAt(n, b.blue ? C.setRGB(1.4, 1.8, 2) : C.setRGB(2, 1.4, 1.2));
      n++;
    }
    kit.boltCore.count = kit.boltGlow.count = n;
    for (const m of [kit.boltCore, kit.boltGlow]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // Particles.
    const g = kit.points.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.aColor.array as Float32Array;
    const sz = g.attributes.aSize.array as Float32Array;
    const al = g.attributes.aAlpha.array as Float32Array;
    sim.particles.forEach((p, i) => {
      if (!p.on) {
        al[i] = 0;
        sz[i] = 0;
        return;
      }
      const [s, a] = particleLook(p);
      pos[i * 3] = p.pos.x;
      pos[i * 3 + 1] = p.pos.y;
      pos[i * 3 + 2] = p.pos.z;
      const c = PCOL[p.kind];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
      sz[i] = s;
      al[i] = a;
    });
    for (const k of ["position", "aColor", "aSize", "aAlpha"]) g.attributes[k].needsUpdate = true;
    // World-size points: pixels per unit at distance 1.
    (kit.points.material as THREE.ShaderMaterial).uniforms.uScale.value = (size.height * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

    // Asteroids.
    const counts = [0, 0, 0];
    for (const r of sim.rocks) {
      TMP.position.copy(r.pos);
      TMP.quaternion.setFromAxisAngle(r.axis, r.angle);
      TMP.scale.setScalar(r.scale);
      TMP.updateMatrix();
      rockMeshes[r.variant].setMatrixAt(counts[r.variant]++, TMP.matrix);
    }
    for (const m of rockMeshes) m.instanceMatrix.needsUpdate = true;

    // Capital ship on its outer orbit, nose along the orbit tangent.
    sim.capitalPose(capPos, capFwd);
    kit.capital.root.position.copy(capPos);
    const x = scratch.b.crossVectors(UP, capFwd).normalize();
    const y = scratch.a.crossVectors(capFwd, x);
    scratch.m.makeBasis(x, y, capFwd);
    kit.capital.root.quaternion.setFromRotationMatrix(scratch.m);
    follow.capital.pos.copy(capPos);
    follow.capital.fwd.copy(capFwd);
    follow.capital.visible = true;
    const fkNow = useSpace.getState().follow;
    const ftNow = fkNow ? FOLLOW.get(fkNow) : undefined;
    hero.current = ftNow?.visible ? ftNow.pos : follow.e46.visible ? follow.e46.pos : null;
    // A followed ship that stays off stage (flight over) releases the camera.
    const fk = useSpace.getState().follow;
    const ft = fk ? FOLLOW.get(fk) : undefined;
    if (fk && ft) {
      ft.hiddenFor = ft.visible ? 0 : ft.hiddenFor + dt;
      if (ft.hiddenFor > 6) {
        ft.hiddenFor = 0;
        useSpace.getState().setFollow(null);
      }
    }
    for (const [i, gl] of kit.capital.glows.entries()) gl.scale.setScalar((gl.userData.base as number) * (0.9 + 0.08 * Math.sin(now * 3 + i)));

    // Far station: a billboard far beyond the system, fading in and out.
    const st = sim.station;
    kit.station.visible = !!st && !!kit.station.material.map;
    if (st) {
      kit.station.position.copy(st.dir).multiplyScalar(300);
      kit.station.scale.setScalar(st.size);
      const env = THREE.MathUtils.smoothstep(st.t, 0, 10) * (1 - THREE.MathUtils.smoothstep(st.t, st.life - 10, st.life));
      kit.station.material.opacity = 0.55 * env;
    }
  });

  return (
    <group>
      <NebulaEnvironment />
      <FleetLights focus={hero} />
      <primitive object={kit.e46.root} onClick={pick("ship:e46")} onPointerOver={hover(true)} onPointerOut={hover(false)} />
      {kit.fighters.map((m, i) => (
        <primitive key={i} object={m.root} onClick={pick(`ship:fighter${i}`)} onPointerOver={hover(true)} onPointerOut={hover(false)} />
      ))}
      <primitive object={kit.capital.root} onClick={pick("ship:capital")} onPointerOver={hover(true)} onPointerOut={hover(false)} />
      {rockMeshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      <primitive object={kit.boltGlow} />
      <primitive object={kit.boltCore} />
      <primitive object={kit.points} />
      <primitive object={kit.station} />
    </group>
  );
}
