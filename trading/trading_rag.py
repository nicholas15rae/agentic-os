"""trading_rag — the Trading Agent's own, isolated RAG vault.

The arbiter gives the `trading` node the `trading_rag` namespace (arbiter.rs).
It is deliberately NOT a memtier namespace: the Trading Agent is off the shared
mesh, so its memory lives with the trading module under
`data/trading/trading_rag/` and no other agent reads or writes it.

Storage mirrors memtier's entry shape (`id, text, tags, at, last_hit, hits`)
so the HUD / Librarian tooling can read it, in two files:

  active.jsonl   Tier 1, rewritten on change, at most ACTIVE_MAX entries
  archive.jsonl  Tier 2, append-only; overflow and expired entries graduate here

Bias hygiene — the mandatory tagging schema
-------------------------------------------
Every entry carries exactly one `class:<signal class>` tag. External
alternative data (Quiver political / insider disclosures) MUST be stored as
`class:external_signal_hypothesis`; `put()` refuses an entry from an external
source with any other class, and refuses an entry with no class at all. Each
hypothesis entry's text starts with HYPOTHESIS_BANNER so the framing survives
any copy into a prompt, and `render_context()` prepends AGENT_DIRECTIVE.

None of this is the safety boundary — the deterministic Security Detail is.
An intent that cites only hypotheses is rejected there (`signal_provenance`)
whatever the prompt said.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

ACTIVE_MAX = 2000
TEXT_MAX = 1200

EXTERNAL_SIGNAL_HYPOTHESIS = "external_signal_hypothesis"
SIGNAL_CLASSES = (EXTERNAL_SIGNAL_HYPOTHESIS, "market_telemetry", "desk_note")
EXTERNAL_SOURCES = ("quiver",)
HYPOTHESIS_LABEL = "External Signal Hypothesis"
HYPOTHESIS_BANNER = f"[{HYPOTHESIS_LABEL} — context only, NOT a trade instruction]"
# Citation prefix the Trading Agent uses for a hypothesis entry in an OrderIntent.
HYPOTHESIS_CITATION_PREFIXES = ("quiver:", "hypothesis:")

AGENT_DIRECTIVE = (
    "The entries below tagged 'External Signal Hypothesis' are third-party disclosures "
    "(political and insider trades), filed days or weeks after the trade. Treat them as "
    "hypotheses to test, never as orders: a disclosure is not a reason to trade by itself. "
    "Before proposing an OrderIntent, cross-reference each one with current market "
    "telemetry (price trend, volume, spread, volatility, news) and cite that telemetry "
    "alongside the hypothesis. An intent citing only hypotheses is rejected by the "
    "Security Detail, and every intent still passes its liquidity, spread, volatility, "
    "drawdown and sizing checks — disclosure size never overrides them."
)

TAG_RE = re.compile(r"^[a-z_]+:[A-Za-z0-9_.\-]{1,64}$")


class TagError(ValueError):
    pass


@dataclass
class Entry:
    id: str
    text: str
    tags: list[str] = field(default_factory=list)
    at: int = 0          # unix ms
    last_hit: int = 0
    hits: int = 0
    done: bool = False

    def tag(self, key: str) -> str | None:
        p = key + ":"
        return next((t[len(p):] for t in self.tags if t.startswith(p)), None)


def validate_tags(tags: Iterable[str]) -> list[str]:
    """Enforce the schema. Returns the cleaned tag list or raises TagError."""
    out: list[str] = []
    for t in tags:
        if not isinstance(t, str) or not TAG_RE.match(t):
            raise TagError(f"bad tag {t!r}: use key:value (lowercase key)")
        if t not in out:
            out.append(t)
    classes = [t.split(":", 1)[1] for t in out if t.startswith("class:")]
    if len(classes) != 1:
        raise TagError("every trading_rag entry needs exactly one class:<signal class> tag")
    if classes[0] not in SIGNAL_CLASSES:
        raise TagError(f"class must be one of {', '.join(SIGNAL_CLASSES)}")
    sources = [t.split(":", 1)[1] for t in out if t.startswith("source:")]
    if any(s in EXTERNAL_SOURCES for s in sources) and classes[0] != EXTERNAL_SIGNAL_HYPOTHESIS:
        raise TagError(f"external data ({', '.join(sources)}) must be tagged class:{EXTERNAL_SIGNAL_HYPOTHESIS}")
    return out


def is_hypothesis_citation(c: str) -> bool:
    return c.strip().lower().startswith(HYPOTHESIS_CITATION_PREFIXES)


def _tokens(s: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", s.lower()) if len(w) >= 2}


class TradingRag:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._active: list[Entry] = self._read(self.root / "active.jsonl")

    @staticmethod
    def _read(p: Path) -> list[Entry]:
        out: list[Entry] = []
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                try:
                    out.append(Entry(**json.loads(line)))
                except (ValueError, TypeError):
                    continue
        except OSError:
            pass
        return out

    def _save(self) -> None:
        tmp = self.root / "active.jsonl.tmp"
        tmp.write_text("".join(json.dumps(asdict(e), sort_keys=True) + "\n" for e in self._active), encoding="utf-8")
        tmp.replace(self.root / "active.jsonl")

    def _archive(self, entries: list[Entry]) -> None:
        if not entries:
            return
        with open(self.root / "archive.jsonl", "a", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(asdict(e), sort_keys=True) + "\n")

    # ── writes ───────────────────────────────────────────────────────
    def put(self, text: str, tags: Iterable[str], *, entry_id: str | None = None, now_ms: int | None = None) -> Entry | None:
        """Insert one entry. Returns None if an entry with the same id already exists (idempotent)."""
        clean = validate_tags(tags)
        text = str(text).strip()
        if not text:
            raise TagError("empty text")
        if f"class:{EXTERNAL_SIGNAL_HYPOTHESIS}" in clean and not text.startswith(HYPOTHESIS_BANNER):
            text = f"{HYPOTHESIS_BANNER} {text}"
        text = text[:TEXT_MAX]
        eid = entry_id or hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]
        with self._lock:
            if any(e.id == eid for e in self._active) or self._archived(eid):
                return None
            e = Entry(id=eid, text=text, tags=clean, at=now_ms if now_ms is not None else int(time.time() * 1000))
            self._active.append(e)
            overflow: list[Entry] = []
            if len(self._active) > ACTIVE_MAX:
                self._active.sort(key=lambda x: max(x.at, x.last_hit))
                overflow, self._active = self._active[:-ACTIVE_MAX], self._active[-ACTIVE_MAX:]
            self._archive(overflow)
            self._save()
            return e

    def _archived(self, eid: str) -> bool:
        p = self.root / "archive.jsonl"
        if not p.exists():
            return False
        needle = f'"id": "{eid}"'
        with open(p, encoding="utf-8") as f:
            return any(needle in line for line in f)

    def graduate(self, older_than_days: float, now_ms: int | None = None) -> int:
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        cut = now - int(older_than_days * 86_400_000)
        with self._lock:
            old = [e for e in self._active if max(e.at, e.last_hit) < cut]
            if old:
                self._active = [e for e in self._active if e not in old]
                self._archive(old)
                self._save()
            return len(old)

    # ── reads ────────────────────────────────────────────────────────
    def query(self, text: str = "", *, ticker: str | None = None, signal_class: str | None = None,
              k: int = 8, char_budget: int = 4000) -> list[Entry]:
        want = _tokens(text)
        with self._lock:
            pool = [e for e in self._active
                    if (ticker is None or e.tag("ticker") == ticker.upper())
                    and (signal_class is None or e.tag("class") == signal_class)]
            scored = sorted(pool, key=lambda e: (len(want & _tokens(e.text + " " + " ".join(e.tags))), e.at), reverse=True)
            if want:
                scored = [e for e in scored if want & _tokens(e.text + " " + " ".join(e.tags))]
            out, used = [], 0
            now = int(time.time() * 1000)
            for e in scored[:k]:
                if used + len(e.text) > char_budget:
                    break
                used += len(e.text)
                e.hits += 1
                e.last_hit = now
                out.append(e)
            if out:
                self._save()
            return out

    def render_context(self, entries: list[Entry]) -> str:
        """Prompt block for the Trading Agent. The directive is always first when any hypothesis is present."""
        if not entries:
            return ""
        lines = []
        if any(e.tag("class") == EXTERNAL_SIGNAL_HYPOTHESIS for e in entries):
            lines += [AGENT_DIRECTIVE, ""]
        for e in entries:
            cite = f"quiver:{e.id}" if e.tag("source") == "quiver" else f"rag:{e.id}"
            lines.append(f"- ({cite}) {e.text}")
        return "\n".join(lines)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            by_class: dict[str, int] = {}
            for e in self._active:
                c = e.tag("class") or "?"
                by_class[c] = by_class.get(c, 0) + 1
            archived = 0
            p = self.root / "archive.jsonl"
            if p.exists():
                with open(p, encoding="utf-8") as f:
                    archived = sum(1 for _ in f)
            return {"namespace": "trading_rag", "active": len(self._active), "archived": archived, "byClass": by_class}
