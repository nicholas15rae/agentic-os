"""Project layout (projects/<slug>/{raw,working,renders}) and the render_timeline tool."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from pathlib import Path

import pytest
from conftest import gen, wait
from PIL import Image

from media_forge import config, ff, timeline
from media_forge.config import PolicyError

SLUG = "test-tape"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def media(s, raw):
    base = config.project_dir(s, SLUG)
    png = base / "raw" / "end_slate.png"
    if not png.exists():
        img = Image.new("RGB", (1280, 720), (20, 24, 40))
        img.paste((230, 200, 60), (400, 260, 880, 460))
        img.save(png)
    vo = base / "working" / "voiceover" / "vo_v001.wav"
    if not vo.exists():
        gen(vo, "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=5", "-c:a", "pcm_s16le")
    return {**raw, "png": png, "vo": vo}


def write_spec(s, name: str, spec: dict) -> Path:
    p = config.project_dir(s, SLUG) / "working" / "timeline" / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(spec), "utf-8")
    return p


def base_spec(media, **over) -> dict:
    spec = {"version": 1, "project": SLUG, "width": 1920, "height": 1080, "fps": 30,
            "clips": [{"path": str(media["slate"]), "kind": "video", "in": 0.8, "out": 4.2, "fade_ms": 0},
                      {"path": str(media["take"]), "kind": "video", "in": 0.5, "out": 3.5, "fade_ms": 0},
                      {"path": str(media["png"]), "kind": "image", "in": 0, "out": 2.0, "fade_ms": 250}],
            "audio": [{"path": str(media["vo"]), "start": 1.0, "in": 0, "out": 4.0, "volume": 0.8}],
            "clip_audio_volume": 1.0, "loudness_lufs": -18, "max_size_mb": None}
    spec.update(over)
    return spec


# ── layout ──────────────────────────────────────────────────────────────────────

def test_project_layout(s):
    base = config.project_dir(s, SLUG)
    assert base == s.media_root / "projects" / SLUG
    assert config.PROJECT_SUBDIRS == ("raw", "working", "renders")
    assert all((base / sub).is_dir() for sub in config.PROJECT_SUBDIRS)
    with pytest.raises(PolicyError, match="read-only"):
        config.writable(s, str(base / "raw" / "x.mp4"))
    with pytest.raises(PolicyError, match="read-only"):
        config.writable(s, str(base / "raw" / "sub" / "x.mp4"))
    with pytest.raises(PolicyError, match="own state"):
        config.writable(s, str(s.media_root / ".media-forge" / "x.json"))
    assert config.writable(s, str(base / "working" / "captions" / "ok.srt")).parent.is_dir()


def test_default_outputs(s, media):
    import server

    p = server._out_path(SLUG, None, "renders", "web", ".mp4")
    assert p.parent == config.project_dir(s, SLUG) / "renders" and p.name == "web_v001.mp4"
    sheet = asyncio.run(server.contact_sheet([str(media["png"])], SLUG, 2, 200))
    assert Path(sheet["output"]).parent == config.project_dir(s, SLUG) / "working" / "stills"
    th = asyncio.run(server.make_thumbnail(str(media["png"]), "HELLO", SLUG))
    assert Path(th["output"]).parent == config.project_dir(s, SLUG) / "working" / "stills"


# ── render_timeline ─────────────────────────────────────────────────────────────

def test_render_timeline(s, jobs, media):
    raws = [media[k] for k in ("slate", "take", "png")]
    before = {p: sha(p) for p in raws}
    spec_path = write_spec(s, "cut", base_spec(media))
    plan = timeline.load_spec(s, spec_path)
    assert plan["total_duration"] == pytest.approx(3.4 + 3.0 + 2.0, abs=0.01)
    out = config.writable(s, str(config.project_dir(s, SLUG) / "renders" / "cut_v001.mp4"))
    res = wait(jobs, jobs.start("timeline", "t", lambda ctx: timeline.render(s, ctx, plan, out, spec_path)))
    assert res["verify"]["ok"], res["verify"]
    assert (res["width"], res["height"]) == (1920, 1080)
    v = res["verify"]["probe"]["video"]
    assert (v["width"], v["height"]) == (1920, 1080)
    assert res["duration_sec"] == pytest.approx(8.4, abs=0.25)
    assert abs(res["loudness_measured"] - (-18)) <= 1.5
    assert res["clips"] == 3 and res["audio_layers"] == 1 and res["encoder"] == "x264"
    assert {p: sha(p) for p in raws} == before  # originals byte-identical


@pytest.mark.parametrize("mutate, match", [
    (lambda sp, m: sp["clips"][0].update(kind="audio"), "kind must be"),
    (lambda sp, m: sp["clips"][1].update(out=99.0), "past the end"),
    (lambda sp, m: sp["clips"][0].update(path=r"C:\Windows\win.ini"), "outside the media root"),
    (lambda sp, m: sp.update(width=1921), "even integer"),
    (lambda sp, m: sp.update(version=2), "version"),
    (lambda sp, m: sp["clips"][2].update(out=90), "held 0.2"),
    (lambda sp, m: sp.update(loudness_lufs=-20), "loudness_lufs"),
    (lambda sp, m: sp["audio"][0].update(volume=3), "volume"),
    (lambda sp, m: sp.update(clips=[]), "1–200"),
])
def test_spec_validation(s, media, mutate, match):
    spec = base_spec(media)
    mutate(spec, media)
    with pytest.raises(PolicyError, match=match):
        timeline.load_spec(s, write_spec(s, "bad", spec))


def test_vertical_via_tool_default_output(s, media):
    import server

    spec = base_spec(media, width=1080, height=1920, loudness_lufs=None,
                     clips=[{"path": str(media["take"]), "kind": "video", "in": 0, "out": 2.0, "fade_ms": 100},
                            {"path": str(media["png"]), "kind": "image", "in": 0, "out": 1.0, "fade_ms": 0}])
    spec_path = write_spec(s, "vertical", spec)
    view = asyncio.run(server.render_timeline(str(spec_path), wait_s=300))
    assert view["status"] == "done", view
    res = view["result"]
    assert Path(res["output"]).parent == config.project_dir(s, SLUG) / "renders"
    assert Path(res["output"]).name.startswith("vertical_v")
    assert res["verify"]["ok"], res["verify"]
    v = res["verify"]["probe"]["video"]
    assert (v["width"], v["height"]) == (1080, 1920)
    assert res["loudness_target"] is None


def test_render_timeline_cancel(s, jobs, media):
    clip = {"path": str(media["slate"]), "kind": "video", "in": 0, "out": 5.0, "fade_ms": 0}
    spec_path = write_spec(s, "long", base_spec(media, clips=[clip] * 12, loudness_lufs=None))
    plan = timeline.load_spec(s, spec_path)
    out = config.writable(s, str(config.project_dir(s, SLUG) / "renders" / "long_v001.mp4"))
    job = jobs.start("timeline", "t", lambda ctx: timeline.render(s, ctx, plan, out, spec_path))
    end = time.time() + 20
    while job.stage != "encoding" and time.time() < end:
        time.sleep(0.1)
    time.sleep(1.0)
    jobs.cancel(job.id)
    end = time.time() + 30
    while job.status in ("queued", "running") and time.time() < end:
        time.sleep(0.2)
    assert job.status == "cancelled", (job.status, job.error)
    assert not out.exists()
