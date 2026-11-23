"""Filesystem helpers: atomic writes, link-or-fail, reparse-point checks and a process lock."""

from __future__ import annotations

import json
import os
import re
import secrets as _secrets
import socket
import stat
import time
from pathlib import Path

from .errors import ArchiveError, Deferred, HubWriteRefused

FILE_ATTRIBUTE_REPARSE_POINT = 0x400

# ── C:\ai-hub is READ-ONLY ───────────────────────────────────────────────────
# No Memory Scrolls writer may create, replace, lock or append anything under these roots, whatever
# the path came from (flag, env, .env, os.json, a pinned state root or a default). The check is
# case-insensitive and runs on both the literal absolute path and its resolved form (symlinks,
# junctions and, where the volume has them, 8.3 short names expanded), so a link elsewhere that lands
# inside the hub is refused. An admin share (\\host\C$\ai-hub, \\?\UNC\..., a drive mapped to it) maps
# back to its drive letter, and any other alias (a plain share, SUBST, a volume GUID path) is caught by
# file identity: the target or an existing ancestor that IS the hub. Tests may extend this tuple
# (never shrink it).
PROTECTED_WRITE_ROOTS: tuple = (r"G:\ai-hub", r"C:\ai-hub")  # G: is home; C: is the old path (a junction)


# `\\host\C$\...`: an administrative drive share, mapped back to `C:\...` for any host (fail closed:
# a remote machine's C$\ai-hub is refused too, which costs nothing).
_ADMIN_SHARE = re.compile(r"\\\\[^\\]+\\([A-Za-z])\$(?=\\|$)")


def _path_key(s: str) -> str:
    """Comparable form: backslashes, no extended-length prefix, an admin share mapped to its drive,
    normalized, no trailing slash, casefolded."""
    s = s.replace("/", "\\")
    for pre in (r"\\?\UNC" + "\\", r"\\.\UNC" + "\\"):
        if s.upper().startswith(pre):
            s = "\\\\" + s[len(pre):]
    for pre in (r"\\?" + "\\", r"\\." + "\\"):
        if s.startswith(pre):
            s = s[len(pre):]
    m = _ADMIN_SHARE.match(s)
    if m:
        s = m.group(1) + ":\\" + s[m.end():].lstrip("\\")
    if os.name == "nt":
        s = os.path.normpath(s)
    return s.rstrip("\\").casefold()


def _path_forms(p) -> set:
    s = os.fspath(p)
    forms = {s}
    try:
        forms.add(os.path.abspath(s))
    except (OSError, ValueError):
        pass
    try:
        forms.add(os.path.realpath(s))
    except (OSError, ValueError):
        pass
    return {_path_key(f) for f in forms if f}


def _file_id(p) -> "tuple | None":
    """(volume, file index) of an existing path (links followed), or None."""
    try:
        st = os.stat(p)
    except (OSError, ValueError):
        return None
    return (st.st_dev, st.st_ino) if st.st_ino else None


def _ancestor_ids(p) -> set:
    """File ids of `p` and of every existing ancestor, for its literal, absolute and resolved forms.

    This catches a path that reaches a protected root under a name no lexical rule knows: a share
    other than the admin one, a mapped or SUBST drive, a volume GUID path. (On Windows the id of
    C:\\ai-hub reached over an SMB loopback share equals the local one.)
    """
    s = os.fspath(p)
    forms = {s}
    for f in (os.path.abspath, os.path.realpath):
        try:
            forms.add(f(s))
        except (OSError, ValueError):
            pass
    ids = set()
    for form in forms:
        cur = Path(form)
        for anc in (cur, *cur.parents):
            fid = _file_id(anc)
            if fid is not None:
                ids.add(fid)
    return ids


def protected_root(p) -> "str | None":
    """The protected root `p` is (or lies) under, literal, resolved or by file identity, else None."""
    cands = _path_forms(p)
    for root in PROTECTED_WRITE_ROOTS:
        for r in _path_forms(root):
            for c in cands:
                if c == r or c.startswith(r + "\\"):
                    return root
    root_ids = [(root, _file_id(root)) for root in PROTECTED_WRITE_ROOTS]
    root_ids = [(root, fid) for root, fid in root_ids if fid is not None]
    if root_ids:
        ids = _ancestor_ids(p)
        for root, fid in root_ids:
            if fid in ids:
                return root
    return None


def refuse_protected(p, what: str = "write target") -> None:
    """Raise HubWriteRefused when `p` resolves under a protected (read-only) root."""
    if protected_root(p) is not None:
        raise HubWriteRefused(f"{what} is under the read-only ai-hub tree; refusing to write there")


def is_reparse(path: Path) -> bool:
    """True for a symlink, junction or any other reparse point (False when the path is absent)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    return bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def fsync_dir(path: Path) -> None:
    """Best-effort directory fsync (a no-op on Windows, which cannot open directories)."""
    if os.name == "nt":
        return
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def atomic_write(path: Path, data: bytes) -> None:
    """Write `data` to a temp file in the same directory, fsync, then replace `path`."""
    path = Path(path)
    refuse_protected(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{_secrets.token_hex(8)}.tmp")
    try:
        with open(tmp, "xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    fsync_dir(path.parent)


def link_or_fail(tmp: Path, final: Path) -> None:
    """Move `tmp` to `final`, failing (and leaving any existing `final` untouched) if it exists."""
    refuse_protected(final, "archive file")
    try:
        os.link(tmp, final)
    except FileExistsError:
        raise ArchiveError(f"refusing to overwrite existing archive {final.name}") from None
    except OSError:
        # No hard links on this filesystem: exists-check + rename (the caller holds the
        # process lock; rename on Windows also refuses an existing target).
        if final.exists():
            raise ArchiveError(f"refusing to overwrite existing archive {final.name}") from None
        os.rename(tmp, final)
        return
    try:
        tmp.unlink()
    except OSError:
        pass


def pid_alive(pid: int) -> bool:
    """Whether a process with this id exists on this host."""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            # Access denied still means the process exists.
            return ctypes.get_last_error() == 5  # type: ignore[attr-defined]
        try:
            code = ctypes.c_ulong()
            if k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return True
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ProcessLock:
    """Cross-process O_EXCL lockfile holding {pid, hostname, token, at}.

    A lock whose owner is on this host is stale only when that process is gone (a long manual run
    or `offload --apply` can hold it well past 10 min; it is never refreshed), or after
    `max_live_secs` (default 6 h, a ceiling against pid reuse). A lock from another host, or one
    whose owner cannot be read, is stale after `stale_secs` (default 10 min).
    """

    def __init__(self, path: Path, stale_secs: float = 600.0, what: str = "another compaction running", max_live_secs: float = 6 * 3600.0):
        self.path = Path(path)
        self.stale_secs = stale_secs
        self.max_live_secs = max_live_secs
        self.what = what
        self.token = _secrets.token_hex(12)
        self.held = False

    def _stale(self) -> bool:
        try:
            st = os.stat(self.path)
            raw = self.path.read_text(encoding="utf-8")
        except OSError:
            return False
        age = time.time() - st.st_mtime
        try:
            owner = json.loads(raw)
        except ValueError:
            owner = None
        if isinstance(owner, dict) and owner.get("hostname") == socket.gethostname() and isinstance(owner.get("pid"), int):
            # Checked before the age: a live holder keeps its lock however long its run takes.
            return not pid_alive(owner["pid"]) or age > self.max_live_secs
        return age > self.stale_secs

    def acquire(self) -> "ProcessLock":
        refuse_protected(self.path, "lock file")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        body = json.dumps({"pid": os.getpid(), "hostname": socket.gethostname(), "token": self.token, "at": time.time()}).encode()
        for attempt in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except (FileExistsError, PermissionError):
                if attempt == 0 and self._stale():
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    continue
                raise Deferred(self.what) from None
            try:
                os.write(fd, body)
            finally:
                os.close(fd)
            self.held = True
            return self
        raise Deferred(self.what)

    def release(self) -> None:
        if not self.held:
            return
        self.held = False
        try:
            current = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(current, dict) and current.get("token") == self.token:
            try:
                os.unlink(self.path)
            except OSError:
                pass

    def __enter__(self) -> "ProcessLock":
        return self.acquire()

    def __exit__(self, *exc) -> None:
        self.release()
