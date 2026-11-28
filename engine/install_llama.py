"""Install the pinned official llama.cpp CUDA build into D:\\llama.cpp\\<version> (Section 26, Nic's pick).

Not LM Studio's bundled backends: LM Studio updates and deletes those, so the engine could change
under Tony. This build only changes when PINNED below changes.

    python -m engine.install_llama            # download (resumable), verify sha256, unpack
    python -m engine.install_llama --check    # just say whether it is installed

Each zip is downloaded into its own empty folder (D:\\llama.cpp\\_downloads\\<version>), checked against
the sha256 GitHub publishes for the release, then unpacked into D:\\llama.cpp\\<version>. Nothing is
deleted: a finished download is kept (so a re-run is instant), and an existing install is left alone.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
import zipfile
from pathlib import Path

VERSION = "b12317"  # published 2026-11-12
BASE = f"https://github.com/ggml-org/llama.cpp/releases/download/{VERSION}/"
PINNED = {
    f"llama-{VERSION}-bin-win-cuda-12.4-x64.zip": "b6678853912e0cd1ac5adb2258db6b021c1833c4d139001fa1bb3ed7481745ea",
    "cudart-llama-bin-win-cuda-12.4-x64.zip": "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
}
ROOT = Path(r"D:\llama.cpp")


def install_dir(root: Path = ROOT, version: str = VERSION) -> Path:
    return root / version


def server_exe(root: Path = ROOT, version: str = VERSION) -> Path:
    return install_dir(root, version) / "llama-server.exe"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, opener=urllib.request.urlopen) -> None:
    """Resumable: a `.part` file continues with an HTTP Range request."""
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={"User-Agent": "agentic-os-engine-installer"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    with opener(req, timeout=60) as r:
        if have and getattr(r, "status", 200) != 206:  # server ignored the range: start over
            have = 0
        with part.open("ab" if have else "wb") as f:
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
    part.replace(dest)


def install(root: Path = ROOT, log=print) -> Path:
    target = install_dir(root)
    if server_exe(root).exists():
        log(f"already installed: {server_exe(root)}")
        return target
    dl = root / "_downloads" / VERSION
    dl.mkdir(parents=True, exist_ok=True)
    for name, digest in PINNED.items():
        z = dl / name
        if not (z.exists() and sha256(z) == digest):
            log(f"downloading {name} ...")
            download(BASE + name, z)
        got = sha256(z)
        if got != digest:
            raise RuntimeError(f"{name}: sha256 {got} != pinned {digest}; not unpacking")
        log(f"verified {name}")
    target.mkdir(parents=True, exist_ok=True)
    for name in PINNED:
        with zipfile.ZipFile(dl / name) as zf:
            for m in zf.namelist():  # no path escapes
                if m.startswith(("/", "\\")) or ".." in Path(m).parts:
                    raise RuntimeError(f"{name}: unsafe path {m!r}")
            zf.extractall(target)
    if not server_exe(root).exists():
        # some releases nest everything one folder down
        nested = next(target.rglob("llama-server.exe"), None)
        raise RuntimeError(f"llama-server.exe not at {server_exe(root)} (found {nested})")
    log(f"installed {server_exe(root)}")
    return target


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    if a.check:
        ok = server_exe().exists()
        print(f"{'installed' if ok else 'missing'}: {server_exe()}")
        return 0 if ok else 1
    install()
    return 0


if __name__ == "__main__":
    sys.exit(main())
