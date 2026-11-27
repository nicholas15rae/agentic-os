"""Stills: batch polish + smart crop, contact sheets, text-on-frame thumbnails (Pillow)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat

from . import ff
from .config import PolicyError, Settings, next_version
from .jobs import Ctx

RATIOS = {"4:5": (4, 5), "8x10": (4, 5), "headshot": (4, 5), "1:1": (1, 1), "16:9": (16, 9),
          "9:16": (9, 16), "3:2": (3, 2), "2:3": (2, 3)}
FONT_CANDIDATES = [r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arial.ttf"]


def _font(size: int) -> ImageFont.ImageFont:
    for f in FONT_CANDIDATES:
        if Path(f).is_file():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default(size)


def _face_box(img: Image.Image) -> tuple[int, int, int, int] | None:
    """Largest frontal face via OpenCV's bundled Haar cascade, if OpenCV is installed."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    if not hasattr(cv2, "CascadeClassifier"):  # OpenCV 5 without contrib: fall back to centre crop
        return None
    gray = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2GRAY)
    scale = 800 / max(gray.shape)
    small = cv2.resize(gray, None, fx=scale, fy=scale) if scale < 1 else gray
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = casc.detectMultiScale(small, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    k = 1 / scale if scale < 1 else 1
    return int(x * k), int(y * k), int(w * k), int(h * k)


def crop_to(img: Image.Image, ratio: str, focus: str = "face") -> tuple[Image.Image, str]:
    if ratio not in RATIOS:
        raise PolicyError(f"ratio must be one of {', '.join(RATIOS)}")
    rw, rh = RATIOS[ratio]
    W, H = img.size
    if W / H > rw / rh:
        cw, ch = int(H * rw / rh), H
    else:
        cw, ch = W, int(W * rh / rw)
    cx, cy, how = W / 2, H / 2, "center"
    if focus == "face" and (box := _face_box(img)):
        x, y, w, h = box
        cx = x + w / 2
        cy = y + h * 0.9  # headshot framing: eyes in the upper third, room for shoulders
        how = "face"
    left = int(min(max(cx - cw / 2, 0), W - cw))
    top = int(min(max(cy - ch / 2, 0), H - ch))
    if how == "face":
        top = int(min(max(cy - ch * 0.45, 0), H - ch))
    return img.crop((left, top, left + cw, top + ch)), how


def _gray_world(img: Image.Image, strength: float) -> Image.Image:
    r, g, b = ImageStat.Stat(img.convert("RGB")).mean
    avg = (r + g + b) / 3
    gains = [1 + strength * (avg / max(c, 1) - 1) for c in (r, g, b)]
    bands = [ch.point(lambda v, k=k: min(255, int(v * k))) for ch, k in zip(img.convert("RGB").split(), gains)]
    return Image.merge("RGB", bands)


def apply_ops(img: Image.Image, ops: dict) -> tuple[Image.Image, list[str]]:
    done: list[str] = []
    img = ImageOps.exif_transpose(img).convert("RGB")
    if ops.get("auto_level", True):
        img = ImageOps.autocontrast(img, cutoff=float(ops.get("auto_level_cutoff", 0.5)), preserve_tone=True)
        done.append("auto_level")
    if ops.get("white_balance"):
        img = _gray_world(img, float(ops.get("white_balance_strength", 0.6)))
        done.append("white_balance")
    for key, enh in (("exposure", ImageEnhance.Brightness), ("contrast", ImageEnhance.Contrast),
                     ("saturation", ImageEnhance.Color)):
        if (v := ops.get(key)) not in (None, 1, 1.0):
            img = enh(img).enhance(float(v))
            done.append(f"{key}={v}")
    if ops.get("sharpen", True):
        img = img.filter(ImageFilter.UnsharpMask(radius=float(ops.get("sharpen_radius", 1.2)),
                                                 percent=int(ops.get("sharpen_percent", 60)), threshold=3))
        done.append("sharpen")
    if ratio := ops.get("crop"):
        img, how = crop_to(img, ratio, ops.get("focus", "face"))
        done.append(f"crop={ratio}({how})")
    if long_edge := ops.get("long_edge"):
        img.thumbnail((int(long_edge), int(long_edge)), Image.Resampling.LANCZOS)
        done.append(f"long_edge={long_edge}")
    if text := ops.get("watermark"):
        d = ImageDraw.Draw(img)
        f = _font(max(14, img.width // 40))
        pad = img.width // 60
        tw, th = d.textbbox((0, 0), text, font=f)[2:]
        d.text((img.width - tw - pad, img.height - th - pad), text, font=f, fill=(255, 255, 255),
               stroke_width=2, stroke_fill=(0, 0, 0))
        done.append("watermark")
    return img, done


def batch(s: Settings, ctx: Ctx, sources: list[Path], out_dir: Path, ops: dict, fmt: str, quality: int) -> dict:
    ext = {"jpg": ".jpg", "jpeg": ".jpg", "png": ".png", "webp": ".webp"}.get(fmt.lower())
    if not ext:
        raise PolicyError("format must be jpg, png or webp")
    results = []
    for i, src in enumerate(sources):
        ctx.check()
        with Image.open(src) as im:
            icc = im.info.get("icc_profile")
            out_img, done = apply_ops(im, ops)
        tag = (ops.get("crop") or "edit").replace(":", "x")
        out = next_version(out_dir, f"{src.stem}_{tag}", ext)
        kw: dict = {"icc_profile": icc} if icc else {}
        if ext == ".jpg":
            kw.update(quality=quality, subsampling=0, optimize=True)
        elif ext == ".webp":
            kw.update(quality=quality)
        out_img.save(out, **kw)
        results.append({"source": str(src), "output": str(out), "size": out_img.size, "ops": done,
                        "bytes": out.stat().st_size})
        ctx.progress((i + 1) / len(sources), f"{i + 1}/{len(sources)}")
    return {"count": len(results), "outputs": results}


def contact_sheet(s: Settings, sources: list[Path], out: Path, cols: int, cell: int) -> dict:
    rows = (len(sources) + cols - 1) // cols
    label_h = max(18, cell // 12)
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label_h)), (18, 18, 20))
    d = ImageDraw.Draw(sheet)
    f = _font(label_h - 6)
    for i, src in enumerate(sources):
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((cell - 8, cell - 8))
        x, y = (i % cols) * cell, (i // cols) * (cell + label_h)
        sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
        d.text((x + 6, y + cell), src.name[:40], font=f, fill=(200, 200, 205))
    sheet.save(out, quality=90)
    return {"output": str(out), "count": len(sources), "size": sheet.size}


def thumbnail(s: Settings, src: Path, at_sec: float | None, out: Path, text: str, aspect: str,
              subtitle: str | None) -> dict:
    tmp: Path | None = None
    if src.suffix.lower() in (".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi"):
        fd, name = tempfile.mkstemp(suffix=".png")
        os.close(fd)  # Windows keeps an open handle locked; ffmpeg must be able to overwrite it
        tmp = Path(name)
        t = at_sec if at_sec is not None else ff.probe(s, src)["duration_sec"] / 3
        r = ff.run([s.ffmpeg, "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", str(tmp)], 60)
        if r.returncode != 0 or not tmp.stat().st_size:
            raise PolicyError(f"could not grab a frame at {t:.1f}s")
        base = Image.open(tmp)
    else:
        base = Image.open(src)
    try:
        img, _ = crop_to(ImageOps.exif_transpose(base).convert("RGB"), aspect, "face")
        target_w = 1280 if RATIOS[aspect][0] >= RATIOS[aspect][1] else 1080
        img = img.resize((target_w, int(target_w * img.height / img.width)), Image.Resampling.LANCZOS)
        W, H = img.size
        # bottom gradient so text reads on any frame
        grad = Image.new("L", (1, H))
        for y in range(H):
            grad.putpixel((0, y), int(200 * max(0, (y - H * 0.45) / (H * 0.55))))
        img.paste(Image.new("RGB", (W, H), (0, 0, 0)), (0, 0), grad.resize((W, H)))
        d = ImageDraw.Draw(img)
        size = W // 9
        f = _font(size)
        while d.textbbox((0, 0), text, font=f)[2] > W * 0.92 and size > 24:
            size -= 4
            f = _font(size)
        tw, th = d.textbbox((0, 0), text, font=f)[2:]
        y = int(H * 0.86) - th - (size // 2 if subtitle else 0)
        d.text(((W - tw) // 2, y), text, font=f, fill=(255, 255, 255), stroke_width=max(2, size // 14),
               stroke_fill=(0, 0, 0))
        if subtitle:
            sf = _font(max(18, size // 2))
            sw = d.textbbox((0, 0), subtitle, font=sf)[2]
            d.text(((W - sw) // 2, y + th + size // 4), subtitle, font=sf, fill=(255, 122, 47),
                   stroke_width=2, stroke_fill=(0, 0, 0))
        img.save(out, quality=92)
    finally:
        base.close()
        if tmp:
            tmp.unlink(missing_ok=True)
    return {"output": str(out), "size": img.size, "aspect": aspect}
