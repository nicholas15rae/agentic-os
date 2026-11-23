# Orbital Ecosystem: nebula wallpapers (`/wallpapers`)

Layer 0 of the deep-space backdrop. Every image here joins the rotation: an ultra-slow sway plus
drift, crossfading on a long cycle (`BACKDROP_CONFIG.wallpaperCycleInterval`). The engine also
samples each image's dominant colour and brightest region to grade the sprites over it.

| File | Source |
|------|--------|
| `01-violet-nebula.webp` | soft violet nebula |
| `02-amber-dust-nebula.webp` | dusty amber nebula |
| `03-milky-way.webp` | purple/blue Milky Way |

- **Formats:** JPG, WebP, AVIF or PNG, 16:9.
- **Size:** 3840×2160 ideal. Anything under ~2560 px wide reads soft on a large window. The
  current three are 1024 px wide; swap in 4K versions with the same names when you have them.
- **Content:** clean deep-field only: no ships, HUDs or grids baked in.
- **Order:** filename order.

Vite picks files up by glob import. Reload the dev server after adding files (or rebuild the
desktop app). Wallpapers imported through the in-app Wallpaper manager (Backdrop: Custom) take
precedence while they are switched on.
