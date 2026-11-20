"""Knowledge-graph upsert, compatible with @modelcontextprotocol/server-memory 2.1.1.

- Format: JSONL, one `{"type":"entity",...}` / `{"type":"relation",...}` per line. A legacy pretty
  `{"entities": [...], "relations": [...]}` file keeps its shape.
- Lock: `<file>.lock` created exclusively with `{"pid","hostname","token"}`; stale after 30 s or when
  its owner on this host is gone (then removed under the `<file>.lock.break` O_EXCL guard, re-checked
  inside it, and retried once); we wait up to 10 s, else defer.
- Save: `<file>.<hex>.tmp` in the same directory, then rename over the file.
- Never deletes. Unknown fields and unreadable lines are kept verbatim and in order. Identity is the
  exact entity name; only new observations are appended; an existing entityType is kept.
"""

from __future__ import annotations

import json
import os
import secrets as _secrets
import socket
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from . import fsutil
from .errors import Deferred

STALE_SECS = 30.0
WAIT_SECS = 10.0
POLL_SECS = 0.1


class KGLock:
    def __init__(self, path: Path, wait_secs: float = WAIT_SECS, stale_secs: float = STALE_SECS):
        self.lock = Path(str(path) + ".lock")
        self.wait = wait_secs
        self.stale = stale_secs
        self.token = json.dumps({"pid": os.getpid(), "hostname": socket.gethostname(), "token": _secrets.token_hex(16)})

    def _is_stale(self) -> bool:
        try:
            st = os.stat(self.lock)
            raw = self.lock.read_text(encoding="utf-8")
        except OSError:
            return False
        try:
            owner = json.loads(raw)
        except ValueError:
            owner = None
        if isinstance(owner, dict) and owner.get("hostname") == socket.gethostname() and isinstance(owner.get("pid"), int):
            if not fsutil.pid_alive(owner["pid"]):
                return True
        return time.time() - st.st_mtime > self.stale

    def _break_stale(self) -> bool:
        """Remove an abandoned lock under server-memory's `<lock>.break` O_EXCL guard.

        Only one breaker at a time, and staleness is re-checked inside the guard, so a lock that a
        Node writer broke and re-took between our check and the remove is never deleted. A guard
        older than the stale window was left by a crash and is cleared (as server-memory does).
        """
        breaker = Path(str(self.lock) + ".break")
        try:
            fd = os.open(breaker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except (FileExistsError, PermissionError):
            try:
                if time.time() - os.stat(breaker).st_mtime > self.stale:
                    os.remove(breaker)
            except OSError:
                pass
            return False
        try:
            os.close(fd)
            if not self._is_stale():
                return False
            try:
                os.remove(self.lock)
            except OSError:
                return False
            return True
        finally:
            try:
                os.remove(breaker)
            except OSError:
                pass

    def __enter__(self) -> "KGLock":
        deadline = time.monotonic() + self.wait
        broke = False
        fsutil.refuse_protected(self.lock, "knowledge graph lock")
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except (FileExistsError, PermissionError):
                if not broke and self._is_stale() and self._break_stale():
                    broke = True
                    continue
                if time.monotonic() >= deadline:
                    raise Deferred("knowledge graph is locked by another writer") from None
                time.sleep(POLL_SECS)
                continue
            try:
                os.write(fd, self.token.encode("utf-8"))
            finally:
                os.close(fd)
            return self

    def __exit__(self, *exc) -> None:
        try:
            if self.lock.read_text(encoding="utf-8") == self.token:
                os.remove(self.lock)
        except OSError:
            pass


def _save(path: Path, text: str) -> None:
    fsutil.refuse_protected(path, "knowledge graph path")
    tmp = path.with_name(f"{path.name}.{_secrets.token_hex(16)}.tmp")
    try:
        with open(tmp, "x", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _entity_line(name: str, etype: str, obs: List[str], extras: Dict) -> str:
    return json.dumps({"type": "entity", "name": name, "entityType": etype, "observations": obs, **extras}, ensure_ascii=False)


def _clean_entities(entities: Sequence[dict]) -> List[Tuple[str, str, List[str]]]:
    merged: Dict[str, Tuple[str, List[str]]] = {}
    order: List[str] = []
    for e in entities:
        name = str(e.get("name") or "").strip()
        if not name:
            continue
        etype = str(e.get("entityType") or "concept").strip() or "concept"
        obs = [str(o).strip() for o in (e.get("observations") or []) if str(o).strip()]
        if name not in merged:
            merged[name] = (etype, [])
            order.append(name)
        for o in obs:
            if o not in merged[name][1]:
                merged[name][1].append(o)
    return [(n, merged[n][0], merged[n][1]) for n in order]


def _clean_relations(relations: Sequence[dict]) -> List[Tuple[str, str, str]]:
    out = []
    for r in relations:
        key = (str(r.get("from") or "").strip(), str(r.get("to") or "").strip(), str(r.get("relationType") or "").strip())
        if all(key) and key not in out:
            out.append(key)
    return out


def _upsert_jsonl(text: str, ents, rels) -> Tuple[str, Dict[str, int]]:
    lines = [ln for ln in text.split("\n") if ln.strip() != ""]
    parsed: List[Optional[dict]] = []
    for ln in lines:
        try:
            v = json.loads(ln)
        except ValueError:
            v = None
        parsed.append(v if isinstance(v, dict) else None)
    by_name: Dict[str, int] = {}
    rel_keys = set()
    last_entity = -1
    last_rel = -1
    for i, v in enumerate(parsed):
        if v is None:
            continue
        if v.get("type") == "entity" and isinstance(v.get("name"), str) and isinstance(v.get("observations"), list):
            by_name.setdefault(v["name"], i)
            last_entity = i
        elif v.get("type") == "relation":
            rel_keys.add((v.get("from"), v.get("to"), v.get("relationType")))
            last_rel = i
    stats = {"entities_added": 0, "observations_added": 0, "relations_added": 0}
    new_entity_lines: List[str] = []
    for name, etype, obs in ents:
        if name in by_name:
            i = by_name[name]
            v = parsed[i]
            have = [o for o in v["observations"]]
            add = [o for o in obs if o not in have]
            if add:
                extras = {k: x for k, x in v.items() if k not in ("type", "name", "entityType", "observations")}
                lines[i] = _entity_line(name, v.get("entityType") or etype, have + add, extras)
                stats["observations_added"] += len(add)
        else:
            new_entity_lines.append(_entity_line(name, etype, obs, {}))
            stats["entities_added"] += 1
    new_rel_lines = []
    for f, t, rt in rels:
        if (f, t, rt) in rel_keys:
            continue
        rel_keys.add((f, t, rt))
        new_rel_lines.append(json.dumps({"type": "relation", "from": f, "to": t, "relationType": rt}, ensure_ascii=False))
        stats["relations_added"] += 1
    # Insert new entities after the last entity line; new relations after the last relation line
    # (or right after the entities when there is none yet).
    ent_at = last_entity + 1 if last_entity >= 0 else 0
    lines[ent_at:ent_at] = new_entity_lines
    if last_rel >= 0:
        rel_at = last_rel + 1 + (len(new_entity_lines) if last_rel >= ent_at else 0)
    else:
        rel_at = ent_at + len(new_entity_lines)
    lines[rel_at:rel_at] = new_rel_lines
    return ("\n".join(lines) + "\n") if lines else "", stats


def _upsert_legacy(doc: dict, ents, rels) -> Tuple[str, Dict[str, int]]:
    entities = doc.setdefault("entities", [])
    relations = doc.setdefault("relations", [])
    stats = {"entities_added": 0, "observations_added": 0, "relations_added": 0}
    index = {e.get("name"): e for e in entities if isinstance(e, dict)}
    for name, etype, obs in ents:
        e = index.get(name)
        if e is None:
            e = {"name": name, "entityType": etype, "observations": list(obs)}
            entities.append(e)
            index[name] = e
            stats["entities_added"] += 1
            continue
        have = e.setdefault("observations", [])
        for o in obs:
            if o not in have:
                have.append(o)
                stats["observations_added"] += 1
    keys = {(r.get("from"), r.get("to"), r.get("relationType")) for r in relations if isinstance(r, dict)}
    for f, t, rt in rels:
        if (f, t, rt) not in keys:
            keys.add((f, t, rt))
            relations.append({"from": f, "to": t, "relationType": rt})
            stats["relations_added"] += 1
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n", stats


def kg_upsert(path: Path, entities: Sequence[dict], relations: Sequence[dict] = (), wait_secs: float = WAIT_SECS) -> Dict[str, int]:
    """Upsert entities/relations; creates the file (JSONL) only when absent. Raises Deferred on a held lock."""
    path = Path(path)
    fsutil.refuse_protected(path, "knowledge graph path")
    ents = _clean_entities(entities)
    rels = _clean_relations(relations)
    if not ents and not rels:
        return {"entities_added": 0, "observations_added": 0, "relations_added": 0, "created": 0}
    with KGLock(path, wait_secs=wait_secs):
        created = not path.exists()
        text = "" if created else path.read_text(encoding="utf-8")
        legacy = None
        stripped = text.strip()
        if stripped.startswith("{"):
            try:
                v = json.loads(stripped)
                if isinstance(v, dict) and "entities" in v and "type" not in v:
                    legacy = v
            except ValueError:
                legacy = None
        if legacy is not None:
            out, stats = _upsert_legacy(legacy, ents, rels)
        else:
            out, stats = _upsert_jsonl(text, ents, rels)
        if out != text:
            _save(path, out)
    stats["created"] = int(created)
    return stats


def scroll_graph(scroll_id: str, rel: str, entities: Sequence[dict]) -> Tuple[List[dict], List[dict]]:
    """The host's own additions: one `scroll` entity plus `documented_in` relations."""
    ents = [dict(e) for e in entities] + [{"name": scroll_id, "entityType": "scroll", "observations": [f"path: {rel}"]}]
    rels = [{"from": str(e.get("name")), "to": scroll_id, "relationType": "documented_in"} for e in entities if str(e.get("name") or "").strip() and e.get("name") != scroll_id]
    return ents, rels


def read_entities(path: Path) -> List[dict]:
    """All entity records (JSONL or legacy) for tests / status."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return []
    s = text.strip()
    if s.startswith("{"):
        try:
            v = json.loads(s)
            if isinstance(v, dict) and "entities" in v:
                return [e for e in v["entities"] if isinstance(e, dict)]
        except ValueError:
            pass
    out = []
    for ln in text.split("\n"):
        try:
            v = json.loads(ln)
        except ValueError:
            continue
        if isinstance(v, dict) and v.get("type") == "entity":
            out.append(v)
    return out
