/**
 * Art for the Orbital Ecosystem deep-space backdrop.
 *
 *   Wallpapers: command center/src/assets/orbital-backdrops/
 *     JPG / WebP / AVIF / PNG, 16:9. 3840×2160 ideal (the engine scales them to the viewport,
 *     and anything under ~2560 px wide reads soft on a large window). Dark deep-field nebulae
 *     without ships, HUDs or grids. Every file joins the rotation, in filename order.
 *     Folder empty → a procedural nebula gradient rotates instead.
 *
 *   Sprites: command center/src/assets/orbital-sprites/
 *     True-alpha PNG, trimmed. Produced from the originals in `assets-src/orbital/` by
 *     `scripts/orbital-assets.py` (checkerboard removal, sprite-sheet slicing). Roles come
 *     from the filename: `e46_side`, `e46_rear`, `death_star`, `capital_ship`, `enemy_fighter_*`,
 *     `asteroid_*`.
 *     Orientation and engine positions for each role live in SPRITE_META below.
 *
 * Both folders are read with Vite's glob import: a new file needs a dev-server reload (or a
 * rebuild of the desktop bundle). No manifest to edit.
 */

const backdropUrls = import.meta.glob<string>("../../../assets/orbital-backdrops/*.{jpg,jpeg,png,webp,avif,JPG,JPEG,PNG,WEBP,AVIF}", { eager: true, query: "?url", import: "default" });
const spriteUrls = import.meta.glob<string>("../../../assets/orbital-sprites/*.png", { eager: true, query: "?url", import: "default" });

const baseName = (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();

/** Drop-in wallpaper URLs, in filename order. */
export const DROP_IN_BACKDROPS: readonly string[] = Object.keys(backdropUrls)
  .sort()
  .map((k) => backdropUrls[k]);

/** Sprite URL by basename (`e46_side`, `asteroid_3`, …). */
export const SPRITE_URLS: ReadonlyMap<string, string> = new Map(Object.entries(spriteUrls).map(([k, url]) => [baseName(k), url] as const));

export interface SpriteMeta {
  /** Direction the unmirrored art faces, radians (screen space, y down; 0 = right, π = left). */
  nose: number;
  /** Engine exhaust points, normalised to the unmirrored art (0..1). */
  thrusters: readonly (readonly [number, number])[];
  /** Max baked width (px): sprites are pre-scaled once, never drawn from the full source. */
  bakeWidth: number;
}

/** Per-role art facts, measured on the processed PNGs. */
export const SPRITE_META: Readonly<Record<string, SpriteMeta>> = {
  // Side profile: nose left; main nacelle exhaust at the right end, upper wing pod above it.
  e46_side: { nose: Math.PI, thrusters: [[0.95, 0.64], [0.65, 0.06]], bakeWidth: 320 },
  // Rear 3/4 (GABAGOUL plate side): travelling away towards the upper left; four tail engines.
  e46_rear: { nose: Math.PI + 0.42, thrusters: [[0.754, 0.767], [0.817, 0.767], [0.903, 0.741], [0.955, 0.719]], bakeWidth: 320 },
  // Sheet fighters: nose lower-left, flames upper-right.
  enemy_fighter_1: { nose: 2.76, thrusters: [[0.44, 0.25], [0.79, 0.43]], bakeWidth: 150 },
  enemy_fighter_2: { nose: 2.76, thrusters: [[0.46, 0.26], [0.71, 0.46]], bakeWidth: 150 },
  death_star: { nose: 0, thrusters: [], bakeWidth: 340 },
  // Capital ship 3/4 render: rounded bow upper-left, engine cluster lower-right.
  capital_ship: { nose: Math.PI + 0.32, thrusters: [[0.8, 0.66], [0.87, 0.53], [0.94, 0.6], [0.9, 0.78]], bakeWidth: 300 },
};
export const ASTEROID_BAKE_WIDTH = 96;
