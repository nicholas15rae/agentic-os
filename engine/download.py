"""Resumable single-file model downloads from Hugging Face (Section 26 item 19), and recoverable
deletes.

  download(repo, filename, dest_root)   https://huggingface.co/<repo>/resolve/<revision>/<filename>
      → <dest_root>/<owner>/<name>/<filename>. A `.part` file resumes with an HTTP Range request.
      The sha256 Hugging Face publishes for LFS files (X-Linked-Etag) is checked when present; a
      mismatch keeps the file as `.bad` and raises. Only `.gguf` files; repo and file names are
      validated (no path escapes); the destination must be inside a library root; a pre-flight
      refuses when the drive would drop under MIN_FREE_GB free.
  trash(path, loaded)                   sends a model file to the Windows Recycle Bin (recoverable),
      never the model the engine has loaded, only inside a library root. The caller (the model
      screen) must pass confirm == the file name: a typed confirmation.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Iterable, Optional

HF = "https://huggingface.co"
MIN_FREE_GB = 20
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ +-]{0,200}\.gguf$")
REV_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class DownloadRefused(ValueError):
    pass


def _inside(p: Path, roots: Iterable[str]) -> bool:
    rp = os.path.normcase(os.path.realpath(p))
    for r in roots:
        rr = os.path.normcase(os.path.realpath(r))
        if rp == rr or rp.startswith(rr.rstrip("\\/") + os.sep):
            return True
    return False


def plan(repo: str, filename: str, dest_root: str, roots: Iterable[str], revision: str = "main") -> dict:
    if not REPO_RE.match(repo or "") or ".." in repo:
        raise DownloadRefused(f"not a Hugging Face repo id: {repo!r}")
    if not FILE_RE.match(filename or "") or ".." in filename:
        raise DownloadRefused(f"only a single .gguf file name (no folders): {filename!r}")
    if not REV_RE.match(revision or ""):
        raise DownloadRefused(f"bad revision {revision!r}")
    roots = list(roots)
    if not _inside(Path(dest_root), roots):
        raise DownloadRefused(f"{dest_root} is not one of the model library roots")
    dest = Path(dest_root) / repo.split("/")[0] / repo.split("/")[1] / filename
    url = f"{HF}/{urllib.parse.quote(repo)}/resolve/{urllib.parse.quote(revision)}/{urllib.parse.quote(filename)}"
    return {"url": url, "dest": str(dest)}


def head(url: str, opener=urllib.request.urlopen) -> dict:
    """Size and sha256 (LFS) of a Hugging Face file, following its redirect."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "agentic-os-engine"})
    with opener(req, timeout=30) as r:
        h = {k.lower(): v for k, v in r.headers.items()}
    etag = (h.get("x-linked-etag") or h.get("etag") or "").strip('"').replace("W/", "").strip('"')
    size = h.get("x-linked-size") or h.get("content-length")
    return {"size": int(size) if size and str(size).isdigit() else None,
            "sha256": etag if re.fullmatch(r"[0-9a-f]{64}", etag or "") else None}


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def download(repo: str, filename: str, dest_root: str, roots: Iterable[str], revision: str = "main", *,
             opener=urllib.request.urlopen, free_bytes: Callable[[str], int] = lambda p: shutil.disk_usage(p).free,
             progress: Optional[Callable[[int, Optional[int]], None]] = None) -> dict:
    pl = plan(repo, filename, dest_root, roots, revision)
    dest = Path(pl["dest"])
    if dest.exists():
        return {"status": "exists", "path": str(dest), "bytes": dest.stat().st_size}
    info = head(pl["url"], opener)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    need = (info["size"] or 0) - have
    Path(dest_root).mkdir(parents=True, exist_ok=True)
    if free_bytes(dest_root) - need < MIN_FREE_GB * (1 << 30):
        raise DownloadRefused(f"would leave less than {MIN_FREE_GB} GB free on {dest_root}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(pl["url"], headers={"User-Agent": "agentic-os-engine"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    with opener(req, timeout=60) as r:
        if have and getattr(r, "status", 200) != 206:
            have = 0
        with part.open("ab" if have else "wb") as f:
            done = have
            while True:
                b = r.read(1 << 22)
                if not b:
                    break
                f.write(b)
                done += len(b)
                if progress:
                    progress(done, info["size"])
    if info["size"] and part.stat().st_size != info["size"]:
        return {"status": "partial", "path": str(part), "bytes": part.stat().st_size, "size": info["size"]}
    if info["sha256"]:
        got = _sha(part)
        if got != info["sha256"]:
            bad = part.with_name(dest.name + ".bad")
            part.replace(bad)
            raise DownloadRefused(f"sha256 mismatch ({got} != {info['sha256']}); kept as {bad.name}")
    part.replace(dest)
    return {"status": "done", "path": str(dest), "bytes": dest.stat().st_size, "sha256": info["sha256"]}


def _recycle(path: Path) -> None:
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; "
          "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:CC_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], env={**os.environ, "CC_TRASH_PATH": str(path)},
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or path.exists():
        raise OSError(f"could not move to the Recycle Bin: {r.stderr.strip()[:200]}")


def trash(path: str, confirm: str, roots: Iterable[str], loaded: Iterable[str] = (),
          recycle: Callable[[Path], None] = _recycle) -> dict:
    p = Path(path)
    if confirm != p.name:
        raise DownloadRefused("type the file name to confirm the delete")
    if p.suffix.lower() != ".gguf" or not p.is_file():
        raise DownloadRefused(f"not a model file: {path}")
    if not _inside(p, roots):
        raise DownloadRefused(f"{path} is not inside a model library root")
    for lp in loaded:
        try:
            if lp and os.path.samefile(lp, p):
                raise DownloadRefused("that model is loaded in the engine; unload it first")
        except OSError:
            continue
    size = p.stat().st_size
    recycle(p)
    return {"status": "recycled", "path": str(p), "bytes": size}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="download one GGUF from Hugging Face (resumable)")
    ap.add_argument("repo")
    ap.add_argument("filename")
    ap.add_argument("dest_root")
    ap.add_argument("--revision", default="main")
    a = ap.parse_args()
    from engine.models import library_roots
    print(json.dumps(download(a.repo, a.filename, a.dest_root, library_roots(), a.revision,
                              progress=lambda d, t: print(f"\r{d >> 20} / {(t or 0) >> 20} MiB", end="")), indent=2))
