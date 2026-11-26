"""render_timeline spec v2: validation, filter graph, captions (ASS), colour, local-only whisper, batch."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from pathlib import Path

import pytest
from conftest import gen, wait
from PIL import Image

from media_forge import analyze, captions, config, ff, timeline
from media_forge.config import PolicyError

SLUG = "test-v2"
TINY = Path(r"C:\ai-hub\models\faster-whisper\models--Systran--faster-whisper-tiny.en")


@pytest.fixture(scope="module")
def media(s, raw):
    base = config.project_dir(s, SLUG)
    png = base / "working" / "stills" / "end.png"
    if not png.exists():
        png.parent.mkdir(parents=True, exist_ok=True)
        img = Image.new("RGB", (1280, 720), (30, 30, 50))
        img.paste((240, 120, 60), (300, 200, 980, 520))
        img.save(png)
    music = base / "working" / "music" / "bed.wav"
    if not music.exists():
        gen(music, "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=12", "-c:a", "pcm_s16le")
    # transcribe_clip JSON, in each clip's SOURCE time (slate speaks 1.0–4.0 s, take 0.8–2.8 s).
    words = base / "working" / "captions"
    words.mkdir(parents=True, exist_ok=True)
    slate_js = words / "slate.json"
    slate_js.write_text(json.dumps({"language": "en", "duration": 5.5, "segments": [
        {"start": 1.0, "end": 2.6, "text": "Hello there, this is a test.",
         "words": [{"w": " Hello", "s": 1.0, "e": 1.3, "p": 0.9}, {"w": " there,", "s": 1.35, "e": 1.7, "p": 0.9},
                   {"w": " this", "s": 1.75, "e": 1.95, "p": 0.9}, {"w": " is", "s": 2.0, "e": 2.1, "p": 0.9},
                   {"w": " a", "s": 2.15, "e": 2.2, "p": 0.9}, {"w": " test.", "s": 2.25, "e": 2.6, "p": 0.9}]},
        {"start": 3.0, "end": 3.9, "text": "Second {line}",
         "words": [{"w": " Second", "s": 3.0, "e": 3.4, "p": 0.9}, {"w": " {line}", "s": 3.45, "e": 3.9, "p": 0.9}]},
        {"start": 4.5, "end": 5.0, "text": "cut off", "words": [{"w": " cut", "s": 4.5, "e": 4.7, "p": 0.9},
                                                              {"w": " off", "s": 4.75, "e": 5.0, "p": 0.9}]},
    ]}), "utf-8")
    take_js = words / "take.json"
    take_js.write_text(json.dumps({"language": "en", "duration": 3.8, "segments": [
        {"start": 0.9, "end": 2.0, "text": "Take two words", "words": [
            {"w": " Take", "s": 0.9, "e": 1.2, "p": 0.9}, {"w": " two", "s": 1.3, "e": 1.5, "p": 0.9},
            {"w": " words", "s": 1.6, "e": 2.0, "p": 0.9}]}]}), "utf-8")
    bad_js = words / "bad.json"
    bad_js.write_text(json.dumps({"segments": [{"words": [{"w": "x"}]}]}), "utf-8")
    return {**raw, "png": png, "music": music, "slate_js": slate_js, "take_js": take_js, "bad_js": bad_js}


def write_spec(s, name: str, spec: dict) -> Path:
    p = config.project_dir(s, SLUG) / "working" / "timeline" / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(spec), "utf-8")
    return p


def v2_spec(media, **over) -> dict:
    spec = {
        "version": 2, "project": SLUG, "width": 1280, "height": 720, "fps": 30,
        "clips": [
            {"path": str(media["slate"]), "kind": "video", "in": 0.8, "out": 4.2, "fade_ms": 0,
             "transition_in": {"kind": "fade_black", "ms": 400}, "punch_in": 1.0,
             "transcript": str(media["slate_js"])},
            {"path": str(media["take"]), "kind": "video", "in": 0.5, "out": 3.5, "fade_ms": 0,
             "transition_in": {"kind": "crossfade", "ms": 500}, "punch_in": 1.2,
             "transcript": str(media["take_js"])},
            {"path": str(media["png"]), "kind": "image", "in": 0, "out": 2.0, "fade_ms": 0,
             "transition_in": {"kind": "fade_black", "ms": 600}, "punch_in": 1.0, "transcript": None},
        ],
        # volume 0.5: at 0.6 loudnorm's pass-1 (shared ff.measure_loudness, v1 too) under-reads this
        # synthetic sine bed by ~1.6 LU against ebur128, so the -16 check would fail for that reason alone.
        "audio": [{"path": str(media["music"]), "start": 0, "in": 0, "out": 7.9, "volume": 0.5,
                   "fade_in_ms": 800, "fade_out_ms": 1200, "duck_under_voice": True}],
        "clip_audio_volume": 1.0, "loudness_lufs": -16, "max_size_mb": None,
        "captions": {"enabled": True, "style": "bold_pop", "position": "lower", "max_words_per_line": 3},
        "color": {"preset": "warm", "strength": 0.7},
    }
    spec.update(over)
    return spec


# ── validation ──────────────────────────────────────────────────────────────────

def test_v2_plan_timing(s, media):
    plan = timeline.load_spec(s, write_spec(s, "plan", v2_spec(media)))
    assert plan["version"] == 2
    c = plan["clips"]
    assert [x["transition"] for x in c] == ["fade_black", "crossfade", "fade_black"]
    assert [x["start"] for x in c] == pytest.approx([0, 3.4 - 0.5, 3.4 - 0.5 + 3.0])
    assert plan["total_duration"] == pytest.approx(3.4 + 3.0 + 2.0 - 0.5, abs=0.01)
    assert c[1]["punch_in"] == 1.2 and c[1]["transcript"] == str(media["take_js"])
    a = plan["audio"][0]
    assert (a["fade_in_s"], a["fade_out_s"], a["duck"]) == (0.8, 1.2, True)
    assert plan["captions"]["style"] == "bold_pop" and plan["color"] == {"preset": "warm", "strength": 0.7}


def test_v2_defaults_and_caps(s, media):
    spec = v2_spec(media)
    for c in spec["clips"]:
        for k in ("transition_in", "punch_in", "transcript"):
            c.pop(k)
    for k in ("fade_in_ms", "fade_out_ms", "duck_under_voice"):
        spec["audio"][0].pop(k)
    spec.pop("captions"), spec.pop("color")
    plan = timeline.load_spec(s, write_spec(s, "defaults", spec))
    assert all(c["transition"] == "cut" and c["punch_in"] == 1.0 and c["transcript"] is None for c in plan["clips"])
    assert plan["total_duration"] == pytest.approx(8.4, abs=0.01)
    assert plan["captions"] == timeline.CAPTION_DEFAULT and plan["color"] == timeline.COLOR_DEFAULT
    assert timeline.color_filter(plan["color"]) is None
    # A 1.5 s crossfade into a 2 s image is capped at 45% of the shorter clip; fades fit the layer.
    spec = v2_spec(media)
    spec["clips"][2]["transition_in"] = {"kind": "crossfade", "ms": 1500}
    spec["audio"][0].update(out=2.0, fade_in_ms=3000, fade_out_ms=1000)
    plan = timeline.load_spec(s, write_spec(s, "caps", spec))
    assert plan["clips"][2]["transition_s"] == pytest.approx(0.9)
    assert plan["audio"][0]["fade_in_s"] + plan["audio"][0]["fade_out_s"] == pytest.approx(2.0, abs=0.01)
    # ms 0 crossfade is a cut
    spec["clips"][1]["transition_in"] = {"kind": "crossfade", "ms": 0}
    assert timeline.load_spec(s, write_spec(s, "caps", spec))["clips"][1]["transition"] == "cut"


@pytest.mark.parametrize("mutate, match", [
    (lambda sp, m: sp["clips"][1].update(wobble=1), "unknown key"),
    (lambda sp, m: sp.update(look={}), "unknown key"),
    (lambda sp, m: sp["clips"][1].update(transition_in={"kind": "wipe", "ms": 300}), "transition_in.kind"),
    (lambda sp, m: sp["clips"][1].update(transition_in={"kind": "crossfade", "ms": 1600}), "ms must be ≤ 1500"),
    (lambda sp, m: sp["clips"][1].update(transition_in={"kind": "crossfade", "ms": -1}), "ms must be ≥ 0"),
    (lambda sp, m: sp["clips"][1].update(transition_in={"kind": "crossfade", "ms": 300, "ease": 1}), "unknown key"),
    (lambda sp, m: sp["clips"][1].update(transition_in="crossfade"), "must be an object"),
    (lambda sp, m: sp["clips"][0].update(transition_in={"kind": "crossfade", "ms": 300}), "first clip"),
    (lambda sp, m: sp["clips"][1].update(punch_in=1.6), "punch_in must be ≤ 1.5"),
    (lambda sp, m: sp["clips"][1].update(punch_in=0.9), "punch_in must be ≥ 1.0"),
    (lambda sp, m: sp["clips"][1].update(punch_in=True), "punch_in must be a number"),
    (lambda sp, m: sp["clips"][2].update(transcript=str(m["take_js"])), "image has no speech"),
    (lambda sp, m: sp["clips"][1].update(transcript=str(m["take"])), ".json"),
    (lambda sp, m: sp["clips"][1].update(transcript=str(m["bad_js"])), "words need"),
    (lambda sp, m: sp["clips"][1].update(transcript=r"C:\Windows\win.ini"), "outside the media root"),
    (lambda sp, m: sp["clips"][1].update(transcript=5), "absolute path or null"),
    (lambda sp, m: sp["audio"][0].update(fade_in_ms=20000), "fade_in_ms must be ≤ 10000"),
    (lambda sp, m: sp["audio"][0].update(fade_out_ms="1s"), "fade_out_ms must be a number"),
    (lambda sp, m: sp["audio"][0].update(duck_under_voice="yes"), "duck_under_voice"),
    (lambda sp, m: sp["audio"][0].update(sidechain=True), "unknown key"),
    (lambda sp, m: sp.update(captions={"enabled": True, "style": "comic"}), "captions.style"),
    (lambda sp, m: sp.update(captions={"enabled": True, "position": "top"}), "captions.position"),
    (lambda sp, m: sp.update(captions={"enabled": True, "max_words_per_line": 0}), "max_words_per_line"),
    (lambda sp, m: sp.update(captions={"enabled": True, "max_words_per_line": 4.5}), "max_words_per_line"),
    (lambda sp, m: sp.update(captions={"enabled": 1}), "captions.enabled"),
    (lambda sp, m: sp.update(captions={"enabled": True, "font": "x"}), "unknown key"),
    (lambda sp, m: sp.update(captions=[]), "captions must be an object"),
    (lambda sp, m: [c.update(transcript=None) for c in sp["clips"]], "no clip has a transcript"),
    (lambda sp, m: sp.update(color={"preset": "sepia", "strength": 0.5}), "color.preset"),
    (lambda sp, m: sp.update(color={"preset": "warm", "strength": 1.5}), "strength must be ≤ 1"),
    (lambda sp, m: sp.update(color={"preset": "warm", "lut": "x"}), "unknown key"),
])
def test_v2_validation(s, media, mutate, match):
    spec = v2_spec(media)
    mutate(spec, media)
    with pytest.raises(PolicyError, match=match):
        timeline.load_spec(s, write_spec(s, "bad", spec))


# ── filter graph ───────────────────────────────────────────────────────────────

def test_v2_graph(s, media):
    plan = timeline.load_spec(s, write_spec(s, "graph", v2_spec(media)))
    inputs, g = timeline._graph_v2(plan, True, "amix", "captions.ass")
    # clip 2 punches in (centre crop before the letterbox scale)
    assert "[1:v]trim=start=0.5:end=3.5,setpts=PTS-STARTPTS,crop=trunc(iw/1.2/2)*2:trunc(ih/1.2/2)*2,scale=" in g
    # clip 1 rises from black (whole 0.4 s on the first clip); clip 2 dips to black before the image
    assert "fade=t=in:st=0:d=0.400" in g and "fade=t=out:st=2.700:d=0.300" in g
    # clip 1 → 2 is a crossfade: offset = clip 1 length − overlap
    assert "[vr0][vr1]xfade=transition=fade:duration=0.500:offset=2.900[vx1]" in g
    assert "[ar0][ar1]acrossfade=d=0.500" in g
    # clip 2 + image are one concat run (a cut with a dip to black)
    assert "[v1][a1][v2][a2]concat=n=2:v=1:a=1[vr1][ar1]" in g
    # colour before captions, then the final format
    assert "colorbalance=rs=0.056" in g and g.index("colorbalance") < g.index("ass=captions.ass")
    assert "ass=captions.ass,format=yuv420p[vcat]" in g
    # music: faded, delayed, padded to the bus and ducked under the clip audio
    assert "asplit=2[acat][sc0]" in g
    assert "afade=t=in:st=0:d=0.800" in g and "afade=t=out:st=6.700:d=1.200" in g
    assert f"apad,atrim=end={plan['total_duration']:.3f}[lp0]" in g
    assert "[lp0][sc0]sidechaincompress=" in g
    assert "[acat][l0]amix=inputs=2:duration=first:normalize=0[amix]" in g
    assert inputs.count("-i") == 5  # slate, take, png, music, the image's silence
    # audio-only pass (loudness): no picture, no images, no captions
    a_inputs, ag = timeline._graph_v2(plan, False, "aout")
    assert "xfade" not in ag and "ass=" not in ag and "[v" not in ag
    assert "acrossfade" in ag and ag.endswith("[aout]")
    assert str(media["png"]) not in a_inputs


def test_v2_graph_no_layers_no_look(s, media):
    spec = v2_spec(media, audio=[], color={"preset": "none", "strength": 1},
                   captions={"enabled": False, "style": "clean", "position": "lower", "max_words_per_line": 5})
    plan = timeline.load_spec(s, write_spec(s, "plain", spec))
    _, g = timeline._graph_v2(plan, True, "amix")
    assert g.endswith("[ax1]anull[amix]") and "ass=" not in g and "colorbalance" not in g
    assert "[vx1]format=yuv420p[vcat]" in g


def test_v1_path_unchanged(s, media):
    """A v1 spec plans exactly as before (no v2 keys) and renders through the v1 `_graph`."""
    spec = v2_spec(media, version=1, captions=None, color=None)
    spec.pop("captions"), spec.pop("color")
    for c in spec["clips"]:
        for k in ("transition_in", "punch_in", "transcript"):
            c.pop(k)
    for k in ("fade_in_ms", "fade_out_ms", "duck_under_voice"):
        spec["audio"][0].pop(k)
    plan = timeline.load_spec(s, write_spec(s, "v1", spec))
    assert "version" not in plan and "captions" not in plan
    assert set(plan["clips"][0]) == {"index", "path", "kind", "in", "out", "duration", "fade_s", "has_audio"}
    assert set(plan["audio"][0]) == {"index", "path", "start", "in", "out", "volume"}
    _, g = timeline._graph(plan, True, "amix")
    assert "xfade" not in g and "settb" not in g
    assert g.endswith("amix=inputs=2:duration=first:normalize=0[amix]")


@pytest.mark.parametrize("preset", ["warm", "cool", "punchy", "film", "bw"])
def test_color_filters(s, preset):
    f = timeline.color_filter({"preset": preset, "strength": 1.0})
    assert f and f == timeline.color_filter({"preset": preset, "strength": 1})
    assert timeline.color_filter({"preset": preset, "strength": 0}) is None
    if preset == "bw":
        assert "hue=s=0.000" in f
    if preset == "film":
        assert f.startswith("curves=all='0/0.060 0.5/0.5 1/0.950'")
    # every look is a valid ffmpeg filter chain
    r = ff.run([s.ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                "testsrc=size=160x90:rate=5:duration=0.4", "-vf", f, "-f", "null", "-"], 60)
    assert r.returncode == 0, r.stderr


# ── captions ───────────────────────────────────────────────────────────────────

def test_caption_retiming_and_lines(s, media):
    words = captions.load_words(media["slate_js"])
    assert words[0] == {"w": "Hello", "s": 1.0, "e": 1.3, "seg": 0}
    # slate trimmed 0.8–4.2 and placed at 10 s: "cut off" (4.5 s) is outside the trim
    placed = captions.place_words(words, 0.8, 4.2, 10.0, 3.4)
    assert [w["w"] for w in placed][-1] == "{line}" and len(placed) == 8
    assert placed[0]["s"] == pytest.approx(10.2) and placed[0]["e"] == pytest.approx(10.5)
    lines = captions.group_lines(placed, 3)
    # "Hello there, this" | "is a test." (sentence end) | "Second {line}" (new segment)
    assert [" ".join(w["w"] for w in ln) for ln in lines] == ["Hello there, this", "is a test.", "Second {line}"]
    ass = captions.build_ass(lines, "karaoke", "middle", 1080, 1920, 20.0)
    assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass
    assert ",5,64,64,0,1" in ass  # Alignment 5 (middle), no vertical margin
    dialogue = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]
    assert len(dialogue) == 3
    assert dialogue[0].startswith("Dialogue: 0,0:00:10.20,0:00:11.")
    assert "{\\kf30}Hello" in dialogue[0]
    assert "(line)" in dialogue[2] and "{line}" not in dialogue[2]  # braces can't inject ASS tags


def test_timeline_ass_uses_output_time(s, media):
    plan = timeline.load_spec(s, write_spec(s, "ass", v2_spec(media)))
    text, n = captions.timeline_ass(plan)
    starts = [ln.split(",")[1] for ln in text.splitlines() if ln.startswith("Dialogue:")]
    assert n == len(starts) >= 4
    # slate's first word (1.0 s source, in 0.8) lands at 0.2 s; take's first word (0.9 s source, in 0.5)
    # lands at its clip start 2.9 + 0.4 = 3.3 s
    assert starts[0] == "0:00:00.20" and "0:00:03.30" in starts
    assert "\\fscx82" in text and "HELLO" in text  # bold_pop


# ── real render ────────────────────────────────────────────────────────────────

def test_render_v2(s, jobs, media):
    spec_path = write_spec(s, "v2cut", v2_spec(media))
    plan = timeline.load_spec(s, spec_path)
    out = config.writable(s, str(config.project_dir(s, SLUG) / "renders" / "v2cut_v001.mp4"))
    res = wait(jobs, jobs.start("timeline", "t", lambda ctx: timeline.render(s, ctx, plan, out, spec_path)))
    assert res["verify"]["ok"], res["verify"]
    assert res["spec_version"] == 2 and res["crossfades"] == 1 and res["ducked_layers"] == 1
    assert res["duration_sec"] == pytest.approx(7.9, abs=0.25)
    probe = ff.probe(s, out)
    assert probe["duration_sec"] == pytest.approx(7.9, abs=0.25)
    assert (probe["video"]["width"], probe["video"]["height"]) == (1280, 720)
    assert abs(res["loudness_measured"] - (-16)) <= 1.5
    cap = res["captions"]
    assert cap["enabled"] and cap["lines"] >= 4 and Path(cap["ass_path"]).is_file()
    assert res["color"]["preset"] == "warm" and res["encoder"] == "x264"


def test_render_v2_via_tool(s, media):
    import server

    spec = v2_spec(media, width=640, height=360, loudness_lufs=None, color={"preset": "bw", "strength": 1},
                   captions={"enabled": True, "style": "karaoke", "position": "middle", "max_words_per_line": 2})
    spec["clips"] = spec["clips"][:2]
    view = asyncio.run(server.render_timeline(str(write_spec(s, "v2tool", spec)), wait_s=300))
    assert view["status"] == "done", view
    res = view["result"]
    assert res["verify"]["ok"], res["verify"]
    assert res["duration_sec"] == pytest.approx(3.4 + 3.0 - 0.5, abs=0.25)


# ── whisper: local only, batch ─────────────────────────────────────────────────

def fake_model(root: Path, name: str) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "model.bin").write_bytes(b"x")
    (d / "config.json").write_text("{}", "utf-8")
    return d


def test_resolve_model_local_only(s, tmp_path):
    ss = dataclasses.replace(s, whisper_dir=tmp_path)
    with pytest.raises(PolicyError, match="never downloaded"):
        analyze.resolve_model(ss, "small.en")
    plain = fake_model(tmp_path, "faster-whisper-base.en")
    assert analyze.resolve_model(ss, "base.en") == plain
    assert analyze.resolve_model(ss, str(plain)) == plain
    snap = fake_model(tmp_path / "models--Systran--faster-whisper-tiny.en" / "snapshots", "abc123")
    (tmp_path / "models--Systran--faster-whisper-tiny.en" / "refs").mkdir()
    (tmp_path / "models--Systran--faster-whisper-tiny.en" / "refs" / "main").write_text("abc123", "utf-8")
    assert analyze.resolve_model(ss, "tiny.en") == snap
    # the faster-whisper-<name> folder doesn't exist, but the HF cache beside it does
    assert analyze.resolve_model(ss, str(tmp_path / "faster-whisper-tiny.en")) == snap
    assert analyze.model_label(str(snap)) == "tiny.en"
    for bad in ("..", "a/b", r"..\x"):
        with pytest.raises(PolicyError):
            analyze.resolve_model(ss, bad)
    with pytest.raises(PolicyError, match="no whisper model at"):
        analyze.resolve_model(ss, str(tmp_path / "nothing"))


@pytest.mark.skipif(not TINY.is_dir(), reason="the local tiny.en model is not on this machine")
def test_tiny_en_is_local(s):
    p = analyze.resolve_model(s, "tiny.en")
    assert (p / "model.bin").is_file() and TINY in p.parents
    assert analyze.resolve_model(s, r"C:\ai-hub\models\faster-whisper\faster-whisper-tiny.en") == p


def test_transcribe_batch_sequential(s, jobs, media, monkeypatch, tmp_path):
    calls = []

    def fake(ss, ctx, src, base, model, language, words):
        calls.append((src.name, base.name, model))
        ctx.stage("transcribing", 0.5)
        if src.name == "mute.mp4":
            raise PolicyError("could not decode audio from mute.mp4")
        js = base.with_suffix(".json")
        js.write_text("{}", "utf-8")
        return {"srt": str(base.with_suffix(".srt")), "vtt": "", "json": str(js), "language": "en",
                "segment_count": 1, "first_speech_s": 0.5, "last_speech_s": 1.0, "text": "hi"}

    monkeypatch.setattr(analyze, "transcribe", fake)
    fake_model(tmp_path, "tiny.en")
    ss = dataclasses.replace(s, whisper_dir=tmp_path)
    base = config.project_dir(s, SLUG) / "working" / "captions"
    items = [(media["slate"], base / "a1"), (media["mute"], base / "a2"), (media["take"], base / "a3")]
    res = wait(jobs, jobs.start("transcribe", "b", lambda ctx: analyze.transcribe_batch(
        ss, ctx, items, "tiny.en", None, True)))
    assert [c[0] for c in calls] == ["slate.mp4", "mute.mp4", "take.mp4"]  # in order, one job
    assert (res["count"], res["done"], res["failed"]) == (3, 2, 1)
    assert res["results"][1] == {"path": str(media["mute"]), "ok": False,
                                 "error": "could not decode audio from mute.mp4"}
    assert res["results"][2]["json"].endswith("a3.json")
    with pytest.raises(PolicyError, match="never downloaded"):
        analyze.transcribe_batch(ss, _NullCtx(), items, "huge.en", None, True)


class _NullCtx:
    def __init__(self):
        import threading
        self.cancel = threading.Event()

    def progress(self, *a, **k):
        pass

    def stage(self, *a, **k):
        pass

    def attach(self, *a):
        pass

    def check(self):
        pass


def test_transcribe_batch_tool_checks(s, media, monkeypatch):
    import server

    raws = [str(media["slate"]), str(media["take"])]
    with pytest.raises(ValueError, match="never downloaded"):
        asyncio.run(server.transcribe_batch(raws, project=SLUG, model="huge.en"))
    with pytest.raises(ValueError, match="one entry per path"):
        asyncio.run(server.transcribe_batch(raws, project=SLUG, model="huge.en", output_stems=["a"]))
    with pytest.raises(ValueError, match="1–50"):
        asyncio.run(server.transcribe_batch([], project=SLUG))
    seen = {}
    monkeypatch.setattr(analyze, "resolve_model", lambda ss, m: Path("x"))
    with pytest.raises(ValueError, match="raw/"):  # raw clips need a project for their captions
        asyncio.run(server.transcribe_batch(raws, model="tiny.en"))
    monkeypatch.setattr(analyze, "transcribe_batch",
                        lambda ss, ctx, items, model, lang, words: seen.update(items=items, model=model) or {"ok": 1})
    with pytest.raises(ValueError, match="same caption files"):
        asyncio.run(server.transcribe_batch([raws[0], raws[0]], project=SLUG, model="tiny.en"))
    with pytest.raises(ValueError, match="plain file name"):
        asyncio.run(server.transcribe_batch(raws, project=SLUG, model="tiny.en", output_stems=["a/b", "c"]))
    view = asyncio.run(server.transcribe_batch(raws, project=SLUG, model="tiny.en", output_stems=["as1", "as2"],
                                               wait_s=30))
    assert view["status"] == "done", view
    cap_dir = config.project_dir(s, SLUG) / "working" / "captions"
    assert [b for _, b in seen["items"]] == [cap_dir / "as1", cap_dir / "as2"] and seen["model"] == "tiny.en"
