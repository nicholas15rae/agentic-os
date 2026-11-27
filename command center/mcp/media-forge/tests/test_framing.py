"""detect_bars + render_timeline v2 framing (crop, fit: pad | fill | blur)."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
from pathlib import Path

import pytest
from conftest import gen, wait
from PIL import Image, ImageStat
from test_timeline_v2 import media, v2_spec, write_spec  # noqa: F401  (media is a fixture)

from media_forge import bars, config, ff, timeline
from media_forge.config import PolicyError

SLUG = "test-framing"
BASELINE = json.loads((Path(__file__).parent / "data" / "v2_graph_baseline.json").read_text("utf-8"))
DEMO = Path(r"C:\Users\nicho\Downloads\Nicholas_Rae_Demo_Reel.mp4")
CHECK_DIR = os.environ.get("MF_FRAMING_CHECK_DIR")  # where the demo-reel check frames go


@pytest.fixture(scope="module")
def boxed(s):
    """Synthetic sources: testsrc pillarboxed / letterboxed inside 1280x720 with pure black bars."""
    d = config.project_dir(s, SLUG) / "raw"
    pillar = d / "pillar.mp4"
    if not pillar.exists():  # 360x640 picture centred in 1280x720 (460 px bars), with a tone
        gen(pillar, "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=3", "-f", "lavfi", "-i",
            "sine=frequency=330:sample_rate=48000:duration=3", "-vf", "pad=1280:720:460:40:color=black",
            "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac")
    letter = d / "letter.mp4"
    if not letter.exists():  # 1280x544 picture, 88 px bars top and bottom
        gen(letter, "-f", "lavfi", "-i", "testsrc2=size=1280x544:rate=30:duration=2",
            "-vf", "pad=1280:720:0:88:color=black", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
    late = d / "late.mp4"
    if not late.exists():  # black for the first 2 s (a dark open), then the pillarboxed picture
        gen(late, "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=4",
            "-vf", "pad=1280:720:460:40:color=black,fade=t=in:st=2:d=0.05", "-c:v", "libx264",
            "-preset", "ultrafast", "-pix_fmt", "yuv420p")
    black = d / "black.mp4"
    if not black.exists():
        gen(black, "-f", "lavfi", "-i", "color=black:size=640x360:rate=30:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
    return {"pillar": pillar, "letter": letter, "late": late, "black": black}


# ── detect_bars ────────────────────────────────────────────────────────────────

def test_detect_bars_pillarbox(s, boxed):
    r = bars.detect(s, boxed["pillar"])
    assert r["source"] == {"w": 1280, "h": 720}
    assert r["content"] == {"x": 460, "y": 40, "w": 360, "h": 640}
    assert r["pillarboxed"] and r["letterboxed"]  # 40 px top/bottom too: a windowbox
    assert r["confidence"] == 1.0 and len(r["samples"]) == 8 and len(r["regions"]) == 1
    assert set(r) >= {"content", "source", "confidence", "letterboxed", "pillarboxed", "window", "samples"}


def test_detect_bars_letterbox_and_window(s, boxed):
    r = bars.detect(s, boxed["letter"], sample_s=1.0, start_s=0.5, samples=4)
    assert r["content"] == {"x": 0, "y": 88, "w": 1280, "h": 544}
    assert r["letterboxed"] and not r["pillarboxed"]
    assert r["window"] == {"start_s": 0.5, "end_s": 1.5}
    assert [x["t"] for x in r["samples"]] == pytest.approx([0.625, 0.875, 1.125, 1.375])


def test_detect_bars_full_frame(s, media):
    r = bars.detect(s, media["slate"])  # testsrc2 edge to edge: no bars
    assert r["content"] == {"x": 0, "y": 0, "w": 1280, "h": 720}
    assert not r["pillarboxed"] and not r["letterboxed"] and r["confidence"] == 1.0


def test_detect_bars_ignores_black_samples(s, boxed):
    r = bars.detect(s, boxed["late"])
    assert sum(1 for x in r["samples"] if x.get("black")) == 4  # the first half is black
    assert r["content"] == {"x": 460, "y": 40, "w": 360, "h": 640}
    assert r["confidence"] == 0.5  # only half the samples saw a picture
    r = bars.detect(s, boxed["black"])
    assert r["confidence"] == 0.0 and r["content"] == {"x": 0, "y": 0, "w": 640, "h": 360}
    assert not r["pillarboxed"] and all(x.get("black") for x in r["samples"])


def test_detect_bars_image_and_bad_args(s, media):
    r = bars.detect(s, media["png"])  # the end card: dark navy (30,30,50) is above the black limit
    assert len(r["samples"]) == 1 and r["source"] == {"w": 1280, "h": 720}
    for kw, match in [({"sample_s": 0}, "sample_s"), ({"sample_s": -1}, "sample_s"), ({"start_s": -1}, "start_s"),
                      ({"samples": 0}, "samples"), ({"samples": 25}, "samples"), ({"samples": True}, "samples"),
                      ({"start_s": 99}, "past the end")]:
        with pytest.raises(PolicyError, match=match):
            bars.detect(s, media["slate"], **kw)


def test_detect_bars_tool(s, boxed):
    import server

    r = asyncio.run(server.detect_bars(str(boxed["pillar"]), samples=3))
    assert r["content"]["w"] == 360
    with pytest.raises(ValueError, match="outside the media root"):
        asyncio.run(server.detect_bars(r"C:\Windows\win.ini"))


@pytest.mark.skipif(not DEMO.is_file(), reason="the demo reel is not on this machine")
def test_detect_bars_demo_reel(s):
    """Read-only. The first minute is vertical footage pillarboxed in 1920x1080 (≈608x1080); the rest is
    windowboxed landscape, so the whole-file union is wider and reports two regions."""
    ss = dataclasses.replace(s, media_root=DEMO.parent)
    src = config.readable(ss, str(DEMO))
    r = bars.detect(ss, src, sample_s=55)
    assert r["source"] == {"w": 1920, "h": 1080}
    assert abs(r["content"]["w"] - 600) <= 40 and abs(r["content"]["h"] - 1080) <= 4
    assert r["pillarboxed"] and not r["letterboxed"] and r["confidence"] >= 0.75
    whole = bars.detect(ss, src)
    assert len(whole["regions"]) >= 2 and whole["content"]["w"] > r["content"]["w"]


# ── spec validation ────────────────────────────────────────────────────────────

def one_clip(path: Path, **clip) -> dict:
    return {"version": 2, "project": SLUG, "width": 1080, "height": 1920, "fps": 30,
            "clips": [{"path": str(path), "kind": "video", "in": 0.8, "out": 4.2, **clip}],
            "audio": [], "loudness_lufs": None}


@pytest.mark.parametrize("clip, match", [
    ({"fit": "stretch"}, "fit must be pad, fill or blur"),
    ({"fit": None}, "fit must be"),
    ({"crop": [0, 0, 100, 100]}, "crop must be an object"),
    ({"crop": {"x": 0, "y": 0, "w": 100}}, "missing h"),
    ({"crop": {"x": 0, "y": 0, "w": 100, "h": 100, "r": 1}}, "unknown key"),
    ({"crop": {"x": 1, "y": 0, "w": 100, "h": 100}}, "crop.x must be even"),
    ({"crop": {"x": 0, "y": 0, "w": 101, "h": 100}}, "crop.w must be even"),
    ({"crop": {"x": -2, "y": 0, "w": 100, "h": 100}}, "crop.x must be ≥ 0"),
    ({"crop": {"x": 0, "y": 0, "w": 100.0, "h": 100}}, "crop.w must be an integer"),
    ({"crop": {"x": 0, "y": True, "w": 100, "h": 100}}, "crop.y must be an integer"),
    ({"crop": {"x": 0, "y": 0, "w": 14, "h": 100}}, "at least 16x16"),
    ({"crop": {"x": 1200, "y": 0, "w": 100, "h": 100}}, "outside the 1280x720 source"),
    ({"crop": {"x": 0, "y": 640, "w": 100, "h": 100}}, "outside the 1280x720 source"),
])
def test_framing_validation(s, media, clip, match):
    with pytest.raises(PolicyError, match=match):
        timeline.load_spec(s, write_spec(s, "fbad", one_clip(media["slate"], **clip)))


def test_framing_v1_refuses_new_keys(s, media):
    spec = one_clip(media["slate"], fit="fill")
    spec["version"] = 1
    with pytest.raises(PolicyError, match="unknown key"):
        timeline.load_spec(s, write_spec(s, "fv1", spec))


def test_framing_plan_defaults(s, media):
    plan = timeline.load_spec(s, write_spec(s, "fdef", one_clip(media["slate"])))
    assert plan["clips"][0]["fit"] == "pad" and plan["clips"][0]["crop"] is None
    crop = {"x": 426, "y": 0, "w": 428, "h": 720}  # exactly at the right edge is fine
    plan = timeline.load_spec(s, write_spec(s, "fok", one_clip(media["slate"], crop=crop, fit="blur")))
    assert plan["clips"][0]["crop"] == crop and plan["clips"][0]["fit"] == "blur"
    edge = {"x": 1264, "y": 704, "w": 16, "h": 16}
    assert timeline.load_spec(s, write_spec(s, "fedge", one_clip(media["slate"], crop=edge)))["clips"][0]["crop"] == edge


# ── filter graph ───────────────────────────────────────────────────────────────

def test_graph_unchanged_without_framing_keys(s, media):
    """A v2 spec that omits crop / fit builds byte-for-byte the graph it built before they existed."""
    spec = v2_spec(media)
    plan = timeline.load_spec(s, write_spec(s, "fbase", spec))
    assert timeline._graph_v2(plan, True, "amix", "captions.ass")[1] == BASELINE["full"]
    assert timeline._graph_v2(plan, False, "aout")[1] == BASELINE["audio"]
    for c in spec["clips"]:
        c.update(fit="pad", crop=None)
    plan = timeline.load_spec(s, write_spec(s, "fbase2", spec))
    assert timeline._graph_v2(plan, True, "amix", "captions.ass")[1] == BASELINE["full"]


HEAD = "[0:v]trim=start=0.8:end=4.2,setpts=PTS-STARTPTS"
TAIL = ",setsar=1,fps=30,format=yuv420p,settb=AVTB[v0]"
CROP = {"x": 426, "y": 0, "w": 428, "h": 720}


@pytest.mark.parametrize("clip, expect", [
    ({"fit": "fill"},
     [HEAD + ",scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" + TAIL]),
    ({"fit": "fill", "crop": CROP},
     [HEAD + ",crop=428:720:426:0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" + TAIL]),
    ({"fit": "fill", "punch_in": 1.2},
     [HEAD + ",scale=1296:2304:force_original_aspect_ratio=increase,crop=1080:1920" + TAIL]),
    ({"fit": "fill", "crop": CROP, "punch_in": 1.25},
     [HEAD + ",crop=428:720:426:0,scale=1350:2400:force_original_aspect_ratio=increase,crop=1080:1920" + TAIL]),
    ({"fit": "blur"},
     [HEAD + ",split=2[bg0][fg0]",
      "[bg0]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,scale=1080:1920,"
      "eq=brightness=-0.08:saturation=0.85[bb0]",
      "[fg0]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fs0]",
      "[bb0][fs0]overlay=(W-w)/2:(H-h)/2" + TAIL]),
    ({"fit": "blur", "crop": CROP, "punch_in": 1.25},
     [HEAD + ",crop=428:720:426:0,crop=trunc(iw/1.25/2)*2:trunc(ih/1.25/2)*2,split=2[bg0][fg0]",
      "[bg0]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,scale=1080:1920,"
      "eq=brightness=-0.08:saturation=0.85[bb0]",
      "[fg0]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fs0]",
      "[bb0][fs0]overlay=(W-w)/2:(H-h)/2" + TAIL]),
    ({"fit": "pad", "crop": CROP},
     [HEAD + ",crop=428:720:426:0,scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,"
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black" + TAIL]),
])
def test_framing_graph_strings(s, media, clip, expect):
    plan = timeline.load_spec(s, write_spec(s, "fg", one_clip(media["slate"], **clip)))
    parts = timeline._graph_v2(plan, True, "amix")[1].split(";")
    assert parts[:len(expect)] == expect
    assert parts[len(expect)].startswith("[0:a]atrim=start=0.8:end=4.2")
    # the audio-only loudness pass never builds the picture
    assert "[bg0]" not in timeline._graph_v2(plan, False, "aout")[1]


def test_framing_blur_with_fades_and_image(s, media):
    spec = one_clip(media["slate"], fit="blur", fade_ms=300)
    spec["clips"].append({"path": str(media["png"]), "kind": "image", "in": 0, "out": 1.5, "fit": "blur",
                          "transition_in": {"kind": "crossfade", "ms": 400}})
    plan = timeline.load_spec(s, write_spec(s, "fgi", spec))
    g = timeline._graph_v2(plan, True, "amix")[1]
    assert ("[bb0][fs0]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p,fade=t=in:st=0:d=0.300,"
            "fade=t=out:st=3.100:d=0.300,settb=AVTB[v0]") in g
    assert "[1:v]trim=duration=1.500,setpts=PTS-STARTPTS,split=2[bg1][fg1]" in g
    assert "[vr0][vr1]xfade=transition=fade:duration=0.400" in g


# ── real renders ───────────────────────────────────────────────────────────────

def _frame(s, video: Path, at: float, out: Path) -> Image.Image:
    out.parent.mkdir(parents=True, exist_ok=True)
    r = ff.run([s.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at}", "-i", str(video),
                "-frames:v", "1", "-q:v", "3", str(out)], 60)
    assert r.returncode == 0, r.stderr
    return Image.open(out).convert("L")


def _strip_mean(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    return ImageStat.Stat(img.crop(box)).mean[0]


@pytest.mark.parametrize("fit", ["fill", "blur"])
def test_render_pillarboxed_source(s, jobs, boxed, fit):
    """detect_bars → crop → 9:16. pad would leave the content as a small window in black; fill and
    blur must put picture right to the left/right edges."""
    det = bars.detect(s, boxed["pillar"])
    spec = {"version": 2, "project": SLUG, "width": 540, "height": 960, "fps": 30, "loudness_lufs": None,
            "clips": [{"path": str(boxed["pillar"]), "kind": "video", "in": 0, "out": 2.5,
                       "crop": det["content"], "fit": fit}], "audio": []}
    spec_path = write_spec(s, f"pillar_{fit}", spec)
    plan = timeline.load_spec(s, spec_path)
    out = config.writable(s, str(config.next_version(config.project_dir(s, SLUG) / "renders", f"pillar_{fit}", ".mp4")))
    res = wait(jobs, jobs.start("timeline", fit, lambda ctx: timeline.render(s, ctx, plan, out, spec_path)))
    assert res["verify"]["ok"], res["verify"]
    assert res["fits"][fit] == 1 and res["cropped_clips"] == 1
    assert (res["width"], res["height"]) == (540, 960)
    img = _frame(s, out, 1.2, out.with_suffix(".jpg"))
    assert img.size == (540, 960)
    left, right = _strip_mean(img, (0, 100, 12, 860)), _strip_mean(img, (528, 100, 540, 860))
    top = _strip_mean(img, (100, 0, 440, 12))
    assert left > 25 and right > 25 and top > 25, (left, right, top)  # no black bars anywhere


def test_render_pad_still_boxes(s, jobs, boxed):
    """Control: the default fit on the same source keeps the old (boxed) look."""
    spec = {"version": 2, "project": SLUG, "width": 540, "height": 960, "fps": 30, "loudness_lufs": None,
            "clips": [{"path": str(boxed["pillar"]), "kind": "video", "in": 0, "out": 1.0}], "audio": []}
    spec_path = write_spec(s, "pillar_pad", spec)
    plan = timeline.load_spec(s, spec_path)
    out = config.writable(s, str(config.next_version(config.project_dir(s, SLUG) / "renders", "pillar_pad", ".mp4")))
    wait(jobs, jobs.start("timeline", "pad", lambda ctx: timeline.render(s, ctx, plan, out, spec_path)))
    img = _frame(s, out, 0.5, out.with_suffix(".jpg"))
    assert _strip_mean(img, (0, 100, 12, 860)) < 8  # black pillar bars survive


@pytest.mark.skipif(not DEMO.is_file(), reason="the demo reel is not on this machine")
@pytest.mark.parametrize("fit", ["fill", "blur"])
def test_render_demo_reel(s, jobs, tmp_path, fit):
    """3 s of the demo reel (read-only) to a 1080x1920 Reel; one frame saved as <fit>_check.jpg."""
    check = Path(CHECK_DIR) if CHECK_DIR else tmp_path
    check.mkdir(parents=True, exist_ok=True)
    # one root that holds both the source (Downloads) and the outputs (scratch / temp)
    common = Path(os.path.commonpath([str(DEMO.parent.resolve()), str(check.resolve())]))
    ss = dataclasses.replace(s, media_root=common)
    det = bars.detect(ss, config.readable(ss, str(DEMO)), sample_s=3.0, start_s=10.0)
    assert det["pillarboxed"] and abs(det["content"]["w"] - 600) <= 40
    spec = {"version": 2, "project": None, "width": 1080, "height": 1920, "fps": 30, "loudness_lufs": None,
            "clips": [{"path": str(DEMO), "kind": "video", "in": 10.0, "out": 13.0,
                       "crop": det["content"], "fit": fit}], "audio": []}
    spec_path = check / f"demo_{fit}_spec.json"
    spec_path.write_text(json.dumps(spec), "utf-8")
    plan = timeline.load_spec(ss, spec_path)
    out = config.writable(ss, str(config.next_version(check, f"demo_{fit}", ".mp4")))
    assert DEMO.parent not in out.parents
    res = wait(jobs, jobs.start("timeline", fit, lambda ctx: timeline.render(ss, ctx, plan, out, spec_path)))
    assert res["verify"]["ok"], res["verify"]
    img = _frame(ss, out, 1.5, check / f"{fit}_check.jpg")
    assert img.size == (1080, 1920)
    edge = min(_strip_mean(img, (0, 200, 16, 1700)), _strip_mean(img, (1064, 200, 1080, 1700)))
    assert edge > 6, edge  # picture (or its blurred copy) at the edges, not black pillars
