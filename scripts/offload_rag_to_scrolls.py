#!/usr/bin/env python3
"""Offload the existing RAG store into Memory Scrolls.

    python scripts/offload_rag_to_scrolls.py                       # --dry-run (default): preview + token
    python scripts/offload_rag_to_scrolls.py --apply --confirm TOK  # live cutover (Nic only)

The dry-run only issues GET requests to AnythingLLM (never the Booking workspaces) and writes only
under staging/memory-scrolls-preview/. `--apply` archives a verified snapshot first and removes
nothing if any earlier step fails.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_scrolls.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["offload", *sys.argv[1:]]))
