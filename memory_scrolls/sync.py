"""Changed-scroll AnythingLLM sync with a crash-safe ledger (`state["sync"]`).

Replace flow per changed scroll: ledger intent -> raw-text ingest into the scroll workspace ->
record the new location at once -> un-embed the OLD location (only locations from our own
ledger, workspace-scoped) -> old marked orphaned -> synced. `reconcile()` finishes a half-done
entry on the next run. Without an API key entries stay `pending`; scrolls are still written.

An ingest whose outcome is unknown (client timeout, error, or a crash while `ingesting`) may still
have landed server-side with a location we never recorded. Such an entry is flagged `stray_check`;
its next successful ingest looks up this scroll's own documents in the scroll workspace
(`docSource` agentic-os-scroll, title = scroll_id) and un-embeds every one but the new copy.

Writers mark a scroll `dirty` (`mark_dirty`) BEFORE writing it, so a run killed between the write
and the sync phase still syncs it next time (`sync_changed` always includes dirty entries).

Tier-2 privacy: the text embedded is always the privacy-filtered scroll (`privacy.filter_scroll`),
so a scroll written before the filter (or edited by hand) never reaches AnythingLLM with personal
data; the removal is counted by category in the result's `privacy` key.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from collections import Counter
from typing import Callable, Dict, List, Optional

from . import privacy
from .allm import Conn, ScrollWriter
from .net import short_error
from .scroll import read_scroll, render, target_info

MAX_ORPHANS = 50


def make_writer(base: str, key: Optional[str], workspace: str, trace=None) -> Optional[ScrollWriter]:
    if not key:
        return None
    return ScrollWriter(Conn(base, key, trace), workspace)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _entry(state: Dict, scroll_id: str) -> Dict:
    return state.setdefault("sync", {}).setdefault(scroll_id, {"state": "new", "sha256": None, "version": None, "location": None, "orphaned": []})


def mark_dirty(state: Dict, scroll_id: str, rel: str) -> None:
    """Record, before a scroll is written, that it must be synced (crash / kill safe). Caller saves."""
    e = _entry(state, scroll_id)
    e["rel"] = rel
    e["dirty"] = True


def _drop(e: Dict, locs: List[str]) -> None:
    e.setdefault("orphaned", []).extend(locs)
    e["orphaned"] = e["orphaned"][-MAX_ORPHANS:]


def reconcile(writer: Optional[ScrollWriter], state: Dict, save: Callable[[], None]) -> List[str]:
    """Finish entries interrupted after ingest (new location recorded, old not yet un-embedded)."""
    done = []
    if writer is None:
        return done
    for sid, e in (state.get("sync") or {}).items():
        if e.get("state") == "unembedding" and e.get("new_location"):
            new = e["new_location"]
            olds = [x for x in [e.get("old_location"), *(e.get("stray_locations") or [])] if x and x != new]
            olds = list(dict.fromkeys(olds))
            if olds:
                writer.unembed(olds)
                _drop(e, olds)
            e["location"] = e.pop("new_location")
            e.pop("old_location", None)
            e.pop("stray_locations", None)
            e["state"] = "synced"
            save()
            done.append(sid)
        elif e.get("state") == "ingesting":
            # The ingest may or may not have landed; ingest again on the next sync and look for
            # the copy it may have left behind.
            e["state"] = "pending"
            e["stray_check"] = True
            save()
    return done


def sync_one(writer: Optional[ScrollWriter], state: Dict, scroll_id: str, text: str, version: int, save: Callable[[], None]) -> str:
    e = _entry(state, scroll_id)
    sha = _sha(text)
    if e.get("state") == "synced" and e.get("sha256") == sha:
        if e.pop("dirty", None):
            save()
        return "unchanged"
    if writer is None:
        e.update({"state": "pending", "sha256": sha, "version": version})
        save()
        return "pending"
    prev = e.get("location")
    e.update({"state": "ingesting", "sha256": sha, "version": version})
    save()
    try:
        new_loc = writer.ingest_scroll(scroll_id, text)
    except Exception:
        # Unknown outcome (e.g. a client timeout while the server finishes the ingest).
        e["stray_check"] = True
        save()
        raise
    e.update({"state": "unembedding", "new_location": new_loc, "old_location": prev})
    save()
    strays: List[str] = []
    if e.get("stray_check"):
        try:
            strays = [x for x in writer.scroll_locations(scroll_id) if x not in (new_loc, prev)]
            e.pop("stray_check", None)
        except Exception:
            strays = []  # keep the flag: looked up again on the next ingest
        if strays:
            e["stray_locations"] = strays
            save()
    olds = list(dict.fromkeys(x for x in [prev, *strays] if x and x != new_loc))
    if olds:
        writer.unembed(olds)
        _drop(e, olds)
    e["location"] = new_loc
    e.pop("new_location", None)
    e.pop("old_location", None)
    e.pop("stray_locations", None)
    e.pop("dirty", None)
    e["state"] = "synced"
    save()
    return "synced"


def sync_changed(writer: Optional[ScrollWriter], state: Dict, scrolls_root: Path, rels: List[str], save: Callable[[], None], policy: Optional[privacy.Policy] = None) -> Dict[str, List[str]]:
    """Sync `rels` plus every ledger entry still pending. Reads the scroll text from disk and embeds
    its privacy-filtered rendering (`policy`, default `privacy.default_policy()`); lines removed
    are counted under `out["privacy"]` ({category: n}, only when any)."""
    out: Dict[str, List[str]] = {"synced": [], "pending": [], "unchanged": [], "failed": []}
    removed: Counter = Counter()
    todo = list(dict.fromkeys(rels))
    by_id = {}
    for rel in todo:
        by_id[target_info(rel).scroll_id] = rel
    for sid, e in (state.get("sync") or {}).items():
        if (e.get("state") in ("pending", "new") or e.get("dirty")) and sid not in by_id and e.get("rel"):
            by_id[sid] = e["rel"]
    for sid, rel in by_id.items():
        try:
            s = read_scroll(scrolls_root, rel)
        except Exception:
            s = None
        if s is None:
            continue
        s, c = privacy.filter_scroll(s, policy)
        removed.update(c)
        _entry(state, sid)["rel"] = rel
        try:
            res = sync_one(writer, state, sid, render(s), s.version, save)
        except Exception as ex:  # keep going; the ledger says where it stopped
            out["failed"].append(f"{sid}: {short_error(ex)}")
            continue
        out[res].append(sid)
    if removed:
        out["privacy"] = dict(sorted(removed.items()))
    return out
