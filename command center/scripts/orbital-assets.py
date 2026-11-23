"""
Orbital Ecosystem asset prep: fake-transparency removal, photoreal mattes, wallpaper copy.

    python -I "command center/scripts/orbital-assets.py"            (from the repo root)

Reads the untouched originals in `command center/assets-src/orbital/` and writes:
  src/assets/orbital-backdrops/   nebula wallpapers (copied as-is, WebP)
  src/assets/orbital-sprites/     true-alpha PNG sprites (trimmed, edge-decontaminated)
  assets-src/orbital/_review.png  every sprite over magenta and over a nebula, for eyeballing

Photoreal ships and rocks are matted out of the scene renders (`e46-rear-scene`,
`dogfight-scene`) with GrabCut plus hand hints; the old cartoon sheet fighters and rocks are
retired. Needs Pillow, numpy, scipy, opencv-python. Re-runnable: outputs are overwritten.
"""
from pathlib import Path
import shutil

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
import cv2

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets-src" / "orbital"
WALL = ROOT / "src" / "assets" / "orbital-backdrops"
SPR = ROOT / "src" / "assets" / "orbital-sprites"

WALLPAPERS = {
    "nebula-violet.webp": "01-violet-nebula.webp",
    "nebula-amber-dust.webp": "02-amber-dust-nebula.webp",
    "milky-way.webp": "03-milky-way.webp",
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


# Photoreal rocks in the dogfight render (x0, y0, x1, y1), found as grey low-chroma blobs:
# whole, unlit by laser hits, away from the frame edge.
DOGFIGHT_ROCKS = [
    (921, 131, 963, 175), (945, 176, 996, 211), (945, 216, 986, 248),
    (671, 302, 710, 343), (748, 336, 802, 407), (24, 428, 55, 459),
]
FIGHTER_BOX = (770, 186, 915, 305)


def grabcut(path: Path, rect, hints=None, iters: int = 8) -> Image.Image:
    """Matte one object off a painted background: GrabCut, optional hints, soft edge, decontaminate."""
    bgr = cv2.imread(str(path))
    x0, y0, x1, y1 = rect
    pad = 14
    X0, Y0 = max(x0 - pad, 0), max(y0 - pad, 0)
    X1, Y1 = min(x1 + pad, bgr.shape[1]), min(y1 + pad, bgr.shape[0])
    c = np.ascontiguousarray(bgr[Y0:Y1, X0:X1])
    mask = np.zeros(c.shape[:2], np.uint8)
    bgd, fgd = np.zeros((1, 65)), np.zeros((1, 65))
    cv2.grabCut(c, mask, (x0 - X0, y0 - Y0, x1 - x0, y1 - y0), bgd, fgd, 6, cv2.GC_INIT_WITH_RECT)
    if hints:
        hints(c, mask, (X0, Y0))
        cv2.grabCut(c, mask, None, bgd, fgd, iters, cv2.GC_INIT_WITH_MASK)
    fg = np.isin(mask, [1, 3]).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg)
    if n > 1:
        big = st[1:, 4].max()
        fg = np.isin(lab, 1 + np.where(st[1:, 4] > max(300, big * 0.02))[0]) if hints else lab == 1 + st[1:, 4].argmax()
    fg = fg.astype(bool)
    # Local background behind the edge: inpaint the object away, then unmix edge pixels from it.
    bg = cv2.inpaint(c, ndi.binary_dilation(fg, iterations=2).astype(np.uint8), 5, cv2.INPAINT_TELEA)
    alpha = ndi.gaussian_filter(fg.astype(np.float32), 0.8)
    alpha = np.where(ndi.binary_erosion(fg, iterations=2), 1.0, alpha).astype(np.float32)
    rgbc = c[..., ::-1].astype(np.float32)
    return finish(rgbc, alpha, bg[..., ::-1].astype(np.float32))


def rock_cut(path: Path, rect) -> Image.Image:
    """Grey rock on a saturated nebula: low chroma is the matte."""
    im = rgb(path)
    x0, y0, x1, y1 = rect
    pad = 8
    X0, Y0, X1, Y1 = max(x0 - pad, 0), max(y0 - pad, 0), min(x1 + pad, im.shape[1]), min(y1 + pad, im.shape[0])
    c = im[Y0:Y1, X0:X1]
    chroma, lum = c.max(-1) - c.min(-1), c.mean(-1)
    m = ndi.binary_fill_holes(ndi.binary_opening(ndi.binary_closing((chroma < 38) & (lum > 22) & (lum < 170), iterations=2)))
    lab, n = ndi.label(m)
    fg = lab == (np.bincount(lab.ravel())[1:].argmax() + 1)
    bg = cv2.inpaint(np.ascontiguousarray(c.astype(np.uint8)), ndi.binary_dilation(fg, iterations=2).astype(np.uint8), 5, cv2.INPAINT_TELEA)
    alpha = ndi.gaussian_filter(fg.astype(np.float32), 0.8)
    alpha = np.where(ndi.binary_erosion(fg, iterations=2), 1.0, alpha).astype(np.float32)
    return finish(c, alpha, bg.astype(np.float32))


def e46_hints(c: np.ndarray, mask: np.ndarray, off) -> None:
    """Rear-scene E46: drop the nebula glow and ion plume, keep the thin lower-left wing and guns."""
    X0, Y0 = off
    b, g, r = (c[..., i].astype(int) for i in range(3))
    yy, xx = np.mgrid[: c.shape[0], : c.shape[1]]
    xx, yy = xx + X0, yy + Y0
    fg0 = np.isin(mask, [1, 3])
    magenta = (r > g + 35) & (b > g + 35)
    plume = (b > r + 50) & (g > r + 30) & ((xx < 222) | (yy > 420))
    mask[:] = np.where(fg0, cv2.GC_PR_FGD, cv2.GC_BGD)
    mask[(magenta | plume) & fg0] = cv2.GC_BGD
    mask[(yy >= 398) & (yy < 440) & (xx >= 280) & (xx < 420)] = cv2.GC_BGD
    sl = lambda x0, y0, x1, y1: (slice(y0 - Y0, y1 - Y0), slice(x0 - X0, x1 - X0))
    mask[sl(260, 150, 560, 330)] = cv2.GC_FGD
    mask[sl(560, 200, 760, 330)] = cv2.GC_FGD
    poly = np.array([(126, 368), (129, 384), (148, 384), (236, 352), (234, 318), (224, 318)]) - (X0, Y0)
    cv2.fillPoly(mask, [poly.astype(np.int32)], int(cv2.GC_FGD))
    cv2.line(mask, (250 - X0, 98 - Y0), (326 - X0, 98 - Y0), int(cv2.GC_FGD), 3)
    cv2.line(mask, (840 - X0, 98 - Y0), (878 - X0, 96 - Y0), int(cv2.GC_FGD), 3)


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
        "e46_rear": grabcut(SRC / "e46-rear-scene.webp", (115, 78, 925, 493), e46_hints),
        "enemy_fighter_1": grabcut(SRC / "dogfight-scene.webp", FIGHTER_BOX),
        **{f"asteroid_{i + 1}": rock_cut(SRC / "dogfight-scene.webp", box) for i, box in enumerate(DOGFIGHT_ROCKS)},
    }
    # Optional: the capital ship that orbits in the far background.
    capital = next(iter(sorted(SRC.glob("capital-ship-checker.*"))), None)
    if capital:
        sprites["capital_ship"] = strip_checker(capital)
    for name, sp in sprites.items():
        sp.save(SPR / f"{name}.png", optimize=True)
        print(f"{name:18s} {sp.width}x{sp.height}")
    review(sprites)


if __name__ == "__main__":
    main()
