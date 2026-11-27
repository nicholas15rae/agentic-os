"""Paths, binaries and the write policy.

Every path a tool touches must sit under MEDIA_ROOT. Nothing is ever written into a
`raw` folder: originals are read-only to this server (non-destructive first).
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

SHOTCUT_DIR = Path(os.environ.get("SHOTCUT_DIR", r"C:\Program Files\Shotcut"))
PROJECT_SUBDIRS = ("raw", "working", "renders")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


class PolicyError(ValueError):
    """A path or argument the server refuses. The message is shown to the agent."""


@dataclass(frozen=True)
class Settings:
    media_root: Path
    ffmpeg: str
    ffprobe: str
    cpu_pct: int
    allow_gpu: bool
    max_jobs: int
    whisper_model: str
    whisper_device: str
    whisper_compute: str
    whisper_dir: Path

    @property
    def threads(self) -> int:
        cores = os.cpu_count() or 4
        return max(1, (cores * self.cpu_pct) // 100)

    @property
    def state_dir(self) -> Path:
        return self.media_root / ".media-forge"


def _which(env: str, name: str) -> str:
    """Env override, then PATH, then Shotcut's bundled copy."""
    explicit = os.environ.get(env, "").strip()
    if explicit:
        if not Path(explicit).is_file():
            raise PolicyError(f"{env} points at a missing file: {explicit}")
        return explicit
    found = shutil.which(name)
    if found:
        return found
    bundled = SHOTCUT_DIR / f"{name}.exe"
    if bundled.is_file():
        return str(bundled)
    raise PolicyError(f"{name} not found: set {env}, put it on PATH, or install Shotcut")


def load() -> Settings:
    root = Path(os.environ.get("MEDIA_ROOT", r"G:\ai-hub\media")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    pct = int(os.environ.get("MEDIA_CPU_PCT", "70"))
    return Settings(
        media_root=root,
        ffmpeg=_which("MEDIA_FFMPEG", "ffmpeg"),
        ffprobe=_which("MEDIA_FFPROBE", "ffprobe"),
        cpu_pct=min(100, max(10, pct)),
        allow_gpu=os.environ.get("MEDIA_ALLOW_GPU", "0") == "1",
        max_jobs=min(4, max(1, int(os.environ.get("MEDIA_MAX_JOBS", "1")))),
        whisper_model=os.environ.get("WHISPER_MODEL", "tiny.en"),  # the model already on disk; small.en is opt-in
        whisper_device=os.environ.get("WHISPER_DEVICE", "cpu"),
        whisper_compute=os.environ.get("WHISPER_COMPUTE", "int8"),
        whisper_dir=Path(os.environ.get("WHISPER_MODEL_DIR", r"C:\ai-hub\models\faster-whisper")),
    )


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def readable(s: Settings, p: str) -> Path:
    """An existing file under MEDIA_ROOT."""
    if not p:
        raise PolicyError("a path is required")
    path = Path(p)
    if not path.is_absolute():
        raise PolicyError(f"use an absolute path: {p}")
    path = path.resolve()
    if not _inside(path, s.media_root):
        raise PolicyError(f"outside the media root ({s.media_root}): {path}")
    if not path.is_file():
        raise PolicyError(f"no such file: {path}")
    return path


def writable(s: Settings, p: str, *, overwrite: bool = False) -> Path:
    """A new output path under MEDIA_ROOT, never inside a raw/ folder."""
    path = Path(p)
    if not path.is_absolute():
        raise PolicyError(f"use an absolute path: {p}")
    path = path.resolve()
    if not _inside(path, s.media_root):
        raise PolicyError(f"outside the media root ({s.media_root}): {path}")
    rel = path.relative_to(s.media_root).parts
    if any(part.lower() == "raw" for part in rel[:-1]):
        raise PolicyError("raw/ is read-only: originals are never written or overwritten")
    if rel and rel[0] == ".media-forge":
        raise PolicyError("that folder is the server's own state")
    if path.exists() and not overwrite:
        raise PolicyError(f"already exists (pick a new name or version): {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def project_dir(s: Settings, slug: str) -> Path:
    """`<media_root>/projects/<slug>/{raw,working,renders}`, created on demand."""
    if not SLUG_RE.match(slug or ""):
        raise PolicyError("project slug must be a-z, 0-9 and dashes, up to 48 chars")
    base = s.media_root / "projects" / slug
    for sub in PROJECT_SUBDIRS:
        (base / sub).mkdir(parents=True, exist_ok=True)
    return base


def next_version(folder: Path, stem: str, ext: str) -> Path:
    """`<stem>_v001.mp4`, `<stem>_v002.mp4`, … — never overwrites an earlier render."""
    folder.mkdir(parents=True, exist_ok=True)
    n = 1
    while (folder / f"{stem}_v{n:03d}{ext}").exists():
        n += 1
    return folder / f"{stem}_v{n:03d}{ext}"
