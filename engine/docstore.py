"""Document store for the built-in engine (Section 26 step 6): documents → chunks → nomic vectors.

Its own SQLite file (data/engine/docstore.db). It is NOT the gateway vault (command_center_api's
`vault` table holds finance and private collections and is Nic's to change); joining the two waits
for him. Embeddings go through the vault's own `command_center_api.embed` (the CPU nomic embedder on
:1237, never a GPU JIT load), so vectors here match the vault's exactly.

  add_text()     add or update one document; an unchanged document (same sha256) is a no-op, a
                 changed one is re-chunked and re-embedded
  add_file()     .txt .md .py .json .csv ... directly; .pdf / .docx when pypdf / python-docx exist
  index_folder() add every supported file under a folder, re-indexing only what changed
  search()       hybrid: BM25-lite + cosine, the vault's 0.3 / 0.7 weighting; lexical when the
                 embedder is down (chunks keep vector NULL and `reembed()` fills them later)
  remove()       drop a document from the store (never touches the source file)
"""
from __future__ import annotations

import array
import contextlib
import hashlib
import json
import math
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DB_PATH = ROOT / "data" / "engine" / "docstore.db"
CHUNK_CHARS = 1200
OVERLAP_CHARS = 200
TEXT_EXT = {".txt", ".md", ".markdown", ".rst", ".py", ".rs", ".ts", ".tsx", ".js", ".json", ".csv", ".yml",
            ".yaml", ".toml", ".ini", ".html", ".htm", ".xml", ".ps1", ".sh", ".sql", ".log", ".fountain"}
MAX_FILE_BYTES = 20 << 20
_TOKEN = re.compile(r"[a-z0-9$#.\-]{2,}")

Embedder = Callable[[list[str]], tuple[list[list[float]], str]]


def default_embedder(texts: list[str]) -> tuple[list[list[float]], str]:
    import command_center_api as cc
    return cc.embed(texts, background=True)


def chunk_text(text: str, size: int = CHUNK_CHARS, overlap: int = OVERLAP_CHARS) -> list[str]:
    """Paragraph-aware chunks of about `size` characters; a paragraph longer than `size` is cut with
    `overlap` characters carried into the next piece."""
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out: list[str] = []
    cur = ""
    for p in paras:
        if len(p) > size:
            if cur:
                out.append(cur)
                cur = ""
            step = max(1, size - overlap)
            for i in range(0, len(p), step):
                out.append(p[i:i + size])
                if i + size >= len(p):
                    break
            continue
        if cur and len(cur) + 2 + len(p) > size:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        out.append(cur)
    return out


def extract_text(path: Path) -> str:
    """Plain text of a file. Raises ValueError for an unsupported / too-large file."""
    ext = path.suffix.lower()
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError(f"{path.name}: {size >> 20} MiB is over the {MAX_FILE_BYTES >> 20} MiB limit")
    if ext in TEXT_EXT:
        return path.read_text(encoding="utf-8", errors="replace")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError as e:
            raise ValueError("PDF needs pypdf (pip install pypdf)") from e
        return "\n\n".join((pg.extract_text() or "") for pg in PdfReader(str(path)).pages)
    if ext == ".docx":
        try:
            import docx
        except ImportError as e:
            raise ValueError("DOCX needs python-docx (pip install python-docx)") from e
        return "\n\n".join(p.text for p in docx.Document(str(path)).paragraphs)
    raise ValueError(f"{path.name}: unsupported type {ext or '(none)'}")


def _cosine(a: array.array, b: array.array) -> float:
    if len(a) != len(b) or not len(a):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


class DocStore:
    def __init__(self, path: Path = DB_PATH, embedder: Optional[Embedder] = None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.embedder = embedder or default_embedder
        self._lock = threading.Lock()
        with self._db() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS docs(
                    id INTEGER PRIMARY KEY, source TEXT NOT NULL, key TEXT NOT NULL, title TEXT,
                    sha256 TEXT NOT NULL, meta TEXT, updated REAL, UNIQUE(source, key));
                CREATE TABLE IF NOT EXISTS chunks(
                    id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                    idx INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB, model TEXT);
                CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
            """)

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        """One connection per use: committed on success, rolled back on error, always closed (an
        open handle keeps the file locked on Windows)."""
        c = sqlite3.connect(self.path, timeout=30)
        try:
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys=ON")
            with c:
                yield c
        finally:
            c.close()

    def _embed(self, texts: list[str]) -> tuple[Optional[list[list[float]]], Optional[str]]:
        if not texts:
            return [], None
        try:
            return self.embedder(texts)
        except Exception:
            return None, None  # embedder down: lexical only until reembed()

    # ── write ──
    def add_text(self, source: str, key: str, text: str, title: str = "", meta: Optional[dict] = None) -> str:
        """'added', 'updated', 'unchanged' or 'empty'."""
        digest = hashlib.sha256((text or "").encode("utf-8")).hexdigest()
        with self._lock, self._db() as c:
            row = c.execute("SELECT id, sha256 FROM docs WHERE source=? AND key=?", (source, key)).fetchone()
            if row and row["sha256"] == digest:
                return "unchanged"
        chunks = chunk_text(text)
        if not chunks:
            return "empty"
        vecs, model = self._embed(chunks)
        with self._lock, self._db() as c:
            row = c.execute("SELECT id FROM docs WHERE source=? AND key=?", (source, key)).fetchone()
            meta_s = json.dumps(meta or {}, ensure_ascii=False)
            if row:
                doc_id = row["id"]
                c.execute("UPDATE docs SET title=?, sha256=?, meta=?, updated=? WHERE id=?", (title, digest, meta_s, time.time(), doc_id))
                c.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
            else:
                doc_id = c.execute("INSERT INTO docs(source,key,title,sha256,meta,updated) VALUES(?,?,?,?,?,?)",
                                   (source, key, title, digest, meta_s, time.time())).lastrowid
            for i, t in enumerate(chunks):
                blob = array.array("f", vecs[i]).tobytes() if vecs else None
                c.execute("INSERT INTO chunks(doc_id,idx,text,vector,model) VALUES(?,?,?,?,?)", (doc_id, i, t, blob, model))
        return "updated" if row else "added"

    def add_file(self, path: str | Path, source: str = "files") -> str:
        p = Path(path)
        st = p.stat()
        return self.add_text(source, str(p.resolve()), extract_text(p), title=p.name,
                             meta={"path": str(p.resolve()), "mtime": st.st_mtime, "bytes": st.st_size})

    def index_folder(self, folder: str | Path, source: str = "files", exts: Optional[Iterable[str]] = None) -> dict:
        """Add / re-index every supported file under `folder`; files that disappeared are dropped
        from the store (only from the store)."""
        folder = Path(folder).resolve()
        want = {e.lower() for e in (exts or (TEXT_EXT | {".pdf", ".docx"}))}
        counts = {"added": 0, "updated": 0, "unchanged": 0, "empty": 0, "skipped": 0, "removed": 0}
        errors: list[str] = []
        present = set()
        for p in sorted(folder.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in want:
                continue
            present.add(str(p.resolve()))
            try:
                counts[self.add_file(p, source)] += 1
            except (ValueError, OSError) as e:
                counts["skipped"] += 1
                errors.append(str(e)[:200])
        prefix = str(folder)
        with self._lock, self._db() as c:
            for r in c.execute("SELECT id, key FROM docs WHERE source=?", (source,)).fetchall():
                if r["key"].startswith(prefix) and r["key"] not in present:
                    c.execute("DELETE FROM docs WHERE id=?", (r["id"],))
                    counts["removed"] += 1
        return {**counts, "errors": errors}

    def reembed(self, limit: int = 500) -> int:
        """Embed chunks that were stored while the embedder was down. Returns how many."""
        with self._db() as c:
            rows = c.execute("SELECT id, text FROM chunks WHERE vector IS NULL LIMIT ?", (limit,)).fetchall()
        if not rows:
            return 0
        vecs, model = self._embed([r["text"] for r in rows])
        if not vecs:
            return 0
        with self._lock, self._db() as c:
            for r, v in zip(rows, vecs):
                c.execute("UPDATE chunks SET vector=?, model=? WHERE id=?", (array.array("f", v).tobytes(), model, r["id"]))
        return len(rows)

    def remove(self, source: str, key: str) -> bool:
        with self._lock, self._db() as c:
            return c.execute("DELETE FROM docs WHERE source=? AND key=?", (source, key)).rowcount > 0

    # ── read ──
    def stats(self) -> dict:
        with self._db() as c:
            docs = c.execute("SELECT source, COUNT(*) n FROM docs GROUP BY source").fetchall()
            ch = c.execute("SELECT COUNT(*) n, SUM(vector IS NOT NULL) v FROM chunks").fetchone()
        return {"docs": {r["source"]: r["n"] for r in docs}, "chunks": ch["n"] or 0, "embedded": ch["v"] or 0}

    def search(self, q: str, k: int = 8, sources: Optional[list[str]] = None) -> dict:
        with self._db() as c:
            rows = c.execute("SELECT c.id, c.text, c.vector, c.idx, d.source, d.key, d.title FROM chunks c "
                             "JOIN docs d ON d.id=c.doc_id").fetchall()
        if sources:
            rows = [r for r in rows if r["source"] in sources]
        if not rows:
            return {"results": [], "mode": "empty"}
        q_terms = _TOKEN.findall(q.lower())
        toks = {r["id"]: _TOKEN.findall(r["text"].lower()) for r in rows}
        df: dict[str, int] = {}
        for t in toks.values():
            for w in set(t):
                df[w] = df.get(w, 0) + 1
        n = len(rows)
        lex = {}
        for r in rows:
            t = toks[r["id"]]
            lex[r["id"]] = sum(math.log(1 + n / df[w]) * (t.count(w) / (t.count(w) + 1.2)) for w in q_terms if w in df)
        lmax = max(lex.values()) or 1.0
        sem: dict[int, float] = {}
        vecs, _ = self._embed([q])
        if vecs:
            qa = array.array("f", vecs[0])
            for r in rows:
                if r["vector"]:
                    v = array.array("f")
                    v.frombytes(r["vector"])
                    sem[r["id"]] = _cosine(qa, v)
        scored = []
        for r in rows:
            lx = lex[r["id"]] / lmax
            s = 0.3 * lx + 0.7 * sem.get(r["id"], 0.0) if sem else lx
            scored.append((s, r))
        scored.sort(key=lambda x: x[0], reverse=True)
        res = [{"score": round(s, 4), "source": r["source"], "key": r["key"], "title": r["title"], "chunk": r["idx"],
                "text": r["text"]} for s, r in scored[:k] if s > 0]
        return {"results": res, "mode": "hybrid" if sem else "lexical"}


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="the built-in engine's document store")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats")
    ix = sub.add_parser("index")
    ix.add_argument("folder")
    ix.add_argument("--source", default="files")
    se = sub.add_parser("search")
    se.add_argument("q")
    se.add_argument("-k", type=int, default=5)
    sub.add_parser("reembed")
    a = ap.parse_args(argv)
    ds = DocStore()
    if a.cmd == "stats":
        print(json.dumps(ds.stats(), indent=2))
    elif a.cmd == "index":
        print(json.dumps(ds.index_folder(a.folder, a.source), indent=2))
    elif a.cmd == "search":
        print(json.dumps(ds.search(a.q, a.k), indent=2, ensure_ascii=False))
    elif a.cmd == "reembed":
        print(ds.reembed())
    return 0


if __name__ == "__main__":
    sys.exit(main())
