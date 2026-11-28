"""Document ingest into the engine's doc store (Section 26, inventory A7), replacing AnythingLLM's:

  ingest_note(actor, title, text)  documenter.rs `check_ingest` rules: ONLY Tony writes (other agents
                                   read), a title, non-empty text, at most 256 KB. Re-ingesting the
                                   same title updates it (sha256 change detection in the doc store).
  sync_scrolls(root)               memory_scrolls' Tier 2 (the layer AnythingLLM embedded): every
                                   .md under the scrolls root, re-indexed on change, vanished files
                                   dropped from the store (never from disk). Source "scrolls".

Both go through the doc store (engine/docstore.py) and its CPU nomic embedder; neither touches the
gateway vault (joining the two is Nic's call).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

NOTE_MAX = 256 * 1024  # documenter.rs INGEST_MAX = NOTE_MAX
TITLE_MAX = 120        # documenter.rs INGEST_TITLE_MAX
WRITERS = {"tony", "general"}  # RolePolicy.allm == Write: Tony only
NOTES_SOURCE = "notes"
SCROLLS_SOURCE = "scrolls"


class IngestRefused(ValueError):
    pass


def check_note(actor: str, title: str, text: str) -> None:
    if (actor or "").strip().lower() not in WRITERS:
        raise IngestRefused(f"{actor} may not write to the doc store (only Tony's documenter indexes notes)")
    if not title.strip():
        raise IngestRefused("an indexed note needs a title")
    if not text.strip():
        raise IngestRefused("nothing to index")
    if len(text.encode("utf-8")) > NOTE_MAX:
        raise IngestRefused(f"note is over {NOTE_MAX // 1024} KB")


def ingest_note(actor: str, title: str, text: str, store=None) -> str:
    check_note(actor, title, text)
    from engine.docstore import DocStore
    store = store or DocStore()
    t = title.strip()[:TITLE_MAX]
    return store.add_text(NOTES_SOURCE, t, text, title=t, meta={"by": "tony"})


def scrolls_root() -> Path:
    from memory_scrolls import config
    return Path(config.resolve().scrolls_root)


def sync_scrolls(root: Optional[Path] = None, store=None) -> dict:
    from engine.docstore import DocStore
    store = store or DocStore()
    root = Path(root) if root else scrolls_root()
    if not root.is_dir():
        raise IngestRefused(f"no scrolls folder at {root}")
    return store.index_folder(root, source=SCROLLS_SOURCE, exts={".md"})


def main(argv=None) -> int:
    import argparse
    import json
    ap = argparse.ArgumentParser(description="doc store ingest (notes, memory scrolls)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scrolls")
    n = sub.add_parser("note")
    n.add_argument("title")
    n.add_argument("file")
    a = ap.parse_args(argv)
    if a.cmd == "scrolls":
        print(json.dumps(sync_scrolls(), indent=2))
    else:
        print(ingest_note("tony", a.title, Path(a.file).read_text(encoding="utf-8")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
