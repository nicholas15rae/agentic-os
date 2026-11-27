"""Agentic OS tiered memory ("Memory Scrolls"), Phase 3.

Tier 1 (hot): live threads, TaskEnvelopes, staging build output, Tony's notes. Read-only here.
Tier 2 (warm): compact Markdown scrolls under the scrolls root, the only layer embedded in AnythingLLM.
Tier 3 (cold): lossless gzip JSONL archives, never embedded.

Run `python -m memory_scrolls --help`. Stdlib only.
"""

__all__ = ["__version__"]
__version__ = "1.0.0"
