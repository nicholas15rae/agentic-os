/**
 * Procedural 3D models for the Orbital Ecosystem fleet: built from three.js primitives and
 * canvas-generated textures at runtime (no model files, no downloads). Every model faces +Z
 * with +Y up, so `quaternion` from the sim drives it directly.
 *
 *   E46 Touring  silver-blue wagon on an X-wing frame: rounded extruded body, dark glass
 *                greenhouse with pillars and roof rails, tail-lights, the GABAGOUL plate, four
 *                cyan tail engines, four wings with tip cannons.
 *   Interceptor  ball cockpit with a framed viewport, two pylons, bent dagger wings with
 *                solar-panel grids, red ion drive.
 *   Gabagoul     capital ship: a marbled-capicola hull (lathe), steel bands, side hangar bays,
 *                dorsal decks, a bridge tower with masts and a seven-nozzle engine cluster.
 *   Rocks        noise-displaced icosahedra (three variants, instanced by the scene).
 */
import * as THREE from "three";

export interface ShipModel {
  root: THREE.Group;
  /** Engine exhaust points (model space, after the model's scale). */
  nozzles: THREE.Vector3[];
  /** Additive glow sprites at the nozzles (scaled by the scene for flicker). */
  glows: THREE.Sprite[];
}

// ── textures ─────────────────────────────────────────────────────────────────

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

/** Seeded value noise (fBm) on a grid: cheap, tileable enough for hull textures. */
function noise2(seed: number) {
  const N = 256;
  const perm = new Uint8Array(N * 2);
  const vals = new Float32Array(N);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < N; i++) {
    perm[i] = i;
    vals[i] = rnd();
  }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const v = (x: number, y: number) => vals[perm[(perm[x & 255] + y) & 511]];
  const sm = (t: number) => t * t * (3 - 2 * t);
  const n = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = sm(x - xi);
    const fy = sm(y - yi);
    const a = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * fx;
    const b = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x: number, y: number, oct = 4) => {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      sum += n(x * f, y * f) * amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / (1 - Math.pow(0.5, oct));
  };
}

function texture(c: HTMLCanvasElement, srgb = true, repeat?: [number, number]) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

/**
 * Tangent-space normal map from a canvas texture's luminance (bright = raised), wrapping at the
 * edges so tiled textures stay seamless. Same repeat as the source.
 */
function normalFrom(src: THREE.CanvasTexture, strength: number, invert = false): THREE.Texture {
  const c = src.image as HTMLCanvasElement;
  const W = c.width;
  const H = c.height;
  const d = c.getContext("2d")!.getImageData(0, 0, W, H).data;
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const l = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    h[i] = invert ? 1 - l : l;
  }
  const [out, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  const at = (x: number, y: number) => h[((y + H) % H) * W + ((x + W) % W)];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      img.data[i] = (-dx / len) * 127.5 + 127.5;
      img.data[i + 1] = (dy / len) * 127.5 + 127.5;
      img.data[i + 2] = (1 / len) * 127.5 + 127.5;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = src.wrapS;
  t.wrapT = src.wrapT;
  t.repeat.copy(src.repeat);
  t.anisotropy = 4;
  return t;
}

/** Weathered paint: soft grime, faint rust freckles, a few scuffs (colour map, multiplies). */
function grimeTexture(seed: number) {
  const W = 256;
  const [c, g] = canvas(W, W);
  const n = noise2(seed);
  const img = g.createImageData(W, W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const k = n(x / 40, y / 40, 5);
      const r = n(x / 9 + 50, y / 9 + 50, 3);
      let v = 0.94 + (k - 0.5) * 0.09;
      let rr = v;
      let gg = v;
      let bb = v;
      if (r > 0.8) {
        // Rust freckle.
        const t = (r - 0.8) * 4;
        rr = v * (1 - t * 0.15);
        gg = v * (1 - t * 0.35);
        bb = v * (1 - t * 0.5);
      }
      const i = (y * W + x) * 4;
      img.data[i] = rr * 255;
      img.data[i + 1] = gg * 255;
      img.data[i + 2] = bb * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  // Rust run-off: thin streaks dripping down (canvas y is down the panel on the body sides).
  let s = seed * 7919;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * W;
    const y = rnd() * W * 0.8;
    const len = 20 + rnd() * 70;
    const grd = g.createLinearGradient(x, y, x, y + len);
    grd.addColorStop(0, "rgba(120,62,30,0.55)");
    grd.addColorStop(1, "rgba(120,62,30,0)");
    g.fillStyle = grd;
    g.fillRect(x, y, 1 + rnd() * 2.2, len);
  }
  return texture(c, true, [2, 2]);
}

/** Paint roughness: smoother where polished, rougher in grime. */
function roughTexture(seed: number) {
  const W = 128;
  const [c, g] = canvas(W, W);
  const n = noise2(seed);
  const img = g.createImageData(W, W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const v = 120 + (n(x / 18, y / 18, 4) - 0.5) * 140;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return texture(c, false, [2, 2]);
}

/** Panel lines + greebles for wings and steel. */
function panelTexture(seed: number, base: string, line: string) {
  const W = 256;
  const [c, g] = canvas(W, W);
  g.fillStyle = base;
  g.fillRect(0, 0, W, W);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = line;
  g.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) {
    const y = Math.floor(rnd() * W);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    const x = Math.floor(rnd() * W);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, W);
    g.stroke();
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.08)";
    g.fillRect(rnd() * W, rnd() * W, 4 + rnd() * 18, 3 + rnd() * 10);
  }
  return texture(c, true, [1, 1]);
}

/** Solar panel: near-black cells in a steel frame grid. */
function solarTexture() {
  const W = 256;
  const [c, g] = canvas(W, W);
  g.fillStyle = "#15171c";
  g.fillRect(0, 0, W, W);
  g.strokeStyle = "#4a4f58";
  g.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    g.beginPath();
    g.moveTo(0, (i * W) / 8);
    g.lineTo(W, (i * W) / 8);
    g.stroke();
  }
  g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath();
    g.moveTo((i * W) / 4, 0);
    g.lineTo((i * W) / 4, W);
    g.stroke();
  }
  return texture(c, true, [1, 1]);
}

/** The GABAGOUL plate. */
function plateTexture() {
  const [c, g] = canvas(256, 64);
  g.fillStyle = "#e9e4cf";
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = "#2a2a2a";
  g.lineWidth = 4;
  g.strokeRect(3, 3, 250, 58);
  g.fillStyle = "#1d2a6b";
  g.fillRect(6, 6, 22, 52);
  g.fillStyle = "#181818";
  g.font = "bold 40px 'Arial Narrow', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("GABAGOUL", 142, 34);
  return texture(c);
}

/** Cockpit viewport: dark glass behind an octagonal spoke frame. */
function viewportTexture() {
  const W = 256;
  const [c, g] = canvas(W, W);
  g.fillStyle = "#06080b";
  g.fillRect(0, 0, W, W);
  const grd = g.createRadialGradient(W * 0.4, W * 0.35, 4, W / 2, W / 2, W / 2);
  grd.addColorStop(0, "rgba(120,140,160,0.35)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, W, W);
  g.strokeStyle = "#5b616b";
  g.lineWidth = 10;
  g.beginPath();
  g.arc(W / 2, W / 2, W * 0.45, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 7;
  g.beginPath();
  g.arc(W / 2, W / 2, W * 0.14, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.moveTo(W / 2 + Math.cos(a) * W * 0.14, W / 2 + Math.sin(a) * W * 0.14);
    g.lineTo(W / 2 + Math.cos(a) * W * 0.45, W / 2 + Math.sin(a) * W * 0.45);
    g.stroke();
  }
  return texture(c);
}

/**
 * Marbled capicola for the lathe hull: u wraps the circumference, v runs stern → bow. Sampled on
 * a cylinder (seamless around the hull) at world-proportional scales, so the marbling isn't
 * stretched: rose meat, creamy fat veins and pockets, darker cured flecks.
 */
function capicolaTexture() {
  const W = 512; // around (≈ 21 units of circumference)
  const H = 1024; // along (≈ 36 units of profile)
  const [c, g] = canvas(W, H);
  const n = noise2(91);
  const m = noise2(17);
  // Cheap seamless 3D-ish noise from three 2D projections.
  const n3 = (f: typeof n, x: number, y: number, z: number, o: number) => (f(x + z * 0.7, y, o) + f(y + 5.3, z - x * 0.6, o) + f(z + 9.1, x + y, o)) / 3;
  const img = g.createImageData(W, H);
  const RC = 21 / (2 * Math.PI);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const a = (x / W) * Math.PI * 2;
      const X = Math.cos(a) * RC;
      const Y = Math.sin(a) * RC;
      const Z = (y / H) * 36;
      const warp = n3(n, X * 0.18, Y * 0.18, Z * 0.18, 3) * 3;
      const k = n3(m, X * 0.32 + warp, Y * 0.32 + warp, Z * 0.32, 4);
      const fat = Math.max(0, 1 - Math.abs(k - 0.5) * 11);
      const blob = Math.max(0, (n3(n, X * 0.7 + 3, Y * 0.7, Z * 0.7 + 7, 3) - 0.6) * 4.5);
      const cure = Math.max(0, (n3(m, X * 1.4 + 9, Y * 1.4, Z * 1.4, 2) - 0.64) * 3);
      const f = Math.min(1, fat * 0.9 + blob);
      let r = 182 + (k - 0.5) * 60;
      let gg = 84 + (k - 0.5) * 30;
      let b = 94 + (k - 0.5) * 30;
      r = r * (1 - f) + 240 * f;
      gg = gg * (1 - f) + 210 * f;
      b = b * (1 - f) + 204 * f;
      r *= 1 - cure * 0.35;
      gg *= 1 - cure * 0.45;
      b *= 1 - cure * 0.4;
      const i = (y * W + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return texture(c);
}

/** Soft radial glow for additive sprites. */
export function glowTexture(): THREE.Texture {
  const W = 128;
  const [c, g] = canvas(W, W);
  const grd = g.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.75)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.18)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, W, W);
  return texture(c, false);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, pos?: [number, number, number], rot?: [number, number, number]) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  return m;
}

/** Side profile (x = length, nose +x; y = height) extruded across the width, centred, nose → +Z. */
function profileBody(pts: [number, number][], width: number, bevel: number) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.01, width - bevel * 2);
  // bevelOffset pulls the rounded edge inside the outline, so the profile keeps its true size.
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelOffset: -bevel * 0.9, bevelSegments: 5, curveSegments: 16 });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A thin tapered panel from root chord to tip chord along +X. */
function taperPanel(span: number, root: number, tip: number, sweep: number, thick: number) {
  const s = new THREE.Shape();
  s.moveTo(0, -root / 2);
  s.lineTo(span, -tip / 2 + sweep);
  s.lineTo(span, tip / 2 + sweep);
  s.lineTo(0, root / 2);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.3, bevelSize: thick * 0.3, bevelSegments: 2 });
  geo.translate(0, 0, -thick / 2);
  // Shape y → model z (chord runs fore-aft), extrusion → model y (thickness).
  geo.rotateX(Math.PI / 2);
  return geo;
}

function addGlow(model: ShipModel, at: THREE.Vector3, color: string, size: number, tex: THREE.Texture) {
  const mat = new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
  const sp = new THREE.Sprite(mat);
  sp.position.copy(at);
  sp.scale.setScalar(size);
  sp.userData.base = size;
  model.root.add(sp);
  model.glows.push(sp);
  model.nozzles.push(at.clone());
}

// ── E46 Touring X-wing ───────────────────────────────────────────────────────

/** Built in metres (4.5 m long), scaled to world units by `scale`. */
export function buildE46(glowTex: THREE.Texture, scale = 0.65): ShipModel {
  // Real car paint: a softer metallic base coat under a near-mirror clear coat.
  const paint = new THREE.MeshPhysicalMaterial({ color: "#c0c8d1", map: grimeTexture(4), roughnessMap: roughTexture(9), metalness: 0.42, roughness: 0.48, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.5 });
  const blue = new THREE.MeshPhysicalMaterial({ color: "#6a7d96", map: grimeTexture(8), metalness: 0.45, roughness: 0.42, clearcoat: 0.5 });
  const glass = new THREE.MeshPhysicalMaterial({ color: "#0b0f14", metalness: 0.3, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6 });
  const trim = new THREE.MeshStandardMaterial({ color: "#26292e", metalness: 0.4, roughness: 0.62 });
  const steelMap = panelTexture(3, "#b0b7c0", "rgba(40,44,50,0.28)");
  const steel = new THREE.MeshStandardMaterial({ color: "#a7aeb7", map: steelMap, normalMap: normalFrom(steelMap, 2.2), metalness: 0.6, roughness: 0.36, envMapIntensity: 1.2 });
  const red = new THREE.MeshStandardMaterial({ color: "#5a0806", emissive: "#ff2a14", emissiveIntensity: 1.6, roughness: 0.3 });
  const lamp = new THREE.MeshStandardMaterial({ color: "#dfe8ff", emissive: "#cfe0ff", emissiveIntensity: 0.9, roughness: 0.15 });
  const rubber = new THREE.MeshStandardMaterial({ color: "#121315", roughness: 0.9 });
  const cyan = new THREE.MeshStandardMaterial({ color: "#0d3c48", emissive: "#4fe6ff", emissiveIntensity: 2.4, toneMapped: false });

  const model: ShipModel = { root: new THREE.Group(), nozzles: [], glows: [] };
  const car = new THREE.Group();
  model.root.add(car);
  const W = 1.74;

  // Lower body: bumper to bumper, hood, flat beltline, near-vertical tailgate.
  const lower = profileBody(
    [
      [-2.22, 0.26], [2.16, 0.26], [2.25, 0.36], [2.26, 0.55], [2.2, 0.7], [1.95, 0.8], [1.1, 0.93],
      [0.95, 0.95], [-1.95, 0.98], [-2.16, 0.95], [-2.24, 0.78], [-2.25, 0.4],
    ],
    W,
    0.17,
  );
  car.add(mesh(lower, paint));
  // Dark lower cladding and the side rub strip.
  const sill = profileBody([[-2.18, 0.24], [2.14, 0.24], [2.18, 0.4], [-2.2, 0.4]], W + 0.02, 0.05);
  car.add(mesh(sill, blue));
  car.add(mesh(new THREE.BoxGeometry(W + 0.05, 0.05, 3.2), trim, [0, 0.62, 0.1]));

  // Greenhouse: dark glass, narrower than the body (tumblehome via a big bevel).
  const glassGeo = profileBody([[1.02, 0.93], [0.1, 1.36], [-1.92, 1.39], [-2.1, 1.0], [-1.95, 0.97]], 1.36, 0.14);
  car.add(mesh(glassGeo, glass));
  // Roof skin + rails over the glass.
  const roof = profileBody([[0.12, 1.37], [-1.9, 1.4], [-1.93, 1.45], [0.06, 1.42]], 1.3, 0.06);
  car.add(mesh(roof, paint));
  for (const x of [-0.56, 0.56]) car.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 1.9), trim, [x, 1.5, -0.9]));
  // Pillars (A, B, C, D) both sides.
  const pillar = (x: number, z0: number, y0: number, z1: number, y1: number) => {
    const len = Math.hypot(z1 - z0, y1 - y0);
    const m = mesh(new THREE.BoxGeometry(0.06, len, 0.1), paint, [x, (y0 + y1) / 2, (z0 + z1) / 2]);
    m.rotation.x = Math.atan2(z1 - z0, y1 - y0);
    car.add(m);
  };
  for (const x of [-0.7, 0.7]) {
    pillar(x, 0.98, 0.95, 0.12, 1.36);
    pillar(x, -0.35, 0.97, -0.38, 1.38);
    pillar(x, -1.35, 0.97, -1.38, 1.39);
    pillar(x, -2.02, 0.98, -1.9, 1.38);
  }

  // Shut-lines (door and hatch seams), slightly proud of the panels so they always read.
  const seam = new THREE.MeshStandardMaterial({ color: "#14161a", roughness: 0.8 });
  for (const side of [-1, 1]) {
    for (const z of [0.98, -0.36, -1.42]) car.add(mesh(new THREE.BoxGeometry(0.01, 0.6, 0.012), seam, [side * 0.876, 0.66, z]));
    car.add(mesh(new THREE.BoxGeometry(0.01, 0.012, 2.4), seam, [side * 0.876, 0.94, -0.2]));
    // Door handles and mirrors.
    for (const z of [0.55, -0.85]) car.add(mesh(new THREE.BoxGeometry(0.03, 0.03, 0.14), steel, [side * 0.885, 0.82, z]));
    const mirror = new THREE.Group();
    mirror.position.set(side * 0.93, 1.0, 0.9);
    mirror.add(mesh(new THREE.BoxGeometry(0.16, 0.1, 0.06), paint));
    mirror.add(mesh(new THREE.BoxGeometry(0.06, 0.03, 0.08), trim, [-side * 0.08, -0.03, 0]));
    car.add(mirror);
  }
  // Hatch: roundel, wiper, handle bar.
  const roundel = (() => {
    const [c, g] = canvas(64, 64);
    g.fillStyle = "#111";
    g.beginPath();
    g.arc(32, 32, 31, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#e8e8e8";
    g.beginPath();
    g.arc(32, 32, 20, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1c69d4";
    for (const [a0, a1] of [[-Math.PI / 2, 0], [Math.PI / 2, Math.PI]]) {
      g.beginPath();
      g.moveTo(32, 32);
      g.arc(32, 32, 20, a0, a1);
      g.fill();
    }
    return texture(c);
  })();
  car.add(mesh(new THREE.CircleGeometry(0.06, 24), new THREE.MeshStandardMaterial({ map: roundel, metalness: 0.4, roughness: 0.3 }), [0, 0.9, -2.272], [0, Math.PI, 0]));
  const wiper = mesh(new THREE.BoxGeometry(0.55, 0.018, 0.02), trim, [0.05, 1.07, -2.1]);
  wiper.rotation.set(-0.32, 0, 0.18);
  car.add(wiper);
  car.add(mesh(new THREE.BoxGeometry(0.3, 0.035, 0.03), steel, [0, 0.74, -2.27]));
  // Two steel straps over the hatch, roof to plate.
  const strut = (x0: number, x1: number, z0: number, y0: number, z1: number, y1: number) => {
    const len = Math.hypot(z1 - z0, y1 - y0, x1 - x0);
    const m = mesh(new THREE.BoxGeometry(0.05, len, 0.035), steel, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
    m.rotation.x = Math.atan2(z1 - z0, y1 - y0);
    car.add(m);
  };
  for (const sx of [-1, 1]) {
    strut(sx * 0.2, sx * 0.16, -1.9, 1.47, -2.15, 1.0);
    strut(sx * 0.16, sx * 0.13, -2.19, 0.98, -2.3, 0.62);
  }

  const livery = (() => {
    const [c, g] = canvas(512, 160);
    g.clearRect(0, 0, 512, 160);
    // Diagonal hazard band (rear quarter).
    g.save();
    g.beginPath();
    g.rect(300, 20, 150, 26);
    g.clip();
    g.fillStyle = "#2b3442";
    g.fillRect(300, 20, 150, 26);
    g.fillStyle = "#d9dde2";
    for (let x = 280; x < 470; x += 18) {
      g.beginPath();
      g.moveTo(x, 46);
      g.lineTo(x + 9, 46);
      g.lineTo(x + 35, 20);
      g.lineTo(x + 26, 20);
      g.fill();
    }
    g.restore();
    g.fillStyle = "rgba(30,36,46,0.85)";
    g.font = "bold 20px 'Arial Narrow', Arial, sans-serif";
    g.fillText("GAB SQUADRON · 001", 60, 70);
    // Blue-grey lower stripe.
    g.fillStyle = "rgba(78,98,124,0.9)";
    g.fillRect(0, 112, 512, 26);
    return texture(c);
  })();
  const liveryMat = new THREE.MeshStandardMaterial({ map: livery, transparent: true, roughness: 0.4, metalness: 0.3, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const side of [-1, 1]) car.add(mesh(new THREE.PlaneGeometry(2.6, 0.81), liveryMat, [side * 0.873, 0.62, -0.7], [0, side * Math.PI / 2, 0]));

  // Front: kidney grille, headlights. Rear: tail-lights, plate, hatch handle.
  for (const x of [-0.14, 0.14]) car.add(mesh(new THREE.BoxGeometry(0.2, 0.16, 0.06), trim, [x, 0.66, 2.24]));
  for (const x of [-0.58, 0.58]) car.add(mesh(new THREE.BoxGeometry(0.44, 0.13, 0.06), lamp, [x, 0.67, 2.2]));
  for (const x of [-0.6, 0.6]) car.add(mesh(new THREE.BoxGeometry(0.42, 0.17, 0.06), red, [x, 0.8, -2.25]));
  car.add(mesh(new THREE.BoxGeometry(1.1, 0.03, 0.04), red, [0, 1.3, -2.08]));
  const plate = mesh(new THREE.PlaneGeometry(0.52, 0.13), new THREE.MeshStandardMaterial({ map: plateTexture(), roughness: 0.5, metalness: 0.1 }), [0, 0.6, -2.31], [0, Math.PI, 0]);
  car.add(plate);
  car.add(mesh(new THREE.BoxGeometry(1.9, 0.1, 0.12), trim, [0, 0.36, -2.28]));
  car.add(mesh(new THREE.BoxGeometry(1.9, 0.1, 0.12), trim, [0, 0.36, 2.28]));

  // Wheels, tucked for flight.
  const tire = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 28);
  tire.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.21, 20);
  rim.rotateZ(Math.PI / 2);
  for (const x of [-0.78, 0.78])
    for (const z of [-1.4, 1.36]) {
      car.add(mesh(tire, rubber, [x, 0.3, z]));
      car.add(mesh(rim, steel, [x, 0.3, z]));
    }

  // Tail engines under the plate: four nozzles with cyan cores.
  const bell = new THREE.CylinderGeometry(0.2, 0.22, 0.42, 32, 1, true);
  bell.rotateX(Math.PI / 2);
  const lip = new THREE.TorusGeometry(0.205, 0.03, 10, 32);
  const core = new THREE.CircleGeometry(0.17, 32);
  car.add(mesh(new THREE.BoxGeometry(1.75, 0.5, 0.36), trim, [0, 0.4, -2.3]));
  for (const x of [-0.66, -0.23, 0.23, 0.66]) {
    car.add(mesh(bell, steel, [x, 0.38, -2.5]));
    car.add(mesh(lip, steel, [x, 0.38, -2.71]));
    car.add(mesh(core, cyan, [x, 0.38, -2.55], [0, Math.PI, 0]));
    addGlow(model, new THREE.Vector3(x, 0.38, -2.78), "#55d8ff", 1.25, glowTex);
  }
  // Tow ladder under the plate.
  for (const y of [0.3, 0.4, 0.5]) car.add(mesh(new THREE.BoxGeometry(0.16, 0.025, 0.03), steel, [0, y, -2.5]));

  // X-wings as in the renders: uppers spring from the roof line, lowers from the sills, both
  // rooted behind the B-pillar and splayed wide; fat cannon pods with a cyan aft ring.
  const wingGeo = taperPanel(2.45, 1.35, 0.5, -0.45, 0.07);
  const pod = new THREE.CylinderGeometry(0.13, 0.13, 1.0, 20);
  pod.rotateX(Math.PI / 2);
  const podRing = new THREE.TorusGeometry(0.13, 0.025, 8, 20);
  const barrel = new THREE.CylinderGeometry(0.032, 0.032, 1.35, 10);
  barrel.rotateX(Math.PI / 2);
  const hider = new THREE.CylinderGeometry(0.05, 0.05, 0.16, 10);
  hider.rotateX(Math.PI / 2);
  const aft = new THREE.CircleGeometry(0.11, 20);
  const drum = new THREE.CylinderGeometry(0.24, 0.24, 0.42, 24);
  drum.rotateZ(Math.PI / 2);
  for (const side of [-1, 1])
    for (const up of [-1, 1]) {
      const wing = new THREE.Group();
      wing.position.set(side * (up > 0 ? 0.74 : 0.86), up > 0 ? 1.3 : 0.32, -0.75);
      // Mirror (not rotate) the left pair so the cannons still point forwards.
      wing.scale.x = side;
      wing.rotation.z = up * (up > 0 ? 0.62 : 0.5) * side;
      wing.add(mesh(wingGeo, steel));
      // Blue-grey stripe along the span, and the root fairing.
      wing.add(mesh(new THREE.BoxGeometry(1.5, 0.08, 0.2), blue, [1.0, 0, 0.25]));
      wing.add(mesh(new THREE.BoxGeometry(0.35, 0.18, 1.2), steel, [0.12, 0, 0]));
      const tip = new THREE.Group();
      tip.position.set(2.48, 0, -0.35);
      tip.add(mesh(pod, steel));
      for (const z of [-0.25, 0.25]) tip.add(mesh(podRing, trim, [0, 0, z]));
      tip.add(mesh(barrel, steel, [0, 0, 1.15]));
      tip.add(mesh(hider, trim, [0, 0, 1.85]));
      tip.add(mesh(aft, cyan, [0, 0, -0.51], [0, Math.PI, 0]));
      wing.add(tip);
      car.add(wing);
    }
  // Wing hinge drums at the upper roots (by the rear side windows).
  for (const side of [-1, 1]) car.add(mesh(drum, steel, [side * 0.78, 1.18, -0.6]));

  for (const o of car.children) {
    o.castShadow = false;
    o.receiveShadow = false;
  }
  model.root.scale.setScalar(scale);
  for (const n of model.nozzles) n.multiplyScalar(scale);
  return model;
}

/**
 * The E46 from a generated mesh (Hunyuan3D-2 from the GABAGOUL render, see
 * `assets-src/orbital/README-3d.md`): 2 units long with its nose at -Z, four thrusters low on the
 * tailgate. Turned to face +Z, sized to the same 4.5 m as the hand-built model, given clear-coated
 * paint, and fitted with thruster cores and glows at its real nozzles.
 */
export function buildE46FromMesh(glowTex: THREE.Texture, src: THREE.Object3D, scale = 0.65): ShipModel {
  const model: ShipModel = { root: new THREE.Group(), nozzles: [], glows: [] };
  const k = 2.3; // 2.0 generated units → 4.6 m
  const lift = 0.85; // match the hand-built model's ride height
  const body = src.clone(true);
  body.rotation.y = Math.PI;
  body.scale.setScalar(k);
  body.position.y = lift;
  body.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const old = m.material as THREE.MeshStandardMaterial;
    // The render's nebula leaves a violet cast in the bake: warm it back towards silver.
    m.material = new THREE.MeshPhysicalMaterial({ map: old.map ?? null, color: new THREE.Color(1.12, 1.08, 1.0), metalness: 0.12, roughness: 0.5, clearcoat: 0.55, clearcoatRoughness: 0.14, envMapIntensity: 1.0 });
    old.dispose();
  });
  model.root.add(body);
  const cyan = new THREE.MeshStandardMaterial({ color: "#0d3c48", emissive: "#4fe6ff", emissiveIntensity: 2.4, toneMapped: false });
  const core = new THREE.CircleGeometry(0.17, 28);
  for (const x of [-0.23, -0.1, 0.1, 0.23]) {
    // Generated-space nozzle (x, -0.16, +0.99) after the half-turn → (-x, -0.16, -0.99).
    const at = new THREE.Vector3(-x * k, -0.16 * k + lift, -0.99 * k);
    const disc = new THREE.Mesh(core, cyan);
    disc.position.copy(at).add(new THREE.Vector3(0, 0, -0.02));
    disc.rotation.y = Math.PI;
    model.root.add(disc);
    addGlow(model, at.clone().add(new THREE.Vector3(0, 0, -0.2)), "#55d8ff", 1.25, glowTex);
  }
  model.root.scale.setScalar(scale);
  for (const n of model.nozzles) n.multiplyScalar(scale);
  return model;
}

// ── Interceptor ──────────────────────────────────────────────────────────────

export function buildFighter(glowTex: THREE.Texture, scale = 0.55): ShipModel {
  const gunMap = panelTexture(12, "#686d77", "rgba(10,12,16,0.6)");
  const gun = new THREE.MeshStandardMaterial({ color: "#5d626c", map: gunMap, normalMap: normalFrom(gunMap, 3), metalness: 0.6, roughness: 0.4, envMapIntensity: 1.2 });
  const dark = new THREE.MeshStandardMaterial({ color: "#1b1d22", metalness: 0.6, roughness: 0.5 });
  const solar = new THREE.MeshStandardMaterial({ map: solarTexture(), metalness: 0.5, roughness: 0.32 });
  const frame = new THREE.MeshStandardMaterial({ color: "#5a5f69", metalness: 0.85, roughness: 0.35 });
  const red = new THREE.MeshStandardMaterial({ color: "#3a0805", emissive: "#ff3018", emissiveIntensity: 2.2, toneMapped: false });
  const viewport = new THREE.MeshPhysicalMaterial({ map: viewportTexture(), metalness: 0.2, roughness: 0.08, clearcoat: 1 });

  const model: ShipModel = { root: new THREE.Group(), nozzles: [], glows: [] };
  const g = new THREE.Group();
  model.root.add(g);
  g.add(mesh(new THREE.SphereGeometry(0.62, 40, 28), gun));
  g.add(mesh(new THREE.CircleGeometry(0.4, 40), viewport, [0, 0.02, 0.6]));
  g.add(mesh(new THREE.TorusGeometry(0.42, 0.05, 10, 40), frame, [0, 0.02, 0.58]));
  // Chin guns.
  for (const x of [-0.2, 0.2]) {
    const b = new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8);
    b.rotateX(Math.PI / 2);
    g.add(mesh(b, frame, [x, -0.42, 0.55]));
    g.add(mesh(new THREE.SphereGeometry(0.045, 10, 8), red, [x, -0.42, 0.76]));
  }
  // Pylons.
  const pylon = new THREE.CylinderGeometry(0.13, 0.18, 1.0, 16);
  pylon.rotateZ(Math.PI / 2);
  for (const side of [-1, 1]) g.add(mesh(pylon, gun, [side * 0.95, 0, 0]));
  // Dagger wings: upper and lower halves bent inwards, points swept forwards.
  const half = new THREE.Shape();
  half.moveTo(-0.55, 0);
  half.lineTo(0.55, 0);
  half.lineTo(0.95, 1.75);
  half.lineTo(0.25, 1.55);
  half.lineTo(-0.5, 0.55);
  half.closePath();
  const halfGeo = new THREE.ExtrudeGeometry(half, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
  halfGeo.translate(0, 0, -0.025);
  // Shape x → model z (forward), shape y → model y (span); thin across x.
  halfGeo.rotateY(-Math.PI / 2);
  const uv = halfGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5 + 0.5, uv.getY(i) * 0.5);
  for (const side of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(side * 1.48, 0, 0);
    for (const up of [1, -1]) {
      const h = mesh(halfGeo, solar);
      h.scale.y = up;
      h.rotation.z = side * up * 0.32;
      // Red gun tip at the dagger point.
      h.add(mesh(new THREE.SphereGeometry(0.06, 10, 8), red, [0, 1.72, 0.92]));
      wing.add(h);
    }
    wing.add(mesh(new THREE.BoxGeometry(0.16, 0.3, 1.1), frame));
    g.add(wing);
  }
  addGlow(model, new THREE.Vector3(0, 0, -0.7), "#ff4a2a", 1.0, glowTex);
  g.add(mesh(new THREE.CircleGeometry(0.22, 24), red, [0, 0, -0.63], [0, Math.PI, 0]));
  void dark;
  model.root.scale.setScalar(scale);
  for (const n of model.nozzles) n.multiplyScalar(scale);
  return model;
}

// ── Gabagoul capital ship ─────────────────────────────────────────────────────

/** ~30 units long before `scale` (default ≈ 48). */
export function buildCapital(glowTex: THREE.Texture, scale = 1.6): ShipModel {
  // Cured-meat hull: fat veins stand slightly proud, with a waxy sheen.
  const meatMap = capicolaTexture();
  const meat = new THREE.MeshPhysicalMaterial({ map: meatMap, normalMap: normalFrom(meatMap, 2.2), roughness: 0.5, metalness: 0.02, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffd9d2"), clearcoat: 0.25, clearcoatRoughness: 0.4 });
  const capSteelMap = panelTexture(21, "#868c95", "rgba(30,34,40,0.6)");
  const steel = new THREE.MeshStandardMaterial({ color: "#7d838c", map: capSteelMap, normalMap: normalFrom(capSteelMap, 3), metalness: 0.75, roughness: 0.42 });
  const dark = new THREE.MeshStandardMaterial({ color: "#16181c", metalness: 0.5, roughness: 0.7 });
  const bay = new THREE.MeshStandardMaterial({ color: "#2a2620", emissive: "#ffb070", emissiveIntensity: 0.55 });
  const nozzleCore = new THREE.MeshStandardMaterial({ color: "#0b1622", emissive: "#5fb8ff", emissiveIntensity: 0.9, toneMapped: false });

  const model: ShipModel = { root: new THREE.Group(), nozzles: [], glows: [] };
  const g = new THREE.Group();
  model.root.add(g);
  const L = 30;
  const R = 3.3;
  // Lathe profile (radius, length) from the stern (y = -L/2) to the rounded bow (y = +L/2).
  const prof: THREE.Vector2[] = [];
  prof.push(new THREE.Vector2(0, -L / 2));
  prof.push(new THREE.Vector2(R * 0.82, -L / 2));
  prof.push(new THREE.Vector2(R * 0.95, -L / 2 + 2));
  prof.push(new THREE.Vector2(R, -L / 2 + 6));
  prof.push(new THREE.Vector2(R * 0.98, L / 2 - 8));
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2);
    prof.push(new THREE.Vector2(Math.cos(a) * R * 0.98, L / 2 - 8 + Math.sin(a) * 8));
  }
  const hull = new THREE.LatheGeometry(prof, 64);
  // Lathe UVs advance per profile point, which crams the long midsection into a sliver of
  // texture: re-derive v from the position along the axis so the marbling isn't smeared.
  {
    const pos = hull.attributes.position as THREE.BufferAttribute;
    const uv = hull.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, (pos.getY(i) + L / 2) / L);
  }
  hull.rotateX(Math.PI / 2); // lathe axis y → z (bow +Z)
  const hullMesh = mesh(hull, meat);
  hullMesh.scale.set(1, 0.86, 1);
  g.add(hullMesh);
  // Steel bands.
  for (const z of [-11, -5, 2, 8]) {
    const band = mesh(new THREE.CylinderGeometry(R * 1.01, R * 1.01, 0.5, 64, 1, true), steel, [0, 0, z], [Math.PI / 2, 0, 0]);
    band.scale.set(1, 1, 0.86);
    g.add(band);
  }
  // Side spine with hangar bays (both sides).
  for (const side of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 0.9, 20), steel, [side * R * 0.98, -0.3, -1.5]));
    for (const z of [-6, -1.5, 3]) {
      g.add(mesh(new THREE.BoxGeometry(0.7, 1.7, 2.4), steel, [side * R * 0.99, -0.2, z]));
      g.add(mesh(new THREE.PlaneGeometry(1.9, 1.3), bay, [side * (R * 0.99 + 0.36), -0.2, z], [0, side * Math.PI / 2, 0]));
      // Ramp.
      const ramp = mesh(new THREE.BoxGeometry(0.06, 0.08, 1.8), steel, [side * (R + 0.9), -1.2, z]);
      ramp.rotation.z = side * 0.9;
      g.add(ramp);
    }
  }
  // Dorsal decks and greebles.
  g.add(mesh(new THREE.BoxGeometry(2.4, 0.5, 12), steel, [0, R * 0.86 + 0.1, -1]));
  for (let i = 0; i < 9; i++) g.add(mesh(new THREE.BoxGeometry(0.5 + (i % 3) * 0.3, 0.35, 0.8), steel, [((i % 3) - 1) * 0.8, R * 0.86 + 0.45, -6 + i * 1.3]));
  g.add(mesh(new THREE.BoxGeometry(0.9, 0.6, 1.2), steel, [0, R * 0.86 + 0.25, 9]));
  // Bridge tower with masts near the stern.
  g.add(mesh(new THREE.BoxGeometry(2, 1.6, 2.6), steel, [0, R * 0.86 + 1, -10]));
  g.add(mesh(new THREE.BoxGeometry(1.4, 0.4, 1.8), dark, [0, R * 0.86 + 1.9, -10]));
  for (const [x, h] of [[-0.4, 3.2], [0, 4.2], [0.4, 2.6], [0.2, 3.6]] as const) g.add(mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 6), steel, [x, R * 0.86 + 1.8 + h / 2, -10.4]));
  // Engine cluster: seven bells (one centre, six around).
  const bellGeo = new THREE.CylinderGeometry(0.95, 1.25, 2.6, 32, 1, true);
  bellGeo.rotateX(Math.PI / 2);
  const ringGeo = new THREE.TorusGeometry(1.25, 0.12, 10, 32);
  const coreGeo = new THREE.CircleGeometry(0.85, 32);
  const spots: [number, number][] = [[0, 0]];
  for (let i = 0; i < 6; i++) spots.push([Math.cos((i / 6) * Math.PI * 2) * 2.05, Math.sin((i / 6) * Math.PI * 2) * 1.75]);
  g.add(mesh(new THREE.CylinderGeometry(R * 0.82, R * 0.7, 1.4, 48), steel, [0, 0, -L / 2 - 0.5], [Math.PI / 2, 0, 0]));
  for (const [x, y] of spots) {
    g.add(mesh(bellGeo, steel, [x, y, -L / 2 - 2.2]));
    g.add(mesh(ringGeo, dark, [x, y, -L / 2 - 3.5]));
    g.add(mesh(coreGeo, nozzleCore, [x, y, -L / 2 - 1.2], [0, Math.PI, 0]));
    addGlow(model, new THREE.Vector3(x, y, -L / 2 - 3.6), "#6cc4ff", 2.6, glowTex);
  }
  model.root.scale.setScalar(scale);
  for (const n of model.nozzles) n.multiplyScalar(scale);
  return model;
}

// ── Rocks ─────────────────────────────────────────────────────────────────────

/** A lumpy asteroid: icosphere displaced by 3D value noise, unit radius. */
export function buildRockGeometry(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 4);
  const n = noise2(seed * 31 + 5);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const stretch = new THREE.Vector3(1 + (seed % 3) * 0.18, 0.78 + (seed % 2) * 0.1, 0.92);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    // Two projections of the 2D noise approximate 3D noise well enough for rock relief.
    const big = n(v.x * 1.6 + 3, v.y * 1.6 + v.z * 0.9, 3);
    const small = n(v.z * 5 + 11, v.x * 5 + v.y * 2.3, 3);
    const crater = Math.max(0, n(v.y * 3 + 7, v.z * 3 - v.x, 2) - 0.66) * 1.6;
    const r = 0.78 + big * 0.42 + small * 0.08 - crater * 0.35;
    v.multiplyScalar(r).multiply(stretch);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function rockMaterial(): THREE.MeshStandardMaterial {
  const W = 256;
  const [c, g] = canvas(W, W);
  const n = noise2(77);
  const img = g.createImageData(W, W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const k = n(x / 22, y / 22, 5);
      const s = n(x / 4 + 30, y / 4, 2);
      const v = 70 + k * 70 + (s - 0.5) * 30;
      const i = (y * W + x) * 4;
      img.data[i] = v * 1.02;
      img.data[i + 1] = v * 0.97;
      img.data[i + 2] = v * 0.92;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = texture(c, true, [2, 2]);
  return new THREE.MeshStandardMaterial({ map: t, normalMap: normalFrom(t, 4), roughness: 0.95, metalness: 0.02 });
}
