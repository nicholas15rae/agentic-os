"""Synthetic clips in a throwaway media root. FFmpeg: MEDIA_FFMPEG if set, else PATH, else Shotcut."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(tempfile.mkdtemp(prefix="mf-test-"))
os.environ["MEDIA_ROOT"] = str(ROOT)
os.environ.setdefault("MEDIA_CPU_PCT", "50")
os.environ.pop("MEDIA_ALLOW_GPU", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from media_forge import config  # noqa: E402
from media_forge.jobs import JobManager  # noqa: E402

S = config.load()


def gen(out: Path, *args: str) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([S.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", *args, str(out)], check=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return out


def tone_clip(out: Path, head: float, tone: float, tail: float, size: str = "1280x720",
              pattern: str = "testsrc2", vol: float = 0.3) -> Path:
    total = head + tone + tail
    audio = (f"aevalsrc='if(between(t,{head},{head + tone}),{vol}*sin(2*PI*440*t),0)'"
             f":s=48000:d={total}")
    return gen(out, "-f", "lavfi", "-i", f"{pattern}=size={size}:rate=30:duration={total}",
               "-f", "lavfi", "-i", audio, "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
               "-pix_fmt", "yuv420p", "-c:a", "aac")


@pytest.fixture(scope="session")
def s():
    return S


@pytest.fixture(scope="session")
def jobs():
    return JobManager(S)


@pytest.fixture(scope="session")
def raw():
    d = config.project_dir(S, "test-tape") / "raw"
    return {
        "slate": tone_clip(d / "slate.mp4", 1.0, 3.0, 1.5),
        "take": tone_clip(d / "take.mp4", 0.8, 2.0, 1.0, size="640x360", pattern="smptebars"),
        "mute": gen(d / "mute.mp4", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"),
    }


def wait(jobs: JobManager, job, timeout: float = 300):
    end = time.time() + timeout
    while job.status in ("queued", "running") and time.time() < end:
        time.sleep(0.2)
    assert job.status == "done", f"{job.status}: {job.error}"
    return job.result
