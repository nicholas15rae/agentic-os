"""The only scroll writer. Called by the host orchestrator (`compact.py`, `offload.py --apply`) only.

Before replacing a scroll its previous file is copied to `<state>/scroll-history/<id>/v<n>.md`
(last 5 kept) so any version can be rolled back; the cold archive stays the real source of truth.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from . import fsutil
from .scroll import Scroll, check_matches, parse, render, resolve_in_root, target_info

HISTORY_KEEP = 5


def _prune_history(d: Path) -> None:
    versions = []
    for p in d.glob("v*.md"):
        m = re.fullmatch(r"v(\d+)\.md", p.name)
        if m:
            versions.append((int(m.group(1)), p))
    versions.sort()
    for _, p in versions[:-HISTORY_KEEP]:
        try:
            os.remove(p)
        except OSError:
            pass


def write_scroll(root: Path, rel: str, scroll: Scroll, history_dir: Path) -> Path:
    """Atomically write `scroll` at `rel` under `root`, keeping the previous version in history."""
    fsutil.refuse_protected(root, "scrolls root")
    fsutil.refuse_protected(history_dir, "scroll history dir")
    t = target_info(rel)
    check_matches(t, scroll)
    path = resolve_in_root(root, rel)
    fsutil.refuse_protected(path, "scroll file")
    text = render(scroll)
    parse(text)  # the renderer is canonical; never write something the parser would reject
    if path.is_file():
        try:
            prev = path.read_bytes()
            prev_s = parse(prev.decode("utf-8"))
            hdir = Path(history_dir) / t.scroll_id
            fsutil.atomic_write(hdir / f"v{prev_s.version}.md", prev)
            _prune_history(hdir)
        except Exception:
            # An unreadable previous file is still kept, under a neutral name.
            hdir = Path(history_dir) / t.scroll_id
            fsutil.atomic_write(hdir / "v0.md", path.read_bytes())
    fsutil.atomic_write(path, text.encode("utf-8"))
    return path
