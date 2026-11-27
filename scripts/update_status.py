"""Refresh the git-derived block of STATUS.md.

Run from any worktree after a commit or merge:  python scripts/update_status.py
Only rewrites the text between the AUTO markers in that worktree's STATUS.md;
the hand-written sections (done, in progress, waiting on you, not started,
tests) are left alone. Branch data comes from the shared repo, so the table
is the same whichever worktree runs it. On a STATUS.md merge conflict, keep
the newer hand-written lines and re-run this script.
"""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BEGIN = "<!-- AUTO:BRANCHES (scripts/update_status.py rewrites this block) -->"
END = "<!-- /AUTO:BRANCHES -->"


def git(*args: str, cwd: Path) -> str:
    out = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    return out.stdout.strip() if out.returncode == 0 else ""


def worktrees(root: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    path = None
    for line in git("worktree", "list", "--porcelain", cwd=root).splitlines():
        if line.startswith("worktree "):
            path = Path(line[len("worktree "):])
        elif line.startswith("branch refs/heads/") and path:
            found[line[len("branch refs/heads/"):]] = path
    return found


def build_block(root: Path) -> str:
    wts = worktrees(root)
    rows = []
    for ref in git("for-each-ref", "--sort=-committerdate",
                   "--format=%(refname:short)", "refs/heads", cwd=root).splitlines():
        if ref == "main":
            continue
        if subprocess.run(["git", "merge-base", "--is-ancestor", ref, "main"],
                          cwd=root, capture_output=True).returncode == 0:
            continue  # fully merged: nothing to track
        ahead = git("rev-list", "--count", f"main..{ref}", cwd=root)
        last = git("log", "-1", "--format=%h|%cs|%s", ref, cwd=root).split("|", 2)
        wt = wts.get(ref)
        dirty = ""
        if wt and wt.exists():
            n = len([l for l in git("status", "--porcelain", cwd=wt).splitlines() if l])
            dirty = f"{n} files" if n else "clean"
        subject = last[2] if len(last) > 2 else ""
        if len(subject) > 70:
            subject = subject[:67] + "..."
        rows.append(f"| `{ref}` | {ahead} | `{last[0]}` {last[1]} {subject} | {dirty or 'no worktree'} |")

    merges = git("log", "--first-parent", "-6", "--format=- `%h` %cs %s", "main", cwd=root)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        BEGIN,
        f"_Refreshed {stamp} by `python scripts/update_status.py`._",
        "",
        "**Not merged into main yet**",
        "",
        "| Branch | Commits ahead | Last commit | Uncommitted |",
        "|---|---|---|---|",
        *(rows or ["| (none) | | | |"]),
        "",
        "**Latest on main**",
        "",
        merges,
        END,
    ]
    return "\n".join(lines)


def main() -> int:
    top = git("rev-parse", "--show-toplevel", cwd=Path.cwd())
    if not top:
        return 0
    root = Path(top)
    status = root / "STATUS.md"
    if not status.exists():
        return 0
    text = status.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        return 0
    head, rest = text.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    new = head + build_block(root) + tail
    if new != text:
        tmp = status.with_suffix(".md.tmp")
        tmp.write_text(new, encoding="utf-8")
        os.replace(tmp, status)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"update_status: {exc}", file=sys.stderr)
        sys.exit(1)
