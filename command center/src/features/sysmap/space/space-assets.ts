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
 *     `scripts/orbital-assets.py` (checkerboard removal, photoreal mattes). Roles come
 *     from the filename: `e46_rear` (optional `e46_side`), `death_star`, `capital_ship`, `enemy_fighter_*`,
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

/** Sprite URL by basename (`e46_rear`, `asteroid_3`, …). */
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
  // Photoreal rear 3/4 (from the rear-scene render): travelling away towards the right, four
  // tail engines under the GABAGOUL plate.
  e46_rear: { nose: -0.3, thrusters: [[0.163, 0.704], [0.23, 0.709], [0.35, 0.735], [0.424, 0.742]], bakeWidth: 420 },
  // Photoreal fighter (from the dogfight render): cockpit towards the viewer, heading lower left.
  enemy_fighter_1: { nose: 2.7, thrusters: [], bakeWidth: 150 },
  death_star: { nose: 0, thrusters: [], bakeWidth: 340 },
  // Gabagoul capital ship 3/4 render: rounded bow upper-left, engine cluster lower-right.
  capital_ship: { nose: Math.PI + 0.32, thrusters: [[0.8, 0.66], [0.87, 0.53], [0.94, 0.6], [0.9, 0.78]], bakeWidth: 300 },
};
export const ASTEROID_BAKE_WIDTH = 96;
