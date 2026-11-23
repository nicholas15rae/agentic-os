# Orbital Ecosystem: sprites (`/sprites`)

Only the far battle station is still a sprite: it's a billboard ~300 units out, where a flat
image and a sphere look the same. Everything that flies (the E46, the interceptors, the Gabagoul
capital ship) and the asteroid field are real 3D geometry built at runtime in
`src/features/sysmap/space/fleet/models.ts`.

| File | Source | Notes |
|------|--------|-------|
| `death_star.png` | `assets-src/orbital/death-star-checker.webp` | checkerboard removed, circle-masked |

Regenerate with `python -I scripts/orbital-assets.py` (don't hand-edit). The other originals in
`assets-src/orbital/` (E46 renders, dogfight scene, sprite sheet) are kept as references for the
3D models.
