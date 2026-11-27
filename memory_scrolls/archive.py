"""Step A: archive first (zero loss). Writes only under the cold archive root.

Layout: `<root>/YYYY/MM/arch-YYYY-MM-DD-NN.jsonl.gz` (gzip mtime 0, so identical input gives identical
bytes) plus an append-only `<root>/manifest.jsonl`. An archive is never overwritten. A manifest row
is appended only after the file re-reads and checksums cleanly.
"""

from __future__ import annotations

import datetime as _dt
import gzip
import hashlib
import io
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import fsutil
from .errors import ArchiveError
from .scrub import REDACTED, scrub, scrub_obj

SCHEMA = "agentic-os.archive.v1"
ID_RE = re.compile(r"^arch-(\d{4})-(\d{2})-(\d{2})-(\d{2,3})$")
MAX_RAW_PER_ARCHIVE = 256 * 1024
MAX_DECOMPRESSED = 64 * 1024 * 1024


@dataclass
class ArchiveRef:
    archive_id: str
    path: Path
    rel: str
    bytes_gz: int
    bytes_raw: int
    sha256_gz: str
    sha256_raw: str
    records: int
    kinds: List[str]
    created_at: str


def manifest_path(root: Path) -> Path:
    return Path(root) / "manifest.jsonl"


def read_manifest(root: Path) -> List[dict]:
    p = manifest_path(root)
    if not p.is_file():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            v = json.loads(line)
        except ValueError:
            continue
        if isinstance(v, dict) and isinstance(v.get("archive_id"), str):
            rows.append(v)
    return rows


def path_for(root: Path, archive_id: str) -> Path:
    m = ID_RE.match(archive_id)
    if not m:
        raise ArchiveError("invalid archive id")
    return Path(root) / m.group(1) / m.group(2) / f"{archive_id}.jsonl.gz"


def next_id(root: Path, day: _dt.date) -> str:
    prefix = f"arch-{day.isoformat()}-"
    nums = [int(r["archive_id"][len(prefix):]) for r in read_manifest(root) if r["archive_id"].startswith(prefix) and r["archive_id"][len(prefix):].isdigit()]
    month_dir = Path(root) / f"{day.year:04d}" / f"{day.month:02d}"
    if month_dir.is_dir():
        for p in month_dir.iterdir():
            name = p.name.split(".", 1)[0]
            if name.startswith(prefix) and name[len(prefix):].isdigit():
                nums.append(int(name[len(prefix):]))
    n = max(nums, default=0) + 1
    return f"{prefix}{n:02d}" if n <= 99 else f"{prefix}{n:03d}"


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _record_line(seq: int, r: dict) -> dict:
    line = {"type": "record", "seq": seq, "kind": r.get("kind"), "ts": r.get("ts") or ""}
    for k in ("agent", "role", "title"):
        if r.get(k):
            line[k] = r[k]
    line["source"] = r.get("source") or ""
    line["text"] = r.get("text") or ""
    line["meta"] = r.get("meta") or {}
    return line


def split_batches(records: List[dict], cap: int = MAX_RAW_PER_ARCHIVE) -> List[List[dict]]:
    batches: List[List[dict]] = []
    cur: List[dict] = []
    size = 0
    for r in records:
        b = len(_dumps(r).encode("utf-8")) + 1
        if cur and size + b > cap:
            batches.append(cur)
            cur, size = [], 0
        cur.append(r)
        size += b
    if cur:
        batches.append(cur)
    return batches


def _build(archive_id: str, records: List[dict], source_desc: dict, created_at: str, known) -> Tuple[bytes, int]:
    known = list(known)
    clean = []
    redactions = 0
    for r in records:
        r2 = dict(r)
        r2["text"] = scrub(r.get("text") or "", known)
        r2["meta"] = scrub_obj(r.get("meta") or {}, known)
        redactions += r2["text"].count(REDACTED)
        clean.append(r2)
    header = {"type": "header", "schema": SCHEMA, "archive_id": archive_id, "created_at": created_at, "source": source_desc, "records": len(clean), "redactions": redactions}
    lines = [_dumps(header)] + [_dumps(_record_line(i + 1, r)) for i, r in enumerate(clean)]
    return ("\n".join(lines) + "\n").encode("utf-8"), len(clean)


def _gz(raw: bytes) -> bytes:
    return gzip.compress(raw, compresslevel=9, mtime=0)


def _gunzip_capped(data: bytes, cap: int = MAX_DECOMPRESSED) -> bytes:
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as g:
        out = g.read(cap + 1)
    if len(out) > cap:
        raise ArchiveError("archive exceeds the decompression cap")
    return out


def verify(path: Path, archive_id: str, sha256_gz: str, sha256_raw: str, records: int) -> None:
    """Re-open and check every promise; raises ArchiveError on any mismatch."""
    try:
        data = Path(path).read_bytes()
    except OSError as e:
        raise ArchiveError(f"archive unreadable ({type(e).__name__})") from None
    if hashlib.sha256(data).hexdigest() != sha256_gz:
        raise ArchiveError("archive gz checksum mismatch")
    try:
        raw = _gunzip_capped(data)
    except (OSError, EOFError, gzip.BadGzipFile) as e:
        raise ArchiveError(f"archive does not decompress ({type(e).__name__})") from None
    if hashlib.sha256(raw).hexdigest() != sha256_raw:
        raise ArchiveError("archive raw checksum mismatch")
    lines = raw.decode("utf-8").splitlines()
    if len(lines) != records + 1:
        raise ArchiveError("archive line count mismatch")
    try:
        header = json.loads(lines[0])
    except ValueError:
        raise ArchiveError("archive header unreadable") from None
    if header.get("archive_id") != archive_id or header.get("type") != "header":
        raise ArchiveError("archive header id mismatch")


def _append_manifest(root: Path, row: dict) -> None:
    p = manifest_path(root)
    fsutil.refuse_protected(p, "archive manifest")
    with open(p, "a", encoding="utf-8", newline="\n") as f:
        f.write(_dumps(row) + "\n")
        f.flush()
        os.fsync(f.fileno())


def write_one(root: Path, records: List[dict], source_desc: dict, now: _dt.datetime, known=()) -> ArchiveRef:
    root = Path(root)
    fsutil.refuse_protected(root, "archive root")
    root.mkdir(parents=True, exist_ok=True)
    archive_id = next_id(root, now.date())
    final = path_for(root, archive_id)
    final.parent.mkdir(parents=True, exist_ok=True)
    created_at = now.isoformat(timespec="seconds")
    raw, n = _build(archive_id, records, source_desc, created_at, known)
    gz = _gz(raw)
    part = final.with_name(final.name + ".part")
    try:
        with open(part, "xb") as f:
            f.write(gz)
            f.flush()
            os.fsync(f.fileno())
        fsutil.link_or_fail(part, final)
    finally:
        try:
            part.unlink()
        except OSError:
            pass
    sha_gz = hashlib.sha256(gz).hexdigest()
    sha_raw = hashlib.sha256(raw).hexdigest()
    verify(final, archive_id, sha_gz, sha_raw, n)
    kinds = sorted({str(r.get("kind")) for r in records})
    ref = ArchiveRef(archive_id, final, final.relative_to(root).as_posix(), len(gz), len(raw), sha_gz, sha_raw, n, kinds, created_at)
    _append_manifest(root, {
        "archive_id": archive_id, "path": ref.rel, "bytes_gz": ref.bytes_gz, "bytes_raw": ref.bytes_raw,
        "sha256_gz": sha_gz, "sha256_raw": sha_raw, "records": n, "kinds": kinds, "created_at": created_at,
        "verified_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    })
    return ref


def write_archive(root: Path, records: List[dict], source_desc: dict, now: _dt.datetime, known=()) -> List[ArchiveRef]:
    """Archive `records` (split at 256 KB raw), verify each and append its manifest row."""
    return [write_one(root, batch, source_desc, now, known) for batch in split_batches(records)]


def snapshot(root: Path, docs: List[dict], now: _dt.datetime, known=(), extra: Optional[dict] = None) -> List[ArchiveRef]:
    """A pre-offload RAG snapshot (`rag_snapshot`), used by `offload --apply` before any removal."""
    return write_archive(root, docs, {"kind": "rag_snapshot", **(extra or {})}, now, known)


def manifest_row(root: Path, archive_id: str) -> Optional[dict]:
    for r in read_manifest(root):
        if r["archive_id"] == archive_id:
            return r
    return None


def prune_allowed(root: Path, archive_id: str) -> bool:
    """Re-verify immediately before any destructive step."""
    row = manifest_row(root, archive_id)
    if not row:
        return False
    try:
        verify(path_for(root, archive_id), archive_id, row["sha256_gz"], row["sha256_raw"], int(row["records"]))
    except (ArchiveError, KeyError, ValueError):
        return False
    return True


def read_entry(root: Path, archive_id: str) -> Tuple[dict, List[dict]]:
    """(header, records) of one archive (for compaction / status; the Librarian has its own reader)."""
    data = path_for(root, archive_id).read_bytes()
    lines = _gunzip_capped(data).decode("utf-8").splitlines()
    header = json.loads(lines[0])
    return header, [json.loads(x) for x in lines[1:] if x.strip()]


def iter_ids(root: Path) -> Iterable[str]:
    return [r["archive_id"] for r in read_manifest(root)]
