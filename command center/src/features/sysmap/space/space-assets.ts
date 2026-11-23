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
 *     True-alpha PNG, produced from `assets-src/orbital/` by `scripts/orbital-assets.py`. Only
 *     `death_star` remains: it's a far billboard. Ships, rocks and the capital ship are real 3D
 *     geometry built in `fleet/models.ts`.
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
