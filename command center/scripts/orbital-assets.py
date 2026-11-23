"""
Orbital Ecosystem asset prep: fake-transparency removal, sprite-sheet slicing, wallpaper copy.

    python -I "command center/scripts/orbital-assets.py"            (from the repo root)

Reads the untouched originals in `command center/assets-src/orbital/` and writes:
  src/assets/orbital-backdrops/   nebula wallpapers (copied as-is, WebP)
  src/assets/orbital-sprites/     true-alpha PNG sprites (trimmed, edge-decontaminated)
  assets-src/orbital/_review.png  every sprite over magenta and over a nebula, for eyeballing

Needs Pillow, numpy, scipy. Re-runnable: outputs are overwritten.
"""
from pathlib import Path
import shutil

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets-src" / "orbital"
WALL = ROOT / "src" / "assets" / "orbital-backdrops"
SPR = ROOT / "src" / "assets" / "orbital-sprites"

WALLPAPERS = {
    "nebula-violet.webp": "01-violet-nebula.webp",
    "nebula-amber-dust.webp": "02-amber-dust-nebula.webp",
    "milky-way.webp": "03-milky-way.webp",
}

# Sprite sheet boxes (x0, y0, x1, y1) in the 1024×572 sheet, from a connected-component pass.
# The flaming meteor, burning asteroid, lasers, flares and shard cluster are skipped on purpose.
SHEET = {
    "enemy_fighter_1": (586, 50, 772, 182),  # stops above the "ASTEROIDS" label box
    "enemy_fighter_2": (796, 50, 998, 210),  # stops above asteroid_5
    "asteroid_1": (528, 249, 565, 283),
    "asteroid_2": (579, 248, 614, 287),
    "asteroid_3": (629, 234, 687, 298),
    "asteroid_4": (697, 226, 779, 307),
    "asteroid_5": (788, 214, 893, 317),
    "asteroid_6": (36, 464, 91, 516),
    "asteroid_7": (90, 451, 156, 525),
    "asteroid_8": (158, 440, 250, 531),
    "asteroid_9": (366, 406, 507, 544),
}


def rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32)


def border_connected(cand: np.ndarray) -> np.ndarray:
    lab, _ = ndi.label(cand)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    return np.isin(lab, edge[edge > 0])


def checker_colors(im: np.ndarray) -> np.ndarray:
    """The two checkerboard tones, from the image border (2-means)."""
    b = np.concatenate([im[:6].reshape(-1, 3), im[-6:].reshape(-1, 3), im[:, :6].reshape(-1, 3), im[:, -6:].reshape(-1, 3)])
    c = np.array([b.min(0), b.max(0)])
    for _ in range(12):
        k = np.argmin(((b[:, None] - c[None]) ** 2).sum(-1), 1)
        c = np.array([b[k == i].mean(0) if (k == i).any() else c[i] for i in range(2)])
    return c


def finish(im: np.ndarray, alpha: np.ndarray, bgc: np.ndarray) -> Image.Image:
    """Decontaminate semi-transparent pixels against the local background, trim, pad."""
    a = alpha[..., None]
    safe = np.maximum(a, 1e-3)
    col = np.where(a < 0.999, (im - (1 - a) * bgc) / safe, im)
    col = np.clip(col, 0, 255)
    out = np.dstack([col, alpha * 255]).astype(np.uint8)
    ys, xs = np.where(alpha > 0.02)
    y0, y1, x0, x1 = max(ys.min() - 3, 0), ys.max() + 4, max(xs.min() - 3, 0), xs.max() + 4
    return Image.fromarray(out[y0:y1, x0:x1], "RGBA")


def checker_score(lum: np.ndarray, sq: float, k: float = 0.9) -> np.ndarray:
    """
    Local "is a checkerboard showing here" score, phase- and tint-free: demodulate at the
    checker's diagonal fundamentals and normalise by local contrast. Works through
    semi-transparent glass and glow, where colour tests fail.
    """
    h, w = lum.shape
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    m = lum - ndi.uniform_filter(lum, int(2 * sq))
    sig = sq * k
    acc = np.zeros_like(lum)
    for sign in (1, -1):
        ph = np.pi * (xx + sign * yy) / sq
        acc += np.hypot(ndi.gaussian_filter(m * np.cos(ph), sig), ndi.gaussian_filter(m * np.sin(ph), sig))
    return acc / (np.sqrt(ndi.gaussian_filter(m * m, sig)) + 2)


def square_size(lum: np.ndarray) -> float:
    """Checker square size (fractional px) that best explains the top border band."""
    band = lum[:24]
    return max(np.arange(6.5, 12.0, 0.05), key=lambda q: float(np.median(checker_score(band, q)[6:18, 20:-20])))


def strip_checker(path: Path, sphere: bool = False, glass: bool = False) -> Image.Image:
    im = rgb(path)
    cc = checker_colors(im)
    # Phase-free checker test (the generated checker drifts and its square boundaries are
    # antialiased): neutral grey, inside the two tones' range, and BOTH tones present within
    # ±5 px. Flat grey metal fails the "both tones nearby" test, so it never leaks.
    lum = im.mean(-1)
    chroma = im.max(-1) - im.min(-1)
    lo, hi = sorted(cc.mean(-1))
    neutral = chroma < 14
    near_lo = neutral & (np.abs(lum - lo) < 16)
    near_hi = neutral & (np.abs(lum - hi) < 16)
    both = ndi.maximum_filter(near_lo, 11) & ndi.maximum_filter(near_hi, 11)
    cand = neutral & (lum > lo - 16) & (lum < hi + 16) & both
    # Anything the checker shows through (baked glow halos, ion trails) is background too; the
    # engine draws its own additive bloom. Solid hull never carries the pattern.
    sq = square_size(lum)
    score = checker_score(lum, sq)
    border_level = float(np.median(np.concatenate([score[:12].ravel(), score[-12:].ravel()])))
    shows = score > border_level * 0.45
    bg = border_connected(ndi.binary_closing(cand | (shows & (lum > lo - 40)), iterations=1, border_value=1))
    # The coarse detector blurs ~1 square: peel the remaining halo rim with a fine-scale pass,
    # only outward from the background and at most 8 px (solid hull and gun barrels never match).
    fine = checker_score(lum, sq, 0.45)
    fine_level = float(np.median(fine[:12]))
    rim_ok = (fine > fine_level * 0.4) & (lum > lo - 40) & ((im.max(-1) - im.min(-1)) < 30)
    for _ in range(8):
        grow = ndi.binary_dilation(bg) & ~bg & rim_ok
        if not grow.any():
            break
        bg |= grow
    # Edge decontamination tone: the lighter checker tone (edges sit over either).
    bgc = np.broadcast_to(cc[np.argmax(cc.mean(-1))], im.shape).astype(np.float32)
    if glass:
        # See-through glass shows the checker inside the hull. Wherever that texture appears,
        # low-pass it into smooth, slightly darkened tinted glass.
        w = np.clip((fine / fine_level - 0.35) / 0.35, 0, 1) * (~bg)
        w = ndi.gaussian_filter(w.astype(np.float32), 2)[..., None]
        im = im * (1 - w) + ndi.gaussian_filter(im, (4.5, 4.5, 0)) * 0.62 * w
    fg = ~bg
    # Keep the main body and anything big attached to it; drop ghost specks.
    lab, n = ndi.label(fg)
    sizes = ndi.sum(fg, lab, range(1, n + 1))
    keep = np.isin(lab, 1 + np.where(sizes > max(400, sizes.max() * 0.004))[0])

    if sphere:
        ys, xs = np.where(keep)
        lab2, _ = ndi.label(keep)
        big = lab2 == (np.bincount(lab2.ravel())[1:].argmax() + 1)
        ys, xs = np.where(big)
        cy, cx = (ys.min() + ys.max()) / 2, (xs.min() + xs.max()) / 2
        r = min(ys.max() - ys.min(), xs.max() - xs.min()) / 2 - 1.5
        yy, xx = np.mgrid[: im.shape[0], : im.shape[1]]
        alpha = np.clip(r - np.hypot(yy - cy, xx - cx) + 0.5, 0, 1).astype(np.float32)
        return finish(im, alpha, bgc)

    # Soft edge: blur the hard mask a touch.
    alpha = ndi.gaussian_filter(keep.astype(np.float32), 0.7)
    alpha = np.where(ndi.binary_erosion(keep, iterations=2), 1.0, alpha)
    alpha = np.clip(alpha, 0, 1).astype(np.float32)
    return finish(im, alpha, bgc)


def slice_sheet(path: Path) -> dict:
    im = rgb(path)
    out = {}
    for name, (x0, y0, x1, y1) in SHEET.items():
        c = im[y0:y1, x0:x1]
        r, g, b = c[..., 0], c[..., 1], c[..., 2]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        # Navy panel + its lighter grid lines: blue-dominant and darkish.
        cand = ((b - r) > 20) & (lum < 120)
        bg = border_connected(cand)
        fg = ~bg
        fg = ndi.binary_fill_holes(fg)
        lab, n = ndi.label(fg)
        if n:
            sizes = ndi.sum(fg, lab, range(1, n + 1))
            fg = np.isin(lab, 1 + np.where(sizes >= sizes.max() * 0.08)[0])
        alpha = ndi.gaussian_filter(fg.astype(np.float32), 0.6)
        alpha = np.where(ndi.binary_erosion(fg, iterations=1), 1.0, alpha).astype(np.float32)
        bgc = np.median(c[bg], 0) if bg.any() else np.array([14, 26, 46], np.float32)
        out[name] = finish(c, alpha, bgc)
    return out


def review(sprites: dict) -> None:
    neb = Image.open(SRC / "nebula-violet.webp").convert("RGBA")
    cell = 220
    cols = 4
    rows = (len(sprites) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell * 2, rows * cell), (0, 0, 0, 255))
    for i, (name, sp) in enumerate(sprites.items()):
        t = sp.copy()
        t.thumbnail((cell - 12, cell - 12), Image.LANCZOS)
        for j, bg in enumerate([Image.new("RGBA", (cell, cell), (255, 0, 255, 255)), neb.resize((cell, cell))]):
            tile = bg.copy()
            tile.alpha_composite(t, ((cell - t.width) // 2, (cell - t.height) // 2))
            sheet.paste(tile, ((i % cols) * cell * 2 + j * cell, (i // cols) * cell))
    sheet.convert("RGB").save(SRC / "_review.png")


def main() -> None:
    WALL.mkdir(parents=True, exist_ok=True)
    SPR.mkdir(parents=True, exist_ok=True)
    for src, dst in WALLPAPERS.items():
        shutil.copyfile(SRC / src, WALL / dst)
    sprites = {
        "death_star": strip_checker(SRC / "death-star-checker.webp", sphere=True),
        "e46_side": strip_checker(SRC / "e46-side-checker.webp", glass=True),
        "e46_rear": strip_checker(SRC / "e46-rear34-checker.webp"),
        **slice_sheet(SRC / "sprite-sheet.webp"),
    }
    for name, sp in sprites.items():
        sp.save(SPR / f"{name}.png", optimize=True)
        print(f"{name:18s} {sp.width}x{sp.height}")
    review(sprites)


if __name__ == "__main__":
    main()
