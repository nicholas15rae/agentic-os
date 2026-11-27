"""AnythingLLM client for the host orchestrator.

- `AllmReader` issues GET requests only (per-workspace reads; it has no listing of every workspace
  or every document, because those would expose the Booking workspaces).
- `ScrollWriter` can only ingest one scroll as raw text into its own workspace and un-embed
  locations from that same workspace. It has no system-wide document removal.
- `check_slug` runs at the top of every method, before any I/O: Booking (`my-workspace`,
  `booking`) raises `BookingRefused`.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any, List, Optional

from . import net
from .errors import BookingRefused

NEVER_TOUCH = frozenset({"my-workspace", "booking"})
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DOC_SOURCE = "agentic-os-scroll"


def check_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise BookingRefused("invalid workspace slug")
    if slug in NEVER_TOUCH:
        raise BookingRefused("Booking workspaces are never touched")
    return slug


class RequestTrace:
    """(method, path) of every request. Never headers or bodies."""

    def __init__(self) -> None:
        self.items: List[tuple] = []

    def add(self, method: str, path: str) -> None:
        self.items.append((method, path))

    def as_list(self) -> List[dict]:
        return [{"method": m, "path": p} for m, p in self.items]


class Conn:
    def __init__(self, base: str, key: Optional[str], trace: Optional[RequestTrace] = None, timeout: float = 30.0):
        self.base = base.rstrip("/")
        self.key = key
        self.trace = trace or RequestTrace()
        self.timeout = timeout

    def _guard(self, path: str) -> None:
        segs = [urllib.parse.unquote(s) for s in path.split("?")[0].split("/")]
        if any(s in NEVER_TOUCH for s in segs):
            raise BookingRefused("Booking workspaces are never touched")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.key}"} if self.key else {}

    def get(self, path: str, timeout: Optional[float] = None) -> Any:
        self._guard(path)
        self.trace.add("GET", f"/api{path}")
        return net.get_json(f"{self.base}/api{path}", timeout=timeout or self.timeout, headers=self._headers())

    def send(self, path: str, body: Any, timeout: Optional[float] = None) -> Any:
        self._guard(path)
        self.trace.add("POST", f"/api{path}")
        return net.send_json(f"{self.base}/api{path}", body, timeout=timeout or self.timeout, headers=self._headers())


def unwrap_workspace(v: Any) -> dict:
    """`GET /v1/workspace/{slug}` returns an object or a 1-array under `workspace`."""
    if not isinstance(v, dict):
        return {}
    w = v.get("workspace")
    if isinstance(w, list):
        w = w[0] if w else {}
    return w if isinstance(w, dict) else {}


def doc_meta(d: dict) -> dict:
    """A workspace document's `metadata` (AnythingLLM sends it as a JSON string or an object)."""
    m = d.get("metadata")
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    return m if isinstance(m, dict) else {}


def is_scroll_doc(d: dict) -> bool:
    """A document this package ingested as a Memory Scroll (never raw input for distillation)."""
    return doc_meta(d).get("docSource") == DOC_SOURCE or d.get("docSource") == DOC_SOURCE


# One page of `GET /v1/workspace/{slug}/chats` (the API has no offset): a reply this long may be
# cut short, which callers report (`chats_truncated`).
CHATS_LIMIT = 500


class AllmReader:
    """GET only."""

    def __init__(self, conn: Conn):
        self.conn = conn

    def ping(self) -> bool:
        try:
            self.conn.get("/ping", timeout=4)
            return True
        except Exception:
            return False

    def workspace(self, slug: str) -> dict:
        check_slug(slug)
        return unwrap_workspace(self.conn.get(f"/v1/workspace/{slug}"))

    def workspace_chats(self, slug: str, limit: int = CHATS_LIMIT) -> List[dict]:
        check_slug(slug)
        v = self.conn.get(f"/v1/workspace/{slug}/chats?limit={int(limit)}&orderBy=asc")
        hist = v.get("history") if isinstance(v, dict) else None
        return [h for h in (hist or []) if isinstance(h, dict)]

    def document(self, name: str) -> dict:
        """`GET /v1/document/{docName}` (content for an `--apply` snapshot)."""
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or ".." in name:
            raise ValueError("invalid document name")
        v = self.conn.get(f"/v1/document/{urllib.parse.quote(name)}")
        d = v.get("document") if isinstance(v, dict) else None
        return d if isinstance(d, dict) else {}


class ScrollWriter:
    """Scroll-only writes into one non-Booking workspace."""

    def __init__(self, conn: Conn, workspace: str):
        self.workspace = check_slug(workspace)
        self.conn = conn

    def ingest_scroll(self, scroll_id: str, text: str) -> str:
        check_slug(self.workspace)
        v = self.conn.send("/v1/document/raw-text", {
            "textContent": text,
            "addToWorkspaces": self.workspace,
            "metadata": {"title": scroll_id, "docSource": DOC_SOURCE},
        }, timeout=120)
        try:
            loc = v["documents"][0]["location"]
        except (KeyError, IndexError, TypeError):
            loc = None
        if not isinstance(loc, str) or not loc:
            raise RuntimeError("AnythingLLM did not return the document location")
        return loc

    def scroll_locations(self, scroll_id: str) -> List[str]:
        """Locations of this scroll's own documents embedded in this workspace (GET, workspace-scoped).

        Only documents we ingested match: `docSource == "agentic-os-scroll"` and `title == scroll_id`.
        Used to find a copy whose ingest landed after the client gave up (never recorded in the ledger).
        """
        check_slug(self.workspace)
        w = unwrap_workspace(self.conn.get(f"/v1/workspace/{self.workspace}"))
        out: List[str] = []
        for d in w.get("documents") or []:
            if not isinstance(d, dict):
                continue
            meta = doc_meta(d)
            loc = str(d.get("docpath") or "")
            if loc and meta.get("docSource") == DOC_SOURCE and meta.get("title") == scroll_id:
                out.append(loc)
        return out

    def unembed(self, locations: List[str]) -> None:
        check_slug(self.workspace)
        locs = [x for x in locations if isinstance(x, str) and x]
        if not locs:
            return
        self.conn.send(f"/v1/workspace/{self.workspace}/update-embeddings", {"adds": [], "deletes": locs}, timeout=120)
