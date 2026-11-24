from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from conftest import gen, tone_clip, wait
from PIL import Image

from media_forge import analyze, config, ff, photos, video
from media_forge.config import PolicyError


# ── policy ──────────────────────────────────────────────────────────────────────

def test_raw_is_read_only(s, raw):
    with pytest.raises(PolicyError, match="read-only"):
        config.writable(s, str(raw["slate"].parent / "new.mp4"))


def test_outside_root_refused(s, tmp_path):
    with pytest.raises(PolicyError, match="outside the media root"):
        config.writable(s, str(tmp_path / "x.mp4"))
    with pytest.raises(PolicyError, match="absolute"):
        config.readable(s, "relative.mp4")


def test_no_overwrite_and_versions(s):
    d = config.project_dir(s, "test-tape") / "renders"
    first = config.next_version(d, "cut", ".mp4")
    first.write_bytes(b"x")
    assert config.next_version(d, "cut", ".mp4").name == "cut_v002.mp4"
    with pytest.raises(PolicyError, match="already exists"):
        config.writable(s, str(first))
    first.unlink()


def test_gpu_refused_by_default(s):
    assert not s.allow_gpu
    with pytest.raises(PolicyError, match="GPU_BUSY"):
        ff.video_encoder(s, "nvenc", 20, None)
    with pytest.raises(PolicyError, match="GPU_BUSY"):
        ff.refuse_gpu_args(s, "h264_nvenc")
    args = ff.video_encoder(s, "x264", 20, None)
    assert "libx264" in args and str(s.threads) in args


def test_bad_slug(s):
    with pytest.raises(PolicyError):
        config.project_dir(s, "../escape")


# ── analysis ────────────────────────────────────────────────────────────────────

def test_probe(s, raw):
    info = ff.probe(s, raw["take"])
    assert info["video"]["width"] == 640 and info["video"]["height"] == 360
    assert info["audio"]["sample_rate"] == 48000
    assert abs(info["duration_sec"] - 3.8) < 0.15


def test_silence_trim_points(s, raw):
    spans = ff.silences(s, raw["slate"], -35, 0.4)
    t_in, t_out = ff.trim_points(spans, ff.probe(s, raw["slate"])["duration_sec"], pad=0.25)
    assert abs(t_in - 0.75) < 0.12, spans   # 1.0 s head silence − 0.25 pad
    assert abs(t_out - 4.25) < 0.12, spans  # tone ends at 4.0 + 0.25 pad


def test_scenes(s, jobs, raw):
    pytest.importorskip("scenedetect")
    d = config.project_dir(s, "test-tape") / "working"
    a = tone_clip(d / "sc_a.mp4", 0, 2, 0, pattern="testsrc2")
    b = tone_clip(d / "sc_b.mp4", 0, 2, 0, pattern="smptebars")
    lst = d / "list.txt"
    lst.write_text(f"file '{a.as_posix()}'\nfile '{b.as_posix()}'\n")
    joined = gen(d / "two_shots.mp4", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy")
    res = wait(jobs, jobs.start("scenes", "t", lambda ctx: analyze.scenes(s, ctx, joined, 27, 0.5, d / "th")))
    assert res["scene_count"] >= 2
    assert all(Path(x["thumbnail"]).is_file() for x in res["scenes"])


# ── assembly ────────────────────────────────────────────────────────────────────

def test_self_tape_assemble(s, jobs, raw):
    clips = [{"path": str(raw["slate"])}, {"path": str(raw["take"])}, {"path": str(raw["mute"])}]
    plan = video.plan_assembly(s, clips, auto_trim=True, threshold_db=-35, pad=0.25, fade_ms=100,
                               width=None, height=None)
    assert plan["width"] == 1280 and plan["height"] == 720
    assert plan["clips"][0]["auto_trim"] and plan["clips"][2]["auto_trim"] is None  # no audio → no trim
    assert abs(plan["clips"][0]["duration"] - 3.5) < 0.2
    out = config.writable(s, str(config.project_dir(s, "test-tape") / "renders" / "tape_v001.mp4"))
    res = wait(jobs, jobs.start("assemble", "t", lambda ctx: video.assemble(
        s, ctx, plan, out, "self-tape", True, None, None, "x264")))
    assert res["verify"]["ok"], res["verify"]
    assert abs(res["loudness_measured"] - (-18)) <= 1.5
    assert abs(res["verify"]["probe"]["duration_sec"] - plan["total_duration"]) < 0.5
    for p in raw.values():  # originals untouched
        assert p.is_file()


def test_size_cap(s, jobs, raw):
    clips = [{"path": str(raw["slate"])}, {"path": str(raw["take"])}]
    plan = video.plan_assembly(s, clips, False, -35, 0.25, 0, 1280, 720)
    out = config.writable(s, str(config.project_dir(s, "test-tape") / "renders" / "capped_v001.mp4"))
    res = wait(jobs, jobs.start("assemble", "t", lambda ctx: video.assemble(
        s, ctx, plan, out, "web", False, None, 1.5, "x264")))
    assert res["verify"]["ok"], res
    assert out.stat().st_size <= 1.5 * 1024 * 1024


def test_reframe_with_burned_captions(s, jobs, raw):
    src = config.project_dir(s, "test-tape") / "renders" / "tape_v001.mp4"
    if not src.exists():
        pytest.skip("depends on test_self_tape_assemble")
    srt = src.with_suffix(".srt")
    srt.write_text("1\n00:00:00,500 --> 00:00:02,000\nHello there\n", "utf-8")
    out = config.writable(s, str(src.with_name("tape_9x16_v001.mp4")))
    burn = "subtitles" in ff.run([s.ffmpeg, "-hide_banner", "-filters"], 30).stdout
    res = wait(jobs, jobs.start("reframe", "t", lambda ctx: video.reframe(
        s, ctx, src, out, "9:16", "blur", srt, burn, 18, "x264")))
    assert res["verify"]["ok"], res
    assert res["verify"]["probe"]["video"]["width"] == 1080
    assert res["verify"]["probe"]["video"]["height"] == 1920


def test_cancel(s, jobs, raw):
    clips = [{"path": str(raw["slate"])}] * 12
    plan = video.plan_assembly(s, clips, False, -35, 0.25, 0, 1920, 1080)
    out = config.writable(s, str(config.project_dir(s, "test-tape") / "renders" / "cancel_v001.mp4"))
    job = jobs.start("assemble", "t", lambda ctx: video.assemble(s, ctx, plan, out, "web", True, None, None, "x264"))
    import time
    time.sleep(1.0)
    jobs.cancel(job.id)
    end = time.time() + 30
    while job.status in ("queued", "running") and time.time() < end:
        time.sleep(0.2)
    assert job.status == "cancelled", (job.status, job.error)
    assert not out.exists()


# ── stills ──────────────────────────────────────────────────────────────────────

def test_photos_and_thumbnail(s, jobs, raw):
    d = config.project_dir(s, "test-tape") / "raw"
    img = d / "head.jpg"
    Image.new("RGB", (3000, 2000), (120, 90, 80)).save(img)
    out_dir = config.project_dir(s, "test-tape") / "working" / "stills"
    res = wait(jobs, jobs.start("photos", "t", lambda ctx: photos.batch(
        s, ctx, [img], out_dir, {"crop": "4:5", "white_balance": True, "long_edge": 1500, "watermark": "© test"},
        "jpg", 90)))
    w, h = res["outputs"][0]["size"]
    assert h == 1500 and abs(w / h - 0.8) < 0.01
    sheet = photos.contact_sheet(s, [img, Path(res["outputs"][0]["output"])], out_dir / "sheet.jpg", 2, 200)
    assert Path(sheet["output"]).is_file()
    th = photos.thumbnail(s, raw["slate"], 1.5, out_dir / "thumb.jpg", "MY SELF TAPE", "16:9", "Scene 1")
    assert th["size"] == (1280, 720)


@pytest.mark.skipif(not os.environ.get("MF_TEST_WHISPER"), reason="set MF_TEST_WHISPER=1 (downloads a model)")
def test_transcribe_cpu(s, jobs):
    pytest.importorskip("faster_whisper")
    speech = Path(os.environ["MF_TEST_WHISPER"])
    d = config.project_dir(s, "test-tape") / "working"
    src = d / speech.name
    shutil.copyfile(speech, src)
    res = wait(jobs, jobs.start("transcribe", "t", lambda ctx: analyze.transcribe(
        s, ctx, src, src.with_suffix(""), "tiny.en", None, True)), timeout=600)
    assert res["segment_count"] >= 1 and Path(res["srt"]).is_file()
