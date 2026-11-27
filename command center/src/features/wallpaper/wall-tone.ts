import { useWallpapers } from "./wallpaper-store";
import { wallTone } from "@/core/widgets/look";

/**
 * Section pass, legibility: how bright the current wallpaper is, as `data-wall-tone="light|dark"`
 * on <html>. Widget text (`.legible`) gets a stronger shadow over bright wallpapers, so panels
 * can stay transparent and the wallpaper stays the star. One tiny 24×24 sample per wallpaper
 * change, never a loop.
 */
export function installWallTone(): () => void {
  let gen = 0;
  const sample = (src: string | undefined) => {
    const g = ++gen;
    if (typeof document === "undefined") return;
    // A new wallpaper never keeps the old one's tone (no src / a failed load → the default, dark).
    delete document.documentElement.dataset.wallTone;
    if (!src) return;
    const img = new Image();
    img.onerror = () => undefined;
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (g !== gen) return;
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 24;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0;
        let gg = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          gg += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        document.documentElement.dataset.wallTone = wallTone(r / n, gg / n, b / n);
      } catch {
        /* a tainted canvas: keep the default (dark) */
      }
    };
    img.src = src;
  };
  const srcOf = (s: ReturnType<typeof useWallpapers.getState>) => s.items.find((i) => i.id === s.currentId)?.src;
  sample(srcOf(useWallpapers.getState()));
  const off = useWallpapers.subscribe((s, prev) => {
    if (s.currentId !== prev.currentId || srcOf(s) !== srcOf(prev)) sample(srcOf(s));
  });
  return () => {
    gen++;
    off();
  };
}
