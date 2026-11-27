"""Repoint the app's and Claude's config files from the old C:/D: homes to G: (2026-11-23 move).

Run by move-to-g.ps1 while the Command Center and Claude are closed (both rewrite their own
config files, so an edit made while they run can be overwritten). Every file is backed up next
to itself first, written atomically, and only string VALUES are changed. Prints what changed,
never the values themselves (claude_desktop_config.json holds an API key).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

STAMP = time.strftime("%Y%m%d-%H%M%S")
RULES = [
    (re.compile(r"(?i)\bC:([\\/]+)ai-hub(?![\w-])"), r"G:\1ai-hub"),
    (re.compile(r"(?i)\bD:([\\/]+)ai-hub-memory(?![\w-])"), r"G:\1ai-hub-memory"),
    (re.compile(r"(?i)\bC:([\\/]+)whisper(?![\w-])"), r"G:\1whisper"),
]
APPDATA = Path(os.environ["APPDATA"])
LOCAL = Path(os.environ["LOCALAPPDATA"])
TARGETS = [
    APPDATA / "os.agentic.commandcenter" / "os.json",
    APPDATA / "os.agentic.commandcenter" / "providers.json",
    *sorted((LOCAL / "Claude-Data").glob("claude_*/claude_desktop_config.json")),
]
KG = r"G:\ai-hub-memory\knowledge-graph.json"


def rewrite(v, hits: list, where: str):
    if isinstance(v, str):
        new = v
        for rx, rep in RULES:
            new = rx.sub(rep, new)
        if new != v:
            hits.append(where)
        return new
    if isinstance(v, list):
        return [rewrite(x, hits, f"{where}[{i}]") for i, x in enumerate(v)]
    if isinstance(v, dict):
        return {k: rewrite(x, hits, f"{where}.{k}") for k, x in v.items()}
    return v


def main() -> int:
    bad = 0
    for path in TARGETS:
        if not path.exists():
            print(f"skip (not found): {path}")
            continue
        text = path.read_text(encoding="utf-8-sig")
        data = json.loads(text)
        hits: list = []
        out = rewrite(data, hits, "$")
        # Claude's knowledge-graph tool pointed at a file that never existed; share the app's graph.
        kg = (out.get("mcpServers") or {}).get("knowledge-graph") if isinstance(out, dict) else None
        if isinstance(kg, dict) and isinstance(kg.get("env"), dict) and kg["env"].get("MEMORY_FILE_PATH") != KG:
            kg["env"]["MEMORY_FILE_PATH"] = KG
            hits.append("$.mcpServers.knowledge-graph.env.MEMORY_FILE_PATH")
        if not hits:
            print(f"unchanged: {path}")
            continue
        backup = path.with_name(f"{path.name}.bak-{STAMP}-move-to-g")
        shutil.copy2(path, backup)
        tmp = path.with_name(path.name + ".tmp-move-to-g")
        tmp.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        json.loads(tmp.read_text(encoding="utf-8"))  # never replace a file with broken JSON
        os.replace(tmp, path)
        print(f"updated {len(hits)} value(s): {path}")
        for h in hits:
            print(f"    {h}")
        print(f"    backup: {backup.name}")
        left = [rx.pattern for rx, _ in RULES if rx.search(path.read_text(encoding="utf-8"))]
        if left:
            bad += 1
            print(f"    STILL HAS old paths: {left}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
