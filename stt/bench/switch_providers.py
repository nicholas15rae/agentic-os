"""Point the desktop app's STT at faster-whisper :8177 (providers.json), keeping the whisper.cpp
provider (the Language Hub sidecars find ggml-small.bin through it; it is also the fallback).

Backs the file up next to itself first (providers.json.<time>-before-faster-whisper), writes
atomically (temp + rename, like the app's own persist), and checks the result the way
dispatch.rs validate() does for these fields. Prints what changed. --dry-run prints only.

  python -I "G:\\agentic os\\stt\\bench\\switch_providers.py" --model large-v3-turbo [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

PATH = Path(os.environ.get("APPDATA", str(Path.home()))) / "os.agentic.commandcenter" / "providers.json"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
REQUIRED = ("id", "label", "kind", "baseUrl", "model", "needsKey")


def entry(model: str) -> dict:
    # Field order = the app's Provider struct (serde), so its next save is a no-op diff.
    return {"id": "faster-whisper", "label": "faster-whisper (GPU)", "kind": "stt", "baseUrl": "http://127.0.0.1:8177/v1", "model": model,
            "needsKey": False, "engine": "fasterwhisper", "language": "en", "custom": True}


def check(cfg: dict) -> None:
    ids = set()
    for p in cfg["providers"]:
        missing = [k for k in REQUIRED if k not in p]
        assert not missing, f"{p.get('id')}: missing {missing}"
        assert ID_RE.match(p["id"]), f"bad id {p['id']}"
        assert re.match(r"^https?://", p["baseUrl"]), f"{p['id']}: baseUrl must be http(s)"
        assert p["id"] not in ids, f"duplicate id {p['id']}"
        ids.add(p["id"])
    kinds = {p["id"]: p["kind"] for p in cfg["providers"]}
    assert kinds.get(cfg["policy"]["stt"]) == "stt", "policy.stt must name an STT provider"
    assert any(p.get("engine") == "whispercpp" and p.get("modelsDir") for p in cfg["providers"] if p["kind"] == "stt"), "the whisper.cpp provider must stay"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    raw = PATH.read_text(encoding="utf-8")
    cfg = json.loads(raw)
    before = cfg["policy"].get("stt")
    provs = [p for p in cfg["providers"] if p.get("id") != "faster-whisper"]
    # Right after the whisper.cpp provider, so Settings lists the two STT engines together.
    at = next((i + 1 for i, p in enumerate(provs) if p.get("kind") == "stt"), len(provs))
    provs.insert(at, entry(a.model))
    cfg["providers"] = provs
    cfg["policy"]["stt"] = "faster-whisper"
    check(cfg)
    print(json.dumps({"policy.stt": [before, "faster-whisper"], "added": entry(a.model)}, indent=1))
    if a.dry_run:
        return
    backup = PATH.with_name(f"providers.json.{time.strftime('%Y%m%d-%H%M%S')}-before-faster-whisper")
    shutil.copy2(PATH, backup)
    tmp = PATH.with_name("providers.json.tmp-stt")
    tmp.write_bytes(json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8"))  # LF, like serde_json's own save
    os.replace(tmp, PATH)
    check(json.loads(PATH.read_text(encoding="utf-8")))
    print(f"backup: {backup}", file=sys.stderr)


if __name__ == "__main__":
    main()
