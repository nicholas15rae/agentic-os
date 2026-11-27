"""AnythingLLM export + import (Section 26 step 7). Read-only on AnythingLLM: nothing there is changed,
moved or deleted.

    python -m engine.allm_import export            # snapshot into data/engine/allm-export/<stamp>/
    python -m engine.allm_import import <export>   # that snapshot's documents into the doc store
    python -m engine.allm_import report <export>   # counts: AnythingLLM vs export vs doc store

The export (kept until Nic confirms nothing is missing):
  anythingllm.db           a consistent copy via SQLite's backup API from a read-only connection
  documents/ lancedb/ vector-cache/   copied as they are
  plugins/anythingllm_mcp_servers.json, plugins/agent-skills/, plugins/agent-flows/
  workspaces/<slug>.json   settings + system prompt + prompt history + threads + chats, per workspace
  manifest.json            source path, counts per table, sha256 of every copied file, what was skipped

Secrets: API keys, tokens and passwords are redacted from the export (redact_export: secret columns,
secret-named JSON fields, token-shaped strings, then VACUUM). Not exported: `comkey` (AnythingLLM's encryption key), `models/` and `engines/` (its bundled
runtimes, ~5 GB, no user data), `logs/`, `tmp/`, `hotdir/`, the *.bak MCP lists.

The import puts only DOCUMENTS (documents/**.json pageContent) into the doc store. Chats stay in the
export as an archive: they are not made searchable (the Finance workspace's among them).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

STORAGE = Path(os.environ.get("APPDATA", str(Path.home()))) / "anythingllm-desktop" / "storage"
EXPORT_ROOT = ROOT / "data" / "engine" / "allm-export"
COPY_DIRS = ("documents", "lancedb", "vector-cache", "plugins/agent-skills", "plugins/agent-flows")
COPY_FILES = ("plugins/anythingllm_mcp_servers.json",)
SKIPPED = ("comkey", "models/", "engines/", "logs/", "tmp/", "hotdir/", "plugins/*.bak", "lemond/", "generated-files/")
TABLES = ("workspaces", "workspace_documents", "workspace_chats", "workspace_threads", "document_vectors",
          "prompt_history", "workspace_agent_invocations", "system_settings", "event_logs")


def _ro(db: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _counts(c: sqlite3.Connection) -> dict:
    names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {t: c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in TABLES if t in names}


def _rows(c: sqlite3.Connection, sql: str, args=()) -> list[dict]:
    return [dict(r) for r in c.execute(sql, args).fetchall()]


def export(storage: Path = STORAGE, out_root: Path = EXPORT_ROOT, stamp: Optional[str] = None) -> Path:
    db = storage / "anythingllm.db"
    if not db.is_file():
        raise FileNotFoundError(f"no AnythingLLM database at {db}")
    out = out_root / (stamp or time.strftime("%Y%m%d-%H%M%S"))
    if out.exists():
        raise FileExistsError(f"{out} already exists; exports are never overwritten")
    out.mkdir(parents=True)
    src = _ro(db)
    try:
        dst = sqlite3.connect(out / "anythingllm.db")
        try:
            src.backup(dst)
        finally:
            dst.close()
        counts = _counts(src)
        (out / "workspaces").mkdir()
        for ws in _rows(src, "SELECT * FROM workspaces ORDER BY id"):
            wid = ws["id"]
            doc = {
                "workspace": ws,
                "documents": _rows(src, "SELECT * FROM workspace_documents WHERE workspaceId=?", (wid,)),
                "promptHistory": _rows(src, "SELECT * FROM prompt_history WHERE workspaceId=? ORDER BY id", (wid,)),
                "threads": _rows(src, "SELECT * FROM workspace_threads WHERE workspace_id=? ORDER BY id", (wid,)),
                "chats": _rows(src, "SELECT * FROM workspace_chats WHERE workspaceId=? ORDER BY id", (wid,)),
            }
            safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(ws["slug"]))
            (out / "workspaces" / f"{safe}.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        settings_labels = [r["label"] for r in src.execute("SELECT label FROM system_settings ORDER BY label")]
    finally:
        src.close()
    files: dict[str, str] = {}
    for rel in COPY_DIRS:
        s = storage / rel
        if s.is_dir():
            shutil.copytree(s, out / rel, dirs_exist_ok=False)
    for rel in COPY_FILES:
        s = storage / rel
        if s.is_file():
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, out / rel)
    for p in sorted(out.rglob("*")):
        if p.is_file():
            files[p.relative_to(out).as_posix()] = _sha(p)
    manifest = {"source": str(storage), "exportedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "counts": counts,
                "documents": len(list((out / "documents").rglob("*.json"))) if (out / "documents").is_dir() else 0,
                "systemSettingLabels": settings_labels, "skipped": list(SKIPPED), "sha256": files}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    redact_export(out)  # no API key or token stays in plain text in an export
    return out


def verify(export_dir: Path) -> list[str]:
    """Files whose sha256 no longer matches the manifest (empty = intact)."""
    m = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
    bad = []
    for rel, digest in m["sha256"].items():
        p = export_dir / rel
        if not p.is_file() or _sha(p) != digest:
            bad.append(rel)
    return bad


def _doc_workspaces(export_dir: Path) -> dict[str, list[str]]:
    """docpath → workspace slugs, from the exported database."""
    c = _ro(export_dir / "anythingllm.db")
    try:
        out: dict[str, list[str]] = {}
        for r in c.execute("SELECT d.docpath, w.slug FROM workspace_documents d JOIN workspaces w ON w.id=d.workspaceId"):
            out.setdefault(r[0], []).append(r[1])
        return out
    finally:
        c.close()


def import_documents(export_dir: Path, store=None) -> dict:
    """Every exported document's pageContent into the doc store (source "anythingllm", key = its
    docpath). Re-running is a no-op for unchanged documents."""
    from engine.docstore import DocStore
    store = store or DocStore()
    docs_root = export_dir / "documents"
    ws_map = _doc_workspaces(export_dir)
    counts = {"added": 0, "updated": 0, "unchanged": 0, "empty": 0, "unreadable": 0}
    for p in sorted(docs_root.rglob("*.json")) if docs_root.is_dir() else []:
        rel = p.relative_to(docs_root).as_posix()
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            text = d.get("pageContent") or ""
        except (OSError, ValueError, AttributeError):
            counts["unreadable"] += 1
            continue
        meta = {k: d.get(k) for k in ("id", "url", "docSource", "chunkSource", "published", "wordCount")}
        meta["workspaces"] = ws_map.get(rel, [])
        counts[store.add_text("anythingllm", rel, text, title=d.get("title") or p.name, meta=meta)] += 1
    return counts


def report(export_dir: Path, storage: Path = STORAGE, store=None) -> dict:
    """AnythingLLM now vs the export vs the doc store, so Nic can see nothing is missing."""
    from engine.docstore import DocStore
    m = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
    live = {}
    if (storage / "anythingllm.db").is_file():
        c = _ro(storage / "anythingllm.db")
        try:
            live = _counts(c)
        finally:
            c.close()
    exp_db = _ro(export_dir / "anythingllm.db")
    try:
        exported = _counts(exp_db)
    finally:
        exp_db.close()
    live_docs = len(list((storage / "documents").rglob("*.json"))) if (storage / "documents").is_dir() else None
    stored = (store or DocStore()).stats()["docs"].get("anythingllm", 0)
    newer = {t: (live.get(t), exported.get(t)) for t in TABLES if live.get(t) != exported.get(t)}
    return {"export": str(export_dir), "exportedAt": m["exportedAt"], "tablesLiveVsExport": newer or "all equal",
            "documents": {"live": live_docs, "exported": m["documents"], "inDocStore": stored},
            "integrity": verify(export_dir) or "ok"}


# ── secrets: the export never keeps an API key or token in plain text (Nic, 11-27) ──

# A field NAME that holds a secret: the name ends in one of these words (BRAVE_API_KEY, apiKey,
# access_token, clientSecret), so counts like token_count_estimate or tokenLimit are left alone.
SECRET_KEY = re.compile(r"(?i)(api[_-]?key|token|secret|password|passwd|bearer|authorization|cookie|credentials?)$")
SECRET_VALUE = re.compile(r"(?<![A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}"
                          r"|xox[abp]-[A-Za-z0-9-]{10,}|ya29\.[0-9A-Za-z_-]{20,}|1//[0-9A-Za-z_-]{30,})|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}")
REDACTED = "[REDACTED]"
# (table, column) pairs that only ever hold secrets
SECRET_COLUMNS = (("api_keys", "secret"), ("desktop_mobile_devices", "token"), ("users", "password"),
                  ("temporary_auth_tokens", "token"), ("browser_extension_api_keys", "key"), ("recovery_codes", "code_hash"),
                  ("password_reset_tokens", "token"))


def _scrub(v, counter: list[int]):
    """Redact secret-named fields and token-shaped strings anywhere in a JSON value."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if SECRET_KEY.search(str(k)) and isinstance(x, (str, int)) and str(x) not in ("", REDACTED):
                out[k] = REDACTED
                counter[0] += 1
            else:
                out[k] = _scrub(x, counter)
        return out
    if isinstance(v, list):
        return [_scrub(x, counter) for x in v]
    if isinstance(v, str):
        new, n = SECRET_VALUE.subn(REDACTED, v)
        counter[0] += n
        return new
    return v


def _scrub_text(t: str, counter: list[int]) -> str:
    t2 = t
    if t.lstrip().startswith(("{", "[")):
        try:
            return json.dumps(_scrub(json.loads(t), counter), indent=2, ensure_ascii=False)
        except ValueError:
            pass
    t2, n = SECRET_VALUE.subn(REDACTED, t2)
    counter[0] += n
    return t2


def redact_export(export_dir: Path) -> dict:
    """Scrub secrets out of an export IN PLACE (the export only, never AnythingLLM), VACUUM the
    database so no old page keeps them, and rewrite the manifest's checksums."""
    export_dir = Path(export_dir)
    db = export_dir / "anythingllm.db"
    counts: dict[str, int] = {}
    c = sqlite3.connect(db)
    try:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for t, col in SECRET_COLUMNS:
            if t in tables and col in [r[1] for r in c.execute(f'PRAGMA table_info("{t}")')]:
                # per-row marker: some of these columns are UNIQUE (api_keys.secret)
                n = c.execute(f'UPDATE "{t}" SET "{col}" = ? || rowid WHERE "{col}" IS NOT NULL '
                              f'AND "{col}" NOT LIKE ? AND "{col}" != ""', (REDACTED + "-", REDACTED + "%")).rowcount
                if n:
                    counts[f"{t}.{col}"] = n
        if "system_settings" in tables:
            for sid, val in c.execute("SELECT id, value FROM system_settings").fetchall():
                k = [0]
                new = _scrub_text(val or "", k)
                if k[0]:
                    c.execute("UPDATE system_settings SET value=? WHERE id=?", (new, sid))
                    counts["system_settings"] = counts.get("system_settings", 0) + k[0]
        for t in ("workspace_chats", "event_logs", "prompt_history"):
            if t not in tables:
                continue
            cols = [r[1] for r in c.execute(f'PRAGMA table_info("{t}")') if r[2].upper() in ("TEXT", "")]
            for row in c.execute(f'SELECT rowid, {", ".join(chr(34) + x + chr(34) for x in cols)} FROM "{t}"').fetchall():
                for col, val in zip(cols, row[1:]):
                    if isinstance(val, str) and SECRET_VALUE.search(val):
                        k = [0]
                        new = SECRET_VALUE.sub(REDACTED, val)
                        c.execute(f'UPDATE "{t}" SET "{col}"=? WHERE rowid=?', (new, row[0]))
                        counts[t] = counts.get(t, 0) + 1
        c.commit()
        c.execute("VACUUM")  # rewrite the file: no free page keeps an old value
    finally:
        c.close()
    for p in sorted(export_dir.rglob("*")):
        if not p.is_file() or p.name in ("anythingllm.db", "manifest.json") or p.suffix.lower() not in (".json", ".txt", ".md", ".log", ".yml", ".yaml", ".env"):
            continue
        k = [0]
        t = p.read_text(encoding="utf-8", errors="replace")
        new = _scrub_text(t, k)
        if k[0]:
            p.write_text(new, encoding="utf-8")
            counts[p.relative_to(export_dir).as_posix()] = k[0]
    m = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
    m["sha256"] = {p.relative_to(export_dir).as_posix(): _sha(p) for p in sorted(export_dir.rglob("*"))
                   if p.is_file() and p.name != "manifest.json"}
    m["redacted"] = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "counts": counts}
    (export_dir / "manifest.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
    return counts


def leftover_secrets(export_dir: Path) -> list[str]:
    """Anything token-shaped still in the export (text files, and the database's raw bytes)."""
    found = []
    for p in sorted(Path(export_dir).rglob("*")):
        if not p.is_file():
            continue
        try:
            t = p.read_bytes().decode("utf-8", errors="ignore")
        except OSError:
            continue
        if SECRET_VALUE.search(t):
            found.append(p.relative_to(export_dir).as_posix())
    return found


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="AnythingLLM export / import (read-only on AnythingLLM)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("export")
    rd = sub.add_parser("redact")
    rd.add_argument("export_dir")
    for name in ("import", "report"):
        sp = sub.add_parser(name)
        sp.add_argument("export_dir")
    a = ap.parse_args(argv)
    if a.cmd == "export":
        out = export()
        print(f"exported to {out}")
        print(json.dumps(json.loads((out / "manifest.json").read_text())["counts"], indent=2))
    elif a.cmd == "redact":
        print(json.dumps(redact_export(Path(a.export_dir)), indent=2))
        print("leftover token-shaped strings:", leftover_secrets(Path(a.export_dir)) or "none")
    elif a.cmd == "import":
        print(json.dumps(import_documents(Path(a.export_dir)), indent=2))
    else:
        print(json.dumps(report(Path(a.export_dir)), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
