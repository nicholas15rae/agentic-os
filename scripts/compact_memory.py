#!/usr/bin/env python3
"""`compact-memory`: archive Tier-1 history, distill it into Memory Scrolls, sync changed scrolls.

    python scripts/compact_memory.py --dry-run     # report only, writes nothing
    python scripts/compact_memory.py               # needs LM Studio idle with a chat model loaded
    python scripts/compact_memory.py --json        # NDJSON phases + result (used by the desktop app)

Exit codes: 0 ok, 75 deferred, 2 config error, 1 unexpected.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_scrolls.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["compact", *sys.argv[1:]]))
